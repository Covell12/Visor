// public/ext.js: how the page decides whether it can reach the extension, and
// what /extension/connect says when it can't. A false "not installed" is what
// this guards: an extension installed or updated while the tab was open only
// reaches the page after a real reload, and a sleeping worker can be slow.
// Runs in a vm with stand-ins for the browser; nothing here leaves the process.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const test = require('node:test');
const assert = require('node:assert');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public', 'ext.js'), 'utf8');

// marked: the page as site-bridge.js leaves it. answer: what the bridge replies
// to a message, or null for silence.
function load({ marked = false, answer = null, running = false } = {}) {
  const timers = [], routes = {}, listeners = [];
  const window = {
    addEventListener: (_, fn) => listeners.push(fn),
    postMessage(m) {
      const body = answer && answer(m);
      if (body) listeners.forEach(fn => fn({ source: window, origin: 'https://visor.test', data: { source: 'visor-ext', replyTo: m.id, ...body } }));
    }
  };
  const ctx = vm.createContext({
    window, location: { origin: 'https://visor.test', pathname: '/extension/connect' },
    document: { documentElement: { dataset: marked ? { visorExtension: '4.3.0' } : {} } },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: () => {},
    VisorRouter: { add: (p, fn) => { routes[p] = fn; }, title: () => {} },
    me: { id: 'u1' }, I: { refresh: '', check: '', puzzle: '' }, esc: String, crumbs: () => '',
    api: async () => ({ connected: false }),
    Image: class { set src(url) { assert.match(url, /^chrome-extension:\/\/mienldgcindjfiinlbmjibgmemnapkog\//); running ? this.onload() : this.onerror(); } }
  });
  vm.runInContext(SOURCE, ctx);
  return { VisorExt: window.VisorExt, timers, route: routes['/extension/connect'] };
}

test('an unmarked page gives up after 1.5 s: there is no bridge to answer', async () => {
  const { VisorExt, timers } = load();
  const pending = VisorExt.ping();
  assert.strictEqual(timers[0].ms, 1500);
  timers[0].fn();
  assert.strictEqual((await pending).installed, false);
});

test('a marked page waits for a sleeping worker instead of calling it missing', async () => {
  const { VisorExt, timers } = load({ marked: true, answer: () => ({ ok: true, version: '4.3.0' }) });
  const p = await VisorExt.ping();
  assert.strictEqual(timers[0].ms, 5000);
  assert.strictEqual(p.installed, true);
  assert.strictEqual(p.version, '4.3.0');
});

test('a bridge left behind by an update reports gone', async () => {
  const { VisorExt } = load({ marked: true, answer: () => ({ ok: false, gone: true }) });
  const p = await VisorExt.ping();
  assert.strictEqual(p.installed, false);
  assert.strictEqual(p.gone, true);
});

test('/extension/connect offers a real reload, the only thing that brings a bridge in', async () => {
  const silent = load();
  const el = { innerHTML: '' };
  const shown = silent.route(el);
  await new Promise(r => setImmediate(r));
  silent.timers[0].fn();
  await shown;
  assert.match(el.innerHTML, /onclick="location\.reload\(\)"/);
  assert.match(el.innerHTML, /Site access/);
  assert.doesNotMatch(el.innerHTML, /VisorRouter\.render|isn’t installed/);
});

test('/extension/connect reports what it found when it can\'t reach the extension', async () => {
  const run = async opts => {
    const page = load(opts), el = { innerHTML: '' }, shown = page.route(el);
    await new Promise(r => setImmediate(r));
    page.timers[0].fn();
    await shown;
    return el.innerHTML;
  };
  assert.match(await run({}), /Visor isn’t on this page · no answer · Web Store copy not running/);
  assert.match(await run({ running: true }), /Visor isn’t on this page · no answer · Web Store copy running/);
  assert.match(await run({ marked: true, running: true }), /Visor 4\.3\.0 is on this page · no answer · Web Store copy running/);
});

test('/extension/connect tells an updated extension apart from a missing one', async () => {
  const el = { innerHTML: '' };
  await load({ marked: true, answer: () => ({ ok: false, gone: true }) }).route(el);
  assert.match(el.innerHTML, /updated or turned off after this page opened/);
  assert.match(el.innerHTML, /onclick="location\.reload\(\)"/);
  assert.doesNotMatch(el.innerHTML, /Install/);
});
