// Data access for local runs (embedded Postgres, or any Postgres via DATABASE_URL).
// lib/repoFirestore.js is the same interface on Firestore, used on Firebase.
//
// Three stores:
//   core       — one small JSON document: { orgs, users, projects }. The original
//                app's whole-store logic runs unchanged against it. Writes lock the
//                row, so two requests can't overwrite each other's changes.
//   resources  — one row per recording or document report (transcripts live here,
//                so they're only loaded for the project being viewed).
//   analyses   — one row per project: the latest report.
//   records    — everything Visor Classroom adds (assignments, student documents,
//                op log chunks, writing sessions, research, discussions,
//                feedback, extension tokens), one row per record, keyed by
//                kind + id, with the ids a record is looked up by as columns.

const fs = require('fs');
const path = require('path');
const { db } = require('./db');

function normalizeCore(data) {
  const s = data || {};
  s.orgs = s.orgs || {};
  s.users = s.users || {};
  s.projects = s.projects || {};
  s.classes = s.classes || {};
  return s;
}

async function readCore() {
  const d = await db();
  const rows = await d.query('SELECT data FROM visor_core WHERE id = 1');
  return normalizeCore(rows[0]?.data);
}

// Read-modify-write the core document under a row lock.
async function withCore(fn) {
  const d = await db();
  return d.tx(async q => {
    const rows = await q('SELECT data FROM visor_core WHERE id = 1 FOR UPDATE');
    const core = normalizeCore(rows[0]?.data);
    const out = await fn(core);
    await q('UPDATE visor_core SET data = $1::jsonb WHERE id = 1', [JSON.stringify(core)]);
    return out;
  });
}

// ---- resources ----

async function listResources(projectId) {
  const d = await db();
  const rows = await d.query('SELECT data FROM visor_resources WHERE project_id = $1 ORDER BY uploaded_at DESC', [projectId]);
  return rows.map(r => r.data);
}

// { projectId: number of resources } for the given projects
async function countResources(projectIds) {
  if (!projectIds.length) return {};
  const d = await db();
  const rows = await d.query('SELECT project_id, COUNT(*)::int AS n FROM visor_resources WHERE project_id = ANY($1) GROUP BY project_id', [projectIds]);
  return Object.fromEntries(rows.map(r => [r.project_id, r.n]));
}

async function getResource(id) {
  const d = await db();
  const rows = await d.query('SELECT data FROM visor_resources WHERE id = $1', [id]);
  return rows[0]?.data || null;
}

async function putResource(r) {
  const d = await db();
  await d.query(
    `INSERT INTO visor_resources (id, project_id, uploaded_at, data) VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (id) DO UPDATE SET project_id = EXCLUDED.project_id, uploaded_at = EXCLUDED.uploaded_at, data = EXCLUDED.data`,
    [r.id, r.projectId, r.uploadedAt, JSON.stringify(r)]
  );
  return r;
}

// Read-modify-write one resource under a row lock (transcription and the
// "who is this?" answers can land at the same moment).
async function updateResource(id, fn) {
  const d = await db();
  return d.tx(async q => {
    const rows = await q('SELECT data FROM visor_resources WHERE id = $1 FOR UPDATE', [id]);
    const r = rows[0]?.data;
    if (!r) return null;
    const out = await fn(r);
    await q('UPDATE visor_resources SET data = $1::jsonb, uploaded_at = $2 WHERE id = $3', [JSON.stringify(r), r.uploadedAt, id]);
    return out === undefined ? r : out;
  });
}

async function deleteResource(id) {
  const d = await db();
  await d.query('DELETE FROM visor_resources WHERE id = $1', [id]);
}

async function deleteProjectData(projectId) {
  const d = await db();
  await d.query('DELETE FROM visor_resources WHERE project_id = $1', [projectId]);
  await d.query('DELETE FROM visor_analyses WHERE project_id = $1', [projectId]);
}

// ---- analyses ----

async function getAnalysis(projectId) {
  const d = await db();
  const rows = await d.query('SELECT data FROM visor_analyses WHERE project_id = $1', [projectId]);
  return rows[0]?.data || null;
}

async function putAnalysis(projectId, analysis) {
  const d = await db();
  await d.query(
    `INSERT INTO visor_analyses (project_id, data) VALUES ($1, $2::jsonb)
     ON CONFLICT (project_id) DO UPDATE SET data = EXCLUDED.data`,
    [projectId, JSON.stringify(analysis)]
  );
}

// ---- generic records ----
// The fields a record can be looked up by. Each is a column, so listRecords
// never has to open the JSON to filter.
const RECORD_KEYS = { classId: 'class_id', assignmentId: 'assignment_id', studentId: 'student_id', docId: 'doc_id', sessionId: 'session_id', projectId: 'project_id' };
const recordCols = obj => Object.keys(RECORD_KEYS).map(k => (obj[k] == null ? null : String(obj[k])));

function whereSql(kind, where = {}, opts = {}) {
  const parts = ['kind = $1'], params = [kind];
  for (const [k, v] of Object.entries(where || {})) {
    if (!RECORD_KEYS[k]) throw new Error(`records can't be filtered by ${k}`);
    if (v === undefined) continue;
    params.push(String(v));
    parts.push(`${RECORD_KEYS[k]} = $${params.length}`);
  }
  if (opts.updatedBefore) { params.push(String(opts.updatedBefore)); parts.push(`updated_at < $${params.length}`); }
  return { sql: parts.join(' AND '), params };
}

