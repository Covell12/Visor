// Where pictures in essays live.
//
// "gcs"   — Cloud Storage (the Firebase project's default bucket), at
//           images/<docId>/<id>.<ext>. Used on Firebase.
// "local" — files in data/images/<docId>/<id>.<ext>. Used when running on
//           your own computer.
//
// Each picture arrives in one request: the editor shrinks it first, so it
// stays under MAX_IMAGE_BYTES. The bucket stays private, like the recordings
// (lib/audioStorage.js): pictures are only served through the /api/images
// route, which checks who's asking.

const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream');
const { IS_FIREBASE } = require('./platform');

const IMAGE_DIR = process.env.VISOR_IMAGE_DIR || path.join(__dirname, '..', 'data', 'images'); // tests use their own folder
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const ID_RE = /^[a-f0-9]{32}$/;
const DOC_RE = /^[A-Za-z0-9_-]{1,64}$/; // doc ids are hex; nothing that could leave the folder

function mode() { return IS_FIREBASE ? 'gcs' : 'local'; }
const gcsFile = p => require('./firebaseAdmin').bucket().file(p);

// The picture's type from its first bytes (never from what the browser says):
// PNG, JPEG, GIF or WebP, or null for anything else.
function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf.toString('latin1', 0, 8) === '\x89PNG\r\n\x1a\n') return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  const gif = buf.toString('latin1', 0, 6);
  if (gif === 'GIF87a' || gif === 'GIF89a') return 'image/gif';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

// The local file for a stored picture, or null if the record points outside the folder
function localPath(stored) {
  if (!stored?.file) return null;
  const file = path.resolve(IMAGE_DIR, stored.file);
  return file.startsWith(path.resolve(IMAGE_DIR) + path.sep) ? file : null;
}

// Store one picture. Returns where it went, for the image record.
async function putImage({ docId, id, mime, buf }) {
  const ext = EXT[mime];
  if (!ext || !DOC_RE.test(String(docId)) || !ID_RE.test(String(id)) || !Buffer.isBuffer(buf)) throw new Error('putImage: bad picture');
  if (mode() === 'gcs') {
    const p = `images/${docId}/${id}.${ext}`;
    await gcsFile(p).save(buf, { resumable: false, contentType: mime, metadata: { contentType: mime } });
    return { storage: 'gcs', path: p };
  }
  const file = `${docId}/${id}.${ext}`;
  await fs.promises.mkdir(path.join(IMAGE_DIR, docId), { recursive: true });
  await fs.promises.writeFile(path.join(IMAGE_DIR, file), buf, { flag: 'wx' }); // ids are random: never overwrite
  return { storage: 'local', file };
}

// Send a picture to an already-authorized request. Private caching only, so a
// shared cache (Hosting's CDN) never keeps a student's picture.
async function streamImage(stored, mime, res) {
  const missing = () => res.status(404).json({ error: 'image not found' });
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const type = EXT[mime] ? mime : 'application/octet-stream';
  if (stored?.storage === 'gcs') {
    if (!stored.path) return missing();
    const f = gcsFile(stored.path);
    let size;
    try { size = Number((await f.getMetadata())[0].size); } catch { return missing(); }
    res.setHeader('Content-Type', type);
    if (Number.isFinite(size)) res.setHeader('Content-Length', String(size));
    // pipeline stops reading from storage if the listener goes away mid-stream
    pipeline(f.createReadStream(), res, err => { if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.error('image stream failed:', err.message); });
    return;
  }
  const file = localPath(stored);
  if (!file || !fs.existsSync(file)) return missing();
  res.setHeader('Content-Type', type);
  res.sendFile(file);
}

// Delete a stored picture. A picture that's already gone is fine.
async function deleteImage(stored) {
  if (!stored) return;
  if (stored.storage === 'gcs') {
    if (!stored.path) return;
    try { await gcsFile(stored.path).delete({ ignoreNotFound: true }); } catch (err) { console.warn('image delete failed:', err.message); }
    return;
  }
  const file = localPath(stored);
  if (!file) return;
  try { fs.unlinkSync(file); } catch {}
  // the document's folder, once it's empty
  if (path.dirname(file) !== path.resolve(IMAGE_DIR)) { try { fs.rmdirSync(path.dirname(file)); } catch {} }
}

module.exports = { mode, sniffImage, putImage, streamImage, deleteImage, IMAGE_DIR, MAX_IMAGE_BYTES };
