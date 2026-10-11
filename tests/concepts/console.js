/* Concept 2 — "Console": dark, dense, monospaced figures, everything on a grid. */

'use strict';

const { DOC, growthPath } = require('./common');

const g = growthPath(300, 56);
const maxHour = Math.max(...DOC.hours);

module.exports = {
  name: 'console',
  label: 'Console — dark, dense, monospaced, built for reading numbers fast',
  css: `
  :root {
    --bg: #0B0F16;
    --sheet: #111721;
    --sheet-2: #161E2A;
    --line: #202A3A;
    --ink: #E6EDF7;
    --ink-2: #93A3BA;
    --ink-3: #61728B;
    --accent: #4FA9FF;
    --good: #39C08A;
    --warm: #E3A44B;
    --hot: #F2678E;
    --mono: ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, monospace;
  }
  .panel { background: var(--bg); color: var(--ink); font-family: ui-sans-serif, -apple-system, 'Segoe UI', sans-serif; }

  .c-head { display: flex; align-items: center; gap: 9px; padding: 11px 13px; border-bottom: 1px solid var(--line); background: var(--sheet); }
  .c-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--good); box-shadow: 0 0 0 3px rgba(57,192,138,0.15); }
  .c-head-title { font-size: 12px; font-weight: 620; }
  .c-head-sub { font-family: var(--mono); font-size: 10px; color: var(--ink-3); }
  .c-head-right { margin-left: auto; font-family: var(--mono); font-size: 10px; color: var(--ink-3); }

  .c-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--line); background: var(--sheet); }
  .c-tab { flex: 1; text-align: center; padding: 8px 0; font-family: var(--mono); font-size: 10px; letter-spacing: 0.6px; text-transform: uppercase; color: var(--ink-3); border-right: 1px solid var(--line); }
  .c-tab:last-child { border-right: none; }
  .c-tab.on { color: var(--accent); background: var(--sheet-2); box-shadow: inset 0 -2px 0 var(--accent); }

  .c-scope { display: flex; align-items: center; gap: 8px; padding: 8px 13px; border-bottom: 1px solid var(--line); font-family: var(--mono); font-size: 10.5px; color: var(--ink-2); }
  .c-scope b { color: var(--ink); font-weight: 600; }
  .c-scope .c-caret { margin-left: auto; color: var(--ink-3); }

  .c-grid { display: grid; grid-template-columns: 1fr 1fr; border-bottom: 1px solid var(--line); }
  .c-cell { padding: 12px 13px; border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); }
  .c-cell:nth-child(2n) { border-right: none; }
  .c-cell.wide { grid-column: 1 / -1; border-right: none; }
  .c-key { font-family: var(--mono); font-size: 9.5px; letter-spacing: 1px; text-transform: uppercase; color: var(--ink-3); }
  .c-num { margin-top: 5px; font-family: var(--mono); font-size: 20px; letter-spacing: -0.5px; }
  .c-num.big { font-size: 30px; }
  .c-num.good { color: var(--good); } .c-num.warm { color: var(--warm); } .c-num.hot { color: var(--hot); }
  .c-note { margin-top: 4px; font-family: var(--mono); font-size: 10px; color: var(--ink-3); }

  .c-sparkline svg { display: block; width: 100%; height: 56px; margin-top: 8px; }

  .c-hours { display: flex; align-items: flex-end; gap: 2px; height: 34px; margin-top: 9px; }
  .c-hours i { flex: 1; background: var(--accent); opacity: 0.85; border-radius: 1px; }

  .c-people { padding: 4px 0 0; }
  .c-prow { display: grid; grid-template-columns: 14px 1fr auto; gap: 9px; align-items: center; padding: 9px 13px; border-bottom: 1px solid var(--line); }
  .c-swatch { width: 10px; height: 10px; border-radius: 2px; background: var(--c); }
  .c-pname { font-size: 11.5px; }
  .c-pmeta { font-family: var(--mono); font-size: 9.5px; color: var(--ink-3); margin-top: 2px; }
  .c-pshare { font-family: var(--mono); font-size: 13px; color: var(--c); }
  .c-pbar { grid-column: 2 / -1; height: 3px; background: var(--sheet-2); margin-top: 6px; }
  .c-pbar i { display: block; height: 100%; background: var(--c); }

  /* ── The bar in the document ─────────────────────────────────────────── */
  .c-dock {
    display: inline-flex; align-items: center; gap: 0; background: var(--sheet);
    border: 1px solid var(--line); border-radius: 8px; overflow: hidden;
    font-family: ui-sans-serif, -apple-system, sans-serif; color: var(--ink);
    box-shadow: 0 18px 40px -22px #000;
  }
  .c-dock-cell { display: flex; align-items: center; gap: 7px; padding: 9px 13px; border-right: 1px solid var(--line); }
  .c-dock-cell:last-child { border-right: none; }
  .c-dock-key { font-family: var(--mono); font-size: 9px; letter-spacing: 1px; text-transform: uppercase; color: var(--ink-3); }
  .c-dock-val { font-family: var(--mono); font-size: 12px; }
  .c-dock-swatch { width: 8px; height: 8px; border-radius: 2px; background: var(--c); }
  .c-dock-play { width: 26px; height: 26px; border-radius: 6px; background: var(--accent); color: #05203B; display: grid; place-items: center; font-size: 10px; }

  /* ── The collapsed button ────────────────────────────────────────────── */
  .c-btn { display: inline-flex; align-items: center; gap: 9px; padding: 7px 12px; background: var(--sheet); border: 1px solid var(--line); border-radius: 8px; color: var(--ink); font-family: var(--mono); font-size: 11px; box-shadow: 0 12px 26px -18px #000; }
  .c-btn .c-dot { width: 6px; height: 6px; }
  .c-btn b { color: var(--accent); font-weight: 500; }
  `,
  panel: `
  <div class="c-head">
    <span class="c-dot"></span>
    <div>
      <div class="c-head-title">${DOC.title}</div>
      <div class="c-head-sub">visor · live</div>
    </div>
    <div class="c-head-right">8s</div>
  </div>
  <div class="c-tabs">
    <div class="c-tab on">over</div><div class="c-tab">people</div><div class="c-tab">time</div><div class="c-tab">evid</div><div class="c-tab">signal</div>
  </div>
  <div class="c-scope">tab: <b>current · Draft</b><span class="c-caret">▾</span></div>

  <div class="c-grid">
    <div class="c-cell wide">
      <div class="c-key">words now</div>
      <div class="c-num big">${DOC.words}</div>
      <div class="c-note">${DOC.people.length} authors · ${DOC.span} · ${DOC.externalPct}% external</div>
      <div class="c-sparkline">
        <svg viewBox="0 0 300 56" preserveAspectRatio="none">
          <polygon points="${g.area}" fill="rgba(79,169,255,0.14)"/>
          <polyline points="${g.line}" fill="none" stroke="#4FA9FF" stroke-width="1.4"/>
        </svg>
      </div>
    </div>
    <div class="c-cell"><div class="c-key">edits</div><div class="c-num">${DOC.edits}</div></div>
    <div class="c-cell"><div class="c-key">writing</div><div class="c-num good">${DOC.writing}</div></div>
    <div class="c-cell"><div class="c-key">pastes</div><div class="c-num warm">${DOC.pastes}</div></div>
    <div class="c-cell"><div class="c-key">deleted</div><div class="c-num hot">${DOC.deleted}</div></div>
    <div class="c-cell wide">
      <div class="c-key">activity by hour</div>
      <div class="c-hours">${DOC.hours.map((h) => `<i style="height:${Math.max(4, (h / maxHour) * 100)}%;opacity:${h ? 0.35 + (h / maxHour) * 0.65 : 0.12}"></i>`).join('')}</div>
    </div>
  </div>

  <div class="c-people">
    ${DOC.people.map((p) => `
      <div class="c-prow" style="--c:${p.colour}">
        <span class="c-swatch"></span>
        <div><div class="c-pname">${p.name}</div><div class="c-pmeta">${p.chars} chars · ${p.mins} · ${p.typed}% typed</div></div>
        <div class="c-pshare">${p.share}%</div>
        <span class="c-pbar"><i style="width:${p.share}%"></i></span>
      </div>`).join('')}
  </div>`,
  dock: `
  <div class="c-dock">
    <div class="c-dock-cell"><span class="c-dock-key">visor</span></div>
    ${DOC.people.map((p) => `
      <div class="c-dock-cell" style="--c:${p.colour}">
        <span class="c-dock-swatch"></span><span class="c-dock-val">${p.share}%</span>
        <span class="c-dock-key">${p.first}</span>
      </div>`).join('')}
    <div class="c-dock-cell"><span class="c-dock-key">ext</span><span class="c-dock-val">${DOC.externalPct}%</span></div>
    <div class="c-dock-cell"><span class="c-dock-key">current tab ▾</span></div>
    <div class="c-dock-cell"><span class="c-dock-play">▶</span></div>
  </div>`,
  button: `<div class="c-btn"><span class="c-dot"></span>visor <b>58%</b></div>`
};
