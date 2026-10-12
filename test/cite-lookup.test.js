// The citation lookup (lib/cite-lookup.js) and its route: reading a page's
// details (parseHtml), the SSRF guard, DOIs and ISBNs through a local stand-in
// for Crossref and Open Library, and POST /api/write/:docId/sources/lookup.
// Runs on a local PGlite store in a temp folder. Nothing here reaches the
// internet, Firebase, Google or Gemini: their settings are blanked or pointed
// at a closed local port, every page comes from a stub server on 127.0.0.1,
// and the addresses the guard refuses are refused before any connection.
'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const zlib = require('zlib');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-lookup-'));
Object.assign(process.env, {
  VISOR_PLATFORM: '', DATABASE_URL: '',
  PGLITE_DIR: path.join(DATA, 'pglite'), VISOR_IMAGE_DIR: path.join(DATA, 'images'), VISOR_AUDIO_DIR: path.join(DATA, 'audio'),
  VISOR_DEV_LOGIN: '1', SESSION_SECRET: 'test-secret', NODE_ENV: 'test',
  GEMINI_API_KEY: '', GEMINI_VIA: 'apikey', GEMINI_BASE_URL: 'http://127.0.0.1:9', VERTEX_BASE_URL: 'http://127.0.0.1:9', DRIVE_API_BASE: 'http://127.0.0.1:9',
  GOOGLE_CLIENT_ID: '', GOOGLE_API_KEY: '', GOOGLE_APP_ID: '', CLASSROOM_IMPORT: '',
  // The route lets the stub's private address through; Crossref and Open Library are the stub too
  VISOR_CITE_ALLOW_PRIVATE: '1', CROSSREF_BASE: 'http://127.0.0.1:9', OPENLIBRARY_BASE: 'http://127.0.0.1:9'
});

const test = require('node:test');
const assert = require('node:assert');
const L = require('../lib/cite-lookup');
const C = require('../lib/cite');
const app = require('../server');

/* ---------------- fixtures ---------------- */

const NEWS = `<!doctype html><html><head>
<meta charset="utf-8">
<title>Why Teens Can&rsquo;t Fall Asleep Before 11 | The Example Times</title>
<meta property="og:title" content="Why Teens Can&#8217;t Fall Asleep Before 11 | The Example Times">
<meta content="The Example Times" property="og:site_name">
<meta property='og:type' content='article'>
<meta name=author content="By Someone Else">
<meta property="article:author" content="https://www.facebook.com/someone">
<meta property="article:published_time" content="2023-09-05T08:00:00-04:00">
<link rel="canonical" href="https://www.example-times.com/2023/09/05/health/teens-sleep.html">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"NewsArticle","headline":"Teens and Sleep","datePublished":"2023-09-04",
 "author":[{"@type":"Person","name":"Maria Lopez"},{"@type":"Person","name":"Dan Brooks"},{"@type":"Organization","name":"The Example Times"}],
 "publisher":{"@type":"Organization","name":"Example Media Group"}}</script>
</head><body><h1>Why Teens Can’t Fall Asleep Before 11</h1></body></html>`;

const JOURNAL = `<html><head><title>Delaying School Start Times | Journal of Adolescent Health</title>
<meta content="Delaying School Start Times and Adolescent Sleep" name="citation_title">
<meta name='citation_author' content='Wahlstrom, Kyla L.'>
<meta name=citation_author content="Judith A. Owens">
<meta name="citation_publication_date" content="2017/06/15">
<meta name="citation_journal_title" content="Journal of Adolescent Health">
<meta name="citation_volume" content="60"><meta name="citation_issue" content="6">
<meta name="citation_firstpage" content="627"><meta name="citation_lastpage" content="633">
<meta name="citation_doi" content="doi:10.1016/j.jadohealth.2017.01.011">
</head><body></body></html>`;

const VIDEO = `<html><head><title>Why Do We Sleep? - YouTube</title>
<meta property="og:site_name" content="YouTube">
<meta property="og:title" content="Why Do We Sleep?">
<meta property="og:type" content="video.other">
<meta itemprop="datePublished" content="2019-05-12T07:00:00-07:00">
<link rel="canonical" href="https://www.youtube.com/watch?v=abc123">
</head><body><span itemprop="author" itemscope itemtype="http://schema.org/Person"><link itemprop="url" href="http://www.youtube.com/@ExampleScience"><link itemprop="name" content="Example Science"></span></body></html>`;

const BARE = '<html><head><title>  Sleep and Your Health -\n Healthy Teens </title></head><body><p>Hello</p></body></html>';

/* ---------------- a stub server: pages, Crossref and Open Library ---------------- */

