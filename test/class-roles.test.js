// Class roles beyond the owner: co-teachers, assistant teachers and advisors.
// All of them have a teacher's powers. Advisors aren't listed as teachers, and
// nothing a student receives names them. Assistant teachers can't add or remove
// teachers or advisors. Runs on a local PGlite store in a temp folder; nothing
// here reaches Firebase, Google or Gemini (their settings are blanked and
// pointed at a closed local port).
'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-roles-'));
Object.assign(process.env, {
  VISOR_PLATFORM: '', DATABASE_URL: '',
  PGLITE_DIR: path.join(DATA, 'pglite'), VISOR_IMAGE_DIR: path.join(DATA, 'images'), VISOR_AUDIO_DIR: path.join(DATA, 'audio'),
  VISOR_DEV_LOGIN: '1', SESSION_SECRET: 'test-secret', NODE_ENV: 'test',
  GEMINI_API_KEY: '', GEMINI_VIA: 'apikey', GEMINI_BASE_URL: 'http://127.0.0.1:9', VERTEX_BASE_URL: 'http://127.0.0.1:9', DRIVE_API_BASE: 'http://127.0.0.1:9',
  GOOGLE_CLIENT_ID: '', GOOGLE_API_KEY: '', GOOGLE_APP_ID: '', CLASSROOM_IMPORT: ''
});

const test = require('node:test');
const assert = require('node:assert');
const C = require('../lib/classes');
const app = require('../server');
const repo = require('../lib/repo');

// The smallest real PNG (1×1)
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

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
// A new account; the email is firstname<n>@roles.test
async function signup(c, role, firstName, lastName, extra = {}) {
  const email = `${firstName.toLowerCase()}${++people}@roles.test`;
  const r = await c.post('/api/auth/signup', { email, password: 'secret12', firstName, lastName, role, ...(role === 'student' ? { over13: true } : {}), ...extra });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return r.data.user;
}
const newClass = async (teacher, name) => (await teacher.post('/api/classes', { name })).data.class;
// The teacher view's entry for a user, and the same without the email
const entry = (u, owner) => ({ id: u.id, name: u.name, avatarColor: null, owner, email: u.email });
const noEmail = ({ email, ...rest }) => rest;


const STAFF_ONLY = 'Assistant teachers can’t add or remove teachers or advisors.';

// A class with one person in each role, each signed in
async function staffedClass(name) {
  const owner = client(), co = client(), assistant = client(), advisor = client(), stu = client();
  const O = await signup(owner, 'teacher', 'Olive', 'Owner');
  const T = await signup(co, 'teacher', 'Theo', 'Coteacher');
  const A = await signup(assistant, 'teacher', 'Asha', 'Assistant');
  const V = await signup(advisor, 'teacher', 'Vera', 'Quietadvisor');
  const cls = await newClass(owner, name);
  const S = await signup(stu, 'student', 'Sam', 'Student', { classCode: cls.joinCode });
  for (const [u, role] of [[T, 'teacher'], [A, 'assistant'], [V, 'advisor']]) {
    const r = await owner.post(`/api/classes/${cls.id}/teachers`, { email: u.email, role });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  }
  return { owner, co, assistant, advisor, stu, O, T, A, V, S, cls };
}

/* ---------------- lib/classes.js ---------------- */

