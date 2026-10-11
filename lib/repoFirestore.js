// Data access on Firebase (Firestore). Same interface as lib/repoSql.js.
//
//   visor/core               — one document: { orgs, users, projects }, stored
//                              gzipped. Every change runs in a transaction, so two
//                              requests can't overwrite each other's changes.
//   visor_resources/{id}     — one per recording or document report, gzipped.
//                              Very large reports (over ~900 KB compressed) are
//                              kept in Cloud Storage instead, because a Firestore
//                              document can hold at most 1 MB.
//   visor_analyses/{project} — the latest report for each project.
//   visor_rec_{kind}/{id}    — Visor Classroom records (assignments, student
//                              documents, op chunks, sessions, research,
//                              discussions, feedback, extension tokens),
//                              gzipped like resources, with the ids they're
//                              looked up by as plain fields. Big ones overflow
//                              to data/records/{kind}/{id}.json.gz in Storage.
//
// Only the server reads or writes these (firestore.rules blocks everyone else).

const zlib = require('zlib');
const { firestore, bucket } = require('./firebaseAdmin');

const INLINE_LIMIT = 900 * 1024;

const pack = obj => zlib.gzipSync(Buffer.from(JSON.stringify(obj)));
const unpack = buf => JSON.parse(zlib.gunzipSync(Buffer.from(buf)).toString('utf8'));

function normalizeCore(data) {
  const s = data || {};
  s.orgs = s.orgs || {};
  s.users = s.users || {};
  s.projects = s.projects || {};
  s.classes = s.classes || {};
  return s;
}

const coreRef = () => firestore().collection('visor').doc('core');
const resRef = id => firestore().collection('visor_resources').doc(id);
const analysisRef = projectId => firestore().collection('visor_analyses').doc(projectId);
const externalFile = id => bucket().file(`data/resources/${id}.json.gz`);

async function readCore() {
  const snap = await coreRef().get();
  return normalizeCore(snap.exists ? unpack(snap.get('gz')) : null);
}

// Read-modify-write the core document. Firestore may run fn again if another
// request changed the document at the same moment, so fn only changes `core`.
// Extra attempts let a whole class sign up at once without errors.
async function withCore(fn) {
  return firestore().runTransaction(async t => {
    const snap = await t.get(coreRef());
    const core = normalizeCore(snap.exists ? unpack(snap.get('gz')) : null);
    const out = await fn(core);
    const gz = pack(core);
    if (gz.length > 1000 * 1024) throw new Error('The account list has grown past what one Firestore document can hold.');
    t.set(coreRef(), { gz, updatedAt: new Date().toISOString() });
    return out;
  }, { maxAttempts: 15 });
}

// ---- resources ----

async function decodeResource(snap) {
  if (!snap.exists) return null;
  if (snap.get('external')) {
    const [buf] = await externalFile(snap.id).download();
    return unpack(buf);
  }
  return unpack(snap.get('gz'));
}

// Returns the fields to store for r (and writes the big copy to Storage if needed)
async function encodeResource(r) {
  const gz = pack(r);
  const meta = { projectId: r.projectId, uploadedAt: r.uploadedAt, type: r.type };
  if (gz.length <= INLINE_LIMIT) return { ...meta, gz, external: false };
  await externalFile(r.id).save(gz, { contentType: 'application/gzip', resumable: false });
  return { ...meta, external: true };
}

async function listResources(projectId) {
  const snaps = await firestore().collection('visor_resources').where('projectId', '==', projectId).get();
  const list = await Promise.all(snaps.docs.map(decodeResource));
  return list.filter(Boolean).sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1));
}

async function countResources(projectIds) {
  const col = firestore().collection('visor_resources');
  const pairs = await Promise.all(projectIds.map(async id => [id, (await col.where('projectId', '==', id).count().get()).data().count]));
  return Object.fromEntries(pairs);
}

async function getResource(id) {
  return decodeResource(await resRef(id).get());
}

async function putResource(r) {
  await resRef(r.id).set(await encodeResource(r));
  return r;
}

// Read-modify-write one resource in a transaction (transcription and the
// "who is this?" answers can land at the same moment).
async function updateResource(id, fn) {
  let wasExternal = false, nowExternal = false;
  const result = await firestore().runTransaction(async t => {
    const snap = await t.get(resRef(id));
    const r = await decodeResource(snap);
    if (!r) return null;
    const out = await fn(r);
    const fields = await encodeResource(r);
    wasExternal = !!snap.get('external'); nowExternal = fields.external;
    t.set(resRef(id), fields);
    return out === undefined ? r : out;
  }, { maxAttempts: 10 });
  // It shrank back under the limit: the big copy in Storage is no longer needed.
  if (wasExternal && !nowExternal) await externalFile(id).delete({ ignoreNotFound: true }).catch(() => {});
  return result;
}

async function deleteResource(id) {
  const snap = await resRef(id).get();
  if (snap.exists && snap.get('external')) await externalFile(id).delete({ ignoreNotFound: true });
  await resRef(id).delete();
}

async function deleteProjectData(projectId) {
  const snaps = await firestore().collection('visor_resources').where('projectId', '==', projectId).get();
  for (const d of snaps.docs) {
    if (d.get('external')) await externalFile(d.id).delete({ ignoreNotFound: true });
  }
  for (let i = 0; i < snaps.docs.length; i += 400) {
    const batch = firestore().batch();
    snaps.docs.slice(i, i + 400).forEach(d => batch.delete(d.ref));
    await batch.commit();
  }
  await analysisRef(projectId).delete();
}

// ---- analyses ----

async function getAnalysis(projectId) {
  const snap = await analysisRef(projectId).get();
  return snap.exists ? unpack(snap.get('gz')) : null;
}

