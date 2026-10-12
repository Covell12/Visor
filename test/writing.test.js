// lib/writing.js: applying ops, batches, chunks, snapshots, replay.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const W = require('../lib/writing');

const ins = (at, s, extra = {}) => ({ k: 'i', at, s, t: 1, src: 'type', ...extra });
const del = (at, len) => ({ k: 'd', at, len, t: 1, src: 'type' });
const fmt = (at, len, attrs) => ({ k: 'f', at, len, attrs, t: 1, src: 'other' });

test('applyOp inserts, deletes and bounds-checks', () => {
  const st = { text: '', formats: [] };
  W.applyOp(st, W.cleanOp(ins(0, 'Hello world')));
  W.applyOp(st, W.cleanOp(ins(5, ',')));
  assert.strictEqual(st.text, 'Hello, world');
  W.applyOp(st, W.cleanOp(del(5, 1)));
  assert.strictEqual(st.text, 'Hello world');
  W.applyOp(st, W.cleanOp(ins(11, '!')));          // at the very end is fine
  assert.strictEqual(st.text, 'Hello world!');
  assert.throws(() => W.applyOp(st, W.cleanOp(ins(13, 'x'))), e => e.status === 409);
  assert.throws(() => W.applyOp(st, W.cleanOp(del(10, 5))), e => e.status === 409);
  assert.throws(() => W.applyOp(st, W.cleanOp(fmt(0, 50, { bold: true }))), e => e.status === 409);
  W.applyOp(st, W.cleanOp(fmt(12, 1, { header: 1 })));   // Quill's final line break, one past the end
  assert.deepStrictEqual(st.formats.at(-1), { at: 12, len: 1, attrs: { header: 1 } });
  assert.throws(() => W.cleanOp({ k: 'x', at: 0 }), e => e.status === 400);
  assert.throws(() => W.cleanOp({ k: 'i', at: -1, s: 'a' }), e => e.status === 400);
  assert.throws(() => W.cleanOp(ins(0, 'x'.repeat(50001))), e => e.status === 413);
});

test('applyOp keeps formatting runs in step with the text', () => {
  const st = { text: '', formats: [] };
  W.applyOp(st, W.cleanOp(ins(0, 'one two three')));
  W.applyOp(st, W.cleanOp(fmt(4, 3, { bold: true })));     // "two"
  W.applyOp(st, W.cleanOp(ins(0, '>> ')));                 // before: run shifts
  assert.deepStrictEqual(st.formats, [{ at: 7, len: 3, attrs: { bold: true } }]);
  // Inside a run: the run splits around the new text, which has only its own
  // attrs (as in a Quill delta). Typing in bold text sends bold.
  W.applyOp(st, W.cleanOp(ins(8, 'w', { attrs: { bold: true } })));   // "twwo"
  assert.deepStrictEqual(st.formats, [{ at: 7, len: 1, attrs: { bold: true } }, { at: 9, len: 2, attrs: { bold: true } }, { at: 8, len: 1, attrs: { bold: true } }]);
  assert.deepStrictEqual(W.compactFormats(st.formats, st.text.length), [{ at: 7, len: 4, attrs: { bold: true } }]);
  W.applyOp(st, W.cleanOp(del(6, 3)));                     // cut across the run's start
  assert.strictEqual(st.text, '>> onewo three');
  assert.deepStrictEqual(st.formats, [{ at: 6, len: 2, attrs: { bold: true } }]);
  W.applyOp(st, W.cleanOp(ins(7, 'X')));                   // inside, with no attrs: plain
  assert.deepStrictEqual(W.compactFormats(st.formats, st.text.length), [{ at: 6, len: 1, attrs: { bold: true } }, { at: 8, len: 1, attrs: { bold: true } }]);
  W.applyOp(st, W.cleanOp(ins(st.text.length, '\nHeading\n', { attrs: { header: 2 } })));
  assert.deepStrictEqual(st.formats.at(-1).attrs, { header: 2 });
  // Unknown or unsafe attributes are dropped; colour and the other new formats are kept
  assert.deepStrictEqual(W.cleanAttrs({ bold: true, color: '#F00', header: 7, list: 'ordered', foo: 1 }), { bold: true, color: '#ff0000', list: 'ordered' });
  // A format op with nothing valid left is skipped, never a 400
  assert.strictEqual(W.cleanOp(fmt(0, 1, { color: 'red', foo: 'bar' })), null);
  assert.deepStrictEqual(W.cleanOp(fmt(0, 1, { color: 'rgb(255, 0, 0)' })).attrs, { color: '#ff0000' });
});

