// Time limits, teacher pauses and session windows, and what happens when a
// student is removed from a class or a report is replaced. Runs on a local
// PGlite store in a temp folder; nothing here reaches Firebase, Google or Gemini
// (their settings are blanked and pointed at a closed local port).
'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-fixes-'));
Object.assign(process.env, {
  VISOR_PLATFORM: '', DATABASE_URL: '',
  PGLITE_DIR: path.join(DATA, 'pglite'), VISOR_IMAGE_DIR: path.join(DATA, 'images'), VISOR_AUDIO_DIR: path.join(DATA, 'audio'),
  VISOR_DEV_LOGIN: '1', VISOR_SCHOOL_OPTIONAL: '1', SESSION_SECRET: 'test-secret', NODE_ENV: 'test',
  GEMINI_API_KEY: '', GEMINI_VIA: 'apikey', GEMINI_BASE_URL: 'http://127.0.0.1:9', VERTEX_BASE_URL: 'http://127.0.0.1:9', DRIVE_API_BASE: 'http://127.0.0.1:9',
  GOOGLE_CLIENT_ID: '', GOOGLE_API_KEY: '', GOOGLE_APP_ID: '', CLASSROOM_IMPORT: ''
});
const test = require('node:test');
const assert = require('node:assert');
const S = require('../lib/sessions');
const C = require('../lib/classes');
const research = require('../lib/research');
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
    const r = await fetch(base + url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    let data = null;
    try { data = await r.json(); } catch {}
    return { status: r.status, data };
  };
  return { get: u => call('GET', u), post: (u, b, h) => call('POST', u, b || {}, h), patch: (u, b) => call('PATCH', u, b), del: u => call('DELETE', u) };
}
let n = 0;
async function signup(c, role, firstName, extra = {}) {
  const r = await c.post('/api/auth/signup', { email: `${firstName.toLowerCase()}${++n}@fixes.test`, password: 'secret12', firstName, lastName: 'Test', role, ...(role === 'student' ? { over13: true } : {}), ...extra });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return r.data.user;
}
const T0 = Date.parse('2026-11-02T14:00:00Z');
const min = m => T0 + m * 60000;
const ISO = t => new Date(t).toISOString();

test('a teacher’s pause stops the clock', () => {
  const s = S.newSession({ doc: { id: 'd', assignmentId: 'a', classId: 'c', seq: 0 }, assignment: { writing: {} }, userId: 'u', deadlineAt: ISO(min(45)), now: T0 });
  s.lastBeat = ISO(min(10));
  S.teacherPause(s, min(10));
  // the deadline passes during the pause, with beats still arriving: nothing ends
  s.lastBeat = ISO(min(46));
  assert.strictEqual(S.sweep(s, min(46)), null);
  assert.notStrictEqual(s.state, 'ended');
  S.teacherResume(s, min(46));
  assert.strictEqual(s.deadlineAt, ISO(min(81)), '36 paused minutes go back on the clock');
  s.lastBeat = ISO(min(80));
  assert.strictEqual(S.sweep(s, min(80)), null);
  s.lastBeat = ISO(min(81));
  assert.strictEqual(S.sweep(s, min(81)), 'time-limit');
  // and the pause isn't time used
  assert.strictEqual(S.usedMs([s]), 45 * 60000);
});

test('the session window: extra time carries past it, and everyone is told the real end', () => {
  const windowEnd = ISO(min(45));
  assert.strictEqual(S.computeDeadline({ timeLimitMin: 60, windowEnd, now: T0 }), ISO(min(45)), 'a limit longer than the window ends at the window');
  assert.strictEqual(S.computeDeadline({ timeLimitMin: 45, multiplier: 1.5, windowEnd, now: T0 }), ISO(min(67.5)), '1.5× keeps the extra 22.5 minutes');
  assert.strictEqual(S.windowExtra({ timeLimitMin: 45, multiplier: 1.5 }), 22.5 * 60000);
  assert.strictEqual(S.windowExtra({ timeLimitMin: null, multiplier: 2 }), 0);

  // a teacher adds time near the end: it isn't lost to the window
  const s = S.newSession({ doc: { id: 'd', assignmentId: 'a', classId: 'c', seq: 0 }, assignment: { writing: {} }, userId: 'u', now: T0 });
  S.addTime(s, 10, min(40));
  s.lastBeat = ISO(min(50));
  assert.strictEqual(S.sweep(s, min(50), { windowEnd }), null);
  s.lastBeat = ISO(min(55));
  assert.strictEqual(S.sweep(s, min(55), { windowEnd }), 'window-closed');
});

