/**
 * ==========================================================================
 * PASSERELLE WEBSOCKET <-> KAFKA — CEV_AVI
 * ==========================================================================
 *
 * Ce service fait le pont entre les extensions Chrome (via WebSocket)
 * et le broker Kafka pour la coordination multi-profils.
 *
 * Deux topics Kafka :
 *  - applicant-registry : registre des demandeurs (clé = windowId).
 *      • "register"   → enregistre/remplace l'internet number de la fenêtre.
 *      • déconnexion  → tombstone (suppression de l'internet number).
 *  - appointment-found : événement "RDV trouvé" (fin du processus complet).
 *      • diffusé IMMÉDIATEMENT à toutes les fenêtres abonnées, sans cooldown
 *        ni file d'attente (la protection contre les cascades de notification
 *        vit côté extension : seule la fenêtre principale notifie, voir
 *        notifyAppointmentFoundOnce dans client.js) ;
 *      • purgé PÉRIODIQUEMENT une fois consommé (deleteTopicRecords).
 *
 * Flux :
 *  1. Chaque fenêtre se connecte et s'enregistre {register, windowId, internetNumber}.
 *  2. La fenêtre principale termine son processus de RDV → {appointmentFound}.
 *  3. La passerelle produit sur Kafka, consomme, diffuse à toutes les fenêtres.
 *  4. Les autres fenêtres recherchent LEUR internet number et cliquent le calendrier.
 *  5. Le topic appointment-found est purgé périodiquement, sans jamais dépasser
 *     le dernier offset consommé (voir purgeTopic).
 * ==========================================================================
 */

const { Kafka } = require('kafkajs');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const http = require('http');
const os = require('os');
const nodemailer = require('nodemailer');
const {
    parseMessage,
    buildEventId,
    isValidRegister,
    isValidAppointmentFound,
    isValidSendEmail,
    shouldReplay,
    applyRegister,
    applyUnregister,
    countOpenClients,
    buildAppointmentEmail,
    pickServerHost,
    buildServerUrl,
    buildAppointmentAlertEmail,
    isAllowedOrigin,
    extractAuthToken,
    isValidAuthToken,
    shouldSendAppointmentAlert,
    allowAppointmentProduction,
} = require('./logic');

// ======================== CONFIGURATION ========================

// Les valeurs par défaut doivent rester alignées sur server/docker-compose.yml,
// sinon un lancement direct (`node index.js`, sans .env) viserait un broker et un
// port inexistants.
const KAFKA_BROKER   = process.env.KAFKA_BROKER   || 'localhost:8686';
const KAFKA_TOPIC    = process.env.KAFKA_TOPIC    || 'appointment-found';
const REGISTRY_TOPIC = process.env.REGISTRY_TOPIC || 'applicant-registry';
const WS_PORT        = parseInt(process.env.WS_PORT || '8787', 10);

/**
 * groupId Kafka STABLE du consumer (ne change PAS entre redémarrages), pour
 * que Kafka retienne la position de lecture (offsets committés) et ne perde
 * pas les messages produits pendant un arrêt bref. À NE PAS confondre avec
 * GATEWAY_INSTANCE_ID ci-dessous (aléatoire, sert uniquement à distinguer les
 * logs/healthcheck d'un processus à l'autre).
 *
 * ⚠️ Architecture mono-instance : ce système suppose qu'UNE SEULE passerelle
 * est active à la fois sur ce groupId. Avec plusieurs instances partageant le
 * même groupId, Kafka RÉPARTIRAIT les messages ENTRE elles au lieu de les
 * diffuser à toutes les fenêtres connectées (le broadcast actuel suppose un
 * unique consommateur du groupe). Ne pas lancer plusieurs instances de
 * passerelle simultanément avec le même KAFKA_CONSUMER_GROUP_ID.
 */
const KAFKA_CONSUMER_GROUP_ID = (process.env.KAFKA_CONSUMER_GROUP_ID || 'cev-avi-gateway').trim();

/**
 * Intervalle (ms) entre deux purges du topic KAFKA_TOPIC. On purge
 * PÉRIODIQUEMENT plutôt qu'après CHAQUE message consommé : ce topic est un
 * simple bus de diffusion éphémère (pas un historique), et ouvrir/fermer une
 * connexion admin Kafka à chaque RDV trouvé serait coûteux pour un bénéfice
 * nul (quelques secondes de délai supplémentaire avant purge sont sans impact).
 */
const KAFKA_PURGE_INTERVAL_MS = parseInt(process.env.KAFKA_PURGE_INTERVAL_MS || '', 10)
    || 30 * 1000;

/**
 * Hôte d'écoute du serveur HTTP/WebSocket. Par défaut `127.0.0.1` (loopback) :
 * le port n'est PAS exposé en dehors de la machine, même avec
 * `network_mode: host`. Pour autoriser l'accès depuis le réseau local ou
 * l'extérieur (coordination multi-machines), positionner explicitement
 * `WS_HOST=0.0.0.0` — dans ce cas, `GATEWAY_AUTH_TOKEN` DOIT être configuré.
 */
const WS_HOST = (process.env.WS_HOST || '127.0.0.1').trim();

