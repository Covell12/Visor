#!/usr/bin/env node
/* ============================================================================
 * Build the Docs-only Visor: Google Docs history, without Visor Classroom.
 * ----------------------------------------------------------------------------
 *   node tools/build-docs.js [outDir] [zipPath]
 *
 * Writes the extension to outDir (default dist/visor-docs) and, given a path,
 * zips it there. The source tree stays the Visor Classroom companion; this
 * build is the same code with edition.js saying 'docs' (which turns off the
 * writing-session code paths), only the files Docs history uses, and a
 * manifest asking for no more than the Web Store's v3.6 did: storage, the
 * side panel and tabs, on Google Docs and Slides.
 * ==========================================================================*/

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SRC = path.join(__dirname, '..');
const OUT_DEFAULT = path.resolve(require.main === module && process.argv[2] || path.join(SRC, 'dist', 'visor-docs'));
const ZIP_DEFAULT = require.main === module && process.argv[3] ? path.resolve(process.argv[3]) : null;

// The listing this build updates (the Web Store's v3.6 is "Visor — Who Wrote
// What: Google Docs History"), so the version only has to be past 3.6.
const NAME = 'Visor — Who Wrote What: Google Docs History';
const VERSION = '3.7.0';
const DESCRIPTION = 'Free and unlimited. See who wrote what in any Google Doc: contributions, replay, paste detection, and recovered deleted text.';
const PERMISSIONS = ['storage', 'sidePanel', 'tabs'];
const HOSTS = ['https://docs.google.com/document/*', 'https://docs.google.com/presentation/*'];

// What Docs history is made of. Everything else in the source tree belongs
// to Visor Classroom (session-bg, lockdown, research, cite, site-bridge, the
// session panel, the blocked and permission pages, config) or to development.
const FILES = [
  'background.js', 'page-probe.js', 'aware.js', 'changelog.js', 'shares.js', 'content.js', 'content.css',
  'sidepanel.html', 'sidepanel.js', 'sidepanel.css', 'glass.css', 'theme.js',
  'replay.html', 'replay.js', 'replay.css', 'popup.html', 'popup.js', 'logo.png',
  'icons/icon16.png', 'icons/icon48.png', 'icons/icon128.png'
];
const CLASSROOM_ONLY = ['site-bridge.js', 'blocked.html', 'blocked.js', 'blocked.css', 'config.js'];

function manifest() {
  const m = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
  m.name = NAME;
  m.short_name = 'Visor';
  m.version = VERSION;
  m.description = DESCRIPTION;
  m.permissions = PERMISSIONS;
  m.host_permissions = HOSTS;
  delete m.optional_host_permissions;
  delete m.commands;
  if (m.action) m.action.default_title = NAME;
  m.content_scripts = m.content_scripts.filter((cs) => !(cs.js || []).some((f) => CLASSROOM_ONLY.includes(f)));
  m.web_accessible_resources = (m.web_accessible_resources || [])
    .filter((w) => !w.resources.some((r) => CLASSROOM_ONLY.includes(r)));
  return m;
}

function build(OUT = OUT_DEFAULT, ZIP = ZIP_DEFAULT) {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'icons'), { recursive: true });
  for (const f of FILES) fs.copyFileSync(path.join(SRC, f), path.join(OUT, f));

  // This edition, and its manifest
  const edition = fs.readFileSync(path.join(SRC, 'edition.js'), 'utf8')
    .replace("globalThis.VISOR_EDITION = 'classroom';", "globalThis.VISOR_EDITION = 'docs';");
  if (!edition.includes("'docs'")) throw new Error('edition.js no longer has the line this build rewrites');
  fs.writeFileSync(path.join(OUT, 'edition.js'), edition);
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest(), null, 2) + '\n');

  // The side panel loads Visor Classroom's config only for the Send box
  const sp = path.join(OUT, 'sidepanel.html');
  fs.writeFileSync(sp, fs.readFileSync(sp, 'utf8').replace(/\s*<script src="config\.js"><\/script>/, ''));

  check(OUT);
  if (ZIP) {
    fs.rmSync(ZIP, { force: true });
    execFileSync('zip', ['-r', '-X', '-q', ZIP, '.'], { cwd: OUT });
  }
  return OUT;
}

/** Every file the manifest and the pages name is in the build, and nothing of Visor Classroom is. */
function check(OUT = OUT_DEFAULT) {
  const m = JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8'));
  const named = new Set([m.background.service_worker, m.action.default_popup, ...Object.values(m.icons || {}), ...Object.values(m.action.default_icon || {})]);
  if (m.side_panel) named.add(m.side_panel.default_path);
  for (const cs of m.content_scripts) [...(cs.js || []), ...(cs.css || [])].forEach((f) => named.add(f));
  for (const w of m.web_accessible_resources || []) w.resources.forEach((f) => named.add(f));
  for (const f of fs.readdirSync(OUT).filter((x) => x.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(OUT, f), 'utf8');
    for (const [, ref] of html.matchAll(/(?:src|href)="([^"#:]+\.(?:js|css|png))"/g)) named.add(ref);
  }
  const bg = fs.readFileSync(path.join(OUT, m.background.service_worker), 'utf8');
  for (const [, list] of bg.matchAll(/^importScripts\(([^)]*)\)/gm)) for (const [, f] of list.matchAll(/'([^']+)'/g)) named.add(f);
  const missing = [...named].filter((f) => !fs.existsSync(path.join(OUT, f)));
  if (missing.length) throw new Error(`the build is missing ${missing.join(', ')}`);
  const leaked = ['session-bg.js', 'lockdown.js', 'research.js', 'research-capture.js', 'cite.js', 'sessionpanel.html', 'permission.html', ...CLASSROOM_ONLY]
    .filter((f) => fs.existsSync(path.join(OUT, f)));
  if (leaked.length) throw new Error(`Visor Classroom files in the Docs build: ${leaked.join(', ')}`);
}

if (require.main === module) {
  const out = build();
  const m = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
  console.log(`${m.name} ${m.version} → ${out}${ZIP_DEFAULT ? `\nzipped → ${ZIP_DEFAULT}` : ''}`);
  console.log(`permissions: ${m.permissions.join(', ')}; hosts: ${m.host_permissions.join(', ')}`);
}

module.exports = { build, check, VERSION, PERMISSIONS };
