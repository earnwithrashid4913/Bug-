'use strict';

// -----------------------------------------------------------------------------
// International WhatsApp number normalization for the Telegram pairing flow.
//
// This module strictly separates:
//   1. NUMBER FORMAT VALIDATION — the structural correctness of an
//      international phone number (country code + subscriber number).
//   2. WHATSAPP AVAILABILITY — whether the number can actually be linked,
//      which only the real WhatsApp pairing flow can determine.
//
// The rules are international (ITU E.164) and never assume a specific country.
// The user may type the number with or without "+", and with spaces, dashes,
// dots, or parentheses; every form normalizes to one canonical representation.
// -----------------------------------------------------------------------------

const MIN_DIGITS = 7;
const MAX_DIGITS = 15;

const NUMBER_HELP = 'Use a 7-15 digit WhatsApp number with country code, without + (for example 923001234567).';

// All assigned three-digit ITU E.164 country codes. Used to split a number
// into country code + subscriber number for display formatting and structural
// validation. Anything else is treated as a one- or two-digit country code.
const THREE_DIGIT_COUNTRY_CODES = new Set((
  '212,213,216,218,' +                                                          // North Africa
  '220,221,222,223,224,225,226,227,228,229,230,231,232,233,234,235,236,237,238,239,' + // West Africa
  '240,241,242,243,244,245,246,248,249,' +                                      // Central Africa
  '250,251,252,253,254,255,256,257,258,' +                                      // East Africa
  '260,261,262,263,264,265,266,267,268,269,' +                                  // Indian Ocean / South Africa
  '290,291,297,298,299,' +                                                      // Atlantic
  '350,351,352,353,354,355,356,357,358,359,' +                                  // Europe
  '370,371,372,373,374,375,376,377,378,380,381,382,383,385,386,387,389,' +      // Baltans / Balkans
  '420,421,423,' +                                                              // Central Europe
  '500,501,502,503,504,505,506,507,508,509,' +                                  // Central America / Caribbean
  '590,591,592,593,594,595,596,597,598,599,' +                                  // South America / Caribbean
  '670,672,673,674,675,676,677,678,679,680,681,682,683,685,686,687,688,689,690,691,692,' + // Oceania
  '850,852,853,855,880,886,' +                                                  // East Asia
  '960,961,962,963,964,965,966,967,968,970,971,972,973,974,975,976,977,' +      // Middle East
  '992,993,994,995,996,998'                                                     // Central Asia
).split(',').filter(Boolean));

class NumberFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NumberFormatError';
    this.code = 'INVALID_NUMBER';
  }
}

/**
 * Normalizes user input into the canonical internal representation:
 * plain digits in international format (country code + subscriber number).
 *
 * Accepted inputs (all normalize identically):
 *   923001234567
 *   +923001234567
 *   92 300 1234567
 *   92-300-1234567
 *   (92) 300.1234567
 *
 * "+" is accepted but never required. A leading zero is rejected because it
 * means a local number was supplied without the country code.
 */
function normalizeWhatsAppNumber(value) {
  const raw = String(value ?? '').trim();
  // The plus sign and common visual separators are cosmetic; remove them.
  const number = raw.replace(/[+\s\-().]/g, '');

  if (!number) throw new NumberFormatError(`No phone number was supplied. ${NUMBER_HELP}`);
  if (!/^\d+$/.test(number)) {
    throw new NumberFormatError(`A phone number may only contain digits. ${NUMBER_HELP}`);
  }
  if (number.startsWith('0')) {
    throw new NumberFormatError(`Include the country code and do not start with 0. ${NUMBER_HELP}`);
  }
  if (number.length < MIN_DIGITS || number.length > MAX_DIGITS) {
    throw new NumberFormatError(`Use a 7-15 digit WhatsApp number with country code. ${NUMBER_HELP}`);
  }
  return number;
}

/**
 * Splits a canonical number into its country code and subscriber number.
 * Uses the assigned three-digit codes first, then the one-digit zones (+1, +7),
 * and falls back to a two-digit country code. Purely structural — this works
 * for every international country code, not one specific country.
 */
function splitCountryCode(number) {
  if (THREE_DIGIT_COUNTRY_CODES.has(number.slice(0, 3))) {
    return { countryCode: number.slice(0, 3), subscriber: number.slice(3) };
  }
  if (number.startsWith('1') || number.startsWith('7')) {
    return { countryCode: number.slice(0, 1), subscriber: number.slice(1) };
  }
  return { countryCode: number.slice(0, 2), subscriber: number.slice(2) };
}

/**
 * Pretty display form for Telegram messages, e.g. 923001234567 becomes
 * "+92 300 1234567". Display only — the canonical form stays digit-only.
 */
function formatInternationalNumber(number) {
  const canonical = normalizeWhatsAppNumber(number);
  const { countryCode, subscriber } = splitCountryCode(canonical);
  // North American Numbering Plan numbers follow the familiar 3-3-4 grouping.
  if (countryCode === '1' && subscriber.length === 10) {
    return `+1 ${subscriber.slice(0, 3)} ${subscriber.slice(3, 6)} ${subscriber.slice(6)}`;
  }
  if (subscriber.length >= MIN_DIGITS) {
    return `+${countryCode} ${subscriber.slice(0, 3)} ${subscriber.slice(3)}`;
  }
  return `+${countryCode} ${subscriber}`;
}

/**
 * Groups a raw pairing code for display: 8 characters render as XXXX-XXXX,
 * matching the input field WhatsApp shows under "Link with phone number".
 * Falsy inputs pass through unchanged (undefined stays undefined).
 */
function formatPairingCodeDisplay(code) {
  const value = String(code ?? '');
  if (!value) return code;
  return value.match(/.{1,4}/g).join('-');
}

module.exports = {
  MAX_DIGITS,
  MIN_DIGITS,
  NumberFormatError,
  formatInternationalNumber,
  formatPairingCodeDisplay,
  normalizeWhatsAppNumber,
  splitCountryCode
};
