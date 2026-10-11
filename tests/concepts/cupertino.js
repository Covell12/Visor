/* Apple A — "Cupertino": iOS grouped lists. Grey ground, white inset groups,
 * inset separators, right-aligned values, a system segmented control. */

'use strict';

const { DOC, growthPath } = require('./common');

const g = growthPath(300, 64);

module.exports = {
  name: 'cupertino',
  label: 'Cupertino — iOS grouped lists: grey ground, white inset groups, inset separators, system segmented control',
  css: `
  :root {
    --ios-bg: #F2F2F7;
    --ios-card: #FFFFFF;
    --ios-sep: #E5E5EA;
    --ios-label: #000000;
    --ios-2: #3C3C43;
    --ios-3: rgba(60,60,67,0.6);
    --ios-4: rgba(60,60,67,0.3);
    --green: #248A62;
    --green-fill: #34C77B;
    --orange: #C77B27;
    --red: #C0392F;
    --sf: -apple-system, 'SF Pro Text', 'SF Pro Display', ui-sans-serif, 'Segoe UI', sans-serif;
    --sfr: ui-rounded, 'SF Pro Rounded', -apple-system, sans-serif;
  }
  .panel { background: var(--ios-bg); color: var(--ios-label); font-family: var(--sf); -webkit-font-smoothing: antialiased; }

  .cu-nav { padding: 14px 16px 8px; }
  .cu-nav-small { font-size: 12px; color: var(--ios-3); }
  .cu-nav-title { font-size: 26px; font-weight: 700; letter-spacing: -0.6px; margin-top: 1px; }

  .cu-seg { margin: 8px 16px 16px; padding: 2px; background: rgba(120,120,128,0.12); border-radius: 9px; display: flex; gap: 2px; }
  .cu-seg span { flex: 1; text-align: center; padding: 6px 0; font-size: 12px; font-weight: 550; color: var(--ios-label); border-radius: 7px; }
  .cu-seg span.on { background: #fff; box-shadow: 0 3px 8px rgba(0,0,0,0.12), 0 1px 1px rgba(0,0,0,0.04); }

  .cu-group-label { padding: 0 32px 6px; font-size: 11.5px; letter-spacing: 0.3px; text-transform: uppercase; color: var(--ios-3); }
  .cu-group { margin: 0 16px 20px; background: var(--ios-card); border-radius: 12px; overflow: hidden; }
  .cu-group-foot { margin: -14px 32px 20px; font-size: 11.5px; line-height: 1.4; color: var(--ios-3); }

  .cu-row { display: flex; align-items: center; gap: 12px; padding: 11px 16px; position: relative; }
  .cu-row + .cu-row::before { content: ''; position: absolute; left: 16px; right: 0; top: 0; height: 1px; background: var(--ios-sep); }
  .cu-row-icon { width: 28px; height: 28px; border-radius: 7px; display: grid; place-items: center; color: #fff; font-size: 13px; background: var(--c, var(--green)); }
  .cu-row-title { font-size: 14px; }
  .cu-row-value { margin-left: auto; font-size: 14px; color: var(--ios-3); font-variant-numeric: tabular-nums; }
  .cu-row-chev { color: var(--ios-4); font-size: 13px; margin-left: 6px; }

  .cu-hero { padding: 16px 16px 14px; }
  .cu-hero-key { font-size: 12px; font-weight: 600; color: var(--green); letter-spacing: 0.2px; }
  .cu-hero-fig { display: flex; align-items: baseline; gap: 6px; margin-top: 4px; }
  .cu-hero-num { font-family: var(--sfr); font-size: 40px; font-weight: 700; letter-spacing: -1.4px; line-height: 1; }
  .cu-hero-unit { font-size: 14px; font-weight: 600; color: var(--ios-3); }
  .cu-hero-sub { margin-top: 6px; font-size: 12.5px; color: var(--ios-3); }
  .cu-hero-chart svg { display: block; width: 100%; height: 64px; margin-top: 12px; }

  .cu-person { display: flex; align-items: center; gap: 12px; padding: 11px 16px; position: relative; }
  .cu-person + .cu-person::before { content: ''; position: absolute; left: 56px; right: 0; top: 0; height: 1px; background: var(--ios-sep); }
  .cu-face { width: 32px; height: 32px; border-radius: 50%; background: var(--c); color: #fff; display: grid; place-items: center; font-size: 12px; font-weight: 600; }
  .cu-pname { font-size: 14px; }
  .cu-pmeta { font-size: 11.5px; color: var(--ios-3); margin-top: 1px; }
  .cu-pshare { margin-left: auto; font-family: var(--sfr); font-size: 17px; font-weight: 650; color: var(--c); }

  /* ── Bar: an iOS toolbar, floating ───────────────────────────────────── */
  .cu-dock {
    display: inline-flex; align-items: center; gap: 14px; padding: 8px 8px 8px 16px;
    background: rgba(255,255,255,0.92); border-radius: 999px;
    box-shadow: 0 18px 40px -20px rgba(0,0,0,0.35), 0 0 0 0.5px rgba(0,0,0,0.06);
    font-family: var(--sf); color: var(--ios-label);
  }
  .cu-dock-title { font-size: 13px; font-weight: 600; }
  .cu-dock-item { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--ios-2); }
  .cu-dock-item i { width: 9px; height: 9px; border-radius: 50%; background: var(--c); }
  .cu-dock-item b { font-family: var(--sfr); font-weight: 650; }
  .cu-dock-sep { width: 0.5px; height: 20px; background: var(--ios-4); }
  .cu-dock-tab { font-size: 13px; color: var(--green); font-weight: 550; }
  .cu-dock-play { width: 30px; height: 30px; border-radius: 50%; background: var(--green-fill); color: #fff; display: grid; place-items: center; font-size: 11px; }

  /* ── Button: a circular iOS control ──────────────────────────────────── */
  .cu-btn { display: inline-flex; align-items: center; gap: 8px; padding: 5px 6px 5px 13px; background: rgba(255,255,255,0.94); border-radius: 999px; box-shadow: 0 14px 30px -18px rgba(0,0,0,0.4), 0 0 0 0.5px rgba(0,0,0,0.06); }
  .cu-btn b { font-size: 13px; font-weight: 600; }
  .cu-btn-play { width: 28px; height: 28px; border-radius: 50%; background: var(--green-fill); color: #fff; display: grid; place-items: center; font-size: 10px; }
  `,
  panel: `
  <div class="cu-nav">
    <div class="cu-nav-small">${DOC.title}</div>
    <div class="cu-nav-title">Visor</div>
  </div>
  <div class="cu-seg"><span class="on">Overview</span><span>People</span><span>Time</span><span>Evidence</span></div>

  <div class="cu-group">
    <div class="cu-hero">
      <div class="cu-hero-key">WORDS NOW</div>
      <div class="cu-hero-fig"><span class="cu-hero-num">${DOC.words}</span><span class="cu-hero-unit">words</span></div>
      <div class="cu-hero-sub">${DOC.people.length} people · ${DOC.span} · ${DOC.externalPct}% from outside</div>
      <div class="cu-hero-chart">
        <svg viewBox="0 0 300 64" preserveAspectRatio="none">
          <polygon points="${g.area}" fill="rgba(52,199,123,0.16)"/>
          <polyline points="${g.line}" fill="none" stroke="#34C77B" stroke-width="2" stroke-linejoin="round"/>
        </svg>
      </div>
    </div>
  </div>

  <div class="cu-group-label">The work</div>
  <div class="cu-group">
    <div class="cu-row"><span class="cu-row-icon">✎</span><span class="cu-row-title">Edit operations</span><span class="cu-row-value">${DOC.edits}</span><span class="cu-row-chev">›</span></div>
    <div class="cu-row"><span class="cu-row-icon" style="--c:#2F6FC4">◷</span><span class="cu-row-title">Active writing</span><span class="cu-row-value">${DOC.writing}</span><span class="cu-row-chev">›</span></div>
    <div class="cu-row"><span class="cu-row-icon" style="--c:var(--orange)">⧉</span><span class="cu-row-title">Pastes</span><span class="cu-row-value">${DOC.pastes} · ${DOC.externalPct}% external</span><span class="cu-row-chev">›</span></div>
    <div class="cu-row"><span class="cu-row-icon" style="--c:var(--red)">⌫</span><span class="cu-row-title">Characters deleted</span><span class="cu-row-value">${DOC.deleted}</span><span class="cu-row-chev">›</span></div>
  </div>
  <div class="cu-group-foot">Every figure is read from this document's own revision log. Nothing leaves your browser.</div>

  <div class="cu-group-label">Contributors</div>
  <div class="cu-group">
    ${DOC.people.map((p) => `
      <div class="cu-person" style="--c:${p.colour}">
        <span class="cu-face">${p.initials}</span>
        <div><div class="cu-pname">${p.name}</div><div class="cu-pmeta">${p.chars} chars · ${p.mins} · ${p.typed}% typed</div></div>
        <span class="cu-pshare">${p.share}%</span>
      </div>`).join('')}
  </div>

  <div class="cu-group-label">Document tab</div>
  <div class="cu-group">
    <div class="cu-row"><span class="cu-row-title">Showing</span><span class="cu-row-value">Current tab · Draft</span><span class="cu-row-chev">›</span></div>
  </div>`,
  dock: `
  <div class="cu-dock">
    <span class="cu-dock-title">Visor</span>
    ${DOC.people.map((p) => `<span class="cu-dock-item" style="--c:${p.colour}"><i></i><b>${p.share}%</b> ${p.first}</span>`).join('')}
    <span class="cu-dock-sep"></span>
    <span class="cu-dock-item"><b>${DOC.words}</b> words</span>
    <span class="cu-dock-tab">Current tab ⌄</span>
    <span class="cu-dock-play">▶</span>
  </div>`,
  button: `<div class="cu-btn"><b>Visor</b><span class="cu-btn-play">▶</span></div>`
};
