/**
 * ==========================================================================
 * POPUP SCRIPT — Extension Chrome CEV_AVI
 * ==========================================================================
 * Gère l'interface de configuration du popup :
 *  - Affichage du windowId (UUID unique par profil Chrome)
 *  - Saisie et sauvegarde de l'URL de la passerelle WebSocket
 *  - Saisie du mot de passe requis pour s'y connecter (sert de jeton
 *    d'authentification WebSocket, voir buildAuthenticatedWsUrl dans wsUrl.js)
 *  - Signal de connexion WebSocket (via message au background)
 * ==========================================================================
 */

const isMainWindowInput    = document.getElementById('isMainWindow');
const gatewayUrlInput      = document.getElementById('gatewayUrl');
const gatewayPasswordInput = document.getElementById('gatewayPassword');
const windowIdEl           = document.getElementById('windowId');
const statusDot            = document.getElementById('statusDot');
const statusText           = document.getElementById('statusText');
const btnSave              = document.getElementById('btnSave');
const btnTest              = document.getElementById('btnTest');
const btnCopyUrl           = document.getElementById('btnCopyUrl');
const btnDisconnect        = document.getElementById('btnDisconnect');
const toast                = document.getElementById('toast');
const loginUsernameInput   = document.getElementById('loginUsername');
const loginPasswordInput   = document.getElementById('loginPassword');
const btnSaveLogin         = document.getElementById('btnSaveLogin');
const tabButtons           = document.querySelectorAll('.tab');

/** Dernier statut connu, pour décider de l'action du bouton (déconnecter/reconnecter). */
let currentStatus = 'disconnected';

// ======================== ONGLETS ========================

/** Affiche le panneau demandé et met à jour l'onglet actif. */
function activateTab(panelId) {
    tabButtons.forEach((btn) => {
        const isActive = btn.dataset.panel === panelId;
        btn.classList.toggle('active', isActive);
        document.getElementById(btn.dataset.panel).hidden = !isActive;
    });
}

tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => activateTab(btn.dataset.panel));
});

/** Affiche un toast temporaire */
function showToast(message, type = 'success') {
    toast.textContent = message;
    toast.className = `toast ${type}`;
    toast.style.display = 'block';
    setTimeout(() => { toast.style.display = 'none'; }, 2500);
}

/**
 * Copie une valeur dans le presse-papiers et affiche un retour visuel.
 * @param {string} value - Texte à copier.
 * @param {string} emptyMessage - Message si la valeur est vide.
 * @param {string} successMessage - Message après copie réussie.
 */
async function copyToClipboard(value, emptyMessage, successMessage) {
    const text = (value || '').trim();
    if (!text) {
        showToast(emptyMessage, 'error');
        return;
    }

    try {
        await navigator.clipboard.writeText(text);
        showToast(successMessage);
    } catch {
        // Secours si l'API Clipboard est indisponible dans le popup.
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        try {
            document.execCommand('copy');
            showToast(successMessage);
        } catch {
            showToast('Impossible de copier.', 'error');
        }
        document.body.removeChild(ta);
    }
}

/**
 * Met à jour le signal de connexion affiché dans l'en-tête.
 * @param {'connected'|'connecting'|'disconnected'} status
 */
function updateStatusUI(status) {
    currentStatus = status;
    statusDot.className = 'status-indicator';
    switch (status) {
        case 'connected':
            statusDot.classList.add('connected');
            statusText.textContent = 'Connecté';
            break;
        case 'connecting':
            statusDot.classList.add('connecting');
            statusText.textContent = 'Connexion...';
            break;
        default:
            statusDot.classList.add('disconnected');
            statusText.textContent = 'Déconnecté';
    }

    // Le bouton bascule selon l'état : déconnecter si connecté, reconnecter sinon.
    if (status === 'disconnected') {
        btnDisconnect.textContent = 'Reconnecter';
        btnDisconnect.classList.add('reconnect');
    } else {
        btnDisconnect.textContent = 'Déconnecter';
        btnDisconnect.classList.remove('reconnect');
    }
}

