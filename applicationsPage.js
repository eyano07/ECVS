/**
 * ==========================================================================
 * SCRIPT PAGE DES DEMANDES (Content Script) — Extension Chrome CEV_AVI
 * ==========================================================================
 *
 * Ce script est injecté sur la page "My applications" :
 *   https://visaonweb.diplomatie.be/<langue>/VisaApplication/IndexByUserId
 *
 * MISE À JOUR DU PORTAIL — NOUVEAU PARCOURS :
 * La colonne « Action » n'expose PLUS de bouton calendrier. Le captcha ne
 * s'atteint plus qu'en deux temps :
 *     ligne du demandeur → bouton d'édition (crayon) → page /VisaApplication/Edit/<id>
 *     → bouton « Gérer votre rendez-vous » → page captcha
 * Ce script couvre la PREMIÈRE étape ; editPage.js couvre la seconde.
 *
 * Son rôle :
 *  Lorsqu'une autre fenêtre a trouvé un créneau et que le background script
 *  a posé le flag `pendingBooking` en storage (ou envoyé le message `startBooking`),
 *  ce script :
 *    1. Récupère l'internet number du demandeur de ce profil.
 *    2. Saisit cet internet number dans l'input de recherche DataTables.
 *    3. Attend que le tableau filtre la ligne correspondante.
 *    4. Lit l'URL du dossier sur le bouton d'édition de cette ligne, SANS le
 *       cliquer : elle s'obtient par lecture du DOM (href, ou identifiant dans
 *       l'expression ng-click). Le dossier est ensuite ouvert dans un NOUVEL
 *       onglet via le service worker. L'onglet IndexByUserId est CONSERVÉ et son
 *       filtre vidé pour réafficher tous les demandeurs.
 *       → editPage.js prend le relais sur la page Edit, puis client.js sur SelectSlot.
 *    5. Dernier recours si l'URL n'a pas pu être lue : le bouton d'édition est
 *       réellement cliqué (via le pont Angular), ce qui navigue CET onglet vers
 *       le dossier. Un garde-fou relance un cycle complet si rien ne se produit,
 *       jusqu'à MAX_BOOKING_ATTEMPTS fois, au lieu de rester bloqué sur le filtre.
 *    6. Réinitialise le flag `pendingBooking` (à la confirmation ou à l'abandon).
 *
 *  En parallèle, dès le chargement de la page, l'URL du dossier du profil est
 *  résolue puis mise en cache (`applicationEditUrl`). Le service worker peut
 *  alors, à la notification suivante, ouvrir le dossier IMMÉDIATEMENT — sans
 *  filtrage DataTables ni même onglet IndexByUserId ouvert. C'est le chemin
 *  normal ; tout ce qui précède n'est que le repli quand le cache est vide.
 *
 * Sélecteurs utilisés (à ajuster si le site change) :
 *   - Input recherche DataTables : .dataTables_filter input
 *   - Bouton d'édition : localisé DANS la ligne du bon demandeur via
 *     findEditControlForRow() (lien vers /VisaApplication/Edit/, ng-click editVA,
 *     icône crayon, fallback 1er bouton de la colonne Action).
 *
 * NOTE sur les sélecteurs :
 *   Le tableau est rendu par Angular + DataTables ; les actions sont des
 *   <button ng-click="..."> avec une icône <span class="glyphicon glyphicon-pencil">.
 *   Si le DOM réel diffère, ajustez findEditControlForRow().
 * ==========================================================================
 */
