/**
 * ==========================================================================
 * LOGIQUE PURE DE LA PASSERELLE — CEV_AVI
 * ==========================================================================
 *
 * Fonctions sans effet de bord (pas de Kafka, pas de WebSocket, pas de réseau)
 * extraites de index.js pour être testables unitairement.
 *
 * Toute la logique décisionnelle (validation des messages, génération
 * d'identifiants, décision de rejeu, mutations du registre) vit ici.
 * index.js se contente d'orchestrer ces fonctions avec les I/O réelles.
 * ==========================================================================
 */

const crypto = require('crypto');

/** Constante WebSocket readyState OPEN (évite de dépendre de la lib ws ici). */
const WS_OPEN = 1;

/**
 * Parse un message WebSocket entrant en objet JSON.
 * @param {string|Buffer} raw - Donnée brute reçue.
 * @returns {object|null} L'objet parsé, ou null si JSON invalide.
 */
function parseMessage(raw) {
    try {
        const text = typeof raw === 'string' ? raw : raw.toString();
        const parsed = JSON.parse(text);
        // On n'accepte que des objets (pas les nombres/chaînes/null JSON valides).
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * Génère l'identifiant stable d'un événement RDV, utilisé pour la
 * déduplication côté extension.
 * @param {string} windowId
 * @param {number} timestamp
 * @returns {string}
 */
function buildEventId(windowId, timestamp) {
    return `${windowId}:${timestamp}`;
}

// ======================== VALIDATION DU FORMAT DES ENTRÉES CLIENT ========================
//
// windowId et internetNumber ne sont pas de simples identifiants internes :
// ils sont réinjectés tels quels dans le corps des emails envoyés
// automatiquement et utilisés comme clés Kafka. Une simple vérification de
// présence (valeur non vide) ne suffit pas — un client pourrait fournir une
// chaîne arbitraire (injection de contenu dans l'email, clé Kafka anormale,
// déni de service via une valeur démesurément longue). On valide donc aussi
// le FORMAT attendu, pas seulement la présence.

/**
 * windowId est un UUID v4 généré côté extension par crypto.randomUUID()
 * (voir background.js) : on exige ce format exact.
 */
const WINDOW_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * internetNumber suit le format des numéros du portail (ex: "VOWINT6055154") :
 * on reste volontairement permissif sur le préfixe/la casse exacte (pour ne
 * pas casser une variante légitime non anticipée) mais on restreint le jeu de
 * caractères à l'alphanumérique et on borne la longueur — ce qui suffit à
 * bloquer toute tentative d'injection (HTML, sauts de ligne, etc.) tout en
 * acceptant les formats réels.
 */
const INTERNET_NUMBER_REGEX = /^[A-Za-z0-9]{3,40}$/;

/**
 * Vérifie qu'une valeur est un windowId valide (UUID v4, espaces en début/fin
 * tolérés).
 * @param {*} value
 * @returns {boolean}
 */
function isValidWindowId(value) {
    return typeof value === 'string' && WINDOW_ID_REGEX.test(value.trim());
}

/**
 * Vérifie qu'une valeur est un internetNumber valide (alphanumérique,
 * 3 à 40 caractères, espaces en début/fin tolérés).
 * @param {*} value
 * @returns {boolean}
 */
function isValidInternetNumber(value) {
    return typeof value === 'string' && INTERNET_NUMBER_REGEX.test(value.trim());
}

/**
 * Vérifie qu'un message "register" est complet, bien typé ET dans un format
 * exploitable (windowId/internetNumber valides — pas seulement présents).
 * @param {object} msg
 * @returns {boolean}
 */
function isValidRegister(msg) {
    return Boolean(
        msg &&
        msg.type === 'register' &&
        isValidWindowId(msg.windowId) &&
        isValidInternetNumber(msg.internetNumber),
    );
}

/**
 * Vérifie qu'un message "appointmentFound" est complet, bien typé ET dans un
 * format exploitable (windowId/internetNumber valides — pas seulement présents).
 * @param {object} msg
 * @returns {boolean}
 */
function isValidAppointmentFound(msg) {
    return Boolean(
        msg &&
        msg.type === 'appointmentFound' &&
        isValidWindowId(msg.windowId) &&
        isValidInternetNumber(msg.internetNumber),
    );
}

/**
 * Décide si le dernier événement RDV doit être REJOUÉ à une fenêtre qui
 * (re)connecte. On rejoue si :
 *  - un événement existe,
 *  - il est encore dans la fenêtre de rejeu (TTL),
 *  - et ce n'est PAS la fenêtre qui l'a elle-même produit.
 *
 * @param {{payload: object, receivedAt: number}|null} lastAppointment
 * @param {string} windowId - Fenêtre qui vient de se (re)connecter.
 * @param {number} now - Horodatage courant (ms).
 * @param {number} ttlMs - Durée de validité du rejeu (ms).
 * @returns {boolean}
 */
function shouldReplay(lastAppointment, windowId, now, ttlMs) {
    if (!lastAppointment || !lastAppointment.payload) return false;
    if ((now - lastAppointment.receivedAt) >= ttlMs) return false;
    if (lastAppointment.payload.windowId === windowId) return false;
    return true;
}

/**
 * Enregistre/remplace l'internet number d'une fenêtre dans un registre (Map).
 * Mutation pure : ne touche qu'à la Map fournie.
 * @param {Map<string,string>} registry
 * @param {string} windowId
 * @param {string} internetNumber
 * @returns {{previous: string|undefined, changed: boolean}}
 */
function applyRegister(registry, windowId, internetNumber) {
    const previous = registry.get(windowId);
    registry.set(windowId, internetNumber);
    return { previous, changed: previous !== internetNumber };
}

/**
 * Supprime une fenêtre du registre (Map).
 * @param {Map<string,string>} registry
 * @param {string} windowId
 * @returns {{removed: boolean, internetNumber: string|undefined}}
 */
function applyUnregister(registry, windowId) {
    if (!registry.has(windowId)) {
        return { removed: false, internetNumber: undefined };
    }
    const internetNumber = registry.get(windowId);
    registry.delete(windowId);
    return { removed: true, internetNumber };
}

/**
 * Compte le nombre de clients WebSocket actuellement ouverts.
 * @param {Iterable<{readyState: number}>} clients
 * @returns {number}
 */
function countOpenClients(clients) {
    let count = 0;
    for (const client of clients) {
        if (client && client.readyState === WS_OPEN) count++;
    }
    return count;
}

/** URL de connexion au portail, affichée dans l'email de notification. */
const LOGIN_URL = 'https://visaonweb.diplomatie.be/Account/Login';

/** Longueur maximale retenue pour un champ libre réinjecté dans un email. */
const EMAIL_FIELD_MAX_LENGTH = 200;

/**
 * Indique si une chaîne contient un caractère de contrôle (code inférieur à 32,
 * ou 127/DEL). Comparaison directe sur le code de chaque caractère plutôt
 * qu'une classe de regex à échappements hexadécimaux, pour rester lisible sans
 * ambiguïté d'encodage.
 * @param {string} value
 * @returns {boolean}
 */
function hasControlCharacter(value) {
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code < 32 || code === 127) return true;
    }
    return false;
}

