// Visor backend (v7, Visor Classroom)
// Accounts + schools, projects, resources (audio with speaker identification,
// document reports from the Visor extension or Google Drive), and the
// Gemini-written analysis. Visor Classroom adds classes, assignments, the
// Visor Writer editor with its op log and writing sessions, the extension's
// session API, and class discussions. The frontend lives in public/ and talks
// to this over /api/*. Route sections only wire requests; the logic for the
// classroom features lives in lib/ (classes, assignments, writing, sessions,
// process, research, discussion, sites, cite).
//
// Runs two ways with the same code:
//   • On Firebase: index.js wraps this app in a Cloud Function. Data goes in
//     Firestore, recordings in Cloud Storage, transcription runs as a
//     background function. See README.md for setup.
//   • On your computer: `npm start`. Data goes in data/ (embedded Postgres +
//     audio files). Put your keys in .env.local.

require('dotenv').config({ path: ['.env.local', '.env'], quiet: true });
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const repo = require('./lib/repo');
const audioStorage = require('./lib/audioStorage');
const imageStorage = require('./lib/imageStorage');
const { normalizeReport, buildDriveReport } = require('./lib/reports');
const { analyzeDriveFile } = require('./lib/drive');
const legal = require('./lib/legalPages');
const { sessionMiddleware, sign, verify } = require('./lib/session');
const { IS_FIREBASE, IS_PROD } = require('./lib/platform');
const { OAuth2Client } = require('google-auth-library');
const classes = require('./lib/classes');
const assignments = require('./lib/assignments');
const materials = require('./lib/materials');
const { DEFAULT_AI_SITES } = require('./lib/sites');
const writing = require('./lib/writing');
const sessionsLib = require('./lib/sessions');
const research = require('./lib/research');
const citeFormat = require('./lib/cite');
const citeLookup = require('./lib/cite-lookup');
const sourceGrade = require('./lib/source-grade');
const processLib = require('./lib/process');
const discussionLib = require('./lib/discussion');
// The document format shared with the editor (a copy of public/doc-format.js)
const docFormat = require('./lib/doc-format.js');

const app = express();
const PORT = process.env.PORT || 3000;

// ═══════════════════════════════════════════════════════════════
// SECTION 1 — CONFIG
// ═══════════════════════════════════════════════════════════════

// Gemini can be reached two ways (GEMINI_VIA):
//   "vertex" — Vertex AI in this Google Cloud project. The server signs in as
//              itself, so there's no key, and it's billed like the rest of
//              Firebase. The default on Firebase.
//   "apikey" — the Gemini API with GEMINI_API_KEY (from .env.local on your
//              computer, or Firebase's Secret Manager). The default locally.
const GEMINI_VIA = (process.env.GEMINI_VIA || (IS_FIREBASE ? 'vertex' : 'apikey')).trim().toLowerCase() === 'vertex' ? 'vertex' : 'apikey';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite-preview';
const GEMINI_BASE_URL = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';
// Vertex AI: Gemini 3 models are served from the "global" location. If a model
// name isn't available (404), the next one in the list is tried.
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || 'global';
const VERTEX_BASE_URL = process.env.VERTEX_BASE_URL || (VERTEX_LOCATION === 'global' ? 'https://aiplatform.googleapis.com/v1' : `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1`);
const VERTEX_MODELS = [...new Set([process.env.VERTEX_MODEL, 'gemini-3.1-flash-lite', 'gemini-3.1-flash-lite-preview', 'gemini-3-flash-preview', 'gemini-2.5-flash'].filter(Boolean))];
const geminiReady = () => GEMINI_VIA === 'vertex' || (!!GEMINI_API_KEY && !GEMINI_API_KEY.includes('PASTE_'));

// Signs the sign-in cookie and upload tokens. On Firebase, if SESSION_SECRET
// isn't set, a random secret is made once and kept in Firestore (visor_meta/session),
// which only the server can read. On your computer a dev default is used.
const SESSION_SECRET = process.env.SESSION_SECRET || ((IS_PROD || IS_FIREBASE) ? '' : 'dev-only-change-me');
let sessionSecretPromise = null;
function getSessionSecret() {
  if (SESSION_SECRET) return SESSION_SECRET;
  if (!IS_FIREBASE) throw new HttpError(500, 'Server setup incomplete: set the SESSION_SECRET environment variable.');
  if (!sessionSecretPromise) {
    const { firestore } = require('./lib/firebaseAdmin');
    const ref = firestore().collection('visor_meta').doc('session');
    sessionSecretPromise = firestore().runTransaction(async t => {
      const snap = await t.get(ref);
      if (snap.exists && snap.get('secret')) return snap.get('secret');
      const secret = crypto.randomBytes(48).toString('base64url');
      t.set(ref, { secret, createdAt: new Date().toISOString() });
      return secret;
    }).catch(err => { sessionSecretPromise = null; throw err; });
  }
  return sessionSecretPromise;
}

// Google sign-in and Drive picker (browser keys, set in .env). The NEXT_PUBLIC_
// names are accepted so variables from the earlier Visor Web site keep working.
const GOOGLE = {
  clientId: process.env.GOOGLE_CLIENT_ID || '',
  apiKey: process.env.GOOGLE_API_KEY || process.env.NEXT_PUBLIC_GOOGLE_API_KEY || '',
  appId: process.env.GOOGLE_APP_ID || process.env.NEXT_PUBLIC_GOOGLE_APP_ID || ''
};
const googleReady = () => !!(GOOGLE.clientId && GOOGLE.apiKey && GOOGLE.appId);
// Sign in with Google only needs the client ID (the same OAuth client used for Drive import).
const googleSignInReady = () => !!GOOGLE.clientId;
const googleClient = GOOGLE.clientId ? new OAuth2Client(GOOGLE.clientId) : null;
// Google Classroom roster import (SECTION 10). Off unless the school's Google
// project is set up for it: GOOGLE_CLIENT_ID plus CLASSROOM_IMPORT=1.
const CLASSROOM_IMPORT_READY = () => !!GOOGLE.clientId && process.env.CLASSROOM_IMPORT === '1';
async function verifyGoogleCredential(credential) {
  if (!googleClient) throw new HttpError(500, 'Google sign-in is not set up on this server.');
  if (!credential) throw new HttpError(400, 'Missing Google credential');
  let ticket;
  try {
    ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE.clientId });
  } catch {
    throw new HttpError(401, 'Could not verify that Google sign-in. Try again.');
  }
  const payload = ticket.getPayload();
  if (!payload || !payload.email_verified) throw new HttpError(401, "That Google account's email isn't verified.");
  return { email: String(payload.email).trim().toLowerCase(), firstName: payload.given_name || '', lastName: payload.family_name || '', sub: payload.sub };
}

// Startup summary when running on your computer
function checkConfig() {
  if (GEMINI_VIA === 'vertex') {
    console.log(`  ✓ Gemini through Vertex AI (${VERTEX_LOCATION}), model ${VERTEX_MODELS[0]}`);
  } else if (!geminiReady()) {
    console.warn('\n  ! GEMINI_API_KEY is missing. Transcription and the written analysis will fail until it is set.\n');
  } else {
    console.log('  ✓ Gemini key loaded (' + GEMINI_API_KEY.slice(0, 6) + '…), model ' + GEMINI_MODEL);
  }
  if (!process.env.SESSION_SECRET) console.warn('  ! SESSION_SECRET not set; using a dev default. Set one before sharing this server.');
  console.log(`  ✓ Database: ${process.env.DATABASE_URL ? 'Postgres (DATABASE_URL)' : `local, in ${process.env.PGLITE_DIR || 'data/pglite'}`}`);
  console.log(`  ✓ Recordings: local, in ${process.env.VISOR_AUDIO_DIR || 'data/audio'}`);
  console.log(`  ✓ Essay pictures: local, in ${process.env.VISOR_IMAGE_DIR || 'data/images'}`);
  console.log(`  ${googleReady() ? '✓' : '·'} Google Drive import ${googleReady() ? 'enabled' : 'off (set GOOGLE_CLIENT_ID, GOOGLE_API_KEY, GOOGLE_APP_ID to turn it on)'}`);
  console.log(`  ${googleSignInReady() ? '✓' : '·'} Sign in with Google ${googleSignInReady() ? 'enabled' : 'off (set GOOGLE_CLIENT_ID to turn it on)'}`);
}

const uid = () => crypto.randomUUID();
// Own-property lookup, so ids like "__proto__" can't reach Object.prototype
const own = (obj, key) => (key != null && Object.prototype.hasOwnProperty.call(obj, String(key)) ? obj[String(key)] : undefined);
// Trimmed text with a length cap; non-strings become ''
const cleanText = (v, max) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '');
const NAME_MAX = 60;
const now = () => new Date().toISOString();

// An error with an HTTP status. Throwing one inside withCore() also rolls the change back.
class HttpError extends Error {
  constructor(status, message, data) { super(message); this.status = status; this.data = data; }
}
// Express 4 doesn't catch rejected promises, so every async route goes through this.
const ah = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ═══════════════════════════════════════════════════════════════
// SECTION 2 — MIDDLEWARE
// ═══════════════════════════════════════════════════════════════

app.set('trust proxy', 1);
// The extension's side panel frames /write/… (Section 8.5). Only Visor itself
// and extension pages may frame it; no X-Frame-Options (it can't express that).
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) res.setHeader('Content-Security-Policy', "frame-ancestors 'self' chrome-extension:");
  next();
});
app.use(express.json({ limit: '32mb' }));
app.use(sessionMiddleware({ getSecret: getSessionSecret, maxAgeMs: 1000 * 60 * 60 * 24 * 14, secure: IS_PROD }));
// On your computer this serves the page. On Firebase, Hosting serves public/
// itself and only sends /api, /privacy and /terms here.
app.use(express.static(path.join(__dirname, 'public')));

// The Chrome extension posts from a chrome-extension:// origin
app.use('/api/extension', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function currentUser(req, core) {
  return req.session?.userId ? core.users[req.session.userId] || null : null;
}
function requireAuth(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: 'not signed in' });
  next();
}
const requireTeacher = ah(async (req, res, next) => {
  const u = currentUser(req, await repo.readCore());
  if (!u || u.role !== 'teacher') return res.status(403).json({ error: 'teachers only' });
  next();
});
// A project's teacher: the one who made it, and for a class's group project
// (project.classId) every teacher of that class, co-teachers included
function isProjectTeacher(core, project, userId) {
  if (project.teacherId === userId) return true;
  const cls = project.classId ? own(core.classes, project.classId) : null;
  return !!cls && classes.isClassTeacher(cls, userId);
}
// Load the project and check the caller can see it (its teacher or a student member)
function projectFor(req, core, id = req.params.id) {
  const project = own(core.projects, id);
  if (!project) throw new HttpError(404, 'project not found');
  const me = currentUser(req, core);
  const isTeacher = !!me && isProjectTeacher(core, project, me.id);
  if (!me || (!isTeacher && !project.studentIds.includes(me.id))) throw new HttpError(403, 'not a member of this project');
  return { project, isDemo: false, me, isTeacher };
}
// Load a resource and check it belongs to the project
async function resourceFor(got, rid, type) {
  const r = await repo.getResource(rid);
  if (!r || r.projectId !== got.project.id || (type && r.type !== type)) throw new HttpError(404, type === 'audio' ? 'recording not found' : 'resource not found');
  return reconcileStale(r);
}

// Public, non-secret settings the page needs (the picker keys are browser keys by design).
app.get('/api/config', (req, res) => {
  res.json({
    uploadMode: audioStorage.mode(),
    maxAudioMB: Math.round(audioStorage.MAX_AUDIO_BYTES / 1024 / 1024),
    chunkBytes: audioStorage.CHUNK_BYTES,
    google: googleReady() ? { ...GOOGLE } : null,
    googleSignIn: googleSignInReady() ? GOOGLE.clientId : null,
    geminiReady: geminiReady(),
    // Google Classroom roster import: needs the Google client and the flag
    classroomImport: CLASSROOM_IMPORT_READY(),
    // Visor Classroom: writing assignment presets and the default AI-site list
    writingPresets: assignments.PRESETS,
    defaultAiSites: DEFAULT_AI_SITES
  });
});

// ═══════════════════════════════════════════════════════════════
// SECTION 3 — SCHOOLS
// ═══════════════════════════════════════════════════════════════
//
// People choose their own school: pick one that's already on Visor, type the
// name of a new one, or skip it. Email addresses are never used to decide.

// Letters and numbers in any language, lowercased, accents dropped
function slug(s) {
  return String(s || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
}
function publicOrg(o) { return o ? { id: o.id, name: o.name } : null; }

function createOrg(core, name) {
  const org = { id: uid(), name, createdAt: now() };
  core.orgs[org.id] = org;
  return org;
}

// The school someone chose. { schoolId } picks an existing school; { schoolName }
// finds one with that name or creates it; neither means "no school" (null).
function resolveSchoolChoice(core, { schoolId, schoolName } = {}) {
  if (schoolId) {
    const org = own(core.orgs, schoolId);
    if (!org) throw new HttpError(400, 'That school is no longer on Visor. Pick it again or type its name.');
    return org;
  }
  if (schoolName != null && typeof schoolName !== 'string') throw new HttpError(400, 'School name must be text');
  const name = String(schoolName || '').trim().replace(/\s+/g, ' ');
  if (!name) return null;
  if (name.length > 120) throw new HttpError(400, 'That school name is too long');
  if (!slug(name)) throw new HttpError(400, 'Use letters or numbers in the school name');
  return Object.values(core.orgs).find(o => slug(o.name) === slug(name)) || createOrg(core, name);
}

// Remove a school nobody belongs to any more (keeps typos and abandoned names from piling up)
function dropSchoolIfEmpty(core, orgId) {
  if (!orgId || !own(core.orgs, orgId)) return;
  const used = Object.values(core.users).some(u => u.orgId === orgId) || Object.values(core.projects).some(p => p.orgId === orgId);
  if (!used) delete core.orgs[orgId];
}

// Search schools by name (used while signing up, so no sign-in needed).
// Needs at least 2 letters, so the full list of schools isn't handed out.
app.get('/api/schools', ah(async (req, res) => {
  const q = slug(req.query.q);
  if (q.length < 2) return res.json({ schools: [] });
  const core = await repo.readCore();
  const words = q.split('-');
  const schools = Object.values(core.orgs)
    .filter(o => { const s = slug(o.name); return words.every(w => s.includes(w)); })
    .sort((a, b) => (slug(a.name).startsWith(q) ? 0 : 1) - (slug(b.name).startsWith(q) ? 0 : 1) || a.name.localeCompare(b.name))
    .slice(0, 8)
    .map(publicOrg);
  res.json({ schools });
}));

// ═══════════════════════════════════════════════════════════════
// SECTION 4 — ACCOUNTS
// ═══════════════════════════════════════════════════════════════

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, user) {
  if (!user?.passwordHash || !user?.passwordSalt) return false;
  const { hash } = hashPassword(password, user.passwordSalt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.passwordHash, 'hex'));
}

function publicUser(u, core) {
  if (!u) return null;
  const org = core ? core.orgs[u.orgId] : null;
  return { id: u.id, email: u.email, firstName: u.firstName, lastName: u.lastName, name: `${u.firstName} ${u.lastName}`.trim(), role: u.role, orgId: u.orgId, org: publicOrg(org), avatarColor: u.avatarColor || null, tutorialSeen: !!u.tutorialSeen };
}

// Students: Visor is for schools, so a student either confirms they're 13 or
// older, or was signed up by their school (a teacher invited their email to a
// class). Anyone else is told to ask their teacher.
const UNDER_13_MESSAGE = 'Check the box below Class code if you’re 13 or older. If you’re under 13, ask your teacher to add you to their class.';
function checkStudentAge(core, { role, email, over13 }) {
  if (role === 'student' && over13 !== true && !classes.hasPendingInvite(core, email)) throw new HttpError(400, UNDER_13_MESSAGE);
}
// After an account is created or signs in: join any classes that invited its
// email, and the class whose code was typed at sign-up.
function joinClassesOnSignIn(core, user, classCode) {
  classes.joinPendingInvites(core, user);
  if (classCode && String(classCode).trim()) classes.joinByCode(core, user, classCode);
}

app.post('/api/auth/signup', ah(async (req, res) => {
  const { email, password, role, schoolId, schoolName, classCode, over13 } = req.body || {};
  const firstName = cleanText(req.body?.firstName, NAME_MAX), lastName = cleanText(req.body?.lastName, NAME_MAX);
  const em = cleanText(email, 200).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) return res.status(400).json({ error: 'Enter a valid email address' });
  if (!firstName || !lastName) return res.status(400).json({ error: 'Enter your first and last name' });
  if (typeof password !== 'string' || password.length < 6) return res.status(400).json({ error: 'Password needs at least 6 characters' });
  if (password.length > 200) return res.status(400).json({ error: 'That password is too long' });
  if (!['teacher', 'student'].includes(role)) return res.status(400).json({ error: 'Pick Student or Teacher' });

  const { hash, salt } = hashPassword(password); // slow on purpose; done before taking the lock
  const out = await repo.withCore(core => {
    if (Object.values(core.users).some(u => u.email === em)) throw new HttpError(409, 'That email already has an account. Sign in instead.');
    checkStudentAge(core, { role, email: em, over13 });
    const org = resolveSchoolChoice(core, { schoolId, schoolName });
    const user = { id: uid(), email: em, firstName, lastName, role, orgId: org ? org.id : null, passwordSalt: salt, passwordHash: hash, createdAt: now() };
    core.users[user.id] = user;
    joinClassesOnSignIn(core, user, role === 'student' ? classCode : null);
    return { user: publicUser(user, core), id: user.id };
  });
  req.session.userId = out.id;
  res.json({ user: out.user });
}));

app.post('/api/auth/login', ah(async (req, res) => {
  const { email, password } = req.body || {};
  const core = await repo.readCore();
  const user = Object.values(core.users).find(u => u.email === String(email || '').trim().toLowerCase());
  if (user && !user.passwordHash && user.googleSub) return res.status(401).json({ error: 'This account uses Sign in with Google. Use the Google button instead.' });
  if (!user || typeof password !== 'string' || password.length > 200 || !verifyPassword(password, user)) return res.status(401).json({ error: 'Wrong email or password' });
  await joinInvitesIfAny(core, user);
  req.session.userId = user.id;
  res.json({ user: publicUser(user, core) });
}));

// Only takes the core lock when this person actually has an invite waiting.
async function joinInvitesIfAny(core, user) {
  if (user.role !== 'student' || !classes.hasPendingInvite(core, user.email)) return;
  await repo.withCore(c => { const u = c.users[user.id]; if (u) classes.joinPendingInvites(c, u); });
}

app.post('/api/auth/logout', (req, res) => { req.session = null; res.json({ ok: true }); });

// Sign in with Google: verify the credential, then either sign the existing
// account in or, for a first-time email, ask the frontend to finish signup
// (role + school name) via /api/auth/google/signup.
app.post('/api/auth/google', ah(async (req, res) => {
  const g = await verifyGoogleCredential(req.body?.credential);
  const core = await repo.readCore();
  let user = Object.values(core.users).find(u => u.email === g.email);
  if (!user) {
    return res.status(200).json({ needsSignup: true, email: g.email, firstName: g.firstName, lastName: g.lastName });
  }
  if (!user.googleSub) {
    // An existing password account signing in with Google for the first time.
    // Google has just proved who owns this email; the password was set without
    // any proof, so it could belong to someone who signed up with this address
    // first. Drop it: from now on this account signs in with Google only.
    user = await repo.withCore(c => {
      const u = c.users[user.id];
      u.googleSub = g.sub; delete u.passwordHash; delete u.passwordSalt;
      return u;
    });
  }
  await joinInvitesIfAny(core, user);
  req.session.userId = user.id;
  res.json({ user: publicUser(user, core) });
}));

// Finishes account creation for a Google sign-in that had no existing account.
app.post('/api/auth/google/signup', ah(async (req, res) => {
  const { credential, role, schoolId, schoolName, classCode, over13 } = req.body || {};
  const g = await verifyGoogleCredential(credential);
  if (!['teacher', 'student'].includes(role)) return res.status(400).json({ error: 'Pick Student or Teacher' });
  const out = await repo.withCore(core => {
    let user = Object.values(core.users).find(u => u.email === g.email);
    if (user) { // account was created meanwhile (double submit, race with another tab)
      if (!user.googleSub) { user.googleSub = g.sub; delete user.passwordHash; delete user.passwordSalt; }
      return { user: publicUser(user, core), id: user.id };
    }
    checkStudentAge(core, { role, email: g.email, over13 });
    const org = resolveSchoolChoice(core, { schoolId, schoolName });
    user = { id: uid(), email: g.email, firstName: cleanText(g.firstName, NAME_MAX) || 'Student', lastName: cleanText(g.lastName, NAME_MAX), role, orgId: org ? org.id : null, googleSub: g.sub, createdAt: now() };
    core.users[user.id] = user;
    joinClassesOnSignIn(core, user, role === 'student' ? classCode : null);
    return { user: publicUser(user, core), id: user.id };
  });
  req.session.userId = out.id;
  res.json({ user: out.user });
}));

app.get('/api/me', ah(async (req, res) => {
  const core = await repo.readCore();
  const u = currentUser(req, core);
  if (!u) return res.json({ signedIn: false });
  res.json({ signedIn: true, user: publicUser(u, core), geminiReady: geminiReady() });
}));

