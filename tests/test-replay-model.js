/* ============================================================================
 * The replay's document model.
 * ----------------------------------------------------------------------------
 * replay.js keeps the document in a gap buffer with a per-character author
 * mark, and paints it as paragraphs that are diffed between frames. All of
 * that is an optimisation, so the only thing worth asserting is that it is
 * invisible: at every step, and after any jump, the text and the authorship
 * must equal what a naive "apply every operation to a string" model produces,
 * and what is on screen must equal a from-scratch paint.
 * ==========================================================================*/

'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { makeDom } = require('./dom');

const DIR = path.join(__dirname, '..');

const out = [];
const ck = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  out.push(ok);
  if (!ok) {
    const g = String(got), w = String(want);
    let i = 0; while (i < g.length && i < w.length && g[i] === w[i]) i++;
    console.log(`FAIL  ${name}: differs at ${i} of ${g.length}/${w.length}: ` +
      JSON.stringify(g.slice(Math.max(0, i - 25), i + 25)) + ' vs ' + JSON.stringify(w.slice(Math.max(0, i - 25), i + 25)));
  }
  else console.log(`PASS  ${name}`);
};

// ── A stream with the awkward cases in it ──────────────────────────────────
function stream(n, seed) {
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const steps = [];
  let len = 0, cur = 0, t = 0;
  for (let i = 0; i < n; i++) {
    t += 200 + Math.floor(rnd() * 500);
    const u = String(1 + Math.floor(rnd() * 3));
    const ops = [];
    const r = rnd();
    if (r < 0.12 && len > 20) {                      // delete, sometimes to the end
      const at = Math.floor(rnd() * len);
      const take = Math.min(len - at, 1 + Math.floor(rnd() * 9));
      ops.push([1, at, take]);
      len -= take; cur = at;
    } else if (r < 0.16) {                            // a paste
      const s = 'pasted block of text. '.repeat(2 + Math.floor(rnd() * 3));
      const at = Math.min(len, Math.floor(rnd() * (len + 1)));
      ops.push([0, at, s]);
      len += s.length; cur = at + s.length;
    } else if (r < 0.22 && len > 5) {                 // replace: delete then insert
      const at = Math.floor(rnd() * (len - 2));
      ops.push([1, at, 2]);
      len -= 2;
      ops.push([0, at, 'xy']);
      len += 2; cur = at + 2;
    } else {                                          // ordinary typing, sometimes a jump
      if (rnd() < 0.08) cur = Math.floor(rnd() * (len + 1));
      const ch = 'abcdefg hijk.\n'[Math.floor(rnd() * 14)];
      ops.push([0, Math.min(cur, len), ch]);
      len += 1; cur = Math.min(cur, len) + 1;
    }
    steps.push({ i, t, u, big: ops[0][0] === 0 ? String(ops[0][2]).length : 1, ops });
  }
  return steps;
}

/** The obvious, slow implementation: strings and an array of author marks. */
function naive(steps, upTo, pasteCut) {
  let text = '';
  let marks = [];
  for (let k = 0; k <= upTo && k < steps.length; k++) {
    const s = steps[k];
    const mode = s.big >= pasteCut ? 'paste' : 'typed';
    for (const op of s.ops) {
      if (op[0] === 0) {
        const at = Math.min(op[1], text.length);
        text = text.slice(0, at) + op[2] + text.slice(at);
        marks = marks.slice(0, at).concat([...op[2]].map(() => `${s.u}|${mode}`), marks.slice(at));
      } else {
        const at = Math.min(op[1], text.length);
        const end = Math.min(at + op[2], text.length);
        text = text.slice(0, at) + text.slice(end);
        marks = marks.slice(0, at).concat(marks.slice(end));
      }
    }
  }
  return { text, marks: marks.join(',') };
}

function loadReplay() {
  const { win, document, clock } = makeDom({ autoIds: true });
  win.parent = { postMessage() {} };
  win.chrome = { storage: { local: { get: (k, cb) => cb && cb({}), set() {} } }, runtime: { getURL: (p) => p } };
  win.visorApplyTheme = () => {};
  win.visorInitTheme = async () => 'light';
  win.matchMedia = () => ({ matches: false, addEventListener() {} });
  win.NodeFilter = { SHOW_TEXT: 4 };
  // Two buttons the transport looks inside; everything else the panel touches
  // is conjured by id.
  for (const [id, cls] of [['r-play', ['r-icon-play', 'r-icon-pause']]]) {
    const host = document.getElementById(id);
    for (const c of cls) {
      const e = document.createElement('span');
      e.className = c;
      host.appendChild(e);
    }
  }
  const ctx = vm.createContext(win);
  vm.runInContext(fs.readFileSync(`${DIR}/replay.js`, 'utf8'), ctx, { filename: 'replay.js' });
  return { ctx, document, clock, run: (code) => vm.runInContext(code, ctx) };
}

