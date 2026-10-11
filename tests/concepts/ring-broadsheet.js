/* Rings × Broadsheet — Apple Health's structure (coloured section titles,
 * activity rings, "show all" affordances) built in paper, serif figures and
 * hairline rules instead of grey cards and rounded sans. */

'use strict';

const { DOC, growthPath } = require('./common');

const g = growthPath(300, 66);
const maxHour = Math.max(...DOC.hours);

/* Concentric rings, one per contributor, Health-style but hairline-thin. */
function rings(size, stroke, gap) {
  const cx = size / 2;
  return DOC.people.map((p, i) => {
    const r = cx - stroke / 2 - i * (stroke + gap) - 1;
    const c = 2 * Math.PI * r;
    return `
      <circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke="${p.colour}" stroke-opacity="0.15" stroke-width="${stroke}"/>
      <circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke="${p.colour}" stroke-width="${stroke}"
              stroke-linecap="round" stroke-dasharray="${(c * p.share / 100).toFixed(1)} ${c.toFixed(1)}"
              transform="rotate(-90 ${cx} ${cx})"/>`;
  }).join('');
}

module.exports = {
  name: 'ring-broadsheet',
  label: 'Rings × Broadsheet — Health’s structure in paper, serif figures and hairline rules',
  tall: true,
  css: `
  :root {
    --paper: #FAF9F5;
    --card: #FFFFFF;
    --ink: #16211C;
    --ink-2: #4C594F;
    --ink-3: #8A958C;
    --rule: #E4E2D9;
    --rule-2: #EFEDE6;
    --green: #17624A;
    --green-deep: #0E4635;
    --green-fill: #2E9C74;
    --blue: #2F6FC4;
    --teal: #118A7E;
    --orange: #B4742A;
    --red: #A8402F;
    --serif: 'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif;
    --sans: -apple-system, 'SF Pro Text', ui-sans-serif, 'Segoe UI', sans-serif;
  }
  .panel { background: var(--paper); color: var(--ink); font-family: var(--sans); -webkit-font-smoothing: antialiased; }

  /* Masthead: editorial, not a title bar. */
  .rb-head { padding: 16px 18px 12px; }
  .rb-brand { display: flex; align-items: baseline; gap: 9px; }
  .rb-brand b { font-family: var(--serif); font-size: 21px; letter-spacing: 0.4px; }
  .rb-brand span { font-size: 11.5px; color: var(--ink-3); }
  .rb-rule { height: 2px; background: var(--ink); margin: 11px 0 0; }

  /* Health's pill tabs, in ink and paper. */
  .rb-tabs { display: flex; gap: 7px; padding: 12px 18px 4px; }
  .rb-tabs span { padding: 5px 12px; border-radius: 999px; border: 1px solid var(--rule); font-size: 11.5px; color: var(--ink-2); }
  .rb-tabs span.on { background: var(--green-deep); border-color: var(--green-deep); color: #F4F8F5; }

  .rb-body { padding: 10px 18px 20px; }

  /* A section: coloured title, hairline rule, an affordance at the right. */
  .rb-sec { display: flex; align-items: baseline; gap: 10px; margin: 20px 0 9px; }
  .rb-sec-title { font-size: 11px; font-weight: 700; letter-spacing: 1.4px; text-transform: uppercase; color: var(--c, var(--green)); }
  .rb-sec-rule { flex: 1; height: 1px; background: var(--rule); }
  .rb-sec-more { font-size: 11px; color: var(--ink-3); }

  /* The headline figure sits on paper, not in a box. */
  .rb-lead { display: flex; align-items: baseline; gap: 9px; }
  .rb-lead-num { font-family: var(--serif); font-size: 50px; line-height: 0.9; letter-spacing: -1.8px; }
  .rb-lead-unit { font-family: var(--serif); font-size: 15px; color: var(--ink-3); }
  .rb-lead-sub { margin-top: 8px; font-size: 12px; color: var(--ink-2); }
  .rb-chart { margin-top: 10px; }
  .rb-chart svg { display: block; width: 100%; height: 66px; }
  .rb-axis { display: flex; justify-content: space-between; margin-top: 4px; font-size: 10px; color: var(--ink-3); }

  /* Rings, with the roster read as a list beside them. */
  .rb-rings { display: flex; align-items: center; gap: 18px; padding: 4px 0 2px; }
  .rb-rings svg { flex: none; }
  .rb-keys { flex: 1; }
  .rb-key { display: flex; align-items: baseline; gap: 9px; padding: 8px 0; border-bottom: 1px solid var(--rule-2); }
  .rb-key:last-child { border-bottom: none; }
  .rb-key i { width: 9px; height: 9px; border-radius: 50%; background: var(--c); transform: translateY(-1px); }
  .rb-key-name { font-size: 12.5px; }
  .rb-key-meta { font-size: 10.5px; color: var(--ink-3); margin-top: 2px; }
  .rb-key-share { margin-left: auto; font-family: var(--serif); font-size: 19px; color: var(--c); }

  /* The measured figures: dot-free hairline rows, serif values. */
  .rb-row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 11px 0; border-bottom: 1px solid var(--rule-2); }
  .rb-row:last-child { border-bottom: none; }
  .rb-row-key { font-size: 12px; color: var(--ink-2); }
  .rb-row-val { font-family: var(--serif); font-size: 17px; font-variant-numeric: tabular-nums; }
  .rb-row-val small { font-family: var(--sans); font-size: 10.5px; color: var(--ink-3); margin-left: 7px; }
  .rb-row-val.red { color: var(--red); }
  .rb-row-val.orange { color: var(--orange); }

  /* One card, for the thing that benefits from being an object: the hours. */
  .rb-card { margin-top: 4px; padding: 13px 14px 11px; background: var(--card); border: 1px solid var(--rule); border-radius: 12px; }
  .rb-hours { display: flex; align-items: flex-end; gap: 3px; height: 46px; }
  .rb-hours i { flex: 1; border-radius: 2px 2px 0 0; background: var(--green-fill); }
  .rb-hours-axis { display: flex; justify-content: space-between; margin-top: 6px; font-size: 9.5px; color: var(--ink-3); }

  .rb-foot { margin-top: 22px; padding-top: 12px; border-top: 2px solid var(--ink); font-size: 10.5px; color: var(--ink-3); line-height: 1.5; }

  /* ── Bar: paper capsule, rings, serif figures ────────────────────────── */
  .rb-dock {
    display: inline-flex; align-items: center; gap: 14px; padding: 8px 9px 8px 15px;
    background: var(--paper); border: 1px solid var(--rule); border-radius: 999px;
    box-shadow: 0 22px 44px -26px rgba(14,35,28,0.55), 0 1px 2px rgba(14,35,28,0.06);
    font-family: var(--sans); color: var(--ink);
  }
  .rb-dock-mark { font-family: var(--serif); font-size: 14px; letter-spacing: 0.4px; color: var(--green); }
  .rb-dock-item { display: inline-flex; align-items: baseline; gap: 6px; font-size: 11.5px; color: var(--ink-2); }
  .rb-dock-item b { font-family: var(--serif); font-size: 14px; color: var(--c, var(--ink)); }
  .rb-dock-div { width: 1px; height: 18px; background: var(--rule); align-self: center; }
  .rb-dock-tab { font-size: 11.5px; color: var(--ink-2); }
  .rb-dock-play { width: 29px; height: 29px; border-radius: 50%; background: var(--green-deep); color: #fff; display: grid; place-items: center; font-size: 10px; }

  /* ── Button: the rings, and the word ─────────────────────────────────── */
  .rb-btn { display: inline-flex; align-items: center; gap: 9px; padding: 6px 13px 6px 7px; background: var(--paper); border: 1px solid var(--rule); border-radius: 999px; box-shadow: 0 14px 30px -20px rgba(14,35,28,0.6); }
  .rb-btn b { font-family: var(--serif); font-size: 14px; letter-spacing: 0.4px; color: var(--green); }
  `,
  panel: `
  <div class="rb-head">
    <div class="rb-brand"><b>VISOR</b><span>${DOC.title}</span></div>
    <div class="rb-rule"></div>
  </div>
  <div class="rb-tabs"><span class="on">Overview</span><span>People</span><span>Timeline</span><span>Evidence</span></div>

  <div class="rb-body">
    <div class="rb-sec"><span class="rb-sec-title">Words now</span><span class="rb-sec-rule"></span><span class="rb-sec-more">${DOC.span} ›</span></div>
    <div class="rb-lead"><span class="rb-lead-num">${DOC.words}</span><span class="rb-lead-unit">words</span></div>
    <div class="rb-lead-sub">written by ${DOC.people.length} people · ${DOC.externalPct}% arrived from outside the document</div>
    <div class="rb-chart">
      <svg viewBox="0 0 300 66" preserveAspectRatio="none">
        <polygon points="${g.area}" fill="rgba(23,98,74,0.10)"/>
        <polyline points="${g.line}" fill="none" stroke="#17624A" stroke-width="1.6"/>
      </svg>
      <div class="rb-axis"><span>first edit</span><span>now</span></div>
    </div>

    <div class="rb-sec" style="--c:var(--blue)"><span class="rb-sec-title">Contributions</span><span class="rb-sec-rule"></span><span class="rb-sec-more">Show all ›</span></div>
    <div class="rb-rings">
      <svg width="104" height="104" viewBox="0 0 104 104">${rings(104, 10, 4)}</svg>
      <div class="rb-keys">
        ${DOC.people.map((p) => `
          <div class="rb-key" style="--c:${p.colour}">
            <i></i>
            <div>
              <div class="rb-key-name">${p.name}</div>
              <div class="rb-key-meta">${p.chars} chars · ${p.mins} · ${p.typed}% typed</div>
            </div>
            <span class="rb-key-share">${p.share}%</span>
          </div>`).join('')}
      </div>
    </div>

    <div class="rb-sec" style="--c:var(--teal)"><span class="rb-sec-title">The work</span><span class="rb-sec-rule"></span></div>
    <div class="rb-row"><span class="rb-row-key">Edit operations</span><span class="rb-row-val">${DOC.edits}</span></div>
    <div class="rb-row"><span class="rb-row-key">Active writing</span><span class="rb-row-val">${DOC.writing}</span></div>
    <div class="rb-row"><span class="rb-row-key">Pastes</span><span class="rb-row-val orange">${DOC.pastes}<small>${DOC.externalPct}% external</small></span></div>
    <div class="rb-row"><span class="rb-row-key">Characters deleted</span><span class="rb-row-val red">${DOC.deleted}</span></div>

    <div class="rb-sec" style="--c:var(--green-fill)"><span class="rb-sec-title">When it was written</span><span class="rb-sec-rule"></span><span class="rb-sec-more">Expand ›</span></div>
    <div class="rb-card">
      <div class="rb-hours">${DOC.hours.map((h) => `<i style="height:${Math.max(5, (h / maxHour) * 100)}%;opacity:${h ? 0.35 + (h / maxHour) * 0.65 : 0.14}"></i>`).join('')}</div>
      <div class="rb-hours-axis"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
    </div>

    <div class="rb-foot">Every figure on this page was read from the document's own revision log, in your browser. Nothing was sent anywhere.</div>
  </div>`,
  dock: `
  <div class="rb-dock">
    <span class="rb-dock-mark">VISOR</span>
    <svg width="26" height="26" viewBox="0 0 104 104">${rings(104, 12, 5)}</svg>
    ${DOC.people.map((p) => `<span class="rb-dock-item" style="--c:${p.colour}"><b>${p.share}%</b>${p.first}</span>`).join('')}
    <span class="rb-dock-div"></span>
    <span class="rb-dock-item"><b>${DOC.words}</b>words</span>
    <span class="rb-dock-div"></span>
    <span class="rb-dock-tab">Current tab ⌄</span>
    <span class="rb-dock-play">▶</span>
  </div>`,
  button: `
  <div class="rb-btn">
    <svg width="27" height="27" viewBox="0 0 104 104">${rings(104, 12, 5)}</svg>
    <b>VISOR</b>
  </div>`
};