// ---- Authentification des connexions WebSocket ----
/** Jeton partagé requis pour se connecter (vide = authentification désactivée). */
const GATEWAY_AUTH_TOKEN = (process.env.GATEWAY_AUTH_TOKEN || '').trim();
/**
 * Origines autorisées à se connecter (ex: "chrome-extension://*"). Vide =
 * aucune restriction d'Origin (à combiner avec GATEWAY_AUTH_TOKEN).
 */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const IS_LOOPBACK_HOST = WS_HOST === '127.0.0.1' || WS_HOST === 'localhost' || WS_HOST === '::1';

if (!GATEWAY_AUTH_TOKEN) {
    if (IS_LOOPBACK_HOST) {
        console.warn('[GATEWAY] GATEWAY_AUTH_TOKEN non défini — authentification désactivée (acceptable en loopback uniquement).');
    } else {
        console.error('[GATEWAY] ⚠️ ALERTE SÉCURITÉ : WS_HOST n\'est pas en loopback et GATEWAY_AUTH_TOKEN n\'est PAS défini — la passerelle est OUVERTE sur le réseau sans authentification. Définissez GATEWAY_AUTH_TOKEN.');
    }
} else {
    console.log('[GATEWAY] Authentification WebSocket activée (jeton requis).');
}
if (ALLOWED_ORIGINS.length > 0) {
    console.log(`[GATEWAY] Origines autorisées : ${ALLOWED_ORIGINS.join(', ')}`);
}

// ---- Configuration email (Gmail) ----
const GMAIL_USER         = process.env.GMAIL_USER || '';
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD || '';
/** Destinataires par défaut si l'extension n'en fournit pas. */
const MAIL_RECIPIENTS = (process.env.MAIL_RECIPIENTS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Destinataires de l'alerte automatique « RDV trouvé » envoyée par le serveur
 * (indépendante du message sendEmail de l'extension). Aucune valeur par
 * défaut en dur dans le code : à définir dans le fichier .env non versionné.
 */
const APPOINTMENT_ALERT_RECIPIENTS = (process.env.APPOINTMENT_ALERT_RECIPIENTS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * État de déduplication de l'alerte « RDV trouvé » (voir shouldSendAppointmentAlert
 * dans logic.js). Évite les cascades d'emails quand un cycle de réservation
 * multi-fenêtres génère plusieurs événements appointmentFound rapprochés.
 * N'affecte QUE l'envoi d'email : la diffusion Kafka aux fenêtres n'est jamais
 * retardée ni filtrée par cet état.
 */
const alertDedupState = {
    sentEvents: new Map(),
    lastSentByInternetNumber: new Map(),
};
/** Durée de conservation d'un eventId déjà alerté (purge automatique au-delà). */
const ALERT_EVENT_TTL_MS = 10 * 60 * 1000;
/** Délai minimum entre deux alertes pour le même internetNumber (anti-rafale). */
const ALERT_COOLDOWN_MS = parseInt(process.env.APPOINTMENT_ALERT_COOLDOWN_MS || '', 10)
    || 5 * 60 * 1000;

// ---- URL publique du serveur (IP:Port) incluse dans l'alerte RDV ----
// Override possible via SERVER_PUBLIC_URL (URL complète) ou SERVER_PUBLIC_HOST
// (hôte seul). Sinon, détection automatique de la 1re IPv4 non-interne.
const SERVER_PUBLIC_URL  = (process.env.SERVER_PUBLIC_URL || '').trim();
const SERVER_PUBLIC_HOST = (process.env.SERVER_PUBLIC_HOST || '').trim();
const SERVER_URL = SERVER_PUBLIC_URL
    || buildServerUrl(pickServerHost(os.networkInterfaces(), SERVER_PUBLIC_HOST), WS_PORT);

if (!SERVER_PUBLIC_URL && !SERVER_PUBLIC_HOST) {
    // Sur une machine multi-interfaces (Docker, VPN, plusieurs cartes réseau),
    // la 1re IPv4 non-interne détectée n'est pas forcément la bonne — l'URL
    // affichée dans l'alerte RDV pourrait alors être inutilisable/trompeuse.
    console.warn(`[GATEWAY] ⚠️ SERVER_PUBLIC_HOST/SERVER_PUBLIC_URL non défini — URL "${SERVER_URL}" déduite AUTOMATIQUEMENT (1re IPv4 non-interne détectée), potentiellement incorrecte sur une machine multi-interfaces. Définissez SERVER_PUBLIC_HOST explicitement en production.`);
}

// Transport Nodemailer initialisé seulement si les identifiants sont fournis.
// Hôte/port SMTP Gmail donnés explicitement plutôt que via le raccourci
// `service: 'gmail'` : ce raccourci ne résout plus les options de connexion
// dans nodemailer 10.x (options.host reste undefined), alors que la
// configuration explicite est vérifiée fonctionner.
let mailTransport = null;
if (GMAIL_USER && GMAIL_APP_PASSWORD) {
    mailTransport = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    });
    console.log(`[GATEWAY] Email activé — expéditeur: ${GMAIL_USER} | destinataires par défaut: ${MAIL_RECIPIENTS.join(', ') || '(aucun)'}`);
} else {
    console.warn('[GATEWAY] Email DÉSACTIVÉ — définissez GMAIL_USER et GMAIL_APP_PASSWORD pour l\'activer.');
}

