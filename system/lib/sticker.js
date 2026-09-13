'use strict';

const sharp = require('sharp');
const webp = require('node-webpmux');
const crypto = require('node:crypto');

const MAX_STICKER_INPUT_BYTES = 12 * 1024 * 1024;

function buildStickerExif({ packname, author, categories = [''] }) {
  const metadata = {
    'sticker-pack-id': crypto.randomUUID(),
    'sticker-pack-name': packname,
    'sticker-pack-publisher': author,
    emojis: Array.isArray(categories) && categories.length ? categories : ['']
  };
  const jsonBuffer = Buffer.from(JSON.stringify(metadata), 'utf8');
  const exifHeader = Buffer.from([
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x16, 0x00, 0x00, 0x00
  ]);
  const exif = Buffer.concat([exifHeader, jsonBuffer]);
  exif.writeUIntLE(jsonBuffer.length, 14, 4);
  return exif;
}

async function convertStickerToImage(input) {
  if (!Buffer.isBuffer(input) || input.length === 0) {
    throw new TypeError('Sticker source must be a non-empty Buffer.');
  }
  if (input.length > MAX_STICKER_INPUT_BYTES) {
    throw new Error('Sticker is too large to convert. Maximum size is 12 MB.');
  }

  return extractFirstFrameFromWebP(input);
}

async function createImageSticker(input, metadata) {
  if (!Buffer.isBuffer(input) || input.length === 0) {
    throw new TypeError('Sticker source must be a non-empty Buffer.');
  }
  if (input.length > MAX_STICKER_INPUT_BYTES) {
    throw new Error('Image is too large for sticker conversion. Maximum size is 12 MB.');
  }

  const webpBuffer = await sharp(input, { limitInputPixels: 25_000_000, failOn: 'error' })
    .rotate()
    .resize(512, 512, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
      withoutEnlargement: true
    })
    .webp({ quality: 82, effort: 4, smartSubsample: true })
    .toBuffer();

  const image = new webp.Image();
  await image.load(webpBuffer);
  image.exif = buildStickerExif(metadata);
  return image.save(null);
}

module.exports = {
  MAX_STICKER_INPUT_BYTES,
  buildStickerExif,
  convertStickerToImage,
  createImageSticker
};

// Source conversion helpers use isolated temporary directories per request.
// Never return image bytes under a video MIME type when FFmpeg fails.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
async function withTempDir(operation) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'anime-convert-'));
  try { return await operation(dir); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
}
async function runFfmpeg(args) {
  try { await execFile('ffmpeg', ['-nostdin', '-y', ...args], { timeout: 60000, maxBuffer: 2 * 1024 * 1024 }); }
  catch (error) { throw new Error(error.code === 'ENOENT' ? 'FFmpeg is required. Install ffmpeg on the bot host.' : `Conversion failed: ${error.message}`); }
}
async function takeSticker(input, metadata) {
  const image = new webp.Image();
  await image.load(input);
  image.exif = buildStickerExif(metadata);
  return image.save(null);
}
async function createVideoSticker(input, metadata) {
  if (!Buffer.isBuffer(input) || !input.length || input.length > MAX_STICKER_INPUT_BYTES) throw new Error('Video must be 1 byte to 12 MB.');
  return withTempDir(async dir => {
    const source = path.join(dir, 'input');
    const output = path.join(dir, 'sticker.webp');
    await fs.writeFile(source, input);
    await runFfmpeg(['-i', source, '-t', '10', '-vf', 'fps=15,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000', '-c:v', 'libwebp', '-q:v', '70', '-loop', '0', '-an', output]);
    return takeSticker(await fs.readFile(output), metadata);
  });
}
async function checkIfAnimatedWebP(input) {
  const metadata = await sharp(input, { animated: true }).metadata();
  return (metadata.pages || 1) > 1;
}
async function extractFirstFrameFromWebP(input) {
  return sharp(input, { page: 0, pages: 1, limitInputPixels: 25_000_000, failOn: 'error' }).png().toBuffer();
}
async function createSimpleVideo(input) {
  return withTempDir(async dir => {
    const frame = path.join(dir, 'frame.png');
    const output = path.join(dir, 'video.mp4');
    await fs.writeFile(frame, await sharp(input, { page: 0, pages: 1 }).resize(512, 512, { fit: 'contain' }).png().toBuffer());
    await runFfmpeg(['-loop', '1', '-i', frame, '-t', '3', '-r', '10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', output]);
    return fs.readFile(output);
  });
}
async function convertToVideo(input) {
  if (!(await checkIfAnimatedWebP(input))) return createSimpleVideo(input);
  // FFmpeg builds commonly cannot decode animated WebP. Extract each frame
  // with libvips, preserving delays, then encode a WhatsApp-compatible MP4.
  return withTempDir(async dir => {
    const info = await sharp(input, { animated: true }).metadata();
    if (info.pages > 300) throw new Error('Sticker animation exceeds 300 frames.');
    const lines = [];
    for (let page = 0; page < info.pages; page++) {
      const name = `frame-${page}.png`;
      await sharp(input, { page, pages: 1 }).resize(512, 512, { fit: 'contain' }).png().toFile(path.join(dir, name));
      lines.push(`file '${name}'`, `duration ${Math.max(10, info.delay?.[page] || 100) / 1000}`);
    }
    lines.push(`file 'frame-${info.pages - 1}.png'`);
    const manifest = path.join(dir, 'frames.txt');
    const output = path.join(dir, 'video.mp4');
    await fs.writeFile(manifest, lines.join('\n'));
    await runFfmpeg(['-f', 'concat', '-safe', '0', '-i', manifest, '-t', '5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output]);
    return fs.readFile(output);
  });
}
Object.assign(module.exports, { takeSticker, createVideoSticker, checkIfAnimatedWebP, extractFirstFrameFromWebP, createSimpleVideo, convertToVideo });
