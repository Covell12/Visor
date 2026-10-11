/* Visor Classroom — talking to the Visor Chrome extension.
   The extension's site-bridge.js runs on Visor's own pages. The page posts
   { source:'visor-page', type, id, ... } to itself; the bridge forwards it to
   the extension and posts back { source:'visor-ext', replyTo: id, ... }. No
   answer within 1.5 s means the extension isn't installed (or is turned off).

   Also the /extension/connect page, and the Profile dialog's extension line. */

'use strict';

const VisorExt = (() => {
  let seq = 0;
  const waiting = new Map();
  window.addEventListener('message', e => {
    if (e.source !== window || e.origin !== location.origin) return;
    const m = e.data;
    if (!m || m.source !== 'visor-ext' || !m.replyTo) return;
    const w = waiting.get(m.replyTo);
    if (w) { waiting.delete(m.replyTo); clearTimeout(w.timer); w.resolve(m); }
  });
  function send(type, payload = {}, timeoutMs = 1500) {
    return new Promise(resolve => {
      const id = `v${Date.now().toString(36)}${++seq}`;
      const timer = setTimeout(() => { waiting.delete(id); resolve({ installed: false, timeout: true }); }, timeoutMs);
      waiting.set(id, { resolve, timer });
      window.postMessage({ source: 'visor-page', type, id, ...payload }, location.origin);
    });
  }
  // The bridge marks the page as soon as it loads, so this needs no round trip
  const installedVersion = () => document.documentElement.dataset.visorExtension || null;
  return {
    installedVersion,
    async ping() {
      const r = await send('PING');
      // timeout: not installed or turned off; gone: turned off or reloaded since this page loaded
      return r.timeout || r.gone ? { installed: false, gone: !!r.gone } : { installed: true, version: r.version, connected: !!r.connected, user: r.user || null, hasHostPermission: !!r.hasHostPermission, lockActive: !!r.lockActive, session: r.session || null };
    },
    connect: (token, user) => send('CONNECT', { token, user }),
    disconnect: () => send('DISCONNECT'),
    // Sent twice for each session: first with no token (the extension confirms
    // to the server it's here), then with the session token once it starts.
    startSession: ({ docId, assignmentId, sessionToken, settings }) => send('SESSION_START', { docId, assignmentId, sessionToken, settings }, 4000),
    endSession: docId => send('SESSION_END', { docId }),
    openPanel: docId => send('OPEN_PANEL', { docId }, 3000).then(r => (r.timeout ? { ok: false, error: 'The Visor extension didn’t answer.' } : r)),
    // Opens the extension's own small window asking to allow research recording
    // The answer can be lost if the extension's worker slept while the window
    // was open, so the permission itself is checked again afterwards
    requestPermission: () => send('REQUEST_PERMISSION', {}, 120000).then(async r => (r.granted ? { granted: true } : { granted: !!(await send('PING')).hasHostPermission }))
  };
})();
window.VisorExt = VisorExt;

