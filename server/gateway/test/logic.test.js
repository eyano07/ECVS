/**
 * ==========================================================================
 * TESTS UNITAIRES — Logique pure de la passerelle CEV_AVI
 * ==========================================================================
 * Utilise le runner intégré de Node 20 (node:test), sans dépendance externe.
 * Lancement : npm test  (ou : node --test)
 * ==========================================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    WS_OPEN,
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
    LOGIN_URL,
    hasControlCharacter,
    sanitizeEmailField,
    EMAIL_FIELD_MAX_LENGTH,
} = require('../logic');

// ---------------------------------------------------------------- parseMessage
test('parseMessage : parse un objet JSON valide', () => {
    assert.deepEqual(parseMessage('{"type":"register"}'), { type: 'register' });
});

test('parseMessage : accepte un Buffer', () => {
    assert.deepEqual(parseMessage(Buffer.from('{"a":1}')), { a: 1 });
});

test('parseMessage : retourne null sur JSON invalide', () => {
    assert.equal(parseMessage('pas du json'), null);
});

test('parseMessage : retourne null pour les non-objets JSON', () => {
    assert.equal(parseMessage('42'), null);
    assert.equal(parseMessage('"texte"'), null);
    assert.equal(parseMessage('null'), null);
});

// ---------------------------------------------------------------- buildEventId
test('buildEventId : combine windowId et timestamp', () => {
    assert.equal(buildEventId('win-123', 1700000000000), 'win-123:1700000000000');
});

// Valeurs de test réalistes (le format est désormais validé, pas seulement la présence).
const VALID_WINDOW_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const VALID_INTERNET_NUMBER = 'VOWINT6055154';

// ----------------------------------------------------------------- isValidWindowId
test('isValidWindowId : accepte un UUID v4 valide (avec espaces tolérés)', () => {
    assert.equal(isValidWindowId(VALID_WINDOW_ID), true);
    assert.equal(isValidWindowId(`  ${VALID_WINDOW_ID}  `), true);
    assert.equal(isValidWindowId(VALID_WINDOW_ID.toUpperCase()), true);
});

test('isValidWindowId : rejette un format non-UUID', () => {
    assert.equal(isValidWindowId('w'), false);
    assert.equal(isValidWindowId('win-123'), false);
    assert.equal(isValidWindowId('<script>alert(1)</script>'), false);
    assert.equal(isValidWindowId(''), false);
});

test('isValidWindowId : rejette les types non-string', () => {
    assert.equal(isValidWindowId(null), false);
    assert.equal(isValidWindowId(undefined), false);
    assert.equal(isValidWindowId(12345), false);
});

// ------------------------------------------------------------ isValidInternetNumber
test('isValidInternetNumber : accepte un format alphanumérique valide', () => {
    assert.equal(isValidInternetNumber(VALID_INTERNET_NUMBER), true);
    assert.equal(isValidInternetNumber(`  ${VALID_INTERNET_NUMBER}  `), true);
    assert.equal(isValidInternetNumber('ABC123'), true);
});

test('isValidInternetNumber : rejette une valeur trop courte, trop longue ou vide', () => {
    assert.equal(isValidInternetNumber(''), false);
    assert.equal(isValidInternetNumber('AB'), false);
    assert.equal(isValidInternetNumber('A'.repeat(41)), false);
});

test('isValidInternetNumber : rejette les caractères non-alphanumériques (anti-injection)', () => {
    assert.equal(isValidInternetNumber('<script>alert(1)</script>'), false);
    assert.equal(isValidInternetNumber('VOWINT 6055154'), false);
    assert.equal(isValidInternetNumber('VOWINT' + String.fromCharCode(10) + '6055154'), false);
    assert.equal(isValidInternetNumber('VOWINT;DROP TABLE'), false);
});

test('isValidInternetNumber : rejette les types non-string', () => {
    assert.equal(isValidInternetNumber(null), false);
    assert.equal(isValidInternetNumber(undefined), false);
    assert.equal(isValidInternetNumber(6055154), false);
});

// ------------------------------------------------------------- isValidRegister
test('isValidRegister : valide un message complet et bien formaté', () => {
    assert.equal(
        isValidRegister({ type: 'register', windowId: VALID_WINDOW_ID, internetNumber: VALID_INTERNET_NUMBER }),
        true,
    );
});

test('isValidRegister : rejette si windowId ou internetNumber manquant', () => {
    assert.equal(isValidRegister({ type: 'register', windowId: VALID_WINDOW_ID }), false);
    assert.equal(isValidRegister({ type: 'register', internetNumber: VALID_INTERNET_NUMBER }), false);
});

test('isValidRegister : rejette le mauvais type, null et undefined', () => {
    assert.equal(
        isValidRegister({ type: 'autre', windowId: VALID_WINDOW_ID, internetNumber: VALID_INTERNET_NUMBER }),
        false,
    );
    assert.equal(isValidRegister(null), false);
    assert.equal(isValidRegister(undefined), false);
});

test('isValidRegister : rejette un windowId ou internetNumber mal formé (pas seulement vide)', () => {
    assert.equal(isValidRegister({ type: 'register', windowId: 'pas-un-uuid', internetNumber: VALID_INTERNET_NUMBER }), false);
    assert.equal(isValidRegister({ type: 'register', windowId: VALID_WINDOW_ID, internetNumber: '<script>' }), false);
});

// ----------------------------------------------------- isValidAppointmentFound
test('isValidAppointmentFound : valide un message complet et bien formaté', () => {
    assert.equal(
        isValidAppointmentFound({ type: 'appointmentFound', windowId: VALID_WINDOW_ID, internetNumber: VALID_INTERNET_NUMBER }),
        true,
    );
});

test('isValidAppointmentFound : rejette les messages incomplets ou de mauvais type', () => {
    assert.equal(isValidAppointmentFound({ type: 'appointmentFound', windowId: VALID_WINDOW_ID }), false);
    assert.equal(
        isValidAppointmentFound({ type: 'register', windowId: VALID_WINDOW_ID, internetNumber: VALID_INTERNET_NUMBER }),
        false,
    );
    assert.equal(isValidAppointmentFound(null), false);
});

test('isValidAppointmentFound : rejette un windowId ou internetNumber mal formé', () => {
    assert.equal(
        isValidAppointmentFound({ type: 'appointmentFound', windowId: 'pas-un-uuid', internetNumber: VALID_INTERNET_NUMBER }),
        false,
    );
    assert.equal(
        isValidAppointmentFound({ type: 'appointmentFound', windowId: VALID_WINDOW_ID, internetNumber: 'a'.repeat(41) }),
        false,
    );
});

// ----------------------------------------------------------------- shouldReplay
const TTL = 3 * 60 * 1000;

test('shouldReplay : rejoue un événement récent venant d\'une autre fenêtre', () => {
    const last = { payload: { windowId: 'A', eventId: 'A:1' }, receivedAt: 1000 };
    assert.equal(shouldReplay(last, 'B', 1000 + 5000, TTL), true);
});

test('shouldReplay : ne rejoue pas à la fenêtre émettrice', () => {
    const last = { payload: { windowId: 'A' }, receivedAt: 1000 };
    assert.equal(shouldReplay(last, 'A', 1000 + 5000, TTL), false);
});

test('shouldReplay : ne rejoue pas un événement expiré (TTL dépassé)', () => {
    const last = { payload: { windowId: 'A' }, receivedAt: 1000 };
    assert.equal(shouldReplay(last, 'B', 1000 + TTL + 1, TTL), false);
});

test('shouldReplay : pas de rejeu sans dernier événement', () => {
    assert.equal(shouldReplay(null, 'B', 5000, TTL), false);
    assert.equal(shouldReplay({ receivedAt: 0 }, 'B', 5000, TTL), false);
});

// ---------------------------------------------------------------- applyRegister
test('applyRegister : ajoute une nouvelle entrée', () => {
    const registry = new Map();
    const res = applyRegister(registry, 'w1', '42');
    assert.equal(registry.get('w1'), '42');
    assert.deepEqual(res, { previous: undefined, changed: true });
});

test('applyRegister : remplace une valeur différente (changed=true)', () => {
    const registry = new Map([['w1', '42']]);
    const res = applyRegister(registry, 'w1', '99');
    assert.equal(registry.get('w1'), '99');
    assert.deepEqual(res, { previous: '42', changed: true });
});

test('applyRegister : même valeur → changed=false', () => {
    const registry = new Map([['w1', '42']]);
    const res = applyRegister(registry, 'w1', '42');
    assert.deepEqual(res, { previous: '42', changed: false });
});

// -------------------------------------------------------------- applyUnregister
test('applyUnregister : supprime une entrée existante', () => {
    const registry = new Map([['w1', '42']]);
    const res = applyUnregister(registry, 'w1');
    assert.equal(registry.has('w1'), false);
    assert.deepEqual(res, { removed: true, internetNumber: '42' });
});

test('applyUnregister : entrée inexistante → removed=false', () => {
    const registry = new Map();
    const res = applyUnregister(registry, 'inconnu');
    assert.deepEqual(res, { removed: false, internetNumber: undefined });
});

// -------------------------------------------------------------- countOpenClients
test('countOpenClients : ne compte que les clients OPEN', () => {
    const clients = [
        { readyState: WS_OPEN },
        { readyState: 0 /* CONNECTING */ },
        { readyState: WS_OPEN },
        { readyState: 3 /* CLOSED */ },
    ];
    assert.equal(countOpenClients(clients), 2);
});

