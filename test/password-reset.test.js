// Forgot password: the emailed link, what it refuses, and what setting a new
// password ends. Runs on a local PGlite store in a temp folder, with mail kept in
// memory. Nothing here reaches Firebase, Google, Gemini or a mail server.
'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-reset-'));
Object.assign(process.env, {
  VISOR_PLATFORM: '', DATABASE_URL: '',
  PGLITE_DIR: path.join(DATA, 'pglite'), VISOR_IMAGE_DIR: path.join(DATA, 'images'), VISOR_AUDIO_DIR: path.join(DATA, 'audio'),
  VISOR_DEV_LOGIN: '1', SESSION_SECRET: 'test-secret', NODE_ENV: 'test', MAIL_TRANSPORT: 'memory', MAIL_PASSWORD: '',
  GEMINI_API_KEY: '', GEMINI_VIA: 'apikey', GEMINI_BASE_URL: 'http://127.0.0.1:9', VERTEX_BASE_URL: 'http://127.0.0.1:9', DRIVE_API_BASE: 'http://127.0.0.1:9',
  GOOGLE_CLIENT_ID: '', GOOGLE_API_KEY: '', GOOGLE_APP_ID: '', CLASSROOM_IMPORT: '', PUBLIC_URL: 'https://visor.test'
});
const crypto = require('crypto');
const test = require('node:test');
const assert = require('node:assert');
const app = require('../server');
const repo = require('../lib/repo');
const mail = require('../lib/mail');
const throttle = require('../lib/throttle');

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
  return { get: u => call('GET', u), post: (u, b) => call('POST', u, b || {}), del: u => call('DELETE', u) };
}
let n = 0;
async function account(role = 'teacher') {
  const c = client(), email = `person${++n}@reset.test`;
  const r = await c.post('/api/auth/signup', { email, password: 'old-password', firstName: 'Pat', lastName: `Test${n}`, role, over13: true });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return { c, email, id: r.data.user.id };
}
const lastTo = email => mail.sent.filter(m => m.to === email).pop();
const tokenOf = m => /token=([\w-]+)/.exec(m.text)[1];
const forgot = email => client().post('/api/auth/forgot', { email });

