/**
 * ==========================================================================
 * SERVICE WORKER (Background Script) — Extension Chrome CEV_AVI
 * ==========================================================================
 *
 * Rôle principal :
 *  - Générer et persister un UUID unique par profil Chrome (windowId).
 *  - Maintenir une connexion WebSocket vers la passerelle Kafka.
 *  - Publier sur Kafka quand un créneau est trouvé (message appointmentFound).
 *  - Recevoir les broadcasts Kafka et déclencher la réservation dans la page du
 *    dossier DÉJÀ OUVERTE par l'opérateur (poste d'attente des fenêtres filles) :
 *    on y pose le marqueur `manageRdvRequestedAt`, editPage.js clique aussitôt
 *    « Gérer votre rendez-vous ». Si aucune page de dossier n'est ouverte, la
 *    notification est ignorée — voir triggerBookingFromBroadcast.
 *  - Recharger un onglet.
 * ==========================================================================
 */

// wsUrl.js → helper buildAuthenticatedWsUrl, partagé avec le popup. Le jeton
// qu'il ajoute à l'URL est désormais le mot de passe saisi dans le popup
// (chrome.storage.local.gatewayPassword), plus le jeton interne fixe d'avant.
importScripts('wsUrl.js');

// ======================== CONSTANTES ========================

const VISAONWEB_DOMAIN         = 'visaonweb.diplomatie.be';
const INDEX_PAGE_URL_FRAG      = 'VisaApplication/IndexByUserId';

/**
 * Fragment d'URL de la page du dossier. Les fenêtres FILLES stationnent sur
 * cette page (ouverte manuellement par l'opérateur) et y attendent la
 * notification : c'est là qu'editPage.js clique « Gérer votre rendez-vous ».
 *
 * Le fragment est dupliqué depuis applicationsPage.js (EDIT_PATH_FRAGMENT) :
 * les content scripts et le service worker ne partagent aucune portée, et
 * l'URL IndexByUserId est déjà répétée de la même façon dans trois fichiers.
 */
const EDIT_PAGE_URL_FRAG       = 'VisaApplication/Edit/';

/**
 * Clé storage.session portant l'anti-rebond d'ouverture d'onglet de dossier,
 * sous la forme { url, time }. Les canaux de déclenchement se recoupent, et
 * sans cet anti-doublon un seul créneau ouvrirait plusieurs onglets de dossier,
 * donc plusieurs prises de RDV. Stocké en storage.session et non gardé en
 * variable globale : le service worker MV3 est suspendu après quelques secondes
 * d'inactivité, ce qui effacerait l'anti-doublon.
 */
const EDIT_LAST_OPEN_KEY = 'editLastOpen';

/** Fenêtre glissante (ms) du garde-fou anti-boucle des effacements de données de navigation. */
const CACHE_CLEAR_WINDOW_MS = 30 * 60 * 1000;

/**
 * Nombre maximum d'effacements dans la fenêtre ci-dessus. Chaque effacement
 * déconnecte l'utilisateur de TOUS ses sites (voir clearAllBrowsingData) et
 * relance aussitôt une requête vers le portail — qui vient justement de
 * bloquer. Si ce blocage est appliqué côté serveur (par IP), aucun effacement
 * ne peut le lever : sans ce plafond, la reprise automatique de
 * tooManyAttempts.js boucle indéfiniment à la fréquence du chargement de page,
 * en déconnectant l'utilisateur de tout à chaque tour.
 */
const MAX_CACHE_CLEARS_PER_WINDOW = 3;

/** Nom de l'alarme Chrome utilisée pour le keepalive WebSocket */
const ALARM_KEEPALIVE = 'wsKeepalive';

/**
 * Fenêtre de l'anti-rebond d'ouverture d'onglet : un même RDV peut générer
 * plusieurs demandes d'ouverture (déclenchements multi-canaux). On n'ouvre
 * qu'un seul onglet par fenêtre de CAPTCHA_TAB_DEDUP_MS millisecondes.
 */
const CAPTCHA_TAB_DEDUP_MS = 12000;

/** Intervalle de l'alarme keepalive (en minutes, min Chrome = 0.5 = 30s) */
const ALARM_INTERVAL_MINUTES = 0.5;

/**
 * Durée du by-pass captcha : compte à rebours démarré à la FERMETURE MANUELLE
 * de l'onglet captcha (l'utilisateur a résolu le captcha puis fermé l'onglet).
 * Il s'affiche en badge en bas à droite de la page IndexByUserId dès son
 * démarrage, et devient plus voyant dans les 2 dernières minutes (voir
 * applicationsPage.js).
 */
const CAPTCHA_BYPASS_DURATION_MS = 15 * 60 * 1000;

/** Clé storage.session listant les tabId des onglets captcha suivis. */
const CAPTCHA_TABS_KEY = 'captchaOpenTabIds';

/**
 * Indique si une URL est une page captcha du portail rendez-vous.
 * @param {string} url
 * @returns {boolean}
 */
function isCaptchaTabUrl(url) {
    try {
        const u = new URL(url);
        return u.hostname === 'appointment.cloud.diplomatie.be' && /captcha/i.test(u.pathname);
    } catch {
        return false;
    }
}

/**
 * Enregistre un onglet captcha dans storage.session (persistant au redémarrage
 * du service worker MV3, contrairement à une Map en mémoire).
 * @param {number} tabId
 */
