// Classes: a teacher's roster, its join code, pending email invites,
// per-student accommodations and co-teachers. The teacher who made a class is
// its owner (teacherId); other teacher accounts can be added as co-teachers
// (coTeacherIds, missing on older classes) and can do everything the owner
// can except delete the class or remove another teacher. Classes live in the
// core document next to users and projects (core.classes), so joining a class
// is one transaction with the account it changes.
//
// Everything here works on a core object passed in; server.js wraps the calls
// in repo.withCore() and turns thrown errors into HTTP responses.

const crypto = require('crypto');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const NAME_MAX = 120;
const MAX_MULTIPLIER = 4;
const MAX_TEACHERS = 20; // owner included
// The colours a teacher can give a course (the page maps each name to its
// shades). Folders use the same list.
const COURSE_COLORS = ['teal', 'green', 'navy', 'violet', 'magenta', 'red', 'orange', 'gold', 'slate', 'forest'];

class ClassError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const own = (obj, key) => (key != null && Object.prototype.hasOwnProperty.call(obj, String(key)) ? obj[String(key)] : undefined);
const now = () => new Date().toISOString();
const cleanName = v => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, NAME_MAX) : '');
const normEmail = v => String(v || '').trim().toLowerCase();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// A 6-character code no class and no project already uses (students type
// either kind into the same places, so they share one space).
function newJoinCode(core) {
  const taken = new Set([...Object.values(core.projects || {}).map(p => p.code), ...Object.values(core.classes || {}).map(c => c.joinCode)]);
  let code;
  do { code = Array.from(crypto.randomBytes(6)).map(b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join(''); } while (taken.has(code));
  return code;
}

function createClass(core, teacher, name) {
  const n = cleanName(name);
  if (!n) throw new ClassError(400, 'Give the class a name');
  const cls = {
    id: crypto.randomUUID(), name: n, orgId: teacher.orgId || null, teacherId: teacher.id,
    studentIds: [], joinCode: newJoinCode(core), joinOpen: true,
    accommodations: {}, pendingInvites: [], researchRetentionDays: 180,
    discussionConsentAt: null, createdAt: now(), archived: false
  };
  // A colour none of this teacher's running classes (own or co-taught) has
  // yet, while one is left: the class's own default if it's free, else the
  // next free one
  const used = new Set(Object.values(core.classes).filter(c => isClassTeacher(c, teacher.id) && !c.archived).map(colorFor));
  const def = colorFor(cls), i = COURSE_COLORS.indexOf(def);
  const free = [...COURSE_COLORS.slice(i), ...COURSE_COLORS.slice(0, i)].find(c => !used.has(c));
  if (free && free !== def) cls.color = free;
  core.classes[cls.id] = cls;
  return cls;
}

// Everyone who teaches a class: the owner first, then the co-teachers.
function teacherIdsOf(cls) {
  const ids = [cls.teacherId];
  for (const id of cls.coTeacherIds || []) if (id && !ids.includes(id)) ids.push(id);
  return ids;
}

// The owner or a co-teacher
function isClassTeacher(cls, userId) {
  return !!cls && !!userId && teacherIdsOf(cls).includes(userId);
}

// Load a class and check who's asking: one of its teachers, or an enrolled
// student. isOwner: the teacher who made it.
function classFor(core, me, id) {
  const cls = own(core.classes, id);
  if (!cls) throw new ClassError(404, 'class not found');
  if (!me) throw new ClassError(401, 'not signed in');
  const isTeacher = isClassTeacher(cls, me.id);
  if (!isTeacher && !cls.studentIds.includes(me.id)) throw new ClassError(403, 'you are not in this class');
  return { cls, isTeacher, isOwner: cls.teacherId === me.id, me };
}

// A teacher of the class adds another teacher account by its email. Returns
// the user added.
function addTeacher(core, cls, email) {
  const e = normEmail(typeof email === 'string' ? email : '');
  if (!e) throw new ClassError(400, "Type a teacher's email address");
  const u = Object.values(core.users).find(x => normEmail(x.email) === e);
  if (!u) throw new ClassError(404, 'No teacher account uses that email. They need to create a Visor teacher account first.');
  if (u.role !== 'teacher') throw new ClassError(400, "That's a student account. Only teacher accounts can teach a class.");
  if (isClassTeacher(cls, u.id)) throw new ClassError(400, 'They already teach this class.');
  if (teacherIdsOf(cls).length >= MAX_TEACHERS) throw new ClassError(400, `A class can have at most ${MAX_TEACHERS} teachers`);
  cls.coTeacherIds = [...teacherIdsOf(cls).slice(1), u.id];
  return u;
}

// Take a co-teacher off the class. The owner always stays.
function removeTeacher(cls, userId) {
  if (userId === cls.teacherId) throw new ClassError(400, "The class's owner can't be removed.");
  if (!(cls.coTeacherIds || []).includes(userId)) throw new ClassError(404, "That teacher isn't in this class");
  cls.coTeacherIds = cls.coTeacherIds.filter(id => id !== userId);
}

function findByCode(core, code) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return null;
  return Object.values(core.classes).find(x => x.joinCode === c) || null;
}