const hits = [];
const sockets = new Set();
let port, stubBase, authorsInFlight = 0, maxAuthorsInFlight = 0;
const CROSSREF = {
  '10.1016/j.jadohealth.2017.01.011': {
    DOI: '10.1016/j.jadohealth.2017.01.011', type: 'journal-article', title: ['Delaying School Start Times and <i>Adolescent</i> Sleep'],
    author: [{ given: 'Kyla L.', family: 'Wahlstrom', sequence: 'first' }, { given: 'Judith A.', family: 'Owens' }, { name: 'Sleep Study Group' }],
    'container-title': ['Journal of Adolescent Health'], volume: '60', issue: '6', page: '627-633', publisher: 'Elsevier BV',
    issued: { 'date-parts': [[2017, 6]] }, published: { 'date-parts': [[2017, 6, 15]] }
  },
  '10.5555/chapter.1': {
    type: 'book-chapter', title: ['How Sleep Works'], author: [], 'container-title': ['The Science of Sleep'], publisher: 'Example Press',
    issued: { 'date-parts': [[null]] }, 'published-print': { 'date-parts': [[2020, 2, 1]] }
  }
};
const stub = http.createServer((req, res) => {
  res.on('error', () => {});
  const u = req.url;
  hits.push({ path: u, ua: req.headers['user-agent'], accept: req.headers.accept });
  const send = (status, type, body, headers = {}) => { res.writeHead(status, { ...(type ? { 'Content-Type': type } : {}), ...headers }); res.end(body); };
  const html = body => send(200, 'text/html; charset=utf-8', body);
  const json = (status, data) => send(status, 'application/json', JSON.stringify(data));
  let m;
  if (u === '/empty-deflate') {
    // Deflate blocks that decode to nothing, forever: only the raw-byte cap stops it
    res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'deflate' });
    res.write(Buffer.from([0x78, 0x9c]));
    const block = Buffer.alloc(13107 * 5);
    for (let i = 0; i < block.length; i += 5) block.set([0x00, 0x00, 0x00, 0xff, 0xff], i);
    const pump = () => { if (res.destroyed) return; while (res.write(block)) { if (res.destroyed) return; } res.once('drain', pump); };
    return pump();
  }
  if (u === '/article' || u === '/r/0') return html(NEWS);
  if (u === '/journal') return html(JOURNAL);
  if ((m = /^\/r\/(\d+)$/.exec(u))) return send(302, null, '', { Location: `/r/${m[1] - 1}` });
  if (u === '/to-absolute') return send(301, null, '', { Location: `${stubBase}/journal` });
  if (u === '/to-creds') return send(302, null, '', { Location: `http://u:p@127.0.0.1:${port}/article` });
  if (u === '/to-ftp') return send(302, null, '', { Location: 'ftp://127.0.0.1/file' });
  if (u === '/gzip') return send(200, 'text/html', zlib.gzipSync(VIDEO), { 'Content-Encoding': 'gzip' });
  if (u === '/deflate') return send(200, 'text/html', zlib.deflateSync(VIDEO), { 'Content-Encoding': 'deflate' });
  if (u === '/br') return send(200, 'text/html', zlib.brotliCompressSync(VIDEO), { 'Content-Encoding': 'br' });
  if (u === '/xhtml') return send(200, 'application/xhtml+xml', BARE);
  if (u === '/latin') return send(200, 'text/html; charset=windows-1252', Buffer.concat([Buffer.from('<title>Caf'), Buffer.from([0xe9]), Buffer.from(' Lopez'), Buffer.from([0x92]), Buffer.from('s Guide</title>')]));
  // 2 MB: Visor stops at 1.5 MB, so the og:title at the very end is never read
  if (u === '/big') return html(`<html><head><title>Big Page</title></head><body>${'x'.repeat(2 * 1024 * 1024)}<meta property="og:title" content="End Marker"></body></html>`);
  if (u === '/pdf') return send(200, 'application/pdf', '%PDF-1.4');
  if (u === '/notype') return send(200, null, NEWS);
  if (u === '/missing') return send(404, 'text/html', '<title>Not found</title>');
  if (u === '/broken') return send(500, 'text/html', '<title>Oops</title>');
  if (u === '/hangup') return req.socket.destroy();
  if (u === '/slow') return; // never answers

  // Crossref
  if ((m = /^\/crossref\/works\/(.+)$/.exec(u))) {
    const rec = CROSSREF[decodeURIComponent(m[1])];
    return rec ? json(200, { status: 'ok', message: rec }) : send(404, 'text/plain', 'Resource not found.');
  }
  // Open Library: /isbn/ redirects to the edition, as the real one does
  if (u === '/ol/isbn/9780306406157.json') return send(302, null, '', { Location: '/ol/books/OL1M.json' });
  if (u === '/ol/books/OL1M.json') {
    return json(200, { title: 'Sleep', subtitle: 'A Very Short Introduction', publishers: ['Oxford University Press', 'Another'], publish_date: 'June 1, 2004',
      authors: [1, 2, 3, 4, 5, 6, 7].map(n => ({ key: `/authors/OL${n}A` })).concat([{ key: '/authors/../../secret' }]) });
  }
  if (u === '/ol/isbn/080442957X.json') return json(200, { title: 'The Sleep Book', publish_date: '1993', works: [{ key: '/works/OL5W' }] });
  if (u === '/ol/works/OL5W.json') return json(200, { authors: [{ author: { key: '/authors/OL9A' } }] });
  if ((m = /^\/ol\/authors\/OL(\d+)A\.json$/.exec(u))) {
    authorsInFlight++;
    maxAuthorsInFlight = Math.max(maxAuthorsInFlight, authorsInFlight);
    return setTimeout(() => { authorsInFlight--; json(200, { name: m[1] === '9' ? 'Ann Adams' : `Author ${m[1]}` }); }, 40);
  }
  send(404, 'text/plain', 'not here');
});
stub.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });

