// Assignments: Writing, Group project, Discussion. Stored as generic records
// (kind "assignment", keyed by classId). This module builds and checks them;
// server.js SECTION 11 wires the routes.

const crypto = require('crypto');
const { DEFAULT_AI_SITES, normalizeSiteList } = require('./sites');

class AssignmentError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const TYPES = ['writing', 'group', 'discussion'];
const TITLE_MAX = 200;
const INSTRUCTIONS_MAX = 20000;
const TEMPLATE_MAX = 20000;
const now = () => new Date().toISOString();

// Writing settings when a teacher doesn't say otherwise ("Homework essay" shape).
function defaultWriting(mode = 'open') {
  const locked = mode === 'locked';
  return {
    mode,
    windowStart: null, windowEnd: null,
    timeLimitMin: locked ? 45 : null,
    requireExtension: locked,
    researchTracking: true,
    allowPaste: locked ? 'internal-only' : 'allow',
    allowedSites: [],
    blockedSites: [...DEFAULT_AI_SITES], blockAiSites: locked,
    citationStyle: 'mla',
    minWords: null, maxWords: null,
    templateText: '',
    pauseGraceSec: 0,
    autoSubmitOnTimeUp: locked
  };
}

// The two presets on the create form (Section 11).
const PRESETS = {
  'in-class': { label: 'In-class essay (locked)', writing: { ...defaultWriting('locked'), timeLimitMin: 45, allowPaste: 'internal-only', researchTracking: true, blockAiSites: true, autoSubmitOnTimeUp: true } },
  homework: { label: 'Homework essay (open)', writing: { ...defaultWriting('open'), timeLimitMin: null, allowPaste: 'allow', researchTracking: true, blockAiSites: false, autoSubmitOnTimeUp: false } }
};

const isoOrNull = (v, label) => {
  if (v === null || v === undefined || v === '') return null;
  const t = Date.parse(v);
  if (!Number.isFinite(t)) throw new AssignmentError(400, `${label} isn't a date Visor can read`);
  return new Date(t).toISOString();
};
const intOrNull = (v, min, max, label) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < min || n > max) throw new AssignmentError(400, `${label} must be between ${min} and ${max}`);
  return n;
};
const text = (v, max) => (typeof v === 'string' ? v.replace(/\r\n/g, '\n').slice(0, max) : '');
const oneLine = (v, max) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '');

// Merge a teacher's writing settings over the current ones, checking each.
function cleanWriting(input = {}, current = defaultWriting()) {
  const w = { ...current };
  const has = k => Object.prototype.hasOwnProperty.call(input, k);
  if (has('mode')) {
    if (!['locked', 'open'].includes(input.mode)) throw new AssignmentError(400, 'Mode must be locked or open');
    if (input.mode !== w.mode && !has('autoSubmitOnTimeUp')) w.autoSubmitOnTimeUp = input.mode === 'locked';
    w.mode = input.mode;
  }
  if (has('windowStart')) w.windowStart = isoOrNull(input.windowStart, 'The session window start');
  if (has('windowEnd')) w.windowEnd = isoOrNull(input.windowEnd, 'The session window end');
  if (w.windowStart && w.windowEnd && w.windowEnd <= w.windowStart) throw new AssignmentError(400, 'The session window must end after it starts');
  if (has('timeLimitMin')) w.timeLimitMin = intOrNull(input.timeLimitMin, 1, 600, 'The time limit (minutes)');
  if (has('requireExtension')) w.requireExtension = !!input.requireExtension;
  if (has('researchTracking')) w.researchTracking = !!input.researchTracking;
  if (has('allowPaste')) {
    if (!['allow', 'internal-only', 'block'].includes(input.allowPaste)) throw new AssignmentError(400, 'Pasting must be allow, internal-only or block');
    w.allowPaste = input.allowPaste;
  }
  if (has('allowedSites')) w.allowedSites = normalizeSiteList(input.allowedSites);
  if (has('blockedSites')) w.blockedSites = normalizeSiteList(input.blockedSites);
  if (has('blockAiSites')) w.blockAiSites = !!input.blockAiSites;
  if (has('citationStyle')) {
    if (!['mla', 'apa', 'chicago'].includes(input.citationStyle)) throw new AssignmentError(400, 'Citation style must be MLA, APA or Chicago');
    w.citationStyle = input.citationStyle;
  }
  if (has('minWords')) w.minWords = intOrNull(input.minWords, 1, 100000, 'Minimum words');
  if (has('maxWords')) w.maxWords = intOrNull(input.maxWords, 1, 100000, 'Maximum words');
  if (w.minWords && w.maxWords && w.maxWords < w.minWords) throw new AssignmentError(400, 'Maximum words must be at least the minimum');
  if (has('templateText')) w.templateText = text(input.templateText, TEMPLATE_MAX);
  if (has('pauseGraceSec')) w.pauseGraceSec = intOrNull(input.pauseGraceSec, 0, 600, 'Grace period (seconds)') || 0;
  if (has('autoSubmitOnTimeUp')) w.autoSubmitOnTimeUp = !!input.autoSubmitOnTimeUp;
  // Locked sessions are enforced by the extension, so they always need it.
  if (w.mode === 'locked') w.requireExtension = true;
  return w;
}

