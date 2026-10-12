/* Visor Classroom — teacher review of one student's essay (/review/:docId).
   Tabs: Document (with "Color by source"), Replay (replay-web.js), Process
   (the engine's view from app.js plus what only Visor's editor can measure),
   Research (the extension's log), Feedback. "Print / Save as PDF" prints the
   essay, its Works Cited and, optionally, a one-page process summary.

   Everything here is a measurement. The notes for the teacher are written by
   rules (lib/process.js), not by AI, and none of them is a verdict. */

'use strict';

const SRC_LABEL = { typed: 'Typed', 'pasted-research': 'Pasted: copied from a page during a session', 'pasted-outside': 'Pasted from outside Visor’s view', 'pasted-internal': 'Moved or copied within the essay', cited: 'Citation', template: 'Teacher’s starter text', other: 'No keyboard or paste event' };
const SRC_ORDER = ['typed', 'pasted-research', 'pasted-outside', 'pasted-internal', 'cited', 'template', 'other'];
let rv = null;

VisorRouter.add('/review/:docId', async (el, { docId }, query) => {
  el.innerHTML = `<div class="page"><div class="loading-row"><span class="spinner"></span></div></div>`;
  const data = await api(`/api/review/${docId}`);
  rv = { data, tab: query.get('tab') || 'document', colored: false, filter: 'all', stop: null, quill: null };
  rvRender();
  return () => { if (rv?.stop) rv.stop(); rv = null; };
});

function rvTab(tab) {
  if (rv.stop) { rv.stop(); rv.stop = null; }
  rv.tab = tab;
  history.replaceState(null, '', `/review/${rv.data.doc.id}${tab === 'document' ? '' : '?tab=' + tab}`);
  rvRender();
}

function rvRender() {
  const { doc, student, assignment: a, class: cls, nav, report } = rv.data;
  $('routeView').innerHTML = `<div class="page review">
    ${crumbs([['Home', '/'], [cls.name, `/class/${cls.id}`], [a.title, `/a/${a.id}?tab=submissions`], [student.name]])}
    <div class="page-head">
      <div><h1>${esc(student.name)}</h1>
        <div class="head-meta"><span>${esc(a.title)}</span>${statusPillDoc(doc.status)}<span class="muted small">${vcPlural(report.totals.studentWords, 'word')}${report.totals.studentWords !== report.totals.words ? ` (${report.totals.words} with the starter text)` : ''}</span>${doc.submittedAt ? `<span class="muted small">Submitted ${esc(vcDateTime(doc.submittedAt))}</span>` : ''}</div></div>
      <div class="head-actions">
        <a class="btn btn-ghost btn-sm ${nav.prev ? '' : 'disabled'}" ${nav.prev ? `href="/review/${nav.prev.docId}" data-link` : 'aria-disabled="true"'} title="${nav.prev ? esc(nav.prev.name) : ''}">← Prev student</a>
        <span class="tiny muted">${nav.position} of ${nav.of}</span>
        <a class="btn btn-ghost btn-sm ${nav.next ? '' : 'disabled'}" ${nav.next ? `href="/review/${nav.next.docId}" data-link` : 'aria-disabled="true"'} title="${nav.next ? esc(nav.next.name) : ''}">Next student →</a>
        <button class="btn btn-ghost btn-sm" onclick="rvPrintDialog()">${I.doc}Print / Save as PDF</button>
      </div>
    </div>
    ${pageTabs([['document', 'Document'], ['replay', 'Replay'], ['process', 'Process'], ['research', 'Research', report.research.events.length || null], ['feedback', 'Feedback']], rv.tab, 'rvTab')}
    <div id="rvBody"></div>
  </div>
  <div id="printArea" class="print-area" aria-hidden="true"></div>`;
  const body = $('rvBody');
  if (rv.tab === 'replay') { mountReplay(body, { docId: doc.id, sessions: rv.data.sessions, research: report.research.events }).then(stop => { rv.stop = stop; }); return; }
  if (rv.tab === 'process') return rvProcess(body);
  if (rv.tab === 'research') return rvResearch(body);
  if (rv.tab === 'feedback') return rvFeedback(body);
  rvDocument(body);
}

