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

const fs = require('fs');
const path = require('path');
const { db } = require('./db');

function normalizeCore(data) {
  const s = data || {};
  s.orgs = s.orgs || {};
  s.users = s.users || {};
  s.projects = s.projects || {};
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
  importLegacyStoreIfEmpty
};
