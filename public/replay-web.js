/* Visor Classroom — replay of a student document (review page, Replay tab).
   A port of the extension's Live replay (extension/replay.js and replay.css)
   to Visor's own op log: the text is rebuilt op by op, new text glows in its
   source's color, pastes flash, deletions drift into "Removed as you watch".
   Under the scrubber: session boundaries and pauses on the bar, research
   ticks below it (hover for the search or page).

   Seeking uses keyframes built once when the replay opens, every 250 ops,
   so jumping anywhere replays at most 250 ops. (The server's snapshots hold
   only the text; the replay also needs where each character came from.) */

'use strict';

const RP_SPEEDS = [1, 4, 16, 64];
const RP_IDLE_MS = 10000;      // gaps longer than this are skipped (toggle)
const RP_IDLE_SHOWN = 600;     // …and shown as this long
const RP_KEY_EVERY = 250;
const RP_CAT_COLOR = { typed: 'var(--rp-typed)', 'pasted-internal': 'var(--rp-internal)', 'pasted-research': 'var(--rp-research)', 'pasted-outside': 'var(--rp-outside)', cited: 'var(--rp-cited)', template: 'var(--rp-template)', other: 'var(--rp-other)' };
let rp = null;

function rpCategory(op) {
  if (op.src === 'template') return 'template';
  if (op.src === 'cite') return 'cited';
  if (op.src === 'paste' || op.src === 'drop') return op.paste?.internal ? 'pasted-internal' : op.paste?.origin ? 'pasted-research' : 'pasted-outside';
  if (op.src === 'other') return 'other';
  return 'typed';
}

async function mountReplay(el, { docId, sessions, research }) {
  if (rp?.raf) cancelAnimationFrame(rp.raf);
  el.innerHTML = `<div class="loading-row"><span class="spinner"></span></div>`;
  const ops = [];
  for (let from = 1; ;) {
    const r = await api(`/api/write/${docId}/ops?from=${from}`);
    ops.push(...r.ops);
    if (!r.nextFrom) break;
    from = r.nextFrom;
  }
  rp = { el, ops, sessions, research: research || [], i: 0, playing: false, speed: 4, skipIdle: true, vclock: 0, last: 0, text: '', tags: [], ghosts: [], keys: [] };
  rpBuildClock();
  rpBuildKeys();
  el.innerHTML = `<div class="rp">
    <div class="rp-stage">
      <div class="rp-paper"><div id="rpText" class="rp-text" aria-live="off"></div></div>
      <aside class="rp-ghosts" aria-label="Removed as you watch"><div class="rp-ghosts-head">Removed as you watch</div><div id="rpGhosts" class="rp-ghosts-body"></div></aside>
    </div>
    <div class="rp-transport">
      <button id="rpPlay" class="rp-play" aria-label="Play" onclick="rpToggle()">${I.play}</button>
      <button class="rp-mini" onclick="rpSeek(0)" title="Back to the start" aria-label="Back to the start">↺</button>
      <div class="rp-scrub-wrap">
        <div id="rpScrub" class="rp-scrub" role="slider" tabindex="0" aria-label="Position in the writing" aria-valuemin="0" aria-valuemax="${ops.length}" aria-valuenow="0">
          <div id="rpBands" class="rp-bands"></div><div id="rpFill" class="rp-fill"></div><div id="rpKnob" class="rp-knob"></div>
        </div>
        <div id="rpTicks" class="rp-ticks"></div>
      </div>
      <div class="rp-speeds" role="group" aria-label="Speed">${RP_SPEEDS.map(s => `<button data-s="${s}" aria-pressed="${s === rp.speed}" onclick="rpSpeed(${s})">${s}×</button>`).join('')}</div>
      <label class="rp-skip"><input type="checkbox" ${rp.skipIdle ? 'checked' : ''} onchange="rpSkip(this.checked)" /> Skip pauses over 10 s</label>
    </div>
    <div class="rp-meta"><span id="rpWhen" class="mono"></span><span id="rpCount" class="mono"></span>
      <span class="rp-legend">${Object.entries({ typed: 'typed', 'pasted-research': 'pasted (copied during session)', 'pasted-outside': 'pasted (outside Visor’s view)', 'pasted-internal': 'moved within the essay', cited: 'citation', template: 'starter text', other: 'no keyboard or paste event' }).map(([k, l]) => `<span><i style="background:${RP_CAT_COLOR[k]}"></i>${l}</span>`).join('')}</span></div>
  </div>`;
  rpDrawMarks();
  const scrub = $('rpScrub');
  const seekAt = x => { const r = scrub.getBoundingClientRect(); rpSeekV(Math.max(0, Math.min(1, (x - r.left) / r.width)) * rp.vTotal); };
  scrub.addEventListener('pointerdown', e => { seekAt(e.clientX); const mv = ev => seekAt(ev.clientX); window.addEventListener('pointermove', mv); window.addEventListener('pointerup', () => window.removeEventListener('pointermove', mv), { once: true }); });
  scrub.addEventListener('keydown', e => {
    const step = Math.max(1, Math.round(rp.ops.length / 50));
    if (e.key === 'ArrowRight') { e.preventDefault(); rpSeek(Math.min(rp.ops.length, rp.i + step)); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); rpSeek(Math.max(0, rp.i - step)); }
    if (e.key === ' ') { e.preventDefault(); rpToggle(); }
  });
  rpSeek(ops.length); // open on the finished essay
  return () => { if (rp?.raf) cancelAnimationFrame(rp.raf); rp = null; };
}

