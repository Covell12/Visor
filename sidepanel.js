/* ============================================================================
 * Visor — Side Panel
 * ----------------------------------------------------------------------------
 * Pure presentation. Every number rendered here came from folding the
 * document's own edit stream in the content script; nothing is fetched, and
 * nothing leaves the browser.
 * ==========================================================================*/

'use strict';

const $  = (id) => document.getElementById(id);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const STATES = ['state-nodoc', 'state-viewonly', 'state-empty', 'state-error', 'state-loading'];

let current = null;   // last analysis
let meta    = null;   // { fileId, kind, title }
let tabId   = null;

// ── Tab plumbing ─────────────────────────────────────────────────────────────

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

function ask(type, payload = {}) {
  return new Promise((resolve) => {
    if (tabId == null) return resolve(null);
    chrome.tabs.sendMessage(tabId, { type, ...payload }, (resp) => {
      if (chrome.runtime.lastError) return resolve(null);
      resolve(resp);
    });
  });
}

// ── State machine ────────────────────────────────────────────────────────────

function show(which) {
  STATES.forEach((id) => $(id).classList.toggle('hidden', id !== which));
  $('main').classList.toggle('hidden', which !== null);
}

function setProgress(v, label) {
  $('progress-fill').style.width = `${Math.round(v * 100)}%`;
  if (label) $('loading-label').textContent = label;
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== 'VISOR_PROGRESS') return;
  if (sender && sender.tab && sender.tab.id !== tabId) return;
  const labels = {
    fetch:   'Reading revision stream…',
    fold:    'Replaying every edit in order…',
    analyze: 'Measuring what actually happened…',
    done:    'Done'
  };
  setProgress(msg.value, labels[msg.phase]);
});

async function boot() {
  const tab = await activeTab();
  if (!tab || !/^https:\/\/docs\.google\.com\/(document|presentation)\/d\//.test(tab.url || '')) {
    return show('state-nodoc');
  }
  tabId = tab.id;

  const status = await ask('VISOR_STATUS');
  if (!status) {
    // Content script absent — almost always a page loaded before install.
    $('error-message').textContent =
      'Reload the document tab so Visor can analyze it, then try again.';
    return show('state-error');
  }

  meta = status.meta;
  $('doc-title').textContent = meta.title || 'Untitled';

  if (status.state === 'view-only') return show('state-viewonly');
  if (status.state === 'no-document') return show('state-nodoc');

  await analyze(false);
}

async function analyze(force, attempt = 0) {
  show('state-loading');
  setProgress(0.02, 'Reading revision stream…');

  const res = await ask('VISOR_ANALYZE', { force });
  if (!res) {
    $('error-message').textContent = 'Lost contact with the document tab.';
    return show('state-error');
  }

  switch (res.state) {
    case 'view-only': return show('state-viewonly');
    case 'no-document': return show('state-nodoc');
    case 'empty': return show('state-empty');
    // The document moved on while it was being read: start again on the new one.
    case 'stale': return boot();
    // The page is already reading — the bar refreshes on its own schedule, and
    // asking again would only queue a second fold. Wait for the one in flight
    // rather than sitting on the loading screen for ever, which is what this
    // used to do: 'running' fell through to the default and nothing retried.
    case 'running':
      if (attempt > 40) {
        $('error-message').textContent = 'The document is taking longer than expected to read.';
        return show('state-error');
      }
      await new Promise((r) => setTimeout(r, 400));
      return analyze(false, attempt + 1);
    case 'error':
      $('error-message').textContent = res.error || 'Unknown failure.';
      return show('state-error');
    case 'ready':
      current = res.analysis;
      meta = res.meta || meta;
      $('doc-title').textContent = meta.title || 'Untitled';
      render(current);
      renderScope(res.tabState || (current && current.tabState));
      show(null);
      return;
    default:
      return show('state-loading');
  }
}

// ── Render ───────────────────────────────────────────────────────────────────

function render(a) {
  renderMetrics(a);
  renderGrowth(a.growth);
  renderHeatmap(a.heatmap);
  renderPeople(a);
  renderProvenance(a);
  renderSessions(a);
  renderEvidence(a);
  renderSignal(a);
}

function renderMetrics(a) {
  const t = a.totals;
  const people = a.contributors || [];

  /*
   * The overview opens with one figure, not six.
   *
   * Six identical boxes gave every number the same weight and the page no
   * shape at all — the thing you actually want to know (how much of this
   * document there is, and who wrote it) had to be found among five other
   * numbers in the same grey. The headline sits on the one dark panel in the
   * extension, with the authorship underneath it, and everything else follows
   * in a single quiet strip.
   */
  const days = t.spanDays ? `${t.spanDays} day${t.spanDays === 1 ? '' : 's'}` : 'one sitting';
  // A document whose log names nobody still has a span; it just has no "by".
  const who = people.length === 1 ? esc(firstName(people[0].name))
            : people.length > 1  ? `${people.length} people`
            : '';
  const sub = who ? `written by ${who} over ${esc(days)}` : `written over ${esc(days)}`;

  const dots = people.slice(0, 6).map((c) => `
    <span class="v-hero-who" style="--c:${esc(c.color)}">
      <i></i>${esc(firstName(c.name))}<b>${Math.round((c.share || 0) * 100)}%</b>
    </span>`).join('');

  const strip = [
    { v: fmtInt(t.mutations),      l: 'edits' },
    { v: fmtMins(t.activeMinutes), l: 'writing',  tone: 'good' },
    { v: fmtInt(t.pasteCount),     l: t.pasteCount === 1 ? 'paste' : 'pastes', tone: t.pasteCount ? 'warm' : '' },
    { v: fmtInt(t.deleted),        l: 'deleted', tone: t.deleted ? 'hot' : '' }
  ];

  $('metrics').innerHTML = `
    <div class="v-hero">
      <div class="v-hero-figure">
        <span class="v-hero-value">${esc(fmtInt(t.finalWords))}</span>
        <span class="v-hero-unit">words</span>
      </div>
      <div class="v-hero-sub">${sub}</div>
      ${dots ? `<div class="v-hero-people">${dots}</div>` : ''}
    </div>
    <div class="v-strip">
      ${strip.map((c) => `
        <div class="v-stat${c.tone ? ` is-${c.tone}` : ''}">
          <span class="v-stat-value">${esc(c.v)}</span>
          <span class="v-stat-label">${esc(c.l)}</span>
        </div>`).join('')}
    </div>`;
}

function renderGrowth(growth) {
  const host = $('growth-chart');
  if (!growth || growth.length < 2) {
    host.innerHTML = `<div class="v-empty">Not enough edits to chart.</div>`;
    return;
  }

  const W = 300, H = 108, PAD = 6;
  const max = Math.max(...growth.map((g) => g.length), 1);
  const xy = growth.map((g, i) => [
    PAD + (i / (growth.length - 1)) * (W - PAD * 2),
    H - PAD - (g.length / max) * (H - PAD * 2)
  ]);
  const line = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${PAD},${H - PAD} ${line} ${W - PAD},${H - PAD}`;
  const len  = Math.round(pathLength(xy));

  host.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
         aria-label="Document length over time">
      <defs>
        <linearGradient id="v-growth" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stop-color="var(--accent)" stop-opacity="0.42"/>
          <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <polygon class="v-chart-area" points="${area}" fill="url(#v-growth)"/>
      <polyline class="v-chart-line" points="${line}" fill="none"
                stroke="var(--accent)" stroke-width="2"
                stroke-linejoin="round" stroke-linecap="round"
                style="--len:${len}"/>
      <line class="v-chart-cursor" id="growth-cursor" y1="${PAD}" y2="${H - PAD}"
            stroke="var(--ink-3)" stroke-width="1" stroke-dasharray="3 3"/>
      <circle class="v-chart-cursor" id="growth-dot" r="3.5"
              fill="var(--accent)" stroke="white" stroke-width="1.5"/>
    </svg>
    <div class="v-chart-tip" id="growth-tip"></div>`;

  wireGrowthHover(host, growth, xy, W, H);
}

