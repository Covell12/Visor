// The portal: course colours, folders and their order (lib/materials.js and
// the routes), class updates, Recent activity, the calendar, and what deleting
// a class removes. Runs on a local PGlite store in a temp folder; nothing here
// reaches Firebase, Google or Gemini (their settings are blanked and pointed
// at a closed local port).
'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-portal-'));
Object.assign(process.env, {
  VISOR_PLATFORM: '', DATABASE_URL: '',
  PGLITE_DIR: path.join(DATA, 'pglite'), VISOR_IMAGE_DIR: path.join(DATA, 'images'), VISOR_AUDIO_DIR: path.join(DATA, 'audio'),
  VISOR_DEV_LOGIN: '1', VISOR_SCHOOL_OPTIONAL: '1', SESSION_SECRET: 'test-secret', NODE_ENV: 'test',
  GEMINI_API_KEY: '', GEMINI_VIA: 'apikey', GEMINI_BASE_URL: 'http://127.0.0.1:9', VERTEX_BASE_URL: 'http://127.0.0.1:9', DRIVE_API_BASE: 'http://127.0.0.1:9',
  GOOGLE_CLIENT_ID: '', GOOGLE_API_KEY: '', GOOGLE_APP_ID: '', CLASSROOM_IMPORT: ''
});

const test = require('node:test');
const assert = require('node:assert');
const M = require('../lib/materials');
const { COURSE_COLORS, colorFor } = require('../lib/classes');
const app = require('../server');
const repo = require('../lib/repo');

const sleep = ms => new Promise(r => setTimeout(r, ms));

let server, base;
test.before(async () => {
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); fs.rmSync(DATA, { recursive: true, force: true }); });

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
  return { get: (u, h) => call('GET', u, null, h), post: (u, b, h) => call('POST', u, b || {}, h), patch: (u, b) => call('PATCH', u, b), put: (u, b) => call('PUT', u, b), del: (u, b) => call('DELETE', u, b) };
}

let people = 0;
async function signup(c, role, firstName, extra = {}) {
  const r = await c.post('/api/auth/signup', { email: `${firstName.toLowerCase()}${++people}@school.test`, password: 'secret12', firstName, lastName: role === 'teacher' ? 'Teacher' : 'Student', role, ...(role === 'student' ? { over13: true } : {}), ...extra });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return r.data.user;
}
const newClass = async (teacher, name) => (await teacher.post('/api/classes', { name })).data.class;

// One level of a class page in order, the way the order route takes it
const levelOf = (page, folderId) => [
  ...page.folders.filter(f => f.parentId === folderId).map(f => ({ kind: 'folder', id: f.id, position: f.position })),
  ...page.assignments.filter(a => a.folderId === folderId).map(a => ({ kind: 'assignment', id: a.id, position: a.position }))
].sort((x, y) => x.position - y.position).map(({ kind, id }) => ({ kind, id }));

/* ---------------- lib/materials.js ---------------- */

const T = '2026-01-01T00:00:00.000Z';
const F = (id, parentId = null, position = 0) => ({ id, classId: 'c', parentId, name: id.toUpperCase(), position, createdAt: T });
const A = (id, folderId = null, position = 0, publishedAt = null) => ({ id, classId: 'c', folderId, position, createdAt: T, publishedAt });

test('materials: effective positions, the order of a level, the top', () => {
  const old = { id: 'a', createdAt: '2026-01-01T00:00:00.000Z' };
  const newer = { id: 'b', createdAt: '2026-02-01T00:00:00.000Z' };
  assert.strictEqual(M.effectivePosition({ ...old, position: 3 }), 3);
  assert.strictEqual(M.effectivePosition({ ...old, position: null }), -Date.parse(old.createdAt) / 1000);
  // never put in order: newest first, as class pages were before folders
  assert.deepStrictEqual(M.sortLevel([old, newer]).map(x => x.id), ['b', 'a']);
  // in order: by position; ties go newer first, then by id
  const later = '2026-03-01T00:00:00.000Z';
  const items = [{ id: 'x', position: 1, createdAt: T }, { id: 'y', position: 0, createdAt: T }, { id: 'z', position: 1, createdAt: later }, { id: 'w', position: 1, createdAt: T }];
  assert.deepStrictEqual(M.sortLevel(items).map(x => x.id), ['y', 'z', 'w', 'x']);
  assert.deepStrictEqual(items.map(x => x.id), ['x', 'y', 'z', 'w'], 'sortLevel leaves its input alone');
  // the top: one before the first item, leaving out the item itself; 0 when empty
  assert.strictEqual(M.topPosition([]), 0);
  assert.strictEqual(M.topPosition([{ kind: 'folder', id: 'f', position: 0 }, { kind: 'assignment', id: 'a', position: 2 }]), -1);
  assert.strictEqual(M.topPosition([{ kind: 'folder', id: 'f', position: -1 }, { kind: 'assignment', id: 'a', position: 2 }], { kind: 'folder', id: 'f' }), 1);
  assert.strictEqual(M.topPosition([{ kind: 'folder', id: 'f', position: -1 }], { kind: 'folder', id: 'f' }), 0);
  assert.strictEqual(M.topPosition([{ kind: 'assignment', id: 'f', position: -1 }], { kind: 'folder', id: 'f' }), -2, 'the same id in the other kind is another item');
  assert.strictEqual(M.topPosition([old, newer]), -Date.parse(newer.createdAt) / 1000 - 1);
});

test('materials: levels, depth, moving folders, the breadcrumb', () => {
  const folders = [F('u1', null, 1), F('u2', null, 0), F('w1', 'u1', 0), F('d1', 'w1', 0)];
  const list = [A('a1', null, 2), A('a2', 'u1', -1), A('a3', 'd1', 0)];
  assert.deepStrictEqual(M.levelItems(folders, list, null).map(x => `${x.kind}:${x.id}`), ['folder:u2', 'folder:u1', 'assignment:a1']);
  assert.deepStrictEqual(M.levelItems(folders, list, 'u1').map(x => x.id), ['a2', 'w1']);
  assert.deepStrictEqual(M.levelItems(folders, list, 'u2'), []);
  assert.deepStrictEqual([null, 'u1', 'w1', 'd1'].map(id => M.depthOf(folders, id)), [0, 1, 2, 3]);
  assert.deepStrictEqual(['u1', 'w1', 'd1', 'u2'].map(id => M.heightOf(folders, id)), [3, 2, 1, 1]);
  assert.ok(M.isInside(folders, 'd1', 'u1') && M.isInside(folders, 'u1', 'u1') && !M.isInside(folders, 'u1', 'd1') && !M.isInside(folders, null, 'u1'));

  // a new folder: at most 3 deep, and only in this class
  assert.strictEqual(M.checkPlace(folders, 'w1'), 'w1');
  assert.strictEqual(M.checkPlace(folders, ''), null);
  assert.throws(() => M.checkPlace(folders, 'd1'), { status: 400, message: 'Folders can be at most 3 deep' });
  assert.throws(() => M.checkPlace(folders, 'elsewhere'), { status: 400, message: "That folder isn't in this class" });
  // a move: never into itself or anything inside it, and the whole folder must fit
  assert.throws(() => M.checkPlace(folders, 'd1', 'u1'), { status: 400, message: "A folder can't go inside itself" });
  assert.throws(() => M.checkPlace(folders, 'u1', 'u1'), { message: "A folder can't go inside itself" });
  assert.throws(() => M.checkPlace(folders, 'u2', 'u1'), { message: 'Folders can be at most 3 deep' });
  assert.throws(() => M.checkPlace(folders, 'd1', 'u2'), { message: 'Folders can be at most 3 deep' });
  assert.strictEqual(M.checkPlace(folders, 'u2', 'w1'), 'u2', 'two levels into a top folder fits');
  assert.strictEqual(M.checkPlace(folders, 'w1', 'u2'), 'w1');
  assert.strictEqual(M.checkPlace(folders, null, 'd1'), null);

  assert.deepStrictEqual(M.folderPath(folders, 'd1'), [{ id: 'u1', name: 'U1' }, { id: 'w1', name: 'W1' }, { id: 'd1', name: 'D1' }]);
  assert.deepStrictEqual(M.folderPath(folders, null), []);
  assert.deepStrictEqual(M.folderPath(folders, 'gone'), []);
});