// Profile settings: name, avatar color, school, tutorial flag.
// "school": { id } or { name } to set it, null to have no school.
app.patch('/api/me', requireAuth, ah(async (req, res) => {
  const { firstName, lastName, avatarColor, tutorialSeen } = req.body || {};
  const hasSchool = req.body && Object.prototype.hasOwnProperty.call(req.body, 'school');
  const school = hasSchool ? req.body.school : undefined;
  if (hasSchool && school !== null && (typeof school !== 'object' || Array.isArray(school) ||
      (school.id != null && typeof school.id !== 'string') || (school.name != null && typeof school.name !== 'string'))) {
    return res.status(400).json({ error: 'school must be { id }, { name }, or null' });
  }
  const user = await repo.withCore(core => {
    const u = currentUser(req, core);
    if (!u) throw new HttpError(401, 'not signed in');
    if (cleanText(firstName, NAME_MAX)) u.firstName = cleanText(firstName, NAME_MAX);
    if (cleanText(lastName, NAME_MAX)) u.lastName = cleanText(lastName, NAME_MAX);
    if (typeof avatarColor === 'string') {
      if (/^#[0-9a-fA-F]{6}$/.test(avatarColor)) u.avatarColor = avatarColor.toLowerCase();
      else if (avatarColor === '') delete u.avatarColor;
      else throw new HttpError(400, 'color must look like #4dbedc');
    }
    if (typeof tutorialSeen === 'boolean') u.tutorialSeen = tutorialSeen;
    if (hasSchool) {
      const before = u.orgId;
      const org = school ? resolveSchoolChoice(core, { schoolId: school.id, schoolName: school.name }) : null;
      u.orgId = org ? org.id : null;
      if (before !== u.orgId) dropSchoolIfEmpty(core, before);
    }
    return publicUser(u, core);
  });
  res.json({ user });
}));

// Students a teacher can add to a project: students at the teacher's school
// whose name or email matches (2+ letters), plus any student whose full email
// address is typed exactly, so students without a school can be added too.
app.get('/api/school/students', requireAuth, requireTeacher, ah(async (req, res) => {
  const core = await repo.readCore();
  const me = currentUser(req, core);
  const q = String(req.query.q || '').toLowerCase().trim();
  const students = Object.values(core.users).filter(u => u.role === 'student');
  const found = new Map();
  const exact = students.find(u => u.email === q);
  if (exact) found.set(exact.id, exact);
  // Name search within the school: 2+ letters, names only (not emails), at most 10 results
  if (me.orgId && q.replace(/[^\p{L}\p{N}]/gu, '').length >= 2 && !q.includes('@')) {
    for (const u of students) {
      if (found.size >= 10) break;
      if (u.orgId === me.orgId && `${u.firstName} ${u.lastName}`.toLowerCase().includes(q)) found.set(u.id, u);
    }
  }
  res.json([...found.values()].map(u => publicUser(u, core)).sort((a, b) => a.name.localeCompare(b.name)));
}));

// ═══════════════════════════════════════════════════════════════
// SECTION 5 — GEMINI
// ═══════════════════════════════════════════════════════════════

// Vertex AI sign-in: inside Cloud Functions, google-auth-library gets a token
// for the function's own service account. A stand-in VERTEX_BASE_URL (tests)
// gets a placeholder instead.
let vertexAuth = null;
async function vertexTarget() {
  if (process.env.VERTEX_BASE_URL) return { token: 'stand-in', project: process.env.GCLOUD_PROJECT || 'stand-in' };
  if (!vertexAuth) {
    const { GoogleAuth } = require('google-auth-library');
    vertexAuth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  }
  const [token, project] = await Promise.all([
    vertexAuth.getAccessToken(),
    process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || vertexAuth.getProjectId()
  ]);
  return { token, project };
}

let vertexModelIndex = 0; // the first model name that worked, remembered while this server runs
async function geminiCall(body) {
  if (GEMINI_VIA === 'apikey') {
    if (!geminiReady()) throw new Error('No Gemini API key. Set GEMINI_API_KEY and restart.');
    const resp = await fetch(`${GEMINI_BASE_URL}/models/${GEMINI_MODEL}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY }, body: JSON.stringify(body) });
    return { resp, data: await resp.json().catch(() => ({})) };
  }
  let token, project;
  try { ({ token, project } = await vertexTarget()); }
  catch (err) { throw new Error(`Vertex AI sign-in failed: ${err.message}`); }
  for (let i = vertexModelIndex; ; i++) {
    const model = VERTEX_MODELS[i];
    const url = `${VERTEX_BASE_URL}/projects/${encodeURIComponent(project)}/locations/${VERTEX_LOCATION}/publishers/google/models/${model}:generateContent`;
    const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    const data = await resp.json().catch(() => ({}));
    if (resp.status === 404 && i + 1 < VERTEX_MODELS.length) { console.warn(`Vertex AI: model ${model} not found, trying ${VERTEX_MODELS[i + 1]}`); continue; }
    if (resp.ok) vertexModelIndex = i;
    return { resp, data };
  }
}

async function geminiGenerate(parts, opts = {}) {
  const generationConfig = { temperature: opts.temperature ?? 0.3, maxOutputTokens: opts.maxOutputTokens ?? 2000 };
  if (opts.json) generationConfig.responseMimeType = 'application/json';
  const { resp, data } = await geminiCall({ contents: [{ role: 'user', parts }], generationConfig });
  if (!resp.ok) {
    let msg = data?.error?.message || JSON.stringify(data);
    if (GEMINI_VIA === 'vertex' && resp.status === 403 && /aiplatform|Vertex AI API/i.test(msg) && /disabled|not been used|enable/i.test(msg)) {
      msg = 'Turn on the Vertex AI API for this project (Google Cloud console → search "Vertex AI API" → Enable), wait a few minutes, then try again. Google said: ' + msg;
    }
    throw new Error(`Gemini ${resp.status}: ${msg}`);
  }
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  if (!text) throw new Error('Gemini returned no text' + (data?.candidates?.[0]?.finishReason ? ` (${data.candidates[0].finishReason})` : ''));
  return text;
}

function parseLooseJSON(text) {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  const a = cleaned.indexOf('{'), b = cleaned.lastIndexOf('}');
  if (a !== -1 && b > a) { try { return JSON.parse(cleaned.slice(a, b + 1)); } catch {} }
  throw new Error('Gemini did not return valid JSON');
}
async function geminiJSON(parts, opts = {}) { return parseLooseJSON(await geminiGenerate(parts, { ...opts, json: true })); }

// ═══════════════════════════════════════════════════════════════
// SECTION 6 — AUDIO: TRANSCRIBE + FIND SPEAKERS
// ═══════════════════════════════════════════════════════════════
//
// Flow: upload → status "transcribing" (background job) → status "identify"
// (we know Speaker 1, Speaker 2… with sample quotes; the uploader tells us
// who each one is) → status "ready" (script-style transcript with names).

const ALLOWED_AUDIO_TYPES = ['audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/aac', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/flac', 'audio/x-flac', 'audio/aiff', 'audio/x-aiff', 'video/mp4', 'video/webm', 'video/quicktime'];
const MIME_BY_EXT = { webm: 'audio/webm', mp3: 'audio/mp3', m4a: 'audio/mp4', mp4: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac', aiff: 'audio/aiff' };
// The stored file name and type only ever come from these known lists.
function audioMime(filename, mime) {
  const ext = (String(filename || '').split('.').pop() || '').toLowerCase();
  const given = typeof mime === 'string' ? mime.split(';')[0].trim().toLowerCase() : '';
  const mimeType = (given.startsWith('audio/') && ALLOWED_AUDIO_TYPES.includes(given) ? given : null) || own(MIME_BY_EXT, ext) || 'audio/webm';
  const byType = Object.entries(MIME_BY_EXT).find(([, t]) => t === mimeType)?.[0];
  const fileExt = own(MIME_BY_EXT, ext) ? ext : (byType || (mimeType === 'audio/mpeg' ? 'mp3' : 'webm'));
  return { mimeType, fileExt };
}

// A transcription that has been "transcribing" longer than the job is allowed
// to run (9 minutes on Firebase) was cut off. Say so, so the "Try again" button
// appears instead of a spinner that never ends.
const STALE_TRANSCRIPTION_MS = (IS_FIREBASE ? 11 : 6) * 60 * 1000;
const transcriptionJobs = new Map(); // resourceId → Promise (local runs only)

async function reconcileStale(r) {
  if (r?.type !== 'audio' || r.audio?.status !== 'transcribing' || transcriptionJobs.has(r.id)) return r;
  const started = Date.parse(r.audio.startedAt || r.uploadedAt || 0);
  if (!started || Date.now() - started < STALE_TRANSCRIPTION_MS) return r;
  return (await repo.updateResource(r.id, x => {
    if (x.audio?.status === 'transcribing') { x.audio.status = 'error'; x.audio.error = 'Transcription was interrupted before it finished. Try again.'; }
  })) || r;
}

// Transcribe and record the outcome (success or the error message).
async function runTranscriptionJob(resourceId) {
  try {
    await transcribeResource(resourceId);
  } catch (err) {
    console.error(`transcription failed for ${resourceId}:`, err.message);
    await repo.updateResource(resourceId, r => { if (r.audio) { r.audio.status = 'error'; r.audio.error = err.message; } }).catch(() => {});
  }
}

// Start transcribing in the background and return right away.
// On Firebase a cloud function can't keep working after it has answered, so a
// job document is written and the "transcribe" function (index.js) picks it up.
// On your computer the job just runs inside this process.
async function startTranscription(resourceId) {
  if (IS_FIREBASE) {
    const { firestore } = require('./lib/firebaseAdmin');
    await firestore().collection('visor_jobs').add({ kind: 'transcribe', resourceId, createdAt: now() });
    return;
  }
  if (transcriptionJobs.has(resourceId)) return;
  const job = runTranscriptionJob(resourceId).finally(() => transcriptionJobs.delete(resourceId));
  transcriptionJobs.set(resourceId, job);
}

// The transcription prompt. `setting` says what the recording is; `people`
// are names that may be heard; `hints` (Visor Classroom discussions) describe
// the voices of the previous 10-minute segment, so labels stay consistent
// from one segment to the next.
function transcriptionPrompt({ setting = 'This is a recording of a student group working on a school project.', people = [], hints = null } = {}) {
  return `${setting}${people.length ? ` The people who might be in it: ${people.join(', ')} (there may also be others).` : ''}
${hints ? discussionLib.hintsText(hints) : ''}
Transcribe it word for word and separate the speakers by voice. Do NOT guess names; label voices "Speaker 1", "Speaker 2", etc., numbered in order of first appearance. Do not summarize or interpret anything.

Return ONLY JSON in this shape:
{
  "lines": [ { "t": "mm:ss", "speaker": "Speaker 1", "text": "exactly what they said" } ],
  "speakers": [
    { "label": "Speaker 1", "quotes": ["three short, distinctive things this voice said, in their own words", "…", "…"], "voice": "brief neutral description of the voice, e.g. 'lower voice, speaks fast'" }
  ]
}
Keep every line short (one thought each). Every line's speaker must be one of the labels in "speakers".`;
}

// Send one stored recording to Gemini with a prompt; returns { lines, speakers }.
async function transcribeAudio(audio, prompt) {
  const opts = { temperature: 0.2, maxOutputTokens: 16000 };
  const inline = async () => geminiJSON([
    { text: prompt },
    { inlineData: { mimeType: audio.mime, data: (await audioStorage.readAudio(audio)).toString('base64') } }
  ], opts);
  let parsed;
  const gsUri = GEMINI_VIA === 'vertex' ? audioStorage.gcsUri(audio) : null;
  if (gsUri) {
    // Vertex AI reads the recording straight from Cloud Storage (no size limit
    // from sending it inside the request). If it can't, send the bytes instead.
    try {
      parsed = await geminiJSON([{ text: prompt }, { fileData: { mimeType: audio.mime, fileUri: gsUri } }], opts);
    } catch (err) {
      if (!/^Gemini (400|403):/.test(err.message)) throw err;
      console.warn('Vertex AI could not read the recording from Cloud Storage; sending it inline instead:', err.message);
      parsed = await inline();
    }
  } else {
    parsed = await inline();
  }

  const lines = Array.isArray(parsed.lines) ? parsed.lines.map(l => ({ t: String(l.t || ''), speaker: String(l.speaker || 'Speaker 1'), text: String(l.text || '').trim() })).filter(l => l.text) : [];
  const labels = Array.from(new Set(lines.map(l => l.speaker)));
  const fromModel = Array.isArray(parsed.speakers) ? parsed.speakers : [];
  const speakers = labels.map(label => {
    const m = fromModel.find(s => s.label === label) || {};
    const own = lines.filter(l => l.speaker === label);
    const quotes = (Array.isArray(m.quotes) && m.quotes.length ? m.quotes : own.slice(0, 3).map(l => l.text)).map(String).slice(0, 3);
    return { label, quotes, voice: String(m.voice || ''), assignedName: null, assignedUserId: null };
  });
  return { lines, speakers };
}

async function transcribeResource(resourceId) {
  const r = await repo.getResource(resourceId);
  if (!r || r.type !== 'audio') return;
  const core = await repo.readCore();
  const project = core.projects[r.projectId];
  const people = project ? projectPeople(core, project).map(p => p.name) : [];
  const { lines, speakers } = await transcribeAudio(r.audio, transcriptionPrompt({ people }));
  await repo.updateResource(resourceId, res => {
    res.audio.lines = lines;
    res.audio.speakers = speakers;
    res.audio.transcribedAt = now();
    res.audio.status = speakers.length ? 'identify' : 'ready';
    res.audio.error = null;
  });
}

// A project's teachers: for a class's group project everyone listed as teaching
// the class (owner first), else the one who made it. Students get this list, so
// advisors aren't in it.
function projectTeacherIds(core, project) {
  const cls = project.classId ? own(core.classes, project.classId) : null;
  return cls ? [...new Set([project.teacherId, ...classes.teacherIdsOf(cls)])] : [project.teacherId];
}
// Everyone who could be a voice in a project's recording, a class's advisors too
function projectPeople(core, project) {
  const list = project.studentIds.map(id => core.users[id]).filter(Boolean).map(u => ({ id: u.id, name: `${u.firstName} ${u.lastName}`, role: 'student', avatarColor: u.avatarColor || null }));
  const cls = project.classId ? own(core.classes, project.classId) : null;
  for (const id of new Set([...projectTeacherIds(core, project), ...(cls ? classes.staffIdsOf(cls) : [])])) {
    const t = own(core.users, id);
    if (t) list.push({ id: t.id, name: `${t.firstName} ${t.lastName}`, role: 'teacher', avatarColor: t.avatarColor || null });
  }
  return list;
}

// Public view of a resource: script lines use assigned names when known.
// Recordings are only reachable through the signed-in /audio route.
function publicResource(r) {
  if (r.type === 'audio') {
    const a = r.audio;
    const nameFor = label => a.speakers?.find(s => s.label === label)?.assignedName || label;
    return {
      id: r.id, projectId: r.projectId, type: 'audio', title: r.title, uploadedBy: r.uploadedBy, uploadedByName: r.uploadedByName, uploadedAt: r.uploadedAt,
      duration: a.duration || null, url: `/api/projects/${r.projectId}/resources/${r.id}/audio`, status: a.status, error: a.error || null,
      speakers: (a.speakers || []).map(s => ({ ...s })),
      script: a.status === 'ready' || a.status === 'identify' ? (a.lines || []).map(l => ({ t: l.t, speaker: nameFor(l.speaker), label: l.speaker, text: l.text })) : [],
      lineCount: (a.lines || []).length,
      unassigned: (a.speakers || []).filter(s => !s.assignedName).length
    };
  }
  return { id: r.id, projectId: r.projectId, type: 'extension', source: r.report?.source || 'legacy', title: r.title, uploadedBy: r.uploadedBy, uploadedByName: r.uploadedByName, uploadedAt: r.uploadedAt, report: r.report };
}

// ═══════════════════════════════════════════════════════════════
// SECTION 7 — PROJECTS
// ═══════════════════════════════════════════════════════════════

function newProjectCode(core) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const taken = new Set([...Object.values(core.projects).map(p => p.code), ...Object.values(core.classes || {}).map(c => c.joinCode)]);
  let code;
  do { code = Array.from(crypto.randomBytes(6)).map(b => alphabet[b % alphabet.length]).join(''); } while (taken.has(code));
  return code;
}

async function projectResources(project) {
  const list = await repo.listResources(project.id);
  return (await Promise.all(list.map(reconcileStale))).map(publicResource);
}

function publicProject(core, project, me, { resources, resourceCount } = {}) {
  const isTeacher = isProjectTeacher(core, project, me.id);
  const cls = project.classId ? own(core.classes, project.classId) : null;
  const out = {
    id: project.id, name: project.name, code: isTeacher ? project.code : undefined,
    teacher: isTeacher ? publicUser(core.users[project.teacherId]) : nameOnly(core.users[project.teacherId]),
    teachers: projectTeacherIds(core, project).map(id => own(core.users, id)).filter(Boolean).map(u => ({ ...(isTeacher ? publicUser(u) : nameOnly(u)), ...(cls && classes.staffRole(cls, u.id) === 'assistant' ? { assistant: true } : {}) })),
    students: project.studentIds.map(id => publicUser(core.users[id])).filter(Boolean),
    showAnalysis: !!project.showAnalysis, isTeacher, createdAt: project.createdAt,
    classId: project.classId || null, assignmentId: project.assignmentId || null,
    hasAnalysis: !!project.lastAnalyzedAt, lastAnalyzedAt: project.lastAnalyzedAt || null,
    resourceCount: resources ? resources.length : (resourceCount || 0)
  };
  if (resources) out.resources = resources;
  return out;
}
async function fullProject(core, project, me) {
  const out = publicProject(core, project, me, { resources: await projectResources(project) });
  // Visor Classroom: a group project links back to its class and assignment
  if (project.classId && own(core.classes, project.classId)) {
    const a = project.assignmentId ? await repo.getRecord('assignment', project.assignmentId) : null;
    out.breadcrumb = { classId: project.classId, className: core.classes[project.classId].name, assignmentId: a?.id || null, assignmentTitle: a?.title || null };
    out.docUrl = project.docUrl || null;
  }
  return out;
}

app.get('/api/projects', requireAuth, ah(async (req, res) => {
  const core = await repo.readCore();
  const me = currentUser(req, core);
  if (!me) return res.status(401).json({ error: 'not signed in' });
  const mineRaw = Object.values(core.projects)
    .filter(p => isProjectTeacher(core, p, me.id) || p.studentIds.includes(me.id))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const counts = await repo.countResources(mineRaw.map(p => p.id));
  const mine = mineRaw.map(p => publicProject(core, p, me, { resourceCount: counts[p.id] || 0 }));
  res.json({ projects: mine });
}));

app.post('/api/projects', requireAuth, requireTeacher, ah(async (req, res) => {
  const name = cleanText(req.body?.name, 120);
  if (!name) return res.status(400).json({ error: 'Give the project a name' });
  const out = await repo.withCore(core => {
    const me = currentUser(req, core);
    const project = { id: uid(), name, orgId: me.orgId, teacherId: me.id, studentIds: [], code: newProjectCode(core), showAnalysis: false, createdAt: now() };
    core.projects[project.id] = project;
    return publicProject(core, project, me, { resources: [] });
  });
  res.json({ project: out });
}));

app.get('/api/projects/:id', requireAuth, ah(async (req, res) => {
  const core = await repo.readCore();
  const got = projectFor(req, core);
  res.json({ project: await fullProject(core, got.project, got.me) });
}));

app.patch('/api/projects/:id', requireAuth, ah(async (req, res) => {
  const { name, showAnalysis } = req.body || {};
  const { core, got } = await repo.withCore(core => {
    const got = projectFor(req, core);
    if (!got.isTeacher) throw new HttpError(403, 'only the teacher can change project settings');
    if (cleanText(name, 120)) got.project.name = cleanText(name, 120);
    if (typeof showAnalysis === 'boolean') got.project.showAnalysis = showAnalysis;
    return { core, got };
  });
  res.json({ project: await fullProject(core, got.project, got.me) });
}));

app.delete('/api/projects/:id', requireAuth, ah(async (req, res) => {
  const core = await repo.readCore();
  const got = projectFor(req, core);
  if (!got.isTeacher) return res.status(403).json({ error: 'only the teacher can delete a project' });
  for (const r of await repo.listResources(got.project.id)) if (r.type === 'audio') await audioStorage.deleteAudio(r.audio);
  await repo.deleteProjectData(got.project.id);
  await repo.withCore(c => { delete c.projects[got.project.id]; });
  res.json({ ok: true });
}));

// Students
app.post('/api/projects/:id/students', requireAuth, ah(async (req, res) => {
  const { core, got } = await repo.withCore(core => {
    const got = projectFor(req, core);
    if (!got.isTeacher) throw new HttpError(403, 'only the teacher can add students');
    const student = core.users[req.body?.userId];
    if (!student || student.role !== 'student') throw new HttpError(404, 'student not found');
    if (!got.project.studentIds.includes(student.id)) got.project.studentIds.push(student.id);
    return { core, got };
  });
  res.json({ project: await fullProject(core, got.project, got.me) });
}));

app.delete('/api/projects/:id/students/:userId', requireAuth, ah(async (req, res) => {
  const { core, got } = await repo.withCore(core => {
    const got = projectFor(req, core);
    if (!got.isTeacher) throw new HttpError(403, 'only the teacher can remove students');
    got.project.studentIds = got.project.studentIds.filter(id => id !== req.params.userId);
    return { core, got };
  });
  res.json({ project: await fullProject(core, got.project, got.me) });
}));

// ═══════════════════════════════════════════════════════════════
// SECTION 8 — RESOURCES
// ═══════════════════════════════════════════════════════════════

// ---- Recordings ----


// Uploading a recording takes three steps, so files up to 60 MB fit through the
// hosting request limits:
//   1. POST .../audio/uploads        { filename, mime, size } → { uploadToken, chunkBytes }
//   2. PUT  .../audio/uploads/chunk?offset=N   (raw bytes, X-Upload-Token header), in order
//   3. POST .../audio                { uploadToken, filename, title, duration } → the new resource
// The upload token is signed, so it can't be pointed at another project or file.
const UPLOAD_TOKEN_MS = 3 * 60 * 60 * 1000;

async function readUploadToken(req, token) {
  const t = verify(await getSessionSecret(), String(token || ''), 'audio-upload');
  if (!t || t.kind !== 'audio-upload' || t.exp < Date.now() || t.projectId !== req.params.id || t.userId !== req.session.userId) {
    throw new HttpError(400, 'That upload has expired or is not valid. Start the upload again.');
  }
  return t.up;
}

app.post('/api/projects/:id/resources/audio/uploads', requireAuth, ah(async (req, res) => {
  const got = projectFor(req, await repo.readCore());
  const { filename, mime } = req.body || {};
  const size = Number(req.body?.size);
  if (!Number.isInteger(size) || size <= 0) return res.status(400).json({ error: 'no audio received' });
  if (size > audioStorage.MAX_AUDIO_BYTES) return res.status(413).json({ error: 'That file is over 60 MB. Try a shorter or more compressed recording.' });
  const { mimeType, fileExt } = audioMime(filename, mime);
  const up = await audioStorage.startUpload({ projectId: got.project.id, ext: fileExt, mime: mimeType, size });
  const uploadToken = sign(await getSessionSecret(), { kind: 'audio-upload', up, projectId: got.project.id, userId: got.me.id, exp: Date.now() + UPLOAD_TOKEN_MS }, 'audio-upload');
  res.json({ uploadToken, chunkBytes: audioStorage.CHUNK_BYTES });
}));

app.put('/api/projects/:id/resources/audio/uploads/chunk', requireAuth, express.raw({ type: () => true, limit: '6mb' }), ah(async (req, res) => {
  projectFor(req, await repo.readCore()); // still a member of the project
  const up = await readUploadToken(req, req.get('X-Upload-Token'));
  const offset = Number(req.query.offset);
  const buf = Buffer.isBuffer(req.body) ? req.body : (Buffer.isBuffer(req.rawBody) ? req.rawBody : null);
  if (!Number.isInteger(offset) || offset < 0 || !buf || !buf.length) return res.status(400).json({ error: 'That piece of the upload is missing.' });
  res.json(await audioStorage.writeChunk(up, offset, buf));
}));

app.post('/api/projects/:id/resources/audio', requireAuth, ah(async (req, res) => {
  const got = projectFor(req, await repo.readCore());
  const { uploadToken, filename, title, duration } = req.body || {};
  if (!uploadToken) return res.status(400).json({ error: 'no audio received' });
  const up = await readUploadToken(req, uploadToken);
  // One resource per uploaded file: the id comes from the file's own name, so a
  // double click or a retry can't make two resources share (and later delete) one file.
  const id = crypto.createHash('sha256').update(String(up.path || up.file)).digest('hex').slice(0, 32);
  if (await repo.getResource(id)) return res.status(409).json({ error: 'That recording was already added.' });
  const audio = await audioStorage.finishUpload(up);
  const r = {
    id, projectId: got.project.id, type: 'audio',
    title: String(title || filename || 'Recording').replace(/\.[a-z0-9]+$/i, '').trim() || 'Recording',
    uploadedBy: got.me.id, uploadedByName: `${got.me.firstName} ${got.me.lastName}`, uploadedAt: now(),
    audio: { ...audio, duration: Number(duration) || null, status: 'transcribing', startedAt: now(), error: null, lines: [], speakers: [] }
  };
  await repo.putResource(r);
  await startTranscription(id);
  res.json({ resource: publicResource(r) });
}));

// Play a recording (members only)
app.get('/api/projects/:id/resources/:rid/audio', requireAuth, ah(async (req, res) => {
  const got = projectFor(req, await repo.readCore());
  const r = await resourceFor(got, req.params.rid, 'audio');
  await audioStorage.streamAudio(r.audio, req, res);
}));

app.get('/api/projects/:id/resources/:rid', requireAuth, ah(async (req, res) => {
  const got = projectFor(req, await repo.readCore());
  const r = await resourceFor(got, req.params.rid);
  res.json({ resource: publicResource(r) });
}));

// Retry a failed transcription
app.post('/api/projects/:id/resources/:rid/retranscribe', requireAuth, ah(async (req, res) => {
  const got = projectFor(req, await repo.readCore());
  await resourceFor(got, req.params.rid, 'audio');
  let started = false;
  const r = await repo.updateResource(req.params.rid, x => {
    started = false;
    if (x.audio.status !== 'error') return;
    x.audio.status = 'transcribing'; x.audio.error = null; x.audio.speakers = []; x.audio.lines = []; x.audio.startedAt = now();
    started = true;
  });
  if (!started) return res.status(409).json({ error: 'This recording is already transcribed or transcribing.' });
  await startTranscription(r.id);
  res.json({ resource: publicResource(r) });
}));

// Tell us who each voice is. Body: { assignments: { "Speaker 1": { name, userId? }, ... } }
app.post('/api/projects/:id/resources/:rid/speakers', requireAuth, ah(async (req, res) => {
  const core = await repo.readCore();
  const got = projectFor(req, core);
  await resourceFor(got, req.params.rid, 'audio');
  const assignments = req.body?.assignments || {};
  const r = await repo.updateResource(req.params.rid, x => {
    for (const sp of x.audio.speakers || []) {
      const a = assignments[sp.label];
      if (a === undefined) continue;
      if (a === null || a.name === null) { sp.assignedName = null; sp.assignedUserId = null; continue; }
      if (typeof a !== 'object') continue;
      const name = String(a.name || '').trim();
      if (!name) continue;
      sp.assignedName = name;
      sp.assignedUserId = a.userId && own(core.users, a.userId) ? a.userId : null;
    }
    // Two labels assigned to the same person collapse into one voice in the script; that's fine.
    x.audio.status = (x.audio.speakers || []).every(s => s.assignedName) ? 'ready' : 'identify';
  });
  res.json({ resource: publicResource(r) });
}));

app.patch('/api/projects/:id/resources/:rid', requireAuth, ah(async (req, res) => {
  const got = projectFor(req, await repo.readCore());
  await resourceFor(got, req.params.rid);
  const title = req.body?.title;
  const r = await repo.updateResource(req.params.rid, x => { if (typeof title === 'string' && title.trim()) x.title = title.trim(); });
  res.json({ resource: publicResource(r) });
}));

app.delete('/api/projects/:id/resources/:rid', requireAuth, ah(async (req, res) => {
  const got = projectFor(req, await repo.readCore());
  const r = await resourceFor(got, req.params.rid);
  if (!got.isTeacher && r.uploadedBy !== got.me.id) return res.status(403).json({ error: 'only the teacher or the person who added it can remove this' });
  if (r.type === 'audio') await audioStorage.deleteAudio(r.audio);
  await repo.deleteResource(r.id);
  res.json({ ok: true });
}));

// ---- Document reports (Visor extension, Google Drive, or pasted JSON) ----

// Re-sending the same document replaces its earlier report instead of adding a duplicate.
async function upsertDocumentResource(project, report, uploadedBy, uploadedByName) {
  if (report.fileId) {
    for (const r of await repo.listResources(project.id)) {
      if (r.type === 'extension' && r.report?.fileId === report.fileId) await repo.deleteResource(r.id);
    }
  }
  const r = { id: uid(), projectId: project.id, type: 'extension', title: report.title, uploadedBy, uploadedByName, uploadedAt: now(), report };
  await repo.putResource(r);
  return r;
}

// Paste a report by hand
app.post('/api/projects/:id/resources/extension', requireAuth, ah(async (req, res) => {
  const got = projectFor(req, await repo.readCore());
  let report = req.body?.report;
  if (typeof report === 'string') { try { report = JSON.parse(report); } catch { return res.status(400).json({ error: 'That is not valid JSON' }); } }
  const norm = normalizeReport(report);
  if (!norm) return res.status(400).json({ error: 'That does not look like a Visor extension report' });
  const r = await upsertDocumentResource(got.project, norm, got.me.id, `${got.me.firstName} ${got.me.lastName}`);
  res.json({ resource: publicResource(r) });
}));

// Google Drive: the browser sends the picked file's id and a short-lived
// drive.file access token. The token is used for this request only.
app.post('/api/projects/:id/resources/drive', requireAuth, ah(async (req, res) => {
  const got = projectFor(req, await repo.readCore());
  const { fileId, accessToken } = req.body || {};
  if (!fileId || !accessToken) return res.status(400).json({ error: 'Pick a file first.' });
  const { file, result } = await analyzeDriveFile(String(fileId), String(accessToken));
  const report = buildDriveReport(file, result);
  const r = await upsertDocumentResource(got.project, report, got.me.id, `${got.me.firstName} ${got.me.lastName}`);
  res.json({ resource: publicResource(r) });
}));

// The extension posts here with the project code; no sign-in needed
app.post('/api/extension/ingest', ah(async (req, res) => {
  const code = String(req.body?.code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: 'code is required' });
  const core = await repo.readCore();
  const project = Object.values(core.projects).find(p => p.code === code);
  if (!project) return res.status(404).json({ error: 'no project with that code' });
  const norm = normalizeReport(req.body?.report);
  if (!norm) return res.status(400).json({ error: 'report is missing or not in a recognized shape' });
  const r = await upsertDocumentResource(project, norm, null, 'Visor extension');
  res.json({ ok: true, group: { id: project.id, name: project.name }, project: { id: project.id, name: project.name }, resource: { id: r.id, title: r.title } });
}));
app.get('/api/extension/group/:code', ah(async (req, res) => {
  const core = await repo.readCore();
  const project = Object.values(core.projects).find(p => p.code === String(req.params.code).toUpperCase());
  if (!project) return res.status(404).json({ error: 'no project with that code' });
  res.json({ id: project.id, name: project.name, memberCount: project.studentIds.length });
}));

// ═══════════════════════════════════════════════════════════════
// SECTION 9 — ANALYSIS
// ═══════════════════════════════════════════════════════════════

const nameKey = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const firstName = s => String(s || '').trim().split(/\s+/)[0].toLowerCase();
function matchPerson(people, { name, email }) {
  if (email) { const p = people.find(p => p.email && p.email.toLowerCase() === email.toLowerCase()); if (p) return p; }
  const nk = nameKey(name);
  if (nk) {
    const p = people.find(p => nameKey(p.name) === nk); if (p) return p;
    const f = people.filter(p => firstName(p.name) === firstName(name)); if (f.length === 1) return f[0];
  }
  return null;
}

function classifyRole(c) {
  if (c.extRevisions === 0 && c.inRecordings) return 'Commenter';
  if (c.pct < 10) return 'Minimal Contributor';
  if (c.extWordsAdded > 0 && c.extWordsRemoved > c.extWordsAdded) return 'Active Editor';
  return 'Primary Writer';
}
function calculateFairness(contributors) {
  if (contributors.length <= 1) return 100;
  const ideal = 100 / contributors.length;
  const avgDev = contributors.reduce((s, c) => s + Math.abs(c.pct - ideal), 0) / contributors.length;
  return Math.max(0, Math.round(100 - avgDev * 2));
}

const SOURCE_LABEL = { 'visor-extension': 'Visor extension, every edit', drive: 'Google Drive saved snapshots, coarser', legacy: 'extension report' };

// Writing habits from extension reports (exact edit-by-edit figures), summed
// across every document a person worked on.
function addHabits(p, c, rep) {
  const x = c.measures;
  const h = p.habits || (p.habits = { docs: 0, inserted: 0, typed: 0, deleted: 0, externalPastes: 0, externalChars: 0, internalChars: 0, activeMinutes: 0, sessions: 0, wpmWeighted: 0, wpmMinutes: 0, first: null, last: null, bigPastes: [] });
  h.docs++;
  h.inserted += x.insertedChars || 0; h.typed += x.typedChars || 0; h.deleted += x.deletedChars || 0;
  h.externalPastes += x.externalPastes || 0; h.externalChars += x.externalPastedChars || 0; h.internalChars += x.internalPastedChars || 0;
  h.activeMinutes += x.activeMinutes || 0; h.sessions += x.sessions || 0;
  if (x.wpm != null && x.activeMinutes) { h.wpmWeighted += x.wpm * x.activeMinutes; h.wpmMinutes += x.activeMinutes; }
  if (x.firstEdit && (!h.first || x.firstEdit < h.first)) h.first = x.firstEdit;
  if (x.lastEdit && (!h.last || x.lastEdit > h.last)) h.last = x.lastEdit;
  const mine = (rep.detail?.pastes || []).filter(e => e.origin === 'external' && c.key != null && e.who === c.key);
  for (const e of mine) h.bigPastes.push({ doc: rep.title, time: e.time, length: e.length });
}
function finishHabits(h) {
  if (!h) return null;
  const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);
  return {
    docs: h.docs, insertedChars: h.inserted, deletedChars: h.deleted,
    typedPct: pct(h.typed, h.inserted), externalPct: pct(h.externalChars, h.inserted), internalPct: pct(h.internalChars, h.inserted),
    externalPastes: h.externalPastes, externalPastedChars: h.externalChars, internalPastedChars: h.internalChars,
    activeMinutes: Math.round(h.activeMinutes), sessions: h.sessions, wpm: h.wpmMinutes ? Math.round(h.wpmWeighted / h.wpmMinutes) : null,
    firstEdit: h.first, lastEdit: h.last,
    largestExternalPastes: h.bigPastes.sort((a, b) => b.length - a.length).slice(0, 3)
  };
}
const shortDate = t => (t ? new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '?');
const mins = m => { m = Math.round(Number(m) || 0); if (m < 60) return `${m}m`; const h = Math.floor(m / 60), r = m % 60; return r ? `${h}h ${r}m` : `${h}h`; };