test('countOpenClients : ensemble vide → 0', () => {
    assert.equal(countOpenClients([]), 0);
    assert.equal(countOpenClients(new Set()), 0);
});

// ------------------------------------------------------------------ hasControlCharacter
test('hasControlCharacter : détecte un caractère de contrôle', () => {
    assert.equal(hasControlCharacter('a' + String.fromCharCode(0) + 'b'), true);
    assert.equal(hasControlCharacter('a\r\nb'), true);
    assert.equal(hasControlCharacter('a' + String.fromCharCode(127) + 'b'), true);
});

test('hasControlCharacter : texte normal → false', () => {
    assert.equal(hasControlCharacter('GLADY NKOSI'), false);
    assert.equal(hasControlCharacter(''), false);
});

// --------------------------------------------------------- buildAppointmentEmail
test('buildAppointmentEmail : inclut toutes les infos fournies', () => {
    const { subject, text } = buildAppointmentEmail({
        applicantName: 'MAYAMBA NKOSI GLADY',
        appointmentDate: '11/05/2026 à 10:20',
        bookedAt: 'vendredi 3 avril 2026 à 09:44:53',
        bookedBy: 'agent@example.com',
    });
    assert.match(subject, /MAYAMBA NKOSI GLADY/);
    assert.match(text, /Candidat : MAYAMBA NKOSI GLADY/);
    assert.match(text, /Date du rendez-vous : 11\/05\/2026 à 10:20/);
    assert.match(text, /Réservation effectuée le : vendredi 3 avril 2026 à 09:44:53/);
    assert.match(text, /Rendez-vous pris par : agent@example.com/);
    assert.ok(text.includes(LOGIN_URL));
});

