/* ============================================================================
 * Citation details from a page: cite.js extractCitationMeta().
 * ----------------------------------------------------------------------------
 * Fixture pages for each source of metadata: Highwire tags (a journal),
 * JSON-LD (a news article with several authors), OpenGraph only, a YouTube
 * video, and a bare page with nothing but a <title>.
 * ==========================================================================*/

'use strict';

const { extractCitationMeta, stripSiteFromTitle, normDate } = require('../cite.js');
const { parseHtml } = require('./html');

const out = [];
const ck = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  out.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `: ${JSON.stringify(got)} (want ${JSON.stringify(want)})`}`);
};
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));
const read = (html, url) => extractCitationMeta(parseHtml(html), url);

// ── Highwire: a journal article ───────────────────────────────────────────
{
  const m = read(`<!doctype html><html><head><title>Sleep and school start times | Journal of Adolescent Health</title>
    <meta name="citation_title" content="Delaying School Start Times and Adolescent Sleep">
    <meta name="citation_author" content="Wahlstrom, Kyla L.">
    <meta name="citation_author" content="Owens, Judith A.">
    <meta name="citation_author" content="mailto:someone@example.org">
    <meta name="citation_publication_date" content="2017/06/15">
    <meta name="citation_journal_title" content="Journal of Adolescent Health">
    <meta name="citation_volume" content="60"><meta name="citation_issue" content="6">
    <meta name="citation_firstpage" content="627"><meta name="citation_lastpage" content="633">
    <meta name="citation_doi" content="doi:10.1016/j.jadohealth.2017.01.011">
    <meta name="citation_publisher" content="Elsevier">
    <meta property="og:title" content="A different OG title">
    <link rel="canonical" href="https://www.jahonline.org/article/S1054-139X(17)30039-9/fulltext">
  </head><body></body></html>`, 'https://www.jahonline.org/article/S1054-139X(17)30039-9/fulltext?utm=x');
  ck('Highwire: title wins over OpenGraph', m.title, 'Delaying School Start Times and Adolescent Sleep');
  ck('Highwire: authors in order, email dropped', m.authors, ['Wahlstrom, Kyla L.', 'Owens, Judith A.']);
  ck('Highwire: journal fields', pick(m, ['published', 'journal', 'volume', 'issue', 'pages', 'doi', 'publisher', 'type']),
    { published: '2017-06-15', journal: 'Journal of Adolescent Health', volume: '60', issue: '6', pages: '627-633', doi: '10.1016/j.jadohealth.2017.01.011', publisher: 'Elsevier', type: 'journal' });
  ck('Highwire: canonical URL', m.canonicalUrl, 'https://www.jahonline.org/article/S1054-139X(17)30039-9/fulltext');
}

// ── JSON-LD: a news article with an author array ───────────────────────────
{
  const m = read(`<html><head><title>Why teens can't fall asleep - The Example Times</title>
    <meta property="og:site_name" content="The Example Times">
    <script type="application/ld+json">{"@context":"https://schema.org","@graph":[
      {"@type":"WebPage","name":"Why teens can't fall asleep"},
      {"@type":"NewsArticle","headline":"Why Teens Can’t Fall Asleep Before 11","datePublished":"2023-09-05T08:00:00-04:00","dateModified":"2023-09-06T10:00:00Z",
       "author":[{"@type":"Person","name":"Maria  Lopez"},{"@type":"Person","name":"https://example.com/staff/dan"},{"@type":"Person","name":"Dan Brooks"}],
       "publisher":{"@type":"Organization","name":"Example Media Group"}}]}</script>
    <script type="application/ld+json">{ this is broken json </script>
    <meta name="author" content="Someone Else">
  </head></html>`, 'https://www.example-times.com/2023/09/05/health/teens-sleep.html');
  ck('JSON-LD: the article, not the page', m.title, 'Why Teens Can’t Fall Asleep Before 11');
  ck('JSON-LD: author array, whitespace squashed, URL dropped', m.authors, ['Maria Lopez', 'Dan Brooks']);
  ck('JSON-LD: dates, site, publisher, type', pick(m, ['published', 'modified', 'siteName', 'publisher', 'type']),
    { published: '2023-09-05', modified: '2023-09-06', siteName: 'The Example Times', publisher: 'Example Media Group', type: 'article' });
}

// ── OpenGraph only ─────────────────────────────────────────────────────────
{
  const m = read(`<html><head><title>Sleep tips for students | Healthy Teens Blog</title>
    <meta property="og:title" content="10 Sleep Tips for Students">
    <meta property="og:site_name" content="Healthy Teens Blog">
    <meta property="og:type" content="article">
    <meta property="article:published_time" content="2022-01-20T12:00:00Z">
    <meta property="article:author" content="https://www.facebook.com/healthyteens">
  </head></html>`, 'https://healthyteens.example.org/sleep-tips');
  ck('OG: title and site', pick(m, ['title', 'siteName', 'published', 'type']), { title: '10 Sleep Tips for Students', siteName: 'Healthy Teens Blog', published: '2022-01-20', type: 'article' });
  ck('OG: an article:author that is a URL is not an author', m.authors, []);
}

// ── YouTube: the channel is the author ─────────────────────────────────────
{
  const m = read(`<html><head><title>Why Do We Sleep? - YouTube</title>
    <meta property="og:title" content="Why Do We Sleep?">
    <meta property="og:site_name" content="YouTube">
    <meta property="og:type" content="video.other">
    <meta itemprop="name" content="Why Do We Sleep?">
    <meta itemprop="uploadDate" content="2019-05-12T07:00:02-07:00">
    <link itemprop="url" href="http://www.youtube.com/@ExampleScience">
    <link itemprop="name" content="Example Science">
  </head></html>`, 'https://www.youtube.com/watch?v=abc123');
  ck('YouTube: channel as author', m.authors, ['Example Science']);
  ck('YouTube: video fields', pick(m, ['title', 'siteName', 'published', 'type']), { title: 'Why Do We Sleep?', siteName: 'YouTube', published: '2019-05-12', type: 'video' });
}

// ── A bare page: only a <title> ────────────────────────────────────────────
{
  const m = read(`<html><head><title>  How Much Sleep Do I Need?   |   Sleep Foundation </title></head><body>…</body></html>`, 'https://www.sleepfoundation.example/how-much-sleep');
  ck('bare: title with the site suffix stripped', m.title, 'How Much Sleep Do I Need?');
  ck('bare: nothing else made up', pick(m, ['authors', 'published', 'siteName', 'doi', 'type']), { authors: [], published: '', siteName: '', doi: '', type: 'webpage' });
  ck('bare: the URL is kept', m.url, 'https://www.sleepfoundation.example/how-much-sleep');
}

// ── Helpers ────────────────────────────────────────────────────────────────
ck('stripSiteFromTitle with a known site', stripSiteFromTitle('Teen Sleep — The Atlantic', 'The Atlantic'), 'Teen Sleep');
ck('stripSiteFromTitle keeps short titles whole', stripSiteFromTitle('A - B', ''), 'A - B');
ck('normDate', [normDate('2021'), normDate('2021-3-4'), normDate('March 4, 2021 12:00 UTC'), normDate('nonsense')], ['2021', '2021-03-04', '2021-03-04', '']);
ck('long titles are capped', read(`<title>${'x'.repeat(500)}</title>`, 'https://a.example/').title.length, 300);

console.log(out.every(Boolean) ? `\nall passed (${out.length} checks)` : `\n${out.filter((x) => !x).length} FAILED`);
process.exit(out.every(Boolean) ? 0 : 1);
