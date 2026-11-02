/* Visor Classroom — Your School. Every teacher sees the school's people; its
   facilitators also run it: logo, the list of who can join, each person's role
   and grades, and invites, and they see every class at the school. The rules are
   in lib/schools.js. */

'use strict';

const sq = { data: null, tab: 'people', q: '', who: 'all', grade: '', status: '', picked: new Set(), shown: 200, add: null, classQ: '' };
const ROLE_PILL = { facilitator: 'pill-violet', teacher: 'pill-blue', assistant: 'pill-blue', advisor: 'pill-blue', student: 'pill-gray' };
const SCHOOL_STATUS = { joined: ['Joined', 'pill-green'], invited: ['Invited', 'pill-blue'], added: ['Not invited', 'pill-gray'], waiting: ['Not joined yet', 'pill-gray'] };
const INVITE_BATCH = 25;
const schoolRoleLabel = id => sq.data.roles.find(r => r.id === id)?.label || id;
const isStudentRow = p => p.role === 'student';
const roleOptions = selected => sq.data.roles.map(r => `<option value="${r.id}" ${r.id === selected ? 'selected' : ''}>${esc(r.label)}</option>`).join('');
const gradeChips = (selected, handler) => sq.data.grades.map(g => `<button type="button" class="grade-chip" data-grade="${g}" aria-pressed="${selected.includes(g)}" onclick="${handler}">${g}</button>`).join('');
const chosenGrades = root => [...root.querySelectorAll('.grade-chip[aria-pressed="true"]')].map(b => b.dataset.grade);
function toggleGradeChip(btn) { btn.setAttribute('aria-pressed', String(btn.getAttribute('aria-pressed') !== 'true')); }

VisorRouter.add('/school', async el => {
  VisorRouter.title('Your School');
  el.innerHTML = VisorRouter.skeleton('page');
  const mine = VisorRouter.seq();
  await schoolLoad();
  if (mine === VisorRouter.seq()) schoolDraw();
});
async function schoolLoad() {
  sq.data = await api('/api/school');
  const waiting = sq.data.requests.length + sq.data.facilitatorRequests.length;
  if (me.facilitator && me.schoolRequests !== waiting) { me.schoolRequests = waiting; paintSchool(); }
  const ids = new Set(sq.data.people.map(p => p.id));
  sq.picked = new Set([...sq.picked].filter(id => ids.has(id)));
}
async function schoolReload() { await schoolLoad(); if (location.pathname === '/school') schoolDraw(); }
// The sidebar and anything else showing the school follow a change to it
function schoolUserChanged(user) { me = user; paintSchool(); }