/* ====================== /extension/connect ====================== */
VisorRouter.add('/extension/connect', async el => {
  el.innerHTML = `<div class="page narrow"><div class="loading-row"><span class="spinner"></span></div></div>`;
  const p = await VisorExt.ping();
  let status = null;
  try { status = await api('/api/ext/token/status'); } catch {}
  const connectedHere = p.installed && p.connected && p.user?.id === me.id;
  el.innerHTML = `<div class="page narrow">
    ${crumbs([['Home', '/'], ['Visor extension']])}
    <div class="card card-pad connect-card">
      <img src="/logo.png" alt="" class="connect-logo" />
      <h1>Connect the Visor extension</h1>
      ${!p.installed ? `
        <p>The Visor Chrome extension isn’t installed in this browser, or it’s turned off.</p>
        <ol class="small" style="line-height:1.8;">
          <li>Install <b>Visor — Writing Sessions &amp; Google Docs History</b> from the Chrome Web Store (or ask your school; many install it for every student).</li>
          <li>Make sure it’s turned on at <span class="mono">chrome://extensions</span>.</li>
          <li>Reload this page.</li>
        </ol>
        <button class="btn btn-ghost" onclick="VisorRouter.render()">${I.refresh}Check again</button>`
      : connectedHere ? `
        <div class="connected-line">${I.check}<span>Connected as <b>${esc(p.user.name)}</b></span></div>
        <p class="small muted">During a writing session the extension records your research (searches, pages and how long you spent on them, text you copy), adds citations with one click, and keeps a locked session on the allowed sites. Outside a session it records nothing.</p>
        ${p.hasHostPermission ? '' : `<p class="small">Research recording needs one more permission. <button class="btn btn-ghost btn-sm" onclick="extAllowResearch()">Allow research recording</button></p>`}
        <div class="btn-row"><button class="btn btn-ghost" onclick="extDisconnect()">Disconnect</button></div>`
      : `
        <p>Connecting lets the extension work with your Visor account: it records research during your writing sessions, adds citations, and sends your group’s Google Doc history to your project.</p>
        ${p.connected && p.user ? `<div class="callout amber" style="margin-bottom:12px;">The extension is connected to ${esc(p.user.name)}. Connecting replaces that.</div>` : ''}
        <button class="btn btn-primary btn-lg" onclick="extConnect(this)">${I.puzzle}Connect the Visor extension</button>
        <div id="connectErr" class="form-error hidden" style="margin-top:12px;"></div>`}
      ${status?.connected && !connectedHere ? `<p class="tiny muted" style="margin-top:14px;">Your account also has an extension connected in another browser.</p>` : ''}
    </div></div>`;
});

async function extConnect(btn) {
  btn.disabled = true;
  try {
    const r = await api('/api/ext/token', { method: 'POST' });
    const res = await VisorExt.connect(r.token, r.user);
    if (res.timeout || !res.ok) throw new Error('The extension didn’t answer. Reload this page and try again.');
    toast(`Connected as ${r.user.name}`);
    VisorRouter.render();
  } catch (e) { formError('connectErr', e.message); btn.disabled = false; }
}
async function extDisconnect() {
  try { await api('/api/ext/token', { method: 'DELETE' }); } catch {}
  await VisorExt.disconnect();
  toast('Extension disconnected');
  if (location.pathname === '/extension/connect') VisorRouter.render();
}
async function extAllowResearch() {
  const r = await VisorExt.requestPermission();
  toast(r.granted ? 'Research recording allowed' : 'Not allowed. Locked sessions can’t start without it.', r.granted ? '' : 'err');
  if (location.pathname === '/extension/connect') VisorRouter.render();
  else if (window.writerRefresh && WR.data) { WR.extInfo = await VisorExt.ping(); writerRefresh(); }
}

// Profile dialog: "Extension: connected · Disconnect", and "Download my data"
async function profileExtras(el) {
  if (!el) return;
  const [p, st] = await Promise.all([VisorExt.ping(), api('/api/ext/token/status').catch(() => null)]);
  const connected = (p.installed && p.connected && p.user?.id === me.id) || st?.connected;
  el.innerHTML = `<div class="prof-row"><div><b>Extension</b><div class="tiny muted">${connected ? 'Connected' : p.installed ? 'Installed, not connected' : 'Not installed in this browser'}</div></div>
      ${connected ? `<button class="btn btn-ghost btn-sm" onclick="extDisconnect().then(()=>profileExtras($('profExtras')))">Disconnect</button>` : `<a class="btn btn-ghost btn-sm" href="/extension/connect" data-link onclick="closeModal()">Connect</a>`}</div>
    ${me.role === 'student' ? `<div class="prof-row"><div><b>Your data</b><div class="tiny muted">Your essays, their writing history, and what your sessions recorded, as a JSON file.</div></div><a class="btn btn-ghost btn-sm" href="/api/me/export" download>Download my data</a></div>` : ''}`;
}
