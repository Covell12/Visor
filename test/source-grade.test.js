// lib/source-grade.js (= public/source-grade.js): each source's reliability
// grade, A to D, and the reasons it gives, for sources like the ones students
// add. Everything is local: the grade never looks anything up.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const G = require('../lib/source-grade');
const { DEFAULT_AI_SITES } = require('../lib/sites');

const now = Date.parse('2026-11-01T12:00:00Z');
const grade = s => G.grade({ authors: [], ...s }, { now });
const letter = s => (grade(s) || {}).letter || null;
const page = (url, more) => ({ type: 'webpage', url, ...more });

test('the browser copy and the server copy are the same file', () => {
  const pub = fs.readFileSync(path.join(__dirname, '..', 'public', 'source-grade.js'), 'utf8');
  const lib = fs.readFileSync(path.join(__dirname, '..', 'lib', 'source-grade.js'), 'utf8');
  assert.strictEqual(lib, pub, 'run `npm run sync-engine`');
});

// The extension's session panel grades the page in front with its own copy
test('the extension\'s copy is the same file too', t => {
  const ext = path.join(__dirname, '..', '..', 'extension', 'source-grade.js');
  if (!fs.existsSync(ext)) { t.skip('extension/ not next to web-app/; comparison skipped'); return; }
  const pub = fs.readFileSync(path.join(__dirname, '..', 'public', 'source-grade.js'), 'utf8');
  assert.strictEqual(fs.readFileSync(ext, 'utf8'), pub, 'copy public/source-grade.js to the extension');
});

test('the kind of site decides the grade', () => {
  const want = [
    ['A', page('https://www.cdc.gov/sleep/about.html'), 'gov'],
    ['A', page('https://www.nhs.uk/conditions/insomnia/'), 'gov'],
    ['A', page('https://www.gov.uk/government/statistics'), 'gov'],
    ['A', page('https://www.who.int/news-room/fact-sheets/detail/x'), 'intl'],
    ['A', page('https://pubmed.ncbi.nlm.nih.gov/12345/'), 'scholarly'],
    ['A', page('https://www.jstor.org/stable/123'), 'scholarly'],
    ['B', page('https://apnews.com/article/x', { authors: ['Jo Reyes'], published: '2025-04-01' }), 'news'],
    ['B', page('https://www.bbc.co.uk/news/x', { authors: ['Jo Reyes'], published: '2025-04-01' }), 'news'],
    ['B', page('https://www.britannica.com/science/sleep'), 'reference'],
    ['B', page('https://www.mayoclinic.org/healthy-lifestyle/x'), 'org'],
    ['B', page('https://www.stanford.edu/research/x'), 'edu'],
    ['B', page('https://www.ox.ac.uk/news/x'), 'edu'],
    ['C', page('https://en.wikipedia.org/wiki/Sleep'), 'wiki'],
    ['C', page('https://arxiv.org/abs/2401.00001', { authors: ['A B'], published: '2024' }), 'preprint'],
    ['C', page('https://www.researchgate.net/publication/1'), 'upload'],
    ['C', page('https://www.academia.edu/123/x'), 'upload'],
    ['D', page('https://www.reddit.com/r/sleep/x', { authors: ['someone'] }), 'social'],
    ['D', page('https://www.tiktok.com/@x/video/1'), 'social'],
    ['D', page('https://www.sparknotes.com/lit/gatsby/'), 'study'],
    ['D', page('https://chatgpt.com/share/abc'), 'ai'],
    ['D', page('https://www.theonion.com/x'), 'satire'],
    ['D', page('https://www.google.com/search?q=sleep'), 'search'],
    ['D', page('https://www.google.co.uk/search?q=sleep'), 'search'],
    ['D', page('https://scholar.google.com/scholar?q=sleep'), 'search']
  ];
  for (const [l, src, kind] of want) {
    const g = grade(src);
    assert.ok(g, src.url);
    assert.strictEqual(g.kind, kind, src.url);
    assert.strictEqual(g.letter, l, `${src.url}: ${g.score}`);
    assert.ok(g.label && g.why && g.word, src.url);
  }
});

