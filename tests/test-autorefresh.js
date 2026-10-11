/* ============================================================================
 * Auto-refresh: the bar that puts itself up, and keeps itself current.
 * ----------------------------------------------------------------------------
 * Runs content.js against the little DOM in dom.js with a manual clock, so
 * "thirty seconds pass" costs nothing. The changelog engine is replaced with a
 * counting stub: what matters is how often Visor reads the document, not what
 * the reading says.
 * ==========================================================================*/

'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { makeDom } = require('./dom');

const DIR = path.join(__dirname, '..');

const out = [];
const ck = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  out.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `: ${JSON.stringify(got)} (want ${JSON.stringify(want)})`}`);
};

function load({ editable = true } = {}) {
  const { win, document, clock } = makeDom();
  const h = { probeBroken: false };   // filled in below; the stubs close over it

  const counts = { fetch: 0, revision: 0, sync: 0, refreshed: 0 };
  let revision = 100;

  const entries = [{ mutation: { ty: 'is', ibi: 1, s: 'hello' }, time: Date.UTC(2026, 0, 1), rev: 1, userId: '1', sid: null }];
  win.VisorChangelog = {
    async fetchChangelog() {
      counts.fetch++;
      if (h.holdFetch) await new Promise((r) => { h.releaseFetch = r; });
      return {
        entries, users: [{ id: '1', name: 'Ethan', color: '#5AC8FA' }],
        lastRevision: revision, diagnostics: {}, tabs: []
      };
    },
    async latestRevision() { counts.revision++; return h.probeBroken ? 0 : revision; },
    buildTimeline: () => ({ steps: [{ i: 0, time: 1, userId: '1', inserted: 5, deleted: 0, biggestInsert: 5, _norm: [] }], finalText: 'hello', textAt: () => 'hello' }),
    analyze: () => ({
      contributors: [{ id: '1', name: 'Ethan', color: '#5AC8FA', chars: 5, share: 1, activeMinutes: 1 }],
      totals: { finalChars: 5, finalWords: 1, mutations: 1, activeMinutes: 1, pasteCount: 0, deleted: 0, spanDays: 1, externalPasted: 0 },
      growth: [{ length: 1 }, { length: 5 }], sessions: [], heatmap: [], pastes: [], deletions: [],
      behavior: { enough: false }, calendar: {}, pasteThreshold: { value: 20, source: 'floor', samples: 0 }
    }),
    constants: {}
  };

  win.chrome = {
    runtime: {
      id: 'visor-test',
      lastError: null,
      getURL: (p) => `chrome-extension://visor/${p}`,
      sendMessage: (msg, cb) => {
        if (msg && msg.type === 'VISOR_TAB_SYNC') counts.sync++;
        if (msg && msg.type === 'VISOR_DATA_REFRESHED') counts.refreshed++;
        if (cb) cb({ ok: true });
      },
      onMessage: { addListener() {} }
    },
    storage: { local: { get: (k, cb) => cb && cb({}), set() {} }, onChanged: { addListener() {} } }
  };

  const ctx = vm.createContext(win);
  vm.runInContext(fs.readFileSync(`${DIR}/content.js`, 'utf8'), ctx, { filename: 'content.js' });
  // Editability is read from the page; say so directly.
  vm.runInContext(`probeResult = { editable: ${editable}, revisionHint: 0, liveTabs: [], ready: true };`, ctx);

  return Object.assign(h, {
    ctx, document, clock, counts,
    run: (code) => vm.runInContext(code, ctx),
    setRevision: (r) => { revision = r; },
    tab: () => document.getElementById('visor-hud-tab'),
    hud: () => document.getElementById('visor-hud')
  });
}

// Advance the clock, then let every promise the timers started run to the end.
// Advance the clock in small slices, letting promises run between them: a reply
// scheduled by an earlier reply's handler still has to arrive, and a budget
// measured in coarse jumps flatters the code under test.
const settle = async (h, ms = 1) => {
  const step = 50;
  for (let left = ms; left > 0; left -= step) {
    h.clock.advance(Math.min(step, left));
    for (let k = 0; k < 12; k++) await Promise.resolve();
  }
};

