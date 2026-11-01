/* Visor Classroom — the calendar (/calendar). Due dates, discussion dates
   and writing windows across every class, as a month or a list.
     ?m=2026-10      the month shown (default: this month)
     ?class=<id>     one class only
     ?view=list      the list instead of the month grid */

'use strict';

let cal = null; // { month: Date (the 1st), classId, view, events, classes }

VisorRouter.add('/calendar', async (el, params, query) => {
  VisorRouter.title('Calendar');
  const now = new Date();
  const m = /^(\d{4})-(\d{2})$/.exec(query.get('m') || '');
  const month = m ? new Date(Number(m[1]), Number(m[2]) - 1, 1) : new Date(now.getFullYear(), now.getMonth(), 1);
  let view = query.get('view');
  if (!['month', 'list'].includes(view)) view = window.matchMedia('(max-width: 720px)').matches ? 'list' : 'month';
  cal = { month, classId: query.get('class') || '', view, events: null, classes: [] };
  drawCalendar();
  const { from, to } = calRange();
  const mine = VisorRouter.seq();
  try {
    const r = await api(`/api/calendar?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`);
    if (mine !== VisorRouter.seq()) return; // left while it loaded
    cal.events = r.events; cal.classes = r.classes;
    // A class that isn't on the calendar (archived, or not yours): show them all
    if (cal.classId && !r.classes.some(c => c.id === cal.classId)) { cal.missing = cal.classId; cal.classId = ''; }
  } catch (e) { if (mine !== VisorRouter.seq()) return; cal.events = []; toast(e.message, 'err'); }
  drawCalendar();
});

// The weeks the month grid shows: from the Sunday on or before the 1st to the
// Saturday on or after the last day
function calRange() {
  const first = cal.month, last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
  const from = new Date(first.getFullYear(), first.getMonth(), 1 - first.getDay());
  const to = new Date(last.getFullYear(), last.getMonth(), last.getDate() + (7 - last.getDay()));
  return { from, to };
}
const calMonthParam = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
function calGo({ month = cal.month, classId = cal.classId, view = cal.view } = {}) {
  const q = new URLSearchParams();
  const now = new Date();
  if (month.getFullYear() !== now.getFullYear() || month.getMonth() !== now.getMonth()) q.set('m', calMonthParam(month));
  if (classId) q.set('class', classId);
  if (view === 'list') q.set('view', 'list');
  VisorRouter.go(`/calendar${q.toString() ? '?' + q : ''}`);
}
const calStep = n => calGo({ month: new Date(cal.month.getFullYear(), cal.month.getMonth() + n, 1) });
const calToday = () => calGo({ month: new Date(new Date().getFullYear(), new Date().getMonth(), 1) });

function calShown() {
  return (cal.events || []).filter(e => !cal.classId || e.classId === cal.classId);
}
const CAL_KIND = { due: 'Due', discussion: 'Discussion', opens: 'Opens', closes: 'Closes' };
function calEventClass(e) {
  return [e.published === false ? 'draft' : '', isDone(e.status) ? 'done' : '', e.kind === 'due' && isOverdue(e.at, e.status) ? 'overdue' : ''].filter(Boolean).join(' ');
}
function calEventTitle(e) {
  return [`${CAL_KIND[e.kind] || ''} ${vcTime(e.at)}`, e.title, e.className, e.published === false ? 'not published' : '', isDone(e.status) ? STATUS_LABEL[e.status] : ''].filter(Boolean).join(' · ');
}

