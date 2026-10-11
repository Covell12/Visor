/* Visor — the page a locked session shows instead of a site that isn't
   allowed. Reports the attempt (a lock-violation) and leads back to the essay. */
'use strict';
const raw = location.href.includes('?u=') ? location.href.slice(location.href.indexOf('?u=') + 3) : (document.referrer || '');
let shown = raw;
try { shown = new URL(raw).href; } catch (_) {}
document.getElementById('url').textContent = shown.slice(0, 300);
try { chrome.runtime.sendMessage({ type: 'VISOR_BLOCKED', url: shown.slice(0, 2000) }, () => void chrome.runtime.lastError); } catch (_) {}
document.getElementById('back').addEventListener('click', () => {
  try { chrome.runtime.sendMessage({ type: 'VISOR_BACK_TO_WRITING' }, () => void chrome.runtime.lastError); } catch (_) {}
});
document.getElementById('back').focus();
