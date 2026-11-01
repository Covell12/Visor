/* ============================================================================
 * Visor — Session side panel
 * ----------------------------------------------------------------------------
 * Shown instead of the Docs history panel while a writing session is running
 * (session-bg.js switches it). It frames the student's own document from the
 * Visor web app (/write/<assignment>?embed=panel) and hands that page the
 * student's tokens by postMessage, checking the origin both ways. It also
 * tells that page what only the extension can see (PANEL_CONTEXT): whether
 * Chrome has focus, and whether the tab in front is Visor's blocked page.
 *
 * The page tells this panel how writing stands (PANEL_STATUS: recording,
 * paused and why, or writing elsewhere), for the state chip at the top.
 *
 * Presence: while a session runs, each copy of this panel holds a port to the
 * service worker and says whether it's on screen. A locked session writing
 * here (research mode) only keeps its loosened rules while a copy is visible
 * (session-bg.js, panel presence).
 * ==========================================================================*/

'use strict';

const $ = (id) => document.getElementById(id);
const DOC_URL = /^https:\/\/docs\.google\.com\/(document|presentation)\/d\//;
let state = null;
let frameOrigin = null;
let frameLoaded = false;   // the editor in the frame has loaded

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
  if (state.deadlineAt) {
    const left = Date.parse(state.deadlineAt) - Date.now();
    el.textContent = `${clock(left)} left`;
    el.classList.toggle('low', left < 5 * 60 * 1000);
  } else if (state.startedAt) el.textContent = clock(Date.now() - Date.parse(state.startedAt));
}

const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// What this session lets the student open, in a line (and the allowed sites as chips)
function rulesHtml(st) {
  const ai = st.blockAiSites ? 'AI sites are blocked.' : 'AI sites are recorded, not blocked.';
  if (st.mode === 'locked' && st.researchMode) return `<b>Research mode.</b> Open any site except AI sites; everything is recorded. Closing this panel takes you back to full screen and the session’s allowed sites.`;
  if (st.mode === 'locked') {
    const sites = st.allowedSites || [];
    return sites.length ? `<b>Locked session.</b> Only these sites open. ${ai}<div class="sp-chips">${sites.map((x) => `<button type="button" class="sp-chip" data-site="${esc(x)}" title="Open ${esc(x)}">${esc(x)}</button>`).join('')}</div>`
      : `<b>Locked session.</b> Any site that isn’t blocked opens. ${ai}`;
  }
  return `<b>Open session.</b> ${ai}`;
}

// Opened as an ordinary tab (its address typed in): this page belongs in the
// side panel, so it loads no document there
let inTab = null;
async function render() {
  if (inTab == null) inTab = !!(await chrome.tabs.getCurrent().catch(() => null));
  if (inTab) {
    $('sp-main').hidden = true; $('sp-foot').hidden = true; $('sp-none').hidden = false;
    $('sp-none').querySelector('h2').textContent = 'This belongs in the side panel';
    $('sp-none').querySelector('p').textContent = 'Click the Visor icon in Chrome’s toolbar to open your document next to your research.';
    return;
  }
  const next = await ask('VISOR_PANEL_STATE');
  const was = state;
  state = next && next.active ? next : null;
  const active = !!state;
  $('sp-main').hidden = !active; $('sp-foot').hidden = !active;
  $('sp-none').hidden = active;
  $('sp-title').textContent = active ? state.title : 'Visor';
  presence(active);
  if (!active) { frameOrigin = null; frameLoaded = false; $('sp-frame').removeAttribute('src'); $('sp-sub').textContent = 'Writing session'; return; }
  const locked = state.mode === 'locked', research = locked && !!state.researchMode;
  $('sp-sub').textContent = research ? 'Locked session · writing here' : locked ? 'Locked session' : 'Open session';
  $('sp-recording').textContent = state.recording ? 'Recording research' : 'Research isn’t being recorded';
  $('sp-rec-dot').classList.toggle('off', !state.recording);
  $('sp-rules').innerHTML = rulesHtml(state);
  // One-click citing can be off for the assignment. Open Google shows where
  // Google isn't blocked: open sessions, and locked ones in research mode.
  // Back to full screen: a locked session writing here can go back any time.
  const cite = state.oneClickCite !== false;
  const google = !locked || research;
  $('sp-cite').hidden = !cite; $('sp-cite-status').hidden = !cite;
  $('sp-google').hidden = !google;
  $('sp-back').hidden = !research;
  // (Re)load the editor only when the session changed
  if (!was || was.docId !== state.docId || $('sp-frame').getAttribute('src') == null) {
    frameOrigin = state.origin;
    frameLoaded = false;
    $('sp-frame').src = `${state.origin}/write/${encodeURIComponent(state.assignmentId)}?embed=panel`;
  }
  tick();
}

