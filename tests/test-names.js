/* ============================================================================
 * Naming the people in a document's history.
 * ----------------------------------------------------------------------------
 * fetchChangelog runs against a stand-in for the Docs revision endpoints (a
 * fetch that answers from a made-up history), so each way a name used to go
 * missing can be set up exactly:
 *   - someone who first writes deep into a long history, past where the
 *     roster pages used to stop, with the one big roster call coming back capped
 *   - a roster whose records come as lists rather than objects
 *   - the person signed in, whom Google's roster leaves nameless
 *   - edits the log gives no author for: text, and formatting
 * Nothing here reaches Google.
 * ==========================================================================*/

'use strict';

const out = [];
const ck = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  out.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `: ${JSON.stringify(got)} (want ${JSON.stringify(want)})`}`);
};

/**
 * A made-up document: `rows` is [[userId|null, text], ...], one revision each.
 * `roster(start, size)` is what a tile window's userMap holds; by default the
 * people who edit inside the window, capped at 1500 revisions however big the
 * window asked for (as a long history can come back capped).
 */
function stand_in({ rows, people, rosterAsLists = false, cap = 1500, pageHtml = '' }) {
  const t0 = Date.UTC(2026, 9, 1, 8);
  let len = 0;
  const log = rows.map(([uid, text], i) => {
    const m = text ? { ty: 'is', ibi: len + 1, s: text } : { ty: 'as', st: 'text', si: 1, ei: 1, sm: {} };
    len += text ? text.length : 0;
    const row = [m, t0 + i * 2000];
    if (uid) row.push(uid);
    return row;
  });
  const calls = { tiles: [] };
  global.document = { documentElement: { innerHTML: pageHtml } };
  global.fetch = async (url) => {
    const u = new URL(url);
    const start = +u.searchParams.get('start');
    let body;
    if (u.pathname.endsWith('/revisions/tiles')) {
      const size = Math.min(+u.searchParams.get('revisionBatchSize'), cap);
      calls.tiles.push([start, size]);
      const end = Math.min(log.length, start + size - 1);
      const ids = new Set(rows.slice(start - 1, end).map((r) => r[0]).filter(Boolean));
      const userMap = {};
      for (const id of ids) if (people[id]) userMap[id] = rosterAsLists ? [people[id], '#3367d6', 'https://lh3.example/p.png', false] : { name: people[id], anonymous: false, color: '#3367d6' };
      body = { tileInfo: [{ start: 1, end: log.length }], userMap };
    } else {
      const end = +u.searchParams.get('end');
      body = { changelog: log.slice(start - 1, end) };
    }
    return { ok: true, text: async () => `)]}'\n${JSON.stringify(body)}` };
  };
  delete require.cache[require.resolve('../changelog.js')];
  return { VisorChangelog: require('../changelog.js').VisorChangelog, calls };
}

const names = (VisorChangelog, res) => VisorChangelog.analyze(VisorChangelog.buildTimeline(res.entries, res.users)).contributors.map((c) => c.name).sort();

