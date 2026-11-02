// Co-teachers: adding a teacher to a class by email, what a co-teacher can do
// there (lists, assignments, folders, updates, students, the live board,
// reviews, essay pictures, group projects), who may delete the class or remove
// a teacher, leaving, and the teachers in each payload. Runs on a local PGlite
// store in a temp folder; nothing here reaches Firebase, Google or Gemini
// (their settings are blanked and pointed at a closed local port).
'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-coteach-'));
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
// A new account; the email is firstname<n>@coteach.test
async function signup(c, role, firstName, lastName, extra = {}) {
  const email = `${firstName.toLowerCase()}${++people}@coteach.test`;
  const r = await c.post('/api/auth/signup', { email, password: 'secret12', firstName, lastName, role, ...(role === 'student' ? { over13: true } : {}), ...extra });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return r.data.user;
}
const newClass = async (teacher, name) => (await teacher.post('/api/classes', { name })).data.class;
// The teacher view's entry for a user, and the same without the email
const entry = (u, owner) => ({ id: u.id, name: u.name, avatarColor: null, owner, email: u.email });
const noEmail = ({ email, ...rest }) => rest;

/* ---------------- lib/classes.js ---------------- */

test('lib: teacherIdsOf, isClassTeacher, addTeacher, removeTeacher, classFor', () => {
  const users = {
    o: { id: 'o', email: 'owner@x.test', role: 'teacher' }, t: { id: 't', email: 'Co@X.test', role: 'teacher' },
    s: { id: 's', email: 'stu@x.test', role: 'student' }, n: { id: 'n', email: 'new@x.test', role: 'teacher' }
  };
  const core = { users, classes: {}, projects: {} };
  const old = { id: 'c1', teacherId: 'o', studentIds: ['s'] };
  core.classes.c1 = old;
  // an older class without coTeacherIds has only its owner
  assert.deepStrictEqual(C.teacherIdsOf(old), ['o']);
  assert.ok(C.isClassTeacher(old, 'o') && !C.isClassTeacher(old, 't') && !C.isClassTeacher(old, 's'));
  assert.ok(!C.isClassTeacher(old, undefined) && !C.isClassTeacher(undefined, 'o'));
  // owner first, never twice, no repeats
  assert.deepStrictEqual(C.teacherIdsOf({ teacherId: 'o', coTeacherIds: ['t', 'o', 't', null, 'n'] }), ['o', 't', 'n']);

  assert.strictEqual(C.addTeacher(core, old, '  co@x.TEST ').id, 't');
  assert.deepStrictEqual(old.coTeacherIds, ['t']);
  assert.throws(() => C.addTeacher(core, old, ''), { status: 400, message: "Type a teacher’s email address" });
  assert.throws(() => C.addTeacher(core, old, { email: 'co@x.test' }), { status: 400, message: "Type a teacher’s email address" });
  assert.throws(() => C.addTeacher(core, old, 'who@x.test'), { status: 404, message: 'No teacher account uses that email. They need to create a Visor teacher account first.' });
  assert.throws(() => C.addTeacher(core, old, 'stu@x.test'), { status: 400, message: "That’s a student account. Only teacher accounts can teach a class." });
  assert.throws(() => C.addTeacher(core, old, 'co@x.test'), { status: 400, message: 'They already teach this class.' });
  assert.throws(() => C.addTeacher(core, old, 'owner@x.test'), { status: 400, message: 'They already teach this class.' });
  // 20 teachers at most, owner included
  const full = { id: 'c2', teacherId: 'o', studentIds: [], coTeacherIds: Array.from({ length: 19 }, (_, i) => `x${i}`) };
  assert.throws(() => C.addTeacher(core, full, 'new@x.test'), { status: 400, message: 'A class can have at most 20 teachers' });
  full.coTeacherIds.pop();
  C.addTeacher(core, full, 'new@x.test');
  assert.strictEqual(C.teacherIdsOf(full).length, 20);

  // classFor: a co-teacher is a teacher, not the owner
  assert.deepStrictEqual([C.classFor(core, users.o, 'c1').isTeacher, C.classFor(core, users.o, 'c1').isOwner], [true, true]);
  assert.deepStrictEqual([C.classFor(core, users.t, 'c1').isTeacher, C.classFor(core, users.t, 'c1').isOwner], [true, false]);
  assert.deepStrictEqual([C.classFor(core, users.s, 'c1').isTeacher, C.classFor(core, users.s, 'c1').isOwner], [false, false]);
  assert.throws(() => C.classFor(core, users.n, 'c1'), { status: 403 });

  assert.throws(() => C.removeTeacher(old, 'o'), { status: 400, message: "The class’s owner can’t be removed." });
  assert.throws(() => C.removeTeacher(old, 's'), { status: 404, message: "That teacher isn’t in this class" });
  C.removeTeacher(old, 't');
  assert.deepStrictEqual(C.teacherIdsOf(old), ['o']);
  assert.throws(() => C.classFor(core, users.t, 'c1'), { status: 403 });

  // teacher accounts are still never enrolled as students
  const r = C.addStudents(core, old, { emails: ['owner@x.test', 'stu@x.test'] });
  assert.deepStrictEqual(r.skipped, [{ email: 'owner@x.test', why: 'that is a teacher account' }]);
  assert.throws(() => C.addStudents(core, old, { userId: 'n' }), { status: 404, message: 'student not found' });
});