test('a time in a message goes out marked for the page to localize', () => {
  assert.strictEqual(S.windowProblem({ windowStart: ISO(min(60)) }, T0), `This writing session opens {{when:${ISO(min(60))}}}.`);
});

test('a research event can’t carry a time that breaks the teacher’s review', () => {
  const ev = research.cleanEvent({ type: 'visit', t: -1e300, url: 'https://example.com/' }, T0) || research.cleanEvent({ type: 'search', t: -1e300, query: 'x', engine: 'google' }, T0);
  assert.ok(ev.t >= 0);
  assert.doesNotThrow(() => new Date(ev.t).toISOString());
});

test('invites are capped per class; removing a student clears their private note', () => {
  const core = { users: {}, classes: {}, projects: {} };
  const cls = { id: 'c', teacherId: 'o', studentIds: ['s'], accommodations: { s: { timeMultiplier: 2, note: 'IEP' } }, pendingInvites: Array.from({ length: 500 }, (_, i) => ({ email: `p${i}@x.test` })) };
  const r = C.addStudents(core, cls, { emails: ['new@x.test', 'p3@x.test'] });
  assert.strictEqual(cls.pendingInvites.length, 500);
  assert.deepStrictEqual([r.invited, r.skipped.map(x => x.email)], [['p3@x.test'], ['new@x.test']]);
  C.removeStudent(cls, 's');
  assert.deepStrictEqual([cls.studentIds, cls.accommodations], [[], {}]);
});

async function essay(limit) {
  const t = client(), st = client();
  await signup(t, 'teacher', 'Tess');
  const cls = (await t.post('/api/classes', { name: 'Fixes' })).data.class;
  const me = await signup(st, 'student', 'Stu', { classCode: cls.joinCode });
  const a = (await t.post(`/api/classes/${cls.id}/assignments`, { type: 'writing', title: 'Essay', writing: { mode: 'open', timeLimitMin: limit } })).data.assignment;
  await t.post(`/api/assignments/${a.id}/publish`, {});
  const doc = (await st.get(`/api/write/${a.id}`)).data.doc;
  return { t, st, cls, me, a, doc };
}

