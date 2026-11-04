/* ============================================================================
 * Visor — Content Script
 * ----------------------------------------------------------------------------
 * The only place in the extension that touches the network, and it only ever
 * talks to the origin of the document you already have open.
 *
 * Responsibilities:
 *   • decide whether this user may see revision history at all (editors only)
 *   • pull and fold the document's native mutation log
 *   • own the in-memory timeline and serve it to the side panel and replay
 *   • inject the Visor launcher and the glass HUD
 * ==========================================================================*/

'use strict';

const VISOR_BTN_ID  = 'visor-launch-btn';
const VISOR_HUD_ID  = 'visor-hud';
const VISOR_TAB_ID  = 'visor-hud-tab';
const PROBE_CHANNEL = 'VISOR_PAGE_PROBE';

// ── Document identity ────────────────────────────────────────────────────────

function getDocKind() {
  const p = location.pathname;
  if (p.includes('/document/')) return 'doc';
  if (p.includes('/presentation/')) return 'slides';
  return null;
}

function getFileId() {
  const m = location.pathname.match(/\/(document|presentation)\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[2] : null;
}

/**
 * The person signed in to this Doc, from Google's account button, whose label
 * reads "Google Account: Name (address)" (the first word changes with the
 * language; the name and the address in brackets don't). Used only to name
 * their own edits when Google's revision roster leaves them nameless.
 */
function signedInPerson() {
  try {
    const el = document.querySelector('a[aria-label*="@"][href*="accounts.google.com"], [aria-label^="Google Account"]');
    const label = el && el.getAttribute('aria-label');
    if (!label) return null;
    const m = /:\s*([^(\n]+?)\s*\(([^)\s]+@[^)\s]+)\)/.exec(label.replace(/\s+/g, ' '));
    if (!m) return null;
    return { name: m[1].trim(), email: m[2].trim() };
  } catch (_) {
    return null;
  }
}

// ── Access control ───────────────────────────────────────────────────────────
//
// Revision history is an editor-level capability. Visor mirrors that exactly:
// if you cannot edit the document, Visor will not show you who wrote it, when,
// or what they deleted. The check fails closed — anything short of positive
// evidence of edit access is treated as view-only.

let probeResult = { editable: null, revisionHint: 0, liveTabs: [], ready: false };

/** Ask the page probe to report again — after an SPA navigation, it must. */
function askPageProbe() {
  try {
    window.postMessage({ source: `${PROBE_CHANNEL}_REQUEST` }, window.location.origin);
  } catch (_) { /* nothing to do */ }
}

window.addEventListener('message', (e) => {
  if (e.source !== window) return;
  if (!e.data || e.data.source !== PROBE_CHANNEL) return;
  probeResult = {
    editable: e.data.editable,
    revisionHint: e.data.revisionHint || 0,
    liveTabs: Array.isArray(e.data.liveTabs) ? e.data.liveTabs : [],
    ready: !!e.data.ready
  };
});

/** DOM evidence that the editing surface — not the viewing surface — is present. */
function domSaysEditable() {
  // A view-only document carries an explicit badge in the title bar.
  const badge = document.querySelector('.docs-titlebar-badge, .docs-title-input-label-inner');
  if (badge && /view only|read only/i.test(badge.textContent || '')) return false;

  // Viewers get no editing menus. Editors always have Insert and Format.
  const menubar = document.querySelector('#docs-menubar, .docs-menubar');
  if (menubar) {
    const labels = [...menubar.querySelectorAll('[role="menuitem"], .menu-button')]
      .map((el) => (el.textContent || '').trim().toLowerCase());
    if (labels.length) {
      const hasEditingMenus = labels.includes('insert') && labels.includes('format');
      if (!hasEditingMenus) return false;
    }
  }

  // The editable canvas itself.
  const canvas = document.querySelector(
    '.kix-appview-editor [contenteditable="true"], .docs-texteventtarget-iframe, ' +
    '#docs-editor [contenteditable="true"]'
  );
  if (canvas) return true;

  // Slides: the filmstrip is only interactive for editors.
  if (getDocKind() === 'slides' && document.querySelector('#punch-filmstrip-thumbnail-list')) {
    return !document.querySelector('[aria-label*="View only" i]');
  }

  return menubar ? true : null;
}

/**
 * Combined verdict: 'editor' | 'viewer' | 'unknown'.
 *
 * Any negative signal is decisive — that is the fail-closed half. When the page
 * gives us nothing to go on we return 'unknown' and let the revision endpoint
 * itself arbitrate, since it enforces the same rule server-side and cannot be
 * fooled by a selector that changed name. A viewer's request returns nothing,
 * which we then surface as view-only.
 */
function accessVerdict() {
  if (probeResult.editable === false) return 'viewer';
  const dom = domSaysEditable();
  if (dom === false) return 'viewer';
  if (probeResult.editable === true || dom === true) return 'editor';
  return 'unknown';
}

// ── Analysis lifecycle ───────────────────────────────────────────────────────

let timeline = null;   // fold of the current selection, kept for replay
let analysis = null;   // derived stats for the current selection
let running  = false;
let lastError = null;

// Retained so a tab filter can be re-applied without re-fetching the log.
let allEntries = [];
/* Set when the extension has been reloaded out from under this page: see
 * visorShutdown(). Everything that builds UI checks it, because a timeout
 * scheduled before the shutdown would otherwise put the bar back. */
let visorStopped = false;
let lastRevisionSeen = 0;   // the newest revision the current analysis covers
/* Bumped whenever Visor starts over on a different document. Anything that was
 * already in flight compares it on the way back and throws its result away:
 * the alternative is a reply about the last document being written into this
 * one's state, or a bar appearing over a document nobody opened it on. */
let docGeneration = 0;
let allUsers   = [];
/*
 * Which document tab the figures cover.
 *
 *   pick      what the user chose: 'current' (the default), null for all tabs,
 *             or a specific tab id
 *   selected  what that resolves to at this moment: null or a tab id
 *
 * They differ only in 'current' mode, where `selected` follows whichever tab
 * the user is looking at in Docs and `pick` stays 'current'.
 */
const PICK_CURRENT = 'current';
let tabState = { tabs: [], resolvable: false, pick: PICK_CURRENT, selected: null };

/** The Docs tab on screen, from the address bar; null when there is only one. */
function currentDocTab() {
  const ids = tabState.tabs.map((t) => t.id);
  if (ids.length < 2) return null;
  let param = null;
  try { param = new URL(location.href).searchParams.get('tab'); } catch (_) { /* keep null */ }
  // A tab we have no history for yet — created since the log was read — is
  // still the tab being viewed. It resolves to an empty selection, which is
  // the truth, rather than silently borrowing another tab's figures.
  if (param) return param;
  // No tab in the address: Docs is showing its first tab.
  return ids.includes('t.0') ? 't.0' : ids[0];
}

function normalizePick(pick) {
  if (pick === PICK_CURRENT) return PICK_CURRENT;
  if (!pick) return null;
  return tabState.tabs.some((t) => t.id === pick) ? pick : PICK_CURRENT;
}

function resolvePick(pick) {
  return pick === PICK_CURRENT ? currentDocTab() : (pick || null);
}

function broadcast(msg) {
  try { chrome.runtime.sendMessage(msg); } catch (_) { /* panel closed */ }
}

async function runAnalysis(force = false) {
  const fileId = getFileId();
  const kind   = getDocKind();
  if (!fileId || !kind) return { state: 'no-document' };

  if (accessVerdict() === 'viewer') {
    timeline = null;
    analysis = null;
    clearFoldCache();
    return { state: 'view-only' };
  }

  // Same shape as the cold path below. This used to hand back the raw analysis
  // and no tabState: the untrimmed pastes and deletions carry their full 4,000
  // character bodies across the message boundary, and a missing tabState makes
  // the panel's scope selector disappear on any re-open.
  if (analysis && !force) {
    return {
      state: 'ready',
      analysis: compactAnalysis(analysis),
      meta: docMeta(),
      tabState: tabInfo()
    };
  }
  if (running) return { state: 'running' };

  running = true;
  lastError = null;
  // Which document this read belongs to. Reading takes seconds, and Docs can
  // move to another document inside that window — the reply would then be
  // written into the new document's state and drawn over its bar.
  const startedOn = docKey();
  const startedGen = docGeneration;
  broadcast({ type: 'VISOR_PROGRESS', phase: 'fetch', value: 0 });

  try {
    const { entries, users, lastRevision, diagnostics, tabs } = await VisorChangelog.fetchChangelog(
      fileId, kind,
      {
        revisionHint: probeResult.revisionHint,
        liveTabs: probeResult.liveTabs,
        me: signedInPerson(),
        onProgress: (v) => broadcast({ type: 'VISOR_PROGRESS', phase: 'fetch', value: v })
      }
    );

    if (docKey() !== startedOn || docGeneration !== startedGen) {
      running = false;
      return { state: 'stale' };          // this reply is about the last document
    }

    if (!entries.length) {
      running = false;
      // No log despite apparent edit access — treat as locked rather than empty.
      return { state: lastRevision ? 'empty' : 'view-only' };
    }

    allEntries = entries;
    lastRevisionSeen = lastRevision || 0;
    lastReadAt = Date.now();
    clearFoldCache();   // folds cached against the previous log are now wrong
    allUsers   = users;
    // The roster is read from the edit stream itself, so per-tab figures are
    // always real when the document has tabs — nothing is inferred.
    const keptPick = tabState.pick;
    tabState = {
      tabs: (tabs || []).filter((t) => !t.deleted),
      deletedTabs: (tabs || []).filter((t) => t.deleted),
      resolvable: true,
      pick: PICK_CURRENT,
      selected: null
    };
    // A refresh keeps whatever the user had chosen, provided that tab still
    // exists; the first read of a document starts in current-tab mode.
    tabState.pick = normalizePick(keptPick === undefined ? PICK_CURRENT : keptPick);
    tabState.selected = resolvePick(tabState.pick);

    broadcast({ type: 'VISOR_PROGRESS', phase: 'fold', value: 0.7 });
    buildForSelection(lastRevision, diagnostics);

    running = false;
    broadcast({ type: 'VISOR_PROGRESS', phase: 'done', value: 1 });

    renderHUD(analysis);
    autoSendReport();
    return {
      state: 'ready',
      analysis: compactAnalysis(analysis),
      meta: docMeta(),
      tabState: tabInfo()
    };
  } catch (err) {
    running = false;
    lastError = String(err && err.message ? err.message : err);
    return { state: 'error', error: lastError };
  }
}

/**
 * Fold and analyse whatever the current tab selection covers.
 *
 * A tab's edits index into that tab's own buffer, so a selection is folded from
 * that tab's ops alone rather than sliced out of the whole-document fold —
 * otherwise every position after the first omitted edit would be wrong.
 */
/**
 * Folds already computed, keyed by tab selection.
 *
 * Switching scope used to re-fold the whole log every time, including switching
 * back to a tab just looked at. A fold is the most expensive thing Visor does
 * and it runs on the Docs page's own heap, so repeating it is exactly the load
 * that made the editor stutter. Held to a few entries because each one retains
 * its own steps and keyframes; beyond that the memory costs more than the work
 * it saves.
 */
const FOLD_CACHE_MAX = 3;
const foldCache = new Map();

function clearFoldCache() { foldCache.clear(); }

function buildForSelection(lastRevision, diagnostics) {  // eslint-disable-line
  const sel = tabState.selected;
  const key = sel || '';

  const hit = foldCache.get(key);
  if (hit) {
    // Refresh recency: Map preserves insertion order, so re-set moves it last.
    foldCache.delete(key);
    foldCache.set(key, hit);
    timeline = hit.timeline;
    analysis = hit.analysis;
  } else {
    timeline = VisorChangelog.buildTimeline(allEntries, allUsers, sel ? { tab: sel } : undefined);
    analysis = VisorChangelog.analyze(timeline);
    foldCache.set(key, { timeline, analysis });
    while (foldCache.size > FOLD_CACHE_MAX) {
      foldCache.delete(foldCache.keys().next().value);
    }
  }

  analysis.lastRevision = lastRevision != null ? lastRevision : (analysis.lastRevision || 0);
  analysis.analyzedAt = Date.now();
  if (diagnostics) analysis.diagnostics = diagnostics;
  analysis.tabState = tabInfo();
}