test('lib: who is listed, who has powers, who may manage the staff', () => {
  const cls = { id: 'c', teacherId: 'o', studentIds: ['s'], coTeacherIds: ['t'], assistantIds: ['a'], advisorIds: ['v'] };
  assert.deepStrictEqual(C.teacherIdsOf(cls), ['o', 't', 'a'], 'advisors aren’t listed');
  assert.deepStrictEqual(C.staffIdsOf(cls), ['o', 't', 'a', 'v']);
  assert.deepStrictEqual(['o', 't', 'a', 'v', 's', 'x'].map(id => C.staffRole(cls, id)), ['owner', 'teacher', 'assistant', 'advisor', null, null]);
  assert.deepStrictEqual(['o', 't', 'a', 'v', 's', 'x'].map(id => C.isClassTeacher(cls, id)), [true, true, true, true, false, false]);
  assert.deepStrictEqual(['o', 't', 'a', 'v', 's', 'x'].map(id => C.canManageStaff(cls, id)), [true, true, false, true, false, false]);
  assert.strictEqual(C.staffRole(undefined, 'o'), null);
  // an older class has none of the lists
  const old = { id: 'd', teacherId: 'o', studentIds: [] };
  assert.deepStrictEqual([C.staffIdsOf(old), C.staffRole(old, 'o'), C.staffRole(old, 'x')], [['o'], 'owner', null]);
  const me = { id: 'a' };
  const core = { users: { a: me, v: { id: 'v' } }, classes: { c: cls }, projects: {} };
  assert.deepStrictEqual([C.classFor(core, me, 'c').isTeacher, C.classFor(core, me, 'c').canManageStaff], [true, false]);
  assert.deepStrictEqual([C.classFor(core, core.users.v, 'c').isTeacher, C.classFor(core, core.users.v, 'c').canManageStaff], [true, true]);
});

test('lib: adding in a role, one role at a time, and removing from any of them', () => {
  const users = {};
  for (const id of ['o', 'a', 'b', 'c', 'd']) users[id] = { id, email: `${id}@x.test`, role: 'teacher', orgId: 'org' };
  users.s = { id: 's', email: 's@x.test', role: 'student', orgId: 'org' };
  const core = { users, classes: {}, projects: {} };
  const cls = { id: 'k', teacherId: 'o', studentIds: [] };
  C.addTeacher(core, cls, 'a@x.test', 'advisor');
  C.addTeacher(core, cls, 'b@x.test', 'assistant');
  C.addTeacher(core, cls, 'c@x.test');
  assert.deepStrictEqual([cls.advisorIds, cls.assistantIds, cls.coTeacherIds], [['a'], ['b'], ['c']]);
  for (const bad of ['owner', 'student', '__proto__', 'constructor', '']) assert.throws(() => C.addTeacher(core, cls, 'd@x.test', bad), { status: 400, message: 'Pick co-teacher, assistant teacher or advisor.' });
  assert.throws(() => C.addTeacher(core, cls, 'a@x.test', 'teacher'), { status: 400, message: 'They’re already an advisor of this class.' });
  assert.throws(() => C.addTeacher(core, cls, 'b@x.test', 'advisor'), { status: 400, message: 'They already teach this class.' });
  assert.throws(() => C.addTeacher(core, cls, 's@x.test', 'advisor'), { status: 400 });
  // advisors count toward the limit
  const full = { id: 'f', teacherId: 'o', studentIds: [], advisorIds: Array.from({ length: 19 }, (_, i) => `x${i}`) };
  assert.throws(() => C.addTeacher(core, full, 'd@x.test'), { status: 400, message: 'A class can have at most 20 teachers' });
  for (const id of ['a', 'b', 'c']) C.removeTeacher(cls, id);
  assert.deepStrictEqual(C.staffIdsOf(cls), ['o']);
  assert.throws(() => C.removeTeacher(cls, 'a'), { status: 404 });
  assert.throws(() => C.removeTeacher(cls, 'o'), { status: 400 });

  // from the school list: the role picked; an assistant teacher only adds students
  const school = { id: 'z', teacherId: 'o', studentIds: [], assistantIds: ['b'] };
  assert.deepStrictEqual(C.addFromSchool(core, school, users.o, ['a'], 'advisor'), { students: 0, teachers: 1, skipped: [] });
  assert.deepStrictEqual(school.advisorIds, ['a']);
  const r = C.addFromSchool(core, school, users.b, ['c', 's'], 'teacher');
  assert.deepStrictEqual([r.students, r.teachers, r.skipped.map(x => x.why)], [1, 0, ['assistant teachers can’t add teachers']]);
  assert.strictEqual(C.staffRole(school, 'c'), null);
  assert.throws(() => C.addFromSchool(core, school, users.o, ['d'], 'boss'), { status: 400 });
});