/**
 * Nettoie une valeur fournie par le client avant de l'insérer dans un email.
 *
 * Les champs de `sendEmail` (nom du demandeur, date, agent) sont du texte libre :
 * ils atterrissent dans le SUJET et le corps du message. Sans nettoyage, un
 * retour chariot permettrait d'injecter des en-têtes SMTP supplémentaires
 * (destinataires cachés, faux expéditeur) et une valeur démesurée servirait à
 * saturer l'envoi. On retire donc tous les caractères de contrôle et on borne la
 * longueur.
 *
 * @param {*} value - Valeur brute reçue du client.
 * @returns {string} Valeur exploitable (chaîne vide si inutilisable).
 */
function sanitizeEmailField(value) {
    if (typeof value !== 'string') return '';
    let cleaned = '';
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        cleaned += (code < 32 || code === 127) ? ' ' : value[i];
    }
    return cleaned.trim().slice(0, EMAIL_FIELD_MAX_LENGTH);
}

/**
 * Construit le sujet et le corps (texte) de l'email de notification « RDV trouvé ».
 * Fonction pure (aucun envoi) pour être testable unitairement.
 *
 * @param {object} data
 * @param {string} [data.applicantName]   - Nom du candidat.
 * @param {string} [data.appointmentDate] - Date/heure du RDV (ex: "11/05/2026 à 10:20").
 * @param {string} [data.bookedAt]        - Horodatage lisible de la réservation.
 * @param {string} [data.bookedBy]        - Email de l'agent ayant pris le RDV.
 * @returns {{subject: string, text: string}}
 */
