/* Radical C — "Strata": the data is the layout. A full-bleed stacked band of
 * authorship over time fills the top of the panel; figures sit on top of it. */

'use strict';

const { DOC } = require('./common');

/* Authorship over time as three stacked bands, as percentages per column. */
const COLS = 40;
function bands() {
  let s = 7;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const out = [];
  let a = 70, b = 20;
  for (let i = 0; i < COLS; i++) {
    a = Math.max(28, Math.min(80, a + (rnd() - 0.5) * 14));
    b = Math.max(10, Math.min(45, b + (rnd() - 0.5) * 10));
    const c = Math.max(6, 100 - a - b);
    out.push([a, b, c]);
  }
  return out;
}
const B = bands();

/* Turn the bands into three stacked SVG polygons over a 300×150 field. */
function poly(index) {
  const W = 300, H = 150;
  const top = [];
  const bottom = [];
  B.forEach((col, i) => {
    const x = (i / (COLS - 1)) * W;
    const below = col.slice(0, index).reduce((n, v) => n + v, 0);
    const here = col[index];
    top.push(`${x.toFixed(1)},${(H * (below / 100)).toFixed(1)}`);
    bottom.unshift(`${x.toFixed(1)},${(H * ((below + here) / 100)).toFixed(1)}`);
  });
  return `${top.join(' ')} ${bottom.join(' ')}`;
}

