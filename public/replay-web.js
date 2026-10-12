/* Visor Classroom — replay of a student document (review page, Replay tab).
   A port of the extension's Live replay (extension/replay.js and replay.css)
   to Visor's own op log: the essay is rebuilt op by op on the same page the
   student wrote on (a read-only Quill in the assignment's document style, with
   formats, tables and pictures). Each character is marked with where it came
   from (the "srccat" format, as in Color by source); new text glows in its
   source's colour, pastes flash, deletions drift into "Removed as you watch".
   Under the scrubber: session boundaries and pauses on the bar, research
   ticks below it (hover for the search or page).

   The model is { text, formats, tags }: the stored text, its formatting runs
   (moved with the shared run operations in doc-format.js, exactly as the
   server does) and a tag per character saying which op wrote it.
   - Seeking: keyframes every 250 ops, built once when the replay opens (in
     slices of about 10 ms, so a long essay never holds up the page), so a
     jump replays at most 290 ops on the model (from a keyframe at least 40
     ops back, for "Removed as you watch"), then redraws the page once.
   - Playing: each animation frame turns its ops into ONE composed delta for
     Quill (updateContents, silent), so 64× on a long essay stays smooth. A
     frame with too many ops redraws the page instead, like a seek. */

'use strict';

const RP_SPEEDS = [1, 4, 16, 64];
const RP_IDLE_MS = 10000;      // gaps longer than this are skipped (toggle)
const RP_IDLE_SHOWN = 600;     // …and shown as this long
const RP_KEY_EVERY = 250;
const RP_FRESH_MS = 650;       // new text keeps its highlight this long (real time)
const RP_FRAME_OPS = 400;      // more ops than this in one frame: redraw the page instead
const RP_COMPACT_RUNS = 400;   // tidy the formatting runs past this many, as the server does
const RP_SLICE_MS = 10;        // the keyframes are built in slices this long
const RP_DRAW_NOW = 20000;     // an essay longer than this (in characters) opens a part at a time
const RP_LEGEND = { typed: 'typed', 'pasted-research': 'pasted (copied during session)', 'pasted-outside': 'pasted (outside Visor’s view)', 'pasted-internal': 'moved within the essay', cited: 'citation', template: 'starter text', other: 'no keyboard or paste event', image: 'image' };
let rp = null;
let rpMounts = 0;

// The same categories as lib/process.js categoryOf. kinds: the report's kind
// for each paste (by op number), which knows copies matched after the paste.
function rpCategory(op, kinds) {
  if (op.src === 'template') return 'template';
  if (op.src === 'cite') return 'cited';
  if (op.src === 'image') return 'image';
  if (op.src === 'paste' || op.src === 'drop') {
    const k = kinds && kinds[op.n];
    if (k) return k === 'internal' ? 'pasted-internal' : k === 'research' ? 'pasted-research' : 'pasted-outside';
    return op.paste?.internal ? 'pasted-internal' : op.paste?.origin ? 'pasted-research' : 'pasted-outside';
  }
  if (op.src === 'other') return 'other';
  return 'typed';   // type, ime, replace, autocorrect, undo, redo, structure…
}

const rpClamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.floor(Number(v)) || 0));
const rpPlain = s => String(s).replace(/\uFFFC/g, '[image]');
const rpDelta = ops => new (Quill.import('delta'))(ops);

