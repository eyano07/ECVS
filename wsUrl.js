/**
 * ==========================================================================
 * CONSTRUCTION DE L'URL WEBSOCKET AUTHENTIFIÉE — Extension Chrome CEV_AVI
 * ==========================================================================
 * Partagé par background.js (importScripts) et popup.html (balise script) :
 * les deux ouvrent une WebSocket vers la passerelle et doivent y joindre le
 * jeton de la même façon.
 * ==========================================================================
 */

/**
 * Ajoute le jeton d'authentification (le mot de passe saisi dans le popup,
 * voir gatewayPassword dans popup.js/background.js) à l'URL de la passerelle,
 * sous forme de paramètre de requête `token`.
 *
 * Le paramètre d'URL est la seule option disponible : l'API WebSocket des
 * navigateurs n'autorise pas d'en-tête personnalisé. Le jeton est donc
 * susceptible d'apparaître dans les journaux d'accès d'un éventuel proxy — une
 * raison de plus de servir la passerelle en `wss://` derrière TLS.
 *
 * @param {string} baseUrl - URL de la passerelle (ex: "ws://1.2.3.4:8787").
 * @param {string} [token] - Mot de passe/jeton attendu côté passerelle (GATEWAY_AUTH_TOKEN).
 * @returns {string} URL avec le jeton ajouté, ou l'URL d'origine si pas de jeton.
 */
function buildAuthenticatedWsUrl(baseUrl, token) {
    if (!token) return baseUrl;
    try {
        const url = new URL(baseUrl);
        url.searchParams.set('token', token);
        return url.toString();
    } catch {
        const sep = baseUrl.includes('?') ? '&' : '?';
        return `${baseUrl}${sep}token=${encodeURIComponent(token)}`;
    }
}
