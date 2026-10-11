/* ============================================================================
 * Visor — Page Probe  (MAIN world)
 * ----------------------------------------------------------------------------
 * Runs in the Google Docs page context so it can read the editor's own
 * bootstrap state. Reports two things back to the isolated content script:
 *
 *   1. editable      — whether this user can edit, which decides whether Visor
 *                      is allowed to look at revision history at all.
 *   2. revisionHint  — the current revision number, so the engine can skip
 *                      most of its binary-search probing.
 *
 * Reads only. Never writes to the page, never touches document content.
 * ==========================================================================*/

(function () {
  'use strict';

  const CHANNEL = 'VISOR_PAGE_PROBE';

  function readInitialData() {
    try {
      const d = window._docs_flag_initialData;
      return (d && typeof d === 'object') ? d : null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Look through the bootstrap blob for a flag that names editability.
   * Key names have changed across Docs releases, so match on meaning rather
   * than on any single key, and return null when nothing conclusive is found
   * (the caller then falls back to DOM inspection).
   */
  function editableFromFlags(data) {
    if (!data) return null;

    const EXPLICIT = [
      'docs-eev',            // "editor enabled"
      'docs-ecpc',
      'info_params.editable',
      'editable'
    ];
    for (const key of EXPLICIT) {
      if (typeof data[key] === 'boolean') return data[key];
    }

    // Read-only style flags invert the answer.
    for (const key of Object.keys(data)) {
      const v = data[key];
      if (typeof v !== 'boolean') continue;
      const k = key.toLowerCase();
      if (k.includes('readonly') || k.includes('viewonly') || k.includes('read_only')) {
        return !v;
      }
    }
    return null;
  }

  function revisionHint(data) {
    if (!data) return 0;
    const CANDIDATES = ['docs-crs', 'docs-rev', 'revision', 'info_params.revision'];
    for (const key of CANDIDATES) {
      const v = data[key];
      if (typeof v === 'number' && v > 0 && v < 1e7) return v;
    }
    // Fall back to any plausible revision-shaped integer under a rev-ish key.
    for (const key of Object.keys(data)) {
      if (!/rev/i.test(key)) continue;
      const v = data[key];
      if (typeof v === 'number' && v > 1 && v < 1e7) return v;
    }
    return 0;
  }

  const TAB_ID_RE = /^t\.[A-Za-z0-9_-]+$/;

  /** Any t.-shaped id on the element or anywhere beneath it. */
  function findTabIdIn(el, depth) {
    depth = depth || 0;
    if (!el || !el.attributes || depth > 3) return null;
    for (const a of el.attributes) {
      if (TAB_ID_RE.test(a.value)) return a.value;
      // Some attributes embed the id inside a longer string.
      const m = /\bt\.[A-Za-z0-9_-]{1,40}\b/.exec(a.value || '');
      if (m && /id|tab|key|item/i.test(a.name)) return m[0];
    }
    for (const child of el.children || []) {
      const hit = findTabIdIn(child, depth + 1);
      if (hit) return hit;
    }
    return null;
  }

  /** The visible label of a strip item, without its icons or controls. */
  function tabLabel(el) {
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria;
    // Prefer a dedicated label node over the whole subtree, which can drag in
    // button text such as "More options".
    const label = el.querySelector('[class*="label" i], [class*="title" i], [class*="name" i]');
    if (label && label.textContent.trim()) return label.textContent;
    return el.textContent;
  }

  /**
   * The document tab strip, and nothing else.
   *
   * An earlier version matched on role alone and picked up the Workspace
   * add-on sidebar — Calendar, Keep, Tasks — and offered those as document
   * tabs. So an element now only counts when it actually carries a t.-shaped
   * tab id. If nothing does, this returns nothing rather than something wrong:
   * the changelog is the real source of tabs, and a bad guess here is worse
   * than no guess at all.
   */
  function harvestLiveTabs() {
    const found = new Map();

    let nodes;
    try {
      nodes = document.querySelectorAll('[data-tab-id], [id^="t."], [data-id^="t."]');
    } catch (_) {
      return [];
    }

    nodes.forEach((el) => {
      const id = findTabIdIn(el);
      if (!id) return;
      const title = (tabLabel(el) || '').replace(/\s+/g, ' ').trim();
      if (!title || title.length > 200) return;
      if (!found.has(id)) found.set(id, { id, title });
    });

    return found.size > 1 ? [...found.values()] : [];
  }

  /** Never let one harvester's failure suppress the whole report. */
  function safely(fn, fallback) {
    try { return fn(); } catch (_) { return fallback; }
  }

  function report() {
    const data = safely(readInitialData, null);
    window.postMessage({
      source: CHANNEL,
      editable: safely(() => editableFromFlags(data), null),
      revisionHint: safely(() => revisionHint(data), 0),
      liveTabs: safely(harvestLiveTabs, []),
      ready: !!data
    }, window.location.origin);
  }

  report();
  // The bootstrap blob is populated asynchronously on cold loads.
  [400, 1200, 3000].forEach((t) => setTimeout(report, t));

  /*
   * Report again when asked.
   *
   * Docs moves between documents without reloading the page, and this data —
   * edit access, the revision hint, the live tab titles — belongs to whichever
   * document is open now. Without this the content script kept the previous
   * document's answers, so a view-only document's verdict stuck to the next
   * one and no bar appeared until a hard reload.
   */
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    if (!e.data || e.data.source !== `${CHANNEL}_REQUEST`) return;
    report();
  });
})();
