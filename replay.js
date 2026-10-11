/* ============================================================================
 * Visor — Live Replay
 * ----------------------------------------------------------------------------
 * Rebuilds the document from its own operation stream, one edit at a time.
 * Nothing here is an approximation: every character appears at the position,
 * in the order, and by the author that the edit log records. Deletions are
 * shown as they happen, because the stream is the only place that text still
 * exists.
 * ==========================================================================*/

'use strict';

const $ = (id) => document.getElementById(id);

// ── State ────────────────────────────────────────────────────────────────────

let payload  = null;
let steps    = [];
let byUser   = new Map();

// ── Document model ──────────────────────────────────────────────────────────
//
// The text and its per-character author marks are held split at the most
// recent edit, like a gap buffer. An edit beside the previous one — which is
// what typing is — then costs next to nothing. The old model rebuilt the whole
// string and shifted the whole marks array on every operation, so each frame of
// playback cost O(document) several dozen times over, and jumping to a session
// deep in a long document replayed thousands of those.
let tL = '', tR = '';        // text before / after the gap
let mL = [], mR = [];        // marks before the gap, and after it in REVERSE order
let flat = '', flatDirty = false;

function docLength() { return tL.length + tR.length; }
function docText() {
  if (flatDirty) { flat = tL + tR; flatDirty = false; }
  return flat;
}
function resetDoc() { tL = ''; tR = ''; mL = []; mR = []; flat = ''; flatDirty = false; }

function moveGap(pos) {
  const p = Math.max(0, Math.min(pos, docLength()));
  if (p < tL.length) {
    tR = tL.slice(p) + tR;
    tL = tL.slice(0, p);
    while (mL.length > p) mR.push(mL.pop());
  } else if (p > tL.length) {
    const take = p - tL.length;
    tL += tR.slice(0, take);
    tR = tR.slice(take);
    while (mL.length < p && mR.length) mL.push(mR.pop());
  }
}

function docInsert(at, str, tag) {
  moveGap(at);
  tL += str;
  for (let i = 0; i < str.length; i++) mL.push(tag);   // shared tag object, no copies
  flatDirty = true;
}

/** Removes [at, at+len) and returns the text that was there. */
function docRemove(at, len) {
  // Gap to the END of the range, so deleting what was just typed — a backspace —
  // trims the left side in place without moving anything.
  moveGap(at + len);
  const gone = tL.slice(at);
  tL = tL.slice(0, at);
  mL.length = at;
  flatDirty = true;
  return gone;
}

function markAt(i) {
  return i < mL.length ? mL[i] : mR[mR.length - 1 - (i - mL.length)];
}
let cursor = -1;    // index of the last applied step

let playing  = false;
let speed    = 4;   // 0 means "as fast as frames allow"
let rafId    = null;
let lastFrame = 0;
let carry    = 0;   // virtual milliseconds owed

let colorize = true;
let pasteCut = 20;          // replaced by the document's own derived threshold
let renderedRuns = [];
let freshRange = null;   // [start, end) inserted since last paint
let pasteFlash = false;

/*
 * Pastes glow for a moment and then fade out, timed by the clock rather than
 * by replay steps: at speed the next edit arrives a few milliseconds later,
 * and a flash that lasted only until then was never seen. Each glow is a
 * document range that later edits shift, so it stays on the pasted text.
 */
const GLOW_MS = 1700;      // keep in step with the r-paste-glow animation
const GLOW_LIMIT = 12;
let glows = [];            // { a, b, t0, n }

function shiftGlows(op) {
  if (!glows.length) return;
  if (op[0] === 0) {
    const at = op[1], len = op[2].length;
    for (const g of glows) {
      if (at <= g.a) { g.a += len; g.b += len; }
      else if (at < g.b) g.b += len;
    }
  } else {
    const at = op[1], end = op[1] + op[2];
    const map = (p) => p <= at ? p : p >= end ? p - (end - at) : at;
    for (const g of glows) { g.a = map(g.a); g.b = map(g.b); }
    glows = glows.filter((g) => g.b > g.a);
  }
}

function liveGlows(now) {
  if (glows.length) glows = glows.filter((g) => now - g.t0 < GLOW_MS);
  return glows;
}

