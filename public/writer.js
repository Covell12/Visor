/* Visor Writer — the student editor (/write/:assignmentId).
   Built on Quill 2 (vendored in /vendor/quill). Every user edit becomes ops
   (insert / delete / format) labelled with where it came from (typed,
   pasted, dropped, autocorrected, undo…). Ops queue here and go to the server
   every 1.5 s; the server applies them to its own copy of the text and
   refuses anything that doesn't line up, and the editor then reloads the
   server's text ("Re-synced with the server").

   The session around the editor (start, beats, focus, timer) is
   writer-session.js. The side panel loads this same page with ?embed=panel. */

'use strict';

const WR_FLUSH_MS = 1500;
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

/* ====================== the page ====================== */
VisorRouter.add('/write/:id', async (el, { id }, query) => {
  Object.assign(WR, { assignmentId: id, embed: query.get('embed') === 'panel', events: [], offline: null, offlinePause: null, queue: [], seq: 0, confirmedText: '', copied: new Set(), copiedHashes: new Set(), hashWaits: [], pendingSrc: null, lastBeforeInput: null, composing: false, saving: false, lastLock: undefined, banner: null, data: null, session: null, token: null, lease: null });
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
  WR.doc = WR.data.doc; WR.session = WR.data.session; WR.token = WR.data.token; WR.lease = WR.doc.lease;
  WR.serverOffset = Date.parse(WR.data.serverNow) - Date.now();
  writerRender(el);
  wsInstall();
  if (window.VisorExt && !WR.embed) VisorExt.ping().then(p => { wsNoteExt(p); writerRefresh(); wsRearmExtension(p); });
  if (wsActive()) { writerCheckStoredQueue(); wsBeat(); }
  else writerCheckStoredQueue();
  return () => {
    wsUninstall(); writerFlush({ unload: true });
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    document.body.classList.remove('writing', 'embed');
    // A citation arriving after leaving the editor must not land in it
    WR.data = null; WR.quill = null; WR.token = null;
  };
});

