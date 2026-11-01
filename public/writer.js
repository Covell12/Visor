/* Visor Writer — the student editor (/write/:assignmentId).
   A Docs-style letter page built on Quill 2 (vendored in /vendor/quill). The
   document model (formats, pictures, how stored text becomes a Quill delta) is
   doc-format.js; the menus, toolbar, find panel and outline are docs-ui.js
   (DocsUI), which drives the editor only through writerExec and the callbacks
   handed to DocsUI.mount. Without DocsUI the editor still works (keyboard
   shortcuts and a small bar with the word count and sources).

   Every user edit becomes ops (insert / delete / format) labelled with where it
   came from (typed, pasted, a picture, a table, find & replace, undo…). Ops
   queue here and go to the server every 1.5 s; the server applies them to its
   own copy of the text and refuses anything that doesn't line up, and the
   editor then reloads the server's text ("Re-synced with the server"). A
   picture is one character (VisorDocFormat.EMBED) in the stored text, the same
   one index Quill gives it, so every index lines up.

   The session around the editor (start, beats, focus, timer) is
   writer-session.js. The side panel loads this same page with ?embed=panel. */

'use strict';

const WR_FLUSH_MS = 1500;
const WR_DF = window.VisorDocFormat;
const WR_EMBED = WR_DF.EMBED;
const WR_Delta = Quill.import('delta');
const WR_INSERT_MAX = 50000;          // characters per insert op (the server's limit)
const WR_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const WR_PAGE_W = 816;                // 8.5in
const WR_PAGE_TEXT_H = 864;           // 9in of writing per letter page (11in less two 1in margins)
const WR_MARGIN = 96;                 // 1in
const WR_TEXT_W = 624;                // 6.5in between the margins: a full-width picture
const WR_ZOOMS = [50, 75, 90, 100, 125, 150, 200];
const WR_IS_MAC = /Mac|iPhone|iPad/i.test(navigator.platform || '');
// Commands that change the essay (refused while writing is locked)
const WR_EDIT_CMDS = new Set(['undo', 'redo', 'style', 'font', 'size', 'sizeStep', 'bold', 'italic', 'underline', 'strike', 'script', 'color', 'background', 'link', 'editLink', 'removeLink', 'align', 'lineheight', 'list', 'indent', 'clear', 'insertTable', 'tableOp', 'image', 'imageSize', 'imageAlt', 'specialChar', 'cut']);

const normalizeWs = s => String(s || '').replace(/\s+/g, ' ').trim();
async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s)));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
// The same text arithmetic as lib/writing.js, for the text after a batch
function applyTextOp(text, op) {
  if (op.k === 'i') return text.slice(0, op.at) + op.s + text.slice(op.at);
  if (op.k === 'd') return text.slice(0, op.at) + text.slice(op.at + op.len);
  return text;
}
// beforeinput inputType -> op source (Section 6.2)
function srcForInputType(type, composing) {
  if (!type) return null;
  if (type === 'insertText' || type === 'insertCompositionText') return composing || type === 'insertCompositionText' ? 'ime' : 'type';
  if (type === 'insertFromPaste' || type === 'insertFromPasteAsQuotation') return 'paste';
  if (type === 'insertFromDrop') return 'drop';
  if (type === 'insertReplacementText') return 'replace';
  if (type === 'historyUndo') return 'undo';
  if (type === 'historyRedo') return 'redo';
  if (type.startsWith('delete')) return 'type';
  if (type === 'insertParagraph' || type === 'insertLineBreak') return 'type';
  return 'other';
}
// Settings kept on this device (they may be unavailable: private windows, blocked storage)
const writerPref = (key, fallback) => { try { const v = localStorage.getItem(key); return v == null ? fallback : v; } catch { return fallback; } };
const writerSetPref = (key, value) => { try { localStorage.setItem(key, String(value)); } catch {} };

/* ====================== the page ====================== */
VisorRouter.add('/write/:id', async (el, { id }, query) => {
  Object.assign(WR, { assignmentId: id, embed: query.get('embed') === 'panel', instrChoice: null, instrShown: false, sideOpen: false, srcTab: null, panelClosed: false, toolsSeen: new Set(), events: [], offline: null, offlinePause: null, queue: [], seq: 0, confirmedText: '', copied: new Set(), copiedHashes: new Set(), hashWaits: [], pendingSrc: null, lastBeforeInput: null, composing: false, saving: false, lastLock: undefined, banner: null, data: null, session: null, token: null, lease: null, panelCtx: null, researchSent: undefined,
    imageIds: new Set(), imageToken: null, queueDetached: false, lastRange: null, textCache: null, find: null, findDirty: false, outline: null, outlineSig: '', outlineRev: 0, pages: 1, zoom: 1, loads: 0, docsUI: false, lastCanEdit: undefined, breaksSig: '', printing: false, pastePending: null, pasteConv: null, storedOwn: false, selSig: '', changeN: 0, fitW: 0, selWords: null });
  WR.surf = WR.embed ? 'panel' : 'tab';
  WR.surfaceId = wsSurfaceId(WR.embed);
  WR.startError = null; WR.extOther = null; WR.refreshSig = null;
  el.innerHTML = `<div class="page"><div class="loading-row"><span class="spinner"></span></div></div>`;
  if (WR.embed) {
    // The side panel hands this page the student's tokens (no cookie here)
    const auth = await embedAuth();
    WR.extToken = auth.extToken;
  }
  try { WR.data = await writerFetch(); }
  catch (e) {
    if (e.data?.reviewUrl) { el.innerHTML = `<div class="page"><div class="card card-pad">${esc(e.message)} <a href="${esc(e.data.reviewUrl)}" data-link>Go to the submissions</a></div></div>`; return; }
    throw e;
  }
  VisorRouter.title(WR.data.assignment?.title);
  WR.doc = WR.data.doc; WR.session = WR.data.session; WR.token = WR.data.token; WR.lease = WR.doc.lease;
  WR.serverOffset = Date.parse(WR.data.serverNow) - Date.now();
  writerRender(el);
  wsInstall();
  if (window.VisorExt && !WR.embed) VisorExt.ping().then(p => { wsNoteExt(p); writerRefresh(); wsRearmExtension(p); });
  if (wsActive()) { writerCheckStoredQueue(); wsBeat(); }
  else writerCheckStoredQueue();
  return () => {
    wsUninstall(); writerFlush({ unload: true });
    writerTeardown();
    WR.barObserver?.disconnect(); WR.barObserver = null;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    document.body.classList.remove('writing', 'embed');
    // A citation arriving after leaving the editor must not land in it
    WR.data = null; WR.quill = null; WR.token = null;
  };
});

// The editor's payload. Every fetch brings a fresh image token (12 h).
async function writerFetch() {
  const data = await wapi(`/api/write/${WR.assignmentId}${WR.embed ? '?surf=panel' : ''}`);
  if (data && data.imageToken) WR.imageToken = data.imageToken;
  return data;
}

// Side panel: wait for { source:'visor-ext', type:'EMBED_AUTH', sessionToken, extToken } from the extension page that framed us
function embedAuth() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Open this from the Visor extension’s side panel.')), 8000);
    window.addEventListener('message', function onMsg(e) {
      if (!/^chrome-extension:\/\//.test(e.origin) || e.source !== window.parent) return;
      const m = e.data;
      if (!m || m.source !== 'visor-ext') return;
      if (m.type === 'EMBED_AUTH') { clearTimeout(timer); window.removeEventListener('message', onMsg); WR.embedOrigin = e.origin; resolve({ extToken: m.extToken, sessionToken: m.sessionToken }); }
    });
    window.parent.postMessage({ source: 'visor-page', type: 'EMBED_READY' }, '*');
  });
}

// Side panel: { source:'visor-ext', type:'PANEL_CONTEXT', chromeFocused, onBlockedPage }
// from the extension page around this one, on every change and every 5 s.
// While the panel holds the lease, time on another (unblocked) tab is research.
window.addEventListener('message', e => {
  const m = e.data;
  if (!m || m.source !== 'visor-ext' || m.type !== 'PANEL_CONTEXT') return;
  if (!WR.embed || e.source !== window.parent || e.origin !== WR.embedOrigin) return;
  const ctx = { focused: !!m.chromeFocused, blocked: !!m.onBlockedPage };
  const changed = !WR.panelCtx || WR.panelCtx.focused !== ctx.focused || WR.panelCtx.blocked !== ctx.blocked;
  WR.panelCtx = ctx;
  if (!changed || !WR.data) return;
  writerApplyLock();
  wsBeat();
});

// The page: header (title, status, actions, then the menu bar), the toolbar,
// then the canvas with the outline and the letter page, and the Works Cited
// as a second page below it.
function writerRender(el) {
  const { assignment: a, class: cls } = WR.data;
  const w = a.writing || {};
  WR.docStyle = w.docStyle === 'docs' ? 'docs' : 'mla';
  const style = WR_DF.styleClass(WR.docStyle);
  WR.spellcheck = writerPref('visor-spell', '1') !== '0';
  WR.pageBreaks = writerPref('visor-pagebreaks', '1') !== '0';
  WR.outlineOpen = !WR.embed && writerPref('visor-outline', '0') === '1';
  const z = writerPref('visor-zoom', null);
  WR.zoomSetting = z === 'fit' ? 'fit' : WR_ZOOMS.includes(Number(z)) ? Number(z) : (window.innerWidth < 900 ? 'fit' : 100);
  // Works Cited, as the teacher set it: a page after the essay, a side panel, or off
  const works = writerWorksMode();
  // The side panel embed has no room for a second panel: its sources sit under the page
  const sourcesBelow = works === 'page' || (works === 'panel' && WR.embed);
  WR.sideOpen = works !== 'off' && !WR.embed && writerPref(`visor-side:${a.id}`, works === 'panel' && window.innerWidth >= 1280 ? '1' : '0') === '1';
  el.innerHTML = `<div class="wr dx ${WR.embed ? 'wr-embed' : ''} wr-works-${works}">
    <header class="wr-bar">
      <div class="wr-head">
        ${WR.embed ? '' : `<a class="wr-logo" href="/a/${a.id}" data-link aria-label="Back to the assignment" title="Back to the assignment"><img src="/logo.png" alt="" /></a><a class="wr-back" href="/a/${a.id}" data-link aria-label="Back to the assignment" title="Back to the assignment">${PI.left}</a>`}
        <div class="wr-head-main">
          <div class="wr-title-row">
            <div class="wr-title"><h1 class="wr-h" title="${esc(a.title)}">${esc(a.title)}</h1></div>
            ${WR.embed ? '' : `<a class="wr-cls" href="/class/${cls.id}" data-link title="Go to ${esc(cls.name)}">${esc(cls.name)}</a>`}
            <span class="wr-saved" id="wrSaved" role="status"></span>
          </div>
          <div id="dxMenubar" class="dx-menubar-slot"></div>
        </div>
        <div class="wr-head-right">
          <div class="wr-status" id="wrStatus" aria-live="polite"></div>
          <div class="wr-actions" id="wrActions"></div>
          ${WR.embed ? '' : writerUserMenu()}
        </div>
      </div>
    </header>
    <div id="dxToolbar" class="dx-toolbar-slot"></div>
    <div id="dxCanvas" class="dx-canvas${WR.outlineOpen ? ' dx-outline-on' : ''}${WR.sideOpen ? ' dx-side-on' : ''}">
      <aside id="dxOutline" class="dx-outline" aria-label="Outline"></aside>
      <div class="dx-pages" id="dxPages">
        <!-- Above the page, exactly as wide as it at any zoom: banners, the
             Instructions dropdown and the start card -->
        <div class="dx-above">
          <div id="wrBanner" class="wr-banner-slot"></div>
          ${WR.embed ? '' : '<section id="wrInstr" class="wr-instr-drop"></section>'}
          <div id="wrIntro" class="dx-intro"></div>
        </div>
        <div class="wr-paper dx-page ${style}" id="wrPaper">
          <div id="wrEditor"></div>
          <div id="dxBreaks" class="dx-breaks" aria-hidden="true"></div>
          <div id="wrOverlay" class="wr-overlay hidden"></div>
        </div>
        ${sourcesBelow ? `<div id="wrSources" class="dx-sources ${style}"></div>` : ''}
      </div>
      ${works !== 'off' && !WR.embed ? `<aside id="wrSide" class="dx-side" aria-label="Sources" ${WR.sideOpen ? '' : 'inert'}><div class="dx-side-inner">
        <div class="dx-side-head"><b id="wrSideTitle" tabindex="-1">Sources</b><span class="dx-side-style">${esc({ mla: 'MLA', apa: 'APA', chicago: 'Chicago' }[w.citationStyle] || 'MLA')}</span><button type="button" class="btn-icon" aria-label="Close sources" title="Close" onclick="writerToggleSources(false)">${I.x}</button></div>
        <div class="dx-side-body" id="wrSideBody"></div></div></aside>` : ''}
    </div>
    <div id="dxPrint" class="dx-print"></div>
  </div>`;
  WR.barObserver?.disconnect();
  // (Each reports on the next frame: setting the sizes inside the callback
  // changed what was being watched, and Chrome logged "ResizeObserver loop" errors.)
  WR.barObserver = window.ResizeObserver ? new ResizeObserver(() => requestAnimationFrame(writerSyncBarHeight)) : null;
  WR.barObserver?.observe(el.querySelector('.wr-bar'));
  WR.barObserver?.observe($('dxToolbar'));
  // Fit follows the page column's width whatever changes it (the outline
  // opening or closing, a window resize). A change smaller than a scrollbar is
  // left alone: re-fitting for it could bring the scrollbar back and forth.
  WR.pagesObserver?.disconnect();
  WR.pagesObserver = window.ResizeObserver ? new ResizeObserver(() => requestAnimationFrame(() => {
    const w = $('dxPages')?.clientWidth || 0;
    if (WR.zoomSetting === 'fit' && Math.abs(w - (WR.fitW || 0)) > 24) writerApplyZoom(true);
  })) : null;
  WR.pagesObserver?.observe($('dxPages'));
  writerSetupQuill();
  writerInstall();
  writerApplyZoom(false);
  writerMountUi();
  writerLoadServerText(WR.doc, { force: true });
  writerRenderInstructions();
  writerRefresh();
  writerSyncBarHeight();
}

// 'page' (a Works Cited page after the essay; older assignments), 'panel' or 'off'
function writerWorksMode() {
  const v = WR.data?.assignment?.writing?.worksCited;
  return v === 'panel' || v === 'off' ? v : 'page';
}
// The avatar at the right of the header (the site's own bar is hidden here)
function writerUserMenu() {
  if (!window.ddHtml || !me) return '';
  return '<div class="wr-user">' + ddHtml({ id: 'wrUser', btnClass: 'wr-avatar', btn: avatarHtml(me, 'avatar-sm'), label: `${me.name}: menu`, right: true, items: [
    { header: me.name },
    { label: 'Home', icon: PI.list, href: '/' },
    { label: 'This assignment', icon: I.doc, href: `/a/${WR.data.assignment.id}` },
    'sep',
    { label: 'Profile settings', icon: I.gear, onclick: 'openProfile()' },
    { label: 'Sign out', icon: I.x, onclick: 'signOut()' }
  ] }) + '</div>';
}

// DocsUI (docs-ui.js) builds the menus, toolbar, dialogs, find panel and
// outline. It never touches Quill: it calls writerExec and these callbacks.
function writerMountUi() {
  WR.docsUI = false;
  const UI = window.DocsUI;
  // A callback that throws must not break the menus (or the editor)
  const safe = (fn, fallback) => (...args) => { try { return fn(...args); } catch (e) { console.error(e); return fallback; } };
  if (UI && typeof UI.mount === 'function') {
    try {
      UI.mount({
        menubar: $('dxMenubar'), toolbar: $('dxToolbar'), outline: $('dxOutline'), canvas: $('dxCanvas'),
        compact: !!WR.embed,
        exec: safe((cmd, value) => writerExec(cmd, value), false),
        getOutline: safe(() => writerOutline(), []),
        find: safe((q, o) => writerFind(q, o), { count: 0, current: 0 }),
        findStep: safe(dir => writerFindStep(dir), { count: 0, current: 0 }),
        replace: safe(s => writerReplace(s), { count: 0, current: 0 }),
        replaceAll: safe(s => writerReplaceAll(s), { replaced: 0 }),
        clearFind: safe(() => writerClearFind()),
        wordCount: safe(() => writerWordStats(), { pages: 1, words: 0, chars: 0, charsNoSpaces: 0 }),
        sources: safe(() => (WR.doc?.sources || []).map(s => ({ id: s.id, inText: s.inText, title: s.title || s.url || '' })), []),
        insertCitation: safe(id => writerCiteSource(id), false),
        uploadImage: safe(() => writerPickImage(), false),
        getImageSelection: safe(() => writerImageSelection(), null),
        getSelectionRect: safe(() => writerSelectionRect(), null),
        getLink: safe(() => writerGetLink(), null),
        docStyle: WR.docStyle, zoom: WR.zoomSetting, pageBreaks: WR.pageBreaks, spellcheck: WR.spellcheck, outlineOpen: WR.outlineOpen,
        // Citation tools only when the assignment has a Works Cited page or panel.
        // The word count floats (as in Docs); the side panel keeps its toolbar chips.
        citations: writerWorksMode() !== 'off', wcChip: !!WR.embed, sourcesChip: !!WR.embed
      });
      WR.docsUI = true;
    } catch (e) {
      console.error('The menus couldn’t load', e);
      try { UI.unmount?.(); } catch {}
    }
  }
  if (!WR.docsUI) writerFallbackBar();
  writerScheduleUi();
}

// No DocsUI: a small bar with what the essay still needs (keyboard shortcuts do the rest)
function writerFallbackBar() {
  const el = $('dxToolbar'); if (!el) return;
  el.innerHTML = `<div class="dx-fallback-bar" role="toolbar" aria-label="Essay">
    <span class="wr-wc" id="wrWords" aria-live="off">0 words</span>
    ${writerWorksMode() === 'off' ? '' : `<button type="button" class="wr-tb-btn" id="wrSourcesBtn" onclick="writerToggleSources()">Sources (0)</button>
    <button type="button" class="wr-tb-btn" id="wrCiteBtn" onclick="writerInsertCitationMenu()">Insert citation</button>`}
  </div>`;
}

// Listeners outside the editor (removed by wsUninstall with the session's)
function writerInstall() {
  const on = (target, ev, fn, opts) => { target.addEventListener(ev, fn, opts); WR.listeners.push([target, ev, fn, opts]); };
  // Copy and cut: remember what was copied (before Quill's own cut deletes it),
  // so pasting it back counts as moving text within the essay
  on(document, 'copy', writerRememberCopy, true);
  on(document, 'cut', writerRememberCopy, true);
  on(document, 'keydown', writerDocKeys);
  on(window, 'resize', () => { writerApplyZoom(true); writerLayoutSoon(); });
  on(window, 'scroll', writerSyncToolbarEdge, { passive: true });
  on(window, 'afterprint', writerAfterPrint);
  wsWatchTools();
  // A font that arrives late changes where lines (and pages) end
  if (document.fonts && document.fonts.addEventListener) on(document.fonts, 'loadingdone', () => writerLayoutSoon());
}

// Leaving the page: the menus, timers and highlights go with it
function writerTeardown() {
  try { if (WR.docsUI) window.DocsUI?.unmount?.(); } catch (e) { console.error(e); }
  WR.docsUI = false;
  for (const k of ['wcTimer', 'layoutTimer', 'findTimer', 'imgRefreshTimer']) { clearTimeout(WR[k]); WR[k] = null; }
  if (WR.uiFrame) cancelAnimationFrame(WR.uiFrame);
  WR.uiFrame = 0;
  writerClearHighlights();
  try { if (window.CSS && CSS.highlights) CSS.highlights.delete('dx-sel'); } catch {}
  WR.selSig = '';
  WR.pagesObserver?.disconnect(); WR.pagesObserver = null;
  WR.toolsObserver?.disconnect(); WR.toolsObserver = null;
  writerAfterPrint();
  document.documentElement.style.removeProperty('--dx-sticky-h');
  document.body.classList.remove('writing-focus');
  document.documentElement.style.removeProperty('--dx-tb-bottom');
}

