// The Works Cited setting (writing.worksCited: 'page', 'panel' or 'off'):
// its default and checks (lib/assignments.js), the sentence students read
// (public/assignment-text.js = lib/assignment-text.js), the student's view,
// and the sources route refusing new sources while it's off. Runs on a local
// PGlite store in a temp folder; nothing here reaches Firebase, Google or
// Gemini (their settings are blanked and pointed at a closed local port).
'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-wc-'));
Object.assign(process.env, {
  VISOR_PLATFORM: '', DATABASE_URL: '',
  PGLITE_DIR: path.join(DATA, 'pglite'), VISOR_IMAGE_DIR: path.join(DATA, 'images'), VISOR_AUDIO_DIR: path.join(DATA, 'audio'),
  VISOR_DEV_LOGIN: '1', VISOR_SCHOOL_OPTIONAL: '1', SESSION_SECRET: 'test-secret', NODE_ENV: 'test',
  GEMINI_API_KEY: '', GEMINI_VIA: 'apikey', GEMINI_BASE_URL: 'http://127.0.0.1:9', VERTEX_BASE_URL: 'http://127.0.0.1:9', DRIVE_API_BASE: 'http://127.0.0.1:9',
  GOOGLE_CLIENT_ID: '', GOOGLE_API_KEY: '', GOOGLE_APP_ID: '', CLASSROOM_IMPORT: ''
});

const test = require('node:test');
const assert = require('node:assert');
const A = require('../lib/assignments');
const shared = require('../public/assignment-text.js');
const app = require('../server');
const repo = require('../lib/repo');

let server, base;
test.before(async () => {
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); fs.rmSync(DATA, { recursive: true, force: true }); });

// A signed-in person: keeps the __session cookie between calls
function client() {
  let cookie = '';
  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    let data = null;
    try { data = await r.json(); } catch {}
    return { status: r.status, data };
  };
  return { get: u => call('GET', u, null), post: (u, b) => call('POST', u, b || {}), patch: (u, b) => call('PATCH', u, b), del: u => call('DELETE', u, null) };
}
let people = 0;
async function signup(c, role, firstName, extra = {}) {
  const r = await c.post('/api/auth/signup', { email: `${firstName.toLowerCase()}${++people}@wc.test`, password: 'secret12', firstName, lastName: role === 'teacher' ? 'Teacher' : 'Student', role, ...(role === 'student' ? { over13: true } : {}), ...extra });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return r.data.user;
}

/* ---------------- the setting ---------------- */

test('worksCited: a page by default, in both presets, and on a new assignment', () => {
  assert.strictEqual(A.defaultWriting().worksCited, 'page');
  assert.strictEqual(A.defaultWriting('locked').worksCited, 'page');
  assert.strictEqual(A.PRESETS['in-class'].writing.worksCited, 'page');
  assert.strictEqual(A.PRESETS.homework.writing.worksCited, 'page');
  const a = A.createAssignment({ id: 'c1', studentIds: [] }, { type: 'writing', title: 'Essay' });
  assert.strictEqual(a.writing.worksCited, 'page');
});

test('worksCited: page, panel and off are accepted; anything else is a 400', () => {
  for (const v of ['page', 'panel', 'off']) assert.strictEqual(A.cleanWriting({ worksCited: v }).worksCited, v);
  for (const v of ['pdf', '', null, 'Page', 1]) {
    assert.throws(() => A.cleanWriting({ worksCited: v }), e => e.status === 400 && e.message === 'Works Cited must be a page, a side panel or off', String(v));
  }
  // Other edits leave it alone, and an older assignment without it keeps not having it (read as a page)
  assert.strictEqual(A.cleanWriting({ minWords: 300 }, { ...A.defaultWriting(), worksCited: 'off' }).worksCited, 'off');
  const older = A.defaultWriting(); delete older.worksCited;
  assert.strictEqual(A.cleanWriting({ minWords: 300 }, older).worksCited, undefined);
});

