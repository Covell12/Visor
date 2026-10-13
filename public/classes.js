/* Visor Classroom — Home (the course dashboard and its right-hand column),
   the top bar's Classes menu, and the class pages: the sidebar frame,
   Assignments (folders and assignments in the teacher's order), People and
   Settings. Announcements and Home's Activity are updates.js; the
   assignment page (inside the same frame) is assignments.js.

   Also the small helpers every Visor Classroom page shares (dates, page
   headers, breadcrumbs, dropdown menus, course colours). Uses app.js
   helpers: $, esc, api, toast, openModal… */

'use strict';

/* ====================== shared helpers ====================== */
const vcDate = iso => (iso ? new Date(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : '');
const vcDateTime = iso => (iso ? new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const vcTime = iso => (iso ? new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '');
// "1h 05m", "4m 12s", "38s"
function vcDur(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(r).padStart(2, '0')}s`;
  return `${r}s`;
}
// "12:04" style clock for timers
function vcClock(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}
const vcPlural = (n, word, plural) => `${n} ${n === 1 ? word : (plural || word + 's')}`;
// A local calendar day as "2026-10-16"
const vcDayKey = d => { d = new Date(d); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
// "Today", "Tomorrow", "Yesterday" or "Thursday, October 16"
function vcDayLabel(d) {
  const k = vcDayKey(d), now = new Date();
  const off = n => vcDayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + n));
  if (k === off(0)) return 'Today';
  if (k === off(1)) return 'Tomorrow';
  if (k === off(-1)) return 'Yesterday';
  return new Date(d).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', ...(new Date(d).getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}
// "Due Thu, Oct 16 at 11:59 PM"
const vcDue = iso => (iso ? `Due ${new Date(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} at ${vcTime(iso)}` : 'No due date');

const TYPE_LABEL = { writing: 'Writing', group: 'Group project', discussion: 'Discussion' };
const TYPE_PILL = { writing: 'pill-blue', group: 'pill-violet', discussion: 'pill-amber' };
const typePill = t => `<span class="pill ${TYPE_PILL[t] || 'pill-gray'}">${esc(TYPE_LABEL[t] || t)}</span>`;
const STATUS_LABEL = { 'not-started': 'Not started', 'in-progress': 'In progress', submitted: 'Submitted', returned: 'Returned' };
const STATUS_PILL = { 'not-started': 'pill-gray', 'in-progress': 'pill-blue', submitted: 'pill-green', returned: 'pill-violet' };
const statusPillDoc = s => `<span class="pill ${STATUS_PILL[s] || 'pill-gray'}">${esc(STATUS_LABEL[s] || s)}</span>`;
const isDone = status => status === 'submitted' || status === 'returned';
// A writing assignment the student hasn't handed in, past its due date
const isOverdue = (dueAt, status) => !!dueAt && Date.parse(dueAt) < Date.now() && !!status && !isDone(status);

// Icons the portal adds to app.js's set
const PI = {
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
  megaphone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 11 15-6v14L3 13z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/><path d="M18 9a3 3 0 0 1 0 6"/></svg>',
  cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M2.5 6.5A2.5 2.5 0 0 1 5 4h3.9c.66 0 1.3.26 1.77.73L12.2 6.3H19a2.5 2.5 0 0 1 2.5 2.5v8.7A2.5 2.5 0 0 1 19 20H5a2.5 2.5 0 0 1-2.5-2.5z"/></svg>',
  folderPlus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11v6M9 14h6"/></svg>',
  move: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="m13 11 3 3-3 3M8 14h8"/></svg>',
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
  left: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>',
  right: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
  grip: '<svg viewBox="0 0 12 18" fill="currentColor"><circle cx="3" cy="3" r="1.5"/><circle cx="9" cy="3" r="1.5"/><circle cx="3" cy="9" r="1.5"/><circle cx="9" cy="9" r="1.5"/><circle cx="3" cy="15" r="1.5"/><circle cx="9" cy="15" r="1.5"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5M9 10.8V4h6v6.8l3 3.2v2H6v-2z"/></svg>',
  dots: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
  eyeOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.9 17.9A10 10 0 0 1 12 20c-6.5 0-10-8-10-8a18 18 0 0 1 5.1-6"/><path d="M9.9 4.2A9 9 0 0 1 12 4c6.5 0 10 8 10 8a18 18 0 0 1-2.2 3.2M14.1 14.1a3 3 0 1 1-4.2-4.2M2 2l20 20"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/></svg>',
  book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/></svg>',
  live: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="2"/><path d="M16.2 7.8a6 6 0 0 1 0 8.4M7.8 16.2a6 6 0 0 1 0-8.4M19.1 4.9a10 10 0 0 1 0 14.2M4.9 19.1a10 10 0 0 1 0-14.2"/></svg>'
};
const TYPE_ICON = { writing: I.edit, group: I.users, discussion: I.chat };
const typeIcon = (t, extra = '') => `<span class="mat-ic t-${esc(t)} ${extra}" aria-hidden="true">${TYPE_ICON[t] || I.doc}</span>`;

function crumbs(list) {
  return `<nav class="crumbs" aria-label="Breadcrumb">${list.map(([label, href], i) => (href && i < list.length - 1 ? `<a href="${href}" data-link>${esc(label)}</a>` : `<span aria-current="page">${esc(label)}</span>`)).join('<span class="sep" aria-hidden="true">/</span>')}</nav>`;
}
function pageTabs(tabs, active, onclickFn) {
  return `<div class="tabs" role="tablist">${tabs.map(([k, label, count]) => `<button class="tab ${k === active ? 'active' : ''}" role="tab" aria-selected="${k === active}" onclick="${onclickFn}('${k}')">${label}${count != null ? ` <span class="count">${count}</span>` : ''}</button>`).join('')}</div>`;
}
async function copyText(text, label = 'Copied') {
  try { await navigator.clipboard.writeText(text); toast(label); } catch { toast(text); }
}
// Run a dialog's save with its buttons switched off, so a double click (or
// Enter twice) saves once. A second call while one is running does nothing.
async function modalBusy(fn) {
  const btns = [...document.querySelectorAll('#modalFooter button')];
  if (btns.some(b => b.dataset.busy)) return;
  btns.forEach(b => { b.dataset.busy = b.disabled ? 'was' : '1'; b.disabled = true; });
  try { return await fn(); }
  finally { btns.forEach(b => { if (b.dataset.busy !== 'was') b.disabled = false; delete b.dataset.busy; }); }
}

// Escape closes an open dropdown first; otherwise a dialog that has a close
// button, unless it's a form (a stray Escape shouldn't throw away a
// half-written assignment)
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (ddOpen) { ddClose(true); return; }
  const root = $('modalRoot');
  if (root?.querySelector('.mh .btn-icon') && !root.querySelector('.modal input:not([type=checkbox]):not([type=radio]), .modal textarea')) closeModal();
});

/* ---- dropdown menus: a button that shows a panel of actions or links ----
   ddHtml({ id, btn, items, right, btnClass, label }) where items are
   { label, icon, onclick (code), href, danger, disabled, note }, 'sep' or
   { header }. One menu is open at a time; Escape, a click outside or
   choosing an item closes it. */
let ddOpen = null; // { menu, btn }
function ddHtml({ id, btn, items, right = false, btnClass = 'btn btn-ghost btn-sm', label = '' }) {
  return `<div class="dd"><button type="button" class="${btnClass}" aria-haspopup="true" aria-expanded="false" aria-controls="${id}" ${label ? `aria-label="${esc(label)}" title="${esc(label)}"` : ''} onclick="ddToggle('${id}', this)">${btn}</button>
    <div class="dd-menu ${right ? 'right' : ''} hidden" id="${id}">${items.filter(Boolean).map(ddItem).join('')}</div></div>`;
}
function ddItem(it) {
  if (it === 'sep') return '<div class="dd-sep"></div>';
  if (it.header) return `<div class="dd-label">${esc(it.header)}</div>`;
  const inner = `${it.icon || ''}<span>${esc(it.label)}</span>${it.note ? `<span class="dd-note">${esc(it.note)}</span>` : ''}`;
  if (it.href) return `<a class="dd-item ${it.danger ? 'danger' : ''}" href="${it.href}" data-link>${inner}</a>`;
  return `<button type="button" class="dd-item ${it.danger ? 'danger' : ''}" ${it.disabled ? 'disabled' : ''} onclick="ddClose();${it.onclick}">${inner}</button>`;
}
function ddToggle(id, btn) {
  const m = $(id);
  if (!m) return;
  const wasOpen = ddOpen?.menu === m;
  ddClose();
  if (wasOpen) return;
  m.classList.remove('hidden');
  btn.setAttribute('aria-expanded', 'true');
  ddOpen = { menu: m, btn };
  // Open upwards when there's no room below
  m.style.top = ''; m.style.bottom = '';
  const r = m.getBoundingClientRect();
  if (r.bottom > window.innerHeight - 8 && btn.getBoundingClientRect().top > r.height + 8) { m.style.top = 'auto'; m.style.bottom = 'calc(100% + 4px)'; }
}
function ddClose(focusButton = false) {
  if (!ddOpen) return;
  const { menu, btn } = ddOpen;
  ddOpen = null;
  menu.classList.add('hidden');
  btn.setAttribute('aria-expanded', 'false');
  if (focusButton) btn.focus();
}
const ddItems = m => [...m.querySelectorAll('.dd-item:not(:disabled), .cm-item, .cm-foot .btn')];
document.addEventListener('click', e => {
  if (ddOpen && !ddOpen.menu.parentElement.contains(e.target)) ddClose();
});
document.addEventListener('keydown', e => {
  if (!['ArrowDown', 'ArrowUp'].includes(e.key)) return;
  const btn = e.target.closest?.('[aria-haspopup="true"]');
  const menu = ddOpen?.menu;
  if (btn && !menu && e.key === 'ArrowDown') { e.preventDefault(); btn.click(); setTimeout(() => ddOpen && ddItems(ddOpen.menu)[0]?.focus(), 0); return; }
  if (!menu || !(menu.contains(e.target) || e.target === ddOpen.btn)) return;
  e.preventDefault();
  const list = ddItems(menu), i = list.indexOf(document.activeElement);
  const next = e.key === 'ArrowDown' ? list[(i + 1) % list.length] : list[(i - 1 + list.length) % list.length];
  next?.focus();
});
document.addEventListener('focusin', e => { if (ddOpen && !ddOpen.menu.parentElement.contains(e.target)) ddClose(); });

/* ---- course colours and pictures ----
   The server picks a colour for every class (the teacher can change it); the
   pattern comes from the class id, so each class looks the same everywhere. */
const COURSE_COLORS = ['teal', 'green', 'navy', 'violet', 'magenta', 'red', 'orange', 'gold', 'slate', 'forest'];
const COLOR_NAME = { teal: 'Teal', green: 'Green', navy: 'Navy', violet: 'Violet', magenta: 'Magenta', red: 'Red', orange: 'Orange', gold: 'Gold', slate: 'Slate', forest: 'Forest' };
const hashStr = s => { let h = 0; for (const ch of String(s || '')) h = (h * 31 + ch.charCodeAt(0)) | 0; return Math.abs(h); };
const courseColor = c => (COURSE_COLORS.includes(c?.color) ? c.color : COURSE_COLORS[hashStr(c?.id) % COURSE_COLORS.length]);
const coursePattern = c => hashStr(`${c?.id}:pattern`) % 6;
// "English 10 – Period 3" → "E10", "AP Biology" → "AB"
function courseInitials(name) {
  const words = String(name || '').split(/[\s\-–—:/,]+/).filter(w => /[\p{L}\p{N}]/u.test(w));
  if (!words.length) return '?';
  const first = [...words[0]].find(ch => /[\p{L}\p{N}]/u.test(ch)) || '';
  const second = words[1] ? (/^\d/.test(words[1]) ? words[1].match(/^\d{1,3}/)[0] : [...words[1]].find(ch => /[\p{L}]/u.test(ch)) || '') : '';
  return (first + second).toUpperCase();
}
// A class's teachers, owner first ([{ id, name, avatarColor, owner }]); older
// payloads only have `teacher`
const teachersOf = c => (c?.teachers?.length ? c.teachers : c?.teacher ? [{ ...c.teacher, owner: true }] : []);
const teacherNames = c => teachersOf(c).map(t => (t.id === me?.id ? 'You' : t.name)).join(', ');
// The banner: the class colour with its lens art, or a background the
// teachers chose (one of Visor's designs, or their own picture, centred at
// pos% down; the colour stays underneath while the picture loads)
const BG_NAME = { sunrise: 'Sunrise', ocean: 'Ocean', meadow: 'Meadow', night: 'Night sky', chalkboard: 'Chalkboard', blueprint: 'Blueprint', library: 'Library', aurora: 'Aurora' };
const courseArt = (c, extra = '', tag = 'div', attrs = '') => {
  const b = c?.background;
  const bg = b?.kind === 'preset' && BG_NAME[b.preset] ? ` has-bg bg-${b.preset}` : b?.kind === 'upload' && b.url ? ' has-bg bg-photo' : '';
  const style = bg === ' has-bg bg-photo' ? ` style="--bg-img:url('${esc(b.url)}');--bg-pos:${Math.min(100, Math.max(0, Number(b.pos) || 0))}%"` : '';
  return `<${tag} class="course-art cc-${courseColor(c)} pat-${coursePattern(c)}${bg} ${extra}"${style} ${attrs}><span class="course-initials" aria-hidden="true">${esc(courseInitials(c?.name))}</span></${tag}>`;
};

/* ---- signing out ----
   Every page keeps what it loaded (the class page draws a class it has seen
   straight away). On sign-out all of it goes, so nothing of one account is
   ever drawn for the next person to sign in on this tab. */
function resetPortal() {
  ddClose();
  cp = null; ap = null; af = null; upd = null; act = null; cal = null; coursesCache = null;
  updSeen.clear();
  home = { projectsOpen: null, data: null, view: 'dashboard', showArchived: false, upcoming: null };
  if ($('routeView')) $('routeView').innerHTML = '';
  if ($('coursesMenu')) $('coursesMenu').innerHTML = '';
}

/* ====================== the top bar's Classes menu ====================== */
let coursesCache = null; // { at, list }
const forgetCourses = () => { coursesCache = null; };
async function loadCourses(force = false) {
  if (!force && coursesCache && Date.now() - coursesCache.at < 20000) return coursesCache.list;
  const r = await api('/api/classes');
  coursesCache = { at: Date.now(), list: r.classes };
  return r.classes;
}
async function toggleCoursesMenu() {
  const btn = $('coursesBtn'), menu = $('coursesMenu');
  const opening = ddOpen?.menu !== menu;
  ddToggle('coursesMenu', btn);
  if (!opening) return;
  if (!coursesCache) menu.innerHTML = '<div class="cm-empty"><span class="spinner"></span></div>';
  else menu.innerHTML = coursesMenuHtml(coursesCache.list);
  try {
    const list = await loadCourses();
    if (ddOpen?.menu !== menu) return;
    const i = ddItems(menu).indexOf(document.activeElement);
    menu.innerHTML = coursesMenuHtml(list);
    if (i >= 0) ddItems(menu)[Math.min(i, ddItems(menu).length - 1)]?.focus();
  }
  catch (e) { menu.innerHTML = `<div class="cm-empty">${esc(e.message)}</div>`; }
}
function coursesMenuHtml(list) {
  const active = list.filter(c => !c.archived), archived = list.length - active.length;
  const teacher = me.role === 'teacher';
  return `<div class="cm-head"><b>My classes</b>${archived ? `<a class="tiny" href="/?archived=1" data-link onclick="ddClose()">Archived (${archived})</a>` : ''}</div>
    ${active.length ? `<div class="cm-grid">${active.map(c => `<a class="cm-item" href="/class/${c.id}" data-link onclick="ddClose()">${courseArt(c, 'cm-thumb')}<span class="cm-text"><span class="cm-name">${esc(c.name)}</span><span class="cm-sub">${c.isTeacher ? vcPlural(c.studentCount, 'student') + (teachersOf(c).length > 1 ? ` · ${vcPlural(teachersOf(c).length, 'teacher')}` : '') : esc(teacherNames(c))}</span></span></a>`).join('')}</div>`
      : `<div class="cm-empty">${archived ? 'All your classes are archived.' : teacher ? 'You haven’t made a class yet.' : 'You’re not in a class yet. Ask your teacher for the class code.'}</div>`}
    <div class="cm-foot">${teacher ? `<button class="btn btn-primary btn-sm" onclick="ddClose();openCreateClass()">${I.plusSm}Create class</button>` : `<button class="btn btn-primary btn-sm" onclick="ddClose();openJoinClass()">${I.plusSm}Join a class</button>`}
      <a class="btn btn-ghost btn-sm" href="/" data-link onclick="ddClose()">All classes</a></div>`;
}

/* ====================== home ====================== */
let home = { projectsOpen: null, data: null, view: 'dashboard', showArchived: false, upcoming: null };
const homeViewKey = () => `visor.homeView.${me?.id || ''}`;

VisorRouter.add('/', async (el, params, query) => {
  let saved = null;
  try { saved = localStorage.getItem(homeViewKey()); } catch {}
  home.view = query.get('view') || saved || 'dashboard';
  if (!['dashboard', 'activity'].includes(home.view)) home.view = 'dashboard';
  home.showArchived = query.get('archived') === '1';
  el.innerHTML = `<div class="portal"><div class="loading-row"><span class="spinner"></span></div></div>`;
  const mine = VisorRouter.seq();
  const [cls, dash, projs] = await Promise.all([api('/api/classes'), api('/api/dashboard'), api('/api/projects')]);
  if (mine !== VisorRouter.seq()) return;
  coursesCache = { at: Date.now(), list: cls.classes };
  home.data = { classes: cls.classes, dash, projects: projs.projects };
  home.upcoming = null;
  renderHome();
  loadHomeUpcoming();
  const t = setInterval(async () => {
    // Keep "Happening now" fresh while the page is open
    if (me.role !== 'teacher' || document.hidden) return;
    try { const d = await api('/api/dashboard'); home.data.dash = d; const box = $('happeningBox'); if (box) box.outerHTML = happeningBoxHtml(d.happeningNow); } catch {}
  }, 20000);
  return () => clearInterval(t);
});

function homeView(view) {
  home.view = view;
  try { localStorage.setItem(homeViewKey(), view); } catch {}
  history.replaceState(null, '', view === 'dashboard' ? '/' : '/?view=activity');
  renderHome();
}

function renderHome() {
  const el = $('routeView');
  const teacher = me.role === 'teacher';
  const head = `<div class="home-head">
      <div class="tabs" role="tablist" aria-label="Home view">
        <button class="tab ${home.view === 'dashboard' ? 'active' : ''}" role="tab" aria-selected="${home.view === 'dashboard'}" onclick="homeView('dashboard')">Classes</button>
        <button class="tab ${home.view === 'activity' ? 'active' : ''}" role="tab" aria-selected="${home.view === 'activity'}" onclick="homeView('activity')">Activity</button>
      </div>
      <div class="head-actions">${teacher ? `<button class="btn btn-primary btn-sm" onclick="openCreateClass()">${I.plusSm}Create class</button>` : `<button class="btn btn-ghost btn-sm" onclick="openJoinClass()">${I.plusSm}Join a class</button>`}</div>
    </div>`;
  el.innerHTML = `<div class="portal"><div class="home-grid">
    <div class="home-main">${head}<div id="homeBody"></div></div>
    <aside class="home-right" aria-label="To do">${teacher ? teacherHomeRight() : studentHomeRight()}</aside>
  </div></div>`;
  if (home.view === 'activity' && window.renderActivity) renderActivity($('homeBody'), home.data.classes);
  else $('homeBody').innerHTML = dashboardHtml();
  if (!teacher) homeExtStatus();
}

function dashboardHtml() {
  const { classes: list, projects } = home.data;
  const teacher = me.role === 'teacher';
  const active = list.filter(c => !c.archived), archived = list.filter(c => c.archived);
  const newTile = teacher
    ? `<button class="ct-new" onclick="openCreateClass()">${I.plusSm}Create a class</button>`
    : `<button class="ct-new" onclick="openJoinClass()">${I.plusSm}Join a class</button>`;
  const empty = !active.length ? (archived.length
    ? `<div class="feed-empty" style="margin-bottom:18px;"><b>All your classes are archived</b>${teacher ? 'Restore one in its Settings, or create a new class.' : 'Join a class with the class code your teacher gives you.'}</div>`
    : `<div class="feed-empty" style="margin-bottom:18px;"><b>${teacher ? 'Create your first class' : 'You’re not in a class yet'}</b>${teacher ? 'A class holds your roster, its assignments (in-class essays, group projects and discussions, in folders if you like) and its announcements. You can share it with other teachers.' : 'Ask your teacher for the class code, then join with it.'}</div>`) : '';
  return `${empty}<div class="course-tiles">${active.map(courseTile).join('')}${newTile}</div>
    ${archived.length ? `<div class="home-more"><button class="btn btn-ghost btn-sm" aria-expanded="${home.showArchived}" onclick="home.showArchived=!home.showArchived;$('homeBody').innerHTML=dashboardHtml()">${home.showArchived ? 'Hide' : 'Show'} archived classes (${archived.length})</button></div>
      ${home.showArchived ? `<div class="course-tiles" style="margin-top:14px;">${archived.map(courseTile).join('')}</div>` : ''}` : ''}
    ${projectsSection(projects, list.length > 0)}`;
}

function courseTile(c) {
  const stats = c.isTeacher
    ? [c.activeSessions ? `<span class="live-dot-text"><i class="live-dot"></i>${c.activeSessions} writing now</span>` : '', c.toReview ? `<span><b>${c.toReview}</b> to review</span>` : '', `<span>${vcPlural(c.assignmentCount || 0, 'assignment')}</span>`]
    : [c.upcoming?.[0] ? `<span>Next: <b>${esc(c.upcoming[0].title)}</b> · ${esc(vcDate(c.upcoming[0].dueAt))}</span>` : `<span>${vcPlural(c.assignmentCount || 0, 'assignment')}</span>`];
  return `<a class="course-tile cc-${courseColor(c)} ${c.archived ? 'archived' : ''}" href="/class/${c.id}" data-link>
    ${courseArt(c)}${courseMono(c)}
    ${c.archived ? '<span class="pill pill-gray ct-flag">Archived</span>' : ''}
    <span class="ct-body"><span class="ct-name">${esc(c.name)}</span><span class="ct-sub">${c.isTeacher ? vcPlural(c.studentCount, 'student') + (teachersOf(c).length > 1 ? ` · ${vcPlural(teachersOf(c).length, 'teacher')}` : '') : esc(teacherNames(c))}</span>
      <span class="ct-stats">${stats.filter(Boolean).join('')}</span></span>
  </a>`;
}

function projectsSection(projects, collapsedByDefault) {
  const list = projects.filter(p => !p.classId);
  if (!list.length && me.role !== 'teacher') return '';
  if (home.projectsOpen === null) home.projectsOpen = !collapsedByDefault;
  const body = list.length
    ? `<div class="stack" style="gap:8px;">${list.map(p => `<a class="card card-hover row-link" href="/project/${p.id}" data-link><b>${esc(p.name)}</b><span class="muted small">${vcPlural(p.students?.length || 0, 'student')} · ${vcPlural(p.resourceCount || 0, 'resource')}</span></a>`).join('')}</div>`
    : `<div class="muted small">No projects outside your classes.</div>`;
  return `<section class="home-section">
    <div class="card collapse ${home.projectsOpen ? 'open' : ''}" id="homeProjects">
      <div class="ch" role="button" tabindex="0" aria-expanded="${home.projectsOpen}" onclick="toggleHomeProjects()" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleHomeProjects();}">${I.chev}<b style="flex:1;">Projects outside classes</b><span class="muted small">${list.length}</span>
        ${me.role === 'teacher' ? `<button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();openNewProject()">${I.plusSm}New project</button>` : ''}</div>
      <div class="cb">${body}</div>
    </div></section>`;
}
function toggleHomeProjects() {
  home.projectsOpen = !home.projectsOpen;
  const el = $('homeProjects'); el.classList.toggle('open', home.projectsOpen);
  el.querySelector('.ch').setAttribute('aria-expanded', home.projectsOpen);
}

/* ---- Home's right-hand column ---- */
function teacherHomeRight() {
  const d = home.data.dash;
  const review = d.needsReview || [];
  return `${happeningBoxHtml(d.happeningNow)}
    <section class="side-box"><div class="side-box-h"><span>${I.check}To review</span>${review.length ? `<span>${review.length}</span>` : ''}</div>
      ${review.length ? `<div class="side-box-b">${review.slice(0, 6).map(r => `<a class="ev-row" href="/review/${r.docId}" data-link><span class="ev-main"><span class="ev-title">${esc(r.student)}</span><span class="ev-meta">${esc(r.title)} · ${esc(r.className)} · ${esc(timeAgo(r.submittedAt))}</span></span></a>`).join('')}
        ${review.length > 6 ? `<div class="side-empty">and ${review.length - 6} more: see each assignment’s Submissions.</div>` : ''}</div>`
        : `<div class="side-empty">Nothing waiting. Submitted work shows up here until you return it.</div>`}</section>
    <section class="side-box" id="upcomingBox">${upcomingBoxInner()}</section>`;
}
function happeningBoxHtml(list) {
  if (!list?.length) return '<div id="happeningBox"></div>';
  return `<section class="side-box" id="happeningBox"><div class="side-box-h live"><span><i class="live-dot"></i> Live now</span></div><div class="side-box-b">
    ${list.map(h => `<a class="ev-row" href="/a/${h.assignmentId}?tab=live" data-link><span class="ev-main"><span class="ev-title">${esc(h.title)}</span><span class="ev-meta">${esc(h.className)} · ${h.live} of ${h.students} writing</span></span></a>`).join('')}</div></section>`;
}
function studentHomeRight() {
  const todo = home.data.dash.todo || [];
  const overdue = todo.filter(t => t.type === 'writing' && isOverdue(t.dueAt, t.status)).sort((a, b) => (a.dueAt < b.dueAt ? -1 : 1));
  return `<section class="side-box"><div class="side-box-h"><span>${I.puzzle}Visor extension</span></div><div class="side-box-p" id="homeExt"><span class="muted small">Checking…</span></div></section>
    ${overdue.length ? `<section class="side-box"><div class="side-box-h red"><span>${I.alert}Overdue</span><span>${overdue.length}</span></div><div class="side-box-b">
      ${overdue.map(t => `<a class="ev-row" href="/a/${t.assignmentId}" data-link><span class="ev-main"><span class="ev-title">${esc(t.title)}</span><span class="ev-meta red">${esc(vcDue(t.dueAt))}</span><span class="ev-meta">${esc(t.className)} · ${esc(STATUS_LABEL[t.status] || '')}</span></span></a>`).join('')}</div></section>` : ''}
    <section class="side-box" id="upcomingBox">${upcomingBoxInner()}</section>`;
}
async function homeExtStatus() {
  const box = $('homeExt');
  if (!box || !window.VisorExt) return;
  const p = await VisorExt.ping();
  if (!$('homeExt')) return;
  const ok = p.installed && p.connected && p.user?.id === me.id;
  box.innerHTML = ok ? `<div class="ext-line ok">${I.check}Connected to your account</div><div class="tiny muted" style="margin-top:4px;">Ready for locked sessions and one-click citations.</div>`
    : `<div class="ext-line">${I.puzzle}${p.installed ? 'Installed, not connected' : 'Not installed'}</div><div class="tiny muted" style="margin:4px 0 10px;">Some writing sessions need the Visor Chrome extension.</div><a class="btn btn-ghost btn-sm" href="/extension/connect" data-link>${p.installed ? 'Connect it' : 'Set it up'}</a>`;
}

// Upcoming: the next two weeks from the calendar (due dates, discussions,
// writing windows), across every class
async function loadHomeUpcoming() {
  const from = new Date(), to = new Date(Date.now() + 14 * 864e5);
  try { home.upcoming = (await api(`/api/calendar?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`)).events; }
  catch { home.upcoming = []; }
  const box = $('upcomingBox');
  if (box) box.innerHTML = upcomingBoxInner();
}
function upcomingBoxInner() {
  const head = `<div class="side-box-h"><span>${PI.cal}Coming up</span><a href="/calendar" data-link>Calendar</a></div>`;
  if (home.upcoming === null) return `${head}<div class="side-empty"><span class="spinner"></span></div>`;
  const list = home.upcoming.filter(e => me.role === 'teacher' || !isDone(e.status));
  if (!list.length) return `${head}<div class="side-empty">Nothing due in the next two weeks.</div>`;
  return `${head}<div class="side-box-b">${eventsByDayHtml(list.slice(0, 12), { showClass: true })}</div>`;
}

const EVENT_KIND = { due: 'Due', discussion: 'Discussion', opens: 'Writing opens', closes: 'Writing closes' };
// Events grouped under "Today", "Tomorrow", "Thursday, October 16"…
function eventsByDayHtml(events, { showClass = false } = {}) {
  let out = '', day = '';
  for (const ev of events) {
    const k = vcDayKey(ev.at);
    if (k !== day) { day = k; out += `<div class="ev-day">${esc(vcDayLabel(ev.at))}</div>`; }
    const overdue = ev.kind === 'due' && isOverdue(ev.at, ev.status);
    const meta = [`${EVENT_KIND[ev.kind] || ''} ${vcTime(ev.at)}`, showClass ? ev.className : '', ev.published === false ? 'Not published' : '', isDone(ev.status) ? STATUS_LABEL[ev.status] : ''].filter(Boolean);
    out += `<a class="ev-row cc-${esc(ev.color || 'slate')}" href="/a/${ev.assignmentId}" data-link><span class="ev-dot"></span><span class="ev-main"><span class="ev-title">${esc(ev.title)}</span><span class="ev-meta ${overdue ? 'red' : ''}">${esc(meta.join(' · '))}</span></span></a>`;
  }
  return out;
}

/* ---- create and join ---- */
function openCreateClass() {
  openModal({ title: 'Create a class', sub: 'Students join with its class code, or you add them by email. You can add other teachers later, under People.', body: `<div class="field"><label for="ncName">Class name</label><input id="ncName" class="input" placeholder="English 10 – Period 3" maxlength="120" /></div>`,
    footer: `<button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="createClass()">Create class</button>` });
  setTimeout(() => $('ncName')?.focus(), 50);
  $('ncName').addEventListener('keydown', e => { if (e.key === 'Enter') createClass(); });
}
async function createClass() {
  const name = $('ncName').value.trim();
  if (!name) return $('ncName').classList.add('error');
  await modalBusy(async () => {
    try { const r = await api('/api/classes', { method: 'POST', body: { name } }); forgetCourses(); closeModal(); VisorRouter.go(`/class/${r.class.id}?tab=people`); toast('Class created. Add your students.'); }
    catch (e) { toast(e.message, 'err'); }
  });
}

function openJoinClass() {
  openModal({ title: 'Join a class', sub: 'Type the 6-character class code your teacher gave you.', body: `<div class="field"><label for="jcCode">Class code</label><input id="jcCode" class="input mono" maxlength="6" autocomplete="off" style="text-transform:uppercase;font-size:20px;letter-spacing:.2em;" /></div><div id="jcErr" class="form-error hidden"></div>`,
    footer: `<button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="joinClass()">Join</button>` });
  setTimeout(() => $('jcCode')?.focus(), 50);
  $('jcCode').addEventListener('keydown', e => { if (e.key === 'Enter') joinClass(); });
}
async function joinClass() {
  await modalBusy(async () => {
    try { const r = await api('/api/classes/join', { method: 'POST', body: { code: $('jcCode').value } }); forgetCourses(); closeModal(); toast(`You joined ${r.class.name}`); VisorRouter.go(`/class/${r.class.id}`); }
    catch (e) { formError('jcErr', e.message); }
  });
}

/* ====================== the course frame ======================
   Visor's "lens" layout: the class's cover (its banner, with a frosted panel
   holding its monogram, name and teachers), pill tabs for its pages, then the
   page with an optional right-hand column. The assignment page uses the
   compact form: one bar with the monogram, the class name and the tabs. */
function courseFrame(c, { active = '', main = '', right = '', compact = false }) {
  return `<div class="course cc-${courseColor(c)} ${right ? '' : 'no-right'}${compact ? ' compact' : ''}">
    ${compact ? courseBarHtml(c, active) : courseHeroHtml(c, active)}
    <div class="course-body">
      <div class="course-main">${main}</div>
      ${right ? `<aside class="course-right">${right}</aside>` : ''}
    </div>
  </div>`;
}
// The class's pages, as pill tabs
function courseTabsHtml(c, active) {
  const teachers = teachersOf(c);
  const link = (key, href, icon, label, count) => `<a href="${href}" data-link class="${active === key ? 'active' : ''}" ${active === key ? 'aria-current="page"' : ''}>${icon}<span>${label}</span>${count != null ? `<span class="count">${count}</span>` : ''}</a>`;
  return `<nav class="course-tabs" aria-label="Class pages">
      ${link('materials', `/class/${c.id}`, PI.list, 'Assignments')}
      ${link('updates', `/class/${c.id}?tab=announcements`, PI.megaphone, 'Announcements')}
      ${c.isTeacher ? link('members', `/class/${c.id}?tab=people`, I.users, 'People', (c.studentCount ?? c.students?.length ?? 0) + teachers.length) : ''}
      ${c.archived ? '' : link('calendar', `/calendar?class=${c.id}`, PI.cal, 'Calendar')}
      ${c.isTeacher ? link('settings', `/class/${c.id}?tab=settings`, I.gear, 'Settings') : ''}
    </nav>`;
}
// The monogram: the class's initials in a ring of its colour (the lens)
const courseMono = (c, size = '') => `<span class="course-mono ${size}" aria-hidden="true">${esc(courseInitials(c?.name))}</span>`;
function courseHeroHtml(c, active) {
  const teachers = teachersOf(c);
  const who = c.isTeacher
    ? `${vcPlural(c.studentCount ?? c.students?.length ?? 0, 'student')} · ${teachers.length > 1 ? 'Teachers' : 'Teacher'}: ${esc(teacherNames(c))}`
    : `${teachers.length > 1 ? 'Teachers' : 'Teacher'}: ${esc(teacherNames(c))}`;
  // A teacher's way to bring people in: their school's list, or the class code
  const invite = !c.isTeacher || c.archived ? ''
    : me?.org ? `<button type="button" class="glass-btn" onclick="openAddFromSchool('${c.id}')">${I.users}<span>Add people</span></button>`
      : c.joinCode ? `<button type="button" class="glass-btn code" onclick="copyText('${esc(c.joinCode)}','Class code copied')" title="${c.joinOpen === false ? 'Joining with the code is closed' : 'Students join with this code. Click to copy it.'}"><span class="glass-k">Class code</span><span class="mono">${esc(c.joinCode)}</span>${I.copy}</button>` : '';
  return `<header class="course-hero">
      ${courseArt(c, 'course-cover')}
      <div class="course-hero-tools">${invite}${c.isTeacher ? `<button type="button" class="glass-btn icon" onclick="openClassBanner('${c.id}')" aria-label="Change the banner" title="Change the banner">${I.edit}</button>` : ''}</div>
      <div class="course-glass">
        ${courseMono(c, 'lg')}
        <div class="course-glass-text"><div class="course-name">${esc(c.name)}${c.archived ? ' <span class="pill pill-gray">Archived</span>' : ''}</div>
          <div class="course-who">${avatarStack(teachers)}<span>${who}</span></div></div>
      </div>
    </header>
    ${courseTabsHtml(c, active)}`;
}
function courseBarHtml(c, active) {
  return `<header class="course-bar">
      <a class="course-bar-id" href="/class/${c.id}" data-link>${courseMono(c)}<span class="course-bar-name">${esc(c.name)}</span></a>
      ${courseTabsHtml(c, active)}
    </header>`;
}
const avatarStack = list => `<span class="avatar-stack" aria-hidden="true">${list.slice(0, 4).map(t => avatarHtml(t, 'avatar-xs')).join('')}</span>`;

// The sidebar's pencil (and Settings): the class's banner. A background (the
// class colour, one of Visor's designs, or a picture) and the colour, which
// also marks the class's calendar events and stays under any picture.
let bn = null; // { classId, c, color, bg: { kind: 'none'|'preset'|'upload'|'file', preset, pos, url, blob } }
function openClassBanner(classId) {
  const c = cp?.cls?.id === classId ? cp.cls : ap?.data?.class?.id === classId ? ap.data.class : null;
  if (!c) return;
  const b = c.background;
  bn = { classId, c, color: courseColor(c), bg: b?.kind === 'preset' ? { kind: 'preset', preset: b.preset } : b?.kind === 'upload' ? { kind: 'upload', url: b.url, pos: b.pos ?? 50 } : { kind: 'none' } };
  bn.was = JSON.stringify([bn.color, bn.bg]);
  const tile = (key, label, art) => `<button type="button" role="radio" class="bn-tile" data-bg="${key}" aria-checked="false" aria-label="${esc(label)}">${art}<span class="bn-name">${esc(label)}</span></button>`;
  openModal({ title: 'Class banner', sub: 'Everyone in the class sees it: on the class page, its tile on Home and the Classes menu.', wide: true,
    body: `<div class="bn-preview" id="bnPreview"></div>
      <div class="bn-k" id="bnBgLabel">Background</div>
      <div class="bn-grid" role="radiogroup" aria-labelledby="bnBgLabel" id="bnGrid">
        ${tile('none', 'Class colour', courseArt({ ...c, background: null, color: bn.color }, 'bn-art'))}
        ${Object.entries(BG_NAME).map(([k, l]) => tile(k, l, courseArt({ ...c, background: { kind: 'preset', preset: k } }, 'bn-art'))).join('')}
        <span id="bnPhotoTile"></span>
        <button type="button" class="bn-tile bn-upload" id="bnUpload">${I.upload}<span class="bn-name">Upload a picture</span></button>
        <input type="file" id="bnFile" accept="image/png,image/jpeg,image/webp" hidden />
      </div>
      <div class="bn-pos" id="bnPosWrap"><div class="bn-pos-in"><div class="bn-pos-pad">
        <label for="bnPos" class="bn-k" style="margin:0;">Picture position</label>
        <div class="bn-pos-row"><span class="tiny muted">Top</span><input type="range" id="bnPos" min="0" max="100" step="1" /><span class="tiny muted">Bottom</span></div>
        <div class="hint">Choose which part of the picture shows. Wide pictures (about 3 to 1) fit best.</div>
      </div></div></div>
      <div class="bn-k" id="bnColorLabel">Colour <span class="label-note">also marks the class on the calendar</span></div>
      ${swatchesHtml('bnColor', bn.color, false)}
      <div id="bnErr" class="form-error hidden"></div>`,
    footer: `<button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-primary" id="bnSave">Save</button>` });
  wireSwatches('bnColor', v => { bn.color = v; bnPaint(); });
  $('bnGrid').addEventListener('click', e => {
    const t = e.target.closest('[data-bg]'); if (!t) return;
    const k = t.dataset.bg;
    bn.bg = k === 'none' ? { kind: 'none' } : k === 'photo' ? bn.photo : { kind: 'preset', preset: k };
    bnPaint();
  });
  // Arrow keys move through the backgrounds, as in any radio group
  $('bnGrid').addEventListener('keydown', e => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key) || !e.target.matches('[data-bg]')) return;
    e.preventDefault();
    const all = [...$('bnGrid').querySelectorAll('[data-bg]')], i = all.indexOf(e.target);
    const n = all[(i + (['ArrowRight', 'ArrowDown'].includes(e.key) ? 1 : -1) + all.length) % all.length];
    n.click(); n.focus();
  });
  $('bnUpload').onclick = () => $('bnFile').click();
  $('bnFile').onchange = () => { const f = $('bnFile').files[0]; $('bnFile').value = ''; if (f) bnPickFile(f); };
  $('bnPos').addEventListener('input', e => { if (bn.bg.kind === 'upload' || bn.bg.kind === 'file') { bn.bg.pos = Number(e.target.value); bnPaint(true); } });
  $('bnSave').onclick = () => modalBusy(bnSave);
  // A picture already there gets its own tile
  if (bn.bg.kind === 'upload') bn.photo = bn.bg;
  bnPaint();
}
// Redraw the preview and the choices (light: just the picture's position, while dragging)
function bnPaint(light) {
  const b = bn.bg;
  const shown = { ...bn.c, color: bn.color, background: b.kind === 'none' ? null : b.kind === 'preset' ? b : { kind: 'upload', url: b.url, pos: b.pos } };
  if (light) { [$('bnPreview').firstElementChild, $('bnGrid').querySelector('[data-bg="photo"] .course-art')].forEach(art => art?.style.setProperty('--bg-pos', `${b.pos}%`)); return; }
  $('bnPreview').innerHTML = courseArt(shown, 'bn-big') + `<div class="bn-cap"><b>${esc(bn.c.name)}</b><span>${esc(b.kind === 'none' ? 'Class colour' : b.kind === 'preset' ? BG_NAME[b.preset] : 'Your picture')}</span></div>`;
  $('bnPhotoTile').outerHTML = bn.photo ? `<button type="button" role="radio" class="bn-tile" data-bg="photo" id="bnPhotoTile" aria-checked="false" aria-label="Your picture">${courseArt({ ...bn.c, background: { kind: 'upload', url: bn.photo.url, pos: bn.photo.pos } }, 'bn-art')}<span class="bn-name">Your picture</span></button>` : '<span id="bnPhotoTile"></span>';
  // The colour tile follows the colour picked
  const none = $('bnGrid').querySelector('[data-bg="none"] .course-art');
  if (none) none.outerHTML = courseArt({ ...bn.c, background: null, color: bn.color }, 'bn-art');
  const key = b.kind === 'none' ? 'none' : b.kind === 'preset' ? b.preset : 'photo';
  $('bnGrid').querySelectorAll('[data-bg]').forEach(t => { const on = t.dataset.bg === key; t.setAttribute('aria-checked', String(on)); t.tabIndex = on ? 0 : -1; });
  const photo = b.kind === 'upload' || b.kind === 'file';
  $('bnPosWrap').classList.toggle('open', photo);
  $('bnPosWrap').querySelector('.bn-pos-in').toggleAttribute('inert', !photo);
  if (photo) $('bnPos').value = b.pos ?? 50;
}
// A picture from the computer: checked and shrunk here (at most 2000 pixels
// wide, as a JPEG), and only uploaded on Save
async function bnPickFile(file) {
  formError('bnErr', '');
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) return formError('bnErr', 'Use a PNG, JPEG or WebP picture.');
  if (file.size > 30 * 1024 * 1024) return formError('bnErr', 'That picture is too large. Use one under 30 MB.');
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 2000 / bmp.width, 1400 / bmp.height);
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(bmp.width * scale)); cv.height = Math.max(1, Math.round(bmp.height * scale));
    const g = cv.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height); // (transparent PNGs on white)
    g.drawImage(bmp, 0, 0, cv.width, cv.height);
    bmp.close?.();
    const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.86));
    if (!blob) throw new Error('shrink failed');
    if (bn.photo?.kind === 'file') URL.revokeObjectURL(bn.photo.url);
    bn.photo = { kind: 'file', blob, url: URL.createObjectURL(blob), pos: 50 };
    bn.bg = bn.photo;
    bnPaint();
  } catch { formError('bnErr', 'Visor couldn’t read that picture. Try another one.'); }
}
async function bnSave() {
  const { classId, c, bg } = bn;
  if (JSON.stringify([bn.color, bg]) === bn.was) { closeModal(); return; }
  const before = c.background;
  try {
    if (bn.color !== courseColor(c)) await api(`/api/classes/${classId}`, { method: 'PATCH', body: { color: bn.color } });
    if (bg.kind === 'none' && before) await api(`/api/classes/${classId}/background`, { method: 'DELETE' });
    if (bg.kind === 'preset' && !(before?.kind === 'preset' && before.preset === bg.preset)) await api(`/api/classes/${classId}/background`, { method: 'PUT', body: { preset: bg.preset } });
    if (bg.kind === 'file') {
      const r = await fetch(`/api/classes/${classId}/background`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: bg.blob });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `Upload failed (${r.status})`);
      if (bg.pos !== 50) await api(`/api/classes/${classId}/background`, { method: 'PUT', body: { pos: bg.pos } });
    }
    if (bg.kind === 'upload' && before?.kind === 'upload' && bg.pos !== before.pos) await api(`/api/classes/${classId}/background`, { method: 'PUT', body: { pos: bg.pos } });
    if (bn.photo?.kind === 'file') URL.revokeObjectURL(bn.photo.url);
    closeModal(); forgetCourses(); toast('Banner saved');
    VisorRouter.render();
  } catch (e) { formError('bnErr', e.message); }
}
// A row of colour buttons (radio group). withNone adds "no colour" first.
function swatchesHtml(id, current, withNone) {
  const opts = [...(withNone ? [null] : []), ...COURSE_COLORS];
  return `<div class="swatches" role="radiogroup" aria-label="Colour" id="${id}">${opts.map(k => `<button type="button" role="radio" class="swatch ${k ? 'cc-' + k : 'none'}" data-v="${k || ''}" aria-checked="${(current || null) === k}" aria-label="${k ? COLOR_NAME[k] : 'No colour'}" title="${k ? COLOR_NAME[k] : 'No colour'}">${I.check}</button>`).join('')}</div>`;
}
function wireSwatches(id, onPick) {
  const box = $(id);
  box.querySelectorAll('.swatch').forEach(b => b.addEventListener('click', () => {
    box.querySelectorAll('.swatch').forEach(x => x.setAttribute('aria-checked', String(x === b)));
    onPick(b.dataset.v || null);
  }));
}

