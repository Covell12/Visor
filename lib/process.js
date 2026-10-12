// The process report for one student document (Section 7.7): how the essay
// was written, from Visor's own op log.
//
// A. Engine analysis. The op log is converted into the edit entries the
//    Visor extension reads from Google Docs, and run through the same engine
//    (lib/engine/changelog.js, a copy of extension/changelog.js). The result
//    renders in the web app's existing document view.
// B. Ground truth, which only Visor's own editor can know: sessions and
//    pauses, every paste and where it came from, how much of the final text
//    arrived each way, typing pace, the research log, and factual notes for
//    the teacher.
//
// Nothing here guesses or scores. The notes are rules over measured numbers,
// phrased as observations, never as accusations. Thresholds live in NOTES.

const { VisorChangelog } = require('./engine/changelog.js');
const { normalizeReport } = require('./reports');
const { researchMsOf } = require('./sessions');
const { EMBED, wordCount } = require('./doc-format.js');

// When a note is written. One place, so they can be tuned together.
const NOTES = {
  OUTSIDE_PASTE_PCT: 10,       // share of the final text pasted from outside Visor's view
  RESEARCH_PASTE_PCT: 15,      // share pasted from pages copied during sessions
  LEFT_TIMES: 3,               // times away from the writing tab…
  LEFT_MINUTES: 5,             // …or total minutes away
  PANEL_RESEARCH_MS: 60 * 1000, // research on other tabs with the side panel open, per session
  INJECTED_CHARS: 100,         // a block inserted with no keyboard or paste event
  PACE_TOLERANCE: 0.35,        // within ±35% of the student's usual pace = "in line"
  MIN_WORDS_FOR_PACE: 100,
  ACTIVE_GAP_MS: 2 * 60 * 1000 // a gap longer than this isn't active writing
};
const GROUP_MS = 1000;         // ops this close, same session and source = one engine entry
const TEMPLATE_USER = 'teacher-template';

const CATEGORY = {            // how a character arrived
  typed: 'Typed', 'pasted-internal': 'Moved or copied within the essay', 'pasted-research': 'Pasted from a page copied during a session',
  'pasted-outside': 'Pasted from outside Visor’s view', cited: 'Citations', template: 'Teacher’s starter text', other: 'Inserted with no keyboard or paste event',
  image: 'Image'
};

function categoryOf(op) {
  if (op.src === 'template') return 'template';
  if (op.src === 'cite') return 'cited';
  if (op.src === 'image') return 'image';
  if (op.src === 'paste' || op.src === 'drop') {
    if (op.paste?.internal) return 'pasted-internal';
    if (op.paste?.origin) return 'pasted-research';
    return 'pasted-outside';
  }
  if (op.src === 'other') return 'other';
  return 'typed';   // type, ime, replace, autocorrect, undo, redo, structure (tables, lists from the menus…)
}

