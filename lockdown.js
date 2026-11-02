/* ============================================================================
 * Visor — Lockdown rules
 * ----------------------------------------------------------------------------
 * Pure functions (no chrome.* calls), used by session-bg.js and tested in node.
 *
 * buildBlockRules(settings, { visorOrigin, blockedPage, research }) returns the
 * declarativeNetRequest dynamic rules for a session:
 *
 *   locked, with allowed sites   allow (priority 2): Visor, the allowed sites,
 *                                accounts.google.com; redirect (priority 1):
 *                                every other page, to blocked.html?u=<url>;
 *                                with "block AI sites", the AI list is
 *                                redirected above the allow rules (priority 3)
 *   no allowed list, "block AI"  allow Visor and accounts.google.com; redirect
 *   (locked or open)             only the sites on the AI list
 *   "block AI" off, no list      no rules (AI visits are only recorded)
 *
 * research: true is a locked session writing in the side panel. The allowed
 * list doesn't apply then, so it gets the "no allowed list" rules above.
 *
 * With "block AI sites", the AI list also covers:
 *   • the AI answer modes of search engines (SEARCH_AI: Google's AI Mode,
 *     Bing's Copilot search, DuckDuckGo's Duck.ai), which live at a search
 *     address rather than a site of their own;
 *   • frames: an AI site embedded in another page (a chat widget, a page
 *     that frames ChatGPT) is blocked outright (sub_frame, action "block").
 *
 * Top-level pages (main_frame) are redirected to the blocked page, which reads
 * the original address from everything after "?u=" (it isn't re-encoded, so
 * the original's own "?" and "&" survive). Chrome only redirects pages the
 * extension may see: without that access (canRedirect: false) the same pages
 * are blocked outright instead, so the lock never silently stops.
 *
 * The search engines' AI modes can also be reached without a page load (the
 * results page switching mode in place) or by an encoded address the regexes
 * don't read; session-bg.js checks every navigation with searchAiMatch, which
 * parses the address, and sends those tabs to the blocked page itself.
 * ==========================================================================*/

'use strict';