function buildAppointmentEmail(data) {
    const d = data || {};
    const applicant = sanitizeEmailField(d.applicantName) || 'Demandeur';
    const appointmentDate = sanitizeEmailField(d.appointmentDate) || 'à confirmer sur le site';
    const bookedAt = sanitizeEmailField(d.bookedAt) || '-';
    const bookedBy = sanitizeEmailField(d.bookedBy) || '-';

    const subject = `RDV réservé : ${applicant}${sanitizeEmailField(d.appointmentDate) ? ` — ${appointmentDate}` : ''}`;

    const text =
        'Bonne nouvelle ! Un rendez-vous a été réservé avec succès !\n\n' +
        `👤 Candidat : ${applicant}\n` +
        `📅 Date du rendez-vous : ${appointmentDate}\n` +
        `🕐 Réservation effectuée le : ${bookedAt}\n\n` +
        `👨‍💻 Rendez-vous pris par : ${bookedBy}\n\n` +
        '⚠️ Connectez-vous rapidement sur le site pour vérifier et finaliser le rendez-vous :\n' +
        LOGIN_URL;

    return { subject, text };
}

/** Champs de texte libre acceptés dans un message "sendEmail". */
const SEND_EMAIL_TEXT_FIELDS = ['applicantName', 'appointmentDate', 'bookedAt', 'bookedBy'];

/**
 * Valide un message WebSocket "sendEmail" provenant de l'extension.
 *
 * Vérifier le seul `type` ne suffit pas : ce message déclenche un envoi réel
 * depuis le compte Gmail de la passerelle. On exige donc que chaque champ libre
 * soit une chaîne de longueur raisonnable et sans caractère de contrôle (un
 * retour chariot dans le sujet permettrait d'injecter des en-têtes SMTP). Les
 * champs absents restent tolérés — ils sont tous optionnels côté extension.
 *
 * @param {object} msg
 * @returns {boolean}
 */
function isValidSendEmail(msg) {
    if (!msg || msg.type !== 'sendEmail') return false;

    return SEND_EMAIL_TEXT_FIELDS.every((field) => {
        const value = msg[field];
        if (value === undefined || value === null) return true;
        if (typeof value !== 'string') return false;
        if (value.length > EMAIL_FIELD_MAX_LENGTH) return false;
        return !hasControlCharacter(value);
    });
}

/**
 * Détermine l'hôte (IP) du serveur à afficher dans l'alerte email.
 * Priorité : override explicite → première adresse IPv4 non-interne détectée
 * sur les interfaces réseau → "localhost" en dernier recours.
 *
 * Fonction pure : reçoit le résultat de os.networkInterfaces() en argument
 * pour rester testable sans dépendre de l'environnement réel.
 *
 * @param {Record<string, Array<{address: string, family: string|number, internal: boolean}>>} interfaces
 * @param {string} [override] - Hôte forcé (ex: IP publique / nom DNS).
 * @returns {string}
 */
function pickServerHost(interfaces, override) {
    if (override && override.trim()) return override.trim();

    if (interfaces && typeof interfaces === 'object') {
        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name] || []) {
                const isIPv4 = iface.family === 'IPv4' || iface.family === 4;
                if (isIPv4 && !iface.internal && iface.address) {
                    return iface.address;
                }
            }
        }
    }
    return 'localhost';
}

/**
 * Construit l'URL du serveur au format protocole://hôte:port.
 * @param {string} host
 * @param {number|string} port
 * @param {string} [protocol='ws']
 * @returns {string}
 */
function buildServerUrl(host, port, protocol = 'ws') {
    return `${protocol}://${host}:${port}`;
}

/**
 * Construit le sujet et le corps de l'alerte « RDV trouvé » envoyée
 * automatiquement par le serveur, incluant l'URL du serveur (IP:Port).
 * Fonction pure (aucun envoi) pour être testable unitairement.
 *
 * @param {object} data
 * @param {string} [data.serverUrl]      - URL du serveur (IP:Port) ayant trouvé le RDV.
 * @param {string} [data.internetNumber] - Numéro internet du demandeur concerné.
 * @param {string} [data.windowId]       - Identifiant de la fenêtre émettrice.
 * @param {string} [data.foundAt]        - Horodatage lisible de la détection.
 * @returns {{subject: string, text: string}}
 */