/** What the UI needs to render its tab selectors. */
function tabInfo() {
  return {
    tabs: tabState.tabs.map((t) => ({ id: t.id, title: t.title })),
    resolvable: tabState.resolvable,
    selected: tabState.selected,
    pick: tabState.pick,
    current: currentDocTab(),
    label: selectionLabel()
  };
}

function tabTitle(id) {
  const t = tabState.tabs.find((x) => x.id === id);
  return t ? t.title : null;
}

function selectionLabel() {
  if (tabState.pick === PICK_CURRENT && tabState.tabs.length > 1) {
    return `the current tab (${tabTitle(tabState.selected) || 'untitled'})`;
  }
  if (!tabState.selected) {
    return tabState.tabs.length > 1 ? 'all tabs' : 'the whole document';
  }
  return tabTitle(tabState.selected) || 'a tab';
}

function docMeta() {
  return {
    fileId: getFileId(),
    kind: getDocKind(),
    title: (document.title || '').replace(/ - Google (Docs|Slides).*$/, '').trim(),
    url: location.href
  };
}

/**
 * Visor Classroom: the report a group project receives (Section 8.7). The
 * same figures the side panel shows, without any of the document's text:
 * pasted and deleted passages stay here.
 *
 * `whole`: every tab of a Doc that has tabs, whichever one is on screen. "Add
 * files from Google Drive" sends files this way, since the background tab it
 * reads a file in shows whichever tab Docs opens first.
 */
function exportReport(whole = false) {
  const strip = (list) => (list || []).map(({ text, ...rest }) => rest);
  const picked = whole ? wholeDocument() : { figures: analysis, scope: selectionLabel() };
  // AWARE's map of who wrote each stretch and Visor's own diagnostics stay on
  // this computer: the site reads the counted figures and nothing else.
  const { ownership, diagnostics, ...figures } = picked.figures;
  return {
    schema: 'visor-export/1',
    meta: docMeta(),
    scope: picked.scope,
    exportedAt: new Date().toISOString(),
    analysis: { ...figures, pastes: strip(figures.pastes).slice(0, 300), deletions: strip(figures.deletions).slice(0, 300) }
  };
}

/**
 * The whole document's figures, leaving the selection alone: the bar, the
 * panel and the tab the user chose all stay as they were. The fold goes into
 * the cache like any other, so choosing "all tabs" afterwards costs nothing.
 */
function wholeDocument() {
  if (!tabState.selected) return { figures: analysis, scope: selectionLabel() };
  let hit = foldCache.get('');
  if (!hit) {
    const tl = VisorChangelog.buildTimeline(allEntries, allUsers);
    hit = { timeline: tl, analysis: VisorChangelog.analyze(tl) };
    foldCache.set('', hit);
    while (foldCache.size > FOLD_CACHE_MAX) foldCache.delete(foldCache.keys().next().value);
  }
  return {
    figures: { ...hit.analysis, lastRevision: analysis.lastRevision, analyzedAt: analysis.analyzedAt },
    scope: 'all tabs'
  };
}

// If this Doc is linked to one of the student's group projects, the service
// worker sends each fresh analysis there (at most every 5 minutes). Nothing
// is sent for documents that aren't linked, or when Visor isn't connected.
function autoSendReport() {
  if (globalThis.VISOR_EDITION === 'docs') return;   // Visor Classroom only
  if (!analysis || !visorAlive()) return;
  try { chrome.runtime.sendMessage({ type: 'VISOR_AUTO_SEND', fileId: getFileId(), report: exportReport() }, () => void chrome.runtime.lastError); } catch (_) {}
}

// A linked group Doc is read when it's opened, so its project stays current
// without anyone pressing the Visor button.
function readIfLinked() {
  if (globalThis.VISOR_EDITION === 'docs') return;   // Visor Classroom only
  if (!visorAlive() || analysis || running || !getFileId() || accessVerdict() === 'viewer') return;
  try {
    chrome.runtime.sendMessage({ type: 'VISOR_IS_LINKED', fileId: getFileId() }, (res) => {
      if (chrome.runtime.lastError || !res || res.linked !== true) return;
      if (!analysis && !running) runAnalysis();
    });
  } catch (_) {}
}
setTimeout(readIfLinked, 4000);

/** Trim heavy fields before crossing the message boundary to the side panel. */
function compactAnalysis(a) {
  return {
    ...a,
    ownership: undefined,   // only AWARE mode, in this tab, needs the runs
    pastes: a.pastes.slice(0, 200).map((p) => ({ ...p, text: p.text.slice(0, 600) })),
    deletions: a.deletions.slice(0, 200).map((d) => ({ ...d, text: d.text.slice(0, 600) }))
  };
}

/**
 * Compact per-step stream the replay overlay animates.
 *
 * Ops are encoded positionally so the overlay can rebuild the document itself:
 *   [0, at, text]  insert
 *   [1, at, len]   delete
 * Style-only ops are dropped — they do not move text.
 */
function replayPayload() {
  if (!timeline) return null;
  return {
    // Only the steps that belong to the selection. With a tab chosen, the other
    // tabs' edits used to ride along as empty no-ops: the text was right, but
    // the scrubber, the edit counter and playback time all walked every step of
    // the whole document, so a small tab played mostly dead air. Each step keeps
    // its document-wide index `i`, which is how session jumps still find it.
    steps: timeline.steps.filter((s) => !s.offTab).map((s) => ({
      i: s.i,
      t: s.time,
      u: s.userId == null ? '0' : s.userId,
      big: s.biggestInsert,
      ops: (s._norm || [])
        .filter((o) => o.op === 'insert' || o.op === 'delete')
        .map((o) => (o.op === 'insert' ? [0, o.at, o.text] : [1, o.at, o.len]))
    })),
    finalText: timeline.finalText,
    pasteThreshold: (analysis && analysis.pasteThreshold && analysis.pasteThreshold.value) || 20,
    contributors: analysis ? analysis.contributors : [],
    sessions: analysis ? analysis.sessions : [],
    tabState: tabInfo(),
    meta: docMeta()
  };
}

// ── Messaging ────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg && msg.type) {
    case 'VISOR_EXPORT':
      // The side panel's "Send to Visor" box; with `whole`, "Add files from
      // Google Drive" (every tab of the document)
      sendResponse(analysis ? { ok: true, report: exportReport(!!(msg && msg.whole)) } : { ok: false });
      return false;

    case 'VISOR_STATUS':
      sendResponse({
        state: !getFileId() ? 'no-document'
             : accessVerdict() === 'viewer' ? 'view-only'
             : running ? 'running'
             : analysis ? 'ready'
             : 'idle',
        meta: docMeta()
      });
      return false;

    case 'VISOR_ANALYZE':
      runAnalysis(!!msg.force).then(sendResponse);
      return true; // async

    case 'VISOR_SESSION_STEPS': {
      // Just the slice a single session covers, with its inserted and deleted
      // text, so the panel can show and replay that edit on its own.
      if (!timeline) { sendResponse(null); return false; }
      const from = Math.max(0, msg.from | 0);
      const to   = Math.min(timeline.steps.length - 1, msg.to | 0);
      sendResponse({
        steps: timeline.steps.slice(from, to + 1).map((s) => ({
          i: s.i,
          t: s.time,
          u: s.userId == null ? '0' : s.userId,
          ins: s.inserted,
          del: s.deleted,
          big: s.biggestInsert
        }))
      });
      return false;
    }

    case 'VISOR_REPLAY_DATA':
      sendResponse(replayPayload());
      return false;

    case 'VISOR_TEXT_AT':
      sendResponse({ text: timeline ? timeline.textAt(msg.step) : '' });
      return false;

    case 'VISOR_OPEN_REPLAY':
      openReplay(typeof msg.step === 'number' ? msg.step : null);
      sendResponse({ ok: true });
      return false;

    case 'VISOR_TOGGLE_HUD':
      toggleHUD();
      sendResponse({ ok: true });
      return false;

    case 'VISOR_TAB_STATE':
      sendResponse(tabInfo());
      return false;

    case 'VISOR_SET_TAB': {
      // The panel renders from this reply, so no sync broadcast back to it.
      if (!applyTabSelection(msg.tabId, false)) { sendResponse({ ok: false }); return false; }
      sendResponse({
        ok: true,
        analysis: compactAnalysis(analysis),
        tabState: tabInfo()
      });
      return false;
    }

    case 'VISOR_SET_THEME':
      applyInjectedTheme(msg.theme);
      sendResponse({ ok: true });
      return false;
  }
  return false;
});

// ── Theme ────────────────────────────────────────────────────────────────────
//
// The injected UI cannot use :root, since that belongs to the Google Docs page.
// Each Visor element carries the attribute itself and the stylesheet keys off it.

let injectedTheme = 'light';   // Visor's own theme — used by the replay overlay
let pageTheme     = 'light';   // the host document's appearance

/**
 * Work out whether the Google Docs page itself is light or dark.
 *
 * Surfaces that sit *on* the page — the toolbar pill, the HUD, the minimised
 * tab — must match the page, not Visor's panel theme. Painting Visor's dark
 * palette onto Docs' light toolbar is what made the launcher white-on-white.
 * The replay overlay is exempt: it covers the page, so it follows Visor.
 */
function detectPageTheme() {
  const probe = document.querySelector('#docs-toolbar, .docs-material-menubar, body');
  let bg = probe ? getComputedStyle(probe).backgroundColor : '';

  // Walk up for a non-transparent backdrop if the toolbar declares none.
  let el = probe;
  while (el && isTransparent(bg)) {
    el = el.parentElement;
    bg = el ? getComputedStyle(el).backgroundColor : '';
  }
  if (isTransparent(bg)) return 'light';

  const m = bg.match(/\d+(\.\d+)?/g);
  if (!m || m.length < 3) return 'light';
  const [r, g, b] = m.slice(0, 3).map(Number);
  // Rec. 709 luma; below the midpoint we treat the page as dark.
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) < 128 ? 'dark' : 'light';
}

function isTransparent(c) {
  return !c || c === 'transparent' || /rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/.test(c);
}

/**
 * Only the toolbar button follows the page.
 *
 * It sits inside Docs' own toolbar, which Docs renders light even when Visor is
 * dark, so matching Visor there would paint light text onto a light bar. The
 * bottom bar and its collapsed tab are different: they float on their own
 * surface over the document and belong to Visor, so they follow Visor's theme
 * along with the side panel and the replay.
 */
function applyPageTheme() {
  pageTheme = detectPageTheme();
  document.getElementById(VISOR_BTN_ID)?.setAttribute('data-visor-theme', pageTheme);
}

// The stored choice can be 'system'; the injected UI shows what that resolves
// to on this computer right now, and follows it when the computer changes.
let injectedThemeChoice = 'light';
function resolveInjectedTheme(choice) {
  if (choice === 'dark') return 'dark';
  if (choice === 'system') {
    try { return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; } catch (_) { return 'light'; }
  }
  return 'light';
}

function applyInjectedTheme(theme) {
  injectedThemeChoice = ['light', 'dark', 'system'].includes(theme) ? theme : 'light';
  injectedTheme = resolveInjectedTheme(injectedThemeChoice);
  for (const id of [VISOR_HUD_ID, VISOR_TAB_ID, 'visor-replay-overlay', 'visor-aware-panel']) {
    document.getElementById(id)?.setAttribute('data-visor-theme', injectedTheme);
  }
  document.getElementById('visor-replay-frame')
    ?.contentWindow.postMessage({ source: 'VISOR_REPLAY_THEME', theme: injectedTheme }, REPLAY_ORIGIN);
  applyPageTheme();
}