const MAX_GAP_MS = 1400;   // longest pause the replay will actually sit through
const GHOST_LIMIT = 8;   // the pane is a glance, not a log — 8 keeps it readable

// ── Boot ─────────────────────────────────────────────────────────────────────

let booted = false;

window.addEventListener('message', (e) => {
  if (!e.data) return;
  // Only the window this replay is embedded in may drive it. Page script on
  // the host document can reach a frame with postMessage, and a fabricated
  // payload would put someone else's text on screen as if it were this
  // document's history.
  if (e.source !== parent && e.source !== window) return;
  if (e.data.source === 'VISOR_REPLAY_INIT') {
    if (booted) return;              // the handshake can arrive twice; ignore the echo
    booted = true;
    if (e.data.theme) visorApplyTheme(e.data.theme);
    init(e.data.payload, e.data.startStep);
  }
  if (e.data.source === 'VISOR_REPLAY_ERROR') failToLoad(e.data.message);
  if (e.data.source === 'VISOR_REPLAY_THEME') visorApplyTheme(e.data.theme);
  if (e.data.source === 'VISOR_REPLAY_SEEK' && steps.length) {
    pause();
    seek(Math.min(steps.length - 1, positionOf(e.data.step)));
    syncTransport();
  }
});

/** Tell the host we are listening. This starts the handshake. */
function announceReady() {
  try { parent.postMessage({ source: 'VISOR_REPLAY_READY' }, '*'); } catch (_) { /* detached */ }
}

function failToLoad(message) {
  if (booted) return;
  const host = $('r-loading');
  if (!host) return;
  host.innerHTML = `
    <div class="r-load-fail">
      <div class="r-load-fail-mark" aria-hidden="true">△</div>
      <p>${String(message || 'Replay could not start.').replace(/[<&]/g, '')}</p>
      <button id="r-load-close" class="r-btn-quiet">Close</button>
    </div>`;
  host.querySelector('#r-load-close').addEventListener('click', () => {
    parent.postMessage({ source: 'VISOR_REPLAY_CLOSE' }, '*');
  });
}

// Announce immediately, and keep announcing briefly in case the host attached
// its listener a moment later. Cheap, and removes every ordering assumption.
announceReady();
let readyPings = 0;
const readyTimer = setInterval(() => {
  if (booted || ++readyPings > 20) return clearInterval(readyTimer);
  announceReady();
}, 150);

// If nothing ever answers, say so instead of spinning forever.
setTimeout(() => {
  if (!booted) failToLoad('Replay data never arrived. Close this and try again.');
}, 8000);

/**
 * Position in `steps` of the step whose document-wide index is `index`, or of
 * the first one after it. Steps are addressed by position throughout this file,
 * but a start point arrives as a document-wide index (a session's first edit).
 * The two only coincide when every step of the document is present — which is
 * no longer true when a single tab is being replayed.
 */
