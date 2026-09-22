/**
 * ==========================================================================
 * PONT MONDE-PAGE (Content Script "MAIN world") — Extension Chrome CEV_AVI
 * ==========================================================================
 *
 * Ce script est injecté dans le CONTEXTE DE LA PAGE (world: "MAIN"), et non
 * dans le monde isolé des content scripts. Il a donc accès à `window.angular`
 * et peut déclencher les handlers AngularJS (ng-click) de façon fiable.
 *
 * Pourquoi : les pages IndexByUserId et Edit/<id> sont une application
 * AngularJS 1.x. Les boutons d'action sont des <button ng-click="..."> ; un clic
 * synthétique émis depuis le content script (monde isolé) n'est pas pris en
 * compte par AngularJS. Il faut appeler le handler dans le monde de la page.
 *
 * Communication : le content script (monde isolé) marque l'élément cible avec
 * l'attribut data-cev-avi-click="1" puis envoie un window.postMessage. Ce pont
 * reçoit le message et déclenche le ng-click dans le digest Angular.
 *
 * Deux pages l'utilisent :
 *   - IndexByUserId (applicationsPage.js) : clic sur le bouton d'ÉDITION de la
 *     ligne du demandeur, en dernier recours quand l'identifiant du dossier n'a
 *     pas pu être extrait du DOM (le chemin normal navigue directement vers
 *     /VisaApplication/Edit/<id>, sans clic).
 *   - Edit/<id> (editPage.js) : clic sur « Gérer votre rendez-vous », avec
 *     `intercept: true` — voir plus bas.
 * ==========================================================================
 */
