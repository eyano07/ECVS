/**
 * ==========================================================================
 * SCRIPT PAGE DU DOSSIER (Content Script) — Extension Chrome CEV_AVI
 * ==========================================================================
 *
 * Ce script est injecté sur la page de détail d'une demande :
 *   https://visaonweb.diplomatie.be/<langue>/VisaApplication/Edit/<applicationId>
 *
 * POURQUOI CETTE PAGE (mise à jour du portail) :
 * La colonne « Action » du tableau IndexByUserId n'expose plus de bouton
 * calendrier. Le seul chemin vers le captcha passe désormais par la page du
 * dossier : bouton « Gérer votre rendez-vous » en bas de page → page captcha.
 *
 * CETTE PAGE EST LE POSTE D'ATTENTE DES FENÊTRES FILLES.
 * L'opérateur ouvre manuellement le dossier de son demandeur et LAISSE l'onglet
 * ouvert. À la notification, il n'y a plus rien à ouvrir ni à chercher : le
 * bouton est déjà là, sous la souris. C'est le chemin le plus court possible
 * entre le créneau détecté par la fenêtre principale et le captcha.
 *
 * Conséquence sur la durée de vie du script : il n'est plus exécuté une fois au
 * chargement puis oublié. Il reste actif des heures et doit réagir à des
 * notifications successives — d'où les deux canaux de déclenchement en bas de
 * fichier et la réinitialisation complète de l'état à chaque cycle
 * (voir runManageRdvCycle).
 *
 * Son rôle, à chaque notification :
 *   1. Vérifie qu'une prise de RDV est bien en attente (`manageRdvRequestedAt`,
 *      posé par le service worker). Sans ce marqueur — ou s'il est périmé — le
 *      script ne fait RIEN : consulter un dossier manuellement, ou simplement
 *      stationner dessus, ne doit jamais déclencher de prise de RDV.
 *   2. Contrôle que le dossier affiché est bien celui du profil (comparaison du
 *      numéro internet lu sur la page avec celui configuré). Une prise de RDV
 *      sur le dossier d'un autre demandeur serait irréversible.
 *   3. Repère le bouton « Gérer votre rendez-vous » et le clique via le pont
 *      Angular (pageBridge.js), en mode INTERCEPTION FORCÉE de window.open.
 *   4. Amène CET onglet sur la page captcha :
 *        - si le portail appelle window.open, le pont capture l'URL et on
 *          navigue nous-mêmes (une popup par script serait bloquée) ;
 *        - s'il redirige l'onglet courant, il n'y a rien à faire.
 *      L'onglet quitte donc son poste — il faudra rouvrir la page du dossier
 *      pour réarmer la fenêtre après le RDV.
 *   5. En cas d'échec, relance la séquence depuis le tableau (`bookingTrigger`)
 *      après avoir invalidé l'identifiant de dossier mis en cache.
 *
 * Ce script affiche aussi le badge de compte à rebours du by-pass captcha
 * (15 min), qui vivait auparavant sur IndexByUserId : il a suivi le poste
 * d'attente, seule page réellement sous les yeux de l'opérateur.
 *
 * Sélecteurs utilisés (à ajuster si le site change) :
 *   - Bouton de prise de RDV : localisé par findManageRdvButton() — ng-click
 *     reconnaissable, puis libellé visible (FR/EN/NL, insensible aux accents).
 *   - Numéro internet : premier champ dont la valeur ressemble à VOWINT<chiffres>.
 * ==========================================================================
 */