test('a path can change the kind: Forbes contributors, Nature news, the Google sites', () => {
  assert.strictEqual(grade(page('https://www.forbes.com/sites/someone/2025/x', { authors: ['A'], published: '2025' })).kind, 'selfpub');
  assert.strictEqual(grade(page('https://www.forbes.com/2025/x', { authors: ['A'], published: '2025' })).kind, 'news');
  assert.strictEqual(grade(page('https://www.nature.com/articles/d41586-025-00001-1', { authors: ['A'], published: '2025' })).kind, 'news');
  assert.strictEqual(grade({ type: 'journal', url: 'https://www.nature.com/articles/s41586-025-00001-1', authors: ['A'], published: '2025' }).kind, 'scholarly');
  assert.strictEqual(grade(page('https://docs.google.com/document/d/abc/edit')).kind, 'selfpub');
  assert.strictEqual(grade(page('https://sites.google.com/view/x')).kind, 'selfpub');
  assert.strictEqual(grade(page('https://books.google.com/books?id=x')).kind, 'reference');
});

test('author and date move a website, a blog or a video, within limits', () => {
  const full = { authors: ['Jordan Reyes'], published: '2024-06-10' };
  // A website Visor doesn't know: C with both, still C with one, D with neither
  assert.strictEqual(grade(page('https://healthyteens.example.org/sleep', full)).letter, 'C');
  assert.strictEqual(grade(page('https://healthyteens.example.org/sleep', { authors: ['Jordan Reyes'] })).letter, 'C');
  const bare = grade(page('https://healthyteens.example.org/sleep'));
  assert.strictEqual(bare.letter, 'D');
  assert.deepStrictEqual(bare.notes.map(n => n.effect), [-1, -1]);
  assert.match(bare.notes[0].text, /No author/);
  // Both can't lift a website to B
  assert.ok(grade(page('https://healthyteens.example.org/sleep', full)).score <= 69);
  // A blog: a low C at best
  assert.strictEqual(grade(page('https://someone.medium.com/sleep', full)).letter, 'C');
  assert.strictEqual(grade(page('https://someone.medium.com/sleep')).letter, 'D');
  // A video: the channel counts as its author
  assert.strictEqual(grade({ type: 'video', url: 'https://www.youtube.com/watch?v=abc123', authors: ['Example Science'], published: '2019-05-12' }).letter, 'C');
  assert.strictEqual(grade({ type: 'video', url: 'https://www.youtube.com/watch?v=abc123' }).letter, 'D');
  // Government and journals don't need either
  assert.strictEqual(grade(page('https://www.cdc.gov/x')).notes.length, 0);
});

test('news: no author, no date, old, or opinion each count against it', () => {
  const g = grade(page('https://www.nytimes.com/2010/01/02/us/x.html', { published: '2010-01-02' }));
  assert.strictEqual(g.letter, 'C');
  assert.deepStrictEqual(g.notes.map(n => n.text), ['No author named.', 'From 2010: check it’s still up to date.']);
  const op = grade(page('https://www.nytimes.com/2025/01/02/opinion/x.html', { authors: ['A'], published: '2025-01-02' }));
  assert.strictEqual(op.letter, 'C');
  assert.match(op.notes[0].text, /opinion piece/);
});

test('DOIs, journals and books', () => {
  // A DOI makes a site Visor doesn't know a published paper
  const doi = grade({ type: 'journal', doi: '10.1016/j.jadohealth.2017.01.011', journal: 'Journal of Adolescent Health', url: 'https://www.jahonline.org/article/x', authors: ['Kyla Wahlstrom'], published: '2017-06-15' });
  assert.strictEqual(doi.letter, 'A');
  assert.match(doi.notes[0].text, /DOI/);
  assert.strictEqual(letter({ type: 'webpage', url: 'https://somejournal.example.com/x', doi: '10.1000/xyz123' }), 'A');
  assert.strictEqual(letter({ type: 'journal', journal: 'Sleep', title: 'x' }), 'A');
  // A journal type with nothing else is only what the student typed
  assert.strictEqual(letter({ type: 'journal', title: 'x' }), null);
  // Books
  assert.strictEqual(letter({ type: 'book', title: 'x', publisher: 'Oxford University Press', authors: ['A'], published: '2015' }), 'A');
  assert.strictEqual(letter({ type: 'book', title: 'x', publisher: 'MIT Press', authors: ['A'], published: '2015' }), 'A');
  assert.strictEqual(letter({ type: 'book', title: 'x', publisher: 'Penguin', authors: ['A'], published: '2015' }), 'B');
  assert.strictEqual(letter({ type: 'book', title: 'x', publisher: 'Penguin', published: '2015' }), 'C');
  const old = grade({ type: 'book', title: 'x', publisher: 'Penguin', authors: ['A'], published: '1990' });
  assert.strictEqual(old.letter, 'B');
  assert.deepStrictEqual(old.notes, [{ text: 'From 1990: look for newer research on the same question.', effect: 0 }]);
});

