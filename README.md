# CEV_AVI

Système d'automatisation de prise de rendez-vous pour les demandes de visa belge,
conçu pour coordonner **plusieurs profils Chrome en parallèle** via un bus
d'événements **Kafka**.

Le projet se compose de deux parties :

1. **Extension Chrome (Manifest V3)** — automatise la navigation et la sélection
   de créneaux sur les portails `appointment.cloud.diplomatie.be` et
   `visaonweb.diplomatie.be`.
2. **Passerelle Node.js** — fait le pont entre les extensions (WebSocket) et le
   broker Kafka pour diffuser à toutes les fenêtres l'information « RDV trouvé ».

> **Avertissement** : cet outil automatise des portails gouvernementaux officiels.
> Assurez-vous que son usage respecte les conditions d'utilisation de ces sites
> et la réglementation applicable.

---

## Sommaire

- [Architecture](#architecture)
- [Flux métier](#flux-métier)
- [Prérequis](#prérequis)
- [Installation de l'extension](#installation-de-lextension)
- [Démarrage du serveur (passerelle + Kafka)](#démarrage-du-serveur-passerelle--kafka)
- [Configuration](#configuration)
- [Tests](#tests)
- [Publication de l'image Docker](#publication-de-limage-docker)
- [Structure du projet](#structure-du-projet)

---

## Architecture

```
┌─────────────────┐        WebSocket        ┌──────────────────┐      Kafka      ┌──────────┐
│  Profil Chrome 1│ ──────────────────────► │                  │ ──────────────► │          │
│  (extension)    │ ◄────────────────────── │   Passerelle     │ ◄────────────── │  Kafka   │
└─────────────────┘                         │   (gateway/      │                 │ (KRaft)  │
┌─────────────────┐                         │    index.js)     │                 │          │
│  Profil Chrome 2│ ◄──────────────────────►│                  │                 └──────────┘
│  (extension)    │                         └──────────────────┘
└─────────────────┘
```

- L'extension **ne parle jamais directement à Kafka** : elle passe par la
  passerelle WebSocket.
- Deux topics Kafka :
  - `applicant-registry` (compacté) — registre des demandeurs (clé = `windowId`).
  - `appointment-found` — événements « RDV trouvé », **purgé périodiquement**
    (toutes les 30 s par défaut) et jamais au-delà du dernier offset consommé,
    pour ne pas supprimer un événement avant sa diffusion.

## Flux métier

1. Chaque profil Chrome génère un `windowId` (UUID) et s'enregistre auprès de la
   passerelle avec son *internet number*.
2. Un profil détecte un créneau disponible et confirme le RDV → envoie
   `appointmentFound` à la passerelle.
3. La passerelle produit l'événement sur Kafka, le consomme, puis **le diffuse à
   toutes les fenêtres connectées**.
4. Les autres profils cliquent « Gérer votre rendez-vous » dans la page de
   **leur** dossier, restée ouverte en attente.
5. Le topic `appointment-found` est vidé.

La passerelle conserve le dernier événement pendant 3 min pour le **rejouer** aux
fenêtres qui se reconnectent (service worker MV3 suspendu = WebSocket coupée).

### Parcours vers le captcha (mise à jour du portail)

La colonne « Action » du tableau `IndexByUserId` **n'expose plus de bouton
calendrier**. Le captcha ne s'atteint plus que depuis la page du dossier :

```
/VisaApplication/Edit/<id> → « Gérer votre rendez-vous » → page captcha
```

**Les fenêtres filles stationnent donc directement sur cette page.** L'opérateur
ouvre lui-même le dossier de son demandeur et **laisse l'onglet ouvert**. À la
notification, il n'y a plus rien à ouvrir, ni à chercher, ni à filtrer : le
service worker pose le marqueur `manageRdvRequestedAt`, `editPage.js` — déjà
chargé dans cet onglet — le reçoit via `chrome.storage.onChanged` et clique
aussitôt. C'est le chemin le plus court possible entre le créneau détecté et le
captcha.

`editPage.js` repère « Gérer votre rendez-vous » (libellé FR/EN/NL normalisé,
puis `ng-click`) et le clique via `pageBridge.js` en mode **interception forcée**
de `window.open` : selon que le portail ouvre une popup ou redirige l'onglet,
l'URL du captcha est capturée au vol ou la navigation se fait d'elle-même. Dans
les deux cas **cet onglet devient la page captcha** — il faut donc rouvrir la
page du dossier pour remettre la fenêtre en poste après un RDV.

> **Mise en poste manuelle.** Si aucune page `/VisaApplication/Edit/` n'est
> ouverte au moment de la notification, celle-ci est **ignorée** (avertissement
> dans la console du service worker, rien n'est ouvert à la place : ouvrir un
> onglet d'autorité risquerait de viser le mauvais dossier). Il revient à
> l'opérateur de vérifier que chaque fenêtre fille est bien restée sur le dossier
> de son demandeur — une session expirée peut l'avoir silencieusement ramenée
> vers la page de connexion.

Pour aider à repérer une fenêtre mal stationnée, `editPage.js` compare dès le
chargement le numéro internet affiché avec celui configuré, et **avertit en
console** en cas de désaccord — sans attendre l'instant critique. S'ils
concordent, il met l'URL en cache (`applicationEditUrl` / `applicationIdFor`),
ce qui arme le parcours de repli ci-dessous.

**Parcours de repli — le clic échoue.** Si le bouton reste introuvable, si le
dossier affiché n'est pas celui du profil, ou si le clic ne produit rien après
trois tentatives, `editPage.js` invalide le cache et rebascule sur le parcours
complet par le tableau (`applicationsPage.js` : filtrage sur le numéro internet,
lecture de l'URL du dossier sur la ligne, ouverture dans un nouvel onglet). Le
crayon n'est **jamais cliqué** — lire l'URL est plus rapide et ne peut pas
échouer silencieusement ; le clic réel n'intervient qu'en dernier recours, si
l'URL est illisible.

#### Compte à rebours du by-pass captcha (15 min)

Fermer **manuellement** l'onglet captcha (une fois le captcha résolu) démarre un
compte à rebours de 15 minutes pendant lequel le portail n'en redemande pas. Il
s'affiche dans un badge discret en bas à droite, **sur la page du dossier** —
c'est-à-dire sur le poste d'attente, la seule page réellement sous les yeux de
l'opérateur. Dans les 2 dernières minutes, le badge est agrandi et passe en
couleur d'alerte. Il disparaît dès que le RDV est confirmé.

Ce badge s'affichait auparavant sur `IndexByUserId` ; il a suivi le poste
d'attente.

#### Garde-fous

Cette chaîne peut rompre sans rien signaler. Quatre protections :

- **Identité du dossier.** `editPage.js` compare, juste avant de cliquer, le
  numéro internet affiché sur la page avec celui du profil. En cas de désaccord
  avéré, il refuse de cliquer, invalide le cache et relance le parcours complet —
  une prise de RDV sur le dossier d'un autre demandeur serait irréversible. Le
  même contrôle tourne au chargement de la page, pour signaler une fenêtre mal
  stationnée bien avant l'instant critique.
- **Marqueur de demande.** `editPage.js` reste **inerte** sans
  `manageRdvRequestedAt` frais (3 min) : stationner sur un dossier, ou le
  consulter manuellement, ne déclenche jamais de prise de RDV. Le marqueur est
  consommé avant le clic.
- **Rôle de la fenêtre.** La fenêtre principale ne clique jamais
  « Gérer votre rendez-vous », même si une page de dossier y est ouverte : elle
  surveille et notifie, elle ne réserve pas. Le garde-fou est posé aux trois
  niveaux (`background.js`, `editPage.js`, `applicationsPage.js`).
- **Échec silencieux.** `pageBridge.js` signale explicitement chaque échec
  (`angularClickFailed`) et un minuteur couvre les cas muets. Un cycle est alors
  relancé jusqu'à `MAX_CLICK_ATTEMPTS` fois, puis le cache est invalidé et le
  parcours complet reprend depuis le tableau.

Le poste d'attente restant ouvert des heures, `editPage.js` **réinitialise
entièrement son état à chaque notification** (`runManageRdvCycle`). Sans cela, un
abandon survenu lors d'une notification précédente neutraliserait silencieusement
toutes les suivantes.

### Diffusion sans délai, sans boucle récursive

Chaque `appointmentFound` reçu par la passerelle est diffusé **immédiatement**
à toutes les fenêtres connectées, sans cooldown ni délai d'attente : un ancien
mécanisme imposait un cooldown glissant de 10 minutes entre deux diffusions
(pour éviter les cascades), il a été supprimé.

La protection contre les cascades repose désormais uniquement sur **l'origine**
de la notification : `client.js` (`notifyAppointmentFoundOnce`) ne l'envoie
réellement à la passerelle QUE depuis la fenêtre **principale**. Une fenêtre
fille qui décroche un créneau pour son propre profil ne notifie jamais les
autres — sans ce garde-fou, chaque fenêtre notifiée pourrait à son tour trouver
un créneau et notifier de nouveau, créant une boucle auto-entretenue.

Ce rôle se règle **explicitement**, via la case « Fenêtre principale » du popup
(clé `isMainWindow`, enregistrée dès le clic sans passer par « Validé »). Il
était auparavant *déduit* de l'absence de numéro internet : un numéro laissé
dans le popup de la fenêtre principale la faisait passer pour une fenêtre
fille, et plus aucune fenêtre n'était notifiée — sans la moindre erreur
visible. Tant que la case n'a jamais été touchée, l'ancienne convention sert de
repli, pour ne pas casser les installations existantes.

La notification n'est par ailleurs marquée comme faite (drapeau `sessionStorage`
de l'onglet) qu'après **accusé de réception** du service worker confirmant la
publication. Si la WebSocket est fermée au mauvais moment (service worker MV3
suspendu, passerelle redémarrée), la reconnexion est demandée immédiatement et
l'envoi est retenté jusqu'à 5 fois — au lieu d'être perdu en silence.

### Rapidité du déclenchement de l'onglet captcha

Entre la notification `appointmentFound` et l'arrivée sur le captcha, chaque
milliseconde compte (créneaux disputés entre plusieurs profils).

Le gain principal vient du **poste d'attente** décrit plus haut : la page qui
porte le bouton est déjà chargée, déjà rendue, et son content script est déjà en
écoute. Au moment critique il ne reste qu'une écriture en storage et un clic —
ni ouverture d'onglet, ni navigation, ni filtrage DataTables, ni rendu Angular à
attendre. Le marqueur est posé **avant** l'envoi du message, et
`chrome.storage.onChanged` sert de canal principal : il atteint l'onglet même
quand le message direct échoue (service worker réveillé, onglet rechargé).

Quand le tableau doit malgré tout être consulté (parcours de repli), la recherche de la ligne
n'attend plus un délai fixe pariant sur le temps de rendu de DataTables : un
`MutationObserver` sur le corps du tableau la déclenche dès que le DOM change,
avec un filet de secours à très court délai en repli. Même logique sur la page du
dossier, où l'observateur est en plus **coalescé sur une frame** — le rendu
d'AngularJS émet des centaines de mutations, et rebalayer le DOM à chacune
provoquerait un pic CPU au pire moment. Les intervalles de sondage (attente du
tableau, réessai de recherche, relance après échec) suivent la même logique.

## Prérequis

- **Google Chrome** (ou Chromium) pour l'extension.
- **Docker** et **Docker Compose** pour le serveur.
- (Optionnel, pour le développement) **Node.js 20+** pour lancer les tests
  localement sans Docker.

## Installation de l'extension

1. Ouvrir `chrome://extensions`.
2. Activer le **Mode développeur** (coin supérieur droit).
3. Cliquer **« Charger l'extension non empaquetée »** et sélectionner le dossier
   contenant le `manifest.json` (`AVI_Server/AVI_ANA/`).
4. Répéter l'opération dans **chaque profil Chrome** à coordonner.

## Démarrage du serveur (passerelle + Kafka)

Depuis `AVI_Server/AVI_ANA/server/` :

1. Créer le fichier de secrets `.env` à partir du modèle versionné :

   ```bash
   cp .env.example .env
   ```

2. Renseigner au minimum `GATEWAY_AUTH_TOKEN` (voir
   [Sécurité de la passerelle](#sécurité-de-la-passerelle)) et, si besoin, les
   identifiants Gmail pour les notifications. **Ne jamais committer `.env`**
   (déjà exclu par `.gitignore`).

3. Démarrer les conteneurs :

   ```bash
   docker compose up -d
   ```

Cela lance :

| Service   | Rôle                                  | Port  |
|-----------|---------------------------------------|-------|
| `kafka`   | Broker Kafka 3.7 en mode KRaft        | 8686  |
| `gateway` | Passerelle WebSocket ↔ Kafka          | 8787  |

Vérifier la santé de la passerelle :

```bash
curl http://localhost:8787/health
# {"status":"ok","kafka":{"producer":"connected","consumer":"running","lastError":null},"clients":0,"applicants":0,"instance":"gateway-..."}
```

La réponse est **503 `degraded`** si le producteur ou le consommateur Kafka est
hors service : la passerelle ne peut alors plus diffuser d'événement, et le
healthcheck Docker marque le conteneur `unhealthy`.

Mettre à jour vers la dernière image publiée :

```bash
docker compose pull gateway && docker compose up -d
```

## Configuration

Toutes les variables ci-dessous se définissent dans `server/.env` (copié depuis
`server/.env.example`, jamais committé). `docker-compose.yml` ne contient plus
aucun secret ni adresse email en dur : il ne fait que référencer `${VAR}`.

### Passerelle (variables d'environnement)

| Variable                       | Défaut               | Description                                                        |
|---------------------------------|----------------------|---------------------------------------------------------------------|
| `KAFKA_BROKER`                  | `localhost:8686`     | Adresse du broker Kafka                                             |
| `KAFKA_TOPIC`                   | `appointment-found`  | Topic des événements RDV                                            |
| `REGISTRY_TOPIC`                | `applicant-registry` | Topic du registre des demandeurs                                    |
| `WS_PORT`                       | `8787`               | Port d'écoute WebSocket + healthcheck                                |
| `WS_HOST`                       | `127.0.0.1`          | Hôte d'écoute. `0.0.0.0` = exposé au réseau (exige `GATEWAY_AUTH_TOKEN`) |
| `GATEWAY_AUTH_TOKEN`            | (vide)               | Jeton partagé requis pour se connecter (voir section Sécurité)      |
| `ALLOWED_ORIGINS`               | (vide)               | Origines WS autorisées, séparées par virgules (ex: `chrome-extension://*`) |
| `GMAIL_USER` / `GMAIL_APP_PASSWORD` | (vide)          | Identifiants d'envoi des emails de notification                    |
| `MAIL_RECIPIENTS`               | (vide)               | Destinataires par défaut de l'email « RDV réservé »                 |
| `APPOINTMENT_ALERT_RECIPIENTS`  | (vide)               | Destinataires de l'alerte auto « RDV trouvé » (avec l'URL du serveur) |
| `APPOINTMENT_ALERT_COOLDOWN_MS` | `300000` (5 min)     | Délai mini entre deux alertes pour le même numéro internet (anti-rafale) |
| `SERVER_PUBLIC_HOST` / `SERVER_PUBLIC_URL` | (vide)        | **Fortement recommandé en production** : force l'hôte/URL affiché dans l'alerte (sinon détection auto IPv4, potentiellement incorrecte) |
| `KAFKA_CONSUMER_GROUP_ID`       | `cev-avi-gateway`    | groupId Kafka **stable** du consumer (voir Fiabilité Kafka ci-dessous) |
| `KAFKA_PURGE_INTERVAL_MS`       | `30000` (30s)        | Intervalle entre deux purges du topic `appointment-found`           |

### Sécurité de la passerelle

Depuis cette mise à jour, la passerelle WebSocket est protégée par deux
mécanismes indépendants, tous deux optionnels mais fortement recommandés :

1. Authentification par mot de passe — si `GATEWAY_AUTH_TOKEN` est défini,
   toute connexion doit fournir le même jeton (via `?token=...` dans l'URL,
   automatiquement ajouté par l'extension d'après le champ **Mot de passe**
   du popup — voir section Extension ci-dessous). Sans ce mot de passe (ou
   avec un mot de passe incorrect), la passerelle rejette la connexion avec un
   401 et l'extension reste déconnectée : c'est ce qui rend l'accès à
   l'extension conditionné à la connaissance à la fois de l'URL **et** du mot
   de passe. Générer un jeton fort :

   ```bash
   openssl rand -hex 32
   ```

   Ce mot de passe est saisi et stocké par chaque utilisateur dans son propre
   profil Chrome (`chrome.storage.local`, jamais commité) plutôt qu'embarqué
   dans le code de l'extension. En cas de fuite, le remplacer côté serveur
   (`GATEWAY_AUTH_TOKEN`) et en informer les utilisateurs pour qu'ils resaisissent
   le nouveau mot de passe dans leur popup.

2. Vérification de l'Origin — `ALLOWED_ORIGINS` restreint les origines
   autorisées à se connecter (utile pour limiter aux extensions Chrome via
   `chrome-extension://*`).

3. Port fermé par défaut — `WS_HOST=127.0.0.1` (défaut) fait que le port
   n'est joignable QUE depuis la machine hébergeant la passerelle, même avec
   `network_mode: host`. Ne définir `WS_HOST=0.0.0.0` que si un accès
   réseau/multi-machines est nécessaire, et dans ce cas configurer
   impérativement `GATEWAY_AUTH_TOKEN`. Au démarrage, la passerelle affiche un
   avertissement (ou une erreur) si elle est exposée sans authentification.

4. Validation stricte du format des messages — la passerelle rejette tout
   message `register`/`appointmentFound` dont `windowId` ou `internetNumber`
   ne respecte pas le format attendu (pas seulement leur présence) :
   - `windowId` : UUID v4 (généré côté extension par `crypto.randomUUID()`).
   - `internetNumber` : alphanumérique, 3 à 40 caractères (ex: `VOWINT6055154`).

   Ces deux valeurs étant réinjectées telles quelles dans le corps des emails
   et utilisées comme clés Kafka, cette validation empêche toute injection de
   contenu ou clé anormale même par un client déjà authentifié.

5. Envoi d'email verrouillé côté serveur — les destinataires viennent
   EXCLUSIVEMENT de `MAIL_RECIPIENTS` : un champ `recipients` présent dans un
   message `sendEmail` est ignoré, pour que la passerelle ne serve pas de relais
   d'envoi. Les champs libres (`applicantName`, `appointmentDate`, `bookedAt`,
   `bookedBy`) sont refusés s'ils contiennent un caractère de contrôle
   (injection d'en-tête SMTP via un retour chariot dans le sujet) ou dépassent
   200 caractères.

### Fiabilité Kafka

- **Purge périodique et bornée** — le topic `appointment-found` (simple bus de
  diffusion éphémère) est purgé toutes les `KAFKA_PURGE_INTERVAL_MS` (défaut :
  30s) plutôt qu'après chaque message, pour éviter d'ouvrir/fermer une
  connexion admin Kafka à chaque RDV trouvé. La purge ne dépasse jamais le
  dernier offset **effectivement consommé** : un événement produit juste avant
  la purge mais pas encore diffusé ne peut donc pas être supprimé.
- **Santé réelle** — `/health` répond 503 (`degraded`) si le producteur ou le
  consommateur Kafka est hors service, au lieu d'annoncer `ok` alors que plus
  aucun événement ne circule.
- **Arrêt propre** — sur `SIGTERM`/`SIGINT`, les clients sont fermés avec le code
  1001 avant la déconnexion de Kafka, avec sortie forcée au bout de 10 s si une
  déconnexion se bloque.
- **groupId stable** — `KAFKA_CONSUMER_GROUP_ID` (défaut : `cev-avi-gateway`)
  ne change PAS entre redémarrages, contrairement à l'identifiant d'instance
  (aléatoire, visible dans les logs et le healthcheck). Cela permet à Kafka de
  retenir la position de lecture et d'éviter la perte d'un événement produit
  pendant un arrêt bref de la passerelle.
- **⚠️ Architecture mono-instance** — ce système suppose qu'**une seule**
  passerelle est active à la fois sur un même `KAFKA_CONSUMER_GROUP_ID`/broker.
  Avec plusieurs instances partageant le même groupId, Kafka **répartirait**
  les messages entre elles au lieu de les diffuser à toutes les fenêtres
  connectées (le broadcast actuel suppose un unique consommateur du groupe).
  Ne lancez jamais deux instances de passerelle simultanément sur le même
  groupId/broker.

### Extension (popup de configuration)

Cliquer sur l'icône de l'extension et renseigner (onglet « Serveur ») :

- **URL de la passerelle** : ex. `ws://localhost:8787` (ou `wss://...` en
  production).
- **Mot de passe** : doit correspondre exactement à `GATEWAY_AUTH_TOKEN` côté
  serveur. **Obligatoire** — sans URL et mot de passe valides, la passerelle
  refuse la connexion (401) et l'extension ne fonctionne pas (voir section
  Sécurité ci-dessus).

Le bouton **Tester** vérifie la connexion (URL + mot de passe) sans sauvegarder.

Dans l'onglet « Connexion » *(optionnel)* : **identifiant et mot de passe du
portail**, utilisés par `autoLogin.js` pour remplir et valider la page de
connexion. Les laisser vides désactive la connexion automatique.

### Reprise après blocage du portail

Quand le portail affiche `/Error/ErrorTooManyAttempts`, `tooManyAttempts.js`
demande au service worker d'effacer les données de navigation, puis relance le
parcours :

- le nettoyage est **total** (aucun filtre d'origine, `since: 0`) : cache HTTP,
  Cache Storage, cookies, `localStorage`, IndexedDB, service workers, fileSystems
  et WebSQL. Un nettoyage limité aux origines du portail laissait subsister des
  résidus (cookie tiers d'un CDN/WAF, cookie partitionné, domaine de redirection)
  qui maintenaient le blocage ;
- contrepartie assumée : les sessions des **autres** sites de ce profil Chrome
  sont fermées. Acceptable sur un profil dédié à l'automatisation ;
- ce qui n'est jamais touché : la configuration du popup (numéro internet, URL de
  la passerelle, identifiants de connexion) car elle vit dans
  `chrome.storage.local`, hors d'atteinte de `chrome.browsingData` ; ainsi que les
  mots de passe Chrome, l'historique et les données de formulaire, volontairement
  exclus ;
- un plafond de nettoyages par fenêtre de temps évite la boucle infinie
  « blocage → nettoyage → échec de connexion → blocage ». Une fois le plafond
  atteint, le nettoyage est **retenté automatiquement** dès qu'un créneau se
  libère, avec un badge de compte à rebours affiché en bas à droite de la page
  bloquée.

## Tests

Les tests unitaires couvrent la **logique pure** de la passerelle
(`server/gateway/logic.js`) : validation des messages (dont le durcissement de
`sendEmail` : types, caractères de contrôle, longueur), génération
d'identifiants, décision de rejeu, mutations du registre et comptage des clients.

Ils utilisent le runner intégré de Node 20 (`node:test`), **sans dépendance
externe**.

Avec Node installé localement :

```bash
cd server/gateway
npm test
```

Sans Node local, via Docker :

```bash
cd server/gateway
docker run --rm -v "$(pwd)":/app -w /app node:20-alpine node --test
```

> L'extension Chrome (content scripts) dépend fortement des APIs Chrome et du DOM
> des sites cibles ; elle est validée manuellement dans le navigateur.

## Publication de l'image Docker

Le script `server/publish.sh` construit et pousse l'image vers Docker Hub
(`eyano3535/avi-server`).

```bash
cd server
./publish.sh          # publie uniquement le tag "latest"
./publish.sh 1.1      # publie les tags "1.1" ET "latest"
```

Prérequis : être connecté (`docker login -u eyano3535`).

## Structure du projet

```
AVI_Server/AVI_ANA/
├── manifest.json              # Manifest Chrome MV3
├── background.js              # Service worker (WebSocket, coordination, keepalive)
├── client.js                  # Content script : sélection de créneau
├── applicationsPage.js        # Content script : résolution du dossier + déclenchement
├── editPage.js                # Content script : clic « Gérer votre rendez-vous »
├── pageBridge.js              # Pont AngularJS (monde MAIN)
├── multiSessionRedirect.js    # Redirections automatiques
├── autoLogin.js               # Connexion automatique au portail
├── tooManyAttempts.js         # Reprise après blocage anti-spam du portail
├── wsUrl.js                   # URL WebSocket authentifiée (partagé popup/background)
├── popup.html / popup.js      # Interface de configuration (URL + mot de passe)
├── icons/                     # Icônes de l'extension
└── server/
    ├── docker-compose.yml     # Kafka + passerelle (ne référence que des ${VAR})
    ├── .env.example           # Modèle de configuration (versionné, sans secrets)
    ├── .env                   # Secrets réels (NON versionné, à créer localement)
    ├── publish.sh             # Build & push Docker Hub
    └── gateway/
        ├── index.js           # Passerelle WebSocket ↔ Kafka (orchestration)
        ├── logic.js           # Logique pure (testable)
        ├── test/
        │   └── logic.test.js  # Tests unitaires (node:test)
        ├── package.json
        └── Dockerfile
```
