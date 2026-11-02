// A class's banner background: one of Visor's designs, or a picture a teacher
// uploads (PNG, JPEG or WebP, checked by its bytes), with a position. Only the
// class's teachers change it; only its teachers and students can load the
// picture; a replaced or removed picture, and a deleted class's picture, are
// deleted from storage. Runs on a local PGlite store and a temp image folder;
// nothing here reaches Firebase, Google or Gemini.
'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-classbg-'));
const IMAGES = path.join(DATA, 'images');
Object.assign(process.env, {
  VISOR_PLATFORM: '', DATABASE_URL: '',
  PGLITE_DIR: path.join(DATA, 'pglite'), VISOR_IMAGE_DIR: IMAGES, VISOR_AUDIO_DIR: path.join(DATA, 'audio'),
  VISOR_DEV_LOGIN: '1', VISOR_SCHOOL_OPTIONAL: '1', SESSION_SECRET: 'test-secret', NODE_ENV: 'test',
  GEMINI_API_KEY: '', GEMINI_VIA: 'apikey', GEMINI_BASE_URL: 'http://127.0.0.1:9', VERTEX_BASE_URL: 'http://127.0.0.1:9', DRIVE_API_BASE: 'http://127.0.0.1:9',
  GOOGLE_CLIENT_ID: '', GOOGLE_API_KEY: '', GOOGLE_APP_ID: '', CLASSROOM_IMPORT: ''
});

const test = require('node:test');
const assert = require('node:assert');
const C = require('../lib/classes');
const app = require('../server');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 1)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(40, 2)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(40, 3)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

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
    const r = await fetch(base + url, { method, headers: { ...(body && !raw ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: raw ? body : body ? JSON.stringify(body) : undefined });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const buf = Buffer.from(await r.arrayBuffer());
    let data = null;
    try { data = JSON.parse(buf.toString('utf8')); } catch {}
    return { status: r.status, data, buf, headers: r.headers };
  };
  return {
    get: u => call('GET', u), post: (u, b) => call('POST', u, b || {}), put: (u, b) => call('PUT', u, b), del: (u, b) => call('DELETE', u, b),
    upload: (u, buf, type = 'image/jpeg') => call('POST', u, buf, { 'Content-Type': type })
  };
}
let n = 0;
async function signup(role, firstName) {
  const c = client();
  const r = await c.post('/api/auth/signup', { email: `${firstName.toLowerCase()}${++n}@bg.test`, password: 'secret12', firstName, lastName: 'Test', role, ...(role === 'student' ? { over13: true } : {}) });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  c.user = r.data.user;
  return c;
}
// Every stored picture file under the image folder
const files = () => fs.existsSync(IMAGES) ? fs.readdirSync(IMAGES, { recursive: true }).filter(f => /\.(png|jpg|webp)$/.test(f)) : [];

test('lib: positions, presets and what pages see', () => {
  assert.strictEqual(C.backgroundPos(0), 0);
  assert.strictEqual(C.backgroundPos('37.4'), 37);
  for (const bad of [-1, 101, 'x', null, '']) assert.throws(() => C.backgroundPos(bad), { status: 400, message: 'The position must be 0 to 100.' });
  assert.strictEqual(C.backgroundPreset('ocean'), 'ocean');
  for (const bad of ['', 'evil', null, '../x', {}]) assert.throws(() => C.backgroundPreset(bad), { status: 400 });
  assert.strictEqual(C.publicBackground({ id: 'c' }), null);
  assert.deepStrictEqual(C.publicBackground({ id: 'c', background: { kind: 'preset', preset: 'night' } }), { kind: 'preset', preset: 'night' });
  assert.strictEqual(C.publicBackground({ id: 'c', background: { kind: 'preset', preset: 'gone' } }), null);
  const up = C.publicBackground({ id: 'c', background: { kind: 'upload', id: 'abc', mime: 'image/png', stored: { storage: 'local', file: 'x/abc.png' }, pos: 30 } });
  assert.deepStrictEqual(up, { kind: 'upload', url: '/api/classes/c/background?v=abc', pos: 30 });
});

