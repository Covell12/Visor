/* ============================================================================
 * Adding Google Drive files to a group project (drive.js).
 * ----------------------------------------------------------------------------
 *   1. What a paste names: Docs and Slides files, each once, and why anything
 *      else isn't one.
 *   2. The addresses Visor opens: built from a checked id, never from a paste.
 *   3. Reading one file in a background tab and sending it, against a small
 *      chrome.tabs: the tab is opened, read, closed; a tab the person already
 *      had open is used as it is; and each way it can go wrong says so.
 * ==========================================================================*/

'use strict';

const { parse, openUrl, fromTabUrl, cleanTitle, importFile } = require('../drive.js');

const out = [];
const ck = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  out.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `: ${JSON.stringify(got)} (want ${JSON.stringify(want)})`}`);
};

const ID1 = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_abc-X';
const ID2 = '1ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210-zyx_Y';
const ID3 = '1Qq2Ww3Ee4Rr5Tt6Yy7Uu8Ii9Oo0Pp1Aa2Ss3Dd4Ff';
const files = (r) => r.files.map((f) => [f.fileId, f.kind, f.authuser, f.title]);
const codes = (r) => r.rejected.map((x) => x.code);

// ── 1. What a paste names ────────────────────────────────────────────────────
ck('a Doc link', files(parse(`https://docs.google.com/document/d/${ID1}/edit?usp=sharing`)), [[ID1, 'doc', null, null]]);
ck('a Slides link, opened as the second Google account', files(parse(`https://docs.google.com/presentation/u/1/d/${ID2}/edit#slide=id.p`)), [[ID2, 'slides', '1', null]]);
ck('  or naming the account by its address', files(parse(`https://docs.google.com/document/d/${ID1}/edit?authuser=sam@school.org`)), [[ID1, 'doc', 'sam@school.org', null]]);
ck('  an authuser that isn\'t an index or an address is dropped', files(parse(`https://docs.google.com/document/d/${ID1}/edit?authuser=x%26y%3Dz`)), [[ID1, 'doc', null, null]]);
ck('a school\'s old /a/<domain>/ address', files(parse(`https://docs.google.com/a/school.org/document/d/${ID1}/edit`)), [[ID1, 'doc', null, null]]);
ck('without https://, in a sentence, ending in a full stop',
  files(parse(`Our notes are at docs.google.com/document/d/${ID1}/edit. And the deck (docs.google.com/presentation/d/${ID2}/view).`)),
  [[ID1, 'doc', null, null], [ID2, 'slides', null, null]]);
ck('Drive\'s open link: the kind shows once it opens', files(parse(`https://drive.google.com/open?id=${ID3}&authuser=0`)), [[ID3, null, '0', null]]);
ck('the same file twice is one file', files(parse(`https://docs.google.com/document/d/${ID1}/edit\nhttps://docs.google.com/document/d/${ID1}/view?usp=drive_link`)), [[ID1, 'doc', null, null]]);
ck('  and an open link to a file already named keeps the kind', files(parse(`https://drive.google.com/open?id=${ID1}\nhttps://docs.google.com/document/d/${ID1}/edit`)), [[ID1, 'doc', null, null]]);
ck('a list joined with commas', files(parse(`https://docs.google.com/document/d/${ID1}/edit,https://docs.google.com/presentation/d/${ID2}/edit, docs.google.com/document/d/${ID3}`)).map((f) => f[0]), [ID1, ID2, ID3]);
ck('one per line, as Drive copies a selection', parse([1, 2, 3].map((i) => `https://docs.google.com/document/d/${ID1.slice(0, -1)}${i}/edit?usp=drive_web`).join('\n')).files.length, 3);

const rejected = parse([
  `https://docs.google.com/spreadsheets/d/${ID1}/edit`,
  `https://docs.google.com/forms/d/e/${ID2}/viewform`,
  `https://drive.google.com/drive/folders/${ID3}`,
  `https://drive.google.com/file/d/${ID1}/view?usp=sharing`,
  `https://drive.google.com/uc?id=${ID1}&export=download`,
  `https://docs.google.com/document/d/e/2PACX-1vQabcdefghijklmnopqrstuvwxyz/pub`,
  'https://drive.google.com/drive/my-drive',
  'https://docs.google.com/document/u/0/',
  'https://docs.google.com/document/d/1AbC/edit',
  'https://www.example.com/essay.docx',
  `https://docs.google.com/drawings/d/${ID2}/edit`
].join('\n'));
ck('anything else is named, with why', codes(rejected), ['sheets', 'forms', 'folder', 'uploaded', 'uploaded', 'published', 'drive-page', 'home', 'bad-id', 'not-google', 'other-app']);
ck('  and none of it is a file', rejected.files, []);
ck('  each reason is a sentence', rejected.rejected.every((x) => /[.:]/.test(x.reason) && x.reason.length > 20), true);
ck('plain words are not links', parse('my group essay, and the slides for Friday').files.length + parse('my group essay').rejected.length, 0);