/* ---------- Document ---------- */
function rvDelta(doc) {
  const Delta = Quill.import('delta');
  let d = new Delta().insert(doc.text + '\n');
  for (const r of doc.formats || []) d = d.compose(new Delta().retain(r.at).retain(r.len, r.attrs));
  return d;
}
function rvEssayHtml(doc) {
  const div = document.createElement('div');
  const q = new Quill(div, { readOnly: true, formats: ['bold', 'italic', 'underline', 'header', 'list'], modules: { toolbar: false } });
  q.setContents(rvDelta(doc), 'silent');
  return q.root.innerHTML;
}
function rvBibHtml() {
  const { doc, assignment: a } = rv.data;
  const bib = VisorCiteFormat.bibliography(doc.sources || [], a.writing?.citationStyle || 'mla');
  return bib.items.length ? `<section class="wr-works"><h2>${esc(bib.heading)}</h2><ol class="wr-bib">${bib.items.map(i => `<li><span class="wr-bib-text">${i.html}</span>${i.source.check?.length ? `<span class="chip-check" title="The student should check this source">Check: ${esc(i.source.check.join(', '))}</span>` : ''}</li>`).join('')}</ol></section>` : '';
}
function rvDocument(body) {
  const { doc, report } = rv.data;
  body.innerHTML = `<div class="rv-doc-tools">
      <button class="btn btn-ghost btn-sm" aria-pressed="${rv.colored}" onclick="rv.colored=!rv.colored;rvDocument($('rvBody'))">${rv.colored ? 'Hide sources' : 'Color by source'}</button>
      ${rv.colored ? `<div class="src-legend" aria-label="Legend">${SRC_ORDER.filter(k => report.survival.chars[k]).map(k => `<span class="src-key src-${k}"><i></i>${esc(SRC_LABEL[k])} · ${report.survival.pct[k]}%</span>`).join('')}</div>` : ''}
    </div>
    <div class="wr-paper rv-paper">${rv.colored ? `<div class="src-view">${rvSourceSpans(doc.text, report.survival.runs)}</div>` : '<div id="rvQuill"></div>'}</div>
    ${rvBibHtml()}`;
  if (!rv.colored) {
    const q = new Quill('#rvQuill', { theme: 'snow', readOnly: true, formats: ['bold', 'italic', 'underline', 'header', 'list'], modules: { toolbar: false } });
    q.setContents(rvDelta(doc), 'silent');
  }
}
// Each run of the final text marked with where it came from: color plus a
// pattern (underline style) and a tooltip, so color isn't the only signal.
function rvSourceSpans(text, runs) {
  return runs.map(r => `<span class="src-${r.c}" title="${esc(SRC_LABEL[r.c])}">${esc(text.slice(r.at, r.at + r.len))}</span>`).join('').replace(/\n/g, '<br>');
}