function rememberCaptchaTab(tabId) {
    if (typeof tabId !== 'number') return;
    chrome.storage.session.get(CAPTCHA_TABS_KEY, (data) => {
        const ids = Array.isArray(data[CAPTCHA_TABS_KEY]) ? data[CAPTCHA_TABS_KEY] : [];
        if (!ids.includes(tabId)) {
            ids.push(tabId);
            chrome.storage.session.set({ [CAPTCHA_TABS_KEY]: ids });
            console.log(`[CEV_AVI] Onglet captcha suivi pour le compte à rebours — tabId ${tabId}.`);
        }
    });
}

/**
 * Retire un onglet captcha du suivi et indique s'il était bien suivi.
 * @param {number} tabId
 * @param {(wasTracked: boolean) => void} callback
 */
function forgetCaptchaTab(tabId, callback) {
    chrome.storage.session.get(CAPTCHA_TABS_KEY, (data) => {
        const ids = Array.isArray(data[CAPTCHA_TABS_KEY]) ? data[CAPTCHA_TABS_KEY] : [];
        const wasTracked = ids.includes(tabId);
        if (wasTracked) {
            const next = ids.filter((id) => id !== tabId);
            chrome.storage.session.set({ [CAPTCHA_TABS_KEY]: next }, () => callback(true));
        } else {
            callback(false);
        }
    });
}

/**
 * Démarre le compte à rebours de 15 min (by-pass captcha). Le délai d'expiration
 * est stocké sous forme d'horodatage absolu : les pages IndexByUserId comparent
 * cet horodatage à l'heure courante (robuste à la suspension du service worker).
 */
function startCaptchaBypassCountdown() {
    const expiresAt = Date.now() + CAPTCHA_BYPASS_DURATION_MS;
    chrome.storage.local.set({
        captchaBypassExpiresAt: expiresAt,
        captchaBypassExpired: false,
    }, () => {
        console.log(`[CEV_AVI] Compte à rebours by-pass captcha démarré — expire dans 15 min (${new Date(expiresAt).toLocaleTimeString()}).`);
    });
}

/**
 * Efface le compte à rebours du by-pass captcha (RDV confirmé) : la boîte de
 * dialogue ne doit plus apparaître.
 */
function clearCaptchaBypassCountdown() {
    chrome.storage.local.set({
        captchaBypassExpiresAt: null,
        captchaBypassExpired: false,
    }, () => {
        console.log('[CEV_AVI] RDV confirmé — compte à rebours du by-pass captcha effacé.');
    });
}

// Suit les onglets captcha détectés par navigation (filet de sécurité en plus
// du message registerCaptchaTab envoyé par client.js).
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    const url = changeInfo.url || (tab && tab.url);
    if (url && isCaptchaTabUrl(url)) {
        rememberCaptchaTab(tabId);
    }
});

// Fermeture d'un onglet captcha SUIVI → démarre le compte à rebours de 15 min.
// L'extension ne ferme plus jamais l'onglet captcha elle-même (la reprise
// automatique après erreur a été supprimée) : toute fermeture est donc
// nécessairement manuelle.
chrome.tabs.onRemoved.addListener((tabId) => {
    forgetCaptchaTab(tabId, (wasTracked) => {
        if (!wasTracked) return;

        console.log(`[CEV_AVI] Onglet captcha fermé manuellement (tabId ${tabId}) — démarrage du compte à rebours de 15 min.`);
        startCaptchaBypassCountdown();
    });
});

// ======================== GESTION DE L'UUID PAR PROFIL ========================

/**
 * Génère un UUID persistant pour ce profil Chrome lors de l'installation.
 * Stocké dans chrome.storage.local, isolé par profil.
 */
chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.local.get('windowId', (data) => {
        if (!data.windowId) {
            const newId = crypto.randomUUID();
            chrome.storage.local.set({ windowId: newId }, () => {
                console.log(`[CEV_AVI] UUID généré pour ce profil : ${newId}`);
            });
        }
    });

    // Clés d'une ancienne génération du champ mot de passe (avant le passage
    // temporaire par gatewayConfig.js, lui-même abandonné depuis) : purge sans
    // rapport avec la clé actuelle `gatewayPassword`.
    chrome.storage.local.remove(['gatewayToken', 'draftGatewayToken']);
});

// ======================== CONNEXION WEBSOCKET ========================

/** Référence à la connexion WebSocket active (null si déconnecté) */
let ws = null;

/** Indique si une tentative de reconnexion est déjà planifiée */
let reconnectScheduled = false;

/** Délai (ms) avant la prochaine tentative de reconnexion */
let reconnectDelay = 2000;

/** Statut courant de la connexion WebSocket */
let wsStatus = 'disconnected';

/**
 * Met à jour le statut et le persiste pour le popup.
 * @param {'connected'|'connecting'|'disconnected'} status
 */
function setWsStatus(status) {
    wsStatus = status;
    chrome.storage.local.set({ wsStatus: status });
}

/**
 * Envoie un message à la passerelle en protégeant l'appel : ws.send lève une
 * exception si la socket s'est fermée entre le test de readyState et l'envoi,
 * ce qui interromprait le service worker au milieu d'un flux de réservation.
 *
 * @param {string} message - Message JSON déjà sérialisé.
 * @returns {boolean} true si le message a pu être remis à la socket.
 */
function sendToGateway(message) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
        ws.send(message);
        return true;
    } catch (e) {
        console.warn('[CEV_AVI] Envoi WebSocket impossible :', e.message);
        return false;
    }
}

