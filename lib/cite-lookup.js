// The citation lookup: a link, a DOI or an ISBN in, a source's details out,
// like the citation tool in Google Docs. The editor fills its form from the
// result; nothing here is saved.
//
//   lookup(query, opts) -> { source, found, missing, via }
//     source   the fields cleanSource takes: type, title, authors[] ("Given
//              Family"), siteName, publisher, published, url, canonicalUrl,
//              doi, journal, volume, issue, pages
//     found    which of title, authors, published and siteName it filled in,
//     missing  and which it couldn't (a book has publisher in place of
//              siteName, a journal article has journal)
//     via      'page', 'doi' or 'isbn'
//   It fails with a LookupError (status + message the route sends as is).
//
// DOIs go to Crossref, ISBNs to Open Library, and links are fetched and read
// with parseHtml. Fetching addresses that people type is an SSRF risk, so
// every request goes through safeGet: http and https only, ports 80 and 443,
// no credentials in the URL, redirects followed by hand (4 at most, each one
// checked again), 7 seconds and 1.5 MB at most, and a DNS lookup at connect
// time that refuses private, loopback, link-local and similar addresses.
// Checking at connect time (not before) means a name can't pass the check
// and then resolve somewhere else (DNS rebinding). opts.allowPrivate turns
// the address and port checks off; it's for tests only.
'use strict';
const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const zlib = require('zlib');

const LIMITS = { TIMEOUT_MS: 7000, MAX_BYTES: 1.5 * 1024 * 1024, REDIRECTS: 4, QUERY: 2000, AUTHORS: 20, BOOK_AUTHORS: 5 };
const PAGE_UA = 'Mozilla/5.0 (compatible; VisorCitation/1.0)';
const API_UA = 'VisorClassroom/7 (mailto:support@visor.invalid)';
const HTML_TYPES = /^\s*(text\/html|application\/xhtml\+xml)\s*(;|$)/i;

const MESSAGES = {
  query: 'Paste a link, a DOI or an ISBN.',
  isbn: 'That ISBN isn’t valid.',
  doiNotFound: 'Nothing was found for that DOI.',
  isbnNotFound: 'Nothing was found for that ISBN.',
  page: 'Visor couldn’t read that page. Fill in the details yourself.'
};

// status and message are what the student sees; reason is for logs and tests
class LookupError extends Error {
  constructor(status, message, reason) { super(message); this.status = status; this.reason = reason || message; }
}
const unreadable = reason => new LookupError(422, MESSAGES.page, reason);

const squash = v => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const sameText = (a, b) => !!a && !!b && squash(a).toLowerCase() === squash(b).toLowerCase();

/* ---------------- Addresses that may not be fetched ---------------- */