// Virtual playback time for each op: real gaps, with long idle gaps squeezed
function rpBuildClock() {
  rp.v = new Array(rp.ops.length);
  let v = 0;
  for (let i = 0; i < rp.ops.length; i++) {
    const gap = i ? Math.max(0, rp.ops[i].t - rp.ops[i - 1].t) : 0;
    v += rp.skipIdle && gap > RP_IDLE_MS ? RP_IDLE_SHOWN : Math.min(gap, 6 * 3600e3);
    rp.v[i] = v;
  }
  rp.vTotal = Math.max(1, v);
}

// Keyframes every 250 ops: the text and where each character came from
function rpBuildKeys() {
  let text = '', tags = [];
  rp.keys = [{ i: 0, text: '', tags: [] }];
  for (let i = 0; i < rp.ops.length; i++) {
    ({ text, tags } = rpApply(text, tags, rp.ops[i], null));
    if ((i + 1) % RP_KEY_EVERY === 0) rp.keys.push({ i: i + 1, text, tags: tags.slice() });
  }
}

function rpApply(text, tags, op, ghosts) {
  if (op.k === 'i') {
    const cat = rpCategory(op);
    const tag = { c: cat, n: op.n, big: op.s.length >= 20 && cat !== 'typed' };
    text = text.slice(0, op.at) + op.s + text.slice(op.at);
    tags.splice(op.at, 0, ...new Array(op.s.length).fill(tag));
  } else if (op.k === 'd') {
    if (ghosts && op.len >= 3) ghosts.unshift({ text: text.slice(op.at, op.at + op.len), t: op.t });
    text = text.slice(0, op.at) + text.slice(op.at + op.len);
    tags.splice(op.at, op.len);
  }
  return { text, tags };
}

function rpSeek(target) {
  if (!rp) return;
  let k = rp.keys[0];
  for (const key of rp.keys) if (key.i <= target) k = key;
  let text = k.text, tags = k.tags.slice();
  rp.ghosts = [];
  for (let i = k.i; i < target; i++) ({ text, tags } = rpApply(text, tags, rp.ops[i], i >= target - 40 ? rp.ghosts : null));
  rp.text = text; rp.tags = tags; rp.i = target;
  rp.vclock = target ? rp.v[target - 1] : 0;
  rp.freshFrom = target;
  rpPaint();
}
function rpSeekV(v) {
  let lo = 0, hi = rp.ops.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (rp.v[mid] <= v) lo = mid + 1; else hi = mid; }
  rpSeek(lo);
}

