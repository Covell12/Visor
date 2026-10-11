/* Radical A — "Spine": the panel IS the timeline. No cards; a single vertical
 * thread of the document's history, with figures hung off it. */

'use strict';

const { DOC } = require('./common');

const EVENTS = [
  { t: '09:12', who: 0, kind: 'start',  text: 'Ethan opened the document',        meta: 'first keystroke' },
  { t: '09:31', who: 0, kind: 'write',  text: '1,240 words written',              meta: '19m · 46% typed' },
  { t: '10:04', who: 2, kind: 'paste',  text: 'Maya pasted 301 characters',       meta: 'from outside the document' },
  { t: '10:38', who: 2, kind: 'write',  text: '612 words written',                meta: '22m' },
  { t: '11:50', who: 1, kind: 'delete', text: '1,400 characters removed',         meta: 'Sam, rewriting the opening' },
  { t: '12:24', who: 1, kind: 'write',  text: '980 words written',                meta: '34m · 63% typed' },
  { t: '13:42', who: 0, kind: 'paste',  text: 'Ethan pasted 2 blocks',            meta: '602 characters, external' },
  { t: '14:05', who: 0, kind: 'now',    text: '1,996 words now',                  meta: 'last edit 3 minutes ago' }
];

const GLYPH = { start: '◆', write: '●', paste: '▣', delete: '✕', now: '◎' };