/**
 * Ouvre la connexion WebSocket vers la passerelle.
 * Se reconnecte automatiquement en cas de fermeture ou d'erreur.
 */
function connectWebSocket() {
    chrome.storage.local.get(['gatewayUrl', 'gatewayPassword', 'windowId', 'internetNumber', 'wsManualDisconnect'], (data) => {
        // Déconnexion manuelle demandée via le popup → on ne (re)connecte pas
        // tant que l'utilisateur n'a pas cliqué « Reconnecter ».
        if (data.wsManualDisconnect) {
            console.log('[CEV_AVI] Déconnexion manuelle active — connexion ignorée.');
            setWsStatus('disconnected');
            return;
        }

        if (!data.gatewayUrl) {
            console.warn('[CEV_AVI] Pas d\'URL passerelle configurée — WebSocket non ouvert.');
            setWsStatus('disconnected');
            return;
        }

        // Le mot de passe (saisi dans le popup) sert de jeton d'authentification
        // WebSocket (voir GATEWAY_AUTH_TOKEN côté serveur) : sans lui, la passerelle
        // rejette l'upgrade avec un 401 — l'extension est donc inutilisable tant
        // qu'il n'est pas renseigné ET validé (voir isValidAuthToken dans logic.js).
        if (!data.gatewayPassword) {
            console.warn('[CEV_AVI] Pas de mot de passe passerelle configuré — WebSocket non ouvert.');
            setWsStatus('disconnected');
            return;
        }

        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
            return; // déjà connecté ou en cours de connexion
        }

        console.log(`[CEV_AVI] Connexion WebSocket → ${data.gatewayUrl}`);
        setWsStatus('connecting');

        ws = new WebSocket(buildAuthenticatedWsUrl(data.gatewayUrl, data.gatewayPassword));

        ws.onopen = () => {
            console.log('[CEV_AVI] WebSocket connecté.');
            setWsStatus('connected');
            reconnectDelay = 2000; // réinitialise le délai de reconnexion
            reconnectScheduled = false;

            // S'abonne au registre : publie l'internet number de ce profil dans le topic.
            // Rejoué à chaque (re)connexion → un changement d'internet number dans le
            // popup (qui force une reconnexion) remplace l'ancien dans le topic.
            sendRegistration();
        };

        ws.onmessage = (event) => {
            handleGatewayMessage(event.data, data.windowId);
        };

        ws.onclose = () => {
            console.warn('[CEV_AVI] WebSocket fermé.');
            setWsStatus('disconnected');
            ws = null;
            scheduleReconnect();
        };

        ws.onerror = (err) => {
            console.error('[CEV_AVI] Erreur WebSocket :', err);
            setWsStatus('disconnected');
        };
    });
}

/**
 * Planifie une tentative de reconnexion WebSocket avec backoff exponentiel.
 */
function scheduleReconnect() {
    if (reconnectScheduled) return;
    reconnectScheduled = true;
    const delay = Math.min(reconnectDelay, 30000);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    console.log(`[CEV_AVI] Reconnexion WebSocket dans ${delay / 1000}s...`);
    setTimeout(() => {
        reconnectScheduled = false;
        connectWebSocket();
    }, delay);
}

/**
 * eventId des événements RDV déjà pris en charge depuis le démarrage de ce
 * service worker. Sert de verrou SYNCHRONE contre les doublons (voir
 * handleGatewayMessage) — chrome.storage étant asynchrone, il ne peut pas
 * remplir ce rôle à lui seul.
 */
const handledEventIds = new Set();

/** Nombre d'eventId conservés en mémoire (borne la taille du Set). */
const MAX_HANDLED_EVENT_IDS = 50;

/** Mémorise un eventId traité, en évinçant le plus ancien au-delà de la borne. */
function rememberHandledEventId(eventId) {
    handledEventIds.add(eventId);
    while (handledEventIds.size > MAX_HANDLED_EVENT_IDS) {
        handledEventIds.delete(handledEventIds.values().next().value);
    }
}

/**
 * Gère un message reçu depuis la passerelle (broadcast Kafka).
 * Ignore le message si windowId correspond au profil courant (son propre écho).
 *
 * @param {string} rawData - Message JSON brut reçu via WebSocket.
 * @param {string} myWindowId - UUID de ce profil.
 */