try {
  chrome.storage.local.get('visor_theme', (res) => {
    if (!chrome.runtime.lastError) applyInjectedTheme(res && res.visor_theme);
  });

  // Follow the stored value directly rather than relying on the panel's
  // VISOR_SET_THEME message reaching us. That message is best-effort — it is
  // dropped whenever the panel cannot resolve this tab — and a dropped one used
  // to leave the bar and its tab dropdown on the previous theme, which reads as
  // dark-on-light and is close to unreadable.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.visor_theme) {
      applyInjectedTheme(changes.visor_theme.newValue);
    }
  });
} catch (_) { /* default light */ }

applyPageTheme();
// Docs can switch its own appearance while open; keep the injected chrome in step.
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (injectedThemeChoice === 'system') applyInjectedTheme('system');
  else applyPageTheme();
});
[1200, 4000].forEach((t) => setTimeout(applyPageTheme, t));

// ── Launcher button ──────────────────────────────────────────────────────────

function buildLauncher() {
  const btn = document.createElement('button');
  btn.id = VISOR_BTN_ID;
  btn.className = 'visor-launch';
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Open Visor');
  btn.setAttribute('data-visor-theme', pageTheme);
  btn.innerHTML = `
    <img class="visor-launch-mark" src="${chrome.runtime.getURL('logo.png')}" alt="" width="24" height="16">
    <span class="visor-launch-text">Visor</span>
  `;

  const label = () => btn.querySelector('.visor-launch-text');

  btn.addEventListener('click', () => requestSidePanel(retryHint));

  let hintTimer = null;
  function retryHint() {
    const el = label();
    if (!el || hintTimer) return;
    const was = el.textContent;
    el.textContent = 'Click again';
    hintTimer = setTimeout(() => {
      el.textContent = was;
      hintTimer = null;
    }, 2200);
  }

  return btn;
}

/*
 * Where the button goes: the title bar, immediately right of version history.
 *
 * That row — history, comments, Share — is Docs' own place for things about
 * the document rather than about the text, which is exactly what Visor is. It
 * is also far calmer than the formatting toolbar, which Docs rebuilds
 * constantly and which crowds anything inserted into it.
 *
 * Every anchor is searched for by several names because Docs' own ids are not
 * stable across surfaces: Docs and Slides differ, and the labels are
 * translated. Whatever is found first wins, and if none is, the button falls
 * back to the formatting toolbar and then to floating in the corner.
 */
const HISTORY_SELECTORS = [
  '#docs-revisions-button',
  '#docs-revisions-chip',
  '.docs-revisions-button',
  '[aria-label*="version history" i]',
  '[data-tooltip*="version history" i]',
  '[aria-label*="revision history" i]',
  '[data-tooltip*="revision history" i]',
  '[aria-label*="Last edit was" i]',
  '[data-tooltip*="Last edit was" i]'
];

/** The rest of that row, if version history itself is not on this surface. */
const TITLEBAR_SELECTORS = [
  '#docs-docos-commentsbutton',
  '.docs-docos-commentsbutton',
  '#docs-titlebar-buttons',
  '.docs-titlebar-buttons'
];

const TOOLBAR_SELECTORS = [
  '#docs-toolbar', '.docs-toolbar-wrapper', '[id^="docs-toolbar"]',
  '#punch-toolbar-wrapper', '.punch-toolbar', '.goog-toolbar', '[role="toolbar"]'
];

/** The Editing / Suggesting / Viewing control at the right of the toolbar. */
const MODE_SWITCHER_SELECTORS = [
  '#docs-toolbar-mode-switcher',
  '.docs-toolbar-mode-switcher',
  '[aria-label*="Editing mode" i]',
  '[aria-label*="Mode" i][role="button"]'
];

function injectLauncher(floatingOnly) {
  if (visorStopped) return true;
  if (document.getElementById(VISOR_BTN_ID)) return true;
  const btn = buildLauncher();

  // Last-resort placement, used on its own once Docs has shown it will keep
  // tearing the button out of the toolbar. Nothing reconciles <body>.
  if (floatingOnly) {
    btn.classList.add('visor-launch-floating');
    document.body.appendChild(btn);
    return true;
  }

  const spot = findToolbarSpot();
  if (spot) {
    spot.parent.insertBefore(btn, spot.before);
    launcherHost = spot.parent;
    launcherSettled = !!spot.best;
    centreLauncher();
    return true;
  }

  btn.classList.add('visor-launch-floating');
  document.body.appendChild(btn);
  launcherHost = null;
  launcherSettled = false;
  return true;
}

/**
 * Where the button belongs in the toolbar, or null while Docs is still building
 * it. `before` is null for an append. Kept separate from the insertion so the
 * same search can relocate a button that is already on the page.
 */
function findToolbarSpot() {
  // Preferred: the title bar, just to the right of version history.
  for (const sel of HISTORY_SELECTORS) {
    const el = visibleMatch(sel);
    if (el && el.parentElement) return { parent: el.parentElement, before: el.nextSibling, best: true };
  }

  // That row without a history control of its own: sit at its left end, still
  // ahead of comments and Share.
  for (const sel of TITLEBAR_SELECTORS) {
    const el = visibleMatch(sel);
    if (!el) continue;
    if (el.id === 'docs-titlebar-buttons' || el.classList.contains('docs-titlebar-buttons')) {
      return { parent: el, before: el.firstChild, best: true };
    }
    if (el.parentElement) return { parent: el.parentElement, before: el, best: true };
  }

  // Failing that, the old spot beside the Editing control.
  for (const sel of MODE_SWITCHER_SELECTORS) {
    const mode = visibleMatch(sel);
    if (mode && mode.parentElement) return { parent: mode.parentElement, before: mode };
  }

  for (const sel of TOOLBAR_SELECTORS) {
    const bar = visibleMatch(sel);
    if (!bar) continue;
    const groups = bar.querySelectorAll('[role="button"], .goog-toolbar-button, .goog-toolbar-menu-button');
    const anchor = groups.length ? groups[groups.length - 1].parentElement : bar;
    if (anchor) return { parent: anchor, before: null };
  }
  return null;
}

/**
 * Line the button up with the controls beside it.
 *
 * Docs' title bar is not one consistent layout — parts of it are flex rows,
 * parts are lines of inline-blocks with their own baselines — so a button that
 * is correctly centred on one surface sits low on another. Rather than guess,
 * this measures: it compares the middle of the button with the middle of the
 * control next to it and shifts by the difference. One read and one write,
 * when the button is placed and when the window changes size.
 */
function centreLauncher() {
  const btn = document.getElementById(VISOR_BTN_ID);
  if (!btn || btn.classList.contains('visor-launch-floating')) return;

  const ref = [btn.previousElementSibling, btn.nextElementSibling, btn.parentElement]
    .find((el) => el && el.getBoundingClientRect().height > 4);
  if (!ref) return;

  btn.style.transform = '';                 // measure unshifted
  const a = btn.getBoundingClientRect();
  const b = ref.getBoundingClientRect();
  if (!a.height || !b.height) return;

  const dy = (b.top + b.height / 2) - (a.top + a.height / 2);
  // Anything larger is not a centring problem — it is the wrong container.
  if (Math.abs(dy) > 0.5 && Math.abs(dy) < 20) btn.style.transform = `translateY(${dy.toFixed(1)}px)`;
}

/**
 * The first match that is actually on screen.
 *
 * Docs keeps hidden copies of several of these controls — a menu item for
 * version history exists whether or not the title bar button does — and
 * inserting next to one would put the launcher somewhere invisible.
 */
function visibleMatch(sel) {
  for (const el of document.querySelectorAll(sel)) {
    if (el.id === VISOR_BTN_ID || el.closest('#' + VISOR_BTN_ID)) continue;
    if (el.closest('[role="menu"], [role="menuitem"], .goog-menu')) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return el;
  }
  return null;
}

/**
 * Docs builds its toolbar in stages, so the button often lands in the floating
 * fallback before there is anywhere better to put it. Once the toolbar exists,
 * move it up. Without this the retry timers did nothing at all: they called
 * injectLauncher(), which returns immediately when a button is already present.
 */
/**
 * Where the button was last placed, and whether that was the place it belongs.
 *
 * Only a title-bar placement settles the question. A button sitting in the
 * formatting toolbar — the fallback while Docs is still building the title bar
 * — must keep looking, or it never moves up.
 */
let launcherHost = null;
let launcherSettled = false;

function upgradeLauncherPlacement() {
  if (gaveUpOnToolbar) return;
  const btn = document.getElementById(VISOR_BTN_ID);
  if (!btn) return;

  // Already in the container it was placed in: nothing to do, and nothing to
  // search for. The search is twenty document-wide selector sweeps with a
  // layout read per candidate, and this runs on a three-second interval and on
  // every mutation of that row — which on a shared document is where Docs
  // renders collaborator chips.
  if (launcherSettled && launcherHost && btn.parentElement === launcherHost) return;

  const spot = findToolbarSpot();
  if (!spot) return;
  // Already in the right container: leave it alone. Comparing the exact
  // sibling instead would fight Docs — it re-creates the nodes in that row,
  // so the button would be moved again on every mutation, for ever.
  if (btn.parentElement === spot.parent) {
    launcherHost = spot.parent;
    launcherSettled = !!spot.best;
    return;
  }
  btn.classList.remove('visor-launch-floating');
  spot.parent.insertBefore(btn, spot.before);
  launcherHost = spot.parent;
  launcherSettled = !!spot.best;
  watchLauncherHost();
  centreLauncher();
}

// ── Heads-up display ─────────────────────────────────────────────────────────

let hudCollapsed = false;

/**
 * The collapsed bar: the Visor mark and a play button in one white rounded
 * rectangle. The play button opens the live replay; anywhere else on it brings
 * the bar back. A sibling on <body>, not a child of the bar — the bar is
 * translated, and a transformed ancestor would anchor position: fixed to it.
 */
function ensureHudTab() {
  let tab = document.getElementById(VISOR_TAB_ID);
  if (tab || visorStopped) return tab || document.createElement('div');

  tab = document.createElement('div');
  tab.id = VISOR_TAB_ID;
  tab.className = 'visor-hud-tab';
  tab.setAttribute('role', 'group');
  tab.setAttribute('aria-label', 'Visor');
  tab.setAttribute('data-visor-theme', injectedTheme);   // Visor's theme, not the page's
  // The play shape is an equilateral triangle turned to point right; a stroke
  // in its own colour with round joins rounds the corners.
  tab.innerHTML = `
    <button type="button" class="vt-open" title="Show the Visor bar" aria-label="Show the Visor bar">
      <img src="${chrome.runtime.getURL('logo.png')}" alt="" width="30" height="20">
    </button>
    <button type="button" class="vt-play" title="Open live replay" aria-label="Open live replay">
      <svg width="28" height="28" viewBox="0 0 30 30" fill="none" aria-hidden="true">
        <path d="M9.5 6 L24 15 L9.5 24 Z" fill="currentColor"
              stroke="currentColor" stroke-width="4.5" stroke-linejoin="round"/>
      </svg>
    </button>
    <span class="vt-hint" role="status" aria-live="polite"></span>`;

  // One listener for the whole rectangle, so its padding expands the bar too.
  tab.addEventListener('click', (e) => {
    // Not openReplay directly: it would receive the MouseEvent as its start step.
    if (e.target.closest && e.target.closest('.vt-play')) return openReplayWithData();
    expandBar();
  });

  document.body.appendChild(tab);
  return tab;
}

function toggleHUD(expand) {
  const hud = document.getElementById(VISOR_HUD_ID);
  if (!hud) { if (expand !== false) expandBar(); return; }
  hudCollapsed = expand === undefined ? !hudCollapsed : !expand;
  hud.classList.toggle('is-collapsed', hudCollapsed);
  ensureHudTab().classList.toggle('is-shown', hudCollapsed);
}