// Charge les valeurs sauvegardées et le statut au démarrage.
// Priorité : brouillon (draft*) → valeur active → vide.
// Les brouillons permettent de conserver la saisie si le popup se ferme
// avant que l'utilisateur ait cliqué sur Validé — SAUF pour le mot de passe
// du portail (voir draftLoginPassword plus bas).
chrome.storage.local.get(
    ['windowId', 'internetNumber', 'isMainWindow', 'gatewayUrl', 'gatewayPassword', 'wsStatus',
     'draftGatewayUrl',
     'loginUsername', 'loginPassword', 'draftLoginUsername', 'draftLoginPassword'],
    (data) => {
        // Purge d'un éventuel brouillon de mot de passe écrit par une version
        // antérieure de l'extension (voir draftLoginPassword plus bas) : ce
        // secret ne doit pas rester en clair sur le disque plus longtemps que
        // nécessaire.
        if (data.draftLoginPassword !== undefined) {
            chrome.storage.local.remove('draftLoginPassword');
        }

        if (data.windowId) {
            windowIdEl.textContent = data.windowId;
        } else {
            windowIdEl.textContent = 'Non généré (rechargez l\'extension)';
        }

        // Repli sur l'ancienne convention (fenêtre principale = sans numéro
        // internet) tant que la case n'a jamais été touchée, pour ne pas casser
        // les installations existantes lors de la mise à jour.
        const inferredIsMainWindow = !(data.internetNumber || '').trim();
        isMainWindowInput.checked = typeof data.isMainWindow === 'boolean'
            ? data.isMainWindow
            : inferredIsMainWindow;

        // FIGE le rôle déduit dès la première ouverture du popup. Tant que la
        // clé restait absente, c'est le repli qui tranchait À CHAQUE lecture,
        // dans client.js comme ici — le rôle basculait donc tout seul dès qu'un
        // numéro internet était saisi sur la fenêtre principale : elle devenait
        // silencieusement une « fenêtre fille » et cessait de prévenir les
        // autres, sans que rien ne le signale. En persistant la valeur, le rôle
        // ne change plus que sur action explicite de l'utilisateur (case cochée
        // ou décochée), et la case affichée correspond toujours au comportement
        // réel.
        if (typeof data.isMainWindow !== 'boolean') {
            chrome.storage.local.set({ isMainWindow: inferredIsMainWindow });
        }

        gatewayUrlInput.value     = data.draftGatewayUrl     ?? data.gatewayUrl     ?? '';
        // Pas de brouillon pour ce mot de passe non plus, même raison que pour
        // celui du portail juste en dessous : seule la valeur déjà VALIDÉE est restituée.
        gatewayPasswordInput.value = data.gatewayPassword ?? '';
        loginUsernameInput.value  = data.draftLoginUsername   ?? data.loginUsername  ?? '';
        // Pas de brouillon pour le mot de passe (voir draftLoginPassword plus bas) :
        // seule la valeur déjà VALIDÉE est restituée.
        loginPasswordInput.value  = data.loginPassword ?? '';

        updateStatusUI(data.wsStatus || 'disconnected');
    }
);

// Le rôle de la fenêtre est enregistré IMMÉDIATEMENT, sans passer par le
// brouillon ni par le bouton « Validé » : une case cochée mais non validée
// donnerait une fenêtre principale qui ne notifie personne — précisément la
// panne silencieuse que ce réglage explicite doit éliminer.
isMainWindowInput.addEventListener('change', () => {
    chrome.storage.local.set({ isMainWindow: isMainWindowInput.checked }, () => {
        showToast(isMainWindowInput.checked
            ? 'Cette fenêtre est la fenêtre principale.'
            : 'Cette fenêtre est une fenêtre fille.');
    });
});

gatewayUrlInput.addEventListener('input', () => {
    chrome.storage.local.set({ draftGatewayUrl: gatewayUrlInput.value });
});

loginUsernameInput.addEventListener('input', () => {
    chrome.storage.local.set({ draftLoginUsername: loginUsernameInput.value });
});

// PAS de brouillon pour le mot de passe : contrairement aux autres champs,
// chrome.storage.local n'est pas chiffré (LevelDB en clair dans le profil
// Chrome). Persister le mot de passe du portail à CHAQUE frappe l'écrirait sur
// le disque bien avant toute validation, pour un gain (survivre à une
// fermeture accidentelle du popup) qui ne justifie pas ce risque sur le seul
// secret de ce système qui appartienne à l'utilisateur plutôt qu'à
// l'infrastructure. La valeur reste en mémoire dans le champ jusqu'au clic sur
// « Enregistrer » (btnSaveLogin) ; fermer le popup avant ce clic la perd, ce
// qui est le compromis voulu.

// Demande le statut en temps réel au background
chrome.runtime.sendMessage({ action: 'getWsStatus' }, (response) => {
    if (chrome.runtime.lastError) return;
    if (response && response.status) {
        updateStatusUI(response.status);
    }
});

// Met à jour le signal EN DIRECT lorsque le background change `wsStatus`
// dans le storage (ex: après reconnexion suite à une validation).
chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes.wsStatus) {
        updateStatusUI(changes.wsStatus.newValue || 'disconnected');
    }
});

// Copie l'URL du serveur dans le presse-papiers.
btnCopyUrl.addEventListener('click', () => {
    copyToClipboard(
        gatewayUrlInput.value,
        'Aucune URL à copier.',
        'URL copiée !',
    );
});