function v4parts(ip) {
  const p = String(ip).split('.');
  if (p.length !== 4 || !p.every(x => /^\d{1,3}$/.test(x))) return null;
  const n = p.map(Number);
  return n.every(x => x <= 255) ? n : null;
}
function isPrivateV4(ip) {
  const p = v4parts(ip);
  if (!p) return true;
  const [a, b, c] = p;
  return a === 0 || a === 10 || a === 127 || a >= 224              // "this network", private, loopback, multicast, reserved, broadcast
    || (a === 100 && b >= 64 && b <= 127)                            // CGNAT (100.64/10)
    || (a === 169 && b === 254)                                      // link-local, cloud metadata (169.254.169.254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) // private
    || (a === 192 && b === 0 && (c === 0 || c === 2))                // IETF assignments, TEST-NET-1
    || (a === 198 && (b === 18 || b === 19))                         // benchmarking
    || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113); // TEST-NET-2 and 3
}
// "::ffff:127.0.0.1" -> eight 16-bit numbers, or null if it isn't IPv6
function v6groups(ip) {
  let s = String(ip).toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    const p = v4parts(tail[1]);
    if (!p) return null;
    s = s.slice(0, -tail[1].length) + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0) return null;
  const all = [...head, ...Array(fill).fill('0'), ...rest];
  if (all.length !== 8 || !all.every(g => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return all.map(g => parseInt(g, 16));
}
function isPrivateV6(ip) {
  const g = v6groups(ip);
  if (!g) return true;
  const zeros = n => g.slice(0, n).every(x => x === 0);
  const v4 = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  if (zeros(8) || (zeros(7) && g[7] === 1)) return true;                                     // :: unspecified, ::1 loopback
  if (zeros(5) && g[5] === 0xffff) return isPrivateV4(v4(g[6], g[7]));                       // ::ffff:a.b.c.d, IPv4-mapped
  if (zeros(4) && g[4] === 0xffff && g[5] === 0) return isPrivateV4(v4(g[6], g[7]));         // ::ffff:0:a.b.c.d, IPv4-translated
  if (zeros(6)) return isPrivateV4(v4(g[6], g[7]));                                          // ::a.b.c.d, IPv4-compatible
  if (g[0] === 0x64 && g[1] === 0xff9b) return g[2] + g[3] + g[4] + g[5] !== 0 || isPrivateV4(v4(g[6], g[7])); // NAT64
  if (g[0] === 0x2002) return isPrivateV4(v4(g[1], g[2]));                                   // 6to4
  return (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0                            // link-local, old site-local
    || (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xff00) === 0xff00                              // unique-local, multicast
    || (g[0] === 0x2001 && g[1] === 0x0db8) || (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0); // documentation, discard
}
// True for any address Visor mustn't fetch from (and for anything that isn't an address)
function isPrivate(ip) {
  const s = String(ip || '').replace(/^\[|\]$/g, '');
  const kind = net.isIP(s);
  return kind === 4 ? isPrivateV4(s) : kind === 6 ? isPrivateV6(s) : true;
}

// The `lookup` option for http(s).request: resolves every address for the
// name and refuses the connection if any of them is private. Node calls it
// with { all: true } (wanting a list) or without (wanting one address).
function safeLookup(allowPrivate = false) {
  return function lookup(hostname, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    const o = typeof options === 'number' ? { family: options } : options || {};
    dns.lookup(hostname, { all: true, family: o.family || 0, hints: o.hints || 0 }, (err, list) => {
      if (err) return callback(err);
      const addrs = (list || []).filter(a => a && a.address);
      if (!addrs.length) return callback(Object.assign(new Error(`No address for ${hostname}`), { code: 'ENOTFOUND' }));
      if (!allowPrivate && addrs.some(a => isPrivate(a.address))) return callback(Object.assign(new Error(`${hostname} is a private address`), { code: 'EBLOCKED' }));
      if (o.all) return callback(null, addrs);
      callback(null, addrs[0].address, addrs[0].family);
    });
  };
}

// What may be fetched at all, checked before every request (redirects too).
// Node doesn't call `lookup` for an address typed as numbers, so those are
// checked here.
function checkUrl(raw, allowPrivate = false) {
  let u;
  try { u = new URL(raw); } catch { throw unreadable('not a URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw unreadable(`scheme ${u.protocol}`);
  if (u.username || u.password) throw unreadable('credentials in the URL');
  if (!allowPrivate && u.port && u.port !== '80' && u.port !== '443') throw unreadable(`port ${u.port}`);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw unreadable('no host');
  if (!allowPrivate && net.isIP(host) && isPrivate(host)) throw unreadable('private address');
  return u;
}

/* ---------------- Fetching ---------------- */

// One request, no redirects followed. Resolves { status, headers, url,
// redirect } or { status, headers, url, body }; the body only for a 2xx, and
// cut at maxBytes (what arrived before that is kept).
function requestOnce(u, o) {
  return new Promise((resolve, reject) => {
    const left = o.deadline - Date.now();
    if (left <= 0) return reject(unreadable('timed out'));
    let done = false;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve(val);
    };
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { method: 'GET', headers: o.headers, lookup: safeLookup(o.allowPrivate), agent: false }, res => {
      const status = res.statusCode;
      const base = { status, headers: res.headers, url: u.href };
      res.on('error', () => {});
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
        finish(null, { ...base, redirect: String(res.headers.location) });
        return req.destroy();
      }
      if (status < 200 || status >= 300) { finish(null, base); return req.destroy(); }
      if (o.types && !o.types.test(String(res.headers['content-type'] || ''))) {
        finish(unreadable(`content type ${res.headers['content-type'] || 'missing'}`));
        return req.destroy();
      }
      // gzip, deflate and br are decoded; a cut-off stream keeps what decoded
      const enc = String(res.headers['content-encoding'] || '').trim().toLowerCase();
      const flush = { finishFlush: zlib.constants.Z_SYNC_FLUSH };
      const unzip = enc === 'gzip' || enc === 'x-gzip' ? zlib.createGunzip(flush)
        : enc === 'deflate' ? zlib.createInflate(flush)
        : enc === 'br' ? zlib.createBrotliDecompress({ finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH }) : null;
      const stream = unzip ? res.pipe(unzip) : res;
      const chunks = [];
      let size = 0;
      const end = () => finish(null, { ...base, body: Buffer.concat(chunks) });
      stream.on('data', c => {
        if (done) return;
        const room = o.maxBytes - size;
        if (c.length >= room) {
          chunks.push(c.subarray(0, room)); size += room;
          end();
          if (unzip) unzip.destroy();
          req.destroy();
          return;
        }
        chunks.push(c); size += c.length;
      });
      stream.on('end', end);
      stream.on('error', () => (size ? end() : finish(unreadable('the response could not be decoded'))));
      res.on('close', () => { if (!res.complete) setImmediate(() => (size ? end() : finish(unreadable('the connection closed')))); });
    });
    const timer = setTimeout(() => { finish(unreadable('timed out')); req.destroy(); }, left);
    req.on('error', e => finish(unreadable(e.code === 'EBLOCKED' ? 'private address' : e.code || e.message)));
    req.end();
  });
}

// GET a URL safely (see the top of the file), following up to 4 redirects.
// opts: { allowPrivate, deadline | timeoutMs, headers, types, maxBytes }
async function safeGet(url, opts = {}) {
  const o = {
    allowPrivate: !!opts.allowPrivate,
    deadline: opts.deadline || Date.now() + (opts.timeoutMs || LIMITS.TIMEOUT_MS),
    headers: opts.headers || {},
    types: opts.types || null,
    maxBytes: opts.maxBytes || LIMITS.MAX_BYTES
  };
  let u = checkUrl(url, o.allowPrivate);
  for (let hop = 0; ; hop++) {
    const r = await requestOnce(u, o);
    if (r.redirect === undefined) return r;
    if (hop >= LIMITS.REDIRECTS) throw unreadable('too many redirects');
    let next;
    try { next = new URL(r.redirect, u); } catch { throw unreadable('a bad redirect'); }
    u = checkUrl(next.href, o.allowPrivate);
  }
}

// Windows-1252's 0x80-0x9F (’ is 0x92). Pages labelled Latin-1 mean this too.
const CP1252 = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F\u0090‘’“”•–—˜™š›œ\u009DžŸ';
const LATIN1 = /^(windows-1252|cp1252|x-cp1252|iso-8859-1|iso8859-1|iso_8859-1|latin1|l1|us-ascii|ascii)$/i;

// Bytes to text: the charset from the header, or a <meta charset> near the
// top, or UTF-8. (Node's TextDecoder reads windows-1252 as plain Latin-1, so
// that one is done by hand.)
function decodeBody(buf, contentType) {
  let cs = (/charset\s*=\s*["']?([\w.:-]+)/i.exec(String(contentType || '')) || [])[1];
  if (!cs) cs = (/<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(buf.subarray(0, 4096).toString('latin1')) || [])[1];
  if (cs && LATIN1.test(cs)) return buf.toString('latin1').replace(/[\x80-\x9f]/g, c => CP1252[c.charCodeAt(0) - 0x80]);
  try { return new TextDecoder(cs || 'utf-8').decode(buf); } catch { return buf.toString('utf8'); }
}

const ok = r => r.status >= 200 && r.status < 300;
// JSON from Crossref or Open Library: the data, or null for a 404
async function getJson(url, o) {
  const r = await safeGet(url, { ...o, headers: { 'User-Agent': API_UA, Accept: 'application/json', 'Accept-Encoding': 'gzip, deflate, br' } });
  if (r.status === 404 || r.status === 410) return null;
  if (!ok(r)) throw unreadable(`status ${r.status}`);
  try { return JSON.parse(decodeBody(r.body, 'charset=utf-8')); } catch { throw unreadable('not JSON'); }
}

/* ---------------- Reading a page ---------------- */

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„',
  hellip: '…', middot: '·', bull: '•', laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›', copy: '©', reg: '®', trade: '™',
  deg: '°', times: '×', divide: '÷', sect: '§', para: '¶', euro: '€', pound: '£', cent: '¢', yen: '¥', iexcl: '¡', iquest: '¿',
  szlig: 'ß', aelig: 'æ', AElig: 'Æ', oelig: 'œ', OElig: 'Œ', oslash: 'ø', Oslash: 'Ø', eth: 'ð', ETH: 'Ð', thorn: 'þ', THORN: 'Þ',
  frac12: '½', frac14: '¼', frac34: '¾', shy: ''
};
const ACCENTS = { acute: '́', grave: '̀', circ: '̂', uml: '̈', tilde: '̃', ring: '̊', cedil: '̧', caron: '̌' };
function decodeEntities(s) {
  return String(s == null ? '' : s).replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z][a-z0-9]{1,31}));?/gi, (m, dec, hex, name) => {
    if (dec || hex) {
      const n = dec ? parseInt(dec, 10) : parseInt(hex, 16);
      if (n >= 0x80 && n <= 0x9f) return CP1252[n - 0x80]; // &#146; is ’, as browsers read it
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '�';
    }
    if (!m.endsWith(';')) return m;
    if (Object.prototype.hasOwnProperty.call(NAMED, name)) return NAMED[name];
    const acc = /^([a-z])(acute|grave|circ|uml|tilde|ring|cedil|caron)$/i.exec(name);
    return acc ? (acc[1] + ACCENTS[acc[2]]).normalize('NFC') : m;
  });
}
// Markup out of a short piece of text (capped first: every field it's for is short)
const stripTags = s => String(s == null ? '' : s).slice(0, 5000).replace(/<[^<>]*>/g, ' ');