/* ---------------- the API ---------------- */

test('assistant teachers can’t add or remove teachers or advisors; they can leave', async () => {
  const { owner, assistant, A, T, V, O, cls } = await staffedClass('Roles 1');
  const extra = client();
  const X = await signup(extra, 'teacher', 'Xan', 'Extra');
  const Y = await signup(client(), 'teacher', 'Yui', 'Second');
  await owner.post(`/api/classes/${cls.id}/teachers`, { email: Y.email, role: 'assistant' });

  for (const role of [undefined, 'teacher', 'assistant', 'advisor']) {
    const r = await assistant.post(`/api/classes/${cls.id}/teachers`, { email: X.email, role });
    assert.deepStrictEqual([r.status, r.data.error], [403, STAFF_ONLY], `adding as ${role}`);
  }
  for (const u of [T, V, Y]) {
    const r = await assistant.del(`/api/classes/${cls.id}/teachers/${u.id}`);
    assert.deepStrictEqual([r.status, r.data.error], [403, STAFF_ONLY], `removing ${u.name}`);
  }
  let r = await assistant.del(`/api/classes/${cls.id}/teachers/${O.id}`);
  assert.deepStrictEqual([r.status, r.data.error], [400, 'The class’s owner can’t be removed.']);
  const page = (await assistant.get(`/api/classes/${cls.id}`)).data.class;
  assert.deepStrictEqual([page.staffRole, page.canManageStaff, page.isTeacher, page.isOwner], ['assistant', false, true, false]);
  r = await assistant.del(`/api/classes/${cls.id}/teachers/${A.id}`);
  assert.deepStrictEqual([r.status, r.data], [200, { ok: true, left: true }]);
  assert.strictEqual((await assistant.get(`/api/classes/${cls.id}`)).status, 403);
});

test('co-teachers and advisors add and remove staff, in every role, but never the owner', async () => {
  const { owner, co, advisor, T, V, O, cls } = await staffedClass('Roles 2');
  const X = await signup(client(), 'teacher', 'Xia', 'Extra');
  const Y = await signup(client(), 'teacher', 'Yan', 'Extra');
  for (const [who, name] of [[co, 'co-teacher'], [advisor, 'advisor']]) {
    let r = await who.post(`/api/classes/${cls.id}/teachers`, { email: X.email, role: 'advisor' });
    assert.strictEqual(r.status, 200, name);
    assert.ok(r.data.class.advisors.some(a => a.id === X.id));
    r = await who.post(`/api/classes/${cls.id}/teachers`, { email: Y.email, role: 'teacher' });
    assert.ok(r.data.class.teachers.some(t => t.id === Y.id && !t.assistant), name);
    for (const u of [X, Y]) {
      r = await who.del(`/api/classes/${cls.id}/teachers/${u.id}`);
      assert.strictEqual(r.status, 200, name);
      assert.strictEqual(r.data.left, undefined, 'removing someone else isn’t leaving');
      assert.ok(![...r.data.class.teachers, ...r.data.class.advisors].some(p => p.id === u.id));
    }
    r = await who.del(`/api/classes/${cls.id}/teachers/${O.id}`);
    assert.strictEqual(r.status, 400, name);
  }
  // an advisor can remove a co-teacher, and the other way round
  let r = await advisor.del(`/api/classes/${cls.id}/teachers/${T.id}`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await co.get(`/api/classes/${cls.id}`)).status, 403);
  await owner.post(`/api/classes/${cls.id}/teachers`, { email: T.email });
  r = await co.del(`/api/classes/${cls.id}/teachers/${V.id}`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await advisor.get(`/api/classes/${cls.id}`)).status, 403);
  // back as a co-teacher: a role changes by removing and adding
  r = await owner.post(`/api/classes/${cls.id}/teachers`, { email: V.email, role: 'teacher' });
  assert.ok(r.data.class.teachers.some(t => t.id === V.id));
  assert.deepStrictEqual(r.data.class.advisors, []);
});