async function mountReplay(el, { docId, sessions, research, docStyle, imageToken, pasteKinds } = {}) {
  const mount = ++rpMounts;
  if (rp) rpHalt(rp);
  const stale = () => mount !== rpMounts || !el.isConnected;
  el.innerHTML = `<div class="loading-row"><span class="spinner"></span></div>`;
  const ops = [];
  try {
    for (let from = 1; ;) {
      const r = await api(`/api/write/${docId}/ops?from=${from}`);
      if (stale()) return () => {};
      for (const op of r.ops || []) ops.push(op);
      if (!r.nextFrom) break;
      from = r.nextFrom;
    }
  } catch (e) {
    if (!stale()) el.innerHTML = `<div class="card card-pad muted">The replay couldn’t load. ${esc(e.message || '')}</div>`;
    return () => {};
  }
  if (stale()) return () => {};
  const st = rp = {
    el, ops, sessions: sessions || [], research: research || [], i: 0, playing: false, speed: 4, skipIdle: true, vclock: 0, last: 0,
    cats: ops.map(op => (op.k === 'i' ? rpCategory(op, pasteKinds) : null)),
    model: rpEmpty(), ghosts: [], ghostTop: undefined, ghostCount: 0, keys: [], fresh: [], caretAt: null,
    imageSrc: id => (id ? `/api/images/${id}${imageToken ? `?t=${encodeURIComponent(imageToken)}` : ''}` : VisorDocFormat.TRANSPARENT_GIF)
  };
  rpBuildClock();
  // The keyframes: a typical essay is built in the first slice and opens
  // straight away. A long one carries on in the background, then is drawn a
  // part at a time, while "Preparing the replay" shows.
  rpBuildStart(st);
  const openNow = rpBuildSome(st, ops.length, performance.now() + RP_SLICE_MS) && st.b.len <= RP_DRAW_NOW;
  const busy = openNow ? '' : 'disabled';
  el.innerHTML = `<div class="rp${openNow ? '' : ' rp-busy'}">
    <div class="rp-stage">
      <div id="rpPaper" class="rp-paper"><div id="rpPrep" class="rp-prep" role="status"><span class="spinner"></span><span>Preparing the replay… <span id="rpPrepPct"></span></span></div><div class="rp-page rv-doc ${VisorDocFormat.styleClass(docStyle)}"><div id="rpQuill" aria-live="off"></div></div></div>
      <aside class="rp-ghosts" aria-label="Removed as you watch"><div class="rp-ghosts-head">Removed as you watch</div><div id="rpGhosts" class="rp-ghosts-body"></div></aside>
    </div>
    <div class="rp-transport">
      <button id="rpPlay" class="rp-play" aria-label="Play" onclick="rpToggle()" ${busy}>${I.play}</button>
      <button id="rpStart" class="rp-mini" onclick="rpSeek(0)" title="Back to the start" aria-label="Back to the start" ${busy}>↺</button>
      <div class="rp-scrub-wrap">
        <div id="rpScrub" class="rp-scrub" role="slider" tabindex="${openNow ? 0 : -1}" aria-label="Position in the writing" aria-valuemin="0" aria-valuemax="${ops.length}" aria-valuenow="0" ${openNow ? '' : 'aria-disabled="true"'}>
          <div id="rpBands" class="rp-bands"></div><div id="rpFill" class="rp-fill"></div><div id="rpKnob" class="rp-knob"></div>
        </div>
        <div id="rpTicks" class="rp-ticks"></div>
      </div>
      <div class="rp-speeds" role="group" aria-label="Speed">${RP_SPEEDS.map(s => `<button data-s="${s}" aria-pressed="${s === st.speed}" onclick="rpSpeed(${s})">${s}×</button>`).join('')}</div>
      <label class="rp-skip"><input type="checkbox" ${st.skipIdle ? 'checked' : ''} onchange="rpSkip(this.checked)" /> Skip pauses over 10 s</label>
    </div>
    <div class="rp-meta"><span id="rpWhen" class="mono"></span><span id="rpCount" class="mono"></span>
      <span class="rp-legend">${Object.entries(RP_LEGEND).map(([k, l]) => `<span class="src-key src-${k}"><i></i>${esc(l)}</span>`).join('')}</span></div>
  </div>`;
  VisorDocFormat.registerQuill(Quill);
  st.quill = new Quill(el.querySelector('#rpQuill'), { theme: 'snow', readOnly: true, formats: VisorDocFormat.QUILL_FORMATS.concat(['srccat', 'rpfresh']), modules: { toolbar: false } });
  st.paper = el.querySelector('#rpPaper');
  st.caretEl = document.createElement('span');
  st.caretEl.className = 'rp-cursor';
  st.caretEl.hidden = true;
  st.caretEl.setAttribute('aria-hidden', 'true');
  st.quill.container.appendChild(st.caretEl);
  rpDrawMarks();
  const scrub = el.querySelector('#rpScrub');
  // Dragging seeks at most once a frame (each seek redraws the page)
  let wantX = null;
  const seekAt = x => {
    wantX = x;
    if (st.seekRaf || !st.ready) return;
    st.seekRaf = requestAnimationFrame(() => {
      st.seekRaf = 0;
      if (rp !== st) return;
      const r = scrub.getBoundingClientRect();
      rpSeekV(Math.max(0, Math.min(1, (wantX - r.left) / Math.max(1, r.width))) * st.vTotal);
    });
  };
  scrub.addEventListener('pointerdown', e => { seekAt(e.clientX); const mv = ev => seekAt(ev.clientX); window.addEventListener('pointermove', mv); window.addEventListener('pointerup', () => window.removeEventListener('pointermove', mv), { once: true }); });
  scrub.addEventListener('keydown', e => {
    if (!st.ready) return;
    const step = Math.max(1, Math.round(st.ops.length / 50));
    if (e.key === 'ArrowRight') { e.preventDefault(); rpSeek(Math.min(st.ops.length, st.i + step)); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); rpSeek(Math.max(0, st.i - step)); }
    if (e.key === ' ') { e.preventDefault(); rpToggle(); }
  });
  if (openNow) rpReady(st);
  else { rpProgress(st, 0); rpYield(() => rpBuildLoop(st)); }
  return () => rpHalt(st);
}

