/* Visor — frontend. Plain JS, no framework.
   Sections: helpers · auth · shell · members · resources · speaker wizard · analysis */

'use strict';

/* ====================== helpers ====================== */
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initials = n => String(n || '?').trim().split(/\s+/).map(w => w[0] || '').join('').slice(0, 2).toUpperCase();
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const fmtDur = s => { s = Math.round(s || 0); const m = Math.floor(s / 60); return `${m}:${String(s % 60).padStart(2, '0')}`; };
const timeAgo = iso => {
  if (!iso) return '';
  const d = (Date.now() - new Date(iso)) / 1000;
  if (d < 60) return 'just now'; if (d < 3600) return `${Math.floor(d / 60)} min ago`; if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  if (d < 86400 * 7) return `${Math.floor(d / 86400)} d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};
const colorClass = i => `c${i % 8}`;
const PALETTE = ['#1E9BC4', '#4CA35C', '#E39B2E', '#7C5CD6', '#D9534F', '#2A9D8F', '#B5179E', '#6C757D'];
// Avatar circle: uses the person's chosen color, otherwise the logo gradient
function avatarHtml(person, size = '') {
  const bg = person?.avatarColor ? `background:${person.avatarColor}` : 'background:var(--grad)';
  return `<span class="avatar ${size}" style="${bg}">${initials(person?.name)}</span>`;
}
// Color for a person in charts/scripts: their chosen color, else a palette slot
function personColor(person, i) { return person?.avatarColor || PALETTE[i % 8]; }
function projectPerson(idOrName) {
  if (!project) return null;
  const all = [...(project.students || []), ...(project.teacher ? [project.teacher] : [])];
  return all.find(p => p.id === idOrName) || all.find(p => p.name.toLowerCase() === String(idOrName || '').toLowerCase()) || null;
}

async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await r.json(); } catch {}
  if (!r.ok) { const e = new Error(data.error || `Request failed (${r.status})`); e.status = r.status; e.data = data; throw e; }
  return data;
}

const I = {
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/></svg>',
  upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/></svg>',
  puzzle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19.4 14.2a2 2 0 1 0-2.6-2.6L15 13.5V10a1 1 0 0 0-1-1h-3.5l1.9-1.8a2 2 0 1 0-2.6-2.6L8 6.5V5a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v3a1 1 0 0 0 1 1h1.5L3.6 10.8a2 2 0 1 0 2.6 2.6L8 11.5V15a1 1 0 0 0 1 1h3.5l-1.9 1.8a2 2 0 1 0 2.6 2.6L15 18.5V20a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-3a1 1 0 0 0-1-1h-1.5z"/></svg>',
  doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8M16 17H8M10 9H8"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  hash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.2 2h-.4a2 2 0 0 0-2 2v.2a2 2 0 0 1-1 1.7l-.4.3a2 2 0 0 1-2 0l-.2-.1a2 2 0 0 0-2.7.7l-.2.4a2 2 0 0 0 .7 2.7l.2.1a2 2 0 0 1 1 1.7v.6a2 2 0 0 1-1 1.7l-.2.1a2 2 0 0 0-.7 2.7l.2.4a2 2 0 0 0 2.7.7l.2-.1a2 2 0 0 1 2 0l.4.3a2 2 0 0 1 1 1.7V20a2 2 0 0 0 2 2h.4a2 2 0 0 0 2-2v-.2a2 2 0 0 1 1-1.7l.4-.3a2 2 0 0 1 2 0l.2.1a2 2 0 0 0 2.7-.7l.2-.4a2 2 0 0 0-.7-2.7l-.2-.1a2 2 0 0 1-1-1.7v-.6a2 2 0 0 1 1-1.7l.2-.1a2 2 0 0 0 .7-2.7l-.2-.4a2 2 0 0 0-2.7-.7l-.2.1a2 2 0 0 1-2 0l-.4-.3a2 2 0 0 1-1-1.7V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  sparkle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z"/></svg>',
  chev: '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/></svg>',
  plusSm: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  school: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m10.3 3.9-8.4 14A2 2 0 0 0 3.6 21h16.8a2 2 0 0 0 1.7-3l-8.4-14a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>',
  pen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 19 7-7 3 3-7 7-3-3z"/><path d="m18 13-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="m2 2 7.6 7.6"/><circle cx="11" cy="11" r="2"/></svg>',
  compass: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m16.2 7.8-2.2 6.4-6.4 2.2 2.2-6.4z"/></svg>',
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.5 7.2L3 21l1.8-5.5A8 8 0 1 1 21 12z"/></svg>',
  minus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M8 12h8"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 1-15.5 6.3L3 16"/><path d="M3 21v-5h5"/><path d="M3 12a9 9 0 0 1 15.5-6.3L21 8"/><path d="M21 3v5h-5"/></svg>',
  drive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19a4.5 4.5 0 1 0-1.4-8.8A6 6 0 0 0 4.5 12.5 3.5 3.5 0 0 0 6 19z"/><path d="M12 11.5v6.5M9.5 15.5 12 18l2.5-2.5"/></svg>'
};

// Server settings: where recordings upload to, and the Google Drive picker keys (null when Drive isn't set up).
let CFG = { uploadMode: 'local', maxAudioMB: 60, chunkBytes: 4194304, google: null, audioFormats: null };
const configReady = fetch('/api/config').then(r => r.json()).then(c => { CFG = { ...CFG, ...c }; }).catch(() => {});

let toastTimer;
function toast(msg, kind = '') {
  const root = $('toastRoot');
  root.innerHTML = `<div class="toast ${kind}">${kind === 'err' ? I.alert : I.check}<span>${esc(msg)}</span></div>`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { root.innerHTML = ''; }, kind === 'err' ? 5000 : 2600);
}

// Modal: openModal({ title, sub, body, footer, wide, onClose }) → returns close()
let modalOnClose = null;
function openModal({ title, sub = '', body = '', footer = '', wide = false, onClose = null, closable = true }) {
  modalOnClose = onClose;
  $('modalRoot').innerHTML = `
    <div class="overlay" onclick="if(event.target===this)${closable ? 'closeModal()' : ''}">
      <div class="modal ${wide ? 'wide' : ''}">
        <div class="mh"><div><h3>${title}</h3>${sub ? `<p>${sub}</p>` : ''}</div>${closable ? `<button class="btn-icon" onclick="closeModal()">${I.x}</button>` : ''}</div>
        <div class="mb" id="modalBody">${body}</div>
        ${footer ? `<div class="mf" id="modalFooter">${footer}</div>` : '<div id="modalFooter"></div>'}
      </div>
    </div>`;
}
function closeModal() {
  $('modalRoot').innerHTML = '';
  if (modalOnClose) { const f = modalOnClose; modalOnClose = null; f(); }
}
function confirmModal(title, text, { okLabel = 'Confirm', danger = false } = {}) {
  return new Promise(resolve => {
    openModal({ title, body: `<p style="margin:0;">${esc(text)}</p>`, footer: `<button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="confirmOk">${esc(okLabel)}</button>`, onClose: () => resolve(false) });
    $('confirmOk').onclick = () => { modalOnClose = null; closeModal(); resolve(true); };
  });
}
function toggleMenu(id) { const m = $(id); const open = !m.classList.contains('hidden'); document.querySelectorAll('.menu').forEach(x => x.classList.add('hidden')); if (!open) m.classList.remove('hidden'); }
document.addEventListener('click', e => { if (!e.target.closest('.user-menu') && !e.target.closest('.proj-actions')) document.querySelectorAll('.menu').forEach(x => x.classList.add('hidden')); });

/* ====================== state ====================== */
let me = null;
let projects = [];
let project = null;        // full project currently open
let analysis = null;
let pollTimer = null;
let selectedRole = null;
let waitingModalFor = null; // resource id whose 'Transcribing…' dialog is open
let googlePending = null;  // {credential, email, firstName, lastName} while finishing a Google-only signup

/* ====================== auth ====================== */
function showAuth(which) {
  $('authView').classList.remove('hidden'); $('appView').classList.add('hidden');
  $('signinForm').classList.toggle('hidden', which !== 'signin');
  $('signupForm').classList.toggle('hidden', which !== 'signup');
  $('signinError').classList.add('hidden'); $('signupError').classList.add('hidden');
  if (which !== 'signup') exitGoogleSignupMode();
}

// Renders "Sign in with Google" into a container once the CFG says it's on
// and the GIS script has loaded. Safe to call more than once.
async function initGoogleSignIn() {
  if (!CFG.googleSignIn) return;
  const mounts = ['googleSigninBtn', 'googleSignupBtn'].map(id => $(id)).filter(Boolean);
  if (!mounts.length) return;
  try {
    await loadScriptOnce('https://accounts.google.com/gsi/client');
    window.google.accounts.id.initialize({ client_id: CFG.googleSignIn, callback: onGoogleCredential, auto_select: false });
    mounts.forEach(el => { el.classList.remove('hidden'); window.google.accounts.id.renderButton(el, { theme: 'outline', size: 'large', width: 320, text: 'continue_with' }); });
  } catch { /* Google script blocked or offline: password sign-in still works */ }
}

async function onGoogleCredential(resp) {
  formError('signinError', ''); formError('signupError', '');
  try {
    const r = await api('/api/auth/google', { method: 'POST', body: { credential: resp.credential } });
    if (r.needsSignup) {
      enterGoogleSignupMode(resp.credential, r);
      return;
    }
    me = r.user; enterApp();
  } catch (e) {
    formError($('signinForm').classList.contains('hidden') ? 'signupError' : 'signinError', e.message);
  }
}

// A brand-new Google account: show the sign-up form so the person picks a
// role (and school, if needed), with email/name locked in and no password field.
function enterGoogleSignupMode(credential, info) {
  googlePending = { credential };
  showAuth('signup');
  $('suEmail').value = info.email; $('suEmail').disabled = true;
  $('suFirst').value = info.firstName || ''; $('suLast').value = info.lastName || '';
  $('suPassword').closest('.field').classList.add('hidden'); $('suPassword').required = false;
  $('signupForm').classList.add('google-mode');
}
function exitGoogleSignupMode() {
  if (!googlePending) return;
  googlePending = null;
  $('suEmail').disabled = false;
  $('suPassword').closest('.field').classList.remove('hidden'); $('suPassword').required = true;
  $('signupForm').classList.remove('google-mode');
}
function formError(id, msg) { const el = $(id); el.textContent = msg; el.classList.toggle('hidden', !msg); }

function pickRole(role) {
  selectedRole = role;
  document.querySelectorAll('.role-card').forEach(c => c.classList.toggle('selected', c.dataset.role === role));
}

/* ---- school picker: pick a school on Visor, name a new one, or leave blank ---- */
function mountSchoolPicker(id, current) {
  const el = $(id);
  el.innerHTML = `
    <div class="school-picker-box">
      <input class="input" type="text" autocomplete="off" placeholder="Search for your school, or type its name" value="${esc(current?.name || '')}" />
      <div class="dropdown hidden"></div>
    </div>
    <div class="school-chosen tiny"></div>
    <div class="hint">Leave this blank if you'd rather not pick a school. You can change it any time in Profile settings.</div>`;
  el.dataset.schoolId = current?.id || '';
  const input = el.querySelector('input'), dd = el.querySelector('.dropdown');
  // Under the box: what will be saved. Hidden while suggestions are open.
  const showChosen = () => {
    const name = input.value.trim(), chosen = el.querySelector('.school-chosen');
    const open = !dd.classList.contains('hidden');
    chosen.innerHTML = !name || open ? '' : el.dataset.schoolId ? `${I.school}<span>${esc(name)}</span>` : `${I.school}<span>New school: <b>${esc(name)}</b></span>`;
  };
  const search = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2) { dd.classList.add('hidden'); showChosen(); return; }
    let schools = [];
    try { schools = (await api(`/api/schools?q=${encodeURIComponent(q)}`)).schools; } catch {}
    if (input.value.trim() !== q) return;
    const exact = schools.some(x => x.name.toLowerCase() === q.toLowerCase());
    dd.innerHTML = schools.map(x => `<button type="button" data-id="${esc(x.id)}" data-name="${esc(x.name)}">${I.school}<span>${esc(x.name)}</span></button>`).join('')
      + (exact ? '' : `<button type="button" data-id="" data-name="${esc(q)}">${I.plusSm}<span>Add <b>${esc(q)}</b> as a new school</span></button>`);
    dd.classList.remove('hidden'); showChosen();
  }, 200);
  input.addEventListener('input', () => { el.dataset.schoolId = ''; showChosen(); search(); });
  input.addEventListener('focus', search);
  dd.addEventListener('mousedown', e => {
    const b = e.target.closest('button'); if (!b) return;
    e.preventDefault();
    input.value = b.dataset.name; el.dataset.schoolId = b.dataset.id;
    dd.classList.add('hidden'); showChosen();
  });
  input.addEventListener('blur', () => setTimeout(() => { dd.classList.add('hidden'); showChosen(); }, 150));
  showChosen();
}
// What the person chose: { schoolId }, { schoolName }, or {} for no school.
function schoolChoice(id) {
  const el = $(id), name = el.querySelector('input').value.trim();
  if (!name) return {};
  return el.dataset.schoolId ? { schoolId: el.dataset.schoolId } : { schoolName: name };
}

async function doSignup() {
  formError('signupError', '');
  if (!selectedRole) return formError('signupError', 'Pick Student or Teacher.');
  try {
    let r;
    if (googlePending) {
      r = await api('/api/auth/google/signup', { method: 'POST', body: { credential: googlePending.credential, role: selectedRole, ...schoolChoice('suSchoolPicker') } });
    } else {
      const body = { email: $('suEmail').value.trim(), firstName: $('suFirst').value.trim(), lastName: $('suLast').value.trim(), password: $('suPassword').value, role: selectedRole, ...schoolChoice('suSchoolPicker') };
      r = await api('/api/auth/signup', { method: 'POST', body });
    }
    me = r.user; googlePending = null; enterApp();
  } catch (e) {
    formError('signupError', e.message);
  }
}
async function doSignin() {
  formError('signinError', '');
  try {
    const r = await api('/api/auth/login', { method: 'POST', body: { email: $('siEmail').value.trim(), password: $('siPassword').value } });
    me = r.user; enterApp();
  } catch (e) { formError('signinError', e.message); }
}
async function signOut() { await api('/api/auth/logout', { method: 'POST' }); me = null; project = null; showAuth('signin'); }
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  if (!$('signinForm').classList.contains('hidden') && $('signinForm').contains(document.activeElement)) doSignin();
  else if (!$('signupForm').classList.contains('hidden') && $('signupForm').contains(document.activeElement)) doSignup();
});