// The embedded editor says it's ready: give it the tokens (to its origin only).
// It also says how writing stands, for the state chip.
const STATE_TEXT = { writing: 'Recording', paused: 'Paused', elsewhere: 'Writing in the Visor tab', waiting: 'Not started', ended: 'Session ended' };
window.addEventListener('message', (e) => {
  if (!frameOrigin || e.origin !== frameOrigin || e.source !== $('sp-frame').contentWindow) return;
  const m = e.data;
  if (m && m.source === 'visor-page' && m.type === 'EMBED_READY' && state) {
    frameLoaded = true;
    e.source.postMessage({ source: 'visor-ext', type: 'EMBED_AUTH', sessionToken: state.sessionToken, extToken: state.extToken }, frameOrigin);
    updateContext(true);
  }
  if (m && m.source === 'visor-page' && m.type === 'PANEL_STATUS' && STATE_TEXT[m.state]) {
    const chip = $('sp-state');
    chip.className = `sp-state ${m.state === 'writing' ? 'rec' : m.state === 'paused' ? 'paused' : 'idle'}`;
    $('sp-state-t').textContent = m.state === 'paused' && m.why ? `Paused: ${String(m.why).slice(0, 60)}` : STATE_TEXT[m.state];
  }
});
$('sp-frame').addEventListener('load', () => { frameLoaded = $('sp-frame').getAttribute('src') != null; });

// ── What the student is doing in Chrome (PANEL_CONTEXT) ────────────────────
// While the side panel holds the editing lease, time on other Chrome tabs is
// research, not time away. Leaving Chrome, or sitting on the blocked page,
// still counts as away. Sent after EMBED_AUTH, on every change and every 5 s.
const BLOCKED_PAGE = chrome.runtime.getURL('blocked.html');
const context = { chromeFocused: false, onBlockedPage: false };

function postContext() {
  const frame = $('sp-frame');
  if (!frameOrigin || !frameLoaded || !frame.contentWindow) return;
  frame.contentWindow.postMessage({ source: 'visor-ext', type: 'PANEL_CONTEXT', chromeFocused: context.chromeFocused, onBlockedPage: context.onBlockedPage }, frameOrigin);
}

// focused: already known (a window event said no Chrome window has focus)
async function updateContext(always, focused) {
  let chromeFocused = !!focused;
  if (focused == null) {
    try { chromeFocused = !!(await chrome.windows.getLastFocused({ windowTypes: ['normal'] })).focused; } catch (_) { chromeFocused = false; }
  }
  let onBlockedPage = false;
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    onBlockedPage = !!(tab && String(tab.url || '').startsWith(BLOCKED_PAGE));
  } catch (_) {}
  const changed = chromeFocused !== context.chromeFocused || onBlockedPage !== context.onBlockedPage;
  context.chromeFocused = chromeFocused; context.onBlockedPage = onBlockedPage;
  if (changed || always) postContext();
}
chrome.windows.onFocusChanged.addListener((windowId) => { updateContext(false, windowId === chrome.windows.WINDOW_ID_NONE ? false : undefined); });
chrome.tabs.onActivated.addListener(() => { updateContext(false); });
chrome.tabs.onUpdated.addListener((id, info) => { if (info.url || info.status) updateContext(false); });
setInterval(() => { updateContext(true); }, 5000);