/**
 * Where a centred tooltip may sit so that it stays within its card.
 *
 * `at` is where the point is, `width` the card's inner width. The label is
 * translated by half its own width, so its edges are at `left ± half`.
 */
function tipLeft(tip, at, width) {
  const half = (tip.offsetWidth || 90) / 2;
  const edge = 4;
  if (width <= half * 2 + edge * 2) return width / 2;   // narrower than the label
  return Math.max(half + edge, Math.min(at, width - half - edge));
}

let growthHoverController = null;

function wireGrowthHover(host, growth, xy, W, H) {
  const svg    = host.querySelector('svg');
  const cursor = host.querySelector('#growth-cursor');
  const dot    = host.querySelector('#growth-dot');
  const tip    = host.querySelector('#growth-tip');

  // One layout read and one batch of writes per frame. getBoundingClientRect()
  // inside pointermove forces a synchronous layout, and the writes that follow
  // invalidate it again — at the display's refresh rate that is what made the
  // panel stutter under the pointer. The chart does not move while you hover
  // it, so the rect is read once and dropped when anything could have moved it.
  let hoverX = 0;
  let hoverQueued = false;
  let hoverRect = null;
  let cardRect = null;
  let hovering = false;

  /*
   * One set of handlers at a time.
   *
   * The chart's host element is static markup — only its contents are
   * replaced — so every render used to add another pointermove listener to the
   * same node, and another pair on the window. The panel re-renders on every
   * refresh, which is every few seconds while a document is being edited, so
   * within an hour a single pointer move ran dozens of stale callbacks, each
   * measuring layout. Aborting the previous render's handlers keeps it at one.
   */
  if (growthHoverController) growthHoverController.abort();
  growthHoverController = new AbortController();
  const { signal } = growthHoverController;

  const dropRects = () => { hoverRect = null; cardRect = null; };
  host.addEventListener('pointerenter', () => { hovering = true; dropRects(); }, { passive: true, signal });
  addEventListener('scroll', dropRects, { passive: true, capture: true, signal });
  addEventListener('resize', dropRects, { passive: true, signal });

  const paintHover = () => {
    hoverQueued = false;
    if (!hovering) return;          // the pointer left before this frame ran
    // The label is absolutely positioned against its offset parent, which is
    // the card, not the chart inside it. Measuring the chart and writing the
    // result as card coordinates put the label a padding's width off.
    if (!hoverRect) {
      hoverRect = svg.getBoundingClientRect();
      cardRect = (tip.offsetParent || host).getBoundingClientRect();
    }
    const r = hoverRect;
    if (!r.width) return;
    const frac = Math.max(0, Math.min(1, (hoverX - r.left) / r.width));
    const i = Math.round(frac * (growth.length - 1));
    const [x, y] = xy[i];
    cursor.setAttribute('x1', x); cursor.setAttribute('x2', x);
    dot.setAttribute('cx', x);    dot.setAttribute('cy', y);

    const g = growth[i];
    tip.textContent = `${fmtInt(g.length)} chars${g.time ? ` · ${fmtDate(g.time)}` : ''}`;
    // The label is centred on the point and must stay inside the card. Left to
    // itself it hung off the right-hand end near the end of the chart, which
    // widened the panel's scrollable area — the whole side panel shifted
    // sideways as the pointer approached the last few days.
    tip.style.left = `${tipLeft(tip, (x / W) * r.width + (r.left - cardRect.left), cardRect.width)}px`;
    tip.style.top  = `${(y / H) * r.height}px`;
    tip.classList.add('is-on');
  };

  host.addEventListener('pointermove', (e) => {
    hoverX = e.clientX;
    hovering = true;
    if (hoverQueued) return;
    hoverQueued = true;
    requestAnimationFrame(paintHover);
  }, { passive: true, signal });

  // A frame already queued when the pointer leaves would put the label back up
  // and leave it there — hence the flag rather than only the class.
  host.addEventListener('pointerleave', () => {
    hovering = false;
    tip.classList.remove('is-on');
  }, { signal });
}

function pathLength(pts) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) {
    d += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  }
  return d;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Edits by day and hour.
 *
 * Days run down the side as labelled rows and hours across the top. The panel
 * is narrow, so days-as-columns left every date unlabelled and unreadable —
 * as rows there is room to name each one, and reading a day's pattern becomes
 * a left-to-right scan instead of a vertical hunt.
 */
