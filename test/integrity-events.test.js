// Two things the session records so they're hard to get around: another
// extension's writing tool on the essay page (the editor sends an
// 'assistant-ext' event) and a locked session's side panel closed while the
// student wrote in it (the extension sends a 'panel-closed' research event).
// Both reach the live board's "needs attention" and the notes for the teacher,
// as plain facts. On a local PGlite store; nothing reaches Firebase or Google.
'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-integrity-'));
Object.assign(process.env, {
  VISOR_PLATFORM: '', DATABASE_URL: '',
  PGLITE_DIR: path.join(DATA, 'pglite'), VISOR_IMAGE_DIR: path.join(DATA, 'images'), VISOR_AUDIO_DIR: path.join(DATA, 'audio'),
  VISOR_DEV_LOGIN: '1', VISOR_SCHOOL_OPTIONAL: '1', SESSION_SECRET: 'test-secret', NODE_ENV: 'test',
  GEMINI_API_KEY: '', GEMINI_VIA: 'apikey', GEMINI_BASE_URL: 'http://127.0.0.1:9', VERTEX_BASE_URL: 'http://127.0.0.1:9', DRIVE_API_BASE: 'http://127.0.0.1:9',
  GOOGLE_CLIENT_ID: '', GOOGLE_API_KEY: '', GOOGLE_APP_ID: '', CLASSROOM_IMPORT: ''
});
const test = require('node:test');
const assert = require('node:assert');
const app = require('../server');
const research = require('../lib/research');
const sessions = require('../lib/sessions');

let server, base;
test.before(async () => { await new Promise(r => { server = app.listen(0, '127.0.0.1', r); }); base = `http://127.0.0.1:${server.address().port}`; });
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
  return { get: (u, h) => call('GET', u, null, h), post: (u, b, h) => call('POST', u, b || {}, h) };
}

test('the new event types are accepted where they come from, and nowhere else', () => {
  assert.ok(research.TYPES.includes('panel-closed'));
  assert.ok(sessions.CLIENT_EVENTS.includes('assistant-ext'));
  assert.deepStrictEqual(research.cleanEvent({ type: 'panel-closed', t: Date.now() }).type, 'panel-closed');
  assert.strictEqual(research.cleanEvent({ type: 'assistant-ext' }), null, 'writing tools come from the editor, not the extension');
});

test('writing tools and a closed side panel reach the board and the notes', async () => {
  const teacher = client(), sam = client();
  await teacher.post('/api/auth/signup', { email: 't@int.test', password: 'secret12', firstName: 'Tess', lastName: 'Teacher', role: 'teacher' });
  const cls = (await teacher.post('/api/classes', { name: 'English 10' })).data.class;
  await sam.post('/api/auth/signup', { email: 's@int.test', password: 'secret12', firstName: 'Sam', lastName: 'Student', role: 'student', classCode: cls.joinCode, over13: true });
  const a = (await teacher.post(`/api/classes/${cls.id}/assignments`, { type: 'writing', title: 'Essay', writing: { mode: 'open' } })).data.assignment;
  await teacher.post(`/api/assignments/${a.id}/publish`, { published: true });
  const doc = (await sam.get(`/api/write/${a.id}`)).data.doc;
  let r = await sam.post(`/api/write/${doc.id}/sessions`, { surfaceId: 'tab-1', surf: 'tab', extPresent: true, fullscreen: false });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  const H = { 'X-Visor-Session': r.data.token };

  // the editor saw Grammarly on the page (once per session per tool)
  r = await sam.post(`/api/write/${doc.id}/beat`, { surfaceId: 'tab-1', surf: 'tab', visible: true, focused: true, fullscreen: false, events: [{ type: 'assistant-ext', t: Date.now(), detail: 'Grammarly' }, { type: 'assistant-ext', t: Date.now(), detail: 'LanguageTool' }] }, H);
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  // the extension says the side panel was closed
  const X = { 'X-Visor-Token': (await sam.post('/api/ext/token')).data.token };
  r = await sam.post('/api/ext/research', { sessionToken: H['X-Visor-Session'], docId: doc.id, events: [{ type: 'panel-closed', t: Date.now() }] }, X);
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));

  r = await teacher.get(`/api/assignments/${a.id}/live`);
  const row = r.data.rows.find(x => x.student.name === 'Sam Student');
  assert.deepStrictEqual(row.tools, ['Grammarly', 'LanguageTool']);
  assert.strictEqual(row.panelClosed, 1);
  assert.ok(row.attention.includes('writing tool on the page: Grammarly, LanguageTool'), JSON.stringify(row.attention));
  assert.ok(row.attention.includes('closed the side panel'));

  r = await teacher.get(`/api/review/${doc.id}`);
  const notes = r.data.report.notes.map(n => [n.rule, n.text]);
  assert.ok(notes.some(([rule, text]) => rule === 'writing-tool' && text === 'Another extension’s writing tool was on the essay page during session 1: Grammarly, LanguageTool.'), JSON.stringify(notes));
  assert.ok(notes.some(([rule, text]) => rule === 'panel-closed' && text === 'Closed the side panel while writing in it during session 1; the session went back to its allowed sites.'), JSON.stringify(notes));
  // facts only: nothing calls the writing AI-generated
  assert.ok(!JSON.stringify(notes).match(/AI-generated|probability/i));
});

