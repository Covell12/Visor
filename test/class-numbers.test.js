// The numbers on Home, the class page and People: what they count, and that a
// student gets only their own. Runs on a local PGlite store in a temp folder;
// nothing here reaches Firebase, Google or Gemini (their settings are blanked
// and pointed at a closed local port).
'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-numbers-'));
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

let server, base;
test.before(async () => {
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); fs.rmSync(DATA, { recursive: true, force: true }); });

// A signed-in person: keeps the __session cookie between calls. upload()
// sends raw bytes, the way the editor sends a picture.
function client() {
  let cookie = '';
  const call = async (method, url, body, headers = {}) => {
    const raw = Buffer.isBuffer(body);
    const r = await fetch(base + url, {
      method, redirect: 'manual',
      headers: { ...(body && !raw ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: raw ? body : body ? JSON.stringify(body) : undefined
    });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const buf = Buffer.from(await r.arrayBuffer());
    let data = null;
    try { data = JSON.parse(buf.toString('utf8')); } catch {}
    return { status: r.status, data, buf };
  };
  return {
    get: (u, h) => call('GET', u, null, h), post: (u, b, h) => call('POST', u, b || {}, h), patch: (u, b) => call('PATCH', u, b), del: (u, b) => call('DELETE', u, b),
    upload: (u, buf, h = {}) => call('POST', u, buf, { 'Content-Type': 'image/png', ...h })
  };
}

let people = 0;
async function signup(c, role, firstName, extra = {}) {
  const email = `${firstName.toLowerCase()}${++people}@numbers.test`;
  const r = await c.post('/api/auth/signup', { email, password: 'secret12', firstName, lastName: 'Tester', role, ...(role === 'student' ? { over13: true } : {}), ...extra });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return r.data.user;
}

// Two students; one essay submitted, one started, one more essay left a draft
async function classWithWork() {
  const t = client(), one = client(), two = client();
  await signup(t, 'teacher', 'Tess');
  const cls = (await t.post('/api/classes', { name: 'Numbers' })).data.class;
  const A = await signup(one, 'student', 'Ana', { classCode: cls.joinCode });
  const B = await signup(two, 'student', 'Ben', { classCode: cls.joinCode });
  const dueAt = new Date(Date.now() + 3 * 864e5).toISOString();
  const a = (await t.post(`/api/classes/${cls.id}/assignments`, { type: 'writing', title: 'Essay', dueAt, writing: { mode: 'locked', timeLimitMin: 40, minWords: 200, maxWords: 400 } })).data.assignment;
  await t.post(`/api/assignments/${a.id}/publish`, {});
  await t.post(`/api/classes/${cls.id}/assignments`, { type: 'writing', title: 'Draft', writing: { mode: 'open' } });
  const docA = (await one.get(`/api/write/${a.id}`)).data.doc, docB = (await two.get(`/api/write/${a.id}`)).data.doc;
  await one.post(`/api/write/${docA.id}/sessions`, { surfaceId: 'one', surf: 'tab' });
  await one.post(`/api/write/${docA.id}/submit`, {});
  await repo.updateRecord('doc', docA.id, d => { d.stats.words = 250; });
  await repo.updateRecord('doc', docB.id, d => { d.status = 'in-progress'; d.stats.words = 40; });
  return { t, one, two, cls, A, B, a };
}

test('a class’s numbers count published essays and current students', async () => {
  const { t, cls, A, B } = await classWithWork();
  const c = (await t.get(`/api/classes/${cls.id}`)).data.class;
  assert.deepStrictEqual([c.assignmentCount, c.published, c.expected, c.handedIn, c.toReview, c.returned, c.inProgress, c.words], [2, 1, 2, 1, 1, 0, 1, 290]);
  assert.deepStrictEqual([c.upcomingCount, c.dueThisWeek], [1, 1]);
  assert.deepStrictEqual([c.rosterStats[A.id].handedIn, c.rosterStats[A.id].inProgress, c.rosterStats[A.id].words], [1, 0, 250]);
  assert.deepStrictEqual([c.rosterStats[B.id].handedIn, c.rosterStats[B.id].inProgress, c.rosterStats[B.id].words], [0, 1, 40]);
  assert.ok(c.rosterStats[A.id].lastActive);
  const listed = (await t.get('/api/classes')).data.classes.find(x => x.id === cls.id);
  assert.deepStrictEqual([listed.expected, listed.handedIn, listed.words], [2, 1, 290]);
});

test('a removed student’s work stops counting', async () => {
  const { t, cls, A } = await classWithWork();
  const r = await t.del(`/api/classes/${cls.id}/students/${A.id}`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  const c = (await t.get(`/api/classes/${cls.id}`)).data.class;
  assert.deepStrictEqual([c.expected, c.handedIn, c.words, c.rosterStats[A.id]], [1, 0, 40, undefined]);
});

test('a student gets their own numbers and nobody else’s', async () => {
  const { one, cls, a } = await classWithWork();
  const r = await one.get(`/api/classes/${cls.id}`);
  for (const key of ['rosterStats', 'expected', 'handedIn', 'toReview', 'returned', 'inProgress', 'words', 'published', 'activeSessions']) {
    assert.strictEqual(key in r.data.class, false, key);
  }
  assert.deepStrictEqual([r.data.class.submitted, r.data.class.assignmentCount, r.data.class.upcomingCount], [1, 1, 0]);
  const listed = (await one.get('/api/classes')).data.classes.find(x => x.id === cls.id);
  for (const key of ['expected', 'handedIn', 'words']) assert.strictEqual(key in listed, false, key);
  const item = r.data.assignments.find(x => x.id === a.id);
  assert.deepStrictEqual([item.mode, item.minWords, item.maxWords], ['locked', 200, 400]);
  assert.strictEqual('timeLimitMin' in item, false, 'a student’s time limit depends on their accommodations');
  assert.strictEqual('stats' in item, false);
  assert.strictEqual(r.data.assignments.some(x => x.title === 'Draft'), false);
});

test('the teacher’s list of assignments carries the session’s settings', async () => {
  const { t, cls, a } = await classWithWork();
  const item = (await t.get(`/api/classes/${cls.id}`)).data.assignments.find(x => x.id === a.id);
  assert.deepStrictEqual([item.mode, item.timeLimitMin, item.minWords, item.maxWords], ['locked', 40, 200, 400]);
});