const words = wordCount;   // an image isn't a word
const hostOf = url => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
const fmtInt = n => Math.round(n).toLocaleString('en-US');
const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);
const minutes = ms => Math.round(ms / 60000);
const median = arr => { const a = [...arr].sort((x, y) => x - y); if (!a.length) return null; const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const plural = (n, w, p) => `${fmtInt(n)} ${n === 1 ? w : (p || w + 's')}`;

/* ---------------- A. the engine ---------------- */

// Op log -> engine entries: consecutive ops from one session, with the same
// source and less than a second apart, become one entry (the way Docs
// batches keystrokes), so the engine's typing and session logic behave alike.
function opsToEntries(ops, studentId) {
  const entries = [];
  let cur = null;
  for (const op of ops) {
    const user = op.src === 'template' ? TEMPLATE_USER : studentId;
    const same = cur && cur._sid === (op.sid || null) && cur._src === op.src && op.t - cur._last <= GROUP_MS && cur.userId === user;
    if (!same) {
      cur = { mutation: { ty: 'mlti', mts: [] }, time: op.t, rev: op.n, userId: user, sid: op.sid || null, _sid: op.sid || null, _src: op.src, _last: op.t };
      entries.push(cur);
    }
    cur._last = op.t;
    if (op.k === 'i') cur.mutation.mts.push({ ty: 'is', ibi: op.at + 1, s: op.s });
    else if (op.k === 'd') cur.mutation.mts.push({ ty: 'ds', si: op.at + 1, ei: op.at + op.len });
    else if (op.k === 'f') cur.mutation.mts.push({ ty: 'as', si: op.at + 1, ei: op.at + op.len });
  }
  return entries.map(({ _sid, _src, _last, ...e }) => e);
}

function engineAnalysis(ops, { studentId, studentName, title }) {
  const entries = opsToEntries(ops, studentId);
  const users = [{ id: studentId, name: studentName || 'Student' }, { id: TEMPLATE_USER, name: 'Teacher template' }];
  const timeline = VisorChangelog.buildTimeline(entries, users);
  const analysis = VisorChangelog.analyze(timeline);
  // The same shape the extension sends, so the existing document view renders it
  const exportShape = { schema: 'visor-export/1', meta: { title: title || 'Essay', kind: 'doc' }, exportedAt: new Date().toISOString(), analysis };
  return { finalText: timeline.finalText, entries: entries.length, report: normalizeReport(exportShape) };
}

/* ---------------- B. ground truth ---------------- */

// Who wrote each surviving character, and how it arrived: a fold over the op
// log that carries a tag per character.
function provenance(ops) {
  const tags = [];   // parallel to the text: { c: category, n: op number }
  for (const op of ops) {
    if (op.k === 'i') {
      const tag = { c: categoryOf(op), n: op.n };
      const block = new Array(op.s.length).fill(tag);
      for (let i = 0; i < block.length; i += 4096) tags.splice(op.at + i, 0, ...block.slice(i, i + 4096));
    } else if (op.k === 'd') {
      tags.splice(op.at, op.len);
    }
  }
  return tags;
}

// Characters of the final text by category. Whitespace and images aren't
// counted (an image isn't text), but both stay in the runs with their category.
function survival(tags, finalText) {
  const by = Object.fromEntries(Object.keys(CATEGORY).map(k => [k, 0]));
  let skipped = 0, images = 0;
  for (let i = 0; i < tags.length; i++) {
    if (finalText[i] === EMBED) { images++; skipped++; continue; }
    if (/\s/.test(finalText[i])) { skipped++; continue; }
    by[tags[i].c] += 1;
  }
  const total = tags.length - skipped;
  // Runs for "Color by source": [{ at, len, c }] over the final text
  const runs = [];
  for (let i = 0; i < tags.length; i++) {
    const c = tags[i].c, last = runs[runs.length - 1];
    if (last && last.c === c && last.at + last.len === i) last.len++;
    else runs.push({ at: i, len: 1, c });
  }
  return { chars: by, total, images, pct: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, pct(v, total)])), runs };
}

function activeMsOf(ops) {
  let ms = 0;
  for (let i = 1; i < ops.length; i++) { const g = ops[i].t - ops[i - 1].t; if (g > 0 && g <= NOTES.ACTIVE_GAP_MS) ms += g; }
  return ms;
}

// Stretches of typing (gaps of 2 s or less), in characters
function bursts(ops) {
  const out = [];
  let cur = 0, last = null;
  for (const op of ops) {
    if (op.k !== 'i' || (op.src !== 'type' && op.src !== 'ime')) continue;
    if (last != null && op.t - last > 2000) { if (cur) out.push(cur); cur = 0; }
    cur += op.s.length; last = op.t;
  }
  if (cur) out.push(cur);
  return out;
}

