// Where recordings live.
//
// "gcs"   — Cloud Storage (the Firebase project's default bucket). Used on Firebase.
// "local" — files in data/audio. Used when running on your own computer.
//
// Uploads arrive in 4 MB pieces (each request stays well under the hosting
// request-size limits). On Cloud Storage each piece is saved as a temporary
// object under uploads/, and finishing the upload joins them into one file and
// deletes the pieces; locally the pieces are written straight into one file.
// The browser never talks to the bucket directly, so the bucket needs no CORS
// setup and stays private: playback goes through the signed-in /audio route.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { once } = require('events');
const { pipeline } = require('stream');
const { IS_FIREBASE } = require('./platform');

const AUDIO_DIR = path.join(__dirname, '..', 'data', 'audio');
const MAX_AUDIO_BYTES = 60 * 1024 * 1024; // keeps an inline Gemini request under its limit after base64
const CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_RANGE_BYTES = 4 * 1024 * 1024;   // largest piece sent back per playback request

function mode() { return IS_FIREBASE ? 'gcs' : 'local'; }
const gcsFile = p => require('./firebaseAdmin').bucket().file(p);

// ---- upload ----

// Returns what the upload needs to remember between pieces.
async function startUpload({ projectId, ext, mime, size }) {
  const name = `${crypto.randomUUID()}.${ext}`;
  if (mode() === 'gcs') {
    return { storage: 'gcs', path: `audio/${projectId}/${name}`, parts: `uploads/${crypto.randomUUID()}`, size, mime };
  }
  // Pieces go into "<name>.part"; finishing renames it, so a used upload token
  // can never write into a finished recording.
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  fs.writeFileSync(path.join(AUDIO_DIR, `${name}.part`), Buffer.alloc(0));
  return { storage: 'local', file: name, size, mime };
}

const partCount = up => Math.ceil(up.size / CHUNK_BYTES);
const partFile = (up, i) => gcsFile(`${up.parts}/${String(i).padStart(3, '0')}`);

// Write one piece: CHUNK_BYTES each, except the last. Sending a piece again
// (after a network hiccup) just replaces it.
async function writeChunk(up, offset, buf) {
  const end = offset + buf.length;
  if (offset % CHUNK_BYTES !== 0 || end > up.size || (buf.length !== CHUNK_BYTES && end !== up.size)) {
    const err = new Error('That piece of the upload is the wrong size.'); err.status = 400; throw err;
  }
  const done = end === up.size;
  if (up.storage === 'gcs') {
    if ((await gcsFile(up.path).exists())[0]) { const err = new Error('That upload has already finished. Start a new one.'); err.status = 400; throw err; }
    await partFile(up, offset / CHUNK_BYTES).save(buf, { resumable: false, contentType: 'application/octet-stream' });
    return { done };
  }
  let fd;
  try { fd = fs.openSync(path.join(AUDIO_DIR, `${up.file}.part`), 'r+'); }
  catch { const err = new Error('That upload has already finished. Start a new one.'); err.status = 400; throw err; }
  try { fs.writeSync(fd, buf, 0, buf.length, offset); } finally { fs.closeSync(fd); }
  return { done };
}

