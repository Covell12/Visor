// lib/discussion.js (measured stats, merging, hints) and the discussion flow
// end to end: 10-minute segments, transcription with the previous segment's
// voices as hints, the voice wizard on the class roster, measured stats and the
// AI-written summary. "Gemini" here is a stand-in server on this machine.
'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-disc-'));
Object.assign(process.env, {
  PGLITE_DIR: path.join(DATA, 'pglite'), VISOR_AUDIO_DIR: path.join(DATA, 'audio'), SESSION_SECRET: 'test-secret', NODE_ENV: 'test',
  GEMINI_VIA: 'apikey', GEMINI_API_KEY: 'stand-in-key', GEMINI_MODEL: 'stand-in', VERTEX_BASE_URL: 'http://127.0.0.1:9', DRIVE_API_BASE: 'http://127.0.0.1:9',
  GOOGLE_CLIENT_ID: '', GOOGLE_API_KEY: '', GOOGLE_APP_ID: ''
});

const test = require('node:test');
const assert = require('node:assert');
const D = require('../lib/discussion');

/* ---------------- unit ---------------- */
const roster = [{ id: 's1', name: 'Ana Ruiz' }, { id: 's2', name: 'Ben Cho' }, { id: 's3', name: 'Cal Diaz' }];
const teacher = { id: 't1', name: 'Ms. Teacher' };
const speakers = [
  { label: 'Speaker 1', assignedName: 'Ms. Teacher', assignedUserId: 't1' },
  { label: 'Speaker 2', assignedName: 'Ana Ruiz', assignedUserId: 's1' },
  { label: 'Speaker 3', assignedName: 'Ben Cho', assignedUserId: 's2' }
];

test('lines across segments get times from the start of the whole discussion', () => {
  const lines = D.mergedLines([
    { k: 1, durationSec: 300, lines: [{ t: '00:05', speaker: 'Speaker 2', text: 'Second part.' }] },
    { k: 0, durationSec: 600, lines: [{ t: '00:00', speaker: 'Speaker 1', text: 'Welcome.' }, { t: '9:58', speaker: 'Speaker 2', text: 'End of part one.' }] }
  ]);
  assert.deepStrictEqual(lines.map(l => [l.i, l.at, l.t]), [[0, 0, '0:00'], [1, 598, '9:58'], [2, 605, '10:05']]);
  assert.strictEqual(D.parseTime('1:02:03'), 3723);
});

test('measured: talk time, turns, words, longest turn, first contribution, follows, didn’t speak', () => {
  const lines = D.mergedLines([{ k: 0, durationSec: 600, lines: [
    { t: '0:00', speaker: 'Speaker 1', text: 'What did you think of chapter four?' },
    { t: '0:10', speaker: 'Speaker 2', text: 'I think Gatsby is lonely.' },
    { t: '0:20', speaker: 'Speaker 2', text: 'He throws parties for one person.' },
    { t: '0:30', speaker: 'Speaker 3', text: 'I disagree, he wants to be seen.' },
    { t: '2:00', speaker: 'Speaker 2', text: 'Both can be true.' },
    { t: '2:05', speaker: 'Speaker 1', text: 'Good.' }
  ] }]);
  const m = D.measure(lines, speakers, roster, teacher);
  const ana = m.students.find(s => s.userId === 's1'), ben = m.students.find(s => s.userId === 's2');
  assert.strictEqual(ana.turns, 2);
  assert.strictEqual(ana.talkSec, 25);           // 10 + 10 + 5
  assert.strictEqual(ana.words, 15);
  assert.strictEqual(ana.longestTurnSec, 20);
  assert.strictEqual(ana.firstAtText, '0:10');
  assert.strictEqual(ben.talkSec, 60, 'a line runs until the next one starts, capped at a minute');
  assert.deepStrictEqual(m.didntSpeak, [{ userId: 's3', name: 'Cal Diaz' }]);
  assert.strictEqual(m.distinctStudentSpeakers, 2);
  assert.strictEqual(m.follows.counts.s1.s2, 1);
  assert.strictEqual(m.follows.counts.s2.s1, 1);
  assert.strictEqual(m.follows.counts.t1.s1, 1);
  assert.ok(m.teacherSharePct > 0 && m.studentSharePct > m.teacherSharePct);
});