function handleGatewayMessage(rawData, myWindowId) {
    let payload;
    try {
        payload = JSON.parse(rawData);
    } catch {
        return;
    }

    if (payload.type === 'connected') {
        console.log(`[CEV_AVI] Passerelle confirmée (instance: ${payload.instanceId})`);
        return;
    }

    if (payload.type === 'registered') {
        console.log(`[CEV_AVI] Internet number enregistré dans le topic : ${payload.internetNumber}`);
        return;
    }

    if (payload.type !== 'appointmentFound') {
        return;
    }

    // Ignore son propre écho
    if (payload.windowId === myWindowId) {
        console.log('[CEV_AVI] Broadcast reçu — c\'est mon propre message, ignoré.');
        return;
    }

    // Déduplication par eventId : le même événement peut arriver DEUX fois
    // (broadcast initial + rejeu de la passerelle à la reconnexion).
    //
    // Le verrou est pris de façon SYNCHRONE dans handledEventIds : deux messages
    // arrivant à quelques millisecondes d'intervalle lanceraient sinon tous les
    // deux un chrome.storage.local.get avant que le premier n'ait écrit sa
    // valeur, passeraient tous les deux le test, et déclencheraient DEUX
    // réservations pour le même créneau. Le storage ne sert plus qu'à couvrir le
    // cas d'un redémarrage du service worker entre les deux réceptions.
    const eventId = payload.eventId || `${payload.windowId}:${payload.timestamp || ''}`;

    if (handledEventIds.has(eventId)) {
        console.log(`[CEV_AVI] Événement ${eventId} déjà traité — ignoré (anti-doublon broadcast/rejeu).`);
        return;
    }
    rememberHandledEventId(eventId);

    chrome.storage.local.get(['lastHandledAppointmentEventId', 'isMainWindow'], (data) => {
        if (data.lastHandledAppointmentEventId === eventId) {
            console.log(`[CEV_AVI] Événement ${eventId} déjà traité avant un redémarrage du service worker — ignoré.`);
            return;
        }

        // Garde-fou explicite : la fenêtre principale (case « Fenêtre principale »
        // du popup) ne réserve JAMAIS pour elle-même — elle ne fait que surveiller
        // et notifier les autres fenêtres (voir client.js). Le filtre d'écho ci-
        // dessus (payload.windowId === myWindowId) couvre déjà son propre message,
        // mais cette vérification protège aussi le chemin rapide d'ouverture de
        // dossier (openEditTab), qui ne repasse pas par applicationsPage.js.
        if (data.isMainWindow === true) {
            console.warn('[CEV_AVI] Fenêtre principale — réservation bloquée pour ce broadcast (cette fenêtre ne doit jamais cliquer « Gérer votre rendez-vous »).');
            return;
        }

        chrome.storage.local.set({ lastHandledAppointmentEventId: eventId });

        // Déclenchement IMMÉDIAT et simultané sur toutes les fenêtres réceptrices
        // (comportement d'origine : profils Chrome séparés = sessions distinctes,
        // l'ouverture simultanée des captchas est légitime).
        triggerBookingFromBroadcast(payload);
    });
}

/**
 * Déclenche la réservation pour ce profil, dans l'onglet de la page du dossier
 * DÉJÀ OUVERT par l'opérateur.
 *
 * Les fenêtres filles stationnent en permanence sur
 * /VisaApplication/Edit/<id> — la page qui porte le bouton « Gérer votre
 * rendez-vous ». Il n'y a donc RIEN à ouvrir ni à chercher au moment critique :
 * on pose le marqueur d'autorisation et editPage.js, déjà chargé dans cet
 * onglet, clique immédiatement. C'est le chemin le plus court possible entre la
 * notification et le captcha.
 *
 * Le marqueur est posé AVANT le message : storage.onChanged est reçu par TOUS
 * les contextes de l'extension et constitue le canal fiable ; le message direct
 * n'est qu'un doublon best-effort (même schéma que bookingTrigger pour
 * applicationsPage.js).
 *
 * Si aucune page de dossier n'est ouverte, la notification est IGNORÉE : la
 * mise en poste est manuelle, et ouvrir un onglet à la place de l'opérateur
 * risquerait de tomber sur le mauvais dossier. Seul un avertissement est
 * journalisé.
 *
 * @param {object} payload - Événement appointmentFound dédupliqué.
 */
function triggerBookingFromBroadcast(payload) {
    console.log(`[CEV_AVI] Créneau trouvé par la fenêtre ${payload.windowId} (eventId ${payload.eventId}) ! Déclenchement de la réservation...`);

    chrome.tabs.query({ url: `*://${VISAONWEB_DOMAIN}/*${EDIT_PAGE_URL_FRAG}*` }, (tabs) => {
        if (!tabs || tabs.length === 0) {
            console.warn('[CEV_AVI] Aucune page de dossier (/VisaApplication/Edit/) ouverte dans cette fenêtre — notification IGNORÉE. Ouvrez la page du dossier du demandeur et laissez-la ouverte pour que la réservation puisse se déclencher.');
            return;
        }

        chrome.storage.local.set({ manageRdvRequestedAt: Date.now() }, () => {
            console.log(`[CEV_AVI] ${tabs.length} page(s) de dossier en poste — marqueur posé, clic « Gérer votre rendez-vous » demandé.`);

            // Doublon best-effort : réveille le content script sans attendre la
            // propagation de storage.onChanged. L'absence de réponse n'est pas
            // une erreur (l'onglet peut avoir été rechargé à l'instant).
            for (const tab of tabs) {
                chrome.tabs.sendMessage(tab.id, { action: 'startManageRdv' }, () => {
                    if (chrome.runtime.lastError) {
                        console.log(`[CEV_AVI] Onglet dossier ${tab.id} injoignable par message — storage.onChanged prend le relais.`);
                    }
                });
            }
        });
    });
}

/**
 * Pose le déclencheur de réservation et amène un onglet sur IndexByUserId, qui
 * résoudra puis ouvrira le dossier du demandeur.
 */
