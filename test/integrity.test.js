// A locked session holds up against a page that's lying: the extension reports by
// itself, the server sets the rules, and only the extension can be a side panel.
// Runs on a local PGlite store in a temp folder; nothing here reaches Firebase,
// Google or Gemini (their settings are blanked and pointed at a closed local port).
'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-integrity-'));
Object.assign(process.env, {
  VISOR_PLATFORM: '', DATABASE_URL: '',
  PGLITE_DIR: path.join(DATA, 'pglite'), VISOR_IMAGE_DIR: path.join(DATA, 'images'), VISOR_AUDIO_DIR: path.join(DATA, 'audio'),
  VISOR_DEV_LOGIN: '1', VISOR_SCHOOL_OPTIONAL: '1', SESSION_SECRET: 'test-secret', NODE_ENV: 'test',
  GEMINI_API_KEY: '', GEMINI_VIA: 'apikey', GEMINI_BASE_URL: 'http://127.0.0.1:9', VERTEX_BASE_URL: 'http://127.0.0.1:9', DRIVE_API_BASE: 'http://127.0.0.1:9',
  GOOGLE_CLIENT_ID: '', GOOGLE_API_KEY: '', GOOGLE_APP_ID: '', CLASSROOM_IMPORT: ''
});

const test = require('node:test');
const assert = require('node:assert');
const app = require('../server');
const repo = require('../lib/repo');
const S = require('../lib/sessions');

