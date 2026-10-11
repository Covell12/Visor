/* Visor Classroom — the live session board (assignment page, Live tab).
   Polls /api/assignments/:id/live every 5 seconds: one row per student with
   status, session time, time left, words, pastes, time away, extension and
   lockdown, last activity. Actions per student (end, pause/resume, add time,
   message) and for everyone. The poll also sweeps sessions on the server,
   so a student whose page went quiet times out here. */

'use strict';

const LIVE_STATUS = {
  'not-started': ['Not started', 'pill-gray'], writing: ['Writing', 'pill-green'], paused: ['Paused by you', 'pill-violet'],
  left: ['Left', 'pill-amber'], offline: ['Offline', 'pill-amber'], ended: ['Ended', 'pill-gray'], submitted: ['Submitted', 'pill-blue'], returned: ['Returned', 'pill-violet']
};
const REASON_TEXT = { 'left-tab': 'left the tab', 'left-window': 'left the window', 'exit-fullscreen': 'left full screen', 'ext-missing': 'extension off', offline: 'offline', teacher: 'paused by you' };
let lb = null; // { data, rows, filter, sort, timer, el }

function renderLiveBoard(el, data) {
  lb = { data, rows: [], filter: 'all', sort: 'name', el, serverOffset: 0, error: null };
  el.innerHTML = `<div class="live">
    <div class="live-tools">
      <div class="seg" role="group" aria-label="Show">${[['all', 'Everyone'], ['attention', 'Needs attention'], ['writing', 'Writing'], ['not-started', 'Not started'], ['submitted', 'Submitted']].map(([k, l]) => `<button data-f="${k}" aria-pressed="${k === 'all'}" onclick="liveFilter('${k}')">${l}</button>`).join('')}</div>
      <label class="small muted">Sort <select class="input input-sm" onchange="liveSort(this.value)" aria-label="Sort students"><option value="name">Name</option><option value="status">Status</option><option value="words">Words</option><option value="away">Time away</option><option value="activity">Last activity</option></select></label>
      <span style="flex:1"></span>
      <button class="btn btn-ghost btn-sm" onclick="liveBulk('pause-all')">Pause everyone</button>
      <button class="btn btn-ghost btn-sm" onclick="liveBulk('resume-all')">Resume everyone</button>
      <button class="btn btn-ghost btn-sm" onclick="liveExtendAll()">Extend all</button>
      <button class="btn btn-danger btn-sm" onclick="liveBulk('end-all-submit')">End all and submit</button>
    </div>
    <div id="liveLate"></div>
    <div id="liveTable" class="card live-card"><div class="loading-row"><span class="spinner"></span></div></div>
    <div class="tiny muted" style="margin-top:8px;">Updates every 5 seconds. Time away counts every time a student left the Visor tab or window.</div>
  </div>`;
  livePoll();
  const timer = setInterval(livePoll, 5000);
  // Between polls only the clocks move; rebuilding the table every second
  // swallowed clicks on its buttons
  const tick = setInterval(liveTick, 1000);
  return () => { clearInterval(timer); clearInterval(tick); lb = null; };
}

async function livePoll() {
  if (!lb) return;
  try {
    const r = await api(`/api/assignments/${lb.data.assignment.id}/live`);
    if (!lb) return;
    lb.rows = r.rows; lb.fetchedAt = Date.now(); lb.error = null;
    lb.serverOffset = Date.parse(r.serverNow) - Date.now();
  } catch (e) { if (lb) lb.error = e.message; }
  liveRender();
}

function liveFilter(f) { lb.filter = f; lb.el.querySelectorAll('.seg button').forEach(b => b.setAttribute('aria-pressed', b.dataset.f === f)); liveRender(); }
function liveSort(s) { lb.sort = s; liveRender(); }

function liveTick() {
  if (!lb || !lb.fetchedAt) return;
  const since = Date.now() - lb.fetchedAt;
  document.querySelectorAll('#liveTable [data-tick]').forEach(el => {
    const base = Number(el.dataset.base), kind = el.dataset.tick;
    if (kind === 'down') el.textContent = vcClock(Math.max(0, base - since));
    else if (kind === 'dur') el.textContent = vcDur(base + since);
    else if (kind === 'left') el.textContent = `Left: ${vcClock(base + since)}`;
    else if (kind === 'offline') el.textContent = `Offline ${vcClock(base + since)}`;
    else el.textContent = vcClock(base + since);
  });
}