test('materials: tidy gives lost folders and assignments a place', () => {
  const folders = [F('a', 'b'), F('b', 'a'), F('c', 'gone'), F('d', 'c')];
  const tidied = M.tidy(folders, [A('x', 'gone'), A('y', 'd'), A('z')]);
  const parent = Object.fromEntries(tidied.folders.map(f => [f.id, f.parentId]));
  assert.strictEqual(parent.c, null, 'a folder whose parent is gone goes to the top');
  assert.strictEqual(parent.d, 'c');
  assert.strictEqual([parent.a, parent.b].filter(p => p === null).length, 1, 'a loop is broken in one place');
  assert.deepStrictEqual(tidied.assignments.map(a => a.folderId), [null, 'd', null]);
  assert.strictEqual(folders[2].parentId, 'gone', 'the records passed in are not changed');
  // checks on a looped list still finish
  assert.ok(M.depthOf(folders, 'a') >= 1);
  assert.strictEqual(M.isInside(folders, 'a', 'zz'), false);
});

test('materials: folder names, colours and descriptions', () => {
  assert.deepStrictEqual(M.cleanFolderInput({ name: '  Unit   1  ' }), { name: 'Unit 1', color: null, description: '' });
  assert.throws(() => M.cleanFolderInput({ name: '   ' }), { status: 400, message: 'Give the folder a name' });
  assert.throws(() => M.cleanFolderInput({}), { message: 'Give the folder a name' });
  assert.strictEqual(M.cleanFolderInput({ name: 'x'.repeat(300) }).name.length, 120);
  assert.throws(() => M.cleanFolderInput({ name: 'U', color: 'pink' }), { status: 400, message: 'Pick one of the course colors' });
  for (const color of COURSE_COLORS) assert.strictEqual(M.cleanFolderInput({ name: 'U', color }).color, color);
  assert.strictEqual(M.cleanFolderInput({ name: 'U', description: '  Line 1\r\nLine 2\n\n' }).description, 'Line 1\nLine 2');
  assert.strictEqual(M.cleanFolderInput({ name: 'U', description: 'x'.repeat(1000) }).description.length, 1000);
  assert.throws(() => M.cleanFolderInput({ name: 'U', description: 'x'.repeat(1001) }), { status: 400, message: 'Folder descriptions can be at most 1,000 characters' });
  // an edit only returns what was sent
  assert.deepStrictEqual(M.cleanFolderInput({ color: null }, F('u1')), { color: null });
  assert.deepStrictEqual(M.cleanFolderInput({ parentId: 'x' }, F('u1')), {});
  assert.throws(() => M.cleanFolderInput({ name: '' }, F('u1')), { message: 'Give the folder a name' });
  const f = M.newFolder('c1', { name: 'Unit' }, { parentId: 'p', position: -2 });
  assert.deepStrictEqual(Object.keys(f), ['id', 'classId', 'parentId', 'name', 'color', 'description', 'position', 'createdAt', 'updatedAt']);
  assert.deepStrictEqual([f.classId, f.parentId, f.position, f.color, f.description], ['c1', 'p', -2, null, '']);
});

test('materials: what students see, deleting a folder, the exact-set check', () => {
  const folders = [F('u1', null, 0), F('w1', 'u1', 0), F('d1', 'w1', 0), F('empty', null, 1), F('drafts', null, 2), F('w2', 'u1', 1)];
  const list = [A('pub', 'w1', 0, T), A('draft', 'drafts', 0), A('draft2', 'w2', 0)];
  assert.deepStrictEqual(M.studentVisibleFolders(folders, list).map(f => f.id), ['u1', 'w1'], 'only folders holding something published');
  assert.deepStrictEqual(M.studentVisibleFolders(folders, [A('top', null, 0, T)]), []);

  // f2's children take its place in the level above, in their order
  const fs2 = [F('f1', null, 0), F('f2', null, 1), F('f3', null, 2), F('g1', 'f2', 1)];
  const as2 = [A('x', 'f2', 0), A('y', 'f2', 2), A('top', null, 3)];
  assert.deepStrictEqual(M.levelAfterDelete(fs2, as2, 'f2').map(x => x.id), ['f1', 'x', 'g1', 'y', 'f3', 'top']);
  assert.deepStrictEqual(M.levelAfterDelete(fs2, as2, 'g1').map(x => x.id), ['x', 'y'], 'an empty folder just leaves');

  const level = M.levelItems(fs2, as2, null);
  const ref = level.map(({ kind, id }) => ({ kind, id }));
  assert.ok(M.sameItems(level, ref));
  assert.ok(M.sameItems(level, [...ref].reverse()), 'any order of the same items');
  assert.ok(!M.sameItems(level, ref.slice(1)), 'one missing');
  assert.ok(!M.sameItems(level, [...ref, { kind: 'folder', id: 'g1' }]), 'one extra');
  assert.ok(!M.sameItems(level, [...ref.slice(1), ref[1]]), 'one twice');
  assert.ok(!M.sameItems(level, ref.map((x, i) => (i ? x : { ...x, kind: 'assignment' }))), 'the wrong kind');
  assert.ok(!M.sameItems(level, ref.map((x, i) => (i ? x : { ...x, kind: 'page' }))), 'not a kind at all');
  assert.ok(!M.sameItems(level, null));
  assert.ok(M.sameItems([], []));
});

/* ---------------- course colours ---------------- */