/* ── Auto-refresh ──────────────────────────────────────────────────────────
 *
 * The bar puts itself up, collapsed, on every document: a rectangle costs one
 * element and no reading, so Visor is one click away without having spent
 * anything on a document nobody asks about. The reading happens when that
 * button is pressed, and from then on the open bar keeps itself current.
 */
/*
 * How often an open bar looks for new edits.
 *
 * Two different questions, answered two different ways.
 *
 *   Did *you* just write something?  Docs answers that itself, for free: its
 *   save indicator goes to "Saving…" and back the moment anything changes.
 *   Watching that element costs nothing and reacts immediately, so your own
 *   typing shows up without waiting for the next poll at all.
 *
 *   Did *someone else*?  Nothing on the page says so, so this asks the server —
 *   one small request for the document's newest revision number. That is the
 *   only network cost, and it only leads to a real re-read when the number has
 *   actually moved.
 *
 * The asking backs off while nothing is happening: four seconds when the
 * document is live, stretching towards twenty when it has been still, and
 * straight back to four the moment anything changes. A document nobody is
 * touching therefore settles into a handful of tiny requests a minute, and a
 * document being worked on is never more than four seconds stale.
 */
const BAR_CHECK_MIN_MS = 4000;
const BAR_CHECK_MAX_MS = 20000;
const BAR_TICK_MS = 1000;

/* Re-reading the log while someone is mid-sentence is the worst possible
 * moment to do it: the work lands on the page they are typing into, and the
 * figures are out of date again a keystroke later. So a burst of typing is
 * allowed to finish first — with a ceiling, so a long stretch of writing still
 * updates as it goes. */
const TYPING_QUIET_MS = 1500;
const TYPING_MAX_STALE_MS = 15000;

/* A re-read is the whole log: every revision, folded again, on the Docs page's
 * own main thread. The check that precedes it is cheap, so it can run every
 * few seconds — but the read itself must not. While a document keeps changing,
 * whoever is changing it, the figures are brought up to date at this rate and
 * no faster. A change after a quiet spell is read immediately, because by then
 * the last read is older than this anyway.
 *
 * Without this, a collaborator typing steadily meant a complete re-read every
 * four seconds for as long as the bar was open — the local typing gate above
 * cannot see their keystrokes, only Docs' save indicator for this browser. */
const READ_MIN_GAP_MS = 12000;

/* When the revision cannot be read at all, every check would otherwise look
 * like a change and re-read the whole log. Fall back to a slow blind re-read
 * instead of hammering. */
const BLIND_READ_MS = 60000;

let barInterval = BAR_CHECK_MIN_MS;
let barNextCheck = 0;
let lastCheckAt = 0;
let lastTouchAt = 0;
let lastReadAt = 0;

let barBusy = false;

/** A word on the collapsed rectangle — "Reading edits…", and why it stopped. */
function tabHint(text, ms = 2400) {
  const tab = document.getElementById(VISOR_TAB_ID);
  if (!tab) return;
  const hint = tab.querySelector('.vt-hint');
  if (!hint) return;
  clearTimeout(tabHint._t);
  hint.textContent = text || '';
  tab.classList.toggle('is-hinting', !!text);
  if (text && ms) tabHint._t = setTimeout(() => tab.classList.remove('is-hinting'), ms);
}

function tabBusy(on) {
  document.getElementById(VISOR_TAB_ID)?.classList.toggle('is-busy', !!on);
}

/**
 * Open the bar, reading the document first if this is the first time.
 *
 * The rectangle is on screen before anything has been read, so its click is
 * also where the analysis starts. Both entry points share this: whichever the
 * user presses, they wait once and never twice.
 */
async function withData() {
  if (analysis) return true;
  if (barBusy) return false;
  barBusy = true;
  tabBusy(true);
  tabHint('Reading edits…', 0);
  try {
    // The side panel may already be reading this document. Wait for that read
    // rather than reporting nothing: asking again would only queue a second
    // fold, and saying "nothing to show" was simply wrong.
    let res = await runAnalysis(false);
    for (let i = 0; res.state === 'running' && i < 40; i++) {
      await new Promise((r) => setTimeout(r, 400));
      res = await runAnalysis(false);
    }
    if (res.state === 'ready') return true;
    if (res.state === 'stale') return false;   // moved on; nothing to say
    tabHint(res.state === 'view-only' ? 'No edit access' :
            res.state === 'empty'     ? 'No edits recorded' :
            res.state === 'error'     ? 'Could not read this document' : 'Nothing to show');
    return false;
  } finally {
    barBusy = false;
    tabBusy(false);
    if (analysis) tabHint('');
  }
}

async function expandBar() {
  // Whatever happens next, the bar is about to be looked at: figures that went
  // stale while it was folded away should not sit there for another interval.
  scheduleCheckSoon();
  if (document.getElementById(VISOR_HUD_ID)) { toggleHUD(true); return; }
  if (!(await withData())) return;
  // The read builds the bar itself, and builds it folded away, since that is
  // the state the rectangle was in. Unfold it through toggleHUD so the bar and
  // the rectangle are never both on screen.
  renderHUD(analysis);
  if (document.getElementById(VISOR_HUD_ID)) toggleHUD(true);
  else tabHint('No edits recorded');
}

async function openReplayWithData() {
  if (!(await withData())) return;
  openReplay();
}

/** Put the collapsed rectangle up on a document Visor can actually read. */
function autoShowBar() {
  if (visorStopped) return;
  if (document.getElementById(VISOR_TAB_ID)) return;
  if (!getFileId() || !getDocKind()) return;
  if (accessVerdict() === 'viewer') return;
  hudCollapsed = true;
  ensureHudTab().classList.add('is-shown');
}

// Editability is read from the page's own bootstrap data, which lands a moment
// after the script does, so this is tried a few times rather than once.
[900, 2500, 6000].forEach((t) => setTimeout(autoShowBar, t));

/*
 * Keep an open bar current. Everything that would make a refresh a nuisance
 * rather than a service is refused here: a replay in progress, a background
 * page, a read already running.
 */
let barRefreshing = false;

async function refreshBar() {
  if (barRefreshing || running || barBusy) return;
  if (document.hidden) return;
  if (!analysis || hudCollapsed) return;
  if (!document.getElementById(VISOR_HUD_ID)) return;
  if (document.getElementById('visor-replay-overlay')) return;

  // Mid-burst: wait for the typing to settle, unless the figures have been
  // stale for long enough that waiting is worse than the work.
  const now = Date.now();
  if (now - lastTouchAt < TYPING_QUIET_MS && now - lastReadAt < TYPING_MAX_STALE_MS) {
    barNextCheck = now + BAR_TICK_MS;
    return;
  }

  barRefreshing = true;
  lastCheckAt = now;
  const startedOn = docKey();
  const startedGen = docGeneration;
  let changing = false;
  try {
    const rev = await VisorChangelog.latestRevision(getFileId(), getDocKind());
    // Docs can move to another document inside that request. This refresh was
    // decided for the one that is no longer open; the new one will ask for
    // itself when its own bar is opened.
    if (docKey() !== startedOn || docGeneration !== startedGen) return;
    if (rev && lastRevisionSeen && rev === lastRevisionSeen) return;   // untouched
    // A probe that could not tell is not a change. Re-read on that basis only
    // rarely, so a document whose revision cannot be read is not re-folded
    // every few seconds for as long as it is open.
    if (!rev && Date.now() - lastReadAt < BLIND_READ_MS) return;

    // Something is happening, so keep checking at the fast cadence — but read
    // no more often than READ_MIN_GAP_MS.
    changing = true;
    if (Date.now() - lastReadAt < READ_MIN_GAP_MS) return;

    // Dated before the attempt, not after it: a read that fails or comes back
    // empty must still count as having been tried, or a document whose log has
    // stopped answering is re-read every four seconds for ever.
    lastReadAt = Date.now();
    const res = await runAnalysis(true);                               // renders the bar
    if (res.state === 'ready') broadcast({ type: 'VISOR_DATA_REFRESHED' });
  } catch (_) {
    /* a refresh that fails leaves the previous figures up */
  } finally {
    barRefreshing = false;
    // Busy document: stay at four seconds. Quiet one: ask less and less often.
    barInterval = changing ? BAR_CHECK_MIN_MS
                           : Math.min(Math.round(barInterval * 1.5), BAR_CHECK_MAX_MS);
    // From now, not from when the check started: a read that took longer than
    // the interval would otherwise leave the next one already overdue, so a
    // slow document was checked in a tight loop.
    barNextCheck = Date.now() + barInterval;
  }
}

/**
 * Look as soon as the fast cadence allows — never sooner.
 *
 * Not "look now": the save indicator moves on every keystroke burst, and
 * honouring each one would mean a request a second for as long as someone is
 * writing. The earliest a check may happen is one interval after the last one.
 */
function scheduleCheckSoon() {
  barInterval = BAR_CHECK_MIN_MS;
  barNextCheck = Math.max(lastCheckAt + BAR_CHECK_MIN_MS, Date.now());
}

/** Docs said something changed. */
function markDocTouched() {
  lastTouchAt = Date.now();
  scheduleCheckSoon();
}

/*
 * Stop when there is nothing left to stop for.
 *
 * Reloading or updating the extension orphans this script: the page keeps
 * running it, but chrome.runtime is gone. Everything it does then either
 * throws or, worse, quietly carries on making requests to docs.google.com for
 * the life of the tab. The bar's own tick is the heartbeat that notices.
 */
const visorTimers = [];

function visorAlive() {
  try { return !!(chrome.runtime && chrome.runtime.id); } catch (_) { return false; }
}

function visorShutdown() {
  if (visorStopped) return;
  visorStopped = true;
  visorTimers.forEach((id) => clearInterval(id));
  try { launcherObserver.disconnect(); } catch (_) { /* already gone */ }
  try { if (saveWatcher) saveWatcher.disconnect(); } catch (_) { /* already gone */ }
  document.getElementById(VISOR_HUD_ID)?.remove();
  document.getElementById(VISOR_TAB_ID)?.remove();
  document.getElementById(VISOR_BTN_ID)?.remove();
  document.getElementById('visor-replay-overlay')?.remove();
  document.getElementById('visor-aware-panel')?.remove();
  if (awarePanelTimer) { clearInterval(awarePanelTimer); awarePanelTimer = 0; }
  awarePost({ on: false });
}

/** setInterval, but recorded so it can be stopped. */
function visorInterval(fn, ms) {
  const id = setInterval(fn, ms);
  visorTimers.push(id);
  return id;
}

visorInterval(() => {
  if (!visorAlive()) return visorShutdown();
  if (Date.now() < barNextCheck) return;
  barNextCheck = Date.now() + barInterval;   // hold the slot while the check runs
  refreshBar();
}, BAR_TICK_MS);

/*
 * Coming back to a document that was left open: check straight away rather
 * than serving whatever was on screen when the tab was last looked at, and
 * start again at the fast cadence.
 */
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) scheduleCheckSoon();
});

/*
 * Docs' own save indicator, used as a free change signal.
 *
 * It is the element that reads "Saving…" and then "All changes saved in
 * Drive". Every edit moves it, and watching one small element costs nothing at
 * all — no requests, no polling, no work while the document is still. It only
 * covers edits made in this browser; a collaborator's edits arrive through the
 * revision check above.
 */
const SAVE_STATE_SELECTORS = [
  '#docs-save-indicator',
  '.docs-save-indicator',
  '#docs-title-save-label',
  '.docs-title-save-label',
  '[id*="save-indicator"]',
  '[class*="save-indicator"]'
];

let saveWatcher = null;
let saveWatched = null;

