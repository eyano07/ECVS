/**
 * ==========================================================================
 * SCRIPT DE REDIRECTION AUTOMATIQUE — Extension Chrome CEV_AVI
 * ==========================================================================
 * 
 * Ce content script est injecté automatiquement sur les pages suivantes :
 *   - https://appointment.cloud.diplomatie.be/Integration/Error/MultiSessionNotAllowed
 *   - https://visaonweb.diplomatie.be/fr-BE
 *   - https://visaonweb.diplomatie.be/en
 * 
 * Ces pages sont des pages intermédiaires (erreur de session multiple,
 * page d'accueil FR ou EN) qui ne sont pas utiles pour l'automatisation.
 * 
 * Solution automatique :
 *  Redirige l'utilisateur vers la page de ses demandes de visa :
 *   https://visaonweb.diplomatie.be/fr-BE/VisaApplication/IndexByUserId
 *
 * CAS PARTICULIER : si la page MultiSessionNotAllowed apparaît juste après
 * une prise de RDV (marqueur bookingCaptchaPending récent), cela signifie que
 * le site a REJETÉ la session du captcha de booking. On NE redirige PAS tout
 * de suite : on garde la page visible et on logue l'incident, pour que le
 * problème soit diagnosticable au lieu d'être masqué par une redirection.
 * ==========================================================================
 */
(() => {
    const INDEX_URL = 'https://visaonweb.diplomatie.be/fr-BE/VisaApplication/IndexByUserId';
    const isMultiSessionPage = window.location.pathname.includes('MultiSessionNotAllowed');

    /** Fenêtre (ms) pendant laquelle un marqueur de captcha de booking est jugé récent. */
    const BOOKING_MARKER_MAX_AGE_MS = 120000;

    function redirect() {
        console.log('[CEV_AVI] Page intermédiaire — redirection vers IndexByUserId.');
        window.location.href = INDEX_URL;
    }

    /**
     * La page d'accueil /fr-BE sert AUSSI de page de connexion quand la session
     * a expiré. Rediriger dans ce cas serait contre-productif : autoLogin.js
     * n'aurait pas le temps de remplir le formulaire, et IndexByUserId
     * renverrait aussitôt vers la connexion — une boucle de redirections.
     */
    function hasLoginForm() {
        const user = document.querySelector('#UserName, input[name="UserName" i]');
        const pass = document.querySelector('#Password, input[type="password"]');
        return Boolean(user && pass);
    }

    if (!isMultiSessionPage) {
        if (hasLoginForm()) {
            console.log('[CEV_AVI] Formulaire de connexion détecté — pas de redirection, autoLogin.js prend le relais.');
            return;
        }
        redirect();
        return;
    }

    // Page MultiSessionNotAllowed : vérifie si elle fait suite à une prise de RDV.
    chrome.storage.local.get('bookingCaptchaPending', (data) => {
        const ts = data.bookingCaptchaPending || 0;
        const isAfterBooking = ts && (Date.now() - ts) < BOOKING_MARKER_MAX_AGE_MS;

        if (isAfterBooking) {
            // Le site a rejeté la session du captcha de prise de RDV. PAS de
            // reprise automatique : fermer l'onglet puis re-cliquer le calendrier
            // créait une boucle qui déclenchait le blocage « 60 minutes » du
            // site. On journalise, l'utilisateur décide de la suite.
            console.error('[CEV_AVI] ⚠️ MultiSessionNotAllowed PENDANT une prise de RDV : le site a rejeté la session du captcha. Aucune reprise automatique — intervention manuelle requise.');
        } else {
            redirect();
        }
    });
})();
