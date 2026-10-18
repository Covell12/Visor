/* ============================================================================
 * AWARE mode, and the System theme.
 * ----------------------------------------------------------------------------
 *   1. Placing the runs Docs paints in the document's text (aware.js, pure).
 *   2. Splitting a run into each author's stretch, and reading order.
 *   3. Who wrote each stretch of the surviving text, from a real fold.
 *   4. The switch: the bar's AWARE button (with its NEW label), the stored
 *      value the side panel shares, and what the page is sent.
 *   5. The theme's three choices: Light, Dark, and System.
 * Nothing here reaches Google: the document is a few strings.
 * ==========================================================================*/

'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { makeDom } = require('./dom');
const aware = require('../aware.js');
const { VisorChangelog } = require('../changelog.js');

const DIR = path.join(__dirname, '..');
const out = [];
const ck = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  out.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `: ${JSON.stringify(got)} (want ${JSON.stringify(want)})`}`);
};

// ── 1. Placing runs ──────────────────────────────────────────────────────────
{
  const doc = '\u0003Field notes\nThe first paragraph wraps over two lines on the page.\nA second paragraph.\n';
  const at = (s) => doc.indexOf(s);
  const runs = ['Field notes', 'The first paragraph wraps over', 'two lines on the page.', 'A second paragraph.'];
  ck('each run of a page is found where it is in the document', aware.placeRuns(runs, doc), runs.map(at));

  // Docs paints list numbers and bullets as runs of their own; they aren't in
  // the text, and must not move the cursor.
  const listed = ['Field notes', '1.', 'The first paragraph wraps over', '●', 'two lines on the page.'];
  ck('list numbers and bullets are skipped and nothing else moves',
    aware.placeRuns(listed, doc), [at('Field notes'), -1, at('The first paragraph wraps over'), -1, at('two lines on the page.')]);

  // A short run only counts right where the text continues: a "2." further on
  // must not be taken for this page's list number.
  const doc2 = 'Steps to follow today.\nStep 2. Mix the paint well.\n';
  ck('a short run far ahead is not matched',
    aware.placeRuns(['Steps to follow today.', '2.', 'Step'], doc2), [0, -1, doc2.indexOf('Step 2')]);

  // Text written since Visor last read the history: left alone, and the runs
  // after it still found.
  ck('a run the document doesn\'t have yet is left uncoloured',
    aware.placeRuns(['The first paragraph wraps over', 'brand new words typed just now', 'two lines on the page.'], doc),
    [at('The first paragraph wraps over'), -1, at('two lines on the page.')]);

  // Short runs above the anchor are placed going backwards.
  ck('short runs before the anchor are placed backwards',
    aware.placeRuns(['A', 'second paragraph.'], 'Intro.\nA second paragraph.\n'), [7, 9]);

  // A phrase that occurs twice: the runs after it decide which.
  const twice = 'Example: one two three four five six seven eight.\nAnd then.\nExample: one two three four five six seven eight.\nNine ten eleven twelve.\nThirteen fourteen.\nFifteen sixteen.\n';
  const page = ['Example: one two three four five six seven eight.', 'Nine ten eleven twelve.', 'Thirteen fourteen.', 'Fifteen sixteen.'];
  ck('a repeated phrase is placed where what follows confirms it',
    aware.placeRuns(page, twice)[0], twice.lastIndexOf('Example:'));
  ck('  and with nothing to confirm either copy, nothing is coloured',
    aware.placeRuns(['Example: one two three four five six seven eight.'], twice), [-1]);

  ck('no anchor at all: nothing is guessed', aware.placeRuns(['a', 'of', 'the'], 'a tale of the sea'), [-1, -1, -1]);
  ck('an empty document places nothing', aware.placeRuns(['Field notes'], ''), [-1]);

  // A stretch the document lost track of is picked up again at a unique run.
  const long = 'Alpha beta gamma delta.\n' + 'x'.repeat(2000) + '\nOmega psi chi phi upsilon.\n';
  ck('after a long gap the thread is picked up again at a unique run',
    aware.placeRuns(['Alpha beta gamma delta.', 'Omega psi chi phi upsilon.'], long), [0, long.indexOf('Omega')]);
}

// ── 2. Stretches and reading order ───────────────────────────────────────────
{
  const owners = [[0, 5, 0], [5, 3, 1], [8, 10, 0], [18, 4, 2]];
  ck('a run is split into each author\'s stretch', aware.stretchesIn(owners, 3, 7), [[0, 2, 0, 0], [2, 5, 1, 0], [5, 7, 0, 0]]);
  ck('  a run inside one author\'s stretch is one stretch', aware.stretchesIn(owners, 9, 4), [[0, 4, 0, 0]]);
  ck('  a pasted stretch says so', aware.stretchesIn([[0, 4, 0, 0], [4, 6, 1, 1]], 2, 6), [[0, 2, 0, 0], [2, 6, 1, 1]]);
  ck('  and past the end there is nothing', aware.stretchesIn(owners, 40, 5), []);

  const r = (t, x, y, size = 30) => ({ t, x, y, size });
  const order = aware.readingOrder([r('world', 300, 100), r('2', 210, 88, 20), r('Hello', 20, 100), r('Next line', 20, 160)]);
  ck('runs are read line by line, left to right (a superscript stays on its line)', order.map((x) => x.t), ['Hello', '2', 'world', 'Next line']);
}

{
  ck('plain dark text is recoloured', ['#000000', '#222', 'rgb(51, 51, 51)', '#434343'].map(aware.plainInk), [true, true, true, true]);
  ck('the light blue turns paper blue and keeps every author colour as it is',
    ['#2F6FC4', '#B4603A', '#3D8B4F'].every((c) => {
      const m = aware.pasteMultiply(c, aware.PASTE_BLUE).match(/\d+/g).map(Number), C = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
      const f = (px) => C.map((cv, i) => Math.round(255 * (1 - (1 - px * m[i] / 255) * (1 - cv / 255)))).join();
      return f(1) === aware.PASTE_BLUE.join() && f(0) === C.join();
    }), true);
  ck('  coloured, light or patterned text is underlined instead', ['#1155cc', '#ffffff', '#cc0000', '#999999', '[object CanvasGradient]', ''].map(aware.plainInk), [false, false, false, false, false, false]);
}

// ── 3. Who wrote each stretch, from a real fold ──────────────────────────────
{
  const t0 = Date.UTC(2026, 9, 1, 9);
  const e = (userId, mutation, k) => ({ mutation, time: t0 + k * 60000, rev: k + 1, userId, sid: null });
  const entries = [
    e('1', { ty: 'is', ibi: 1, s: 'Hello world.' }, 0),
    e('2', { ty: 'is', ibi: 13, s: ' Second voice.' }, 1),
    e('1', { ty: 'is', ibi: 7, s: 'big ' }, 2),          // "Hello big world. Second voice."
    e('2', { ty: 'ds', si: 1, ei: 6 }, 3)                // "big world. Second voice."
  ];
  const users = [{ id: '1', name: 'Maya' }, { id: '2', name: 'Sam' }];
  const tl = VisorChangelog.buildTimeline(entries, users);
  const a = VisorChangelog.analyze(tl);
  ck('the fold gives the expected text', tl.finalText, 'big world. Second voice.');
  ck('ownership runs cover the text exactly, in order', a.ownership, [[0, 10, '1', 0], [10, 14, '2', 0]]);
  ck('  and every character is owned', a.ownership.reduce((n, r) => n + r[1], 0), tl.finalText.length);
  ck('runs from marks: neighbours by one person merge', VisorChangelog.ownershipRuns([{ u: 'a' }, { u: 'a' }, { u: 'b' }, null, { u: 'a' }]),
    [[0, 2, 'a', 0], [2, 1, 'b', 0], [3, 1, '0', 0], [4, 1, 'a', 0]]);
  ck('  a pasted stretch is a run of its own, marked by where it came from', VisorChangelog.ownershipRuns([{ u: 'a', m: 'typed' }, { u: 'a', m: 'paste', o: 'external' }, { u: 'a', m: 'paste', o: 'external' }, { u: 'a', m: 'paste', o: 'internal' }, { u: 'a', m: 'typed' }]),
    [[0, 1, 'a', 0], [1, 2, 'a', 1], [3, 1, 'a', 2], [4, 1, 'a', 0]]);
  {
    // a real fold: a sentence copied within the document, and one pasted in
    const t1 = Date.UTC(2026, 9, 2, 9);
    const said = 'The tide turned in the spring of 1848 across Europe.';
    const ins = (userId, at, s2, k) => ({ mutation: { ty: 'is', ibi: at, s: s2 }, time: t1 + k * 60000, rev: k + 1, userId, sid: null });
    const typed = 'Intro. ';
    let at = 1; const es = [];
    for (const ch of typed) es.push(ins('1', at++, ch, es.length));
    es.push(ins('1', at, said, es.length)); at += said.length;                    // pasted in from outside
    es.push(ins('2', at, ' ' + said, es.length)); at += said.length + 1;          // the same sentence, copied within
    const tl2 = VisorChangelog.buildTimeline(es, [{ id: '1', name: 'Maya' }, { id: '2', name: 'Sam' }]);
    const own = VisorChangelog.analyze(tl2).ownership;
    ck('a paste from outside is marked 1, a copy within the document 2', own.map((r) => [r[2], r[3]]), [['1', 0], ['1', 1], ['2', 2]]);
  }
  ck('  collapsed into one author, the pastes are still marked', VisorChangelog.ownershipRuns([{ u: 'a', m: 'typed' }, { u: 'b', m: 'paste' }], '0'),
    [[0, 1, '0', 0], [1, 1, '0', 1]]);
}

// ── 4. The switch ────────────────────────────────────────────────────────────
function loadContent({ stored = {} } = {}) {
  const { win, document, clock } = makeDom();
  const posted = [];
  const store = { ...stored };
  const changeListeners = [];
  win.location.origin = 'https://docs.google.com';
  win.postMessage = (msg) => { posted.push(msg); };
  win.VisorChangelog = {
    async fetchChangelog() {
      return { entries: [{ mutation: { ty: 'is', ibi: 1, s: 'hello' }, time: 1, rev: 1, userId: '1', sid: null }], users: [{ id: '1', name: 'Maya' }], lastRevision: 5, diagnostics: {}, tabs: [] };
    },
    async latestRevision() { return 5; },
    buildTimeline: () => ({ steps: [{ i: 0, time: 1, userId: '1', inserted: 5, deleted: 0, biggestInsert: 5, _norm: [] }], finalText: 'hello there', textAt: () => 'hello there' }),
    analyze: () => ({
      contributors: [{ id: '1', name: 'Maya', color: '#2F6FC4', share: .5, activeMinutes: 1 }, { id: '2', name: 'Sam', color: '#118A7E', share: .5, activeMinutes: 1 }],
      totals: { finalChars: 11, finalWords: 2, mutations: 2, activeMinutes: 1, pasteCount: 2, externalPastes: 1, internalPastes: 1, deleted: 0, spanDays: 1 },
      growth: [{ length: 1 }, { length: 11 }], sessions: [], heatmap: [], pastes: [], deletions: [],
      behavior: { enough: false }, calendar: {}, pasteThreshold: { value: 20, source: 'floor', samples: 0 },
      ownership: [[0, 6, '1', 0], [6, 3, '2', 1], [9, 2, '2', 2]]
    }),
    constants: {}
  };
  win.chrome = {
    runtime: { id: 'visor-test', lastError: null, getURL: (p) => `chrome-extension://visor/${p}`, sendMessage: (m, cb) => cb && cb({ ok: true }), onMessage: { addListener() {} } },
    storage: {
      local: {
        get: (k, cb) => { const keys = Array.isArray(k) ? k : [k]; const r = {}; keys.forEach((x) => { if (x in store) r[x] = store[x]; }); cb && cb(r); },
        set: (obj) => {
          const changes = {};
          for (const [k, v] of Object.entries(obj)) { changes[k] = { oldValue: store[k], newValue: v }; store[k] = v; }
          changeListeners.forEach((fn) => fn(changes, 'local'));
        }
      },
      onChanged: { addListener: (fn) => changeListeners.push(fn) }
    }
  };
  const ctx = vm.createContext(win);
  vm.runInContext(fs.readFileSync(`${DIR}/content.js`, 'utf8'), ctx, { filename: 'content.js' });
  vm.runInContext('probeResult = { editable: true, revisionHint: 0, liveTabs: [], ready: true };', ctx);
  return { win, document, clock, posted, store, run: (c) => vm.runInContext(c, ctx), hud: () => document.getElementById('visor-hud'), setStored: (o) => win.chrome.storage.local.set(o) };
}
const settle = async (h, ms = 1) => {
  for (let left = ms; left > 0; left -= 50) { h.clock.advance(Math.min(50, left)); for (let k = 0; k < 12; k++) await Promise.resolve(); }
};