/* ====================== class page ======================
   /class/:id                    Assignments (the top level)
   /class/:id?folder=<id>        a folder
   /class/:id?tab=announcements  Announcements (updates.js)
   /class/:id?tab=people         People: teachers and students (teacher)
   /class/:id?tab=settings       Settings (teacher)
   (The older names ?tab=updates, members and students still work.) */
let cp = null; // { cls, assignments, folders, tab, folder }

VisorRouter.add('/class/:id', async (el, { id }, query) => {
  // Inside, the pages keep their first names: materials, updates, members
  let tab = { assignments: 'materials', announcements: 'updates', people: 'members', students: 'members' }[query.get('tab')] || query.get('tab') || 'materials';
  const folder = tab === 'materials' ? query.get('folder') || null : null;
  // Same class as last time: draw it straight away, then refresh
  const cached = cp?.cls?.id === id;
  if (cached) { cp.tab = tab; cp.folder = folder; renderClassPage(); }
  else el.innerHTML = `<div class="portal"><div class="loading-row"><span class="spinner"></span></div></div>`;
  const before = cached ? classSnapshot() : null;
  const mine = VisorRouter.seq();
  const r = await api(`/api/classes/${id}`);
  if (mine !== VisorRouter.seq()) return; // left while it loaded
  setClass(r, tab, folder);
  if (!cached || classSnapshot() !== before) renderClassPage();
});