/**
 * Envoie l'email de notification « RDV trouvé » via Gmail.
 * Sans configuration mail, ne fait que logguer (n'interrompt jamais le flux).
 * @param {object} payload - Message sendEmail reçu de l'extension.
 */
async function sendAppointmentEmail(payload) {
    // Les destinataires sont décidés UNIQUEMENT par la configuration du serveur.
    // Un `recipients` fourni dans le message n'est jamais utilisé : sinon tout
    // client authentifié pourrait faire envoyer un email à l'adresse de son
    // choix depuis le compte Gmail de la passerelle (relais d'envoi).
    const recipients = MAIL_RECIPIENTS;

    if (!mailTransport) {
        console.warn('[GATEWAY] sendEmail reçu mais email non configuré — ignoré.');
        return;
    }
    if (recipients.length === 0) {
        console.warn('[GATEWAY] sendEmail reçu mais aucun destinataire — ignoré.');
        return;
    }

    const { subject, text } = buildAppointmentEmail(payload);
    try {
        await mailTransport.sendMail({
            from: GMAIL_USER,
            to: recipients.join(', '),
            subject,
            text,
        });
        console.log(`[GATEWAY] Email RDV envoyé à ${recipients.join(', ')} (candidat: ${payload.applicantName || '-'}).`);
    } catch (err) {
        console.error('[GATEWAY] Échec envoi email :', err.message);
    }
}

/**
 * Envoie automatiquement l'alerte « RDV trouvé » au(x) destinataire(s)
 * d'alerte, en incluant l'URL du serveur (IP:Port). Déclenchée par le serveur
 * lui-même à chaque événement appointmentFound consommé depuis Kafka.
 * Ne fait que logguer si l'email n'est pas configuré (n'interrompt jamais le flux).
 * @param {object} payload - Événement appointmentFound consommé.
 */
async function sendAppointmentAlertEmail(payload) {
    if (!mailTransport) {
        console.warn('[GATEWAY] RDV trouvé mais email non configuré — alerte serveur non envoyée.');
        return;
    }
    if (APPOINTMENT_ALERT_RECIPIENTS.length === 0) {
        console.warn('[GATEWAY] RDV trouvé mais aucun destinataire d\'alerte — ignoré.');
        return;
    }

    const { subject, text } = buildAppointmentAlertEmail({
        serverUrl: SERVER_URL,
        internetNumber: payload.internetNumber,
        windowId: payload.windowId,
        foundAt: payload.timestamp ? new Date(payload.timestamp).toLocaleString('fr-FR') : '',
    });

    try {
        await mailTransport.sendMail({
            from: GMAIL_USER,
            to: APPOINTMENT_ALERT_RECIPIENTS.join(', '),
            subject,
            text,
        });
        console.log(`[GATEWAY] Alerte RDV trouvé envoyée à ${APPOINTMENT_ALERT_RECIPIENTS.join(', ')} (serveur: ${SERVER_URL}).`);
    } catch (err) {
        console.error('[GATEWAY] Échec envoi alerte RDV :', err.message);
    }
}

/** Intervalle en ms du ping WebSocket pour détecter les connexions mortes */
const WS_PING_INTERVAL_MS = 30000;

// Identifiant unique de CE PROCESSUS (change à chaque redémarrage) — sert de
// clientId Kafka et d'identifiant de log/healthcheck. Distinct du groupId
// Kafka du consumer (KAFKA_CONSUMER_GROUP_ID, stable — voir plus haut).
const GATEWAY_INSTANCE_ID = `gateway-${crypto.randomUUID()}`;

console.log(`[GATEWAY] Démarrage — instance: ${GATEWAY_INSTANCE_ID} | groupId Kafka (stable) : ${KAFKA_CONSUMER_GROUP_ID}`);
console.log(`[GATEWAY] Kafka : ${KAFKA_BROKER} | Topics : ${KAFKA_TOPIC}, ${REGISTRY_TOPIC} | WS : ${WS_HOST}:${WS_PORT}`);
console.log(`[GATEWAY] URL serveur (alerte RDV) : ${SERVER_URL} | destinataires alerte : ${APPOINTMENT_ALERT_RECIPIENTS.join(', ') || '(aucun)'}`);

// ======================== INITIALISATION KAFKA ========================

const kafka = new Kafka({
    clientId: GATEWAY_INSTANCE_ID,
    brokers: [KAFKA_BROKER],
    retry: {
        initialRetryTime: 1000,
        retries: 20,
    },
});

const producer = kafka.producer();
const consumer = kafka.consumer({ groupId: KAFKA_CONSUMER_GROUP_ID });

/**
 * État Kafka exposé par /health. Sans lui, le healthcheck ne testait que le
 * serveur HTTP : une passerelle dont le consommateur est mort continuait de
 * répondre « ok » tout en ne diffusant plus AUCUN événement de RDV — la panne
 * la plus grave possible ici, et la plus silencieuse.
 */
const kafkaHealth = {
    producerConnected: false,
    consumerRunning: false,
    lastError: null,
};

