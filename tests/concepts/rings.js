/* Apple D — "Rings": Apple Health/Fitness. Coloured section titles, bold
 * rounded figures, activity rings for share, white cards on grey. */

'use strict';

const { DOC, growthPath } = require('./common');

const g = growthPath(300, 60);

/* Concentric activity rings, one per contributor. */
function rings(size = 108) {
  const cx = size / 2;
  const stroke = 11;
  return DOC.people.map((p, i) => {
    const r = cx - stroke / 2 - i * (stroke + 3.5) - 2;
    const c = 2 * Math.PI * r;
    return `
      <circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke="${p.colour}" stroke-opacity="0.16" stroke-width="${stroke}"/>
      <circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke="${p.colour}" stroke-width="${stroke}"
              stroke-linecap="round" stroke-dasharray="${(c * p.share / 100).toFixed(1)} ${c.toFixed(1)}"
              transform="rotate(-90 ${cx} ${cx})"/>`;
  }).join('');
}

module.exports = {
  name: 'rings',
  label: 'Rings — Apple Health: coloured section titles, activity rings for share, bold rounded figures',
  css: `
  :root {
    --bg: #F2F2F7;
    --card: #FFFFFF;
    --label: #000000;
    --label-2: rgba(60,60,67,0.72);
    --label-3: rgba(60,60,67,0.48);
    --sep: #EBEBF0;
    --green: #2FA36F;
    --blue: #2F6FC4;
    --teal: #118A7E;
    --orange: #D08326;
    --red: #CE4A45;
    --sf: -apple-system, 'SF Pro Text', ui-sans-serif, 'Segoe UI', sans-serif;
    --sfr: ui-rounded, 'SF Pro Rounded', -apple-system, sans-serif;
  }
  .panel { background: var(--bg); color: var(--label); font-family: var(--sf); -webkit-font-smoothing: antialiased; }

  .rg-nav { display: flex; align-items: flex-end; justify-content: space-between; padding: 14px 16px 10px; }
  .rg-title { font-family: var(--sfr); font-size: 25px; font-weight: 700; letter-spacing: -0.6px; }
  .rg-date { font-size: 12px; color: var(--label-3); }

  .rg-seg { display: flex; gap: 7px; padding: 0 16px 12px; }
  .rg-seg span { padding: 6px 13px; border-radius: 999px; background: rgba(120,120,128,0.12); font-size: 12px; font-weight: 550; color: var(--label-2); }
  .rg-seg span.on { background: var(--green); color: #fff; }

  .rg-card { margin: 0 16px 12px; background: var(--card); border-radius: 16px; padding: 14px 15px; }
  .rg-card-head { display: flex; align-items: center; gap: 7px; font-size: 12.5px; font-weight: 680; }
  .rg-card-head .tint { color: var(--c); }
  .rg-card-head .more { margin-left: auto; color: var(--label-3); font-size: 12px; }

  .rg-big { display: flex; align-items: baseline; gap: 6px; margin-top: 8px; }
  .rg-big-num { font-family: var(--sfr); font-size: 38px; font-weight: 700; letter-spacing: -1.3px; line-height: 1; }
  .rg-big-unit { font-size: 13px; font-weight: 600; color: var(--label-3); }
  .rg-big-sub { margin-top: 5px; font-size: 12px; color: var(--label-2); }
  .rg-chart svg { display: block; width: 100%; height: 60px; margin-top: 10px; }

  .rg-rings { display: flex; align-items: center; gap: 16px; margin-top: 10px; }
  .rg-rings svg { flex: none; }
  .rg-keys { display: flex; flex-direction: column; gap: 9px; }
  .rg-key { display: flex; align-items: baseline; gap: 8px; }
  .rg-key i { width: 9px; height: 9px; border-radius: 50%; background: var(--c); transform: translateY(-1px); }
  .rg-key-name { font-size: 12.5px; }
  .rg-key-num { font-family: var(--sfr); font-size: 15px; font-weight: 680; color: var(--c); }
  .rg-key-meta { font-size: 10.5px; color: var(--label-3); }

  .rg-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 0 16px 12px; }
  .rg-tile { background: var(--card); border-radius: 16px; padding: 13px 14px; }
  .rg-tile-head { display: flex; align-items: center; gap: 6px; font-size: 11.5px; font-weight: 680; color: var(--c); }
  .rg-tile-num { font-family: var(--sfr); font-size: 25px; font-weight: 700; letter-spacing: -0.7px; margin-top: 6px; }
  .rg-tile-sub { font-size: 11px; color: var(--label-3); margin-top: 1px; }

  .rg-list { margin: 0 16px 14px; background: var(--card); border-radius: 16px; overflow: hidden; }
  .rg-item { display: flex; align-items: center; gap: 11px; padding: 11px 15px; position: relative; }
  .rg-item + .rg-item::before { content: ''; position: absolute; left: 52px; right: 0; top: 0; height: 1px; background: var(--sep); }
  .rg-face { width: 30px; height: 30px; border-radius: 50%; background: var(--c); color: #fff; display: grid; place-items: center; font-size: 11px; font-weight: 650; }
  .rg-iname { font-size: 13px; }
  .rg-imeta { font-size: 11px; color: var(--label-3); margin-top: 1px; }
  .rg-ishare { margin-left: auto; font-family: var(--sfr); font-size: 17px; font-weight: 680; color: var(--c); }

  /* ── Bar: rings in a capsule ─────────────────────────────────────────── */
  .rg-dock {
    display: inline-flex; align-items: center; gap: 14px; padding: 8px 8px 8px 15px;
    background: rgba(255,255,255,0.94); border-radius: 999px;
    box-shadow: 0 18px 38px -20px rgba(0,0,0,0.35), 0 0 0 0.5px rgba(0,0,0,0.05);
    font-family: var(--sf); color: var(--label);
  }
  .rg-dock b { font-size: 13px; font-weight: 650; }
  .rg-dock-item { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--label-2); }
  .rg-dock-item i { width: 9px; height: 9px; border-radius: 50%; background: var(--c); }
  .rg-dock-item b { font-family: var(--sfr); color: var(--c); }
  .rg-dock-play { width: 30px; height: 30px; border-radius: 50%; background: var(--green); color: #fff; display: grid; place-items: center; font-size: 11px; }

  /* ── Button: the rings themselves ────────────────────────────────────── */
  .rg-btn { display: inline-flex; align-items: center; gap: 9px; padding: 6px 13px 6px 7px; background: rgba(255,255,255,0.95); border-radius: 999px; box-shadow: 0 14px 28px -18px rgba(0,0,0,0.4), 0 0 0 0.5px rgba(0,0,0,0.05); }
  .rg-btn b { font-size: 12.5px; font-weight: 650; }
  `,
  panel: `
  <div class="rg-nav">
    <div class="rg-title">Visor</div>
    <div class="rg-date">${DOC.title}</div>
  </div>
  <div class="rg-seg"><span class="on">Overview</span><span>People</span><span>Time</span><span>Evidence</span></div>

  <div class="rg-card" style="--c:var(--green)">
    <div class="rg-card-head"><span class="tint">Words now</span><span class="more">${DOC.span} ›</span></div>
    <div class="rg-big"><span class="rg-big-num">${DOC.words}</span><span class="rg-big-unit">words</span></div>
    <div class="rg-big-sub">${DOC.people.length} people · ${DOC.externalPct}% arrived from outside</div>
    <div class="rg-chart">
      <svg viewBox="0 0 300 60" preserveAspectRatio="none">
        <polygon points="${g.area}" fill="rgba(47,163,111,0.15)"/>
        <polyline points="${g.line}" fill="none" stroke="#2FA36F" stroke-width="2.2" stroke-linejoin="round"/>
      </svg>
    </div>
  </div>

  <div class="rg-card" style="--c:var(--blue)">
    <div class="rg-card-head"><span class="tint">Contributions</span><span class="more">Show all ›</span></div>
    <div class="rg-rings">
      <svg width="108" height="108" viewBox="0 0 108 108">${rings()}</svg>
      <div class="rg-keys">
        ${DOC.people.map((p) => `
          <div class="rg-key" style="--c:${p.colour}">
            <i></i>
            <div>
              <div class="rg-key-name">${p.first} <span class="rg-key-num">${p.share}%</span></div>
              <div class="rg-key-meta">${p.chars} chars · ${p.mins}</div>
            </div>
          </div>`).join('')}
      </div>
    </div>
  </div>

  <div class="rg-pair">
    <div class="rg-tile" style="--c:var(--teal)"><div class="rg-tile-head">Writing</div><div class="rg-tile-num">${DOC.writing}</div><div class="rg-tile-sub">${DOC.edits} edits</div></div>
    <div class="rg-tile" style="--c:var(--orange)"><div class="rg-tile-head">Pastes</div><div class="rg-tile-num">${DOC.pastes}</div><div class="rg-tile-sub">${DOC.externalPct}% external</div></div>
  </div>
  <div class="rg-pair">
    <div class="rg-tile" style="--c:var(--red)"><div class="rg-tile-head">Deleted</div><div class="rg-tile-num">${DOC.deleted}</div><div class="rg-tile-sub">characters removed</div></div>
    <div class="rg-tile" style="--c:var(--green)"><div class="rg-tile-head">Tab</div><div class="rg-tile-num" style="font-size:17px;margin-top:9px">Draft</div><div class="rg-tile-sub">current tab</div></div>
  </div>

  <div class="rg-list">
    ${DOC.people.map((p) => `
      <div class="rg-item" style="--c:${p.colour}">
        <span class="rg-face">${p.initials}</span>
        <div><div class="rg-iname">${p.name}</div><div class="rg-imeta">${p.typed}% typed by hand</div></div>
        <span class="rg-ishare">${p.share}%</span>
      </div>`).join('')}
  </div>`,
  dock: `
  <div class="rg-dock">
    <b>Visor</b>
    <svg width="26" height="26" viewBox="0 0 108 108">${rings()}</svg>
    ${DOC.people.map((p) => `<span class="rg-dock-item" style="--c:${p.colour}"><i></i><b>${p.share}%</b> ${p.first}</span>`).join('')}
    <span class="rg-dock-item">${DOC.words} words</span>
    <span class="rg-dock-play">▶</span>
  </div>`,
  button: `<div class="rg-btn"><svg width="26" height="26" viewBox="0 0 108 108">${rings()}</svg><b>Visor</b></div>`
};