function findSaveState() {
  for (const sel of SAVE_STATE_SELECTORS) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  // Nothing named: fall back to whatever in the title area says it saved.
  const chrome_ = document.querySelector('#docs-chrome, .docs-chrome, header');
  if (!chrome_) return null;
  for (const el of chrome_.querySelectorAll('span, div')) {
    if (el.children.length) continue;
    if (/saving|saved in|last edit/i.test(el.textContent || '')) return el;
  }
  return null;
}

function watchSaveState() {
  // Docs re-creates parts of that row; a watcher on a detached node is silent.
  if (saveWatched && !saveWatched.isConnected) saveWatched = null;
  const el = findSaveState();
  if (!el || el === saveWatched) return;
  if (saveWatcher) saveWatcher.disconnect();
  saveWatched = el;
  saveWatcher = new MutationObserver(markDocTouched);
  saveWatcher.observe(el, { childList: true, characterData: true, subtree: true });
}

// Docs builds the title bar in stages, and replaces parts of it later, so the
// element is looked for a few times and then checked on now and then.
[1200, 3000, 7000].forEach((t) => setTimeout(watchSaveState, t));
visorInterval(watchSaveState, 30000);

/**
 * Ask the service worker to open the side panel.
 *
 * The worker is asleep whenever the machine has been — after closing the lid,
 * most obviously. The click has to wake it, and Chrome's user-gesture window
 * can lapse during that cold start, at which point it refuses to open the
 * panel. Nothing is wrong by then except that the worker is warm, so the next
 * click works; `onFail` lets the caller say so rather than appear to do nothing.
 */
function requestSidePanel(onFail) {
  try {
    chrome.runtime.sendMessage({ type: 'OPEN_SIDE_PANEL' }, (res) => {
      if (chrome.runtime.lastError || (res && res.ok === false)) onFail();
    });
  } catch (_) {
    onFail();   // extension context gone: a reload is the only cure
  }
}


/**
 * The HUD is built once, then updated in place.
 *
 * It used to be rebuilt wholesale — `hud.innerHTML = …` — on every call, and it
 * is called whenever the tab scope changes from the side panel. That destroyed
 * and re-created `.vh-glass`, which carries `backdrop-filter: blur(26px)`.
 * Tearing down a backdrop-filtered element makes Chrome rebuild the backdrop
 * root, and over Docs' very large composited layers that re-rasterises the
 * whole page — which is the flash of the document vanishing and coming back.
 *
 * Writing text into existing nodes costs nothing and never touches the filtered
 * layer, so the glass is created exactly once per document.
 */
// ── AWARE mode ───────────────────────────────────────────────────────────────
//
// Colours the document's text on this screen by who wrote it. The colouring
// itself is aware.js, in the page (it has to watch Docs paint); this side owns
// the switch and sends it the document's text, who wrote each stretch, and
// each author's colour (the same colours as the bar and the side panel). Only
// for Google Docs, only for someone who can see the history (editors), and
// nothing leaves this tab: it's a window message to the page's own window.
const AWARE_KEY = 'visor_aware';
const AWARE_SEEN_KEY = 'visor_aware_seen';
const AWARE_HIDDEN_KEY = 'visor_aware_hidden';   // { fileId: [userId, ...] } switched off in the panel
const AWARE_PASTE_EXT_KEY = 'visor_aware_paste_ext';   // highlight pastes from outside the document (yellow)
const AWARE_PASTE_INT_KEY = 'visor_aware_paste_int';   // highlight text copied or moved within it (light blue)
const AWARE_PASTES_OLD_KEY = 'visor_aware_pastes';     // the single switch these replaced; read once as the default for both
const AWARE_MIN_KEY = 'visor_aware_min';         // the panel folded to its title
const AWARE_CHANNEL = 'VISOR_AWARE';
const AWARE_PANEL_ID = 'visor-aware-panel';
let awareOn = false;
let awareSeen = true;          // until storage says otherwise, no NEW label
let awareSent = null;          // the analysis last sent, so the text isn't resent on every repaint
let awareHiddenAll = {};
let awarePasteExt = false;
let awarePasteInt = false;
let awareMin = false;
const awareHidden = () => new Set((awareHiddenAll[getFileId()] || []).map(String));

// What the percentages count (shares.js): both kinds of paste left out unless
// switched off, in the bar's menu here or in the side panel.
let shareOpts = visorShareSettings();
try {
  chrome.storage.local.get([VISOR_SHARE_EXT_KEY, VISOR_SHARE_INT_KEY], (res) => {
    if (chrome.runtime.lastError) return;
    shareOpts = visorShareSettings(res);
    refreshShares();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || (!changes[VISOR_SHARE_EXT_KEY] && !changes[VISOR_SHARE_INT_KEY])) return;
    const next = { ...shareOpts };
    if (changes[VISOR_SHARE_EXT_KEY]) next.excludeExternal = changes[VISOR_SHARE_EXT_KEY].newValue !== false;
    if (changes[VISOR_SHARE_INT_KEY]) next.excludeInternal = changes[VISOR_SHARE_INT_KEY].newValue !== false;
    shareOpts = next;
    refreshShares();
  });
} catch (_) { /* defaults */ }

function setShareOpt(key, on) {
  shareOpts = { ...shareOpts, [key === VISOR_SHARE_EXT_KEY ? 'excludeExternal' : 'excludeInternal']: !!on };
  try { chrome.storage.local.set({ [key]: !!on }); } catch (_) { /* no-op */ }
  refreshShares();
}

/** Every percentage on screen, recounted (on the bar, with the chips moving). */
function refreshShares() {
  const hud = document.getElementById(VISOR_HUD_ID);
  if (hud && analysis) { hudChipsMove = true; updateHUD(hud, analysis); hudChipsMove = false; }
  syncShareMenu();
  if (document.getElementById(AWARE_PANEL_ID)) renderAwarePanel();
}

function awarePost(msg) {
  try { window.postMessage({ source: AWARE_CHANNEL, ...msg }, window.location.origin); } catch (_) { /* nothing to do */ }
}

/** What aware.js needs, from the current selection's fold. */
function awarePayload(tl, a) {
  if (!tl || !a || !Array.isArray(a.ownership)) return null;
  const colors = [];
  const index = new Map();
  for (const c of a.contributors || []) { index.set(String(c.id), colors.length); colors.push(c.color); }
  // People switched off in the panel are left out; each kind of paste is
  // marked only while its switch is on (1: from outside, 2: from within).
  const hidden = awareHidden();
  const owners = [];
  for (const [start, len, who, pasted] of a.ownership) {
    if (hidden.has(String(who))) continue;
    const c = index.get(String(who));
    const shown = (pasted === 1 && awarePasteExt) || (pasted === 2 && awarePasteInt) ? pasted : 0;
    if (c != null) owners.push([start, len, c, shown]);
  }
  return { text: tl.finalText || '', owners, colors };
}

function awareSync(force = false) {
  if (getDocKind() !== 'doc') return;
  renderAwarePanel();
  if (!awareOn || visorStopped || !analysis) {
    if (awareSent !== false) { awarePost({ on: false }); awareSent = false; }
    return;
  }
  if (!force && awareSent === analysis) return;
  const payload = awarePayload(timeline, analysis);
  if (!payload) return;
  awareSent = analysis;
  awarePost({ on: true, ...payload });
}

// ── The AWARE panel ──
//
// While AWARE is on, a small panel sits beside the page, just under the
// toolbar: everyone's colour (each can be switched off), and "Show pastes",
// which highlights every paste in yellow. It goes when AWARE goes off.

function awareStore(obj) {
  try { chrome.storage.local.set(obj); } catch (_) { /* no-op */ }
}

function toggleAwarePerson(id) {
  const fid = getFileId();
  const set = awareHidden();
  if (set.has(id)) set.delete(id); else set.add(id);
  awareHiddenAll = { ...awareHiddenAll, [fid]: [...set] };
  if (!awareHiddenAll[fid].length) delete awareHiddenAll[fid];
  awareStore({ [AWARE_HIDDEN_KEY]: awareHiddenAll });
  awareSync(true);
}

let awarePanelTimer = 0;
let awarePanelResize = false;

function renderAwarePanel() {
  const existing = document.getElementById(AWARE_PANEL_ID);
  const people = visorShares((analysis && analysis.contributors) || [], shareOpts);
  if (!awareOn || visorStopped || !analysis || getDocKind() !== 'doc') {
    existing?.remove();
    if (awarePanelTimer) { clearInterval(awarePanelTimer); awarePanelTimer = 0; }
    return;
  }

  let panel = existing;
  if (!panel) {
    panel = document.createElement('div');
    panel.id = AWARE_PANEL_ID;
    panel.className = 'visor-aware-panel';
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', 'Visor AWARE');
    panel.addEventListener('click', (e) => {
      const t = e.target && e.target.closest ? e.target.closest('[data-aw]') : null;
      if (!t) return;
      const act = t.getAttribute('data-aw');
      if (act === 'person') toggleAwarePerson(t.getAttribute('data-id'));
      else if (act === 'paste-ext') { awarePasteExt = !awarePasteExt; awareStore({ [AWARE_PASTE_EXT_KEY]: awarePasteExt }); awareSync(true); }
      else if (act === 'paste-int') { awarePasteInt = !awarePasteInt; awareStore({ [AWARE_PASTE_INT_KEY]: awarePasteInt }); awareSync(true); }
      else if (act === 'min') { awareMin = !awareMin; awareStore({ [AWARE_MIN_KEY]: awareMin }); renderAwarePanel(); }
      else if (act === 'off') setAware(false);
    });
    document.body.appendChild(panel);
    // Docs moves its own furniture (the side panel opening, a narrower window);
    // keep the panel beside the page.
    if (!awarePanelResize) { awarePanelResize = true; addEventListener('resize', () => placeAwarePanel()); }
    if (!awarePanelTimer) awarePanelTimer = setInterval(() => placeAwarePanel(), 1500);
  }
  panel.setAttribute('data-visor-theme', injectedTheme);
  panel.classList.toggle('is-min', awareMin);

  const hidden = awareHidden();
  const t = analysis.totals || {};
  const pasteRow = (act, on, swatch, label, n, tip) => `
      <button type="button" class="va-pastes${on ? ' is-on' : ''}" data-aw="${act}" role="switch" aria-checked="${on}" title="${tip}">
        <span class="${swatch}" aria-hidden="true"></span>
        <span class="va-pastes-label">${label} <em>${Number(n || 0).toLocaleString()}</em></span>
        <span class="va-switch" aria-hidden="true"><i></i></span>
      </button>`;
  panel.innerHTML = `
    <div class="va-head">
      <span class="va-dots" aria-hidden="true"><i></i><i></i><i></i></span>
      <b class="va-title">Visor <span>AWARE</span></b>
      <button type="button" class="va-icon va-fold" data-aw="min" aria-expanded="${!awareMin}"
              title="${awareMin ? 'Show the key' : 'Fold the panel'}" aria-label="${awareMin ? 'Show the key' : 'Fold the panel'}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 14.5 12 9l5.5 5.5"/></svg>
      </button>
      <button type="button" class="va-icon" data-aw="off" title="Turn AWARE off" aria-label="Turn AWARE off">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 7.5l9 9M16.5 7.5l-9 9"/></svg>
      </button>
    </div>
    <div class="va-body">
      <p class="va-note">Each person's text in their color. Click someone to hide or show their color.</p>
      <div class="va-people">
        ${people.map((c) => {
          const on = !hidden.has(String(c.id));
          return `<button type="button" class="va-person${on ? '' : ' is-off'}" data-aw="person" data-id="${esc(String(c.id))}"
                    aria-pressed="${on}" title="${on ? 'Hide' : 'Show'} ${esc(c.name)}'s color">
            <span class="va-swatch" style="--c:${esc(c.color || '#888')}"></span>
            <span class="va-name">${esc(c.name || 'Unknown')}</span>
            <span class="va-share">${Math.round((c.share || 0) * 100)}%</span>
          </button>`;
        }).join('')}
      </div>
      <div class="va-paste-rows">
        ${pasteRow('paste-ext', awarePasteExt, 'va-yellow', 'Pasted from outside', t.externalPastes,
          'Highlight in yellow the text pasted in from outside this document')}
        ${pasteRow('paste-int', awarePasteInt, 'va-blue', 'Pasted from within', t.internalPastes,
          'Highlight in light blue the text copied or moved from elsewhere in this document')}
      </div>
      <p class="va-foot">Only on your screen. The document isn't changed.</p>
    </div>`;
  placeAwarePanel(panel);
}

