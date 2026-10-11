// Copies the Visor analysis engine from the extension into the web app.
//
// extension/changelog.js is the one real engine. The web app keeps two committed
// copies of it (Firebase deploys only this folder, and the two repos are cloned
// separately, so the copies have to live here):
//   lib/engine/changelog.js     — required by the server (process reports)
//   public/engine/changelog.js  — loaded by the browser (replay)
//
// It also copies the citation formatter the other way round, inside this repo:
// public/cite-format.js (the browser's) -> lib/cite.js (the server's).
//
// Run with `npm run sync-engine` (also runs before every deploy). If the
// extension isn't next to this folder, the committed engine copies are left alone.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, '..', 'extension', 'changelog.js');
const TARGETS = [path.join(ROOT, 'lib', 'engine', 'changelog.js'), path.join(ROOT, 'public', 'engine', 'changelog.js')];

// The citation formatter: one file, served to the browser and required by the server
const CITE_FROM = path.join(ROOT, 'public', 'cite-format.js'), CITE_TO = path.join(ROOT, 'lib', 'cite.js');
if (fs.existsSync(CITE_FROM)) {
  const c = fs.readFileSync(CITE_FROM);
  const same = fs.existsSync(CITE_TO) && fs.readFileSync(CITE_TO).equals(c);
  if (!same) fs.writeFileSync(CITE_TO, c);
  console.log(`sync-engine: lib/cite.js ${same ? 'already up to date' : 'updated'}`);
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