(() => {
    /**
     * Durée (ms) pendant laquelle window.open reste intercepté après l'appel de
     * groupVA. Doit couvrir le POST /VisaApplication/ManageRdv, lent quand
     * plusieurs fenêtres sollicitent le portail en même temps : passé ce délai,
     * une réponse tardive produirait un window.open réel, bloqué par le
     * navigateur faute de geste utilisateur, et l'URL du RDV serait perdue.
     * Reste INFÉRIEURE au garde-fou d'applicationsPage.js pour que l'échec soit
     * signalé ici avant que le garde-fou n'expire.
     */
    const OPEN_INTERCEPT_WINDOW_MS = 10000;

    /**
     * Vrai `window.open` de la page, capturé AVANT toute interception : c'est
     * la seule référence sûre à restaurer (voir interceptOpenAndCall).
     */
    const nativeOpen = window.open;

    /** Génération de l'interception `window.open` en cours (0 = aucune). */
    let activeInterceptId = 0;

    /**
     * Exécute fn dans un cycle de digest Angular, sans provoquer l'erreur
     * "$apply already in progress" si un digest est déjà en cours.
     */
    function safeApply(scope, fn) {
        const root = scope.$root || scope;
        const phase = root.$$phase;
        if (phase === '$apply' || phase === '$digest') {
            fn();
        } else {
            scope.$apply(fn);
        }
    }

    /**
     * Analyse une expression ng-click d'appel de fonction et en extrait le nom
     * et les arguments (chaînes entre quotes). Gère un nombre VARIABLE d'arguments.
     *
     * Exemples gérés :
     *   groupVA('id','BEL','NA')          → { name: 'groupVA',    args: ['id','BEL','NA'] }
     *   groupVAEpp('id','NA')             → { name: 'groupVAEpp', args: ['id','NA'] }
     *
     * Robuste au renommage de la fonction côté site (le portail est passé de
     * groupVA(3 args) à groupVAEpp(2 args)).
     *
     * @param {string} expr - Expression ng-click.
     * @returns {{name: string, args: string[]}|null}
     */
    function parseNgClickCall(expr) {
        const head = expr && expr.match(/^\s*([A-Za-z_$][\w$]*)\s*\(([\s\S]*)\)\s*;?\s*$/);
        if (!head) return null;
        const name = head[1];
        const args = [];
        const argRe = /'([^']*)'|"([^"]*)"/g;
        let m;
        while ((m = argRe.exec(head[2])) !== null) {
            args.push(m[1] !== undefined ? m[1] : m[2]);
        }
        return { name, args };
    }

    /**
     * Reconnaît la fonction de prise de RDV quel que soit son suffixe :
     * groupVA, groupVAEpp, etc. (le site peut la renommer).
     *
     * @param {string} name - Nom de la fonction ng-click.
     * @returns {boolean}
     */
    function isBookingFunction(name) {
        return /^groupVA/i.test(name);
    }

    /**
     * Remonte la chaîne de scopes Angular pour trouver celui qui expose la
     * fonction `fnName` (ex: 'groupVAEpp').
     *
     * @param {object} scope - Scope de départ.
     * @param {string} fnName - Nom de la fonction recherchée.
     * @returns {object|null} Scope contenant la fonction.
     */
    function findScopeWithFunction(scope, fnName) {
        let current = scope;
        while (current) {
            if (typeof current[fnName] === 'function') {
                return current;
            }
            current = current.$parent;
        }
        return null;
    }

    /**
     * Vérifie après un délai si la page a navigué. Si ce n'est pas le cas,
     * lance un fallback. Cela permet d'enchaîner plusieurs stratégies sans
     * s'arrêter trop tôt sur une méthode qui logue mais ne navigue pas.
     */
    function afterNoNavigation(previousHref, delayMs, fallback) {
        setTimeout(() => {
            if (window.location.href === previousHref) {
                fallback();
            }
        }, delayMs);
    }

    /**
     * Déclenche tous les fallbacks de clic possibles dans le monde page.
     */
    function fireNativeAndJqueryClick(el) {
        try {
            if (window.angular && typeof window.angular.element === 'function') {
                const $el = window.angular.element(el);
                if (typeof $el.trigger === 'function') {
                    $el.trigger('click');
                    console.log('[CEV_AVI/pageBridge] Fallback angular.element(...).trigger(\"click\").');
                }
                if (typeof $el.triggerHandler === 'function') {
                    $el.triggerHandler('click');
                    console.log('[CEV_AVI/pageBridge] Fallback angular triggerHandler(\"click\").');
                }
            }

            if (window.jQuery) {
                window.jQuery(el).trigger('click');
                console.log('[CEV_AVI/pageBridge] Fallback jQuery(...).trigger(\"click\").');
            }

            const opts = { bubbles: true, cancelable: true, view: window };
            el.dispatchEvent(new MouseEvent('mouseover', opts));
            el.dispatchEvent(new MouseEvent('mousemove', opts));
            el.dispatchEvent(new MouseEvent('mousedown', opts));
            el.dispatchEvent(new MouseEvent('mouseup', opts));
            el.dispatchEvent(new MouseEvent('click', opts));
            el.click();
            console.log('[CEV_AVI/pageBridge] Fallback clic natif complet.');
        } catch (e) {
            console.warn('[CEV_AVI/pageBridge] Fallback clic échoué :', e);
        }
    }

    /**
     * Déclenche le handler d'un élément SANS installer d'interception : soit en
     * évaluant son expression ng-click dans le digest Angular (voie fiable pour
     * AngularJS), soit — à défaut d'expression, de scope ou d'injecteur — par un
     * clic natif complet.
     *
     * Utilisé par le mode « interception forcée » : l'appelant se charge
     * d'envelopper cet appel dans interceptOpenAndCall.
     *
     * @param {HTMLElement} el - Élément à déclencher.
     * @param {string|null} ngExpr - Expression ng-click de l'élément, si présente.
     */
    function dispatchClick(el, ngExpr) {
        if (ngExpr && window.angular && typeof window.angular.element === 'function') {
            const $el = window.angular.element(el);
            const scope = $el.scope && $el.scope();
            const injector = $el.injector && $el.injector();
            const $parse = injector && injector.get ? injector.get('$parse') : null;

            if (scope && $parse) {
                const $event = {
                    target: el,
                    currentTarget: el,
                    preventDefault() {},
                    stopPropagation() {},
                };
                safeApply(scope, () => $parse(ngExpr)(scope, { $event }));
                console.log(`[CEV_AVI/pageBridge] ng-click exécuté via $parse : ${ngExpr}`);
                return;
            }
        }

        // Bouton non-Angular (ou scope inaccessible) : clic natif complet. Le
        // bouton « Gérer votre rendez-vous » peut être un simple <a href> ou un
        // <button> lié par jQuery ; ce chemin les couvre tous.
        fireNativeAndJqueryClick(el);
    }

    /**
     * Signale au content script (monde isolé) que la prise de RDV n'a pas abouti,
     * afin qu'il relance un cycle complet (nouveau filtrage + nouveau clic) au
     * lieu de rester bloqué sur la page des demandes.
     *
     * @param {string} reason - Cause de l'échec, transmise pour les logs.
     */
    function reportFailure(reason) {
        console.warn(`[CEV_AVI/pageBridge] Échec signalé au content script : ${reason}`);
        window.postMessage(
            { cevAvi: true, action: 'angularClickFailed', reason },
            window.location.origin
        );
    }

    /**
     * Intercepte window.open pendant l'exécution de fn() pour capturer l'URL
     * du rendez-vous, puis transmet cette URL au content script (monde isolé).
     *
     * Pourquoi : la prise de RDV fait un POST AJAX asynchrone puis
     * window.open(url,"_blank"). Sans geste utilisateur réel, le navigateur bloque
     * cette popup et l'URL serait perdue. On la capture donc au vol ; le content
     * script décide ensuite quoi en faire (nouvel onglet via le service worker
     * depuis IndexByUserId, navigation de l'onglet courant depuis la page Edit).
     *
     * L'interception reste active quelques secondes pour couvrir le POST async.
     *
     * @param {Function} fn - Callback qui déclenche la prise de RDV.
     * @param {string} label - Libellé pour les logs.
     */
    function interceptOpenAndCall(fn, label) {
        // Génération de cette interception. Sans ce jeton, une interception qui
        // démarre pendant qu'une précédente est encore installée capturerait
        // l'OVERRIDE comme « original » ; la restauration de la première
        // écraserait alors celle de la seconde et l'URL du captcha serait
        // perdue. On restaure donc toujours le vrai `window.open` natif, et
        // seule la génération courante a le droit de restaurer.
        const interceptId = ++activeInterceptId;
        let captured = false;

        window.open = function (url) {
            if (url && !captured) {
                captured = true;
                window.open = nativeOpen;
                // Résout en URL absolue (groupVA peut fournir une URL relative).
                let absoluteUrl = url;
                try {
                    absoluteUrl = new URL(url, window.location.href).href;
                } catch { /* garde l'URL telle quelle si non parsable */ }
                console.log(`[CEV_AVI/pageBridge] window.open intercepté → ouverture nouvel onglet : ${absoluteUrl}`);
                // Transmet au content script (monde isolé) qui relaiera au background.
                // L'onglet IndexByUserId courant n'est PAS modifié.
                window.postMessage({ cevAvi: true, action: 'openCaptchaTab', url: absoluteUrl }, window.location.origin);
                return null;
            }
            return nativeOpen.apply(window, arguments);
        };

        try {
            fn();
            console.log(`[CEV_AVI/pageBridge] Prise de RDV déclenchée (open intercepté) : ${label}`);
        } catch (e) {
            console.warn('[CEV_AVI/pageBridge] Erreur pendant groupVA :', e);
            if (!captured) {
                if (activeInterceptId === interceptId) window.open = nativeOpen;
                reportFailure(`exception pendant ${label} : ${e.message}`);
                return;
            }
        }

        // Filet de sécurité : restaure window.open si rien n'a été capturé
        // (POST en erreur ou réponse sans EappUrl) et signale l'échec.
        setTimeout(() => {
            // Une interception plus récente a pris la main : ne rien restaurer,
            // sous peine de désarmer la capture en cours.
            if (activeInterceptId !== interceptId) return;

            window.open = nativeOpen;
            if (!captured) {
                reportFailure(`aucune URL de RDV reçue après ${OPEN_INTERCEPT_WINDOW_MS / 1000}s (POST /ManageRdv échoué ou sans EappUrl ?)`);
            }
        }, OPEN_INTERCEPT_WINDOW_MS);
    }

    window.addEventListener('message', (event) => {
        // N'accepte que les messages provenant de cette même fenêtre
        if (event.source !== window) return;

        const data = event.data;
        if (!data || data.cevAvi !== true || data.action !== 'angularClick') return;

        try {
            const el = document.querySelector('[data-cev-avi-click="1"]');
            if (!el) {
                // Cas fréquent : DataTables/Angular a re-rendu le tableau entre le
                // marquage et l'arrivée de ce message (postMessage est asynchrone).
                reportFailure('bouton cible introuvable (tableau re-rendu depuis le marquage)');
                return;
            }
            el.removeAttribute('data-cev-avi-click');

            const ngExpr = el.getAttribute('ng-click');

            // MODE « INTERCEPTION FORCÉE » — utilisé par editPage.js pour le bouton
            // « Gérer votre rendez-vous » de la page Edit/<id>.
            //
            // Sur IndexByUserId, l'interception n'était armée que pour un ng-click
            // reconnu comme groupVA*. Sur la page Edit, on ne peut RIEN présumer du
            // bouton : nom de fonction inconnu (manageRdv, groupVA, bookAppointment…),
            // voire absence totale de ng-click (<a href> ou handler jQuery). Le
            // content script sait, lui, qu'il s'agit du bouton de prise de RDV : il
            // demande donc explicitement l'interception, quelle que soit la forme du
            // bouton.
            //
            // Les deux issues possibles sont couvertes : si le portail appelle
            // window.open, l'URL est capturée et transmise ; s'il navigue l'onglet
            // courant, la page part vers le captcha et ce script disparaît avec elle
            // (le filet de sécurité de 10 s ne peut donc pas signaler un faux échec).
            if (data.intercept === true) {
                const label = ngExpr
                    || (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60)
                    || 'bouton sans ng-click';
                interceptOpenAndCall(() => dispatchClick(el, ngExpr), label);
                return;
            }

            // Méthode AngularJS la plus fiable : évaluer directement l'expression
            // ng-click (ex: groupVA('id','BEL','NA')) sur le scope du bouton, dans
            // un $apply sécurisé. On fournit un faux $event au cas où le handler
            // l'utilise. On N'utilise PAS triggerHandler (événement incomplet) ni un
            // $apply imbriqué (erreur $rootScope:inprog).
            if (ngExpr && window.angular && typeof window.angular.element === 'function') {
                const $el = window.angular.element(el);
                const scope = $el.scope && $el.scope();
                if (scope) {
                    const $event = {
                        target: el,
                        currentTarget: el,
                        preventDefault() {},
                        stopPropagation() {},
                    };

                    const call = parseNgClickCall(ngExpr);
                    const injector = $el.injector && $el.injector();
                    const $parse = injector && injector.get ? injector.get('$parse') : null;

                    // PRISE DE RDV (groupVA / groupVAEpp / ...) : la fonction effectue un
                    // POST /VisaApplication/ManageRdv puis window.open(EappUrl, "_blank").
                    // Ce window.open par script est BLOQUÉ par le navigateur (pas de geste
                    // utilisateur). On intercepte donc window.open PENDANT l'appel pour
                    // récupérer l'URL et ouvrir l'onglet captcha via le background.
                    //
                    // IMPORTANT : on englobe TOUTES les voies d'exécution dans
                    // interceptOpenAndCall pour que window.open soit capté quel que soit
                    // le nom de la fonction (le site est passé de groupVA(3 args) à
                    // groupVAEpp(2 args)).
                    if (call && isBookingFunction(call.name)) {
                        const fnScope = findScopeWithFunction(scope, call.name);
                        interceptOpenAndCall(() => {
                            if (fnScope) {
                                // Appel direct de la fonction avec ses arguments réels.
                                safeApply(fnScope, () => {
                                    fnScope[call.name].apply(fnScope, call.args);
                                });
                            } else if ($parse) {
                                // La fonction n'est pas sur le scope : on évalue l'expression
                                // ng-click telle quelle (toujours SOUS interception).
                                safeApply(scope, () => $parse(ngExpr)(scope, { $event }));
                            } else {
                                el.click();
                            }
                        }, `${call.name}(${call.args.join(', ')})`);
                        console.log(`[CEV_AVI/pageBridge] Prise de RDV déclenchée sous interception : ${call.name}(${call.args.join(', ')})`);
                        return;
                    }

                    // Fallback Angular avec $parse pour les autres ng-click (non-RDV).
                    if ($parse) {
                        safeApply(scope, () => $parse(ngExpr)(scope, { $event }));
                        console.log(`[CEV_AVI/pageBridge] ng-click exécuté via $parse : ${ngExpr}`);
                        afterNoNavigation(window.location.href, 800, () => fireNativeAndJqueryClick(el));
                        return;
                    }

                    // Dernier fallback Angular : handler click jQuery/jqLite.
                    if (typeof $el.triggerHandler === 'function') {
                        $el.triggerHandler('click');
                        console.log(`[CEV_AVI/pageBridge] ng-click déclenché via triggerHandler : ${ngExpr}`);
                        return;
                    }
                }
            }

            // Fallback : clic natif complet dans le contexte page
            const opts = { bubbles: true, cancelable: true, view: window };
            el.dispatchEvent(new MouseEvent('mousedown', opts));
            el.dispatchEvent(new MouseEvent('mouseup', opts));
            el.dispatchEvent(new MouseEvent('click', opts));
            el.click();
            console.log('[CEV_AVI/pageBridge] Clic natif (Angular indisponible).');
        } catch (e) {
            console.warn('[CEV_AVI/pageBridge] Erreur lors du déclenchement :', e);
            reportFailure(`erreur lors du déclenchement du clic : ${e.message}`);
        }
    });

    console.log('[CEV_AVI/pageBridge] Pont Angular prêt (monde page).');
})();