// "Doc history": on a Google Doc, Visor's original panel for that document
async function updateDocLink() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  const onDoc = !!(tab && DOC_URL.test(tab.url || ''));
  // Not while a locked session writes here: leaving this panel ends research mode
  $('sp-dochist').hidden = !onDoc || !state || (state.mode === 'locked' && !!state.researchMode);
  $('sp-none-dochist').hidden = !onDoc || !!state;
}
const openDocHistory = () => { location.href = 'sidepanel.html'; };
$('sp-dochist').addEventListener('click', openDocHistory);
$('sp-none-dochist').addEventListener('click', openDocHistory);
chrome.tabs.onActivated.addListener(updateDocLink);
chrome.tabs.onUpdated.addListener((id, info) => { if (info.url) updateDocLink(); });

$('sp-what').addEventListener('click', () => {
  const wrap = $('sp-whatwrap'), open = !wrap.classList.contains('open');
  wrap.classList.toggle('open', open);
  $('sp-what').setAttribute('aria-expanded', String(open));
});
// An allowed site: open it in a new tab
$('sp-rules').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-site]');
  if (chip) chrome.tabs.create({ url: `https://${chip.dataset.site}` }).catch(() => {});
});
// Back to full screen: the Visor tab comes to the front, where one click
// takes the writing back and returns to full screen
$('sp-back').addEventListener('click', async () => {
  const id = state && state.visorTabId;
  const tab = id != null ? await chrome.tabs.get(id).catch(() => null) : null;
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
    chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  } else if (state) chrome.tabs.create({ url: `${state.origin}/write/${encodeURIComponent(state.assignmentId)}` }).catch(() => {});
});

// ── Presence: tell the service worker whether this copy is on screen ───────
// (and in which window: hidden because its window is minimized or behind
// another isn't the same as closed)
let port = null, pingTimer = null, windowId = null, quickDrops = 0;
chrome.windows.getCurrent().then((w) => { windowId = w && w.id; sendVisibility(); }).catch(() => {});
function sendVisibility() {
  try { port && port.postMessage({ type: 'visibility', visible: document.visibilityState === 'visible', windowId }); } catch (_) {}
}
function presence(on) {
  if (!on) {
    clearInterval(pingTimer); pingTimer = null;
    if (port) { const p = port; port = null; try { p.disconnect(); } catch (_) {} }
    return;
  }
  if (port) return;
  const at = Date.now();
  try { port = chrome.runtime.connect({ name: 'visor-session-panel' }); } catch (_) { port = null; return; }
  // The worker restarted (or was updated): connect again. Refused straight
  // away again and again: back off rather than knock every second.
  port.onDisconnect.addListener(() => {
    port = null; void chrome.runtime.lastError;
    quickDrops = Date.now() - at < 1000 ? quickDrops + 1 : 0;
    setTimeout(() => { if (state) presence(true); }, quickDrops > 3 ? 30000 : 800);
  });
  sendVisibility();
  // A message every 20 s keeps the worker listening while the panel is open
  clearInterval(pingTimer);
  pingTimer = setInterval(() => { try { port && port.postMessage({ type: 'ping' }); } catch (_) {} }, 20000);
}
document.addEventListener('visibilitychange', sendVisibility);

