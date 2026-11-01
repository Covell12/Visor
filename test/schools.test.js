// Schools someone runs: creating one, the list of who can join, roles and grades,
// invites, and what teachers see. Being on the list must never be enough to get
// in: Visor doesn't confirm addresses at sign-up, so the invite link is the proof.
// Runs on a local PGlite store in a temp folder; email stays in memory; nothing
// here reaches Firebase, Google or Gemini.
'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-schools-'));
Object.assign(process.env, {
  VISOR_PLATFORM: '', DATABASE_URL: '', MAIL_TRANSPORT: 'memory',
  PGLITE_DIR: path.join(DATA, 'pglite'), VISOR_IMAGE_DIR: path.join(DATA, 'images'), VISOR_AUDIO_DIR: path.join(DATA, 'audio'),
  VISOR_DEV_LOGIN: '1', SESSION_SECRET: 'test-secret', NODE_ENV: 'test',
  GEMINI_API_KEY: '', GEMINI_VIA: 'apikey', GEMINI_BASE_URL: 'http://127.0.0.1:9', VERTEX_BASE_URL: 'http://127.0.0.1:9', DRIVE_API_BASE: 'http://127.0.0.1:9',
  GOOGLE_CLIENT_ID: '', GOOGLE_API_KEY: '', GOOGLE_APP_ID: '', CLASSROOM_IMPORT: ''
});

