/* ============================================================================
 * The lockdown's declarativeNetRequest rules (lockdown.js).
 * ----------------------------------------------------------------------------
 * Locked with an allowed list: Visor, Google sign-in and the list are allowed,
 * everything else goes to blocked.html. Locked with no list, or open with
 * "block AI sites": only the AI list is redirected. Open and only flagging:
 * nothing. The regexes are run against real URLs here, the way Chrome would.
 * ==========================================================================*/

'use strict';

const { buildBlockRules, blockedReason, shouldBounce, RULE_BASE } = require('../lockdown.js');

const out = [];
const ck = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  out.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `: ${JSON.stringify(got)} (want ${JSON.stringify(want)})`}`);
};

const opts = { visorOrigin: 'https://visor-ed.web.app', blockedPage: 'chrome-extension://abc/blocked.html' };
const AI = ['chatgpt.com', 'openai.com', 'huggingface.co/chat'];

// What Chrome would do with a main-frame URL: the highest-priority matching rule
function decide(rules, url) {
  const u = new URL(url);
  const hostMatch = (domains) => domains.some((d) => u.hostname === d || u.hostname.endsWith('.' + d));
  const hits = rules.filter((r) => {
    const c = r.condition;
    if (c.requestDomains && !hostMatch(c.requestDomains)) return false;
    if (c.regexFilter && !new RegExp(c.regexFilter).test(url)) return false;
    if (c.urlFilter) { const f = c.urlFilter.replace(/^\|\|/, ''); const hp = u.hostname + u.pathname; if (!(hp === f || hp.startsWith(f + '/') || ('.' + hp).includes('.' + f))) return false; }
    return true;
  }).sort((a, b) => b.priority - a.priority);
  if (!hits.length) return 'load';
  const r = hits[0];
  if (r.action.type === 'allow') return 'allow';
  return url.replace(new RegExp(r.condition.regexFilter), r.action.redirect.regexSubstitution.split('\\0').join('$&'));
}

// ── Locked, with allowed sites ─────────────────────────────────────────────
{
  const rules = buildBlockRules({ mode: 'locked', allowedSites: ['en.wikipedia.org', 'jstor.org', 'example.org/library'], blockedSites: AI, blockAiSites: true }, opts);
  ck('rule ids start at the reserved base', rules[0].id, RULE_BASE);
  ck('only top-level pages', rules.every((r) => JSON.stringify(r.condition.resourceTypes) === '["main_frame"]'), true);
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

// ── Browser pages ──────────────────────────────────────────────────────────
ck('chrome://extensions is bounced', shouldBounce('chrome://extensions/?id=abc'), true);
ck('chrome://settings is bounced', shouldBounce('chrome://settings/clearBrowserData'), true);
ck('a web page isn’t', shouldBounce('https://www.cdc.gov/'), false);

console.log(out.every(Boolean) ? `\nall passed (${out.length} checks)` : `\n${out.filter((x) => !x).length} FAILED`);
process.exit(out.every(Boolean) ? 0 : 1);