/* ====================== shell ====================== */
async function boot() {
  try {
    await configReady;
    const r = await api('/api/me');
    if (r.signedIn) { me = r.user; if (!r.geminiReady) toast('No Gemini key on the server yet. Transcription and analysis will fail until it is set.', 'err'); enterApp(); }
    else showAuth('signin');
  } catch { showAuth('signin'); }
  mountSchoolPicker('suSchoolPicker', null);
  initGoogleSignIn();
}

function enterApp() {
  $('authView').classList.add('hidden'); $('appView').classList.remove('hidden');
  $('topSchool').textContent = me.org?.name || '';
  $('userBtn').innerHTML = `${avatarHtml(me, 'avatar-sm')}<span><div class="n">${esc(me.name)}</div><div class="r">${esc(me.role)}</div></span>`;
  $('newProjectBtn').classList.toggle('hidden', me.role !== 'teacher');
  $('emptyMainText').textContent = me.role === 'teacher' ? 'Create a project on the left to add students and resources.' : 'Your teacher adds you to projects. They will show up on the left.';
  loadProjects();
  if (!me.tutorialSeen) setTimeout(openTutorial, 400);
}

/* ====================== profile settings ====================== */
function openProfile() {
  const color = me.avatarColor || '#4dbedc';
  openModal({ title: 'Profile settings', sub: 'How you appear to everyone in your projects.', body: `
    <div style="display:flex;align-items:center;gap:18px;margin-bottom:20px;">
      <span id="profPreview" class="avatar avatar-lg" style="background:${esc(color)};width:64px;height:64px;font-size:22px;">${initials(me.name)}</span>
      <div>
        <div style="font-weight:700;font-size:16px;" id="profPreviewName">${esc(me.name)}</div>
        <div class="muted small">${esc(me.email)} · ${esc(me.role)}${me.org ? ' · ' + esc(me.org.name) : ''}</div>
      </div>
    </div>
    <div class="input-row">
      <div class="field"><label>First name</label><input id="profFirst" class="input" value="${esc(me.firstName)}" oninput="profPreview()" /></div>
      <div class="field"><label>Last name</label><input id="profLast" class="input" value="${esc(me.lastName)}" oninput="profPreview()" /></div>
    </div>
    <div class="field">
      <label>Icon color</label>
      <div style="display:flex;align-items:center;gap:12px;">
        <input id="profColor" type="color" value="${esc(color)}" oninput="profPreview()" style="width:56px;height:40px;border:1.5px solid var(--line);border-radius:10px;padding:2px;background:#fff;cursor:pointer;" />
        <span class="mono small muted" id="profColorText">${esc(color)}</span>
        <button class="btn btn-ghost btn-sm" onclick="$('profColor').value='#4dbedc';profPreview()">Reset</button>
      </div>
      <div class="hint">This color shows on your icon, your name in transcripts, and your bar in the analysis.</div>
    </div>
    <div class="field"><label>School <span class="label-note">optional</span></label><div id="profSchoolPicker" class="school-picker"></div></div>
    <div id="profErr" class="form-error hidden"></div>`,
    footer: `<button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="saveProfile()">Save</button>` });
  mountSchoolPicker('profSchoolPicker', me.org);
}
function profPreview() {
  const c = $('profColor').value; $('profPreview').style.background = c; $('profColorText').textContent = c;
  const n = `${$('profFirst').value.trim()} ${$('profLast').value.trim()}`.trim(); $('profPreview').textContent = initials(n || me.name); $('profPreviewName').textContent = n || me.name;
}
async function saveProfile() {
  try {
    const sc = schoolChoice('profSchoolPicker');
    const school = sc.schoolId ? { id: sc.schoolId } : sc.schoolName ? { name: sc.schoolName } : null;
    const r = await api('/api/me', { method: 'PATCH', body: { firstName: $('profFirst').value, lastName: $('profLast').value, avatarColor: $('profColor').value, school } });
    me = r.user; closeModal(); toast('Profile saved');
    $('topSchool').textContent = me.org?.name || '';
    $('userBtn').innerHTML = `${avatarHtml(me, 'avatar-sm')}<span><div class="n">${esc(me.name)}</div><div class="r">${esc(me.role)}</div></span>`;
    if (project) selectProject(project.id);
  } catch (e) { $('profErr').textContent = e.message; $('profErr').classList.remove('hidden'); }
}

/* ====================== tutorial ====================== */
const TUTORIAL = {
  teacher: [
    { icon: 'users', title: 'Welcome to Visor', text: 'Visor shows you who actually did the work on a group project. It listens to the group\'s recordings and reads their document history, then writes you a fair report. Here\'s the whole flow in four steps.' },
    { icon: 'doc', title: '1. Create a project', text: 'Click <b>+ New</b> in the left sidebar and give the project a name your students will recognize. Every project gets a short code (the <b>#</b> chip in the header). Students use that code in the Visor extension to send document data.' },
    { icon: 'users', title: '2. Add your students', text: 'On the <b>Members</b> tab, search by name or email. Students at your school show up when you search their name; anyone else, type their full email address. They need a Visor account first.' },
    { icon: 'mic', title: '3. Resources come in', text: 'Students (or you) add two kinds of resources: <b>document data</b> from the Visor Chrome extension (or picked straight from Google Drive), and <b>recordings</b> of group meetings. Recordings are transcribed automatically and Visor asks who each voice is.' },
    { icon: 'sparkle', title: '4. Run the analysis', text: 'On the <b>Analysis</b> tab, click <b>Run analysis</b>. You get workload percentages, who did what, and a bottom line. Students can\'t see it unless you turn on <b>Show analysis to students</b> in the project settings (gear icon).' }
  ],
  student: [
    { icon: 'users', title: 'Welcome to Visor', text: 'Visor gives you credit for the work you actually do on group projects. Your teacher sees who wrote, who talked, and who coasted. Here\'s what you do.' },
    { icon: 'doc', title: '1. Wait for your teacher', text: 'Your teacher adds you to a project. It shows up in <b>My projects</b> on the left. You don\'t need to do anything for this step.' },
    { icon: 'puzzle', title: '2. Send document data', text: 'Install the Visor Chrome extension. Open your group\'s Google Doc or Slides, click the <b>Visor</b> button, and when it finishes click <b>Send to Website</b> with your project\'s code (ask your teacher). That\'s the main way Visor sees your work.' },
    { icon: 'mic', title: '3. Record your meetings', text: 'On the <b>Resources</b> tab, upload a recording or hit <b>Record now</b> during a group session. Visor transcribes it and then asks "Who is this?" for each voice. Pick the right person and the recording becomes a script.' },
    { icon: 'sparkle', title: '4. Your teacher runs the analysis', text: 'When the project is done, your teacher runs the analysis. If they share it, you\'ll see the <b>Analysis</b> tab with everyone\'s share of the work.' }
  ]
};
let tut = { i: 0 };
function openTutorial() { tut.i = 0; renderTutorial(); }
function renderTutorial() {
  const steps = TUTORIAL[me.role] || TUTORIAL.student;
  const st = steps[tut.i]; const last = tut.i === steps.length - 1;
  openModal({ title: st.title, closable: true, onClose: finishTutorial, body: `
    <div class="wiz-progress">${steps.map((_, j) => `<span class="${j < tut.i ? 'done' : ''} ${j === tut.i ? 'cur' : ''}"></span>`).join('')}</div>
    <div style="display:flex;gap:18px;align-items:flex-start;">
      <div class="choice" style="pointer-events:none;padding:14px;flex:none;"><div class="ic" style="margin:0;">${I[st.icon]}</div></div>
      <div style="font-size:15.5px;line-height:1.6;">${st.text}</div>
    </div>`,
    footer: `<div style="display:flex;gap:10px;width:100%;align-items:center;">
      <button class="btn btn-ghost" ${tut.i === 0 ? 'disabled' : ''} onclick="tut.i--;renderTutorial()">Back</button>
      <span style="flex:1"></span>
      ${last ? '' : `<button class="btn btn-ghost" onclick="closeModal()">Skip</button>`}
      <button class="btn btn-primary" onclick="${last ? 'closeModal()' : 'tut.i++;renderTutorial()'}">${last ? 'Got it' : 'Next'}</button>
    </div>` });
}
async function finishTutorial() {
  if (me && !me.tutorialSeen) { me.tutorialSeen = true; try { await api('/api/me', { method: 'PATCH', body: { tutorialSeen: true } }); } catch {} }
}

async function loadProjects(selectId) {
  const r = await api('/api/projects');
  projects = r.projects;
  renderProjectList();
  const id = selectId || project?.id || (projects[0] && projects[0].id);
  if (id) selectProject(id); else showEmptyMain();
}

function renderProjectList() {
  $('projectList').innerHTML = projects.map(p => `
    <button class="proj-item ${project?.id === p.id ? 'active' : ''}" onclick="selectProject('${p.id}')">
      <div class="n">${esc(p.name)}</div>
      <div class="m">${p.students?.length ?? 0} student${(p.students?.length ?? 0) !== 1 ? 's' : ''} · ${p.resourceCount ?? 0} resource${(p.resourceCount ?? 0) !== 1 ? 's' : ''}</div>
    </button>`).join('') || `<div class="muted small" style="padding:8px;">No projects yet.</div>`;
}

function showEmptyMain() { $('emptyMain').classList.remove('hidden'); $('projectView').classList.add('hidden'); }

async function selectProject(id) {
  clearInterval(pollTimer);
  try {
    const r = await api(`/api/projects/${id}`);
    project = r.project; analysis = null;
    renderProjectList();
    renderProject();
    if (project.hasAnalysis && (project.isTeacher || project.showAnalysis || project.isDemo)) {
      api(`/api/projects/${id}/analysis`).then(a => { if (project?.id === id && a.analysis) { analysis = a.analysis; renderAnalysis(); } }).catch(() => {});
    }
  } catch (e) { toast(e.message, 'err'); }
}

function renderProject() {
  $('emptyMain').classList.add('hidden'); $('projectView').classList.remove('hidden');
  const p = project;
  $('projName').textContent = p.name;
  $('projMeta').innerHTML = `<span>Teacher: ${esc(p.teacher?.name || '—')}</span><span>${p.students.length} student${p.students.length !== 1 ? 's' : ''}</span>`;

  const actions = [];
  if (p.isTeacher && !p.isDemo) {
    actions.push(`<button class="code-chip" onclick="copyCode()" title="Project code. Students enter this in the Visor extension to send document data here.">${I.hash}<span id="codeText">${esc(p.code)}</span></button>`);
    actions.push(`<button class="btn-icon" onclick="toggleMenu('projMenu')" title="Project settings">${I.gear}</button>
      <div id="projMenu" class="menu hidden">
        <button onclick="renameProject()">${I.edit}Rename project</button>
        <button onclick="toggleAnalysisVisibility()">${I.eye}${p.showAnalysis ? 'Hide analysis from students' : 'Show analysis to students'}</button>
        <div class="sep"></div>
        <button class="danger" onclick="deleteProject()">${I.trash}Delete project</button>
      </div>`);
  }
  $('projActions').innerHTML = actions.join('');

  // Analysis tab visibility for students
  const canSeeAnalysis = p.isTeacher || p.showAnalysis || p.isDemo;
  $('tabAnalysis').classList.toggle('hidden', !canSeeAnalysis);
  if (!canSeeAnalysis && document.querySelector('.tab.active')?.dataset.tab === 'analysis') switchTab('members');

  $('cntMembers').textContent = p.students.length;
  $('cntResources').textContent = p.resources.length;
  $('memberSearch').classList.toggle('hidden', !(p.isTeacher && !p.isDemo));
  $('addResourceBtn').classList.toggle('hidden', !!p.isDemo);

  renderMembers(); renderResources(); renderAnalysis();
  schedulePolling();
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('[data-panel]').forEach(s => s.classList.toggle('hidden', s.dataset.panel !== name));
}

async function copyCode() {
  try { await navigator.clipboard.writeText(project.code); toast('Project code copied'); } catch { toast(project.code); }
}

function openNewProject() {
  openModal({ title: 'New project', sub: 'Name it the way your students will recognize it.', body: `<div class="field"><label>Project name</label><input id="npName" class="input" placeholder="Project name" /></div>`, footer: `<button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="createProject()">Create project</button>` });
  setTimeout(() => $('npName')?.focus(), 50);
  $('npName').addEventListener('keydown', e => { if (e.key === 'Enter') createProject(); });
}
async function createProject() {
  const name = $('npName').value.trim();
  if (!name) return $('npName').classList.add('error');
  try { const r = await api('/api/projects', { method: 'POST', body: { name } }); closeModal(); await loadProjects(r.project.id); switchTab('members'); toast('Project created. Add your students.'); }
  catch (e) { toast(e.message, 'err'); }
}
function renameProject() {
  openModal({ title: 'Rename project', body: `<div class="field"><label>Project name</label><input id="rnName" class="input" value="${esc(project.name)}" /></div>`, footer: `<button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="saveRename()">Save</button>` });
  setTimeout(() => $('rnName')?.focus(), 50);
}
async function saveRename() {
  try { const r = await api(`/api/projects/${project.id}`, { method: 'PATCH', body: { name: $('rnName').value } }); project = r.project; closeModal(); renderProject(); loadProjectsQuiet(); }
  catch (e) { toast(e.message, 'err'); }
}
async function toggleAnalysisVisibility() {
  try { const r = await api(`/api/projects/${project.id}`, { method: 'PATCH', body: { showAnalysis: !project.showAnalysis } }); project = r.project; renderProject(); toast(project.showAnalysis ? 'Students can now see the analysis' : 'Analysis hidden from students'); }
  catch (e) { toast(e.message, 'err'); }
}
async function deleteProject() {
  if (!await confirmModal('Delete this project?', `"${project.name}" and all of its recordings and reports will be removed. This cannot be undone.`, { okLabel: 'Delete', danger: true })) return;
  try { await api(`/api/projects/${project.id}`, { method: 'DELETE' }); project = null; await loadProjects(); toast('Project deleted'); }
  catch (e) { toast(e.message, 'err'); }
}
async function loadProjectsQuiet() { try { const r = await api('/api/projects'); projects = r.projects; renderProjectList(); } catch {} }

