'use strict';
const strict = require('node:assert/strict');
// Existing behavior assertions compare title wording independently of display
// font. Normalize only boxed titles: body text, codes and identifiers stay raw.
function normalizeTelegramHeadings(text) {
  return typeof text === 'string' ? text.replace(/〔 ([^〕\n]+) 〕/g, (_, title) => `〔 ${title.normalize('NFKC')} 〕`) : text;
}
const displayAssert = Object.assign(function (...args) { return strict(...args); }, strict, {
  match(actual, expected, message) { return strict.match(normalizeTelegramHeadings(actual), expected, message); },
  doesNotMatch(actual, expected, message) { return strict.doesNotMatch(normalizeTelegramHeadings(actual), expected, message); }
});
module.exports = { displayAssert, normalizeTelegramHeadings };