producer.on(producer.events.CONNECT, () => {
    kafkaHealth.producerConnected = true;
});
producer.on(producer.events.DISCONNECT, () => {
    kafkaHealth.producerConnected = false;
});

// GROUP_JOIN = le consommateur a rejoint le groupe et consomme réellement.
consumer.on(consumer.events.GROUP_JOIN, () => {
    kafkaHealth.consumerRunning = true;
    kafkaHealth.lastError = null;
});
consumer.on(consumer.events.CRASH, ({ payload }) => {
    // kafkajs redémarre lui-même le consommateur quand `restart` est vrai : on ne
    // déclare la passerelle en panne que lorsqu'aucune reprise n'est prévue.
    const willRestart = Boolean(payload && payload.restart);
    kafkaHealth.lastError = payload && payload.error ? String(payload.error) : 'crash';
    if (!willRestart) kafkaHealth.consumerRunning = false;
    console.error(`[GATEWAY] Consommateur Kafka en échec (reprise automatique : ${willRestart ? 'oui' : 'NON'}) : ${kafkaHealth.lastError}`);
});
consumer.on(consumer.events.STOP, () => {
    kafkaHealth.consumerRunning = false;
});

/**
 * Nombre de membres du groupe de consommateurs, tel que vu au dernier sondage
 * (voir refreshConsumerGroupSize). `null` tant qu'aucun sondage n'a abouti.
 *
 * Sert à détecter l'architecture multi-instance ACCIDENTELLE documentée comme
 * interdite (KAFKA_CONSUMER_GROUP_ID doit rester unique à une seule passerelle
 * active) : avec 2 membres ou plus sur le même groupId, Kafka RÉPARTIT les
 * messages entre les instances au lieu de les diffuser à toutes les fenêtres
 * connectées — une panne partielle et silencieuse (certaines fenêtres cessent
 * de recevoir les événements, sans qu'aucun log ni /health ne le signale)
 * jusqu'à ce sondage.
 */
let consumerGroupMemberCount = null;

/** Intervalle (ms) entre deux sondages de la taille du groupe de consommateurs. */
const GROUP_SIZE_CHECK_INTERVAL_MS = 30 * 1000;

/**
 * Interroge Kafka sur le nombre de membres actifs du groupe de consommateurs
 * et met à jour `consumerGroupMemberCount`. Alerte bruyamment si plus d'une
 * instance est détectée sur le même groupId — c'est la signature exacte de
 * l'architecture mono-instance non respectée.
 */
async function refreshConsumerGroupSize() {
    const admin = kafka.admin();
    try {
        await admin.connect();
        const { groups } = await admin.describeGroups([KAFKA_CONSUMER_GROUP_ID]);
        const group = groups.find((g) => g.groupId === KAFKA_CONSUMER_GROUP_ID);
        const count = group ? group.members.length : null;

        if (count > 1 && consumerGroupMemberCount !== count) {
            console.error(`[GATEWAY] ⚠️ ${count} instances détectées sur le groupId Kafka "${KAFKA_CONSUMER_GROUP_ID}" — Kafka RÉPARTIT les messages entre elles au lieu de les diffuser à toutes les fenêtres connectées. Architecture mono-instance requise : arrêtez les instances en trop.`);
        }
        consumerGroupMemberCount = count;
    } catch (err) {
        console.warn('[GATEWAY] Sondage de la taille du groupe de consommateurs impossible :', err.message);
    } finally {
        await admin.disconnect().catch(() => {});
    }
}

// ======================== REGISTRE DES DEMANDEURS ========================

/**
 * Registre en mémoire des demandeurs abonnés.
 * Clé : windowId (UUID du profil Chrome) — Valeur : internetNumber.
 * Miroir du topic Kafka applicant-registry (compacté).
 */
const registry = new Map();

/**
 * Horodatage de la dernière production Kafka par windowId (voir
 * allowAppointmentProduction dans logic.js). Protège contre un client UNIQUE
 * qui spammerait appointmentFound ; ne retarde JAMAIS un événement légitime
 * provenant d'une fenêtre différente.
 * @type {Map<string, number>}
 */
const lastProducedByWindow = new Map();

/**
 * Enregistre (ou remplace) l'internet number d'une fenêtre dans le registre
 * et le publie sur le topic applicant-registry (même clé → remplacement).
 */
async function registerApplicant(windowId, internetNumber) {
    const { previous, changed } = applyRegister(registry, windowId, internetNumber);

    try {
        await producer.send({
            topic: REGISTRY_TOPIC,
            messages: [{
                key: windowId,
                value: JSON.stringify({ windowId, internetNumber, timestamp: Date.now() }),
            }],
        });
        if (previous && changed) {
            console.log(`[GATEWAY] Registre : ${windowId} → ${internetNumber} (remplace ${previous})`);
        } else {
            console.log(`[GATEWAY] Registre : ${windowId} → ${internetNumber}`);
        }
    } catch (err) {
        console.error('[GATEWAY] Erreur publication registre :', err.message);
    }
}

/**
 * Supprime l'internet number d'une fenêtre du registre (fenêtre fermée
 * ou déconnectée) et publie un tombstone sur le topic applicant-registry.
 */
