/* Visor — an assignment's writing settings in plain words, the way a student
   sees them before starting: "Locked session · 45 minutes · research is
   recorded · …". The assignment page, the editor and the teacher's live
   preview on the assignment form all show this line.

   One file, two places: the browser loads public/assignment-text.js; the
   server requires lib/assignment-text.js, an identical copy kept in step by
   `npm run sync-engine` (test/engine-sync.test.js checks they match). Edit
   public/assignment-text.js, then run the sync.

   describeWriting(writing, multiplier) -> string
     multiplier  the student's extra time (1.5 = time and a half) */

(function (root) {
  'use strict';

  const STYLES = { mla: 'MLA', apa: 'APA', chicago: 'Chicago' };

  // A whole number above 0, or null (the form's preview passes what's typed,
  // which can be empty or not a number yet)
  const count = v => {
    if (v === null || v === undefined || v === '') return null;
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  function describeWriting(w, multiplier = 1) {
    if (!w) return '';
    const mult = Number(multiplier) > 0 ? Number(multiplier) : 1;
    const limit = count(w.timeLimitMin), minWords = count(w.minWords), maxWords = count(w.maxWords);
    // Missing on assignments saved before it existed: a page after the essay
    const worksCited = ['panel', 'off'].includes(w.worksCited) ? w.worksCited : 'page';
    const parts = [w.mode === 'locked' ? 'Locked session' : 'Open session'];
    if (limit) parts.push(`${Math.round(limit * mult)} minutes${mult > 1 ? ` (includes your extra time)` : ''}`);
    else parts.push('no time limit');
    parts.push(w.researchTracking ? 'research is recorded' : 'research isn’t recorded');
    parts.push(w.allowPaste === 'allow' ? 'pasting is allowed' : w.allowPaste === 'block' ? 'pasting is off' : 'pasting from outside sources is off');
    if (w.blockAiSites) parts.push('AI sites are blocked');
    if (w.mode === 'locked' && w.allowedSites?.length) parts.push(`only ${w.allowedSites.length} allowed site${w.allowedSites.length === 1 ? '' : 's'}`);
    // Missing on assignments saved before these settings existed: both are on
    if (w.mode === 'locked' && w.panelBrowsing !== false) parts.push('you can switch to the side panel to research');
    parts.push(`cite in ${STYLES[w.citationStyle] || 'MLA'}`);
    if (worksCited === 'panel') parts.push('your sources go in a side panel (no Works Cited page)');
    if (worksCited === 'off') parts.push('write your own Works Cited (citation tools are off)');
    // With the tools off there's nothing to cite in one click anyway
    else if (w.oneClickCite === false) parts.push('one-click citing is off');
    if (minWords || maxWords) parts.push(minWords && maxWords ? `${minWords}–${maxWords} words` : minWords ? `at least ${minWords} words` : `at most ${maxWords} words`);
    return parts.join(' · ');
  }

  const api = { describeWriting };
  root.VisorAssignmentText = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