test('course colours: a stable default, the teacher picks one, students see it', async () => {
  const teacher = client(), stu = client();
  await signup(teacher, 'teacher', 'Cora');
  const cls = await newClass(teacher, 'Art');
  const def = cls.color;
  assert.ok(COURSE_COLORS.includes(def));
  assert.strictEqual(colorFor({ id: cls.id }), def);
  let r = await teacher.get(`/api/classes/${cls.id}`);
  assert.strictEqual(r.data.class.color, def, 'the same colour every time');
  r = await teacher.get('/api/classes');
  assert.strictEqual(r.data.classes[0].color, def);

  r = await teacher.patch(`/api/classes/${cls.id}`, { color: 'pink' });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.data.error, 'Pick one of the course colors');
  const pick = COURSE_COLORS.find(c => c !== def);
  r = await teacher.patch(`/api/classes/${cls.id}`, { color: pick });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.class.color, pick);
  r = await teacher.patch(`/api/classes/${cls.id}`, { name: 'Art 2' });
  assert.strictEqual(r.data.class.color, pick, 'other edits keep it');

  await signup(stu, 'student', 'Stu', { classCode: cls.joinCode });
  r = await stu.get('/api/classes');
  assert.strictEqual(r.data.classes[0].color, pick);
  r = await stu.get(`/api/classes/${cls.id}`);
  assert.strictEqual(r.data.class.color, pick);
  r = await stu.patch(`/api/classes/${cls.id}`, { color: def });
  assert.strictEqual(r.status, 403);

  r = await teacher.patch(`/api/classes/${cls.id}`, { color: null });
  assert.strictEqual(r.data.class.color, def, 'null goes back to the default');

  // A teacher's new classes get colours their other classes don't have, until all ten are taken
  const more = [];
  for (let i = 0; i < 9; i++) more.push(await newClass(teacher, `Period ${i + 1}`));
  assert.strictEqual(new Set([def, ...more.map(c => c.color)]).size, COURSE_COLORS.length);
  const eleventh = await newClass(teacher, 'Period 10');
  assert.ok(COURSE_COLORS.includes(eleventh.color));
});

/* ---------------- folders ---------------- */

