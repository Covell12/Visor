/* Visor — client-side routes. history.pushState, no framework.
   The original app (projects sidebar + project view) is the /project/:id view;
   every Visor Classroom page renders into #routeView.

     /                       home (teacher or student dashboard)
     /class/:id              class page
     /a/:assignmentId        assignment page
     /write/:assignmentId    the student editor (?embed=panel inside the extension)
     /review/:docId          teacher review
     /calendar               due dates across classes (calendar.js)
     /project/:id            the existing project view
     /extension/connect      connect the Visor extension */

'use strict';

const VisorRouter = (() => {
  const routes = [];
  let cleanup = null;     // the current page's teardown (timers, listeners)
  let started = false;
  let seq = 0;            // counts navigations, so a slow page can tell it's been left

  // Pages register here: VisorRouter.add('/class/:id', (el, params, query) => {...})
  function add(pattern, render) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/\/:(\w+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '/?$');
    routes.push({ re, keys, render });
  }

  function match(path) {
    for (const r of routes) {
      const m = r.re.exec(path);
      if (m) return { r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
    }
    return null;
  }

  function showRouteView() {
    $('routeView').classList.remove('hidden');
    document.querySelector('#appView > .shell')?.classList.add('hidden');
  }
  function showShell() {
    $('routeView').classList.add('hidden');
    document.querySelector('#appView > .shell')?.classList.remove('hidden');
  }

  // The top bar: Home, Classes (any class or assignment page) or Calendar
  function setNav(path) {
    const section = path === '/' ? 'home' : /^\/(class|a|review|write)\//.test(path) ? 'courses' : /^\/calendar\/?$/.test(path) ? 'calendar' : '';
    document.querySelectorAll('.topnav [data-nav]').forEach(a => {
      const on = a.dataset.nav === section;
      a.classList.toggle('active', on);
      if (a.tagName === 'A') { if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }
    });
  }

  async function render() {
    const mine = ++seq;
    if (cleanup) { try { cleanup(); } catch {} cleanup = null; }
    const path = location.pathname;
    const query = new URLSearchParams(location.search);
    const hit = match(path);
    if (!hit) { history.replaceState(null, '', '/'); return render(); }
    setNav(path);
    document.body.classList.toggle('writing', /^\/write\//.test(path));
    if (hit.r.shell) { showShell(); }
    else { showRouteView(); $('routeView').innerHTML = ''; window.scrollTo(0, 0); }
    try {
      const out = await hit.r.render($('routeView'), hit.params, query);
      // Left while it loaded: stop its timers instead of keeping them
      if (mine !== seq) { if (typeof out === 'function') try { out(); } catch {} return; }
      if (typeof out === 'function') cleanup = out;
    } catch (e) {
      if (mine !== seq) return;
      $('routeView').innerHTML = `<div class="page"><div class="callout red">${esc(e.message || 'This page could not load.')}</div><p><a href="/" data-link>Back to home</a></p></div>`;
    }
  }

  function go(path, { replace = false } = {}) {
    if (path === location.pathname + location.search && !replace) return render();
    history[replace ? 'replaceState' : 'pushState'](null, '', path);
    render();
  }

  // Same-origin links marked data-link (and any in-app absolute link) stay in the app
  document.addEventListener('click', e => {
    const a = e.target.closest('a[data-link]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || a.target === '_blank') return;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin) return;
    e.preventDefault();
    document.querySelectorAll('.menu').forEach(x => x.classList.add('hidden'));
    if (window.ddClose) ddClose();
    go(url.pathname + url.search);
  });
  window.addEventListener('popstate', () => { if (started) render(); });

  return {
    add,
    go,
    render,
    // The current navigation's number: a page that awaits something checks it
    // is still current before it draws (VisorRouter.seq() !== mine → leave it)
    seq: () => seq,
    // Called by app.js once someone is signed in
    start() { started = true; render(); },
    // Signed out: end the current page (its timers and listeners)
    stop() { started = false; if (cleanup) { try { cleanup(); } catch {} cleanup = null; } },
    // The side panel loads /write/:id?embed=panel with no cookie: it skips the
    // normal sign-in and waits for the extension to hand it a token.
    isEmbed: () => new URLSearchParams(location.search).get('embed') === 'panel' && /^\/write\//.test(location.pathname),
    startEmbed() { document.body.classList.add('embed'); $('authView').classList.add('hidden'); $('appView').classList.remove('hidden'); started = true; render(); },
    // The project sidebar picked a project: keep the address bar in step
    onProjectSelected(id) {
      const want = `/project/${id}`;
      if (location.pathname !== want) history.pushState(null, '', want);
      setNav(want); showShell();
    },
    addShell(pattern, render) { add(pattern, render); routes[routes.length - 1].shell = true; }
  };
})();

// app.js checks window.VisorRouter (a top-level const isn't a window property)
window.VisorRouter = VisorRouter;

// The existing project view: the sidebar and project page from app.js
VisorRouter.addShell('/project/:id', (el, { id }) => { loadProjects(id); });