const classSnapshot = () => JSON.stringify([cp.cls, cp.assignments, cp.folders]);
function setClass(r, tab, folder) {
  cp = { cls: r.class, assignments: r.assignments || [], folders: r.folders || [], tab, folder };
  if (!cp.cls.isTeacher && !['materials', 'updates'].includes(cp.tab)) {
    cp.tab = 'materials';
    if (location.pathname === `/class/${cp.cls.id}`) history.replaceState(null, '', `/class/${cp.cls.id}`);
  }
}
async function loadClass(id, tab, folder) { setClass(await api(`/api/classes/${id}`), tab, folder); }
// After a change on the page: reload the class and draw it again, in the
// same place (unless the person has moved on in the meantime)
async function refreshClass() {
  if (!cp) return;
  const id = cp.cls.id, mine = VisorRouter.seq();
  let r;
  try { r = await api(`/api/classes/${id}`); } catch (e) { toast(e.message, 'err'); return; }
  if (mine !== VisorRouter.seq() || cp?.cls?.id !== id) return;
  setClass(r, cp.tab, cp.folder);
  if (location.pathname === `/class/${id}`) renderClassPage();
}

function renderClassPage() {
  const c = cp.cls;
  if (cp.folder && !cp.folders.some(f => f.id === cp.folder)) {
    // The folder is gone (deleted, or not visible): back to the top
    cp.folder = null;
    history.replaceState(null, '', `/class/${c.id}`);
  }
  const tab = cp.tab;
  let main = '', right = '';
  if (tab === 'members' && c.isTeacher) main = membersHtml();
  else if (tab === 'settings' && c.isTeacher) main = classSettingsHtml();
  else if (tab === 'updates') { main = `${courseHead(c, 'Announcements')}<div id="classUpdates"></div>`; right = classRightHtml(); }
  else { main = materialsHtml(); right = classRightHtml(); }
  $('routeView').innerHTML = courseFrame(c, { active: tab === 'updates' || tab === 'members' || tab === 'settings' ? tab : 'materials', main, right });
  if (tab === 'updates' && window.renderClassUpdates) renderClassUpdates($('classUpdates'), c);
  if (tab === 'materials' && c.isTeacher) wireMaterialsDnD();
}