(async () => {
  // ── Someone who joins deep into a long history ─────────────────────────────
  {
    const rows = [];
    for (let i = 0; i < 25000; i++) rows.push([i < 24000 ? 'A1' : (i % 2 ? 'A1' : 'B2'), 'x']);
    const { VisorChangelog, calls } = stand_in({ rows, people: { A1: 'Maya Lopez', B2: 'Sam Ortiz' } });
    const res = await VisorChangelog.fetchChangelog('DOC', 'doc', {});
    ck('a late author is named, though the big roster call came back capped', names(VisorChangelog, res), ['Maya Lopez', 'Sam Ortiz']);
    ck('  found by asking where they first appear, not by paging from the start',
      calls.tiles.some(([s]) => s > 23000 && s <= 24001), true);
    ck('  in a handful of calls', calls.tiles.length <= 5, true);
    ck('  and nobody is left unresolved', res.diagnostics.authorsUnresolved, 0);
  }

  // ── A roster whose records are lists ──────────────────────────────────────
  {
    const rows = [['A1', 'Hello '], ['B2', 'there. '], ['A1', 'Bye.']];
    const { VisorChangelog } = stand_in({ rows, people: { A1: 'Maya Lopez', B2: 'Sam Ortiz' }, rosterAsLists: true });
    const res = await VisorChangelog.fetchChangelog('DOC', 'doc', {});
    ck('roster records that come as lists are read', names(VisorChangelog, res), ['Maya Lopez', 'Sam Ortiz']);
  }

  // ── The person signed in, nameless in Google's roster ─────────────────────
  {
    const rows = [['A1', 'Student text. '], ['T9', 'Teacher note.']];
    const pageHtml = '<script>var _docs_flag_initialData={"docs-pid":"T9","info_params":{"token":"tok"}};</script>';
    const { VisorChangelog } = stand_in({ rows, people: { A1: 'Maya Lopez' }, pageHtml });
    const res = await VisorChangelog.fetchChangelog('DOC', 'doc', { me: { name: 'Tara Teacher', email: 'tara@school.org' } });
    ck('the signed-in person\'s own edits carry their name from the page', names(VisorChangelog, res), ['Maya Lopez', 'Tara Teacher']);
    ck('  and it says so in the diagnostics', res.diagnostics.namedFromPage, true);

    const { VisorChangelog: V2 } = stand_in({ rows, people: { A1: 'Maya Lopez' }, pageHtml });
    const res2 = await V2.fetchChangelog('DOC', 'doc', {});
    ck('  (without the page\'s name they are still "Unknown 1")', names(V2, res2), ['Maya Lopez', 'Unknown 1']);
  }

  // ── Edits with no author in the log ───────────────────────────────────────
  {
    const rows = [['A1', 'Written by Maya. '], ['A1', 'More. '], [null, ''], [null, ''], ['B2', 'Sam too.']];
    const { VisorChangelog } = stand_in({ rows, people: { A1: 'Maya Lopez', B2: 'Sam Ortiz' } });
    const res = await VisorChangelog.fetchChangelog('DOC', 'doc', {});
    ck('formatting the log gives no author for adds no phantom "Unknown"', names(VisorChangelog, res), ['Maya Lopez', 'Sam Ortiz']);

    const rows2 = [['A1', 'Written by Maya. '], [null, 'Text with no author. '], ['A1', 'More. '], ['B2', 'Sam too.']];
    const { VisorChangelog: V2 } = stand_in({ rows: rows2, people: { A1: 'Maya Lopez', B2: 'Sam Ortiz' } });
    const res2 = await V2.fetchChangelog('DOC', 'doc', {});
    const a = V2.analyze(V2.buildTimeline(res2.entries, res2.users));
    const un = a.contributors.find((c) => c.unattributed);
    ck('text with no author is "Unattributed edits", not a numbered stranger', un && un.name, 'Unattributed edits');
    ck('  and the people are still themselves', a.contributors.filter((c) => !c.unattributed).map((c) => c.name).sort(), ['Maya Lopez', 'Sam Ortiz']);
  }

  // ── "Copy details": the shape of the naming, never its contents ──────────
  {
    const rows = [['A1', 'Hello '], ['B2', 'there. '], ['C3', 'More.']];
    const { VisorChangelog } = stand_in({ rows, people: { A1: 'Maya Lopez', B2: 'Sam Ortiz' } });
    const res = await VisorChangelog.fetchChangelog('DOC', 'doc', {});
    const n = res.diagnostics.naming;
    const json = JSON.stringify(n);
    ck('the details say where the roster was', n.responses[0].rosterIn, ['userMap']);
    ck('  what its records look like', n.responses[0].rosterRecords[0].startsWith('{name:text('), true);
    ck('  which log column holds the authors, and how much of it the roster covers',
      [n.authorColumn, n.logColumns[2].matchesRoster], [2, '67%']);
    ck('  and how each author came out', n.authors, { named: 2, inRosterWithoutName: 0, anonymous: 0, notInRoster: 1, noAuthorColumn: 0 });
    ck('  with no names, ids or text in it', ['Maya', 'Sam', '"A1"', '"B2"', 'Hello', 'there'].some((x) => json.includes(x)), false);
  }

  const failed = out.filter((x) => !x).length;
  console.log(failed ? `${failed} of ${out.length} checks FAILED` : `all passed (${out.length} checks)`);
  process.exit(failed ? 1 : 0);
})();
