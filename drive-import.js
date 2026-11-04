/* ============================================================================
 * Visor — Add files from Google Drive (Visor Classroom)
 * ----------------------------------------------------------------------------
 * Opened from the side panel's Send to Visor box and from the toolbar popup.
 * The person picks a project and Google Docs and Slides files: links they
 * paste (Google Drive copies a selection of files as their links), or files
 * they have open in Chrome. drive.js reads the files one at a time, in this
 * browser, and their figures go to the project through the worker's
 * VISOR_SEND: the same route, and the same report, as Send to Visor.
 *
 * Everything shown that came from elsewhere (file and tab titles, project
 * names, what Visor's server says) is set as text, never parsed as HTML.
 * ==========================================================================*/

'use strict';

const MAX_FILES = 20;
// Failures that trying again won't change: those files are unticked after.
// The rest (too slow, closed, sign in first, Visor unreachable) stay ticked.
const FINAL = new Set(['view-only', 'uploaded', 'sheets', 'not-doc', 'empty']);
const DOC_TABS = ['https://docs.google.com/document/*', 'https://docs.google.com/presentation/*'];
const DRIVE_URL = 'https://drive.google.com/drive/recent';
const $ = (id) => document.getElementById(id);

const ICONS = {
  doc: '<svg viewBox="0 0 18 22" fill="none" aria-hidden="true"><path d="M2 1.5h9.5L16.5 6.5V20a.5.5 0 0 1-.5.5H2a.5.5 0 0 1-.5-.5V2a.5.5 0 0 1 .5-.5z" fill="currentColor" opacity=".16" stroke="currentColor"/><path d="M5 10h8M5 13h8M5 16h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  slides: '<svg viewBox="0 0 18 22" fill="none" aria-hidden="true"><path d="M2 1.5h9.5L16.5 6.5V20a.5.5 0 0 1-.5.5H2a.5.5 0 0 1-.5-.5V2a.5.5 0 0 1 .5-.5z" fill="currentColor" opacity=".16" stroke="currentColor"/><rect x="4.5" y="10" width="9" height="6.5" rx="1" stroke="currentColor" stroke-width="1.5"/></svg>',
  any: '<svg viewBox="0 0 18 22" fill="none" aria-hidden="true"><path d="M2 1.5h9.5L16.5 6.5V20a.5.5 0 0 1-.5.5H2a.5.5 0 0 1-.5-.5V2a.5.5 0 0 1 .5-.5z" fill="currentColor" opacity=".12" stroke="currentColor"/></svg>'
};

const state = {
  connected: false,
  origin: null,
  user: null,
  projects: [],
  sessionActive: false,
  files: new Map(),       // fileId → { fileId, kind, authuser, title, tabId, picked, checked, status, note }
  order: [],              // picked files, in the order they were added
  importing: false,
  stop: false,
  result: null,           // what the last import came to: { text, ok, link }
  current: null,          // the file being read
  readingTab: null,       // and the tab it's being read in (for its progress)
  ownedTabs: new Set(),   // tabs this page opened, kept out of "Open in Chrome"
  me: null                // this page's own tab, so files open beside it
};

function bg(msg) {
  return new Promise((resolve) => {
    try { chrome.runtime.sendMessage(msg, (r) => resolve(chrome.runtime.lastError ? null : r)); }
    catch (_) { resolve(null); }
  });
}

const kindName = (k) => (k === 'slides' ? 'Google Slides' : k === 'doc' ? 'Google Doc' : 'Google Drive file');
const label = (f) => f.title || `${kindName(f.kind)} …${f.fileId.slice(-6)}`;
const picked = () => state.order.map((id) => state.files.get(id)).filter(Boolean);
const openOnly = () => [...state.files.values()].filter((f) => !f.picked);
const chosen = () => [...picked(), ...openOnly()].filter((f) => f.checked);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ── Rendering ───────────────────────────────────────────────────────────────

function fileRow(f) {
  const li = document.createElement('li');
  li.className = `di-file${f.status ? ` is-${f.status}` : ''}`;
  li.dataset.id = f.fileId;

  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = !!f.checked;
  box.disabled = state.importing;
  box.setAttribute('aria-label', `Add ${label(f)}`);
  box.addEventListener('change', () => { f.checked = box.checked; updateGo(); });

  const icon = document.createElement('span');
  icon.className = `di-kind ${f.kind || 'any'}`;
  icon.innerHTML = ICONS[f.kind] || ICONS.any;   // constant markup, nothing from the file

  const main = document.createElement('div');
  main.className = 'di-file-main';
  const title = document.createElement('span');
  title.className = 'di-file-title';
  title.textContent = label(f);
  title.title = label(f);
  const sub = document.createElement('span');
  sub.className = 'di-file-sub';
  sub.textContent = f.note || (f.kind ? kindName(f.kind) : 'Google Drive link: Visor checks what it is when it opens it') + (f.tabId != null && f.picked ? ' · open in Chrome' : '');
  main.append(title, sub);

  li.append(box, icon, main);
  if (f.picked && !state.importing) {
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'di-remove';
    rm.textContent = '×';
    rm.setAttribute('aria-label', `Remove ${label(f)}`);
    rm.addEventListener('click', () => removePicked(f.fileId));
    li.append(rm);
  } else {
    li.append(document.createElement('span'));
  }
  return li;
}