function liveRender() {
  if (!lb || !$('liveTable')) return;
  const since = lb.fetchedAt ? Date.now() - lb.fetchedAt : 0;   // tick timers between polls
  const order = ['writing', 'left', 'offline', 'paused', 'ended', 'not-started', 'submitted', 'returned'];
  let rows = [...lb.rows];
  if (lb.filter === 'attention') rows = rows.filter(r => r.attention.length);
  else if (lb.filter !== 'all') rows = rows.filter(r => r.status === lb.filter || (lb.filter === 'writing' && ['left', 'offline', 'paused'].includes(r.status)));
  const by = { name: (a, b) => a.student.lastName.localeCompare(b.student.lastName), status: (a, b) => order.indexOf(a.status) - order.indexOf(b.status), words: (a, b) => b.words - a.words, away: (a, b) => b.awayMs - a.awayMs, activity: (a, b) => String(b.lastActivity || '').localeCompare(String(a.lastActivity || '')) }[lb.sort];
  rows.sort(by);
  const late = lb.rows.filter(r => r.lateBeat);
  $('liveLate').innerHTML = lb.error ? `<div class="callout red live-banner">Couldn’t refresh: ${esc(lb.error)}</div>`
    : late.length ? `<div class="callout amber live-banner" role="status">${late.length === 1 ? `${esc(late[0].student.name)}’s page hasn’t` : `${late.length} students’ pages haven’t`} checked in for over 30 seconds (closed laptop, lost connection, or the page was closed).</div>` : '';
  if (!lb.rows.length && !lb.fetchedAt) return;
  const mode = lb.data.assignment.writing?.mode;
  const yes = (v, label) => (v == null ? '<span class="muted">—</span>' : v ? `<span class="ok-mark" title="${label}: yes">✓<span class="sr-only">${label}: yes</span></span>` : `<span class="no-mark" title="${label}: no">✗<span class="sr-only">${label}: no</span></span>`);
  $('liveTable').innerHTML = rows.length ? `<table class="roster live-table">
    <thead><tr><th>Student</th><th>Status</th><th>Session</th><th>Time left</th><th>Words</th><th>Pastes</th><th>Away</th><th>Extension</th>${mode === 'locked' ? '<th>Lock</th>' : ''}<th>Last activity</th><th><span class="sr-only">Actions</span></th></tr></thead>
    <tbody>${rows.map(r => {
      const [label, pill] = LIVE_STATUS[r.status] || [r.status, 'pill-gray'];
      const paused = r.pausedMs != null ? r.pausedMs + since : null;
      const statusText = r.status === 'left' ? `Left: ${vcClock(paused)}` : r.status === 'offline' ? `Offline ${vcClock(paused)}` : label;
      const live = ['writing', 'left', 'offline'].includes(r.status);
      const reason = r.reason && (r.status === 'left' || r.status === 'ended') ? `<div class="tiny muted">${esc(REASON_TEXT[r.reason] || r.reason)}</div>` : '';
      const tl = r.timeLeftMs != null ? Math.max(0, r.timeLeftMs - (r.status === 'writing' || r.status === 'left' || r.status === 'offline' ? since : 0)) : null;
      const sess = r.sessionMs != null ? r.sessionMs + (['writing', 'left', 'offline', 'paused'].includes(r.status) ? since : 0) : null;
      return `<tr class="${r.attention.length ? 'attn' : ''}">
        <td><div class="roster-name">${avatarHtml(r.student, 'avatar-sm')}<span><b>${esc(r.student.name)}</b>${r.attention.length ? `<div class="tiny attn-text">${I.alert}${esc(r.attention.join(' · '))}</div>` : ''}</span></div></td>
        <td><span class="pill ${pill}" ${r.status === 'left' || r.status === 'offline' ? `data-tick="${r.status}" data-base="${paused}"` : ''}>${esc(statusText)}</span>${reason}</td>
        <td class="mono" ${sess != null && (live || r.status === 'paused') ? `data-tick="up" data-base="${sess}"` : ''}>${sess != null ? vcClock(sess) : '—'}</td>
        <td class="mono ${tl != null && tl < 300000 ? 'low' : ''}" ${tl != null && live ? `data-tick="down" data-base="${tl}"` : ''}>${tl != null ? vcClock(tl) : '—'}</td>
        <td class="mono">${r.words.toLocaleString()}</td>
        <td class="mono">${r.pastes}${r.outsidePasteChars ? `<div class="tiny muted">${r.outsidePasteChars.toLocaleString()} ch outside</div>` : ''}</td>
        <td class="mono" ${r.status === 'left' || r.status === 'offline' ? `data-tick="dur" data-base="${r.awayMs}"` : ''}>${r.awayMs ? vcDur(r.awayMs + (r.status === 'left' || r.status === 'offline' ? since : 0)) : '—'}</td>
        <td>${r.status === 'writing' || r.status === 'left' || r.status === 'offline' || r.status === 'paused' ? yes(r.ext, 'Extension') : '<span class="muted">—</span>'}</td>
        ${mode === 'locked' ? `<td>${r.lock == null ? '<span class="muted">—</span>' : yes(r.lock, 'Lockdown')}</td>` : ''}
        <td class="small">${r.lastActivity ? esc(timeAgo(r.lastActivity)) : '—'}</td>
        <td class="row-actions">${r.sessionId ? `<div class="live-acts">
          <button class="btn btn-ghost btn-sm" onclick="liveAct('${r.student.id}','${r.teacherPaused ? 'resume' : 'pause'}')">${r.teacherPaused ? 'Resume' : 'Pause'}</button>
          <button class="btn btn-ghost btn-sm" onclick="liveAddTime('${r.student.id}')">+ time</button>
          <button class="btn btn-ghost btn-sm" onclick="liveMessage('${r.student.id}')">Message</button>
          <button class="btn btn-ghost btn-sm" onclick="liveAct('${r.student.id}','end')">End</button></div>`
          : r.docId && ['submitted', 'returned', 'ended'].includes(r.status) ? `<a class="btn btn-ghost btn-sm" href="/review/${r.docId}" data-link>Review</a>` : ''}</td>
      </tr>`;
    }).join('')}</tbody></table>`
    : `<div class="empty"><h4>${lb.filter === 'attention' ? 'Nobody needs attention' : 'No students here'}</h4></div>`;
}