// Check the finished file is all there. Returns the stored audio record.
async function finishUpload(up) {
  let size;
  if (up.storage === 'gcs') {
    const [already] = await gcsFile(up.path).exists();
    if (already) return { storage: 'gcs', path: up.path, mime: up.mime, sizeBytes: Number((await gcsFile(up.path).getMetadata())[0].size) };
    // Every piece must be there with the right size before joining them.
    const [files] = await require('./firebaseAdmin').bucket().getFiles({ prefix: `${up.parts}/` });
    const sizes = new Map(files.map(f => [f.name, Number(f.metadata.size)]));
    const want = Array.from({ length: partCount(up) }, (_, i) => partFile(up, i).name);
    const complete = want.every((n, i) => sizes.get(n) === (i < want.length - 1 ? CHUNK_BYTES : up.size - CHUNK_BYTES * (want.length - 1)));
    if (complete) {
      // Stream the pieces into one file, one after another (memory use stays small).
      const out = gcsFile(up.path).createWriteStream({ resumable: false, contentType: up.mime, metadata: { contentType: up.mime } });
      const failed = new Promise((_, reject) => out.on('error', reject));
      failed.catch(() => {});
      for (let i = 0; i < want.length; i++) {
        for await (const chunk of partFile(up, i).createReadStream()) {
          if (!out.write(chunk)) await Promise.race([once(out, 'drain'), failed]);
        }
      }
      out.end();
      await Promise.race([once(out, 'finish'), failed]);
      size = Number((await gcsFile(up.path).getMetadata())[0].size);
      await Promise.all(want.map((_, i) => partFile(up, i).delete({ ignoreNotFound: true }).catch(() => {})));
    }
  } else {
    const part = path.join(AUDIO_DIR, `${up.file}.part`), done = path.join(AUDIO_DIR, up.file);
    try { size = fs.statSync(part).size; } catch {}
    if (size === up.size) fs.renameSync(part, done);
    else if (size === undefined) { try { size = fs.statSync(done).size; } catch {} }
  }
  if (size !== up.size) {
    const err = new Error('The upload did not finish. Try again.'); err.status = 400; throw err;
  }
  return up.storage === 'gcs'
    ? { storage: 'gcs', path: up.path, mime: up.mime, sizeBytes: size }
    : { storage: 'local', file: up.file, mime: up.mime, sizeBytes: size };
}

// ---- read / play / delete ----

async function readAudio(audio) {
  if (audio.storage === 'gcs') return (await gcsFile(audio.path).download())[0];
  return fs.readFileSync(path.join(AUDIO_DIR, audio.file));
}

// The recording's gs:// address, so Vertex AI can read it from the bucket.
// Null for recordings kept on your computer.
function gcsUri(audio) {
  if (audio?.storage !== 'gcs' || !audio.path) return null;
  return `gs://${require('./firebaseAdmin').bucket().name}/${audio.path}`;
}

async function deleteAudio(audio) {
  if (!audio) return;
  if (audio.storage === 'gcs') {
    try { await gcsFile(audio.path).delete({ ignoreNotFound: true }); } catch (err) { console.warn('recording delete failed:', err.message); }
    return;
  }
  if (audio.file) { try { fs.unlinkSync(path.join(AUDIO_DIR, audio.file)); } catch {} }
}

// Stream a recording to an already-authorized request, honoring Range so the
// player can seek. The audio player always asks for ranges; each answer is at
// most MAX_RANGE_BYTES and the player asks for the next piece on its own.
async function streamAudio(audio, req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (audio.storage !== 'gcs') {
    const file = path.join(AUDIO_DIR, audio.file || '');
    if (!audio.file || !fs.existsSync(file)) return res.status(404).json({ error: 'recording not found' });
    res.type(audio.mime || 'application/octet-stream');
    return res.sendFile(file);
  }
  const f = gcsFile(audio.path);
  let size;
  try { size = Number((await f.getMetadata())[0].size); } catch { return res.status(404).json({ error: 'recording not found' }); }
  res.setHeader('Content-Type', audio.mime || 'application/octet-stream');
  res.setHeader('Accept-Ranges', 'bytes');
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim());
  let start = 0, end = size - 1, partial = false;
  if (m && (m[1] || m[2])) {
    partial = true;
    if (m[1]) { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1; }
    else { start = Math.max(0, size - Number(m[2])); }
    if (start >= size || start > end) { res.setHeader('Content-Range', `bytes */${size}`); return res.status(416).end(); }
  }
  if (partial) {
    end = Math.min(end, start + MAX_RANGE_BYTES - 1);
    res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  }
  res.setHeader('Content-Length', String(end - start + 1));
  if (req.method === 'HEAD') return res.end();
  // pipeline stops reading from storage if the listener goes away mid-stream
  pipeline(f.createReadStream({ start, end }), res, err => { if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.error('recording stream failed:', err.message); });
}

module.exports = { mode, startUpload, writeChunk, finishUpload, readAudio, gcsUri, deleteAudio, streamAudio, AUDIO_DIR, MAX_AUDIO_BYTES, CHUNK_BYTES };
