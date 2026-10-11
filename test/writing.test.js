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
  W.applyOp(st, W.cleanOp(ins(8, 'w')));                   // inside: run grows ("twwo")
  assert.deepStrictEqual(st.formats[0], { at: 7, len: 4, attrs: { bold: true } });
  W.applyOp(st, W.cleanOp(del(6, 3)));                     // cut across the run's start
  assert.strictEqual(st.text, '>> onewo three');
  assert.deepStrictEqual(st.formats[0], { at: 6, len: 2, attrs: { bold: true } });
  W.applyOp(st, W.cleanOp(ins(st.text.length, '\nHeading\n', { attrs: { header: 2 } })));
  assert.deepStrictEqual(st.formats[1].attrs, { header: 2 });
  // Unknown or unsafe attributes are dropped; a format op needs at least one real one
  assert.deepStrictEqual(W.cleanAttrs({ bold: true, color: 'red', header: 7, list: 'ordered' }), { bold: true, list: 'ordered' });
  assert.throws(() => W.cleanOp(fmt(0, 1, { color: 'red' })), e => e.status === 400);
});

test('compactFormats merges runs without changing what is formatted', () => {
  const runs = [{ at: 0, len: 2, attrs: { bold: true } }, { at: 2, len: 2, attrs: { bold: true } }, { at: 1, len: 1, attrs: { bold: null } }];
  assert.deepStrictEqual(W.compactFormats(runs, 6), [{ at: 0, len: 1, attrs: { bold: true } }, { at: 2, len: 2, attrs: { bold: true } }]);
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