function triggerBookingViaApplicationsTable() {
    // Déclencheur horodaté : un NOUVEAU timestamp à chaque notification garantit
    // que chrome.storage.onChanged se déclenche côté content script (même valeur
    // → pas d'événement). applicationsPage.js réagit à ce changement SANS message
    // ni rechargement, ce qui évite le bug "onglet juste réactualisé".
    chrome.storage.local.set({ pendingBooking: true, bookingTrigger: Date.now() }, () => {
        // Cherche un onglet déjà sur IndexByUserId pour ce profil
        chrome.tabs.query({ url: `*://${VISAONWEB_DOMAIN}/*${INDEX_PAGE_URL_FRAG}*` }, (tabs) => {
            if (tabs && tabs.length > 0) {
                // Un onglet est déjà sur la bonne page : le content script va réagir
                // au changement de storage tout seul. On envoie aussi un message
                // best-effort (sans recharger si pas de réponse).
                const tabId = tabs[0].id;
                chrome.tabs.sendMessage(tabId, { action: 'startBooking' }, () => {
                    if (chrome.runtime.lastError) {
                        // Pas de content script à l'écoute (souvent après rechargement de
                        // l'extension). On injecte les scripts au lieu de recharger l'onglet.
                        injectBookingScripts(tabId);
                    }
                });
            } else {
                // Aucun onglet sur la bonne page : on navigue (le content script lira
                // pendingBooking au chargement via checkPendingBooking).
                chrome.tabs.query({ url: `*://${VISAONWEB_DOMAIN}/*` }, (visaTabs) => {
                    if (visaTabs && visaTabs.length > 0) {
                        chrome.tabs.update(visaTabs[0].id, {
                            url: `https://${VISAONWEB_DOMAIN}/fr-BE/VisaApplication/IndexByUserId`,
                        });
                    } else {
                        chrome.tabs.create({
                            url: `https://${VISAONWEB_DOMAIN}/fr-BE/VisaApplication/IndexByUserId`,
                        });
                    }
                });
            }
        });
    });
}

/**
 * Dérive un identifiant alphanumérique valide (format attendu par la
 * passerelle pour "internetNumber") à partir du windowId, pour les fenêtres
 * qui n'ont volontairement pas de numéro internet configuré (fenêtre
 * "principale" : celle qui détecte les créneaux et clique manuellement le
 * calendrier de n'importe quel demandeur, sans être liée à un seul dossier).
 * Ceci reste purement technique (traçabilité côté serveur/emails) — ce n'est
 * PAS demandé à l'utilisateur.
 * @param {string} windowId - UUID généré à l'installation.
 * @returns {string}
 */
function anonymousInternetNumberFromWindowId(windowId) {
    return `ANON${windowId.replace(/-/g, '').toUpperCase()}`.slice(0, 40);
}

/**
 * Envoie un message {type: "appointmentFound"} à la passerelle.
 * Appelé quand client.js détecte un créneau disponible.
 *
 * Le numéro internet n'est PAS obligatoire ici : la fenêtre "principale" qui
 * détecte un créneau et déclenche la notification vers les autres fenêtres
 * peut ne représenter aucun demandeur précis. Un identifiant anonyme est
 * alors substitué uniquement pour satisfaire le format exigé côté passerelle.
 */
function publishAppointmentFound(respond = () => {}) {
    chrome.storage.local.get(['windowId', 'internetNumber'], (data) => {
        if (!data.windowId) {
            console.warn('[CEV_AVI] windowId manquant — publication Kafka impossible.');
            respond({ ok: false, error: 'windowId manquant' });
            return;
        }

        const internetNumber = (data.internetNumber || '').trim()
            || anonymousInternetNumberFromWindowId(data.windowId);

        const message = JSON.stringify({
            type: 'appointmentFound',
            internetNumber,
            windowId: data.windowId,
        });

        // Échec d'envoi = WebSocket fermée (service worker suspendu, passerelle
        // redémarrée…). On relance la connexion SANS attendre le backoff et on
        // signale l'échec à l'appelant, qui réessaiera : sans cet accusé de
        // réception, la notification était perdue en silence et les fenêtres
        // filles n'étaient jamais prévenues.
        if (!sendToGateway(message)) {
            console.warn('[CEV_AVI] WebSocket non connectée — appointmentFound non publié, reconnexion immédiate demandée.');
            connectWebSocket();
            respond({ ok: false, error: 'WebSocket non connectée' });
            return;
        }

        console.log(`[CEV_AVI] Message appointmentFound publié sur Kafka : ${message}`);
        respond({ ok: true });
    });
}

/**
 * Envoie une demande d'email {type: "sendEmail"} à la passerelle, qui se
 * charge de l'envoi via Gmail (Nodemailer côté serveur).
 * Appelé quand client.js détecte la page de confirmation du RDV.
 *
 * @param {object} details - Données du RDV.
 * @param {string} [details.applicantName]   - Nom du candidat.
 * @param {string} [details.appointmentDate] - Date/heure du RDV (ex: "11/05/2026 à 10:20").
 */
function publishAppointmentEmail(details = {}) {
    chrome.storage.local.get(['windowId', 'internetNumber', 'bookerEmail'], (data) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            console.warn('[CEV_AVI] WebSocket non connecté — envoi email impossible.');
            return;
        }

        // Horodatage lisible de la réservation, en français (ex: "vendredi 3 avril 2026 à 09:44:53").
        let bookedAt;
        try {
            bookedAt = new Intl.DateTimeFormat('fr-FR', {
                weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
                hour: '2-digit', minute: '2-digit', second: '2-digit',
            }).format(new Date()).replace(',', ' à');
        } catch {
            bookedAt = new Date().toLocaleString('fr-FR');
        }

        const message = JSON.stringify({
            type: 'sendEmail',
            windowId: data.windowId || '',
            internetNumber: data.internetNumber || '',
            applicantName: details.applicantName || '',
            appointmentDate: details.appointmentDate || '',
            bookedAt,
            bookedBy: data.bookerEmail || '',
        });

        if (!sendToGateway(message)) return;
        console.log(`[CEV_AVI] Demande d'email RDV envoyée à la passerelle : ${message}`);
    });
}