test('a panel closed after the session ended is not recorded; AI modes go by their name', async () => {
  const teacher = client(), kim = client();
  await teacher.post('/api/auth/signup', { email: 't2@int.test', password: 'secret12', firstName: 'Tess', lastName: 'Two', role: 'teacher' });
  const cls = (await teacher.post('/api/classes', { name: 'English 11' })).data.class;
  await kim.post('/api/auth/signup', { email: 'k@int.test', password: 'secret12', firstName: 'Kim', lastName: 'Lee', role: 'student', classCode: cls.joinCode, over13: true });
  const a = (await teacher.post(`/api/classes/${cls.id}/assignments`, { type: 'writing', title: 'Essay', writing: { mode: 'open' } })).data.assignment;
  await teacher.post(`/api/assignments/${a.id}/publish`, { published: true });
  const doc = (await kim.get(`/api/write/${a.id}`)).data.doc;
  const H = { 'X-Visor-Session': (await kim.post(`/api/write/${doc.id}/sessions`, { surfaceId: 'tab-1', surf: 'tab', extPresent: true, fullscreen: false })).data.token };
  const X = { 'X-Visor-Token': (await kim.post('/api/ext/token')).data.token };
  // an AI mode visit, by name
  let r = await kim.post('/api/ext/research', { sessionToken: H['X-Visor-Session'], docId: doc.id, events: [{ type: 'ai-site', t: Date.now(), url: 'https://www.google.com/search?q=x&udm=50', host: 'www.google.com', site: 'Google AI Mode', blocked: true }, { type: 'ai-site', t: Date.now(), url: 'https://duckduckgo.com/?q=x&ia=chat', host: 'duckduckgo.com', site: 'Duck.ai', blocked: true }] }, X);
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  // the session ends, then a late 'panel-closed' arrives stamped after it
  r = await kim.post(`/api/write/${doc.id}/end`, {}, H);
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  r = await kim.post('/api/ext/research', { sessionToken: H['X-Visor-Session'], docId: doc.id, events: [{ type: 'panel-closed', t: Date.now() + 1000 }] }, X);
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  r = await teacher.get(`/api/review/${doc.id}`);
  const notes = r.data.report.notes.map(n => n.text);
  assert.ok(notes.includes('Visited Google AI Mode during session 1 (blocked).'), JSON.stringify(notes));
  assert.ok(notes.includes('Visited Duck.ai during session 1 (blocked).'), JSON.stringify(notes));
  assert.ok(!notes.some(t => /side panel/.test(t)), 'no closed-panel note after the session ended');
  assert.ok(!r.data.report.research.events.some(e => e.type === 'panel-closed'), 'nor a Research-tab line');
});
