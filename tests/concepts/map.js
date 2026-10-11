/* Radical B — "Map": the panel shows the document itself, in miniature, with
 * every line coloured by who wrote it. The figures read off the page. */

'use strict';

const { DOC } = require('./common');

/* A deterministic miniature of the page: lines made of author-coloured runs. */
function page(seed, lines) {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const out = [];
  let who = 0;
  for (let i = 0; i < lines; i++) {
    const width = 62 + Math.round(rnd() * 38);
    const runs = [];
    let left = width;
    while (left > 6) {
      if (rnd() < 0.34) who = Math.floor(rnd() * 3);
      const take = Math.min(left, 8 + Math.round(rnd() * 34));
      const paste = rnd() < 0.07;
      runs.push({ w: take, who, paste });
      left -= take;
    }
    out.push({ runs, gap: rnd() < 0.12 });
  }
  return out;
}

const PAGE = page(20260926, 34);

module.exports = {
  name: 'map',
  label: 'Map — a miniature of the page itself, every line coloured by who wrote it',
  css: `
  :root {
    --paper: #F6F7F4;
    --card: #FFFFFF;
    --ink: #14211C;
    --ink-2: #4C5C55;
    --ink-3: #8C9A93;
    --line: #E3E7E2;
    --green: #16694D;
    --green-deep: #0B4030;
    --green-soft: #E6F1EB;
    --hot: #A8402F;
    --serif: 'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif;
  }
  .panel { background: var(--paper); color: var(--ink); font-family: ui-sans-serif, -apple-system, 'Segoe UI', sans-serif; }

  .mp-head { display: flex; align-items: baseline; gap: 9px; padding: 15px 16px 10px; }
  .mp-mark { font-family: var(--serif); font-size: 15px; color: var(--green); }
  .mp-title { font-size: 11.5px; color: var(--ink-3); }
  .mp-live { margin-left: auto; display: inline-flex; align-items: center; gap: 5px; font-size: 10px; color: var(--green); }
  .mp-live i { width: 6px; height: 6px; border-radius: 50%; background: var(--green); }

  /* The page, in miniature */
  .mp-sheet { margin: 0 16px; background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 14px 13px; box-shadow: 0 10px 26px -18px rgba(11,40,30,0.5); }
  .mp-line { display: flex; gap: 2px; margin-bottom: 5px; }
  .mp-line.gap { margin-bottom: 11px; }
  .mp-run { height: 5px; border-radius: 2px; background: var(--c); opacity: 0.88; }
  .mp-run.paste { outline: 1px solid color-mix(in srgb, var(--c) 55%, #000); outline-offset: 1px; opacity: 1; }
  .mp-cursor { position: relative; height: 5px; margin-bottom: 5px; }
  .mp-cursor i { position: absolute; left: 0; width: 22%; height: 100%; border-radius: 2px; background: var(--c); }
  .mp-cursor em { position: absolute; left: 22%; top: -2px; width: 2px; height: 9px; background: var(--ink); }

  .mp-legend { display: flex; gap: 10px; padding: 12px 16px 0; }
  .mp-leg { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--ink-2); }
  .mp-leg i { width: 10px; height: 10px; border-radius: 3px; background: var(--c); }
  .mp-leg b { font-family: var(--serif); font-size: 13px; color: var(--ink); }

  .mp-read { margin: 14px 16px 0; padding: 13px 14px; border-radius: 12px; background: var(--green-deep); color: #EAF3EE; }
  .mp-read-fig { display: flex; align-items: baseline; gap: 7px; }
  .mp-read-num { font-family: var(--serif); font-size: 32px; line-height: 1; letter-spacing: -1px; }
  .mp-read-unit { font-family: var(--serif); font-size: 13px; color: #9CC1B1; }
  .mp-read-sub { margin-top: 5px; font-size: 11px; color: #9CC1B1; }

  .mp-rows { margin: 12px 16px 16px; }
  .mp-row { display: flex; align-items: baseline; justify-content: space-between; padding: 9px 0; border-bottom: 1px solid var(--line); }
  .mp-row:first-child { border-top: 1px solid var(--line); }
  .mp-key { font-size: 11.5px; color: var(--ink-2); }
  .mp-val { font-family: var(--serif); font-size: 15px; }
  .mp-val.hot { color: var(--hot); }

  .mp-hint { margin: 0 16px 18px; font-size: 10.5px; color: var(--ink-3); line-height: 1.5; }

  /* ── The bar: the same map, one line high ────────────────────────────── */
  .mp-dock {
    display: inline-flex; align-items: center; gap: 13px; padding: 8px 10px 8px 14px;
    background: var(--card); border-radius: 12px; border: 1px solid var(--line);
    box-shadow: 0 22px 44px -26px rgba(11,40,30,0.55);
    font-family: ui-sans-serif, sans-serif; color: var(--ink);
  }
  .mp-dock-mark { font-family: var(--serif); font-size: 13px; color: var(--green); }
  .mp-strip { display: flex; gap: 2px; width: 240px; }
  .mp-strip i { height: 10px; border-radius: 2px; background: var(--c); }
  .mp-dock-fig { font-family: var(--serif); font-size: 14px; }
  .mp-dock-fig small { font-family: ui-sans-serif, sans-serif; font-size: 10px; color: var(--ink-3); margin-left: 4px; }
  .mp-dock-tab { font-size: 11px; color: var(--ink-2); }
  .mp-dock-play { width: 28px; height: 28px; border-radius: 9px; background: var(--green); color: #fff; display: grid; place-items: center; font-size: 10px; }

  /* ── The button: the page as a chip ──────────────────────────────────── */
  .mp-btn { display: inline-flex; align-items: center; gap: 9px; padding: 6px 12px 6px 7px; background: var(--card); border: 1px solid var(--line); border-radius: 10px; box-shadow: 0 14px 28px -20px rgba(11,40,30,0.6); }
  .mp-btn-page { width: 22px; padding: 3px; border-radius: 4px; background: var(--green-soft); display: flex; flex-direction: column; gap: 2px; }
  .mp-btn-page i { height: 2px; border-radius: 1px; background: var(--c); }
  .mp-btn b { font-family: var(--serif); font-size: 13px; color: var(--green); }
  `,
  panel: `
  <div class="mp-head">
    <span class="mp-mark">Visor</span>
    <span class="mp-title">${DOC.title}</span>
    <span class="mp-live"><i></i>live</span>
  </div>

  <div class="mp-sheet">
    ${PAGE.map((l, i) => i === 21 ? `
      <div class="mp-cursor" style="--c:${DOC.people[0].colour}"><i></i><em></em></div>` : `
      <div class="mp-line ${l.gap ? 'gap' : ''}">
        ${l.runs.map((r) => `<span class="mp-run ${r.paste ? 'paste' : ''}" style="width:${r.w}%;--c:${DOC.people[r.who].colour}"></span>`).join('')}
      </div>`).join('')}
  </div>

  <div class="mp-legend">
    ${DOC.people.map((p) => `<span class="mp-leg" style="--c:${p.colour}"><i></i>${p.first} <b>${p.share}%</b></span>`).join('')}
  </div>

  <div class="mp-read">
    <div class="mp-read-fig"><span class="mp-read-num">${DOC.words}</span><span class="mp-read-unit">words</span></div>
    <div class="mp-read-sub">${DOC.people.length} people · ${DOC.span} · outlined blocks arrived by paste</div>
  </div>

  <div class="mp-rows">
    <div class="mp-row"><span class="mp-key">Edit operations</span><span class="mp-val">${DOC.edits}</span></div>
    <div class="mp-row"><span class="mp-key">Active writing</span><span class="mp-val">${DOC.writing}</span></div>
    <div class="mp-row"><span class="mp-key">Pastes</span><span class="mp-val">${DOC.pastes}</span></div>
    <div class="mp-row"><span class="mp-key">Characters deleted</span><span class="mp-val hot">${DOC.deleted}</span></div>
  </div>
  <div class="mp-hint">Every line above is a line of your document, coloured by who wrote it. Scrub the map to move through time.</div>`,
  dock: `
  <div class="mp-dock">
    <span class="mp-dock-mark">Visor</span>
    <span class="mp-strip">
      ${PAGE.slice(0, 1)[0].runs.concat(PAGE[3].runs, PAGE[7].runs).slice(0, 12)
        .map((r) => `<i style="flex:${r.w};--c:${DOC.people[r.who].colour}"></i>`).join('')}
    </span>
    <span class="mp-dock-fig">${DOC.words}<small>words</small></span>
    <span class="mp-dock-tab">Current tab ▾</span>
    <span class="mp-dock-play">▶</span>
  </div>`,
  button: `
  <div class="mp-btn">
    <span class="mp-btn-page">
      ${[0, 1, 0, 2, 1, 0].map((w) => `<i style="--c:${DOC.people[w].colour}"></i>`).join('')}
    </span>
    <b>Visor</b>
  </div>`
};
