/* Visor Classroom — class discussions (assignment page, Recordings tab).
   The teacher confirms the recording notice once per class, then records in
   the browser or uploads a file. The recorder splits long discussions into
   10-minute segments (MediaRecorder stop/start) and uploads each one as soon
   as it ends, so a long class never becomes one huge upload. Once the
   segments are transcribed, the teacher names the voices (the same wizard as
   project recordings, with the class roster), and Visor measures talk time,
   turns and who followed whom. Gemini's part is labelled as AI-written. */

'use strict';

const DISC_SEGMENT_MS = 10 * 60 * 1000;
const DISC_STATUS = { recording: ['Recording', 'pill-red'], empty: ['No audio yet', 'pill-gray'], transcribing: ['Transcribing', 'pill-blue'], error: ['Needs attention', 'pill-amber'], identify: ['Name the voices', 'pill-amber'], ready: ['Ready', 'pill-green'] };
const discPill = s => { const [l, c] = DISC_STATUS[s] || [s, 'pill-gray']; return `<span class="pill ${c}">${l}</span>`; };
const discSec = s => vcClock((s || 0) * 1000);
let dq = null; // { data, cls, open: discussion | null, poll }

function renderDiscussionTab(el, data) {
  dq = { data, el, cls: null, open: null, poll: null };
  discList();
  return () => { if (dq?.poll) clearInterval(dq.poll); recStopAll(); dq = null; };
}

async function discList() {
  const el = dq.el;
  if (dq.poll) { clearInterval(dq.poll); dq.poll = null; }
  dq.open = null;
  el.innerHTML = `<div class="loading-row"><span class="spinner"></span></div>`;
  let c, fresh;
  try { [c, fresh] = await Promise.all([api(`/api/classes/${dq.data.class.id}`), api(`/api/assignments/${dq.data.assignment.id}`)]); }
  catch (e) { el.innerHTML = `<div class="callout red">${esc(e.message)} <button class="btn btn-ghost btn-sm" onclick="discList()">Try again</button></div>`; return; }
  dq.cls = c.class; dq.data = fresh; ap.data = fresh;
  const a = fresh.assignment, rows = fresh.discussions;
  const consent = dq.cls.discussionConsentAt
    ? ''
    : `<div class="card card-pad consent-card">
        <div class="kicker">Before the first recording in this class</div>
        <label class="check-row" style="margin:8px 0 12px;"><input id="discConsent" type="checkbox" /> <span>I’ve told students this discussion is being recorded, and my school allows it.</span></label>
        <button class="btn btn-primary btn-sm" onclick="discConfirmConsent()">Confirm</button></div>`;
  el.innerHTML = `${consent}
    <div class="disc-tools">
      <button class="btn btn-primary" ${dq.cls.discussionConsentAt ? '' : 'disabled'} onclick="discRecord()">${I.mic}Record in the browser</button>
      <button class="btn btn-ghost" ${dq.cls.discussionConsentAt ? '' : 'disabled'} onclick="discUpload()">${I.upload}Upload a recording</button>
      <span style="flex:1"></span>
      <label class="check-row" style="margin:0;"><input type="checkbox" ${a.discussion.shareOwnStats ? 'checked' : ''} onchange="discShare(this.checked)" /> <span class="small">Students see their own talk time and turns (never anyone else’s)</span></label>
    </div>
    ${!CFG.geminiReady ? '<div class="callout amber" style="margin-bottom:12px;">Transcription and the AI-written summary are unavailable on this server (no Gemini access). You can still record and upload.</div>' : ''}
    ${rows.length ? `<div class="card list-card">${rows.map(r => `<button class="list-row row-btn" onclick="discOpen('${r.id}')"><span class="grow"><b>${esc(r.title)}</b><div class="tiny muted">${esc(vcDateTime(r.createdAt))} · ${vcPlural(r.segments, 'part')}</div></span>${discPill(r.status)}${r.analyzedAt ? '<span class="pill pill-green">Analyzed</span>' : ''}</button>`).join('')}</div>`
      : `<div class="card"><div class="empty"><div class="ic">${I.mic}</div><h4>No recordings yet</h4><p>Put the laptop in the middle of the room and record the discussion. Long discussions are split into 10-minute parts automatically.</p></div></div>`}`;
}