function renderHeatmap(heat) {
  const host = $('heatmap');
  if (!heat || !heat.length) {
    host.innerHTML = `<div class="v-empty">No timestamped activity.</div>`;
    return;
  }

  const days = [...new Set(heat.map((h) => h.date))].sort();
  const shown = days.slice(-14);                 // a fortnight fits comfortably
  const hidden = days.length - shown.length;
  const byKey = new Map(heat.map((h) => [`${h.date}|${h.hour}`, h.count]));
  const max = Math.max(...heat.map((h) => h.count), 1);

  const LEFT = 46, TOP = 16, CELL = 11, GAP = 2.5, ROW = CELL + GAP;
  const GRID = LEFT + 24 * (CELL + GAP);       // where the last cell ends
  const RIGHT = 26;                            // gutter for the per-day totals
  const W = GRID + RIGHT;
  const H = TOP + shown.length * ROW + 4;

  // Hour ruler across the top.
  let hourLabels = '';
  for (let hr = 0; hr <= 24; hr += 6) {
    const x = LEFT + hr * (CELL + GAP);
    const label = hr === 24 ? '24' : String(hr).padStart(2, '0');
    hourLabels += `<text x="${x}" y="${TOP - 5}" font-size="8" fill="var(--ink-3)"
      text-anchor="${hr === 0 ? 'start' : hr === 24 ? 'end' : 'middle'}">${label}</text>`;
    if (x <= GRID) {
      hourLabels += `<line x1="${x}" y1="${TOP - 2}" x2="${x}" y2="${H - 4}"
        stroke="var(--hairline-dim)" stroke-width="0.6" opacity="0.5"/>`;
    }
  }

  let rows = '';
  shown.forEach((d, r) => {
    const y = TOP + r * ROW;
    const date = new Date(`${d}T00:00:00`);
    const wd = WEEKDAYS[date.getDay()];
    const dayTotal = Array.from({ length: 24 }, (_, hr) => byKey.get(`${d}|${hr}`) || 0)
      .reduce((a, b) => a + b, 0);
    const weekend = date.getDay() === 0 || date.getDay() === 6;

    rows += `<text x="${LEFT - 8}" y="${y + CELL - 2}" font-size="8.5"
      fill="var(--ink-${weekend ? '3' : '2'})" text-anchor="end"
      font-weight="${weekend ? '400' : '600'}">${wd} ${date.getDate()}</text>`;

    for (let hr = 0; hr < 24; hr++) {
      const n = byKey.get(`${d}|${hr}`) || 0;
      const t = n ? 0.2 + (n / max) * 0.8 : 0;
      const fill = n
        ? `color-mix(in srgb, var(--accent) ${Math.round(t * 100)}%, transparent)`
        : 'var(--hairline-dim)';
      rows += `<rect class="v-heat-cell" x="${LEFT + hr * (CELL + GAP)}" y="${y}"
        width="${CELL}" height="${CELL}" rx="3" fill="${fill}">
        <title>${wd} ${date.getDate()} ${String(hr).padStart(2, '0')}:00 — ${n} edit${n === 1 ? '' : 's'}</title>
      </rect>`;
    }

    // Totals live in the right gutter; drawn at the grid edge they ran back
    // across the last few hours of the day.
    rows += `<text x="${W - 2}" y="${y + CELL - 2}" font-size="7.5"
      fill="var(--ink-3)" text-anchor="end" opacity="0.8">${dayTotal || ''}</text>`;
  });

  host.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img"
         aria-label="Edits by day of week and hour of day">
      ${hourLabels}${rows}
    </svg>
    <div class="v-heat-legend">
      <span>less</span>
      <i style="background:var(--hairline-dim)"></i>
      <i style="background:color-mix(in srgb,var(--accent) 35%,transparent)"></i>
      <i style="background:color-mix(in srgb,var(--accent) 65%,transparent)"></i>
      <i style="background:var(--accent)"></i>
      <span>more</span>
      <span class="v-heat-note">${
        hidden > 0 ? `latest 14 days · ${fmtInt(hidden)} earlier not shown` : 'hour of day →'
      }</span>
    </div>`;
}

function renderPeople(a) {
  const host = $('people-list');
  if (!a.contributors.length) {
    host.innerHTML = `<div class="v-empty">No contributors recorded.</div>`;
    return;
  }

  // Note the limitation once, quietly, and move on. These are real people who
  // wrote real parts of the document; Google just did not hand over their
  // names, so they are numbered rather than labelled as a failure.
  const unnamed = a.contributors.filter((c) => !c.identified).length;
  const notice = a.collapsedRoster
    ? `<div class="v-note">This document's history does not separate its authors,
         so all edits are shown together. Totals and timings are still exact.</div>`
    : unnamed
      ? `<div class="v-note">Google did not include ${
          unnamed === a.contributors.length ? 'author names' : `names for ${unnamed} of these authors`
        }, so they are numbered in the order they first edited.</div>`
      : '';

  host.innerHTML = notice + a.contributors.map((c) => {
    const typedPct = c.inserted ? (c.typedChars / c.inserted) * 100 : 0;
    const pastePct = 100 - typedPct;
    return `
      <div class="v-person" style="--c:${esc(c.color)}">
        <div class="v-person-head">
          <div class="v-avatar">${esc(initials(c.name))}</div>
          <div class="v-person-id">
            <div class="v-person-name">${esc(c.name)}</div>
            ${c.email ? `<a class="v-person-mail" href="mailto:${esc(c.email)}"
               title="${esc(c.email)}">${esc(c.email)}</a>` : ''}
            <div class="v-person-when">${esc(rangeLabel(c.first, c.last))}</div>
          </div>
          <div class="v-person-share">${Math.round(c.share * 100)}%</div>
        </div>
        <div class="v-person-grid">
          <div class="v-stat"><b>${fmtInt(c.inserted)}</b><span>INSERTED</span></div>
          <div class="v-stat"><b>${fmtInt(c.deleted)}</b><span>DELETED</span></div>
          <div class="v-stat"><b>${esc(fmtMins(c.activeMinutes))}</b><span>ACTIVE</span></div>
          <div class="v-stat"><b>${c.wpm != null ? fmtInt(c.wpm) : '—'}</b><span>WPM</span></div>
        </div>
        <div class="v-mix">
          <i style="width:${typedPct.toFixed(1)}%;background:${esc(c.color)}"></i>
          <i class="v-mix-pasted" style="width:${pastePct.toFixed(1)}%;--c:${esc(c.color)};animation-delay:.1s"></i>
        </div>
        <div class="v-mix-key">
          <span><i style="background:${esc(c.color)}"></i>typed ${Math.round(typedPct)}%</span>
          <span><i class="v-mix-pasted" style="--c:${esc(c.color)}"></i>pasted ${Math.round(pastePct)}%</span>
        </div>
      </div>`;
  }).join('');
}

/** Share of the text still in the document, by who put it there. */
function renderProvenance(a) {
  const bar = $('provenance-bar');
  const key = $('provenance-legend');
  const prov = a.provenance || [];
  const total = prov.reduce((s, p) => s + p.total, 0);

  if (!total) {
    bar.innerHTML = '';
    key.innerHTML = `<span>No surviving text to attribute.</span>`;
    return;
  }

  const nameOf = (uid) =>
    (a.contributors.find((c) => c.id === uid) || {}).name || 'Unknown';
  const colorOf = (uid) =>
    (a.contributors.find((c) => c.id === uid) || {}).color || 'var(--ink-3)';

  bar.innerHTML = prov.map((p, i) => `
    <i style="width:${((p.total / total) * 100).toFixed(2)}%;background:${esc(colorOf(p.userId))};animation-delay:${i * 80}ms"
       title="${esc(nameOf(p.userId))}: ${fmtInt(p.total)} chars (${fmtInt(p.typed)} typed, ${fmtInt(p.paste + p.bulk)} pasted)"></i>
  `).join('');

  key.innerHTML = prov.map((p) => `
    <span><i style="background:${esc(colorOf(p.userId))}"></i>${esc(nameOf(p.userId))}
      ${Math.round((p.total / total) * 100)}%</span>
  `).join('');
}

function renderSessions(a) {
  const host = $('sessions');
  if (!a.sessions.length) {
    host.innerHTML = `<div class="v-empty">No sessions recorded.</div>`;
    return;
  }

  const byId = new Map(a.contributors.map((c) => [c.id, c]));
  const ordered = [...a.sessions].sort((x, y) => (y.start || 0) - (x.start || 0));

  const who = (id) => byId.get(id) || { name: 'Unknown', color: 'var(--ink-3)' };

  host.innerHTML = ordered.slice(0, 120).map((s) => {
    // A session can hold several people writing in the same stretch of time,
    // so every one of them is named, largest contributor first.
    const seats = (s.authors && s.authors.length)
      ? s.authors
      : [{ userId: s.userId }];
    const c = who(seats[0].userId);
    const churn = s.inserted + s.deleted || 1;
    const mins = s.start && s.end ? Math.max(1, Math.round((s.end - s.start) / 60000)) : 0;
    return `
      <div class="v-session" style="--c:${esc(c.color)}"
           data-step="${s.firstStep}" data-last="${s.lastStep}"
           data-users="${esc(seats.map((a) => a.userId).join(','))}"
           role="button" tabindex="0" title="Open this edit on its own">
        <div class="v-session-rail"></div>
        <div class="v-session-body">
          <div class="v-session-top">
            <span class="v-session-who">${seats.map((a) => {
              const p = who(a.userId);
              return `<span class="v-session-name"><i style="background:${
                esc(p.color)}"></i>${esc(firstName(p.name))}</span>`;
            }).join('')}</span>
            ${s.pastes ? `<span class="v-badge v-badge-paste">${s.pastes} paste${s.pastes === 1 ? '' : 's'}</span>` : ''}
            <span class="v-session-when">${esc(fmtDate(s.start))}</span>
          </div>
          <div class="v-session-meta">
            <b>+${fmtInt(s.inserted)}</b> / <b>−${fmtInt(s.deleted)}</b> chars ·
            <b>${fmtInt(s.mutations)}</b> edits${mins ? ` · ${fmtMins(mins)}` : ''}
          </div>
          <div class="v-session-bar">
            <i style="width:${((s.inserted / churn) * 100).toFixed(1)}%;background:${esc(c.color)}"></i>
            <i style="width:${((s.deleted / churn) * 100).toFixed(1)}%;background:var(--hot)"></i>
          </div>
        </div>
      </div>`;
  }).join('');

  $$('.v-session').forEach((el) => {
    el.addEventListener('click', () => openEdit({
      from: +el.dataset.step,
      to: +el.dataset.last,
      userIds: (el.dataset.users || '').split(',').filter(Boolean)
    }));
  });
}

// Sort mode per evidence list, remembered while the panel is open.
const evidenceSort = { pastes: 'recent', deletions: 'recent' };

/**
 * Order an evidence list. "Person" groups by author — largest contributor
 * first, then that person's biggest items — so one author's pastes read
 * together rather than being interleaved by time.
 */
function sortEvidence(items, mode, byId) {
  const list = [...items];
  if (mode === 'size') {
    return list.sort((x, y) => y.length - x.length || (y.time || 0) - (x.time || 0));
  }
  if (mode === 'person') {
    const rank = new Map([...byId.values()]
      .sort((x, y) => y.inserted - x.inserted)
      .map((c, i) => [c.id, i]));
    return list.sort((x, y) =>
      (rank.get(x.userId) ?? 99) - (rank.get(y.userId) ?? 99) ||
      y.length - x.length);
  }
  return list.sort((x, y) => (y.time || 0) - (x.time || 0) || y.length - x.length);
}

function renderEvidence(a) {
  const byId = new Map(a.contributors.map((c) => [c.id, c]));

  const ORIGIN = {
    'external':      { label: 'external paste', cls: 'is-external' },
    'internal-copy': { label: 'internal paste', cls: 'is-internal' },
    'internal-move': { label: 'internal paste', cls: 'is-internal' }
  };

  const entry = (e, kindLabel) => {
    const c = byId.get(e.userId) || { name: 'Unknown', color: 'var(--ink-3)' };
    const o = e.origin && ORIGIN[e.origin];
    return `
      <div class="v-eventry" style="--c:${esc(c.color)}">
        <div class="v-eventry-head">
          <span class="v-eventry-who">${esc(firstName(c.name))}</span>
          ${o ? `<span class="v-origin ${o.cls}">${esc(o.label)}</span>` : ''}
          <span>${esc(fmtDate(e.time))}</span>
          <span class="v-eventry-size">${fmtInt(e.length)} chars</span>
        </div>
        <div class="v-eventry-text" title="Click to expand">${esc(e.text) || '<em>(empty)</em>'}</div>
      </div>`;
  };

  const pastes = a.pastes.filter((p) => p.kind === 'paste');
  $('pastes-list').innerHTML = pastes.length
    ? sortEvidence(pastes, evidenceSort.pastes, byId).slice(0, 100)
        .map((p) => entry(p, 'paste')).join('')
    : `<div class="v-empty">No bulk pastes.</div>`;

  $('deletions-list').innerHTML = a.deletions.length
    ? sortEvidence(a.deletions, evidenceSort.deletions, byId).slice(0, 100)
        .map((d) => entry(d, 'deletion')).join('')
    : `<div class="v-empty">Nothing substantial was deleted.</div>`;

  $('paste-sorts').classList.toggle('hidden', !pastes.length);
  $('deletion-sorts').classList.toggle('hidden', !a.deletions.length);

  $$('.v-eventry-text').forEach((el) => {
    el.addEventListener('click', () => el.classList.toggle('is-open'));
  });
}

/** Sort buttons re-render only the evidence lists, keeping the tab in place. */
function wireSorts(hostId, key) {
  const host = $(hostId);
  if (!host) return;
  host.addEventListener('click', (e) => {
    const btn = e.target.closest('.v-sort');
    if (!btn || !current) return;
    evidenceSort[key] = btn.dataset.sort;
    [...host.children].forEach((b) => b.classList.toggle('is-active', b === btn));
    renderEvidence(current);
  });
}
wireSorts('paste-sorts', 'pastes');
wireSorts('deletion-sorts', 'deletions');

function renderSignal(a) {
  const b = a.behavior || {};
  const share = b.externalShare || 0;

  // The gauge shows a measured proportion, not a rating. There is no scoring
  // model behind it: it is the share of inserted characters that arrived from
  // outside the document, counted directly.
  const R = 40, C = 2 * Math.PI * R;
  const frac = Math.max(0, Math.min(1, share));
  const tone = !b.enough ? 'var(--ink-3)'
             : share >= 0.5 ? 'var(--hot)'
             : share > 0 ? 'var(--warm)'
             : 'var(--good)';

  $('gauge').innerHTML = `
    <svg width="92" height="92" viewBox="0 0 92 92" role="img"
         aria-label="${b.enough ? `${Math.round(share * 100)} percent pasted from outside` : 'Not enough history'}">
      <circle cx="46" cy="46" r="${R}" fill="none"
              stroke="var(--hairline-dim)" stroke-width="7"/>
      <circle class="v-gauge-arc" cx="46" cy="46" r="${R}" fill="none"
              stroke="${tone}" stroke-width="7" stroke-linecap="round"
              transform="rotate(-90 46 46)"
              style="--circ:${C.toFixed(1)};stroke-dasharray:${(C * frac).toFixed(1)} ${C.toFixed(1)}"/>
    </svg>
    <div class="v-gauge-num" style="color:${tone};font-size:${b.enough ? '20px' : '23px'}">${
      b.enough ? `${Math.round(share * 100)}%` : '—'
    }</div>`;

  $('gauge-verdict').style.color = tone;
  if (!b.enough) {
    $('gauge-verdict').textContent = 'Not enough history';
    $('gauge-blurb').textContent =
      `Fewer than ${fmtInt(b.minEdits || 20)} recorded edits`;
  } else {
    $('gauge-verdict').textContent = 'External Pastes';
    $('gauge-blurb').textContent =
      `${fmtInt(b.externalChars || 0)} of ${fmtInt(b.totalChars || 0)} total characters were ` +
      `pasted into this document from an external source. The rest was created in the document.`;
  }

  renderPasteOrigin(a);

  // Observations are measurements shown alongside, not inputs to a score.
  $('signal-list').innerHTML = (b.observations || []).map((o) => `
    <div class="v-signal">
      <span class="v-signal-pip v-signal-flat"></span>
      <div class="v-signal-main">
        <div class="v-signal-label">${esc(o.label)}</div>
        <div class="v-signal-detail">${esc(o.detail)}</div>
      </div>
      ${o.measure ? `<span class="v-signal-measure">${esc(o.measure)}</span>` : ''}
    </div>`).join('') || `<div class="v-empty">Nothing measured yet.</div>`;
}

/**
 * How the text arrived: typed, copied from elsewhere in this document, or
 * pasted in from outside. Measured over every character ever inserted, so the
 * three shares answer the question people actually ask.
 */
function renderPasteOrigin(a) {
  const t = a.totals || {};
  const external = t.externalPastedChars || 0;
  const internal = t.internalPastedChars || 0;
  const typed    = Math.max(0, (t.inserted || 0) - external - internal);

  const parts = [
    { label: 'Typed keystroke by keystroke', color: 'var(--good)', value: typed,
      note: `${fmtInt(typed)} characters` },
    { label: 'Internal pastes', color: 'var(--accent)', value: internal,
      note: `${fmtInt(internal)} characters in ${fmtInt(t.internalPastes || 0)} paste${(t.internalPastes || 0) === 1 ? '' : 's'}` },
    { label: 'External pastes', color: 'var(--hot)', value: external,
      note: `${fmtInt(external)} characters in ${fmtInt(t.externalPastes || 0)} paste${(t.externalPastes || 0) === 1 ? '' : 's'}` }
  ];

  const total = parts.reduce((n, p) => n + p.value, 0);
  if (!total) {
    $('origin-chart').innerHTML = '';
    $('origin-legend').innerHTML = `<div class="v-empty">No text recorded yet.</div>`;
    return;
  }

  const extFrac = external / total;
  drawDonut($('origin-chart'), $('origin-legend'), parts, {
    centerValue: pctOf(extFrac),
    centerLabel: 'external',
    ariaLabel: 'How the text arrived',
    centerColor: external ? 'var(--hot)' : 'var(--good)'
  });
}

/**
 * Shared donut, drawn as stroked arcs rather than filled wedges: a rounded cap
 * and a real gap between segments reads far better at this size than three
 * hard-edged pie slices meeting at a point.
 *
 * Segments below a whisker of the total are dropped from the ring — they would
 * render as a sliver or, with rounded caps, as a misleading dot — but they stay
 * in the legend with their true share.
 */
function drawDonut(chartHost, legendHost, parts, opts = {}) {
  const total = parts.reduce((n, p) => n + p.value, 0) || 1;
  const drawn = parts.filter((p) => p.value / total >= 0.015);

  const SIZE = 128, R = 48, THICK = 15;
  const c = SIZE / 2;
  const circ = 2 * Math.PI * R;
  const GAP = drawn.length > 1 ? 3.5 : 0;   // degrees of breathing room

  let offset = 0;
  const arcs = drawn.map((p, i) => {
    const share = p.value / total;
    const len = Math.max(0, share * circ - (GAP / 360) * circ);
    const arc = `
      <circle class="v-donut-arc" cx="${c}" cy="${c}" r="${R}"
              fill="none" stroke="${p.color}" stroke-width="${THICK}"
              stroke-linecap="${drawn.length > 1 ? 'round' : 'butt'}"
              stroke-dasharray="${len.toFixed(2)} ${(circ - len).toFixed(2)}"
              stroke-dashoffset="${(-offset).toFixed(2)}"
              style="--len:${len.toFixed(2)};--circ:${circ.toFixed(2)};animation-delay:${i * 110}ms">
        <title>${esc(p.label)}: ${pctOf(share)}</title>
      </circle>`;
    offset += share * circ;
    return arc;
  }).join('');

  chartHost.innerHTML = `
    <svg viewBox="0 0 ${SIZE} ${SIZE}" role="img"
         aria-label="${esc(opts.ariaLabel || 'Breakdown')}">
      <circle cx="${c}" cy="${c}" r="${R}" fill="none"
              stroke="var(--hairline-dim)" stroke-width="${THICK}" opacity="0.5"/>
      <g transform="rotate(-90 ${c} ${c})">${arcs}</g>
    </svg>
    <div class="v-pie-center">
      <b style="color:${opts.centerColor || 'inherit'}">${esc(opts.centerValue || '')}</b>
      <span>${esc(opts.centerLabel || '')}</span>
    </div>`;

  legendHost.innerHTML = parts.map((p, i) => {
    const share = p.value / total;
    return `
      <div class="v-legend-row${p.value ? '' : ' is-zero'}">
        <span class="v-legend-key">
          <i style="background:${p.color}"></i>
          <span class="v-legend-name">${esc(p.label)}</span>
          <b class="v-legend-pct">${pctOf(share)}</b>
        </span>
        <span class="v-legend-bar">
          <i style="width:${(share * 100).toFixed(1)}%;background:${p.color};animation-delay:${i * 90}ms"></i>
        </span>
        <span class="v-legend-note">${esc(p.note || '')}</span>
      </div>`;
  }).join('');
}

// ── Document-tab scope ───────────────────────────────────────────────────────

let tabState = null;
let scopeOpen = false;
let scopeActive = 0;     // which row the keyboard is on

/** "All tabs" always leads; the document's own tabs follow in document order. */
/**
 * 'Current tab' leads and is the default: it follows whichever tab is open in
 * Docs, and the bottom bar and this panel move together as you switch.
 */
function scopeOptions() {
  const tabs = (tabState && tabState.tabs) || [];
  const cur = tabs.find((t) => t.id === (tabState && tabState.current));
  return [
    { id: 'current', title: 'Current tab', sub: cur ? cur.title : '' },
    { id: '', title: 'All tabs' }
  ].concat(tabs.map((t) => ({ id: t.id, title: t.title })));
}

function scopeSelectedId() {
  if (!tabState) return '';
  if (tabState.pick === 'current') return 'current';
  // `pick` is the user's choice; older replies only carried `selected`.
  return (tabState.pick !== undefined ? tabState.pick : tabState.selected) || '';
}

function renderScope(state) {
  tabState = state || null;
  const bar = $('scope-bar');
  if (!tabState || !tabState.tabs || tabState.tabs.length < 2) {
    closeScope();
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');

  const opts = scopeOptions();
  const sel = scopeSelectedId();
  const chosen = opts.find((o) => o.id === sel) || opts[0];

  $('scope-current').textContent =
    chosen.id === 'current' && chosen.sub ? `Current tab · ${chosen.sub}` : chosen.title;
  // Same rule as the bottom bar's drop-up: eight rows, then another column,
  // then smaller past two columns, so a long tab list stays compact.
  const ROWS = 8;
  const cols = Math.max(1, Math.ceil(opts.length / ROWS));
  const menu = $('scope-menu');
  menu.style.setProperty('--sm-rows', String(Math.min(opts.length, ROWS)));
  menu.style.setProperty('--sm-cols', String(cols));
  menu.style.setProperty('--sm-scale', String(cols <= 2 ? 1 : Math.max(0.6, 1 - (cols - 2) * 0.1)));
  $('scope-menu').innerHTML = opts.map((o, i) => `
    <li id="scope-opt-${i}" class="v-scope-opt${o.id === sel ? ' is-selected' : ''}"
        role="option" aria-selected="${o.id === sel}"
        data-id="${esc(o.id)}" data-i="${i}">
      <svg class="v-scope-tick" width="12" height="12" viewBox="0 0 24 24"
           fill="currentColor" aria-hidden="true">
        <path d="M9.6 16.8 5 12.2l1.4-1.4 3.2 3.2 8-8L19 7.4z"/>
      </svg>
      <span class="v-scope-opt-label">${esc(o.title)}</span>
      ${o.sub ? `<span class="v-scope-opt-sub">${esc(o.sub)}</span>` : ''}
    </li>`).join('');

  $('scope-note').innerHTML = `Showing <strong>${esc(tabState.label)}</strong>.`;
}

function paintScopeActive() {
  const rows = [...$('scope-menu').children];
  rows.forEach((el, i) => el.classList.toggle('is-active', i === scopeActive));
  const row = rows[scopeActive];
  if (!row) return;
  $('scope-menu').setAttribute('aria-activedescendant', row.id);
  row.scrollIntoView({ block: 'nearest' });
}

function openScope() {
  if (scopeOpen) return;
  scopeOpen = true;
  const menu = $('scope-menu');
  menu.classList.remove('hidden');
  requestAnimationFrame(() => menu.classList.add('is-open'));
  $('scope-button').setAttribute('aria-expanded', 'true');

  const rows = [...menu.children];
  scopeActive = Math.max(0, rows.findIndex((el) => el.classList.contains('is-selected')));
  paintScopeActive();
  menu.focus();
}

function closeScope(refocus) {
  if (!scopeOpen) return;
  scopeOpen = false;
  const menu = $('scope-menu');
  menu.classList.remove('is-open');
  menu.removeAttribute('aria-activedescendant');
  $('scope-button').setAttribute('aria-expanded', 'false');
  // Kept in the tree until the collapse finishes, then taken out of it.
  setTimeout(() => { if (!scopeOpen) menu.classList.add('hidden'); }, 190);
  if (refocus) $('scope-button').focus();
}

async function chooseScope(id) {
  closeScope(true);
  if (id === scopeSelectedId()) return;

  const res = await ask('VISOR_SET_TAB', { tabId: id || null });
  if (!res || !res.ok) return;
  current = res.analysis;
  render(current);
  renderScope(res.tabState);
}

$('scope-button').addEventListener('click', () => (scopeOpen ? closeScope() : openScope()));

$('scope-button').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    openScope();
  }
});

$('scope-menu').addEventListener('click', (e) => {
  const row = e.target.closest('.v-scope-opt');
  if (row) chooseScope(row.dataset.id);
});

$('scope-menu').addEventListener('keydown', (e) => {
  const rows = [...$('scope-menu').children];
  if (!rows.length) return;

  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const step = e.key === 'ArrowDown' ? 1 : -1;
    scopeActive = (scopeActive + step + rows.length) % rows.length;
    paintScopeActive();
  } else if (e.key === 'Home' || e.key === 'End') {
    e.preventDefault();
    scopeActive = e.key === 'Home' ? 0 : rows.length - 1;
    paintScopeActive();
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    if (rows[scopeActive]) chooseScope(rows[scopeActive].dataset.id);
  } else if (e.key === 'Escape' || e.key === 'Tab') {
    if (e.key === 'Escape') e.preventDefault();
    closeScope(e.key === 'Escape');
  }
});

// Anywhere else on the page dismisses it, the way a native menu behaves.
document.addEventListener('pointerdown', (e) => {
  if (scopeOpen && !e.target.closest('.v-scope-picker')) closeScope();
});

// The in-document bar can change the selection too; keep the panel in step.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg) return;
  // Every Docs tab broadcasts; this panel belongs to one of them.
  if (sender && sender.tab && sender.tab.id !== tabId) return;
  // VISOR_DATA_REFRESHED: the bar has just re-read the document on its own
  // schedule, so this asks for the analysis it already has rather than making
  // the page do the whole read a second time.
  if (msg.type === 'VISOR_TAB_SYNC' || msg.type === 'VISOR_DATA_REFRESHED') quietRefresh(false);
});

/* ── Keeping current ───────────────────────────────────────────────────────
 *
 * The panel re-reads the document every five minutes, without the loading
 * screen: that would throw away where the reader was. What is on screen is put
 * back afterwards — the tab they are reading, the sub-tab inside it, how far
 * down each one is scrolled — so a refresh shows new figures and moves nothing
 * else. A replay runs in the document's own window and is not touched at all.
 */
const PANEL_REFRESH_MS = 5 * 60 * 1000;
let refreshing = false;

function viewState() {
  return {
    scroll: $$('.v-panel').map((p) => p.scrollTop),
    ev: document.querySelector('.v-seg-btn.is-active')?.dataset.ev || null,
    // Which evidence entries the reader had opened out, by position.
    open: $$('.v-eventry-text').map((el, i) => (el.classList.contains('is-open') ? i : -1)).filter((i) => i >= 0),
    sheet: $('stats-sheet')?.classList.contains('is-open') || false
  };
}

function restoreView(v) {
  if (v.ev) {
    $$('.v-seg-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.ev === v.ev));
    $$('.v-ev').forEach((p) => p.classList.toggle('is-active', p.id === `ev-${v.ev}`));
  }
  const texts = $$('.v-eventry-text');
  v.open.forEach((i) => texts[i] && texts[i].classList.add('is-open'));
  $$('.v-panel').forEach((p, i) => { if (v.scroll[i]) p.scrollTop = v.scroll[i]; });
  // The sheet reads from `current`, which has just been replaced underneath it.
  if (v.sheet) renderStats();
}

async function quietRefresh(force) {
  // Only while figures are actually on screen: during loading, an error or a
  // view-only document there is nothing to refresh into.
  if (refreshing || !current || !$('main') || $('main').classList.contains('hidden')) return;
  refreshing = true;
  try {
    const res = await ask('VISOR_ANALYZE', { force });
    if (!res || res.state !== 'ready') return;   // 'running' included: try later
    const keep = viewState();
    current = res.analysis;
    meta = res.meta || meta;
    // Nothing should announce itself: without this every chart redraws its
    // entrance animation, and a document being edited would have the whole
    // panel flickering through its introductions every few seconds.
    document.body.classList.add('is-quiet');
    render(current);
    renderScope(res.tabState);
    restoreView(keep);
    requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove('is-quiet')));
  } catch (_) {
    /* leave the figures that are up */
  } finally {
    refreshing = false;
  }
}

setInterval(() => {
  if (document.visibilityState === 'visible') quietRefresh(true);
}, PANEL_REFRESH_MS);

// ── Theme ────────────────────────────────────────────────────────────────────

function syncThemeIcon() {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  // Show the destination, not the current state: a moon means "go dark".
  document.querySelector('.v-icon-sun').classList.toggle('hidden', !dark);
  document.querySelector('.v-icon-moon').classList.toggle('hidden', dark);
}

$('btn-theme').addEventListener('click', () => {
  visorToggleTheme();
  syncThemeIcon();
  ask('VISOR_SET_THEME', { theme: document.documentElement.getAttribute('data-theme') });
});

visorInitTheme().then(syncThemeIcon);

// ── Interaction ──────────────────────────────────────────────────────────────

function moveGlider(btn) {
  const glider = $('tab-glider');
  const bar = btn.parentElement.getBoundingClientRect();
  const r = btn.getBoundingClientRect();
  glider.style.width = `${r.width}px`;
  glider.style.transform = `translateX(${r.left - bar.left}px)`;
}

$$('.v-tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.v-tab').forEach((b) => {
      b.classList.toggle('is-active', b === btn);
      b.setAttribute('aria-selected', String(b === btn));
    });
    $$('.v-panel').forEach((p) => {
      p.classList.toggle('is-active', p.id === `panel-${btn.dataset.tab}`);
    });
    moveGlider(btn);
  });
});

$$('.v-seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.v-seg-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
    $$('.v-ev').forEach((p) => p.classList.toggle('is-active', p.id === `ev-${btn.dataset.ev}`));
  });
});

$('btn-refresh').addEventListener('click', async (e) => {
  // Hold the element, not the event. currentTarget is only set while the event
  // is being dispatched; after the await it is null, so removing the class
  // threw inside this async handler and the icon spun forever. finally makes
  // sure it stops even if the analysis itself fails.
  const btn = e.currentTarget;
  if (btn.classList.contains('is-spinning')) return;
  btn.classList.add('is-spinning');
  try {
    await analyze(true);
  } finally {
    btn.classList.remove('is-spinning');
  }
});

$('btn-retry').addEventListener('click', () => boot());

// The store is the only place a rating can actually be left: Chrome exposes no
// API for collecting one in-extension, and gating who gets sent here on a
// rating captured first is against Web Store policy.
$('btn-rate').addEventListener('click', () => {
  chrome.tabs.create({
    url: 'https://chromewebstore.google.com/detail/visor-%E2%80%93-google-docs-revis/mienldgcindjfiinlbmjibgmemnapkog/reviews'
  });
});
$('btn-replay').addEventListener('click', () => ask('VISOR_OPEN_REPLAY'));

// ── Formatting ───────────────────────────────────────────────────────────────

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const fmtInt = (n) => Number(n || 0).toLocaleString();
const firstName = (n) => String(n || 'Unknown').split(' ')[0];

function initials(name) {
  return String(name || 'U').split(/\s+/).map((w) => w[0] || '')
    .join('').slice(0, 2).toUpperCase();
}

function fmtMins(m) {
  if (!m) return '<1m';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}

function fmtDate(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    year: sameYear ? undefined : 'numeric',
    hour: 'numeric', minute: '2-digit'
  });
}

function rangeLabel(first, last) {
  if (!first) return '—';
  const a = new Date(first).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const b = new Date(last).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return a === b ? a : `${a} → ${b}`;
}

// ── Expanded activity statistics ─────────────────────────────────────────────

let grain = 'day';
let pieMetric = 'inserted';

function openStats() {
  if (!current) return;
  $('stats-sheet').classList.remove('hidden');
  requestAnimationFrame(() => $('stats-sheet').classList.add('is-open'));
  renderStats();
}

function closeStats() {
  const sheet = $('stats-sheet');
  sheet.classList.remove('is-open');
  setTimeout(() => sheet.classList.add('hidden'), 320);
}

function renderStats() {
  const a = current;
  const cal = a && a.calendar;
  if (!cal || !cal.days.length) {
    $('sheet-sub').textContent = 'No timestamped activity';
    // Leave nothing of the last document behind: this used to return with the
    // previous document's charts still in place, under the new heading.
    ['sheet-tiles', 'grain-chart', 'pie-chart', 'pie-legend', 'hour-chart', 'weekday-chart', 'day-list']
      .forEach((id) => { const el = $(id); if (el) el.innerHTML = ''; });
    return;
  }

  $('sheet-sub').textContent =
    `${fmtInt(cal.activeDays)} active day${cal.activeDays === 1 ? '' : 's'}` +
    (cal.span ? ` · ${shortDate(cal.span.first)} → ${shortDate(cal.span.last)}` : '');

  renderSheetTiles(a, cal);
  renderGrainChart(cal);
  renderPie(a);
  renderHourChart(cal);
  renderWeekdayChart(cal);
  renderDayList(a, cal);
}

function renderSheetTiles(a, cal) {
  const busiest = cal.busiestDay;
  const peakHour = cal.byHour.indexOf(Math.max(...cal.byHour));
  const longest = [...(a.sessions || [])].sort(
    (x, y) => ((y.end - y.start) || 0) - ((x.end - x.start) || 0)
  )[0];
  const longestMins = longest ? Math.max(1, Math.round((longest.end - longest.start) / 60000)) : 0;
  const perDay = cal.activeDays ? Math.round(a.totals.mutations / cal.activeDays) : 0;

  const tiles = [
    { v: fmtInt(cal.activeDays),                l: 'days worked on' },
    { v: fmtInt(perDay),                        l: 'edits per active day' },
    { v: busiest ? shortDate(busiest.date) : '—', l: `busiest day · ${fmtInt(busiest ? busiest.count : 0)} edits` },
    { v: `${pad2(peakHour)}:00`,                l: 'most common hour' },
    { v: fmtMins(longestMins),                  l: 'longest single session' },
    { v: fmtInt(cal.longestGapDays),            l: 'longest gap (days)' }
  ];

  $('sheet-tiles').innerHTML = tiles.map((t) => `
    <div class="v-metric">
      <div class="v-metric-value">${esc(t.v)}</div>
      <div class="v-metric-label">${esc(t.l)}</div>
    </div>`).join('');
}

/** Re-bin the per-day data to whatever grouping is selected. */
function binDays(days, by) {
  if (by === 'hour') {
    const out = new Array(24).fill(0).map((_, h) => ({ key: `${pad2(h)}:00`, count: 0 }));
    for (const d of days) for (let h = 0; h < 24; h++) out[h].count += d.hours[h];
    return out;
  }

  const keyFor = {
    day:   (d) => d.date,
    week:  (d) => isoWeek(d.date),
    month: (d) => d.date.slice(0, 7),
    year:  (d) => d.date.slice(0, 4)
  }[by] || ((d) => d.date);

  const map = new Map();
  for (const d of days) {
    const key = keyFor(d);
    const cur = map.get(key) || { key, count: 0, inserted: 0, deleted: 0, days: 0 };
    cur.count += d.count;
    cur.inserted += d.inserted;
    cur.deleted += d.deleted;
    cur.days += 1;
    map.set(key, cur);
  }
  return [...map.values()];
}

function renderGrainChart(cal) {
  const bins = binDays(cal.days, grain);
  const label = {
    hour: (b) => b.key,
    day: (b) => shortDate(b.key),
    week: (b) => b.key.replace(/^\d{4}-W?/, 'W'),   // 2026-W29 -> W29
    month: (b) => monthName(b.key),
    year: (b) => b.key
  }[grain];

  $('grain-chart').innerHTML = barChart(bins, label, {
    valueLabel: (b) => `${fmtInt(b.count)} edit${b.count === 1 ? '' : 's'}` +
      (b.days ? ` over ${fmtInt(b.days)} day${b.days === 1 ? '' : 's'}` : '')
  });
}

function renderHourChart(cal) {
  const bins = cal.byHour.map((count, h) => ({ key: pad2(h), count }));
  $('hour-chart').innerHTML = barChart(bins, (b) => b.key, {
    dense: true,
    valueLabel: (b) => `${b.key}:00 — ${fmtInt(b.count)} edits`
  });
}

function renderWeekdayChart(cal) {
  const bins = cal.byWeekday.map((count, i) => ({ key: WEEKDAYS[i], count }));
  $('weekday-chart').innerHTML = barChart(bins, (b) => b.key, {
    valueLabel: (b) => `${b.key} — ${fmtInt(b.count)} edits`
  });
}

/** Horizontal bars: readable in a narrow panel where vertical bars are not. */
function barChart(bins, label, opts = {}) {
  if (!bins.length) return `<div class="v-empty">Nothing to show.</div>`;
  const max = Math.max(...bins.map((b) => b.count), 1);

  return `<div class="v-bars-inner${opts.dense ? ' is-dense' : ''}">` + bins.map((b, i) => `
    <div class="v-bar-row" title="${esc(opts.valueLabel ? opts.valueLabel(b) : b.count)}">
      <span class="v-bar-key">${esc(label(b))}</span>
      <span class="v-bar-track">
        <i style="width:${((b.count / max) * 100).toFixed(1)}%;animation-delay:${Math.min(i * 12, 400)}ms"></i>
      </span>
      <span class="v-bar-val">${fmtInt(b.count)}</span>
    </div>`).join('') + '</div>';
}

/** Donut of contributor share, by whichever measure is selected. */
function renderPie(a) {
  const contribs = (a.contributors || []).filter((c) => (c[pieMetric] || 0) > 0);
  if (!contribs.length) {
    $('pie-chart').innerHTML = '';
    $('pie-legend').innerHTML = `<div class="v-empty">No contributions to compare.</div>`;
    return;
  }

  const total = contribs.reduce((s, c) => s + (c[pieMetric] || 0), 0) || 1;
  const unit = { inserted: 'characters', mutations: 'edits', activeMinutes: 'min' }[pieMetric];

  const parts = contribs.map((c) => ({
    label: c.name,
    color: c.color,
    value: c[pieMetric] || 0,
    note: pieMetric === 'activeMinutes' ? fmtMins(c.activeMinutes) : `${fmtInt(c[pieMetric])} ${unit}`
  }));

  const top = contribs[0];
  drawDonut($('pie-chart'), $('pie-legend'), parts, {
    centerValue: pctOf((top[pieMetric] || 0) / total),
    centerLabel: firstName(top.name),
    ariaLabel: 'Share of contribution by author'
  });
}

/** One row per writing day, each with that day's own 24-hour profile. */
function renderDayList(a, cal) {
  const byId = new Map((a.contributors || []).map((c) => [c.id, c]));
  const days = [...cal.days].reverse();      // newest first
  $('daylist-count').textContent = `${fmtInt(days.length)} day${days.length === 1 ? '' : 's'}`;

  $('day-list').innerHTML = days.map((d) => {
    const max = Math.max(...d.hours, 1);
    const bars = d.hours.map((n, h) => {
      const pct = n ? Math.max(8, (n / max) * 100) : 0;
      return `<i style="height:${pct.toFixed(1)}%" title="${pad2(h)}:00 — ${fmtInt(n)} edits"
                 class="${n ? '' : 'is-empty'}"></i>`;
    }).join('');

    const people = Object.entries(d.users)
      .sort((x, y) => y[1] - x[1])
      .map(([uid, n]) => {
        const c = byId.get(uid) || { name: 'Unknown', color: 'var(--ink-3)' };
        return `<span class="v-day-who"><i style="background:${esc(c.color)}"></i>${
          esc(firstName(c.name))} ${fmtInt(n)}</span>`;
      }).join('');

    return `
      <div class="v-day">
        <div class="v-day-head">
          <strong>${esc(longDate(d.date))}</strong>
          <span class="v-day-window">${clock(d.firstEdit)}–${clock(d.lastEdit)}</span>
        </div>
        <div class="v-day-hours" aria-hidden="true">${bars}</div>
        <div class="v-day-axis" aria-hidden="true"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
        <div class="v-day-stats">
          <span><b>${fmtInt(d.count)}</b> edits</span>
          <span><b>+${fmtInt(d.inserted)}</b>/<b>−${fmtInt(d.deleted)}</b></span>
          <span><b>${esc(fmtMins(d.activeMinutes))}</b> active</span>
          ${d.pastes ? `<span class="v-badge v-badge-paste">${fmtInt(d.pastes)} paste${d.pastes === 1 ? '' : 's'}</span>` : ''}
        </div>
        <div class="v-day-people">${people}</div>
      </div>`;
  }).join('');
}

// ── Sheet controls ───────────────────────────────────────────────────────────

$('btn-expand-stats').addEventListener('click', openStats);
$('btn-close-stats').addEventListener('click', closeStats);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('stats-sheet').classList.contains('hidden')) closeStats();
});

$('grain-sorts').addEventListener('click', (e) => {
  const btn = e.target.closest('.v-sort');
  if (!btn) return;
  grain = btn.dataset.grain;
  [...$('grain-sorts').children].forEach((b) => b.classList.toggle('is-active', b === btn));
  renderGrainChart(current.calendar);
});

$('pie-metric').addEventListener('click', (e) => {
  const btn = e.target.closest('.v-sort');
  if (!btn) return;
  pieMetric = btn.dataset.metric;
  [...$('pie-metric').children].forEach((b) => b.classList.toggle('is-active', b === btn));
  renderPie(current);
});

// ── Date helpers ─────────────────────────────────────────────────────────────

const pad2 = (n) => String(n).padStart(2, '0');
const pctOf = (f) => `${(f * 100).toFixed(f < 0.01 ? 1 : 0)}%`;

function shortDate(iso) {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function longDate(iso) {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function monthName(ym) {
  const d = new Date(`${ym}-01T00:00:00`);
  // An apostrophe on the year stops "Jul 26" reading as a day of the month.
  return d.toLocaleDateString(undefined, { month: 'short' }) + ` '${ym.slice(2, 4)}`;
}