test('folders: create, nest, edit, move, reorder, delete; assignments in folders', async () => {
  const teacher = client(), stu = client(), other = client();
  await signup(teacher, 'teacher', 'Fay');
  const cls = await newClass(teacher, 'English 11');
  const cls2 = await newClass(teacher, 'English 12');
  await signup(stu, 'student', 'Sol', { classCode: cls.joinCode });
  await signup(other, 'teacher', 'Oto');
  const otherCls = await newClass(other, 'Elsewhere');
  const elsewhere = (await other.post(`/api/classes/${otherCls.id}/folders`, { name: 'Theirs' })).data.folder;

  const old = (await teacher.post(`/api/classes/${cls.id}/assignments`, { type: 'writing', title: 'Old essay', instructions: 'Keep me', writing: { mode: 'open' } })).data.assignment;
  assert.strictEqual(old.folderId, null);
  assert.strictEqual(old.position, 0, 'the first thing in an empty level');

  // creating
  let r = await teacher.post(`/api/classes/${cls.id}/folders`, { name: '  Unit 1 ', color: 'teal', description: 'Poetry\r\nand prose' });
  assert.strictEqual(r.status, 200);
  const u1 = r.data.folder;
  assert.deepStrictEqual({ ...u1, id: null, createdAt: null, updatedAt: null }, { id: null, classId: cls.id, parentId: null, name: 'Unit 1', color: 'teal', description: 'Poetry\nand prose', position: -1, createdAt: null, updatedAt: null });
  const u2 = (await teacher.post(`/api/classes/${cls.id}/folders`, { name: 'Unit 2' })).data.folder;
  assert.strictEqual(u2.position, -2, 'new folders land at the top');
  assert.strictEqual(u2.color, null);
  const w1 = (await teacher.post(`/api/classes/${cls.id}/folders`, { name: 'Week 1', parentId: u1.id })).data.folder;
  assert.deepStrictEqual([w1.parentId, w1.position], [u1.id, 0]);
  const d1 = (await teacher.post(`/api/classes/${cls.id}/folders`, { name: 'Day 1', parentId: w1.id })).data.folder;
  r = await teacher.post(`/api/classes/${cls.id}/folders`, { name: 'Too deep', parentId: d1.id });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.data.error, 'Folders can be at most 3 deep');
  r = await teacher.post(`/api/classes/${cls.id}/folders`, { name: 'Borrowed', parentId: elsewhere.id });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.data.error, "That folder isn't in this class");
  r = await teacher.post(`/api/classes/${cls.id}/folders`, { name: '  ' });
  assert.strictEqual(r.status, 400);
  r = await teacher.post(`/api/classes/${cls.id}/folders`, { name: 'Bad colour', color: 'pink' });
  assert.strictEqual(r.data.error, 'Pick one of the course colors');
  r = await stu.post(`/api/classes/${cls.id}/folders`, { name: 'Mine' });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.data.error, 'only the class teacher can do that');
  r = await other.post(`/api/classes/${cls.id}/folders`, { name: 'Mine' });
  assert.strictEqual(r.status, 403);

  // editing
  r = await teacher.patch(`/api/folders/${u2.id}`, { name: 'Unit Two', color: 'gold', description: 'Drama' });
  assert.deepStrictEqual([r.data.folder.name, r.data.folder.color, r.data.folder.description, r.data.folder.position, r.data.folder.parentId], ['Unit Two', 'gold', 'Drama', -2, null]);
  r = await teacher.patch(`/api/folders/${u2.id}`, { color: null });
  assert.deepStrictEqual([r.data.folder.name, r.data.folder.color], ['Unit Two', null]);
  r = await teacher.patch(`/api/folders/${u2.id}`, { color: 'beige' });
  assert.strictEqual(r.status, 400);
  r = await stu.patch(`/api/folders/${u1.id}`, { name: 'Mine now' });
  assert.strictEqual(r.status, 403);
  r = await teacher.patch('/api/folders/nope', { name: 'X' });
  assert.strictEqual(r.status, 404);

  // moving a folder: never into itself, and it has to fit
  r = await teacher.patch(`/api/folders/${u1.id}`, { parentId: d1.id });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.data.error, "A folder can't go inside itself");
  r = await teacher.patch(`/api/folders/${u1.id}`, { parentId: u1.id });
  assert.strictEqual(r.data.error, "A folder can't go inside itself");
  r = await teacher.patch(`/api/folders/${u2.id}`, { parentId: d1.id });
  assert.strictEqual(r.data.error, 'Folders can be at most 3 deep');
  r = await teacher.patch(`/api/folders/${w1.id}`, { parentId: elsewhere.id });
  assert.strictEqual(r.data.error, "That folder isn't in this class");
  // Week 1 (with Day 1 in it) into Unit 2: three levels, fits
  r = await teacher.patch(`/api/folders/${w1.id}`, { parentId: u2.id });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual([r.data.folder.parentId, r.data.folder.position, r.data.folder.name], [u2.id, 0, 'Week 1']);

  // assignments made in a folder go to its top
  r = await teacher.post(`/api/classes/${cls.id}/assignments`, { type: 'writing', title: 'Sonnet', folderId: u1.id, writing: { mode: 'open' } });
  const sonnet = r.data.assignment;
  assert.deepStrictEqual([sonnet.folderId, sonnet.position], [u1.id, 0]);
  r = await teacher.post(`/api/classes/${cls.id}/assignments`, { type: 'writing', title: 'Nope', folderId: elsewhere.id });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.data.error, "That folder isn't in this class");
  // Week 1 comes back to Unit 1, above Sonnet
  r = await teacher.patch(`/api/folders/${w1.id}`, { parentId: u1.id });
  assert.deepStrictEqual([r.data.folder.parentId, r.data.folder.position], [u1.id, -1]);
  const ode = (await teacher.post(`/api/classes/${cls.id}/assignments`, { type: 'writing', title: 'Ode', folderId: d1.id, writing: { mode: 'open' } })).data.assignment;

  // students only see folders holding something published
  r = await stu.get(`/api/classes/${cls.id}`);
  assert.deepStrictEqual(r.data.folders, [], 'empty and draft-only folders are hidden');
  assert.deepStrictEqual(r.data.assignments, []);
  await teacher.post(`/api/assignments/${ode.id}/publish`, {});
  r = await stu.get(`/api/classes/${cls.id}`);
  assert.deepStrictEqual(r.data.folders.map(f => f.name).sort(), ['Day 1', 'Unit 1', 'Week 1']);
  assert.deepStrictEqual(r.data.assignments.map(a => [a.title, a.folderId]), [['Ode', d1.id]]);
  r = await teacher.get(`/api/classes/${cls.id}`);
  assert.deepStrictEqual(r.data.folders.map(f => f.name).sort(), ['Day 1', 'Unit 1', 'Unit Two', 'Week 1']);
  assert.ok(r.data.folders.every(f => typeof f.position === 'number'));
  assert.ok(r.data.assignments.every(a => typeof a.position === 'number' && a.folderId !== undefined));

  // the breadcrumb on the assignment page
  r = await stu.get(`/api/assignments/${ode.id}`);
  assert.deepStrictEqual(r.data.folderPath, [{ id: u1.id, name: 'Unit 1' }, { id: w1.id, name: 'Week 1' }, { id: d1.id, name: 'Day 1' }]);
  r = await teacher.get(`/api/assignments/${old.id}`);
  assert.deepStrictEqual(r.data.folderPath, []);

  // moving an assignment with only { folderId }: nothing else changes
  const before = await repo.getRecord('assignment', old.id);
  r = await teacher.patch(`/api/assignments/${old.id}`, { folderId: u1.id });
  assert.strictEqual(r.status, 200);
  const moved = r.data.assignment;
  assert.deepStrictEqual([moved.folderId, moved.position], [u1.id, -2], 'the top of Unit 1');
  assert.deepStrictEqual({ ...moved, folderId: null, position: null }, { ...before, folderId: null, position: null });
  r = await teacher.patch(`/api/assignments/${old.id}`, { folderId: elsewhere.id });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.data.error, "That folder isn't in this class");
  r = await teacher.patch(`/api/assignments/${old.id}`, { folderId: u1.id, instructions: 'Still here' });
  assert.deepStrictEqual([r.data.assignment.position, r.data.assignment.instructions], [-2, 'Still here'], 'same folder: it stays where it is');
  // …and with other edits too
  r = await teacher.patch(`/api/assignments/${sonnet.id}`, { folderId: null, title: 'Sonnet 18' });
  assert.deepStrictEqual([r.data.assignment.folderId, r.data.assignment.position, r.data.assignment.title], [null, -3, 'Sonnet 18']);

  // reordering a level: exactly what's there, or 409
  let page = (await teacher.get(`/api/classes/${cls.id}`)).data;
  const top = levelOf(page, null);
  assert.deepStrictEqual(top.map(x => x.id), [sonnet.id, u2.id, u1.id]);
  const want = [top[2], top[0], top[1]];
  r = await teacher.put(`/api/classes/${cls.id}/materials/order`, { folderId: null, items: want });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.data, { ok: true });
  page = (await teacher.get(`/api/classes/${cls.id}`)).data;
  assert.deepStrictEqual(levelOf(page, null), want);
  assert.deepStrictEqual([page.folders.find(f => f.id === u1.id).position, page.assignments.find(a => a.id === sonnet.id).position, page.folders.find(f => f.id === u2.id).position], [0, 1, 2]);
  for (const items of [want.slice(1), [...want, want[0]], [...want.slice(1), want[1]], [...want, { kind: 'folder', id: w1.id }], want.map((x, i) => (i ? x : { ...x, kind: 'assignment' })), []]) {
    r = await teacher.put(`/api/classes/${cls.id}/materials/order`, { folderId: null, items });
    assert.strictEqual(r.status, 409, JSON.stringify(items));
    assert.strictEqual(r.data.error, 'The list changed while you were moving things. Reload and try again.');
  }
  r = await teacher.put(`/api/classes/${cls.id}/materials/order`, { folderId: elsewhere.id, items: [] });
  assert.strictEqual(r.status, 400);
  r = await stu.put(`/api/classes/${cls.id}/materials/order`, { folderId: null, items: want });
  assert.strictEqual(r.status, 403);
  const inU1 = levelOf(page, u1.id);
  assert.deepStrictEqual(inU1.map(x => x.id), [old.id, w1.id]);
  r = await teacher.put(`/api/classes/${cls.id}/materials/order`, { folderId: u1.id, items: [inU1[1], inU1[0]] });
  assert.strictEqual(r.status, 200);
  page = (await teacher.get(`/api/classes/${cls.id}`)).data;
  assert.deepStrictEqual(levelOf(page, u1.id).map(x => x.id), [w1.id, old.id]);

  // deleting Unit 1: Week 1 and Old essay move up, in order, where Unit 1 was
  r = await stu.del(`/api/folders/${u1.id}`);
  assert.strictEqual(r.status, 403);
  r = await teacher.del(`/api/folders/${u1.id}`);
  assert.deepStrictEqual(r.data, { ok: true });
  page = (await teacher.get(`/api/classes/${cls.id}`)).data;
  assert.deepStrictEqual(levelOf(page, null).map(x => x.id), [w1.id, old.id, sonnet.id, u2.id]);
  assert.deepStrictEqual([page.folders.find(f => f.id === w1.id).position, page.assignments.find(a => a.id === old.id).position, page.assignments.find(a => a.id === sonnet.id).position, page.folders.find(f => f.id === u2.id).position], [0, 1, 2, 3]);
  assert.strictEqual(page.folders.find(f => f.id === d1.id).parentId, w1.id, 'what was deeper stays where it was');
  assert.strictEqual(page.assignments.find(a => a.id === ode.id).folderId, d1.id);
  assert.strictEqual(page.assignments.length, 3, 'no assignment was deleted');
  assert.strictEqual(page.folders.some(f => f.id === u1.id), false);
  r = await teacher.del(`/api/folders/${u1.id}`);
  assert.strictEqual(r.status, 404);
  r = await stu.get(`/api/assignments/${ode.id}`);
  assert.deepStrictEqual(r.data.folderPath.map(p => p.name), ['Week 1', 'Day 1']);

  // duplicating: the same class keeps the folder, another class doesn't; both at the top
  r = await teacher.post(`/api/assignments/${ode.id}/duplicate`, {});
  assert.deepStrictEqual([r.data.assignment.folderId, r.data.assignment.position, r.data.assignment.publishedAt], [d1.id, -1, null]);
  r = await teacher.post(`/api/assignments/${old.id}/duplicate`, {});
  assert.deepStrictEqual([r.data.assignment.folderId, r.data.assignment.position], [null, -1]);
  r = await teacher.post(`/api/assignments/${ode.id}/duplicate`, { classId: cls2.id });
  assert.deepStrictEqual([r.data.assignment.folderId, r.data.assignment.position, r.data.assignment.classId], [null, 0, cls2.id]);
});

