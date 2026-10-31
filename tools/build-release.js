#!/usr/bin/env node
/* ============================================================================
 * Build the Web Store release: Google Docs history and Visor Classroom.
 * ----------------------------------------------------------------------------
 *   node tools/build-release.js [outDir] [zipPath]
 *
 * Writes the extension to outDir (default dist/visor-release) and, given a
 * path, zips it there, from the files git tracks (so commit first). It's this
 * source tree with what only development needs taken out: docs, tests, tools,
 * and the localhost address.
 *
 * The localhost address matters. Source lists http://localhost:3000 so the
 * extension can be tested against a local web app, which makes any page on
 * that port a trusted Visor page: it could connect the extension or start a
 * session. Port 3000 is the usual port for any local web app, so a published
 * build must not trust it. The build fails if the word survives anywhere.
 * ==========================================================================*/

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { missingFiles } = require('./build-docs.js');

const SRC = path.join(__dirname, '..');
const OUT_DEFAULT = path.resolve(require.main === module && process.argv[2] || path.join(SRC, 'dist', 'visor-release'));
const ZIP_DEFAULT = require.main === module && process.argv[3] ? path.resolve(process.argv[3]) : null;

const DEV_ONLY = /^(docs|tests|tools)\/|\.md$|^\.gitignore$/;
const TEXT = /\.(js|json|html|css)$/;

function build(OUT = OUT_DEFAULT, ZIP = ZIP_DEFAULT) {
  fs.rmSync(OUT, { recursive: true, force: true });
  const files = execFileSync('git', ['ls-files'], { cwd: SRC, encoding: 'utf8' }).split('\n')
    .filter((f) => f && !DEV_ONLY.test(f));
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(OUT, f)), { recursive: true });
    fs.copyFileSync(path.join(SRC, f), path.join(OUT, f));
  }

  // The bridge's addresses, in the two places that must agree (see config.js)
  const manifest = path.join(OUT, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  for (const cs of m.content_scripts) if (cs.matches) cs.matches = cs.matches.filter((u) => !u.includes('localhost'));
  fs.writeFileSync(manifest, JSON.stringify(m, null, 2) + '\n');
  const config = path.join(OUT, 'config.js');
  const before = fs.readFileSync(config, 'utf8');
  const after = before.replace(/^\s*'http:\/\/localhost:3000',\n/m, '');
  if (after === before) throw new Error('config.js no longer has the line this build removes');
  fs.writeFileSync(config, after);

  check(OUT);
  if (ZIP) {
    fs.rmSync(ZIP, { force: true });
    execFileSync('zip', ['-r', '-X', '-q', ZIP, '.'], { cwd: OUT });
  }
  return OUT;
}

/** Everything named is present, and nothing still trusts localhost. */
function check(OUT = OUT_DEFAULT) {
  const missing = missingFiles(OUT);
  if (missing.length) throw new Error(`the build is missing ${missing.join(', ')}`);
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const local = walk(OUT).filter((f) => TEXT.test(f) && /localhost/.test(fs.readFileSync(f, 'utf8')));
  if (local.length) throw new Error(`localhost is still in ${local.map((f) => path.relative(OUT, f)).join(', ')}`);
}

if (require.main === module) {
  const out = build();
  const m = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
  console.log(`${m.name} ${m.version} → ${out}${ZIP_DEFAULT ? `\nzipped → ${ZIP_DEFAULT}` : ''}`);
}

module.exports = { build, check };