async function liveAct(studentId, action, extra = {}) {
  try { await api(`/api/assignments/${lb.data.assignment.id}/live/action`, { method: 'POST', body: { action, studentIds: [studentId], ...extra } }); livePoll(); }
  catch (e) { toast(e.message, 'err'); }
}
async function liveBulk(action, extra = {}) {
  const ask = { 'pause-all': ['Pause everyone?', 'Writing turns off for every student until you resume.', 'Pause everyone'], 'end-all-submit': ['End every session and submit?', 'Every running session ends now and every essay in progress is submitted.', 'End and submit'], 'resume-all': null, 'extend-all': null }[action];
  if (ask && !await confirmModal(ask[0], ask[1], { okLabel: ask[2], danger: action === 'end-all-submit' })) return;
  try { const r = await api(`/api/assignments/${lb.data.assignment.id}/live/action`, { method: 'POST', body: { action, ...extra } }); toast(`Done (${r.changed})`); livePoll(); }
  catch (e) { toast(e.message, 'err'); }
}
function liveTimeModal(title, onPick) {
  openModal({ title, body: `<div class="btn-row" style="margin:0 0 12px;"><button class="btn btn-ghost" data-m="5">+5 min</button><button class="btn btn-ghost" data-m="10">+10 min</button></div>
    <div class="field"><label for="ltCustom">Or a number of minutes</label><input id="ltCustom" class="input" type="number" min="1" max="240" style="max-width:140px;" /></div>`,
    footer: `<button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-primary" id="ltOk">Add</button>` });
  document.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { closeModal(); onPick(Number(b.dataset.m)); });
  $('ltOk').onclick = () => { const m = Number($('ltCustom').value); if (!m) return; closeModal(); onPick(m); };
}
function liveAddTime(studentId) { liveTimeModal('Add time', m => liveAct(studentId, 'add-time', { minutes: m })); }
function liveExtendAll() { liveTimeModal('Extend everyone’s time', m => liveBulk('extend-all', { minutes: m })); }
function liveMessage(studentId) {
  const r = lb.rows.find(x => x.student.id === studentId);
  openModal({ title: `Message ${esc(r?.student.name || '')}`, sub: 'Shown as a banner in their editor within a few seconds.', body: `<div class="field"><label for="lmText">Message</label><input id="lmText" class="input" maxlength="200" placeholder="e.g. Ten minutes left: start your conclusion." /></div>`,
    footer: `<button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-primary" id="lmOk">Send</button>` });
  setTimeout(() => $('lmText')?.focus(), 50);
  const send = () => { const text = $('lmText').value.trim(); if (!text) return; closeModal(); liveAct(studentId, 'message', { message: text }).then(() => toast('Sent')); };
  $('lmOk').onclick = send;
  $('lmText').addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
}
