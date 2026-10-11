/* Concept 4 — "Instrument": near-monochrome, one accent, type and space only. */

'use strict';

const { DOC, growthPath } = require('./common');

const g = growthPath(300, 58);

module.exports = {
  name: 'instrument',
  label: 'Instrument — near-monochrome, one accent, no boxes at all',
  css: `
  :root {
    --bg: #FFFFFF;
    --ink: #0B0C0E;
    --ink-2: #4E525A;
    --ink-3: #9096A0;
    --line: #EDEEF1;
    --accent: #0A5AFF;
    --hot: #D22D4F;
  }
  .panel { background: var(--bg); color: var(--ink); font-family: ui-sans-serif, -apple-system, 'Segoe UI', sans-serif; }

  .i-head { display: flex; align-items: center; gap: 10px; padding: 16px 18px 12px; }
  .i-mark { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); }
  .i-title { font-size: 12.5px; font-weight: 600; letter-spacing: -0.1px; }
  .i-sub { font-size: 11px; color: var(--ink-3); margin-left: auto; }

  .i-tabs { display: flex; gap: 18px; padding: 0 18px; border-bottom: 1px solid var(--line); }
  .i-tabs span { padding: 8px 0 10px; font-size: 11.5px; color: var(--ink-3); }
  .i-tabs span.on { color: var(--ink); font-weight: 600; box-shadow: inset 0 -1.5px 0 var(--ink); }

  .i-body { padding: 22px 18px 18px; }

  .i-lead { display: flex; align-items: baseline; gap: 8px; }
  .i-lead-num { font-size: 46px; font-weight: 300; letter-spacing: -2.4px; line-height: 1; font-variant-numeric: tabular-nums; }
  .i-lead-unit { font-size: 13px; color: var(--ink-3); }
  .i-lead-sub { margin-top: 8px; font-size: 12px; color: var(--ink-2); }

  .i-chart { margin: 18px 0 4px; }
  .i-chart svg { display: block; width: 100%; height: 58px; }

  .i-scale { display: flex; justify-content: space-between; font-size: 10px; color: var(--ink-3); }

  .i-rows { margin-top: 26px; }
  .i-row { display: flex; align-items: baseline; justify-content: space-between; padding: 11px 0; border-top: 1px solid var(--line); }
  .i-row:last-child { border-bottom: 1px solid var(--line); }
  .i-row-key { font-size: 12px; color: var(--ink-2); }
  .i-row-val { font-size: 13.5px; font-weight: 560; font-variant-numeric: tabular-nums; }
  .i-row-val.hot { color: var(--hot); }
  .i-row-val small { color: var(--ink-3); font-weight: 400; margin-left: 5px; }

  .i-sec { margin: 28px 0 4px; font-size: 11px; font-weight: 600; color: var(--ink); }
  .i-sec span { color: var(--ink-3); font-weight: 400; margin-left: 6px; }

  .i-person { padding: 13px 0; border-top: 1px solid var(--line); }
  .i-person:last-child { border-bottom: 1px solid var(--line); }
  .i-person-top { display: flex; align-items: baseline; gap: 8px; }
  .i-pname { font-size: 12.5px; }
  .i-pshare { margin-left: auto; font-size: 12.5px; font-variant-numeric: tabular-nums; }
  .i-dots { display: flex; gap: 3px; margin-top: 9px; }
  .i-dots i { width: 5px; height: 5px; border-radius: 50%; background: var(--ink); opacity: 0.85; }
  .i-dots i.off { background: var(--line); }
  .i-pmeta { margin-top: 7px; font-size: 10.5px; color: var(--ink-3); }

  /* ── The bar in the document ─────────────────────────────────────────── */
  .i-dock {
    display: inline-flex; align-items: center; gap: 16px; padding: 10px 12px 10px 16px;
    background: rgba(255,255,255,0.96); border: 1px solid var(--line); border-radius: 12px;
    box-shadow: 0 18px 40px -26px rgba(11,12,14,0.7);
    font-family: ui-sans-serif, -apple-system, sans-serif; color: var(--ink);
  }
  .i-dock-mark { display: inline-flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 600; }
  .i-dock-mark i { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); }
  .i-dock-fig { font-size: 12px; font-variant-numeric: tabular-nums; }
  .i-dock-fig span { color: var(--ink-3); margin-left: 5px; }
  .i-dock-spark svg { display: block; width: 74px; height: 18px; }
  .i-dock-tab { font-size: 11.5px; color: var(--ink-2); }
  .i-dock-play { width: 26px; height: 26px; border-radius: 8px; border: 1px solid var(--line); display: grid; place-items: center; font-size: 9px; color: var(--accent); }

  /* ── The collapsed button ────────────────────────────────────────────── */
  .i-btn { display: inline-flex; align-items: center; gap: 8px; padding: 8px 13px; background: #fff; border: 1px solid var(--line); border-radius: 999px; box-shadow: 0 12px 26px -20px rgba(11,12,14,0.8); font-size: 12px; }
  .i-btn i { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); }
  .i-btn b { font-weight: 560; }
  .i-btn span { color: var(--ink-3); }
  `,
  panel: `
  <div class="i-head">
    <span class="i-mark"></span>
    <span class="i-title">Visor</span>
    <span class="i-sub">${DOC.title}</span>
  </div>
  <div class="i-tabs"><span class="on">Overview</span><span>People</span><span>Timeline</span><span>Evidence</span><span>Signal</span></div>
  <div class="i-body">
    <div class="i-lead">
      <span class="i-lead-num">${DOC.words}</span>
      <span class="i-lead-unit">words</span>
    </div>
    <div class="i-lead-sub">${DOC.people.length} people · ${DOC.span} · ${DOC.externalPct}% arrived from outside</div>

    <div class="i-chart">
      <svg viewBox="0 0 300 58" preserveAspectRatio="none">
        <polyline points="${g.line}" fill="none" stroke="#0A5AFF" stroke-width="1.5"/>
      </svg>
    </div>
    <div class="i-scale"><span>first edit</span><span>now</span></div>

    <div class="i-rows">
      <div class="i-row"><span class="i-row-key">Edit operations</span><span class="i-row-val">${DOC.edits}</span></div>
      <div class="i-row"><span class="i-row-key">Active writing</span><span class="i-row-val">${DOC.writing}</span></div>
      <div class="i-row"><span class="i-row-key">Pastes</span><span class="i-row-val">${DOC.pastes}<small>${DOC.externalPct}% external</small></span></div>
      <div class="i-row"><span class="i-row-key">Characters deleted</span><span class="i-row-val hot">${DOC.deleted}</span></div>
    </div>

    <div class="i-sec">Contributors<span>by surviving text</span></div>
    ${DOC.people.map((p) => `
      <div class="i-person">
        <div class="i-person-top"><span class="i-pname">${p.name}</span><span class="i-pshare">${p.share}%</span></div>
        <div class="i-dots">${Array.from({ length: 20 }, (_, i) => `<i class="${i < Math.round(p.share / 5) ? '' : 'off'}"></i>`).join('')}</div>
        <div class="i-pmeta">${p.chars} characters · ${p.mins} active · ${p.typed}% typed</div>
      </div>`).join('')}
  </div>`,
  dock: `
  <div class="i-dock">
    <span class="i-dock-mark"><i></i>Visor</span>
    <span class="i-dock-fig">${DOC.people[0].share}%<span>${DOC.people[0].first}</span></span>
    <span class="i-dock-spark">
      <svg viewBox="0 0 300 58" preserveAspectRatio="none"><polyline points="${g.line}" fill="none" stroke="#0A5AFF" stroke-width="4"/></svg>
    </span>
    <span class="i-dock-fig">${DOC.words}<span>words</span></span>
    <span class="i-dock-tab">Current tab ▾</span>
    <span class="i-dock-play">▶</span>
  </div>`,
  button: `<div class="i-btn"><i></i><b>Visor</b> <span>58% Ethan</span></div>`
};