/* ====================== Quill and op capture ====================== */
function writerSetupQuill() {
  WR_DF.registerQuill(Quill);
  const rowIds = new WeakMap();
  const quill = new Quill('#wrEditor', {
    theme: 'snow',
    formats: WR_DF.QUILL_FORMATS,
    placeholder: 'Start writing…',
    modules: {
      toolbar: false,   // the menus and toolbar are DocsUI's
      table: true,
      history: { delay: 800, maxStack: 500, userOnly: true },
      keyboard: { bindings: writerKeyBindings() },
      uploader: { mimetypes: WR_IMAGE_TYPES.slice(), handler: (range, files) => writerInsertImages(range, files) },
      clipboard: { matchers: [['img', writerMatchImage], ['tr', (node, delta) => writerMatchRow(node, delta, rowIds)], [Node.TEXT_NODE, writerMatchText]] }
    }
  });
  WR.quill = quill;
  const root = quill.root;
  root.setAttribute('autocomplete', 'off'); root.setAttribute('autocorrect', 'off'); root.setAttribute('autocapitalize', 'off');
  root.setAttribute('spellcheck', WR.spellcheck ? 'true' : 'false');
  root.setAttribute('aria-label', 'Your essay');
  // Grammar and AI writing tools that other extensions add to text boxes, and
  // the browser's own writing suggestions ("Help me write"), stay out of the
  // essay when the assignment blocks AI sites: these are the switches those
  // tools honour. wsWatchTools (writer-session.js) records any that come anyway.
  if (WR.data.assignment.writing.blockAiSites !== false) {
    for (const [k, v] of [['writingsuggestions', 'false'], ['data-gramm', 'false'], ['data-gramm_editor', 'false'], ['data-enable-grammarly', 'false'], ['data-lt-active', 'false']]) root.setAttribute(k, v);
  }

  // Everything pasted (HTML or plain text) is checked once more as a whole. In
  // a table cell it becomes text in that one cell (cells are a single line).
  const clip = quill.getModule('clipboard');
  const convert = clip.convert.bind(clip);
  clip.convert = (data, formats) => {
    const inCell = !!formats && formats.table != null;
    // writerOnPaste may have converted this HTML already (for the paste setting)
    const c = WR.pasteConv;
    const d = !inCell && c && data && data.html && c.html === data.html && c.text === (data.text || '') ? c.delta : writerCleanPaste(convert(data, formats));
    return inCell ? writerFlattenForCell(d) : d;
  };
  // Quill's paste, done here: labelled however long Quill takes, and a table
  // pasted after text on a line goes on its own lines
  clip.onPaste = (range, data) => writerPasteInto(range, data);

  // Undo/redo from the keyboard go through the history module too
  const hist = quill.getModule('history');
  for (const kind of ['undo', 'redo']) {
    const orig = hist[kind].bind(hist);
    hist[kind] = () => { WR.pendingSrc = { src: kind, it: kind === 'undo' ? 'historyUndo' : 'historyRedo', once: true }; try { orig(); } finally { WR.pendingSrc = null; } };
  }
  // An undo step can carry where its text came from (a paste, a citation, a
  // picture): undoing then redoing it puts the text back with that label
  const change = hist.change.bind(hist);
  hist.change = (from, to) => {
    const item = hist.stack[from][hist.stack[from].length - 1];
    const tag = item && item.visor;
    const n = hist.stack[to].length, prev = WR.pendingSrc;
    if (tag && item.delta.ops.some(o => o.insert != null)) WR.pendingSrc = Object.assign({}, tag, { it: from === 'undo' ? 'historyUndo' : 'historyRedo', once: true });
    try { change(from, to); } finally { if (tag) WR.pendingSrc = prev; }
    const pushed = hist.stack[to][hist.stack[to].length - 1];
    if (tag && pushed && hist.stack[to].length > n) pushed.visor = tag;
  };
  // Quill rebuilds the steps when an edit that isn't the student's lands; keep their labels
  const transform = hist.transform.bind(hist);
  hist.transform = delta => {
    const tags = s => s.map(i => i.visor);
    const u = tags(hist.stack.undo), r = tags(hist.stack.redo);
    transform(delta);
    const put = (s, t) => { if (s.length === t.length) s.forEach((i, k) => { if (t[k]) i.visor = t[k]; }); };
    put(hist.stack.undo, u); put(hist.stack.redo, r);
  };

  // Capture phase: before Quill's own handler, which applies spellcheck and
  // autocorrect replacements (insertReplacementText) straight away
  root.addEventListener('beforeinput', e => { WR.lastBeforeInput = { type: e.inputType, at: performance.now() }; }, true);
  // Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z (Ctrl+Y) go to Quill's history through its
  // own key bindings, with no input event: label those edits undo / redo
  root.addEventListener('keydown', e => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'z') WR.pendingSrc = { src: e.shiftKey ? 'redo' : 'undo', it: e.shiftKey ? 'historyRedo' : 'historyUndo', until: performance.now() + 100 };
    else if (k === 'y' && e.ctrlKey) WR.pendingSrc = { src: 'redo', it: 'historyRedo', until: performance.now() + 100 };
  }, true);
  root.addEventListener('compositionstart', () => { WR.composing = true; });
  root.addEventListener('compositionend', () => { WR.composing = false; WR.lastBeforeInput = { type: 'insertCompositionText', at: performance.now() }; });

  // Pastes: check the assignment's paste setting first (capture phase, before Quill's own handler)
  root.addEventListener('paste', e => writerOnPaste(e), true);
  root.addEventListener('drop', e => writerOnDrop(e), true);
  root.addEventListener('contextmenu', e => { if (WR.data.assignment.writing.mode === 'locked' && wsActive()) e.preventDefault(); });
  // A picture that won't load: its token probably ran out
  root.addEventListener('error', writerOnImageError, true);
  // A picture that has loaded now has its height: the page breaks move
  root.addEventListener('load', e => { if (e.target instanceof HTMLImageElement) writerLayoutSoon(); }, true);
  // Clicking a picture selects it (for its size and alt text)
  root.addEventListener('click', e => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !quill.isEnabled()) return;
    const blot = Quill.find(img);
    if (!blot || blot === quill || typeof blot.offset !== 'function') return;
    quill.setSelection(quill.getIndex(blot), 1, 'user');
  });

  // editor-change also carries Quill's silent selection updates (the caret
  // moving as the student types never fires a plain selection-change)
  quill.on('editor-change', (type, value, old, source) => {
    if (type === 'selection-change') { if (value) WR.lastRange = value; writerScheduleUi(); return; }
    if (type !== 'text-change') return;
    WR.textCache = null; WR.changeN = (WR.changeN || 0) + 1;
    if (source === 'user') writerCapture(value, old);
    writerAfterChange();
  });
  // Focus only matters to the server when it changes whether this page may write
  root.addEventListener('focus', () => { if (lockReason() !== WR.lastLock) { writerApplyLock(); wsBeat(); } });
}

// Keyboard shortcuts inside the essay (Quill's own: B, I, U, undo, redo, Tab…).
// Number keys are matched by key code, since Shift changes what they type.
function writerKeyBindings() {
  const run = (cmd, value) => () => { writerExec(cmd, value); return false; };
  const k = (key, extra, cmd, value) => Object.assign({ key, shortKey: true, handler: run(cmd, value) }, extra);
  // Enter at the end of a Title or Subtitle: the next line is normal text (as
  // Quill's own 'header enter' does for headings)
  const styleEnter = fmt => ({ key: 'Enter', collapsed: true, format: [fmt], suffix: /^$/, handler(range, context) {
    const [line, offset] = this.quill.getLine(range.index);
    this.quill.updateContents(new WR_Delta().retain(range.index).insert('\n', context.format).retain(line.length() - offset - 1).retain(1, { [fmt]: null }), 'user');
    this.quill.setSelection(range.index + 1, 0, 'silent');
    this.quill.scrollSelectionIntoView();
    return false;
  } });
  return {
    // Named as Quill's own binding, so this one replaces it
    'table enter': { key: 'Enter', shiftKey: null, format: ['table'], handler: range => { writerTableEnter(range); return false; } },
    'visor title enter': styleEnter('title'),
    'visor subtitle enter': styleEnter('subtitle'),
    'visor size up': k(['>', '.', 190], { shiftKey: true }, 'sizeStep', 1),
    'visor size down': k(['<', ',', 188], { shiftKey: true }, 'sizeStep', -1),
    'visor strike': k(['x', 'X'], { shiftKey: true }, 'strike'),
    'visor superscript': k('.', {}, 'script', 'super'),
    'visor subscript': k(',', {}, 'script', 'sub'),
    'visor align left': k(['l', 'L'], { shiftKey: true }, 'align', null),
    'visor align center': k(['e', 'E'], { shiftKey: true }, 'align', 'center'),
    'visor align right': k(['r', 'R'], { shiftKey: true }, 'align', 'right'),
    'visor align justify': k(['j', 'J'], { shiftKey: true }, 'align', 'justify'),
    'visor indent': k(']', {}, 'indent', '+1'),
    'visor outdent': k('[', {}, 'indent', '-1'),
    'visor numbered': k(55, { shiftKey: true }, 'list', 'ordered'),
    'visor bulleted': k(56, { shiftKey: true }, 'list', 'bullet'),
    'visor checklist': k(57, { shiftKey: true }, 'list', 'checked'),
    'visor clear': k('\\', {}, 'clear'),
    'visor normal text': k(48, { altKey: true }, 'style', 'normal'),
    'visor heading 1': k(49, { altKey: true }, 'style', 'h1'),
    'visor heading 2': k(50, { altKey: true }, 'style', 'h2'),
    'visor heading 3': k(51, { altKey: true }, 'style', 'h3'),
    'visor link': { key: ['k', 'K'], shortKey: true, handler: () => { writerOpenLink(); return false; } }
  };
}

// Shortcuts that work anywhere on the page: print, find, word count
function writerDocKeys(e) {
  if (!WR.quill || e.defaultPrevented || e.altKey) return;
  if (!(WR_IS_MAC ? e.metaKey : e.ctrlKey)) return;
  const k = (e.key || '').toLowerCase();
  if (k === 'p' && !e.shiftKey) { e.preventDefault(); writerExec('print'); }
  else if (k === 'f' && !e.shiftKey) { if (writerOpenFind('find')) e.preventDefault(); }
  else if (k === 'h' && e.shiftKey) { if (writerOpenFind('replace')) e.preventDefault(); }
  else if (k === 'c' && e.shiftKey) { e.preventDefault(); writerExec('wordCount'); }
}
function writerOpenFind(mode) {
  if (!WR.docsUI || typeof window.DocsUI?.openFind !== 'function') return false;
  try { DocsUI.openFind(mode); return true; } catch (e) { console.error(e); return false; }
}

/* ---- pasting ---- */

// Paste policy (Section 6.2): block cancels; internal-only allows only text
// (and pictures) from this same essay. Blocked attempts are logged as session events.
function writerOnPaste(e) {
  if (lockReason()) { e.preventDefault(); e.stopImmediatePropagation(); return; }
  WR.pasteSeq = (WR.pasteSeq || 0) + 1;
  const cd = e.clipboardData;
  const text = cd?.getData('text/plain') || '';
  const html = cd?.getData('text/html') || '';
  const files = Array.from(cd?.files || []);
  const policy = WR.data.assignment.writing.allowPaste;
  // Picture files (a screenshot, "Copy image"): Quill's uploader takes them,
  // and writerInsertImages applies the paste setting
  if (files.length && (!html || writerHtmlImages(html).only)) {
    // …unless it's a picture copied from this essay: that's moving it within the essay
    const own = html ? writerHtmlImages(html).ids.find(id => WR.imageIds.has(id)) : null;
    if (own && policy !== 'block') { e.preventDefault(); e.stopImmediatePropagation(); writerPasteOwnImage(own); }
    return;
  }
  // What Quill will insert: it takes the HTML when there is any, so that's
  // what's checked and hashed (the plain text can say something else)
  WR.pasteConv = null;
  let plain = text;
  if (html && policy !== 'block') {
    try {
      const delta = WR.quill.getModule('clipboard').convert({ html, text }, {});
      WR.pasteConv = { html, text, delta };
      plain = WR_DF.deltaText(delta.ops);
    } catch (err) { console.error(err); }
  }
  plain = plain.split(WR_EMBED).join('');
  const norm = normalizeWs(plain);
  const imgs = html ? writerHtmlImages(html).ids : [];
  const ownImagesOnly = !norm && imgs.length > 0 && imgs.every(id => WR.imageIds.has(id));
  const internal = ownImagesOnly || (!!norm && (WR.copied.has(norm) || normalizeWs(writerText().split(WR_EMBED).join('')).includes(norm)));
  if (policy === 'block' || (policy === 'internal-only' && !internal)) {
    e.preventDefault(); e.stopImmediatePropagation();
    WR.pasteConv = null;
    toast('Pasting is turned off for this assignment', 'err');
    sha256Hex(norm).then(hash => wsNoteEvent('paste-blocked', { len: plain.length, hash }));
    return;
  }
  const paste = { hash: null, len: plain.length, internal };
  if (norm) WR.hashWaits.push(sha256Hex(norm).then(h => { paste.hash = h; if (WR.copiedHashes.has(h)) paste.internal = true; }));
  // Quill's paste runs straight after this listener and takes the label
  // (writerPasteInto), however long it then takes; if it doesn't run, the label goes
  WR.pastePending = { src: 'paste', it: 'insertFromPaste', paste };
  setTimeout(() => { WR.pastePending = null; WR.pasteConv = null; }, 0);
}

// Quill's onPaste, with the paste labelled for the whole call (not a time
// window), as its own undo step, and a table pasted after text on a line put
// on lines of its own (as Insert → Table does)
function writerPasteInto(range, data) {
  const q = WR.quill;
  const p = WR.pastePending;
  WR.pastePending = null;
  try {
    const formats = q.getFormat(range.index);
    const pasted = q.getModule('clipboard').convert(data, formats);
    const d = new WR_Delta().retain(range.index).delete(range.length);
    let at = range.index;
    if (formats.table == null && writerStartsWithRow(pasted)) {
      if (q.getLine(range.index)[1] > 0) { d.insert('\n', writerBlockOnly(q.getFormat(range.index, 0))); at += 1; }
      // Right under another table the two would merge
      else if (range.index > 0 && q.getFormat(range.index - 1, 1).table != null) { d.insert('\n'); at += 1; }
    }
    WR.pendingSrc = p ? Object.assign({ once: true }, p) : null;
    writerHistoryStep(p && { src: p.src, paste: p.paste }, () => q.updateContents(d.concat(pasted), 'user'));
    q.setSelection(at + pasted.length(), 0, 'silent');
    q.scrollSelectionIntoView();
  } finally { WR.pendingSrc = null; WR.pasteConv = null; }
}
// Does the pasted delta start with a table row (its first line break is a cell's)?
function writerStartsWithRow(delta) {
  for (const op of delta.ops) {
    if (typeof op.insert !== 'string' || op.insert.indexOf('\n') < 0) continue;
    return !!(op.attributes && op.attributes.table != null);
  }
  return false;
}
// What's pasted into a table cell: inline text in that one cell. Line breaks
// (and tabs) become spaces, and line formats (rows, lists, headings) go.
function writerFlattenForCell(delta) {
  const out = new WR_Delta();
  const ops = delta.ops;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.insert == null) continue;
    let attrs;
    for (const k of Object.keys(op.attributes || {})) if (!WR_DF.isBlockKey(k)) (attrs || (attrs = {}))[k] = op.attributes[k];
    if (typeof op.insert === 'string') {
      let s = op.insert.replace(/\r\n?|\n|\t/g, m => (m === '\t' ? ' ' : '\n'));
      // the paste's own last line break adds nothing
      if (i === ops.length - 1) s = s.replace(/\n+$/, '');
      s = s.replace(/\n/g, ' ');
      if (s) out.insert(s, attrs);
    } else out.insert(op.insert, attrs);
  }
  return out;
}

// One edit as its own undo step. tag ({src, paste…}) stays with the step, so
// undoing and redoing it puts the text back with its first label.
function writerHistoryStep(tag, fn) {
  const hist = WR.quill.getModule('history');
  hist.cutoff();
  const before = hist.stack.undo[hist.stack.undo.length - 1];
  try { return fn(); } finally {
    const now = hist.stack.undo[hist.stack.undo.length - 1];
    if (tag && now && now !== before) now.visor = tag;
    hist.cutoff();
  }
}

// The pictures in pasted HTML: their ids (ours or null), and whether the HTML is just one picture
function writerHtmlImages(html) {
  if (WR.htmlScan && WR.htmlScan.html === html) return WR.htmlScan;
  let body = null;
  try { body = new DOMParser().parseFromString(html, 'text/html').body; } catch {}
  const imgs = body ? Array.from(body.querySelectorAll('img')) : [];
  const out = { html, ids: imgs.map(i => WR_DF.imageIdFromSrc(i.getAttribute('src') || '')), only: !!body && body.childElementCount === 1 && body.firstElementChild?.tagName === 'IMG' };
  WR.htmlScan = out;
  return out;
}

// A picture of this essay pasted from "Copy image": put the same picture in
function writerPasteOwnImage(id) {
  const q = WR.quill;
  const r = q.getSelection() || writerRange();
  const paste = { hash: null, len: 1, internal: true };
  WR.pendingSrc = { src: 'paste', it: 'insertFromPaste', paste, once: true };
  try { writerHistoryStep({ src: 'paste', paste }, () => q.updateContents(new WR_Delta().retain(r.index).delete(r.length).insert({ image: writerImageSrc(id) }), 'user')); } finally { WR.pendingSrc = null; }
  q.setSelection(r.index + 1, 0, 'silent');
}

// One toast per paste (or per few seconds) about pictures that were left out
function writerPictureToast() {
  const key = WR.pasteSeq || 0;
  if (WR.pictureToastFor === key && Date.now() - (WR.pictureToastAt || 0) < 3000) return;
  WR.pictureToastFor = key; WR.pictureToastAt = Date.now();
  setTimeout(() => toast('Pictures in what you pasted weren’t added. Use Insert → Image to add one.', 'err'), 0);
}

// Clipboard matchers: only this essay's own pictures; fresh row ids for
// pasted tables (one per source row); no placeholder characters in text.
function writerMatchImage(node, delta) {
  const id = WR_DF.imageIdFromSrc(node.getAttribute('src') || '');
  if (id && WR.imageIds.has(id)) return delta;
  writerPictureToast();
  return new WR_Delta();
}
function writerMatchRow(node, delta, rowIds) {
  const table = node.closest('table');
  if (!table) return delta;
  let map = rowIds.get(table);
  if (!map) rowIds.set(table, map = new Map());
  return new WR_Delta(delta.ops.map(op => {
    if (!op.attributes || op.attributes.table == null) return op;
    const key = String(op.attributes.table);
    if (!map.has(key)) map.set(key, writerNewRowId());
    return Object.assign({}, op, { attributes: Object.assign({}, op.attributes, { table: map.get(key) }) });
  }));
}
function writerMatchText(node, delta) {
  if (!delta.ops.some(op => typeof op.insert === 'string' && op.insert.indexOf(WR_EMBED) > -1)) return delta;
  return new WR_Delta(delta.ops.map(op => (typeof op.insert === 'string' ? Object.assign({}, op, { insert: op.insert.split(WR_EMBED).join('') }) : op)).filter(op => op.insert !== ''));
}
// A table row id the server accepts: "row-" and 6 letters or digits
function writerNewRowId() {
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  return 'row-' + Array.from(a, b => (b % 36).toString(36)).join('');
}