// A long essay: the rest of the keyframes a slice at a time, then the
// finished essay, drawn a part at a time. Each step is a task of its own.
const rpAlive = st => !st.dead && rp === st && st.el.isConnected;
function rpBuildLoop(st) {
  if (st.dead || rp !== st) return;
  if (!st.el.isConnected) { rpHalt(st); return; }
  const built = rpBuildSome(st, st.ops.length, performance.now() + RP_SLICE_MS);
  rpProgress(st, 0);
  if (built) rpYield(() => { if (rpAlive(st)) rpReady(st); });
  else rpYield(() => rpBuildLoop(st));
}
// "Preparing the replay… n%": building the keyframes is the first half, drawing the essay the second
function rpProgress(st, drawn) {
  const pct = $('rpPrepPct');
  if (pct) pct.textContent = `${Math.floor(50 * (st.bi / Math.max(1, st.ops.length) + drawn))}%`;
}
// Every keyframe is in: the replay opens on the finished essay
function rpReady(st) {
  rpSeekModel(st, st.ops.length);
  if (st.model.text.length <= RP_DRAW_NOW) { rpRedraw(st); rpOpen(st); }
  else rpYield(() => rpDrawInParts(st, () => rpOpen(st)));
}
// …and then the controls work
function rpOpen(st) {
  st.ready = true;
  st.el.querySelector('.rp')?.classList.remove('rp-busy');
  for (const id of ['rpPlay', 'rpStart']) { const b = $(id); if (b) b.disabled = false; }
  const scrub = $('rpScrub');
  if (scrub) { scrub.tabIndex = 0; scrub.removeAttribute('aria-disabled'); }
  rpPaint(st);
}

// Run f in a task of its own soon, so the page can paint and respond in
// between (a message, not setTimeout, which waits at least 4 ms once nested)
const rpYield = (() => {
  if (typeof MessageChannel !== 'function') return f => setTimeout(f, 0);
  const ch = new MessageChannel(), queue = [];
  ch.port1.onmessage = () => { const f = queue.shift(); if (f) f(); };
  return f => { queue.push(f); ch.port2.postMessage(0); };
})();

// Stop one replay for good (its tab closed, or another replay opened)
function rpHalt(st) {
  st.dead = true;
  st.playing = false;
  if (st.raf) cancelAnimationFrame(st.raf);
  if (st.seekRaf) cancelAnimationFrame(st.seekRaf);
  clearTimeout(st.freshTimer);
  if (rp === st) rp = null;
}

// Virtual playback time for each op: real gaps, with long idle gaps squeezed
function rpBuildClock() {
  rp.v = new Array(rp.ops.length);
  let v = 0;
  for (let i = 0; i < rp.ops.length; i++) {
    const gap = i ? Math.max(0, rp.ops[i].t - rp.ops[i - 1].t) : 0;
    v += rp.skipIdle && gap > RP_IDLE_MS ? RP_IDLE_SHOWN : Math.min(gap || 0, 6 * 3600e3);
    rp.v[i] = v;
  }
  rp.vTotal = Math.max(1, v);
}

/* ---------- the model ---------- */

const rpEmpty = () => ({ text: '', formats: [], tags: [], compacted: 0 });

/* ---------- keyframes ----------
   Keyframes every 250 ops: the text, its formatting runs and where each
   character came from, as [{c, len}] runs of one category. The formatting
   runs are never changed in place (doc-format.js), so a keyframe can share
   them. A huge essay (keyframes holding over 10 million characters in all)
   spaces the rest out, so they stay within about 20 million.

   The builder has a model of its own, so a long, much-revised essay (tens of
   thousands of ops) takes a fraction of a second, not seconds:
   - the sources are kept as category runs, changed in place (a per-character
     array would move the whole essay along on every typed character);
   - typing (inserts one after another, with the same formats) is gathered
     and goes into the text and the formatting runs in one go, when another
     kind of op or a keyframe comes. Gathered inserts give the same text and
     the same formatting as one at a time, in fewer runs.
   It runs in slices (rpBuildSome), and a seek past what's built builds up
   to its target first. */
const RP_KEY_CHARS = 20e6;

function rpBuildStart(st) {
  st.b = { text: '', len: 0, formats: [], compacted: 0, runs: rpRunsNew(), pend: null, pendAt: 0, pendAttrs: null };
  st.keys = [{ i: 0, text: '', formats: [], tags: [], compacted: 0 }];
  st.bi = 0;            // ops applied so far
  st.every = RP_KEY_EVERY; st.stored = 0; st.since = 0;
  st.endGhosts = [];    // what the last 40 ops took out, for opening on the finished essay
  st.ready = false;
}

// Apply ops until `upto` of them are in or the deadline passes. True once
// every op is in.
function rpBuildSome(st, upto, deadline) {
  const n = st.ops.length;
  upto = Math.min(upto, n);
  while (st.bi < upto) {
    rpBuildOp(st.b, st.ops[st.bi], st.cats[st.bi], st.bi >= n - 40 ? st.endGhosts : null);
    st.bi++;
    if (++st.since >= st.every) {
      st.since = 0;
      rpBuildKey(st);
      if (st.stored > RP_KEY_CHARS / 2) {
        const allowed = Math.max(1, Math.floor((RP_KEY_CHARS - st.stored) / Math.max(1, st.b.len)));
        st.every = Math.max(RP_KEY_EVERY, Math.ceil((n - st.bi) / allowed));
      }
    }
    if ((st.bi & 127) === 0 && performance.now() >= deadline) break;
  }
  return st.bi >= n;
}
function rpBuildKey(st) {
  const b = st.b;
  rpBuildFlush(b);
  st.keys.push({ i: st.bi, text: b.text, formats: b.formats, tags: b.runs.list.map(r => ({ c: r.c, len: r.len })), compacted: b.compacted });
  st.stored += b.text.length;
}

