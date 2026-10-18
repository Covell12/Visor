/* ============================================================================
 * Visor — AWARE mode  (MAIN world, document_start, Google Docs only)
 * ----------------------------------------------------------------------------
 * Colours the text of the Google Doc on screen by who wrote it. Only on the
 * screen of the person who switched it on: nothing is written to the
 * document, nothing is sent anywhere, and switching it off removes it.
 *
 * Google Docs paints its text onto a canvas per page (`kix-canvas-tile-
 * content`), one fillText call per run of text: a line, or the part of a line
 * in one format. This script watches those calls — it never changes them — to
 * learn what text sits where on each page. When AWARE is on, it lays a
 * transparent canvas over each page and paints every author's stretch of each
 * run in their colour with a "lighten" blend: the white page stays white and
 * the dark text takes the author's colour. Text Docs draws in a colour of its
 * own (a link, a coloured heading, white text in a dark cell) keeps it and is
 * underlined in the author's colour instead, on a second layer: blending two
 * colours would only make a third. Switching it off removes the layers, and
 * the page is exactly as Docs drew it.
 *
 * Pastes (the panel switches each kind on): text pasted from outside the
 * document is highlighted in Google Docs' own light yellow, and text copied
 * or moved within it in Docs' light blue, behind the author's colour. A
 * single blend layer can't make white paper a colour and black text another
 * at once, so two do it: a multiply layer by M and a screen layer by the
 * author's colour C send every pixel p to C + p·(B − C), i.e. paper to the
 * highlight B and ink to C, with the antialiasing in between kept. That needs
 * B ≥ C in every channel, which both highlights are for every colour in
 * Visor's author palette.
 *
 * Placing a run in the document: its text is looked up in the document's text
 * (which Visor's history engine rebuilt from the revision log), walking each
 * page in reading order from an anchor run that occurs exactly once. A run
 * that can't be placed — a list number, a header, text typed since Visor last
 * read the history — is left as Docs drew it. Nothing is ever guessed.
 *
 * The content script sends the document's text, who wrote each stretch of it
 * (runs of [start, length, colour index, pasted]) and the colours, over
 * postMessage on this window. People switched off in the panel are simply
 * left out of the runs.
 * ==========================================================================*/

