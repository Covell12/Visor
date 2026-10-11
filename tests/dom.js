/* ============================================================================
 * A DOM small enough to run content.js in node.
 * ----------------------------------------------------------------------------
 * Only what Visor's injected UI actually touches: ids, classes, a parent/child
 * tree, click listeners and the handful of window globals the script reads at
 * load. Timers are manual, so a test can say "thirty seconds pass" without
 * waiting thirty seconds.
 * ==========================================================================*/

'use strict';

function makeDom({ autoIds = false } = {}) {
  const byId = new Map();

  class ClassList {
    constructor(el) { this.el = el; this.set = new Set(); }
    add(...c) { c.forEach((x) => this.set.add(x)); }
    remove(...c) { c.forEach((x) => this.set.delete(x)); }
    contains(c) { return this.set.has(c); }
    toggle(c, f) {
      const on = f === undefined ? !this.set.has(c) : !!f;
      on ? this.set.add(c) : this.set.delete(c);
      return on;
    }
    get value() { return [...this.set].join(' '); }
  }

  const detach = (el) => {
    if (!el || !el.parentElement) return;
    const sibs = el.parentElement.children;
    const i = sibs.indexOf(el);
    if (i >= 0) sibs.splice(i, 1);
    el.parentElement = null;
  };

  class El {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase();
      this.nodeType = 1;
      this.children = [];
      this.parentElement = null;
      this.classList = new ClassList(this);
      this.attrs = new Map();
      this.style = { setProperty() {}, removeProperty() {} };
      this.dataset = {};
      this._listeners = new Map();
      this._id = '';
      this._html = '';
      this._text = '';
    }
    get id() { return this._id; }
    set id(v) { this._id = v; if (v) byId.set(v, this); }
    get className() { return this.classList.value; }
    set className(v) { this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean)); }
    setAttribute(k, v) { this.attrs.set(k, String(v)); if (k === 'id') this.id = v; }
    getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
    removeAttribute(k) { this.attrs.delete(k); }
    get innerHTML() { return this._html; }
    set innerHTML(v) { this._html = String(v); this.children = parseChildren(String(v), this); }
    // As in a real DOM: reading concatenates the subtree, and writing replaces
    // it — including `textContent = ''`, which is how code empties a node.
    get textContent() {
      return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text;
    }
    set textContent(v) {
      this.children.forEach((c) => { c.parentElement = null; });
      this.children = [];
      this._html = '';
      this._text = String(v);
    }
    // Inserting a node that already has a parent moves it, as in a real DOM.
    appendChild(el) {
      if (el._frag) { el.children.slice().forEach((c) => this.appendChild(c)); return el; }
      detach(el); el.parentElement = this; this.children.push(el); return el;
    }
    insertBefore(el, ref) {
      if (el._frag) {
        el.children.slice().forEach((c) => this.insertBefore(c, ref));
        return el;
      }
      detach(el);
      el.parentElement = this;
      const i = ref ? this.children.indexOf(ref) : -1;
      i < 0 ? this.children.push(el) : this.children.splice(i, 0, el);
      return el;
    }
    get isConnected() {
      let n = this;
      while (n.parentElement) n = n.parentElement;
      return n === body || n === document.documentElement;
    }
    get nextElementSibling() { return this.nextSibling; }
    get previousElementSibling() { return this.previousSibling; }
    get nextSibling() {
      const sibs = this.parentElement ? this.parentElement.children : [];
      return sibs[sibs.indexOf(this) + 1] || null;
    }
    get previousSibling() {
      const sibs = this.parentElement ? this.parentElement.children : [];
      return sibs[sibs.indexOf(this) - 1] || null;
    }
    get firstChild() { return this.children[0] || null; }
    get childNodes() { return this.children; }
    removeChild(el) {
      const i = this.children.indexOf(el);
      if (i >= 0) this.children.splice(i, 1);
      el.parentElement = null;
      return el;
    }
    remove() {
      if (this.parentElement) this.parentElement.removeChild(this);
      if (this._id && byId.get(this._id) === this) byId.delete(this._id);
    }
    get all() { return this.children.flatMap((c) => [c, ...c.all]); }
    matches(sel) {
      return sel.split(',').map((s) => s.trim()).some((s) => {
        if (s.startsWith('.')) return this.classList.contains(s.slice(1));
        if (s.startsWith('#')) return this._id === s.slice(1);
        if (s.startsWith('[')) {
          const [, k, v] = /\[([^=\]]+)(?:="([^"]*)")?\]/.exec(s) || [];
          return k ? (v === undefined ? this.attrs.has(k) : this.attrs.get(k) === v) : false;
        }
        return this.tagName === s.toUpperCase();
      });
    }
    querySelector(sel) { return this.all.find((e) => e.matches(sel)) || null; }
    querySelectorAll(sel) { return this.all.filter((e) => e.matches(sel)); }
    closest(sel) {
      let n = this;
      while (n) { if (n.matches && n.matches(sel)) return n; n = n.parentElement; }
      return null;
    }
    addEventListener(type, fn, opts) {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type).push(fn);
      // Honour AbortSignal: code that cleans up after itself must be seen to.
      if (opts && opts.signal) opts.signal.addEventListener('abort', () => this.removeEventListener(type, fn));
    }
    listenerCount(type) { return (this._listeners.get(type) || []).length; }
    removeEventListener(type, fn) {
      const l = this._listeners.get(type) || [];
      const i = l.indexOf(fn);
      if (i >= 0) l.splice(i, 1);
    }
    fire(type, ev = {}) {
      const e = { type, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...ev };
      (this._listeners.get(type) || []).forEach((fn) => fn(e));
    }
    /* Serialise back to HTML. A node whose innerHTML was written keeps that
     * string verbatim, so what comes out is what the product wrote. */
    serialize() {
      const attrs = [...this.attrs].filter(([k]) => k !== 'id').map(([k, v]) => ` ${k}="${v}"`).join('');
      const cls = this.classList.value ? ` class="${this.classList.value}"` : '';
      const id = this._id ? ` id="${this._id}"` : '';
      const inner = this.children.length
        ? this.children.map((c) => c.serialize()).join('')
        : (this._html || this._text);
      const tag = this.tagName.toLowerCase();
      return `<${tag}${id}${cls}${attrs.replace(/ class="[^"]*"/, '')}>${inner}</${tag}>`;
    }
    get innerSerialized() {
      return this.children.length
        ? this.children.map((c) => c.serialize()).join('')
        : (this._html || this._text);
    }
    /* Tests that care about geometry set `rect`; everything else gets a
     * plausible default. */
    set rect(r) { this._rect = { left: 0, top: 0, width: 200, height: 40, ...r }; }
    getBoundingClientRect() {
      const r = this._rect || { left: 0, top: 0, width: 200, height: 40 };
      return { ...r, right: r.left + r.width, bottom: r.top + r.height };
    }
    scrollIntoView() {}
    focus() {}
  }

  // Elements the script later looks up by class or id must exist as nodes, so
  // innerHTML is parsed just far enough to create them.
  function parseChildren(html, parent) {
    const out = [];
    const re = /<(\w[\w-]*)([^>]*)>/g;
    const stack = [];
    let m;
    while ((m = re.exec(html))) {
      const [, tag, rawAttrs] = m;
      if (rawAttrs.trim().startsWith('/')) continue;
      const el = new El(tag);
      for (const a of rawAttrs.matchAll(/([\w-]+)="([^"]*)"/g)) {
        el.setAttribute(a[1], a[2]);
        if (a[1] === 'class') el.className = a[2];
        if (a[1].startsWith('data-')) el.dataset[a[1].slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = a[2];
      }
      const host = stack.length ? stack[stack.length - 1] : parent;
      el.parentElement = host;
      (host === parent ? out : host.children).push(el);
      if (!/\/>$/.test(m[0]) && !['img', 'br', 'input', 'path', 'stop'].includes(tag)) stack.push(el);
      const close = new RegExp(`</${tag}>`, 'g');
      close.lastIndex = re.lastIndex;
      const c = close.exec(html);
      if (c) {
        const after = html.slice(re.lastIndex, c.index);
        if (!/[<]/.test(after)) { el._text = after.trim(); stack.pop(); }
      }
    }
    return out;
  }

  const body = new El('body');
  body.id = '__body';
  const docListeners = new Map();

  const document = {
    body,
    title: 'Test document',
    hidden: false,
    visibilityState: 'visible',
    documentElement: new El('html'),
    createElement: (t) => new El(t),
    // Good enough for code that batches nodes before inserting them: a plain
    // element whose children are spliced into the parent on insert.
    createDocumentFragment: () => {
      const f = new El('#fragment');
      f._frag = true;
      return f;
    },
    createTreeWalker: () => ({ nextNode: () => null }),
    createRange: () => ({
      setStart() {}, setEnd() {},
      getClientRects: () => [],
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1, height: 16 })
    }),
    getElementById: (id) => {
      if (!byId.has(id) && autoIds) { const el = new El('div'); el.id = id; body.appendChild(el); }
      return byId.get(id) || null;
    },
    querySelector: (s) => body.querySelector(s),
    querySelectorAll: (s) => body.querySelectorAll(s),
    addEventListener(t, fn) { if (!docListeners.has(t)) docListeners.set(t, []); docListeners.get(t).push(fn); },
    removeEventListener() {}
  };

  // ── Manual clocks ──────────────────────────────────────────────────────────
  const timers = [];   // { at, fn, every }
  let now = 0;
  const clock = {
    get now() { return now; },
    advance(ms) {
      const end = now + ms;
      for (let guard = 0; guard < 10000; guard++) {
        const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        now = due.at;
        if (due.every) due.at += due.every; else timers.splice(timers.indexOf(due), 1);
        due.fn();
      }
      now = end;
    }
  };

  // Date.now() has to follow the test's clock too: code that schedules itself
  // by wall time would otherwise never come round again.
  const epoch = Date.UTC(2026, 8, 25, 9, 0, 0);
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [epoch + now])); }
    static now() { return epoch + now; }
  }

  const winListeners = new Map();

  const win = {
    document,
    location: { href: 'https://docs.google.com/document/d/DOC1/edit', pathname: '/document/d/DOC1/edit' },
    setTimeout: (fn, ms = 0) => { timers.push({ at: now + ms, fn }); return timers.length; },
    clearTimeout: () => {},
    setInterval: (fn, ms = 1) => { timers.push({ at: now + ms, fn, every: Math.max(1, ms) }); return timers.length; },
    clearInterval: () => {},
    requestAnimationFrame: (fn) => { timers.push({ at: now + 16, fn }); return 1; },
    cancelAnimationFrame: () => {},
    // Window listeners are recorded too — a leak there is just as real as one
    // on an element, and a no-op stub is how the last one went unnoticed.
    addEventListener(type, fn, opts) {
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type).push(fn);
      if (opts && opts.signal) opts.signal.addEventListener('abort', () => win.removeEventListener(type, fn));
    },
    removeEventListener(type, fn) {
      const l = winListeners.get(type) || [];
      const i = l.indexOf(fn);
      if (i >= 0) l.splice(i, 1);
    },
    listenerCount: (type) => (winListeners.get(type) || []).length,
    getComputedStyle: () => ({ backgroundColor: 'rgb(255, 255, 255)', color: 'rgb(0, 0, 0)' }),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    // Records what it was told to watch, and exposes __fire() so a test can
    // say "the page changed" without a real DOM behind it.
    MutationObserver: class {
      constructor(fn) { this.fn = fn; this.targets = []; }
      observe(el) { this.targets.push(el); }
      disconnect() { this.targets = []; }
      __fire() { this.fn([{ type: 'childList', target: this.targets[0] }], this); }
    },
    AbortController: class {
      constructor() {
        const on = [];
        this.signal = {
          aborted: false,
          addEventListener(t, fn) { if (t === 'abort') on.push(fn); }
        };
        this._fire = () => { if (!this.signal.aborted) { this.signal.aborted = true; on.slice().forEach((f) => f()); } };
      }
      abort() { this._fire(); }
    },
    URL, URLSearchParams, Map, Set, JSON, Math, Date: FakeDate, Object, Array, String, Number,
    Boolean, RegExp, Error, Promise, console, isFinite, parseInt, parseFloat, encodeURIComponent,
    performance: { now: () => now }
  };
  win.window = win;
  win.self = win;
  win.globalThis = win;

  return { win, document, body, El, clock, byId };
}

module.exports = { makeDom };
