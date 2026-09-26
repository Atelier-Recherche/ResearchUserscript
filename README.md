# AT Research Userscripts

Collection de **userscripts** destinés aux chercheurs, doctorants et étudiants en sciences humaines et sociales. Chaque script automatise une tâche répétitive sur une plateforme académique (téléchargement, navigation, export…), sans remplacer l’accès légitime aux contenus.

> Prérequis : un gestionnaire de userscripts — [Tampermonkey](https://www.tampermonkey.net/) ou [Violentmonkey](https://violentmonkey.github.io/).

---

## Installation rapide

1. Installez Tampermonkey ou Violentmonkey dans votre navigateur.
2. Ouvrez le fichier `.user.js` du script souhaité (ou cliquez sur le lien *Installer* ci-dessous).
3. Confirmez l’installation dans le gestionnaire.
4. Rechargez la page cible : le script s’active automatiquement.

---

## Scripts disponibles

| Script | Plateforme | Description | Installer |
|--------|------------|-------------|-----------|
| **Cairn PDF Downloader** | [Cairn.info](https://www.cairn.info/) / [shs.cairn.info](https://shs.cairn.info/) | Télécharge tous les PDF des chapitres d’un ouvrage en libre accès, avec option de fusion en un seul fichier | [`cairn-pdf-downloader.user.js`](./cairn-pdf-downloader.user.js) |

---

### Cairn PDF Downloader

Sur la page d’un **livre ou dossier en libre accès** sur Cairn, un bouton *Télécharger tous les chapitres* apparaît en haut à droite.

**Fonctionnalités**

- Détection automatique des chapitres et téléchargement séquentiel des PDF
- Option pour **fusionner** tous les chapitres en un seul PDF (ordre respecté)
- Nommage des fichiers à partir des titres de chapitres
- Délais entre les requêtes pour ne pas surcharger le serveur

**Utilisation**

1. Ouvrez la page principale d’un ouvrage Cairn en libre accès (pas une page de chapitre isolée).
2. Cliquez sur *Télécharger tous les chapitres*.
3. Cochez ou décochez la fusion en un seul PDF, puis validez.
4. Attendez la fin du processus (plusieurs minutes selon le nombre de chapitres).

**Périmètre**

- Fonctionne uniquement sur les contenus **déjà accessibles** via votre navigateur (libre accès ou session authentifiée).
- Ne contourne pas les paywalls ni les restrictions d’accès.

---

## Structure du dépôt

```
ATResearchUserscript/
├── README.md
└── cairn-pdf-downloader.user.js   # script officiel
```

Les fichiers `*.nomerge.js` / `*.debugmerge.js` éventuels sont des variantes de développement et ne sont pas destinés à l’installation courante.

---

## Contribuer

Les contributions sont les bienvenues : nouveau userscript, correction, amélioration d’UI ou de compatibilité.

Pour proposer un script :

1. Un fichier `nom-descriptif.user.js` avec un en-tête UserScript complet (`@name`, `@match`, `@description`, etc.).
2. Une courte entrée dans le tableau *Scripts disponibles* de ce README.
3. Une section d’usage (comme pour Cairn) si le comportement n’est pas évident.

Idées de domaines utiles : Persée, OpenEdition, Gallica, HAL, Google Scholar, Zotero / export bibliographique, etc.

---

## Avertissement

Ces outils sont fournis **tels quels**, à des fins de recherche et de confort d’usage. Respectez les conditions d’utilisation des sites concernés, le droit d’auteur et les licences des documents. L’auteur du dépôt n’est pas affilié à Cairn.info ni aux plateformes ciblées.

---

## Licence

À préciser (MIT ou autre) selon votre choix avant publication publique.
