// Class materials: the folders on a class page and the order of everything in
// them. Folders are generic records (kind "folder", keyed by classId);
// assignments say which folder they're in (folderId, null = the top of the
// class). The folders and assignments in one place make up a "level" and share
// one ordering.
//
// Everything here is pure: server.js SECTION 11 reads the records, calls these,
// and saves the result.

const crypto = require('crypto');
const { COURSE_COLORS } = require('./classes');

const MAX_FOLDERS = 200;
const MAX_DEPTH = 3;
const NAME_MAX = 120;
const DESCRIPTION_MAX = 1000;
const KINDS = ['folder', 'assignment'];

class MaterialsError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const now = () => new Date().toISOString();
const has = (obj, k) => obj != null && Object.prototype.hasOwnProperty.call(obj, k);
// null, undefined and '' all mean "the top of the class"
const levelId = v => (v === undefined || v === null || v === '' ? null : String(v));
const byIdOf = folders => new Map(folders.map(f => [f.id, f]));

// Where an item sits in its level. Items never put in order fall back to their
// age, newest first (the order class pages had before folders).
function effectivePosition(item) {
  if (Number.isFinite(item?.position)) return item.position;
  const t = Date.parse(item?.createdAt);
  return Number.isFinite(t) ? -t / 1000 : 0;
}