test('compactFormats merges runs without changing what is formatted', () => {
  const runs = [{ at: 0, len: 2, attrs: { bold: true } }, { at: 2, len: 2, attrs: { bold: true } }, { at: 1, len: 1, attrs: { bold: null } }];
  assert.deepStrictEqual(W.compactFormats(runs, 6), [{ at: 0, len: 1, attrs: { bold: true } }, { at: 2, len: 2, attrs: { bold: true } }]);
  // Every key survives, and the final line break (index textLength) is covered
  const rich = [{ at: 0, len: 3, attrs: { color: '#ff0000', link: 'https://a.example' } }, { at: 3, len: 1, attrs: { table: 'row-ab12', lineheight: '2' } }];
  assert.deepStrictEqual(W.compactFormats(rich, 3), rich);
});

test('format ops with nothing valid are skipped; the rest of the batch goes through', () => {
  const doc = freshDoc();
  const stamped = W.applyBatch(doc, [ins(0, 'Hello'), fmt(0, 5, { foo: true }), fmt(0, 5, { bold: 'yes' }), fmt(0, 5, { strike: true, image: 'a'.repeat(32) }), ins(5, '!')], { baseSeq: 0, textHash: W.sha256('Hello!') });
  assert.deepStrictEqual(stamped.map(o => [o.n, o.k]), [[1, 'i'], [2, 'f'], [3, 'i']]);
  assert.deepStrictEqual(stamped[1].attrs, { strike: true }, 'an image id is never changed by a format op');
  assert.strictEqual(doc.seq, 3);
  assert.deepStrictEqual(doc.formats, [{ at: 0, len: 5, attrs: { strike: true } }]);
  // A batch of only skipped ops changes nothing and still succeeds
  assert.deepStrictEqual(W.applyBatch(doc, [fmt(0, 1, { nope: 1 })], { baseSeq: 3 }), []);
  assert.strictEqual(doc.seq, 3);
});

test('images: one EMBED character naming its upload', () => {
  const id = 'ab'.repeat(16);
  const E = W.EMBED;
  assert.strictEqual(E, '\uFFFC');
  const op = W.cleanOp(ins(0, E, { src: 'image', attrs: { image: id, width: 320, alt: 'A chart', bold: true, header: 1 } }));
  assert.deepStrictEqual(op.attrs, { bold: true, header: 1, image: id, width: '320', alt: 'A chart' });
  assert.strictEqual(op.src, 'image');
  const missing = e => e.status === 400 && e.message === 'An image is missing its upload.';
  assert.throws(() => W.cleanOp(ins(0, E)), missing);
  assert.throws(() => W.cleanOp(ins(0, E, { attrs: { image: 'not-an-id' } })), missing);
  assert.throws(() => W.cleanOp(ins(0, E, { attrs: { image: null } })), missing);
  assert.throws(() => W.cleanOp(ins(0, 'a' + E, { attrs: { image: id } })), missing);
  assert.throws(() => W.cleanOp(ins(0, E + E, { attrs: { image: id } })), missing);
  // Text never carries an image id; nulls mean nothing on new text
  assert.strictEqual(W.cleanOp(ins(0, 'abc', { attrs: { image: id, bold: null } })).attrs, undefined);
  // Resizing and alt text are format ops on the embed
  assert.deepStrictEqual(W.cleanOp(fmt(3, 1, { width: '200', alt: 'Bar chart' })).attrs, { width: '200', alt: 'Bar chart' });
  // Structure and image ops keep their src
  assert.ok(W.SRC.includes('image') && W.SRC.includes('structure'));
  assert.strictEqual(W.cleanOp(ins(0, '\n\n\n', { src: 'structure', attrs: { table: 'row-x1' } })).src, 'structure');

  const doc = freshDoc();
  const st = W.applyBatch(doc, [ins(0, 'See:  done'), ins(5, E, { src: 'image', attrs: { image: id, width: '300' } }), ins(11, '\n\n', { src: 'structure', attrs: { table: 'row-ab' } }), ins(13, 'xyz', { src: 'other' })], { baseSeq: 0 });
  W.updateStats(doc, st);
  assert.strictEqual(doc.text, 'See: ' + E + ' done\n\nxyz');
  assert.strictEqual(doc.stats.words, 3, 'an image is not a word');
  assert.strictEqual(doc.stats.images, 1);
  assert.strictEqual(doc.stats.typedChars, 10, 'images and structure are not typing');
  assert.strictEqual(doc.stats.otherChars, 3);
  assert.deepStrictEqual(doc.formats, [{ at: 5, len: 1, attrs: { image: id, width: '300' } }, { at: 11, len: 2, attrs: { table: 'row-ab' } }]);
});

