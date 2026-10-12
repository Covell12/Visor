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
 * Only top-level pages (main_frame) are redirected. The blocked page reads the
 * original address from everything after "?u=" (it isn't re-encoded, so the
 * original's own "?" and "&" survive).
 * ==========================================================================*/

'use strict';

(function (root) {
  const RULE_BASE = 9100;   // our dynamic rule ids: 9100 and up
  const MAIN = ['main_frame'];

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

  function aiRedirectRules(blocked, redirect, priority, nextId) {
    const rules = [];
    const hosts = blocked.filter((b) => !b.path).map((b) => b.host);
    if (hosts.length) rules.push({ id: nextId(), priority, action: redirect, condition: { regexFilter: '^https?://.*', requestDomains: hosts, resourceTypes: MAIN } });
    for (const b of blocked.filter((x) => x.path)) {
      const re = `^https?://([a-z0-9-]+\\.)*${b.host.replace(/\./g, '\\.')}${b.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([/?#].*)?$`;
      rules.push({ id: nextId(), priority, action: redirect, condition: { regexFilter: re, resourceTypes: MAIN } });
    }
    return rules;
  }

  function buildBlockRules(settings, { visorOrigin, blockedPage, research }) {
    const s = settings || {};
    const locked = s.mode === 'locked';
    const allowed = (s.allowedSites || []).map(splitEntry).filter(Boolean);
    const blocked = (s.blockedSites || []).map(splitEntry).filter(Boolean);
    const rules = [];
    let id = RULE_BASE;
    const nextId = () => id++;
    const redirect = { type: 'redirect', redirect: { regexSubstitution: `${blockedPage}?u=\\0` } };
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
    if (s.blockAiSites && blocked.some(under)) return 'ai';
    if (s.mode === 'locked' && !research && allowed.length && !allowed.some(under)) return 'not-allowed';
    return null;
  }

  // Browser pages a locked session sends back to the Visor tab
  const BOUNCE = /^(chrome|edge|brave|opera|vivaldi):\/\/(extensions|settings|flags|policy|management|history|downloads|net-internals|inspect)/i;
  function shouldBounce(url) { return BOUNCE.test(String(url || '')); }

  const api = { RULE_BASE, buildBlockRules, blockedReason, shouldBounce, splitEntry };
  root.VisorLockdown = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
