/* ============================================================================
 * Visor — Session side panel
 * ----------------------------------------------------------------------------
 * Shown instead of the Docs history panel while a writing session is running
 * (session-bg.js switches it). It frames the student's own document from the
 * Visor web app (/write/<assignment>?embed=panel) and hands that page the
 * student's tokens by postMessage, checking the origin both ways.
 * ==========================================================================*/

'use strict';

const $ = (id) => document.getElementById(id);
const DOC_URL = /^https:\/\/docs\.google\.com\/(document|presentation)\/d\//;
let state = null;
let frameOrigin = null;

function ask(type, extra = {}) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type, ...extra }, (r) => resolve(chrome.runtime.lastError ? null : r));
    } catch (_) { resolve(null); }
  });
}

function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

function tick() {
  if (!state || !state.active) return;
  const el = $('sp-timer');
  if (state.deadlineAt) el.textContent = `${clock(Date.parse(state.deadlineAt) - Date.now())} left`;
  else if (state.startedAt) el.textContent = clock(Date.now() - Date.parse(state.startedAt));
}

async function render() {
  const next = await ask('VISOR_PANEL_STATE');
  const was = state;
  state = next && next.active ? next : null;
  const active = !!state;
  $('sp-main').hidden = !active; $('sp-foot').hidden = !active; $('sp-rec').hidden = !active;
  $('sp-none').hidden = active;
  $('sp-title').textContent = active ? state.title : 'Visor';
  if (!active) { frameOrigin = null; $('sp-frame').removeAttribute('src'); return; }
  $('sp-recording').textContent = state.recording ? 'Recording research' : 'Research isn’t being recorded';
  // (Re)load the editor only when the session changed
  if (!was || was.docId !== state.docId || $('sp-frame').getAttribute('src') == null) {
    frameOrigin = state.origin;
    $('sp-frame').src = `${state.origin}/write/${encodeURIComponent(state.assignmentId)}?embed=panel`;
  }
  tick();
}

// The embedded editor says it's ready: give it the tokens (to its origin only)
window.addEventListener('message', (e) => {
  if (!frameOrigin || e.origin !== frameOrigin || e.source !== $('sp-frame').contentWindow) return;
  const m = e.data;
  if (m && m.source === 'visor-page' && m.type === 'EMBED_READY' && state) {
    e.source.postMessage({ source: 'visor-ext', type: 'EMBED_AUTH', sessionToken: state.sessionToken, extToken: state.extToken }, frameOrigin);
  }
});

// "Doc history": on a Google Doc, Visor's original panel for that document
async function updateDocLink() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  const onDoc = !!(tab && DOC_URL.test(tab.url || ''));
  $('sp-dochist').hidden = !onDoc || !state;
  $('sp-none-dochist').hidden = !onDoc || !!state;
}
const openDocHistory = () => { location.href = 'sidepanel.html'; };
$('sp-dochist').addEventListener('click', openDocHistory);
$('sp-none-dochist').addEventListener('click', openDocHistory);
chrome.tabs.onActivated.addListener(updateDocLink);
chrome.tabs.onUpdated.addListener((id, info) => { if (info.url) updateDocLink(); });

$('sp-what').addEventListener('click', () => {
  const list = $('sp-whatlist');
  list.hidden = !list.hidden;
  $('sp-what').setAttribute('aria-expanded', String(!list.hidden));
});

// The cite button (formatting and insertion happen in the editor)
$('sp-cite').addEventListener('click', async () => {
  const btn = $('sp-cite');
  btn.disabled = true;
  const status = $('sp-cite-status');
  status.className = 'sp-cite-status'; status.textContent = 'Reading this page…';
  const r = await ask('VISOR_CITE_ACTIVE', { from: 'panel' });
  btn.disabled = false;
  if (!r || !r.ok) { status.className = 'sp-cite-status warn'; status.textContent = (r && r.error) || 'Couldn’t read this page.'; return; }
  status.textContent = r.message || `Cited: ${r.meta && r.meta.title ? r.meta.title : 'this page'}`;
  setTimeout(() => { if (status.textContent.startsWith('Cited')) status.textContent = ''; }, 6000);
});

// The service worker sends citations here; pass them to the editor
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'VISOR_CITE_TO_PANEL') {
    if (!frameOrigin || !$('sp-frame').contentWindow) { sendResponse({ ok: false }); return false; }
    $('sp-frame').contentWindow.postMessage({ source: 'visor-ext', type: 'CITE', meta: msg.meta }, frameOrigin);
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

chrome.storage.onChanged.addListener((changes, area) => { if (area === 'session' && changes.visorSession) render().then(updateDocLink); });
setInterval(tick, 1000);
setInterval(render, 30000);
render().then(updateDocLink);
