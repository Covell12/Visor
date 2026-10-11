// Class discussions (Section 10): a recorded discussion, transcribed in
// 10-minute segments, its voices matched to the class roster, then measured.
//
// The measured half is plain arithmetic on the transcript's timestamps: talk
// time, turns, words, longest turn, first contribution, who spoke right after
// whom, teacher vs. students. Nothing in it comes from AI.
//
// The AI-written half (Gemini, through server.js's geminiJSON) counts each
// student's contribution types with one quoted example each, and writes a
// short summary of the group's dynamics with suggestions. It's labelled
// "AI-written summary: check against the transcript" wherever it's shown,
// and every quote is tied to the transcript line it came from.

const SEGMENT_SEC = 10 * 60;
const LINE_CAP_SEC = 60;        // a line's length is estimated up to this
const SECONDS_PER_WORD = 0.4;   // for the last line, which has no next line
const TYPES = ['new-idea', 'evidence', 'question', 'builds-on', 'disagrees', 'summarizes', 'off-topic'];
const TYPE_LABEL = { 'new-idea': 'New idea', evidence: 'Evidence or example', question: 'Question', 'builds-on': 'Builds on someone', disagrees: 'Disagrees respectfully', summarizes: 'Summarizes', 'off-topic': 'Off-topic' };

