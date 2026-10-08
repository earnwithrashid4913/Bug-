'use strict';

// ---------------------------------------------------------------------------
// Shared media validation layer (system/lib/media-validation.js).
//
// The contract every download path relies on:
//   * HTML/JSON/XML error pages are NEVER media, even at HTTP 200.
//   * Real bytes (magic signatures) decide the kind, not labels or MIME text.
//   * Unknown binary is a document, never a fake "video".
// ---------------------------------------------------------------------------

const assert = require('node:assert/strict');
const test = require('node:test');
const { looksLikeErrorPage, assertValidDownload, detectMediaKind } = require('../system/lib/media-validation');

const mp4 = () => Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6F, 0x6D, 1, 1, 1, 1]);
const webm = () => Buffer.from([0x1A, 0x45, 0xDF, 0xA3, 1, 1, 1, 1, 1, 1, 1, 1]);
const jpeg = () => Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 1, 1, 1, 1, 1, 1, 1, 1]);
const png = () => Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 1, 1, 1]);
const mp3id3 = () => Buffer.from([0x49, 0x44, 0x33, 0x04, 1, 1, 1, 1, 1, 1, 1, 1]);
const mp3frame = () => Buffer.from([0xFF, 0xFB, 0x90, 0x00, 1, 1, 1, 1, 1, 1, 1, 1]);
const ogg = () => Buffer.from([0x4F, 0x67, 0x67, 0x53, 1, 1, 1, 1, 1, 1, 1, 1]);

test('HTML, JSON and XML error pages are rejected, real media is not', () => {
  for (const bad of [
    Buffer.from('<!DOCTYPE html><html><body>error</body></html>'),
    Buffer.from('  <html><head><title>404</title></head></html>'),
    Buffer.from('{"status":false,"message":"rate limited"}'),
    Buffer.from('[{"error":"not found"}]'),
    Buffer.from('<?xml version="1.0"?><error>no</error>'),
    Buffer.alloc(0)
  ]) {
    assert.equal(looksLikeErrorPage(bad), true, `must be rejected: ${bad.toString('latin1').slice(0, 24)}`);
  }
  for (const good of [mp4(), webm(), jpeg(), png(), mp3id3(), ogg()]) {
    assert.equal(looksLikeErrorPage(good), false);
  }
});

test('assertValidDownload throws for error pages and empty bodies, passes real media', () => {
  assert.throws(() => assertValidDownload(Buffer.from('<!doctype html>'), 'Provider X'), /Provider X returned an error page instead of media/);
  assert.throws(() => assertValidDownload(Buffer.alloc(0), 'Provider X'), /Provider X returned an empty file/);
  assert.throws(() => assertValidDownload(null, 'Provider X'), /Provider X returned an empty file/);
  assert.doesNotThrow(() => assertValidDownload(mp4(), 'Provider X'));
});

test('media kind comes from magic bytes first, extension second, never faked', () => {
  assert.equal(detectMediaKind(mp4(), 'https://cdn.example/file.bin'), 'video');
  assert.equal(detectMediaKind(webm(), ''), 'video');
  assert.equal(detectMediaKind(jpeg(), ''), 'image');
  assert.equal(detectMediaKind(png(), ''), 'image');
  assert.equal(detectMediaKind(mp3id3(), ''), 'audio');
  assert.equal(detectMediaKind(mp3frame(), ''), 'audio');
  assert.equal(detectMediaKind(ogg(), ''), 'audio');
  // Extension hints only when the signature is inconclusive.
  assert.equal(detectMediaKind(Buffer.alloc(1200, 1), 'https://cdn.example/clip.mp4'), 'video');
  assert.equal(detectMediaKind(Buffer.alloc(1200, 1), 'https://cdn.example/song.mp3'), 'audio');
  assert.equal(detectMediaKind(Buffer.alloc(1200, 1), 'https://cdn.example/pic.jpg'), 'image');
  // Unknown binary is a document — never faked into a video message.
  assert.equal(detectMediaKind(Buffer.alloc(1200, 1), 'https://cdn.example/archive.zip'), 'document');
  assert.equal(detectMediaKind(Buffer.alloc(1200, 1), ''), 'document');
});
