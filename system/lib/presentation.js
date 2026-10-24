'use strict';
function font(text) {
  return String(text ?? '').replace(/[A-Za-z]/g, char => String.fromCodePoint(char.charCodeAt(0) + (char <= 'Z' ? 0x1d400 - 65 : 0x1d41a - 97)));
}
// Only marked display headings are styled. Never change command/action IDs,
// code blocks, URLs or the body of a user's query.
function styleHeaders(text) {
  return String(text ?? '').split(/(```[\s\S]*?```|`[^`]*`)/g).map((part, i) => i % 2 ? part : part.replace(/\*([^*\n]+)\*/g, (match, title) => /https?:\/\/|[!/?]/.test(title) ? match : `*${font(title)}*`)).join('');
}
// One shared ANIME MD credit line for every user-facing template. The source
// of truth is the canonical identity, so a footer can never drift back to a
// legacy third-party brand.
const { CANONICAL_IDENTITY } = require('../security');
const BRAND_FOOTER = `𝐏𝐨𝐰𝐞𝐫𝐞𝐝 𝐁𝐲 ${font(CANONICAL_IDENTITY.projectName.replace(/\s+/g, ' '))}`;
const FOOTER = BRAND_FOOTER;
module.exports = { font, styleHeaders, FOOTER };
