// lib/process.js: the op log through the shared engine, attribution by
// source, and the rule-based notes for the teacher.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const W = require('../lib/writing');
const P = require('../lib/process');
const { VisorChangelog } = require('../lib/engine/changelog.js');

const T0 = Date.parse('2026-10-12T14:00:00Z');

// Build a document the way the server does: newDoc + applyBatch, keeping the log
function makeDoc(template = '') {
  const { doc, firstOps } = W.newDoc({ id: 'd1', assignmentId: 'a1', classId: 'c1', studentId: 's1', templateText: template, now: T0 });
  return { doc, log: [...firstOps] };
}
function write(state, ops, { sid = 'sess1', t } = {}) {
  let clock = t ?? (state.log.length ? state.log[state.log.length - 1].t : T0);
  const raw = ops.map(o => ({ t: (clock += o.gap ?? 250), ...o }));
  state.log.push(...W.applyBatch(state.doc, raw, { baseSeq: state.doc.seq, sid, surf: 'tab', now: clock }));
}
const typeText = (state, at, text, opts) => write(state, [...text].map((ch, i) => ({ k: 'i', at: at + i, s: ch, src: 'type' })), opts);
const session = (id, from, to, extra = {}) => ({ id, docId: 'd1', studentId: 's1', startedAt: new Date(from).toISOString(), endedAt: new Date(to).toISOString(), lastBeat: new Date(to).toISOString(), endReason: 'student', pauses: [], events: [], ...extra });

test('op log -> engine entries -> buildTimeline reproduces the document exactly', () => {
  const st = makeDoc('Title:\n\n');
  typeText(st, st.doc.text.length, 'Sleep matters for teens.');
  write(st, [{ k: 'd', at: 8, len: 6, src: 'type' }, { k: 'i', at: 8, s: 'Rest', src: 'type' }]);
  write(st, [{ k: 'f', at: 0, len: 6, attrs: { bold: true }, src: 'type' }]);
  write(st, [{ k: 'i', at: st.doc.text.length, s: ' A pasted sentence about circadian rhythms.', src: 'paste', paste: { internal: false } }], { sid: 'sess2', t: T0 + 3600e3 });
  write(st, [{ k: 'd', at: 0, len: 3, src: 'undo' }, { k: 'i', at: 0, s: 'Tit', src: 'redo' }]);
  // a long random tail
  let seed = 3;
  const rnd = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor((seed / 2147483648) * n); };
  for (let i = 0; i < 300; i++) {
    const L = st.doc.text.length;
    if (rnd(4) === 0 && L > 5) { const at = rnd(L - 2); write(st, [{ k: 'd', at, len: 1 + rnd(Math.min(4, L - at - 1)), src: 'type', gap: rnd(3000) }]); }
    else write(st, [{ k: 'i', at: rnd(L + 1), s: 'xyz '.slice(rnd(3)), src: 'type', gap: rnd(3000) }]);
  }
  const entries = P.opsToEntries(st.log, 's1');
  assert.ok(entries.length < st.log.length, 'ops close together are grouped');
  assert.strictEqual(entries[0].userId, 'teacher-template');
  assert.deepStrictEqual(entries[0].mutation.mts[0], { ty: 'is', ibi: 1, s: 'Title:\n\n' });
  const tl = VisorChangelog.buildTimeline(entries, [{ id: 's1', name: 'Sam' }, { id: 'teacher-template', name: 'Teacher template' }]);
  assert.strictEqual(tl.finalText, st.doc.text);
  const r = P.build({ doc: st.doc, ops: st.log, sessions: [session('sess1', T0, T0 + 1800e3), session('sess2', T0 + 3600e3, T0 + 4000e3)], studentName: 'Sam Student', title: 'Essay' });
  assert.strictEqual(r.engine.matchesDoc, true);
  assert.strictEqual(r.engine.report.source, 'visor-extension');
  assert.ok(r.engine.report.contributors.some(c => c.name === 'Teacher template'));
});

test('attribution: typed, pasted (research, outside, internal), cited and template text', () => {
  const st = makeDoc('Name: ');                                           // 6 template chars (5 non-space)
  typeText(st, 6, 'abcdefghij');                                          // 10 typed
  write(st, [{ k: 'i', at: 16, s: 'RESEARCHED', src: 'paste', paste: { internal: false } }]);   // 10, origin set below
  st.log[st.log.length - 1].paste.origin = { url: 'https://www.cdc.gov/sleep', title: 'CDC', copiedAt: new Date(T0).toISOString() };
  write(st, [{ k: 'i', at: 26, s: 'OUTSIDEXXXYYYYY', src: 'paste', paste: { internal: false } }]);  // 15 outside
  write(st, [{ k: 'i', at: 41, s: 'abcde', src: 'paste', paste: { internal: true } }]);            // 5 internal
  write(st, [{ k: 'i', at: 46, s: '(Lopez)', src: 'cite' }]);                                     // 7 cited
  write(st, [{ k: 'i', at: 53, s: 'INJECT', src: 'other', it: 'none' }]);                          // 6 other
  write(st, [{ k: 'd', at: 26, len: 5, src: 'type' }]);                                            // 5 of the outside paste deleted
  const tags = P.provenance(st.log);
  const s = P.survival(tags, st.doc.text);
  assert.deepStrictEqual(s.chars, { typed: 10, 'pasted-internal': 5, 'pasted-research': 10, 'pasted-outside': 10, cited: 7, template: 5, other: 6, image: 0 });
  assert.strictEqual(s.total, 53);
  assert.strictEqual(s.pct.typed, 19);
  assert.strictEqual(s.pct['pasted-outside'], 19);
  assert.strictEqual(s.pct.template, 9);
  assert.deepStrictEqual(s.runs.slice(0, 3).map(r => r.c), ['template', 'typed', 'pasted-research']);
  const r = P.build({ doc: st.doc, ops: st.log, sessions: [session('sess1', T0, T0 + 600e3)], studentName: 'Sam' });
  const outside = r.pastes.find(p => p.kind === 'outside');
  assert.strictEqual(outside.len, 15);
  assert.strictEqual(outside.survivedChars, 10);
  assert.strictEqual(r.pastes.find(p => p.kind === 'research').origin.url, 'https://www.cdc.gov/sleep');
});

