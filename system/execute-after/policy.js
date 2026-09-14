'use strict';

// =============================================================================
// EXECUTEAFTER — CONTENT POLICY GATE
// =============================================================================
// ExecuteAfter is built for permitted, non-explicit video APIs. Before a result
// is formatted or a media file is fetched, the title/description/URL is checked
// against the blocked terms and hosts configured in execute-after.config.js
// (framework.policy). Blocked results are refused with a clean message.
//
// This is a safety net, not a replacement for the operator's own responsibility
// to only wire APIs they are allowed to use.
// =============================================================================

const { ERROR_CODES, ExecuteAfterError } = require('./errors');

// Terms are matched on a normalised copy of the text so spacing tricks such as
// "x x x" or "p-o-r-n" cannot slip through.
function normalizeForMatch(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function compilePolicy(policy = {}) {
  const terms = (Array.isArray(policy.blockedTerms) ? policy.blockedTerms : [])
    .map((term) => normalizeForMatch(term))
    .filter(Boolean);
  const hosts = (Array.isArray(policy.blockedHostPatterns) ? policy.blockedHostPatterns : [])
    .map((pattern) => String(pattern || '').trim().toLowerCase())
    .filter(Boolean);
  return {
    enforce: policy.enforce !== false,
    terms,
    hosts,
    // Compact form without separators ("p0rn"-style spacing is caught too).
    compactTerms: terms.map((term) => term.replace(/\s+/g, ''))
  };
}

function hostOf(value) {
  try {
    return new URL(String(value)).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function findViolation({ title = '', description = '', url = '' } = {}, compiled) {
  if (!compiled?.enforce) return '';
  const text = normalizeForMatch(`${title} ${description}`);
  const compact = text.replace(/\s+/g, '');
  for (let index = 0; index < compiled.terms.length; index += 1) {
    const term = compiled.terms[index];
    if (!term) continue;
    if (new RegExp(`(?:^|\\s)${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`).test(text)) return term;
    const compactTerm = compiled.compactTerms[index];
    if (compactTerm.length >= 4 && compact.includes(compactTerm)) return compactTerm;
  }
  const host = hostOf(url);
  if (host) {
    for (const pattern of compiled.hosts) {
      if (host === pattern || host.endsWith(`.${pattern}`) || (pattern.startsWith('*') && host.endsWith(pattern.slice(1)))) return pattern;
      if (pattern.includes('*') && new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(host)) return pattern;
    }
  }
  return '';
}

function assertAllowed(candidate, compiled, { provider = '', mode = '' } = {}) {
  const violation = findViolation(candidate, compiled);
  if (!violation) return true;
  throw new ExecuteAfterError(ERROR_CODES.POLICY_BLOCKED, {
    provider,
    mode,
    technical: `policy match "${violation}" in "${String(candidate?.title || candidate?.url || '').slice(0, 120)}"`
  });
}

module.exports = { assertAllowed, compilePolicy, findViolation, hostOf, normalizeForMatch };
