/* Visor Classroom — assignment forms (Writing, Group project, Discussion) and
   the assignment page (/a/:id). The Live tab is live.js; groups and
   discussions add their own panels (groups below, discussions.js). */

'use strict';

// ISO <-> <input type="datetime-local">
const toLocalInput = iso => { if (!iso) return ''; const d = new Date(iso); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
const fromLocalInput = v => (v ? new Date(v).toISOString() : null);
const siteLines = list => (list || []).join('\n');
const STYLE_NAME = { mla: 'MLA 9', apa: 'APA 7', chicago: 'Chicago' };

/* ====================== create / edit form ====================== */
let af = null; // { classId, type, a (existing or null), groups, students, folders, folderId }

// opts.folderId: the folder a new assignment goes in (Add Materials inside a folder)
async function openAssignmentForm(classId, type, existing = null, opts = {}) {
  // The roster and folders of this assignment's class (not whichever class page was open last)
  let students = cp?.cls?.id === classId ? cp.cls.students : null, folders = cp?.cls?.id === classId ? cp.folders : null;
  if (!students || !folders) { try { const r = await api(`/api/classes/${classId}`); students = r.class.students; folders = r.folders || []; } catch {} }
  const folderId = existing ? existing.folderId || '' : opts.folderId || '';
  af = { classId, type, a: existing, students: students || [], folders: folders || [], folderId, groups: JSON.parse(JSON.stringify(existing?.group?.groups || [])) };
  const a = existing || { title: '', instructions: '', dueAt: null, writing: CFG.writingPresets?.homework?.writing, discussion: { date: null, shareOwnStats: false } };
  const titles = { writing: 'writing assignment', group: 'group project', discussion: 'discussion' };
  const common = `
    <div class="field"><label for="afTitle">Title</label><input id="afTitle" class="input" maxlength="200" value="${esc(a.title)}" placeholder="${type === 'writing' ? 'e.g. Argument essay: school start times' : type === 'group' ? 'e.g. Civil rights movement presentation' : 'e.g. Socratic seminar: Chapter 4'}" /></div>
    <div class="field"><label for="afInstr">${type === 'discussion' ? 'Prompt' : 'Instructions'}</label><textarea id="afInstr" class="input" maxlength="20000" placeholder="What students should do. Line breaks are kept.">${esc(a.instructions)}</textarea></div>
    <div class="form-grid" style="margin-top:0;">
      <div class="field"><label for="afDue">Due <span class="label-note">optional</span></label><input id="afDue" class="input" type="datetime-local" value="${toLocalInput(a.dueAt)}" /></div>
      ${af.folders.length ? `<div class="field"><label for="afFolder">Folder</label><select id="afFolder" class="input">${folderOptions(af.folders, af.folderId)}</select></div>` : ''}
    </div>`;
  let extra = '';
  if (type === 'writing') extra = writingFields(a.writing || CFG.writingPresets.homework.writing, !existing);
  if (type === 'group') extra = `<div class="kicker" style="margin:18px 0 8px;">Groups</div><div id="afGroups"></div>`;
  if (type === 'discussion') extra = `
    <div class="field"><label for="afDiscDate">Discussion date</label><input id="afDiscDate" class="input" type="datetime-local" value="${toLocalInput(a.discussion?.date)}" /></div>
    <label class="check-row"><input id="afShare" type="checkbox" ${a.discussion?.shareOwnStats ? 'checked' : ''} /> <span>Let each student see their own talk time and turns (never anyone else’s)</span></label>`;
  openModal({ title: `${existing ? 'Edit' : 'New'} ${titles[type]}`, wide: true, body: common + extra + `<div id="afErr" class="form-error hidden"></div>`,
    footer: `<button class="btn btn-ghost" onclick="closeModal()">Cancel</button>${existing ? '' : `<button class="btn btn-ghost" onclick="saveAssignment(false)">Save as draft</button>`}<button class="btn btn-primary" onclick="saveAssignment(${existing ? 'null' : 'true'})">${existing ? 'Save changes' : 'Save and publish'}</button>` });
  if (type === 'writing') syncWritingForm();
  if (type === 'group') renderGroupBuilder();
  setTimeout(() => $('afTitle')?.focus(), 50);
}

// <option>s for every folder, indented under its parent
function folderOptions(folders, current) {
  const out = [`<option value="" ${!current ? 'selected' : ''}>None (the top of the class)</option>`];
  const walk = (parentId, depth) => folders.filter(f => (f.parentId || null) === parentId)
    .sort((x, y) => matPos(x) - matPos(y) || (x.createdAt < y.createdAt ? 1 : -1))
    .forEach(f => { out.push(`<option value="${f.id}" ${f.id === current ? 'selected' : ''}>${'\u2003'.repeat(depth)}${esc(f.name)}</option>`); walk(f.id, depth + 1); });
  walk(null, 0);
  return out.join('');
}

function writingFields(w, showPresets) {
  const opt = (v, cur, label) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${label}</option>`;
  const docStyle = w.docStyle === 'docs' ? 'docs' : 'mla'; // missing on older assignments: MLA
  return `
    ${showPresets ? `<div class="kicker" style="margin:16px 0 8px;">Start from a preset</div>
    <div class="preset-row">
      <button type="button" class="choice preset" onclick="applyPreset('in-class')"><div class="t">In-class essay (locked)</div><div class="d">45 minutes · Visor extension required · pasting only from this essay · AI sites blocked · submits at time up</div></button>
      <button type="button" class="choice preset" onclick="applyPreset('homework')"><div class="t">Homework essay (open)</div><div class="d">No time limit · pasting allowed · research recorded · AI sites blocked</div></button>
    </div>` : ''}
    <div class="form-grid">
      <fieldset class="field"><legend>Session type</legend>
        <label class="radio-row"><input type="radio" name="afMode" value="locked" ${w.mode === 'locked' ? 'checked' : ''} onchange="syncWritingForm()" /> <span><b>Locked</b> (in class): needs the Visor extension, keeps students on allowed sites, strict</span></label>
        <label class="radio-row"><input type="radio" name="afMode" value="open" ${w.mode !== 'locked' ? 'checked' : ''} onchange="syncWritingForm()" /> <span><b>Open</b> (homework): records everything, blocks nothing it doesn’t have to</span></label>
      </fieldset>
      <div class="field"><label for="afLimit">Time limit (minutes)</label><input id="afLimit" class="input" type="number" min="1" max="600" value="${w.timeLimitMin ?? ''}" placeholder="No limit" /><div class="hint">Per student, across all their sessions. Extra time from the class roster is added.</div></div>
      <div class="field"><label for="afWinStart">Sessions can start from <span class="label-note">optional</span></label><input id="afWinStart" class="input" type="datetime-local" value="${toLocalInput(w.windowStart)}" /></div>
      <div class="field"><label for="afWinEnd">…until <span class="label-note">optional</span></label><input id="afWinEnd" class="input" type="datetime-local" value="${toLocalInput(w.windowEnd)}" /><div class="hint">Sessions still open at this time end automatically.</div></div>
      <div class="field"><label for="afPaste">Pasting</label><select id="afPaste" class="input">${opt('allow', w.allowPaste, 'Allowed (every paste is recorded)')}${opt('internal-only', w.allowPaste, 'Only text copied from this same essay')}${opt('block', w.allowPaste, 'Off')}</select></div>
      <div class="field"><label for="afStyle">Citation style</label><select id="afStyle" class="input">${opt('mla', w.citationStyle, 'MLA 9')}${opt('apa', w.citationStyle, 'APA 7')}${opt('chicago', w.citationStyle, 'Chicago')}</select></div>
      <div class="field" style="grid-column:1/-1;"><label for="afDocStyle">Document style</label><select id="afDocStyle" class="input" style="max-width:420px;">${opt('mla', docStyle, 'MLA essay (Times New Roman 12, double-spaced)')}${opt('docs', docStyle, 'Docs default (Arial 11, 1.15 spacing)')}</select><div class="hint">The font, size and line spacing every essay starts with. Students can still change them as they write.</div></div>
      <div class="field"><label for="afMin">Minimum words <span class="label-note">optional</span></label><input id="afMin" class="input" type="number" min="1" value="${w.minWords ?? ''}" /></div>
      <div class="field"><label for="afMax">Maximum words <span class="label-note">optional</span></label><input id="afMax" class="input" type="number" min="1" value="${w.maxWords ?? ''}" /></div>
    </div>
    <label class="check-row"><input id="afExt" type="checkbox" ${w.requireExtension ? 'checked' : ''} /> <span>Require the Visor extension to start a session <span class="muted small" id="afExtNote"></span></span></label>
    <label class="check-row"><input id="afResearch" type="checkbox" ${w.researchTracking ? 'checked' : ''} /> <span>Record research during sessions (searches, pages visited and for how long, text copied). Only while a session is running.</span></label>
    <label class="check-row"><input id="afBlockAi" type="checkbox" ${w.blockAiSites ? 'checked' : ''} /> <span>Block AI sites during sessions (on by default; when it's off, visits are only recorded). Blocking works through the Visor extension.</span></label>
    <label class="check-row" id="afPanelRow"><input id="afPanel" type="checkbox" ${w.panelBrowsing !== false ? 'checked' : ''} /> <span>Let students switch to the side panel to research (leaves full screen; blocked and AI sites stay blocked, everything is recorded) <span class="muted small" id="afPanelNote"></span></span></label>
    <label class="check-row"><input id="afCite" type="checkbox" ${w.oneClickCite !== false ? 'checked' : ''} /> <span>Let students cite a page in one click with the Visor extension (Cite this page, right-click, Alt+Shift+C). Sources added by hand always work.</span></label>
    <label class="check-row"><input id="afAuto" type="checkbox" ${w.autoSubmitOnTimeUp ? 'checked' : ''} /> <span>Submit automatically when time runs out</span></label>
    <details class="more"><summary>Sites, starter text and pauses</summary>
      <div class="field" id="afAllowedWrap"><label for="afAllowed">Allowed sites in locked sessions <span class="label-note">optional</span></label><textarea id="afAllowed" class="input mono small" style="min-height:70px;" placeholder="One per line, e.g. en.wikipedia.org&#10;Leave empty to allow any site that isn't blocked">${esc(siteLines(w.allowedSites))}</textarea></div>
      <div class="field"><label for="afBlocked">AI and answer sites</label><textarea id="afBlocked" class="input mono small" style="min-height:90px;">${esc(siteLines(w.blockedSites || CFG.defaultAiSites))}</textarea><div class="hint">Blocked when the box above is ticked; recorded either way. <button type="button" class="linklike" onclick="$('afBlocked').value=CFG.defaultAiSites.join('\\n')">Reset to Visor’s list</button></div></div>
      <div class="field"><label for="afTemplate">Starter text <span class="label-note">optional</span></label><textarea id="afTemplate" class="input" maxlength="20000" placeholder="Copied into every student's essay at the start (e.g. headings to fill in). It's marked as yours, not theirs.">${esc(w.templateText || '')}</textarea></div>
      <div class="field"><label for="afGrace">Seconds away before a pause is recorded</label><input id="afGrace" class="input" type="number" min="0" max="600" value="${w.pauseGraceSec || 0}" style="max-width:120px;" /><div class="hint">0 records every time a student leaves the tab. Writing is always turned off while they’re away.</div></div>
    </details>`;
}

function applyPreset(key) {
  const w = CFG.writingPresets[key].writing;
  document.querySelector(`input[name=afMode][value=${w.mode}]`).checked = true;
  $('afLimit').value = w.timeLimitMin ?? ''; $('afPaste').value = w.allowPaste;
  $('afExt').checked = w.requireExtension; $('afResearch').checked = w.researchTracking;
  $('afBlockAi').checked = w.blockAiSites; $('afAuto').checked = w.autoSubmitOnTimeUp;
  if (w.mode === 'locked') $('afPanel').checked = w.panelBrowsing !== false;
  document.querySelectorAll('.preset').forEach(b => b.classList.toggle('selected', b.getAttribute('onclick').includes(key)));
  syncWritingForm();
  toast(`${CFG.writingPresets[key].label} settings filled in`);
}
function syncWritingForm() {
  const locked = document.querySelector('input[name=afMode]:checked')?.value === 'locked';
  if (locked) $('afExt').checked = true;
  $('afExt').disabled = locked;
  $('afExtNote').textContent = locked ? '(always on for locked sessions)' : '';
  $('afAllowedWrap').classList.toggle('dim', !locked);
  // The side panel only matters in locked sessions (open ones can always use it)
  $('afPanel').disabled = !locked;
  $('afPanelRow').classList.toggle('dim', !locked);
  $('afPanelNote').textContent = locked ? '' : '(locked sessions only)';
}

function collectWriting() {
  const lines = id => $(id).value.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
  return {
    mode: document.querySelector('input[name=afMode]:checked').value,
    timeLimitMin: $('afLimit').value || null,
    windowStart: fromLocalInput($('afWinStart').value), windowEnd: fromLocalInput($('afWinEnd').value),
    allowPaste: $('afPaste').value, citationStyle: $('afStyle').value, docStyle: $('afDocStyle').value,
    minWords: $('afMin').value || null, maxWords: $('afMax').value || null,
    requireExtension: $('afExt').checked, researchTracking: $('afResearch').checked,
    blockAiSites: $('afBlockAi').checked, autoSubmitOnTimeUp: $('afAuto').checked,
    panelBrowsing: $('afPanel').checked, oneClickCite: $('afCite').checked,
    allowedSites: lines('afAllowed'), blockedSites: lines('afBlocked'),
    templateText: $('afTemplate').value, pauseGraceSec: $('afGrace').value || 0
  };
}

// publish: true = save and publish, false = save as draft, null = edit (keep as is)
// The footer buttons are off while it saves, so a double click saves once
const saveAssignment = publish => modalBusy(() => saveAssignmentNow(publish));
async function saveAssignmentNow(publish) {
  // A date or time box left half-filled reads as empty: say so instead of saving "no date"
  const half = [...document.querySelectorAll('.modal input[type=datetime-local]')].find(i => i.validity.badInput);
  if (half) { formError('afErr', 'One of the dates is only partly filled in. Finish it or clear it.'); half.focus(); return; }
  const body = { type: af.type, title: $('afTitle').value, instructions: $('afInstr').value, dueAt: fromLocalInput($('afDue').value) };
  const folderId = $('afFolder') ? $('afFolder').value || null : af.folderId || null;
  if (!af.a || folderId !== (af.a.folderId || null)) body.folderId = folderId;
  if (af.type === 'writing') body.writing = collectWriting();
  if (af.type === 'group') body.group = { groups: af.groups };
  if (af.type === 'discussion') body.discussion = { date: fromLocalInput($('afDiscDate').value), shareOwnStats: $('afShare').checked };
  try {
    let r;
    if (af.a) r = await api(`/api/assignments/${af.a.id}`, { method: 'PATCH', body });
    else r = await api(`/api/classes/${af.classId}/assignments`, { method: 'POST', body });
    if (publish) r = await api(`/api/assignments/${r.assignment.id}/publish`, { method: 'POST', body: { published: true } });
    closeModal();
    toast(af.a ? 'Saved' : publish ? 'Published. Students can see it now.' : 'Saved as a draft. Students can’t see it until you publish it.');
    // From the class's materials: stay on the list. From the assignment page: show it again.
    if (cp && location.pathname === `/class/${af.classId}`) {
      // A new one made somewhere else than the folder on screen: go and show it there
      if (!af.a && (body.folderId || null) !== (cp.folder || null)) VisorRouter.go(`/class/${af.classId}${body.folderId ? '?folder=' + body.folderId : ''}`);
      else refreshClass();
    } else VisorRouter.go(`/a/${r.assignment.id}`, { replace: !!af.a });
  } catch (e) { formError('afErr', e.message); $('afErr').scrollIntoView({ block: 'nearest' }); }
}

/* ---- group builder: drag students into groups, or pick from a list ---- */
function renderGroupBuilder() {
  const el = $('afGroups'); if (!el) return;
  const placed = new Set(af.groups.flatMap(g => g.studentIds));
  const pool = af.students.filter(s => !placed.has(s.id));
  const chip = s => `<span class="gchip" draggable="true" data-sid="${s.id}" ondragstart="event.dataTransfer.setData('text/plain','${s.id}')">${esc(s.name)}
      <select aria-label="Move ${esc(s.name)} to a group" onchange="moveToGroup('${s.id}', this.value)"><option value="">Move…</option><option value="pool">Not in a group</option>${af.groups.map((g, i) => `<option value="${i}">${esc(g.name)}</option>`).join('')}</select></span>`;
  const byId = id => af.students.find(s => s.id === id) || { id, name: 'Student' };
  el.innerHTML = `
    <div class="gb-tools"><label for="gbN" class="small">Auto-make groups of</label><input id="gbN" class="input input-sm" type="number" min="2" max="12" value="4" style="width:70px;" /><button type="button" class="btn btn-ghost btn-sm" onclick="autoGroups()">Make groups</button>
      <button type="button" class="btn btn-ghost btn-sm" onclick="addGroup()">${I.plusSm}Add a group</button></div>
    <div class="gb-pool gb-drop" data-g="pool" ondragover="event.preventDefault()" ondrop="dropStudent(event,'pool')"><div class="kicker">Not in a group (${pool.length})</div>${pool.map(chip).join('') || '<span class="tiny muted">Everyone is in a group.</span>'}</div>
    <div class="gb-groups">${af.groups.map((g, i) => `<div class="card gb-group gb-drop" ondragover="event.preventDefault()" ondrop="dropStudent(event,${i})">
      <div class="gb-group-head"><input class="input input-sm" aria-label="Group name" value="${esc(g.name)}" onchange="af.groups[${i}].name=this.value" /><button type="button" class="btn-icon" aria-label="Remove ${esc(g.name)}" onclick="af.groups.splice(${i},1);renderGroupBuilder()">${I.x}</button></div>
      <div class="gb-members">${g.studentIds.map(id => chip(byId(id))).join('') || '<span class="tiny muted">Drag students here</span>'}</div>
      <input class="input input-sm" aria-label="Google Doc link for ${esc(g.name)}" placeholder="Google Doc or Slides link (optional)" value="${esc(g.docUrl || '')}" onchange="af.groups[${i}].docUrl=this.value.trim()" />
    </div>`).join('')}</div>
    ${!af.students.length ? '<div class="tiny muted">Add students to the class first.</div>' : ''}`;
}
function addGroup() { af.groups.push({ name: `Group ${af.groups.length + 1}`, studentIds: [], docUrl: '' }); renderGroupBuilder(); }
function moveToGroup(sid, target) {
  if (target === '') return;
  af.groups.forEach(g => { g.studentIds = g.studentIds.filter(x => x !== sid); });
  if (target !== 'pool') af.groups[Number(target)].studentIds.push(sid);
  renderGroupBuilder();
}
function dropStudent(e, target) { e.preventDefault(); const sid = e.dataTransfer.getData('text/plain'); if (sid) moveToGroup(sid, String(target)); }
function autoGroups() {
  const n = Math.max(2, Math.min(12, Number($('gbN').value) || 4));
  const ids = af.students.map(s => s.id).sort(() => Math.random() - 0.5);
  const count = Math.max(1, Math.round(ids.length / n));
  const keep = af.groups.slice(0, count);
  af.groups = Array.from({ length: count }, (_, i) => ({ ...(keep[i] || {}), name: keep[i]?.name || `Group ${i + 1}`, docUrl: keep[i]?.docUrl || '', studentIds: [] }));
  ids.forEach((id, i) => af.groups[i % count].studentIds.push(id));
  renderGroupBuilder();
}

/* ====================== assignment page ======================
   Inside the course frame (classes.js): the class's sidebar on the left,
   the assignment in the middle, and on the overview a right-hand column
   with the student's own work or the teacher's submission counts. */
let ap = null; // { data, tab }

VisorRouter.add('/a/:id', async (el, { id }, query) => {
  el.innerHTML = `<div class="portal"><div class="loading-row"><span class="spinner"></span></div></div>`;
  const mine = VisorRouter.seq();
  const data = await api(`/api/assignments/${id}`);
  if (mine !== VisorRouter.seq()) return; // left while it loaded
  const a = data.assignment;
  const defaultTab = data.isTeacher ? (a.type === 'writing' && query.get('tab') === 'live' ? 'live' : (query.get('tab') || 'overview')) : 'overview';
  ap = { data, tab: defaultTab, stop: null };
  renderAssignmentPage();
  return () => { if (ap?.stop) ap.stop(); };
});

function assignmentTab(tab) {
  ap.tab = tab;
  history.replaceState(null, '', `/a/${ap.data.assignment.id}${tab === 'overview' ? '' : '?tab=' + tab}`);
  renderAssignmentPage();
}
async function reloadAssignment() {
  const id = ap.data.assignment.id, mine = VisorRouter.seq();
  const data = await api(`/api/assignments/${id}`);
  if (mine !== VisorRouter.seq() || ap?.data?.assignment?.id !== id) return;
  ap.data = data; renderAssignmentPage();
}

function renderAssignmentPage() {
  if (ap.stop) { ap.stop(); ap.stop = null; }
  const { assignment: a, class: cls, isTeacher } = ap.data;
  const course = { ...cls, isTeacher };
  const tabs = !isTeacher ? [] : a.type === 'writing' ? [['overview', 'Overview'], ['live', 'Live'], ['submissions', 'Submissions', ap.data.submissions.filter(s => s.status === 'submitted').length || null]]
    : a.type === 'group' ? [['overview', 'Overview'], ['groups', 'Groups', ap.data.groups.length]]
      : [['overview', 'Overview'], ['recordings', 'Recordings', ap.data.discussions.length]];
  const status = !isTeacher && a.type === 'writing' ? ap.data.doc?.status || 'not-started' : null;
  const overdue = status && isOverdue(a.dueAt, status);
  const meta = [
    `<span>${esc(TYPE_LABEL[a.type] || '')}</span>`,
    a.type === 'discussion' && a.discussion?.date ? `<span>Discussion ${esc(vcDateTime(a.discussion.date))}</span>` : '',
    a.dueAt || a.type !== 'discussion' ? `<span class="${overdue ? 'overdue' : ''}">${esc(vcDue(a.dueAt))}${overdue ? ' · overdue' : ''}</span>` : '',
    isTeacher ? (a.publishedAt ? '<span class="pill pill-green">Published</span>' : '<span class="pill pill-gray">Not published</span>') : ''
  ].filter(Boolean).join('');
  const options = isTeacher ? ddHtml({ id: 'asgOpts', btn: `${I.gear}Options ${PI.down}`, right: true, items: [
    { label: 'Edit', icon: I.edit, onclick: `openAssignmentForm('${cls.id}','${a.type}',ap.data.assignment)` },
    { label: a.publishedAt ? 'Unpublish' : 'Publish', icon: a.publishedAt ? PI.eyeOff : I.eye, onclick: 'togglePublish()' },
    { label: 'Move to…', icon: PI.move, onclick: 'moveFromAssignment()' },
    { label: 'Duplicate…', icon: I.copy, onclick: `openDuplicate('${a.id}')` },
    'sep',
    { label: 'Delete', icon: I.trash, onclick: 'deleteAssignment()', danger: true }
  ] }) : '';
  const trail = [[cls.name, `/class/${cls.id}`], ...(ap.data.folderPath || []).map(f => [f.name, `/class/${cls.id}?folder=${f.id}`]), [a.title]];
  const main = `<header class="course-head"><div style="min-width:0;flex:1;">
      ${crumbs(trail)}
      <div class="asg-head">${typeIcon(a.type)}<div class="asg-title"><h1>${esc(a.title)}</h1><div class="asg-meta">${meta}</div></div>
        ${isTeacher ? `<div class="asg-actions">${!a.publishedAt ? `<button class="btn btn-primary btn-sm" onclick="togglePublish()">Publish</button>` : ''}${options}</div>` : ''}</div>
    </div></header>
    ${tabs.length ? pageTabs(tabs, ap.tab, 'assignmentTab') : ''}
    <div id="aBody"></div>`;
  const right = ap.tab === 'overview' ? assignmentRightHtml() : '';
  $('routeView').innerHTML = courseFrame(course, { active: 'materials', main, right });
  const body = $('aBody');
  if (!isTeacher) return renderStudentAssignment(body);
  if (ap.tab === 'live' && window.renderLiveBoard) { ap.stop = renderLiveBoard(body, ap.data); return; }
  if (ap.tab === 'submissions') return renderSubmissions(body);
  if (ap.tab === 'groups') return renderGroupsTab(body);
  if (ap.tab === 'recordings' && window.renderDiscussionTab) { ap.stop = renderDiscussionTab(body, ap.data); return; }
  renderAssignmentOverview(body);
}

function instructionsHtml(a) {
  return a.instructions ? `<div class="card card-pad instructions">${esc(a.instructions).replace(/\n/g, '<br>')}</div>` : '';
}

// The right-hand column on the overview
function assignmentRightHtml() {
  const { assignment: a, isTeacher } = ap.data;
  const box = (title, inner) => `<section class="side-box"><div class="side-box-h"><span>${title}</span></div>${inner}</section>`;
  const details = box('Details', `<div class="side-box-b">
      <div class="side-stat"><span>Type</span><b>${esc(TYPE_LABEL[a.type] || '')}</b></div>
      ${a.type === 'writing' ? `<div class="side-stat"><span>Session</span><b>${a.writing.mode === 'locked' ? 'Locked (in class)' : 'Open'}</b></div>
        ${isTeacher ? `<div class="side-stat"><span>Time limit</span><b>${a.writing.timeLimitMin ? `${a.writing.timeLimitMin} min` : 'None'}</b></div>` : ''}
        ${a.writing.minWords || a.writing.maxWords ? `<div class="side-stat"><span>Length</span><b>${a.writing.minWords || 0}–${a.writing.maxWords || '∞'} words</b></div>` : ''}` : ''}
      ${a.type === 'discussion' && a.discussion?.date ? `<div class="side-stat"><span>Discussion</span><b>${esc(vcDateTime(a.discussion.date))}</b></div>` : ''}
      ${a.dueAt || a.type !== 'discussion' ? `<div class="side-stat"><span>Due</span><b>${a.dueAt ? esc(vcDateTime(a.dueAt)) : 'No due date'}</b></div>` : ''}
      ${isTeacher && a.publishedAt ? `<div class="side-stat"><span>Published</span><b>${esc(vcDate(a.publishedAt))}</b></div>` : ''}
    </div>`);
  if (!isTeacher) {
    if (a.type !== 'writing') return details;
    const d = ap.data.doc, st = d?.status || 'not-started';
    const label = st === 'not-started' ? 'Open the editor' : st === 'submitted' ? 'View your essay' : st === 'returned' ? 'See feedback' : 'Keep writing';
    return `${box('Your work', `<div class="side-box-p your-work">${statusPillDoc(st)}${isOverdue(a.dueAt, st) ? ' <span class="pill pill-red">Overdue</span>' : ''}
      ${d?.words ? `<div class="your-work-line">${d.words.toLocaleString()} words</div>` : ''}
      ${d?.submittedAt ? `<div class="your-work-line">Submitted ${esc(vcDateTime(d.submittedAt))}</div>` : ''}
      ${d?.returnedAt && st === 'returned' ? `<div class="your-work-line">Returned ${esc(vcDateTime(d.returnedAt))}</div>` : ''}
      <a class="btn btn-primary" href="/write/${a.id}" data-link>${I.pen}${label}</a></div>`)}${details}`;
  }
  if (a.type === 'writing') {
    const subs = ap.data.submissions || [], n = st => subs.filter(s => s.status === st).length;
    return `${box('Submissions', `<div class="side-box-b">
        <a class="side-stat" href="/a/${a.id}?tab=submissions" data-link onclick="event.preventDefault();assignmentTab('submissions')"><span>To review</span><b>${n('submitted')}</b></a>
        <a class="side-stat" href="/a/${a.id}?tab=submissions" data-link onclick="event.preventDefault();assignmentTab('submissions')"><span>Returned</span><b>${n('returned')}</b></a>
        <a class="side-stat" href="/a/${a.id}?tab=submissions" data-link onclick="event.preventDefault();assignmentTab('submissions')"><span>In progress</span><b>${n('in-progress')}</b></a>
        <a class="side-stat" href="/a/${a.id}?tab=submissions" data-link onclick="event.preventDefault();assignmentTab('submissions')"><span>Not started</span><b>${n('not-started')}</b></a>
      </div><div class="side-box-p" style="border-top:1px solid var(--line);"><button class="btn btn-ghost btn-sm" style="width:100%;justify-content:center;" onclick="assignmentTab('live')">${PI.live}Watch live</button></div>`)}${details}`;
  }
  if (a.type === 'group') {
    const groups = ap.data.groups || [];
    return `${box('Groups', `<div class="side-box-b"><div class="side-stat"><span>Groups</span><b>${groups.length}</b></div><div class="side-stat"><span>Students in a group</span><b>${groups.reduce((t, g) => t + g.students.length, 0)} of ${ap.data.students?.length || 0}</b></div></div>`)}${details}`;
  }
  return `${box('Discussion', `<div class="side-box-b"><div class="side-stat"><span>Date</span><b>${a.discussion?.date ? esc(vcDateTime(a.discussion.date)) : 'Not set'}</b></div><div class="side-stat"><span>Recordings</span><b>${(ap.data.discussions || []).length}</b></div></div>`)}${details}`;
}

function renderAssignmentOverview(body) {
  const { assignment: a } = ap.data;
  let settings = '';
  if (a.type === 'writing') {
    const w = a.writing;
    const rows = [
      ['Session', w.mode === 'locked' ? 'Locked (in class): Visor extension required, students kept to allowed sites' : 'Open (homework): recorded, not locked'],
      ['Time limit', w.timeLimitMin ? `${w.timeLimitMin} minutes per student, across all their sessions (plus any extra time)` : 'None'],
      ['Session window', w.windowStart || w.windowEnd ? `${w.windowStart ? vcDateTime(w.windowStart) : 'any time'} → ${w.windowEnd ? vcDateTime(w.windowEnd) : 'no end'}` : 'Any time'],
      ['Pasting', { allow: 'Allowed, every paste recorded', 'internal-only': 'Only text copied from the same essay', block: 'Off' }[w.allowPaste]],
      ['Research', w.researchTracking ? 'Recorded during sessions' : 'Not recorded'],
      ['AI sites', `${w.blockAiSites ? 'Blocked' : 'Recorded, not blocked'} (${w.blockedSites.length} sites)`],
      ['Allowed sites', w.mode === 'locked' ? (w.allowedSites.length ? w.allowedSites.join(', ') : 'Any site that isn’t blocked') : 'Not limited (open session)'],
      ...(w.mode === 'locked' ? [['Side panel', w.panelBrowsing !== false ? 'Students can switch to it to research (blocked and AI sites stay blocked)' : 'Off: locked sessions stay in full screen']] : []),
      ['Citations', `${STYLE_NAME[w.citationStyle]}${w.oneClickCite === false ? ' · one-click citing off' : ''}`],
      ['Document style', w.docStyle === 'docs' ? 'Docs default' : 'MLA essay'],
      ['Length', w.minWords || w.maxWords ? `${w.minWords || 0}–${w.maxWords || '∞'} words` : 'Any'],
      ['Starter text', w.templateText ? `${w.templateText.length.toLocaleString()} characters` : 'None'],
      ['Time up', w.autoSubmitOnTimeUp ? 'Submits automatically' : 'Session ends; student submits'],
      ['Pause grace', w.pauseGraceSec ? `${w.pauseGraceSec} seconds` : 'None: every time away is recorded']
    ];
    settings = `<h2 class="section-title" style="font-size:16px;margin:20px 0 10px;">Session settings</h2><div class="card settings-table">${rows.map(([k, v]) => `<div class="st-row"><div class="st-k">${k}</div><div class="st-v">${esc(v)}</div></div>`).join('')}</div>`;
  }
  if (a.type === 'discussion') settings = `<div class="card card-pad"><div class="kicker">Discussion</div><div>${a.discussion.date ? esc(vcDateTime(a.discussion.date)) : 'No date set'}</div><div class="small muted" style="margin-top:6px;">${a.discussion.shareOwnStats ? 'Students can see their own talk time and turns.' : 'Only you see the results.'}</div></div>`;
  body.innerHTML = `${!a.publishedAt ? `<div class="callout amber" style="margin-bottom:14px;">This assignment isn’t published. Students can’t see it until you publish it.</div>` : ''}
    ${instructionsHtml(a) || `<div class="card card-pad muted small">No instructions. ${a.type === 'discussion' ? 'Add a prompt' : 'Add some'} with Options → Edit.</div>`}
    ${a.type === 'writing' ? `<p class="muted small" style="margin:12px 0 0;">${esc(ap.data.describe)}</p>` : ''}
    ${settings}`;
}

function renderSubmissions(body) {
  const rows = ap.data.submissions;
  if (!rows.length) { body.innerHTML = `<div class="card"><div class="empty"><h4>No students in this class yet</h4></div></div>`; return; }
  body.innerHTML = `<div class="card" style="overflow-x:auto;position:relative;"><table class="roster subs">
    <thead><tr><th>Student</th><th>Status</th><th>Words</th><th>Sessions</th><th>Submitted</th><th>Score</th><th><span class="sr-only">Open</span></th></tr></thead>
    <tbody>${rows.map(r => `<tr>
      <td><div class="roster-name">${avatarHtml(r.student, 'avatar-sm')}<b>${esc(r.student.name)}</b></div></td>
      <td>${statusPillDoc(r.status)}</td><td class="mono">${r.words.toLocaleString()}</td><td class="mono">${r.sessions}</td>
      <td class="small">${r.submittedAt ? esc(vcDateTime(r.submittedAt)) : '—'}</td><td class="mono">${r.score ?? '—'}</td>
      <td>${r.docId ? `<a class="btn btn-ghost btn-sm" href="/review/${r.docId}" data-link>Review</a>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
}

function renderStudentAssignment(body) {
  const { assignment: a } = ap.data;
  if (a.type === 'writing') {
    body.innerHTML = `${instructionsHtml(a)}
      <div class="card card-pad"><div class="kicker" style="margin-bottom:6px;">How this assignment works</div><div class="small">${esc(ap.data.describe)}</div></div>`;
    return;
  }
  if (a.type === 'group') { body.innerHTML = instructionsHtml(a) + studentGroupHtml(ap.data.myGroup); return; }
  body.innerHTML = instructionsHtml(a) + (window.studentDiscussionHtml ? studentDiscussionHtml(ap.data) : '');
}

async function togglePublish() {
  const a = ap.data.assignment;
  try { await api(`/api/assignments/${a.id}/publish`, { method: 'POST', body: { published: !a.publishedAt } }); toast(a.publishedAt ? 'Unpublished: students can’t see it now' : 'Published. Students can see it now.'); reloadAssignment(); }
  catch (e) { toast(e.message, 'err'); }
}
// Options → Move to…: the class's folders come from the class page's data
async function moveFromAssignment() {
  const classId = ap.data.class.id;
  try { if (cp?.cls?.id !== classId) await loadClass(classId, 'materials', null); else await loadClass(classId); }
  catch (e) { return toast(e.message, 'err'); }
  if (!cp.folders.length) return toast('This class has no folders yet. Make one with Add Materials → Folder on the class page.', 'err');
  openMoveModal('assignment', ap.data.assignment.id);
}
// Copy into one of the teacher's classes (from the assignment page or the class's list)
async function openDuplicate(id) {
  let list = [];
  try { list = (await loadCourses()).filter(c => c.isTeacher && !c.archived); } catch {}
  const from = ap?.data?.assignment?.id === id ? ap.data.class.id : cp?.cls?.id;
  openModal({ title: 'Duplicate assignment', sub: 'The copy isn’t published, and has the same settings.', body: `<div class="field"><label for="dupClass">Copy into</label><select id="dupClass" class="input">${list.map(c => `<option value="${c.id}" ${c.id === from ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>`,
    footer: `<button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-primary" id="dupGo">Duplicate</button>` });
  $('dupGo').onclick = () => modalBusy(async () => {
    const classId = $('dupClass').value;
    try {
      const r = await api(`/api/assignments/${id}/duplicate`, { method: 'POST', body: { classId } });
      closeModal(); toast('Copied. The copy isn’t published yet.');
      if (cp && location.pathname === `/class/${classId}`) refreshClass();
      else VisorRouter.go(`/a/${r.assignment.id}`);
    } catch (e) { toast(e.message, 'err'); }
  });
}
async function deleteAssignment() {
  const a = ap.data.assignment;
  if (!await confirmModal('Delete this assignment?', `"${a.title}" and all student work, sessions and research${a.type === 'group' ? ', group projects' : ''}${a.type === 'discussion' ? ', recordings' : ''} in it will be deleted. This cannot be undone.`, { okLabel: 'Delete', danger: true })) return;
  try { await api(`/api/assignments/${a.id}`, { method: 'DELETE' }); toast('Assignment deleted'); VisorRouter.go(`/class/${ap.data.class.id}${a.folderId ? '?folder=' + a.folderId : ''}`); }
  catch (e) { toast(e.message, 'err'); }
}

/* ---- groups tab (teacher) and the student's group ---- */
function renderGroupsTab(body) {
  const groups = ap.data.groups || [];
  if (!groups.length) { body.innerHTML = `<div class="card"><div class="empty"><div class="ic">${I.users}</div><h4>No groups yet</h4><p>Edit the assignment to make groups. Each group gets its own project.</p></div></div>`; return; }
  body.innerHTML = `<div class="stack">${groups.map(g => `<div class="card card-pad group-row">
    <div class="grow"><b>${esc(g.name)}</b><div class="small muted">${g.students.map(s => esc(s.name)).join(', ') || 'No students'}</div>
      ${g.docUrl ? `<div class="tiny"><a href="${esc(g.docUrl)}" target="_blank" rel="noopener">Linked Google Doc ↗</a></div>` : '<div class="tiny muted">No Google Doc linked</div>'}</div>
    <div class="group-stats"><span>${vcPlural(g.resourceCount || 0, 'resource')}</span><span>${g.lastAnalyzedAt ? 'Analyzed ' + esc(timeAgo(g.lastAnalyzedAt)) : 'Not analyzed yet'}</span></div>
    ${g.projectId ? `<a class="btn btn-ghost btn-sm" href="/project/${g.projectId}" data-link>Open project</a>` : ''}</div>`).join('')}</div>`;
}
function studentGroupHtml(g) {
  if (!g) return `<div class="card card-pad muted">Your teacher hasn’t put you in a group yet.</div>`;
  return `<div class="card card-pad group-row"><div class="grow"><b>${esc(g.name)}</b><div class="small muted">${g.students.map(s => esc(s.name)).join(', ')}</div>
    ${g.docUrl ? `<div class="small" style="margin-top:6px;">Your group’s document: <a href="${esc(g.docUrl)}" target="_blank" rel="noopener">open in Google Docs ↗</a>. With the Visor extension connected, its history is sent here automatically when you open it.</div>` : ''}</div>
    ${g.projectId ? `<a class="btn btn-primary btn-sm" href="/project/${g.projectId}" data-link>Open group project</a>` : ''}</div>`;
}