test('compaction is amortised: only past twice the size of the last tidy', () => {
  const doc = freshDoc();
  W.applyBatch(doc, [ins(0, 'x'.repeat(5000))], { baseSeq: 0 });
  // 450 separate one-character runs, each a different colour so they can't merge
  const colour = i => '#' + (0x100000 + i).toString(16);
  let ops = Array.from({ length: 450 }, (_, i) => fmt(i * 2, 1, { color: colour(i) }));
  W.applyBatch(doc, ops, { baseSeq: doc.seq });
  assert.strictEqual(doc.formatsCompacted, 401, 'compacted once past 400 runs');
  assert.strictEqual(doc.formats.length, 450);
  // The next tidy waits until there are more than 2 × 401 runs
  ops = Array.from({ length: 352 }, (_, i) => fmt(2000 + i * 2, 1, { color: colour(1000 + i) }));
  W.applyBatch(doc, ops, { baseSeq: doc.seq });
  assert.strictEqual(doc.formats.length, 802);
  assert.strictEqual(doc.formatsCompacted, 401);
  W.applyBatch(doc, [fmt(4000, 1, { bold: true })], { baseSeq: doc.seq });
  assert.strictEqual(doc.formatsCompacted, 803);
  assert.strictEqual(doc.formats.length, 803);
});

test('starter text is plain: image placeholders are dropped from it', () => {
  const { doc, firstOps } = W.newDoc({ id: 'd3', assignmentId: 'a', classId: 'c', studentId: 's', templateText: 'Name:\uFFFC\n' });
  assert.strictEqual(doc.text, 'Name:\n');
  assert.strictEqual(firstOps[0].s, 'Name:\n');
  assert.strictEqual(W.newDoc({ id: 'd4', assignmentId: 'a', classId: 'c', studentId: 's', templateText: '\uFFFC' }).firstOps.length, 0);
});

function freshDoc() { return W.newDoc({ id: 'd1', assignmentId: 'a', classId: 'c', studentId: 's' }).doc; }

test('a batch with the wrong baseSeq is refused with 409 and the server state', () => {
  const doc = freshDoc();
  W.applyBatch(doc, [ins(0, 'abc')], { baseSeq: 0, sid: 's1', surf: 'tab' });
  assert.strictEqual(doc.seq, 1);
  assert.throws(() => W.applyBatch(doc, [ins(3, 'd')], { baseSeq: 0 }), e => e.status === 409 && e.data.seq === 1 && e.data.text === 'abc');
  // A mismatched text hash is refused too, and nothing changes
  assert.throws(() => W.applyBatch(doc, [ins(3, 'd')], { baseSeq: 1, textHash: W.sha256('wrong') }), e => e.status === 409);
  assert.strictEqual(doc.text, 'abc');
  const ok = W.applyBatch(doc, [ins(3, 'd')], { baseSeq: 1, textHash: W.sha256('abcd') });
  assert.strictEqual(ok[0].n, 2);
  assert.strictEqual(doc.text, 'abcd');
  // An op that doesn't fit leaves the document untouched
  assert.throws(() => W.applyBatch(doc, [ins(4, 'e'), del(10, 2)], { baseSeq: 2 }), e => e.status === 409);
  assert.strictEqual(doc.text, 'abcd');
  assert.strictEqual(doc.seq, 2);
});