async function putAnalysis(projectId, analysis) {
  await analysisRef(projectId).set({ gz: pack(analysis), updatedAt: new Date().toISOString() });
}

// ---- generic records ----

const RECORD_KEYS = ['classId', 'assignmentId', 'studentId', 'docId', 'sessionId', 'projectId'];
const recCol = kind => firestore().collection(`visor_rec_${kind}`);
const recRef = (kind, id) => recCol(kind).doc(String(id));
const recFile = (kind, id) => bucket().file(`data/records/${kind}/${id}.json.gz`);

async function decodeRecord(kind, snap) {
  if (!snap.exists) return null;
  if (snap.get('external')) {
    const [buf] = await recFile(kind, snap.id).download();
    return unpack(buf);
  }
  return unpack(snap.get('gz'));
}

// The fields stored for a record: its lookup ids (so queries can filter on
// them) plus the gzipped body, or a pointer to the Storage copy if it's big.
async function encodeRecord(kind, obj) {
  const gz = pack(obj);
  const meta = { updatedAt: obj.updatedAt || new Date().toISOString() };
  for (const k of RECORD_KEYS) meta[k] = obj[k] == null ? null : String(obj[k]);
  if (gz.length <= INLINE_LIMIT) return { ...meta, gz, external: false };
  await recFile(kind, obj.id).save(gz, { contentType: 'application/gzip', resumable: false });
  return { ...meta, external: true };
}

async function putRecord(kind, obj) {
  if (!obj || !obj.id) throw new Error('a record needs an id');
  const before = await recRef(kind, obj.id).get();
  const fields = await encodeRecord(kind, obj);
  await recRef(kind, obj.id).set(fields);
  if (before.exists && before.get('external') && !fields.external) await recFile(kind, obj.id).delete({ ignoreNotFound: true }).catch(() => {});
  return obj;
}

async function getRecord(kind, id) {
  return decodeRecord(kind, await recRef(kind, id).get());
}

// Several records changed together in one transaction. fn gets
// { get(kind, id), put(kind, obj), del(kind, id) }. Firestore wants every read
// before any write, so puts and deletes are held until fn finishes. Firestore
// may run fn again if a record changed meanwhile, so fn only changes the
// records it was given.
async function withRecords(fn) {
  const shrunk = [];
  const out = await firestore().runTransaction(async tx => {
    shrunk.length = 0;
    const writes = [];
    const seen = new Map();
    const t = {
      async get(kind, id) {
        const snap = await tx.get(recRef(kind, id));
        seen.set(`${kind}/${id}`, !!(snap.exists && snap.get('external')));
        return decodeRecord(kind, snap);
      },
      put(kind, obj) { writes.push(['put', kind, obj]); },
      del(kind, id) { writes.push(['del', kind, id]); }
    };
    const result = await fn(t);
    for (const [op, kind, x] of writes) {
      if (op === 'put') {
        const fields = await encodeRecord(kind, x);
        if (seen.get(`${kind}/${x.id}`) && !fields.external) shrunk.push([kind, x.id]);
        tx.set(recRef(kind, x.id), fields);
      } else {
        tx.delete(recRef(kind, x));
      }
    }
    return result;
  }, { maxAttempts: 10 });
  for (const [kind, id] of shrunk) await recFile(kind, id).delete({ ignoreNotFound: true }).catch(() => {});
  return out;
}

async function updateRecord(kind, id, fn) {
  return withRecords(async t => {
    const r = await t.get(kind, id);
    if (!r) return null;
    const out = await fn(r);
    t.put(kind, r);
    return out === undefined ? r : out;
  });
}

function recordQuery(kind, where = {}, opts = {}) {
  let q = recCol(kind);
  for (const [k, v] of Object.entries(where || {})) {
    if (!RECORD_KEYS.includes(k)) throw new Error(`records can't be filtered by ${k}`);
    if (v === undefined) continue;
    q = q.where(k, '==', String(v));
  }
  if (opts.updatedBefore) q = q.where('updatedAt', '<', String(opts.updatedBefore));
  return q;
}

// Equality filters only (plus an optional updatedBefore); sorted here by id so
// no composite index is needed for the order.
async function listRecords(kind, where = {}, opts = {}) {
  const snaps = await recordQuery(kind, where, opts).get();
  const list = await Promise.all(snaps.docs.map(d => decodeRecord(kind, d)));
  return list.filter(Boolean).sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
}

async function deleteRecord(kind, id) {
  const snap = await recRef(kind, id).get();
  if (snap.exists && snap.get('external')) await recFile(kind, id).delete({ ignoreNotFound: true }).catch(() => {});
  await recRef(kind, id).delete();
}

async function deleteRecords(kind, where = {}, opts = {}) {
  if (!Object.values(where || {}).some(v => v != null) && !opts.updatedBefore) throw new Error('deleteRecords needs a filter');
  const snaps = await recordQuery(kind, where, opts).get();
  for (const d of snaps.docs) if (d.get('external')) await recFile(kind, d.id).delete({ ignoreNotFound: true }).catch(() => {});
  for (let i = 0; i < snaps.docs.length; i += 400) {
    const batch = firestore().batch();
    snaps.docs.slice(i, i + 400).forEach(d => batch.delete(d.ref));
    await batch.commit();
  }
  return snaps.docs.length;
}

// The old data/store.json import only applies to copies run on a computer.
async function importLegacyStoreIfEmpty() { return false; }

module.exports = {
  kind: 'firestore',
  readCore, withCore,
  listResources, countResources, getResource, putResource, updateResource, deleteResource, deleteProjectData,
  getAnalysis, putAnalysis,
  putRecord, getRecord, updateRecord, withRecords, listRecords, deleteRecord, deleteRecords,
  importLegacyStoreIfEmpty
};