let server, base;
test.before(async () => {
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); fs.rmSync(DATA, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  const call = async (method, url, body, headers = {}) => {
    const r = await fetch(base + url, { method, redirect: 'manual', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    let data = null;
    try { data = await r.json(); } catch {}
    return { status: r.status, data };
  };
  return { get: (u, h) => call('GET', u, null, h), post: (u, b, h) => call('POST', u, b || {}, h) };
}
let n = 0;
const signup = (c, role, name, extra = {}) => c.post('/api/auth/signup', { email: `${name.toLowerCase()}${++n}@integrity.test`, password: 'secret12', firstName: name, lastName: 'Tester', role, ...(role === 'student' ? { over13: true } : {}), ...extra });

// A locked session that's running, with its extension connected
async function locked() {
  const t = client(), st = client();
  await signup(t, 'teacher', 'Tess');
  const cls = (await t.post('/api/classes', { name: 'Locked' })).data.class;
  await signup(st, 'student', 'Stu', { classCode: cls.joinCode });
  const a = (await t.post(`/api/classes/${cls.id}/assignments`, { type: 'writing', title: 'Essay', writing: { mode: 'locked', allowedSites: ['cdc.gov'], blockAiSites: true } })).data.assignment;
  await t.post(`/api/assignments/${a.id}/publish`, {});
  const doc = (await st.get(`/api/write/${a.id}`)).data.doc;
  const X = { 'X-Visor-Token': (await st.post('/api/ext/token')).data.token };
  const ack = await st.post('/api/ext/session/ack', { docId: doc.id, version: '4.5.0', hasHostPermission: true }, X);
  assert.strictEqual(ack.status, 200, JSON.stringify(ack.data));
  const s = await st.post(`/api/write/${doc.id}/sessions`, { surfaceId: 'tab', surf: 'tab', extPresent: true, fullscreen: true });
  assert.strictEqual(s.status, 200, JSON.stringify(s.data));
  await st.post('/api/ext/session/beat', { docId: doc.id, lockActive: true, hasHostPermission: true }, X);
  return { t, st, a, doc, X, ack: ack.data, H: { 'X-Visor-Session': s.data.token } };
}
const honest = { surfaceId: 'tab', surf: 'tab', focused: true, visible: true, fullscreen: true, extPresent: true };
const beat = (c, doc, H, body = honest) => c.post(`/api/write/${doc.id}/beat`, body, H);
const session = async doc => (await repo.listRecords('session', { docId: doc.id })).find(s => s.state !== 'ended');
const rowOf = async (t, a) => (await t.get(`/api/assignments/${a.id}/live`)).data.rows[0];

test('where the student went comes from the extension, past anything the page says', async () => {
  const { t, st, a, doc, X, H } = await locked();
  await beat(st, doc, H);
  assert.strictEqual((await session(doc)).pauses.length, 0);
  for (const [where, reason] of [['other-tab', 'left-tab'], ['other-window', 'left-window'], ['other-app', 'left-window'], ['other-desktop', 'left-window'], ['minimized', 'left-window']]) {
    const r = await st.post('/api/ext/session/presence', { docId: doc.id, where }, X);
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    await repo.updateRecord('session', (await session(doc)).id, s => { if (s.away) s.away.since -= 60000; });
    await beat(st, doc, H); // the page insists all is well
    const s = await session(doc), open = S.openPause(s);
    assert.ok(open, `${where}: paused`);
    const row = await rowOf(t, a);
    assert.deepStrictEqual([row.status, row.place], ['left', where]);
    assert.ok(row.reason, reason);
    await st.post('/api/ext/session/presence', { docId: doc.id, where: 'visor' }, X);
    await beat(st, doc, H);
    assert.strictEqual(S.openPause(await session(doc)), null, `${where}: back`);
  }
  assert.ok((await session(doc)).events.filter(e => e.type === 'ext-where').length >= 5);
});

test('a page that keeps saying it’s fine while the extension disagrees is flagged', async () => {
  const { t, st, a, doc, X, H } = await locked();
  await st.post('/api/ext/session/presence', { docId: doc.id, where: 'other-desktop' }, X);
  await repo.updateRecord('session', (await session(doc)).id, s => { s.extension.whereAt = new Date(Date.now() - 20000).toISOString(); });
  await beat(st, doc, H);
  assert.strictEqual((await rowOf(t, a)).mismatch, true);
  assert.ok((await session(doc)).events.some(e => e.type === 'page-mismatch'));
});

test('an extension that stops reporting pauses the session, whatever the page says', async () => {
  const { t, st, a, doc, X, H } = await locked();
  const past = new Date(Date.now() - 200000).toISOString();
  await repo.updateRecord('session', (await session(doc)).id, s => { s.extension.lastBeat = past; });
  await beat(st, doc, H);
  const s = await session(doc);
  assert.strictEqual(s.extension.silent, true);
  assert.ok(s.events.some(e => e.type === 'ext-missing' && e.detail === 'stopped reporting'));
  assert.strictEqual((await rowOf(t, a)).extSilent, true);
  await repo.updateRecord('session', s.id, x => { if (x.away) x.away.since -= 60000; });
  await beat(st, doc, H);
  assert.ok(S.openPause(await session(doc)), 'paused');
  await st.post('/api/ext/session/beat', { docId: doc.id, lockActive: true, hasHostPermission: true }, X);
  await beat(st, doc, H);
  const back = await session(doc);
  assert.deepStrictEqual([back.extension.silent, S.openPause(back)], [false, null]);
});

test('leaving things out of a beat doesn’t count as being in full screen', async () => {
  const { st, doc, H } = await locked();
  await beat(st, doc, H, { surfaceId: 'tab', surf: 'tab', focused: true, visible: true });
  const s = await session(doc);
  assert.strictEqual(s.surfaces.tab.focused, false);
  assert.strictEqual(s.awayReason, 'ext-missing');
  await beat(st, doc, H, { ...honest, fullscreen: undefined });
  assert.strictEqual((await session(doc)).awayReason, 'exit-fullscreen');
});

test('a copy that isn’t writing can’t keep a locked session looking present', () => {
  const s = S.newSession({ doc: { id: 'd', studentId: 'u', classId: 'c', assignmentId: 'a' }, assignment: { id: 'a', writing: { mode: 'locked' } }, userId: 'u', body: { surfaceId: 'tab', surf: 'tab' }, now: 1000 });
  s.extension = { ...s.extension, lastBeat: new Date(1000).toISOString() };
  S.applyBeat(s, { ...honest, surfaceId: 'second-laptop', holdsLease: false }, 2000);
  assert.strictEqual(s.surfaces['second-laptop'].focused, false);
});

test('only the extension can be a side panel', async () => {
  const { st, a, doc, X, H } = await locked();
  const cookieOnly = await st.get(`/api/write/${a.id}?surf=panel`);
  const claimed = await st.post(`/api/write/${doc.id}/beat`, { ...honest, surf: 'panel', fullscreen: false, surfaceId: 'fake-panel' }, { 'X-Visor-Session': cookieOnly.data.token });
  assert.strictEqual(claimed.status, 200);
  assert.strictEqual((await session(doc)).surfaces['fake-panel'].kind, 'tab', 'it stays a tab, which needs full screen');
  assert.strictEqual((await session(doc)).surfaces['fake-panel'].focused, false);
  const real = await st.get(`/api/write/${a.id}?surf=panel`, X);
  assert.strictEqual(real.status, 200);
  assert.ok(H);
});

test('the server sets a session’s rules, and a locked session can’t just be ended', async () => {
  const { st, doc, ack, H } = await locked();
  assert.deepStrictEqual([ack.settings.mode, ack.settings.allowedSites, ack.settings.blockAiSites], ['locked', ['cdc.gov'], true]);
  const r = await st.post(`/api/write/${doc.id}/end`, {}, H);
  assert.strictEqual(r.status, 409);
  assert.match(r.data.error, /ends when you submit/);
  assert.ok(await session(doc));
});

test('writing that arrives long after they left is kept, and noted', async () => {
  const { t, st, a, doc, X, H } = await locked();
  await st.post('/api/ext/session/presence', { docId: doc.id, where: 'other-app' }, X);
  const id = (await session(doc)).id;
  await repo.updateRecord('session', id, s => { s.away = null; s.pauses.push({ from: new Date(Date.now() - 60000).toISOString(), to: null, reason: 'left-window' }); });
  const d = await repo.getRecord('doc', doc.id);
  const r = await st.post(`/api/write/${doc.id}/ops`, { baseSeq: d.seq, ops: [{ k: 'i', at: d.text.length, s: 'typed away', t: Date.now(), src: 'type' }], surfaceId: 'tab' }, H);
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual((await repo.getRecord('doc', doc.id)).text.includes('typed away'), true);
  assert.strictEqual((await rowOf(t, a)).typedAway, true);
});

test('a second screen, a quick glance and developer tools all leave a mark', async () => {
  const { t, st, a, doc, X, H } = await locked();
  await st.post('/api/ext/session/presence', { docId: doc.id, where: 'visor', extended: true, devtools: true }, X);
  await beat(st, doc, H, { ...honest, focused: false });
  await beat(st, doc, H);
  const row = await rowOf(t, a);
  assert.deepStrictEqual([row.secondScreen, row.devtools, row.briefAways], [true, true, 1]);
});
