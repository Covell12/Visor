/* Concept 1 — "Broadsheet": paper, serif figures, thin rules, almost no chrome. */

'use strict';

const { DOC, growthPath } = require('./common');

const g = growthPath(300, 64);

module.exports = {
  name: 'broadsheet',
  label: 'Broadsheet — paper, serif figures, rules instead of boxes',
  css: `
  :root {
    --paper: #FBFAF7;
    --ink: #17171A;
    --ink-2: #4A4A52;
    --ink-3: #85858F;
    --rule: #DFDDD6;
    --rule-2: #EDEBE5;
    --accent: #1F5E4D;
    --hot: #A23B36;
    --serif: 'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif;
  }
  .panel { background: var(--paper); color: var(--ink); font-family: ui-sans-serif, -apple-system, 'Segoe UI', sans-serif; }

  .b-head { padding: 18px 20px 14px; border-bottom: 2px solid var(--ink); }
  .b-kicker { font-size: 9.5px; letter-spacing: 2.4px; text-transform: uppercase; color: var(--ink-3); }
  .b-title { margin-top: 7px; font-family: var(--serif); font-size: 21px; line-height: 1.15; letter-spacing: -0.3px; }
  .b-byline { margin-top: 6px; font-size: 11px; color: var(--ink-2); }

  .b-nav { display: flex; gap: 16px; padding: 10px 20px; border-bottom: 1px solid var(--rule); font-size: 11px; letter-spacing: 0.4px; text-transform: uppercase; color: var(--ink-3); }
  .b-nav .on { color: var(--ink); font-weight: 700; box-shadow: inset 0 -2px 0 var(--accent); padding-bottom: 2px; }

  .b-body { padding: 4px 20px 20px; }

  .b-lead { display: flex; align-items: flex-end; gap: 12px; padding: 20px 0 16px; border-bottom: 1px solid var(--rule); }
  .b-figure { font-family: var(--serif); font-size: 54px; line-height: 0.9; letter-spacing: -2px; }
  .b-figure small { font-family: inherit; font-size: 15px; letter-spacing: 0; color: var(--ink-3); margin-left: 6px; }
  .b-lead-note { flex: 1; font-size: 11.5px; line-height: 1.5; color: var(--ink-2); padding-bottom: 4px; }

  .b-row { display: flex; justify-content: space-between; gap: 14px; padding: 13px 0; border-bottom: 1px solid var(--rule-2); }
  .b-row:last-child { border-bottom: none; }
  .b-key { font-size: 11.5px; color: var(--ink-2); }
  .b-val { font-family: var(--serif); font-size: 15px; font-variant-numeric: tabular-nums; }
  .b-val.hot { color: var(--hot); }

  .b-sec { margin-top: 22px; font-size: 9.5px; letter-spacing: 2.2px; text-transform: uppercase; color: var(--ink-3); padding-bottom: 7px; border-bottom: 1px solid var(--ink); }

  .b-person { padding: 13px 0; border-bottom: 1px solid var(--rule-2); }
  .b-person-top { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
  .b-name { font-family: var(--serif); font-size: 15px; }
  .b-share { font-family: var(--serif); font-size: 15px; font-variant-numeric: tabular-nums; }
  .b-meta { margin-top: 3px; font-size: 10.5px; color: var(--ink-3); }
  .b-bar { margin-top: 8px; height: 2px; background: var(--rule); }
  .b-bar i { display: block; height: 100%; background: var(--ink); }

  .b-chart { margin-top: 14px; }
  .b-chart svg { display: block; width: 100%; height: 64px; }

  /* ── The bar in the document ─────────────────────────────────────────── */
  .b-dock {
    display: inline-flex; align-items: stretch; gap: 0;
    background: var(--paper); border: 1px solid var(--ink);
    box-shadow: 6px 6px 0 rgba(23,23,26,0.12);
    font-family: ui-sans-serif, -apple-system, sans-serif; color: var(--ink);
  }
  .b-dock-cell { padding: 9px 14px; border-right: 1px solid var(--rule); display: flex; align-items: center; gap: 8px; }
  .b-dock-cell:last-child { border-right: none; }
  .b-dock-mark { font-family: var(--serif); font-size: 13px; letter-spacing: 0.4px; }
  .b-dock-fig { font-family: var(--serif); font-size: 14px; font-variant-numeric: tabular-nums; }
  .b-dock-lab { font-size: 9px; letter-spacing: 1.6px; text-transform: uppercase; color: var(--ink-3); }
  .b-dock-play { background: var(--ink); color: var(--paper); padding: 0 14px; display: flex; align-items: center; }

  /* ── The collapsed button ────────────────────────────────────────────── */
  .b-btn {
    display: inline-flex; align-items: center; gap: 9px; padding: 8px 14px;
    background: var(--paper); border: 1px solid var(--ink); box-shadow: 4px 4px 0 rgba(23,23,26,0.12);
    font-family: var(--serif); font-size: 13px; color: var(--ink);
  }
  .b-btn span { font-size: 10px; font-family: ui-sans-serif, sans-serif; letter-spacing: 1.4px; text-transform: uppercase; color: var(--ink-3); }
  `,
  panel: `
  <div class="b-head">
    <div class="b-kicker">Visor · Revision record</div>
    <div class="b-title">${DOC.title}</div>
    <div class="b-byline">${DOC.people.length} contributors · ${DOC.span} · read from the document's own log</div>
  </div>
  <div class="b-nav"><span class="on">Overview</span><span>People</span><span>Timeline</span><span>Evidence</span><span>Signal</span></div>
  <div class="b-body">
    <div class="b-lead">
      <div class="b-figure">${DOC.words}<small>words</small></div>
      <div class="b-lead-note">of which <strong>${DOC.externalPct}%</strong> arrived from outside the document.</div>
    </div>
    <div class="b-row"><span class="b-key">Edit operations</span><span class="b-val">${DOC.edits}</span></div>
    <div class="b-row"><span class="b-key">Active writing</span><span class="b-val">${DOC.writing}</span></div>
    <div class="b-row"><span class="b-key">Pastes</span><span class="b-val">${DOC.pastes}</span></div>
    <div class="b-row"><span class="b-key">Characters deleted</span><span class="b-val hot">${DOC.deleted}</span></div>

    <div class="b-sec">Growth</div>
    <div class="b-chart">
      <svg viewBox="0 0 300 64" preserveAspectRatio="none">
        <polygon points="${g.area}" fill="rgba(31,94,77,0.10)"/>
        <polyline points="${g.line}" fill="none" stroke="#1F5E4D" stroke-width="1.5"/>
      </svg>
    </div>

    <div class="b-sec">Contributors</div>
    ${DOC.people.map((p) => `
      <div class="b-person">
        <div class="b-person-top"><span class="b-name">${p.name}</span><span class="b-share">${p.share}%</span></div>
        <div class="b-meta">${p.chars} characters · ${p.mins} active · ${p.typed}% typed</div>
        <div class="b-bar"><i style="width:${p.share}%"></i></div>
      </div>`).join('')}
  </div>`,
  dock: `
  <div class="b-dock">
    <div class="b-dock-cell"><span class="b-dock-mark">VISOR</span></div>
    <div class="b-dock-cell"><span class="b-dock-fig">${DOC.people[0].share}%</span><span class="b-dock-lab">${DOC.people[0].first}</span></div>
    <div class="b-dock-cell"><span class="b-dock-fig">${DOC.words}</span><span class="b-dock-lab">words</span></div>
    <div class="b-dock-cell"><span class="b-dock-fig">${DOC.externalPct}%</span><span class="b-dock-lab">external</span></div>
    <div class="b-dock-cell"><span class="b-dock-lab">Current tab ▾</span></div>
    <div class="b-dock-play">▶</div>
  </div>`,
  button: `<div class="b-btn">Visor <span>open</span></div>`
};