test('coming back to a stale session keeps the time already used', async () => {
  const { st, doc } = await essay(45);
  let r = await st.post(`/api/write/${doc.id}/sessions`, { surfaceId: 'one', surf: 'tab' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  // 40 minutes of writing, last heard from two minutes ago: under the timeout, past the takeover
  const id = r.data.session.id, ago = m => new Date(Date.now() - m * 60000).toISOString();
  await repo.updateRecord('session', id, s => { s.startedAt = ago(42); s.lastBeat = ago(2); s.deadlineAt = ago(-3); });
  r = await st.post(`/api/write/${doc.id}/sessions`, { surfaceId: 'two', surf: 'tab' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.notStrictEqual(r.data.session.id, id, 'a new session');
  const left = (Date.parse(r.data.session.deadlineAt) - Date.now()) / 60000;
  assert.ok(left > 4 && left < 6, `five minutes left, not a fresh 45 (got ${left.toFixed(1)})`);
});

test('a surface can’t be named after a prototype key', async () => {
  const { st, doc } = await essay(null);
  const r = await st.post(`/api/write/${doc.id}/sessions`, { surfaceId: '__proto__', surf: 'tab' });
  assert.strictEqual(r.status, 400);
  assert.strictEqual({}.lastBeat, undefined);
});

test('a window that closes counts as time running out for auto-submit; a paused student can’t walk away', async () => {
  const { t, st, doc, a } = await essay(null);
  await t.patch(`/api/assignments/${a.id}`, { writing: { autoSubmitOnTimeUp: true } });
  const r = await st.post(`/api/write/${doc.id}/sessions`, { surfaceId: 'one', surf: 'tab' });
  const H = { 'X-Visor-Session': r.data.token };
  const paused = await repo.updateRecord('session', r.data.session.id, s => { S.teacherPause(s, Date.now()); });
  assert.strictEqual(paused.teacherPaused, true);
  const e = await st.post(`/api/write/${doc.id}/end`, {}, H);
  assert.deepStrictEqual([e.status, e.data.error], [409, 'Your teacher paused this session. You can end it once they resume it.']);
  await repo.updateRecord('session', paused.id, s => { S.teacherResume(s, Date.now()); });
  const past = new Date(Date.now() - 1000).toISOString();
  const row = await repo.getRecord('assignment', a.id);
  await repo.updateRecord('assignment', a.id, x => { x.writing = { ...row.writing, autoSubmitOnTimeUp: true, windowEnd: past }; });
  await st.get(`/api/write/${a.id}`);
  const after = await repo.getRecord('doc', doc.id);
  assert.deepStrictEqual([after.status, after.autoSubmitted], ['submitted', true]);
});

test('removing a student ends their session, takes them off group projects, keeps their work', async () => {
  const { t, st, cls, me, doc } = await essay(null);
  const group = (await t.post(`/api/classes/${cls.id}/assignments`, { type: 'group', title: 'Team', group: { groups: [{ name: 'One', studentIds: [me.id], docUrl: 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/edit' }] } })).data.assignment;
  const pid = group.group.projectIds[0];
  const s = (await st.post(`/api/write/${doc.id}/sessions`, { surfaceId: 'one', surf: 'tab' })).data;
  assert.strictEqual((await st.get(`/api/projects/${pid}`)).status, 200);
  const r = await t.del(`/api/classes/${cls.id}/students/${me.id}`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await repo.getRecord('session', s.session.id)).state, 'ended');
  assert.strictEqual((await repo.getRecord('session', s.session.id)).endReason, 'removed');
  assert.notStrictEqual((await st.get(`/api/projects/${pid}`)).status, 200);
  const again = await st.post(`/api/write/${doc.id}/sessions`, { surfaceId: 'two', surf: 'tab' });
  assert.deepStrictEqual([again.status, again.data.error], [403, 'You’re no longer in this class. Ask your teacher to add you back.']);
  assert.ok(await repo.getRecord('doc', doc.id), 'their essay stays');
});

test('a student’s pasted report can’t replace someone else’s', async () => {
  const t = client(), a = client(), b = client();
  await signup(t, 'teacher', 'Tia');
  const cls = (await t.post('/api/classes', { name: 'Reports' })).data.class;
  const A = await signup(a, 'student', 'Ann', { classCode: cls.joinCode });
  const B = await signup(b, 'student', 'Bob', { classCode: cls.joinCode });
  const g = (await t.post(`/api/classes/${cls.id}/assignments`, { type: 'group', title: 'Team', group: { groups: [{ name: 'One', studentIds: [A.id, B.id], docUrl: 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/edit' }] } })).data.assignment;
  await t.post(`/api/assignments/${g.id}/publish`, {});
  const pid = g.group.projectIds[0];
  const report = name => ({ fileId: 'file-1', docMeta: { title: 'Doc' }, contributors: [{ name, email: 123, percentContribution: 100, revisionCount: 1 }] });
  const put = (c, name) => c.post(`/api/projects/${pid}/resources/extension`, { report: report(name) });
  const reports = async () => (await t.get(`/api/projects/${pid}`)).data.project.resources.filter(r => r.type === 'extension').length;
  assert.strictEqual((await put(a, 'Ann')).status, 200);
  assert.strictEqual((await put(b, 'Bob')).status, 200);
  assert.strictEqual(await reports(), 2, 'Bob’s paste leaves Ann’s in place');
  assert.strictEqual((await put(a, 'Ann again')).status, 200);
  assert.strictEqual(await reports(), 2, 'Ann replaces her own');
  assert.strictEqual((await put(t, 'Tia')).status, 200);
  assert.strictEqual(await reports(), 1, 'a teacher’s replaces every report of that document');
});

test('returned feedback doesn’t say who gave it', async () => {
  const { t, st, a, doc } = await essay(null);
  await st.post(`/api/write/${doc.id}/sessions`, { surfaceId: 'one', surf: 'tab' });
  await st.post(`/api/write/${doc.id}/submit`, {});
  const r = await t.post(`/api/review/${doc.id}/feedback`, { comment: 'Good start', returnToStudent: true });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  const fb = (await st.get(`/api/write/${a.id}`)).data.doc.feedback;
  assert.strictEqual(fb.comment, 'Good start');
  assert.strictEqual(fb.by, undefined);
});

test('the last words typed as time runs out still count, and only for a moment', async () => {
  const { st, doc } = await essay(45);
  const r = await st.post(`/api/write/${doc.id}/sessions`, { surfaceId: 'one', surf: 'tab' });
  const H = { 'X-Visor-Session': r.data.token };
  const op = s => ({ k: 'i', at: 0, s, t: Date.now(), src: 'type' });
  // the buzzer went two seconds ago, and these were on their way
  await repo.updateRecord('session', r.data.session.id, s => { s.deadlineAt = new Date(Date.now() - 2000).toISOString(); });
  let w = await st.post(`/api/write/${doc.id}/ops`, { baseSeq: 0, ops: [op('Last words')], surfaceId: 'one' }, H);
  assert.strictEqual(w.status, 200, JSON.stringify(w.data));
  assert.strictEqual((await repo.getRecord('doc', doc.id)).text, 'Last words');
  assert.strictEqual((await repo.getRecord('session', r.data.session.id)).state, 'ended');
  // a moment later it's over
  await repo.updateRecord('session', r.data.session.id, s => { s.endedAt = new Date(Date.now() - 60000).toISOString(); });
  w = await st.post(`/api/write/${doc.id}/ops`, { baseSeq: w.data.seq, ops: [op('Too late ')], surfaceId: 'one' }, H);
  assert.deepStrictEqual([w.status, w.data.ended], [409, true]);
  assert.strictEqual((await repo.getRecord('doc', doc.id)).text, 'Last words');
});

test('a session the student ended takes no more writing', async () => {
  const { st, doc } = await essay(null);
  const r = await st.post(`/api/write/${doc.id}/sessions`, { surfaceId: 'one', surf: 'tab' });
  const H = { 'X-Visor-Session': r.data.token };
  await st.post(`/api/write/${doc.id}/end`, {}, H);
  const w = await st.post(`/api/write/${doc.id}/ops`, { baseSeq: 0, ops: [{ k: 'i', at: 0, s: 'After', t: Date.now(), src: 'type' }], surfaceId: 'one' }, H);
  assert.deepStrictEqual([w.status, w.data.ended], [409, true]);
});

test('a link with a stray % or a name with a stray hyphen can’t break an essay', () => {
  const grade = require('../lib/source-grade');
  const cite = require('../lib/cite');
  for (const url of ['https://web.archive.org/web/2012/http://www.example.fr/caf%E9.html', 'https://web.archive.org/web/2012/https://example.com/50%-off']) {
    assert.ok(grade.grade({ type: 'web', url, title: 'A page' }), url);
  }
  for (const name of ['John Smith - CNN', 'Mary - Jane Smith', 'Jean- Luc Godard']) {
    const f = cite.format({ type: 'web', title: 'A page', authors: [name], url: 'https://example.com/' }, 'apa');
    assert.ok(f.text.length > 0, name);
    assert.doesNotMatch(f.text, /undefined/);
  }
});

test('research keeps only web addresses, so a teacher can’t be handed a script as a link', () => {
  const T = Date.parse('2026-11-02T14:00:00Z');
  assert.strictEqual(research.cleanEvent({ type: 'search', t: T, query: 'x', engine: 'google', url: 'javascript:alert(1)' }, T).url, undefined);
  assert.strictEqual(research.cleanEvent({ type: 'search', t: T, query: 'x', engine: 'google', url: 'https://example.com/a' }, T).url, 'https://example.com/a');
});

test('“End all and submit” keeps the last words typed before the teacher pressed it', async () => {
  const { t, st, doc, a } = await essay(null);
  const r = await st.post(`/api/write/${doc.id}/sessions`, { surfaceId: 'one', surf: 'tab' });
  const H = { 'X-Visor-Session': r.data.token };
  const end = await t.post(`/api/assignments/${a.id}/live/action`, { action: 'end-all-submit' });
  assert.strictEqual(end.status, 200, JSON.stringify(end.data));
  assert.strictEqual((await repo.getRecord('doc', doc.id)).status, 'submitted');
  const w = await st.post(`/api/write/${doc.id}/ops`, { baseSeq: 0, ops: [{ k: 'i', at: 0, s: 'Last line', t: Date.now(), src: 'type' }], surfaceId: 'one' }, H);
  assert.strictEqual(w.status, 200, JSON.stringify(w.data));
  assert.strictEqual((await repo.getRecord('doc', doc.id)).text, 'Last line');
});

