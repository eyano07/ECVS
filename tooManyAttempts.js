/**
 * ==========================================================================
 * SCRIPT DE BY-PASS "TOO MANY ATTEMPTS" — Extension Chrome CEV_AVI
 * ==========================================================================
 *
 * Injecté automatiquement sur la page :
 *   https://visaonweb.diplomatie.be/Error/ErrorTooManyAttempts
 *
 * Cette page signale un blocage anti-spam du site (trop de tentatives).
 * Pour le by-passer, on demande au service worker d'effacer TOUTES les données
 * de navigation (voir clearAllBrowsingData dans background.js — un nettoyage
 * limité aux origines du portail laissait des résidus qui maintenaient le
 * blocage), puis on redirige vers la page des demandes de visa (IndexByUserId)
 * afin de reprendre l'automatisation. Les identifiants du popup, stockés dans
 * chrome.storage.local, ne sont jamais touchés.
 *
 * Le service worker plafonne le nombre d'effacements sur une fenêtre glissante
 * (voir MAX_CACHE_CLEARS_PER_WINDOW dans background.js). Une fois ce plafond
 * atteint, ce script n'insiste PAS : rediriger quand même relancerait aussitôt
 * une requête vers un portail déjà bloqué, et si le blocage est appliqué côté
 * serveur (IP), la page IndexByUserId retomberait immédiatement sur
 * ErrorTooManyAttempts — boucle à la fréquence du chargement de page. On
 * affiche à la place un badge de compte à rebours jusqu'à ce qu'une place se
 * libère dans la fenêtre glissante, puis on retente automatiquement.
 * ==========================================================================
 */
(() => {
    const INDEX_URL = 'https://visaonweb.diplomatie.be/fr-BE/VisaApplication/IndexByUserId';

    /** Identifiant de l'intervalle du badge de compte à rebours (évite les doublons). */
    let countdownIntervalId = null;

    /** Retire le badge de compte à rebours s'il est présent. */
    function removeThrottleBadge() {
        const el = document.getElementById('cev-avi-throttle-badge');
        if (el) el.remove();
        if (countdownIntervalId !== null) {
            clearInterval(countdownIntervalId);
            countdownIntervalId = null;
        }
    }

    /** Formate une durée en millisecondes au format m:ss. */
    function formatRemaining(ms) {
        const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${minutes}:${String(seconds).padStart(2, '0')}`;
    }

    /**
     * Affiche un badge non bloquant (pas d'alert/confirm) en bas à droite,
     * décomptant jusqu'à `retryAt`, puis relance automatiquement le nettoyage.
     * Cette page reste consultable pendant l'attente.
     *
     * @param {number} retryAt - Horodatage (ms) auquel une place se libère
     *        dans la fenêtre glissante de MAX_CACHE_CLEARS_PER_WINDOW.
     */
    function showThrottleBadgeAndRetry(retryAt) {
        removeThrottleBadge();

        const badge = document.createElement('div');
        badge.id = 'cev-avi-throttle-badge';
        Object.assign(badge.style, {
            position: 'fixed',
            bottom: '24px',
            right: '24px',
            zIndex: '2147483647',
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            padding: '14px 18px',
            borderRadius: '14px',
            background: '#fff',
            border: '1px solid rgba(15,23,42,0.12)',
            boxShadow: '0 14px 34px rgba(15,23,42,0.2)',
            font: '600 14px/1.4 Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif',
            color: '#0f172a',
        });

        const label = document.createElement('span');
        label.textContent = 'Trop d\'effacements récents — nouvel essai dans';

        const time = document.createElement('span');
        Object.assign(time.style, { fontVariantNumeric: 'tabular-nums', fontWeight: '800' });

        badge.appendChild(label);
        badge.appendChild(time);
        (document.body || document.documentElement).appendChild(badge);

        function tick() {
            const remaining = retryAt - Date.now();
            if (remaining <= 0) {
                removeThrottleBadge();
                console.log('[CEV_AVI] Fenêtre glissante d\'effacements expirée — nouvelle tentative.');
                attemptCleanupAndRedirect();
                return;
            }
            time.textContent = formatRemaining(remaining);
        }
        tick();
        countdownIntervalId = setInterval(tick, 1000);
    }

    /**
     * Demande l'effacement au service worker, puis redirige — sauf en cas de
     * refus par plafond (rateLimited), où l'on affiche le badge d'attente au
     * lieu d'insister immédiatement.
     */
    function attemptCleanupAndRedirect() {
        console.warn('[CEV_AVI] Page "Too Many Attempts" détectée — nettoyage des données du portail puis redirection.');

        chrome.runtime.sendMessage({ action: 'clearBrowserCache' }, (response) => {
            if (chrome.runtime.lastError) {
                console.warn('[CEV_AVI] Nettoyage impossible via le service worker :', chrome.runtime.lastError.message);
                window.location.href = INDEX_URL;
                return;
            }

            if (response && response.rateLimited) {
                console.error('[CEV_AVI] Plafond d\'effacements atteint — reprise automatique différée pour ne pas marteler un portail déjà bloqué.');
                showThrottleBadgeAndRetry(response.retryAt || (Date.now() + 60000));
                return;
            }

            if (response && response.ok) {
                console.log('[CEV_AVI] Données de navigation effacées — redirection vers IndexByUserId.');
            } else {
                console.warn('[CEV_AVI] Le nettoyage a échoué côté service worker — tentative de reprise quand même.');
            }
            window.location.href = INDEX_URL;
        });
    }

    attemptCleanupAndRedirect();
})();