(async () => {
  // ── The bar puts itself up, collapsed, without reading anything ───────────
  {
    const h = load();
    ck('nothing is on screen the moment the script loads', !!h.tab(), false);
    await settle(h, 1000);
    ck('the collapsed rectangle appears on its own', !!h.tab(), true);
    ck('  it is shown', h.tab().classList.contains('is-shown'), true);
    ck('  the full bar is not built', !!h.hud(), false);
    ck('  and nothing has been read', h.counts.fetch, 0);

    // Clicking it is what starts the read.
    h.tab().fire('click', { target: h.tab().querySelector('.vt-open') });
    ck('  clicking says it is working', h.tab().classList.contains('is-busy'), true);
    await settle(h, 50);
    ck('  the document is read exactly once', h.counts.fetch, 1);
    ck('  the bar opens', !!h.hud(), true);
    ck('  the rectangle steps aside', h.tab().classList.contains('is-shown'), false);
    ck('  and it is no longer busy', h.tab().classList.contains('is-busy'), false);

    // Collapsing and expanding again must not read the document a second time.
    h.run('toggleHUD(false)');
    ck('collapsing brings the rectangle back', h.tab().classList.contains('is-shown'), true);
    h.tab().fire('click', { target: h.tab() });
    await settle(h, 50);
    ck('  expanding again reads nothing', h.counts.fetch, 1);
    ck('  and the bar is open', h.hud().classList.contains('is-collapsed'), false);
  }

  // ── A view-only document gets no bar at all ───────────────────────────────
  {
    const h = load({ editable: false });
    await settle(h, 7000);
    ck('a document without edit access gets no rectangle', !!h.tab(), false);
  }

  // ── Refreshing only when the document has actually moved ─────────────────
  {
    const h = load();
    await settle(h, 1000);
    h.tab().fire('click', { target: h.tab() });
    await settle(h, 50);
    const base = h.counts.fetch;

    await settle(h, 5000);
    ck('the document is checked within a few seconds', h.counts.revision > 0, true);
    ck('  but an untouched document is not re-read', h.counts.fetch, base);

    h.setRevision(140);
    await settle(h, 14000);   // a read is rationed to one per READ_MIN_GAP_MS
    ck('once it has been written to, it is re-read', h.counts.fetch, base + 1);
    ck('  and the side panel is told', h.counts.refreshed, 1);

    await settle(h, 8000);
    ck('  then it goes quiet again', h.counts.fetch, base + 1);

    // Asking backs off while nothing happens, so a document nobody is editing
    // costs a handful of small requests a minute rather than fifteen.
    const idleFrom = h.counts.revision;
    await settle(h, 60000);
    const idleChecks = h.counts.revision - idleFrom;
    ck('a still document is asked about sparingly', idleChecks <= 8, true);
    ck('  but it is still asked', idleChecks >= 3, true);

    // Docs' own save indicator: an edit here is noticed without any request,
    // and puts the fast cadence back.
    h.run('markDocTouched()');
    const before = h.counts.revision;
    await settle(h, 1500);
    ck('an edit in the document is picked up at once', h.counts.revision, before + 1);
    const fastFrom = h.counts.revision;
    await settle(h, 7000);
    ck('  and the cadence is quick again afterwards', h.counts.revision - fastFrom >= 1, true);

    // Things that must stand aside.
    h.setRevision(200);
    h.document.hidden = true;
    const hiddenFrom = h.counts.fetch;
    await settle(h, 30000);
    ck('a background document is left alone', h.counts.fetch, hiddenFrom);
    h.document.hidden = false;

    h.run('toggleHUD(false)');
    await settle(h, 30000);
    ck('a collapsed bar is left alone', h.counts.fetch, hiddenFrom);
    h.run('toggleHUD(true)');

    h.run('openReplay()');
    await settle(h, 30000);
    ck('an open replay is left alone', h.counts.fetch, hiddenFrom);
    h.run('closeReplay()');
    await settle(h, 400);

    h.run('markDocTouched()');
    await settle(h, 4000);
    ck('once the replay is closed it refreshes again', h.counts.fetch, hiddenFrom + 1);
  }

  // ── The save indicator is what carries that signal ───────────────────────
  {
    const h = load();
    const save = h.document.createElement('div');
    save.id = 'docs-save-indicator';
    save.textContent = 'All changes saved in Drive';
    h.document.body.appendChild(save);

    await settle(h, 1000);
    h.tab().fire('click', { target: h.tab() });
    await settle(h, 2500);          // the title bar is searched a moment after load
    ck('Docs\' save indicator is found and watched', h.run('saveWatched && saveWatched.id'), 'docs-save-indicator');

    // Let it go quiet, then have Docs report a save.
    await settle(h, 40000);
    const quiet = h.counts.revision;
    h.run("saveWatcher.__fire && saveWatcher.__fire()");
    await settle(h, 1500);
    ck('  a save wakes the check straight away', h.counts.revision > quiet, true);
  }

  // ── Re-opening a folded bar looks again straight away ────────────────────
  {
    const h = load();
    await settle(h, 1000);
    h.tab().fire('click', { target: h.tab() });
    await settle(h, 2500);

    h.run('toggleHUD(false)');           // folded away; the schedule goes quiet
    await settle(h, 60000);
    h.setRevision(321);
    const before = h.counts.fetch;
    h.tab().fire('click', { target: h.tab() });   // opened again
    await settle(h, 5000);
    ck('re-opening the bar refreshes it promptly', h.counts.fetch, before + 1);
  }

  // ── Someone typing must not turn into a storm of requests ────────────────
  {
    const h = load();
    await settle(h, 1000);
    h.tab().fire('click', { target: h.tab() });
    await settle(h, 2500);

    // Docs' save indicator flickers on every keystroke burst. Simulate a solid
    // minute of writing: the indicator moves every second, and the document's
    // revision climbs with it.
    const from = { revision: h.counts.revision, fetch: h.counts.fetch };
    let rev = 200;
    for (let sec = 0; sec < 60; sec++) {
      h.setRevision(++rev);
      h.run('markDocTouched()');
      await settle(h, 1000);
    }
    const checks = h.counts.revision - from.revision;
    const reads = h.counts.fetch - from.fetch;
    if (process.env.VISOR_TEST_VERBOSE) console.log(`      (a minute of typing: ${checks} checks, ${reads} reads)`);
    ck('a minute of steady typing stays within a handful of checks', checks <= 20, true);
    ck('  and re-reads the log only every so often', reads <= 6, true);
    ck('  but it does keep up', reads >= 3, true);

    // Once the typing stops, the figures catch up within one ration.
    const settled = h.counts.fetch;
    h.setRevision(999);
    await settle(h, 14000);
    ck('  and it catches up shortly after the typing stops', h.counts.fetch > settled, true);
  }

  // ── A collaborator typing is not visible locally, and must still be cheap ─
  // Docs' save indicator only moves for edits made in this browser, so a
  // collaborator's steady typing arrives purely as a climbing revision number.
  {
    const h = load();
    await settle(h, 1000);
    h.tab().fire('click', { target: h.tab() });
    await settle(h, 2500);

    const from = { revision: h.counts.revision, fetch: h.counts.fetch };
    let rev = 500;
    for (let sec = 0; sec < 60; sec++) { h.setRevision(++rev); await settle(h, 1000); }
    const checks = h.counts.revision - from.revision;
    const reads = h.counts.fetch - from.fetch;
    if (process.env.VISOR_TEST_VERBOSE) console.log(`      (a minute of someone else typing: ${checks} checks, ${reads} reads)`);
    ck('someone else typing for a minute is checked often but read rarely', reads <= 6, true);
    ck('  and it does keep up with them', reads >= 3, true);
  }

  // ── A probe that cannot tell must not mean "re-read everything" ──────────
  {
    const h = load();
    h.probeBroken = true;
    await settle(h, 1000);
    h.tab().fire('click', { target: h.tab() });
    await settle(h, 2500);

    const from = h.counts.fetch;
    await settle(h, 60000);
    const reads = h.counts.fetch - from;
    ck('when the revision cannot be read, the log is not re-read every few seconds', reads <= 3, true);
  }

  // ── Moving to another document starts over ───────────────────────────────
  {
    const h = load();
    await settle(h, 1000);
    h.tab().fire('click', { target: h.tab() });
    await settle(h, 50);
    ck('the bar is open on the first document', !!h.hud() && !h.hud().classList.contains('is-collapsed'), true);

    h.ctx.location.href = 'https://docs.google.com/document/d/DOC2/edit';
    h.ctx.location.pathname = '/document/d/DOC2/edit';
    await settle(h, 2000);
    ck('opening another document clears the old bar', !!h.hud(), false);
    await settle(h, 4000);
    ck('  and offers the button again', h.tab().classList.contains('is-shown'), true);
    const reads = h.counts.fetch;
    await settle(h, 30000);
    ck('  which has read nothing until it is pressed', h.counts.fetch, reads);
  }

  // ── A read that lands after the document has changed is discarded ────────
  {
    const h = load();
    await settle(h, 1000);
    h.holdFetch = true;
    h.tab().fire('click', { target: h.tab() });     // starts a read that hangs
    await settle(h, 200);
    ck('the read is in flight', h.counts.fetch, 1);

    // Docs moves to another document while that read is still out.
    h.ctx.location.href = 'https://docs.google.com/document/d/DOC2/edit';
    h.ctx.location.pathname = '/document/d/DOC2/edit';
    await settle(h, 1500);
    h.releaseFetch();                                // the old reply arrives now
    await settle(h, 500);

    ck('the old document\'s reply is thrown away', h.run('!!analysis'), false);
    ck('  and it does not draw a bar over the new document', !!h.hud(), false);
    ck('  the new document still offers its button', h.tab().classList.contains('is-shown'), true);
  }

  // ── When the extension is reloaded, the orphan stops ────────────────────
  // The page keeps running this script after an extension reload or update,
  // but chrome.runtime is gone. Left alone it kept polling docs.google.com for
  // the life of the tab, with a bar on screen that could no longer do anything.
  {
    const h = load();
    await settle(h, 1000);
    h.tab().fire('click', { target: h.tab() });
    await settle(h, 2500);
    ck('the bar is up while the extension is alive', !!h.hud(), true);

    delete h.ctx.chrome.runtime.id;        // what an extension reload looks like
    h.setRevision(777);
    await settle(h, 3000);
    ck('  its own UI is taken off the page', [!!h.hud(), !!h.tab()], [false, false]);

    const after = { fetch: h.counts.fetch, revision: h.counts.revision };
    await settle(h, 60000);
    ck('  and it stops asking about the document', [h.counts.fetch, h.counts.revision], [after.fetch, after.revision]);
  }

  // ── The play button reads the document too ────────────────────────────────
  {
    const h = load();
    await settle(h, 1000);
    h.tab().fire('click', { target: h.tab().querySelector('.vt-play') });
    await settle(h, 50);
    ck('the play button reads the document first', h.counts.fetch, 1);
    ck('  and opens the replay', !!h.document.getElementById('visor-replay-overlay'), true);
    // The bar is built by the read itself, but stays folded away behind the
    // rectangle: the user asked for the replay, not for the bar.
    ck('  the bar stays collapsed behind the rectangle',
       [h.hud().classList.contains('is-collapsed'), h.tab().classList.contains('is-shown')], [true, true]);
  }

  console.log(out.every(Boolean) ? `\nall passed (${out.length} checks)` : `\n${out.filter((x) => !x).length} FAILED`);
  process.exit(out.every(Boolean) ? 0 : 1);
})();
