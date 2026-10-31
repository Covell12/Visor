/* ============================================================================
 * The Docs-only build (tools/build-docs.js): Google Docs history, and nothing
 * of Visor Classroom.
 * ----------------------------------------------------------------------------
 *   1. What the build contains and asks for.
 *   2. Its service worker runs with only the v3.6 permissions: no session
 *      modules, no session APIs, and the side panel still opens.
 *   3. Its content script never offers anything to Visor Classroom.
 * Built into a temporary folder; nothing reaches Google or the Visor site.
 * ==========================================================================*/

'use strict';

const fs = require('fs');
const os = require('os');
const vm = require('vm');
const path = require('path');
const { makeDom } = require('./dom');
const { build } = require('../tools/build-docs.js');

const out = [];
const ck = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  out.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `: ${JSON.stringify(got)} (want ${JSON.stringify(want)})`}`);
};

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-docs-'));
build(OUT);
const read = (f) => fs.readFileSync(path.join(OUT, f), 'utf8');
const m = JSON.parse(read('manifest.json'));

// ── 1. What it contains and asks for ─────────────────────────────────────────
ck('the Docs build asks only for what the Web Store\'s v3.6 did', m.permissions, ['storage', 'sidePanel', 'tabs']);
ck('  on Google Docs and Slides only', m.host_permissions, ['https://docs.google.com/document/*', 'https://docs.google.com/presentation/*']);
ck('  with no optional access to other sites and no cite shortcut', [m.optional_host_permissions, m.commands], [undefined, undefined]);
ck('  versioned past the listing\'s 3.6, under its name', [m.version, m.name], ['3.7.0', 'Visor — Who Wrote What: Google Docs History']);
ck('  no script on the Visor website', m.content_scripts.some((cs) => cs.js.includes('site-bridge.js')), false);
ck('  AWARE and the history are there', m.content_scripts.flatMap((cs) => cs.js), ['page-probe.js', 'aware.js', 'edition.js', 'changelog.js', 'shares.js', 'content.js']);
ck('  none of Visor Classroom\'s files', ['session-bg.js', 'lockdown.js', 'research.js', 'cite.js', 'sessionpanel.html', 'blocked.html', 'permission.html', 'config.js', 'site-bridge.js'].filter((f) => fs.existsSync(path.join(OUT, f))), []);
ck('  it says it is the Docs edition', /VISOR_EDITION = 'docs'/.test(read('edition.js')), true);
ck('  the side panel doesn\'t load Visor Classroom\'s config', /config\.js/.test(read('sidepanel.html')), false);
ck('  and hides the Send to Visor box', read('sidepanel.html').match(/class="[^"]*classroom-only[^"]*"/g).length, 2);

// ── The Web Store release: both, without the dev address ─────────────────────
{
  const { build: buildRelease } = require('../tools/build-release.js');
  const REL = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-release-'));
  buildRelease(REL);
  const rel = (f) => fs.readFileSync(path.join(REL, f), 'utf8');
  const rm = JSON.parse(rel('manifest.json'));
  ck('the release is the Classroom edition', /VISOR_EDITION = 'classroom'/.test(rel('edition.js')), true);
  ck('  with the writing-session code in it', ['session-bg.js', 'lockdown.js', 'research.js', 'cite.js', 'site-bridge.js', 'sessionpanel.html', 'blocked.html', 'permission.html'].filter((f) => !fs.existsSync(path.join(REL, f))), []);
  ck('  and AWARE', rm.content_scripts.flatMap((cs) => cs.js).includes('aware.js'), true);
  ck('  the bridge runs on the Visor site only', rm.content_scripts.find((cs) => cs.js.includes('site-bridge.js')).matches, ['https://visor-ed.web.app/*', 'https://visor-ed.firebaseapp.com/*']);
  ck('  and localhost isn\'t trusted as Visor', /localhost/.test(rel('config.js')), false);
  ck('  no tests, docs or tools in it', ['tests', 'docs', 'tools', 'SETUP.md', 'STORE-LISTING.md'].filter((f) => fs.existsSync(path.join(REL, f))), []);
  ck('  the summary fits the store\'s 132 characters', rm.description.length <= 132, true);
  ck('  and the name is the one the connect page tells students to install', rm.name, 'Visor — Writing Sessions & Google Docs History');
  fs.rmSync(REL, { recursive: true, force: true });
}

// ── 2. The service worker, with only the v3.6 permissions ────────────────────
{
  const imported = [];
  const setOptions = [];
  const listeners = { message: [], updated: [] };
  const evt = (arr) => ({ addListener: (fn) => arr.push(fn) });
  const chrome = {
    runtime: { onInstalled: evt([]), onMessage: evt(listeners.message), lastError: null },
    sidePanel: { setPanelBehavior: async () => {}, setOptions: async (o) => { setOptions.push(o); }, open: async () => {} },
    tabs: { onUpdated: evt(listeners.updated), onActivated: evt([]), onRemoved: evt([]), get: async (id) => ({ id, url: 'https://docs.google.com/document/d/X/edit' }) }
    // no alarms, webNavigation, contextMenus, declarativeNetRequest, scripting:
    // the Docs build doesn't have them, so touching them would throw
  };
  const ctx = vm.createContext({ chrome, console, setTimeout, clearTimeout, URL, Promise });
  ctx.globalThis = ctx;
  ctx.importScripts = (...files) => files.forEach((f) => { imported.push(f); vm.runInContext(read(f), ctx, { filename: f }); });
  let loaded = true;
  try { vm.runInContext(read('background.js'), ctx, { filename: 'background.js' }); } catch (e) { loaded = String(e); }
  ck('the service worker starts', loaded, true);
  ck('  loading nothing but the edition', imported, ['edition.js']);
  (async () => {
    let reply = null;
    listeners.message.forEach((fn) => fn({ type: 'OPEN_SIDE_PANEL', tabId: 7 }, {}, (r) => { reply = r; }));
    await new Promise((r) => setTimeout(r, 10));
    ck('  the toolbar opens the Docs side panel', [setOptions[0] && setOptions[0].path, reply && reply.ok], ['sidepanel.html', true]);
    let threw = false;
    try { listeners.updated.forEach((fn) => fn(7, { url: 'https://docs.google.com/document/d/X/edit#heading=h.1' }, { id: 7, url: 'https://docs.google.com/document/d/X/edit' })); } catch (_) { threw = true; }
    await new Promise((r) => setTimeout(r, 10));
    ck('  and keeps it on its Doc without any writing-session state', threw, false);
    let bridged = 'no reply';
    const kept = listeners.message.map((fn) => fn({ channel: 'visor-bridge', type: 'PING' }, { tab: { id: 1 }, url: 'https://visor-ed.web.app/' }, (r) => { bridged = r; }));
    ck('  a message from the Visor website gets no answer', [kept.every((k) => k === false), bridged], [true, 'no reply']);
    contentPart();
  })();
}

// ── 3. The content script offers nothing to Visor Classroom ──────────────────
function contentPart() {
  const { win, document, clock } = makeDom();
  const sent = [];
  win.location.origin = 'https://docs.google.com';
  win.postMessage = () => {};
  win.VisorChangelog = {
    async fetchChangelog() { return { entries: [{ mutation: { ty: 'is', ibi: 1, s: 'x' }, time: 1, rev: 1, userId: '1', sid: null }], users: [{ id: '1', name: 'Maya' }], lastRevision: 5, diagnostics: {}, tabs: [] }; },
    async latestRevision() { return 5; },
    buildTimeline: () => ({ steps: [{ i: 0, time: 1, userId: '1', inserted: 5, deleted: 0, biggestInsert: 5, _norm: [] }], finalText: 'hello', textAt: () => 'hello' }),
    analyze: () => ({
      contributors: [{ id: '1', name: 'Maya', color: '#2F6FC4', inserted: 5, share: 1, activeMinutes: 1 }],
      totals: { finalChars: 5, finalWords: 1, mutations: 1, activeMinutes: 1, pasteCount: 0, deleted: 0, spanDays: 1 },
      growth: [], sessions: [], heatmap: [], pastes: [], deletions: [], behavior: { enough: false }, calendar: {},
      pasteThreshold: { value: 20 }, ownership: [[0, 5, '1', 0]]
    }),
    constants: {}
  };
  win.chrome = {
    runtime: { id: 't', lastError: null, getURL: (p) => p, sendMessage: (msg, cb) => { sent.push(msg && msg.type); if (cb) cb({ ok: true, linked: true }); }, onMessage: { addListener() {} } },
    storage: { local: { get: (k, cb) => cb && cb({}), set() {} }, onChanged: { addListener() {} } }
  };
  const ctx = vm.createContext(win);
  for (const f of ['edition.js', 'shares.js', 'content.js']) vm.runInContext(read(f), ctx, { filename: f });
  vm.runInContext('probeResult = { editable: true, revisionHint: 0, liveTabs: [], ready: true };', ctx);
  (async () => {
    const settle = async (ms) => { for (let l = ms; l > 0; l -= 50) { clock.advance(50); for (let k = 0; k < 12; k++) await Promise.resolve(); } };
    await settle(6000);   // past the 4 s at which a linked Doc used to be read on its own
    const tab = document.getElementById('visor-hud-tab');
    tab.fire('click', { target: tab.querySelector('.vt-open') });
    await settle(500);
    ck('the content script never asks whether this Doc is linked to Visor', sent.includes('VISOR_IS_LINKED'), false);
    ck('  and sends no report anywhere', sent.includes('VISOR_AUTO_SEND'), false);
    ck('  while the bar, with AWARE, works as before', [!!document.getElementById('visor-hud'), !!document.getElementById('visor-hud').querySelector('[data-act="aware"]')], [true, true]);

    fs.rmSync(OUT, { recursive: true, force: true });
    const failed = out.filter((x) => !x).length;
    console.log(failed ? `${failed} of ${out.length} checks FAILED` : `all passed (${out.length} checks)`);
    process.exit(failed ? 1 : 0);
  })();
}