// The whole pasted delta, once more: values the document model doesn't allow
// are dropped (so Quill shows what the server keeps), no placeholder
// characters, only this essay's pictures, valid table rows.
function writerCleanPaste(delta) {
  const out = new WR_Delta();
  const rows = new Map();
  for (const op of delta.ops) {
    if (op.insert == null) continue;
    const attrs = writerCleanPasteAttrs(op.attributes, rows);
    if (typeof op.insert === 'string') {
      const s = op.insert.split(WR_EMBED).join('');
      if (s) out.insert(s, attrs);
    } else if (op.insert && op.insert.image != null) {
      const id = WR_DF.imageIdFromSrc(String(op.insert.image));
      if (id && WR.imageIds.has(id)) out.insert({ image: writerImageSrc(id) }, attrs);
      else writerPictureToast();
    } else writerPictureToast();
  }
  return out;
}
function writerCleanPasteAttrs(raw, rows) {
  if (!raw) return undefined;
  const out = {};
  for (const k of Object.keys(raw)) {
    if (k === 'image') continue;
    if (k === 'table') {
      const v = String(raw.table);
      if (/^row-[a-z0-9]{1,16}$/.test(v)) out.table = v;
      else { if (!rows.has(v)) rows.set(v, writerNewRowId()); out.table = rows.get(v); }
      continue;
    }
    const v = WR_DF.cleanValue(k, raw[k]);
    if (v != null) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

// Text drags never land (Quill's uploader cancels every drop), so nothing is
// labelled for them; dropped picture files go to the uploader.
function writerOnDrop(e) {
  if (lockReason()) { e.preventDefault(); e.stopImmediatePropagation(); return; }
  if (e.dataTransfer?.files?.length) WR.dropAt = performance.now();
}

// Copy and cut in the essay: remember the text (as the clipboard has it:
// no picture placeholders), so pasting it back counts as internal
function writerRememberCopy(e) {
  const q = WR.quill;
  if (!q || !(e.target instanceof Node) || !q.root.contains(e.target)) return;
  const r = q.getSelection(); if (!r || !r.length) return;
  const t = normalizeWs(WR_DF.deltaText(q.getContents(r.index, r.length).ops).split(WR_EMBED).join(''));
  if (!t) return;
  WR.copied.add(t); sha256Hex(t).then(h => WR.copiedHashes.add(h));
}

/* ---- where an edit came from, and the ops it becomes ---- */
function writerSourceFor(delta) {
  const p = WR.pendingSrc;
  if (p && (p.once || (p.until && performance.now() <= p.until))) { if (!p.once) WR.pendingSrc = null; return Object.assign({ pending: true }, p); }
  WR.pendingSrc = null;
  const b = WR.lastBeforeInput;
  if (b && performance.now() - b.at <= 50) return { src: srcForInputType(b.type, WR.composing) || 'other', it: b.type };
  if (WR.composing) return { src: 'ime', it: 'none' };
  let inserted = 0, cellsOnly = true, any = false;
  for (const o of delta.ops) {
    if (o.insert == null) continue;
    any = true;
    if (typeof o.insert === 'string') {
      inserted += o.insert.length;
      if (!/^\n+$/.test(o.insert) || !o.attributes || !o.attributes.table) cellsOnly = false;
    } else { inserted += 1; cellsOnly = false; }
  }
  // Empty cells Quill adds to even out a table's rows
  if (any && cellsOnly) return { src: 'structure', it: 'none' };
  // No beforeinput: Quill's own keys (Enter, Backspace, formatting) or text a
  // browser extension injected. More than one character with no input event
  // is the second kind.
  if (inserted > 1) return { src: 'other', it: 'none' };
  return { src: 'type', it: 'none' };
}

const WR_FORMAT_SRCS = new Set(['undo', 'redo', 'structure', 'replace']);
const WR_DELETE_SRCS = new Set(['replace', 'undo', 'redo', 'paste', 'ime', 'structure', 'image']);
// Attributes for an op: what the document model keeps (never the image id)
function writerOpAttrs(raw, dropNulls) {
  const c = WR_DF.cleanAttrs(raw);
  if (!c) return null;
  delete c.image;
  if (dropNulls) for (const k of Object.keys(c)) if (c[k] === null) delete c[k];
  return Object.keys(c).length ? c : null;
}
// What to change in Quill so an insert's attributes match what the server keeps
function writerAttrFix(raw, clean) {
  let fix = null;
  for (const k of Object.keys(raw || {})) {
    if (k === 'image' || raw[k] == null) continue;
    const v = clean ? clean[k] : undefined;
    if (v === undefined) (fix || (fix = {}))[k] = null;
    else if (v !== raw[k]) (fix || (fix = {}))[k] = v;
  }
  return fix;
}

// Quill sometimes writes a change as an insert after the document's final
// line break, or as deleting that break (the table module's edits at the end
// of the essay do). The server's text has no final break, so such a change is
// re-expressed as the same change to the text before it, plus the final
// line's own formats.
function writerServerSafe(delta, old) {
  if (!old) return delta;
  const oldLen = old.length();
  let pos = 0, bad = false;
  for (const o of delta.ops) {
    if (o.retain != null) pos += typeof o.retain === 'number' ? o.retain : 1;
    else if (o.delete != null) { if (pos + o.delete > oldLen - 1) { bad = true; break; } pos += o.delete; }
    else if (pos >= oldLen) { bad = true; break; }
  }
  if (!bad) return delta;
  const neu = old.compose(delta);
  const newLen = neu.length();
  const out = new WR_Delta(old.slice(0, oldLen - 1).diff(neu.slice(0, newLen - 1)).ops.slice());
  let used = 0;
  for (const o of out.ops) used += o.retain != null ? (typeof o.retain === 'number' ? o.retain : 1) : o.delete != null ? o.delete : 0;
  const before = (old.slice(oldLen - 1).ops[0] || {}).attributes || {};
  const after = (neu.slice(newLen - 1).ops[0] || {}).attributes || {};
  const fa = {};
  for (const k of Object.keys(before)) if (!(k in after)) fa[k] = null;
  for (const k of Object.keys(after)) if (before[k] !== after[k]) fa[k] = after[k];
  if (Object.keys(fa).length) out.retain(oldLen - 1 - used).retain(1, fa);
  return out;
}

// Quill delta -> Visor ops. `si` walks the server's text, `qi` Quill's (they
// differ only by characters taken back out: placeholders in pasted text and
// pictures that aren't this essay's, removed from Quill right after).
function writerCapture(change, old) {
  // Labelled as the server will get it (cells Quill adds past the final line
  // break are re-expressed inside the text first)
  const delta = writerServerSafe(change, old);
  const from = writerSourceFor(delta);
  const t = Date.now();
  const ops = [], fmts = [], removals = [], fixes = [];
  let si = 0, qi = 0;
  const coalesce = from.src === 'paste' || from.src === 'drop';
  const fSrc = WR_FORMAT_SRCS.has(from.src) ? from.src : 'type';
  const dSrc = WR_DELETE_SRCS.has(from.src) ? from.src : 'type';
  let pasteOp = null;
  for (const o of delta.ops) {
    if (o.retain != null) {
      const n = typeof o.retain === 'number' ? o.retain : 1;   // an embed retain is one character
      if (o.attributes) {
        const attrs = writerOpAttrs(o.attributes, false);
        if (attrs) ops.push({ k: 'f', at: si, len: n, attrs, t, src: fSrc, it: from.it });
      }
      si += n; qi += n;
    } else if (typeof o.insert === 'string') {
      let s = o.insert;
      if (s.indexOf(WR_EMBED) > -1) {
        for (let j = 0; j < s.length; j++) if (s[j] === WR_EMBED) removals.push(qi + j);
        s = s.split(WR_EMBED).join('');
      }
      if (s) {
        const attrs = o.attributes ? writerOpAttrs(o.attributes, true) : null;
        const fix = o.attributes ? writerAttrFix(o.attributes, attrs) : null;
        if (fix && s.length === o.insert.length) fixes.push([qi, s.length, fix]);
        if (coalesce) {
          // one paste, one insert op; formatting inside it becomes format ops
          if (pasteOp && pasteOp.at + pasteOp.s.length === si) pasteOp.s += s;
          else { pasteOp = { k: 'i', at: si, s, t, src: from.src, it: from.it, paste: from.paste || { hash: null, len: s.length, internal: false } }; ops.push(pasteOp); }
          if (attrs) fmts.push({ k: 'f', at: si, len: s.length, attrs, t, src: from.src, it: from.it });
        } else {
          const op = { k: 'i', at: si, s, t, src: from.src, it: from.it };
          if (attrs) op.attrs = attrs;
          ops.push(op);
        }
      }
      si += s.length; qi += o.insert.length;
    } else if (o.insert != null) {
      const id = o.insert.image != null ? WR_DF.imageIdFromSrc(String(o.insert.image)) : null;
      if (id && WR.imageIds.has(id)) {
        const attrs = Object.assign(writerOpAttrs(o.attributes, true) || {}, { image: id });
        const fix = o.attributes ? writerAttrFix(o.attributes, attrs) : null;
        if (fix) fixes.push([qi, 1, fix]);
        const op = { k: 'i', at: si, s: WR_EMBED, attrs, t, src: from.pending ? from.src : 'image', it: from.it };
        if (op.src === 'paste' || op.src === 'drop') op.paste = { hash: null, len: 1, internal: true };
        ops.push(op);
        pasteOp = null;
        si += 1;
      } else {
        // Not a picture of this essay: it doesn't go in (Quill drops it below)
        removals.push(qi);
        writerPictureToast();
      }
      qi += 1;
    } else if (o.delete != null) {
      ops.push({ k: 'd', at: si, len: o.delete, t, src: dSrc, it: from.it });
    }
  }
  // Inserts longer than the server takes go as consecutive pieces
  const out = [];
  for (const op of ops) {
    if (op.k === 'i' && op.s.length > WR_INSERT_MAX) {
      for (let j = 0; j < op.s.length; j += WR_INSERT_MAX) out.push(Object.assign({}, op, { at: op.at + j, s: op.s.slice(j, j + WR_INSERT_MAX) }));
    } else out.push(op);
  }
  // One paste can become several inserts (pieces of a long one, or text and a
  // picture pasted together): the second and later say so (part: 1, 2…), so
  // the server can count it as one paste
  if (coalesce) { let n = 0; for (const op of out) if (op.paste) { if (n) op.part = n; n++; } }
  // Format ops for a coalesced paste go after the inserts they format
  if (out.length || fmts.length) {
    WR.queue.push(...out, ...fmts);
    writerPersistQueue();
    writerSetSaved('unsaved');
  }
  if (removals.length || fixes.length) queueMicrotask(() => writerTakeBack(removals, fixes));
}

// Make Quill match what was recorded: attribute values the model doesn't keep,
// then characters that weren't recorded (last first, so positions hold). Not a
// user edit, so it isn't recorded again; the undo history adjusts to it.
function writerTakeBack(removals, fixes) {
  const q = WR.quill; if (!q) return;
  for (const [at, len, attrs] of fixes) q.formatText(at, len, attrs, 'api');
  removals.sort((a, b) => b - a);
  for (const at of removals) if (at < q.getLength() - 1) q.deleteText(at, 1, 'api');
}

function writerHistory(kind) {
  if (lockReason()) return false;
  WR.quill.getModule('history')[kind]();
  return true;
}

/* ====================== sending ops ====================== */
let flushing = null, retryDelay = 2000, retryTimer = null;
async function writerFlush({ unload = false } = {}) {
  if (!WR.queue?.length || !WR.token || !WR.doc) return;
  if (unload) return writerFlushBeacon();
  if (flushing) return flushing;
  flushing = (async () => {
    writerSetSaved('saving');
    try {
      while (WR.queue.length) {
        // wait for paste hashes still being computed
        await Promise.all(WR.hashWaits.splice(0));
        const batch = WR.queue.slice(0, 500);
        // The text this batch leads to. When it's every edit made in this
        // editor, that's simply the editor's text: if the ops say otherwise
        // the server refuses them and the editor reloads its text.
        let text;
        if (batch.length === WR.queue.length && !WR.queueDetached && WR.quill) text = writerText();
        else { text = WR.confirmedText; for (const op of batch) text = applyTextOp(text, op); }
        const textHash = await sha256Hex(text);
        const r = await wapi(`/api/write/${WR.doc.id}/ops`, { method: 'POST', body: { baseSeq: WR.seq, ops: batch, textHash, surfaceId: WR.surfaceId }, timeoutMs: 30000 });
        WR.queue.splice(0, batch.length);
        WR.seq = r.seq; WR.confirmedText = text; WR.rebased = false;
        if (!WR.queue.length) WR.queueDetached = false;
        writerPersistQueue(true);
      }
      retryDelay = 2000;
      if (WR.offline) wsBackOnline();
      writerSetSaved('saved');
    } catch (e) {
      if (e.network) { wsGoOffline(); writerSetSaved('offline'); writerRetrySoon(); }
      else if (e.status === 409 && e.data?.ended) { writerSetSaved(WR.queue.length ? 'unsaved' : 'saved'); await wsSessionEnded(e.data); }
      else if (e.status === 409 && e.data && 'text' in e.data) writerConflict(e.data, e.data.notLeaseHolder);
      else if (e.status === 423) { writerSetSaved('unsaved'); writerRetrySoon(); }
      else if (e.status === 401) wsLost(e.message);
      // The server won't take these edits however often they're sent: start again from its copy
      else if (e.status === 400 || e.status === 413) await writerRejected(e);
      else { writerSetSaved('unsaved'); toast(e.message, 'err'); writerRetrySoon(); }
    } finally { flushing = null; }
  })();
  return flushing;
}
function writerRetrySoon() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => writerFlush(), retryDelay);
  retryDelay = Math.min(retryDelay * 2, 30000);
}
// Leaving the page: send what's left without waiting for an answer
function writerFlushBeacon() {
  if (!WR.queue.length || !WR.token) return;
  writerPersistQueue(true);
  const ops = WR.queue.slice(0, 500);
  const body = JSON.stringify({ baseSeq: WR.seq, ops, surfaceId: WR.surfaceId, _session: WR.token });
  // The copy kept on this device remembers the text this send leads to, so a
  // reload can tell "it arrived" from "it was lost"
  if (ops.length === WR.queue.length) {
    try {
      const stored = JSON.parse(localStorage.getItem(queueKey()) || 'null');
      let text = WR.confirmedText;
      for (const op of ops) text = applyTextOp(text, op);
      if (stored) localStorage.setItem(queueKey(), JSON.stringify({ ...stored, sentText: text }));
    } catch {}
  }
  try {
    fetch(`/api/write/${WR.doc.id}/ops`, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json', 'X-Visor-Session': WR.token }, body }).catch(() => {});
  } catch {
    try { navigator.sendBeacon(`/api/write/${WR.doc.id}/ops`, new Blob([body], { type: 'application/json' })); } catch {}
  }
}

// How many of these queued ops the server already has, starting from baseText
// at baseSeq, or -1 if its text isn't what they lead to. The server numbers every
// op, so its seq says how many to look for.
function opsLanded(ops, baseText, baseSeq, server) {
  const want = server.seq - baseSeq;
  if (want === 0) return server.text === baseText ? 0 : -1;
  let text = baseText, found = -1;
  for (let i = 0; i < ops.length; i++) {
    text = applyTextOp(text, ops[i]);
    if (text === server.text && i + 1 === want) return want;
    if (text === server.text) found = i + 1; // one the server dropped as empty can throw the count off
  }
  return found;
}

// The server isn't where this page thought. Usually nothing is wrong: a reply got
// lost, so a batch arrived though this page never heard. Those ops come off the
// queue and the rest go on. Student writing is never dropped to resolve this.
function writerConflict(data, notLeaseHolder) {
  const landed = opsLanded(WR.queue, WR.confirmedText, WR.seq, data);
  if (landed > 0) {
    WR.queue.splice(0, landed);
    WR.seq = data.seq; WR.confirmedText = data.text;
    if (!WR.queue.length) WR.queueDetached = false;
    writerPersistQueue(true);
  }
  if (notLeaseHolder) {
    // Another window took over, and it has the server's copy
    if (WR.queue.length) toast('The last few words typed here didn’t reach the window you switched to.', 'err');
    WR.queue = [];
    writerPersistQueue(true);
    writerLoadServerText(data, { force: true });
    WR.lease = data.lease || WR.lease;
    writerSetSaved('saved');
    return writerRefresh();
  }
  if (landed >= 0) {
    writerSetSaved(WR.queue.length ? 'saving' : 'saved');
    if (WR.queue.length) writerRetrySoon();
    return;
  }
  if (writerRebase(data)) return;
  const text = WR.queueDetached ? '' : writerText();
  WR.queue = []; WR.queueDetached = false;
  writerPersistQueue(true);
  writerLoadServerText(data, { force: true });
  wsNoteEvent('resync');
  writerSetSaved('saved');
  writerRefresh();
  if (text && text !== data.text) writerRescue(text);
}

// The essay on screen and the server's differ in a way the queue can't explain.
// What's on screen is what the student wrote, so it goes back up as one edit on
// top of the server's copy. Once: if the server refuses that too, writerRescue.
function writerRebase(data) {
  if (WR.rebased || WR.queueDetached) return false;
  const want = writerText(), have = data.text;
  let a = 0, b = 0;
  while (a < want.length && a < have.length && want[a] === have[a]) a++;
  while (b < want.length - a && b < have.length - a && want[want.length - 1 - b] === have[have.length - 1 - b]) b++;
  const gone = have.length - a - b, added = want.slice(a, want.length - b);
  // A picture can't be rebuilt from its placeholder
  if (added.includes(WR_EMBED) || have.slice(a, a + gone).includes(WR_EMBED)) return false;
  const t = Date.now();
  WR.queue = [...(gone ? [{ k: 'd', at: a, len: gone, t, src: 'other' }] : []), ...(added ? [{ k: 'i', at: a, s: added, t, src: 'other' }] : [])];
  WR.seq = data.seq; WR.confirmedText = data.text; WR.rebased = true;
  writerPersistQueue(true);
  wsNoteEvent('resync');
  if (WR.queue.length) writerRetrySoon(); else writerSetSaved('saved');
  return true;
}

// Writing the server won't take, shown so the student can copy it somewhere safe
function writerRescue(text) {
  openModal({ title: 'Copy your latest writing', sub: 'Visor couldn’t save it, so your essay went back to its last save. Copy this and paste what’s missing back in.', closable: false,
    body: `<textarea id="wrRescue" class="input" readonly style="width:100%;min-height:220px;" aria-label="Your unsaved writing">${esc(text)}</textarea>`,
    footer: `<button class="btn btn-ghost" onclick="closeModal()">Done</button><button class="btn btn-primary" onclick="copyText($('wrRescue').value,'Copied')">Copy</button>` });
}

// A 400 or 413 from the ops route: those edits can never be saved. Drop them
// and show the last saved essay (never resend the same batch for ever).
async function writerRejected(e) {
  console.warn('Visor: the server refused some edits', e.status, e.message);
  const text = WR.queueDetached || !WR.quill ? '' : writerText();
  WR.queue = []; WR.queueDetached = false;
  writerPersistQueue(true);
  wsNoteEvent('resync');
  toast('Some changes couldn’t be saved, so the essay was reloaded from its last save.', 'err');
  try {
    const fresh = await writerFetch();
    if (WR.quill && fresh?.doc) { WR.doc = { ...WR.doc, ...fresh.doc }; writerLoadServerText(fresh.doc, { force: true }); if (text && text !== fresh.doc.text) writerRescue(text); }
  } catch {
    // Can't reach the server now: the next save starts from the text it last confirmed,
    // and a mismatch there reloads the essay
  }
  writerSetSaved('saved');
  writerRefresh();
}

/* ====================== loading the server's document ====================== */
// Show the server's text and formatting without recording it as an edit
function writerLoadServerText(doc, { force = false } = {}) {
  if (!WR.quill || !doc || doc.text == null) return;
  if (!force && WR.queue.length) return;
  if (!force && doc.seq === WR.seq && doc.text === WR.confirmedText && WR.loads) return;
  writerNoteImageIds(doc);
  const d = new WR_Delta(WR_DF.docToDelta(doc.text, doc.formats || [], { imageSrc: writerImageSrc }));
  const sel = WR.quill.hasFocus() ? WR.quill.getSelection() : null;
  WR.quill.setContents(d, 'silent');
  if (sel) WR.quill.setSelection(Math.min(sel.index, WR.quill.getLength() - 1), 0, 'silent');
  WR.confirmedText = doc.text; WR.seq = doc.seq;
  WR.textCache = null; WR.loads = (WR.loads || 0) + 1;
  if (force) { WR.queue = []; WR.queueDetached = false; WR.quill.getModule('history').clear(); }
  writerAfterChange();
  writerUpdateCounts(true);
}

// Pictures this essay may show: every one its text names (kept for the visit,
// so undo can bring a deleted one back)
function writerNoteImageIds(doc) {
  const text = doc.text || '';
  if (text.indexOf(WR_EMBED) < 0) return;
  for (const s of WR_DF.segments(text.length, doc.formats || [])) if (s.attrs && s.attrs.image) WR.imageIds.add(s.attrs.image);
}

// A picture's address, with the image token (an <img> can't send headers)
function writerImageSrc(id) {
  if (!id) return WR_DF.TRANSPARENT_GIF;
  return `/api/images/${id}${WR.imageToken ? `?t=${encodeURIComponent(WR.imageToken)}` : ''}`;
}

// A picture failed to load: fetch a fresh token (once in a while) and point
// the pictures at it, without touching the text
function writerOnImageError(e) {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !WR_DF.imageIdFromSrc(img.getAttribute('src') || '')) return;
  if (WR.imgRefreshTimer || Date.now() - (WR.imgRefreshAt || 0) < 60000) return;
  WR.imgRefreshTimer = setTimeout(writerRefreshImages, 400);
}
async function writerRefreshImages() {
  WR.imgRefreshTimer = null; WR.imgRefreshAt = Date.now();
  try { await writerFetch(); } catch { return; }
  const q = WR.quill; if (!q) return;
  q.update('user');   // any edit in progress is taken in first, as usual
  for (const img of q.root.querySelectorAll('img')) {
    const id = WR_DF.imageIdFromSrc(img.getAttribute('src') || '');
    if (id) img.setAttribute('src', writerImageSrc(id));
  }
  q.update('silent'); // Quill takes in the new addresses without recording an edit
}