test('voices merge across segments, keeping names already given', () => {
  const merged = D.mergeSpeakers([
    { k: 0, speakers: [{ label: 'Speaker 1', quotes: ['a'] }, { label: 'Speaker 2', quotes: ['b'] }] },
    { k: 1, speakers: [{ label: 'Speaker 2', quotes: ['c'] }, { label: 'Speaker 3', quotes: ['d'] }] }
  ], [{ label: 'Speaker 2', assignedName: 'Ana Ruiz', assignedUserId: 's1' }]);
  assert.deepStrictEqual(merged.map(s => [s.label, s.quotes[0], s.assignedName]), [['Speaker 1', 'a', null], ['Speaker 2', 'b', 'Ana Ruiz'], ['Speaker 3', 'd', null]]);
  const hints = D.hintsFrom({ speakers: [{ label: 'Speaker 1', quotes: ['one', 'two', 'three'], voice: 'low' }] });
  assert.deepStrictEqual(hints, [{ label: 'Speaker 1', quotes: ['one', 'two'], voice: 'low' }]);
  assert.match(D.hintsText(hints), /If a voice matches a speaker from the previous part, reuse that label/);
});

test('the AI summary keeps only quotes from the student’s own lines', () => {
  const lines = D.mergedLines([{ k: 0, durationSec: 60, lines: [{ t: '0:01', speaker: 'Speaker 2', text: 'I think Gatsby is lonely.' }, { t: '0:05', speaker: 'Speaker 3', text: 'Why would he be?' }] }]);
  const ai = D.sanitizeAI({ students: [
    { name: 'Ana Ruiz', types: { 'new-idea': { count: 1, quote: 'Gatsby is lonely', line: 1 }, 'made-up': { count: 3 } } },
    { name: 'Ben Cho', types: { question: { count: 2.4, quote: 'Why would he be?', line: 1 } } },
    { name: 'Nobody', types: { question: { count: 1 } } }
  ], groupDynamics: 'Lively.', suggestions: ['Invite Cal in.'] }, { lines, speakers, roster, teacher });
  assert.deepStrictEqual(ai.students.map(s => s.name), ['Ana Ruiz', 'Ben Cho']);
  assert.strictEqual(ai.students[0].types['new-idea'].line, 0, 'a wrong line number is corrected to the student’s own line');
  assert.strictEqual(ai.students[1].types.question.count, 2);
  assert.ok(!('made-up' in ai.students[0].types));
});

/* ---------------- end to end, with a stand-in Gemini ---------------- */
const prompts = [];
let gemini;
function standInGemini() {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const parts = JSON.parse(body).contents[0].parts;
      const prompt = parts[0].text;
      prompts.push(prompt);
      let out;
      if (/class discussion at school/.test(prompt) && !/continues an earlier part/.test(prompt)) {
        out = { lines: [{ t: '0:00', speaker: 'Speaker 1', text: 'Let us start with chapter four.' }, { t: '0:12', speaker: 'Speaker 2', text: 'Gatsby throws parties for one person.' }],
          speakers: [{ label: 'Speaker 1', quotes: ['Let us start with chapter four.'], voice: 'adult' }, { label: 'Speaker 2', quotes: ['Gatsby throws parties for one person.'], voice: 'higher' }] };
      } else if (/class discussion at school/.test(prompt)) {
        out = { lines: [{ t: '0:03', speaker: 'Speaker 2', text: 'And Daisy never comes.' }, { t: '0:15', speaker: 'Speaker 3', text: 'Maybe he does not want her to.' }],
          speakers: [{ label: 'Speaker 2', quotes: ['And Daisy never comes.'] }, { label: 'Speaker 3', quotes: ['Maybe he does not want her to.'] }] };
      } else {
        out = { students: [{ name: 'Ana Ruiz', types: { 'new-idea': { count: 2, quote: 'Gatsby throws parties for one person.', line: 1 } } }], groupDynamics: 'Ana led; Ben added a counterpoint.', suggestions: ['Invite Cal in.'] };
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }] }));
    });
  });
}

let server, base;
test.before(async () => {
  gemini = standInGemini();
  await new Promise(r => gemini.listen(0, '127.0.0.1', r));
  process.env.GEMINI_BASE_URL = `http://127.0.0.1:${gemini.address().port}`;
  const app = require('../server');
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); gemini.close(); fs.rmSync(DATA, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  return async (method, url, body, headers = {}) => {
    const isBuf = Buffer.isBuffer(body);
    const r = await fetch(base + url, { method, headers: { ...(body && !isBuf ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body ? (isBuf ? body : JSON.stringify(body)) : undefined });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    let data = null; try { data = await r.json(); } catch {}
    return { status: r.status, data };
  };
}
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 100)); } };

