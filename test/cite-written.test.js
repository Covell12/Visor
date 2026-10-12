// Written sources (type 'written'): a citation the student wrote or pasted
// whole. How lib/cite.js (= public/cite-format.js) formats one, the in-text
// guesses for MLA, APA and Chicago, and the sources routes adding, editing and
// deleting one. Runs on a local PGlite store in a temp folder; nothing here
// reaches Firebase, Google or Gemini (their settings are blanked and pointed
// at a closed local port).
'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-written-'));
Object.assign(process.env, {
  VISOR_PLATFORM: '', DATABASE_URL: '',
  PGLITE_DIR: path.join(DATA, 'pglite'), VISOR_IMAGE_DIR: path.join(DATA, 'images'), VISOR_AUDIO_DIR: path.join(DATA, 'audio'),
  VISOR_DEV_LOGIN: '1', SESSION_SECRET: 'test-secret', NODE_ENV: 'test',
  GEMINI_API_KEY: '', GEMINI_VIA: 'apikey', GEMINI_BASE_URL: 'http://127.0.0.1:9', VERTEX_BASE_URL: 'http://127.0.0.1:9', DRIVE_API_BASE: 'http://127.0.0.1:9',
  GOOGLE_CLIENT_ID: '', GOOGLE_API_KEY: '', GOOGLE_APP_ID: '', CLASSROOM_IMPORT: '',
  CROSSREF_BASE: 'http://127.0.0.1:9', OPENLIBRARY_BASE: 'http://127.0.0.1:9'
});

const test = require('node:test');
const assert = require('node:assert');
const C = require('../lib/cite');
const app = require('../server');

let server, base;
test.before(async () => {
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); fs.rmSync(DATA, { recursive: true, force: true }); });

/* ---------------- formatting ---------------- */

const W = (written, inTextWritten) => ({ type: 'written', written, ...(inTextWritten !== undefined ? { inTextWritten } : {}) });

test('written: the text as written, squashed, with *asterisks* for italics', () => {
  const f = C.format(W('  Smith, John.  *The Sleep Book*.\n Penguin,   2020. '), 'mla');
  assert.deepStrictEqual(f, {
    text: 'Smith, John. The Sleep Book. Penguin, 2020.',
    html: 'Smith, John. <i>The Sleep Book</i>. Penguin, 2020.',
    inText: '(Smith)', sortKey: 'smith, john. the sleep book. penguin, 2020.', check: []
  });
  // HTML is escaped; a lone asterisk, or one with a space inside, stays as it is
  const g = C.format(W('A <b>bold</b> & "quoted" *title*: 5 * 3 = 15, ** and *x*'), 'apa');
  assert.strictEqual(g.html, 'A &lt;b&gt;bold&lt;/b&gt; &amp; &quot;quoted&quot; <i>title</i>: 5 * 3 = 15, ** and <i>x</i>');
  assert.strictEqual(g.text, 'A <b>bold</b> & "quoted" title: 5 * 3 = 15, ** and x');
  // Students are responsible for written ones: nothing to check, in any style
  for (const style of C.STYLES) assert.deepStrictEqual(C.format(W('Smith, John. Sleep.'), style).check, []);
});

test('written: in-text guesses for MLA, Chicago and APA', () => {
  const cases = [
    // [written, mla/chicago, apa]
    ['Smith, John. *The Sleep Book*. Penguin, 2020.', '(Smith)', '(Smith, n.d.)'],
    ['Smith, J. (2021, March 3). *Sleep and school*. Example News.', '(Smith)', '(Smith, 2021)'],
    ['Lopez, M., & Brooks, D. (2024). Later start times. *Sleep*, 3(2), 1-9.', '(Lopez)', '(Lopez, 2024)'],
    ['Reyes, J. (n.d.). Sleep and your health.', '(Reyes)', '(Reyes, n.d.)'],
    ['“How Much Sleep Do Teens Need?” Sleep Foundation, 10 June 2021.', '(How)', '(How, n.d.)'],
    ['O’Brien. Sleep Facts.', '(O’Brien)', '(O’Brien, n.d.)'],
    ['*Sleep-Wake Cycles.* Health Press', '(Sleep-Wake)', '(Sleep-Wake, n.d.)']
  ];
  for (const [w, mla, apa] of cases) {
    assert.strictEqual(C.format(W(w), 'mla').inText, mla, w);
    assert.strictEqual(C.format(W(w), 'chicago').inText, mla, w);
    assert.strictEqual(C.format(W(w), 'apa').inText, apa, w);
  }
  // The student's own in-text citation wins, squashed
  assert.strictEqual(C.format(W('Smith, John. Sleep.', '  (Smith   12) '), 'mla').inText, '(Smith 12)');
  assert.strictEqual(C.format(W('Smith, J. (2021). Sleep.', '(Smith, 2021, p. 4)'), 'apa').inText, '(Smith, 2021, p. 4)');
  assert.strictEqual(C.format(W('Smith, J. (2021). Sleep.', ''), 'apa').inText, '(Smith, 2021)', 'empty means guess');
  // Nothing written: still no throw
  assert.strictEqual(C.format(W(''), 'mla').text, '');
});