/**
 * Just under the toolbar, beside the page on its right when there's room
 * before Docs' own right-hand strip; otherwise over the page's right edge.
 */
function placeAwarePanel(panel = document.getElementById(AWARE_PANEL_ID)) {
  if (!panel) return;
  try {
    const bar = document.getElementById('docs-toolbar-wrapper') || document.querySelector('.docs-toolbar-wrapper, #docs-toolbar, #docs-chrome');
    const top = Math.max(56, Math.round((bar ? bar.getBoundingClientRect().bottom : 112) + 12));
    const page = document.querySelector('.kix-page-paginated, .kix-page, canvas.kix-canvas-tile-content');
    const rail = document.querySelector('.docs-companion-app-switcher-container, .companion-app-switcher-container');
    const railLeft = rail ? rail.getBoundingClientRect().left : innerWidth;
    const w = panel.offsetWidth || 248;
    const pageRight = page ? page.getBoundingClientRect().right : 0;
    let left = pageRight + 20;
    if (!page || left + w > railLeft - 12) left = railLeft - 16 - w;
    panel.style.top = `${top}px`;
    panel.style.left = `${Math.max(8, Math.round(left))}px`;
  } catch (_) { /* leave it where it is */ }
}

function setAware(on) {
  try { chrome.storage.local.set({ [AWARE_KEY]: !!on, [AWARE_SEEN_KEY]: true }); } catch (_) { /* no-op */ }
  applyAware(!!on, true);
}

function applyAware(on, seen) {
  awareOn = !!on;
  if (seen) awareSeen = true;
  const btn = document.getElementById(VISOR_HUD_ID)?.querySelector('[data-act="aware"]');
  if (btn) {
    btn.classList.toggle('is-on', awareOn);
    btn.setAttribute('aria-pressed', String(awareOn));
    btn.title = awareOn
      ? 'AWARE is on: the text is colored by who wrote it, on your screen only. Click to turn it off.'
      : 'AWARE: color this document\'s text by who wrote it. Only on your screen; the document isn\'t changed.';
    const nw = btn.querySelector('.vh-new');
    if (nw) nw.hidden = awareSeen;
  }
  awareSync(true);
}

try {
  chrome.storage.local.get([AWARE_KEY, AWARE_SEEN_KEY, AWARE_HIDDEN_KEY, AWARE_PASTE_EXT_KEY, AWARE_PASTE_INT_KEY, AWARE_PASTES_OLD_KEY, AWARE_MIN_KEY], (res) => {
    if (chrome.runtime.lastError) return;
    res = res || {};
    awareSeen = !!res[AWARE_SEEN_KEY];
    awareHiddenAll = (res[AWARE_HIDDEN_KEY] && typeof res[AWARE_HIDDEN_KEY] === 'object') ? res[AWARE_HIDDEN_KEY] : {};
    const was = !!res[AWARE_PASTES_OLD_KEY];
    awarePasteExt = AWARE_PASTE_EXT_KEY in res ? !!res[AWARE_PASTE_EXT_KEY] : was;
    awarePasteInt = AWARE_PASTE_INT_KEY in res ? !!res[AWARE_PASTE_INT_KEY] : was;
    awareMin = !!(res && res[AWARE_MIN_KEY]);
    applyAware(!!(res && res[AWARE_KEY]), false);
  });
  // The side panel has the same switch; follow it.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[AWARE_SEEN_KEY]) awareSeen = !!changes[AWARE_SEEN_KEY].newValue;
    // the panel's settings, changed in this tab or another one on the same document
    let panelChanged = false;
    if (changes[AWARE_HIDDEN_KEY]) { awareHiddenAll = changes[AWARE_HIDDEN_KEY].newValue || {}; panelChanged = true; }
    if (changes[AWARE_PASTE_EXT_KEY]) { awarePasteExt = !!changes[AWARE_PASTE_EXT_KEY].newValue; panelChanged = true; }
    if (changes[AWARE_PASTE_INT_KEY]) { awarePasteInt = !!changes[AWARE_PASTE_INT_KEY].newValue; panelChanged = true; }
    if (changes[AWARE_MIN_KEY]) { awareMin = !!changes[AWARE_MIN_KEY].newValue; panelChanged = true; }
    if (changes[AWARE_KEY]) applyAware(!!changes[AWARE_KEY].newValue, false);
    else if (changes[AWARE_SEEN_KEY] || panelChanged) applyAware(awareOn, false);
  });
} catch (_) { /* off */ }

function renderHUD(a) {
  awareSync();
  if (!a) return;
  // A selection with nothing recorded in it — an empty or brand-new document
  // tab — must still repaint a bar that is already up. Returning early here is
  // what left the previous tab's figures on screen after switching. It just
  // should not conjure a bar into existence for a document with no history.
  if (!document.getElementById(VISOR_HUD_ID) && !a.contributors.length) return;
  updateHUD(ensureHUD(), a);
  ensureHudTab().classList.toggle('is-shown', hudCollapsed);
}

function ensureHUD() {
  const existing = document.getElementById(VISOR_HUD_ID);
  if (existing || visorStopped) return existing || document.createElement('div');

  const hud = document.createElement('div');
  hud.id = VISOR_HUD_ID;
  hud.className = 'visor-hud';
  hud.setAttribute('data-visor-theme', injectedTheme);   // Visor's theme, not the page's
  hud.innerHTML = `
    <div class="vh-glass" aria-hidden="true"></div>
    <div class="vh-body">
      <div class="vh-brand">
        <img src="${chrome.runtime.getURL('logo.png')}" width="23" height="15" alt="">
        <span>Visor</span>
      </div>
      <div class="vh-rule"></div>
      <div class="vh-chips"></div>
      <div class="vh-share">
        <button class="vh-btn vh-btn-share" data-act="share" aria-haspopup="true" aria-expanded="false"
                title="What the percentages count">
          <span class="vh-share-label">Excl. pastes</span>
          <svg width="10" height="10" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <div class="vh-share-menu" role="menu" aria-label="What the percentages count" hidden>
          <p class="vh-share-note">Percentages are each person's share of the text added. Leave out:</p>
          <button class="vh-share-opt" role="menuitemcheckbox" data-share="ext" aria-checked="true">
            <span class="vh-share-swatch is-ext" aria-hidden="true"></span>
            <span>Pastes from outside</span>
            <span class="vh-share-switch" aria-hidden="true"><i></i></span>
          </button>
          <button class="vh-share-opt" role="menuitemcheckbox" data-share="int" aria-checked="true">
            <span class="vh-share-swatch is-int" aria-hidden="true"></span>
            <span>Pastes from within</span>
            <span class="vh-share-switch" aria-hidden="true"><i></i></span>
          </button>
        </div>
      </div>
      <div class="vh-rule"></div>
      <div class="vh-stats"></div>
      <span class="vh-flag vh-flag-cool" hidden></span>
      <div class="vh-spark"></div>
      <div class="vh-filter" hidden>
        <button class="vh-btn vh-btn-filter" data-act="filter"
                title="Choose which document tab these stats cover"
                aria-haspopup="listbox" aria-expanded="false">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M3 5h18l-7 8v6l-4 2v-8z"/>
          </svg>
          <span class="vh-scope"></span>
        </button>
        <div class="vh-menu" role="listbox" aria-label="Document tab"></div>
      </div>
      <button class="vh-btn vh-btn-aware" data-act="aware" aria-pressed="false"
              title="AWARE: color this document's text by who wrote it. Only on your screen; the document isn't changed.">
        <span class="vh-aware-dots" aria-hidden="true"><i></i><i></i><i></i></span>
        <span class="vh-aware-label">AWARE</span>
        <span class="vh-new" hidden>NEW</span>
      </button>
      <button class="vh-btn vh-btn-play" data-act="replay" title="Open live replay" aria-label="Open live replay">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.2v13.6L19 12z"/></svg>
      </button>
      <button class="vh-btn" data-act="collapse" title="Collapse">▾</button>
    </div>
  `;
  hud.classList.toggle('is-collapsed', hudCollapsed);
  document.body.appendChild(hud);
  requestAnimationFrame(() => hud.classList.add('is-in'));

  // Must not pass the handler directly: addEventListener would hand openReplay
  // the MouseEvent as its startStep, which is not structured-cloneable and made
  // the postMessage carrying the replay payload throw.
  hud.querySelector('[data-act="replay"]')?.addEventListener('click', () => openReplay());
  hud.querySelector('[data-act="collapse"]')?.addEventListener('click', () => toggleHUD(false));
  hud.querySelector('[data-act="aware"]')?.addEventListener('click', () => setAware(!awareOn));
  wireShareMenu(hud);
  wireHudFilter(hud);
  requestAnimationFrame(() => applyAware(awareOn, false));
  return hud;
}

/** Last chip roster rendered, so the entry animation is not replayed on every
 *  scope change when the same people are still on screen with the same shares. */
let hudChipKey = '';
let hudChipsMove = false;   // set while the percentages are recounted, so the chips glide

const reducedMotion = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; } };

