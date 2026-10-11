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

// The old data/store.json import only applies to copies run on a computer.
async function importLegacyStoreIfEmpty() { return false; }

module.exports = {
  kind: 'firestore',
  readCore, withCore,
  listResources, countResources, getResource, putResource, updateResource, deleteResource, deleteProjectData,
  getAnalysis, putAnalysis,
  importLegacyStoreIfEmpty
};