test('buildAppointmentEmail : valeurs par défaut si données manquantes', () => {
    const { subject, text } = buildAppointmentEmail({});
    assert.match(subject, /Demandeur/);
    assert.match(text, /Candidat : Demandeur/);
    assert.match(text, /Date du rendez-vous : à confirmer sur le site/);
    assert.match(text, /Rendez-vous pris par : -/);
});

test('buildAppointmentEmail : tolère un argument null', () => {
    const { subject, text } = buildAppointmentEmail(null);
    assert.ok(subject.length > 0);
    assert.ok(text.includes(LOGIN_URL));
});

test('buildAppointmentEmail : neutralise un saut de ligne injecté dans le sujet', () => {
    // Un retour chariot dans le sujet permettrait d'ajouter des en-têtes SMTP
    // (Bcc, From falsifié) : il doit être remplacé, pas transmis tel quel.
    const injected = 'GLADY' + String.fromCharCode(13) + String.fromCharCode(10) + 'Bcc: pirate@example.com';
    const { subject } = buildAppointmentEmail({ applicantName: injected });
    assert.ok(!subject.includes(String.fromCharCode(13)));
    assert.ok(!subject.includes(String.fromCharCode(10)));
    assert.match(subject, /Bcc: pirate@example.com/);
});

test('buildAppointmentEmail : borne la longueur des champs libres', () => {
    const { text } = buildAppointmentEmail({ applicantName: 'A'.repeat(500) });
    assert.ok(!text.includes('A'.repeat(EMAIL_FIELD_MAX_LENGTH + 1)));
});

