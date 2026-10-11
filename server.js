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
const { normalizeReport, buildDriveReport } = require('./lib/reports');
const { analyzeDriveFile } = require('./lib/drive');
const legal = require('./lib/legalPages');
const { sessionMiddleware, sign, verify } = require('./lib/session');
const { IS_FIREBASE, IS_PROD } = require('./lib/platform');
const { OAuth2Client } = require('google-auth-library');
const classes = require('./lib/classes');
const assignments = require('./lib/assignments');
const { DEFAULT_AI_SITES } = require('./lib/sites');
const writing = require('./lib/writing');
const sessionsLib = require('./lib/sessions');
const research = { matchPasteOrigins() {} }; // lib/research.js arrives with research capture

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
  console.log(`  ✓ Database: ${process.env.DATABASE_URL ? 'Postgres (DATABASE_URL)' : 'local, in data/pglite'}`);
  console.log('  ✓ Recordings: local, in data/audio');
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
// Load the project and check the caller can see it (teacher-owner or student member)
function projectFor(req, core, id = req.params.id) {
  const project = own(core.projects, id);
  if (!project) throw new HttpError(404, 'project not found');
  const me = currentUser(req, core);
  if (!me || (project.teacherId !== me.id && !project.studentIds.includes(me.id))) throw new HttpError(403, 'not a member of this project');
  return { project, isDemo: false, me, isTeacher: project.teacherId === me.id };
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
const UNDER_13_MESSAGE = 'Ask your teacher to add you to their class.';
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

async function transcribeResource(resourceId) {
  const r = await repo.getResource(resourceId);
  if (!r || r.type !== 'audio') return;
  const core = await repo.readCore();
  const project = core.projects[r.projectId];
  const people = project ? projectPeople(core, project).map(p => p.name) : [];

  const prompt = `This is a recording of a student group working on a school project.${people.length ? ` The people who might be in it: ${people.join(', ')} (there may also be others).` : ''}

Transcribe it word for word and separate the speakers by voice. Do NOT guess names; label voices "Speaker 1", "Speaker 2", etc., numbered in order of first appearance. Do not summarize or interpret anything.

Return ONLY JSON in this shape:
{
  "lines": [ { "t": "mm:ss", "speaker": "Speaker 1", "text": "exactly what they said" } ],
  "speakers": [
    { "label": "Speaker 1", "quotes": ["three short, distinctive things this voice said, in their own words", "…", "…"], "voice": "brief neutral description of the voice, e.g. 'lower voice, speaks fast'" }
  ]
}
Keep every line short (one thought each). Every line's speaker must be one of the labels in "speakers".`;

  const opts = { temperature: 0.2, maxOutputTokens: 16000 };
  const inline = async () => geminiJSON([
    { text: prompt },
    { inlineData: { mimeType: r.audio.mime, data: (await audioStorage.readAudio(r.audio)).toString('base64') } }
  ], opts);
  let parsed;
  const gsUri = GEMINI_VIA === 'vertex' ? audioStorage.gcsUri(r.audio) : null;
  if (gsUri) {
    // Vertex AI reads the recording straight from Cloud Storage (no size limit
    // from sending it inside the request). If it can't, send the bytes instead.
    try {
      parsed = await geminiJSON([{ text: prompt }, { fileData: { mimeType: r.audio.mime, fileUri: gsUri } }], opts);
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

  await repo.updateResource(resourceId, res => {
    res.audio.lines = lines;
    res.audio.speakers = speakers;
    res.audio.transcribedAt = now();
    res.audio.status = speakers.length ? 'identify' : 'ready';
    res.audio.error = null;
  });
}

// Everyone who could be a voice in a project's recording
function projectPeople(core, project) {
  const t = core.users[project.teacherId];
  const list = project.studentIds.map(id => core.users[id]).filter(Boolean).map(u => ({ id: u.id, name: `${u.firstName} ${u.lastName}`, role: 'student', avatarColor: u.avatarColor || null }));
  if (t) list.push({ id: t.id, name: `${t.firstName} ${t.lastName}`, role: 'teacher', avatarColor: t.avatarColor || null });
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
  const isTeacher = project.teacherId === me.id;
  const out = {
    id: project.id, name: project.name, code: isTeacher ? project.code : undefined,
    teacher: publicUser(core.users[project.teacherId]), students: project.studentIds.map(id => publicUser(core.users[id])).filter(Boolean),
    showAnalysis: !!project.showAnalysis, isTeacher, createdAt: project.createdAt,
    classId: project.classId || null, assignmentId: project.assignmentId || null,
    hasAnalysis: !!project.lastAnalyzedAt, lastAnalyzedAt: project.lastAnalyzedAt || null,
    resourceCount: resources ? resources.length : (resourceCount || 0)
  };
  if (resources) out.resources = resources;
  return out;
}
async function fullProject(core, project, me) {
  return publicProject(core, project, me, { resources: await projectResources(project) });
}

app.get('/api/projects', requireAuth, ah(async (req, res) => {
  const core = await repo.readCore();
  const me = currentUser(req, core);
  if (!me) return res.status(401).json({ error: 'not signed in' });
  const mineRaw = Object.values(core.projects)
    .filter(p => p.teacherId === me.id || p.studentIds.includes(me.id))
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
  const fairnessScore = calculateFairness(contributors);
  const silentMembers = students.filter(m => !contributors.some(c => c.id === m.id)).map(m => m.name);

  // Prompt
  const L = [];
  L.push(`PROJECT: ${project.name}`);
  L.push(`STUDENTS: ${students.map(s => s.name).join(', ') || '(none added yet)'}`);
  L.push(`TEACHER: ${members.find(m => m.role === 'teacher')?.name || '?'}`);
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
    ai = sanitizeAIReport(await geminiJSON([{ text: prompt }], { temperature: 0.3, maxOutputTokens: 5000 }), contributors.filter(c => c.isMember !== false && c.id !== project.teacherId));
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

// Counts and upcoming work for a class card.
async function classSummary(cls, isTeacher, meId) {
  const assignments = (await repo.listRecords('assignment', { classId: cls.id })).filter(a => isTeacher || a.publishedAt);
  const out = { assignmentCount: assignments.length, upcoming: [] };
  const soon = assignments.filter(a => a.publishedAt && a.dueAt && Date.parse(a.dueAt) > Date.now() - 864e5)
    .sort((a, b) => (a.dueAt < b.dueAt ? -1 : 1)).slice(0, 3);
  out.upcoming = soon.map(a => ({ id: a.id, title: a.title, type: a.type, dueAt: a.dueAt }));
  if (isTeacher) {
    const sessions = await repo.listRecords('session', { classId: cls.id });
    const docs = await repo.listRecords('doc', { classId: cls.id });
    out.activeSessions = sessions.filter(isLive).length;
    out.toReview = docs.filter(d => d.status === 'submitted').length;
  } else {
    const docs = await repo.listRecords('doc', { classId: cls.id, studentId: meId });
    out.submitted = docs.filter(d => d.status === 'submitted' || d.status === 'returned').length;
  }
  return out;
}

function publicClass(core, cls, me) {
  const isTeacher = cls.teacherId === me.id;
  const base = { id: cls.id, name: cls.name, archived: !!cls.archived, createdAt: cls.createdAt, isTeacher, teacher: publicUser(core.users[cls.teacherId]), studentCount: cls.studentIds.length };
  if (!isTeacher) return base;
  return {
    ...base,
    joinCode: cls.joinCode, joinOpen: cls.joinOpen !== false,
    students: cls.studentIds.map(id => publicUser(core.users[id])).filter(Boolean).sort((a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName)),
    pendingInvites: cls.pendingInvites || [],
    accommodations: cls.accommodations || {},
    researchRetentionDays: cls.researchRetentionDays || 180,
    discussionConsentAt: cls.discussionConsentAt || null
  };
}

app.get('/api/classes', requireAuth, ah(async (req, res) => {
  const core = await repo.readCore();
  const me = meOrThrow(req, core);
  const mine = Object.values(core.classes).filter(c => c.teacherId === me.id || c.studentIds.includes(me.id))
    .sort((a, b) => Number(!!a.archived) - Number(!!b.archived) || (a.createdAt < b.createdAt ? 1 : -1));
  const list = await Promise.all(mine.map(async c => ({ ...publicClass(core, c, me), ...(await classSummary(c, c.teacherId === me.id, me.id)) })));
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
  const assignments = await classAssignmentsFor(got);
  res.json({ class: { ...publicClass(core, got.cls, got.me), ...(await classSummary(got.cls, got.isTeacher, got.me.id)) }, assignments });
}));

function teacherClass(req, core) {
  const got = classFor(req, core);
  if (!got.isTeacher) throw new HttpError(403, 'only the class teacher can do that');
  return got;
}

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

// The assignments on a class page (students only see published ones).
async function classAssignmentsFor(got) {
  const list = (await repo.listRecords('assignment', { classId: got.cls.id })).filter(a => got.isTeacher || a.publishedAt);
  return list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).map(a => ({ id: a.id, type: a.type, title: a.title, publishedAt: a.publishedAt || null, dueAt: a.dueAt || null, createdAt: a.createdAt }));
}

// Home page: what's happening now and what needs review (teachers), or a
// to-do list across every class (students).
app.get('/api/dashboard', requireAuth, ah(async (req, res) => {
  const core = await repo.readCore();
  const me = meOrThrow(req, core);
  if (me.role === 'teacher') {
    const mine = Object.values(core.classes).filter(c => c.teacherId === me.id && !c.archived);
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

// Everything a class owns: assignments, student documents and their op logs,
// sessions, research, discussions (and their recordings), feedback, and the
// group projects its assignments created. `studentId` narrows it to one
// student's data (the teacher's "delete this student's data").
async function deleteClassRecords(core, cls, { studentId } = {}) {
  const who = studentId ? { studentId } : {};
  const docs = await repo.listRecords('doc', { classId: cls.id, ...who });
  for (const d of docs) {
    await repo.deleteRecords('opchunk', { docId: d.id });
    await repo.deleteRecords('feedback', { docId: d.id });
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
  for (const p of Object.values(core.projects).filter(p => p.classId === cls.id)) await deleteProjectEverything(p.id);
}
async function deleteProjectEverything(projectId) {
  for (const r of await repo.listResources(projectId)) if (r.type === 'audio') await audioStorage.deleteAudio(r.audio);
  await repo.deleteProjectData(projectId);
  await repo.withCore(c => { delete c.projects[projectId]; });
}

// A teacher deletes one student's work in a class (documents, op logs,
// sessions, research, feedback). The student stays on the roster.
app.delete('/api/classes/:id/students/:userId/data', requireAuth, ah(async (req, res) => {
  const core = await repo.readCore();
  const got = teacherClass(req, core);
  await deleteClassRecords(core, got.cls, { studentId: String(req.params.userId) });
  res.json({ ok: true });
}));

// Deleting a class removes everything in it. The page asks the teacher to type
// the class name first; the server checks it too.
app.delete('/api/classes/:id', requireAuth, ah(async (req, res) => {
  const core = await repo.readCore();
  const got = teacherClass(req, core);
  if (String(req.body?.confirmName || '').trim() !== got.cls.name) throw new HttpError(400, 'Type the class name exactly to delete it.');
  await deleteClassRecords(core, got.cls);
  await repo.withCore(c => { delete c.classes[got.cls.id]; });
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

app.post('/api/classes/:id/assignments', requireAuth, ah(async (req, res) => {
  const core = await repo.readCore();
  const got = teacherClass(req, core);
  const a = assignments.createAssignment(got.cls, req.body || {});
  await repo.putRecord('assignment', a);
  if (a.type === 'group') await syncGroupProjects(a, got.cls, got.me);
  res.json({ assignment: await repo.getRecord('assignment', a.id) });
}));

app.get('/api/assignments/:id', requireAuth, ah(async (req, res) => {
  const core = await repo.readCore();
  const got = await assignmentFor(req, core);
  const { a, cls } = got;
  const classInfo = { id: cls.id, name: cls.name };
  if (got.isTeacher) {
    const out = { assignment: a, class: classInfo, isTeacher: true, describe: assignments.describeWriting(a.writing) };
    if (a.type === 'writing') out.submissions = await submissionRows(core, cls, a);
    if (a.type === 'group') out.groups = await groupRows(core, a);
    if (a.type === 'discussion') out.discussions = await discussionRows(a);
    out.students = cls.studentIds.map(id => publicUser(core.users[id])).filter(Boolean);
    return res.json(out);
  }
  const out = { assignment: assignments.studentView(a), class: classInfo, isTeacher: false, describe: assignments.describeWriting(a.writing, classes.multiplierFor(cls, got.me.id)) };
  if (a.type === 'writing') {
    const d = (await repo.listRecords('doc', { assignmentId: a.id, studentId: got.me.id }))[0];
    out.doc = d ? { id: d.id, status: d.status, words: d.stats?.words || 0, submittedAt: d.submittedAt || null, returnedAt: d.returnedAt || null } : null;
  }
  if (a.type === 'group') out.myGroup = await myGroupFor(core, a, got.me);
  if (a.type === 'discussion') out.myStats = await myDiscussionStats(a, got.me);
  res.json(out);
}));

app.patch('/api/assignments/:id', requireAuth, ah(async (req, res) => {
  const core = await repo.readCore();
  const got = await teacherAssignment(req, core);
  const a = await repo.updateRecord('assignment', got.a.id, x => { assignments.patchAssignment(x, req.body || {}, got.cls); });
  if (a.type === 'group') await syncGroupProjects(a, got.cls, got.me);
  res.json({ assignment: await repo.getRecord('assignment', a.id) });
}));

app.post('/api/assignments/:id/publish', requireAuth, ah(async (req, res) => {
  const core = await repo.readCore();
  const got = await teacherAssignment(req, core);
  const published = req.body?.published !== false;
  const a = await repo.updateRecord('assignment', got.a.id, x => { x.publishedAt = published ? (x.publishedAt || now()) : null; x.updatedAt = now(); });
  res.json({ assignment: a });
}));

// Copy to another of the teacher's classes (or the same one)
app.post('/api/assignments/:id/duplicate', requireAuth, ah(async (req, res) => {
  const core = await repo.readCore();
  const got = await teacherAssignment(req, core);
  const target = classes.classFor(core, got.me, req.body?.classId || got.cls.id);
  if (!target.isTeacher) throw new HttpError(403, 'you can only copy into your own classes');
  const copy = assignments.duplicateAssignment(got.a, target.cls);
  await repo.putRecord('assignment', copy);
  res.json({ assignment: copy });
}));

app.delete('/api/assignments/:id', requireAuth, ah(async (req, res) => {
  const core = await repo.readCore();
  const got = await teacherAssignment(req, core);
  await deleteAssignmentRecords(core, got.a);
  res.json({ ok: true });
}));

async function deleteAssignmentRecords(core, a) {
  for (const d of await repo.listRecords('doc', { assignmentId: a.id })) await repo.deleteRecords('opchunk', { docId: d.id });
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
async function writerUser(req, core) {
  const fromCookie = currentUser(req, core);
  if (fromCookie) return fromCookie;
  const ext = await extUserFromHeader(req, core);
  if (ext) return ext;
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

// A student document and who may see it: its student, or the class teacher.
async function docFor(req, core, docId = req.params.docId) {
  const me = await writerUser(req, core);
  const doc = await repo.getRecord('doc', docId);
  if (!doc) throw new HttpError(404, 'document not found');
  const cls = own(core.classes, doc.classId);
  const isOwner = doc.studentId === me.id;
  const isTeacher = !!cls && cls.teacherId === me.id;
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
    if (!doc.lease || doc.lease.sessionId !== s.id || doc.lease.surfaceId !== surfaceId) throw new HttpError(409, 'Another window is writing in this document.', { notLeaseHolder: true, lease: doc.lease, ...writing.resyncData(doc) });
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

// Beat: { surfaceId, surf, focused, visible, fullscreen, extPresent, extLock, online, events, offlinePause, seq, wantText }
app.post('/api/write/:docId/beat', ah(async (req, res) => {
  const { tok, s: s0 } = await liveSession(req);
  const a = await repo.getRecord('assignment', s0.assignmentId);
  const body = req.body || {};
  let endedNow = null, pausesBefore = s0.pauses.length;
  const s = await repo.updateRecord('session', s0.id, x => {
    const t = Date.now();
    endedNow = sessionsLib.sweep(x, t, { windowEnd: a?.writing?.windowEnd });
    if (x.state !== 'ended') sessionsLib.applyBeat(x, { ...body, surf: body.surf === 'panel' ? 'panel' : 'tab' }, t);
  });
  if (endedNow) await afterSessionEnded(s, a);
  else if (s.pauses.length !== pausesBefore) await syncDocStats(s.docId);
  const doc = await repo.getRecord('doc', s.docId);
  const out = { ...sessionsLib.clientView(s, Date.now()), lease: doc.lease, seq: doc.seq, docStatus: doc.status, ended: s.state === 'ended' };
  if (body.wantText && Number(body.seq) !== doc.seq) Object.assign(out, { text: doc.text, formats: doc.formats });
  res.json(out);
}));

// Hand the editing lease to this surface: { surfaceId, surf }
app.post('/api/write/:docId/lease', ah(async (req, res) => {
  const { s: s0 } = await liveSession(req);
  if (s0.state === 'ended') return res.status(409).json({ error: 'Your writing session has ended.', ...endedReply(s0) });
  const body = req.body || {};
  const surfaceId = String(body.surfaceId || '').slice(0, 60);
  if (!surfaceId) throw new HttpError(400, 'surfaceId is required');
  const surf = body.surf === 'panel' ? 'panel' : 'tab';
  const t = Date.now();
  const lease = { surfaceId, sessionId: s0.id, surf, at: new Date(t).toISOString() };
  const doc = await repo.updateRecord('doc', s0.docId, d => { d.lease = lease; });
  await repo.updateRecord('session', s0.id, x => {
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

// Extension API, research and citations (SECTION 13, phases 7–9)
async function extUserFromHeader() { return null; }
async function researchCopiesFor() { return []; }

// Group projects and discussions arrive in SECTIONS 11 and 14 (phases 12, 13).
async function syncGroupProjects() {}
async function groupRows() { return []; }
async function myGroupFor() { return null; }
async function discussionRows() { return []; }
async function myDiscussionStats() { return null; }

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
}

// `npm start` runs this file directly. On Firebase, index.js loads it instead.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n  Visor running → http://localhost:${PORT}\n`);
    boot().then(() => console.log('')).catch(err => console.error('startup error:', err));
  });
}

module.exports = app;
module.exports.runTranscriptionJob = runTranscriptionJob;