/* ====================== members ====================== */
function renderMembers() {
  const p = project;
  const rows = [];
  if (p.teacher) rows.push(`<div class="row">${avatarHtml(p.teacher)}<div class="grow"><div class="t">${esc(p.teacher.name)} <span class="pill pill-blue">Teacher</span></div><div class="s">${esc(p.teacher.email || '')}</div></div></div>`);
  p.students.forEach((s, i) => rows.push(`<div class="row">${avatarHtml(s)}<div class="grow"><div class="t">${esc(s.name)}</div><div class="s">${esc(s.email || '')}</div></div>${p.isTeacher && !p.isDemo ? `<button class="btn-icon" title="Remove from project" onclick="removeStudent('${s.id}')">${I.x}</button>` : ''}</div>`));
  if (!p.students.length) rows.push(`<div class="empty"><div class="ic">${I.users}</div><h4>No students yet</h4><p>${p.isTeacher ? 'Search above by name, or type a student\'s full email address.' : 'Your teacher hasn\'t added anyone yet.'}</p></div>`);
  $('membersList').innerHTML = rows.join('');
}
const onMemberSearch = debounce(async q => {
  const dd = $('memberDropdown');
  try {
    const list = await api(`/api/school/students?q=${encodeURIComponent(q)}`);
    const have = new Set(project.students.map(s => s.id));
    const avail = list.filter(s => !have.has(s.id));
    dd.classList.remove('hidden');
    dd.innerHTML = avail.length ? avail.slice(0, 12).map(s => `<button onclick="addStudent('${s.id}')">${avatarHtml(s, 'avatar-sm')}<span><div style="font-weight:600;font-size:14px;">${esc(s.name)}</div><div class="tiny muted">${esc(s.email)}</div></span></button>`).join('')
      : `<div class="none">${list.length ? 'Everyone matching is already in this project.' : (q.trim().length < 2 ? (me.org ? 'Type a name to search students at your school, or a full email address.' : 'Type a student\'s full email address.') : (q.includes('@') ? 'No student account uses that email. They need to sign up for Visor first.' : (me.org ? 'No students at your school match. Try their full email address.' : 'Type the student\'s full email address.')))}</div>`;
  } catch (e) { dd.classList.add('hidden'); }
}, 200);
document.addEventListener('click', e => { if (!e.target.closest('#memberSearch')) $('memberDropdown')?.classList.add('hidden'); });
async function addStudent(id) {
  try { const r = await api(`/api/projects/${project.id}/students`, { method: 'POST', body: { userId: id } }); project = r.project; $('memberSearchInput').value = ''; $('memberDropdown').classList.add('hidden'); renderProject(); loadProjectsQuiet(); }
  catch (e) { toast(e.message, 'err'); }
}
async function removeStudent(id) {
  const s = project.students.find(x => x.id === id);
  if (!await confirmModal('Remove student?', `Remove ${s?.name || 'this student'} from "${project.name}"?`, { okLabel: 'Remove', danger: true })) return;
  try { const r = await api(`/api/projects/${project.id}/students/${id}`, { method: 'DELETE' }); project = r.project; renderProject(); loadProjectsQuiet(); }
  catch (e) { toast(e.message, 'err'); }
}

/* ====================== resources ====================== */
function statusPill(r) {
  if (r.type !== 'audio') return r.source === 'drive' ? `<span class="pill pill-blue">Google Drive</span>` : `<span class="pill pill-violet">Document data</span>`;
  if (r.status === 'transcribing') return `<span class="pill pill-blue"><i class="dot pulse"></i>Transcribing</span>`;
  if (r.status === 'identify') return `<span class="pill pill-amber">${r.unassigned} voice${r.unassigned !== 1 ? 's' : ''} to name</span>`;
  if (r.status === 'error') return `<span class="pill pill-red">Failed</span>`;
  return `<span class="pill pill-green">Transcript ready</span>`;
}

function renderResources() {
  const p = project;
  const root = $('resourceList');
  if (!p.resources.length) {
    root.innerHTML = `<div class="card"><div class="empty"><div class="ic">${I.mic}</div><h4>Nothing here yet</h4><p>Upload a recording of a group meeting, or send document data from the Visor extension. Visor does the rest.</p></div></div>`;
    return;
  }
  root.innerHTML = p.resources.map(r => {
    const isAudio = r.type === 'audio';
    let cta = '';
    if (isAudio && r.status === 'identify') cta = `<button class="btn btn-primary btn-sm" onclick="event.stopPropagation();openSpeakerWizard('${r.id}')">Name the voices</button>`;
    else if (isAudio && r.status === 'error' && !p.isDemo) cta = `<button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();retranscribe('${r.id}')">${I.refresh}Try again</button>`;
    else if (isAudio && r.status === 'transcribing') cta = `<span class="spinner spinner-sm"></span>`;
    const sub = isAudio
      ? `${r.duration ? `<span>${fmtDur(r.duration)}</span>` : ''}<span>Added by ${esc(r.uploadedByName || '?')}</span><span>${timeAgo(r.uploadedAt)}</span>`
      : `<span>${esc(r.report?.docType === 'slides' ? 'Google Slides' : 'Google Doc')}</span><span>${(r.report?.revisionCount || 0).toLocaleString()} ${esc(r.report?.revisionLabel || 'revisions')}</span><span>${r.report?.contributors?.length || 0} contributors</span>${r.report?.metrics ? `<span>${Math.round((r.report.metrics.externalShare || 0) * 100)}% external pastes</span>` : ''}<span>${timeAgo(r.uploadedAt)}</span>`;
    return `<div class="card card-hover res-card" onclick="openResource('${r.id}')">
      <div class="ic ${isAudio ? 'audio' : 'ext'}">${isAudio ? I.mic : I.doc}</div>
      <div class="grow" style="flex:1;min-width:0;">
        <div class="t">${esc(r.title)}</div>
        <div class="s">${statusPill(r)}${sub}</div>
      </div>
      <div class="cta">${cta}</div>
    </div>`;
  }).join('');
}

// Poll while any recording is transcribing
function schedulePolling() {
  clearInterval(pollTimer);
  if (!project || project.isDemo) return;
  const pending = () => project.resources.filter(r => r.type === 'audio' && r.status === 'transcribing');
  if (!pending().length) return;
  pollTimer = setInterval(async () => {
    if (!project) return clearInterval(pollTimer);
    let changed = false;
    for (const r of pending()) {
      try {
        const u = await api(`/api/projects/${project.id}/resources/${r.id}`);
        if (u.resource.status !== 'transcribing') {
          const i = project.resources.findIndex(x => x.id === r.id); project.resources[i] = u.resource; changed = true;
          if (u.resource.status === 'identify') { toast(`"${u.resource.title}" is transcribed. Time to name the voices.`); if (!$('modalRoot').innerHTML || waitingModalFor === u.resource.id) { waitingModalFor = null; openSpeakerWizard(u.resource.id); } }
          else if (u.resource.status === 'error') toast(`Transcription failed: ${u.resource.error}`, 'err');
          else toast(`"${u.resource.title}" is ready.`);
        }
      } catch {}
    }
    if (changed) renderResources();
    if (!pending().length) clearInterval(pollTimer);
  }, 3000);
}

/* ---- add resource ---- */
function openAddResource() {
  const drive = CFG.google ? `<button class="choice" onclick="showDriveImport()"><div class="ic">${I.drive}</div><div class="t">From Google Drive</div><div class="d">No extension? Pick the Doc or Slides file instead.</div></button>` : '';
  openModal({ title: 'Add a resource', sub: 'What do you want to add to this project?', wide: true, body: `
    <button class="choice choice-hero" onclick="showExtensionData()"><div class="ic">${I.puzzle}</div><div><div class="t">Document data from the Visor extension</div><div class="d">The revision history of your group's Google Doc or Slides: who wrote what, and when. This is the main thing Visor uses.</div></div></button>
    <div class="choice-grid ${drive ? '' : 'two'}" style="margin-top:12px;">
      ${drive}
      <button class="choice" onclick="showUploadAudio()"><div class="ic">${I.upload}</div><div class="t">Upload a recording</div><div class="d">An audio file of a group meeting.</div></button>
      <button class="choice" onclick="showRecordAudio()"><div class="ic">${I.mic}</div><div class="t">Record now</div><div class="d">Record a session right here.</div></button>
    </div>` });
}