// Groups for a group-project assignment: [{ id, name, studentIds, docUrl, fileId }]
// Also accepts the multi-account form (…/document/u/1/d/<id>) and a link pasted without https://
const DOC_URL_RE = /^(?:https:\/\/)?docs\.google\.com\/(document|presentation)\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{10,})/;
function parseDocUrl(url) {
  const m = DOC_URL_RE.exec(String(url || '').trim());
  return m ? { kind: m[1] === 'presentation' ? 'slides' : 'doc', fileId: m[2] } : null;
}
function cleanGroups(input, roster) {
  if (!Array.isArray(input)) throw new AssignmentError(400, 'Groups must be a list');
  if (input.length > 60) throw new AssignmentError(400, 'At most 60 groups');
  const seen = new Set();
  return input.map((g, i) => {
    const studentIds = (Array.isArray(g.studentIds) ? g.studentIds : []).map(String).filter(id => roster.includes(id) && !seen.has(id));
    studentIds.forEach(id => seen.add(id));
    let docUrl = oneLine(g.docUrl, 500), fileId = null;
    if (docUrl) {
      const p = parseDocUrl(docUrl);
      if (!p) throw new AssignmentError(400, `${oneLine(g.name, 80) || `Group ${i + 1}`}: that isn't a Google Docs or Slides link (docs.google.com/document/d/… or /presentation/d/…)`);
      fileId = p.fileId;
      if (!/^https:\/\//.test(docUrl)) docUrl = `https://${docUrl}`;
    }
    return { id: oneLine(g.id, 60) || crypto.randomUUID(), name: oneLine(g.name, 80) || `Group ${i + 1}`, studentIds, docUrl: docUrl || '', fileId, projectId: g.projectId || null };
  });
}

// A new assignment from the create form.
function createAssignment(cls, body = {}) {
  const type = body.type;
  if (!TYPES.includes(type)) throw new AssignmentError(400, 'Pick Writing, Group project or Discussion');
  const a = {
    id: crypto.randomUUID(), classId: cls.id, type,
    title: '', instructions: '', createdAt: now(), updatedAt: now(), publishedAt: null, dueAt: null
  };
  if (type === 'writing') a.writing = defaultWriting(body.writing?.mode === 'locked' ? 'locked' : 'open');
  if (type === 'group') a.group = { projectIds: [], groups: [] };
  if (type === 'discussion') a.discussion = { discussionIds: [], date: null, shareOwnStats: false };
  return patchAssignment(a, body, cls);
}

// Apply edits from the form. Title is required.
function patchAssignment(a, body = {}, cls) {
  const has = k => Object.prototype.hasOwnProperty.call(body, k);
  if (has('title')) a.title = oneLine(body.title, TITLE_MAX);
  if (!a.title) throw new AssignmentError(400, 'Give the assignment a title');
  if (has('instructions')) {
    if (typeof body.instructions === 'string' && body.instructions.length > INSTRUCTIONS_MAX) throw new AssignmentError(400, 'Instructions can be at most 20,000 characters');
    a.instructions = text(body.instructions, INSTRUCTIONS_MAX);
  }
  if (has('dueAt')) a.dueAt = isoOrNull(body.dueAt, 'The due date');
  if (a.type === 'writing' && body.writing) a.writing = cleanWriting(body.writing, a.writing);
  if (a.type === 'group' && body.group?.groups) a.group.groups = cleanGroups(body.group.groups, cls ? cls.studentIds : []).map(g => {
    // keep the project a group already has
    const before = (a.group.groups || []).find(x => x.id === g.id);
    return { ...g, projectId: before?.projectId || null };
  });
  if (a.type === 'discussion' && body.discussion) {
    if (Object.prototype.hasOwnProperty.call(body.discussion, 'date')) a.discussion.date = isoOrNull(body.discussion.date, 'The discussion date');
    if (typeof body.discussion.shareOwnStats === 'boolean') a.discussion.shareOwnStats = body.discussion.shareOwnStats;
  }
  a.updatedAt = now();
  return a;
}

// A copy for another class: same settings, unpublished, no groups or
// recordings (those belong to the original class's students).
function duplicateAssignment(a, cls) {
  const copy = JSON.parse(JSON.stringify(a));
  copy.id = crypto.randomUUID(); copy.classId = cls.id;
  copy.createdAt = now(); copy.updatedAt = now(); copy.publishedAt = null;
  copy.title = a.title.length < TITLE_MAX - 7 ? `${a.title} (copy)` : a.title;
  if (copy.group) copy.group = { projectIds: [], groups: [] };
  if (copy.discussion) copy.discussion = { ...copy.discussion, discussionIds: [] };
  return copy;
}

// The settings in plain words, the way a student sees them before starting:
// "Locked session · 45 minutes · research is recorded · …"
function describeWriting(w, multiplier = 1) {
  if (!w) return '';
  const styles = { mla: 'MLA', apa: 'APA', chicago: 'Chicago' };
  const parts = [w.mode === 'locked' ? 'Locked session' : 'Open session'];
  if (w.timeLimitMin) parts.push(`${Math.round(w.timeLimitMin * multiplier)} minutes${multiplier > 1 ? ` (includes your extra time)` : ''}`);
  else parts.push('no time limit');
  parts.push(w.researchTracking ? 'research is recorded' : 'research isn’t recorded');
  parts.push(w.allowPaste === 'allow' ? 'pasting is allowed' : w.allowPaste === 'block' ? 'pasting is off' : 'pasting from outside sources is off');
  if (w.blockAiSites) parts.push('AI sites are blocked');
  if (w.mode === 'locked' && w.allowedSites?.length) parts.push(`only ${w.allowedSites.length} allowed site${w.allowedSites.length === 1 ? '' : 's'}`);
  parts.push(`cite in ${styles[w.citationStyle] || 'MLA'}`);
  if (w.minWords || w.maxWords) parts.push(w.minWords && w.maxWords ? `${w.minWords}–${w.maxWords} words` : w.minWords ? `at least ${w.minWords} words` : `at most ${w.maxWords} words`);
  return parts.join(' · ');
}

// What a student may see of an assignment.
function studentView(a) {
  const out = { id: a.id, classId: a.classId, type: a.type, title: a.title, instructions: a.instructions, dueAt: a.dueAt, publishedAt: a.publishedAt };
  // Writing settings are shown whole: the extension needs the site lists.
  if (a.writing) out.writing = { ...a.writing };
  if (a.discussion) out.discussion = { date: a.discussion.date, shareOwnStats: !!a.discussion.shareOwnStats };
  return out;
}

module.exports = { AssignmentError, TYPES, PRESETS, defaultWriting, cleanWriting, cleanGroups, parseDocUrl, createAssignment, patchAssignment, duplicateAssignment, describeWriting, studentView };