// The heading at the top of a course page: the course (or a folder in it)
function courseHead(c, title, { trail = [], actions = '', sub = '' } = {}) {
  return `<header class="course-head"><div style="min-width:0;flex:1;">
      ${trail.length ? crumbs([...trail, [title]]) : ''}
      <h1>${esc(title)}</h1>${sub ? `<div class="course-sub">${sub}</div>` : ''}</div>
    ${actions ? `<div class="head-actions">${actions}</div>` : ''}</header>`;
}

/* ---- the right-hand column on a course page ---- */
function classRightHtml() {
  const c = cp.cls, list = cp.assignments;
  const now = Date.now(), soon = now + 21 * 864e5;
  const events = [];
  for (const a of list) {
    if (!a.publishedAt && !c.isTeacher) continue;
    const base = { assignmentId: a.id, title: a.title, type: a.type, color: courseColor(c), published: !!a.publishedAt, status: a.status || null };
    if (a.dueAt) events.push({ ...base, kind: 'due', at: a.dueAt });
    if (a.discussionDate) events.push({ ...base, kind: 'discussion', at: a.discussionDate });
  }
  const upcoming = events.filter(e => Date.parse(e.at) >= now && Date.parse(e.at) < soon && (c.isTeacher || !isDone(e.status))).sort((a, b) => (a.at < b.at ? -1 : 1));
  const upBox = `<section class="side-box"><div class="side-box-h"><span>${PI.cal}Coming up</span>${c.archived ? '' : `<a href="/calendar?class=${c.id}" data-link>Calendar</a>`}</div>
    ${upcoming.length ? `<div class="side-box-b">${eventsByDayHtml(upcoming.slice(0, 10))}</div>` : '<div class="side-empty">Nothing due in the next three weeks.</div>'}</section>`;
  if (!c.isTeacher) {
    const overdue = list.filter(a => a.type === 'writing' && isOverdue(a.dueAt, a.status || 'not-started'));
    return `${overdue.length ? `<section class="side-box"><div class="side-box-h red"><span>${I.alert}Overdue</span><span>${overdue.length}</span></div><div class="side-box-b">
      ${overdue.map(a => `<a class="ev-row" href="/a/${a.id}" data-link><span class="ev-main"><span class="ev-title">${esc(a.title)}</span><span class="ev-meta red">${esc(vcDue(a.dueAt))}</span></span></a>`).join('')}</div></section>` : ''}${upBox}`;
  }
  const live = list.filter(a => a.stats?.live);
  const review = list.filter(a => a.stats?.submitted);
  return `${live.length ? `<section class="side-box"><div class="side-box-h live"><span><i class="live-dot"></i> Live now</span></div><div class="side-box-b">
      ${live.map(a => `<a class="ev-row" href="/a/${a.id}?tab=live" data-link><span class="ev-main"><span class="ev-title">${esc(a.title)}</span><span class="ev-meta">${a.stats.live} of ${c.studentCount} writing</span></span></a>`).join('')}</div></section>` : ''}
    <section class="side-box"><div class="side-box-h"><span>${I.check}To review</span></div>
      ${review.length ? `<div class="side-box-b">${review.map(a => `<a class="side-stat" href="/a/${a.id}?tab=submissions" data-link><span>${esc(a.title)}</span><b>${a.stats.submitted}</b></a>`).join('')}</div>` : '<div class="side-empty">Nothing waiting for you.</div>'}</section>
    ${upBox}`;
}