/* ---- ops kept on this device (offline, or a reload before they were sent) ---- */
const queueKey = () => `visor-wq:${WR.doc?.id}`;
// At most every 750 ms while typing; straight away when asked (a batch was
// saved, the page loses focus or is hidden, or is about to close)
function writerPersistQueue(now) {
  if (now === true) { clearTimeout(WR.persistTimer); WR.persistTimer = null; writerPersistNow(); return; }
  if (WR.persistTimer) return;
  WR.persistTimer = setTimeout(() => { WR.persistTimer = null; writerPersistNow(); }, Math.max(0, 750 - (Date.now() - (WR.persistAt || 0))));
}
// The copy is removed only by the page that stored it (WR.storedOwn): another
// tab of the same essay, or this page while it offers to send writing left
// from before a reload, never wipes it by having nothing queued itself.
function writerPersistNow() {
  WR.persistAt = Date.now();
  if (!WR.doc) return;
  try {
    if (!WR.queue.length) { if (WR.storedOwn) localStorage.removeItem(queueKey()); WR.storedOwn = false; }
    else { localStorage.setItem(queueKey(), JSON.stringify({ sessionId: WR.session?.id, baseSeq: WR.seq, baseText: WR.confirmedText, ops: WR.queue, savedAt: Date.now() })); WR.storedOwn = true; }
  } catch {}
}
function writerClearStoredQueue() { WR.storedOwn = false; try { localStorage.removeItem(queueKey()); } catch {} }
function writerStoredCopy() { try { return JSON.parse(localStorage.getItem(queueKey()) || 'null'); } catch { return null; } }
// After a reload: offer to send writing that never reached the server. Part of
// it may have arrived as the page closed, and then only the rest is left.
function writerCheckStoredQueue() {
  let stored = writerStoredCopy();
  if (!stored?.ops?.length || WR.queue.length) return;
  // Sent as the page closed, and the server has it
  if (stored.sentText != null && stored.sentText === WR.doc.text) return writerClearStoredQueue();
  if (stored.baseSeq !== WR.doc.seq && stored.baseText != null) {
    const landed = opsLanded(stored.ops, stored.baseText, stored.baseSeq, WR.doc);
    if (landed === stored.ops.length) return writerClearStoredQueue();
    if (landed > 0) {
      stored = { ...stored, ops: stored.ops.slice(landed), baseSeq: WR.doc.seq, baseText: WR.doc.text };
      try { localStorage.setItem(queueKey(), JSON.stringify(stored)); } catch {}
    }
  }
  if (stored.baseSeq !== WR.doc.seq) {
    // The essay moved on without these. They can't be placed, but they're the student's.
    const text = stored.ops.filter(o => o.k === 'i').map(o => o.s).join('').replaceAll(WR_EMBED, '');
    writerClearStoredQueue();
    if (text.trim()) writerRescue(text);
    return;
  }
  if (!wsActive() || !isLeaseHolder()) {
    writerBanner(`You have writing saved on this device that hasn’t been sent yet. Start a session to send it.`, 'info');
    return;
  }
  openModal({ title: 'Send unsent writing?', closable: false, sub: `Saved on this device ${timeAgo(new Date(stored.savedAt).toISOString())}.`, body: `<p style="margin:0;">${stored.ops.length} edit${stored.ops.length === 1 ? '' : 's'} didn’t reach Visor before the page closed. Send ${stored.ops.length === 1 ? 'it' : 'them'} now?</p>`,
    footer: `<button class="btn btn-ghost" onclick="writerClearStoredQueue();closeModal();toast('Discarded')">Discard</button><button class="btn btn-primary" onclick="writerSendStored()">Send</button>` });
}
async function writerSendStored() {
  closeModal();
  const stored = writerStoredCopy();
  if (!stored || stored.baseSeq !== WR.seq) { writerClearStoredQueue(); return toast('The document changed, so that writing couldn’t be sent.', 'err'); }
  // Send it like any other edits (they aren't in the editor, which shows the
  // server's text), then show the server's text
  // This page owns that copy now: it goes once the server has the ops
  WR.queue = stored.ops; WR.queueDetached = true; WR.storedOwn = true;
  await writerFlush();
  const fresh = await writerFetch().catch(() => null);
  if (fresh) writerLoadServerText(fresh.doc, { force: true });
  toast('Sent');
}

/* ====================== text, counts and the toolbar's state ====================== */
// The essay's text as stored: a picture is one EMBED character (Quill's own
// getText drops pictures, which would shift every index after one)
function writerText() {
  if (!WR.quill) return WR.doc?.text || '';
  if (WR.textCache == null) WR.textCache = WR_DF.deltaText(WR.quill.getContents().ops).slice(0, -1);
  return WR.textCache;
}
function writerWordCount() { return WR_DF.wordCount(writerText()); }
// The word count is redrawn 300 ms after typing stops (now = true: straight away)
function writerUpdateCounts(now) {
  clearTimeout(WR.wcTimer); WR.wcTimer = null;
  if (now !== true) { WR.wcTimer = setTimeout(() => writerUpdateCounts(true), 300); return; }
  WR.wordsTotal = writerWordCount();
  WR.wordsLabel = writerWordsLabel();
  const el = $('wrWords'); if (el) el.textContent = WR.wordsLabel;
  const n = (WR.doc?.sources || []).length;
  const sb = $('wrSourcesBtn'); if (sb) sb.textContent = `Sources (${n})`;
  const hc = $('wrSrcCount'); if (hc) hc.textContent = n ? String(n) : '';
  writerScheduleUi();
}
function writerWordStats() {
  const count = s => ({ words: WR_DF.wordCount(s), chars: s.replace(/[\n\uFFFC]/g, '').length, charsNoSpaces: s.replace(/[\s\uFFFC]/g, '').length });
  const out = Object.assign({ pages: WR.pages || 1 }, count(writerText()));
  const r = WR.lastRange;
  if (WR.quill && r && r.length > 0) out.selection = count(WR_DF.deltaText(WR.quill.getContents(r.index, r.length).ops));
  return out;
}

// Words in the selection (null without one), worked out again only when the
// selection or the text changed
function writerSelectionWords() {
  const q = WR.quill, r = WR.lastRange;
  if (!q || !r || !(r.length > 0)) return null;
  const key = `${r.index}:${r.length}:${WR.changeN || 0}`;
  if (WR.selWords && WR.selWords.key === key) return WR.selWords.n;
  let n = null;
  try { n = WR_DF.wordCount(WR_DF.deltaText(q.getContents(r.index, r.length).ops)); } catch {}
  WR.selWords = { key, n };
  return n;
}
// "1,219 words", or "4 of 1,219 words" with a selection
function writerWordsLabel(sel) {
  const total = WR.wordsTotal != null ? WR.wordsTotal : writerWordCount();
  const n = sel === undefined ? writerSelectionWords() : sel;
  const t = Number(total).toLocaleString();
  return n == null ? `${t} ${total === 1 ? 'word' : 'words'}` : `${Number(n).toLocaleString()} of ${t} ${total === 1 ? 'word' : 'words'}`;
}

// After any change to the text: counts, pages, outline and find catch up (later)
function writerAfterChange() {
  writerUpdateCounts();
  writerLayoutSoon();
  if (WR.find) {
    WR.findDirty = true;
    clearTimeout(WR.findTimer);
    WR.findTimer = setTimeout(() => { WR.findTimer = null; if (WR.find && WR.findDirty) { writerFindRun(null, false); writerScheduleUi(); } }, 200);
  }
  writerScheduleUi();
}

// The caret or selection the student last had (kept while the menus have focus)
function writerRange() {
  const q = WR.quill;
  const max = Math.max(0, (q ? q.getLength() : 1) - 1);
  const r = WR.lastRange || { index: max, length: 0 };
  const index = Math.min(Math.max(0, r.index), max);
  return { index, length: Math.max(0, Math.min(r.length || 0, max - index)) };
}
// Put the focus back in the essay, with the selection it had
function writerFocus() {
  const q = WR.quill;
  if (!q || !q.isEnabled() || q.hasFocus()) return;
  const r = writerRange();
  q.setSelection(r.index, r.length, 'silent');
}
// The selection to act on (refocusing the editor first)
function writerSel() {
  writerFocus();
  return (WR.quill.hasFocus() && WR.quill.getSelection()) || writerRange();
}
const writerCanEdit = () => !!WR.quill && lockReason() === null && WR.quill.isEnabled();
// Run a Quill call as the student's edit, labelled
function writerAsUser(src, fn, it = 'toolbar') {
  WR.pendingSrc = { src, it, once: true };
  try { return fn(); } finally { WR.pendingSrc = null; }
}
const writerInlineOnly = f => { const o = {}; for (const k in f || {}) if (WR_DF.isInlineKey(k) && !Array.isArray(f[k]) && f[k] != null) o[k] = f[k]; return o; };
const writerBlockOnly = f => { const o = {}; for (const k in f || {}) if (WR_DF.isBlockKey(k) && k !== 'table' && !Array.isArray(f[k]) && f[k] != null) o[k] = f[k]; return o; };

// DocsUI's state, worked out at most once per frame
function writerScheduleUi() {
  if (WR.uiFrame || !WR.quill) return;
  WR.uiFrame = requestAnimationFrame(() => { WR.uiFrame = 0; writerPaintSelection(); writerPushUi(); });
}
// While the focus is outside the essay (the size box, the link box, the find
// field), the selection it acts on stays visible, painted with the CSS Custom
// Highlight API (a blurred editor hides the browser's own selection)
function writerPaintSelection() {
  const q = WR.quill;
  if (!q || !window.CSS || !CSS.highlights || typeof Highlight !== 'function') return;
  const r = WR.lastRange;
  const show = !!r && r.length > 0 && !q.hasFocus();
  const sig = show ? `${r.index}:${r.length}:${WR.changeN || 0}` : '';
  if (sig === WR.selSig) return;
  WR.selSig = sig;
  try {
    const range = show ? writerDomRange(r.index, r.length) : null;
    if (!range) { CSS.highlights.delete('dx-sel'); return; }
    const h = new Highlight(range);
    h.priority = -1;   // under the find highlights
    CSS.highlights.set('dx-sel', h);
    // DocsUI paints its own copy only when the writer doesn't: never both
    CSS.highlights.delete('dui-sel');
  } catch {}
}
function writerPushUi() {
  if (!WR.quill || !WR.docsUI || typeof window.DocsUI?.update !== 'function') return;
  const q = WR.quill;
  const r = writerRange();
  let formats = {};
  try { formats = q.getFormat(r.index, r.length); } catch {}
  const hist = q.getModule('history');
  const canEdit = writerCanEdit();
  const sources = WR.doc?.sources || [];
  const state = {
    canEdit, canUndo: canEdit && !!hist?.stack.undo.length, canRedo: canEdit && !!hist?.stack.redo.length,
    formats, inTable: formats.table != null, onImage: !!writerImageAt(), hasSelection: r.length > 0,
    zoom: WR.zoomSetting, pageBreaks: WR.pageBreaks, spellcheck: WR.spellcheck, outlineOpen: WR.outlineOpen,
    sourcesCount: sources.length, citationAllowed: writerWorksMode() !== 'off' && sources.length > 0,
    // also: the document style, the outline's version, and the find counts after edits
    docStyle: WR.docStyle, outlineRev: WR.outlineRev || 0, pages: WR.pages || 1
  };
  // The word count: the whole essay and the selection ("4 of 1,219 words")
  if (WR.wordsTotal == null) WR.wordsTotal = writerWordCount();
  const sel = r.length > 0 ? writerSelectionWords() : null;
  state.words = { total: WR.wordsTotal, selection: sel };
  state.wordsLabel = writerWordsLabel(sel);
  // The find counts, kept up to date as the essay changes ({count, current}, current 1-based)
  state.find = WR.find ? writerFindResult() : null;
  try { DocsUI.update(state); } catch (e) { console.error(e); }
}

/* ====================== commands (DocsUI's exec) ====================== */
// Returns true when it did something, false for an unknown command (or one
// that can't run now, e.g. editing while writing is locked).
function writerExec(cmd, value) {
  const q = WR.quill;
  if (!q || typeof cmd !== 'string') return false;
  if (WR_EDIT_CMDS.has(cmd) && !writerCanEdit()) return false;
  switch (cmd) {
    case 'undo': case 'redo': return writerHistory(cmd);
    case 'print': writerPrint(); return true;
    case 'download': return writerDownload(value);
    case 'zoom': return writerSetZoom(value);
    case 'style': return writerSetStyle(value);
    case 'font': { const v = value == null ? false : WR_DF.cleanValue('font', value); return v === undefined ? false : writerFormat('font', v || false); }
    case 'size': { const v = value == null ? false : WR_DF.cleanValue('size', value); return v === undefined ? false : writerFormat('size', v || false); }
    case 'sizeStep': return writerSizeStep(value);
    case 'bold': case 'italic': case 'underline': case 'strike': return writerFormat(cmd, !writerFormats()[cmd]);
    case 'script': {
      const v = value === 'sub' || value === 'super' ? value : null;
      return writerFormat('script', v && writerFormats().script !== v ? v : false);
    }
    case 'color': case 'background': {
      if (!value) return writerFormat(cmd, false);
      const v = WR_DF.cleanValue(cmd, value);
      return v ? writerFormat(cmd, v) : false;
    }
    case 'link': return value == null ? writerRemoveLink() : writerSetLink(value, false);
    case 'editLink': return writerSetLink(value, true);
    case 'removeLink': return writerRemoveLink();
    case 'align': return writerFormatLine({ align: ['center', 'right', 'justify'].includes(value) ? value : false });
    case 'lineheight': { const v = WR_DF.cleanValue('lineheight', value); return v ? writerFormatLine({ lineheight: v }) : false; }
    case 'list': return writerList(value);
    case 'indent': return writerIndent(value);
    case 'clear': return writerClearFormatting();
    case 'insertTable': return writerInsertTable(value);
    case 'tableOp': return writerTableOp(value);
    case 'image': return writerPickImage();
    case 'imageSize': return writerImageSize(value);
    case 'imageAlt': return writerImageAlt(value);
    case 'specialChar': return writerInsertChars(value);
    case 'pageBreaks':
      WR.pageBreaks = !!value; writerSetPref('visor-pagebreaks', WR.pageBreaks ? '1' : '0');
      WR.breaksSig = ''; writerLayoutSoon(0); writerScheduleUi(); return true;
    case 'outline': writerShowOutline(!!value); return true;
    case 'spellcheck':
      WR.spellcheck = !!value; writerSetPref('visor-spell', WR.spellcheck ? '1' : '0');
      q.root.setAttribute('spellcheck', WR.spellcheck ? 'true' : 'false'); writerScheduleUi(); return true;
    case 'selectAll': writerFocus(); q.setSelection(0, Math.max(0, q.getLength() - 1), 'user'); return true;
    case 'copy': case 'cut': {
      writerFocus();
      WR.pendingSrc = cmd === 'cut' ? { src: 'type', it: 'cut', once: true } : null;
      try { return document.execCommand(cmd); } catch { return false; } finally { WR.pendingSrc = null; }
    }
    case 'paste': toast(`Use ${WR_IS_MAC ? '⌘V' : 'Ctrl+V'} to paste`); return true;
    case 'sources': if (writerWorksMode() === 'off') return false; writerToggleSources(); return true;
    case 'instructions': writerToggleInstructions(true); return true;
    case 'wordCount':
      if (WR.docsUI && typeof window.DocsUI?.openWordCount === 'function') { try { DocsUI.openWordCount(); return true; } catch (e) { console.error(e); } }
      writerWordCountDialog(); return true;
    case 'focus': writerFocus(); return true;
    case 'gotoIndex': return writerGoto(value);
  }
  return false;
}

const writerFormats = () => { const r = writerRange(); try { return WR.quill.getFormat(r.index, r.length); } catch { return {}; } };
// An inline or line format at the selection (at a caret: for what's typed next)
function writerFormat(name, value, src = 'type') {
  writerSel();
  writerAsUser(src, () => WR.quill.format(name, value, 'user'));
  writerScheduleUi();
  return true;
}
function writerFormatLine(formats, src = 'type') {
  const r = writerSel();
  writerAsUser(src, () => WR.quill.formatLine(r.index, r.length, formats, 'user'));
  writerScheduleUi();
  return true;
}

const WR_STYLES = { normal: {}, title: { title: true }, subtitle: { subtitle: true }, h1: { header: 1 }, h2: { header: 2 }, h3: { header: 3 } };
function writerSetStyle(v) {
  if (!Object.prototype.hasOwnProperty.call(WR_STYLES, v)) return false;
  const r = writerSel();
  if (WR.quill.getFormat(r.index, r.length).table != null) { toast('Paragraph styles don’t work inside a table.', 'err'); return false; }
  return writerFormatLine(Object.assign({ header: false, title: false, subtitle: false }, WR_STYLES[v]));
}
function writerSizeStep(dir) {
  const sizes = WR_DF.SIZES;
  const f = writerFormats();
  const cur = (Array.isArray(f.size) ? f.size[0] : f.size) || WR_DF.DOC_STYLES[WR.docStyle].size;
  let i = sizes.indexOf(cur);
  if (i < 0) i = sizes.indexOf(WR_DF.DOC_STYLES[WR.docStyle].size);
  const next = sizes[Math.max(0, Math.min(sizes.length - 1, i + (Number(dir) < 0 ? -1 : 1)))];
  return writerFormat('size', next);
}
function writerList(v) {
  const want = v === 'checked' || v === 'unchecked' ? 'check' : v;
  if (!['bullet', 'ordered', 'check'].includes(want)) return false;
  const r = writerSel();
  const f = WR.quill.getFormat(r.index, r.length);
  if (f.table != null) { toast('Lists don’t work inside a table.', 'err'); return false; }
  const cur = f.list === 'checked' || f.list === 'unchecked' ? 'check' : f.list;
  return writerFormatLine({ list: cur === want ? false : want === 'check' ? 'unchecked' : want }, 'structure');
}
function writerIndent(v) {
  const dir = String(v) === '-1' ? '-1' : '+1';
  return writerFormat('indent', dir, 'structure');
}
// Clear formatting: text formats (not links) and paragraph styles, alignment,
// spacing and indent (lists and tables stay). Quill's removeFormat would drop
// pictures, so this is done format by format.
function writerClearFormatting() {
  const q = WR.quill;
  const r = writerSel();
  const INLINE = ['bold', 'italic', 'underline', 'strike', 'script', 'font', 'size', 'color', 'background'];
  const BLOCK = ['header', 'title', 'subtitle', 'align', 'lineheight', 'indent'];
  WR.pendingSrc = { src: 'structure', it: 'toolbar', once: true };
  try {
    if (r.length) {
      const set = {};
      for (const op of q.getContents(r.index, r.length).ops) for (const k of Object.keys(op.attributes || {})) if (INLINE.includes(k)) set[k] = null;
      if (Object.keys(set).length) q.formatText(r.index, r.length, set, 'user');
    } else {
      const f = q.getFormat(r.index, 0);
      for (const k of INLINE) if (f[k] != null) q.format(k, false, 'user');
    }
    const blk = {};
    for (const line of q.getLines(r.index, r.length)) { const f = line.formats ? line.formats() : {}; for (const k of BLOCK) if (f[k] != null) blk[k] = false; }
    if (Object.keys(blk).length) q.formatLine(r.index, r.length, blk, 'user');
  } finally { WR.pendingSrc = null; }
  writerScheduleUi();
  return true;
}
// Special characters (and any short text a menu inserts), with the formats around the caret
function writerInsertChars(value) {
  const ch = String(value == null ? '' : value).replace(/[\r\uFFFC]/g, '');
  if (!ch) return false;
  const q = WR.quill;
  const r = writerSel();
  const fmt = writerInlineOnly(q.getFormat(r.index, r.length ? 1 : 0));
  writerAsUser('type', () => q.updateContents(new WR_Delta().retain(r.index).delete(r.length).insert(ch, fmt), 'user'));
  q.setSelection(r.index + ch.length, 0, 'silent');
  return true;
}
function writerGoto(i) {
  const q = WR.quill;
  const idx = Math.max(0, Math.min(Number(i) || 0, q.getLength() - 1));
  WR.lastRange = { index: idx, length: 0 };
  if (q.isEnabled()) q.setSelection(idx, 0, 'silent');
  const b = q.getBounds(idx);
  if (b) { const c = q.container.getBoundingClientRect(); window.scrollBy({ top: c.top + b.top - writerStickyHeight() - 24 }); }
  writerScheduleUi();
  return true;
}
const writerStickyHeight = () => { const tb = $('dxToolbar'); return tb ? Math.max(0, tb.getBoundingClientRect().bottom) : 0; };