let server, base;
test.before(async () => {
  await new Promise(r => stub.listen(0, '127.0.0.1', r));
  port = stub.address().port;
  stubBase = `http://127.0.0.1:${port}`;
  process.env.CROSSREF_BASE = `${stubBase}/crossref`;
  process.env.OPENLIBRARY_BASE = `${stubBase}/ol`;
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  for (const s of sockets) s.destroy();
  stub.close();
  server.close();
  fs.rmSync(DATA, { recursive: true, force: true });
});

// A LookupError with this status and message
const refused = (status, message, reason) => e => {
  assert.ok(e instanceof L.LookupError, String(e && e.stack));
  assert.strictEqual(e.status, status);
  assert.strictEqual(e.message, message);
  if (reason) assert.match(e.reason, reason);
  return true;
};
const PAGE = L.MESSAGES.page;
const open = { allowPrivate: true };

/* ---------------- parseHtml ---------------- */

test('parseHtml: a news article (meta tags and JSON-LD)', () => {
  const s = L.parseHtml(NEWS, 'https://example-times.com/2023/09/05/health/teens-sleep.html?utm_source=x');
  assert.deepStrictEqual(s, {
    type: 'article',
    // og:title beats the JSON-LD headline; the " | The Example Times" is the site's name, so it goes
    title: 'Why Teens Can’t Fall Asleep Before 11',
    // JSON-LD beats meta author; the site as an author is left out
    authors: ['Maria Lopez', 'Dan Brooks'],
    siteName: 'The Example Times', publisher: '',
    // article:published_time beats JSON-LD datePublished, and keeps its own date
    published: '2023-09-05',
    // the canonical URL is on the same site (www. or not), so it's the link
    url: 'https://www.example-times.com/2023/09/05/health/teens-sleep.html', canonicalUrl: 'https://www.example-times.com/2023/09/05/health/teens-sleep.html',
    doi: '', journal: '', volume: '', issue: '', pages: ''
  });
  // A canonical URL on another site is ignored
  const copy = L.parseHtml(NEWS, 'https://mirror.example.net/copy');
  assert.strictEqual(copy.url, 'https://mirror.example.net/copy');
  assert.strictEqual(copy.canonicalUrl, '');
});

test('parseHtml: a journal page (citation_* tags, attributes in any order and quoting)', () => {
  const s = L.parseHtml(JOURNAL, 'https://www.jahonline.org/article/S1054-139X(17)30038-7/fulltext');
  assert.deepStrictEqual(s, {
    type: 'journal', title: 'Delaying School Start Times and Adolescent Sleep',
    authors: ['Kyla L. Wahlstrom', 'Judith A. Owens'],
    siteName: 'jahonline.org', publisher: '', published: '2017-06-15',
    url: 'https://www.jahonline.org/article/S1054-139X(17)30038-7/fulltext', canonicalUrl: '',
    doi: '10.1016/j.jadohealth.2017.01.011', journal: 'Journal of Adolescent Health', volume: '60', issue: '6', pages: '627-633'
  });
  // dc.identifier as a doi.org link
  const dc = L.parseHtml('<meta name="DC.Identifier" content="https://doi.org/10.1000/xyz123"><meta name="DC.Identifier" content="urn:x">', 'https://example.org/a');
  assert.strictEqual(dc.doi, '10.1000/xyz123');
});

test('parseHtml: a YouTube-like video', () => {
  const s = L.parseHtml(VIDEO, 'https://www.youtube.com/watch?v=abc123&feature=share');
  assert.strictEqual(s.type, 'video');
  assert.strictEqual(s.title, 'Why Do We Sleep?');
  assert.deepStrictEqual(s.authors, ['Example Science']);
  assert.strictEqual(s.siteName, 'YouTube');
  assert.strictEqual(s.published, '2019-05-12');
  assert.strictEqual(s.url, 'https://www.youtube.com/watch?v=abc123');
  // and it formats like any other video
  assert.strictEqual(C.format(s, 'mla', { accessed: '2026-10-12' }).text, 'Example Science. “Why Do We Sleep?” YouTube, 12 May 2019, www.youtube.com/watch?v=abc123. Accessed 12 Oct. 2026.');
  // the host alone is enough
  assert.strictEqual(L.parseHtml('<title>A film</title>', 'https://vimeo.com/123').type, 'video');
  assert.strictEqual(L.parseHtml('<title>A short</title>', 'https://youtu.be/abc').type, 'video');
});

