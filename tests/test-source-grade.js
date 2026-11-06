/* ============================================================================
 * The reliability grade shown in the session panel (source-grade.js, a copy
 * of the web app's public/source-grade.js): a few pages a student might be
 * on, and every AI site this extension knows grades D.
 * ==========================================================================*/

'use strict';

const G = require('../source-grade.js');
// config.js puts everything on VisorConfig (it also loads as a plain script)
const { DEFAULT_AI_SITES } = require('../config.js').VisorConfig;

const out = [];
const ck = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  out.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `: ${JSON.stringify(got)} (want ${JSON.stringify(want)})`}`);
};
const g = (url) => { const r = G.gradeUrl(url, { now: Date.parse('2026-11-01') }); return r ? `${r.letter} ${r.kind}` : null; };

ck('government', g('https://www.cdc.gov/sleep/'), 'A gov');
ck('journal', g('https://pubmed.ncbi.nlm.nih.gov/123/'), 'A scholarly');
ck('encyclopedia', g('https://www.britannica.com/science/sleep'), 'B reference');
ck('Wikipedia', g('https://en.wikipedia.org/wiki/Sleep'), 'C wiki');
ck('unknown site, nothing known about author or date', g('https://sleep-facts.example.com/x'), 'D web');
ck('Reddit', g('https://www.reddit.com/r/x'), 'D social');
ck('Google results', g('https://www.google.com/search?q=sleep'), 'D search');
ck('not a web page', g('chrome://newtab/'), null);
// A cited page with its author and date does better than the bare address
ck('cited with author and date', G.grade({ type: 'article', url: 'https://sleep-facts.example.com/x', authors: ['Jo Reyes'], published: '2025-01-02' }, { now: Date.parse('2026-11-01') }).letter, 'C');
// An archived copy is graded by the page it saved, even when that address has
// a % that isn't an escape (the web app's copy had this fix first)
const safe = (f) => { try { return f(); } catch (e) { return `threw ${e.name}`; } };
ck('archived copy, address with a stray %', safe(() => g('https://web.archive.org/web/20190101000000/https://www.cdc.gov/sleep/100%-rest.html')), 'A gov');
const notD = DEFAULT_AI_SITES.filter((s) => !/^D /.test(g(`https://${s}/x`) || ''));
ck(`every AI site in config.js (${DEFAULT_AI_SITES.length}) grades D`, notD, []);

const failed = out.filter((x) => !x).length;
console.log(`\n${out.length - failed}/${out.length} passed`);
process.exit(failed ? 1 : 0);
