// Adding people from the teacher's school: the list (students and teachers who
// chose the same school, with a search, marking who's already in the class)
// and adding picks (students join, teachers become co-teachers; anyone at
// another school, or already in, is skipped). Runs on a local PGlite store in a
// temp folder; nothing here reaches Firebase, Google or Gemini.
'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-school-'));
Object.assign(process.env, {
  VISOR_PLATFORM: '', DATABASE_URL: '',
  PGLITE_DIR: path.join(DATA, 'pglite'), VISOR_IMAGE_DIR: path.join(DATA, 'images'), VISOR_AUDIO_DIR: path.join(DATA, 'audio'),
  VISOR_DEV_LOGIN: '1', VISOR_SCHOOL_OPTIONAL: '1', SESSION_SECRET: 'test-secret', NODE_ENV: 'test',
  GEMINI_API_KEY: '', GEMINI_VIA: 'apikey', GEMINI_BASE_URL: 'http://127.0.0.1:9', VERTEX_BASE_URL: 'http://127.0.0.1:9', DRIVE_API_BASE: 'http://127.0.0.1:9',
  GOOGLE_CLIENT_ID: '', GOOGLE_API_KEY: '', GOOGLE_APP_ID: '', CLASSROOM_IMPORT: ''
});

const test = require('node:test');
const assert = require('node:assert');
const C = require('../lib/classes');
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
  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    let data = null;
    try { data = await r.json(); } catch {}
    return { status: r.status, data };
  };
  return { get: u => call('GET', u), post: (u, b) => call('POST', u, b || {}) };
}
let n = 0;
// These schools have nobody running them, the way every school did before
// facilitators (lib/schools.js): anyone can still pick one.
async function openSchool(name) {
  await repo.withCore(core => { if (!Object.values(core.orgs).some(o => o.name === name)) { const id = `org-${name.replace(/\W/g, '')}`; core.orgs[id] = { id, name, createdAt: new Date().toISOString() }; } });
}
async function signup(role, firstName, lastName, schoolName) {
  const c = client();
  if (schoolName) await openSchool(schoolName);
  const r = await c.post('/api/auth/signup', { email: `${firstName.toLowerCase()}${++n}@school.test`, password: 'secret12', firstName, lastName, role, ...(schoolName ? { schoolName } : {}), ...(role === 'student' ? { over13: true } : {}) });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  c.user = r.data.user;
  return c;
}

/* ---------------- lib/classes.js ---------------- */

test('lib: schoolPeople lists the same school, searches, marks the class, and pages', () => {
  const u = (id, role, orgId, firstName, lastName) => ({ id, role, orgId, firstName, lastName, email: `${id}@x.test` });
  const users = {
    me: u('me', 'teacher', 'A', 'Tess', 'Teacher'), t2: u('t2', 'teacher', 'A', 'Ana', 'Ortiz'), t3: u('t3', 'teacher', 'B', 'Bo', 'Other'),
    s1: u('s1', 'student', 'A', 'Sam', 'Zed'), s2: u('s2', 'student', 'A', 'Kim', 'Lee'), s3: u('s3', 'student', 'B', 'Al', 'Away'), s4: u('s4', 'student', null, 'No', 'School')
  };
  const core = { users, classes: {}, projects: {} };
  const cls = { id: 'c', teacherId: 'me', studentIds: ['s2'] };
  const ids = r => r.people.map(p => [p.user.id, p.inClass]);
  // students at school A only, sorted by last name, with s2 marked as already in
  assert.deepStrictEqual(ids(C.schoolPeople(core, cls, users.me, { role: 'student' })), [['s2', true], ['s1', false]]);
  // teachers: never the one asking
  assert.deepStrictEqual(ids(C.schoolPeople(core, cls, users.me, { role: 'teacher' })), [['t2', false]]);
  // search by name or email, every word must match
  assert.deepStrictEqual(ids(C.schoolPeople(core, cls, users.me, { q: 'sam' })), [['s1', false]]);
  assert.deepStrictEqual(ids(C.schoolPeople(core, cls, users.me, { q: 's2@x' })), [['s2', true]]);
  assert.deepStrictEqual(ids(C.schoolPeople(core, cls, users.me, { q: 'kim zed' })), []);
  // no school: refused
  assert.throws(() => C.schoolPeople(core, cls, { ...users.me, orgId: null }), { status: 400, message: 'Choose your school in Profile settings first.' });
  // at most SCHOOL_PAGE at a time, with the total
  for (let i = 0; i < C.SCHOOL_PAGE + 5; i++) users[`x${i}`] = u(`x${i}`, 'student', 'A', 'X', `Many${String(i).padStart(3, '0')}`);
  const big = C.schoolPeople(core, cls, users.me, {});
  assert.deepStrictEqual([big.people.length, big.total, big.more], [C.SCHOOL_PAGE, C.SCHOOL_PAGE + 7, true]);
});

