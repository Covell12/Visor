/* ============================================================================
 * Where the Visor button lands in Google Docs.
 * ----------------------------------------------------------------------------
 * The title bar, immediately right of version history — and when that is not
 * there, the next best place, down to floating in the corner. Also that it
 * settles: Docs rebuilds that row, and a button that re-inserted itself on
 * every mutation would fight the page for ever.
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
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `: ${JSON.stringify(got)} (want ${JSON.stringify(want)})`}`);
};

function load(build) {
  const { win, document, clock } = makeDom();
  win.chrome = {
    runtime: { id: 'visor-test', lastError: null, getURL: (p) => p, sendMessage: (m, cb) => cb && cb({ ok: true }), onMessage: { addListener() {} } },
    storage: { local: { get: (k, cb) => cb && cb({}), set() {} }, onChanged: { addListener() {} } }
  };
  win.VisorChangelog = { fetchChangelog: async () => ({ entries: [], users: [], lastRevision: 0, tabs: [] }), latestRevision: async () => 0 };
  if (build) build(document);
  const ctx = vm.createContext(win);
  vm.runInContext(fs.readFileSync(`${DIR}/content.js`, 'utf8'), ctx, { filename: 'content.js' });
  return { ctx, document, clock, run: (c) => vm.runInContext(c, ctx) };
}

const el = (document, tag, id, parent) => {
  const e = document.createElement(tag);
  if (id) e.id = id;
  (parent || document.body).appendChild(e);
  return e;
};

const settle = (h, ms = 2000) => h.clock.advance(ms);
const btnOf = (h) => h.document.getElementById('visor-launch-btn');

// ── The title bar, right of version history ────────────────────────────────
{
  let row, history, comments;
  const h = load((doc) => {
    row = el(doc, 'div', 'docs-titlebar-buttons');
    history = el(doc, 'div', 'docs-revisions-button', row);
    comments = el(doc, 'div', 'docs-docos-commentsbutton', row);
  });
  settle(h);
  const btn = btnOf(h);
  ck('the button is put in the title bar', btn && btn.parentElement.id, 'docs-titlebar-buttons');
  ck('  immediately right of version history', row.children.map((c) => c.id),
     ['docs-revisions-button', 'visor-launch-btn', 'docs-docos-commentsbutton']);
  ck('  and is not floating', btn.classList.contains('visor-launch-floating'), false);

  // Docs rebuilding the row must not start a tug of war.
  const before = row.children.length;
  for (let i = 0; i < 6; i++) settle(h, 3000);
  ck('  repeated checks leave it exactly where it is', row.children.map((c) => c.id),
     ['docs-revisions-button', 'visor-launch-btn', 'docs-docos-commentsbutton']);
  ck('  and do not add a second one', row.children.length, before);
}

// ── No version history control: still that row, ahead of comments ──────────
{
  let row;
  const h = load((doc) => {
    row = el(doc, 'div', 'docs-titlebar-buttons');
    el(doc, 'div', 'docs-docos-commentsbutton', row);
  });
  settle(h);
  ck('without a history button it still goes in the title bar', row.children[0].id, 'visor-launch-btn');
}

// ── Neither: the formatting toolbar, as before ─────────────────────────────
{
  let bar;
  const h = load((doc) => {
    bar = el(doc, 'div', 'docs-toolbar');
    el(doc, 'div', 'docs-toolbar-mode-switcher', bar);
  });
  settle(h);
  const btn = btnOf(h);
  ck('with no title bar it falls back to the toolbar', btn.parentElement.id, 'docs-toolbar');
  ck('  beside the Editing control', bar.children.map((c) => c.id), ['visor-launch-btn', 'docs-toolbar-mode-switcher']);
}

// ── A bare page: floating in the corner ────────────────────────────────────
{
  const h = load(null);
  settle(h);
  const btn = btnOf(h);
  ck('with nowhere to sit it floats in the corner', btn.classList.contains('visor-launch-floating'), true);
}

// ── The title bar arriving late lifts it out of the toolbar ────────────────
{
  let bar;
  const h = load((doc) => { bar = el(doc, 'div', 'docs-toolbar'); });
  settle(h);
  ck('a cold load starts in the toolbar', btnOf(h).parentElement.id, 'docs-toolbar');

  const row = el(h.document, 'div', 'docs-titlebar-buttons');
  el(h.document, 'div', 'docs-revisions-button', row);
  settle(h, 4000);
  ck('  and moves up once the title bar exists', btnOf(h).parentElement.id, 'docs-titlebar-buttons');
  ck('  leaving nothing behind', bar.children.length, 0);
}

// ── Lining up with the controls beside it ──────────────────────────────────
{
  let row, history;
  const h = load((doc) => {
    row = el(doc, 'div', 'docs-titlebar-buttons');
    history = el(doc, 'div', 'docs-revisions-button', row);
  });
  // Docs' control is 32px tall starting at y=10; the launcher would sit 5px low.
  history.rect = { top: 10, height: 32 };
  settle(h);
  const btn = btnOf(h);
  btn.rect = { top: 16, height: 30 };
  h.run('centreLauncher()');
  ck('the button is nudged onto its neighbour\'s centre line', btn.style.transform, 'translateY(-5.0px)');

  // Already centred: no nudge at all.
  btn.rect = { top: 11, height: 30 };
  h.run('centreLauncher()');
  ck('  and left alone when it is already centred', btn.style.transform, '');

  // A wild difference means the wrong container, not a centring problem.
  btn.rect = { top: 300, height: 30 };
  h.run('centreLauncher()');
  ck('  a nonsensical difference is ignored', btn.style.transform, '');
}

console.log(out.every(Boolean) ? `\nall passed (${out.length} checks)` : `\n${out.filter((x) => !x).length} FAILED`);
process.exit(out.every(Boolean) ? 0 : 1);