// Fixtures that trigger each rule
function fixture() {
  const st = makeDoc('');
  // ~1,200 typed characters over ~10 active minutes
  const sentence = 'Teenagers need more sleep than adults and school starts too early for them. ';
  for (let i = 0; i < 16; i++) typeText(st, st.doc.text.length, sentence, { t: T0 + i * 40e3 });
  write(st, [{ k: 'i', at: st.doc.text.length, s: ' ' + 'Pasted from somewhere with no copy recorded in any session at all. '.repeat(8), src: 'paste', paste: { internal: false } }]);
  write(st, [{ k: 'i', at: st.doc.text.length, s: ' Copied from the CDC page during the session, word for word. '.repeat(6), src: 'paste', paste: { internal: false, origin: { url: 'https://www.cdc.gov/sleep/', title: 'CDC', copiedAt: new Date(T0).toISOString() } } }]);
  st.log[st.log.length - 1].paste.origin = { url: 'https://www.cdc.gov/sleep/', title: 'CDC', copiedAt: new Date(T0).toISOString() };
  write(st, [{ k: 'i', at: st.doc.text.length, s: 'An injected block of text that arrived with no keyboard or paste event at all, which is what a tool does.', src: 'other', it: 'none' }]);
  const pauses = [1, 2, 3, 4].map(i => ({ from: new Date(T0 + i * 100e3).toISOString(), to: new Date(T0 + i * 100e3 + 90e3).toISOString(), reason: 'left-tab' }));
  const events = [
    { t: T0 + 50e3, type: 'ai-site', host: 'chatgpt.com', blocked: true },
    { t: T0 + 51e3, type: 'ai-site', host: 'chatgpt.com', blocked: true },
    { t: T0 + 60e3, type: 'lock-violation', host: 'reddit.com' },
    { t: T0 + 70e3, type: 'paste-blocked', len: 300 },
    { t: T0 + 80e3, type: 'ext-missing', detail: 'turned-off' }
  ];
  return { st, sessions: [session('sess1', T0, T0 + 900e3, { pauses, events })] };
}

test('notes for the teacher: one per rule, factual', () => {
  const { st, sessions } = fixture();
  const r = P.build({ doc: { ...st.doc, autoSubmitted: true }, ops: st.log, sessions, studentName: 'Sam', baselineWpm: 30 });
  const rules = r.notes.map(n => n.rule);
  for (const rule of ['outside-paste', 'research-paste', 'left', 'ai-site', 'lock-violation', 'injected', 'paste-blocked', 'ext-missing', 'pace', 'auto-submit']) {
    assert.ok(rules.includes(rule), `a "${rule}" note`);
  }
  const text = rule => r.notes.find(n => n.rule === rule).text;
  assert.match(text('outside-paste'), /^\d+% of the final text was pasted from outside Visor’s view \(1 paste\)\.$/);
  assert.match(text('research-paste'), /from cdc\.gov\)\.$/);
  assert.strictEqual(text('left'), 'Left the writing tab 4 times, 6 min in total.');
  assert.strictEqual(text('ai-site'), 'Visited chatgpt.com during session 1 (2 times) (blocked).');
  assert.match(text('injected'), /^A 105-character block appeared with no keyboard or paste event \(often a browser extension or tool inserting text\)\.$/);
  assert.match(text('pace'), /^Wrote [\d,]+ words in \d+ active minutes \(\d+ wpm\)/);
  // No note is an accusation. Only the AI-site note may name an AI site.
  for (const n of r.notes) {
    assert.ok(!/cheat|plagiar/i.test(n.text), n.text);
    assert.ok(!/\bAI\b/.test(n.text), n.text);
    if (n.rule !== 'ai-site') assert.ok(!/chatgpt/i.test(n.text), n.text);
  }
});