// Finding tags is done by scanning, not with backtracking regexes, so a
// broken or hostile page (unclosed tags, quotes, comments) can't make it slow.
// tagEnd: where the tag starting at i ends, the first '>' outside a quoted
// value (a quote right after '=' opens one), or -1.
function tagEnd(html, i) {
  let quote = 0, prev = 0;
  for (let j = i + 1; j < html.length; j++) {
    const c = html.charCodeAt(j);
    if (quote) { if (c === quote) { quote = 0; prev = c; } }
    else if ((c === 34 || c === 39) && prev === 61) quote = c;
    else if (c === 62) return j;
    else if (c > 32) prev = c;
  }
  return -1;
}
// Every <name ...> tag, as text
function tagsNamed(html, name, limit = Infinity) {
  const out = [];
  const re = new RegExp(`<${name}(?=[\\s/>])`, 'gi');
  let m;
  while (out.length < limit && (m = re.exec(html))) {
    const end = tagEnd(html, m.index);
    if (end < 0) break;
    out.push(html.slice(m.index, end + 1));
    re.lastIndex = end + 1;
  }
  return out;
}
// The first <name>…</name> at or after `from`: { tag, text, next } or null
function elementAt(html, name, from = 0) {
  const open = new RegExp(`<${name}(?=[\\s/>])`, 'gi');
  open.lastIndex = from;
  const m = open.exec(html);
  const gt = m ? tagEnd(html, m.index) : -1;
  if (gt < 0) return null;
  const close = new RegExp(`</${name}\\s*>`, 'gi');
  close.lastIndex = gt + 1;
  const c = close.exec(html);
  return c ? { tag: html.slice(m.index, gt + 1), text: html.slice(gt + 1, c.index), next: c.index + c[0].length } : null;
}
// HTML comments out (one left open is kept: it may just be a script's text)
function dropComments(html) {
  let out = '', i = 0;
  for (;;) {
    const start = html.indexOf('<!--', i);
    const end = start < 0 ? -1 : html.indexOf('-->', start + 4);
    if (end < 0) return out + html.slice(i);
    out += html.slice(i, start);
    i = end + 3;
  }
}

