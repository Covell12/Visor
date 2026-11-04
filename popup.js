/* Visor — toolbar popup. Reports what Visor can do with the current tab. */

'use strict';

const DOC_URL = /^https:\/\/docs\.google\.com\/(document|presentation)\/d\//;

const dot    = document.getElementById('dot');
const status = document.getElementById('status');
const open   = document.getElementById('open');

function set(cls, text, enabled) {
  dot.className = `p-dot ${cls}`;
  status.textContent = text;
  open.disabled = !enabled;
}

// The Visor account this browser is connected to (from the site's
// /extension/connect page). Most people using Docs history have none, so
// nothing shows until there is one.
chrome.storage.local.get('visorAuth', ({ visorAuth: auth }) => {
  if (!auth || !auth.token || (auth.expiresAt && auth.expiresAt <= Date.now())) return;
  const name = auth.user && (auth.user.name || auth.user.email);
  document.getElementById('accountName').textContent = name ? `Connected to Visor as ${name}` : 'Connected to Visor';
  document.getElementById('account').hidden = false;
  // Visor Classroom: Docs and Slides files from Google Drive, for a group project
  if (globalThis.VISOR_EDITION !== 'docs') document.getElementById('drive').hidden = false;
});

document.getElementById('drive').addEventListener('click', async () => {
  if (globalThis.VISOR_EDITION === 'docs') return;
  try { await chrome.tabs.create({ url: chrome.runtime.getURL('drive-import.html') }); } catch (_) { /* nothing to open it in */ }
  window.close();
});

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab || !DOC_URL.test(tab.url || '')) {
    return set('p-dot-off', 'Open a Google Doc or Slides file.', false);
  }

  chrome.tabs.sendMessage(tab.id, { type: 'VISOR_STATUS' }, (resp) => {
    if (chrome.runtime.lastError || !resp) {
      return set('p-dot-off', 'Reload the document tab to attach Visor.', false);
    }
    if (resp.state === 'view-only') {
      return set('p-dot-lock', 'View-only access — history is hidden.', false);
    }
    set('p-dot-ok', 'Ready to analyze this document.', true);
  });

  open.addEventListener('click', async () => {
    // Routed through the worker so the panel is recorded as belonging to this
    // tab. Opening it directly leaves that unset, and the next tab sync closes
    // it again on the assumption it was left over from somewhere else.
    let res = null;
    try {
      res = await chrome.runtime.sendMessage({ type: 'OPEN_SIDE_PANEL', tabId: tab.id });
    } catch (_) { /* the worker was asleep; it is awake now */ }

    // Chrome refuses to open a panel outside a user gesture, and waking a
    // sleeping worker can outlast the one that was just made. Say so instead
    // of closing on a click that did nothing.
    if (res && res.ok === false) {
      return set('p-dot-lock', 'Chrome was still waking up — click again.', true);
    }
    window.close();
  });
})();
