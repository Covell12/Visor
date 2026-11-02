// Profile pictures: choosing one, who can load it, and what replaces or removes
// it. Runs on a local PGlite store in a temp folder; nothing here reaches
// Firebase, Google or Gemini (their settings are blanked and pointed at a closed
// local port).
'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-avatar-'));
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

// The smallest real PNG (1×1)
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
    return { status: r.status, data, buf, headers: r.headers };
  };
  return {
    get: u => call('GET', u), post: (u, b) => call('POST', u, b || {}), patch: (u, b) => call('PATCH', u, b), del: u => call('DELETE', u),
    upload: (u, buf, type = 'image/png') => call('POST', u, buf, { 'Content-Type': type })
  };
}

let people = 0;
async function signup(c, role, firstName, extra = {}) {
  const email = `${firstName.toLowerCase()}${++people}@avatar.test`;
  const r = await c.post('/api/auth/signup', { email, password: 'secret12', firstName, lastName: 'Tester', role, ...(role === 'student' ? { over13: true } : {}), ...extra });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return r.data.user;
}
// Everything stored under the images folder, as names
const storedFiles = () => (fs.existsSync(path.join(DATA, 'images')) ? fs.readdirSync(path.join(DATA, 'images'), { recursive: true }).filter(f => /\.\w+$/.test(f)) : []);

async function classOfTwo() {
  const t = client(), s = client();
  await signup(t, 'teacher', 'Tess');
  const cls = (await t.post('/api/classes', { name: 'Icons' })).data.class;
  const S = await signup(s, 'student', 'Sam', { classCode: cls.joinCode });
  return { t, s, cls, S };
}

test('a picture shows for people who see your name, and needs a sign-in to load', async () => {
  const { t, s, cls, S } = await classOfTwo();
  assert.strictEqual(S.avatarUrl, undefined, 'none until someone chooses one');
  const r = await s.upload('/api/me/avatar', PNG);
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  const url = r.data.user.avatarUrl;
  assert.match(url, new RegExp(`^/api/users/${S.id}/avatar\\?v=[a-f0-9]{32}$`));
  assert.strictEqual(JSON.stringify(r.data).includes('stored'), false, 'where it’s stored stays on the server');
  const roster = (await t.get(`/api/classes/${cls.id}`)).data.class.students.find(x => x.id === S.id);
  assert.strictEqual(roster.avatarUrl, url);
  const got = await t.get(url);
  assert.deepStrictEqual([got.status, got.headers.get('content-type'), got.headers.get('x-content-type-options'), got.buf.equals(PNG)], [200, 'image/png', 'nosniff', true]);
  assert.strictEqual((await client().get(url)).status, 401, 'signed out');
  assert.strictEqual((await t.get(`/api/users/${S.id}/avatar?v=${'0'.repeat(32)}`)).status, 404, 'its address has to be the real one');
  assert.strictEqual((await t.get(`/api/users/${S.id}/avatar`)).status, 404);
});

test('a replaced or removed picture is gone', async () => {
  const c = client();
  await signup(c, 'teacher', 'Rae');
  const before = storedFiles().length;
  const first = (await c.upload('/api/me/avatar', PNG)).data.user.avatarUrl;
  assert.strictEqual(storedFiles().length, before + 1);
  const second = (await c.upload('/api/me/avatar', PNG)).data.user.avatarUrl;
  assert.notStrictEqual(second, first);
  assert.strictEqual(storedFiles().length, before + 1, 'the first file is deleted');
  assert.strictEqual((await c.get(first)).status, 404);
  assert.strictEqual((await c.get(second)).status, 200);
  const r = await c.del('/api/me/avatar');
  assert.deepStrictEqual([r.status, r.data.user.avatarUrl], [200, undefined]);
  assert.strictEqual(storedFiles().length, before);
  assert.strictEqual((await c.get(second)).status, 404);
  assert.strictEqual((await c.get('/api/me')).data.user.avatarUrl, undefined);
  assert.strictEqual((await c.del('/api/me/avatar')).status, 200, 'removing nothing is fine');
});

test('only a picture, of a sensible size, from someone signed in', async () => {
  const c = client();
  await signup(c, 'student', 'Ivy');
  assert.strictEqual((await c.upload('/api/me/avatar', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'image/png')).status, 400);
  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(16)]);
  assert.strictEqual((await c.upload('/api/me/avatar', gif, 'image/gif')).status, 400);
  assert.strictEqual((await c.upload('/api/me/avatar', Buffer.concat([PNG, Buffer.alloc(600 * 1024)]))).status, 413);
  assert.strictEqual((await client().upload('/api/me/avatar', PNG)).status, 401);
  assert.strictEqual((await c.get('/api/me')).data.user.avatarUrl, undefined);
});

test('your color stays yours when you add or remove a picture', async () => {
  const c = client();
  await signup(c, 'student', 'Kai');
  await c.patch('/api/me', { avatarColor: '#2e8549' });
  await c.upload('/api/me/avatar', PNG);
  assert.strictEqual((await c.get('/api/me')).data.user.avatarColor, '#2e8549');
  await c.del('/api/me/avatar');
  assert.strictEqual((await c.get('/api/me')).data.user.avatarColor, '#2e8549');
  assert.strictEqual((await c.patch('/api/me', { avatarColor: '' })).data.user.avatarColor, null);
});