test('a two-segment discussion: hints, voices, measured stats, AI summary, student view', async () => {
  const T = client(), A = client(), B = client(), C = client();
  await T('POST', '/api/auth/signup', { email: 'dt@s.test', password: 'secret12', firstName: 'Dee', lastName: 'Teacher', role: 'teacher' });
  const cls = (await T('POST', '/api/classes', { name: 'English 11' })).data.class;
  const ids = {};
  for (const [c, f, l] of [[A, 'Ana', 'Ruiz'], [B, 'Ben', 'Cho'], [C, 'Cal', 'Diaz']]) ids[f] = (await c('POST', '/api/auth/signup', { email: `${f}@s.test`, password: 'secret12', firstName: f, lastName: l, role: 'student', over13: true, classCode: cls.joinCode })).data.user.id;
  const a = (await T('POST', `/api/classes/${cls.id}/assignments`, { type: 'discussion', title: 'Gatsby seminar', instructions: 'Is Gatsby lonely?', discussion: { shareOwnStats: true } })).data.assignment;
  await T('POST', `/api/assignments/${a.id}/publish`, {});

  let r = await T('POST', `/api/assignments/${a.id}/discussions`, {});
  assert.strictEqual(r.status, 409, 'the recording notice comes first');
  r = await T('POST', `/api/classes/${cls.id}/discussion-consent`, { confirmed: true });
  assert.ok(r.data.class.discussionConsentAt);
  const d = (await T('POST', `/api/assignments/${a.id}/discussions`, { source: 'recorder' })).data.discussion;
  assert.strictEqual(d.status, 'recording');

  // Two 10-minute segments, uploaded as the recorder finishes each one
  for (const k of [0, 1]) {
    const bytes = Buffer.from(`fake webm audio, segment ${k}`);
    const up = await T('POST', `/api/discussions/${d.id}/uploads`, { filename: `segment-${k}.webm`, mime: 'audio/webm', size: bytes.length, k });
    assert.strictEqual(up.status, 200);
    await T('PUT', `/api/discussions/${d.id}/uploads/chunk?offset=0`, bytes, { 'Content-Type': 'application/octet-stream', 'X-Upload-Token': up.data.uploadToken });
    r = await T('POST', `/api/discussions/${d.id}/segments`, { uploadToken: up.data.uploadToken, duration: 600, last: k === 1 });
    assert.strictEqual(r.status, 200);
  }
  const done = await until(async () => { const x = (await T('GET', `/api/discussions/${d.id}`)).data.discussion; return x.segments.every(s => s.status === 'ready') && x; });
  // Segment 2 was told about segment 1's voices
  const p2 = prompts.find(p => /continues an earlier part/.test(p));
  assert.ok(p2, 'the second segment’s prompt carries hints');
  assert.match(p2, /Speaker 2 \(higher\): "Gatsby throws parties for one person\."/);
  assert.match(p2, /Ana Ruiz/);
  assert.deepStrictEqual(done.speakers.map(s => s.label), ['Speaker 1', 'Speaker 2', 'Speaker 3']);
  assert.deepStrictEqual(done.transcript.map(l => l.t), ['0:00', '0:12', '10:03', '10:15']);
  assert.strictEqual(done.status, 'identify');

  // The voice wizard, with the class roster
  r = await T('POST', `/api/discussions/${d.id}/speakers`, { assignments: { 'Speaker 1': { name: 'Dee Teacher', userId: cls.teacher?.id || null }, 'Speaker 2': { name: 'Ana Ruiz', userId: ids.Ana }, 'Speaker 3': { name: 'Ben Cho', userId: ids.Ben } } });
  assert.strictEqual(r.data.discussion.status, 'ready');
  r = await T('POST', `/api/discussions/${d.id}/analyze`, {});
  const an = r.data.discussion.analysis;
  const ana = an.measured.students.find(s => s.userId === ids.Ana);
  assert.strictEqual(ana.turns, 1, 'one turn spans the segment boundary');
  assert.deepStrictEqual(an.measured.didntSpeak.map(s => s.name), ['Cal Diaz']);
  assert.strictEqual(an.ai.students[0].types['new-idea'].line, 1);
  assert.strictEqual(an.ai.groupDynamics, 'Ana led; Ben added a counterpoint.');

  // Students see only their own numbers, and only when shared
  r = await A('GET', `/api/assignments/${a.id}`);
  assert.strictEqual(r.data.myStats[0].mine.turns, 1);
  assert.ok(!JSON.stringify(r.data).includes('Ben Cho'), 'no other student’s numbers');
  r = await A('GET', `/api/discussions/${d.id}`);
  assert.strictEqual(r.status, 403);
  await T('PATCH', `/api/assignments/${a.id}`, { discussion: { shareOwnStats: false } });
  r = await C('GET', `/api/assignments/${a.id}`);
  assert.strictEqual(r.data.myStats, null);
});