// Drive's copied selection carries HTML: each file a link named after it
const html = `<meta charset="utf-8"><a href="https://docs.google.com/document/d/${ID1}/edit?usp=drive_web&amp;ouid=1">Group essay &amp; notes</a><br>`
  + `<a href='https://docs.google.com/presentation/d/${ID2}/edit?usp=drive_web'><span>Final <b>slides</b></span></a>`
  + `<a href="https://docs.google.com/document/d/${ID3}/edit">https://docs.google.com/document/d/${ID3}/edit</a>`;
ck('Drive\'s copied HTML: the files, named', files(parse('', html)), [[ID1, 'doc', null, 'Group essay & notes'], [ID2, 'slides', null, 'Final slides'], [ID3, 'doc', null, null]]);
ck('  the same files in the text as well are still one each, and keep their names',
  files(parse(`https://docs.google.com/document/d/${ID1}/edit?usp=drive_web\nhttps://docs.google.com/presentation/d/${ID2}/edit`, html)).map((f) => f[3]),
  ['Group essay & notes', 'Final slides', null]);

// ── 2. The addresses Visor opens ─────────────────────────────────────────────
ck('a Doc opens in Docs', openUrl({ fileId: ID1, kind: 'doc' }), `https://docs.google.com/document/d/${ID1}/edit`);
ck('a Slides file in Slides, as the account the link named', openUrl({ fileId: ID2, kind: 'slides', authuser: '1' }), `https://docs.google.com/presentation/d/${ID2}/edit?authuser=1`);
ck('a file of unknown kind through Drive', openUrl({ fileId: ID3, kind: null, authuser: 'sam@school.org' }), `https://drive.google.com/open?id=${ID3}&authuser=sam%40school.org`);
ck('nothing that isn\'t an id is ever put into an address',
  [openUrl({ fileId: 'abc/../../evil.example', kind: 'doc' }), openUrl({ fileId: `${ID1}?x=https://evil.example`, kind: 'doc' }), openUrl({ fileId: '', kind: 'doc' }), openUrl(null)],
  [null, null, null, null]);
ck('  nor an authuser that could carry more query', openUrl({ fileId: ID1, kind: 'doc', authuser: '0&continue=https://evil.example' }), `https://docs.google.com/document/d/${ID1}/edit`);
ck('the file a tab shows', [fromTabUrl(`https://docs.google.com/document/d/${ID1}/edit#heading=h.1`), fromTabUrl(`https://docs.google.com/presentation/d/${ID2}/edit`)],
  [{ fileId: ID1, kind: 'doc' }, { fileId: ID2, kind: 'slides' }]);
ck('  and the tabs that show none', [fromTabUrl('https://docs.google.com/document/u/0/'), fromTabUrl(`https://docs.google.com/spreadsheets/d/${ID1}/edit`), fromTabUrl('https://example.com/'), fromTabUrl(undefined)], [null, null, null, null]);
ck('a tab\'s title without Google\'s ending', [cleanTitle('Group essay - Google Docs'), cleanTitle('Deck - Google Slides'), cleanTitle('  Notes  ')], ['Group essay', 'Deck', 'Notes']);

// ── 3. Reading one file and sending it ───────────────────────────────────────
const FAST = { loadTimeoutMs: 600, readTimeoutMs: 600, pollMs: 2, settleMs: 6, stillLoadingMs: 40, driveOpenMs: 60, viewOnlyRetryMs: 6 };
const report = (fileId, people = 2) => ({
  schema: 'visor-export/1', meta: { fileId, kind: 'doc', title: 'Group essay', url: `https://docs.google.com/document/d/${fileId}/edit` },
  scope: 'the whole document', analysis: { contributors: Array.from({ length: people }, (_, i) => ({ id: String(i), name: `P${i}` })) }
});