async function writerFetch() {
  return wapi(`/api/write/${WR.assignmentId}${WR.embed ? '?surf=panel' : ''}`);
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

function writerRender(el) {
  const { assignment: a, class: cls } = WR.data;
  el.innerHTML = `<div class="wr ${WR.embed ? 'wr-embed' : ''}">
    <header class="wr-bar">
      <div class="wr-title">${WR.embed ? '' : `<a class="wr-back" href="/a/${a.id}" data-link aria-label="Back to the assignment">←</a>`}<div><div class="wr-h">${esc(a.title)}</div>${WR.embed ? '' : `<div class="tiny muted">${esc(cls.name)}</div>`}</div></div>
      <div class="wr-status" id="wrStatus" aria-live="polite"></div>
      <div class="wr-actions" id="wrActions"></div>
    </header>
    <div id="wrBanner" class="wr-banner-slot"></div>
    <div class="wr-body">
      <div id="wrIntro"></div>
      <div class="wr-paper-wrap">
        <div class="wr-toolbar" id="wrToolbar" role="toolbar" aria-label="Formatting">
          <span class="ql-formats">
            <button class="ql-bold" aria-label="Bold"></button><button class="ql-italic" aria-label="Italic"></button><button class="ql-underline" aria-label="Underline"></button>
          </span>
          <span class="ql-formats">
            <select class="ql-header" aria-label="Text style"><option value="1">Heading 1</option><option value="2">Heading 2</option><option value="3">Heading 3</option><option selected>Normal</option></select>
          </span>
          <span class="ql-formats">
            <button class="ql-list" value="bullet" aria-label="Bulleted list"></button><button class="ql-list" value="ordered" aria-label="Numbered list"></button>
          </span>
          <span class="ql-formats">
            <button class="ql-undo" aria-label="Undo" title="Undo"><svg viewBox="0 0 18 18"><path class="ql-stroke" d="M5 7h6a4 4 0 0 1 0 8H8"/><path class="ql-stroke" d="M7 4 4 7l3 3"/></svg></button>
            <button class="ql-redo" aria-label="Redo" title="Redo"><svg viewBox="0 0 18 18"><path class="ql-stroke" d="M13 7H7a4 4 0 0 0 0 8h3"/><path class="ql-stroke" d="m11 4 3 3-3 3"/></svg></button>
          </span>
          <span class="wr-tb-spacer"></span>
          <span class="wr-wc" id="wrWords" aria-live="off">0 words</span>
          <button type="button" class="wr-tb-btn" id="wrSourcesBtn" onclick="writerToggleSources()">Sources (0)</button>
          <button type="button" class="wr-tb-btn" id="wrCiteBtn" onclick="writerInsertCitationMenu()">Insert citation</button>
          <button type="button" class="wr-tb-btn" id="wrSerifBtn" onclick="writerToggleSerif()" aria-pressed="false" title="Switch between serif and sans-serif text">Aa</button>
        </div>
        <div class="wr-paper" id="wrPaper">
          <div id="wrEditor"></div>
          <div id="wrOverlay" class="wr-overlay hidden"></div>
        </div>
        <div id="wrSources"></div>
      </div>
    </div>
  </div>`;
  writerSetupQuill();
  try { if (localStorage.getItem('visor-serif') === '1') writerToggleSerif(true); } catch {}
  writerLoadServerText(WR.doc, { force: true });
  writerRefresh();
}

/* ====================== Quill and op capture ====================== */
function writerSetupQuill() {
  const quill = new Quill('#wrEditor', {
    theme: 'snow',
    formats: ['bold', 'italic', 'underline', 'header', 'list'],   // no images or embeds in v1
    placeholder: 'Start writing…',
    modules: {
      toolbar: { container: '#wrToolbar', handlers: { undo: () => writerHistory('undo'), redo: () => writerHistory('redo') } },
      history: { delay: 800, maxStack: 500, userOnly: true }
    }
  });
  WR.quill = quill;
  const root = quill.root;
  root.setAttribute('autocomplete', 'off'); root.setAttribute('autocorrect', 'off'); root.setAttribute('autocapitalize', 'off');
  root.setAttribute('spellcheck', 'true');
  root.setAttribute('aria-label', 'Your essay');

  // Undo/redo from the keyboard go through the history module too
  const hist = quill.getModule('history');
  for (const kind of ['undo', 'redo']) {
    const orig = hist[kind].bind(hist);
    hist[kind] = () => { WR.pendingSrc = { src: kind, it: kind === 'undo' ? 'historyUndo' : 'historyRedo', once: true }; try { orig(); } finally { WR.pendingSrc = null; } };
  }

  root.addEventListener('beforeinput', e => { WR.lastBeforeInput = { type: e.inputType, at: performance.now() }; });
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

  // Copy and cut inside the editor: remember what was copied, so pasting it
  // back counts as moving text within the essay.
  const remember = () => {
    const r = quill.getSelection(); if (!r || !r.length) return;
    const t = normalizeWs(quill.getText(r.index, r.length));
    if (!t) return;
    WR.copied.add(t); sha256Hex(t).then(h => WR.copiedHashes.add(h));
  };
  root.addEventListener('copy', remember);
  root.addEventListener('cut', remember);

  // Pastes: check the assignment's paste setting first (capture phase, before Quill's own handler)
  root.addEventListener('paste', e => writerOnPaste(e), true);
  root.addEventListener('dragstart', () => { WR.dragInternal = true; });
  root.addEventListener('dragend', () => { WR.dragInternal = false; });
  root.addEventListener('drop', e => writerOnDrop(e), true);
  root.addEventListener('contextmenu', e => { if (WR.data.assignment.writing.mode === 'locked' && wsActive()) e.preventDefault(); });

  quill.on('selection-change', range => { if (range) WR.lastRange = range; });
  quill.on('text-change', (delta, old, source) => {
    if (source !== 'user') return;
    writerCapture(delta);
  });
  root.addEventListener('focus', () => { writerRefresh(); wsBeat(); });
}

// Paste policy (Section 6.2): block cancels; internal-only allows only text
// from this same essay. Blocked attempts are logged as session events.
function writerOnPaste(e) {
  if (lockReason()) { e.preventDefault(); e.stopImmediatePropagation(); return; }
  const text = e.clipboardData?.getData('text/plain') || '';
  const norm = normalizeWs(text);
  const internal = !!norm && (WR.copied.has(norm) || normalizeWs(WR.quill.getText()).includes(norm));
  const policy = WR.data.assignment.writing.allowPaste;
  if (policy === 'block' || (policy === 'internal-only' && !internal)) {
    e.preventDefault(); e.stopImmediatePropagation();
    toast('Pasting is turned off for this assignment', 'err');
    sha256Hex(norm).then(hash => wsNoteEvent('paste-blocked', { len: text.length, hash }));
    return;
  }
  const paste = { hash: null, len: text.length, internal };
  WR.hashWaits.push(sha256Hex(norm).then(h => { paste.hash = h; if (WR.copiedHashes.has(h)) paste.internal = true; }));
  WR.pendingSrc = { src: 'paste', it: 'insertFromPaste', paste, until: performance.now() + 150 };
}

// Dragging text in from outside the editor is a paste by another name
function writerOnDrop(e) {
  if (WR.dragInternal) { WR.pendingSrc = { src: 'other', it: 'insertFromDrop', until: performance.now() + 300, internalMove: true }; return; }
  const w = WR.data.assignment.writing;
  if (lockReason() || w.mode === 'locked' || w.allowPaste !== 'allow') {
    e.preventDefault(); e.stopImmediatePropagation();
    if (!lockReason()) {
      toast('Dropping text in is turned off for this assignment', 'err');
      const t = e.dataTransfer?.getData('text/plain') || '';
      sha256Hex(normalizeWs(t)).then(hash => wsNoteEvent('paste-blocked', { len: t.length, hash, detail: 'drop' }));
    }
    return;
  }
  const text = e.dataTransfer?.getData('text/plain') || '';
  const paste = { hash: null, len: text.length, internal: false };
  WR.hashWaits.push(sha256Hex(normalizeWs(text)).then(h => { paste.hash = h; }));
  WR.pendingSrc = { src: 'drop', it: 'insertFromDrop', paste, until: performance.now() + 300 };
}

// Where this edit came from
function writerSourceFor(delta) {
  const p = WR.pendingSrc;
  if (p && (p.once || (p.until && performance.now() <= p.until))) { if (!p.once) WR.pendingSrc = null; return p; }
  WR.pendingSrc = null;
  const b = WR.lastBeforeInput;
  if (b && performance.now() - b.at <= 50) return { src: srcForInputType(b.type, WR.composing) || 'other', it: b.type };
  if (WR.composing) return { src: 'ime', it: 'none' };
  const inserted = delta.ops.reduce((n, o) => n + (typeof o.insert === 'string' ? o.insert.length : 0), 0);
  // No beforeinput: Quill's own keys (Enter, Backspace, formatting) or text a
  // browser extension injected. More than one character with no input event
  // is the second kind.
  if (inserted > 1) return { src: 'other', it: 'none' };
  return { src: 'type', it: 'none' };
}

// Quill delta -> Visor ops
function writerCapture(delta) {
  const from = writerSourceFor(delta);
  const t = Date.now();
  const ops = [];
  let index = 0;
  const coalesce = from.src === 'paste' || from.src === 'drop';
  let pasteOp = null;
  for (const o of delta.ops) {
    if (o.retain != null) {
      if (typeof o.retain === 'number') {
        if (o.attributes) ops.push({ k: 'f', at: index, len: o.retain, attrs: o.attributes, t, src: from.src === 'undo' || from.src === 'redo' ? from.src : 'type', it: from.it });
        index += o.retain;
      }
    } else if (o.insert != null) {
      if (typeof o.insert !== 'string') continue; // embeds aren't allowed
      if (coalesce && pasteOp && pasteOp.at + pasteOp.s.length === index) {
        // one paste, one insert op; formatting inside it becomes format ops
        pasteOp.s += o.insert;
      } else {
        const op = { k: 'i', at: index, s: o.insert, t, src: from.src, it: from.it };
        if (coalesce) { op.paste = from.paste || { hash: null, len: o.insert.length, internal: false }; pasteOp = op; }
        else if (o.attributes) op.attrs = o.attributes;
        ops.push(op);
      }
      if (coalesce && o.attributes) ops.push({ k: 'f', at: index, len: o.insert.length, attrs: o.attributes, t, src: from.src, it: from.it, _after: pasteOp });
      index += o.insert.length;
    } else if (o.delete != null) {
      ops.push({ k: 'd', at: index, len: o.delete, t, src: from.src === 'replace' || from.src === 'undo' || from.src === 'redo' || from.src === 'paste' || from.src === 'ime' ? from.src : 'type', it: from.it });
    }
  }
  // Format ops for a coalesced paste go after the insert they format
  const fmts = ops.filter(o => o._after), rest = ops.filter(o => !o._after);
  fmts.forEach(f => delete f._after);
  WR.queue.push(...rest, ...fmts);
  writerPersistQueue();
  writerSetSaved('unsaved');
  writerUpdateCounts();
}

function writerHistory(kind) {
  if (lockReason()) return;
  WR.quill.getModule('history')[kind]();
}

/* ====================== sending ops ====================== */
let flushing = null, retryDelay = 2000, retryTimer = null;
async function writerFlush({ unload = false, final = false } = {}) {
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
        let text = WR.confirmedText;
        for (const op of batch) text = applyTextOp(text, op);
        const textHash = await sha256Hex(text);
        const r = await wapi(`/api/write/${WR.doc.id}/ops`, { method: 'POST', body: { baseSeq: WR.seq, ops: batch, textHash, surfaceId: WR.surfaceId } });
        WR.queue.splice(0, batch.length);
        WR.seq = r.seq; WR.confirmedText = text;
        writerPersistQueue();
        if (r.pastes?.some(p => p.origin)) WR.knownOrigins = (WR.knownOrigins || 0) + r.pastes.filter(p => p.origin).length;
      }
      retryDelay = 2000;
      if (WR.offline) wsBackOnline();
      writerSetSaved('saved');
    } catch (e) {
      if (e.network) { wsGoOffline(); writerSetSaved('offline'); writerRetrySoon(); }
      else if (e.status === 409 && e.data?.ended) { writerSetSaved('saved'); await wsSessionEnded(e.data); }
      else if (e.status === 409 && e.data && 'text' in e.data) writerResync(e.data, e.data.notLeaseHolder);
      else if (e.status === 423) { writerSetSaved('unsaved'); writerRetrySoon(); }
      else if (e.status === 401) wsLost(e.message);
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
  const body = JSON.stringify({ baseSeq: WR.seq, ops: WR.queue.slice(0, 500), surfaceId: WR.surfaceId, _session: WR.token });
  try {
    fetch(`/api/write/${WR.doc.id}/ops`, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json', 'X-Visor-Session': WR.token }, body }).catch(() => {});
  } catch {
    try { navigator.sendBeacon(`/api/write/${WR.doc.id}/ops`, new Blob([body], { type: 'application/json' })); } catch {}
  }
}

// The server's text differs from ours: take the server's
function writerResync(data, notLeaseHolder) {
  WR.queue = [];
  writerPersistQueue();
  writerLoadServerText(data, { force: true });
  if (notLeaseHolder) WR.lease = data.lease || WR.lease;
  else { wsNoteEvent('resync'); toast('Re-synced with the server'); }
  writerSetSaved('saved');
  writerRefresh();
}

// Show the server's text (and formatting) without recording it as an edit
function writerLoadServerText(doc, { force = false } = {}) {
  if (!WR.quill || !doc || doc.text == null) return;
  if (!force && WR.queue.length) return;
  const Delta = Quill.import('delta');
  let d = new Delta().insert(doc.text + '\n');
  for (const r of doc.formats || []) d = d.compose(new Delta().retain(r.at).retain(r.len, r.attrs));
  const sel = WR.quill.getSelection();
  WR.quill.setContents(d, 'silent');
  if (sel && WR.quill.hasFocus()) WR.quill.setSelection(Math.min(sel.index, WR.quill.getLength() - 1), 0, 'silent');
  WR.confirmedText = doc.text; WR.seq = doc.seq;
  if (force) { WR.queue = []; WR.quill.getModule('history').clear(); }
  writerUpdateCounts();
}

/* ---- ops kept on this device (offline, or a reload before they were sent) ---- */
const queueKey = () => `visor-wq:${WR.doc?.id}`;
function writerPersistQueue() {
  try {
    if (!WR.queue.length) localStorage.removeItem(queueKey());
    else localStorage.setItem(queueKey(), JSON.stringify({ sessionId: WR.session?.id, baseSeq: WR.seq, ops: WR.queue, savedAt: Date.now() }));
  } catch {}
}
function writerClearStoredQueue() { try { localStorage.removeItem(queueKey()); } catch {} }
// After a reload: offer to send writing that never reached the server, but
// only if the document hasn't changed since (otherwise it can't be placed).
function writerCheckStoredQueue() {
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem(queueKey()) || 'null'); } catch {}
  if (!stored?.ops?.length || WR.queue.length) return;
  if (stored.baseSeq !== WR.doc.seq) {
    writerClearStoredQueue();
    writerBanner(`Some writing saved on this device on ${vcDateTime(new Date(stored.savedAt).toISOString())} couldn’t be sent, because the document changed after it. It was discarded.`, 'warn');
    return;
  }
  if (!wsActive() || !isLeaseHolder()) {
    writerBanner(`You have writing saved on this device that hasn’t been sent yet. Start a session to send it.`, 'info');
    return;
  }
  openModal({ title: 'Send unsent writing?', sub: `Saved on this device ${timeAgo(new Date(stored.savedAt).toISOString())}.`, body: `<p style="margin:0;">${stored.ops.length} edit${stored.ops.length === 1 ? '' : 's'} didn’t reach Visor before the page closed. Send ${stored.ops.length === 1 ? 'it' : 'them'} now?</p>`,
    footer: `<button class="btn btn-ghost" onclick="writerClearStoredQueue();closeModal();toast('Discarded')">Discard</button><button class="btn btn-primary" onclick="writerSendStored()">Send</button>` });
}
async function writerSendStored() {
  closeModal();
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem(queueKey()) || 'null'); } catch {}
  if (!stored || stored.baseSeq !== WR.seq) { writerClearStoredQueue(); return toast('The document changed, so that writing couldn’t be sent.', 'err'); }
  // Send it like any other edits, then show the server's text
  WR.queue = stored.ops;
  await writerFlush();
  const fresh = await writerFetch().catch(() => null);
  if (fresh) writerLoadServerText(fresh.doc, { force: true });
  toast('Sent');
}