async function analyzeProject(core, project) {
  const resources = await Promise.all((await repo.listResources(project.id)).map(reconcileStale));
  if (!resources.length) throw new HttpError(400, 'Add at least one resource first');
  const members = projectPeople(core, project);
  const students = members.filter(m => m.role === 'student');
  for (const m of members) m.email = core.users[m.id]?.email || null;

  const people = [];
  const getPerson = ({ id, name, email }) => {
    let p = id ? people.find(x => x.id === id) : null;
    if (!p) p = matchPerson(people, { name, email });
    if (!p) { p = { id: id || `name:${nameKey(name)}`, name, email: email || null, ext: { revisions: 0, wordsAdded: 0, wordsRemoved: 0, roles: [], weighted: 0 }, habits: null, speak: { sum: 0, n: 0 } }; people.push(p); }
    return p;
  };
  // Seed with members so names (and school emails) normalize to their real names
  for (const m of members) getPerson({ id: m.id, name: m.name, email: m.email });

  const perResource = [];
  const errors = [];

  // Each document's contributor shares are weighted by the document's length, so
  // sources that count different things (every edit vs. saved revisions) mix fairly.
  const extReports = resources.filter(r => r.type === 'extension' && r.report);
  let weightTotal = 0;
  for (const r of extReports) {
    const rep = r.report;
    const weight = Math.max(1, Number(rep.wordCount) || 0);
    const pctTotal = rep.contributors.reduce((s, c) => s + (Number(c.percentContribution) || 0), 0);
    if (pctTotal) weightTotal += weight;
    const contributors = rep.contributors.map(c => {
      const p = getPerson({ name: c.name, email: c.email });
      p.ext.revisions += c.revisionCount; p.ext.wordsAdded += c.wordsAdded; p.ext.wordsRemoved += c.wordsRemoved; if (c.role) p.ext.roles.push(c.role);
      if (rep.source === 'visor-extension' && c.measures) addHabits(p, c, rep);
      if (pctTotal) p.ext.weighted += weight * ((Number(c.percentContribution) || 0) / pctTotal);
      return { id: p.id, name: p.name, count: c.revisionCount, pct: c.percentContribution, role: c.role };
    });
    perResource.push({ id: r.id, title: rep.title, type: 'extension', source: rep.source || 'legacy', total: rep.revisionCount || contributors.reduce((s, c) => s + c.count, 0), summary: rep.overallSummary, contributors });
  }

  const transcripts = [];
  for (const r of resources.filter(r => r.type === 'audio')) {
    const a = r.audio;
    if (a.status === 'transcribing') { errors.push(`"${r.title}" is still being transcribed`); continue; }
    if (a.status === 'error') { errors.push(`"${r.title}" could not be transcribed: ${a.error}`); continue; }
    const pub = publicResource(r);
    const unnamed = (a.speakers || []).filter(s => !s.assignedName).map(s => s.label);
    if (unnamed.length) errors.push(`"${r.title}" still has unnamed voices (${unnamed.join(', ')}); their lines are marked as unknown`);
    // Register named voices as people so the report can match them (no numbers attached)
    for (const sp of a.speakers || []) if (sp.assignedName) getPerson({ id: sp.assignedUserId || undefined, name: sp.assignedName });
    const names = Array.from(new Set(pub.script.map(l => l.speaker)));
    transcripts.push({ id: r.id, title: r.title, script: pub.script, names });
    perResource.push({ id: r.id, title: r.title, type: 'audio', lines: pub.script.length, names });
  }

  // Numeric baseline comes from the documents only. Recordings go to Gemini as raw scripts.
  const extTotal = people.reduce((s, p) => s + p.ext.revisions, 0);
  let contributors = people.map(p => {
    const extPct = weightTotal ? (p.ext.weighted / weightTotal) * 100 : 0;
    return { id: p.id, name: p.name, extRevisions: p.ext.revisions, extWordsAdded: p.ext.wordsAdded, extWordsRemoved: p.ext.wordsRemoved, extPct: Math.round(extPct), pct: Math.round(extPct), inRecordings: transcripts.some(t => t.names.includes(p.name)), isMember: !!members.find(m => m.id === p.id), habits: finishHabits(p.habits) };
  }).filter(c => c.extRevisions > 0 || c.inRecordings);
  contributors.sort((a, b) => b.pct - a.pct);
  const sum = contributors.reduce((s, c) => s + c.pct, 0);
  if (sum && sum !== 100 && contributors.length) contributors[0].pct += 100 - sum;
  for (const c of contributors) c.role = classifyRole(c);
  // Teachers are never part of the group's workload
  const teacherIds = new Set(members.filter(m => m.role === 'teacher').map(m => m.id));
  const fairnessScore = calculateFairness(contributors.filter(c => !teacherIds.has(c.id)));
  const silentMembers = students.filter(m => !contributors.some(c => c.id === m.id)).map(m => m.name);

  // Prompt
  const L = [];
  L.push(`PROJECT: ${project.name}`);
  L.push(`STUDENTS: ${students.map(s => s.name).join(', ') || '(none added yet)'}`);
  const teacherNames = members.filter(m => m.role === 'teacher').map(m => m.name);
  L.push(`${teacherNames.length > 1 ? 'TEACHERS' : 'TEACHER'}: ${teacherNames.join(', ') || '?'}`);
  if (silentMembers.length) L.push(`STUDENTS WITH NO TRACKED ACTIVITY IN ANY SOURCE: ${silentMembers.join(', ')}`);
  L.push('', '=== SOURCE 1: DOCUMENT REPORTS (Visor extension = every edit and paste; Google Drive = periodic saved snapshots) ===');
  if (!extReports.length) L.push('(none)');
  for (const r of extReports) {
    const rep = r.report;
    L.push(`Document: "${rep.title}" (${rep.docType}; source: ${SOURCE_LABEL[rep.source] || SOURCE_LABEL.legacy}) — ${rep.revisionCount} ${rep.revisionLabel || 'revisions'}, ~${rep.wordCount} words`);
    if (rep.overallSummary) L.push(`  Overview: ${rep.overallSummary}`);
    for (const c of rep.contributors) {
      L.push(`  - ${c.name}: ${c.revisionCount} ${rep.revisionLabel || 'revisions'} (${c.percentContribution}% of the text), +${c.wordsAdded}/-${c.wordsRemoved} words, role: ${c.role}`);
      if (c.summary) L.push(`      ${c.summary}`);
      if (c.keyContributions?.length) L.push(`      key: ${c.keyContributions.join('; ')}`);
    }
  }
  L.push('', '=== SOURCE 2: MEETING RECORDINGS (word-for-word scripts; voices identified by the students) ===');
  if (!transcripts.length) L.push('(none)');
  for (const t of transcripts) {
    L.push(`Recording: "${t.title}" — people heard: ${t.names.join(', ')}`);
    const text = t.script.map(l => `${l.t ? '[' + l.t + '] ' : ''}${l.speaker}: ${l.text}`).join('\n');
    L.push('  Script:\n' + (text.length > 9000 ? text.slice(0, 9000) + '\n  […truncated]' : text).split('\n').map(x => '    ' + x).join('\n'));
  }
  const withHabits = contributors.filter(c => c.habits);
  if (withHabits.length) {
    L.push('', '=== WRITING HABITS (Visor extension, exact counts across all of their documents) ===');
    for (const c of withHabits) {
      const h = c.habits;
      L.push(`  - ${c.name}: ${h.insertedChars} characters inserted in ${h.docs} document${h.docs === 1 ? '' : 's'}: ${h.typedPct}% typed, ${h.internalPct}% internal pastes, ${h.externalPct}% external pastes (${h.externalPastes} paste${h.externalPastes === 1 ? '' : 's'}, ${h.externalPastedChars} characters); ${h.deletedChars} characters deleted; ${mins(h.activeMinutes)} of active writing in ${h.sessions} session${h.sessions === 1 ? '' : 's'}${h.wpm ? `; typing speed ${h.wpm} wpm` : ''}; active ${shortDate(h.firstEdit)} to ${shortDate(h.lastEdit)}`);
      for (const e of h.largestExternalPastes) L.push(`      external paste: ${e.length} characters into "${e.doc}" on ${shortDate(e.time)}`);
    }
  }
  L.push('', '=== DOCUMENT BASELINE (each person\'s share of the writing, averaged across documents weighted by length; a starting point, adjust with judgment) ===');
  for (const c of contributors) L.push(`  - ${c.name}: ${c.extPct}% of the document writing — ${c.role}${c.inRecordings ? ' (heard in recordings)' : ''}`);
  L.push(`Fairness score: ${fairnessScore}/100 (100 = perfectly even)`);

  const prompt = `You are Visor, an AI that helps a teacher see who actually did the work on a student group project. You are fair, specific, and evidence-based. Never invent facts that are not in the data.

${L.join('\n')}

Using ALL sources together, produce a report. Rules:
- Estimate each student's share of the total workload as a percentage; shares must sum to 100. Start from the document baseline and adjust using what the recordings show: read the scripts yourself and judge who proposed ideas, made decisions, took on tasks, and who stayed quiet. The teacher is not a contributor; leave them out of the workload.
- "Who did what" must be concrete: name actual tasks, sections, decisions, or deliverables, and who owned them. Cite the source for each (extension, drive, or recording).
- If a student appears in no source, say so plainly and give them a low share; do not guess at hidden work.
- Distinguish producing (writing, building slides) from discussing (talking in meetings). Talking is real contribution but weighs less than producing.
- External pastes are text that arrived from outside the document. Mention them as something to look at, never as proof of wrongdoing; internal pastes (copying or moving text within the document) are ordinary editing.
- Use the writing habits where they help: who wrote steadily across many sessions versus in one sitting, who typed their text versus pasted it in, who edited and cut text. Cite the numbers in "evidence".
- Neutral tone. Flag concerns without accusing.

Return ONLY JSON in exactly this shape:
{
  "executiveSummary": "3-5 sentences for the teacher",
  "workload": [ { "name": "student name exactly as above", "percent": <integer>, "role": "Primary Writer|Active Editor|Coordinator|Commenter|Minimal Contributor|Absent", "confidence": "high|medium|low", "whatTheyDid": ["specific thing", "specific thing", "specific thing"], "evidence": "one or two sentences citing numbers and sources" } ],
  "whoDidWhat": [ { "task": "specific task, section, decision or deliverable", "owner": "name (or names, comma separated)", "source": "extension|drive|recording|multiple" } ],
  "recordingInsights": [ { "title": "recording title", "summary": "2-3 sentences on who drove the discussion, what was decided, and who was assigned what", "speakers": [ { "name": "name", "share": <integer: your estimate of their percent of the talking, from the script> } ] } ],
  "groupDynamics": "one paragraph on how the group worked together",
  "concerns": ["short concern"],
  "bottomLine": "one or two sentences: each student's percentage, then a grading recommendation"
}`;

  let ai = null;
  try {
    // The teacher is never part of the workload (the prompt says so; this keeps the fill-in step from adding them back)
    ai = sanitizeAIReport(await geminiJSON([{ text: prompt }], { temperature: 0.3, maxOutputTokens: 5000 }), contributors.filter(c => c.isMember !== false && !teacherIds.has(c.id)));
  } catch (err) {
    console.error('gemini report error:', err.message);
    errors.push(`Gemini could not write the report: ${err.message}`);
  }

  return {
    at: now(), ai, contributors, perResource, fairnessScore, totalEvents: extTotal,
    sources: { extensionReports: extReports.filter(r => r.report.source !== 'drive').length, driveReports: extReports.filter(r => r.report.source === 'drive').length, transcripts: transcripts.length },
    silentMembers, errors
  };
}

function sanitizeAIReport(ai, contributors) {
  const out = {
    executiveSummary: String(ai.executiveSummary || ''),
    workload: (Array.isArray(ai.workload) ? ai.workload : []).map(w => ({ name: String(w.name || ''), percent: Math.max(0, Math.round(Number(w.percent) || 0)), role: String(w.role || ''), confidence: String(w.confidence || 'medium'), whatTheyDid: Array.isArray(w.whatTheyDid) ? w.whatTheyDid.map(String).slice(0, 8) : [], evidence: String(w.evidence || '') })),
    whoDidWhat: (Array.isArray(ai.whoDidWhat) ? ai.whoDidWhat : []).map(t => ({ task: String(t.task || ''), owner: String(t.owner || ''), source: String(t.source || '') })).filter(t => t.task),
    recordingInsights: (Array.isArray(ai.recordingInsights) ? ai.recordingInsights : []).map(r => ({ title: String(r.title || ''), summary: String(r.summary || ''), speakers: Array.isArray(r.speakers) ? r.speakers.map(s => ({ name: String(s.name || ''), share: Math.round(Number(s.share) || 0) })) : [] })),
    groupDynamics: String(ai.groupDynamics || ''),
    concerns: (Array.isArray(ai.concerns) ? ai.concerns : []).map(String).filter(Boolean),
    bottomLine: String(ai.bottomLine || '')
  };
  for (const c of contributors) if (!out.workload.some(w => nameKey(w.name) === nameKey(c.name))) out.workload.push({ name: c.name, percent: c.pct, role: c.role, confidence: 'medium', whatTheyDid: [], evidence: 'Share taken from the numeric baseline.' });
  const sum = out.workload.reduce((s, w) => s + w.percent, 0);
  if (sum > 0 && sum !== 100) { out.workload.forEach(w => { w.percent = Math.round((w.percent / sum) * 100); }); const s2 = out.workload.reduce((s, w) => s + w.percent, 0); if (s2 !== 100) out.workload[0].percent += 100 - s2; }
  out.workload.sort((a, b) => b.percent - a.percent);
  return out;
}

function canSeeAnalysis(got) { return got.isTeacher || !!got.project.showAnalysis; }

app.post('/api/projects/:id/analyze', requireAuth, ah(async (req, res) => {
  const core = await repo.readCore();
  const got = projectFor(req, core);
  if (!got.isTeacher) return res.status(403).json({ error: 'only the teacher can run the analysis' });
  const result = await analyzeProject(core, got.project);
  await repo.putAnalysis(got.project.id, result);
  await repo.withCore(c => { if (c.projects[got.project.id]) c.projects[got.project.id].lastAnalyzedAt = result.at; });
  res.json({ analysis: result });
}));

app.get('/api/projects/:id/analysis', requireAuth, ah(async (req, res) => {
  const got = projectFor(req, await repo.readCore());
  if (!canSeeAnalysis(got)) return res.status(403).json({ error: 'the teacher has not shared the analysis with students' });
  res.json({ analysis: await repo.getAnalysis(got.project.id) });
}));

// ═══════════════════════════════════════════════════════════════
// SECTION 10 — CLASSES
// ═══════════════════════════════════════════════════════════════
//
// A teacher's classes and rosters (lib/classes.js). Assignments, student
// documents and everything else a class owns are generic records keyed by
// classId, so a class page is one core read plus a few record lists.

const meOrThrow = (req, core) => { const me = currentUser(req, core); if (!me) throw new HttpError(401, 'not signed in'); return me; };
function classFor(req, core, id = req.params.id) {
  return classes.classFor(core, meOrThrow(req, core), id);
}
const fullName = u => (u ? `${u.firstName} ${u.lastName}`.trim() : '');

// Live sessions: not ended, and heard from in the last 3 minutes.
const isLive = s => s.state !== 'ended' && Date.now() - Date.parse(s.lastBeat || s.startedAt || 0) < 3 * 60 * 1000;

// Counts and upcoming work for a class card. `loaded` passes on lists the
// caller already read (the class page), so they aren't read twice.
async function classSummary(cls, isTeacher, meId, loaded = {}) {
  const assignments = (loaded.assignments || await repo.listRecords('assignment', { classId: cls.id })).filter(a => isTeacher || a.publishedAt);
  const out = { assignmentCount: assignments.length, upcoming: [] };
  // What's coming up: for a student, only what's still due and not handed in
  let handedIn = new Set();
  if (isTeacher) {
    const sessions = loaded.sessions || await repo.listRecords('session', { classId: cls.id });
    const docs = loaded.docs || await repo.listRecords('doc', { classId: cls.id });
    out.activeSessions = sessions.filter(isLive).length;
    out.toReview = docs.filter(d => d.status === 'submitted').length;
  } else {
    const docs = loaded.docs || await repo.listRecords('doc', { classId: cls.id, studentId: meId });
    const done = docs.filter(d => d.status === 'submitted' || d.status === 'returned');
    out.submitted = done.length;
    handedIn = new Set(done.map(d => d.assignmentId));
  }
  const after = isTeacher ? Date.now() - 864e5 : Date.now();
  const soon = assignments.filter(a => a.publishedAt && a.dueAt && Date.parse(a.dueAt) > after && !handedIn.has(a.id))
    .sort((a, b) => (a.dueAt < b.dueAt ? -1 : 1)).slice(0, 3);
  out.upcoming = soon.map(a => ({ id: a.id, title: a.title, type: a.type, dueAt: a.dueAt }));
  return out;
}

// A class's teachers, owner first: [{ id, name, avatarColor, owner }], with
// each one's email when withEmail (the class's own teachers only)
// A teacher as a student sees them: a name and a colour, no email
const nameOnly = u => (u ? { id: u.id, name: fullName(u), avatarColor: u.avatarColor || null } : null);

function publicTeachers(core, cls, withEmail = false) {
  return classes.teacherIdsOf(cls).map(id => own(core.users, id)).filter(Boolean).map(u => {
    const t = { id: u.id, name: fullName(u), avatarColor: u.avatarColor || null, owner: u.id === cls.teacherId };
    if (classes.staffRole(cls, u.id) === 'assistant') t.assistant = true;
    if (withEmail) t.email = u.email;
    return t;
  });
}
// Advisors aren't listed as teachers, so only the class's staff get these
const publicAdvisors = (core, cls) => (cls.advisorIds || []).map(id => own(core.users, id)).filter(Boolean)
  .map(u => ({ id: u.id, name: fullName(u), email: u.email, avatarColor: u.avatarColor || null }));

// teacher: the owner. teachers: everyone listed as teaching it. isTeacher: anyone
// on the staff, advisors included.
function publicClass(core, cls, me) {
  const isTeacher = classes.isClassTeacher(cls, me.id);
  const base = {
    id: cls.id, name: cls.name, color: classes.colorFor(cls), background: classes.publicBackground(cls), archived: !!cls.archived, createdAt: cls.createdAt,
    isTeacher, isOwner: cls.teacherId === me.id, teacher: isTeacher ? publicUser(core.users[cls.teacherId]) : nameOnly(core.users[cls.teacherId]), teachers: publicTeachers(core, cls, isTeacher),
    studentCount: cls.studentIds.length
  };
  if (!isTeacher) return base;
  return {
    ...base,
    staffRole: classes.staffRole(cls, me.id), canManageStaff: classes.canManageStaff(cls, me.id), advisors: publicAdvisors(core, cls),
    joinCode: cls.joinCode, joinOpen: cls.joinOpen !== false,
    students: cls.studentIds.map(id => publicUser(core.users[id])).filter(Boolean).sort((a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName)),
    pendingInvites: cls.pendingInvites || [],
    accommodations: cls.accommodations || {},
    researchRetentionDays: cls.researchRetentionDays || 180,
    discussionConsentAt: cls.discussionConsentAt || null
  };
}

// Everything the search box can jump to, for this person: their running classes
// and the assignments in them (a student only sees published ones), their group
// projects, and for a class's staff its students. The page filters as they type.
app.get('/api/search-index', requireAuth, ah(async (req, res) => {
  const core = await repo.readCore();
  const me = meOrThrow(req, core);
  const mine = Object.values(core.classes).filter(c => !c.archived && (classes.isClassTeacher(c, me.id) || c.studentIds.includes(me.id)));
  const lists = await Promise.all(mine.map(c => repo.listRecords('assignment', { classId: c.id })));
  const out = { classes: [], assignments: [], projects: [], students: [] };
  mine.forEach((c, i) => {
    const staff = classes.isClassTeacher(c, me.id);
    out.classes.push({ id: c.id, name: c.name, color: classes.colorFor(c) });
    for (const a of lists[i]) if (staff || a.publishedAt) out.assignments.push({ id: a.id, title: a.title, type: a.type, className: c.name, draft: !a.publishedAt });
    if (staff) for (const id of c.studentIds) { const u = own(core.users, id); if (u) out.students.push({ id: u.id, name: fullName(u), classId: c.id, className: c.name }); }
  });
  for (const p of Object.values(core.projects)) if (p.studentIds.includes(me.id) || isProjectTeacher(core, p, me.id)) out.projects.push({ id: p.id, name: p.name });
  res.json(out);
}));

app.get('/api/classes', requireAuth, ah(async (req, res) => {
  const core = await repo.readCore();
  const me = meOrThrow(req, core);
  const mine = Object.values(core.classes).filter(c => classes.isClassTeacher(c, me.id) || c.studentIds.includes(me.id))
    .sort((a, b) => Number(!!a.archived) - Number(!!b.archived) || (a.createdAt < b.createdAt ? 1 : -1));
  const list = await Promise.all(mine.map(async c => ({ ...publicClass(core, c, me), ...(await classSummary(c, classes.isClassTeacher(c, me.id), me.id)) })));
  res.json({ classes: list });
}));

