/* ============================================================================
 * Render the in-document bar to a PNG.
 * ----------------------------------------------------------------------------
 * The markup comes from content.js itself, built against the little DOM in
 * dom.js from a real fold, then dropped into a page with the real stylesheet.
 *
 *   node tests/render-bar.js [light|dark]
 *
 * Writes tests/.out/bar-<theme>.png.
 * ==========================================================================*/

'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { execFileSync } = require('child_process');
const { makeDom } = require('./dom');

const DIR = path.join(__dirname, '..');
const OUT = path.join(__dirname, '.out');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const theme = process.argv[2] === 'dark' ? 'dark' : 'light';

fs.mkdirSync(OUT, { recursive: true });

// ── Build the bar's markup ──────────────────────────────────────────────────
const { win, document, clock } = makeDom();

function entries() {
  const words = 'the of and to in is that for it as was with be by on not this are or from at which but have an they one you were all we there would their will when who him been has more'.split(' ');
  const out = [];
  let rev = 0, t = Date.UTC(2026, 1, 3, 9, 12), len = 1, cur = 1, seed = 7, author = 1, pending = '';
  const r = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 4000; i++) {
    t += 300 + Math.floor(r() * 700);
    if (i % 700 === 0 && i) { author = 1 + Math.floor(r() * 3); t += 12e5; }
    let m;
    if (r() < 0.05 && len > 100) { const a = Math.max(1, Math.min(cur - 8, len - 10)); m = { ty: 'ds', si: a, ei: a + 6 }; len -= 7; cur = a; }
    else {
      if (!pending) pending = words[Math.floor(r() * words.length)] + ' ';
      const ch = pending[0]; pending = pending.slice(1);
      m = { ty: 'is', ibi: cur, s: ch }; len += 1; cur += 1;
    }
    out.push({ mutation: m, time: t, rev: ++rev, userId: String(author), sid: null });
  }
  return out;
}

const engine = new vm.Script(fs.readFileSync(`${DIR}/changelog.js`, 'utf8'));
win.chrome = {
  runtime: { id: 'visor-test', lastError: null, getURL: (p) => p, sendMessage: (m, cb) => cb && cb({ ok: true }), onMessage: { addListener() {} } },
  storage: { local: { get: (k, cb) => cb && cb({}), set() {} }, onChanged: { addListener() {} } }
};
const ctx = vm.createContext(win);
engine.runInContext(ctx);

const USERS = [{ id: '1', name: 'Ethan Bernstein' }, { id: '2', name: 'Maya Okonkwo' }, { id: '3', name: 'Sam Reyes' }];
win.__entries = entries();
win.__users = USERS;

vm.runInContext(fs.readFileSync(`${DIR}/content.js`, 'utf8'), ctx, { filename: 'content.js' });
vm.runInContext(`
  const TL = VisorChangelog.buildTimeline(__entries, __users);
  analysis = VisorChangelog.analyze(TL);
  timeline = TL;
  allEntries = __entries;
  hudCollapsed = false;
  renderHUD(analysis);
`, ctx);
clock.advance(50);

const hud = document.getElementById('visor-hud');
const tab = document.getElementById('visor-hud-tab');

// ── Draw it ─────────────────────────────────────────────────────────────────
const page = `
<meta charset="utf-8">
<style>${fs.readFileSync(`${DIR}/content.css`, 'utf8')}</style>
<style>
  html, body { margin: 0; height: 100%; background: ${theme === 'dark' ? '#202124' : '#F8F9FA'}; }
  /* Pin both pieces where they can be seen, and finish every animation. */
  .visor-launch-row { display: flex; align-items: center; gap: 10px; padding: 14px 18px;
    font: 13px 'Google Sans', Inter, system-ui, sans-serif; color: ${theme === 'dark' ? '#E3E3E3' : '#444746'}; }
  #visor-hud { position: fixed; left: 50%; bottom: 96px; opacity: 1 !important; }
  #visor-hud-tab { bottom: 24px; opacity: 1 !important; transform: none !important; }
  *, *::before, *::after { animation-delay: -5s !important; animation-duration: 0.001s !important; transition: none !important; }
</style>
<div class="visor-launch-row"><span>Version history</span>
  <button class="visor-launch" data-visor-theme="${theme}">
    <img class="visor-launch-mark" src="logo.png" alt="" width="24" height="16">
    <span class="visor-launch-text">Visor</span>
  </button><span>Share</span></div>
<div id="visor-hud" class="visor-hud is-in" data-visor-theme="${theme}">${hud ? hud.innerSerialized : '(no bar)'}</div>
<div id="visor-hud-tab" class="visor-hud-tab is-shown" data-visor-theme="${theme}">${tab ? tab.innerSerialized : ''}</div>
`;
const file = path.join(DIR, '_render-bar.html');
fs.writeFileSync(file, page);

const png = path.join(OUT, `bar-${theme}.png`);
execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--allow-file-access-from-files',
  '--force-device-scale-factor=2', '--window-size=1200,340', '--virtual-time-budget=2500',
  `--screenshot=${png}`, `file://${file}`], { stdio: 'ignore' });
fs.unlinkSync(file);   // the page is scaffolding, not part of the extension
console.log(png);
