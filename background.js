/* ============================================================================
 * Visor — Service Worker
 * ----------------------------------------------------------------------------
 * Deliberately almost empty.
 *
 * All reading and analysis happens in the content script, on the document's
 * own origin, in the user's own browser. This worker opens the side panel,
 * keeps it pointed at the right tab, and answers the Visor site
 * (site-bridge.js): connecting the extension to a Visor account keeps that
 * account's extension token here, in chrome.storage.local.
 * ==========================================================================*/

'use strict';

importScripts('config.js');

const DOC_URL = /^https:\/\/docs\.google\.com\/(document|presentation)\/d\//;

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'VISOR_SITE') {
    handleSite(msg.msg || {}, sender)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;   // responding asynchronously
  }
  if (msg && msg.type === 'OPEN_SIDE_PANEL') {
    // The popup has no sender.tab, so it names the tab explicitly. Both routes
    // must come through here, or the panel opens without being recorded as
    // belonging to that tab and the next sync immediately closes it again.
    const tabId = (sender.tab && sender.tab.id) != null ? sender.tab.id : msg.tabId;
    if (tabId != null) {
      openedFor = tabId;
      panelEnabled.delete(tabId);
      // Must precede open(): a tab whose stored options say enabled:false has
      // no panel for open() to show.
      chrome.sidePanel
        .setOptions({ tabId, path: 'sidepanel.html', enabled: true })
        .catch(() => {});
      panelEnabled.set(tabId, true);

      // Report what actually happened. open() must be called inside the user's
      // gesture, and after the laptop sleeps this worker is dead — the click
      // has to cold-start it, and the gesture can expire during that boot.
      // Chrome then rejects open(), and saying ok:true here left the page
      // believing the panel had opened when nothing had happened at all.
      chrome.sidePanel.open({ tabId })
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
      return true;   // responding asynchronously
    }
    sendResponse({ ok: false, error: 'no tab' });
    return false;
  }
  // Progress events from the content script are broadcast; the side panel
  // listens for them directly. Nothing to do here.
  return false;
});

/**
 * Keep the side panel enabled only on documents Visor can actually read.
 *
 * Call this ONLY when the answer changes. Docs rewrites its URL constantly
 * while you work (heading anchors, `?tab=t.xxxx`, cursor state), and every one
 * of those fires tabs.onUpdated with `info.url`. Calling setOptions on each
 * re-navigated the side panel, blanking it for a few hundred milliseconds,
 * several times a minute. That repaints nothing on the Docs page itself, which
 * is why DevTools paint flashing there never showed it.
 *
 * `path` must be sent. A tab-specific entry written with `enabled: true` and no
 * path does not fall back to the manifest's `default_path` — Chrome finds the
 * tab entry, sees no usable panel, and sidePanel.open() then does nothing.
 * Dropping it is what stopped the toolbar button from opening anything.
 */
const panelEnabled = new Map();   // tabId -> last value we set

// The panel belongs to the tab it was opened from. Switching to any other tab
// closes it, rather than leaving it up showing a document you are no longer
// looking at — Chrome has no sidePanel.close(), so disabling it for the tab you
// switch to is what shuts it.
let openedFor = null;

async function syncPanel(tabId, url) {
  const enabled = DOC_URL.test(url || '') && tabId === openedFor;
  if (panelEnabled.get(tabId) === enabled) return;
  panelEnabled.set(tabId, enabled);
  try {
    await chrome.sidePanel.setOptions({ tabId, path: 'sidepanel.html', enabled });
  } catch (_) {
    panelEnabled.delete(tabId);   // tab closed mid-flight; do not cache a lie
  }
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  // A reload or a real navigation ends the panel's claim on this tab, so it
  // comes back closed rather than reattaching to a document being rebuilt.
  // `info.status === 'loading'` is the reload signal; `info.url` alone is the
  // in-place rewriting Docs does constantly and must not count.
  if (info.status === 'loading' && openedFor === tabId) openedFor = null;

  if (info.url || info.status === 'loading') syncPanel(tabId, tab.url);
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    syncPanel(tabId, tab.url);
  } catch (_) { /* gone */ }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  panelEnabled.delete(tabId);
  if (openedFor === tabId) openedFor = null;
});