async function discConfirmConsent() {
  if (!$('discConsent').checked) return toast('Tick the box first.', 'err');
  try { await api(`/api/classes/${dq.data.class.id}/discussion-consent`, { method: 'POST', body: { confirmed: true } }); toast('Thanks. You won’t be asked again for this class.'); discList(); }
  catch (e) { toast(e.message, 'err'); }
}
async function discShare(on) {
  try {
    const r = await api(`/api/assignments/${dq.data.assignment.id}`, { method: 'PATCH', body: { discussion: { shareOwnStats: on } } });
    dq.data.assignment = r.assignment; if (ap?.data) ap.data.assignment = r.assignment;
    toast(on ? 'Students can see their own numbers' : 'Only you see the results');
  }
  catch (e) { toast(e.message, 'err'); }
}

/* ---- uploading one segment (the same 3-step chunked upload as recordings) ---- */
async function discSendSegment(did, blob, { k, duration, last, filename, onProgress }) {
  const type = (blob.type || 'audio/webm').split(';')[0];
  const start = await api(`/api/discussions/${did}/uploads`, { method: 'POST', body: { filename, mime: type, size: blob.size, k } });
  for (let offset = 0; offset < blob.size; offset += start.chunkBytes) {
    const piece = blob.slice(offset, Math.min(offset + start.chunkBytes, blob.size));
    for (let tries = 0; ; tries++) {
      try {
        const r = await fetch(`/api/discussions/${did}/uploads/chunk?offset=${offset}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-Upload-Token': start.uploadToken }, body: piece, credentials: 'same-origin' });
        if (r.ok) break;
        const data = await r.json().catch(() => ({}));
        const err = new Error(data.error || `Upload failed (${r.status})`); err.status = r.status; throw err;
      } catch (e) {
        if (tries >= 2 || (e.status && e.status < 500)) throw e;
        await new Promise(res => setTimeout(res, 1000 * (tries + 1)));
      }
    }
    onProgress && onProgress(Math.round(Math.min(offset + start.chunkBytes, blob.size) / blob.size * 100));
  }
  return api(`/api/discussions/${did}/segments`, { method: 'POST', body: { uploadToken: start.uploadToken, duration, last } });
}

/* ---- the recorder: 10-minute segments ---- */
let drec = null; // { did, stream, recorder, k, segStart, start, timer, uploads: [], stopping }
// Leaving the page while recording: the part being recorded is saved as the last one
function recStopAll() {
  if (!drec) return;
  const r = drec;
  r.stopping = true;
  clearInterval(r.timer); clearTimeout(r.rotate);
  try { if (r.recorder?.state === 'recording') r.recorder.stop(); } catch {}
  // Microphone off once the last part is in hand
  setTimeout(() => { r.stream?.getTracks().forEach(t => t.stop()); }, 500);
  Promise.allSettled(r.uploads).then(() => api(`/api/discussions/${r.did}/finish`, { method: 'POST' }).catch(() => {}));
  drec = null;
  if ($('modalRoot')?.querySelector('#drecStop')) closeModal();
}

async function discRecord() {
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { return toast('Microphone access was blocked. Allow it in the browser and try again.', 'err'); }
  let d;
  try { d = (await api(`/api/assignments/${dq.data.assignment.id}/discussions`, { method: 'POST', body: { source: 'recorder' } })).discussion; }
  catch (e) { stream.getTracks().forEach(t => t.stop()); return toast(e.message, 'err'); }
  drec = { did: d.id, stream, k: 0, start: Date.now(), uploads: [], stopping: false, mime: MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : (MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '') };
  openModal({ title: 'Recording the discussion', sub: esc(d.title), closable: false, body: `
    <div class="rec">
      <div class="rec-btn on" aria-hidden="true">${I.mic}</div>
      <div class="rec-time" id="drecTime" aria-live="off">0:00</div>
      <div class="muted small" id="drecParts">Part 1 recording · parts are saved every 10 minutes</div>
      <div class="tiny muted" id="drecUploads"></div>
    </div>`,
    footer: `<button class="btn btn-danger" id="drecStop" onclick="discStopRecording()">${I.stop}Stop and save</button>` });
  drec.timer = setInterval(() => { if ($('drecTime')) $('drecTime').textContent = fmtDur((Date.now() - drec.start) / 1000); }, 500);
  discStartSegment();
}

// One MediaRecorder per segment: each stop gives a complete, playable file
function discStartSegment() {
  const r = drec;   // this recording, even after drec is cleared
  const k = r.k;
  const chunks = [];
  const rec = new MediaRecorder(r.stream, r.mime ? { mimeType: r.mime } : undefined);
  const segStart = Date.now();
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  rec.onstop = () => {
    const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
    const last = r.stopping;
    const ext = (blob.type || '').includes('mp4') ? 'm4a' : 'webm';
    const job = discSendSegment(r.did, blob, { k, duration: (Date.now() - segStart) / 1000, last, filename: `discussion-part-${k + 1}.${ext}` })
      .then(() => { discUploadsNote(`Part ${k + 1} saved.`); })
      .catch(e => { discUploadsNote(`Part ${k + 1} didn’t upload: ${e.message}`); throw e; });
    r.uploads.push(job);
    if (!last) { r.k += 1; discStartSegment(); if ($('drecParts')) $('drecParts').textContent = `Part ${r.k + 1} recording · parts are saved every 10 minutes`; }
  };
  rec.start(1000);
  r.recorder = rec;
  r.rotate = setTimeout(() => { if (!r.stopping && rec.state === 'recording') rec.stop(); }, DISC_SEGMENT_MS);
}
function discUploadsNote(t) { const el = $('drecUploads'); if (el) el.textContent = t; }

async function discStopRecording() {
  if (!drec) return;
  const btn = $('drecStop'); btn.disabled = true; btn.innerHTML = `<span class="spinner spinner-sm"></span> Saving…`;
  drec.stopping = true;
  clearTimeout(drec.rotate);
  const did = drec.did;
  await new Promise(res => { const r = drec.recorder; if (r.state === 'inactive') return res(); r.addEventListener('stop', () => setTimeout(res, 0), { once: true }); r.stop(); });
  const results = await Promise.allSettled(drec.uploads);
  drec.stream.getTracks().forEach(t => t.stop()); clearInterval(drec.timer);
  drec = null;
  await api(`/api/discussions/${did}/finish`, { method: 'POST' }).catch(() => {});
  closeModal();
  const failed = results.filter(r => r.status === 'rejected').length;
  toast(failed ? `${failed} part${failed === 1 ? '' : 's'} didn’t upload. The rest is saved.` : 'Saved. Transcription has started.', failed ? 'err' : '');
  discOpen(did);
}

function discUpload() {
  openModal({ title: 'Upload a discussion recording', sub: 'MP3, M4A, WAV, WebM or OGG, up to 60 MB.', body: `
    <div class="field"><label for="duFile">Recording</label><input id="duFile" type="file" accept="audio/*,.m4a,.mp3,.wav,.webm,.ogg" class="input" /></div>
    <div class="field"><label for="duTitle">Title <span class="label-note">optional</span></label><input id="duTitle" class="input" placeholder="e.g. Socratic seminar, 3rd period" /></div>`,
    footer: `<button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-primary" id="duBtn" onclick="discDoUpload()">Upload</button>` });
}
async function discDoUpload() {
  const f = $('duFile').files[0];
  if (!f) return toast('Choose a file first.', 'err');
  if (f.size > (CFG.maxAudioMB || 60) * 1024 * 1024) return toast(`That file is over ${CFG.maxAudioMB || 60} MB.`, 'err');
  const btn = $('duBtn'); btn.disabled = true;
  try {
    const d = (await api(`/api/assignments/${dq.data.assignment.id}/discussions`, { method: 'POST', body: { source: 'upload', title: $('duTitle').value } })).discussion;
    const duration = await audioDuration(f);
    await discSendSegment(d.id, f, { k: 0, duration, last: true, filename: f.name, onProgress: p => { btn.innerHTML = `<span class="spinner spinner-sm"></span> ${p}%`; } });
    closeModal(); toast('Uploaded. Transcription has started.'); discOpen(d.id);
  } catch (e) { toast(e.message, 'err'); btn.disabled = false; btn.textContent = 'Upload'; }
}

/* ---- one discussion ---- */
async function discOpen(did) {
  if (dq.poll) clearInterval(dq.poll);
  const load = async () => {
    const r = await api(`/api/discussions/${did}`);
    dq.open = r.discussion;
    discRender();
    if (!['recording', 'transcribing'].includes(r.discussion.status) && dq.poll) { clearInterval(dq.poll); dq.poll = null; }
  };
  try { await load(); } catch (e) { toast(e.message, 'err'); return; }
  if (['recording', 'transcribing'].includes(dq.open.status)) dq.poll = setInterval(() => load().catch(() => {}), 4000);
}

function discRender() {
  const d = dq.open, el = dq.el;
  const an = d.analysis;
  el.innerHTML = `<div class="disc-head"><button class="btn btn-ghost btn-sm" onclick="discList()">← All recordings</button>
      <h2 class="section-title" style="margin:0;flex:1;">${esc(d.title)}</h2>${discPill(d.status)}
      ${d.speakers.length && d.status !== 'transcribing' && d.status !== 'recording' ? `<button class="btn btn-ghost btn-sm" onclick="discWizard()">${I.users}${d.speakers.some(s => !s.assignedName) ? 'Name the voices' : 'Fix names'}</button>` : ''}
      ${d.status === 'recording' && !drec ? `<button class="btn btn-ghost btn-sm" onclick="discFinish()">Stop waiting for more parts</button>` : ''}
      ${['identify', 'ready', 'error'].includes(d.status) && d.transcript.length ? `<button class="btn btn-primary btn-sm" onclick="discAnalyze(this)">${an ? 'Analyze again' : 'Analyze'}</button>` : ''}
      <button class="btn-icon" aria-label="Delete this recording" title="Delete" onclick="discDelete()">${I.trash}</button></div>
    <div class="disc-segs">${d.segments.map(s => `<div class="disc-seg"><b>Part ${s.k + 1}</b>${s.durationSec ? `<span class="mono tiny">${discSec(s.durationSec)}</span>` : ''}
      <span class="pill ${s.status === 'ready' ? 'pill-green' : s.status === 'error' ? 'pill-amber' : 'pill-blue'}">${esc({ queued: 'waiting', transcribing: 'transcribing', ready: `${s.lines} lines`, error: 'failed' }[s.status] || s.status)}</span>
      ${s.error ? `<span class="tiny" style="color:var(--red);">${esc(s.error)}</span><button class="btn btn-ghost btn-sm" onclick="discRetry(${s.k})">${I.refresh}Try again</button>` : ''}
      <audio controls preload="none" src="${esc(s.audioUrl)}"></audio></div>`).join('') || '<div class="muted small">No audio yet.</div>'}</div>
    ${d.status === 'identify' ? `<div class="callout amber" style="margin:12px 0;">${d.speakers.filter(s => !s.assignedName).length} voice${d.speakers.filter(s => !s.assignedName).length === 1 ? '' : 's'} still unnamed. Name them so the numbers belong to the right students.</div>` : ''}
    ${an ? discAnalysisHtml(an, d) : ''}
    ${d.transcript.length ? `<h3 class="section-title rv-h">Transcript</h3><div class="card script disc-script">${d.transcript.map(l => `<div class="line ${/^Speaker \d+$/.test(l.speaker) ? 'unnamed' : ''}" id="dl-${l.i}"><div class="who">${esc(l.speaker)}<span class="t">${esc(l.t)}</span></div><div class="what">${esc(l.text)}</div></div>`).join('')}</div>` : ''}`;
}

function discAnalysisHtml(an, d) {
  const m = an.measured;
  const max = Math.max(1, ...m.students.map(s => s.talkSec));
  const nameOf = k => m.follows.people.find(p => p.key === k)?.name || k;
  const keys = m.follows.people.map(p => p.key);
  const matrix = keys.length > 1 ? `<div class="hb-wrap"><table class="hb follows"><thead><tr><th>Spoke…</th>${keys.map(k => `<th>Then ${esc(nameOf(k).split(' ')[0])}</th>`).join('')}</tr></thead>
    <tbody>${keys.map(a => `<tr><th scope="row">${esc(nameOf(a))}</th>${keys.map(b => `<td class="mono">${a === b ? '—' : (m.follows.counts[a]?.[b] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '';
  const ai = an.ai;
  return `<div class="card card-pad rise" style="margin:14px 0;">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap;"><h3 class="section-title">Measured</h3><span class="tiny muted">from the transcript’s timestamps · ${discSec(m.durationSec)} · ${m.turns} turns</span></div>
      <div class="disc-share"><span>Teacher <b>${m.teacherSharePct}%</b> of talk time</span><span>Students <b>${m.studentSharePct}%</b></span><span><b>${m.distinctStudentSpeakers}</b> of ${m.students.length} students spoke</span></div>
      <div class="hb-wrap"><table class="hb"><thead><tr><th>Student</th><th>Talk time</th><th>Share</th><th>Turns</th><th>Words</th><th>Longest turn</th><th>First spoke</th></tr></thead>
      <tbody>${m.students.map(s => `<tr${s.turns ? '' : ' class="muted"'}><td>${esc(s.name)}</td><td><div class="disc-bar"><i style="width:${(100 * s.talkSec / max).toFixed(1)}%"></i></div><span class="mono tiny">${discSec(s.talkSec)}</span></td><td class="mono">${s.sharePct}%</td><td class="mono">${s.turns}</td><td class="mono">${s.words}</td><td class="mono">${s.turns ? discSec(s.longestTurnSec) : '—'}</td><td class="mono">${s.firstAtText || '—'}</td></tr>`).join('')}</tbody></table></div>
      ${m.didntSpeak.length ? `<div class="small" style="margin-top:10px;"><b>Didn’t speak:</b> ${m.didntSpeak.map(s => esc(s.name)).join(', ')}</div>` : ''}
      ${m.others.filter(o => o.role === 'unknown').length ? `<div class="tiny muted" style="margin-top:6px;">Unnamed voices are counted separately: ${m.others.filter(o => o.role === 'unknown').map(o => esc(o.name)).join(', ')}.</div>` : ''}
      ${matrix ? `<div class="kicker" style="margin:14px 0 6px;">Who spoke right after whom</div>${matrix}` : ''}
    </div>
    <div class="card card-pad rise ai-card">
      <div class="kicker" style="margin-bottom:8px;">${I.sparkle} <span class="ai-label" style="margin:0;">AI-written summary: check against the transcript</span></div>
      ${ai ? `${ai.students.length ? `<div class="stack">${ai.students.map(s => `<div><b>${esc(s.name)}</b><div class="chips" style="margin-top:4px;">${Object.entries(s.types).map(([t, v]) => `<span class="pill pill-gray">${esc(DISC_TYPE_LABEL[t] || t)} · ${v.count}</span>`).join('')}</div>
          ${Object.entries(s.types).filter(([, v]) => v.quote && v.line != null).map(([t, v]) => `<div class="small disc-quote">${esc(DISC_TYPE_LABEL[t] || t)}: “${esc(v.quote)}” <a href="#dl-${v.line}" onclick="event.preventDefault();discJump(${v.line})">line ${v.line + 1}</a></div>`).join('')}</div>`).join('')}</div>` : ''}
        ${ai.groupDynamics ? `<div class="kicker" style="margin:12px 0 4px;">Group dynamics</div><div style="font-size:14.5px;">${esc(ai.groupDynamics)}</div>` : ''}
        ${ai.suggestions?.length ? `<div class="kicker" style="margin:12px 0 4px;">Suggestions</div><ul class="small">${ai.suggestions.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}`
      : `<div class="muted small">${esc(an.aiError || 'No AI-written summary.')}</div>`}
    </div>`;
}
const DISC_TYPE_LABEL = { 'new-idea': 'New idea', evidence: 'Evidence or example', question: 'Question', 'builds-on': 'Builds on someone', disagrees: 'Disagrees respectfully', summarizes: 'Summarizes', 'off-topic': 'Off-topic' };

function discJump(i) {
  const el = $(`dl-${i}`); if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1800);
}

function discWizard() {
  const d = dq.open;
  if (!d.speakers.length) return toast('No separate voices were found.', 'err');
  openVoiceWizard({ id: d.id, speakers: d.speakers.slice(), people: d.people.map(p => ({ ...p, avatarColor: null })), editing: d.status === 'ready',
    onFinish: async assignments => {
      try { const r = await api(`/api/discussions/${d.id}/speakers`, { method: 'POST', body: { assignments } }); dq.open = r.discussion; closeModal(); discRender(); toast(r.discussion.status === 'ready' ? 'Voices named. Analyze when you’re ready.' : 'Saved. Some voices are still unnamed.'); }
      catch (e) { toast(e.message, 'err'); }
    } });
}
async function discAnalyze(btn) {
  btn.disabled = true; btn.innerHTML = `<span class="spinner spinner-sm"></span> Working…`;
  try { const r = await api(`/api/discussions/${dq.open.id}/analyze`, { method: 'POST' }); dq.open = r.discussion; discRender(); }
  catch (e) { toast(e.message, 'err'); btn.disabled = false; btn.textContent = 'Analyze'; }
}
// A recording whose page closed before it finished: use the parts that arrived
async function discFinish() {
  try { const r = await api(`/api/discussions/${dq.open.id}/finish`, { method: 'POST' }); dq.open = r.discussion; discOpen(dq.open.id); }
  catch (e) { toast(e.message, 'err'); }
}
async function discRetry(k) {
  try { const r = await api(`/api/discussions/${dq.open.id}/segments/${k}/retranscribe`, { method: 'POST' }); dq.open = r.discussion; discOpen(dq.open.id); }
  catch (e) { toast(e.message, 'err'); }
}
async function discDelete() {
  if (!await confirmModal('Delete this recording?', 'Its audio, transcript and results will be deleted. This cannot be undone.', { okLabel: 'Delete', danger: true })) return;
  try { await api(`/api/discussions/${dq.open.id}`, { method: 'DELETE' }); toast('Deleted'); discList(); }
  catch (e) { toast(e.message, 'err'); }
}

/* ---- a student's own numbers ---- */
function studentDiscussionHtml(data) {
  const a = data.assignment;
  const date = a.discussion?.date ? `<div class="small muted" style="margin-bottom:10px;">${esc(vcDateTime(a.discussion.date))}</div>` : '';
  const mine = data.myStats;
  if (!mine) return `<div class="card card-pad">${date}<div class="muted small">Your teacher hasn’t shared discussion results.</div></div>`;
  if (!mine.length) return `<div class="card card-pad">${date}<div class="muted small">No results yet.</div></div>`;
  return `<div class="stack">${mine.map(x => `<div class="card card-pad"><b>${esc(x.title)}</b><div class="tiny muted">${esc(vcDateTime(x.createdAt))} · ${discSec(x.durationSec)}</div>
    ${x.mine && x.mine.turns ? `<div class="stat-grid" style="margin-top:10px;">${[['Talk time', discSec(x.mine.talkSec)], ['Share', `${x.mine.sharePct}%`], ['Turns', x.mine.turns], ['Words', x.mine.words], ['Longest turn', discSec(x.mine.longestTurnSec)], ['First spoke', x.mine.firstAtText]].map(([k, v]) => `<div class="card stat"><div class="kicker">${k}</div><div class="v">${v}</div></div>`).join('')}</div>`
      : '<div class="small" style="margin-top:8px;">You didn’t speak in this discussion.</div>'}
    <div class="tiny muted" style="margin-top:8px;">Only you see your numbers.</div></div>`).join('')}</div>`;
}
