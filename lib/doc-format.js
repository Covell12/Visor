/* Visor — the document model the editor, the server and the teacher's views
   share: which formats a document may carry, how they're checked, how the
   formatting runs move with edits, and how stored text + runs become a Quill
   delta.

   One file, two places: the browser loads public/doc-format.js (after
   vendor/quill/quill.js); the server requires lib/doc-format.js, an identical
   copy kept in step by `npm run sync-engine` (test/engine-sync.test.js checks
   they match). Edit public/doc-format.js, then run the sync.

   A stored document is { text, formats }:
     text     Quill's text without its final line break. An image is one
              EMBED character (U+FFFC), the same one index Quill gives it.
     formats  [{ at, len, attrs }] applied in order: later wins, null removes.
              Runs may reach index text.length, the final line break, which
              carries the last line's block formats.

   Everything here is pure except registerQuill, which is browser only. */

(function (root) {
  'use strict';

  const EMBED = '￼';
  const TRANSPARENT_GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

  const FONTS = ['Arial', 'Times New Roman', 'Georgia', 'Garamond', 'Courier New', 'Verdana', 'Trebuchet MS', 'Comic Sans MS'];
  const SIZES = ['8pt', '9pt', '10pt', '11pt', '12pt', '14pt', '16pt', '18pt', '24pt', '30pt', '36pt', '48pt', '60pt', '72pt'];
  const LINE_HEIGHTS = ['1', '1.15', '1.5', '2'];
  const DOC_STYLES = {
    mla: { label: 'MLA essay', font: 'Times New Roman', size: '12pt', lineheight: '2' },
    docs: { label: 'Docs default', font: 'Arial', size: '11pt', lineheight: '1.15' }
  };
  const INLINE_KEYS = ['bold', 'italic', 'underline', 'strike', 'script', 'font', 'size', 'color', 'background', 'link'];
  const BLOCK_KEYS = ['header', 'title', 'subtitle', 'list', 'align', 'indent', 'lineheight', 'table'];
  const EMBED_KEYS = ['image', 'width', 'alt'];
  // Every Quill format name the editor and the read-only views use. width and
  // alt are attributes of the image, not formats of their own.
  const QUILL_FORMATS = INLINE_KEYS.concat(BLOCK_KEYS, ['image']);
  // How each character arrived (lib/process.js), for the teacher's colour-by-source view
  const SRC_CATEGORIES = ['typed', 'pasted-internal', 'pasted-research', 'pasted-outside', 'cited', 'template', 'other', 'image'];

  const ALL_KEYS = INLINE_KEYS.concat(BLOCK_KEYS, EMBED_KEYS);
  const has = (list, k) => list.indexOf(k) > -1;
  const isInlineKey = k => has(INLINE_KEYS, k);
  const isBlockKey = k => has(BLOCK_KEYS, k);
  const isEmbedKey = k => has(EMBED_KEYS, k);
  const isKnownKey = k => has(ALL_KEYS, k);

  /* ---------------- checking values ---------------- */

  // A whole number from a number or a string of digits (never a boolean)
  function intOf(v) {
    if (typeof v === 'number') return Number.isInteger(v) ? v : null;
    if (typeof v === 'string' && /^\s*\d{1,6}\s*$/.test(v)) return Number(v);
    return null;
  }

  function hexOf(v) {
    if (typeof v !== 'string') return undefined;
    const s = v.trim().toLowerCase();
    let m = /^#([0-9a-f]{3})$/.exec(s);
    if (m) return '#' + m[1].split('').map(c => c + c).join('');
    if (/^#[0-9a-f]{6}$/.test(s)) return s;
    m = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/.exec(s);
    if (m) {
      const n = [m[1], m[2], m[3]].map(Number);
      if (n.some(x => x > 255)) return undefined;
      return '#' + n.map(x => (x < 16 ? '0' : '') + x.toString(16)).join('');
    }
    return undefined;
  }

  // "example.com", "www.example.com/page?x=1", "example.org:8080"
  const HOSTLIKE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d{1,5})?(?:[/?#]\S*)?$/i;
  function linkOf(v) {
    if (typeof v !== 'string') return undefined;
    let s = v.trim();
    if (!s || s.length > 2048 || /[\u0000-\u001f\u007f]/.test(s)) return undefined;
    if (HOSTLIKE.test(s)) s = 'https://' + s;
    if (s.length > 2048) return undefined;
    let u;
    try { u = new URL(s); } catch (e) { return undefined; }
    if (u.protocol === 'http:' || u.protocol === 'https:') return /^https?:\/\/[^/?#\s]/i.test(s) ? s : undefined;
    if (u.protocol === 'mailto:') return /^mailto:\S/i.test(s) ? s : undefined;
    return undefined;
  }

  // The clean value for one attribute: the value, null (remove the format), or
  // undefined (drop the key: unknown, or a value that isn't allowed).
  function cleanValue(key, v) {
    if (!isKnownKey(key)) return undefined;
    if (v === null || v === false) return null;
    switch (key) {
      case 'bold': case 'italic': case 'underline': case 'strike': case 'title': case 'subtitle':
        return v === true ? true : undefined;
      case 'script':
        return v === 'sub' || v === 'super' ? v : undefined;
      case 'font': {
        if (typeof v !== 'string') return undefined;
        const f = v.replace(/["']/g, '').trim().toLowerCase();
        for (const name of FONTS) if (name.toLowerCase() === f) return name;
        return undefined;
      }
      case 'size':
        return typeof v === 'string' && has(SIZES, v) ? v : undefined;
      case 'color': case 'background':
        return hexOf(v);
      case 'link':
        return linkOf(v);
      case 'header': { const n = intOf(v); return n != null && n >= 1 && n <= 6 ? n : undefined; }
      case 'list':
        return v === 'bullet' || v === 'ordered' || v === 'checked' || v === 'unchecked' ? v : undefined;
      case 'align':
        return v === 'center' || v === 'right' || v === 'justify' ? v : undefined;
      case 'indent': { const n = intOf(v); return n != null && n >= 1 && n <= 8 ? n : undefined; }
      case 'lineheight': {
        if (typeof v !== 'number' && typeof v !== 'string') return undefined;
        const s = String(v).trim();
        return has(LINE_HEIGHTS, s) ? s : undefined;
      }
      case 'table':
        return typeof v === 'string' && /^row-[a-z0-9]{1,16}$/.test(v) ? v : undefined;
      case 'image':
        return typeof v === 'string' && /^[a-f0-9]{32}$/.test(v) ? v : undefined;
      case 'width': { const n = intOf(v); return n != null && n >= 16 && n <= 2000 ? String(n) : undefined; }
      case 'alt':
        return typeof v === 'string' && v.length <= 300 ? v : undefined;
    }
    return undefined;
  }

  // Only the valid keys of raw, or null if none survive
  function cleanAttrs(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const out = {};
    let n = 0;
    for (const k of ALL_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(raw, k)) continue;
      const v = cleanValue(k, raw[k]);
      if (v === undefined) continue;
      out[k] = v; n++;
    }
    return n ? out : null;
  }

  // Words as the student sees them: an image isn't a word
  function wordCount(text) {
    const t = String(text == null ? '' : text).replace(/￼/g, ' ').trim();
    return t ? t.split(/\s+/).length : 0;
  }

  /* ---------------- formatting runs ---------------- */
  // Each returns a new list and never changes the runs it was given.

  const isEmpty = a => { if (!a) return true; for (const k in a) if (Object.prototype.hasOwnProperty.call(a, k)) return false; return true; };

  // n characters inserted at `at`. Runs at or after it move; a run that
  // strictly contains it is split around the new text, so inserted text
  // inherits nothing and has exactly the insert's own attrs (as in a Quill delta).
  function insertRuns(formats, at, n, attrs) {
    const out = [];
    for (const r of formats) {
      if (n <= 0 || r.at + r.len <= at) out.push(r);
      else if (r.at >= at) out.push({ at: r.at + n, len: r.len, attrs: r.attrs });
      else {
        out.push({ at: r.at, len: at - r.at, attrs: r.attrs });
        out.push({ at: at + n, len: r.at + r.len - at, attrs: r.attrs });
      }
    }
    if (n > 0 && !isEmpty(attrs)) out.push({ at, len: n, attrs });
    return out;
  }

  // len characters deleted from `at`: runs move back and shrink; empty ones go
  function deleteRuns(formats, at, len) {
    const end = at + len;
    const out = [];
    for (const r of formats) {
      const rEnd = r.at + r.len;
      const cut = Math.max(0, Math.min(rEnd, end) - Math.max(r.at, at));
      const nAt = r.at >= end ? r.at - len : r.at > at ? at : r.at;
      const nLen = r.len - cut;
      if (nLen <= 0) continue;
      out.push(nAt === r.at && nLen === r.len ? r : { at: nAt, len: nLen, attrs: r.attrs });
    }
    return out;
  }

  // attrs applied to [at, at + len): a new run on top of the others
  function formatRuns(formats, at, len, attrs) {
    const out = formats.slice();
    if (len > 0 && !isEmpty(attrs)) out.push({ at, len, attrs });
    return out;
  }

  // Two attribute sets with the same keys and values (null or {} = none)
  function sameAttrs(a, b) {
    const ka = a ? Object.keys(a) : [], kb = b ? Object.keys(b) : [];
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (!Object.prototype.hasOwnProperty.call(b, k) || a[k] !== b[k]) return false;
    return true;
  }

  // The formats as non-overlapping segments covering [0, textLength] (the
  // final line break included): [{ at, len, attrs }] with nulls (and false,
  // which cleanValue treats the same) removed, equal neighbours merged and
  // empty attrs kept. A sweep over the run boundaries, so the cost depends on
  // the runs, not the length of the text.
  function segments(textLength, formats) {
    const L = Math.max(0, Math.floor(Number(textLength) || 0)) + 1;
    const runs = [];
    const list = formats || [];
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      if (!r || !r.attrs || typeof r.attrs !== 'object') continue;
      const s = Math.max(0, r.at), e = Math.min(L, r.at + r.len);
      if (e > s) runs.push({ s, e, i, attrs: r.attrs });
    }
    const bounds = [0, L];
    for (const r of runs) bounds.push(r.s, r.e);
    bounds.sort((a, b) => a - b);
    const byStart = runs.slice().sort((a, b) => a.s - b.s);
    const byEnd = runs.slice().sort((a, b) => a.e - b.e);
    const active = [];          // runs covering the current segment, in list order
    const find = i => { let lo = 0, hi = active.length; while (lo < hi) { const m = (lo + hi) >> 1; if (active[m].i < i) lo = m + 1; else hi = m; } return lo; };
    const out = [];
    let si = 0, ei = 0;
    for (let b = 0; b < bounds.length - 1; b++) {
      const at = bounds[b], next = bounds[b + 1];
      if (next === at) continue;
      while (ei < byEnd.length && byEnd[ei].e <= at) { const r = byEnd[ei++]; const p = find(r.i); if (active[p] === r) active.splice(p, 1); }
      while (si < byStart.length && byStart[si].s <= at) { const r = byStart[si++]; if (r.e > at) active.splice(find(r.i), 0, r); }
      const m = {};
      for (const r of active) for (const k in r.attrs) if (Object.prototype.hasOwnProperty.call(r.attrs, k)) m[k] = r.attrs[k];
      const attrs = {};
      for (const k in m) if (m[k] != null && m[k] !== false) attrs[k] = m[k];
      const last = out[out.length - 1];
      if (last && sameAttrs(last.attrs, attrs)) last.len += next - at;
      else out.push({ at, len: next - at, attrs });
    }
    return out;
  }

  // The fewest runs that format the text the same way (every key kept)
  function compactFormats(formats, textLength) {
    return segments(textLength, formats).filter(s => !isEmpty(s.attrs));
  }

  /* ---------------- stored document <-> Quill delta ---------------- */

  const defaultImageSrc = id => (id ? '/api/images/' + id : TRANSPARENT_GIF);

  function pick(attrs, test) {
    let out = null;
    for (const k in attrs) if (test(k)) (out || (out = {}))[k] = attrs[k];
    return out;
  }

  function pushText(ops, s, attrs) {
    const last = ops[ops.length - 1];
    if (last && typeof last.insert === 'string' && sameAttrs(last.attributes, attrs)) { last.insert += s; return; }
    const op = { insert: s };
    if (attrs) op.attributes = Object.assign({}, attrs);
    ops.push(op);
  }

  // Quill delta ops for text + '\n'. Characters get their inline formats, each
  // line break its block formats, each EMBED an image (with width, alt and any
  // inline formats such as a link). Plain data, so it works in node too.
  function docToDelta(text, formats, opts) {
    const full = String(text == null ? '' : text) + '\n';
    const imageSrc = opts && typeof opts.imageSrc === 'function' ? opts.imageSrc : defaultImageSrc;
    const specials = [];      // every line break and image, in order
    for (let i = 0; i < full.length; i++) { const c = full.charCodeAt(i); if (c === 10 || c === 0xFFFC) specials.push(i); }
    const ops = [];
    let sp = 0;
    for (const seg of segments(full.length - 1, formats)) {
      const end = seg.at + seg.len;
      const a = seg.attrs;
      const inline = pick(a, isInlineKey);
      let block, embed;
      let pos = seg.at;
      while (sp < specials.length && specials[sp] < end) {
        const i = specials[sp++];
        if (i > pos) pushText(ops, full.slice(pos, i), inline);
        if (full.charCodeAt(i) === 10) {
          if (block === undefined) block = pick(a, isBlockKey);
          pushText(ops, '\n', block);
        } else {
          if (embed === undefined) embed = pick(a, k => isInlineKey(k) || (k !== 'image' && isEmbedKey(k)));
          const op = { insert: { image: imageSrc(a.image || null) || TRANSPARENT_GIF } };
          if (embed) op.attributes = Object.assign({}, embed);
          ops.push(op);
        }
        pos = i + 1;
      }
      if (pos < end) pushText(ops, full.slice(pos, end), inline);
    }
    return ops;
  }

  // The text of a delta's inserts, an EMBED for each embed (Quill's own
  // getText drops them). For a whole document it ends with the final '\n'.
  function deltaText(ops) {
    const parts = [];
    for (const op of ops || []) {
      if (!op || op.insert == null) continue;
      parts.push(typeof op.insert === 'string' ? op.insert : EMBED);
    }
    return parts.join('');
  }

  // The image id in "/api/images/<id>" (query string allowed), relative or on
  // this page's own origin; otherwise null.
  function imageIdFromSrc(src, origin) {
    if (typeof src !== 'string') return null;
    let s = src.trim();
    const abs = /^https?:\/\/[^/?#]+/i.exec(s);
    if (abs) {
      const own = origin !== undefined ? origin : (typeof location !== 'undefined' && location ? location.origin : null);
      if (!own || abs[0].toLowerCase() !== String(own).toLowerCase()) return null;
      s = s.slice(abs[0].length);
    }
    const m = /^\/api\/images\/([a-f0-9]{32})(?:[?#].*)?$/.exec(s);
    return m ? m[1] : null;
  }

  // The page class for an assignment's document style
  const styleClass = docStyle => (docStyle === 'docs' ? 'doc-style-docs' : 'doc-style-mla');

  /* ---------------- Quill (browser only) ---------------- */

  let registeredWith = null;
  // Register the formats the documents use. Call once before any `new Quill`;
  // calling it again does nothing.
  function registerQuill(Quill) {
    if (!Quill || typeof Quill.import !== 'function') return false;
    if (registeredWith === Quill) return true;
    const P = Quill.import('parchment');

    // Font and size as inline styles, limited to the menus' values
    const Font = Quill.import('attributors/style/font');
    Font.whitelist = FONTS.slice();
    Quill.register(Font, true);
    const Size = Quill.import('attributors/style/size');
    Size.whitelist = SIZES.slice();
    Quill.register(Size, true);

    // Line spacing, a block style
    Quill.register(new P.StyleAttributor('lineheight', 'line-height', { scope: P.Scope.BLOCK, whitelist: LINE_HEIGHTS.slice() }), true);

    // Title and Subtitle paragraph styles: a <p> with a class
    const Block = Quill.import('blots/block');
    class Title extends Block { static formats() { return true; } }
    Title.blotName = 'title'; Title.tagName = 'P'; Title.className = 'ql-title';
    class Subtitle extends Block { static formats() { return true; } }
    Subtitle.blotName = 'subtitle'; Subtitle.tagName = 'P'; Subtitle.className = 'ql-subtitle';
    Quill.register(Title, true);
    Quill.register(Subtitle, true);

    // The teacher's colour-by-source view: class "src-<category>". Parchment
    // finds a class attributor on a node again by the class name minus its
    // last "-part", which fails for "src-pasted-research"; a second marker
    // class ("src-cat") lets it find these after Quill splits or clones a span.
    class SourceClass extends P.ClassAttributor {
      add(node, value) {
        if (!super.add(node, value)) return false;
        if (String(value).indexOf('-') > -1) node.classList.add(this.keyName + '-cat');
        return true;
      }
      value(node) {
        const pre = this.keyName + '-';
        for (const name of (node.getAttribute('class') || '').split(/\s+/)) {
          if (name.indexOf(pre) === 0 && this.canAdd(node, name.slice(pre.length))) return name.slice(pre.length);
        }
        return '';
      }
    }
    Quill.register(new SourceClass('srccat', 'src', { scope: P.Scope.INLINE, whitelist: SRC_CATEGORIES.slice() }), true);
    // The replay's highlight on text that just arrived: class "rp-fresh" / "rp-glow"
    Quill.register(new P.ClassAttributor('rpfresh', 'rp', { scope: P.Scope.INLINE, whitelist: ['fresh', 'glow'] }), true);

    // Images: also our own relative /api/images/<id> URLs and inline data
    // images (the blank placeholder); width and alt work as before.
    const BaseImage = Quill.import('formats/image');
    class Image extends BaseImage {
      static sanitize(url) {
        if (typeof url === 'string' && (/^\/api\/images\/[a-f0-9]{32}(?:\?[^\s"'<>#]*)?$/.test(url) || /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(url))) return url;
        return super.sanitize(url);
      }
    }
    Image.blotName = 'image'; Image.tagName = 'IMG';
    Quill.register(Image, true);

    registeredWith = Quill;
    return true;
  }

  const api = {
    EMBED, TRANSPARENT_GIF, FONTS, SIZES, LINE_HEIGHTS, DOC_STYLES, INLINE_KEYS, BLOCK_KEYS, EMBED_KEYS, QUILL_FORMATS, SRC_CATEGORIES,
    cleanValue, cleanAttrs, isBlockKey, isInlineKey, isEmbedKey, wordCount,
    insertRuns, deleteRuns, formatRuns, segments, compactFormats, sameAttrs,
    docToDelta, deltaText, imageIdFromSrc, styleClass, registerQuill
  };
  root.VisorDocFormat = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