/* ====================== UI state ====================== */
function writerWordCount() { const t = WR.quill ? WR.quill.getText() : WR.doc?.text || ''; return t.trim() ? t.trim().split(/\s+/).length : 0; }
function writerUpdateCounts() {
  const el = $('wrWords'); if (el) el.textContent = vcPlural(writerWordCount(), 'word');
  const n = (WR.doc?.sources || []).length;
  const sb = $('wrSourcesBtn'); if (sb) sb.textContent = `Sources (${n})`;
}
function writerSetSaved(state) {
  WR.saveState = state;
  const el = $('wrSaved'); if (!el) return;
  el.className = `wr-saved ${state}`;
  el.textContent = { saved: 'Saved', saving: 'Saving…', unsaved: 'Saving…', offline: 'Offline: saved on this device' }[state] || '';
}
function writerBanner(text, kind = 'info') {
  const el = $('wrBanner'); if (!el) return;
  el.innerHTML = `<div class="wr-banner ${kind}" role="${kind === 'warn' || kind === 'teacher' ? 'alert' : 'status'}"><span>${esc(text)}</span><button class="btn-icon" aria-label="Dismiss" onclick="this.parentElement.remove()">${I.x}</button></div>`;
}
function writerToggleSerif(force) {
  const on = force === true ? true : !$('wrPaper').classList.contains('serif');
  $('wrPaper').classList.toggle('serif', on);
  $('wrSerifBtn')?.setAttribute('aria-pressed', on);
  try { localStorage.setItem('visor-serif', on ? '1' : '0'); } catch {}
}