test('ops are stamped and chunked across the 500 boundary', () => {
  const doc = freshDoc();
  const chunks = {};
  const put = list => list.forEach(c => { chunks[c.id] = c; });
  // 498 ops, then a batch of 5 that crosses into the second chunk
  let ops = Array.from({ length: 498 }, (_, i) => ins(i, 'x'));
  let stamped = W.applyBatch(doc, ops, { baseSeq: 0, sid: 's1', surf: 'tab', now: 42 });
  assert.deepStrictEqual(stamped[0], { n: 1, k: 'i', at: 0, s: 'x', t: 1, src: 'type', st: 42, sid: 's1', surf: 'tab' });
  assert.deepStrictEqual(W.chunkIdsFor('d1', 0, 498), ['d1:000000']);
  put(W.appendToChunks('d1', chunks, stamped));
  ops = Array.from({ length: 5 }, (_, i) => ins(498 + i, 'y'));
  assert.deepStrictEqual(W.chunkIdsFor('d1', 498, 5), ['d1:000000', 'd1:000001']);
  stamped = W.applyBatch(doc, ops, { baseSeq: 498, sid: 's1', surf: 'panel' });
  put(W.appendToChunks('d1', chunks, stamped));
  assert.strictEqual(chunks['d1:000000'].ops.length, 500);
  assert.deepStrictEqual(chunks['d1:000001'].ops.map(o => o.n), [501, 502, 503]);
  assert.strictEqual(chunks['d1:000001'].ops[0].surf, 'panel');
  assert.throws(() => W.applyBatch(doc, Array.from({ length: 501 }, () => ins(0, 'z')), { baseSeq: 503 }), e => e.status === 413);
});

test('a snapshot is kept every 2,000 ops (the last 20)', () => {
  const doc = freshDoc();
  for (let b = 0; b < 9; b++) {
    W.applyBatch(doc, Array.from({ length: 500 }, (_, i) => ins(doc.text.length + i, String(i % 10))), { baseSeq: doc.seq });
  }
  assert.strictEqual(doc.seq, 4500);
  assert.deepStrictEqual(doc.snapshots.map(s => s.seq), [2000, 4000]);
  assert.strictEqual(doc.snapshots[0].text.length, 2000);
  assert.strictEqual(doc.snapshots[1].text, doc.text.slice(0, 4000));
  doc.snapshots = Array.from({ length: 20 }, (_, i) => ({ seq: i }));
  W.applyBatch(doc, Array.from({ length: 500 }, () => ins(0, 'q')), { baseSeq: doc.seq }); // reaches 5000? no: 5000 % 2000 != 0
  W.applyBatch(doc, Array.from({ length: 500 }, () => ins(0, 'q')), { baseSeq: doc.seq });
  W.applyBatch(doc, Array.from({ length: 500 }, () => ins(0, 'q')), { baseSeq: doc.seq }); // 6000
  assert.strictEqual(doc.snapshots.length, 20);
  assert.strictEqual(doc.snapshots[19].seq, 6000);
});

test('replaying every op reproduces the document exactly', () => {
  const { doc, firstOps } = W.newDoc({ id: 'd2', assignmentId: 'a', classId: 'c', studentId: 's', templateText: 'Title:\n\n' });
  assert.strictEqual(firstOps[0].src, 'template');
  assert.strictEqual(doc.seq, 1);
  const log = [...firstOps];
  // A pseudo-random editing session: typing, deleting, formatting, pasting
  let seed = 7;
  const rnd = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor((seed / 2147483648) * n); };
  for (let b = 0; b < 60; b++) {
    const shadow = { text: doc.text, formats: doc.formats.map(r => ({ ...r })) };
    const batch = [];
    for (let i = 0; i < 1 + rnd(20); i++) {
      const L = shadow.text.length;
      const r = rnd(10);
      let op;
      if (r < 6 || L < 5) op = ins(rnd(L + 1), 'abcdefghij '.slice(rnd(10)), r === 0 ? { attrs: { italic: true } } : {});
      else if (r < 8) { const at = rnd(L - 1); op = del(at, 1 + rnd(Math.min(8, L - at))); }
      else if (r < 9) { const at = rnd(L - 1); op = fmt(at, 1 + rnd(Math.min(8, L - at)), { bold: true }); }
      else op = ins(rnd(L + 1), 'PASTED BLOCK OF TEXT '.repeat(3), { src: 'paste', paste: { hash: 'x', internal: false } });
      W.applyOp(shadow, W.cleanOp(op));
      batch.push(op);
    }
    log.push(...W.applyBatch(doc, batch, { baseSeq: doc.seq, textHash: W.sha256(shadow.text) }));
  }
  const replayed = W.replayOps(log);
  assert.strictEqual(replayed.text, doc.text);
  assert.deepStrictEqual(W.compactFormats(replayed.formats, replayed.text.length), W.compactFormats(doc.formats, doc.text.length));
  assert.ok(log.some(o => o.paste && o.paste.hash.length === 64), 'paste hashes are made server-side when the client sends a bad one');
});