function enroll(cls, userId) {
  if (!cls.studentIds.includes(userId)) cls.studentIds.push(userId);
}

// A student types a class code (on its own, or at sign-up).
function joinByCode(core, user, code) {
  if (!user || user.role !== 'student') throw new ClassError(403, 'Only student accounts can join a class with a code.');
  const cls = findByCode(core, code);
  if (!cls || cls.archived) throw new ClassError(404, 'No class uses that code. Check it with your teacher.');
  if (!cls.joinOpen && !cls.studentIds.includes(user.id)) throw new ClassError(403, 'This class has closed joining. Ask your teacher to add you.');
  enroll(cls, user.id);
  return cls;
}

// Anyone a teacher invited by email before they had an account joins those
// classes as soon as the account exists (sign-up, or a later sign-in).
// Returns the classes joined.
function joinPendingInvites(core, user) {
  if (!user || user.role !== 'student') return [];
  const email = normEmail(user.email);
  const joined = [];
  for (const cls of Object.values(core.classes)) {
    const before = (cls.pendingInvites || []).length;
    cls.pendingInvites = (cls.pendingInvites || []).filter(i => normEmail(i.email) !== email);
    if (cls.pendingInvites.length !== before) { enroll(cls, user.id); joined.push(cls); }
  }
  return joined;
}

function hasPendingInvite(core, email) {
  const e = normEmail(email);
  return Object.values(core.classes).some(c => (c.pendingInvites || []).some(i => normEmail(i.email) === e));
}

// Teacher adds students: { userId } or { emails: [...] }. Existing student
// accounts are enrolled; unknown addresses become pending invites; teacher
// accounts are never enrolled (they're added as co-teachers instead). Returns
// a summary the page shows ("3 added, 2 invited, 1 skipped").
function addStudents(core, cls, body = {}) {
  const added = [], invited = [], skipped = [];
  if (body.userId) {
    const u = own(core.users, body.userId);
    if (!u || u.role !== 'student') throw new ClassError(404, 'student not found');
    enroll(cls, u.id); added.push(u.email);
    return { added, invited, skipped };
  }
  const emails = Array.isArray(body.emails) ? body.emails : typeof body.emails === 'string' ? body.emails.split(/[\s,;]+/) : [];
  if (!emails.length) throw new ClassError(400, 'Give a student account or a list of email addresses');
  if (emails.length > 500) throw new ClassError(400, 'Add at most 500 addresses at a time');
  for (const raw of emails) {
    const email = normEmail(raw);
    if (!email) continue;
    if (!EMAIL_RE.test(email) || email.length > 200) { skipped.push({ email: String(raw).slice(0, 200), why: 'not an email address' }); continue; }
    const u = Object.values(core.users).find(x => x.email === email);
    if (u && u.role !== 'student') { skipped.push({ email, why: 'that is a teacher account' }); continue; }
    if (u) { enroll(cls, u.id); added.push(email); continue; }
    cls.pendingInvites = cls.pendingInvites || [];
    if (!cls.pendingInvites.some(i => normEmail(i.email) === email)) cls.pendingInvites.push({ email, invitedAt: now() });
    invited.push(email);
  }
  return { added, invited, skipped };
}