function schoolDraw() {
  const el = $('routeView'), d = sq.data;
  if (!d.school) return schoolDrawNone(el);
  const s = d.school, people = d.people, staff = people.filter(p => !isStudentRow(p)), students = people.filter(isStudentRow);
  const joined = people.filter(p => p.status === 'joined').length, invited = people.filter(p => p.status === 'invited').length;
  const uninvited = people.filter(p => p.status === 'added').length;
  el.innerHTML = `<div class="portal school">
    <header class="school-hero">
      <span class="school-logo">${s.logoUrl ? `<img src="${esc(s.logoUrl)}" alt="" />` : I.school}</span>
      <div class="school-id"><h1>${esc(s.name)}</h1>
        <div class="course-sub">${s.facilitators.length ? `${s.facilitators.length > 1 ? 'Facilitators' : 'Facilitator'}: ${esc(s.facilitators.join(', '))}` : 'Nobody runs this school on Visor yet'}</div></div>
      ${d.canRun ? `<div class="school-actions">
        ${uninvited ? `<button class="btn btn-ghost" onclick="schoolInviteAll()">${d.mailReady ? 'Send' : 'Copy'} ${vcPlural(uninvited, 'invite')}</button>` : ''}
        <button class="btn btn-ghost" onclick="openSchoolSettings()">${I.gear}Settings</button>
        <button class="btn btn-primary" onclick="openAddPeople()">${I.plusSm}Add people</button></div>` : ''}
      ${!d.canRun && s.managed && d.myFacilitatorRequest?.status !== 'pending' ? `<div class="school-actions"><button class="btn btn-ghost" onclick="openFacilitatorAsk()">Ask to be a facilitator</button></div>` : ''}
    </header>
    ${facilitatorAskNote()}
    ${!s.managed ? `<div class="callout" style="margin-bottom:16px;"><b>Nobody runs this school yet.</b> Anyone can join it by picking its name. Take it over to add a logo and control who can join. <button class="btn btn-primary btn-sm" style="margin-left:8px;" onclick="schoolClaim()">Become its facilitator</button></div>` : ''}
    ${d.canRun ? schoolSetupCard(s, people) : ''}
    ${schoolRequestsHtml()}
    ${kpiRow([
      { label: 'Students', value: students.length, note: `${students.filter(p => p.status === 'joined').length} joined`, tone: 'blue' },
      { label: 'Teachers and staff', value: staff.length, note: `${staff.filter(p => p.status === 'joined').length} joined`, tone: 'blue' },
      { label: 'Classes', value: d.classCount, note: 'At this school', tone: 'blue' },
      { label: 'Joined', value: people.length ? `${Math.round(100 * joined / people.length)}%` : '–', note: `${joined} of ${people.length}`, tone: 'green', bar: stackBar([[joined, 'done', 'joined'], [invited, 'going', 'invited']], people.length) },
      ...(d.canRun ? [{ label: 'Still to invite', value: uninvited, note: invited ? `${invited} invited` : 'None invited yet', tone: uninvited ? 'amber' : 'blue' }] : [])
    ])}
    ${d.canRun ? `<div class="seg school-tabs" role="group" aria-label="Show">${[['people', 'People'], ['classes', `Classes (${d.classes.length})`]].map(([k, t]) => `<button aria-pressed="${sq.tab === k}" onclick="sq.tab='${k}';schoolDraw()">${t}</button>`).join('')}</div>` : ''}
    ${d.canRun && sq.tab === 'classes' ? schoolClassesHtml() : `<div class="school-bar">
      <input class="input" id="schoolQ" type="search" placeholder="Search names and emails" aria-label="Search people" value="${esc(sq.q)}" oninput="sq.q=this.value;sq.shown=200;schoolDrawRows()" />
      <div class="seg" role="group" aria-label="Show">${[['all', 'Everyone'], ['staff', 'Teachers and staff'], ['student', 'Students']].map(([k, t]) => `<button aria-pressed="${sq.who === k}" onclick="sq.who='${k}';sq.shown=200;schoolDraw()">${t}</button>`).join('')}</div>
      <select class="input" aria-label="Grade" onchange="sq.grade=this.value;sq.shown=200;schoolDrawRows()"><option value="">All grades</option>${d.grades.map(g => `<option value="${g}" ${sq.grade === g ? 'selected' : ''}>Grade ${g}</option>`).join('')}</select>
      ${d.canRun ? `<select class="input" aria-label="Status" onchange="sq.status=this.value;sq.shown=200;schoolDrawRows()"><option value="">Any status</option>${['joined', 'invited', 'added'].map(k => `<option value="${k}" ${sq.status === k ? 'selected' : ''}>${SCHOOL_STATUS[k][0]}</option>`).join('')}</select>` : ''}
    </div>
    <div id="schoolBulk"></div>
    <div id="schoolRows"></div>
    <details class="school-roles"><summary>What each role means</summary>
      <dl>${d.roles.map(r => `<dt>${esc(r.label)}</dt><dd>${esc(r.about)}</dd>`).join('')}</dl></details>`}
  </div>`;
  if (d.canRun && sq.tab === 'classes') schoolDrawClasses(); else schoolDrawRows();
}