(() => {

    // ======================== CONSTANTES ========================

    /**
     * Durée de validité (ms) du marqueur `manageRdvRequestedAt`. Passé ce délai,
     * la page Edit est considérée comme une consultation manuelle et le script
     * reste inerte. Borne le risque qu'un marqueur oublié déclenche une prise de
     * RDV involontaire bien plus tard.
     */
    const REQUEST_FLAG_TTL_MS = 3 * 60 * 1000;

    /** Nombre maximum de tentatives de localisation du bouton (filet de secours). */
    const MAX_FIND_ATTEMPTS = 40;

    /** Intervalle (ms) entre deux tentatives de localisation du bouton. */
    const FIND_RETRY_MS = 150;

    /**
     * Délai (ms) accordé au clic pour aboutir (URL de captcha capturée, ou
     * navigation de l'onglet). Doit rester SUPÉRIEUR au filet de sécurité de
     * pageBridge.js (OPEN_INTERCEPT_WINDOW_MS) pour laisser le pont signaler
     * l'échec lui-même, avec sa cause précise.
     */
    const CLICK_CONFIRM_TIMEOUT_MS = 12000;

    /** Nombre maximum de clics tentés sur cette page pour une même prise de RDV. */
    const MAX_CLICK_ATTEMPTS = 3;

    /** Pause (ms) avant de retenter un clic après un échec. */
    const CLICK_RETRY_BACKOFF_MS = 500;

    /**
     * Libellés du bouton de prise de rendez-vous, dans les trois langues du
     * portail. Comparés après normalisation (minuscules, accents et ponctuation
     * retirés), ce qui rend inutile de lister chaque variante d'écriture.
     */
    const MANAGE_RDV_LABELS = [
        'gerer votre rendez vous',   // fr-BE
        'gerer mon rendez vous',
        'gerer le rendez vous',
        'manage your appointment',   // en
        'manage appointment',
        'beheer uw afspraak',        // nl-BE
        'afspraak beheren',
    ];

    /**
     * Expressions ng-click reconnues comme « prise de rendez-vous ». `groupVA*`
     * est le nom historique (page IndexByUserId) ; les autres couvrent les
     * renommages plausibles côté portail.
     */
    const MANAGE_RDV_NG_CLICK = /groupva|managerdv|manage_rdv|manageappointment|gererrdv|rendezvous/i;

    /**
     * Termes qui INTERDISENT de cliquer un élément, quel que soit le critère qui
     * l'a désigné. Recherchés à la fois dans le libellé visible ET dans
     * l'expression ng-click.
     *
     * Ce n'est pas une simple préférence de sélection mais un VETO final : la
     * barre d'actions contient « Imprimer demande » et « Nouvelle demande dans
     * groupe » juste à côté du bouton visé, et cliquer le second créerait une
     * demande de visa. Aucune heuristique de sélection ne doit pouvoir passer
     * outre — d'où un contrôle séparé, appliqué juste avant le clic.
     */
    const FORBIDDEN_TERMS = [
        'imprimer',          // « Imprimer demande »
        'print',
        'afdrukken',
        'nouvelle demande',  // « Nouvelle demande dans groupe »
        'new application',
        'nieuwe aanvraag',
        'supprimer',
        'delete',
        'annuler',
        'cancel',
    ];

    /**
     * Formes d'attribut sous lesquelles AngularJS 1.x accepte une directive
     * ng-click. Le portail peut utiliser n'importe laquelle ; ne lire que
     * `ng-click` reviendrait à ignorer silencieusement les trois autres.
     */
    const NG_CLICK_ATTRS = ['ng-click', 'data-ng-click', 'x-ng-click', 'ng:click'];

    // ======================== OUTILS ========================

    /**
     * Normalise un libellé pour la comparaison : minuscules, accents retirés,
     * ponctuation et espaces multiples réduits à un espace simple.
     * « Gérer votre rendez-vous » → « gerer votre rendez vous ».
     *
     * @param {string} text
     * @returns {string}
     */
    function normalizeLabel(text) {
        return (text || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, ' ')
            .trim();
    }

    /**
     * Lit l'expression ng-click d'un élément, quelle que soit la forme
     * d'attribut employée par le portail.
     *
     * @param {HTMLElement} el
     * @returns {string} Expression trouvée, ou chaîne vide.
     */
    function getNgClickExpr(el) {
        for (const attr of NG_CLICK_ATTRS) {
            const value = el.getAttribute(attr);
            if (value) return value;
        }
        return '';
    }

    /**
     * Libellé normalisé d'un élément. `value` couvre les <input type="button">,
     * dont le libellé n'est pas dans textContent.
     *
     * @param {HTMLElement} el
     * @returns {string}
     */
    function labelOf(el) {
        return normalizeLabel(el.textContent || el.value || '');
    }

    /**
     * L'élément porte-t-il le libellé attendu pour la prise de rendez-vous ?
     *
     * @param {HTMLElement} el
     * @returns {boolean}
     */
    function hasManageRdvLabel(el) {
        const label = labelOf(el);
        return Boolean(label) && MANAGE_RDV_LABELS.some((wanted) => label.includes(wanted));
    }

    /**
     * VETO : l'élément désigne-t-il une action à ne jamais déclencher ?
     *
     * Contrôlé séparément de la sélection et appliqué juste avant le clic : peu
     * importe quel critère a désigné l'élément, s'il ressemble de près ou de loin
     * à « Imprimer demande » ou « Nouvelle demande dans groupe », on n'appuie pas.
     *
     * L'ÉTENDUE du contrôle dépend de ce que l'on sait de l'élément :
     *  - libellé de prise de RDV reconnu → seul le libellé est inspecté. La page
     *    atteinte par ce bouton permet aussi d'ANNULER un rendez-vous, son
     *    expression ng-click peut donc légitimement contenir « cancel » ; y
     *    appliquer le veto bloquerait le bon bouton. Un conteneur englobant toute
     *    la barre reste écarté, puisque son libellé contient « Imprimer ».
     *  - libellé inconnu ou absent → l'expression ng-click est inspectée en plus,
     *    car un `printVA(...)` trahit l'action quand le libellé est illisible
     *    (traduction Angular pas encore appliquée, icône seule…).
     *
     * @param {HTMLElement} el
     * @returns {string} Terme interdit rencontré, ou chaîne vide si l'élément est sûr.
     */
    function forbiddenTermIn(el) {
        const label = labelOf(el);
        const haystack = hasManageRdvLabel(el)
            ? label
            : `${label} ${normalizeLabel(getNgClickExpr(el))}`;
        return FORBIDDEN_TERMS.find((term) => haystack.includes(term)) || '';
    }

    /**
     * Décrit un élément pour les logs de diagnostic : c'est ce qui permet, en cas
     * de mauvaise cible, d'identifier le DOM réel sans avoir à instrumenter la page.
     *
     * @param {HTMLElement} el
     * @returns {string}
     */
    function describeElement(el) {
        const text = (el.textContent || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 60);
        return `<${el.tagName.toLowerCase()} class="${el.className}" ng-click="${getNgClickExpr(el)}"> « ${text} »`;
    }

    /**
     * Indique si un élément est visible et actionnable. Le portail rend le bouton
     * de prise de RDV désactivé tant que le dossier n'est pas au bon statut : le
     * cliquer dans cet état ne produirait rien et consommerait une tentative.
     *
     * @param {HTMLElement} el
     * @returns {boolean}
     */
    function isActionable(el) {
        if (!el || el.disabled) return false;
        if (el.getAttribute('aria-disabled') === 'true') return false;
        if (el.classList.contains('disabled')) return false;
        // offsetParent vaut null pour un élément masqué (display:none ou parent masqué).
        return el.offsetParent !== null || el.getClientRects().length > 0;
    }

    /**
     * Localise le bouton « Gérer votre rendez-vous » de la barre d'actions.
     *
     * DEUX PASSES COMPLÈTES, et non un seul balayage : la première épuise tous
     * les candidats sur le critère du libellé avant que la seconde n'envisage le
     * critère ng-click. En un seul balayage, un bouton voisin au ng-click
     * trompeur rencontré TÔT dans le DOM pouvait l'emporter sur le bon bouton
     * situé plus loin — les boutons de cette barre sont flottés à droite, donc
     * leur ordre dans le DOM est l'inverse de l'ordre visible.
     *
     *   Passe 1 — libellé visible, normalisé (accents/ponctuation retirés) et
     *             comparé aux variantes FR/EN/NL. Exact, donc prioritaire.
     *   Passe 2 — ng-click reconnaissable (groupVA, manageRdv…), pour survivre à
     *             un renommage du libellé.
     *
     * Les deux passes écartent tout élément frappé de veto. Volontairement PAS de
     * repli « n-ième bouton de la barre » : les voisins sont « Imprimer demande »
     * et « Nouvelle demande dans groupe », et l'un crée une demande de visa.
     *
     * @returns {HTMLElement|null}
     */
    function findManageRdvButton() {
        const candidates = [...document.querySelectorAll(
            'button, a, input[type="button"], input[type="submit"]'
        )].filter((el) => isActionable(el) && !forbiddenTermIn(el));

        // Parmi les correspondances de libellé, on retient la PLUS COURTE, c'est-
        // à-dire la plus proche du libellé exact. Un conteneur cliquable qui
        // engloberait toute la barre d'actions aurait pour texte
        // « Gérer votre rendez-vous Imprimer demande » : il « contient » bien le
        // libellé cherché, mais le cliquer déclencherait l'action d'un de ses
        // enfants. Le bouton lui-même a toujours le libellé le plus court.
        const labelMatches = candidates.filter(hasManageRdvLabel);
        if (labelMatches.length > 0) {
            return labelMatches.reduce((best, el) => (
                labelOf(el).length < labelOf(best).length ? el : best
            ));
        }

        return candidates.find((el) => {
            const ngExpr = getNgClickExpr(el);
            return ngExpr && MANAGE_RDV_NG_CLICK.test(ngExpr);
        }) || null;
    }

    /**
     * Journalise tous les boutons visibles de la page.
     *
     * Appelé quand la sélection échoue ou aboutit à une cible refusée : sans ce
     * relevé, diagnostiquer une évolution du portail imposerait d'instrumenter la
     * page à la main pendant le créneau d'un RDV — c'est-à-dire au pire moment.
     */
    function logActionBarContents() {
        const all = [...document.querySelectorAll(
            'button, a, input[type="button"], input[type="submit"]'
        )].filter(isActionable);

        console.warn(`[CEV_AVI] Boutons visibles sur la page du dossier (${all.length}) :`);
        all.forEach((el) => console.warn(`[CEV_AVI]   ${describeElement(el)}`));
    }

    /**
     * Lit le numéro internet affiché sur la page (champ « Numéro internet »).
     * Sert à vérifier que le dossier ouvert est bien celui du profil.
     *
     * @returns {string} Numéro trouvé (majuscules), ou chaîne vide.
     */
    function readInternetNumberFromPage() {
        const pattern = /VOWINT\d+/i;

        for (const input of document.querySelectorAll('input')) {
            const match = (input.value || '').match(pattern);
            if (match) return match[0].toUpperCase();
        }

        // Repli : le portail peut rendre ce champ en lecture seule hors <input>.
        const bodyMatch = (document.body.textContent || '').match(pattern);
        return bodyMatch ? bodyMatch[0].toUpperCase() : '';
    }

    // ======================== ÉTAT DU CYCLE ========================

    /** Empêche deux séquences de clic simultanées sur cette page. */
    let clickInProgress = false;

    /** Numéro de la tentative de clic en cours (1 = première). */
    let clickAttempt = 0;

    /** Identifiant du minuteur de confirmation (garde-fou). */
    let confirmWatchdogId = null;

    /** Identifiant du minuteur de réessai (évite deux cycles concurrents). */
    let retryTimerId = null;

    /** Vrai une fois le captcha atteint : neutralise tout signal d'échec tardif. */
    let settled = false;

    /** Numéro internet du profil, relu au début de chaque cycle. */
    let configuredInternetNumber = '';

    /**
     * Vrai tant qu'un cycle est en cours (de la lecture du marqueur jusqu'au
     * captcha ou à l'abandon). Cette page n'est plus une simple étape de
     * passage : elle RESTE OUVERTE en attente de notification, et les deux
     * canaux de déclenchement (storage.onChanged + message) arrivent
     * quasi-simultanément pour un même événement. Sans ce verrou, un seul
     * créneau lancerait deux séquences de clic concurrentes.
     */
    let cycleInProgress = false;

    /**
     * Vrai si le cycle courant a démarré AU CHARGEMENT de la page, c'est-à-dire
     * que la page a été ouverte par l'extension elle-même avec le marqueur déjà
     * posé (parcours de repli, openEditTab).
     *
     * Change la façon de traiter un dossier qui ne correspond pas au profil :
     *  - ouvert par l'extension → l'URL visée était fausse, c'est une vraie
     *    anomalie : on invalide le cache et on repart du tableau ;
     *  - page stationnée notifiée → cet onglet n'est simplement pas concerné,
     *    on se retire sans rien casser (voir declineCycle).
     */
    let cycleStartedAtLoad = false;

    /** Désarme le garde-fou de confirmation. */
    function clearConfirmWatchdog() {
        if (confirmWatchdogId !== null) {
            clearTimeout(confirmWatchdogId);
            confirmWatchdogId = null;
        }
    }

    /** Arme le garde-fou : sans confirmation dans le délai, on retente. */
    function armConfirmWatchdog() {
        clearConfirmWatchdog();
        confirmWatchdogId = setTimeout(() => {
            confirmWatchdogId = null;
            retryClickOrGiveUp('aucune URL de captcha confirmée dans le délai imparti');
        }, CLICK_CONFIRM_TIMEOUT_MS);
    }

    /**
     * Abandonne définitivement la prise de RDV sur cette page et rebascule sur le
     * chemin complet (tableau IndexByUserId).
     *
     * L'identifiant de dossier mis en cache est invalidé : si l'échec vient de
     * lui (dossier périmé, page d'erreur), le prochain cycle le reconstruira
     * depuis le tableau. `bookingTrigger` réveille applicationsPage.js dans
     * l'onglet IndexByUserId, qui reprend la séquence depuis le début.
     *
     * @param {string} reason - Cause de l'abandon, pour les logs.
     */
    /**
     * Se retire du cycle SANS toucher à l'état partagé.
     *
     * Cas d'usage : cette page est stationnée sur le dossier d'un AUTRE
     * demandeur que celui du profil. La notification ne la concerne pas — c'est
     * un onglet frère, stationné sur le bon dossier, qui est en train de la
     * traiter. Passer ici par `fallbackToTableFlow` serait destructeur : il
     * effacerait `manageRdvRequestedAt` et le cache d'URL, et lancerait un
     * parcours par le tableau CONCURRENT du clic en cours dans l'autre onglet.
     *
     * @param {string} reason - Cause du retrait, pour les logs.
     */
    function declineCycle(reason) {
        settled = true;
        cycleInProgress = false;
        clearConfirmWatchdog();
        console.log(`[CEV_AVI] Notification ignorée par cet onglet (${reason}) — aucun effet de bord, un autre onglet la traite peut-être.`);
    }

    function fallbackToTableFlow(reason) {
        settled = true;
        cycleInProgress = false; // cette page reste ouverte : un cycle ultérieur doit pouvoir démarrer
        clearConfirmWatchdog();
        console.error(`[CEV_AVI] Prise de RDV impossible sur la page du dossier (${reason}) — retour au parcours complet via le tableau.`);

        chrome.storage.local.set({
            manageRdvRequestedAt: null,
            applicationEditUrl: null,
            applicationIdFor: null,
            pendingBooking: true,
            bookingTrigger: Date.now(),
        }, () => {
            // `bookingTrigger` ne réveille applicationsPage.js que dans un onglet
            // DÉJÀ ouvert sur IndexByUserId. Le chemin rapide n'en exige aucun :
            // on demande donc au service worker d'en amener un, sans quoi le
            // repli n'aurait aucun destinataire.
            try {
                chrome.runtime.sendMessage({ action: 'bookingFallbackToTable' }, () => {
                    if (chrome.runtime.lastError) {
                        console.warn('[CEV_AVI] Repli non transmis au service worker :', chrome.runtime.lastError.message);
                    }
                });
            } catch (e) {
                console.warn('[CEV_AVI] Repli non transmis (contexte d\'extension invalidé) :', e.message);
            }
        });
    }

    /**
     * Persiste l'état « prise de RDV en cours d'aboutissement », AVANT le clic.
     *
     * L'écriture doit précéder le clic parce que le portail peut REDIRIGER cet
     * onglet vers le captcha au lieu d'appeler window.open : dans ce cas la page
     * disparaît sans que nous soyons prévenus, et tout ce qui n'aurait pas été
     * écrit avant serait perdu. Deux clés sont concernées :
     *
     *  - `manageRdvRequestedAt` est CONSOMMÉ ici : après son unique lecture au
     *    démarrage, le script n'en dépend plus (les réessais s'appuient sur un
     *    état en mémoire). Le laisser traîner exposerait à un clic automatique
     *    lors d'une consultation manuelle de dossier dans les minutes suivantes.
     *  - `bookingCaptchaPending` est POSÉ ici pour que client.js affiche le
     *    bandeau du demandeur sur la page captcha. Le service worker s'en charge
     *    quand c'est LUI qui ouvre l'onglet captcha ; ici c'est cet onglet qui y
     *    navigue, personne d'autre ne peut le poser.
     *
     * Le poser trop tôt est sans conséquence : client.js le consomme à
     * l'affichage du premier captcha, et il n'a aucun effet ailleurs.
     *
     * @param {() => void} done - Appelé une fois l'état RÉELLEMENT persisté.
     */
    function persistBookingHandoff(done) {
        chrome.storage.local.set({
            manageRdvRequestedAt: null,
            pendingBooking: false,
            bookingCaptchaPending: Date.now(),
        }, done);
    }

    /** Clôt le cycle : le captcha est atteint, plus aucun signal ne doit agir. */
    function finishWithCaptcha() {
        settled = true;
        cycleInProgress = false;
        clearConfirmWatchdog();
        if (retryTimerId !== null) {
            clearTimeout(retryTimerId);
            retryTimerId = null;
        }
    }

    /**
     * Relance un clic après un échec, ou bascule sur le parcours complet si le
     * plafond de tentatives est atteint.
     *
     * @param {string} reason - Cause de l'échec, pour les logs.
     */
    function retryClickOrGiveUp(reason) {
        if (settled) return;
        clearConfirmWatchdog();

        if (retryTimerId !== null) {
            console.log(`[CEV_AVI] Réessai déjà programmé — signal ignoré (${reason}).`);
            return;
        }

        if (clickAttempt >= MAX_CLICK_ATTEMPTS) {
            fallbackToTableFlow(`${reason}, après ${clickAttempt} tentatives`);
            return;
        }

        console.warn(`[CEV_AVI] Clic « Gérer votre rendez-vous » non abouti (${reason}) — nouvelle tentative ${clickAttempt + 1}/${MAX_CLICK_ATTEMPTS} dans ${CLICK_RETRY_BACKOFF_MS}ms.`);
        retryTimerId = setTimeout(() => {
            retryTimerId = null;
            clickInProgress = false;
            waitForManageRdvButton(configuredInternetNumber);
        }, CLICK_RETRY_BACKOFF_MS);
    }

    // ======================== SÉQUENCE PRINCIPALE ========================

    /**
     * Clique sur le bouton de prise de RDV via le pont Angular, en demandant
     * l'INTERCEPTION FORCÉE de window.open (`intercept: true`).
     *
     * Le clic passe obligatoirement par le pont : un clic synthétique émis
     * depuis le monde isolé du content script n'est pas vu par AngularJS, et
     * seul le monde de la page peut intercepter son window.open.
     *
     * @param {HTMLElement} button
     */
    function clickManageRdvButton(button) {
        // VETO FINAL, indépendant du critère qui a désigné ce bouton. Il a déjà
        // servi : une première version cliquait « Imprimer demande ». Mieux vaut
        // ne pas prendre le RDV que déclencher une action irréversible sur le
        // dossier — le repli par le tableau reste disponible.
        const forbidden = forbiddenTermIn(button);
        if (forbidden) {
            console.error(`[CEV_AVI] Cible REFUSÉE (terme interdit « ${forbidden} ») : ${describeElement(button)}`);
            logActionBarContents();
            fallbackToTableFlow(`cible refusée par le garde-fou (« ${forbidden} »)`);
            return;
        }

        clickInProgress = true;
        clickAttempt += 1;

        console.log(`[CEV_AVI] Cible retenue : ${describeElement(button)}`);

        // L'état est persisté AVANT le clic : le portail peut rediriger cet
        // onglet immédiatement, sans nous laisser la main ensuite.
        persistBookingHandoff(() => {
            button.setAttribute('data-cev-avi-click', '1');
            // Cible explicitement l'origine de la page : le message ne doit pas
            // être lisible par un cadre d'une autre origine.
            window.postMessage(
                { cevAvi: true, action: 'angularClick', intercept: true },
                window.location.origin
            );

            console.log(`[CEV_AVI] Clic « Gérer votre rendez-vous » demandé au pont Angular (tentative ${clickAttempt}/${MAX_CLICK_ATTEMPTS}).`);
            armConfirmWatchdog();
        });
    }

    /**
     * Attend l'apparition du bouton de prise de RDV puis le clique.
     *
     * La page Edit est rendue par AngularJS : au moment où ce content script
     * s'exécute (document_end), la barre d'actions du bas n'est pas forcément
     * dans le DOM. Un MutationObserver déclenche la recherche DÈS que le DOM
     * change — plutôt que d'attendre un délai fixe, ce qui coûterait des
     * centaines de millisecondes au pire moment. Le polling reste un filet de
     * secours si aucune mutation n'est observée (bouton déjà présent, rendu
     * antérieur à l'injection).
     *
     * @param {string} configuredNumber - Numéro internet du profil, vérifié
     *        contre celui affiché juste avant de cliquer.
     */
    function waitForManageRdvButton(configuredNumber) {
        if (settled) return;

        let attempts = 0;
        let stopped = false;
        let pollTimerId = null;
        let scanScheduled = false;

        // Les mutations sont COALESCÉES sur une frame : le rendu d'AngularJS en
        // émet des centaines, et relancer un balayage complet du DOM à chacune
        // provoquerait un pic CPU au moment précis où l'on veut être rapide.
        const observer = new MutationObserver(() => {
            if (scanScheduled || stopped || settled) return;
            scanScheduled = true;
            requestAnimationFrame(() => {
                scanScheduled = false;
                tryClick();
            });
        });
        observer.observe(document.body || document.documentElement, {
            childList: true,
            subtree: true,
        });

        function stopWatching() {
            stopped = true;
            observer.disconnect();
            if (pollTimerId !== null) {
                clearTimeout(pollTimerId);
                pollTimerId = null;
            }
        }

        /**
         * Cherche le bouton et le clique s'il est présent. Volontairement SANS
         * effet de bord d'ordonnancement : appelée à chaque mutation du DOM, elle
         * ne programme aucun minuteur et ne consomme pas le budget de tentatives.
         * Sinon un rendu Angular, qui émet des dizaines de mutations, lancerait
         * autant de chaînes de polling parallèles.
         *
         * @returns {boolean} true si le bouton a été trouvé et cliqué.
         */
        function tryClick() {
            if (stopped || settled) return true;

            const button = findManageRdvButton();
            if (!button) return false;

            // Contrôle d'identité du dossier fait ICI et non au démarrage : à
            // document_end, AngularJS n'a pas encore rendu les champs du
            // formulaire et le numéro internet serait illisible, donc le contrôle
            // serait systématiquement ignoré. Au moment où la barre d'actions
            // existe, la page est rendue et la vérification a du sens.
            if (!matchesConfiguredProfile(configuredNumber)) {
                stopWatching();
                if (cycleStartedAtLoad) {
                    // La page a été ouverte par l'extension sur une URL en cache :
                    // viser le mauvais dossier est une vraie anomalie à corriger.
                    fallbackToTableFlow('le dossier ouvert ne correspond pas au profil configuré');
                } else {
                    // Onglet stationné sur le dossier d'un autre demandeur : la
                    // notification ne le concerne pas.
                    declineCycle('dossier affiché ≠ profil configuré');
                }
                return true;
            }

            stopWatching();
            clickManageRdvButton(button);
            return true;
        }

        /**
         * Chaîne de polling UNIQUE : seule détentrice du budget de tentatives et
         * seule à programmer le minuteur suivant.
         */
        function poll() {
            pollTimerId = null;
            if (stopped || settled) return;

            attempts += 1;
            if (tryClick()) return;

            if (attempts < MAX_FIND_ATTEMPTS) {
                pollTimerId = setTimeout(poll, FIND_RETRY_MS);
                return;
            }

            stopWatching();
            logActionBarContents();
            fallbackToTableFlow(`bouton « Gérer votre rendez-vous » introuvable après ${attempts} tentatives`);
        }

        // Premier essai immédiat (le bouton peut déjà être rendu), puis la chaîne
        // s'auto-entretient toutes les FIND_RETRY_MS.
        poll();
    }

    /**
     * Vérifie que le dossier affiché correspond bien au profil configuré.
     *
     * Le chemin rapide ouvre cette page depuis un identifiant de dossier mis en
     * cache : si l'utilisateur a changé de numéro internet, ou si le portail a
     * réattribué l'identifiant, on atterrirait sur le dossier de quelqu'un
     * d'autre — et une prise de RDV y serait irréversible. En cas de désaccord
     * AVÉRÉ on refuse donc de cliquer et on repasse par le tableau.
     *
     * Un numéro illisible sur la page n'est PAS traité comme un désaccord : le
     * rendu Angular peut être incomplet, et bloquer une réservation légitime
     * coûterait plus cher que ce contrôle ne rapporte.
     *
     * @param {string} configuredNumber - Numéro internet du profil.
     * @returns {boolean} true si l'on peut poursuivre.
     */
    function matchesConfiguredProfile(configuredNumber) {
        const wanted = (configuredNumber || '').trim().toUpperCase();
        if (!wanted) return true; // profil sans numéro (fenêtre principale)

        const shown = readInternetNumberFromPage();
        if (!shown) {
            console.warn('[CEV_AVI] Numéro internet illisible sur la page du dossier — contrôle ignoré.');
            return true;
        }

        if (shown !== wanted) {
            console.error(`[CEV_AVI] Dossier ouvert (${shown}) ≠ profil configuré (${wanted}).`);
            return false;
        }

        return true;
    }

    /**
     * Met en cache l'URL de CETTE page comme dossier du profil, si le numéro
     * internet affiché correspond bien à celui configuré.
     *
     * Le cache (`applicationEditUrl` / `applicationIdFor`) n'était jusqu'ici
     * alimenté que par la pré-résolution d'applicationsPage.js, qui ne tourne
     * QU'au chargement d'IndexByUserId. Or une fenêtre fille stationne désormais
     * ici en permanence et ne visite plus ce tableau : sans cette écriture, le
     * parcours de repli après un clic raté repartirait systématiquement de zéro.
     *
     * Effet de bord utile : si l'opérateur a stationné la fenêtre sur le dossier
     * d'un AUTRE demandeur, le désaccord est signalé dès le chargement de la
     * page — sans attendre l'instant critique de la notification.
     *
     * @param {number} attempt - Tentative courante (le rendu Angular est tardif).
     */
    function cacheOwnUrlIfProfileMatches(attempt = 1) {
        chrome.storage.local.get('internetNumber', (data) => {
            const configured = (data.internetNumber || '').trim();
            if (!configured) return; // fenêtre principale, ou profil non configuré

            const shown = readInternetNumberFromPage();
            if (!shown) {
                // Le champ n'est pas encore rendu : on retente, dans le même
                // budget que la recherche du bouton.
                if (attempt < MAX_FIND_ATTEMPTS) {
                    setTimeout(() => cacheOwnUrlIfProfileMatches(attempt + 1), FIND_RETRY_MS);
                } else {
                    console.log('[CEV_AVI] Numéro internet illisible sur cette page — URL du dossier non mise en cache.');
                }
                return;
            }

            if (shown !== configured.toUpperCase()) {
                console.warn(`[CEV_AVI] ATTENTION : cette page est le dossier ${shown}, mais le profil est configuré sur ${configured.toUpperCase()}. Stationnez la fenêtre sur le bon dossier, sinon la notification ne réservera rien.`);
                return;
            }

            // Fragment et paramètres retirés : le portail utilise des ancres de
            // navigation (#PersonalData, #Group…) qui suivent la section
            // consultée par l'opérateur. Les garder produirait une URL en cache
            // instable, différente de celle que buildEditUrl reconstruit depuis
            // le tableau, et fausserait l'anti-doublon d'openEditTab (comparaison
            // d'URL exacte).
            const cleanUrl = window.location.origin + window.location.pathname;

            chrome.storage.local.set({
                applicationEditUrl: cleanUrl,
                applicationIdFor: configured,
            }, () => {
                console.log(`[CEV_AVI] Dossier ${configured} en poste — URL mise en cache : ${cleanUrl}`);
            });
        });
    }

    /**
     * Lance une séquence de prise de RDV, si et seulement si elle est réellement
     * autorisée pour ce profil.
     *
     * Cette page RESTE OUVERTE en attente de notification (poste des fenêtres
     * filles) : la fonction est donc appelée PLUSIEURS fois dans la vie de la
     * page — au chargement, puis à chaque notification. Tout l'état du cycle
     * précédent est réinitialisé ici ; sans cela, `settled` posé par un abandon
     * antérieur neutraliserait silencieusement toutes les notifications
     * suivantes.
     *
     * @param {string} origine - Canal de déclenchement, pour les logs.
     * @param {boolean} [atLoad=false] - Vrai si déclenché au chargement de la page
     *   (page ouverte par l'extension avec le marqueur déjà posé).
     */
    function runManageRdvCycle(origine, atLoad = false) {
        if (cycleInProgress) {
            console.log(`[CEV_AVI] Cycle déjà en cours — déclenchement (${origine}) ignoré.`);
            return;
        }

        chrome.storage.local.get(['manageRdvRequestedAt', 'internetNumber', 'isMainWindow'], (data) => {
            const requestedAt = data.manageRdvRequestedAt || 0;

            if (!requestedAt) {
                console.log('[CEV_AVI] Page du dossier en poste — aucune prise de RDV en attente pour le moment.');
                return;
            }

            const age = Date.now() - requestedAt;
            if (age > REQUEST_FLAG_TTL_MS) {
                console.log(`[CEV_AVI] Marqueur de prise de RDV périmé (${Math.round(age / 1000)}s) — aucune action.`);
                chrome.storage.local.set({ manageRdvRequestedAt: null });
                return;
            }

            // La fenêtre principale surveille et notifie les autres : elle ne
            // réserve JAMAIS pour elle-même, même si une page de dossier est
            // ouverte dans ce profil (garde-fou symétrique de ceux de
            // background.js et applicationsPage.js).
            if (data.isMainWindow === true) {
                console.warn('[CEV_AVI] Fenêtre principale — clic « Gérer votre rendez-vous » bloqué sur cette page.');
                return;
            }

            // Réinitialisation COMPLÈTE de l'état du cycle précédent.
            cycleInProgress = true;
            cycleStartedAtLoad = atLoad;
            settled = false;
            clickInProgress = false;
            clickAttempt = 0;
            clearConfirmWatchdog();
            if (retryTimerId !== null) {
                clearTimeout(retryTimerId);
                retryTimerId = null;
            }

            configuredInternetNumber = data.internetNumber || '';

            console.log(`[CEV_AVI] Prise de RDV en attente (${origine}) — recherche du bouton « Gérer votre rendez-vous »...`);
            waitForManageRdvButton(configuredInternetNumber);
        });
    }

    // ======================== ÉCOUTE DU PONT ANGULAR ========================

    /**
     * Messages du pont Angular (pageBridge.js, monde page) :
     *  - openCaptchaTab    : l'URL du captcha a été capturée au vol dans
     *                        window.open → on navigue CET onglet vers elle
     *                        (une popup par script serait bloquée par Chrome) ;
     *  - angularClickFailed: le clic n'a rien produit → nouvelle tentative.
     */
    window.addEventListener('message', (event) => {
        if (event.source !== window) return;

        const data = event.data;
        if (!data || data.cevAvi !== true) return;

        if (data.action === 'angularClickFailed') {
            if (clickInProgress) retryClickOrGiveUp(data.reason || 'échec signalé par le pont Angular');
            return;
        }

        if (data.action !== 'openCaptchaTab' || !data.url) return;

        if (settled) {
            console.log('[CEV_AVI] URL de captcha reçue après coup — ignorée.');
            return;
        }

        console.log(`[CEV_AVI] URL du captcha capturée — navigation de cet onglet : ${data.url}`);
        // L'état a déjà été persisté avant le clic : il ne reste qu'à naviguer.
        finishWithCaptcha();
        window.location.href = data.url;
    });

    // ======================== COMPTE À REBOURS VISIBLE (BY-PASS CAPTCHA) ========================
    //
    // Le compte à rebours de 15 min du by-pass captcha (démarré côté background à
    // la fermeture MANUELLE de l'onglet captcha) est affiché EN PERMANENCE dans un
    // badge discret en bas à droite, dès son démarrage. Dans les 2 dernières
    // minutes, le badge est agrandi et mis en évidence (couleur d'alerte) pour
    // que l'échéance soit impossible à manquer. Un élément natif (alert/confirm)
    // est volontairement évité : il bloquerait le thread JS de cette page et
    // retarderait le déclenchement d'une réservation si un autre profil trouve
    // un RDV pendant que la boîte est affichée.
    //
    // Ce badge vivait auparavant sur IndexByUserId. Il a suivi le poste d'attente
    // des fenêtres filles : c'est désormais CETTE page qui reste ouverte sous les
    // yeux de l'opérateur, donc la seule où le compte à rebours est réellement vu.

    /** Seuil (ms) : le badge est agrandi/mis en évidence sous ce seuil. */
    const CAPTCHA_COUNTDOWN_URGENT_THRESHOLD_MS = 2 * 60 * 1000;

    /** Intervalle (ms) de rafraîchissement de l'affichage du compte à rebours. */
    const CAPTCHA_COUNTDOWN_CHECK_INTERVAL_MS = 1000;

    /** Référence de l'intervalle de surveillance (évite les doublons). */
    let captchaDialogInterval = null;

    /**
     * Horodatage d'expiration (captchaBypassExpiresAt) pour lequel l'utilisateur
     * a déjà fermé le badge en phase normale. Chaque nouveau compte à rebours
     * ayant un horodatage d'expiration différent, le badge réapparaîtra pour un
     * futur by-pass même après une fermeture manuelle de celui-ci. La phase
     * critique (≤ 2 min) force de toute façon sa réapparition, fermeture ou non.
     */
    let dismissedForExpiresAt = null;

    /** Formate une durée en millisecondes au format m:ss. */
    function formatCountdown(remainingMs) {
        const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${minutes}:${String(seconds).padStart(2, '0')}`;
    }

    /**
     * Crée (si absent) le badge de compte à rebours en bas à droite, avec un
     * bouton de fermeture. Non bloquant : n'interrompt jamais le script
     * (contrairement à alert()/confirm()).
     */
    function ensureCaptchaBypassDialog(expiresAt) {
        let dialog = document.getElementById('cev-avi-captcha-dialog');
        if (dialog) return dialog;

        dialog = document.createElement('div');
        dialog.id = 'cev-avi-captcha-dialog';
        Object.assign(dialog.style, {
            position: 'fixed',
            bottom: '24px',
            right: '24px',
            zIndex: '2147483647',
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            padding: '14px 18px',
            borderRadius: '14px',
            background: '#fff',
            border: '1px solid rgba(15,23,42,0.12)',
            boxShadow: '0 14px 34px rgba(15,23,42,0.2)',
            font: '600 14px/1.4 Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif',
            color: '#0f172a',
            transition: 'padding 0.25s ease, border-color 0.25s ease, box-shadow 0.25s ease',
        });

        const dot = document.createElement('span');
        dot.id = 'cev-avi-captcha-dot';
        Object.assign(dot.style, {
            flex: '0 0 auto',
            width: '10px',
            height: '10px',
            borderRadius: '999px',
            background: '#2563eb',
            boxShadow: '0 0 0 4px rgba(37,99,235,0.18)',
            transition: 'background 0.25s ease, box-shadow 0.25s ease',
        });

        const time = document.createElement('span');
        time.id = 'cev-avi-captcha-time';
        Object.assign(time.style, {
            fontVariantNumeric: 'tabular-nums',
            fontWeight: '800',
            transition: 'font-size 0.25s ease, color 0.25s ease',
        });

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.textContent = '✕';
        closeBtn.title = 'Fermer';
        Object.assign(closeBtn.style, {
            flex: '0 0 auto',
            border: 'none',
            background: 'transparent',
            color: '#94a3b8',
            fontSize: '16px',
            fontWeight: '700',
            cursor: 'pointer',
            lineHeight: '1',
            padding: '0',
            marginLeft: '4px',
        });
        closeBtn.addEventListener('click', () => {
            dismissedForExpiresAt = expiresAt;
            removeCaptchaBypassDialog();
        });

        dialog.appendChild(dot);
        dialog.appendChild(time);
        dialog.appendChild(closeBtn);
        (document.body || document.documentElement).appendChild(dialog);
        console.log('[CEV_AVI] By-pass captcha : compte à rebours affiché.');
        return dialog;
    }

    /** Retire le badge s'il est présent. */
    function removeCaptchaBypassDialog() {
        const dialog = document.getElementById('cev-avi-captcha-dialog');
        if (dialog) dialog.remove();
    }

    /** Met à jour le texte du compte à rebours et bascule le style « urgent ». */
    function renderCaptchaCountdown(dialog, remainingMs, isUrgent) {
        const dot = dialog.querySelector('#cev-avi-captcha-dot');
        const time = dialog.querySelector('#cev-avi-captcha-time');
        time.textContent = formatCountdown(remainingMs);

        if (isUrgent) {
            dialog.style.padding = '20px 26px';
            dialog.style.border = '1px solid rgba(225,29,72,0.4)';
            dialog.style.boxShadow = '0 20px 46px rgba(225,29,72,0.28)';
            dot.style.background = '#e11d48';
            dot.style.boxShadow = '0 0 0 6px rgba(225,29,72,0.2)';
            time.style.fontSize = '26px';
            time.style.color = '#e11d48';
        } else {
            dialog.style.padding = '14px 18px';
            dialog.style.border = '1px solid rgba(15,23,42,0.12)';
            dialog.style.boxShadow = '0 14px 34px rgba(15,23,42,0.2)';
            dot.style.background = '#2563eb';
            dot.style.boxShadow = '0 0 0 4px rgba(37,99,235,0.18)';
            time.style.fontSize = '15px';
            time.style.color = '#0f172a';
        }
    }

    /**
     * Vérifie le temps restant du by-pass et affiche/retire/actualise le badge :
     *  - temps restant > 0 → badge visible, affichant le compte à rebours en direct ;
     *    agrandi et mis en évidence dès qu'il reste ≤ 2 min (phase critique, non
     *    masquable par une fermeture précédente) ;
     *  - expiré / effacé (RDV confirmé) → badge retiré.
     */
    function updateCaptchaBypassDialog() {
        chrome.storage.local.get(['captchaBypassExpiresAt'], (data) => {
            const expiresAt = data.captchaBypassExpiresAt || 0;
            if (!expiresAt) {
                removeCaptchaBypassDialog();
                return;
            }

            const remaining = expiresAt - Date.now();
            if (remaining <= 0) {
                removeCaptchaBypassDialog();
                chrome.storage.local.set({ captchaBypassExpiresAt: null, captchaBypassExpired: true });
                return;
            }

            const isUrgent = remaining <= CAPTCHA_COUNTDOWN_URGENT_THRESHOLD_MS;
            if (isUrgent) {
                // La phase critique force la réapparition, même si l'utilisateur
                // avait fermé le badge plus tôt pendant la phase normale.
                dismissedForExpiresAt = null;
            } else if (dismissedForExpiresAt === expiresAt) {
                return;
            }

            const dialog = ensureCaptchaBypassDialog(expiresAt);
            renderCaptchaCountdown(dialog, remaining, isUrgent);
        });
    }

    /** Démarre (une seule fois) la surveillance périodique du by-pass captcha. */
    function startCaptchaBypassWatcher() {
        updateCaptchaBypassDialog();
        if (!captchaDialogInterval) {
            captchaDialogInterval = setInterval(updateCaptchaBypassDialog, CAPTCHA_COUNTDOWN_CHECK_INTERVAL_MS);
        }
    }

    // ======================== DÉCLENCHEURS ========================

    // Canal 1 (PRINCIPAL) : changement du marqueur dans le storage.
    // chrome.storage.onChanged est reçu par TOUS les contextes de l'extension,
    // y compris un onglet ouvert depuis des heures dont le service worker ne
    // connaît pas l'existence. C'est ce canal qui réveille le poste d'attente.
    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local') return;

        if (changes.manageRdvRequestedAt && changes.manageRdvRequestedAt.newValue) {
            runManageRdvCycle('storage.onChanged');
        }

        // Le compte à rebours du by-pass captcha a démarré/changé/été effacé
        // (background) → réévalue immédiatement l'affichage du badge.
        if (changes.captchaBypassExpiresAt || changes.captchaBypassExpired) {
            startCaptchaBypassWatcher();
        }
    });

    // Canal 2 : message direct du background (best-effort, gagne quelques ms).
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'startManageRdv') {
            // Répond immédiatement pour que background.js sache que le content
            // script est bien présent dans cet onglet.
            sendResponse({ ok: true });
            runManageRdvCycle('message du service worker');
        }
    });

    // ======================== POINT D'ENTRÉE ========================

    console.log('[CEV_AVI] editPage.js chargé sur la page du dossier — en poste, en attente de notification.');

    // Met en cache l'URL de CE dossier s'il correspond au profil configuré.
    cacheOwnUrlIfProfileMatches();

    // Reprend la surveillance du by-pass captcha (si un compte à rebours est en
    // cours), pour réafficher le badge même si la page a été (re)chargée.
    startCaptchaBypassWatcher();

    // Une prise de RDV peut déjà être autorisée au chargement : c'est le cas
    // quand cette page vient d'être ouverte par le parcours de repli (openEditTab
    // pose le marqueur avant de créer l'onglet). Le second argument le signale :
    // un dossier non conforme est alors une anomalie à corriger, et non un simple
    // onglet non concerné (voir cycleStartedAtLoad).
    runManageRdvCycle('chargement de la page', true);

})();