// A level in display order: position, then newer first, then id.
function sortLevel(items) {
  const made = x => Date.parse(x.createdAt) || 0;
  return [...items].sort((a, b) => effectivePosition(a) - effectivePosition(b) || made(b) - made(a)
    || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
}

// The position that puts an item at the top of a level: one less than the
// first item there, or 0 for an empty level. `self` ({ kind, id }) is left
// out, so an item already in the level can still go to its top.
function topPosition(items, self = null) {
  const others = items.filter(x => !(self && x.kind === self.kind && x.id === self.id));
  return others.length ? Math.min(...others.map(effectivePosition)) - 1 : 0;
}

// One level of a class: the folders whose parent is folderId and the
// assignments in folderId (null = the top). Each comes back as
// { kind, id, position, createdAt }, in display order.
function levelItems(folders, assignments, folderId = null) {
  const at = levelId(folderId);
  const item = (kind, x) => ({ kind, id: x.id, position: x.position, createdAt: x.createdAt });
  return sortLevel([
    ...folders.filter(f => levelId(f.parentId) === at).map(f => item('folder', f)),
    ...assignments.filter(a => levelId(a.folderId) === at).map(a => item('assignment', a))
  ]);
}

// Records as stored can point at a folder that's gone (deleted while something
// was moved into it), and two moves at once could loop folders into each
// other. Those go to the top of the class, so everything always has a place a
// teacher can see. Returns copies with parentId / folderId set to a real
// folder or null.
function tidy(folders, assignments) {
  const byId = new Map(folders.map(f => [f.id, { ...f, parentId: levelId(f.parentId) }]));
  for (const f of byId.values()) {
    const seen = new Set([f.id]);
    for (let cur = f; cur.parentId;) {
      const next = byId.get(cur.parentId);
      if (!next || seen.has(next.id)) { cur.parentId = null; break; }
      seen.add(next.id);
      cur = next;
    }
  }
  return {
    folders: [...byId.values()],
    assignments: assignments.map(a => ({ ...a, folderId: byId.has(levelId(a.folderId)) ? levelId(a.folderId) : null }))
  };
}

// How deep a folder is: 1 at the top of the class, 2 inside a top folder, and
// so on. The top of the class itself (null) is 0.
function depthOf(folders, id) {
  const byId = byIdOf(folders);
  let depth = 0;
  for (let f = byId.get(levelId(id)); f && depth <= folders.length; f = byId.get(levelId(f.parentId))) depth++;
  return depth;
}

// How many levels of folders a folder makes, counting itself (1 when it has
// no folders inside).
function heightOf(folders, id) {
  const seen = new Set();
  let height = 0;
  for (let level = new Set([levelId(id)]); level.size;) {
    height++;
    level.forEach(x => seen.add(x));
    level = new Set(folders.filter(f => level.has(levelId(f.parentId)) && !seen.has(f.id)).map(f => f.id));
  }
  return height;
}

// True when folder `id` is `ancestorId` itself or somewhere inside it.
function isInside(folders, id, ancestorId) {
  const byId = byIdOf(folders);
  const seen = new Set();
  for (let cur = levelId(id); cur && !seen.has(cur); cur = levelId(byId.get(cur)?.parentId)) {
    if (cur === ancestorId) return true;
    seen.add(cur);
  }
  return false;
}

// A folder id sent by the page: null for the top, or one of this class's
// folders (anything else is refused).
function folderInClass(folders, id) {
  const at = levelId(id);
  if (at && !folders.some(f => f.id === at)) throw new MaterialsError(400, "That folder isn't in this class");
  return at;
}

// Can a folder go into parentId (null = the top)? movingId is the folder being
// moved (with everything in it); leave it out for a new folder. Returns the
// parent id, or throws the reason it can't.
function checkPlace(folders, parentId, movingId = null) {
  const at = folderInClass(folders, parentId);
  if (at && movingId && isInside(folders, at, movingId)) throw new MaterialsError(400, "A folder can't go inside itself");
  const height = movingId ? heightOf(folders, movingId) : 1;
  if (depthOf(folders, at) + height > MAX_DEPTH) throw new MaterialsError(400, `Folders can be at most ${MAX_DEPTH} deep`);
  return at;
}

// A folder's name, colour and description from the form. With `current` (an
// edit) fields that weren't sent are left out; without it (a new folder)
// they get their defaults. Returns only the fields to set.
function cleanFolderInput(body = {}, current = null) {
  const out = {};
  if (!current || has(body, 'name')) {
    const name = typeof body?.name === 'string' ? body.name.trim().replace(/\s+/g, ' ').slice(0, NAME_MAX) : '';
    if (!name) throw new MaterialsError(400, 'Give the folder a name');
    out.name = name;
  }
  if (has(body, 'color')) {
    if (body.color !== null && !COURSE_COLORS.includes(body.color)) throw new MaterialsError(400, 'Pick one of the course colors');
    out.color = body.color;
  } else if (!current) out.color = null;
  if (has(body, 'description')) {
    if (body.description !== null && typeof body.description !== 'string') throw new MaterialsError(400, 'The folder description must be text');
    const d = (body.description || '').replace(/\r\n?/g, '\n').trim();
    if (d.length > DESCRIPTION_MAX) throw new MaterialsError(400, 'Folder descriptions can be at most 1,000 characters');
    out.description = d;
  } else if (!current) out.description = '';
  return out;
}

function newFolder(classId, body, { parentId = null, position = 0 } = {}) {
  const t = now();
  return { id: crypto.randomUUID(), classId, parentId: levelId(parentId), ...cleanFolderInput(body), position, createdAt: t, updatedAt: t };
}

// The folders a student sees: those holding at least one published
// assignment, directly or in a folder inside them.
function studentVisibleFolders(folders, assignments) {
  const byId = byIdOf(folders);
  const show = new Set();
  for (const a of assignments) {
    if (!a.publishedAt) continue;
    for (let id = levelId(a.folderId); id && byId.has(id) && !show.has(id); id = levelId(byId.get(id).parentId)) show.add(id);
  }
  return folders.filter(f => show.has(f.id));
}

// The folders above something in folderId, top first: [{ id, name }, …]
// ([] at the top of the class).
function folderPath(folders, folderId) {
  const byId = byIdOf(folders);
  const path = [];
  for (let id = levelId(folderId); id && byId.has(id) && !path.some(p => p.id === id); id = levelId(byId.get(id).parentId)) {
    path.unshift({ id, name: byId.get(id).name });
  }
  return path;
}

// Deleting a folder never deletes what's in it: its subfolders and
// assignments move up into the folder's own level, in their order, where the
// folder was. Returns that level's new order as [{ kind, id }].
function levelAfterDelete(folders, assignments, folderId) {
  const folder = folders.find(f => f.id === folderId);
  const inside = levelItems(folders, assignments, folderId);
  const out = [];
  for (const x of levelItems(folders, assignments, folder?.parentId)) {
    if (x.kind === 'folder' && x.id === folderId) out.push(...inside);
    else out.push(x);
  }
  return out.map(({ kind, id }) => ({ kind, id }));
}

// Is `items` exactly what's in the level now: the same kinds and ids, each once?
function sameItems(level, items) {
  if (!Array.isArray(items) || items.length !== level.length) return false;
  const key = x => (x && KINDS.includes(x.kind) ? `${x.kind}:${x.id}` : null);
  const want = new Set(level.map(key));
  const got = new Set(items.map(key));
  return got.size === items.length && [...got].every(k => k && want.has(k));
}

module.exports = {
  MaterialsError, MAX_FOLDERS, MAX_DEPTH, NAME_MAX, DESCRIPTION_MAX, KINDS,
  levelId, effectivePosition, sortLevel, topPosition, levelItems, tidy, depthOf, heightOf, isInside,
  folderInClass, checkPlace, cleanFolderInput, newFolder, studentVisibleFolders, folderPath, levelAfterDelete, sameItems
};
