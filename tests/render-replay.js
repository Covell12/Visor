/* ============================================================================
 * Render the live replay window to a PNG, mid-playback.
 * ----------------------------------------------------------------------------
 *   node tests/render-replay.js [light|dark] [percent]
 *
 * Writes tests/.out/replay-<theme>.png. The page is written to the project root
 * as _render-replay.html, which packaging excludes.
 * ==========================================================================*/

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DIR = path.join(__dirname, '..');
const OUT = path.join(__dirname, '.out');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const theme = process.argv[2] === 'dark' ? 'dark' : 'light';
const pct = Number(process.argv[3] || 55);

fs.mkdirSync(OUT, { recursive: true });

const stub = `
<style>
  *, *::before, *::after { transition: none !important; animation-delay: -5s !important; animation-duration: 0.001s !important; }
</style>
<script src="changelog.js"></script>
<script>
function buildEntries() {
  const words = ('the of and to in is that for it as was with be by on not this are or from at which but have an they one you were all we there would their will when who him been has more if no out do so can what up said about other into than its time only could new them some these then'
    ).split(' ');
  const e = []; let rev = 0, t = Date.UTC(2026, 1, 3, 9, 12), len = 1, cur = 1, seed = 4242, author = 1, sentence = 0, pending = '';
  const r = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 5000; i++) {
    t += 280 + Math.floor(r() * 700);
    if (i % 800 === 0 && i) { author = 1 + Math.floor(r() * 3); t += 9e5; }
    if (r() < 0.02) cur = Math.max(1, Math.floor(r() * len));
    let m;
    if (r() < 0.05 && len > 140) { const a = Math.max(1, Math.min(cur - 9, len - 12)); m = { ty: 'ds', si: a, ei: a + 7 }; len -= 8; cur = a; }
    else if (r() < 0.003) { const s = ' ' + 'Quoted passage carried in from a source document. '.repeat(4); m = { ty: 'is', ibi: cur, s }; len += s.length; cur += s.length; }
    else {
      if (!pending) { sentence++; pending = words[Math.floor(r() * words.length)] + (sentence % 12 === 0 ? '. ' : ' ') + (sentence % 60 === 0 ? '\\n' : ''); }
      const ch = pending[0]; pending = pending.slice(1);
      m = { ty: 'is', ibi: cur, s: ch }; len += 1; cur += 1;
    }
    e.push({ mutation: m, time: t, rev: ++rev, userId: String(author), sid: null });
  }
  return e;
}
const USERS = [{ id: '1', name: 'Ethan Bernstein' }, { id: '2', name: 'Maya Okonkwo' }, { id: '3', name: 'Sam Reyes' }];
const TL = VisorChangelog.buildTimeline(buildEntries(), USERS);
const AN = VisorChangelog.analyze(TL);
window.__pay = {
  steps: TL.steps.map((s) => ({ i: s.i, t: s.time, u: s.userId, big: s.biggestInsert,
    ops: (s._norm || []).filter((o) => o.op === 'insert' || o.op === 'delete')
      .map((o) => o.op === 'insert' ? [0, o.at, o.text] : [1, o.at, o.len]) })),
  finalText: TL.finalText, pasteThreshold: AN.pasteThreshold.value, contributors: AN.contributors,
  sessions: AN.sessions, tabState: { tabs: [] }, meta: { title: 'Thesis — Chapter 3 draft' }
};
addEventListener('load', () => setTimeout(() => {
  document.documentElement.setAttribute('data-theme', '${theme}');
  booted = true;
  init(window.__pay, Math.floor(window.__pay.steps.length * ${pct / 100}));
  pause();
  document.title = 'ready';
}, 50));
</script>
`;

let html = fs.readFileSync(path.join(DIR, 'replay.html'), 'utf8');
html = html.replace('<script src="replay.js"></script>', stub + '<script src="replay.js"></script>');
const page = path.join(DIR, '_render-replay.html');
fs.writeFileSync(page, html);

const file = path.join(OUT, `replay-${theme}.png`);
execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--allow-file-access-from-files',
  '--force-device-scale-factor=2', '--window-size=2200,1400', '--virtual-time-budget=6000',
  `--screenshot=${file}`, `file://${page}`], { stdio: 'ignore' });
fs.unlinkSync(page);   // the page is scaffolding, not part of the extension
console.log(file);
