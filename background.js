/* ============================================================================
 * Visor — Service Worker
 * ----------------------------------------------------------------------------
 * Deliberately almost empty.
 *
 * Visor makes no API calls, holds no credentials, and has no backend. All
 * reading and analysis happens in the content script, on the document's own
 * origin, in the user's own browser. This worker exists only to open the side
 * panel and to keep it pointed at the right tab.
 * ==========================================================================*/

'use strict';

const DOC_URL = /^https:\/\/docs\.google\.com\/(document|presentation)\/d\//;

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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
