/* Radical D — "Ledger": the panel as a printed record of the document — dot
 * leaders, a stamp, a signature line. The bar is a ticker tape. */

'use strict';

const { DOC } = require('./common');

module.exports = {
  name: 'ledger',
  label: 'Ledger — a printed record: dot leaders, a stamp, a signature line, a ticker-tape bar',
  css: `
  :root {
    --paper: #F8F6EF;
    --paper-2: #FFFDF7;
    --ink: #1A1A16;
    --ink-2: #4E4E44;
    --ink-3: #8A8A7C;
    --rule: #D8D5C8;
    --green: #1B6046;
    --green-deep: #123F2E;
    --hot: #A23A2B;
    --serif: 'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif;
    --mono: ui-monospace, 'SF Mono', Menlo, monospace;
  }
  .panel { background: var(--paper); color: var(--ink); font-family: var(--mono); }

  /* A torn edge at the top, as if the record were pulled from a roll. */
  .lg-tear { height: 10px; background:
    radial-gradient(circle at 6px -2px, transparent 6px, var(--paper) 6.5px) repeat-x;
    background-size: 12px 10px; }

  .lg-head { padding: 12px 18px 14px; text-align: center; border-bottom: 2px solid var(--ink); }
  .lg-brand { font-family: var(--serif); font-size: 19px; letter-spacing: 2px; }
  .lg-doc { margin-top: 5px; font-size: 10px; letter-spacing: 0.8px; color: var(--ink-2); }
  .lg-when { margin-top: 3px; font-size: 9.5px; color: var(--ink-3); }

  .lg-body { padding: 14px 18px 0; }

  .lg-sec { display: flex; align-items: center; gap: 8px; margin: 16px 0 8px; font-size: 9.5px; letter-spacing: 2px; text-transform: uppercase; color: var(--ink-3); }
  .lg-sec::after { content: ''; flex: 1; border-top: 1px dashed var(--rule); }

  .lg-line { display: flex; align-items: baseline; gap: 6px; padding: 6px 0; font-size: 11.5px; }
  .lg-line .k { color: var(--ink-2); white-space: nowrap; }
  .lg-line .dots { flex: 1; border-bottom: 1px dotted var(--rule); transform: translateY(-3px); }
  .lg-line .v { font-family: var(--serif); font-size: 15px; font-variant-numeric: tabular-nums; }
  .lg-line .v.hot { color: var(--hot); }

  .lg-total { margin-top: 10px; padding: 12px 0 14px; border-top: 2px solid var(--ink); border-bottom: 2px solid var(--ink); display: flex; align-items: baseline; justify-content: space-between; }
  .lg-total .k { font-size: 10px; letter-spacing: 1.6px; text-transform: uppercase; color: var(--ink-2); }
  .lg-total .v { font-family: var(--serif); font-size: 34px; letter-spacing: -1px; }
  .lg-total .v small { font-size: 13px; color: var(--ink-3); margin-left: 6px; }

  .lg-people { margin-top: 4px; }
  .lg-person { padding: 9px 0; border-bottom: 1px dashed var(--rule); }
  .lg-person-top { display: flex; align-items: baseline; gap: 8px; font-size: 11.5px; }
  .lg-person-top .n { font-family: var(--serif); font-size: 14px; }
  .lg-person-top .s { margin-left: auto; font-family: var(--serif); font-size: 15px; }
  .lg-bar { display: flex; gap: 1px; margin-top: 7px; }
  .lg-bar i { height: 7px; flex: 1; background: var(--rule); }
  .lg-bar i.on { background: var(--c); }
  .lg-person-meta { margin-top: 5px; font-size: 9.5px; color: var(--ink-3); }

  .lg-stampwrap { position: relative; height: 96px; margin: 14px 0 0; }
  .lg-stamp {
    position: absolute; right: 4px; top: 2px; transform: rotate(-9deg);
    border: 2px solid var(--hot); color: var(--hot); border-radius: 6px;
    padding: 7px 12px; text-align: center; opacity: 0.85;
  }
  .lg-stamp b { display: block; font-family: var(--serif); font-size: 21px; line-height: 1; }
  .lg-stamp span { font-size: 8px; letter-spacing: 1.8px; }
  .lg-sign { position: absolute; left: 0; bottom: 6px; width: 62%; }
  .lg-sign i { display: block; border-bottom: 1px solid var(--ink); height: 26px; }
  .lg-sign span { font-size: 9px; color: var(--ink-3); }

  .lg-foot { padding: 8px 18px 18px; font-size: 9px; color: var(--ink-3); line-height: 1.6; text-align: center; letter-spacing: 0.4px; }

  /* ── The bar: ticker tape ────────────────────────────────────────────── */
  .lg-dock {
    display: inline-flex; align-items: stretch; background: var(--paper-2);
    border-top: 2px solid var(--ink); border-bottom: 2px solid var(--ink);
    box-shadow: 0 20px 40px -26px rgba(26,26,22,0.6);
    font-family: var(--mono); color: var(--ink);
  }
  .lg-dock-cell { display: flex; align-items: center; gap: 7px; padding: 9px 13px; border-right: 1px dashed var(--rule); font-size: 11px; }
  .lg-dock-cell:last-child { border-right: none; }
  .lg-dock-cell b { font-family: var(--serif); font-size: 14px; }
  .lg-dock-cell i { width: 8px; height: 8px; border-radius: 50%; background: var(--c); }
  .lg-dock-brand { font-family: var(--serif); letter-spacing: 2px; font-size: 13px; }
  .lg-dock-play { background: var(--ink); color: var(--paper-2); padding: 0 14px; display: grid; place-items: center; }

  /* ── The button: a stamp ─────────────────────────────────────────────── */
  .lg-btn { display: inline-flex; align-items: center; gap: 10px; padding: 7px 14px 7px 8px; background: var(--paper-2); border: 2px solid var(--ink); border-radius: 4px; box-shadow: 4px 4px 0 rgba(26,26,22,0.18); }
  .lg-btn-seal { width: 30px; height: 30px; border-radius: 50%; border: 2px solid var(--green); color: var(--green); display: grid; place-items: center; font-family: var(--serif); font-size: 14px; }
  .lg-btn b { font-family: var(--serif); font-size: 13px; letter-spacing: 1.4px; }
  `,
  panel: `
  <div class="lg-tear"></div>
  <div class="lg-head">
    <div class="lg-brand">VISOR</div>
    <div class="lg-doc">${DOC.title}</div>
    <div class="lg-when">record read from the document's own log · 14:05</div>
  </div>

  <div class="lg-body">
    <div class="lg-total">
      <span class="k">Words now</span>
      <span class="v">${DOC.words}<small>words</small></span>
    </div>

    <div class="lg-sec">Account of the work</div>
    <div class="lg-line"><span class="k">Edit operations</span><span class="dots"></span><span class="v">${DOC.edits}</span></div>
    <div class="lg-line"><span class="k">Active writing</span><span class="dots"></span><span class="v">${DOC.writing}</span></div>
    <div class="lg-line"><span class="k">Pastes</span><span class="dots"></span><span class="v">${DOC.pastes}</span></div>
    <div class="lg-line"><span class="k">— of which external</span><span class="dots"></span><span class="v">${DOC.externalPct}%</span></div>
    <div class="lg-line"><span class="k">Characters deleted</span><span class="dots"></span><span class="v hot">${DOC.deleted}</span></div>
    <div class="lg-line"><span class="k">Span</span><span class="dots"></span><span class="v">${DOC.span}</span></div>

    <div class="lg-sec">Attributed to</div>
    <div class="lg-people">
      ${DOC.people.map((p) => `
        <div class="lg-person" style="--c:${p.colour}">
          <div class="lg-person-top"><span class="n">${p.name}</span><span class="s">${p.share}%</span></div>
          <div class="lg-bar">${Array.from({ length: 20 }, (_, i) => `<i class="${i < Math.round(p.share / 5) ? 'on' : ''}"></i>`).join('')}</div>
          <div class="lg-person-meta">${p.chars} characters · ${p.mins} active · ${p.typed}% typed by hand</div>
        </div>`).join('')}
    </div>

    <div class="lg-stampwrap">
      <div class="lg-stamp"><b>${DOC.externalPct}%</b><span>EXTERNAL</span></div>
      <div class="lg-sign"><i></i><span>nothing here left your browser</span></div>
    </div>
  </div>
  <div class="lg-foot">VISOR · every figure derived from the document's revision log</div>`,
  dock: `
  <div class="lg-dock">
    <span class="lg-dock-cell lg-dock-brand">VISOR</span>
    ${DOC.people.map((p) => `<span class="lg-dock-cell" style="--c:${p.colour}"><i></i><b>${p.share}%</b> ${p.first.toUpperCase()}</span>`).join('')}
    <span class="lg-dock-cell"><b>${DOC.words}</b> WORDS</span>
    <span class="lg-dock-cell">CURRENT TAB ▾</span>
    <span class="lg-dock-play">▶</span>
  </div>`,
  button: `<div class="lg-btn"><span class="lg-btn-seal">V</span><b>VISOR</b></div>`
};