/**
 * Injecte les scripts nécessaires à la page IndexByUserId sans recharger l'onglet.
 * Utile après un rechargement de l'extension : les anciens content scripts ouverts
 * dans les onglets deviennent invalides et ne répondent plus à sendMessage.
 *
 * @param {number} tabId - ID de l'onglet IndexByUserId.
 */
function injectBookingScripts(tabId) {
    console.log('[CEV_AVI] Injection des scripts de booking sans rechargement...');

    chrome.scripting.executeScript({
        target: { tabId },
        files: ['pageBridge.js'],
        world: 'MAIN',
    }, () => {
        if (chrome.runtime.lastError) {
            console.warn('[CEV_AVI] Injection pageBridge.js impossible :', chrome.runtime.lastError.message);
            return;
        }

        chrome.scripting.executeScript({
            target: { tabId },
            files: ['applicationsPage.js'],
        }, () => {
            if (chrome.runtime.lastError) {
                console.warn('[CEV_AVI] Injection applicationsPage.js impossible :', chrome.runtime.lastError.message);
                return;
            }

            chrome.tabs.sendMessage(tabId, { action: 'startBooking' }, () => {
                if (chrome.runtime.lastError) {
                    console.warn('[CEV_AVI] startBooking après injection non reçu :', chrome.runtime.lastError.message);
                }
            });
        });
    });
}

/**
 * Publie l'abonnement de ce profil : {type:"register", windowId, internetNumber}.
 * La passerelle l'enregistre dans le topic applicant-registry (clé = windowId) :
 *  - même clé → un changement d'internet number REMPLACE l'ancien dans le topic ;
 *  - à la fermeture de la fenêtre, la connexion WebSocket se coupe et la
 *    passerelle SUPPRIME automatiquement l'internet number du topic (tombstone).
 */
function sendRegistration() {
    chrome.storage.local.get(['windowId', 'internetNumber'], (data) => {
        if (!data.windowId || !data.internetNumber) {
            console.log('[CEV_AVI] Internet number non configuré — abonnement différé.');
            return;
        }

        const sent = sendToGateway(JSON.stringify({
            type: 'register',
            windowId: data.windowId,
            internetNumber: data.internetNumber,
        }));
        if (!sent) return;
        console.log(`[CEV_AVI] Abonnement envoyé : ${data.internetNumber}`);
    });
}

// ======================== KEEPALIVE VIA CHROME.ALARMS ========================

/**
 * Crée l'alarme de keepalive si elle n'existe pas.
 * Les alarmes survivent à la suspension du service worker.
 */
function ensureKeepaliveAlarm() {
    chrome.alarms.get(ALARM_KEEPALIVE, (alarm) => {
        if (!alarm) {
            chrome.alarms.create(ALARM_KEEPALIVE, {
                delayInMinutes: ALARM_INTERVAL_MINUTES,
                periodInMinutes: ALARM_INTERVAL_MINUTES,
            });
            console.log('[CEV_AVI] Alarme keepalive créée.');
        }
    });
}

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== ALARM_KEEPALIVE) return;

    // Ping WebSocket ou reconnexion si la socket est fermée / l'envoi échoue
    if (!sendToGateway(JSON.stringify({ type: 'ping' }))) {
        connectWebSocket();
    }
});

// Initialise la connexion et l'alarme au démarrage du service worker
ensureKeepaliveAlarm();
connectWebSocket();

// ======================== OUVERTURE DE L'ONGLET DOSSIER ========================

/**
 * Ouvre la page du dossier (/VisaApplication/Edit/<id>) dans un NOUVEL onglet et
 * arme editPage.js, qui y cliquera « Gérer votre rendez-vous » pour atteindre le
 * captcha. L'onglet IndexByUserId éventuellement ouvert est CONSERVÉ.
 *
 * Le marqueur `manageRdvRequestedAt` est écrit AVANT la création de l'onglet, et
 * l'imbrication des callbacks garantit cet ordre : editPage.js s'exécute au
 * chargement de la page et reste volontairement inerte s'il ne trouve pas ce
 * marqueur (une consultation manuelle d'un dossier ne doit jamais déclencher de
 * prise de RDV). Le poser après coup ouvrirait une fenêtre où le clic serait
 * perdu.
 *
 * Anti-rebond PAR URL, comme pour l'onglet captcha : une demande STRICTEMENT
 * identique dans la fenêtre CAPTCHA_TAB_DEDUP_MS est ignorée — utile pour les
 * retries de livraison du content script. L'état vit dans storage.session pour
 * rester valable après une suspension du service worker.
 *
 * @param {string} url - URL de la page du dossier.
 * @param {(result: object) => void} respond
 */
