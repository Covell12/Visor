/* ============================================================================
 * Visor — Site bridge
 * ----------------------------------------------------------------------------
 * Runs on the Visor web app's own pages (the origins in config.js, which must
 * match this script's "matches" in manifest.json). Relays between the page and
 * the extension:
 *
 *   page -> extension  window.postMessage({ source:'visor-page', type, id, … })
 *                      from this same origin only; forwarded to the service
 *                      worker, and its answer posted back as
 *                      { source:'visor-ext', replyTo:id, … }.
 *   extension -> page  { channel:'visor-to-page', … } from the service worker
 *                      (a citation for the editor) is posted to the page as
 *                      { source:'visor-ext', … }.
 *
 * It also marks the page with the extension's version, so the page can tell
 * the extension is installed without waiting for an answer.
 * ==========================================================================*/

'use strict';

(function () {
  const TYPES = ['PING', 'CONNECT', 'DISCONNECT', 'SESSION_START', 'SESSION_END', 'OPEN_PANEL', 'REQUEST_PERMISSION', 'RESEARCH_MODE'];
  let version = '';
  try { version = chrome.runtime.getManifest().version; } catch (_) { return; }
  document.documentElement.dataset.visorExtension = version;

  const reply = (id, body) => window.postMessage({ source: 'visor-ext', replyTo: id, ...body }, location.origin);

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const m = e.data;
    if (!m || m.source !== 'visor-page' || !TYPES.includes(m.type) || !m.id) return;
    const { source, id, type, ...payload } = m;
    try {
      chrome.runtime.sendMessage({ channel: 'visor-bridge', type, payload }, (res) => {
        const err = chrome.runtime.lastError;
        reply(id, err ? { ok: false, error: err.message } : (res || { ok: false }));
      });
    } catch (err) {
      // The extension was reloaded or turned off since this page loaded
      delete document.documentElement.dataset.visorExtension;
      reply(id, { ok: false, error: 'The Visor extension was turned off or updated. Reload this page.', gone: true });
    }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.channel !== 'visor-to-page') return false;
    const { channel, ...rest } = msg;
    window.postMessage({ source: 'visor-ext', ...rest }, location.origin);
    sendResponse({ ok: true });
    return false;
  });
})();