function render() {
  $('di-picked').replaceChildren(...picked().map(fileRow));
  const open = openOnly();
  $('di-open').replaceChildren(...open.map(fileRow));
  $('di-open-empty').hidden = open.length > 0 || picked().some((f) => f.tabId != null);
  updateGo();
}

// One row, in place: during an import its status changes several times a file
function paint(f) {
  const old = document.querySelector(`.di-file[data-id="${CSS.escape(f.fileId)}"]`);
  if (old) old.replaceWith(fileRow(f));
}

function setRow(f, status, note) {
  f.status = status;
  f.note = note;
  paint(f);
}

function summary(text, ok, link) {
  const el = $('di-summary');
  el.className = `di-summary${ok === true ? ' is-ok' : ok === false ? ' is-err' : ''}`;
  el.textContent = text || '';
  if (link) {
    const a = document.createElement('a');
    a.className = 'di-link';
    a.href = link.href;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = link.text;
    el.append(' ', a);
  }
}

function banner(text) {
  $('di-banner').textContent = text || '';
  $('di-banner').hidden = !text;
}

// ── The project ─────────────────────────────────────────────────────────────

function target() {
  if (!$('di-project-list').hidden) {
    const p = state.projects.find((x) => x.id === $('di-project').value);
    return p ? { projectId: p.id, name: p.name } : null;
  }
  const code = $('di-code').value.trim().toUpperCase();
  return code ? { code } : null;
}

function projectNote() {
  const note = $('di-project-note');
  note.textContent = '';
  if (state.connected && state.projects.length) {
    if (state.user && (state.user.name || state.user.email)) note.textContent = `Connected to Visor as ${state.user.name || state.user.email}.`;
    return;
  }
  note.append(state.connected
    ? 'You aren’t in a Visor project yet. Type the project’s code, or ask your teacher to add you to it.'
    : 'Type the code your teacher gave the project, or ');
  if (!state.connected) {
    const a = document.createElement('a');
    a.className = 'di-link';
    a.href = `${VisorConfig.VISOR_DEFAULT_ORIGIN}/extension/connect`;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = 'connect the extension';
    note.append(a, ' to choose from your projects.');
  }
}

async function loadProject() {
  const st = await bg({ type: 'VISOR_SEND_STATE' });
  if (!st) {
    $('di-project-note').textContent = 'Visor didn’t answer. Close this tab and open it again from the Visor icon.';
    return;
  }
  state.connected = !!st.connected;
  state.origin = st.origin && VisorConfig.isVisorOrigin(`${st.origin}/`) ? st.origin : null;
  state.user = st.user || null;
  state.projects = Array.isArray(st.projects) ? st.projects : [];
  state.sessionActive = !!st.sessionActive;

  const useList = state.connected && state.projects.length > 0;
  $('di-project-list').hidden = !useList;
  $('di-project-code').hidden = useList;
  if (useList) {
    const sel = $('di-project');
    const keep = sel.value || new URLSearchParams(location.search).get('project');
    sel.replaceChildren(...state.projects.map((p) => {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.name;
      return o;
    }));
    if (keep && state.projects.some((p) => p.id === keep)) sel.value = keep;
  }
  projectNote();
  banner(state.sessionActive
    ? 'A Visor writing session is running. Add files once it has ended: during a session, Visor records the pages it opens as research.'
    : '');
  updateGo();
}

// ── Files ───────────────────────────────────────────────────────────────────

function takeLinks(text, html) {
  if (state.importing) return false;
  const r = VisorDrive.parse(text, html);
  if (!r.files.length && !r.rejected.length) return false;
  for (const p of r.files) {
    const had = state.files.get(p.fileId);
    if (had) {
      if (!had.picked) { had.picked = true; state.order.push(p.fileId); }
      had.checked = true;
      had.kind = had.kind || p.kind;
      had.title = had.title || p.title;
      had.authuser = had.authuser || p.authuser;
      continue;
    }
    state.files.set(p.fileId, { ...p, tabId: null, picked: true, checked: true, status: '', note: '' });
    state.order.push(p.fileId);
  }
  showRejected(r.rejected);
  render();
  return true;
}