// Re-draw everything that depends on the session state. The header and the
// start card are only rebuilt when something they show changed (beats arrive
// every 10 seconds; rebuilding each time blanked the timer and closed the
// Instructions).
function writerRefresh(force) {
  if (!WR.data || !$('wrStatus')) return;
  const a = WR.data.assignment, w = a.writing, doc = WR.doc;
  const active = wsActive();
  const status = doc.status;
  const sig = JSON.stringify([active, status, doc.submittedAt, doc.reopened, !!doc.feedback, !!WR.session, WR.session?.state === 'ended', WR.extPresent, WR.extOther, WR.extInfo?.installed, WR.extInfo?.hasHostPermission, WR.data.timeLeftMs, WR.data.windowProblem, WR.startError, WR.starting]);
  if (!force && sig === WR.refreshSig) { writerSetSaved(WR.offline ? 'offline' : WR.queue.length ? 'unsaved' : 'saved'); writerUpdateCounts(); writerApplyLock(); return; }
  WR.refreshSig = sig;
  // Status line
  const extOk = WR.extPresent;
  $('wrStatus').innerHTML = active
    ? `<span class="wr-rec"><i class="live-dot"></i>Session active</span><span class="wr-timer mono" id="wrTimer"></span><span class="wr-saved" id="wrSaved"></span>`
    : status === 'submitted' ? `<span class="pill pill-green">Submitted</span><span class="tiny muted">${esc(vcDateTime(doc.submittedAt))}</span>`
      : status === 'returned' ? `<span class="pill pill-violet">Returned</span>` : '';
  writerSetSaved(WR.offline ? 'offline' : WR.queue.length ? 'unsaved' : 'saved');
  // Actions
  const acts = [];
  if (active) {
    if (!WR.embed && extOk && window.VisorExt) acts.push(`<button class="btn btn-ghost btn-sm" onclick="VisorExt.openPanel(WR.doc.id).then(r=>{ if(!r.ok) toast(r.error||'Click the Visor icon in Chrome’s toolbar to open the side panel.','err'); })">Open side panel</button>`);
    acts.push(`<button class="btn btn-ghost btn-sm" onclick="wsEnd()">End session</button>`);
    acts.push(`<button class="btn btn-primary btn-sm" onclick="wsSubmit()">Submit</button>`);
  } else if (status !== 'submitted' && WR.session && !WR.embed) {
    acts.push(`<button class="btn btn-primary btn-sm" onclick="wsSubmit()">Submit</button>`);
  }
  $('wrActions').innerHTML = acts.join('');
  writerRenderIntro();
  writerRenderSources();
  writerUpdateCounts();
  WR.lastLock = undefined;
  writerApplyLock();
}