module.exports = {
  name: 'spine',
  label: 'Spine — no cards at all: one vertical thread of the document’s life, figures hung off it',
  css: `
  :root {
    --paper: #F7F8F5;
    --ink: #10201A;
    --ink-2: #47594F;
    --ink-3: #8A9A90;
    --thread: #CFDBD3;
    --green: #16694D;
    --green-deep: #0C4433;
    --hot: #A8402F;
    --serif: 'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif;
  }
  .panel { background: var(--paper); color: var(--ink); font-family: ui-sans-serif, -apple-system, 'Segoe UI', sans-serif; }

  .sp-head { padding: 16px 18px 14px; }
  .sp-kicker { font-size: 9.5px; letter-spacing: 2.2px; text-transform: uppercase; color: var(--green); }
  .sp-fig { display: flex; align-items: baseline; gap: 8px; margin-top: 10px; }
  .sp-num { font-family: var(--serif); font-size: 44px; line-height: 0.9; letter-spacing: -1.6px; }
  .sp-unit { font-family: var(--serif); font-size: 14px; color: var(--ink-3); }
  .sp-sub { margin-top: 7px; font-size: 11.5px; color: var(--ink-2); }

  .sp-legend { display: flex; gap: 12px; padding: 0 18px 14px; }
  .sp-leg { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--ink-2); }
  .sp-leg i { width: 9px; height: 9px; border-radius: 50%; background: var(--c); }
  .sp-leg b { font-family: var(--serif); font-size: 13px; color: var(--ink); }

  /* The thread itself */
  .sp-thread { position: relative; padding: 6px 18px 18px 0; margin-left: 74px; }
  .sp-thread::before { content: ''; position: absolute; left: -33px; top: 0; bottom: 34px; width: 2px; background: var(--thread); }

  .sp-ev { position: relative; padding: 13px 0 13px 0; }
  .sp-time { position: absolute; left: -74px; top: 15px; width: 34px; text-align: right; font-size: 10px; color: var(--ink-3); font-variant-numeric: tabular-nums; }
  .sp-node { position: absolute; left: -40px; top: 13px; width: 16px; height: 16px; border-radius: 50%; background: var(--paper); border: 2px solid var(--c); color: var(--c); display: grid; place-items: center; font-size: 7px; }
  .sp-node.filled { background: var(--c); color: var(--paper); }
  .sp-text { font-size: 12.5px; }
  .sp-meta { margin-top: 3px; font-size: 10.5px; color: var(--ink-3); }
  .sp-ev.delete .sp-text { color: var(--hot); }

  /* A session band, drawn behind a stretch of the thread */
  .sp-band { position: absolute; left: -44px; width: 24px; border-radius: 12px; background: color-mix(in srgb, var(--c) 12%, transparent); }

  .sp-foot { margin: 6px 18px 20px 74px; padding-top: 14px; border-top: 1px solid var(--thread); display: flex; gap: 18px; }
  .sp-foot div { font-size: 10.5px; color: var(--ink-3); }
  .sp-foot b { display: block; font-family: var(--serif); font-size: 17px; color: var(--ink); }
  .sp-foot b.hot { color: var(--hot); }

  /* ── The bar: the same thread, laid flat ─────────────────────────────── */
  .sp-dock {
    display: inline-flex; align-items: center; gap: 14px; padding: 9px 11px 9px 15px;
    background: var(--paper); border-radius: 999px; box-shadow: 0 22px 44px -26px rgba(12,40,30,0.6);
    font-family: ui-sans-serif, sans-serif; color: var(--ink);
  }
  .sp-dock-mark { font-family: var(--serif); font-size: 13px; color: var(--green); }
  .sp-track { position: relative; width: 260px; height: 3px; border-radius: 2px; background: var(--thread); }
  .sp-track i { position: absolute; top: -4px; width: 3px; height: 11px; border-radius: 2px; background: var(--c); }
  .sp-track em { position: absolute; top: -6px; width: 15px; height: 15px; border-radius: 50%; border: 2px solid var(--green); background: var(--paper); }
  .sp-dock-fig { font-family: var(--serif); font-size: 14px; }
  .sp-dock-fig small { font-family: ui-sans-serif, sans-serif; font-size: 10px; color: var(--ink-3); margin-left: 4px; }
  .sp-dock-play { width: 28px; height: 28px; border-radius: 50%; background: var(--green); color: #fff; display: grid; place-items: center; font-size: 10px; }

  /* ── The button: a thread in miniature ───────────────────────────────── */
  .sp-btn { display: inline-flex; align-items: center; gap: 9px; padding: 7px 13px 7px 10px; background: var(--paper); border-radius: 999px; box-shadow: 0 14px 30px -20px rgba(12,40,30,0.6); }
  .sp-btn-thread { display: flex; align-items: center; gap: 2px; }
  .sp-btn-thread i { width: 3px; border-radius: 2px; background: var(--c); }
  .sp-btn b { font-family: var(--serif); font-size: 13px; color: var(--green); }
  `,
  panel: `
  <div class="sp-head">
    <div class="sp-kicker">Visor · ${DOC.title}</div>
    <div class="sp-fig"><span class="sp-num">${DOC.words}</span><span class="sp-unit">words, now</span></div>
    <div class="sp-sub">Everything below happened to this document, in order.</div>
  </div>
  <div class="sp-legend">
    ${DOC.people.map((p) => `<span class="sp-leg" style="--c:${p.colour}"><i></i>${p.first} <b>${p.share}%</b></span>`).join('')}
  </div>

  <div class="sp-thread">
    ${EVENTS.map((e) => {
      const c = DOC.people[e.who].colour;
      const filled = e.kind === 'write' || e.kind === 'now';
      return `
      <div class="sp-ev ${e.kind}" style="--c:${c}">
        <span class="sp-time">${e.t}</span>
        <span class="sp-node ${filled ? 'filled' : ''}">${GLYPH[e.kind]}</span>
        <div class="sp-text">${e.text}</div>
        <div class="sp-meta">${e.meta}</div>
      </div>`;
    }).join('')}
  </div>

  <div class="sp-foot">
    <div><b>${DOC.edits}</b>edits</div>
    <div><b>${DOC.writing}</b>writing</div>
    <div><b>${DOC.pastes}</b>pastes</div>
    <div><b class="hot">${DOC.deleted}</b>deleted</div>
  </div>`,
  dock: `
  <div class="sp-dock">
    <span class="sp-dock-mark">Visor</span>
    <span class="sp-track">
      ${[6, 14, 23, 31, 46, 58, 63, 71, 78, 86].map((x, i) => `<i style="left:${x}%;--c:${DOC.people[i % 3].colour}"></i>`).join('')}
      <em style="left:92%"></em>
    </span>
    <span class="sp-dock-fig">${DOC.words}<small>words</small></span>
    <span class="sp-dock-play">▶</span>
  </div>`,
  button: `
  <div class="sp-btn">
    <span class="sp-btn-thread">
      ${[9, 15, 11, 18, 13, 16].map((h, i) => `<i style="height:${h}px;--c:${DOC.people[i % 3].colour}"></i>`).join('')}
    </span>
    <b>Visor</b>
  </div>`
};
