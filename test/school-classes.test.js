// Classes belong to a school and a term, and a school someone runs only admits its
// own people, whichever way they try to get in. Anyone else can ask to join.
// Runs on a local PGlite store in a temp folder; nothing here reaches Firebase,
// Google or Gemini (their settings are blanked and pointed at a closed local port).
'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-school-classes-'));
Object.assign(process.env, {
  VISOR_PLATFORM: '', DATABASE_URL: '', MAIL_TRANSPORT: 'memory',
  PGLITE_DIR: path.join(DATA, 'pglite'), VISOR_IMAGE_DIR: path.join(DATA, 'images'), VISOR_AUDIO_DIR: path.join(DATA, 'audio'),
  VISOR_DEV_LOGIN: '1', SESSION_SECRET: 'test-secret', NODE_ENV: 'test',
  GEMINI_API_KEY: '', GEMINI_VIA: 'apikey', GEMINI_BASE_URL: 'http://127.0.0.1:9', VERTEX_BASE_URL: 'http://127.0.0.1:9', DRIVE_API_BASE: 'http://127.0.0.1:9',
  GOOGLE_CLIENT_ID: '', GOOGLE_API_KEY: '', GOOGLE_APP_ID: '', CLASSROOM_IMPORT: ''
});
delete process.env.VISOR_SCHOOL_OPTIONAL;

const test = require('node:test');
const assert = require('node:assert');
const app = require('../server');
const repo = require('../lib/repo');
const schools = require('../lib/schools');

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
  return { get: u => call('GET', u), post: (u, b) => call('POST', u, b || {}), patch: (u, b) => call('PATCH', u, b), del: u => call('DELETE', u) };
}
let n = 0;
const address = name => `${name.toLowerCase()}${++n}@classes.test`;
const signup = (c, role, name, extra = {}) => c.post('/api/auth/signup', { email: address(name), password: 'secret12', firstName: name, lastName: 'Tester', role, ...(role === 'student' ? { over13: true } : {}), ...extra });
const accept = async (f, email, c) => {
  const id = (await f.get('/api/school')).data.people.find(p => p.email === email).id;
  const link = (await f.post('/api/school/invites', { ids: [id], copy: true })).data.links[0].link;
  return c.post(`/api/invite/${link.split('/invite/')[1]}/accept`);
};
// A school with a facilitator, a member student, and a class
async function school() {
  const f = client(), s = client();
  const fr = await signup(f, 'teacher', 'Fay', { schoolName: `Classes School ${++n}` });
  const sr = await signup(s, 'student', 'Sia');
  await f.post('/api/school/people', { people: [{ email: sr.data.user.email, role: 'student', grades: ['9'] }] });
  assert.strictEqual((await accept(f, sr.data.user.email, s)).status, 200);
  const cls = (await f.post('/api/classes', { name: 'English' })).data.class;
  return { f, s, fUser: fr.data.user, sUser: sr.data.user, cls, orgId: fr.data.user.orgId };
}

test('a class needs a school, and gets the running term', async () => {
  const lone = client();
  await signup(lone, 'teacher', 'Lee');
  const no = await lone.post('/api/classes', { name: 'Solo' });
  assert.strictEqual(no.status, 409);
  assert.match(no.data.error, /belong to a school/);
  const { cls } = await school();
  assert.ok(cls.school.name.startsWith('Classes School'));
  assert.deepStrictEqual([cls.term.state, cls.term.id.startsWith('year-')], ['current', true]);
});

