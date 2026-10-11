// The whole classroom flow through the HTTP API, on a local PGlite store in a
// temp folder. Nothing here reaches Firebase, Google or Gemini: the Google and
// Gemini settings are blanked and pointed at a closed local port.
'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-api-'));
Object.assign(process.env, {
  PGLITE_DIR: path.join(DATA, 'pglite'), VISOR_DEV_LOGIN: '1', SESSION_SECRET: 'test-secret', NODE_ENV: 'test',
  GEMINI_API_KEY: '', GEMINI_VIA: 'apikey', GEMINI_BASE_URL: 'http://127.0.0.1:9', VERTEX_BASE_URL: 'http://127.0.0.1:9', DRIVE_API_BASE: 'http://127.0.0.1:9',
  GOOGLE_CLIENT_ID: '', GOOGLE_API_KEY: '', GOOGLE_APP_ID: '', CLASSROOM_IMPORT: ''
});

const test = require('node:test');
const assert = require('node:assert');
const app = require('../server');

const sha = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const norm = s => s.replace(/\s+/g, ' ').trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));

let server, base;
test.before(async () => {
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); fs.rmSync(DATA, { recursive: true, force: true }); });

const base_ = () => base;
const cookieOf = async c => c.cookie();

// A signed-in person: keeps the __session cookie between calls
function client() {
  let cookie = '';
  const call = async (method, url, body, headers = {}) => {
    const r = await fetch(base + url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    let data = null;
    try { data = await r.json(); } catch {}
    return { status: r.status, data };
  };
  return { get: (u, h) => call('GET', u, null, h), post: (u, b, h) => call('POST', u, b || {}, h), patch: (u, b) => call('PATCH', u, b), del: (u, b) => call('DELETE', u, b), cookie: () => cookie };
}

test('the classroom flow, end to end', async t => {
  const teacher = client(), sam = client(), kim = client();

  // 1. teacher signs up, creates a class, adds a student by email (no account yet)
  let r = await teacher.post('/api/auth/signup', { email: 'teacher@school.test', password: 'secret12', firstName: 'Tess', lastName: 'Teacher', role: 'teacher' });
  assert.strictEqual(r.status, 200);
  r = await teacher.post('/api/classes', { name: 'English 10' });
  const cls = r.data.class;
  assert.match(cls.joinCode, /^[A-Z2-9]{6}$/);
  r = await teacher.post(`/api/classes/${cls.id}/students`, { emails: ['sam@school.test'] });
  assert.deepStrictEqual(r.data.invited, ['sam@school.test']);

  // 2. the student signs up (no age box: their school signed them up) and joins automatically
  r = await sam.post('/api/auth/signup', { email: 'sam@school.test', password: 'secret12', firstName: 'Sam', lastName: 'Student', role: 'student' });
  assert.strictEqual(r.status, 200);
  r = await sam.get('/api/classes');
  assert.deepStrictEqual(r.data.classes.map(c => c.id), [cls.id]);
  assert.strictEqual(r.data.classes[0].joinCode, undefined, 'students never see the join code');
  // a second student joins with the code; without the age box and no invite, sign-up is refused
  r = await kim.post('/api/auth/signup', { email: 'kim@school.test', password: 'secret12', firstName: 'Kim', lastName: 'Park', role: 'student', classCode: cls.joinCode });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.data.error, 'Ask your teacher to add you to their class.');
  r = await kim.post('/api/auth/signup', { email: 'kim@school.test', password: 'secret12', firstName: 'Kim', lastName: 'Park', role: 'student', classCode: cls.joinCode, over13: true });
  assert.strictEqual(r.status, 200);

  // 3. teacher creates and publishes an open writing assignment
  r = await teacher.post(`/api/classes/${cls.id}/assignments`, { type: 'writing', title: 'Narrative', instructions: 'Tell a story.', writing: { mode: 'open', allowPaste: 'allow', templateText: 'Title: ' } });
  assert.strictEqual(r.status, 200);
  const a = r.data.assignment;
  r = await sam.get(`/api/write/${a.id}`);
  assert.strictEqual(r.status, 404, 'unpublished assignments are invisible to students');
  r = await teacher.post(`/api/assignments/${a.id}/publish`, { published: true });
  assert.ok(r.data.assignment.publishedAt);
  r = await teacher.get(`/api/write/${a.id}`);
  assert.strictEqual(r.status, 403);
  assert.ok(r.data.reviewUrl);

  // 4. the student gets the doc (starter text attributed to the teacher), starts a session, writes
  r = await sam.get(`/api/write/${a.id}`);
  assert.strictEqual(r.status, 200);
  let doc = r.data.doc;
  assert.strictEqual(doc.text, 'Title: ');
  assert.strictEqual(doc.seq, 1);
  r = await sam.get(`/api/write/${doc.id}/ops`);
  assert.strictEqual(r.data.ops[0].src, 'template');
  r = await sam.post(`/api/write/${doc.id}/ops`, { baseSeq: 1, ops: [], surfaceId: 'tab-1' });
  assert.strictEqual(r.status, 401, 'no writing without a session');

  r = await sam.post(`/api/write/${doc.id}/sessions`, { surfaceId: 'tab-1', surf: 'tab', extPresent: false, fullscreen: false });
  assert.strictEqual(r.status, 200);
  const H = { 'X-Visor-Session': r.data.token };
  const ins = (at, s, extra = {}) => ({ k: 'i', at, s, t: Date.now(), src: 'type', ...extra });
  let text = 'Title: ';
  const typed = 'The Storm';
  const ops = [...typed].map((ch, i) => ins(text.length + i, ch));
  text += typed;
  r = await sam.post(`/api/write/${doc.id}/ops`, { baseSeq: 1, ops, textHash: sha(text), surfaceId: 'tab-1' }, H);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.seq, 1 + typed.length);
  // a stale baseSeq gets the server's state back
  r = await sam.post(`/api/write/${doc.id}/ops`, { baseSeq: 1, ops: [ins(0, 'x')], surfaceId: 'tab-1' }, H);
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.data.text, text);
  // only the lease holder may write
  r = await sam.post(`/api/write/${doc.id}/ops`, { baseSeq: 10, ops: [ins(0, 'x')], surfaceId: 'someone-else' }, H);
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.data.notLeaseHolder, true);

  // beats: focused, then away for 5 s, then back
  const beat = b => sam.post(`/api/write/${doc.id}/beat`, { surfaceId: 'tab-1', surf: 'tab', visible: true, fullscreen: false, ...b }, H);
  r = await beat({ focused: true });
  assert.strictEqual(r.data.state, 'active');
  r = await beat({ focused: false, visible: false });
  await sleep(5000);
  r = await beat({ focused: true });
  // 5. the session has exactly one pause, about 5 seconds long
  assert.strictEqual(r.data.pauseCount, 1);
  assert.ok(r.data.awayMs >= 4800 && r.data.awayMs < 8000, `away ${r.data.awayMs} ms`);
  assert.strictEqual(r.data.state, 'active');

  // 6. research: the extension (connected with its own token) records a copy;
  //    pasting the same text into the essay picks up where it came from
  r = await sam.post('/api/ext/token');
  const X = { 'X-Visor-Token': r.data.token };
  r = await sam.get('/api/ext/me', X);
  assert.strictEqual(r.data.user.email, 'sam@school.test');
  const copied = 'Teenagers’ circadian rhythms shift later during puberty.';
  r = await sam.post('/api/ext/research', { sessionToken: H['X-Visor-Session'], docId: doc.id, events: [
    { type: 'search', t: Date.now() - 20000, url: 'https://www.google.com/search?q=teen+sleep', query: 'teen sleep', engine: 'google' },
    { type: 'visit', t: Date.now() - 15000, url: 'https://www.cdc.gov/sleep/', title: 'Sleep | CDC' },
    { type: 'copy', t: Date.now() - 10000, url: 'https://www.cdc.gov/sleep/', title: 'Sleep | CDC', copy: { hash: sha(norm(copied)), len: copied.length, preview: copied } }
  ] }, X);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.stored, 3);
  const seqNow = 1 + typed.length;
  const pasted = ' ' + copied;
  r = await sam.post(`/api/write/${doc.id}/ops`, { baseSeq: seqNow, ops: [ins(text.length, pasted, { src: 'paste', it: 'insertFromPaste', paste: { hash: sha(norm(pasted)), internal: false } })], textHash: sha(text + pasted), surfaceId: 'tab-1' }, H);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.pastes[0].origin.url, 'https://www.cdc.gov/sleep/');
  text += pasted;
  // someone else's extension token can't post into this session
  r = await kim.post('/api/ext/token');
  r = await kim.post('/api/ext/research', { sessionToken: H['X-Visor-Session'], docId: doc.id, events: [{ type: 'visit', url: 'https://x.example/' }] }, { 'X-Visor-Token': r.data.token });
  assert.strictEqual(r.status, 403);

  // 7. the student submits
  r = await sam.post(`/api/write/${doc.id}/submit`, {});
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.doc.status, 'submitted');
  r = await sam.post(`/api/write/${doc.id}/sessions`, { surfaceId: 'tab-2', surf: 'tab' });
  assert.strictEqual(r.status, 409, 'no new sessions once submitted');
  r = await beat({ focused: true });
  assert.strictEqual(r.data.ended, true);
  assert.strictEqual(r.data.endReason, 'submitted');
  t.diagnostic(`doc ${doc.id}: "${text}", 1 pause`);

  // the teacher sees the submission
  r = await teacher.get(`/api/assignments/${a.id}`);
  const row = r.data.submissions.find(x => x.student.email === 'sam@school.test');
  assert.strictEqual(row.status, 'submitted');
  assert.strictEqual(row.docId, doc.id);

  // 8. the teacher's process report and live board
  r = await teacher.get(`/api/review/${doc.id}`);
  assert.strictEqual(r.status, 200);
  const rep = r.data.report;
  assert.strictEqual(rep.engine.matchesDoc, true, 'the engine rebuilds the essay exactly from the op log');
  assert.strictEqual(rep.totals.sessions, 1);
  assert.strictEqual(rep.totals.pauses, 1);
  assert.strictEqual(rep.pastes[0].kind, 'research');
  assert.strictEqual(rep.pastes[0].origin.url, 'https://www.cdc.gov/sleep/');
  assert.ok(rep.survival.pct['pasted-research'] > 0 && rep.survival.pct.template > 0);
  assert.ok(rep.research.searches.some(x => x.query === 'teen sleep'));
  for (const n of rep.notes) assert.ok(!/\bAI\b|cheat|plagiar/i.test(n.text), n.text);
  r = await teacher.get(`/api/assignments/${a.id}/live`);
  assert.strictEqual(r.status, 200);
  const samRow = r.data.rows.find(x => x.student.email === 'sam@school.test');
  assert.strictEqual(samRow.status, 'submitted');
  assert.strictEqual(samRow.words, 10);
  assert.strictEqual(r.data.rows.find(x => x.student.email === 'kim@school.test').status, 'not-started');
  r = await sam.get(`/api/review/${doc.id}`);
  assert.strictEqual(r.status, 403, 'the review page is the teacher’s');
  r = await sam.get(`/api/assignments/${a.id}/live`);
  assert.strictEqual(r.status, 403);

  // the teacher returns it with feedback and reopens it; the student can write again
  r = await teacher.post(`/api/review/${doc.id}/feedback`, { comment: 'Good start.', score: 8, outOf: 10, returnToStudent: true, reopen: true });
  assert.strictEqual(r.data.doc.status, 'returned');
  r = await sam.get(`/api/write/${a.id}`);
  assert.strictEqual(r.data.doc.feedback.comment, 'Good start.');
  r = await sam.post(`/api/write/${doc.id}/sessions`, { surfaceId: 'tab-3', surf: 'tab' });
  assert.strictEqual(r.status, 200, 'a reopened document takes new sessions');
  // the teacher's live controls reach the student's next beat
  r = await teacher.post(`/api/assignments/${a.id}/live/action`, { action: 'message', studentIds: [samRow.student.id], message: 'Ten minutes left' });
  assert.strictEqual(r.data.changed, 1);
  r = await teacher.post(`/api/assignments/${a.id}/live/action`, { action: 'pause-all' });
  const H3 = { 'X-Visor-Session': (await sam.get(`/api/write/${a.id}`)).data.token };
  r = await sam.post(`/api/write/${doc.id}/beat`, { surfaceId: 'tab-3', surf: 'tab', focused: true, visible: true }, H3);
  assert.strictEqual(r.data.teacherMessage.text, 'Ten minutes left');
  assert.strictEqual(r.data.pause.reason, 'teacher');
  await teacher.post(`/api/assignments/${a.id}/live/action`, { action: 'end-all-submit' });
  r = await sam.get(`/api/write/${a.id}`);
  assert.strictEqual(r.data.doc.status, 'submitted');

  // 9. another student can't read the first student's doc or its op log
  r = await kim.get(`/api/write/${doc.id}/ops`);
  assert.strictEqual(r.status, 403);
  r = await kim.post(`/api/write/${doc.id}/sessions`, { surfaceId: 'x' });
  assert.strictEqual(r.status, 403);
});