// A tag's attributes, names lowercased and values decoded: name="a", name='a' or name=a
function attrsOf(tag) {
  const out = {};
  let body = tag.replace(/^<\s*[\w:-]+/, '');
  if (body.endsWith('>')) body = body.slice(0, -1);
  if (body.endsWith('/')) body = body.slice(0, -1);
  const re = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(body))) {
    const k = m[1].toLowerCase();
    if (!(k in out)) out[k] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

// "2023-09-05T10:00:00Z", "2017/06/15", "September 5, 2023", "5 Sept. 2023",
// "June 2004", "c2004" -> "YYYY-MM-DD", "YYYY-MM" or "YYYY" ('' if none)
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function normDate(raw) {
  const s = squash(raw).slice(0, 200);
  if (!s) return '';
  const pad = n => String(n).padStart(2, '0');
  const out = (y, mo, d) => {
    if (!(y >= 1000 && y <= 2999) || (mo && !(mo >= 1 && mo <= 12)) || (d && !(d >= 1 && d <= 31))) return '';
    return [String(y), mo ? pad(mo) : '', mo && d ? pad(d) : ''].filter(Boolean).join('-');
  };
  let m = /^(\d{4})(?:[-/.](\d{1,2})(?:[-/.](\d{1,2}))?)?(?!\d)/.exec(s);
  if (m) return out(+m[1], m[2] && +m[2], m[3] && +m[3]) || out(+m[1]);
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return out(+m[1], +m[2], +m[3]);
  const year = /(?:^|[^\d])(1\d{3}|2\d{3})(?!\d)/.exec(s);
  if (!year) return '';
  const mon = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?/i.exec(s);
  if (!mon) return out(+year[1]);
  const after = /^\s*(\d{1,2})(?:st|nd|rd|th)?(?!\d)/.exec(s.slice(mon.index + mon[0].length));
  const before = /(?:^|[^\d])(\d{1,2})(?:st|nd|rd|th)?\s*$/.exec(s.slice(0, mon.index));
  const day = after ? +after[1] : before ? +before[1] : null;
  return out(+year[1], MONTHS.indexOf(mon[1].toLowerCase()) + 1, day) || out(+year[1]);
}

const isUrlish = s => /^(https?:)?\/\//i.test(s) || /^www\./i.test(s);
// "Wahlstrom, Kyla L." -> "Kyla L. Wahlstrom"; "By Maria Lopez" -> "Maria Lopez"
function tidyAuthor(raw, flip) {
  let s = squash(raw).slice(0, 300).replace(/^by\s+/i, '');
  if (flip) {
    const m = /^([^,]+),\s*([^,]+)$/.exec(s);
    if (m && !/^(jr|sr|ii|iii|iv)\.?$/i.test(m[2])) s = `${m[2]} ${m[1]}`;
  }
  return s;
}
function uniq(list) {
  const seen = new Set();
  return list.filter(a => { const k = a.toLowerCase(); if (!a || seen.has(k)) return false; seen.add(k); return true; });
}

const hostOf = url => { try { return new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch { return ''; } };
const tidyHost = host => host.replace(/^(www\d*|m|amp)\./, '');
// "news.bbc.co.uk" -> "bbc.co.uk", "www.example.com" -> "example.com" (close
// enough without the public suffix list)
function registrable(host) {
  const h = String(host).toLowerCase().replace(/\.$/, '');
  if (net.isIP(h)) return h;
  const parts = h.split('.');
  if (parts.length <= 2) return h;
  const two = parts[parts.length - 1].length === 2 && /^(co|com|org|net|ac|gov|edu|govt|sch|ltd|plc|or|ne|go|gob|mil|nic)$/.test(parts[parts.length - 2]);
  return parts.slice(two ? -3 : -2).join('.');
}

// JSON-LD: every object in every ld+json script, arrays and @graph opened up
function jsonLd(html) {
  const items = [];
  const add = (x, depth) => {
    if (!x || depth > 6) return;
    if (Array.isArray(x)) return x.forEach(y => add(y, depth + 1));
    if (typeof x !== 'object') return;
    items.push(x);
    if (x['@graph']) add(x['@graph'], depth + 1);
  };
  for (let at = 0, el; (el = elementAt(html, 'script', at)); at = el.next) {
    if (!/type\s*=\s*["']?application\/ld\+json/i.test(el.tag)) continue;
    try { add(JSON.parse(el.text.trim().replace(/^<!\[CDATA\[|\]\]>$/g, '')), 0); } catch { /* a broken script is skipped */ }
  }
  return items;
}
const ldTypes = x => [].concat(x && x['@type'] || []).map(String);
const ldText = v => (typeof v === 'string' ? squash(decodeEntities(stripTags(v)))
  : Array.isArray(v) ? ldText(v[0]) : v && typeof v === 'object' ? ldText(v['@value'] || v.name) : typeof v === 'number' ? String(v) : '');

// A page's citation details from its HTML. Pure: no fetching. url is the
// address the HTML came from (after redirects).
function parseHtml(rawHtml, url) {
  const html = dropComments(String(rawHtml || ''));
  const host = hostOf(url);

  // <meta name|property|itemprop=... content=...>, any order, by lowercased key
  const meta = new Map();
  for (const tag of tagsNamed(html, 'meta')) {
    const a = attrsOf(tag);
    if (a.content == null) continue;
    for (const k of [a.name, a.property, a.itemprop]) {
      if (!k) continue;
      const key = k.trim().toLowerCase();
      if (!meta.has(key)) meta.set(key, []);
      meta.get(key).push(squash(a.content));
    }
  }
  const all = k => (meta.get(k) || []).filter(Boolean);
  const first = (...keys) => { for (const k of keys) { const v = all(k)[0]; if (v) return v; } return ''; };

  let canonicalHref = '';
  for (const tag of tagsNamed(html, 'link')) {
    const a = attrsOf(tag);
    if (!canonicalHref && a.href && String(a.rel || '').toLowerCase().split(/\s+/).includes('canonical')) canonicalHref = a.href.trim();
  }
  const titleEl = elementAt(html, 'title');

  // JSON-LD: the item the page is about (an article or video first), with
  // {"@id": ...} references looked up in the rest of the graph
  const items = jsonLd(html);
  const byId = new Map(items.filter(x => typeof x['@id'] === 'string').map(x => [x['@id'], x]));
  const resolve = x => (x && typeof x === 'object' && !Array.isArray(x) && x['@id'] && !x.name && byId.get(x['@id'])) || x;
  const rank = x => {
    const t = ldTypes(x).join(' ');
    return /Article|BlogPosting|Posting|Report|VideoObject|\bBook\b|Chapter/.test(t) ? 3 : x.headline ? 2 : /WebPage|CreativeWork/.test(t) ? 1 : 0;
  };
  const main = items.filter(x => rank(x) > 0).sort((a, b) => rank(b) - rank(a))[0] || null;
  const pubItem = main && main.publisher ? main : items.find(x => x.publisher);
  const ldPublisher = pubItem ? ldText(resolve([].concat(pubItem.publisher)[0])) : '';

  const siteName = first('og:site_name') || first('application-name') || ldPublisher || tidyHost(host);

  // Title, with a trailing " | Site" or " - Site" taken off
  let title = (first('citation_title', 'og:title', 'twitter:title') || (main ? ldText(main.headline) || ldText(main.name) : '') || (titleEl ? squash(decodeEntities(stripTags(titleEl.text))) : '')).slice(0, 1000);
  const tail = /^(.*\S)\s+[|\-–—]\s+(.+)$/.exec(title);
  if (tail && (sameText(tail[2], siteName) || sameText(tail[2], ldPublisher))) title = tail[1];

  // Authors: citation_author > JSON-LD > meta author > article:author and the rest
  let authors = all('citation_author').map(a => tidyAuthor(a, true));
  if (!authors.length && main) {
    authors = [].concat(main.author || main.creator || []).map(resolve).map(a => {
      if (typeof a === 'string') return tidyAuthor(decodeEntities(a));
      if (!a || typeof a !== 'object') return '';
      const name = tidyAuthor(ldText(a.name));
      const isOrg = ldTypes(a).some(t => /Organization|Corporation/.test(t));
      return isOrg && (sameText(name, siteName) || sameText(name, ldPublisher)) ? '' : name;
    });
  }
  authors = authors.filter(a => a && !isUrlish(a));
  if (!authors.length) authors = all('author').map(a => tidyAuthor(a)).filter(a => !isUrlish(a));
  if (!authors.length) authors = [...all('article:author'), ...all('parsely-author'), ...all('dc.creator')].map(a => tidyAuthor(a)).filter(a => !isUrlish(a));
  if (!authors.length) authors = microdataAuthors(html);
  authors = uniq(authors).slice(0, LIMITS.AUTHORS);

  // Date published: the first that reads as a date
  const dates = [
    ...all('citation_publication_date'), ...all('citation_date'), ...all('article:published_time'),
    ...(main ? [ldText(main.datePublished)] : []), ...all('datepublished'), ...all('uploaddate'),
    ...all('dc.date'), ...all('dc.date.issued'), ...all('dcterms.date'), ...all('dcterms.issued'), ...all('date'), ...all('pubdate')
  ];
  let published = '';
  for (const d of dates) if ((published = normDate(d))) break;

  // Journal articles
  const doiFrom = s => ((/(10\.\d{4,9}\/[^\s"'<>]+)/.exec(String(s || '')) || [])[1] || '').replace(/[.,;]+$/, '');
  const doi = doiFrom(first('citation_doi')) || all('dc.identifier').map(doiFrom).find(Boolean) || '';
  const journal = first('citation_journal_title');
  const fp = first('citation_firstpage'), lp = first('citation_lastpage');
  const pages = fp && lp && fp !== lp ? `${fp}-${lp}` : fp || lp;

  const ogType = first('og:type').toLowerCase();
  const videoHost = /(^|\.)(youtube\.com|youtu\.be|vimeo\.com)$/.test(host);
  const type = journal ? 'journal'
    : ogType.startsWith('video') || videoHost ? 'video'
    : ogType === 'article' || (published && authors.length) ? 'article' : 'webpage';

  // The canonical URL when it's http(s) on the same site, else the fetched one
  let canonicalUrl = '';
  if (canonicalHref) {
    try {
      const c = new URL(canonicalHref, url);
      if (/^https?:$/.test(c.protocol) && host && registrable(c.hostname) === registrable(host)) canonicalUrl = c.href;
    } catch { /* not a URL */ }
  }
  return {
    type, title, authors, siteName, publisher: '', published,
    url: canonicalUrl || String(url || ''), canonicalUrl,
    doi, journal, volume: first('citation_volume'), issue: first('citation_issue'), pages
  };
}

// Microdata, as on YouTube: <span itemprop="author"><link itemprop="name" content="Channel"></span>
// (the first 5 author blocks, each read up to its closing tag or 3,000 characters)
function microdataAuthors(html) {
  const out = [];
  const re = /itemprop\s*=\s*["']?author(?=["'\s/>])/gi;
  for (let m, n = 0; n < 5 && (m = re.exec(html)); n++) {
    const start = html.lastIndexOf('<', m.index);
    const end = start < 0 ? -1 : tagEnd(html, start);
    if (end < 0) break;
    let box = html.slice(end + 1, end + 3001);
    const close = /<\/(span|div)\b/i.exec(box);
    if (close) box = box.slice(0, close.index);
    for (const t of [...tagsNamed(box, 'link', 20), ...tagsNamed(box, 'meta', 20)]) {
      const a = attrsOf(t);
      if (String(a.itemprop || '').toLowerCase() === 'name' && a.content) out.push(tidyAuthor(a.content));
    }
    re.lastIndex = Math.max(re.lastIndex, end + 1);
  }
  return out;
}

/* ---------------- DOIs (Crossref) ---------------- */

// [2017, 6, 15] -> "2017-06-15"
function fromDateParts(p) {
  if (!Array.isArray(p) || !p[0]) return '';
  return normDate(p.filter(x => x != null).slice(0, 3).map((x, i) => (i ? String(x).padStart(2, '0') : String(x))).join('-'));
}
async function lookupDoi(doi, o) {
  const base = String(process.env.CROSSREF_BASE || 'https://api.crossref.org').replace(/\/+$/, '');
  const data = await getJson(`${base}/works/${encodeURIComponent(doi)}`, o);
  const m = data && data.message;
  if (!m || typeof m !== 'object') throw new LookupError(404, MESSAGES.doiNotFound);
  const t = v => squash(decodeEntities(stripTags(Array.isArray(v) ? v[0] : v)));
  const authors = (Array.isArray(m.author) ? m.author : []).map(a => (a ? squash(a.given && a.family ? `${a.given} ${a.family}` : a.name || a.family || a.given) : '')).filter(Boolean);
  let published = '';
  for (const k of ['issued', 'published', 'published-print', 'published-online']) if ((published = fromDateParts(m[k] && m[k]['date-parts'] && m[k]['date-parts'][0]))) break;
  const type = m.type === 'journal-article' ? 'journal' : 'article';
  const journal = t(m['container-title']), publisher = t(m.publisher);
  return {
    type, title: t(m.title), authors: uniq(authors).slice(0, LIMITS.AUTHORS),
    // Not a journal article (a chapter, a paper in proceedings): the book or proceedings is the "site"
    siteName: type === 'journal' ? '' : journal || publisher,
    publisher, published, url: `https://doi.org/${doi}`, canonicalUrl: '',
    doi, journal, volume: t(m.volume), issue: t(m.issue), pages: t(m.page)
  };
}

/* ---------------- ISBNs (Open Library) ---------------- */

// "978-0-306-40615-7", "0 306 40615 2", "080442957X": the check digit has to add up
function isValidIsbn(raw) {
  const s = String(raw || '').replace(/[\s-]/g, '').toUpperCase();
  if (/^\d{9}[\dX]$/.test(s)) {
    let sum = 0;
    for (let i = 0; i < 10; i++) sum += (10 - i) * (s[i] === 'X' ? 10 : Number(s[i]));
    return sum % 11 === 0;
  }
  if (/^\d{13}$/.test(s)) {
    let sum = 0;
    for (let i = 0; i < 13; i++) sum += Number(s[i]) * (i % 2 ? 3 : 1);
    return sum % 10 === 0;
  }
  return false;
}
async function lookupIsbn(isbn, o) {
  const base = String(process.env.OPENLIBRARY_BASE || 'https://openlibrary.org').replace(/\/+$/, '');
  const ed = await getJson(`${base}/isbn/${isbn}.json`, o);
  if (!ed || typeof ed !== 'object' || !ed.title) throw new LookupError(404, MESSAGES.isbnNotFound);
  // Authors are on the edition, or else on the work it's an edition of
  let keys = (Array.isArray(ed.authors) ? ed.authors : []).map(a => a && a.key);
  const workKey = Array.isArray(ed.works) && ed.works[0] && ed.works[0].key;
  if (!keys.length && /^\/works\/OL\d+W$/.test(workKey || '')) {
    const work = await getJson(`${base}${workKey}.json`, o).catch(() => null);
    keys = (work && Array.isArray(work.authors) ? work.authors : []).map(a => a && a.author && a.author.key);
  }
  keys = keys.filter(k => /^\/authors\/OL\d+A$/.test(k || '')).slice(0, LIMITS.BOOK_AUTHORS);
  const names = await Promise.all(keys.map(k => getJson(`${base}${k}.json`, o).then(a => squash(a && (a.name || a.personal_name))).catch(() => '')));
  const title = squash(ed.title), sub = squash(ed.subtitle);
  // A full date only when it has a day; otherwise the year
  const d = normDate(ed.publish_date);
  return {
    type: 'book', title: sub ? `${title}${/[?!:]$/.test(title) ? ' ' : ': '}${sub}` : title,
    authors: uniq(names.filter(Boolean)), siteName: '', publisher: squash(Array.isArray(ed.publishers) ? ed.publishers[0] : ''),
    published: /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : d.slice(0, 4),
    url: '', canonicalUrl: '', doi: '', journal: '', volume: '', issue: '', pages: ''
  };
}

/* ---------------- The query ---------------- */

// What the student typed: { kind: 'doi', doi } | { kind: 'isbn', isbn } |
// { kind: 'url', url } | { kind: 'bad' } | { kind: 'bad-isbn' }
function classify(raw) {
  const q = squash(typeof raw === 'string' ? raw : '');
  if (!q || q.length > LIMITS.QUERY) return { kind: 'bad' };

  // A DOI: "10.1000/xyz", "doi:10.1000/xyz" or a doi.org link
  const link = /^https?:\/\/(?:dx\.|www\.)?doi\.org\/(.+)$/i.exec(q);
  let doi = link ? link[1] : q.replace(/^doi:\s*/i, '');
  if (link) { try { doi = decodeURIComponent(doi); } catch { /* keep it as typed */ } }
  if (/^10\.\d{4,9}\/\S+$/.test(doi)) return { kind: 'doi', doi: doi.replace(/[.,;]+$/, '') };

  // An ISBN: ten or thirteen digits, hyphens and spaces allowed, "ISBN" in front allowed
  const isbn = /^(isbn(?:-?1[03])?\s*:?\s*)?(\d[\d\s-]*[\dXx])$/i.exec(q);
  if (isbn) {
    const digits = isbn[2].replace(/[\s-]/g, '').toUpperCase();
    if (isbn[1] || digits.length === 10 || digits.length === 13) return isValidIsbn(digits) ? { kind: 'isbn', isbn: digits } : { kind: 'bad-isbn' };
  }

  // A link, with or without http(s):// ("example.com/page")
  let url = q;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    const named = /^[^/?#@:]+\.[a-z][a-z0-9-]*\.?(?::\d+)?(?:[/?#].*)?$/i.test(url);
    const numbered = /^\d+\.\d+\.\d+\.\d+(?::\d+)?(?:[/?#].*)?$/.test(url);
    if (/\s/.test(url) || (!named && !numbered)) return { kind: 'bad' };
    url = `https://${url}`;
  }
  let u;
  try { u = new URL(url); } catch { return { kind: 'bad' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { kind: 'bad' };
  return { kind: 'url', url: u.href };
}

// Which of the four key fields were filled in. A book's "site" is its
// publisher; a journal article's is its journal.
function foundMissing(source) {
  const keys = ['title', 'authors', 'published', source.type === 'book' ? 'publisher' : source.type === 'journal' ? 'journal' : 'siteName'];
  const has = k => (Array.isArray(source[k]) ? source[k].length > 0 : !!source[k]);
  return { found: keys.filter(has), missing: keys.filter(k => !has(k)) };
}

// opts: { allowPrivate (tests only), timeoutMs (7 s, for the whole lookup) }
async function lookup(query, opts = {}) {
  const q = classify(query);
  if (q.kind === 'bad') throw new LookupError(400, MESSAGES.query);
  if (q.kind === 'bad-isbn') throw new LookupError(400, MESSAGES.isbn);
  const o = { allowPrivate: !!opts.allowPrivate, deadline: Date.now() + (opts.timeoutMs || LIMITS.TIMEOUT_MS) };
  let source;
  try {
    if (q.kind === 'doi') source = await lookupDoi(q.doi, o);
    else if (q.kind === 'isbn') source = await lookupIsbn(q.isbn, o);
    else {
      const r = await safeGet(q.url, { ...o, types: HTML_TYPES, headers: { 'User-Agent': PAGE_UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Encoding': 'gzip, deflate, br' } });
      if (!ok(r)) throw unreadable(`status ${r.status}`);
      source = parseHtml(decodeBody(r.body, r.headers['content-type']), r.url);
    }
  } catch (e) {
    if (e instanceof LookupError) throw e;
    throw unreadable(e && e.message);
  }
  return { source, ...foundMissing(source), via: q.kind === 'url' ? 'page' : q.kind };
}

// 20 lookups per student per 5 minutes, per server instance
const RATE = { MAX: 20, WINDOW_MS: 5 * 60 * 1000 };
const hits = new Map();
function rateLimit(key, now = Date.now()) {
  const recent = (hits.get(key) || []).filter(t => now - t < RATE.WINDOW_MS);
  if (recent.length >= RATE.MAX) { hits.set(key, recent); return false; }
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] >= RATE.WINDOW_MS) hits.delete(k);
  return true;
}

module.exports = {
  lookup, parseHtml, classify, isValidIsbn, isPrivate, safeLookup, checkUrl, safeGet, normDate, decodeEntities, rateLimit,
  LookupError, MESSAGES, LIMITS, RATE, PAGE_UA, API_UA
};
