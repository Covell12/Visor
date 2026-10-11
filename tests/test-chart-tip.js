/* ============================================================================
 * The growth chart's label stays inside the panel.
 * ----------------------------------------------------------------------------
 * It is centred on the point under the pointer, so near either end half of it
 * wants to hang off the side. Hanging off the right widened the panel's
 * scrollable area, and the whole side panel shifted sideways as the pointer
 * approached the last few days of the chart.
 * ==========================================================================*/

'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { makeDom } = require('./dom');

const DIR = path.join(__dirname, '..');

const out = [];
const ck = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  out.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `: ${JSON.stringify(got)} (want ${JSON.stringify(want)})`}`);
};

const { win, document } = makeDom({ autoIds: true });
win.chrome = {
  tabs: { query: async () => [], sendMessage: () => {}, onActivated: { addListener() {} }, create() {} },
  runtime: { lastError: null, onMessage: { addListener() {} }, sendMessage() {}, getURL: (p) => p },
  storage: { local: { get: (k, cb) => cb && cb({}), set() {} }, onChanged: { addListener() {} } }
};
win.visorInitTheme = async () => 'light';
win.visorApplyTheme = () => {};
win.matchMedia = () => ({ matches: false, addEventListener() {} });
for (const cls of ['v-icon-sun', 'v-icon-moon']) {
  const e = document.createElement('div');
  e.className = cls;
  document.body.appendChild(e);
}
const ctx = vm.createContext(win);
vm.runInContext(fs.readFileSync(`${DIR}/sidepanel.js`, 'utf8'), ctx, { filename: 'sidepanel.js' });

const tipLeft = (tipWidth, at, cardWidth) =>
  vm.runInContext(`tipLeft({ offsetWidth: ${tipWidth} }, ${at}, ${cardWidth})`, ctx);

// A 120px label in a 330px card: its middle may run from 64 to 266.
const W = 330, TIP = 120;
const fits = (left) => left - TIP / 2 >= 0 && left + TIP / 2 <= W;

ck('in the middle of the chart the label follows the point', tipLeft(TIP, 165, W), 165);
ck('at the far right it stops at the edge', tipLeft(TIP, 330, W), W - TIP / 2 - 4);
ck('  and stays inside the card', fits(tipLeft(TIP, 330, W)), true);
ck('at the far left it stops at the edge', tipLeft(TIP, 0, W), TIP / 2 + 4);
ck('  and stays inside the card', fits(tipLeft(TIP, 0, W)), true);
ck('just short of the right it is still clamped', tipLeft(TIP, 300, W), W - TIP / 2 - 4);
ck('  while a point comfortably inside is not', tipLeft(TIP, 200, W), 200);

// Every point along a real chart must be safe, not just the ends.
let worst = null;
for (let x = 0; x <= W; x += 3) if (!fits(tipLeft(TIP, x, W))) { worst = x; break; }
ck('no point along the chart pushes the label out of the card', worst, null);

// A label wider than the card cannot be placed inside it; it is centred rather
// than pushed off one side.
ck('a label wider than the card is centred', tipLeft(400, 300, W), W / 2);

console.log(out.every(Boolean) ? `\nall passed (${out.length} checks)` : `\n${out.filter((x) => !x).length} FAILED`);
process.exit(out.every(Boolean) ? 0 : 1);