app.post('/api/classes', requireAuth, requireTeacher, ah(async (req, res) => {
  const out = await repo.withCore(core => { const me = meOrThrow(req, core); return publicClass(core, classes.createClass(core, me, req.body?.name), me); });
  res.json({ class: out });
}));

// Join with a class code (students)
app.post('/api/classes/join', requireAuth, ah(async (req, res) => {
  const out = await repo.withCore(core => { const me = meOrThrow(req, core); return publicClass(core, classes.joinByCode(core, me, req.body?.code), me); });
  res.json({ class: out });
}));

app.get('/api/classes/:id', requireAuth, ah(async (req, res) => {
  const core = await repo.readCore();
  const got = classFor(req, core);
  const page = await classPageFor(got);
  res.json({ class: { ...publicClass(core, got.cls, got.me), ...(await classSummary(got.cls, got.isTeacher, got.me.id, page.loaded)) }, assignments: page.assignments, folders: page.folders });
}));

function teacherClass(req, core) {
  const got = classFor(req, core);
  if (!got.isTeacher) throw new HttpError(403, 'only the class teacher can do that');
  return got;
}
const STAFF_ONLY_MESSAGE = 'Assistant teachers can’t add or remove teachers or advisors.';

app.patch('/api/classes/:id', requireAuth, ah(async (req, res) => {
  const out = await repo.withCore(core => { const got = teacherClass(req, core); classes.patchClass(got.cls, req.body || {}); return publicClass(core, got.cls, got.me); });
  res.json({ class: out });
}));

app.post('/api/classes/:id/rotate-code', requireAuth, ah(async (req, res) => {
  const out = await repo.withCore(core => { const got = teacherClass(req, core); classes.rotateCode(core, got.cls); return publicClass(core, got.cls, got.me); });
  res.json({ class: out });
}));

// { userId } or { emails: [...] }
app.post('/api/classes/:id/students', requireAuth, ah(async (req, res) => {
  const out = await repo.withCore(core => {
    const got = teacherClass(req, core);
    const result = classes.addStudents(core, got.cls, req.body || {});
    return { result, cls: publicClass(core, got.cls, got.me) };
  });
  res.json({ class: out.cls, ...out.result });
}));

app.delete('/api/classes/:id/students/:userId', requireAuth, ah(async (req, res) => {
  const out = await repo.withCore(core => { const got = teacherClass(req, core); classes.removeStudent(got.cls, req.params.userId); return publicClass(core, got.cls, got.me); });
  res.json({ class: out });
}));

app.delete('/api/classes/:id/invites', requireAuth, ah(async (req, res) => {
  const out = await repo.withCore(core => { const got = teacherClass(req, core); classes.removeInvite(got.cls, req.body?.email); return publicClass(core, got.cls, got.me); });
  res.json({ class: out });
}));

// ---- Co-teachers ----
// Any teacher of a class can add another teacher account by email. Only the
// owner removes other teachers; a co-teacher can remove themselves (leave).

// { email, role? } role: 'teacher' (a co-teacher, the default), 'assistant' or 'advisor'
app.post('/api/classes/:id/teachers', requireAuth, ah(async (req, res) => {
  const out = await repo.withCore(core => {
    const got = teacherClass(req, core);
    if (!got.canManageStaff) throw new HttpError(403, STAFF_ONLY_MESSAGE);
    classes.addTeacher(core, got.cls, req.body?.email, req.body?.role ?? 'teacher');
    return publicClass(core, got.cls, got.me);
  });
  res.json({ class: out });
}));

app.delete('/api/classes/:id/teachers/:userId', requireAuth, ah(async (req, res) => {
  const out = await repo.withCore(core => {
    const got = teacherClass(req, core);
    const userId = String(req.params.userId);
    // Removing the owner is refused below (400), whoever asks
    if (!got.canManageStaff && userId !== got.me.id && userId !== got.cls.teacherId) throw new HttpError(403, STAFF_ONLY_MESSAGE);
    classes.removeTeacher(got.cls, userId);
    // They saw the class's group-project codes, which work without signing in: new codes
    for (const p of Object.values(core.projects)) if (p.classId === got.cls.id) p.code = newProjectCode(core);
    return userId === got.me.id ? { ok: true, left: true } : { class: publicClass(core, got.cls, got.me) };
  });
  res.json(out);
}));

// ---- The banner's background ----
// POST   the picture's bytes as the body (PNG, JPEG or WebP; the page shrinks it first)
// PUT    { preset } one of Visor's designs, and/or { pos } where an uploaded picture sits
// DELETE back to the class colour
// GET    the uploaded picture, for the class's teachers and students only
// Each answers { class } (the GET answers the picture). A replaced picture is deleted.
const BG_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
async function setBackground(req, fn) {
  let old = null;
  const out = await repo.withCore(core => {
    const got = teacherClass(req, core);
    old = got.cls.background || null;
    fn(got.cls, old);
    got.cls.background = got.cls.background || null;
    return publicClass(core, got.cls, got.me);
  });
  return { out, old };
}
async function dropOldUpload(old, cls) {
  if (old?.kind === 'upload' && old.id !== cls?.background?.id) await imageStorage.deleteImage(old.stored);
}

// (Teachers only, checked before the body is read. imageBody is defined with
// the essay pictures, further down.)
app.post('/api/classes/:id/background', requireAuth, ah(async (req, res, next) => { teacherClass(req, await repo.readCore()); next(); }), (req, res, next) => imageBody(req, res, next), ah(async (req, res) => {
  const buf = Buffer.isBuffer(req.body) ? req.body : null;
  if (buf && buf.length > imageStorage.MAX_IMAGE_BYTES) return res.status(413).json({ error: IMAGE_TOO_LARGE });
  const mime = imageStorage.sniffImage(buf);
  if (!BG_TYPES.includes(mime)) throw new HttpError(400, 'Use a PNG, JPEG or WebP picture.');
  const id = crypto.randomBytes(16).toString('hex');
  const stored = await imageStorage.putImage({ docId: `classbg-${req.params.id}`, id, mime, buf });
  let result;
  try {
    result = await setBackground(req, (cls, old) => {
      cls.background = { kind: 'upload', id, mime, stored, pos: old?.kind === 'upload' && Number.isFinite(old.pos) ? old.pos : 50, by: req.session.userId, updatedAt: now() };
    });
  } catch (err) { await imageStorage.deleteImage(stored); throw err; }
  await dropOldUpload(result.old, { background: { id } });
  res.json({ class: result.out });
}));

app.put('/api/classes/:id/background', requireAuth, ah(async (req, res) => {
  const body = req.body || {};
  const has = k => Object.prototype.hasOwnProperty.call(body, k);
  if (!has('preset') && !has('pos')) throw new HttpError(400, 'Choose a background or a position.');
  let kept = null;
  const result = await setBackground(req, (cls, old) => {
    if (has('preset')) cls.background = { kind: 'preset', preset: classes.backgroundPreset(body.preset), by: req.session.userId, updatedAt: now() };
    else {
      if (old?.kind !== 'upload') throw new HttpError(400, 'Only an uploaded picture has a position.');
      cls.background = { ...old, pos: classes.backgroundPos(body.pos) };
    }
    kept = cls.background;
  });
  await dropOldUpload(result.old, { background: kept });
  res.json({ class: result.out });
}));

app.delete('/api/classes/:id/background', requireAuth, ah(async (req, res) => {
  const result = await setBackground(req, cls => { cls.background = null; });
  await dropOldUpload(result.old, null);
  res.json({ class: result.out });
}));

app.get('/api/classes/:id/background', requireAuth, ah(async (req, res) => {
  const core = await repo.readCore();
  let got;
  try { got = classFor(req, core); } catch { return res.status(404).json({ error: 'not found' }); }
  const b = got.cls.background;
  if (b?.kind !== 'upload' || !b.stored) return res.status(404).json({ error: 'not found' });
  await imageStorage.streamImage(b.stored, b.mime, res);
}));

// ---- Adding people from the teacher's school ----
// GET ?role=student|teacher&q=… -> { school, people: [{ id, name, email, role, avatarColor, inClass }], total, more }
// POST { userIds } -> { class, students, teachers, skipped }: students join, teachers become co-teachers
app.get('/api/classes/:id/school-people', requireAuth, ah(async (req, res) => {
  const core = await repo.readCore();
  const got = teacherClass(req, core);
  const out = classes.schoolPeople(core, got.cls, got.me, { role: String(req.query.role || 'student'), q: String(req.query.q || '').slice(0, 120) });
  res.json({ school: publicOrg(core.orgs[got.me.orgId]), people: out.people.map(({ user: u, inClass }) => ({ id: u.id, name: `${u.firstName} ${u.lastName}`.trim(), email: u.email, role: u.role, avatarColor: u.avatarColor || null, inClass })), total: out.total, more: out.more });
}));

app.post('/api/classes/:id/school-people', requireAuth, ah(async (req, res) => {
  const out = await repo.withCore(core => {
    const got = teacherClass(req, core);
    const result = classes.addFromSchool(core, got.cls, got.me, req.body?.userIds, req.body?.as ?? 'teacher');
    return { result, cls: publicClass(core, got.cls, got.me) };
  });
  res.json({ class: out.cls, ...out.result });
}));

// A class's folders and assignments as the class page places them
// (lib/materials.js tidies anything pointing at a folder that's gone).
async function classMaterials(classId) {
  const [folders, list] = await Promise.all([repo.listRecords('folder', { classId }), repo.listRecords('assignment', { classId })]);
  return materials.tidy(folders, list);
}

function publicFolder(f) {
  return { id: f.id, classId: f.classId, parentId: f.parentId || null, name: f.name, color: f.color || null, description: f.description || '', position: materials.effectivePosition(f), createdAt: f.createdAt, updatedAt: f.updatedAt };
}

// Where a writing assignment stands, for the teacher's class page.
function writingStats(a, docs, sessions) {
  const mine = docs.filter(d => d.assignmentId === a.id && d.studentId !== 'template');
  const count = status => mine.filter(d => d.status === status).length;
  return { submitted: count('submitted'), returned: count('returned'), inProgress: count('in-progress'), live: sessions.filter(s => s.assignmentId === a.id && isLive(s)).length };
}

// The assignments and folders on a class page. Students only see published
// assignments and the folders holding one; the teacher also gets each writing
// assignment's counts, a student their own status. `position` is the place in
// its level (lib/materials.js). `loaded` is handed on to classSummary.
async function classPageFor(got) {
  const { folders, assignments: all } = await classMaterials(got.cls.id);
  const list = all.filter(a => got.isTeacher || a.publishedAt);
  const [docs, sessions] = got.isTeacher
    ? await Promise.all([repo.listRecords('doc', { classId: got.cls.id }), repo.listRecords('session', { classId: got.cls.id })])
    : [await repo.listRecords('doc', { classId: got.cls.id, studentId: got.me.id }), []];
  const item = a => {
    const out = {
      id: a.id, type: a.type, title: a.title, publishedAt: a.publishedAt || null, dueAt: a.dueAt || null, createdAt: a.createdAt,
      folderId: a.folderId, position: materials.effectivePosition(a), discussionDate: a.discussion?.date || null
    };
    if (got.isTeacher) out.stats = a.type === 'writing' ? writingStats(a, docs, sessions) : null;
    else out.status = a.type === 'writing' ? (docs.find(d => d.assignmentId === a.id)?.status || 'not-started') : null;
    return out;
  };
  const shown = got.isTeacher ? folders : materials.studentVisibleFolders(folders, list);
  // A student gets each item's place among what they can see (0, 1, 2…), so
  // gaps in the stored positions don't give away hidden drafts
  const rank = got.isTeacher ? null : new Map();
  if (rank) for (const lvl of [null, ...shown.map(f => f.id)]) materials.levelItems(shown, list, lvl).forEach((x, i) => rank.set(`${x.kind}:${x.id}`, i));
  const ranked = (kind, x) => (rank ? { ...x, position: rank.get(`${kind}:${x.id}`) ?? 0 } : x);
  return {
    assignments: materials.sortLevel(list).map(item).map(x => ranked('assignment', x)),
    folders: materials.sortLevel(shown).map(publicFolder).map(x => ranked('folder', x)),
    loaded: { assignments: all, docs, sessions }
  };
}

// Home page: what's happening now and what needs review (teachers), or a
// to-do list across every class (students).
app.get('/api/dashboard', requireAuth, ah(async (req, res) => {
  const core = await repo.readCore();
  const me = meOrThrow(req, core);
  if (me.role === 'teacher') {
    const mine = Object.values(core.classes).filter(c => classes.isClassTeacher(c, me.id) && !c.archived);
    const happeningNow = [], needsReview = [];
    for (const cls of mine) {
      const [assignments, sessions, docs] = await Promise.all([
        repo.listRecords('assignment', { classId: cls.id }), repo.listRecords('session', { classId: cls.id }), repo.listRecords('doc', { classId: cls.id })
      ]);
      for (const a of assignments) {
        const live = sessions.filter(s => s.assignmentId === a.id && isLive(s));
        if (live.length) happeningNow.push({ assignmentId: a.id, title: a.title, classId: cls.id, className: cls.name, live: live.length, students: cls.studentIds.length });
      }
      for (const d of docs.filter(d => d.status === 'submitted' && d.studentId !== 'template')) {
        const a = assignments.find(x => x.id === d.assignmentId);
        needsReview.push({ docId: d.id, assignmentId: d.assignmentId, title: a?.title || 'Assignment', classId: cls.id, className: cls.name, student: fullName(core.users[d.studentId]), submittedAt: d.submittedAt });
      }
    }
    needsReview.sort((a, b) => (a.submittedAt < b.submittedAt ? -1 : 1));
    return res.json({ role: 'teacher', happeningNow, needsReview });
  }
  const todo = [];
  for (const cls of Object.values(core.classes).filter(c => c.studentIds.includes(me.id) && !c.archived)) {
    const [assignments, docs] = await Promise.all([repo.listRecords('assignment', { classId: cls.id }), repo.listRecords('doc', { classId: cls.id, studentId: me.id })]);
    for (const a of assignments.filter(a => a.publishedAt)) {
      const d = docs.find(x => x.assignmentId === a.id);
      todo.push({ assignmentId: a.id, title: a.title, type: a.type, classId: cls.id, className: cls.name, dueAt: a.dueAt || null, status: a.type === 'writing' ? (d?.status || 'not-started') : null });
    }
  }
  todo.sort((a, b) => (a.dueAt || '9999') < (b.dueAt || '9999') ? -1 : 1);
  res.json({ role: 'student', todo });
}));

// Everything a class owns: assignments, student documents with their op logs
// and pictures, sessions, research, discussions (and their recordings),
// feedback, folders, updates, and the group projects its assignments created.
// `studentId` narrows it to one student's data (the teacher's "delete this
// student's data"), which leaves the folders and updates alone.
async function deleteClassRecords(core, cls, { studentId } = {}) {
  const who = studentId ? { studentId } : {};
  const docs = await repo.listRecords('doc', { classId: cls.id, ...who });
  for (const d of docs) {
    await repo.deleteRecords('opchunk', { docId: d.id });
    await repo.deleteRecords('feedback', { docId: d.id });
    await deleteDocImages(d.id);
  }
  await repo.deleteRecords('doc', { classId: cls.id, ...who });
  await repo.deleteRecords('session', { classId: cls.id, ...who });
  await repo.deleteRecords('research', { classId: cls.id, ...who });
  if (studentId) return;
  for (const disc of await repo.listRecords('discussion', { classId: cls.id })) {
    for (const seg of disc.segments || []) if (seg.audio) await audioStorage.deleteAudio(seg.audio);
  }
  await repo.deleteRecords('discussion', { classId: cls.id });
  for (const a of await repo.listRecords('assignment', { classId: cls.id })) await repo.deleteRecords('feedback', { assignmentId: a.id });
  await repo.deleteRecords('assignment', { classId: cls.id });
  await repo.deleteRecords('folder', { classId: cls.id });
  await repo.deleteRecords('announcement', { classId: cls.id });
  for (const p of Object.values(core.projects).filter(p => p.classId === cls.id)) await deleteProjectEverything(p.id);
}
async function deleteProjectEverything(projectId) {
  for (const r of await repo.listResources(projectId)) if (r.type === 'audio') await audioStorage.deleteAudio(r.audio);
  await repo.deleteProjectData(projectId);
  await repo.withCore(c => { delete c.projects[projectId]; });
}

// A teacher deletes one student's work in a class (documents, op logs,
// pictures, sessions, research, feedback). The student stays on the roster.
app.delete('/api/classes/:id/students/:userId/data', requireAuth, ah(async (req, res) => {
  const core = await repo.readCore();
  const got = teacherClass(req, core);
  await deleteClassRecords(core, got.cls, { studentId: String(req.params.userId) });
  res.json({ ok: true });
}));

// Deleting a class removes everything in it, so only its owner can. The page
// asks the teacher to type the class name first; the server checks it too.
app.delete('/api/classes/:id', requireAuth, ah(async (req, res) => {
  const core = await repo.readCore();
  const got = teacherClass(req, core);
  if (!got.isOwner) throw new HttpError(403, 'Only the class owner can delete it.');
  if (String(req.body?.confirmName || '').trim() !== got.cls.name) throw new HttpError(400, 'Type the class name exactly to delete it.');
  await deleteClassRecords(core, got.cls);
  let bg = null;
  await repo.withCore(c => { bg = own(c.classes, got.cls.id)?.background; delete c.classes[got.cls.id]; });
  if (bg?.kind === 'upload') await imageStorage.deleteImage(bg.stored);
  res.json({ ok: true });
}));

// ═══════════════════════════════════════════════════════════════
// SECTION 11 — ASSIGNMENTS
// ═══════════════════════════════════════════════════════════════
//
// Writing, Group project and Discussion assignments (lib/assignments.js),
// stored as "assignment" records. Students only ever see published ones.

// Load an assignment and check the caller: the class teacher, or an enrolled
// student once it's published.
async function assignmentFor(req, core, id = req.params.id) {
  const a = await repo.getRecord('assignment', id);
  if (!a) throw new HttpError(404, 'assignment not found');
  const got = classes.classFor(core, meOrThrow(req, core), a.classId);
  if (!got.isTeacher && !a.publishedAt) throw new HttpError(404, 'assignment not found');
  return { a, ...got };
}
async function teacherAssignment(req, core, id) {
  const got = await assignmentFor(req, core, id);
  if (!got.isTeacher) throw new HttpError(403, 'only the class teacher can do that');
  return got;
}

// Each student's document for a writing assignment, for the Submissions list.
async function submissionRows(core, cls, a) {
  const docs = await repo.listRecords('doc', { assignmentId: a.id });
  return cls.studentIds.map(id => core.users[id]).filter(Boolean).map(u => {
    const d = docs.find(x => x.studentId === u.id);
    return {
      student: publicUser(u), docId: d?.id || null, status: d?.status || 'not-started',
      words: d?.stats?.words || 0, submittedAt: d?.submittedAt || null, returnedAt: d?.returnedAt || null,
      updatedAt: d?.updatedAt || null, sessions: d?.stats?.sessions || 0, score: d?.feedback?.score ?? null
    };
  }).sort((x, y) => x.student.lastName.localeCompare(y.student.lastName) || x.student.firstName.localeCompare(y.student.firstName));
}

// A new assignment goes at the top of its folder (or of the class)
app.post('/api/classes/:id/assignments', requireAuth, ah(async (req, res) => {
  const core = await repo.readCore();
  const got = teacherClass(req, core);
  const a = assignments.createAssignment(got.cls, req.body || {}, got.me.id);
  const { folders, assignments: list } = await classMaterials(got.cls.id);
  a.folderId = materials.folderInClass(folders, req.body?.folderId);
  a.position = materials.topPosition(materials.levelItems(folders, list, a.folderId));
  await repo.putRecord('assignment', a);
  if (a.type === 'group') await syncGroupProjects(a, got.cls, got.me);
  res.json({ assignment: await repo.getRecord('assignment', a.id) });
}));

app.get('/api/assignments/:id', requireAuth, ah(async (req, res) => {
  const core = await repo.readCore();
  const got = await assignmentFor(req, core);
  const { a, cls } = got;
  // teacher: the owner; teachers: every teacher, owner first (no emails here)
  const classInfo = {
    id: cls.id, name: cls.name, color: classes.colorFor(cls), background: classes.publicBackground(cls), archived: !!cls.archived,
    teacher: { id: cls.teacherId, name: fullName(core.users[cls.teacherId]) }, teachers: publicTeachers(core, cls), isOwner: got.isOwner,
    studentCount: cls.studentIds.length
  };
  if (got.isTeacher) Object.assign(classInfo, { joinCode: cls.joinCode, joinOpen: cls.joinOpen !== false, canManageStaff: classes.canManageStaff(cls, got.me.id), advisorCount: (cls.advisorIds || []).length });
  // The folders above it, top first, for the breadcrumb
  const folderPath = materials.folderPath(materials.tidy(await repo.listRecords('folder', { classId: cls.id }), []).folders, a.folderId);
  if (got.isTeacher) {
    const out = { assignment: a, class: classInfo, folderPath, isTeacher: true, describe: assignments.describeWriting(a.writing) };
    if (a.type === 'writing') out.submissions = await submissionRows(core, cls, a);
    if (a.type === 'group') out.groups = await groupRows(core, a);
    if (a.type === 'discussion') out.discussions = await discussionRows(a);
    out.students = cls.studentIds.map(id => publicUser(core.users[id])).filter(Boolean);
    return res.json(out);
  }
  const out = { assignment: assignments.studentView(a), class: classInfo, folderPath, isTeacher: false, describe: assignments.describeWriting(a.writing, classes.multiplierFor(cls, got.me.id)) };
  if (a.type === 'writing') {
    const d = (await repo.listRecords('doc', { assignmentId: a.id, studentId: got.me.id }))[0];
    out.doc = d ? { id: d.id, status: d.status, words: d.stats?.words || 0, submittedAt: d.submittedAt || null, returnedAt: d.returnedAt || null } : null;
  }
  if (a.type === 'group') out.myGroup = await myGroupFor(core, a, got.me);
  if (a.type === 'discussion') out.myStats = await myDiscussionStats(a, got.me);
  res.json(out);
}));

// { folderId } moves it to the top of that folder (null = the top of the
// class). Sent on its own it only moves: nothing else about it changes.
app.patch('/api/assignments/:id', requireAuth, ah(async (req, res) => {
  const core = await repo.readCore();
  const got = await teacherAssignment(req, core);
  const body = req.body || {};
  let move = null;
  if (Object.prototype.hasOwnProperty.call(body, 'folderId')) {
    const { folders, assignments: list } = await classMaterials(got.cls.id);
    const folderId = materials.folderInClass(folders, body.folderId);
    const before = list.find(x => x.id === got.a.id)?.folderId ?? null;
    if (folderId !== before) move = { folderId, position: materials.topPosition(materials.levelItems(folders, list, folderId)) };
  }
  const edit = !move || Object.keys(body).some(k => k !== 'folderId');
  const a = await repo.updateRecord('assignment', got.a.id, x => {
    if (edit) assignments.patchAssignment(x, body, got.cls);
    if (move) Object.assign(x, move);
  });
  if (a.type === 'group' && edit) await syncGroupProjects(a, got.cls, got.me);
  res.json({ assignment: await repo.getRecord('assignment', a.id) });
}));

// publishedBy: the teacher who published it (Recent activity shows them)
app.post('/api/assignments/:id/publish', requireAuth, ah(async (req, res) => {
  const core = await repo.readCore();
  const got = await teacherAssignment(req, core);
  const published = req.body?.published !== false;
  const a = await repo.updateRecord('assignment', got.a.id, x => {
    if (published && !x.publishedAt) { x.publishedAt = now(); x.publishedBy = got.me.id; }
    else if (!published) { x.publishedAt = null; delete x.publishedBy; }
    x.updatedAt = now();
  });
  res.json({ assignment: a });
}));

// Copy to another class the caller teaches (or the same one). The copy goes at
// the top of the original's folder in the same class, or of the other class.
app.post('/api/assignments/:id/duplicate', requireAuth, ah(async (req, res) => {
  const core = await repo.readCore();
  const got = await teacherAssignment(req, core);
  const target = classes.classFor(core, got.me, req.body?.classId || got.cls.id);
  if (!target.isTeacher) throw new HttpError(403, 'you can only copy into your own classes');
  const copy = assignments.duplicateAssignment(got.a, target.cls, got.me.id);
  const { folders, assignments: list } = await classMaterials(target.cls.id);
  copy.folderId = target.cls.id === got.cls.id ? (list.find(x => x.id === got.a.id)?.folderId ?? null) : null;
  copy.position = materials.topPosition(materials.levelItems(folders, list, copy.folderId));
  await repo.putRecord('assignment', copy);
  res.json({ assignment: copy });
}));

app.delete('/api/assignments/:id', requireAuth, ah(async (req, res) => {
  const core = await repo.readCore();
  const got = await teacherAssignment(req, core);
  await deleteAssignmentRecords(core, got.a);
  res.json({ ok: true });
}));

// ---- Folders and their order (class materials) ----
// Folders are "folder" records keyed by classId; an assignment's folderId says
// which one it's in. Folders and assignments in one place share one order
// (lib/materials.js). Only the class teacher changes them.

async function teacherFolder(req, core) {
  const f = await repo.getRecord('folder', req.params.fid);
  if (!f) throw new HttpError(404, 'folder not found');
  const got = classes.classFor(core, meOrThrow(req, core), f.classId);
  if (!got.isTeacher) throw new HttpError(403, 'only the class teacher can do that');
  return { f, ...got };
}

// { name, parentId?, color?, description? } → a folder at the top of its level
app.post('/api/classes/:id/folders', requireAuth, ah(async (req, res) => {
  const core = await repo.readCore();
  const got = teacherClass(req, core);
  const { folders, assignments: list } = await classMaterials(got.cls.id);
  if (folders.length >= materials.MAX_FOLDERS) throw new HttpError(400, `A class can have at most ${materials.MAX_FOLDERS} folders`);
  const parentId = materials.checkPlace(folders, req.body?.parentId);
  const folder = materials.newFolder(got.cls.id, req.body || {}, { parentId, position: materials.topPosition(materials.levelItems(folders, list, parentId)) });
  await repo.putRecord('folder', folder);
  res.json({ folder: publicFolder(folder) });
}));

