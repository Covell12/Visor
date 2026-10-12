// public/doc-format.js (lib/doc-format.js on the server): checking formats, the
// formatting runs, stored document <-> Quill delta, and their speed.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const D = require('../lib/doc-format.js');
const W = require('../lib/writing');

const E = D.EMBED;
const ID = 'a1'.repeat(16);

// A seeded random source, so a failure can be reproduced
function rng(seed) {
  return n => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor((seed / 2147483648) * n); };
}
const ATTR_POOL = [
  { bold: true }, { bold: null }, { italic: true }, { italic: false }, { color: '#ff0000' }, { color: '#00ff00' }, { color: null },
  { size: '14pt', font: 'Georgia' }, { link: 'https://a.example' }, { header: 1 }, { header: null }, { list: 'bullet' },
  { align: 'center', lineheight: '2' }, { table: 'row-a' }, { table: 'row-b' }, { strike: true, script: 'super' }
];
// Merge attrs the way runs do: later wins, null removes
function apply(into, attrs) {
  const m = { ...into };
  for (const [k, v] of Object.entries(attrs || {})) { if (v == null || v === false) delete m[k]; else m[k] = v; }
  return m;
}
const clean = attrs => apply({}, attrs);
const eq = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
// Per-character attrs -> segments, the slow obvious way
function group(per) {
  const out = [];
  per.forEach((a, i) => {
    const last = out[out.length - 1];
    if (last && eq(last.attrs, a)) last.len++;
    else out.push({ at: i, len: 1, attrs: a });
  });
  return out;
}
function naiveSegments(textLength, formats) {
  const per = Array.from({ length: textLength + 1 }, () => ({}));
  for (const r of formats) for (let i = Math.max(0, r.at); i < Math.min(per.length, r.at + r.len); i++) per[i] = apply(per[i], r.attrs);
  return group(per);
}