// One op on the builder's model: what rpApply does, with the sources as runs
// and typing gathered (b.len counts the gathered text too)
function rpBuildOp(b, op, cat, ghosts) {
  const DF = VisorDocFormat;
  const L = b.len;
  if (op.k === 'i') {
    const s = typeof op.s === 'string' ? op.s : '';
    if (!s) return;
    const at = rpClamp(op.at, 0, L), attrs = op.attrs || null;
    if (b.pend !== null && at === b.pendAt + b.pend.length && DF.sameAttrs(attrs, b.pendAttrs)) b.pend += s;
    else { rpBuildFlush(b); b.pend = s; b.pendAt = at; b.pendAttrs = attrs; }
    b.len += s.length;
    rpRunsInsert(b.runs, at, s.length, cat || 'typed');
    return;
  }
  if (op.k === 'd') {
    const at = rpClamp(op.at, 0, L), len = rpClamp(op.len, 0, L - at);
    if (!len) return;
    if (ghosts) { rpBuildFlush(b); rpGhost(ghosts, b.text.slice(at, at + len), op.t); }
    rpRunsDelete(b.runs, at, len);
    b.len -= len;
    // A typo taken back: cut from the gathered text, which isn't in yet
    if (b.pend !== null && at >= b.pendAt && at + len <= b.pendAt + b.pend.length) {
      const k = at - b.pendAt;
      b.pend = b.pend.slice(0, k) + b.pend.slice(k + len);
      if (!b.pend) b.pend = null;
      return;
    }
    rpBuildFlush(b);
    b.text = b.text.slice(0, at) + b.text.slice(at + len);
    b.formats = DF.deleteRuns(b.formats, at, len);
    rpTidy(b);
    return;
  }
  if (op.k === 'f' && op.attrs && typeof op.attrs === 'object') {
    const at = rpClamp(op.at, 0, L), len = rpClamp(op.len, 0, L + 1 - at);
    if (!len) return;
    rpBuildFlush(b);
    b.formats = DF.formatRuns(b.formats, at, len, op.attrs);
    rpTidy(b);
  }
}
// The gathered typing into the text and the formatting runs
function rpBuildFlush(b) {
  if (b.pend === null) return;
  b.text = b.text.slice(0, b.pendAt) + b.pend + b.text.slice(b.pendAt);
  b.formats = VisorDocFormat.insertRuns(b.formats, b.pendAt, b.pend.length, b.pendAttrs);
  b.pend = null;
  rpTidy(b);
}

// Category runs { list: [{c, len}], total }, with the last run looked at
// (ci) and where it starts (cs) remembered: typing mostly happens where the
// last op did, so finding the run is usually one step
const rpRunsNew = () => ({ list: [], total: 0, ci: 0, cs: 0 });
// [index, start] of the run holding position p (0 <= p < total), or of the last run when p === total
function rpRunsFind(R, p) {
  const L = R.list;
  let i = R.ci, s = R.cs;
  if (i >= L.length) { i = 0; s = 0; }
  while (i > 0 && s > p) { i--; s -= L[i].len; }
  while (i < L.length - 1 && s + L[i].len <= p) { s += L[i].len; i++; }
  R.ci = i; R.cs = s;
  return [i, s];
}
function rpRunsInsert(R, p, n, c) {
  const L = R.list;
  R.total += n;
  if (!L.length) { L.push({ c, len: n }); R.ci = 0; R.cs = 0; return; }
  const [i, s] = rpRunsFind(R, p);
  const r = L[i];
  if (p === s && i > 0 && L[i - 1].c === c) { R.ci = i - 1; R.cs = s - L[i - 1].len; L[i - 1].len += n; }
  else if (r.c === c) r.len += n;
  else if (p === s) L.splice(i, 0, { c, len: n });
  else if (p === s + r.len) L.push({ c, len: n });   // p is the end (i is the last run)
  else L.splice(i, 1, { c: r.c, len: p - s }, { c, len: n }, { c: r.c, len: s + r.len - p });
}
function rpRunsDelete(R, p, n) {
  const L = R.list;
  R.total -= n;
  const [i, s] = rpRunsFind(R, p);
  let j = i, off = p - s, left = n;
  while (left > 0 && j < L.length) {
    const take = Math.min(left, L[j].len - off);
    L[j].len -= take; left -= take; off = 0; j++;
  }
  // Runs i..j-1 were cut: drop the empty ones, then join equal neighbours
  let k = i;
  for (let x = i; x < j; x++) if (L[x].len) L[k++] = L[x];
  if (k === j) return;   // nothing emptied, so nothing to join (R.ci, R.cs still hold)
  L.splice(k, j - k);
  for (let a = Math.max(0, i - 1); a < Math.min(k, L.length - 1);) {
    if (L[a].c === L[a + 1].c) { L[a].len += L[a + 1].len; L.splice(a + 1, 1); k--; }
    else a++;
  }
  R.ci = 0; R.cs = 0;
}

