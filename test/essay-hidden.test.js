// A student sees none of their essay outside a writing session, until a teacher
// returns it, and can't unsubmit once their time has run out. Runs on a local
// PGlite store in a temp folder; nothing here reaches Firebase, Google or Gemini
// (their settings are blanked and pointed at a closed local port).
'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-hidden-'));
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
const signup = (c, role, name, extra = {}) => c.post('/api/auth/signup', { email: `${name.toLowerCase()}${++n}@hidden.test`, password: 'secret12', firstName: name, lastName: 'Tester', role, ...(role === 'student' ? { over13: true } : {}), ...extra });

async function essay(writing = { mode: 'open' }, extra = {}) {
  const t = client(), st = client();
  await signup(t, 'teacher', 'Tess');
  const cls = (await t.post('/api/classes', { name: 'Hidden' })).data.class;
  await signup(st, 'student', 'Stu', { classCode: cls.joinCode });
  const a = (await t.post(`/api/classes/${cls.id}/assignments`, { type: 'writing', title: 'Essay', writing, ...extra })).data.assignment;
  await t.post(`/api/assignments/${a.id}/publish`, {});
  const doc = (await st.get(`/api/write/${a.id}`)).data.doc;
  return { t, st, cls, a, doc };
}
// Start a session and type something
async function write(st, doc, text) {
  const s = (await st.post(`/api/write/${doc.id}/sessions`, { surfaceId: 'tab', surf: 'tab' })).data;
  const r = await st.post(`/api/write/${doc.id}/ops`, { baseSeq: s.doc.seq, ops: [{ k: 'i', at: s.doc.text.length, s: text, t: Date.now(), src: 'type' }], surfaceId: 'tab' }, { 'X-Visor-Session': s.token });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return s;
}
const end = (st, doc, s) => st.post(`/api/write/${doc.id}/end`, {}, { 'X-Visor-Session': s.token });
const SECRET = 'A sentence only a session may show.';
const nothing = view => assert.deepStrictEqual([view.text, view.formats, view.sources, view.essayHidden], [null, [], [], true]);

test('the essay arrives with a session and leaves with it', async () => {
  const { st, a, doc } = await essay();
  nothing((await st.get(`/api/write/${a.id}`)).data.doc);
  const s = await write(st, doc, SECRET);
  const during = (await st.get(`/api/write/${a.id}`)).data;
  assert.strictEqual(during.doc.text, SECRET);
  assert.strictEqual(typeof during.imageToken, 'string');
  assert.strictEqual((await end(st, doc, s)).status, 200);
  const after = await st.get(`/api/write/${a.id}`);
  nothing(after.data.doc);
  assert.strictEqual(after.data.imageToken, null);
  assert.strictEqual(JSON.stringify(after.data).includes(SECRET), false, 'nowhere in the page’s data');
  assert.strictEqual(after.data.doc.stats.words, 7, 'the count isn’t the essay');
  const edits = await st.get(`/api/write/${doc.id}/ops`);
  assert.strictEqual(edits.status, 403);
  assert.strictEqual((await st.post(`/api/write/${doc.id}/sources`, { source: { title: 'A', url: 'https://example.org/a' } })).status, 403);
});

test('submitting hides it, and every answer leaves it out', async () => {
  const { st, a, doc } = await essay();
  await write(st, doc, SECRET);
  const sub = await st.post(`/api/write/${doc.id}/submit`);
  assert.strictEqual(sub.status, 200);
  nothing(sub.data.doc);
  nothing((await st.get(`/api/write/${a.id}`)).data.doc);
  const un = await st.post(`/api/write/${doc.id}/unsubmit`);
  assert.strictEqual(un.status, 200);
  nothing(un.data.doc);
  assert.strictEqual(JSON.stringify((await st.get('/api/me/export')).data).includes(SECRET), false, 'Download my data doesn’t get round it');
});

test('a teacher always reads it, and a returned essay opens for the student', async () => {
  const { t, st, a, doc } = await essay();
  await write(st, doc, SECRET);
  await st.post(`/api/write/${doc.id}/submit`);
  assert.strictEqual((await t.get(`/api/review/${doc.id}`)).data.doc.text, SECRET);
  await t.post(`/api/review/${doc.id}/feedback`, { comment: 'Good', returnToStudent: true });
  const back = (await st.get(`/api/write/${a.id}`)).data;
  assert.deepStrictEqual([back.doc.text, back.doc.feedback.comment, back.doc.essayHidden], [SECRET, 'Good', undefined]);
  assert.strictEqual((await st.get(`/api/write/${doc.id}/ops`)).status, 200);
  assert.ok(JSON.stringify((await st.get('/api/me/export')).data).includes(SECRET));
});

test('reopened for more writing, it’s back to sessions only', async () => {
  const { t, st, a, doc } = await essay();
  await write(st, doc, SECRET);
  await st.post(`/api/write/${doc.id}/submit`);
  await t.post(`/api/review/${doc.id}/feedback`, { comment: 'More', returnToStudent: true, reopen: true });
  const view = (await st.get(`/api/write/${a.id}`)).data.doc;
  nothing(view);
  assert.strictEqual(view.feedback.comment, 'More', 'the feedback still shows');
});

test('with time left it can be unsubmitted; with the time used up it can’t, and it says so', async () => {
  const { st, a, doc } = await essay({ mode: 'open', timeLimitMin: 45 });
  await write(st, doc, SECRET);
  await st.post(`/api/write/${doc.id}/submit`);
  assert.strictEqual((await st.get(`/api/write/${a.id}`)).data.unsubmitBlocked, null);
  assert.strictEqual((await st.get(`/api/assignments/${a.id}`)).data.doc.unsubmitBlocked, null);
  // All 45 minutes went in that session
  const session = (await repo.listRecords('session', { docId: doc.id }))[0];
  await repo.updateRecord('session', session.id, s => { s.endedAt = new Date(Date.parse(s.startedAt) + 45 * 60000).toISOString(); });
  const said = /used all of your time/;
  assert.match((await st.get(`/api/write/${a.id}`)).data.unsubmitBlocked, said);
  assert.match((await st.get(`/api/assignments/${a.id}`)).data.doc.unsubmitBlocked, said);
  const r = await st.post(`/api/write/${doc.id}/unsubmit`);
  assert.strictEqual(r.status, 409);
  assert.match(r.data.error, said);
  assert.strictEqual((await repo.getRecord('doc', doc.id)).status, 'submitted');
});

test('when the clock itself runs out and submits it, it stays submitted', async () => {
  const { st, a, doc } = await essay({ mode: 'open', timeLimitMin: 45, autoSubmitOnTimeUp: true });
  await write(st, doc, SECRET);
  const session = (await repo.listRecords('session', { docId: doc.id }))[0];
  const ago = m => new Date(Date.now() - m * 60000).toISOString();
  await repo.updateRecord('session', session.id, s => { s.startedAt = ago(46); s.lastBeat = ago(0.5); s.deadlineAt = ago(1); });
  const seen = (await st.get(`/api/write/${a.id}`)).data;
  assert.strictEqual(seen.doc.status, 'submitted', 'the time limit submitted it');
  assert.match(seen.unsubmitBlocked, /used all of your time/);
  assert.strictEqual((await st.post(`/api/write/${doc.id}/unsubmit`)).status, 409);
});