/* ---- links ---- */
// The link under the caret (or the selection): its text, address and extent
function writerGetLink() {
  const q = WR.quill; if (!q) return null;
  const r = writerRange();
  let url = null;
  try { url = q.getFormat(r.index, r.length).link; } catch {}
  if (typeof url !== 'string') return null;
  const probe = r.length ? r.index : Math.max(0, r.index - 1);   // a caret belongs to the character before it
  // A link never crosses a line break, so its line is enough
  const [line] = q.getLine(probe);
  if (!line) return null;
  const start = q.getIndex(line);
  const found = (from, end) => {
    if (probe < from || probe >= end) return null;
    const text = WR_DF.deltaText(q.getContents(from, end - from).ops);
    // hasImage: the link includes a picture, so its text can't be edited
    return { text, url, index: from, length: end - from, hasImage: text.indexOf(WR_EMBED) > -1 };
  };
  // The runs of characters carrying this link; the one that holds probe
  let pos = start, from = -1;
  for (const op of q.getContents(start, line.length()).ops) {
    const n = typeof op.insert === 'string' ? op.insert.length : 1;
    if (op.attributes && op.attributes.link === url) { if (from < 0) from = pos; }
    else if (from >= 0) { if (probe < pos) return found(from, pos); from = -1; }
    pos += n;
  }
  return from >= 0 ? found(from, pos) : null;
}
function writerSetLink(v, edit) {
  if (!v || typeof v !== 'object') return false;
  const url = WR_DF.cleanValue('link', String(v.url || '').trim());
  if (!url) { toast('That link doesn’t look right. Try a web address like https://example.com.', 'err'); return false; }
  const q = WR.quill;
  writerSel();
  const cur = edit ? writerGetLink() : null;
  const r = cur ? { index: cur.index, length: cur.length } : writerRange();
  const now = WR_DF.deltaText(q.getContents(r.index, r.length).ops);
  const raw = String(v.text == null ? '' : v.text);
  const norm = t => t.replace(/[\r\n\uFFFC]+/g, ' ');
  const text = norm(raw);
  // No text, the same text, or a range with a picture or a line break in it
  // (never deleted and typed again as plain text): link the range as it is
  if (r.length && (!raw || raw === now || text === norm(now) || /[\n\uFFFC]/.test(now))) {
    writerAsUser('type', () => q.formatText(r.index, r.length, { link: url }, 'user'));
  } else {
    const t = text || url;
    const fmt = Object.assign(writerInlineOnly(q.getFormat(r.index, r.length ? 1 : 0)), { link: url });
    writerAsUser('type', () => q.updateContents(new WR_Delta().retain(r.index).delete(r.length).insert(t, fmt), 'user'));
    q.setSelection(r.index + t.length, 0, 'silent');
  }
  writerScheduleUi();
  return true;
}
function writerRemoveLink() {
  const q = WR.quill;
  writerSel();
  const r = writerRange();
  const cur = writerGetLink();
  const span = r.length ? r : cur ? { index: cur.index, length: cur.length } : null;
  if (!span) return false;
  writerAsUser('type', () => q.formatText(span.index, span.length, { link: false }, 'user'));
  writerScheduleUi();
  return true;
}
// ⌘K: DocsUI's link popover, or a small dialog when the menus aren't there
function writerOpenLink() {
  if (!writerCanEdit()) return;
  const UI = window.DocsUI;
  if (WR.docsUI && typeof UI?.openLink === 'function') { try { UI.openLink(); return; } catch (e) { console.error(e); } }
  const cur = writerGetLink();
  const r = writerRange();
  const sel = cur ? cur.text : WR_DF.deltaText(WR.quill.getContents(r.index, r.length).ops);
  // A link with a picture (or a line break) in it has no text to edit ('' keeps the range as it is)
  const pic = /[\n\uFFFC]/.test(sel);
  const text = pic ? '' : sel;
  openModal({ title: cur ? 'Edit link' : 'Insert link', body: `${pic ? '' : `<div class="field"><label for="dxLinkText">Text</label><input id="dxLinkText" class="input" value="${esc(text)}"></div>`}<div class="field"><label for="dxLinkUrl">Link</label><input id="dxLinkUrl" class="input" placeholder="https://…" value="${esc(cur ? cur.url : '')}"></div>`,
    footer: `${cur ? '<button class="btn btn-ghost" id="dxLinkRemove">Remove link</button>' : ''}<button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-primary" id="dxLinkApply">Apply</button>` });
  const apply = () => { const ok = writerExec(cur ? 'editLink' : 'link', { text: pic ? '' : $('dxLinkText').value, url: $('dxLinkUrl').value }); if (ok) { closeModal(); writerFocus(); } };
  $('dxLinkApply').onclick = apply;
  $('dxLinkUrl').onkeydown = e => { if (e.key === 'Enter') apply(); };
  if ($('dxLinkRemove')) $('dxLinkRemove').onclick = () => { closeModal(); writerExec('removeLink'); writerFocus(); };
  setTimeout(() => $(cur || text || pic ? 'dxLinkUrl' : 'dxLinkText')?.focus(), 0);
}
// Where the selection (or the selected picture) is on screen, for bubbles
function writerSelectionRect() {
  const q = WR.quill; if (!q) return null;
  const im = writerImageAt();
  if (im) {
    const blot = q.scroll.descendants(b => b.statics && b.statics.blotName === 'image', im.index, 1)[0];
    if (blot && blot.domNode) { const b = blot.domNode.getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom }; }
  }
  const r = writerRange();
  const b = q.getBounds(r.index, r.length);
  if (!b) return null;
  const c = q.container.getBoundingClientRect();
  return { left: c.left + b.left, top: c.top + b.top, right: c.left + b.right, bottom: c.top + b.bottom };
}

/* ---- tables ---- */
// A rows × cols table on its own lines at the caret (Quill's own insertTable
// would turn the text before the caret into the first cell)
function writerInsertTable(v) {
  const rows = parseInt(v && v.rows, 10), cols = parseInt(v && v.cols, 10);
  if (!(rows > 0) || !(cols > 0)) return false;
  const q = WR.quill;
  const r = writerSel();
  if (q.getFormat(r.index, 0).table != null) { toast('A table can’t go inside a table.', 'err'); return false; }
  const [, offset] = q.getLine(r.index);
  const d = new WR_Delta().retain(r.index);
  let at = r.index;
  if (offset > 0) { d.insert('\n', writerBlockOnly(q.getFormat(r.index, 0))); at += 1; }
  // Right under another table the two would merge: keep a line between them
  else if (at > 0 && q.getFormat(at - 1, 1).table != null) { d.insert('\n'); at += 1; }
  for (let i = 0; i < Math.min(rows, 20); i++) d.insert('\n'.repeat(Math.min(cols, 10)), { table: writerNewRowId() });
  writerAsUser('structure', () => q.updateContents(d, 'user'));
  q.setSelection(at, 0, 'silent');
  writerScheduleUi();
  return true;
}
// Enter in a cell. Cells hold one line, so Enter never edits away from the
// caret: at the very start of the table it opens a line above it, in the last
// row a line below it (the way out of a table), and elsewhere it moves to the
// same column in the next row.
function writerTableEnter(range) {
  const q = WR.quill, tm = q.getModule('table');
  if (!tm || !writerCanEdit()) return;
  let table, row, cell, offset;
  try { [table, row, cell, offset] = tm.getTable(range); } catch { return; }
  if (!table || !row || !cell) return;
  const start = table.offset(q.scroll);
  if (!row.prev && !cell.prev && offset === 0 && !range.length) {
    writerAsUser('type', () => q.updateContents(new WR_Delta().retain(start).insert('\n'), 'user'), 'insertParagraph');
    q.setSelection(start, 0, 'silent');
  } else if (!row.next) {
    const end = start + table.length();
    writerAsUser('type', () => q.updateContents(new WR_Delta().retain(end).insert('\n'), 'user'), 'insertParagraph');
    q.setSelection(end, 0, 'silent');
  } else {
    const col = row.children.indexOf(cell);
    const below = row.next.children.at(Math.max(0, col)) || row.next.children.tail;
    if (below) q.setSelection(below.offset(q.scroll) + below.length() - 1, 0, 'user');
  }
  q.scrollSelectionIntoView();
}
const WR_TABLE_OPS = { rowAbove: 'insertRowAbove', rowBelow: 'insertRowBelow', colLeft: 'insertColumnLeft', colRight: 'insertColumnRight', deleteRow: 'deleteRow', deleteCol: 'deleteColumn', deleteTable: 'deleteTable' };
function writerTableOp(op) {
  const q = WR.quill;
  const fn = WR_TABLE_OPS[op], tm = q.getModule('table');
  if (!fn || !tm) return false;
  const r = writerSel();
  if (q.getFormat(r.index, 0).table == null) return false;
  writerAsUser('structure', () => tm[fn]());
  writerScheduleUi();
  return true;
}

/* ---- pictures ---- */
// The picture selected on its own (clicked), or null
function writerImageAt() {
  const q = WR.quill, r = WR.lastRange;
  if (!q || !r || r.length !== 1) return null;
  const op = q.getContents(r.index, 1).ops[0];
  return op && op.insert && typeof op.insert === 'object' && op.insert.image != null ? { index: r.index, attrs: op.attributes || {} } : null;
}
function writerImageSelection() {
  const im = writerImageAt();
  return im ? { width: im.attrs.width ? Number(im.attrs.width) : null, alt: im.attrs.alt || '' } : null;
}
const WR_IMAGE_SIZES = { small: 0.25, medium: 0.5, large: 0.75, full: 1 };
function writerImageSize(v) {
  const im = writerImageAt(), f = WR_IMAGE_SIZES[v];
  if (!im || !f) return false;
  writerAsUser('type', () => WR.quill.formatText(im.index, 1, { width: String(Math.round(WR_TEXT_W * f)) }, 'user'));
  writerScheduleUi();
  return true;
}
function writerImageAlt(v) {
  const im = writerImageAt();
  if (!im) return false;
  const alt = String(v == null ? '' : v).slice(0, 300);
  writerAsUser('type', () => WR.quill.formatText(im.index, 1, { alt: alt || false }, 'user'));
  writerScheduleUi();
  return true;
}
// Pictures come from outside the essay, so the paste setting covers them
function writerImagesAllowed() {
  if (WR.data?.assignment?.writing?.allowPaste === 'allow') return true;
  toast('Images from outside the essay are turned off for this assignment.', 'err');
  wsNoteEvent('paste-blocked', { len: 0, detail: 'image' });
  return false;
}
// Insert → Image: the file picker
function writerPickImage() {
  if (!writerCanEdit() || !writerImagesAllowed()) return false;
  const range = writerRange();
  const input = document.createElement('input');
  input.type = 'file'; input.accept = WR_IMAGE_TYPES.join(','); input.multiple = true;
  input.onchange = () => { const files = Array.from(input.files || []); if (files.length) writerInsertImages(range, files, 'toolbar'); };
  input.click();
  return true;
}
// Upload pictures (shrunk first), then put them where the caret was, wherever
// that has moved to while they uploaded. Also Quill's uploader (pasted or
// dropped picture files).
async function writerInsertImages(range, files, it) {
  const q = WR.quill;
  if (!q || !WR.doc || lockReason()) return;
  if (!it) it = performance.now() - (WR.dropAt || 0) < 1500 ? 'insertFromDrop' : 'insertFromPaste';
  if (!writerImagesAllowed()) return;
  const list = Array.from(files || []).filter(f => f && WR_IMAGE_TYPES.includes(f.type)).slice(0, 10);
  if (!list.length) return;
  const base = range || writerRange();
  let start = base.index, end = base.index + (base.length || 0);
  const loads = WR.loads;
  const follow = delta => { start = delta.transformPosition(start); end = Math.max(start, delta.transformPosition(end)); };
  q.on('text-change', follow);
  const ids = [];
  toast(list.length > 1 ? `Adding ${list.length} images…` : 'Adding the image…');
  try {
    for (const f of list) {
      const { blob, w, h } = await writerShrinkImage(f);
      const r = await wapi(`/api/write/${WR.doc.id}/images?w=${w}&h=${h}`, { method: 'POST', raw: blob, headers: { 'X-Visor-Surface': WR.surfaceId } });
      if (r && /^[a-f0-9]{32}$/.test(r.id || '')) { WR.imageIds.add(r.id); ids.push(r.id); }
    }
  } catch (e) {
    if (e.status === 409 && e.data?.ended) wsSessionEnded(e.data);
    else if (e.status === 401) wsLost(e.message);
    else toast(e.network ? 'You seem to be offline, so the image wasn’t added.' : (e.message || 'That image couldn’t be added.'), 'err');
  } finally { q.off('text-change', follow); }
  if (!ids.length || WR.quill !== q) return;
  // Only if this page may still write (stepping away for a moment is fine)
  const reason = lockReason();
  if (reason && !['left-tab', 'left-window', 'blocked-site', 'exit-fullscreen'].includes(reason)) { toast('The image wasn’t added because writing is paused.', 'err'); return; }
  if (WR.loads !== loads) { const r = writerRange(); start = r.index; end = r.index; }
  const max = q.getLength() - 1;
  start = Math.min(start, max); end = Math.min(Math.max(end, start), max);
  const d = new WR_Delta().retain(start);
  if (end > start) d.delete(end - start);
  for (const id of ids) d.insert({ image: writerImageSrc(id) });
  const was = q.isEnabled();
  if (!was) q.enable(true);
  WR.pendingSrc = { src: 'image', it, once: true };
  try { writerHistoryStep({ src: 'image' }, () => q.updateContents(d, 'user')); } finally { WR.pendingSrc = null; if (!was) q.enable(false); }
  WR.lastRange = { index: start + ids.length, length: 0 };
  if (q.hasFocus()) q.setSelection(WR.lastRange.index, 0, 'silent');
  toast(ids.length > 1 ? 'Images added' : 'Image added');
}
// Big pictures are scaled down (1600 px on the long side) and re-encoded so
// the upload stays well under 5 MB. Small ones, and GIFs (they may move), go as they are.
async function writerShrinkImage(file) {
  const MAX_BYTES = 5 * 1024 * 1024, KEEP_BYTES = 1.5 * 1024 * 1024, MAX_SIDE = 1600;
  let bmp;
  try { bmp = await createImageBitmap(file); } catch { throw new Error('That image couldn’t be read. Try a PNG or JPEG.'); }
  const w0 = bmp.width, h0 = bmp.height, big = Math.max(w0, h0);
  const done = out => { try { bmp.close(); } catch {} return out; };
  if ((file.type === 'image/gif' && file.size <= MAX_BYTES) || (big <= MAX_SIDE && file.size <= KEEP_BYTES)) return done({ blob: file, w: w0, h: h0 });
  let scale = Math.min(1, MAX_SIDE / big);
  for (let i = 0; i < 5; i++) {
    const w = Math.max(1, Math.round(w0 * scale)), h = Math.max(1, Math.round(h0 * scale));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.drawImage(bmp, 0, 0, w, h);
    let blob = await new Promise(res => c.toBlob(res, 'image/webp', 0.86));
    if (!blob || blob.type !== 'image/webp') {
      // No WebP here: JPEG on white (it has no transparency)
      g.globalCompositeOperation = 'destination-over'; g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
      blob = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.86));
    }
    if (blob && blob.size <= MAX_BYTES) return done({ blob, w, h });
    scale *= 0.7;
  }
  done(null);
  throw new Error('That image is too large (5 MB at most).');
}

/* ====================== find & replace ====================== */
// Matches are found in the EMBED-aware text (one character per Quill index)
// and shown with the CSS Custom Highlight API, which never touches the document.
function writerFind(query, opts) {
  WR.find = { query: String(query == null ? '' : query).split(WR_EMBED).join(''), matchCase: !!(opts && opts.matchCase), matches: [], current: -1 };
  writerFindRun('caret', true);
  return writerFindResult();
}
// count, and current as "n of count" (1-based; 0 with no matches)
function writerFindResult() {
  const f = WR.find;
  return { count: f ? f.matches.length : 0, current: f && f.current >= 0 ? f.current + 1 : 0 };
}
// anchor: 'caret' (the first match from the caret), a text index (the first
// match from there), or null (stay near the current one)
function writerFindRun(anchor, scroll = true) {
  const f = WR.find; if (!f) return;
  WR.findDirty = false;
  const prev = f.matches[f.current];
  f.matches = [];
  if (f.query) {
    const text = writerText();
    const re = new RegExp(f.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), f.matchCase ? 'gu' : 'giu');
    let m;
    while ((m = re.exec(text)) && f.matches.length < 10000) {
      if (!m[0].length) { re.lastIndex++; continue; }
      f.matches.push({ i: m.index, n: m[0].length });
    }
  }
  const from = anchor === 'caret' ? writerRange().index : typeof anchor === 'number' ? anchor : prev ? prev.i : 0;
  let c = f.matches.findIndex(x => x.i >= from);
  if (c < 0) c = 0;
  f.current = f.matches.length ? c : -1;
  writerFindPaint(scroll && anchor != null);
}
function writerFindStep(dir) {
  const f = WR.find;
  if (!f) return writerFindResult();
  if (WR.findDirty) writerFindRun(null, false);
  if (!f.matches.length) return writerFindResult();
  f.current = (f.current + (Number(dir) < 0 ? -1 : 1) + f.matches.length) % f.matches.length;
  writerFindPaint(true);
  return writerFindResult();
}
// Replace the current match (with the formatting of its first character)
function writerReplace(replacement) {
  const f = WR.find;
  if (!f || !writerCanEdit()) return writerFindResult();
  if (WR.findDirty) writerFindRun(null, false);
  const m = f.matches[f.current];
  if (!m) return writerFindResult();
  const q = WR.quill;
  const s = String(replacement == null ? '' : replacement).replace(/[\r\uFFFC]/g, '');
  const d = new WR_Delta().retain(m.i).delete(m.n);
  if (s) d.insert(s, writerInlineOnly(q.getFormat(m.i, 1)));
  writerAsUser('replace', () => q.updateContents(d, 'user'), 'findReplace');
  writerFindRun(m.i + s.length, true);
  return writerFindResult();
}
// Every match at once: one change, so one labelled edit (and one undo)
function writerReplaceAll(replacement) {
  const f = WR.find;
  if (!f || !f.query || !writerCanEdit()) return { replaced: 0 };
  // The matches are current unless the essay changed since the last search
  if (WR.findDirty) writerFindRun(null, false);
  const ms = f.matches.slice();
  if (!ms.length) return { replaced: 0 };
  const q = WR.quill;
  const s = String(replacement == null ? '' : replacement).replace(/[\r\uFFFC]/g, '');
  // Each replacement takes the text formats of its match's first character:
  // one walk through the essay's contents (matches are in order)
  const ops = s ? q.getContents().ops : [];
  let k = 0, pos = 0;
  const fmtAt = i => {
    for (; k < ops.length; k++) {
      const n = typeof ops[k].insert === 'string' ? ops[k].insert.length : 1;
      if (i < pos + n) return writerInlineOnly(ops[k].attributes);
      pos += n;
    }
    return {};
  };
  const d = new WR_Delta();
  let at = 0;
  for (const m of ms) {
    d.retain(m.i - at).delete(m.n);
    if (s) d.insert(s, fmtAt(m.i));
    at = m.i + m.n;
  }
  writerAsUser('replace', () => q.updateContents(d, 'user'), 'findReplace');
  // The replaced matches are gone. The search runs again once the essay
  // settles (writerAfterChange), not inside this click.
  f.matches = []; f.current = -1;
  writerClearHighlights();
  return { replaced: ms.length };
}
function writerClearFind() {
  const f = WR.find;
  WR.find = null; WR.findDirty = false;
  clearTimeout(WR.findTimer); WR.findTimer = null;
  writerClearHighlights();
  // The match that was current becomes the selection when the essay gets focus back
  const m = f && f.matches[f.current];
  if (m) WR.lastRange = { index: m.i, length: m.n };
  writerScheduleUi();
}
function writerClearHighlights() {
  try { if (window.CSS && CSS.highlights) { CSS.highlights.delete('dx-find'); CSS.highlights.delete('dx-find-current'); } } catch {}
}
// A DOM range over Quill indexes [index, index + length) (as Quill's own getBounds builds one)
function writerDomRange(index, length) {
  const q = WR.quill;
  const total = q.getLength();
  if (index >= total - 1) return null;
  length = Math.min(index + length, total - 1) - index;
  let [leaf, offset] = q.getLeaf(index);
  if (!leaf) return null;
  if (length > 0 && offset === leaf.length()) {
    const [next] = q.getLeaf(index + 1);
    if (next && q.getLine(index)[0] === q.getLine(index + 1)[0]) { leaf = next; offset = 0; }
  }
  const [sn, so] = leaf.position(offset, true);
  const [eleaf, eoff] = q.getLeaf(index + length);
  if (!eleaf) return null;
  const [en, eo] = eleaf.position(eoff, true);
  const range = document.createRange();
  try { range.setStart(sn, so); range.setEnd(en, eo); } catch { return null; }
  return range;
}
function writerFindPaint(scroll) {
  const f = WR.find;
  if (!f || !WR.quill) return writerClearHighlights();
  const cur = f.matches[f.current];
  if (window.CSS && CSS.highlights && typeof Highlight === 'function') {
    // At most 1,500 highlighted at once: the ones around the current match
    const lo = Math.max(0, Math.min(f.current - 750, f.matches.length - 1500));
    const all = [], now = [];
    for (let k = Math.max(0, lo); k < Math.min(f.matches.length, lo + 1500); k++) {
      const r = writerDomRange(f.matches[k].i, f.matches[k].n);
      if (r) (k === f.current ? now : all).push(r);
    }
    try {
      CSS.highlights.set('dx-find', new Highlight(...all));
      const h = new Highlight(...now); h.priority = 1;
      CSS.highlights.set('dx-find-current', h);
    } catch {}
  }
  if (scroll && cur) {
    const r = writerDomRange(cur.i, cur.n);
    const rect = r && r.getBoundingClientRect();
    const top = writerStickyHeight() + 12, bottom = window.innerHeight - 24;
    if (rect && (rect.top < top || rect.bottom > bottom)) window.scrollBy({ top: rect.top - (top + (bottom - top) / 3) });
  }
}