// Restored text shares one tag per category: only text arriving while the
// replay plays needs its own (for the glow)
const RP_CAT_TAG = {};
const rpCatTag = c => RP_CAT_TAG[c] || (RP_CAT_TAG[c] = { c, n: 0 });
function rpUnpackTags(runs) {
  let n = 0;
  for (const r of runs) n += r.len;
  const tags = new Array(n);
  let i = 0;
  for (const r of runs) { tags.fill(rpCatTag(r.c), i, i + r.len); i += r.len; }
  return tags;
}

// n copies of tag at `at`, in pieces (spreading a huge array overflows the stack)
function rpInsertTags(tags, at, n, tag) {
  for (let i = 0; i < n; i += 4096) tags.splice(at + i, 0, ...new Array(Math.min(4096, n - i)).fill(tag));
}

// The formatting runs tidied once they pile up, as lib/writing.js does
function rpTidy(m) {
  if (m.formats.length <= Math.max(RP_COMPACT_RUNS, 2 * (m.compacted || 0))) return;
  m.formats = VisorDocFormat.compactFormats(m.formats, m.text.length);
  m.compacted = m.formats.length;
}

// Apply one op to the model, as the server did. Returns the new tag for an insert.
function rpApply(m, op, cat, ghosts) {
  const DF = VisorDocFormat;
  const L = m.text.length;
  if (op.k === 'i') {
    const s = typeof op.s === 'string' ? op.s : '';
    if (!s) return null;
    const at = rpClamp(op.at, 0, L);
    const tag = { c: cat || 'typed', n: op.n };
    m.text = m.text.slice(0, at) + s + m.text.slice(at);
    rpInsertTags(m.tags, at, s.length, tag);
    m.formats = DF.insertRuns(m.formats, at, s.length, op.attrs || null);
    rpTidy(m);
    return tag;
  }
  if (op.k === 'd') {
    const at = rpClamp(op.at, 0, L), len = rpClamp(op.len, 0, L - at);
    if (!len) return null;
    if (ghosts) rpGhost(ghosts, m.text.slice(at, at + len), op.t);
    m.text = m.text.slice(0, at) + m.text.slice(at + len);
    m.tags.splice(at, len);
    m.formats = DF.deleteRuns(m.formats, at, len);
    rpTidy(m);
    return null;
  }
  if (op.k === 'f' && op.attrs && typeof op.attrs === 'object') {
    const at = rpClamp(op.at, 0, L), len = rpClamp(op.len, 0, L + 1 - at);
    if (len) { m.formats = DF.formatRuns(m.formats, at, len, op.attrs); rpTidy(m); }
  }
  return null;
}

// Deleted text for "Removed as you watch" (newest first): 3+ characters, or a picture
function rpGhost(ghosts, gone, t) {
  if (gone.length >= 3 || gone.includes(VisorDocFormat.EMBED)) { const shown = rpPlain(gone); if (shown.trim()) ghosts.unshift({ text: shown, t }); }
}

// Where the replay's caret goes after an op
function rpCaretAfter(m, op) {
  const L = m.text.length;
  if (op.k === 'i') return rpClamp(op.at, 0, L) + (typeof op.s === 'string' ? op.s.length : 0);
  if (op.k === 'd') return rpClamp(op.at, 0, L);
  return rpClamp((op.at || 0) + (op.len || 0), 0, L);
}

/* ---------- model -> Quill ---------- */

const rpPick = (a, test) => { let out = null; for (const k in a) if (test(k)) (out || (out = {}))[k] = a[k]; return out; };
const rpEmbedKey = k => VisorDocFormat.isInlineKey(k) || (k !== 'image' && VisorDocFormat.isEmbedKey(k));

