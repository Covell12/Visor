// Copies Quill (the editor Visor Writer is built on) out of node_modules into
// public/vendor/quill/, where Firebase Hosting serves it. The copies are
// committed: school web filters often block CDNs, so nothing is loaded from one.
//
//   npm i -D quill@2.0.3   (already in package.json)
//   npm run vendor
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FROM = path.join(ROOT, 'node_modules', 'quill', 'dist');
const TO = path.join(ROOT, 'public', 'vendor', 'quill');
const FILES = ['quill.js', 'quill.js.LICENSE.txt', 'quill.snow.css'];

if (!fs.existsSync(FROM)) {
  console.warn('vendor: node_modules/quill not found (run npm install); keeping the committed copies.');
  process.exit(0);
}
fs.mkdirSync(TO, { recursive: true });
for (const f of FILES) {
  // The source-map comment points at a file that isn't copied; drop it so
  // browsers don't ask for it.
  let body = fs.readFileSync(path.join(FROM, f), 'utf8');
  if (f.endsWith('.js') || f.endsWith('.css')) body = body.replace(/\n?\/[/*]# sourceMappingURL=.*$/m, '');
  fs.writeFileSync(path.join(TO, f), body);
  console.log(`vendor: public/vendor/quill/${f}`);
}
const version = require(path.join(ROOT, 'node_modules', 'quill', 'package.json')).version;
fs.writeFileSync(path.join(TO, 'VERSION'), `quill ${version}\n`);
