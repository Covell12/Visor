// Pictures in essays through the HTTP API: uploading (who may, which types,
// how big, how many), who can see a picture, ops that insert one, Download my
// data and deleting. Runs on a local PGlite store and a temp picture folder;
// nothing here reaches Firebase, Google or Gemini.
'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-img-'));
const IMAGES = path.join(DATA, 'images');
Object.assign(process.env, {
  VISOR_PLATFORM: '', DATABASE_URL: '',
  PGLITE_DIR: path.join(DATA, 'pglite'), VISOR_IMAGE_DIR: IMAGES, VISOR_AUDIO_DIR: path.join(DATA, 'audio'), SESSION_SECRET: 'test-secret', NODE_ENV: 'test',
  GEMINI_API_KEY: '', GEMINI_VIA: 'apikey', GEMINI_BASE_URL: 'http://127.0.0.1:9', VERTEX_BASE_URL: 'http://127.0.0.1:9', DRIVE_API_BASE: 'http://127.0.0.1:9',
  GOOGLE_CLIENT_ID: '', GOOGLE_API_KEY: '', GOOGLE_APP_ID: '', CLASSROOM_IMPORT: ''
});

const test = require('node:test');
const assert = require('node:assert');
const app = require('../server');
const repo = require('../lib/repo');
const { sign } = require('../lib/session');

const EMBED = '￼';
// The smallest real PNG (1×1); the other types only need their first bytes
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 7), Buffer.from([0xff, 0xd9])]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(30, 1)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([30, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(22, 2)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

let server, base;
test.before(async () => {
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); fs.rmSync(DATA, { recursive: true, force: true }); });

// A person in a browser: keeps the __session cookie between calls. upload()
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
    return { status: r.status, data, headers: r.headers, buf };
  };
  return {
    get: (u, h) => call('GET', u, null, h), post: (u, b, h) => call('POST', u, b || {}, h), patch: (u, b) => call('PATCH', u, b), del: (u, b) => call('DELETE', u, b),
    upload: (u, buf, h = {}) => call('POST', u, buf, { 'Content-Type': 'image/png', ...h }), cookie: () => cookie
  };
}

test('the document style: MLA unless the teacher picks Docs default, and checked', async () => {
  const teacher = client(), stu = client();
  await teacher.post('/api/auth/signup', { email: 'ds@school.test', password: 'secret12', firstName: 'Dee', lastName: 'Teacher', role: 'teacher' });
  const cls = (await teacher.post('/api/classes', { name: 'Style' })).data.class;
  await stu.post('/api/auth/signup', { email: 'dss@school.test', password: 'secret12', firstName: 'Dot', lastName: 'Student', role: 'student', over13: true, classCode: cls.joinCode });

  let r = await teacher.post(`/api/classes/${cls.id}/assignments`, { type: 'writing', title: 'Default', writing: { mode: 'locked' } });
  assert.strictEqual(r.data.assignment.writing.docStyle, 'mla', 'locked: MLA by default');
  r = await teacher.post(`/api/classes/${cls.id}/assignments`, { type: 'writing', title: 'Default open', writing: { mode: 'open' } });
  assert.strictEqual(r.data.assignment.writing.docStyle, 'mla', 'open: MLA by default');
  r = await teacher.post(`/api/classes/${cls.id}/assignments`, { type: 'writing', title: 'Docs', writing: { mode: 'open', docStyle: 'docs' } });
  assert.strictEqual(r.status, 200);
  const a = r.data.assignment;
  assert.strictEqual(a.writing.docStyle, 'docs');
  r = await teacher.get(`/api/assignments/${a.id}`);
  assert.strictEqual(r.data.assignment.writing.docStyle, 'docs');
  r = await teacher.patch(`/api/assignments/${a.id}`, { writing: { docStyle: 'apa' } });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.data.error, 'Document style must be MLA essay or Docs default');
  r = await teacher.patch(`/api/assignments/${a.id}`, { writing: { citationStyle: 'apa' } });
  assert.strictEqual(r.data.assignment.writing.docStyle, 'docs', 'a setting not sent is kept');
  await teacher.post(`/api/assignments/${a.id}/publish`, {});
  r = await stu.get(`/api/write/${a.id}`);
  assert.strictEqual(r.data.assignment.writing.docStyle, 'docs', 'the editor gets it');
  r = await teacher.patch(`/api/assignments/${a.id}`, { writing: { docStyle: 'mla' } });
  assert.strictEqual(r.data.assignment.writing.docStyle, 'mla');
});