(function (root) {
  const RULE_BASE = 9100;   // our dynamic rule ids: 9100 and up
  const MAIN = ['main_frame'];
  const SUB = ['sub_frame'];

  // AI answer modes inside search engines: RE2 regexes for the rules, as
  // Chrome runs them on the address as typed
  const SEARCH_AI = [
    { name: 'Google AI Mode', res: ['^https?://([a-z0-9-]+\\.)*google\\.[a-z]{2,3}(\\.[a-z]{2})?/search\\?([^#]*&)?udm=50(&.*|#.*)?$'] },
    { name: 'Bing Copilot Search', res: ['^https?://([a-z0-9-]+\\.)*bing\\.com/(chat|copilotsearch)([/?#].*)?$', '^https?://([a-z0-9-]+\\.)*bing\\.com/search\\?([^#]*&)?showconv=1(&.*|#.*)?$', '^https?://edgeservices\\.bing\\.com/edgesvc/chat([/?#].*)?$'] },
    { name: 'Duck.ai', res: ['^https?://([a-z0-9-]+\\.)*duckduckgo\\.com/(aichat([/?#].*)?|\\?([^#]*&)?ia=chat(&.*|#.*)?)$'] }
  ];
  // Which of them a URL is (its name), or null. Parses the address, so an
  // encoded one ("udm=5%30") is read the way the search engine reads it.
  function searchAiMatch(url) {
    let u;
    try { u = new URL(String(url || '')); } catch (_) { return null; }
    if (!/^https?:$/.test(u.protocol)) return null;
    const h = u.hostname.toLowerCase(), p = u.pathname.toLowerCase(), q = u.searchParams;
    if (/(^|\.)google\.[a-z]{2,3}(\.[a-z]{2})?$/.test(h) && p === '/search' && q.get('udm') === '50') return 'Google AI Mode';
    if (/(^|\.)bing\.com$/.test(h) && (/^\/(chat|copilotsearch)(\/|$)/.test(p) || (p === '/search' && q.get('showconv') === '1') || (h === 'edgeservices.bing.com' && p.startsWith('/edgesvc/chat')))) return 'Bing Copilot Search';
    if (/(^|\.)duckduckgo\.com$/.test(h) && (/^\/aichat(\/|$)/.test(p) || q.get('ia') === 'chat')) return 'Duck.ai';
    return null;
  }

  // "example.com" -> { host: 'example.com' }; "huggingface.co/chat" -> { host, path: '/chat' }
  function splitEntry(entry) {
    const e = String(entry || '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/\/+$/, '');
    if (!e) return null;
    const slash = e.indexOf('/');
    const host = (slash < 0 ? e : e.slice(0, slash)).replace(/:\d+$/, '');
    if (!/^[a-z0-9.-]+$/.test(host)) return null;
    return { host, path: slash < 0 ? '' : e.slice(slash) };
  }

  function hostOfOrigin(origin) {
    try { return new URL(origin).hostname; } catch (_) { return null; }
  }

  // The AI list (and the search engines' AI modes): pages go to the blocked
  // page; the same sites inside a frame are blocked outright
  function aiRedirectRules(blocked, redirect, priority, nextId) {
    const rules = [];
    const block = { type: 'block' };
    const hosts = blocked.filter((b) => !b.path).map((b) => b.host);
    if (hosts.length) {
      rules.push({ id: nextId(), priority, action: redirect, condition: { regexFilter: '^https?://.*', requestDomains: hosts, resourceTypes: MAIN } });
      rules.push({ id: nextId(), priority, action: block, condition: { requestDomains: hosts, resourceTypes: SUB } });
    }
    const regexes = blocked.filter((x) => x.path).map((b) => `^https?://([a-z0-9-]+\\.)*${b.host.replace(/\./g, '\\.')}${b.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([/?#].*)?$`)
      .concat(...SEARCH_AI.map((x) => x.res));
    for (const re of regexes) {
      rules.push({ id: nextId(), priority, action: redirect, condition: { regexFilter: re, isUrlFilterCaseSensitive: false, resourceTypes: MAIN } });
      rules.push({ id: nextId(), priority, action: block, condition: { regexFilter: re, isUrlFilterCaseSensitive: false, resourceTypes: SUB } });
    }
    return rules;
  }

  function buildBlockRules(settings, { visorOrigin, blockedPage, research, canRedirect = true }) {
    const s = settings || {};
    const locked = s.mode === 'locked';
    const allowed = (s.allowedSites || []).map(splitEntry).filter(Boolean);
    const blocked = (s.blockedSites || []).map(splitEntry).filter(Boolean);
    const rules = [];
    let id = RULE_BASE;
    const nextId = () => id++;
    // (Without access to the pages, Chrome won't redirect them: block instead)
    const redirect = canRedirect === false ? { type: 'block' } : { type: 'redirect', redirect: { regexSubstitution: `${blockedPage}?u=\\0` } };
    // Research mode (side panel): the allowed list is set aside
    const listed = locked && allowed.length > 0 && !research;

    // Nothing to redirect: an open session that only flags AI sites, or a
    // locked one with no allowed list and "block AI sites" turned off
    if (!listed && !s.blockAiSites) return rules;

    // Always reachable: Visor itself and Google sign-in
    const allowHosts = ['accounts.google.com'];
    const vh = hostOfOrigin(visorOrigin);
    if (vh) allowHosts.push(vh);
    rules.push({ id: nextId(), priority: 2, action: { type: 'allow' }, condition: { requestDomains: allowHosts, resourceTypes: MAIN } });

    if (listed) {
      const hosts = allowed.filter((a) => !a.path).map((a) => a.host);
      if (hosts.length) rules.push({ id: nextId(), priority: 2, action: { type: 'allow' }, condition: { requestDomains: hosts, resourceTypes: MAIN } });
      for (const a of allowed.filter((x) => x.path)) rules.push({ id: nextId(), priority: 2, action: { type: 'allow' }, condition: { urlFilter: `||${a.host}${a.path}`, resourceTypes: MAIN } });
      // Everything else goes to the blocked page
      rules.push({ id: nextId(), priority: 1, action: redirect, condition: { regexFilter: '^https?://.*', resourceTypes: MAIN } });
      // AI sites stay blocked even inside an allowed domain (gemini.google.com
      // when google.com is allowed), above the allow rules
      if (s.blockAiSites) rules.push(...aiRedirectRules(blocked, redirect, 3, nextId));
      return rules;
    }
    // No allowed list, "block AI sites" on (locked or open): just the AI list
    rules.push(...aiRedirectRules(blocked, redirect, 1, nextId));
    return rules;
  }

  // The same decision for a page that's already open when the lock starts:
  // null when it may stay, else why it may not ('ai' or 'not-allowed').
  // opts.research: research mode, as in buildBlockRules.
  function blockedReason(url, settings, visorOrigin, opts) {
    const s = settings || {};
    const research = !!(opts && opts.research);
    let u;
    try { u = new URL(url); } catch (_) { return null; }
    if (!/^https?:$/.test(u.protocol)) return null;
    const host = u.hostname.toLowerCase(), path = u.pathname.toLowerCase();
    const under = (e) => (host === e.host || host.endsWith('.' + e.host)) && (!e.path || path === e.path || path.startsWith(e.path + '/'));
    const vh = hostOfOrigin(visorOrigin);
    if (host === 'accounts.google.com' || (vh && host === vh)) return null;
    const allowed = (s.allowedSites || []).map(splitEntry).filter(Boolean);
    const blocked = (s.blockedSites || []).map(splitEntry).filter(Boolean);
    if (s.blockAiSites && (blocked.some(under) || searchAiMatch(url))) return 'ai';
    if (s.mode === 'locked' && !research && allowed.length && !allowed.some(under)) return 'not-allowed';
    return null;
  }

  // Pages that aren't the web, which a locked session sends back to the Visor tab:
  // every browser page but a new tab, local files, page source, developer tools,
  // and other extensions' pages (never Visor's own)
  const BOUNCE = /^((chrome|edge|brave|opera|vivaldi):\/\/(?!new-?tab)|chrome-untrusted:|devtools:|view-source:|file:)/i;
  function shouldBounce(url, ownId) {
    const u = String(url || '');
    if (/^(chrome-extension|moz-extension):/i.test(u)) return !ownId || !u.includes(`://${ownId}/`);
    return BOUNCE.test(u);
  }

  const api = { RULE_BASE, SEARCH_AI, buildBlockRules, blockedReason, shouldBounce, splitEntry, searchAiMatch };
  root.VisorLockdown = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
