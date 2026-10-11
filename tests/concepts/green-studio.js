/* Blend B — "Green studio": the same green and serif headline, but Studio's
 * card-and-colour layout throughout, and lighter on the editorial rules. */

'use strict';

const { DOC, growthPath } = require('./common');

const g = growthPath(300, 76);
const maxHour = Math.max(...DOC.hours);

module.exports = {
  name: 'green-studio',
  label: 'Green studio — the same green and serif headline, carried on Studio cards and colour',
  css: `
  :root {
    --bg: #F1F4F0;
    --card: #FFFFFF;
    --ink: #16211D;
    --ink-2: #4F5C57;
    --ink-3: #8B9691;
    --line: #E2E8E3;
    --green: #17795A;
    --green-deep: #0F5E45;
    --green-soft: #E4F2EB;
    --mint: #35C08C;
    --warm: #C9832B;
    --hot: #C0504A;
    --serif: 'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif;
  }
  .panel { background: var(--bg); color: var(--ink); font-family: ui-rounded, 'SF Pro Rounded', ui-sans-serif, -apple-system, sans-serif; }

  .gs-head { display: flex; align-items: center; gap: 10px; padding: 14px 14px 10px; }
  .gs-mark { width: 30px; height: 30px; border-radius: 11px; background: var(--green); color: #fff; display: grid; place-items: center; font-family: var(--serif); font-size: 16px; }
  .gs-title { font-size: 13px; font-weight: 700; letter-spacing: -0.2px; }
  .gs-sub { font-size: 10.5px; color: var(--ink-3); }

  .gs-seg { display: flex; gap: 3px; margin: 2px 12px 10px; padding: 3px; background: #E3E9E4; border-radius: 12px; }
  .gs-seg span { flex: 1; text-align: center; padding: 6px 0; font-size: 10.5px; font-weight: 650; color: var(--ink-2); border-radius: 10px; }
  .gs-seg span.on { background: var(--card); color: var(--green-deep); box-shadow: 0 2px 5px -2px rgba(22,33,29,0.3); }

  .gs-scope { display: flex; align-items: center; gap: 7px; margin: 0 12px 10px; padding: 7px 11px; border-radius: 999px; background: var(--green-soft); color: var(--green-deep); font-size: 11.5px; font-weight: 650; }
  .gs-scope span { margin-left: auto; }

  .gs-body { padding: 0 12px 14px; display: flex; flex-direction: column; gap: 10px; }

  .gs-hero { border-radius: 18px; background: var(--green-deep); color: #EFF7F2; padding: 16px 16px 14px; }
  .gs-hero-top { display: flex; align-items: flex-end; justify-content: space-between; gap: 10px; }
  .gs-hero-num { font-family: var(--serif); font-size: 44px; line-height: 0.92; letter-spacing: -1.4px; }
  .gs-hero-unit { font-family: var(--serif); font-size: 14px; color: #9EC6B4; margin-left: 6px; }
  .gs-hero-pill { padding: 5px 10px; border-radius: 999px; background: rgba(255,255,255,0.12); font-size: 10.5px; font-weight: 700; }
  .gs-hero-sub { margin-top: 7px; font-size: 11px; color: #9EC6B4; }
  .gs-hero-chart svg { display: block; width: 100%; height: 76px; margin-top: 8px; }

  .gs-tiles { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
  .gs-tile { background: var(--card); border-radius: 15px; padding: 12px 13px; }
  .gs-tile-num { font-family: var(--serif); font-size: 22px; letter-spacing: -0.4px; }
  .gs-tile-key { margin-top: 2px; font-size: 10.5px; font-weight: 620; color: var(--ink-3); }
  .gs-tile.warm .gs-tile-num { color: var(--warm); }
  .gs-tile.hot .gs-tile-num { color: var(--hot); }

  .gs-card { background: var(--card); border-radius: 18px; overflow: hidden; }
  .gs-card-title { display: flex; align-items: center; gap: 8px; padding: 13px 15px 8px; font-size: 10.5px; font-weight: 700; letter-spacing: 1.2px; text-transform: uppercase; color: var(--ink-3); }
  .gs-prow { display: flex; align-items: center; gap: 11px; padding: 11px 15px; border-top: 1px solid var(--line); }
  .gs-face { width: 32px; height: 32px; border-radius: 50%; background: var(--c); color: #fff; display: grid; place-items: center; font-size: 11px; font-weight: 700; }
  .gs-pname { font-size: 12.5px; font-weight: 680; }
  .gs-pmeta { font-size: 10.5px; color: var(--ink-3); margin-top: 1px; }
  .gs-pshare { margin-left: auto; font-family: var(--serif); font-size: 20px; color: var(--c); }
  .gs-stack { display: flex; height: 10px; border-radius: 999px; overflow: hidden; margin: 12px 15px 14px; }
  .gs-stack i { display: block; height: 100%; background: var(--c); }

  .gs-hours { display: flex; align-items: flex-end; gap: 3px; height: 40px; padding: 4px 15px 14px; }
  .gs-hours i { flex: 1; border-radius: 3px 3px 0 0; background: var(--mint); }

  /* ── The bar in the document ─────────────────────────────────────────── */
  .gs-dock {
    display: inline-flex; align-items: center; gap: 11px; padding: 8px 9px 8px 13px;
    background: var(--card); border-radius: 999px;
    box-shadow: 0 22px 46px -26px rgba(16,40,31,0.65), 0 2px 6px -3px rgba(16,40,31,0.25);
    font-family: ui-rounded, 'SF Pro Rounded', ui-sans-serif, sans-serif; color: var(--ink);
  }
  .gs-dock-mark { width: 26px; height: 26px; border-radius: 9px; background: var(--green); color: #fff; display: grid; place-items: center; font-family: var(--serif); font-size: 13px; }
  .gs-dock-chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px 4px 7px; border-radius: 999px; background: color-mix(in srgb, var(--c) 13%, #fff); font-size: 11px; font-weight: 680; color: color-mix(in srgb, var(--c) 80%, #000); }
  .gs-dock-chip i { width: 7px; height: 7px; border-radius: 50%; background: var(--c); }
  .gs-dock-div { width: 1px; height: 18px; background: var(--line); }
  .gs-dock-fig { font-family: var(--serif); font-size: 14px; }
  .gs-dock-fig small { font-family: ui-rounded, sans-serif; font-size: 10px; color: var(--ink-3); margin-left: 5px; }
  .gs-dock-tab { font-size: 11px; font-weight: 640; color: var(--ink-2); }
  .gs-dock-play { width: 30px; height: 30px; border-radius: 50%; background: var(--green); color: #fff; display: grid; place-items: center; font-size: 10px; }

  /* ── The collapsed button ────────────────────────────────────────────── */
  .gs-btn { display: inline-flex; align-items: center; gap: 8px; padding: 6px 8px 6px 7px; background: var(--card); border-radius: 999px; box-shadow: 0 16px 32px -20px rgba(16,40,31,0.6); }
  .gs-btn-mark { width: 27px; height: 27px; border-radius: 9px; background: var(--green); color: #fff; display: grid; place-items: center; font-family: var(--serif); font-size: 13px; }
  .gs-btn-share { font-family: var(--serif); font-size: 14px; color: var(--green-deep); }
  .gs-btn-faces { display: flex; }
  .gs-btn-faces i { width: 18px; height: 18px; border-radius: 50%; background: var(--c); border: 2px solid var(--card); margin-left: -7px; }
  .gs-btn-faces i:first-child { margin-left: 0; }
  .gs-btn-play { width: 27px; height: 27px; border-radius: 50%; background: var(--green); color: #fff; display: grid; place-items: center; font-size: 9px; }
  `,
  panel: `
  <div class="gs-head">
    <div class="gs-mark">V</div>
    <div><div class="gs-title">${DOC.title}</div><div class="gs-sub">Visor · revision record</div></div>
  </div>
  <div class="gs-seg"><span class="on">Overview</span><span>People</span><span>Time</span><span>Evidence</span></div>
  <div class="gs-scope">Current tab · Draft<span>▾</span></div>

  <div class="gs-body">
    <div class="gs-hero">
      <div class="gs-hero-top">
        <div><span class="gs-hero-num">${DOC.words}</span><span class="gs-hero-unit">words</span></div>
        <span class="gs-hero-pill">${DOC.externalPct}% external</span>
      </div>
      <div class="gs-hero-sub">written by ${DOC.people.length} people over ${DOC.span}</div>
      <div class="gs-hero-chart">
        <svg viewBox="0 0 300 76" preserveAspectRatio="none">
          <polygon points="${g.area}" fill="rgba(53,192,140,0.18)"/>
          <polyline points="${g.line}" fill="none" stroke="#5FE0AC" stroke-width="2.2" stroke-linejoin="round"/>
        </svg>
      </div>
    </div>

    <div class="gs-tiles">
      <div class="gs-tile"><div class="gs-tile-num">${DOC.edits}</div><div class="gs-tile-key">edits</div></div>
      <div class="gs-tile"><div class="gs-tile-num">${DOC.writing}</div><div class="gs-tile-key">writing</div></div>
      <div class="gs-tile warm"><div class="gs-tile-num">${DOC.pastes}</div><div class="gs-tile-key">pastes</div></div>
      <div class="gs-tile hot"><div class="gs-tile-num">${DOC.deleted}</div><div class="gs-tile-key">deleted</div></div>
    </div>

    <div class="gs-card">
      <div class="gs-card-title">Who wrote it</div>
      ${DOC.people.map((p) => `
        <div class="gs-prow" style="--c:${p.colour}">
          <span class="gs-face">${p.initials}</span>
          <div><div class="gs-pname">${p.name}</div><div class="gs-pmeta">${p.chars} chars · ${p.mins}</div></div>
          <span class="gs-pshare">${p.share}%</span>
        </div>`).join('')}
      <div class="gs-stack">${DOC.people.map((p) => `<i style="--c:${p.colour};width:${p.share}%"></i>`).join('')}</div>
    </div>

    <div class="gs-card">
      <div class="gs-card-title">When it was written</div>
      <div class="gs-hours">${DOC.hours.map((h) => `<i style="height:${Math.max(6, (h / maxHour) * 100)}%;opacity:${h ? 0.4 + (h / maxHour) * 0.6 : 0.15}"></i>`).join('')}</div>
    </div>
  </div>`,
  dock: `
  <div class="gs-dock">
    <span class="gs-dock-mark">V</span>
    ${DOC.people.map((p) => `<span class="gs-dock-chip" style="--c:${p.colour}"><i></i>${p.first} ${p.share}%</span>`).join('')}
    <span class="gs-dock-div"></span>
    <span class="gs-dock-fig">${DOC.words}<small>words</small></span>
    <span class="gs-dock-div"></span>
    <span class="gs-dock-tab">Current tab ▾</span>
    <span class="gs-dock-play">▶</span>
  </div>`,
  button: `
  <div class="gs-btn">
    <span class="gs-btn-mark">V</span>
    <span class="gs-btn-faces">${DOC.people.map((p) => `<i style="--c:${p.colour}"></i>`).join('')}</span>
    <span class="gs-btn-share">${DOC.people[0].share}%</span>
    <span class="gs-btn-play">▶</span>
  </div>`
};