function openEditTab(url, respond) {
    chrome.storage.session.get(EDIT_LAST_OPEN_KEY, (data) => {
        const last = data[EDIT_LAST_OPEN_KEY] || {};
        const now = Date.now();

        if (url === last.url && (now - (last.time || 0)) < CAPTCHA_TAB_DEDUP_MS) {
            console.log('[CEV_AVI] Onglet dossier identique déjà ouvert récemment — demande ignorée.');
            respond({ ok: true, opened: false, reason: 'duplicate' });
            return;
        }

        chrome.storage.session.set({ [EDIT_LAST_OPEN_KEY]: { url, time: now } }, () => {
            chrome.storage.local.set({ manageRdvRequestedAt: now }, () => {
                chrome.tabs.create({ url, active: true }, (tab) => {
                    if (chrome.runtime.lastError || !tab) {
                        const errMsg = chrome.runtime.lastError ? chrome.runtime.lastError.message : 'tab indéfini';
                        console.error(`[CEV_AVI] ÉCHEC création onglet dossier : ${errMsg}`);
                        // Libère la dédup pour permettre un retry immédiat.
                        chrome.storage.session.remove(EDIT_LAST_OPEN_KEY, () => {
                            respond({ ok: false, error: errMsg });
                        });
                        return;
                    }

                    console.log(`[CEV_AVI] Onglet dossier ouvert — tabId ${tab.id} : ${url}`);
                    respond({ ok: true, opened: true, tabId: tab.id });
                });
            });
        });
    });
}

// ======================== BY-PASS « TOO MANY ATTEMPTS » ========================

/**
 * Vide TOUTES les données de navigation pour repartir sur une session
 * entièrement neuve après un blocage « Too Many Attempts ».
 *
 * Pourquoi un effacement TOTAL et non ciblé sur les origines du portail : le
 * blocage survivait à un nettoyage limité à `visaonweb.diplomatie.be` et
 * `appointment.cloud.diplomatie.be`. Un traceur hors de ces origines suffit à
 * le maintenir — cookie posé par un service tiers (CDN/WAF devant le portail),
 * cookie partitionné, ou stockage d'un domaine intermédiaire de redirection.
 * On efface donc sans filtre d'origine, seule façon de garantir qu'aucun résidu
 * ne subsiste.
 *
 * Ce qui n'est PAS touché :
 *  - la configuration de l'extension (numéro internet, URL de la passerelle et
 *    identifiants de l'onglet « Connexion ») : elle vit dans
 *    `chrome.storage.local`, hors d'atteinte de `chrome.browsingData` ;
 *  - les mots de passe enregistrés dans Chrome, l'historique, les téléchargements
 *    et les données de formulaire : volontairement exclus, ce ne sont pas des
 *    résidus de session.
 *
 * Contrepartie assumée : les sessions des AUTRES sites de ce profil Chrome sont
 * fermées (déconnexion). Acceptable sur un profil dédié à l'automatisation.
 *
 * Plafond glissant (MAX_CACHE_CLEARS_PER_WINDOW par CACHE_CLEAR_WINDOW_MS) :
 * chaque effacement relance aussitôt une requête vers le portail qui vient de
 * bloquer. Si le blocage est appliqué côté serveur (IP), aucun effacement ne
 * peut le lever, et un effacement illimité ferait boucler
 * « blocage → effacement → redirection → blocage » à la fréquence du
 * chargement de page — en déconnectant l'utilisateur de tous ses sites à
 * chaque tour. Au-delà du plafond, la demande est refusée
 * (`{ok:false, rateLimited:true, retryAt}`) : c'est tooManyAttempts.js qui
 * décide alors de ne PAS rediriger tout de suite (voir ce fichier).
 *
 * Précaution conservée — écriture CIBLÉE : seules les clés `loginAttempts` et
 * `cacheClearAttempts` sont modifiées (jamais un `get(null)` + réécriture
 * complète du storage). `chrome.browsingData.remove` est asynchrone et peut
 * prendre plusieurs centaines de ms : relire TOUT le storage avant et le
 * réécrire en bloc après aurait effacé silencieusement toute clé modifiée par
 * un autre script pendant ce délai (ex : `bookingTrigger` posé par un autre
 * onglet pour relancer une réservation) — source de pannes intermittentes
 * difficiles à reproduire. `chrome.storage.local.set` fusionne par clé, donc
 * écrire uniquement ces clés ne touche à rien d'autre.
 *
 * @param {(result: {ok: boolean, rateLimited?: boolean, retryAt?: number}) => void} respond
 */
function clearAllBrowsingData(respond) {
    chrome.storage.local.get('cacheClearAttempts', (data) => {
        const now = Date.now();
        const recentClears = (Array.isArray(data.cacheClearAttempts) ? data.cacheClearAttempts : [])
            .filter((ts) => now - ts < CACHE_CLEAR_WINDOW_MS);

        if (recentClears.length >= MAX_CACHE_CLEARS_PER_WINDOW) {
            const retryAt = recentClears[0] + CACHE_CLEAR_WINDOW_MS;
            console.error(`[CEV_AVI] ${recentClears.length} effacements déjà effectués en ${CACHE_CLEAR_WINDOW_MS / 60000} min — nouvelle demande refusée (le blocage persiste probablement côté serveur/IP ; un effacement de plus n'y changerait rien). Prochaine tentative possible dans ${Math.ceil((retryAt - now) / 1000)}s.`);
            respond({ ok: false, rateLimited: true, retryAt });
            return;
        }

        // AUCUN filtre d'origine et `since: 0` : on efface depuis le début des
        // temps et pour tous les sites, sinon un résidu hors des origines du
        // portail (cookie tiers, cookie partitionné) maintient le blocage.
        chrome.browsingData.remove({ since: 0 }, {
            cache: true,
            cacheStorage: true,
            cookies: true,
            fileSystems: true,
            indexedDB: true,
            localStorage: true,
            serviceWorkers: true,
            webSQL: true,
        }, () => {
            const removeError = chrome.runtime.lastError;
            if (removeError) {
                console.warn('[CEV_AVI] Effacement total des données de navigation impossible :', removeError.message);
            }

            // Écriture CIBLÉE (voir doc ci-dessus) : ne touche à aucune autre clé.
            chrome.storage.local.set({
                loginAttempts: [],
                cacheClearAttempts: [...recentClears, now],
            }, () => {
                console.log(`[CEV_AVI] TOUTES les données de navigation effacées (effacement ${recentClears.length + 1}/${MAX_CACHE_CLEARS_PER_WINDOW} de la fenêtre glissante) — configuration du popup préservée, connexion automatique réarmée.`);
                respond({ ok: !removeError });
            });
        });
    });
}