const PASTE_CUT = 20;

for (const seed of [1, 7, 4242, 99991]) {
  const steps = stream(400, seed);
  const h = loadReplay();
  h.ctx.__p = { steps, pasteThreshold: PASTE_CUT, contributors: [], tabState: { tabs: [] }, meta: {}, sessions: [] };
  h.run('booted = true; init(__p, null); pause();');

  const marksOf = () => h.run("Array.from({length: docLength()}, (_, i) => markAt(i).u + '|' + markAt(i).m).join(',')");

  let bad = -1;
  for (let i = 0; i < steps.length; i++) {
    h.run('applyStep(cursor + 1)');
    const ref = naive(steps, i, PASTE_CUT);
    if (h.run('docText()') !== ref.text || marksOf() !== ref.marks) { bad = i; break; }
  }
  ck(`[seed ${seed}] playing forward matches at every step`, bad, -1);

  let badSeek = -1;
  for (const target of [399, 3, 250, 0, impatient(seed), 120]) {
    h.run(`seek(${target})`);
    const ref = naive(steps, target, PASTE_CUT);
    if (h.run('docText()') !== ref.text || marksOf() !== ref.marks) { badSeek = target; break; }
  }
  ck(`[seed ${seed}] seeking matches, including backwards`, badSeek, -1);

  h.run('seek(399)');
  ck(`[seed ${seed}] the rendered runs spell the document exactly`,
     h.run('buildRuns().map(r => r.text).join("") === docText()'), true);

  h.run('seek(150); for (let k = 0; k < 200; k++) { applyStep(cursor + 1); if (k % 3 === 0) paint(false); } paint(false);');
  const shown = () => h.run("$('r-text').children.map(p => p.children.map(n => n.textContent).join('')).join('')");
  ck(`[seed ${seed}] incremental paints show exactly the document`, shown(), h.run('docText()'));
  const incremental = h.run("$('r-text').children.map(p => p.children.map(n => n.textContent).join('\\u0003')).join('\\u0004')");
  h.run('paint(true)');
  ck(`[seed ${seed}] and leave the same paragraphs and spans a full paint does`,
     incremental, h.run("$('r-text').children.map(p => p.children.map(n => n.textContent).join('\\u0003')).join('\\u0004')"));
}

function impatient(seed) { return 40 + (seed % 60); }

// ── Highlighting: the word being typed, and pastes on their own clock ──────
{
  const h = loadReplay();
  const typed = 'The quick brown fox jumps over the lazy dog and keeps running along the riverbank';
  const steps = [...typed].map((ch, i) => ({ i, t: i * 200, u: '1', big: 1, ops: [[0, i, ch]] }));
  h.ctx.__p = { steps, pasteThreshold: PASTE_CUT, contributors: [], tabState: { tabs: [] }, meta: {}, sessions: [] };
  h.run('booted = true; init(__p, null); pause();');
  for (let i = 0; i < steps.length; i++) h.run('applyStep(cursor + 1)');
  ck('typing lights up only the last word', h.run('buildRuns().filter(r => r.f).map(r => r.text).join("")'), 'riverbank');
}
{
  const h = loadReplay();
  const block = 'A pasted paragraph that arrives all at once and glows as a block.';
  const steps = [{ i: 0, t: 0, u: '1', big: 5, ops: [[0, 0, 'Intro']] },
                 { i: 1, t: 1, u: '1', big: block.length, ops: [[0, 5, block]] }];
  h.ctx.__p = { steps, pasteThreshold: PASTE_CUT, contributors: [], tabState: { tabs: [] }, meta: {}, sessions: [] };
  h.run('booted = true; init(__p, null); pause(); applyStep(0); applyStep(1);');
  ck('a paste glows as a whole block', h.run('buildRuns().filter(r => r.g).map(r => r.text).join("")'), block);
  ck('  and is not also given the typing highlight', h.run('buildRuns().filter(r => r.f).length'), 0);

  h.clock.advance(300);
  h.run('steps.push({ i: 2, t: 2, u: "2", big: 3, ops: [[0, 0, ">> "]] }); applyStep(2);');
  ck('  typing before it keeps the glow on the pasted text', h.run('buildRuns().filter(r => r.g).map(r => r.text).join("")'), block);

  h.clock.advance(2000);   // past GLOW_MS
  ck('  and the glow ends on its own', h.run('buildRuns().filter(r => r.g).length'), 0);
}

console.log(out.every(Boolean) ? `\nall passed (${out.length} checks)` : `\n${out.filter((x) => !x).length} FAILED`);
process.exit(out.every(Boolean) ? 0 : 1);
