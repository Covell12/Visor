/* ============================================================================
 * Visor — Research capture (page)
 * ----------------------------------------------------------------------------
 * Registered on every site only while a writing session records research, and
 * unregistered when it ends (session-bg.js). It does one thing: when the
 * student copies text (20 characters or more), it tells the service worker,
 * which keeps a hash, the length and the first 140 characters, so a paste into
 * the essay can show which page it came from.
 *
 * It doesn't read the page and doesn't record keystrokes. It also answers the
 * cite button's request for the page's citation details (cite.js).
 * ==========================================================================*/

'use strict';

(function () {
  if (window.__visorResearchCapture) return;   // injected and registered: run once
  window.__visorResearchCapture = true;

  document.addEventListener('copy', (e) => {
    // A page's own script can fire a "copy" event over any text it selects,
    // without anything reaching the clipboard: only the browser's counts
    if (!e.isTrusted) return;
    let text = '';
    try { text = String(document.getSelection() ? document.getSelection().toString() : ''); } catch (_) { return; }
    if (text.trim().length < 20) return;
    try {
      chrome.runtime.sendMessage({ type: 'VISOR_RESEARCH_COPY', text: text.slice(0, 400000), len: text.length, url: location.href, title: document.title.slice(0, 300) }, () => { void chrome.runtime.lastError; });
    } catch (_) { /* the extension was reloaded: nothing to do */ }
  }, true);

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'GET_CITATION_META') {
      try { sendResponse({ ok: true, meta: self.VisorCite ? self.VisorCite.extractCitationMeta(document, location.href) : null }); }
      catch (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); }
    }
    return false;
  });
})();