test('pace compared with the student’s usual typing in this class', () => {
  const { st, sessions } = fixture();
  const at = baselineWpm => P.build({ doc: st.doc, ops: st.log, sessions, studentName: 'Sam', baselineWpm }).notes.find(n => n.rule === 'pace').text;
  const wpm = Number(/\((\d+) wpm\)/.exec(at(null))[1]);
  assert.match(at(wpm), /in line with this student’s typing in this class\.$/);
  assert.match(at(wpm / 3), /faster than this student’s usual/);
  assert.ok(!/usual|in line/.test(at(null)), 'no comparison without earlier work');
});

test('research with the side panel open: its own figure and note, never time away', () => {
  const st = makeDoc('');
  typeText(st, 0, 'A short typed answer.');
  const spans = [{ from: new Date(T0 + 60e3).toISOString(), to: new Date(T0 + 240e3).toISOString() }];
  const sessions = [session('sess1', T0, T0 + 600e3, { researchSpans: spans }), session('sess2', T0 + 3600e3, T0 + 3700e3, { researchSpans: [{ from: new Date(T0 + 3610e3).toISOString(), to: new Date(T0 + 3630e3).toISOString() }] })];
  const r = P.build({ doc: st.doc, ops: st.log, sessions, studentName: 'Sam' });
  assert.deepStrictEqual(r.sessions.map(s => s.researchMs), [180e3, 20e3]);
  assert.strictEqual(r.totals.researchMs, 200e3);
  assert.strictEqual(r.totals.awayMs, 0);
  assert.deepStrictEqual(r.notes.map(n => n.text), ['Researched on other tabs with the side panel open for 3 min in session 1.']);
});

test('a quiet, typed essay gets no warnings', () => {
  const st = makeDoc('');
  typeText(st, 0, 'A short typed answer.');
  const r = P.build({ doc: st.doc, ops: st.log, sessions: [session('sess1', T0, T0 + 120e3)], studentName: 'Sam' });
  assert.deepStrictEqual(r.notes, []);
  assert.strictEqual(r.survival.pct.typed, 100);
});

test('images: their own category, never counted as text, and a note', () => {
  const E = W.EMBED;
  const id = n => String(n).repeat(32).slice(0, 32);
  assert.strictEqual(P.categoryOf({ src: 'image' }), 'image');
  assert.strictEqual(P.categoryOf({ src: 'structure' }), 'typed');
  assert.strictEqual(P.CATEGORY.image, 'Image');
  const st = makeDoc('');
  typeText(st, 0, 'My chart: ');
  write(st, [{ k: 'i', at: 10, s: E, src: 'image', attrs: { image: id(1) } }]);
  write(st, [{ k: 'i', at: 11, s: E, src: 'image', attrs: { image: id(2), width: '300' } }]);
  write(st, [{ k: 'i', at: 12, s: E, src: 'image', attrs: { image: id(3) } }]);
  write(st, [{ k: 'd', at: 12, len: 1, src: 'type' }]);                 // the third is deleted again
  typeText(st, 12, ' done');
  assert.strictEqual(st.doc.text, 'My chart: ' + E + E + ' done');
  const s = P.survival(P.provenance(st.log), st.doc.text);
  assert.strictEqual(s.chars.image, 0, 'an image is not text');
  assert.strictEqual(s.images, 2);
  assert.strictEqual(s.total, 12);
  assert.strictEqual(s.pct.typed, 100);
  assert.deepStrictEqual(s.runs, [{ at: 0, len: 10, c: 'typed' }, { at: 10, len: 2, c: 'image' }, { at: 12, len: 5, c: 'typed' }]);
  const r = P.build({ doc: st.doc, ops: st.log, sessions: [session('sess1', T0, T0 + 600e3)], studentName: 'Sam' });
  assert.strictEqual(r.totals.words, 3, 'images aren’t words');
  assert.strictEqual(r.survival.images, 2);
  assert.strictEqual(r.engine.matchesDoc, true);
  assert.deepStrictEqual(r.notes.map(n => n.text), ['Inserted 2 images.']);
  // One image: singular
  const one = makeDoc('');
  write(one, [{ k: 'i', at: 0, s: E, src: 'image', attrs: { image: id(4) } }]);
  assert.deepStrictEqual(P.build({ doc: one.doc, ops: one.log, sessions: [session('sess1', T0, T0 + 600e3)], studentName: 'Sam' }).notes.map(n => n.text), ['Inserted 1 image.']);
});

test('structure from the toolbar counts as typed, never as an injected block', () => {
  const st = makeDoc('');
  typeText(st, 0, 'Results');
  // A 12 × 10 table: 120 cell line breaks in one insert, with no keyboard event
  write(st, [{ k: 'i', at: 7, s: '\n'.repeat(120), src: 'structure', attrs: { table: 'row-a1' } }]);
  write(st, [{ k: 'i', at: 127, s: 'A heading made from the menu, then a long line the menu restyled as a whole block of text.', src: 'structure' }]);
  const r = P.build({ doc: st.doc, ops: st.log, sessions: [session('sess1', T0, T0 + 600e3)], studentName: 'Sam' });
  assert.ok(!r.notes.some(n => n.rule === 'injected'), 'no injected note');
  assert.strictEqual(r.survival.chars.other, 0);
  assert.strictEqual(r.survival.pct.typed, 100);
});