test('a member joins with the code, or a teacher puts them in directly', async () => {
  const { f, s, sUser, cls } = await school();
  const r = await s.post('/api/classes/join', { code: cls.joinCode });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.deepStrictEqual([r.data.class.school.id, r.data.class.term.id], [cls.school.id, cls.term.id]);
  const other = (await f.post('/api/classes', { name: 'History' })).data.class;
  const put = await f.post(`/api/classes/${other.id}/school-people`, { userIds: [sUser.id] });
  assert.strictEqual(put.status, 200, JSON.stringify(put.data));
  assert.strictEqual((await f.get(`/api/classes/${other.id}`)).data.class.students.length, 1);
  const byEmail = (await f.post('/api/classes', { name: 'Math' })).data.class;
  assert.deepStrictEqual((await f.post(`/api/classes/${byEmail.id}/students`, { emails: [sUser.email] })).data.added, [sUser.email]);
});

test('someone outside the school can’t get into its class any way at all', async () => {
  const { f, cls } = await school();
  const out = client(), t = client();
  const u = (await signup(out, 'student', 'Out')).data.user;
  const tu = (await signup(t, 'teacher', 'Tad')).data.user;

  const code = await out.post('/api/classes/join', { code: cls.joinCode });
  assert.strictEqual(code.status, 403);
  assert.deepStrictEqual([code.data.needsSchool.school.id, code.data.needsSchool.classId], [cls.school.id, cls.id]);
  const email = await f.post(`/api/classes/${cls.id}/students`, { emails: [u.email, 'stranger@classes.test'] });
  assert.deepStrictEqual([email.data.added, email.data.invited, email.data.skipped.map(x => x.why)], [[], [], ['not on your school’s list', 'not on your school’s list']]);
  assert.strictEqual((await f.post(`/api/classes/${cls.id}/students`, { userId: u.id })).status, 403);
  assert.strictEqual((await f.post(`/api/classes/${cls.id}/teachers`, { email: tu.email, role: 'teacher' })).status, 403);
  assert.strictEqual((await f.post(`/api/classes/${cls.id}/school-people`, { userIds: [u.id] })).data.students ?? 0, 0);
  assert.strictEqual((await out.get(`/api/classes/${cls.id}`)).status >= 400, true);
  assert.strictEqual((await f.get(`/api/classes/${cls.id}`)).data.class.students.length, 0);

  const viaSignup = client();
  const r = await signup(viaSignup, 'student', 'Signup', { classCode: cls.joinCode });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual([r.data.user.schoolRequest.status, r.data.user.org], ['pending', null], 'a code at sign-up asks the school instead');
  assert.strictEqual((await f.get(`/api/classes/${cls.id}`)).data.class.students.length, 0);
});

test('someone listed but not joined waits: a class invite fires when they join', async () => {
  const { f, cls } = await school();
  const c = client(), u = (await signup(c, 'student', 'Wren')).data.user;
  await f.post('/api/school/people', { people: [{ email: u.email, role: 'student' }] });
  const r = await f.post(`/api/classes/${cls.id}/students`, { emails: [u.email] });
  assert.deepStrictEqual([r.data.added, r.data.invited], [[], [u.email]]);
  assert.strictEqual((await f.get(`/api/classes/${cls.id}`)).data.class.students.length, 0);
  await accept(f, u.email, c);
  assert.strictEqual((await f.get(`/api/classes/${cls.id}`)).data.class.students.length, 1);
});

