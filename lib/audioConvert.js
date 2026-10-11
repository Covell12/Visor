// Turns any recording into a small mono MP3 (16 kHz, 32 kbps) for Gemini.
//
// Browsers record in different formats (Chrome: WebM/Opus, Safari: MP4/AAC),
// and Google doesn't accept every one of them in every route. Converting first
// means Gemini always receives a format it reads, and the file is much smaller
// (about 14 MB per hour), so it fits inside the request. Speech loses nothing
// that matters for a transcript.
//
// Uses the ffmpeg program from the ffmpeg-static package. If it's missing,
// convert() returns null and the original file is sent instead.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

function ffmpegPath() {
  if (process.env.VISOR_NO_FFMPEG) return null;
  try {
    const p = require('ffmpeg-static');
    return p && fs.existsSync(p) ? p : null;
  } catch { return null; }
}

// An error whose message can be shown to the person who added the recording.
class UnreadableAudio extends Error {}

function explain(stderr) {
  const s = String(stderr || '');
  if (/matches no streams|does not contain any stream|no audio/i.test(s)) {
    return "This file has no sound in it that Visor can find. If it's a video, make sure it has audio, or upload just the audio.";
  }
  return "Visor couldn't read the audio in this file. It may be damaged, or its ending (.mp3, .m4a…) may not match what's inside. Try exporting it again as MP3 or M4A.";
}

// buf: the recording; ext: its file ending (helps ffmpeg pick the reader).
// Resolves to an MP3 Buffer, or null if ffmpeg isn't available.
async function convert(buf, ext) {
  const bin = ffmpegPath();
  if (!bin) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-audio-'));
  const input = path.join(dir, `in.${/^[a-z0-9]{1,5}$/.test(ext || '') ? ext : 'bin'}`);
  const output = path.join(dir, 'out.mp3');
  try {
    fs.writeFileSync(input, buf);
    await new Promise((resolve, reject) => {
      execFile(bin, [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        '-i', input,
        '-map', '0:a:0', '-vn',          // first sound track only, no video
        '-ac', '1', '-ar', '16000',      // mono, 16 kHz
        '-c:a', 'libmp3lame', '-b:a', '32k',
        output
      ], { timeout: 6 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 }, (err, _out, stderr) => {
        if (!err) return resolve();
        if (err.killed) return reject(new Error('Converting the recording took too long.'));
        console.warn('ffmpeg could not convert the recording:', String(stderr || err.message).trim().slice(-600));
        reject(new UnreadableAudio(explain(stderr)));
      });
    });
    const mp3 = fs.readFileSync(output);
    if (mp3.length < 200) throw new UnreadableAudio(explain('no audio'));
    return mp3;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { convert, UnreadableAudio, available: () => !!ffmpegPath() };