function positionOf(index) {
  let lo = 0, hi = steps.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (steps[mid].i < index) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function init(p, startStep) {
  payload = p;
  steps = p.steps || [];
  pasteCut = p.pasteThreshold || 20;
  byUser = new Map((p.contributors || []).map((c) => [c.id, c]));

  $('r-doc').textContent = (p.meta && p.meta.title) || 'Live replay';
  $('r-scrub').setAttribute('aria-valuemax', String(steps.length));

  renderActors();
  renderScope(p.tabState);
  renderScrubHeat();
  renderScrubMarks();

  // Opening from a session jumps to just before it, so you see it arrive.
  const from = typeof startStep === 'number' ? Math.max(-1, positionOf(startStep) - 1) : -1;
  seek(from);
  syncTransport();

  $('r-loading').classList.add('is-gone');
  setTimeout(() => $('r-loading').remove(), 450);

  // Start moving on its own — the first thing you should see is writing.
  setTimeout(() => play(), 500);
}

/**
 * Tab picker. Changing it asks the host to re-fold for that tab and send a
 * fresh payload, rather than filtering here — a tab's edits index into its own
 * buffer, so the positions only make sense when folded on their own.
 */
function renderScope(state) {
  const host = $('r-scope');
  const sel  = $('r-scope-select');
  if (!state || !state.tabs || state.tabs.length < 2) {
    host.classList.add('hidden');
    return;
  }
  host.classList.remove('hidden');
  sel.innerHTML =
    `<option value="">All tabs</option>` +
    state.tabs.map((t) =>
      `<option value="${esc(t.id)}"${t.id === state.selected ? ' selected' : ''}>${esc(t.title)}</option>`
    ).join('');
  sel.disabled = false;
  sel.title = 'Replay a single document tab';
}

$('r-scope-select').addEventListener('change', (e) => {
  pause();
  booted = false;                       // allow the replacement payload through
  $('r-text').textContent = '';
  $('r-ghosts').innerHTML = '';
  parent.postMessage({ source: 'VISOR_REPLAY_SET_TAB', tabId: e.target.value || null }, '*');
});

function actorOf(uid) {
  return byUser.get(uid) || { id: uid, name: 'Unknown', color: 'var(--ink-3)' };
}

// ── Applying and unapplying edits ────────────────────────────────────────────

function applyStep(n) {
  const s = steps[n];
  if (!s) return;

  const tag = tagFor(s);
  let firstAt = -1;
  let lastAt = -1;

  for (const op of s.ops) {
    if (op[0] === 0) {                        // insert
      const at = Math.min(op[1], docLength());
      const str = op[2];
      docInsert(at, str, tag);
      shiftGlows([0, at, str]);
      if (firstAt < 0) firstAt = at;
      lastAt = at + str.length;
    } else {                                  // delete
      const at  = Math.min(op[1], docLength());
      const end = Math.min(at + op[2], docLength());
      if (end > at) { pushGhost(s, docRemove(at, end - at)); shiftGlows([1, at, end - at]); }
      if (firstAt < 0) firstAt = at;
      lastAt = at;
    }
  }

  freshRange = firstAt >= 0 ? [firstAt, lastAt] : null;
  pasteFlash = s.big >= pasteCut;
  if (pasteFlash && freshRange && freshRange[1] > freshRange[0]) {
    glows.push({ a: freshRange[0], b: freshRange[1], t0: performance.now(), n: s.big });
    if (glows.length > GLOW_LIMIT) glows.shift();
  }
  cursor = n;
}

/** Tag objects are shared so 40,000 characters cost one object, not 40,000. */
const tagCache = new Map();
function tagFor(s) {
  const mode = s.big >= pasteCut ? 'paste' : 'typed';
  const key = `${s.u}|${mode}`;
  if (!tagCache.has(key)) tagCache.set(key, { u: s.u, m: mode });
  return tagCache.get(key);
}

function seek(n) {
  resetDoc();
  cursor = -1;
  ghosts = [];
  renderedRuns = [];
  renderedKeys = [];
  $('r-text').textContent = '';
  $('r-ghosts').innerHTML = '';

  for (let i = 0; i <= n && i < steps.length; i++) {
    const s = steps[i];
    const tag = tagFor(s);
    for (const op of s.ops) {
      if (op[0] === 0) {
        docInsert(Math.min(op[1], docLength()), op[2], tag);
      } else {
        const at  = Math.min(op[1], docLength());
        const end = Math.min(at + op[2], docLength());
        if (end > at) docRemove(at, end - at);
      }
    }
    cursor = i;
  }
  freshRange = null;
  glows = [];
  paint(true);
}

// ── Rendering ────────────────────────────────────────────────────────────────

/** Collapse the per-character marks into contiguous runs for the DOM. */
/**
 * The span of text to light up after the latest edit.
 *
 * Only what was just written: the word ending at the caret while someone types,
 * while they type. Pastes are lit separately, by the glows. This used to be the entire last run of
 * the document — every consecutive character by that author — so a paragraph
 * glowed in their colour while one word of it was being typed, and it glowed at
 * the end of the document even when the edit was somewhere in the middle.
 */
function highlightRange() {
  if (!freshRange) return null;
  const [start, end] = freshRange;
  if (end <= start) return null;                 // a deletion: nothing new to show
  if (pasteFlash) return null;                   // pastes glow on their own clock

  const full = docText();
  let b = end;
  // A word just finished with a space still counts as that word.
  while (b > 0 && end - b < 3 && /\s/.test(full[b - 1])) b--;
  let a = b;
  while (a > 0 && b - a < 40 && !/\s/.test(full[a - 1])) a--;
  return a < end ? [a, end] : null;
}

/*
 * Spans are cut at changes of author, and also at the ends of paragraphs and
 * sentences. Those boundaries belong to the text, so an edit moves nothing but
 * the span it lands in: every span before it and every span after it is
 * unchanged, and paint() keeps them. Cutting at fixed character positions
 * looked similar but was not — an insertion shifts every later position, so
 * every later span changed and was rebuilt on every frame of playback.
 */

function buildRuns() {
  const n = docLength();
  const full = docText();
  const hl = highlightRange();
  const now = performance.now();
  const lit = liveGlows(now);
  const cuts = new Set();
  if (hl) { cuts.add(hl[0]); cuts.add(hl[1]); }
  for (const g of lit) { cuts.add(g.a); cuts.add(g.b); }
  const runs = [];
  let start = 0;
  for (let i = 1; i <= n; i++) {
    const a = markAt(i - 1);
    const b = i < n ? markAt(i) : null;
    const c = full.charCodeAt(i - 1);
    const edge = !b || a.u !== b.u || a.m !== b.m ||
                 c === 10 ||                                              // newline
                 (c === 32 && i > 1 && /[.!?]/.test(full[i - 2])) ||      // sentence end
                 cuts.has(i);
    if (edge) {
      const run = {
        u: a ? a.u : '0',
        m: a ? a.m : 'typed',
        text: full.slice(start, i),
        f: hl !== null && start >= hl[0] && i <= hl[1],
        g: null
      };
      for (let k = lit.length - 1; k >= 0; k--) {
        const gl = lit[k];
        if (start >= gl.a && i <= gl.b) {
          run.g = { t0: gl.t0, age: now - gl.t0, n: start === gl.a ? gl.n : 0 };
          break;
        }
      }
      runs.push(run);
      start = i;
    }
  }
  return runs;
}

/*
 * Each paragraph is its own block element.
 *
 * The text used to be one long run of inline spans inside a single block, so
 * changing any span made the browser re-flow every line of the document — and
 * measuring the caret straight afterwards forced that re-flow immediately, on
 * every frame. At 28,000 characters that was eight of the ten milliseconds a
 * frame took. As separate blocks, an edit re-flows only its own paragraph.
 *
 * Newlines stay inside the text: in pre-wrap a paragraph ending in one still
 * renders as a single line and a newline on its own keeps one line of height,
 * so the layout is identical and every character keeps its offset.
 */
function paraKey(para) {
  let key = '';
  for (const r of para) key += `${r.u}\u0001${r.m}\u0001${r.f ? 1 : 0}\u0001${r.g ? r.g.t0 : 0}\u0001${r.text}\u0002`;
  return key;
}

function paraEl(para) {
  const el = document.createElement('div');
  el.className = 'r-para';
  for (const r of para) el.appendChild(runSpan(r));
  return el;
}

let renderedKeys = [];

function paint(full) {
  const host = $('r-text');
  const runs = buildRuns();

  // Runs already break after every newline, so paragraphs are runs up to and
  // including one whose text ends in a newline.
  const paras = [];
  let cur = [];
  for (const r of runs) {
    cur.push(r);
    if (r.text.charCodeAt(r.text.length - 1) === 10) { paras.push(cur); cur = []; }
  }
  if (cur.length) paras.push(cur);
  const keys = paras.map(paraKey);

  // Keep unchanged paragraphs at the front and the back; replace the middle.
  let from = 0;
  let tail = 0;
  const oldN = full ? 0 : renderedKeys.length;
  if (full) {
    host.textContent = '';
  } else {
    const lim = Math.min(keys.length, oldN);
    while (from < lim && keys[from] === renderedKeys[from]) from++;
    while (tail < lim - from && keys[keys.length - 1 - tail] === renderedKeys[oldN - 1 - tail]) tail++;
  }

  for (let k = from; k < oldN - tail; k++) {
    const node = host.childNodes[from];
    if (node) host.removeChild(node);
  }
  const frag = document.createDocumentFragment();
  for (let i = from; i < paras.length - tail; i++) frag.appendChild(paraEl(paras[i]));
  host.insertBefore(frag, host.childNodes[from] || null);

  renderedKeys = keys;
  renderedRuns = runs;
  positionCaret();
  followCaret();
}

function runSpan(run) {
  const el = document.createElement('span');
  el.textContent = run.text;
  const a = actorOf(run.u);
  el.style.setProperty('--c', a.color);
  if (colorize) el.style.color = a.color;
  if (run.f) el.classList.add('r-fresh');
  if (run.g) {
    // A paragraph rebuilt mid-glow picks the fade up where it had got to.
    el.classList.add('r-paste-glow');
    el.style.animationDelay = `${-Math.round(run.g.age)}ms`;
    if (run.g.n) {
      el.classList.add('r-paste-head');
      el.dataset.pasted = `Pasted · ${run.g.n.toLocaleString()} chars`;
    }
  }
  return el;
}

let hostRectCache = null;
addEventListener('resize', () => { hostRectCache = null; }, { passive: true });

function positionCaret() {
  const caret = $('r-caret');
  const host  = $('r-text');
  const at = freshRange ? freshRange[1] : docLength();
  if (!docLength()) { caret.classList.remove('is-on'); return; }

  const spot = locate(host, at);
  if (!spot) { caret.classList.remove('is-on'); return; }

  // Cached: the text pane does not move during playback, and measuring it on
  // every frame forced a second layout on top of the one locate() already
  // triggered. Dropped on resize, and whenever the pane itself scrolls.
  if (!hostRectCache) hostRectCache = host.getBoundingClientRect();
  const hostRect = hostRectCache;
  caret.style.transform =
    `translate(${spot.left - hostRect.left + host.scrollLeft}px, ${spot.top - hostRect.top + host.scrollTop}px)`;
  caret.style.height = `${Math.max(16, spot.height)}px`;

  const s = steps[cursor];
  if (s) caret.style.setProperty('--c', actorOf(s.u).color);
  caret.classList.add('is-on');
}

/** Client rect of the character offset `at` within the rendered text. */
function locate(host, at) {
  // Fast path, and it is the one taken on essentially every frame of playback:
  // the caret sits at the end of the text. Finding that by walking every text
  // node from the start cost O(number of spans) per frame — thousands of nodes
  // by the end of a long document, on top of the forced layout below — and
  // that is what made playback stutter as the replay went on.
  if (at >= docLength()) {
    let node = host.lastChild;
    while (node && node.nodeType !== 3) node = node.lastChild;
    if (node) {
      const range = document.createRange();
      range.setStart(node, node.nodeValue.length);
      range.setEnd(node, node.nodeValue.length);
      const rects = range.getClientRects();
      const r = rects.length ? rects[0] : range.getBoundingClientRect();
      if (r && (r.height || r.width)) return r;
    }
    return null;
  }

  let remaining = at;
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const len = node.nodeValue.length;
    if (remaining <= len) {
      const range = document.createRange();
      const off = Math.max(0, Math.min(remaining, len));
      range.setStart(node, off);
      range.setEnd(node, off);
      const rects = range.getClientRects();
      const r = rects.length ? rects[0] : range.getBoundingClientRect();
      if (r && (r.height || r.width)) return r;
      return null;
    }
    remaining -= len;
  }
  return null;
}