/* ====================== outline ====================== */
// Title, Subtitle and Headings 1–3, with where each starts
function writerBuildOutline() {
  const q = WR.quill; if (!q) return [];
  const out = [];
  let index = 0;
  for (const line of q.getLines()) {
    const name = line.statics && line.statics.blotName;
    let level = null;
    if (name === 'header') { const h = Number(line.formats().header); if (h >= 1 && h <= 3) level = h; }
    else if (name === 'title' || name === 'subtitle') level = name;
    if (level != null) {
      const text = (line.domNode.textContent || '').replace(/[\uFEFF\uFFFC]/g, '').trim();
      if (text) out.push({ level, text: text.slice(0, 200), index });
    }
    index += line.length();
  }
  return out;
}
function writerOutline() {
  if (!WR.outline) { WR.outline = writerBuildOutline(); WR.outlineSig = JSON.stringify(WR.outline); }
  return WR.outline.map(x => Object.assign({}, x));
}
function writerRefreshOutline() {
  const next = writerBuildOutline();
  const sig = JSON.stringify(next);
  if (sig === WR.outlineSig && WR.outline) return;
  WR.outline = next; WR.outlineSig = sig; WR.outlineRev = (WR.outlineRev || 0) + 1;
  writerScheduleUi();
}
function writerShowOutline(on) {
  WR.outlineOpen = !!on && !WR.embed;
  writerSetPref('visor-outline', WR.outlineOpen ? '1' : '0');
  $('dxCanvas')?.classList.toggle('dx-outline-on', WR.outlineOpen);
  if (WR.outlineOpen) writerRefreshOutline();
  writerApplyZoom(true);
  writerScheduleUi();
}

/* ====================== the page: zoom and page breaks ====================== */
function writerSetZoom(v) {
  let s = v === 'fit' ? 'fit' : Number(v);
  if (s !== 'fit') {
    if (!(s > 0)) return false;
    if (s <= 5) s *= 100;   // a factor (1.25) or a percentage (125)
    s = Math.max(50, Math.min(200, Math.round(s)));
  }
  WR.zoomSetting = s;
  writerSetPref('visor-zoom', s);
  writerApplyZoom(true);
  writerScheduleUi();
  return true;
}
// Fit: the page and a 20px margin on each side fill the canvas (50–200%)
function writerApplyZoom(relayout) {
  const canvas = $('dxCanvas'); if (!canvas) return;
  let z = 1;
  if (!WR.embed) {
    if (WR.zoomSetting === 'fit') { const w = ($('dxPages') || canvas).clientWidth; WR.fitW = w; z = w ? Math.max(0.5, Math.min(2, w / (WR_PAGE_W + 40))) : 1; }
    else z = (Number(WR.zoomSetting) || 100) / 100;
  }
  z = Math.round(z * 1000) / 1000;
  if (z === WR.zoom && canvas.style.getPropertyValue('--dx-zoom')) return;
  WR.zoom = z;
  canvas.style.setProperty('--dx-zoom', String(z));
  if (relayout !== false) { WR.breaksSig = ''; writerLayoutSoon(0); }
}

// Pages and the outline catch up 250 ms after the last change (at least once a second while typing)
function writerLayoutSoon(ms = 250) {
  const now = Date.now();
  if (!WR.layoutTimer) WR.layoutSince = now;
  clearTimeout(WR.layoutTimer);
  WR.layoutTimer = setTimeout(writerLayout, now - WR.layoutSince > 1000 ? 0 : ms);
}
function writerLayout() {
  WR.layoutTimer = null;
  if (!WR.quill) return;
  writerLayoutPages();
  writerRefreshOutline();
}

// Where letter pages would end. One continuous editor: each page holds 9in of
// writing; a block that crosses the end of a page is split at the last line
// that fits (table rows aren't split). Dashed lines and "Page N" mark the
// breaks; the page is made tall enough that the last page is a full one.
function writerLayoutPages() {
  const paper = $('wrPaper'), layer = $('dxBreaks'), ed = WR.quill?.root;
  if (!paper || !layer || !ed) return;
  if (WR.embed) { WR.pages = 1; if (layer.firstChild) layer.textContent = ''; return; }
  const z = WR.zoom || 1;
  const base = ed.getBoundingClientRect().top;
  const Y = v => (v - base) / z;
  const units = [];
  for (const el of ed.children) {
    if (el.tagName === 'OL' || el.tagName === 'UL') units.push(...el.children);
    else if (el.tagName === 'TABLE') units.push(...el.querySelectorAll('tr'));
    else units.push(el);
  }
  const breaks = [];
  let pageStart = 0, lastBottom = 0;
  const place = (top, bottom) => {
    while (bottom > pageStart + WR_PAGE_TEXT_H) {
      // after the last line that fits (halfway to the next), else through the block
      let at = lastBottom > pageStart ? (top > lastBottom ? (lastBottom + top) / 2 : lastBottom) : top > pageStart ? top : pageStart + WR_PAGE_TEXT_H;
      if (at <= pageStart) at = pageStart + WR_PAGE_TEXT_H;
      breaks.push(at);
      pageStart = at;
    }
    lastBottom = bottom;
  };
  for (const el of units) {
    const r = el.getBoundingClientRect();
    if (!r.height) continue;
    const top = Y(r.top), bottom = Y(r.bottom);
    if (bottom <= pageStart + WR_PAGE_TEXT_H) { lastBottom = bottom; continue; }
    const lines = el.tagName === 'TR' ? [] : writerLineBoxes(el, Y);
    if (!lines.length) lines.push([top, bottom]);
    for (const [lt, lb] of lines) place(lt, lb);
  }
  WR.pages = breaks.length + 1;
  const textH = (breaks.length ? breaks[breaks.length - 1] : 0) + WR_PAGE_TEXT_H;
  const sig = `${WR.pageBreaks}|${textH}|${breaks.map(b => b.toFixed(1)).join(',')}`;
  if (sig === WR.breaksSig) return;
  WR.breaksSig = sig;
  paper.style.setProperty('--dx-text-h', `${Math.round(textH)}px`);
  layer.innerHTML = WR.pageBreaks ? breaks.map((y, k) => `<div class="dx-break" style="top:${(WR_MARGIN + y).toFixed(1)}px"><span>Page ${k + 2}</span></div>`).join('') : '';
  writerScheduleUi();
}
// A block's line boxes: its client rects, grouped where they overlap
function writerLineBoxes(el, Y) {
  const range = document.createRange();
  range.selectNodeContents(el);
  const rects = Array.from(range.getClientRects()).filter(r => r.height > 0).map(r => [Y(r.top), Y(r.bottom)]).sort((a, b) => a[0] - b[0]);
  const lines = [];
  for (const [t, b] of rects) {
    const last = lines[lines.length - 1];
    if (last && t < last[1] - 2) last[1] = Math.max(last[1], b);
    else lines.push([t, b]);
  }
  return lines;
}

/* ====================== print and download ====================== */
// The essay as HTML, from a detached read-only Quill (what the student sees,
// in the document style), and the Works Cited
function writerEssayHtml() {
  const div = document.createElement('div');
  const q = new Quill(div, { readOnly: true, formats: WR_DF.QUILL_FORMATS });
  q.setContents(WR.quill.getContents(), 'silent');
  return `<div class="dx-print-essay ${WR_DF.styleClass(WR.docStyle)}"><div class="ql-editor">${q.root.innerHTML}</div></div>`;
}
function writerWorksHtml() {
  if (writerWorksMode() !== 'page') return '';
  const bib = VisorCiteFormat.bibliography(WR.doc?.sources || [], WR.data.assignment.writing.citationStyle);
  if (!bib.items.length) return '';
  return `<section class="dx-print-works ${WR_DF.styleClass(WR.docStyle)}"><h2>${esc(bib.heading)}</h2><ol class="wr-bib">${bib.items.map(i => `<li><span class="wr-bib-text">${i.html}</span></li>`).join('')}</ol></section>`;
}
// Letter pages with 1in margins; MLA adds "Lastname 1" at the top right of each page
function writerPageCss() {
  const last = String(WR.data?.user?.name || '').trim().split(/\s+/).pop() || '';
  const header = WR.docStyle === 'mla' && last ? ` @top-right { content: "${last.replace(/[\\"]/g, '\\$&').replace(/[\r\n]/g, ' ')} " counter(page); font-family: 'Times New Roman', Tinos, Times, serif; font-size: 12pt; }` : '';
  return `@page { size: letter; margin: 1in;${header} }`;
}
async function writerPrint() {
  if (WR.printing || !WR.quill) return;
  writerAfterPrint();
  const host = $('dxPrint'); if (!host) return;
  WR.printing = true;
  try {
    host.innerHTML = writerEssayHtml() + writerWorksHtml();
    const style = document.createElement('style');
    style.id = 'dxPrintStyle';
    style.textContent = writerPageCss();
    document.head.appendChild(style);
    document.body.classList.add('dx-printing');
    await Promise.all(Array.from(host.querySelectorAll('img'), img => (img.decode ? img.decode().catch(() => {}) : null)));
    window.print();
  } catch (e) {
    console.error(e);
    writerAfterPrint();
  }
}
function writerAfterPrint() {
  document.body.classList.remove('dx-printing');
  document.getElementById('dxPrintStyle')?.remove();
  const host = $('dxPrint'); if (host) host.innerHTML = '';
  WR.printing = false;
}
function writerDownloadName(ext) {
  return `${String(WR.data?.assignment?.title || 'Essay').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 80) || 'Essay'}.${ext}`;
}
function writerSaveFile(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function writerDownload(kind) {
  if (!WR.quill) return false;
  if (kind === 'txt') {
    let text = writerText().split(WR_EMBED).join('[image]');
    const bib = VisorCiteFormat.bibliography(WR.doc?.sources || [], WR.data.assignment.writing.citationStyle);
    if (bib.items.length && writerWorksMode() === 'page') {
      const plain = h => { const d = document.createElement('div'); d.innerHTML = h; return d.textContent; };
      text += `\n\n${bib.heading}\n\n${bib.items.map(i => plain(i.html)).join('\n')}`;
    }
    writerSaveFile(new Blob([text], { type: 'text/plain;charset=utf-8' }), writerDownloadName('txt'));
    return true;
  }
  if (kind === 'html') { writerDownloadHtml().catch(e => toast(e.message || 'The web page couldn’t be made.', 'err')); return true; }
  return false;
}
// A web page that stands on its own: the document style's CSS and the pictures inside it
async function writerDownloadHtml() {
  toast('Preparing the web page…');
  const holder = document.createElement('div');
  holder.innerHTML = writerEssayHtml() + writerWorksHtml();
  for (const img of holder.querySelectorAll('img')) {
    const src = img.getAttribute('src') || '';
    if (!WR_DF.imageIdFromSrc(src)) continue;
    try {
      const blob = await (await fetch(src, { credentials: 'same-origin' })).blob();
      img.setAttribute('src', await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob); }));
    } catch {}
  }
  const get = u => fetch(u, { credentials: 'same-origin' }).then(r => (r.ok ? r.text() : '')).catch(() => '');
  const [snow, doc] = await Promise.all([get('/vendor/quill/quill.snow.css'), get('/doc-format.css')]);
  const page = `body{margin:0;background:#f1f3f4;color:#000}.dx-print-essay,.dx-print-works{box-sizing:border-box;max-width:8.5in;margin:24px auto;padding:1in;background:#fff;box-shadow:0 1px 3px rgba(60,64,67,.3)}.ql-editor{padding:0;overflow:visible;height:auto}.dx-print-works.doc-style-mla{font:12pt/2 'Times New Roman',Tinos,Times,serif}.dx-print-works.doc-style-docs{font:11pt/1.15 Arial,Arimo,Helvetica,sans-serif}.dx-print-works h2{font:inherit;text-align:center;margin:0}.wr-bib{list-style:none;padding:0;margin:0}.wr-bib-text{display:block;padding-left:.5in;text-indent:-.5in}@media print{body{background:#fff}.dx-print-essay,.dx-print-works{box-shadow:none;margin:0;padding:0;max-width:none}.dx-print-works{break-before:page}}`;
  const title = esc(WR.data?.assignment?.title || 'Essay');
  const html = `<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>${snow}\n${doc}\n${page}</style></head><body>${holder.innerHTML}</body></html>`;
  writerSaveFile(new Blob([html], { type: 'text/html;charset=utf-8' }), writerDownloadName('html'));
}

// Tools → Word count (also ⌘⇧C)
function writerWordCountDialog() {
  const s = writerWordStats();
  const fmt = n => Number(n || 0).toLocaleString();
  const row = (label, k) => `<tr><td>${label}</td><td class="num">${s.selection && k !== 'pages' ? `${fmt(s.selection[k])} of ${fmt(s[k])}` : fmt(s[k])}</td></tr>`;
  const float = writerPref('visor-wc-float', '1') === '1';
  openModal({ title: 'Word count', body: `<table class="dx-wc-table">${row('Pages', 'pages')}${row('Words', 'words')}${row('Characters', 'chars')}${row('Characters excluding spaces', 'charsNoSpaces')}</table>
    <label class="check-row" style="margin:14px 0 0;"><input type="checkbox" id="dxWcFloat" ${float ? 'checked' : ''}> <span>Display word count while typing</span></label>`,
    footer: `<button class="btn btn-primary" onclick="closeModal();writerFocus()">OK</button>` });
  $('dxWcFloat').onchange = e => { writerSetPref('visor-wc-float', e.target.checked ? '1' : '0'); writerScheduleUi(); };
}

