/* Apple B — "Vision": visionOS glass. Dark translucent plates, thin bright
 * rims, specular top edge, everything floating over a soft field. */

'use strict';

const { DOC, growthPath } = require('./common');

const g = growthPath(300, 66);

module.exports = {
  name: 'vision',
  label: 'Vision — visionOS glass: translucent plates, bright rims, floating controls',
  css: `
  :root {
    --glass: rgba(28, 34, 38, 0.52);
    --glass-2: rgba(255, 255, 255, 0.10);
    --rim: rgba(255, 255, 255, 0.22);
    --rim-soft: rgba(255, 255, 255, 0.10);
    --on: #FFFFFF;
    --on-2: rgba(255, 255, 255, 0.66);
    --on-3: rgba(255, 255, 255, 0.42);
    --green: #6BE3AE;
    --sf: -apple-system, 'SF Pro Text', 'SF Pro Display', ui-sans-serif, sans-serif;
    --sfr: ui-rounded, 'SF Pro Rounded', -apple-system, sans-serif;
  }
  /* The field the glass floats over. */
  .panel {
    position: relative; color: var(--on); font-family: var(--sf); -webkit-font-smoothing: antialiased;
    background: #16202A;
  }
  .panel::before {
    content: ''; position: absolute; inset: 0;
    background:
      radial-gradient(60% 40% at 18% 8%, rgba(60,190,140,0.55), transparent 70%),
      radial-gradient(50% 36% at 88% 26%, rgba(70,130,220,0.45), transparent 72%),
      radial-gradient(70% 50% at 50% 100%, rgba(20,60,50,0.9), transparent 70%);
  }
  .vs-in { position: relative; padding: 14px 13px 18px; display: flex; flex-direction: column; gap: 12px; }

  .vs-plate {
    position: relative; border-radius: 22px; padding: 16px;
    background: var(--glass);
    box-shadow:
      inset 0 1px 0 var(--rim),
      inset 0 0 0 1px var(--rim-soft),
      0 22px 50px -26px rgba(0,0,0,0.9);
    -webkit-backdrop-filter: blur(26px) saturate(150%);
    backdrop-filter: blur(26px) saturate(150%);
  }

  .vs-head { display: flex; align-items: center; gap: 10px; padding: 2px 4px 0; }
  .vs-mark { width: 30px; height: 30px; border-radius: 10px; background: var(--glass-2); box-shadow: inset 0 1px 0 var(--rim); display: grid; place-items: center; font-family: var(--sfr); font-weight: 700; font-size: 13px; }
  .vs-title { font-size: 13px; font-weight: 600; }
  .vs-sub { font-size: 11px; color: var(--on-3); }

  .vs-seg { display: flex; gap: 3px; padding: 3px; border-radius: 999px; background: rgba(255,255,255,0.08); box-shadow: inset 0 0 0 1px var(--rim-soft); }
  .vs-seg span { flex: 1; text-align: center; padding: 7px 0; font-size: 11.5px; font-weight: 550; color: var(--on-2); border-radius: 999px; }
  .vs-seg span.on { background: rgba(255,255,255,0.20); color: var(--on); box-shadow: inset 0 1px 0 rgba(255,255,255,0.35); }

  .vs-hero-num { font-family: var(--sfr); font-size: 42px; font-weight: 600; letter-spacing: -1.6px; line-height: 1; }
  .vs-hero-unit { font-size: 13px; color: var(--on-3); margin-left: 7px; }
  .vs-hero-sub { margin-top: 7px; font-size: 11.5px; color: var(--on-2); }
  .vs-hero-chart svg { display: block; width: 100%; height: 66px; margin-top: 10px; }

  .vs-chips { display: flex; gap: 7px; margin-top: 13px; }
  .vs-chip { display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px 5px 8px; border-radius: 999px; background: rgba(255,255,255,0.10); box-shadow: inset 0 0 0 1px var(--rim-soft); font-size: 11px; }
  .vs-chip i { width: 8px; height: 8px; border-radius: 50%; background: var(--c); box-shadow: 0 0 8px var(--c); }
  .vs-chip b { font-family: var(--sfr); font-weight: 650; }

  .vs-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .vs-cell { padding: 13px 14px; }
  .vs-cell-num { font-family: var(--sfr); font-size: 22px; font-weight: 620; letter-spacing: -0.4px; }
  .vs-cell-key { margin-top: 2px; font-size: 11px; color: var(--on-3); }

  .vs-people { padding: 4px 0 2px; }
  .vs-person { display: flex; align-items: center; gap: 11px; padding: 10px 14px; }
  .vs-person + .vs-person { box-shadow: inset 0 1px 0 var(--rim-soft); }
  .vs-face { width: 30px; height: 30px; border-radius: 50%; background: var(--c); display: grid; place-items: center; font-size: 11px; font-weight: 650; color: #08110D; box-shadow: 0 0 14px -2px var(--c); }
  .vs-pname { font-size: 12.5px; }
  .vs-pmeta { font-size: 10.5px; color: var(--on-3); margin-top: 1px; }
  .vs-pshare { margin-left: auto; font-family: var(--sfr); font-size: 17px; font-weight: 620; }

  /* ── Bar: a floating glass capsule ───────────────────────────────────── */
  .vs-dock {
    display: inline-flex; align-items: center; gap: 13px; padding: 9px 9px 9px 16px;
    border-radius: 999px; color: var(--on); font-family: var(--sf);
    background: rgba(24, 30, 34, 0.58);
    box-shadow: inset 0 1px 0 var(--rim), inset 0 0 0 1px var(--rim-soft), 0 26px 50px -24px rgba(0,0,0,0.85);
    -webkit-backdrop-filter: blur(24px) saturate(150%); backdrop-filter: blur(24px) saturate(150%);
  }
  .vs-dock-title { font-size: 12.5px; font-weight: 600; }
  .vs-dock-item { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--on-2); }
  .vs-dock-item i { width: 8px; height: 8px; border-radius: 50%; background: var(--c); box-shadow: 0 0 8px var(--c); }
  .vs-dock-item b { font-family: var(--sfr); font-weight: 650; color: var(--on); }
  .vs-dock-play { width: 30px; height: 30px; border-radius: 50%; background: rgba(255,255,255,0.18); box-shadow: inset 0 1px 0 rgba(255,255,255,0.4); display: grid; place-items: center; font-size: 10px; }

  /* ── Button: a glass bead ────────────────────────────────────────────── */
  .vs-btn {
    display: inline-flex; align-items: center; gap: 9px; padding: 7px 8px 7px 14px; border-radius: 999px;
    background: rgba(24, 30, 34, 0.58); color: var(--on);
    box-shadow: inset 0 1px 0 var(--rim), inset 0 0 0 1px var(--rim-soft), 0 18px 34px -20px rgba(0,0,0,0.9);
    -webkit-backdrop-filter: blur(20px) saturate(150%); backdrop-filter: blur(20px) saturate(150%);
  }
  .vs-btn b { font-size: 12.5px; font-weight: 600; }
  .vs-btn-play { width: 26px; height: 26px; border-radius: 50%; background: rgba(255,255,255,0.18); box-shadow: inset 0 1px 0 rgba(255,255,255,0.4); display: grid; place-items: center; font-size: 9px; }
  `,
  panel: `
  <div class="vs-in">
    <div class="vs-head">
      <span class="vs-mark">V</span>
      <div><div class="vs-title">Visor</div><div class="vs-sub">${DOC.title}</div></div>
    </div>

    <div class="vs-seg"><span class="on">Overview</span><span>People</span><span>Time</span><span>Evidence</span></div>

    <div class="vs-plate">
      <div><span class="vs-hero-num">${DOC.words}</span><span class="vs-hero-unit">words</span></div>
      <div class="vs-hero-sub">${DOC.people.length} people · ${DOC.span} · ${DOC.externalPct}% from outside</div>
      <div class="vs-hero-chart">
        <svg viewBox="0 0 300 66" preserveAspectRatio="none">
          <polygon points="${g.area}" fill="rgba(107,227,174,0.18)"/>
          <polyline points="${g.line}" fill="none" stroke="#6BE3AE" stroke-width="2" stroke-linejoin="round"/>
        </svg>
      </div>
      <div class="vs-chips">
        ${DOC.people.map((p) => `<span class="vs-chip" style="--c:${p.colour}"><i></i>${p.first} <b>${p.share}%</b></span>`).join('')}
      </div>
    </div>

    <div class="vs-grid">
      <div class="vs-plate vs-cell"><div class="vs-cell-num">${DOC.edits}</div><div class="vs-cell-key">edits</div></div>
      <div class="vs-plate vs-cell"><div class="vs-cell-num">${DOC.writing}</div><div class="vs-cell-key">writing</div></div>
      <div class="vs-plate vs-cell"><div class="vs-cell-num">${DOC.pastes}</div><div class="vs-cell-key">pastes</div></div>
      <div class="vs-plate vs-cell"><div class="vs-cell-num">${DOC.deleted}</div><div class="vs-cell-key">deleted</div></div>
    </div>

    <div class="vs-plate vs-people" style="padding:6px 0">
      ${DOC.people.map((p) => `
        <div class="vs-person" style="--c:${p.colour}">
          <span class="vs-face">${p.initials}</span>
          <div><div class="vs-pname">${p.name}</div><div class="vs-pmeta">${p.chars} chars · ${p.mins}</div></div>
          <span class="vs-pshare">${p.share}%</span>
        </div>`).join('')}
    </div>
  </div>`,
  dock: `
  <div class="vs-dock">
    <span class="vs-dock-title">Visor</span>
    ${DOC.people.map((p) => `<span class="vs-dock-item" style="--c:${p.colour}"><i></i><b>${p.share}%</b> ${p.first}</span>`).join('')}
    <span class="vs-dock-item"><b>${DOC.words}</b> words</span>
    <span class="vs-dock-play">▶</span>
  </div>`,
  button: `<div class="vs-btn"><b>Visor</b><span class="vs-btn-play">▶</span></div>`
};