// ------------------------------------------------------------ sanitizeEmailField
test('sanitizeEmailField : retire les caractères de contrôle et découpe', () => {
    assert.equal(sanitizeEmailField('  Nom' + String.fromCharCode(13) + String.fromCharCode(10) + 'Suite  '), 'Nom  Suite');
    assert.equal(sanitizeEmailField('a' + String.fromCharCode(0) + 'b'), 'a b');
    assert.equal(sanitizeEmailField('B'.repeat(300)).length, EMAIL_FIELD_MAX_LENGTH);
});

test('sanitizeEmailField : renvoie une chaîne vide pour une valeur non textuelle', () => {
    assert.equal(sanitizeEmailField(undefined), '');
    assert.equal(sanitizeEmailField(null), '');
    assert.equal(sanitizeEmailField(42), '');
    assert.equal(sanitizeEmailField({ toString: () => 'x' }), '');
});

// ------------------------------------------------------------- isValidSendEmail
test('isValidSendEmail : valide le bon type', () => {
    assert.equal(isValidSendEmail({ type: 'sendEmail' }), true);
    assert.equal(isValidSendEmail({ type: 'register' }), false);
    assert.equal(isValidSendEmail(null), false);
});

test('isValidSendEmail : accepte les champs libres absents ou nuls', () => {
    assert.equal(isValidSendEmail({ type: 'sendEmail', applicantName: undefined }), true);
    assert.equal(isValidSendEmail({ type: 'sendEmail', bookedBy: null }), true);
    assert.equal(isValidSendEmail({
        type: 'sendEmail',
        applicantName: 'GLADY NKOSI',
        appointmentDate: '11/05/2026 à 10:20',
        bookedAt: 'vendredi 3 avril 2026 à 09:44:53',
        bookedBy: 'agent@example.com',
    }), true);
});

test('isValidSendEmail : rejette un champ non textuel', () => {
    assert.equal(isValidSendEmail({ type: 'sendEmail', applicantName: {} }), false);
    assert.equal(isValidSendEmail({ type: 'sendEmail', bookedBy: 42 }), false);
    assert.equal(isValidSendEmail({ type: 'sendEmail', appointmentDate: ['x'] }), false);
});

test('isValidSendEmail : rejette une injection d\'en-tête email', () => {
    const injected = 'GLADY' + String.fromCharCode(13) + String.fromCharCode(10) + 'Bcc: pirate@example.com';
    assert.equal(isValidSendEmail({ type: 'sendEmail', applicantName: injected }), false);
    assert.equal(isValidSendEmail({ type: 'sendEmail', bookedBy: 'a' + String.fromCharCode(10) + 'b' }), false);
    assert.equal(isValidSendEmail({ type: 'sendEmail', bookedAt: 'a' + String.fromCharCode(0) + 'b' }), false);
});

test('isValidSendEmail : rejette un champ démesuré', () => {
    assert.equal(isValidSendEmail({
        type: 'sendEmail',
        applicantName: 'A'.repeat(EMAIL_FIELD_MAX_LENGTH + 1),
    }), false);
    assert.equal(isValidSendEmail({
        type: 'sendEmail',
        applicantName: 'A'.repeat(EMAIL_FIELD_MAX_LENGTH),
    }), true);
});

// --------------------------------------------------------------- pickServerHost
test('pickServerHost : privilégie l\'override explicite', () => {
    const interfaces = { eth0: [{ address: '10.0.0.5', family: 'IPv4', internal: false }] };
    assert.equal(pickServerHost(interfaces, '203.0.113.7'), '203.0.113.7');
    assert.equal(pickServerHost(interfaces, '  1.2.3.4  '), '1.2.3.4');
});