// ── This page's reliability grade (source-grade.js) ────────────────────────
// The tab in front, graded from its address, updated as the student moves
// between pages. Not for Visor itself, extension pages or a blank tab.
let gradeUrl = null;
const gradeOf = (src) => { try { return VisorSourceGrade.grade(src); } catch (_) { return null; } };
function gradeNotes(g) {
  const mark = { 1: '+', '-1': '−', 0: '•' };
  return `<p>${esc(g.why)}</p>${g.notes.length ? `<ul>${g.notes.map((n) => `<li><i class="e${n.effect}">${mark[n.effect]}</i>${esc(n.text)}</li>`).join('')}</ul>` : ''}
    <p class="sp-grade-how">Visor grades a page by the kind of site it’s on. It doesn’t read the page or check its facts: it’s a place to start, and you decide whether to trust it. Citing it can add the author and date.</p>`;
}
async function updateGrade() {
  const card = $('sp-grade');
  let tab = null;
  try { [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); } catch (_) {}
  const url = (tab && tab.url) || '';
  const g = state && /^https?:/i.test(url) && !VisorConfig.isVisorOrigin(url) ? gradeOf({ type: 'webpage', url, authors: [] }) : null;
  if (!g) { card.hidden = true; gradeUrl = null; return; }
  if (url === gradeUrl && !card.hidden) return;
  gradeUrl = url;
  card.hidden = false;
  card.className = `sp-card sp-grade g-${g.letter}`;
  $('sp-grade-letter').textContent = g.letter;
  $('sp-grade-word').textContent = `This page: ${g.letter} · ${g.word}`;
  $('sp-grade-label').textContent = `${g.label}${g.host ? ` · ${g.host}` : ''}`;
  $('sp-grade-more').innerHTML = gradeNotes(g);
}
$('sp-grade-btn').addEventListener('click', () => {
  const more = $('sp-grade-more'), open = more.hidden;
  more.hidden = !open;
  $('sp-grade-btn').setAttribute('aria-expanded', String(open));
});
chrome.tabs.onActivated.addListener(() => { updateGrade(); });
chrome.tabs.onUpdated.addListener((id, info) => { if (info.url) updateGrade(); });
chrome.windows.onFocusChanged.addListener(() => { updateGrade(); });

// The cite button (formatting and insertion happen in the editor)
$('sp-cite').addEventListener('click', async () => {
  const btn = $('sp-cite');
  btn.disabled = true;
  const status = $('sp-cite-status');
  status.className = 'sp-cite-status'; status.textContent = 'Reading this page…';
  const r = await ask('VISOR_CITE_ACTIVE', { from: 'panel' });
  btn.disabled = false;
  if (!r || !r.ok) { status.className = 'sp-cite-status warn'; status.textContent = (r && r.error) || 'Couldn’t read this page.'; return; }
  status.className = 'sp-cite-status ok';
  const cg = r.meta ? gradeOf(r.meta) : null;
  status.textContent = (r.message || `Cited: ${r.meta && r.meta.title ? r.meta.title : 'this page'}`) + (cg ? ` · Reliability ${cg.letter} (${cg.word})` : '');
  setTimeout(() => { if (status.textContent.startsWith('Cited')) status.textContent = ''; }, 6000);
});

// Open Google: a new tab to research from
$('sp-google').addEventListener('click', () => { chrome.tabs.create({ url: 'https://www.google.com/' }).catch(() => {}); });

// The service worker sends citations here; pass them to the editor
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'VISOR_CITE_TO_PANEL') {
    // Chrome may keep a copy of this panel for each tab: only the one on
    // screen takes the citation (a hidden copy stays silent, so it can't
    // answer for the one that matters)
    if (document.hidden) return false;
    if (!frameOrigin || !$('sp-frame').contentWindow) { sendResponse({ ok: false }); return false; }
    $('sp-frame').contentWindow.postMessage({ source: 'visor-ext', type: 'CITE', meta: msg.meta }, frameOrigin);
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

chrome.storage.onChanged.addListener((changes, area) => { if (area === 'session' && changes.visorSession) render().then(updateDocLink).then(updateGrade); });
setInterval(tick, 1000);
setInterval(render, 30000);
render().then(updateDocLink).then(updateGrade);