// The block above the paper: instructions and the Start button, the
// ended/submitted/returned notes.
function writerRenderIntro() {
  const el = $('wrIntro'); if (!el) return;
  const a = WR.data.assignment, w = a.writing, doc = WR.doc;
  if (wsActive()) {
    el.innerHTML = WR.embed || !a.instructions ? '' : `<details class="wr-instr"><summary>Instructions</summary><div>${esc(a.instructions).replace(/\n/g, '<br>')}</div></details>`;
    return;
  }
  const instr = !WR.embed && a.instructions ? `<div class="wr-instr-open">${esc(a.instructions).replace(/\n/g, '<br>')}</div>` : '';
  if (doc.status === 'submitted') { el.innerHTML = `<div class="card card-pad wr-card">${instr}<div class="wr-card-line">${I.check}<span>Submitted ${esc(vcDateTime(doc.submittedAt))}${doc.autoSubmitted ? ' (automatically, when time ran out)' : ''}. Your teacher will return it with feedback.</span></div></div>`; return; }
  const fb = doc.feedback ? `<div class="wr-feedback"><div class="kicker">Feedback from your teacher</div>${doc.feedback.score != null ? `<div class="wr-score">${esc(String(doc.feedback.score))}${doc.feedback.outOf ? ` <span class="muted">/ ${esc(String(doc.feedback.outOf))}</span>` : ''}</div>` : ''}${doc.feedback.comment ? `<div>${esc(doc.feedback.comment).replace(/\n/g, '<br>')}</div>` : ''}</div>` : '';
  if (doc.status === 'returned' && !doc.reopened) { el.innerHTML = `<div class="card card-pad wr-card">${fb || '<div>Your teacher returned this.</div>'}</div>`; return; }
  const needsExt = w.mode === 'locked' || w.requireExtension;
  const extLine = !needsExt || WR.embed ? '' : WR.extPresent
    ? `<div class="wr-ext ok">${I.check}<span>Visor extension: connected</span></div>`
    : WR.extOther ? `<div class="wr-ext missing">${I.puzzle}<span>The Visor extension in this browser is connected to ${esc(WR.extOther)}. <a href="/extension/connect" data-link>Connect it to your account</a> to start.</span></div>`
      : `<div class="wr-ext missing">${I.puzzle}<span>${WR.extInfo?.installed ? '<a href="/extension/connect" data-link>Connect the Visor extension</a> to start' : 'Install the Visor extension, then <a href="/extension/connect" data-link>connect it</a> to start'}.</span></div>`;
  const needsPerm = !WR.embed && (w.researchTracking || w.mode === 'locked') && WR.extPresent && WR.extInfo && !WR.extInfo.hasHostPermission;
  const permLine = needsPerm ? `<div class="wr-ext missing">${I.alert}<span>${w.mode === 'locked' ? 'Locked sessions need' : 'This assignment records research, which needs'} your OK for the extension to see the pages you visit during the session. <button class="btn btn-ghost btn-sm" onclick="extAllowResearch()">Allow research recording</button></span></div>` : '';
  const outOfTime = WR.data.timeLeftMs != null && WR.data.timeLeftMs <= 5000;
  const blocked = WR.data.windowProblem || (outOfTime ? 'You’ve used all of your time for this assignment.' : '') || (needsExt && !WR.extPresent && !WR.embed ? '' : '');
  const timeNote = WR.data.timeLeftMs != null && !outOfTime && WR.session ? `<div class="small muted">${vcDur(WR.data.timeLeftMs)} left of your time for this assignment.</div>` : '';
  const ended = WR.session && WR.session.state === 'ended';
  el.innerHTML = `<div class="card card-pad wr-card">
    ${fb}${ended ? '' : instr}
    <div class="wr-describe">${esc(WR.data.describe)}</div>
    ${extLine}${permLine}${timeNote}
    ${blocked ? `<div class="callout amber" style="margin-top:10px;">${esc(blocked)}</div>` : ''}
    <div id="wrStartErr" class="form-error ${WR.startError ? '' : 'hidden'}" style="margin-top:12px;">${esc(WR.startError || '')}</div>
    <div class="btn-row" style="margin-top:14px;">
      <button class="btn btn-primary btn-lg" id="wrStartBtn" onclick="wsStart()" ${blocked || WR.starting ? 'disabled' : ''}>${WR.starting ? '<span class="spinner spinner-sm"></span> Starting…' : `${I.pen}${ended ? 'Start a new session' : 'Start writing session'}`}</button>
      ${ended && !WR.embed ? `<button class="btn btn-ghost btn-lg" onclick="wsSubmit()">Submit</button>` : ''}
    </div>
    ${w.mode === 'locked' && !WR.embed ? '<div class="tiny muted" style="margin-top:8px;">The session runs in full screen. Leaving full screen or the Visor tab pauses your writing.</div>' : ''}
  </div>`;
}