test('written: bibliography() sorts written sources in with the others', () => {
  const sources = [
    { type: 'webpage', title: 'Sleep and Your Health', authors: ['Jordan Reyes'], siteName: 'Healthy Teens Blog', url: 'https://healthyteens.example.org/sleep', accessed: '2026-10-12' },
    W('Wahlstrom, Kyla. *Start Times*. 2017.'),
    W('*The Moon and Sleep*. NASA, 2020.'),
    { type: 'journal', title: 'Delaying School Start Times', authors: ['Owens, Judith A.'], published: '2017', journal: 'Journal of Adolescent Health' },
    W('Adams, Ann. Zebras Sleep Standing Up. 2019.')
  ];
  const bib = C.bibliography(sources, 'mla');
  assert.deepStrictEqual(bib.items.map(i => i.text.slice(0, 12)), ['Adams, Ann. ', 'The Moon and', 'Owens, Judit', 'Reyes, Jorda', 'Wahlstrom, K']);
  assert.strictEqual(bib.items[1].html, '<i>The Moon and Sleep</i>. NASA, 2020.');
});

/* ---------------- the routes ---------------- */

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
  return { get: u => call('GET', u, null), post: (u, b) => call('POST', u, b || {}), patch: (u, b) => call('PATCH', u, b), del: u => call('DELETE', u, null) };
}
let people = 0;
async function signup(c, role, firstName, extra = {}) {
  const r = await c.post('/api/auth/signup', { email: `${firstName.toLowerCase()}${++people}@written.test`, password: 'secret12', firstName, lastName: role === 'teacher' ? 'Teacher' : 'Student', role, ...(role === 'student' ? { over13: true } : {}), ...extra });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return r.data.user;
}
async function essay(style) {
  const teacher = client(), stu = client();
  await signup(teacher, 'teacher', 'Tess');
  const cls = (await teacher.post('/api/classes', { name: 'English 10' })).data.class;
  await signup(stu, 'student', 'Sam', { classCode: cls.joinCode });
  const a = (await teacher.post(`/api/classes/${cls.id}/assignments`, { type: 'writing', title: 'Sleep essay', writing: { mode: 'open', citationStyle: style } })).data.assignment;
  await teacher.post(`/api/assignments/${a.id}/publish`, { published: true });
  const doc = (await stu.get(`/api/write/${a.id}`)).data.doc;
  return { teacher, stu, a, doc };
}

