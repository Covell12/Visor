/* Visor Classroom — reading a pasted list of people for a school. Accepts plain
   email addresses, or lines copied from a spreadsheet in any order: name, email,
   role and grades, split by commas, tabs, semicolons or bars. */

'use strict';

const SchoolPaste = (() => {
  const EMAIL = /[^\s,;|<>"'()]+@[^\s,;|<>"'()]+\.[^\s,;|<>"'()]+/g;
  const ROLE_WORDS = [
    [/^(students?|pupils?|learners?)$/i, 'student'],
    [/^(teachers?|faculty|staff|instructors?|co-?teachers?)$/i, 'teacher'],
    [/^(assistants?|assistant teachers?|teaching assistants?|tas?|aides?|paras?|paraprofessionals?)$/i, 'assistant'],
    [/^(advisors?|advisers?|counsell?ors?)$/i, 'advisor'],
    [/^(facilitators?|admins?|administrators?|principals?)$/i, 'facilitator']
  ];
  const ORDER = ['PK', 'K', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];

  const roleOf = cell => ROLE_WORDS.find(([re]) => re.test(cell.trim()))?.[1] || null;

  // One grade: "10", "10th", "Grade 10", "K", "Kindergarten", "Pre-K"
  function oneGrade(text) {
    const t = text.trim().toLowerCase().replace(/^grade\s*/, '').replace(/\s*grade$/, '').replace(/(st|nd|rd|th)$/, '');
    if (/^(k|kg|kindergarten)$/.test(t)) return 'K';
    if (/^(pk|pre-?k|prek|pre-?kindergarten)$/.test(t)) return 'PK';
    return /^\d{1,2}$/.test(t) && ORDER.includes(String(Number(t))) ? String(Number(t)) : null;
  }
  // A cell of grades: one, several ("9, 10" arrives as cells; "9 10", "9/10", "9 & 10"), or a range ("9-12")
  function gradesOf(cell) {
    const range = /^\s*(?:grades?\s*)?(\w+)\s*(?:-|–|to)\s*(\w+)\s*$/i.exec(cell);
    if (range) {
      const a = ORDER.indexOf(oneGrade(range[1])), b = ORDER.indexOf(oneGrade(range[2]));
      if (a >= 0 && b >= a) return ORDER.slice(a, b + 1);
    }
    const parts = cell.replace(/^\s*grades?\s*/i, '').split(/\s*(?:\/|&|\band\b)\s*|\s+(?=\d)/i).filter(Boolean);
    const found = parts.map(oneGrade);
    return found.length && found.every(Boolean) ? found : null;
  }

  // -> { rows: [{ email, name, role, grades }], bad: [lines with no address] }
  // role is null, and grades empty, when the line doesn't say.
  function parse(text) {
    const rows = [], bad = [], seen = new Set();
    const add = row => { const key = row.email.toLowerCase(); if (seen.has(key)) return; seen.add(key); rows.push({ ...row, email: key }); };
    for (const line of String(text || '').split(/\r?\n/)) {
      if (!line.trim()) continue;
      const emails = line.match(EMAIL);
      if (!emails) { if (!/\b(e-?mail|role|grade|name)\b/i.test(line)) bad.push(line.trim()); continue; } // a heading row isn't a problem
      if (emails.length > 1) { emails.forEach(email => add({ email, name: '', role: null, grades: [] })); continue; }
      const cells = line.replace(emails[0], '').split(/[,;\t|]+/).map(c => c.trim()).filter(Boolean);
      let role = null;
      const grades = [], names = [];
      for (const cell of cells) {
        const r = roleOf(cell), g = r ? null : gradesOf(cell);
        if (r) role = r; else if (g) grades.push(...g); else names.push(cell);
      }
      add({ email: emails[0], name: names.join(' '), role, grades: ORDER.filter(g => grades.includes(g)) });
    }
    return { rows, bad };
  }

  return { parse, gradesOf };
})();

if (typeof module !== 'undefined') module.exports = SchoolPaste;