// The delta for one op, against the model BEFORE the op. It gives Quill the
// same attributes docToDelta would (inline on text, block on line breaks,
// size/alt on pictures), so composing it never makes Quill diff the document.
function rpOpDelta(st, op, cat) {
  const Delta = Quill.import('delta');
  const m = st.model, L = m.text.length;
  const a = op.attrs && typeof op.attrs === 'object' ? op.attrs : {};
  if (op.k === 'i') {
    const s = typeof op.s === 'string' ? op.s : '';
    const d = new Delta().retain(rpClamp(op.at, 0, L));
    if (!s) return d;
    const fresh = s.length >= 20 && cat !== 'typed' ? 'glow' : 'fresh';
    const text = { ...rpPick(a, VisorDocFormat.isInlineKey), srccat: cat || 'typed', rpfresh: fresh };
    const block = rpPick(a, VisorDocFormat.isBlockKey) || undefined;
    let pos = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c !== 10 && c !== 0xFFFC) continue;
      if (i > pos) d.insert(s.slice(pos, i), { ...text });
      if (c === 10) d.insert('\n', block && { ...block });
      else d.insert({ image: st.imageSrc(a.image || null) }, { ...rpPick(a, rpEmbedKey), srccat: cat || 'typed', rpfresh: fresh });
      pos = i + 1;
    }
    if (pos < s.length) d.insert(s.slice(pos), { ...text });
    return d;
  }
  if (op.k === 'd') {
    const at = rpClamp(op.at, 0, L);
    return new Delta().retain(at).delete(rpClamp(op.len, 0, L - at));
  }
  if (op.k === 'f') {
    const at = rpClamp(op.at, 0, L), end = at + rpClamp(op.len, 0, L + 1 - at);
    const d = new Delta().retain(at);
    const inline = rpPick(a, VisorDocFormat.isInlineKey) || undefined, block = rpPick(a, VisorDocFormat.isBlockKey) || undefined, embed = rpPick(a, rpEmbedKey) || undefined;
    let pos = at;
    for (let i = at; i < end; i++) {
      const c = i < L ? m.text.charCodeAt(i) : 10;   // index L is the final line break
      if (c !== 10 && c !== 0xFFFC) continue;
      if (i > pos) d.retain(i - pos, inline && { ...inline });
      const b = c === 10 ? block : embed;
      d.retain(1, b && { ...b });
      pos = i + 1;
    }
    if (end > pos) d.retain(end - pos, inline && { ...inline });
    return d;
  }
  return new Delta();
}

// Where each character came from, as retains to compose on the document
// (line breaks carry no inline class)
function rpTagDelta(text, tags) {
  const Delta = Quill.import('delta');
  const d = new Delta();
  const n = text.length;
  const cat = i => (tags[i] && tags[i].c) || 'typed';
  for (let i = 0; i < n;) {
    let j = i + 1;
    if (text.charCodeAt(i) === 10) { while (j < n && text.charCodeAt(j) === 10) j++; d.retain(j - i); }
    else { const c = cat(i); while (j < n && text.charCodeAt(j) !== 10 && cat(j) === c) j++; d.retain(j - i, { srccat: c }); }
    i = j;
  }
  return d;
}

// The whole page from the model: on open, on a seek, or after a crowded frame
const rpModelDelta = st => rpDelta(VisorDocFormat.docToDelta(st.model.text, st.model.formats, { imageSrc: st.imageSrc })).compose(rpTagDelta(st.model.text, st.model.tags));
function rpRedraw(st) {
  rpForgetFresh(st);
  st.quill.setContents(rpModelDelta(st), 'silent');
}
// The same for a long essay when the replay opens, a part at a time (whole
// lines, each part a task of its own: one setContents of a 30-page essay
// holds up the page). If Quill doesn't end up holding exactly the delta, as
// one setContents would leave it, it's redrawn in one go.
const RP_PART_CHARS = 6000;
function rpDrawInParts(st, done) {
  if (!rpAlive(st)) return;
  rpForgetFresh(st);
  const full = rpModelDelta(st);
  const parts = [];
  let part = [], n = 0, total = 0;
  for (const op of full.ops) {
    part.push(op);
    const len = typeof op.insert === 'string' ? op.insert.length : 1;
    n += len; total += len;
    if (n >= RP_PART_CHARS && typeof op.insert === 'string' && op.insert.endsWith('\n')) { parts.push(part); part = []; n = 0; }
  }
  if (part.length) parts.push(part);
  let k = 0, at = 0;
  const step = () => {
    if (!rpAlive(st)) return;
    const d = rpDelta(parts[k]);
    if (k === 0) st.quill.setContents(d, 'silent');                       // parts end with a line break,
    else st.quill.updateContents(rpDelta([]).retain(at).concat(d), 'silent');  // so each goes after the last
    at += d.length();
    rpProgress(st, at / Math.max(1, total));
    if (++k < parts.length) { rpYield(step); return; }
    if (!rpSameOps(st.quill.getContents().ops, full.ops)) rpRedraw(st);
    done();
  };
  rpYield(step);
}
// Two deltas' ops alike (attributes in any order)
function rpSameOps(a, b) {
  if (a.length !== b.length) return false;
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (!same(x.insert, y.insert) || !same(x.retain, y.retain) || x.delete !== y.delete) return false;
    const ka = Object.keys(x.attributes || {}), kb = Object.keys(y.attributes || {});
    if (ka.length !== kb.length || ka.some(key => !same(x.attributes[key], (y.attributes || {})[key]))) return false;
  }
  return true;
}

/* ---------- the "just arrived" highlight (format rpfresh) ---------- */

function rpForgetFresh(st) {
  for (const t of st.fresh) { t.until = 0; t.expired = false; }
  st.fresh = [];
  clearTimeout(st.freshTimer);
}

