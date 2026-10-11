/* ============================================================================
 * Visor — Lockdown rules
 * ----------------------------------------------------------------------------
 * Pure functions (no chrome.* calls), used by session-bg.js and tested in node.
 *
 * buildBlockRules(settings, { visorOrigin, blockedPage }) returns the
 * declarativeNetRequest dynamic rules for a session:
 *
 *   locked, with allowed sites   allow (priority 2): Visor, the allowed sites,
 *                                accounts.google.com; redirect (priority 1):
 *                                every other page, to blocked.html?u=<url>
 *   locked, no allowed sites     allow Visor and accounts.google.com; redirect
 *   or open with "block AI"      only the sites on the AI list
 *   open, AI only flagged        no rules
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

  function buildBlockRules(settings, { visorOrigin, blockedPage }) {
    const s = settings || {};
    const locked = s.mode === 'locked';
    const allowed = (s.allowedSites || []).map(splitEntry).filter(Boolean);
    const blocked = (s.blockedSites || []).map(splitEntry).filter(Boolean);
    const rules = [];
    let id = RULE_BASE;
    const redirect = { type: 'redirect', redirect: { regexSubstitution: `${blockedPage}?u=\\0` } };

    if (!locked && !s.blockAiSites) return rules;

    // Always reachable: Visor itself and Google sign-in
    const allowHosts = ['accounts.google.com'];
    const vh = hostOfOrigin(visorOrigin);
    if (vh) allowHosts.push(vh);
    rules.push({ id: id++, priority: 2, action: { type: 'allow' }, condition: { requestDomains: allowHosts, resourceTypes: MAIN } });

    if (locked && allowed.length) {
      const hosts = allowed.filter((a) => !a.path).map((a) => a.host);
      if (hosts.length) rules.push({ id: id++, priority: 2, action: { type: 'allow' }, condition: { requestDomains: hosts, resourceTypes: MAIN } });
      for (const a of allowed.filter((x) => x.path)) rules.push({ id: id++, priority: 2, action: { type: 'allow' }, condition: { urlFilter: `||${a.host}${a.path}`, resourceTypes: MAIN } });
      // Everything else goes to the blocked page (AI sites included)
      rules.push({ id: id++, priority: 1, action: redirect, condition: { regexFilter: '^https?://.*', resourceTypes: MAIN } });
      return rules;
    }
    // Locked with no list, or open with "block AI sites": just the AI list
    const hosts = blocked.filter((b) => !b.path).map((b) => b.host);
    if (hosts.length) rules.push({ id: id++, priority: 1, action: redirect, condition: { regexFilter: '^https?://.*', requestDomains: hosts, resourceTypes: MAIN } });
    for (const b of blocked.filter((x) => x.path)) {
      const re = `^https?://([a-z0-9-]+\\.)*${b.host.replace(/\./g, '\\.')}${b.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([/?#].*)?$`;
      rules.push({ id: id++, priority: 1, action: redirect, condition: { regexFilter: re, resourceTypes: MAIN } });
    }
    return rules;
  }

  // Browser pages a locked session sends back to the Visor tab
  const BOUNCE = /^(chrome|edge|brave|opera|vivaldi):\/\/(extensions|settings|flags|policy|management|history|downloads|net-internals|inspect)/i;
  function shouldBounce(url) { return BOUNCE.test(String(url || '')); }

  const api = { RULE_BASE, buildBlockRules, shouldBounce, splitEntry };
  root.VisorLockdown = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