test('worksCited: the student view carries it', () => {
  const a = A.createAssignment({ id: 'c1', studentIds: [] }, { type: 'writing', title: 'Essay', writing: { worksCited: 'panel' } });
  assert.strictEqual(A.studentView(a).writing.worksCited, 'panel');
});

/* ---------------- describeWriting ---------------- */

test('describeWriting: lib/assignments re-exports the shared module, which is the same file as lib/assignment-text.js', () => {
  assert.strictEqual(A.describeWriting, require('../lib/assignment-text').describeWriting);
  const root = path.join(__dirname, '..');
  assert.ok(fs.readFileSync(path.join(root, 'lib', 'assignment-text.js')).equals(fs.readFileSync(path.join(root, 'public', 'assignment-text.js'))), 'run `npm run sync-engine`');
  const w = { ...A.defaultWriting('locked'), worksCited: 'panel', allowedSites: ['a.org'], minWords: 300 };
  assert.strictEqual(shared.describeWriting(w, 1.5), A.describeWriting(w, 1.5));
});

test('describeWriting: each Works Cited setting in words', () => {
  const w = { ...A.defaultWriting(), citationStyle: 'apa' };
  const page = A.describeWriting({ ...w, worksCited: 'page' });
  assert.strictEqual(page, 'Open session · no time limit · research is recorded · pasting is allowed · AI sites are blocked · cite in APA');
  // older assignments without the setting read as a page
  const older = { ...w }; delete older.worksCited;
  assert.strictEqual(A.describeWriting(older), page);
  assert.strictEqual(A.describeWriting({ ...w, worksCited: 'panel' }), `${page} · your sources go in a side panel (no Works Cited page)`);
  assert.strictEqual(A.describeWriting({ ...w, worksCited: 'off' }), `${page} · write your own Works Cited (citation tools are off)`);

  // "one-click citing is off" only while there are citation tools at all
  assert.match(A.describeWriting({ ...w, worksCited: 'page', oneClickCite: false }), /cite in APA · one-click citing is off$/);
  assert.match(A.describeWriting({ ...w, worksCited: 'panel', oneClickCite: false }), /\(no Works Cited page\) · one-click citing is off$/);
  const off = A.describeWriting({ ...w, worksCited: 'off', oneClickCite: false });
  assert.ok(!off.includes('one-click'), off);
  assert.ok(off.endsWith('write your own Works Cited (citation tools are off)'), off);
});

test('describeWriting: numbers typed into the form (strings, blanks, nonsense) read sensibly', () => {
  const w = A.defaultWriting();
  assert.match(A.describeWriting({ ...w, timeLimitMin: '45', minWords: '300', maxWords: '' }), /Open session · 45 minutes · .* · at least 300 words$/);
  const odd = A.describeWriting({ ...w, timeLimitMin: 'abc', minWords: '-5', maxWords: 'x' });
  assert.ok(odd.includes('no time limit') && !/NaN|words/.test(odd), odd);
  assert.strictEqual(A.describeWriting(null), '');
});

/* ---------------- the sources route ---------------- */