/* ====================== UI state ====================== */
// The cloud next to the title, as in Docs: saved, saving, or offline
const WR_CLOUD = {
  saved: '<path d="M7 18h10.5a4.5 4.5 0 0 0 .5-8.97A6 6 0 0 0 6.34 10 4 4 0 0 0 7 18z"/><path d="m9.5 13.5 1.8 1.8 3.4-3.6"/>',
  saving: '<path d="M7 18h10.5a4.5 4.5 0 0 0 .5-8.97A6 6 0 0 0 6.34 10 4 4 0 0 0 7 18z"/><path d="M12 11v4M10.3 12.7 12 11l1.7 1.7"/>',
  offline: '<path d="M7 18h10.5a4.5 4.5 0 0 0 1.6-.3M20.9 14.6A4.5 4.5 0 0 0 18 9.03 6 6 0 0 0 9.3 5.6M6.34 10A4 4 0 0 0 7 18"/><path d="m3 3 18 18"/>'
};
function writerSetSaved(state) {
  WR.saveState = state;
  const el = $('wrSaved'); if (!el) return;
  const key = state === 'offline' ? 'offline' : state === 'saved' ? 'saved' : 'saving';
  if (el.dataset.state === key) return;
  el.dataset.state = key;
  el.className = `wr-saved ${state}`;
  // Short, so the header doesn't move as it changes (the paused card says more when offline)
  el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${WR_CLOUD[key]}</svg><span>${{ saved: 'Saved', saving: 'Saving…', offline: 'Offline' }[key]}</span>`;
  el.title = key === 'offline' ? 'Offline: your writing is saved on this device and sent when you’re back online' : key === 'saved' ? 'All your writing is saved to Visor' : 'Saving to Visor…';
}
function writerBanner(text, kind = 'info') {
  const el = $('wrBanner'); if (!el) return;
  el.innerHTML = `<div class="wr-banner ${kind}" role="${kind === 'warn' || kind === 'teacher' ? 'alert' : 'status'}"><span>${esc(text)}</span><button class="btn-icon" aria-label="Dismiss" onclick="this.parentElement.remove()">${I.x}</button></div>`;
}

// The toolbar sticks right under the header, however tall the header gets
// (also set straight after each redraw, in case the observer is slow to report).
// Scrolling to the caret keeps it clear of both.
function writerSyncBarHeight() {
  const bar = document.querySelector('.wr .wr-bar'), wr = document.querySelector('.wr'), tb = $('dxToolbar');
  if (!bar || !wr) return;
  const h = bar.offsetHeight, t = tb ? tb.offsetHeight : 0;
  wr.style.setProperty('--wr-bar-h', `${h}px`);
  wr.style.setProperty('--dx-tb-h', `${t}px`);
  document.documentElement.style.setProperty('--dx-sticky-h', `${h + t}px`);
  writerSyncToolbarEdge();
}
// Where the toolbar ends on screen right now (the site's bar above it scrolls
// away): narrow windows float the Sources panel just under it
function writerSyncToolbarEdge() {
  const tb = $('dxToolbar');
  if (!tb || !WR.sideOpen) return;
  document.documentElement.style.setProperty('--dx-tb-bottom', `${Math.max(0, Math.round(tb.getBoundingClientRect().bottom))}px`);
}
// Re-draw everything that depends on the session state. The header and the
// start card are only rebuilt when something they show changed (beats arrive
// every 10 seconds; rebuilding each time blanked the timer and closed the
// Instructions).
function writerRefresh(force) {
  if (!WR.data || !$('wrStatus')) return;
  const a = WR.data.assignment, w = a.writing, doc = WR.doc;
  const active = wsActive();
  // A session started (or was running when the page loaded): look for other
  // extensions' writing tools already on the page, once per session
  if (active && WR.toolsScannedFor !== WR.session.id) { WR.toolsScannedFor = WR.session.id; setTimeout(wsScanTools, 0); }
  const status = doc.status;
  const sig = JSON.stringify([active, status, doc.submittedAt, doc.reopened, !!doc.feedback, !!WR.session, WR.session?.state === 'ended', WR.extPresent, WR.extOther, WR.extInfo?.installed, WR.extInfo?.hasHostPermission, WR.data.timeLeftMs, WR.data.windowProblem, WR.startError, WR.starting, isLeaseHolder()]);
  if (!force && sig === WR.refreshSig) { writerSetSaved(WR.offline ? 'offline' : WR.queue.length ? 'unsaved' : 'saved'); writerUpdateCounts(); writerApplyLock(); return; }
  WR.refreshSig = sig;
  // Status line
  const extOk = WR.extPresent;
  $('wrStatus').innerHTML = active
    ? `<span class="wr-rec" title="Writing session in progress: your writing is recorded"><i class="live-dot"></i><span class="wr-rec-t">Recording</span><span class="wr-timer mono" id="wrTimer"></span></span>`
    : status === 'submitted' ? `<span class="pill pill-green" title="${esc(vcDateTime(doc.submittedAt))}">Submitted</span>`
      : status === 'returned' ? `<span class="pill pill-violet">Returned</span>` : '';
  writerSetSaved(WR.offline ? 'offline' : WR.queue.length ? 'unsaved' : 'saved');
  // Actions
  const acts = [];
  const works = writerWorksMode();
  if (!WR.embed) {
    acts.push(`<button type="button" class="wr-hbtn" id="wrInstrBtn" aria-controls="wrInstr" aria-expanded="${!!WR.instrShown}" onclick="writerToggleInstructions()" title="Instructions">${PI.down.replace('<svg', '<svg class="wr-hchev"')}<span>Instructions</span></button>`);
    if (works !== 'off') acts.push(`<button type="button" class="wr-hbtn" id="wrSideBtn" aria-controls="wrSide" aria-expanded="${!!WR.sideOpen}" onclick="writerToggleSources()" title="${works === 'page' ? 'Your sources and the Works Cited page' : 'Your sources'}">${PI.book}<span>Sources</span><span class="wr-hcount" id="wrSrcCount">${(doc.sources || []).length || ''}</span></button>`);
  }
  if (active) {
    // Locked sessions that may use the side panel move the writing there to research
    const research = w.mode === 'locked' && wsPanelAllowed() && isLeaseHolder();
    if (!WR.embed && extOk && window.VisorExt && research) acts.push(`<button class="btn btn-ghost btn-sm" onclick="wsResearchMode()">Research in side panel</button>`);
    // (Locked sessions otherwise stay in full screen, where the panel can't show)
    else if (!WR.embed && extOk && window.VisorExt && w.mode !== 'locked') acts.push(`<button class="btn btn-ghost btn-sm" onclick="VisorExt.openPanel(WR.doc.id).then(r=>{ if(!r.ok) toast(r.error||'Click the Visor icon in Chrome’s toolbar to open the side panel.','err'); })">Open side panel</button>`);
    acts.push(`<button class="btn btn-ghost btn-sm wr-end" onclick="wsEnd()">End session</button>`);
    acts.push(`<button class="btn btn-primary btn-sm wr-submit" onclick="wsSubmit()">${PI.send}Submit</button>`);
  } else if (status !== 'submitted' && WR.session && !WR.embed) {
    acts.push(`<button class="btn btn-primary btn-sm wr-submit" onclick="wsSubmit()">${PI.send}Submit</button>`);
  }
  $('wrActions').innerHTML = acts.join('');
  // While a session runs the editor has the whole window (the site's bar slides
  // away, as in Docs); outside one the bar stays, to get around the site
  document.body.classList.toggle('writing-focus', !!active && !WR.embed);
  writerSyncBarHeight();
  writerSyncInstructions();
  writerRenderIntro();
  writerRenderSources();
  writerUpdateCounts();
  WR.lastLock = undefined;
  writerApplyLock();
  writerScheduleUi();
}

// The block above the paper: instructions and the Start button, the
// ended/submitted/returned notes.
function writerRenderIntro() {
  const el = $('wrIntro'); if (!el) return;
  const a = WR.data.assignment, w = a.writing, doc = WR.doc;
  if (wsActive()) { el.innerHTML = ''; return; }
  // The side panel has no Instructions dropdown: they stay on its card
  const instr = WR.embed && a.instructions ? `<div class="wr-instr-open">${esc(a.instructions).replace(/\n/g, '<br>')}</div>` : '';
  if (doc.status === 'submitted') { el.innerHTML = `<div class="card card-pad wr-card">${instr}<div class="wr-card-line">${I.check}<span>Submitted ${esc(vcDateTime(doc.submittedAt))}${doc.autoSubmitted ? ' (automatically, when time ran out)' : ''}. Your teacher will return it with feedback.</span></div></div>`; return; }
  const fb = doc.feedback ? `<div class="wr-feedback"><div class="kicker">Feedback from your teacher</div>${doc.feedback.score != null ? `<div class="wr-score">${esc(String(doc.feedback.score))}${doc.feedback.outOf ? ` <span class="muted">/ ${esc(String(doc.feedback.outOf))}</span>` : ''}</div>` : ''}${doc.feedback.comment ? `<div>${esc(doc.feedback.comment).replace(/\n/g, '<br>')}</div>` : ''}</div>` : '';
  if (doc.status === 'returned' && !doc.reopened) { el.innerHTML = `<div class="card card-pad wr-card">${fb || '<div>Your teacher returned this.</div>'}</div>`; return; }
  const needsExt = w.mode === 'locked' || w.requireExtension;
  const extLine = !needsExt || WR.embed ? '' : WR.extPresent
    ? `<div class="wr-ext ok">${I.check}<span>Visor extension: connected</span></div>`
    : WR.extOther ? `<div class="wr-ext missing">${I.puzzle}<span>The Visor extension in this browser is connected to ${esc(WR.extOther)}. <a href="/extension/connect" data-link>Connect it to your account</a> to start.</span></div>`
      : `<div class="wr-ext missing">${I.puzzle}<span>${WR.extInfo?.installed ? '<a href="/extension/connect" data-link>Connect the Visor extension</a> to start' : 'Install the Visor extension, then <a href="/extension/connect" data-link>connect it</a> to start'}.</span></div>`;
  const needsPerm = !WR.embed && (w.researchTracking || w.blockAiSites || w.mode === 'locked') && WR.extPresent && WR.extInfo && !WR.extInfo.hasHostPermission;
  const permLine = needsPerm ? `<div class="wr-ext missing">${I.alert}<span>${w.mode === 'locked' ? 'Locked sessions need' : w.blockAiSites ? 'This assignment blocks AI sites, which needs' : 'This assignment records research, which needs'} your OK for the extension to see the pages you visit during the session. <button class="btn btn-ghost btn-sm" onclick="extAllowResearch()">Allow research recording</button></span></div>` : '';
  const outOfTime = WR.data.timeLeftMs != null && WR.data.timeLeftMs <= 5000;
  const blocked = localWhen(WR.data.windowProblem) || (outOfTime ? 'You’ve used all of your time for this assignment.' : '') || (needsExt && !WR.extPresent && !WR.embed ? '' : '');
  const timeNote = WR.data.timeLeftMs != null && !outOfTime && WR.session ? `<div class="small muted">${vcDur(WR.data.timeLeftMs)} left of your time for this assignment.</div>` : '';
  const ended = WR.session && WR.session.state === 'ended';
  el.innerHTML = `<div class="card card-pad wr-card">
    ${fb}${ended ? '' : instr}
    <div class="wr-start-h">${ended ? 'Your session ended' : doc.status === 'returned' ? 'Your teacher reopened this for more writing' : 'Ready when you are'}</div>
    ${WR.embed ? `<div class="wr-describe">${esc(WR.data.describe)}</div>` : `<div class="wr-describe">${ended ? 'Your writing is saved. Start another session to keep going, or submit it.' : 'Everything you write is saved as you go. The instructions and the rules for this assignment are above.'}</div>`}
    ${extLine}${permLine}${timeNote}
    ${blocked ? `<div class="callout amber" style="margin-top:10px;">${esc(blocked)}</div>` : ''}
    <div id="wrStartErr" class="form-error ${WR.startError ? '' : 'hidden'}" style="margin-top:12px;">${esc(WR.startError || '')}</div>
    <div class="btn-row" style="margin-top:14px;">
      ${WR.embed && w.mode === 'locked' ? '<div class="small muted">Start locked sessions from the Visor tab.</div>'
        : `<button class="btn btn-primary btn-lg" id="wrStartBtn" onclick="wsStart()" ${blocked || WR.starting ? 'disabled' : ''}>${WR.starting ? '<span class="spinner spinner-sm"></span> Starting…' : `${I.pen}${ended ? 'Start a new session' : 'Start writing session'}`}</button>`}
      ${ended && !WR.embed ? `<button class="btn btn-ghost btn-lg" onclick="wsSubmit()">Submit</button>` : ''}
    </div>
    ${w.mode === 'locked' && !WR.embed ? '<div class="tiny muted" style="margin-top:8px;">The session runs in full screen. Leaving full screen or the Visor tab pauses your writing.</div>' : ''}
  </div>`;
}

// The extension's side panel shows how writing stands (its state chip)
const WR_PANEL_WHY = { 'left-tab': 'the panel is hidden', 'left-window': 'you left Chrome', 'exit-fullscreen': 'you left full screen', offline: 'offline', teacher: 'your teacher paused it', 'ext-missing': 'the extension is off', 'blocked-site': 'on a blocked site' };
function writerPanelStatus(reason) {
  if (!WR.embed || !WR.embedOrigin || window.parent === window) return;
  const state = reason === null ? 'writing' : reason === 'mirror' ? 'elsewhere' : reason === 'not-started' ? 'waiting' : reason === 'ended' ? 'ended' : 'paused';
  try { window.parent.postMessage({ source: 'visor-page', type: 'PANEL_STATUS', state, why: WR_PANEL_WHY[reason] || '' }, WR.embedOrigin); } catch {}
}

const LOCK_TEXT = {
  'left-tab': ['Session paused: you left the Visor tab.', 'Writing is turned off while you’re away.'],
  'left-window': ['Session paused: you left the Visor window.', 'Writing is turned off while you’re away.'],
  'exit-fullscreen': ['Session paused: you left full screen.', 'Locked sessions run in full screen.'],
  offline: ['Offline: your writing is saved on this device.', 'Writing turns back on when the connection does.'],
  'ext-missing': ['Visor’s extension was turned off.', 'Turn it back on, then reload this page to keep writing.'],
  teacher: ['Your teacher paused the session.', 'Writing turns back on when they resume it.'],
  'blocked-site': ['You’re on a blocked site.', 'Time on blocked sites counts as time away. Go back to another tab to keep researching.']
};

// Enable or lock the editor; show the paused or mirror card. Runs every
// second and on every change, and only touches the page when the reason changes.
function writerApplyLock() {
  if (!WR.quill) return;
  const reason = lockReason();
  const canWrite = reason === null;
  if (WR.quill.isEnabled() !== canWrite) WR.quill.enable(canWrite);
  $('wrPaper')?.classList.toggle('locked', !canWrite && wsActive());
  // The menus follow (editing items off while writing is locked)
  if (canWrite !== WR.lastCanEdit) { WR.lastCanEdit = canWrite; writerScheduleUi(); }
  if (WR.lease?.surf !== 'panel') WR.panelClosed = false;
  if (reason === WR.lastLock) return;
  const prev = WR.lastLock;
  WR.lastLock = reason;
  writerPanelStatus(reason);
  // (Not while the side panel's student is on another tab: that would pull them back)
  if (canWrite && prev && prev !== 'mirror' && prev !== 'not-started' && prev !== 'ended' && document.hasFocus()) setTimeout(() => WR.quill?.focus(), 0);
  if (!canWrite && prev === null) WR.awaySince = Date.now();
  const ov = $('wrOverlay');
  if (!wsActive() || canWrite) { ov.classList.add('hidden'); ov.innerHTML = ''; return; }
  ov.classList.remove('hidden');
  if (reason === 'mirror') {
    const w = WR.data.assignment.writing;
    const locked = w.mode === 'locked';
    if (locked && !WR.embed && WR.lease?.surf === 'panel') {
      // The extension says the panel was closed (or isn't open): its loosened rules are gone too
      const gone = WR.panelClosed || WR.extInfo?.session?.panelOpen === false;
      ov.innerHTML = gone
        ? `<div class="wr-card-pause" role="alert"><b>The side panel was closed</b><p>Go back to full screen to keep writing. The session’s allowed sites apply again.</p><button class="btn btn-primary" onclick="wsBackToFullscreen()">Back to full screen</button></div>`
        : `<div class="wr-card-pause" role="status"><b>Writing in the side panel</b><p>Sites you open are recorded. Blocked and AI sites stay blocked.</p><button class="btn btn-primary" onclick="wsBackToFullscreen()">Back to full screen</button></div>`;
      return;
    }
    if (locked && WR.embed && !wsPanelAllowed()) {
      ov.innerHTML = `<div class="wr-card-pause" role="status"><b>Writing in the Visor tab</b><p>This assignment stays in full screen, so you can’t write here.</p></div>`;
      return;
    }
    const where = WR.lease?.surf === 'panel' ? 'Writing in side panel' : WR.embed ? 'Writing in the Visor tab' : 'Writing in another Visor tab';
    ov.innerHTML = `<div class="wr-card-pause" role="status"><b>${where}</b><p>This copy shows the text as it’s written there.</p><button class="btn btn-primary" onclick="wsTakeLease()">Write here instead</button></div>`;
    return;
  }
  const [title, line] = LOCK_TEXT[reason] || ['Session paused.', ''];
  const showResume = ['left-tab', 'left-window', 'exit-fullscreen'].includes(reason);
  ov.innerHTML = `<div class="wr-card-pause" role="alert"><b>${esc(title)}</b><p>${esc(line)}</p>
    <div class="wr-away">Away <span id="wrAwayTime">${vcDur(Date.now() - (WR.awaySince || Date.now()))}</span></div>
    ${showResume ? `<button class="btn btn-primary" onclick="wsResume()">${reason === 'exit-fullscreen' ? 'Return to full screen' : 'Resume'}</button>` : ''}</div>`;
}

/* ====================== citations ======================
   The extension's cite button reads the page and sends its details here (to
   the side panel's editor, or to this tab through the bridge). Only the
   editor holding the lease acts on it: it inserts the in-text citation at the
   cursor as a src:'cite' op and adds the full entry to the document's sources
   (kept outside the op-logged text, so it never counts as typed words). */

// The Sources side panel slides in to the right of the page (on = force open
// or closed). The side panel embed has no room for it: its list is under the page.
function writerToggleSources(on) {
  if (writerWorksMode() === 'off') return;
  const canvas = $('dxCanvas'), side = $('wrSide');
  if (!canvas || !side) { $('wrSources')?.scrollIntoView({ block: 'start', behavior: 'smooth' }); return; }
  WR.sideOpen = on === undefined ? !WR.sideOpen : !!on;
  canvas.classList.toggle('dx-side-on', WR.sideOpen);
  side.toggleAttribute('inert', !WR.sideOpen);
  $('wrSideBtn')?.setAttribute('aria-expanded', String(WR.sideOpen));
  writerSetPref(`visor-side:${WR.data.assignment.id}`, WR.sideOpen ? '1' : '0');
  if (WR.sideOpen) setTimeout(() => $('wrSideTitle')?.focus({ preventScroll: true }), 260);
  else if (side.contains(document.activeElement)) $('wrSideBtn')?.focus({ preventScroll: true });
  // Fit zoom re-fits once the panel has finished sliding
  if (WR.zoomSetting === 'fit') setTimeout(() => writerApplyZoom(true), 320);
  writerSyncBarHeight();
}

/* ---- the Instructions dropdown, under the toolbar ----
   Open before a session starts (and whenever the student opens it), folded
   away while they write unless they keep it open. Their choice is kept per
   assignment on this device. */
function writerInstrOpen() {
  if (WR.instrChoice != null) return WR.instrChoice;
  const saved = writerPref(`visor-instr:${WR.data.assignment.id}`, null);
  if (saved != null) return saved === '1';
  return !wsActive() && !['submitted'].includes(WR.doc?.status);
}
function writerRenderInstructions() {
  const el = $('wrInstr'); if (!el || !WR.data) return;
  const a = WR.data.assignment, w = a.writing || {};
  // The time limit with the student's extra time, as "How this assignment works" says it
  const mult = Number(WR.data.multiplier) > 1 ? Number(WR.data.multiplier) : 1;
  const sum = [a.dueAt ? vcDue(a.dueAt) : '', w.mode === 'locked' ? 'Locked session' : 'Open session', w.timeLimitMin ? `${Math.round(w.timeLimitMin * mult)} minutes${mult > 1 ? ' with your extra time' : ''}` : 'no time limit'].filter(Boolean).join(' · ');
  el.innerHTML = `<button type="button" class="wr-instr-head" aria-expanded="false" aria-controls="wrInstrBody" onclick="writerToggleInstructions()">
      <span class="wr-instr-chev" aria-hidden="true">${PI.down}</span><span class="wr-instr-t">Instructions</span><span class="wr-instr-sum">${esc(sum)}</span></button>
    <div class="wr-instr-body" id="wrInstrBody" role="region" aria-label="Instructions"><div class="wr-instr-inner"><div class="wr-instr-pad">
      ${a.instructions ? `<div class="wr-instr-text">${esc(a.instructions).replace(/\n/g, '<br>')}</div>` : '<div class="wr-instr-text muted">Your teacher didn’t write instructions for this one.</div>'}
      <div class="wr-instr-rules"><span class="wr-instr-k">How this assignment works</span>${esc(WR.data.describe)}</div>
    </div></div></div>`;
  writerSyncInstructions();
}
function writerSyncInstructions() {
  const el = $('wrInstr'); if (!el) return;
  const open = writerInstrOpen();
  WR.instrShown = open;
  el.classList.toggle('open', open);
  el.querySelector('.wr-instr-head')?.setAttribute('aria-expanded', String(open));
  el.querySelector('.wr-instr-body')?.toggleAttribute('inert', !open);
  $('wrInstrBtn')?.setAttribute('aria-expanded', String(open));
}
// open: true from Help → Assignment instructions (also scrolls up to them)
function writerToggleInstructions(open) {
  if (!$('wrInstr')) { if (open === true && WR.data) writerInstructionsDialog(); return; }
  WR.instrChoice = open === true ? true : !writerInstrOpen();
  writerSetPref(`visor-instr:${WR.data.assignment.id}`, WR.instrChoice ? '1' : '0');
  writerSyncInstructions();
  if (WR.instrChoice) window.scrollTo({ top: 0, behavior: 'smooth' });
}

// The extension's side panel has no room for the dropdown: the same text in a dialog
function writerInstructionsDialog() {
  const a = WR.data.assignment;
  openModal({ title: 'Instructions', sub: esc(a.title), body: `${a.instructions ? `<div class="wr-instr-text">${esc(a.instructions).replace(/\n/g, '<br>')}</div>` : '<div class="wr-instr-text muted">Your teacher didn’t write instructions for this one.</div>'}
    <div class="wr-instr-rules"><span class="wr-instr-k">How this assignment works</span>${esc(WR.data.describe)}</div>`,
    footer: '<button class="btn btn-primary" onclick="closeModal()">Done</button>' });
}

// Insert text at the cursor as a citation op, even if the editor is locked
// because the student is on the research page right now.
function writerInsertCite(text) {
  const q = WR.quill;
  const len = q.getLength() - 1;
  const at = Math.min((WR.lastRange?.index ?? len), len);
  // The character before the caret, pictures included (one EMBED each)
  const before = at > 0 ? WR_DF.deltaText(q.getContents(at - 1, 1).ops) : '';
  const insert = (before && !/\s/.test(before) ? ' ' : '') + text;
  const was = q.isEnabled();
  if (!was) q.enable(true);
  WR.pendingSrc = { src: 'cite', it: 'none', once: true };
  try { writerHistoryStep({ src: 'cite' }, () => q.insertText(at, insert, 'user')); } finally { WR.pendingSrc = null; if (!was) q.enable(false); }
  WR.lastRange = { index: at + insert.length, length: 0 };
  try { q.setSelection(WR.lastRange.index, 0, 'silent'); } catch {}
}

async function writerCite(meta) {
  if (!WR.data || !meta) return;
  if (WR.data.assignment.writing.oneClickCite === false || writerWorksMode() === 'off') return; // turned off for this assignment
  if (WR.embed && document.hidden) return; // another copy of the side panel is the one on screen
  if (!wsActive()) { toast('Start a writing session to add citations.', 'err'); return; }
  if (!isLeaseHolder()) return; // the other editor (tab or side panel) takes it
  if (WR.session.pause?.reason === 'teacher') { toast('Your teacher paused the session.', 'err'); return; }
  try {
    const r = await wapi(`/api/write/${WR.doc.id}/sources`, { method: 'POST', body: { source: meta, via: 'extension' } });
    WR.doc.sources = r.sources;
    writerInsertCite(r.source.inText);
    writerRenderSources(); writerUpdateCounts();
    const g = window.VisorSourceGrade ? VisorSourceGrade.grade(r.source) : null;
    toast(`${r.existing ? 'Cited again' : 'Cited'}: ${r.source.title}${g ? ` · Reliability ${g.letter} (${g.word})` : ''}`, g && g.letter === 'D' ? 'warn' : '');
    if (r.source.check?.length && !r.existing) setTimeout(() => toast(`Check: ${r.source.check.join(', ')}. Fix it under Sources.`, 'err'), 2600);
  } catch (e) { toast(e.message, 'err'); }
}

// The extension closed research mode because the side panel was closed: this
// tab is in front again, and offers full screen
window.addEventListener('message', e => {
  const m = e.data;
  if (!m || m.source !== 'visor-ext' || m.type !== 'PANEL_CLOSED' || m.replyTo) return;
  if (e.source !== window || e.origin !== location.origin || WR.embed || !WR.doc || m.docId !== WR.doc.id) return;
  WR.panelClosed = true; WR.lastLock = undefined;
  writerApplyLock();
  toast('The side panel was closed. Go back to full screen to keep writing.', 'warn');
});
// ...and opened again, with the writing still in it
window.addEventListener('message', e => {
  const m = e.data;
  if (!m || m.source !== 'visor-ext' || m.type !== 'PANEL_OPENED' || m.replyTo) return;
  if (e.source !== window || e.origin !== location.origin || WR.embed || !WR.doc || m.docId !== WR.doc.id) return;
  WR.panelClosed = false;
  if (WR.extInfo?.session) WR.extInfo.session.panelOpen = true;
  WR.lastLock = undefined;
  writerApplyLock();
});

// Messages carrying a citation: the bridge in this tab, or the side panel around the embed
window.addEventListener('message', e => {
  const m = e.data;
  if (!m || m.source !== 'visor-ext' || m.type !== 'CITE' || m.replyTo) return;
  const fromBridge = e.source === window && e.origin === location.origin;
  const fromPanel = WR.embed && e.source === window.parent && e.origin === WR.embedOrigin;
  if (fromBridge || fromPanel) writerCite(m.meta);
});

// Re-cite a source already in the list (Insert → Citation, or the toolbar)
function writerCiteSource(id) {
  const s = (WR.doc?.sources || []).find(x => x.id === id);
  if (!s || !WR.quill) return false;
  if (!wsActive() || !isLeaseHolder()) { toast('Start a writing session to add citations.', 'err'); return false; }
  writerInsertCite(s.inText);
  WR.quill.focus();
  return true;
}
function writerInsertCitationMenu() {
  const list = WR.doc?.sources || [];
  const w = WR.data.assignment.writing;
  if (writerWorksMode() === 'off') return;
  if (!list.length) return toast(w.oneClickCite === false ? 'No sources yet. Add one by hand under Sources.' : 'No sources yet. Use the Visor extension’s “Cite this page” on a page you’re using.');
  if (!wsActive() || !isLeaseHolder()) return toast('Start a writing session to add citations.', 'err');
  openModal({ title: 'Insert a citation', sub: 'Adds the in-text citation where your cursor is.', body: `<div class="stack">${list.map(s => `<button class="choice cite-pick" data-id="${esc(s.id)}"><div class="t">${esc(s.inText)}</div><div class="d">${esc(s.title || s.url || (s.written || '').replace(/\*([^*]+)\*/g, '$1'))}</div></button>`).join('')}</div>`, footer: `<button class="btn btn-ghost" onclick="closeModal()">Cancel</button>` });
  document.querySelectorAll('.cite-pick').forEach(b => b.onclick = () => { closeModal(); writerCiteSource(b.dataset.id); });
}

/* ---- reliability grades (source-grade.js) ----
   Each source's grade, A to D, as a chip next to it in the Sources panel and
   on the Works Cited page; the chip opens what the grade is based on. The
   source dialog shows it as the student fills the details in. review.js
   shows the same chips to the teacher. */
const SOURCE_GRADE_HOW = 'Visor grades a source by the kind of site it’s on and whether it names an author and a date. It doesn’t read the page or check its facts, so the grade is a place to start: you still decide whether to trust it.';
function sourceGradeChip(src, onclick) {
  const g = window.VisorSourceGrade ? VisorSourceGrade.grade(src) : null;
  if (!g) return `<span class="src-grade g-none" title="Visor grades a source from its link, its DOI or its publisher.">Not graded</span>`;
  return `<button type="button" class="src-grade g-${g.letter}" onclick="${onclick}" title="${esc(`${g.label}. What this grade is based on`)}" aria-label="${esc(`Reliability ${g.letter}, ${g.word}. What this grade is based on`)}"><b>${g.letter}</b>${esc(g.word)}</button>`;
}
function sourceGradeDetails(g) {
  const cls = { 1: 'up', '-1': 'down', 0: 'info' };
  return `<div class="grade-head"><span class="grade-letter g-${g.letter}" aria-hidden="true">${g.letter}</span><div><div class="grade-word">Reliability ${g.letter}: ${esc(g.word)}</div><div class="small muted">${esc(g.label)}${g.host ? ` · ${esc(g.host)}` : ''}</div></div></div>
    <p class="grade-why">${esc(g.why)}</p>
    ${g.notes.length ? `<ul class="grade-notes">${g.notes.map(n => `<li class="n-${cls[n.effect]}">${esc(n.text)}</li>`).join('')}</ul>` : ''}`;
}
function showSourceGrade(src) {
  const g = src && window.VisorSourceGrade ? VisorSourceGrade.grade(src) : null;
  if (!g) return;
  openModal({ title: 'Reliability grade', sub: esc(src.title || g.host || ''), body: `${sourceGradeDetails(g)}<p class="tiny muted grade-how">${SOURCE_GRADE_HOW}</p>`, footer: '<button class="btn btn-primary" onclick="closeModal()">Done</button>' });
}
function writerGradeInfo(id) { showSourceGrade((WR.doc?.sources || []).find(x => x.id === id)); }

// The sources: the Works Cited page under the essay ('page'; in the side panel
// embed, a list there for 'panel' too) and the Sources side panel
function writerRenderSources() {
  if (!WR.data) return;
  const works = writerWorksMode();
  if (works === 'off') return;
  const style = WR.data.assignment.writing.citationStyle;
  const bib = VisorCiteFormat.bibliography(WR.doc?.sources || [], style);
  const editable = WR.doc.status !== 'submitted' && !(WR.doc.status === 'returned' && !WR.doc.reopened);
  const styleName = esc({ mla: 'MLA', apa: 'APA', chicago: 'Chicago' }[style] || 'MLA');
  const check = i => i.source.check?.length ? `<button class="chip-check" onclick="writerEditSource('${esc(i.source.id)}')">Check: ${esc(i.source.check.join(', '))}</button>` : '';
  const chip = i => sourceGradeChip(i.source, `writerGradeInfo('${esc(i.source.id)}')`);
  const tools = (i, withCheck = true) => `<span class="wr-bib-tools">${withCheck ? check(i) : ''}
      ${editable ? `<button class="btn-icon" aria-label="Edit this source" title="Edit" onclick="writerEditSource('${esc(i.source.id)}')">${I.edit}</button><button class="btn-icon" aria-label="Remove this source" title="Remove" onclick="writerDeleteSource('${esc(i.source.id)}')">${I.trash}</button>` : ''}</span>`;
  const empty = `${WR.data.assignment.writing.oneClickCite === false ? 'Your sources show up here' : 'Sources you add here or cite with the Visor extension show up here'}, formatted in ${styleName}.`;
  const page = $('wrSources');
  if (page) {
    const heading = works === 'page' ? bib.heading : 'Sources';
    page.innerHTML = `<section class="wr-works" aria-label="${esc(heading)}"><h2>${esc(heading)}</h2>
      ${bib.items.length ? `<ol class="wr-bib">${bib.items.map(i => `<li><span class="wr-bib-text">${i.html}</span>${tools(i, false)}<span class="wr-bib-notes">${chip(i)}${check(i)}</span></li>`).join('')}</ol>`
        : `<p class="muted small">${empty}</p>`}
      ${editable ? `<div class="wr-works-add"><button class="btn btn-ghost btn-sm" onclick="writerEditSource(null)">${I.plusSm}Add a source</button><button class="btn btn-ghost btn-sm" onclick="writerEditSource(null, 'write')">${I.edit}Write a source</button></div>` : ''}
    </section>`;
  }
  const side = $('wrSideBody');
  if (side) {
    const canCite = wsActive() && isLeaseHolder();
    side.innerHTML = `<p class="dx-side-note">${works === 'page' ? `These make the ${esc(bib.heading)} page after your essay. <button class="linklike" onclick="$('wrSources')?.scrollIntoView({ block: 'start', behavior: 'smooth' })">Go to it</button>` : 'Your teacher asked for your sources here, not as a page in the essay.'}</p>
      ${bib.items.length ? `<ol class="dx-side-list">${bib.items.map(i => `<li class="dx-src">
        <div class="dx-src-text">${i.html}</div>
        ${check(i) ? `<div class="dx-src-check">${check(i)}</div>` : ''}
        <div class="dx-src-row">${chip(i)}<span class="dx-src-in">${esc(i.source.inText || '')}</span>
          ${editable && canCite ? `<button class="btn btn-ghost btn-sm" onclick="writerCiteSource('${esc(i.source.id)}')" title="Add ${esc(i.source.inText || 'the citation')} where your cursor is">Cite</button>` : ''}${tools(i, false)}</div></li>`).join('')}</ol>`
        : `<div class="dx-side-empty">${empty}</div>`}
      ${editable ? `<div class="dx-side-adds"><button class="btn btn-primary btn-sm" onclick="writerEditSource(null)">${I.plusSm}Add a source</button><button class="btn btn-ghost btn-sm" onclick="writerEditSource(null, 'write')">${I.edit}Write a source</button></div>
        <p class="dx-side-hint">Add one from a link, a DOI or an ISBN (Visor fills in what it can find), or write or paste it yourself.</p>` : ''}`;
  }
  const hc = $('wrSrcCount'); if (hc) hc.textContent = bib.items.length ? String(bib.items.length) : '';
  writerScheduleUi();
}

/* ---- the source dialog ----
   Three ways to add a source, as in Docs' citation tool:
     From a link   a link, a DOI or an ISBN: Visor fills in what it can find
                   (server: POST …/sources/lookup), then the details tab opens
                   with the rest to check
     Details       the fields, with a live preview of the citation
     Write         the whole citation pasted or typed, as the student wants it
   tab: 'link' | 'details' | 'write' (a new source starts on the link). */
const WR_SRC_FIELDS = ['title', 'authors', 'siteName', 'publisher', 'published', 'type', 'url', 'journal', 'doi', 'volume', 'issue', 'pages'];
function writerEditSource(id, tab) {
  const s = id ? (WR.doc.sources || []).find(x => x.id === id) : { type: 'webpage', authors: [] };
  if (!s) return;
  const style = WR.data.assignment.writing.citationStyle || 'mla';
  const styleName = { mla: 'MLA', apa: 'APA', chicago: 'Chicago' }[style] || 'MLA';
  const written = s.type === 'written';
  WR.srcTab = tab || (written ? 'write' : id ? 'details' : 'link');
  const f = (k, label, ph = '') => `<div class="field"><label for="se-${k}">${label}</label><input id="se-${k}" class="input" value="${esc(written ? '' : s[k] || '')}" placeholder="${esc(ph)}" /></div>`;
  const tabBtn = (k, label) => `<button type="button" role="tab" id="seTab-${k}" data-tab="${k}" aria-controls="sePane-${k}" aria-selected="false" tabindex="-1">${label}</button>`;
  openModal({ title: id ? 'Edit source' : 'Add a source', sub: `Formatted in ${styleName}.`, wide: true, body: `
    <div class="seg src-tabs" role="tablist" aria-label="How to add it">${id ? '' : tabBtn('link', 'From a link')}${tabBtn('details', 'Fill in the details')}${tabBtn('write', 'Write it yourself')}</div>
    <div class="src-pane" id="sePane-link" data-pane="link" role="tabpanel" aria-labelledby="seTab-link">
      <div class="field"><label for="seQuery">Link, DOI or ISBN</label>
        <div class="src-find"><input id="seQuery" class="input" placeholder="https://… · 10.1000/xyz123 · 978-0-…" autocomplete="off" /><button type="button" class="btn btn-primary" id="seFind">Find</button></div>
        <div class="hint">Visor reads the page (or looks the DOI or ISBN up) and fills in what it can find. You check it and add anything it missed.</div></div>
    </div>
    <div class="src-pane" id="sePane-details" data-pane="details" role="tabpanel" aria-labelledby="seTab-details">
      <div id="seFound" class="src-found hidden" role="status"></div>
      ${f('title', 'Title')}
      <div class="field"><label for="se-authors">Authors <span class="label-note">one per line</span></label><textarea id="se-authors" class="input" style="min-height:70px;">${esc(written ? '' : (s.authors || []).join('\n'))}</textarea></div>
      <div class="input-row">${f('siteName', 'Website or publication')}${f('publisher', 'Publisher', 'if different')}</div>
      <div class="input-row">${f('published', 'Date published', 'YYYY-MM-DD')}
        <div class="field"><label for="se-type">Kind</label><select id="se-type" class="input">${['webpage', 'article', 'journal', 'video', 'book'].map(t => `<option value="${t}" ${s.type === t ? 'selected' : ''}>${{ webpage: 'Web page', article: 'Article', journal: 'Journal article', video: 'Video', book: 'Book' }[t]}</option>`).join('')}</select></div></div>
      ${f('url', 'Link', 'https://…')}
      <div class="input-row">${f('journal', 'Journal')}${f('doi', 'DOI')}</div>
      <div class="input-row">${f('volume', 'Volume')}${f('issue', 'Issue')}</div>
      ${f('pages', 'Pages', 'e.g. 45-67')}
    </div>
    <div class="src-pane" id="sePane-write" data-pane="write" role="tabpanel" aria-labelledby="seTab-write">
      <div class="field"><label for="se-written">The citation</label><textarea id="se-written" class="input" style="min-height:96px;" maxlength="1500" placeholder="Paste a citation, or type it in ${styleName} style. Put a title in *asterisks* to make it italic.">${esc(written ? s.written || '' : '')}</textarea></div>
      <div class="field"><label for="se-inTextWritten">In-text citation <span class="label-note">optional</span></label><input id="se-inTextWritten" class="input" maxlength="120" value="${esc(written ? s.inTextWritten || '' : '')}" placeholder="${style === 'apa' ? '(Smith, 2021)' : '(Smith 12)'}" /><div class="hint">What goes in your essay when you cite it. Left empty, Visor makes one from the first word.</div></div>
    </div>
    <div class="src-preview" aria-live="polite"><div class="src-preview-k">Preview</div><div id="sePreview" class="src-preview-t"></div><div id="sePreviewIn" class="src-preview-in"></div>
      <div id="seGrade" class="src-preview-grade"></div></div>
    <div id="seErr" class="form-error hidden"></div>`,
    footer: `<button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-primary" id="seSave">${id ? 'Save' : 'Add source'}</button>` });
  const body = $('modalBody');
  const show = k => {
    WR.srcTab = k;
    body.querySelectorAll('.src-tabs [data-tab]').forEach(b => { const on = b.dataset.tab === k; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; b.classList.toggle('on', on); });
    body.querySelectorAll('.src-pane').forEach(p => p.classList.toggle('on', p.dataset.pane === k));
    body.querySelector('.src-preview').classList.toggle('hidden', k === 'link');
    $('seSave').disabled = k === 'link';
    writerSourcePreview();
    setTimeout(() => (k === 'link' ? $('seQuery') : k === 'write' ? $('se-written') : $('se-title'))?.focus(), 30);
  };
  const tabs = [...body.querySelectorAll('.src-tabs [data-tab]')];
  tabs.forEach(b => b.addEventListener('click', () => show(b.dataset.tab)));
  // Left and right move between the tabs, as tabs do
  body.querySelector('.src-tabs').addEventListener('keydown', e => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const i = tabs.findIndex(b => b.dataset.tab === WR.srcTab);
    const n = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    show(tabs[n].dataset.tab); tabs[n].focus();
  });
  body.addEventListener('input', e => { e.target.classList?.remove('needs'); formError('seErr', ''); writerSourcePreview(); });
  body.addEventListener('change', writerSourcePreview);
  $('seFind').onclick = () => writerLookupSource();
  $('seQuery').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); writerLookupSource(); } });
  $('seSave').onclick = () => modalBusy(() => writerSaveSource(id));
  show(WR.srcTab);
}
// What the dialog would save, from the tab that's open
function writerSourceForm() {
  const v = k => $(`se-${k}`)?.value || '';
  if (WR.srcTab === 'write') return { type: 'written', written: v('written'), inTextWritten: v('inTextWritten') };
  return { title: v('title'), authors: v('authors').split('\n').map(x => x.trim()).filter(Boolean), siteName: v('siteName'), publisher: v('publisher'), published: v('published'), type: v('type'), url: v('url'), journal: v('journal'), doi: v('doi'), volume: v('volume'), issue: v('issue'), pages: v('pages') };
}
function writerSourcePreview() {
  const out = $('sePreview'); if (!out || WR.srcTab === 'link') return;
  const src = writerSourceForm();
  const empty = src.type === 'written' ? !src.written.trim() : !src.title.trim() && !src.url.trim();
  writerGradePreview(empty ? null : src);
  if (empty) { out.innerHTML = '<span class="muted">The citation shows up here as you fill it in.</span>'; $('sePreviewIn').textContent = ''; return; }
  try {
    const f = VisorCiteFormat.format(src, WR.data.assignment.writing.citationStyle || 'mla');
    out.innerHTML = f.html;
    $('sePreviewIn').textContent = f.inText ? `In your essay: ${f.inText}` : '';
  } catch { out.textContent = ''; }
}
// The grade of what the dialog would save, as it changes
function writerGradePreview(src) {
  const el = $('seGrade'); if (!el) return;
  const g = src && window.VisorSourceGrade ? VisorSourceGrade.grade(src) : null;
  el.innerHTML = g ? `${sourceGradeDetails(g)}<p class="tiny muted grade-how">${SOURCE_GRADE_HOW}</p>`
    : src ? `<p class="small muted">Not graded yet. Add a link, a DOI or a publisher and Visor gives the source a reliability grade.</p>` : '';
}