// { name?, color?, description?, parentId? }. A new parentId moves the folder,
// and everything in it, to the top of that level.
app.patch('/api/folders/:fid', requireAuth, ah(async (req, res) => {
  const core = await repo.readCore();
  const got = await teacherFolder(req, core);
  const body = req.body || {};
  const fields = materials.cleanFolderInput(body, got.f);
  let move = null;
  if (Object.prototype.hasOwnProperty.call(body, 'parentId')) {
    const { folders, assignments: list } = await classMaterials(got.cls.id);
    const before = folders.find(f => f.id === got.f.id)?.parentId ?? null;
    const to = materials.levelId(body.parentId);
    if (to !== before) {
      const parentId = materials.checkPlace(folders, to, got.f.id);
      move = { parentId, position: materials.topPosition(materials.levelItems(folders, list, parentId)) };
    }
  }
  const folder = await repo.updateRecord('folder', got.f.id, x => { Object.assign(x, fields, move || {}); x.updatedAt = now(); });
  if (!folder) throw new HttpError(404, 'folder not found');
  res.json({ folder: publicFolder(folder) });
}));

// The level a record is in as the transaction reads it (a folder that no
// longer exists counts as the top, as in materials.tidy)
const ORDER_CHANGED = 'The list changed while you were moving things. Reload and try again.';
function levelOf(kind, r, known) {
  const id = materials.levelId(kind === 'folder' ? r.parentId : r.folderId);
  return id && known.has(id) ? id : null;
}

// Deleting a folder never deletes assignments: what was in it moves up into
// the folder's place, in its order, and that level is numbered again.
app.delete('/api/folders/:fid', requireAuth, ah(async (req, res) => {
  const core = await repo.readCore();
  const got = await teacherFolder(req, core);
  const { folders, assignments: list } = await classMaterials(got.cls.id);
  const parentId = folders.find(f => f.id === got.f.id)?.parentId ?? null;
  const order = materials.levelAfterDelete(folders, list, got.f.id);
  const known = new Set(folders.map(f => f.id));
  await repo.withRecords(async t => {
    const fresh = new Map();
    for (const x of order) { const r = await t.get(x.kind, x.id); if (r) fresh.set(`${x.kind}:${x.id}`, r); }
    // Something moved out since the read above: start again rather than undo it
    for (const [k, r] of fresh) if (![got.f.id, parentId].includes(levelOf(k.split(':')[0], r, known))) throw new HttpError(409, ORDER_CHANGED);
    // The order as the transaction sees it (a reorder may have landed since)
    const now_ = materials.tidy(folders.map(f => fresh.get(`folder:${f.id}`) || f), list.map(a => fresh.get(`assignment:${a.id}`) || a));
    materials.levelAfterDelete(now_.folders, now_.assignments, got.f.id).forEach((x, i) => {
      const r = fresh.get(`${x.kind}:${x.id}`);
      if (!r) return;
      r.position = i;
      if (x.kind === 'folder') r.parentId = parentId; else r.folderId = parentId;
      t.put(x.kind, r);
    });
    t.del('folder', got.f.id);
  });
  res.json({ ok: true });
}));

// { folderId: null | id, items: [{ kind: 'folder' | 'assignment', id }] }:
// the new order of one level. items must be exactly what's in the level now.
app.put('/api/classes/:id/materials/order', requireAuth, ah(async (req, res) => {
  const core = await repo.readCore();
  const got = teacherClass(req, core);
  const { folders, assignments: list } = await classMaterials(got.cls.id);
  const folderId = materials.folderInClass(folders, req.body?.folderId);
  const items = req.body?.items;
  if (!Array.isArray(items)) throw new HttpError(400, 'items must be a list');
  if (!materials.sameItems(materials.levelItems(folders, list, folderId), items)) throw new HttpError(409, ORDER_CHANGED);
  const known = new Set(folders.map(f => f.id));
  await repo.withRecords(async t => {
    const recs = [];
    for (const x of items) {
      const r = await t.get(x.kind, x.id);
      if (!r || r.classId !== got.cls.id || levelOf(x.kind, r, known) !== folderId) throw new HttpError(409, ORDER_CHANGED);
      recs.push([x.kind, r]);
    }
    recs.forEach(([kind, r], i) => { r.position = i; t.put(kind, r); });
  });
  res.json({ ok: true });
}));

// ---- Class updates (announcements) ----
// A teacher's posts on a class page: "announcement" records keyed by classId.
// Pinned ones stay at the top; the rest page back by date.

const UPDATE_MAX = 5000;
function cleanUpdateBody(v) {
  const body = typeof v === 'string' ? v.replace(/\r\n?/g, '\n').trim() : '';
  if (!body) throw new HttpError(400, 'Write something to post');
  if (body.length > UPDATE_MAX) throw new HttpError(400, 'Updates can be at most 5,000 characters');
  return body;
}

function newUpdate(cls, me, body, pinned = false) {
  const t = now();
  return { id: uid(), classId: cls.id, authorId: me.id, body, pinned: pinned === true, createdAt: t, updatedAt: t, editedAt: null };
}

// What the page sees of an update (the author's name and colour, no email)
function publicUpdate(core, u) {
  const author = own(core.users, u.authorId);
  return { id: u.id, classId: u.classId, body: u.body, pinned: !!u.pinned, createdAt: u.createdAt, editedAt: u.editedAt || null, author: { id: u.authorId, name: fullName(author), avatarColor: author?.avatarColor || null } };
}

const newestFirst = (x, y) => Date.parse(y.createdAt) - Date.parse(x.createdAt) || (x.id < y.id ? 1 : x.id > y.id ? -1 : 0);

// ?before=<ISO>&beforeKey=<key>&limit= for lists that page back in time,
// newest first with ties in descending key order. limit is kept to 1–50 (20
// when not given). The next page starts after the last item shown: its time
// and key, so items that share a time are neither lost nor repeated.
function pageParams(q) {
  const n = Math.round(Number(q.limit));
  const limit = q.limit === undefined || q.limit === '' || !Number.isFinite(n) ? 20 : Math.min(50, Math.max(1, n));
  if (q.before === undefined || q.before === '') return { limit, older: () => true, first: true };
  const before = Date.parse(q.before);
  if (!Number.isFinite(before)) throw new HttpError(400, "before isn't a date Visor can read");
  const key = typeof q.beforeKey === 'string' && q.beforeKey ? q.beforeKey.slice(0, 200) : null;
  // Older than the cursor: an earlier time, or the same time and a smaller key
  const older = (at, k) => { const t = Date.parse(at); return t < before || (t === before && key !== null && String(k) < key); };
  return { limit, older, first: false };
}

async function teacherUpdate(req, core) {
  const u = await repo.getRecord('announcement', req.params.uid);
  if (!u) throw new HttpError(404, 'update not found');
  const got = classes.classFor(core, meOrThrow(req, core), u.classId);
  if (!got.isTeacher) throw new HttpError(403, 'only the class teacher can do that');
  return { u, ...got };
}

// The class's updates: every pinned one on the first page, then the rest
// newest first, `limit` at a time.
app.get('/api/classes/:id/updates', requireAuth, ah(async (req, res) => {
  const core = await repo.readCore();
  const got = classFor(req, core);
  const { limit, older, first } = pageParams(req.query);
  const all = (await repo.listRecords('announcement', { classId: got.cls.id })).sort(newestFirst);
  const rest = all.filter(u => !u.pinned && older(u.createdAt, u.id));
  res.json({
    pinned: first ? all.filter(u => u.pinned).map(u => publicUpdate(core, u)) : [],
    updates: rest.slice(0, limit).map(u => publicUpdate(core, u)),
    more: rest.length > limit
  });
}));

// { body, pinned? }
app.post('/api/classes/:id/updates', requireAuth, ah(async (req, res) => {
  const core = await repo.readCore();
  const got = teacherClass(req, core);
  if (got.cls.archived) throw new HttpError(400, 'This class is archived');
  const u = newUpdate(got.cls, got.me, cleanUpdateBody(req.body?.body), req.body?.pinned);
  await repo.putRecord('announcement', u);
  res.json({ update: publicUpdate(core, u) });
}));

// { classIds: [...], body }: the same update in several classes at once. Every
// class must be one of the caller's running classes, or nothing is posted.
app.post('/api/updates', requireAuth, ah(async (req, res) => {
  const core = await repo.readCore();
  const me = meOrThrow(req, core);
  const raw = Array.isArray(req.body?.classIds) ? req.body.classIds : [];
  if (!raw.length) throw new HttpError(400, 'Pick at least one class');
  if (raw.length > 50) throw new HttpError(400, 'Post to at most 50 classes at a time');
  const targets = [...new Set(raw.map(String))].map(id => {
    const got = classes.classFor(core, me, id);
    if (!got.isTeacher) throw new HttpError(403, 'only the class teacher can do that');
    if (got.cls.archived) throw new HttpError(400, 'This class is archived');
    return got.cls;
  });
  const body = cleanUpdateBody(req.body?.body);
  const list = targets.map(cls => newUpdate(cls, me, body));
  await repo.withRecords(async t => { for (const u of list) t.put('announcement', u); });
  res.json({ updates: list.map(u => publicUpdate(core, u)) });
}));

// { body?, pinned? }. A changed body is marked as edited.
app.patch('/api/updates/:uid', requireAuth, ah(async (req, res) => {
  const core = await repo.readCore();
  const got = await teacherUpdate(req, core);
  const b = req.body || {};
  const body = b.body !== undefined ? cleanUpdateBody(b.body) : undefined;
  const u = await repo.updateRecord('announcement', got.u.id, x => {
    if (body !== undefined && body !== x.body) { x.body = body; x.editedAt = now(); }
    if (typeof b.pinned === 'boolean') x.pinned = b.pinned;
    x.updatedAt = now();
  });
  if (!u) throw new HttpError(404, 'update not found');
  res.json({ update: publicUpdate(core, u) });
}));

app.delete('/api/updates/:uid', requireAuth, ah(async (req, res) => {
  const core = await repo.readCore();
  const got = await teacherUpdate(req, core);
  await repo.deleteRecord('announcement', got.u.id);
  res.json({ ok: true });
}));

// ---- Recent activity and the calendar ----

// The caller's classes that are still running (teaching, co-teaching or
// enrolled), newest first
function activeClassesOf(core, me) {
  return Object.values(core.classes).filter(c => !c.archived && (classes.isClassTeacher(c, me.id) || c.studentIds.includes(me.id)))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

// Home: updates and newly published assignments across those classes, newest
// first, `limit` at a time. Drafts never show, not even to their teacher.
app.get('/api/activity', requireAuth, ah(async (req, res) => {
  const core = await repo.readCore();
  const me = meOrThrow(req, core);
  const { limit, older } = pageParams(req.query);
  const perClass = await Promise.all(activeClassesOf(core, me).map(async cls => {
    const [updates, list] = await Promise.all([repo.listRecords('announcement', { classId: cls.id }), repo.listRecords('assignment', { classId: cls.id })]);
    const where = { classId: cls.id, className: cls.name, color: classes.colorFor(cls) };
    // Who published it; the class owner for older assignments (or when that
    // account is gone)
    const owner = { id: cls.teacherId, name: fullName(own(core.users, cls.teacherId)) };
    const publisherOf = a => { const u = a.publishedBy ? own(core.users, a.publishedBy) : null; return u ? { id: u.id, name: fullName(u) } : owner; };
    return [
      ...updates.map(u => ({ kind: 'update', at: u.createdAt, update: publicUpdate(core, u), ...where })),
      ...list.filter(a => a.publishedAt).map(a => ({ kind: 'assignment', at: a.publishedAt, assignmentId: a.id, title: a.title, type: a.type, dueAt: a.dueAt || null, ...where, teacher: publisherOf(a) }))
    ];
  }));
  const key = x => `${x.kind}:${x.update?.id || x.assignmentId}`;
  const items = perClass.flat().filter(x => older(x.at, key(x)))
    .sort((x, y) => Date.parse(y.at) - Date.parse(x.at) || (key(x) < key(y) ? 1 : -1));
  // key: what the page sends back as beforeKey to get the next page
  res.json({ items: items.slice(0, limit).map(x => ({ ...x, key: key(x) })), more: items.length > limit });
}));

// ?from=<ISO>&to=<ISO> (at most 100 days): due dates, discussion dates and
// writing windows in the caller's running classes. Students see published
// assignments with their own status; teachers see drafts too.
const CALENDAR_MAX_DAYS = 100;
app.get('/api/calendar', requireAuth, ah(async (req, res) => {
  const core = await repo.readCore();
  const me = meOrThrow(req, core);
  const from = Date.parse(req.query.from), to = Date.parse(req.query.to);
  if (!req.query.from || !req.query.to || !Number.isFinite(from) || !Number.isFinite(to)) throw new HttpError(400, 'Give the calendar a from and a to date');
  if (to <= from) throw new HttpError(400, 'The calendar has to end after it starts');
  if (to - from > CALENDAR_MAX_DAYS * 864e5) throw new HttpError(400, `Show at most ${CALENDAR_MAX_DAYS} days at a time`);
  const mine = activeClassesOf(core, me);
  const perClass = await Promise.all(mine.map(async cls => {
    const isTeacher = classes.isClassTeacher(cls, me.id);
    const [list, docs] = await Promise.all([repo.listRecords('assignment', { classId: cls.id }), isTeacher ? [] : repo.listRecords('doc', { classId: cls.id, studentId: me.id })]);
    const events = [];
    for (const a of list.filter(a => isTeacher || a.publishedAt)) {
      const status = isTeacher || a.type !== 'writing' ? null : (docs.find(d => d.assignmentId === a.id)?.status || 'not-started');
      const dates = { due: a.dueAt, discussion: a.discussion?.date, opens: a.writing?.windowStart, closes: a.writing?.windowEnd };
      for (const [kind, at] of Object.entries(dates)) {
        const t = at ? Date.parse(at) : NaN;
        if (!Number.isFinite(t) || t < from || t >= to) continue;
        events.push({ id: `${a.id}:${kind}`, kind, at, assignmentId: a.id, title: a.title, type: a.type, classId: cls.id, className: cls.name, color: classes.colorFor(cls), published: !!a.publishedAt, status });
      }
    }
    return events;
  }));
  const events = perClass.flat().sort((x, y) => Date.parse(x.at) - Date.parse(y.at) || (x.id < y.id ? -1 : 1));
  res.json({ events, classes: mine.map(c => ({ id: c.id, name: c.name, color: classes.colorFor(c), isTeacher: classes.isClassTeacher(c, me.id) })) });
}));

// ---- Live session board (Section 7.9) ----

const LATE_BEAT_MS = 30 * 1000;
// all: every session of this student's document, so time away is counted
// from the pauses themselves (doc.stats is only synced now and then)
function liveRow(u, doc, s, a, t, all = null) {
  const row = { student: publicUser(u), docId: doc?.id || null, status: 'not-started', reason: null, awayMs: all ? sessionsLib.docSessionStats(all, t).awayMs : doc?.stats?.awayMs || 0, words: doc?.stats?.words || 0, pastes: doc?.stats?.pastes || 0, outsidePasteChars: doc?.stats?.externalPasteChars || 0, biggestPaste: doc?.stats?.biggestPaste || 0, sessionMs: null, timeLeftMs: null, ext: null, lock: null, lastActivity: doc?.updatedAt || null, lateBeat: false, aiSite: false, sessionId: null, teacherPaused: false, where: null, researching: false };
  if (doc?.status === 'submitted') row.status = 'submitted';
  else if (doc?.status === 'returned' && !doc.reopened) row.status = 'returned';
  if (s && s.state !== 'ended') {
    const open = sessionsLib.openPause(s);
    row.sessionId = s.id;
    row.sessionMs = t - Date.parse(s.startedAt);
    row.timeLeftMs = s.deadlineAt ? Date.parse(s.deadlineAt) - t : null;
    // The lockdown only counts while the extension is actually there (its last
    // report can say "on" long after it was turned off)
    row.ext = !!s.extension?.present; row.lock = s.mode === 'locked' ? !!(s.extension?.present && s.extension?.lockActive) : null;
    row.lastActivity = [s.lastBeat, doc?.updatedAt].filter(Boolean).sort().pop();
    row.lateBeat = t - Date.parse(s.lastBeat) > LATE_BEAT_MS;
    row.aiSite = (s.events || []).some(e => e.type === 'ai-site');
    // Another extension's writing tool on the essay page; the side panel closed while writing in it
    row.tools = [...new Set((s.events || []).filter(e => e.type === 'assistant-ext' && e.detail).map(e => e.detail))].slice(0, 4);
    row.panelClosed = (s.events || []).filter(e => e.type === 'panel-closed').length;
    row.teacherPaused = !!s.teacherPaused;
    // Writing in the side panel (and researching on other tabs right now)?
    row.where = doc?.lease?.surf === 'panel' && doc.lease.sessionId === s.id ? 'panel' : 'tab';
    row.researching = !!s.research;
    if (open) {
      row.reason = open.reason; row.pausedMs = t - Date.parse(open.from);
      if (!all && open.reason !== 'teacher') row.awayMs += row.pausedMs;
      row.status = open.reason === 'teacher' ? 'paused' : open.reason === 'offline' ? 'offline' : 'left';
    } else row.status = 'writing';
  } else if (s && row.status === 'not-started') {
    row.status = 'ended'; row.reason = s.endReason;
    row.sessionMs = Date.parse(s.endedAt || s.lastBeat) - Date.parse(s.startedAt);
  } else if (doc && row.status === 'not-started' && doc.status === 'in-progress') row.status = 'ended';
  // Needs attention: away over a minute, extension missing in a locked
  // session, an AI site, or a big paste from outside Visor's view
  row.attention = [
    (row.status === 'left' || row.status === 'offline') && row.pausedMs > 60000 ? 'away over a minute' : null,
    row.status !== 'submitted' && s && s.state !== 'ended' && s.mode === 'locked' && !row.ext ? 'extension missing' : null,
    row.aiSite ? 'AI site visited' : null,
    row.tools?.length ? `writing tool on the page: ${row.tools.join(', ')}` : null,
    row.panelClosed ? 'closed the side panel' : null,
    // The extension can't see pages, so it can only block them outright and records no research
    s && s.state !== 'ended' && s.mode === 'locked' && row.ext && s.extension?.hasHostPermission === false ? 'site access withheld from the extension' : null,
    row.biggestPaste >= 200 && row.outsidePasteChars >= 200 ? 'large paste from outside' : null,
    row.lateBeat ? 'not heard from in 30 s' : null
  ].filter(Boolean);
  return row;
}

app.get('/api/assignments/:id/live', requireAuth, ah(async (req, res) => {
  const core = await repo.readCore();
  const got = await teacherAssignment(req, core);
  const { a, cls } = got;
  const t = Date.now();
  const docs = await repo.listRecords('doc', { assignmentId: a.id });
  // The board's poll also sweeps: quiet sessions time out, time limits end
  let sessions = await repo.listRecords('session', { assignmentId: a.id });
  for (const d of docs.filter(d => sessions.some(s => s.docId === d.id && s.state !== 'ended'))) await sweepDocSessions(d, a);
  sessions = await repo.listRecords('session', { assignmentId: a.id });
  const freshDocs = await repo.listRecords('doc', { assignmentId: a.id });
  const rows = cls.studentIds.map(id => core.users[id]).filter(Boolean).map(u => {
    const doc = freshDocs.find(d => d.studentId === u.id);
    const mine = sessions.filter(s => s.studentId === u.id).sort((x, y) => (x.startedAt < y.startedAt ? 1 : -1));
    return liveRow(u, doc, mine.find(s => s.state !== 'ended') || mine[0] || null, a, t, doc ? mine.filter(s => s.docId === doc.id) : null);
  }).sort((x, y) => x.student.lastName.localeCompare(y.student.lastName));
  res.json({ rows, serverNow: new Date(t).toISOString(), mode: a.writing?.mode, timeLimitMin: a.writing?.timeLimitMin || null });
}));

// { action, studentIds?, minutes?, message? }
// One student: end, pause, resume, add-time, message. Everyone: pause-all,
// resume-all, end-all-submit, extend-all (studentIds omitted).
app.post('/api/assignments/:id/live/action', requireAuth, ah(async (req, res) => {
  const core = await repo.readCore();
  const got = await teacherAssignment(req, core);
  const { a, cls } = got;
  const { action, minutes, message } = req.body || {};
  const ACTIONS = ['end', 'pause', 'resume', 'add-time', 'message', 'pause-all', 'resume-all', 'end-all-submit', 'extend-all'];
  if (!ACTIONS.includes(action)) throw new HttpError(400, 'Unknown action');
  const all = action.endsWith('-all') || action === 'end-all-submit';
  const who = all ? cls.studentIds : (Array.isArray(req.body?.studentIds) ? req.body.studentIds.map(String) : []).filter(id => cls.studentIds.includes(id));
  if (!who.length) throw new HttpError(400, 'Pick at least one student');
  const live = (await repo.listRecords('session', { assignmentId: a.id })).filter(s => s.state !== 'ended' && who.includes(s.studentId));
  const t = Date.now();
  let changed = 0;
  for (const s0 of live) {
    let ended = false;
    const s = await repo.updateRecord('session', s0.id, x => {
      if (x.state === 'ended') return;
      if (action === 'end' || action === 'end-all-submit') { sessionsLib.endSession(x, 'teacher', t); ended = true; }
      else if (action === 'pause' || action === 'pause-all') sessionsLib.teacherPause(x, t);
      else if (action === 'resume' || action === 'resume-all') sessionsLib.teacherResume(x, t);
      else if (action === 'add-time' || action === 'extend-all') sessionsLib.addTime(x, minutes, t);
      else if (action === 'message') sessionsLib.teacherMessage(x, message, t);
    });
    if (ended) await afterSessionEnded(s, a);
    if ((action === 'add-time' || action === 'extend-all') && s) {
      const m = Math.max(1, Math.min(240, Math.round(Number(minutes) || 0)));
      await repo.updateRecord('doc', s.docId, d => { d.extraTimeMs = (d.extraTimeMs || 0) + m * 60000; });
    }
    changed++;
  }
  // Extra time also counts for students who aren't writing right now
  if (action === 'add-time' || action === 'extend-all') {
    const m = Math.max(1, Math.min(240, Math.round(Number(minutes) || 0)));
    for (const d of (await repo.listRecords('doc', { assignmentId: a.id })).filter(d => who.includes(d.studentId) && !live.some(s => s.docId === d.id))) {
      await repo.updateRecord('doc', d.id, x => { x.extraTimeMs = (x.extraTimeMs || 0) + m * 60000; }); changed++;
    }
  }
  if (action === 'end-all-submit') {
    for (const d of (await repo.listRecords('doc', { assignmentId: a.id })).filter(d => who.includes(d.studentId) && d.status === 'in-progress')) {
      await repo.updateRecord('doc', d.id, x => { x.status = 'submitted'; x.submittedAt = new Date(t).toISOString(); x.lease = null; x.reopened = false; x.submittedBy = 'teacher'; });
      changed++;
    }
  }
  res.json({ ok: true, changed });
}));

async function deleteAssignmentRecords(core, a) {
  for (const d of await repo.listRecords('doc', { assignmentId: a.id })) {
    await repo.deleteRecords('opchunk', { docId: d.id });
    await deleteDocImages(d.id);
  }
  for (const k of ['doc', 'session', 'research', 'feedback']) await repo.deleteRecords(k, { assignmentId: a.id });
  for (const disc of await repo.listRecords('discussion', { assignmentId: a.id })) {
    for (const seg of disc.segments || []) if (seg.audio) await audioStorage.deleteAudio(seg.audio);
  }
  await repo.deleteRecords('discussion', { assignmentId: a.id });
  for (const p of Object.values(core.projects).filter(p => p.assignmentId === a.id)) await deleteProjectEverything(p.id);
  await repo.deleteRecord('assignment', a.id);
}

// ═══════════════════════════════════════════════════════════════
// SECTION 12 — WRITING
// ═══════════════════════════════════════════════════════════════
//
// Visor Writer. Each student gets one document per writing assignment ("doc"
// record), whose text the server keeps itself by applying every op the
// editor sends (lib/writing.js). Ops are only accepted inside an active
// writing session (lib/sessions.js), from the one surface holding the
// editing lease, in sequence. The tab authenticates with the cookie, the
// extension's side panel with its extension token; both then send the
// session token (X-Visor-Session) on op, beat and lease calls.

const WSESS = 'wsess';

// Who's asking: the cookie, or the extension's token (the side panel embed).
// The extension's token wins when both are present: the side panel's editor
// belongs to whoever connected the extension, even if someone else is signed
// in to the site in this browser.
async function writerUser(req, core) {
  const ext = await extUserFromHeader(req, core);
  if (ext) return ext;
  const fromCookie = currentUser(req, core);
  if (fromCookie) return fromCookie;
  throw new HttpError(401, 'not signed in');
}

async function sessionToken(s, surf) {
  return sign(await getSessionSecret(), { uid: s.studentId, sid: s.id, docId: s.docId, surf, iat: Date.now() }, WSESS);
}
// The session token on op, beat and lease calls. The session's own state is
// checked on every use, so a token dies with its session.
async function sessionAuth(req) {
  // The header normally; the body for navigator.sendBeacon, which can't set headers
  const t = verify(await getSessionSecret(), String(req.get('X-Visor-Session') || req.body?._session || ''), WSESS);
  if (!t || t.docId !== req.params.docId) throw new HttpError(401, 'Your writing session has expired. Reload the page.');
  return t;
}

// A student document and who may see it: its student (isOwner here), or a
// teacher of the class (owner or co-teacher).
async function docFor(req, core, docId = req.params.docId) {
  const me = await writerUser(req, core);
  const doc = await repo.getRecord('doc', docId);
  if (!doc) throw new HttpError(404, 'document not found');
  const cls = own(core.classes, doc.classId);
  const isOwner = doc.studentId === me.id;
  const isTeacher = !!cls && classes.isClassTeacher(cls, me.id);
  if (!isOwner && !isTeacher) throw new HttpError(403, 'not your document');
  const a = await repo.getRecord('assignment', doc.assignmentId);
  return { doc, a, cls, me, isOwner, isTeacher };
}

// Get the student's document, making it (with the teacher's starter text as
// op 1) the first time.
async function getOrCreateDoc(a, cls, studentId) {
  const id = writing.docIdFor(a.id, studentId);
  const have = await repo.getRecord('doc', id);
  if (have) return have;
  return repo.withRecords(async t => {
    const again = await t.get('doc', id);
    if (again) return again;
    const { doc, firstOps } = writing.newDoc({ id, assignmentId: a.id, classId: cls.id, studentId, templateText: a.writing?.templateText || '' });
    if (firstOps.length) t.put('opchunk', { id: writing.chunkId(id, 0), docId: id, classId: cls.id, assignmentId: a.id, studentId, no: 0, ops: firstOps, updatedAt: now() });
    t.put('doc', doc);
    return doc;
  });
}

// Bring a document's sessions up to date (timeouts, time limits, windows),
// saving any that changed. Returns them, newest first.
async function sweepDocSessions(doc, a) {
  const list = await repo.listRecords('session', { docId: doc.id });
  const t = Date.now();
  for (const s of list.filter(s => s.state !== 'ended')) {
    const before = JSON.stringify([s.state, s.pauses.length, s.events.length]);
    const ended = sessionsLib.sweep(s, t, { windowEnd: a?.writing?.windowEnd });
    if (JSON.stringify([s.state, s.pauses.length, s.events.length]) !== before) {
      const saved = await repo.updateRecord('session', s.id, x => { if (x.state !== 'ended') sessionsLib.sweep(x, Date.now(), { windowEnd: a?.writing?.windowEnd }); });
      Object.assign(s, saved);
    }
    if (ended) await afterSessionEnded(s, a);
  }
  return list.sort((x, y) => (x.startedAt < y.startedAt ? 1 : -1));
}

// A session just ended: free the lease, refresh the cached figures, and submit
// if time ran out on an assignment set to submit automatically.
async function afterSessionEnded(s, a) {
  const autoSubmit = s.endReason === 'time-limit' && a?.writing?.autoSubmitOnTimeUp;
  await repo.updateRecord('doc', s.docId, d => {
    if (d.lease?.sessionId === s.id) d.lease = null;
    if (autoSubmit && d.status !== 'submitted') { d.status = 'submitted'; d.submittedAt = s.endedAt || now(); d.reopened = false; d.autoSubmitted = true; }
  });
  if (autoSubmit) await repo.updateRecord('session', s.id, x => { if (!x.events.some(e => e.type === 'submit')) sessionsLib.addEvent(x, { t: Date.parse(x.endedAt || now()), type: 'submit', auto: true }); });
  await syncDocStats(s.docId);
}

async function syncDocStats(docId) {
  const list = await repo.listRecords('session', { docId });
  const st = sessionsLib.docSessionStats(list, Date.now());
  await repo.updateRecord('doc', docId, d => { d.stats = { ...(d.stats || {}), ...st }; });
}

// The document as the editor sees it
function docView(doc, { withFeedback } = {}) {
  const out = { id: doc.id, assignmentId: doc.assignmentId, text: doc.text, formats: doc.formats, sources: doc.sources || [], seq: doc.seq, status: doc.status, submittedAt: doc.submittedAt, returnedAt: doc.returnedAt, reopened: !!doc.reopened, lease: doc.lease, stats: doc.stats, autoSubmitted: !!doc.autoSubmitted };
  if (withFeedback && doc.feedback && (doc.status === 'returned' || doc.reopened)) out.feedback = doc.feedback;
  return out;
}

// Remaining time across sessions, for the start screen ("38 minutes left")
function timeLeft(a, cls, doc, sessions, studentId) {
  const lim = a.writing?.timeLimitMin;
  if (!lim) return null;
  const total = lim * 60000 * classes.multiplierFor(cls, studentId) + (doc.extraTimeMs || 0);
  return Math.max(0, total - sessionsLib.usedMs(sessions.filter(s => s.state === 'ended')));
}

// The editor page: the student's document, the assignment's settings, the
// active session (if any) and a token for it.
app.get('/api/write/:assignmentId', ah(async (req, res) => {
  const core = await repo.readCore();
  const me = await writerUser(req, core);
  const a = await repo.getRecord('assignment', req.params.assignmentId);
  if (!a || a.type !== 'writing') throw new HttpError(404, 'writing assignment not found');
  const got = classes.classFor(core, me, a.classId);
  if (got.isTeacher) return res.status(403).json({ error: 'Teachers review student writing from the assignment page.', reviewUrl: `/a/${a.id}?tab=submissions` });
  if (!a.publishedAt) throw new HttpError(404, 'writing assignment not found');
  const doc = await getOrCreateDoc(a, got.cls, me.id);
  const list = await sweepDocSessions(doc, a);
  const fresh = await repo.getRecord('doc', doc.id);
  const active = list.find(s => s.state !== 'ended') || null;
  const surf = req.query.surf === 'panel' ? 'panel' : 'tab';
  const mult = classes.multiplierFor(got.cls, me.id);
  res.json({
    assignment: assignments.studentView(a), class: { id: got.cls.id, name: got.cls.name }, describe: assignments.describeWriting(a.writing, mult),
    doc: docView(fresh, { withFeedback: true }),
    session: active ? sessionsLib.clientView(active, Date.now()) : null,
    token: active ? await sessionToken(active, surf) : null,
    // For the essay's pictures: /api/images/<id>?t=<imageToken>
    imageToken: await imageToken(fresh.id, me.id),
    // Writing is possible in an active session not paused by the teacher; the
    // editor also needs focus and the lease, which only the page can know.
    canWrite: !!active && !active.teacherPaused && fresh.status !== 'submitted',
    timeLeftMs: timeLeft(a, got.cls, fresh, list, me.id), multiplier: mult,
    windowProblem: sessionsLib.windowProblem(a.writing, Date.now()),
    user: { id: me.id, name: fullName(me) },
    serverNow: now()
  });
}));

// Start (or take over) a session. Body: { surfaceId, surf, extPresent, extVersion, fullscreen }
app.post('/api/write/:docId/sessions', ah(async (req, res) => {
  const core = await repo.readCore();
  const got = await docFor(req, core);
  if (!got.isOwner) throw new HttpError(403, 'Only the student can write in their document.');
  const body = req.body || {};
  const surfaceId = String(body.surfaceId || '').slice(0, 60);
  if (!surfaceId) throw new HttpError(400, 'surfaceId is required');
  const surf = body.surf === 'panel' ? 'panel' : 'tab';
  // A locked session starts in full screen, which the side panel can't do
  if (surf === 'panel' && got.a.writing?.mode === 'locked') throw new HttpError(409, 'Start locked sessions from the Visor tab in full screen.');
  const list = await sweepDocSessions(got.doc, got.a);
  const doc = await repo.getRecord('doc', got.doc.id);
  let active = list.find(s => s.state !== 'ended') || null;
  const t = Date.now();
  const { takeover } = sessionsLib.checkStart({ doc, assignment: got.a, userId: got.me.id, active, extAck: doc.extAck, body: { ...body, surf }, now: t });
  if (takeover?.end) {
    await repo.updateRecord('session', active.id, x => sessionsLib.endSession(x, 'timeout', t, { at: Date.parse(x.lastBeat || x.startedAt) }));
    await afterSessionEnded(active, got.a);
    active = null;
  }
  let s;
  if (takeover?.reuse) {
    // The same student opened another tab: it joins the running session.
    s = await repo.updateRecord('session', active.id, x => {
      sessionsLib.leaseMoved(x, surf, t);
      x.surfaces[surfaceId] = { kind: surf, focused: true, visible: true, fullscreen: body.fullscreen !== false, lastBeat: new Date(t).toISOString() };
      x.lastBeat = new Date(t).toISOString();
      sessionsLib.addEvent(x, { t, type: 'lease', surf, takeover: true });
      sessionsLib.evaluateFocus(x, t);
    });
  } else {
    const ended = list.filter(x => x.state === 'ended' || x.id === active?.id);
    const deadlineAt = sessionsLib.computeDeadline({ timeLimitMin: got.a.writing?.timeLimitMin, multiplier: classes.multiplierFor(got.cls, got.me.id), used: sessionsLib.usedMs(ended), extraMs: doc.extraTimeMs, now: t });
    if (deadlineAt && Date.parse(deadlineAt) <= t + 5000) throw new HttpError(409, 'You’ve used all of your time for this assignment. Ask your teacher if you need more.');
    s = sessionsLib.newSession({ doc, assignment: got.a, userId: got.me.id, body: { ...body, surf, surfaceId }, deadlineAt, extAck: doc.extAck, now: t });
    await repo.putRecord('session', s);
  }
  const lease = { surfaceId, sessionId: s.id, surf, at: new Date(t).toISOString() };
  await repo.updateRecord('doc', doc.id, d => {
    d.lease = lease;
    if (d.status === 'not-started' || d.status === 'returned') d.status = 'in-progress';
    d.updatedAt = now();
  });
  await syncDocStats(doc.id);
  const fresh = await repo.getRecord('doc', doc.id);
  res.json({ session: sessionsLib.clientView(s, t), token: await sessionToken(s, surf), lease, doc: docView(fresh), serverNow: now() });
}));

// Load the session named by the token and bring it up to date
async function liveSession(req) {
  const tok = await sessionAuth(req);
  const s = await repo.getRecord('session', tok.sid);
  if (!s || s.docId !== req.params.docId || s.studentId !== tok.uid) throw new HttpError(401, 'Your writing session has expired. Reload the page.');
  return { tok, s };
}
const endedReply = s => ({ ended: true, session: sessionsLib.clientView(s, Date.now()) });

// Ops: { baseSeq, ops:[...], textHash, surfaceId }
app.post('/api/write/:docId/ops', ah(async (req, res) => {
  const { tok, s: s0 } = await liveSession(req);
  const body = req.body || {};
  if (!Array.isArray(body.ops)) throw new HttpError(400, 'ops must be a list');
  if (body.ops.length > writing.LIMITS.BATCH_OPS) throw new HttpError(413, 'Too many ops in one batch (500 at most).');
  await checkOpImages(req.params.docId, body.ops);
  const a = await repo.getRecord('assignment', s0.assignmentId);
  // Pastes: look for the research copy each one came from (outside the transaction)
  const copies = body.ops.some(o => o && (o.src === 'paste' || o.src === 'drop')) ? await researchCopiesFor(s0.studentId, s0.assignmentId) : [];
  let endedNow = null;
  const out = await repo.withRecords(async t => {
    const s = await t.get('session', s0.id);
    const doc = await t.get('doc', req.params.docId);
    const nowMs = Date.now();
    endedNow = sessionsLib.sweep(s, nowMs, { windowEnd: a?.writing?.windowEnd });
    if (s.state === 'ended') { t.put('session', s); return { ended: s }; }
    if (s.teacherPaused) throw new HttpError(423, 'Your teacher paused the session.');
    if (doc.status === 'submitted') throw new HttpError(409, 'This document has been submitted.');
    const surfaceId = String(body.surfaceId || '');
    if (!sessionsLib.holdsLease(doc.lease, s.id, surfaceId, tok.surf)) throw new HttpError(409, 'Another window is writing in this document.', { notLeaseHolder: true, lease: doc.lease, ...writing.resyncData(doc) });
    const chunkIds = writing.chunkIdsFor(doc.id, Number(body.baseSeq), body.ops.length);
    const chunks = {};
    if (Number(body.baseSeq) === doc.seq) for (const id of chunkIds) chunks[id] = await t.get('opchunk', id);
    const stamped = writing.applyBatch(doc, body.ops, { baseSeq: Number(body.baseSeq), textHash: body.textHash, sid: s.id, surf: tok.surf === 'panel' || doc.lease.surf === 'panel' ? 'panel' : 'tab', now: nowMs });
    research.matchPasteOrigins(stamped, copies, { studentId: s.studentId, now: nowMs });
    writing.updateStats(doc, stamped);
    for (const c of writing.appendToChunks(doc.id, chunks, stamped)) t.put('opchunk', { ...c, classId: doc.classId, assignmentId: doc.assignmentId, studentId: doc.studentId });
    doc.updatedAt = new Date(nowMs).toISOString();
    doc.process = null; // the process report is rebuilt on the next review
    s.opsTo = doc.seq;
    if (!s.opsFrom || s.opsFrom > stamped[0]?.n) s.opsFrom = stamped[0]?.n || s.opsFrom;
    s.lastBeat = new Date(nowMs).toISOString();
    if (s.surfaces[surfaceId]) s.surfaces[surfaceId].lastBeat = s.lastBeat;
    t.put('doc', doc); t.put('session', s);
    return { seq: doc.seq, pastes: stamped.filter(o => o.paste).map(o => ({ n: o.n, origin: o.paste.origin, internal: o.paste.internal })) };
  });
  if (out.ended) { if (endedNow) await afterSessionEnded(out.ended, a); return res.status(409).json({ error: 'Your writing session has ended.', ...endedReply(out.ended) }); }
  res.json(out);
}));

// ---- Pictures in essays ----
//
// A picture is uploaded once, as raw bytes the editor has already shrunk
// (POST /api/write/:docId/images), kept by lib/imageStorage.js, and listed as
// an "image" record. The essay's text holds one placeholder character for it
// (docFormat.EMBED) with the picture's id in its attributes. Pictures stay
// until the essay is deleted, so the replay can still show ones taken out.
// GET /api/images/:id serves them to the student and their teacher: by the
// sign-in cookie on Visor's own pages, or by an image token in the address
// (?t=), because the side panel has no cookie and an <img> can't send headers.

const IMAGE_TOKEN_MS = 12 * 3600 * 1000;
const IMAGES_PER_DOC = 100;
const IMAGE_ID_RE = /^[a-f0-9]{32}$/;
const IMAGE_TOO_LARGE = 'That image is too large (5 MB at most).';

// Lets whoever holds it see one document's pictures for 12 hours
async function imageToken(docId, uid) {
  return sign(await getSessionSecret(), { docId, uid, exp: Date.now() + IMAGE_TOKEN_MS }, 'img');
}

// Every picture an op batch inserts must have been uploaded to this document
async function checkOpImages(docId, ops) {
  const ids = ops.filter(o => o && o.k === 'i' && o.attrs && typeof o.attrs === 'object').map(o => docFormat.cleanAttrs(o.attrs)?.image).filter(Boolean);
  if (!ids.length) return;
  const mine = new Set((await repo.listRecords('image', { docId })).filter(r => r.docId === docId).map(r => r.id));
  if (!ids.every(id => mine.has(id))) throw new HttpError(400, 'That image belongs to another document.');
}

// A document's pictures: the files, then their records
async function deleteDocImages(docId) {
  for (const img of await repo.listRecords('image', { docId })) await imageStorage.deleteImage(img.stored);
  await repo.deleteRecords('image', { docId });
}

// The raw body, read only after the session token checks out. The 6 MB cap
// only stops runaway uploads; the real limit is MAX_IMAGE_BYTES below.
const rawImageBody = express.raw({ type: () => true, limit: '6mb' });
const imageBody = (req, res, next) => rawImageBody(req, res, err => (err && err.type === 'entity.too.large' ? res.status(413).json({ error: IMAGE_TOO_LARGE }) : next(err)));
const imageSide = v => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 1 && n <= 20000 ? n : null; };