test('parseHtml: a bare page with only a <title>', () => {
  assert.deepStrictEqual(L.parseHtml(BARE, 'https://www.healthyteens.example.org/sleep'), {
    // " - Healthy Teens" stays: it isn't the site's name (that's the tidied host)
    type: 'webpage', title: 'Sleep and Your Health - Healthy Teens', authors: [], siteName: 'healthyteens.example.org', publisher: '',
    published: '', url: 'https://www.healthyteens.example.org/sleep', canonicalUrl: '', doi: '', journal: '', volume: '', issue: '', pages: ''
  });
  // Nothing at all: still no throw
  assert.strictEqual(L.parseHtml('', 'https://example.org/').title, '');
  assert.strictEqual(L.parseHtml('<<<>>> "\'', undefined).siteName, '');
});

test('parseHtml: HTML entities are decoded', () => {
  const s = L.parseHtml(`<title>Tom &amp; Jerry&#8217;s &#x2014; Caf&eacute; &lt;Guide&gt; &quot;2024&quot; &nbsp;&amp;c &foo;</title>
    <meta name="author" content="Ren&eacute;e O&#39;Brien"><meta property="og:site_name" content="Caf&eacute; &amp; Co">
    <meta name="date" content="5 Sept. 2023">`, 'https://example.org/p');
  assert.strictEqual(s.title, 'Tom & Jerry’s — Café <Guide> "2024" &c &foo;');
  assert.deepStrictEqual(s.authors, ['Renée O\'Brien']);
  assert.strictEqual(s.siteName, 'Café & Co');
  assert.strictEqual(s.published, '2023-09-05');
  assert.strictEqual(s.type, 'article', 'a date and an author make it an article');
  assert.strictEqual(L.decodeEntities('&#146;&Ccedil;a&#0;&amp'), '’Ça�&amp');
});

test('parseHtml: JSON-LD in a @graph or an array, with references; broken JSON-LD is skipped', () => {
  const graph = `<title>Ignored | Example Media</title><script type="application/ld+json">{ not json }</script>
    <script type="application/ld+json">[{"@context":"https://schema.org","@graph":[
      {"@type":"WebSite","@id":"#site","name":"Example"},
      {"@type":"Organization","@id":"#org","name":"Example Media"},
      {"@type":"Person","@id":"#p1","name":"Maria Lopez"},
      {"@type":["BlogPosting"],"headline":"Sleep &amp; School","author":[{"@id":"#p1"},{"@type":"Organization","name":"Example Media"},"https://example.org/staff"],
       "publisher":{"@id":"#org"},"datePublished":"2024-01-15T09:00:00Z"}]}]</script>`;
  const s = L.parseHtml(graph, 'https://blog.example.org/sleep');
  assert.strictEqual(s.title, 'Sleep & School');
  assert.deepStrictEqual(s.authors, ['Maria Lopez']);
  assert.strictEqual(s.siteName, 'Example Media');
  assert.strictEqual(s.published, '2024-01-15');
  assert.strictEqual(s.type, 'article');
  // An Organization that isn't the site is an author; a <title>'s site suffix goes when it's the publisher
  const org = L.parseHtml('<title>Report | Example Media</title><script type="application/ld+json">{"@type":"Report","author":{"@type":"Organization","name":"World Health Organization"},"publisher":{"name":"Example Media"}}</script>', 'https://example.org/r');
  assert.strictEqual(org.title, 'Report');
  assert.deepStrictEqual(org.authors, ['World Health Organization']);
});

test('normDate: the shapes dates come in', () => {
  const want = { '2023-09-05T10:00:00Z': '2023-09-05', '2017/06/15': '2017-06-15', 'September 5, 2023': '2023-09-05', '5 Sept. 2023': '2023-09-05',
    'June 2004': '2004-06', c2004: '2004', 'Mon, 05 Sep 2023 10:00:00 GMT': '2023-09-05', 20230905: '2023-09-05', '2023-13-01': '2023', 1693900800: '', soon: '', '': '' };
  for (const [k, v] of Object.entries(want)) assert.strictEqual(L.normDate(k), v, k);
});

/* ---------------- the SSRF guard ---------------- */