/** A percentage counting from what it shows to `to`, over the bars' own time. */
function countTo(el, to, suffix = '%') {
  const from = parseFloat(el.textContent) || 0;
  if (from === to || reducedMotion()) { el.textContent = `${to}${suffix}`; return; }
  const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const t0 = clock(), T = 480;
  const step = () => {
    const k = Math.min(1, (clock() - t0) / T), e = 1 - Math.pow(1 - k, 3);
    el.textContent = `${Math.round(from + (to - from) * e)}${suffix}`;
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/**
 * The same people on the bar, recounted: each chip keeps its place in the
 * DOM until it glides to its new one (FLIP, on the `translate` property, so
 * it doesn't fight the chips' entry animation), while its bar resizes and its
 * percentage counts to the new figure.
 */
function moveHudChips(host, top) {
  const chips = new Map([...host.querySelectorAll('.vh-chip')].map((c) => [c.getAttribute('data-id'), c]));
  const canMeasure = [...chips.values()].every((c) => typeof c.getBoundingClientRect === 'function');
  const first = new Map();
  if (canMeasure) chips.forEach((c, id) => first.set(id, c.getBoundingClientRect().left));
  // Chips that are already on screen don't play their entrance again: moving
  // one in the page would otherwise restart it (a fade-in and a bar filling
  // from nothing).
  chips.forEach((chip) => chip.classList.add('is-settled'));
  // the new order first, moving only chips that aren't in place ...
  let at = host.firstElementChild;
  for (const c of top) {
    const chip = chips.get(String(c.id));
    if (chip !== at) host.insertBefore(chip, at); else at = chip.nextElementSibling;
  }
  // ... then, once they've settled at their old widths, the new figures (so
  // the bars animate: a moved element's first style change doesn't)
  void host.offsetWidth;
  for (const c of top) {
    const chip = chips.get(String(c.id));
    const pct = Math.round(c.share * 100);
    const bar = chip.querySelector('.vh-track i');
    if (bar) bar.style.width = `${pct}%`;
    const num = chip.querySelector('.vh-pct');
    if (num) countTo(num, pct);
    const meta = chip.querySelector('.vh-meta');
    if (meta) meta.setAttribute('title', `${pct}% of the text${shareOpts.excludeExternal || shareOpts.excludeInternal ? ', leaving out pastes' : ''} · ${fmtMins(c.activeMinutes)} active`);
  }
  if (!canMeasure || reducedMotion()) return;
  chips.forEach((chip, id) => {
    const dx = first.get(id) - chip.getBoundingClientRect().left;
    if (!dx) return;
    chip.style.transition = 'none';
    chip.style.translate = `${dx}px 0`;
  });
  void host.offsetWidth;
  chips.forEach((chip) => {
    if (!chip.style.translate) return;
    chip.style.transition = 'translate .45s cubic-bezier(.2, .7, .2, 1)';
    chip.style.translate = '';
  });
}

function updateHUD(hud, a) {
  const top = visorShares(a.contributors, shareOpts).slice(0, 3);
  const t   = a.totals;

  // An empty selection gets its own key, so moving into one clears the chips
  // left by the previous tab instead of matching the initial blank state.
  const key = top.length
    ? top.map((c) => `${c.id}|${Math.round(c.share * 100)}|${c.activeMinutes}`).join('/')
    : '(none)';
  const host = hud.querySelector('.vh-chips');
  const onBar = [...host.querySelectorAll('.vh-chip')].map((c) => c.getAttribute('data-id')).sort().join('|');
  if (key !== hudChipKey && hudChipsMove && top.length && onBar === top.map((c) => String(c.id)).sort().join('|')) {
    // a recount with the same people on the bar: move what's there
    hudChipKey = key;
    moveHudChips(host, top);
  } else if (key !== hudChipKey) {
    hudChipKey = key;
    host.innerHTML = !top.length
      ? '<div class="vh-none">No edits recorded in this tab</div>'
      : top.map((c, i) => `
      <div class="vh-chip" data-id="${esc(String(c.id))}" style="--c:${esc(c.color)};--d:${i * 60}ms">
        <div class="vh-chip-head">
          <span class="vh-dot"></span>
          <span class="vh-name">${esc(firstName(c.name))}</span>
          <span class="vh-meta" title="${Math.round(c.share * 100)}% of the text${shareOpts.excludeExternal || shareOpts.excludeInternal ? ', leaving out pastes' : ''} · ${esc(fmtMins(c.activeMinutes))} active">
            <b class="vh-pct">${Math.round(c.share * 100)}%</b>
            <span class="vh-time">${esc(fmtMins(c.activeMinutes))}</span>
          </span>
        </div>
        <div class="vh-track"><i style="width:${Math.round(c.share * 100)}%"></i></div>
      </div>`).join('');
  }

  hud.querySelector('.vh-stats').innerHTML = `
    <span><b>${fmtInt(t.mutations)}</b> ${t.mutations === 1 ? 'edit' : 'edits'}</span>
    <span><b>${fmtInt(t.finalWords)}</b> ${t.finalWords === 1 ? 'word' : 'words'}</span>
    <span><b>${fmtInt(t.pasteCount)}</b> ${t.pasteCount === 1 ? 'paste' : 'pastes'}</span>
    <span><b>${esc(fmtMins(t.activeMinutes))}</b></span>`;

  // A measured share, not a verdict. This previously read behavior.verdict and
  // behavior.score, which stopped existing when scoring was removed — so it
  // silently fell through to "typed" on every document, however much had been
  // pasted into it.
  const b = a.behavior || {};
  const flag = hud.querySelector('.vh-flag');
  const enough = !!b.enough;
  flag.hidden = !enough;
  if (enough) flag.textContent = `${Math.round((b.externalShare || 0) * 100)}% external`;

  const spark = hud.querySelector('.vh-spark');
  const svg = sparkline(a.growth);
  if (spark.innerHTML !== svg) spark.innerHTML = svg;

  const multi = tabState.tabs.length > 1;
  hud.querySelector('.vh-filter').hidden = !multi;
  if (multi) {
    // The whole bar is scoped to one selection, so name it on the bar itself —
    // otherwise 'current tab' mode changes every figure with no visible cause.
    const name = tabState.selected ? (tabTitle(tabState.selected) || 'Untitled tab') : 'All tabs';
    const scope = hud.querySelector('.vh-scope');
    scope.textContent = name;
    const btn = hud.querySelector('.vh-btn-filter');
    btn.title = tabState.pick === PICK_CURRENT
      ? `Following the tab you are viewing: ${name}`
      : `Stats cover: ${name}`;
    btn.classList.toggle('is-following', tabState.pick === PICK_CURRENT);
  }
}

/**
 * "What the percentages count", on the bar: a pill naming the setting, and a
 * menu (opening upward, like the tab filter) with a switch for each kind of
 * paste. The same setting as the side panel's.
 */
let shareMenuOff = null;
function wireShareMenu(hud) {
  const wrap = hud.querySelector('.vh-share');
  if (!wrap) return;
  const btn = wrap.querySelector('[data-act="share"]');
  const menu = wrap.querySelector('.vh-share-menu');
  let open = false;
  menu.hidden = true;
  const close = () => {
    open = false;
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    if (shareMenuOff) { shareMenuOff(); shareMenuOff = null; }
  };
  btn.addEventListener('click', (e) => {
    if (e && e.stopPropagation) e.stopPropagation();
    if (open) return close();
    open = true;
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    // Close on a click anywhere else, or Escape.
    const away = (ev) => { if (!wrap.contains(ev.target)) close(); };
    const onKey = (ev) => { if (ev.key === 'Escape') close(); };
    document.addEventListener('mousedown', away, true);
    document.addEventListener('keydown', onKey, true);
    shareMenuOff = () => { document.removeEventListener('mousedown', away, true); document.removeEventListener('keydown', onKey, true); };
  });
  menu.addEventListener('click', (e) => {
    const opt = e.target && e.target.closest ? e.target.closest('[data-share]') : null;
    if (!opt) return;
    const ext = opt.getAttribute('data-share') === 'ext';
    setShareOpt(ext ? VISOR_SHARE_EXT_KEY : VISOR_SHARE_INT_KEY, !(ext ? shareOpts.excludeExternal : shareOpts.excludeInternal));
  });
  syncShareMenu();
}

function syncShareMenu() {
  const hud = document.getElementById(VISOR_HUD_ID);
  if (!hud) return;
  const label = hud.querySelector('.vh-share-label');
  if (label) label.textContent = visorShareLabel(shareOpts);
  const btn = hud.querySelector('[data-act="share"]');
  if (btn) btn.classList.toggle('is-filtered', shareOpts.excludeExternal || shareOpts.excludeInternal);
  for (const opt of hud.querySelectorAll('[data-share]')) {
    const on = opt.getAttribute('data-share') === 'ext' ? shareOpts.excludeExternal : shareOpts.excludeInternal;
    opt.setAttribute('aria-checked', String(on));
    opt.classList.toggle('is-on', on);
  }
}

/**
 * Tab filter in the HUD. The menu opens upward, because the bar is anchored to
 * the bottom of the window and a downward menu would open off-screen.
 */
function wireHudFilter(hud) {
  const wrap = hud.querySelector('.vh-filter');
  if (!wrap) return;

  const btn  = wrap.querySelector('[data-act="filter"]');
  const menu = wrap.querySelector('.vh-menu');

  // Rebuilt every time it opens, from the same roster the side panel reads.
  // Building it once at render time meant a title corrected after the HUD was
  // drawn — a tab rename recovered later in the log — never reached this menu.
  const fillMenu = () => {
    const info = tabInfo();
    const currentName = tabTitle(info.current);
    const options = [
      { key: PICK_CURRENT, title: 'Current tab', note: currentName || '' },
      { key: '', title: 'All tabs' },
      ...info.tabs.map((t) => ({ key: t.id, title: t.title }))
    ];
    const on = info.pick === PICK_CURRENT ? PICK_CURRENT : (info.pick || '');

    // Eight rows, then another column. Past two columns it keeps adding columns
    // and shrinks everything a step per column, so a document with many tabs can
    // never push this drop-up off the top of the screen.
    const ROWS = 8;
    const cols = Math.max(1, Math.ceil(options.length / ROWS));
    menu.style.setProperty('--vh-rows', String(Math.min(options.length, ROWS)));
    menu.style.setProperty('--vh-scale', String(menuScale(cols)));
    menu.innerHTML = options.map((o) => `
      <button class="vh-menu-item${o.key === on ? ' is-on' : ''}"
              role="option" aria-selected="${o.key === on}"
              data-tab="${esc(o.key)}">
        <span class="vh-menu-check" aria-hidden="true">✓</span>
        <span class="vh-menu-text">${esc(o.title)}</span>
        ${o.note ? `<span class="vh-menu-sub">${esc(o.note)}</span>` : ''}
      </button>`).join('');
  };
  fillMenu();

  const close = () => {
    wrap.classList.remove('is-open');
    btn.setAttribute('aria-expanded', 'false');
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = !wrap.classList.contains('is-open');
    if (open) {
      fillMenu();
      keepMenuOnScreen(wrap, menu);
    }
    wrap.classList.toggle('is-open', open);
    btn.setAttribute('aria-expanded', String(open));
  });

  menu.addEventListener('click', (e) => {
    const item = e.target.closest('.vh-menu-item');
    if (!item) return;
    applyTabSelection(item.dataset.tab || null);
    close();
  });

  document.addEventListener('click', close, { once: false, signal: hudFilterAbort().signal });
}

/** Full size up to two columns, then a step smaller per extra column. */
function menuScale(cols) {
  return cols <= 2 ? 1 : Math.max(0.6, 1 - (cols - 2) * 0.1);
}

/**
 * The drop-up opens leftward from the filter button. With enough columns it can
 * outgrow the space to the left, so slide it back inside the window — measured
 * once as it opens, not on any hot path.
 */
function keepMenuOnScreen(wrap, menu) {
  menu.style.right = '';
  const MARGIN = 8;
  const left = wrap.getBoundingClientRect().right + 6 - menu.offsetWidth;
  if (left < MARGIN) menu.style.right = `${-6 - (MARGIN - left)}px`;
}

/** One abort controller per HUD build, so old close-handlers do not pile up. */
let hudFilterController = null;
function hudFilterAbort() {
  if (hudFilterController) hudFilterController.abort();
  hudFilterController = new AbortController();
  return hudFilterController;
}

/** Apply a tab choice locally, then let the side panel know it changed. */
/**
 * Every change of scope comes through here — the bar's dropdown, the side
 * panel, the replay picker, and the current-tab watcher — so the bar, the
 * panel and the fold can never disagree about what is selected.
 */
function applyTabSelection(pick, sync = true) {
  if (!allEntries.length) return false;
  tabState.pick = normalizePick(pick);
  tabState.selected = resolvePick(tabState.pick);
  buildForSelection(null, null);
  renderHUD(analysis);
  if (sync) broadcast({ type: 'VISOR_TAB_SYNC', tabState: tabInfo() });
  return true;
}

/*
 * Current-tab mode: follow the tab being viewed in Docs.
 *
 * Docs changes tabs with history.replaceState, which fires no event a content
 * script can hear, so this polls the address. It is a single string comparison
 * and does nothing at all outside current-tab mode or on a one-tab document.
 */
visorInterval(() => {
  if (tabState.pick !== PICK_CURRENT || tabState.tabs.length < 2 || !allEntries.length) return;
  if (running) return;
  const now = currentDocTab();
  if (now === tabState.selected) return;
  tabState.selected = now;
  buildForSelection(null, null);
  renderHUD(analysis);
  broadcast({ type: 'VISOR_TAB_SYNC', tabState: tabInfo() });
}, 400);

/** Document-length sparkline, drawn from real per-step buffer lengths. */
function sparkline(growth) {
  if (!growth || growth.length < 2) return '';
  const W = 74, H = 20;
  const max = Math.max(...growth.map((g) => g.length), 1);
  const pts = growth.map((g, i) => {
    const x = (i / (growth.length - 1)) * W;
    const y = H - (g.length / max) * (H - 2) - 1;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return `
    <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Document growth">
      <defs>
        <linearGradient id="vh-spark-g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="rgba(90,200,250,.55)"/>
          <stop offset="100%" stop-color="rgba(90,200,250,0)"/>
        </linearGradient>
      </defs>
      <polygon points="0,${H} ${pts} ${W},${H}" fill="url(#vh-spark-g)"/>
      <polyline points="${pts}" fill="none" stroke="rgba(90,200,250,.95)" stroke-width="1.4"
                stroke-linejoin="round" stroke-linecap="round"/>
    </svg>`;
}

// ── Replay overlay ───────────────────────────────────────────────────────────

function openReplay(startStep = null) {
  if (visorStopped) return;
  // Defensive: anything that is not a real step index is treated as "from the
  // top". Guarantees only cloneable data reaches postMessage.
  const step = typeof startStep === 'number' && isFinite(startStep) ? startStep : null;

  // Re-opening during the closing fade: cancel the removal, or the overlay is
  // taken away 320ms after it comes back — Escape, then the play button.
  clearTimeout(replayRemoval);
  replayRemoval = null;

  let overlay = document.getElementById('visor-replay-overlay');
  if (overlay) {
    overlay.classList.add('is-open');
    if (step != null) {
      overlay.querySelector('iframe')
        ?.contentWindow.postMessage({ source: 'VISOR_REPLAY_SEEK', step }, REPLAY_ORIGIN);
    }
    return;
  }

  overlay = document.createElement('div');
  overlay.id = 'visor-replay-overlay';
  overlay.setAttribute('data-visor-theme', injectedTheme);
  overlay.innerHTML = `
    <div class="vr-scrim"></div>
    <div class="vr-shell">
      <iframe id="visor-replay-frame" src="${chrome.runtime.getURL('replay.html')}"
              title="Visor live replay" allow="clipboard-read"></iframe>
    </div>`;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('is-open'));

  overlay.querySelector('.vr-scrim')?.addEventListener('click', closeReplay);

  // The replay announces itself when its listeners are live. Waiting for the
  // iframe's own load event is a race: an extension resource can finish loading
  // before the listener is attached, and the payload is then never delivered —
  // which is what left the replay sitting on "Preparing replay…".
  pendingStart = step;
  replayReady = false;

  // Belt and braces: if the announcement is somehow missed, try once on load.
  overlay.querySelector('iframe')?.addEventListener('load', () => {
    if (!replayReady) setTimeout(sendReplayInit, 60);
  });
}

let pendingStart = null;
let replayReady  = false;

/*
 * The extension's own origin, for addressing the replay frame.
 *
 * Every message to it used to go to "*", which means "whatever is in that
 * frame now" — and the frame lives in the page's DOM, where page script can
 * change its src. The payload is the document's text and its authors, so it is
 * addressed rather than broadcast.
 */
const REPLAY_ORIGIN = (() => {
  try { return new URL(chrome.runtime.getURL('replay.html')).origin; }
  catch (_) { return '*'; }
})();

function sendReplayInit() {
  const frame = document.getElementById('visor-replay-frame');
  if (!frame || !frame.contentWindow) return;

  const payload = replayPayload();
  if (!payload) {
    // Nothing to replay — say so rather than spinning forever.
    frame.contentWindow.postMessage({
      source: 'VISOR_REPLAY_ERROR',
      message: 'No revision history is loaded for this document yet.'
    }, REPLAY_ORIGIN);
    return;
  }

  try {
    frame.contentWindow.postMessage(
      {
        source: 'VISOR_REPLAY_INIT',
        payload,
        startStep: typeof pendingStart === 'number' ? pendingStart : null,
        theme: injectedTheme
      },
      REPLAY_ORIGIN
    );
    replayReady = true;
  } catch (err) {
    // A clone failure used to look identical to "never arrived"; say what it was.
    frame.contentWindow.postMessage({
      source: 'VISOR_REPLAY_ERROR',
      message: `Replay data could not be transferred (${err && err.name ? err.name : 'error'}).`
    }, REPLAY_ORIGIN);
  }
}

/** The pending removal after the closing fade, so re-opening can cancel it. */
let replayRemoval = null;

function closeReplay() {
  const overlay = document.getElementById('visor-replay-overlay');
  if (!overlay) return;
  overlay.classList.remove('is-open');
  clearTimeout(replayRemoval);
  replayRemoval = setTimeout(() => { overlay.remove(); replayRemoval = null; }, 320);
}

/*
 * Only the replay's own frame may speak for the replay.
 *
 * These messages arrive through the page's window, so without a check any
 * script on docs.google.com could close the replay, or — worse — claim to be
 * it and be sent the whole payload: the document's text, its authors, its
 * sessions. Comparing the source against the frame's own window is the check;
 * the payload is also addressed to the extension's origin rather than "*".
 */
window.addEventListener('message', (e) => {
  if (!e.data) return;
  const frame = document.getElementById('visor-replay-frame');
  if (!frame || e.source !== frame.contentWindow) return;
  if (e.data.source === 'VISOR_REPLAY_CLOSE') closeReplay();
  if (e.data.source === 'VISOR_REPLAY_READY') sendReplayInit();
  if (e.data.source === 'VISOR_REPLAY_SET_TAB') {
    // A session's start point belongs to the scope the replay was opened in;
    // carried into a different tab it would jump to an unrelated position.
    pendingStart = null;
    applyTabSelection(e.data.tabId || null);
    sendReplayInit();                   // re-send the payload for the new scope
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeReplay();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const fmtInt = (n) => Number(n || 0).toLocaleString();
const firstName = (n) => String(n || 'Unknown').split(' ')[0];

function fmtMins(m) {
  if (!m) return '<1m';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}

// ── Boot ─────────────────────────────────────────────────────────────────────

injectLauncher();

/**
 * Docs rebuilds its toolbar as you work, and that takes Visor's button with it,
 * so the button has to be replaced when it disappears. Watching the whole
 * document for that is what made Docs stutter and flash: the editor mutates its
 * DOM continuously — every keystroke, caret blink and scroll — and a
 * `subtree: true` observer on <body> makes the browser record every one of
 * those mutations and wake this script for each batch.
 *
 * Worse, Docs owns the toolbar container and reconciles it. Re-inserting into
 * it could provoke an immediate removal, and the two sides would then fight
 * frame after frame. Since the button carries a backdrop-filter, every one of
 * those inserts forced the compositor to re-snapshot the page behind it, which
 * is what made the window blink.
 *
 * So: watch only the element the button actually sits in, never the subtree;
 * coalesce to at most one check per frame; and if Docs keeps pulling the button
 * out, stop competing and move to the floating position it leaves alone.
 */
const REINJECT_LIMIT = 6;        // within the window below
const REINJECT_WINDOW_MS = 10_000;

let reinjects = 0;
let windowStart = 0;
let checkQueued = false;
let gaveUpOnToolbar = false;

const launcherObserver = new MutationObserver(queueLauncherCheck);

function watchLauncherHost() {
  launcherObserver.disconnect();
  if (gaveUpOnToolbar) return;
  const host = document.getElementById(VISOR_BTN_ID)?.parentElement;
  // No point observing <body> — that is the fallback position, which is safe.
  if (host && host !== document.body) {
    launcherObserver.observe(host, { childList: true });
  }
}

function queueLauncherCheck() {
  if (checkQueued) return;
  checkQueued = true;
  requestAnimationFrame(checkLauncher);
}

function checkLauncher() {
  checkQueued = false;
  if (document.getElementById(VISOR_BTN_ID)) {
    upgradeLauncherPlacement();
    return;
  }

  const now = Date.now();
  if (now - windowStart > REINJECT_WINDOW_MS) { windowStart = now; reinjects = 0; }
  reinjects += 1;

  if (reinjects > REINJECT_LIMIT) {
    // Docs is reconciling the toolbar out from under us. Stop fighting it.
    gaveUpOnToolbar = true;
    launcherObserver.disconnect();
    injectLauncher(true);
    return;
  }

  injectLauncher(false);        // the give-up path returned above
  watchLauncherHost();
}

watchLauncherHost();

// Safety net for the case the observer cannot cover: Docs removing the whole
// container the button lived in, which silently ends the observation above.
// One getElementById every three seconds costs nothing.
visorInterval(queueLauncherCheck, 3000);

// The toolbar is built in stages during load, so claim the good position as
// soon as it appears rather than sitting in the floating fallback.
[600, 1800, 4000, 9000].forEach((t) => setTimeout(queueLauncherCheck, t));

// Docs settles the row's height after its own fonts and avatars land, so the
// alignment is taken again once things have stopped moving, and on resize.
[1200, 3000, 6000].forEach((t) => setTimeout(centreLauncher, t));
let centreTimer = null;
addEventListener('resize', () => {
  // One trailing measurement. Dragging a window edge fires this dozens of
  // times, and each measurement writes a style and then reads layout back.
  clearTimeout(centreTimer);
  centreTimer = setTimeout(centreLauncher, 150);
}, { passive: true });

// Track SPA navigation between documents.
//
// Compare the document's identity, never location.href. Docs rewrites the URL
// constantly while you work — the heading anchor as you move through the
// outline, `?tab=t.xxxx` when you switch document tabs, assorted cursor state —
// and none of that is a navigation. Treating it as one threw away the fetched
// log, the fold cache and the HUD several times a minute, forcing a full
// re-fetch and re-fold each time.
//
// It is also the flicker. The HUD was removed and rebuilt, and a rebuilt HUD
// starts at opacity 0 and fades in over 0.45s — "invisible for a few hundred
// milliseconds", exactly. A compositor-driven opacity animation repaints
// nothing, which is why paint flashing showed no green anywhere.
const docKey = () => `${getDocKind() || ''}:${getFileId() || ''}`;
let lastDocKey = docKey();

visorInterval(() => {
  const key = docKey();
  if (key === lastDocKey) return;
  lastDocKey = key;
  docGeneration += 1;         // anything in flight now belongs to the past
  timeline = null;
  analysis = null;
  allEntries = [];
  allUsers = [];
  tabState = { tabs: [], resolvable: false, pick: PICK_CURRENT, selected: null };
  hudChipKey = '';
  awareSync();        // the colours belonged to the document that was open
  clearFoldCache();   // a different document: nothing cached applies, and the
                      // folds are the largest thing Visor holds on this page
  document.getElementById(VISOR_HUD_ID)?.remove();
  document.getElementById(VISOR_TAB_ID)?.remove();
  closeReplay();
  lastRevisionSeen = 0;
  // The probe describes the document that was open: its edit access, its
  // revision hint, its tab titles. Kept, it made a view-only document's
  // verdict stick to the next one — no bar at all until a hard reload — and
  // fed the old document's tab titles to the new document's roster.
  probeResult = { editable: null, revisionHint: 0, liveTabs: [], ready: false };
  [0, 500, 1500].forEach((t) => setTimeout(askPageProbe, t));
  // The schedule belongs to the document that was open, not to this one.
  barInterval = BAR_CHECK_MIN_MS;
  barNextCheck = 0;
  lastCheckAt = 0;
  lastTouchAt = 0;
  lastReadAt = 0;
  // Docs replaces the title bar between documents, so the element that was
  // being watched is gone; find the new one.
  saveWatched = null;
  if (saveWatcher) { saveWatcher.disconnect(); saveWatcher = null; }
  launcherHost = null;
  launcherSettled = false;
  // The old bar's dropdown had a document-level click handler on it.
  hudFilterAbort();
  pendingStart = null;
  replayReady = false;
  [400, 1500, 4000].forEach((t) => setTimeout(watchSaveState, t));
  // The next document gets the same welcome as the first: a button, and no
  // reading until it is pressed.
  hudCollapsed = true;
  [200, 1200, 3000].forEach((t) => setTimeout(autoShowBar, t));
  setTimeout(readIfLinked, 4000);
}, 1000);