/*
 * A chrome.tabs with one scripted page per tab. `page(tab, msg)` answers a
 * message to the content script, or returns undefined when there is none yet;
 * `nav(tab, polls)` moves the tab along (redirects, loading → complete).
 */
function makeTabs({ page, nav, existing = [] } = {}) {
  const tabs = new Map(existing.map((t) => [t.id, { ...t, polls: 0 }]));
  const log = [];
  let next = 100;
  return {
    log,
    tabs,
    api: {
      async create(o) { log.push(['create', o.url, o.active]); const t = { id: next++, url: o.url, status: 'loading', polls: 0 }; tabs.set(t.id, t); return { id: t.id }; },
      async get(id) {
        const t = tabs.get(id);
        if (!t) throw new Error(`No tab with id: ${id}`);
        t.polls++;
        if (nav) nav(t, t.polls);
        return { id: t.id, url: t.url, status: t.status };
      },
      async remove(id) { log.push(['remove', id]); tabs.delete(id); },
      async sendMessage(id, msg) {
        log.push(['msg', id, msg.type, msg.force === undefined ? undefined : msg.force, msg.whole]);
        const t = tabs.get(id);
        const r = t && page ? page(t, msg) : undefined;
        if (r === undefined) throw new Error('Could not establish connection. Receiving end does not exist.');
        return r;
      }
    }
  };
}
// The ordinary page: loads, Visor attaches on the second look, then it's complete
const docNav = (t, polls) => { if (polls >= 3) t.status = 'complete'; if (polls >= 2) t.attached = true; };
const docPage = (answers = {}) => (t, msg) => {
  if (!t.attached) return undefined;
  const id = (fromTabUrl(t.url) || {}).fileId;
  if (msg.type === 'VISOR_STATUS') return { state: (answers.status && answers.status(t)) || 'idle', meta: { fileId: id } };
  if (msg.type === 'VISOR_ANALYZE') return answers.analyze ? answers.analyze(t, msg) : { state: 'ready' };
  if (msg.type === 'VISOR_EXPORT') return answers.export ? answers.export(t, msg) : { ok: true, report: report(id) };
  return undefined;
};
const sends = [];
const sendOk = async (r) => { sends.push(r.meta.fileId); return { ok: true, to: ['Group 2'] }; };
const msgs = (log, type) => log.filter((l) => l[0] === 'msg' && l[2] === type);