/* ---------- Process ---------- */
function rvProcess(body) {
  const { report } = rv.data;
  const t = report.totals, ty = report.typing;
  const surv = report.survival;
  const bar = SRC_ORDER.filter(k => surv.chars[k]).map(k => `<i class="src-bar-${k}" style="width:${(100 * surv.chars[k] / Math.max(1, surv.total)).toFixed(2)}%" title="${esc(SRC_LABEL[k])}: ${surv.pct[k]}%"></i>`).join('');
  body.innerHTML = `
    <div class="card card-pad rv-notes">
      <div class="rv-notes-head"><h3 class="section-title">Notes for the teacher</h3><span class="tiny muted">Measured facts, written by rules (not AI). Your judgment decides what they mean.</span></div>
      ${report.notes.length ? `<ul>${report.notes.map(n => `<li>${esc(n.text)}</li>`).join('')}</ul>` : '<p class="muted small" style="margin:0;">Nothing stood out: typed in the editor, no long absences, no pastes from outside.</p>'}
    </div>
    <div class="stat-grid rv-tiles">
      ${[['Words', t.studentWords.toLocaleString(), t.words !== t.studentWords ? `${t.words} with starter text` : ''], ['Sessions', t.sessions, ''], ['Active writing', fmtMins(t.activeMs / 60000), 'time with edits less than 2 min apart'], ['Time away', vcDur(t.awayMs), vcPlural(t.pauses, 'pause')], ['Pastes', t.pastes, ''], ['Typing', ty.wpm ? `${ty.wpm}<small> wpm</small>` : '—', `revised ${Math.round(ty.revisionRatio * 100)}% of what was written`]]
        .map(([k, v, d]) => `<div class="card stat"><div class="kicker">${k}</div><div class="v">${v}</div>${d ? `<div class="d">${esc(d)}</div>` : ''}</div>`).join('')}
    </div>
    <h3 class="section-title rv-h">How the final text arrived</h3>
    <div class="card card-pad"><div class="src-bar" role="img" aria-label="${esc(SRC_ORDER.filter(k => surv.chars[k]).map(k => `${SRC_LABEL[k]} ${surv.pct[k]}%`).join(', '))}">${bar}</div>
      <table class="rv-table"><tbody>${SRC_ORDER.map(k => `<tr><td><span class="src-key src-${k}"><i></i>${esc(SRC_LABEL[k])}</span></td><td class="mono">${surv.pct[k]}%</td><td class="mono muted">${(surv.chars[k] || 0).toLocaleString()} characters</td></tr>`).join('')}</tbody></table>
      <div class="tiny muted">Characters still in the final essay, not counting spaces.</div></div>
    <h3 class="section-title rv-h">Sessions</h3>
    <div class="card"><table class="roster"><thead><tr><th>#</th><th>Started</th><th>Length</th><th>Active</th><th>Away</th><th>Side panel research</th><th>Typing</th><th>Ended</th></tr></thead><tbody>
      ${report.sessions.map(s => `<tr><td>${s.n}</td><td class="small">${esc(vcDateTime(s.startedAt))}</td><td class="mono">${vcDur(s.durationMs)}</td><td class="mono">${vcDur(s.activeMs)}</td>
        <td class="small">${s.pauses.filter(p => p.reason !== 'teacher').length ? `${vcDur(s.awayMs)}<div class="tiny muted">${s.pauses.map(p => `${esc(REASON_TEXT[p.reason] || p.reason)} ${vcDur(p.ms)}`).join(', ')}</div>` : '—'}</td>
        <td class="mono">${s.researchMs ? vcDur(s.researchMs) : '—'}</td>
        <td class="mono">${s.wpm ? `${s.wpm} wpm` : '—'}</td><td class="small">${esc({ student: 'by the student', submitted: 'submitted', teacher: 'by you', timeout: 'no contact for 3 min', 'time-limit': 'time ran out', 'window-closed': 'window closed' }[s.endReason] || (s.endedAt ? s.endReason : 'still open'))}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">No sessions yet.</td></tr>'}
    </tbody></table></div>
    <h3 class="section-title rv-h">Pastes</h3>
    ${report.pastes.length ? `<div class="stack">${report.pastes.map(p => `<div class="card card-pad rv-paste">
      <div class="rv-paste-head"><span class="pill ${p.kind === 'outside' ? 'pill-amber' : p.kind === 'research' ? 'pill-blue' : 'pill-gray'}">${p.kind === 'outside' ? 'From outside Visor’s view' : p.kind === 'research' ? 'Copied during a session' : 'Within the essay'}</span>
        <span class="mono small">${p.len.toLocaleString()} characters</span><span class="tiny muted">${esc(vcDateTime(new Date(p.t).toISOString()))}</span>
        <span class="tiny muted">${p.survivedChars ? `${Math.round(100 * p.survivedChars / p.len)}% still in the essay` : 'since deleted'}</span></div>
      ${p.origin ? `<div class="small">From <a href="${esc(p.origin.url)}" target="_blank" rel="noopener noreferrer">${esc(p.origin.title || p.origin.url)}</a>, copied ${esc(vcTime(p.origin.copiedAt))}</div>` : ''}
      <blockquote class="rv-quote">${esc(p.preview)}${p.len > 140 ? '…' : ''}</blockquote></div>`).join('')}</div>` : '<div class="muted small">No pastes.</div>'}
    <h3 class="section-title rv-h">Typing</h3>
    <div class="card card-pad small">Overall ${ty.wpm ? `<b>${ty.wpm} wpm</b>` : 'not enough typing to measure'}${ty.perSession.filter(s => s.wpm).length > 1 ? ` · by session: ${ty.perSession.filter(s => s.wpm).map(s => `${s.n}: ${s.wpm}`).join(', ')}` : ''} ·
      ${ty.bursts.count} stretches of continuous typing (typical ${Math.round(ty.bursts.medianChars || 0)} characters, longest ${ty.bursts.longestChars.toLocaleString()}) ·
      ${ty.deletedChars.toLocaleString()} characters deleted of ${ty.insertedChars.toLocaleString()} written (revision ratio ${ty.revisionRatio}).</div>
    <h3 class="section-title rv-h">Edit history</h3>
    <div class="tiny muted" style="margin-bottom:8px;">The same analysis the Visor extension gives for a Google Doc, run on this essay’s own edit log. It judges pastes by their size alone; where it differs, the paste figures above (from Visor’s own editor) are the exact ones.${report.engine.matchesDoc ? '' : ' (The rebuilt text differs from the saved essay; the figures above are still exact.)'}</div>
    <div class="card card-pad" id="rvEngine"></div>`;
  if (report.engine.report) embedDocumentView($('rvEngine'), report.engine.report);
  else $('rvEngine').innerHTML = '<div class="muted small">No edits yet.</div>';
}

/* ---------- Research ---------- */
const RV_FILTERS = [['all', 'Everything'], ['search', 'Searches'], ['pages', 'Pages'], ['ai', 'AI sites'], ['copy', 'Copies'], ['cite', 'Citations']];
function rvResearch(body) {
  const { report, sessions } = rv.data;
  const evs = report.research.events;
  const aiSiteEvents = sessions.flatMap((s, i) => (s.events || []).filter(e => e.type === 'ai-site' || e.type === 'lock-violation').map(e => ({ ...e, session: i + 1, fromSession: true })));
  const all = [...evs.filter(e => e.type !== 'ai-site' && e.type !== 'blocked'), ...aiSiteEvents].sort((a, b) => a.t - b.t);
  const want = { all: () => true, search: e => e.type === 'search', pages: e => e.type === 'visit', ai: e => e.type === 'ai-site' || e.type === 'lock-violation', copy: e => e.type === 'copy', cite: e => e.type === 'cite' }[rv.filter];
  // A visit's time on the page comes from its matching "leave"
  const dwell = new Map();
  // A page's title is often still loading when it opens; the "leave" has the real one
  const titled = new Map();
  evs.forEach((e, i) => { if (e.type !== 'visit') return; const l = evs.slice(i + 1).find(x => x.type === 'leave' && x.url === e.url); if (l) { dwell.set(e, l.dwellMs); if (l.title && l.title !== l.url) titled.set(e, l.title); } });
  const pastedFrom = new Set(report.pastes.filter(p => p.origin).map(p => p.origin.copiedAt));
  const shown = all.filter(want);
  const groups = new Map();
  for (const e of shown) { if (!groups.has(e.session)) groups.set(e.session, []); groups.get(e.session).push(e); }
  const line = e => {
    const time = `<span class="mono tiny muted">${esc(vcTime(new Date(e.t).toISOString()))}</span>`;
    if (e.type === 'search') return `<div class="rl rl-search">${time}<span class="rl-kind">Search</span><b>${esc(e.query)}</b><span class="tiny muted">${esc(e.engine)}</span></div>`;
    if (e.type === 'visit') return `<div class="rl">${time}<span class="rl-kind">Page</span><a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">${esc(titled.get(e) || (e.title && e.title !== e.url ? e.title : '') || e.host)}</a><span class="tiny muted">${esc(e.host || '')}${dwell.has(e) ? ` · ${vcDur(dwell.get(e))}` : ''}</span></div>`;
    if (e.type === 'copy') return `<div class="rl">${time}<span class="rl-kind">Copied</span><span class="small">“${esc(e.copy?.preview || '')}${(e.copy?.len || 0) > 140 ? '…' : ''}”</span><span class="tiny muted">${(e.copy?.len || 0).toLocaleString()} ch from ${esc(e.host || '')}</span>${pastedFrom.has(new Date(e.t).toISOString()) ? '<span class="pill pill-blue">pasted into the essay</span>' : ''}</div>`;
    if (e.type === 'cite') return `<div class="rl">${time}<span class="rl-kind">Cited</span><span>${esc(e.title || e.url)}</span></div>`;
    if (e.type === 'ai-site') return `<div class="rl rl-ai">${time}<span class="rl-kind">AI site</span><b>${esc(e.host)}</b><span class="pill ${e.blocked ? 'pill-gray' : 'pill-amber'}">${e.blocked ? 'blocked' : 'visited'}</span></div>`;
    if (e.type === 'lock-violation') return `<div class="rl">${time}<span class="rl-kind">Not allowed</span><span>${esc(e.host || e.url || '')}</span><span class="pill pill-gray">blocked</span></div>`;
    return '';
  };
  body.innerHTML = `<div class="seg" role="group" aria-label="Show">${RV_FILTERS.map(([k, l]) => `<button aria-pressed="${rv.filter === k}" onclick="rv.filter='${k}';rvResearch($('rvBody'))">${l}</button>`).join('')}</div>
    ${rv.data.assignment.writing?.researchTracking === false ? '<div class="callout amber" style="margin:12px 0;">Research recording was off for this assignment.</div>' : ''}
    ${shown.length ? [...groups.entries()].map(([n, list]) => `<h3 class="section-title rv-h">Session ${n || '?'} <span class="tiny muted">${esc(vcDateTime(sessions[n - 1]?.startedAt))}</span></h3><div class="card rl-list">${list.map(line).join('')}</div>`).join('')
      : `<div class="card card-pad muted" style="margin-top:12px;">${evs.length || aiSiteEvents.length ? 'Nothing of this kind.' : 'No research was recorded (no sessions with the Visor extension recording research).'}</div>`}`;
}

