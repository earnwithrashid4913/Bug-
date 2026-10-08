'use strict';

// ---------------------------------------------------------------------------
// ANIME-MD SHARED MEDIA VALIDATION LAYER
//
// ONE validator for every download path (!aio, !media, !play, !video,
// !audio and the social downloaders). The rules this module enforces:
//
//   * "Downloaded bytes" != "valid media". A provider answering HTTP 200 with
//     an HTML/JSON/XML error page must be rejected BEFORE it is uploaded to
//     WhatsApp as a broken "video".
//   * Content-Type, file extension and provider labels are hints only. The
//     real bytes (magic signatures) are the trustworthy signal.
//   * Unknown binary is delivered as a DOCUMENT, never faked into a video or
//     audio message WhatsApp cannot play.
// ---------------------------------------------------------------------------

function headText(buffer, length = 512) {
  return buffer.subarray(0, Math.min(length, buffer.length)).toString('latin1').trimStart().toLowerCase();
}

// True when the buffer is really a text error page (HTML/JSON/XML) rather than
// media. Real video/audio/image never starts with these markers.
function looksLikeErrorPage(buffer) {
  if (!buffer || !buffer.length) return true;
  const head = headText(buffer);
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) return true;
  if (head.startsWith('<') && /<\/(html|body|head|error|response|title)>/i.test(head)) return true;
  if (head.startsWith('{') || head.startsWith('[')) return true; // JSON payload
  return false;
}

// Hard gate every download path must pass before declaring success.
function assertValidDownload(buffer, stageLabel) {
  const label = stageLabel || 'The download source';
  if (!buffer || !buffer.length) throw new Error(`${label} returned an empty file.`);
  if (looksLikeErrorPage(buffer)) throw new Error(`${label} returned an error page instead of media.`);
}

// Media kind from the real bytes first (the only trustworthy signal), then
// the URL extension as a hint. Unknown binary is 'document': it is delivered
// as a file, never faked into a video/audio message WhatsApp cannot play.
function detectMediaKind(buffer, hintUrl = '') {
  if (buffer && buffer.length >= 12) {
    const head = buffer.subarray(0, 12);
    if (head[0] === 0xFF && head[1] === 0xD8 && head[2] === 0xFF) return 'image'; // JPEG
    if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4E && head[3] === 0x47) return 'image'; // PNG
    if (head.subarray(0, 4).toString('latin1') === 'GIF8') return 'image';
    if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image';
    if (head.subarray(4, 8).toString('latin1') === 'ftyp') return 'video'; // MP4/MOV/3GP (ISO-BMFF)
    // EBML header: WebM / Matroska.
    if (head[0] === 0x1A && head[1] === 0x45 && head[2] === 0xDF && head[3] === 0xA3) return 'video';
    if (head.subarray(0, 3).toString('latin1') === 'ID3') return 'audio'; // MP3 with tags
    if (head[0] === 0xFF && (head[1] & 0xE0) === 0xE0) return 'audio'; // MP3 frame sync
    if (head.subarray(0, 4).toString('latin1') === 'OggS') return 'audio'; // Ogg (Vorbis/Opus)
    if (head.subarray(0, 4).toString('latin1') === 'fLaC') return 'audio';
    if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WAVE') return 'audio';
    if (head.subarray(0, 4).toString('latin1') === '%PDF') return 'document';
  }
  const url = String(hintUrl || '');
  if (/\.(mp3|m4a|aac|opus|ogg|oga|flac|wav|amr)(?:[?#]|$)/i.test(url)) return 'audio';
  if (/\.(jpe?g|png|webp|gif|bmp)(?:[?#]|$)/i.test(url)) return 'image';
  if (/\.(mp4|mkv|webm|mov|avi|3gp|m4v)(?:[?#]|$)/i.test(url)) return 'video';
  return 'document';
}

module.exports = { looksLikeErrorPage, assertValidDownload, detectMediaKind };