function buildAppointmentAlertEmail(data) {
    const d = data || {};
    const serverUrl = (d.serverUrl || '').trim() || 'inconnu';
    const internetNumber = (d.internetNumber || '').trim() || '-';
    const windowId = (d.windowId || '').trim() || '-';
    const foundAt = (d.foundAt || '').trim() || '-';

    const subject = `RDV trouvé — serveur ${serverUrl}`;

    const text =
        'Un rendez-vous vient d\'être trouvé par un serveur.\n\n' +
        `🌐 URL du serveur (IP:Port) : ${serverUrl}\n` +
        `🔢 Numéro internet : ${internetNumber}\n` +
        `🪟 Fenêtre émettrice : ${windowId}\n` +
        `🕐 Détecté le : ${foundAt}\n\n` +
        '⚠️ Connectez-vous rapidement sur le site pour finaliser le rendez-vous :\n' +
        LOGIN_URL;

    return { subject, text };
}

// ======================== DÉDUPLICATION DES ALERTES EMAIL ========================

/**
 * Décide si l'alerte email « RDV trouvé » doit être ENVOYÉE pour cet
 * événement, ou IGNORÉE car il s'agit d'un doublon récent. Deux garde-fous
 * indépendants (mêmes principes que la dédup côté extension par eventId) :
 *
 *  1. Doublon EXACT : le même eventId a déjà déclenché une alerte (ex: rejeu
 *     Kafka, redélivrance du consumer group).
 *  2. Rafale : une alerte a déjà été envoyée pour ce MÊME internetNumber il y
 *     a moins de `cooldownMs` (ex: plusieurs événements très rapprochés issus
 *     du même profil lors d'un cycle de réservation multi-fenêtres).
 *
 * Cette déduplication ne concerne QUE l'envoi d'email : la diffusion Kafka aux
 * fenêtres (broadcastToAll dans index.js) n'est, elle, jamais retardée ni
 * filtrée — voir isValidAppointmentFound/index.js.
 *
 * Fonction pure : mute l'état fourni (comme applyRegister/applyUnregister),
 * ne fait aucune I/O. Purge au passage les entrées expirées de `sentEvents`
 * pour éviter une croissance illimitée de l'état en mémoire.
 *
 * @param {{sentEvents: Map<string, number>, lastSentByInternetNumber: Map<string, number>}} state
 * @param {{eventId?: string, internetNumber?: string}} event
 * @param {number} now - Horodatage courant (ms).
 * @param {{eventTtlMs: number, cooldownMs: number}} options
 * @returns {boolean} true si l'alerte doit être envoyée (état mis à jour en conséquence).
 */
function shouldSendAppointmentAlert(state, event, now, options) {
    const eventTtlMs = options && options.eventTtlMs;
    const cooldownMs = options && options.cooldownMs;
    const eventId = event && event.eventId;
    const internetNumber = event && event.internetNumber;

    for (const [id, sentAt] of state.sentEvents) {
        if ((now - sentAt) >= eventTtlMs) state.sentEvents.delete(id);
    }

    if (eventId && state.sentEvents.has(eventId)) {
        return false;
    }
    if (internetNumber && state.lastSentByInternetNumber.has(internetNumber)) {
        const lastSentAt = state.lastSentByInternetNumber.get(internetNumber);
        if ((now - lastSentAt) < cooldownMs) {
            return false;
        }
    }

    if (eventId) state.sentEvents.set(eventId, now);
    if (internetNumber) state.lastSentByInternetNumber.set(internetNumber, now);
    return true;
}

// ======================== ANTI-RAFALE APPOINTMENTFOUND ========================

/**
 * Délai minimum (ms) entre deux productions Kafka d'un MÊME windowId.
 *
 * La passerelle diffuse chaque appointmentFound valide immédiatement et sans
 * cooldown GLOBAL (voir index.js : la protection contre les cascades légitimes
 * multi-fenêtres vit côté extension, via isMainWindow). Mais rien ne bornait
 * un client UNIQUE qui spammerait — bug ou rafale malveillante : chaque
 * eventId étant horodaté, la dédup par eventId côté extension ne filtre rien
 * dans ce cas (eventId différent à chaque envoi). Ce cooldown est donc borné
 * PAR windowId, pas global : des fenêtres différentes restent diffusées
 * immédiatement, comme avant.
 */
const APPOINTMENT_PRODUCE_COOLDOWN_MS = 30 * 1000;

/**
 * Décide si un appointmentFound émis par `windowId` doit être PRODUIT sur
 * Kafka maintenant, ou ignoré parce que CE MÊME windowId vient déjà d'en
 * produire un très récemment.
 *
 * Fonction pure : mute `lastProducedByWindow` sur acceptation, ne fait aucune
 * I/O — comme applyRegister/applyUnregister.
 *
 * @param {Map<string, number>} lastProducedByWindow
 * @param {string} windowId
 * @param {number} now - Horodatage courant (ms).
 * @param {number} [cooldownMs]
 * @returns {boolean} true si la production doit avoir lieu (état mis à jour en conséquence).
 */
