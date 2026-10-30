/* ============================================================================
 * Visor — bridge between Visor's own pages and the extension
 * ----------------------------------------------------------------------------
 * Runs only on the Visor sites in config.js. The page (public/ext.js on the
 * site) posts { source:'visor-page', type, id, ... } to itself; this script
 * hands it to the service worker and posts the answer back as
 * { source:'visor-ext', replyTo: id, ... }. The page treats no answer within
 * 1.5 s as "not installed".
 *
 * It also marks <html data-visor-extension="<version>"> as soon as it loads,
 * so the page can tell the extension is here without a round trip.
 * ==========================================================================*/

'use strict';

(() => {
  if (!VISOR_WEB_ORIGINS.includes(location.origin)) return;

  const root = document.documentElement;
  root.dataset.visorExtension = chrome.runtime.getManifest().version;

  // After the extension is reloaded or turned off, this copy of the script is
  // orphaned: chrome.runtime.id goes away and sendMessage throws.
  const alive = () => { try { return !!chrome.runtime.id; } catch (_) { return false; } };

  function reply(id, data) {
    window.postMessage({ ...data, source: 'visor-ext', replyTo: id }, location.origin);
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const m = e.data;
    if (!m || m.source !== 'visor-page' || typeof m.type !== 'string' || !m.id) return;

    if (!alive()) {
      delete root.dataset.visorExtension;
      return reply(m.id, { gone: true, ok: false });
    }
    const { source, id, ...msg } = m;   // eslint-disable-line no-unused-vars
    try {
      chrome.runtime.sendMessage({ type: 'VISOR_SITE', msg }, (res) => {
        if (chrome.runtime.lastError || !res) return reply(id, { ok: false, error: 'The Visor extension didn’t answer.' });
        reply(id, res);
      });
    } catch (_) {
      delete root.dataset.visorExtension;
      reply(id, { gone: true, ok: false });
    }
  });
})();
