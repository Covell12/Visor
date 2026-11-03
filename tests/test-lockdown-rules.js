/* ============================================================================
 * The lockdown's declarativeNetRequest rules (lockdown.js).
 * ----------------------------------------------------------------------------
 * Locked with an allowed list: Visor, Google sign-in and the list are allowed,
 * everything else goes to blocked.html. Locked with no list, or open with
 * "block AI sites": only the AI list is redirected. Open and only flagging:
 * nothing. Research mode (side panel) sets the allowed list aside. The
 * regexes are run against real URLs here, the way Chrome would.
 * ==========================================================================*/

'use strict';

const { buildBlockRules, blockedReason, blockedUrl, shouldBounce, searchAiMatch, RULE_BASE } = require('../lockdown.js');

const out = [];
const ck = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  out.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `: ${JSON.stringify(got)} (want ${JSON.stringify(want)})`}`);
};

const opts = { visorOrigin: 'https://visor-ed.web.app', blockedPage: 'chrome-extension://abc/blocked.html' };
const AI = ['chatgpt.com', 'openai.com', 'huggingface.co/chat'];

// What Chrome would do with a URL loaded as a page (main_frame) or inside a
// frame (sub_frame): the highest-priority matching rule
function decide(rules, url, type = 'main_frame') {
  const u = new URL(url);
  const hostMatch = (domains) => domains.some((d) => u.hostname === d || u.hostname.endsWith('.' + d));
  const hits = rules.filter((r) => {
    const c = r.condition;
    if (!c.resourceTypes.includes(type)) return false;
    if (c.requestDomains && !hostMatch(c.requestDomains)) return false;
    if (c.regexFilter && !new RegExp(c.regexFilter, c.isUrlFilterCaseSensitive === false ? 'i' : '').test(url)) return false;
    if (c.urlFilter) { const f = c.urlFilter.replace(/^\|\|/, ''); const hp = u.hostname + u.pathname; if (!(hp === f || hp.startsWith(f + '/') || ('.' + hp).includes('.' + f))) return false; }
    return true;
  }).sort((a, b) => b.priority - a.priority);
  if (!hits.length) return 'load';
  const r = hits[0];
  if (r.action.type === 'allow') return 'allow';
  if (r.action.type === 'block') return 'block';
  return url.replace(new RegExp(r.condition.regexFilter), r.action.redirect.regexSubstitution.split('\\0').join('$&'));
}

// ── Locked, with allowed sites ─────────────────────────────────────────────
{
  const rules = buildBlockRules({ mode: 'locked', allowedSites: ['en.wikipedia.org', 'jstor.org', 'example.org/library'], blockedSites: AI, blockAiSites: true }, opts);
  ck('rule ids start at the reserved base', rules[0].id, RULE_BASE);
  ck('pages are redirected and allowed at the top level only', rules.filter((r) => r.action.type !== 'block').every((r) => JSON.stringify(r.condition.resourceTypes) === '["main_frame"]'), true);
  ck('frames are only ever blocked', rules.filter((r) => r.condition.resourceTypes.includes('sub_frame')).every((r) => r.action.type === 'block' && r.condition.resourceTypes.length === 1), true);
  ck('an allowed site may still be framed', decide(rules, 'https://en.wikipedia.org/wiki/Sleep', 'sub_frame'), 'load');
  ck('Visor is allowed', decide(rules, 'https://visor-ed.web.app/write/abc'), 'allow');
  ck('Google sign-in is allowed', decide(rules, 'https://accounts.google.com/signin'), 'allow');
  ck('an allowed site', decide(rules, 'https://en.wikipedia.org/wiki/Sleep'), 'allow');
  ck('…and its subdomains', decide(rules, 'https://www.jstor.org/stable/123'), 'allow');
  ck('an allowed path', decide(rules, 'https://example.org/library/books?q=1'), 'allow');
  ck('the rest of that site is not', decide(rules, 'https://example.org/games'), 'chrome-extension://abc/blocked.html?u=https://example.org/games');
  ck('anything else goes to the blocked page, address kept', decide(rules, 'https://www.reddit.com/r/x?a=1&b=2'), 'chrome-extension://abc/blocked.html?u=https://www.reddit.com/r/x?a=1&b=2');
  ck('AI sites too', decide(rules, 'https://chatgpt.com/'), 'chrome-extension://abc/blocked.html?u=https://chatgpt.com/');
}

// ── Locked, no list: AI sites only ─────────────────────────────────────────
{
  const rules = buildBlockRules({ mode: 'locked', allowedSites: [], blockedSites: AI, blockAiSites: true }, opts);
  ck('locked, no list: ordinary sites load', decide(rules, 'https://www.cdc.gov/sleep/'), 'load');
  ck('locked, no list: AI sites are blocked', decide(rules, 'https://chat.openai.com/c/1'), 'chrome-extension://abc/blocked.html?u=https://chat.openai.com/c/1');
  ck('a path entry is blocked', decide(rules, 'https://huggingface.co/chat/conv/9'), 'chrome-extension://abc/blocked.html?u=https://huggingface.co/chat/conv/9');
  ck('…but not the rest of the host', decide(rules, 'https://huggingface.co/datasets'), 'load');
  ck('a lookalike host isn’t blocked', decide(rules, 'https://notchatgpt.com/'), 'load');
}

// ── Open sessions ──────────────────────────────────────────────────────────
ck('open, AI flagged only: no rules', buildBlockRules({ mode: 'open', blockedSites: AI, blockAiSites: false }, opts), []);
{
  const rules = buildBlockRules({ mode: 'open', blockedSites: AI, blockAiSites: true, allowedSites: ['only.example'] }, opts);
  ck('open, "block AI sites": AI blocked', decide(rules, 'https://chatgpt.com/'), 'chrome-extension://abc/blocked.html?u=https://chatgpt.com/');
  ck('open: the allowed list doesn’t apply', decide(rules, 'https://www.cdc.gov/'), 'load');
}

// ── AI sites inside an allowed domain, and "block AI sites" turned off ─────
{
  const rules = buildBlockRules({ mode: 'locked', allowedSites: ['google.com'], blockedSites: ['gemini.google.com', 'chatgpt.com'], blockAiSites: true }, opts);
  ck('an allowed domain still loads', decide(rules, 'https://www.google.com/search?q=sleep'), 'allow');
  ck('…but an AI site under it is blocked', decide(rules, 'https://gemini.google.com/app'), 'chrome-extension://abc/blocked.html?u=https://gemini.google.com/app');
  ck('Google sign-in still loads', decide(rules, 'https://accounts.google.com/signin'), 'allow');
}
ck('locked, no list, "block AI sites" off: nothing is redirected', buildBlockRules({ mode: 'locked', allowedSites: [], blockedSites: AI, blockAiSites: false }, opts), []);
{
  const rules = buildBlockRules({ mode: 'locked', allowedSites: ['en.wikipedia.org'], blockedSites: AI, blockAiSites: false }, opts);
  ck('locked list, "block AI sites" off: AI sites still aren’t on the list', decide(rules, 'https://chatgpt.com/'), 'chrome-extension://abc/blocked.html?u=https://chatgpt.com/');
}

// ── Pages already open when the lock starts ────────────────────────────────
{
  const st = { mode: 'locked', allowedSites: ['en.wikipedia.org', 'google.com'], blockedSites: ['gemini.google.com'], blockAiSites: true };
  ck('an open allowed page may stay', blockedReason('https://en.wikipedia.org/wiki/Sleep', st, opts.visorOrigin), null);
  ck('an open AI page is sent away', blockedReason('https://gemini.google.com/app', st, opts.visorOrigin), 'ai');
  ck('an open page that isn’t allowed is sent away', blockedReason('https://www.reddit.com/', st, opts.visorOrigin), 'not-allowed');
  ck('Visor itself stays', blockedReason('https://visor-ed.web.app/write/1', st, opts.visorOrigin), null);
  ck('browser pages are left to the bounce', blockedReason('chrome://newtab/', st, opts.visorOrigin), null);
  ck('open session: only AI pages', [blockedReason('https://www.reddit.com/', { ...st, mode: 'open' }, opts.visorOrigin), blockedReason('https://gemini.google.com/', { ...st, mode: 'open' }, opts.visorOrigin)], [null, 'ai']);
}

// ── Research mode: a locked session writing in the side panel ──────────────
{
  const st = { mode: 'locked', allowedSites: ['en.wikipedia.org', 'google.com'], blockedSites: ['gemini.google.com', 'chatgpt.com'], blockAiSites: true };
  const rules = buildBlockRules(st, { ...opts, research: true });
  ck('research mode: a site off the allowed list loads', decide(rules, 'https://example.com/'), 'load');
  ck('research mode: AI sites stay blocked', decide(rules, 'https://chatgpt.com/'), 'chrome-extension://abc/blocked.html?u=https://chatgpt.com/');
  ck('research mode: an AI site under an allowed domain stays blocked', decide(rules, 'https://gemini.google.com/app'), 'chrome-extension://abc/blocked.html?u=https://gemini.google.com/app');
  ck('research mode: no catch-all redirect', rules.some((r) => r.action.type === 'redirect' && !r.condition.requestDomains && r.condition.regexFilter === '^https?://.*'), false);
  ck('research mode: the same rules as a locked session with no list', rules, buildBlockRules({ ...st, allowedSites: [] }, opts));
  ck('research mode, "block AI sites" off: nothing is redirected', buildBlockRules({ ...st, blockAiSites: false }, { ...opts, research: true }), []);
  ck('without research mode the list still applies', decide(buildBlockRules(st, opts), 'https://example.com/'), 'chrome-extension://abc/blocked.html?u=https://example.com/');
  const why = (url, o) => blockedReason(url, st, opts.visorOrigin, o);
  ck('blockedReason agrees in research mode', [why('https://example.com/', { research: true }), why('https://chatgpt.com/', { research: true }), why('https://gemini.google.com/app', { research: true })], [null, 'ai', 'ai']);
  ck('…and without it', [why('https://example.com/'), why('https://example.com/', { research: false })], ['not-allowed', 'not-allowed']);
}

// ── AI inside frames, and the search engines' AI modes ─────────────────────
{
  const st = { mode: 'open', allowedSites: [], blockedSites: AI, blockAiSites: true };
  const rules = buildBlockRules(st, opts);
  ck('an AI site framed in another page is blocked', decide(rules, 'https://chatgpt.com/embed', 'sub_frame'), 'block');
  ck('…a subdomain too', decide(rules, 'https://chat.openai.com/', 'sub_frame'), 'block');
  ck('…and an AI path', decide(rules, 'https://huggingface.co/chat/abc', 'sub_frame'), 'block');
  ck('other frames load', [decide(rules, 'https://www.youtube.com/embed/x', 'sub_frame'), decide(rules, 'https://huggingface.co/models', 'sub_frame')], ['load', 'load']);
  ck('Google AI Mode goes to the blocked page', decide(rules, 'https://www.google.com/search?q=sleep&udm=50'), 'chrome-extension://abc/blocked.html?u=https://www.google.com/search?q=sleep&udm=50');
  ck('…in any Google country', decide(rules, 'https://www.google.co.uk/search?udm=50&q=x'), 'chrome-extension://abc/blocked.html?u=https://www.google.co.uk/search?udm=50&q=x');
  ck('an ordinary Google search loads', [decide(rules, 'https://www.google.com/search?q=sleep'), decide(rules, 'https://www.google.com/search?q=sleep&udm=5'), decide(rules, 'https://www.google.com/search?q=udm%3D50')], ['load', 'load', 'load']);
  ck('Bing Copilot search and chat are blocked', [decide(rules, 'https://www.bing.com/copilotsearch?q=x'), decide(rules, 'https://www.bing.com/chat')].map((x) => x.startsWith('chrome-extension://abc/blocked.html')), [true, true]);
  ck('a Bing search loads', decide(rules, 'https://www.bing.com/search?q=chat'), 'load');
  ck('Duck.ai is blocked', [decide(rules, 'https://duckduckgo.com/?q=x&ia=chat'), decide(rules, 'https://duckduckgo.com/aichat')].map((x) => x.startsWith('chrome-extension://abc/blocked.html')), [true, true]);
  ck('a DuckDuckGo search loads', decide(rules, 'https://duckduckgo.com/?q=x&ia=web'), 'load');
  ck('searchAiMatch names them', [searchAiMatch('https://www.google.com/search?udm=50&q=a'), searchAiMatch('https://www.bing.com/chat'), searchAiMatch('https://duckduckgo.com/aichat'), searchAiMatch('https://www.google.com/search?q=a')], ['Google AI Mode', 'Bing Copilot Search', 'Duck.ai', null]);
  ck('blockedReason sends an open AI Mode page away', blockedReason('https://www.google.com/search?q=a&udm=50', st, opts.visorOrigin), 'ai');
  ck('…only when AI sites are blocked', blockedReason('https://www.google.com/search?q=a&udm=50', { ...st, blockAiSites: false }, opts.visorOrigin), null);
  ck('"block AI sites" off: no frame rules either', buildBlockRules({ ...st, blockAiSites: false }, opts), []);
  ck('encoded addresses are read as the search engine reads them', [searchAiMatch('https://www.google.com/search?q=a&udm=5%30'), searchAiMatch('https://www.google.com/search?q=a&ud%6D=50'), searchAiMatch('https://duckduckgo.com/?q=x&i%61=chat')], ['Google AI Mode', 'Google AI Mode', 'Duck.ai']);
  ck('…but a search that only mentions it isn’t', searchAiMatch('https://www.google.com/search?q=udm%3D50'), null);
  ck('Bing’s other Copilot addresses', [decide(rules, 'https://cn.bing.com/chat'), decide(rules, 'https://www.bing.com/search?q=x&showconv=1'), decide(rules, 'https://edgeservices.bing.com/edgesvc/chat?x=1')].map((x) => x.startsWith('chrome-extension://abc/blocked.html')), [true, true, true]);
  ck('…named as such', [searchAiMatch('https://cn.bing.com/chat'), searchAiMatch('https://www.bing.com/search?q=x&showconv=1'), searchAiMatch('https://edgeservices.bing.com/edgesvc/chat')], ['Bing Copilot Search', 'Bing Copilot Search', 'Bing Copilot Search']);
  const noAccess = buildBlockRules({ mode: 'locked', allowedSites: ['en.wikipedia.org'], blockedSites: AI, blockAiSites: true }, { ...opts, canRedirect: false });
  ck('without site access pages are blocked outright, never left open', [decide(noAccess, 'https://www.reddit.com/'), decide(noAccess, 'https://chatgpt.com/'), decide(noAccess, 'https://en.wikipedia.org/wiki/X')], ['block', 'block', 'allow']);
  const locked = buildBlockRules({ mode: 'locked', allowedSites: ['google.com'], blockedSites: AI, blockAiSites: true }, opts);
  ck('locked, google.com allowed: AI Mode is still blocked', decide(locked, 'https://www.google.com/search?q=a&udm=50').startsWith('chrome-extension://abc/blocked.html'), true);
  ck('…while ordinary searches are allowed', decide(locked, 'https://www.google.com/search?q=a'), 'allow');
}

// ── Browser pages ──────────────────────────────────────────────────────────
ck('chrome://extensions is bounced', shouldBounce('chrome://extensions/?id=abc'), true);
ck('chrome://settings is bounced', shouldBounce('chrome://settings/clearBrowserData'), true);
ck('a web page isn’t', shouldBounce('https://www.cdc.gov/'), false);
ck('other browsers’ settings pages too', ['edge://settings', 'brave://extensions', 'opera://flags', 'vivaldi://settings'].map((u) => shouldBounce(u)), [true, true, true, true]);
ck('so are the file system, page source and developer tools', ['file:///Users/s/notes.txt', 'view-source:https://www.cdc.gov/', 'devtools://devtools/bundled/inspector.html'].map((u) => shouldBounce(u)), [true, true, true]);
ck('so is another extension’s page', shouldBounce('chrome-extension://notes/page.html', 'visor'), true);
ck('…but not Visor’s own', shouldBounce('chrome-extension://visor/blocked.html', 'visor'), false);
ck('a new tab is left alone', [shouldBounce('chrome://newtab/'), shouldBounce('chrome://new-tab-page/')], [false, false]);

// The session's key goes first in the blocked page's address, so a page the
// session's rules opened can be told from one a site framed or opened itself
{
  const KEY = '0123456789abcdef0123456789abcdef';
  const keyed = buildBlockRules({ mode: 'locked', allowedSites: ['example.org'], blockedSites: AI, blockAiSites: true }, { ...opts, blockedKey: KEY });
  ck('with a key: the redirect carries it, the address still after u=', decide(keyed, 'https://www.reddit.com/r/x?a=1&b=2'), `chrome-extension://abc/blocked.html?k=${KEY}&u=https://www.reddit.com/r/x?a=1&b=2`);
  ck('  AI sites too', decide(keyed, 'https://chatgpt.com/'), `chrome-extension://abc/blocked.html?k=${KEY}&u=https://chatgpt.com/`);
  ck('blockedUrl for a tab sent there directly', blockedUrl('chrome-extension://abc/blocked.html', KEY, 'https://chatgpt.com/?q=1&u=2'), `chrome-extension://abc/blocked.html?k=${KEY}&u=https://chatgpt.com/?q=1&u=2`);
  ck('  a missing or malformed key is left out (never put into a rule)', [blockedUrl('x/blocked.html', '', 'https://a.b/'), blockedUrl('x/blocked.html', 'short', 'https://a.b/'), blockedUrl('x/blocked.html', 'a\\0b&u=evil-and-long-enough', 'https://a.b/')], ['x/blocked.html?u=https://a.b/', 'x/blocked.html?u=https://a.b/', 'x/blocked.html?u=https://a.b/']);
}

console.log(out.every(Boolean) ? `\nall passed (${out.length} checks)` : `\n${out.filter((x) => !x).length} FAILED`);
process.exit(out.every(Boolean) ? 0 : 1);
