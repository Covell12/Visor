/* Visor — which Visor sites the extension talks to.
 *
 * Loaded by the service worker (importScripts) and by site-bridge.js. Every
 * origin listed here must also be in manifest.json, in the `matches` of the
 * content script whose `js` includes site-bridge.js; the two lists must match
 * exactly. A Visor site not listed in both is ignored: the extension never
 * answers it and never accepts a token from it.
 *
 * For a local copy of the site (npm start), add 'http://localhost:3000' here
 * and 'http://localhost:3000/*' to the manifest, then reload the extension.
 */

'use strict';

// eslint-disable-next-line no-unused-vars
const VISOR_WEB_ORIGINS = [
  'https://visor-ed.web.app',
  'https://visor-ed.firebaseapp.com'
];

// eslint-disable-next-line no-unused-vars
const VISOR_DEFAULT_ORIGIN = 'https://visor-ed.web.app';
