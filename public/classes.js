/* Visor Classroom — home dashboards and class pages.
   Also the small helpers every Visor Classroom page shares (dates, page
   headers, breadcrumbs). Uses app.js helpers: $, esc, api, toast, openModal… */

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
const TYPE_LABEL = { writing: 'Writing', group: 'Group project', discussion: 'Discussion' };
const TYPE_PILL = { writing: 'pill-blue', group: 'pill-violet', discussion: 'pill-amber' };
const typePill = t => `<span class="pill ${TYPE_PILL[t] || 'pill-gray'}">${esc(TYPE_LABEL[t] || t)}</span>`;
const STATUS_LABEL = { 'not-started': 'Not started', 'in-progress': 'In progress', submitted: 'Submitted', returned: 'Returned' };
const STATUS_PILL = { 'not-started': 'pill-gray', 'in-progress': 'pill-blue', submitted: 'pill-green', returned: 'pill-violet' };
const statusPillDoc = s => `<span class="pill ${STATUS_PILL[s] || 'pill-gray'}">${esc(STATUS_LABEL[s] || s)}</span>`;

function crumbs(list) {
  return `<nav class="crumbs" aria-label="Breadcrumb">${list.map(([label, href], i) => (href && i < list.length - 1 ? `<a href="${href}" data-link>${esc(label)}</a>` : `<span aria-current="page">${esc(label)}</span>`)).join('<span class="sep" aria-hidden="true">/</span>')}</nav>`;
}
function pageTabs(tabs, active, onclickFn) {
  return `<div class="tabs" role="tablist">${tabs.map(([k, label, count]) => `<button class="tab ${k === active ? 'active' : ''}" role="tab" aria-selected="${k === active}" onclick="${onclickFn}('${k}')">${label}${count != null ? ` <span class="count">${count}</span>` : ''}</button>`).join('')}</div>`;
}
async function copyText(text, label = 'Copied') {
  try { await navigator.clipboard.writeText(text); toast(label); } catch { toast(text); }
}

// Escape closes a dialog that has a close button
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $('modalRoot')?.querySelector('.mh .btn-icon')) closeModal();
});

/* ====================== home ====================== */
let home = { projectsOpen: null };

VisorRouter.add('/', async el => {
  el.innerHTML = `<div class="page"><div class="loading-row"><span class="spinner"></span></div></div>`;
  const [cls, dash, projs] = await Promise.all([api('/api/classes'), api('/api/dashboard'), api('/api/projects')]);
  if (me.role === 'teacher') renderTeacherHome(el, cls.classes, dash, projs.projects);
  else renderStudentHome(el, cls.classes, dash, projs.projects);
  const t = setInterval(async () => {
    // Keep "Happening now" fresh while the page is open
    if (me.role !== 'teacher' || document.hidden) return;
    try { const d = await api('/api/dashboard'); const box = $('happeningNow'); if (box) box.outerHTML = happeningHtml(d.happeningNow); } catch {}
  }, 20000);
  return () => clearInterval(t);
});

function classCard(c) {
  const stats = me.role === 'teacher'
    ? [`${vcPlural(c.studentCount, 'student')}`, c.activeSessions ? `<b class="live-dot-text"><i class="live-dot"></i>${c.activeSessions} writing now</b>` : '', c.toReview ? `<b>${c.toReview} to review</b>` : ''].filter(Boolean)
    : [`${esc(c.teacher?.name || '')}`, vcPlural(c.assignmentCount, 'assignment')];
  return `<a class="card card-hover class-card ${c.archived ? 'archived' : ''}" href="/class/${c.id}" data-link>
    <div class="class-card-top"><div class="class-name">${esc(c.name)}</div>${c.archived ? '<span class="pill pill-gray">Archived</span>' : ''}</div>
    <div class="class-meta">${stats.map(s => `<span>${s}</span>`).join('')}</div>
    ${c.upcoming?.length ? `<div class="class-upcoming">${c.upcoming.map(a => `<div>${typePill(a.type)} <span>${esc(a.title)}</span> <span class="muted tiny">due ${esc(vcDate(a.dueAt))}</span></div>`).join('')}</div>` : ''}
  </a>`;
}