// Send a recording to the server in 4 MB pieces (so big files fit through the
// hosting limits), then register it so transcription starts.
// Which recording types Visor takes. The list comes from the server
// (lib/audioFormats.js); this copy is only used until /api/config arrives.
const AUDIO_FORMATS_FALLBACK = {
  byExt: { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', webm: 'audio/webm', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', aiff: 'audio/aiff', aif: 'audio/aiff', mp4: 'audio/mp4', mov: 'audio/mp4' },
  byType: { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/webm': 'webm', 'video/webm': 'webm', 'audio/ogg': 'ogg', 'audio/flac': 'flac', 'audio/aiff': 'aiff', 'video/mp4': 'mp4', 'video/quicktime': 'mov' },
  label: 'MP3, M4A, WAV, WebM, OGG, FLAC, AAC or AIFF audio, or MP4/MOV video'
};
const audioFormats = () => CFG.audioFormats || AUDIO_FORMATS_FALLBACK;
const hasKey = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
// → { ext, type } if Visor takes this file, or null. Same rule as the server.
function recordingFormat(filename, type) {
  const F = audioFormats();
  const name = String(filename || ''); const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (ext && hasKey(F.byExt, ext)) return { ext, type: F.byExt[ext] };
  const t = String(type || '').split(';')[0].trim().toLowerCase();
  if (t && hasKey(F.byType, t)) return { ext: F.byType[t], type: F.byExt[F.byType[t]] };
  return null;
}
function unsupportedRecordingMessage(filename, type) {
  const name = String(filename || ''); const dot = name.lastIndexOf('.');
  const what = dot > 0 ? `.${name.slice(dot + 1).toLowerCase()} files aren't` : (type ? `"${String(type).split(';')[0]}" files aren't` : "That kind of file isn't");
  return `${what} supported for recordings. Use ${audioFormats().label}.`;
}
const recordingAccept = () => ['audio/*', 'video/mp4', 'video/quicktime', ...Object.keys(audioFormats().byExt).map(e => '.' + e)].join(',');

async function sendRecording(fileOrBlob, { filename, title, duration, onProgress }) {
  const format = recordingFormat(filename, fileOrBlob.type);
  if (!format) throw new Error(unsupportedRecordingMessage(filename, fileOrBlob.type));
  const type = (fileOrBlob.type || format.type).split(';')[0];
  if (!fileOrBlob.size) throw new Error('That recording is empty.');
  if (fileOrBlob.size > CFG.maxAudioMB * 1024 * 1024) throw new Error(`That file is over ${CFG.maxAudioMB} MB. Try a shorter or more compressed recording.`);
  const base = `/api/projects/${project.id}/resources/audio`;
  const start = await api(`${base}/uploads`, { method: 'POST', body: { filename, mime: type, size: fileOrBlob.size } });
  const step = start.chunkBytes;
  for (let offset = 0; offset < fileOrBlob.size; offset += step) {
    const piece = fileOrBlob.slice(offset, Math.min(offset + step, fileOrBlob.size));
    let tries = 0;
    for (;;) {
      try {
        const r = await fetch(`${base}/uploads/chunk?offset=${offset}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-Upload-Token': start.uploadToken }, body: piece, credentials: 'same-origin' });
        if (r.ok) break;
        const data = await r.json().catch(() => ({}));
        const err = new Error(data.error || `Upload failed (${r.status})`); err.status = r.status;
        throw err;
      } catch (e) {
        if (++tries >= 3 || (e.status && e.status < 500)) throw e;
        await new Promise(res => setTimeout(res, 1000 * tries));
      }
    }
    onProgress && onProgress(Math.round(Math.min(offset + step, fileOrBlob.size) / fileOrBlob.size * 100));
  }
  return api(base, { method: 'POST', body: { uploadToken: start.uploadToken, filename, mime: type, title, duration } });
}

function showUploadAudio() {
  openModal({ title: 'Upload a recording', sub: `${audioFormats().label}. Visor transcribes it and asks you who each voice is.`, body: `
    <div id="dropzone" class="dropzone" onclick="$('fileInput').click()" ondragover="event.preventDefault();this.classList.add('over')" ondragleave="this.classList.remove('over')" ondrop="onDrop(event)">
      ${I.upload}
      <div style="font-weight:600;margin-top:8px;">Drop an audio file here, or click to choose</div>
      <div class="muted small" style="margin-top:4px;">Up to ${CFG.maxAudioMB} MB</div>
      <input id="fileInput" type="file" accept="${recordingAccept()}" class="hidden" onchange="onFilePicked(this.files[0])" />
    </div>
    <div class="field" style="margin-top:16px;"><label>Title</label><input id="upTitle" class="input" placeholder="e.g. Planning meeting, Tuesday" /></div>
    <div id="upStatus"></div>`,
    footer: `<button class="btn btn-ghost" onclick="openAddResource()">Back</button><button class="btn btn-primary" id="upBtn" disabled onclick="submitUpload()">Upload &amp; transcribe</button>` });
}
let pickedFile = null;
function onDrop(e) { e.preventDefault(); $('dropzone').classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) onFilePicked(f); }
function onFilePicked(f) {
  if (!f) return;
  const input = `<input id="fileInput" type="file" accept="${recordingAccept()}" class="hidden" onchange="onFilePicked(this.files[0])" />`;
  const problem = !recordingFormat(f.name, f.type) ? unsupportedRecordingMessage(f.name, f.type)
    : f.size > CFG.maxAudioMB * 1024 * 1024 ? `That file is ${(f.size / 1024 / 1024).toFixed(0)} MB. The limit is ${CFG.maxAudioMB} MB; try a shorter or more compressed recording.`
    : !f.size ? 'That file is empty.' : '';
  if (problem) {
    pickedFile = null;
    $('dropzone').classList.add('bad');
    $('dropzone').innerHTML = `${I.upload}<div style="font-weight:600;margin-top:8px;">${esc(f.name)}</div><div class="dz-error" role="alert">${esc(problem)}</div><div class="muted small" style="margin-top:6px;">Click to choose a different file</div>${input}`;
    $('upBtn').disabled = true;
    return;
  }
  pickedFile = f;
  $('dropzone').classList.remove('bad');
  $('dropzone').innerHTML = `${I.check}<div style="font-weight:600;margin-top:8px;">${esc(f.name)}</div><div class="muted small">${(f.size / 1024 / 1024).toFixed(1)} MB · click to change</div>${input}`;
  if (!$('upTitle').value) $('upTitle').value = f.name.replace(/\.[a-z0-9]+$/i, '');
  $('upBtn').disabled = false;
}
async function audioDuration(file) { return new Promise(res => { try { const a = new Audio(); a.preload = 'metadata'; a.onloadedmetadata = () => { res(isFinite(a.duration) ? a.duration : null); URL.revokeObjectURL(a.src); }; a.onerror = () => res(null); a.src = URL.createObjectURL(file); } catch { res(null); } }); }
async function submitUpload() {
  if (!pickedFile) return;
  const btn = $('upBtn');
  btn.disabled = true; btn.innerHTML = `<span class="spinner spinner-sm"></span> Uploading…`;
  try {
    const duration = await audioDuration(pickedFile);
    const r = await sendRecording(pickedFile, { filename: pickedFile.name, title: $('upTitle').value.trim(), duration, onProgress: p => { btn.innerHTML = `<span class="spinner spinner-sm"></span> Uploading… ${p}%`; } });
    afterAudioAdded(r.resource);
  } catch (e) { toast(e.message, 'err'); $('upBtn').disabled = false; $('upBtn').textContent = 'Upload & transcribe'; }
}
function afterAudioAdded(resource) {
  pickedFile = null;
  project.resources.unshift(resource);
  $('cntResources').textContent = project.resources.length;
  renderResources(); switchTab('resources'); schedulePolling(); loadProjectsQuiet();
  waitingModalFor = resource.id;
  openModal({ title: 'Transcribing…', sub: 'Gemini is listening to the recording and separating the voices. This usually takes under a minute.', closable: true, onClose: () => { waitingModalFor = null; }, body: `
    <div class="steps">
      <div class="step done"><span class="d">${I.check}</span>Uploaded "${esc(resource.title)}"</div>
      <div class="step active"><span class="d"></span>Transcribing and separating voices</div>
      <div class="step"><span class="d"></span>You name each voice</div>
      <div class="step"><span class="d"></span>Script-style transcript ready</div>
    </div>
    <p class="muted small" style="margin:16px 0 0;">You can close this. We'll let you know when it's time to name the voices.</p>`,
    footer: `<button class="btn btn-ghost" onclick="closeModal()">Close</button>` });
}

/* ---- record ---- */
let rec = { stream: null, recorder: null, chunks: [], start: 0, timer: null, blob: null, ctx: null, raf: null };
function showRecordAudio() {
  openModal({ title: 'Record a session', sub: 'Put the laptop in the middle of the table. Click to start, click again to stop.', body: `
    <div class="rec">
      <button id="recBtn" class="rec-btn" onclick="toggleRecord()">${I.mic}</button>
      <div class="rec-time" id="recTime">0:00</div>
      <canvas id="wave" class="wave" width="460" height="64"></canvas>
      <div class="muted small" id="recHint">Click the microphone to start recording</div>
    </div>
    <div class="field"><label>Title</label><input id="recTitle" class="input" placeholder="e.g. Brainstorm, Monday" /></div>`,
    footer: `<button class="btn btn-ghost" onclick="stopRecordCleanup();openAddResource()">Back</button><button class="btn btn-primary" id="recSave" disabled onclick="saveRecording()">Save &amp; transcribe</button>`, onClose: stopRecordCleanup });
}
async function toggleRecord() {
  if (rec.recorder && rec.recorder.state === 'recording') { rec.recorder.stop(); return; }
  if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    toast("This browser can't record audio. Use Chrome, Safari, Edge or Firefox, or upload a recording instead.", 'err'); return;
  }
  try {
    rec.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch { toast('Microphone access was blocked. Allow it in the browser and try again.', 'err'); return; }
  rec.chunks = []; rec.blob = null;
  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : (MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '');
  rec.recorder = new MediaRecorder(rec.stream, mime ? { mimeType: mime } : undefined);
  rec.recorder.ondataavailable = e => { if (e.data.size) rec.chunks.push(e.data); };
  rec.recorder.onstop = () => {
    rec.blob = new Blob(rec.chunks, { type: rec.recorder.mimeType || 'audio/webm' });
    rec.duration = (Date.now() - rec.start) / 1000;
    rec.stream.getTracks().forEach(t => t.stop()); cancelAnimationFrame(rec.raf); clearInterval(rec.timer);
    $('recBtn').classList.remove('on'); $('recBtn').innerHTML = I.mic;
    $('recHint').textContent = `Recorded ${fmtDur((Date.now() - rec.start) / 1000)}. Click the mic to record again, or save.`;
    $('recSave').disabled = false;
  };
  rec.recorder.start(250); rec.start = Date.now();
  $('recBtn').classList.add('on'); $('recBtn').innerHTML = I.stop; $('recHint').textContent = 'Recording… click to stop'; $('recSave').disabled = true;
  rec.timer = setInterval(() => { $('recTime').textContent = fmtDur((Date.now() - rec.start) / 1000); }, 500);
  drawWave();
}
function drawWave() {
  const canvas = $('wave'); if (!canvas) return;
  rec.ctx = rec.ctx || new (window.AudioContext || window.webkitAudioContext)();
  const src = rec.ctx.createMediaStreamSource(rec.stream); const an = rec.ctx.createAnalyser(); an.fftSize = 128; src.connect(an);
  const data = new Uint8Array(an.frequencyBinCount); const g = canvas.getContext('2d');
  const grad = g.createLinearGradient(0, 0, canvas.width, 0); grad.addColorStop(0, '#4DBEDC'); grad.addColorStop(1, '#7BC288');
  const loop = () => {
    if (!rec.recorder || rec.recorder.state !== 'recording') return;
    an.getByteFrequencyData(data); g.clearRect(0, 0, canvas.width, canvas.height); g.fillStyle = grad;
    const bw = canvas.width / data.length;
    data.forEach((v, i) => { const h = Math.max(3, (v / 255) * canvas.height); g.fillRect(i * bw + 1, (canvas.height - h) / 2, bw - 2, h); });
    rec.raf = requestAnimationFrame(loop);
  };
  loop();
}
function stopRecordCleanup() { try { if (rec.recorder?.state === 'recording') rec.recorder.stop(); rec.stream?.getTracks().forEach(t => t.stop()); } catch {} cancelAnimationFrame(rec.raf); clearInterval(rec.timer); }
async function saveRecording() {
  if (!rec.blob) return;
  const btn = $('recSave');
  btn.disabled = true; btn.innerHTML = `<span class="spinner spinner-sm"></span> Saving…`;
  try {
    // Name the file after what the browser actually recorded (Chrome: WebM, Safari: MP4).
    const fmt = rec.blob.type ? recordingFormat('', rec.blob.type) : { ext: 'webm' };
    if (!fmt) throw new Error(`This browser recorded in a format Visor doesn't support (${rec.blob.type.split(';')[0]}). Try Chrome or Safari, or upload a recording instead.`);
    const r = await sendRecording(rec.blob, { filename: `recording.${fmt.ext}`, title: $('recTitle').value.trim() || 'Recording', duration: rec.duration || (Date.now() - rec.start) / 1000, onProgress: p => { btn.innerHTML = `<span class="spinner spinner-sm"></span> Saving… ${p}%`; } });
    modalOnClose = null; afterAudioAdded(r.resource);
  } catch (e) { toast(e.message, 'err'); $('recSave').disabled = false; $('recSave').textContent = 'Save & transcribe'; }
}
async function retranscribe(id) {
  try { const r = await api(`/api/projects/${project.id}/resources/${id}/retranscribe`, { method: 'POST' }); const i = project.resources.findIndex(x => x.id === id); project.resources[i] = r.resource; renderResources(); schedulePolling(); }
  catch (e) { toast(e.message, 'err'); }
}

/* ---- extension data ---- */
function showExtensionData() {
  const code = project.isTeacher ? project.code : null;
  openModal({ title: 'Document data from the extension', sub: 'The Visor Chrome extension reads a Google Doc or Slides file\'s full revision history.', body: `
    <div class="card card-pad" style="background:var(--surface);margin-bottom:16px;">
      <div style="font-weight:700;margin-bottom:6px;">The easy way</div>
      <ol style="margin:0;padding-left:20px;font-size:14px;line-height:1.7;">
        <li>Open the Doc or Slides file in Chrome and click the <b>Visor</b> button.</li>
        <li>When the analysis finishes, click <b>Send to Website</b>.</li>
        <li>Enter this project's code${code ? `: <span class="code-chip" style="padding:3px 10px;">${esc(code)}</span>` : ' (ask your teacher for it)'}.</li>
      </ol>
      <div class="muted small" style="margin-top:8px;">The <b>Send to Website</b> box is on the extension's Overview tab, under Live replay. It shows up here automatically, and re-sending the same file just updates it.</div>
    </div>
    <div class="field"><label>Or paste the report JSON</label><textarea id="extJson" class="input mono" style="font-size:12px;min-height:110px;" placeholder='{ "schema": "visor-export-v1", "meta": { … }, "analysis": { … } }'></textarea></div>
    <div id="extErr" class="form-error hidden"></div>`,
    footer: `<button class="btn btn-ghost" onclick="openAddResource()">Back</button><button class="btn btn-primary" onclick="submitExtension()">Add report</button>` });
}
async function submitExtension() {
  const raw = $('extJson').value.trim();
  const err = $('extErr'); err.classList.add('hidden');
  if (!raw) { err.textContent = 'Paste the JSON first, or send it from the extension.'; err.classList.remove('hidden'); return; }
  let report; try { report = JSON.parse(raw); } catch { err.textContent = 'That is not valid JSON.'; err.classList.remove('hidden'); return; }
  try {
    await api(`/api/projects/${project.id}/resources/extension`, { method: 'POST', body: { report } });
    closeModal(); await selectProject(project.id); switchTab('resources'); toast('Document data added');
  } catch (e) { err.textContent = e.message; err.classList.remove('hidden'); }
}

/* ---- Google Drive ---- */
// Google's own sign-in popup gives a short-lived drive.file token, and the user
// picks one file in Google's own picker. That pick is the only file Visor can
// open. The token goes to the server for this one import and isn't stored.
let driveToken = null; // { value, exp }
function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    const had = document.querySelector(`script[src="${src}"]`);
    if (had) { if (had.dataset.loaded) return resolve(); had.addEventListener('load', resolve); had.addEventListener('error', reject); return; }
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = () => { s.dataset.loaded = '1'; resolve(); };
    s.onerror = () => reject(new Error('Could not load Google’s file picker. Check your connection or ad blocker.'));
    document.head.appendChild(s);
  });
}
function loadGoogleScripts() {
  return Promise.all([
    loadScriptOnce('https://accounts.google.com/gsi/client'),
    loadScriptOnce('https://apis.google.com/js/api.js').then(() => new Promise(res => window.gapi.load('picker', res)))
  ]);
}

function showDriveImport(errMsg) {
  if (!CFG.google) return toast('Google Drive isn’t set up on this server yet.', 'err');
  openModal({ title: 'Import from Google Drive', sub: 'Pick a Google Doc or Slides file. Visor reads its saved revision history.', body: `
    <div class="card card-pad" style="background:var(--surface);margin-bottom:16px;">
      <div style="font-weight:700;margin-bottom:6px;">How this compares to the extension</div>
      <div class="small">Google Drive keeps occasional snapshots of a file, not every keystroke. Visor compares those snapshots and credits each change to whoever saved the later one, so this is coarser, and it can’t tell pasting from typing. For exact, keystroke-level history, send the file from the Visor extension instead.</div>
    </div>
    <ol class="small" style="margin:0 0 4px;padding-left:20px;line-height:1.7;">
      <li>Sign in with the Google account that can <b>edit</b> the file.</li>
      <li>Allow access to <b>only the file you pick</b>. Visor never sees the rest of your Drive.</li>
      <li>Choose the file.</li>
    </ol>
    <div id="driveErr" class="form-error ${errMsg ? '' : 'hidden'}">${esc(errMsg || '')}</div>`,
    footer: `<button class="btn btn-ghost" onclick="openAddResource()">Back</button><button class="btn btn-primary" id="driveBtn" onclick="pickFromDrive()">${I.drive}Choose a file</button>` });
  // Load Google's scripts now so the sign-in popup opens right on the click (browsers block delayed popups).
  loadGoogleScripts().catch(e => { const el = $('driveErr'); if (el) { el.textContent = e.message; el.classList.remove('hidden'); } });
}

function getDriveToken() {
  if (driveToken && driveToken.exp > Date.now() + 60000) return Promise.resolve(driveToken.value);
  return new Promise((resolve, reject) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: CFG.google.clientId,
      scope: 'https://www.googleapis.com/auth/drive.file',
      callback: resp => {
        if (resp.error) return reject(new Error(resp.error_description || resp.error));
        driveToken = { value: resp.access_token, exp: Date.now() + (Number(resp.expires_in) || 3600) * 1000 };
        resolve(resp.access_token);
      },
      error_callback: err => reject(new Error(err && err.type === 'popup_closed' ? 'The Google sign-in window was closed.' : err && err.type === 'popup_failed_to_open' ? 'Your browser blocked the Google sign-in window. Allow pop-ups for this site and try again.' : 'Google sign-in didn’t finish.'))
    });
    client.requestAccessToken();
  });
}