function rpToggle() {
  if (!rp) return;
  if (rp.i >= rp.ops.length) rpSeek(0);
  rp.playing = !rp.playing;
  $('rpPlay').innerHTML = rp.playing ? I.stop : I.play;
  $('rpPlay').setAttribute('aria-label', rp.playing ? 'Pause' : 'Play');
  if (rp.playing) { rp.last = performance.now(); rp.raf = requestAnimationFrame(rpFrame); }
}
function rpFrame(now) {
  if (!rp || !rp.playing) return;
  rp.vclock += (now - rp.last) * rp.speed;
  rp.last = now;
  rp.freshFrom = rp.i;
  while (rp.i < rp.ops.length && rp.v[rp.i] <= rp.vclock) {
    ({ text: rp.text, tags: rp.tags } = rpApply(rp.text, rp.tags, rp.ops[rp.i], rp.ghosts));
    rp.i++;
  }
  rp.ghosts.length = Math.min(rp.ghosts.length, 30);
  rpPaint(true);
  if (rp.i >= rp.ops.length) { rp.playing = false; $('rpPlay').innerHTML = I.play; return; }
  rp.raf = requestAnimationFrame(rpFrame);
}
function rpSpeed(s) { rp.speed = s; rp.el.querySelectorAll('.rp-speeds button').forEach(b => b.setAttribute('aria-pressed', Number(b.dataset.s) === s)); }
function rpSkip(on) { const at = rp.i; rp.skipIdle = on; rpBuildClock(); rpDrawMarks(); rpSeek(at); }

// The text as runs of one source each; the newest op glows
function rpPaint(live) {
  const el = $('rpText'); if (!el) return;
  const t = rp.text, tags = rp.tags;
  const newest = rp.i ? rp.ops[rp.i - 1].n : -1;
  let html = '', start = 0;
  for (let i = 1; i <= t.length; i++) {
    if (i === t.length || tags[i] !== tags[start]) {
      const tag = tags[start];
      const fresh = live && tag && tag.n === newest;
      html += `<span class="rp-run ${tag && tag.big ? 'rp-big' : ''} ${fresh ? (tag.big ? 'rp-paste-glow' : 'rp-fresh') : ''}" style="--c:${RP_CAT_COLOR[tag ? tag.c : 'typed']}">${esc(t.slice(start, i))}</span>`;
      start = i;
    }
  }
  el.innerHTML = html + (rp.i < rp.ops.length || live ? '<span class="rp-caret" aria-hidden="true"></span>' : '');
  if (live) { const c = el.querySelector('.rp-fresh, .rp-paste-glow'); if (c) c.scrollIntoView({ block: 'nearest' }); }
  $('rpGhosts').innerHTML = rp.ghosts.slice(0, 30).map(g => `<div class="rp-ghost">${esc(g.text.slice(0, 300))}</div>`).join('') || '<div class="tiny muted">Nothing removed nearby.</div>';
  const f = rp.ops.length ? (rp.i ? rp.v[rp.i - 1] : 0) / rp.vTotal : 1;
  $('rpFill').style.width = `${(f * 100).toFixed(2)}%`;
  $('rpKnob').style.left = `${(f * 100).toFixed(2)}%`;
  $('rpScrub').setAttribute('aria-valuenow', rp.i);
  const op = rp.ops[Math.max(0, rp.i - 1)];
  $('rpWhen').textContent = op ? vcDateTime(new Date(op.t).toISOString()) : '';
  $('rpCount').textContent = `edit ${rp.i.toLocaleString()} of ${rp.ops.length.toLocaleString()}`;
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