function drawCalendar() {
  const el = $('routeView');
  const monthName = cal.month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const classOpts = cal.classes.length ? cal.classes : (coursesCache?.list || []).filter(c => !c.archived);
  const picked = classOpts.find(c => c.id === cal.classId);
  const head = `<div class="cal-head">
      <button class="btn btn-ghost btn-sm" onclick="calToday()">Today</button>
      <button class="btn-icon" onclick="calStep(-1)" aria-label="Previous month" title="Previous month">${PI.left}</button>
      <button class="btn-icon" onclick="calStep(1)" aria-label="Next month" title="Next month">${PI.right}</button>
      <h1 class="cal-title" aria-live="polite">${esc(monthName)}</h1>
      <span class="grow"></span>
      <select class="input" aria-label="Show one class" onchange="calGo({ classId: this.value })"><option value="">All classes</option>${classOpts.map(c => `<option value="${c.id}" ${c.id === cal.classId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
      <div class="seg" role="group" aria-label="View"><button aria-pressed="${cal.view === 'month'}" onclick="calGo({ view: 'month' })">Month</button><button aria-pressed="${cal.view === 'list'}" onclick="calGo({ view: 'list' })">List</button></div>
    </div>`;
  const crumb = picked ? crumbs([[picked.name, `/class/${picked.id}`], ['Calendar']]) : '';
  const body = cal.events === null ? '<div class="loading-row"><span class="spinner"></span></div>' : cal.view === 'list' ? calListHtml() : calGridHtml();
  const legend = !cal.classId && cal.classes.length > 1 ? `<div class="cal-legend">${cal.classes.map(c => `<span class="cc-${esc(c.color)}"><i></i>${esc(c.name)}</span>`).join('')}</div>` : '';
  const missing = cal.missing ? `<div class="callout amber" style="margin-bottom:12px;">That class isn’t on your calendar: it may be archived. Showing all your classes.</div>` : '';
  el.innerHTML = `<div class="portal">${crumb}${head}${missing}${body}${legend}</div>`;
}

function calGridHtml() {
  const { from, to } = calRange();
  const byDay = new Map();
  for (const e of calShown()) { const k = vcDayKey(e.at); if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(e); }
  const today = vcDayKey(new Date());
  const days = [];
  for (let d = new Date(from); d < to; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) days.push(d);
  const lastRow = days.length - 7;
  const dows = [...Array(7)].map((_, i) => new Date(2026, 1, 1 + i).toLocaleDateString(undefined, { weekday: 'short' })); // Feb 1 2026 is a Sunday
  return `<div class="cal-grid">
    ${dows.map(w => `<div class="cal-dow" aria-hidden="true">${esc(w)}</div>`).join('')}
    ${days.map((d, i) => {
      const k = vcDayKey(d), list = byDay.get(k) || [];
      const shown = list.slice(0, 3);
      const label = d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
      return `<div class="cal-cell ${d.getMonth() !== cal.month.getMonth() ? 'other' : ''} ${k === today ? 'today' : ''} ${i >= lastRow ? 'last-row' : ''}">
        <span class="cal-num" aria-hidden="true">${d.getDate()}</span><span class="sr-only" ${k === today ? 'aria-current="date"' : ''}>${esc(label)}${list.length ? `: ${vcPlural(list.length, 'event')}` : ''}</span>
        ${shown.map(e => `<a class="cal-ev cc-${esc(e.color)} ${calEventClass(e)}" href="/a/${e.assignmentId}" data-link title="${esc(calEventTitle(e))}">${e.kind !== 'due' ? `<span class="k">${esc(CAL_KIND[e.kind])}:</span> ` : ''}<span class="t">${esc(vcTime(e.at))}</span> ${esc(e.title)}</a>`).join('')}
        ${list.length > 3 ? `<button class="cal-more" onclick="calDay('${k}')">${list.length - 3} more</button>` : ''}
      </div>`;
    }).join('')}
  </div>`;
}

function calListHtml() {
  const first = cal.month, next = new Date(first.getFullYear(), first.getMonth() + 1, 1);
  const list = calShown().filter(e => Date.parse(e.at) >= first.getTime() && Date.parse(e.at) < next.getTime());
  if (!list.length) return `<div class="feed-empty"><b>Nothing this month</b>Due dates, discussions and writing windows show up here.</div>`;
  const today = vcDayKey(new Date());
  let out = '', day = '';
  for (const e of list) {
    const k = vcDayKey(e.at);
    if (k !== day) { day = k; out += `<div class="cal-list-day ${k === today ? 'today' : ''}">${esc(vcDayLabel(e.at))}</div>`; }
    out += calListRow(e);
  }
  return `<div class="cal-list">${out}</div>`;
}
function calListRow(e) {
  const meta = [CAL_KIND[e.kind], e.className, e.published === false ? 'Not published' : '', isDone(e.status) ? STATUS_LABEL[e.status] : '', e.kind === 'due' && isOverdue(e.at, e.status) ? 'Overdue' : ''].filter(Boolean);
  return `<a class="cal-list-row cc-${esc(e.color)}" href="/a/${e.assignmentId}" data-link><span class="time">${esc(vcTime(e.at))}</span><span class="ev-dot" style="margin-top:0;"></span>${typeIcon(e.type)}
    <span class="ev-main"><span class="ev-title">${esc(e.title)}</span><span class="ev-meta ${e.kind === 'due' && isOverdue(e.at, e.status) ? 'red' : ''}">${esc(meta.join(' · '))}</span></span></a>`;
}

// "N more": every event on one day
function calDay(key) {
  const list = calShown().filter(e => vcDayKey(e.at) === key);
  if (!list.length) return;
  openModal({ title: esc(vcDayLabel(list[0].at)), body: `<div class="cal-list">${list.map(calListRow).join('')}</div>` });
  document.querySelectorAll('#modalRoot a[data-link]').forEach(a => a.addEventListener('click', () => closeModal()));
}