test('only the owner deletes the class; a role that isn’t real is refused', async () => {
  const { owner, co, assistant, advisor, cls } = await staffedClass('Roles 3');
  for (const who of [co, assistant, advisor]) {
    const r = await who.del(`/api/classes/${cls.id}`, { confirmName: 'Roles 3' });
    assert.deepStrictEqual([r.status, r.data.error], [403, 'Only the class owner can delete it.']);
  }
  const X = await signup(client(), 'teacher', 'Zed', 'Extra');
  const r = await owner.post(`/api/classes/${cls.id}/teachers`, { email: X.email, role: 'superuser' });
  assert.deepStrictEqual([r.status, r.data.error], [400, 'Pick co-teacher, assistant teacher or advisor.']);
});

test('advisors and assistant teachers do a teacher’s work, start to finish', async () => {
  const { owner, assistant, advisor, stu, S, cls } = await staffedClass('Roles 4');
  for (const [who, tag] of [[advisor, 'advisor'], [assistant, 'assistant']]) {
    let r = await who.get('/api/classes');
    assert.ok(r.data.classes.some(c => c.id === cls.id && c.isTeacher), `${tag} has it on Home`);
    r = await who.get(`/api/classes/${cls.id}`);
    assert.strictEqual(r.data.class.joinCode, cls.joinCode, tag);
    assert.ok(r.data.class.students.some(x => x.id === S.id), tag);
    r = await who.patch(`/api/classes/${cls.id}`, { accommodations: { [S.id]: { timeMultiplier: 1.5, note: tag } } });
    assert.strictEqual(r.status, 200, tag);
    r = await who.post(`/api/classes/${cls.id}/updates`, { body: `From the ${tag}` });
    assert.strictEqual(r.status, 200, tag);
    const a = (await who.post(`/api/classes/${cls.id}/assignments`, { type: 'writing', title: `Essay by ${tag}` })).data.assignment;
    assert.strictEqual((await who.post(`/api/assignments/${a.id}/publish`, {})).status, 200, tag);
    r = await stu.get(`/api/write/${a.id}`);
    assert.strictEqual(r.status, 200, tag);
    const doc = r.data.doc;
    const session = (await stu.post(`/api/write/${doc.id}/sessions`, { surfaceId: `t-${tag}`, surf: 'tab' })).data;
    await stu.post(`/api/write/${doc.id}/ops`, { baseSeq: 0, ops: [{ k: 'i', at: 0, s: 'Words', t: Date.now(), src: 'type' }], surfaceId: `t-${tag}` }, { 'X-Visor-Session': session.token });
    await stu.post(`/api/write/${doc.id}/submit`, {});
    r = await who.get(`/api/review/${doc.id}`);
    assert.strictEqual(r.status, 200, `${tag} reviews the essay`);
  }
  const roster = (await owner.get(`/api/classes/${cls.id}`)).data.class;
  assert.strictEqual(roster.students.length, 1);
});

