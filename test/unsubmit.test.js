// Unsubmitting: open until the due date or the teacher's review, and never when
// the student couldn't write and hand it in again. Runs on a local PGlite store
// in a temp folder; nothing here reaches Firebase, Google or Gemini (their
// settings are blanked and pointed at a closed local port).
'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-unsubmit-'));
Object.assign(process.env, {
  VISOR_PLATFORM: '', DATABASE_URL: '',
  PGLITE_DIR: path.join(DATA, 'pglite'), VISOR_IMAGE_DIR: path.join(DATA, 'images'), VISOR_AUDIO_DIR: path.join(DATA, 'audio'),
  VISOR_DEV_LOGIN: '1', SESSION_SECRET: 'test-secret', NODE_ENV: 'test',
  GEMINI_API_KEY: '', GEMINI_VIA: 'apikey', GEMINI_BASE_URL: 'http://127.0.0.1:9', VERTEX_BASE_URL: 'http://127.0.0.1:9', DRIVE_API_BASE: 'http://127.0.0.1:9',
  GOOGLE_CLIENT_ID: '', GOOGLE_API_KEY: '', GOOGLE_APP_ID: '', CLASSROOM_IMPORT: ''
});

const test = require('node:test');
const assert = require('node:assert');
const app = require('../server');
const repo = require('../lib/repo');
const { unsubmitProblem } = require('../lib/sessions');

let server, base;
test.before(async () => {
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); fs.rmSync(DATA, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, redirect: 'manual', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    let data = null;
    try { data = await r.json(); } catch {}
    return { status: r.status, data };
  };
  return { get: u => call('GET', u), post: (u, b) => call('POST', u, b || {}) };
}
let people = 0;
async function signup(c, role, firstName, extra = {}) {
  const r = await c.post('/api/auth/signup', { email: `${firstName.toLowerCase()}${++people}@unsubmit.test`, password: 'secret12', firstName, lastName: 'Tester', role, ...(role === 'student' ? { over13: true } : {}), ...extra });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return r.data.user;
}
const inDays = n => new Date(Date.now() + n * 864e5).toISOString();

// A published essay, written and submitted
async function submitted({ dueAt = null, writing = { mode: 'open' } } = {}) {
  const t = client(), st = client();
  await signup(t, 'teacher', 'Tess');
  const cls = (await t.post('/api/classes', { name: 'Unsubmit' })).data.class;
  await signup(st, 'student', 'Stu', { classCode: cls.joinCode });
  const a = (await t.post(`/api/classes/${cls.id}/assignments`, { type: 'writing', title: 'Essay', dueAt, writing })).data.assignment;
  await t.post(`/api/assignments/${a.id}/publish`, {});
  const doc = (await st.get(`/api/write/${a.id}`)).data.doc;
  const started = await st.post(`/api/write/${doc.id}/sessions`, { surfaceId: 'one', surf: 'tab' });
  assert.strictEqual(started.status, 200, JSON.stringify(started.data));
  assert.strictEqual((await st.post(`/api/write/${doc.id}/submit`)).status, 200);
  return { t, st, cls, a, doc };
}
const unsubmit = (c, doc) => c.post(`/api/write/${doc.id}/unsubmit`);

test('a student can unsubmit, write again and resubmit, and the teacher can tell', async () => {
  const { t, st, a, doc } = await submitted({ dueAt: inDays(3) });
  assert.strictEqual((await st.get(`/api/write/${a.id}`)).data.unsubmitBlocked, null);
  assert.strictEqual((await st.get(`/api/assignments/${a.id}`)).data.doc.unsubmitBlocked, null);
  const r = await unsubmit(st, doc);
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.deepStrictEqual([r.data.doc.status, r.data.doc.submittedAt, r.data.doc.unsubmits], ['in-progress', null, 1]);
  const row = (await t.get(`/api/assignments/${a.id}`)).data.submissions[0];
  assert.deepStrictEqual([row.status, row.unsubmits], ['in-progress', 1]);
  assert.strictEqual((await st.post(`/api/write/${doc.id}/sessions`, { surfaceId: 'two', surf: 'tab' })).status, 200, 'writing again');
  assert.strictEqual((await st.post(`/api/write/${doc.id}/submit`)).status, 200);
  assert.deepStrictEqual([(await st.get(`/api/write/${a.id}`)).data.doc.status, (await repo.getRecord('doc', doc.id)).unsubmits], ['submitted', 1]);
});

