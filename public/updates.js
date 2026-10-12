/* Visor Classroom — class updates (announcements) and Home's Recent
   Activity. Teachers post updates on a class (or several at once from
   Home); students read them on the class's Updates page and in Recent
   Activity, next to newly published assignments. Uses classes.js helpers. */

'use strict';

// Plain text with its line breaks, and web addresses as links
function updateBodyHtml(text) {
  return esc(text).replace(/https?:\/\/[^\s<]+/g, raw => {
    // Punctuation after an address isn't part of it ("see https://x.org." or
    // "(https://x.org)"), but a bracket the address opened is
    let url = raw, tail = '';
    for (;;) {
      const m = url.match(/(&#39;|&quot;|[.,;:!?\]]|\))$/);
      if (!m || (m[0] === ')' && (url.match(/\(/g) || []).length >= (url.match(/\)/g) || []).length)) break;
      tail = m[0] + tail; url = url.slice(0, -m[0].length);
    }
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>${tail}`;
  }).replace(/\n/g, '<br>');
}

// Every update shown on the page, by id (its card can be edited in place)
const updSeen = new Map(); // id -> { u, ctx: { canManage, showClass, cls } }

function updateCardHtml(u, ctx) {
  updSeen.set(u.id, { u, ctx });
  const when = `<span class="upd-time" title="${esc(vcDateTime(u.createdAt))}">${esc(timeAgo(u.createdAt))}${u.editedAt ? ' · edited' : ''}</span>`;
  const where = ctx.showClass && ctx.cls ? `<span class="upd-where">posted in <a href="/class/${ctx.cls.id}?tab=updates" data-link>${esc(ctx.cls.name)}</a></span>` : '';
  const menu = ctx.canManage ? ddHtml({ id: `um-${u.id}`, btnClass: 'btn-icon', btn: PI.dots, label: 'Update options', right: true, items: [
    { label: 'Edit', icon: I.edit, onclick: `editUpdate('${u.id}')` },
    { label: u.pinned ? 'Unpin' : 'Pin to the top', icon: PI.pin, onclick: `pinUpdate('${u.id}', ${!u.pinned})` },
    'sep',
    { label: 'Delete', icon: I.trash, onclick: `deleteUpdate('${u.id}')`, danger: true }
  ] }) : '';
  return `<article class="upd ${u.pinned ? 'pinned' : ''}" id="upd-${u.id}">
    ${avatarHtml(u.author || {}, '')}
    <div class="upd-main">
      <div class="upd-head">${u.pinned ? `<span class="upd-pin">${PI.pin}Pinned</span>` : ''}<span class="upd-author">${esc(u.author?.name || 'Teacher')}</span>${where}${when}</div>
      <div class="upd-body" id="updBody-${u.id}">${updateBodyHtml(u.body)}</div>
    </div>
    ${menu}
  </article>`;
}

function editUpdate(id) {
  const seen = updSeen.get(id), body = $(`updBody-${id}`);
  if (!seen || !body) return;
  body.outerHTML = `<div class="upd-edit" id="updBody-${id}"><textarea class="input" id="updEdit-${id}" maxlength="5000" aria-label="Edit the update">${esc(seen.u.body)}</textarea>
    <div class="btn-row"><button class="btn btn-ghost btn-sm" onclick="redrawUpdate('${id}')">Cancel</button><button class="btn btn-primary btn-sm" onclick="saveUpdateEdit('${id}')">Save</button></div></div>`;
  const t = $(`updEdit-${id}`); t.focus(); t.setSelectionRange(t.value.length, t.value.length);
}
function redrawUpdate(id) {
  const seen = updSeen.get(id), card = $(`upd-${id}`);
  if (seen && card) card.outerHTML = updateCardHtml(seen.u, seen.ctx);
}
async function saveUpdateEdit(id) {
  const seen = updSeen.get(id), btn = document.querySelector(`#updBody-${id} .btn-primary`);
  if (!seen || btn?.disabled) return;
  if (btn) btn.disabled = true;
  try {
    const r = await api(`/api/updates/${id}`, { method: 'PATCH', body: { body: $(`updEdit-${id}`).value } });
    seen.u = { ...seen.u, ...r.update };
    redrawUpdate(id); toast('Update saved');
  } catch (e) { toast(e.message, 'err'); if (btn) btn.disabled = false; }
}
async function pinUpdate(id, pinned) {
  try {
    await api(`/api/updates/${id}`, { method: 'PATCH', body: { pinned } });
    toast(pinned ? 'Pinned to the top of the class’s updates' : 'Unpinned');
    if (upd?.el?.isConnected) loadClassUpdates(); else if (act?.el?.isConnected) loadActivity();
  } catch (e) { toast(e.message, 'err'); }
}
async function deleteUpdate(id) {
  if (!await confirmModal('Delete this update?', 'Students won’t see it any more. This cannot be undone.', { okLabel: 'Delete', danger: true })) return;
  try {
    await api(`/api/updates/${id}`, { method: 'DELETE' });
    $(`upd-${id}`)?.remove(); updSeen.delete(id);
    if (upd?.el?.isConnected) { upd.pinned = upd.pinned.filter(u => u.id !== id); upd.list = upd.list.filter(u => u.id !== id); if (!upd.pinned.length && !upd.list.length) drawClassUpdates(); }
    if (act?.el?.isConnected) act.items = act.items.filter(x => x.update?.id !== id);
    toast('Update deleted');
  } catch (e) { toast(e.message, 'err'); }
}

/* ====================== a class's Updates page ====================== */
let upd = null; // { el, cls, pinned, list, more, busy }

function renderClassUpdates(el, cls) {
  upd = { el, cls, pinned: null, list: [], more: false, busy: false };
  drawClassUpdates();
  loadClassUpdates();
}
async function loadClassUpdates(more = false) {
  if (!upd || upd.busy) return;
  upd.busy = true;
  const last = more ? upd.list[upd.list.length - 1] : null;
  const before = last ? `&before=${encodeURIComponent(last.createdAt)}&beforeKey=${encodeURIComponent(last.id)}` : '';
  try {
    const r = await api(`/api/classes/${upd.cls.id}/updates?limit=20${before}`);
    if (!upd.el.isConnected) return;
    if (!more) upd.pinned = r.pinned || [];
    upd.list = more ? [...upd.list, ...r.updates] : r.updates;
    upd.more = !!r.more;
  } catch (e) { if (!more) upd.pinned = []; toast(e.message, 'err'); }
  finally { upd.busy = false; }
  drawClassUpdates();
}
function drawClassUpdates() {
  const { el, cls } = upd;
  if (!el.isConnected) return;
  const ctx = { canManage: cls.isTeacher, showClass: false, cls };
  const composer = cls.isTeacher && !cls.archived ? `<div class="upd-composer">
      <textarea id="updText" maxlength="5000" placeholder="Write an update for ${esc(cls.name)}: a reminder, a change of plan, a link…" aria-label="New update"></textarea>
      <div class="upd-composer-foot"><label class="check-row"><input type="checkbox" id="updPin" /> <span>Pin to the top</span></label><span class="grow"></span>
        <button class="btn btn-primary btn-sm" id="updPost" onclick="postClassUpdate()">${PI.send}Post</button></div></div>` : '';
  let feed;
  if (upd.pinned === null) feed = '<div class="loading-row"><span class="spinner"></span></div>';
  else if (!upd.pinned.length && !upd.list.length) feed = `<div class="feed-empty"><b>No updates yet</b>${cls.isTeacher ? 'Updates you post here show up for every student in the class, on this page and in their Recent Activity.' : 'Your teacher’s announcements for this class show up here.'}</div>`;
  else feed = [...upd.pinned, ...upd.list].map(u => updateCardHtml(u, ctx)).join('')
    + (upd.more ? `<div class="upd-more"><button class="btn btn-ghost btn-sm" onclick="loadClassUpdates(true)">Show older updates</button></div>` : '');
  // Keep anything half-typed in the box
  const draft = $('updText')?.value || '', pin = $('updPin')?.checked || false;
  el.innerHTML = composer + feed;
  if ($('updText')) { $('updText').value = draft; $('updPin').checked = pin; }
}
async function postClassUpdate() {
  if ($('updPost').disabled) return; // already posting
  const text = $('updText').value;
  if (!text.trim()) { toast('Write something to post', 'err'); $('updText').focus(); return; }
  $('updPost').disabled = true;
  try {
    await api(`/api/classes/${upd.cls.id}/updates`, { method: 'POST', body: { body: text, pinned: $('updPin').checked } });
    $('updText').value = ''; $('updPin').checked = false;
    toast('Posted. Students can see it now.');
    loadClassUpdates();
  } catch (e) { toast(e.message, 'err'); }
  finally { if ($('updPost')) $('updPost').disabled = false; }
}

/* ====================== Home: Recent Activity ====================== */
let act = null; // { el, classes, items, more, busy, picked: Set }

function renderActivity(el, classes) {
  const active = classes.filter(c => !c.archived);
  const teaching = active.filter(c => c.isTeacher);
  act = { el, classes: active, teaching, items: null, more: false, busy: false, picked: new Set(teaching.length === 1 ? [teaching[0].id] : []) };
  drawActivity();
  loadActivity();
}
async function loadActivity(more = false) {
  if (!act || act.busy) return;
  act.busy = true;
  const last = more ? act.items?.[act.items.length - 1] : null;
  const before = last ? `&before=${encodeURIComponent(last.at)}&beforeKey=${encodeURIComponent(last.key)}` : '';
  try {
    const r = await api(`/api/activity?limit=20${before}`);
    if (!act.el.isConnected) return;
    act.items = more ? [...act.items, ...r.items] : r.items;
    act.more = !!r.more;
  } catch (e) { if (!more) act.items = []; toast(e.message, 'err'); }
  finally { act.busy = false; }
  drawActivity();
}
function drawActivity() {
  const { el } = act;
  if (!el.isConnected) return;
  const composer = act.teaching.length ? `<div class="upd-composer">
      <textarea id="actText" maxlength="5000" placeholder="Post an update to your classes…" aria-label="New update"></textarea>
      <div class="upd-composer-foot"><span class="small muted">Post to:</span><span class="upd-classes" role="group" aria-label="Classes to post to">${act.teaching.map(c => `<button type="button" class="upd-class cc-${courseColor(c)}" aria-pressed="${act.picked.has(c.id)}" onclick="pickActClass('${c.id}', this)"><i></i>${esc(c.name)}</button>`).join('')}</span>
        <span class="grow"></span><button class="btn btn-primary btn-sm" id="actPost" onclick="postActivityUpdate()">${PI.send}Post</button></div></div>` : '';
  let feed;
  if (act.items === null) feed = '<div class="loading-row"><span class="spinner"></span></div>';
  else if (!act.items.length) feed = `<div class="feed-empty"><b>Nothing yet</b>${me.role === 'teacher' ? 'Updates you post and assignments you publish show up here.' : 'Your teachers’ updates and new assignments show up here.'}</div>`;
  else feed = act.items.map(activityItemHtml).join('') + (act.more ? `<div class="upd-more"><button class="btn btn-ghost btn-sm" onclick="loadActivity(true)">Show older activity</button></div>` : '');
  const draft = $('actText')?.value || '';
  el.innerHTML = composer + feed;
  if ($('actText')) $('actText').value = draft;
}
function activityItemHtml(it) {
  const cls = { id: it.classId, name: it.className, color: it.color, isTeacher: act.teaching.some(c => c.id === it.classId) };
  if (it.kind === 'update') return updateCardHtml(it.update, { canManage: cls.isTeacher, showClass: true, cls });
  const who = it.teacher?.id === me.id ? 'You' : it.teacher?.name || 'Your teacher';
  return `<article class="upd">
    ${typeIcon(it.type, 'act-ic')}
    <div class="upd-main">
      <div class="upd-head"><span class="upd-author">${esc(who)}</span><span class="upd-where">posted ${it.type === 'writing' ? 'a writing assignment' : it.type === 'group' ? 'a group project' : 'a discussion'} in <a href="/class/${it.classId}" data-link>${esc(it.className)}</a></span><span class="upd-time" title="${esc(vcDateTime(it.at))}">${esc(timeAgo(it.at))}</span></div>
      <div class="upd-body"><a href="/a/${it.assignmentId}" data-link style="font-weight:700;">${esc(it.title)}</a>${it.dueAt || it.type !== 'discussion' ? `<div class="small muted">${esc(vcDue(it.dueAt))}</div>` : ''}</div>
    </div></article>`;
}
function pickActClass(id, btn) {
  if (act.picked.has(id)) act.picked.delete(id); else act.picked.add(id);
  btn.setAttribute('aria-pressed', String(act.picked.has(id)));
}
async function postActivityUpdate() {
  if ($('actPost').disabled) return; // already posting
  const text = $('actText').value;
  if (!text.trim()) { toast('Write something to post', 'err'); $('actText').focus(); return; }
  if (!act.picked.size) { toast('Pick at least one class to post to', 'err'); return; }
  $('actPost').disabled = true;
  try {
    const r = await api('/api/updates', { method: 'POST', body: { classIds: [...act.picked], body: text } });
    $('actText').value = '';
    toast(`Posted to ${vcPlural(r.updates.length, 'class', 'classes')}`);
    loadActivity();
  } catch (e) { toast(e.message, 'err'); }
  finally { if ($('actPost')) $('actPost').disabled = false; }
}