test('isPrivate: IPv4, IPv6 and IPv4-mapped addresses', () => {
  const blocked = ['127.0.0.1', '127.255.0.9', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '169.254.0.1', '100.64.0.1', '100.127.255.255',
    '0.0.0.0', '224.0.0.1', '239.255.255.250', '255.255.255.255', '198.18.0.1', '192.0.2.1',
    '::', '::1', 'fe80::1', 'fe80::1%en0', 'fc00::1', 'fd12:3456::1', 'ff02::1', 'fec0::1', '2001:db8::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:169.254.169.254', '::ffff:0:10.0.0.1', '::127.0.0.1', '64:ff9b::a00:1', '2002:7f00:1::1',
    '', 'localhost', 'not an address', '1.2.3', '256.1.1.1', '[::1]'];
  const allowed = ['8.8.8.8', '93.184.216.34', '172.32.0.1', '100.128.0.1', '169.255.0.1', '2606:4700:4700::1111', '2a00:1450:4009:81f::200e', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1'];
  for (const ip of blocked) assert.strictEqual(L.isPrivate(ip), true, ip);
  for (const ip of allowed) assert.strictEqual(L.isPrivate(ip), false, ip);
});

// The connect-time DNS check, called the way Node's http calls it
const resolveWith = (lookup, host, options) => new Promise(resolve => {
  const cb = (err, address, family) => resolve({ err, address, family });
  if (options === undefined) lookup(host, cb); else lookup(host, options, cb);
});

test('safeLookup: refuses 127.0.0.1, localhost, 169.254.169.254 and 10.x unless allowPrivate (both callback shapes)', async () => {
  const guard = L.safeLookup(false);
  for (const host of ['127.0.0.1', 'localhost', '169.254.169.254', '10.1.2.3', '::1']) {
    for (const options of [undefined, {}, { all: true }, { family: 4 }, 0]) {
      const r = await resolveWith(guard, host, options);
      assert.ok(r.err, `${host} ${JSON.stringify(options)}`);
      assert.strictEqual(r.err.code, 'EBLOCKED', `${host} ${JSON.stringify(options)}: ${r.err.message}`);
    }
  }
  const open = L.safeLookup(true);
  let r = await resolveWith(open, '127.0.0.1', {});
  assert.ifError(r.err);
  assert.strictEqual(r.address, '127.0.0.1');
  assert.strictEqual(r.family, 4);
  r = await resolveWith(open, '127.0.0.1', { all: true });
  assert.ifError(r.err);
  assert.deepStrictEqual(r.address, [{ address: '127.0.0.1', family: 4 }]);
});

test('lookup: refuses private, odd-port, credentialed and non-http addresses before connecting', async () => {
  const before = hits.length;
  const blocked = [
    [`http://127.0.0.1:${port}/article`, /port/], ['http://127.0.0.1/article', /private/], ['http://localhost/article', /private/],
    [`http://localhost:${port}/article`, /port/], ['http://169.254.169.254/latest/meta-data/', /private/], ['http://10.0.0.1/', /private/],
    ['http://[::1]/', /private/], ['http://[::ffff:127.0.0.1]/', /private/], ['http://2130706433/', /private/], ['http://0x7f.1/', /private/],
    ['127.0.0.1/article', /private/], ['https://user:secret@example.com/', /credentials/], ['http://example.com:8080/', /port/]
  ];
  for (const [q, reason] of blocked) await assert.rejects(L.lookup(q), refused(422, PAGE, reason), q);
  assert.strictEqual(hits.length, before, 'the stub was never reached');
  // Not links at all
  for (const q of ['ftp://example.com/file', 'javascript:alert(1)', 'file:///etc/passwd', 'hello there', '', '   ', null, 42, { query: 'x' }, 'x'.repeat(2001)]) {
    await assert.rejects(L.lookup(q), refused(400, 'Paste a link, a DOI or an ISBN.'), String(q));
  }
  // checkUrl is the same check, on every redirect
  assert.throws(() => L.checkUrl('http://169.254.169.254/'), refused(422, PAGE, /private/));
  assert.strictEqual(L.checkUrl('https://example.com:443/x').hostname, 'example.com');
  assert.strictEqual(L.checkUrl(`http://127.0.0.1:${port}/`, true).port, String(port));
});

test('lookup: redirects (4 at most, each one checked), limits, encodings and content types', async () => {
  // 4 redirects are followed; the link is where they ended (the canonical URL is on another site)
  let r = await L.lookup(`${stubBase}/r/4`, open);
  assert.strictEqual(r.via, 'page');
  assert.strictEqual(r.source.title, 'Why Teens Can’t Fall Asleep Before 11');
  assert.strictEqual(r.source.url, `${stubBase}/r/0`);
  await assert.rejects(L.lookup(`${stubBase}/r/5`, open), refused(422, PAGE, /too many redirects/));
  r = await L.lookup(`${stubBase}/to-absolute`, open);
  assert.strictEqual(r.source.type, 'journal');
  // a redirect is checked like the first address: no credentials, http(s) only, even with private addresses allowed
  await assert.rejects(L.lookup(`${stubBase}/to-creds`, open), refused(422, PAGE, /credentials/));
  await assert.rejects(L.lookup(`${stubBase}/to-ftp`, open), refused(422, PAGE, /scheme/));

  // What it asked for
  const seen = hits.filter(h => h.path === '/journal').pop();
  assert.strictEqual(seen.ua, 'Mozilla/5.0 (compatible; VisorCitation/1.0)');
  assert.strictEqual(seen.accept, 'text/html,application/xhtml+xml');

  // gzip, deflate and br are decoded; xhtml is read; a charset is honoured
  for (const p of ['/gzip', '/deflate', '/br']) assert.strictEqual((await L.lookup(stubBase + p, open)).source.title, 'Why Do We Sleep?', p);
  assert.strictEqual((await L.lookup(`${stubBase}/xhtml`, open)).source.title, 'Sleep and Your Health - Healthy Teens');
  assert.strictEqual((await L.lookup(`${stubBase}/latin`, open)).source.title, 'Café Lopez’s Guide');

  // 1.5 MB at most: what came before that is read, the end never is
  r = await L.lookup(`${stubBase}/big`, open);
  assert.strictEqual(r.source.title, 'Big Page');

  // Not HTML, not there, broken, hung up or too slow: 422, never a crash
  for (const p of ['/pdf', '/notype', '/missing', '/broken', '/hangup']) await assert.rejects(L.lookup(stubBase + p, open), refused(422, PAGE), p);
  const t = Date.now();
  await assert.rejects(L.lookup(`${stubBase}/slow`, { ...open, timeoutMs: 300 }), refused(422, PAGE, /timed out/));
  assert.ok(Date.now() - t < 3000);
  // a closed port
  await assert.rejects(L.lookup('http://127.0.0.1:9/', open), refused(422, PAGE));
});

/* ---------------- DOIs and ISBNs ---------------- */

test('lookup: a DOI through Crossref, typed three ways', async () => {
  for (const q of ['10.1016/j.jadohealth.2017.01.011', 'https://doi.org/10.1016/j.jadohealth.2017.01.011', 'doi: 10.1016/j.jadohealth.2017.01.011.']) {
    const r = await L.lookup(q, open);
    assert.strictEqual(r.via, 'doi', q);
    assert.deepStrictEqual(r.source, {
      type: 'journal', title: 'Delaying School Start Times and Adolescent Sleep',
      authors: ['Kyla L. Wahlstrom', 'Judith A. Owens', 'Sleep Study Group'],
      siteName: '', publisher: 'Elsevier BV', published: '2017-06',
      url: 'https://doi.org/10.1016/j.jadohealth.2017.01.011', canonicalUrl: '',
      doi: '10.1016/j.jadohealth.2017.01.011', journal: 'Journal of Adolescent Health', volume: '60', issue: '6', pages: '627-633'
    });
    assert.deepStrictEqual(r.found, ['title', 'authors', 'published', 'journal']);
    assert.deepStrictEqual(r.missing, []);
  }
  const seen = hits.filter(h => h.path.startsWith('/crossref/')).pop();
  assert.strictEqual(seen.path, '/crossref/works/10.1016%2Fj.jadohealth.2017.01.011');
  assert.strictEqual(seen.ua, 'VisorClassroom/7 (mailto:support@visor.invalid)');

  // Not a journal article: an 'article', its book as the site
  const ch = await L.lookup('10.5555/chapter.1', open);
  assert.strictEqual(ch.source.type, 'article');
  assert.strictEqual(ch.source.siteName, 'The Science of Sleep');
  assert.strictEqual(ch.source.published, '2020-02-01');
  assert.deepStrictEqual(ch.missing, ['authors']);
  assert.deepStrictEqual(ch.found, ['title', 'published', 'siteName']);

  await assert.rejects(L.lookup('10.9999/nothing.here', open), refused(404, 'Nothing was found for that DOI.'));
});

test('isValidIsbn: ISBN-10 and ISBN-13 check digits', () => {
  for (const s of ['0-306-40615-2', '0306406152', '080442957X', '080442957x', '978-0-306-40615-7', '978 0 306 40615 7', '9780000000002']) assert.strictEqual(L.isValidIsbn(s), true, s);
  for (const s of ['0306406153', '0-306-40615-X', '9780306406158', '978030640615', '97803064061577', 'X306406152', '', null]) assert.strictEqual(L.isValidIsbn(s), false, String(s));
});

test('lookup: an ISBN through Open Library (authors fetched in parallel, at most 5)', async () => {
  let r = await L.lookup('978-0-306-40615-7', open);
  assert.strictEqual(r.via, 'isbn');
  assert.deepStrictEqual(r.source, {
    type: 'book', title: 'Sleep: A Very Short Introduction', authors: ['Author 1', 'Author 2', 'Author 3', 'Author 4', 'Author 5'],
    siteName: '', publisher: 'Oxford University Press', published: '2004-06-01',
    url: '', canonicalUrl: '', doi: '', journal: '', volume: '', issue: '', pages: ''
  });
  assert.deepStrictEqual(r.found, ['title', 'authors', 'published', 'publisher']);
  assert.ok(maxAuthorsInFlight > 1, 'the authors were asked for at the same time');
  assert.ok(!hits.some(h => h.path.includes('secret')), 'an author key that isn\'t one is never fetched');

  // ISBN-10 with an X, "ISBN" in front; authors from the work; a year only
  r = await L.lookup('ISBN 0-8044-2957-X', open);
  assert.strictEqual(r.source.title, 'The Sleep Book');
  assert.deepStrictEqual(r.source.authors, ['Ann Adams']);
  assert.strictEqual(r.source.published, '1993');
  assert.deepStrictEqual(r.missing, ['publisher']);

  await assert.rejects(L.lookup('9780000000002', open), refused(404, 'Nothing was found for that ISBN.'));
  for (const q of ['978-0-306-40615-8', '0306406153', 'ISBN 12345']) await assert.rejects(L.lookup(q, open), refused(400, 'That ISBN isn’t valid.'), q);
});

test('rateLimit: 20 in 5 minutes per key', () => {
  const T = 1e12;
  for (let i = 0; i < 20; i++) assert.strictEqual(L.rateLimit('rl-key', T + i), true);
  assert.strictEqual(L.rateLimit('rl-key', T + 100), false);
  assert.strictEqual(L.rateLimit('rl-other', T + 100), true, 'per key');
  assert.strictEqual(L.rateLimit('rl-key', T + 5 * 60 * 1000 + 1), true, 'the first ones expire');
});

/* ---------------- the route ---------------- */

function client() {
  let cookie = '';
  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    let data = null;
    try { data = await r.json(); } catch {}
    return { status: r.status, data };
  };
  return { get: u => call('GET', u, null), post: (u, b) => call('POST', u, b || {}), patch: (u, b) => call('PATCH', u, b) };
}
let people = 0;
async function signup(c, role, firstName, extra = {}) {
  const r = await c.post('/api/auth/signup', { email: `${firstName.toLowerCase()}${++people}@lookup.test`, password: 'secret12', firstName, lastName: role === 'teacher' ? 'Teacher' : 'Student', role, ...(role === 'student' ? { over13: true } : {}), ...extra });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return r.data.user;
}