test('group projects: one project per group, linked Docs, extension ingest', async () => {
  const teacher = client(), ana = client(), ben = client(), cal = client();
  await teacher.post('/api/auth/signup', { email: 'gt@school.test', password: 'secret12', firstName: 'Gia', lastName: 'Teacher', role: 'teacher' });
  const cls = (await teacher.post('/api/classes', { name: 'History 9' })).data.class;
  const ids = {};
  for (const [c, first] of [[ana, 'Ana'], [ben, 'Ben'], [cal, 'Cal']]) {
    const r = await c.post('/api/auth/signup', { email: `${first.toLowerCase()}@school.test`, password: 'secret12', firstName: first, lastName: 'Student', role: 'student', over13: true, classCode: cls.joinCode });
    ids[first] = r.data.user.id;
  }
  const docUrl = 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/edit';
  let r = await teacher.post(`/api/classes/${cls.id}/assignments`, { type: 'group', title: 'Civil rights project', group: { groups: [
    { name: 'Group 1', studentIds: [ids.Ana, ids.Ben], docUrl },
    { name: 'Group 2', studentIds: [ids.Cal] }
  ] } });
  assert.strictEqual(r.status, 200);
  const a = r.data.assignment;
  assert.strictEqual(a.group.projectIds.length, 2);
  assert.strictEqual(a.group.groups[0].fileId, '1AbCdEfGhIjKlMnOpQrStUvWxYz');
  r = await teacher.post(`/api/classes/${cls.id}/assignments`, { type: 'group', title: 'Bad', group: { groups: [{ name: 'G', studentIds: [], docUrl: 'https://example.com/doc' }] } });
  assert.strictEqual(r.status, 400, 'only Google Docs or Slides links');
  await teacher.post(`/api/assignments/${a.id}/publish`, {});

  // The existing project view, with a breadcrumb back to the class
  r = await ana.get(`/api/projects/${a.group.projectIds[0]}`);
  assert.strictEqual(r.data.project.name, 'Civil rights project – Group 1');
  assert.deepStrictEqual(r.data.project.students.map(s => s.firstName).sort(), ['Ana', 'Ben']);
  assert.strictEqual(r.data.project.breadcrumb.className, 'History 9');
  r = await cal.get(`/api/projects/${a.group.projectIds[0]}`);
  assert.strictEqual(r.status, 403, 'other groups’ projects are closed');
  r = await ana.get(`/api/assignments/${a.id}`);
  assert.strictEqual(r.data.myGroup.name, 'Group 1');
  r = await teacher.get(`/api/assignments/${a.id}`);
  assert.deepStrictEqual(r.data.groups.map(g => g.resourceCount), [0, 0]);

  // Renaming a group keeps its project
  const groups = a.group.groups.map(g => ({ ...g, name: g.name === 'Group 1' ? 'Team Rosa' : g.name }));
  r = await teacher.patch(`/api/assignments/${a.id}`, { group: { groups } });
  assert.deepStrictEqual(r.data.assignment.group.projectIds, a.group.projectIds);

  // The extension: linked Docs, then an analysis sent with the student's token
  const X = { 'X-Visor-Token': (await ana.post('/api/ext/token')).data.token };
  r = await ana.get('/api/ext/linked-docs', X);
  assert.deepStrictEqual(r.data.docs.map(d => d.fileId), ['1AbCdEfGhIjKlMnOpQrStUvWxYz']);
  const report = { schema: 'visor-export/1', meta: { fileId: '1AbCdEfGhIjKlMnOpQrStUvWxYz', kind: 'document', title: 'Civil Rights Draft', url: docUrl }, exportedAt: new Date().toISOString(),
    analysis: { contributors: [{ id: 'u1', name: 'Ana Student', inserted: 900, deleted: 50, mutations: 300, typedChars: 850, share: 0.75 }, { id: 'u2', name: 'Ben Student', inserted: 300, deleted: 10, mutations: 90, typedChars: 300, share: 0.25 }], totals: { mutations: 390, finalWords: 210, inserted: 1200, deleted: 60 }, sessions: [], pastes: [], deletions: [] } };
  r = await ana.post('/api/ext/ingest', { report }, X);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.sent[0].project.name, 'Civil rights project – Team Rosa');
  r = await ana.post('/api/ext/ingest', { report: { ...report, meta: { ...report.meta, fileId: 'notlinked' } } }, X);
  assert.strictEqual(r.status, 404);
  r = await teacher.get(`/api/projects/${a.group.projectIds[0]}`);
  assert.strictEqual(r.data.project.resources.length, 1);
  assert.strictEqual(r.data.project.resources[0].report.source, 'visor-extension');

  // The old code-based route still works for anyone with the project code
  const code = r.data.project.code;
  r = await cal.post('/api/extension/ingest', { code, report: { ...report, meta: { ...report.meta, fileId: 'other-doc', title: 'Notes' } } });
  assert.strictEqual(r.status, 200);
  r = await teacher.get(`/api/projects/${a.group.projectIds[0]}`);
  assert.strictEqual(r.data.project.resources.length, 2);
});