/* ---------------- adding teachers ---------------- */

test('adding a co-teacher: by email in any case, every refusal, and who may add', async () => {
  const owner = client(), co = client(), co2 = client(), stu = client(), outsider = client(), loner = client();
  const O = await signup(owner, 'teacher', 'Olive', 'Owner');
  const T = await signup(co, 'teacher', 'Cora', 'Co');
  const T2 = await signup(co2, 'teacher', 'Dev', 'Second');
  const X = await signup(outsider, 'teacher', 'Otto', 'Outside');
  const cls = await newClass(owner, 'Biology');
  const S = await signup(stu, 'student', 'Sam', 'Student', { classCode: cls.joinCode });
  const L = await signup(loner, 'student', 'Lu', 'Loner');

  // a new class: the owner is its only teacher
  assert.strictEqual(cls.isOwner, true);
  assert.deepStrictEqual(cls.teachers, [entry(O, true)]);

  // by email, whatever the case and spaces
  let r = await owner.post(`/api/classes/${cls.id}/teachers`, { email: `  ${T.email.toUpperCase()}\t` });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.deepStrictEqual(r.data.class.teachers, [entry(O, true), entry(T, false)]);
  assert.strictEqual(r.data.class.isOwner, true);
  assert.strictEqual(r.data.class.isTeacher, true);
  assert.strictEqual(r.data.class.teacher.id, O.id, 'teacher is still the owner');

  // every refusal
  const refusals = [
    [{}, 400, "Type a teacher’s email address"],
    [{ email: '   ' }, 400, "Type a teacher’s email address"],
    [{ email: 'nobody@coteach.test' }, 404, 'No teacher account uses that email. They need to create a Visor teacher account first.'],
    [{ email: S.email }, 400, "That’s a student account. Only teacher accounts can teach a class."],
    [{ email: L.email }, 400, "That’s a student account. Only teacher accounts can teach a class."],
    [{ email: T.email }, 400, 'They already teach this class.'],
    [{ email: O.email.toUpperCase() }, 400, 'They already teach this class.']
  ];
  for (const [body, status, error] of refusals) {
    r = await owner.post(`/api/classes/${cls.id}/teachers`, body);
    assert.deepStrictEqual([r.status, r.data.error], [status, error], JSON.stringify(body));
  }

  // a student of the class can't add a teacher; a teacher outside it can't either
  r = await stu.post(`/api/classes/${cls.id}/teachers`, { email: T2.email });
  assert.deepStrictEqual([r.status, r.data.error], [403, 'only the class teacher can do that']);
  r = await outsider.post(`/api/classes/${cls.id}/teachers`, { email: T2.email });
  assert.deepStrictEqual([r.status, r.data.error], [403, 'you are not in this class']);
  r = await outsider.post('/api/classes/no-such-class/teachers', { email: T2.email });
  assert.strictEqual(r.status, 404);
  r = await client().post(`/api/classes/${cls.id}/teachers`, { email: T2.email });
  assert.strictEqual(r.status, 401);

  // any teacher of the class may add one, co-teachers too
  r = await co.post(`/api/classes/${cls.id}/teachers`, { email: T2.email });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.class.isOwner, false);
  assert.strictEqual(r.data.class.isTeacher, true);
  assert.deepStrictEqual(r.data.class.teachers, [entry(O, true), entry(T, false), entry(T2, false)]);

  // 20 teachers at most, owner included
  await repo.withCore(core => { core.classes[cls.id].coTeacherIds.push(...Array.from({ length: 17 }, (_, i) => `gone-${i}`)); });
  r = await owner.post(`/api/classes/${cls.id}/teachers`, { email: X.email });
  assert.deepStrictEqual([r.status, r.data.error], [400, 'A class can have at most 20 teachers']);
  await repo.withCore(core => { const c = core.classes[cls.id]; c.coTeacherIds = c.coTeacherIds.filter(id => !id.startsWith('gone-')); });
});

