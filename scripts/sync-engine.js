// Copies the Visor analysis engine from the extension into the web app.
//
// extension/changelog.js is the one real engine. The web app keeps two committed
// copies of it (Firebase deploys only this folder, and the two repos are cloned
// separately, so the copies have to live here):
//   lib/engine/changelog.js     — required by the server (process reports)
//   public/engine/changelog.js  — loaded by the browser (replay)
//
// It also copies three shared modules the other way round, inside this repo
// (the browser's copy is the one to edit):
//   public/cite-format.js     -> lib/cite.js             the citation formatter
//   public/doc-format.js      -> lib/doc-format.js       the document model (formats, runs, deltas)
//   public/assignment-text.js -> lib/assignment-text.js  an assignment's settings in plain words
//   public/source-grade.js    -> lib/source-grade.js     a source's reliability grade
//
// Run with `npm run sync-engine` (also runs before every deploy). If the
// extension isn't next to this folder, the committed engine copies are left alone.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, '..', 'extension', 'changelog.js');
const TARGETS = [path.join(ROOT, 'lib', 'engine', 'changelog.js'), path.join(ROOT, 'public', 'engine', 'changelog.js')];

// One file each, served to the browser and required by the server
const SHARED = [
  [path.join(ROOT, 'public', 'cite-format.js'), path.join(ROOT, 'lib', 'cite.js')],
  [path.join(ROOT, 'public', 'doc-format.js'), path.join(ROOT, 'lib', 'doc-format.js')],
  [path.join(ROOT, 'public', 'assignment-text.js'), path.join(ROOT, 'lib', 'assignment-text.js')],
  [path.join(ROOT, 'public', 'source-grade.js'), path.join(ROOT, 'lib', 'source-grade.js')]
];
for (const [from, to] of SHARED) {
  if (!fs.existsSync(from)) continue;
  const c = fs.readFileSync(from);
  const same = fs.existsSync(to) && fs.readFileSync(to).equals(c);
  if (!same) fs.writeFileSync(to, c);
  console.log(`sync-engine: ${path.relative(ROOT, to)} ${same ? 'already up to date' : 'updated'}`);
}

if (!fs.existsSync(SOURCE)) {
  console.warn(`sync-engine: ${path.relative(ROOT, SOURCE)} not found; keeping the committed copies.`);
  process.exit(0);
}
const src = fs.readFileSync(SOURCE);
for (const t of TARGETS) {
  fs.mkdirSync(path.dirname(t), { recursive: true });
  const same = fs.existsSync(t) && fs.readFileSync(t).equals(src);
  if (!same) fs.writeFileSync(t, src);
  console.log(`sync-engine: ${path.relative(ROOT, t)} ${same ? 'already up to date' : 'updated'}`);
}