async function unregisterApplicant(windowId) {
    const { removed, internetNumber } = applyUnregister(registry, windowId);
    if (!removed) return;

    try {
        // Tombstone Kafka : valeur null sur la même clé = suppression logique
        await producer.send({
            topic: REGISTRY_TOPIC,
            messages: [{ key: windowId, value: null }],
        });
        console.log(`[GATEWAY] Registre : ${windowId} supprimé (était ${internetNumber}).`);
    } catch (err) {
        console.error('[GATEWAY] Erreur tombstone registre :', err.message);
    }
}

/**
 * Dernier offset CONSOMMÉ par partition du topic RDV. Sert de borne à la purge :
 * voir purgeTopic.
 * @type {Map<number, number>}
 */
const consumedOffsets = new Map();

/**
 * Vide le topic Kafka des enregistrements DÉJÀ CONSOMMÉS, partition par
 * partition.
 *
 * La borne est le dernier offset effectivement traité par `eachMessage`, et non
 * l'offset le plus récent du topic : purger jusqu'à `high` supprimerait un
 * message produit quelques millisecondes plus tôt mais pas encore consommé, ce
 * qui ferait disparaître un RDV trouvé sans jamais le diffuser.
 */
async function purgeTopic(topic) {
    if (consumedOffsets.size === 0) return; // rien n'a encore été consommé

    const admin = kafka.admin();
    try {
        await admin.connect();
        const offsets = await admin.fetchTopicOffsets(topic);

        const partitions = [];
        for (const { partition, low, high } of offsets) {
            const consumed = consumedOffsets.get(partition);
            if (consumed === undefined) continue;

            // fetchTopicOffsets renvoie les offsets sous forme de chaînes.
            const lowOffset = Number(low);
            const highOffset = Number(high);

            // deleteTopicRecords supprime tout ce qui précède l'offset fourni :
            // consumed + 1 conserve donc uniquement les messages non traités.
            const target = Math.min(consumed + 1, highOffset);
            if (target > lowOffset) {
                partitions.push({ partition, offset: String(target) });
            }
        }

        if (partitions.length === 0) return;

        await admin.deleteTopicRecords({ topic, partitions });
        console.log(`[GATEWAY] Topic "${topic}" purgé jusqu'aux offsets consommés (${partitions.map((p) => `${p.partition}:${p.offset}`).join(', ')}).`);
    } catch (err) {
        console.error(`[GATEWAY] Erreur purge du topic "${topic}" :`, err.message);
    } finally {
        await admin.disconnect().catch(() => {});
    }
}

/** Empêche deux purges de tourner en parallèle (intervalle court / purge lente). */
let purgeInFlight = false;

/**
 * Déclenche une purge du topic RDV si aucune n'est déjà en cours. Appelée
 * PÉRIODIQUEMENT (voir purgeInterval) plutôt qu'après chaque message —
 * voir KAFKA_PURGE_INTERVAL_MS ci-dessus pour la justification.
 */
async function purgeTopicIfIdle(topic) {
    if (purgeInFlight) return;
    purgeInFlight = true;
    try {
        await purgeTopic(topic);
    } finally {
        purgeInFlight = false;
    }
}

/** Purge périodique et indépendante de la consommation message par message. */
const purgeInterval = setInterval(() => {
    purgeTopicIfIdle(KAFKA_TOPIC);
}, KAFKA_PURGE_INTERVAL_MS);

/** Intervalle du sondage périodique de la taille du groupe (voir start()). */
let groupSizeInterval = null;

// ======================== GESTION DES CLIENTS WEBSOCKET ========================

/** Set de tous les clients WebSocket actuellement connectés */
const connectedClients = new Set();

/**
 * Dernier événement appointmentFound diffusé, conservé en mémoire pour être
 * REJOUÉ aux fenêtres qui se (re)connectent après le broadcast initial.
 * Sans ce rejeu, une fenêtre dont la WebSocket dormait (service worker MV3
 * suspendu) au moment du broadcast rate définitivement la notification.
 * Forme : { payload, receivedAt }.
 */
let lastAppointment = null;

/** Durée (ms) pendant laquelle le dernier événement reste rejouable. */
const REPLAY_TTL_MS = 3 * 60 * 1000;

/**
 * Envoie un message JSON à tous les clients WebSocket connectés et ouverts.
 */
function broadcastToAll(payload) {
    const message = JSON.stringify(payload);
    for (const client of connectedClients) {
        if (client.readyState === 1 /* OPEN */) {
            client.send(message);
        }
    }
    const count = countOpenClients(connectedClients);
    console.log(`[GATEWAY] Broadcast envoyé à ${count} client(s) : ${message}`);
    return count;
}

// ======================== SERVEUR HTTP (healthcheck) ========================

