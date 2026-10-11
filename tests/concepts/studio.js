/* Concept 3 — "Studio": colour blocks per author, chunky type, soft geometry. */

'use strict';

const { DOC, growthPath } = require('./common');

const g = growthPath(300, 70);

module.exports = {
  name: 'studio',
  label: 'Studio — authorship as colour, big friendly blocks, chunky type',
  css: `
  :root {
    --bg: #F2F1F6;
    --card: #FFFFFF;
    --ink: #17161C;
    --ink-2: #565465;
    --ink-3: #8B8899;
    --line: #E6E4EE;
    --accent: #5B45E0;
    --warm: #E08A2E;
    --hot: #D3456B;
  }
  .panel { background: var(--bg); color: var(--ink); font-family: ui-rounded, 'SF Pro Rounded', ui-sans-serif, -apple-system, sans-serif; }

  .s-head { display: flex; align-items: center; gap: 10px; padding: 14px 14px 10px; }
  .s-logo { width: 30px; height: 30px; border-radius: 10px; background: var(--accent); color: #fff; display: grid; place-items: center; font-size: 13px; font-weight: 800; }
  .s-title { font-size: 13.5px; font-weight: 750; letter-spacing: -0.2px; }
  .s-sub { font-size: 11px; color: var(--ink-3); }

  .s-seg { display: flex; gap: 4px; margin: 4px 12px 12px; padding: 4px; background: #E6E4EE; border-radius: 12px; }
  .s-seg span { flex: 1; text-align: center; padding: 6px 0; font-size: 11px; font-weight: 650; color: var(--ink-2); border-radius: 9px; }
  .s-seg span.on { background: var(--card); color: var(--ink); box-shadow: 0 2px 6px -2px rgba(23,22,28,0.25); }

  .s-body { padding: 0 12px 14px; display: flex; flex-direction: column; gap: 10px; }

  .s-hero { background: var(--card); border-radius: 18px; padding: 16px; }
  .s-hero-top { display: flex; align-items: flex-end; justify-content: space-between; }
  .s-hero-num { font-size: 40px; font-weight: 800; letter-spacing: -1.6px; line-height: 1; }
  .s-hero-unit { font-size: 12px; font-weight: 650; color: var(--ink-3); margin-left: 5px; }
  .s-hero-pill { padding: 5px 10px; border-radius: 999px; background: #EFECFF; color: var(--accent); font-size: 11px; font-weight: 750; }
  .s-hero-chart svg { display: block; width: 100%; height: 70px; margin-top: 10px; }

  .s-split { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .s-tile { background: var(--card); border-radius: 16px; padding: 13px 14px; }
  .s-tile-num { font-size: 21px; font-weight: 780; letter-spacing: -0.6px; }
  .s-tile-key { margin-top: 2px; font-size: 11px; font-weight: 600; color: var(--ink-3); }
  .s-tile.warm .s-tile-num { color: var(--warm); }
  .s-tile.hot .s-tile-num { color: var(--hot); }

  .s-people { background: var(--card); border-radius: 18px; overflow: hidden; }
  .s-ptitle { padding: 13px 15px 9px; font-size: 11px; font-weight: 750; letter-spacing: 0.6px; text-transform: uppercase; color: var(--ink-3); }
  .s-prow { display: flex; align-items: center; gap: 11px; padding: 11px 15px; border-top: 1px solid var(--line); }
  .s-face { width: 34px; height: 34px; border-radius: 12px; background: var(--c); color: #fff; display: grid; place-items: center; font-size: 12px; font-weight: 750; }
  .s-pname { font-size: 12.5px; font-weight: 700; }
  .s-pmeta { font-size: 10.5px; color: var(--ink-3); margin-top: 1px; }
  .s-pshare { margin-left: auto; font-size: 17px; font-weight: 800; color: var(--c); }

  .s-stack { display: flex; height: 12px; border-radius: 999px; overflow: hidden; margin: 12px 15px 15px; }
  .s-stack i { display: block; height: 100%; background: var(--c); }

  /* ── The bar in the document ─────────────────────────────────────────── */
  .s-dock {
    display: inline-flex; align-items: center; gap: 12px; padding: 9px 10px 9px 15px;
    background: var(--card); border-radius: 999px; box-shadow: 0 20px 45px -25px rgba(23,22,28,0.6), 0 2px 6px -3px rgba(23,22,28,0.2);
    font-family: ui-rounded, 'SF Pro Rounded', ui-sans-serif, sans-serif; color: var(--ink);
  }
  .s-dock-mark { width: 24px; height: 24px; border-radius: 8px; background: var(--accent); color: #fff; display: grid; place-items: center; font-size: 11px; font-weight: 800; }
  .s-dock-people { display: flex; align-items: center; gap: 7px; }
  .s-dock-chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px 4px 6px; border-radius: 999px; background: color-mix(in srgb, var(--c) 14%, #fff); font-size: 11px; font-weight: 700; color: color-mix(in srgb, var(--c) 78%, #000); }
  .s-dock-chip i { width: 8px; height: 8px; border-radius: 50%; background: var(--c); }
  .s-dock-div { width: 1px; height: 20px; background: var(--line); }
  .s-dock-fig { font-size: 12px; font-weight: 700; }
  .s-dock-fig small { font-weight: 600; color: var(--ink-3); margin-left: 4px; }
  .s-dock-tab { font-size: 11.5px; font-weight: 650; color: var(--ink-2); }
  .s-dock-play { width: 30px; height: 30px; border-radius: 50%; background: var(--accent); color: #fff; display: grid; place-items: center; font-size: 11px; }

  /* ── The collapsed button ────────────────────────────────────────────── */
  .s-btn { display: inline-flex; align-items: center; gap: 8px; padding: 7px 8px 7px 9px; background: var(--card); border-radius: 999px; box-shadow: 0 14px 30px -18px rgba(23,22,28,0.6); }
  .s-btn-mark { width: 26px; height: 26px; border-radius: 9px; background: var(--accent); color: #fff; display: grid; place-items: center; font-size: 11px; font-weight: 800; }
  .s-btn-faces { display: flex; }
  .s-btn-faces i { width: 18px; height: 18px; border-radius: 50%; background: var(--c); border: 2px solid var(--card); margin-left: -6px; }
  .s-btn-faces i:first-child { margin-left: 0; }
  .s-btn-play { width: 26px; height: 26px; border-radius: 50%; background: var(--accent); color: #fff; display: grid; place-items: center; font-size: 9px; }
  `,
  panel: `
  <div class="s-head">
    <div class="s-logo">V</div>
    <div><div class="s-title">${DOC.title}</div><div class="s-sub">Current tab · Draft</div></div>
  </div>
  <div class="s-seg"><span class="on">Overview</span><span>People</span><span>Time</span><span>Evidence</span></div>
  <div class="s-body">
    <div class="s-hero">
      <div class="s-hero-top">
        <div><span class="s-hero-num">${DOC.words}</span><span class="s-hero-unit">words</span></div>
        <div class="s-hero-pill">${DOC.externalPct}% external</div>
      </div>
      <div class="s-hero-chart">
        <svg viewBox="0 0 300 70" preserveAspectRatio="none">
          <polygon points="${g.area}" fill="rgba(91,69,224,0.12)"/>
          <polyline points="${g.line}" fill="none" stroke="#5B45E0" stroke-width="2.5" stroke-linejoin="round"/>
        </svg>
      </div>
    </div>

    <div class="s-split">
      <div class="s-tile"><div class="s-tile-num">${DOC.edits}</div><div class="s-tile-key">edits</div></div>
      <div class="s-tile"><div class="s-tile-num">${DOC.writing}</div><div class="s-tile-key">writing</div></div>
      <div class="s-tile warm"><div class="s-tile-num">${DOC.pastes}</div><div class="s-tile-key">pastes</div></div>
      <div class="s-tile hot"><div class="s-tile-num">${DOC.deleted}</div><div class="s-tile-key">deleted</div></div>
    </div>

    <div class="s-people">
      <div class="s-ptitle">Who wrote it</div>
      ${DOC.people.map((p) => `
        <div class="s-prow" style="--c:${p.colour}">
          <div class="s-face">${p.initials}</div>
          <div><div class="s-pname">${p.name}</div><div class="s-pmeta">${p.chars} chars · ${p.mins}</div></div>
          <div class="s-pshare">${p.share}%</div>
        </div>`).join('')}
      <div class="s-stack">${DOC.people.map((p) => `<i style="--c:${p.colour};width:${p.share}%"></i>`).join('')}</div>
    </div>
  </div>`,
  dock: `
  <div class="s-dock">
    <div class="s-dock-mark">V</div>
    <div class="s-dock-people">
      ${DOC.people.map((p) => `<span class="s-dock-chip" style="--c:${p.colour}"><i></i>${p.first} ${p.share}%</span>`).join('')}
    </div>
    <span class="s-dock-div"></span>
    <span class="s-dock-fig">${DOC.words}<small>words</small></span>
    <span class="s-dock-div"></span>
    <span class="s-dock-tab">Current tab ▾</span>
    <span class="s-dock-play">▶</span>
  </div>`,
  button: `
  <div class="s-btn">
    <span class="s-btn-mark">V</span>
    <span class="s-btn-faces">${DOC.people.map((p) => `<i style="--c:${p.colour}"></i>`).join('')}</span>
    <span class="s-btn-play">▶</span>
  </div>`
};