function allowAppointmentProduction(lastProducedByWindow, windowId, now, cooldownMs = APPOINTMENT_PRODUCE_COOLDOWN_MS) {
    const last = lastProducedByWindow.get(windowId);
    if (typeof last === 'number' && (now - last) < cooldownMs) {
        return false;
    }
    lastProducedByWindow.set(windowId, now);
    return true;
}

// ======================== AUTHENTIFICATION DES CONNEXIONS WS ========================

/**
 * Vérifie si une Origin de connexion WebSocket est autorisée.
 *
 * Sans liste configurée (tableau vide/absent), AUCUNE restriction n'est
 * appliquée (comportement historique, pour ne pas casser un déploiement non
 * configuré) — un avertissement doit être loggé par l'appelant dans ce cas.
 * Avec une liste, l'origin doit correspondre EXACTEMENT à une entrée, ou à un
 * préfixe si l'entrée se termine par "*" (utile pour "chrome-extension://*",
 * car l'ID d'une extension chargée en mode développeur varie selon le poste).
 *
 * @param {string} origin - En-tête Origin de la requête entrante (peut être vide).
 * @param {string[]} allowedOrigins - Origines autorisées (exactes ou préfixes "...*").
 * @returns {boolean}
 */
function isAllowedOrigin(origin, allowedOrigins) {
    if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) return true;
    const o = origin || '';
    return allowedOrigins.some((allowed) => {
        if (!allowed) return false;
        if (allowed.endsWith('*')) {
            return o.startsWith(allowed.slice(0, -1));
        }
        return o === allowed;
    });
}

/**
 * Extrait le jeton d'authentification d'une requête WebSocket entrante.
 * Cherche d'abord l'en-tête `x-gateway-token` (utilisable par un futur client
 * non-navigateur), puis le paramètre de requête `?token=...` (seule option
 * disponible pour l'API WebSocket des navigateurs, qui ne permet pas d'en-têtes
 * personnalisés).
 *
 * @param {string} requestUrl - `req.url` de la requête d'upgrade (ex: "/?token=abc").
 * @param {Record<string, string|string[]|undefined>} [headers] - En-têtes de la requête.
 * @returns {string} Jeton trouvé, ou chaîne vide.
 */
function extractAuthToken(requestUrl, headers) {
    const h = headers || {};
    const headerToken = h['x-gateway-token'];
    if (headerToken) {
        return Array.isArray(headerToken) ? headerToken[0] : String(headerToken);
    }

    try {
        const url = new URL(requestUrl || '', 'http://localhost');
        const qToken = url.searchParams.get('token');
        if (qToken) return qToken;
    } catch {
        // URL invalide : pas de jeton exploitable.
    }
    return '';
}

/**
 * Compare un jeton fourni au jeton attendu, en temps constant pour éviter les
 * attaques par mesure de timing.
 *
 * Si aucun jeton n'est configuré côté serveur (`expectedToken` vide),
 * l'authentification est considérée comme DÉSACTIVÉE et la fonction retourne
 * `true` (comportement opt-in, comme pour l'email : la fonctionnalité ne
 * s'active que si elle est explicitement configurée).
 *
 * @param {string} providedToken - Jeton fourni par le client.
 * @param {string} expectedToken - Jeton attendu (configuration serveur).
 * @returns {boolean}
 */
function isValidAuthToken(providedToken, expectedToken) {
    if (!expectedToken) return true;
    if (!providedToken) return false;

    const a = Buffer.from(String(providedToken));
    const b = Buffer.from(String(expectedToken));
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

module.exports = {
    WS_OPEN,
    LOGIN_URL,
    EMAIL_FIELD_MAX_LENGTH,
    hasControlCharacter,
    sanitizeEmailField,
    parseMessage,
    buildEventId,
    isValidWindowId,
    isValidInternetNumber,
    isValidRegister,
    isValidAppointmentFound,
    shouldReplay,
    applyRegister,
    applyUnregister,
    countOpenClients,
    buildAppointmentEmail,
    isValidSendEmail,
    pickServerHost,
    buildServerUrl,
    buildAppointmentAlertEmail,
    isAllowedOrigin,
    extractAuthToken,
    isValidAuthToken,
    shouldSendAppointmentAlert,
    allowAppointmentProduction,
    APPOINTMENT_PRODUCE_COOLDOWN_MS,
};
