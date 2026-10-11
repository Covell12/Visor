/* ============================================================================
 * Visor — Citation details from a web page
 * ----------------------------------------------------------------------------
 * extractCitationMeta(document, url) reads what a page says about itself and
 * returns { url, canonicalUrl, title, authors[], published, modified,
 * siteName, publisher, doi, journal, volume, issue, pages, type }.
 *
 * Sources, best first: Highwire citation_* tags (journals), JSON-LD, Dublin
 * Core, OpenGraph, <meta name="author">, <link rel="canonical">, then the
 * page title with the site name trimmed off. On YouTube the channel is the
 * author. Everything is trimmed and capped, and "authors" that are links or
 * email addresses are dropped.
 *
 * Formatting (MLA, APA, Chicago) happens in the Visor web app
 * (public/cite-format.js). This file runs in the page (injected by the
 * service worker, and with research-capture.js), and in node for the tests:
 * it only uses querySelectorAll('meta' | 'link' | 'script') and .title.
 * ==========================================================================*/

'use strict';

(function (root) {
  const CAP = { title: 300, author: 120, site: 150, field: 100, url: 2000 };
  const squash = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  const cap = (v, n) => { const s = squash(v); return s.length > n ? s.slice(0, n).trim() : s; };
  const isUrlOrEmail = (v) => /^(https?:)?\/\//i.test(v) || /^www\./i.test(v) || /\S+@\S+\.\S+/.test(v);

  function attr(el, name) { try { return el.getAttribute(name); } catch (_) { return null; } }
  function all(doc, tag) { try { return Array.from(doc.querySelectorAll(tag)); } catch (_) { return []; } }

  // Every <meta> as { key, content }, keyed by name, property or itemprop (lowercased)
  function metaList(doc) {
    const out = [];
    for (const m of all(doc, 'meta')) {
      const key = (attr(m, 'name') || attr(m, 'property') || attr(m, 'itemprop') || '').toLowerCase();
      const content = attr(m, 'content');
      if (key && content != null && squash(content)) out.push({ key, content: squash(content) });
    }
    return out;
  }
  const first = (metas, ...keys) => { for (const k of keys) { const m = metas.find((x) => x.key === k); if (m) return m.content; } return ''; };
  const every = (metas, key) => metas.filter((x) => x.key === key).map((x) => x.content);

  // "2021-03-04T10:00:00Z", "2021/03/04", "March 4, 2021" -> "2021-03-04"; "2021" stays "2021"
  function normDate(v) {
    const s = squash(v);
    if (!s) return '';
    if (/^\d{4}$/.test(s)) return s;
    const ymd = /^(\d{4})[-/](\d{1,2})(?:[-/](\d{1,2}))?/.exec(s);
    if (ymd) return ymd[3] ? `${ymd[1]}-${ymd[2].padStart(2, '0')}-${ymd[3].padStart(2, '0')}` : `${ymd[1]}-${ymd[2].padStart(2, '0')}`;
    const t = Date.parse(s);
    if (Number.isFinite(t)) { const d = new Date(t); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`; }
    return '';
  }

  function cleanAuthors(list) {
    const out = [];
    for (const raw of list) {
      for (const part of String(raw || '').split(/\s*;\s*/)) {
        let a = cap(part.replace(/^by\s+/i, ''), CAP.author);
        if (!a || isUrlOrEmail(a) || a.length < 2) continue;
        if (!out.some((x) => x.toLowerCase() === a.toLowerCase())) out.push(a);
      }
    }
    return out.slice(0, 20);
  }

  // JSON-LD: the first item of a type we cite, looking through @graph and arrays
  const LD_TYPES = { scholarlyarticle: 'journal', newsarticle: 'article', article: 'article', blogposting: 'article', reportagenewsarticle: 'article', videoobject: 'video', book: 'book', webpage: 'webpage' };
  function ldItems(doc) {
    const items = [];
    const walk = (x) => {
      if (!x || typeof x !== 'object') return;
      if (Array.isArray(x)) { x.forEach(walk); return; }
      if (x['@graph']) walk(x['@graph']);
      const types = [].concat(x['@type'] || []).map((t) => String(t).toLowerCase());
      if (types.some((t) => LD_TYPES[t])) items.push({ item: x, type: LD_TYPES[types.find((t) => LD_TYPES[t])] });
    };
    for (const s of all(doc, 'script')) {
      if ((attr(s, 'type') || '').toLowerCase() !== 'application/ld+json') continue;
      try { walk(JSON.parse(s.textContent || '')); } catch (_) { /* a broken block is skipped */ }
    }
    // An article beats the page it sits on
    items.sort((a, b) => (a.type === 'webpage') - (b.type === 'webpage'));
    return items[0] || null;
  }
  const ldName = (v) => (v == null ? '' : typeof v === 'string' ? v : Array.isArray(v) ? '' : v.name || '');
  const ldAuthors = (v) => [].concat(v || []).map((a) => (typeof a === 'string' ? a : a && a.name ? a.name : '')).filter(Boolean);

  // Trim " | Site", " - Site", " — Site" off a page title
  function stripSiteFromTitle(title, siteName) {
    const t = squash(title);
    if (!t) return '';
    const seps = [' | ', ' - ', ' — ', ' – ', ' :: ', ' · '];
    if (siteName) {
      for (const sep of seps) {
        if (t.toLowerCase().endsWith((sep + siteName).toLowerCase())) return t.slice(0, t.length - sep.length - siteName.length).trim();
        if (t.toLowerCase().startsWith((siteName + sep).toLowerCase())) return t.slice(siteName.length + sep.length).trim();
      }
    }
    for (const sep of seps) {
      const i = t.lastIndexOf(sep);
      if (i > 0 && t.length - i - sep.length <= 40 && i >= 12) return t.slice(0, i).trim();
    }
    return t;
  }

  function extractCitationMeta(doc, pageUrl) {
    const url = cap(pageUrl || '', CAP.url);
    let host = '';
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch (_) {}
    const metas = metaList(doc);
    const ld = ldItems(doc);
    const L = ld ? ld.item : {};
    const canonicalEl = all(doc, 'link').find((l) => (attr(l, 'rel') || '').toLowerCase().split(/\s+/).includes('canonical'));
    const canonicalUrl = canonicalEl ? cap(attr(canonicalEl, 'href'), CAP.url) : '';

    // Highwire (Google Scholar's tags; journals and many news sites)
    const hwTitle = first(metas, 'citation_title');
    const hwAuthors = every(metas, 'citation_author');
    const hwDate = first(metas, 'citation_publication_date', 'citation_date', 'citation_online_date', 'citation_cover_date');
    const journal = first(metas, 'citation_journal_title', 'citation_conference_title');
    const firstPage = first(metas, 'citation_firstpage'), lastPage = first(metas, 'citation_lastpage');

    const ogSite = first(metas, 'og:site_name');
    const ogType = first(metas, 'og:type').toLowerCase();
    const isYouTube = /(^|\.)youtube\.com$/.test(host) || host === 'youtu.be';

    // The channel on YouTube: <link itemprop="name" content="…"> inside the author
    const ytChannel = isYouTube ? (all(doc, 'link').map((l) => (attr(l, 'itemprop') === 'name' ? attr(l, 'content') : null)).find(Boolean) || first(metas, 'author')) : '';

    const siteName = cap(ogSite || (L.isPartOf && ldName(L.isPartOf)) || first(metas, 'application-name') || (isYouTube ? 'YouTube' : ''), CAP.site);
    const title = cap(hwTitle || L.headline || L.name || first(metas, 'dc.title', 'dcterms.title') || first(metas, 'og:title', 'twitter:title') || stripSiteFromTitle(doc.title, siteName), CAP.title);

    let authors = cleanAuthors(hwAuthors);
    if (!authors.length) authors = cleanAuthors(ldAuthors(L.author || L.creator));
    if (!authors.length) authors = cleanAuthors(every(metas, 'dc.creator').concat(every(metas, 'dcterms.creator')));
    if (!authors.length) authors = cleanAuthors(every(metas, 'article:author').filter((a) => !isUrlOrEmail(a)));
    if (!authors.length) authors = cleanAuthors(every(metas, 'author'));
    if (!authors.length && ytChannel) authors = cleanAuthors([ytChannel]);

    const published = normDate(hwDate || L.datePublished || L.uploadDate || first(metas, 'dc.date', 'dcterms.date', 'dcterms.issued') || first(metas, 'article:published_time', 'og:published_time', 'datepublished', 'uploaddate', 'date', 'pubdate'));
    const modified = normDate(L.dateModified || first(metas, 'article:modified_time', 'og:updated_time', 'dcterms.modified', 'datemodified'));
    const publisher = cap(first(metas, 'citation_publisher', 'dc.publisher', 'dcterms.publisher') || ldName(L.publisher) || '', CAP.site);
    let doi = first(metas, 'citation_doi', 'dc.identifier', 'prism.doi') || '';
    const doiMatch = /10\.\d{4,9}\/[^\s"<>]+/.exec(doi);
    doi = doiMatch ? doiMatch[0].replace(/[.,;]$/, '') : '';

    let type = 'webpage';
    if (journal || (ld && ld.type === 'journal')) type = 'journal';
    else if (isYouTube || (ld && ld.type === 'video') || ogType.startsWith('video')) type = 'video';
    else if ((ld && ld.type === 'book') || ogType === 'book') type = 'book';
    else if ((ld && ld.type === 'article') || ogType === 'article' || hwTitle) type = 'article';

    return {
      url, canonicalUrl, title, authors, published, modified, siteName, publisher, doi,
      journal: cap(journal, CAP.site), volume: cap(first(metas, 'citation_volume', 'prism.volume'), CAP.field), issue: cap(first(metas, 'citation_issue', 'prism.number'), CAP.field),
      pages: cap(firstPage && lastPage ? `${firstPage}-${lastPage}` : firstPage, CAP.field), type
    };
  }

  const api = { extractCitationMeta, stripSiteFromTitle, normDate };
  root.VisorCite = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