const httpServer = http.createServer((req, res) => {
    if (req.url === '/health') {
        // Une passerelle qui ne peut plus produire ni consommer est INUTILISABLE :
        // on répond 503 pour que le healthcheck Docker le signale, au lieu de
        // masquer la panne derrière un 200. Idem si plus d'une instance
        // partage le même groupId Kafka (voir refreshConsumerGroupSize) :
        // cette configuration interdite fait taire une partie des fenêtres
        // sans qu'aucun autre signal ne le révèle.
        const multiInstance = typeof consumerGroupMemberCount === 'number' && consumerGroupMemberCount > 1;
        const healthy = kafkaHealth.producerConnected && kafkaHealth.consumerRunning && !multiInstance;
        res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: healthy ? 'ok' : 'degraded',
            kafka: {
                producer: kafkaHealth.producerConnected ? 'connected' : 'disconnected',
                consumer: kafkaHealth.consumerRunning ? 'running' : 'stopped',
                lastError: kafkaHealth.lastError,
            },
            clients: connectedClients.size,
            applicants: registry.size,
            consumerGroupMembers: consumerGroupMemberCount,
            instance: GATEWAY_INSTANCE_ID,
        }));
    } else {
        res.writeHead(404);
        res.end();
    }
});

// ======================== SERVEUR WEBSOCKET ========================

/**
 * Valide une connexion WebSocket ENTRANTE avant l'upgrade HTTP :
 *  1. Vérifie l'Origin (si ALLOWED_ORIGINS est configuré).
 *  2. Vérifie le jeton partagé (si GATEWAY_AUTH_TOKEN est configuré).
 * Rejette avec un code HTTP explicite en cas d'échec, AVANT que la connexion
 * WebSocket ne soit établie (aucun message n'est jamais traité).
 */
function verifyClient(info, callback) {
    const origin = info.req.headers.origin || '';

    if (!isAllowedOrigin(origin, ALLOWED_ORIGINS)) {
        console.warn(`[GATEWAY] Connexion WS refusée — Origin non autorisée : "${origin}"`);
        callback(false, 403, 'Origin non autorisée');
        return;
    }

    const token = extractAuthToken(info.req.url, info.req.headers);
    if (!isValidAuthToken(token, GATEWAY_AUTH_TOKEN)) {
        console.warn(`[GATEWAY] Connexion WS refusée — jeton invalide ou manquant (origin: "${origin}").`);
        callback(false, 401, 'Jeton invalide');
        return;
    }

    callback(true);
}

const wss = new WebSocketServer({ server: httpServer, verifyClient });

/**
 * Traite un message reçu d'une extension.
 *
 * @param {import('ws').WebSocket} ws - Connexion émettrice.
 * @param {Buffer|string} data - Données brutes reçues.
 */
async function handleClientMessage(ws, data) {
    const parsed = parseMessage(data);
    if (!parsed) {
        console.warn('[GATEWAY] Message WS non-JSON reçu, ignoré.');
        return;
    }

    switch (parsed.type) {

        // Abonnement : enregistre/remplace l'internet number de cette fenêtre
        case 'register': {
            // Valide à la fois la présence ET le format (UUID pour windowId,
            // alphanumérique borné pour internetNumber) — ces valeurs sont
            // réinjectées telles quelles dans les emails et les clés Kafka.
            if (!isValidRegister(parsed)) {
                console.warn('[GATEWAY] register incomplet ou mal formé, ignoré.');
                return;
            }
            // Normalisation : on retire les espaces superflus tolérés par la
            // validation, pour que la valeur STOCKÉE/DIFFUSÉE soit toujours
            // strictement conforme au format attendu.
            const windowId = parsed.windowId.trim();
            const internetNumber = parsed.internetNumber.trim();

            ws.windowId = windowId;
            await registerApplicant(windowId, internetNumber);
            ws.send(JSON.stringify({ type: 'registered', internetNumber }));

            // Rejeu : si un RDV récent a été diffusé pendant que cette fenêtre
            // était déconnectée, on le lui renvoie maintenant (sauf si c'est
            // elle qui l'a produit). La dédup par eventId côté extension évite
            // tout double traitement.
            if (shouldReplay(lastAppointment, windowId, Date.now(), REPLAY_TTL_MS)) {
                ws.send(JSON.stringify(lastAppointment.payload));
                console.log(`[GATEWAY] Rejeu appointmentFound → ${windowId} (eventId: ${lastAppointment.payload.eventId})`);
            }
            break;
        }

        // RDV trouvé (fin du processus complet) → produire sur Kafka
        case 'appointmentFound': {
            if (!isValidAppointmentFound(parsed)) {
                console.warn('[GATEWAY] appointmentFound incomplet ou mal formé, ignoré.');
                return;
            }
            const windowId = parsed.windowId.trim();
            const internetNumber = parsed.internetNumber.trim();

            // Aucun cooldown GLOBAL côté passerelle : un appointmentFound
            // légitime provenant d'une fenêtre DIFFÉRENTE est produit et
            // diffusé immédiatement. La protection contre les cascades (une
            // fenêtre notifiée qui retrouverait un créneau et notifierait à
            // son tour) est assurée côté extension — seule la fenêtre
            // principale envoie ce message (voir isMainWindow /
            // notifyAppointmentFoundOnce dans client.js).
            //
            // Anti-rafale PAR windowId : un client UNIQUE qui spammerait ce
            // message (bug, ou rafale malveillante) n'est filtré par AUCUNE
            // dédup côté extension (chaque eventId est horodaté, donc
            // distinct). Ce cooldown ne retarde jamais un événement d'une
            // fenêtre différente.
            if (!allowAppointmentProduction(lastProducedByWindow, windowId, Date.now())) {
                console.warn(`[GATEWAY] appointmentFound ignoré — anti-rafale actif pour ${windowId} (windowId: ${windowId}, internetNumber: ${internetNumber}).`);
                return;
            }

            try {
                const eventTimestamp = Date.now();
                await producer.send({
                    topic: KAFKA_TOPIC,
                    messages: [{
                        key: windowId,
                        value: JSON.stringify({
                            type: 'appointmentFound',
                            internetNumber,
                            windowId,
                            timestamp: eventTimestamp,
                            // Identifiant stable de l'événement pour la dédup côté extension.
                            eventId: buildEventId(windowId, eventTimestamp),
                        }),
                    }],
                });
                console.log(`[GATEWAY] appointmentFound produit — windowId: ${windowId}, internetNumber: ${internetNumber}`);
            } catch (err) {
                console.error('[GATEWAY] Erreur Kafka produce :', err.message);
            }
            break;
        }

        // Notification email « RDV trouvé » → envoi via Gmail.
        case 'sendEmail': {
            if (!isValidSendEmail(parsed)) {
                console.warn('[GATEWAY] sendEmail invalide (champ non conforme), ignoré.');
                return;
            }
            await sendAppointmentEmail(parsed);
            break;
        }

        // Ping applicatif de keepalive envoyé par les extensions
        case 'ping':
            break;

        default:
            console.warn(`[GATEWAY] Type de message inconnu : ${parsed.type}`);
    }
}

