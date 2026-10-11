/* Visor — client-side routes. history.pushState, no framework.
   The original app (projects sidebar + project view) is the /project/:id view;
   every Visor Classroom page renders into #routeView.

     /                       home (teacher or student dashboard)
     /class/:id              class page
     /a/:assignmentId        assignment page
     /write/:assignmentId    the student editor (?embed=panel inside the extension)
     /review/:docId          teacher review
     /project/:id            the existing project view
     /extension/connect      connect the Visor extension */

'use strict';

const VisorRouter = (() => {
  const routes = [];
  let cleanup = null;     // the current page's teardown (timers, listeners)
  let started = false;

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

  function setNav(path) {
    document.querySelectorAll('.topnav a').forEach(a => a.classList.toggle('active', a.getAttribute('href') === path || (a.dataset.nav === 'home' && path === '/')));
  }

  async function render() {
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
      if (typeof out === 'function') cleanup = out;
    } catch (e) {
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
    go(url.pathname + url.search);
  });
  window.addEventListener('popstate', () => { if (started) render(); });

  return {
    add,
    go,
    render,
    // Called by app.js once someone is signed in
    start() { started = true; render(); },
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
