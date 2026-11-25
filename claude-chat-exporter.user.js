// ==UserScript==
// @name         Claude Chat Exporter (Obsidian)
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  Exporte une discussion Claude.ai en markdown propre (thinking/outils en callouts) et prépare le contenu pour Obsidian Web Clipper
// @author       l'Atelier
// @match        https://claude.ai/chat/*
// @match        https://claude.ai/share/*
// @match        https://claude.com/chat/*
// @match        https://claude.com/share/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const EXPORT_ROOT_ID = 'atr-claude-export';
    const EXPORT_MD_ID = 'atr-claude-md';
    const EXPORT_TITLE_ID = 'atr-claude-title';
    const PANEL_ID = 'atr-claude-export-panel';

    // -------------------------------------------------------------------------
    // Utils
    // -------------------------------------------------------------------------

    function sanitizeFilename(name) {
        return String(name || 'claude-chat')
            .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 120) || 'claude-chat';
    }

    function indentCallout(text) {
        return String(text || '')
            .replace(/\r\n/g, '\n')
            .split('\n')
            .map((line) => `> ${line}`)
            .join('\n');
    }

    function formatCallout(type, title, body) {
        const cleaned = String(body || '').trim();
        if (!cleaned) return '';
        return `> [!${type}]- ${title}\n${indentCallout(cleaned)}\n`;
    }

    function todayISODate() {
        return new Date().toISOString().slice(0, 10);
    }

    function getChatTitle() {
        const split = document.querySelector('[data-testid="chat-title-split"]');
        if (split && split.textContent.trim()) {
            return split.textContent.trim();
        }
        return document.title.replace(/\s*[-–—]\s*Claude\s*$/i, '').trim() || 'Discussion Claude';
    }

    function getConversationIdFromUrl(url = location.href) {
        const m = String(url).match(/\/(?:chat|share)\/([0-9a-f-]{36})/i);
        return m ? m[1] : null;
    }

    function isSharePage() {
        return /\/share\//i.test(location.pathname);
    }

    // -------------------------------------------------------------------------
    // API extraction
    // -------------------------------------------------------------------------

    async function fetchJson(url) {
        const res = await fetch(url, {
            credentials: 'include',
            headers: { Accept: 'application/json' }
        });
        if (!res.ok) {
            const err = new Error(`HTTP ${res.status} for ${url}`);
            err.status = res.status;
            throw err;
        }
        return res.json();
    }

    async function fetchOrganizations() {
        const data = await fetchJson('/api/organizations');
        if (Array.isArray(data)) return data;
        if (Array.isArray(data?.organizations)) return data.organizations;
        return [];
    }

    async function fetchConversation(orgId, conversationId) {
        const qs = new URLSearchParams({
            tree: 'True',
            rendering_mode: 'messages',
            render_all_tools: 'true'
        });
        return fetchJson(
            `/api/organizations/${encodeURIComponent(orgId)}/chat_conversations/${encodeURIComponent(conversationId)}?${qs}`
        );
    }

    async function fetchSharedConversation(shareId) {
        // Routes observées / possibles pour les liens de partage
        const candidates = [
            `/api/share/${encodeURIComponent(shareId)}`,
            `/api/chat_snapshots/${encodeURIComponent(shareId)}`,
            `/api/organizations/share/${encodeURIComponent(shareId)}`
        ];
        let lastError = null;
        for (const url of candidates) {
            try {
                return await fetchJson(url);
            } catch (e) {
                lastError = e;
                if (e.status && e.status !== 404) continue;
            }
        }
        throw lastError || new Error('Conversation partagée introuvable via API');
    }

    async function loadConversationPayload() {
        const id = getConversationIdFromUrl();
        if (!id) throw new Error('Aucun ID de conversation dans l’URL');

        if (isSharePage()) {
            try {
                return await fetchSharedConversation(id);
            } catch (_) {
                // repli : parfois le share est aussi récupérable via org+id
            }
        }

        const orgs = await fetchOrganizations();
        if (!orgs.length) throw new Error('Aucune organisation Claude trouvée (session ?)');

        let lastError = null;
        for (const org of orgs) {
            const orgId = org.uuid || org.id;
            if (!orgId) continue;
            try {
                return await fetchConversation(orgId, id);
            } catch (e) {
                lastError = e;
            }
        }
        throw lastError || new Error('Conversation introuvable pour les organisations disponibles');
    }

    function buildActiveBranch(payload) {
        const messages = Array.isArray(payload.chat_messages) ? payload.chat_messages : [];
        if (!messages.length) return [];

        const byUuid = new Map();
        for (const msg of messages) {
            if (msg && msg.uuid) byUuid.set(msg.uuid, msg);
        }

        const leaf =
            (payload.current_leaf_message_uuid && byUuid.get(payload.current_leaf_message_uuid)) ||
            messages[messages.length - 1];

        if (!leaf) return messages.slice().sort((a, b) => (a.index || 0) - (b.index || 0));

        const branch = [];
        const seen = new Set();
        let current = leaf;
        while (current && !seen.has(current.uuid)) {
            seen.add(current.uuid);
            branch.push(current);
            const parentId = current.parent_message_uuid;
            if (!parentId || !byUuid.has(parentId)) break;
            current = byUuid.get(parentId);
        }
        branch.reverse();
        return branch;
    }

    function formatToolInput(input) {
        if (input == null) return '';
        if (typeof input === 'string') return input;
        try {
            return '```json\n' + JSON.stringify(input, null, 2) + '\n```';
        } catch (_) {
            return String(input);
        }
    }

    function formatToolResultContent(content) {
        if (!content) return '';
        if (typeof content === 'string') return content;
        if (!Array.isArray(content)) {
            return formatToolInput(content);
        }
        const parts = [];
        for (const item of content) {
            if (!item) continue;
            if (item.type === 'text' && item.text) {
                parts.push(item.text);
            } else if (item.type === 'knowledge') {
                const title = item.title || 'Résultat';
                const url = item.url || '';
                parts.push(url ? `- [${title}](${url})` : `- ${title}`);
            } else if (item.text) {
                parts.push(item.text);
            } else {
                parts.push(formatToolInput(item));
            }
        }
        return parts.join('\n\n');
    }

    function formatAttachments(msg) {
        const names = [];
        const list = []
            .concat(msg.attachments || [])
            .concat(msg.files || []);
        for (const a of list) {
            const name = a.file_name || a.filename || a.name || a.title;
            if (name) names.push(name);
            const extracted = a.extracted_content || a.extracted_text || a.text;
            if (extracted && String(extracted).trim()) {
                names.push(`${name || 'fichier'} (extrait):\n${String(extracted).trim()}`);
            }
        }
        if (!names.length) return '';
        return names.map((n) => `- ${n}`).join('\n');
    }

    function blocksFromMessage(msg) {
        if (Array.isArray(msg.content) && msg.content.length) return msg.content;
        if (msg.text) return [{ type: 'text', text: msg.text }];
        return [];
    }

    function messageToMarkdown(msg) {
        const sender = (msg.sender || '').toLowerCase();
        const isHuman = sender === 'human' || sender === 'user';
        const heading = isHuman ? '## Human' : '## Claude';
        const parts = [heading, ''];

        const attachments = formatAttachments(msg);
        if (attachments) {
            parts.push('**Pièces jointes :**', '', attachments, '');
        }

        for (const block of blocksFromMessage(msg)) {
            const type = block.type || 'text';

            if (type === 'text') {
                const text = (block.text || '').trim();
                if (text) parts.push(text, '');
                continue;
            }

            if (type === 'thinking') {
                const thinking = (block.thinking || '').trim();
                if (thinking) {
                    parts.push(formatCallout('thinking', 'Thinking', thinking), '');
                } else if (Array.isArray(block.summaries) && block.summaries.length) {
                    const summary = block.summaries.map((s) => s.summary || s).filter(Boolean).join('\n');
                    if (summary) parts.push(formatCallout('thinking', 'Thinking (résumé)', summary), '');
                }
                continue;
            }

            if (type === 'tool_use') {
                const name = block.name || block.icon_name || 'outil';
                const body = [
                    block.message ? String(block.message).trim() : '',
                    formatToolInput(block.input)
                ].filter(Boolean).join('\n\n');
                parts.push(formatCallout('abstract', `Outil: ${name}`, body), '');
                continue;
            }

            if (type === 'tool_result') {
                const name = block.name || 'résultat';
                const body = formatToolResultContent(block.content);
                const title = block.is_error ? `Erreur outil: ${name}` : `Résultat: ${name}`;
                parts.push(formatCallout('abstract', title, body || '(vide)'), '');
                continue;
            }

            // Artefacts / blocs divers
            if (type === 'artifact' || type === 'code' || block.title) {
                const title = block.title || block.name || type;
                const body = block.content || block.text || formatToolInput(block);
                parts.push(formatCallout('example', `Artefact: ${title}`, body), '');
                continue;
            }

            // Fallback générique
            const raw = formatToolInput(block);
            if (raw && raw !== '{}' && raw !== 'null') {
                parts.push(formatCallout('example', `Bloc: ${type}`, raw), '');
            }
        }

        // Si aucun contenu structuré, utiliser text racine
        if (parts.length <= 2 && msg.text) {
            parts.push(String(msg.text).trim(), '');
        }

        return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    }

    function conversationToMarkdown(payload, { warning } = {}) {
        const title = payload.name || getChatTitle();
        const model = payload.model || payload.settings?.model || '';
        const branch = buildActiveBranch(payload);

        const header = [
            `# ${title}`,
            '',
            `**Source:** ${location.href}`,
            `**Date:** ${todayISODate()}`,
            model ? `**Modèle:** ${model}` : null,
            warning ? `**Avertissement:** ${warning}` : null,
            '',
            '---',
            ''
        ].filter((line) => line !== null);

        const body = branch.map(messageToMarkdown).filter(Boolean).join('\n\n');
        return (header.join('\n') + body + '\n').replace(/\n{3,}/g, '\n\n');
    }

    // -------------------------------------------------------------------------
    // DOM fallback
    // -------------------------------------------------------------------------

    function htmlNodeToMarkdown(node, indent = '') {
        if (!node) return '';
        if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
        if (node.nodeType !== Node.ELEMENT_NODE) return '';

        const tag = node.tagName.toLowerCase();
        const children = () =>
            Array.from(node.childNodes)
                .map((n) => htmlNodeToMarkdown(n, indent))
                .join('');

        switch (tag) {
            case 'p':
                return children().trim() + '\n\n';
            case 'br':
                return '\n';
            case 'strong':
            case 'b':
                return `**${children()}**`;
            case 'em':
            case 'i':
                return `*${children()}*`;
            case 'code':
                if (node.closest('pre')) return children();
                return '`' + children().replace(/`/g, '\\`') + '`';
            case 'pre': {
                const code = node.querySelector('code');
                const lang =
                    (code &&
                        Array.from(code.classList)
                            .find((c) => c.startsWith('language-'))
                            ?.replace(/^language-/, '')) ||
                    '';
                const text = (code || node).textContent || '';
                return '```' + lang + '\n' + text.replace(/\n$/, '') + '\n```\n\n';
            }
            case 'h1':
                return `# ${children().trim()}\n\n`;
            case 'h2':
                return `## ${children().trim()}\n\n`;
            case 'h3':
                return `### ${children().trim()}\n\n`;
            case 'h4':
                return `#### ${children().trim()}\n\n`;
            case 'ul':
                return (
                    Array.from(node.children)
                        .filter((li) => li.tagName.toLowerCase() === 'li')
                        .map((li) => `- ${htmlNodeToMarkdown(li, indent + '  ').trim()}`)
                        .join('\n') + '\n\n'
                );
            case 'ol':
                return (
                    Array.from(node.children)
                        .filter((li) => li.tagName.toLowerCase() === 'li')
                        .map((li, i) => `${i + 1}. ${htmlNodeToMarkdown(li, indent + '  ').trim()}`)
                        .join('\n') + '\n\n'
                );
            case 'li':
                return children().trim();
            case 'blockquote':
                return (
                    children()
                        .trim()
                        .split('\n')
                        .map((l) => `> ${l}`)
                        .join('\n') + '\n\n'
                );
            case 'a': {
                const href = node.getAttribute('href') || '';
                const label = children().trim() || href;
                return href ? `[${label}](${href})` : label;
            }
            case 'hr':
                return '---\n\n';
            case 'table':
                return children() + '\n';
            default:
                return children();
        }
    }

    function extractDomConversationMarkdown() {
        const userMsgs = Array.from(document.querySelectorAll('[data-testid="user-message"]'));
        const claudeMsgs = Array.from(document.querySelectorAll('.standard-markdown'));

        const items = [
            ...userMsgs.map((el) => ({ el, role: 'user' })),
            ...claudeMsgs.map((el) => ({ el, role: 'claude' }))
        ].sort((a, b) => {
            const pos = a.el.compareDocumentPosition(b.el);
            if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
            if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
            return 0;
        });

        // Dédupliquer : un .standard-markdown à l'intérieur d'un user-message ne doit pas doubler
        const filtered = [];
        for (const item of items) {
            if (item.role === 'claude' && item.el.closest('[data-testid="user-message"]')) continue;
            filtered.push(item);
        }

        const parts = [];
        for (const { el, role } of filtered) {
            if (role === 'user') {
                const text = (el.textContent || '').trim();
                if (!text) continue;
                parts.push('## Human\n\n' + text);
            } else {
                const md = htmlNodeToMarkdown(el).trim();
                if (!md) continue;
                parts.push('## Claude\n\n' + md);
            }
        }

        const title = getChatTitle();
        const warning =
            'Export DOM : thinking / outils / artefacts peuvent être incomplets (virtualisation ou blocs repliés).';
        const header = [
            `# ${title}`,
            '',
            `**Source:** ${location.href}`,
            `**Date:** ${todayISODate()}`,
            `**Avertissement:** ${warning}`,
            '',
            '---',
            ''
        ];
        return (header.join('\n') + parts.join('\n\n') + '\n').replace(/\n{3,}/g, '\n\n');
    }

    // -------------------------------------------------------------------------
    // Injection + download / copy
    // -------------------------------------------------------------------------

    function ensureExportMount() {
        let root = document.getElementById(EXPORT_ROOT_ID);
        if (!root) {
            root = document.createElement('article');
            root.id = EXPORT_ROOT_ID;
            root.setAttribute('data-atr-claude-export', '1');
            root.setAttribute('aria-hidden', 'true');
            // Hors viewport mais présent dans le DOM pour le clipper
            root.style.cssText = [
                'position:fixed',
                'left:-10000px',
                'top:0',
                'width:1px',
                'height:1px',
                'overflow:hidden',
                'opacity:0',
                'pointer-events:none',
                'z-index:-1'
            ].join(';');

            const title = document.createElement('h1');
            title.id = EXPORT_TITLE_ID;
            root.appendChild(title);

            const pre = document.createElement('pre');
            pre.id = EXPORT_MD_ID;
            root.appendChild(pre);

            document.documentElement.appendChild(root);
        }
        return root;
    }

    function injectMarkdown(markdown, title) {
        const root = ensureExportMount();
        const titleEl = document.getElementById(EXPORT_TITLE_ID);
        const mdEl = document.getElementById(EXPORT_MD_ID);
        if (titleEl) titleEl.textContent = title || getChatTitle();
        if (mdEl) mdEl.textContent = markdown;
        root.dataset.preparedAt = new Date().toISOString();
        return root;
    }

    async function copyToClipboard(text) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (_) {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;left:-9999px;top:0';
            document.body.appendChild(ta);
            ta.focus();
            ta.select();
            let ok = false;
            try {
                ok = document.execCommand('copy');
            } catch (_) {
                ok = false;
            }
            ta.remove();
            return ok;
        }
    }

    function downloadMarkdown(markdown, title) {
        const filename = sanitizeFilename(title || getChatTitle()) + '.md';
        const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1500);
    }

    // -------------------------------------------------------------------------
    // UI (intégré à gauche de « Partager »)
    // -------------------------------------------------------------------------

    const ICON_OBSIDIAN = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 2L4 6v6c0 5 3.4 9.4 8 10 4.6-.6 8-5 8-10V6l-8-4z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M9 12l2 2 4-4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    const ICON_COPY = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.7"/><path d="M5 15V5a2 2 0 012-2h10" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`;
    const ICON_DOWNLOAD = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 4v11m0 0l-4-4m4 4l4-4M5 19h14" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

    let lastMarkdown = '';
    let lastTitle = '';
    let exportBusy = false;

    function showToast(message, isError = false) {
        const existing = document.getElementById('atr-claude-toast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.id = 'atr-claude-toast';
        toast.textContent = message;
        toast.style.cssText = [
            'position:fixed',
            'bottom:24px',
            'right:24px',
            'z-index:100001',
            'max-width:360px',
            'padding:12px 16px',
            'border-radius:10px',
            'font:14px/1.4 system-ui,sans-serif',
            'box-shadow:0 8px 24px rgba(0,0,0,.18)',
            isError ? 'background:#7f1d1d;color:#fff' : 'background:#1a1a1a;color:#f5f5f5'
        ].join(';');
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 4500);
    }

    function setBusy(busy) {
        exportBusy = !!busy;
        const panel = document.getElementById(PANEL_ID);
        if (!panel) return;
        panel.querySelectorAll('button').forEach((btn) => {
            btn.disabled = exportBusy;
            btn.style.opacity = exportBusy ? '0.55' : '1';
        });
    }

    function createIconButton(action, label, svg) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.dataset.action = action;
        btn.setAttribute('aria-label', label);
        btn.title = label;
        btn.innerHTML = svg;
        btn.style.cssText = [
            'display:inline-flex',
            'align-items:center',
            'justify-content:center',
            'width:36px',
            'height:36px',
            'padding:0',
            'margin:0',
            'border:none',
            'border-radius:8px',
            'background:transparent',
            'color:inherit',
            'cursor:pointer',
            'flex-shrink:0'
        ].join(';');
        btn.addEventListener('mouseenter', () => {
            if (!btn.disabled) btn.style.background = 'rgba(128,128,128,0.14)';
        });
        btn.addEventListener('mouseleave', () => {
            btn.style.background = 'transparent';
        });
        return btn;
    }

    async function runExport() {
        if (exportBusy) return lastMarkdown;
        setBusy(true);
        try {
            let markdown;
            let title = getChatTitle();
            let via = 'api';

            try {
                const payload = await loadConversationPayload();
                title = payload.name || title;
                markdown = conversationToMarkdown(payload);
            } catch (apiErr) {
                console.warn('[ATR Claude Export] API failed, DOM fallback:', apiErr);
                via = 'dom';
                markdown = extractDomConversationMarkdown();
            }

            lastMarkdown = markdown;
            lastTitle = title;
            injectMarkdown(markdown, title);

            showToast(
                via === 'api'
                    ? 'Prêt pour Obsidian Web Clipper (API).'
                    : 'Prêt (fallback DOM — thinking/outils incomplets possibles).'
            );
            return markdown;
        } catch (e) {
            console.error('[ATR Claude Export]', e);
            showToast('Erreur: ' + (e.message || e), true);
            throw e;
        } finally {
            setBusy(false);
        }
    }

    function wirePanelActions(panel) {
        if (panel.dataset.wired === '1') return;
        panel.dataset.wired = '1';

        panel.addEventListener('click', async (e) => {
            const btn = e.target.closest('button[data-action]');
            if (!btn || !panel.contains(btn)) return;
            e.preventDefault();
            e.stopPropagation();

            const action = btn.dataset.action;
            try {
                if (action === 'prepare') {
                    await runExport();
                    return;
                }
                if (action === 'copy') {
                    if (!lastMarkdown) await runExport();
                    const ok = await copyToClipboard(lastMarkdown);
                    showToast(ok ? 'Markdown copié.' : 'Copie impossible.', !ok);
                    return;
                }
                if (action === 'download') {
                    if (!lastMarkdown) await runExport();
                    downloadMarkdown(lastMarkdown, lastTitle);
                    showToast('Fichier .md téléchargé.');
                }
            } catch (_) {
                /* toast déjà affiché */
            }
        });
    }

    function buildPanel() {
        const panel = document.createElement('div');
        panel.id = PANEL_ID;
        panel.setAttribute('data-atr-claude-toolbar', '1');
        panel.className = 'flex items-center gap-1';
        panel.style.cssText = 'display:inline-flex;align-items:center;gap:2px;flex-shrink:0;';

        panel.appendChild(
            createIconButton('prepare', 'Préparer pour Obsidian Web Clipper', ICON_OBSIDIAN)
        );
        panel.appendChild(createIconButton('copy', 'Copier le markdown', ICON_COPY));
        panel.appendChild(createIconButton('download', 'Télécharger le .md', ICON_DOWNLOAD));

        wirePanelActions(panel);
        return panel;
    }

    function findShareInsertPoint() {
        const shareBtn = document.querySelector('[data-testid="wiggle-controls-actions-share"]');
        if (!shareBtn) return null;

        const group = shareBtn.closest('[data-testid="wiggle-controls-actions-group"]');
        // Insérer juste avant le wrapper du bouton Partager (souvent un span.relative)
        let before = shareBtn;
        while (before.parentElement && before.parentElement !== group) {
            before = before.parentElement;
        }
        if (group && before.parentElement === group) {
            return { parent: group, before };
        }

        // Repli : parent immédiat du bouton
        if (shareBtn.parentElement) {
            return { parent: shareBtn.parentElement, before: shareBtn };
        }
        return null;
    }

    function mountPanelInHeader() {
        const existing = document.getElementById(PANEL_ID);
        const insert = findShareInsertPoint();

        if (!insert) {
            // Header pas encore monté : ne pas coller un panneau flottant
            return false;
        }

        const panel = existing || buildPanel();
        if (panel.parentElement !== insert.parent || panel.nextSibling !== insert.before) {
            insert.parent.insertBefore(panel, insert.before);
        }
        return true;
    }

    function shouldShowPanel() {
        return !!getConversationIdFromUrl();
    }

    function mount() {
        if (!shouldShowPanel()) {
            const existing = document.getElementById(PANEL_ID);
            if (existing) existing.remove();
            return;
        }
        if (!mountPanelInHeader()) {
            // Réessayer tant que « Partager » n’est pas dans le DOM
            [200, 600, 1200, 2500].forEach((ms) => setTimeout(mountPanelInHeader, ms));
        }
    }

    // SPA : Claude change d’URL sans reload complet
    let lastHref = location.href;
    function watchNavigation() {
        const check = () => {
            if (location.href !== lastHref) {
                lastHref = location.href;
                lastMarkdown = '';
                lastTitle = '';
                mount();
            } else if (shouldShowPanel() && !document.getElementById(PANEL_ID)) {
                mountPanelInHeader();
            }
        };
        setInterval(check, 800);
        window.addEventListener('popstate', () => setTimeout(mount, 50));
        const origPush = history.pushState;
        const origReplace = history.replaceState;
        history.pushState = function () {
            const r = origPush.apply(this, arguments);
            setTimeout(mount, 50);
            return r;
        };
        history.replaceState = function () {
            const r = origReplace.apply(this, arguments);
            setTimeout(mount, 50);
            return r;
        };

        const obs = new MutationObserver(() => {
            if (shouldShowPanel() && !document.getElementById(PANEL_ID)) {
                mountPanelInHeader();
            }
        });
        obs.observe(document.documentElement, { childList: true, subtree: true });
    }

    function init() {
        mount();
        watchNavigation();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
