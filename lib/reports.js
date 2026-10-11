// Document reports: every source ends up in the one shape the site already
// renders and the analysis already reads:
//   { title, docType, revisionCount, wordCount, analyzedAt, overallSummary,
//     contributors: [{ name, email, revisionCount, percentContribution,
//                      wordsAdded, wordsRemoved, role, summary, keyContributions }] }
//
// Sources:
//   'visor-extension' — the Visor Chrome extension's own analysis (every edit
//                       operation, typed vs pasted, external pastes). Exact.
//   'drive'           — Google Drive's saved revision snapshots. Coarser.
//   'legacy'          — the older report format the site accepted before.
//
// Nothing here is written by an AI. Every summary sentence is built from
// counted numbers, so the analysis step (which does use Gemini) is reading
// measurements, not guesses.

const now = () => new Date().toISOString();
const str = (v, max = 200) => (v == null ? '' : String(v)).slice(0, max);
// Only link to real Google Docs/Slides pages (a report can come from anyone who knows the project code).
const safeDocUrl = u => (typeof u === 'string' && /^https:\/\/docs\.google\.com\//.test(u) ? u.slice(0, 500) : null);
const fmt = n => Math.round(Number(n) || 0).toLocaleString('en-US');
const pct = x => `${Math.round((Number(x) || 0) * 100)}%`;
const toWords = chars => Math.round((Number(chars) || 0) / 5); // same 5-chars-per-word rule the extension uses for WPM
const num = v => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
// Timestamps arrive as milliseconds or ISO text; keep plausible ones as ms.
function ms(v) {
  const t = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(t) && t > 946684800000 && t < Date.now() + 864e5 ? Math.round(t) : null;
}
const ORIGINS = new Set(['external', 'internal-copy', 'internal-move']);

// The extension's detailed figures, copied field by field. Whatever else a
// report contains (for example text, if someone sends a modified export) is
// dropped here and never stored.
function visorDetail(a) {
  const who = v => (v == null ? null : str(v, 80));
  const arr = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);
  // Parts an older extension (before 3.1) didn't send stay null, so the site can say so
  const opt = (v, fn) => (Array.isArray(v) ? fn() : null);
  const obs = a.observations || a.behavior?.observations;
  return {
    sessions: arr(a.sessions, 400).map(x => ({
      start: ms(x.start), end: ms(x.end), who: who(x.userId),
      authors: arr(x.authors, 12).map(y => ({ who: who(y.userId), inserted: num(y.inserted), deleted: num(y.deleted), mutations: num(y.mutations) })),
      inserted: num(x.inserted), deleted: num(x.deleted), mutations: num(x.mutations), pastes: num(x.pastes)
    })).filter(x => x.start),
    pastes: opt(a.pastes, () => arr(a.pastes, 300).map(x => ({ who: who(x.userId), time: ms(x.time), length: num(x.length), origin: ORIGINS.has(x.origin) ? x.origin : null })).filter(x => x.length)),
    deletions: opt(a.deletions, () => arr(a.deletions, 300).map(x => ({ who: who(x.userId), time: ms(x.time), length: num(x.length) })).filter(x => x.length)),
    heatmap: opt(a.heatmap, () => arr(a.heatmap, 2400).filter(h => /^\d{4}-\d{2}-\d{2}$/.test(String(h.date)) && Number.isInteger(Number(h.hour)) && Number(h.hour) >= 0 && Number(h.hour) < 24 && num(h.count))
      .map(h => ({ date: String(h.date), hour: Number(h.hour), count: num(h.count) }))),
    provenance: opt(a.provenance, () => arr(a.provenance, 100).map(x => ({ who: who(x.userId), typed: num(x.typed), pasted: num(x.paste) + num(x.bulk), total: num(x.total) })).filter(x => x.total)),
    observations: opt(obs, () => arr(obs, 20).map(o => ({ label: str(o.label, 120), detail: str(o.detail, 300), measure: o.measure == null ? null : str(o.measure, 40) })).filter(o => o.label))
  };
}

function mins(m) {
  m = Math.round(Number(m) || 0);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}