wss.on('connection', (ws, req) => {
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    console.log(`[GATEWAY] Nouvelle connexion WS depuis ${clientIp}`);

    connectedClients.add(ws);
    ws.isAlive = true;
    ws.windowId = null; // renseigné lors du message "register"

    ws.on('pong', () => {
        ws.isAlive = true;
    });

    ws.on('message', (data) => {
        // Le traitement est délégué à une fonction async dont le rejet est
        // TOUJOURS capturé : sans cela, une exception inattendue remonterait en
        // rejet de promesse non géré (message perdu en silence, et arrêt du
        // processus selon la configuration de Node).
        handleClientMessage(ws, data).catch((err) => {
            console.error('[GATEWAY] Erreur de traitement d\'un message WS :', err.message);
        });
    });

    ws.on('close', async () => {
        console.log(`[GATEWAY] Connexion WS fermée depuis ${clientIp}`);
        connectedClients.delete(ws);
        // Fenêtre fermée → supprime son internet number du registre/topic
        if (ws.windowId) {
            await unregisterApplicant(ws.windowId);
        }
    });

    ws.on('error', (err) => {
        console.error('[GATEWAY] Erreur WS :', err.message);
        connectedClients.delete(ws);
    });

    // Confirme la connexion au client
    ws.send(JSON.stringify({ type: 'connected', instanceId: GATEWAY_INSTANCE_ID }));
});

// Ping périodique pour détecter les connexions mortes
const pingInterval = setInterval(() => {
    for (const ws of wss.clients) {
        if (!ws.isAlive) {
            console.log('[GATEWAY] Client WS inactif détecté, fermeture.');
            connectedClients.delete(ws);
            if (ws.windowId) {
                unregisterApplicant(ws.windowId);
            }
            ws.terminate();
            continue;
        }
        ws.isAlive = false;
        ws.ping();
    }
}, WS_PING_INTERVAL_MS);

wss.on('close', () => clearInterval(pingInterval));

// ======================== DÉMARRAGE PRINCIPAL ========================

