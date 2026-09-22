/**
 * ==========================================================================
 * MODÈLE DE CONFIGURATION INTERNE — Extension Chrome CEV_AVI
 * ==========================================================================
 * Copiez ce fichier en `gatewayConfig.js` (même dossier) et renseignez le
 * jeton :
 *
 *   cp gatewayConfig.example.js gatewayConfig.js
 *
 * `gatewayConfig.js` est ignoré par Git : il contient un secret et ne doit
 * JAMAIS être committé. Sa valeur doit être identique à la variable
 * d'environnement `GATEWAY_AUTH_TOKEN` du serveur (voir server/.env.example).
 *
 * Chaîne vide = passerelle sans authentification (loopback uniquement).
 *
 * Rappel de sécurité : ce jeton est embarqué dans l'extension distribuée, donc
 * extractible par quiconque en possède une copie. Il protège contre les
 * connexions opportunistes depuis Internet, pas contre un utilisateur de
 * l'extension. Faites-le tourner s'il a pu fuiter.
 * ==========================================================================
 */

const GATEWAY_AUTH_TOKEN = '';