/* ---------- Feedback ---------- */
function rvFeedback(body) {
  const { doc } = rv.data;
  const f = doc.feedback || {};
  body.innerHTML = `<div class="card card-pad" style="max-width:720px;">
    <div class="field"><label for="fbComment">Comment</label><textarea id="fbComment" class="input" style="min-height:160px;" maxlength="10000">${esc(f.comment || '')}</textarea></div>
    <div class="input-row" style="max-width:340px;"><div class="field"><label for="fbScore">Score</label><input id="fbScore" class="input" type="number" step="any" value="${f.score ?? ''}" /></div>
      <div class="field"><label for="fbOutOf">Out of</label><input id="fbOutOf" class="input" type="number" step="any" min="0" value="${f.outOf ?? ''}" /></div></div>
    <label class="check-row"><input id="fbReopen" type="checkbox" ${doc.reopened ? 'checked' : ''} /> <span>Let the student keep writing (new sessions allowed after you return it)</span></label>
    <div id="fbErr" class="form-error hidden"></div>
    <div class="btn-row"><button class="btn btn-ghost" onclick="rvSaveFeedback(false)">Save</button><button class="btn btn-primary" onclick="rvSaveFeedback(true)">Return to student</button></div>
    <div class="tiny muted" style="margin-top:10px;">${doc.status === 'returned' ? `Returned ${esc(vcDateTime(doc.returnedAt))}${doc.reopened ? '; the student can write again' : ''}.` : 'The student sees your comment and score once you return it.'}${f.at ? ` Last saved ${esc(timeAgo(f.at))}.` : ''}</div>
  </div>`;
}
async function rvSaveFeedback(returnToStudent) {
  try {
    const r = await api(`/api/review/${rv.data.doc.id}/feedback`, { method: 'POST', body: { comment: $('fbComment').value, score: $('fbScore').value, outOf: $('fbOutOf').value, returnToStudent, reopen: $('fbReopen').checked } });
    rv.data.doc = { ...rv.data.doc, ...r.doc };
    toast(returnToStudent ? 'Returned to the student' : 'Feedback saved');
    rvRender();
  } catch (e) { formError('fbErr', e.message); }
}

