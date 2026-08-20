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
  createImageSticker
};