test('stats count words and outside pastes', () => {
  const doc = freshDoc();
  const st = W.applyBatch(doc, [ins(0, 'one two '), ins(8, 'pasted words here', { src: 'paste', paste: { internal: false } })], { baseSeq: 0 });
  W.updateStats(doc, st);
  assert.strictEqual(doc.stats.words, 5);
  assert.strictEqual(doc.stats.pastes, 1);
  assert.strictEqual(doc.stats.externalPasteChars, 17);
  assert.strictEqual(doc.stats.typedChars, 8);
});

test('a paste that arrives in pieces counts as one paste', () => {
  const doc = freshDoc();
  const paste = { internal: false };
  const st = W.applyBatch(doc, [ins(0, 'a'.repeat(30), { src: 'paste', paste }), ins(30, 'b'.repeat(20), { src: 'paste', paste, part: 1 }), ins(50, 'c'.repeat(5), { src: 'paste', paste, part: 2 }), ins(55, 'short', { src: 'paste', paste })], { baseSeq: 0 });
  assert.strictEqual(st[1].paste.part, 1);
  W.updateStats(doc, st);
  assert.strictEqual(doc.stats.pastes, 2, 'three pieces and one more paste');
  assert.strictEqual(doc.stats.biggestPaste, 55, 'the pieces add up');
  assert.strictEqual(doc.stats.externalPasteChars, 60);
});

// A link of exactly 2,048 characters (the most one link may be), different for each i
const longLink = i => { const head = 'https://example.com/' + i.toString(36) + '/'; return head + 'x'.repeat(2048 - head.length); };
const tooMuch = e => e.status === 413 && /too much formatting/.test(e.message);

test('formatting has an overall limit: a batch that pushes it past is refused with 413', () => {
  const doc = freshDoc();
  W.applyBatch(doc, [ins(0, 'x'.repeat(5000))], { baseSeq: 0 });
  // 300 one-character links, each with a 300-character alt text: about 630 KB, accepted
  const linkOps = (from, n) => Array.from({ length: n }, (_, i) => fmt(from + i, 1, { link: longLink(from + i), alt: 'a'.repeat(300) }));
  const ok = W.applyBatch(doc, linkOps(0, 300), { baseSeq: 1 });
  assert.strictEqual(ok.length, 300);
  assert.deepStrictEqual(Object.keys(ok[0].attrs), ['link'], 'alt text on text (no picture) is dropped');
  assert.ok(W.formatBytes(doc.formats) < W.LIMITS.FORMAT_BYTES);
  // 300 more would make about 1.25 MB: refused, and nothing changes
  const before = JSON.stringify(doc);
  assert.throws(() => W.applyBatch(doc, linkOps(300, 300), { baseSeq: 301 }), tooMuch);
  assert.strictEqual(JSON.stringify(doc), before);
  // Ordinary edits still go through
  W.applyBatch(doc, [ins(5000, ' more words', { attrs: { bold: true } }), del(0, 10), fmt(20, 5, { italic: true })], { baseSeq: 301 });
  assert.strictEqual(doc.seq, 304);
  // The cap counts the tidy list: the same link over and over is one run
  W.applyBatch(doc, Array.from({ length: 500 }, (_, i) => fmt(1000 + i, 1, { link: longLink(1) })), { baseSeq: 304 });
  assert.ok(W.formatBytes(W.compactFormats(doc.formats, doc.text.length)) < W.LIMITS.FORMAT_BYTES);
});

test('formatting has an overall limit on the number of runs', () => {
  const doc = freshDoc();
  doc.text = 'x'.repeat(50000);
  // Alternating bold and italic one-character runs can't merge
  const run = i => ({ at: i, len: 1, attrs: i % 2 ? { italic: true } : { bold: true } });
  const max = W.LIMITS.FORMAT_RUNS;
  doc.formats = Array.from({ length: max - 5 }, (_, i) => run(i));
  doc.formatsCompacted = doc.formats.length;
  const more = (from, n) => Array.from({ length: n }, (_, i) => fmt(from + i, 1, run(from + i).attrs));
  assert.throws(() => W.applyBatch(doc, more(max - 5, 10), { baseSeq: 0 }), tooMuch);
  assert.strictEqual(doc.formats.length, max - 5);
  W.applyBatch(doc, more(max - 5, 5), { baseSeq: 0 });
  assert.strictEqual(W.compactFormats(doc.formats, doc.text.length).length, max);
  assert.throws(() => W.applyBatch(doc, more(max, 1), { baseSeq: 5 }), tooMuch);
});