let lastScroll = 0;
function followCaret() {
  const host = $('r-text');
  const now = performance.now();
  if (now - lastScroll < 120) return;   // don't fight the smooth-scroll
  lastScroll = now;

  const caretTop = parseFloat((/translate\(([^,]+)px,\s*([^)]+)px\)/
    .exec($('r-caret').style.transform) || [])[2] || '0');
  const target = caretTop - host.clientHeight * 0.6;
  if (Math.abs(host.scrollTop - target) > host.clientHeight * 0.25) {
    host.scrollTop = Math.max(0, target);
  }
}

// ── Ghost pane ───────────────────────────────────────────────────────────────

let ghosts = [];

function pushGhost(step, removed) {
  if (removed.trim().length < 12) return;
  ghosts.unshift({ step, text: removed });
  if (ghosts.length > GHOST_LIMIT) ghosts.pop();

  const a = actorOf(step.u);
  const el = document.createElement('div');
  el.className = 'r-ghost';
  el.style.setProperty('--c', a.color);
  el.innerHTML = `
    <div class="r-ghost-meta">
      <b>${esc(firstName(a.name))}</b>
      <span>removed ${removed.length.toLocaleString()} chars</span>
    </div>
    <div class="r-ghost-text">${esc(removed.slice(0, 400))}</div>`;

  const pane = $('r-ghosts');
  pane.insertBefore(el, pane.firstChild);
  while (pane.childNodes.length > GHOST_LIMIT) pane.removeChild(pane.lastChild);
}