function sessionRows(sessions, ops) {
  return sessions.map((s, i) => {
    const mine = ops.filter(o => o.sid === s.id);
    const start = Date.parse(s.startedAt), end = Date.parse(s.endedAt || s.lastBeat || s.startedAt);
    const away = (s.pauses || []).filter(p => p.reason !== 'teacher').reduce((a, p) => a + Math.max(0, (Date.parse(p.to) || end) - Date.parse(p.from)), 0);
    const activeMs = activeMsOf(mine);
    const typed = mine.filter(o => o.k === 'i' && (o.src === 'type' || o.src === 'ime')).reduce((a, o) => a + o.s.length, 0);
    const inserted = mine.filter(o => o.k === 'i').reduce((a, o) => a + o.s.length, 0);
    const deleted = mine.filter(o => o.k === 'd').reduce((a, o) => a + o.len, 0);
    const wpm = activeMs >= 60000 && typed >= 100 ? Math.round((typed / 5) / (activeMs / 60000)) : null;
    return {
      n: i + 1, id: s.id, startedAt: s.startedAt, endedAt: s.endedAt, endReason: s.endReason, mode: s.mode, durationMs: Math.max(0, end - start),
      activeMs, awayMs: away, researchMs: researchMsOf(s, end), pauses: (s.pauses || []).map(p => ({ from: p.from, to: p.to, reason: p.reason, ms: Math.max(0, (Date.parse(p.to) || end) - Date.parse(p.from)) })),
      ops: mine.length, typedChars: typed, insertedChars: inserted, deletedChars: deleted, wpm,
      extension: s.extension || null, events: s.events || []
    };
  });
}

function pasteRows(ops, tags, finalText) {
  const pasteOps = ops.filter(o => o.k === 'i' && o.paste);
  return pasteOps.map(o => {
    let survived = 0, firstAt = -1;
    for (let i = 0; i < tags.length; i++) if (tags[i].n === o.n) { survived++; if (firstAt < 0) firstAt = i; }
    return {
      n: o.n, t: o.t, len: o.s.length, preview: o.s.slice(0, 140), sid: o.sid,
      kind: o.paste.internal ? 'internal' : o.paste.origin ? 'research' : 'outside',
      origin: o.paste.origin || null, survivedChars: survived, at: firstAt, context: firstAt >= 0 ? finalText.slice(Math.max(0, firstAt - 40), firstAt) : ''
    };
  });
}

function researchSummary(researchChunks, sessions, pastes, sources) {
  const events = researchChunks.flatMap(c => (c.events || []).map(e => ({ ...e, sessionId: c.sessionId }))).sort((a, b) => a.t - b.t);
  const sessionNo = id => sessions.findIndex(s => s.id === id) + 1;
  const searches = events.filter(e => e.type === 'search').map(e => ({ t: e.t, query: e.query, engine: e.engine, session: sessionNo(e.sessionId) }));
  const sites = new Map();
  for (const e of events.filter(e => e.type === 'leave' || e.type === 'visit')) {
    const h = e.host ? e.host.replace(/^www\./, '') : hostOf(e.url);
    if (!h) continue;
    const s = sites.get(h) || { host: h, visits: 0, dwellMs: 0, titles: new Set() };
    if (e.type === 'visit') s.visits++;
    if (e.type === 'leave') s.dwellMs += e.dwellMs || 0;
    if (e.title) s.titles.add(e.title);
    sites.set(h, s);
  }
  const pastedHashes = new Set(pastes.filter(p => p.origin).map(p => `${p.origin.url}|${p.origin.copiedAt}`));
  const copies = events.filter(e => e.type === 'copy').map(e => ({ t: e.t, url: e.url, title: e.title, len: e.copy?.len, preview: e.copy?.preview, pasted: pastedHashes.has(`${e.url}|${new Date(e.t).toISOString()}`), session: sessionNo(e.sessionId) }));
  const aiSites = [];
  for (const s of sessions) for (const ev of s.events || []) if (ev.type === 'ai-site') aiSites.push({ t: ev.t, host: (ev.host || hostOf(ev.url)).replace(/^www\./, ''), blocked: !!ev.blocked, session: sessionNo(s.id) });
  const blocked = [];
  for (const s of sessions) for (const ev of s.events || []) if (ev.type === 'lock-violation') blocked.push({ t: ev.t, host: (ev.host || hostOf(ev.url)).replace(/^www\./, ''), session: sessionNo(s.id) });
  return {
    events: events.map(e => ({ ...e, session: sessionNo(e.sessionId) })),
    searches, sites: [...sites.values()].map(s => ({ ...s, titles: [...s.titles].slice(0, 3) })).sort((a, b) => b.dwellMs - a.dwellMs),
    copies, aiSites, blocked, citations: (sources || []).map(s => ({ title: s.title, url: s.url, addedAt: s.addedAt, check: s.check || [] }))
  };
}

