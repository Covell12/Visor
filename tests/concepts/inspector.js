/* Apple C — "Inspector": a macOS pro-app sidebar. Compact, precise, hairlines,
 * SF at 12–13px, a real segmented control, values right-aligned on a grid. */

'use strict';

const { DOC, growthPath } = require('./common');

const g = growthPath(300, 52);

module.exports = {
  name: 'inspector',
  label: 'Inspector — a macOS pro-app sidebar: compact, hairlines, everything on one grid',
  css: `
  :root {
    --bg: #ECECEE;
    --sheet: #FFFFFF;
    --hair: #D9D9DE;
    --hair-2: #E9E9ED;
    --label: #1D1D1F;
    --label-2: #494950;
    --label-3: #86868B;
    --green: #1E7A56;
    --green-fill: #2CA36F;
    --sel: #E6F1EC;
    --red: #B23A2F;
    --sf: -apple-system, 'SF Pro Text', ui-sans-serif, 'Segoe UI', sans-serif;
    --mono: ui-monospace, 'SF Mono', Menlo, monospace;
  }
  .panel { background: var(--bg); color: var(--label); font-family: var(--sf); font-size: 12px; -webkit-font-smoothing: antialiased; }

  .in-titlebar { display: flex; align-items: center; gap: 8px; height: 38px; padding: 0 10px; background: #F6F6F8; border-bottom: 1px solid var(--hair); }
  .in-mark { width: 18px; height: 18px; border-radius: 5px; background: var(--green-fill); color: #fff; display: grid; place-items: center; font-size: 10px; font-weight: 700; }
  .in-doc { font-size: 12px; font-weight: 600; }
  .in-right { margin-left: auto; display: flex; gap: 6px; color: var(--label-3); }
  .in-icon { width: 22px; height: 22px; border-radius: 5px; display: grid; place-items: center; font-size: 11px; }
  .in-icon.on { background: rgba(0,0,0,0.06); color: var(--label); }

  .in-seg { display: flex; margin: 9px 10px; border: 1px solid var(--hair); border-radius: 6px; overflow: hidden; background: var(--sheet); }
  .in-seg span { flex: 1; text-align: center; padding: 5px 0; font-size: 11.5px; color: var(--label-2); border-right: 1px solid var(--hair); }
  .in-seg span:last-child { border-right: none; }
  .in-seg span.on { background: var(--sel); color: var(--green); font-weight: 600; }

  .in-scope { display: flex; align-items: center; gap: 7px; margin: 0 10px 10px; padding: 5px 8px; background: var(--sheet); border: 1px solid var(--hair); border-radius: 6px; font-size: 11.5px; }
  .in-scope b { font-weight: 600; }
  .in-scope span { margin-left: auto; color: var(--label-3); }

  .in-sec { display: flex; align-items: center; gap: 7px; padding: 12px 12px 5px; font-size: 10px; font-weight: 680; letter-spacing: 0.5px; text-transform: uppercase; color: var(--label-3); }
  .in-sec::after { content: ''; flex: 1; height: 1px; background: var(--hair); }

  .in-block { margin: 0 10px; background: var(--sheet); border: 1px solid var(--hair); border-radius: 7px; }

  .in-hero { padding: 11px 12px 10px; }
  .in-hero-fig { display: flex; align-items: baseline; gap: 6px; }
  .in-hero-num { font-size: 27px; font-weight: 640; letter-spacing: -0.9px; font-variant-numeric: tabular-nums; }
  .in-hero-unit { font-size: 11.5px; color: var(--label-3); }
  .in-hero-sub { margin-top: 3px; font-size: 11px; color: var(--label-3); }
  .in-hero-chart svg { display: block; width: 100%; height: 52px; margin-top: 8px; }

  .in-row { display: flex; align-items: center; gap: 10px; padding: 6px 12px; border-top: 1px solid var(--hair-2); }
  .in-row:first-child { border-top: none; }
  .in-key { font-size: 11.5px; color: var(--label-2); }
  .in-val { margin-left: auto; font-family: var(--mono); font-size: 11.5px; font-variant-numeric: tabular-nums; }
  .in-val.red { color: var(--red); }
  .in-val small { font-family: var(--sf); color: var(--label-3); margin-left: 6px; }

  .in-person { display: grid; grid-template-columns: 18px 1fr auto; gap: 9px; align-items: center; padding: 7px 12px; border-top: 1px solid var(--hair-2); }
  .in-person:first-child { border-top: none; }
  .in-swatch { width: 11px; height: 11px; border-radius: 3px; background: var(--c); box-shadow: inset 0 0 0 1px rgba(0,0,0,0.12); }
  .in-pname { font-size: 12px; }
  .in-pmeta { font-family: var(--mono); font-size: 10px; color: var(--label-3); margin-top: 1px; }
  .in-pshare { font-family: var(--mono); font-size: 12px; }
  .in-pbar { grid-column: 2 / -1; height: 4px; border-radius: 2px; background: var(--hair-2); margin-top: 5px; overflow: hidden; }
  .in-pbar i { display: block; height: 100%; background: var(--c); }

  .in-foot { padding: 9px 12px 14px; font-size: 10.5px; color: var(--label-3); }

  /* ── Bar: a macOS toolbar strip ──────────────────────────────────────── */
  .in-dock {
    display: inline-flex; align-items: center; gap: 12px; padding: 6px 6px 6px 12px;
    background: rgba(246,246,248,0.96); border: 1px solid var(--hair); border-radius: 9px;
    box-shadow: 0 16px 32px -20px rgba(0,0,0,0.45);
    font-family: var(--sf); font-size: 11.5px; color: var(--label);
  }
  .in-dock b { font-weight: 600; }
  .in-dock-item { display: inline-flex; align-items: center; gap: 5px; font-family: var(--mono); font-size: 11px; }
  .in-dock-item i { width: 9px; height: 9px; border-radius: 3px; background: var(--c); }
  .in-dock-sep { width: 1px; height: 18px; background: var(--hair); }
  .in-dock-pop { display: inline-flex; align-items: center; gap: 6px; padding: 3px 7px; border: 1px solid var(--hair); border-radius: 6px; background: #fff; }
  .in-dock-play { width: 24px; height: 24px; border-radius: 6px; background: var(--green-fill); color: #fff; display: grid; place-items: center; font-size: 9px; }

  /* ── Button: a toolbar item ──────────────────────────────────────────── */
  .in-btn { display: inline-flex; align-items: center; gap: 7px; padding: 5px 9px 5px 6px; background: rgba(246,246,248,0.96); border: 1px solid var(--hair); border-radius: 7px; box-shadow: 0 12px 24px -18px rgba(0,0,0,0.5); font-size: 11.5px; }
  .in-btn-mark { width: 18px; height: 18px; border-radius: 5px; background: var(--green-fill); color: #fff; display: grid; place-items: center; font-size: 10px; font-weight: 700; }
  .in-btn-play { width: 20px; height: 20px; border-radius: 5px; border: 1px solid var(--hair); display: grid; place-items: center; font-size: 8px; color: var(--green); }
  `,
  panel: `
  <div class="in-titlebar">
    <span class="in-mark">V</span>
    <span class="in-doc">${DOC.title}</span>
    <span class="in-right"><span class="in-icon on">◐</span><span class="in-icon">⟳</span></span>
  </div>

  <div class="in-seg"><span class="on">Overview</span><span>People</span><span>Time</span><span>Evidence</span><span>Signal</span></div>
  <div class="in-scope">Tab: <b>Current · Draft</b><span>⌄</span></div>

  <div class="in-sec">Document</div>
  <div class="in-block">
    <div class="in-hero">
      <div class="in-hero-fig"><span class="in-hero-num">${DOC.words}</span><span class="in-hero-unit">words now</span></div>
      <div class="in-hero-sub">${DOC.people.length} contributors · ${DOC.span} · ${DOC.externalPct}% external</div>
      <div class="in-hero-chart">
        <svg viewBox="0 0 300 52" preserveAspectRatio="none">
          <polygon points="${g.area}" fill="rgba(44,163,111,0.14)"/>
          <polyline points="${g.line}" fill="none" stroke="#2CA36F" stroke-width="1.4"/>
        </svg>
      </div>
    </div>
  </div>

  <div class="in-sec">Measured</div>
  <div class="in-block">
    <div class="in-row"><span class="in-key">Edit operations</span><span class="in-val">${DOC.edits}</span></div>
    <div class="in-row"><span class="in-key">Active writing</span><span class="in-val">${DOC.writing}</span></div>
    <div class="in-row"><span class="in-key">Pastes</span><span class="in-val">${DOC.pastes}<small>${DOC.externalPct}% ext</small></span></div>
    <div class="in-row"><span class="in-key">Characters deleted</span><span class="in-val red">${DOC.deleted}</span></div>
    <div class="in-row"><span class="in-key">Span</span><span class="in-val">${DOC.span}</span></div>
  </div>

  <div class="in-sec">Contributors</div>
  <div class="in-block">
    ${DOC.people.map((p) => `
      <div class="in-person" style="--c:${p.colour}">
        <span class="in-swatch"></span>
        <div><div class="in-pname">${p.name}</div><div class="in-pmeta">${p.chars} chars · ${p.mins} · ${p.typed}% typed</div></div>
        <span class="in-pshare">${p.share}%</span>
        <span class="in-pbar"><i style="width:${p.share}%"></i></span>
      </div>`).join('')}
  </div>
  <div class="in-foot">Read from the document's revision log · refreshed 8s ago</div>`,
  dock: `
  <div class="in-dock">
    <b>Visor</b>
    ${DOC.people.map((p) => `<span class="in-dock-item" style="--c:${p.colour}"><i></i>${p.share}% ${p.first}</span>`).join('')}
    <span class="in-dock-sep"></span>
    <span class="in-dock-item">${DOC.words} words</span>
    <span class="in-dock-pop">Current tab ⌄</span>
    <span class="in-dock-play">▶</span>
  </div>`,
  button: `<div class="in-btn"><span class="in-btn-mark">V</span>Visor<span class="in-btn-play">▶</span></div>`
};