// ── Transport ────────────────────────────────────────────────────────────────

function play() {
  if (playing) return;
  if (cursor >= steps.length - 1) seek(-1);  // replay from the top when finished
  playing = true;
  lastFrame = performance.now();
  carry = 0;
  toggleIcons();
  rafId = requestAnimationFrame(tick);
}

function pause() {
  playing = false;
  toggleIcons();
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
}

function toggleIcons() {
  $('r-play').querySelector('.r-icon-play').classList.toggle('hidden', playing);
  $('r-play').querySelector('.r-icon-pause').classList.toggle('hidden', !playing);
}

function tick(now) {
  if (!playing) return;
  const dt = Math.min(120, now - lastFrame);
  lastFrame = now;

  let applied = 0;

  if (speed === 0) {
    // "max": burn through as many edits as one frame can carry.
    const budget = Math.max(40, Math.ceil(steps.length / 240));
    while (applied < budget && cursor < steps.length - 1) {
      applyStep(cursor + 1);
      applied++;
    }
  } else {
    carry += dt * speed;
    while (cursor < steps.length - 1 && applied < 4000) {
      const a = steps[cursor];
      const b = steps[cursor + 1];
      let gap = (a && a.t && b && b.t) ? (b.t - a.t) : 60;
      if (!(gap > 0)) gap = 30;
      gap = Math.min(gap, MAX_GAP_MS);
      if (carry < gap) break;
      carry -= gap;
      applyStep(cursor + 1);
      applied++;
    }
  }

  if (applied) {
    paint(false);
    syncTransport();
  }

  if (cursor >= steps.length - 1) { pause(); syncTransport(); return; }
  rafId = requestAnimationFrame(tick);
}