async function putRecordWith(q, kind, obj) {
  if (!obj || !obj.id) throw new Error('a record needs an id');
  const updatedAt = obj.updatedAt || new Date().toISOString();
  await q(
    `INSERT INTO visor_records (kind, id, class_id, assignment_id, student_id, doc_id, session_id, project_id, updated_at, data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
     ON CONFLICT (kind, id) DO UPDATE SET class_id = EXCLUDED.class_id, assignment_id = EXCLUDED.assignment_id, student_id = EXCLUDED.student_id,
       doc_id = EXCLUDED.doc_id, session_id = EXCLUDED.session_id, project_id = EXCLUDED.project_id, updated_at = EXCLUDED.updated_at, data = EXCLUDED.data`,
    [kind, String(obj.id), ...recordCols(obj), updatedAt, JSON.stringify(obj)]
  );
  return obj;
}

async function putRecord(kind, obj) {
  const d = await db();
  return putRecordWith((sql, params) => d.query(sql, params), kind, obj);
}

async function getRecord(kind, id) {
  const d = await db();
  const rows = await d.query('SELECT data FROM visor_records WHERE kind = $1 AND id = $2', [kind, String(id)]);
  return rows[0]?.data || null;
}

// Read-modify-write one record under a row lock. fn changes the record in
// place; the result is fn's return value, or the record if fn returns nothing.
// Returns null (and doesn't call fn) when the record doesn't exist.
async function updateRecord(kind, id, fn) {
  return withRecords(async t => {
    const r = await t.get(kind, id);
    if (!r) return null;
    const out = await fn(r);
    t.put(kind, r);
    return out === undefined ? r : out;
  });
}

// Several records changed together, all or nothing (a student document and the
// op chunk its new edits go into). fn gets { get(kind, id), put(kind, obj),
// del(kind, id) }; reads lock their rows, writes apply when fn finishes.
async function withRecords(fn) {
  const d = await db();
  return d.tx(async q => {
    const writes = [];
    const t = {
      async get(kind, id) {
        const rows = await q('SELECT data FROM visor_records WHERE kind = $1 AND id = $2 FOR UPDATE', [kind, String(id)]);
        return rows[0]?.data || null;
      },
      put(kind, obj) { writes.push(['put', kind, obj]); },
      del(kind, id) { writes.push(['del', kind, id]); }
    };
    const out = await fn(t);
    for (const [op, kind, x] of writes) {
      if (op === 'put') await putRecordWith(q, kind, x);
      else await q('DELETE FROM visor_records WHERE kind = $1 AND id = $2', [kind, String(x)]);
    }
    return out;
  });
}

// where: { classId?, assignmentId?, studentId?, docId?, sessionId?, projectId? },
// all must match. opts.updatedBefore keeps records last changed before that time.
// Sorted by id, so zero-padded chunk ids come back in order.
async function listRecords(kind, where = {}, opts = {}) {
  const d = await db();
  const { sql, params } = whereSql(kind, where, opts);
  const rows = await d.query(`SELECT data FROM visor_records WHERE ${sql} ORDER BY id`, params);
  return rows.map(r => r.data);
}

async function deleteRecord(kind, id) {
  const d = await db();
  await d.query('DELETE FROM visor_records WHERE kind = $1 AND id = $2', [kind, String(id)]);
}

async function deleteRecords(kind, where = {}, opts = {}) {
  if (!Object.values(where || {}).some(v => v != null) && !opts.updatedBefore) throw new Error('deleteRecords needs a filter');
  const d = await db();
  const { sql, params } = whereSql(kind, where, opts);
  const rows = await d.query(`DELETE FROM visor_records WHERE ${sql} RETURNING id`, params);
  return rows.length;
}

// ---- one-time import of the old data/store.json (local copies only) ----
// The previous version kept everything in data/store.json. If this database
// is brand new and that file exists, bring its accounts, projects, resources
// and reports across so nothing is lost when upgrading.
async function importLegacyStoreIfEmpty(storePath) {
  if (!fs.existsSync(storePath)) return false;
  const core = await readCore();
  if (Object.keys(core.users).length || Object.keys(core.projects).length) return false;
  let legacy;
  try { legacy = JSON.parse(fs.readFileSync(storePath, 'utf8')); } catch { return false; }
  const projects = legacy.projects || {};
  await withCore(c => {
    c.orgs = legacy.orgs || {};
    c.users = legacy.users || {};
    c.projects = {};
    for (const [id, p] of Object.entries(projects)) {
      const { lastAnalysis, ...rest } = p;
      c.projects[id] = { ...rest, lastAnalyzedAt: lastAnalysis?.at || null };
    }
  });
  for (const r of Object.values(legacy.resources || {})) {
    if (r.type === 'audio' && r.audio && !r.audio.storage) r.audio.storage = 'local';
    await putResource(r);
  }
  for (const [id, p] of Object.entries(projects)) if (p.lastAnalysis) await putAnalysis(id, p.lastAnalysis);
  console.log(`  ✓ Imported ${Object.keys(legacy.users || {}).length} accounts and ${Object.keys(projects).length} projects from ${path.basename(storePath)}`);
  return true;
}

module.exports = {
  kind: 'sql',
  readCore, withCore,
  listResources, countResources, getResource, putResource, updateResource, deleteResource, deleteProjectData,
  getAnalysis, putAnalysis,
  putRecord, getRecord, updateRecord, withRecords, listRecords, deleteRecord, deleteRecords,
  importLegacyStoreIfEmpty
};