test('routes: teachers set a background; members see it; others get nothing', async () => {
  const tess = await signup('teacher', 'Tess'), ana = await signup('teacher', 'Ana'), sam = await signup('student', 'Sam'), out = await signup('student', 'Out'), other = await signup('teacher', 'Oz');
  const cls = (await tess.post('/api/classes', { name: 'English 10' })).data.class;
  assert.strictEqual(cls.background, null);
  await tess.post(`/api/classes/${cls.id}/teachers`, { email: ana.user.email });
  await tess.post(`/api/classes/${cls.id}/students`, { emails: [sam.user.email] });
  const bgUrl = `/api/classes/${cls.id}/background`;

  // a preset
  let r = await tess.put(bgUrl, { preset: 'ocean' });
  assert.deepStrictEqual([r.status, r.data.class.background], [200, { kind: 'preset', preset: 'ocean' }]);
  assert.deepStrictEqual((await tess.put(bgUrl, { preset: 'nope' })).data.error, 'Pick one of Visor’s backgrounds.');
  assert.strictEqual((await tess.put(bgUrl, {})).status, 400);
  assert.strictEqual((await tess.put(bgUrl, { pos: 20 })).data.error, 'Only an uploaded picture has a position.');
  // the student sees it in their class list; nothing to load for a preset
  assert.deepStrictEqual((await sam.get('/api/classes')).data.classes.find(c => c.id === cls.id).background, { kind: 'preset', preset: 'ocean' });
  assert.strictEqual((await sam.get(bgUrl)).status, 404);

  // only the class's teachers may change it
  for (const who of [sam, out, other]) {
    assert.strictEqual((await who.put(bgUrl, { preset: 'night' })).status, 403);
    assert.strictEqual((await who.upload(bgUrl, JPEG)).status, 403);
    assert.strictEqual((await who.del(bgUrl)).status, 403);
  }
  // pictures by their bytes: PNG, JPEG, WebP; not GIF, SVG or anything else, whatever the type says
  for (const [buf, type] of [[GIF, 'image/gif'], [SVG, 'image/svg+xml'], [SVG, 'image/png'], [Buffer.from('hello'), 'image/jpeg']]) {
    r = await tess.upload(bgUrl, buf, type);
    assert.deepStrictEqual([r.status, r.data.error], [400, 'Use a PNG, JPEG or WebP picture.']);
  }
  r = await tess.upload(bgUrl, Buffer.alloc(5 * 1024 * 1024 + 10, 0xff));
  assert.strictEqual(r.status, 413);
  assert.deepStrictEqual(files(), []);

  r = await ana.upload(bgUrl, PNG, 'image/png'); // a co-teacher can
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  const first = r.data.class.background;
  assert.strictEqual(first.kind, 'upload');
  assert.match(first.url, new RegExp(`^/api/classes/${cls.id}/background\\?v=[a-f0-9]{32}$`));
  assert.strictEqual(first.pos, 50);
  assert.ok(!JSON.stringify(r.data).includes('stored') && !JSON.stringify(r.data).includes('classbg-'), 'no storage details');
  assert.strictEqual(files().length, 1);

  // members load it, with the sniffed type and nosniff; anyone else gets a 404
  for (const who of [tess, ana, sam]) {
    const g = await who.get(first.url);
    assert.strictEqual(g.status, 200);
    assert.ok(g.buf.equals(PNG));
    assert.strictEqual(g.headers.get('content-type'), 'image/png');
    assert.strictEqual(g.headers.get('x-content-type-options'), 'nosniff');
    assert.match(g.headers.get('cache-control'), /private/);
  }
  for (const who of [out, other]) assert.strictEqual((await who.get(first.url)).status, 404);
  assert.strictEqual((await client().get(first.url)).status, 401);

  // the position, then a new picture keeps it and deletes the old file
  r = await tess.put(bgUrl, { pos: 20 });
  assert.strictEqual(r.data.class.background.pos, 20);
  assert.strictEqual((await tess.put(bgUrl, { pos: 140 })).status, 400);
  r = await tess.upload(bgUrl, WEBP, 'image/webp');
  assert.deepStrictEqual([r.status, r.data.class.background.pos], [200, 20]);
  assert.notStrictEqual(r.data.class.background.url, first.url);
  assert.deepStrictEqual(files().map(f => path.extname(f)), ['.webp']);
  assert.strictEqual((await sam.get(r.data.class.background.url)).headers.get('content-type'), 'image/webp');
  // a preset replaces the picture (and deletes it); then back to a picture, then removed
  r = await tess.put(bgUrl, { preset: 'aurora' });
  assert.deepStrictEqual(files(), []);
  r = await tess.upload(bgUrl, JPEG);
  assert.strictEqual(r.data.class.background.pos, 50);
  assert.strictEqual(files().length, 1);
  r = await tess.del(bgUrl);
  assert.deepStrictEqual([r.status, r.data.class.background], [200, null]);
  assert.deepStrictEqual(files(), []);

  // the assignment page's class has it too
  await tess.put(bgUrl, { preset: 'meadow' });
  const a = (await tess.post(`/api/classes/${cls.id}/assignments`, { type: 'writing', title: 'Essay' })).data.assignment;
  assert.deepStrictEqual((await tess.get(`/api/assignments/${a.id}`)).data.class.background, { kind: 'preset', preset: 'meadow' });

  // deleting the class deletes its picture
  await tess.upload(bgUrl, JPEG);
  assert.strictEqual(files().length, 1);
  r = await tess.del(`/api/classes/${cls.id}`, { confirmName: 'English 10' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.deepStrictEqual(files(), []);
});