// ======================== ÉCOUTEUR DE MESSAGES ========================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

    if (request.action === 'clearBrowserCache') {
        // Demandé par tooManyAttempts.js (page « Too Many Attempts »).
        clearAllBrowsingData(sendResponse);
        return true; // réponse asynchrone

    } else if (request.action === 'reloadTab' && sender.tab) {
        reloadTab(sender.tab.id);

    } else if (request.action === 'registerCaptchaTab' && sender.tab) {
        // client.js confirme s'exécuter sur une page captcha : on suit cet onglet
        // de façon fiable (indépendamment de la détection d'URL). Sa fermeture
        // MANUELLE déclenchera le compte à rebours de 15 min.
        rememberCaptchaTab(sender.tab.id);

    } else if (request.action === 'appointmentConfirmed') {
        // RDV réellement confirmé pour ce profil → le by-pass captcha n'a plus
        // d'objet : on efface le compte à rebours (plus de boîte de dialogue).
        clearCaptchaBypassCountdown();

    } else if (request.action === 'openEditTab') {
        // applicationsPage.js a résolu l'URL du dossier sur la ligne du demandeur
        // et demande son ouverture dans un NOUVEL onglet, pour conserver l'onglet
        // IndexByUserId. editPage.js y poursuivra vers le captcha.
        if (!request.url) {
            sendResponse({ ok: false, error: 'URL manquante' });
            return;
        }
        openEditTab(request.url, sendResponse);
        return true; // réponse asynchrone (lecture storage + tabs.create)

    } else if (request.action === 'bookingFallbackToTable') {
        // editPage.js n'a pas pu aboutir sur la page du dossier (bouton absent,
        // dossier ne correspondant pas au profil…). Il a déjà invalidé le cache ;
        // on relance ici le parcours complet, qui amènera un onglet sur
        // IndexByUserId même si aucun n'est ouvert — cas que le seul drapeau
        // `bookingTrigger` en storage ne couvrirait pas.
        triggerBookingViaApplicationsTable();

    } else if (request.action === 'appointmentFound') {
        // Créneau détecté par la fenêtre principale (client.js) → publier sur
        // Kafka. La réponse confirme la publication : client.js réessaie tant
        // qu'elle n'est pas obtenue.
        publishAppointmentFound(sendResponse);
        return true; // réponse asynchrone (lecture storage + envoi WebSocket)

    } else if (request.action === 'sendAppointmentEmail') {
        // Page de confirmation détectée → demander à la passerelle d'envoyer l'email.
        publishAppointmentEmail(request.details || {});

    } else if (request.action === 'getWsStatus') {
        // Le popup demande le statut de la connexion WebSocket (réponse immédiate)
        sendResponse({ status: wsStatus });

    } else if (request.action === 'reconnectWs') {
        // L'utilisateur vient de valider une nouvelle configuration OU a cliqué
        // « Reconnecter ». On lève le drapeau de déconnexion manuelle puis on
        // repart sur une connexion neuve.
        chrome.storage.local.set({ wsManualDisconnect: false }, () => {
            if (ws) {
                ws.close();
                ws = null;
            }
            reconnectDelay = 2000;
            reconnectScheduled = false;
            connectWebSocket();
        });

    } else if (request.action === 'disconnectWs') {
        // Déconnexion manuelle depuis le popup : on coupe la WebSocket et on
        // pose un drapeau persistant pour empêcher la reconnexion automatique
        // (alarme keepalive / onclose) tant que l'utilisateur ne reconnecte pas.
        chrome.storage.local.set({ wsManualDisconnect: true }, () => {
            reconnectScheduled = false;
            if (ws) {
                ws.close();
                ws = null;
            }
            setWsStatus('disconnected');
            console.log('[CEV_AVI] Déconnexion manuelle effectuée.');
        });
    }
});

// ======================== RECHARGEMENT D'ONGLET ========================

/** Délai (ms) au-delà duquel on cesse d'attendre la fin du rechargement d'un onglet. */
const RELOAD_WATCH_TIMEOUT_MS = 30000;

function reloadTab(tabId) {
    chrome.tabs.reload(tabId, {}, () => {
        function listener(tabIdUpdated, changeInfo) {
            if (tabId === tabIdUpdated && changeInfo.status === 'complete') {
                clearTimeout(giveUp);
                chrome.tabs.onUpdated.removeListener(listener);
            }
        }

        // Sans ce garde-fou, un onglet fermé ou bloqué pendant son rechargement
        // laisserait le listener attaché définitivement (fuite cumulative).
        const giveUp = setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(listener);
        }, RELOAD_WATCH_TIMEOUT_MS);

        chrome.tabs.onUpdated.addListener(listener);
    });
}