test('a request: the facilitator sees it, approves with a role, and the class follows', async () => {
  const { f, s, cls, orgId } = await school();
  const c = client(), u = (await signup(c, 'student', 'Rae')).data.user;
  const asked = await c.post(`/api/schools/${orgId}/request`, { note: 'I’m in Ms. Fay’s class', classId: cls.id });
  assert.strictEqual(asked.data.user.schoolRequest.status, 'pending');
  const list = (await f.get('/api/school')).data.requests;
  assert.deepStrictEqual([list.length, list[0].email, list[0].note, list[0].className, list[0].confirmed], [1, u.email, 'I’m in Ms. Fay’s class', 'English', false]);
  assert.strictEqual((await f.get('/api/me')).data.user.schoolRequests, 1);
  assert.strictEqual((await s.get('/api/school')).status, 403);
  const t = client(), tr = await signup(t, 'teacher', 'Tam');
  await f.post('/api/school/people', { people: [{ email: tr.data.user.email, role: 'teacher' }] });
  await accept(f, tr.data.user.email, t);
  assert.deepStrictEqual((await t.get('/api/school')).data.requests, [], 'only facilitators see requests');
  assert.strictEqual((await t.post(`/api/school/requests/${u.id}`, { approve: true })).status, 403);

  assert.strictEqual((await f.post(`/api/school/requests/${u.id}`, { approve: true, role: 'teacher' })).status, 409, 'a role can’t upgrade an account');
  assert.strictEqual((await f.post(`/api/school/requests/${u.id}`, { approve: true, role: 'student', grades: ['9'] })).status, 200);
  const me = (await c.get('/api/me')).data.user;
  assert.deepStrictEqual([me.org.id, me.schoolRequest], [orgId, undefined]);
  assert.strictEqual((await f.get(`/api/classes/${cls.id}`)).data.class.students.length, 1);
  assert.deepStrictEqual((await f.get('/api/school')).data.people.find(p => p.email === u.email).grades, ['9']);
  assert.strictEqual((await f.post(`/api/school/requests/${u.id}`, { approve: true })).status, 404, 'answered once');
});

test('a declined request says so, and can be withdrawn or sent again', async () => {
  const { f, orgId } = await school();
  const c = client(), u = (await signup(c, 'student', 'Dee')).data.user;
  await c.post(`/api/schools/${orgId}/request`);
  await f.post(`/api/school/requests/${u.id}`, { approve: false });
  const me = (await c.get('/api/me')).data.user;
  assert.deepStrictEqual([me.schoolRequest.status, me.org], ['declined', null]);
  assert.strictEqual((await c.post(`/api/schools/${orgId}/request`)).data.user.schoolRequest.status, 'pending');
  assert.strictEqual((await c.del('/api/school-request')).data.user.schoolRequest, undefined);
  assert.deepStrictEqual((await f.get('/api/school')).data.requests, []);
});

test('leaving the list means leaving its classes; a class owner has to hand over first', async () => {
  const { f, s, sUser, cls } = await school();
  await s.post('/api/classes/join', { code: cls.joinCode });
  const t = client(), tu = (await signup(t, 'teacher', 'Ora')).data.user;
  await f.post('/api/school/people', { people: [{ email: tu.email, role: 'teacher' }] });
  await accept(f, tu.email, t);
  const mine = (await t.post('/api/classes', { name: 'Ora’s class' })).data.class;
  const idOf = async e => (await f.get('/api/school')).data.people.find(p => p.email === e).id;
  const blocked = await f.post('/api/school/people/remove', { ids: [await idOf(tu.email)] });
  assert.strictEqual(blocked.status, 409);
  assert.match(blocked.data.error, /owns a class/);
  assert.ok(mine.id);
  assert.strictEqual((await f.post('/api/school/people/remove', { ids: [await idOf(sUser.email)] })).status, 200);
  assert.strictEqual((await f.get(`/api/classes/${cls.id}`)).data.class.students.length, 0);
  assert.strictEqual((await s.post('/api/classes/join', { code: cls.joinCode })).status, 403, 'and the code no longer works for them');
});

test('members can’t walk out of a school someone runs from Profile', async () => {
  const { s } = await school();
  const r = await s.patch('/api/me', { school: null });
  assert.strictEqual(r.status, 409);
  assert.match(r.data.error, /facilitator/);
});

