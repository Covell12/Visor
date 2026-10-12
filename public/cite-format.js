/* Visor — citation formatting: MLA 9, APA 7, Chicago (notes-bibliography
   entries, author-date for in-text). Turns the page details the extension's
   cite button reads (extension/cite.js) into a Works Cited / References /
   Bibliography entry and an in-text citation.

   One file, two places: the browser loads public/cite-format.js; the server
   requires lib/cite.js, an identical copy kept in step by
   `npm run sync-engine` (test/cite.test.js checks they match). Edit
   public/cite-format.js, then run the sync.

   format(meta, style, { accessed }) -> { text, html, inText, sortKey, check }
     text   the entry as plain text
     html   the same with <i> where the style italicizes
     inText "(Lopez)", "(Lopez & Brooks, 2023)", "(Lopez 2023)"…
     check  what's missing that a student should look up ("no author found")

   A written source (type 'written') is one the student wrote or pasted
   whole: { written, inTextWritten }. Its entry is their text as it is, with
   *asterisks* around words for italics. */

(function (root) {
  'use strict';

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const MLA_MONTHS = ['Jan.', 'Feb.', 'Mar.', 'Apr.', 'May', 'June', 'July', 'Aug.', 'Sept.', 'Oct.', 'Nov.', 'Dec.'];
  const ORG_WORDS = /\b(center|centre|institute|university|college|association|department|organization|organisation|agency|foundation|society|council|committee|ministry|office|bureau|news|inc|ltd|llc|corporation|company|press|group|network|board|service|services|team|staff|editors|editorial)\b/i;
  const PARTICLES = ['van', 'von', 'de', 'der', 'den', 'del', 'della', 'da', 'di', 'du', 'la', 'le', 'st.', 'bin', 'al'];
  const SUFFIX = /^(jr\.?|sr\.?|ii|iii|iv)$/i;

  const squash = v => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const endsPunct = s => /[.?!]["”’]?$/.test(s);
  const dot = s => (endsPunct(s) ? s : s + '.');

  // "Kyla L. Wahlstrom" / "Wahlstrom, Kyla L." / "World Health Organization"
  function parseName(raw) {
    const s = squash(raw);
    if (!s) return null;
    if (s.includes(',')) {
      const [last, ...rest] = s.split(',');
      const first = squash(rest.join(','));
      if (first && !SUFFIX.test(first)) return { last: squash(last), first };
    }
    const words = s.split(' ');
    if (words.length === 1) return { last: s, first: '', single: true };
    if (words.length > 4 || ORG_WORDS.test(s)) return { org: s };
    let suffix = '';
    if (SUFFIX.test(words[words.length - 1])) suffix = words.pop();
    let i = words.length - 1;
    while (i > 1 && PARTICLES.includes(words[i - 1].toLowerCase())) i--;
    return { last: words.slice(i).join(' '), first: words.slice(0, i).join(' '), suffix };
  }
  const fullName = n => (n.org ? n.org : squash(`${n.first} ${n.last}${n.suffix ? ', ' + n.suffix : ''}`));
  const invName = n => (n.org ? n.org : n.first ? `${n.last}, ${n.first}${n.suffix ? ', ' + n.suffix : ''}` : n.last);
  const initials = first => first.split(/\s+/).filter(Boolean).map(w => w.split('-').map(p => (/^[A-Za-z]\.$/.test(p) ? p : p[0].toUpperCase() + '.')).join('-')).join(' ');
  const apaName = n => (n.org ? n.org : n.first ? `${n.last}, ${initials(n.first)}${n.suffix ? ', ' + n.suffix : ''}` : n.last);
  const lastOf = n => (n.org ? n.org : n.last);

  // "2017", "2017-06", "2017-06-15" -> { y, m, d } (no time zones involved)
  function parseDate(s) {
    const m = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?/.exec(squash(s));
    if (!m) return null;
    return { y: Number(m[1]), m: m[2] ? Number(m[2]) : null, d: m[3] ? Number(m[3]) : null };
  }
  function toDate(v) {
    if (!v) return null;
    if (typeof v === 'string' && /^\d{4}(-\d{1,2}){0,2}$/.test(v)) return parseDate(v);
    const t = v instanceof Date ? v : new Date(v);
    if (!Number.isFinite(t.getTime())) return null;
    return { y: t.getFullYear(), m: t.getMonth() + 1, d: t.getDate() };
  }
  const mlaDate = d => [d.d, d.m ? MLA_MONTHS[d.m - 1] : null, d.y].filter(x => x != null).join(' ');
  const longDate = d => (d.m ? `${MONTHS[d.m - 1]}${d.d ? ' ' + d.d : ''}, ${d.y}` : String(d.y));
  const apaDate = d => (d.m ? `${d.y}, ${MONTHS[d.m - 1]}${d.d ? ' ' + d.d : ''}` : String(d.y));

  // "627-633" -> "627-33" (MLA and Chicago shorten the second number)
  function shortRange(p) {
    const m = /^(\d+)\s*[-–]\s*(\d+)$/.exec(squash(p));
    if (!m) return squash(p);
    const [a, b] = [m[1], m[2]];
    if (a.length !== b.length || a.length < 3) return `${a}-${b}`;
    let i = 0;
    while (i < a.length - 2 && a[i] === b[i]) i++;
    return `${a}-${b.slice(i)}`;
  }
  const noProtocol = u => String(u || '').replace(/^https?:\/\//, '');
  const doiUrl = doi => (doi ? `https://doi.org/${doi}` : '');
  // In-text title: the whole title up to a colon if it's short, else its first four words
  const shortTitle = t => {
    const main = squash(t).replace(/\s*[:;].*$/, '').replace(/\.$/, '');
    const w = main.split(' ');
    return w.length <= 6 ? main : w.slice(0, 4).join(' ').replace(/[,.]$/, '');
  };
  const sameText = (a, b) => !!a && !!b && squash(a).toLowerCase() === squash(b).toLowerCase();

  // Pieces are [text, italic?]; joined into plain text and HTML together
  function build(parts) {
    const text = parts.map(p => p[0]).join('');
    const html = parts.map(p => (p[1] ? `<i>${esc(p[0])}</i>` : esc(p[0]))).join('');
    return { text: text.replace(/\s+/g, ' ').trim(), html: html.replace(/\s+/g, ' ').trim() };
  }

  function prepare(meta) {
    const m = meta || {};
    // A video's "author" is its channel: a name to keep as it is, not a person's to invert
    const names = (Array.isArray(m.authors) ? m.authors : []).map(a => (m.type === 'video' && squash(a) ? { org: squash(a) } : parseName(a))).filter(Boolean);
    return {
      names, title: squash(m.title), site: squash(m.siteName), publisher: squash(m.publisher),
      url: squash(m.canonicalUrl || m.url), doi: squash(m.doi), journal: squash(m.journal), volume: squash(m.volume), issue: squash(m.issue), pages: squash(m.pages),
      type: m.type || 'webpage', date: toDate(m.published)
    };
  }

  /* ---------------- MLA 9 ---------------- */
  function mlaAuthors(names) {
    if (!names.length) return '';
    if (names.length === 1) return invName(names[0]);
    if (names.length === 2) return `${invName(names[0])}, and ${fullName(names[1])}`;
    return `${invName(names[0])}, et al`;
  }
  function mla(p, accessed) {
    const parts = [];
    const au = mlaAuthors(p.names);
    if (au) parts.push([dot(au) + ' ']);
    if (p.type === 'book') {
      parts.push([dot(p.title), true], [' ']);
      const tail = [p.publisher, p.date ? String(p.date.y) : ''].filter(Boolean).join(', ');
      if (tail) parts.push([dot(tail)]);
      return build(parts);
    }
    parts.push([`“${dot(p.title)}” `]);
    if (p.type === 'journal') {
      const bits = [];
      if (p.journal) bits.push([p.journal, true]);
      if (p.volume) bits.push([`vol. ${p.volume}`]);
      if (p.issue) bits.push([`no. ${p.issue}`]);
      if (p.date) bits.push([String(p.date.y)]);
      if (p.pages) bits.push([`${/[-–]/.test(p.pages) ? 'pp.' : 'p.'} ${shortRange(p.pages)}`]);
      bits.forEach((b, i) => { parts.push(b); parts.push([i < bits.length - 1 ? ', ' : '. ']); });
      if (p.doi) parts.push([`${doiUrl(p.doi)}.`]);
      else if (p.url) parts.push([`${noProtocol(p.url)}. Accessed ${mlaDate(accessed)}.`]);
      return build(parts);
    }
    const bits = [];
    if (p.site) bits.push([p.site, true]);
    if (p.publisher && !sameText(p.publisher, p.site) && !(p.names.length === 1 && sameText(p.publisher, fullName(p.names[0])))) bits.push([p.publisher]);
    if (p.date) bits.push([mlaDate(p.date)]);
    if (p.url) bits.push([noProtocol(p.url)]);
    bits.forEach((b, i) => { parts.push(b); parts.push([i < bits.length - 1 ? ', ' : '. ']); });
    parts.push([`Accessed ${mlaDate(accessed)}.`]);
    return build(parts);
  }
  function mlaInText(p) {
    const n = p.names;
    if (!n.length) return `(“${shortTitle(p.title)}”)`;
    if (n.length === 1) return `(${lastOf(n[0])})`;
    if (n.length === 2) return `(${lastOf(n[0])} and ${lastOf(n[1])})`;
    return `(${lastOf(n[0])} et al.)`;
  }

  /* ---------------- APA 7 ---------------- */
  function apaAuthors(names) {
    const list = names.map(apaName);
    if (!list.length) return '';
    if (list.length === 1) return list[0];
    if (list.length <= 20) return `${list.slice(0, -1).join(', ')}, & ${list[list.length - 1]}`;
    return `${list.slice(0, 19).join(', ')}, . . . ${list[list.length - 1]}`;
  }
  function apa(p) {
    const parts = [];
    const au = apaAuthors(p.names);
    const when = p.type === 'journal' || p.type === 'book' ? (p.date ? String(p.date.y) : 'n.d.') : (p.date ? apaDate(p.date) : 'n.d.');
    const titleItalic = p.type !== 'journal';
    const label = p.type === 'video' ? ' [Video]' : '';
    if (au) {
      parts.push([dot(au) + ' '], [`(${when}). `]);
      parts.push([p.title, titleItalic], [label], [endsPunct(p.title) && !label ? ' ' : '. ']);
    } else {
      // No author: the title moves to the front
      parts.push([p.title, titleItalic], [label], [endsPunct(p.title) && !label ? ' ' : '. '], [`(${when}). `]);
    }
    if (p.type === 'journal') {
      if (p.journal) {
        parts.push([p.journal, true]);
        if (p.volume) parts.push([', '], [p.volume, true]);
        if (p.issue) parts.push([`(${p.issue})`]);
        if (p.pages) parts.push([`, ${p.pages.replace(/\s*[-–]\s*/, '–')}`]);
        parts.push(['. ']);
      }
      if (p.doi) parts.push([doiUrl(p.doi)]);
      else if (p.url) parts.push([p.url]);
      return build(parts);
    }
    if (p.type === 'book') { if (p.publisher) parts.push([dot(p.publisher)]); return build(parts); }
    // The site is left out when it's also the author
    if (p.site && !(p.names.length === 1 && sameText(p.site, fullName(p.names[0])))) parts.push([dot(p.site) + ' ']);
    if (p.url) parts.push([p.url]);
    return build(parts);
  }
  function apaInText(p) {
    const n = p.names, y = p.date ? String(p.date.y) : 'n.d.';
    if (!n.length) return `(${shortTitle(p.title)}, ${y})`;
    if (n.length === 1) return `(${lastOf(n[0])}, ${y})`;
    if (n.length === 2) return `(${lastOf(n[0])} & ${lastOf(n[1])}, ${y})`;
    return `(${lastOf(n[0])} et al., ${y})`;
  }

  /* ---------------- Chicago (bibliography; author-date in text) ---------------- */
  function chicagoAuthors(names) {
    if (!names.length) return '';
    const list = names.length > 10 ? names.slice(0, 7) : names;
    const shown = list.map((n, i) => (i === 0 ? invName(n) : fullName(n)));
    let s;
    if (shown.length === 1) s = shown[0];
    else if (shown.length === 2) s = `${shown[0]}, and ${shown[1]}`;
    else s = `${shown.slice(0, -1).join(', ')}, and ${shown[shown.length - 1]}`;
    if (names.length > 10) s = `${shown.join(', ')}, et al`;
    return s;
  }
  function chicago(p, accessed) {
    const parts = [];
    const au = chicagoAuthors(p.names);
    if (au) parts.push([dot(au) + ' ']);
    if (p.type === 'book') {
      parts.push([dot(p.title), true], [' ']);
      const tail = [p.publisher, p.date ? String(p.date.y) : ''].filter(Boolean).join(', ');
      if (tail) parts.push([dot(tail)]);
      return build(parts);
    }
    parts.push([`“${dot(p.title)}” `]);
    if (p.type === 'journal') {
      if (p.journal) parts.push([p.journal, true]);
      if (p.volume) parts.push([` ${p.volume}`]);
      if (p.issue) parts.push([`, no. ${p.issue}`]);
      if (p.date) parts.push([` (${p.date.y})`]);
      parts.push([p.pages ? `: ${shortRange(p.pages).replace('-', '–')}. ` : '. ']);
      if (p.doi) parts.push([`${doiUrl(p.doi)}.`]);
      else if (p.url) parts.push([`${p.url}.`]);
      return build(parts);
    }
    if (p.site) parts.push([dot(p.site) + ' ']);
    const pubDate = [p.publisher && !sameText(p.publisher, p.site) ? p.publisher : '', p.date ? longDate(p.date) : ''].filter(Boolean).join(', ');
    if (pubDate) parts.push([dot(pubDate) + ' ']);
    else parts.push([`Accessed ${longDate(accessed)}. `]);
    if (p.url) parts.push([`${p.url}.`]);
    return build(parts);
  }
  function chicagoInText(p) {
    const n = p.names, y = p.date ? String(p.date.y) : 'n.d.';
    if (!n.length) return `(“${shortTitle(p.title)}” ${y})`;
    if (n.length === 1) return `(${lastOf(n[0])} ${y})`;
    if (n.length === 2) return `(${lastOf(n[0])} and ${lastOf(n[1])} ${y})`;
    if (n.length === 3) return `(${lastOf(n[0])}, ${lastOf(n[1])}, and ${lastOf(n[2])} ${y})`;
    return `(${lastOf(n[0])} et al. ${y})`;
  }

  const STYLES = { mla: { entry: mla, inText: mlaInText, heading: 'Works Cited' }, apa: { entry: apa, inText: apaInText, heading: 'References' }, chicago: { entry: chicago, inText: chicagoInText, heading: 'Bibliography' } };
  const sortKeyOf = text => text.replace(/^[“"]/, '').replace(/^(the|a|an)\s+/i, '').toLowerCase();

  /* ---------------- Written by the student ---------------- */
  // *words* in asterisks are italic: <i>words</i> in the HTML, plain words in
  // the text. A lone asterisk, or one with a space inside it ("5 * 3"), stays.
  const ITALIC = /\*(?=[^*\s])([^*]*[^*\s])\*/g;
  function written(m, style) {
    const raw = squash(m.written);
    const text = raw.replace(ITALIC, '$1');
    const html = esc(raw).replace(ITALIC, '<i>$1</i>');
    // A best guess at the in-text citation: the first word before the first
    // comma or period ("Smith, John." -> Smith), and in APA the year in
    // parentheses ("(2021)", "(2021, March 3)") or n.d.
    const head = text.split(/[,.]/)[0].trim().split(' ')[0] || '';
    const word = head.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').replace(/[^\p{L}\p{N}'’-]/gu, '') || 'Untitled';
    const year = /\((\d{4})[a-z]?(?=[,)\s])/.exec(text);
    const guess = style === 'apa' ? `(${word}, ${year ? year[1] : 'n.d.'})` : `(${word})`;
    return { text, html, inText: squash(m.inTextWritten) || guess, sortKey: sortKeyOf(text), check: [] };
  }

  function format(meta, style = 'mla', opts = {}) {
    const S = STYLES[style] || STYLES.mla;
    if (meta && meta.type === 'written') return written(meta, STYLES[style] ? style : 'mla');
    const p = prepare(meta);
    if (!p.title) p.title = p.site || noProtocol(p.url) || 'Untitled';
    const accessed = toDate(opts.accessed || meta.accessed) || toDate(new Date());
    const { text, html } = S.entry(p, accessed);
    const check = [];
    if (!p.names.length) check.push('no author found');
    if (!p.date) check.push('no date found');
    return { text, html, inText: S.inText(p), sortKey: sortKeyOf(text), check };
  }

  // A list of sources as Works Cited / References / Bibliography, sorted
  function bibliography(sources, style = 'mla') {
    const S = STYLES[style] || STYLES.mla;
    const items = (sources || []).map(s => ({ source: s, ...format(s, style, { accessed: s.accessed }) })).sort((a, b) => a.sortKey.localeCompare(b.sortKey));
    return { heading: S.heading, items };
  }

  const api = { format, bibliography, parseName, shortTitle, STYLES: Object.keys(STYLES), headingFor: style => (STYLES[style] || STYLES.mla).heading };
  root.VisorCiteFormat = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