/* ====================== materials ====================== */
// Where an item sits in its level: the teacher's order, else newest first
// (the same rule as lib/materials.js)
const matPos = x => (Number.isFinite(x.position) ? x.position : -Date.parse(x.createdAt) / 1000);
function levelItems(folderId) {
  const fid = folderId || null;
  const items = [
    ...cp.folders.filter(f => (f.parentId || null) === fid).map(f => ({ kind: 'folder', id: f.id, x: f })),
    ...cp.assignments.filter(a => (a.folderId || null) === fid).map(a => ({ kind: 'assignment', id: a.id, x: a }))
  ];
  return items.sort((p, q) => matPos(p.x) - matPos(q.x) || (p.x.createdAt < q.x.createdAt ? 1 : p.x.createdAt > q.x.createdAt ? -1 : 0) || (p.id < q.id ? -1 : 1));
}
const folderById = id => cp.folders.find(f => f.id === id) || null;
// The folders from the top down to this one
function folderTrail(id) {
  const out = [];
  for (let f = folderById(id), guard = 0; f && guard < 10; f = folderById(f.parentId), guard++) out.unshift(f);
  return out;
}
const folderDepth = id => folderTrail(id).length; // top level = 0
function folderHeight(id) { // 1 for a folder with no folders inside
  const kids = cp.folders.filter(f => f.parentId === id);
  return 1 + (kids.length ? Math.max(...kids.map(k => folderHeight(k.id))) : 0);
}
const inSubtree = (id, rootId) => folderTrail(id).some(f => f.id === rootId);

function materialsHtml() {
  const c = cp.cls, fid = cp.folder;
  const folder = fid ? folderById(fid) : null;
  const trail = folder ? folderTrail(fid) : [];
  const items = levelItems(fid);
  const addMenu = c.isTeacher ? ddHtml({ id: 'addMat', btnClass: 'btn btn-primary btn-sm', btn: `${I.plusSm}New ${PI.down}`, right: true, items: [
    { header: folder ? `New in ${folder.name}` : 'New in this class' },
    { label: 'Writing assignment', icon: I.edit, onclick: `openAssignmentForm('${c.id}','writing',null,{folderId:${fid ? `'${fid}'` : 'null'}})` },
    { label: 'Group project', icon: I.users, onclick: `openAssignmentForm('${c.id}','group',null,{folderId:${fid ? `'${fid}'` : 'null'}})` },
    { label: 'Discussion', icon: I.chat, onclick: `openAssignmentForm('${c.id}','discussion',null,{folderId:${fid ? `'${fid}'` : 'null'}})` },
    'sep',
    { label: 'Folder', icon: PI.folderPlus, onclick: 'openFolderForm()', disabled: folderDepth(fid) >= 3, note: folderDepth(fid) >= 3 ? '3 deep at most' : '' }
  ] }) : '';
  const head = folder
    ? `<header class="course-head"><div style="min-width:0;flex:1;">${crumbsDrop([['Assignments', `/class/${c.id}`, ''], ...trail.slice(0, -1).map(f => [f.name, `/class/${c.id}?folder=${f.id}`, f.id]), [folder.name]])}
        <h1><span class="mat-ic t-folder ${folder.color ? 'fc-' + folder.color : ''}" style="width:auto;height:auto;vertical-align:-5px;margin-right:6px;" aria-hidden="true">${PI.folder}</span>${esc(folder.name)}</h1></div>
        <div class="head-actions">${c.isTeacher ? folderMenuHtml(folder, 'Head') : ''}${addMenu}</div></header>`
    : `<header class="course-head"><div style="min-width:0;flex:1;"><h1>Assignments</h1><div class="course-sub">${vcPlural(cp.assignments.filter(a => c.isTeacher || a.publishedAt).length, 'assignment')}${c.isTeacher && cp.assignments.some(a => !a.publishedAt) ? ` (${cp.assignments.filter(a => !a.publishedAt).length} unpublished)` : ''}</div></div>
        ${addMenu ? `<div class="head-actions">${addMenu}</div>` : ''}</header>`;
  const desc = folder?.description ? `<div class="folder-desc">${esc(folder.description).replace(/\n/g, '<br>')}</div>` : '';
  const archived = c.archived ? `<div class="callout amber" style="margin-bottom:12px;">This class is archived. ${c.isTeacher ? 'Restore it in Settings to post announcements again.' : ''}</div>` : '';
  if (!items.length) {
    const msg = folder ? (c.isTeacher ? 'This folder is empty. Use New, or drag things onto it in the folder above.' : 'Nothing here yet.')
      : (c.isTeacher ? 'Use New for a writing assignment (an in-class essay or homework), a group project, a discussion, or a folder to keep units together.' : 'Your teacher hasn’t published anything here yet.');
    return `${head}${archived}${desc}<div class="mat-list"><div class="mat-empty"><b>${folder ? 'Empty folder' : 'No assignments yet'}</b>${msg}</div></div>`;
  }
  return `${head}${archived}${desc}<div class="mat-list" id="matList" role="list">${items.map(it => (it.kind === 'folder' ? folderRowHtml(it.x) : assignmentRowHtml(it.x))).join('')}</div>
    ${c.isTeacher && items.length > 1 ? '<div class="tiny muted mat-hint" style="margin-top:8px;">Drag the rows to reorder them, or drop one onto a folder (or onto a folder name above) to move it.</div>' : ''}`;
}
// Breadcrumbs whose folders accept dropped rows: [label, href, folderId ('' = top)]
function crumbsDrop(list) {
  return `<nav class="crumbs" aria-label="Breadcrumb">${list.map(([label, href, fid], i) => (href && i < list.length - 1 ? `<a href="${href}" data-link class="crumb-drop" data-drop-folder="${fid}">${esc(label)}</a>` : `<span aria-current="page">${esc(label)}</span>`)).join('<span class="sep" aria-hidden="true">/</span>')}</nav>`;
}

function folderRowHtml(f) {
  const c = cp.cls;
  const n = levelItems(f.id).length;
  return `<div class="mat-row mat-folder" role="listitem" data-kind="folder" data-id="${f.id}" ${c.isTeacher ? 'draggable="true"' : ''}>
    ${c.isTeacher ? `<span class="mat-grip" aria-hidden="true">${PI.grip}</span>` : ''}
    <span class="mat-ic t-folder ${f.color ? 'fc-' + f.color : ''}" aria-hidden="true">${PI.folder}</span>
    <div class="mat-body"><a class="mat-title" href="/class/${c.id}?folder=${f.id}" data-link draggable="false">${esc(f.name)}</a>
      <div class="mat-meta"><span>Folder · ${vcPlural(n, 'item')}</span>${f.description ? `<span>${esc(f.description.split('\n')[0].slice(0, 120))}</span>` : ''}</div></div>
    ${c.isTeacher ? `<div class="mat-side">${folderMenuHtml(f, 'Row')}</div>` : ''}
  </div>`;
}
function folderMenuHtml(f, where) {
  const items = levelItems(f.parentId), i = items.findIndex(x => x.id === f.id);
  return ddHtml({ id: `fm${where}-${f.id}`, btnClass: 'btn-icon', btn: I.gear, label: `Folder options: ${f.name}`, right: true, items: [
    { label: 'Edit folder', icon: I.edit, onclick: `openFolderForm('${f.id}')` },
    { label: 'Move to…', icon: PI.move, onclick: `openMoveModal('folder','${f.id}')` },
    where === 'Row' ? { label: 'Move up', icon: PI.up, onclick: `moveStep('folder','${f.id}',-1)`, disabled: i <= 0 } : null,
    where === 'Row' ? { label: 'Move down', icon: PI.down, onclick: `moveStep('folder','${f.id}',1)`, disabled: i >= items.length - 1 } : null,
    'sep',
    { label: 'Delete folder', icon: I.trash, onclick: `deleteFolder('${f.id}')`, danger: true }
  ] });
}

function assignmentRowHtml(a) {
  const c = cp.cls;
  const when = a.type === 'discussion' && a.discussionDate ? `Meets ${vcDateTime(a.discussionDate)}` : vcDue(a.dueAt);
  const status = !c.isTeacher && a.type === 'writing' ? a.status || 'not-started' : null;
  const overdue = status && isOverdue(a.dueAt, status);
  let side = '';
  if (c.isTeacher) {
    const s = a.stats;
    side = [!a.publishedAt ? '<span class="pill pill-gray">Not published</span>' : '',
      s?.live ? `<span class="mat-stat live-dot-text"><i class="live-dot"></i>${s.live} writing now</span>` : '',
      s?.submitted ? `<span class="mat-stat"><b>${s.submitted}</b> to review</span>` : '',
      s && a.publishedAt && c.studentCount ? `<span class="mat-progress" title="${s.submitted + s.returned} of ${c.studentCount} handed in"><i><b style="width:${Math.round(100 * Math.min(1, (s.submitted + s.returned) / c.studentCount))}%"></b></i>${s.submitted + s.returned}/${c.studentCount}</span>` : ''].filter(Boolean).join('');
  } else if (status) side = `${overdue ? '<span class="pill pill-red">Overdue</span>' : ''}${statusPillDoc(status)}`;
  return `<div class="mat-row ${a.publishedAt ? '' : 'is-draft'}" role="listitem" data-kind="assignment" data-id="${a.id}" ${c.isTeacher ? 'draggable="true"' : ''}>
    ${c.isTeacher ? `<span class="mat-grip" aria-hidden="true">${PI.grip}</span>` : ''}
    ${typeIcon(a.type)}
    <div class="mat-body"><a class="mat-title" href="/a/${a.id}" data-link draggable="false">${esc(a.title)}</a>
      <div class="mat-meta"><span>${esc(TYPE_LABEL[a.type] || '')}</span><span class="${overdue ? 'overdue' : ''}">${esc(when)}</span></div></div>
    ${side || c.isTeacher ? `<div class="mat-side">${side}${c.isTeacher ? assignmentMenuHtml(a) : ''}</div>` : ''}
  </div>`;
}
function assignmentMenuHtml(a) {
  const items = levelItems(a.folderId), i = items.findIndex(x => x.id === a.id);
  return ddHtml({ id: `am-${a.id}`, btnClass: 'btn-icon', btn: I.gear, label: `Options: ${a.title}`, right: true, items: [
    { label: 'Edit', icon: I.edit, onclick: `editAssignmentById('${a.id}')` },
    { label: a.publishedAt ? 'Unpublish' : 'Publish', icon: a.publishedAt ? PI.eyeOff : I.eye, onclick: `publishFromList('${a.id}', ${!a.publishedAt})` },
    { label: 'Move to…', icon: PI.move, onclick: `openMoveModal('assignment','${a.id}')` },
    { label: 'Move up', icon: PI.up, onclick: `moveStep('assignment','${a.id}',-1)`, disabled: i <= 0 },
    { label: 'Move down', icon: PI.down, onclick: `moveStep('assignment','${a.id}',1)`, disabled: i >= items.length - 1 },
    { label: 'Duplicate…', icon: I.copy, onclick: `openDuplicate('${a.id}')` },
    'sep',
    { label: 'Delete', icon: I.trash, onclick: `deleteAssignmentById('${a.id}')`, danger: true }
  ] });
}

