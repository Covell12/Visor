/* Visor Classroom — search. The sidebar's Search, or Cmd/Ctrl+K, opens a box that
   jumps to a class, assignment, group project or student. The server sends what
   this person can open (/api/search-index) and the box filters it as they type.

   In the essay editor Cmd+K is Insert link, so there it stays the editor's. */

'use strict';

let jump = null; // { index, rows, on }

const JUMP_GROUPS = [
  ['classes', 'Classes', x => x.name, () => '', x => `/class/${x.id}`],
  ['assignments', 'Assignments', x => x.title, x => `${x.draft ? 'Draft · ' : ''}${x.className}`, x => `/a/${x.id}`],
  ['projects', 'Group projects', x => x.name, () => '', x => `/project/${x.id}`],
  ['students', 'Students', x => x.name, x => x.className, x => `/class/${x.classId}?tab=people`]
];

// Rows matching every word typed; a label that starts with the search comes first
function jumpMatches(q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const out = [];
  for (const [key, heading, label, sub, href] of JUMP_GROUPS) {
    const rows = (jump.index[key] || [])
      .map(x => ({ label: label(x), sub: sub(x), href: href(x) }))
      .filter(r => words.every(w => `${r.label} ${r.sub}`.toLowerCase().includes(w)))
      .sort((a, b) => Number(b.label.toLowerCase().startsWith(words[0] || '')) - Number(a.label.toLowerCase().startsWith(words[0] || '')) || a.label.localeCompare(b.label))
      .slice(0, words.length ? 6 : 5);
    if (rows.length && (words.length || key === 'classes' || key === 'projects')) out.push({ heading, rows });
  }
  return out;
}

function jumpDraw() {
  const box = $('jumpList');
  if (!box || !jump) return;
  const q = $('jumpQ').value.trim();
  const groups = jumpMatches(q);
  jump.rows = groups.flatMap(g => g.rows);
  jump.on = 0;
  let n = 0;
  box.innerHTML = groups.length ? groups.map(g => `<div class="jump-h">${esc(g.heading)}</div>${g.rows.map(r => `<button type="button" class="jump-row${n === 0 ? ' on' : ''}" data-i="${n++}"><b>${esc(r.label)}</b>${r.sub ? `<span>${esc(r.sub)}</span>` : ''}</button>`).join('')}`).join('')
    : `<div class="jump-empty">${q ? `Nothing matches “${esc(q)}”.` : 'Nothing to search yet.'}</div>`;
}

function jumpMove(by) {
  if (!jump?.rows.length) return;
  jump.on = (jump.on + by + jump.rows.length) % jump.rows.length;
  $('jumpList').querySelectorAll('.jump-row').forEach((b, i) => { const on = i === jump.on; b.classList.toggle('on', on); if (on) b.scrollIntoView({ block: 'nearest' }); });
}

function jumpOpenRow(i) {
  const r = jump?.rows[i];
  if (!r) return;
  closeModal();
  VisorRouter.go(r.href);
}

async function openJump() {
  if (window.toggleNav) toggleNav(false);
  jump = { index: {}, rows: [], on: 0 };
  openModal({ title: 'Search', onClose: () => { jump = null; }, body: `<div class="jump-box"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input id="jumpQ" class="input" type="search" autocomplete="off" aria-label="Search classes, assignments, projects and students" placeholder="Classes, assignments, projects, students" /></div>
    <div id="jumpList" class="jump-list"><div class="jump-empty"><span class="spinner spinner-sm"></span></div></div>` });
  const input = $('jumpQ');
  input.focus();
  input.addEventListener('input', jumpDraw);
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); jumpMove(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); jumpMove(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); jumpOpenRow(jump?.on); }
    else if (e.key === 'Escape') { e.preventDefault(); closeModal(); }
  });
  $('jumpList').addEventListener('click', e => { const b = e.target.closest('.jump-row'); if (b) jumpOpenRow(Number(b.dataset.i)); });
  try {
    const index = await api('/api/search-index');
    if (!jump) return; // closed while it loaded
    jump.index = index;
    jumpDraw();
  } catch (e) { if ($('jumpList')) $('jumpList').innerHTML = `<div class="jump-empty">${esc(e.message)}</div>`; }
}

document.addEventListener('keydown', e => {
  if (e.key.toLowerCase() !== 'k' || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
  if (!me || document.body.classList.contains('writing') || $('modalRoot').firstElementChild) return;
  e.preventDefault();
  openJump();
});

if ($('jumpKey')) $('jumpKey').textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K';