test('folders: at most 200 in a class', async () => {
  const teacher = client();
  await signup(teacher, 'teacher', 'Max');
  const cls = await newClass(teacher, 'Many folders');
  const t = new Date().toISOString();
  for (let i = 0; i < 199; i++) await repo.putRecord('folder', { id: `bulk-${i}`, classId: cls.id, parentId: null, name: `F${i}`, color: null, description: '', position: i, createdAt: t, updatedAt: t });
  let r = await teacher.post(`/api/classes/${cls.id}/folders`, { name: 'Number 200' });
  assert.strictEqual(r.status, 200);
  r = await teacher.post(`/api/classes/${cls.id}/folders`, { name: 'Number 201' });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.data.error, 'A class can have at most 200 folders');
});

/* ---------------- the class page ---------------- */

test('class page: the teacher gets counts per writing assignment, each student their status', async () => {
  const teacher = client(), s1 = client(), s2 = client(), s3 = client(), s4 = client();
  const me = await signup(teacher, 'teacher', 'Tara');
  const cls = await newClass(teacher, 'Writing lab');
  for (const [c, n] of [[s1, 'Ann'], [s2, 'Bo'], [s3, 'Cy'], [s4, 'Di']]) await signup(c, 'student', n, { classCode: cls.joinCode });
  const essay = (await teacher.post(`/api/classes/${cls.id}/assignments`, { type: 'writing', title: 'Essay', writing: { mode: 'open' } })).data.assignment;
  const talk = (await teacher.post(`/api/classes/${cls.id}/assignments`, { type: 'discussion', title: 'Seminar', discussion: { date: '2026-11-02T15:00:00.000Z' } })).data.assignment;
  for (const a of [essay, talk]) await teacher.post(`/api/assignments/${a.id}/publish`, {});

  // Ann is writing now, Bo has submitted, Cy's came back, Di hasn't opened it
  const docOf = async c => (await c.get(`/api/write/${essay.id}`)).data.doc;
  const ann = await docOf(s1);
  let r = await s1.post(`/api/write/${ann.id}/sessions`, { surfaceId: 'tab-1', surf: 'tab' });
  assert.strictEqual(r.status, 200);
  const bo = await docOf(s2), cy = await docOf(s3);
  await repo.updateRecord('doc', bo.id, d => { d.status = 'submitted'; d.submittedAt = new Date().toISOString(); });
  await repo.updateRecord('doc', cy.id, d => { d.status = 'returned'; d.returnedAt = new Date().toISOString(); });

  r = await teacher.get(`/api/classes/${cls.id}`);
  const byTitle = Object.fromEntries(r.data.assignments.map(a => [a.title, a]));
  assert.deepStrictEqual(byTitle.Essay.stats, { submitted: 1, returned: 1, inProgress: 1, live: 1 });
  assert.strictEqual(byTitle.Seminar.stats, null);
  assert.strictEqual(byTitle.Seminar.discussionDate, '2026-11-02T15:00:00.000Z');
  assert.strictEqual(byTitle.Essay.discussionDate, null);
  assert.deepStrictEqual([byTitle.Essay.folderId, typeof byTitle.Essay.position, byTitle.Essay.status], [null, 'number', undefined]);
  assert.strictEqual(r.data.class.toReview, 1, 'the class summary still counts');

  const statusOf = async c => Object.fromEntries((await c.get(`/api/classes/${cls.id}`)).data.assignments.map(a => [a.title, a.status]));
  assert.deepStrictEqual(await statusOf(s1), { Essay: 'in-progress', Seminar: null });
  assert.deepStrictEqual(await statusOf(s2), { Essay: 'submitted', Seminar: null });
  assert.deepStrictEqual(await statusOf(s3), { Essay: 'returned', Seminar: null });
  assert.deepStrictEqual(await statusOf(s4), { Essay: 'not-started', Seminar: null });
  r = await s1.get(`/api/classes/${cls.id}`);
  assert.ok(r.data.assignments.every(a => a.stats === undefined), 'no class counts for students');
  assert.strictEqual(r.data.class.submitted, 0);

  // the assignment page's class: colour, teacher(s), size; the join code only for the teacher
  const teacherInfo = { id: me.id, name: 'Tara Teacher' };
  const teachers = [{ id: me.id, name: 'Tara Teacher', avatarColor: null, owner: true }];
  r = await teacher.get(`/api/assignments/${essay.id}`);
  assert.deepStrictEqual(r.data.class, { id: cls.id, name: 'Writing lab', color: cls.color, background: null, archived: false, teacher: teacherInfo, teachers, isOwner: true, studentCount: 4, joinCode: cls.joinCode, joinOpen: true, canManageStaff: true, advisorCount: 0 });
  assert.deepStrictEqual(r.data.folderPath, []);
  r = await s1.get(`/api/assignments/${essay.id}`);
  assert.deepStrictEqual(r.data.class, { id: cls.id, name: 'Writing lab', color: cls.color, background: null, archived: false, teacher: teacherInfo, teachers, isOwner: false, studentCount: 4 });
  assert.deepStrictEqual(r.data.folderPath, []);
});

/* ---------------- updates ---------------- */