/* ---- actions on the list ---- */
async function editAssignmentById(id) {
  try { const d = await api(`/api/assignments/${id}`); openAssignmentForm(d.class.id, d.assignment.type, d.assignment); }
  catch (e) { toast(e.message, 'err'); }
}
async function publishFromList(id, published) {
  try { await api(`/api/assignments/${id}/publish`, { method: 'POST', body: { published } }); toast(published ? 'Published. Students can see it now.' : 'Unpublished: students can’t see it now'); refreshClass(); }
  catch (e) { toast(e.message, 'err'); }
}
async function deleteAssignmentById(id) {
  const a = cp.assignments.find(x => x.id === id);
  if (!a) return;
  if (!await confirmModal('Delete this assignment?', `"${a.title}" and all student work, sessions and research${a.type === 'group' ? ', group projects' : ''}${a.type === 'discussion' ? ', recordings' : ''} in it will be deleted. This cannot be undone.`, { okLabel: 'Delete', danger: true })) return;
  try { await api(`/api/assignments/${id}`, { method: 'DELETE' }); toast('Assignment deleted'); refreshClass(); }
  catch (e) { toast(e.message, 'err'); }
}

// Move up/down one place in its level
function moveStep(kind, id, dir) {
  const parent = kind === 'folder' ? folderById(id)?.parentId : cp.assignments.find(a => a.id === id)?.folderId;
  const items = levelItems(parent);
  const i = items.findIndex(x => x.id === id), j = i + dir;
  if (i < 0 || j < 0 || j >= items.length) return;
  [items[i], items[j]] = [items[j], items[i]];
  saveOrder(parent || null, items);
}
// Save a level's order: shown at once, then sent; reloaded if it fails
async function saveOrder(folderId, items) {
  items.forEach((it, k) => { it.x.position = k; });
  renderClassPage();
  try { await api(`/api/classes/${cp.cls.id}/materials/order`, { method: 'PUT', body: { folderId, items: items.map(it => ({ kind: it.kind, id: it.id })) } }); }
  catch (e) { toast(e.message, 'err'); }
  refreshClass();
}
// Into a folder (null: the top of the class)
async function moveItem(kind, id, folderId) {
  try {
    if (kind === 'assignment') await api(`/api/assignments/${id}`, { method: 'PATCH', body: { folderId } });
    else await api(`/api/folders/${id}`, { method: 'PATCH', body: { parentId: folderId } });
    toast(`Moved to ${folderId ? folderById(folderId)?.name || 'the folder' : 'the top of the class'}`);
  } catch (e) { toast(e.message, 'err'); }
  if (ap && location.pathname === `/a/${ap.data.assignment.id}`) reloadAssignment().catch(() => {});
  refreshClass();
}

// Move to…: pick a folder (or the top of the class)
function openMoveModal(kind, id) {
  const item = kind === 'folder' ? folderById(id) : cp.assignments.find(a => a.id === id);
  if (!item) return;
  const current = (kind === 'folder' ? item.parentId : item.folderId) || '';
  const height = kind === 'folder' ? folderHeight(id) : 0;
  // A folder can't go inside itself, and nothing may end up more than 3 deep
  const allowed = f => kind !== 'folder' || (!f || (f.id !== id && !inSubtree(f.id, id) && folderDepth(f.id) + height <= 3));
  const rows = [];
  const walk = (parentId, depth) => levelItems(parentId).filter(x => x.kind === 'folder').forEach(({ x: f }) => {
    const ok = allowed(f);
    rows.push(`<label class="${ok ? '' : 'dim'}" style="padding-left:${8 + depth * 22}px;"><input type="radio" name="mvTo" value="${f.id}" ${f.id === current ? 'checked' : ''} ${ok ? '' : 'disabled'} /><span class="${f.color ? 'fc-' + f.color : ''}" style="display:inline-flex;">${PI.folder}</span>${esc(f.name)}</label>`);
    walk(f.id, depth + 1);
  });
  walk(null, 0);
  openModal({ title: `Move “${esc(kind === 'folder' ? item.name : item.title)}”`, sub: 'It goes to the top of the folder you pick.',
    body: `<div class="folder-tree"><label><input type="radio" name="mvTo" value="" ${current === '' ? 'checked' : ''} /><span style="display:inline-flex;">${PI.list}</span>${esc(cp.cls.name)} (top level)</label>${rows.join('')}</div>`,
    footer: `<button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-primary" id="mvGo">Move</button>` });
  $('mvGo').onclick = () => {
    const to = document.querySelector('input[name=mvTo]:checked')?.value ?? '';
    closeModal();
    if (to === current) return;
    moveItem(kind, id, to || null);
  };
}

/* ---- folders ---- */
function openFolderForm(id = null) {
  const f = id ? folderById(id) : null;
  let color = f?.color || null;
  openModal({ title: f ? 'Edit folder' : 'New folder', sub: f ? '' : cp.folder ? `Inside ${esc(folderById(cp.folder)?.name || 'this folder')}.` : 'Folders keep a unit’s assignments together. Students see a folder once something in it is published.',
    body: `<div class="field"><label for="fName">Name</label><input id="fName" class="input" maxlength="120" value="${esc(f?.name || '')}" placeholder="e.g. Unit 1: The Great Gatsby" /></div>
      <div class="field"><label>Colour</label>${swatchesHtml('fColor', color, true)}</div>
      <div class="field"><label for="fDesc">Description <span class="label-note">optional</span></label><textarea id="fDesc" class="input" maxlength="1000" style="min-height:80px;" placeholder="Shown at the top of the folder.">${esc(f?.description || '')}</textarea></div>
      <div id="fErr" class="form-error hidden"></div>`,
    footer: `<button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-primary" id="fSave">${f ? 'Save' : 'Create folder'}</button>` });
  wireSwatches('fColor', v => { color = v; });
  setTimeout(() => $('fName')?.focus(), 50);
  const save = () => modalBusy(async () => {
    const body = { name: $('fName').value, color, description: $('fDesc').value };
    try {
      if (f) await api(`/api/folders/${f.id}`, { method: 'PATCH', body });
      else await api(`/api/classes/${cp.cls.id}/folders`, { method: 'POST', body: { ...body, parentId: cp.folder || null } });
      closeModal(); toast(f ? 'Folder saved' : 'Folder created'); refreshClass();
    } catch (e) { formError('fErr', e.message); }
  });
  $('fSave').onclick = save;
  $('fName').addEventListener('keydown', e => { if (e.key === 'Enter') save(); });
}
async function deleteFolder(id) {
  const f = folderById(id);
  if (!f) return;
  const n = levelItems(id).length;
  const parent = f.parentId ? folderById(f.parentId)?.name : 'the top of the class';
  if (!await confirmModal(`Delete the folder “${f.name}”?`, n ? `${n === 1 ? 'The item in it moves' : `The ${n} items in it move`} up to ${parent}. No assignments or student work are deleted.` : 'It’s empty. Nothing else is deleted.', { okLabel: 'Delete folder', danger: true })) return;
  try {
    await api(`/api/folders/${id}`, { method: 'DELETE' });
    toast('Folder deleted');
    if (cp.folder === id || inSubtree(cp.folder, id)) { cp.folder = f.parentId || null; history.replaceState(null, '', `/class/${cp.cls.id}${cp.folder ? '?folder=' + cp.folder : ''}`); }
    refreshClass();
  } catch (e) { toast(e.message, 'err'); }
}

/* ---- drag and drop: reorder a level, or drop onto a folder ---- */
let matDrag = null; // { kind, id }
function wireMaterialsDnD() {
  const list = $('matList');
  if (!list) return;
  const clear = () => document.querySelectorAll('.drop-before, .drop-after, .drop-into').forEach(x => x.classList.remove('drop-before', 'drop-after', 'drop-into'));
  const zone = (row, e) => {
    const r = row.getBoundingClientRect(), y = e.clientY - r.top;
    if (row.dataset.kind === 'folder' && row.dataset.id !== matDrag.id && y > r.height * 0.25 && y < r.height * 0.75) return 'into';
    return y < r.height / 2 ? 'before' : 'after';
  };
  list.querySelectorAll('.mat-row[draggable="true"]').forEach(row => {
    row.addEventListener('dragstart', e => {
      if (e.target.closest('.dd')) { e.preventDefault(); return; }
      matDrag = { kind: row.dataset.kind, id: row.dataset.id };
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', `${matDrag.kind}:${matDrag.id}`);
      requestAnimationFrame(() => row.classList.add('dragging'));
    });
    row.addEventListener('dragend', () => { row.classList.remove('dragging'); clear(); matDrag = null; });
    row.addEventListener('dragover', e => {
      if (!matDrag || row.dataset.id === matDrag.id) return;
      e.preventDefault(); e.dataTransfer.dropEffect = 'move';
      const z = zone(row, e);
      clear(); row.classList.add(`drop-${z}`);
    });
    row.addEventListener('dragleave', e => { if (!row.contains(e.relatedTarget)) row.classList.remove('drop-before', 'drop-after', 'drop-into'); });
    row.addEventListener('drop', e => {
      if (!matDrag || row.dataset.id === matDrag.id) return;
      e.preventDefault();
      const z = zone(row, e), drag = matDrag;
      clear(); matDrag = null;
      if (z === 'into') return moveItem(drag.kind, drag.id, row.dataset.id);
      const items = levelItems(cp.folder);
      const from = items.findIndex(x => x.id === drag.id);
      if (from < 0) return;
      const [moved] = items.splice(from, 1);
      let to = items.findIndex(x => x.id === row.dataset.id);
      if (z === 'after') to++;
      items.splice(to, 0, moved);
      saveOrder(cp.folder || null, items);
    });
  });
  // The breadcrumbs: drop a row onto a folder above this one (or the class)
  document.querySelectorAll('.course-head [data-drop-folder]').forEach(a => {
    a.addEventListener('dragover', e => { if (!matDrag) return; e.preventDefault(); clear(); a.classList.add('drop-into'); });
    a.addEventListener('dragleave', () => a.classList.remove('drop-into'));
    a.addEventListener('drop', e => {
      if (!matDrag) return;
      e.preventDefault();
      const drag = matDrag; clear(); matDrag = null;
      moveItem(drag.kind, drag.id, a.dataset.dropFolder || null);
    });
  });
}

/* ====================== people (teacher) ======================
   The class's teachers (the owner, who made it, and any co-teachers), then
   its students with their accommodations, then pending invites. */