test('with no due date it stays open until the teacher reviews it', async () => {
  const { st, doc } = await submitted();
  assert.strictEqual((await unsubmit(st, doc)).status, 200);
});

test('not after the due date', async () => {
  const { st, a, doc } = await submitted({ dueAt: inDays(1) });
  await repo.updateRecord('assignment', a.id, x => { x.dueAt = inDays(-1); });
  const r = await unsubmit(st, doc);
  assert.strictEqual(r.status, 409);
  assert.match(r.data.error, /due date has passed/);
  assert.match((await st.get(`/api/write/${a.id}`)).data.unsubmitBlocked, /due date has passed/);
  assert.strictEqual((await repo.getRecord('doc', doc.id)).status, 'submitted');
});

test('not once the teacher has saved feedback, returned or not', async () => {
  const saved = await submitted({ dueAt: inDays(3) });
  assert.strictEqual((await saved.t.post(`/api/review/${saved.doc.id}/feedback`, { comment: 'Good start' })).status, 200);
  const r = await unsubmit(saved.st, saved.doc);
  assert.strictEqual(r.status, 409);
  assert.match(r.data.error, /reviewed/);

  const back = await submitted({ dueAt: inDays(3) });
  await back.t.post(`/api/review/${back.doc.id}/feedback`, { comment: 'Done', returnToStudent: true });
  assert.strictEqual((await unsubmit(back.st, back.doc)).status, 409);
});

test('a teacher opening the essay isn’t a review, and an earlier review doesn’t count against a new submission', async () => {
  const { t, st, doc } = await submitted({ dueAt: inDays(3) });
  assert.strictEqual((await t.get(`/api/review/${doc.id}`)).status, 200);
  assert.strictEqual((await t.post(`/api/review/${doc.id}/feedback`, { comment: 'Keep going', returnToStudent: true, reopen: true })).status, 200);
  await new Promise(r => setTimeout(r, 5));
  assert.strictEqual((await st.post(`/api/write/${doc.id}/sessions`, { surfaceId: 'two', surf: 'tab' })).status, 200);
  assert.strictEqual((await st.post(`/api/write/${doc.id}/submit`)).status, 200);
  assert.strictEqual((await unsubmit(st, doc)).status, 200);
});

test('only the student, and only something submitted', async () => {
  const { t, st, doc } = await submitted({ dueAt: inDays(3) });
  assert.strictEqual((await unsubmit(t, doc)).status, 403);
  assert.strictEqual((await unsubmit(client(), doc)).status, 401);
  assert.strictEqual((await unsubmit(st, doc)).status, 200);
  assert.strictEqual((await unsubmit(st, doc)).status, 409, 'not twice');
});

test('not when the student couldn’t write and hand it in again', async () => {
  const now = Date.now(), at = new Date(now - 60000).toISOString();
  const doc = { status: 'submitted', submittedAt: at }, assignment = { publishedAt: at, dueAt: null, writing: {} };
  assert.strictEqual(unsubmitProblem({ doc, assignment, timeLeftMs: null, now }), null);
  assert.strictEqual(unsubmitProblem({ doc, assignment, timeLeftMs: 600000, now }), null);
  assert.match(unsubmitProblem({ doc, assignment, timeLeftMs: 0, now }), /used all of your time/);
  assert.match(unsubmitProblem({ doc, assignment: { ...assignment, writing: { windowEnd: at } }, timeLeftMs: null, now }), /window closed/);
  assert.match(unsubmitProblem({ doc: { ...doc, submittedBy: 'teacher' }, assignment, timeLeftMs: null, now }), /ended this session/);
  assert.match(unsubmitProblem({ doc, assignment: { ...assignment, publishedAt: null }, timeLeftMs: null, now }), /isn’t published/);
});
