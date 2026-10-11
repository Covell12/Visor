/* ============================================================================
 * Draw each concept: the side panel, the in-document bar, and the collapsed
 * button, on one canvas, so the directions can be compared like for like.
 *
 *   node tests/concepts/render.js              # all
 *   node tests/concepts/render.js console      # one
 * ==========================================================================*/

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DIR = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, '..', '.out', 'concepts');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const CONCEPTS = ['broadsheet', 'console', 'studio', 'instrument', 'green-editorial', 'green-studio',
                  'spine', 'map', 'strata', 'ledger',
                  'cupertino', 'vision', 'inspector', 'rings', 'ring-broadsheet']
  .map((n) => require(`./${n}`))
  .filter((c) => !process.argv[2] || c.name === process.argv[2]);

fs.mkdirSync(OUT, { recursive: true });

for (const c of CONCEPTS) {
  const page = `
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; background: #C9CEDA; font-family: ui-sans-serif, -apple-system, 'Segoe UI', sans-serif; }
  .stage { display: flex; gap: 30px; padding: 30px; align-items: flex-start; }
  .col-note { font-size: 11px; letter-spacing: 1.6px; text-transform: uppercase; color: #5C6374; margin-bottom: 10px; }
  .panel-frame { width: 380px; border-radius: 14px; overflow: hidden; box-shadow: 0 30px 60px -30px rgba(10,14,25,0.6); }
  .panel { min-height: 900px; }
  .right { flex: 1; display: flex; flex-direction: column; gap: 26px; }
  /* The document behind the bar, so the surfaces are judged in context. */
  .doc {
    position: relative; height: 430px; border-radius: 14px; overflow: hidden;
    background: #FFFFFF; box-shadow: 0 30px 60px -30px rgba(10,14,25,0.6);
    padding: 26px 30px; color: #C7CBD4;
  }
  .doc.dark { background: #1F1F1F; color: #4A4A4A; }
  .doc-line { height: 9px; border-radius: 4px; background: currentColor; opacity: 0.5; margin-bottom: 11px; }
  .doc-dock { position: absolute; left: 50%; bottom: 20px; transform: translateX(-50%); }
  .btn-row { display: flex; align-items: center; gap: 26px; }
  .btn-cell { background: #FFFFFF; border-radius: 14px; padding: 22px 26px; box-shadow: 0 30px 60px -34px rgba(10,14,25,0.6); display: flex; align-items: center; gap: 18px; }
  .btn-cell.dark { background: #1F1F1F; }
  .caption { font-size: 12px; color: #414856; max-width: 520px; line-height: 1.5; }
  ${c.css}
</style>
<div class="stage">
  <div>
    <div class="col-note">Side panel</div>
    <div class="panel-frame"><div class="panel">${c.panel}</div></div>
  </div>
  <div class="right">
    <div>
      <div class="col-note">In the document</div>
      <div class="doc ${['console', 'vision'].includes(c.name) ? 'dark' : ''}">
        ${Array.from({ length: 11 }, (_, i) => `<div class="doc-line" style="width:${[96, 88, 93, 70, 91, 85, 96, 62, 89, 94, 45][i]}%"></div>`).join('')}
        <div class="doc-dock">${c.dock}</div>
      </div>
    </div>
    <div>
      <div class="col-note">Collapsed button</div>
      <div class="btn-row">
        <div class="btn-cell ${['console', 'vision'].includes(c.name) ? 'dark' : ''}">${c.button}</div>
        <div class="caption">${c.label}</div>
      </div>
    </div>
  </div>
</div>`;

  const file = path.join(DIR, `_concept-${c.name}.html`);
  fs.writeFileSync(file, page);
  const png = path.join(OUT, `${c.name}.png`);
  execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--allow-file-access-from-files',
    '--force-device-scale-factor=2', `--window-size=1320,${c.tall ? 1180 : 1010}`, '--virtual-time-budget=3000',
    `--screenshot=${png}`, `file://${file}`], { stdio: 'ignore' });
  fs.unlinkSync(file);
  console.log(png);
}