const test = require('node:test');
const assert = require('node:assert');
const app = require('../server');
const repo = require('../lib/repo');
const mail = require('../lib/mail');
const SchoolPaste = require('../public/school-people.js');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
let server, base;
test.before(async () => {
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); fs.rmSync(DATA, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  const call = async (method, url, body, headers = {}) => {
    const raw = Buffer.isBuffer(body);
    const r = await fetch(base + url, { method, redirect: 'manual', headers: { ...(body && !raw ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: raw ? body : body ? JSON.stringify(body) : undefined });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const buf = Buffer.from(await r.arrayBuffer());
    let data = null;
    try { data = JSON.parse(buf.toString('utf8')); } catch {}
    return { status: r.status, data, headers: r.headers };
  };
  return { get: u => call('GET', u), post: (u, b, h) => call('POST', u, b === undefined ? {} : b, h), patch: (u, b) => call('PATCH', u, b), del: u => call('DELETE', u) };
}
let n = 0;
const address = name => `${name.toLowerCase()}${++n}@schools.test`;
const student = (c, name, extra = {}) => c.post('/api/auth/signup', { email: extra.email || address(name), password: 'secret12', firstName: name, lastName: 'Tester', role: 'student', over13: true, ...extra });
const teacher = (c, name, extra = {}) => c.post('/api/auth/signup', { email: extra.email || address(name), password: 'secret12', firstName: name, lastName: 'Tester', role: 'teacher', ...extra });

// A teacher who creates a school at sign-up
async function newSchool() {
  const f = client(), name = `School ${++n}`;
  const r = await teacher(f, 'Fay', { schoolName: name });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return { f, user: r.data.user, name, orgId: r.data.user.orgId };
}
const peopleOf = async c => (await c.get('/api/school')).data.people;
const personIn = async (c, email) => (await peopleOf(c)).find(p => p.email === email);
// The invite link for someone on the list, and its token
async function linkFor(f, email) {
  const id = (await personIn(f, email)).id;
  const r = await f.post('/api/school/invites', { ids: [id], copy: true });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return r.data.links[0].link.split('/invite/')[1];
}

test('creating a school at sign-up makes you its facilitator, and only teachers can', async () => {
  const { f, user, name } = await newSchool();
  assert.deepStrictEqual([user.facilitator, user.org.name, user.org.managed], [true, name, true]);
  const me = await personIn(f, user.email);
  assert.deepStrictEqual([me.role, me.status], ['facilitator', 'joined']);
  const s = await student(client(), 'Stu', { schoolName: `Student School ${n}` });
  assert.strictEqual(s.status, 403);
  assert.match(s.data.error, /Only teachers can create a school/);
});

test('a school someone runs can’t be joined by picking it', async () => {
  const { name, orgId } = await newSchool();
  for (const body of [{ schoolId: orgId }, { schoolName: name }, { schoolName: name.toLowerCase() }]) {
    const r = await teacher(client(), 'Tom', body);
    assert.strictEqual(r.status, 403, JSON.stringify(body));
    assert.match(r.data.error, /Ask its facilitator for an invite/);
  }
  const c = client();
  await teacher(c, 'Tia');
  assert.strictEqual((await c.patch('/api/me', { school: { id: orgId } })).status, 403);
  assert.strictEqual((await c.patch('/api/me', { school: { name } })).status, 403);
  assert.strictEqual((await c.get('/api/me')).data.user.org, null);
  assert.strictEqual((await client().get(`/api/schools?q=${encodeURIComponent(name)}`)).data.schools[0].managed, true);
});

test('being on the list isn’t enough: without the link, a listed address stays out', async () => {
  const { f, orgId } = await newSchool();
  const email = address('listed');
  await f.post('/api/school/people', { people: [{ email, role: 'teacher' }] });
  const c = client();
  const r = await teacher(c, 'Imposter', { email });
  assert.strictEqual(r.status, 200, 'the account is fine; it just isn’t in the school');
  assert.strictEqual(r.data.user.org, null);
  assert.strictEqual((await teacher(client(), 'Other', { email: address('other'), schoolId: orgId })).status, 403);
  assert.strictEqual((await c.get('/api/school')).data.school, null, 'and it sees nobody');
});

test('an invite link signs someone up with the role on the list, once', async () => {
  const { f, name } = await newSchool();
  const email = address('kid');
  await f.post('/api/school/people', { people: [{ email, name: 'Kid Lee', role: 'student', grades: ['10'] }] });
  const token = await linkFor(f, email);
  const info = await client().get(`/api/invite/${token}`);
  assert.deepStrictEqual([info.data.school.name, info.data.email, info.data.roleLabel, info.data.account, info.data.hasAccount], [name, email, 'Student', 'student', false]);

  const wrong = await client().post('/api/auth/signup', { email: address('someone'), password: 'secret12', firstName: 'A', lastName: 'B', inviteToken: token });
  assert.strictEqual(wrong.status, 403);
  // It asks to be a teacher, and has no age box: the school signed them up
  const r = await client().post('/api/auth/signup', { email, password: 'secret12', firstName: 'Kid', lastName: 'Lee', role: 'teacher', inviteToken: token });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.deepStrictEqual([r.data.user.role, r.data.user.org.name], ['student', name]);
  assert.strictEqual((await personIn(f, email)).status, 'joined');
  assert.strictEqual((await client().get(`/api/invite/${token}`)).status, 404, 'one use');
});

test('someone with an account joins by the link, only as themselves and the right kind', async () => {
  const { f } = await newSchool();
  const c = client(), email = address('tess');
  await teacher(c, 'Tess', { email });
  await f.post('/api/school/people', { people: [{ email, role: 'teacher', grades: ['9', '10'] }] });
  const token = await linkFor(f, email);
  assert.strictEqual((await client().get(`/api/invite/${token}`)).data.hasAccount, true);
  const stranger = client();
  await teacher(stranger, 'Sly');
  const no = await stranger.post(`/api/invite/${token}/accept`);
  assert.strictEqual(no.status, 403);
  assert.match(no.data.error, /This invite is for/);
  assert.strictEqual((await c.post(`/api/invite/${token}/accept`)).status, 200);
  assert.strictEqual((await c.get('/api/school')).data.people.length, 2);

  const kid = client(), kidEmail = address('kay');
  await student(kid, 'Kay', { email: kidEmail });
  await f.post('/api/school/people', { people: [{ email: kidEmail, role: 'teacher' }] });
  const r = await kid.post(`/api/invite/${await linkFor(f, kidEmail)}/accept`);
  assert.strictEqual(r.status, 409, 'a listed role never upgrades a student account');
  assert.strictEqual((await kid.get('/api/me')).data.user.org, null);
});

test('a facilitator invited in runs the school too', async () => {
  const { f } = await newSchool();
  const email = address('vice');
  await f.post('/api/school/people', { people: [{ email, role: 'facilitator' }] });
  const c = client();
  const r = await c.post('/api/auth/signup', { email, password: 'secret12', firstName: 'Vi', lastName: 'Ce', inviteToken: await linkFor(f, email) });
  assert.deepStrictEqual([r.data.user.role, r.data.user.facilitator], ['teacher', true]);
  assert.strictEqual((await c.get('/api/school')).data.canRun, true);
  assert.deepStrictEqual((await c.get('/api/school')).data.school.facilitators.length, 2);
});

test('teachers see everyone at the school; students don’t; only facilitators change it', async () => {
  const { f } = await newSchool();
  const tEmail = address('tina'), sEmail = address('sid'), waiting = address('wes');
  await f.post('/api/school/people', { people: [{ email: tEmail, role: 'teacher', grades: ['9'] }, { email: sEmail, role: 'student', grades: ['9'] }, { email: waiting, role: 'student', grades: ['10'] }] });
  const t = client(), s = client();
  await t.post('/api/auth/signup', { email: tEmail, password: 'secret12', firstName: 'Tina', lastName: 'T', inviteToken: await linkFor(f, tEmail) });
  await s.post('/api/auth/signup', { email: sEmail, password: 'secret12', firstName: 'Sid', lastName: 'S', inviteToken: await linkFor(f, sEmail) });

  const seen = (await t.get('/api/school')).data;
  assert.strictEqual(seen.canRun, false);
  assert.strictEqual(seen.people.length, 4);
  assert.deepStrictEqual(seen.people.find(p => p.email === waiting).status, 'waiting');
  assert.strictEqual(seen.people.some(p => 'invitedAt' in p), false, 'invite details stay with the facilitator');
  assert.strictEqual((await s.get('/api/school')).status, 403);
  assert.strictEqual((await client().get('/api/school')).status, 401);

  const id = seen.people[0].id;
  for (const [url, body] of [['/api/school/people', { people: [{ email: address('x') }] }], ['/api/school/people/update', { ids: [id], role: 'student' }], ['/api/school/people/remove', { ids: [id] }], ['/api/school/invites', { ids: [id], copy: true }]]) {
    assert.strictEqual((await t.post(url, body)).status, 403, url);
    assert.strictEqual((await s.post(url, body)).status, 403, url);
  }
});

test('a pasted list is checked, and pasting again corrects it', async () => {
  const { f } = await newSchool();
  const a = address('ann');
  const r = await f.post('/api/school/people', { people: [{ email: ` ${a.toUpperCase()} `, role: 'teacher', grades: ['9', '10', 'banana'] }, { email: a }, { email: 'nope' }, { email: address('bo'), role: 'wizard' }] });
  assert.deepStrictEqual([r.data.added, r.data.updated, r.data.skipped.map(s => s.why)], [2, 0, ['listed twice', 'not an email address']]);
  assert.strictEqual(r.data.ids.length, 2);
  const p = await personIn(f, a);
  assert.deepStrictEqual([p.role, p.grades, p.status], ['teacher', ['9', '10'], 'added']);
  assert.strictEqual((await peopleOf(f)).find(x => x.email.startsWith('bo')).role, 'student', 'an unknown role is the least powerful one');
  const again = await f.post('/api/school/people', { people: [{ email: a, role: 'advisor', grades: ['11'] }] });
  assert.deepStrictEqual([again.data.added, again.data.updated], [0, 1]);
  assert.deepStrictEqual([(await personIn(f, a)).role, (await personIn(f, a)).grades], ['advisor', ['11']]);
  assert.strictEqual((await f.post('/api/school/people', { people: [] })).status, 400);
});

test('roles and grades change in bulk, within what an account can be', async () => {
  const { f, user } = await newSchool();
  const s = address('sal'), one = address('one'), two = address('two');
  await f.post('/api/school/people', { people: [{ email: s, role: 'student' }, { email: one }, { email: two }] });
  await client().post('/api/auth/signup', { email: s, password: 'secret12', firstName: 'Sal', lastName: 'S', inviteToken: await linkFor(f, s) });
  const ids = [(await personIn(f, one)).id, (await personIn(f, two)).id];
  assert.strictEqual((await f.post('/api/school/people/update', { ids, grades: ['7'] })).status, 200);
  assert.deepStrictEqual((await personIn(f, two)).grades, ['7']);
  const flip = await f.post('/api/school/people/update', { ids: [(await personIn(f, s)).id], role: 'teacher' });
  assert.strictEqual(flip.status, 409, 'a joined student stays a student');
  const self = await f.post('/api/school/people/update', { ids: [(await personIn(f, user.email)).id], role: 'teacher' });
  assert.strictEqual(self.status, 409, 'a school keeps a facilitator');
  assert.match(self.data.error, /needs a facilitator/);
});

test('removing someone takes them out of the school and off the list, and their invite stops working', async () => {
  const { f, user } = await newSchool();
  const a = address('amy'), b = address('ben');
  await f.post('/api/school/people', { people: [{ email: a, role: 'student' }, { email: b, role: 'student' }] });
  const c = client();
  await c.post('/api/auth/signup', { email: a, password: 'secret12', firstName: 'Amy', lastName: 'A', inviteToken: await linkFor(f, a) });
  const token = await linkFor(f, b);
  assert.strictEqual((await f.post('/api/school/people/remove', { ids: [(await personIn(f, a)).id, (await personIn(f, b)).id] })).data.removed, 2);
  assert.strictEqual((await c.get('/api/me')).data.user.org, null);
  assert.strictEqual((await client().get(`/api/invite/${token}`)).status, 404);
  assert.strictEqual((await f.post('/api/school/people/remove', { ids: [(await personIn(f, user.email)).id] })).status, 409, 'not the last facilitator');
  assert.strictEqual((await f.patch('/api/me', { school: null })).status, 409, 'and they can’t just leave');
});

test('email invites go out with a working link, and copying works when email isn’t set up', async () => {
  const { f, name } = await newSchool();
  const a = address('eva');
  await f.post('/api/school/people', { people: [{ email: a, role: 'teacher' }] });
  const id = (await personIn(f, a)).id;
  const before = mail.sent.length;
  const r = await f.post('/api/school/invites', { ids: [id] });
  assert.deepStrictEqual([r.data.sent, r.data.stopped], [1, null]);
  const m = mail.sent[before];
  assert.deepStrictEqual([m.to, m.subject], [a, `Join ${name} on Visor`]);
  assert.match(m.text, /as a teacher/);
  const token = /\/invite\/([\w-]+)/.exec(m.text)[1];
  assert.strictEqual((await client().get(`/api/invite/${token}`)).data.email, a);
  assert.strictEqual((await personIn(f, a)).status, 'invited');

  const saved = process.env.MAIL_TRANSPORT;
  delete process.env.MAIL_TRANSPORT;
  try {
    const off = await f.post('/api/school/invites', { ids: [id] });
    assert.deepStrictEqual([off.status, off.data.mailReady], [503, false]);
    assert.strictEqual((await f.get('/api/school')).data.mailReady, false);
    assert.strictEqual((await f.post('/api/school/invites', { ids: [id], copy: true })).data.links.length, 1);
  } finally { process.env.MAIL_TRANSPORT = saved; }
});

test('the logo: only a facilitator sets it, anyone can load it, and a new one replaces it', async () => {
  const { f, user } = await newSchool();
  const r = await f.post('/api/school/logo', PNG, { 'Content-Type': 'image/png' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  const url = r.data.user.org.logoUrl;
  const got = await client().get(url);
  assert.deepStrictEqual([got.status, got.headers.get('content-type')], [200, 'image/png']);
  assert.strictEqual((await f.post('/api/school/logo', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), { 'Content-Type': 'image/png' })).status, 400);
  const other = client();
  await teacher(other, 'Otto');
  assert.strictEqual((await other.post('/api/school/logo', PNG, { 'Content-Type': 'image/png' })).status, 404);
  const next = await f.post('/api/school/logo', PNG, { 'Content-Type': 'image/png' });
  assert.notStrictEqual(next.data.user.org.logoUrl, url);
  assert.strictEqual((await client().get(url)).status, 404);
  assert.strictEqual((await f.del('/api/school/logo')).data.user.org.logoUrl, undefined);
  assert.strictEqual(user.facilitator, true);
});

test('a school from before stays open until a teacher takes it over, and its people stay', async () => {
  const name = `Old School ${++n}`;
  await repo.withCore(core => { core.orgs[`old-${n}`] = { id: `old-${n}`, name, createdAt: new Date().toISOString() }; });
  const t = client(), s = client();
  const tr = await teacher(t, 'Ola', { schoolName: name });
  assert.deepStrictEqual([tr.status, tr.data.user.facilitator], [200, undefined], 'joining isn’t running it');
  const sr = await student(s, 'Oli', { schoolName: name });
  assert.strictEqual(sr.status, 200);
  assert.strictEqual((await t.get('/api/school')).data.people.length, 2);
  assert.strictEqual((await t.post('/api/school/claim')).data.user.facilitator, true);
  assert.strictEqual((await t.post('/api/school/claim')).status, 409);
  const after = await peopleOf(t);
  assert.deepStrictEqual(after.map(p => [p.status, p.role]).sort(), [['joined', 'facilitator'], ['joined', 'student']]);
  assert.strictEqual((await teacher(client(), 'Late', { schoolName: name })).status, 403);
});

test('a teacher with no school can create one later', async () => {
  const c = client();
  await teacher(c, 'Nia');
  const none = (await c.get('/api/school')).data;
  assert.deepStrictEqual([none.school, none.grades.includes('K'), none.roles.length], [null, true, 5]);
  const name = `Later School ${++n}`;
  const r = await c.post('/api/school', { name });
  assert.deepStrictEqual([r.data.user.facilitator, r.data.user.org.name], [true, name]);
  assert.strictEqual((await c.post('/api/school', { name: 'Another' })).status, 409);
  const kid = client();
  await student(kid, 'Kit');
  assert.strictEqual((await kid.post('/api/school', { name: 'Mine' })).status, 403);
});

test('a pasted list: emails alone, or spreadsheet columns in any order', () => {
  const { rows, bad } = SchoolPaste.parse([
    'Email, Name, Role, Grade', 'maya@s.org', 'MAYA@s.org', 'a@s.org b@s.org; c@s.org',
    'Jo Park, jo@s.org, teacher, 9-10', 'sam@s.org\tStudent\tGrade 10\tSam\tLee', 'ms@s.org, counselor, 9, 10, 11th', 'k@s.org, K', 'pk@s.org, Pre-K', 'd@s.org, admin', 'no address here'
  ].join('\n'));
  const by = e => rows.find(r => r.email === e);
  assert.deepStrictEqual(rows.map(r => r.email), ['maya@s.org', 'a@s.org', 'b@s.org', 'c@s.org', 'jo@s.org', 'sam@s.org', 'ms@s.org', 'k@s.org', 'pk@s.org', 'd@s.org']);
  assert.deepStrictEqual(by('maya@s.org'), { email: 'maya@s.org', name: '', role: null, grades: [] });
  assert.deepStrictEqual(by('jo@s.org'), { email: 'jo@s.org', name: 'Jo Park', role: 'teacher', grades: ['9', '10'] });
  assert.deepStrictEqual(by('sam@s.org'), { email: 'sam@s.org', name: 'Sam Lee', role: 'student', grades: ['10'] });
  assert.deepStrictEqual([by('ms@s.org').role, by('ms@s.org').grades], ['advisor', ['9', '10', '11']]);
  assert.deepStrictEqual([by('k@s.org').grades, by('pk@s.org').grades, by('d@s.org').role], [['K'], ['PK'], 'facilitator']);
  assert.deepStrictEqual(bad, ['no address here']);
  assert.deepStrictEqual(SchoolPaste.gradesOf('9/10'), ['9', '10']);
  assert.deepStrictEqual(SchoolPaste.gradesOf('K-2'), ['K', '1', '2']);
  assert.strictEqual(SchoolPaste.gradesOf('Algebra'), null);
  assert.strictEqual(SchoolPaste.gradesOf('13'), null);
});
