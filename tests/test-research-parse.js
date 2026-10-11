/* ============================================================================
 * Which URLs are searches, and on which engine.
 * ----------------------------------------------------------------------------
 * research.js parseSearch() for every engine Section 8.3 lists, the forms each
 * one uses, and pages that only look like searches. Also the AI-site matcher
 * and what counts as research at all.
 * ==========================================================================*/

'use strict';

const { parseSearch, siteMatch, isRecordable } = require('../research.js');

const out = [];
const ck = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  out.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `: ${JSON.stringify(got)} (want ${JSON.stringify(want)})`}`);
};
const s = (engine, query) => ({ engine, query });

// ── Every engine ───────────────────────────────────────────────────────────
ck('Google', parseSearch('https://www.google.com/search?q=school+start+times&oq=school'), s('google', 'school start times'));
ck('Google, another country', parseSearch('https://www.google.co.uk/search?q=sleep%20teens'), s('google', 'sleep teens'));
ck('Google images (tbm)', parseSearch('https://www.google.com/search?q=circadian+rhythm&tbm=isch'), s('google', 'circadian rhythm'));
ck('Bing', parseSearch('https://www.bing.com/search?q=later+start+times&form=QBLH'), s('bing', 'later start times'));
ck('DuckDuckGo', parseSearch('https://duckduckgo.com/?q=adolescent+sleep&t=h_'), s('duckduckgo', 'adolescent sleep'));
ck('DuckDuckGo html', parseSearch('https://html.duckduckgo.com/html/?q=melatonin'), s('duckduckgo', 'melatonin'));
ck('Yahoo', parseSearch('https://search.yahoo.com/search?p=bell+schedule&fr=yfp'), s('yahoo', 'bell schedule'));
ck('YouTube', parseSearch('https://www.youtube.com/results?search_query=teen+sleep+science'), s('youtube', 'teen sleep science'));
ck('Google Scholar', parseSearch('https://scholar.google.com/scholar?hl=en&q=school+start+time+academic+performance'), s('scholar', 'school start time academic performance'));
ck('Google Scholar, another country', parseSearch('https://scholar.google.de/scholar?q=schlaf'), s('scholar', 'schlaf'));
ck('Wikipedia index.php', parseSearch('https://en.wikipedia.org/w/index.php?search=circadian+rhythm&title=Special%3ASearch'), s('wikipedia', 'circadian rhythm'));
ck('Wikipedia Special:Search', parseSearch('https://en.wikipedia.org/wiki/Special:Search?search=sleep+deprivation'), s('wikipedia', 'sleep deprivation'));
ck('Wikipedia Special:Search/path', parseSearch('https://en.wikipedia.org/wiki/Special:Search/Sleep_hygiene'), s('wikipedia', 'Sleep hygiene'));
ck('Ecosia', parseSearch('https://www.ecosia.org/search?method=index&q=start+times'), s('ecosia', 'start times'));
ck('Brave', parseSearch('https://search.brave.com/search?q=school+bus+schedules&source=web'), s('brave', 'school bus schedules'));
ck('Perplexity ?q=', parseSearch('https://www.perplexity.ai/search?q=should+school+start+later'), s('perplexity', 'should school start later'));
ck('Perplexity path form', parseSearch('https://www.perplexity.ai/search/should-school-start-later-a1B2c3D4e5F6g7'), s('perplexity', 'should school start later'));

// ── Not searches ───────────────────────────────────────────────────────────
ck('a Wikipedia article', parseSearch('https://en.wikipedia.org/wiki/Circadian_rhythm'), null);
ck('the Google home page', parseSearch('https://www.google.com/'), null);
ck('an empty Google search', parseSearch('https://www.google.com/search?q='), null);
ck('a YouTube video', parseSearch('https://www.youtube.com/watch?v=abc123'), null);
ck('a news article with ?q=', parseSearch('https://www.nytimes.com/2024/01/01/health/sleep.html?q=x'), null);
ck('Bing maps', parseSearch('https://www.bing.com/maps?q=school'), null);
ck('not a URL', parseSearch('school start times'), null);
ck('a chrome page', parseSearch('chrome://settings/?search=sleep'), null);
ck('long queries are capped at 500', parseSearch('https://www.google.com/search?q=' + 'a'.repeat(900)).query.length, 500);

// ── AI and blocked sites ───────────────────────────────────────────────────
const AI = ['chatgpt.com', 'openai.com', 'claude.ai', 'huggingface.co/chat', 'perplexity.ai'];
ck('an AI site', siteMatch('https://chatgpt.com/c/123', AI), 'chatgpt.com');
ck('a subdomain counts', siteMatch('https://chat.openai.com/', AI), 'openai.com');
ck('a path entry', siteMatch('https://huggingface.co/chat/conversation/9', AI), 'huggingface.co/chat');
ck('…but not the rest of the site', siteMatch('https://huggingface.co/datasets', AI), null);
ck('a lookalike isn’t a match', siteMatch('https://notclaude.ai/', AI), null);
ck('a bare host', siteMatch('perplexity.ai', AI), 'perplexity.ai');

// ── What's research ────────────────────────────────────────────────────────
const VISOR = ['http://localhost:3000', 'https://visor-ed.web.app'];
ck('an ordinary page is research', isRecordable('https://www.cdc.gov/sleep/', VISOR), true);
ck('Visor itself isn’t', isRecordable('https://visor-ed.web.app/write/abc', VISOR), false);
ck('browser pages aren’t', [isRecordable('chrome://newtab/', VISOR), isRecordable('chrome-extension://x/blocked.html', VISOR), isRecordable('about:blank', VISOR)], [false, false, false]);
ck('Google’s new tab page isn’t', isRecordable('https://www.google.com/_/chrome/newtab?ie=UTF-8', VISOR), false);

console.log(out.every(Boolean) ? `\nall passed (${out.length} checks)` : `\n${out.filter((x) => !x).length} FAILED`);
process.exit(out.every(Boolean) ? 0 : 1);
