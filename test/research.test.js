// lib/research.js: paste origins, cleaning and chunking research events.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const R = require('../lib/research');
const W = require('../lib/writing');

const T = Date.parse('2026-10-12T14:00:00Z');
const text = 'Teenagers’ circadian rhythms shift later during puberty.';
const hash = W.pasteHash(text);
const pasteOp = (t, h = hash) => ({ n: 5, k: 'i', at: 0, s: text, t, src: 'paste', paste: { hash: h, len: text.length, origin: null, internal: false } });
const copy = (studentId, t, url = 'https://www.cdc.gov/sleep/', h = hash) => ({ studentId, hash: h, url, title: 'Sleep | CDC', t });

test('a paste is matched to the same student’s copy within 3 hours', () => {
  const [op] = R.matchPasteOrigins([pasteOp(T)], [copy('s1', T - 2 * 3600e3)], { studentId: 's1' });
  assert.deepStrictEqual(op.paste.origin, { url: 'https://www.cdc.gov/sleep/', title: 'Sleep | CDC', copiedAt: new Date(T - 2 * 3600e3).toISOString() });
});

test('copies older than 3 hours don’t match', () => {
  const [op] = R.matchPasteOrigins([pasteOp(T)], [copy('s1', T - 3 * 3600e3 - 1000)], { studentId: 's1' });
  assert.strictEqual(op.paste.origin, null);
});

test('another student’s copy never matches', () => {
  const [op] = R.matchPasteOrigins([pasteOp(T)], [copy('s2', T - 60e3)], { studentId: 's1' });
  assert.strictEqual(op.paste.origin, null);
});

test('a different hash doesn’t match; the most recent matching copy wins', () => {
  const copies = [copy('s1', T - 600e3, 'https://old.example/'), copy('s1', T - 60e3, 'https://new.example/'), copy('s1', T - 30e3, 'https://other.example/', 'f'.repeat(64))];
  const [op] = R.matchPasteOrigins([pasteOp(T)], copies, { studentId: 's1' });
  assert.strictEqual(op.paste.origin.url, 'https://new.example/');
  const [op2] = R.matchPasteOrigins([pasteOp(T, 'e'.repeat(64))], copies.slice(0, 2), { studentId: 's1' });
  assert.strictEqual(op2.paste.origin, null);
});

test('copies made after the paste don’t count', () => {
  const [op] = R.matchPasteOrigins([pasteOp(T)], [copy('s1', T + 5 * 60e3)], { studentId: 's1' });
  assert.strictEqual(op.paste.origin, null);
});

test('the copy hash is the whitespace-collapsed text, as the extension computes it', () => {
  assert.strictEqual(W.pasteHash('  Teenagers’ circadian\n rhythms   shift later during puberty. '), hash);
});

test('events are cleaned and capped', () => {
  const ev = R.cleanEvents([
    { type: 'search', t: T, url: 'https://www.google.com/search?q=' + 'x'.repeat(3000), query: 'q'.repeat(900), engine: 'google' },
    { type: 'copy', t: T + 1, url: 'https://a.example/', copy: { hash: 'nope', len: 40, preview: 'x' } },
    { type: 'made-up', t: T + 2 },
    { type: 'leave', t: T + 3, url: 'https://a.example/', dwellMs: 1234.4 }
  ], T + 10);
  assert.deepStrictEqual(ev.map(e => e.type), ['search', 'leave']);
  assert.strictEqual(ev[0].url.length, 2000);
  assert.strictEqual(ev[0].query.length, 500);
  assert.strictEqual(ev[0].host, 'www.google.com');
  assert.strictEqual(ev[1].dwellMs, 1234);
  assert.throws(() => R.cleanEvents(new Array(201).fill({ type: 'visit' })), e => e.status === 413);
});

test('events go into 500-event chunks per session', () => {
  const s = { id: 'sess', docId: 'd', studentId: 's1', assignmentId: 'a', classId: 'c' };
  const ev = n => Array.from({ length: n }, (_, i) => ({ t: T + i, type: 'visit', url: 'https://a.example/' }));
  let chunks = R.appendEvents(s, null, ev(480));
  assert.deepStrictEqual(chunks.map(c => [c.id, c.events.length]), [['sess:0000', 480]]);
  chunks = R.appendEvents(s, chunks[0], ev(30));
  assert.deepStrictEqual(chunks.map(c => [c.id, c.events.length]), [['sess:0000', 500], ['sess:0001', 10]]);
  assert.strictEqual(chunks[1].classId, 'c');
});

test('research batches are rate limited per session', () => {
  let ok = 0;
  for (let i = 0; i < 40; i++) if (R.rateLimit('k', T)) ok++;
  assert.strictEqual(ok, 30);
  assert.ok(R.rateLimit('k', T + 10000), 'tokens come back over the minute');
});