test('pictures: uploading, who can see them, ops, Download my data and deleting', async () => {
  const teacher = client(), stu = client(), other = client(), nobody = client(), panel = client();
  await teacher.post('/api/auth/signup', { email: 'it@school.test', password: 'secret12', firstName: 'Ida', lastName: 'Teacher', role: 'teacher' });
  const cls = (await teacher.post('/api/classes', { name: 'Art' })).data.class;
  const me = (await stu.post('/api/auth/signup', { email: 'is@school.test', password: 'secret12', firstName: 'Ivy', lastName: 'Student', role: 'student', over13: true, classCode: cls.joinCode })).data.user;
  await other.post('/api/auth/signup', { email: 'io@school.test', password: 'secret12', firstName: 'Oz', lastName: 'Other', role: 'student', over13: true, classCode: cls.joinCode });
  const a = (await teacher.post(`/api/classes/${cls.id}/assignments`, { type: 'writing', title: 'Picture essay', writing: { mode: 'open', allowPaste: 'allow' } })).data.assignment;
  await teacher.post(`/api/assignments/${a.id}/publish`, {});

  let r = await stu.get(`/api/write/${a.id}`);
  const doc = r.data.doc;
  const stuToken = r.data.imageToken;
  assert.strictEqual(typeof stuToken, 'string', 'the editor gets an image token');
  r = await other.get(`/api/write/${a.id}`);
  const otherDoc = r.data.doc, otherToken = r.data.imageToken;
  const up = `/api/write/${doc.id}/images`;

  // No session, no upload
  r = await stu.upload(up, PNG);
  assert.strictEqual(r.status, 401);
  const s = (await stu.post(`/api/write/${doc.id}/sessions`, { surfaceId: 't1', surf: 'tab' })).data;
  const H = { 'X-Visor-Session': s.token, 'X-Visor-Surface': 't1' };
  // Only the surface holding the lease
  r = await stu.upload(up, PNG, { ...H, 'X-Visor-Surface': 'another-tab' });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.data.notLeaseHolder, true);
  // Only real PNG, JPEG, GIF or WebP, whatever the browser says it is
  r = await stu.upload(up, SVG, H);
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.data.error, 'Only PNG, JPEG, GIF or WebP images.');
  r = await stu.upload(up, Buffer.from('not a picture at all'), { ...H, 'Content-Type': 'image/jpeg' });
  assert.strictEqual(r.status, 400);
  // 5 MB at most (just over, and well over the request limit)
  const big = n => Buffer.concat([PNG, Buffer.alloc(n - PNG.length)]);
  r = await stu.upload(up, big(5 * 1024 * 1024 + 1), H);
  assert.strictEqual(r.status, 413);
  assert.strictEqual(r.data.error, 'That image is too large (5 MB at most).');
  r = await stu.upload(up, big(7 * 1024 * 1024), H);
  assert.strictEqual(r.status, 413);
  assert.strictEqual(r.data.error, 'That image is too large (5 MB at most).');
  assert.deepStrictEqual(await repo.listRecords('image', { docId: doc.id }), [], 'nothing refused was kept');

  // A picture
  r = await stu.upload(`${up}?w=1&h=1`, PNG, H);
  assert.strictEqual(r.status, 200);
  const id = r.data.id;
  assert.match(id, /^[a-f0-9]{32}$/);
  assert.strictEqual(r.data.url, `/api/images/${id}`);
  const rec = await repo.getRecord('image', id);
  assert.deepStrictEqual({ docId: rec.docId, classId: rec.classId, assignmentId: rec.assignmentId, studentId: rec.studentId, sessionId: rec.sessionId, mime: rec.mime, sizeBytes: rec.sizeBytes, width: rec.width, height: rec.height, stored: rec.stored },
    { docId: doc.id, classId: cls.id, assignmentId: a.id, studentId: me.id, sessionId: s.session.id, mime: 'image/png', sizeBytes: PNG.length, width: 1, height: 1, stored: { storage: 'local', file: `${doc.id}/${id}.png` } });
  assert.ok(rec.createdAt);
  assert.ok(fs.readFileSync(path.join(IMAGES, doc.id, `${id}.png`)).equals(PNG), 'the file is in the image folder');
  // The type comes from the bytes: a JPEG sent as image/png is a JPEG
  r = await stu.upload(`${up}?w=abc`, JPEG, H);
  const jpegId = r.data.id;
  assert.strictEqual((await repo.getRecord('image', jpegId)).mime, 'image/jpeg');
  assert.strictEqual((await repo.getRecord('image', jpegId)).width, null, 'a size that isn’t a number is left out');
  assert.ok(fs.existsSync(path.join(IMAGES, doc.id, `${jpegId}.jpg`)));
  r = await stu.upload(up, GIF, H);
  assert.strictEqual((await repo.getRecord('image', r.data.id)).mime, 'image/gif');
  // The surface may come in the address instead of a header
  r = await stu.upload(`${up}?surfaceId=t1`, WEBP, { 'X-Visor-Session': s.token, 'Content-Type': 'application/octet-stream' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await repo.getRecord('image', r.data.id)).mime, 'image/webp');

  // Who can see it: the student, their teacher, or a valid image token. Everyone else: 404
  const pic = `/api/images/${id}`;
  r = await stu.get(pic);
  assert.strictEqual(r.status, 200);
  assert.ok(r.buf.equals(PNG));
  assert.strictEqual(r.headers.get('content-type'), 'image/png');
  assert.strictEqual(r.headers.get('cache-control'), 'private, max-age=3600');
  assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
  r = await stu.get(`/api/images/${jpegId}`);
  assert.strictEqual(r.headers.get('content-type'), 'image/jpeg', 'the type from the record');
  r = await teacher.get(pic);
  assert.strictEqual(r.status, 200, 'the class teacher');
  r = await nobody.get(`${pic}?t=${encodeURIComponent(stuToken)}`);
  assert.strictEqual(r.status, 200, 'the image token, with no cookie (the side panel)');
  assert.ok(r.buf.equals(PNG));
  r = await nobody.get(pic);
  assert.strictEqual(r.status, 404);
  r = await other.get(pic);
  assert.strictEqual(r.status, 404, 'another student');
  r = await other.get(`${pic}?t=${encodeURIComponent(otherToken)}`);
  assert.strictEqual(r.status, 404, 'a token for another document');
  const expired = sign('test-secret', { docId: doc.id, uid: me.id, exp: Date.now() - 1000 }, 'img');
  r = await nobody.get(`${pic}?t=${encodeURIComponent(expired)}`);
  assert.strictEqual(r.status, 404, 'an expired token');
  r = await nobody.get(`${pic}?t=${encodeURIComponent(s.token)}`);
  assert.strictEqual(r.status, 404, 'a session token isn’t an image token');
  r = await stu.get(`/api/images/${'0'.repeat(32)}`);
  assert.strictEqual(r.status, 404);
  r = await stu.get('/api/images/..%2F..%2Fserver.js');
  assert.strictEqual(r.status, 404);
  r = await teacher.get(`/api/review/${doc.id}`);
  assert.strictEqual(typeof r.data.imageToken, 'string', 'the review gets an image token');
  r = await nobody.get(`${pic}?t=${encodeURIComponent(r.data.imageToken)}`);
  assert.strictEqual(r.status, 200);

  // Ops may only insert this document's own pictures
  const os2 = (await other.post(`/api/write/${otherDoc.id}/sessions`, { surfaceId: 'o1', surf: 'tab' })).data;
  r = await other.upload(`/api/write/${otherDoc.id}/images`, PNG, { 'X-Visor-Session': os2.token, 'X-Visor-Surface': 'o1' });
  const otherId = r.data.id;
  assert.strictEqual(r.status, 200);
  r = await stu.upload(`/api/write/${otherDoc.id}/images`, PNG, H);
  assert.strictEqual(r.status, 401, 'a session token only works for its own document');
  const embed = (imageId, extra = {}) => ({ k: 'i', at: 0, s: EMBED, attrs: { image: imageId, ...extra }, t: Date.now(), src: 'image' });
  r = await stu.post(`/api/write/${doc.id}/ops`, { baseSeq: 0, ops: [embed(otherId)], surfaceId: 't1' }, H);
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.data.error, 'That image belongs to another document.');
  r = await stu.post(`/api/write/${doc.id}/ops`, { baseSeq: 0, ops: [embed('f'.repeat(32))], surfaceId: 't1' }, H);
  assert.strictEqual(r.status, 400, 'a picture that was never uploaded');
  r = await stu.post(`/api/write/${doc.id}/ops`, { baseSeq: 0, ops: [embed(id, { width: 200 })], surfaceId: 't1' }, H);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.seq, 1);
  const saved = await repo.getRecord('doc', doc.id);
  assert.strictEqual(saved.text, EMBED, 'the picture is one placeholder character');
  assert.ok(saved.formats.some(f => f.attrs && f.attrs.image === id), 'with its id in the formats');

  // The side panel (extension token, panel session token, no cookie) uploads too
  r = await stu.post(`/api/write/${doc.id}/lease`, { give: 'panel' }, H);
  assert.strictEqual(r.status, 200);
  const X = { 'X-Visor-Token': (await stu.post('/api/ext/token')).data.token };
  r = await panel.get(`/api/write/${a.id}?surf=panel`, X);
  const P = { ...X, 'X-Visor-Session': r.data.token, 'X-Visor-Surface': 'panel-1' };
  const panelToken = r.data.imageToken;
  r = await panel.upload(up, PNG, P);
  assert.strictEqual(r.status, 200);
  r = await panel.get(`/api/images/${r.data.id}?t=${encodeURIComponent(panelToken)}`);
  assert.strictEqual(r.status, 200, 'the panel shows it with its image token');
  r = await stu.upload(up, PNG, H);
  assert.strictEqual(r.status, 409, 'the tab no longer holds the lease');
  r = await stu.post(`/api/write/${doc.id}/lease`, { surfaceId: 't1', surf: 'tab' }, H);
  assert.strictEqual(r.status, 200);

  // At most 100 pictures per essay
  const have = (await repo.listRecords('image', { docId: doc.id })).length;
  assert.strictEqual((await repo.getRecord('doc', doc.id)).imageCount, have, 'the essay counts its pictures');
  await repo.updateRecord('doc', doc.id, d => { d.imageCount = 100; });
  r = await stu.upload(up, PNG, H);
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.data.error, 'This essay has the most images it can hold (100).');
  await repo.updateRecord('doc', doc.id, d => { d.imageCount = have; });

  // Not while the teacher has paused the session
  await teacher.post(`/api/assignments/${a.id}/live/action`, { action: 'pause', studentIds: [me.id] });
  r = await stu.upload(up, PNG, H);
  assert.strictEqual(r.status, 423);
  await teacher.post(`/api/assignments/${a.id}/live/action`, { action: 'resume', studentIds: [me.id] });
  r = await stu.upload(up, PNG, H);
  assert.strictEqual(r.status, 200);
  const count = (await repo.listRecords('image', { docId: doc.id })).length;

  // Download my data lists the pictures (without their bytes)
  r = await stu.get('/api/me/export');
  const mine = r.data.documents.find(d => d.assignment.id === a.id);
  assert.strictEqual(mine.images.length, count);
  assert.ok(mine.images.every(i => /^\/api\/images\/[a-f0-9]{32}$/.test(i.url) && i.mime && i.sizeBytes > 0 && !('stored' in i)));
  assert.ok(mine.images.some(i => i.id === id && i.width === 1 && i.height === 1));
  assert.match(r.data.imagesNote, /signed in/);
  assert.ok(!mine.images.some(i => i.id === otherId), 'only their own');

  // Not once it's submitted
  await stu.post(`/api/write/${doc.id}/submit`, {});
  r = await stu.upload(up, PNG, H);
  assert.strictEqual(r.status, 409);

  // Deleting the student's work deletes their pictures, files and records
  r = await teacher.del(`/api/classes/${cls.id}/students/${me.id}/data`);
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(await repo.listRecords('image', { docId: doc.id }), []);
  assert.strictEqual(fs.existsSync(path.join(IMAGES, doc.id)), false, 'the files are gone');
  r = await teacher.get(pic);
  assert.strictEqual(r.status, 404);
  assert.ok(await repo.getRecord('image', otherId), 'other students’ pictures stay');
  assert.ok(fs.existsSync(path.join(IMAGES, otherDoc.id, `${otherId}.png`)));

  // …and deleting the assignment deletes everyone's
  r = await teacher.del(`/api/assignments/${a.id}`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(await repo.getRecord('image', otherId), null);
  assert.strictEqual(fs.existsSync(path.join(IMAGES, otherDoc.id)), false);
});