test('route: a written source is added, formatted, edited and deleted (MLA)', async () => {
  const { stu, a, doc } = await essay('mla');
  const url = `/api/write/${doc.id}/sources`;

  // Empty text is refused, even with a title; other sources keep their rule
  for (const source of [{ type: 'written' }, { type: 'written', written: '  \n ' }, { type: 'written', written: '', title: 'A Title' }]) {
    const r = await stu.post(url, { source });
    assert.strictEqual(r.status, 400, JSON.stringify(source));
    assert.strictEqual(r.data.error, 'Write or paste the citation.');
  }
  let r = await stu.post(url, { source: { type: 'webpage' } });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.data.error, 'A source needs at least a title or a link.');

  r = await stu.post(url, { source: { type: 'written', written: '  Smith, John.\n *The Sleep Book*.  Penguin, 2020. ' } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  const s = r.data.source;
  assert.strictEqual(r.data.existing, false);
  assert.strictEqual(s.type, 'written');
  assert.strictEqual(s.written, 'Smith, John. *The Sleep Book*. Penguin, 2020.', 'one line, whitespace collapsed');
  assert.strictEqual(s.formatted, 'Smith, John. The Sleep Book. Penguin, 2020.');
  assert.strictEqual(s.formattedHtml, 'Smith, John. <i>The Sleep Book</i>. Penguin, 2020.');
  assert.strictEqual(s.inText, '(Smith)');
  assert.deepStrictEqual(s.check, []);
  assert.strictEqual(s.style, 'mla');

  // Written sources never count as "the same page": not with each other, not with a cited page
  r = await stu.post(url, { source: { title: 'Teens and Sleep', url: 'https://example.org/sleep' } });
  const page = r.data.source;
  r = await stu.post(url, { source: { type: 'written', written: 'Lopez, Maria. “Teens and Sleep.” example.org/sleep.', url: 'https://example.org/sleep' } });
  assert.strictEqual(r.data.existing, false);
  const w2 = r.data.source;
  assert.notStrictEqual(w2.id, page.id);
  r = await stu.post(url, { source: { type: 'written', written: 'Lopez, Maria. “Teens and Sleep.” example.org/sleep.', url: 'https://example.org/sleep' } });
  assert.strictEqual(r.data.existing, false);
  assert.strictEqual(r.data.sources.length, 4);
  // ...while the same page twice is still one source
  r = await stu.post(url, { source: { title: 'Teens and Sleep', url: 'https://example.org/sleep' } });
  assert.strictEqual(r.data.existing, true);
  assert.strictEqual(r.data.source.id, page.id);
  assert.strictEqual(r.data.sources.length, 4);
  const extra = r.data.sources[3];

  // At most 1,500 characters, and 120 for the in-text citation
  r = await stu.post(url, { source: { type: 'written', written: 'Long, Ann. ' + 'x'.repeat(3000), inTextWritten: '(' + 'y'.repeat(300) + ')' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.source.written.length, 1500);
  assert.strictEqual(r.data.source.inTextWritten.length, 120);
  const long = r.data.source;

  // Edit: new text, then the student's own in-text citation, then back to the guess
  r = await stu.patch(`${url}/${s.id}`, { source: { written: 'Smyth, John. *The Sleep Book*. 2nd ed., Penguin, 2021.' } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.source.type, 'written');
  assert.strictEqual(r.data.source.formattedHtml, 'Smyth, John. <i>The Sleep Book</i>. 2nd ed., Penguin, 2021.');
  assert.strictEqual(r.data.source.inText, '(Smyth)');
  assert.ok(r.data.source.editedAt);
  r = await stu.patch(`${url}/${s.id}`, { source: { inTextWritten: '(Smyth 12)' } });
  assert.strictEqual(r.data.source.inText, '(Smyth 12)');
  assert.strictEqual(r.data.source.written, 'Smyth, John. *The Sleep Book*. 2nd ed., Penguin, 2021.');
  r = await stu.patch(`${url}/${s.id}`, { source: { inTextWritten: '' } });
  assert.strictEqual(r.data.source.inText, '(Smyth)');

  // A written source can become a filled-in one, and back
  r = await stu.patch(`${url}/${w2.id}`, { source: { type: 'webpage', title: 'Teens and Sleep', authors: ['Maria Lopez'], siteName: 'Example' } });
  assert.strictEqual(r.data.source.type, 'webpage');
  assert.match(r.data.source.formatted, /^Lopez, Maria\. “Teens and Sleep\.” Example, example\.org\/sleep\./);
  r = await stu.patch(`${url}/${w2.id}`, { source: { type: 'written' } });
  assert.strictEqual(r.data.source.formatted, 'Lopez, Maria. “Teens and Sleep.” example.org/sleep.');

  // Delete
  for (const id of [w2.id, extra.id, long.id]) assert.strictEqual((await stu.del(`${url}/${id}`)).status, 200);
  r = await stu.get(`/api/write/${a.id}`);
  assert.deepStrictEqual(r.data.doc.sources.map(x => x.id).sort(), [s.id, page.id].sort());
});

test('route: written sources in APA guess "(Word, year)" or "(Word, n.d.)"', async () => {
  const { stu, doc } = await essay('apa');
  const url = `/api/write/${doc.id}/sources`;
  let r = await stu.post(url, { source: { type: 'written', written: 'Smith, J. (2021, March 3). *Sleep and school*. Example News.' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.source.inText, '(Smith, 2021)');
  assert.strictEqual(r.data.source.style, 'apa');
  r = await stu.post(url, { source: { type: 'written', written: 'Reyes, J. Sleep and your health. Healthy Teens Blog.' } });
  assert.strictEqual(r.data.source.inText, '(Reyes, n.d.)');
  r = await stu.post(url, { source: { type: 'written', written: 'Reyes, J. Sleep and your health.', inTextWritten: '(Reyes, 2019)' } });
  assert.strictEqual(r.data.source.inText, '(Reyes, 2019)');
});