test('nothing to grade from: no link, no DOI, no publisher', () => {
  assert.strictEqual(grade({ type: 'webpage', title: 'Only a title' }), null);
  assert.strictEqual(grade({ type: 'book', title: 'A book' }), null);
  assert.strictEqual(grade({ type: 'written', written: 'Smith, J. *Sleep.* Penguin, 2020.' }), null);
  assert.strictEqual(G.grade(null), null);
  assert.strictEqual(grade(page('ftp://example.com/x')), null);
  assert.strictEqual(grade(page('not a link at all')), null);
});

test('a written citation is graded from the link or DOI in it', () => {
  const w = grade({ type: 'written', written: 'Smith, J. *Sleep.* www.sleepblog.wordpress.com/x. Accessed 2 Jan. 2024.' });
  assert.strictEqual(w.kind, 'selfpub');
  assert.strictEqual(w.letter, 'D');
  assert.deepStrictEqual(w.notes, [{ text: 'Graded from the link in your citation.', effect: 0 }]);
  const d = grade({ type: 'written', written: 'Smith, J. (2020). Sleep. Sleep Journal, 2(3). https://doi.org/10.1000/xyz123.' });
  assert.strictEqual(d.letter, 'A');
  assert.strictEqual(d.notes[d.notes.length - 1].text, 'Graded from the DOI in your citation.');
});

test('an archived copy is graded by the page it saved', () => {
  const g = grade(page('https://web.archive.org/web/20190101000000/https://www.cdc.gov/sleep/x.html'));
  assert.strictEqual(g.kind, 'gov');
  assert.strictEqual(g.host, 'cdc.gov');
  assert.match(g.notes[0].text, /archived copy/);
});

test('an archived address with a % that isn\'t an escape is still graded by the page it saved', () => {
  const g = grade(page('https://web.archive.org/web/20190101000000/https://www.cdc.gov/sleep/100%-rest.html'));
  assert.strictEqual(g.kind, 'gov');
  assert.strictEqual(g.host, 'cdc.gov');
});

test('every AI or answer site on the blocked-sites list grades D', () => {
  for (const site of DEFAULT_AI_SITES) {
    const g = grade(page(`https://${site}/x`));
    assert.ok(g, site);
    assert.strictEqual(g.letter, 'D', `${site} -> ${g.kind} ${g.score}`);
    assert.ok(['ai', 'study'].includes(g.kind), `${site} -> ${g.kind}`);
  }
});

test('lookalike addresses are not the sites they imitate', () => {
  // Not x.com, not cdc.gov, not .edu
  assert.strictEqual(grade(page('https://max.com/x', { authors: ['A'], published: '2025' })).kind, 'web');
  assert.strictEqual(grade(page('https://cdc.gov.example.com/x')).kind, 'web');
  assert.strictEqual(grade(page('https://abcnews.com.co/x')).kind, 'web');
  assert.strictEqual(grade(page('https://www.edu-help.com/x')).kind, 'web');
  const xyz = grade(page('https://real-news-today.xyz/x'));
  assert.strictEqual(xyz.letter, 'D');
  assert.match(xyz.notes[xyz.notes.length - 1].text, /ends in \.xyz/);
});

test('gradeUrl: the same grade for a bare address', () => {
  assert.strictEqual(G.gradeUrl('https://www.cdc.gov/x', { now }).letter, 'A');
  assert.strictEqual(G.gradeUrl('reddit.com/r/x', { now }).letter, 'D');
  assert.strictEqual(G.gradeUrl('', { now }), null);
});

test('grades are A to D, and every kind has a label and a reason', () => {
  for (const [k, v] of Object.entries(G.KINDS)) {
    assert.ok(v.label && v.why && Number.isFinite(v.base), k);
    assert.doesNotMatch(v.why, /\bAI-generated\b/i, k);
  }
  assert.deepStrictEqual(G.GRADES.map(g => g.letter), ['A', 'B', 'C', 'D']);
  for (const [kind] of G.SITES) assert.ok(G.KINDS[kind], kind);
});
