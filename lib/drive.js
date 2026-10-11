// Google Drive: read one picked file's saved revisions and diff them.
//
// The browser gets a short-lived drive.file access token from Google (Google
// Identity Services) and the user picks a file in the Google Picker. That pick
// is what grants access to that one file. The token is sent here for this one
// request and is never stored.

const { diffChars, diffWords } = require('diff');

const DRIVE = process.env.DRIVE_API_BASE || 'https://www.googleapis.com/drive/v3'; // override only for tests
const SUPPORTED = new Set(['application/vnd.google-apps.document', 'application/vnd.google-apps.presentation']);
const MAX_REVISIONS = 120;   // read at most this many snapshots, spread evenly (first and last always included)
const CONCURRENCY = 6;
const LARGE_DOC_CHARS = 120_000;

class DriveError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function driveJSON(url, token) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.message || `Google Drive request failed (${res.status})`;
    if (res.status === 401) throw new DriveError('Your Google access expired. Choose the file again.', 401);
    if (res.status === 404) throw new DriveError("Google Drive says this file doesn't exist or wasn't shared with Visor. Pick it again in the file chooser.", 404);
    if (res.status === 403) throw new DriveError(`Google refused: ${msg}. You need edit access to see a file's revision history.`, 403);
    throw new DriveError(msg, 502);
  }
  return body;
}

async function listRevisions(fileId, token) {
  const out = [];
  let pageToken;
  do {
    const u = new URL(`${DRIVE}/files/${encodeURIComponent(fileId)}/revisions`);
    u.searchParams.set('fields', 'nextPageToken,revisions(id,modifiedTime,lastModifyingUser(displayName,emailAddress),exportLinks)');
    u.searchParams.set('pageSize', '1000');
    if (pageToken) u.searchParams.set('pageToken', pageToken);
    const body = await driveJSON(u.toString(), token);
    out.push(...(body.revisions || []));
    pageToken = body.nextPageToken;
  } while (pageToken);
  return out.sort((a, b) => new Date(a.modifiedTime) - new Date(b.modifiedTime));
}

async function revisionText(rev, token) {
  const link = rev.exportLinks?.['text/plain'];
  if (!link) return null;
  const res = await fetch(link, { headers: { Authorization: `Bearer ${token}` } });
  return res.ok ? res.text() : null;
}

function sample(list, max) {
  if (list.length <= max) return list;
  const step = (list.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => list[Math.round(i * step)]);
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

function diffCounts(prev, curr) {
  const parts = prev.length + curr.length > LARGE_DOC_CHARS ? diffWords(prev, curr) : diffChars(prev, curr);
  let added = 0, removed = 0;
  for (const p of parts) { if (p.added) added += p.value.length; else if (p.removed) removed += p.value.length; }
  return { added, removed };
}

// Credit each change between two snapshots to whoever saved the later one.
function buildAuthorship(revisions, texts) {
  const steps = [];
  const byKey = new Map();
  let prev = '';
  let skippedNoText = 0;
  for (const rev of revisions) {
    const name = rev.lastModifyingUser?.displayName || 'Unknown contributor';
    const email = rev.lastModifyingUser?.emailAddress || null;
    const text = texts.get(rev.id);
    if (text == null) { skippedNoText++; steps.push({ time: rev.modifiedTime, name, textUnavailable: true, docLength: prev.length }); continue; }
    const { added, removed } = diffCounts(prev, text);
    steps.push({ time: rev.modifiedTime, name, charsAdded: added, charsRemoved: removed, docLength: text.length });
    const key = email || `name:${name}`;
    const c = byKey.get(key) || { name, email, charsAdded: 0, charsRemoved: 0, revisions: 0 };
    c.charsAdded += added; c.charsRemoved += removed; c.revisions += 1;
    byKey.set(key, c);
    prev = text;
  }
  return { steps, contributors: [...byKey.values()].sort((a, b) => b.charsAdded - a.charsAdded), skippedNoText };
}

async function analyzeDriveFile(fileId, token) {
  const file = await driveJSON(`${DRIVE}/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,webViewLink`, token);
  if (!SUPPORTED.has(file.mimeType)) throw new DriveError('Only Google Docs and Google Slides files can be analyzed.', 400);
  const all = await listRevisions(fileId, token);
  if (!all.length) throw new DriveError('Google Drive has no revision history saved for this file.', 400);
  const picked = sample(all, MAX_REVISIONS);
  const texts = new Map();
  await mapLimit(picked, CONCURRENCY, async rev => texts.set(rev.id, await revisionText(rev, token)));
  const auth = buildAuthorship(picked, texts);
  if (!auth.contributors.length) throw new DriveError("Google Drive didn't provide the text of this file's revisions, so there was nothing to compare.", 400);
  return {
    file,
    result: { ...auth, totalRevisions: all.length, analyzedRevisions: picked.length - auth.skippedNoText, sampled: all.length > picked.length }
  };
}

module.exports = { analyzeDriveFile, buildAuthorship, DriveError };
