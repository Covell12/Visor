/* ============================================================================
 * Visor — Changelog Engine
 * ----------------------------------------------------------------------------
 * Reads a Google Doc's native operational-transform mutation log — the same
 * stream that powers realtime collaboration — directly from the docs.google.com
 * origin using the user's existing session. No OAuth, no Drive API, no Gemini,
 * no network call to any host other than the document's own origin.
 *
 * Endpoint:  /document/d/<id>/revisions/load?id=<id>&start=<a>&end=<b>
 * Response:  )]}'\n  +  JSON  { changelog: [...], ... }
 *
 * Every figure Visor reports is derived by folding this op stream over a text
 * buffer. Nothing is sampled, inferred from file size, or estimated.
 * ==========================================================================*/

(function (root) {
  'use strict';

  // ── Tunables ───────────────────────────────────────────────────────────────
  const IDLE_GAP_MS    = 120_000; // gap above which a writing session is broken
  const SESSION_GAP_MS = 300_000; // gap above which a *new* session starts
  // The smallest insert worth considering a paste. Not a classification
  // threshold — that is derived per document from how this author actually
  // types — just a floor below which the question is meaningless.
  const PASTE_FLOOR    = 20;
  const DELETION_FLOOR = 15;      // display noise floor for recovered deletions
  const KEYFRAME_EVERY = 250;     // buffer snapshot cadence for O(1)-ish seeking
  const PAGE_SIZE      = 1000;    // revisions fetched per request
  const MAX_REVISIONS  = 250_000; // hard ceiling, protects against runaway docs

  const XSSI = /^\)\]\}'\s*/;

  // ── Fetch layer ────────────────────────────────────────────────────────────

  function originFor(kind) {
    return kind === 'slides' ? 'presentation' : 'document';
  }

  /**
   * Session token and obfuscated user id, read out of the page's own HTML.
   *
   * The revision endpoints expect the same token the Docs client sends. Without
   * it the requests are refused, which is indistinguishable from "no history"
   * and was the likeliest reason the roster came back empty.
   */
  function readPageCredentials() {
    let html = '';
    try { html = document.documentElement.innerHTML; } catch (_) { return {}; }

    // The token appears in several places; the one next to info_params is the
    // one the revision endpoints accept.
    let token = null;
    const at = html.indexOf('info_params');
    if (at >= 0) {
      const near = html.slice(at, at + 400).match(/"token":"(.*?)"/);
      if (near) token = near[1];
    }
    if (!token) {
      const any = html.match(/"token":"(.*?)"/);
      if (any) token = any[1];
    }

    const pid = html.match(/"docs-pid":"(.*?)"/);
    return { token: token || null, ouid: pid ? pid[1] : null };
  }

  function withCreds(url, creds) {
    if (creds.token) url.searchParams.set('token', creds.token);
    if (creds.ouid)  url.searchParams.set('ouid', creds.ouid);
    url.searchParams.set('includes_info_params', 'true');
    url.searchParams.set('cros_files', 'false');
    return url.toString();
  }

  function loadUrl(fileId, kind, start, end, creds) {
    const seg = originFor(kind);
    const u = new URL(`https://docs.google.com/${seg}/d/${encodeURIComponent(fileId)}/revisions/load`);
    u.searchParams.set('id', fileId);
    u.searchParams.set('start', String(start));
    u.searchParams.set('end', String(end));
    u.searchParams.set('smv', '9');
    u.searchParams.set('srfn', 'false');
    u.searchParams.set('ern', 'false');
    u.searchParams.set('smb', '[9, ]');
    return withCreds(u, creds || {});
  }

  /**
   * The tile index: total revision count, and the author roster.
   *
   * `revisionBatchSize` bounds how much history the response covers, so a fixed
   * batch only describes the authors of the first N revisions. Everyone who
   * joined later comes back unnamed. The roster is therefore fetched twice: a
   * cheap call to learn how long the document is, then a detailed one sized to
   * the whole thing.
   */
  function tilesUrl(fileId, kind, creds, batchSize, detailed) {
    const seg = originFor(kind);
    const u = new URL(`https://docs.google.com/${seg}/d/${encodeURIComponent(fileId)}/revisions/tiles`);
    u.searchParams.set('id', fileId);
    u.searchParams.set('start', '1');
    u.searchParams.set('revisionBatchSize', String(batchSize || 1500));
    u.searchParams.set('showDetailedRevisions', detailed ? 'true' : 'false');
    u.searchParams.set('loadType', '0');
    return withCreds(u, creds || {});
  }

  /** Same-origin, cookie-authenticated GET returning parsed JSON, or null. */
  async function getJSON(url) {
    let res;
    try {
      res = await fetch(url, {
        credentials: 'include',
        headers: { 'X-Same-Domain': '1' }
      });
    } catch (_) {
      return null;
    }
    // 403 is the server saying this user may not read revision history.
    if (!res.ok) return null;
    const raw = await res.text();
    try {
      return JSON.parse(raw.replace(XSSI, ''));
    } catch (_) {
      return null;
    }
  }

  /**
   * Fallback for finding the last revision when the tile index is unavailable:
   * probe outward, then bisect. The endpoint refuses ranges past the end.
   */
  async function probeLastRevision(fileId, kind, hint, creds) {
    const ok = async (n) => {
      if (n < 1) return false;
      const j = await getJSON(loadUrl(fileId, kind, n, n, creds));
      return !!(j && (j.changelog || j.chunkedSnapshot));
    };

    if (hint && Number.isFinite(hint) && hint > 1 && await ok(hint)) {
      if (!(await ok(hint + 1))) return hint;
    }

    let hi = 1;
    while (hi < MAX_REVISIONS && await ok(hi * 2)) hi *= 2;
    if (hi === 1 && !(await ok(1))) return 0;

    let lo = hi;
    hi = Math.min(hi * 2, MAX_REVISIONS);
    while (lo + 1 < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (await ok(mid)) lo = mid; else hi = mid;
    }
    return lo;
  }

  /**
   * Pull the whole log and interpret it.
   *
   * The tile index gives the revision count outright, so there is no need to
   * binary-search for the end of the document any more.
   */
  /**
   * The document's newest revision, for a few hundred bytes.
   *
   * Auto-refresh asks this first: one small tiles request says whether anything
   * has been written since the last read, and an untouched document then costs
   * nothing more — no log fetch, no fold. Returns 0 when it cannot tell, which
   * callers should treat as "refresh anyway" rather than "unchanged".
   */
  async function latestRevision(fileId, kind) {
    try {
      const creds = readPageCredentials();
      return tileEnd(await getJSON(tilesUrl(fileId, kind, creds, 1500, false))) || 0;
    } catch (_) {
      return 0;
    }
  }

  async function fetchChangelog(fileId, kind, opts = {}) {
    const onProgress = opts.onProgress || (() => {});
    const creds = readPageCredentials();

    const users = [];
    const rows  = [];

    // Pass one: how long is the document?
    const tiles = await getJSON(tilesUrl(fileId, kind, creds, 1500, false));
    if (tiles) absorbUsers(tiles, users);

    let last = tileEnd(tiles);
    if (!last) last = await probeLastRevision(fileId, kind, opts.revisionHint, creds);

    // Pass two: a roster sized to the whole history, so authors who only appear
    // late are named too.
    let detailedTiles = null;
    if (last) {
      detailedTiles = await getJSON(tilesUrl(fileId, kind, creds, last, true));
      if (detailedTiles) absorbUsers(detailedTiles, users);
    }
    if (!last) {
      return {
        entries: [], users: [], lastRevision: 0, tabs: [],
        diagnostics: { rows: 0, tilesResponded: !!tiles, hasToken: !!creds.token, rosterSize: users.length }
      };
    }

    for (let start = 1; start <= last; start += PAGE_SIZE) {
      const end = Math.min(start + PAGE_SIZE - 1, last);
      const json = await getJSON(loadUrl(fileId, kind, start, end, creds));
      if (!json) continue;
      absorbUsers(json, users);
      collectRows(json, rows, start);
      onProgress(Math.min(1, end / last), end, last);
    }


    const layout  = knownLayout(rows) || profileColumns(rows, users.map((u) => u.id));
    const entries = buildEntries(rows, layout);
    entries.sort((a, b) => a.rev - b.rev || a.time - b.time);

    // Anyone the roster still does not cover gets one more attempt: walk the
    // tile index in windows. A single detailed call is normally enough, but a
    // very long history can come back capped.
    const sweep = await resolveMissingAuthors(fileId, kind, creds, entries, users, last);

    // Tab roster, read from the same stream that carries the edits.
    const tabEvents = [];
    const tabStats  = { seen: 0, unparsed: 0 };
    for (const e of entries) collectTabEvents(e.mutation, tabEvents, tabStats);
    // Correct in order of confidence: the live strip knows current names, then
    // an orphaned rename from the log fills a tab still wearing a default.
    const liveStats = {};
    const tabs = finaliseTitles(
      pairOrphanNames(
        applyLiveTitles(buildTabRoster(tabEvents), opts.liveTabs, liveStats),
        tabEvents
      )
    );

    const diagnostics = {
      rows: rows.length,
      tilesResponded: !!tiles,
      detailedRoster: !!detailedTiles,
      hasToken: !!creds.token,
      hasOuid: !!creds.ouid,
      revisionCountFrom: tileEnd(tiles) ? 'tiles' : 'probe',
      rosterSize: users.length,
      rosterWithNames: users.filter((u) => u.name).length,
      rosterWithEmails: users.filter((u) => u.email).length,
      authorsInLog: sweep.authorsInLog,
      authorsUnresolved: sweep.unresolved,
      rosterSweeps: sweep.calls,
      tabCount: tabs.length,
      tabEvents: tabEvents.length,
      tabOpsSeen: tabStats.seen,
      tabOpsUnparsed: tabStats.unparsed,
      tabOpSamples: tabStats.samples || [],
      layoutSource: (layout && layout.source) || 'profiled',
      tabsNamed: tabs.filter((t) => t.title && !t.fallbackTitle).length,
      tabTitleSources: tabs.map((t) => `${t.title}<-${t.titleSource || 'changelog'}`),
      orphanNames: tabEvents.filter((e) => e && e.kind === 'orphan-name').length,
      liveTabs: liveStats.liveCount || 0,
      liveWithIds: liveStats.liveWithIds || 0,
      titleMatchMode: liveStats.mode || 'none',
      liveSample: liveStats.sample || [],
      // Count every page-derived source, not just the id path — the previous
      // counter reported zero even when positional matching had worked.
      titlesFromPage: tabs.filter((t) => /^page/.test(t.titleSource || '')).length,
      layout
    };

    return { entries, users, lastRevision: last, layout, diagnostics, tabs };
  }

  /**
   * Fill roster gaps by paging the tile index.
   *
   * Returns how many distinct authors the log actually contains and how many
   * are still nameless afterwards — the number that matters for whether people
   * can be told apart, and the one to look at when they cannot.
   */
  async function resolveMissingAuthors(fileId, kind, creds, entries, users, last) {
    const known = new Set(users.map((u) => u.id));
    const inLog = new Set();
    for (const e of entries) if (e.userId) inLog.add(e.userId);

    let missing = [...inLog].filter((id) => !known.has(id));
    let calls = 0;

    const WINDOW = 1500;
    const MAX_CALLS = 12;
    for (let start = 1; missing.length && start <= last && calls < MAX_CALLS; start += WINDOW) {
      const u = new URL(tilesUrl(fileId, kind, creds, WINDOW, true));
      u.searchParams.set('start', String(start));
      const json = await getJSON(u.toString());
      calls++;
      if (!json) continue;

      absorbUsers(json, users);
      const now = new Set(users.map((x) => x.id));
      missing = missing.filter((id) => !now.has(id));
    }

    return { authorsInLog: inLog.size, unresolved: missing.length, calls };
  }

  /** Total revisions, straight from the tile index. */
  function tileEnd(tiles) {
    const info = tiles && (tiles.tileInfo || tiles.tiles);
    if (!Array.isArray(info) || !info.length) return 0;
    const last = info[info.length - 1];
    const end = last && (last.end != null ? last.end : last.e);
    return typeof end === 'number' && end > 0 ? end : 0;
  }

  // ── Response parsing ───────────────────────────────────────────────────────

  const EPOCH_MIN = 946_684_800_000;  // 2000-01-01 — floor for "this is a timestamp"
  const EPOCH_MAX = 4_102_444_800_000; // 2100-01-01 — ceiling for the same

  /**
   * Find the author roster, wherever it is hiding.
   *
   * Tries the documented-by-observation locations first, then falls back to a
   * bounded walk of the whole payload looking for a map whose values are user
   * records. The roster's *keys* matter as much as its values: they are the
   * indices the changelog uses to refer to authors, so a roster found at the
   * wrong nesting level is worse than none at all.
   */
  function absorbUsers(json, users) {
    let hits = 0;

    const consider = (map) => {
      if (!map || typeof map !== 'object') return 0;
      const keys = Array.isArray(map) ? map.map((_, i) => i) : Object.keys(map);
      let n = 0;
      for (const k of keys) {
        const u = map[k];
        if (!u || typeof u !== 'object' || Array.isArray(u)) continue;
        if (!looksLikeUser(u)) continue;
        mergeUser(users, k, u);
        n++;
      }
      return n;
    };

    for (const key of ['userMap', 'users', 'um', 'userMapping', 'authors']) {
      hits += consider(json[key]);
    }
    if (hits) return;

    // Bounded search for a roster nested deeper (tileInfo, metadata, …).
    const seen = new Set();
    const stack = [json];
    let budget = 20_000;
    while (stack.length && budget-- > 0) {
      const node = stack.pop();
      if (!node || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);

      if (!Array.isArray(node)) {
        // A map is a roster when most of its values look like user records.
        const vals = Object.values(node);
        const userish = vals.filter(
          (v) => v && typeof v === 'object' && !Array.isArray(v) && looksLikeUser(v)
        ).length;
        if (vals.length && userish >= Math.max(1, Math.ceil(vals.length * 0.6))) {
          hits += consider(node);
          if (hits) return;
        }
      }

      for (const v of (Array.isArray(node) ? node : Object.values(node))) {
        if (v && typeof v === 'object') stack.push(v);
      }
    }
  }

  /** A payload object shaped like a person rather than like configuration. */
  function looksLikeUser(u) {
    return ('name' in u) || ('displayName' in u) || ('emailAddress' in u) ||
           ('email' in u) || ('photo' in u) || ('photoUrl' in u) ||
           ('anonymous' in u) || ('isAnonymous' in u) || ('color' in u);
  }

  /**
   * Fold one roster entry in, keyed by the id the changelog uses to refer to
   * that author. An address is kept only when the payload actually carries one
   * — Visor no longer tries to attach an email by matching names, because that
   * was a guess and Google's roster does not include addresses to begin with.
   */
  function mergeUser(users, key, u) {
    const id    = String(key);
    const name  = u.name || u.displayName || u.n || null;
    const email = u.emailAddress || u.email || u.em || null;
    const anon  = !!(u.anonymous || u.isAnonymous);

    const found = users.find((x) => x.id === id);
    if (found) {
      if (!found.name && name)   found.name = name;
      if (!found.email && email) found.email = email;
      return;
    }
    users.push({
      id,
      name,
      email,
      photo: u.photo || u.photoUrl || u.p || null,
      color: u.color || u.c || null,
      anonymous: anon
    });
  }

  /** Keep rows verbatim; interpretation happens once, later, over all of them. */
  function collectRows(json, out, pageStart) {
    const log = json.changelog || json.chunkedSnapshot || json.cl;
    if (!Array.isArray(log)) return;

    log.forEach((row, i) => {
      if (Array.isArray(row)) {
        const mutation = row.find((v) => v && typeof v === 'object' && !Array.isArray(v));
        if (mutation) {
          out.push({ row, mutation, fallbackRev: pageStart + i });
        }
      } else if (row && typeof row === 'object' && (row.ty || row.type)) {
        out.push({ row: [row], mutation: row, fallbackRev: pageStart + i });
      }
    });
  }

  /**
   * Decide which tuple position holds the timestamp, the revision number and
   * the author, by measuring each column across every row.
   *
   *   timestamp — values sit in a plausible epoch-millisecond range
   *   revision  — non-decreasing, and spans about as many values as there are rows
   *   author    — small non-negative integers with very low cardinality
   *
   * Any column that fails its test is reported as absent rather than guessed at.
   */
  /**
   * The layout the live editor emits: [ mutation, timestampMs, userIdString ].
   *
   * Checking for it directly beats inferring it. The author id is a string, so
   * the statistical profiler — which only ever considered numeric columns —
   * reported "not found" and collapsed everyone into a single contributor.
   * Column 2 is absent on some rows, so the bar is a majority, not all.
   */
  function knownLayout(rows) {
    if (!rows.length) return null;
    let times = 0;
    let ids = 0;
    for (const r of rows) {
      const t = r.row[1];
      const u = r.row[2];
      if (typeof t === 'number' && t >= EPOCH_MIN && t <= EPOCH_MAX) times++;
      if (typeof u === 'string' && u) ids++;
    }
    const n = rows.length;
    if (times < n * 0.8 || ids < n * 0.5) return null;
    // No revision column in this shape; document order is the ordering.
    return { timeIdx: 1, revIdx: -1, userIdx: 2, authorCount: 0, source: 'known' };
  }

  function profileColumns(rows, knownUserIds) {
    const width = rows.reduce((w, r) => Math.max(w, r.row.length), 0);
    const stats = [];

    for (let c = 0; c < width; c++) {
      const s = {
        index: c, count: 0, epoch: 0, ints: 0, negative: 0, switches: 0,
        strings: 0, present: 0,
        min: Infinity, max: -Infinity,
        distinct: new Set(),      // numeric values only
        anyDistinct: new Set(),   // every scalar value, as a string
        monotonic: true
      };
      let prev = -Infinity;
      let first = true;
      for (const r of rows) {
        const raw = r.row[c];
        if (typeof raw === 'string' || typeof raw === 'number') {
          s.present++;
          if (typeof raw === 'string') s.strings++;
          if (s.anyDistinct.size <= 1000) s.anyDistinct.add(String(raw));
        }
        const v = raw;
        if (typeof v !== 'number' || !isFinite(v)) continue;
        s.count++;
        if (v >= EPOCH_MIN && v <= EPOCH_MAX) s.epoch++;
        if (Number.isInteger(v)) s.ints++;
        if (v < 0) s.negative++;
        if (v < s.min) s.min = v;
        if (v > s.max) s.max = v;
        if (s.distinct.size <= 1000) s.distinct.add(v);
        if (v < prev) s.monotonic = false;
        if (!first && v !== prev) s.switches++;
        first = false;
        prev = v;
      }
      // Mean run of identical consecutive values. People edit in bursts, so an
      // author column holds its value; a status flag flips constantly.
      s.meanRun = s.count / (s.switches + 1);
      stats.push(s);
    }

    const n = rows.length || 1;
    const covered = (s) => s.count >= n * 0.8;

    // Timestamp: overwhelmingly epoch-shaped.
    const timeIdx = pick(stats, (s) => covered(s) && s.epoch >= s.count * 0.8,
                         (s) => -s.epoch);

    // Revision: monotonic, integral, and roughly one distinct value per row.
    const revIdx = pick(stats,
      (s) => covered(s) && s.index !== timeIdx && s.monotonic &&
             s.ints === s.count && s.negative === 0 &&
             (s.max - s.min) >= n * 0.5 && (s.max - s.min) <= n * 4,
      (s) => Math.abs((s.max - s.min) - n));

    // Author: small non-negative integers, few of them, and not constant — a
    // column that never changes identifies nobody.
    const CARD_CAP = Math.max(2, Math.min(200, Math.floor(n / 4)));
    const candidate = (s) =>
      covered(s) && s.index !== timeIdx && s.index !== revIdx &&
      s.ints === s.count && s.negative === 0 &&
      s.distinct.size >= 2 && s.distinct.size <= CARD_CAP &&
      s.max < 10000;

    // Ranked on evidence, strongest first:
    //   1. how many of the known author ids the column actually accounts for
    //      (a roster from the payload is the best evidence there is)
    //   2. how burst-like its values are — real authorship is contiguous
    //   3. cardinality, only as a tiebreak
    const known = new Set((knownUserIds || []).map(String));

    // Strongest evidence: every value in the column is a known author id. That
    // holds however the ids are typed — the live payload uses strings, older
    // shapes used small integers.
    // A strong majority of values being known author ids is enough. Demanding
    // every value fails on logs that also carry ids absent from the roster —
    // departed collaborators, copy markers — and rejected the real column.
    const rosterHits = (s) => [...s.anyDistinct].filter((v) => known.has(v)).length;
    const rosterMatch = (s) =>
      known.size && s.present >= n * 0.5 && s.anyDistinct.size &&
      s.index !== timeIdx && s.index !== revIdx &&
      rosterHits(s) >= Math.max(1, Math.ceil(s.anyDistinct.size * 0.6));

    let userIdx = pick(stats, rosterMatch, (s) => [-rosterHits(s), s.anyDistinct.size]);

    // Failing that, a low-cardinality column of short strings that holds its
    // value in runs is an author column whatever the roster says.
    if (userIdx == null) {
      const stringy = (s) =>
        s.index !== timeIdx && s.index !== revIdx &&
        s.strings >= s.present * 0.8 && s.present >= n * 0.5 &&
        s.anyDistinct.size >= 2 && s.anyDistinct.size <= Math.max(2, Math.min(200, n / 4));
      userIdx = pick(stats, stringy, (s) => [-s.meanRun, s.anyDistinct.size]);
    }

    // Otherwise fall back to shape: small, non-constant, burst-like integers.
    if (userIdx == null) {
      userIdx = pick(stats, candidate, (s) => {
        const covers = known.size
          ? [...s.distinct].filter((v) => known.has(String(v))).length
          : 0;
        return [-covers, -s.meanRun, s.distinct.size];
      });
    }

    return {
      timeIdx: timeIdx == null ? -1 : timeIdx,
      revIdx:  revIdx  == null ? -1 : revIdx,
      userIdx: userIdx == null ? -1 : userIdx,
      authorCount: userIdx == null ? 1 : stats[userIdx].distinct.size
    };
  }

  /**
   * Lowest-scoring candidate that passes the predicate, or null.
   * `score` may return a number or an array of numbers compared left to right.
   */
  function pick(stats, ok, score) {
    let best = null, bestScore = null;
    for (const s of stats) {
      if (!ok(s)) continue;
      const v = [].concat(score(s));
      if (bestScore === null || lessThan(v, bestScore)) { bestScore = v; best = s.index; }
    }
    return best;
  }

  function lessThan(a, b) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const x = a[i] || 0, y = b[i] || 0;
      if (x !== y) return x < y;
    }
    return false;
  }

  function buildEntries(rows, layout) {
    const { timeIdx, revIdx, userIdx } = layout;
    return rows.map((r, i) => {
      const time = timeIdx >= 0 && typeof r.row[timeIdx] === 'number' ? r.row[timeIdx] : 0;
      const rev  = revIdx  >= 0 && typeof r.row[revIdx]  === 'number' ? r.row[revIdx]  : r.fallbackRev;
      // No identifiable author column means one unknown author, never one per row.
      const raw  = userIdx >= 0 ? r.row[userIdx] : undefined;
      const uid  = (typeof raw === 'string' && raw) || (typeof raw === 'number' ? String(raw) : '0');
      return { mutation: r.mutation, time, rev, userId: uid, sid: null, _i: i };
    });
  }

  // ── Mutation normalisation ────────────────────────────────────────────────
  //
  // Reduce Google's op vocabulary to three primitives: insert, delete, style.

  const ROOT_TAB = 't.0';   // the first tab; edits outside any wrapper belong here

  /**
   * Reduce Google's op vocabulary to insert / delete / style, tagging each op
   * with the document tab it applies to.
   *
   * Tabs are called "chapters" internally, which is why nothing in the payload
   * ever says "tab". An `nm` node re-targets its child mutation at the tab named
   * in `nmr[1]`; anything not wrapped that way belongs to the first tab, `t.0`.
   */
  function normalize(m, out, tab) {
    out = out || [];
    if (tab === undefined) tab = ROOT_TAB;
    if (!m || typeof m !== 'object') return out;

    const ty = m.ty || m.type;

    switch (ty) {
      case 'nm': {   // named mutation — retargets its child at another tab
        const target = Array.isArray(m.nmr) && m.nmr.length > 1 ? m.nmr[1] : tab;
        normalize(m.nmc, out, typeof target === 'string' ? target : tab);
        break;
      }
      case 'mlti': { // bundle — same tab unless a child says otherwise
        const kids = m.mts || m.mutations || [];
        for (const k of kids) normalize(k, out, tab);
        break;
      }
      case 'rplc': { // wholesale replacement carries a nested snapshot
        const snap = m.snapshot || m.mts || [];
        for (const k of snap) normalize(k, out, tab);
        break;
      }
      case 'is': {   // insert string
        const s = typeof m.s === 'string' ? m.s : '';
        const at = num(m.ibi, m.ib, m.i);
        if (s) out.push({ op: 'insert', at: Math.max(0, at - 1), text: s, tab });
        break;
      }
      case 'ds': {   // delete span (1-based, inclusive)
        const si = num(m.si, m.s1, m.start);
        const ei = num(m.ei, m.e1, m.end);
        if (ei >= si) out.push({ op: 'delete', at: Math.max(0, si - 1), len: ei - si + 1, tab });
        break;
      }
      case 'as':     // apply style
      case 'ss':
      case 'usm':
      case 'asrpm': {
        const si = num(m.si, m.s1, m.start);
        const ei = num(m.ei, m.e1, m.end);
        out.push({ op: 'style', at: Math.max(0, si - 1), len: Math.max(0, ei - si + 1), tab });
        break;
      }
      default: {
        // Unknown wrapper: recurse into nested mutations so a future payload
        // change degrades to partial data rather than none.
        for (const k of Object.keys(m)) {
          const v = m[k];
          if (Array.isArray(v)) v.forEach((x) => normalize(x, out, tab));
          else if (v && typeof v === 'object' && (v.ty || v.type)) normalize(v, out, tab);
        }
      }
    }
    return out;
  }

  /**
   * Tab lifecycle events, read from the same stream.
   *
   *   mkch  the document's first tab   id is always t.0, name at d[0][1]
   *   ac    a tab was added            id at d[0],       name at d[1][1]
   *   ucp   a tab was renamed          id at d[0],       name at d[1][1][1]
   *   dc    a tab was deleted          id at d[0]
   */
  const TAB_ID_RE = /^t\.[A-Za-z0-9_-]+$/;

  /** A value that could plausibly be a tab's display name. */
  function nameLike(v) {
    return typeof v === 'string' && v.trim().length > 0 && v.length <= 200 &&
           !TAB_ID_RE.test(v) &&
           !/^[A-Z0-9_]{4,}$/.test(v);   // enum-ish constants are not names
  }

  /** Depth-first search for the first name-like string in a nested structure. */
  function findName(v, depth) {
    depth = depth || 0;
    if (depth > 6) return null;
    if (nameLike(v)) return v.trim();
    if (Array.isArray(v)) {
      for (const x of v) {
        const hit = findName(x, depth + 1);
        if (hit) return hit;
      }
    } else if (v && typeof v === 'object') {
      // Prefer explicitly-named fields before guessing.
      for (const k of ['title', 'name', 'tabName', 'text']) {
        if (nameLike(v[k])) return v[k].trim();
      }
      for (const k of Object.keys(v)) {
        const hit = findName(v[k], depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  }

  function findTabId(v, depth) {
    depth = depth || 0;
    if (depth > 4) return null;
    if (typeof v === 'string' && TAB_ID_RE.test(v)) return v;
    if (Array.isArray(v)) {
      for (const x of v) {
        const hit = findTabId(x, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  }

  /**
   * Tab lifecycle events, read from the same stream as the edits.
   *
   *   mkch  the document's first tab   id is always t.0
   *   ac    a tab was added
   *   ucp   a tab's properties changed — a rename, when it carries a name
   *   dc    a tab was deleted
   *
   * The known index paths are tried first, then a bounded search of the same
   * payload. A rename that does not match the expected shape must not vanish
   * silently: that is what left the first tab showing its creation-time name
   * ("Tab 1") while later tabs, named on creation, looked correct.
   */
  function collectTabEvents(m, out, stats) {
    out = out || [];
    stats = stats || { seen: 0, unparsed: 0 };
    if (!m || typeof m !== 'object') return out;
    const ty = m.ty || m.type;

    if (ty === 'mlti') {
      for (const k of (m.mts || [])) collectTabEvents(k, out, stats);
      return out;
    }
    if (ty === 'rplc') {
      for (const k of (m.snapshot || [])) collectTabEvents(k, out, stats);
      return out;
    }
    if (ty === 'nm') {
      collectTabEvents(m.nmc, out, stats);
      return out;
    }
    if (ty !== 'mkch' && ty !== 'ac' && ty !== 'ucp' && ty !== 'dc') return out;

    stats.seen++;
    const d = m.d;

    try {
      if (ty === 'mkch') {
        const name = pick1(() => d[0][1]) || findName(d);
        out.push({ kind: 'add', id: ROOT_TAB, name: name || null });
        if (!name) { stats.unparsed++; noteUnparsed(stats, ty, d); }
        return out;
      }

      let id = (typeof d[0] === 'string' && d[0]) || findTabId(d) || null;

      // The first tab has no id of its own: operations that target it leave the
      // id slot empty where other tabs carry "t.xxxx". An empty slot therefore
      // means the root tab, not a malformed operation — reading it as the
      // latter is what discarded the first tab's rename.
      const emptySlot = d[0] === '' || d[0] === 0 || d[0] === '0' ||
                        d[0] === null || d[0] === undefined;
      if (!id && emptySlot) id = ROOT_TAB;

      if (!id) {
        // The id is unreadable, but the name may still be right there. Keep it
        // as an orphan rather than discarding the whole operation: a rename we
        // cannot address is still evidence that some tab has that name, and
        // throwing it away is what left the first tab showing "Tab 1".
        //
        // Search the payload only. d[0] is the id slot, so a string there is a
        // malformed identifier, not somebody's tab name.
        const payload = Array.isArray(d) ? d.slice(1) : d;
        const orphan = findName(payload);
        if (orphan) out.push({ kind: 'orphan-name', name: orphan });
        stats.unparsed++;
        noteUnparsed(stats, ty, d);
        return out;
      }

      if (ty === 'dc') {
        out.push({ kind: 'delete', id });
      } else if (ty === 'ac') {
        const name = pick1(() => d[1][1]) || findName(d[1]) || findName(d);
        out.push({ kind: 'add', id, name: name || null });
        if (!name) { stats.unparsed++; noteUnparsed(stats, ty, d); }
      } else {  // ucp — only a rename when a name is actually present
        const name = pick1(() => d[1][1][1]) || findName(d[1]);
        if (name) out.push({ kind: 'rename', id, name });
        // A ucp carrying no name changed some other property; not a failure.
      }
    } catch (_) {
      stats.unparsed++;
      noteUnparsed(stats, ty, d);
    }
    return out;
  }

  /**
   * Describe an operation we could not read, without capturing any document
   * text. Types and shapes only — enough to fix the parser, nothing more.
   */
  function noteUnparsed(stats, ty, d) {
    stats.samples = stats.samples || [];
    if (stats.samples.length >= 3) return;
    stats.samples.push(`${ty}:${shapeOf(d, 0)}`);
  }

  function shapeOf(v, depth) {
    if (depth > 3) return '…';
    if (v === null) return 'null';
    if (Array.isArray(v)) return `[${v.slice(0, 4).map((x) => shapeOf(x, depth + 1)).join(',')}]`;
    switch (typeof v) {
      case 'string':  return TAB_ID_RE.test(v) ? 'tabid' : `str${v.length}`;
      case 'number':  return String(v);
      case 'boolean': return String(v);
      case 'object':  return `{${Object.keys(v).slice(0, 5).join(',')}}`;
      default:        return typeof v;
    }
  }

  /** Evaluate a fixed index path, returning null instead of throwing. */
  function pick1(fn) {
    try {
      const v = fn();
      return nameLike(v) ? v.trim() : null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Correct titles against the tab strip the editor is showing.
   *
   * The changelog is the authority on which tabs exist and who edited them, but
   * it only knows names that were recorded as events. The live strip is the
   * authority on what a tab is called *now* — so where both agree a tab exists,
   * the page wins on the name. Matching is by id; ordinal matching is used only
   * when every live tab lacks an id and the counts line up exactly, since a
   * mismatched guess would put the wrong name on the wrong tab.
   */
  function applyLiveTitles(roster, liveTabs, stats) {
    stats = stats || {};
    stats.mode = 'none';
    stats.matched = 0;
    stats.liveWithIds = 0;

    const norm = (v) => String(v == null ? '' : v).trim();
    const live = (Array.isArray(liveTabs) ? liveTabs : [])
      .map((t) => ({ id: norm(t && t.id), title: norm(t && t.title) }))
      .filter((t) => t.title);

    stats.liveCount = live.length;
    if (!live.length) return roster;

    const claimed = new Set();

    // 1. Exact id match — the only unambiguous route.
    const byId = new Map();
    for (const t of live) if (t.id) byId.set(t.id, t.title);
    stats.liveWithIds = byId.size;

    for (const tab of roster) {
      const title = byId.get(norm(tab.id));
      if (title) {
        tab.title = title;
        tab.titleSource = 'page';
        claimed.add(title);
        stats.matched++;
      }
    }
    if (stats.matched) stats.mode = 'id';

    const alive = roster.filter((t) => !t.deleted);

    // 2. Fill whatever is still unmatched by position, but only when the strip
    //    and the surviving roster are the same length — otherwise the alignment
    //    is a guess and would put the wrong name on the wrong tab.
    if (stats.matched < alive.length && alive.length === live.length) {
      alive.forEach((tab, i) => {
        if (tab.titleSource) return;
        const title = live[i].title;
        if (!title) return;
        tab.title = title;
        tab.titleSource = 'page-order';
        claimed.add(title);
        stats.matched++;
      });
      if (stats.mode === 'none') stats.mode = 'order';
      else if (stats.mode === 'id') stats.mode = 'id+order';
    }

    // 3. One tab still wearing a default name, and exactly one strip title that
    //    no tab claims: the pairing is forced, so take it. This is the case
    //    where the log recorded a tab's creation name and never its rename.
    const stale = alive.filter((t) => !t.titleSource && isDefaultTabName(t.title));
    const spare = live
      .map((t) => t.title)
      .filter((title) => !claimed.has(title) && !alive.some((r) => norm(r.title) === title));

    if (stale.length === 1 && spare.length === 1) {
      stale[0].title = spare[0];
      stale[0].titleSource = 'page-unique';
      stats.matched++;
      stats.mode = stats.mode === 'none' ? 'unique' : `${stats.mode}+unique`;
    }

    stats.sample = live.slice(0, 6).map((t) => `${t.id || '·'}=${t.title.slice(0, 24)}`);
    return roster;
  }

  /** A name Docs generated rather than one a person chose. */
  function isDefaultTabName(title) {
    const t = String(title || '').trim();
    return !t || /^tab\s*\d+$/i.test(t) || /^untitled( tab)?$/i.test(t);
  }

  /**
   * Pair a name we could not address with the tab that is still unnamed.
   *
   * Only when the pairing is forced: exactly one tab still wearing a Docs
   * default, and exactly one orphaned name that no tab already carries. Two of
   * either would be a guess, so nothing happens.
   */
  function pairOrphanNames(roster, events) {
    const alive = roster.filter((t) => !t.deleted);
    const stale = alive.filter((t) => !t.titleSource && isDefaultTabName(t.title));
    if (stale.length !== 1) return roster;

    const taken = new Set(alive.map((t) => String(t.title || '').trim().toLowerCase()));
    const orphans = [...new Set(
      events.filter((e) => e && e.kind === 'orphan-name' && e.name)
            .map((e) => e.name.trim())
    )].filter((n) => !taken.has(n.toLowerCase()) && !isDefaultTabName(n));

    if (orphans.length !== 1) return roster;

    stale[0].title = orphans[0];
    stale[0].titleSource = 'changelog-orphan';
    return roster;
  }

  /** Last resort: a tab with no name anywhere still needs something to show. */
  function finaliseTitles(roster) {
    let n = 0;
    for (const tab of roster) {
      n++;
      if (!tab.title) {
        tab.title = tab.id === ROOT_TAB ? 'First tab' : `Tab ${n}`;
        tab.fallbackTitle = true;
      }
      if (!tab.titleSource) tab.titleSource = 'changelog';
    }
    return roster;
  }

  /** Fold tab events into the current roster, in order. */
  function buildTabRoster(events) {
    const byId = new Map();
    for (const e of events) {
      if (!e || !e.id) continue;   // orphan names carry no id; handled later
      if (e.kind === 'delete') {
        const prev = byId.get(e.id);
        byId.set(e.id, { id: e.id, title: prev ? prev.title : '', deleted: true });
      } else {
        const prev = byId.get(e.id);
        const named = typeof e.name === 'string' && e.name.trim();
        byId.set(e.id, {
          id: e.id,
          // Never let a nameless event clobber a name we already have.
          title: named || (prev && prev.title) || '',
          deleted: false
        });
      }
    }
    return [...byId.values()];
  }

  function num() {
    for (const v of arguments) if (typeof v === 'number' && isFinite(v)) return v;
    return 0;
  }

  // ── Fold engine ────────────────────────────────────────────────────────────

  /**
   * Replays the op stream over a text buffer, recording exactly what each edit
   * did — including the text of everything deleted, which no export can show.
   */
  /**
   * The text buffer the fold replays edits over.
   *
   * This used to be a plain string rebuilt on every operation —
   * `buf.slice(0, at) + text + buf.slice(at)` — which allocates a fresh copy of
   * the whole document per edit. On a 10,000-edit document that is well over
   * 200 MB of throwaway strings, all of it on the Google Docs page's own heap,
   * and the garbage collection that follows is what made the editor stutter and
   * blank while Visor worked.
   *
   * Writing is a run of edits at one position, so holding the text split at that
   * position makes the common case a plain append, which V8 does without copying.
   * The buffer is only flattened when something genuinely needs the whole
   * string: a keyframe, a paste comparison, or the final text.
   */
  function GapBuffer() {
    this.l = '';        // text before the cursor
    this.r = '';        // text after it
    this._flat = '';    // cached flattening
    this._dirty = false;
  }
  GapBuffer.prototype.get = function () { return this.l.length + this.r.length; };
  Object.defineProperty(GapBuffer.prototype, 'length', {
    get() { return this.l.length + this.r.length; }
  });
  GapBuffer.prototype.seek = function (pos) {
    const p = pos < 0 ? 0 : (pos > this.length ? this.length : pos);
    if (p === this.l.length) return;              // already there: the typing case
    if (p < this.l.length) {
      this.r = this.l.slice(p) + this.r;
      this.l = this.l.slice(0, p);
    } else {
      const take = p - this.l.length;
      this.l += this.r.slice(0, take);
      this.r = this.r.slice(take);
    }
  };
  GapBuffer.prototype.insert = function (at, text) {
    this.seek(at);
    this.l += text;
    this._dirty = true;
  };
  GapBuffer.prototype.remove = function (at, len) {
    this.seek(at);
    const gone = this.r.slice(0, len);
    this.r = this.r.slice(len);
    this._dirty = true;
    return gone;
  };
  GapBuffer.prototype.toString = function () {
    if (this._dirty) { this._flat = this.l + this.r; this._dirty = false; }
    return this._flat;
  };

  function buildTimeline(entries, users, opts) {
    // A tab's edits index into that tab's own buffer, so a filtered view is
    // folded from only that tab's ops rather than sliced out of the whole.
    const only = opts && opts.tab ? String(opts.tab) : null;
    const steps     = [];   // one per mutation entry, in order
    const keyframes = [];   // { index, text } every KEYFRAME_EVERY steps
    const buf = new GapBuffer();

    // Recently removed text, for spotting a cut-then-paste move.
    const recentDeletes = [];

    for (let i = 0; i < entries.length; i++) {
      const e   = entries[i];
      const all = e._all || (e._all = normalize(e.mutation));
      const ops = only ? all.filter((o) => o.tab === only) : all;
      e._norm = ops;

      let inserted = '';
      let deleted  = '';
      let styled   = 0;
      let biggestInsert = 0;
      let pasteOrigin = null;

      // The document as it stood before this edit — the only moment at which
      // "was this text already here?" can be answered. Flattening the buffer to
      // capture it costs a full copy, so it is taken only for the steps that
      // actually contain a block big enough to be classified, which on a typed
      // document is a few dozen out of many thousands. The scan has to happen
      // up front: by the time a later op in the same step is reached, earlier
      // ops have already moved the buffer on.
      let before = null;
      for (const o of ops) {
        if (o.op === 'insert' && o.text.length >= PASTE_FLOOR) {
          before = buf.toString();
          break;
        }
      }

      for (const o of ops) {
        if (o.op === 'insert') {
          const at = Math.min(o.at, buf.length);
          buf.insert(at, o.text);
          inserted += o.text;
          if (o.text.length > biggestInsert) {
            biggestInsert = o.text.length;
            if (o.text.length >= PASTE_FLOOR) {
              pasteOrigin = classifyPaste(o.text, before, recentDeletes, e.time);
            }
          }
        } else if (o.op === 'delete') {
          const at  = Math.min(o.at, buf.length);
          const end = Math.min(at + o.len, buf.length);
          const gone = buf.remove(at, end - at);
          deleted += gone;
          if (gone.length >= PASTE_FLOOR) {
            recentDeletes.push({ text: gone, time: e.time });
            if (recentDeletes.length > 60) recentDeletes.shift();
          }
        } else if (o.op === 'style') {
          styled += o.len;
        }
      }

      steps.push({
        i,
        // With a tab filter on, an entry that touched some *other* tab still
        // has to occupy a slot here — keyframes and textAt() index steps by
        // entry position — but it must not be counted as an edit in this one.
        // Leaving it unmarked meant a tab's edit count, contributor list,
        // sessions and active time were all those of the whole document; only
        // the character counts actually narrowed.
        offTab: only ? ops.length === 0 : false,
        mutation: e.mutation,
        _norm: ops,
        rev: e.rev,
        tabId: e.tabId || null,
        time: e.time,
        userId: e.userId,
        sid: e.sid,
        inserted,
        deleted,
        styled,
        biggestInsert,
        pasteOrigin,
        length: buf.length
      });

      if (i % KEYFRAME_EVERY === 0) keyframes.push({ index: i, text: buf.toString() });
    }

    const finalText = buf.toString();

    return {
      steps,
      users,
      finalText,
      keyframes,
      /** Exact document text as of step `n` (inclusive). */
      textAt(n) {
        if (n < 0) return '';
        if (n >= steps.length - 1) return finalText;
        // A keyframe holds the buffer *after* its own step, so resume at +1.
        let kf = null;
        for (const k of keyframes) { if (k.index <= n) kf = k; else break; }
        // Same reason as the main fold: replaying forward from the keyframe by
        // slicing and concatenating copies the whole document once per edit.
        const g = new GapBuffer();
        if (kf) { g.l = kf.text; g._dirty = true; }
        for (let i = (kf ? kf.index + 1 : 0); i <= n; i++) {
          // Read the ops off the step, not off the shared entry. `entries[i]._norm`
          // is overwritten by whichever fold ran most recently, so a timeline
          // kept for a different tab selection would replay that tab's ops.
          for (const o of (steps[i] ? steps[i]._norm || [] : [])) {
            if (o.op === 'insert') {
              g.insert(Math.min(o.at, g.length), o.text);
            } else if (o.op === 'delete') {
              const at  = Math.min(o.at, g.length);
              const end = Math.min(at + o.len, g.length);
              g.remove(at, end - at);
            }
          }
        }
        return g.toString();
      }
    };
  }

  /**
   * Where a pasted block came from.
   *
   * Text moved or duplicated inside the document is not text brought in from
   * outside, and treating the two the same overstates how much of a document
   * arrived from elsewhere. A paste counts as internal when the same text was
   * already in the document, or was cut from it shortly beforehand.
   */
  const MOVE_WINDOW_MS = 10 * 60_000;   // a cut and its paste, generously spaced

  function classifyPaste(text, before, recentDeletes, time) {
    const needle = squash(text);
    if (needle.length < PASTE_FLOOR) return 'external';

    // Still present in the document: a copy of something already written.
    if (squash(before).includes(needle)) return 'internal-copy';

    // Cut a moment ago and put back somewhere else: a move.
    for (let i = recentDeletes.length - 1; i >= 0; i--) {
      const d = recentDeletes[i];
      if (time && d.time && time - d.time > MOVE_WINDOW_MS) break;
      const hay = squash(d.text);
      if (hay.includes(needle) || needle.includes(hay)) return 'internal-move';
    }

    // Allow for light editing after the fact by matching a leading run.
    const head = needle.slice(0, 120);
    if (head.length >= PASTE_FLOOR && squash(before).includes(head)) return 'internal-copy';

    return 'external';
  }

  /** Whitespace-insensitive comparison; layout changes on paste are routine. */
  function squash(t) {
    return String(t || '').replace(/\s+/g, ' ').trim();
  }

  /**
   * What counts as a paste in *this* document, measured rather than assumed.
   *
   * A fixed size cannot be right for everyone: Google batches fast keystrokes
   * into larger single operations, so one person's ordinary typing is another's
   * paste threshold. Instead, look at how big an insert gets during continuous
   * typing in this document, and treat anything beyond that as not typed.
   */
  function derivePasteThreshold(steps) {
    const sizes = [];
    for (let i = 1; i < steps.length; i++) {
      const a = steps[i - 1], b = steps[i];
      if (!b.biggestInsert) continue;
      const gap = (a.time && b.time) ? b.time - a.time : Infinity;
      if (gap > 2000) continue;              // only inserts mid-burst
      sizes.push(b.biggestInsert);
    }

    if (sizes.length < 30) {
      return { value: PASTE_FLOOR, source: 'floor', samples: sizes.length };
    }

    sizes.sort((x, y) => x - y);
    const p99 = sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * 0.99))];
    return {
      value: Math.max(PASTE_FLOOR, p99 + 1),
      source: 'derived',
      samples: sizes.length,
      typingP99: p99
    };
  }

  // ── Analytics ──────────────────────────────────────────────────────────────

  /**
   * Contributor colors. Pink is deliberately absent: the UI reserves it for
   * deleted and pasted text, and an author tinted the same color makes their
   * own insert/delete bar unreadable.
   */
  /* Author colours: a muted categorical set, distinguishable from each other
   * and legible on both the light and the dark surface. The previous set was
   * the bright end of the spectrum — cyan, mint, lilac, amber — which read as
   * decoration rather than as a key to the data. */
  const PALETTE = [
    '#2F6FC4', '#118A7E', '#B4603A', '#7A56C2',
    '#B03A69', '#3D8B4F', '#2A7E9E', '#7A6A46'
  ];

  function analyze(timeline) {
    const steps = timeline.steps.filter(
      (s) => !s.offTab && (s.time > 0 || s.inserted || s.deleted));
    if (!steps.length) return emptyAnalysis(timeline);

    // Derived first: everything downstream depends on what counts as a paste.
    const pt = derivePasteThreshold(steps);
    const pasteThreshold = pt.value;

    const byUser   = new Map();
    const sessions = [];
    const pastes   = [];
    const deletions = [];

    let cur = null;
    let prev = null;

    for (const s of steps) {
      const uid = s.userId == null ? '0' : s.userId;
      const u = userRec(byUser, uid, timeline.users);

      // ── per-contributor totals ──
      u.inserted   += s.inserted.length;
      u.deleted    += s.deleted.length;
      u.styleOps   += s.styled ? 1 : 0;
      u.mutations  += 1;
      if (s.time) {
        if (!u.first || s.time < u.first) u.first = s.time;
        if (!u.last  || s.time > u.last)  u.last  = s.time;
      }

      // ── active time: only count gaps a human could plausibly be present for ──
      if (prev && prev.time && s.time) {
        const gap = s.time - prev.time;
        if (gap > 0 && gap <= IDLE_GAP_MS) {
          const owner = userRec(byUser, prev.userId == null ? '0' : prev.userId, timeline.users);
          owner.activeMs += gap;
        }
        // Typing cadence: consecutive keystrokes only, no pasted blocks and no
        // pauses long enough to mean the person stopped.
        if (gap > 0 && gap <= 5000 && s.biggestInsert < pasteThreshold && s.inserted.length) {
          u.typingChars += s.inserted.length;
          u.typingMs += gap;
        }
      }

      // ── sessions ──
      // A session is a continuous stretch of work on the document, not on one
      // person's work: two people editing at the same time are in the same
      // session. Only a gap in time ends one. `authors` keeps the per-person
      // split inside it, and `userId` names whoever wrote the most.
      const brokeSession = !cur ||
        (s.time && cur.end && s.time - cur.end > SESSION_GAP_MS);

      if (brokeSession) {
        cur = {
          userId: uid,
          authors: [],
          start: s.time,
          end: s.time,
          firstStep: s.i,
          lastStep: s.i,
          inserted: 0,
          deleted: 0,
          mutations: 0,
          pastes: 0
        };
        sessions.push(cur);
      }
      cur.end = s.time || cur.end;
      cur.lastStep = s.i;
      cur.inserted += s.inserted.length;
      cur.deleted  += s.deleted.length;
      cur.mutations += 1;

      let seat = cur.authors.find((a) => a.userId === uid);
      if (!seat) {
        seat = { userId: uid, inserted: 0, deleted: 0, mutations: 0 };
        cur.authors.push(seat);
      }
      seat.inserted += s.inserted.length;
      seat.deleted  += s.deleted.length;
      seat.mutations += 1;

      // ── pastes: a fact in this data, not a heuristic ──
      if (s.biggestInsert >= pasteThreshold) {
        const kind = 'paste';
        const origin = s.pasteOrigin || (kind === 'paste' ? 'external' : null);
        if (kind === 'paste') {
          cur.pastes += 1;
          u.pastes += 1;
          u.pastedChars += s.biggestInsert;
          if (origin === 'external') {
            u.externalPastes += 1;
            u.externalPastedChars += s.biggestInsert;
          } else {
            u.internalPastes += 1;
            u.internalPastedChars += s.biggestInsert;
          }
        }
        pastes.push({
          step: s.i,
          rev: s.rev,
          time: s.time,
          userId: uid,
          kind,
          origin,
          length: s.biggestInsert,
          text: s.inserted.slice(0, 4000)
        });
      }

      // ── recovered deletions: text that exists nowhere in any export ──
      if (s.deleted.length >= DELETION_FLOOR) {
        deletions.push({
          step: s.i,
          rev: s.rev,
          time: s.time,
          userId: uid,
          length: s.deleted.length,
          text: s.deleted.slice(0, 4000)
        });
      }

      prev = s;
    }

    // Inside a session, order the authors by how much they wrote and let the
    // largest contributor stand for the session where only one name fits.
    for (const sess of sessions) {
      sess.authors.sort((a, b) =>
        (b.inserted + b.deleted) - (a.inserted + a.deleted) ||
        b.mutations - a.mutations);
      if (sess.authors.length) sess.userId = sess.authors[0].userId;
    }

    // ── finalise contributors ──
    const roster = collapseIfImplausible(byUser);
    assignLabels([...roster.values()]);
    const contributors = [...roster.values()].map((u, i) => {
      u.color = u.color || PALETTE[i % PALETTE.length];
      u.activeMinutes = Math.round(u.activeMs / 60000);
      u.net = u.inserted - u.deleted;
      u.deleteRatio = u.inserted ? u.deleted / u.inserted : 0;
      u.typedChars = Math.max(0, u.inserted - u.pastedChars);
      // Words per minute, the conventional five-characters-to-a-word measure.
      // Only meaningful once somebody has actually written something.
      u.wpm = (u.typingMs > 0 && u.inserted >= 100)
        ? Math.round((u.typingChars / 5) / (u.typingMs / 60000))
        : null;
      return u;
    }).sort((a, b) => b.inserted - a.inserted);

    const totalInserted = contributors.reduce((s, c) => s + c.inserted, 0) || 1;
    for (const c of contributors) c.share = c.inserted / totalInserted;

    const first = steps.find((s) => s.time)?.time || 0;
    const last  = [...steps].reverse().find((s) => s.time)?.time || 0;

    // When the roster was collapsed, every downstream reference must point at
    // the single merged author or it will resolve to nothing.
    const collapsed = contributors.length === 1 && contributors[0].collapsed;
    const reown = (x) => (collapsed ? { ...x, userId: '0' } : x);

    let provenance = buildProvenance(timeline, pasteThreshold);
    if (collapsed) {
      provenance = [provenance.reduce((acc, p) => ({
        userId: '0',
        typed: acc.typed + p.typed,
        bulk: acc.bulk + p.bulk,
        paste: acc.paste + p.paste,
        total: acc.total + p.total
      }), { userId: '0', typed: 0, bulk: 0, paste: 0, total: 0 })];
    }

    return {
      contributors,
      collapsedRoster: collapsed ? contributors[0].collapsedFrom : 0,
      sessions: sessions.filter((s) => s.mutations > 0).map((s) => (collapsed
        ? { ...s, userId: '0', authors: [{
            userId: '0',
            inserted: s.inserted,
            deleted: s.deleted,
            mutations: s.mutations
          }] }
        : s)),
      pastes: pastes.map(reown),
      deletions: deletions.map(reown),
      totals: {
        mutations: steps.length,
        revisions: timeline.steps.length,
        inserted: totalInserted,
        deleted: contributors.reduce((s, c) => s + c.deleted, 0),
        finalChars: timeline.finalText.length,
        finalWords: countWords(timeline.finalText),
        pasteCount: pastes.filter((p) => p.kind === 'paste').length,
        pastedChars: contributors.reduce((s, c) => s + c.pastedChars, 0),
        externalPastes: contributors.reduce((s, c) => s + c.externalPastes, 0),
        externalPastedChars: contributors.reduce((s, c) => s + c.externalPastedChars, 0),
        internalPastes: contributors.reduce((s, c) => s + c.internalPastes, 0),
        internalPastedChars: contributors.reduce((s, c) => s + c.internalPastedChars, 0),
        activeMinutes: Math.round(contributors.reduce((s, c) => s + c.activeMs, 0) / 60000),
        firstEdit: first,
        lastEdit: last,
        spanDays: first && last ? Math.max(1, Math.round((last - first) / 86_400_000)) : 0
      },
      provenance,
      pasteThreshold: pt,
      heatmap: buildHeatmap(steps),
      calendar: buildCalendar(steps, pasteThreshold),
      growth: buildGrowth(steps),
      behavior: behaviorProfile(timeline, steps, contributors, pasteThreshold)
    };
  }

  /**
   * The result for a selection with nothing in it — a document tab nobody has
   * written in yet, for instance. It must carry every field a full analysis
   * does: the side panel and the bottom bar render straight from it, and a
   * missing `calendar` or `pasteThreshold` broke those views outright, while
   * the old `behavior` shape (score / verdict) no longer matches anything that
   * reads it.
   */
  function emptyAnalysis(timeline) {
    return {
      contributors: [], collapsedRoster: 0, sessions: [], pastes: [], deletions: [],
      totals: {
        mutations: 0, revisions: 0, inserted: 0, deleted: 0,
        finalChars: timeline.finalText.length,
        finalWords: countWords(timeline.finalText),
        pasteCount: 0, pastedChars: 0,
        externalPastes: 0, externalPastedChars: 0,
        internalPastes: 0, internalPastedChars: 0,
        activeMinutes: 0, firstEdit: 0, lastEdit: 0, spanDays: 0
      },
      provenance: [], heatmap: [], growth: [],
      calendar: buildCalendar([], PASTE_FLOOR),
      pasteThreshold: { value: PASTE_FLOOR, source: 'floor', samples: 0 },
      behavior: {
        measured: false, enough: false, minEdits: 0,
        externalShare: 0, externalChars: 0, internalChars: 0,
        typedChars: 0, totalChars: 0, delRatio: 0, cps: 0,
        pasteThreshold: PASTE_FLOOR, observations: []
      }
    };
  }


  function userRec(map, uid, users) {
    if (!map.has(uid)) {
      const meta = users.find((u) => u.id === uid) || {};
      // Real identity if the document carries one. Otherwise leave the name
      // blank here — a readable label is assigned later, once the roster is
      // known and authors can be lettered in the order they first appear.
      map.set(uid, {
        id: uid,
        name: meta.name || meta.email || null,
        email: meta.email || null,
        anonymous: !!meta.anonymous,
        identified: !!(meta.name || meta.email),
        photo: meta.photo || null,
        color: meta.color || null,
        inserted: 0, deleted: 0, pastedChars: 0, pastes: 0,
        externalPastes: 0, externalPastedChars: 0,
        internalPastes: 0, internalPastedChars: 0,
        typingChars: 0, typingMs: 0,
        mutations: 0, styleOps: 0, activeMs: 0,
        first: 0, last: 0
      });
    }
    return map.get(uid);
  }

  /**
   * Give every author a usable name.
   *
   * Google frequently omits the roster. When it does, the person is still real
   * and still wrote part of the document — we simply were not handed a name —
   * so they are numbered in the order they first touched it: Unknown 1,
   * Unknown 2, and so on. Stable across re-runs and easy to refer to.
   */
  function assignLabels(list) {
    // Named and anonymous authors are numbered independently, so a document
    // with one of each reads "Unknown 1" and "Anonymous 1" rather than skipping
    // a number in either sequence.
    let nUnknown = 0;
    let nAnon = 0;

    list
      .filter((u) => !u.name)
      .sort((a, b) => (a.first || Infinity) - (b.first || Infinity))
      .forEach((u) => {
        u.name = u.anonymous ? `Anonymous ${++nAnon}` : `Unknown ${++nUnknown}`;
        u.numbered = true;
      });
  }

  /**
   * Safety net. A document has a handful of authors. If we ever end up with a
   * crowd, the author column was misidentified — collapse rather than present
   * hundreds of fictional people as though they were real collaborators.
   */
  const MAX_PLAUSIBLE_AUTHORS = 60;

  function collapseIfImplausible(byUser) {
    if (byUser.size <= MAX_PLAUSIBLE_AUTHORS) return byUser;

    const merged = {
      id: '0', name: 'All authors combined', email: null, identified: false,
      anonymous: false, photo: null, color: null,
      collapsed: true, collapsedFrom: byUser.size,
      inserted: 0, deleted: 0, pastedChars: 0, pastes: 0,
      externalPastes: 0, externalPastedChars: 0,
      internalPastes: 0, internalPastedChars: 0,
      typingChars: 0, typingMs: 0,
      mutations: 0, styleOps: 0, activeMs: 0, first: 0, last: 0
    };
    for (const u of byUser.values()) {
      merged.inserted += u.inserted;
      merged.deleted += u.deleted;
      merged.pastedChars += u.pastedChars;
      merged.pastes += u.pastes;
      merged.externalPastes += u.externalPastes;
      merged.externalPastedChars += u.externalPastedChars;
      merged.internalPastes += u.internalPastes;
      merged.internalPastedChars += u.internalPastedChars;
      merged.typingChars += u.typingChars;
      merged.typingMs += u.typingMs;
      merged.mutations += u.mutations;
      merged.styleOps += u.styleOps;
      merged.activeMs += u.activeMs;
      if (u.first && (!merged.first || u.first < merged.first)) merged.first = u.first;
      if (u.last > merged.last) merged.last = u.last;
    }
    return new Map([['0', merged]]);
  }

  /**
   * Character-level provenance of the *surviving* text: replay forward and tag
   * each surviving character with the author and the arrival mode that put it
   * there. This is what makes attribution exact rather than apportioned.
   */
  function buildProvenance(timeline, pasteThreshold) {
    // A second fold that carries an authorship mark alongside every character,
    // so the tally at the end describes the text that actually survived rather
    // than everything that was ever written.
    let len = 0;
    const marks = []; // parallel to the buffer, one entry per surviving char

    for (const s of timeline.steps) {
      for (const o of normalizeStep(s)) {
        if (o.op === 'insert') {
          const at = Math.min(o.at, len);
          const mode = o.text.length >= (pasteThreshold || PASTE_FLOOR) ? 'paste' : 'typed';
          const tag = { u: s.userId == null ? '0' : s.userId, m: mode };
          spliceFill(marks, at, o.text.length, tag);
          len += o.text.length;
        } else if (o.op === 'delete') {
          const at  = Math.min(o.at, len);
          const end = Math.min(at + o.len, len);
          marks.splice(at, end - at);
          len -= (end - at);
        }
      }
    }

    const tally = new Map();
    for (const m of marks) {
      if (!m) continue;
      const key = m.u;
      if (!tally.has(key)) tally.set(key, { userId: key, typed: 0, bulk: 0, paste: 0, total: 0 });
      const t = tally.get(key);
      t[m.m] += 1;
      t.total += 1;
    }
    return [...tally.values()].sort((a, b) => b.total - a.total);
  }

  /** Cached per-step normalisation — the fold and provenance pass share it. */
  function normalizeStep(s) {
    if (!s._norm) s._norm = normalize(s.mutation);
    return s._norm;
  }

  /**
   * Per-day detail, rich enough for the panel to re-bin by week, month or year
   * without another pass over the log. Each day keeps its own 24-hour profile,
   * so "when during the day was this written" is answerable per day rather than
   * only in aggregate.
   */
  function buildCalendar(steps, pasteThreshold) {
    const days = new Map();

    const dayOf = (ms) => {
      const d = new Date(ms);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    };

    let prev = null;
    for (const s of steps) {
      if (!s.time) continue;
      const key = dayOf(s.time);
      let day = days.get(key);
      if (!day) {
        day = {
          date: key,
          count: 0, inserted: 0, deleted: 0, pastes: 0,
          activeMs: 0,
          firstEdit: s.time, lastEdit: s.time,
          hours: new Array(24).fill(0),
          users: {}
        };
        days.set(key, day);
      }

      const uid = s.userId == null ? '0' : s.userId;
      day.count += 1;
      day.inserted += s.inserted.length;
      day.deleted += s.deleted.length;
      if (s.biggestInsert >= (pasteThreshold || PASTE_FLOOR)) day.pastes += 1;
      day.hours[new Date(s.time).getHours()] += 1;
      day.users[uid] = (day.users[uid] || 0) + 1;
      if (s.time < day.firstEdit) day.firstEdit = s.time;
      if (s.time > day.lastEdit) day.lastEdit = s.time;

      // Active time accrues to the day the earlier edit belongs to, so a
      // session spanning midnight does not credit the whole gap to one side.
      if (prev && prev.time) {
        const gap = s.time - prev.time;
        if (gap > 0 && gap <= IDLE_GAP_MS) {
          const owner = days.get(dayOf(prev.time));
          if (owner) owner.activeMs += gap;
        }
      }
      prev = s;
    }

    const list = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
    for (const d of list) d.activeMinutes = Math.round(d.activeMs / 60000);

    return {
      days: list,
      byHour: aggregateHours(list),
      byWeekday: aggregateWeekdays(list),
      span: list.length ? { first: list[0].date, last: list[list.length - 1].date } : null,
      activeDays: list.length,
      busiestDay: list.reduce((best, d) => (!best || d.count > best.count ? d : best), null),
      longestGapDays: longestGap(list)
    };
  }

  function aggregateHours(days) {
    const out = new Array(24).fill(0);
    for (const d of days) for (let h = 0; h < 24; h++) out[h] += d.hours[h];
    return out;
  }

  function aggregateWeekdays(days) {
    const out = new Array(7).fill(0);
    for (const d of days) out[new Date(`${d.date}T00:00:00`).getDay()] += d.count;
    return out;
  }

  /** Longest stretch of calendar days with no edits at all. */
  function longestGap(days) {
    let worst = 0;
    for (let i = 1; i < days.length; i++) {
      const a = new Date(`${days[i - 1].date}T00:00:00`);
      const b = new Date(`${days[i].date}T00:00:00`);
      const gap = Math.round((b - a) / 86_400_000) - 1;
      if (gap > worst) worst = gap;
    }
    return worst;
  }

  function buildHeatmap(steps) {
    const byHour = new Map(); // "YYYY-MM-DD|H" → count
    for (const s of steps) {
      if (!s.time) continue;
      const d = new Date(s.time);
      const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}|${d.getHours()}`;
      byHour.set(key, (byHour.get(key) || 0) + 1);
    }
    return [...byHour.entries()].map(([k, count]) => {
      const [date, hour] = k.split('|');
      return { date, hour: +hour, count };
    }).sort((a, b) => a.date.localeCompare(b.date) || a.hour - b.hour);
  }

  function buildGrowth(steps) {
    const MAX_POINTS = 400;
    const stride = Math.max(1, Math.ceil(steps.length / MAX_POINTS));
    const out = [];
    for (let i = 0; i < steps.length; i += stride) {
      const s = steps[i];
      out.push({ step: s.i, time: s.time, length: s.length });
    }
    const last = steps[steps.length - 1];
    if (last && (!out.length || out[out.length - 1].step !== last.i)) {
      out.push({ step: last.i, time: last.time, length: last.length });
    }
    return out;
  }

  /**
   * Behavioural authorship signal.
   *
   * This deliberately does NOT judge the prose. It measures how the text
   * arrived — which is observable, verifiable, and far harder to argue with
   * than stylometry. Text that was composed in the document leaves revision,
   * deletion and cadence evidence. Text that arrived elsewhere does not.
   */
  /**
   * How the text arrived, as a measurement rather than a verdict.
   *
   * There is deliberately no weighted score here any more. The old version
   * added up hand-picked penalties and bonuses against hand-picked thresholds,
   * which meant the headline number encoded my opinions rather than the
   * document's contents. The number reported now is one thing that was actually
   * counted: the share of inserted characters that arrived as a block from
   * outside this document. Everything else is reported beside it as a measured
   * observation, contributing nothing to the figure.
   */
  function behaviorProfile(timeline, steps, contributors, pasteThreshold) {
    const totalIns = contributors.reduce((s, c) => s + c.inserted, 0);
    const totalDel = contributors.reduce((s, c) => s + c.deleted, 0);
    const external = contributors.reduce((s, c) => s + c.externalPastedChars, 0);
    const internal = contributors.reduce((s, c) => s + c.internalPastedChars, 0);
    const typed    = Math.max(0, totalIns - external - internal);

    const externalShare = totalIns ? external / totalIns : 0;
    const delRatio = totalIns ? totalDel / totalIns : 0;
    const cps = typingRate(steps, pasteThreshold);

    const observations = [];

    // Every entry states a measured quantity. None of them move the number.
    observations.push({
      label: `${fmtInt(typed)} characters typed in`,
      detail: 'Arrived one keystroke at a time, in operations small enough to be keyboard input.',
      measure: `${pct(totalIns ? typed / totalIns : 0)} of all text`
    });

    if (internal) {
      observations.push({
        label: `${fmtInt(internal)} characters in internal pastes`,
        detail: 'Cut, copied or reordered inside this document — the same text was already here.',
        measure: `${pct(totalIns ? internal / totalIns : 0)} of all text`
      });
    }

    if (external) {
      const biggest = Math.max(0, ...timeline.steps
        .filter((s) => s.pasteOrigin === 'external')
        .map((s) => s.biggestInsert || 0));
      observations.push({
        label: `${fmtInt(external)} characters in external pastes`,
        detail: `Arrived in ${fmtInt(contributors.reduce((n, c) => n + c.externalPastes, 0))} block${
          contributors.reduce((n, c) => n + c.externalPastes, 0) === 1 ? '' : 's'
        }; the largest was ${fmtInt(biggest)} characters.`,
        measure: `${pct(externalShare)} of all text`
      });
    }

    observations.push({
      label: `${fmtInt(totalDel)} characters deleted`,
      detail: 'Text written and then removed. Composition normally deletes as it goes; transplanted text usually does not.',
      measure: `${pct(delRatio)} of what was written`
    });

    if (cps > 0) {
      observations.push({
        label: `${cps.toFixed(1)} characters per second while typing`,
        detail: 'Measured across consecutive keystrokes, excluding pasted blocks and pauses over five seconds.',
        measure: `${Math.round(cps * 60 / 5)} wpm`
      });
    }

    // The only judgement left is whether there is enough history to bother
    // reporting a share at all, and that bar is stated rather than hidden.
    const MIN_EDITS = 20;
    const enough = steps.length >= MIN_EDITS && totalIns > 0;

    return {
      measured: true,
      enough,
      minEdits: MIN_EDITS,
      externalShare,
      externalChars: external,
      internalChars: internal,
      typedChars: typed,
      totalChars: totalIns,
      delRatio,
      cps,
      pasteThreshold,
      observations
    };
  }

  function typingRate(steps, pasteThreshold) {
    const cut = pasteThreshold || PASTE_FLOOR;
    let chars = 0, ms = 0;
    for (let i = 1; i < steps.length; i++) {
      const a = steps[i - 1], b = steps[i];
      if (!a.time || !b.time) continue;
      const gap = b.time - a.time;
      if (gap <= 0 || gap > 5000) continue;
      if (b.biggestInsert >= cut) continue;      // pasted blocks are not typing
      chars += b.inserted.length;
      ms += gap;
    }
    return ms > 0 ? (chars / (ms / 1000)) : 0;
  }

  // ── Small helpers ──────────────────────────────────────────────────────────

  /**
   * Insert `n` copies of `tag` at `at`. Chunked because a 50k-character paste
   * spread into splice() as arguments overflows the call stack.
   */
  function spliceFill(arr, at, n, tag) {
    const CHUNK = 4096;
    let placed = 0;
    while (placed < n) {
      const size = Math.min(CHUNK, n - placed);
      const block = new Array(size);
      for (let i = 0; i < size; i++) block[i] = tag;
      arr.splice(at + placed, 0, ...block);
      placed += size;
    }
  }

  const pad = (n) => String(n).padStart(2, '0');
  const pct = (x) => `${Math.round(x * 100)}%`;
  const fmtInt = (n) => Number(n || 0).toLocaleString();
  const countWords = (t) => (t.trim() ? t.trim().split(/\s+/).length : 0);

  // ── Public surface ─────────────────────────────────────────────────────────
  root.VisorChangelog = {
    fetchChangelog,
    latestRevision,
    probeLastRevision,
    buildTimeline,
    analyze,
    normalize,
    constants: { IDLE_GAP_MS, SESSION_GAP_MS, PASTE_FLOOR, DELETION_FLOOR }
  };
})(typeof self !== 'undefined' ? self : this);