module.exports = {
  name: 'strata',
  label: 'Strata — the data is the layout: authorship over time fills the panel, figures sit on it',
  css: `
  :root {
    --paper: #F4F6F3;
    --ink: #101B17;
    --ink-2: #4A574F;
    --ink-3: #87948C;
    --line: #E1E6E1;
    --green: #15694C;
    --green-deep: #0A3527;
    --hot: #A8402F;
    --serif: 'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif;
  }
  .panel { background: var(--paper); color: var(--ink); font-family: ui-sans-serif, -apple-system, 'Segoe UI', sans-serif; }

  .st-top { position: relative; height: 300px; overflow: hidden; background: var(--green-deep); }
  .st-top svg { position: absolute; inset: 0; width: 100%; height: 100%; }
  .st-over { position: absolute; inset: 0; padding: 18px; display: flex; flex-direction: column; justify-content: space-between; color: #F1F6F2; }
  .st-kicker { font-size: 9.5px; letter-spacing: 2.2px; text-transform: uppercase; opacity: 0.75; }
  .st-num { font-family: var(--serif); font-size: 46px; line-height: 0.9; letter-spacing: -1.8px; }
  .st-num small { font-family: var(--serif); font-size: 14px; opacity: 0.7; margin-left: 7px; letter-spacing: 0; }
  .st-sub { margin-top: 6px; font-size: 11.5px; opacity: 0.82; }
  .st-axis { display: flex; justify-content: space-between; font-size: 9.5px; opacity: 0.7; }

  .st-keys { display: flex; }
  .st-key { flex: 1; padding: 11px 12px; border-right: 1px solid var(--line); background: color-mix(in srgb, var(--c) 9%, #fff); }
  .st-key:last-child { border-right: none; }
  .st-key-name { display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 620; }
  .st-key-name i { width: 8px; height: 8px; border-radius: 2px; background: var(--c); }
  .st-key-share { font-family: var(--serif); font-size: 20px; margin-top: 3px; color: color-mix(in srgb, var(--c) 82%, #000); }
  .st-key-meta { font-size: 9.5px; color: var(--ink-3); margin-top: 1px; }

  .st-rows { padding: 4px 16px 0; }
  .st-row { display: flex; align-items: baseline; justify-content: space-between; padding: 11px 0; border-bottom: 1px solid var(--line); }
  .st-key2 { font-size: 11.5px; color: var(--ink-2); }
  .st-val { font-family: var(--serif); font-size: 16px; }
  .st-val.hot { color: var(--hot); }

  .st-sec { padding: 18px 16px 6px; font-size: 9.5px; letter-spacing: 2px; text-transform: uppercase; color: var(--ink-3); }
  .st-mix { display: flex; height: 26px; margin: 0 16px; border-radius: 6px; overflow: hidden; }
  .st-mix i { display: block; height: 100%; background: var(--c); position: relative; }
  .st-mix span { display: flex; align-items: center; justify-content: center; height: 100%; font-size: 10px; color: #fff; font-weight: 650; }
  .st-note { padding: 10px 16px 18px; font-size: 10.5px; color: var(--ink-3); line-height: 1.5; }

  /* ── The bar: one strata band, flattened ─────────────────────────────── */
  .sx-dock {
    display: inline-flex; align-items: center; gap: 0; padding: 0; overflow: hidden;
    background: #fff; border-radius: 10px; box-shadow: 0 22px 44px -26px rgba(10,53,39,0.6);
    font-family: ui-sans-serif, sans-serif; color: var(--ink);
  }
  .sx-mark { padding: 10px 13px; font-family: var(--serif); font-size: 13px; color: var(--green); border-right: 1px solid var(--line); }
  .sx-band { display: flex; width: 300px; height: 38px; }
  .sx-band i { height: 100%; background: var(--c); display: grid; place-items: center; font-size: 10px; font-weight: 650; color: #fff; }
  .sx-fig { padding: 10px 13px; font-family: var(--serif); font-size: 14px; border-left: 1px solid var(--line); }
  .sx-fig small { font-family: ui-sans-serif, sans-serif; font-size: 10px; color: var(--ink-3); margin-left: 4px; }
  .sx-play { width: 38px; align-self: stretch; background: var(--green); color: #fff; display: grid; place-items: center; font-size: 10px; }

  /* ── The button: the strata as a stack ───────────────────────────────── */
  .sx-btn { display: inline-flex; align-items: center; gap: 9px; padding: 7px 12px 7px 8px; background: #fff; border-radius: 10px; box-shadow: 0 14px 30px -20px rgba(10,53,39,0.6); }
  .sx-btn-stack { display: flex; flex-direction: column; gap: 2px; width: 20px; }
  .sx-btn-stack i { height: 5px; border-radius: 2px; background: var(--c); }
  .sx-btn b { font-family: var(--serif); font-size: 13px; color: var(--green); }
  `,
  panel: `
  <div class="st-top">
    <svg viewBox="0 0 300 150" preserveAspectRatio="none">
      ${DOC.people.map((p, i) => `<polygon points="${poly(i)}" fill="${p.colour}" opacity="${0.92 - i * 0.06}"/>`).join('')}
    </svg>
    <div class="st-over">
      <div>
        <div class="st-kicker">Visor · ${DOC.title}</div>
        <div class="st-num" style="margin-top:12px">${DOC.words}<small>words</small></div>
        <div class="st-sub">who was writing, from the first keystroke to now</div>
      </div>
      <div class="st-axis"><span>09:12</span><span>11:30</span><span>14:05</span></div>
    </div>
  </div>

  <div class="st-keys">
    ${DOC.people.map((p) => `
      <div class="st-key" style="--c:${p.colour}">
        <div class="st-key-name"><i></i>${p.first}</div>
        <div class="st-key-share">${p.share}%</div>
        <div class="st-key-meta">${p.chars} chars</div>
      </div>`).join('')}
  </div>

  <div class="st-rows">
    <div class="st-row"><span class="st-key2">Edit operations</span><span class="st-val">${DOC.edits}</span></div>
    <div class="st-row"><span class="st-key2">Active writing</span><span class="st-val">${DOC.writing}</span></div>
    <div class="st-row"><span class="st-key2">Pastes</span><span class="st-val">${DOC.pastes} <small style="font-family:ui-sans-serif;font-size:10px;color:var(--ink-3)">${DOC.externalPct}% external</small></span></div>
    <div class="st-row"><span class="st-key2">Characters deleted</span><span class="st-val hot">${DOC.deleted}</span></div>
  </div>

  <div class="st-sec">Surviving text</div>
  <div class="st-mix">
    ${DOC.people.map((p) => `<i style="--c:${p.colour};width:${p.share}%"><span>${p.share}%</span></i>`).join('')}
  </div>
  <div class="st-note">The band at the top is the document over time: thickness is how much of what was being written belonged to each person.</div>`,
  dock: `
  <div class="sx-dock">
    <span class="sx-mark">Visor</span>
    <span class="sx-band">
      ${DOC.people.map((p) => `<i style="--c:${p.colour};width:${p.share}%">${p.first} ${p.share}%</i>`).join('')}
    </span>
    <span class="sx-fig">${DOC.words}<small>words</small></span>
    <span class="sx-play">▶</span>
  </div>`,
  button: `
  <div class="sx-btn">
    <span class="sx-btn-stack">${DOC.people.map((p) => `<i style="--c:${p.colour}"></i>`).join('')}</span>
    <b>Visor</b>
  </div>`
};