test('privacy: research retention, deleting a student’s data, and Download my data', async () => {
  const repo = require('../lib/repo');
  const teacher = client(), stu = client(), other = client();
  await teacher.post('/api/auth/signup', { email: 'pt@school.test', password: 'secret12', firstName: 'Pat', lastName: 'Teacher', role: 'teacher' });
  const cls = (await teacher.post('/api/classes', { name: 'Biology' })).data.class;
  await teacher.patch(`/api/classes/${cls.id}`, { researchRetentionDays: 30 });
  const me = (await stu.post('/api/auth/signup', { email: 'ps@school.test', password: 'secret12', firstName: 'Pia', lastName: 'Student', role: 'student', over13: true, classCode: cls.joinCode })).data.user;
  await other.post('/api/auth/signup', { email: 'po@school.test', password: 'secret12', firstName: 'Olu', lastName: 'Other', role: 'student', over13: true, classCode: cls.joinCode });
  const a = (await teacher.post(`/api/classes/${cls.id}/assignments`, { type: 'writing', title: 'Lab report', writing: { mode: 'open' } })).data.assignment;
  await teacher.post(`/api/assignments/${a.id}/publish`, {});
  const doc = (await stu.get(`/api/write/${a.id}`)).data.doc;
  await other.get(`/api/write/${a.id}`);
  const s = (await stu.post(`/api/write/${doc.id}/sessions`, { surfaceId: 't', surf: 'tab' })).data;
  await stu.post(`/api/write/${doc.id}/ops`, { baseSeq: 0, ops: [{ k: 'i', at: 0, s: 'Mitochondria', t: Date.now(), src: 'type' }], surfaceId: 't' }, { 'X-Visor-Session': s.token });

  // Research records: one fresh, one older than the class's 30 days
  const base = { sessionId: s.session.id, docId: doc.id, studentId: me.id, assignmentId: a.id, classId: cls.id, no: 0 };
  await repo.putRecord('research', { id: `${s.session.id}:0000`, ...base, events: [{ t: Date.now(), type: 'visit', url: 'https://new.example/' }], updatedAt: new Date().toISOString() });
  await repo.putRecord('research', { id: `${s.session.id}:0001`, ...base, no: 1, events: [{ t: Date.now() - 40 * 864e5, type: 'visit', url: 'https://old.example/' }], updatedAt: new Date(Date.now() - 40 * 864e5).toISOString() });
  assert.ok(await app.runRetentionSweep() >= 1);
  const left = await repo.listRecords('research', { docId: doc.id });
  assert.deepStrictEqual(left.map(r => r.events[0].url), ['https://new.example/']);

  // Download my data: the student's own essay, its edit log and research
  let r = await fetch(`${base_()}/api/me/export`, { headers: { Cookie: await cookieOf(stu) } });
  assert.match(r.headers.get('content-disposition'), /attachment; filename="visor-my-data-/);
  const data = await r.json();
  assert.strictEqual(data.account.email, 'ps@school.test');
  assert.strictEqual(data.documents.length, 1);
  assert.strictEqual(data.documents[0].text, 'Mitochondria');
  assert.strictEqual(data.documents[0].editLog.length, 1);
  assert.strictEqual(data.documents[0].research[0].url, 'https://new.example/');
  assert.ok(!JSON.stringify(data).includes('po@school.test'), 'nothing about other students');

  // The teacher deletes this student's work in the class
  r = await teacher.del(`/api/classes/${cls.id}/students/${me.id}/data`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(await repo.getRecord('doc', doc.id), null);
  assert.deepStrictEqual(await repo.listRecords('research', { docId: doc.id }), []);
  assert.deepStrictEqual(await repo.listRecords('session', { docId: doc.id }), []);
  assert.strictEqual((await repo.listRecords('doc', { assignmentId: a.id })).length, 1, 'other students’ work stays');

  // Deleting the class asks for its name, then removes everything in it
  r = await teacher.del(`/api/classes/${cls.id}`, { confirmName: 'nope' });
  assert.strictEqual(r.status, 400);
  r = await teacher.del(`/api/classes/${cls.id}`, { confirmName: 'Biology' });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(await repo.listRecords('assignment', { classId: cls.id }), []);
  assert.deepStrictEqual(await repo.listRecords('doc', { classId: cls.id }), []);
});

test('time limits: extra time is applied, and time-up submits automatically', async () => {
  const repo = require('../lib/repo');
  const teacher = client(), stu = client();
  await teacher.post('/api/auth/signup', { email: 'tt@school.test', password: 'secret12', firstName: 'Tim', lastName: 'Teacher', role: 'teacher' });
  const cls = (await teacher.post('/api/classes', { name: 'Timed' })).data.class;
  const me = (await stu.post('/api/auth/signup', { email: 'ts@school.test', password: 'secret12', firstName: 'Tia', lastName: 'Student', role: 'student', over13: true, classCode: cls.joinCode })).data.user;
  await teacher.patch(`/api/classes/${cls.id}`, { accommodations: { [me.id]: { timeMultiplier: 1.5, note: 'IEP' } } });
  const a = (await teacher.post(`/api/classes/${cls.id}/assignments`, { type: 'writing', title: 'Timed write', writing: { mode: 'open', timeLimitMin: 20, autoSubmitOnTimeUp: true } })).data.assignment;
  await teacher.post(`/api/assignments/${a.id}/publish`, {});
  const doc = (await stu.get(`/api/write/${a.id}`)).data.doc;
  let r = await stu.post(`/api/write/${doc.id}/sessions`, { surfaceId: 't', surf: 'tab' });
  const left = Date.parse(r.data.session.deadlineAt) - Date.parse(r.data.serverNow);
  assert.ok(Math.abs(left - 30 * 60e3) < 5000, `20 min × 1.5 = 30 min (got ${Math.round(left / 1000)} s)`);
  const H = { 'X-Visor-Session': r.data.token };
  // The teacher adds 5 minutes from the live board
  await teacher.post(`/api/assignments/${a.id}/live/action`, { action: 'add-time', studentIds: [me.id], minutes: 5 });
  r = await stu.post(`/api/write/${doc.id}/beat`, { surfaceId: 't', surf: 'tab', focused: true, visible: true }, H);
  assert.ok(Math.abs(Date.parse(r.data.deadlineAt) - Date.parse(r.data.serverNow) - 35 * 60e3) < 5000);
  // Time runs out (the deadline is moved into the past rather than waiting 35 minutes)
  await repo.updateRecord('session', r.data.id, s => { s.deadlineAt = new Date(Date.now() - 1000).toISOString(); });
  r = await stu.post(`/api/write/${doc.id}/ops`, { baseSeq: 0, ops: [{ k: 'i', at: 0, s: 'late', t: Date.now(), src: 'type' }], surfaceId: 't' }, H);
  assert.strictEqual(r.status, 409, 'no writing after the deadline');
  assert.strictEqual(r.data.session.endReason, 'time-limit');
  r = await stu.get(`/api/write/${a.id}`);
  assert.strictEqual(r.data.doc.status, 'submitted');
  assert.strictEqual(r.data.doc.autoSubmitted, true);
  r = await stu.post(`/api/write/${doc.id}/sessions`, { surfaceId: 't2', surf: 'tab' });
  assert.strictEqual(r.status, 409, 'no new session once submitted');
});

test('a paste made before its copy reached the server is matched on review; the panel uses the extension’s account', async () => {
  const teacher = client(), stu = client();
  await teacher.post('/api/auth/signup', { email: 'mt@school.test', password: 'secret12', firstName: 'Max', lastName: 'Teacher', role: 'teacher' });
  const cls = (await teacher.post('/api/classes', { name: 'Late copies' })).data.class;
  await stu.post('/api/auth/signup', { email: 'ms@school.test', password: 'secret12', firstName: 'Mo', lastName: 'Student', role: 'student', over13: true, classCode: cls.joinCode });
  const a = (await teacher.post(`/api/classes/${cls.id}/assignments`, { type: 'writing', title: 'Copies', writing: { mode: 'open' } })).data.assignment;
  await teacher.post(`/api/assignments/${a.id}/publish`, {});
  const X = { 'X-Visor-Token': (await stu.post('/api/ext/token')).data.token };

  // The side panel: the teacher's cookie in this browser, the student's extension token
  let r = await teacher.get(`/api/write/${a.id}?surf=panel`, X);
  assert.strictEqual(r.status, 200, 'the extension token decides whose editor this is');
  assert.strictEqual(r.data.user.name, 'Mo Student');
  const doc = r.data.doc;

  const s = (await stu.post(`/api/write/${doc.id}/sessions`, { surfaceId: 't', surf: 'tab' })).data;
  const H = { 'X-Visor-Session': s.token };
  const copied = 'Adolescents need eight to ten hours of sleep each night.';
  // The paste arrives first…
  r = await stu.post(`/api/write/${doc.id}/ops`, { baseSeq: 0, ops: [{ k: 'i', at: 0, s: copied, t: Date.now(), src: 'paste', paste: { hash: sha(norm(copied)), internal: false } }], surfaceId: 't' }, H);
  assert.strictEqual(r.data.pastes[0].origin, null);
  // …then the copy (the extension sends research in batches)
  await stu.post('/api/ext/research', { sessionToken: s.token, docId: doc.id, events: [{ type: 'copy', t: Date.now() - 5000, url: 'https://www.sleepfoundation.org/teens', title: 'Teens and Sleep', copy: { hash: sha(norm(copied)), len: copied.length, preview: copied } }] }, X);
  r = await teacher.get(`/api/review/${doc.id}`);
  assert.strictEqual(r.data.report.pastes[0].kind, 'research');
  assert.strictEqual(r.data.report.pastes[0].origin.url, 'https://www.sleepfoundation.org/teens');
  // New research makes a new report (it isn't cached by op count alone)
  await stu.post('/api/ext/research', { sessionToken: s.token, docId: doc.id, events: [{ type: 'search', t: Date.now(), url: 'https://www.google.com/search?q=teen+sleep', query: 'teen sleep', engine: 'google' }] }, X);
  r = await teacher.get(`/api/review/${doc.id}`);
  assert.ok(r.data.report.research.searches.some(x => x.query === 'teen sleep'));
});
