// Turning recordings into small MP3s (lib/audioConvert.js) and the list of
// accepted types (lib/audioFormats.js). Uses the local ffmpeg program from
// ffmpeg-static; nothing here leaves the machine.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const convert = require('../lib/audioConvert');
const formats = require('../lib/audioFormats');

// One second of a 440 Hz tone as a WAV file
function wav(seconds = 1, rate = 16000) {
  const samples = seconds * rate, data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(9000 * Math.sin(2 * Math.PI * 440 * i / rate)), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
const isMp3 = b => b.toString('latin1', 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0);

test('a recording becomes a much smaller MP3', { skip: !convert.available() && 'ffmpeg isn’t installed here' }, async () => {
  const original = wav(3);
  const mp3 = await convert.convert(original, 'wav');
  assert.ok(isMp3(mp3), 'an MP3');
  assert.ok(mp3.length < original.length / 3, `${mp3.length} of ${original.length}`);
});

test('a file with no readable sound says so, in words a person can use', { skip: !convert.available() && 'ffmpeg isn’t installed here' }, async () => {
  await assert.rejects(convert.convert(Buffer.from('this is not a recording'.repeat(40)), 'mp3'), err => err instanceof convert.UnreadableAudio && /couldn't read the audio/.test(err.message));
});

test('without ffmpeg the original is sent instead', async () => {
  process.env.VISOR_NO_FFMPEG = '1';
  try { assert.strictEqual(await convert.convert(wav(), 'wav'), null); }
  finally { delete process.env.VISOR_NO_FFMPEG; }
});

test('what browsers record is accepted, by file ending or by type', () => {
  assert.deepStrictEqual(formats.audioFormat('discussion-part-1.webm', 'audio/webm;codecs=opus'), { ext: 'webm', mime: 'audio/webm' });
  assert.deepStrictEqual(formats.audioFormat('discussion-part-2.mp4', 'audio/mp4'), { ext: 'mp4', mime: 'audio/mp4' });
  assert.deepStrictEqual(formats.audioFormat('', 'audio/ogg;codecs=opus'), { ext: 'ogg', mime: 'audio/ogg' });
  assert.deepStrictEqual(formats.audioFormat('notes.txt', 'text/plain'), null);
  assert.match(formats.unsupportedMessage('notes.txt'), /\.txt files aren't supported/);
  assert.strictEqual(formats.audioFormat('constructor', 'constructor'), null, 'nothing from the object’s prototype');
});