test('sources: refused while Works Cited is off; editing and deleting what the essay has still work', async () => {
  const teacher = client(), stu = client();
  await signup(teacher, 'teacher', 'Tess');
  const cls = (await teacher.post('/api/classes', { name: 'English 10' })).data.class;
  await signup(stu, 'student', 'Sam', { classCode: cls.joinCode });

  // Not a value the setting has: 400, nothing made
  let r = await teacher.post(`/api/classes/${cls.id}/assignments`, { type: 'writing', title: 'Bad', writing: { worksCited: 'appendix' } });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.data.error, 'Works Cited must be a page, a side panel or off');

  r = await teacher.post(`/api/classes/${cls.id}/assignments`, { type: 'writing', title: 'Sleep essay', writing: { mode: 'open' } });
  assert.strictEqual(r.status, 200);
  const a = r.data.assignment;
  assert.strictEqual(a.writing.worksCited, 'page');
  await teacher.post(`/api/assignments/${a.id}/publish`, { published: true });

  // A page (the default): the student cites, by hand and from the extension
  r = await stu.get(`/api/write/${a.id}`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.assignment.writing.worksCited, 'page');
  const doc = r.data.doc;
  await stu.post(`/api/write/${doc.id}/sessions`, { surfaceId: 'cite-tab', surf: 'tab' });
  r = await stu.post(`/api/write/${doc.id}/sources`, { source: { title: 'Why Teens Need Sleep', url: 'https://example.org/sleep', authors: ['Maria Lopez'] } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  const kept = r.data.source;
  r = await stu.post(`/api/write/${doc.id}/sources`, { via: 'extension', source: { title: 'Start Times', url: 'https://example.org/start' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.sources.length, 2);
  const second = r.data.source;

  // The side panel: still citing
  r = await teacher.patch(`/api/assignments/${a.id}`, { writing: { worksCited: 'panel' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.assignment.writing.worksCited, 'panel');
  r = await stu.post(`/api/write/${doc.id}/sources`, { source: { title: 'A Third Source', url: 'https://example.org/third' } });
  assert.strictEqual(r.status, 200);
  const third = r.data.source;

  // Off: no new sources, by hand or in one click
  r = await teacher.patch(`/api/assignments/${a.id}`, { writing: { worksCited: 'off', oneClickCite: false } });
  assert.strictEqual(r.data.assignment.writing.worksCited, 'off');
  for (const body of [{ source: { title: 'Another', url: 'https://example.org/another' } }, { via: 'extension', source: { title: 'Cited in one click', url: 'https://example.org/one-click' } }]) {
    r = await stu.post(`/api/write/${doc.id}/sources`, body);
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.data.error, 'Citations are turned off for this assignment.');
  }
  // the same page again is refused too (it would have been "existing")
  r = await stu.post(`/api/write/${doc.id}/sources`, { source: { title: 'Why Teens Need Sleep', url: 'https://example.org/sleep' } });
  assert.strictEqual(r.status, 403);

  // What the student and the teacher see carries the setting, and says so
  r = await stu.get(`/api/write/${a.id}`);
  assert.strictEqual(r.data.assignment.writing.worksCited, 'off');
  assert.strictEqual((await repo.getRecord('doc', doc.id)).sources.length, 3, 'sources from before stay');
  assert.match(r.data.describe, /write your own Works Cited \(citation tools are off\)$/);
  r = await stu.get(`/api/assignments/${a.id}`);
  assert.strictEqual(r.data.assignment.writing.worksCited, 'off');
  assert.ok(!r.data.describe.includes('one-click'), r.data.describe);
  r = await teacher.get(`/api/assignments/${a.id}`);
  assert.strictEqual(r.data.assignment.writing.worksCited, 'off');

  // Editing and deleting the sources the essay already has still work
  r = await stu.patch(`/api/write/${doc.id}/sources/${kept.id}`, { source: { title: 'Why Teenagers Need Sleep', authors: ['Maria Lopez'], published: '2023-09-05' } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.source.title, 'Why Teenagers Need Sleep');
  r = await stu.del(`/api/write/${doc.id}/sources/${second.id}`);
  assert.strictEqual(r.status, 200);
  r = await stu.del(`/api/write/${doc.id}/sources/${third.id}`);
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.data.sources.map(s => s.id), [kept.id]);

  // Back to a page: citing works again
  await teacher.patch(`/api/assignments/${a.id}`, { writing: { worksCited: 'page', oneClickCite: true } });
  r = await stu.post(`/api/write/${doc.id}/sources`, { via: 'extension', source: { title: 'Back Again', url: 'https://example.org/back' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.sources.length, 2);
});