function membersHtml() {
  const c = cp.cls;
  const acc = c.accommodations || {};
  const gcOk = !!CFG.classroomImport;
  const teachers = teachersOf(c);
  const school = me?.org;
  const actions = ddHtml({ id: 'addMem', btnClass: 'btn btn-primary btn-sm', btn: `${I.plusSm}Add people ${PI.down}`, right: true, items: [
    school ? { label: `From ${school.name}…`, icon: I.school, onclick: `openAddFromSchool('${c.id}')` }
      : { label: 'From your school…', icon: I.school, disabled: true, note: 'choose your school in Profile settings' },
    { label: 'Add students by email…', icon: I.users, onclick: 'openAddMembers()' },
    { label: 'Add a teacher…', icon: I.school, onclick: 'openAddTeacher()' },
    { label: 'Import students from Google Classroom', icon: I.school, onclick: 'importFromClassroom()', disabled: !gcOk, note: gcOk ? '' : 'not set up' },
    'sep',
    { label: 'Copy the class code', icon: I.copy, onclick: `copyText('${esc(c.joinCode)}','Class code copied')` },
    { label: 'New class code', icon: I.refresh, onclick: 'rotateCode()' },
    { label: c.joinOpen ? 'Close joining with the code' : 'Open joining with the code', icon: I.hash, onclick: `setJoinOpen(${!c.joinOpen})` }
  ] });
  const teacherRows = `<div class="card" style="overflow-x:auto;position:relative;"><table class="roster">
      <thead><tr><th>Name</th><th>Role</th><th><span class="sr-only">Actions</span></th></tr></thead>
      <tbody>${teachers.map(t => {
        const self = t.id === me.id;
        const items = t.owner ? [] : self ? [{ label: 'Leave this class', icon: I.x, onclick: 'leaveClass()', danger: true }] : c.isOwner ? [{ label: 'Remove from class', icon: I.x, onclick: `removeTeacher('${t.id}')`, danger: true }] : [];
        return `<tr>
        <td><div class="roster-name">${avatarHtml(t, 'avatar-sm')}<span><b>${esc(t.name)}${self ? ' (you)' : ''}</b>${t.email ? `<div class="tiny muted">${esc(t.email)}</div>` : ''}</span></div></td>
        <td>${t.owner ? '<span class="pill pill-blue">Owner</span>' : '<span class="pill pill-gray">Co-teacher</span>'}</td>
        <td class="row-actions">${items.length ? ddHtml({ id: `tm-${t.id}`, btnClass: 'btn-icon', btn: I.gear, label: `Options: ${t.name}`, right: true, items }) : ''}</td>
      </tr>`; }).join('')}</tbody></table></div>`;
  const roster = c.students.length ? `<div class="card" style="overflow-x:auto;position:relative;"><table class="roster">
      <thead><tr><th>Name</th><th>Extra time</th><th>Accommodation note</th><th><span class="sr-only">Actions</span></th></tr></thead>
      <tbody>${c.students.map(s => `<tr>
        <td><div class="roster-name">${avatarHtml(s, 'avatar-sm')}<span><b>${esc(s.name)}</b><div class="tiny muted">${esc(s.email)}</div></span></div></td>
        <td><select class="input input-sm" aria-label="Extra time for ${esc(s.name)}" onchange="saveAccommodation('${s.id}')" id="accM-${s.id}">${[1, 1.25, 1.5, 2, 2.5, 3].map(m => `<option value="${m}" ${(acc[s.id]?.timeMultiplier || 1) === m ? 'selected' : ''}>${m === 1 ? 'None' : m + '×'}</option>`).join('')}</select></td>
        <td><input class="input input-sm" id="accN-${s.id}" aria-label="Accommodation note for ${esc(s.name)}" value="${esc(acc[s.id]?.note || '')}" placeholder="e.g. IEP, 504 plan" maxlength="300" onchange="saveAccommodation('${s.id}')" /></td>
        <td class="row-actions">${ddHtml({ id: `mm-${s.id}`, btnClass: 'btn-icon', btn: I.gear, label: `Options: ${s.name}`, right: true, items: [
          { label: 'Remove from class', icon: I.x, onclick: `removeClassStudent('${s.id}')` },
          { label: 'Delete their work in this class', icon: I.trash, onclick: `deleteStudentData('${s.id}')`, danger: true }] })}</td>
      </tr>`).join('')}</tbody></table></div>`
    : `<div class="mat-list"><div class="mat-empty"><b>No students yet</b>${school ? `Add them from ${esc(school.name)} with <button type="button" class="linklike" onclick="openAddFromSchool('${c.id}')">Add people</button>, or give anyone else the class code <b class="mono" style="display:inline;">${esc(c.joinCode)}</b>.` : `Give students the class code <b class="mono" style="display:inline;">${esc(c.joinCode)}</b>, or use Add people to add them by email.`}</div></div>`;
  const invites = (c.pendingInvites || []).length ? `<h2 class="section-title people-h">Invited, not signed up yet</h2>
    <div class="card list-card">${c.pendingInvites.map(i => `<div class="list-row"><span class="grow mono small">${esc(i.email)}</span><span class="tiny muted">invited ${esc(timeAgo(i.invitedAt))}</span><button class="btn-icon" aria-label="Cancel invite for ${esc(i.email)}" data-email="${esc(i.email)}" onclick="removeInvite(this.dataset.email)">${I.x}</button></div>`).join('')}</div>
    <div class="tiny muted" style="margin-top:6px;">They join this class automatically when they create their Visor account with that email.</div>` : '';
  const codeLine = `class code <b class="mono">${esc(c.joinCode)}</b> · ${c.joinOpen ? 'joining with the code is open' : 'joining with the code is closed (students you add still join)'}`;
  return `${courseHead(c, 'People', { actions, sub: school ? `Add people from ${esc(school.name)}. For anyone else: ${codeLine}` : codeLine.replace(/^c/, 'C') })}
    <h2 class="section-title people-h" style="margin-top:0;">Teachers <span class="muted">${teachers.length}</span></h2>
    ${teacherRows}
    <div class="tiny muted" style="margin-top:6px;">Co-teachers can do everything you can in this class, except delete it${c.isOwner ? '' : ' or remove other teachers'}.</div>
    <h2 class="section-title people-h">Students <span class="muted">${c.students.length}</span></h2>
    ${roster}${invites}`;
}
function openAddMembers() {
  openModal({ title: 'Add students by email', sub: 'Students with a Visor account join now. Anyone else joins when they sign up with that address.',
    body: `<textarea id="addEmails" class="input" style="min-height:120px;" placeholder="One or more addresses, separated by commas or new lines" aria-label="Student email addresses"></textarea>`,
    footer: `<button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="addClassStudents()">Add students</button>` });
  setTimeout(() => $('addEmails')?.focus(), 50);
}
function openAddTeacher() {
  openModal({ title: 'Add a teacher', sub: `They can do everything you can in ${esc(cp.cls.name)}: assignments, announcements, people, live sessions and review. Only the owner can delete the class.`,
    body: `<div class="field"><label for="atEmail">Their Visor teacher account’s email</label><input id="atEmail" class="input" type="email" autocomplete="off" placeholder="colleague@school.org" /></div><div id="atErr" class="form-error hidden"></div>`,
    footer: `<button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-primary" id="atGo">Add teacher</button>` });
  const go = () => modalBusy(async () => {
    try { const r = await api(`/api/classes/${cp.cls.id}/teachers`, { method: 'POST', body: { email: $('atEmail').value } }); cp.cls = { ...cp.cls, ...r.class }; closeModal(); forgetCourses(); renderClassPage(); toast('Teacher added'); }
    catch (e) { formError('atErr', e.message); }
  });
  $('atGo').onclick = go;
  $('atEmail').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  setTimeout(() => $('atEmail')?.focus(), 50);
}
/* ---- Add people from your school ----
   Everyone at the teacher's school (as each person chose it), students and
   teachers on two tabs, with a search. Picks are kept across tabs and
   searches; students join the class, teachers become co-teachers. */
let sp = null; // { classId, role, q, picked: Map(id -> role), seq }
function openAddFromSchool(classId) {
  if (!me?.org) return toast('Choose your school in Profile settings first.', 'err');
  const cls = cp?.cls?.id === classId ? cp.cls : ap?.data?.class?.id === classId ? ap.data.class : null;
  sp = { classId, role: 'student', q: '', picked: new Map(), seq: 0, timer: 0 };
  const tab = (k, label) => `<button type="button" role="tab" data-role="${k}" aria-selected="${k === 'student'}" tabindex="${k === 'student' ? 0 : -1}">${label}</button>`;
  openModal({ title: `Add people from ${esc(me.org.name)}`, sub: `Students join ${cls ? esc(cls.name) : 'the class'} right away; teachers become co-teachers. Only people who chose ${esc(me.org.name)} as their school are listed.`, wide: true,
    body: `<div class="sp-top"><div class="seg sp-tabs" role="tablist" aria-label="Who to show">${tab('student', 'Students')}${tab('teacher', 'Teachers')}</div>
        <input id="spQ" class="input sp-q" type="search" placeholder="Search by name or email" aria-label="Search people at ${esc(me.org.name)}" autocomplete="off" /></div>
      <div class="sp-bar"><label class="sp-all"><input type="checkbox" id="spAll" /> <span>Select everyone shown</span></label><span id="spShown" class="tiny muted" aria-live="polite"></span></div>
      <div id="spList" class="sp-list" role="group" aria-label="People"><div class="sp-empty"><span class="spinner spinner-sm"></span></div></div>
      <div id="spErr" class="form-error hidden"></div>`,
    footer: `<button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-primary" id="spGo" disabled>Add</button>` });
  const body = $('modalBody');
  const tabs = [...body.querySelectorAll('.sp-tabs [data-role]')];
  const show = k => {
    sp.role = k;
    tabs.forEach(b => { const on = b.dataset.role === k; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; });
    spLoad();
  };
  tabs.forEach(b => b.addEventListener('click', () => show(b.dataset.role)));
  body.querySelector('.sp-tabs').addEventListener('keydown', e => {
    if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    e.preventDefault(); const n = tabs.find(b => b.dataset.role !== sp.role); show(n.dataset.role); n.focus();
  });
  $('spQ').addEventListener('input', () => { clearTimeout(sp.timer); sp.timer = setTimeout(() => { sp.q = $('spQ').value.trim(); spLoad(); }, 220); });
  $('spQ').addEventListener('keydown', e => { if (e.key === 'Enter') e.preventDefault(); });
  $('spAll').addEventListener('change', e => {
    $('spList').querySelectorAll('input[type=checkbox]:not(:disabled)').forEach(cb => { cb.checked = e.target.checked; spPick(cb); });
  });
  $('spList').addEventListener('change', e => { if (e.target.matches('input[type=checkbox]')) { spPick(e.target); spSyncAll(); } });
  $('spGo').onclick = () => modalBusy(spAdd);
  spLoad();
  setTimeout(() => $('spQ')?.focus(), 60);
}
async function spLoad() {
  const seq = ++sp.seq, { classId, role, q } = sp;
  formError('spErr', '');
  try {
    const r = await api(`/api/classes/${classId}/school-people?role=${role}&q=${encodeURIComponent(q)}`);
    if (!sp || seq !== sp.seq || !$('spList')) return;
    const who = role === 'teacher' ? 'teachers' : 'students';
    const school = esc(r.school?.name || me.org.name);
    $('spList').innerHTML = r.people.length ? r.people.map(p => `<label class="sp-row${p.inClass ? ' in' : ''}">
        <input type="checkbox" value="${esc(p.id)}" data-role="${esc(p.role)}" ${p.inClass ? 'checked disabled' : sp.picked.has(p.id) ? 'checked' : ''} aria-label="${esc(p.name)}${p.inClass ? ', already in this class' : ''}" />
        ${avatarHtml(p, 'avatar-sm')}<span class="sp-who"><b>${esc(p.name)}</b><span class="tiny muted">${esc(p.email)}</span></span>
        ${p.inClass ? '<span class="pill pill-gray">In this class</span>' : ''}</label>`).join('')
      : `<div class="sp-empty">${q ? `No ${who} at ${school} match “${esc(q)}”.` : role === 'teacher' ? `No other teachers at ${school} are on Visor yet.` : `No students at ${school} are on Visor yet. Students choose their school when they sign up; give them the class code instead.`}</div>`;
    $('spShown').textContent = r.more ? `Showing the first ${r.people.length} of ${r.total.toLocaleString()}. Search to find others.` : r.total ? `${vcPlural(r.total, role === 'teacher' ? 'teacher' : 'student')}` : '';
    spSyncAll();
  } catch (e) { if (sp && seq === sp.seq) { $('spList').innerHTML = ''; formError('spErr', e.message); } }
}
function spPick(cb) {
  if (cb.disabled) return;
  if (cb.checked) sp.picked.set(cb.value, cb.dataset.role); else sp.picked.delete(cb.value);
  const n = [...sp.picked.values()], st = n.filter(r => r === 'student').length, te = n.length - st;
  const label = [st ? vcPlural(st, 'student') : '', te ? vcPlural(te, 'teacher') : ''].filter(Boolean).join(' and ');
  $('spGo').disabled = !n.length;
  $('spGo').textContent = n.length ? `Add ${label}` : 'Add';
}
function spSyncAll() {
  const boxes = [...$('spList').querySelectorAll('input[type=checkbox]:not(:disabled)')], all = $('spAll');
  all.disabled = !boxes.length;
  all.checked = boxes.length > 0 && boxes.every(b => b.checked);
  all.indeterminate = !all.checked && boxes.some(b => b.checked);
}
async function spAdd() {
  const classId = sp.classId;
  try {
    const r = await api(`/api/classes/${classId}/school-people`, { method: 'POST', body: { userIds: [...sp.picked.keys()] } });
    closeModal(); forgetCourses();
    if (cp?.cls?.id === classId) { cp.cls = { ...cp.cls, ...r.class }; renderClassPage(); }
    const parts = [r.students ? `${vcPlural(r.students, 'student')} added` : '', r.teachers ? `${vcPlural(r.teachers, 'co-teacher')} added` : '', r.skipped.length ? `${r.skipped.length} skipped (${[...new Set(r.skipped.map(x => x.why))].join(', ')})` : ''].filter(Boolean);
    toast(parts.join(' · ') || 'Nobody new to add', r.students || r.teachers ? '' : 'err');
  } catch (e) { formError('spErr', e.message); }
}

