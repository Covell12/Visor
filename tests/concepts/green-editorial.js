/* Blend A — "Editorial green": Broadsheet's paper and serif figures, Visor's
 * green, with Studio's rounded blocks and colour-coded people. */

'use strict';

const { DOC, growthPath } = require('./common');

const g = growthPath(300, 74);

module.exports = {
  name: 'green-editorial',
  label: 'Editorial green — paper and serif figures, a deep green hero, rounded people blocks',
  css: `
  :root {
    --paper: #FAF9F5;
    --card: #FFFFFF;
    --ink: #15201C;
    --ink-2: #4B5A54;
    --ink-3: #8A968F;
    --rule: #E3E2DA;
    --rule-2: #EFEEE8;
    --green: #17624A;
    --green-deep: #0E4635;
    --green-soft: #E7F1EC;
    --green-line: #C7DED4;
    --hot: #A8402F;
    --serif: 'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif;
  }
  .panel { background: var(--paper); color: var(--ink); font-family: ui-sans-serif, -apple-system, 'Segoe UI', sans-serif; }

  .ge-head { display: flex; align-items: center; gap: 10px; padding: 15px 18px 13px; border-bottom: 1px solid var(--rule); }
  .ge-mark { width: 28px; height: 28px; border-radius: 9px; background: var(--green); color: #fff; display: grid; place-items: center; font-family: var(--serif); font-size: 15px; }
  .ge-title { font-size: 12.5px; font-weight: 640; letter-spacing: -0.1px; }
  .ge-sub { font-size: 10.5px; color: var(--ink-3); margin-top: 1px; }

  .ge-nav { display: flex; gap: 17px; padding: 0 18px; border-bottom: 1px solid var(--rule); }
  .ge-nav span { padding: 10px 0 9px; font-size: 11px; letter-spacing: 0.9px; text-transform: uppercase; color: var(--ink-3); }
  .ge-nav span.on { color: var(--green); font-weight: 700; box-shadow: inset 0 -2px 0 var(--green); }

  .ge-scope { display: flex; align-items: center; gap: 8px; margin: 14px 16px 0; padding: 8px 11px; border: 1px solid var(--green-line); border-radius: 10px; background: var(--green-soft); font-size: 11.5px; color: var(--green-deep); font-weight: 620; }
  .ge-scope span { margin-left: auto; color: var(--green); }

  .ge-body { padding: 14px 16px 18px; display: flex; flex-direction: column; gap: 14px; }

  .ge-hero { border-radius: 16px; background: var(--green-deep); color: #F3F7F4; padding: 18px 18px 16px; }
  .ge-hero-fig { display: flex; align-items: baseline; gap: 8px; }
  .ge-hero-num { font-family: var(--serif); font-size: 48px; line-height: 0.92; letter-spacing: -1.6px; }
  .ge-hero-unit { font-family: var(--serif); font-size: 15px; color: #A9C6B8; }
  .ge-hero-sub { margin-top: 8px; font-size: 11.5px; color: #A9C6B8; }
  .ge-hero-chart { margin-top: 12px; }
  .ge-hero-chart svg { display: block; width: 100%; height: 74px; }
  .ge-hero-foot { display: flex; gap: 7px; margin-top: 12px; padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.13); }
  .ge-chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 9px 4px 7px; border-radius: 999px; background: rgba(255,255,255,0.09); font-size: 10.5px; }
  .ge-chip i { width: 7px; height: 7px; border-radius: 50%; background: var(--c); }
  .ge-chip b { font-weight: 700; }

  .ge-rows { background: var(--card); border: 1px solid var(--rule); border-radius: 14px; padding: 2px 14px; }
  .ge-row { display: flex; align-items: baseline; justify-content: space-between; padding: 11px 0; border-bottom: 1px solid var(--rule-2); }
  .ge-row:last-child { border-bottom: none; }
  .ge-key { font-size: 11.5px; color: var(--ink-2); }
  .ge-val { font-family: var(--serif); font-size: 16px; font-variant-numeric: tabular-nums; }
  .ge-val small { font-family: ui-sans-serif, sans-serif; font-size: 10px; color: var(--ink-3); margin-left: 6px; }
  .ge-val.hot { color: var(--hot); }

  .ge-sec { display: flex; align-items: center; gap: 10px; font-size: 10px; letter-spacing: 1.8px; text-transform: uppercase; color: var(--ink-3); }
  .ge-sec::after { content: ''; flex: 1; height: 1px; background: var(--rule); }

  .ge-people { display: flex; flex-direction: column; gap: 8px; }
  .ge-person { display: flex; align-items: center; gap: 11px; padding: 12px 13px; background: var(--card); border: 1px solid var(--rule); border-radius: 13px; }
  .ge-face { width: 32px; height: 32px; border-radius: 11px; background: var(--c); color: #fff; display: grid; place-items: center; font-size: 11px; font-weight: 700; }
  .ge-pname { font-size: 12.5px; font-weight: 600; }
  .ge-pmeta { font-size: 10.5px; color: var(--ink-3); margin-top: 2px; }
  .ge-pshare { margin-left: auto; font-family: var(--serif); font-size: 19px; color: var(--c); }

  .ge-stack { display: flex; height: 8px; border-radius: 999px; overflow: hidden; }
  .ge-stack i { display: block; height: 100%; background: var(--c); }

  /* ── The bar in the document ─────────────────────────────────────────── */
  .ge-dock {
    display: inline-flex; align-items: center; gap: 13px; padding: 8px 9px 8px 14px;
    background: var(--paper); border: 1px solid var(--rule); border-radius: 999px;
    box-shadow: 0 22px 44px -26px rgba(14,35,28,0.55), 0 2px 5px -3px rgba(14,35,28,0.25);
    font-family: ui-sans-serif, -apple-system, sans-serif; color: var(--ink);
  }
  .ge-dock-mark { width: 24px; height: 24px; border-radius: 8px; background: var(--green); color: #fff; display: grid; place-items: center; font-family: var(--serif); font-size: 13px; }
  .ge-dock-chip { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; }
  .ge-dock-chip i { width: 8px; height: 8px; border-radius: 50%; background: var(--c); }
  .ge-dock-chip b { font-family: var(--serif); font-size: 13px; }
  .ge-dock-div { width: 1px; height: 18px; background: var(--rule); }
  .ge-dock-fig { font-family: var(--serif); font-size: 14px; }
  .ge-dock-fig small { font-family: ui-sans-serif, sans-serif; font-size: 10px; color: var(--ink-3); margin-left: 5px; }
  .ge-dock-tab { font-size: 11.5px; color: var(--ink-2); }
  .ge-dock-play { width: 28px; height: 28px; border-radius: 50%; background: var(--green); color: #fff; display: grid; place-items: center; font-size: 10px; }

  /* ── The collapsed button ────────────────────────────────────────────── */
  .ge-btn { display: inline-flex; align-items: center; gap: 9px; padding: 6px 8px 6px 10px; background: var(--paper); border: 1px solid var(--rule); border-radius: 999px; box-shadow: 0 14px 30px -20px rgba(14,35,28,0.6); }
  .ge-btn-mark { font-family: var(--serif); font-size: 13px; color: var(--green); }
  .ge-btn-faces { display: flex; }
  .ge-btn-faces i { width: 17px; height: 17px; border-radius: 50%; background: var(--c); border: 2px solid var(--paper); margin-left: -6px; }
  .ge-btn-faces i:first-child { margin-left: 0; }
  .ge-btn-play { width: 26px; height: 26px; border-radius: 50%; background: var(--green); color: #fff; display: grid; place-items: center; font-size: 9px; }
  `,
  panel: `
  <div class="ge-head">
    <div class="ge-mark">V</div>
    <div><div class="ge-title">${DOC.title}</div><div class="ge-sub">Visor · revision record</div></div>
  </div>
  <div class="ge-nav"><span class="on">Overview</span><span>People</span><span>Timeline</span><span>Evidence</span><span>Signal</span></div>
  <div class="ge-scope">Current tab · Draft <span>▾</span></div>

  <div class="ge-body">
    <div class="ge-hero">
      <div class="ge-hero-fig"><span class="ge-hero-num">${DOC.words}</span><span class="ge-hero-unit">words</span></div>
      <div class="ge-hero-sub">written by ${DOC.people.length} people over ${DOC.span} · ${DOC.externalPct}% from outside</div>
      <div class="ge-hero-chart">
        <svg viewBox="0 0 300 74" preserveAspectRatio="none">
          <polygon points="${g.area}" fill="rgba(255,255,255,0.10)"/>
          <polyline points="${g.line}" fill="none" stroke="#7FD9B4" stroke-width="1.8"/>
        </svg>
      </div>
      <div class="ge-hero-foot">
        ${DOC.people.map((p) => `<span class="ge-chip" style="--c:${p.colour}"><i></i>${p.first} <b>${p.share}%</b></span>`).join('')}
      </div>
    </div>

    <div class="ge-rows">
      <div class="ge-row"><span class="ge-key">Edit operations</span><span class="ge-val">${DOC.edits}</span></div>
      <div class="ge-row"><span class="ge-key">Active writing</span><span class="ge-val">${DOC.writing}</span></div>
      <div class="ge-row"><span class="ge-key">Pastes</span><span class="ge-val">${DOC.pastes}<small>${DOC.externalPct}% external</small></span></div>
      <div class="ge-row"><span class="ge-key">Characters deleted</span><span class="ge-val hot">${DOC.deleted}</span></div>
    </div>

    <div class="ge-sec">Contributors</div>
    <div class="ge-people">
      ${DOC.people.map((p) => `
        <div class="ge-person" style="--c:${p.colour}">
          <span class="ge-face">${p.initials}</span>
          <div><div class="ge-pname">${p.name}</div><div class="ge-pmeta">${p.chars} chars · ${p.mins} · ${p.typed}% typed</div></div>
          <span class="ge-pshare">${p.share}%</span>
        </div>`).join('')}
      <div class="ge-stack">${DOC.people.map((p) => `<i style="--c:${p.colour};width:${p.share}%"></i>`).join('')}</div>
    </div>
  </div>`,
  dock: `
  <div class="ge-dock">
    <span class="ge-dock-mark">V</span>
    ${DOC.people.map((p) => `<span class="ge-dock-chip" style="--c:${p.colour}"><i></i><b>${p.share}%</b> ${p.first}</span>`).join('')}
    <span class="ge-dock-div"></span>
    <span class="ge-dock-fig">${DOC.words}<small>words</small></span>
    <span class="ge-dock-div"></span>
    <span class="ge-dock-tab">Current tab ▾</span>
    <span class="ge-dock-play">▶</span>
  </div>`,
  button: `
  <div class="ge-btn">
    <span class="ge-btn-mark">Visor</span>
    <span class="ge-btn-faces">${DOC.people.map((p) => `<i style="--c:${p.colour}"></i>`).join('')}</span>
    <span class="ge-btn-play">▶</span>
  </div>`
};