// "mm:ss", "h:mm:ss", "75" -> seconds (null if unreadable)
function parseTime(t) {
  const s = String(t || '').trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const parts = s.split(':').map(Number);
  if (!parts.length || parts.some(n => !Number.isFinite(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}
const fmtTime = sec => { const s = Math.max(0, Math.round(sec)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`; };
const words = t => (String(t).trim() ? String(t).trim().split(/\s+/).length : 0);

// Every line of every segment, in order, with its time from the start of the
// whole discussion. Segment k starts where the segments before it ended.
function mergedLines(segments) {
  const out = [];
  let offset = 0;
  for (const seg of [...segments].sort((a, b) => a.k - b.k)) {
    let last = 0;
    for (const l of seg.lines || []) {
      const t = parseTime(l.t);
      const at = offset + (t == null ? last : t);
      last = t == null ? last : t;
      out.push({ i: out.length, k: seg.k, at, t: fmtTime(at), speaker: l.speaker, text: l.text });
    }
    const dur = Number(seg.durationSec) || 0;
    offset += dur > 0 ? dur : Math.max(SEGMENT_SEC, last + 5);
  }
  return out;
}

// One voice across segments: labels are kept consistent by the transcription
// hints, so the same label is the same voice. First quotes win; names already
// given to a label are kept.
function mergeSpeakers(segments, previous = []) {
  const map = new Map();
  for (const seg of [...segments].sort((a, b) => a.k - b.k)) {
    for (const sp of seg.speakers || []) {
      if (!map.has(sp.label)) map.set(sp.label, { label: sp.label, quotes: [...(sp.quotes || [])].slice(0, 3), voice: sp.voice || '', assignedName: null, assignedUserId: null });
    }
  }
  for (const p of previous) if (map.has(p.label)) Object.assign(map.get(p.label), { assignedName: p.assignedName || null, assignedUserId: p.assignedUserId || null });
  return [...map.values()];
}

// What segment k's transcription is told about segment k-1: each label and two
// things that voice said, so the same voice keeps the same label.
function hintsFrom(prevSegment) {
  if (!prevSegment || !prevSegment.speakers?.length) return null;
  return prevSegment.speakers.map(sp => ({ label: sp.label, quotes: (sp.quotes || []).slice(0, 2), voice: sp.voice || '' }));
}
function hintsText(hints) {
  if (!hints || !hints.length) return '';
  return `\nThis recording continues an earlier part of the same discussion. The voices in that part were labelled like this:\n${hints.map(h => `- ${h.label}${h.voice ? ` (${h.voice})` : ''}: ${h.quotes.map(q => `"${String(q).slice(0, 160)}"`).join(', ')}`).join('\n')}\nIf a voice matches a speaker from the previous part, reuse that label. Label new voices with the next unused number.\n`;
}

// Who a transcript speaker is: { key, name, userId, role }
function resolver(speakers, roster, teacher) {
  return label => {
    const sp = speakers.find(s => s.label === label);
    if (!sp || !sp.assignedName) return { key: `label:${label}`, name: label, userId: null, role: 'unknown' };
    if (sp.assignedUserId && teacher && sp.assignedUserId === teacher.id) return { key: teacher.id, name: sp.assignedName, userId: teacher.id, role: 'teacher' };
    const st = sp.assignedUserId ? roster.find(r => r.id === sp.assignedUserId) : null;
    if (st) return { key: st.id, name: st.name, userId: st.id, role: 'student' };
    return { key: `name:${sp.assignedName.toLowerCase()}`, name: sp.assignedName, userId: null, role: 'other' };
  };
}

// The measured half. roster: [{ id, name }]; teacher: { id, name }
function measure(lines, speakers, roster, teacher) {
  const who = resolver(speakers, roster, teacher);
  // Each line's length: until the next line starts, capped at a minute
  const timed = lines.map((l, i) => {
    const next = lines[i + 1];
    const len = next && next.at > l.at ? Math.min(LINE_CAP_SEC, next.at - l.at) : Math.min(LINE_CAP_SEC, Math.max(2, words(l.text) * SECONDS_PER_WORD));
    return { ...l, len, person: who(l.speaker) };
  });
  // Turns: consecutive lines by the same person
  const turns = [];
  for (const l of timed) {
    const last = turns[turns.length - 1];
    if (last && last.person.key === l.person.key) { last.len += l.len; last.words += words(l.text); last.lines.push(l.i); }
    else turns.push({ person: l.person, at: l.at, len: l.len, words: words(l.text), lines: [l.i] });
  }
  const people = new Map();
  const row = p => {
    if (!people.has(p.key)) people.set(p.key, { key: p.key, userId: p.userId, name: p.name, role: p.role, talkSec: 0, turns: 0, words: 0, longestTurnSec: 0, firstAt: null });
    return people.get(p.key);
  };
  for (const r of roster) row({ key: r.id, userId: r.id, name: r.name, role: 'student' });
  for (const t of turns) {
    const r = row(t.person);
    r.talkSec += t.len; r.turns += 1; r.words += t.words;
    r.longestTurnSec = Math.max(r.longestTurnSec, t.len);
    if (r.firstAt == null) r.firstAt = t.at;
  }
  const all = [...people.values()].map(r => ({ ...r, talkSec: Math.round(r.talkSec), longestTurnSec: Math.round(r.longestTurnSec), firstAtText: r.firstAt == null ? null : fmtTime(r.firstAt) }));
  const totalTalk = all.reduce((a, r) => a + r.talkSec, 0) || 1;
  for (const r of all) r.sharePct = Math.round((100 * r.talkSec) / totalTalk);
  const students = all.filter(r => r.role === 'student').sort((a, b) => b.talkSec - a.talkSec || a.name.localeCompare(b.name));
  // Who spoke right after whom
  const keys = [...new Set(turns.map(t => t.person.key))];
  const follows = {};
  for (let i = 1; i < turns.length; i++) {
    const a = turns[i - 1].person.key, b = turns[i].person.key;
    follows[a] = follows[a] || {};
    follows[a][b] = (follows[a][b] || 0) + 1;
  }
  const teacherSec = all.filter(r => r.role === 'teacher').reduce((a, r) => a + r.talkSec, 0);
  const studentSec = students.reduce((a, r) => a + r.talkSec, 0);
  return {
    durationSec: Math.round(lines.length ? lines[lines.length - 1].at + (timed[timed.length - 1]?.len || 0) : 0),
    lines: lines.length, turns: turns.length,
    students, others: all.filter(r => r.role !== 'student').sort((a, b) => b.talkSec - a.talkSec),
    didntSpeak: students.filter(r => r.turns === 0).map(r => ({ userId: r.userId, name: r.name })),
    follows: { people: keys.map(k => ({ key: k, name: (people.get(k) || {}).name || k })), counts: follows },
    teacherSharePct: Math.round((100 * teacherSec) / totalTalk), studentSharePct: Math.round((100 * studentSec) / totalTalk),
    distinctStudentSpeakers: students.filter(r => r.turns > 0).length
  };
}

// The AI half: what Gemini is asked, with numbered lines so every quote it
// returns can point at its line.
function aiPrompt({ title, promptText, lines, speakers, roster, teacher }) {
  const who = resolver(speakers, roster, teacher);
  const transcript = lines.map(l => `L${l.i} [${l.t}] ${who(l.speaker).name}: ${l.text}`).join('\n');
  const clipped = transcript.length > 60000 ? transcript.slice(0, 60000) + '\n[…transcript truncated]' : transcript;
  return `You are helping a teacher review a recorded class discussion. Be specific and neutral. Never invent anything that is not in the transcript, and never judge a student's character.

DISCUSSION: ${title || 'Class discussion'}${promptText ? `\nPROMPT THE CLASS DISCUSSED: ${promptText.slice(0, 1500)}` : ''}
STUDENTS: ${roster.map(r => r.name).join(', ') || '(none)'}
TEACHER: ${teacher?.name || 'the teacher'}

TRANSCRIPT (each line starts with its id, like L12):
${clipped}

For each student who spoke, count their contributions of each type and give ONE short quote (their exact words) with the line id it came from. Types: new-idea, evidence (evidence or example), question, builds-on (builds on someone), disagrees (disagrees respectfully), summarizes, off-topic. Leave out types with a count of 0.

Return ONLY JSON:
{
  "students": [ { "name": "student name exactly as above", "types": { "new-idea": { "count": 2, "quote": "exact words", "line": 12 } } } ],
  "groupDynamics": "3-5 sentences on how the discussion went: who drove it, how ideas connected, how it ended",
  "suggestions": ["a concrete suggestion for the teacher, e.g. students to invite in next time"]
}`;
}

// Keep only what the transcript supports: known students, known types,
// counts as integers, and quotes tied to a real line by that student.
function sanitizeAI(ai, { lines, speakers, roster, teacher }) {
  const who = resolver(speakers, roster, teacher);
  const byName = n => roster.find(r => r.name.toLowerCase() === String(n || '').trim().toLowerCase());
  const students = [];
  for (const s of Array.isArray(ai?.students) ? ai.students : []) {
    const r = byName(s.name);
    if (!r) continue;
    const types = {};
    for (const t of TYPES) {
      const v = s.types?.[t];
      const count = Math.max(0, Math.round(Number(v?.count) || 0));
      if (!count) continue;
      let line = Number.isInteger(Number(v.line)) ? Number(v.line) : null;
      const quote = String(v.quote || '').slice(0, 300);
      // the quote has to come from a line this student said
      if (line == null || !lines[line] || who(lines[line].speaker).userId !== r.id) {
        const found = lines.find(l => who(l.speaker).userId === r.id && quote && l.text.toLowerCase().includes(quote.toLowerCase().slice(0, 40)));
        line = found ? found.i : null;
      }
      types[t] = { count, quote: line == null ? '' : quote, line };
    }
    students.push({ userId: r.id, name: r.name, types });
  }
  return {
    students,
    groupDynamics: String(ai?.groupDynamics || '').slice(0, 3000),
    suggestions: (Array.isArray(ai?.suggestions) ? ai.suggestions : []).map(x => String(x).slice(0, 400)).filter(Boolean).slice(0, 8)
  };
}

module.exports = { SEGMENT_SEC, TYPES, TYPE_LABEL, parseTime, fmtTime, mergedLines, mergeSpeakers, hintsFrom, hintsText, measure, aiPrompt, sanitizeAI };
