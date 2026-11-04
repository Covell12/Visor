/* ============================================================================
 * Visor — Google Drive files for a group project (Visor Classroom)
 * ----------------------------------------------------------------------------
 * What the "Add files from Google Drive" page (drive-import.html) runs on:
 *
 *   parse()       turns whatever a person pastes (links copied in Google
 *                 Drive, or Drive's own copied selection) into Google Docs and
 *                 Slides files, and says plainly why anything else isn't one;
 *   importFile()  reads one file's history in this browser and sends its
 *                 figures to a Visor project.
 *
 * No Google sign-in, Drive API or Google Picker, on purpose. Browsing a whole
 * Drive needs an OAuth client and a restricted Drive scope, and the Picker is
 * script loaded from Google's servers, which an extension page can't run. The
 * web app's Resources tab has the Picker route (when its Google keys are set);
 * this is the extension's own: Visor reads a file the way it reads the Doc you
 * have open, from the file's own page, with the Google session this browser
 * already has. A file that isn't open is opened in a background tab, read by
 * the content script exactly as the Visor button would read it, and closed.
 *
 * Only ids that pass ID_RE are ever put into an address, and only into the
 * Google addresses openUrl() builds. Nothing else a paste contains is opened.
 * ==========================================================================*/

(function (root) {
  'use strict';

  // A Drive file id. Real ones are 25 to 44 characters; much shorter is the
  // end of a link that was cut off, or not an id at all.
  const ID_RE = /^[A-Za-z0-9_-]{15,200}$/;
  // ?authuser= names which signed-in Google account opens the file: an index
  // or an address. Kept so a student whose school account isn't Chrome's
  // first one still opens the file as the account that can edit it.
  const AUTHUSER_RE = /^(\d{1,2}|[^\s@/?#&]+@[^\s@/?#&]+\.[^\s@/?#&]+)$/;
  // The pages the content script runs on and reads (content.js getFileId)
  const DOC_TAB_RE = /^https:\/\/docs\.google\.com\/(document|presentation)\/d\/([A-Za-z0-9_-]+)/;

  const REASONS = {
    sheets: 'That’s a Google Sheets file. Visor reads Google Docs and Slides.',
    forms: 'That’s a Google Form. Visor reads Google Docs and Slides.',
    'other-app': 'That isn’t a Google Doc or Slides file.',
    published: 'That’s a “Publish to the web” link, which doesn’t lead to the file. Use the file’s own link: Share → Copy link.',
    uploaded: 'That’s a file uploaded to Drive, like a PDF or a Word file. Visor reads the edit history Google Docs and Slides keep, and uploaded files don’t have one.',
    folder: 'That’s a folder. Open it and copy the links of the files inside.',
    'drive-page': 'That’s a page of Google Drive, not a file. Copy the links of the files you want.',
    home: 'That’s the Docs or Slides home page, not a file.',
    'not-file': 'That isn’t a link to a Google Doc or Slides file.',
    'bad-id': 'That link is cut off. Copy it again.',
    'not-google': 'That isn’t a Google Drive link.'
  };

  // ── Reading a paste ───────────────────────────────────────────────────────

  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
  function decodeEntities(s) {
    return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (m, e) => {
      if (e[0] === '#') {
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
      }
      return Object.prototype.hasOwnProperty.call(ENTITIES, e.toLowerCase()) ? ENTITIES[e.toLowerCase()] : m;
    });
  }

  // People paste links with and without https://, inside sentences, and
  // followed by a full stop or a bracket; Drive's own copy puts one per line.
  const trimLink = (s) => s.replace(/[.,;:!?'"\])}>]+$/, '');
  function linksIn(text) {
    const out = [];
    // A list joined with commas and no spaces is still one link per file
    const s = String(text || '').replace(/,(?=\s*(?:https?:\/\/|(?:docs|drive)\.google\.com\/))/gi, ' ');
    for (const m of s.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) out.push(trimLink(m[0]));
    for (const m of s.matchAll(/(?<![\w./:@-])(?:docs|drive)\.google\.com\/[^\s<>"'`]+/gi)) out.push(trimLink(m[0]));
    return out;
  }

  // Drive's copied selection, as HTML: each file is a link whose text is its
  // name, which makes a better label than an id until the file is read.
  function anchorsIn(html) {
    const out = [];
    for (const m of String(html || '').matchAll(/<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi)) {
      const href = decodeEntities(m[2]).trim();
      const label = decodeEntities(m[3].replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
      out.push({ href, title: label && !/^(https?:\/\/|(docs|drive)\.google\.com\/)/i.test(label) ? label.slice(0, 200) : null });
    }
    return out;
  }

  const authuserOf = (u) => {
    const v = u.searchParams.get('authuser');
    return v && AUTHUSER_RE.test(v) ? v : null;
  };

  /** One link: { file: { fileId, kind, authuser } } or { reject: code }. */
  function classify(raw) {
    let u;
    try { u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); } catch (_) { return { reject: 'not-google' }; }
    const host = u.hostname.toLowerCase();
    const p = u.pathname;
    const idOk = (id) => ID_RE.test(id || '');

    if (host === 'docs.google.com') {
      // /document/d/<id>/edit, /presentation/u/1/d/<id>, /a/<domain>/document/d/<id>
      const m = /^\/(?:a\/[^/]+\/)?([a-z]+)\/(?:u\/(\d{1,2})\/)?d\/([^/?#]+)/.exec(p);
      if (m) {
        const [, app, index, id] = m;
        const kind = app === 'document' ? 'doc' : app === 'presentation' ? 'slides' : null;
        if (!kind) return { reject: app === 'spreadsheets' ? 'sheets' : app === 'forms' ? 'forms' : 'other-app' };
        if (id === 'e') return { reject: 'published' };     // /d/e/2PACX-…/pub
        if (!idOk(id)) return { reject: 'bad-id' };
        return { file: { fileId: id, kind, authuser: authuserOf(u) || index || null } };
      }
      if (/^\/(?:a\/[^/]+\/)?open\/?$/.test(p)) {
        const id = u.searchParams.get('id');
        return idOk(id) ? { file: { fileId: id, kind: null, authuser: authuserOf(u) } } : { reject: 'bad-id' };
      }
      if (/^\/(?:a\/[^/]+\/)?(document|presentation)(\/|$)/.test(p)) return { reject: 'home' };
      if (/^\/(?:a\/[^/]+\/)?(spreadsheets)(\/|$)/.test(p)) return { reject: 'sheets' };
      if (/^\/(?:a\/[^/]+\/)?(forms)(\/|$)/.test(p)) return { reject: 'forms' };
      return { reject: 'not-file' };
    }

    if (host === 'drive.google.com') {
      // Drive's open link works for any file; which kind it is shows once it opens
      if (/^\/(?:drive\/)?(?:u\/\d{1,2}\/)?open\/?$/.test(p)) {
        const id = u.searchParams.get('id');
        return idOk(id) ? { file: { fileId: id, kind: null, authuser: authuserOf(u) } } : { reject: 'bad-id' };
      }
      if (/^\/(?:u\/\d{1,2}\/)?file\/(?:u\/\d{1,2}\/)?d\//.test(p) || p === '/uc') return { reject: 'uploaded' };
      if (/^\/drive\/(?:u\/\d{1,2}\/)?folders\//.test(p)) return { reject: 'folder' };
      return { reject: 'drive-page' };
    }

    return { reject: 'not-google' };
  }

  /**
   * Everything a paste names: the Docs and Slides files in it, each once, and
   * the links that aren't one, each with the reason.
   *   parse(text, html) → { files: [{ fileId, kind, authuser, title }],
   *                         rejected: [{ link, code, reason }] }
   * `kind` is 'doc', 'slides', or null for a Drive "open" link (it shows which
   * when the file opens). `html` is the clipboard's HTML, when there is any.
   */
  function parse(text, html) {
    const files = new Map();
    const rejected = new Map();
    const take = (link, title) => {
      const r = classify(link);
      if (r.file) {
        const had = files.get(r.file.fileId);
        if (!had) { files.set(r.file.fileId, { ...r.file, title: title || null }); return; }
        if (!had.kind && r.file.kind) had.kind = r.file.kind;
        if (!had.authuser && r.file.authuser) had.authuser = r.file.authuser;
        if (!had.title && title) had.title = title;
      } else if (!rejected.has(link)) {
        rejected.set(link, r.reject);
      }
    };
    for (const a of anchorsIn(html)) take(a.href, a.title);
    for (const link of linksIn(text)) take(link, null);
    return {
      files: [...files.values()],
      rejected: [...rejected].map(([link, code]) => ({ link, code, reason: REASONS[code] || REASONS['not-file'] }))
    };
  }

  /** The address that opens a file: built from the id, never from the paste. */
  function openUrl(file) {
    if (!file || !ID_RE.test(String(file.fileId || ''))) return null;
    const id = encodeURIComponent(file.fileId);
    const au = file.authuser && AUTHUSER_RE.test(String(file.authuser)) ? `authuser=${encodeURIComponent(file.authuser)}` : '';
    if (file.kind === 'doc') return `https://docs.google.com/document/d/${id}/edit${au ? `?${au}` : ''}`;
    if (file.kind === 'slides') return `https://docs.google.com/presentation/d/${id}/edit${au ? `?${au}` : ''}`;
    return `https://drive.google.com/open?id=${id}${au ? `&${au}` : ''}`;
  }

  /** The Doc or Slides file a tab shows, as the content script sees it. */
  function fromTabUrl(url) {
    const m = DOC_TAB_RE.exec(String(url || ''));
    return m ? { fileId: m[2], kind: m[1] === 'presentation' ? 'slides' : 'doc' } : null;
  }

  /** A tab's title without Google's " - Google Docs" ending (as content.js docMeta). */
  function cleanTitle(title) {
    return String(title || '').replace(/ - Google (Docs|Slides).*$/, '').trim();
  }

  // ── Reading a file and sending it ─────────────────────────────────────────

  const FAILURES = {
    closed: 'The tab Visor opened to read this file was closed before it finished.',
    signin: 'Google asked to sign in. Sign in to Google in Chrome, then try again.',
    'not-doc': 'Google Drive didn’t open this as a Google Doc or Slides file.',
    sheets: REASONS.sheets,
    uploaded: REASONS.uploaded,
    'no-answer': 'Visor couldn’t read this file here. Open it, click the Visor button, and use Send to Visor.',
    timeout: 'This file took too long to read. Open it, click the Visor button, and use Send to Visor.',
    'view-only': 'Visor can’t read this file’s history: you can only view it, or the Google account signed in here can’t open it. Visor reads history for people who can edit.',
    empty: 'This file has no edits to report yet.',
    'read-error': 'Visor couldn’t read this file’s history.',
    send: 'Couldn’t reach Visor.'
  };

  const DEFAULTS = {
    loadTimeoutMs: 90000,      // opening the file, to its content script answering
    readTimeoutMs: 240000,     // reading its whole history (a long one takes a while)
    pollMs: 500,
    settleMs: 1500,            // after the page has loaded, before asking (Docs is still building its menus)
    stillLoadingMs: 20000,     // Visor is attached but the page never says it has loaded: go anyway
    driveOpenMs: 12000,        // Drive's open link has loaded and gone nowhere: it isn't going to
    viewOnlyRetryMs: 3000      // a view-only answer is asked again once, in case the menus weren't built yet
  };

  const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

  function withTimeout(promise, ms, fallback) {
    let timer;
    return Promise.race([
      Promise.resolve(promise).catch(() => fallback),
      new Promise((r) => { timer = setTimeout(() => r(fallback), Math.max(0, ms)); })
    ]).finally(() => clearTimeout(timer));
  }

  const fail = (code, detail) => ({
    ok: false, code,
    error: (FAILURES[code] || FAILURES['read-error']) + (detail ? ` (${String(detail).slice(0, 160)})` : '')
  });

  /**
   * Read one file and send what Visor finds to a project.
   *
   *   file  { fileId, kind, authuser, tabId? }   tabId: a tab the person already
   *         has open on it, used as it is (and left open)
   *   deps  { tabs: { create, get, remove, sendMessage } (promise-returning),
   *           send(report) → { ok, to, error },
   *           onStep(step, extra)?, sleep(ms)?, now()? }
   *         Steps: 'opening', 'reading' ({ tabId }), 'sending'.
   *
   * → { ok: true, to, fileId, title, kind } or { ok: false, code, error }
   *
   * The report is the whole document (every tab of a Doc that has tabs), the
   * same figures-only export as Send to Visor: no text of the document.
   */
  async function importFile(file, deps, options) {
    const o = { ...DEFAULTS, ...(options || {}) };
    const { tabs, send } = deps;
    const sleep = deps.sleep || sleepReal;
    const now = deps.now || Date.now;
    const step = (s, extra) => { try { if (deps.onStep) deps.onStep(s, extra || {}); } catch (_) { /* the page's problem */ } };
    const ask = (tabId, msg, ms) => withTimeout(Promise.resolve().then(() => tabs.sendMessage(tabId, msg)), ms, null);
    const tabGone = async (tabId) => { try { return !(await tabs.get(tabId)); } catch (_) { return true; } };

    let tabId = null;
    let owned = false;
    try {
      // A tab the person has open on this file, if Visor is attached to it
      if (file.tabId != null) {
        const st = await ask(file.tabId, { type: 'VISOR_STATUS' }, 3000);
        if (st && st.meta && st.meta.fileId === file.fileId) tabId = file.tabId;
      }

      if (tabId == null) {
        const url = openUrl(file);
        if (!url) return fail('not-doc');
        step('opening');
        const tab = await tabs.create({ url, active: false });
        if (!tab || tab.id == null) return fail('closed');
        tabId = tab.id;
        owned = true;
        const loaded = await waitForDoc(tabId);
        if (!loaded.ok) return fail(loaded.code);
      }

      step('reading', { tabId });
      // A tab the person had open may hold figures from hours ago (its bar
      // only refreshes while it's on screen), so that one is read afresh,
      // as the side panel's refresh button does. A tab opened here is new.
      const read = await readHistory(tabId, !owned);
      if (read.state !== 'ready') {
        if (read.state === 'no-answer' && await tabGone(tabId)) return fail('closed');
        const code = { 'view-only': 'view-only', empty: 'empty', error: 'read-error', 'no-document': 'not-doc', timeout: 'timeout' }[read.state] || 'no-answer';
        return fail(code, code === 'read-error' ? read.error : null);
      }

      const exp = await ask(tabId, { type: 'VISOR_EXPORT', whole: true }, 30000);
      if (!exp || !exp.ok || !exp.report) return fail('no-answer');
      const report = exp.report;
      if (!(report.analysis && Array.isArray(report.analysis.contributors) && report.analysis.contributors.length)) return fail('empty');

      // Done with the page: close it before the upload, not after
      if (owned) { tabs.remove(tabId).catch(() => {}); owned = false; }

      step('sending');
      let sent = null;
      try { sent = await send(report); } catch (e) { sent = { ok: false, error: String((e && e.message) || e) }; }
      if (!sent || !sent.ok) return { ok: false, code: 'send', error: (sent && sent.error) || FAILURES.send };
      const meta = report.meta || {};
      return { ok: true, to: sent.to || [], fileId: meta.fileId || file.fileId, title: meta.title || '', kind: meta.kind || file.kind };
    } finally {
      if (owned && tabId != null) tabs.remove(tabId).catch(() => {});
    }

    // The opened tab, until it's a Doc or Slides page Visor is attached to and
    // the page has loaded; or until it plainly isn't going to be one.
    async function waitForDoc(id) {
      const deadline = now() + o.loadTimeoutMs;
      let attachedAt = null;
      let loadedAt = null;
      let stuckAt = null;
      const DRIVE_OPEN = /^https:\/\/drive\.google\.com\/(?:drive\/)?(?:u\/\d+\/)?open\b/;
      while (now() < deadline) {
        let t = null;
        try { t = await tabs.get(id); } catch (_) { t = null; }
        if (!t) return { ok: false, code: 'closed' };
        const url = String(t.url || t.pendingUrl || '');
        if (DOC_TAB_RE.test(url)) {
          const st = await ask(id, { type: 'VISOR_STATUS' }, 2000);
          if (st && st.meta && st.meta.fileId) {
            if (attachedAt == null) attachedAt = now();
            if (t.status === 'complete') {
              if (loadedAt == null) loadedAt = now();
              if (now() - loadedAt >= o.settleMs) return { ok: true };
            } else if (now() - attachedAt >= o.stillLoadingMs) {
              return { ok: true };
            }
          }
        } else if (t.status === 'complete' && DRIVE_OPEN.test(url)) {
          // Drive's open link moves on to the file's own page by itself; one
          // that has loaded and stays (a file that doesn't exist, say) won't
          if (stuckAt == null) stuckAt = now();
          if (now() - stuckAt >= o.driveOpenMs) return { ok: false, code: 'not-doc' };
        } else if (t.status === 'complete' && url && url !== 'about:blank') {
          // It finished loading somewhere that isn't a Doc or Slides file
          if (/^https:\/\/accounts\.google\.com\//.test(url)) return { ok: false, code: 'signin' };
          if (/^https:\/\/docs\.google\.com\/(?:a\/[^/]+\/)?spreadsheets\//.test(url)) return { ok: false, code: 'sheets' };
          if (/^https:\/\/drive\.google\.com\/(?:u\/\d+\/)?file\//.test(url)) return { ok: false, code: 'uploaded' };
          return { ok: false, code: 'not-doc' };
        }
        await sleep(o.pollMs);
      }
      return { ok: false, code: 'timeout' };
    }

    // The content script's own analysis, as the side panel asks for it
    async function readHistory(id, fresh) {
      const deadline = now() + o.readTimeoutMs;
      let retried = false;
      let force = !!fresh;
      while (now() < deadline) {
        const r = await ask(id, { type: 'VISOR_ANALYZE', force }, Math.max(1000, deadline - now()));
        force = false;   // once: after waiting out someone else's read, that read is fresh
        if (!r) return { state: 'no-answer' };
        if (r.state === 'ready') return r;
        if (r.state === 'running' || r.state === 'stale') {
          // Someone else started the read (a linked Doc reads itself on open)
          while (now() < deadline) {
            await sleep(o.pollMs);
            const st = await ask(id, { type: 'VISOR_STATUS' }, 2000);
            if (!st || st.state !== 'running') break;
          }
          continue;
        }
        if (r.state === 'view-only' && !retried) { retried = true; await sleep(o.viewOnlyRetryMs); continue; }
        return r;
      }
      return { state: 'timeout' };
    }
  }

  const api = { parse, classify, openUrl, fromTabUrl, cleanTitle, importFile, REASONS, FAILURES, ID_RE };
  root.VisorDrive = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
