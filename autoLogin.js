/**
 * ==========================================================================
 * AUTO-LOGIN VISAONWEB — Extension Chrome CEV_AVI
 * ==========================================================================
 *
 * Injecté sur les pages visaonweb.diplomatie.be. Détecte le formulaire de
 * connexion (#UserName + #Password + bouton de soumission) ; sur toute autre
 * page, le script s'arrête immédiatement.
 *
 * Les identifiants proviennent de l'onglet « Connexion » du popup, donc de
 * chrome.storage.local — isolé PAR PROFIL Chrome, ce qui permet à chaque
 * fenêtre coordonnée d'avoir son propre compte. Si aucun identifiant n'est
 * enregistré, le script ne fait rien.
 *
 * Le portail utilise ASP.NET MVC + validation jQuery « unobtrusive »
 * (data-val-required), et NON AngularJS : il suffit de renseigner les valeurs
 * puis de soumettre le formulaire normalement.
 *
 * POURQUOI L'EXTENSION SAISIT ELLE-MÊME LES VALEURS : quand Chrome auto-remplit
 * les identifiants, il en affiche un APERÇU mais ne les rend PAS lisibles par
 * JavaScript avant une interaction réelle de l'utilisateur (protection anti-vol
 * d'identifiants du navigateur). Un simple clic sur « Se connecter » soumettrait
 * donc des champs vides, d'où l'erreur « est un champ obligatoire ».
 * ==========================================================================
 */
(() => {
    /** Fenêtre glissante (ms) du garde-fou anti-boucle de connexion. */
    const ATTEMPT_WINDOW_MS = 60000;

    /**
     * Nombre max de soumissions automatiques dans la fenêtre ci-dessus.
     * Garde-fou ESSENTIEL : avec un mot de passe erroné, le site renvoie sur la
     * page de connexion, l'extension resoumettrait aussitôt, en boucle — ce qui
     * déclencherait le blocage « Too Many Attempts » du portail.
     */
    const MAX_ATTEMPTS = 2;

    /** Page des demandes : sa présence prouve que la connexion a réussi. */
    const isLoggedInPage = window.location.pathname.includes('VisaApplication/IndexByUserId');

    if (isLoggedInPage) {
        // Connexion réussie → le compteur d'échecs n'a plus de raison d'être.
        chrome.storage.local.remove('loginAttempts');
        return;
    }

    function findUsernameField() {
        return document.querySelector(
            '#UserName, input[name="UserName" i], input[type="email"], ' +
            'input[name*="user" i], input[name*="mail" i], input[autocomplete~="username"]'
        );
    }

    function findPasswordField() {
        return document.querySelector('#Password, input[type="password"], input[name="Password" i]');
    }

    /** Cherche le bouton de soumission (« Se connecter »). */
    function findLoginButton(form) {
        const scope = form || document;
        const submit = scope.querySelector('input[type="submit"], button[type="submit"]');
        if (submit) return submit;

        const candidates = Array.from(scope.querySelectorAll('button, input[type="button"], a, [role="button"]'));
        return candidates.find((el) => {
            const t = (el.textContent || el.value || '').trim().toLowerCase();
            return t.includes('se connecter') || t === 'login' || t === 'log in';
        });
    }

    const username = findUsernameField();
    const password = findPasswordField();
    if (!username || !password) return;

    const form = username.closest('form') || password.closest('form');
    const button = findLoginButton(form);
    if (!form && !button) return;

    /** Renseigne un champ et notifie la page (validation jQuery, etc.). */
    function setFieldValue(el, value) {
        el.focus();
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
    }

    /** Soumet le formulaire : clic sur le bouton, avec repli sur requestSubmit(). */
    function submitForm() {
        const hrefBefore = window.location.href;

        if (button) {
            const opts = { bubbles: true, cancelable: true, view: window };
            button.dispatchEvent(new MouseEvent('mousedown', opts));
            button.dispatchEvent(new MouseEvent('mouseup', opts));
            button.dispatchEvent(new MouseEvent('click', opts));
            button.click();
            console.log('[CEV_AVI/autoLogin] Clic sur le bouton de connexion.');
        }

        // Repli : si la page n'a pas navigué, soumission directe du formulaire
        // (requestSubmit conserve la validation et le jeton anti-CSRF du form).
        setTimeout(() => {
            if (window.location.href !== hrefBefore || !form) return;
            try {
                if (typeof form.requestSubmit === 'function') {
                    form.requestSubmit(button && button.type === 'submit' ? button : undefined);
                } else {
                    form.submit();
                }
                console.log('[CEV_AVI/autoLogin] Repli : soumission directe du formulaire.');
            } catch (e) {
                console.warn('[CEV_AVI/autoLogin] Soumission du formulaire échouée :', e);
            }
        }, 900);
    }

    chrome.storage.local.get(['loginUsername', 'loginPassword', 'loginAttempts'], (data) => {
        if (!data.loginUsername || !data.loginPassword) {
            console.log('[CEV_AVI/autoLogin] Aucun identifiant enregistré dans le popup (onglet « Connexion ») — aucune action.');
            return;
        }

        // Garde-fou anti-boucle : ne retient que les tentatives récentes.
        const now = Date.now();
        const recentAttempts = (Array.isArray(data.loginAttempts) ? data.loginAttempts : [])
            .filter((ts) => now - ts < ATTEMPT_WINDOW_MS);

        if (recentAttempts.length >= MAX_ATTEMPTS) {
            console.warn(`[CEV_AVI/autoLogin] ⚠️ ${recentAttempts.length} tentatives de connexion en moins de ${ATTEMPT_WINDOW_MS / 1000}s — soumission automatique suspendue pour éviter le blocage « Too Many Attempts ». Vérifiez les identifiants dans le popup (les réenregistrer remet le compteur à zéro).`);
            return;
        }

        recentAttempts.push(now);
        chrome.storage.local.set({ loginAttempts: recentAttempts }, () => {
            setFieldValue(username, data.loginUsername);
            setFieldValue(password, data.loginPassword);
            console.log(`[CEV_AVI/autoLogin] Identifiants du popup saisis (tentative ${recentAttempts.length}/${MAX_ATTEMPTS}) — soumission.`);
            setTimeout(submitForm, 150);
        });
    });
})();
