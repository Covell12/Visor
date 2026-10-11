// Visor backend (v5)
// Accounts + schools, projects, resources (audio with speaker identification,
// document reports from the Visor extension or Google Drive), and the
// Gemini-written analysis. The frontend lives in public/ and talks to this
// over /api/*.
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
const audioFormats = require('./lib/audioFormats');
const audioConvert = require('./lib/audioConvert');
const { normalizeReport, buildDriveReport } = require('./lib/reports');
const { analyzeDriveFile } = require('./lib/drive');
const legal = require('./lib/legalPages');
const { sessionMiddleware, sign, verify } = require('./lib/session');
const { IS_FIREBASE, IS_PROD } = require('./lib/platform');
const { OAuth2Client } = require('google-auth-library');

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
    audioFormats: { byExt: audioFormats.FORMATS, byType: audioFormats.EXT_BY_TYPE, label: audioFormats.LABEL },
    google: googleReady() ? { ...GOOGLE } : null,
    googleSignIn: googleSignInReady() ? GOOGLE.clientId : null,
    geminiReady: geminiReady()
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

app.post('/api/auth/signup', ah(async (req, res) => {
  const { email, password, role, schoolId, schoolName } = req.body || {};
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
    const org = resolveSchoolChoice(core, { schoolId, schoolName });
    const user = { id: uid(), email: em, firstName, lastName, role, orgId: org ? org.id : null, passwordSalt: salt, passwordHash: hash, createdAt: now() };
    core.users[user.id] = user;
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
  req.session.userId = user.id;
  res.json({ user: publicUser(user, core) });
}));

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
  req.session.userId = user.id;
  res.json({ user: publicUser(user, core) });
}));

// Finishes account creation for a Google sign-in that had no existing account.
app.post('/api/auth/google/signup', ah(async (req, res) => {
  const { credential, role, schoolId, schoolName } = req.body || {};
  const g = await verifyGoogleCredential(credential);
  if (!['teacher', 'student'].includes(role)) return res.status(400).json({ error: 'Pick Student or Teacher' });
  const out = await repo.withCore(core => {
    let user = Object.values(core.users).find(u => u.email === g.email);
    if (user) { // account was created meanwhile (double submit, race with another tab)
      if (!user.googleSub) { user.googleSub = g.sub; delete user.passwordHash; delete user.passwordSalt; }
      return { user: publicUser(user, core), id: user.id };
    }
    const org = resolveSchoolChoice(core, { schoolId, schoolName });
    user = { id: uid(), email: g.email, firstName: cleanText(g.firstName, NAME_MAX) || 'Student', lastName: cleanText(g.lastName, NAME_MAX), role, orgId: org ? org.id : null, googleSub: g.sub, createdAt: now() };
    core.users[user.id] = user;
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

// Accepted recording types: lib/audioFormats.js. The stored file name and type
// only ever come from that list.

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

// Send a recording to Gemini and return its parsed JSON answer.
// The sound is converted to a small MP3 first (lib/audioConvert.js). Small
// MP3s go inside the request; bigger ones (over ~1 hour) are put in Cloud
// Storage for a moment so Vertex AI can read them from there.
const INLINE_AUDIO_MAX = Number(process.env.INLINE_AUDIO_MAX_BYTES) || 18 * 1024 * 1024;
const VERTEX_AUDIO_TYPE = { 'audio/aac': 'audio/x-aac' }; // Vertex's name for it (only used if conversion is unavailable)
async function transcribeAudio(r, prompt) {
  const opts = { temperature: 0.2, maxOutputTokens: 16000 };
  const original = await audioStorage.readAudio(r.audio);
  const ext = String(r.audio.path || r.audio.file || '').split('.').pop().toLowerCase();

  let mp3 = null;
  try {
    mp3 = await audioConvert.convert(original, ext);
  } catch (err) {
    if (err instanceof audioConvert.UnreadableAudio) throw new Error(err.message);
    console.warn('converting the recording failed; sending the original:', err.message);
  }
  const send = mp3
    ? { mimeType: 'audio/mp3', data: mp3, gsUri: null }
    : { mimeType: GEMINI_VIA === 'vertex' ? (VERTEX_AUDIO_TYPE[r.audio.mime] || r.audio.mime) : r.audio.mime, data: original, gsUri: GEMINI_VIA === 'vertex' ? audioStorage.gcsUri(r.audio) : null };

  const inline = () => geminiJSON([{ text: prompt }, { inlineData: { mimeType: send.mimeType, data: send.data.toString('base64') } }], opts);
  const viaStorage = async uri => {
    try {
      return await geminiJSON([{ text: prompt }, { fileData: { mimeType: send.mimeType, fileUri: uri } }], opts);
    } catch (err) {
      if (!/^Gemini (400|403):/.test(err.message)) throw err;
      console.warn('Vertex AI could not read the recording from Cloud Storage; sending it inline instead:', err.message);
      return inline();
    }
  };

  try {
    if (GEMINI_VIA === 'vertex' && send.data.length > INLINE_AUDIO_MAX && audioStorage.mode() === 'gcs') {
      if (send.gsUri) return await viaStorage(send.gsUri);
      const temp = await audioStorage.saveTemp(`transcode/${r.id}.mp3`, send.data, send.mimeType);
      try { return await viaStorage(temp.uri); } finally { await temp.remove(); }
    }
    return await inline();
  } catch (err) {
    // Say plainly when it's the recording Google rejected, not a setup problem.
    if (/^Gemini 400:/.test(err.message)) throw new Error(`Gemini couldn't process this recording. ${err.message.replace(/^Gemini 400:\s*/, 'Google said: ')}`);
    throw err;
  }
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

  const parsed = await transcribeAudio(r, prompt);

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
  const taken = new Set(Object.values(core.projects).map(p => p.code));
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
  const format = audioFormats.audioFormat(filename, mime);
  if (!format) return res.status(415).json({ error: audioFormats.unsupportedMessage(filename, mime), unsupportedType: true });
  const up = await audioStorage.startUpload({ projectId: got.project.id, ext: format.ext, mime: format.mime, size });
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
// SECTION 10 — PAGES, ERRORS, BOOT
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