function showRejected(list) {
  $('di-rejected').replaceChildren(...list.slice(0, 12).map((x) => {
    const li = document.createElement('li');
    const code = document.createElement('code');
    code.textContent = x.link.length > 120 ? `${x.link.slice(0, 117)}…` : x.link;
    li.append(code, x.reason);
    return li;
  }));
}

function removePicked(fileId) {
  const f = state.files.get(fileId);
  if (!f || state.importing) return;
  state.order = state.order.filter((id) => id !== fileId);
  if (f.tabId != null) { f.picked = false; f.checked = false; f.status = ''; f.note = ''; }   // back to "Open in Chrome"
  else state.files.delete(fileId);
  render();
}

// Docs and Slides open in Chrome: offered, not chosen
async function refreshOpenTabs() {
  if (state.importing) return;
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: DOC_TABS }); } catch (_) { tabs = []; }
  const seen = new Set();
  for (const t of tabs) {
    if (state.ownedTabs.has(t.id)) continue;
    const f = VisorDrive.fromTabUrl(t.url);
    if (!f || seen.has(f.fileId)) continue;
    seen.add(f.fileId);
    const title = VisorDrive.cleanTitle(t.title) || null;
    const had = state.files.get(f.fileId);
    if (had) {
      had.tabId = t.id;
      had.kind = had.kind || f.kind;
      if (title) had.title = title;
    } else {
      state.files.set(f.fileId, { ...f, authuser: null, title, tabId: t.id, picked: false, checked: false, status: '', note: '' });
    }
  }
  // Closed since: forgotten, unless chosen or there's something to say about it
  for (const [id, f] of state.files) {
    if (seen.has(id)) continue;
    f.tabId = null;
    if (!f.picked && !f.checked && !f.status) state.files.delete(id);
  }
  render();
}

// ── Adding them ─────────────────────────────────────────────────────────────

function updateGo() {
  const go = $('di-go');
  if (state.importing) {
    go.disabled = state.stop;
    go.textContent = state.stop ? 'Stopping after this file…' : 'Stop after this file';
    return;
  }
  const n = chosen().length;
  const t = target();
  go.textContent = !n ? 'Add files' : `Add ${plural(n, 'file')}${t && t.name ? ` to ${t.name}` : ''}`;
  go.disabled = !n || !t || state.sessionActive || n > MAX_FILES;
  // What stops the button, if anything does; otherwise what the last import came to
  if (n > MAX_FILES) summary(`Visor adds up to ${MAX_FILES} files at a time. Untick some, and add them next.`, false);
  else if (n && !t) summary('Type the project code first.');
  else if (state.result) summary(state.result.text, state.result.ok, state.result.link);
  else summary('');
}

// The worker's tabs API, with the files opened beside this page
const tabsApi = {
  async create(o) {
    const opts = { url: o.url, active: false };
    if (state.me) { opts.windowId = state.me.windowId; opts.openerTabId = state.me.id; }
    let tab;
    try { tab = await chrome.tabs.create(opts); } catch (_) { tab = await chrome.tabs.create({ url: o.url, active: false }); }
    state.ownedTabs.add(tab.id);
    return tab;
  },
  get: (id) => chrome.tabs.get(id),
  remove: (id) => chrome.tabs.remove(id),
  sendMessage: (id, msg) => chrome.tabs.sendMessage(id, msg)
};

// Leaving mid-import would stop it with a file half read
const guard = (e) => { e.preventDefault(); e.returnValue = ''; };

// While files are being added, the project and the list stay as they were
// when the button was pressed: the batch already has them
function lockInputs(on) {
  for (const id of ['di-project', 'di-code', 'di-paste', 'di-paste-add']) $(id).disabled = on;
}