(async () => {
  {
    const h = loadContent();
    await settle(h, 1000);
    h.document.getElementById('visor-hud-tab').fire('click', { target: h.document.getElementById('visor-hud-tab').querySelector('.vt-open') });
    await settle(h, 100);
    const btn = h.hud().querySelector('[data-act="aware"]');
    ck('the bar has an AWARE button', !!btn, true);
    ck('  it starts off', btn.getAttribute('aria-pressed'), 'false');
    ck('  and wears the NEW label until it is used', btn.querySelector('.vh-new').hidden, false);
    ck('  while it is off, the page is told nothing but "off"', h.posted.every((m) => m.source === 'VISOR_AWARE' && m.on === false), true);

    btn.fire('click', { target: btn });
    await settle(h, 50);
    ck('clicking it turns AWARE on', btn.getAttribute('aria-pressed'), 'true');
    ck('  the NEW label goes', btn.querySelector('.vh-new').hidden, true);
    ck('  the choice is stored, for the side panel and next time', [h.store.visor_aware, h.store.visor_aware_seen], [true, true]);
    const last = h.posted[h.posted.length - 1];
    ck('  the page is sent the text, who wrote what, and the colours',
      [last.on, last.text, last.owners, last.colors], [true, 'hello there', [[0, 6, 0, 0], [6, 3, 1, 0], [9, 2, 1, 0]], ['#2F6FC4', '#118A7E']]);
    const sentCount = h.posted.length;
    h.run('renderHUD(analysis)');
    ck('  a repaint of the bar doesn\'t resend the whole text', h.posted.length, sentCount);

    // ── the panel beside the page ──
    const panel = () => h.document.getElementById('visor-aware-panel');
    ck('with AWARE on, the panel is up', !!panel(), true);
    const rows = panel().querySelectorAll('[data-aw="person"]');
    ck('  with everyone in it, in their colours', rows.map((r) => r.getAttribute('data-id')), ['1', '2']);
    ck('  everyone shown to begin with', rows.map((r) => r.getAttribute('aria-pressed')), ['true', 'true']);

    panel().fire('click', { target: rows[1] });
    await settle(h, 50);
    ck('switching Sam off leaves his text uncoloured', h.posted[h.posted.length - 1].owners, [[0, 6, 0, 0]]);
    ck('  remembered for this document', h.store.visor_aware_hidden, { DOC1: ['2'] });
    ck('  and his row shows he is off', panel().querySelectorAll('[data-aw="person"]')[1].getAttribute('aria-pressed'), 'false');
    panel().fire('click', { target: panel().querySelectorAll('[data-aw="person"]')[1] });
    await settle(h, 50);
    ck('switching him back on colours him again', h.posted[h.posted.length - 1].owners.length, 3);
    ck('  and the document is forgotten from the list', h.store.visor_aware_hidden, {});

    ck('both paste switches start off', [panel().querySelector('[data-aw="paste-ext"]').getAttribute('aria-checked'), panel().querySelector('[data-aw="paste-int"]').getAttribute('aria-checked')], ['false', 'false']);
    panel().fire('click', { target: panel().querySelector('[data-aw="paste-ext"]') });
    await settle(h, 50);
    ck('"Pasted from outside" marks only the outside paste', h.posted[h.posted.length - 1].owners, [[0, 6, 0, 0], [6, 3, 1, 1], [9, 2, 1, 0]]);
    panel().fire('click', { target: panel().querySelector('[data-aw="paste-int"]') });
    await settle(h, 50);
    ck('"Pasted from within" adds the internal one', h.posted[h.posted.length - 1].owners, [[0, 6, 0, 0], [6, 3, 1, 1], [9, 2, 1, 2]]);
    panel().fire('click', { target: panel().querySelector('[data-aw="paste-ext"]') });
    await settle(h, 50);
    ck('  each turns off on its own', h.posted[h.posted.length - 1].owners, [[0, 6, 0, 0], [6, 3, 1, 0], [9, 2, 1, 2]]);
    ck('  both are remembered', [h.store.visor_aware_paste_ext, h.store.visor_aware_paste_int], [false, true]);
    ck('  with their counts in the panel', panel().querySelectorAll('em').map((e) => e.textContent), ['1', '1']);

    panel().fire('click', { target: panel().querySelector('[data-aw="min"]') });
    await settle(h, 50);
    ck('the panel folds to its title', [panel().classList.contains('is-min'), h.store.visor_aware_min], [true, true]);
    panel().fire('click', { target: panel().querySelector('[data-aw="min"]') });
    await settle(h, 50);
    ck('  and opens again', panel().classList.contains('is-min'), false);

    h.setStored({ visor_aware: false });
    await settle(h, 50);
    ck('switching it off in the side panel turns the bar\'s button off', btn.getAttribute('aria-pressed'), 'false');
    ck('  and the panel goes', !!panel(), false);
    ck('  and tells the page to remove the colours', h.posted[h.posted.length - 1], { source: 'VISOR_AWARE', on: false });

    h.setStored({ visor_aware: true });
    await settle(h, 50);
    ck('switching it on in the side panel colours again', h.posted[h.posted.length - 1].on, true);

    panel().fire('click', { target: panel().querySelector('[data-aw="off"]') });
    await settle(h, 50);
    ck('the panel\'s × turns AWARE off', [h.store.visor_aware, !!panel(), h.posted[h.posted.length - 1].on], [false, false, false]);

    h.setStored({ visor_aware: true });
    await settle(h, 50);
    h.run('visorShutdown()');
    ck('when Visor shuts down, the colours are removed', h.posted[h.posted.length - 1], { source: 'VISOR_AWARE', on: false });
    ck('  and the panel with them', !!panel(), false);
  }
  {
    const h = loadContent({ stored: { visor_aware: true, visor_aware_seen: true } });
    await settle(h, 1000);
    h.document.getElementById('visor-hud-tab').fire('click', { target: h.document.getElementById('visor-hud-tab').querySelector('.vt-open') });
    await settle(h, 100);
    const btn = h.hud().querySelector('[data-act="aware"]');
    ck('stored on: the bar opens with AWARE on and no NEW label', [btn.getAttribute('aria-pressed'), btn.querySelector('.vh-new').hidden], ['true', true]);
    ck('  and the page is coloured as soon as the history is read', h.posted.some((m) => m.on === true && m.text === 'hello there'), true);
  }

  {
    const h = loadContent({ stored: { visor_aware: true, visor_aware_seen: true, visor_aware_pastes: true } });
    await settle(h, 1000);
    h.document.getElementById('visor-hud-tab').fire('click', { target: h.document.getElementById('visor-hud-tab').querySelector('.vt-open') });
    await settle(h, 100);
    ck('the earlier single "Show pastes" setting turns both kinds on', h.posted[h.posted.length - 1].owners.map((o) => o[3]), [0, 1, 2]);
  }

  // ── 5. Theme: Light, Dark, System ──────────────────────────────────────────
  {
    const attrs = new Map();
    let systemDark = false;
    const mqListeners = [];
    const store = {};
    const changeListeners = [];
    const sandbox = {
      document: { documentElement: { setAttribute: (k, v) => attrs.set(k, v), getAttribute: (k) => attrs.get(k) ?? null, style: {} } },
      matchMedia: () => ({ get matches() { return systemDark; }, addEventListener: (t, fn) => mqListeners.push(fn) }),
      chrome: {
        runtime: { lastError: null },
        storage: {
          local: { get: (k, cb) => cb({ [k]: store[k] }), set: (o) => { const ch = {}; for (const [k, v] of Object.entries(o)) { ch[k] = { newValue: v }; store[k] = v; } changeListeners.forEach((fn) => fn(ch, 'local')); } },
          onChanged: { addListener: (fn) => changeListeners.push(fn) }
        }
      }
    };
    const ctx = vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(`${DIR}/theme.js`, 'utf8'), ctx, { filename: 'theme.js' });
    const run = (c) => vm.runInContext(c, ctx);
    ck('the theme opens light', [attrs.get('data-theme'), attrs.get('data-theme-choice')], ['light', 'light']);
    run('visorCycleTheme()');
    ck('one click: dark', [attrs.get('data-theme'), store.visor_theme], ['dark', 'dark']);
    run('visorCycleTheme()');
    ck('two clicks: System, which on a light computer is light', [attrs.get('data-theme'), attrs.get('data-theme-choice'), store.visor_theme], ['light', 'system', 'system']);
    systemDark = true; mqListeners.forEach((fn) => fn());
    ck('  and follows the computer when it goes dark', attrs.get('data-theme'), 'dark');
    run('visorCycleTheme()');
    ck('three clicks: back to light', [attrs.get('data-theme'), attrs.get('data-theme-choice')], ['light', 'light']);
    systemDark = false; mqListeners.forEach((fn) => fn());
    ck('  where the computer no longer matters', attrs.get('data-theme'), 'light');
    store.visor_theme = 'system'; systemDark = true;
    await new Promise((r) => run('visorInitTheme()').then(r));
    ck('a stored System choice resolves on load', [attrs.get('data-theme'), attrs.get('data-theme-choice')], ['dark', 'system']);
    sandbox.chrome.storage.local.set({ visor_theme: 'light' });
    ck('a choice made in another Visor window is followed', attrs.get('data-theme'), 'light');
    ck('an unknown stored value falls back to light', run('visorThemeChoice("sepia")'), 'light');
  }

  const failed = out.filter((x) => !x).length;
  console.log(failed ? `${failed} of ${out.length} checks FAILED` : `all passed (${out.length} checks)`);
  process.exit(failed ? 1 : 0);
})();