(async () => {
  // A file that isn't open: opened in the background, read, closed, sent
  {
    const T = makeTabs({ page: docPage(), nav: docNav });
    const steps = [];
    const r = await importFile({ fileId: ID1, kind: 'doc' }, { tabs: T.api, send: sendOk, onStep: (s) => steps.push(s) }, FAST);
    ck('a file not open: read and sent', [r.ok, r.to, r.fileId, r.title], [true, ['Group 2'], ID1, 'Group essay']);
    ck('  opened in a background tab at the Docs address', T.log.filter((l) => l[0] === 'create'), [['create', `https://docs.google.com/document/d/${ID1}/edit`, false]]);
    ck('  read as the Visor button does, without forcing a second read', msgs(T.log, 'VISOR_ANALYZE').map((l) => l[3]), [false]);
    ck('  the whole document asked for, not the tab on screen', msgs(T.log, 'VISOR_EXPORT').map((l) => l[4]), [true]);
    ck('  the tab closed again', T.tabs.size, 0);
    ck('  closed before the upload', T.log.findIndex((l) => l[0] === 'remove') > T.log.findIndex((l) => l[2] === 'VISOR_EXPORT'), true);
    ck('  the steps the page shows', steps, ['opening', 'reading', 'sending']);
  }

  // A file the person has open, with Visor attached: used as it is
  {
    const T = makeTabs({ page: docPage(), existing: [{ id: 7, url: `https://docs.google.com/document/d/${ID2}/edit`, status: 'complete', attached: true }] });
    const r = await importFile({ fileId: ID2, kind: 'doc', tabId: 7 }, { tabs: T.api, send: sendOk }, FAST);
    ck('a file already open: read where it is', [r.ok, T.log.some((l) => l[0] === 'create')], [true, false]);
    ck('  afresh (an open tab can hold old figures)', msgs(T.log, 'VISOR_ANALYZE').map((l) => [l[1], l[3]]), [[7, true]]);
    ck('  and left open', [T.tabs.has(7), T.log.some((l) => l[0] === 'remove')], [true, false]);
  }

  // Open, but from before Visor was installed (nothing answers): opened afresh
  {
    const T = makeTabs({ page: docPage(), nav: docNav, existing: [{ id: 8, url: `https://docs.google.com/document/d/${ID1}/edit`, status: 'complete', attached: false }] });
    const r = await importFile({ fileId: ID1, kind: 'doc', tabId: 8 }, { tabs: T.api, send: sendOk }, FAST);
    ck('an open tab Visor isn\'t attached to: the file is opened in a new one', [r.ok, T.log.filter((l) => l[0] === 'create').length, T.tabs.has(8), T.log.some((l) => l[0] === 'remove' && l[1] === 8)], [true, 1, true, false]);
  }

  // View-only, asked twice (the menus may not have been built the first time)
  {
    const T = makeTabs({ page: docPage({ analyze: () => ({ state: 'view-only' }) }), nav: docNav });
    const r = await importFile({ fileId: ID1, kind: 'doc' }, { tabs: T.api, send: sendOk }, FAST);
    ck('view-only access: said so', [r.ok, r.code, /only view/.test(r.error)], [false, 'view-only', true]);
    ck('  after asking twice', msgs(T.log, 'VISOR_ANALYZE').length, 2);
    ck('  and the tab closed', T.tabs.size, 0);
  }
  {
    let n = 0;
    const T = makeTabs({ page: docPage({ analyze: () => (++n === 1 ? { state: 'view-only' } : { state: 'ready' }) }), nav: docNav });
    const r = await importFile({ fileId: ID1, kind: 'doc' }, { tabs: T.api, send: sendOk }, FAST);
    ck('  a first view-only answer that was too early is not the last word', r.ok, true);
  }

  // Drive's open link: to a Doc, or to something that isn't one
  {
    const T = makeTabs({ page: docPage(), nav: (t, p) => { if (p === 2) t.url = `https://docs.google.com/document/d/${ID3}/edit`; if (p >= 3) t.attached = true; if (p >= 4) t.status = 'complete'; } });
    const r = await importFile({ fileId: ID3, kind: null }, { tabs: T.api, send: sendOk }, FAST);
    ck('Drive\'s open link to a Doc: followed, read, sent', [r.ok, T.log[0][1], r.fileId], [true, `https://drive.google.com/open?id=${ID3}`, ID3]);
  }
  {
    // Drive answers its open link with a page of its own before moving on
    const T = makeTabs({ page: docPage(), nav: (t, p) => { if (p === 1) t.status = 'complete'; if (p === 3) { t.url = `https://drive.google.com/file/d/${ID3}/view`; t.status = 'complete'; } } });
    const r = await importFile({ fileId: ID3, kind: null }, { tabs: T.api, send: sendOk }, FAST);
    ck('  to an uploaded file: said so, closed', [r.ok, r.code, T.tabs.size], [false, 'uploaded', 0]);
  }
  {
    // Drive's open link that loads and goes nowhere (a file that doesn't exist)
    const T = makeTabs({ page: docPage(), nav: (t) => { t.status = 'complete'; } });
    const started = Date.now();
    const r = await importFile({ fileId: ID3, kind: null }, { tabs: T.api, send: sendOk }, FAST);
    ck('  to nowhere: given up on soon, not after the whole load timeout', [r.ok, r.code, T.tabs.size, Date.now() - started < FAST.loadTimeoutMs], [false, 'not-doc', 0, true]);
  }
  {
    const T = makeTabs({ page: docPage(), nav: (t) => { t.url = 'https://accounts.google.com/v3/signin/identifier?continue=x'; t.status = 'complete'; } });
    const r = await importFile({ fileId: ID1, kind: 'doc' }, { tabs: T.api, send: sendOk }, FAST);
    ck('Google asks to sign in: said so', [r.ok, r.code, /Sign in/.test(r.error), T.tabs.size], [false, 'signin', true, 0]);
  }
  {
    const T = makeTabs({ page: docPage(), nav: (t) => { t.url = `https://docs.google.com/spreadsheets/d/${ID1}/edit`; t.status = 'complete'; } });
    const r = await importFile({ fileId: ID1, kind: null }, { tabs: T.api, send: sendOk }, FAST);
    ck('  a Sheets file behind an open link: said so', [r.ok, r.code], [false, 'sheets']);
  }

  // A linked Doc reads itself when it opens: wait for that read
  {
    // The page's own read starts as Visor first asks, and takes three looks to finish
    let reading = null;
    const T = makeTabs({
      page: docPage({
        status: () => (reading == null ? 'idle' : reading-- > 0 ? 'running' : 'ready'),
        analyze: () => { if (reading == null) { reading = 3; return { state: 'running' }; } return reading > 0 ? { state: 'running' } : { state: 'ready' }; }
      }),
      nav: docNav
    });
    const r = await importFile({ fileId: ID1, kind: 'doc' }, { tabs: T.api, send: sendOk }, FAST);
    ck('a read already running is waited for, not started twice', [r.ok, msgs(T.log, 'VISOR_ANALYZE').length], [true, 2]);
  }

  // The person closes the tab while it's being read
  {
    const T = makeTabs({ nav: docNav });
    T.api.sendMessage = async (id, msg) => {
      const t = T.tabs.get(id);
      if (!t || !t.attached) throw new Error('Receiving end does not exist.');
      if (msg.type === 'VISOR_STATUS') return { state: 'idle', meta: { fileId: ID1 } };
      if (msg.type === 'VISOR_ANALYZE') { T.tabs.delete(id); throw new Error('The message port closed before a response was received.'); }
      return undefined;
    };
    const r = await importFile({ fileId: ID1, kind: 'doc' }, { tabs: T.api, send: sendOk }, FAST);
    ck('the tab closed mid-read: said so', [r.ok, r.code], [false, 'closed']);
  }

  // Nothing ever answers
  {
    const T = makeTabs({ page: () => undefined, nav: () => {} });
    const r = await importFile({ fileId: ID1, kind: 'doc' }, { tabs: T.api, send: sendOk }, FAST);
    ck('a page that never loads: gives up, closes it', [r.ok, r.code, T.tabs.size], [false, 'timeout', 0]);
  }
  {
    const T = makeTabs({ page: docPage(), nav: (t) => { t.attached = true; } });   // attached, but never "complete"
    const r = await importFile({ fileId: ID1, kind: 'doc' }, { tabs: T.api, send: sendOk }, FAST);
    ck('a page that never says it has loaded, with Visor attached: read anyway', r.ok, true);
  }

  // What the read finds, and what Visor says
  {
    const T = makeTabs({ page: docPage({ export: (t) => ({ ok: true, report: report(ID1, 0) }) }), nav: docNav });
    const r = await importFile({ fileId: ID1, kind: 'doc' }, { tabs: T.api, send: async () => { throw new Error('should not send'); } }, FAST);
    ck('a file with no edits: nothing sent', [r.ok, r.code], [false, 'empty']);
  }
  {
    const T = makeTabs({ page: docPage({ analyze: () => ({ state: 'error', error: 'Failed to fetch' }) }), nav: docNav });
    const r = await importFile({ fileId: ID1, kind: 'doc' }, { tabs: T.api, send: sendOk }, FAST);
    ck('a read that fails: said so, with Google\'s reason', [r.ok, r.code, /Failed to fetch/.test(r.error)], [false, 'read-error', true]);
  }
  {
    const T = makeTabs({ page: docPage(), nav: docNav });
    const r = await importFile({ fileId: ID1, kind: 'doc' }, { tabs: T.api, send: async () => ({ ok: false, error: 'You’re not in that project.' }) }, FAST);
    ck('Visor refuses it: Visor\'s words, and the tab already closed', [r.ok, r.code, r.error, T.tabs.size], [false, 'send', 'You’re not in that project.', 0]);
  }
  {
    const T = makeTabs({ page: docPage(), nav: docNav });
    const r = await importFile({ fileId: ID1, kind: 'doc' }, { tabs: T.api, send: async () => { throw new Error('offline'); } }, FAST);
    ck('  or can\'t be reached', [r.ok, r.code, r.error], [false, 'send', 'offline']);
  }
  {
    const T = makeTabs({ page: docPage(), nav: docNav });
    const r = await importFile({ fileId: 'not an id', kind: 'doc' }, { tabs: T.api, send: sendOk }, FAST);
    ck('an id that isn\'t one is never opened', [r.ok, T.log.length], [false, 0]);
  }

  console.log(out.every(Boolean) ? `\nall passed (${out.length} checks)` : `\n${out.filter((x) => !x).length} FAILED`);
  process.exit(out.every(Boolean) ? 0 : 1);
})();
