/* ============================================================================
 * Render the side panel to a PNG, with real figures.
 * ----------------------------------------------------------------------------
 * The panel is built from a real fold of a synthetic edit stream — the same
 * engine the extension runs — so what the picture shows is what a document of
 * that shape actually produces. Chrome's own headless renderer draws it.
 *
 *   node tests/render-panel.js [light|dark] [overview|people|timeline|evidence|signal]
 *
 * Writes tests/.out/panel-<theme>-<tab>.png. The page it renders is written to
 * the project root as _render-panel.html, which the packaging step excludes.
 * ==========================================================================*/

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DIR = path.join(__dirname, '..');
const OUT = path.join(__dirname, '.out');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const theme = process.argv[2] === 'dark' ? 'dark' : 'light';
// A trailing "+tabs" asks for a document with several tabs, so the scope
// selector is on screen.
const tab = (process.argv[3] || 'overview').replace('+tabs', '');
const wantTabs = /\+tabs/.test(process.argv[3] || '');
const height = Number(process.argv[4]) || 1400;

fs.mkdirSync(OUT, { recursive: true });

const stub = `
<style>
  /* Freeze every entrance at its finished state: the renderer must not catch
     a chart halfway through drawing itself. */
  *, *::before, *::after { animation-delay: -5s !important; animation-duration: 0.001s !important; transition: none !important; }
</style>
<script>
const TABS = ${wantTabs ? 'true' : 'false'};
// A document with three people, a few weeks of work, pastes and deletions.
function buildEntries() {
  const words = ('the of and to in is that for it as was with be by on not this are or from at which but have an they one you were all we there would their will when who him been has more if no out do so can what up said about other into than its time only could new them man some these then'
    ).split(' ');
  const e = []; let rev = 0, t = Date.UTC(2026, 1, 3, 9, 12), len = 1, cur = 1, seed = 20260913, author = 1, sentence = 0, pending = '';
  const r = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 9000; i++) {
    t += 300 + Math.floor(r() * 900);
    if (i % 900 === 0 && i) { author = 1 + Math.floor(r() * 3); t += 9e5 + Math.floor(r() * 36e5); }
    if (r() < 0.02) cur = Math.max(1, Math.floor(r() * len));
    if (r() < 0.006) cur = len;
    let m;
    if (r() < 0.06 && len > 120) { const a = Math.max(1, Math.min(cur - 9, len - 12)); m = { ty: 'ds', si: a, ei: a + 7 }; len -= 8; cur = a; }
    else if (r() < 0.0025) { const s = ' ' + 'Quoted passage carried in from a source document. '.repeat(6); m = { ty: 'is', ibi: cur, s }; len += s.length; cur += s.length; }
    else {
      if (!pending) { sentence++; pending = words[Math.floor(r() * words.length)] + (sentence % 13 === 0 ? '. ' : ' ') + (sentence % 80 === 0 ? '\\n' : ''); }
      const ch = pending[0]; pending = pending.slice(1);
      m = { ty: 'is', ibi: cur, s: ch }; len += 1; cur += 1;
    }
    e.push({ mutation: m, time: t, rev: ++rev, userId: String(author), sid: null });
  }
  return e;
}

const USERS = [{ id: '1', name: 'Ethan Bernstein' },
               { id: '2', name: 'Maya Okonkwo' },
               { id: '3', name: 'Sam Reyes' }];

const TL = VisorChangelog.buildTimeline(buildEntries(), USERS);
const AN = VisorChangelog.analyze(TL);
AN.tabState = TABS
  ? { tabs: [{ id: 't.0', title: 'Draft' }, { id: 't.1', title: 'Notes & sources' }, { id: 't.2', title: 'Appendix' }],
      pick: 'current', selected: 't.0', current: 't.0', resolvable: true,
      label: 'the current tab (Draft)' }
  : { tabs: [], pick: 'current', selected: null, current: null, resolvable: false };

const REPLY = {
  VISOR_STATUS:  { state: 'ready', meta: { title: 'Thesis — Chapter 3 draft', fileId: 'DOC1', kind: 'document' } },
  VISOR_ANALYZE: { state: 'ready', analysis: AN, meta: { title: 'Thesis — Chapter 3 draft' }, tabState: AN.tabState }
};

window.chrome = {
  tabs: {
    query: async () => [{ id: 1, url: 'https://docs.google.com/document/d/DOC1/edit' }],
    sendMessage: (id, msg, cb) => cb && cb(REPLY[msg.type] || { ok: true }),
    onActivated: { addListener() {} },
    create() {}
  },
  runtime: { lastError: null, onMessage: { addListener() {} }, sendMessage() {}, getURL: (p) => p },
  storage: { local: { get: (k, cb) => cb && cb({ visor_theme: '${theme}' }), set() {} }, onChanged: { addListener() {} } }
};
addEventListener('load', () => setTimeout(() => {
  if ('${tab}' === 'loading') { show('state-loading'); setProgress(0.42, 'Reading revision stream…'); }
  if ('${tab}' === 'hover') try {
    // Hover the very end of the growth chart, where the label used to hang off
    // the right-hand side and widen the panel.
    const chart = document.getElementById('growth-chart');
    const r = chart.getBoundingClientRect();
    chart.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
    chart.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: r.right - 2, clientY: r.top + 20 }));
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const el = document.documentElement;
      const panel = document.querySelector('.v-panel.is-active');
      document.title = 'overflow doc=' + (el.scrollWidth - el.clientWidth) +
                       ' panel=' + (panel.scrollWidth - panel.clientWidth);
    }));
    return;
  } catch (e) { document.title = 'hover failed: ' + e.message; return; }
  const btn = document.querySelector('.v-tab[data-tab="${tab}"]');
  if (btn) btn.click();
  document.documentElement.setAttribute('data-theme', '${theme}');
  document.documentElement.classList.add('visor-theme-instant');
  document.title = 'ready';
}, 60));
</script>
`;

let html = fs.readFileSync(path.join(DIR, 'sidepanel.html'), 'utf8');
html = html.replace('<script src="changelog.js"></script>', '<script src="changelog.js"></script>' + stub);
if (!html.includes('buildEntries')) {
  // The panel does not load the engine itself; add it, then the stub.
  html = html.replace('<script src="sidepanel.js"></script>', '<script src="changelog.js"></script>' + stub + '<script src="sidepanel.js"></script>');
}
const page = path.join(DIR, '_render-panel.html');
fs.writeFileSync(page, html);

const file = path.join(OUT, `panel-${theme}-${tab}${wantTabs ? '-tabs' : ''}.png`);
execFileSync(CHROME, [
  '--headless=new', '--disable-gpu', '--allow-file-access-from-files',
  '--force-device-scale-factor=2', `--window-size=${380 * 2},${height * 2}`,
  '--virtual-time-budget=4000', `--screenshot=${file}`, `file://${page}`
], { stdio: 'ignore' });

fs.unlinkSync(page);   // the page is scaffolding, not part of the extension
console.log(file);
