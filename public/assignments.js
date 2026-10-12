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
let af = null; // { classId, type, a (existing or null), groups, students }

async function openAssignmentForm(classId, type, existing = null) {
  // The roster of this assignment's class (not whichever class page was open last)
  let students = cp?.cls?.id === classId ? cp.cls.students : null;
  if (!students) { try { students = (await api(`/api/classes/${classId}`)).class.students; } catch {} }
  af = { classId, type, a: existing, students: students || [], groups: JSON.parse(JSON.stringify(existing?.group?.groups || [])) };
  const a = existing || { title: '', instructions: '', dueAt: null, writing: CFG.writingPresets?.homework?.writing, discussion: { date: null, shareOwnStats: false } };
  const titles = { writing: 'writing assignment', group: 'group project', discussion: 'discussion' };
  const common = `
    <div class="field"><label for="afTitle">Title</label><input id="afTitle" class="input" maxlength="200" value="${esc(a.title)}" placeholder="${type === 'writing' ? 'e.g. Argument essay: school start times' : type === 'group' ? 'e.g. Civil rights movement presentation' : 'e.g. Socratic seminar: Chapter 4'}" /></div>
    <div class="field"><label for="afInstr">${type === 'discussion' ? 'Prompt' : 'Instructions'}</label><textarea id="afInstr" class="input" maxlength="20000" placeholder="What students should do. Line breaks are kept.">${esc(a.instructions)}</textarea></div>
    <div class="field"><label for="afDue">Due <span class="label-note">optional</span></label><input id="afDue" class="input" type="datetime-local" value="${toLocalInput(a.dueAt)}" /></div>`;
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

function writingFields(w, showPresets) {
  const opt = (v, cur, label) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${label}</option>`;
  const docStyle = w.docStyle === 'docs' ? 'docs' : 'mla'; // missing on older assignments: MLA
  return `
    ${showPresets ? `<div class="kicker" style="margin:16px 0 8px;">Start from a preset</div>
    <div class="preset-row">
      <button type="button" class="choice preset" onclick="applyPreset('in-class')"><div class="t">In-class essay (locked)</div><div class="d">45 minutes · Visor extension required · pasting only from this essay · AI sites blocked · submits at time up</div></button>
      <button type="button" class="choice preset" onclick="applyPreset('homework')"><div class="t">Homework essay (open)</div><div class="d">No time limit · pasting allowed · research recorded · AI sites flagged, not blocked</div></button>
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
    <label class="check-row"><input id="afBlockAi" type="checkbox" ${w.blockAiSites ? 'checked' : ''} /> <span>Block AI sites during sessions (otherwise visits are only recorded)</span></label>
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
async function saveAssignment(publish) {
  // A date or time box left half-filled reads as empty: say so instead of saving "no date"
  const half = [...document.querySelectorAll('.modal input[type=datetime-local]')].find(i => i.validity.badInput);
  if (half) { formError('afErr', 'One of the dates is only partly filled in. Finish it or clear it.'); half.focus(); return; }
  const body = { type: af.type, title: $('afTitle').value, instructions: $('afInstr').value, dueAt: fromLocalInput($('afDue').value) };
  if (af.type === 'writing') body.writing = collectWriting();
  if (af.type === 'group') body.group = { groups: af.groups };
  if (af.type === 'discussion') body.discussion = { date: fromLocalInput($('afDiscDate').value), shareOwnStats: $('afShare').checked };
  try {
    let r;
    if (af.a) r = await api(`/api/assignments/${af.a.id}`, { method: 'PATCH', body });
    else r = await api(`/api/classes/${af.classId}/assignments`, { method: 'POST', body });
    if (publish) r = await api(`/api/assignments/${r.assignment.id}/publish`, { method: 'POST', body: { published: true } });
    closeModal();
    toast(af.a ? 'Saved' : publish ? 'Published. Students can see it now.' : 'Saved as a draft');
    VisorRouter.go(`/a/${r.assignment.id}`, { replace: !!af.a });
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

/* ====================== assignment page ====================== */
let ap = null; // { data, tab }

VisorRouter.add('/a/:id', async (el, { id }, query) => {
  const data = await api(`/api/assignments/${id}`);
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
async function reloadAssignment() { ap.data = await api(`/api/assignments/${ap.data.assignment.id}`); renderAssignmentPage(); }

function renderAssignmentPage() {
  if (ap.stop) { ap.stop(); ap.stop = null; }
  const { assignment: a, class: cls, isTeacher } = ap.data;
  const tabs = !isTeacher ? [] : a.type === 'writing' ? [['overview', 'Overview'], ['live', 'Live'], ['submissions', 'Submissions', ap.data.submissions.filter(s => s.status === 'submitted').length || null]]
    : a.type === 'group' ? [['overview', 'Overview'], ['groups', 'Groups', ap.data.groups.length]]
      : [['overview', 'Overview'], ['recordings', 'Recordings', ap.data.discussions.length]];
  $('routeView').innerHTML = `<div class="page">
    ${crumbs([['Home', '/'], [cls.name, `/class/${cls.id}`], [a.title]])}
    <div class="page-head">
      <div><h1>${esc(a.title)}</h1><div class="head-meta">${typePill(a.type)}${isTeacher ? (a.publishedAt ? '<span class="pill pill-green">Published</span>' : '<span class="pill pill-gray">Draft</span>') : ''}${a.dueAt ? `<span class="muted small">Due ${esc(vcDateTime(a.dueAt))}</span>` : ''}</div></div>
      ${isTeacher ? `<div class="head-actions">
        <button class="btn btn-ghost btn-sm" onclick="openAssignmentForm('${cls.id}','${a.type}',ap.data.assignment)">${I.edit}Edit</button>
        <button class="btn btn-ghost btn-sm" onclick="togglePublish()">${a.publishedAt ? 'Unpublish' : 'Publish'}</button>
        <button class="btn btn-ghost btn-sm" onclick="duplicateAssignment()">${I.copy}Duplicate</button>
        <button class="btn btn-danger btn-sm" onclick="deleteAssignment()">${I.trash}Delete</button></div>` : ''}
    </div>
    ${tabs.length ? pageTabs(tabs, ap.tab, 'assignmentTab') : ''}
    <div id="aBody"></div></div>`;
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
    settings = `<div class="card settings-table">${rows.map(([k, v]) => `<div class="st-row"><div class="st-k">${k}</div><div class="st-v">${esc(v)}</div></div>`).join('')}</div>`;
  }
  if (a.type === 'discussion') settings = `<div class="card card-pad"><div class="kicker">Discussion</div><div>${a.discussion.date ? esc(vcDateTime(a.discussion.date)) : 'No date set'}</div><div class="small muted" style="margin-top:6px;">${a.discussion.shareOwnStats ? 'Students can see their own talk time and turns.' : 'Only you see the results.'}</div></div>`;
  body.innerHTML = `${!a.publishedAt ? `<div class="callout amber" style="margin-bottom:14px;">This is a draft. Students can’t see it until you publish it.</div>` : ''}
    ${instructionsHtml(a)}
    ${a.type === 'writing' ? `<p class="muted small">${esc(ap.data.describe)}</p>` : ''}
    ${settings}`;
}

function renderSubmissions(body) {
  const rows = ap.data.submissions;
  if (!rows.length) { body.innerHTML = `<div class="card"><div class="empty"><h4>No students in this class yet</h4></div></div>`; return; }
  body.innerHTML = `<div class="card"><table class="roster subs">
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
    const d = ap.data.doc;
    const st = d?.status || 'not-started';
    body.innerHTML = `${instructionsHtml(a)}
      <div class="card card-pad">
        <div class="small muted" style="margin-bottom:10px;">${esc(ap.data.describe)}</div>
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">${statusPillDoc(st)}${d?.words ? `<span class="muted small">${d.words.toLocaleString()} words</span>` : ''}${d?.submittedAt ? `<span class="muted small">Submitted ${esc(vcDateTime(d.submittedAt))}</span>` : ''}
          <span style="flex:1"></span><a class="btn btn-primary" href="/write/${a.id}" data-link>${I.pen}${st === 'not-started' ? 'Open the editor' : st === 'submitted' ? 'View your essay' : st === 'returned' ? 'See feedback' : 'Keep writing'}</a></div>
      </div>`;
    return;
  }
  if (a.type === 'group') { body.innerHTML = instructionsHtml(a) + studentGroupHtml(ap.data.myGroup); return; }
  body.innerHTML = instructionsHtml(a) + (window.studentDiscussionHtml ? studentDiscussionHtml(ap.data) : '');
}

async function togglePublish() {
  const a = ap.data.assignment;
  try { await api(`/api/assignments/${a.id}/publish`, { method: 'POST', body: { published: !a.publishedAt } }); toast(a.publishedAt ? 'Unpublished: students can’t see it now' : 'Published'); reloadAssignment(); }
  catch (e) { toast(e.message, 'err'); }
}
async function duplicateAssignment() {
  let list = [];
  try { list = (await api('/api/classes')).classes.filter(c => c.isTeacher && !c.archived); } catch {}
  openModal({ title: 'Duplicate assignment', sub: 'The copy starts as a draft, with the same settings.', body: `<div class="field"><label for="dupClass">Copy into</label><select id="dupClass" class="input">${list.map(c => `<option value="${c.id}" ${c.id === ap.data.class.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>`,
    footer: `<button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="doDuplicate()">Duplicate</button>` });
}
async function doDuplicate() {
  try { const r = await api(`/api/assignments/${ap.data.assignment.id}/duplicate`, { method: 'POST', body: { classId: $('dupClass').value } }); closeModal(); toast('Copied as a draft'); VisorRouter.go(`/a/${r.assignment.id}`); }
  catch (e) { toast(e.message, 'err'); }
}
async function deleteAssignment() {
  const a = ap.data.assignment;
  if (!await confirmModal('Delete this assignment?', `"${a.title}" and all student work, sessions, research${a.type === 'group' ? ', group projects' : ''}${a.type === 'discussion' ? ', recordings' : ''} in it will be deleted. This cannot be undone.`, { okLabel: 'Delete', danger: true })) return;
  try { await api(`/api/assignments/${a.id}`, { method: 'DELETE' }); toast('Assignment deleted'); VisorRouter.go(`/class/${ap.data.class.id}`); }
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
