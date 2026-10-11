// The recording types Visor accepts, in one place. The server checks every
// upload against this list, and the page gets it from /api/config so it can
// say "not supported" before anything is uploaded.
//
// Whatever the type, the server converts the sound to a small MP3 before
// sending it to Gemini (lib/audioConvert.js), so Gemini always gets one format
// it handles. The original file is kept for playback.

// file ending → the type the file is stored and played back as
const FORMATS = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  webm: 'audio/webm',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  aiff: 'audio/aiff',
  aif: 'audio/aiff',
  // Video files: only the sound is used.
  mp4: 'audio/mp4',
  mov: 'audio/mp4'
};

// browser-reported type → file ending (for recordings or files with no ending)
const EXT_BY_TYPE = {
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mpga': 'mp3',
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a',
  'audio/aac': 'aac', 'audio/x-aac': 'aac',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/vnd.wave': 'wav',
  'audio/webm': 'webm', 'video/webm': 'webm',
  'audio/ogg': 'ogg', 'audio/opus': 'opus',
  'audio/flac': 'flac', 'audio/x-flac': 'flac',
  'audio/aiff': 'aiff', 'audio/x-aiff': 'aiff',
  'video/mp4': 'mp4', 'video/quicktime': 'mov'
};

const LABEL = 'MP3, M4A, WAV, WebM, OGG, FLAC, AAC or AIFF audio, or MP4/MOV video';

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// → { ext, mime } for a supported file, or null.
// A file's own ending decides when it has one; otherwise the browser's type.
function audioFormat(filename, type) {
  const name = String(filename || '');
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (ext && has(FORMATS, ext)) return { ext, mime: FORMATS[ext] };
  const t = typeof type === 'string' ? type.split(';')[0].trim().toLowerCase() : '';
  if (t && has(EXT_BY_TYPE, t)) { const e = EXT_BY_TYPE[t]; return { ext: e, mime: FORMATS[e] }; }
  return null;
}

function unsupportedMessage(filename, type) {
  const name = String(filename || '');
  const dot = name.lastIndexOf('.');
  const what = dot > 0 ? `.${name.slice(dot + 1).toLowerCase()} files aren't` : (type ? `"${String(type).split(';')[0]}" files aren't` : "That kind of file isn't");
  return `${what} supported for recordings. Use ${LABEL}.`;
}

module.exports = { FORMATS, EXT_BY_TYPE, LABEL, audioFormat, unsupportedMessage };