test('route: POST /api/write/:docId/sources/lookup', async () => {
  const teacher = client(), stu = client(), other = client();
  await signup(teacher, 'teacher', 'Tess');
  const cls = (await teacher.post('/api/classes', { name: 'English 10' })).data.class;
  await signup(stu, 'student', 'Sam', { classCode: cls.joinCode });
  await signup(other, 'student', 'Ola', { classCode: cls.joinCode });
  const a = (await teacher.post(`/api/classes/${cls.id}/assignments`, { type: 'writing', title: 'Sleep essay', writing: { mode: 'open' } })).data.assignment;
  await teacher.post(`/api/assignments/${a.id}/publish`, { published: true });
  const doc = (await stu.get(`/api/write/${a.id}`)).data.doc;
  const url = `/api/write/${doc.id}/sources/lookup`;

  // A page on the stub (private addresses are let through for tests)
  let r = await stu.post(url, { query: `${stubBase}/article` });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.deepStrictEqual(Object.keys(r.data).sort(), ['found', 'missing', 'source', 'via']);
  assert.strictEqual(r.data.via, 'page');
  assert.strictEqual(r.data.source.type, 'article');
  assert.strictEqual(r.data.source.title, 'Why Teens Can’t Fall Asleep Before 11');
  assert.deepStrictEqual(r.data.source.authors, ['Maria Lopez', 'Dan Brooks']);
  assert.strictEqual(r.data.source.url, `${stubBase}/article`);
  assert.deepStrictEqual(r.data.found, ['title', 'authors', 'published', 'siteName']);
  assert.deepStrictEqual(r.data.missing, []);
  // Nothing is saved
  assert.strictEqual(((await stu.get(`/api/write/${a.id}`)).data.doc.sources || []).length, 0);

  // A DOI and an ISBN
  r = await stu.post(url, { query: '10.1016/j.jadohealth.2017.01.011' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.via, 'doi');
  assert.strictEqual(r.data.source.journal, 'Journal of Adolescent Health');
  r = await stu.post(url, { query: '0-8044-2957-X' });
  assert.strictEqual(r.data.via, 'isbn');
  assert.deepStrictEqual(r.data.missing, ['publisher']);

  // The errors, word for word
  const want = [
    [{ query: 'the great gatsby' }, 400, 'Paste a link, a DOI or an ISBN.'],
    [{}, 400, 'Paste a link, a DOI or an ISBN.'],
    [{ query: '978-0-306-40615-8' }, 400, 'That ISBN isn’t valid.'],
    [{ query: '10.9999/nothing.here' }, 404, 'Nothing was found for that DOI.'],
    [{ query: '9780000000002' }, 404, 'Nothing was found for that ISBN.'],
    [{ query: `${stubBase}/pdf` }, 422, 'Visor couldn’t read that page. Fill in the details yourself.'],
    [{ query: `${stubBase}/broken` }, 422, 'Visor couldn’t read that page. Fill in the details yourself.'],
    [{ query: `${stubBase}/hangup` }, 422, 'Visor couldn’t read that page. Fill in the details yourself.']
  ];
  for (const [body, status, error] of want) {
    r = await stu.post(url, body);
    assert.strictEqual(r.status, status, JSON.stringify(body));
    assert.strictEqual(r.data.error, error);
  }

  // Private addresses only with VISOR_CITE_ALLOW_PRIVATE=1, and never in production
  const before = hits.length;
  process.env.VISOR_CITE_ALLOW_PRIVATE = '';
  r = await stu.post(url, { query: `${stubBase}/article` });
  assert.strictEqual(r.status, 422);
  process.env.VISOR_CITE_ALLOW_PRIVATE = '1';
  process.env.NODE_ENV = 'production';
  try {
    r = await stu.post(url, { query: `${stubBase}/article` });
    assert.strictEqual(r.status, 422);
  } finally { process.env.NODE_ENV = 'test'; }
  assert.strictEqual(hits.length, before, 'the stub was never reached');

  // Only the student, in their own document
  r = await teacher.post(url, { query: `${stubBase}/article` });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.data.error, 'Only the student can change their sources.');
  r = await other.post(url, { query: `${stubBase}/article` });
  assert.strictEqual(r.status, 403);

  // Works Cited off: no lookups either
  await teacher.patch(`/api/assignments/${a.id}`, { writing: { worksCited: 'off' } });
  r = await stu.post(url, { query: `${stubBase}/article` });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.data.error, 'Citations are turned off for this assignment.');
  await teacher.patch(`/api/assignments/${a.id}`, { writing: { worksCited: 'panel' } });
  r = await stu.post(url, { query: `${stubBase}/journal` });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.source.type, 'journal');

  // Submitted: no more changes
  r = await stu.post(`/api/write/${doc.id}/submit`, {});
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  r = await stu.post(url, { query: `${stubBase}/article` });
  assert.strictEqual(r.status, 409);
});

