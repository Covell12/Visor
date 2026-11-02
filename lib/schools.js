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

// ---- Terms ----
// A term is a stretch of the year that classes belong to: { id, name, startsOn,
// endsOn }, with dates as YYYY-MM-DD. A school always has at least one, so a
// teacher never has to wait for a facilitator before making a class. A class in a
// past term keeps working; terms only sort classes.
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const today = (at = Date.now()) => new Date(at).toISOString().slice(0, 10);

// The school year around a date: August to July
function yearTerm(at = Date.now()) {
  const d = new Date(at), first = d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return { id: `year-${first}`, name: `${first}–${String(first + 1).slice(2)}`, startsOn: `${first}-08-01`, endsOn: `${first + 1}-07-31` };
}
const termsOf = (org, at) => (org?.terms?.length ? [...org.terms].sort((a, b) => (a.startsOn < b.startsOn ? -1 : 1)) : [yearTerm(at)]);
// Saves the school's terms, for when something is about to point at one
function ensureTerms(org, at) { if (!org.terms?.length) org.terms = termsOf(org, at); return org.terms; }
function termState(term, day = today()) { return term.endsOn < day ? 'past' : term.startsOn > day ? 'upcoming' : 'current'; }
// What a new class joins: the term running now, else the next, else the latest
function currentTerm(org, day = today()) {
  const list = termsOf(org);
  return list.find(t => termState(t, day) === 'current') || list.find(t => termState(t, day) === 'upcoming') || list[list.length - 1];
}
function cleanTerm(body) {
  const name = String(body?.name || '').trim().replace(/\s+/g, ' ').slice(0, 60), startsOn = String(body?.startsOn || ''), endsOn = String(body?.endsOn || '');
  if (!name) throw new SchoolError(400, 'Give the term a name');
  if (!DATE.test(startsOn) || !DATE.test(endsOn) || Number.isNaN(Date.parse(startsOn)) || Number.isNaN(Date.parse(endsOn))) throw new SchoolError(400, 'Give the term a start and end date');
  if (endsOn < startsOn) throw new SchoolError(400, 'A term has to end after it starts');
  return { name, startsOn, endsOn };
}

module.exports = { ROLES, GRADES, MAX_PEOPLE, EMAIL, SchoolError, personId, isFacilitator, isManaged, cleanGrades, cleanPerson, addPeople, yearTerm, termsOf, ensureTerms, termState, currentTerm, cleanTerm };
