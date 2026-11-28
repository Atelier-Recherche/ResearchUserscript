// ==UserScript==
// @name         Cairn PDF Downloader
// @namespace    http://tampermonkey.net/
// @version      1.8
// @description  Télécharge et fusionne en un PDF tous les chapitres/articles d'un livre ou d'une revue Cairn
// @author       You
// @match        https://shs.cairn.info/*
// @match        https://*.cairn.info/*
// @match        https://shs-cairn-info.janus.bis-sorbonne.fr/*
// @match        https://*.janus.bis-sorbonne.fr/*
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      cairn.info
// @connect      shs.cairn.info
// @connect      www.cairn.info
// @connect      shs-cairn-info.janus.bis-sorbonne.fr
// @connect      *.janus.bis-sorbonne.fr
// @connect      cdn.jsdelivr.net
// @connect      unpkg.com
// ==/UserScript==

(function() {
    'use strict';

    // Configuration
    const DELAY_BETWEEN_DOWNLOADS = 2000; // 2 secondes entre chaque téléchargement
    const DELAY_BETWEEN_PAGE_FETCHES = 1000; // 1 seconde entre chaque récupération de page

    // Fonction pour extraire l'ID de l'article depuis l'URL
    function extractArticleIdFromUrl(url) {
        const match = url.match(/page-(\d+)/);
        return match ? match[1] : null;
    }

    // Fonction pour extraire l'ID complet de l'article depuis l'attribut x-alt-clipboard
    function extractArticleIdFromElement(element) {
        const clipboard = element.getAttribute('x-alt-clipboard');
        if (clipboard) {
            return clipboard;
        }
        // Fallback: essayer de trouver dans le parent
        const parent = element.closest('[x-alt-clipboard]');
        return parent ? parent.getAttribute('x-alt-clipboard') : null;
    }

    // Langue courante de la page (fr par défaut)
    function getPageLang() {
        const lang = new URLSearchParams(window.location.search).get('lang');
        return lang || 'fr';
    }

    // Toujours rester sur l'hôte courant (proxy Janus inclus) pour garder la session
    function getCairnOrigin() {
        return window.location.origin;
    }

    function isCairnHostname(hostname) {
        if (!hostname) return false;
        return /(^|\.)cairn\.info$/i.test(hostname) ||
            /(^|\.)janus\.bis-sorbonne\.fr$/i.test(hostname);
    }

    // Réécrit les liens cairn.info vers l'origine courante (ex: proxy Janus)
    function toCurrentOriginUrl(href) {
        if (!href) return null;
        const cleaned = href.replace(/&amp;/g, '&');
        try {
            const u = new URL(cleaned, getCairnOrigin());
            if (isCairnHostname(u.hostname)) {
                return getCairnOrigin() + u.pathname + u.search + u.hash;
            }
            return u.href;
        } catch (e) {
            return null;
        }
    }

    // URL PDF directe Cairn (revues et ouvrages accessibles)
    function buildDirectPdfUrl(articleId) {
        return `${getCairnOrigin()}/article/${articleId}/pdf?lang=${getPageLang()}`;
    }

    // Normaliser une URL relative ou absolue Cairn
    function normalizeCairnUrl(href) {
        return toCurrentOriginUrl(href);
    }

    // Extraire une URL PDF depuis un document HTML de chapitre/article
    function extractPdfUrlFromDocument(doc) {
        // Méthode 1: lien caché feuilleteur (ouvrages)
        const pdfLink = doc.getElementById('feuilleteur-url-pdf');
        if (pdfLink && pdfLink.getAttribute('href')) {
            return normalizeCairnUrl(pdfLink.getAttribute('href'));
        }

        // Méthode 2: window.parametersViewer dans les scripts
        const scriptTags = doc.querySelectorAll('script');
        for (let script of scriptTags) {
            const content = script.textContent || '';
            const match = content.match(/window\.parametersViewer\s*=\s*\{[^}]*file:\s*['"]([^'"]+)['"]/);
            if (match) {
                return normalizeCairnUrl(match[1]);
            }
        }

        // Méthode 3: liens pdf-feuilleteur (ouvrages)
        const feuilleteurLinks = doc.querySelectorAll('a[href*="pdf-feuilleteur"]');
        if (feuilleteurLinks.length > 0) {
            return normalizeCairnUrl(feuilleteurLinks[0].getAttribute('href'));
        }

        // Méthode 4: bouton PDF direct des revues/articles (/article/ID/pdf)
        const directPdfLinks = doc.querySelectorAll('a[href*="/article/"][href*="/pdf"]');
        for (let link of directPdfLinks) {
            const href = link.getAttribute('href') || '';
            // Éviter les liens vers pdf-feuilleteur déjà gérés plus haut
            if (href.includes('/pdf') && !href.includes('pdf-feuilleteur')) {
                return normalizeCairnUrl(href);
            }
        }

        // Méthode 5: construire depuis un ID article trouvé dans la page
        const articleIdElements = doc.querySelectorAll('[x-alt-clipboard]');
        for (let el of articleIdElements) {
            const articleId = el.getAttribute('x-alt-clipboard');
            // IDs article du type CITE_030_0003 (pas seulement le numéro de revue CITE_030)
            if (articleId && /^[A-Z][A-Z0-9]*_\d+_\d+$/i.test(articleId)) {
                return buildDirectPdfUrl(articleId);
            }
        }

        return null;
    }

    function isPdfBuffer(buffer) {
        if (!buffer) return false;
        const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
        return bytes.length >= 5 &&
            bytes[0] === 0x25 && bytes[1] === 0x50 &&
            bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2D; // %PDF-
    }

    function resolvePdfUrl(chapter) {
        if (chapter.articleId) {
            return buildDirectPdfUrl(chapter.articleId);
        }
        throw new Error('ID article manquant pour construire l\'URL PDF');
    }

    function getDownloadMode() {
        try {
            if (typeof GM_info !== 'undefined' && GM_info.downloadMode) {
                return GM_info.downloadMode; // 'browser' | 'native' | 'disabled'
            }
        } catch (e) { /* ignore */ }
        return 'unknown';
    }

    /**
     * Vrai téléchargement disque via l'API Downloads du navigateur (Tampermonkey).
     * Ce n'est PAS un fetch/XHR page: DataDome ne le traite pas comme les XHR en 403.
     * Prérequis Tampermonkey: Options → Downloads → Download Mode = "Browser API"
     * et extension .pdf autorisée.
     */
    function downloadWithGmDownload(pdfUrl, filename, referer) {
        return new Promise((resolve, reject) => {
            if (typeof GM_download !== 'function') {
                reject(new Error('GM_download indisponible (installez Tampermonkey/Violentmonkey)'));
                return;
            }

            const mode = getDownloadMode();
            if (mode === 'disabled') {
                reject(new Error(
                    'Téléchargements désactivés dans Tampermonkey. ' +
                    'Options → Downloads → Download Mode = Browser API'
                ));
                return;
            }

            const details = {
                url: pdfUrl,
                name: filename,
                saveAs: false,
                conflictAction: 'uniquify',
                headers: {
                    'Accept': 'application/pdf,*/*;q=0.9',
                    'Referer': referer || window.location.href
                },
                onload: function() {
                    resolve('gm');
                },
                ontimeout: function() {
                    reject(new Error('Timeout GM_download'));
                },
                onerror: function(err) {
                    const code = (err && err.error) || 'not_succeeded';
                    let hint = code;
                    if (code === 'not_enabled' || code === 'not_permitted') {
                        hint = code + ' — activez Browser API dans Tampermonkey → Options → Downloads';
                    } else if (code === 'not_whitelisted') {
                        hint = code + ' — ajoutez .pdf aux extensions autorisées (Tampermonkey → Downloads)';
                    }
                    reject(new Error('GM_download: ' + hint));
                }
            };

            try {
                GM_download(details);
            } catch (e) {
                reject(e);
            }
        });
    }

    /**
     * Fallback same-origin: <a download> sans nouvel onglet.
     * Le navigateur enregistre le fichier au lieu de l'ouvrir.
     */
    function downloadWithAnchorAttribute(pdfUrl, filename) {
        return new Promise((resolve) => {
            const a = document.createElement('a');
            a.href = pdfUrl;
            a.setAttribute('download', filename);
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            a.remove();
            // Pas de confirmation réseau fiable ici; on considère le déclenchement OK
            setTimeout(() => resolve('anchor'), 300);
        });
    }

    // Télécharge un PDF sur le disque (sans ouvrir d'onglet)
    async function downloadPdfToDisk(pdfUrl, filename, referer) {
        try {
            return await downloadWithGmDownload(pdfUrl, filename, referer);
        } catch (gmError) {
            // Fallback si GM_download non configuré
            console.warn('[Cairn PDF]', gmError.message, '→ fallback <a download>');
            await downloadWithAnchorAttribute(pdfUrl, filename);
            return 'anchor-fallback:' + gmError.message;
        }
    }

    /**
     * Fetch same-origin dans le contexte page (cookies Janus / session navigateur).
     * Plus fiable que GM_xmlhttpRequest sur un proxy universitaire.
     */
    function pageFetchPdfBlob(pdfUrl) {
        return new Promise((resolve, reject) => {
            const fetchId = 'cairn_fetch_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
            const pageWindow = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
            let settled = false;

            function cleanup() {
                window.removeEventListener('message', onMessage);
                clearTimeout(timeoutId);
            }

            function finish(err, blob) {
                if (settled) return;
                settled = true;
                cleanup();
                if (err) reject(err);
                else resolve(blob);
            }

            function onMessage(event) {
                const data = event.data;
                if (!data || data.source !== 'cairn-pdf-downloader-fetch' || data.id !== fetchId) {
                    return;
                }
                if (data.error) {
                    finish(new Error(data.error));
                    return;
                }
                try {
                    const store = pageWindow.__cairnFetchData && pageWindow.__cairnFetchData[fetchId];
                    if (!store || !store.buffer) {
                        finish(new Error('Buffer PDF introuvable après fetch page'));
                        return;
                    }
                    const buffer = store.buffer;
                    delete pageWindow.__cairnFetchData[fetchId];
                    if (!isPdfBuffer(buffer)) {
                        finish(new Error('Réponse non-PDF (fetch page)'));
                        return;
                    }
                    finish(null, new Blob([buffer], { type: 'application/pdf' }));
                } catch (e) {
                    finish(e);
                }
            }

            window.addEventListener('message', onMessage);

            const timeoutId = setTimeout(() => {
                finish(new Error('Timeout fetch page'));
            }, 15000);

            const mergeScript = document.createElement('script');
            mergeScript.textContent = `
                (async function() {
                    var id = ${JSON.stringify(fetchId)};
                    try {
                        var res = await fetch(${JSON.stringify(pdfUrl)}, {
                            credentials: 'include',
                            headers: { 'Accept': 'application/pdf,*/*' }
                        });
                        if (!res.ok) throw new Error('HTTP ' + res.status);
                        var buffer = await res.arrayBuffer();
                        window.__cairnFetchData = window.__cairnFetchData || {};
                        window.__cairnFetchData[id] = { buffer: buffer };
                        window.postMessage({
                            source: 'cairn-pdf-downloader-fetch',
                            id: id,
                            ok: true
                        }, '*');
                    } catch (e) {
                        window.postMessage({
                            source: 'cairn-pdf-downloader-fetch',
                            id: id,
                            error: String(e && e.message ? e.message : e)
                        }, '*');
                    }
                })();
            `;
            (document.head || document.documentElement).appendChild(mergeScript);
            mergeScript.remove();
        });
    }

    /**
     * Récupère le PDF en mémoire via GM_xmlhttpRequest (fallback).
     * Peut échouer en 403 DataDome hors session proxy.
     */
    function gmFetchPdfBlob(pdfUrl, referer) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest !== 'function') {
                reject(new Error('GM_xmlhttpRequest indisponible'));
                return;
            }
            GM_xmlhttpRequest({
                method: 'GET',
                url: pdfUrl,
                responseType: 'arraybuffer',
                anonymous: false,
                headers: {
                    'Accept': 'application/pdf,*/*',
                    'Referer': referer || window.location.href
                },
                onload: function(res) {
                    if (res.status < 200 || res.status >= 300) {
                        reject(new Error('HTTP ' + res.status));
                        return;
                    }
                    if (!isPdfBuffer(res.response)) {
                        reject(new Error('Réponse non-PDF'));
                        return;
                    }
                    resolve(new Blob([res.response], { type: 'application/pdf' }));
                },
                onerror: function() {
                    reject(new Error('Erreur réseau GM_xmlhttpRequest'));
                },
                ontimeout: function() {
                    reject(new Error('Timeout GM_xmlhttpRequest'));
                }
            });
        });
    }

    async function fetchPdfBlobForMerge(pdfUrl, referer) {
        // 1) fetch du sandbox userscript (rapide si cookies same-origin dispo)
        try {
            const res = await fetch(pdfUrl, {
                credentials: 'include',
                headers: { 'Accept': 'application/pdf,*/*' }
            });
            if (res.ok) {
                const buffer = await res.arrayBuffer();
                if (isPdfBuffer(buffer)) {
                    return new Blob([buffer], { type: 'application/pdf' });
                }
                console.warn('[Cairn PDF] fetch userscript: réponse non-PDF');
            } else {
                console.warn('[Cairn PDF] fetch userscript: HTTP', res.status);
            }
        } catch (e) {
            console.warn('[Cairn PDF] fetch userscript échoué:', e.message);
        }

        // 2) fetch dans le contexte page (cookies de session Janus)
        try {
            return await pageFetchPdfBlob(pdfUrl);
        } catch (pageErr) {
            console.warn('[Cairn PDF] fetch page échoué:', pageErr.message);
        }

        // 3) GM_xmlhttpRequest
        return gmFetchPdfBlob(pdfUrl, referer);
    }

    async function canFetchPdfsForMerge(sampleUrl, referer) {
        try {
            await fetchPdfBlobForMerge(sampleUrl, referer);
            return { ok: true };
        } catch (e) {
            return { ok: false, reason: e && e.message ? e.message : String(e) };
        }
    }

    // Fonction pour nettoyer le nom de fichier
    function sanitizeFilename(name) {
        return name.replace(/[<>:"/\\|?*]/g, '_').trim();
    }

    // Fonction pour charger pdf-lib depuis CDN en utilisant une injection dans la page
    function loadPdfLib() {
        return new Promise((resolve, reject) => {
            // Vérifier si pdf-lib est déjà chargé
            const checkAlreadyLoaded = () => {
                const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
                if (win.pdfLib && win.pdfLib.PDFDocument) {
                    resolve({});
                    return true;
                }
                return false;
            };
            
            if (checkAlreadyLoaded()) return;
            
            // Créer un ID unique pour la fonction callback
            const callbackId = 'cairn_pdf_lib_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            
            // Vérifier périodiquement si pdf-lib est chargé
            const checkInterval = setInterval(() => {
                const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
                
                // Chercher PDFDocument de différentes façons
                let PDFDocument = null;
                if (win.pdfLib) {
                    if (win.pdfLib.PDFDocument) {
                        PDFDocument = win.pdfLib.PDFDocument;
                    } else if (win.pdfLib.default && win.pdfLib.default.PDFDocument) {
                        PDFDocument = win.pdfLib.default.PDFDocument;
                    }
                }
                if (!PDFDocument && win.PDFLib && win.PDFLib.PDFDocument) {
                    PDFDocument = win.PDFLib.PDFDocument;
                }
                if (!PDFDocument && win.PDFDocument) {
                    PDFDocument = win.PDFDocument;
                }
                
                if (PDFDocument && typeof PDFDocument.create === 'function') {
                    clearInterval(checkInterval);
                    clearTimeout(timeoutId);
                    window.removeEventListener(`${callbackId}_pdfLibReady`, readyHandler);
                    window.removeEventListener(`${callbackId}_pdfLibError`, errorHandler);
                    resolve({});
                }
            }, 100);
            
            // Injecter une fonction dans la page pour charger pdf-lib
            const loadScript = document.createElement('script');
            loadScript.textContent = `
                (function() {
                    if (window.${callbackId}_loading) return;
                    window.${callbackId}_loading = true;
                    
                    const script = document.createElement('script');
                    script.src = 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js';
                    script.onload = function() {
                        // Chercher PDFDocument de différentes façons
                        let PDFDocument = null;
                        if (window.pdfLib && window.pdfLib.PDFDocument) {
                            PDFDocument = window.pdfLib.PDFDocument;
                        } else if (window.pdfLib && window.pdfLib.default && window.pdfLib.default.PDFDocument) {
                            PDFDocument = window.pdfLib.default.PDFDocument;
                        } else if (window.PDFLib && window.PDFLib.PDFDocument) {
                            PDFDocument = window.PDFLib.PDFDocument;
                        } else if (window.PDFDocument) {
                            PDFDocument = window.PDFDocument;
                        }
                        
                        if (PDFDocument && typeof PDFDocument.create === 'function') {
                            window.dispatchEvent(new CustomEvent('${callbackId}_pdfLibReady'));
                        } else {
                            // Attendre un peu et réessayer (parfois pdf-lib met du temps à s'initialiser)
                            setTimeout(function() {
                                if (window.pdfLib && window.pdfLib.PDFDocument) {
                                    window.dispatchEvent(new CustomEvent('${callbackId}_pdfLibReady'));
                                }
                            }, 500);
                        }
                    };
                    script.onerror = function() {
                        const script2 = document.createElement('script');
                        script2.src = 'https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js';
                        script2.onload = function() {
                            if (window.pdfLib && window.pdfLib.PDFDocument) {
                                window.dispatchEvent(new CustomEvent('${callbackId}_pdfLibReady'));
                            }
                        };
                        script2.onerror = function() {
                            window.dispatchEvent(new CustomEvent('${callbackId}_pdfLibError', { 
                                detail: 'Impossible de charger pdf-lib' 
                            }));
                        };
                        document.head.appendChild(script2);
                    };
                    document.head.appendChild(script);
                })();
            `;
            
            // Écouter l'événement de chargement
            const readyHandler = () => {
                clearInterval(checkInterval);
                clearTimeout(timeoutId);
                window.removeEventListener(`${callbackId}_pdfLibReady`, readyHandler);
                window.removeEventListener(`${callbackId}_pdfLibError`, errorHandler);
                resolve({});
            };
            
            const errorHandler = (e) => {
                clearInterval(checkInterval);
                clearTimeout(timeoutId);
                window.removeEventListener(`${callbackId}_pdfLibReady`, readyHandler);
                window.removeEventListener(`${callbackId}_pdfLibError`, errorHandler);
                reject(new Error(e.detail || 'Impossible de charger pdf-lib depuis les CDN'));
            };
            
            window.addEventListener(`${callbackId}_pdfLibReady`, readyHandler);
            window.addEventListener(`${callbackId}_pdfLibError`, errorHandler);
            
            // Timeout de sécurité
            const timeoutId = setTimeout(() => {
                clearInterval(checkInterval);
                window.removeEventListener(`${callbackId}_pdfLibReady`, readyHandler);
                window.removeEventListener(`${callbackId}_pdfLibError`, errorHandler);
                // Vérifier une dernière fois
                if (checkAlreadyLoaded()) return;
                reject(new Error('Timeout: pdf-lib n\'a pas pu être chargé dans les 15 secondes'));
            }, 15000);
            
            // Injecter le script dans la page
            (document.head || document.documentElement).appendChild(loadScript);
        });
    }

    // Fusion via pdf-lib dans le contexte page (buffers passés par unsafeWindow, signal via postMessage)
    async function mergePdfs(pdfBlobs, chapterLinks) {
        await loadPdfLib();

        const pageTitle = document.title.replace(/\s*-\s*Cairn\.info.*$/i, '').trim();
        const mergedFilename = sanitizeFilename(`${pageTitle || 'Livre_Cairn'}_complet.pdf`);
        const mergeId = 'cairn_merge_' + Date.now();
        const pageWindow = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;

        // Éviter JSON.stringify d'octets (très lent / lourd pour ~10–20 Mo)
        const buffers = [];
        for (let i = 0; i < pdfBlobs.length; i++) {
            buffers.push(await pdfBlobs[i].blob.arrayBuffer());
        }
        pageWindow.__cairnMergeData = pageWindow.__cairnMergeData || {};
        pageWindow.__cairnMergeData[mergeId] = {
            buffers: buffers,
            filename: mergedFilename
        };

        return new Promise((resolve, reject) => {
            const timeoutMs = Math.max(180000, pdfBlobs.length * 15000); // 3 min min, +15s/PDF
            const timeoutId = setTimeout(() => {
                cleanup();
                reject(new Error('Timeout: la fusion a pris trop de temps'));
            }, timeoutMs);

            function onMessage(event) {
                const data = event.data;
                if (!data || data.source !== 'cairn-pdf-downloader-merge' || data.id !== mergeId) {
                    return;
                }
                cleanup();
                if (data.error) {
                    reject(new Error(data.error));
                } else {
                    resolve(data);
                }
            }

            function cleanup() {
                clearTimeout(timeoutId);
                window.removeEventListener('message', onMessage);
                try {
                    if (pageWindow.__cairnMergeData) {
                        delete pageWindow.__cairnMergeData[mergeId];
                    }
                } catch (e) { /* ignore */ }
            }

            window.addEventListener('message', onMessage);

            const mergeScript = document.createElement('script');
            mergeScript.textContent = `
                (async function() {
                    var id = ${JSON.stringify(mergeId)};
                    try {
                        var store = window.__cairnMergeData && window.__cairnMergeData[id];
                        if (!store || !store.buffers || !store.buffers.length) {
                            throw new Error('Données de fusion introuvables');
                        }
                        var PDFDocument = null;
                        if (window.pdfLib && window.pdfLib.PDFDocument) {
                            PDFDocument = window.pdfLib.PDFDocument;
                        } else if (window.pdfLib && window.pdfLib.default && window.pdfLib.default.PDFDocument) {
                            PDFDocument = window.pdfLib.default.PDFDocument;
                        } else if (window.PDFLib && window.PDFLib.PDFDocument) {
                            PDFDocument = window.PDFLib.PDFDocument;
                        } else if (window.PDFDocument) {
                            PDFDocument = window.PDFDocument;
                        }
                        if (!PDFDocument || typeof PDFDocument.create !== 'function') {
                            throw new Error('PDFDocument non disponible dans pdf-lib');
                        }

                        var mergedPdf = await PDFDocument.create();
                        var totalPages = 0;
                        for (var i = 0; i < store.buffers.length; i++) {
                            var pdf = await PDFDocument.load(store.buffers[i]);
                            var pages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
                            pages.forEach(function(page) { mergedPdf.addPage(page); });
                            totalPages += pdf.getPageCount();
                        }

                        var mergedPdfBytes = await mergedPdf.save();
                        var blob = new Blob([mergedPdfBytes], { type: 'application/pdf' });
                        var blobUrl = URL.createObjectURL(blob);
                        var a = document.createElement('a');
                        a.href = blobUrl;
                        a.download = store.filename;
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                        URL.revokeObjectURL(blobUrl);

                        window.postMessage({
                            source: 'cairn-pdf-downloader-merge',
                            id: id,
                            ok: true,
                            pages: totalPages,
                            filename: store.filename
                        }, '*');
                    } catch (e) {
                        window.postMessage({
                            source: 'cairn-pdf-downloader-merge',
                            id: id,
                            error: String(e && e.message ? e.message : e)
                        }, '*');
                    }
                })();
            `;
            (document.head || document.documentElement).appendChild(mergeScript);
            mergeScript.remove();
        });
    }

    // Fonction pour trouver tous les liens de chapitres sur la page principale
    function findChapterLinks() {
        const links = [];
        const seenUrls = new Set();
        
        // Chercher tous les liens contenant "page-" dans l'URL
        const allLinks = document.querySelectorAll('a[href*="page-"]');
        
        allLinks.forEach((link, index) => {
            const href = link.getAttribute('href');
            if (!href || !href.includes('page-')) return;
            
            // Normaliser sur l'origine courante (proxy Janus inclus)
            const fullUrl = toCurrentOriginUrl(href);
            if (!fullUrl || !fullUrl.includes('page-')) return;
            
            // Ignorer si déjà traité
            if (seenUrls.has(fullUrl)) return;
            seenUrls.add(fullUrl);
            
            // Récupérer les informations du lien
            const ariaLabel = link.getAttribute('aria-label') || '';
            
            // Vérifier que c'est un chapitre ou une page de début
            const isChapter = ariaLabel.includes('Chapitre');
            const isPagesDebut = ariaLabel.includes('Pages de début');
            
            // Inclure tous les liens (chapitres ET pages de début)
            // On ne filtre plus les pages de début car elles peuvent aussi contenir du contenu utile
            
            // Vérifier qu'il y a un article ID
            const articleId = extractArticleIdFromElement(link);
            if (!articleId) return;
            
            // Extraire le titre du chapitre
            let title = '';
            
            // Méthode 1: depuis aria-label (priorité car souvent plus précis)
            if (ariaLabel) {
                // Si c'est un chapitre, extraire le numéro et le titre
                if (ariaLabel.includes('Chapitre')) {
                    title = ariaLabel.replace(/^Chapitre\s+/, '').trim();
                }
                // Si c'est autre chose (Introduction, Conclusion, Biographie, Table des matières, etc.), utiliser directement
                else if (ariaLabel !== 'Pages de début' && ariaLabel.trim().length > 0) {
                    title = ariaLabel.trim();
                }
            }
            
            // Méthode 2: depuis le texte visible de la page
            if (!title || title === 'Pages de début') {
                const container = link.closest('[class*="shadow-frame"]') || 
                                 link.closest('.flex.flex-row.p-3') ||
                                 link.parentElement;
                if (container) {
                    // Chercher dans plusieurs endroits
                    const titleP = container.querySelector('p.font-bold, .font-serif p.font-bold');
                    if (titleP) {
                        let extractedTitle = titleP.textContent.trim();
                        // Nettoyer le titre (enlever les balises <np>)
                        extractedTitle = extractedTitle.replace(/<np[^>]*>.*?<\/np>/g, '').trim();
                        
                        // Si on a trouvé un titre et que ce n'est pas juste "Pages de début", l'utiliser
                        if (extractedTitle && extractedTitle !== 'Pages de début') {
                            title = extractedTitle;
                        }
                    }
                    
                    // Chercher aussi dans les listes (ul) qui peuvent contenir des sous-titres
                    if (!title || title === 'Pages de début') {
                        const ul = container.querySelector('ul.font-serif, ul.font-bold');
                        if (ul) {
                            const liText = Array.from(ul.querySelectorAll('li')).map(li => li.textContent.trim()).join(' - ');
                            if (liText) {
                                title = liText;
                            }
                        }
                    }
                }
            }
            
            // Méthode 3: Si c'est toujours "Pages de début", utiliser le numéro de page pour différencier
            if (!title || title === 'Pages de début') {
                const pageNum = extractArticleIdFromUrl(href);
                // Mapper les numéros de page connus à des noms plus descriptifs
                const pageNames = {
                    '1': 'Pages de début',
                    '7': 'Introduction',
                    '101': 'Conclusion',
                    '103': 'Biographie',
                    '119': 'Table des matières'
                };
                title = pageNames[pageNum] || `Pages de début (page ${pageNum})`;
            }
            
            links.push({
                url: fullUrl,
                articleId: articleId,
                title: title
            });
        });
        
        // Trier par numéro de page pour un ordre logique
        links.sort((a, b) => {
            const pageA = extractArticleIdFromUrl(a.url) || 0;
            const pageB = extractArticleIdFromUrl(b.url) || 0;
            return parseInt(pageA) - parseInt(pageB);
        });
        
        return links;
    }

    const DEFAULT_BTN_LABEL = 'Télécharger et fusionner tous les PDF';

    function setButtonState(button, { busy = false, label = DEFAULT_BTN_LABEL, progress = '' } = {}) {
        if (!button) return;
        button.disabled = !!busy;
        button.setAttribute('aria-busy', busy ? 'true' : 'false');
        button.setAttribute('aria-label', label);
        button.setAttribute('title', label);
        button.classList.toggle('opacity-60', !!busy);
        button.classList.toggle('pointer-events-none', !!busy);

        let badge = button.querySelector('.cairn-dl-badge');
        if (progress) {
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'cairn-dl-badge';
                badge.setAttribute('aria-hidden', 'true');
                badge.style.cssText = [
                    'position:absolute', 'bottom:-2px', 'right:-4px', 'z-index:2',
                    'min-width:16px', 'height:16px', 'padding:0 4px',
                    'border-radius:999px', 'background:#0b57a4', 'color:#fff',
                    'font-size:9px', 'line-height:16px', 'font-weight:700',
                    'font-family:system-ui,sans-serif'
                ].join(';');
                button.style.position = 'relative';
                button.appendChild(badge);
            }
            badge.textContent = progress;
            badge.hidden = false;
        } else if (badge) {
            badge.hidden = true;
            badge.textContent = '';
        }
    }

    function showToast(message, isError = false) {
        const existing = document.getElementById('cairn-dl-toast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.id = 'cairn-dl-toast';
        toast.setAttribute('role', 'status');
        toast.textContent = message;
        toast.style.cssText = [
            'position:fixed', 'bottom:24px', 'right:24px', 'z-index:100001',
            'max-width:360px', 'padding:12px 16px', 'border-radius:10px',
            'font:14px/1.4 system-ui,sans-serif', 'color:#fff',
            `background:${isError ? '#b42318' : '#0b57a4'}`,
            'box-shadow:0 8px 24px rgba(0,0,0,.2)'
        ].join(';');
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), isError ? 8000 : 4500);
    }

    // Télécharge + fusionne directement (pas de popup)
    async function downloadAllChapters() {
        const chapterLinks = findChapterLinks();
        if (chapterLinks.length === 0) {
            showToast('Aucun chapitre trouvé sur cette page.', true);
            return;
        }

        const button = document.getElementById('cairn-download-all-btn');
        if (button && button.getAttribute('aria-busy') === 'true') {
            return;
        }

        setButtonState(button, {
            busy: true,
            label: `Préparation (${chapterLinks.length} PDF)...`,
            progress: `0/${chapterLinks.length}`
        });

        let shouldMerge = true;
        let successCount = 0;
        let errorCount = 0;
        const errors = [];
        const pdfBlobs = [];

        // Toujours viser la fusion; bascule disque si la lecture mémoire est bloquée
        const probeUrl = resolvePdfUrl(chapterLinks[0]);
        const probeReferer = chapterLinks[0].url || window.location.href;
        const mergeProbe = await canFetchPdfsForMerge(probeUrl, probeReferer);
        if (!mergeProbe.ok) {
            shouldMerge = false;
            showToast(
                `Fusion mémoire impossible (${mergeProbe.reason || 'bloqué'}). Téléchargement fichier par fichier…`,
                true
            );
            console.warn('[Cairn PDF] Probe fusion échoué:', mergeProbe.reason, 'URL:', probeUrl);
        } else {
            console.info('[Cairn PDF] Probe fusion OK via', probeUrl);
        }

        for (let i = 0; i < chapterLinks.length; i++) {
            const chapter = chapterLinks[i];
            try {
                const pdfUrl = resolvePdfUrl(chapter);
                const filename = sanitizeFilename(`${chapter.title || `Chapitre-${i + 1}`}.pdf`);
                const referer = chapter.url || window.location.href;
                const progress = `${i + 1}/${chapterLinks.length}`;

                setButtonState(button, {
                    busy: true,
                    label: shouldMerge
                        ? `Récupération PDF ${progress}…`
                        : `Téléchargement ${progress}…`,
                    progress
                });

                if (shouldMerge) {
                    const blob = await fetchPdfBlobForMerge(pdfUrl, referer);
                    pdfBlobs.push({ blob, title: chapter.title || `Chapitre ${i + 1}` });
                } else {
                    await downloadPdfToDisk(pdfUrl, filename, referer);
                }
                successCount++;

                if (i < chapterLinks.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_DOWNLOADS));
                }
            } catch (error) {
                errorCount++;
                errors.push(`${chapter.title || chapter.url}: ${error.message}`);
            }
        }

        if (shouldMerge && pdfBlobs.length > 0) {
            setButtonState(button, {
                busy: true,
                label: 'Fusion du PDF complet…',
                progress: '∑'
            });
            try {
                await mergePdfs(pdfBlobs, chapterLinks);
            } catch (error) {
                errors.push(`Fusion: ${error.message}`);
                // Secours: enregistrer les blobs individuellement
                for (let i = 0; i < pdfBlobs.length; i++) {
                    const filename = sanitizeFilename(`${pdfBlobs[i].title || `Chapitre-${i + 1}`}.pdf`);
                    try {
                        const blobUrl = URL.createObjectURL(pdfBlobs[i].blob);
                        const a = document.createElement('a');
                        a.href = blobUrl;
                        a.download = filename;
                        document.body.appendChild(a);
                        a.click();
                        a.remove();
                        setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
                    } catch (e) {
                        errors.push(`Secours ${filename}: ${e.message}`);
                    }
                }
            }
        }

        setButtonState(button, { busy: false, label: DEFAULT_BTN_LABEL, progress: '' });

        if (errors.length === 0) {
            showToast(
                shouldMerge
                    ? `PDF fusionné prêt (${successCount} articles).`
                    : `${successCount} PDF téléchargés.`
            );
        } else {
            showToast(
                `Terminé: ${successCount} OK, ${errorCount + (errors.some(e => e.startsWith('Fusion:')) ? 0 : 0)} erreur(s). ${errors[0]}`,
                true
            );
            console.warn('[Cairn PDF] Erreurs:', errors);
        }
    }

    function createToolbarButton() {
        const wrap = document.createElement('div');
        wrap.id = 'cairn-download-all-wrap';
        wrap.className = 'flex flex-row gap-2.5 text-center leading-4';

        const button = document.createElement('button');
        button.id = 'cairn-download-all-btn';
        button.type = 'button';
        button.className = 'z-[1] group text-cairn-main';
        button.setAttribute('aria-label', DEFAULT_BTN_LABEL);
        button.setAttribute('title', DEFAULT_BTN_LABEL);
        button.innerHTML = `
            <span aria-hidden="true" class="fa-stack fa-1x group">
                <svg aria-hidden="true" class="bfa bfa-solid inline fa-stack-2x size-[36px] text-concrete-100 group-hover:text-alto-200" fill="currentColor" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path d="M256 512A256 256 0 1 0 256 0a256 256 0 1 0 0 512z"></path></svg>
                <svg aria-hidden="true" class="bfa bfa-solid inline fa-stack-1x text-cairn-main font-normal size-[18px]" fill="currentColor" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path d="M288 32c0-17.7-14.3-32-32-32s-32 14.3-32 32l0 242.7-73.4-73.4c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3l128 128c12.5 12.5 32.8 12.5 45.3 0l128-128c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L288 274.7 288 32zM64 352c-35.3 0-64 28.7-64 64l0 32c0 35.3 28.7 64 64 64l384 0c35.3 0 64-28.7 64-64l0-32c0-35.3-28.7-64-64-64l-101.5 0-45.3 45.3c-25 25-65.5 25-90.5 0L165.5 352 64 352zm368 56a24 24 0 1 1 0 48 24 24 0 1 1 0-48z"></path></svg>
            </span>
        `;

        button.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            downloadAllChapters().catch((error) => {
                setButtonState(button, { busy: false, label: DEFAULT_BTN_LABEL, progress: '' });
                showToast('Erreur: ' + error.message, true);
            });
        });

        wrap.appendChild(button);
        return wrap;
    }

    function findBookmarkInsertPoint() {
        const bookmarkRoot =
            document.querySelector('[x-data*="bookmarkButton"]') ||
            document.querySelector('button[aria-label*="liste de lecture"]')?.closest('div');

        if (bookmarkRoot && bookmarkRoot.parentElement) {
            return { parent: bookmarkRoot.parentElement, before: bookmarkRoot };
        }

        const citeBtn = document.querySelector('button[aria-label*="Citer ce"]');
        if (citeBtn) {
            const citeWrap = citeBtn.closest('.flex.flex-row, .flex') || citeBtn.parentElement;
            if (citeWrap && citeWrap.parentElement) {
                return { parent: citeWrap.parentElement, before: citeWrap };
            }
        }

        return null;
    }

    // Bouton intégré à gauche du bookmark (style Cairn)
    function addDownloadButton() {
        const url = window.location.href;
        const isChapterPage = /page-\d+/.test(url) && !/page-1(\?|$)/.test(url);
        if (isChapterPage) return;

        const chapterLinks = findChapterLinks();
        if (chapterLinks.length === 0) return;

        if (document.getElementById('cairn-download-all-btn')) return;

        const wrap = createToolbarButton();
        const insert = findBookmarkInsertPoint();

        if (insert && insert.parent) {
            insert.parent.insertBefore(wrap, insert.before);
            return;
        }

        // Repli si la barre d'actions n'est pas encore montée
        wrap.style.cssText = 'position:fixed;top:20px;right:20px;z-index:10000;';
        document.body.appendChild(wrap);
    }

    function scheduleButtonMount() {
        addDownloadButton();
        // La barre bookmark/citer se monte parfois après le 1er paint (Alpine/Livewire)
        [300, 1000, 2500].forEach((ms) => setTimeout(addDownloadButton, ms));
    }

    // Initialiser le script
    function init() {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', scheduleButtonMount);
        } else {
            scheduleButtonMount();
        }

        document.addEventListener('livewire:navigated', () => {
            setTimeout(scheduleButtonMount, 300);
        });
    }

    init();
})();