test('nothing a student receives names an advisor; assistant teachers are listed', async () => {
  const { owner, advisor, assistant, stu, S, V, A, cls } = await staffedClass('Roles 5');
  const a = (await owner.post(`/api/classes/${cls.id}/assignments`, { type: 'group', title: 'Team work', group: { groups: [{ name: 'Group 1', studentIds: [S.id], docUrl: 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/edit' }] } })).data.assignment;
  await owner.post(`/api/assignments/${a.id}/publish`, {});
  const pid = a.group.projectIds[0];
  const from = new Date(Date.now() - 864e5).toISOString(), to = new Date(Date.now() + 864e5).toISOString();
  const leaks = [];
  for (const url of ['/api/classes', `/api/classes/${cls.id}`, `/api/classes/${cls.id}/updates`, `/api/assignments/${a.id}`, `/api/projects/${pid}`, '/api/projects', '/api/activity', '/api/dashboard', `/api/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, '/api/me/export']) {
    const r = await stu.get(url);
    assert.strictEqual(r.status, 200, url);
    const text = JSON.stringify(r.data);
    if (text.includes('Quietadvisor') || text.includes(V.id) || text.includes(V.email)) leaks.push(url);
  }
  assert.deepStrictEqual(leaks, [], 'student responses that name the advisor');

  const page = (await stu.get(`/api/classes/${cls.id}`)).data.class;
  assert.ok(page.teachers.some(t => t.id === A.id && t.assistant === true), 'the assistant teacher is listed');
  for (const key of ['advisors', 'staffRole', 'canManageStaff']) assert.strictEqual(page[key], undefined, key);
  assert.ok(page.teachers.every(t => t.email === undefined), 'students still get no emails');

  // the staff see the advisor, on their own list, never among the teachers
  const seen = (await assistant.get(`/api/classes/${cls.id}`)).data.class;
  assert.deepStrictEqual(seen.advisors.map(x => [x.id, x.email]), [[V.id, V.email]]);
  assert.ok(!seen.teachers.some(t => t.id === V.id));
  const own = (await advisor.get(`/api/classes/${cls.id}`)).data.class;
  assert.deepStrictEqual([own.staffRole, own.canManageStaff, own.isTeacher, own.isOwner], ['advisor', true, true, false]);
  assert.strictEqual((await advisor.get(`/api/projects/${pid}`)).data.project.isTeacher, true, 'an advisor opens the class’s group projects');
  const project = (await stu.get(`/api/projects/${pid}`)).data.project;
  assert.ok(project.teachers.some(t => t.id === A.id) && !project.teachers.some(t => t.id === V.id));
});

test('search: everyone gets what they can open, and nothing else', async () => {
  const { owner, advisor, stu, S, V, cls } = await staffedClass('Roles 6');
  const stranger = client();
  await signup(stranger, 'student', 'Una', 'Outsider');
  const pub = (await owner.post(`/api/classes/${cls.id}/assignments`, { type: 'writing', title: 'Published essay' })).data.assignment;
  await owner.post(`/api/assignments/${pub.id}/publish`, {});
  await owner.post(`/api/classes/${cls.id}/assignments`, { type: 'writing', title: 'Secret draft' });
  const other = await newClass(owner, 'Other class');

  let r = await stu.get('/api/search-index');
  assert.deepStrictEqual(r.data.classes.map(c => c.name), ['Roles 6']);
  assert.deepStrictEqual(r.data.assignments.map(a => a.title), ['Published essay']);
  assert.deepStrictEqual(r.data.students, [], 'students get no roster');
  assert.ok(!JSON.stringify(r.data).includes(V.id), 'nor an advisor');

  r = await advisor.get('/api/search-index');
  assert.deepStrictEqual(r.data.classes.map(c => c.name), ['Roles 6'], 'only their own classes');
  assert.deepStrictEqual(r.data.assignments.map(a => [a.title, a.draft]).sort(), [['Published essay', false], ['Secret draft', true]]);
  assert.deepStrictEqual(r.data.students.map(x => x.id), [S.id]);

  r = await owner.get('/api/search-index');
  assert.deepStrictEqual(r.data.classes.map(c => c.name).sort(), ['Other class', 'Roles 6']);
  await owner.patch(`/api/classes/${other.id}`, { archived: true });
  r = await owner.get('/api/search-index');
  assert.deepStrictEqual(r.data.classes.map(c => c.name), ['Roles 6'], 'archived classes stay out');

  r = await stranger.get('/api/search-index');
  assert.deepStrictEqual([r.data.classes, r.data.assignments, r.data.students, r.data.projects], [[], [], [], []]);
  assert.strictEqual((await client().get('/api/search-index')).status, 401);
});

