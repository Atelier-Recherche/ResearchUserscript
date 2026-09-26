// ==UserScript==
// @name         Cairn PDF Downloader
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  Télécharge tous les PDFs des chapitres d'un livre Cairn en libre accès et peut les fusionner en un seul PDF
// @author       You
// @match        https://shs.cairn.info/*
// @match        https://*.cairn.info/*
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_getResourceURL
// @connect      cairn.info
// @connect      shs.cairn.info
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

    // Fonction pour charger pdf-lib depuis CDN en utilisant une injection dans la page
    function loadPdfLib() {
        return new Promise((resolve, reject) => {
            console.log('[Cairn PDF] Chargement de pdf-lib...');
            
            // Vérifier si pdf-lib est déjà chargé
            const checkAlreadyLoaded = () => {
                const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
                if (win.pdfLib && win.pdfLib.PDFDocument) {
                    console.log('[Cairn PDF] pdf-lib déjà chargé');
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
                    console.log('[Cairn PDF] pdf-lib détecté comme chargé (PDFDocument trouvé)');
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
                        console.log('[Cairn PDF] pdf-lib chargé dans la page');
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
                            console.log('[Cairn PDF] PDFDocument trouvé et disponible');
                            window.dispatchEvent(new CustomEvent('${callbackId}_pdfLibReady'));
                        } else {
                            console.error('[Cairn PDF] pdf-lib chargé mais PDFDocument non disponible. pdfLib:', window.pdfLib);
                            // Attendre un peu et réessayer (parfois pdf-lib met du temps à s'initialiser)
                            setTimeout(function() {
                                if (window.pdfLib && window.pdfLib.PDFDocument) {
                                    window.dispatchEvent(new CustomEvent('${callbackId}_pdfLibReady'));
                                } else {
                                    console.error('[Cairn PDF] PDFDocument toujours non disponible après délai');
                                }
                            }, 500);
                        }
                    };
                    script.onerror = function() {
                        console.error('[Cairn PDF] Erreur jsdelivr, tentative unpkg...');
                        const script2 = document.createElement('script');
                        script2.src = 'https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js';
                        script2.onload = function() {
                            console.log('[Cairn PDF] pdf-lib chargé depuis unpkg');
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
                console.log('[Cairn PDF] pdf-lib prêt (via événement)');
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

    // Fonction pour fusionner plusieurs PDFs en utilisant une injection dans la page
    async function mergePdfs(pdfBlobs, chapterLinks) {
        console.log('[Cairn PDF] Début de la fusion des PDFs...');
        
        // D'abord charger pdf-lib dans la page
        await loadPdfLib();
        
        // Convertir les blobs en ArrayBuffer pour les passer à la fonction de fusion
        const pdfArrayBuffers = [];
        for (let i = 0; i < pdfBlobs.length; i++) {
            const arrayBuffer = await pdfBlobs[i].blob.arrayBuffer();
            pdfArrayBuffers.push({
                data: Array.from(new Uint8Array(arrayBuffer)),
                title: pdfBlobs[i].title
            });
        }
        
        // Générer le nom du fichier fusionné
        const pageTitle = document.title.replace(/\s*-\s*Cairn\.info.*$/i, '').trim();
        const mergedFilename = sanitizeFilename(`${pageTitle || 'Livre_Cairn'}_complet.pdf`);
        
        // Créer un ID unique pour cette fusion
        const mergeId = 'cairn_merge_' + Date.now();
        
        // Injecter la fonction de fusion dans la page où pdf-lib est accessible
        return new Promise((resolve, reject) => {
            const mergeScript = document.createElement('script');
            mergeScript.textContent = `
                (function() {
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
                    
                    if (!PDFDocument || typeof PDFDocument.create !== 'function') {
                        console.error('[Cairn PDF] PDFDocument non disponible. pdfLib:', window.pdfLib);
                        window.dispatchEvent(new CustomEvent('${mergeId}_error', { 
                            detail: 'PDFDocument non disponible dans pdf-lib' 
                        }));
                        return;
                    }
                    const pdfData = ${JSON.stringify(pdfArrayBuffers)};
                    const filename = ${JSON.stringify(mergedFilename)};
                    
                    (async function() {
                        try {
                            console.log('[Cairn PDF] Début de la fusion dans la page...');
                            const mergedPdf = await PDFDocument.create();
                            let totalPages = 0;
                            
                            for (let i = 0; i < pdfData.length; i++) {
                                console.log('[Cairn PDF] Ajout du PDF ' + (i + 1) + '/' + pdfData.length + ': ' + pdfData[i].title);
                                const arrayBuffer = new Uint8Array(pdfData[i].data).buffer;
                                const pdf = await PDFDocument.load(arrayBuffer);
                                const pages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
                                pages.forEach((page) => {
                                    mergedPdf.addPage(page);
                                });
                                totalPages += pdf.getPageCount();
                                console.log('[Cairn PDF] ✓ ' + pdf.getPageCount() + ' page(s) ajoutée(s)');
                            }
                            
                            console.log('[Cairn PDF] Génération du PDF fusionné...');
                            const mergedPdfBytes = await mergedPdf.save();
                            
                            // Créer un blob et déclencher le téléchargement
                            const blob = new Blob([mergedPdfBytes], { type: 'application/pdf' });
                            const blobUrl = URL.createObjectURL(blob);
                            const a = document.createElement('a');
                            a.href = blobUrl;
                            a.download = filename;
                            document.body.appendChild(a);
                            a.click();
                            document.body.removeChild(a);
                            URL.revokeObjectURL(blobUrl);
                            
                            console.log('[Cairn PDF] ✓ PDF fusionné téléchargé: ' + filename);
                            console.log('[Cairn PDF] Total: ' + totalPages + ' pages');
                            
                            window.dispatchEvent(new CustomEvent('${mergeId}_success', { 
                                detail: { filename: filename, pages: totalPages } 
                            }));
                        } catch (error) {
                            console.error('[Cairn PDF] Erreur lors de la fusion:', error);
                            window.dispatchEvent(new CustomEvent('${mergeId}_error', { 
                                detail: error.message 
                            }));
                        }
                    })();
                })();
            `;
            
            const successHandler = (e) => {
                window.removeEventListener(`${mergeId}_success`, successHandler);
                window.removeEventListener(`${mergeId}_error`, errorHandler);
                console.log('[Cairn PDF] Fusion réussie:', e.detail);
                resolve();
            };
            
            const errorHandler = (e) => {
                window.removeEventListener(`${mergeId}_success`, successHandler);
                window.removeEventListener(`${mergeId}_error`, errorHandler);
                reject(new Error(e.detail || 'Erreur lors de la fusion'));
            };
            
            window.addEventListener(`${mergeId}_success`, successHandler);
            window.addEventListener(`${mergeId}_error`, errorHandler);
            
            // Timeout de sécurité
            setTimeout(() => {
                window.removeEventListener(`${mergeId}_success`, successHandler);
                window.removeEventListener(`${mergeId}_error`, errorHandler);
                reject(new Error('Timeout: la fusion a pris trop de temps'));
            }, 60000); // 60 secondes pour fusionner
            
            // Injecter le script dans la page
            (document.head || document.documentElement).appendChild(mergeScript);
        });
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
            <div style="margin: 20px 0;">
                <label style="display: flex; align-items: center; gap: 10px; cursor: pointer;">
                    <input type="checkbox" id="cairn-merge-pdfs" checked style="width: 18px; height: 18px; cursor: pointer;">
                    <span>Fusionner tous les PDFs en un seul fichier (dans le bon ordre)</span>
                </label>
            </div>
            <div style="display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px;">
                <button id="cairn-confirm-cancel" style="padding: 10px 20px; background: #ccc; border: none; border-radius: 5px; cursor: pointer;">Annuler</button>
                <button id="cairn-confirm-ok" style="padding: 10px 20px; background: #0066cc; color: white; border: none; border-radius: 5px; cursor: pointer; font-weight: bold;">Télécharger</button>
            </div>
        `;
        
        modal.appendChild(modalContent);
        document.body.appendChild(modal);
        
        // Gérer la confirmation avec une promesse
        const userChoice = await new Promise((resolve) => {
            const okBtn = document.getElementById('cairn-confirm-ok');
            const cancelBtn = document.getElementById('cairn-confirm-cancel');
            
            okBtn.addEventListener('click', () => {
                const mergePdfs = document.getElementById('cairn-merge-pdfs').checked;
                document.body.removeChild(modal);
                resolve({ confirmed: true, mergePdfs: mergePdfs });
            });
            
            cancelBtn.addEventListener('click', () => {
                document.body.removeChild(modal);
                resolve({ confirmed: false, mergePdfs: false });
            });
            
            // Fermer en cliquant en dehors
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    document.body.removeChild(modal);
                    resolve({ confirmed: false, mergePdfs: false });
                }
            });
        });
        
        if (!userChoice.confirmed) {
            console.log('[Cairn PDF] Téléchargement annulé par l\'utilisateur');
            return;
        }
        
        const shouldMerge = userChoice.mergePdfs;
        
        console.log('[Cairn PDF] Confirmation acceptée, début du téléchargement');

        const button = document.getElementById('cairn-download-all-btn');
        if (button) {
            button.disabled = true;
            button.textContent = shouldMerge ? 
                `Récupération des PDFs... (0/${chapterLinks.length})` : 
                `Téléchargement en cours... (0/${chapterLinks.length})`;
        }

        let successCount = 0;
        let errorCount = 0;
        const errors = [];
        const pdfBlobs = []; // Pour stocker les PDFs en mémoire si fusion

        for (let i = 0; i < chapterLinks.length; i++) {
            const chapter = chapterLinks[i];
            
            try {
                // Mettre à jour le statut
                if (button) {
                    button.textContent = shouldMerge ?
                        `Récupération PDF ${i + 1}/${chapterLinks.length}...` :
                        `Récupération PDF ${i + 1}/${chapterLinks.length}...`;
                }

                // Récupérer l'URL du PDF
                const pdfUrl = await fetchPdfUrl(chapter.url);
                
                // Attendre avant de télécharger
                await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_DOWNLOADS));

                // Générer le nom de fichier
                const filename = sanitizeFilename(`${chapter.title || `Chapitre-${i + 1}`}.pdf`);

                if (shouldMerge) {
                    // Télécharger en mémoire pour fusionner
                    if (button) {
                        button.textContent = `Téléchargement ${i + 1}/${chapterLinks.length} en mémoire...`;
                    }
                    
                    const response = await fetch(pdfUrl);
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    const blob = await response.blob();
                    pdfBlobs.push({ blob: blob, title: chapter.title || `Chapitre ${i + 1}` });
                    successCount++;
                    console.log(`✓ PDF récupéré en mémoire: ${filename}`);
                } else {
                    // Télécharger normalement
                    if (button) {
                        button.textContent = `Téléchargement ${i + 1}/${chapterLinks.length}: ${filename}`;
                    }
                    await downloadPdf(pdfUrl, filename);
                    successCount++;
                    console.log(`✓ Téléchargé: ${filename}`);
                }

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

        // Fusionner les PDFs si demandé
        if (shouldMerge && pdfBlobs.length > 0) {
            if (button) {
                button.textContent = 'Fusion des PDFs en cours...';
            }
            try {
                await mergePdfs(pdfBlobs, chapterLinks);
                console.log('✓ PDFs fusionnés avec succès!');
            } catch (error) {
                console.error('✗ Erreur lors de la fusion:', error);
                errors.push(`Erreur lors de la fusion: ${error.message}`);
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

    // Créer l'objet de débogage une seule fois
    const debugObj = {
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
        
        // Tester la fusion avec seulement 2-3 PDFs (sans tout télécharger)
        testMerge: async function() {
            console.log('=== Test: Fusion de PDFs (2-3 fichiers seulement) ===');
            const chapters = findChapterLinks();
            
            if (chapters.length === 0) {
                console.error('Aucun chapitre trouvé sur cette page');
                return;
            }
            
            // Prendre seulement les 2-3 premiers chapitres pour le test
            const testChapters = chapters.slice(0, Math.min(3, chapters.length));
            console.log(`Test avec ${testChapters.length} chapitre(s):`, testChapters.map(c => c.title));
            
            const pdfBlobs = [];
            
            try {
                for (let i = 0; i < testChapters.length; i++) {
                    const chapter = testChapters[i];
                    console.log(`\n[${i + 1}/${testChapters.length}] Récupération de: ${chapter.title}`);
                    
                    const pdfUrl = await fetchPdfUrl(chapter.url);
                    console.log('URL PDF:', pdfUrl);
                    
                    const response = await fetch(pdfUrl);
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    const blob = await response.blob();
                    pdfBlobs.push({ blob: blob, title: chapter.title });
                    console.log(`✓ PDF récupéré: ${chapter.title}`);
                }
                
                console.log('\n=== Test de fusion ===');
                await mergePdfs(pdfBlobs, testChapters);
                console.log('✓ Test de fusion réussi!');
                
            } catch (error) {
                console.error('✗ Erreur lors du test:', error);
                throw error;
            }
        },
        
        // Fonctions internes exposées pour le débogage
        _findChapterLinks: findChapterLinks,
        _fetchPdfUrl: fetchPdfUrl,
        _downloadPdf: downloadPdf,
        _downloadAllChapters: downloadAllChapters,
        _mergePdfs: mergePdfs
    };
    
    // Exposer dans le contexte du userscript
    window.CairnPDFDebug = debugObj;
    
    // Exposer aussi dans le contexte de la page (pour les userscripts isolés)
    const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    if (win !== window) {
        win.CairnPDFDebug = debugObj;
    }
    
    init();
    
    console.log('%c[Cairn PDF] Script chargé! Utilisez window.CairnPDFDebug pour tester', 'color: green; font-weight: bold');
    console.log('Commandes disponibles:');
    console.log('  - CairnPDFDebug.testFindChapters() : Trouver les chapitres');
    console.log('  - CairnPDFDebug.testFetchPdfUrl(url) : Tester la récupération d\'URL PDF');
    console.log('  - CairnPDFDebug.testDownloadOne(url, filename) : Télécharger un PDF de test');
    console.log('  - CairnPDFDebug.testMerge() : Tester la fusion avec 2-3 PDFs seulement');
    console.log('  - CairnPDFDebug.checkPermissions() : Vérifier les permissions');
    console.log('  - CairnPDFDebug.checkButton() : Vérifier le bouton');
    console.log('  - CairnPDFDebug.testClick() : Simuler un clic');
})();