(() => {

    // ======================== CONSTANTES ========================

    /**
     * Sélecteur de l'input de recherche DataTables.
     * Standard DataTables : .dataTables_filter input
     */
    const SEARCH_INPUT_SELECTOR = '.dataTables_filter input';

    /**
     * Le bouton d'édition est localisé DANS la ligne du bon demandeur par
     * findEditControlForRow() : priorité au lien /VisaApplication/Edit/<id>, puis
     * au ng-click="editVA(...)", puis à l'icône crayon, puis au 1er bouton de la
     * colonne Action.
     */

    /**
     * Identifiant de dossier (GUID) tel qu'il apparaît dans l'URL de la page Edit
     * ou dans l'expression ng-click du bouton d'édition.
     * Ex : 68eb5454-2a6f-f111-a3ae-00505691de06
     */
    const APPLICATION_ID_REGEX = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

    /** Fragment d'URL de la page de détail d'un dossier. */
    const EDIT_PATH_FRAGMENT = '/VisaApplication/Edit/';

    /**
     * Nombre maximum de tentatives de la chaîne de polling pour trouver la
     * ligne après filtrage. Avec FIND_RETRY_MS, borne l'attente à ~6 s.
     * Un MutationObserver déclenche en parallèle une recherche immédiate dès
     * que DataTables re-rend le tableau (chaque milliseconde compte pour
     * l'ouverture du dossier), sans consommer ce budget.
     */
    const MAX_FIND_ATTEMPTS = 30;

    /** Intervalle (ms) entre chaque tentative de recherche de la ligne (filet de secours) */
    const FIND_RETRY_MS = 200;

    /**
     * Délai (ms) accordé au clic de DERNIER RECOURS sur le bouton d'édition pour
     * aboutir à une navigation vers la page du dossier. Doit rester SUPÉRIEUR au
     * filet de sécurité de pageBridge.js pour laisser le pont signaler l'échec
     * lui-même — avec sa cause précise — avant que ce garde-fou ne se déclenche.
     */
    const BOOKING_CONFIRM_TIMEOUT_MS = 12000;

    /** Nombre maximum de cycles complets (filtrage + ouverture) pour un même RDV. */
    const MAX_BOOKING_ATTEMPTS = 3;

    /** Pause (ms) avant de relancer un cycle complet après un échec. */
    const BOOKING_RETRY_BACKOFF_MS = 600;

    // ======================== LOGIQUE PRINCIPALE ========================

    /**
     * Trouve la ligne <tr> du tableau dont le contenu correspond à l'internet number.
     *
     * @param {string} internetNumber - Numéro internet recherché.
     * @returns {HTMLElement|null} La ligne, ou null si elle n'est pas (encore) dans le DOM.
     */
    function findRowForInternetNumber(internetNumber) {
        const rows = document.querySelectorAll('table tbody tr');
        const needle = internetNumber.trim().toLowerCase();

        for (const row of rows) {
            // Matching prioritaire sur la 1ère cellule (colonne "Numéro internet")
            // pour éviter de matcher par sous-chaîne le nom ou un autre numéro.
            const firstCell = row.querySelector('td');
            const firstCellText = firstCell ? firstCell.textContent.trim().toLowerCase() : '';

            const matchesFirstCell = firstCellText === needle || firstCellText.includes(needle);
            const matchesRow = !firstCell && row.textContent.toLowerCase().includes(needle);

            if (matchesFirstCell || matchesRow) {
                return row;
            }
        }

        return null; // Ligne pas encore dans le DOM (filtrage/pagination en cours)
    }

    /**
     * Renvoie l'élément d'ÉDITION (crayon) de la ligne — celui qui mène à la page
     * du dossier /VisaApplication/Edit/<id>.
     *
     * Le tableau réel (Angular + DataTables) utilise des <button> avec ng-click :
     *   <button ng-click="editVA('<id>')"><span class="glyphicon glyphicon-pencil"></span></button>  ← ÉDITION
     *   <button ng-click="printVA('<id>')"><span class="glyphicon glyphicon-print"></span></button>
     *
     * @param {HTMLElement|null} row - Ligne du demandeur.
     * @returns {HTMLElement|null} Le bouton/lien d'édition, ou null.
     */
    function findEditControlForRow(row) {
        if (!row) return null;

        // 1) Lien direct vers la page du dossier : le plus fiable, et le seul qui
        //    porte l'URL complète sans avoir à la reconstruire.
        const editLink = row.querySelector(`a[href*="${EDIT_PATH_FRAGMENT}"]`);
        if (editLink) return editLink;

        // 2) ng-click="editVA(...)"
        const ngBtn = row.querySelector('[ng-click^="editVA"], [ng-click*="editVA"]');
        if (ngBtn) {
            return ngBtn.closest('button, a') || ngBtn;
        }

        // 3) via l'icône crayon (Glyphicon / Font Awesome) → remonte au <button>
        //    ou <a> parent réellement cliquable.
        const pencilIcon = row.querySelector(
            '.glyphicon-pencil, .fa-pencil, .fa-pencil-alt, .fa-pen, .fa-edit, [class*="pencil"]'
        );
        if (pencilIcon) {
            const clickable = pencilIcon.closest('button, a');
            if (clickable) return clickable;
        }

        // 4) fallback : 1er bouton/lien d'action de la dernière cellule.
        //    Ordre observé : 1=édition, 2=impression.
        const actionCell = row.querySelector('td:last-child');
        if (actionCell) {
            const controls = actionCell.querySelectorAll('button, a');
            if (controls.length >= 1) return controls[0];
        }

        return null;
    }

    /**
     * Construit l'URL absolue de la page du dossier à partir d'un identifiant.
     * Le préfixe de langue est repris de l'URL COURANTE (fr-BE, en, nl-BE…) :
     * le portail sert une page distincte par langue et changer de langue en
     * cours de route ferait perdre les libellés attendus par editPage.js.
     *
     * @param {string} applicationId - GUID du dossier.
     * @returns {string} URL absolue.
     */
    function buildEditUrl(applicationId) {
        const langMatch = window.location.pathname.match(/^\/([^/]+)\/VisaApplication\//i);
        const lang = langMatch ? langMatch[1] : 'fr-BE';
        return `${window.location.origin}/${lang}${EDIT_PATH_FRAGMENT}${applicationId}`;
    }

    /**
     * Extrait l'URL de la page du dossier depuis la ligne du demandeur, SANS
     * cliquer quoi que ce soit.
     *
     * C'est le cœur du nouveau parcours : le clic sur le crayon ne fait que
     * naviguer vers cette URL, et la lire est à la fois plus rapide (aucun aller-
     * retour par le pont Angular, aucun digest à attendre) et plus sûr (rien ne
     * peut échouer silencieusement). L'URL est ensuite mise en cache pour que les
     * réservations suivantes s'affranchissent complètement du tableau.
     *
     * @param {HTMLElement|null} row - Ligne du demandeur.
     * @returns {string} URL absolue de la page du dossier, ou chaîne vide.
     */
    function extractEditUrlFromRow(row) {
        if (!row) return '';

        // 1) Lien explicite : l'URL est déjà écrite, on la résout en absolu.
        const editLink = row.querySelector(`a[href*="${EDIT_PATH_FRAGMENT}"]`);
        if (editLink) {
            try {
                return new URL(editLink.getAttribute('href'), window.location.href).href;
            } catch { /* href non parsable : on tente les autres pistes */ }
        }

        // 2) Identifiant porté par l'expression ng-click du bouton d'édition.
        const editBtn = row.querySelector('[ng-click^="editVA"], [ng-click*="editVA"]');
        const editExpr = editBtn && editBtn.getAttribute('ng-click');
        const fromEditExpr = editExpr && editExpr.match(APPLICATION_ID_REGEX);
        if (fromEditExpr) {
            return buildEditUrl(fromEditExpr[0]);
        }

        // 3) Dernier recours : premier GUID trouvé dans les attributs de la ligne.
        //    Les actions d'une même ligne (éditer, imprimer, grouper) portent
        //    toutes l'identifiant du MÊME dossier, n'importe lequel fait l'affaire.
        for (const el of row.querySelectorAll('[ng-click], [href], [data-id]')) {
            for (const attr of el.attributes) {
                const match = attr.value.match(APPLICATION_ID_REGEX);
                if (match) return buildEditUrl(match[0]);
            }
        }

        return '';
    }

    /**
     * Extrait le nom du demandeur depuis sa ligne <tr>.
     *
     * Structure typique du tableau :
     *   Numéro internet | Nom | Prénom | ... | Actions
     * On ignore la 1ère cellule (numéro internet) et la colonne d'actions
     * (cellules contenant des boutons/liens), puis on garde les 2 premières
     * cellules textuelles restantes (nom + prénom).
     *
     * @param {HTMLElement|null} row - Ligne du demandeur.
     * @returns {string} Nom du demandeur (best-effort), ou chaîne vide.
     */
    function getApplicantNameFromRow(row) {
        if (!row) return '';
        const cells = Array.from(row.querySelectorAll('td'));
        if (cells.length === 0) return '';

        // Mots de statut à ignorer (FR/EN) — ce ne sont pas des noms.
        const STATUS_WORDS = new Set([
            'nouveau', 'soumis', 'en traitement', 'traité', 'traite', 'en cours',
            'approuvé', 'approuve', 'refusé', 'refuse', 'annulé', 'annule',
            'new', 'submitted', 'pending', 'processing', 'approved', 'rejected', 'cancelled',
        ]);

        const nameParts = [];
        cells.slice(1).forEach((cell) => {
            // Ignore les colonnes d'actions/icônes.
            if (cell.querySelector('button, a, input')) return;

            const txt = cell.textContent.replace(/\s+/g, ' ').trim();
            if (!txt) return;

            const low = txt.toLowerCase();
            if (STATUS_WORDS.has(low)) return;      // ignore le statut
            if (/^vowint/i.test(txt)) return;       // ignore un éventuel numéro internet
            if (/^\d+$/.test(txt)) return;          // ignore une cellule purement numérique

            nameParts.push(txt);
        });

        // Le nom (+ prénom) occupe en général les 1 à 2 premières cellules retenues.
        return nameParts.slice(0, 2).join(' ').replace(/\s+/g, ' ').trim();
    }

    /** Regex pour repérer un email dans le texte du menu utilisateur. */
    const BOOKER_EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

    /** Sélecteurs de la barre de menu horizontale (navbar VisaOnWeb). */
    const NAV_MENU_SELECTORS = [
        'nav.navbar',
        '.navbar',
        '.navbar-nav',
        '.navbar-right',
        'header nav',
        'header',
    ];

    /**
     * Extrait le premier email trouvé dans une chaîne de texte.
     * @param {string} text
     * @returns {string}
     */
    function findEmailInText(text) {
        if (!text) return '';
        const match = text.match(BOOKER_EMAIL_REGEX);
        return match ? match[0].trim().toLowerCase() : '';
    }

    /**
     * Lit l'email du compte connecté dans la barre de menu horizontale
     * (ex: zarahmalula@gmail.com dans le dropdown utilisateur en haut à droite).
     * @returns {string} Email détecté, ou chaîne vide.
     */
    function extractBookerEmailFromMenu() {
        // Priorité aux liens du menu utilisateur (dropdown avec l'email visible).
        const userMenuLinks = document.querySelectorAll(
            'nav.navbar a, .navbar a, .navbar-nav a, .navbar-right a, .dropdown-toggle'
        );
        for (const link of userMenuLinks) {
            const email = findEmailInText(link.textContent);
            if (email) return email;
        }

        // Secours : parcourir les conteneurs de la navbar.
        for (const selector of NAV_MENU_SELECTORS) {
            const el = document.querySelector(selector);
            if (!el) continue;
            const email = findEmailInText(el.textContent);
            if (email) return email;
        }

        return '';
    }

    /**
     * Enregistre l'email « pris par » dans le storage du profil (sans écraser inutilement).
     * @param {string} email
     */
    function persistBookerEmail(email) {
        if (!email) return;
        chrome.storage.local.get(['bookerEmail'], (data) => {
            if (data.bookerEmail === email) return;
            chrome.storage.local.set({ bookerEmail: email });
            console.log(`[CEV_AVI] Email « pris par » capturé depuis le menu : ${email}`);
        });
    }

    /**
     * Surveille le chargement de la navbar (Angular) et capture l'email du menu.
     * Réessaie pendant ~12 s puis écoute les mutations DOM.
     */
    function watchBookerEmailFromMenu() {
        const tryCapture = () => {
            const email = extractBookerEmailFromMenu();
            if (email) {
                persistBookerEmail(email);
                return true;
            }
            return false;
        };

        if (tryCapture()) return;

        let attempts = 0;
        const maxAttempts = 24;
        const intervalId = setInterval(() => {
            attempts += 1;
            if (tryCapture() || attempts >= maxAttempts) {
                clearInterval(intervalId);
            }
        }, 500);

        const observer = new MutationObserver(() => {
            if (tryCapture()) {
                observer.disconnect();
                clearInterval(intervalId);
            }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
    }

    /** Empêche deux séquences de booking simultanées (message + storage.onChanged) */
    let bookingInProgress = false;

    /**
     * Horodatage de la dernière ouverture de dossier déclenchée. Sert d'anti-rebond :
     * les trois canaux de déclenchement (storage.onChanged, message startBooking,
     * checkPendingBooking) arrivent quasi-simultanément pour un MÊME RDV. Sans ce
     * cooldown, un seul créneau ouvrirait plusieurs onglets de dossier, donc
     * plusieurs prises de RDV concurrentes.
     */
    let lastBookingClickTime = 0;

    /** Durée (ms) pendant laquelle un nouveau déclenchement est ignoré après un clic. */
    const BOOKING_COOLDOWN_MS = 12000;

    /** Numéro internet du cycle de booking en cours (pour les réessais). */
    let activeInternetNumber = '';

    /** Numéro du cycle courant (1 = première tentative). */
    let bookingAttempt = 0;

    /** Identifiant du minuteur du garde-fou (confirmation d'ouverture du captcha). */
    let confirmWatchdogId = null;

    /**
     * Identifiant du minuteur de réessai. Le garde-fou et le signal d'échec du
     * pont peuvent arriver tous les deux : sans ce verrou, deux cycles
     * concurrents ouvriraient deux fois le dossier.
     */
    let retryTimerId = null;

    /**
     * Arme le garde-fou après un clic sur le bouton d'édition (chemin de dernier
     * recours uniquement — le chemin normal ouvre un onglet et se conclut tout de
     * suite, sans garde-fou).
     *
     * Ce clic est indirect (marquage de l'élément + postMessage vers pageBridge.js,
     * qui évalue le ng-click dans le contexte Angular) : rien ne garantit qu'il
     * aboutisse. En cas d'échec silencieux — bouton retiré du DOM par un re-rendu
     * DataTables/Angular entre le marquage et le traitement du message, exception
     * Angular — la fenêtre resterait bloquée sur IndexByUserId avec le filtre
     * rempli. Ce minuteur détecte l'absence de navigation et relance un cycle.
     */
    function armBookingWatchdog() {
        clearBookingWatchdog();
        confirmWatchdogId = setTimeout(() => {
            confirmWatchdogId = null;
            retryBookingOrGiveUp('la page du dossier ne s\'est pas ouverte dans le délai imparti');
        }, BOOKING_CONFIRM_TIMEOUT_MS);
    }

    /** Désarme le garde-fou (succès confirmé ou abandon définitif). */
    function clearBookingWatchdog() {
        if (confirmWatchdogId !== null) {
            clearTimeout(confirmWatchdogId);
            confirmWatchdogId = null;
        }
    }

    /**
     * Clôture le cycle de booking : libère le verrou et efface le flag
     * `pendingBooking` (maintenu jusqu'ici pour qu'un rechargement de l'onglet
     * pendant les réessais reprenne la séquence).
     */
    function finishBookingCycle() {
        clearBookingWatchdog();
        if (retryTimerId !== null) {
            clearTimeout(retryTimerId);
            retryTimerId = null;
        }
        bookingInProgress = false;
        bookingAttempt = 0;
        activeInternetNumber = '';
        chrome.storage.local.set({ pendingBooking: false });
    }

    /**
     * Relance un cycle complet (nouveau filtrage + nouvelle résolution) après un échec,
     * ou abandonne si le plafond de tentatives est atteint.
     *
     * Les réessais passent directement par startBookingCycle : ils ne consultent
     * pas l'anti-rebond `lastBookingClickTime`, qui reste réservé aux déclenchements
     * externes (protection contre les doublons multi-canaux).
     *
     * @param {string} reason - Cause de l'échec, pour les logs.
     */
    function retryBookingOrGiveUp(reason) {
        clearBookingWatchdog();

        if (!activeInternetNumber) {
            bookingInProgress = false;
            return;
        }

        if (retryTimerId !== null) {
            console.log(`[CEV_AVI] Réessai déjà programmé — signal ignoré (${reason}).`);
            return;
        }

        if (bookingAttempt >= MAX_BOOKING_ATTEMPTS) {
            console.error(`[CEV_AVI] Prise de RDV abandonnée pour ${activeInternetNumber} après ${bookingAttempt} tentatives (${reason}).`);
            finishBookingCycle();
            return;
        }

        const internetNumber = activeInternetNumber;
        console.warn(`[CEV_AVI] Prise de RDV non aboutie (${reason}) — nouveau cycle ${bookingAttempt + 1}/${MAX_BOOKING_ATTEMPTS} dans ${BOOKING_RETRY_BACKOFF_MS}ms.`);
        retryTimerId = setTimeout(() => {
            retryTimerId = null;
            // Le tableau peut avoir été re-rendu entre-temps : on repart de zéro
            // (filtre vidé puis ressaisi) pour retrouver une ligne fraîche.
            clearSearchInput();
            startBookingCycle(internetNumber);
        }, BOOKING_RETRY_BACKOFF_MS);
    }

    /**
     * Démarre UN cycle de prise de RDV : attente du tableau, puis filtrage et
     * ouverture de la page du dossier.
     *
     * Le compteur `bookingAttempt` est incrémenté ICI et non dans
     * startSearchAndOpenApplication : un échec de `waitForTable` n'atteint jamais
     * startSearchAndOpenApplication, le compteur restait donc à 0, le plafond
     * MAX_BOOKING_ATTEMPTS n'était jamais atteint et le cycle
     * « waitForTable (15 s) → réessai (600 ms) → waitForTable… » tournait
     * indéfiniment, en gardant `pendingBooking` et le verrou bloqués.
     *
     * @param {string} internetNumber - Numéro internet du demandeur.
     */
    function startBookingCycle(internetNumber) {
        activeInternetNumber = internetNumber;
        bookingInProgress = true;
        bookingAttempt += 1;

        console.log(`[CEV_AVI] Cycle de prise de RDV ${bookingAttempt}/${MAX_BOOKING_ATTEMPTS} pour ${internetNumber} — attente du tableau...`);
        waitForTable(() => startSearchAndOpenApplication(internetNumber));
    }

    /**
     * Clique de façon robuste sur un élément.
     *  - Si l'élément porte un ng-click : on délègue au pont AngularJS (pageBridge.js,
     *    exécuté dans le MONDE DE LA PAGE), qui appelle réellement le handler Angular
     *    via scope.$apply + triggerHandler. C'est la seule méthode fiable : un clic
     *    synthétique depuis le content script (monde isolé) est ignoré par AngularJS.
     *  - Sinon : séquence MouseEvent complète + click() natif.
     *
     * @param {HTMLElement} el - Bouton/élément à cliquer.
     */
    function robustClick(el) {
        const ngExpr = el.getAttribute && el.getAttribute('ng-click');

        if (ngExpr) {
            // Marque l'élément pour que pageBridge.js (monde page) le retrouve et
            // déclenche le ng-click dans le contexte Angular.
            el.setAttribute('data-cev-avi-click', '1');
            // Cible explicitement l'origine de la page : le message ne doit pas
            // être lisible par un cadre d'une autre origine.
            window.postMessage({ cevAvi: true, action: 'angularClick' }, window.location.origin);
            console.log(`[CEV_AVI] Demande d'exécution du ng-click au pont Angular : ${ngExpr}`);
            return;
        }

        // Élément non-Angular : clic standard.
        const opts = { bubbles: true, cancelable: true, view: window };
        try {
            el.dispatchEvent(new MouseEvent('mousedown', opts));
            el.dispatchEvent(new MouseEvent('mouseup', opts));
            el.dispatchEvent(new MouseEvent('click', opts));
        } catch (e) {
            console.warn('[CEV_AVI] dispatch MouseEvent a échoué :', e);
        }
        if (typeof el.click === 'function') {
            try { el.click(); } catch { /* ignore */ }
        }
    }

    /**
     * Attend que le tableau DataTables soit initialisé (input de recherche présent
     * ET lignes rendues), puis appelle le callback. DataTables s'initialise via
     * jQuery APRÈS l'injection du content script : il faut donc patienter.
     *
     * @param {Function} callback - Appelé quand le tableau est prêt.
     * @param {number} maxWaitMs - Attente maximale avant d'abandonner.
     * @param {Function} [onTimeout] - Appelé si le tableau n'apparaît jamais.
     *        Par défaut, relance un cycle de réservation ; la pré-résolution
     *        passe un abandon SILENCIEUX, car elle ne doit surtout pas déclencher
     *        de réservation alors qu'aucun créneau n'a été trouvé.
     */
    function waitForTable(callback, maxWaitMs = 15000, onTimeout = null) {
        const startTime = Date.now();

        function check() {
            const searchInput = document.querySelector(SEARCH_INPUT_SELECTOR)
                || document.querySelector('input[type="search"]');
            const hasRows = document.querySelectorAll('table tbody tr').length > 0;

            if (searchInput && hasRows) {
                console.log('[CEV_AVI] Tableau DataTables prêt.');
                callback();
            } else if (Date.now() - startTime < maxWaitMs) {
                setTimeout(check, 100);
            } else if (onTimeout) {
                onTimeout();
            } else {
                console.error(`[CEV_AVI] Tableau DataTables non initialisé après ${Math.round(maxWaitMs / 1000)}s.`);
                retryBookingOrGiveUp('tableau DataTables indisponible');
            }
        }

        check();
    }

    /**
     * Recherche la ligne de l'internet number dans le tableau DataTables et ouvre
     * la page de son dossier pour lancer la prise de rendez-vous.
     *
     * @param {string} internetNumber - Numéro internet du demandeur (ex: VOWINT6055154)
     */
    function triggerBookingForProfile(internetNumber) {
        // Verrou « en cours » : les deux canaux de déclenchement
        // (storage.onChanged + message) arrivent quasi-simultanément pour un
        // même événement. Sans ce verrou, un événement ouvrirait DEUX onglets
        // de dossier. Les chemins d'échec réinitialisent ce verrou, il n'est donc
        // pas bloquant durablement.
        if (bookingInProgress) {
            console.log('[CEV_AVI] Booking déjà en cours — déclenchement ignoré.');
            return;
        }

        // Anti-rebond : ignore les déclenchements rapprochés pour éviter d'ouvrir
        // plusieurs onglets de dossier.
        const sinceLastClick = Date.now() - lastBookingClickTime;
        if (sinceLastClick < BOOKING_COOLDOWN_MS) {
            console.log(`[CEV_AVI] Déclenchement ignoré (cooldown ${Math.round((BOOKING_COOLDOWN_MS - sinceLastClick) / 1000)}s restant).`);
            return;
        }

        // Garde-fou explicite : la fenêtre principale (case « Fenêtre principale »
        // du popup) ne réserve JAMAIS pour elle-même, quel que soit l'internet
        // number configuré — elle ne fait que surveiller et notifier les autres
        // fenêtres (voir client.js). Sans cette vérification, un internet number
        // laissé/saisi par erreur sur cette fenêtre suffirait à déclencher un
        // clic sur « Gérer votre rendez-vous » alors que ce n'est pas son rôle.
        chrome.storage.local.get('isMainWindow', (data) => {
            if (data.isMainWindow === true) {
                console.warn('[CEV_AVI] Fenêtre principale — réservation bloquée (cette fenêtre ne doit jamais cliquer « Gérer votre rendez-vous »).');
                chrome.storage.local.set({ pendingBooking: false });
                return;
            }

            bookingAttempt = 0;

            console.log(`[CEV_AVI] Déclenchement booking pour ${internetNumber}.`);
            startBookingCycle(internetNumber);
        });
    }

    /**
     * Écrit une valeur dans l'input de recherche DataTables et notifie le
     * tableau. Le setter natif est utilisé pour que les frameworks
     * (jQuery/DataTables) détectent bien le changement de valeur ; tous les
     * événements auxquels DataTables peut être abonné sont ensuite émis.
     *
     * @param {string} value - Valeur à filtrer ('' pour tout réafficher).
     * @returns {boolean} true si l'input a été trouvé.
     */
    function applySearchFilter(value) {
        const searchInput = document.querySelector(SEARCH_INPUT_SELECTOR)
            || document.querySelector('input[type="search"]');
        if (!searchInput) return false;

        const nativeSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
        )?.set;
        if (nativeSetter) {
            nativeSetter.call(searchInput, value);
        } else {
            searchInput.value = value;
        }
        searchInput.focus();
        ['input', 'keyup', 'keydown', 'change', 'search'].forEach((evtName) => {
            searchInput.dispatchEvent(new Event(evtName, { bubbles: true }));
        });
        return true;
    }

    /**
     * Filtre le tableau sur l'internet number puis attend l'apparition de la
     * ligne correspondante.
     *
     * Le filtre est nécessaire : DataTables ne rend que la page courante
     * (~10 lignes sur 145), la bonne ligne n'est donc pas forcément dans le DOM.
     *
     * Plutôt que d'attendre un délai fixe en pariant sur le temps de filtrage,
     * un MutationObserver sur le corps du tableau déclenche la recherche DÈS que
     * le DOM change (re-rendu du filtrage) : sur un filtrage rapide, cela peut
     * faire gagner plusieurs centaines de millisecondes. Le polling reste un
     * filet de secours si aucune mutation n'est détectée (DataTables qui ne
     * toucherait pas le DOM observé, filtre déjà à la bonne valeur…).
     *
     * @param {string} internetNumber - Numéro internet du demandeur.
     * @param {number} maxAttempts - Budget de tentatives du filet de secours.
     * @param {(row: HTMLElement|null, attempts: number) => void} done
     *        Appelé avec la ligne trouvée, ou null si le budget est épuisé.
     */
    function filterAndWaitForRow(internetNumber, maxAttempts, done) {
        if (!applySearchFilter(internetNumber)) {
            console.warn('[CEV_AVI] Input de recherche DataTables non trouvé — recherche par contenu de ligne uniquement.');
        } else {
            console.log(`[CEV_AVI] Filtre appliqué : "${internetNumber}"`);
        }

        let attempts = 0;
        let settled = false;
        let pollTimerId = null;

        const tableBody = document.querySelector('table tbody');
        const observer = tableBody
            ? new MutationObserver(() => tryFindRow())
            : null;
        if (observer) {
            observer.observe(tableBody, { childList: true, subtree: true });
        }

        function stopWatching() {
            settled = true;
            if (observer) observer.disconnect();
            if (pollTimerId !== null) {
                clearTimeout(pollTimerId);
                pollTimerId = null;
            }
        }

        /**
         * Cherche la ligne et conclut si elle est présente. Volontairement SANS
         * effet de bord d'ordonnancement : cette fonction ne programme aucun
         * minuteur et n'incrémente pas le budget de tentatives, parce qu'elle
         * est appelée à chaque mutation du tableau. Un re-rendu DataTables émet
         * des dizaines de mutations ; si chacune replanifiait un minuteur, on
         * obtiendrait autant de chaînes de polling parallèles s'auto-répliquant,
         * et le budget serait épuisé en quelques centaines de ms au lieu des
         * ~6 s prévues (abandon prématuré + pic CPU au pire moment).
         *
         * @returns {boolean} true si la ligne a été trouvée.
         */
        function tryFindRow() {
            if (settled) return true;

            const row = findRowForInternetNumber(internetNumber);
            if (!row) return false;

            stopWatching();
            done(row, attempts);
            return true;
        }

        /**
         * Chaîne de polling UNIQUE : seule détentrice du budget de tentatives et
         * seule à programmer le minuteur suivant. Sert de filet de secours si le
         * MutationObserver ne voit rien (DataTables qui ne touche pas le DOM
         * observé, filtre déjà à la bonne valeur…).
         */
        function poll() {
            pollTimerId = null;
            if (settled) return;

            attempts++;
            if (tryFindRow()) return;

            if (attempts < maxAttempts) {
                pollTimerId = setTimeout(poll, FIND_RETRY_MS);
                return;
            }

            stopWatching();
            done(null, attempts);
        }

        // Premier essai immédiat (la ligne peut déjà être visible, notamment lors
        // d'un réessai où le filtre avait déjà été appliqué), puis la chaîne
        // s'auto-entretient toutes les FIND_RETRY_MS.
        poll();
    }

    /**
     * Met en cache l'URL du dossier pour ce numéro internet.
     *
     * C'est ce cache qui permet au service worker d'ouvrir le dossier DÈS la
     * notification suivante, sans filtrage DataTables ni même onglet
     * IndexByUserId ouvert. Il est indexé par numéro internet
     * (`applicationIdFor`) : changer de numéro dans le popup l'invalide de fait,
     * ce qui évite d'ouvrir le dossier d'un autre demandeur.
     *
     * @param {string} internetNumber
     * @param {string} editUrl
     */
    function cacheApplicationUrl(internetNumber, editUrl) {
        chrome.storage.local.set({
            applicationEditUrl: editUrl,
            applicationIdFor: internetNumber,
        });
    }

    /**
     * Ouvre la page du dossier du demandeur à partir de sa ligne.
     *
     * Chemin normal : l'URL du dossier est LUE sur le bouton d'édition (aucun
     * clic) et l'onglet est ouvert par le service worker. C'est le plus rapide
     * (pas d'aller-retour par le pont Angular, pas de digest à attendre) et le
     * plus sûr : rien ne peut échouer silencieusement, et l'onglet IndexByUserId
     * est conservé.
     *
     * Dernier recours : si l'URL n'a pas pu être lue, le bouton d'édition est
     * réellement cliqué, ce qui navigue CET onglet vers le dossier.
     *
     * @param {string} internetNumber - Numéro internet du demandeur.
     * @param {HTMLElement} row - Ligne du demandeur.
     */
    function openApplicationFromRow(internetNumber, row) {
        // Capture le nom du demandeur pour l'afficher en tête de la page captcha.
        const applicantName = getApplicantNameFromRow(row);
        if (applicantName) {
            chrome.storage.local.set({ applicantName });
            console.log(`[CEV_AVI] Nom du demandeur capturé : ${applicantName}`);
        }

        lastBookingClickTime = Date.now(); // arme l'anti-rebond

        const editUrl = extractEditUrlFromRow(row);
        if (editUrl) {
            console.log(`[CEV_AVI] Dossier de ${internetNumber} résolu : ${editUrl}`);
            cacheApplicationUrl(internetNumber, editUrl);
            requestOpenEditTab(editUrl, () => {
                // Réaffiche tous les demandeurs dans l'onglet conservé, puis clôt
                // le cycle : editPage.js prend le relais dans le nouvel onglet.
                clearSearchInput();
                finishBookingCycle();
            });
            return;
        }

        // L'URL n'a pas pu être lue (DOM inattendu) : on clique réellement le
        // bouton d'édition. CET onglet navigue alors vers le dossier — on perd
        // l'onglet IndexByUserId, ce qui reste préférable à perdre le RDV.
        const editControl = findEditControlForRow(row);
        if (!editControl) {
            console.error(`[CEV_AVI] Ni URL ni bouton d'édition dans la ligne ${internetNumber}.`);
            console.error('[CEV_AVI] Vérifiez extractEditUrlFromRow() / findEditControlForRow() dans applicationsPage.js.');
            retryBookingOrGiveUp('bouton d\'édition introuvable');
            return;
        }

        console.warn('[CEV_AVI] URL du dossier illisible — repli sur un clic réel du bouton d\'édition.');
        // Le marqueur est posé AVANT le clic : la navigation peut être immédiate
        // et editPage.js doit trouver le marqueur déjà persisté à son démarrage.
        chrome.storage.local.set({ manageRdvRequestedAt: Date.now() }, () => {
            robustClick(editControl);
            // Le verrou et le flag `pendingBooking` sont MAINTENUS jusqu'à la
            // navigation : sans cela, un échec silencieux du clic laisserait
            // l'onglet bloqué sur le filtre sans que rien ne le détecte.
            armBookingWatchdog();
        });
    }

    /**
     * Filtre le tableau sur l'internet number puis ouvre la page de son dossier.
     */
    function startSearchAndOpenApplication(internetNumber) {
        // Le verrou, le numéro actif et le compteur de cycle sont posés par
        // startBookingCycle, seul point d'entrée de cette fonction.
        filterAndWaitForRow(internetNumber, MAX_FIND_ATTEMPTS, (row, attempts) => {
            if (!row) {
                console.error(`[CEV_AVI] Ligne du demandeur ${internetNumber} introuvable après ${attempts} tentatives.`);
                retryBookingOrGiveUp('ligne du demandeur introuvable');
                return;
            }
            console.log(`[CEV_AVI] Ligne de ${internetNumber} trouvée (tentative ${attempts}).`);
            openApplicationFromRow(internetNumber, row);
        });
    }

    /**
     * Réinitialise l'input de recherche DataTables (le vide) afin de
     * réafficher TOUS les demandeurs du tableau au lieu de la seule ligne
     * filtrée. Appelé une fois que l'onglet du dossier a été demandé.
     */
    function clearSearchInput() {
        if (!applySearchFilter('')) return;
        console.log('[CEV_AVI] Filtre de recherche vidé — tous les demandeurs réaffichés.');
    }

    /**
     * Écoute les messages du pont Angular (pageBridge.js, monde page).
     *
     * Sur cette page, le pont n'est sollicité que par le chemin de DERNIER
     * RECOURS (clic réel sur le bouton d'édition) : le seul message attendu est
     * donc un signal d'échec. La capture d'URL de captcha, elle, a lieu sur la
     * page du dossier et est traitée par editPage.js.
     */
    window.addEventListener('message', (event) => {
        if (event.source !== window) return;

        const data = event.data;
        if (!data || data.cevAvi !== true) return;

        // Le pont signale que le clic n'a pas abouti (élément cible disparu du
        // DOM à cause d'un re-rendu DataTables, exception Angular) : on relance
        // un cycle complet sans attendre l'expiration du garde-fou.
        if (data.action === 'angularClickFailed') {
            retryBookingOrGiveUp(data.reason || 'échec signalé par le pont Angular');
        }
    });

    /**
     * Demande au background d'ouvrir la page du dossier dans un NOUVEL onglet,
     * avec retries et filet de sécurité.
     *
     * Le background répond {ok:true, opened:true} quand l'onglet est RÉELLEMENT
     * créé (résultat de chrome.tabs.create vérifié) ET que le marqueur
     * `manageRdvRequestedAt` est posé — sans ce marqueur, editPage.js resterait
     * inerte sur la page du dossier. En cas d'échec de livraison ou de création,
     * on réessaie ; en DERNIER RECOURS, on navigue l'onglet courant vers le
     * dossier : perdre l'onglet IndexByUserId vaut mieux que perdre le RDV.
     *
     * @param {string} url - URL de la page du dossier.
     * @param {() => void} onOpened - Appelé quand l'onglet est confirmé ouvert.
     * @param {number} attempt - Numéro de tentative courante.
     */
    function requestOpenEditTab(url, onOpened, attempt = 1) {
        const MAX_ATTEMPTS = 6;

        function lastResortNavigate(reason) {
            console.error(`[CEV_AVI] Background injoignable (${reason}) — DERNIER RECOURS : navigation de cet onglet vers le dossier.`);
            // Le marqueur, normalement posé par le background, doit l'être ici :
            // c'est lui qui autorise editPage.js à cliquer « Gérer votre rendez-vous ».
            chrome.storage.local.set({ manageRdvRequestedAt: Date.now() }, () => {
                window.location.href = url;
            });
        }

        try {
            chrome.runtime.sendMessage({ action: 'openEditTab', url }, (response) => {
                if (!chrome.runtime.lastError && response && response.ok === true) {
                    console.log(`[CEV_AVI] Dossier : ${response.opened ? `onglet ouvert (tabId ${response.tabId})` : 'déjà ouvert (dédup)'}.`);
                    onOpened();
                    return;
                }

                const errMsg = chrome.runtime.lastError
                    ? chrome.runtime.lastError.message
                    : `réponse invalide : ${JSON.stringify(response)}`;

                if (attempt < MAX_ATTEMPTS) {
                    console.warn(`[CEV_AVI] openEditTab échoué (tentative ${attempt}/${MAX_ATTEMPTS}) : ${errMsg} — nouvel essai...`);
                    setTimeout(() => requestOpenEditTab(url, onOpened, attempt + 1), 400);
                } else {
                    lastResortNavigate(errMsg);
                }
            });
        } catch (e) {
            // "Extension context invalidated" : extension rechargée sans recharger
            // l'onglet → le background actuel est inaccessible depuis ce script.
            lastResortNavigate(e.message);
        }
    }

    // ======================== PRÉ-RÉSOLUTION DU DOSSIER ========================

    /**
     * Résout l'URL du dossier du profil dès le chargement de la page, puis la met
     * en cache — SANS attendre qu'un créneau soit trouvé.
     *
     * C'est l'optimisation clé du nouveau parcours : au moment critique, le
     * service worker n'a plus qu'à ouvrir un onglet sur une URL déjà connue. Tout
     * le travail coûteux et incertain (attente de DataTables, filtrage, re-rendu
     * Angular, lecture du DOM) est fait ICI, à froid, plusieurs minutes avant.
     *
     * Le filtre est remis à vide juste après : l'utilisateur retrouve son tableau
     * complet, comme s'il ne s'était rien passé.
     *
     * Ne fait rien si le cache est déjà valide pour ce numéro internet, ni si une
     * réservation est en cours (le cycle de booking a la priorité sur le tableau).
     */
    function prefetchApplicationUrl() {
        chrome.storage.local.get(
            ['internetNumber', 'applicationEditUrl', 'applicationIdFor', 'pendingBooking'],
            (data) => {
                const internetNumber = (data.internetNumber || '').trim();
                if (!internetNumber) return; // fenêtre principale, sans dossier attitré
                if (data.pendingBooking) return;
                if (data.applicationEditUrl && data.applicationIdFor === internetNumber) {
                    console.log(`[CEV_AVI] Dossier déjà en cache pour ${internetNumber} : ${data.applicationEditUrl}`);
                    return;
                }

                waitForTable(() => {
                    if (bookingInProgress) return; // une réservation a démarré entre-temps


                    filterAndWaitForRow(internetNumber, MAX_FIND_ATTEMPTS, (row) => {
                        if (bookingInProgress) return;

                        if (!row) {
                            console.warn(`[CEV_AVI] Pré-résolution : ligne ${internetNumber} introuvable — le dossier sera résolu au moment du RDV.`);
                            clearSearchInput();
                            return;
                        }

                        const editUrl = extractEditUrlFromRow(row);
                        const applicantName = getApplicantNameFromRow(row);

                        if (editUrl) {
                            cacheApplicationUrl(internetNumber, editUrl);
                            console.log(`[CEV_AVI] Dossier pré-résolu pour ${internetNumber} : ${editUrl}`);
                        } else {
                            console.warn('[CEV_AVI] Pré-résolution : URL du dossier illisible dans la ligne.');
                        }
                        if (applicantName) {
                            chrome.storage.local.set({ applicantName });
                        }

                        clearSearchInput();
                    });
                }, 20000, () => {
                    console.warn('[CEV_AVI] Pré-résolution abandonnée : tableau DataTables indisponible.');
                });
            }
        );
    }

    /**
     * Vérifie si le flag `pendingBooking` est positionné et, si oui,
     * déclenche la séquence de réservation pour l'internet number de ce profil.
     */
    function checkPendingBooking() {
        chrome.storage.local.get(['pendingBooking', 'internetNumber'], (data) => {
            if (data.pendingBooking && data.internetNumber) {
                console.log('[CEV_AVI] Flag pendingBooking détecté — lancement de la réservation.');
                triggerBookingForProfile(data.internetNumber);
            }
        });
    }

    // ======================== DÉCLENCHEURS ========================

    /**
     * Lit l'internet number du profil puis lance la séquence de booking.
     * Utilisé par les trois canaux de déclenchement (storage.onChanged,
     * message startBooking, et checkPendingBooking au chargement).
     */
    function launchBooking() {
        chrome.storage.local.get('internetNumber', (data) => {
            if (data.internetNumber) {
                triggerBookingForProfile(data.internetNumber);
            } else {
                console.warn('[CEV_AVI] Internet number non configuré — impossible de déclencher la réservation.');
                // Sur la fenêtre principale (sans numéro internet), ce chemin
                // n'atteint jamais finishBookingCycle : sans cette ligne,
                // `pendingBooking` posé par le service worker resterait à
                // `true` indéfiniment (état mort, sans effet observable
                // aujourd'hui, mais qui traînerait dans le storage).
                chrome.storage.local.set({ pendingBooking: false });
            }
        });
    }

    // Canal 1 (PRINCIPAL) : changement du déclencheur dans le storage.
    // Fiable même si le service worker ne peut pas joindre le content script :
    // chrome.storage.onChanged est reçu par TOUS les contextes de l'extension.
    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local') return;

        if (changes.bookingTrigger && changes.bookingTrigger.newValue) {
            console.log('[CEV_AVI] bookingTrigger détecté via storage.onChanged — lancement du booking.');
            launchBooking();
        }
    });

    // Canal 2 : message direct du background (best-effort).
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'startBooking') {
            // Répond immédiatement pour que background.js sache que le content
            // script est présent et NE recharge PAS l'onglet.
            sendResponse({ ok: true });
            launchBooking();
        }
    });

    // ======================== POINT D'ENTRÉE ========================

    console.log('[CEV_AVI] applicationsPage.js chargé sur IndexByUserId.');

    watchBookerEmailFromMenu();

    // Vérifie le flag pendingBooking au chargement de la page
    checkPendingBooking();

    // Résout et met en cache l'URL du dossier À FROID, pour que la prochaine
    // réservation n'ait plus rien à chercher dans le tableau. Une réservation
    // déjà en attente est prioritaire : la pré-résolution relit `pendingBooking`
    // puis surveille `bookingInProgress` à chaque étape, et s'efface devant elle.
    prefetchApplicationUrl();

})();