async function run() {
  if (state.importing) { state.stop = true; updateGo(); return; }
  const t = target();
  const queue = chosen();
  if (!t || !queue.length || queue.length > MAX_FILES || state.sessionActive) return;

  state.importing = true;
  state.stop = false;
  state.result = null;
  summary('');
  for (const f of queue) { f.status = 'wait'; f.note = 'Waiting'; }
  render();
  lockInputs(true);
  window.addEventListener('beforeunload', guard);

  const sendTo = t.projectId ? { projectId: t.projectId } : { code: t.code };
  let added = 0;
  let stoppedBy = null;
  for (const f of queue) {
    if (state.stop) { f.status = ''; f.note = ''; paint(f); continue; }
    state.current = f;
    state.readingTab = null;
    const res = await VisorDrive.importFile(f, {
      tabs: tabsApi,
      send: (report) => bg({ type: 'VISOR_SEND', report, ...sendTo }),
      onStep: (s, extra) => {
        if (s === 'opening') setRow(f, 'busy', 'Opening it in a background tab…');
        else if (s === 'reading') { state.readingTab = extra.tabId; setRow(f, 'busy', 'Reading its history…'); }
        else if (s === 'sending') setRow(f, 'busy', 'Sending to Visor…');
      }
    });
    state.current = null;
    state.readingTab = null;
    if (res.ok) {
      added++;
      if (res.title) f.title = res.title;
      if (res.kind) f.kind = res.kind;
      f.checked = false;
      setRow(f, 'ok', `Added to ${(res.to || []).join(', ') || 'the project'}`);
    } else {
      if (FINAL.has(res.code)) f.checked = false;
      setRow(f, 'err', res.error);
      // Visor refused the project itself: every other file would fail the same way
      if (res.code === 'send' && /no project with that code|not in that project|isn.t connected|connect it again/i.test(res.error)) {
        stoppedBy = res.error;
        state.stop = true;
      }
    }
  }

  state.importing = false;
  state.stop = false;
  lockInputs(false);
  window.removeEventListener('beforeunload', guard);
  const tried = queue.filter((f) => f.status === 'ok' || f.status === 'err').length;
  const where = t.name || 'the project';
  const link = added && t.projectId && state.origin ? { href: `${state.origin}/project/${encodeURIComponent(t.projectId)}`, text: `Open ${where} on Visor ↗` } : null;
  state.result = stoppedBy ? { text: `Stopped: ${stoppedBy}`, ok: false, link }
    : added && added === tried ? { text: `Added ${plural(added, 'file')} to ${where}.`, ok: true, link }
    : added ? { text: `Added ${added} of ${plural(tried, 'file')} to ${where}. The others say why they weren’t added.`, ok: null, link }
    : tried ? { text: 'No files were added. Each one says why.', ok: false, link: null }
    : null;
  render();
  refreshOpenTabs();
}

// ── Wiring ──────────────────────────────────────────────────────────────────

// Reading progress from the content script, for the file being read
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== 'VISOR_PROGRESS' || !state.importing || !state.current) return;
  if (!sender || !sender.tab || sender.tab.id !== state.readingTab) return;
  if (msg.phase === 'fetch' && typeof msg.value === 'number') setRow(state.current, 'busy', `Reading its history… ${Math.round(Math.max(0, Math.min(1, msg.value)) * 100)}%`);
  else if (msg.phase === 'fold') setRow(state.current, 'busy', 'Replaying every edit…');
});

const paste = $('di-paste');
paste.addEventListener('paste', (e) => {
  const cd = e.clipboardData;
  if (!cd) return;
  // Drive's copied selection carries each file as a named link in its HTML
  if (takeLinks(cd.getData('text/plain'), cd.getData('text/html'))) e.preventDefault();
});
// Typed, or pasted where the clipboard had no links: read what's in the box
function addFromBox() {
  if (takeLinks(paste.value, '')) paste.value = '';
  else if (paste.value.trim()) showRejected([{ link: paste.value.trim().slice(0, 120), reason: 'There’s no link in that. Paste the links of the files.' }]);
}
paste.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.shiftKey) return;
  e.preventDefault();
  addFromBox();
});
$('di-paste-add').addEventListener('click', addFromBox);
for (const ev of ['dragenter', 'dragover']) paste.addEventListener(ev, (e) => { e.preventDefault(); paste.classList.add('is-over'); });
paste.addEventListener('dragleave', () => paste.classList.remove('is-over'));
paste.addEventListener('drop', (e) => {
  e.preventDefault();
  paste.classList.remove('is-over');
  const dt = e.dataTransfer;
  if (!dt) return;
  takeLinks([dt.getData('text/uri-list'), dt.getData('text/plain')].join('\n'), dt.getData('text/html'));
});

$('di-open-drive').addEventListener('click', () => { chrome.tabs.create({ url: DRIVE_URL }).catch(() => {}); });
$('di-project').addEventListener('change', updateGo);
$('di-code').addEventListener('input', updateGo);
$('di-go').addEventListener('click', run);

// Coming back from Drive (or from connecting the extension): look again
document.addEventListener('visibilitychange', () => {
  if (document.hidden || state.importing) return;
  refreshOpenTabs();
  loadProject();
});

// Closing the page mid-import: don't leave a background tab behind
window.addEventListener('pagehide', () => {
  for (const id of state.ownedTabs) { try { chrome.tabs.remove(id).catch(() => {}); } catch (_) { /* gone */ } }
});

(async () => {
  try { await visorInitTheme(); } catch (_) { /* light */ }
  try { state.me = await chrome.tabs.getCurrent(); } catch (_) { state.me = null; }
  render();
  await Promise.all([loadProject(), refreshOpenTabs()]);
  paste.focus();
})();