test('updates: post, edit, pin, delete, page back; who may', async () => {
  const teacher = client(), stu = client(), outsider = client(), loner = client();
  const me = await signup(teacher, 'teacher', 'Uma');
  const cls = await newClass(teacher, 'Civics');
  await signup(stu, 'student', 'Val', { classCode: cls.joinCode });
  await signup(outsider, 'teacher', 'Wes');
  await signup(loner, 'student', 'Xia');

  let r = await teacher.post(`/api/classes/${cls.id}/updates`, { body: '  Welcome!\r\nBring a notebook.  ' });
  assert.strictEqual(r.status, 200);
  const first = r.data.update;
  assert.deepStrictEqual(Object.keys(first).sort(), ['author', 'body', 'classId', 'createdAt', 'editedAt', 'id', 'pinned']);
  assert.deepStrictEqual([first.body, first.classId, first.pinned, first.editedAt], ['Welcome!\nBring a notebook.', cls.id, false, null]);
  assert.deepStrictEqual(first.author, { id: me.id, name: 'Uma Teacher', avatarColor: null });
  assert.ok(!JSON.stringify(r.data).includes('@'), 'no email addresses');

  r = await teacher.post(`/api/classes/${cls.id}/updates`, { body: ' \n\t ' });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.data.error, 'Write something to post');
  r = await teacher.post(`/api/classes/${cls.id}/updates`, {});
  assert.strictEqual(r.data.error, 'Write something to post');
  r = await teacher.post(`/api/classes/${cls.id}/updates`, { body: 'x'.repeat(5001) });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.data.error, 'Updates can be at most 5,000 characters');

  // students and outsiders can't post, edit or delete; outsiders can't read
  r = await stu.post(`/api/classes/${cls.id}/updates`, { body: 'hi' });
  assert.strictEqual(r.status, 403);
  r = await outsider.post(`/api/classes/${cls.id}/updates`, { body: 'hi' });
  assert.strictEqual(r.status, 403);
  r = await stu.patch(`/api/updates/${first.id}`, { body: 'edited' });
  assert.strictEqual(r.status, 403);
  r = await outsider.patch(`/api/updates/${first.id}`, { pinned: true });
  assert.strictEqual(r.status, 403);
  r = await stu.del(`/api/updates/${first.id}`);
  assert.strictEqual(r.status, 403);
  r = await outsider.del(`/api/updates/${first.id}`);
  assert.strictEqual(r.status, 403);
  r = await outsider.get(`/api/classes/${cls.id}/updates`);
  assert.strictEqual(r.status, 403);
  r = await loner.get(`/api/classes/${cls.id}/updates`);
  assert.strictEqual(r.status, 403);
  r = await stu.get(`/api/classes/${cls.id}/updates`);
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.data, { pinned: [], updates: [first], more: false });

  // more updates, two pinned (one when posted, one later)
  const posted = [first];
  for (const [i, pinned] of [[1, false], [2, true], [3, false], [4, false], [5, false]]) {
    await sleep(5);
    posted.push((await teacher.post(`/api/classes/${cls.id}/updates`, { body: `Update ${i}`, pinned })).data.update);
  }
  assert.strictEqual(posted[2].pinned, true);
  r = await teacher.patch(`/api/updates/${posted[4].id}`, { pinned: true });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual([r.data.update.pinned, r.data.update.editedAt, r.data.update.body], [true, null, 'Update 4'], 'pinning is not an edit');

  // first page: every pinned one, then the newest of the rest
  r = await stu.get(`/api/classes/${cls.id}/updates?limit=2`);
  assert.deepStrictEqual(r.data.pinned.map(u => u.body), ['Update 4', 'Update 2']);
  assert.deepStrictEqual(r.data.updates.map(u => u.body), ['Update 5', 'Update 3']);
  assert.strictEqual(r.data.more, true);
  r = await stu.get(`/api/classes/${cls.id}/updates?limit=2&before=${encodeURIComponent(r.data.updates[1].createdAt)}`);
  assert.deepStrictEqual(r.data.pinned, [], 'pinned ones only come on the first page');
  assert.deepStrictEqual(r.data.updates.map(u => u.body), ['Update 1', 'Welcome!\nBring a notebook.']);
  assert.strictEqual(r.data.more, false);
  r = await stu.get(`/api/classes/${cls.id}/updates`);
  assert.strictEqual(r.data.updates.length, 4);
  assert.strictEqual(r.data.more, false);
  r = await stu.get(`/api/classes/${cls.id}/updates?before=yesterday-ish`);
  assert.strictEqual(r.status, 400);

  // editing the text marks it edited; unpinning puts it back in the list
  r = await teacher.patch(`/api/updates/${posted[3].id}`, { body: 'Update 3, fixed\r\n' });
  assert.deepStrictEqual([r.data.update.body, typeof r.data.update.editedAt], ['Update 3, fixed', 'string']);
  r = await teacher.patch(`/api/updates/${posted[3].id}`, { body: '' });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.data.error, 'Write something to post');
  r = await teacher.patch(`/api/updates/${posted[2].id}`, { pinned: false });
  assert.strictEqual(r.data.update.pinned, false);
  r = await teacher.get(`/api/classes/${cls.id}/updates`);
  assert.deepStrictEqual(r.data.pinned.map(u => u.body), ['Update 4']);
  assert.deepStrictEqual(r.data.updates.map(u => u.body), ['Update 5', 'Update 3, fixed', 'Update 2', 'Update 1', 'Welcome!\nBring a notebook.']);

  // deleting
  r = await teacher.del(`/api/updates/${posted[5].id}`);
  assert.deepStrictEqual(r.data, { ok: true });
  r = await teacher.del(`/api/updates/${posted[5].id}`);
  assert.strictEqual(r.status, 404);
  r = await teacher.patch(`/api/updates/${posted[5].id}`, { pinned: true });
  assert.strictEqual(r.status, 404);
  r = await stu.get(`/api/classes/${cls.id}/updates`);
  assert.ok(!r.data.updates.some(u => u.id === posted[5].id));

  // nothing new in an archived class
  await teacher.patch(`/api/classes/${cls.id}`, { archived: true });
  r = await teacher.post(`/api/classes/${cls.id}/updates`, { body: 'Anyone there?' });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.data.error, 'This class is archived');
});

test('updates: one post to several classes, all or nothing', async () => {
  const teacher = client(), other = client(), stu = client();
  await signup(teacher, 'teacher', 'Yan');
  await signup(other, 'teacher', 'Zed');
  const a = await newClass(teacher, 'Period 1'), b = await newClass(teacher, 'Period 2'), old = await newClass(teacher, 'Last year');
  const theirs = await newClass(other, 'Not yours');
  await signup(stu, 'student', 'Ada', { classCode: a.joinCode });
  await teacher.patch(`/api/classes/${old.id}`, { archived: true });
  const count = async id => (await repo.listRecords('announcement', { classId: id })).length;

  let r = await teacher.post('/api/updates', { classIds: [a.id, b.id], body: 'Quiz on Friday' });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.data.updates.map(u => [u.classId, u.body]), [[a.id, 'Quiz on Friday'], [b.id, 'Quiz on Friday']]);
  assert.deepStrictEqual([await count(a.id), await count(b.id)], [1, 1]);
  r = await stu.get(`/api/classes/${a.id}/updates`);
  assert.deepStrictEqual(r.data.updates.map(u => u.body), ['Quiz on Friday']);

  r = await teacher.post('/api/updates', { classIds: [a.id, theirs.id], body: 'Sneaky' });
  assert.strictEqual(r.status, 403);
  r = await teacher.post('/api/updates', { classIds: [b.id, old.id], body: 'Sneaky' });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.data.error, 'This class is archived');
  r = await teacher.post('/api/updates', { classIds: [a.id, b.id], body: '   ' });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.data.error, 'Write something to post');
  r = await teacher.post('/api/updates', { classIds: [], body: 'Nobody' });
  assert.strictEqual(r.status, 400);
  r = await teacher.post('/api/updates', { classIds: Array(51).fill(a.id), body: 'Too many' });
  assert.strictEqual(r.status, 400);
  r = await stu.post('/api/updates', { classIds: [a.id], body: 'From a student' });
  assert.strictEqual(r.status, 403);
  assert.deepStrictEqual([await count(a.id), await count(b.id), await count(old.id), await count(theirs.id)], [1, 1, 0, 0], 'nothing was posted by the refused calls');
});