// [[index, length]] of characters whose highlight is due to go
function rpExpiredRanges(st, now) {
  let any = false;
  for (const t of st.fresh) if (t.until <= now) { t.expired = true; any = true; }
  if (!any) return [];
  const tags = st.model.tags, out = [];
  for (let i = 0; i < tags.length;) {
    if (!(tags[i] && tags[i].expired)) { i++; continue; }
    let j = i + 1;
    while (j < tags.length && tags[j] && tags[j].expired) j++;
    out.push([i, j - i]);
    i = j;
  }
  st.fresh = st.fresh.filter(t => { if (!t.expired) return true; t.expired = false; t.until = 0; return false; });
  return out;
}

// While paused: clear what's left of the highlight a moment later
function rpClearFreshSoon(st) {
  clearTimeout(st.freshTimer);
  if (!st.fresh.length) return;
  st.freshTimer = setTimeout(() => {
    if (st.dead || st.playing) return;
    for (const [i, n] of rpExpiredRanges(st, Infinity)) st.quill.formatText(i, n, { rpfresh: false }, 'silent');
  }, RP_FRESH_MS);
}

/* ---------- seeking and playing ---------- */

function rpSeek(target) {
  const st = rp;
  if (!st) return;
  rpSeekModel(st, target);
  rpRedraw(st);
  rpPaint(st);
}
// The model at op `target` (from the nearest keyframe), without drawing it
function rpSeekModel(st, target) {
  target = rpClamp(target, 0, st.ops.length);
  if (target > st.bi) rpBuildSome(st, target, Infinity);   // past what's built so far: build up to it first
  let m;
  if (target === st.ops.length) {
    // The finished essay is the builder's own model: nothing to replay
    const b = st.b;
    rpBuildFlush(b);
    m = { text: b.text, formats: b.formats, tags: rpUnpackTags(b.runs.list), compacted: b.compacted };
    st.ghosts = st.endGhosts.slice();
  } else {
    // From a keyframe at least 40 ops back, so "Removed as you watch" always
    // shows what the last 40 ops took out
    let k = st.keys[0];
    for (const key of st.keys) if (key.i <= target - 40) k = key;
    m = { text: k.text, formats: k.formats, tags: rpUnpackTags(k.tags), compacted: k.compacted };
    st.ghosts = [];
    for (let i = k.i; i < target; i++) rpApply(m, st.ops[i], st.cats[i], i >= target - 40 ? st.ghosts : null);
  }
  st.model = m;
  st.i = target;
  st.caretAt = target ? rpCaretAfter(m, st.ops[target - 1]) : 0;
  st.vclock = target ? st.v[target - 1] : 0;
}
function rpSeekV(v) {
  let lo = 0, hi = rp.ops.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (rp.v[mid] <= v) lo = mid + 1; else hi = mid; }
  rpSeek(lo);
}

function rpToggle() {
  const st = rp;
  if (!st || !st.ready) return;
  if (st.i >= st.ops.length) rpSeek(0);
  st.playing = !st.playing;
  $('rpPlay').innerHTML = st.playing ? I.stop : I.play;
  $('rpPlay').setAttribute('aria-label', st.playing ? 'Pause' : 'Play');
  if (st.playing) { clearTimeout(st.freshTimer); st.last = performance.now(); st.raf = requestAnimationFrame(rpFrame); }
  else { cancelAnimationFrame(st.raf); rpClearFreshSoon(st); }
}

// One animation frame: every op now due, as one composed delta
function rpFrame(now) {
  const st = rp;
  if (!st || !st.playing || st.dead) return;
  if (!st.el.isConnected) { rpHalt(st); return; }
  st.vclock += Math.max(0, now - st.last) * st.speed;
  st.last = now;
  let d = null, redraw = false, n = 0;
  const expired = rpExpiredRanges(st, now);
  if (expired.length) {
    d = rpDelta([]);
    let pos = 0;
    for (const [i, len] of expired) { d.retain(i - pos).retain(len, { rpfresh: null }); pos = i + len; }
  }
  while (st.i < st.ops.length && st.v[st.i] <= st.vclock) {
    const op = st.ops[st.i], cat = st.cats[st.i];
    if (!redraw && n >= RP_FRAME_OPS) redraw = true;
    if (!redraw) { const od = rpOpDelta(st, op, cat); d = d ? d.compose(od) : od; }
    const tag = rpApply(st.model, op, cat, st.ghosts);
    if (tag && !redraw) { tag.until = now + RP_FRESH_MS; st.fresh.push(tag); }
    st.caretAt = rpCaretAfter(st.model, op);
    st.i++; n++;
  }
  if (redraw) rpRedraw(st);
  else if (d && d.ops.length) {
    try { st.quill.updateContents(d, 'silent'); } catch (e) { rpRedraw(st); }
    // Quill and the model must agree; if not, redraw from the model
    if (st.quill.getLength() !== st.model.text.length + 1) rpRedraw(st);
  }
  if (st.ghosts.length > 30) st.ghosts.length = 30;
  rpPaint(st, n > 0);
  if (st.i >= st.ops.length) {
    st.playing = false;
    $('rpPlay').innerHTML = I.play;
    $('rpPlay').setAttribute('aria-label', 'Play');
    rpClearFreshSoon(st);
    return;
  }
  st.raf = requestAnimationFrame(rpFrame);
}
function rpSpeed(s) { if (!rp) return; rp.speed = s; rp.el.querySelectorAll('.rp-speeds button').forEach(b => b.setAttribute('aria-pressed', Number(b.dataset.s) === s)); }
function rpSkip(on) { if (!rp) return; const at = rp.i; rp.skipIdle = on; rpBuildClock(); rpDrawMarks(); if (rp.ready) rpSeek(at); }