// Upload a picture: the bytes as the body, ?w=&h= its size in pixels, and the
// surface's id in X-Visor-Surface (or ?surfaceId=). The same checks as the ops
// route: a live session the teacher hasn't paused, a document that isn't
// submitted, and this surface holding the lease. Works from the tab (cookie or
// not, the session token decides) and from the side panel. Only when the
// assignment allows pasting from outside.
app.post('/api/write/:docId/images', ah(async (req, res, next) => { req.writeSession = await liveSession(req); next(); }), imageBody, ah(async (req, res) => {
  const { tok, s: s0 } = req.writeSession;
  const a = await repo.getRecord('assignment', s0.assignmentId);
  // Every upload comes from outside the essay (pictures already in it are
  // copied by id), so the paste setting covers pictures too
  if ((a?.writing?.allowPaste || 'allow') !== 'allow') throw new HttpError(403, 'Images from outside the essay are turned off for this assignment.');
  const buf = Buffer.isBuffer(req.body) ? req.body : (Buffer.isBuffer(req.rawBody) ? req.rawBody : null);
  if (buf && buf.length > imageStorage.MAX_IMAGE_BYTES) return res.status(413).json({ error: IMAGE_TOO_LARGE });
  const mime = imageStorage.sniffImage(buf);
  if (!mime) throw new HttpError(400, 'Only PNG, JPEG, GIF or WebP images.');
  const surfaceId = String(req.get('X-Visor-Surface') || req.query.surfaceId || '').slice(0, 60);
  let endedNow = null;
  // The checks, and a place among the document's 100 pictures, in one step
  const out = await repo.withRecords(async t => {
    const s = await t.get('session', s0.id);
    const doc = await t.get('doc', req.params.docId);
    endedNow = sessionsLib.sweep(s, Date.now(), { windowEnd: a?.writing?.windowEnd });
    if (s.state === 'ended') { t.put('session', s); return { ended: s }; }
    if (!doc) throw new HttpError(404, 'document not found');
    if (s.teacherPaused) throw new HttpError(423, 'Your teacher paused the session.');
    if (doc.status === 'submitted') throw new HttpError(409, 'This document has been submitted.');
    if (!sessionsLib.holdsLease(doc.lease, s.id, surfaceId, tok.surf)) throw new HttpError(409, 'Another window is writing in this document.', { notLeaseHolder: true, lease: doc.lease });
    if ((doc.imageCount || 0) >= IMAGES_PER_DOC) throw new HttpError(409, `This essay has the most images it can hold (${IMAGES_PER_DOC}).`);
    doc.imageCount = (doc.imageCount || 0) + 1;
    t.put('doc', doc);
    return { doc };
  });
  if (out.ended) { if (endedNow) await afterSessionEnded(out.ended, a); return res.status(409).json({ error: 'Your writing session has ended.', ...endedReply(out.ended) }); }
  const { doc } = out;
  const id = crypto.randomBytes(16).toString('hex');
  let stored = null;
  try {
    stored = await imageStorage.putImage({ docId: doc.id, id, mime, buf });
    await repo.putRecord('image', { id, docId: doc.id, classId: doc.classId, assignmentId: doc.assignmentId, studentId: doc.studentId, sessionId: s0.id, mime, sizeBytes: buf.length, width: imageSide(req.query.w), height: imageSide(req.query.h), stored, createdAt: now() });
  } catch (err) {
    // Give the place back, and don't leave a file nothing points to
    if (stored) await imageStorage.deleteImage(stored);
    await repo.updateRecord('doc', doc.id, d => { d.imageCount = Math.max(0, (d.imageCount || 0) - 1); }).catch(() => {});
    throw err;
  }
  res.json({ id, url: `/api/images/${id}` });
}));

// A picture, for its student or a teacher of their class. Anyone else gets the
// same 404 as for a picture that doesn't exist.
app.get('/api/images/:id', ah(async (req, res) => {
  const notFound = () => res.status(404).json({ error: 'image not found' });
  const id = String(req.params.id);
  const rec = IMAGE_ID_RE.test(id) ? await repo.getRecord('image', id) : null;
  if (!rec) return notFound();
  let ok = false;
  if (typeof req.query.t === 'string' && req.query.t) {
    const t = verify(await getSessionSecret(), req.query.t, 'img');
    ok = !!t && t.docId === rec.docId && t.exp > Date.now();
    // ...and whoever it was given to is still the student or a teacher of the class
    if (ok) {
      const core = await repo.readCore();
      ok = t.uid === rec.studentId || classes.isClassTeacher(own(core.classes, rec.classId), t.uid);
    }
  }
  if (!ok && req.session?.userId) {
    const core = await repo.readCore();
    const me = currentUser(req, core);
    ok = !!me && (me.id === rec.studentId || classes.isClassTeacher(own(core.classes, rec.classId), me.id));
  }
  if (!ok) return notFound();
  await imageStorage.streamImage(rec.stored, rec.mime, res);
}));

// Beat: { surfaceId, surf, focused, visible, fullscreen, extPresent, extLock, online, events, offlinePause, seq, wantText, browser? }
// browser (the side panel only): { focused, blocked }, from the extension:
// a Chrome window has focus, and whether it shows Visor's blocked page.
app.post('/api/write/:docId/beat', ah(async (req, res) => {
  const { tok, s: s0 } = await liveSession(req);
  const a = await repo.getRecord('assignment', s0.assignmentId);
  const body = req.body || {};
  const surf = body.surf === 'panel' ? 'panel' : 'tab';
  const lease = (await repo.getRecord('doc', s0.docId))?.lease;
  const holdsLease = sessionsLib.holdsLease(lease, s0.id, String(body.surfaceId || 'tab').slice(0, 60), tok.surf);
  const panelLease = !!lease && lease.sessionId === s0.id && lease.surf === 'panel';
  const b = body.browser;
  const browser = surf === 'panel' && b && typeof b === 'object' ? { focused: !!b.focused, blocked: !!b.blocked } : undefined;
  let endedNow = null, pausesBefore = s0.pauses.length;
  const s = await repo.updateRecord('session', s0.id, x => {
    const t = Date.now();
    endedNow = sessionsLib.sweep(x, t, { windowEnd: a?.writing?.windowEnd });
    if (x.state !== 'ended') sessionsLib.applyBeat(x, { ...body, surf, holdsLease, panelLease, browser }, t);
  });
  if (endedNow) await afterSessionEnded(s, a);
  else if (s.pauses.length !== pausesBefore) await syncDocStats(s.docId);
  const doc = await repo.getRecord('doc', s.docId);
  const out = { ...sessionsLib.clientView(s, Date.now()), lease: doc.lease, seq: doc.seq, docStatus: doc.status, ended: s.state === 'ended' };
  if (body.wantText && Number(body.seq) !== doc.seq) Object.assign(out, { text: doc.text, formats: doc.formats });
  res.json(out);
}));

// Hand the editing lease to this surface: { surfaceId, surf }. Or, from the
// tab, to the side panel as a whole: { give: 'panel' } (any copy of the panel
// may then write; see sessionsLib.holdsLease).
app.post('/api/write/:docId/lease', ah(async (req, res) => {
  const { tok, s: s0 } = await liveSession(req);
  if (s0.state === 'ended') return res.status(409).json({ error: 'Your writing session has ended.', ...endedReply(s0) });
  const body = req.body || {};
  const PANEL_OFF = 'Side-panel mode is turned off for this assignment.';
  if (body.give === 'panel') {
    if (!sessionsLib.panelAllowed(s0)) throw new HttpError(409, PANEL_OFF);
    const t = Date.now();
    const lease = { surfaceId: 'panel', sessionId: s0.id, surf: 'panel', at: new Date(t).toISOString() };
    const doc = await repo.updateRecord('doc', s0.docId, d => { d.lease = lease; });
    await repo.updateRecord('session', s0.id, x => {
      // Counts as present for a moment while the panel loads, so the handoff
      // records no pause
      sessionsLib.leaseMoved(x, 'panel', t, { handoff: true });
      x.lastBeat = new Date(t).toISOString();
      sessionsLib.addEvent(x, { t, type: 'lease', surf: 'panel', handoff: true });
      sessionsLib.evaluateFocus(x, t);
    });
    return res.json({ lease, doc: docView(doc) });
  }
  const surfaceId = String(body.surfaceId || '').slice(0, 60);
  if (!surfaceId) throw new HttpError(400, 'surfaceId is required');
  const surf = body.surf === 'panel' ? 'panel' : 'tab';
  if ((surf === 'panel' || tok.surf === 'panel') && !sessionsLib.panelAllowed(s0)) throw new HttpError(409, PANEL_OFF);
  const t = Date.now();
  const lease = { surfaceId, sessionId: s0.id, surf, at: new Date(t).toISOString() };
  const doc = await repo.updateRecord('doc', s0.docId, d => { d.lease = lease; });
  await repo.updateRecord('session', s0.id, x => {
    sessionsLib.leaseMoved(x, surf, t);
    x.surfaces[surfaceId] = { kind: surf, focused: true, visible: true, fullscreen: x.surfaces[surfaceId]?.fullscreen ?? true, lastBeat: new Date(t).toISOString() };
    x.lastBeat = new Date(t).toISOString();
    sessionsLib.addEvent(x, { t, type: 'lease', surf });
    sessionsLib.evaluateFocus(x, t);
  });
  res.json({ lease, doc: docView(doc) });
}));

// The student ends the session
app.post('/api/write/:docId/end', ah(async (req, res) => {
  const { s: s0 } = await liveSession(req);
  const a = await repo.getRecord('assignment', s0.assignmentId);
  const s = await repo.updateRecord('session', s0.id, x => sessionsLib.endSession(x, 'student', Date.now()));
  await afterSessionEnded(s, a);
  res.json({ session: sessionsLib.clientView(s, Date.now()) });
}));

// Submit: ends any running session and marks the document submitted. Word
// limits only warn.
app.post('/api/write/:docId/submit', ah(async (req, res) => {
  const core = await repo.readCore();
  const got = await docFor(req, core);
  if (!got.isOwner) throw new HttpError(403, 'Only the student can submit their document.');
  if (got.doc.status === 'submitted') throw new HttpError(409, 'This is already submitted.');
  const list = await sweepDocSessions(got.doc, got.a);
  const t = Date.now();
  for (const s of list.filter(s => s.state !== 'ended')) {
    const done = await repo.updateRecord('session', s.id, x => { sessionsLib.addEvent(x, { t, type: 'submit' }); sessionsLib.endSession(x, 'submitted', t); });
    await afterSessionEnded(done, got.a);
  }
  if (!list.some(s => s.state !== 'ended') && list[0]) await repo.updateRecord('session', list[0].id, x => { sessionsLib.addEvent(x, { t, type: 'submit', afterSession: true }); });
  const doc = await repo.updateRecord('doc', got.doc.id, d => { d.status = 'submitted'; d.submittedAt = new Date(t).toISOString(); d.reopened = false; d.lease = null; d.updatedAt = now(); });
  const w = got.a.writing || {}, words = doc.stats?.words || 0;
  const warning = w.minWords && words < w.minWords ? `Submitted with ${words} words; the assignment asks for at least ${w.minWords}.`
    : w.maxWords && words > w.maxWords ? `Submitted with ${words} words; the assignment asks for at most ${w.maxWords}.` : null;
  res.json({ doc: docView(doc), warning });
}));