test('terms: facilitators set them, classes pick one, and one in use stays', async () => {
  const { f, s, cls } = await school();
  assert.strictEqual((await s.post('/api/school/terms', { name: 'X', startsOn: '2026-01-01', endsOn: '2026-02-01' })).status, 403);
  const bad = await f.post('/api/school/terms', { name: 'Back to front', startsOn: '2026-05-01', endsOn: '2026-01-01' });
  assert.strictEqual(bad.status, 400);
  const fall = (await f.post('/api/school/terms', { name: 'Fall', startsOn: '2020-09-01', endsOn: '2020-12-20' })).data.term;
  assert.strictEqual(fall.state, 'past');
  const list = (await f.get('/api/school/terms')).data;
  assert.strictEqual(list.terms.length, 2);
  const moved = await f.patch(`/api/classes/${cls.id}`, { termId: fall.id });
  assert.deepStrictEqual([moved.data.class.term.name, moved.data.class.term.state], ['Fall', 'past']);
  assert.strictEqual((await f.patch(`/api/classes/${cls.id}`, { termId: 'nope' })).status, 400);
  assert.strictEqual((await f.del(`/api/school/terms/${fall.id}`)).status, 409, 'a class is using it');
  await f.patch(`/api/classes/${cls.id}`, { termId: list.terms.find(t => t.id !== fall.id).id });
  assert.strictEqual((await f.del(`/api/school/terms/${fall.id}`)).status, 200);
  const last = (await f.get('/api/school/terms')).data.terms[0];
  await f.patch(`/api/classes/${cls.id}`, { name: 'English' });
  assert.strictEqual((await f.del(`/api/school/terms/${last.id}`)).status, 409, 'a school keeps one');
  const renamed = await f.patch(`/api/school/terms/${last.id}`, { name: 'This year', startsOn: last.startsOn, endsOn: last.endsOn });
  assert.strictEqual(renamed.data.term.name, 'This year');
});

test('a class from before schools joins its teacher’s, and brings its students', async () => {
  const f = client();
  const fu = (await signup(f, 'teacher', 'Ola')).data.user;
  const st = client(), su = (await signup(st, 'student', 'Pip')).data.user;
  const id = `legacy-${++n}`;
  await repo.withCore(core => { core.classes[id] = { id, name: 'Old class', orgId: null, teacherId: fu.id, studentIds: [su.id], joinCode: `L${String(n).padStart(5, '0')}`, joinOpen: true, accommodations: {}, pendingInvites: [], createdAt: new Date().toISOString() }; });
  assert.strictEqual((await f.get(`/api/classes/${id}`)).data.class.school, undefined);
  assert.strictEqual((await f.post(`/api/classes/${id}/school`)).status, 409, 'not until they’re in one');
  await f.post('/api/school', { name: `New School ${++n}` });
  const r = await f.post(`/api/classes/${id}/school`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.class.term.state, 'current');
  assert.strictEqual((await st.get('/api/me')).data.user.org.name.startsWith('New School'), true);
  assert.strictEqual((await f.get('/api/school')).data.people.length, 2);
  assert.strictEqual((await f.post(`/api/classes/${id}/school`)).status, 409);
});

test('term dates: the school year turns over in the summer', () => {
  assert.deepStrictEqual(schools.yearTerm(Date.parse('2026-11-01')), { id: 'year-2026', name: '2026–27', startsOn: '2026-08-01', endsOn: '2027-07-31' });
  assert.strictEqual(schools.yearTerm(Date.parse('2027-03-01')).name, '2026–27');
  const t = { startsOn: '2026-01-01', endsOn: '2026-06-01' };
  assert.deepStrictEqual(['2025-12-31', '2026-03-01', '2026-06-02'].map(d => schools.termState(t, d)), ['upcoming', 'current', 'past']);
  const org = { terms: [{ id: 'a', startsOn: '2020-01-01', endsOn: '2020-02-01' }, { id: 'b', startsOn: '2030-01-01', endsOn: '2030-02-01' }] };
  assert.strictEqual(schools.currentTerm(org, '2026-01-01').id, 'b', 'between terms, the next one');
  assert.strictEqual(schools.currentTerm(org, '2031-01-01').id, 'b', 'after them all, the latest');
});