// ---------------------------------------------------------------- legacy ----
function normalizeLegacy(raw) {
  const ai = raw.aiAnalysis || raw;
  const meta = raw.docMeta || {};
  const contributors = (ai.contributors || []).map(c => ({
    name: c.name || 'Unknown', email: c.email || '', revisionCount: Number(c.revisionCount) || 0, percentContribution: Number(c.percentContribution) || 0,
    wordsAdded: Number(c.wordsAdded) || 0, wordsRemoved: Number(c.wordsRemoved) || 0, role: c.role || '', summary: c.summary || '',
    keyContributions: Array.isArray(c.keyContributions) ? c.keyContributions.map(String).slice(0, 8) : [], workPattern: c.workPattern || ''
  }));
  if (!contributors.length && !ai.overallSummary) return null;
  return {
    source: 'legacy',
    fileId: raw.fileId || meta.id || raw.googleFileId || null,
    title: raw.title || meta.name || ai.title || 'Untitled document',
    docType: raw.docType || (raw.isSlides || (meta.mimeType || '').includes('presentation') ? 'slides' : 'doc'),
    analyzedAt: raw.analyzedAt || now(),
    revisionCount: Number(raw.revisionCount ?? (raw.revisions ? raw.revisions.length : 0)) || 0,
    wordCount: Number(raw.wordCount ?? ai.documentInsights?.totalWords) || 0,
    overallSummary: ai.overallSummary || '', insights: ai.documentInsights || null, contributors,
    timeline: Array.isArray(ai.timeline) ? ai.timeline.slice(0, 20) : [], statistics: ai.statistics || null
  };
}

// ------------------------------------------------------- Visor extension ----
function roleFromMeasures(c, share) {
  if (share < 0.1) return 'Minimal Contributor';
  if ((c.deleted || 0) > (c.inserted || 0)) return 'Active Editor';
  return share >= 0.35 ? 'Primary Writer' : 'Active Editor';
}

function normalizeVisorExport(raw) {
  const meta = raw.meta || {};
  const a = raw.analysis || {};
  const t = a.totals || {};
  const people = (Array.isArray(a.contributors) ? a.contributors : []).slice(0, 100);
  if (!people.length) return null;
  const totalInserted = people.reduce((s, c) => s + (Number(c.inserted) || 0), 0) || 1;

  const sessionsFor = id => (a.sessions || []).filter(s => s.userId === id || (s.authors || []).some(x => x.userId === id)).length;

  const contributors = people.map(c => {
    const inserted = Number(c.inserted) || 0;
    const share = typeof c.share === 'number' ? c.share : inserted / totalInserted;
    const typedPct = inserted ? (Number(c.typedChars) || 0) / inserted : 0;
    const ext = Number(c.externalPastedChars) || 0;
    const extN = Number(c.externalPastes) || 0;
    const internal = Number(c.internalPastedChars) || 0;
    const sessions = sessionsFor(c.id);
    const key = [];
    key.push(`${fmt(inserted)} characters inserted, ${fmt(c.deleted)} deleted`);
    key.push(`${pct(typedPct)} typed keystroke by keystroke`);
    if (extN) key.push(`${extN} external paste${extN === 1 ? '' : 's'} (${fmt(ext)} characters from outside the document)`);
    if (internal) key.push(`${fmt(internal)} characters of internal pastes (copied or moved within the document)`);
    if (c.activeMinutes) key.push(`${mins(c.activeMinutes)} of active writing across ${sessions} session${sessions === 1 ? '' : 's'}`);
    if (c.wpm) key.push(`typing speed ${c.wpm} wpm`);
    return {
      key: c.id == null ? null : str(c.id, 80),
      name: str(c.name) || 'Unknown',
      email: str(c.email),
      revisionCount: Number(c.mutations) || 0,
      percentContribution: Math.round(share * 100),
      wordsAdded: toWords(inserted),
      wordsRemoved: toWords(c.deleted),
      role: roleFromMeasures(c, share),
      summary: `Wrote ${pct(share)} of all inserted text (${fmt(inserted)} characters): ${pct(typedPct)} typed, ${inserted ? pct(ext / inserted) : '0%'} external pastes.`,
      keyContributions: key,
      measures: {
        insertedChars: inserted, deletedChars: Number(c.deleted) || 0,
        typedChars: Number(c.typedChars) || 0, typedPct: Math.round(typedPct * 100),
        externalPastes: extN, externalPastedChars: ext, internalPastedChars: internal,
        activeMinutes: Number(c.activeMinutes) || 0, wpm: Number.isFinite(Number(c.wpm)) && c.wpm !== null ? Number(c.wpm) : null, sessions,
        pastes: num(c.pastes), internalPastes: num(c.internalPastes), mutations: num(c.mutations),
        firstEdit: ms(c.first), lastEdit: ms(c.last), identified: c.identified !== false
      }
    };
  }).sort((x, y) => y.percentContribution - x.percentContribution);

  const b = a.behavior || {};
  const external = Number(t.externalPastedChars ?? b.externalChars) || 0;
  const inserted = Number(t.inserted ?? b.totalChars) || 0;
  const parts = [
    `${fmt(t.mutations)} edit operations by ${contributors.length} contributor${contributors.length === 1 ? '' : 's'}`,
    t.spanDays ? `over ${t.spanDays} day${t.spanDays === 1 ? '' : 's'}` : null,
    t.activeMinutes ? `with ${mins(t.activeMinutes)} of active writing` : null
  ].filter(Boolean).join(' ');
  const overallSummary = `${parts}. ${inserted ? `${pct(external / inserted)} of inserted text came from external pastes` : 'No text was inserted'}; ${fmt(t.deleted)} characters were deleted along the way.`;

  return {
    source: 'visor-extension',
    fileId: meta.fileId ? str(meta.fileId) : null,
    title: str(meta.title, 300) || 'Untitled document',
    docType: /slide|presentation/.test(String(meta.kind || '')) ? 'slides' : 'doc',
    url: safeDocUrl(meta.url),
    scope: raw.scope ? str(raw.scope) : null,
    analyzedAt: raw.exportedAt || now(),
    revisionCount: Number(t.mutations) || 0,
    revisionLabel: 'edit operations',
    wordCount: Number(t.finalWords) || 0,
    overallSummary,
    collapsedRoster: !!a.collapsedRoster,
    contributors,
    metrics: {
      finalWords: Number(t.finalWords) || 0,
      editOperations: Number(t.mutations) || 0,
      activeMinutes: Number(t.activeMinutes) || 0,
      pasteCount: Number(t.pasteCount) || 0,
      externalPastes: Number(t.externalPastes) || 0,
      internalPastes: Number(t.internalPastes) || 0,
      externalPastedChars: external,
      internalPastedChars: Number(t.internalPastedChars) || 0,
      insertedChars: inserted,
      deletedChars: Number(t.deleted) || 0,
      spanDays: Number(t.spanDays) || 0,
      firstEdit: t.firstEdit || null,
      lastEdit: t.lastEdit || null,
      externalShare: inserted ? external / inserted : 0,
      enoughHistory: b.enough !== false
    },
    growth: Array.isArray(a.growth) ? a.growth.slice(0, 400).map(g => ({ length: Number(g.length) || 0, time: g.time || null })) : [],
    detail: visorDetail(a)
  };
}

