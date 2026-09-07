'use strict';

// The dashboard has no build step and no browser in CI, so these checks keep the
// three static files honest: every element the script touches exists, every CSS
// variable is actually provided by the theme registry, every theme has its own
// animation block, and no removed UI (QR, country selector) sneaks back in.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { PUBLIC_DIR } = require('../system/web');
const { THEMES } = require('../system/theme');
const { CANONICAL_IDENTITY } = require('../system/security');

const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
const script = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8');
const styles = fs.readFileSync(path.join(PUBLIC_DIR, 'styles.css'), 'utf8');

function referencedElementIds() {
  const ids = new Set();

  const list = script.match(/const ids = \[([\s\S]*?)\];/);
  assert.ok(list, 'app.js must declare the element id list');
  for (const match of list[1].matchAll(/'([^']+)'/g)) ids.add(match[1]);

  for (const match of script.matchAll(/getElementById\('([^']+)'\)/g)) ids.add(match[1]);

  return [...ids];
}

test('every element the dashboard script queries exists in the markup', () => {
  const declared = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
  const referenced = referencedElementIds();

  assert.ok(referenced.length >= 25, `expected a full id list, found ${referenced.length}`);
  assert.deepEqual(referenced.filter((id) => !declared.has(id)), []);

  assert.ok(declared.has('steps'));
  assert.match(html, /id="pairingCard"/);
});

test('every CSS variable used by the stylesheet is provided', () => {
  const defined = new Set();
  for (const match of styles.matchAll(/(--[a-z0-9-]+)\s*:/g)) defined.add(match[1]);
  for (const match of script.matchAll(/'(--[a-z0-9-]+)'/g)) defined.add(match[1]);

  const used = new Set([...styles.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1]));
  const missing = [...used].filter((name) => !defined.has(name));

  assert.deepEqual(missing, []);

  // The palette the browser applies must come from the registry mapping.
  for (const name of ['--primary', '--accent', '--bg', '--glow', '--accent-glow', '--pairing-glow', '--gradient', '--overlay']) {
    assert.ok(used.has(name) || defined.has(name), `${name} is never used`);
    assert.ok(script.includes(`'${name}'`), `${name} is never set from the theme registry`);
  }
});

test('each theme has its own animation block in the stylesheet', () => {
  for (const theme of THEMES) {
    assert.match(styles, new RegExp(`\\[data-theme="${theme.id}"\\] \\.bg-slide\\.is-active img`), `${theme.id} artwork motion`);
    assert.match(styles, new RegExp(`\\[data-theme="${theme.id}"\\] \\.bg-glow`), `${theme.id} glow motion`);
    assert.match(script, new RegExp(`case '${theme.particles.behavior}':|default:`), `${theme.id} particle behavior handled`);
  }

  const keyframes = new Set([...styles.matchAll(/@keyframes ([a-z-]+)/g)].map((match) => match[1]));
  assert.ok(keyframes.size >= 12, `expected per-theme keyframes, found ${keyframes.size}`);
});

test('particle behaviours used by the registry are all implemented', () => {
  const implemented = new Set([...script.matchAll(/case '([a-z]+)':/g)].map((match) => match[1]));
  for (const theme of THEMES) {
    if (theme.particles.behavior === 'dust') continue; // explicit default branch
    assert.ok(implemented.has(theme.particles.behavior), `${theme.particles.behavior} is not implemented`);
  }
});

test('web pairing is the only connection method offered', () => {
  assert.doesNotMatch(html, /<select/i, 'no dropdowns in the pairing flow');
  assert.doesNotMatch(html, /<option/i, 'no country options');
  assert.doesNotMatch(html, /country[- _]?(selector|picker|dropdown|list|input)/i, 'no country selector');
  assert.doesNotMatch(html, /\bQR\b/i, 'no QR pairing UI');
  assert.match(html, /Enter your WhatsApp number with country code, without \+\./);
  assert.match(html, new RegExp(`Developed By: ${CANONICAL_IDENTITY.organization}`));
  assert.match(html, /type="tel"/);
  assert.match(html, /inputmode="numeric"/);
});

test('referenced assets exist and no inline styles or scripts are used', () => {
  for (const asset of ['/styles.css', '/app.js', '/favicon.svg']) {
    assert.ok(fs.existsSync(path.join(PUBLIC_DIR, asset.slice(1))), `${asset} is missing`);
    assert.ok(html.includes(`href="${asset}"`) || html.includes(`src="${asset}"`), `${asset} is not linked`);
  }

  assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)/i, 'inline scripts break the CSP');
  assert.doesNotMatch(html, /<style/i, 'inline styles break the CSP');
  assert.doesNotMatch(html, /\sstyle="/i, 'style attributes break the CSP');
  assert.match(html, /rel="preconnect" href="https:\/\/files\.catbox\.moe"/);
  assert.match(html, /<meta name="viewport"/);
});

test('rotation is disabled in the current build', () => {
  assert.doesNotMatch(script, /setInterval\(tick/);
  assert.doesNotMatch(script, /startRotation\(\)/);
});

test('responsive rules cover phone, tablet and desktop widths', () => {
  assert.match(styles, /@media \(max-width: 900px\)/);
  assert.match(styles, /@media \(max-width: 560px\)/);
  assert.match(styles, /@media \(max-width: 360px\)/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(styles, /overflow-x: hidden/);
  assert.match(styles, /grid-template-columns: minmax\(0, 1\.15fr\) minmax\(0, 400px\)/);
});