/* ---------------- notes for the teacher ---------------- */
// Factual, neutral sentences. Each one says what was measured; none of them
// says what it means.
function teacherNotes({ surv, pastes, sessions, research, ops, studentWords, baselineWpm, doc }) {
  const notes = [];
  const add = (rule, text) => notes.push({ rule, text });
  const nPaste = k => pastes.filter(p => p.kind === k).length;

  const outsidePct = surv.pct['pasted-outside'] || 0;
  if (outsidePct >= NOTES.OUTSIDE_PASTE_PCT) add('outside-paste', `${outsidePct}% of the final text was pasted from outside Visor’s view (${plural(nPaste('outside'), 'paste')}).`);
  const researchPct = surv.pct['pasted-research'] || 0;
  if (researchPct >= NOTES.RESEARCH_PASTE_PCT) {
    const hosts = [...new Set(pastes.filter(p => p.kind === 'research').map(p => hostOf(p.origin.url)).filter(Boolean))].slice(0, 3);
    add('research-paste', `${researchPct}% of the final text was pasted from pages copied during a session (${plural(nPaste('research'), 'paste')}${hosts.length ? `, from ${hosts.join(', ')}` : ''}).`);
  }

  const leaves = sessions.flatMap(s => s.pauses.filter(p => p.reason !== 'teacher'));
  const awayMin = minutes(leaves.reduce((a, p) => a + p.ms, 0));
  if (leaves.length >= NOTES.LEFT_TIMES || awayMin >= NOTES.LEFT_MINUTES) {
    add('left', `Left the writing tab ${plural(leaves.length, 'time')}, ${awayMin < 1 ? 'under a minute' : `${fmtInt(awayMin)} min`} in total.`);
  }

  // Research time isn't time away; it's only described
  for (const s of sessions.filter(s => s.researchMs >= NOTES.PANEL_RESEARCH_MS)) {
    const m = minutes(s.researchMs);
    add('panel-research', `Researched on other tabs with the side panel open for ${m < 1 ? 'under a minute' : `${fmtInt(m)} min`} in session ${s.n}.`);
  }

  const aiBySession = new Map();
  for (const a of research.aiSites) { const k = `${a.host}|${a.session}`; const v = aiBySession.get(k) || { ...a, count: 0 }; v.count++; v.blocked = v.blocked || a.blocked; aiBySession.set(k, v); }
  for (const a of aiBySession.values()) add('ai-site', `Visited ${a.host} during session ${a.session}${a.count > 1 ? ` (${a.count} times)` : ''}${a.blocked ? ' (blocked)' : ''}.`);

  if (research.blocked.length) add('lock-violation', `Tried to open ${plural(research.blocked.length, 'page')} that ${research.blocked.length === 1 ? 'isn’t' : 'aren’t'} allowed in the session (${[...new Set(research.blocked.map(b => b.host))].slice(0, 3).join(', ')}).`);

  // Only src 'other': toolbar structure (tables…) and images have their own src, so never count here
  const injected = ops.filter(o => o.k === 'i' && o.src === 'other' && o.s.length >= NOTES.INJECTED_CHARS);
  for (const o of injected.slice(0, 5)) add('injected', `A ${fmtInt(o.s.length)}-character block appeared with no keyboard or paste event (often a browser extension or tool inserting text).`);

  // Each image in the final text was its own insert
  if (surv.images > 0) add('images', `Inserted ${plural(surv.images, 'image')}.`);

  const blockedPastes = sessions.flatMap(s => s.events.filter(e => e.type === 'paste-blocked'));
  if (blockedPastes.length) add('paste-blocked', `Tried to paste ${plural(blockedPastes.length, 'time')} while pasting was turned off.`);

  const extOff = sessions.filter(s => s.events.some(e => e.type === 'ext-missing' && e.detail !== 'no-permission'));
  if (extOff.length) add('ext-missing', `The Visor extension was off for part of session${extOff.length > 1 ? 's' : ''} ${extOff.map(s => s.n).join(', ')}.`);

  const activeMs = sessions.reduce((a, s) => a + s.activeMs, 0);
  const typed = sessions.reduce((a, s) => a + s.typedChars, 0);
  const wpm = activeMs >= 60000 && typed >= 100 ? Math.round((typed / 5) / (activeMs / 60000)) : null;
  if (wpm && studentWords >= NOTES.MIN_WORDS_FOR_PACE) {
    let cmp = '';
    if (baselineWpm) {
      const r = wpm / baselineWpm;
      cmp = Math.abs(r - 1) <= NOTES.PACE_TOLERANCE ? ', in line with this student’s typing in this class'
        : r > 1 ? `, faster than this student’s usual ${Math.round(baselineWpm)} wpm in this class` : `, slower than this student’s usual ${Math.round(baselineWpm)} wpm in this class`;
    }
    add('pace', `Wrote ${plural(studentWords, 'word')} in ${fmtInt(Math.max(1, minutes(activeMs)))} active minutes (${wpm} wpm)${cmp}.`);
  }
  if (doc?.autoSubmitted) add('auto-submit', 'Submitted automatically when time ran out.');
  return notes;
}