// ---- Sources (Works Cited) ----
// Kept on the document, not in the op-logged text, so a bibliography is never
// counted as the student's writing. The in-text citation the editor inserts
// is an ordinary op with src:'cite'.

// A 'written' source is the whole citation as the student wrote or pasted it
// (written), with the in-text citation they want (inTextWritten, optional).
const SOURCE_FIELDS = { url: 2000, canonicalUrl: 2000, title: 300, siteName: 150, publisher: 150, published: 20, modified: 20, doi: 200, journal: 150, volume: 40, issue: 40, pages: 40, written: 1500, inTextWritten: 120 };
const SOURCE_TYPES = ['webpage', 'article', 'journal', 'video', 'book', 'written'];
function cleanSource(raw = {}, base = {}) {
  const src = { ...base };
  for (const [k, max] of Object.entries(SOURCE_FIELDS)) if (raw[k] !== undefined) src[k] = cleanText(String(raw[k] ?? ''), max);
  if (raw.authors !== undefined) src.authors = (Array.isArray(raw.authors) ? raw.authors : String(raw.authors || '').split('\n')).map(a => cleanText(String(a), 120)).filter(Boolean).slice(0, 20);
  if (raw.type !== undefined) src.type = SOURCE_TYPES.includes(raw.type) ? raw.type : 'webpage';
  src.authors = src.authors || []; src.type = src.type || 'webpage';
  if (src.url && !/^https?:\/\//i.test(src.url)) src.url = '';
  return src;
}
function withFormatting(src, style) {
  const f = citeFormat.format(src, style, { accessed: src.accessed });
  return { ...src, style, formatted: f.text, formattedHtml: f.html, inText: f.inText, check: f.check };
}
async function sourceDocFor(req) {
  const core = await repo.readCore();
  const got = await docFor(req, core);
  if (!got.isOwner) throw new HttpError(403, 'Only the student can change their sources.');
  if (got.doc.status === 'submitted') throw new HttpError(409, 'This document has been submitted.');
  return got;
}
const activeSessionOf = async docId => (await repo.listRecords('session', { docId })).find(s => s.state !== 'ended') || null;

// Add a source (the cite button, or the student by hand). The same page twice
// is one source. Returns { source, existing }. The extension's one-click cite
// sends via: 'extension', which the teacher can turn off. With Works Cited
// off there are no citation tools at all, so nothing is added (sources a
// document already has can still be edited or deleted).
app.post('/api/write/:docId/sources', ah(async (req, res) => {
  const got = await sourceDocFor(req);
  if (got.a.writing?.worksCited === 'off') throw new HttpError(403, 'Citations are turned off for this assignment.');
  if (req.body?.via === 'extension' && got.a.writing?.oneClickCite === false) throw new HttpError(403, 'One-click citing is turned off for this assignment.');
  const style = got.a.writing?.citationStyle || 'mla';
  const t = Date.now();
  const s = await activeSessionOf(got.doc.id);
  let src = cleanSource(req.body?.source || {});
  const written = src.type === 'written';
  if (written && !src.written) throw new HttpError(400, 'Write or paste the citation.');
  if (!written && !src.title && !src.url) throw new HttpError(400, 'A source needs at least a title or a link.');
  src = withFormatting({ ...src, id: uid(), accessed: new Date(t).toISOString().slice(0, 10), addedAt: new Date(t).toISOString(), sessionId: s?.id || null }, style);
  let existing = false;
  const doc = await repo.updateRecord('doc', got.doc.id, d => {
    d.sources = d.sources || [];
    // Written sources are the student's own words, so never "the same page"
    const same = !written && src.url && d.sources.find(x => x.type !== 'written' && (x.canonicalUrl || x.url) === (src.canonicalUrl || src.url));
    if (same) { existing = true; src = same; return; }
    if (d.sources.length >= 200) throw new HttpError(400, 'At most 200 sources.');
    d.sources.push(src);
  });
  // The research log links the citation to the page it came from
  if (s && !existing) {
    await repo.withRecords(async tx => {
      const sess = await tx.get('session', s.id);
      const last = sess.researchLast != null ? await tx.get('research', research.chunkId(sess.id, sess.researchLast)) : null;
      const chunks = research.appendEvents(sess, last, [{ t, type: 'cite', url: src.url, host: (() => { try { return new URL(src.url).hostname; } catch { return ''; } })(), title: src.title || (src.written || '').replace(/\*([^*]+)\*/g, '$1').slice(0, 300), sourceId: src.id }]);
      for (const c of chunks) tx.put('research', c);
      sess.researchLast = chunks[chunks.length - 1].no;
      tx.put('session', sess);
    });
  }
  res.json({ source: src, existing, sources: doc.sources });
}));

// Look a source up from a link, a DOI or an ISBN, for the editor to fill its
// form from (lib/cite-lookup.js). Nothing is saved. { query } -> { source,
// found, missing, via, grade } (grade: lib/source-grade.js, or null). A page
// that can't be read is a 422, never a 500.
// Private addresses are let through only for tests on a local stub server.
app.post('/api/write/:docId/sources/lookup', ah(async (req, res) => {
  const got = await sourceDocFor(req);
  if (got.a.writing?.worksCited === 'off') throw new HttpError(403, 'Citations are turned off for this assignment.');
  if (!citeLookup.rateLimit(got.me.id)) throw new HttpError(429, 'Too many lookups. Wait a minute, or fill in the details yourself.');
  const allowPrivate = process.env.VISOR_CITE_ALLOW_PRIVATE === '1' && process.env.NODE_ENV !== 'production' && !IS_PROD;
  let out;
  try {
    out = await citeLookup.lookup(req.body?.query, { allowPrivate });
  } catch (e) {
    if (e instanceof citeLookup.LookupError) throw new HttpError(e.status, e.message);
    throw new HttpError(422, citeLookup.MESSAGES.page);
  }
  const source = cleanSource(out.source);
  res.json({ source, found: out.found, missing: out.missing, via: out.via, grade: sourceGrade.grade(source) });
}));

// Edit a source by hand (recorded as a session event when one is running)
app.patch('/api/write/:docId/sources/:sourceId', ah(async (req, res) => {
  const got = await sourceDocFor(req);
  const style = got.a.writing?.citationStyle || 'mla';
  let out = null;
  const doc = await repo.updateRecord('doc', got.doc.id, d => {
    const i = (d.sources || []).findIndex(x => x.id === req.params.sourceId);
    if (i < 0) throw new HttpError(404, 'source not found');
    const next = cleanSource(req.body?.source || {}, d.sources[i]);
    // An edit can't leave a source with nothing to cite
    if (next.type === 'written' ? !next.written : !next.title && !next.url) throw new HttpError(400, next.type === 'written' ? 'Write or paste the citation.' : 'A source needs at least a title or a link.');
    d.sources[i] = out = withFormatting(next, style);
    d.sources[i].editedAt = now();
  });
  const s = await activeSessionOf(got.doc.id);
  if (s) await repo.updateRecord('session', s.id, x => sessionsLib.addEvent(x, { t: Date.now(), type: 'source-edit', sourceId: out.id }));
  res.json({ source: out, sources: doc.sources });
}));

app.delete('/api/write/:docId/sources/:sourceId', ah(async (req, res) => {
  const got = await sourceDocFor(req);
  const doc = await repo.updateRecord('doc', got.doc.id, d => { d.sources = (d.sources || []).filter(x => x.id !== req.params.sourceId); });
  const s = await activeSessionOf(got.doc.id);
  if (s) await repo.updateRecord('session', s.id, x => sessionsLib.addEvent(x, { t: Date.now(), type: 'source-edit', sourceId: req.params.sourceId, detail: 'deleted' }));
  res.json({ sources: doc.sources });
}));

// ---- Teacher review (Section 7.8) ----

async function teacherDocFor(req) {
  const core = await repo.readCore();
  const got = await docFor(req, core);
  if (!got.isTeacher) throw new HttpError(403, 'Only the class teacher can review this.');
  return { ...got, core };
}

// Every op of a document, in order
async function allOps(docId) {
  const chunks = await repo.listRecords('opchunk', { docId });
  return chunks.sort((a, b) => a.no - b.no).flatMap(c => c.ops || []);
}

// The process report, cached on the document until its next op
// The cache key: new ops, research arriving later, session changes and
// sources all make a new report
function processKey(doc, sessions, researchChunks) {
  return [PROCESS_VERSION, doc.seq, (doc.sources || []).length, doc.status,
    sessions.map(s => `${s.id}:${(s.events || []).length}:${(s.pauses || []).length}:${s.state}:${(s.researchSpans || []).length}:${!!s.research}`).join(','),
    researchChunks.reduce((n, c) => n + (c.events || []).length, 0)].join('|');
}

async function processReportFor(core, doc, a) {
  const [sessions, researchChunks] = await Promise.all([repo.listRecords('session', { docId: doc.id }), repo.listRecords('research', { docId: doc.id })]);
  const key = processKey(doc, sessions, researchChunks);
  if (doc.process && doc.process.key === key) return doc.process;
  const [ops, classDocs] = await Promise.all([allOps(doc.id), repo.listRecords('doc', { classId: doc.classId, studentId: doc.studentId })]);
  // A paste made before its copy reached the server (the extension sends
  // copies within seconds, research otherwise every minute) is matched now
  const unmatched = ops.filter(o => o.paste && !o.paste.origin && !o.paste.internal);
  if (unmatched.length) {
    const copies = research.copiesFrom(await repo.listRecords('research', { studentId: doc.studentId, assignmentId: doc.assignmentId }));
    research.matchPasteOrigins(unmatched, copies, { studentId: doc.studentId });
  }
  // This student's usual pace in this class, from their other essays' reports
  const others = classDocs.filter(d => d.id !== doc.id && d.stats?.processWpm).map(d => d.stats.processWpm).sort((x, y) => x - y);
  const baselineWpm = others.length ? others[Math.floor(others.length / 2)] : null;
  const report = { v: PROCESS_VERSION, key, ...processLib.build({ doc, ops, sessions, researchChunks, studentName: fullName(core.users[doc.studentId]), title: a?.title, baselineWpm }) };
  await repo.updateRecord('doc', doc.id, d => {
    if (d.seq !== report.seq) return;
    d.process = report;
    d.stats = { ...(d.stats || {}), processWpm: report.typing.wpm || d.stats?.processWpm || null };
  });
  return report;
}
const PROCESS_VERSION = 6;

app.get('/api/review/:docId', ah(async (req, res) => {
  const got = await teacherDocFor(req);
  const { doc, a, cls, core } = got;
  const report = await processReportFor(core, doc, a);
  const sessions = (await repo.listRecords('session', { docId: doc.id })).sort((x, y) => (x.startedAt < y.startedAt ? -1 : 1));
  // Prev / next student in roster order, among students who have a document
  const docs = await repo.listRecords('doc', { assignmentId: doc.assignmentId });
  const order = cls.studentIds.map(id => core.users[id]).filter(Boolean).sort((x, y) => x.lastName.localeCompare(y.lastName) || x.firstName.localeCompare(y.firstName))
    .map(u => docs.find(d => d.studentId === u.id)).filter(Boolean);
  const i = order.findIndex(d => d.id === doc.id);
  const navOf = d => (d ? { docId: d.id, name: fullName(core.users[d.studentId]) } : null);
  res.json({
    doc: { ...docView(doc), feedback: doc.feedback || null },
    student: publicUser(core.users[doc.studentId]),
    assignment: { id: a.id, title: a.title, writing: a.writing, instructions: a.instructions },
    class: { id: cls.id, name: cls.name, color: cls.color },
    nav: { prev: navOf(order[i - 1]), next: navOf(order[i + 1]), position: i + 1, of: order.length },
    sessions: sessions.map(s => ({ ...sessionsLib.clientView(s, Date.now()), pauses: s.pauses, events: s.events, extension: s.extension, opsFrom: s.opsFrom, opsTo: s.opsTo })),
    report,
    imageToken: await imageToken(doc.id, got.me.id)
  });
}));

// Feedback and score; "Return to student" (and optionally let them write again)
app.post('/api/review/:docId/feedback', ah(async (req, res) => {
  const got = await teacherDocFor(req);
  const b = req.body || {};
  const comment = typeof b.comment === 'string' ? b.comment.slice(0, 10000) : '';
  const score = b.score === '' || b.score == null ? null : Number(b.score);
  const outOf = b.outOf === '' || b.outOf == null ? null : Number(b.outOf);
  if (score != null && !Number.isFinite(score)) throw new HttpError(400, 'The score must be a number');
  if (outOf != null && (!Number.isFinite(outOf) || outOf <= 0)) throw new HttpError(400, '“Out of” must be a positive number');
  const feedback = { comment, score, outOf, at: now(), by: got.me.id };
  await repo.putRecord('feedback', { id: got.doc.id, docId: got.doc.id, studentId: got.doc.studentId, assignmentId: got.doc.assignmentId, classId: got.doc.classId, ...feedback, updatedAt: now() });
  const doc = await repo.updateRecord('doc', got.doc.id, d => {
    d.feedback = feedback;
    if (b.returnToStudent) { d.status = 'returned'; d.returnedAt = now(); d.reopened = !!b.reopen; }
    else if (b.reopen === false && d.status === 'returned') d.reopened = false;
  });
  res.json({ doc: { ...docView(doc), feedback: doc.feedback } });
}));

// The op log, for replay: the class teacher, or the student for their own doc.
app.get('/api/write/:docId/ops', ah(async (req, res) => {
  const core = await repo.readCore();
  const got = await docFor(req, core);
  const from = Math.max(1, Number(req.query.from) || 1);
  const to = Math.min(got.doc.seq, Number(req.query.to) || got.doc.seq, from + 4999);
  const ops = [];
  if (to >= from) {
    for (let no = writing.chunkNo(from); no <= writing.chunkNo(to); no++) {
      const c = await repo.getRecord('opchunk', writing.chunkId(got.doc.id, no));
      for (const op of c?.ops || []) if (op.n >= from && op.n <= to) ops.push(op);
    }
  }
  res.json({ ops, from, to, seq: got.doc.seq, nextFrom: to < got.doc.seq ? to + 1 : null });
}));

// ═══════════════════════════════════════════════════════════════
// SECTION 13 — EXTENSION API
// ═══════════════════════════════════════════════════════════════
//
// The Visor extension authenticates with its own token (X-Visor-Token),
// issued on /extension/connect while the person is signed in. Firebase
// Hosting only forwards the __session cookie, and extension pages can't rely
// on third-party cookies, so a header it is. Tokens are signed with purpose
// 'ext', last 30 days, and each one has an "exttoken" record so it can be
// revoked. Every /api/ext/* route uses extAuth except /api/ext/token itself.

const EXT_TOKEN_DAYS = 30;

// Called from chrome-extension:// pages and the extension's service worker.
// Never with credentials: the token is the only thing that authenticates.
app.use('/api/ext', (req, res, next) => {
  const origin = req.get('Origin') || '';
  if (/^chrome-extension:\/\/[a-z]{32}$/.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Visor-Token, X-Visor-Session');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// The user a valid X-Visor-Token belongs to, or null
async function extUserFromHeader(req, core) {
  const raw = req.get('X-Visor-Token');
  if (!raw) return null;
  const t = verify(await getSessionSecret(), String(raw), 'ext');
  if (!t || !t.uid || !t.tid || !(t.exp > Date.now())) return null;
  const rec = await repo.getRecord('exttoken', t.tid);
  if (!rec || rec.studentId !== t.uid || rec.revokedAt) return null;
  const u = core.users[t.uid];
  return u ? Object.assign(u, { _extTid: t.tid }) : null;
}
const extAuth = ah(async (req, res, next) => {
  const core = await repo.readCore();
  const u = await extUserFromHeader(req, core);
  if (!u) return res.status(401).json({ error: 'The Visor extension isn’t connected. Open Visor and connect it again.', reconnect: true });
  req.extUser = u; req.core = core;
  next();
});

// Issue a token for the signed-in person (cookie). The connect page hands it to the extension.
app.post('/api/ext/token', requireAuth, ah(async (req, res) => {
  const core = await repo.readCore();
  const me = meOrThrow(req, core);
  const tid = uid();
  const iat = Date.now(), exp = iat + EXT_TOKEN_DAYS * 864e5;
  await repo.putRecord('exttoken', { id: tid, studentId: me.id, createdAt: new Date(iat).toISOString(), expiresAt: new Date(exp).toISOString(), userAgent: String(req.get('User-Agent') || '').slice(0, 200) });
  const token = sign(await getSessionSecret(), { uid: me.id, tid, iat, exp }, 'ext');
  res.json({ token, user: { id: me.id, name: fullName(me), email: me.email, role: me.role }, expiresAt: new Date(exp).toISOString() });
}));

// Disconnect: revokes every extension token this person has
app.delete('/api/ext/token', requireAuth, ah(async (req, res) => {
  const n = await repo.deleteRecords('exttoken', { studentId: req.session.userId });
  res.json({ ok: true, revoked: n });
}));

// For the Profile dialog: is an extension connected?
app.get('/api/ext/token/status', requireAuth, ah(async (req, res) => {
  const list = (await repo.listRecords('exttoken', { studentId: req.session.userId })).filter(t => Date.parse(t.expiresAt) > Date.now());
  res.json({ connected: list.length > 0, tokens: list.length, latest: list.map(t => t.createdAt).sort().pop() || null });
}));

app.get('/api/ext/me', extAuth, (req, res) => {
  const u = req.extUser;
  res.json({ user: { id: u.id, name: fullName(u), email: u.email, role: u.role } });
});

// The student's own document, for extension calls that name a docId
async function extDoc(req, docId) {
  const doc = await repo.getRecord('doc', String(docId || ''));
  if (!doc || doc.studentId !== req.extUser.id) throw new HttpError(404, 'document not found');
  return doc;
}

// The extension confirms it's present before a session starts (Section 7.1, rule 4)
app.post('/api/ext/session/ack', extAuth, ah(async (req, res) => {
  const doc = await extDoc(req, req.body?.docId);
  const ack = { userId: req.extUser.id, at: now(), version: String(req.body?.version || '').slice(0, 20), hasHostPermission: req.body?.hasHostPermission !== false };
  await repo.updateRecord('doc', doc.id, d => { d.extAck = ack; });
  res.json({ ok: true, ack });
}));

// The extension's own beat, every minute during a session: whether its
// lockdown is on and whether it may record research. Tells it when the
// session is over so it can stop recording.
app.post('/api/ext/session/beat', extAuth, ah(async (req, res) => {
  const doc = await extDoc(req, req.body?.docId);
  const a = await repo.getRecord('assignment', doc.assignmentId);
  const list = await sweepDocSessions(doc, a);
  const s = list.find(x => x.state !== 'ended');
  if (!s) return res.json({ active: false });
  const lockActive = !!req.body?.lockActive, hasHostPermission = req.body?.hasHostPermission !== false;
  const updated = await repo.updateRecord('session', s.id, x => {
    const t = Date.now();
    x.extension = { ...(x.extension || {}), lastBeat: new Date(t).toISOString(), lockActive, hasHostPermission, present: true, version: String(req.body?.version || x.extension?.version || '').slice(0, 20) };
  });
  // Which surface writes ('tab' or 'panel'), so the extension's research mode follows it
  res.json({ active: true, sessionId: updated.id, state: updated.state, deadlineAt: updated.deadlineAt, startedAt: updated.startedAt, leaseSurf: doc.lease?.sessionId === s.id ? doc.lease.surf : null });
}));

// Research events from the extension: { sessionToken, docId, events: [...] }
// (at most 200 per batch, 30 batches a minute per session). Kept in "research"
// records next to the session; AI-site visits and blocked navigations also go
// into the session's own event list.
app.post('/api/ext/research', extAuth, ah(async (req, res) => {
  const body = req.body || {};
  const tok = verify(await getSessionSecret(), String(body.sessionToken || ''), WSESS);
  if (!tok || tok.uid !== req.extUser.id || tok.docId !== body.docId) throw new HttpError(403, 'That session isn’t yours.');
  const s0 = await repo.getRecord('session', tok.sid);
  if (!s0 || s0.studentId !== req.extUser.id) throw new HttpError(404, 'session not found');
  // A late batch from a session that just ended is still kept; a stale one isn't
  if (s0.state === 'ended' && Date.now() - Date.parse(s0.endedAt) > 15 * 60 * 1000) throw new HttpError(410, 'That session ended.');
  if (!research.rateLimit(s0.id)) throw new HttpError(429, 'Too many research batches; try again in a minute.');
  // (a 'panel-closed' stamped after the session ended is just tidying up: not kept)
  const events = research.cleanEvents(body.events).filter(e => !(e.type === 'panel-closed' && s0.endedAt && e.t > Date.parse(s0.endedAt)));
  if (!events.length) return res.json({ ok: true, stored: 0 });
  await repo.withRecords(async t => {
    const s = await t.get('session', s0.id);
    const last = s.researchLast != null ? await t.get('research', research.chunkId(s.id, s.researchLast)) : null;
    const chunks = research.appendEvents(s, last, events);
    for (const c of chunks) t.put('research', c);
    s.researchLast = chunks[chunks.length - 1].no;
    s.researchCount = (s.researchCount || 0) + events.length;
    for (const e of events) {
      if (e.type === 'ai-site') sessionsLib.addEvent(s, { t: e.t, type: 'ai-site', host: e.host, url: e.url, blocked: !!e.blocked, ...(e.site ? { site: e.site } : {}) });
      if (e.type === 'blocked') sessionsLib.addEvent(s, { t: e.t, type: 'lock-violation', host: e.host, url: e.url });
      // (not one stamped after the session ended: the panel closing then is just tidying up)
      if (e.type === 'panel-closed' && !(s.endedAt && e.t > Date.parse(s.endedAt))) sessionsLib.addEvent(s, { t: e.t, type: 'panel-closed' });
    }
    t.put('session', s);
  });
  res.json({ ok: true, stored: events.length });
}));

// Formatting for the extension's cite button outside a session (it copies the
// citation to the clipboard). Nothing is stored. { meta, style } -> { text, html, inText }
app.post('/api/ext/cite/format', (req, res) => {
  const style = ['mla', 'apa', 'chicago'].includes(req.body?.style) ? req.body.style : 'mla';
  const f = citeFormat.format(cleanSource(req.body?.meta || {}), style);
  res.json({ text: f.text, html: f.html, inText: f.inText, check: f.check, style });
});

// ---- Group documents (Section 8.7) ----
// Projects this person belongs to (as student or teacher, co-teachers of a
// class's group project included)
const projectsOf = (core, u) => Object.values(core.projects).filter(p => isProjectTeacher(core, p, u.id) || p.studentIds.includes(u.id));

// Google Docs linked to the person's group projects: [{ fileId, projectId, title }]
app.get('/api/ext/linked-docs', extAuth, (req, res) => {
  const list = projectsOf(req.core, req.extUser).filter(p => p.fileId).map(p => ({ fileId: p.fileId, projectId: p.id, title: p.name }));
  res.json({ docs: list });
});

// The person's projects, for the side panel's "Send to Visor" list
app.get('/api/ext/projects', extAuth, (req, res) => {
  const list = projectsOf(req.core, req.extUser).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 100).map(p => ({ id: p.id, name: p.name, fileId: p.fileId || null }));
  res.json({ projects: list });
});

// A report from the extension, signed in: { report, projectId? }. Without a
// projectId it goes to every project of this person's that links this Doc.
// (The code-based /api/extension/ingest still works for anyone not connected.)
app.post('/api/ext/ingest', extAuth, ah(async (req, res) => {
  const norm = normalizeReport(req.body?.report);
  if (!norm) throw new HttpError(400, 'report is missing or not in a recognized shape');
  const mine = projectsOf(req.core, req.extUser);
  let targets;
  if (req.body?.projectId) {
    const p = mine.find(x => x.id === req.body.projectId);
    if (!p) throw new HttpError(404, 'You’re not in that project.');
    targets = [p];
  } else {
    targets = norm.fileId ? mine.filter(p => p.fileId === norm.fileId) : [];
    if (!targets.length) throw new HttpError(404, 'This document isn’t linked to any of your projects.');
  }
  const out = [];
  for (const p of targets) {
    const r = await upsertDocumentResource(p, norm, req.extUser.id, fullName(req.extUser));
    out.push({ project: { id: p.id, name: p.name }, resource: { id: r.id, title: r.title } });
  }
  res.json({ ok: true, sent: out });
}));

// Copy events this student made for this assignment, for paste origins
async function researchCopiesFor(studentId, assignmentId) {
  const chunks = await repo.listRecords('research', { studentId, assignmentId });
  const since = Date.now() - research.LIMITS.ORIGIN_WINDOW_MS - 60000;
  return research.copiesFrom(chunks).filter(c => c.t >= since);
}

// ---- Group projects (Section 9) ----
// Each group of a group-project assignment is an ordinary project (SECTIONS
// 7–9 unchanged), tagged with its class and assignment and the group's
// linked Google Doc. Saving the assignment creates or updates them; a group
// removed from the assignment keeps its project (and anything in it).
async function syncGroupProjects(a, cls, teacher) {
  const groups = a.group?.groups || [];
  const ids = await repo.withCore(core => {
    return groups.map(g => {
      let p = g.projectId ? own(core.projects, g.projectId) : null;
      if (!p) {
        p = { id: uid(), orgId: teacher.orgId || null, teacherId: cls.teacherId, studentIds: [], code: newProjectCode(core), showAnalysis: false, createdAt: now() };
        core.projects[p.id] = p;
      }
      Object.assign(p, { name: `${a.title} – ${g.name}`.slice(0, 120), studentIds: [...g.studentIds], classId: cls.id, assignmentId: a.id, groupId: g.id, fileId: g.fileId || null, docUrl: g.docUrl || '' });
      return p.id;
    });
  });
  await repo.updateRecord('assignment', a.id, x => {
    x.group.groups = groups.map((g, i) => ({ ...g, projectId: ids[i] }));
    x.group.projectIds = ids;
  });
}
async function groupRows(core, a) {
  const groups = a.group?.groups || [];
  const counts = await repo.countResources(groups.map(g => g.projectId).filter(Boolean));
  return groups.map(g => {
    const p = g.projectId ? own(core.projects, g.projectId) : null;
    return { id: g.id, name: g.name, students: g.studentIds.map(id => publicUser(core.users[id])).filter(Boolean), docUrl: g.docUrl, fileId: g.fileId, projectId: p ? p.id : null, resourceCount: p ? counts[p.id] || 0 : 0, lastAnalyzedAt: p?.lastAnalyzedAt || null };
  });
}
async function myGroupFor(core, a, me) {
  const g = (await groupRows(core, a)).find(x => x.students.some(s => s.id === me.id));
  return g || null;
}

// ═══════════════════════════════════════════════════════════════
// SECTION 14 — DISCUSSIONS
// ═══════════════════════════════════════════════════════════════
//
// A Discussion assignment holds recordings of a class discussion
// ("discussion" records). The browser recorder splits long recordings into
// 10-minute segments and uploads each one as it finishes, with the same
// chunked upload as project recordings. Segments are transcribed one after
// another: segment k's prompt carries segment k-1's voices and two quotes
// each, so the same voice keeps its label. The voice wizard then runs once
// over the merged voices, with the class roster as choices. The analysis is
// measured arithmetic (lib/discussion.js) plus an AI-written summary.

const DISC_STALE_MS = (IS_FIREBASE ? 11 : 6) * 60 * 1000;
const discussionJobs = new Map(); // `${did}:${k}` -> Promise (local runs)

function discussionStatus(d) {
  const segs = d.segments || [];
  if (d.recording) return 'recording';
  if (!segs.length) return 'empty';
  if (segs.some(s => s.status === 'queued' || s.status === 'transcribing')) return 'transcribing';
  if (segs.some(s => s.status === 'error')) return 'error';
  if ((d.speakers || []).some(s => !s.assignedName)) return 'identify';
  return 'ready';
}

async function discussionFor(req, core, did = req.params.did) {
  const d = await repo.getRecord('discussion', did);
  if (!d) throw new HttpError(404, 'discussion not found');
  const got = classes.classFor(core, meOrThrow(req, core), d.classId);
  return { d, ...got };
}
async function teacherDiscussion(req, core) {
  const got = await discussionFor(req, core);
  if (!got.isTeacher) throw new HttpError(403, 'only the class teacher can do that');
  return got;
}
const rosterOf = (core, cls) => cls.studentIds.map(id => core.users[id]).filter(Boolean).map(u => ({ id: u.id, name: fullName(u) }));
// The class's staff as voices: [{ id, name }], the owner first (any of them may
// be heard leading a discussion). Only the staff see this list.
const teachersOf = (core, cls) => classes.staffIdsOf(cls).map(id => own(core.users, id)).filter(Boolean).map(t => ({ id: t.id, name: fullName(t) }));

// Segments that have been "transcribing" longer than a job may run were cut off
async function reconcileDiscussion(d) {
  const stale = (d.segments || []).filter(s => s.status === 'transcribing' && !discussionJobs.has(`${d.id}:${s.k}`) && Date.now() - Date.parse(s.startedAt || 0) > DISC_STALE_MS);
  // A recording that hasn't sent a part in 15 minutes (parts come every 10)
  // was cut off: its page closed or the computer slept
  const lastPart = Math.max(Date.parse(d.createdAt), ...(d.segments || []).map(s => Date.parse(s.uploadedAt || 0)));
  const abandoned = d.recording && Date.now() - lastPart > 15 * 60 * 1000;
  if (!stale.length && !abandoned) return d;
  return repo.updateRecord('discussion', d.id, x => {
    for (const s of x.segments) if (stale.some(t => t.k === s.k) && s.status === 'transcribing') { s.status = 'error'; s.error = 'Transcription was interrupted before it finished. Try again.'; }
    if (abandoned) x.recording = false;
    x.status = discussionStatus(x);
  });
}

// Start the next segment that's waiting, once every segment before it is done
async function kickDiscussion(did) {
  let start = null;
  await repo.updateRecord('discussion', did, d => {
    start = null;
    const segs = [...(d.segments || [])].sort((a, b) => a.k - b.k);
    for (const s of segs) {
      if (s.status === 'transcribing') return;
      if (s.status === 'queued') { s.status = 'transcribing'; s.startedAt = now(); s.error = null; start = s.k; break; }
    }
    d.status = discussionStatus(d);
  });
  if (start == null) return;
  if (IS_FIREBASE) {
    const { firestore } = require('./lib/firebaseAdmin');
    await firestore().collection('visor_jobs').add({ kind: 'discussion', discussionId: did, k: start, createdAt: now() });
    return;
  }
  const key = `${did}:${start}`;
  if (discussionJobs.has(key)) return;
  discussionJobs.set(key, runDiscussionJob(did, start).finally(() => discussionJobs.delete(key)));
}

async function runDiscussionJob(did, k) {
  try {
    await transcribeDiscussionSegment(did, k);
  } catch (err) {
    console.error(`discussion transcription failed for ${did} segment ${k}:`, err.message);
    await repo.updateRecord('discussion', did, d => {
      const s = d.segments.find(x => x.k === k);
      if (s) { s.status = 'error'; s.error = geminiReady() ? err.message : 'Transcription is unavailable: this server has no Gemini access set up.'; }
      d.status = discussionStatus(d);
    }).catch(() => {});
  }
  await kickDiscussion(did).catch(() => {});
}

async function transcribeDiscussionSegment(did, k) {
  const d = await repo.getRecord('discussion', did);
  const seg = d?.segments.find(s => s.k === k);
  if (!seg) return;
  const core = await repo.readCore();
  const cls = own(core.classes, d.classId);
  const people = cls ? [...rosterOf(core, cls), ...teachersOf(core, cls)].map(p => p.name).filter(Boolean) : [];
  const prev = d.segments.find(s => s.k === k - 1 && s.status === 'ready');
  const prompt = transcriptionPrompt({ setting: 'This is a recording of a class discussion at school, led by a teacher.', people, hints: discussionLib.hintsFrom(prev) });
  const { lines, speakers } = await transcribeAudio(seg.audio, prompt);
  await repo.updateRecord('discussion', did, x => {
    const s = x.segments.find(y => y.k === k);
    Object.assign(s, { lines, speakers: speakers.map(({ assignedName, assignedUserId, ...rest }) => rest), status: 'ready', error: null, transcribedAt: now() });
    x.speakers = discussionLib.mergeSpeakers(x.segments.filter(y => y.status === 'ready'), x.speakers);
    x.status = discussionStatus(x);
    x.analysis = null;
  });
}

// What the teacher's page shows
function discussionView(core, d, cls) {
  const lines = discussionLib.mergedLines((d.segments || []).filter(s => s.status === 'ready'));
  const nameFor = label => (d.speakers || []).find(s => s.label === label)?.assignedName || label;
  return {
    id: d.id, assignmentId: d.assignmentId, title: d.title, createdAt: d.createdAt, status: discussionStatus(d), recording: !!d.recording,
    segments: (d.segments || []).sort((a, b) => a.k - b.k).map(s => ({ k: s.k, status: s.status, error: s.error || null, durationSec: s.durationSec || null, lines: (s.lines || []).length, audioUrl: `/api/discussions/${d.id}/segments/${s.k}/audio` })),
    speakers: d.speakers || [],
    transcript: lines.map(l => ({ i: l.i, t: l.t, label: l.speaker, speaker: nameFor(l.speaker), text: l.text })),
    people: [...rosterOf(core, cls).map(r => ({ ...r, role: 'student' })), ...teachersOf(core, cls).map(t => ({ ...t, role: 'teacher' }))],
    analysis: d.analysis || null
  };
}

async function discussionRows(a) {
  const list = await repo.listRecords('discussion', { assignmentId: a.id });
  return list.sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1)).map(d => ({ id: d.id, title: d.title, createdAt: d.createdAt, status: discussionStatus(d), segments: (d.segments || []).length, analyzedAt: d.analysis?.at || null }));
}

// A student's own numbers, if the teacher shares them (never anyone else's)
async function myDiscussionStats(a, me) {
  if (!a.discussion?.shareOwnStats) return null;
  const list = await repo.listRecords('discussion', { assignmentId: a.id });
  return list.filter(d => d.analysis?.measured).map(d => {
    const r = d.analysis.measured.students.find(s => s.userId === me.id);
    return { title: d.title, createdAt: d.createdAt, durationSec: d.analysis.measured.durationSec, mine: r ? { talkSec: r.talkSec, turns: r.turns, words: r.words, longestTurnSec: r.longestTurnSec, firstAtText: r.firstAtText, sharePct: r.sharePct } : null };
  });
}

// The recording notice, confirmed once per class
app.post('/api/classes/:id/discussion-consent', requireAuth, ah(async (req, res) => {
  if (req.body?.confirmed !== true) throw new HttpError(400, 'Tick the box to confirm.');
  const out = await repo.withCore(core => { const got = teacherClass(req, core); got.cls.discussionConsentAt = now(); return publicClass(core, got.cls, got.me); });
  res.json({ class: out });
}));

app.post('/api/assignments/:id/discussions', requireAuth, ah(async (req, res) => {
  const core = await repo.readCore();
  const got = await teacherAssignment(req, core);
  if (got.a.type !== 'discussion') throw new HttpError(400, 'Only discussion assignments have recordings.');
  if (!got.cls.discussionConsentAt) throw new HttpError(409, 'Confirm the recording notice for this class first.');
  const d = {
    id: uid(), assignmentId: got.a.id, classId: got.cls.id, createdBy: got.me.id, createdAt: now(), updatedAt: now(),
    title: cleanText(req.body?.title, 120) || `${got.a.title} – ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
    source: req.body?.source === 'upload' ? 'upload' : 'recorder', recording: req.body?.source !== 'upload', segments: [], speakers: [], status: 'recording', analysis: null
  };
  await repo.putRecord('discussion', d);
  await repo.updateRecord('assignment', got.a.id, x => { x.discussion.discussionIds = [...(x.discussion.discussionIds || []), d.id]; });
  res.json({ discussion: discussionView(core, d, got.cls) });
}));

app.get('/api/discussions/:did', requireAuth, ah(async (req, res) => {
  const core = await repo.readCore();
  const got = await teacherDiscussion(req, core);
  const d = await reconcileDiscussion(got.d);
  res.json({ discussion: discussionView(core, d, got.cls), geminiReady: geminiReady() });
}));

app.patch('/api/discussions/:did', requireAuth, ah(async (req, res) => {
  const core = await repo.readCore();
  const got = await teacherDiscussion(req, core);
  const d = await repo.updateRecord('discussion', got.d.id, x => { if (cleanText(req.body?.title, 120)) x.title = cleanText(req.body.title, 120); });
  res.json({ discussion: discussionView(core, d, got.cls) });
}));

// Segment uploads: the same three steps as project recordings (SECTION 8)
async function readDiscUploadToken(req, token) {
  const t = verify(await getSessionSecret(), String(token || ''), 'disc-upload');
  if (!t || t.exp < Date.now() || t.did !== req.params.did || t.userId !== req.session.userId) throw new HttpError(400, 'That upload has expired or is not valid. Start the upload again.');
  return t;
}
app.post('/api/discussions/:did/uploads', requireAuth, ah(async (req, res) => {
  const core = await repo.readCore();
  const got = await teacherDiscussion(req, core);
  const size = Number(req.body?.size), k = Number(req.body?.k);
  if (!Number.isInteger(size) || size <= 0) throw new HttpError(400, 'no audio received');
  if (!Number.isInteger(k) || k < 0 || k > 200) throw new HttpError(400, 'bad segment number');
  if (size > audioStorage.MAX_AUDIO_BYTES) throw new HttpError(413, 'That file is over 60 MB. Try a shorter or more compressed recording.');
  const { mimeType, fileExt } = audioMime(req.body?.filename, req.body?.mime);
  const up = await audioStorage.startUpload({ projectId: `disc-${got.d.id}`, ext: fileExt, mime: mimeType, size });
  const uploadToken = sign(await getSessionSecret(), { up, did: got.d.id, k, userId: got.me.id, exp: Date.now() + UPLOAD_TOKEN_MS }, 'disc-upload');
  res.json({ uploadToken, chunkBytes: audioStorage.CHUNK_BYTES });
}));
app.put('/api/discussions/:did/uploads/chunk', requireAuth, express.raw({ type: () => true, limit: '6mb' }), ah(async (req, res) => {
  await teacherDiscussion(req, await repo.readCore());
  const t = await readDiscUploadToken(req, req.get('X-Upload-Token'));
  const offset = Number(req.query.offset);
  const buf = Buffer.isBuffer(req.body) ? req.body : (Buffer.isBuffer(req.rawBody) ? req.rawBody : null);
  if (!Number.isInteger(offset) || offset < 0 || !buf || !buf.length) throw new HttpError(400, 'That piece of the upload is missing.');
  res.json(await audioStorage.writeChunk(t.up, offset, buf));
}));
// Finish a segment: { uploadToken, duration, last }. `last` ends the recording.
app.post('/api/discussions/:did/segments', requireAuth, ah(async (req, res) => {
  const core = await repo.readCore();
  const got = await teacherDiscussion(req, core);
  const t = await readDiscUploadToken(req, req.body?.uploadToken);
  if ((got.d.segments || []).some(s => s.k === t.k)) throw new HttpError(409, 'That part of the recording was already added.');
  const audio = await audioStorage.finishUpload(t.up);
  const d = await repo.updateRecord('discussion', got.d.id, x => {
    x.segments.push({ k: t.k, audio: { ...audio, duration: Number(req.body?.duration) || null }, durationSec: Number(req.body?.duration) || null, status: 'queued', error: null, lines: [], speakers: [], uploadedAt: now() });
    if (req.body?.last) x.recording = false;
    x.status = discussionStatus(x); x.updatedAt = now();
  });
  await kickDiscussion(d.id);
  res.json({ discussion: discussionView(core, await repo.getRecord('discussion', d.id), got.cls) });
}));
// The recorder stopped (its last segment may already be uploaded)
app.post('/api/discussions/:did/finish', requireAuth, ah(async (req, res) => {
  const core = await repo.readCore();
  const got = await teacherDiscussion(req, core);
  const d = await repo.updateRecord('discussion', got.d.id, x => { x.recording = false; x.status = discussionStatus(x); });
  res.json({ discussion: discussionView(core, d, got.cls) });
}));
app.get('/api/discussions/:did/segments/:k/audio', requireAuth, ah(async (req, res) => {
  const got = await teacherDiscussion(req, await repo.readCore());
  const s = got.d.segments.find(x => x.k === Number(req.params.k));
  if (!s) throw new HttpError(404, 'recording not found');
  await audioStorage.streamAudio(s.audio, req, res);
}));
app.post('/api/discussions/:did/segments/:k/retranscribe', requireAuth, ah(async (req, res) => {
  const core = await repo.readCore();
  const got = await teacherDiscussion(req, core);
  const k = Number(req.params.k);
  await repo.updateRecord('discussion', got.d.id, x => { const s = x.segments.find(y => y.k === k); if (s && s.status === 'error') { s.status = 'queued'; s.error = null; } x.status = discussionStatus(x); });
  await kickDiscussion(got.d.id);
  res.json({ discussion: discussionView(core, await repo.getRecord('discussion', got.d.id), got.cls) });
}));

// Who each voice is: { assignments: { "Speaker 1": { name, userId? } | null } }
app.post('/api/discussions/:did/speakers', requireAuth, ah(async (req, res) => {
  const core = await repo.readCore();
  const got = await teacherDiscussion(req, core);
  const allowed = new Set([...got.cls.studentIds, ...classes.staffIdsOf(got.cls)]);
  const assignments = req.body?.assignments || {};
  const d = await repo.updateRecord('discussion', got.d.id, x => {
    for (const sp of x.speakers || []) {
      const a = assignments[sp.label];
      if (a === undefined) continue;
      if (a === null || !a.name) { sp.assignedName = null; sp.assignedUserId = null; continue; }
      sp.assignedName = cleanText(String(a.name), 80);
      sp.assignedUserId = a.userId && allowed.has(a.userId) ? a.userId : null;
    }
    x.status = discussionStatus(x); x.analysis = null;
  });
  res.json({ discussion: discussionView(core, d, got.cls) });
}));

// Measured stats (always) and the AI-written summary (when Gemini is set up)
app.post('/api/discussions/:did/analyze', requireAuth, ah(async (req, res) => {
  const core = await repo.readCore();
  const got = await teacherDiscussion(req, core);
  const { d, cls, a } = { ...got, a: await repo.getRecord('assignment', got.d.assignmentId) };
  const ready = (d.segments || []).filter(s => s.status === 'ready');
  if (!ready.length) throw new HttpError(400, 'Nothing has been transcribed yet.');
  const lines = discussionLib.mergedLines(ready);
  const roster = rosterOf(core, cls), teachers = teachersOf(core, cls);
  const measured = discussionLib.measure(lines, d.speakers || [], roster, teachers);
  let ai = null, aiError = null;
  if (!geminiReady()) aiError = 'The AI-written summary is unavailable: this server has no Gemini access set up. The measured figures are complete.';
  else {
    try {
      const raw = await geminiJSON([{ text: discussionLib.aiPrompt({ title: d.title, promptText: a?.instructions, lines, speakers: d.speakers || [], roster, teacher: teachers }) }], { temperature: 0.2, maxOutputTokens: 6000 });
      ai = discussionLib.sanitizeAI(raw, { lines, speakers: d.speakers || [], roster, teacher: teachers });
    } catch (err) { aiError = `Gemini could not write the summary: ${err.message}`; }
  }
  const analysis = { at: now(), measured, ai, aiError };
  const saved = await repo.updateRecord('discussion', d.id, x => { x.analysis = analysis; });
  res.json({ discussion: discussionView(core, saved, cls) });
}));

app.delete('/api/discussions/:did', requireAuth, ah(async (req, res) => {
  const core = await repo.readCore();
  const got = await teacherDiscussion(req, core);
  for (const s of got.d.segments || []) if (s.audio) await audioStorage.deleteAudio(s.audio);
  await repo.deleteRecord('discussion', got.d.id);
  await repo.updateRecord('assignment', got.d.assignmentId, x => { x.discussion.discussionIds = (x.discussion.discussionIds || []).filter(id => id !== got.d.id); });
  res.json({ ok: true });
}));

// ---- Privacy: retention, and a student's own data ----

// Research the extension recorded is kept for each class's retention period
// (180 days unless the teacher changes it), then deleted. Essays and their
// writing history stay. Runs daily: the "sweep" scheduled function on
// Firebase (index.js), an interval when running locally (boot, below).
async function runRetentionSweep() {
  const core = await repo.readCore();
  let deleted = 0;
  for (const cls of Object.values(core.classes)) {
    const days = Number(cls.researchRetentionDays) || 180;
    const before = new Date(Date.now() - days * 864e5).toISOString();
    deleted += await repo.deleteRecords('research', { classId: cls.id }, { updatedBefore: before });
  }
  if (deleted) console.log(`retention sweep: deleted ${deleted} research record(s)`);
  return deleted;
}

// "Download my data": everything Visor Classroom keeps about a student, as JSON
app.get('/api/me/export', requireAuth, ah(async (req, res) => {
  const core = await repo.readCore();
  const me = meOrThrow(req, core);
  const myClasses = Object.values(core.classes).filter(c => c.studentIds.includes(me.id) || classes.isClassTeacher(c, me.id));
  const docs = await repo.listRecords('doc', { studentId: me.id });
  const out = {
    exportedAt: now(), about: 'Everything Visor Classroom keeps about you: your account, your classes, your essays with their full writing history and the pictures you added, your writing sessions, the research the Visor extension recorded during them, and teacher feedback.',
    imagesNote: 'Pictures you added to an essay are listed under that essay (images). To download one, open its url while you’re signed in to Visor.',
    account: publicUser(me, core),
    // teacher: the owner; teachers: everyone teaching it, owner first
    classes: myClasses.map(c => ({ id: c.id, name: c.name, teacher: fullName(core.users[c.teacherId]), teachers: classes.teacherIdsOf(c).map(id => fullName(own(core.users, id))).filter(Boolean) })),
    projects: Object.values(core.projects).filter(p => p.studentIds.includes(me.id)).map(p => ({ id: p.id, name: p.name })),
    documents: []
  };
  for (const d of docs) {
    const a = await repo.getRecord('assignment', d.assignmentId);
    const [ops, sessions, research, images] = await Promise.all([allOps(d.id), repo.listRecords('session', { docId: d.id }), repo.listRecords('research', { docId: d.id }), repo.listRecords('image', { docId: d.id })]);
    out.documents.push({
      assignment: a ? { id: a.id, title: a.title } : { id: d.assignmentId }, class: core.classes[d.classId]?.name || null,
      text: d.text, formats: d.formats, sources: d.sources, status: d.status, submittedAt: d.submittedAt, returnedAt: d.returnedAt,
      feedback: d.status === 'returned' || d.reopened ? d.feedback || null : null, stats: d.stats,
      editLog: ops,
      images: images.sort((x, y) => (x.createdAt < y.createdAt ? -1 : 1)).map(i => ({ id: i.id, mime: i.mime, sizeBytes: i.sizeBytes, width: i.width, height: i.height, createdAt: i.createdAt, url: `/api/images/${i.id}` })),
      sessions: sessions.map(({ surfaces, away, awayReason, ...s }) => s),
      research: research.sort((x, y) => x.no - y.no).flatMap(c => c.events)
    });
  }
  // Discussions: the lines that were matched to this student's voice
  const discussions = [];
  for (const c of myClasses) {
    for (const disc of await repo.listRecords('discussion', { classId: c.id })) {
      const mineLabels = (disc.speakers || []).filter(sp => sp.assignedUserId === me.id).map(sp => sp.label);
      if (!mineLabels.length) continue;
      const lines = discussionLib.mergedLines((disc.segments || []).filter(s => s.status === 'ready')).filter(l => mineLabels.includes(l.speaker)).map(l => ({ t: l.t, text: l.text }));
      discussions.push({ title: disc.title, recordedAt: disc.createdAt, yourLines: lines });
    }
  }
  out.discussions = discussions;
  res.setHeader('Content-Disposition', `attachment; filename="visor-my-data-${new Date().toISOString().slice(0, 10)}.json"`);
  res.type('application/json').send(JSON.stringify(out, null, 2));
}));

// ═══════════════════════════════════════════════════════════════
// SECTION 15 — PAGES, ERRORS, BOOT
// ═══════════════════════════════════════════════════════════════

// Privacy policy and terms (linked from Google's sign-in screen, so they must stay at these URLs)
app.get('/privacy', (req, res) => res.type('html').send(legal.privacy()));
app.get('/terms', (req, res) => res.type('html').send(legal.terms()));

if (process.env.VISOR_DEV_LOGIN === '1' && !IS_PROD) {
  // DEV ONLY: fake sign-in without a password. Never enabled in production.
  app.get('/dev/login', ah(async (req, res) => {
    const core = await repo.readCore();
    const u = Object.values(core.users).find(x => x.email === String(req.query.email || '').toLowerCase());
    if (!u) return res.status(404).send('no such user');
    await joinInvitesIfAny(core, u);
    req.session.userId = u.id;
    res.redirect('/');
  }));
}

app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

// Any unknown page serves the app (single page)
let INDEX_HTML = null;
try { INDEX_HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8'); } catch {}
app.get('*', (req, res) => (INDEX_HTML ? res.type('html').send(INDEX_HTML) : res.status(404).send('Not found')));

// Errors come back as JSON the frontend can show
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || (err.type === 'entity.too.large' ? 413 : 500);
  if (status >= 500) console.error(err);
  const message = status === 413 ? 'That upload is too large.'
    : (err instanceof HttpError || err.name === 'DriveError' || status < 500) ? err.message
    : 'Something went wrong on the server. Try again in a moment.';
  res.status(status).json({ error: message, ...(err.data || {}) });
});

async function boot() {
  checkConfig();
  if (!process.env.DATABASE_URL) await repo.importLegacyStoreIfEmpty(path.join(__dirname, 'data', 'store.json'));
  // Resume any transcription that was interrupted by a restart
  const core = await repo.readCore();
  for (const p of Object.values(core.projects)) {
    for (const r of await repo.listResources(p.id)) if (r.type === 'audio' && r.audio.status === 'transcribing') await startTranscription(r.id);
  }
  // …and discussion segments that were waiting or being transcribed
  for (const d of await repo.listRecords('discussion', {})) {
    if ((d.segments || []).some(s => s.status === 'transcribing')) await repo.updateRecord('discussion', d.id, x => { for (const s of x.segments) if (s.status === 'transcribing') s.status = 'queued'; });
    if ((d.segments || []).some(s => s.status === 'queued' || s.status === 'transcribing')) await kickDiscussion(d.id);
  }
}

// `npm start` runs this file directly. On Firebase, index.js loads it instead.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n  Visor running → http://localhost:${PORT}\n`);
    boot().then(() => console.log('')).catch(err => console.error('startup error:', err));
    // Research retention, daily (on Firebase this is the "sweep" scheduled function)
    setTimeout(() => runRetentionSweep().catch(err => console.error('retention sweep:', err.message)), 60 * 1000);
    setInterval(() => runRetentionSweep().catch(err => console.error('retention sweep:', err.message)), 24 * 3600 * 1000);
  });
}

module.exports = app;
module.exports.runTranscriptionJob = runTranscriptionJob;
module.exports.runDiscussionJob = runDiscussionJob;
module.exports.runRetentionSweep = runRetentionSweep;