test('cleanValue checks every key', () => {
  const ok = (k, v, want) => assert.deepStrictEqual(D.cleanValue(k, v), want, `${k}: ${JSON.stringify(v)}`);
  // null and false remove any known key; unknown keys are dropped
  for (const k of [...D.INLINE_KEYS, ...D.BLOCK_KEYS, ...D.EMBED_KEYS]) { ok(k, null, null); ok(k, false, null); }
  ok('foo', true, undefined); ok('__proto__', true, undefined); ok('constructor', null, undefined);
  for (const k of ['bold', 'italic', 'underline', 'strike', 'title', 'subtitle']) { ok(k, true, true); ok(k, 'true', undefined); ok(k, 1, undefined); }
  ok('script', 'sub', 'sub'); ok('script', 'super', 'super'); ok('script', 'superscript', undefined);
  ok('font', 'Arial', 'Arial'); ok('font', '"times new roman"', 'Times New Roman'); ok('font', " 'Comic Sans MS' ", 'Comic Sans MS');
  ok('font', 'Arial, sans-serif', undefined); ok('font', 'serif', undefined); ok('font', 3, undefined);
  ok('size', '12pt', '12pt'); ok('size', '72pt', '72pt'); ok('size', '13pt', undefined); ok('size', 12, undefined); ok('size', 'large', undefined);
  ok('color', '#ABC', '#aabbcc'); ok('color', '#1a2B3c', '#1a2b3c'); ok('color', 'rgb(255, 0, 16)', '#ff0010'); ok('background', 'rgb(0,0,0)', '#000000');
  ok('color', 'red', undefined); ok('color', '#abcd', undefined); ok('color', 'rgb(256,0,0)', undefined); ok('color', 'rgba(0,0,0,0.5)', undefined); ok('background', 'url(x)', undefined);
  ok('link', ' https://example.com/a?b=1 ', 'https://example.com/a?b=1'); ok('link', 'http://x.example', 'http://x.example');
  ok('link', 'mailto:sam@example.com', 'mailto:sam@example.com'); ok('link', 'example.com/page', 'https://example.com/page');
  ok('link', 'www.example.org:8080', 'https://www.example.org:8080');
  for (const bad of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,hi', 'ftp://x.example', '//x.example', 'https:x', 'http://', 'mailto:', 'not a link', '', '   ', 'https://x.example/\u0000', 'https://' + 'a'.repeat(2048), 42]) ok('link', bad, undefined);
  ok('header', 1, 1); ok('header', '6', 6); ok('header', 7, undefined); ok('header', 0, undefined); ok('header', 2.5, undefined); ok('header', true, undefined);
  for (const v of ['bullet', 'ordered', 'checked', 'unchecked']) ok('list', v, v);
  ok('list', 'check', undefined);
  for (const v of ['center', 'right', 'justify']) ok('align', v, v);
  ok('align', 'left', undefined);
  ok('indent', 1, 1); ok('indent', '8', 8); ok('indent', 9, undefined); ok('indent', '+1', undefined);
  ok('lineheight', 1.15, '1.15'); ok('lineheight', '2', '2'); ok('lineheight', 1, '1'); ok('lineheight', 1.5, '1.5'); ok('lineheight', '1.38', undefined); ok('lineheight', true, undefined);
  ok('table', 'row-ab12', 'row-ab12'); ok('table', 'row-' + 'a'.repeat(16), 'row-' + 'a'.repeat(16)); ok('table', 'row-' + 'a'.repeat(17), undefined);
  ok('table', 1, undefined); ok('table', 'row-AB', undefined); ok('table', 'row-', undefined);
  ok('image', ID, ID); ok('image', ID.toUpperCase(), undefined); ok('image', ID.slice(1), undefined); ok('image', '/api/images/' + ID, undefined);
  ok('width', 320, '320'); ok('width', '16', '16'); ok('width', 2000, '2000'); ok('width', 15, undefined); ok('width', 2001, undefined); ok('width', '50%', undefined); ok('width', 300.5, undefined);
  ok('alt', 'A bar chart', 'A bar chart'); ok('alt', '', ''); ok('alt', 'x'.repeat(301), undefined); ok('alt', 5, undefined);
});

test('cleanAttrs keeps only the valid keys', () => {
  assert.strictEqual(D.cleanAttrs(null), null);
  assert.strictEqual(D.cleanAttrs('bold'), null);
  assert.strictEqual(D.cleanAttrs([true]), null);
  assert.strictEqual(D.cleanAttrs({ foo: 1, color: 'red' }), null);
  assert.deepStrictEqual(D.cleanAttrs({ bold: true, italic: false, header: '2', color: '#F00', foo: 1, table: 'row-1' }), { bold: true, italic: null, color: '#ff0000', header: 2, table: 'row-1' });
  assert.ok(D.QUILL_FORMATS.includes('image') && !D.QUILL_FORMATS.includes('width') && !D.QUILL_FORMATS.includes('alt'));
  assert.deepStrictEqual(D.QUILL_FORMATS, [...D.INLINE_KEYS, ...D.BLOCK_KEYS, 'image']);
  assert.ok(D.isBlockKey('table') && D.isBlockKey('lineheight') && !D.isBlockKey('bold'));
  assert.ok(D.isInlineKey('link') && !D.isInlineKey('header') && !D.isInlineKey('image'));
  assert.strictEqual(D.styleClass('docs'), 'doc-style-docs');
  assert.strictEqual(D.styleClass('mla'), 'doc-style-mla');
  assert.strictEqual(D.styleClass(undefined), 'doc-style-mla');
  assert.strictEqual(D.styleClass('fancy'), 'doc-style-mla');
  assert.deepStrictEqual(D.DOC_STYLES.docs, { label: 'Docs default', font: 'Arial', size: '11pt', lineheight: '1.15' });
});

test('wordCount: images aren’t words', () => {
  assert.strictEqual(D.wordCount(''), 0);
  assert.strictEqual(D.wordCount('  \n '), 0);
  assert.strictEqual(D.wordCount(E), 0);
  assert.strictEqual(D.wordCount('\n' + E + '\n'), 0);
  assert.strictEqual(D.wordCount('a ' + E + ' b'), 2);
  assert.strictEqual(D.wordCount('one' + E + 'two'), 2);
  assert.strictEqual(D.wordCount('Hello there,\nworld'), 3);
});

test('insertRuns splits a run around new text, which inherits nothing', () => {
  const bold = { bold: true };
  const runs = [{ at: 2, len: 4, attrs: bold }, { at: 0, len: 2, attrs: { italic: true } }, { at: 6, len: 1, attrs: { header: 1 } }];
  const frozen = JSON.stringify(runs);
  // Strictly inside [2, 6): split into [2, 4) and [7, 9)
  assert.deepStrictEqual(D.insertRuns(runs, 4, 3), [{ at: 2, len: 2, attrs: bold }, { at: 7, len: 2, attrs: bold }, { at: 0, len: 2, attrs: { italic: true } }, { at: 9, len: 1, attrs: { header: 1 } }]);
  // At a run's start it moves; at its end it stays as it is
  assert.deepStrictEqual(D.insertRuns(runs, 2, 1), [{ at: 3, len: 4, attrs: bold }, { at: 0, len: 2, attrs: { italic: true } }, { at: 7, len: 1, attrs: { header: 1 } }]);
  assert.deepStrictEqual(D.insertRuns(runs, 6, 1).slice(0, 2), runs.slice(0, 2));
  // With attrs, the new text gets exactly those
  assert.deepStrictEqual(D.insertRuns(runs, 4, 2, { bold: true, color: '#ff0000' }).at(-1), { at: 4, len: 2, attrs: { bold: true, color: '#ff0000' } });
  assert.strictEqual(D.insertRuns(runs, 4, 2, {}).length, 4);
  assert.strictEqual(JSON.stringify(runs), frozen, 'the input is never changed');
  // deleteRuns and formatRuns don't change their input either
  assert.deepStrictEqual(D.deleteRuns(runs, 1, 3), [{ at: 1, len: 2, attrs: bold }, { at: 0, len: 1, attrs: { italic: true } }, { at: 3, len: 1, attrs: { header: 1 } }]);
  assert.deepStrictEqual(D.deleteRuns(runs, 0, 7), []);
  assert.deepStrictEqual(D.formatRuns(runs, 1, 2, { strike: true }).at(-1), { at: 1, len: 2, attrs: { strike: true } });
  assert.strictEqual(D.formatRuns(runs, 1, 2, null).length, 3);
  assert.strictEqual(JSON.stringify(runs), frozen);
});

test('segments match a per-character reference on random runs', () => {
  const rnd = rng(11);
  for (let round = 0; round < 300; round++) {
    const L = rnd(40);
    const formats = Array.from({ length: rnd(14) }, () => ({ at: rnd(L + 6) - 2, len: 1 + rnd(12), attrs: ATTR_POOL[rnd(ATTR_POOL.length)] }));
    const got = D.segments(L, formats);
    assert.deepStrictEqual(got, naiveSegments(L, formats), JSON.stringify({ L, formats }));
    // Total coverage of [0, L] and no overlaps
    assert.strictEqual(got.reduce((a, s) => a + s.len, 0), L + 1);
    got.forEach((s, i) => assert.strictEqual(s.at, i ? got[i - 1].at + got[i - 1].len : 0));
    // compactFormats is the same without the plain segments
    assert.deepStrictEqual(D.compactFormats(formats, L), got.filter(s => Object.keys(s.attrs).length));
  }
  assert.deepStrictEqual(D.segments(0, []), [{ at: 0, len: 1, attrs: {} }]);
});

test('the run operations match a per-character model under random edits', () => {
  const rnd = rng(5);
  for (let round = 0; round < 60; round++) {
    let len = 0;                  // text length; the model has len + 1 entries (the final break)
    let per = [{}];
    let runs = [];
    for (let step = 0; step < 80; step++) {
      const r = rnd(10);
      if (r < 5 || len < 3) {
        const at = rnd(len + 1), n = 1 + rnd(4), attrs = rnd(3) ? ATTR_POOL[rnd(ATTR_POOL.length)] : undefined;
        per.splice(at, 0, ...Array.from({ length: n }, () => clean(attrs)));
        runs = D.insertRuns(runs, at, n, attrs);
        len += n;
      } else if (r < 7) {
        const at = rnd(len), n = 1 + rnd(Math.min(5, len - at));
        per.splice(at, n);
        runs = D.deleteRuns(runs, at, n);
        len -= n;
      } else {
        const at = rnd(len + 1), n = 1 + rnd(len + 1 - at), attrs = ATTR_POOL[rnd(ATTR_POOL.length)];
        for (let i = at; i < at + n; i++) per[i] = apply(per[i], attrs);
        runs = D.formatRuns(runs, at, n, attrs);
      }
      assert.deepStrictEqual(D.segments(len, runs), group(per), `round ${round} step ${step}`);
    }
  }
});

test('docToDelta: inline formats on text, block formats on line breaks, images as embeds', () => {
  const text = 'Title\nHello bold' + E + '\nA\nB\nend';
  const formats = [
    { at: 0, len: 5, attrs: { bold: true, header: 1 } },               // header on text is ignored there
    { at: 5, len: 1, attrs: { title: true } },
    { at: 12, len: 4, attrs: { bold: true, link: 'https://a.example' } },
    { at: 16, len: 1, attrs: { image: ID, width: '300', alt: 'Chart', link: 'https://a.example', align: 'center' } },
    { at: 17, len: 1, attrs: { align: 'center' } },
    { at: 19, len: 1, attrs: { table: 'row-a' } },
    { at: 21, len: 1, attrs: { table: 'row-a' } },
    { at: 25, len: 1, attrs: { header: 2, lineheight: '2' } }            // the final line break
  ];
  const ops = D.docToDelta(text, formats);
  assert.deepStrictEqual(ops, [
    { insert: 'Title', attributes: { bold: true } },
    { insert: '\n', attributes: { title: true } },
    { insert: 'Hello ' },
    { insert: 'bold', attributes: { bold: true, link: 'https://a.example' } },
    { insert: { image: '/api/images/' + ID }, attributes: { width: '300', alt: 'Chart', link: 'https://a.example' } },
    { insert: '\n', attributes: { align: 'center' } },
    { insert: 'A' },
    { insert: '\n', attributes: { table: 'row-a' } },
    { insert: 'B' },
    { insert: '\n', attributes: { table: 'row-a' } },
    { insert: 'end' },
    { insert: '\n', attributes: { header: 2, lineheight: '2' } }
  ]);
  assert.strictEqual(D.deltaText(ops), text + '\n');
  // imageSrc is the caller's; with no image id it still gets a src
  const withToken = D.docToDelta(E + E, [{ at: 0, len: 1, attrs: { image: ID } }], { imageSrc: id => (id ? '/api/images/' + id + '?t=tok' : D.TRANSPARENT_GIF) });
  assert.deepStrictEqual(withToken, [{ insert: { image: '/api/images/' + ID + '?t=tok' } }, { insert: { image: D.TRANSPARENT_GIF } }, { insert: '\n' }]);
  assert.deepStrictEqual(D.docToDelta(E, [], { imageSrc: () => '' }), [{ insert: { image: D.TRANSPARENT_GIF } }, { insert: '\n' }]);
  // Adjacent inserts with equal attributes merge, the way Delta.push does
  assert.deepStrictEqual(D.docToDelta('ab\n\ncd', [{ at: 2, len: 2, attrs: { table: 'row-x' } }, { at: 0, len: 1, attrs: { color: '#000000' } }, { at: 1, len: 1, attrs: { color: '#000000', bold: null } }]), [
    { insert: 'ab', attributes: { color: '#000000' } }, { insert: '\n\n', attributes: { table: 'row-x' } }, { insert: 'cd\n' }
  ]);
  assert.deepStrictEqual(D.docToDelta('', null), [{ insert: '\n' }]);
  assert.deepStrictEqual(D.docToDelta('', [{ at: 0, len: 1, attrs: { list: 'checked' } }]), [{ insert: '\n', attributes: { list: 'checked' } }]);
  // Each op owns its attributes object
  const twice = D.docToDelta('a\nb', [{ at: 0, len: 3, attrs: { bold: true } }]);
  assert.notStrictEqual(twice[0].attributes, twice[2].attributes);
});

test('docToDelta and deltaText round-trip random documents with embeds, tables and block formats', () => {
  let Delta = null;
  try { Delta = require('quill-delta'); } catch { /* quill is a dev dependency; the Delta check is extra */ }
  const rnd = rng(23);
  const alphabet = ['a', 'b', ' ', '\n', E];
  for (let round = 0; round < 200; round++) {
    const text = Array.from({ length: rnd(30) }, () => alphabet[rnd(alphabet.length)]).join('');
    const formats = Array.from({ length: rnd(10) }, () => ({ at: rnd(text.length + 2), len: 1 + rnd(8), attrs: rnd(4) ? ATTR_POOL[rnd(ATTR_POOL.length)] : { image: ID, width: '200', bold: true } }));
    const ops = D.docToDelta(text, formats);
    assert.strictEqual(D.deltaText(ops), text + '\n');
    // Reference: one op per character from the per-character attrs, then merged
    const per = naiveSegments(text.length, formats).flatMap(s => Array.from({ length: s.len }, () => s.attrs));
    const want = [];
    const full = text + '\n';
    for (let i = 0; i < full.length; i++) {
      const a = per[i];
      const keep = test => { const o = {}; for (const k of Object.keys(a)) if (test(k)) o[k] = a[k]; return Object.keys(o).length ? o : null; };
      let op;
      if (full[i] === E) op = { insert: { image: a.image ? '/api/images/' + a.image : D.TRANSPARENT_GIF }, attributes: keep(k => D.isInlineKey(k) || k === 'width' || k === 'alt') };
      else op = { insert: full[i], attributes: full[i] === '\n' ? keep(D.isBlockKey) : keep(D.isInlineKey) };
      if (!op.attributes) delete op.attributes;
      const last = want[want.length - 1];
      if (last && typeof last.insert === 'string' && typeof op.insert === 'string' && JSON.stringify(Object.entries(last.attributes || {}).sort()) === JSON.stringify(Object.entries(op.attributes || {}).sort())) last.insert += op.insert;
      else want.push(op);
    }
    assert.deepStrictEqual(ops, want, JSON.stringify({ text, formats }));
    if (Delta) {
      const normal = ops.reduce((d, op) => d.push(op), new Delta()).ops;
      assert.deepStrictEqual(normal, ops, 'already a normal Quill delta');
      assert.strictEqual(new Delta(ops).length(), text.length + 1, 'one index per character, embeds included');
    }
  }
  // deltaText takes whatever a delta holds: retains and deletes add no text
  assert.strictEqual(D.deltaText([{ insert: 'Hi ' }, { insert: { image: 'x' } }, { retain: 3 }, { delete: 1 }, { insert: '\n' }]), 'Hi ' + E + '\n');
  assert.strictEqual(D.deltaText(null), '');
});

test('imageIdFromSrc: our own image URLs only', () => {
  assert.strictEqual(D.imageIdFromSrc('/api/images/' + ID), ID);
  assert.strictEqual(D.imageIdFromSrc('/api/images/' + ID + '?t=abc.def'), ID);
  assert.strictEqual(D.imageIdFromSrc('https://visor.example/api/images/' + ID + '?t=1', 'https://visor.example'), ID);
  assert.strictEqual(D.imageIdFromSrc('https://other.example/api/images/' + ID, 'https://visor.example'), null);
  assert.strictEqual(D.imageIdFromSrc('https://visor.example/api/images/' + ID), null, 'no page origin in node');
  for (const bad of ['/api/images/' + ID.slice(2), '/api/images/' + ID + '/x', '/api/images/' + ID.toUpperCase(), 'data:image/png;base64,AAAA', D.TRANSPARENT_GIF, '/x/api/images/' + ID, null, 7]) {
    assert.strictEqual(D.imageIdFromSrc(bad, 'https://visor.example'), null, String(bad));
  }
});

test('speed: a 500-op batch on a 200,000-character essay with 2,000 runs', t => {
  const rnd = rng(99);
  const words = ['the', 'sleep', 'school', 'early', 'teenagers', 'need', 'more', 'evidence', 'shows'];
  let text = '';
  while (text.length < 200000) text += words[rnd(words.length)] + (rnd(60) ? ' ' : '\n');
  text = text.slice(0, 200000);
  const breaks = [];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') breaks.push(i);
  // 1,600 inline runs scattered through the text and 400 block runs on line breaks, some overlapping
  const inline = [{ bold: true }, { italic: true }, { color: '#cc0000' }, { link: 'https://a.example/x' }, { size: '14pt' }, { bold: null }];
  const block = [{ header: 2 }, { align: 'center' }, { lineheight: '2' }, { list: 'bullet' }, { indent: 1 }];
  const formats = [];
  for (let i = 0; i < 1600; i++) formats.push({ at: rnd(text.length - 50), len: 1 + rnd(40), attrs: inline[rnd(inline.length)] });
  for (let i = 0; i < 400; i++) formats.push({ at: breaks[rnd(breaks.length)], len: 1, attrs: block[rnd(block.length)] });
  const batch = () => {
    const ops = [];
    let L = text.length;
    for (let i = 0; i < 500; i++) {
      const r = rnd(10);
      if (r < 6) { const s = 'abc'.slice(rnd(3)); ops.push({ k: 'i', at: rnd(L + 1), s, attrs: rnd(2) ? { bold: true } : undefined, t: 1, src: 'type' }); L += s.length; }
      else if (r < 8) { const at = rnd(L - 10); ops.push({ k: 'd', at, len: 1 + rnd(3), t: 1, src: 'type' }); L -= ops[ops.length - 1].len; }
      else ops.push({ k: 'f', at: rnd(L - 10), len: 1 + rnd(9), attrs: inline[rnd(inline.length)], t: 1, src: 'type' });
    }
    return ops;
  };
  const time = fn => { const t0 = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t0) / 1e6; };
  // A document that has never been compacted (the worst case: it tidies at once) …
  const fresh = { id: 'big', text, formats: formats.map(r => ({ ...r })), seq: 0, snapshots: [] };
  const ops1 = batch();
  const ms1 = time(() => W.applyBatch(fresh, ops1, { baseSeq: 0 }));
  // … and one that knows its last tidy size
  const tidy = { id: 'big2', text, formats: D.compactFormats(formats, text.length), formatsCompacted: 0, seq: 0, snapshots: [] };
  tidy.formatsCompacted = tidy.formats.length;
  const ops2 = batch();
  const ms2 = time(() => W.applyBatch(tidy, ops2, { baseSeq: 0 }));
  const ms3 = time(() => D.docToDelta(fresh.text, fresh.formats));
  t.diagnostic(`500-op batch, 200k chars, 2,000 runs: ${ms1.toFixed(1)} ms (first tidy), ${ms2.toFixed(1)} ms (already tidy); docToDelta ${ms3.toFixed(1)} ms; runs after: ${fresh.formats.length} / ${tidy.formats.length}`);
  assert.strictEqual(fresh.seq, 500);
  assert.ok(fresh.formatsCompacted > 0 && fresh.formatsCompacted <= 2000);
  assert.ok(ms1 < 2000, `batch took ${ms1} ms`);
  assert.ok(ms2 < 2000, `batch took ${ms2} ms`);
  assert.ok(ms3 < 2000, `docToDelta took ${ms3} ms`);
  // Compaction never changes what the text looks like
  assert.deepStrictEqual(D.segments(text.length, D.compactFormats(formats, text.length)), D.segments(text.length, formats));
});