test('the whole way through: email, new password, signed in', async () => {
  const { email } = await account();
  assert.strictEqual((await forgot(email)).status, 200);
  const m = lastTo(email);
  assert.strictEqual(m.subject, 'Reset your Visor password');
  assert.match(m.text, /https:\/\/visor\.test\/reset\?token=/, 'the link uses the site’s own address, never the request’s Host');
  assert.strictEqual((m.html.match(/logo\.png/g) || []).length, 1);
  const token = tokenOf(m);
  const c = client();
  assert.deepStrictEqual((await c.post('/api/auth/reset/check', { token })).data, { valid: true });
  const r = await c.post('/api/auth/reset', { token, password: 'new-password' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.user.email, email);
  assert.strictEqual((await c.get('/api/me')).data.signedIn, true, 'signed in by the reset');
  assert.strictEqual((await client().post('/api/auth/login', { email, password: 'new-password' })).status, 200);
  assert.strictEqual((await client().post('/api/auth/login', { email, password: 'old-password' })).status, 401);
});

test('a link works once, and stops at the hour', async () => {
  const { email, id } = await account();
  await forgot(email);
  const token = tokenOf(lastTo(email));
  await client().post('/api/auth/reset', { token, password: 'first-password' });
  let r = await client().post('/api/auth/reset', { token, password: 'second-password' });
  assert.deepStrictEqual([r.status, r.data.error], [400, 'This link has expired or was already used. Ask for a new one.']);
  assert.strictEqual((await client().post('/api/auth/login', { email, password: 'first-password' })).status, 200);

  await forgot(email);
  const late = tokenOf(lastTo(email));
  const rec = (await repo.listRecords('pwreset', { studentId: id }))[0];
  await repo.updateRecord('pwreset', rec.id, x => { x.expiresAt = new Date(Date.now() - 1000).toISOString(); });
  assert.deepStrictEqual((await client().post('/api/auth/reset/check', { token: late })).data, { valid: false });
  assert.strictEqual((await client().post('/api/auth/reset', { token: late, password: 'third-password' })).status, 400);
});

test('only a hash of the token is stored, and made-up tokens get nowhere', async () => {
  const { email, id } = await account();
  await forgot(email);
  const token = tokenOf(lastTo(email));
  const [rec] = await repo.listRecords('pwreset', { studentId: id });
  assert.strictEqual(rec.id, crypto.createHash('sha256').update(token).digest('hex'));
  assert.ok(!JSON.stringify(rec).includes(token));
  for (const bad of ['', 'nope', 'x'.repeat(43), rec.id, null, { $gt: '' }]) {
    assert.strictEqual((await client().post('/api/auth/reset', { token: bad, password: 'whatever-1' })).status, 400, JSON.stringify(bad));
  }
  // too short a password doesn't use up the link
  assert.strictEqual((await client().post('/api/auth/reset', { token, password: '123' })).status, 400);
  assert.deepStrictEqual((await client().post('/api/auth/reset/check', { token })).data, { valid: true });
});

test('a reset ends every other sign-in and disconnects the extension', async () => {
  const { c: stolen, email, id } = await account();
  assert.strictEqual((await stolen.get('/api/classes')).status, 200);
  assert.strictEqual((await stolen.post('/api/ext/token')).status, 200);
  assert.strictEqual((await repo.listRecords('exttoken', { studentId: id })).length, 1);
  await forgot(email);
  await client().post('/api/auth/reset', { token: tokenOf(lastTo(email)), password: 'new-password' });
  assert.strictEqual((await stolen.get('/api/me')).data.signedIn, false);
  assert.strictEqual((await stolen.get('/api/classes')).status, 401);
  assert.deepStrictEqual(await repo.listRecords('exttoken', { studentId: id }), []);
  const again = client();
  await again.post('/api/auth/login', { email, password: 'new-password' });
  assert.strictEqual((await again.get('/api/classes')).status, 200, 'a new sign-in works');
});

test('the answer never says whether an account exists', async () => {
  const { email } = await account();
  const known = await forgot(email), unknown = await forgot('nobody@reset.test');
  assert.deepStrictEqual([known.status, known.data], [unknown.status, unknown.data]);
  assert.strictEqual(lastTo('nobody@reset.test'), undefined);
  assert.strictEqual((await forgot('not an email')).status, 400);
});

test('an account gets three emails an hour at most', async () => {
  const { email } = await account();
  const before = mail.sent.filter(m => m.to === email).length;
  for (let i = 0; i < 5; i++) assert.strictEqual((await forgot(email)).status, 200);
  assert.strictEqual(mail.sent.filter(m => m.to === email).length - before, 3);
});

test('a Google account is told to use Google, and can’t be given a password', async () => {
  const { email, id } = await account();
  await repo.withCore(core => { const u = core.users[id]; delete u.passwordHash; delete u.passwordSalt; u.googleSub = 'g1'; });
  await forgot(email);
  const m = lastTo(email);
  assert.strictEqual(m.subject, 'Signing in to Visor');
  assert.doesNotMatch(m.text, /token=/);
  const [rec] = await repo.listRecords('pwreset', { studentId: id });
  assert.strictEqual(rec.usable, false);
});

test('repeated wrong passwords are slowed down, for that address only', async () => {
  const { email } = await account();
  for (let i = 0; i < 10; i++) assert.strictEqual((await client().post('/api/auth/login', { email, password: 'wrong-guess' })).status, 401);
  let r = await client().post('/api/auth/login', { email, password: 'old-password' });
  assert.strictEqual(r.status, 429, 'even the right one, until the wait is over');
  assert.match(r.data.error, /reset your password/);
  const other = await account();
  assert.strictEqual((await client().post('/api/auth/login', { email: other.email, password: 'old-password' })).status, 200);
});

test('throttle: counts inside its window and forgets after it', () => {
  const key = 'k', t = 1000;
  assert.ok(throttle.allow(key, 2, 100, t) && throttle.allow(key, 2, 100, t + 1));
  assert.ok(!throttle.allow(key, 2, 100, t + 2));
  assert.ok(throttle.allow(key, 2, 100, t + 150));
  throttle.clear(key);
});

test('without an email account the page is told so, and nothing is stored', async () => {
  const { email, id } = await account();
  process.env.MAIL_TRANSPORT = '';
  const cfg = (await client().get('/api/config')).data;
  const r = await forgot(email);
  process.env.MAIL_TRANSPORT = 'memory';
  assert.strictEqual(cfg.passwordReset, false);
  assert.strictEqual(r.status, 503);
  assert.match(r.data.error, /visor\.edu\.ai@gmail\.com/);
  assert.deepStrictEqual(await repo.listRecords('pwreset', { studentId: id }), []);
});