/* ---------------- payloads ---------------- */

test('payloads: teachers and isOwner for the owner, a co-teacher and a student; students never get emails', async () => {
  const owner = client(), co = client(), stu = client();
  const O = await signup(owner, 'teacher', 'Pia', 'Owner');
  const T = await signup(co, 'teacher', 'Quin', 'Co');
  await co.patch('/api/me', { avatarColor: '#4dbedc' });
  const cls = await newClass(owner, 'Chemistry');
  await signup(stu, 'student', 'Ray', 'Student', { classCode: cls.joinCode });
  await owner.post(`/api/classes/${cls.id}/teachers`, { email: T.email });
  const coEntry = { ...entry(T, false), avatarColor: '#4dbedc' };
  const a = (await owner.post(`/api/classes/${cls.id}/assignments`, { type: 'writing', title: 'Lab', writing: { mode: 'open' } })).data.assignment;
  await owner.post(`/api/assignments/${a.id}/publish`, {});

  // the class page
  let r = await owner.get(`/api/classes/${cls.id}`);
  assert.deepStrictEqual([r.data.class.isTeacher, r.data.class.isOwner], [true, true]);
  assert.deepStrictEqual(r.data.class.teachers, [entry(O, true), coEntry]);
  r = await co.get(`/api/classes/${cls.id}`);
  assert.deepStrictEqual([r.data.class.isTeacher, r.data.class.isOwner], [true, false]);
  assert.deepStrictEqual(r.data.class.teachers, [entry(O, true), coEntry]);
  assert.strictEqual(r.data.class.joinCode, cls.joinCode, 'a co-teacher gets the teacher view');
  assert.strictEqual(r.data.class.teacher.id, O.id);
  r = await stu.get(`/api/classes/${cls.id}`);
  assert.deepStrictEqual([r.data.class.isTeacher, r.data.class.isOwner], [false, false]);
  assert.deepStrictEqual(r.data.class.teachers, [noEmail(entry(O, true)), noEmail(coEntry)]);
  assert.ok(r.data.class.teachers.every(t => !('email' in t)), 'no emails for students');
  assert.strictEqual(r.data.class.joinCode, undefined);

  // the class list, in both roles
  r = await co.get('/api/classes');
  const listed = r.data.classes.find(c => c.id === cls.id);
  assert.deepStrictEqual([listed.isTeacher, listed.isOwner], [true, false]);
  assert.strictEqual(typeof listed.toReview, 'number', 'a co-teacher gets the teacher summary');
  r = await stu.get('/api/classes');
  assert.ok(r.data.classes[0].teachers.every(t => !('email' in t)));

  // the assignment page's class: teachers without emails, and isOwner
  r = await co.get(`/api/assignments/${a.id}`);
  assert.strictEqual(r.data.isTeacher, true);
  assert.strictEqual(r.data.class.isOwner, false);
  assert.deepStrictEqual(r.data.class.teachers, [noEmail(entry(O, true)), noEmail(coEntry)]);
  r = await owner.get(`/api/assignments/${a.id}`);
  assert.strictEqual(r.data.class.isOwner, true);
  r = await stu.get(`/api/assignments/${a.id}`);
  assert.strictEqual(r.data.class.isOwner, false);
  assert.deepStrictEqual(r.data.class.teachers, [noEmail(entry(O, true)), noEmail(coEntry)]);

  // Download my data lists every teacher of the class
  r = await stu.get('/api/me/export');
  assert.deepStrictEqual(r.data.classes[0].teachers, ['Pia Owner', 'Quin Co']);
  assert.strictEqual(r.data.classes[0].teacher, 'Pia Owner');
});