/* ============================================================================
 * The Visor site (site-bridge.js → here)
 * ----------------------------------------------------------------------------
 * The site's /extension/connect page asks the server for an extension token
 * while the person is signed in, then sends it here with CONNECT. What is kept:
 *   visorAccount: { token, user: { id, name, email, role }, origin, expiresAt }
 * The token is never handed back to a page.
 * ==========================================================================*/

const ACCOUNT_KEY = 'visorAccount';

// Only the bridge on a listed Visor site may talk to this; not other
// extensions, and not this extension's own pages.
function siteOrigin(sender) {
  if (!sender || sender.id !== chrome.runtime.id || !sender.tab || !sender.url) return null;
  let origin;
  try { origin = new URL(sender.url).origin; } catch (_) { return null; }
  return VISOR_WEB_ORIGINS.includes(origin) ? origin : null;
}

// The token is "<base64url JSON>.<signature>"; the JSON carries exp (ms).
function tokenExpiry(token) {
  try {
    const body = token.slice(0, token.lastIndexOf('.')).replace(/-/g, '+').replace(/_/g, '/');
    const exp = JSON.parse(atob(body)).exp;
    return typeof exp === 'number' ? exp : null;
  } catch (_) { return null; }
}

async function getAccount() {
  const { [ACCOUNT_KEY]: acc } = await chrome.storage.local.get(ACCOUNT_KEY);
  if (!acc || !acc.token) return null;
  if (acc.expiresAt && acc.expiresAt <= Date.now()) {
    await chrome.storage.local.remove(ACCOUNT_KEY);
    return null;
  }
  return acc;
}

function cleanUser(u) {
  if (!u || typeof u !== 'object' || !u.id) return null;
  const s = (v) => (v == null ? '' : String(v).slice(0, 200));
  return { id: s(u.id), name: s(u.name), email: s(u.email), role: s(u.role) };
}

const UNSUPPORTED = 'This version of the Visor extension can connect to your account, but doesn’t run writing sessions yet.';

async function handleSite(msg, sender) {
  const origin = siteOrigin(sender);
  if (!origin) return { ok: false, error: 'not a Visor page' };
  const version = chrome.runtime.getManifest().version;

  switch (msg.type) {
    case 'PING': {
      const acc = await getAccount();
      // An account connected on another Visor address doesn't count here:
      // its token belongs to that server.
      const connected = !!acc && acc.origin === origin;
      return {
        ok: true,
        version,
        connected,
        user: connected ? acc.user : null,
        // Research recording, the allowed-sites lock and sessions aren't in
        // this version, so it never claims them.
        hasHostPermission: false,
        lockActive: false,
        session: null
      };
    }

    case 'CONNECT': {
      const token = typeof msg.token === 'string' ? msg.token : '';
      const user = cleanUser(msg.user);
      if (!token || token.length > 4096 || !user) return { ok: false, error: 'Visor sent no account to connect.' };
      const expiresAt = tokenExpiry(token);
      await chrome.storage.local.set({ [ACCOUNT_KEY]: { token, user, origin, expiresAt, connectedAt: Date.now() } });
      return { ok: true, connected: true, user, version };
    }

    case 'DISCONNECT':
      await chrome.storage.local.remove(ACCOUNT_KEY);
      return { ok: true, connected: false };

    case 'REQUEST_PERMISSION':
      return { ok: false, granted: false, error: UNSUPPORTED };

    case 'SESSION_START':
    case 'SESSION_END':
    case 'OPEN_PANEL':
    case 'RESEARCH_MODE':
      return { ok: false, unsupported: true, error: UNSUPPORTED };

    default:
      return { ok: false, error: `unknown request: ${String(msg.type).slice(0, 40)}` };
  }
}
