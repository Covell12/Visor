/* Visor — asks for the optional <all_urls> permission from a click in an
   extension page (Chrome only allows it from a user gesture here). */
'use strict';
let sent = false;
const done = (granted) => {
  if (sent) return;
  sent = true;
  chrome.runtime.sendMessage({ type: 'VISOR_PERMISSION_RESULT', granted }, () => { void chrome.runtime.lastError; window.close(); });
};
document.getElementById('allow').addEventListener('click', async () => {
  let granted = false;
  try { granted = await chrome.permissions.request({ origins: ['<all_urls>'] }); } catch (_) {}
  document.getElementById('result').textContent = granted ? 'Allowed. You can close this window.' : 'Not allowed.';
  done(granted);
});
document.getElementById('no').addEventListener('click', () => done(false));
window.addEventListener('beforeunload', () => { if (!sent) try { chrome.runtime.sendMessage({ type: 'VISOR_PERMISSION_RESULT', granted: false }); } catch (_) {} });
