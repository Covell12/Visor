/* Visor Classroom — the Docs-style menu bar, toolbar, dialogs, find panel and
   outline for the writing editor.

   window.DocsUI = { mount, update, openFind, close, unmount } (plus openLink,
   openWordCount, openSpecialChars, openAltText, openShortcuts, isOpen).
   It never touches Quill: every action goes through opts.exec(command, value),
   and everything it shows comes from the state the writer passes to update()
   and from the mount callbacks. Toolbar and menu clicks never take focus from
   the editor (mousedown → preventDefault, except on inputs).

   Menus and popovers live in one fixed layer on <body>, so nothing clips them;
   the find panel sits inside the canvas, top right. */

'use strict';

(function () {
  /* ====================== constants ====================== */
  const DF = window.VisorDocFormat || {};
  const FONTS = DF.FONTS || ['Arial', 'Times New Roman', 'Georgia', 'Garamond', 'Courier New', 'Verdana', 'Trebuchet MS', 'Comic Sans MS'];
  const SIZES = DF.SIZES || ['8pt', '9pt', '10pt', '11pt', '12pt', '14pt', '16pt', '18pt', '24pt', '30pt', '36pt', '48pt', '60pt', '72pt'];
  const DOC_STYLES = DF.DOC_STYLES || {
    mla: { label: 'MLA essay', font: 'Times New Roman', size: '12pt', lineheight: '2' },
    docs: { label: 'Docs default', font: 'Arial', size: '11pt', lineheight: '1.15' }
  };
  const MAC = /Mac/i.test(navigator.platform || '');   // the same test Quill uses for its shortcut key

  const FONT_STACK = {
    'Arial': 'Arial, Arimo, Helvetica, sans-serif',
    'Times New Roman': '"Times New Roman", Tinos, Times, serif',
    'Georgia': 'Georgia, Gelasio, serif',
    'Garamond': 'Garamond, "EB Garamond", "Times New Roman", serif',
    'Courier New': '"Courier New", Cousine, Courier, monospace',
    'Verdana': 'Verdana, "DejaVu Sans", sans-serif',
    'Trebuchet MS': '"Trebuchet MS", "Fira Sans", sans-serif',
    'Comic Sans MS': '"Comic Sans MS", "Comic Neue", "Comic Sans", cursive'
  };
  const fontStack = name => FONT_STACK[name] || `"${String(name).replace(/["\\]/g, '')}", sans-serif`;

  const ZOOMS = [0.5, 0.75, 0.9, 1, 1.25, 1.5, 2];
  const STYLES = [
    { v: 'normal', label: 'Normal text' }, { v: 'title', label: 'Title' }, { v: 'subtitle', label: 'Subtitle' },
    { v: 'h1', label: 'Heading 1' }, { v: 'h2', label: 'Heading 2' }, { v: 'h3', label: 'Heading 3' }
  ];
  const STYLE_PT = { title: 26, subtitle: 15, h1: 20, h2: 16, h3: 14 };
  const SPACINGS = [['1', 'Single'], ['1.15', '1.15'], ['1.5', '1.5'], ['2', 'Double']];
  const ALIGNS = [
    { v: null, label: 'Left', icon: 'alignLeft', sc: 'mod+shift+l' },
    { v: 'center', label: 'Center', icon: 'alignCenter', sc: 'mod+shift+e' },
    { v: 'right', label: 'Right', icon: 'alignRight', sc: 'mod+shift+r' },
    { v: 'justify', label: 'Justified', icon: 'alignJustify', sc: 'mod+shift+j' }
  ];
  const IMAGE_FULL = 624;   // a full-width image on the letter page, in px
  const IMG_SIZES = [['small', 'Small', 0.25], ['medium', 'Medium', 0.5], ['large', 'Large', 0.75], ['full', 'Full width', 1]];
  const GRID_COLS = 8, GRID_ROWS = 10;

  // Docs-like colours: greys, brights, then three lighter and one darker shade of each
  const PALETTE = [
    ['#000000', '#434343', '#666666', '#999999', '#b7b7b7', '#cccccc', '#d9d9d9', '#efefef', '#f3f3f3', '#ffffff'],
    ['#980000', '#ff0000', '#ff9900', '#ffff00', '#00ff00', '#00ffff', '#4a86e8', '#0000ff', '#9900ff', '#ff00ff'],
    ['#e6b8af', '#f4cccc', '#fce5cd', '#fff2cc', '#d9ead3', '#d0e0e3', '#c9daf8', '#cfe2f3', '#d9d2e9', '#ead1dc'],
    ['#dd7e6b', '#ea9999', '#f9cb9c', '#ffe599', '#b6d7a8', '#a2c4c9', '#a4c2f4', '#9fc5e8', '#b4a7d6', '#d5a6bd'],
    ['#cc4125', '#e06666', '#f6b26b', '#ffd966', '#93c47d', '#76a5af', '#6d9eeb', '#6fa8dc', '#8e7cc3', '#c27ba0'],
    ['#a61c00', '#cc0000', '#e69138', '#f1c232', '#6aa84f', '#45818e', '#3c78d8', '#3d85c6', '#674ea7', '#a64d79']
  ];
  const GREYS = ['black', 'dark gray 4', 'dark gray 3', 'dark gray 2', 'dark gray 1', 'gray', 'light gray 1', 'light gray 2', 'light gray 3', 'white'];
  const HUES = ['red berry', 'red', 'orange', 'yellow', 'green', 'cyan', 'cornflower blue', 'blue', 'purple', 'magenta'];
  const SHADES = ['', 'light 3', 'light 2', 'light 1', 'dark 1'];
  const colorName = (r, i) => r === 0 ? GREYS[i] : r === 1 ? HUES[i] : `${SHADES[r - 1]} ${HUES[i]}`;

  const SPECIAL = [
    ['Punctuation', '— – … “ ” ‘ ’ « » • ¿ ¡'],
    ['Math', '± × ÷ ≈ ≠ ≤ ≥ ∞ √ π °'],
    ['Arrows', '← → ↑ ↓'],
    ['Accented letters', 'á é í ó ú ñ ü ç à è ê ö Á É Í Ó Ú Ñ Ü Ç'],
    ['Greek', 'α β γ δ θ λ μ σ Σ Δ Ω'],
    ['Other', '© ® ™ § ¶ €']
  ];
  const CHAR_NAMES = {
    '—': 'Em dash', '–': 'En dash', '…': 'Ellipsis', '“': 'Left double quote', '”': 'Right double quote',
    '‘': 'Left single quote', '’': 'Right single quote (apostrophe)', '«': 'Left angle quote', '»': 'Right angle quote',
    '•': 'Bullet', '¿': 'Inverted question mark', '¡': 'Inverted exclamation mark', '±': 'Plus or minus', '×': 'Times',
    '÷': 'Divided by', '≈': 'Almost equal to', '≠': 'Not equal to', '≤': 'Less than or equal to', '≥': 'Greater than or equal to',
    '∞': 'Infinity', '√': 'Square root', 'π': 'Pi', '°': 'Degree', '←': 'Left arrow', '→': 'Right arrow', '↑': 'Up arrow',
    '↓': 'Down arrow', '©': 'Copyright', '®': 'Registered', '™': 'Trademark', '§': 'Section', '¶': 'Paragraph', '€': 'Euro'
  };

  /* ====================== icons: 24-unit grid, 2px strokes, drawn at 18px ====================== */
  const BAR = '<rect class="dui-bar" x="3" y="18.5" width="18" height="4" rx="1"/>';
  const P = {
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
    redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
    print: '<path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 9V3h12v6"/><rect x="6" y="14" width="12" height="8" rx="1"/>',
    bold: '<path d="M7 12h7a4 4 0 0 1 0 8H7V4h6a4 4 0 0 1 0 8" stroke-width="2.6"/>',
    italic: '<path d="M19 4h-9M14 20H5M15 4 9 20"/>',
    underline: '<path d="M6 4v6a6 6 0 0 0 12 0V4"/><path d="M4 21h16"/>',
    strike: '<path d="M16 4H9a3 3 0 0 0-2.83 4"/><path d="M14 12a4 4 0 0 1 0 8H6"/><path d="M4 12h16"/>',
    sup: '<path d="m4 19 8-8M12 19l-8-8"/><path d="M20 12h-4c0-1.5.44-2 1.5-2.5S20 8.33 20 7c0-.47-.17-.93-.48-1.29a2.11 2.11 0 0 0-2.62-.44c-.42.24-.74.62-.9 1.07"/>',
    sub: '<path d="m4 5 8 8M12 5l-8 8"/><path d="M20 19h-4c0-1.5.44-2 1.5-2.5S20 15.33 20 14c0-.47-.17-.93-.48-1.29a2.11 2.11 0 0 0-2.62-.44c-.42.24-.74.62-.9 1.07"/>',
    textColor: '<path d="m6.5 15 5.5-12 5.5 12"/><path d="M8.6 10.5h6.8"/>' + BAR,
    highlight: '<path d="m15 3 4.5 4.5-8 8H7v-4.5z"/><path d="m12.5 5.5 4 4"/><path d="M7 15.5 5 17.5"/>' + BAR,
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/>',
    table: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M12 3v18"/>',
    alignLeft: '<path d="M21 6H3M15 12H3M17 18H3"/>',
    alignCenter: '<path d="M21 6H3M17 12H7M19 18H5"/>',
    alignRight: '<path d="M21 6H3M21 12H9M21 18H7"/>',
    alignJustify: '<path d="M3 6h18M3 12h18M3 18h18"/>',
    lineSpacing: '<path d="m3 7 3-3 3 3M6 4v16M3 17l3 3 3-3"/><path d="M13 6h8M13 12h8M13 18h8"/>',
    checklist: '<rect x="3" y="4" width="6" height="6" rx="1"/><path d="m3 17 2 2 4-4"/><path d="M13 7h8M13 17h8"/>',
    bullets: '<path d="M9 6h12M9 12h12M9 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01" stroke-width="3"/>',
    numbered: '<path d="M10 6h11M10 12h11M10 18h11"/><path d="M4 6h1v4M4 10h2"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/>',
    indentLess: '<path d="m7 8-4 4 4 4"/><path d="M21 12H11M21 6H11M21 18H11"/>',
    indentMore: '<path d="m3 8 4 4-4 4"/><path d="M21 12H11M21 6H11M21 18H11"/>',
    clear: '<path d="M4 7V4h16v3M5 20h6M13 4 8 20"/><path d="m15 15 5 5M20 15l-5 5"/>',
    more: '<circle cx="12" cy="5" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="19" r="1" fill="currentColor"/>',
    caret: '<path d="m8 10 4 4 4-4"/>',
    chevRight: '<path d="m9 18 6-6-6-6"/>',
    up: '<path d="m18 15-6-6-6 6"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    minus: '<path d="M5 12h14"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/>',
    replace: '<path d="M14 4a2 2 0 0 1 2-2M16 10a2 2 0 0 1-2-2M20 2a2 2 0 0 1 2 2M22 8a2 2 0 0 1-2 2"/><path d="m3 7 3 3 3-3"/><path d="M6 10V5a3 3 0 0 1 3-3h1"/><rect x="2" y="14" width="8" height="8" rx="2"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5M12 3v12"/>',
    cut: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M8.12 8.12 12 12M20 4 8.12 15.88M14.8 14.8 20 20"/>',
    copy: '<rect x="8" y="8" width="14" height="14" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    paste: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
    selectAll: '<path d="M5 3a2 2 0 0 0-2 2M19 3a2 2 0 0 1 2 2M21 19a2 2 0 0 1-2 2M5 21a2 2 0 0 1-2-2M9 3h1M9 21h1M14 3h1M14 21h1M3 9v1M21 9v1M3 14v1M21 14v1"/>',
    outline: '<path d="M21 12h-8M21 6H8M21 18h-8"/><path d="M3 6v4c0 1.1.9 2 2 2h3M3 10v6c0 1.1.9 2 2 2h3"/>',
    pageBreak: '<path d="M5 9V4a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v5M5 15v5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5"/><path d="M3 12h2M8 12h2M14 12h2M19 12h2"/>',
    zoom: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35M11 8v6M8 11h6"/>',
    omega: '<path d="M3 20h4.5a.5.5 0 0 0 .5-.5v-.28a.52.52 0 0 0-.25-.44 8 8 0 1 1 8.5 0 .52.52 0 0 0-.25.44v.28a.5.5 0 0 0 .5.5H21"/>',
    quote: '<path d="M10 11H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v5c0 3-1.5 5-4 6"/><path d="M19 11h-4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v5c0 3-1.5 5-4 6"/>',
    book: '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>',
    wordCount: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
    spell: '<path d="m4 15 5-11 5 11M5.8 11h6.4"/><path d="m14 19 2.5 2.5L22 16"/>',
    keyboard: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M8 13h.01M12 13h.01M16 13h.01M7 16h10"/>',
    external: '<path d="M15 3h6v6M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    unlink: '<path d="m18.84 12.25 1.72-1.71a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="m5.17 11.75-1.71 1.71a5 5 0 0 0 7.07 7.07l1.71-1.71"/><path d="M8 2v3M2 8h3M16 19v3M19 16h3"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20M2 12h20"/>',
    text: '<path d="M4 7V4h16v3M9 20h6M12 4v16"/>',
    pilcrow: '<path d="M13 4v16M17 4v16M19 4H9.5a4.5 4.5 0 0 0 0 9H13"/>',
    rowAbove: '<rect x="3" y="12" width="18" height="9" rx="2"/><path d="M12 3v6M9 6h6"/>',
    rowBelow: '<rect x="3" y="3" width="18" height="9" rx="2"/><path d="M12 15v6M9 18h6"/>',
    colLeft: '<rect x="12" y="3" width="9" height="18" rx="2"/><path d="M3 12h6M6 9v6"/>',
    colRight: '<rect x="3" y="3" width="9" height="18" rx="2"/><path d="M15 12h6M18 9v6"/>',
    delRow: '<rect x="3" y="7" width="18" height="10" rx="2"/><path d="m10 10 4 4M14 10l-4 4"/>',
    delCol: '<rect x="7" y="3" width="10" height="18" rx="2"/><path d="m10 10 4 4M14 10l-4 4"/>',
    trash: '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
    alt: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="m6 15 2.5-6 2.5 6M6.8 13.2h3.4M14 9v6h3.5"/>',
    none: '<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>'
  };
  const ic = (name, cls) => `<svg class="dui-i${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${P[name] || ''}</svg>`;

  /* ====================== small helpers ====================== */
  const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function setAttr(e, k, v) { if (!e) return; const s = v == null || v === false ? null : String(v); if (e.getAttribute(k) !== s) { if (s == null) e.removeAttribute(k); else e.setAttribute(k, s); } }
  function setText(e, t) { if (e && e.textContent !== t) e.textContent = t; }
  function setCls(e, c, on) { if (e && e.classList.contains(c) !== !!on) e.classList.toggle(c, !!on); }
  const isField = t => !!(t && t.closest && t.closest('input, textarea, select, label'));
  const say = (m, k) => { if (typeof window.toast === 'function') window.toast(m, k); };
  const VW = () => document.documentElement.clientWidth || innerWidth;   // the width without the scroll bar
  const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode: not remembered */ } };

  // "mod+shift+z" → "⌘⇧Z" on a Mac, "Ctrl+Shift+Z" elsewhere
  function scText(sc) {
    if (!sc) return '';
    const parts = sc.split('+'); let key = parts.pop();
    if (key === '') key = '+';
    key = key.length === 1 ? key.toUpperCase() : key;
    if (MAC) return parts.map(p => ({ mod: '⌘', shift: '⇧', alt: '⌥', ctrl: '⌃' }[p] || '')).join('') + key;
    return parts.map(p => ({ mod: 'Ctrl', shift: 'Shift', alt: 'Alt', ctrl: 'Ctrl' }[p] || p)).concat(key).join('+');
  }
  const tipText = (label, sc) => sc ? `${label} (${scText(sc)})` : label;

  /* ====================== state ====================== */
  let M = null;              // the mounted UI, or null
  let S = {};                // the writer's state (merged from every update)
  const stack = [];          // open menus and popovers, bottom first
  let hoverT = 0, hoverOwner = null, lastPt = '', rafPos = 0, rafBub = 0, tipT = 0, tipFor = null, tipAt = 0;
  let keyFromEditor = false;   // the menu a shortcut just closed had been opened from the essay

  const F = () => (S.formats && typeof S.formats === 'object') ? S.formats : {};
  const one = v => Array.isArray(v) ? undefined : v;       // one value, or undefined when the range is mixed
  const first = v => Array.isArray(v) ? v[0] : v;
  const can = () => S.canEdit !== false;
  const docDef = () => DOC_STYLES[S.docStyle] || DOC_STYLES.mla;
  function curStyle() {
    const f = F();
    if (first(f.title)) return 'title';
    if (first(f.subtitle)) return 'subtitle';
    const hd = Number(first(f.header));
    return hd ? 'h' + hd : 'normal';
  }
  function styleLabel(short) {
    const s = curStyle(), hit = STYLES.find(x => x.v === s);
    if (short) return s === 'normal' ? 'Normal' : /^h\d$/.test(s) ? s.toUpperCase() : hit ? hit.label : s;
    return hit ? hit.label : 'Heading ' + s.slice(1);
  }
  function fontName() {
    const v = F().font;
    if (Array.isArray(v)) return '';
    return v ? String(v).replace(/["']/g, '') : docDef().font;
  }
  function sizeValue() {
    const v = F().size;
    if (Array.isArray(v)) return '';
    if (v) return String(parseFloat(v) || '');
    const st = curStyle();
    return String(STYLE_PT[st] || parseFloat(docDef().size));
  }
  const curAlign = () => one(F().align) || null;
  const curLH = () => String(one(F().lineheight) || docDef().lineheight);
  const curList = () => one(F().list);
  function zoomFactor(z) {
    if (z === 'fit') return 'fit';
    const n = Number(z);
    if (!isFinite(n) || n <= 0) return 1;
    return n > 4 ? n / 100 : n;   // accept 125 as well as 1.25
  }
  function zoomLabel() { const z = zoomFactor(S.zoom); return z === 'fit' ? 'Fit' : Math.round(z * 100) + '%'; }
  // The word count chip: "1,219 words", or "4 of 1,219 words" with text selected
  // (from state.words; older writers only send wordsLabel)
  function wordsText() {
    const w = S.words;
    const total = w && typeof w === 'object' ? Number(w.total) : NaN;
    if (!isFinite(total) || total < 0) return String(S.wordsLabel || '');
    const sel = w.selection == null || !isFinite(Number(w.selection)) ? null : Math.max(0, Number(w.selection));
    const unit = total === 1 ? 'word' : 'words';
    return sel == null ? `${total.toLocaleString()} ${unit}` : `${sel.toLocaleString()} of ${total.toLocaleString()} ${unit}`;
  }
  function nearestSize(n) {
    let best = SIZES[0], d = Infinity;
    for (const s of SIZES) { const dd = Math.abs(parseFloat(s) - n); if (dd < d || (dd === d && parseFloat(s) > parseFloat(best))) { d = dd; best = s; } }
    return best;
  }
  function cleanLink(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    if (typeof DF.cleanValue === 'function') { const v = DF.cleanValue('link', s); return typeof v === 'string' ? v : null; }
    return /^(https?:|mailto:)/i.test(s) ? s : 'https://' + s;
  }

  /* ====================== talking to the writer ====================== */
  function call(name, ...args) {
    const f = M && M.opts[name];
    if (typeof f !== 'function') return undefined;
    try { return f(...args); } catch (e) { console.error('[DocsUI] ' + name, e); return undefined; }
  }
  function run(cmd, value) {
    const f = M && M.opts.exec;
    if (typeof f !== 'function') return false;
    try { return f(cmd, value); } catch (e) { console.error('[DocsUI] exec ' + cmd, e); return false; }
  }
  function editorFocused() { const a = document.activeElement; return !!(a && a.closest && a.closest('.ql-editor')); }
  function refocus() { if (M && !editorFocused()) run('focus'); }
  // Run a command with the editor's selection in place, then give the editor its focus back
  function act(cmd, value, o) {
    if (!M) return false;
    if (!editorFocused()) run('focus');
    const r = run(cmd, value);
    if (!(o && o.keep)) refocus();
    return r;
  }
  // View settings: show the change at once; the writer's next update() confirms it
  function setView(cmd, key, value) {
    const r = act(cmd, value);
    if (r !== false && M) { S[key] = value; renderAll(); }
  }
  function sourcesList() { const l = call('sources'); return Array.isArray(l) ? l : []; }
  function modalOpen() { const r = document.getElementById('modalRoot'); return !!(r && r.firstElementChild); }
  function myDialogOpen() { return !!document.querySelector('#modalRoot .dui-dlg'); }
  function insertCite(id) { if (!editorFocused()) run('focus'); call('insertCitation', id); refocus(); }
  function doImage() {
    if (!can()) return;
    closeAll();
    if (typeof M.opts.uploadImage === 'function') call('uploadImage');
    else run('image');
  }

  /* ====================== menus: what they hold ====================== */
  const SEP = { sep: true };
  const isOn = it => !(it.edits && !can()) && (!it.enabled || !!it.enabled());
  const isShown = it => !it.hidden || !it.hidden();
  const imgSel = () => call('getImageSelection') || null;
  function curImgSize() {
    const w = parseInt(imgSel()?.width, 10);
    if (!w) return null;
    const hit = IMG_SIZES.find(([, , p]) => Math.abs(Math.round(IMAGE_FULL * p) - w) <= 1);
    return hit ? hit[0] : null;
  }
  function zoomItems() {
    return ZOOMS.map(z => ({ label: Math.round(z * 100) + '%', checked: () => zoomFactor(S.zoom) === z, run: () => setView('zoom', 'zoom', z) }))
      .concat([SEP, { label: 'Fit', checked: () => zoomFactor(S.zoom) === 'fit', run: () => setView('zoom', 'zoom', 'fit') }]);
  }
  const STYLE_SC = { normal: 'mod+alt+0', h1: 'mod+alt+1', h2: 'mod+alt+2', h3: 'mod+alt+3' };
  function styleItems(withKeys) {
    return STYLES.map(st => ({ label: st.label, cls: 'dui-st-' + st.v, sc: withKeys === true ? STYLE_SC[st.v] : undefined, edits: true, enabled: notTable, checked: () => curStyle() === st.v, run: () => act('style', st.v) }));
  }
  function fontItems() {
    return FONTS.map(name => ({ label: name, font: name, edits: true, checked: () => fontName() === name, run: () => act('font', name) }));
  }
  function alignItems() {
    return ALIGNS.map(a => ({ label: a.label, icon: a.icon, sc: a.sc, edits: true, checked: () => curAlign() === a.v, run: () => act('align', a.v) }));
  }
  function spacingItems() {
    return SPACINGS.map(([v, label]) => ({ label, edits: true, checked: () => curLH() === v, run: () => act('lineheight', v) }));
  }
  function listItems() {
    return [
      { label: 'Bulleted list', icon: 'bullets', sc: 'mod+shift+8', edits: true, enabled: notTable, checked: () => curList() === 'bullet', run: () => act('list', 'bullet') },
      { label: 'Numbered list', icon: 'numbered', sc: 'mod+shift+7', edits: true, enabled: notTable, checked: () => curList() === 'ordered', run: () => act('list', 'ordered') },
      { label: 'Checklist', icon: 'checklist', sc: 'mod+shift+9', edits: true, enabled: notTable, checked: () => curList() === 'checked' || curList() === 'unchecked', run: () => act('list', 'checked') }
    ];
  }
  function citationItems() {
    return sourcesList().map(s => ({
      label: s.inText || s.title || 'Source', edits: true, enabled: () => S.citationAllowed !== false,
      html: `<span class="dui-cite-in">${h(s.inText || '')}</span>${s.title ? `<span class="dui-cite-t">${h(s.title)}</span>` : ''}`,
      run: () => insertCite(s.id)
    }));
  }
  const inTable = () => !!S.inTable;
  // The writer refuses lists, paragraph styles and tables inside a table cell
  const notTable = () => !S.inTable;
  const onImage = () => !!S.onImage;

  const MENUS = [['file', 'File'], ['edit', 'Edit'], ['view', 'View'], ['insert', 'Insert'], ['format', 'Format'], ['tools', 'Tools'], ['help', 'Help']];
  function menuItems(key) {
    switch (key) {
      case 'file': return [
        { label: 'Print', icon: 'print', sc: 'mod+p', run: () => act('print') },
        { label: 'Download', icon: 'download', sub: () => [
          { label: 'Plain text (.txt)', run: () => act('download', 'txt', { keep: true }) },
          { label: 'Web page (.html)', run: () => act('download', 'html', { keep: true }) }
        ] }
      ];
      case 'edit': return [
        { label: 'Undo', icon: 'undo', sc: 'mod+z', edits: true, enabled: () => S.canUndo !== false, run: () => act('undo') },
        { label: 'Redo', icon: 'redo', sc: 'mod+shift+z', edits: true, enabled: () => S.canRedo !== false, run: () => act('redo') },
        SEP,
        { label: 'Cut', icon: 'cut', sc: 'mod+x', edits: true, run: () => act('cut') },
        { label: 'Copy', icon: 'copy', sc: 'mod+c', run: () => act('copy') },
        { label: 'Paste', icon: 'paste', sc: 'mod+v', edits: true, run: () => act('paste') },
        SEP,
        { label: 'Select all', icon: 'selectAll', sc: 'mod+a', run: () => act('selectAll') },
        SEP,
        { label: 'Find and replace', icon: 'search', sc: 'mod+shift+h', run: () => openFind('replace') }
      ];
      case 'view': return [
        { label: 'Show outline', hidden: () => !M.outline || M.compact, checked: () => !!S.outlineOpen, run: () => setOutline(!S.outlineOpen) },
        { label: 'Show page breaks', hidden: () => M.compact, checked: () => S.pageBreaks !== false, run: () => setView('pageBreaks', 'pageBreaks', S.pageBreaks === false) },
        SEP,
        { label: 'Zoom', icon: 'zoom', hidden: () => M.compact, sub: zoomItems }
      ];
      case 'insert': return [
        { label: 'Image', icon: 'image', edits: true, sub: () => [{ label: 'Upload from computer', icon: 'upload', edits: true, run: doImage }] },
        { label: 'Table', icon: 'table', edits: true, enabled: notTable, sub: () => [{ grid: true }] },
        { label: 'Link', icon: 'link', sc: 'mod+k', edits: true, run: () => openLink() },
        SEP,
        { label: 'Special characters', icon: 'omega', edits: true, run: openSpecialChars },
        { label: 'Citation', icon: 'quote', edits: true, enabled: () => S.citationAllowed !== false, hidden: () => M.opts.citations === false || !sourcesList().length, sub: citationItems }
      ];
      case 'format': return [
        { label: 'Text', icon: 'text', edits: true, sub: () => [
          { label: 'Bold', icon: 'bold', sc: 'mod+b', edits: true, checked: () => one(F().bold) === true, run: () => act('bold') },
          { label: 'Italic', icon: 'italic', sc: 'mod+i', edits: true, checked: () => one(F().italic) === true, run: () => act('italic') },
          { label: 'Underline', icon: 'underline', sc: 'mod+u', edits: true, checked: () => one(F().underline) === true, run: () => act('underline') },
          { label: 'Strikethrough', icon: 'strike', sc: 'mod+shift+x', edits: true, checked: () => one(F().strike) === true, run: () => act('strike') },
          SEP,
          { label: 'Superscript', icon: 'sup', sc: 'mod+.', edits: true, checked: () => one(F().script) === 'super', run: () => act('script', one(F().script) === 'super' ? null : 'super') },
          { label: 'Subscript', icon: 'sub', sc: 'mod+,', edits: true, checked: () => one(F().script) === 'sub', run: () => act('script', one(F().script) === 'sub' ? null : 'sub') }
        ] },
        { label: 'Paragraph styles', icon: 'pilcrow', edits: true, enabled: notTable, sub: () => styleItems(true) },
        { label: 'Align & indent', icon: 'alignLeft', edits: true, sub: () => alignItems().concat([SEP,
          { label: 'Increase indent', icon: 'indentMore', sc: 'mod+]', edits: true, run: () => act('indent', '+1') },
          { label: 'Decrease indent', icon: 'indentLess', sc: 'mod+[', edits: true, run: () => act('indent', '-1') }]) },
        { label: 'Line spacing', icon: 'lineSpacing', edits: true, sub: spacingItems },
        { label: 'Bullets & numbering', icon: 'bullets', edits: true, enabled: notTable, sub: listItems },
        SEP,
        { label: 'Table', icon: 'table', edits: true, sub: () => [
          { label: 'Insert row above', icon: 'rowAbove', edits: true, enabled: inTable, run: () => act('tableOp', 'rowAbove') },
          { label: 'Insert row below', icon: 'rowBelow', edits: true, enabled: inTable, run: () => act('tableOp', 'rowBelow') },
          { label: 'Insert column left', icon: 'colLeft', edits: true, enabled: inTable, run: () => act('tableOp', 'colLeft') },
          { label: 'Insert column right', icon: 'colRight', edits: true, enabled: inTable, run: () => act('tableOp', 'colRight') },
          SEP,
          { label: 'Delete row', icon: 'delRow', edits: true, enabled: inTable, run: () => act('tableOp', 'deleteRow') },
          { label: 'Delete column', icon: 'delCol', edits: true, enabled: inTable, run: () => act('tableOp', 'deleteCol') },
          { label: 'Delete table', icon: 'trash', edits: true, enabled: inTable, run: () => act('tableOp', 'deleteTable') }
        ] },
        { label: 'Image', icon: 'image', edits: true, sub: () => IMG_SIZES.map(([v, label]) => ({ label, edits: true, enabled: onImage, checked: () => onImage() && curImgSize() === v, run: () => act('imageSize', v) }))
          .concat([SEP, { label: 'Alt text…', icon: 'alt', edits: true, enabled: onImage, run: openAltText }]) },
        SEP,
        { label: 'Clear formatting', icon: 'clear', sc: 'mod+\\', edits: true, run: () => act('clear') }
      ];
      case 'tools': return [
        { label: 'Word count', icon: 'wordCount', sc: 'mod+shift+c', run: openWordCount },
        { label: 'Check spelling', checked: () => S.spellcheck !== false, run: () => setView('spellcheck', 'spellcheck', S.spellcheck === false) },
        { label: 'Sources', icon: 'book', hidden: () => M.opts.citations === false, run: () => act('sources', undefined, { keep: true }) }
      ];
      case 'help': return [
        { label: 'Assignment instructions', icon: 'book', run: () => act('instructions', undefined, { keep: true }) },
        { label: 'Keyboard shortcuts', icon: 'keyboard', sc: 'mod+/', run: openShortcuts }
      ];
    }
    return [];
  }
  function visibleItems(items) {
    const out = [];
    for (const it of items || []) {
      if (!it) continue;
      if (it.sep) { if (out.length && !out[out.length - 1].sep) out.push(it); continue; }
      if (isShown(it)) out.push(it);
    }
    while (out.length && out[out.length - 1].sep) out.pop();
    return out;
  }

  /* ====================== layers: menus and popovers ====================== */
  function anchorRect(L) {
    if (L.anchorEl) {
      if (!L.anchorEl.isConnected) return null;
      const r = L.anchorEl.getBoundingClientRect();
      return r.width || r.height ? r : null;
    }
    const r = typeof L.rect === 'function' ? L.rect() : L.rect;
    return r && isFinite(r.left) && isFinite(r.top) ? r : null;
  }
  function place(L) {
    const r = anchorRect(L);
    if (!r) { closeLayersFrom(L.idx); return; }
    const e = L.el;
    e.style.maxHeight = '';
    e.style.left = '0px'; e.style.top = '0px';   // measure at full size, not squeezed against the edge
    const vw = VW(), vh = innerHeight;
    const w = e.offsetWidth, ht = e.offsetHeight;
    let x, y;
    if (L.side === 'right') {
      x = r.right - 2; y = r.top - 6;
      if (x + w > vw - 8) x = r.left - w + 2;
      if (x < 8) { x = r.left + 24; y = r.bottom + 2; }   // no room on either side (a narrow panel): drop below the item
      if (y + ht > vh - 8) y = Math.max(8, vh - 8 - ht);
    } else {
      const gap = L.gap ?? 4;
      x = L.align === 'end' ? r.right - w : L.align === 'center' ? r.left + r.width / 2 - w / 2 : r.left;
      y = (r.bottom ?? r.top) + gap;
      if (y + ht > vh - 8 && r.top - gap - ht >= 8) y = r.top - gap - ht;   // no room below: open above
    }
    x = Math.max(8, Math.min(x, vw - w - 8));
    y = Math.max(8, y);
    const room = vh - y - 8;
    if (ht > room) e.style.maxHeight = Math.max(120, room) + 'px';
    e.style.left = Math.round(x) + 'px';
    e.style.top = Math.round(y) + 'px';
  }
  function push(L) {
    L.idx = stack.length;
    stack.push(L);
    M.layer.appendChild(L.el);
    place(L);
    if (L.anchorEl) { setCls(L.anchorEl, 'is-open', true); if (L.anchorEl.hasAttribute('aria-haspopup')) L.anchorEl.setAttribute('aria-expanded', 'true'); }
    hideTip();
    scheduleBubbles();
    return L;
  }
  function closeLayersFrom(i) {
    clearTimeout(hoverT);
    while (stack.length > Math.max(0, i)) {
      const L = stack.pop();
      L.closed = true;
      L.el.remove();
      if (L.anchorEl) { setCls(L.anchorEl, 'is-open', false); if (L.anchorEl.hasAttribute('aria-expanded')) L.anchorEl.setAttribute('aria-expanded', 'false'); }
      if (L.onClose) { try { L.onClose(); } catch (e) { console.error(e); } }
    }
    scheduleBubbles();
  }
  function closeAll() { closeLayersFrom(0); }
  const hostIndex = node => { for (let i = stack.length - 1; i >= 0; i--) if (stack[i].el.contains(node)) return i; return -1; };
  const openOn = anchor => stack.find(L => L.anchorEl === anchor);

  // Open a menu under (or beside) an anchor, closing whatever was open above the anchor's own layer
  function toggleMenu(anchor, items, o) {
    const open = openOn(anchor);
    if (open) { closeLayersFrom(open.idx); if (o.kb) anchor.focus(); return null; }
    closeLayersFrom(hostIndex(anchor) + 1);
    return openMenu(items, Object.assign({ anchorEl: anchor }, o));
  }
  function togglePop(anchor, build, o) {
    const open = openOn(anchor);
    if (open) { closeLayersFrom(open.idx); return null; }
    closeLayersFrom(hostIndex(anchor) + 1);
    return openPop(build(), Object.assign({ anchorEl: anchor }, o));
  }

  function openMenu(items, o) {
    const list = visibleItems(typeof items === 'function' ? items() : items);
    const m = el('div', 'dui-menu' + (o.cls ? ' ' + o.cls : ''));
    m.setAttribute('role', 'menu');
    if (o.label) m.setAttribute('aria-label', o.label);
    m.tabIndex = -1;
    const L = { kind: 'menu', el: m, items: list, els: [], active: -1, kb: !!o.kb, anchorEl: o.anchorEl || null, rect: o.rect || null,
      side: o.side || 'below', align: o.align, gap: o.gap, owner: o.owner, bar: o.bar || null, parent: o.parent || null, parentIndex: o.parentIndex ?? -1, onClose: o.onClose, grid: null,
      fromEditor: !!o.fromEditor };
    list.forEach((it, i) => { const d = itemEl(it, i, L); L.els.push(d); m.appendChild(d); });
    m.addEventListener('mousedown', e => e.preventDefault());
    // Real pointer moves only: a menu that opens under a resting pointer mustn't steal the keyboard's place
    m.addEventListener('mousemove', e => {
      const pt = e.clientX + ',' + e.clientY;
      if (pt === lastPt) return;
      lastPt = pt;
      const d = e.target.closest('.dui-mi');
      if (d && m.contains(d)) hoverItem(L, +d.dataset.i);
    });
    // Reaching a submenu cancels the parent's pending close
    m.addEventListener('mouseenter', () => { if (L.parent && !L.parent.closed) { if (hoverOwner === L.parent) clearTimeout(hoverT); setActive(L.parent, L.parentIndex, false); } });
    m.addEventListener('click', e => { const d = e.target.closest('.dui-mi'); if (d && m.contains(d)) activate(L, +d.dataset.i, false); });
    push(L);
    if (o.kb || o.activeFirst) setActive(L, nextOn(L, -1, 1), !!o.kb);
    if (o.kb && L.active < 0) m.focus({ preventScroll: true });
    return L;
  }
  function itemEl(it, i, L) {
    if (it.sep) { const s = el('div', 'dui-msep'); s.setAttribute('role', 'separator'); return s; }
    if (it.grid) {
      const g = tableGrid((rows, cols) => { closeAll(); act('insertTable', { rows, cols }); });
      L.grid = g;
      g.el.classList.add('dui-mi', 'dui-mi-grid');
      g.el.dataset.i = i;
      g.el.tabIndex = -1;
      g.el.setAttribute('role', 'menuitem');
      g.el.setAttribute('aria-label', 'Table size');
      return g.el;
    }
    const d = el('div', 'dui-mi' + (it.cls ? ' ' + it.cls : ''));
    d.dataset.i = i;
    d.tabIndex = -1;
    d.setAttribute('role', typeof it.checked === 'function' ? 'menuitemcheckbox' : 'menuitem');
    if (it.sub) d.setAttribute('aria-haspopup', 'menu');
    const style = it.font ? ` style="font-family:${h(fontStack(it.font))}"` : '';
    d.innerHTML = `<span class="dui-mi-ic">${it.icon ? ic(it.icon, 'dui-ico') : ''}${ic('check', 'dui-ck')}</span>`
      + `<span class="dui-mi-l"${style}>${it.html || h(it.label)}</span>`
      + (it.sc ? `<span class="dui-mi-sc">${h(scText(it.sc))}</span>` : '')
      + (it.sub ? `<span class="dui-mi-ar">${ic('chevRight')}</span>` : '');
    if (it.html) d.setAttribute('aria-label', it.label);
    refreshItem(d, it);
    return d;
  }
  function refreshItem(d, it) {
    if (!d || !it || it.sep || it.grid) return;
    setAttr(d, 'aria-disabled', isOn(it) ? null : 'true');
    if (typeof it.checked === 'function') { const c = !!it.checked(); setAttr(d, 'aria-checked', String(c)); setCls(d, 'is-checked', c); }
  }
  function refreshMenus() { for (const L of stack) if (L.kind === 'menu') L.items.forEach((it, i) => refreshItem(L.els[i], it)); }
  function nextOn(L, from, dir) {
    const n = L.items.length;
    for (let k = 1; k <= n; k++) {
      const i = ((from + dir * k) % n + n) % n;
      const it = L.items[i];
      if (it && !it.sep && (it.grid || isOn(it))) return i;
    }
    return -1;
  }
  function setActive(L, i, focus) {
    if (L.active !== i) {
      if (L.els[L.active]) L.els[L.active].classList.remove('is-active');
      L.active = i;
    }
    const d = L.els[i];
    if (!d) return;
    d.classList.add('is-active');
    const m = L.el;
    if (d.offsetTop < m.scrollTop) m.scrollTop = d.offsetTop - 6;
    else if (d.offsetTop + d.offsetHeight > m.scrollTop + m.clientHeight) m.scrollTop = d.offsetTop + d.offsetHeight - m.clientHeight + 6;
    if (focus) d.focus({ preventScroll: true });
    if (L.grid && L.items[i] && L.items[i].grid && focus && !L.grid.r) L.grid.set(1, 1);
  }
  function childOf(L) { const c = stack[L.idx + 1]; return c && c.parent === L ? c : null; }
  function hoverItem(L, i) {
    if (L.closed || (hoverOwner === L && L.hoverI === i)) return;   // still on the same item
    L.hoverI = i;
    clearTimeout(hoverT);
    hoverOwner = L;
    setActive(L, i, L.kb);
    const it = L.items[i], child = childOf(L);
    if (it && it.sub && isOn(it)) {
      if (!child || child.parentIndex !== i) hoverT = setTimeout(() => { if (!L.closed) openSub(L, i, false); }, child ? 180 : 110);
    } else if (child) {
      hoverT = setTimeout(() => { if (!L.closed) closeLayersFrom(L.idx + 1); }, 220);
    }
  }
  function activate(L, i, kb) {
    const it = L.items[i];
    if (!it || it.sep || it.grid || !isOn(it)) return;
    if (it.sub) { clearTimeout(hoverT); openSub(L, i, kb); return; }
    closeAll();
    if (typeof it.run === 'function') it.run();
  }
  function openSub(L, i, kb) {
    const it = L.items[i];
    if (!it || !it.sub || !isOn(it)) return;
    const child = childOf(L);
    if (child && child.parentIndex === i) { if (kb) setActive(child, nextOn(child, -1, 1), true); return; }
    closeLayersFrom(L.idx + 1);
    setActive(L, i, kb && L.kb);
    openMenu(it.sub, { anchorEl: L.els[i], side: 'right', kb: kb && L.kb, activeFirst: kb, parent: L, parentIndex: i, owner: L.owner, label: it.label });
  }
  function switchBar(L, dir) {
    const btns = (L.bar || []).filter(b => b.isConnected);
    const i = btns.indexOf(L.anchorEl);
    if (i < 0 || btns.length < 2) return;
    const nb = btns[(i + dir + btns.length) % btns.length];
    openBarMenu(nb, L.kb, true, L.fromEditor);
  }
  // Keys while a menu is open (focus may still be in the editor when it was opened with the mouse)
  function menuKey(e, L) {
    const k = e.key;
    if (e.isComposing) return false;
    L.hoverI = -1;
    const it = L.items[L.active];
    if (it && it.grid && L.grid && /^(Arrow|Enter$| $)/.test(k)) {
      if (k === 'ArrowLeft' && L.grid.c <= 1 && L.parent) { closeLayersFrom(L.idx); if (L.parent.kb) setActive(L.parent, L.parentIndex, true); }
      else L.grid.key(k);
      e.preventDefault(); e.stopPropagation();
      return true;
    }
    if (k === 'ArrowDown' || k === 'ArrowUp') setActive(L, nextOn(L, L.active, k === 'ArrowDown' ? 1 : -1), L.kb);
    else if (k === 'Home') setActive(L, nextOn(L, -1, 1), L.kb);
    else if (k === 'End') setActive(L, nextOn(L, 0, -1), L.kb);
    else if (k === 'ArrowRight') {
      if (it && it.sub && isOn(it)) openSub(L, L.active, true);
      else { const root = rootOf(L); if (root.bar) switchBar(root, 1); }
    } else if (k === 'ArrowLeft') {
      if (L.parent) { closeLayersFrom(L.idx); setActive(L.parent, L.parentIndex, L.parent.kb); }
      else if (L.bar) switchBar(L, -1);
    } else if (k === 'Enter' || k === ' ') { if (L.active >= 0) activate(L, L.active, true); }
    else if (k === 'Escape') {
      closeLayersFrom(L.idx);
      // A menu opened from the essay (an access key such as Ctrl+Alt+O) goes back
      // to the essay, so typing carries on; one reached along the menu bar stays there
      if (L.parent) setActive(L.parent, L.parentIndex, L.parent.kb);
      else if (L.kb && !L.fromEditor && L.anchorEl && L.anchorEl.isConnected) L.anchorEl.focus();
      else refocus();
    } else if (k === 'Tab') { closeAll(); refocus(); }
    else if (k.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const ch = k.toLowerCase(), n = L.items.length;
      for (let s = 1; s <= n; s++) {
        const i = (L.active + s + n) % n, x = L.items[i];
        if (x && !x.sep && !x.grid && isOn(x) && String(x.label || '').toLowerCase().startsWith(ch)) { setActive(L, i, L.kb); break; }
      }
    } else if (/^(Meta|Control|Alt|Shift|CapsLock)$/.test(k)) return false;
    else if (e.metaKey || e.ctrlKey || e.altKey) { keyFromEditor = !!rootOf(L).fromEditor; closeAll(); return false; }   // a shortcut: let it through
    else return false;
    e.preventDefault(); e.stopPropagation();
    return true;
  }
  function rootOf(L) { let x = L; while (x.parent) x = x.parent; return x; }

  function openPop(content, o) {
    const p = el('div', 'dui-pop' + (o.cls ? ' ' + o.cls : ''));
    p.setAttribute('role', o.role || 'dialog');
    if (o.label) p.setAttribute('aria-label', o.label);
    p.appendChild(content);
    p.addEventListener('mousedown', e => { if (!isField(e.target)) e.preventDefault(); });
    const L = { kind: 'pop', el: p, anchorEl: o.anchorEl || null, rect: o.rect || null, side: o.side || 'below', align: o.align || 'start', gap: o.gap,
      onClose: o.onClose, owner: o.owner, kb: !!o.kb, edits: !!o.edits, escTo: o.escTo };
    push(L);
    if (o.onOpen) o.onOpen(L);
    return L;
  }

  /* ====================== the table-size grid ====================== */
  function tableGrid(onPick) {
    const wrap = el('div', 'dui-tgrid');
    const cells = el('div', 'dui-tg-cells');
    cells.style.gridTemplateColumns = `repeat(${GRID_COLS}, 18px)`;
    const all = [];
    for (let r = 1; r <= GRID_ROWS; r++) for (let c = 1; c <= GRID_COLS; c++) {
      const s = el('span', 'dui-tg-c'); s.dataset.r = r; s.dataset.c = c; cells.appendChild(s); all.push(s);
    }
    const lab = el('div', 'dui-tg-l', 'Insert table');
    wrap.append(cells, lab);
    const g = {
      el: wrap, r: 0, c: 0,
      set(r, c) {
        g.r = Math.max(1, Math.min(GRID_ROWS, r)); g.c = Math.max(1, Math.min(GRID_COLS, c));
        for (const s of all) s.classList.toggle('is-on', +s.dataset.r <= g.r && +s.dataset.c <= g.c);
        lab.textContent = `${g.c} × ${g.r}`;
        wrap.setAttribute('aria-valuetext', `${g.c} columns, ${g.r} rows`);
      },
      key(k) {
        if (!g.r) { g.set(1, 1); return; }
        if (k === 'ArrowRight') g.set(g.r, g.c + 1);
        else if (k === 'ArrowLeft') g.set(g.r, g.c - 1);
        else if (k === 'ArrowDown') g.set(g.r + 1, g.c);
        else if (k === 'ArrowUp') g.set(g.r - 1, g.c);
        else if (k === 'Enter' || k === ' ') onPick(g.r, g.c);
      }
    };
    cells.addEventListener('mouseover', e => { const t = e.target.closest('.dui-tg-c'); if (t) g.set(+t.dataset.r, +t.dataset.c); });
    cells.addEventListener('click', e => { const t = e.target.closest('.dui-tg-c'); if (t) { g.set(+t.dataset.r, +t.dataset.c); onPick(g.r, g.c); } });
    return g;
  }

  /* ====================== tooltips ====================== */
  function onTipOver(e) {
    if (!M) return;
    const t = e.target.closest && e.target.closest('[data-tip]');
    if (t === tipFor) return;
    hideTip(true);
    if (!t || !t.closest('.dui-toolbar, .dui-pop, .dui-bubble, .dui-find, .dui-outline, .dui-wc-float')) return;
    tipFor = t;
    tipT = setTimeout(() => showTip(t), Date.now() - tipAt < 700 ? 40 : 450);
  }
  function showTip(t) {
    if (!M || !t.isConnected || openOn(t)) return;
    const tip = M.tip;
    tip.textContent = t.dataset.tip;
    tip.classList.add('is-on');
    tip.style.left = '0px'; tip.style.top = '0px';
    const r = t.getBoundingClientRect(), w = tip.offsetWidth, ht = tip.offsetHeight;
    let x = r.left + r.width / 2 - w / 2, y = r.bottom + 6;
    if (y + ht > innerHeight - 4) y = r.top - ht - 6;
    x = Math.max(4, Math.min(x, VW() - w - 4));
    tip.style.left = Math.round(x) + 'px'; tip.style.top = Math.round(y) + 'px';
    tipAt = Date.now();
  }
  function hideTip(keepAt) {
    clearTimeout(tipT); tipFor = null;
    if (M && M.tip.classList.contains('is-on')) { M.tip.classList.remove('is-on'); if (keepAt) tipAt = Date.now(); }
  }

  /* ====================== the menu bar ====================== */
  function buildMenubar() {
    const bar = el('div', 'dui-menubar');
    bar.setAttribute('role', 'menubar');
    bar.setAttribute('aria-label', 'Menu');
    const btns = MENUS.map(([key, label], i) => {
      const b = el('button', 'dui-mb-item');
      b.type = 'button'; b.textContent = label; b.dataset.menu = key;
      b.setAttribute('role', 'menuitem'); b.setAttribute('aria-haspopup', 'menu'); b.setAttribute('aria-expanded', 'false');
      b.tabIndex = i === 0 ? 0 : -1;
      bar.appendChild(b);
      return b;
    });
    M.barBtns = btns;
    bar.addEventListener('mousedown', e => {
      e.preventDefault();
      const b = e.target.closest('.dui-mb-item');
      if (!b || e.button !== 0) return;
      if (openOn(b)) closeAll(); else openBarMenu(b, false);
    });
    bar.addEventListener('mouseover', e => {
      const b = e.target.closest('.dui-mb-item');
      const top = stack[0];
      if (b && top && top.bar === btns && top.anchorEl !== b) openBarMenu(b, false);
    });
    bar.addEventListener('keydown', e => {
      const b = e.target.closest('.dui-mb-item');
      if (!b || stack.length) return;
      const i = btns.indexOf(b);
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const nb = btns[(i + (e.key === 'ArrowRight' ? 1 : -1) + btns.length) % btns.length];
        btns.forEach(x => { x.tabIndex = x === nb ? 0 : -1; });
        nb.focus();
      } else if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') openBarMenu(b, true);
      else if (e.key === 'Escape') refocus();
      else return;
      e.preventDefault();
    });
    return bar;
  }
  function openBarMenu(b, kb, activeFirst, fromEditor) {
    if (!M) return;
    closeLayersFrom(hostIndex(b) + 1);
    const bar = M.barBtns && M.barBtns.includes(b) ? M.barBtns : M.miniBtns;
    if (kb && bar) bar.forEach(x => { x.tabIndex = x === b ? 0 : -1; });
    openMenu(() => menuItems(b.dataset.menu), { anchorEl: b, kb, activeFirst: kb || activeFirst, owner: 'menubar', bar, label: b.textContent, gap: 2, cls: 'dui-menu-main', fromEditor: !!fromEditor });
  }

  /* ====================== the toolbar ====================== */
  // Groups in Docs order. sec: groups of one section have no divider between them.
  // rank: the higher, the sooner the group moves into ⋮ when space runs out (0 never moves).
  // compact: shown in the side panel's compact toolbar.
  function tbBtn(icon, label, sc, fn, o = {}) {
    const b = el('button', 'dui-btn' + (o.cls ? ' ' + o.cls : ''), ic(icon));
    b.type = 'button';
    b.tabIndex = -1;
    b.setAttribute('aria-label', label);
    b.dataset.tip = b._tip = tipText(label, sc);
    b._offTip = o.offTip || null;
    if (o.toggle) b.setAttribute('aria-pressed', 'false');
    if (o.popup) { b.setAttribute('aria-haspopup', o.popup); b.setAttribute('aria-expanded', 'false'); }
    b._edits = !!o.edits; b._enabled = o.enabled || null;
    b.addEventListener('click', e => { if (b.getAttribute('aria-disabled') === 'true') return; hideTip(); fn(e, b); });
    M.T.ctrls.push(b);
    return b;
  }
  function tbDrop(cls, label, fn, o = {}) {
    const b = el('button', 'dui-dd ' + cls, `<span class="dui-dd-l"></span>${ic('caret', 'dui-caret')}`);
    b.type = 'button';
    b.tabIndex = -1;
    b.setAttribute('aria-label', label);
    b.setAttribute('aria-haspopup', o.popup || 'menu');
    b.setAttribute('aria-expanded', 'false');
    b.dataset.tip = b._tip = label;
    b._offTip = o.offTip || null;
    b._edits = !!o.edits; b._enabled = o.enabled || null;
    b.addEventListener('click', e => { if (b.getAttribute('aria-disabled') === 'true') return; hideTip(); fn(e, b); });
    b.addEventListener('keydown', e => { if (e.key === 'ArrowDown' && b.getAttribute('aria-disabled') !== 'true') { e.preventDefault(); fn({ detail: 0 }, b); } });
    M.T.ctrls.push(b);
    return b;
  }
  const kbOf = e => !!e && e.detail === 0;   // a click from Enter or Space

  function buildToolbar() {
    const root = el('div', 'dui-toolbar' + (M.compact ? ' is-compact' : ''));
    root.setAttribute('role', 'toolbar');
    root.setAttribute('aria-label', 'Formatting');
    const T = M.T = { root, ctrls: [], c: {}, groups: [], spacer: el('div', 'dui-spacer'), ovf: el('div', 'dui-ovf'), ovfWrap: el('div', 'dui-ovf-wrap'), sig: '' };
    const C = T.c;
    const G = (key, sec, opt, kids) => {
      const g = el('div', 'dui-g dui-g-' + key);
      const s = el('span', 'dui-sep'); s.setAttribute('aria-hidden', 'true');
      g.appendChild(s);
      kids.forEach(k => g.appendChild(k));
      T.groups.push({ key, sec, el: g, sepEl: s, compact: !!opt.compact, rank: opt.rank || 0, side: opt.side || 'left', on: opt.on || (() => true), w: 0 });
    };

    C.undo = tbBtn('undo', 'Undo', 'mod+z', () => act('undo'), { edits: true, enabled: () => S.canUndo !== false });
    C.redo = tbBtn('redo', 'Redo', 'mod+shift+z', () => act('redo'), { edits: true, enabled: () => S.canRedo !== false });
    G('hist', 1, { compact: true, rank: 0 }, [C.undo, C.redo]);
    C.print = tbBtn('print', 'Print', 'mod+p', () => act('print'));
    G('print', 1, { rank: 4 }, [C.print]);

    C.zoom = tbDrop('dui-dd-zoom', 'Zoom', (e, b) => toggleMenu(b, zoomItems, { kb: kbOf(e), owner: 'tb', label: 'Zoom' }));
    G('zoom', 2, { rank: 5, on: () => !M.compact }, [C.zoom]);
    C.style = tbDrop('dui-dd-style', 'Styles', (e, b) => toggleMenu(b, styleItems, { kb: kbOf(e), owner: 'tb', label: 'Styles', cls: 'dui-menu-styles ' + (S.docStyle === 'docs' ? 'is-docs' : 'is-mla') }), { edits: true, enabled: notTable, offTip: 'Paragraph styles don’t work inside a table' });
    G('style', 3, { compact: true, rank: 1.5 }, [C.style]);
    C.font = tbDrop('dui-dd-font', 'Font', (e, b) => toggleMenu(b, fontItems, { kb: kbOf(e), owner: 'tb', label: 'Font' }), { edits: true });
    G('font', 4, { rank: 6 }, [C.font]);

    C.sizeDown = tbBtn('minus', 'Decrease font size', 'mod+shift+,', () => act('sizeStep', -1), { edits: true });
    C.size = el('input', 'dui-size-in');
    C.size.type = 'text'; C.size.inputMode = 'numeric'; C.size.maxLength = 3; C.size.tabIndex = -1;
    C.size.setAttribute('aria-label', 'Font size'); C.size.dataset.tip = 'Font size';
    C.size.autocomplete = 'off'; C.size.spellcheck = false;
    C.size._edits = true;
    T.ctrls.push(C.size);
    wireSize(C.size);
    C.sizeUp = tbBtn('plus', 'Increase font size', 'mod+shift+.', () => act('sizeStep', 1), { edits: true });
    const sizeBox = el('div', 'dui-size'); sizeBox.append(C.sizeDown, C.size, C.sizeUp);
    G('size', 5, { rank: 7 }, [sizeBox]);

    C.bold = tbBtn('bold', 'Bold', 'mod+b', () => act('bold'), { edits: true, toggle: true });
    C.italic = tbBtn('italic', 'Italic', 'mod+i', () => act('italic'), { edits: true, toggle: true });
    C.underline = tbBtn('underline', 'Underline', 'mod+u', () => act('underline'), { edits: true, toggle: true });
    G('biu', 6, { compact: true, rank: 1 }, [C.bold, C.italic, C.underline]);
    C.color = tbBtn('textColor', 'Text color', null, (e, b) => togglePop(b, () => palette('color'), { kb: kbOf(e), edits: true, label: 'Text color', onOpen: L => palOpen(L, kbOf(e)) }), { edits: true, popup: 'dialog', cls: 'dui-colorbtn' });
    C.highlight = tbBtn('highlight', 'Highlight color', null, (e, b) => togglePop(b, () => palette('background'), { kb: kbOf(e), edits: true, label: 'Highlight color', onOpen: L => palOpen(L, kbOf(e)) }), { edits: true, popup: 'dialog', cls: 'dui-colorbtn' });
    G('color', 6, { rank: 8 }, [C.color, C.highlight]);

    C.link = tbBtn('link', 'Insert link', 'mod+k', () => openLink(), { edits: true });
    C.image = tbBtn('image', 'Insert image', null, doImage, { edits: true });
    C.table = tbBtn('table', 'Insert table', null, (e, b) => {
      const kb = kbOf(e);
      togglePop(b, () => { const g = tableGrid((rows, cols) => { closeAll(); act('insertTable', { rows, cols }); }); g.el.tabIndex = -1; g.el.addEventListener('keydown', ev => { if (/^Arrow|^Enter$|^ $/.test(ev.key)) { ev.preventDefault(); g.key(ev.key); } }); return g.el; },
        { kb, edits: true, label: 'Insert table', cls: 'dui-pop-grid', onOpen: L => { if (kb) { const g = L.el.querySelector('.dui-tgrid'); g.focus(); g.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' })); } } });
    }, { edits: true, popup: 'dialog', enabled: notTable, offTip: 'A table can’t go inside a table' });
    G('insert', 7, { rank: 10 }, [C.link, C.image, C.table]);

    C.align = tbDrop('dui-dd-align', 'Align & indent', (e, b) => toggleMenu(b, alignItems, { kb: kbOf(e), owner: 'tb', label: 'Align' }), { edits: true });
    C.lh = tbDrop('dui-dd-lh', 'Line & paragraph spacing', (e, b) => toggleMenu(b, spacingItems, { kb: kbOf(e), owner: 'tb', label: 'Line spacing' }), { edits: true });
    C.lh.querySelector('.dui-dd-l').innerHTML = ic('lineSpacing');
    G('para', 8, { rank: 11 }, [C.align, C.lh]);
    const noList = { edits: true, toggle: true, enabled: notTable, offTip: 'Lists don’t work inside a table' };
    C.checklist = tbBtn('checklist', 'Checklist', 'mod+shift+9', () => act('list', 'checked'), noList);
    C.bullets = tbBtn('bullets', 'Bulleted list', 'mod+shift+8', () => act('list', 'bullet'), noList);
    C.numbered = tbBtn('numbered', 'Numbered list', 'mod+shift+7', () => act('list', 'ordered'), noList);
    G('lists', 8, { compact: true, rank: 12 }, [C.checklist, C.bullets, C.numbered]);
    C.outdent = tbBtn('indentLess', 'Decrease indent', 'mod+[', () => act('indent', '-1'), { edits: true });
    C.indent = tbBtn('indentMore', 'Increase indent', 'mod+]', () => act('indent', '+1'), { edits: true });
    G('indent', 8, { rank: 13 }, [C.outdent, C.indent]);
    C.clear = tbBtn('clear', 'Clear formatting', 'mod+\\', () => act('clear'), { edits: true });
    G('clear', 8, { rank: 14 }, [C.clear]);

    // Right side: the word count, the Works Cited sources and citations
    C.wc = el('button', 'dui-chip dui-chip-wc'); C.wc.type = 'button'; C.wc.tabIndex = -1;
    C.wc.dataset.tip = tipText('Word count', 'mod+shift+c');
    C.wc.addEventListener('click', () => { hideTip(); openWordCount(); });
    // The word count lives in the floating chip (as in Docs) unless the writer wants it here
    if (M.opts.wcChip) { T.ctrls.push(C.wc); G('wc', 9, { side: 'right', rank: 9, on: () => !!wordsText() }, [C.wc]); }
    C.sources = el('button', 'dui-chip dui-chip-src', `${ic('book')}<span></span>`); C.sources.type = 'button'; C.sources.tabIndex = -1;
    C.sources.dataset.tip = 'Show your Works Cited sources';
    C.sources.addEventListener('click', () => { hideTip(); act('sources', undefined, { keep: true }); });
    // Sources sit in the writer's header unless it asks for them here
    if (M.opts.sourcesChip && M.opts.citations !== false) { T.ctrls.push(C.sources); G('src', 9, { side: 'right', rank: 3 }, [C.sources]); }
    C.cite = el('button', 'dui-chip dui-chip-cite', `${ic('quote')}<span>Insert citation</span>`); C.cite.type = 'button'; C.cite.tabIndex = -1;
    C.cite.setAttribute('aria-haspopup', 'dialog'); C.cite.setAttribute('aria-expanded', 'false');
    C.cite.dataset.tip = 'Add an in-text citation where your cursor is';
    C.cite._edits = true;
    C.cite.addEventListener('click', e => { if (C.cite.getAttribute('aria-disabled') === 'true') return; hideTip(); togglePop(C.cite, citePicker, { kb: kbOf(e), edits: true, label: 'Insert a citation', align: 'end', cls: 'dui-pop-cite' }); });
    if (M.opts.citations !== false) { T.ctrls.push(C.cite); G('cite', 9, { side: 'right', rank: 2.5, on: () => S.citationAllowed === true }, [C.cite]); }

    C.more = tbBtn('more', 'More', null, (e, b) => togglePop(b, () => T.ovfWrap, { kb: kbOf(e), owner: 'more', label: 'More tools', align: 'end', cls: 'dui-pop-more', onOpen: L => { if (kbOf(e)) { const f = L.el.querySelector('button:not([aria-disabled="true"]), input'); if (f) f.focus(); } } }), { popup: 'dialog', cls: 'dui-more' });
    T.moreG = el('div', 'dui-g dui-g-more'); T.moreG.appendChild(C.more);

    if (M.compact) {
      // The side panel has no menu bar: the same menus sit at the top of ⋮
      const mini = el('div', 'dui-ovf-menus');
      mini.setAttribute('role', 'menubar');
      M.miniBtns = [];
      for (const [key, label] of MENUS) {
        if (!visibleItems(menuItems(key)).length) continue;
        const b = el('button', 'dui-mb-item', h(label));
        b.type = 'button'; b.dataset.menu = key;
        b.setAttribute('role', 'menuitem'); b.setAttribute('aria-haspopup', 'menu'); b.setAttribute('aria-expanded', 'false');
        b.addEventListener('click', e => { if (openOn(b)) closeLayersFrom(openOn(b).idx); else openBarMenu(b, kbOf(e)); });
        b.addEventListener('mouseover', () => { const top = stack[stack.length - 1]; if (top && top.kind === 'menu' && rootOf(top).bar === M.miniBtns && rootOf(top).anchorEl !== b) openBarMenu(b, false); });
        mini.appendChild(b);
        M.miniBtns.push(b);
      }
      T.ovfWrap.appendChild(mini);
    }
    T.ovfWrap.appendChild(T.ovf);

    root.addEventListener('mousedown', onBarMouseDown);
    T.ovf.addEventListener('mousedown', onBarMouseDown);
    root.addEventListener('keydown', onBarKey);
    root.addEventListener('focusin', e => { if (e.target !== C.size && T.ctrls.includes(e.target)) setRoving(e.target); });
    return root;
  }
  function onBarMouseDown(e) {
    const t = e.target;
    if (t === M.T.c.size && t.getAttribute('aria-disabled') !== 'true') return;   // the size box takes focus to be typed in
    if (isField(t) && t !== M.T.c.size) return;
    e.preventDefault();
  }
  // Arrow keys move along the toolbar; one control at a time is in the tab order
  function barCtrls() { const T = M.T; return T.ctrls.filter(c => T.root.contains(c) && c.offsetParent !== null); }
  function setRoving(c) { const T = M.T; for (const x of T.ctrls) x.tabIndex = (x === c ? 0 : (T.root.contains(x) ? -1 : 0)); T.roving = c; }
  function onBarKey(e) {
    const T = M.T;
    if (e.target === T.c.size || !T.ctrls.includes(e.target)) return;
    const list = barCtrls(), i = list.indexOf(e.target);
    let n = -1;
    if (e.key === 'ArrowRight') n = (i + 1) % list.length;
    else if (e.key === 'ArrowLeft') n = (i - 1 + list.length) % list.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = list.length - 1;
    else if (e.key === 'Escape') { refocus(); e.preventDefault(); return; }
    if (n < 0) return;
    e.preventDefault();
    setRoving(list[n]);
    list[n].focus();
  }

  function wireSize(inp) {
    let editing = false, pop = null, hi = -1;
    const revert = () => { inp.value = sizeValue(); };
    const items = () => pop ? [...pop.el.querySelectorAll('.dui-size-opt')] : [];
    const mark = i => { hi = i; items().forEach((x, j) => x.classList.toggle('is-active', j === i)); const a = items()[i]; if (a) a.scrollIntoView({ block: 'nearest' }); };
    const apply = v => {
      const n = parseFloat(String(v).replace(/[^\d.]/g, ''));
      editing = false;
      if (pop) { closeLayersFrom(pop.idx); pop = null; }
      if (!n || !can()) { revert(); refocus(); return; }
      const s = nearestSize(n);
      inp.value = String(parseFloat(s));
      act('size', s);
    };
    inp.addEventListener('focus', () => {
      if (inp.getAttribute('aria-disabled') === 'true') { inp.blur(); return; }
      editing = true;
      inp.select();
      if (pop && !pop.closed) return;
      const list = el('div', 'dui-size-list');
      list.setAttribute('role', 'listbox');
      list.innerHTML = SIZES.map(s => `<div class="dui-size-opt" role="option" data-v="${s}">${parseFloat(s)}</div>`).join('');
      list.addEventListener('click', e => { const o = e.target.closest('.dui-size-opt'); if (o) apply(o.dataset.v); });
      pop = openPop(list, { anchorEl: inp, align: 'center', label: 'Font sizes', cls: 'dui-pop-size', edits: true, escTo: 'editor', onClose: () => { pop = null; } });
      const cur = SIZES.findIndex(s => String(parseFloat(s)) === inp.value);
      mark(cur);
    });
    inp.addEventListener('blur', () => { editing = false; if (pop) { closeLayersFrom(pop.idx); pop = null; } revert(); });
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); const opt = items()[hi]; apply(opt && opt.textContent === inp.value ? opt.dataset.v : inp.value); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = Math.max(0, Math.min(SIZES.length - 1, hi + (e.key === 'ArrowDown' ? 1 : -1)));
        mark(n); inp.value = String(parseFloat(SIZES[n])); inp.select();
      } else if (e.key === 'Escape') { e.preventDefault(); revert(); refocus(); }
      else if (e.key === 'Tab') { revert(); }
    });
    inp._editing = () => editing;
  }

  function palette(key) {
    const cur = String(one(F()[key]) || '').toLowerCase();
    const recent = recentColors();
    const w = el('div', 'dui-pal');
    const light = c => { const n = parseInt(c.slice(1), 16); return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) > 190; };
    const sw = (c, name) => `<button type="button" class="dui-sw${c === cur ? ' is-cur' : ''}${light(c) ? ' is-light' : ''}" style="--c:${c}" data-c="${c}" aria-label="${h(name)}" data-tip="${h(name)}">${ic('check', 'dui-sw-ck')}</button>`;
    w.innerHTML = `<button type="button" class="dui-pal-none" data-c="">${ic('none')}<span>${key === 'background' ? 'None' : 'Default'}</span></button>`
      + `<div class="dui-sw-grid" role="group" aria-label="Colors">${PALETTE.map((row, r) => row.map((c, i) => sw(c, colorName(r, i))).join('')).join('')}</div>`
      + `<div class="dui-pal-h">Custom</div>`
      + `<div class="dui-sw-row">${recent.map(c => sw(c, 'Custom ' + c)).join('')}<label class="dui-sw-add" data-tip="Choose a custom color">${ic('plus')}<input type="color" value="${/^#[0-9a-f]{6}$/.test(cur) ? cur : '#1e9bc4'}" aria-label="Custom color"></label></div>`;
    w.addEventListener('click', e => {
      const b = e.target.closest('[data-c]');
      if (!b) return;
      closeAll();
      act(key, b.dataset.c || null);
    });
    w.querySelector('input[type=color]').addEventListener('change', e => {
      const c = String(e.target.value || '').toLowerCase();
      if (!/^#[0-9a-f]{6}$/.test(c)) return;
      addRecentColor(c);
      closeAll();
      act(key, c);
    });
    // Arrow keys move around the swatches
    w.addEventListener('keydown', e => {
      const all = [...w.querySelectorAll('.dui-pal-none, .dui-sw')];
      const i = all.indexOf(document.activeElement);
      if (i < 0) return;
      const grid = i >= 1 && i <= 60;
      let n = -1;
      if (e.key === 'ArrowRight') n = i + 1;
      else if (e.key === 'ArrowLeft') n = i - 1;
      else if (e.key === 'ArrowDown') n = i === 0 ? 1 : grid && i + 10 <= 60 ? i + 10 : i + 1;
      else if (e.key === 'ArrowUp') n = grid && i - 10 >= 1 ? i - 10 : i > 60 ? Math.max(1, 51) : 0;
      if (n < 0) return;
      e.preventDefault();
      const t = all[Math.max(0, Math.min(all.length - 1, n))];
      if (t) t.focus();
    });
    return w;
  }
  function palOpen(L, kb) { if (!kb) return; const f = L.el.querySelector('.dui-sw.is-cur') || L.el.querySelector('.dui-sw'); if (f) f.focus(); }
  function recentColors() { try { const a = JSON.parse(lsGet('visor-custom-colors') || '[]'); return Array.isArray(a) ? a.filter(c => /^#[0-9a-f]{6}$/.test(c)).slice(0, 9) : []; } catch { return []; } }
  function addRecentColor(c) { lsSet('visor-custom-colors', JSON.stringify([c].concat(recentColors().filter(x => x !== c)).slice(0, 9))); }

  function citePicker() {
    const list = sourcesList();
    const w = el('div', 'dui-cites');
    if (!list.length) {
      w.innerHTML = `<p class="dui-cites-empty">No sources yet. Cite a page with the Visor extension, or add one by hand under Works Cited.</p><button type="button" class="dui-linkbtn" data-src="1">Open Works Cited</button>`;
    } else {
      w.innerHTML = `<div class="dui-cites-h">Insert a citation</div>` + list.map(s => `<button type="button" class="dui-cite" data-id="${h(s.id)}"><span class="dui-cite-in">${h(s.inText || '')}</span><span class="dui-cite-t">${h(s.title || '')}</span></button>`).join('');
    }
    w.addEventListener('click', e => {
      if (e.target.closest('[data-src]')) { closeAll(); act('sources', undefined, { keep: true }); return; }
      const b = e.target.closest('.dui-cite');
      if (!b) return;
      closeAll();
      insertCite(b.dataset.id);
    });
    return w;
  }

  /* ---- fitting the toolbar: trailing groups move into ⋮ when there's no room ---- */
  function layoutToolbar() {
    const T = M && M.T;
    if (!T || !T.root.isConnected) return;
    const root = T.root;
    const live = T.groups.filter(g => g.on());
    for (const g of T.groups) if (!live.includes(g)) g.el.remove();
    // Everything back in the bar, in order, to measure
    for (const g of live) if (g.side === 'left') root.appendChild(g.el);
    root.appendChild(T.moreG);
    root.appendChild(T.spacer);
    for (const g of live) if (g.side === 'right') root.appendChild(g.el);
    seps(live);
    const cs = getComputedStyle(root);
    const avail = root.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    for (const g of live) g.w = g.el.getBoundingClientRect().width + 1;
    const moreW = T.moreG.getBoundingClientRect().width + (M.compact ? 1 : 8);
    const shown = live.filter(g => !(M.compact && !g.compact));
    const hidden = live.filter(g => !shown.includes(g));
    const slack = M.compact ? 2 : 8;
    const need = () => shown.reduce((a, g) => a + g.w, 0) + (hidden.length ? moreW : 0) + slack;
    while (need() > avail) {
      let worst = null;
      for (const g of shown) if (g.rank > 0 && (!worst || g.rank > worst.rank)) worst = g;
      if (!worst) break;
      shown.splice(shown.indexOf(worst), 1);
      hidden.push(worst);
    }
    // The ones that don't fit go into ⋮, in toolbar order
    for (const g of live) if (hidden.includes(g)) T.ovf.appendChild(g.el);
    T.moreG.hidden = !hidden.length;
    seps(shown);
    seps(live.filter(g => hidden.includes(g)));
    for (const c of T.ctrls) if (!root.contains(c)) c.tabIndex = 0;
    if (!T.roving || !root.contains(T.roving) || T.roving.offsetParent === null) setRoving(barCtrls()[0] || T.c.undo);
    else setRoving(T.roving);
    const moreOpen = openOn(T.c.more);
    if (moreOpen && !hidden.length) closeLayersFrom(moreOpen.idx);
    else if (moreOpen) place(moreOpen);
  }
  function seps(list) {
    let prev = null;
    for (const g of list) { g.sepEl.hidden = !(prev && prev.sec !== g.sec && prev.side === g.side); prev = g; }
  }
  function scheduleLayout() {
    if (!M || M.layoutQueued) return;
    M.layoutQueued = true;
    requestAnimationFrame(() => { if (!M) return; M.layoutQueued = false; layoutToolbar(); });
  }

  /* ---- showing the writer's state on the toolbar ---- */
  function renderToolbar() {
    const T = M && M.T;
    if (!T) return;
    const C = T.c, f = F(), ok = can();
    for (const b of T.ctrls) {
      if (b === C.more) continue;
      const locked = b._edits && !ok, na = !locked && !!b._enabled && !b._enabled();
      setAttr(b, 'aria-disabled', locked || na ? 'true' : null);
      // Say why a control is off when it's the place (a table cell), not the lock
      if (b._tip) { const tip = na && b._offTip ? b._offTip : b._tip; if (b.dataset.tip !== tip) { b.dataset.tip = tip; if (tipFor === b) hideTip(); } }
    }
    setAttr(C.bold, 'aria-pressed', String(one(f.bold) === true));
    setAttr(C.italic, 'aria-pressed', String(one(f.italic) === true));
    setAttr(C.underline, 'aria-pressed', String(one(f.underline) === true));
    const l = curList();
    setAttr(C.bullets, 'aria-pressed', String(l === 'bullet'));
    setAttr(C.numbered, 'aria-pressed', String(l === 'ordered'));
    setAttr(C.checklist, 'aria-pressed', String(l === 'checked' || l === 'unchecked'));
    setText(C.zoom.firstChild, zoomLabel());
    setText(C.style.firstChild, styleLabel(M.compact));
    setText(C.font.firstChild, fontName());
    if (!(C.size._editing && C.size._editing())) { const sv = sizeValue(); if (C.size.value !== sv) C.size.value = sv; }
    setAttr(C.size, 'readonly', ok ? null : '');
    const al = ALIGNS.find(a => a.v === curAlign()) || ALIGNS[0];
    if (C.align._icon !== al.icon) { C.align._icon = al.icon; C.align.firstChild.innerHTML = ic(al.icon); C.align.dataset.tip = 'Align & indent'; }
    const col = one(f.color), bg = one(f.background);
    const cv = typeof col === 'string' && col ? col : '#000000';
    if (C.color._c !== cv) { C.color._c = cv; C.color.style.setProperty('--dui-c', cv); }
    const bv = typeof bg === 'string' && bg ? bg : '';
    if (C.highlight._c !== bv) { C.highlight._c = bv; C.highlight.style.setProperty('--dui-c', bv || 'transparent'); setCls(C.highlight, 'is-none', !bv); }
    // The right side
    const wl = wordsText();
    setText(C.wc, wl);
    const n = Number(S.sourcesCount) || 0;
    setText(C.sources.lastChild, `Sources (${n})`);
    C.sources.setAttribute('aria-label', `Works Cited sources: ${n}`);
    // Re-fit when something that takes space appears, goes or changes length
    const sig = [!!wl, wl.length, String(n).length, S.citationAllowed === true].join('|');
    if (sig !== T.sig) { T.sig = sig; scheduleLayout(); }
  }

  /* ====================== the link popover and bubbles ====================== */
  function selectionRect() {
    const r = call('getSelectionRect');
    if (!r || !isFinite(r.left) || !isFinite(r.top)) return null;
    const bottom = isFinite(r.bottom) ? r.bottom : r.top;
    if (bottom < 0 || r.top > innerHeight) return null;
    return { left: r.left, top: r.top, bottom, right: isFinite(r.right) ? r.right : r.left, width: (r.right || r.left) - r.left, height: bottom - r.top };
  }
  function openLink(o = {}) {
    if (!M || !can()) return;
    closeAll();
    hideBubbles();
    const f = F();
    const here = typeof one(f.link) === 'string' ? (call('getLink') || { url: one(f.link), text: '' }) : null;
    const edit = !!o.edit || (!!here && !S.hasSelection);
    // A link that holds a picture keeps its text: there's no Text field, and the
    // writer gets text '' ("keep the text"), so it re-links the range instead of
    // replacing it (which would delete the picture)
    const imgLink = !!here && (here.hasImage === true || String(here.text || '').includes('\uFFFC'));
    const showText = !imgLink && (edit || !S.hasSelection);
    let selText = '';
    if (imgLink) selText = String(here.text || '').replace(/\uFFFC/g, ' [image] ').replace(/\s+/g, ' ').trim();
    else if (!showText && editorFocused()) { try { selText = String(window.getSelection() || '').replace(/\s+/g, ' ').trim(); } catch { /* none */ } }
    const w = el('div', 'dui-lp');
    w.innerHTML = (showText ? `<div class="dui-lp-f">${ic('text')}<input class="dui-lp-text" type="text" placeholder="Text" aria-label="Text to show" autocomplete="off"></div>` : '')
      + ((imgLink && selText === '[image]') || (!showText && !selText && S.onImage) ? `<div class="dui-lp-sel">Link on the image</div>`
        : selText ? `<div class="dui-lp-sel">Link for “${h(selText.length > 60 ? selText.slice(0, 58) + '…' : selText)}”</div>` : '')
      + `<div class="dui-lp-f">${ic('link')}<input class="dui-lp-url" type="text" inputmode="url" placeholder="Paste or type a link" aria-label="Link" autocomplete="off" spellcheck="false">`
      + `<button type="button" class="dui-lp-apply">Apply</button></div>`
      + `<div class="dui-lp-err" role="alert" hidden></div>`;
    const tIn = w.querySelector('.dui-lp-text'), uIn = w.querySelector('.dui-lp-url'), ap = w.querySelector('.dui-lp-apply'), err = w.querySelector('.dui-lp-err');
    if (tIn && here) tIn.value = here.text || '';
    if (here) uIn.value = here.url || '';
    const sync = () => { ap.disabled = !uIn.value.trim(); err.hidden = true; };
    sync();
    uIn.addEventListener('input', sync);
    const apply = () => {
      const url = cleanLink(uIn.value);
      if (!url) { err.textContent = 'Enter a web address, like example.com, or an email link (mailto:).'; err.hidden = false; uIn.focus(); return; }
      // The text goes as typed; only line breaks become spaces. '' tells the
      // writer to keep the link's text (an image link, an empty or unchanged field)
      let text = tIn ? tIn.value.replace(/[\r\n\t]+/g, ' ') : '';
      if (!text.trim()) text = '';
      closeAll();
      run('focus');
      if (edit) {
        const keep = imgLink || (!!here && here.length > 0 && (!text || text === here.text));
        run('editLink', { text: keep ? '' : (text || (here && here.text) || url), url });
      } else run('link', { text: S.hasSelection ? '' : (text || url), url });
      refocus();
    };
    ap.addEventListener('click', apply);
    w.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); apply(); } });
    const rect = selectionRect();
    const anchor = M.T && M.T.root.contains(M.T.c.link) && M.T.c.link.offsetParent ? M.T.c.link : null;
    openPop(w, rect ? { rect: () => selectionRect() || rect, gap: 8, label: edit ? 'Edit link' : 'Insert link', cls: 'dui-pop-link', edits: true, escTo: 'editor' }
      : { anchorEl: anchor || (M.T ? M.T.root : document.body), label: 'Insert link', cls: 'dui-pop-link', edits: true, escTo: 'editor' });
    (tIn && !tIn.value ? tIn : uIn).focus();
    if (uIn.value) uIn.select();
  }

  function buildBubbles() {
    const lb = el('div', 'dui-bubble dui-lbub');
    lb.innerHTML = `${ic('globe')}<a class="dui-lb-url" target="_blank" rel="noopener noreferrer" href="#"></a><span class="dui-vsep"></span>`
      + `<button type="button" class="dui-btn" data-b="open" aria-label="Open link" data-tip="Open link">${ic('external')}</button>`
      + `<button type="button" class="dui-btn" data-b="edit" aria-label="Edit link" data-tip="Edit link">${ic('pencil')}</button>`
      + `<button type="button" class="dui-btn" data-b="remove" aria-label="Remove link" data-tip="Remove link">${ic('unlink')}</button>`;
    lb.hidden = true;
    lb.addEventListener('mousedown', e => { if (!e.target.closest('a')) e.preventDefault(); });
    lb.addEventListener('click', e => {
      const b = e.target.closest('[data-b]');
      if (!b) return;
      hideTip();
      const url = lb._url;
      if (b.dataset.b === 'open') { if (url) window.open(url, '_blank', 'noopener,noreferrer'); }
      else if (b.dataset.b === 'edit') openLink({ edit: true });
      else if (b.dataset.b === 'remove') { act('removeLink'); hideBubbles(); }
    });
    const ib = el('div', 'dui-bubble dui-ibub');
    ib.innerHTML = `<div class="dui-seg" role="group" aria-label="Image size">${IMG_SIZES.map(([v, l]) => `<button type="button" data-size="${v}" aria-pressed="false">${l}</button>`).join('')}</div>`
      + `<span class="dui-vsep"></span><button type="button" class="dui-bb" data-b="alt">${ic('alt')}<span>Alt text</span></button>`;
    ib.hidden = true;
    ib.addEventListener('mousedown', e => e.preventDefault());
    ib.addEventListener('click', e => {
      const s = e.target.closest('[data-size]');
      if (s) { act('imageSize', s.dataset.size); scheduleBubbles(); return; }
      if (e.target.closest('[data-b=alt]')) openAltText();
    });
    M.layer.append(lb, ib);
    M.lb = lb; M.ib = ib;
  }
  function hideBubbles() { if (M) { if (M.lb) M.lb.hidden = true; if (M.ib) M.ib.hidden = true; } }
  function scheduleBubbles() {
    if (!M || rafBub) return;
    rafBub = requestAnimationFrame(() => { rafBub = 0; syncBubbles(); });
  }
  function placeBubble(b, r) {
    b.hidden = false;
    b.style.left = '0px'; b.style.top = '0px';
    const w = b.offsetWidth, ht = b.offsetHeight;
    let y = r.bottom + 8;
    if (y + ht > innerHeight - 8) y = r.top - ht - 8;
    y = Math.max(8, Math.min(y, innerHeight - ht - 8));
    const x = Math.max(8, Math.min(r.left, VW() - w - 8));
    b.style.left = Math.round(x) + 'px'; b.style.top = Math.round(y) + 'px';
  }
  function syncBubbles() {
    if (!M || !M.lb) return;
    const ok = !stack.length && !modalOpen() && editorFocused();
    const link = ok && !S.onImage && typeof one(F().link) === 'string';
    const img = ok && !!S.onImage && can();
    const r = (link || img) ? selectionRect() : null;
    if (link && r) {
      const ln = call('getLink');
      const url = cleanLink((ln && ln.url) || one(F().link)) || '';
      if (M.lb._url !== url) {
        M.lb._url = url;
        const a = M.lb.querySelector('.dui-lb-url');
        a.href = url || '#';
        a.textContent = url.replace(/^(https?:\/\/|mailto:)/i, '').replace(/\/$/, '');
        a.title = url;
      }
      M.lb.querySelectorAll('[data-b=edit], [data-b=remove]').forEach(b => { b.hidden = !can(); });
      M.lb.querySelector('.dui-vsep').hidden = false;
      placeBubble(M.lb, r);
    } else M.lb.hidden = true;
    if (img && r) {
      const cur = curImgSize();
      M.ib.querySelectorAll('[data-size]').forEach(b => setAttr(b, 'aria-pressed', String(b.dataset.size === cur)));
      placeBubble(M.ib, r);
    } else M.ib.hidden = true;
  }

  /* ====================== dialogs (the app's modal) ====================== */
  function openDlg({ title, sub, body, footer, wide }) {
    if (typeof window.openModal !== 'function') return false;
    closeAll();
    hideBubbles();
    window.openModal({ title: h(title), sub: sub ? h(sub) : '', body, footer: footer || '', wide: !!wide, onClose: () => { refocus(); scheduleBubbles(); } });
    return true;
  }
  const byId = id => document.getElementById(id);
  const closeDlg = () => { if (typeof window.closeModal === 'function') window.closeModal(); };

  // On unless the student turned it off (Tools → Word count)
  function wcFloatOn() { return lsGet('visor-wc-float') !== '0'; }
  function openWordCount() {
    if (!M) return;
    const wc = call('wordCount') || {};
    const sel = wc.selection && S.hasSelection !== false && (Number(wc.selection.chars) > 0 || Number(wc.selection.words) > 0) ? wc.selection : null;
    const num = v => (Number(v) || 0).toLocaleString();
    const row = (label, total, part) => `<tr><th scope="row">${label}</th><td>${part != null ? `<b>${num(part)}</b> of ${num(total)}` : `<b>${num(total)}</b>`}</td></tr>`;
    const body = `<div class="dui-dlg dui-wc"><table class="dui-wc-t"><tbody>`
      + row('Pages', wc.pages)
      + row('Words', wc.words, sel ? sel.words : null)
      + row('Characters', wc.chars, sel ? sel.chars : null)
      + row('Characters excluding spaces', wc.charsNoSpaces, sel ? sel.charsNoSpaces : null)
      + `</tbody></table><label class="dui-switch-row"><input type="checkbox" class="dui-switch" id="duiWcFloat"${wcFloatOn() ? ' checked' : ''}><span>Display word count while typing</span></label></div>`;
    if (!openDlg({ title: 'Word count', body, footer: '<button type="button" class="btn btn-primary" id="duiWcOk">OK</button>' })) return;
    byId('duiWcFloat').addEventListener('change', e => { lsSet('visor-wc-float', e.target.checked ? '1' : '0'); renderFloat(); });
    byId('duiWcOk').addEventListener('click', closeDlg);
    byId('duiWcOk').focus();
  }

  function openSpecialChars() {
    if (!M || !can()) return;
    const body = `<div class="dui-dlg dui-sc">${SPECIAL.map(([name, chars]) => `<div class="dui-sc-g"><div class="dui-sc-h">${h(name)}</div><div class="dui-sc-grid">`
      + chars.split(' ').map(c => `<button type="button" class="dui-sc-c" data-ch="${h(c)}" aria-label="${h(CHAR_NAMES[c] || c)}" title="${h(CHAR_NAMES[c] || c)}">${h(c)}</button>`).join('')
      + `</div></div>`).join('')}</div>`;
    if (!openDlg({ title: 'Special characters', sub: 'Click a character to add it where your cursor is.', body, wide: false,
      footer: '<button type="button" class="btn btn-primary" id="duiScDone">Done</button>' })) return;
    const box = document.querySelector('#modalRoot .dui-sc');
    // The dialog stays open, as in Docs: each click inserts at the caret (the
    // writer puts the essay's selection back, inserts, and moves the caret on)
    box.addEventListener('click', e => {
      const b = e.target.closest('[data-ch]');
      if (!b) return;
      if (!can()) { closeDlg(); return; }
      run('specialChar', b.dataset.ch);
      if (b.isConnected) b.focus({ preventScroll: true });
    });
    byId('duiScDone').addEventListener('click', closeDlg);
    box.addEventListener('keydown', e => {
      const all = [...box.querySelectorAll('.dui-sc-c')], i = all.indexOf(document.activeElement);
      if (i < 0 || !/^Arrow/.test(e.key)) return;
      e.preventDefault();
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { const t = all[i + (e.key === 'ArrowRight' ? 1 : -1)]; if (t) t.focus(); return; }
      // Up and down: the nearest button in the row above or below
      const me = all[i].getBoundingClientRect(), down = e.key === 'ArrowDown';
      let best = null, bd = Infinity;
      for (const b of all) {
        const r = b.getBoundingClientRect(), dy = down ? r.top - me.top : me.top - r.top;
        if (dy < 4) continue;
        const d = dy * 1000 + Math.abs(r.left - me.left);
        if (d < bd) { bd = d; best = b; }
      }
      if (best) best.focus();
    });
    const f = box.querySelector('.dui-sc-c'); if (f) f.focus();
  }

  function openAltText() {
    if (!M || !can()) return;
    const cur = imgSel();
    if (!cur && !S.onImage) { say('Click an image first.'); return; }
    const body = `<div class="dui-dlg dui-alt"><label class="dui-alt-l" for="duiAlt">Description</label>`
      + `<textarea class="input" id="duiAlt" maxlength="300" rows="4" placeholder="For example: A bar chart of rainfall in each month of 2025">${h((cur && cur.alt) || '')}</textarea>`
      + `<div class="dui-alt-n" id="duiAltN"></div></div>`;
    if (!openDlg({ title: 'Alt text', sub: 'Describe the image for people who use a screen reader.', body,
      footer: '<button type="button" class="btn btn-ghost" id="duiAltCancel">Cancel</button><button type="button" class="btn btn-primary" id="duiAltSave">Save</button>' })) return;
    const ta = byId('duiAlt'), n = byId('duiAltN');
    const count = () => { n.textContent = `${ta.value.length} / 300`; };
    count();
    ta.addEventListener('input', count);
    const save = () => { const v = ta.value.replace(/\s+/g, ' ').trim().slice(0, 300); closeDlg(); act('imageAlt', v); };
    byId('duiAltSave').addEventListener('click', save);
    byId('duiAltCancel').addEventListener('click', closeDlg);
    ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); save(); } });
    ta.focus();
    ta.select();
  }

  function openShortcuts() {
    if (!M) return;
    const groups = [
      ['Common actions', [['Undo', 'mod+z'], ['Redo', 'mod+shift+z'], ['Cut', 'mod+x'], ['Copy', 'mod+c'], ['Paste', 'mod+v'], ['Select all', 'mod+a'],
        ['Find', 'mod+f'], ['Find and replace', 'mod+shift+h'], ['Find next', 'mod+g'], ['Find previous', 'mod+shift+g'], ['Print', 'mod+p'],
        ['Insert link', 'mod+k'], ['Word count', 'mod+shift+c'], ['Keyboard shortcuts', 'mod+/']]],
      ['Text formatting', [['Bold', 'mod+b'], ['Italic', 'mod+i'], ['Underline', 'mod+u'], ['Strikethrough', 'mod+shift+x'], ['Superscript', 'mod+.'], ['Subscript', 'mod+,'],
        ['Increase font size', 'mod+shift+.'], ['Decrease font size', 'mod+shift+,'], ['Clear formatting', 'mod+\\']]],
      ['Paragraphs', [['Normal text', 'mod+alt+0'], ['Heading 1', 'mod+alt+1'], ['Heading 2', 'mod+alt+2'], ['Heading 3', 'mod+alt+3'],
        ['Align left', 'mod+shift+l'], ['Align center', 'mod+shift+e'], ['Align right', 'mod+shift+r'], ['Justify', 'mod+shift+j'],
        ['Increase indent', 'mod+]'], ['Decrease indent', 'mod+['], ['Numbered list', 'mod+shift+7'], ['Bulleted list', 'mod+shift+8'], ['Checklist', 'mod+shift+9']]],
      ['Menus', [['Open the File menu', MAC ? 'ctrl+alt+f' : 'alt+f'], ['Open the Format menu', MAC ? 'ctrl+alt+o' : 'alt+o'], ['Move between menus', null, '← →'], ['Close a menu', null, 'Esc']]]
    ];
    const body = `<div class="dui-dlg dui-keys">${groups.map(([g, rows]) => `<div class="dui-keys-g"><h4>${h(g)}</h4><table><tbody>`
      + rows.map(([l, sc, raw]) => `<tr><td>${h(l)}</td><td><kbd>${h(raw || scText(sc))}</kbd></td></tr>`).join('')
      + `</tbody></table></div>`).join('')}</div>`;
    if (!openDlg({ title: 'Keyboard shortcuts', body, wide: true, footer: '<button type="button" class="btn btn-primary" id="duiKeysOk">Done</button>' })) return;
    byId('duiKeysOk').addEventListener('click', closeDlg);
    byId('duiKeysOk').focus({ preventScroll: true });
  }

  /* ====================== find and replace ====================== */
  const FD = { open: false, mode: 'find', lastQ: null, lastCase: null, res: { count: 0, current: 0 }, zeroBased: null, seq: 0, timer: 0 };
  function buildFind() {
    const f = el('div', 'dui-find');
    f.setAttribute('role', 'dialog');
    f.setAttribute('aria-label', 'Find and replace');
    f.hidden = true;
    f.innerHTML = `<div class="dui-fd-row">`
      + `<div class="dui-fd-field"><input class="dui-fd-q" type="text" placeholder="Find in document" aria-label="Find in document" autocomplete="off" spellcheck="false"><span class="dui-fd-n" aria-live="polite"></span></div>`
      + `<button type="button" class="dui-btn" data-f="prev" aria-label="Previous match" data-tip="Previous (⇧Enter)">${ic('up')}</button>`
      + `<button type="button" class="dui-btn" data-f="next" aria-label="Next match" data-tip="Next (Enter)">${ic('down')}</button>`
      + `<button type="button" class="dui-btn" data-f="mode" aria-label="Replace" aria-expanded="false" data-tip="${h(tipText('Find and replace', 'mod+shift+h'))}">${ic('replace')}</button>`
      + `<button type="button" class="dui-btn" data-f="close" aria-label="Close find" data-tip="Close (Esc)">${ic('x')}</button></div>`
      + `<div class="dui-fd-rep"><div class="dui-fd-field"><input class="dui-fd-r" type="text" placeholder="Replace with" aria-label="Replace with" autocomplete="off" spellcheck="false"></div></div>`
      + `<div class="dui-fd-foot"><label class="dui-fd-case"><input type="checkbox" class="dui-fd-mc"> Match case</label><span class="dui-spacer"></span>`
      + `<button type="button" class="dui-fbtn" data-f="replace">Replace</button><button type="button" class="dui-fbtn is-primary" data-f="all">Replace all</button></div>`;
    const q = f.querySelector('.dui-fd-q'), r = f.querySelector('.dui-fd-r'), mc = f.querySelector('.dui-fd-mc');
    M.fd = { el: f, q, r, mc, n: f.querySelector('.dui-fd-n') };
    f.addEventListener('mousedown', e => { if (!isField(e.target)) e.preventDefault(); });
    f.addEventListener('click', e => {
      const b = e.target.closest('[data-f]');
      if (!b || b.getAttribute('aria-disabled') === 'true' || b.disabled) return;
      hideTip();
      const k = b.dataset.f;
      if (k === 'prev') step(-1);
      else if (k === 'next') step(1);
      else if (k === 'close') closeFind(true);
      else if (k === 'mode') { setFindMode(FD.mode === 'replace' ? 'find' : 'replace'); (FD.mode === 'replace' ? r : q).focus(); }
      else if (k === 'replace') doReplace();
      else if (k === 'all') doReplaceAll();
    });
    q.addEventListener('input', () => { clearTimeout(FD.timer); FD.timer = setTimeout(doFind, 140); });
    mc.addEventListener('change', () => doFind());
    q.addEventListener('keydown', e => {
      if (e.isComposing) return;
      if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
      else if (e.key === 'Escape') { e.preventDefault(); closeFind(true); }
      else if (e.key === 'Tab' && !e.shiftKey && FD.mode === 'replace') { e.preventDefault(); r.focus(); r.select(); }
    });
    r.addEventListener('keydown', e => {
      if (e.isComposing) return;
      if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); q.focus(); q.select(); }
      else if (e.key === 'Enter') { e.preventDefault(); doReplace(); }
      else if (e.key === 'Escape') { e.preventDefault(); closeFind(true); }
    });
    f.addEventListener('keydown', e => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); closeFind(true); } });
    (M.canvas || M.layer).appendChild(f);
  }
  function setFindMode(mode) {
    FD.mode = mode;
    const f = M.fd.el;
    setCls(f, 'is-replace', mode === 'replace');
    setAttr(f.querySelector('[data-f=mode]'), 'aria-expanded', String(mode === 'replace'));
    renderFind();
    placeFind();
  }
  function openFind(mode) {
    if (!M) return;
    if (!M.fd) buildFind();
    closeAll();
    hideBubbles();
    let pre = '';
    if (editorFocused()) { try { pre = String(window.getSelection() || '').trim(); } catch { /* none */ } }
    if (pre && pre.length <= 120 && !/\n/.test(pre)) M.fd.q.value = pre;
    const was = FD.open;
    FD.open = true;
    M.fd.el.hidden = false;
    setFindMode(mode === 'replace' && can() ? 'replace' : was ? FD.mode : 'find');
    M.fd.q.focus();
    M.fd.q.select();
    if (M.fd.q.value && (M.fd.q.value !== FD.lastQ || M.fd.mc.checked !== FD.lastCase)) doFind();
  }
  function closeFind(back) {
    if (!M || !FD.open) return;
    FD.open = false;
    clearTimeout(FD.timer);
    FD.seq++;
    FD.lastQ = null;
    M.fd.el.hidden = true;
    call('clearFind');
    if (back) refocus();
  }
  // The writer may move focus into the editor to show a match: the find box keeps it
  function keepFindFocus(had) {
    if (M && M.fd && had && had !== document.activeElement && M.fd.el.contains(had) && had.isConnected) had.focus({ preventScroll: true });
  }
  function findCall(name, ...args) {
    const had = document.activeElement;
    const r = call(name, ...args);
    keepFindFocus(had);
    return r;
  }
  function findResult(r, after) {
    const seq = ++FD.seq;
    Promise.resolve(r).then(res => {
      if (!M || seq !== FD.seq || !FD.open) return;
      const count = Math.max(0, parseInt(res && res.count, 10) || 0);
      const current = Math.max(0, parseInt(res && res.current, 10) || 0);
      if (count > 0 && current === count) FD.zeroBased = false;
      else if (count > 0 && current === 0 && after === 'step') FD.zeroBased = true;
      FD.res = { count, current };
      renderFind();
    }, () => {});
  }
  function doFind() {
    if (!M || !FD.open) return;
    clearTimeout(FD.timer);
    const q = M.fd.q.value, mc = M.fd.mc.checked;
    FD.lastQ = q; FD.lastCase = mc;
    if (!q) { FD.seq++; call('clearFind'); FD.res = { count: 0, current: 0 }; renderFind(); return; }
    findResult(findCall('find', q, { matchCase: mc }), 'find');
  }
  function stale() { return M.fd.q.value !== FD.lastQ || M.fd.mc.checked !== FD.lastCase; }
  function step(dir) {
    if (!M || !FD.open) return;
    if (stale()) { doFind(); return; }
    if (!FD.res.count) return;
    findResult(findCall('findStep', dir), 'step');
  }
  function doReplace() {
    if (!M || !FD.open || !can()) return;
    if (stale()) { doFind(); return; }
    if (!FD.res.count) return;
    findResult(findCall('replace', M.fd.r.value), 'step');
  }
  function doReplaceAll() {
    if (!M || !FD.open || !can()) return;
    const q = M.fd.q.value;
    if (!q) return;
    if (stale()) doFind();
    const rep = M.fd.r.value;
    Promise.resolve(findCall('replaceAll', rep)).then(res => {
      if (!M) return;
      const n = Math.max(0, parseInt(res && res.replaced, 10) || 0);
      say(n ? `Replaced ${n === 1 ? '1 match' : n.toLocaleString() + ' matches'}.` : 'Nothing to replace.');
      if (FD.open) { FD.lastQ = null; doFind(); }
    }, () => {});
  }
  function renderFind() {
    if (!M || !M.fd) return;
    const { count, current } = FD.res, q = M.fd.q.value;
    const shown = FD.zeroBased === true || (FD.zeroBased === null && current === 0 && count > 0) ? current + 1 : current;
    setText(M.fd.n, !q || FD.lastQ === null ? '' : count ? `${Math.min(shown, count)} of ${count}` : 'No results');
    const none = !count;
    M.fd.el.querySelectorAll('[data-f=prev], [data-f=next]').forEach(b => setAttr(b, 'aria-disabled', none ? 'true' : null));
    const ro = !can();
    M.fd.el.querySelectorAll('[data-f=replace], [data-f=all]').forEach(b => { b.disabled = ro || none; });
    setAttr(M.fd.el.querySelector('[data-f=mode]'), 'aria-disabled', ro ? 'true' : null);
    M.fd.r.readOnly = ro;
    if (ro && FD.mode === 'replace') { FD.mode = 'find'; setCls(M.fd.el, 'is-replace', false); }
  }
  function placeFind() {
    if (!M || !M.fd || !FD.open) return;
    const f = M.fd.el;
    const vw = VW();
    const cv = M.canvas && M.canvas.isConnected ? M.canvas.getBoundingClientRect() : { left: 0, right: vw, top: 0 };
    const tb = M.toolbarSlot && M.toolbarSlot.isConnected ? M.toolbarSlot.getBoundingClientRect() : null;
    const top = Math.max(8, (tb && tb.height ? tb.bottom : Math.max(0, cv.top)) + 8);
    const right = Math.max(8, vw - Math.min(cv.right, vw) + (M.compact ? 8 : 16));
    f.style.top = Math.round(top) + 'px';
    f.style.right = Math.round(right) + 'px';
    f.style.maxWidth = Math.max(240, Math.min(360, vw - 16)) + 'px';
  }

  /* ====================== the outline ====================== */
  function buildOutline() {
    const o = el('div', 'dui-outline');
    o.innerHTML = `<div class="dui-ol-head"><span>Outline</span><button type="button" class="dui-btn" data-o="close" aria-label="Close outline" data-tip="Close outline">${ic('x')}</button></div>`
      + `<nav class="dui-ol-list" aria-label="Document outline"></nav><p class="dui-ol-empty" hidden>Headings you add to the document will appear here.</p>`;
    o.addEventListener('mousedown', e => e.preventDefault());
    o.addEventListener('click', e => {
      if (e.target.closest('[data-o=close]')) { hideTip(); setOutline(false); return; }
      const b = e.target.closest('.dui-ol-item');
      if (!b) return;
      run('gotoIndex', Number(b.dataset.index));
      refocus();
    });
    M.ol = { el: o, list: o.querySelector('.dui-ol-list'), empty: o.querySelector('.dui-ol-empty'), key: null };
    return o;
  }
  function setOutline(open) {
    const r = run('outline', !!open);
    if (r !== false && M) { S.outlineOpen = !!open; renderOutline(true); refreshMenus(); }
    refocus();
  }
  function renderOutline(now) {
    if (!M || !M.outline || !M.ol) return;
    const open = !!S.outlineOpen && !M.compact;
    setCls(M.outline, 'hidden', !open);
    M.ol.el.hidden = !open;
    if (!open) return;
    clearTimeout(M.olT);
    if (now) fillOutline(); else M.olT = setTimeout(fillOutline, 250);
  }
  function fillOutline() {
    if (!M || !M.ol) return;
    const raw = call('getOutline');
    const list = Array.isArray(raw) ? raw.filter(x => x && String(x.text || '').trim()) : [];
    const key = JSON.stringify(list.map(x => [x.level, x.text, x.index]));
    if (key === M.ol.key) return;
    M.ol.key = key;
    M.ol.empty.hidden = list.length > 0;
    M.ol.list.innerHTML = list.map(x => {
      const lv = x.level === 'title' || x.level === 'subtitle' ? x.level : 'h' + (Number(x.level) || 1);
      const text = String(x.text).replace(/\s+/g, ' ').trim();
      return `<button type="button" class="dui-ol-item dui-ol-${lv}" data-index="${Number(x.index) || 0}" title="${h(text)}">${h(text)}</button>`;
    }).join('');
  }

  /* ====================== the floating word count ====================== */
  function buildFloat() {
    const c = el('button', 'dui-wc-float');
    c.type = 'button';
    c.dataset.tip = 'Word count';
    c.hidden = true;
    c.addEventListener('mousedown', e => e.preventDefault());
    c.addEventListener('click', () => { hideTip(); openWordCount(); });
    M.layer.appendChild(c);
    M.float = c;
  }
  function renderFloat() {
    if (!M || !M.float) return;
    const wl = wordsText();
    const on = !M.opts.wcChip && wcFloatOn() && !!wl;
    M.float.hidden = !on;
    if (on) setText(M.float, wl);
  }

  /* ====================== global listeners ====================== */
  // The physical key ("KeyF"), falling back to the character when a synthetic event has no code
  function codeOf(e) {
    if (e.code) return e.code;
    const k = String(e.key || '');
    if (/^[a-z]$/i.test(k)) return 'Key' + k.toUpperCase();
    return { '/': 'Slash', '?': 'Slash', '\\': 'Backslash' }[k] || '';
  }
  function onKey(e) {
    if (!M) return;
    keyFromEditor = false;
    const top = stack[stack.length - 1];
    if (top && top.kind === 'menu' && menuKey(e, top)) return;
    if (top && top.kind === 'pop' && e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      closeLayersFrom(top.idx);
      if (top.kb && top.anchorEl && top.anchorEl.isConnected && top.escTo !== 'editor' && top.anchorEl.matches('button')) top.anchorEl.focus();
      else refocus();
      return;
    }
    if (e.key === 'Escape' && myDialogOpen()) { e.preventDefault(); e.stopPropagation(); closeDlg(); return; }
    if (modalOpen() || e.isComposing) return;
    const mod = MAC ? e.metaKey : e.ctrlKey;
    if (mod && !e.altKey && !(MAC && e.ctrlKey)) {
      const c = codeOf(e), sh = e.shiftKey;
      if (c === 'KeyF' && !sh) openFind('find');
      else if (c === 'KeyH' && (sh || !MAC)) openFind('replace');
      else if (c === 'KeyG' && FD.open) step(sh ? -1 : 1);
      else if (c === 'KeyK' && !sh && editorFocused() && can()) openLink();
      else if (c === 'KeyC' && sh) openWordCount();
      else if (c === 'KeyP' && !sh) act('print');
      else if (c === 'Slash' && !sh) openShortcuts();
      else return;
      e.preventDefault(); e.stopPropagation();
      return;
    }
    // Menu access keys: Alt+F on Windows and Chromebooks, Ctrl+Option+F on a Mac
    const access = MAC ? (e.ctrlKey && e.altKey && !e.metaKey) : (e.altKey && !e.ctrlKey && !e.metaKey);
    if (access && !e.shiftKey) {
      const key = { KeyF: 'file', KeyE: 'edit', KeyV: 'view', KeyI: 'insert', KeyO: 'format', KeyT: 'tools' }[codeOf(e)];
      const btns = M.barBtns && M.barBtns[0] && M.barBtns[0].offsetParent !== null ? M.barBtns : null;
      const b = key && btns && btns.find(x => x.dataset.menu === key);
      if (!b) return;
      e.preventDefault(); e.stopPropagation();
      const fromEditor = editorFocused() || keyFromEditor;
      closeAll();
      openBarMenu(b, true, false, fromEditor);
    }
  }
  function onDown(e) {
    if (!M) return;
    hideTip();
    if (!stack.length) return;
    const t = e.target;
    let keep = -1;
    for (let i = stack.length - 1; i >= 0; i--) {
      const L = stack[i];
      if (L.el.contains(t) || (L.anchorEl && L.anchorEl.contains(t))) { keep = i; break; }
    }
    closeLayersFrom(keep + 1);
  }
  function schedulePlace() {
    if (!M || rafPos) return;
    rafPos = requestAnimationFrame(() => {
      rafPos = 0;
      if (!M) return;
      for (const L of stack.slice()) if (!L.closed) place(L);
      placeFind();
      syncBubbles();
    });
  }
  function onScroll() { hideTip(); schedulePlace(); }
  function onResize() { hideTip(); schedulePlace(); scheduleLayout(); }
  function onFocusChange(e) {
    if (e && e.type === 'focusout') noteSel(e.target);
    scheduleBubbles();
    scheduleSelPaint();
  }

  /* ---- the essay's selection stays visible while a field here has focus ----
     A blurred contenteditable shows no selection, so while the link popover, the
     size box or the find box has focus, the text it acts on is painted (CSS
     Custom Highlight API, as find's matches are) and cleared when focus leaves. */
  const SEL_HL = 'dui-sel';
  // As focus leaves the essay its selection is still in place: keep it (a live
  // Range follows later edits), or nothing when it's only a caret
  function noteSel(from) {
    const ed = M && from && from.closest ? from.closest('.ql-editor') : null;
    if (!ed) return;
    let s = null;
    try { s = window.getSelection(); } catch { /* none */ }
    const r = s && s.rangeCount ? s.getRangeAt(0) : null;
    M.selRange = r && !r.collapsed && ed.contains(r.commonAncestorContainer) ? r.cloneRange() : null;
  }
  function uiField(t) {
    if (!M || !t || !t.matches || !t.matches('input, textarea')) return false;
    return M.layer.contains(t) || (!!M.fd && M.fd.el.contains(t)) || M.roots.some(x => x.contains(t));
  }
  function scheduleSelPaint() {
    if (!M || M.selRaf) return;
    M.selRaf = requestAnimationFrame(() => { if (M) { M.selRaf = 0; paintSel(); } });
  }
  function paintSel() {
    const reg = window.CSS && CSS.highlights;
    if (!M || !reg || typeof window.Highlight !== 'function') return;
    const r = M.selRange;
    const own = reg.get('dx-sel');   // the writer may paint it itself: then don't paint it twice
    const want = !!r && !r.collapsed && r.startContainer.isConnected && uiField(document.activeElement) && !(own && own.size);
    try {
      if (!want) { if (M.selPainted) { reg.delete(SEL_HL); M.selPainted = null; } return; }
      if (M.selPainted === r && reg.has(SEL_HL)) return;
      const hl = new Highlight(r);
      hl.priority = -1;   // under find's matches
      reg.set(SEL_HL, hl);
      M.selPainted = r;
    } catch { /* no highlight support */ }
  }

  /* ====================== mount, update, unmount ====================== */
  function resolve(x, id) {
    if (x && x.nodeType === 1) return x;
    if (typeof x === 'string' && x) return document.getElementById(x.replace(/^#/, '')) || document.querySelector(x);
    return id ? document.getElementById(id) : null;
  }
  function renderAll() {
    if (!M) return;
    renderToolbar();
    refreshMenus();
    renderOutline(false);
    renderFloat();
    if (FD.open) renderFind();
    // A locked editor closes the popovers that would change it
    if (!can()) { const i = stack.findIndex(L => L.edits); if (i > -1) closeLayersFrom(i); }
    scheduleBubbles();
  }

  function mount(opts) {
    if (M) unmount();
    opts = opts || {};
    const o = Object.assign({}, opts.callbacks || {}, opts);
    const slots = opts.slots || {};
    const init = Object.assign({}, opts.initial || {}, opts.state || {}, opts);
    M = {
      opts: o,
      compact: !!o.compact,
      menubarSlot: resolve(slots.menubar || o.menubar, 'dxMenubar'),
      toolbarSlot: resolve(slots.toolbar || o.toolbar, 'dxToolbar'),
      outline: resolve(slots.outline || o.outline, 'dxOutline'),
      canvas: resolve(slots.canvas || o.canvas, 'dxCanvas'),
      layer: el('div', 'dui-layer'),
      tip: el('div', 'dui-tip'),
      roots: [],
      layoutQueued: false
    };
    S = {
      canEdit: true, canUndo: true, canRedo: true, formats: {}, inTable: false, onImage: false, hasSelection: false,
      zoom: init.zoom ?? 1, pageBreaks: init.pageBreaks !== false, spellcheck: init.spellcheck !== false, outlineOpen: !!init.outlineOpen,
      wordsLabel: '', sourcesCount: 0, citationAllowed: false, docStyle: init.docStyle === 'docs' ? 'docs' : 'mla'
    };
    FD.open = false; FD.res = { count: 0, current: 0 }; FD.lastQ = null; FD.zeroBased = null; FD.mode = 'find';
    M.tip.setAttribute('role', 'tooltip');
    M.layer.appendChild(M.tip);
    document.body.appendChild(M.layer);
    if (M.compact) document.body.classList.add('dui-compact-mode');

    if (M.menubarSlot && !M.compact) { const bar = buildMenubar(); M.menubarSlot.appendChild(bar); M.roots.push(bar); }
    if (M.toolbarSlot) {
      const tb = buildToolbar();
      M.toolbarSlot.appendChild(tb);
      M.roots.push(tb);
      if (typeof ResizeObserver === 'function') { M.ro = new ResizeObserver(() => scheduleLayout()); M.ro.observe(tb); }
    }
    if (M.outline && !M.compact) { const ol = buildOutline(); M.outline.appendChild(ol); M.roots.push(ol); }
    buildBubbles();
    buildFloat();

    M.on = [
      [window, 'keydown', onKey, true],
      [window, 'mousedown', onDown, true],
      [window, 'scroll', onScroll, { capture: true, passive: true }],
      [window, 'resize', onResize, false],
      [document, 'focusin', onFocusChange, false],
      [document, 'focusout', onFocusChange, false],
      [document, 'mouseover', onTipOver, false]
    ];
    for (const [t, ev, fn, opt] of M.on) t.addEventListener(ev, fn, opt);

    renderAll();
    renderOutline(true);
    if (M.T) layoutToolbar();
    return true;
  }

  function update(state) {
    if (!M || !state || typeof state !== 'object') return;
    const wasEdit = can();
    Object.assign(S, state);
    if ('formats' in state) S.formats = state.formats && typeof state.formats === 'object' ? state.formats : {};
    if (state.docStyle !== undefined) S.docStyle = state.docStyle === 'docs' ? 'docs' : 'mla';
    // The writer re-runs the search after edits: its live count replaces ours, but
    // only for the query it searched (not one still being typed, before the debounce)
    if (state.find && typeof state.find === 'object' && FD.open && M.fd && FD.lastQ && !stale()) {
      const count = Math.max(0, parseInt(state.find.count, 10) || 0);
      const current = Math.max(0, Math.min(count, parseInt(state.find.current, 10) || 0));
      FD.res = { count, current };
      if (count > 0) FD.zeroBased = false;   // the writer's current is 1-based (0 only with no matches)
    }
    renderAll();
    if (wasEdit && !can()) hideTip();
  }

  function close(what) {
    if (!M) return;
    closeAll();
    hideTip();
    hideBubbles();
    if (myDialogOpen()) closeDlg();
    if (what === 'all' || (what && what.find)) closeFind(false);
  }

  function unmount() {
    if (!M) return;
    const m = M;
    closeAll();
    hideTip();
    if (myDialogOpen()) closeDlg();
    if (FD.open) { FD.open = false; call('clearFind'); }
    clearTimeout(FD.timer); clearTimeout(m.olT); clearTimeout(hoverT); clearTimeout(tipT);
    if (rafPos) cancelAnimationFrame(rafPos);
    if (rafBub) cancelAnimationFrame(rafBub);
    if (m.selRaf) cancelAnimationFrame(m.selRaf);
    try { if (m.selPainted && window.CSS && CSS.highlights) CSS.highlights.delete(SEL_HL); } catch { /* none */ }
    rafPos = 0; rafBub = 0;
    for (const [t, ev, fn, opt] of m.on || []) t.removeEventListener(ev, fn, opt);
    if (m.ro) m.ro.disconnect();
    for (const r of m.roots) r.remove();
    if (m.fd) m.fd.el.remove();
    m.layer.remove();
    document.body.classList.remove('dui-compact-mode');
    M = null;
    S = {};
    FD.seq++;
  }

  window.DocsUI = {
    mount, update, unmount, close,
    openFind: mode => openFind(mode),
    openLink: () => openLink(),
    openWordCount: () => openWordCount(),
    openSpecialChars: () => openSpecialChars(),
    openAltText: () => openAltText(),
    openShortcuts: () => openShortcuts(),
    isOpen: () => !!M && (stack.length > 0 || myDialogOpen() || FD.open),
    get mounted() { return !!M; }
  };
})();