// From a link: ask the server, fill the details, and say what's missing
async function writerLookupSource() {
  const q = $('seQuery')?.value.trim();
  if (!q) { formError('seErr', 'Paste a link, a DOI or an ISBN.'); return; }
  const btn = $('seFind');
  if (btn.disabled) return; // already looking (Enter pressed again)
  const body = $('modalBody');
  btn.disabled = true; btn.innerHTML = '<span class="spinner spinner-sm"></span> Finding…';
  formError('seErr', '');
  // Only the dialog that asked, still open and still on this tab, takes the answer
  const same = () => body.isConnected && $('modalBody') === body && WR.srcTab === 'link';
  try {
    const r = await wapi(`/api/write/${WR.doc.id}/sources/lookup`, { method: 'POST', body: { query: q } });
    if (!same()) return;
    const src = r.source || {};
    for (const k of WR_SRC_FIELDS) {
      const el = $(`se-${k}`); if (!el) continue;
      const val = k === 'authors' ? (src.authors || []).join('\n') : k === 'url' ? src.canonicalUrl || src.url || '' : src[k] || '';
      if (k === 'type') { if (val) el.value = val; } else el.value = val;
    }
    const names = { title: 'the title', authors: 'the author', published: 'the date', siteName: 'the website', publisher: 'the publisher', journal: 'the journal' };
    const missing = (r.missing || []).map(k => names[k] || k);
    const box = $('seFound');
    box.classList.remove('hidden');
    box.classList.toggle('warn', missing.length > 0);
    box.innerHTML = missing.length ? `${I.alert}<span>Found it. Visor couldn’t find ${missing.join(', ').replace(/, ([^,]*)$/, ' or $1')}: fill ${missing.length > 1 ? 'them' : 'it'} in if you can.</span>`
      : `${I.check}<span>Found it. Check the details, then add the source.</span>`;
    for (const k of r.missing || []) $(`se-${k}`)?.classList.add('needs');
    WR.srcTab = 'details';
    body.querySelector('.src-tabs [data-tab="details"]').click();
  } catch (e) { if (same()) formError('seErr', e.message); }
  finally { if (btn.isConnected) { btn.disabled = false; btn.textContent = 'Find'; } }
}
async function writerSaveSource(id) {
  const source = writerSourceForm();
  if (source.type === 'written' && !source.written.trim()) { formError('seErr', 'Write or paste the citation.'); return; }
  try {
    const r = id ? await wapi(`/api/write/${WR.doc.id}/sources/${id}`, { method: 'PATCH', body: { source } }) : await wapi(`/api/write/${WR.doc.id}/sources`, { method: 'POST', body: { source } });
    WR.doc.sources = r.sources; closeModal(); writerRenderSources(); writerUpdateCounts();
    if (!id) toast(r.existing ? 'You already have that source.' : wsActive() && isLeaseHolder() ? 'Added. Click Cite next to it to cite it where your cursor is.' : 'Added.');
  } catch (e) { formError('seErr', e.message); }
}
async function writerDeleteSource(id) {
  if (!await confirmModal('Remove this source?', 'In-text citations already in your essay stay; remove them yourself if you need to.', { okLabel: 'Remove', danger: true })) return;
  try { const r = await wapi(`/api/write/${WR.doc.id}/sources/${id}`, { method: 'DELETE' }); WR.doc.sources = r.sources; writerRenderSources(); writerUpdateCounts(); }
  catch (e) { toast(e.message, 'err'); }
}
