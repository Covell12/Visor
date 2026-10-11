/* ============================================================================
 * A tiny HTML reader for tests: just enough of a document for cite.js.
 * ----------------------------------------------------------------------------
 * querySelectorAll('meta' | 'link' | 'script') returns those elements with
 * getAttribute() and textContent; .title is the <title> text. Regex-based:
 * it reads well-formed fixture pages, not the web.
 * ==========================================================================*/

'use strict';

function parseAttrs(s) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(s))) attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return attrs;
}
const decode = (s) => String(s).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function el(tag, attrs, text = '') {
  return { tagName: tag.toUpperCase(), getAttribute: (k) => (k.toLowerCase() in attrs ? decode(attrs[k.toLowerCase()]) : null), textContent: text };
}

function parseHtml(html) {
  const byTag = { meta: [], link: [], script: [] };
  for (const m of html.matchAll(/<(meta|link)\b([^>]*)\/?>/gi)) byTag[m[1].toLowerCase()].push(el(m[1], parseAttrs(m[2])));
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) byTag.script.push(el('script', parseAttrs(m[1]), m[2]));
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return {
    title: t ? decode(t[1]).trim() : '',
    querySelectorAll(sel) {
      const tag = String(sel).toLowerCase();
      if (!byTag[tag]) throw new Error(`the test document only knows meta, link and script (asked for ${sel})`);
      return byTag[tag];
    }
  };
}

module.exports = { parseHtml };