function happeningHtml(list) {
  if (!list?.length) return '<div id="happeningNow"></div>';
  return `<div id="happeningNow" class="happening"><div class="kicker"><i class="live-dot"></i> Happening now</div>
    ${list.map(h => `<a class="happening-item" href="/a/${h.assignmentId}?tab=live" data-link><b>${esc(h.title)}</b><span class="muted small">${esc(h.className)} · ${h.live} of ${h.students} writing</span></a>`).join('')}</div>`;
}

function projectsSection(projects, collapsedByDefault) {
  if (home.projectsOpen === null) home.projectsOpen = !collapsedByDefault;
  const list = projects.filter(p => !p.classId);
  const body = list.length
    ? `<div class="stack">${list.map(p => `<a class="card card-hover row-link" href="/project/${p.id}" data-link><b>${esc(p.name)}</b><span class="muted small">${vcPlural(p.students?.length || 0, 'student')} · ${vcPlural(p.resourceCount || 0, 'resource')}</span></a>`).join('')}</div>`
    : `<div class="muted small">No projects outside your classes.</div>`;
  return `<section class="home-section">
    <div class="card collapse ${home.projectsOpen ? 'open' : ''}" id="homeProjects">
      <div class="ch" role="button" tabindex="0" aria-expanded="${home.projectsOpen}" onclick="toggleHomeProjects()" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleHomeProjects();}">${I.chev}<b style="flex:1;">Projects</b><span class="muted small">${list.length}</span>
        ${me.role === 'teacher' ? `<button class="btn btn-soft btn-sm" onclick="event.stopPropagation();openNewProject()">+ New project</button>` : ''}</div>
      <div class="cb">${body}</div>
    </div></section>`;
}
function toggleHomeProjects() {
  home.projectsOpen = !home.projectsOpen;
  const el = $('homeProjects'); el.classList.toggle('open', home.projectsOpen);
  el.querySelector('.ch').setAttribute('aria-expanded', home.projectsOpen);
}

function renderTeacherHome(el, list, dash, projects) {
  const active = list.filter(c => !c.archived), archived = list.filter(c => c.archived);
  el.innerHTML = `<div class="page">
    <div class="page-head"><div><h1>Your classes</h1><div class="muted">${active.length ? `${vcPlural(active.length, 'class', 'classes')}` : 'Create a class to get started.'}</div></div>
      <button class="btn btn-primary" onclick="openCreateClass()">${I.plusSm}Create class</button></div>
    ${happeningHtml(dash.happeningNow)}
    ${active.length ? `<div class="class-grid">${active.map(classCard).join('')}</div>`
      : `<div class="card"><div class="empty"><div class="ic">${I.school}</div><h4>No classes yet</h4><p>A class holds your roster and its assignments: in-class essays, group projects and discussions.</p><button class="btn btn-primary" onclick="openCreateClass()">Create your first class</button></div></div>`}
    <section class="home-section">
      <h2 class="section-title">Needs review</h2>
      ${dash.needsReview.length ? `<div class="card list-card">${dash.needsReview.slice(0, 30).map(r => `<a class="list-row" href="/review/${r.docId}" data-link><span class="grow"><b>${esc(r.student)}</b> · ${esc(r.title)}<div class="tiny muted">${esc(r.className)}</div></span><span class="tiny muted">submitted ${esc(timeAgo(r.submittedAt))}</span></a>`).join('')}</div>`
        : `<div class="muted small">Nothing waiting. Submitted work shows up here until you return it.</div>`}
    </section>
    ${projectsSection(projects, list.length > 0)}
    ${archived.length ? `<section class="home-section"><h2 class="section-title">Archived</h2><div class="class-grid">${archived.map(classCard).join('')}</div></section>` : ''}
  </div>`;
}

