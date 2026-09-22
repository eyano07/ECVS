/**
 * ==========================================================================
 * SCRIPT CLIENT (Content Script) — Extension Chrome CEV_AVI
 * ==========================================================================
 * 
 * Ce script est injecté automatiquement dans la page de prise de rendez-vous
 * du site diplomatique belge (appointment.cloud.diplomatie.be).
 * 
 * Son rôle principal :
 *  1. Détecter si des créneaux horaires sont disponibles.
 *  2. Si aucun créneau n'est disponible → recharger la page automatiquement.
 *  3. Si un créneau est trouvé → sélectionner la première date disponible
 *     dans le calendrier et confirmer la réservation.
 * 
 * Le script s'exécute dans une IIFE (Immediately Invoked Function Expression)
 * pour éviter toute pollution de l'espace global.
 * ==========================================================================
 */
(() => {

  // ======================== CONSTANTES DE CONFIGURATION ========================

  /** Intervalle d'attente (en ms) entre chaque vérification du loader de chargement */
  const LOADER_WAIT_INTERVAL_IN_MS = 1000; // 1 seconde

  /** Temps maximum d'attente (en ms) avant de considérer que le chargement a échoué */
  const MAXIMUM_WAIT_TIME_IN_MS = 1000 * 5; // 5 secondes

  /** Sélecteur CSS du bouton de confirmation du calendrier de rendez-vous */
  const CALENDAR_CONFIRM_BUTTON_SELECTOR = '#submitBtn';

  /**
   * Conteneur du sélecteur de créneau. Sa présence est la PREUVE qu'on est bien
   * sur la vraie page SelectSlot : les pages d'erreur de la passerelle du site
   * (504/502/503) sont servies À LA MÊME URL, donc l'URL ne suffit pas à
   * distinguer une page de réservation d'une page en panne.
   */
  const SLOT_PICKER_SELECTOR = '#dateAndTimePicker';

  /**
   * Marqueurs textuels des pages d'erreur HTTP du portail (504 Gateway Timeout,
   * 502, 503…). Le site les renvoie AVEC l'URL de SelectSlot inchangée et sans
   * aucun des éléments attendus : sans ce filtre, l'absence de loader ET de
   * message « aucun créneau » était interprétée comme un créneau disponible, et
   * toutes les fenêtres filles étaient réveillées pour rien.
   * Comparaison en MAJUSCULES des deux côtés (le site peut mettre le texte en
   * capitales via CSS, ce que `innerText` ne reflète pas).
   */
  const SERVER_ERROR_PAGE_MARKERS = [
    // Titres (« ERROR 504 » + les trois intitulés NL / FR / EN de la page)
    'ERROR 500', 'ERROR 502', 'ERROR 503', 'ERROR 504',
    'GATEWAY TIMEOUT', 'GATEWAY TIME-OUT', 'TIME-OUT VAN GATEWAY',
    'BAD GATEWAY', 'SERVICE UNAVAILABLE', 'SERVICE TEMPORARILY UNAVAILABLE',
    'PAS RÉPONDU À TEMPS', 'PAS REPONDU A TEMPS',
    // Corps du message, dans les trois langues : tient même si le site
    // remanie ses titres. Apostrophes volontairement évitées (le site mélange
    // l'apostrophe droite ' et la typographique ’).
    'DE REACTIETIJD IS OVERSCHREDEN',
    'LE TEMPS DE RÉPONSE EST DÉPASSÉ', 'LE TEMPS DE REPONSE EST DEPASSE',
    'THE RESPONSE TIME HAS BEEN EXCEEDED',
  ];

  /** 
   * Messages d'erreur connus indiquant qu'aucun créneau n'est disponible.
   * Inclut les versions française et anglaise du message du site.
   */
  const ERRORS_MESSAGES = [
    'Il n\'y a actuellement aucune plage horaire disponible pour ce service. Veuillez réessayer plus tard',
    'There is currently no time slot available for this service. Please try again later'
  ];

  /**
   * Clé sessionStorage évitant d'envoyer plusieurs fois la MÊME notification
   * pendant un même cycle de recherche.
   *
   * Portée volontairement limitée au cycle, et non à la durée de vie de
   * l'onglet : `sessionStorage` survit aux rechargements, et la fenêtre
   * principale cherche justement en rechargeant le même onglet en boucle
   * (scheduleReload). Un drapeau posé pour toute la vie de l'onglet faisait
   * donc notifier UNE seule fois, puis plus jamais — la fenêtre principale
   * continuait de tourner et de réserver, mais aucune fenêtre fille n'était
   * plus prévenue, sans la moindre erreur visible. Le drapeau est donc effacé
   * à chaque nouveau cycle (voir scheduleReload).
   */
  const APPOINTMENT_FOUND_NOTIFIED_KEY = 'cevAviAppointmentFoundNotified';

  /** Clé sessionStorage pour éviter d'envoyer plusieurs fois l'email depuis le même onglet */
  const APPOINTMENT_EMAIL_SENT_KEY = 'cevAviAppointmentEmailSent';

  /**
   * Clé sessionStorage comptant les rechargements successifs sans créneau
   * disponible sur CET onglet. Survit aux rechargements (même origine),
   * remise à zéro dès qu'un créneau est trouvé.
   */
  const RELOAD_ATTEMPTS_KEY = 'cevAviReloadAttempts';

  /** Délai de base (ms) avant de recharger la page quand aucun créneau n'est disponible. */
  const RELOAD_BASE_DELAY_MS = 2000;

  /** Aléa (jitter, ms) ajouté au délai pour désynchroniser les profils. */
  const RELOAD_JITTER_MS = 1500;

  /** Incrément de délai (ms) par tentative successive (ralentit progressivement). */
  const RELOAD_BACKOFF_STEP_MS = 500;

  /** Délai maximum (ms) avant rechargement, quel que soit le nombre de tentatives. */
  const RELOAD_MAX_DELAY_MS = 8000;

  // ======================== FONCTIONS UTILITAIRES ========================

  /** Durée max (ms) pendant laquelle un marqueur de captcha de prise de RDV reste valable. */
  const BOOKING_CAPTCHA_MAX_AGE_MS = 120000;

  /**
   * Affiche un bandeau fixe en haut de la page captcha avec le nom du demandeur,
   * UNIQUEMENT lorsque ce captcha provient d'une prise de RDV (marqueur
   * `bookingCaptchaPending` posé par le background). Les autres captchas
   * (ex: annulation de RDV) n'affichent rien. Le nom est capturé sur
   * IndexByUserId et, à défaut, on retombe sur le numéro internet.
   */
  function displayApplicantHeader() {
    chrome.storage.local.get(
      ['applicantName', 'internetNumber', 'bookingCaptchaPending'],
      (data) => {
      // N'affiche le nom QUE si ce captcha provient d'une prise de RDV récente.
      // Les autres captchas (ex: annulation de RDV) ne portent pas ce marqueur.
      const pendingTs = data.bookingCaptchaPending || 0;
      const isBookingCaptcha = pendingTs && (Date.now() - pendingTs) < BOOKING_CAPTCHA_MAX_AGE_MS;
      if (!isBookingCaptcha) {
        console.log('[CEV_AVI] Captcha non lié à une prise de RDV — nom du demandeur non affiché.');
        return;
      }

      // Consomme le marqueur pour ne pas réafficher le nom sur un futur captcha
      // (ex: annulation de RDV ultérieure).
      chrome.storage.local.remove('bookingCaptchaPending');

      const name = (data.applicantName || '').trim();
      const num = (data.internetNumber || '').trim();
      // On affiche le NOM du demandeur ; l'identifiant n'est utilisé qu'en
      // dernier recours si le nom n'a pas pu être capturé.
      const label = name || num;
      if (!label) return;
      if (document.getElementById('cev-avi-applicant-header')) return;

      const banner = document.createElement('div');
      banner.id = 'cev-avi-applicant-header';
      banner.innerHTML = `
        <div style="
          display:inline-flex;align-items:center;gap:10px;max-width:100%;
          padding:9px 14px;border-radius:999px;
          background:rgba(255,255,255,0.86);
          border:1px solid rgba(148,163,184,0.28);
          box-shadow:0 12px 30px rgba(15,23,42,0.14);
          backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
        ">
          <span style="
            width:9px;height:9px;border-radius:999px;flex:0 0 auto;
            background:#2563eb;box-shadow:0 0 0 4px rgba(37,99,235,0.12);
          "></span>
          <span style="
            color:#64748b;font:800 11px/1 Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;
            letter-spacing:0.08em;text-transform:uppercase;
          ">Demandeur</span>
          <span style="
            min-width:0;max-width:72vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
            color:#0f172a;font:800 15px/1.1 Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;
            letter-spacing:-0.01em;
          "></span>
        </div>
      `;
      banner.querySelector('span:last-child').textContent = label;
      // Bandeau dans le FLUX de la page (position statique) : il occupe une bande
      // en haut et pousse le contenu vers le bas, sans recouvrir le captcha.
      Object.assign(banner.style, {
        position: 'static',
        width: '100%',
        boxSizing: 'border-box',
        background: 'linear-gradient(135deg, rgba(239,246,255,0.92), rgba(248,250,252,0.92))',
        color: '#0f172a',
        font: '700 14px/1.4 Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif',
        padding: '12px 14px',
        textAlign: 'center',
        borderBottom: '1px solid rgba(148,163,184,0.24)',
        boxShadow: '0 10px 26px rgba(15,23,42,0.08)',
      });

      const target = document.body || document.documentElement;
      // Insère le bandeau TOUT EN HAUT du body pour qu'il précède le contenu.
      target.insertBefore(banner, target.firstChild);
    });
  }

  /**
   * Sur la page captcha : informe l'utilisateur qu'il doit résoudre le captcha
   * puis fermer cet onglet. Enregistre aussi CET onglet auprès du background de
   * façon fiable : sa fermeture MANUELLE (l'utilisateur a résolu le captcha)
   * déclenchera le compte à rebours de 15 min du by-pass captcha (exigence n°3).
   */
  function watchCaptchaVerificationLoading() {
    console.log('[CEV_AVI] Page captcha — résolvez le captcha puis fermez cet onglet.');
    try {
      chrome.runtime.sendMessage({ action: 'registerCaptchaTab' });
    } catch (e) {
      console.warn('[CEV_AVI] Enregistrement de l\'onglet captcha impossible :', e.message);
    }
  }

  // ======================== FONCTIONS DE SÉLECTION DE DATE ========================

  /** Indique si une date a été sélectionnée avec succès dans le calendrier */
  let dateWasSelected = false;

  /** Nombre maximum de mois à parcourir pour trouver un jour disponible */
  const MAX_MONTH_ATTEMPTS = 12;

  /**
   * Ouvre le calendrier (date picker) et sélectionne automatiquement
   * un jour ALÉATOIRE parmi les jours disponibles (non désactivés).
   * 
   * Fonctionnement :
   *  1. Clique sur l'icône calendrier pour ouvrir le widget.
   *  2. Vérifie que le widget et ses boutons existent (gestion d'erreurs).
   *  3. Récupère TOUS les jours disponibles (td.day:not(.disabled)).
   *  4. Si aucun jour n'est disponible dans le mois en cours,
   *     navigue vers le mois suivant (max 12 tentatives pour éviter une boucle infinie).
   *  5. Choisit un jour AU HASARD parmi tous les jours disponibles.
   *  6. Clique sur le jour sélectionné aléatoirement.
   */
  function defineDate() {
    console.log('[CEV_AVI] 🗓️ Recherche d\'une date disponible...');

    // Vérifie que le bouton calendrier existe avant de cliquer
    const calendButton = document.querySelector('#datepickerControl .fa-calendar');
    if (!calendButton) {
      console.warn('[CEV_AVI] ❌ Bouton calendrier non trouvé');
      dateWasSelected = false;
      return;
    }

    // Ouvre le calendrier en cliquant sur l'icône
    calendButton.click();

    // Attend 300ms que le widget du calendrier s'affiche dans le DOM
    setTimeout(() => {
      // Vérifie que le widget du calendrier est bien apparu
      const datetimePicker = document.querySelector('.bootstrap-datetimepicker-widget');
      if (!datetimePicker) {
        console.warn('[CEV_AVI] ❌ Widget du calendrier non trouvé');
        dateWasSelected = false;
        return;
      }

      // Vérifie que le bouton "mois suivant" existe
      const datetimePickerNextButton = datetimePicker.querySelector('th.next');
      if (!datetimePickerNextButton) {
        console.warn('[CEV_AVI] ❌ Bouton "mois suivant" du calendrier non trouvé');
        dateWasSelected = false;
        return;
      }

      // Récupère TOUS les jours disponibles dans le mois en cours
      let availableDays = datetimePicker.querySelectorAll('td.day:not(.disabled)');
      let attempts = 0;

      // Parcourt les mois suivants tant qu'aucun jour disponible n'est trouvé
      // Limite à MAX_MONTH_ATTEMPTS mois pour éviter une boucle infinie
      while (availableDays.length === 0 && attempts < MAX_MONTH_ATTEMPTS) {
        datetimePickerNextButton.click(); // Passe au mois suivant
        availableDays = datetimePicker.querySelectorAll('td.day:not(.disabled)');
        attempts++;
      }

      if (availableDays.length > 0) {
        // Choisit un index ALÉATOIRE parmi les jours disponibles
        const randomIndex = Math.floor(Math.random() * availableDays.length);
        const selectedDay = availableDays[randomIndex];

        console.log(`[CEV_AVI] ✅ ${availableDays.length} jour(s) disponible(s) — jour choisi aléatoirement : ${selectedDay.textContent}`);

        // Clique sur le jour sélectionné aléatoirement
        selectedDay.click();
        dateWasSelected = true;
      } else {
        // Aucun jour trouvé après avoir parcouru tous les mois
        console.warn(`[CEV_AVI] ❌ Aucune date disponible trouvée après ${attempts} mois parcourus`);
        dateWasSelected = false;
      }
    }, 300);
  }

  // ======================== FONCTIONS DE COMMUNICATION AVEC LE BACKGROUND ========================

  /** Nombre maximum de tentatives d'envoi de la notification appointmentFound. */
  const NOTIFY_MAX_ATTEMPTS = 5;

  /** Délai (ms) entre deux tentatives d'envoi de la notification. */
  const NOTIFY_RETRY_DELAY_MS = 2000;

  /**
   * Verrou d'envoi. Le drapeau sessionStorage n'étant posé qu'au SUCCÈS, il ne
   * peut plus servir à écarter un second appel pendant qu'un envoi est en vol.
   */
  let notifyInFlight = false;

  /**
   * Nombre de tentatives d'envoi déjà effectuées pour ce chargement de page.
   * Remis à zéro naturellement par le rechargement qui ouvre le cycle suivant.
   */
  let notifyAttempts = 0;

  /**
   * Notifie la passerelle qu'un créneau a été trouvé — une seule fois par CYCLE
   * de recherche (voir APPOINTMENT_FOUND_NOTIFIED_KEY, réarmé par
   * scheduleReload) et UNIQUEMENT depuis la fenêtre PRINCIPALE.
   *
   * Pourquoi restreindre à la fenêtre principale : la passerelle diffuse tout
   * appointmentFound reçu à TOUTES les fenêtres connectées, y compris
   * l'émettrice écartée par son propre windowId. Si une fenêtre FILLE (qui
   * vient elle-même d'être notifiée et de décrocher un créneau pour son propre
   * profil) notifiait à son tour, chaque nouvelle notification déclencherait
   * une nouvelle vague de recherches chez les autres fenêtres filles, qui
   * pourraient elles-mêmes trouver un créneau et notifier de nouveau : boucle
   * auto-entretenue, sans fin naturelle. Seule la fenêtre principale — qui ne
   * prend jamais de RDV pour elle-même — est une source saine et non récursive.
   *
   * Le rôle est lu dans `isMainWindow` (case à cocher du popup), et NON déduit
   * de l'absence de numéro internet : cette inférence rendait le système
   * silencieusement inopérant dès qu'un numéro traînait dans le popup de la
   * fenêtre principale — plus aucune fenêtre fille n'était alors notifiée, sans
   * la moindre erreur visible. Repli sur l'ancienne convention tant que la case
   * n'a jamais été touchée, pour ne pas casser les installations existantes.
   *
   * Points de déclenchement possibles (tous filtrés par ce garde-fou) :
   *  - fenêtre principale : dès que SelectSlot confirme qu'un créneau existe
   *    (chargement terminé, pas de message « aucun créneau »), avant la
   *    sélection de date et avant la validation ;
   *  - fenêtre fille : ancien déclencheur après sélection de date, désormais
   *    NO-OP (conservé pour ne pas complexifier makeReservation, mais sans effet) ;
   *  - page « Rendez-vous confirmé » déjà affichée (rechargement de l'extension).
   *
   * @param {string} reason - Raison loggable de la notification.
   */
  function notifyAppointmentFoundOnce(reason) {
    if (sessionStorage.getItem(APPOINTMENT_FOUND_NOTIFIED_KEY) === '1') {
      console.log(`[CEV_AVI] Notification appointmentFound déjà envoyée (${reason}), ignorée.`);
      return;
    }

    if (notifyInFlight) {
      console.log(`[CEV_AVI] Notification appointmentFound déjà en cours (${reason}), ignorée.`);
      return;
    }
    notifyInFlight = true;

    chrome.storage.local.get(['isMainWindow', 'internetNumber'], (data) => {
      const isMainWindow = typeof data.isMainWindow === 'boolean'
        ? data.isMainWindow
        : !(data.internetNumber || '').trim();

      if (!isMainWindow) {
        notifyInFlight = false;
        console.log(`[CEV_AVI] Fenêtre fille (${reason}) — notification NON envoyée pour éviter une boucle récursive.`);
        return;
      }

      sendAppointmentFoundNotification(reason);
    });
  }

  /**
   * Transmet la notification au service worker et NE marque l'onglet comme
   * notifié qu'une fois la publication confirmée par la passerelle.
   *
   * Sans cet accusé de réception, une WebSocket fermée au mauvais moment
   * (service worker MV3 suspendu, reconnexion en cours) faisait perdre la
   * notification en silence : le drapeau était déjà posé, donc l'onglet ne
   * réessayait jamais et les fenêtres filles restaient inertes.
   *
   * @param {string} reason - Raison loggable de la notification.
   */
  function sendAppointmentFoundNotification(reason) {
    notifyAttempts += 1;
    const attempt = notifyAttempts;

    chrome.runtime.sendMessage({ action: 'appointmentFound' }, (response) => {
      notifyInFlight = false;

      const error = chrome.runtime.lastError
        ? chrome.runtime.lastError.message
        : (response && response.ok ? '' : ((response && response.error) || 'aucune réponse du service worker'));

      if (!error) {
        sessionStorage.setItem(APPOINTMENT_FOUND_NOTIFIED_KEY, '1');
        console.log(`[CEV_AVI] appointmentFound envoyé (${reason}, tentative ${attempt}).`);
        return;
      }

      if (attempt >= NOTIFY_MAX_ATTEMPTS) {
        console.error(`[CEV_AVI] ❌ appointmentFound NON transmis après ${attempt} tentatives (${error}) — les fenêtres filles n'ont PAS été notifiées.`);
        return;
      }

      console.warn(`[CEV_AVI] appointmentFound non transmis (${error}) — nouvelle tentative ${attempt + 1}/${NOTIFY_MAX_ATTEMPTS} dans ${NOTIFY_RETRY_DELAY_MS}ms.`);
      notifyInFlight = true;
      setTimeout(() => sendAppointmentFoundNotification(reason), NOTIFY_RETRY_DELAY_MS);
    });
  }

  /**
   * Détecte une page d'erreur HTTP du portail (504/502/503…) servie à la place
   * de la page de réservation. Sur ces pages, il n'y a évidemment AUCUN créneau
   * à annoncer : la fenêtre principale doit se contenter de réessayer plus tard,
   * jamais de notifier les fenêtres filles.
   * @returns {boolean}
   */
  function isServerErrorPage() {
    const pageText = (document.body ? document.body.innerText : '').toUpperCase();
    if (!pageText) return false;
    return SERVER_ERROR_PAGE_MARKERS.some((marker) => pageText.includes(marker));
  }

  /**
   * Détecte la page finale de confirmation.
   * Utile si l'extension est rechargée alors que la page de confirmation est déjà affichée :
   * sans cette détection, aucun clic #submitBtn n'a lieu, donc aucune notification ne part.
   */
  function isAppointmentConfirmationPage() {
    const pageText = document.body ? document.body.innerText : '';
    return pageText.includes('Rendez-vous confirmé')
      || pageText.includes('Votre rendez-vous a été pris')
      || pageText.includes('Appointment confirmed')
      || pageText.includes('Your appointment has been booked');
  }

  /**
   * Extrait la date/heure du RDV depuis le texte de la page de confirmation.
   * Cherche un motif du type "11/05/2026 à 10:20" (ou avec "h" / heure seule).
   * @returns {string} Date formatée "JJ/MM/AAAA à HH:MM" ou chaîne vide si absente.
   */
  function parseAppointmentDateTime() {
    const pageText = document.body ? document.body.innerText : '';
    // Date + heure (ex: "11/05/2026 à 10:20" ou "25/09/2026 13:30")
    const withTime = pageText.match(/(\d{1,2}\/\d{1,2}\/\d{4})\s*(?:à|a|at)?\s*(\d{1,2})[:hH](\d{2})/);
    if (withTime) {
      const hh = withTime[2].padStart(2, '0');
      return `${withTime[1]} à ${hh}:${withTime[3]}`;
    }
    // Date seule en secours
    const dateOnly = pageText.match(/(\d{1,2}\/\d{1,2}\/\d{4})/);
    return dateOnly ? dateOnly[1] : '';
  }

  /**
   * Demande au background l'envoi de l'email « RDV trouvé » via la passerelle.
   * Récupère le nom du candidat (storage) et la date du RDV (page de confirmation).
   * Idempotent par onglet grâce à un drapeau sessionStorage.
   * @param {string} reason - Raison loggable.
   */
  function sendAppointmentEmailOnce(reason) {
    if (sessionStorage.getItem(APPOINTMENT_EMAIL_SENT_KEY) === '1') {
      return;
    }
    sessionStorage.setItem(APPOINTMENT_EMAIL_SENT_KEY, '1');

    // RDV réellement confirmé → le by-pass captcha n'a plus d'objet : on demande
    // au background d'effacer le compte à rebours de 15 min (évite une boule
    // rouge résiduelle 3 min avant une expiration devenue sans intérêt).
    try {
      chrome.runtime.sendMessage({ action: 'appointmentConfirmed' });
    } catch { /* background injoignable — sans conséquence */ }

    const appointmentDate = parseAppointmentDateTime();
    chrome.storage.local.get(['applicantName'], (data) => {
      chrome.runtime.sendMessage({
        action: 'sendAppointmentEmail',
        details: {
          applicantName: (data.applicantName || '').trim(),
          appointmentDate,
        },
      });
      console.log(`[CEV_AVI] Demande d'email RDV envoyée (${reason}) — date: ${appointmentDate || 'inconnue'}.`);
    });
  }

  /**
   * Attend l'apparition de la page de confirmation (après clic sur Confirmer),
   * puis déclenche l'envoi de l'email une fois la date du RDV disponible.
   * @param {number} elapsed - Temps écoulé (ms).
   */
  function watchConfirmationThenEmail(elapsed = 0) {
    const MAX_WAIT = 15000;
    const INTERVAL = 1000;
    if (isAppointmentConfirmationPage()) {
      sendAppointmentEmailOnce('page de confirmation détectée');
      return;
    }
    if (elapsed >= MAX_WAIT) {
      // La confirmation tarde : on envoie quand même (date « à confirmer »).
      sendAppointmentEmailOnce('délai confirmation dépassé');
      return;
    }
    setTimeout(() => watchConfirmationThenEmail(elapsed + INTERVAL), INTERVAL);
  }

  // ======================== RECHARGEMENT TEMPORISÉ (ANTI-BLOCAGE) ========================

  /**
   * Demande un rechargement de la page après un délai temporisé (base +
   * backoff progressif + jitter aléatoire), au lieu d'un rechargement
   * instantané. Objectif : réduire la fréquence des requêtes envoyées au
   * site pour limiter le risque de déclencher le blocage « Too Many
   * Attempts » (>5 tentatives/heure côté site).
   *
   * Le nombre de tentatives successives est compté via sessionStorage (survit
   * aux rechargements de cet onglet) pour ralentir progressivement si le
   * site reste indisponible longtemps, jusqu'à un plafond.
   */
  function scheduleReload() {
    const attempts = Number(sessionStorage.getItem(RELOAD_ATTEMPTS_KEY) || '0') + 1;
    sessionStorage.setItem(RELOAD_ATTEMPTS_KEY, String(attempts));

    // RÉARMEMENT de la notification. Sans cette ligne, le drapeau posé lors du
    // premier créneau trouvé survivait à tous les rechargements de l'onglet
    // (sessionStorage n'est vidé qu'à sa fermeture) : la fenêtre principale
    // notifiait UNE fois puis restait muette indéfiniment, et les fenêtres
    // filles n'étaient plus jamais déclenchées. On repart d'un cycle neuf ici,
    // c'est-à-dire au moment précis où l'on constate qu'il n'y a plus de
    // créneau : le prochain créneau détecté sera donc bien un ÉVÉNEMENT
    // NOUVEAU, digne d'une notification. L'idempotence à l'intérieur d'un même
    // chargement de page, elle, reste assurée (le drapeau n'est effacé qu'ici).
    sessionStorage.removeItem(APPOINTMENT_FOUND_NOTIFIED_KEY);

    const backoff = Math.min(attempts * RELOAD_BACKOFF_STEP_MS, RELOAD_MAX_DELAY_MS);
    const jitter = Math.random() * RELOAD_JITTER_MS;
    const delay = Math.min(RELOAD_BASE_DELAY_MS + backoff, RELOAD_MAX_DELAY_MS) + jitter;

    console.log(`[CEV_AVI] Aucun créneau — nouvelle tentative dans ${(delay / 1000).toFixed(1)}s (tentative n°${attempts}).`);
    setTimeout(() => {
      chrome.runtime.sendMessage({ action: 'reloadTab' });
    }, delay);
  }

  // ======================== FONCTION PRINCIPALE DE RÉSERVATION ========================

  /**
   * Fonction principale qui tente automatiquement de réserver un créneau.
   * 
   * Logique de fonctionnement :
   *  - Si la page est une page d'erreur HTTP du site (504/502/503…) :
   *      → Rechargement temporisé, et SURTOUT aucune notification. Ces pages
   *        sont servies à l'URL de SelectSlot sans rien contenir : elles
   *        passaient donc pour « chargement terminé, aucun message d'erreur »,
   *        c'est-à-dire pour un créneau disponible, et réveillaient toutes les
   *        fenêtres filles alors que le site était simplement en panne.
   *
   *  - Si le loader de chargement est encore visible :
   *      → Attend un intervalle (1s) et réessaye, jusqu'au timeout (5s).
   *      → Si le timeout est atteint, planifie un rechargement temporisé
   *        (backoff + jitter, voir scheduleReload) via le background script.
   * 
   *  - Si le loader a disparu (la page a fini de charger) :
   *      → Vérifie s'il y a un message d'erreur "aucun créneau disponible".
   *        • Si oui → planifie un rechargement temporisé (scheduleReload) pour
   *          retenter sans marteler le site (risque de blocage "Too Many
   *          Attempts").
   *        • Si une autre erreur est rencontrée → ne fait rien (erreur inattendue).
   *        • Si le sélecteur de créneau (#dateAndTimePicker) est absent → la page
   *          n'est pas exploitable (page blanche, maintenance, session expirée) :
   *          rechargement temporisé, sans notification.
   *        • Si aucune erreur ET le sélecteur est présent → un créneau est disponible !
   *          → Notifie immédiatement (sans attendre la sélection de date ni la
   *            validation) — mais SEULE la fenêtre principale (case
   *            « Fenêtre principale » du popup, clé `isMainWindow`) envoie
   *            réellement la notification à la passerelle ; une fenêtre fille
   *            ne notifie jamais (voir notifyAppointmentFoundOnce), pour éviter
   *            une boucle récursive où chaque fenêtre notifiée déclencherait à
   *            son tour une nouvelle vague de notifications.
   *          → Sélectionne un jour disponible avec defineDate().
   *          → Confirme la réservation en cliquant sur le bouton de soumission.
   * 
   * @param {number} timeEllapsed - Temps total écoulé (en ms) depuis le début de l'attente du loader.
   */
  function makeReservation(timeEllapsed = 0) {
    // ---- GARDE-FOU n°1 : page d'erreur HTTP du site (504/502/503…) ----
    // Servie à la MÊME URL que SelectSlot : sans ce test, elle passait pour une
    // page de réservation vide de tout message d'erreur, donc pour un créneau
    // disponible, et déclenchait une notification vers toutes les fenêtres
    // filles. Le site n'a tout simplement pas répondu : on réessaie plus tard.
    if (isServerErrorPage()) {
      console.warn('[CEV_AVI] ⛔ Page d\'erreur du site (504/502/503…) — AUCUNE notification, rechargement temporisé.');
      scheduleReload();
      return;
    }

    // Vérifie si le spinner de chargement est encore affiché
    const loader = document.querySelector(`${SLOT_PICKER_SELECTOR} .loading`);

    if (!loader) {
      // ---- Le chargement est terminé, on analyse le résultat ----

      // Recherche un éventuel message d'erreur sur la page
      const errorMessageNodeElement = document.querySelector('.alert.alert-danger.validation-summary-errors');

      // Vérifie si le message d'erreur correspond à "aucun créneau disponible"
      const isCorrectErrorMessage = errorMessageNodeElement
        && ERRORS_MESSAGES.some((errorMessage) => errorMessageNodeElement.innerText.includes(errorMessage));

      if (isCorrectErrorMessage) {
        // Aucun créneau disponible → recharge la page pour retenter, mais
        // après un délai temporisé (backoff + jitter) plutôt qu'instantanément,
        // pour limiter le risque de déclencher le blocage "Too Many Attempts".
        scheduleReload();
      } else if (errorMessageNodeElement) {
        // Une erreur différente/inattendue a été rencontrée → on ne fait rien
      } else if (!document.querySelector(SLOT_PICKER_SELECTOR)) {
        // ---- GARDE-FOU n°2 : le sélecteur de créneau n'est pas là ----
        // Filet de sécurité générique derrière le garde-fou n°1 : page blanche,
        // maintenance, session expirée, erreur non listée dans
        // SERVER_ERROR_PAGE_MARKERS… Le raisonnement NÉGATIF d'origine (« pas de
        // loader + pas de message d'erreur = créneau disponible ») devient
        // POSITIF : on exige la présence du widget qu'on s'apprête à piloter,
        // faute de quoi rien ne prouve qu'un créneau existe. On laisse toutefois au
        // rendu AngularJS le même délai de grâce que pour le loader, pour ne pas
        // conclure trop tôt sur une vraie page encore en cours de construction.
        timeEllapsed += LOADER_WAIT_INTERVAL_IN_MS;

        if (timeEllapsed >= MAXIMUM_WAIT_TIME_IN_MS) {
          console.warn(`[CEV_AVI] ⛔ Sélecteur de créneau (${SLOT_PICKER_SELECTOR}) absent après ${MAXIMUM_WAIT_TIME_IN_MS / 1000}s — page inexploitable, AUCUNE notification, rechargement temporisé.`);
          scheduleReload();
        } else {
          setTimeout(() => {
            makeReservation(timeEllapsed);
          }, LOADER_WAIT_INTERVAL_IN_MS);
        }
      } else {
        // ---- SUCCÈS : Un créneau est disponible ! ----
        // Un créneau a été trouvé : on repart de zéro pour le backoff au cas
        // où un futur rechargement serait nécessaire (nouvel onglet/tentative).
        sessionStorage.removeItem(RELOAD_ATTEMPTS_KEY);

        // Notification ANTICIPÉE : dès qu'on sait qu'un créneau existe (chargement
        // terminé, pas de message « aucun créneau »), sans attendre la sélection de
        // date ni la validation. Le filtre fenêtre principale / fenêtre secondaire
        // est appliqué DANS notifyAppointmentFoundOnce (source unique de vérité).
        notifyAppointmentFoundOnce('SelectSlot affiché, avant sélection de date');

        // Sélectionne automatiquement un jour aléatoire dans le calendrier
        defineDate();

        // Attend 1 seconde après la sélection de date (defineDate a un délai interne de 300ms)
        // pour s'assurer que la date est bien enregistrée avant de confirmer
        setTimeout(() => {
          // Sur la fenêtre principale, la notification est déjà partie plus haut
          // (notifyAppointmentFoundOnce est idempotent par onglet, ceci est un
          // no-op). Sur une fenêtre secondaire, cet appel est également un no-op
          // (filtré dans notifyAppointmentFoundOnce) : une fenêtre secondaire ne
          // notifie JAMAIS, pour éviter qu'elle ne déclenche à son tour une
          // nouvelle vague de recherches chez les autres fenêtres filles.
          if (dateWasSelected) {
            notifyAppointmentFoundOnce('SelectSlot — date sélectionnée');
          } else {
            console.warn('[CEV_AVI] Aucune date sélectionnée — notification non envoyée.');
          }

          // Clique sur le bouton "Confirmer" (id: submitBtn) pour valider la réservation
          const calendarConfirmButton = document.querySelector(CALENDAR_CONFIRM_BUTTON_SELECTOR);
          if (calendarConfirmButton) {
            console.log('[CEV_AVI] ✅ Clic sur le bouton Confirmer (#submitBtn)');
            calendarConfirmButton.click();

            // Surveille l'apparition de la confirmation pour envoyer l'email avec
            // la date réelle du RDV (lue sur la page de confirmation).
            watchConfirmationThenEmail();

            // Ne vide PAS le cache et ne recharge PAS la page
            // → reste sur la page pour que l'utilisateur puisse voir le message de confirmation
            console.log('[CEV_AVI] ⏳ En attente du message de confirmation sur la page...');
          } else {
            console.warn('[CEV_AVI] ❌ Bouton Confirmer (#submitBtn) non trouvé');
          }
        }, 1000);
      }
    } else {
      // ---- Le loader est encore visible, la page charge encore ----
      timeEllapsed += LOADER_WAIT_INTERVAL_IN_MS;

      if (timeEllapsed >= MAXIMUM_WAIT_TIME_IN_MS) {
        // Timeout atteint (5s) → le chargement prend trop de temps, on recharge
        // la page (avec le même délai temporisé que pour l'absence de créneau).
        scheduleReload();
      } else {
        // Continue d'attendre en rappelant la fonction après l'intervalle défini
        setTimeout(() => {
          makeReservation(timeEllapsed);
        }, LOADER_WAIT_INTERVAL_IN_MS);
      }
    }
  }

  // ======================== POINT D'ENTRÉE DU SCRIPT ========================

  console.log('script executed');

  const path = window.location.pathname;
  const isCaptchaPage = /captcha/i.test(path);

  const isIntegrationErrorPage = path.includes('/Integration/Error/')
    && !path.includes('MultiSessionNotAllowed');

  if (isCaptchaPage) {
    // Page captcha de l'abonné : affiche UNIQUEMENT le nom du demandeur en tête
    // pour identifier qui valider manuellement. Pas de bandeau ailleurs.
    // AUCUNE reprise automatique en cas d'erreur : fermer l'onglet puis
    // re-cliquer le calendrier créait une boucle qui déclenchait le blocage
    // « 60 minutes » du site. En cas d'erreur, l'utilisateur intervient.
    // Le compte à rebours de 15 min est géré côté background : il démarre à la
    // FERMETURE MANUELLE de cet onglet, pas ici.
    displayApplicantHeader();
    watchCaptchaVerificationLoading();
  } else if (isAppointmentConfirmationPage()) {
    notifyAppointmentFoundOnce('page confirmation déjà affichée');
    sendAppointmentEmailOnce('page confirmation déjà affichée');
  } else if (path.includes('/Integration/VOW/SelectSlot')) {
    // Page de sélection du jour : le captcha a été franchi → réservation.
    console.log('[CEV_AVI] Captcha franchi (page SelectSlot atteinte).');
    makeReservation();
  } else if (isIntegrationErrorPage) {
    // Page d'erreur du portail dans l'onglet captcha : PAS de reprise
    // automatique (voir ci-dessus). On journalise, l'utilisateur décide.
    console.error('[CEV_AVI] Page d\'erreur du portail détectée dans l\'onglet captcha — aucune reprise automatique, intervention manuelle requise.');
  } else {
    console.log('[CEV_AVI] Page appointment hors captcha/SelectSlot/confirmation — aucune action.');
  }
})()