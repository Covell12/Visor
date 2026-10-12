/* Visor — the page a session shows instead of a site that isn't allowed (an
   AI site the assignment blocks, or in a locked session any site off its
   list). Reports the attempt and leads back to the essay. */
'use strict';
const raw = location.href.includes('?u=') ? location.href.slice(location.href.indexOf('?u=') + 3) : (document.referrer || '');
let shown = raw;
try { shown = new URL(raw).href; } catch (_) {}
document.getElementById('url').textContent = shown.slice(0, 300);
try {
  chrome.runtime.sendMessage({ type: 'VISOR_BLOCKED', url: shown.slice(0, 2000) }, (r) => {
    void chrome.runtime.lastError;
    // An AI site: say so (the default text is for a locked session's site list)
    if (r && r.reason === 'ai') {
      document.title = 'AI sites are blocked during your Visor session';
      document.getElementById('head').textContent = 'AI sites are blocked during your Visor session.';
      document.getElementById('why').textContent = 'Your teacher blocked AI sites for this assignment. This visit was recorded with your session.';
    }
  });
} catch (_) {}
document.getElementById('back').addEventListener('click', () => {
  try { chrome.runtime.sendMessage({ type: 'VISOR_BACK_TO_WRITING' }, () => void chrome.runtime.lastError); } catch (_) {}
});
document.getElementById('back').focus();