// Bouton déconnexion / reconnexion manuelle de la WebSocket
btnDisconnect.addEventListener('click', () => {
    if (currentStatus === 'disconnected') {
        // Reconnexion : lève le drapeau de déconnexion manuelle et reconnecte.
        updateStatusUI('connecting');
        chrome.runtime.sendMessage({ action: 'reconnectWs' }, () => {
            if (chrome.runtime.lastError) { /* service worker en veille, normal */ }
        });
        showToast('Reconnexion...');
    } else {
        // Déconnexion manuelle : coupe la WebSocket et stoppe la reconnexion auto.
        updateStatusUI('disconnected');
        chrome.runtime.sendMessage({ action: 'disconnectWs' }, () => {
            if (chrome.runtime.lastError) { /* service worker en veille, normal */ }
        });
        showToast('Déconnecté du serveur.');
    }
});

// Teste la connexion WebSocket à l'URL/mot de passe saisis sans les sauvegarder
// (buildAuthenticatedWsUrl vient de wsUrl.js, partagé avec background.js).
btnTest.addEventListener('click', () => {
    const url = gatewayUrlInput.value.trim();
    const password = gatewayPasswordInput.value.trim();
    if (!url) {
        showToast('Saisissez d\'abord l\'URL du serveur.', 'error');
        return;
    }
    if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
        showToast('L\'URL doit commencer par ws:// ou wss://', 'error');
        return;
    }
    if (!password) {
        showToast('Saisissez d\'abord le mot de passe du serveur.', 'error');
        return;
    }

    btnTest.textContent = '...';
    btnTest.disabled = true;

    let testWs;
    let done = false; // garde-fou : un seul résultat traité (onopen/onerror/timeout)

    /** Finalise le test une seule fois : affiche le résultat et réinitialise le bouton. */
    function finishTest(message, type) {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        if (testWs) {
            try { testWs.close(); } catch { /* socket déjà fermée */ }
        }
        showToast(message, type);
        btnTest.textContent = 'Tester';
        btnTest.disabled = false;
    }

    const timeout = setTimeout(() => {
        finishTest('Délai dépassé — serveur inaccessible.', 'error');
    }, 5000);

    try {
        testWs = new WebSocket(buildAuthenticatedWsUrl(url, password));
        testWs.onopen = () => finishTest('Connexion réussie !', 'success');
        testWs.onerror = () => finishTest('Connexion échouée — vérifiez l\'URL et le mot de passe.', 'error');
    } catch {
        finishTest('URL invalide.', 'error');
    }
});

// Valide la configuration. L'extension ne peut se connecter à la passerelle
// (et donc fonctionner) sans URL ET mot de passe : voir isValidAuthToken
// côté serveur (server/gateway/logic.js), qui rejette toute connexion dont
// le jeton (ce mot de passe) ne correspond pas à GATEWAY_AUTH_TOKEN.
btnSave.addEventListener('click', () => {
    const gatewayUrl = gatewayUrlInput.value.trim();
    const gatewayPassword = gatewayPasswordInput.value.trim();

    if (!gatewayUrl) {
        showToast('Veuillez saisir l\'URL du serveur.', 'error');
        return;
    }

    if (!gatewayUrl.startsWith('ws://') && !gatewayUrl.startsWith('wss://')) {
        showToast('L\'URL doit commencer par ws:// ou wss://', 'error');
        return;
    }

    if (!gatewayPassword) {
        showToast('Veuillez saisir le mot de passe du serveur.', 'error');
        return;
    }

    // Sauvegarde les valeurs actives et supprime le brouillon devenu inutile
    chrome.storage.local.set({ gatewayUrl, gatewayPassword }, () => {
        chrome.storage.local.remove(['draftGatewayUrl']);

        // Retour visuel immédiat : la reconnexion démarre. L'écouteur
        // storage.onChanged basculera ensuite sur « Connecté » tout seul.
        updateStatusUI('connecting');

        // Demande au background de se reconnecter avec la nouvelle URL
        chrome.runtime.sendMessage({ action: 'reconnectWs' }, () => {
            if (chrome.runtime.lastError) {
                // Le service worker peut être suspendu, c'est normal
            }
        });
        showToast('Configuration enregistrée !');
    });
});

// Enregistre les identifiants du portail utilisés par autoLogin.js pour remplir
// et valider automatiquement la page de connexion.
//
// Les deux champs sont OPTIONNELS : les laisser vides désactive simplement la
// connexion automatique (autoLogin.js ne fait alors rien). Enregistrer remet
// aussi à zéro le compteur anti-boucle, pour qu'une correction de mot de passe
// après plusieurs échecs reprenne immédiatement.
btnSaveLogin.addEventListener('click', () => {
    const loginUsername = loginUsernameInput.value.trim();
    const loginPassword = loginPasswordInput.value;

    if ((loginUsername && !loginPassword) || (!loginUsername && loginPassword)) {
        showToast('Renseignez l\'identifiant ET le mot de passe.', 'error');
        return;
    }

    chrome.storage.local.set({ loginUsername, loginPassword, loginAttempts: [] }, () => {
        chrome.storage.local.remove(['draftLoginUsername', 'draftLoginPassword']);
        showToast(loginUsername
            ? 'Identifiants enregistrés !'
            : 'Identifiants effacés — connexion automatique désactivée.');
    });
});