async function pickFromDrive() {
  const btn = $('driveBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spinner spinner-sm"></span> Opening Google…`; }
  try {
    if (!window.google?.accounts?.oauth2 || !window.google?.picker) await loadGoogleScripts();
    const token = await getDriveToken();
    closeModal();
    const view = new google.picker.DocsView(google.picker.ViewId.DOCS)
      .setIncludeFolders(false)
      .setMimeTypes('application/vnd.google-apps.document,application/vnd.google-apps.presentation');
    new google.picker.PickerBuilder()
      .addView(view)
      .setOAuthToken(token)
      .setDeveloperKey(CFG.google.apiKey)
      .setAppId(CFG.google.appId) // required: without it drive.file never grants the picked file
      .setTitle('Choose the group’s Doc or Slides file')
      .setCallback(data => {
        if (data.action === google.picker.Action.PICKED) importDriveFile(data.docs[0], token);
        else if (data.action === google.picker.Action.CANCEL) showDriveImport();
      })
      .build()
      .setVisible(true);
  } catch (e) {
    showDriveImport(e.message);
  }
}

async function importDriveFile(doc, token) {
  openModal({ title: 'Reading revision history…', sub: esc(doc.name || 'Google Drive file'), closable: false, body: `
    <div style="text-align:center;padding:18px 0;"><span class="spinner"></span>
    <div class="muted small" style="margin-top:12px;">Comparing the saved versions of the file. Long histories can take up to a minute.</div></div>` });
  try {
    await api(`/api/projects/${project.id}/resources/drive`, { method: 'POST', body: { fileId: doc.id, accessToken: token } });
    closeModal(); await selectProject(project.id); switchTab('resources'); toast('Document data added from Google Drive');
  } catch (e) {
    if (e.status === 401) driveToken = null;
    showDriveImport(e.message);
  }
}

/* ---- resource detail ---- */
async function openResource(id) {
  const r = project.resources.find(x => x.id === id); if (!r) return;
  if (r.type === 'audio') {
    if (r.status === 'identify') return openSpeakerWizard(id);
    if (r.status === 'transcribing') return openModal({ title: esc(r.title), sub: 'Still transcribing. Hang tight.', body: `<div style="text-align:center;padding:20px;"><span class="spinner"></span></div>`, footer: `<button class="btn btn-ghost" onclick="closeModal()">Close</button>` });
    if (r.status === 'error') return openModal({ title: esc(r.title), sub: 'Transcription failed.', body: `<div class="form-error">${esc(r.error || 'Unknown error')}</div><p class="muted small" style="margin:0;">Usually this means the Gemini key is missing, the file format isn't supported, or the recording is too long. Try again or upload as MP3.</p>`, footer: `<button class="btn btn-ghost" onclick="closeModal()">Close</button>${project.isDemo ? '' : `<button class="btn btn-primary" onclick="closeModal();retranscribe('${r.id}')">Try again</button>`}` });
    return openTranscript(r);
  }
  openExtensionDetail(r);
}

// name → css color for each voice in a recording (their icon color if they're on the project)
function speakerPalette(r) {
  const names = []; (r.script || []).forEach(l => { if (!names.includes(l.speaker)) names.push(l.speaker); });
  const map = {};
  names.forEach((n, i) => {
    const sp = (r.speakers || []).find(s => s.assignedName === n);
    const person = (sp?.assignedUserId && projectPerson(sp.assignedUserId)) || projectPerson(n);
    map[n] = personColor(person, i);
  });
  return { names, map };
}

function openTranscript(r) {
  const { names, map } = speakerPalette(r);
  const legend = names.map(n => `<span style="--c:${map[n]}"><i></i>${esc(n)}</span>`).join('');
  const lines = (r.script || []).map(l => `<div class="line ${/^Speaker \d+$/.test(l.speaker) ? 'unnamed' : ''}" style="--c:${map[l.speaker]}"><div class="who">${esc(l.speaker)}${l.t ? `<span class="t">${esc(l.t)}</span>` : ''}</div><div class="what">${esc(l.text)}</div></div>`).join('');
  openModal({ title: esc(r.title), sub: `${r.duration ? fmtDur(r.duration) + ' · ' : ''}Added by ${esc(r.uploadedByName || '?')} ${timeAgo(r.uploadedAt)}`, wide: true, body: `
    ${r.url ? `<audio controls src="${r.url}"></audio>` : ''}
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:10px;">
      <div class="kicker">Transcript</div>
      <div class="tiny muted mono">${(r.script || []).length} lines</div>
    </div>
    <div class="legend">${legend}</div>
    <div class="script">${lines || '<div class="muted">No transcript text.</div>'}</div>`,
    footer: `${project.isDemo ? '' : `<button class="btn btn-ghost" onclick="openSpeakerWizard('${r.id}', true)">${I.users}Fix names</button><button class="btn btn-ghost" onclick="copyTranscript('${r.id}')">${I.copy}Copy</button><span style="flex:1"></span><button class="btn btn-danger btn-sm" onclick="deleteResource('${r.id}')">${I.trash}Delete</button>`}<button class="btn btn-dark" onclick="closeModal()">Done</button>` });
}
async function copyTranscript(id) {
  const r = project.resources.find(x => x.id === id);
  const text = (r.script || []).map(l => `${l.speaker}: ${l.text}`).join('\n');
  try { await navigator.clipboard.writeText(text); toast('Transcript copied'); } catch {}
}
async function deleteResource(id) {
  const r = project.resources.find(x => x.id === id);
  if (!await confirmModal('Delete this resource?', `"${r?.title}" will be removed from the project.`, { okLabel: 'Delete', danger: true })) return;
  try { await api(`/api/projects/${project.id}/resources/${id}`, { method: 'DELETE' }); closeModal(); await selectProject(project.id); switchTab('resources'); }
  catch (e) { toast(e.message, 'err'); }
}

const fmtN = n => Math.round(Number(n) || 0).toLocaleString();
const fmtMins = m => { m = Math.round(Number(m) || 0); if (m < 60) return `${m}m`; const h = Math.floor(m / 60), r = m % 60; return r ? `${h}h ${r}m` : `${h}h`; };

// Document length over time, as a small line chart (hover a point for its value)
function growthChart(points) {
  const pts = (points || []).filter(p => Number.isFinite(p.length));
  if (pts.length < 2) return '';
  const W = 600, H = 90, max = Math.max(1, ...pts.map(p => p.length));
  const xy = pts.map((p, i) => [(i / (pts.length - 1)) * W, H - 4 - (p.length / max) * (H - 8)]);
  const line = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const step = W / Math.max(1, pts.length - 1);
  const hits = pts.map((p, i) => `<rect x="${Math.max(0, xy[i][0] - step / 2).toFixed(1)}" y="0" width="${step.toFixed(1)}" height="${H}" fill="transparent"><title>${fmtN(p.length)} characters${p.time ? ' · ' + esc(dvWhen(p.time)) : ''}</title></rect>`).join('');
  return `<div class="kicker" style="margin:4px 0 8px;">Document growth</div>
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:90px;display:block;margin-bottom:18px;" role="img" aria-label="Document length over time, up to ${fmtN(max)} characters">
      <defs><linearGradient id="gGrow" x1="0" x2="1"><stop offset="0" stop-color="#4DBEDC"/><stop offset="1" stop-color="#7BC288"/></linearGradient></defs>
      <polygon points="0,${H} ${line} ${W},${H}" fill="url(#gGrow)" opacity="0.18"/>
      <polyline points="${line}" fill="none" stroke="url(#gGrow)" stroke-width="2.5" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
      ${hits}
    </svg>`;
}

/* ====================== document view ======================
   The same tabs as the extension's side panel: Overview, People, Timeline,
   Evidence and Signal. Built from counted figures only; the document's text
   stays in the extension. Reports sent before extension 3.1 (and Drive
   imports) have fewer figures, so some tabs are hidden or say what's missing. */

let dv = null; // { r, rep, tab, sort: { pastes, deletions } }

const DV_TABS = [['overview', 'Overview'], ['people', 'People'], ['timeline', 'Timeline'], ['evidence', 'Evidence'], ['signal', 'Signal']];
const dvTime = v => { const t = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(t) ? t : null; };
function dvWhen(v) {
  const t = dvTime(v); if (t == null) return '';
  return new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function dvDay(v) { const t = dvTime(v); return t == null ? '' : new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }
function dvRange(a, b) {
  const x = dvDay(a), y = dvDay(b);
  if (!x && !y) return ''; if (!y || x === y) return x; if (!x) return y;
  return `${x} → ${y}`;
}
const dvLocalDate = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const dvHourLabel = h => (h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`);
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Who's who in this report: key → { name, email, color }
function dvPeople(rep) {
  const map = new Map();
  (rep.contributors || []).forEach((c, i) => {
    const p = { name: c.name, email: c.email, color: personColor(projectPerson(c.name), i), c };
    if (c.key != null) map.set(String(c.key), p);
    map.set('name:' + c.name, p);
  });
  return k => map.get(String(k)) || map.get('name:' + k) || { name: 'Unknown', color: '#8AA0AB' };
}

// Activity as { date, hour, count } cells. The extension sends these directly;
// otherwise they're worked out from writing sessions or Drive saves.
function dvActivity(rep) {
  const d = rep.detail || {};
  if (d.heatmap?.length) return { cells: d.heatmap, unit: 'edits', tz: 'writer' };
  const cells = new Map();
  const add = (t, n) => { if (t == null || !n) return; const dt = new Date(t); const k = `${dvLocalDate(t)}|${dt.getHours()}`; cells.set(k, (cells.get(k) || 0) + n); };
  if (d.sessions?.length) { d.sessions.forEach(s => add(s.start, s.mutations || 1)); return { cells: [...cells].map(([k, count]) => ({ date: k.split('|')[0], hour: +k.split('|')[1], count })), unit: 'edits', tz: 'viewer' }; }
  if (d.saves?.length) { d.saves.forEach(s => add(s.time, 1)); return { cells: [...cells].map(([k, count]) => ({ date: k.split('|')[0], hour: +k.split('|')[1], count })), unit: 'saves', tz: 'viewer' }; }
  return { cells: [], unit: 'edits' };
}

function openExtensionDetail(r) {
  const rep = r.report || {};
  dv = { r, rep, tab: 'overview', sort: { pastes: 'recent', deletions: 'recent' } };
  const isExt = rep.source === 'visor-extension', isDrive = rep.source === 'drive';
  const unit = rep.revisionLabel || 'revisions';
  const from = isDrive ? 'from Google Drive' : isExt ? 'from the extension' : 'pasted report';
  openModal({
    title: esc(rep.title || r.title),
    sub: `${rep.docType === 'slides' ? 'Google Slides' : 'Google Doc'} · ${fmtN(rep.revisionCount)} ${esc(unit)} · ~${fmtN(rep.wordCount)} words · ${from} ${timeAgo(rep.analyzedAt || r.uploadedAt)}${rep.url ? ` · <a href="${esc(rep.url)}" target="_blank" rel="noopener">open ↗</a>` : ''}`,
    wide: true,
    body: `<div class="tabs dv-tabs" id="dvTabs"></div><div id="dvBody"></div>`,
    footer: `${project.isDemo ? '' : `<button class="btn btn-danger btn-sm" onclick="deleteResource('${r.id}')">${I.trash}Delete</button><span style="flex:1"></span>`}<button class="btn btn-dark" onclick="closeModal()">Done</button>`
  });
  dvRender();
}

function dvTabsFor(rep) {
  const isExt = rep.source === 'visor-extension', isDrive = rep.source === 'drive';
  return DV_TABS.filter(([k]) => k === 'overview' || k === 'people' || (k === 'timeline' && (isExt || isDrive)) || ((k === 'evidence' || k === 'signal') && isExt));
}
function dvGo(tab) { dv.tab = tab; dvRender(); $('modalBody')?.scrollTo?.(0, 0); }
function dvRender() {
  if (!dv || !$('dvBody')) return;
  $('dvTabs').innerHTML = dvTabsFor(dv.rep).map(([k, label]) => `<button class="tab ${dv.tab === k ? 'active' : ''}" onclick="dvGo('${k}')">${label}</button>`).join('');
  const fn = { overview: dvOverview, people: dvPeopleTab, timeline: dvTimeline, evidence: dvEvidence, signal: dvSignal }[dv.tab];
  $('dvBody').innerHTML = fn(dv.rep);
}

// Shown where a report was sent by an older extension and lacks this part
const dvResend = what => `<div class="callout amber dv-note">${what} arrives with reports sent from Visor extension 3.1 or newer. Open the document in Chrome and click <b>Send to Website</b> again to fill this in.</div>`;

/* ---------- Overview ---------- */
function dvOverview(rep) {
  const isExt = rep.source === 'visor-extension', isDrive = rep.source === 'drive';
  const m = rep.metrics;
  const notes = [
    isDrive && rep.drive ? `Built from ${fmtN(rep.drive.analyzedRevisions)} of ${fmtN(rep.drive.totalRevisions)} saved versions in Google Drive. Changes between two versions are credited to whoever saved the later one, and pasting can't be told apart from typing.` : '',
    rep.collapsedRoster ? 'This document’s history doesn’t separate its authors, so all edits are shown together. Totals and timings are still exact.' : '',
    rep.scope ? `Covers ${esc(rep.scope)} only.` : ''
  ].filter(Boolean).map(n => `<div class="callout amber dv-note">${n}</div>`).join('');

  let tiles = '';
  if (isExt && m) {
    tiles = dvTiles([
      ['Words now', fmtN(m.finalWords), ''],
      ['Edit operations', fmtN(m.editOperations), m.spanDays ? `over ${m.spanDays} day${m.spanDays === 1 ? '' : 's'}` : ''],
      ['Active writing', fmtMins(m.activeMinutes), ''],
      ['Pastes', fmtN(m.pasteCount), m.externalPastes || m.internalPastes ? `${fmtN(m.externalPastes)} external · ${fmtN(m.internalPastes)} internal` : ''],
      ['Characters deleted', fmtN(m.deletedChars), 'written, then removed'],
      ['Span', m.spanDays ? `${m.spanDays}<small>d</small>` : '—', dvRange(m.firstEdit, m.lastEdit)]
    ]);
  } else if (isDrive) {
    const saves = rep.detail?.saves || [];
    tiles = dvTiles([
      ['Words now', fmtN(rep.wordCount), ''],
      ['Saved versions', fmtN(rep.revisionCount), rep.drive ? `${fmtN(rep.drive.analyzedRevisions)} read` : ''],
      ['Contributors', fmtN((rep.contributors || []).length), saves.length ? dvRange(saves[0].time, saves[saves.length - 1].time) : '']
    ]);
  }
  return `${notes}${tiles}
    ${rep.overallSummary ? `<div class="card card-pad dv-summary">${esc(rep.overallSummary)}</div>` : ''}
    ${growthChart(rep.growth)}
    ${dvActivitySection(rep)}`;
}
const dvTiles = list => `<div class="stat-grid">${list.map(([k, v, d]) => `<div class="card stat"><div class="kicker">${k}</div><div class="v">${v}</div>${d ? `<div class="d">${esc(d)}</div>` : ''}</div>`).join('')}</div>`;

function dvActivitySection(rep) {
  const { cells, unit, tz } = dvActivity(rep);
  if (!cells.length) return rep.source === 'visor-extension' ? `<div class="kicker dv-h">Activity</div>${dvResend('Activity by day and hour')}` : '';
  const byDate = new Map(), byHour = Array(24).fill(0), byWeekday = Array(7).fill(0);
  for (const c of cells) {
    byDate.set(c.date, (byDate.get(c.date) || 0) + c.count);
    byHour[c.hour] += c.count;
    byWeekday[new Date(c.date + 'T12:00:00').getDay()] += c.count;
  }
  const days = [...byDate.keys()].sort();
  const busiest = days.reduce((b, d) => (byDate.get(d) > (byDate.get(b) || 0) ? d : b), days[0]);
  const peak = byHour.indexOf(Math.max(...byHour));
  const sessions = rep.detail?.sessions || [];
  const longest = sessions.reduce((b, s) => ((s.end || s.start) - s.start > ((b?.end || b?.start || 0) - (b?.start || 0)) ? s : b), null);
  const longestMins = longest ? Math.max(1, Math.round(((longest.end || longest.start) - longest.start) / 60000)) : 0;

  const tiles = dvTiles([
    ['Active days', fmtN(days.length), dvRange(days[0] + 'T12:00:00', days[days.length - 1] + 'T12:00:00')],
    ['Busiest day', dvDay(busiest + 'T12:00:00'), `${fmtN(byDate.get(busiest))} ${unit}`],
    [longest ? 'Longest session' : 'Peak hour', longest ? fmtMins(longestMins) : dvHourLabel(peak), longest ? dvWhen(longest.start) : `${fmtN(byHour[peak])} ${unit}`]
  ]);

  // By day (or week, for long projects)
  let series = days.map(d => ({ label: dvDay(d + 'T12:00:00'), value: byDate.get(d), tip: `${dvDay(d + 'T12:00:00')}: ${fmtN(byDate.get(d))} ${unit}` }));
  let grain = 'day';
  if (days.length > 45) {
    grain = 'week';
    const weeks = new Map();
    for (const d of days) { const dt = new Date(d + 'T12:00:00'); dt.setDate(dt.getDate() - dt.getDay()); const k = dvLocalDate(dt.getTime()); weeks.set(k, (weeks.get(k) || 0) + byDate.get(d)); }
    series = [...weeks].sort().map(([k, v]) => ({ label: dvDay(k + 'T12:00:00'), value: v, tip: `Week of ${dvDay(k + 'T12:00:00')}: ${fmtN(v)} ${unit}` }));
  }
  return `<div class="kicker dv-h">Activity</div>${tiles}
    ${dvHeatmap(cells, unit, tz)}
    <div class="dv-two">
      <div><div class="kicker dv-h">${grain === 'day' ? 'By day' : 'By week'}</div>${dvBars(series)}</div>
      <div><div class="kicker dv-h">Time of day</div>${dvBars(byHour.map((v, h) => ({ label: h % 6 === 0 ? dvHourLabel(h) : '', value: v, tip: `${dvHourLabel(h)}: ${fmtN(v)} ${unit}` })))}</div>
    </div>
    <div class="kicker dv-h">Day of week</div>${dvBars(byWeekday.map((v, i) => ({ label: WEEKDAYS[i], value: v, tip: `${WEEKDAYS[i]}: ${fmtN(v)} ${unit}` })), { short: true })}`;
}

// Days × hours grid, one blue hue from light to dark (last 14 active days)
function dvHeatmap(cells, unit, tz) {
  const days = [...new Set(cells.map(c => c.date))].sort();
  const shown = days.slice(-14);
  const val = new Map(cells.map(c => [`${c.date}|${c.hour}`, c.count]));
  const max = Math.max(1, ...cells.map(c => c.count));
  const shade = n => (n ? `rgba(30,155,196,${(0.18 + 0.82 * Math.sqrt(n / max)).toFixed(2)})` : 'var(--surface)');
  const rows = shown.map(d => {
    const label = dvDay(d + 'T12:00:00');
    const total = Array.from({ length: 24 }, (_, h) => val.get(`${d}|${h}`) || 0).reduce((a, b) => a + b, 0);
    const cellsHtml = Array.from({ length: 24 }, (_, h) => { const n = val.get(`${d}|${h}`) || 0; return `<i style="background:${shade(n)}" title="${esc(label)}, ${dvHourLabel(h)}: ${fmtN(n)} ${unit}"></i>`; }).join('');
    return `<div class="dv-hm-row"><span class="dv-hm-day">${esc(label)}</span><div class="dv-hm-cells">${cellsHtml}</div><span class="dv-hm-total">${fmtN(total)}</span></div>`;
  }).join('');
  const ruler = `<div class="dv-hm-row dv-hm-ruler"><span class="dv-hm-day"></span><div class="dv-hm-cells">${Array.from({ length: 24 }, (_, h) => `<b>${h % 6 === 0 ? dvHourLabel(h).replace(' ', '') : ''}</b>`).join('')}</div><span class="dv-hm-total">total</span></div>`;
  return `<div class="card card-pad dv-hm" role="img" aria-label="Activity by day and hour">${ruler}${rows}
    <div class="tiny muted" style="margin-top:8px;">${days.length > shown.length ? `Last 14 of ${days.length} active days. ` : ''}Darker = more ${unit} in that hour. ${tz === 'writer' ? "Times are in the writer's own time zone." : unit === 'edits' ? 'Each writing session is counted at the hour it started, in your time zone.' : 'Times are in your time zone.'}</div></div>`;
}

// Simple vertical bars; hover shows the value
function dvBars(series, { short = false } = {}) {
  const max = Math.max(1, ...series.map(s => s.value));
  return `<div class="card card-pad dv-bars ${short ? 'short' : ''}">${series.map(s => `<div class="dv-bar" title="${esc(s.tip)}"><i style="height:${s.value ? Math.max(3, (s.value / max) * 100) : 0}%"></i><span>${esc(s.label)}</span></div>`).join('')}</div>`;
}

/* ---------- People ---------- */
function dvPeopleTab(rep) {
  const isExt = rep.source === 'visor-extension', isDrive = rep.source === 'drive';
  const who = dvPeople(rep);
  const contribs = rep.contributors || [];
  const unitShort = isExt ? 'edits' : isDrive ? 'saves' : 'revisions';
  const bars = contribs.map((c, i) => `<div class="bar-row" style="--c:${who(c.key ?? c.name).color}"><div class="n"><span class="avatar avatar-sm" style="background:var(--c)">${initials(c.name)}</span><span>${esc(c.name)}</span></div><div class="bar"><i style="width:${c.percentContribution}%"></i></div><div class="v">${c.percentContribution}%</div></div>`).join('');

  const unnamed = contribs.filter(c => c.measures && c.measures.identified === false).length;
  const note = rep.collapsedRoster ? '' : unnamed ? `<div class="callout amber dv-note">Google didn't include ${unnamed === contribs.length ? 'author names' : `names for ${unnamed} of these authors`}, so they are numbered in the order they first edited.</div>` : '';

  const card = (c, i) => {
    const x = c.measures || {};
    const color = who(c.key ?? c.name).color;
    const stats = isExt
      ? [['Inserted', fmtN(x.insertedChars)], ['Deleted', fmtN(x.deletedChars)], ['Active', fmtMins(x.activeMinutes)], ['WPM', x.wpm != null ? fmtN(x.wpm) : '—']]
      : [['Added', fmtN(x.insertedChars ?? c.wordsAdded * 5)], ['Removed', fmtN(x.deletedChars ?? c.wordsRemoved * 5)], [isDrive ? 'Saves' : 'Revisions', fmtN(c.revisionCount)]];
    let mix = '';
    if (isExt && x.insertedChars) {
      const external = Math.round((100 * (x.externalPastedChars || 0)) / x.insertedChars);
      const typed = Math.min(100 - external, Math.round(x.typedPct || 0));
      const internal = Math.max(0, 100 - typed - external);
      // Fixed colors here (not the person's), so "external" always reads the same
      mix = `<div class="dv-mix"><i style="width:${typed}%;background:var(--blue-deep)"></i><i style="width:${internal}%;background:#b9c7cf"></i><i style="width:${external}%;background:var(--amber)"></i></div>
        <div class="dv-key"><span><i style="background:var(--blue-deep)"></i>typed ${typed}%</span><span><i style="background:#b9c7cf"></i>internal pastes ${internal}%</span><span><i style="background:var(--amber)"></i>external pastes ${external}%${x.externalPastes ? ` (${fmtN(x.externalPastes)})` : ''}</span>${x.sessions ? `<span>${fmtN(x.sessions)} session${x.sessions === 1 ? '' : 's'}</span>` : ''}</div>`;
    }
    const when = dvRange(x.firstEdit, x.lastEdit);
    return `<div class="card dv-person" style="--c:${color}">
      <div class="dv-person-head">
        <span class="avatar" style="background:${color}">${initials(c.name)}</span>
        <div class="grow"><div class="dv-person-name">${esc(c.name)} <span class="muted small">· ${esc(c.role || '')}</span></div>
          <div class="tiny muted">${[c.email ? esc(c.email) : '', when ? esc(when) : '', `${fmtN(c.revisionCount)} ${unitShort}`].filter(Boolean).join(' · ')}</div></div>
        <div class="dv-person-share">${c.percentContribution}%</div>
      </div>
      <div class="dv-person-grid">${stats.map(([k, v]) => `<div><b>${v}</b><span>${k}</span></div>`).join('')}</div>
      ${mix}
      ${!isExt && c.keyContributions?.length ? `<ul class="small" style="margin:8px 0 0;padding-left:18px;">${c.keyContributions.map(k => `<li>${esc(k)}</li>`).join('')}</ul>` : ''}
    </div>`;
  };

  // Surviving text by author
  let prov = '';
  if (isExt) {
    const p = (rep.detail?.provenance || []).filter(x => x.total);
    const total = p.reduce((s, x) => s + x.total, 0);
    prov = `<div class="kicker dv-h">Text still in the document, by who wrote it</div>` + (total
      ? `<div class="card card-pad"><div class="dv-stack">${p.map(x => `<i style="width:${((x.total / total) * 100).toFixed(2)}%;background:${who(x.who).color}" title="${esc(who(x.who).name)}: ${fmtN(x.total)} characters (${fmtN(x.typed)} typed, ${fmtN(x.pasted)} pasted)"></i>`).join('')}</div>
          <div class="dv-key" style="margin-top:10px;">${p.map(x => `<span><i style="background:${who(x.who).color}"></i>${esc(who(x.who).name)} ${Math.round((x.total / total) * 100)}%</span>`).join('')}</div></div>`
      : rep.detail?.provenance ? `<div class="muted small">No surviving text to attribute.</div>` : dvResend('This breakdown'));
  }
  return `<div class="kicker dv-h">${isExt ? 'Share of the text written' : isDrive ? 'Share of text added between saves' : 'Share of revisions'}</div>
    <div class="bar-rows" style="margin-bottom:18px;">${bars}</div>
    ${note}<div class="stack">${contribs.map(card).join('')}</div>
    ${prov}`;
}

/* ---------- Timeline ---------- */
function dvTimeline(rep) {
  const who = dvPeople(rep);
  if (rep.source === 'drive') {
    const saves = [...(rep.detail?.saves || [])].sort((a, b) => b.time - a.time);
    if (!saves.length) return `<div class="muted">No saved versions with times.</div>`;
    return `<div class="muted small" style="margin-bottom:12px;">Each saved version in Google Drive, newest first. Changes are credited to whoever saved the version.</div>
      <div class="dv-list">${saves.slice(0, 150).map(s => {
        const p = who(s.who);
        const churn = s.added + s.removed || 1;
        return `<div class="dv-row" style="--c:${p.color}"><div class="dv-rail"></div><div class="grow">
          <div class="dv-row-top"><span class="dv-name"><i style="background:${p.color}"></i>${esc(p.name)}</span><span class="dv-when">${esc(dvWhen(s.time))}</span></div>
          <div class="dv-row-meta">${s.noText ? 'Text unavailable for this version' : `<b>+${fmtN(s.added)}</b> / <b>−${fmtN(s.removed)}</b> chars · ${fmtN(s.length)} chars total`}</div>
          ${s.noText ? '' : `<div class="dv-churn"><i style="width:${((s.added / churn) * 100).toFixed(1)}%;background:${p.color}"></i><i style="width:${((s.removed / churn) * 100).toFixed(1)}%;background:var(--red)"></i></div>`}
        </div></div>`;
      }).join('')}</div>`;
  }
  const sessions = [...(rep.detail?.sessions || [])].sort((a, b) => b.start - a.start);
  if (!rep.detail) return dvResend('The list of writing sessions');
  if (!sessions.length) return `<div class="muted">No writing sessions recorded.</div>`;
  return `<div class="muted small" style="margin-bottom:12px;">Each stretch of writing, newest first. Everyone who wrote during a session is named, largest contributor first.</div>
    <div class="dv-list">${sessions.slice(0, 150).map(s => {
      const seats = s.authors?.length ? [...s.authors].sort((a, b) => b.inserted - a.inserted) : [{ who: s.who }];
      const lead = who(seats[0].who);
      const churn = s.inserted + s.deleted || 1;
      const mins = s.end ? Math.max(1, Math.round((s.end - s.start) / 60000)) : 0;
      return `<div class="dv-row" style="--c:${lead.color}"><div class="dv-rail"></div><div class="grow">
        <div class="dv-row-top"><span>${seats.map(a => { const p = who(a.who); return `<span class="dv-name"><i style="background:${p.color}"></i>${esc(p.name.split(' ')[0])}</span>`; }).join('')}</span>
          ${s.pastes ? `<span class="pill pill-amber">${s.pastes} paste${s.pastes === 1 ? '' : 's'}</span>` : ''}<span class="dv-when">${esc(dvWhen(s.start))}</span></div>
        <div class="dv-row-meta"><b>+${fmtN(s.inserted)}</b> / <b>−${fmtN(s.deleted)}</b> chars · <b>${fmtN(s.mutations)}</b> edits${mins ? ` · ${fmtMins(mins)}` : ''}</div>
        <div class="dv-churn"><i style="width:${((s.inserted / churn) * 100).toFixed(1)}%;background:${lead.color}"></i><i style="width:${((s.deleted / churn) * 100).toFixed(1)}%;background:var(--red)"></i></div>
      </div></div>`;
    }).join('')}</div>${sessions.length > 150 ? `<div class="tiny muted" style="margin-top:8px;">Showing the newest 150 of ${fmtN(sessions.length)} sessions.</div>` : ''}`;
}

/* ---------- Evidence ---------- */
function dvSortItems(items, mode, who) {
  const list = [...items];
  if (mode === 'largest') return list.sort((a, b) => b.length - a.length);
  if (mode === 'person') {
    const total = new Map();
    for (const x of list) total.set(x.who, (total.get(x.who) || 0) + x.length);
    return list.sort((a, b) => (total.get(b.who) - total.get(a.who)) || String(who(a.who).name).localeCompare(who(b.who).name) || b.length - a.length);
  }
  return list.sort((a, b) => (b.time || 0) - (a.time || 0));
}
function dvSort(list, mode) { dv.sort[list] = mode; dvRender(); }
function dvEvidence(rep) {
  if (!rep.detail?.pastes && !rep.detail?.deletions) return dvResend('The list of pastes and deletions');
  const who = dvPeople(rep);
  const ORIGIN = { external: ['external paste', 'pill-amber'], 'internal-copy': ['internal paste', 'pill-gray'], 'internal-move': ['internal paste', 'pill-gray'] };
  const sorts = list => `<div class="dv-sorts">${[['recent', 'Recent'], ['largest', 'Largest'], ['person', 'Person']].map(([k, l]) => `<button class="${dv.sort[list] === k ? 'on' : ''}" onclick="dvSort('${list}','${k}')">${l}</button>`).join('')}</div>`;
  const entry = e => {
    const p = who(e.who); const o = e.origin && ORIGIN[e.origin];
    return `<div class="dv-ev" style="--c:${p.color}"><span class="dv-name"><i style="background:${p.color}"></i>${esc(p.name)}</span>${o ? `<span class="pill ${o[1]}">${o[0]}</span>` : ''}<span class="dv-when">${esc(dvWhen(e.time))}</span><span class="dv-size">${fmtN(e.length)} chars</span></div>`;
  };
  const pastes = rep.detail.pastes || [], dels = rep.detail.deletions || [];
  const ext = pastes.filter(p => p.origin === 'external');
  return `<div class="callout dv-note" style="background:var(--surface);">Who pasted or deleted, when, and how much. The text itself stays in the extension: open the document in Chrome with Visor to read it.</div>
    <div class="dv-ev-head"><div class="kicker">Pastes <span class="muted">· ${fmtN(pastes.length)}${ext.length ? `, ${fmtN(ext.length)} from outside the document` : ''}</span></div>${pastes.length ? sorts('pastes') : ''}</div>
    <div class="dv-evlist">${pastes.length ? dvSortItems(pastes, dv.sort.pastes, who).slice(0, 100).map(entry).join('') : '<div class="muted small">No bulk pastes.</div>'}</div>
    <div class="dv-ev-head"><div class="kicker">Deletions <span class="muted">· ${fmtN(dels.length)}</span></div>${dels.length ? sorts('deletions') : ''}</div>
    <div class="dv-evlist">${dels.length ? dvSortItems(dels, dv.sort.deletions, who).slice(0, 100).map(entry).join('') : '<div class="muted small">Nothing substantial was deleted.</div>'}</div>`;
}

/* ---------- Signal ---------- */
function dvSignal(rep) {
  const m = rep.metrics || {};
  const enough = m.enoughHistory !== false;
  const share = m.externalShare || 0;
  const tone = !enough ? 'var(--ink-3)' : share >= 0.5 ? 'var(--red)' : share > 0 ? 'var(--amber)' : 'var(--green-deep)';
  const external = m.externalPastedChars || 0, internal = m.internalPastedChars || 0;
  const typed = Math.max(0, (m.insertedChars || 0) - external - internal);
  const total = typed + internal + external;
  const parts = [['Typed keystroke by keystroke', 'var(--blue-deep)', typed, ''], ['Internal pastes', '#b9c7cf', internal, m.internalPastes ? `in ${fmtN(m.internalPastes)} paste${m.internalPastes === 1 ? '' : 's'}` : ''], ['External pastes', 'var(--amber)', external, m.externalPastes ? `in ${fmtN(m.externalPastes)} paste${m.externalPastes === 1 ? '' : 's'}` : '']];
  const obs = rep.detail?.observations;
  return `<div class="card card-pad dv-signal">
      <div class="dv-signal-num" style="color:${tone}">${enough ? `${Math.round(share * 100)}<small>%</small>` : '—'}</div>
      <div><div class="dv-signal-title" style="color:${tone}">${enough ? 'External pastes' : 'Not enough history'}</div>
        <div class="small muted">${enough ? `${fmtN(external)} of ${fmtN(m.insertedChars)} characters were pasted into this document from somewhere else. The rest was created in the document.` : 'Too few recorded edits to measure this.'}</div>
        <div class="tiny muted" style="margin-top:6px;">A measurement to discuss, not a verdict.</div></div>
    </div>
    <div class="kicker dv-h">How the text arrived</div>
    ${total ? `<div class="card card-pad"><div class="dv-stack tall">${parts.filter(p => p[2]).map(([l, c, v]) => `<i style="width:${((v / total) * 100).toFixed(2)}%;background:${c}" title="${l}: ${fmtN(v)} characters"></i>`).join('')}</div>
      <div class="dv-origin">${parts.map(([l, c, v, n]) => `<div><i style="background:${c}"></i><div><b>${l}</b><div class="tiny muted">${fmtN(v)} characters${n ? ' ' + n : ''} · ${Math.round((v / total) * 100)}%</div></div></div>`).join('')}</div></div>` : `<div class="muted small">No text recorded yet.</div>`}
    <div class="kicker dv-h">What was measured</div>
    ${obs ? (obs.length ? `<div class="dv-obs">${obs.map(o => `<div class="dv-ob"><div class="grow"><b>${esc(o.label)}</b>${o.detail ? `<div class="small muted">${esc(o.detail)}</div>` : ''}</div>${o.measure ? `<span class="mono small">${esc(o.measure)}</span>` : ''}</div>`).join('')}</div>` : '<div class="muted small">Nothing measured yet.</div>') : dvResend('This list')}`;
}

/* ====================== speaker wizard ====================== */
// One voice at a time: show what they said, pick who it was.
let wiz = null;
function openSpeakerWizard(id, editing = false) {
  const r = project.resources.find(x => x.id === id); if (!r) return;
  const speakers = (r.speakers || []).slice();
  if (!speakers.length) return toast('No separate voices were found in this recording.', 'err');
  const people = [...project.students.map(s => ({ id: s.id, name: s.name, role: 'student', avatarColor: s.avatarColor })), ...(project.teacher ? [{ id: project.teacher.id, name: project.teacher.name, role: 'teacher', avatarColor: project.teacher.avatarColor }] : [])];
  const startAt = editing ? 0 : Math.max(0, speakers.findIndex(s => !s.assignedName));
  wiz = { id, speakers, people, idx: startAt === -1 ? 0 : startAt, picks: Object.fromEntries(speakers.map(s => [s.label, s.assignedName ? { name: s.assignedName, userId: s.assignedUserId } : null])), other: '' };
  renderWizard();
}
function renderWizard() {
  const s = wiz.speakers[wiz.idx];
  const total = wiz.speakers.length;
  const pick = wiz.picks[s.label];
  const cls = colorClass(wiz.idx);
  const usedBy = name => Object.entries(wiz.picks).filter(([l, p]) => l !== s.label && p?.name === name).map(([l]) => l);
  const chips = wiz.people.map(p => {
    const sel = pick?.name === p.name; const used = usedBy(p.name);
    return `<button class="chip ${sel ? 'selected' : ''}" onclick="wizPick(${JSON.stringify(p.name).replace(/"/g, '&quot;')}, '${p.id}')" title="${used.length ? 'Already used for ' + used.join(', ') : ''}">${avatarHtml(p)}${esc(p.name)}${p.role === 'teacher' ? ' <span class="tiny muted">(teacher)</span>' : ''}${used.length ? ' <span class="tiny muted">· also ' + esc(used.join(', ')) + '</span>' : ''}</button>`;
  }).join('');
  const otherSel = pick && !wiz.people.some(p => p.name === pick.name);
  const progress = wiz.speakers.map((sp, i) => `<span class="${i < wiz.idx || (wiz.picks[sp.label] && i !== wiz.idx) ? 'done' : ''} ${i === wiz.idx ? 'cur' : ''}"></span>`).join('');
  openModal({ title: `Who is this? <span class="muted" style="font-weight:500;font-size:15px;">Voice ${wiz.idx + 1} of ${total}</span>`, sub: s.voice ? esc(s.voice) : 'Here are a few things this voice said.', wide: true, closable: true, body: `
    <div class="wiz-progress">${progress}</div>
    <div class="${cls}">${(s.quotes || []).slice(0, 3).map(q => `<div class="quote">${esc(q)}</div>`).join('') || '<div class="muted">No sample lines.</div>'}</div>
    <div class="kicker" style="margin:16px 0 10px;">This voice is…</div>
    <div class="chips" id="wizChips">
      ${chips}
      <button class="chip other ${otherSel ? 'selected' : ''}" onclick="wizOther()">Someone else…</button>
    </div>
    <div id="wizOtherField" class="field ${otherSel ? '' : 'hidden'}" style="margin-top:12px;"><label>Their name</label><input id="wizOtherName" class="input" placeholder="e.g. Mr. Alvarez, or a student not on this project" value="${otherSel ? esc(pick.name) : ''}" oninput="wizOtherTyped(this.value)" /></div>`,
    footer: `<div style="display:flex;gap:10px;width:100%;align-items:center;">
      <button class="btn btn-ghost" ${wiz.idx === 0 ? 'disabled' : ''} onclick="wizStep(-1)">Back</button>
      <span style="flex:1"></span>
      <button class="btn btn-ghost" onclick="wizSkip()">Not sure, skip</button>
      <button class="btn btn-primary" id="wizNext" ${pick ? '' : 'disabled'} onclick="wizStep(1)">${wiz.idx === total - 1 ? 'Finish' : 'Next'}</button>
    </div>` });
  if (otherSel) setTimeout(() => $('wizOtherName')?.focus(), 30);
}
function wizPick(name, userId) { const s = wiz.speakers[wiz.idx]; wiz.picks[s.label] = { name, userId }; renderWizard(); }
function wizOther() { const s = wiz.speakers[wiz.idx]; wiz.picks[s.label] = { name: '', userId: null }; renderWizard(); $('wizOtherField').classList.remove('hidden'); $('wizNext').disabled = true; setTimeout(() => $('wizOtherName')?.focus(), 30); }
function wizOtherTyped(v) { const s = wiz.speakers[wiz.idx]; wiz.picks[s.label] = { name: v.trim(), userId: null }; $('wizNext').disabled = !v.trim(); document.querySelectorAll('#wizChips .chip').forEach(c => c.classList.toggle('selected', c.classList.contains('other'))); }
function wizSkip() { const s = wiz.speakers[wiz.idx]; wiz.picks[s.label] = null; wizStep(1, true); }
async function wizStep(dir, skipping = false) {
  if (dir === 1 && wiz.idx === wiz.speakers.length - 1) return wizFinish();
  wiz.idx = Math.max(0, Math.min(wiz.speakers.length - 1, wiz.idx + dir));
  renderWizard();
}
async function wizFinish() {
  const assignments = {};
  for (const [label, p] of Object.entries(wiz.picks)) assignments[label] = p && p.name ? { name: p.name, userId: p.userId || null } : null;
  try {
    const r = await api(`/api/projects/${project.id}/resources/${wiz.id}/speakers`, { method: 'POST', body: { assignments } });
    const i = project.resources.findIndex(x => x.id === wiz.id); project.resources[i] = r.resource;
    renderResources();
    const left = r.resource.unassigned;
    toast(left ? `Saved. ${left} voice${left > 1 ? 's' : ''} still unnamed; open the recording any time to finish.` : 'Transcript ready.');
    openTranscript(r.resource);
  } catch (e) { toast(e.message, 'err'); }
}

/* ====================== analysis ====================== */
const SRC = { extension: ['pill-violet', 'Document'], recording: ['pill-amber', 'Recording'], transcript: ['pill-amber', 'Recording'], multiple: ['pill-gray', 'Multiple'], drive: ['pill-blue', 'Drive'] };
const srcPill = s => { const [c, l] = SRC[(s || '').toLowerCase()] || SRC.multiple; return `<span class="pill ${c}">${l}</span>`; };
const ROLE_ICON = { 'primary writer': I.pen, 'active editor': I.edit, 'coordinator': I.compass, 'commenter': I.chat, 'minimal contributor': I.minus, 'absent': I.x };
const roleIcon = role => { const k = Object.keys(ROLE_ICON).find(k => (role || '').toLowerCase().includes(k)); return ROLE_ICON[k] || I.users; };

function renderAnalysis() {
  const p = project;
  const actions = $('analysisActions');
  const content = $('analysisContent');
  const canRun = p.isTeacher && !p.isDemo;
  actions.innerHTML = canRun
    ? `<button class="btn btn-primary" id="runBtn" onclick="runAnalysis()">${I.sparkle}<span>${analysis ? 'Run again' : 'Run analysis'}</span></button>`
    : '';
  $('analysisSub').textContent = p.isTeacher ? (p.showAnalysis ? 'Students can see this report.' : 'Only you can see this. Share it with students from the project settings.') : 'Your teacher has shared this report with the project.';

  if (!analysis) {
    const pending = p.resources.filter(r => r.type === 'audio' && r.status !== 'ready').length;
    content.innerHTML = `<div class="card"><div class="empty"><div class="ic">${I.sparkle}</div><h4>${p.isTeacher ? 'No report yet' : 'Nothing to show yet'}</h4><p>${p.isTeacher ? (p.resources.length ? `Run the analysis to combine ${p.resources.length} resource${p.resources.length > 1 ? 's' : ''} into one report.${pending ? ` ${pending} recording${pending > 1 ? 's are' : ' is'} not fully ready yet; they will be noted but not used.` : ''}` : 'Add a recording or document data first, then run the analysis.') : 'Your teacher hasn\'t run the analysis yet.'}</p></div></div>`;
    return;
  }
  const a = analysis, ai = a.ai;
  let h = '';

  // sources + notes
  const chips = [];
  if (a.sources?.extensionReports) chips.push(`${srcPill('extension')} <span class="small muted">${a.sources.extensionReports} document${a.sources.extensionReports > 1 ? 's' : ''}</span>`);
  if (a.sources?.driveReports) chips.push(`${srcPill('drive')} <span class="small muted">${a.sources.driveReports} from Google Drive</span>`);
  if (a.sources?.transcripts) chips.push(`${srcPill('recording')} <span class="small muted">${a.sources.transcripts} recording${a.sources.transcripts > 1 ? 's' : ''}</span>`);
  h += `<div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:14px;" class="rise">${chips.map(c => `<span style="display:inline-flex;align-items:center;gap:6px;">${c}</span>`).join('')}<span class="tiny muted mono" style="margin-left:auto;">${a.at ? 'Run ' + timeAgo(a.at) : ''}</span></div>`;
  if (a.errors?.length) h += `<div class="callout amber rise" style="margin-bottom:14px;"><div class="kicker" style="color:var(--amber);">Heads up</div><ul>${a.errors.map(e => `<li>${esc(e)}</li>`).join('')}</ul></div>`;
  if (a.silentMembers?.length) h += `<div class="callout red rise" style="margin-bottom:14px;"><b>No tracked activity anywhere:</b> ${a.silentMembers.map(esc).join(', ')}. They are on the project but appear in no recording or document.</div>`;

  // stats
  h += `<div class="stat-grid rise">
    <div class="card stat"><div class="kicker">Tracked edits</div><div class="v">${(a.totalEvents ?? 0).toLocaleString()}</div><div class="d">edits and saved revisions, all documents</div></div>
    <div class="card stat"><div class="kicker">Contributors</div><div class="v">${(ai?.workload || a.contributors || []).length}</div><div class="d">people with activity</div></div>
    <div class="card stat"><div class="kicker">Fairness</div><div class="v">${a.fairnessScore ?? '—'}<small>/100</small></div><div class="d">100 = perfectly even split</div></div>
  </div>`;

  if (ai?.executiveSummary) h += `<div class="card card-pad rise" style="margin-bottom:14px;background:linear-gradient(180deg,#F5FBFD,#fff);"><div class="kicker" style="margin-bottom:6px;display:flex;align-items:center;gap:6px;">${I.sparkle} The short version</div><div style="font-size:15.5px;line-height:1.6;">${esc(ai.executiveSummary)}</div></div>`;

  if (ai?.workload?.length) {
    h += `<div class="card card-pad rise" style="margin-bottom:14px;"><div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:18px;"><h3 class="section-title">Estimated workload</h3><span class="tiny muted mono">from every source</span></div><div class="workload">`;
    ai.workload.forEach((w, i) => {
      const c = (a.contributors || []).find(x => x.name.toLowerCase().replace(/[^a-z0-9]/g, '') === w.name.toLowerCase().replace(/[^a-z0-9]/g, ''));
      h += `<div class="wl" style="--c:${personColor(projectPerson(w.name), i)}"><div class="role-ic">${roleIcon(w.role)}</div><div>
        <div class="head"><span class="n">${esc(w.name)}</span><span class="r">${esc(w.role)}</span>${w.confidence ? `<span class="pill pill-gray">${esc(w.confidence)} confidence</span>` : ''}</div>
        <div class="barline"><div class="bar"><i style="width:${w.percent}%"></i></div><div class="pct">${w.percent}%</div></div>
        ${c ? `<div class="src">documents ${c.extPct ?? 0}% of the writing${c.inRecordings ? ' · heard in recordings' : ''}</div>` : ''}
        ${w.whatTheyDid?.length ? `<ul>${w.whatTheyDid.map(d => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}
        ${w.evidence ? `<div class="ev">${esc(w.evidence)}</div>` : ''}
      </div></div>`;
    });
    h += `</div></div>`;
  }

  h += habitsSection(a);

  if (ai?.whoDidWhat?.length) h += `<div class="card card-pad rise" style="margin-bottom:14px;"><h3 class="section-title" style="margin-bottom:8px;">Who did what</h3>${ai.whoDidWhat.map(t => `<div class="task"><div>${esc(t.task)}</div><div class="o">${esc(t.owner)}</div>${srcPill(t.source)}</div>`).join('')}</div>`;

  if (ai?.recordingInsights?.length) h += `<div class="rise" style="margin-bottom:14px;"><h3 class="section-title" style="margin-bottom:10px;">From the recordings</h3><div class="stack">${ai.recordingInsights.map(r => `<div class="card card-pad"><div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;">${srcPill('recording')}<b>${esc(r.title)}</b></div><div style="font-size:14.5px;">${esc(r.summary)}</div>${r.speakers?.length ? `<div class="chips" style="margin-top:10px;">${r.speakers.map(s => `<span class="pill pill-gray">${esc(s.name)} · ${s.share}% of talk time</span>`).join('')}</div>` : ''}</div>`).join('')}</div></div>`;

  if (ai && (ai.groupDynamics || ai.concerns?.length)) {
    h += `<div class="two-col rise" style="margin-bottom:14px;">`;
    if (ai.groupDynamics) h += `<div class="card card-pad"><div class="kicker" style="margin-bottom:6px;">How the group worked</div><div style="font-size:14.5px;">${esc(ai.groupDynamics)}</div></div>`;
    if (ai.concerns?.length) h += `<div class="callout amber"><div class="kicker" style="color:var(--amber);">Worth a look</div><ul>${ai.concerns.map(c => `<li>${esc(c)}</li>`).join('')}</ul></div>`;
    h += `</div>`;
  }
  if (ai?.bottomLine) h += `<div class="callout dark rise" style="margin-bottom:14px;"><div class="kicker">Bottom line</div><div style="font-size:15.5px;margin-top:4px;">${esc(ai.bottomLine)}</div></div>`;

  if (a.perResource?.length) {
    h += `<div class="rise"><h3 class="section-title" style="margin-bottom:10px;">By resource</h3><div class="stack">` + a.perResource.map(pr => {
      let inner = '';
      if (pr.summary) inner += `<div class="small" style="margin:10px 0;">${esc(pr.summary)}</div>`;
      if (pr.type === 'audio') inner += `<div class="small muted" style="margin-top:10px;">${pr.lines || 0} transcript lines, fed to the analysis as-is.${pr.names?.length ? ' Voices: ' + pr.names.map(esc).join(', ') + '.' : ''}</div>`;
      if (pr.contributors?.length) inner += `<div class="bar-rows" style="margin-top:10px;">${pr.contributors.map((c, i) => `<div class="bar-row" style="--c:${personColor(projectPerson(c.name), i)}"><div class="n"><span>${esc(c.name)}</span></div><div class="bar"><i style="width:${c.pct}%"></i></div><div class="v">${c.pct}%</div></div>`).join('')}</div>`;
      return `<div class="card collapse"><div class="ch" onclick="this.parentElement.classList.toggle('open')">${I.chev}<b style="flex:1;">${esc(pr.title)}</b>${srcPill(pr.type === 'audio' ? 'recording' : pr.source === 'drive' ? 'drive' : 'extension')}${pr.total != null ? `<span class="tiny muted mono">${pr.total} rev</span>` : (pr.lines != null ? `<span class="tiny muted mono">${pr.lines} lines</span>` : '')}</div><div class="cb">${inner || '<div class="muted small" style="padding-top:10px;">No detail.</div>'}</div></div>`;
    }).join('') + `</div></div>`;
  }
  if (!ai) h += `<div class="callout amber rise">The report text could not be written (see above). The numbers are from the raw data.</div>`;
  content.innerHTML = h;
}

// How each person wrote, from the extension's edit-by-edit figures, across all documents
function habitsSection(a) {
  const order = (a.ai?.workload || []).map(w => w.name.toLowerCase());
  const rows = (a.contributors || []).filter(c => c.habits).sort((x, y) => {
    const i = order.indexOf(x.name.toLowerCase()), j = order.indexOf(y.name.toLowerCase());
    return (i < 0 ? 99 : i) - (j < 0 ? 99 : j);
  });
  if (!rows.length) return '';
  const body = rows.map((c, i) => {
    const h = c.habits;
    const color = personColor(projectPerson(c.name), i);
    const big = h.largestExternalPastes?.[0];
    return `<tr>
      <td><div class="hb-name"><span class="avatar avatar-sm" style="background:${color}">${initials(c.name)}</span><span>${esc(c.name)}</span></div></td>
      <td><div class="dv-mix hb-mix" title="typed ${h.typedPct}% · internal pastes ${h.internalPct}% · external pastes ${h.externalPct}%"><i style="width:${h.typedPct}%;background:var(--blue-deep)"></i><i style="width:${h.internalPct}%;background:#b9c7cf"></i><i style="width:${h.externalPct}%;background:var(--amber)"></i></div><div class="tiny muted">${h.typedPct}% typed</div></td>
      <td class="mono">${h.externalPastes ? `<b class="hb-warn">${h.externalPct}%</b> <span class="tiny muted">${h.externalPastes} paste${h.externalPastes === 1 ? '' : 's'}${big ? `, largest ${fmtN(big.length)}` : ''}</span>` : '<span class="muted">none</span>'}</td>
      <td class="mono">${fmtMins(h.activeMinutes)}</td>
      <td class="mono">${fmtN(h.sessions)}</td>
      <td class="mono">${h.wpm ?? '—'}</td>
      <td class="mono">${fmtN(h.deletedChars)}</td>
      <td class="small muted">${esc(dvRange(h.firstEdit, h.lastEdit))}</td>
    </tr>`;
  }).join('');
  return `<div class="card card-pad rise" style="margin-bottom:14px;">
    <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:12px;"><h3 class="section-title">Writing habits</h3><span class="tiny muted">from the Visor extension, every edit, all documents</span></div>
    <div class="hb-wrap"><table class="hb">
      <thead><tr><th>Person</th><th>How text arrived</th><th>External pastes</th><th>Active</th><th>Sessions</th><th>WPM</th><th>Deleted</th><th>Active span</th></tr></thead>
      <tbody>${body}</tbody></table></div>
    <div class="dv-key" style="margin-top:10px;"><span><i style="background:var(--blue-deep)"></i>typed</span><span><i style="background:#b9c7cf"></i>internal pastes</span><span><i style="background:var(--amber)"></i>external pastes (text from outside the document: a measurement to discuss, not a verdict)</span></div>
  </div>`;
}

async function runAnalysis() {
  const btn = $('runBtn'); if (!btn) return;
  btn.disabled = true; btn.innerHTML = `<span class="spinner spinner-sm" style="border-top-color:#fff;border-color:rgba(255,255,255,0.4);border-top-color:#fff;"></span><span>Working…</span>`;
  $('analysisContent').innerHTML = `<div class="card card-pad" style="text-align:center;padding:40px;"><span class="spinner"></span><div style="margin-top:14px;font-weight:600;">Reading every resource and asking Gemini for the report</div><div class="muted small" style="margin-top:4px;">Usually 15 to 40 seconds.</div></div>`;
  const startedAt = Date.now(), pid = project.id;
  try {
    let r;
    try {
      r = await api(`/api/projects/${pid}/analyze`, { method: 'POST' });
    } catch (e) {
      // Hosting stops waiting after 60 seconds, but the server keeps going and
      // saves the report. Look for it for a few more minutes before giving up.
      if (e.status && ![502, 503, 504].includes(e.status)) throw e;
      r = null;
      for (let i = 0; i < 60 && !r; i++) {
        await new Promise(res => setTimeout(res, 4000));
        const got = await api(`/api/projects/${pid}/analysis`).catch(() => null);
        if (got?.analysis && Date.parse(got.analysis.at) >= startedAt - 5000) r = got;
      }
      if (!r) throw new Error('The analysis is taking longer than expected. Check back in a few minutes.');
    }
    if (project?.id !== pid) return;
    analysis = r.analysis; project.hasAnalysis = true; renderAnalysis();
  } catch (e) {
    analysis = null; renderAnalysis();
    $('analysisContent').innerHTML = `<div class="callout red">${esc(e.message)}</div>` + $('analysisContent').innerHTML;
  }
}

/* ====================== go ====================== */
boot();