test('pictures follow the paste setting: no uploads when pasting from outside is off', async () => {
  const teacher = client(), stu = client();
  await teacher.post('/api/auth/signup', { email: 'pp@school.test', password: 'secret12', firstName: 'Pam', lastName: 'Teacher', role: 'teacher' });
  const cls = (await teacher.post('/api/classes', { name: 'No pictures' })).data.class;
  await stu.post('/api/auth/signup', { email: 'pps@school.test', password: 'secret12', firstName: 'Pip', lastName: 'Student', role: 'student', over13: true, classCode: cls.joinCode });
  for (const allowPaste of ['internal-only', 'block']) {
    const a = (await teacher.post(`/api/classes/${cls.id}/assignments`, { type: 'writing', title: `Paste ${allowPaste}`, writing: { mode: 'open', allowPaste } })).data.assignment;
    await teacher.post(`/api/assignments/${a.id}/publish`, {});
    const doc = (await stu.get(`/api/write/${a.id}`)).data.doc;
    const s = (await stu.post(`/api/write/${doc.id}/sessions`, { surfaceId: 'x1', surf: 'tab' })).data;
    const r = await stu.upload(`/api/write/${doc.id}/images`, PNG, { 'X-Visor-Session': s.token, 'X-Visor-Surface': 'x1' });
    assert.strictEqual(r.status, 403, allowPaste);
    assert.strictEqual(r.data.error, 'Images from outside the essay are turned off for this assignment.');
    assert.deepStrictEqual(await repo.listRecords('image', { docId: doc.id }), []);
    await stu.post(`/api/write/${doc.id}/end`, {}, { 'X-Visor-Session': s.token });
  }
});