// Anything the extension or a person might send us.
function normalizeReport(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (String(raw.schema || '').startsWith('visor-export') && raw.analysis) return normalizeVisorExport(raw);
  return normalizeLegacy(raw);
}

// ---------------------------------------------------------------- Drive ----
function dateRange(steps) {
  const times = steps.map(s => Date.parse(s.time)).filter(Number.isFinite);
  if (!times.length) return '';
  const f = t => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const a = f(Math.min(...times)), b = f(Math.max(...times));
  return a === b ? `, on ${a}` : `, from ${a} to ${b}`;
}
// `file` = Drive metadata, `result` = buildAuthorship() output.
function buildDriveReport(file, result) {
  const totalAdded = result.contributors.reduce((s, c) => s + c.charsAdded, 0) || 1;
  const last = [...result.steps].reverse().find(s => !s.textUnavailable);
  const contributors = result.contributors.map(c => {
    const share = c.charsAdded / totalAdded;
    return {
      key: str(c.name, 120), name: c.name, email: c.email || '',
      revisionCount: c.revisions,
      percentContribution: Math.round(share * 100),
      wordsAdded: toWords(c.charsAdded), wordsRemoved: toWords(c.charsRemoved),
      role: share < 0.1 ? 'Minimal Contributor' : (c.charsRemoved > c.charsAdded ? 'Active Editor' : share >= 0.35 ? 'Primary Writer' : 'Active Editor'),
      summary: `Last to save ${c.revisions} of the ${result.analyzedRevisions} snapshots read, adding ${fmt(c.charsAdded)} and removing ${fmt(c.charsRemoved)} characters between them.`,
      keyContributions: [],
      measures: { insertedChars: c.charsAdded, deletedChars: c.charsRemoved, snapshots: c.revisions }
    };
  }).sort((x, y) => y.percentContribution - x.percentContribution);

  return {
    source: 'drive',
    fileId: file.id,
    title: file.name || 'Untitled document',
    docType: (file.mimeType || '').includes('presentation') ? 'slides' : 'doc',
    url: safeDocUrl(file.webViewLink),
    analyzedAt: now(),
    revisionCount: result.totalRevisions,
    revisionLabel: 'saved revisions',
    wordCount: last ? toWords(last.docLength) : 0,
    overallSummary: `${result.totalRevisions} saved revisions in Google Drive by ${contributors.length} contributor${contributors.length === 1 ? '' : 's'}${dateRange(result.steps)}.`,
    contributors,
    drive: { totalRevisions: result.totalRevisions, analyzedRevisions: result.analyzedRevisions, sampled: result.sampled, skippedNoText: result.skippedNoText },
    growth: result.steps.filter(s => !s.textUnavailable).map(s => ({ length: s.docLength, time: s.time })),
    detail: {
      saves: result.steps.slice(0, 400).map(s => ({ who: str(s.name, 120), time: ms(s.time), added: num(s.charsAdded), removed: num(s.charsRemoved), length: num(s.docLength), noText: !!s.textUnavailable })).filter(s => s.time)
    }
  };
}

module.exports = { normalizeReport, buildDriveReport };