/* ---------- Print / Save as PDF ---------- */
function rvPrintDialog() {
  openModal({ title: 'Print or save as PDF', sub: 'Uses your browser’s print dialog. Choose “Save as PDF” there for a file.', body: `<label class="check-row"><input id="prSummary" type="checkbox" checked /> <span>Add a process summary page (notes for the teacher, sessions, how the text arrived)</span></label>`,
    footer: `<button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="rvPrint($('prSummary').checked)">Print</button>` });
}
function rvPrint(withSummary) {
  const { doc, student, assignment: a, class: cls, report } = rv.data;
  closeModal();
  const t = report.totals, surv = report.survival;
  $('printArea').innerHTML = `<article class="print-essay">
      <header><div class="print-name">${esc(student.name)}</div><div>${esc(cls.name)}</div><div>${esc(a.title)}</div><div>${doc.submittedAt ? esc(new Date(doc.submittedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })) : ''}</div></header>
      <div class="ql-editor print-body">${rvEssayHtml(doc)}</div>
      ${rvBibHtml()}
    </article>
    ${withSummary ? `<article class="print-summary">
      <h1>Writing process summary</h1>
      <p>${esc(student.name)} · ${esc(a.title)} · ${t.studentWords.toLocaleString()} words · ${t.sessions} session${t.sessions === 1 ? '' : 's'} · ${fmtMins(t.activeMs / 60000)} active · ${vcDur(t.awayMs)} away · ${t.pastes} paste${t.pastes === 1 ? '' : 's'}</p>
      <h2>Notes for the teacher</h2>${report.notes.length ? `<ul>${report.notes.map(n => `<li>${esc(n.text)}</li>`).join('')}</ul>` : '<p>Nothing stood out.</p>'}
      <h2>How the final text arrived</h2><ul>${SRC_ORDER.filter(k => surv.chars[k]).map(k => `<li>${esc(SRC_LABEL[k])}: ${surv.pct[k]}%</li>`).join('')}</ul>
      <h2>Sessions</h2><ul>${report.sessions.map(s => `<li>${esc(vcDateTime(s.startedAt))}: ${vcDur(s.durationMs)}, ${vcDur(s.activeMs)} active, ${vcDur(s.awayMs)} away${s.wpm ? `, ${s.wpm} wpm` : ''}</li>`).join('')}</ul>
      <p class="print-foot">Measured by Visor from the essay’s edit log and writing sessions. These are measurements to discuss, not a judgment.</p>
    </article>` : ''}`;
  // Only this print shows the print layout; Cmd+P on its own prints the page as it is
  document.body.classList.add('printing');
  window.addEventListener('afterprint', () => document.body.classList.remove('printing'), { once: true });
  setTimeout(() => window.print(), 50);
}
