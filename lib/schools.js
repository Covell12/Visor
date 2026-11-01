// Schools that someone runs. A school starts as a name; the teacher who creates
// it (or takes over one with nobody running it) is its facilitator, who gives it
// a logo and a list of the people who can join, each with a role and grades.
//
// The list is one 'schoolroster' record per school: { id: orgId, people: [...] },
// so a bulk add is one write. Whether someone has joined is never stored here:
// that's their account's orgId.
//
// Visor doesn't confirm email addresses at sign-up, so being on the list isn't
// enough to get in. An invite link (it reached that inbox) or Google sign-in
// (Google confirmed the address) is what proves it's them.

const crypto = require('crypto');

// Who someone is at a school. `account` is the kind of Visor account they need.
const ROLES = {
  facilitator: { label: 'Facilitator', account: 'teacher', about: 'Runs the school on Visor: its logo, its people, their roles and grades, and invites. Also a teacher.' },
  teacher: { label: 'Teacher', account: 'teacher', about: 'Creates classes and assignments, watches sessions and reviews essays. Sees everyone at the school.' },
  assistant: { label: 'Assistant teacher', account: 'teacher', about: 'A teacher account for someone who supports classes. Sees everyone at the school.' },
  advisor: { label: 'Advisor', account: 'teacher', about: 'A teacher account for someone who oversees students, such as a counselor. Sees everyone at the school.' },
  student: { label: 'Student', account: 'student', about: 'Joins classes and writes. Doesn’t see the school’s list of people.' }
};
const GRADES = ['PK', 'K', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];
const MAX_PEOPLE = 5000, NAME_MAX = 120;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class SchoolError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const personId = email => crypto.createHash('sha256').update(email).digest('hex').slice(0, 24);
const isFacilitator = (org, userId) => !!org?.facilitatorIds?.includes(userId);
const isManaged = org => !!org?.facilitatorIds?.length;

function cleanGrades(list) {
  const want = new Set((Array.isArray(list) ? list : []).map(g => String(g).toUpperCase()));
  return GRADES.filter(g => want.has(g));
}

// A person as sent by the page, checked. Returns { email, name, role, grades } or { error }.
function cleanPerson(p) {
  const email = String(p?.email || '').trim().toLowerCase().slice(0, 200);
  if (!EMAIL.test(email)) return { email, error: 'not an email address' };
  const role = Object.prototype.hasOwnProperty.call(ROLES, p?.role) ? p.role : 'student';
  return { email, name: String(p?.name || '').trim().replace(/\s+/g, ' ').slice(0, NAME_MAX), role, grades: cleanGrades(p?.grades) };
}

// Add people to a roster, or update the ones already on it. Returns what happened.
function addPeople(roster, people, { by, at }) {
  const byEmail = new Map(roster.people.map(p => [p.email, p]));
  let added = 0, updated = 0;
  const skipped = [], seen = new Set();
  for (const raw of Array.isArray(people) ? people : []) {
    const p = cleanPerson(raw);
    if (p.error) { skipped.push({ email: p.email, why: p.error }); continue; }
    if (seen.has(p.email)) { skipped.push({ email: p.email, why: 'listed twice' }); continue; }
    seen.add(p.email);
    const had = byEmail.get(p.email);
    if (had) {
      Object.assign(had, { role: p.role, grades: p.grades }, p.name ? { name: p.name } : {});
      updated += 1;
    } else {
      if (roster.people.length >= MAX_PEOPLE) { skipped.push({ email: p.email, why: `a school can list ${MAX_PEOPLE} people` }); continue; }
      const person = { id: personId(p.email), ...p, addedAt: at, addedBy: by };
      roster.people.push(person);
      byEmail.set(p.email, person);
      added += 1;
    }
  }
  return { added, updated, skipped };
}

module.exports = { ROLES, GRADES, MAX_PEOPLE, EMAIL, SchoolError, personId, isFacilitator, isManaged, cleanGrades, cleanPerson, addPeople };