/* ---------------- recent activity ---------------- */

test('recent activity: updates and published assignments across running classes', async () => {
  const teacher = client(), stu = client(), nobody = client();
  const me = await signup(teacher, 'teacher', 'Bea');
  const A1 = await newClass(teacher, 'Biology'), B1 = await newClass(teacher, 'Chemistry'), Z = await newClass(teacher, 'Old course');
  await signup(stu, 'student', 'Cam', { classCode: A1.joinCode });
  await signup(nobody, 'student', 'Dee');
  const make = async (cls, title, publish) => {
    const a = (await teacher.post(`/api/classes/${cls.id}/assignments`, { type: 'writing', title, dueAt: '2026-12-01T12:00:00.000Z', writing: { mode: 'open' } })).data.assignment;
    if (publish) await teacher.post(`/api/assignments/${a.id}/publish`, {});
    await sleep(5);
    return a;
  };
  await make(Z, 'Gone', true);
  await teacher.post(`/api/classes/${Z.id}/updates`, { body: 'Old news' });
  await teacher.patch(`/api/classes/${Z.id}`, { archived: true });
  await sleep(5);

  const a1 = await make(A1, 'Cells', true);
  const u1 = (await teacher.post(`/api/classes/${A1.id}/updates`, { body: 'Lab coats tomorrow' })).data.update;
  await sleep(5);
  await make(B1, 'Draft only', false);
  const u2 = (await teacher.post(`/api/classes/${B1.id}/updates`, { body: 'Goggles!' })).data.update;
  await sleep(5);
  const a2 = await make(B1, 'Reactions', true);

  let r = await teacher.get('/api/activity');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.data.items.map(x => (x.kind === 'update' ? x.update.body : x.title)), ['Reactions', 'Goggles!', 'Lab coats tomorrow', 'Cells'], 'no drafts, nothing from the archived class');
  assert.strictEqual(r.data.more, false);
  const [ia2, iu2] = r.data.items;
  const publishedAt = (await repo.getRecord('assignment', a2.id)).publishedAt;
  assert.deepStrictEqual(ia2, { kind: 'assignment', at: publishedAt, assignmentId: a2.id, title: 'Reactions', type: 'writing', dueAt: '2026-12-01T12:00:00.000Z', classId: B1.id, className: 'Chemistry', color: B1.color, teacher: { id: me.id, name: 'Bea Teacher' }, key: `assignment:${a2.id}` });
  assert.deepStrictEqual(iu2, { kind: 'update', at: u2.createdAt, update: u2, classId: B1.id, className: 'Chemistry', color: B1.color, key: `update:${u2.id}` });

  // a page at a time
  r = await teacher.get('/api/activity?limit=3');
  assert.deepStrictEqual(r.data.items.map(x => x.update?.id || x.assignmentId), [a2.id, u2.id, u1.id]);
  assert.strictEqual(r.data.more, true);
  r = await teacher.get(`/api/activity?limit=3&before=${encodeURIComponent(r.data.items[2].at)}&beforeKey=${encodeURIComponent(r.data.items[2].key)}`);
  assert.deepStrictEqual(r.data.items.map(x => x.assignmentId), [a1.id]);
  assert.strictEqual(r.data.more, false);

  // a student: only their classes
  r = await stu.get('/api/activity');
  assert.deepStrictEqual(r.data.items.map(x => x.update?.id || x.assignmentId), [u1.id, a1.id]);
  r = await nobody.get('/api/activity');
  assert.deepStrictEqual(r.data, { items: [], more: false });
  r = await client().get('/api/activity');
  assert.strictEqual(r.status, 401);
});

test('paging back: items that share a time are neither lost nor repeated', async () => {
  const teacher = client(), stu = client();
  await signup(teacher, 'teacher', 'Gus');
  const list = [];
  for (let i = 0; i < 7; i++) list.push(await newClass(teacher, `Section ${i + 1}`));
  await signup(stu, 'student', 'Hal', { classCode: list[0].joinCode });
  // One post to every class: the same createdAt on all seven
  let r = await teacher.post('/api/updates', { classIds: list.map(c => c.id), body: 'Assembly at 10' });
  assert.strictEqual(new Set(r.data.updates.map(u => u.createdAt)).size, 1);
  const seen = [];
  let before = '';
  for (let page = 0; page < 10; page++) {
    r = await teacher.get(`/api/activity?limit=3${before}`);
    seen.push(...r.data.items.map(x => x.key));
    if (!r.data.more) break;
    const last = r.data.items[r.data.items.length - 1];
    before = `&before=${encodeURIComponent(last.at)}&beforeKey=${encodeURIComponent(last.key)}`;
  }
  assert.strictEqual(seen.length, 7);
  assert.strictEqual(new Set(seen).size, 7, 'each once');

  // the same on one class's Updates page (three posts in the same millisecond)
  const cls = list[0], t = new Date().toISOString();
  for (const id of ['u-a', 'u-b', 'u-c']) await repo.putRecord('announcement', { id, classId: cls.id, authorId: 'x', body: id, pinned: false, createdAt: t, updatedAt: t, editedAt: null });
  const bodies = [];
  before = '';
  for (let page = 0; page < 10; page++) {
    r = await stu.get(`/api/classes/${cls.id}/updates?limit=2${before}`);
    bodies.push(...r.data.updates.map(u => u.body));
    if (!r.data.more) break;
    const last = r.data.updates[r.data.updates.length - 1];
    before = `&before=${encodeURIComponent(last.createdAt)}&beforeKey=${encodeURIComponent(last.id)}`;
  }
  assert.deepStrictEqual(bodies.filter(b => b.startsWith('u-')).sort(), ['u-a', 'u-b', 'u-c']);
  assert.strictEqual(bodies.length, 4);
});

test('students get places among what they can see, not the stored positions', async () => {
  const teacher = client(), stu = client();
  await signup(teacher, 'teacher', 'Ivy');
  const cls = await newClass(teacher, 'Art');
  await signup(stu, 'student', 'Jo', { classCode: cls.joinCode });
  const mk = async (title, publish) => {
    const a = (await teacher.post(`/api/classes/${cls.id}/assignments`, { type: 'writing', title, writing: { mode: 'open' } })).data.assignment;
    if (publish) await teacher.post(`/api/assignments/${a.id}/publish`, {});
    return a;
  };
  const one = await mk('One', true), two = await mk('Two', false), three = await mk('Three', true);
  const hidden = (await teacher.post(`/api/classes/${cls.id}/folders`, { name: 'Drafts' })).data.folder;
  await mk('In the folder', false).then(a => teacher.patch(`/api/assignments/${a.id}`, { folderId: hidden.id }));
  let r = await teacher.put(`/api/classes/${cls.id}/materials/order`, { folderId: null, items: [{ kind: 'assignment', id: one.id }, { kind: 'folder', id: hidden.id }, { kind: 'assignment', id: two.id }, { kind: 'assignment', id: three.id }] });
  assert.strictEqual(r.status, 200);
  r = await stu.get(`/api/classes/${cls.id}`);
  assert.deepStrictEqual(r.data.folders, []);
  assert.deepStrictEqual(r.data.assignments.map(a => [a.title, a.position]), [['One', 0], ['Three', 1]]);
  r = await teacher.get(`/api/classes/${cls.id}`);
  assert.deepStrictEqual(r.data.assignments.filter(a => !a.folderId).map(a => [a.title, a.position]), [['One', 0], ['Two', 2], ['Three', 3]]);
});