function removeStudent(cls, userId) {
  cls.studentIds = cls.studentIds.filter(id => id !== userId);
}

function removeInvite(cls, email) {
  const e = normEmail(email);
  cls.pendingInvites = (cls.pendingInvites || []).filter(i => normEmail(i.email) !== e);
}

// { name?, color?, joinOpen?, archived?, accommodations?, researchRetentionDays? }
function patchClass(cls, body = {}) {
  if (body.name !== undefined) {
    const n = cleanName(body.name);
    if (!n) throw new ClassError(400, 'Give the class a name');
    cls.name = n;
  }
  // null goes back to the default colour
  if (body.color !== undefined) {
    if (body.color === null) delete cls.color;
    else if (COURSE_COLORS.includes(body.color)) cls.color = body.color;
    else throw new ClassError(400, 'Pick one of the course colours');
  }
  if (typeof body.joinOpen === 'boolean') cls.joinOpen = body.joinOpen;
  if (typeof body.archived === 'boolean') cls.archived = body.archived;
  if (body.researchRetentionDays !== undefined) {
    const d = Math.round(Number(body.researchRetentionDays));
    if (!Number.isFinite(d) || d < 1 || d > 3650) throw new ClassError(400, 'Keep research for 1 to 3650 days');
    cls.researchRetentionDays = d;
  }
  if (body.accommodations && typeof body.accommodations === 'object') {
    for (const [sid, a] of Object.entries(body.accommodations)) {
      if (!cls.studentIds.includes(sid)) continue;
      if (a === null) { delete cls.accommodations[sid]; continue; }
      const m = Number(a.timeMultiplier);
      if (!Number.isFinite(m) || m < 1 || m > MAX_MULTIPLIER) throw new ClassError(400, `Extra time must be between 1× and ${MAX_MULTIPLIER}×`);
      const note = typeof a.note === 'string' ? a.note.trim().slice(0, 300) : '';
      if (m === 1 && !note) delete cls.accommodations[sid];
      else cls.accommodations[sid] = { timeMultiplier: Math.round(m * 100) / 100, note };
    }
  }
  return cls;
}

// A class's colour: the one its teacher picked, or a default from its id (the
// same class always gets the same one).
function colorFor(cls) {
  if (cls && COURSE_COLORS.includes(cls.color)) return cls.color;
  const h = crypto.createHash('sha1').update(String(cls?.id || '')).digest();
  return COURSE_COLORS[h.readUInt32BE(0) % COURSE_COLORS.length];
}

function rotateCode(core, cls) {
  cls.joinCode = newJoinCode(core);
  return cls.joinCode;
}

// The time multiplier for one student (1 when none is set).
function multiplierFor(cls, studentId) {
  const m = Number(cls?.accommodations?.[studentId]?.timeMultiplier);
  return Number.isFinite(m) && m >= 1 ? m : 1;
}

module.exports = {
  ClassError, CODE_ALPHABET, COURSE_COLORS, MAX_TEACHERS, colorFor, newJoinCode, createClass, classFor, findByCode, joinByCode,
  joinPendingInvites, hasPendingInvite, addStudents, removeStudent, removeInvite, patchClass, rotateCode, multiplierFor,
  teacherIdsOf, isClassTeacher, addTeacher, removeTeacher
};
