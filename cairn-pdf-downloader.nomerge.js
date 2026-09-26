// ==UserScript==
// @name         Cairn PDF Downloader
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Télécharge tous les PDFs des chapitres d'un livre Cairn en libre accès
// @author       You
// @match        https://shs.cairn.info/*
// @match        https://*.cairn.info/*
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      cairn.info
// @connect      shs.cairn.info
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

    // Fonction pour récupérer l'URL du PDF depuis une page de chapitre
    function fetchPdfUrl(chapterUrl) {
        return new Promise((resolve, reject) => {
            console.log(`[Cairn PDF] Récupération de l'URL PDF pour: ${chapterUrl}`);
            
            GM_xmlhttpRequest({
                method: 'GET',
                url: chapterUrl,
                headers: {
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                },
                onload: function(response) {
                    try {
                        // Parser le HTML pour trouver le lien PDF
                        const parser = new DOMParser();
                        const doc = parser.parseFromString(response.responseText, 'text/html');
                        
                        // Méthode 1: Chercher le lien caché feuilleteur-url-pdf (méthode principale)
                        const pdfLink = doc.getElementById('feuilleteur-url-pdf');
                        if (pdfLink) {
                            let pdfUrl = pdfLink.getAttribute('href');
                            if (pdfUrl) {
                                // Décoder les entités HTML (&amp; -> &)
                                pdfUrl = pdfUrl.replace(/&amp;/g, '&');
                                console.log(`[Cairn PDF] URL PDF trouvée (feuilleteur-url-pdf): ${pdfUrl}`);
                                resolve(pdfUrl);
                                return;
                            }
                        }
                        
                        // Méthode 2: Chercher dans window.parametersViewer dans les scripts
                        const scriptTags = doc.querySelectorAll('script');
                        for (let script of scriptTags) {
                            const content = script.textContent;
                            // Pattern pour window.parametersViewer = { file: "url" }
                            const match = content.match(/window\.parametersViewer\s*=\s*\{[^}]*file:\s*['"]([^'"]+)['"]/);
                            if (match) {
                                let pdfUrl = match[1].replace(/&amp;/g, '&');
                                console.log(`[Cairn PDF] URL PDF trouvée (parametersViewer): ${pdfUrl}`);
                                resolve(pdfUrl);
                                return;
                            }
                            
                            // Pattern alternatif: file: document.getElementById('feuilleteur-url-pdf').href
                            const match2 = content.match(/file:\s*document\.getElementById\(['"]feuilleteur-url-pdf['"]\)\.href/);
                            if (match2) {
                                const link = doc.getElementById('feuilleteur-url-pdf');
                                if (link && link.getAttribute('href')) {
                                    let pdfUrl = link.getAttribute('href').replace(/&amp;/g, '&');
                                    console.log(`[Cairn PDF] URL PDF trouvée (via script): ${pdfUrl}`);
                                    resolve(pdfUrl);
                                    return;
                                }
                            }
                        }
                        
                        // Méthode 3: Chercher tous les liens contenant "pdf-feuilleteur"
                        const allLinks = doc.querySelectorAll('a[href*="pdf-feuilleteur"]');
                        if (allLinks.length > 0) {
                            let pdfUrl = allLinks[0].getAttribute('href').replace(/&amp;/g, '&');
                            console.log(`[Cairn PDF] URL PDF trouvée (lien pdf-feuilleteur): ${pdfUrl}`);
                            resolve(pdfUrl);
                            return;
                        }
                        
                        // Méthode 4: Construire l'URL à partir de l'ID de l'article si on le trouve
                        const articleIdMatch = chapterUrl.match(/article\/([A-Z_0-9]+)/) || 
                                               chapterUrl.match(/page-(\d+)/);
                        if (articleIdMatch) {
                            // Essayer de trouver l'ID complet de l'article dans la page
                            const articleIdElements = doc.querySelectorAll('[x-alt-clipboard]');
                            for (let el of articleIdElements) {
                                const articleId = el.getAttribute('x-alt-clipboard');
                                if (articleId && articleId.match(/^[A-Z_0-9]+$/)) {
                                    // Construire l'URL du PDF (sans signature, on essaiera)
                                    const baseUrl = chapterUrl.split('?')[0].replace(/\/page-\d+.*$/, '');
                                    const pdfUrl = `https://shs.cairn.info/article/${articleId}/pdf-feuilleteur?lang=fr`;
                                    console.log(`[Cairn PDF] Tentative avec URL construite: ${pdfUrl}`);
                                    // On va quand même essayer cette URL, mais elle pourrait nécessiter une signature
                                    resolve(pdfUrl);
                                    return;
                                }
                            }
                        }
                        
                        console.error('[Cairn PDF] Aucune méthode n\'a trouvé l\'URL PDF');
                        reject(new Error('URL PDF non trouvée sur la page'));
                    } catch (error) {
                        console.error('[Cairn PDF] Erreur lors de l\'extraction:', error);
                        reject(new Error(`Erreur lors de l'extraction: ${error.message}`));
                    }
                },
                onerror: function(error) {
                    console.error('[Cairn PDF] Erreur HTTP:', error);
                    reject(new Error(`Erreur HTTP: ${error.status} ${error.statusText}`));
                }
            });
        });
    }

    // Fonction pour télécharger un PDF
    function downloadPdf(pdfUrl, filename) {
        return new Promise((resolve, reject) => {
            console.log(`[Cairn PDF] Téléchargement de: ${filename}`);
            console.log(`[Cairn PDF] URL: ${pdfUrl}`);
            
            GM_download({
                url: pdfUrl,
                name: filename,
                saveAs: false,
                onload: function() {
                    console.log(`[Cairn PDF] ✓ Téléchargement réussi: ${filename}`);
                    resolve();
                },
                onerror: function(error) {
                    console.error(`[Cairn PDF] ✗ Erreur de téléchargement pour ${filename}:`, error);
                    // Si l'erreur est liée à l'URL, essayer de télécharger via fetch
                    if (error.error === 'NOT_ALLOWED' || error.error === 'FAILURE') {
                        console.log('[Cairn PDF] Tentative de téléchargement alternatif via fetch...');
                        // Essayer avec fetch + blob
                        fetch(pdfUrl)
                            .then(response => {
                                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                                return response.blob();
                            })
                            .then(blob => {
                                const blobUrl = URL.createObjectURL(blob);
                                const a = document.createElement('a');
                                a.href = blobUrl;
                                a.download = filename;
                                document.body.appendChild(a);
                                a.click();
                                document.body.removeChild(a);
                                URL.revokeObjectURL(blobUrl);
                                console.log(`[Cairn PDF] ✓ Téléchargement réussi (méthode alternative): ${filename}`);
                                resolve();
                            })
                            .catch(fetchError => {
                                console.error('[Cairn PDF] Erreur avec fetch:', fetchError);
                                reject(new Error(`Échec du téléchargement: ${error.error || error.message || 'Erreur inconnue'}`));
                            });
                    } else {
                        reject(new Error(`Échec du téléchargement: ${error.error || error.message || 'Erreur inconnue'}`));
                    }
                }
            });
        });
    }

    // Fonction pour nettoyer le nom de fichier
    function sanitizeFilename(name) {
        return name.replace(/[<>:"/\\|?*]/g, '_').trim();
    }

    // Fonction pour trouver tous les liens de chapitres sur la page principale
    function findChapterLinks() {
        console.log('[Cairn PDF] Recherche des chapitres...');
        const links = [];
        const seenUrls = new Set();
        
        // Chercher tous les liens contenant "page-" dans l'URL
        const allLinks = document.querySelectorAll('a[href*="page-"]');
        console.log(`[Cairn PDF] ${allLinks.length} liens avec "page-" trouvés`);
        
        allLinks.forEach((link, index) => {
            const href = link.getAttribute('href');
            if (!href || !href.includes('page-')) return;
            
            // Normaliser l'URL et s'assurer qu'on est sur l'onglet feuilleteur si nécessaire
            let fullUrl = href.startsWith('http') ? href : `https://shs.cairn.info${href}`;
            
            // Ajouter ?tab=feuilleteur si ce n'est pas déjà présent (nécessaire pour certaines pages)
            if (!fullUrl.includes('tab=')) {
                fullUrl += (fullUrl.includes('?') ? '&' : '?') + 'tab=feuilleteur';
            }
            
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
            console.log(`[Cairn PDF] Chapitre ajouté: ${title} (${fullUrl})`);
        });
        
        // Trier par numéro de page pour un ordre logique
        links.sort((a, b) => {
            const pageA = extractArticleIdFromUrl(a.url) || 0;
            const pageB = extractArticleIdFromUrl(b.url) || 0;
            return parseInt(pageA) - parseInt(pageB);
        });
        
        console.log(`[Cairn PDF] Total: ${links.length} chapitres trouvés`);
        return links;
    }

    // Fonction principale pour télécharger tous les chapitres
    async function downloadAllChapters() {
        console.log('[Cairn PDF] Début de downloadAllChapters');
        const chapterLinks = findChapterLinks();
        console.log('[Cairn PDF] Chapitres trouvés:', chapterLinks);
        
        if (chapterLinks.length === 0) {
            console.warn('[Cairn PDF] Aucun chapitre trouvé');
            alert('Aucun chapitre trouvé sur cette page.');
            return;
        }

        const confirmMessage = `Trouvé ${chapterLinks.length} chapitre(s). Voulez-vous les télécharger tous ?\n\nCela peut prendre plusieurs minutes.`;
        console.log('[Cairn PDF] Affichage de la confirmation...');
        console.log('[Cairn PDF] Chapitres à télécharger:');
        console.table(chapterLinks);
        
        // Créer une modal personnalisée pour la confirmation (plus fiable que confirm())
        const modal = document.createElement('div');
        modal.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0,0,0,0.5);
            z-index: 100000;
            display: flex;
            align-items: center;
            justify-content: center;
        `;
        
        const modalContent = document.createElement('div');
        modalContent.style.cssText = `
            background: white;
            padding: 30px;
            border-radius: 10px;
            max-width: 500px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.3);
        `;
        
        modalContent.innerHTML = `
            <h2 style="margin-top: 0;">Télécharger tous les chapitres</h2>
            <p>${confirmMessage}</p>
            <div style="display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px;">
                <button id="cairn-confirm-cancel" style="padding: 10px 20px; background: #ccc; border: none; border-radius: 5px; cursor: pointer;">Annuler</button>
                <button id="cairn-confirm-ok" style="padding: 10px 20px; background: #0066cc; color: white; border: none; border-radius: 5px; cursor: pointer; font-weight: bold;">Télécharger</button>
            </div>
        `;
        
        modal.appendChild(modalContent);
        document.body.appendChild(modal);
        
        // Gérer la confirmation avec une promesse
        const userConfirmed = await new Promise((resolve) => {
            const okBtn = document.getElementById('cairn-confirm-ok');
            const cancelBtn = document.getElementById('cairn-confirm-cancel');
            
            okBtn.addEventListener('click', () => {
                document.body.removeChild(modal);
                resolve(true);
            });
            
            cancelBtn.addEventListener('click', () => {
                document.body.removeChild(modal);
                resolve(false);
            });
            
            // Fermer en cliquant en dehors
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    document.body.removeChild(modal);
                    resolve(false);
                }
            });
        });
        
        if (!userConfirmed) {
            console.log('[Cairn PDF] Téléchargement annulé par l\'utilisateur');
            return;
        }
        
        console.log('[Cairn PDF] Confirmation acceptée, début du téléchargement');

        const button = document.getElementById('cairn-download-all-btn');
        if (button) {
            button.disabled = true;
            button.textContent = `Téléchargement en cours... (0/${chapterLinks.length})`;
        }

        let successCount = 0;
        let errorCount = 0;
        const errors = [];

        for (let i = 0; i < chapterLinks.length; i++) {
            const chapter = chapterLinks[i];
            
            try {
                // Mettre à jour le statut
                if (button) {
                    button.textContent = `Récupération PDF ${i + 1}/${chapterLinks.length}...`;
                }

                // Récupérer l'URL du PDF
                const pdfUrl = await fetchPdfUrl(chapter.url);
                
                // Attendre avant de télécharger
                await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_DOWNLOADS));

                // Générer le nom de fichier
                const filename = sanitizeFilename(`${chapter.title || `Chapitre-${i + 1}`}.pdf`);

                // Télécharger le PDF
                if (button) {
                    button.textContent = `Téléchargement ${i + 1}/${chapterLinks.length}: ${filename}`;
                }

                await downloadPdf(pdfUrl, filename);
                successCount++;

                console.log(`✓ Téléchargé: ${filename}`);

                // Délai entre chaque chapitre (sauf pour le dernier)
                if (i < chapterLinks.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_PAGE_FETCHES));
                }

            } catch (error) {
                errorCount++;
                const errorMsg = `Erreur pour ${chapter.title || chapter.url}: ${error.message}`;
                errors.push(errorMsg);
                console.error(errorMsg);
            }
        }

        // Message final
        if (button) {
            button.disabled = false;
            button.textContent = 'Télécharger tous les chapitres';
        }

        let message = `Téléchargement terminé !\n\n`;
        message += `✓ Réussis: ${successCount}\n`;
        message += `✗ Échecs: ${errorCount}\n`;
        
        if (errors.length > 0) {
            message += `\nErreurs:\n${errors.join('\n')}`;
        }

        alert(message);
    }

    // Fonction pour ajouter le bouton sur la page principale
    function addDownloadButton() {
        // Vérifier si on est sur une page principale (pas une page de chapitre)
        // Les pages de chapitres ont "page-XX" dans l'URL (sauf page-1 qui peut être la page de début)
        const url = window.location.href;
        const isChapterPage = /page-\d+/.test(url) && !url.includes('page-1?');
        
        if (isChapterPage) {
            return; // On est sur une page de chapitre, ne pas ajouter le bouton
        }
        
        // Vérifier qu'il y a des chapitres sur la page
        const chapterLinks = findChapterLinks();
        if (chapterLinks.length === 0) {
            return; // Pas de chapitres trouvés, ne pas afficher le bouton
        }

        // Vérifier si le bouton existe déjà
        if (document.getElementById('cairn-download-all-btn')) {
            return;
        }

        // Chercher un endroit approprié pour placer le bouton
        // Essayer de trouver la zone de navigation ou les onglets
        const targetContainer = document.querySelector('.shadow-frame, .flex.flex-row.items-center, header, nav') 
            || document.body;

        // Créer le bouton
        const button = document.createElement('button');
        button.id = 'cairn-download-all-btn';
        button.textContent = 'Télécharger tous les chapitres';
        button.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            z-index: 10000;
            padding: 12px 24px;
            background-color: #0066cc;
            color: white;
            border: none;
            border-radius: 8px;
            font-size: 14px;
            font-weight: bold;
            cursor: pointer;
            box-shadow: 0 4px 6px rgba(0,0,0,0.3);
            transition: background-color 0.3s;
        `;
        
        button.addEventListener('mouseenter', () => {
            button.style.backgroundColor = '#0052a3';
        });
        
        button.addEventListener('mouseleave', () => {
            button.style.backgroundColor = '#0066cc';
        });

        button.addEventListener('click', function(e) {
            console.log('[Cairn PDF] Bouton cliqué!', e);
            e.preventDefault();
            e.stopPropagation();
            try {
                downloadAllChapters();
            } catch (error) {
                console.error('[Cairn PDF] Erreur lors du clic:', error);
                alert('Erreur: ' + error.message);
            }
        });

        // Ajouter le bouton à la page
        document.body.appendChild(button);
        console.log('[Cairn PDF] Bouton ajouté à la page');
    }

    // Initialiser le script
    function init() {
        // Attendre que la page soit chargée
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', addDownloadButton);
        } else {
            addDownloadButton();
        }

        // Réinitialiser si la page change (pour Livewire/SPA)
        if (typeof Livewire !== 'undefined') {
            document.addEventListener('livewire:navigated', () => {
                setTimeout(addDownloadButton, 500);
            });
        }
    }

    // Exposer des fonctions de test dans la console AVANT init
    window.CairnPDFDebug = {
        // Tester la détection des chapitres
        testFindChapters: function() {
            console.log('=== Test: Détection des chapitres ===');
            const links = findChapterLinks();
            console.log('Chapitres trouvés:', links.length);
            console.table(links);
            return links;
        },
        
        // Tester la récupération d'URL PDF pour un chapitre
        testFetchPdfUrl: async function(chapterUrl) {
            console.log('=== Test: Récupération URL PDF ===');
            console.log('URL du chapitre:', chapterUrl);
            try {
                const pdfUrl = await fetchPdfUrl(chapterUrl);
                console.log('✓ URL PDF trouvée:', pdfUrl);
                console.log('Vous pouvez tester le téléchargement avec:');
                console.log(`window.CairnPDFDebug.testDownloadOne('${chapterUrl}', 'test.pdf')`);
                return pdfUrl;
            } catch (error) {
                console.error('✗ Erreur:', error);
                throw error;
            }
        },
        
        // Test rapide avec un chapitre de l'exemple
        testQuick: async function() {
            console.log('=== Test rapide avec le chapitre 1 ===');
            const testUrl = 'https://shs.cairn.info/l-ia-et-l-emploi--9782724644852-page-13?lang=fr&tab=feuilleteur';
            console.log('URL testée:', testUrl);
            try {
                const pdfUrl = await fetchPdfUrl(testUrl);
                console.log('✓ URL PDF récupérée:', pdfUrl);
                console.log('\n=== Test de téléchargement ===');
                await downloadPdf(pdfUrl, 'test-chapitre-1.pdf');
                console.log('✓ Téléchargement réussi!');
                return pdfUrl;
            } catch (error) {
                console.error('✗ Erreur:', error);
                throw error;
            }
        },
        
        // Tester le téléchargement d'un seul PDF
        testDownloadOne: async function(chapterUrl, filename) {
            console.log('=== Test: Téléchargement d\'un PDF ===');
            try {
                const pdfUrl = await fetchPdfUrl(chapterUrl);
                console.log('URL PDF:', pdfUrl);
                await downloadPdf(pdfUrl, filename || 'test.pdf');
                console.log('✓ Téléchargement réussi');
            } catch (error) {
                console.error('✗ Erreur:', error);
                throw error;
            }
        },
        
        // Vérifier les permissions
        checkPermissions: function() {
            console.log('=== Test: Vérification des permissions ===');
            console.log('GM_xmlhttpRequest disponible:', typeof GM_xmlhttpRequest !== 'undefined');
            console.log('GM_download disponible:', typeof GM_download !== 'undefined');
            return {
                xmlhttpRequest: typeof GM_xmlhttpRequest !== 'undefined',
                download: typeof GM_download !== 'undefined'
            };
        },
        
        // Afficher les informations du bouton
        checkButton: function() {
            const btn = document.getElementById('cairn-download-all-btn');
            console.log('=== Test: Vérification du bouton ===');
            console.log('Bouton trouvé:', !!btn);
            if (btn) {
                console.log('Bouton:', btn);
                console.log('Texte:', btn.textContent);
                console.log('Disabled:', btn.disabled);
                console.log('Event listeners:', getEventListeners ? getEventListeners(btn) : 'Non disponible');
            }
            return btn;
        },
        
        // Tester manuellement le clic
        testClick: function() {
            const btn = document.getElementById('cairn-download-all-btn');
            if (btn) {
                console.log('Simulation du clic sur le bouton');
                btn.click();
            } else {
                console.error('Bouton non trouvé');
            }
        },
        
        // Fonctions internes exposées pour le débogage
        _findChapterLinks: findChapterLinks,
        _fetchPdfUrl: fetchPdfUrl,
        _downloadPdf: downloadPdf,
        _downloadAllChapters: downloadAllChapters
    };
    
    init();
    
    console.log('%c[Cairn PDF] Script chargé! Utilisez window.CairnPDFDebug pour tester', 'color: green; font-weight: bold');
    console.log('Commandes disponibles:');
    console.log('  - CairnPDFDebug.testFindChapters() : Trouver les chapitres');
    console.log('  - CairnPDFDebug.testFetchPdfUrl(url) : Tester la récupération d\'URL PDF');
    console.log('  - CairnPDFDebug.testDownloadOne(url, filename) : Télécharger un PDF de test');
    console.log('  - CairnPDFDebug.checkPermissions() : Vérifier les permissions');
    console.log('  - CairnPDFDebug.checkButton() : Vérifier le bouton');
    console.log('  - CairnPDFDebug.testClick() : Simuler un clic');
})();