function build({ doc, ops, sessions, researchChunks = [], studentName, title, baselineWpm = null }) {
  const sortedSessions = [...sessions].sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1));
  const A = engineAnalysis(ops, { studentId: doc.studentId, studentName, title });
  const tags = provenance(ops);
  const surv = survival(tags, doc.text);
  const sess = sessionRows(sortedSessions, ops);
  const pastes = pasteRows(ops, tags, doc.text);
  const research = researchSummary(researchChunks, sortedSessions, pastes, doc.sources);
  const inserted = ops.filter(o => o.k === 'i' && o.src !== 'template').reduce((a, o) => a + o.s.length, 0);
  const deleted = ops.filter(o => o.k === 'd').reduce((a, o) => a + o.len, 0);
  const b = bursts(ops);
  const activeMs = sess.reduce((a, s) => a + s.activeMs, 0);
  const typedChars = sess.reduce((a, s) => a + s.typedChars, 0);
  const typing = {
    wpm: activeMs >= 60000 && typedChars >= 100 ? Math.round((typedChars / 5) / (activeMs / 60000)) : null,
    perSession: sess.map(s => ({ n: s.n, wpm: s.wpm })),
    bursts: { count: b.length, medianChars: median(b), longestChars: b.length ? Math.max(...b) : 0 },
    revisionRatio: inserted ? Math.round((deleted / inserted) * 100) / 100 : 0,
    insertedChars: inserted, deletedChars: deleted
  };
  // The teacher's starter text isn't the student's: their words are counted without it
  const studentText = surv.chars.template ? doc.text.split('').map((ch, i) => (tags[i] && tags[i].c === 'template' ? ' ' : ch)).join('') : doc.text;
  const notes = teacherNotes({ surv, pastes, sessions: sess, research, ops, studentWords: words(studentText), baselineWpm, doc });
  return {
    builtAt: new Date().toISOString(), seq: doc.seq,
    engine: { report: A.report, entries: A.entries, matchesDoc: A.finalText === doc.text },
    totals: { words: words(doc.text), studentWords: words(studentText), sessions: sess.length, activeMs, awayMs: sess.reduce((a, s) => a + s.awayMs, 0), researchMs: sess.reduce((a, s) => a + s.researchMs, 0), pauses: sess.reduce((a, s) => a + s.pauses.filter(p => p.reason !== 'teacher').length, 0), pastes: pastes.length },
    sessions: sess, pastes, survival: { chars: surv.chars, pct: surv.pct, total: surv.total, images: surv.images, runs: surv.runs, labels: CATEGORY }, typing, research, notes
  };
}

module.exports = { NOTES, CATEGORY, TEMPLATE_USER, categoryOf, opsToEntries, engineAnalysis, provenance, survival, teacherNotes, build };