test('lib: addFromSchool adds students and co-teachers, skips the rest', () => {
  const u = (id, role, orgId) => ({ id, role, orgId, firstName: id, lastName: '', email: `${id}@x.test` });
  const users = { me: u('me', 'teacher', 'A'), t2: u('t2', 'teacher', 'A'), t3: u('t3', 'teacher', 'B'), s1: u('s1', 'student', 'A'), s2: u('s2', 'student', 'A'), s3: u('s3', 'student', 'B') };
  const core = { users, classes: {}, projects: {} };
  const cls = { id: 'c', teacherId: 'me', studentIds: ['s2'] };
  const r = C.addFromSchool(core, cls, users.me, ['s1', 's1', 's2', 's3', 't2', 't3', 'me', 'nobody']);
  assert.deepStrictEqual([r.students, r.teachers], [1, 1]);
  assert.deepStrictEqual(r.skipped.map(x => [x.id, x.why]), [['s2', 'already in the class'], ['s3', 'not at your school'], ['t3', 'not at your school'], ['me', 'not at your school'], ['nobody', 'not at your school']]);
  assert.deepStrictEqual(cls.studentIds, ['s2', 's1']);
  assert.deepStrictEqual(C.teacherIdsOf(cls), ['me', 't2']);
  assert.throws(() => C.addFromSchool(core, cls, users.me, []), { status: 400, message: 'Pick at least one person to add.' });
  assert.throws(() => C.addFromSchool(core, cls, users.me, 'ok'), { status: 400 });
  assert.throws(() => C.addFromSchool(core, cls, users.me, Array.from({ length: 501 }, (_, i) => `z${i}`)), { status: 400, message: 'Add at most 500 people at a time.' });
  assert.throws(() => C.addFromSchool(core, cls, { ...users.me, orgId: null }, ['s1']), { status: 400 });
  // 20 teachers at most
  const full = { id: 'f', teacherId: 'me', studentIds: [], coTeacherIds: Array.from({ length: 19 }, (_, i) => `y${i}`) };
  assert.deepStrictEqual(C.addFromSchool(core, full, users.me, ['t2']).skipped.map(x => x.why), ['a class can have at most 20 teachers']);
});

/* ---------------- routes ---------------- */

test('routes: a teacher at a school lists and adds; others are refused', async () => {
  const tess = await signup('teacher', 'Tess', 'Teacher', 'Lincoln High');
  const ana = await signup('teacher', 'Ana', 'Ortiz', 'lincoln high'); // the same school, typed differently
  const sam = await signup('student', 'Sam', 'Zed', 'Lincoln High');
  const kim = await signup('student', 'Kim', 'Lee', 'Lincoln High');
  const al = await signup('student', 'Al', 'Away', 'Roosevelt Middle');
  const nosch = await signup('teacher', 'Nora', 'None');
  const cls = (await tess.post('/api/classes', { name: 'English 10' })).data.class;

  const list = await tess.get(`/api/classes/${cls.id}/school-people?role=student`);
  assert.strictEqual(list.status, 200);
  assert.strictEqual(list.data.school.name, 'Lincoln High');
  assert.deepStrictEqual(list.data.people.map(p => p.name), ['Kim Lee', 'Sam Zed']);
  // only what the picker shows
  assert.deepStrictEqual(Object.keys(list.data.people[0]).sort(), ['avatarColor', 'email', 'id', 'inClass', 'name', 'role']);
  const teachers = await tess.get(`/api/classes/${cls.id}/school-people?role=teacher&q=ana`);
  assert.deepStrictEqual(teachers.data.people.map(p => [p.name, p.role]), [['Ana Ortiz', 'teacher']]);

  // students, other teachers and teachers outside the class can't list or add
  for (const [who, code] of [[sam, 403], [ana, 403], [nosch, 403]]) {
    assert.strictEqual((await who.get(`/api/classes/${cls.id}/school-people`)).status, code);
    assert.strictEqual((await who.post(`/api/classes/${cls.id}/school-people`, { userIds: [kim.user.id] })).status, code);
  }

  const add = await tess.post(`/api/classes/${cls.id}/school-people`, { userIds: [sam.user.id, kim.user.id, ana.user.id, al.user.id] });
  assert.strictEqual(add.status, 200, JSON.stringify(add.data));
  assert.deepStrictEqual([add.data.students, add.data.teachers, add.data.skipped.map(x => x.why)], [2, 1, ['not at your school']]);
  assert.deepStrictEqual(add.data.class.students.map(s => s.name).sort(), ['Kim Lee', 'Sam Zed']);
  assert.deepStrictEqual(add.data.class.teachers.map(t => t.name), ['Tess Teacher', 'Ana Ortiz']);
  // now marked as in the class, and the student sees the class
  assert.deepStrictEqual((await tess.get(`/api/classes/${cls.id}/school-people`)).data.people.map(p => p.inClass), [true, true]);
  assert.ok((await sam.get('/api/classes')).data.classes.some(c => c.id === cls.id));
  // the new co-teacher lists from their own school (the same one here)
  assert.strictEqual((await ana.get(`/api/classes/${cls.id}/school-people?role=teacher`)).data.people.map(p => p.name).join(), 'Tess Teacher');

  // a teacher without a school is told to choose one
  const other = (await nosch.post('/api/classes', { name: 'Solo' })).data.class;
  const r = await nosch.get(`/api/classes/${other.id}/school-people`);
  assert.deepStrictEqual([r.status, r.data.error], [400, 'Choose your school in Profile settings first.']);
});