function clock(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** ISO week key, e.g. 2026-W32. */
function isoWeek(iso) {
  const d = new Date(`${iso}T00:00:00`);
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${pad2(week)}`;
}

/* ============================================================================
 * A single edit, on its own
 * ==========================================================================*/

let editSteps = [];      // the ops that make up the open session
let editRuns  = [];      // insert runs, in order, with their timings
let editPos   = 0;       // how many runs have been played
let editPlaying = false;
let editTimer = null;
let editSpeed = 6;

async function openEdit({ from, to, userIds }) {
  const res = await ask('VISOR_SESSION_STEPS', { from, to });
  if (!res || !res.steps || !res.steps.length) return;

  editSteps = res.steps;
  const ids = (userIds || []).length ? userIds : [null];
  const people = ids.map((id) =>
    (current.contributors || []).find((c) => c.id === id) ||
    { name: 'Unknown', color: 'var(--ink-3)' });
  const author = people[0];

  const first = editSteps.find((s) => s.t);
  const last  = [...editSteps].reverse().find((s) => s.t);
  const spanMs = first && last ? Math.max(0, last.t - first.t) : 0;

  const added   = editSteps.map((s) => s.ins).join('');
  const removed = editSteps.map((s) => s.del).join('');

  // Each insert becomes a run, carrying the pause that preceded it.
  editRuns = [];
  let prevT = first ? first.t : 0;
  for (const s of editSteps) {
    if (!s.ins) { prevT = s.t || prevT; continue; }
    editRuns.push({
      text: s.ins,
      gap: Math.max(0, (s.t || prevT) - prevT),
      paste: s.big >= 60,
      t: s.t
    });
    prevT = s.t || prevT;
  }

  const names = people.map((p) => firstName(p.name));
  $('edit-title').textContent =
    names.length === 1 ? `${names[0]}'s edit`
    : names.length === 2 ? `${names[0]} & ${names[1]}'s edit`
    : `${names[0]} and ${names.length - 1} others' edit`;
  $('edit-when').textContent = first ? fullTime(first.t) : 'Time not recorded';
  $('edit-sheet').style.setProperty('--c', author.color);

  const pasteCount = editRuns.filter((r) => r.paste).length;
  const typedRuns = editRuns.filter((r) => !r.paste);
  const typedChars = typedRuns.reduce((n, r) => n + r.text.length, 0);
  const cps = spanMs > 0 ? typedChars / (spanMs / 1000) : 0;

  $('edit-tiles').innerHTML = [
    { v: fmtDuration(spanMs),                 l: 'took' },
    { v: `+${fmtInt(added.length)}`,          l: 'characters added' },
    { v: removed.length ? `−${fmtInt(removed.length)}` : '0', l: 'characters removed' },
    { v: fmtInt(editSteps.length),            l: editSteps.length === 1 ? 'operation' : 'operations' },
    { v: fmtInt(pasteCount),                  l: pasteCount === 1 ? 'paste' : 'pastes' },
    { v: cps ? `${cps.toFixed(1)}/s` : '—',   l: 'typing rate' }
  ].map((t) => `
    <div class="v-metric">
      <div class="v-metric-value">${esc(t.v)}</div>
      <div class="v-metric-label">${esc(t.l)}</div>
    </div>`).join('');

  $('edit-added-len').textContent = `${fmtInt(added.length)} chars`;

  $('edit-removed-wrap').classList.toggle('hidden', !removed.length);
  if (removed.length) {
    $('edit-removed-len').textContent = `${fmtInt(removed.length)} chars`;
    $('edit-removed').textContent = removed;
  }

  renderEditOps(author);

  editPos = 0;
  paintEditReplay();
  $('edit-sheet').classList.remove('hidden');
  requestAnimationFrame(() => $('edit-sheet').classList.add('is-open'));
  setTimeout(playEdit, 420);
}

function closeEdit() {
  pauseEdit();
  const sheet = $('edit-sheet');
  sheet.classList.remove('is-open');
  setTimeout(() => sheet.classList.add('hidden'), 320);
}

/** The added text only — nothing from the surrounding document. */
function paintEditReplay() {
  const host = $('edit-replay');
  const shown = editRuns.slice(0, editPos);

  host.innerHTML = shown.map((r, i) => {
    const cls = r.paste ? 'v-er-paste' : '';
    const fresh = i === shown.length - 1 && editPos < editRuns.length ? ' is-fresh' : '';
    return `<span class="${cls}${fresh}">${esc(r.text)}</span>`;
  }).join('') + (editPos < editRuns.length ? '<span class="v-er-caret"></span>' : '');

  const total = editRuns.reduce((n, r) => n + r.text.length, 0) || 1;
  const done  = shown.reduce((n, r) => n + r.text.length, 0);
  $('edit-progress').style.width = `${((done / total) * 100).toFixed(1)}%`;

  host.scrollTop = host.scrollHeight;
}

function playEdit() {
  if (editPlaying || !editRuns.length) return;
  if (editPos >= editRuns.length) editPos = 0;
  editPlaying = true;
  toggleEditIcons();
  stepEdit();
}

function pauseEdit() {
  editPlaying = false;
  clearTimeout(editTimer);
  editTimer = null;
  toggleEditIcons();
}

function stepEdit() {
  if (!editPlaying) return;
  if (editPos >= editRuns.length) { pauseEdit(); paintEditReplay(); return; }

  editPos++;
  paintEditReplay();

  const next = editRuns[editPos];
  if (!next) { pauseEdit(); return; }

  // Real gaps, compressed, and capped so a long pause is not a dead wait.
  const wait = editSpeed === 0 ? 8 : Math.min(900, Math.max(16, next.gap / editSpeed));
  editTimer = setTimeout(stepEdit, wait);
}

function toggleEditIcons() {
  $('edit-play').querySelector('.ic-play').classList.toggle('hidden', editPlaying);
  $('edit-play').querySelector('.ic-pause').classList.toggle('hidden', !editPlaying);
}

function renderEditOps(author) {
  let prev = null;
  $('edit-ops').innerHTML = editSteps.map((s) => {
    const gap = prev && prev.t && s.t ? s.t - prev.t : 0;
    prev = s;
    const kind = s.del && !s.ins ? 'del' : s.big >= 60 ? 'paste' : 'ins';
    const label = kind === 'del' ? `−${fmtInt(s.del.length)}`
                : `+${fmtInt(s.ins.length)}`;
    const text = kind === 'del' ? s.del : s.ins;
    return `
      <div class="v-op v-op-${kind}">
        <span class="v-op-gap">${gap ? `+${fmtGap(gap)}` : '—'}</span>
        <span class="v-op-size">${esc(label)}</span>
        <span class="v-op-text">${esc(text.slice(0, 90)) || '<em>formatting</em>'}</span>
      </div>`;
  }).join('');
}

$('btn-close-edit').addEventListener('click', closeEdit);
$('edit-play').addEventListener('click', () => (editPlaying ? pauseEdit() : playEdit()));
$('edit-speed').addEventListener('click', (e) => {
  const btn = e.target.closest('.v-sort');
  if (!btn) return;
  editSpeed = +btn.dataset.x;
  [...$('edit-speed').children].forEach((b) => b.classList.toggle('is-active', b === btn));
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('edit-sheet').classList.contains('hidden')) closeEdit();
});

function fmtDuration(ms) {
  if (!ms) return '<1s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return r ? `${m}m ${r}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function fmtGap(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60000)}m`;
}

function fullTime(ms) {
  return new Date(ms).toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit'
  });
}


// ── Go ───────────────────────────────────────────────────────────────────────

window.addEventListener('load', () => {
  const active = document.querySelector('.v-tab.is-active');
  if (active) requestAnimationFrame(() => moveGlider(active));
});

chrome.tabs.onActivated.addListener(() => boot());
boot();
