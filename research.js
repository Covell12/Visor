/* ============================================================================
 * Visor — Research parsing
 * ----------------------------------------------------------------------------
 * Pure functions, no chrome.* calls: the service worker uses them while a
 * session records research, and tests/test-research-parse.js runs them in node.
 *
 *   parseSearch(url)           -> { engine, query } | null
 *   siteMatch(url, list)       -> the list entry a URL falls under, or null
 *   isRecordable(url, origins) -> false for browser pages and Visor itself
 * ==========================================================================*/

'use strict';

(function (root) {
  const clean = (q) => String(q || '').replace(/\s+/g, ' ').trim().slice(0, 500);

  function host(u) { return u.hostname.toLowerCase().replace(/^www\./, ''); }
  const is = (h, base) => h === base || h.endsWith('.' + base);

  /**
   * The search a URL is, if any. Covers the engines a student is likely to
   * use for research, plus YouTube and Wikipedia's own search.
   */
  function parseSearch(raw) {
    let u;
    try { u = new URL(raw); } catch (_) { return null; }
    if (!/^https?:$/.test(u.protocol)) return null;
    const h = host(u), p = u.pathname, q = (k) => u.searchParams.get(k);
    const hit = (engine, query) => {
      const c = clean(query);
      return c ? { engine, query: c } : null;
    };

    // Google Scholar before Google: scholar.google.<anything>/scholar?q=
    if (/^scholar\.google\./.test(h) && /^\/scholar/.test(p)) return hit('scholar', q('q'));
    // Google, any country: google.com/search?q=, google.co.uk/search?q=… (tbm = images, news… still a search)
    if (/^google\.[a-z.]+$/.test(h) && p === '/search') return hit('google', q('q'));
    if (is(h, 'bing.com') && p === '/search') return hit('bing', q('q'));
    if (is(h, 'duckduckgo.com') && (p === '/' || p === '' || p === '/html' || p === '/html/' || p === '/lite' || p === '/lite/')) return hit('duckduckgo', q('q'));
    if (is(h, 'search.yahoo.com') && /^\/search/.test(p)) return hit('yahoo', q('p'));
    if (is(h, 'youtube.com') && p === '/results') return hit('youtube', q('search_query'));
    if (/(^|\.)wikipedia\.org$/.test(h)) {
      if (p === '/w/index.php' && q('search')) return hit('wikipedia', q('search'));
      const special = /^\/wiki\/Special:Search(?:\/(.+))?$/.exec(p);
      if (special) return hit('wikipedia', q('search') || (special[1] ? decodeURIComponent(special[1]).replace(/_/g, ' ') : ''));
      return null;
    }
    if (is(h, 'ecosia.org') && p === '/search') return hit('ecosia', q('q'));
    if (h === 'search.brave.com' && p === '/search') return hit('brave', q('q'));
    if (is(h, 'perplexity.ai')) {
      if (p === '/search' || p === '/search/') return hit('perplexity', q('q'));
      // The path form: perplexity.ai/search/<words-and-an-id>
      const m = /^\/search\/(.+)$/.exec(p);
      if (m) return hit('perplexity', q('q') || decodeURIComponent(m[1]).replace(/-[A-Za-z0-9_.]{6,}$/, '').replace(/[-_]+/g, ' '));
    }
    return null;
  }

  /**
   * Does a URL fall under any entry of a site list? Entries are hostnames
   * (matching their subdomains too) or host + path prefix, as in
   * web-app/lib/sites.js: "openai.com" matches chat.openai.com,
   * "huggingface.co/chat" matches huggingface.co/chat/abc.
   */
  function siteMatch(raw, list) {
    let u;
    try { u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`); } catch (_) { return null; }
    const h = u.hostname.toLowerCase(), path = u.pathname.toLowerCase();
    for (const entry of list || []) {
      const e = String(entry || '').toLowerCase();
      if (!e) continue;
      const slash = e.indexOf('/');
      const eh = slash < 0 ? e : e.slice(0, slash);
      const ep = slash < 0 ? '' : e.slice(slash);
      if ((h === eh || h.endsWith('.' + eh)) && (!ep || path === ep || path.startsWith(ep + '/'))) return entry;
    }
    return null;
  }

  // Browser pages, new tabs, extension pages and Visor itself are never research
  function isRecordable(raw, visorOrigins) {
    let u;
    try { u = new URL(raw); } catch (_) { return false; }
    if (!/^https?:$/.test(u.protocol)) return false;
    if ((visorOrigins || []).includes(u.origin)) return false;
    if (/^(www\.)?google\.[a-z.]+$/.test(u.hostname) && (u.pathname === '/_/chrome/newtab' || u.pathname === '/webhp' && !u.search)) return false;
    return true;
  }

  const api = { parseSearch, siteMatch, isRecordable };
  root.VisorResearch = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