test('a document already over the formatting limit can still be edited, but not given more', () => {
  const doc = freshDoc();
  doc.text = 'x'.repeat(50000);
  const max = W.LIMITS.FORMAT_RUNS;
  doc.formats = Array.from({ length: max + 2000 }, (_, i) => ({ at: i, len: 1, attrs: i % 2 ? { italic: true } : { bold: true } }));
  // Typing where there's no formatting, and deleting, go through
  W.applyBatch(doc, [ins(40000, 'typed'), del(45000, 10)], { baseSeq: 0 });
  W.applyBatch(doc, [del(0, 100)], { baseSeq: 2 });
  assert.strictEqual(doc.seq, 3);
  assert.strictEqual(doc.formats.length, max + 1900);
  // Adding formatting doesn't
  assert.throws(() => W.applyBatch(doc, [fmt(30000, 1, { underline: true }), fmt(30002, 1, { underline: true })], { baseSeq: 3 }), tooMuch);
  assert.strictEqual(doc.seq, 3);
});

test('alt text and width are kept only on pictures', () => {
  const id = 'cd'.repeat(16);
  const E = W.EMBED;
  assert.deepStrictEqual(W.cleanOp(ins(0, 'abc', { attrs: { alt: 'x', width: 300, bold: true } })).attrs, { bold: true });
  assert.strictEqual(W.cleanOp(ins(0, 'abc', { attrs: { alt: 'x' } })).attrs, undefined);
  const doc = freshDoc();
  W.applyBatch(doc, [ins(0, 'ab'), ins(2, E, { src: 'image', attrs: { image: id, alt: 'A chart' } }), ins(3, 'cd')], { baseSeq: 0 });
  const stamped = W.applyBatch(doc, [
    fmt(0, 2, { alt: 'nothing to describe' }),          // text only: skipped
    fmt(0, 2, { alt: 'x', width: '300', italic: true }), // text only: just the italic
    fmt(2, 1, { alt: 'A bar chart', width: '200' }),     // the picture: kept
    fmt(0, 5, { width: null })                          // a span with the picture in it: kept
  ], { baseSeq: 3 });
  assert.deepStrictEqual(stamped.map(o => o.attrs), [{ italic: true }, { alt: 'A bar chart', width: '200' }, { width: null }]);
  assert.deepStrictEqual(stamped.map(o => o.n), [4, 5, 6]);
  assert.deepStrictEqual(W.compactFormats(doc.formats, doc.text.length).find(r => r.attrs.image).attrs, { image: id, alt: 'A bar chart' });
  // An op that doesn't fit is still refused, not skipped
  assert.throws(() => W.applyBatch(doc, [fmt(4, 9, { alt: 'x' })], { baseSeq: 6 }), e => e.status === 409);
});

test('snapshots keep their formatting tidy, and the oldest go when it gets large', () => {
  const doc = freshDoc();
  doc.text = 'x'.repeat(5000);
  // About 840 KB of links: under the document's limit, but four snapshots of it aren't
  doc.formats = Array.from({ length: 400 }, (_, i) => ({ at: i * 2, len: 1, attrs: { link: longLink(i) } }));
  doc.formats.push({ at: 4000, len: 5, attrs: { bold: true } }, { at: 4005, len: 5, attrs: { bold: true } });
  for (let b = 0; b < 16; b++) W.applyBatch(doc, Array.from({ length: 500 }, (_, i) => ins(doc.text.length + i, 'y')), { baseSeq: doc.seq });
  assert.strictEqual(doc.seq, 8000);
  const each = W.formatBytes(doc.snapshots[0].formats);
  assert.ok(each * 2 <= W.LIMITS.SNAPSHOT_FORMAT_BYTES && each * 3 > W.LIMITS.SNAPSHOT_FORMAT_BYTES, `${each} bytes each`);
  assert.deepStrictEqual(doc.snapshots.map(s => s.seq), [6000, 8000]);
  assert.strictEqual(doc.snapshots[1].formats.length, 401, 'the two bold runs are one in the snapshot');
  assert.deepStrictEqual(doc.snapshots[1].formats, W.compactFormats(doc.formats, doc.text.length));
});