/* ---- every class at the school (facilitators) ---- */
const CLASS_ROLES = [['teacher', 'Co-teacher'], ['assistant', 'Assistant teacher'], ['advisor', 'Advisor']];
const listedTeachers = c => c.staff.filter(t => t.role !== 'advisor');
const withTitle = t => (t.title ? `${t.name}, ${t.title}` : t.name);
const nameOptions = (list, chosen) => list.map(t => `<option value="${t.id}" ${t.id === chosen ? 'selected' : ''}>${esc(withTitle(t))}</option>`).join('');
const classRoleOptions = chosen => CLASS_ROLES.map(([k, label]) => `<option value="${k}" ${k === chosen ? 'selected' : ''}>${label}</option>`).join('');
function schoolClassesHtml() {
  return `<div class="school-bar">
      <input class="input" type="search" placeholder="Search classes and teachers" aria-label="Search classes" value="${esc(sq.classQ)}" oninput="sq.classQ=this.value;schoolDrawClasses()" />
    </div>
    <div id="schoolClasses"></div>`;
}
function schoolDrawClasses() {
  const all = sq.data.classes, q = sq.classQ.trim().toLowerCase();
  const list = all.filter(c => !q || `${c.name} ${c.staff.map(t => t.name).join(' ')}`.toLowerCase().includes(q));
  $('schoolClasses').innerHTML = !list.length
    ? `<div class="feed-empty"><b>${all.length ? 'No classes match that' : 'No classes yet'}</b>${all.length ? 'Try a different search.' : 'Classes your teachers create show up here.'}</div>`
    : `<div class="card roster-card"><table class="roster school-table">
      <thead><tr><th>Class</th><th>Teachers</th><th>Term</th><th>Students</th></tr></thead>
      <tbody>${list.map(c => `<tr>
        <td><button class="linklike" onclick="openSchoolClass('${c.id}')">${esc(c.name)}</button>${c.archived ? ' <span class="pill pill-gray">Archived</span>' : ''}${c.inSchool ? '' : ' <span class="pill pill-gray">Not in the school yet</span>'}</td>
        <td>${esc(listedTeachers(c).map(withTitle).join('; ')) || '–'}</td>
        <td>${c.term ? `<span class="pill ${TERM_PILL[c.term.state][1]}">${esc(c.term.name)}</span>` : '–'}</td>
        <td class="roster-num">${c.students.length}</td>
      </tr>`).join('')}</tbody></table></div>`;
}
function schoolClassStaffHtml(c) {
  const d = sq.data, id = c.id, owner = c.staff.find(t => t.role === 'owner'), others = c.staff.filter(t => t !== owner);
  if (!c.inSchool) return `<p class="muted">Its owner, ${esc(owner?.name || 'its teacher')}, hasn’t added this class to the school yet.</p>`;
  const choices = d.teachers.some(t => t.id === owner?.id) ? d.teachers : [owner, ...d.teachers].filter(Boolean);
  const free = d.teachers.filter(t => !c.staff.some(s => s.id === t.id)), elsewhere = d.classes.filter(x => x.inSchool && !x.archived && x.id !== id);
  return `<div class="field"><label for="scOwner">Owner</label><select id="scOwner" class="input" onchange="schoolAssign('${id}',{ userId: this.value, role: 'owner' })">${nameOptions(choices, owner?.id)}</select><div class="hint">The old owner stays on as a co-teacher, so you can move them or take them off.</div></div>
    ${others.map(t => `<div class="class-staff-row"><span class="req-who"><b>${esc(t.name)}</b>${t.title ? ` <span class="tiny muted">${esc(t.title)}</span>` : ''}</span>
      <select class="input input-sm" aria-label="Role for ${esc(t.name)}" onchange="schoolAssign('${id}',{ userId: '${t.id}', role: this.value })">${classRoleOptions(t.role)}</select>
      ${elsewhere.length ? `<select class="input input-sm" aria-label="Move ${esc(t.name)} to another class" onchange="schoolAssign('${id}',{ userId: '${t.id}', moveTo: this.value })"><option value="">Move to…</option>${elsewhere.map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select>` : ''}
      <button class="btn btn-ghost btn-sm" onclick="schoolAssign('${id}',{ userId: '${t.id}', role: null })">Take off</button></div>`).join('')}
    ${free.length ? `<div class="class-staff-row"><select id="scAdd" class="input input-sm" aria-label="Add a teacher"><option value="">Add a teacher</option>${nameOptions(free)}</select>
      <select id="scAddRole" class="input input-sm" aria-label="Their role">${classRoleOptions('teacher')}</select>
      <button class="btn btn-ghost btn-sm" onclick="schoolAddTeacher('${id}')">Add</button></div>` : ''}
    <div id="scErr" class="form-error hidden"></div>`;
}
function openSchoolClass(id) {
  const c = sq.data.classes.find(x => x.id === id);
  openModal({ title: esc(c.name), sub: esc(c.term?.name || ''),
    body: `${schoolClassStaffHtml(c)}<h3 class="school-class-h">Students (${c.students.length})</h3>${c.students.length ? `<ul class="school-class-list">${c.students.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : '<p class="muted" style="margin:0;">No students in this class yet.</p>'}`,
    footer: `<button class="btn btn-ghost" onclick="closeModal()">Close</button>${c.mine ? `<button class="btn btn-primary" onclick="closeModal();VisorRouter.go('/class/${c.id}')">Open class</button>` : ''}` });
}
async function schoolAssign(id, body) {
  try { await api(`/api/school/classes/${id}/teachers`, { method: 'POST', body }); await schoolReload(); openSchoolClass(id); toast('Teachers updated'); }
  catch (e) { formError('scErr', e.message); }
}
function schoolAddTeacher(id) {
  if (!$('scAdd').value) return formError('scErr', 'Pick a teacher first.');
  schoolAssign(id, { userId: $('scAdd').value, role: $('scAddRole').value });
}

/* ---- asking to be a facilitator ---- */
function facilitatorAskNote() {
  const ask = sq.data.myFacilitatorRequest, names = sq.data.school.facilitators.join(', ');
  if (ask?.status === 'pending') return `<div class="callout" style="margin-bottom:16px;">Your request to be a facilitator is with ${esc(names)}. <button class="linklike" onclick="withdrawFacilitatorAsk()">Withdraw it</button></div>`;
  return ask?.status === 'declined' ? `<div class="callout" style="margin-bottom:16px;">Your request to be a facilitator was declined. You can ask again.</div>` : '';
}
function openFacilitatorAsk() {
  openModal({ title: 'Ask to be a facilitator', sub: 'Facilitators run the school: its logo, people, roles, grades and invites.',
    body: `<div class="field"><label for="faNote">Add a note <span class="label-note">optional</span></label><input id="faNote" class="input" maxlength="300" placeholder="Why you’d like to help run the school" /></div><div id="faErr" class="form-error hidden"></div>`,
    footer: `<button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="sendFacilitatorAsk()">Send request</button>` });
}
async function sendFacilitatorAsk() {
  try { schoolUserChanged((await api('/api/school/facilitator-request', { method: 'POST', body: { note: $('faNote').value } })).user); closeModal(); toast('Your request was sent'); await schoolReload(); }
  catch (e) { formError('faErr', e.message); }
}
async function withdrawFacilitatorAsk() {
  try { schoolUserChanged((await api('/api/school/facilitator-request', { method: 'DELETE' })).user); await schoolReload(); }
  catch (e) { toast(e.message, 'err'); }
}

function schoolFiltered() {
  const q = sq.q.trim().toLowerCase();
  return sq.data.people.filter(p => (sq.who === 'all' || (sq.who === 'student') === isStudentRow(p))
    && (!sq.grade || p.grades.includes(sq.grade)) && (!sq.status || p.status === sq.status)
    && (!q || `${p.name} ${p.email}`.toLowerCase().includes(q)));
}
function schoolDrawRows() {
  const d = sq.data, list = schoolFiltered(), shown = list.slice(0, sq.shown), run = d.canRun;
  $('schoolRows').innerHTML = !d.people.length || !list.length
    ? `<div class="feed-empty"><b>${d.people.length ? 'Nobody matches that' : 'Nobody here yet'}</b>${d.people.length ? 'Try a different search or filter.' : run ? 'Add people to start.' : ''}</div>`
    : `<div class="card roster-card"><table class="roster school-table">
      <thead><tr>${run ? `<th class="school-check"><input type="checkbox" aria-label="Select everyone shown" ${shown.every(p => sq.picked.has(p.id)) ? 'checked' : ''} onchange="schoolPickAll(this.checked)" /></th>` : ''}<th>Name</th><th>Role</th><th>Grades</th><th>Status</th>${run ? '<th><span class="sr-only">Actions</span></th>' : ''}</tr></thead>
      <tbody>${shown.map(p => `<tr>
        ${run ? `<td class="school-check"><input type="checkbox" aria-label="Select ${esc(p.name || p.email)}" ${sq.picked.has(p.id) ? 'checked' : ''} onchange="schoolPick('${p.id}',this.checked)" /></td>` : ''}
        <td><div class="roster-name">${avatarHtml({ name: p.name || p.email, avatarColor: p.avatarColor, avatarUrl: p.avatarUrl }, 'avatar-sm')}<span><b>${esc(p.name || p.email)}</b>${p.title ? `<div class="tiny muted">${esc(p.title)}</div>` : ''}${p.name ? `<div class="tiny muted">${esc(p.email)}</div>` : ''}</span></div></td>
        <td><span class="pill ${ROLE_PILL[p.role] || 'pill-gray'}">${esc(schoolRoleLabel(p.role))}</span></td>
        <td class="roster-num">${p.grades.length ? esc(p.grades.join(', ')) : '–'}</td>
        <td><span class="pill ${SCHOOL_STATUS[p.status][1]}">${SCHOOL_STATUS[p.status][0]}</span></td>
        ${run ? `<td>${ddHtml({ id: `sp-${p.id}`, btnClass: 'btn-icon', btn: I.gear, label: `Options: ${p.name || p.email}`, right: true, items: [
          { label: isStudentRow(p) ? 'Edit role and grades' : 'Edit role, grades and title', icon: I.edit, onclick: `openSchoolEdit(['${p.id}'])` },
          ...(p.status === 'joined' ? [] : [{ label: d.mailReady ? 'Send invite' : 'Copy invite link', icon: I.copy, onclick: d.mailReady ? `schoolSend(['${p.id}'])` : `schoolCopyLinks(['${p.id}'])` }, ...(d.mailReady ? [{ label: 'Copy invite link', icon: I.copy, onclick: `schoolCopyLinks(['${p.id}'])` }] : [])]),
          { label: 'Remove from school', icon: I.trash, onclick: `schoolRemove(['${p.id}'])`, danger: true }] })}</td>` : ''}
      </tr>`).join('')}</tbody></table>
      ${list.length > shown.length ? `<div class="school-more"><button class="btn btn-ghost btn-sm" onclick="sq.shown+=400;schoolDrawRows()">Show more (${list.length - shown.length})</button></div>` : ''}</div>`;
  schoolDrawBulk();
}
function schoolDrawBulk() {
  const n = sq.picked.size;
  $('schoolBulk').innerHTML = !n ? '' : `<div class="school-bulk"><b>${n} selected</b>
    <button class="btn btn-ghost btn-sm" onclick="openSchoolEdit([...sq.picked])">${I.edit}Set role or grades</button>
    <button class="btn btn-ghost btn-sm" onclick="${sq.data.mailReady ? 'schoolSend' : 'schoolCopyLinks'}([...sq.picked])">${sq.data.mailReady ? 'Send invites' : 'Copy invite links'}</button>
    <button class="btn btn-ghost btn-sm" onclick="schoolRemove([...sq.picked])">${I.trash}Remove</button>
    <button class="linklike" onclick="sq.picked.clear();schoolDrawRows()">Clear</button></div>`;
}
function schoolPick(id, on) { if (on) sq.picked.add(id); else sq.picked.delete(id); schoolDrawBulk(); }
function schoolPickAll(on) { for (const p of schoolFiltered().slice(0, sq.shown)) if (on) sq.picked.add(p.id); else sq.picked.delete(p.id); schoolDrawRows(); }

/* ---- no school yet, and setting one up ---- */
function schoolDrawNone(el) {
  const r = me.schoolRequest;
  el.innerHTML = `<div class="page narrow"><div class="card card-pad school-none">
    <span class="school-logo">${I.school}</span>
    <h1>Your School</h1>
    ${r?.status === 'pending' ? `<p class="muted">Your request to join <b>${esc(r.school.name)}</b> is with its facilitator.</p><button class="btn btn-ghost" onclick="withdrawSchoolRequest()">Withdraw it</button>`
      : `<p class="muted">Classes belong to a school. Find yours and ask to join, or create it. You’ll set up its logo, terms and people next.</p>${schoolAskHtml('noSchool')}
    <div class="school-or"><span>or</span></div>
    <div class="field"><label for="snName">Create a new school</label><input id="snName" class="input" maxlength="120" placeholder="Lincoln High School" /></div>
    <div id="snErr" class="form-error hidden"></div>
    <button class="btn btn-ghost" onclick="schoolCreate()">Create school</button>`}</div></div>`;
  if ($('noSchool')) mountSchoolPicker('noSchool', null);
}
async function schoolCreate() {
  try { const r = await api('/api/school', { method: 'POST', body: { name: $('snName').value } }); schoolUserChanged(r.user); await schoolReload(); }
  catch (e) { formError('snErr', e.message); }
}
async function schoolClaim() {
  if (!await confirmModal('Become this school’s facilitator?', 'You’ll choose who can join from now on. People already in the school stay in it.', { okLabel: 'Become facilitator' })) return;
  try { const r = await api('/api/school/claim', { method: 'POST', body: {} }); schoolUserChanged(r.user); await schoolReload(); }
  catch (e) { toast(e.message, 'err'); }
}
function schoolSetupCard(s, people) {
  const others = people.filter(p => p.status !== 'joined' || p.email !== me.email);
  const steps = [
    { done: !!s.logoUrl, title: 'Add your logo', go: 'openSchoolSettings()', label: 'Add logo' },
    { done: others.length > 0, title: 'Add your people', go: 'openAddPeople()', label: 'Add people' },
    { done: others.some(p => p.status !== 'added'), title: 'Invite them', go: 'schoolInviteAll()', label: 'Invite', off: !others.length }
  ];
  if (steps.every(st => st.done)) return '';
  return `<section class="setup-card"><h2>Set up ${esc(s.name)}</h2><ol>${steps.map((st, i) => `<li class="${st.done ? 'done' : ''}"><span class="setup-n">${st.done ? I.check : i + 1}</span><span class="setup-t">${st.title}</span>${st.done ? '' : `<button class="btn btn-sm ${steps.findIndex(x => !x.done) === i ? 'btn-primary' : 'btn-ghost'}" ${st.off ? 'disabled' : ''} onclick="${st.go}">${st.label}</button>`}</li>`).join('')}</ol></section>`;
}

/* ---- requests to join ---- */
function schoolRequestsHtml() {
  const list = sq.data.requests, asks = sq.data.facilitatorRequests;
  return (list.length ? `<section class="school-requests"><h2>Requests to join <span class="side-n">${list.length}</span></h2>${list.map(r => `<div class="req-row">
    ${avatarHtml({ name: r.name, avatarColor: r.avatarColor, avatarUrl: r.avatarUrl }, 'avatar-sm')}
    <div class="req-who"><b>${esc(r.name)}</b> <span class="tiny muted">${esc(r.email)}</span>
      <div class="tiny muted">${r.account === 'student' ? 'Student' : 'Teacher'} account · ${r.confirmed ? 'email confirmed by Google' : 'Visor hasn’t confirmed this email'}${r.className ? ` · for ${esc(r.className)}` : ''}</div>
      ${r.note ? `<div class="small">${esc(r.note)}</div>` : ''}</div>
    <select class="input input-sm" id="rqRole-${r.id}" aria-label="Role for ${esc(r.name)}">${sq.data.roles.filter(x => (x.id === 'student') === (r.account === 'student')).map(x => `<option value="${x.id}" ${x.id === (r.account === 'student' ? 'student' : 'teacher') ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select>
    <input class="input input-sm req-grades" id="rqGrades-${r.id}" aria-label="Grades for ${esc(r.name)}" placeholder="Grades" />
    <button class="btn btn-primary btn-sm" onclick="schoolAnswer('${r.id}',true)">Approve</button>
    <button class="btn btn-ghost btn-sm" onclick="schoolAnswer('${r.id}',false)">Decline</button>
  </div>`).join('')}</section>` : '') + (asks.length ? `<section class="school-requests"><h2>Requests to be a facilitator <span class="side-n">${asks.length}</span></h2>${asks.map(r => `<div class="req-row">
    ${avatarHtml({ name: r.name, avatarColor: r.avatarColor, avatarUrl: r.avatarUrl }, 'avatar-sm')}
    <div class="req-who"><b>${esc(r.name)}</b> <span class="tiny muted">${esc(r.email)}</span>
      ${r.note ? `<div class="small">${esc(r.note)}</div>` : ''}</div>
    <button class="btn btn-primary btn-sm" onclick="facilitatorAnswer('${r.id}',true)">Approve</button>
    <button class="btn btn-ghost btn-sm" onclick="facilitatorAnswer('${r.id}',false)">Decline</button>
  </div>`).join('')}</section>` : '');
}
async function schoolAnswer(id, approve) {
  const body = approve ? { approve, role: $(`rqRole-${id}`).value, grades: $(`rqGrades-${id}`).value.split(/[,\s]+/).flatMap(c => SchoolPaste.gradesOf(c) || []) } : { approve };
  try { await api(`/api/school/requests/${id}`, { method: 'POST', body }); toast(approve ? 'Approved' : 'Declined'); await schoolReload(); }
  catch (e) { toast(e.message, 'err'); }
}

async function facilitatorAnswer(id, approve) {
  try { await api(`/api/school/facilitator-requests/${id}`, { method: 'POST', body: { approve } }); toast(approve ? 'They’re a facilitator now' : 'Declined'); await schoolReload(); }
  catch (e) { toast(e.message, 'err'); }
}

/* ---- settings ---- */
function openSchoolSettings() {
  const s = sq.data.school;
  openModal({ title: 'School settings', body: `
    <div class="school-logo-row"><span class="school-logo" id="ssLogo">${s.logoUrl ? `<img src="${esc(s.logoUrl)}" alt="" />` : I.school}</span>
      <div><label class="btn btn-ghost btn-sm prof-file">${s.logoUrl ? 'Replace logo' : 'Upload logo'}<input class="sr-only" type="file" accept="image/png,image/jpeg,image/webp" onchange="schoolPickLogo(this.files[0])" /></label>
      ${s.logoUrl ? '<button class="btn btn-ghost btn-sm" onclick="schoolRemoveLogo()">Remove</button>' : ''}<div class="hint">PNG, JPEG or WebP. It shows on your school’s pages and on invites, so anyone with an invite can see it.</div></div></div>
    <div class="field"><label for="ssName">School name</label><input id="ssName" class="input" maxlength="120" value="${esc(s.name)}" /></div>
    <div id="ssErr" class="form-error hidden"></div>`,
    footer: `<button class="btn btn-ghost" onclick="closeModal()">Close</button><button class="btn btn-primary" onclick="schoolSaveName()">Save</button>` });
}
// Fits inside a square, keeping its shape and any transparency
async function schoolLogoBlob(file, size = 320) {
  let bmp;
  try { bmp = await createImageBitmap(file); } catch { throw new Error('That image couldn’t be read. Try a PNG or JPEG.'); }
  const scale = Math.min(1, size / Math.max(bmp.width, bmp.height)), cv = document.createElement('canvas');
  cv.width = Math.round(bmp.width * scale); cv.height = Math.round(bmp.height * scale);
  cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
  bmp.close();
  return new Promise(r => cv.toBlob(r, 'image/png'));
}
async function schoolPickLogo(file) {
  if (!file) return;
  try {
    const r = await fetch('/api/school/logo', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: await schoolLogoBlob(file) });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error || 'That logo couldn’t be saved.');
    schoolUserChanged(out.user); await schoolReload(); openSchoolSettings(); toast('Logo saved');
  } catch (e) { formError('ssErr', e.message); }
}
async function schoolRemoveLogo() {
  try { const r = await api('/api/school/logo', { method: 'DELETE' }); schoolUserChanged(r.user); await schoolReload(); openSchoolSettings(); }
  catch (e) { formError('ssErr', e.message); }
}
async function schoolSaveName() {
  try { const r = await api('/api/school', { method: 'PATCH', body: { name: $('ssName').value } }); schoolUserChanged(r.user); closeModal(); await schoolReload(); toast('Saved'); }
  catch (e) { formError('ssErr', e.message); }
}

/* ---- adding people: paste a list, check it, add it ---- */
function openAddPeople() {
  sq.add = { rows: [], bad: [], role: 'student', grades: [] };
  const example = 'maya@school.org\nJo Park, jo@school.org, teacher, 9-10\nsam@school.org, student, grade 10';
  openModal({ title: 'Add people', sub: 'Paste email addresses, or columns copied from a spreadsheet. Name, role and grades are picked up from each line, in any order.', wide: true, keep: true, body: `
    <div class="field"><textarea id="apText" class="input mono" rows="6" aria-label="People to add" placeholder="${esc(example)}" oninput="apParse()"></textarea>
      <label class="linklike ap-file">Upload a CSV file<input class="sr-only" type="file" accept=".csv,.tsv,.txt" onchange="apFile(this.files[0])" /></label></div>
    <div class="ap-defaults">
      <div class="field"><label for="apRole">Anyone without a role is a</label><select id="apRole" class="input" onchange="sq.add.role=this.value;apDraw()">${roleOptions('student')}</select></div>
      <div class="field"><label id="apGradeLabel">Anyone without a grade is in</label><div class="grade-chips" id="apGrades" role="group" aria-labelledby="apGradeLabel">${gradeChips([], "toggleGradeChip(this);sq.add.grades=chosenGrades($('apGrades'));apDraw()")}</div></div>
    </div>
    <div id="apPreview"></div><div id="apErr" class="form-error hidden"></div>`,
    footer: `<label class="check-row ap-send ${sq.data.mailReady ? '' : 'hidden'}"><input id="apSend" type="checkbox" ${sq.data.mailReady ? 'checked' : ''} /> <span>Email them invites now</span></label>
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-primary" id="apGo" disabled onclick="apSubmit()">Add people</button>` });
  setTimeout(() => $('apText')?.focus(), 50);
}
function apParse() {
  const { rows, bad } = SchoolPaste.parse($('apText').value);
  // What's been changed in the preview stays, for addresses still in the list
  const before = new Map(sq.add.rows.map(r => [r.email, r]));
  sq.add.rows = rows.map(r => ({ ...r, ...(before.get(r.email)?.edited ? { role: before.get(r.email).role, grades: before.get(r.email).grades, edited: true } : {}) }));
  sq.add.bad = bad;
  apDraw();
}
async function apFile(file) {
  if (!file) return;
  const t = $('apText');
  t.value = `${t.value.trim() ? `${t.value.trim()}\n` : ''}${await file.text()}`;
  apParse();
}
const apRole = r => r.role || sq.add.role;
const apGrades = r => (r.grades.length ? r.grades : sq.add.grades);
function apDraw() {
  const { rows, bad } = sq.add, shown = rows.slice(0, 200);
  const count = roles => rows.filter(r => roles.includes(apRole(r))).length;
  const students = count(['student']), staff = rows.length - students;
  $('apGo').disabled = !rows.length;
  $('apGo').textContent = rows.length ? `Add ${vcPlural(rows.length, 'person', 'people')}` : 'Add people';
  $('apPreview').innerHTML = !rows.length && !bad.length ? '' : `
    <div class="ap-sum">${[students ? vcPlural(students, 'student') : '', staff ? `${staff} staff` : ''].filter(Boolean).join(' · ')}${bad.length ? `<span class="ap-bad">${vcPlural(bad.length, 'line')} with no email: ${esc(bad.slice(0, 2).join(' / ').slice(0, 80))}</span>` : ''}</div>
    ${rows.length ? `<div class="ap-table"><table class="roster"><thead><tr><th>Email</th><th>Name</th><th>Role</th><th>Grades</th></tr></thead><tbody>${shown.map((r, i) => `<tr>
      <td class="ap-email">${esc(r.email)}</td>
      <td><input class="input input-sm" aria-label="Name" value="${esc(r.name)}" onchange="sq.add.rows[${i}].name=this.value" /></td>
      <td><select class="input input-sm" aria-label="Role" onchange="apSet(${i},'role',this.value)">${roleOptions(apRole(r))}</select></td>
      <td><input class="input input-sm ap-grades" aria-label="Grades" value="${esc(apGrades(r).join(', '))}" placeholder="None" onchange="apSetGrades(${i},this.value)" /></td></tr>`).join('')}</tbody></table>
      ${rows.length > shown.length ? `<div class="tiny muted" style="padding:8px 12px;">and ${rows.length - shown.length} more</div>` : ''}</div>` : ''}`;
}
function apSet(i, key, value) { const r = sq.add.rows[i]; r[key] = value; r.grades = apGrades(r); r.edited = true; apDraw(); }
function apSetGrades(i, text) {
  const r = sq.add.rows[i];
  r.grades = text.split(/[,\s]+/).flatMap(c => SchoolPaste.gradesOf(c) || []);
  r.role = apRole(r); r.edited = true;
  apDraw();
}
async function apSubmit() {
  const send = $('apSend').checked, go = $('apGo');
  go.disabled = true;
  try {
    const people = sq.add.rows.map(r => ({ email: r.email, name: r.name, role: apRole(r), grades: apGrades(r) }));
    const r = await api('/api/school/people', { method: 'POST', body: { people } });
    closeModal();
    const said = [r.added ? `Added ${vcPlural(r.added, 'person', 'people')}` : '', r.updated ? `updated ${r.updated}` : '', r.skipped.length ? `skipped ${r.skipped.length}` : ''].filter(Boolean).join(', ');
    toast(said || 'Nothing to add', r.skipped.length ? 'warn' : '');
    await schoolReload();
    if (send && r.ids.length) await schoolSend(r.ids);
  } catch (e) { go.disabled = false; formError('apErr', e.message); }
}

/* ---- editing ---- */
function openSchoolEdit(ids) {
  const people = sq.data.people.filter(p => ids.includes(p.id)), one = people.length === 1 ? people[0] : null;
  openModal({ title: one ? (one.name || one.email) : `Edit ${vcPlural(people.length, 'person', 'people')}`, sub: one ? one.email : 'Only what you set here changes.', body: `
    ${one && one.status !== 'joined' ? `<div class="field"><label for="seName">Name</label><input id="seName" class="input" value="${esc(one.name)}" /></div>` : ''}
    ${one && !isStudentRow(one) ? `<div class="field"><label for="seTitle">Title <span class="label-note">optional</span></label><input id="seTitle" class="input" maxlength="60" value="${esc(one.title || '')}" placeholder="Head of English" /><div class="hint">Shown with their name in Your School and in their classes.</div></div>` : ''}
    <div class="field"><label for="seRole">Role</label><select id="seRole" class="input">${one ? '' : '<option value="">Keep each person’s role</option>'}${roleOptions(one?.role)}</select></div>
    <div class="field"><label id="seGradeLabel">Grades</label><div class="grade-chips" id="seGrades" role="group" aria-labelledby="seGradeLabel">${gradeChips(one?.grades || [], 'toggleGradeChip(this)')}</div>
      ${one ? '' : '<label class="check-row" style="margin-top:8px;"><input id="seGradesOn" type="checkbox" /> <span>Set these grades for everyone selected</span></label>'}</div>
    <div id="seErr" class="form-error hidden"></div>`,
    footer: `<button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick='schoolSaveEdit(${JSON.stringify(ids)})'>Save</button>` });
}
async function schoolSaveEdit(ids) {
  const body = { ids }, role = $('seRole').value, gradesOn = $('seGradesOn');
  if (role) body.role = role;
  if (!gradesOn || gradesOn.checked) body.grades = chosenGrades($('seGrades'));
  if ($('seName')) body.name = $('seName').value;
  if ($('seTitle')) body.title = $('seTitle').value;
  try { await api('/api/school/people/update', { method: 'POST', body }); closeModal(); await schoolReload(); toast('Saved'); }
  catch (e) { formError('seErr', e.message); }
}
async function schoolRemove(ids) {
  const n = ids.length;
  if (!await confirmModal(`Remove ${vcPlural(n, 'person', 'people')} from the school?`, 'Anyone who already joined leaves the school. Their account, classes and work stay.', { okLabel: 'Remove', danger: true })) return;
  try { await api('/api/school/people/remove', { method: 'POST', body: { ids } }); sq.picked.clear(); await schoolReload(); toast('Removed'); }
  catch (e) { toast(e.message, 'err'); }
}

/* ---- invites ---- */
function schoolInviteAll() {
  const ids = sq.data.people.filter(p => p.status === 'added').map(p => p.id);
  if (!ids.length) return openAddPeople();
  return sq.data.mailReady ? schoolSend(ids) : schoolCopyLinks(ids);
}
// A few at a time, so a big school's list can't time out, and shows progress
async function schoolSend(ids) {
  const waiting = sq.data.people.filter(p => ids.includes(p.id) && p.status !== 'joined').map(p => p.id);
  if (!waiting.length) return toast('Everyone selected has already joined.');
  openModal({ title: 'Sending invites', closable: false, body: `<p id="siNow">Sending 0 of ${waiting.length}…</p><div class="sbar"><i class="s-going" id="siBar" style="width:0%"></i></div>` });
  let sent = 0, stopped = null;
  try {
    for (let i = 0; i < waiting.length && !stopped; i += INVITE_BATCH) {
      const r = await api('/api/school/invites', { method: 'POST', body: { ids: waiting.slice(i, i + INVITE_BATCH) } });
      sent += r.sent; stopped = r.stopped;
      $('siNow').textContent = `Sending ${sent} of ${waiting.length}…`;
      $('siBar').style.width = `${100 * sent / waiting.length}%`;
    }
  } catch (e) { stopped = e.message; }
  closeModal();
  await schoolReload();
  if (stopped) toast(`${vcPlural(sent, 'invite')} sent. ${stopped}`, 'warn'); else toast(`${vcPlural(sent, 'invite')} sent`);
}
async function schoolCopyLinks(ids) {
  try {
    const { links } = await api('/api/school/invites', { method: 'POST', body: { ids, copy: true } });
    if (!links.length) return toast('Everyone selected has already joined.');
    if (links.length === 1) { await navigator.clipboard.writeText(links[0].link); return toast(`Link for ${links[0].email} copied. It works for 30 days.`); }
    const text = links.map(l => `${l.email}\t${l.link}`).join('\n');
    openModal({ title: 'Invite links', sub: `One link for each person, for 30 days. Each works only for that person’s email address. Paste them into a spreadsheet or mail merge.`, wide: true, body: `<textarea id="ilText" class="input mono" rows="10" readonly aria-label="Invite links">${esc(text)}</textarea>`,
      footer: `<button class="btn btn-ghost" onclick="closeModal()">Close</button><button class="btn btn-primary" onclick="navigator.clipboard.writeText($('ilText').value).then(()=>toast('Links copied'))">${I.copy}Copy all</button>` });
  } catch (e) { toast(e.message, 'err'); }
}