function renderStudentHome(el, list, dash, projects) {
  const todo = dash.todo || [];
  const open = todo.filter(t => t.type !== 'writing' || !['submitted', 'returned'].includes(t.status));
  el.innerHTML = `<div class="page">
    <div class="page-head"><div><h1>Hi, ${esc(me.firstName)}</h1><div class="muted">${open.length ? `${vcPlural(open.length, 'thing')} to do` : 'You’re all caught up.'}</div></div>
      <div class="head-actions"><button class="btn btn-ghost" onclick="openJoinClass()">${I.plusSm}Join a class</button><a class="btn btn-ghost" href="/extension/connect" data-link id="extStatusBtn">${I.puzzle}Connect extension</a></div></div>
    <section class="home-section">
      <h2 class="section-title">To do</h2>
      ${todo.length ? `<div class="card list-card">${todo.map(t => `<a class="list-row" href="/a/${t.assignmentId}" data-link>${typePill(t.type)}<span class="grow"><b>${esc(t.title)}</b><div class="tiny muted">${esc(t.className)}</div></span>${t.status ? statusPillDoc(t.status) : ''}<span class="tiny muted due">${t.dueAt ? 'due ' + esc(vcDateTime(t.dueAt)) : 'no due date'}</span></a>`).join('')}</div>`
        : `<div class="muted small">No assignments yet. They show up here when your teacher publishes them.</div>`}
    </section>
    <section class="home-section">
      <h2 class="section-title">Classes</h2>
      ${list.length ? `<div class="class-grid">${list.map(classCard).join('')}</div>` : `<div class="card"><div class="empty"><div class="ic">${I.school}</div><h4>You're not in a class yet</h4><p>Ask your teacher for the class code.</p><button class="btn btn-primary" onclick="openJoinClass()">Join a class</button></div></div>`}
    </section>
    ${projects.some(p => !p.classId) ? projectsSection(projects, list.length > 0) : ''}
  </div>`;
  if (window.VisorExt) VisorExt.ping().then(p => { const b = $('extStatusBtn'); if (b && p.installed) b.innerHTML = `${I.puzzle}${p.connected ? 'Extension connected ✓' : 'Connect extension'}`; });
}

function openCreateClass() {
  openModal({ title: 'Create a class', sub: 'Students join with a code, or you add them by email.', body: `<div class="field"><label for="ncName">Class name</label><input id="ncName" class="input" placeholder="English 10 – Period 3" maxlength="120" /></div>`,
    footer: `<button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="createClass()">Create class</button>` });
  setTimeout(() => $('ncName')?.focus(), 50);
  $('ncName').addEventListener('keydown', e => { if (e.key === 'Enter') createClass(); });
}
async function createClass() {
  const name = $('ncName').value.trim();
  if (!name) return $('ncName').classList.add('error');
  try { const r = await api('/api/classes', { method: 'POST', body: { name } }); closeModal(); VisorRouter.go(`/class/${r.class.id}?tab=students`); toast('Class created. Add your students.'); }
  catch (e) { toast(e.message, 'err'); }
}

function openJoinClass() {
  openModal({ title: 'Join a class', sub: 'Type the 6-character code your teacher gave you.', body: `<div class="field"><label for="jcCode">Class code</label><input id="jcCode" class="input mono" maxlength="6" autocomplete="off" style="text-transform:uppercase;font-size:20px;letter-spacing:.2em;" /></div><div id="jcErr" class="form-error hidden"></div>`,
    footer: `<button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="joinClass()">Join</button>` });
  setTimeout(() => $('jcCode')?.focus(), 50);
  $('jcCode').addEventListener('keydown', e => { if (e.key === 'Enter') joinClass(); });
}
async function joinClass() {
  try { const r = await api('/api/classes/join', { method: 'POST', body: { code: $('jcCode').value } }); closeModal(); toast(`You joined ${r.class.name}`); VisorRouter.go(`/class/${r.class.id}`); }
  catch (e) { formError('jcErr', e.message); }
}

/* ====================== class page ====================== */
let cp = null; // { cls, assignments, tab }

VisorRouter.add('/class/:id', async (el, { id }, query) => {
  const r = await api(`/api/classes/${id}`);
  cp = { cls: r.class, assignments: r.assignments, tab: query.get('tab') || 'assignments', groups: null };
  if (!cp.cls.isTeacher && !['assignments'].includes(cp.tab)) cp.tab = 'assignments';
  renderClassPage();
});

function classTab(tab) {
  cp.tab = tab;
  history.replaceState(null, '', `/class/${cp.cls.id}${tab === 'assignments' ? '' : '?tab=' + tab}`);
  renderClassPage();
}

function renderClassPage() {
  const c = cp.cls;
  const el = $('routeView');
  const teacherTabs = [['assignments', 'Assignments', cp.assignments.length], ['students', 'Students', c.students?.length ?? c.studentCount], ['settings', 'Settings']];
  el.innerHTML = `<div class="page">
    ${crumbs([['Home', '/'], [c.name]])}
    <div class="page-head">
      <div><h1>${esc(c.name)} ${c.archived ? '<span class="pill pill-gray">Archived</span>' : ''}</h1>
        <div class="muted">${c.isTeacher ? vcPlural(c.studentCount, 'student') : `Teacher: ${esc(c.teacher?.name || '')}`}</div></div>
      ${c.isTeacher ? `<div class="head-actions">
        <button class="code-chip" onclick="copyText('${esc(c.joinCode)}','Join code copied')" title="Students type this code to join. Click to copy.">${I.hash}<span>${esc(c.joinCode)}</span></button>
        <span class="pill ${c.joinOpen ? 'pill-green' : 'pill-gray'}">${c.joinOpen ? 'Joining open' : 'Joining closed'}</span></div>` : ''}
    </div>
    ${c.isTeacher ? pageTabs(teacherTabs, cp.tab, 'classTab') : ''}
    <div id="classBody"></div>
  </div>`;
  const body = $('classBody');
  if (cp.tab === 'students' && c.isTeacher) body.innerHTML = classStudentsHtml();
  else if (cp.tab === 'settings' && c.isTeacher) body.innerHTML = classSettingsHtml();
  else body.innerHTML = classAssignmentsHtml();
}

function classAssignmentsHtml() {
  const c = cp.cls, list = cp.assignments;
  const create = c.isTeacher ? `<div class="create-row">
      <span class="muted small">New assignment:</span>
      <button class="btn btn-ghost btn-sm" onclick="openAssignmentForm('${c.id}','writing')">${I.pen}Writing</button>
      <button class="btn btn-ghost btn-sm" onclick="openAssignmentForm('${c.id}','group')">${I.users}Group project</button>
      <button class="btn btn-ghost btn-sm" onclick="openAssignmentForm('${c.id}','discussion')">${I.chat}Discussion</button>
    </div>` : '';
  if (!list.length) return `${create}<div class="card"><div class="empty"><div class="ic">${I.doc}</div><h4>No assignments yet</h4><p>${c.isTeacher ? 'Create a writing assignment (an in-class essay or homework), a group project, or a class discussion.' : 'Your teacher hasn’t published anything here yet.'}</p></div></div>`;
  return `${create}<div class="card list-card">${list.map(a => `<a class="list-row" href="/a/${a.id}" data-link>${typePill(a.type)}<span class="grow"><b>${esc(a.title)}</b><div class="tiny muted">${a.dueAt ? 'Due ' + esc(vcDateTime(a.dueAt)) : 'No due date'}</div></span>
    ${c.isTeacher ? (a.publishedAt ? '<span class="pill pill-green">Published</span>' : '<span class="pill pill-gray">Draft</span>') : ''}</a>`).join('')}</div>`;
}

function classStudentsHtml() {
  const c = cp.cls;
  const acc = c.accommodations || {};
  const roster = c.students.length ? `<div class="card"><table class="roster">
      <thead><tr><th>Student</th><th>Extra time</th><th>Note</th><th><span class="sr-only">Actions</span></th></tr></thead>
      <tbody>${c.students.map(s => `<tr>
        <td><div class="roster-name">${avatarHtml(s, 'avatar-sm')}<span><b>${esc(s.name)}</b><div class="tiny muted">${esc(s.email)}</div></span></div></td>
        <td><select class="input input-sm" aria-label="Extra time for ${esc(s.name)}" onchange="saveAccommodation('${s.id}')" id="accM-${s.id}">${[1, 1.25, 1.5, 2, 2.5, 3].map(m => `<option value="${m}" ${(acc[s.id]?.timeMultiplier || 1) === m ? 'selected' : ''}>${m === 1 ? 'None' : m + '×'}</option>`).join('')}</select></td>
        <td><input class="input input-sm" id="accN-${s.id}" aria-label="Accommodation note for ${esc(s.name)}" value="${esc(acc[s.id]?.note || '')}" placeholder="e.g. IEP, 504 plan" maxlength="300" onchange="saveAccommodation('${s.id}')" /></td>
        <td class="row-actions"><button class="btn-icon" title="Delete ${esc(s.name)}'s work in this class" aria-label="Delete ${esc(s.name)}'s work in this class" onclick="deleteStudentData('${s.id}')">${I.trash}</button><button class="btn-icon" title="Remove from class" aria-label="Remove ${esc(s.name)} from class" onclick="removeClassStudent('${s.id}')">${I.x}</button></td>
      </tr>`).join('')}</tbody></table></div>`
    : `<div class="card"><div class="empty"><div class="ic">${I.users}</div><h4>No students yet</h4><p>Share the join code, or add students by email above.</p></div></div>`;
  const invites = (c.pendingInvites || []).length ? `<h3 class="section-title" style="margin-top:22px;">Invited, not signed up yet</h3>
    <div class="card list-card">${c.pendingInvites.map(i => `<div class="list-row"><span class="grow mono small">${esc(i.email)}</span><span class="tiny muted">invited ${esc(timeAgo(i.invitedAt))}</span><button class="btn-icon" aria-label="Cancel invite for ${esc(i.email)}" onclick="removeInvite('${esc(i.email)}')">${I.x}</button></div>`).join('')}</div>
    <div class="tiny muted" style="margin-top:6px;">They join this class automatically when they create their Visor account with that email.</div>` : '';
  const gc = CFG.classroomImport
    ? `<button class="btn btn-ghost btn-sm" onclick="importFromClassroom()">${I.school}Import from Google Classroom</button>`
    : `<span class="tip-wrap"><button class="btn btn-ghost btn-sm" disabled aria-describedby="gcTip">${I.school}Import from Google Classroom</button><span id="gcTip" role="tooltip" class="tip">Needs your school’s Google setup: the server must have GOOGLE_CLIENT_ID and CLASSROOM_IMPORT=1.</span></span>`;
  return `<div class="two-col class-students">
    <div class="card card-pad">
      <div class="kicker" style="margin-bottom:8px;">Join code</div>
      <div class="join-code-big mono">${esc(c.joinCode)}</div>
      <div class="btn-row"><button class="btn btn-ghost btn-sm" onclick="copyText('${esc(c.joinCode)}','Join code copied')">${I.copy}Copy</button>
        <button class="btn btn-ghost btn-sm" onclick="rotateCode()">${I.refresh}New code</button>
        <button class="btn btn-ghost btn-sm" onclick="setJoinOpen(${!c.joinOpen})">${c.joinOpen ? 'Close joining' : 'Open joining'}</button></div>
      <div class="tiny muted" style="margin-top:8px;">${c.joinOpen ? 'Students can join with this code.' : 'Joining is closed. Students you add by email still join.'}</div>
    </div>
    <div class="card card-pad">
      <div class="kicker" style="margin-bottom:8px;">Add students by email</div>
      <textarea id="addEmails" class="input" style="min-height:76px;" placeholder="One or more addresses, separated by commas or new lines" aria-label="Student email addresses"></textarea>
      <div class="btn-row"><button class="btn btn-primary btn-sm" onclick="addClassStudents()">Add students</button>${gc}</div>
      <div id="addResult" class="tiny muted"></div>
    </div>
  </div>
  <h3 class="section-title" style="margin:22px 0 10px;">Roster</h3>
  ${roster}
  ${invites}`;
}

async function classPatch(body, msg) {
  try { const r = await api(`/api/classes/${cp.cls.id}`, { method: 'PATCH', body }); cp.cls = { ...cp.cls, ...r.class }; renderClassPage(); if (msg) toast(msg); }
  catch (e) { toast(e.message, 'err'); }
}
const setJoinOpen = open => classPatch({ joinOpen: open }, open ? 'Joining is open' : 'Joining is closed');
async function rotateCode() {
  if (!await confirmModal('Make a new join code?', 'The old code stops working. Students already in the class stay in it.', { okLabel: 'New code' })) return;
  try { const r = await api(`/api/classes/${cp.cls.id}/rotate-code`, { method: 'POST' }); cp.cls = { ...cp.cls, ...r.class }; renderClassPage(); toast('New join code ready'); } catch (e) { toast(e.message, 'err'); }
}
async function addClassStudents() {
  const emails = $('addEmails').value.split(/[\s,;]+/).filter(Boolean);
  if (!emails.length) return toast('Type at least one email address', 'err');
  try {
    const r = await api(`/api/classes/${cp.cls.id}/students`, { method: 'POST', body: { emails } });
    cp.cls = { ...cp.cls, ...r.class }; renderClassPage();
    const parts = [r.added.length ? `${r.added.length} added` : '', r.invited.length ? `${r.invited.length} invited (no account yet)` : '', r.skipped.length ? `${r.skipped.length} skipped: ${r.skipped.map(s => `${s.email} (${s.why})`).join(', ')}` : ''].filter(Boolean);
    toast(parts.join(' · ') || 'Nothing to add', r.skipped.length && !r.added.length && !r.invited.length ? 'err' : '');
  } catch (e) { toast(e.message, 'err'); }
}
async function removeClassStudent(id) {
  const s = cp.cls.students.find(x => x.id === id);
  if (!await confirmModal('Remove student?', `Remove ${s?.name || 'this student'} from ${cp.cls.name}? Their work stays until you delete it.`, { okLabel: 'Remove', danger: true })) return;
  try { const r = await api(`/api/classes/${cp.cls.id}/students/${id}`, { method: 'DELETE' }); cp.cls = { ...cp.cls, ...r.class }; renderClassPage(); } catch (e) { toast(e.message, 'err'); }
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

function classSettingsHtml() {
  const c = cp.cls;
  return `<div class="stack" style="max-width:640px;">
    <div class="card card-pad">
      <div class="field"><label for="csName">Class name</label><input id="csName" class="input" value="${esc(c.name)}" maxlength="120" /></div>
      <div class="field"><label for="csRetention">Keep research records for</label>
        <div style="display:flex;gap:8px;align-items:center;"><input id="csRetention" class="input" type="number" min="1" max="3650" value="${c.researchRetentionDays || 180}" style="max-width:120px;" /><span class="muted small">days</span></div>
        <div class="hint">Searches, pages and copies the extension recorded during writing sessions are deleted after this. Essays and their writing history are kept.</div></div>
      <button class="btn btn-primary" onclick="saveClassSettings()">Save</button>
    </div>
    <div class="card card-pad">
      <div class="kicker" style="margin-bottom:6px;">${c.archived ? 'Archived' : 'Archive'}</div>
      <p class="small muted" style="margin:0 0 10px;">${c.archived ? 'This class is archived: it’s hidden from the home page lists but nothing is deleted.' : 'Archiving hides the class from your home page. Nothing is deleted, and you can bring it back.'}</p>
      <button class="btn btn-ghost" onclick="classPatch({ archived: ${!c.archived} }, '${c.archived ? 'Class restored' : 'Class archived'}')">${c.archived ? 'Restore class' : 'Archive class'}</button>
    </div>
    <div class="card card-pad danger-zone">
      <div class="kicker" style="margin-bottom:6px;color:var(--red);">Delete class</div>
      <p class="small muted" style="margin:0 0 10px;">Deletes every assignment, essay, writing session, research record, discussion recording, piece of feedback and group project in this class.</p>
      <div class="field"><label for="csConfirm">Type <b>${esc(c.name)}</b> to confirm</label><input id="csConfirm" class="input" autocomplete="off" /></div>
      <button class="btn btn-danger" onclick="deleteClass()">${I.trash}Delete class</button>
    </div>
  </div>`;
}
function saveClassSettings() { classPatch({ name: $('csName').value, researchRetentionDays: Number($('csRetention').value) }, 'Saved'); }
async function deleteClass() {
  const confirmName = $('csConfirm').value.trim();
  if (confirmName !== cp.cls.name) return toast('Type the class name exactly to delete it.', 'err');
  try { await api(`/api/classes/${cp.cls.id}`, { method: 'DELETE', body: { confirmName } }); toast('Class deleted'); VisorRouter.go('/'); }
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
        $('addEmails').value = emails.join('\n');
        addClassStudents();
      } catch (e) { toast(e.message, 'err'); b.disabled = false; }
    });
  } catch (e) { toast(e.message, 'err'); }
}