function syncTransport() {
  const frac = steps.length ? (cursor + 1) / steps.length : 0;
  $('r-scrub-fill').style.width = `${(frac * 100).toFixed(2)}%`;
  $('r-scrub-thumb').style.left = `${(frac * 100).toFixed(2)}%`;
  $('r-scrub').setAttribute('aria-valuenow', String(cursor + 1));

  $('r-pos').textContent = `${(cursor + 1).toLocaleString()} / ${steps.length.toLocaleString()} edits`;
  $('r-chars').textContent = `${docLength().toLocaleString()} chars`;

  const s = steps[cursor];
  $('r-clock').textContent = s && s.t
    ? new Date(s.t).toLocaleString(undefined, {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit'
      })
    : '—';

  const liveId = s ? s.u : null;
  [...document.querySelectorAll('.r-actor')].forEach((el) => {
    el.classList.toggle('is-live', el.dataset.uid === liveId);
  });
}

// ── Scrubber furniture ───────────────────────────────────────────────────────

function renderActors() {
  $('r-actors').innerHTML = (payload.contributors || []).map((c) => `
    <div class="r-actor" data-uid="${esc(c.id)}" style="--c:${esc(c.color)}">
      <span class="r-actor-dot"></span>${esc(c.name)}
    </div>`).join('');
}