// Everything around the page: scrubber, counters, ghosts and the caret
function rpPaint(st, follow = true) {
  if (!st.el.isConnected) return;
  // The ghosts only change when one is added (newest first) or after a seek
  const top = st.ghosts[0] || null;
  if (top !== st.ghostTop || st.ghosts.length !== st.ghostCount) {
    st.ghostTop = top; st.ghostCount = st.ghosts.length;
    $('rpGhosts').innerHTML = top ? st.ghosts.slice(0, 30).map(g => `<div class="rp-ghost">${esc(g.text.slice(0, 300))}</div>`).join('') : '<div class="tiny muted">Nothing removed nearby.</div>';
  }
  const f = st.ops.length ? (st.i ? st.v[st.i - 1] : 0) / st.vTotal : 1;
  $('rpFill').style.width = `${(f * 100).toFixed(2)}%`;
  $('rpKnob').style.left = `${(f * 100).toFixed(2)}%`;
  $('rpScrub').setAttribute('aria-valuenow', st.i);
  const op = st.ops[Math.max(0, st.i - 1)];
  $('rpWhen').textContent = op ? vcDateTime(new Date(op.t).toISOString()) : '';
  $('rpCount').textContent = `edit ${st.i.toLocaleString()} of ${st.ops.length.toLocaleString()}`;
  rpCaret(st, st.i < st.ops.length || st.playing, follow);
}

// The caret at the last edit, kept in view inside the page (not the window)
function rpCaret(st, show, follow) {
  const c = st.caretEl;
  if (!c) return;
  const b = show ? st.quill.getBounds(Math.min(st.caretAt ?? 0, st.model.text.length)) : null;
  if (!b) { c.hidden = true; return; }
  c.hidden = false;
  c.style.transform = `translate(${Math.round(b.left)}px, ${Math.round(b.top)}px)`;
  c.style.height = `${Math.max(12, Math.round(b.height))}px`;
  if (!follow) return;
  const paper = st.paper, pr = paper.getBoundingClientRect(), cr = c.getBoundingClientRect();
  if (cr.bottom > pr.bottom - 16) paper.scrollTop += cr.bottom - pr.bottom + pr.height / 3;
  else if (cr.top < pr.top + 8) paper.scrollTop -= pr.top - cr.top + pr.height / 3;
}

// Position (0–1) of a moment on the scrubber
function rpPos(t) {
  if (!rp.ops.length) return 0;
  let lo = 0, hi = rp.ops.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (rp.ops[mid].t < t) lo = mid + 1; else hi = mid; }
  return rp.v[lo] / rp.vTotal;
}
function rpDrawMarks() {
  const bands = $('rpBands'), ticks = $('rpTicks');
  if (!bands) return;
  let b = '';
  rp.sessions.forEach((s, k) => {
    const first = rp.ops.findIndex(o => o.sid === s.id);
    if (first < 0) return;
    const x = (first ? rp.v[first] : 0) / rp.vTotal;
    b += `<i class="rp-sess" style="left:${(x * 100).toFixed(2)}%" title="Session ${k + 1} starts: ${esc(vcDateTime(s.startedAt))}"></i>`;
    for (const p of s.pauses || []) {
      const a = rpPos(Date.parse(p.from)), z = rpPos(Date.parse(p.to || s.endedAt || p.from));
      b += `<i class="rp-pause" style="left:${(a * 100).toFixed(2)}%;width:${Math.max(0.4, (z - a) * 100).toFixed(2)}%" title="Paused: ${esc(REASON_TEXT[p.reason] || p.reason)}, ${vcDur((Date.parse(p.to) || Date.now()) - Date.parse(p.from))}"></i>`;
    }
  });
  bands.innerHTML = b;
  const label = e => e.type === 'search' ? `Search (${e.engine}): ${e.query}` : e.type === 'copy' ? `Copied from ${e.title || e.host}: “${e.copy?.preview || ''}”` : e.type === 'cite' ? `Cited ${e.title || e.url}` : e.type === 'ai-site' ? `AI site: ${e.host}${e.blocked ? ' (blocked)' : ''}` : e.type === 'blocked' ? `Blocked: ${e.host}` : `Opened ${e.title || e.host}`;
  ticks.innerHTML = rp.research.filter(e => ['search', 'visit', 'copy', 'cite', 'ai-site', 'blocked'].includes(e.type))
    .map(e => `<i class="rp-tick rp-tick-${e.type}" style="left:${(rpPos(e.t) * 100).toFixed(2)}%" title="${esc(label(e))} · ${esc(vcTime(new Date(e.t).toISOString()))}"></i>`).join('');
}