test('pickServerHost : retourne la 1re IPv4 non-interne détectée', () => {
    const interfaces = {
        lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
        eth0: [
            { address: '::1', family: 'IPv6', internal: false },
            { address: '192.168.1.42', family: 'IPv4', internal: false },
        ],
    };
    assert.equal(pickServerHost(interfaces, ''), '192.168.1.42');
});

test('pickServerHost : accepte family numérique (Node récent)', () => {
    const interfaces = { eth0: [{ address: '172.16.0.3', family: 4, internal: false }] };
    assert.equal(pickServerHost(interfaces, undefined), '172.16.0.3');
});

test('pickServerHost : localhost en dernier recours', () => {
    assert.equal(pickServerHost({}, ''), 'localhost');
    assert.equal(pickServerHost({ lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] }, ''), 'localhost');
    assert.equal(pickServerHost(null, ''), 'localhost');
});

// ---------------------------------------------------------------- buildServerUrl
test('buildServerUrl : format protocole://hôte:port', () => {
    assert.equal(buildServerUrl('192.168.1.42', 8787), 'ws://192.168.1.42:8787');
    assert.equal(buildServerUrl('example.com', '443', 'wss'), 'wss://example.com:443');
});

// --------------------------------------------------- buildAppointmentAlertEmail
test('buildAppointmentAlertEmail : inclut l\'URL du serveur (IP:Port)', () => {
    const { subject, text } = buildAppointmentAlertEmail({
        serverUrl: 'ws://192.168.1.42:8787',
        internetNumber: 'VOWINT6055154',
        windowId: 'win-abc',
        foundAt: '3 juillet 2026 à 15:31',
    });
    assert.match(subject, /ws:\/\/192\.168\.1\.42:8787/);
    assert.match(text, /URL du serveur \(IP:Port\) : ws:\/\/192\.168\.1\.42:8787/);
    assert.match(text, /Numéro internet : VOWINT6055154/);
    assert.match(text, /Fenêtre émettrice : win-abc/);
    assert.match(text, /Détecté le : 3 juillet 2026 à 15:31/);
    assert.ok(text.includes(LOGIN_URL));
});

test('buildAppointmentAlertEmail : valeurs par défaut si données manquantes', () => {
    const { subject, text } = buildAppointmentAlertEmail({});
    assert.match(subject, /serveur inconnu/);
    assert.match(text, /URL du serveur \(IP:Port\) : inconnu/);
    assert.match(text, /Numéro internet : -/);
});

test('buildAppointmentAlertEmail : tolère un argument null', () => {
    const { subject, text } = buildAppointmentAlertEmail(null);
    assert.ok(subject.length > 0);
    assert.ok(text.includes(LOGIN_URL));
});

// --------------------------------------------------------------- isAllowedOrigin
test('isAllowedOrigin : aucune restriction configurée → toujours autorisé', () => {
    assert.equal(isAllowedOrigin('https://evil.example', []), true);
    assert.equal(isAllowedOrigin('', undefined), true);
    assert.equal(isAllowedOrigin(null, null), true);
});

test('isAllowedOrigin : correspondance exacte', () => {
    const allowed = ['https://visaonweb.diplomatie.be'];
    assert.equal(isAllowedOrigin('https://visaonweb.diplomatie.be', allowed), true);
    assert.equal(isAllowedOrigin('https://evil.example', allowed), false);
});

test('isAllowedOrigin : préfixe avec joker "*" (extensions Chrome)', () => {
    const allowed = ['chrome-extension://*'];
    assert.equal(isAllowedOrigin('chrome-extension://abcdefghijklmnop', allowed), true);
    assert.equal(isAllowedOrigin('https://evil.example', allowed), false);
});

test('isAllowedOrigin : origin manquante avec liste configurée → refusé', () => {
    assert.equal(isAllowedOrigin('', ['https://visaonweb.diplomatie.be']), false);
    assert.equal(isAllowedOrigin(undefined, ['https://visaonweb.diplomatie.be']), false);
});

