'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  FALLBACK_THEME_ID,
  ROTATION_INTERVAL_MS,
  THEMES,
  getTheme,
  isThemeId,
  listThemes,
  resolveTheme
} = require('../system/theme');

// The artwork URLs exactly as supplied by the project owner. These lists are
// the contract: each character owns its own uploads and nothing else.
const EXPECTED_IDS = ['makima', 'nami', 'nezuko', 'shinobu', 'gojo', 'sukuna', 'asta'];

const EXPECTED_IMAGES = {
  makima: [
    'https://files.catbox.moe/k93ipz.jpg',
    'https://files.catbox.moe/2a0sf6.jpg',
    'https://files.catbox.moe/r2c9j4.jpg',
    'https://files.catbox.moe/2f5y52.jpg',
    'https://files.catbox.moe/q42vuu.jpg'
  ],
  nami: [
    'https://files.catbox.moe/lh0255.jpg',
    'https://files.catbox.moe/8yp9zw.jpg',
    'https://files.catbox.moe/y84zug.jpg',
    'https://files.catbox.moe/gijddp.jpg',
    'https://files.catbox.moe/rakgm1.jpg',
    'https://files.catbox.moe/vjdgrb.jpg'
  ],
  nezuko: [
    'https://files.catbox.moe/2sk71g.jpg',
    'https://files.catbox.moe/kiawc9.jpg',
    'https://files.catbox.moe/ats9kj.jpg',
    'https://files.catbox.moe/yia51b.jpg',
    'https://files.catbox.moe/8dwfla.jpg'
  ],
  shinobu: [
    'https://files.catbox.moe/3gra92.jpg',
    'https://files.catbox.moe/grmrgx.jpg',
    'https://files.catbox.moe/xo2isd.jpg',
    'https://files.catbox.moe/5aiiwz.jpg',
    'https://files.catbox.moe/pqjpne.jpg',
    'https://files.catbox.moe/9h9xko.jpg'
  ],
  gojo: [
    'https://files.catbox.moe/lar8xz.jpg',
    'https://files.catbox.moe/pfpc8n.jpg',
    'https://files.catbox.moe/bcfvml.jpg',
    'https://files.catbox.moe/990bux.jpg',
    'https://files.catbox.moe/88yu96.jpg',
    'https://files.catbox.moe/06ktid.jpg',
    'https://files.catbox.moe/baa82q.jpg',
    'https://files.catbox.moe/4s37uh.jpg'
  ],
  sukuna: [
    'https://files.catbox.moe/czb4r4.jpg',
    'https://files.catbox.moe/98qe3k.jpg',
    'https://files.catbox.moe/9yzxe3.jpg',
    'https://files.catbox.moe/3sumdu.jpg',
    'https://files.catbox.moe/kmk86n.jpg',
    'https://files.catbox.moe/qn19a3.jpg',
    'https://files.catbox.moe/hz9hpf.jpg',
    'https://files.catbox.moe/51skq5.jpg',
    'https://files.catbox.moe/dbvmyk.jpg'
  ],
  asta: [
    'https://files.catbox.moe/c992om.jpg',
    'https://files.catbox.moe/qpgevn.jpg',
    'https://files.catbox.moe/lkz69j.jpg',
    'https://files.catbox.moe/5du0vl.jpg',
    'https://files.catbox.moe/ajblon.jpg',
    'https://files.catbox.moe/w4jash.jpg',
    'https://files.catbox.moe/55xjag.jpg',
    'https://files.catbox.moe/wvp7hp.jpg',
    'https://files.catbox.moe/j2y8tv.jpg',
    'https://files.catbox.moe/k1tt2o.jpg'
  ]
};

const REQUIRED_COLOR_KEYS = [
  'primary',
  'accent',
  'background',
  'surface',
  'surfaceHover',
  'border',
  'text',
  'textMuted',
  'glow',
  'accentGlow',
  'gradient',
  'overlay',
  'pairingGlow'
];

test('exactly the seven anime themes are published, in order', () => {
  assert.deepEqual(listThemes().map((theme) => theme.id), EXPECTED_IDS);
  assert.equal(THEMES.length, 7);
});

test('no generic default theme is exposed to the user', () => {
  const generic = THEMES.filter((theme) => /default|generic|neutral|plain/i.test(`${theme.id} ${theme.name}`));
  assert.deepEqual(generic, []);
  assert.equal(isThemeId('default'), false);
  assert.equal(getTheme('default'), undefined);
});

test('the internal fallback resolves to a real, selectable anime theme', () => {
  assert.equal(isThemeId(FALLBACK_THEME_ID), true);
  assert.equal(resolveTheme('default').id, FALLBACK_THEME_ID);
  assert.equal(resolveTheme(undefined).id, FALLBACK_THEME_ID);
  assert.equal(resolveTheme('sukuna').id, 'sukuna');
});

test('every theme owns only its own hosted artwork', () => {
  for (const theme of THEMES) {
    assert.deepEqual([...theme.images], EXPECTED_IMAGES[theme.id], `${theme.id} artwork drifted`);
    assert.equal(new Set(theme.images).size, theme.images.length, `${theme.id} has duplicate artwork`);
  }

  // No character may borrow another character's upload.
  for (const theme of THEMES) {
    for (const other of THEMES) {
      if (other.id === theme.id) continue;
      const shared = theme.images.filter((url) => other.images.includes(url));
      assert.deepEqual(shared, [], `${theme.id} shares artwork with ${other.id}`);
    }
  }
});

test('artwork uses only the supplied untouched catbox links', () => {
  for (const theme of THEMES) {
    for (const url of theme.images) {
      assert.match(url, /^https:\/\/files\.catbox\.moe\/[a-z0-9]+\.jpg$/, `${theme.id} uses an unexpected URL: ${url}`);
    }
  }
});

test('background rotation is a five second interval', () => {
  assert.equal(ROTATION_INTERVAL_MS, 5_000);
});

test('each theme carries a complete, distinct visual identity', () => {
  const behaviors = new Set();
  const animations = new Set();

  for (const theme of THEMES) {
    for (const key of REQUIRED_COLOR_KEYS) {
      assert.ok(theme.colors[key], `${theme.id} is missing colors.${key}`);
    }
    assert.ok(theme.animation.className.startsWith('anim-'), `${theme.id} animation class`);
    assert.ok(theme.animation.id, `${theme.id} animation id`);
    assert.ok(theme.particles.behavior, `${theme.id} particle behavior`);
    assert.ok(theme.particles.colors.length >= 2, `${theme.id} needs a two colour particle palette`);
    assert.ok(theme.particles.mobileCount < theme.particles.desktopCount, `${theme.id} mobile particle budget`);
    assert.ok(theme.character && theme.series && theme.tagline && theme.quote, `${theme.id} metadata`);

    behaviors.add(theme.particles.behavior);
    animations.add(theme.animation.className);
  }

  // Theme-specific motion rather than one shared animation.
  assert.equal(behaviors.size, THEMES.length);
  assert.equal(animations.size, THEMES.length);

  assert.equal(getTheme('gojo').particles.behavior, 'cosmic');
  assert.equal(getTheme('sukuna').particles.behavior, 'ember');
  assert.equal(getTheme('asta').particles.behavior, 'blade');
  assert.equal(getTheme('nami').particles.behavior, 'wave');
  assert.equal(getTheme('nezuko').particles.behavior, 'float');
  assert.equal(getTheme('shinobu').particles.behavior, 'flutter');
  assert.equal(getTheme('makima').particles.behavior, 'dust');
});