async function removeTeacher(id) {
  const t = teachersOf(cp.cls).find(x => x.id === id);
  if (!await confirmModal('Remove this teacher?', `${t?.name || 'They'} will no longer see ${cp.cls.name} or anything in it. Their announcements stay.`, { okLabel: 'Remove', danger: true })) return;
  try { const r = await api(`/api/classes/${cp.cls.id}/teachers/${id}`, { method: 'DELETE' }); cp.cls = { ...cp.cls, ...r.class }; forgetCourses(); renderClassPage(); toast('Teacher removed'); }
  catch (e) { toast(e.message, 'err'); }
}
async function leaveClass() {
  if (!await confirmModal(`Leave ${cp.cls.name}?`, 'You’ll no longer see the class or anything in it. The owner can add you again.', { okLabel: 'Leave class', danger: true })) return;
  try { await api(`/api/classes/${cp.cls.id}/teachers/${me.id}`, { method: 'DELETE' }); forgetCourses(); cp = null; toast('You left the class'); VisorRouter.go('/'); }
  catch (e) { toast(e.message, 'err'); }
}

async function classPatch(body, msg) {
  try { const r = await api(`/api/classes/${cp.cls.id}`, { method: 'PATCH', body }); cp.cls = { ...cp.cls, ...r.class }; forgetCourses(); renderClassPage(); if (msg) toast(msg); }
  catch (e) { toast(e.message, 'err'); }
}
const setJoinOpen = open => classPatch({ joinOpen: open }, open ? 'Joining is open' : 'Joining is closed');
async function rotateCode() {
  if (!await confirmModal('Make a new class code?', 'The old code stops working. Students already in the class stay in it.', { okLabel: 'New code' })) return;
  try { const r = await api(`/api/classes/${cp.cls.id}/rotate-code`, { method: 'POST' }); cp.cls = { ...cp.cls, ...r.class }; renderClassPage(); toast('New class code ready'); } catch (e) { toast(e.message, 'err'); }
}
// emails: a list (Google Classroom import), or the Add by email box
async function addClassStudents(list) {
  const emails = list || ($('addEmails')?.value || '').split(/[\s,;]+/).filter(Boolean);
  if (!emails.length) return toast('Type at least one email address', 'err');
  if (!list) return modalBusy(() => addClassStudentsNow(emails, false));
  return addClassStudentsNow(emails, true);
}
async function addClassStudentsNow(emails, list) {
  try {
    const r = await api(`/api/classes/${cp.cls.id}/students`, { method: 'POST', body: { emails } });
    if (!list) closeModal();
    cp.cls = { ...cp.cls, ...r.class }; forgetCourses(); renderClassPage();
    const parts = [r.added.length ? `${r.added.length} added` : '', r.invited.length ? `${r.invited.length} invited (no account yet)` : '', r.skipped.length ? `${r.skipped.length} skipped: ${r.skipped.map(s => `${s.email} (${s.why})`).join(', ')}` : ''].filter(Boolean);
    toast(parts.join(' · ') || 'Nothing to add', r.skipped.length && !r.added.length && !r.invited.length ? 'err' : '');
  } catch (e) { toast(e.message, 'err'); }
}
async function removeClassStudent(id) {
  const s = cp.cls.students.find(x => x.id === id);
  if (!await confirmModal('Remove student?', `Remove ${s?.name || 'this student'} from ${cp.cls.name}? Their work stays until you delete it.`, { okLabel: 'Remove', danger: true })) return;
  try { const r = await api(`/api/classes/${cp.cls.id}/students/${id}`, { method: 'DELETE' }); cp.cls = { ...cp.cls, ...r.class }; forgetCourses(); renderClassPage(); } catch (e) { toast(e.message, 'err'); }
}
async function deleteStudentData(id) {
  const s = cp.cls.students.find(x => x.id === id);
  if (!await confirmModal('Delete this student’s work?', `Every document, writing session and research record ${s?.name || 'this student'} has in ${cp.cls.name} will be deleted. This cannot be undone.`, { okLabel: 'Delete their work', danger: true })) return;
  try { await api(`/api/classes/${cp.cls.id}/students/${id}/data`, { method: 'DELETE' }); toast('Deleted'); } catch (e) { toast(e.message, 'err'); }
}
async function removeInvite(email) {
  try { const r = await api(`/api/classes/${cp.cls.id}/invites`, { method: 'DELETE', body: { email } }); cp.cls = { ...cp.cls, ...r.class }; renderClassPage(); } catch (e) { toast(e.message, 'err'); }
}
async function saveAccommodation(id) {
  const m = Number($(`accM-${id}`).value), note = $(`accN-${id}`).value;
  try { const r = await api(`/api/classes/${cp.cls.id}`, { method: 'PATCH', body: { accommodations: { [id]: { timeMultiplier: m, note } } } }); cp.cls = { ...cp.cls, ...r.class }; toast('Saved'); }
  catch (e) { toast(e.message, 'err'); }
}

/* ====================== settings (teacher) ====================== */
function classSettingsHtml() {
  const c = cp.cls;
  return `${courseHead(c, 'Settings')}
  <div class="stack" style="max-width:680px;">
    <section class="card card-pad">
      <h2 class="section-title" style="font-size:16px;margin-bottom:14px;">Class details</h2>
      <div class="field"><label for="csName">Class name</label><input id="csName" class="input" value="${esc(c.name)}" maxlength="120" /></div>
      <div class="field"><label>Banner</label>
        <div class="color-preview cs-banner">${courseArt(c, '', 'div', 'id="csPreview"')}<div><div class="small">${esc(c.background?.kind === 'preset' ? BG_NAME[c.background.preset] : c.background?.kind === 'upload' ? 'Your picture' : 'Class colour')} · ${esc(COLOR_NAME[courseColor(c)] || '')}</div>
          <button type="button" class="btn btn-ghost btn-sm" style="margin-top:6px;" onclick="openClassBanner('${c.id}')">${I.edit}Change background and colour</button>
          <div class="hint">On the class page, its tile on Home and the Classes menu. The colour also marks its calendar events.</div></div></div></div>
      <div class="field"><label for="csRetention">Keep research records for</label>
        <div style="display:flex;gap:8px;align-items:center;"><input id="csRetention" class="input" type="number" min="1" max="3650" value="${c.researchRetentionDays || 180}" style="max-width:120px;" /><span class="muted small">days</span></div>
        <div class="hint">Searches, pages and copies the extension recorded during writing sessions are deleted after this. Essays and their writing history are kept.</div></div>
      <button class="btn btn-primary" onclick="saveClassSettings()">Save</button>
    </section>
    <section class="card card-pad">
      <h2 class="section-title" style="font-size:16px;margin-bottom:6px;">${c.archived ? 'Archived' : 'Archive'}</h2>
      <p class="small muted" style="margin:0 0 12px;">${c.archived ? 'This class is archived: it’s hidden from Home and the Classes menu, but nothing is deleted.' : 'Archiving hides the class from Home and the Classes menu (for every teacher of it). Nothing is deleted, and you can bring it back.'}</p>
      <button class="btn btn-ghost" onclick="classPatch({ archived: ${!c.archived} }, '${c.archived ? 'Class restored' : 'Class archived'}')">${c.archived ? 'Restore class' : 'Archive class'}</button>
    </section>
    ${c.isOwner === false ? `<section class="card card-pad danger-zone">
      <h2 class="section-title" style="font-size:16px;margin-bottom:6px;color:var(--red);">Leave class</h2>
      <p class="small muted" style="margin:0 0 12px;">You’re a co-teacher here. Leaving takes the class off your Home; nothing in it is deleted. Only the owner can delete the class.</p>
      <button class="btn btn-danger" onclick="leaveClass()">${I.x}Leave class</button>
    </section>` : `<section class="card card-pad danger-zone">
      <h2 class="section-title" style="font-size:16px;margin-bottom:6px;color:var(--red);">Delete class</h2>
      <p class="small muted" style="margin:0 0 12px;">Deletes every assignment, folder, announcement, essay, writing session, research record, discussion recording, piece of feedback and group project in this class, for every teacher and student in it.</p>
      <div class="field"><label for="csConfirm">Type <b>${esc(c.name)}</b> to confirm</label><input id="csConfirm" class="input" autocomplete="off" /></div>
      <button class="btn btn-danger" onclick="deleteClass()">${I.trash}Delete class</button>
    </section>`}
  </div>`;
}
function saveClassSettings() { classPatch({ name: $('csName').value, researchRetentionDays: Number($('csRetention').value) }, 'Saved'); }
async function deleteClass() {
  const confirmName = $('csConfirm').value.trim();
  if (confirmName !== cp.cls.name) return toast('Type the class name exactly to delete it.', 'err');
  try { await api(`/api/classes/${cp.cls.id}`, { method: 'DELETE', body: { confirmName } }); forgetCourses(); cp = null; toast('Class deleted'); VisorRouter.go('/'); }
  catch (e) { toast(e.message, 'err'); }
}

/* ---- Google Classroom roster import (only when the server turns it on) ----
   The browser asks Google for a short-lived token with read-only Classroom
   scopes, lists the teacher's courses, and sends the chosen course's student
   emails to the normal "add by email" route. The token never reaches Visor's
   server. */
const CLASSROOM_SCOPES = 'https://www.googleapis.com/auth/classroom.courses.readonly https://www.googleapis.com/auth/classroom.rosters.readonly https://www.googleapis.com/auth/classroom.profile.emails';
async function classroomFetch(token, path) {
  const r = await fetch(`https://classroom.googleapis.com/v1/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error?.message || `Google Classroom said no (${r.status})`);
  return data;
}
async function importFromClassroom() {
  try {
    await loadScriptOnce('https://accounts.google.com/gsi/client');
    const token = await new Promise((resolve, reject) => {
      google.accounts.oauth2.initTokenClient({ client_id: CFG.googleSignIn, scope: CLASSROOM_SCOPES,
        callback: r => (r.error ? reject(new Error(r.error_description || r.error)) : resolve(r.access_token)),
        error_callback: () => reject(new Error('Google sign-in didn’t finish.')) }).requestAccessToken();
    });
    const { courses = [] } = await classroomFetch(token, 'courses?teacherId=me&courseStates=ACTIVE&pageSize=100');
    if (!courses.length) return toast('No active Google Classroom courses where you teach.', 'err');
    openModal({ title: 'Import from Google Classroom', sub: 'Pick the course whose students should join this class.', body: `<div class="stack">${courses.map(c => `<button class="choice" style="text-align:left;" data-course="${esc(c.id)}"><div class="t">${esc(c.name)}</div><div class="d">${esc(c.section || '')}</div></button>`).join('')}</div>`, footer: `<button class="btn btn-ghost" onclick="closeModal()">Cancel</button>` });
    document.querySelectorAll('[data-course]').forEach(b => b.onclick = async () => {
      b.disabled = true;
      try {
        const emails = []; let page = '';
        do {
          const r = await classroomFetch(token, `courses/${encodeURIComponent(b.dataset.course)}/students?pageSize=100${page ? '&pageToken=' + encodeURIComponent(page) : ''}`);
          for (const s of r.students || []) if (s.profile?.emailAddress) emails.push(s.profile.emailAddress);
          page = r.nextPageToken || '';
        } while (page);
        closeModal();
        if (!emails.length) return toast('That course has no students with visible email addresses.', 'err');
        addClassStudents(emails);
      } catch (e) { toast(e.message, 'err'); b.disabled = false; }
    });
  } catch (e) { toast(e.message, 'err'); }
}