(function () {
  'use strict';

  // ── Placing runs (pure; also run by the tests in node) ─────────────────────

  const WINDOW = 400;     // how far ahead of the last placed run the next may start

  /** Every occurrence of `t` in `doc`, up to `max`. */
  function occurrences(doc, t, max) {
    const out = [];
    let i = doc.indexOf(t);
    while (i >= 0 && out.length < max) { out.push(i); i = doc.indexOf(t, i + 1); }
    return out;
  }

  /** The next occurrence of `t` at or after `from`, no further than WINDOW ahead. */
  function nearAfter(doc, t, from, reach) {
    const j = doc.slice(from, from + reach + t.length).indexOf(t);
    return j < 0 ? -1 : from + j;
  }

  /**
   * How well the runs after `i` fall into place if run `i` is at `at`: how
   * many are found in order, and how tightly (a run that starts a character
   * or two after the last is how text on a page actually continues; one sixty
   * characters on is a coincidence).
   */
  function follows(texts, i, at, doc, n) {
    let cur = at + texts[i].length, ok = 0, tight = 0;
    for (let k = i + 1; k < texts.length && k <= i + n; k++) {
      const j = nearAfter(doc, texts[k], cur, texts[k].length <= 2 ? 3 : WINDOW);
      if (j >= 0) { ok++; tight += 1 / (1 + (j - cur)); cur = j + texts[k].length; }
    }
    return { ok, tight };
  }

  /**
   * Where each run (in reading order) is in the document: an offset, or -1.
   * `hint` is where the previous page ended, used only to choose between
   * equally good anchors.
   */
  function placeRuns(texts, doc, hint = 0) {
    const out = new Array(texts.length).fill(-1);
    if (!doc || !texts.length) return out;

    // 1. An anchor: a run that occurs exactly once in the document, or else
    //    the occurrence of a repeated one that the most following runs confirm.
    let anchor = -1, at = -1;
    for (let i = 0; i < texts.length && i < 30 && anchor < 0; i++) {
      const t = texts[i];
      if (t.length < 6) continue;
      const cands = occurrences(doc, t, 40);
      if (!cands.length) continue;
      if (cands.length === 1) { anchor = i; at = cands[0]; break; }
      let best = -1, bestOk = 0, bestTight = -1;
      for (const c of cands) {
        const f = follows(texts, i, c, doc, 10);
        const tight = f.tight + (c >= hint ? .01 : 0);
        if (f.ok > bestOk || (f.ok === bestOk && f.ok && tight > bestTight)) { best = c; bestOk = f.ok; bestTight = tight; }
      }
      if (bestOk >= 3) { anchor = i; at = best; }
    }
    if (anchor < 0) return out;
    out[anchor] = at;

    // 2. Forward from the anchor, each run just after the one before. A run
    //    that isn't there (a list number, a page number) is skipped without
    //    moving on; very short runs must sit right at the cursor, so a "2."
    //    can't be matched to some "2." further down.
    let cur = at + texts[anchor].length;
    for (let i = anchor + 1; i < texts.length; i++) {
      const t = texts[i];
      const j = nearAfter(doc, t, cur, t.length <= 2 ? 3 : WINDOW);
      if (j >= 0) { out[i] = j; cur = j + t.length; continue; }
      // Lost the thread (a stretch Visor hasn't read yet): pick it up again
      // only at a run that occurs exactly once.
      if (t.length >= 8) {
        const c = occurrences(doc, t, 2);
        if (c.length === 1) { out[i] = c[0]; cur = c[0] + t.length; }
      }
    }

    // 3. Back from the anchor, for the runs above it on the page.
    let back = at;
    for (let i = anchor - 1; i >= 0; i--) {
      const t = texts[i];
      const from = Math.max(0, back - (t.length <= 2 ? 3 : WINDOW) - t.length);
      const j = doc.slice(from, back).lastIndexOf(t);
      if (j >= 0) { out[i] = from + j; back = from + j; }
    }
    return out;
  }

  /**
   * The authors' stretches within [at, at + len): [[from, to, colour, pasted],
   * ...], offsets relative to `at`. `owners` is sorted [[start, length,
   * colour, pasted]]; pasted is 0, 1 (from outside) or 2 (from within).
   */
  function stretchesIn(owners, at, len) {
    const out = [];
    let lo = 0, hi = owners.length - 1, first = owners.length;
    while (lo <= hi) {                       // the first run that ends after `at`
      const mid = (lo + hi) >> 1;
      if (owners[mid][0] + owners[mid][1] > at) { first = mid; hi = mid - 1; } else lo = mid + 1;
    }
    for (let k = first; k < owners.length && owners[k][0] < at + len; k++) {
      const [s, n, c, p] = owners[k];
      const from = Math.max(s, at) - at, to = Math.min(s + n, at + len) - at;
      if (to > from) out.push([from, to, c, p || 0]);
    }
    return out;
  }

  /**
   * Runs on a page, grouped into lines (baselines within half a line of each
   * other) and put in reading order: top to bottom, then left to right.
   */
  function readingOrder(runs) {
    const sorted = [...runs].sort((a, b) => a.y - b.y);
    const lines = [];
    for (const r of sorted) {
      const line = lines[lines.length - 1];
      if (line && Math.abs(r.y - line.y) <= Math.max(line.size, r.size) * .45) line.runs.push(r);
      else lines.push({ y: r.y, size: r.size, runs: [r] });
    }
    return lines.flatMap((l) => l.runs.sort((a, b) => a.x - b.x));
  }

  /**
   * Whether text drawn in this colour is plain dark text (black, near-black,
   * dark grey), which a "lighten" layer recolours exactly. Anything else keeps
   * its colour and is underlined instead.
   */
  function plainInk(style) {
    const s = String(style || '').trim().toLowerCase();
    let r, g, b;
    let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
    if (m) {
      const h = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1];
      [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    } else if ((m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(s))) {
      [r, g, b] = [m[1], m[2], m[3]].map(Number);
    } else return false;                          // a gradient, a pattern, a name: leave it be
    return Math.max(r, g, b) <= 0x66 && Math.max(r, g, b) - Math.min(r, g, b) <= 0x30;
  }

  const PASTE_YELLOW = [255, 242, 204];     // Docs' "light yellow 3": pasted from outside
  const PASTE_BLUE = [207, 226, 243];       // Docs' "light blue 3": copied or moved within
  const pasteBg = (kind) => (kind === 2 ? PASTE_BLUE : PASTE_YELLOW);

  /** '#rrggbb' → [r, g, b], or null. */
  function rgbOf(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : null;
  }

  /**
   * The multiply colour M that, followed by a screen by `color`, turns paper
   * into the highlight `bg` and ink into `color` (see the header).
   */
  function pasteMultiply(color, bg = PASTE_YELLOW) {
    const c = rgbOf(color);
    if (!c) return null;
    const m = c.map((v, i) => {
      const y = bg[i] / 255, k = v / 255;
      return k >= 1 ? 255 : Math.round(Math.max(0, Math.min(1, (y - k) / (1 - k))) * 255);
    });
    return `rgb(${m.join(',')})`;
  }

  const core = { placeRuns, stretchesIn, readingOrder, plainInk, pasteMultiply, PASTE_YELLOW, PASTE_BLUE, WINDOW };
  if (typeof window === 'undefined') { module.exports = core; return; }   // the tests

  // ── In the page ────────────────────────────────────────────────────────────

  const CHANNEL = 'VISOR_AWARE';
  const TILE = 'kix-canvas-tile-content';
  const BIDI = /[‪-‮⁦-⁩‎‏]/g;
  const P = window.CanvasRenderingContext2D && CanvasRenderingContext2D.prototype;
  if (!P || P.__visorAware) return;
  P.__visorAware = true;

  // What Docs has painted where, per page canvas: Map(position → run), with
  // positions in the canvas's own pixels.
  const pages = new Map();
  let data = null;            // { text, owners, colors } while AWARE is on
  const dirty = new Set();
  let frame = 0;

  const isTile = (c) => !!(c && c.classList && c.classList.contains(TILE));

  function runsOf(canvas) {
    let p = pages.get(canvas);
    // A canvas that changed size was cleared and is being painted afresh.
    if (!p || p.w !== canvas.width || p.h !== canvas.height) {
      p = { w: canvas.width, h: canvas.height, runs: new Map(), end: 0 };
      pages.set(canvas, p);
      watchPlacement(canvas);
    }
    return p.runs;
  }

  function note(ctx, text, x, y, maxWidth) {
    const t = String(text).replace(BIDI, '');
    if (!t.trim()) return;
    const m = ctx.getTransform();
    if (m.b || m.c) return;                       // rotated text: leave it be
    const size = (parseFloat((/([\d.]+)px/.exec(ctx.font) || [])[1]) || 14) * m.d;
    const run = {
      t, x: m.a * x + m.e, y: m.d * y + m.f, sx: m.a, sy: m.d, size,
      font: ctx.font, ls: ctx.letterSpacing || '0px', align: ctx.textAlign, base: ctx.textBaseline,
      plain: plainInk(ctx.fillStyle),
      maxW: typeof maxWidth === 'number' ? maxWidth : 0
    };
    runsOf(ctx.canvas).set(`${Math.round(run.x)},${Math.round(run.y)}`, run);
    touch(ctx.canvas);
  }

  /** Docs cleared or painted over an area: the text that was there is gone. */
  function erase(ctx, x, y, w, h) {
    const p = pages.get(ctx.canvas);
    if (!p) return;
    const m = ctx.getTransform();
    const x0 = m.a * x + m.e, x1 = m.a * (x + w) + m.e, y0 = m.d * y + m.f, y1 = m.d * (y + h) + m.f;
    const L = Math.min(x0, x1) - 1, R = Math.max(x0, x1) + 1, T = Math.min(y0, y1) - 1, B = Math.max(y0, y1) + 1;
    if (B - T < 6) return;                        // underlines and rules, not erasures
    for (const [k, r] of p.runs) if (r.x >= L && r.x <= R && r.y >= T && r.y <= B) p.runs.delete(k);
    touch(ctx.canvas);
  }

  const origFillText = P.fillText, origClearRect = P.clearRect, origFillRect = P.fillRect;
  P.fillText = function (text, x, y, maxWidth) {
    try { if (isTile(this.canvas)) note(this, text, x, y, maxWidth); } catch (_) { /* never in Docs' way */ }
    return origFillText.apply(this, arguments);
  };
  P.clearRect = function (x, y, w, h) {
    try { if (pages.has(this.canvas)) erase(this, x, y, w, h); } catch (_) { /* never in Docs' way */ }
    return origClearRect.apply(this, arguments);
  };
  P.fillRect = function (x, y, w, h) {
    try { if (pages.has(this.canvas)) erase(this, x, y, w, h); } catch (_) { /* never in Docs' way */ }
    return origFillRect.apply(this, arguments);
  };

  // ── The coloured layer over each page ──

  const layers = new Map();          // page canvas → { mul, scr, tint, mark } overlay canvases
  const placementWatch = new MutationObserver((list) => { for (const m of list) if (data) touch(m.target); });
  function watchPlacement(canvas) {
    try { placementWatch.observe(canvas, { attributes: true, attributeFilter: ['style', 'class'] }); } catch (_) { /* fine */ }
  }

  function layerFor(page) {
    let l = layers.get(page);
    if (l && l.mul.isConnected && l.mul.previousSibling === page && l.mark.previousSibling === l.tint) return l;
    if (l) dropLayers(l);
    const make = (blend) => {
      const o = document.createElement('canvas');
      o.className = 'visor-aware-layer';
      o.setAttribute('aria-hidden', 'true');
      o.style.cssText = `position:absolute;pointer-events:none;mix-blend-mode:${blend};margin:0;`;
      return o;
    };
    l = { mul: make('multiply'), scr: make('screen'), tint: make('lighten'), mark: make('normal') };
    page.after(l.mul, l.scr, l.tint, l.mark);
    layers.set(page, l);
    return l;
  }
  const dropLayers = (l) => { l.mul.remove(); l.scr.remove(); l.tint.remove(); l.mark.remove(); };

  /** Exactly over the page canvas: same parent, same box, same pixels. */
  function place(page, o) {
    if (o.width !== page.width) o.width = page.width;
    if (o.height !== page.height) o.height = page.height;
    const cs = getComputedStyle(page);
    o.style.left = `${page.offsetLeft}px`;
    o.style.top = `${page.offsetTop}px`;
    o.style.width = `${page.offsetWidth}px`;
    o.style.height = `${page.offsetHeight}px`;
    o.style.transform = cs.transform === 'none' ? '' : cs.transform;
    o.style.transformOrigin = cs.transformOrigin;
    if (cs.zIndex !== 'auto') o.style.zIndex = cs.zIndex;
  }

  const measure = document.createElement('canvas').getContext('2d');

  const css = (rgb) => `rgb(${rgb.join(',')})`;
  const mulCache = new Map();
  function paintRun(L, r, at) {
    const { tint: g, mark: u, mul, scr } = L;
    const stretches = stretchesIn(data.owners, at, r.t.length);
    if (!stretches.length) return;
    measure.font = r.font;
    try { measure.letterSpacing = r.ls; } catch (_) { /* older Chrome */ }
    const full = measure.measureText(r.t);
    const squeeze = r.maxW && full.width > r.maxW ? r.maxW / full.width : 1;
    const k = squeeze * r.sx;
    const asc = full.fontBoundingBoxAscent || r.size / r.sy * .8;
    const desc = full.fontBoundingBoxDescent || r.size / r.sy * .25;
    let x0 = r.x;
    if (r.align === 'center') x0 -= full.width * k / 2;
    else if (r.align === 'right' || r.align === 'end') x0 -= full.width * k;
    let top = r.y - asc * r.sy;                    // alphabetic baseline, Docs' default
    if (r.base === 'top' || r.base === 'hanging') top = r.y;
    else if (r.base === 'middle') top = r.y - (asc + desc) * r.sy / 2;
    else if (r.base === 'bottom' || r.base === 'ideographic') top = r.y - (asc + desc) * r.sy;
    const h = (asc + desc) * r.sy;
    for (const [from, to, c, pasted] of stretches) {
      const color = data.colors[c];
      if (!color) continue;
      const a = from ? measure.measureText(r.t.slice(0, from)).width : 0;
      const b = to === r.t.length ? full.width : measure.measureText(r.t.slice(0, to)).width;
      const X = x0 + a * k, Wd = (b - a) * k + .6;
      const bg = pasted ? pasteBg(pasted) : null;
      if (r.plain && pasted) {
        // pasted: paper to the highlight, ink to the author's colour (two layers)
        const key = `${color}|${pasted}`;
        if (!mulCache.has(key)) mulCache.set(key, pasteMultiply(color, bg));
        mul.fillStyle = mulCache.get(key) || css(bg);
        origFillRect.call(mul, X, top, Wd, h);
        scr.fillStyle = color;
        origFillRect.call(scr, X, top, Wd, h);
      } else if (r.plain) {
        g.fillStyle = color;
        origFillRect.call(g, X, top, Wd, h);
      } else {
        // coloured text keeps its colour; a line under it in the author's,
        // and the highlight behind it if it was pasted
        if (pasted) { mul.fillStyle = css(bg); origFillRect.call(mul, X, top, Wd, h); }
        u.fillStyle = color;
        origFillRect.call(u, x0 + a * k, r.y + desc * r.sy * .45, (b - a) * k, Math.max(2, 1.6 * r.sy));
      }
    }
  }

  function paint(page, hint) {
    const p = pages.get(page);
    const l = layerFor(page);
    const ctx = (o) => {
      place(page, o);
      const g = o.getContext('2d');
      g.setTransform(1, 0, 0, 1, 0, 0);
      origClearRect.call(g, 0, 0, o.width, o.height);
      return g;
    };
    const L = { mul: ctx(l.mul), scr: ctx(l.scr), tint: ctx(l.tint), mark: ctx(l.mark) };
    const runs = readingOrder([...p.runs.values()]);
    const at = placeRuns(runs.map((r) => r.t), data.text, hint);
    let end = hint;
    runs.forEach((r, i) => { if (at[i] >= 0) { paintRun(L, r, at[i]); end = Math.max(end, at[i] + r.t.length); } });
    p.end = end;
  }

  function touch(canvas) {
    if (!data) return;
    dirty.add(canvas);
    if (!frame) frame = requestAnimationFrame(flush);
  }

  function flush() {
    frame = 0;
    if (!data) { dirty.clear(); return; }
    // Pages in document order, so each can start looking where the last ended.
    let hint = 0;
    for (const page of document.getElementsByClassName(TILE)) {
      const p = pages.get(page);
      if (!p) continue;
      if (dirty.has(page)) { try { paint(page, hint); } catch (_) { /* leave this page as Docs drew it */ } }
      hint = p.end || hint;
    }
    dirty.clear();
    // Forget pages Docs has thrown away.
    for (const page of [...pages.keys()]) {
      if (!page.isConnected) { const l = layers.get(page); if (l) dropLayers(l); pages.delete(page); layers.delete(page); }
    }
  }

  function off() {
    data = null;
    dirty.clear();
    for (const l of layers.values()) dropLayers(l);
    layers.clear();
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== CHANNEL) return;
    const d = e.data;
    const text = typeof d.text === 'string' ? d.text : data && data.text;
    if (!d.on || typeof text !== 'string' || !Array.isArray(d.owners) || !Array.isArray(d.colors)) { off(); return; }
    data = { text, owners: d.owners, colors: d.colors };
    for (const page of pages.keys()) touch(page);
  });
})();