/* ---------------- what a co-teacher can do ---------------- */

test('a co-teacher teaches the class: lists, assignments, folders, updates, students, live board, review, pictures', async () => {
  const owner = client(), co = client(), stu = client(), stu2 = client(), outsider = client();
  const O = await signup(owner, 'teacher', 'Una', 'Owner');
  const T = await signup(co, 'teacher', 'Vic', 'Co');
  await signup(outsider, 'teacher', 'Wes', 'Outside');
  const cls = await newClass(owner, 'English 10');
  const S = await signup(stu, 'student', 'Xia', 'Student', { classCode: cls.joinCode });
  const S2 = await signup(stu2, 'student', 'Yan', 'Student');
  let r = await owner.post(`/api/classes/${cls.id}/teachers`, { email: T.email });
  assert.strictEqual(r.status, 200);

  // the class shows up in the co-teacher's lists
  r = await co.get('/api/classes');
  assert.deepStrictEqual(r.data.classes.map(c => c.id), [cls.id]);

  // folders
  r = await co.post(`/api/classes/${cls.id}/folders`, { name: 'Unit 1' });
  assert.strictEqual(r.status, 200);
  const folder = r.data.folder;
  r = await co.patch(`/api/folders/${folder.id}`, { name: 'Unit One', color: 'teal' });
  assert.deepStrictEqual([r.status, r.data.folder.name], [200, 'Unit One']);

  // updates: their own, and the owner's
  r = await co.post(`/api/classes/${cls.id}/updates`, { body: 'Bring a notebook.' });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.data.update.author, { id: T.id, name: 'Vic Co', avatarColor: null });
  const ownerUpdate = (await owner.post(`/api/classes/${cls.id}/updates`, { body: 'Welcome!' })).data.update;
  r = await co.patch(`/api/updates/${ownerUpdate.id}`, { pinned: true });
  assert.deepStrictEqual([r.status, r.data.update.pinned], [200, true]);
  r = await co.post('/api/updates', { classIds: [cls.id], body: 'Quiz Friday.' });
  assert.strictEqual(r.status, 200);

  // students: by account or email; teacher accounts are still skipped
  r = await co.post(`/api/classes/${cls.id}/students`, { userId: S2.id });
  assert.deepStrictEqual([r.status, r.data.added], [200, [S2.email]]);
  r = await co.post(`/api/classes/${cls.id}/students`, { emails: [O.email, 'new.kid@coteach.test'] });
  assert.deepStrictEqual(r.data.skipped, [{ email: O.email, why: 'that is a teacher account' }]);
  assert.deepStrictEqual(r.data.invited, ['new.kid@coteach.test']);
  r = await co.post(`/api/classes/${cls.id}/students`, { userId: O.id });
  assert.deepStrictEqual([r.status, r.data.error], [404, 'student not found']);
  r = await co.patch(`/api/classes/${cls.id}`, { accommodations: { [S.id]: { timeMultiplier: 1.5, note: '' } } });
  assert.strictEqual(r.data.class.accommodations[S.id].timeMultiplier, 1.5);

  // assignments: the co-teacher makes and publishes one, the owner another
  const due = new Date(Date.now() + 3 * 864e5).toISOString();
  r = await co.post(`/api/classes/${cls.id}/assignments`, { type: 'writing', title: 'Narrative', folderId: folder.id, dueAt: due, writing: { mode: 'open', allowPaste: 'allow' } });
  assert.strictEqual(r.status, 200);
  const a = r.data.assignment;
  assert.strictEqual(a.createdBy, T.id);
  assert.strictEqual(a.publishedBy, undefined);
  // drafts show on the co-teacher's calendar
  const from = new Date(Date.now() - 864e5).toISOString(), to = new Date(Date.now() + 10 * 864e5).toISOString();
  r = await co.get(`/api/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  assert.deepStrictEqual(r.data.events.map(e => [e.assignmentId, e.kind, e.published]), [[a.id, 'due', false]]);
  assert.deepStrictEqual(r.data.classes, [{ id: cls.id, name: 'English 10', color: cls.color, isTeacher: true }]);

  r = await co.post(`/api/assignments/${a.id}/publish`, {});
  assert.strictEqual(r.data.assignment.publishedBy, T.id);
  assert.ok(r.data.assignment.publishedAt);
  // publishing again changes nothing; the owner unpublishing and publishing makes them the publisher
  r = await owner.post(`/api/assignments/${a.id}/publish`, {});
  assert.strictEqual(r.data.assignment.publishedBy, T.id);
  const b = (await owner.post(`/api/classes/${cls.id}/assignments`, { type: 'discussion', title: 'Seminar' })).data.assignment;
  assert.strictEqual(b.createdBy, O.id);
  r = await owner.post(`/api/assignments/${b.id}/publish`, {});
  assert.strictEqual(r.data.assignment.publishedBy, O.id);
  r = await owner.post(`/api/assignments/${b.id}/publish`, { published: false });
  assert.deepStrictEqual([r.data.assignment.publishedAt, r.data.assignment.publishedBy], [null, undefined]);
  r = await co.post(`/api/assignments/${b.id}/publish`, {});
  assert.strictEqual(r.data.assignment.publishedBy, T.id);
  await owner.post(`/api/assignments/${b.id}/publish`, { published: false });
  await owner.post(`/api/assignments/${b.id}/publish`, {});
  // a copy is made by whoever copies it, and isn't published
  r = await co.post(`/api/assignments/${a.id}/duplicate`, {});
  assert.deepStrictEqual([r.data.assignment.createdBy, r.data.assignment.publishedBy, r.data.assignment.publishedAt], [T.id, undefined, null]);
  await co.del(`/api/assignments/${r.data.assignment.id}`);

  // Recent activity: each assignment under whoever published it, for the
  // co-teacher and the student alike
  const shown = async c => Object.fromEntries((await c.get('/api/activity')).data.items.filter(x => x.kind === 'assignment').map(x => [x.title, x.teacher]));
  for (const c of [co, stu, owner]) assert.deepStrictEqual(await shown(c), { Narrative: { id: T.id, name: 'Vic Co' }, Seminar: { id: O.id, name: 'Una Owner' } });
  // older assignments, and publishers whose account is gone, show the owner
  await repo.updateRecord('assignment', a.id, x => { delete x.publishedBy; });
  await repo.updateRecord('assignment', b.id, x => { x.publishedBy = 'no-such-user'; });
  assert.deepStrictEqual(await shown(co), { Narrative: { id: O.id, name: 'Una Owner' }, Seminar: { id: O.id, name: 'Una Owner' } });
  await repo.updateRecord('assignment', a.id, x => { x.publishedBy = T.id; });

  // the student writes, adds a picture and submits
  r = await stu.get(`/api/write/${a.id}`);
  const doc = r.data.doc;
  const s = (await stu.post(`/api/write/${doc.id}/sessions`, { surfaceId: 't1', surf: 'tab' })).data;
  const H = { 'X-Visor-Session': s.token, 'X-Visor-Surface': 't1' };
  r = await stu.post(`/api/write/${doc.id}/ops`, { baseSeq: 0, ops: [{ k: 'i', at: 0, s: 'Once upon a time', t: Date.now(), src: 'type' }], surfaceId: 't1' }, H);
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  r = await stu.upload(`/api/write/${doc.id}/images`, PNG, H);
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  const image = r.data;

  // the live board while the student writes
  r = await co.get(`/api/assignments/${a.id}/live`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.rows.find(x => x.student.id === S.id).status, 'writing');
  r = await co.post(`/api/assignments/${a.id}/live/action`, { action: 'message', studentIds: [S.id], message: 'Ten minutes left' });
  assert.deepStrictEqual([r.status, r.data.changed], [200, 1]);
  r = await co.get('/api/dashboard');
  assert.deepStrictEqual(r.data.happeningNow.map(x => [x.assignmentId, x.live]), [[a.id, 1]]);

  r = await stu.post(`/api/write/${doc.id}/submit`, {});
  assert.strictEqual(r.data.doc.status, 'submitted');

  // submissions, the dashboard's review list, and the review itself
  r = await co.get(`/api/assignments/${a.id}`);
  assert.deepStrictEqual(r.data.submissions.filter(x => x.docId).map(x => [x.student.id, x.status]), [[S.id, 'submitted']]);
  r = await co.get('/api/dashboard');
  assert.deepStrictEqual([r.data.role, r.data.needsReview.map(x => x.docId)], ['teacher', [doc.id]]);
  r = await co.get(`/api/review/${doc.id}`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.student.id, S.id);
  assert.strictEqual(typeof r.data.imageToken, 'string');
  r = await co.get(`/api/write/${doc.id}/ops`);
  assert.strictEqual(r.status, 200);
  r = await co.post(`/api/review/${doc.id}/feedback`, { comment: 'Nice opening.', score: 9, outOf: 10, returnToStudent: true });
  assert.deepStrictEqual([r.status, r.data.doc.status, r.data.doc.feedback.by], [200, 'returned', T.id]);
  r = await outsider.get(`/api/review/${doc.id}`);
  assert.strictEqual(r.status, 403);
  // a teacher can't write in the student's place
  r = await co.get(`/api/write/${a.id}`);
  assert.strictEqual(r.status, 403);

  // the essay's picture through the sign-in cookie
  r = await co.get(`/api/images/${image.id}`);
  assert.strictEqual(r.status, 200);
  assert.ok(r.buf.equals(PNG));
  r = await outsider.get(`/api/images/${image.id}`);
  assert.strictEqual(r.status, 404);

  // discussions: the co-teacher can confirm the notice and record, and is a
  // voice the wizard offers
  r = await co.post(`/api/classes/${cls.id}/discussion-consent`, { confirmed: true });
  assert.strictEqual(r.status, 200);
  r = await co.post(`/api/assignments/${b.id}/discussions`, { title: 'Period 2' });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.data.discussion.people.filter(p => p.role === 'teacher'), [{ id: O.id, name: 'Una Owner', role: 'teacher' }, { id: T.id, name: 'Vic Co', role: 'teacher' }]);
  r = await co.get(`/api/discussions/${r.data.discussion.id}`);
  assert.strictEqual(r.status, 200);

  // the join code, and archiving
  r = await co.post(`/api/classes/${cls.id}/rotate-code`, {});
  assert.strictEqual(r.status, 200);
  assert.notStrictEqual(r.data.class.joinCode, cls.joinCode);
  r = await co.patch(`/api/classes/${cls.id}`, { archived: true });
  assert.strictEqual(r.data.class.archived, true);
  r = await co.get('/api/activity');
  assert.deepStrictEqual(r.data.items, [], 'archived classes leave Recent activity');
  await co.patch(`/api/classes/${cls.id}`, { archived: false });
});

test('a co-teacher opens the owner’s group projects; projects outside a class stay the owner’s', async () => {
  const owner = client(), co = client(), stu = client();
  const O = await signup(owner, 'teacher', 'Zoe', 'Owner');
  const T = await signup(co, 'teacher', 'Abe', 'Co');
  const cls = await newClass(owner, 'History 9');
  const S = await signup(stu, 'student', 'Bea', 'Student', { classCode: cls.joinCode });
  await owner.post(`/api/classes/${cls.id}/teachers`, { email: T.email });

  const a = (await owner.post(`/api/classes/${cls.id}/assignments`, { type: 'group', title: 'Civil rights', group: { groups: [{ name: 'Group 1', studentIds: [S.id], docUrl: 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/edit' }] } })).data.assignment;
  const pid = a.group.projectIds[0];
  const solo = (await owner.post('/api/projects', { name: 'Owner only' })).data.project;

  let r = await co.get(`/api/projects/${pid}`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.project.isTeacher, true);
  assert.strictEqual(r.data.project.teacher.id, O.id, 'the project keeps its teacher');
  assert.strictEqual(typeof r.data.project.code, 'string');
  r = await co.patch(`/api/projects/${pid}`, { showAnalysis: true });
  assert.deepStrictEqual([r.status, r.data.project.showAnalysis], [200, true]);
  r = await co.get('/api/projects');
  assert.deepStrictEqual(r.data.projects.map(p => [p.id, p.isTeacher]), [[pid, true]]);
  const X = { 'X-Visor-Token': (await co.post('/api/ext/token')).data.token };
  r = await co.get('/api/ext/projects', X);
  assert.deepStrictEqual(r.data.projects.map(p => p.id), [pid]);
  r = await co.get('/api/ext/linked-docs', X);
  assert.deepStrictEqual(r.data.docs.map(d => d.projectId), [pid]);

  // a project with no class is unchanged: only its own teacher and students
  r = await co.get(`/api/projects/${solo.id}`);
  assert.strictEqual(r.status, 403);
  r = await stu.get(`/api/projects/${pid}`);
  assert.strictEqual(r.data.project.isTeacher, false);

  // after leaving the class, its projects close too
  r = await co.del(`/api/classes/${cls.id}/teachers/${T.id}`);
  assert.deepStrictEqual(r.data, { ok: true, left: true });
  r = await co.get(`/api/projects/${pid}`);
  assert.strictEqual(r.status, 403);
  r = await co.get('/api/projects');
  assert.deepStrictEqual(r.data.projects, []);
});

/* ---------------- delete, remove and leave ---------------- */

test('deleting the class: owner only; nobody removes the owner; a co-teacher may leave', async () => {
  const owner = client(), co = client(), co2 = client(), stu = client();
  const O = await signup(owner, 'teacher', 'Cal', 'Owner');
  const T = await signup(co, 'teacher', 'Dee', 'Co');
  const T2 = await signup(co2, 'teacher', 'Eli', 'Co');
  const cls = await newClass(owner, 'Art');
  const S = await signup(stu, 'student', 'Fay', 'Student', { classCode: cls.joinCode });
  await owner.post(`/api/classes/${cls.id}/teachers`, { email: T.email });
  await owner.post(`/api/classes/${cls.id}/teachers`, { email: T2.email });

  // a co-teacher can't delete the class, even with its name typed
  let r = await co.del(`/api/classes/${cls.id}`, { confirmName: 'Art' });
  assert.deepStrictEqual([r.status, r.data.error], [403, 'Only the class owner can delete it.']);
  r = await stu.del(`/api/classes/${cls.id}`, { confirmName: 'Art' });
  assert.deepStrictEqual([r.status, r.data.error], [403, 'only the class teacher can do that']);
  r = await owner.del(`/api/classes/${cls.id}`, { confirmName: 'art' });
  assert.deepStrictEqual([r.status, r.data.error], [400, 'Type the class name exactly to delete it.']);

  // nobody removes the owner (test/class-roles.test.js has who may remove whom)
  r = await co.del(`/api/classes/${cls.id}/teachers/${O.id}`);
  assert.deepStrictEqual([r.status, r.data.error], [400, "The class’s owner can’t be removed."]);
  r = await owner.del(`/api/classes/${cls.id}/teachers/${O.id}`);
  assert.deepStrictEqual([r.status, r.data.error], [400, "The class’s owner can’t be removed."]);
  r = await owner.del(`/api/classes/${cls.id}/teachers/${S.id}`);
  assert.deepStrictEqual([r.status, r.data.error], [404, "That teacher isn’t in this class"]);
  r = await stu.del(`/api/classes/${cls.id}/teachers/${T.id}`);
  assert.deepStrictEqual([r.status, r.data.error], [403, 'only the class teacher can do that']);

  // a co-teacher leaves, and is then outside the class
  r = await co.del(`/api/classes/${cls.id}/teachers/${T.id}`);
  assert.deepStrictEqual([r.status, r.data], [200, { ok: true, left: true }]);
  r = await co.get(`/api/classes/${cls.id}`);
  assert.deepStrictEqual([r.status, r.data.error], [403, 'you are not in this class']);
  r = await co.post(`/api/classes/${cls.id}/assignments`, { type: 'writing', title: 'Sneaky' });
  assert.strictEqual(r.status, 403);
  r = await co.get('/api/classes');
  assert.deepStrictEqual(r.data.classes, []);
  r = await co.get('/api/dashboard');
  assert.deepStrictEqual(r.data.needsReview, []);
  r = await co.del(`/api/classes/${cls.id}/teachers/${T.id}`);
  assert.strictEqual(r.status, 403, 'leaving twice');

  // the owner removes a co-teacher
  r = await owner.del(`/api/classes/${cls.id}/teachers/${T2.id}`);
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.data.class.teachers, [entry(O, true)]);
  assert.strictEqual(r.data.class.isOwner, true);
  r = await co2.get(`/api/classes/${cls.id}`);
  assert.strictEqual(r.status, 403);
  r = await stu.get(`/api/classes/${cls.id}`);
  assert.deepStrictEqual(r.data.class.teachers, [noEmail(entry(O, true))]);

  // the owner deletes the class
  r = await owner.del(`/api/classes/${cls.id}`, { confirmName: 'Art' });
  assert.deepStrictEqual([r.status, r.data], [200, { ok: true }]);
});

test('after a co-teacher is removed: picture tokens stop working, group-project codes change; students never get the owner’s email', async () => {
  const owner = client(), co = client(), stu = client(), anon = client();
  const T = await signup(owner, 'teacher', 'Ola', 'Owner');
  const CO = await signup(co, 'teacher', 'Cy', 'Co');
  const cls = await newClass(owner, 'Biology');
  const S = await signup(stu, 'student', 'Sid', 'Student', { classCode: cls.joinCode });
  assert.strictEqual((await owner.post(`/api/classes/${cls.id}/teachers`, { email: CO.email })).status, 200);

  // students see the owner's name, never an email
  let r = await stu.get(`/api/classes/${cls.id}`);
  assert.deepStrictEqual(r.data.class.teacher, { id: T.id, name: 'Ola Owner', avatarColor: null });

  // a picture, and the co-teacher's token for it from the review
  const a = (await owner.post(`/api/classes/${cls.id}/assignments`, { type: 'writing', title: 'Cells', writing: { mode: 'open' } })).data.assignment;
  await owner.post(`/api/assignments/${a.id}/publish`, {});
  const doc = (await stu.get(`/api/write/${a.id}`)).data.doc;
  const s = (await stu.post(`/api/write/${doc.id}/sessions`, { surfaceId: 't1', surf: 'tab' })).data;
  const H = { 'X-Visor-Session': s.token, 'X-Visor-Surface': 't1' };
  await stu.post(`/api/write/${doc.id}/ops`, { baseSeq: 0, ops: [{ k: 'i', at: 0, s: 'Hi', t: Date.now(), src: 'type' }], surfaceId: 't1' }, H);
  const image = (await stu.upload(`/api/write/${doc.id}/images`, PNG, H)).data;
  await stu.post(`/api/write/${doc.id}/submit`, {});
  const coToken = (await co.get(`/api/review/${doc.id}`)).data.imageToken;
  const ownerToken = (await owner.get(`/api/review/${doc.id}`)).data.imageToken;
  r = await anon.get(`/api/images/${image.id}?t=${encodeURIComponent(coToken)}`);
  assert.strictEqual(r.status, 200, 'works while they teach the class');

  // a group project, whose code the co-teacher can see
  const g = (await owner.post(`/api/classes/${cls.id}/assignments`, { type: 'group', title: 'Labs', group: { groups: [{ name: 'A', studentIds: [S.id] }] } })).data.assignment;
  assert.ok(g);
  const proj = (await co.get('/api/projects')).data.projects.find(p => p.classId === cls.id);
  assert.ok(proj && proj.code, 'a co-teacher sees the class’s project and its code');
  assert.deepStrictEqual(proj.teachers.map(t => t.id), [T.id, CO.id]);
  const stuProj = (await stu.get('/api/projects')).data.projects.find(p => p.id === proj.id);
  assert.ok(stuProj.teachers.every(t => !t.email) && !stuProj.teacher.email, 'students get no teacher emails on projects');

  // removed: the token and the old code stop working
  r = await owner.del(`/api/classes/${cls.id}/teachers/${CO.id}`);
  assert.strictEqual(r.status, 200);
  r = await anon.get(`/api/images/${image.id}?t=${encodeURIComponent(coToken)}`);
  assert.strictEqual(r.status, 404);
  r = await anon.get(`/api/images/${image.id}?t=${encodeURIComponent(ownerToken)}`);
  assert.strictEqual(r.status, 200, 'the owner’s still works');
  const after = (await owner.get('/api/projects')).data.projects.find(p => p.id === proj.id);
  assert.notStrictEqual(after.code, proj.code);
  r = await anon.get(`/api/extension/group/${proj.code}`);
  assert.notStrictEqual(r.status, 200, 'the old code is dead');
});