async function start() {
    // Démarre HTTP+WS immédiatement : le healthcheck Docker peut répondre pendant
    // que Kafka finalise son initialisation (consumer group, topic interne, etc.).
    // Écoute sur WS_HOST (127.0.0.1 par défaut) : le port n'est PAS exposé au
    // réseau externe sauf configuration explicite (voir avertissement au démarrage).
    httpServer.listen(WS_PORT, WS_HOST, () => {
        console.log(`[GATEWAY] Serveur WebSocket en écoute sur ${WS_HOST}:${WS_PORT}`);
    });

    // Connexion du producteur Kafka
    await producer.connect();
    console.log('[GATEWAY] Producteur Kafka connecté.');

    // Création des topics si inexistants
    const admin = kafka.admin();
    await admin.connect();
    try {
        const existingTopics = await admin.listTopics();
        const topicsToCreate = [];

        if (!existingTopics.includes(KAFKA_TOPIC)) {
            topicsToCreate.push({ topic: KAFKA_TOPIC, numPartitions: 1, replicationFactor: 1 });
        }
        if (!existingTopics.includes(REGISTRY_TOPIC)) {
            topicsToCreate.push({
                topic: REGISTRY_TOPIC,
                numPartitions: 1,
                replicationFactor: 1,
                // Compaction : seule la dernière valeur par clé (windowId) est conservée
                configEntries: [{ name: 'cleanup.policy', value: 'compact' }],
            });
        }

        if (topicsToCreate.length > 0) {
            await admin.createTopics({ topics: topicsToCreate });
            console.log(`[GATEWAY] Topics créés : ${topicsToCreate.map(t => t.topic).join(', ')}`);
        } else {
            console.log('[GATEWAY] Topics déjà existants.');
        }
    } finally {
        await admin.disconnect();
    }

    // Connexion et abonnement du consommateur Kafka (événements RDV uniquement)
    await consumer.connect();
    await consumer.subscribe({ topic: KAFKA_TOPIC, fromBeginning: false });
    console.log(`[GATEWAY] Consommateur Kafka connecté (groupId: ${KAFKA_CONSUMER_GROUP_ID}).`);

    // Premier sondage après un court délai (laisse le temps de rejoindre le
    // groupe), puis PÉRIODIQUE — voir refreshConsumerGroupSize.
    setTimeout(refreshConsumerGroupSize, 5000);
    groupSizeInterval = setInterval(refreshConsumerGroupSize, GROUP_SIZE_CHECK_INTERVAL_MS);

    consumer.run({
        eachMessage: async ({ topic, partition, message }) => {
            // Mémorise la progression AVANT tout traitement : c'est cette borne qui
            // autorise la purge à supprimer ce message (voir purgeTopic). Le filtre
            // sur le topic garde la carte exploitable si un second abonnement est
            // ajouté un jour (les numéros de partition ne sont pas globaux).
            const offset = Number(message.offset);
            if (topic === KAFKA_TOPIC && Number.isFinite(offset)) {
                consumedOffsets.set(partition, offset);
            }

            let payload;
            try {
                payload = JSON.parse(message.value.toString());
            } catch {
                return;
            }
            console.log('[GATEWAY] Message consommé depuis Kafka :', JSON.stringify(payload));

            // 1. Diffuse IMMÉDIATEMENT à toutes les fenêtres abonnées, sans
            //    cooldown ni file d'attente (voir le commentaire du cas
            //    "appointmentFound" dans handleClientMessage).
            broadcastToAll(payload);

            // 2. Retient l'événement pour le rejouer aux fenêtres qui se
            //    (re)connectent dans les prochaines minutes (Problème : service
            //    worker MV3 suspendu → WebSocket coupée → broadcast manqué).
            if (payload && payload.type === 'appointmentFound') {
                lastAppointment = { payload, receivedAt: Date.now() };

                // Alerte email automatique du serveur : un RDV a été trouvé.
                // Inclut l'URL du serveur (IP:Port). N'interrompt jamais le flux.
                // Dédupliquée par eventId + anti-rafale par internetNumber pour
                // éviter une cascade d'emails lors d'un cycle multi-fenêtres.
                if (shouldSendAppointmentAlert(alertDedupState, payload, Date.now(), {
                    eventTtlMs: ALERT_EVENT_TTL_MS,
                    cooldownMs: ALERT_COOLDOWN_MS,
                })) {
                    sendAppointmentAlertEmail(payload);
                } else {
                    console.log(`[GATEWAY] Alerte RDV trouvé ignorée (doublon/rafale) — eventId: ${payload.eventId}, internetNumber: ${payload.internetNumber}`);
                }
            }

            // 3. Le topic est vidé PÉRIODIQUEMENT (purgeInterval), pas après
            //    chaque message — voir KAFKA_PURGE_INTERVAL_MS ci-dessus.
        },
    }).catch((err) => {
        console.error('[GATEWAY] Erreur consumer Kafka :', err);
    });
}

start().catch((err) => {
    console.error('[GATEWAY] Erreur fatale au démarrage :', err);
    process.exit(1);
});

// Filet global : une promesse rejetée sans gestionnaire ne doit jamais passer
// inaperçue ni décider seule de l'arrêt du processus.
process.on('unhandledRejection', (reason) => {
    console.error('[GATEWAY] Promesse rejetée sans gestionnaire :', reason instanceof Error ? reason.message : reason);
});

/** Délai (ms) au-delà duquel l'arrêt est forcé même si une déconnexion traîne. */
const SHUTDOWN_TIMEOUT_MS = 10000;

/** Empêche un second signal de relancer la séquence d'arrêt. */
let shuttingDown = false;

// Arrêt propre : on ferme d'abord les connexions entrantes, puis Kafka.
async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[GATEWAY] Arrêt en cours (${signal})...`);

    clearInterval(pingInterval);
    clearInterval(purgeInterval);
    if (groupSizeInterval) clearInterval(groupSizeInterval);

    // Garde-fou : si une déconnexion Kafka se bloque, on sort quand même — sans
    // cela le conteneur resterait suspendu jusqu'au SIGKILL de Docker.
    const forceExit = setTimeout(() => {
        console.warn('[GATEWAY] Arrêt forcé après expiration du délai.');
        process.exit(0);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    try {
        // Ferme les WebSockets avant Kafka : les clients sont prévenus (code 1001,
        // « going away ») au lieu d'être coupés brutalement, et plus aucun message
        // n'arrive pendant que le producteur et le consommateur se déconnectent.
        for (const client of wss.clients) {
            client.close(1001, 'Gateway shutting down');
        }
        await new Promise((resolve) => wss.close(resolve));
        await new Promise((resolve) => httpServer.close(resolve));
        await consumer.disconnect();
        await producer.disconnect();
        console.log('[GATEWAY] Arrêt terminé proprement.');
    } catch (err) {
        console.error('[GATEWAY] Erreur pendant l\'arrêt :', err.message);
    }

    process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
