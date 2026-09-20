'use strict';
const strict = require('node:assert/strict');
// Existing behavior assertions compare title wording independently of display
// font. Normalize only boxed titles: body text, codes and identifiers stay raw.
function normalizeTelegramHeadings(text) {
  return typeof text === 'string' ? text.replace(/〔 ([^〕\n]+) 〕/g, (_, title) => `〔 ${title.normalize('NFKC')} 〕`) : text;
}
// The dashboard cards (CONNECTED / ACTIVITY / SYSTEM / ALL SESSIONS) highlight
// their important fields with MATHEMATICAL BOLD glyphs (U+1D400-U+1D7FF). Those
// fold back to plain ASCII under NFKC, so an assertion about the WORDING of a
// card can stay font-independent without weakening what it checks: every
// character that is not a styled letter/digit survives the fold unchanged.
function normalizeTelegramText(text) {
  return typeof text === 'string' ? text.normalize('NFKC') : text;
}
const displayAssert = Object.assign(function (...args) { return strict(...args); }, strict, {
  match(actual, expected, message) { return strict.match(normalizeTelegramHeadings(actual), expected, message); },
  doesNotMatch(actual, expected, message) { return strict.doesNotMatch(normalizeTelegramHeadings(actual), expected, message); }
});
module.exports = { displayAssert, normalizeTelegramHeadings, normalizeTelegramText };