/** Editing density along the timeline, so quiet stretches are visible. */
function renderScrubHeat() {
  const BUCKETS = 90;
  const counts = new Array(BUCKETS).fill(0);
  steps.forEach((s, i) => {
    const b = Math.min(BUCKETS - 1, Math.floor((i / steps.length) * BUCKETS));
    counts[b] += (s.ops || []).reduce((n, o) => n + (o[0] === 0 ? o[2].length : o[2]), 0);
  });
  const max = Math.max(...counts, 1);
  $('r-scrub-heat').innerHTML = counts.map((n) => {
    const t = Math.round((n / max) * 70);
    return `<i style="width:${(100 / BUCKETS).toFixed(3)}%;background:color-mix(in srgb,var(--accent) ${t}%,transparent)"></i>`;
  }).join('');
}

/** A tick for every paste, so you can jump straight to the interesting parts. */
function renderScrubMarks() {
  const marksHost = $('r-scrub-marks');
  const pastes = steps
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.big >= pasteCut);

  marksHost.innerHTML = pastes.slice(0, 300).map(({ s, i }) => {
    const a = actorOf(s.u);
    return `<div class="r-scrub-mark" data-step="${i}"
      data-tip="${esc(firstName(a.name))} pasted ${s.big.toLocaleString()} chars"
      style="left:${((i / steps.length) * 100).toFixed(3)}%"></div>`;
  }).join('');

  marksHost.addEventListener('click', (e) => {
    const m = e.target.closest('.r-scrub-mark');
    if (!m) return;
    e.stopPropagation();
    pause();
    seek(+m.dataset.step);
    syncTransport();
  });
}

// ── Input ────────────────────────────────────────────────────────────────────

$('r-play').addEventListener('click', () => (playing ? pause() : play()));

$('r-restart').addEventListener('click', () => {
  pause();
  seek(-1);
  syncTransport();
  play();
});

$('r-close').addEventListener('click', () => {
  parent.postMessage({ source: 'VISOR_REPLAY_CLOSE' }, '*');
});

$('r-speeds').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  speed = +btn.dataset.x;
  [...$('r-speeds').children].forEach((b) => b.classList.toggle('is-active', b === btn));
  carry = 0;
});

$('r-colorize').addEventListener('change', (e) => {
  colorize = e.target.checked;
  paint(true);
});

$('r-ghost-toggle').addEventListener('click', () => {
  const stage = document.querySelector('.r-stage');
  stage.classList.toggle('is-solo');
  $('r-ghost-pane').style.display = stage.classList.contains('is-solo') ? 'none' : '';
});

// Scrubbing
(() => {
  const scrub = $('r-scrub');
  let dragging = false;
  let wasPlaying = false;

  const stepAt = (clientX) => {
    const r = scrub.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    return Math.round(frac * steps.length) - 1;
  };

  scrub.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.r-scrub-mark')) return;
    dragging = true;
    wasPlaying = playing;
    pause();
    scrub.classList.add('is-dragging');
    scrub.setPointerCapture(e.pointerId);
    seek(stepAt(e.clientX));
    syncTransport();
  });

  // Only during a drag, and only once per frame: seek() rebuilds the document
  // view and stepAt() reads layout, so running both per pointer event thrashes.
  let dragX = 0;
  let dragQueued = false;

  const applyDrag = () => {
    dragQueued = false;
    if (!dragging) return;
    seek(stepAt(dragX));
    syncTransport();
  };

  scrub.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    dragX = e.clientX;
    if (dragQueued) return;
    dragQueued = true;
    requestAnimationFrame(applyDrag);
  }, { passive: true });

  const end = () => {
    if (!dragging) return;
    dragging = false;
    scrub.classList.remove('is-dragging');
    if (wasPlaying) play();
  };
  scrub.addEventListener('pointerup', end);
  scrub.addEventListener('pointercancel', end);

  scrub.addEventListener('keydown', (e) => {
    const jump = e.shiftKey ? 100 : 1;
    if (e.key === 'ArrowRight') { pause(); seek(Math.min(steps.length - 1, cursor + jump)); syncTransport(); }
    if (e.key === 'ArrowLeft')  { pause(); seek(Math.max(-1, cursor - jump)); syncTransport(); }
  });
})();

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea')) return;
  if (e.key === ' ') { e.preventDefault(); playing ? pause() : play(); }
  if (e.key === 'Escape') parent.postMessage({ source: 'VISOR_REPLAY_CLOSE' }, '*');
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const firstName = (n) => String(n || 'Unknown').split(' ')[0];