// -------------------------------------------------------------- extractAuthToken
test('extractAuthToken : lit le paramètre de requête "token"', () => {
    assert.equal(extractAuthToken('/?token=abc123'), 'abc123');
    assert.equal(extractAuthToken('/?foo=bar&token=xyz'), 'xyz');
});

test('extractAuthToken : privilégie l\'en-tête x-gateway-token', () => {
    assert.equal(extractAuthToken('/?token=fromUrl', { 'x-gateway-token': 'fromHeader' }), 'fromHeader');
});

test('extractAuthToken : tableau d\'en-têtes → prend le premier', () => {
    assert.equal(extractAuthToken('/', { 'x-gateway-token': ['first', 'second'] }), 'first');
});

test('extractAuthToken : rien trouvé → chaîne vide', () => {
    assert.equal(extractAuthToken('/', {}), '');
    assert.equal(extractAuthToken('', undefined), '');
    assert.equal(extractAuthToken(undefined, undefined), '');
});

// -------------------------------------------------------------- isValidAuthToken
test('isValidAuthToken : aucun jeton attendu → authentification désactivée (true)', () => {
    assert.equal(isValidAuthToken('', ''), true);
    assert.equal(isValidAuthToken('peu-importe', ''), true);
    assert.equal(isValidAuthToken(undefined, undefined), true);
});

test('isValidAuthToken : jeton attendu configuré → correspondance exacte requise', () => {
    assert.equal(isValidAuthToken('secret123', 'secret123'), true);
    assert.equal(isValidAuthToken('mauvais', 'secret123'), false);
    assert.equal(isValidAuthToken('', 'secret123'), false);
    assert.equal(isValidAuthToken(undefined, 'secret123'), false);
});

test('isValidAuthToken : robuste aux longueurs différentes', () => {
    assert.equal(isValidAuthToken('court', 'unTokenBienPlusLong'), false);
    assert.equal(isValidAuthToken('unTokenBienPlusLong', 'court'), false);
});

// ------------------------------------------------- shouldSendAppointmentAlert
function freshAlertState() {
    return { sentEvents: new Map(), lastSentByInternetNumber: new Map() };
}
const ALERT_OPTS = { eventTtlMs: 10 * 60 * 1000, cooldownMs: 5 * 60 * 1000 };

test('shouldSendAppointmentAlert : autorise le premier événement', () => {
    const state = freshAlertState();
    const ok = shouldSendAppointmentAlert(
        state, { eventId: 'w1:1000', internetNumber: 'VOWINT1' }, 1000, ALERT_OPTS,
    );
    assert.equal(ok, true);
});

test('shouldSendAppointmentAlert : bloque un doublon EXACT (même eventId)', () => {
    const state = freshAlertState();
    const event = { eventId: 'w1:1000', internetNumber: 'VOWINT1' };
    assert.equal(shouldSendAppointmentAlert(state, event, 1000, ALERT_OPTS), true);
    // Même eventId rejoué (ex: redélivrance Kafka) → ignoré.
    assert.equal(shouldSendAppointmentAlert(state, event, 1500, ALERT_OPTS), false);
});

test('shouldSendAppointmentAlert : bloque une rafale sur le même internetNumber (cooldown)', () => {
    const state = freshAlertState();
    assert.equal(
        shouldSendAppointmentAlert(state, { eventId: 'w1:1000', internetNumber: 'VOWINT1' }, 1000, ALERT_OPTS),
        true,
    );
    // eventId différent mais même internetNumber, dans la fenêtre de cooldown → ignoré.
    assert.equal(
        shouldSendAppointmentAlert(state, { eventId: 'w1:2000', internetNumber: 'VOWINT1' }, 2000, ALERT_OPTS),
        false,
    );
});