const LOCK_TEXT = {
  'left-tab': ['Session paused: you left the Visor tab.', 'Writing is turned off while you’re away.'],
  'left-window': ['Session paused: you left the Visor window.', 'Writing is turned off while you’re away.'],
  'exit-fullscreen': ['Session paused: you left full screen.', 'Locked sessions run in full screen.'],
  offline: ['Offline: your writing is saved on this device.', 'Writing turns back on when the connection does.'],
  'ext-missing': ['Visor’s extension was turned off.', 'Turn it back on, then reload this page to keep writing.'],
  teacher: ['Your teacher paused the session.', 'Writing turns back on when they resume it.']
};

// Enable or lock the editor; show the paused or mirror card. Runs every
// second and on every change, and only touches the page when the reason changes.
function writerApplyLock() {
  if (!WR.quill) return;
  const reason = lockReason();
  const canWrite = reason === null;
  if (WR.quill.isEnabled() !== canWrite) WR.quill.enable(canWrite);
  $('wrPaper')?.classList.toggle('locked', !canWrite && wsActive());
  if (reason === WR.lastLock) return;
  const prev = WR.lastLock;
  WR.lastLock = reason;
  if (canWrite && prev && prev !== 'mirror' && prev !== 'not-started' && prev !== 'ended') setTimeout(() => WR.quill.focus(), 0);
  if (!canWrite && prev === null) WR.awaySince = Date.now();
  const ov = $('wrOverlay');
  if (!wsActive() || canWrite) { ov.classList.add('hidden'); ov.innerHTML = ''; return; }
  ov.classList.remove('hidden');
  if (reason === 'mirror') {
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

function writerToggleSources() { $('wrSources')?.scrollIntoView({ block: 'start', behavior: 'smooth' }); }

// Insert text at the cursor as a citation op, even if the editor is locked
// because the student is on the research page right now.
function writerInsertCite(text) {
  const q = WR.quill;
  const len = q.getLength() - 1;
  let at = Math.min((WR.lastRange?.index ?? len), len);
  const before = at > 0 ? q.getText(at - 1, 1) : '';
  const insert = (before && !/\s/.test(before) ? ' ' : '') + text;
  const was = q.isEnabled();
  if (!was) q.enable(true);
  WR.pendingSrc = { src: 'cite', it: 'none', once: true };
  try { q.insertText(at, insert, 'user'); } finally { WR.pendingSrc = null; if (!was) q.enable(false); }
  WR.lastRange = { index: at + insert.length, length: 0 };
  try { q.setSelection(WR.lastRange.index, 0, 'silent'); } catch {}
}

async function writerCite(meta) {
  if (!WR.data || !meta) return;
  if (!wsActive()) { toast('Start a writing session to add citations.', 'err'); return; }
  if (!isLeaseHolder()) return; // the other editor (tab or side panel) takes it
  if (WR.session.pause?.reason === 'teacher') { toast('Your teacher paused the session.', 'err'); return; }
  try {
    const r = await wapi(`/api/write/${WR.doc.id}/sources`, { method: 'POST', body: { source: meta } });
    WR.doc.sources = r.sources;
    writerInsertCite(r.source.inText);
    writerRenderSources(); writerUpdateCounts();
    toast(r.existing ? `Cited again: ${r.source.title}` : `Cited: ${r.source.title}`);
    if (r.source.check?.length && !r.existing) setTimeout(() => toast(`Check: ${r.source.check.join(', ')}. Add it in Sources below.`, 'err'), 2600);
  } catch (e) { toast(e.message, 'err'); }
}

// Messages carrying a citation: the bridge in this tab, or the side panel around the embed
window.addEventListener('message', e => {
  const m = e.data;
  if (!m || m.source !== 'visor-ext' || m.type !== 'CITE' || m.replyTo) return;
  const fromBridge = e.source === window && e.origin === location.origin;
  const fromPanel = WR.embed && e.source === window.parent && e.origin === WR.embedOrigin;
  if (fromBridge || fromPanel) writerCite(m.meta);
});

// Toolbar: re-cite a source already in the list
function writerInsertCitationMenu() {
  const list = WR.doc?.sources || [];
  if (!list.length) return toast('No sources yet. Use the Visor extension’s “Cite this page” on a page you’re using.');
  if (!wsActive() || !isLeaseHolder()) return toast('Start a writing session to add citations.', 'err');
  openModal({ title: 'Insert a citation', sub: 'Adds the in-text citation where your cursor is.', body: `<div class="stack">${list.map(s => `<button class="choice cite-pick" data-id="${esc(s.id)}"><div class="t">${esc(s.inText)}</div><div class="d">${esc(s.title || s.url)}</div></button>`).join('')}</div>`, footer: `<button class="btn btn-ghost" onclick="closeModal()">Cancel</button>` });
  document.querySelectorAll('.cite-pick').forEach(b => b.onclick = () => {
    const s = list.find(x => x.id === b.dataset.id);
    closeModal();
    writerInsertCite(s.inText);
    WR.quill.focus();
  });
}

// Works Cited / References / Bibliography under the essay
function writerRenderSources() {
  const el = $('wrSources'); if (!el || !WR.data) return;
  const style = WR.data.assignment.writing.citationStyle;
  const bib = VisorCiteFormat.bibliography(WR.doc?.sources || [], style);
  const editable = WR.doc.status !== 'submitted' && !(WR.doc.status === 'returned' && !WR.doc.reopened);
  el.innerHTML = `<section class="wr-works" aria-label="${esc(bib.heading)}"><h2>${esc(bib.heading)}</h2>
    ${bib.items.length ? `<ol class="wr-bib">${bib.items.map(i => `<li><span class="wr-bib-text">${i.html}</span>
      <span class="wr-bib-tools">${i.source.check?.length ? `<button class="chip-check" onclick="writerEditSource('${esc(i.source.id)}')">Check: ${esc(i.source.check.join(', '))}</button>` : ''}
      ${editable ? `<button class="btn-icon" aria-label="Edit this source" onclick="writerEditSource('${esc(i.source.id)}')">${I.edit}</button><button class="btn-icon" aria-label="Remove this source" onclick="writerDeleteSource('${esc(i.source.id)}')">${I.trash}</button>` : ''}</span></li>`).join('')}</ol>`
      : `<p class="muted small">Sources you cite with the Visor extension show up here, formatted in ${esc({ mla: 'MLA', apa: 'APA', chicago: 'Chicago' }[style])}. ${editable ? `<button class="linklike" onclick="writerEditSource(null)">Add one by hand</button>` : ''}</p>`}
    ${bib.items.length && editable ? `<button class="btn btn-ghost btn-sm" onclick="writerEditSource(null)">${I.plusSm}Add a source by hand</button>` : ''}
  </section>`;
}

function writerEditSource(id) {
  const s = id ? (WR.doc.sources || []).find(x => x.id === id) : { type: 'webpage', authors: [] };
  if (!s) return;
  const f = (k, label, ph = '') => `<div class="field"><label for="se-${k}">${label}</label><input id="se-${k}" class="input" value="${esc(s[k] || '')}" placeholder="${esc(ph)}" /></div>`;
  openModal({ title: id ? 'Edit source' : 'Add a source', sub: 'Fix anything the page didn’t say, like the author or the date.', wide: true, body: `
    ${f('title', 'Title')}
    <div class="field"><label for="se-authors">Authors <span class="label-note">one per line</span></label><textarea id="se-authors" class="input" style="min-height:70px;">${esc((s.authors || []).join('\n'))}</textarea></div>
    <div class="input-row">${f('siteName', 'Website or publication')}${f('publisher', 'Publisher', 'if different')}</div>
    <div class="input-row">${f('published', 'Date published', 'YYYY-MM-DD')}
      <div class="field"><label for="se-type">Kind</label><select id="se-type" class="input">${['webpage', 'article', 'journal', 'video', 'book'].map(t => `<option value="${t}" ${s.type === t ? 'selected' : ''}>${{ webpage: 'Web page', article: 'Article', journal: 'Journal article', video: 'Video', book: 'Book' }[t]}</option>`).join('')}</select></div></div>
    ${f('url', 'Link', 'https://…')}
    <div class="input-row">${f('journal', 'Journal')}${f('doi', 'DOI')}</div>
    <div class="input-row">${f('volume', 'Volume')}${f('issue', 'Issue')}</div>
    ${f('pages', 'Pages', 'e.g. 45-67')}
    <div id="seErr" class="form-error hidden"></div>`,
    footer: `<button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="writerSaveSource(${id ? `'${esc(id)}'` : 'null'})">Save</button>` });
}
async function writerSaveSource(id) {
  const v = k => $(`se-${k}`).value;
  const source = { title: v('title'), authors: v('authors').split('\n').map(x => x.trim()).filter(Boolean), siteName: v('siteName'), publisher: v('publisher'), published: v('published'), type: v('type'), url: v('url'), journal: v('journal'), doi: v('doi'), volume: v('volume'), issue: v('issue'), pages: v('pages') };
  try {
    const r = id ? await wapi(`/api/write/${WR.doc.id}/sources/${id}`, { method: 'PATCH', body: { source } }) : await wapi(`/api/write/${WR.doc.id}/sources`, { method: 'POST', body: { source } });
    WR.doc.sources = r.sources; closeModal(); writerRenderSources(); writerUpdateCounts();
    if (!id && wsActive() && isLeaseHolder()) toast('Added. Use “Insert citation” to cite it in your essay.');
  } catch (e) { formError('seErr', e.message); }
}
async function writerDeleteSource(id) {
  if (!await confirmModal('Remove this source?', 'In-text citations already in your essay stay; remove them yourself if you need to.', { okLabel: 'Remove', danger: true })) return;
  try { const r = await wapi(`/api/write/${WR.doc.id}/sources/${id}`, { method: 'DELETE' }); WR.doc.sources = r.sources; writerRenderSources(); writerUpdateCounts(); }
  catch (e) { toast(e.message, 'err'); }
}