test('AI sites are blocked by default, in both presets and with no settings given', async () => {
  const { PRESETS, defaultWriting } = require('../lib/assignments');
  assert.strictEqual(PRESETS['in-class'].writing.blockAiSites, true);
  assert.strictEqual(PRESETS.homework.writing.blockAiSites, true);
  assert.strictEqual(defaultWriting('open').blockAiSites, true);
  const teacher = client();
  await signup(teacher, 'teacher', 'Kit');
  const cls = await newClass(teacher, 'Debate');
  const r = await teacher.post(`/api/classes/${cls.id}/assignments`, { type: 'writing', title: 'Plain' });
  assert.strictEqual(r.data.assignment.writing.blockAiSites, true);
  assert.ok(r.data.assignment.writing.blockedSites.length > 10);
  const off = await teacher.post(`/api/classes/${cls.id}/assignments`, { type: 'writing', title: 'Off', writing: { blockAiSites: false } });
  assert.strictEqual(off.data.assignment.writing.blockAiSites, false, 'a teacher can still turn it off');
});

/* ---------------- calendar ---------------- */

test('calendar: due dates, discussions and writing windows in a range', async () => {
  const teacher = client(), stu = client();
  await signup(teacher, 'teacher', 'Eli');
  const cls = await newClass(teacher, 'History');
  await signup(stu, 'student', 'Fin', { classCode: cls.joinCode });
  const day0 = Date.parse('2026-11-01T00:00:00.000Z');
  const at = d => new Date(day0 + d * 864e5).toISOString();
  const create = async (body, publish = true) => {
    const a = (await teacher.post(`/api/classes/${cls.id}/assignments`, body)).data.assignment;
    if (publish) await teacher.post(`/api/assignments/${a.id}/publish`, {});
    return a;
  };
  const w = await create({ type: 'writing', title: 'Essay', dueAt: at(5), writing: { mode: 'open', windowStart: at(2), windowEnd: at(4) } });
  const disc = await create({ type: 'discussion', title: 'Debate', dueAt: at(40), discussion: { date: at(3) } });
  const draft = await create({ type: 'writing', title: 'Draft', dueAt: at(6), writing: { mode: 'open' } }, false);
  await create({ type: 'writing', title: 'Far off', dueAt: at(200), writing: { mode: 'open' } });
  const doc = (await stu.get(`/api/write/${w.id}`)).data.doc;
  await repo.updateRecord('doc', doc.id, d => { d.status = 'submitted'; });

  // the range: both ends, the end after the start, at most 100 days
  const q = (from, to) => `/api/calendar?${new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) })}`;
  for (const [from, to] of [[null, null], [at(0), null], [null, at(1)], ['soon', at(1)], [at(1), at(1)], [at(2), at(1)], [at(0), at(100.5)]]) {
    const r = await teacher.get(q(from, to));
    assert.strictEqual(r.status, 400, `${from} → ${to}`);
  }
  let r = await teacher.get(q(at(0), at(100)));
  assert.strictEqual(r.status, 200, '100 days is fine');

  // the teacher: drafts too, no status
  r = await teacher.get(q(at(0), at(30)));
  assert.deepStrictEqual(r.data.events.map(e => e.id), [`${w.id}:opens`, `${disc.id}:discussion`, `${w.id}:closes`, `${w.id}:due`, `${draft.id}:due`]);
  assert.deepStrictEqual(r.data.events[0], { id: `${w.id}:opens`, kind: 'opens', at: at(2), assignmentId: w.id, title: 'Essay', type: 'writing', classId: cls.id, className: 'History', color: cls.color, published: true, status: null });
  assert.deepStrictEqual(r.data.events.map(e => [e.published, e.status]), [[true, null], [true, null], [true, null], [true, null], [false, null]]);
  assert.deepStrictEqual(r.data.classes, [{ id: cls.id, name: 'History', color: cls.color, isTeacher: true }]);

  // a student: published only, with their own status on writing
  r = await stu.get(q(at(0), at(30)));
  assert.deepStrictEqual(r.data.events.map(e => [e.kind, e.title, e.status]), [['opens', 'Essay', 'submitted'], ['discussion', 'Debate', null], ['closes', 'Essay', 'submitted'], ['due', 'Essay', 'submitted']]);
  assert.deepStrictEqual(r.data.classes, [{ id: cls.id, name: 'History', color: cls.color, isTeacher: false }]);
  // from ≤ at < to
  r = await stu.get(q(at(2), at(5)));
  assert.deepStrictEqual(r.data.events.map(e => e.kind), ['opens', 'discussion', 'closes']);
  r = await stu.get(q(at(30), at(60)));
  assert.deepStrictEqual(r.data.events.map(e => e.id), [`${disc.id}:due`]);

  // archived classes drop out
  await teacher.patch(`/api/classes/${cls.id}`, { archived: true });
  r = await stu.get(q(at(0), at(30)));
  assert.deepStrictEqual(r.data, { events: [], classes: [] });
});

/* ---------------- deleting ---------------- */

test('deleting a class removes its folders and updates; a student’s data delete keeps them', async () => {
  const teacher = client(), stu = client();
  await signup(teacher, 'teacher', 'Gus');
  const cls = await newClass(teacher, 'Doomed'), keep = await newClass(teacher, 'Kept');
  const sid = (await signup(stu, 'student', 'Hal', { classCode: cls.joinCode })).id;
  for (const c of [cls, keep]) {
    const f = (await teacher.post(`/api/classes/${c.id}/folders`, { name: 'Unit' })).data.folder;
    await teacher.post(`/api/classes/${c.id}/folders`, { name: 'Week', parentId: f.id });
    await teacher.post(`/api/classes/${c.id}/assignments`, { type: 'writing', title: 'Essay', folderId: f.id, writing: { mode: 'open' } });
    await teacher.post(`/api/classes/${c.id}/updates`, { body: 'Hello', pinned: true });
  }
  const has = async (kind, id) => (await repo.listRecords(kind, { classId: id })).length;

  let r = await teacher.del(`/api/classes/${cls.id}/students/${sid}/data`);
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual([await has('folder', cls.id), await has('announcement', cls.id)], [2, 1]);

  r = await teacher.del(`/api/classes/${cls.id}`, { confirmName: 'Doomed' });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual([await has('folder', cls.id), await has('announcement', cls.id), await has('assignment', cls.id)], [0, 0, 0]);
  assert.deepStrictEqual([await has('folder', keep.id), await has('announcement', keep.id), await has('assignment', keep.id)], [2, 1, 1], 'other classes keep theirs');
});