test('shouldSendAppointmentAlert : autorise après expiration du cooldown', () => {
    const state = freshAlertState();
    assert.equal(
        shouldSendAppointmentAlert(state, { eventId: 'w1:1000', internetNumber: 'VOWINT1' }, 1000, ALERT_OPTS),
        true,
    );
    const afterCooldown = 1000 + ALERT_OPTS.cooldownMs + 1;
    assert.equal(
        shouldSendAppointmentAlert(state, { eventId: 'w1:9999', internetNumber: 'VOWINT1' }, afterCooldown, ALERT_OPTS),
        true,
    );
});

test('shouldSendAppointmentAlert : des internetNumber différents ne se bloquent pas mutuellement', () => {
    const state = freshAlertState();
    assert.equal(
        shouldSendAppointmentAlert(state, { eventId: 'w1:1000', internetNumber: 'VOWINT1' }, 1000, ALERT_OPTS),
        true,
    );
    assert.equal(
        shouldSendAppointmentAlert(state, { eventId: 'w2:1001', internetNumber: 'VOWINT2' }, 1001, ALERT_OPTS),
        true,
    );
});

test('shouldSendAppointmentAlert : purge les eventId expirés (pas de croissance illimitée)', () => {
    const state = freshAlertState();
    shouldSendAppointmentAlert(state, { eventId: 'old', internetNumber: 'A' }, 0, ALERT_OPTS);
    assert.equal(state.sentEvents.has('old'), true);
    // Un nouvel appel bien après le TTL doit purger "old" de la map.
    shouldSendAppointmentAlert(state, { eventId: 'new', internetNumber: 'B' }, ALERT_OPTS.eventTtlMs + 1, ALERT_OPTS);
    assert.equal(state.sentEvents.has('old'), false);
});

test('shouldSendAppointmentAlert : tolère l\'absence d\'eventId ou d\'internetNumber', () => {
    const state = freshAlertState();
    assert.equal(shouldSendAppointmentAlert(state, {}, 1000, ALERT_OPTS), true);
    assert.equal(shouldSendAppointmentAlert(state, { internetNumber: 'X' }, 1000, ALERT_OPTS), true);
});

// -------------------------------------------------------- allowAppointmentProduction
const PRODUCE_COOLDOWN = 30 * 1000;

test('allowAppointmentProduction : autorise la première production d\'une fenêtre', () => {
    const state = new Map();
    assert.equal(allowAppointmentProduction(state, 'win-A', 1000, PRODUCE_COOLDOWN), true);
    assert.equal(state.get('win-A'), 1000);
});

test('allowAppointmentProduction : bloque une seconde production trop rapprochée de LA MÊME fenêtre', () => {
    const state = new Map();
    assert.equal(allowAppointmentProduction(state, 'win-A', 1000, PRODUCE_COOLDOWN), true);
    assert.equal(allowAppointmentProduction(state, 'win-A', 1000 + 5000, PRODUCE_COOLDOWN), false);
});

test('allowAppointmentProduction : autorise de nouveau une fois le cooldown écoulé', () => {
    const state = new Map();
    assert.equal(allowAppointmentProduction(state, 'win-A', 1000, PRODUCE_COOLDOWN), true);
    assert.equal(allowAppointmentProduction(state, 'win-A', 1000 + PRODUCE_COOLDOWN, PRODUCE_COOLDOWN), true);
});

test('allowAppointmentProduction : NE retarde JAMAIS une fenêtre différente', () => {
    const state = new Map();
    assert.equal(allowAppointmentProduction(state, 'win-A', 1000, PRODUCE_COOLDOWN), true);
    // win-A vient de produire ; win-B doit passer immédiatement, sans lien avec le cooldown de win-A.
    assert.equal(allowAppointmentProduction(state, 'win-B', 1001, PRODUCE_COOLDOWN), true);
});

test('allowAppointmentProduction : utilise le cooldown par défaut si non précisé', () => {
    const state = new Map();
    assert.equal(allowAppointmentProduction(state, 'win-A', 1000), true);
    assert.equal(allowAppointmentProduction(state, 'win-A', 1000 + APPOINTMENT_PRODUCE_COOLDOWN_MS - 1), false);
    assert.equal(allowAppointmentProduction(state, 'win-A', 1000 + APPOINTMENT_PRODUCE_COOLDOWN_MS), true);
});