test('route: 20 lookups per student per 5 minutes', async () => {
  const teacher = client(), stu = client(), next = client();
  await signup(teacher, 'teacher', 'Rita');
  const cls = (await teacher.post('/api/classes', { name: 'History' })).data.class;
  await signup(stu, 'student', 'Lee', { classCode: cls.joinCode });
  await signup(next, 'student', 'Max', { classCode: cls.joinCode });
  const a = (await teacher.post(`/api/classes/${cls.id}/assignments`, { type: 'writing', title: 'Essay', writing: { mode: 'open' } })).data.assignment;
  await teacher.post(`/api/assignments/${a.id}/publish`, { published: true });
  const doc = (await stu.get(`/api/write/${a.id}`)).data.doc;
  for (let i = 0; i < 20; i++) assert.strictEqual((await stu.post(`/api/write/${doc.id}/sources/lookup`, { query: 'not a link' })).status, 400);
  const r = await stu.post(`/api/write/${doc.id}/sources/lookup`, { query: `${stubBase}/article` });
  assert.strictEqual(r.status, 429);
  assert.strictEqual(r.data.error, 'Too many lookups. Wait a minute, or fill in the details yourself.');
  // per student
  const doc2 = (await next.get(`/api/write/${a.id}`)).data.doc;
  assert.strictEqual((await next.post(`/api/write/${doc2.id}/sources/lookup`, { query: `${stubBase}/article` })).status, 200);
});

test('lookup: compressed data that never decodes stops at the raw-byte cap, not the timeout', async () => {
  const t = Date.now();
  await assert.rejects(L.lookup(`${stubBase}/empty-deflate`, open), refused(422, PAGE));
  assert.ok(Date.now() - t < 5000, `stopped after ${Date.now() - t} ms`);
});

test('lookup: at most a few at once on one server', async () => {
  const many = Array.from({ length: L.LIMITS.CONCURRENT + 3 }, () => L.lookup(`${stubBase}/article`, open).then(() => 'ok', e => e.status));
  const out = await Promise.all(many);
  assert.ok(out.filter(x => x === 503).length >= 1, JSON.stringify(out));
  assert.ok(out.filter(x => x === 'ok').length >= L.LIMITS.CONCURRENT - 1);
});
