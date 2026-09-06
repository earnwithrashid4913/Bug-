'use strict';

// ---------------------------------------------------------------------------
// Centralized theme configuration — the single source of truth.
//
// Every theme owns its own character images, palette, gradients, glow,
// particles and animation profile. Nothing else in the project is allowed to
// hard-code theme values: the web server serializes this registry and the
// browser applies it through CSS custom properties.
//
// Presentation only. Themes must never influence bot identity, authorization,
// command access, or which media the bot downloads.
// ---------------------------------------------------------------------------

// Images rotate on a single controlled timer in the browser.
const ROTATION_INTERVAL_MS = 5_000;

// Hosted artwork. These URLs are supplied by the project owner and are used
// verbatim: never rewritten, proxied, or replaced with generated links.
const CATBOX = 'https://files.catbox.moe';

function catbox(...slugs) {
  // De-duplicates while preserving order so a repeated upload cannot produce a
  // visible "no change" frame during rotation.
  return Object.freeze([...new Set(slugs.map((slug) => `${CATBOX}/${slug}.jpg`))]);
}

const MAKIMA = Object.freeze({
  id: 'makima',
  name: 'Makima',
  character: 'Makima',
  series: 'Chainsaw Man',
  icon: '🩸',
  vibe: 'Control Aura',
  tagline: 'Cinematic authority wrapped in a quiet crimson thread.',
  quote: 'I like humans. In the same way that humans are fond of dogs.',
  images: catbox('k93ipz', '2a0sf6', 'r2c9j4', '2f5y52', 'q42vuu'),
  colors: Object.freeze({
    primary: '#ff5a5f',
    accent: '#8f1d24',
    background: '#0a0407',
    surface: 'rgba(24, 10, 14, 0.72)',
    surfaceHover: 'rgba(40, 16, 21, 0.82)',
    border: 'rgba(255, 90, 95, 0.22)',
    text: '#fdecee',
    textMuted: '#c69ea4',
    glow: 'rgba(255, 90, 95, 0.35)',
    accentGlow: 'rgba(143, 29, 36, 0.45)',
    gradient: 'linear-gradient(140deg, rgba(10, 4, 7, 0.94) 0%, rgba(38, 8, 14, 0.88) 45%, rgba(8, 3, 5, 0.96) 100%)',
    overlay: 'linear-gradient(180deg, rgba(6, 2, 4, 0.55) 0%, rgba(6, 2, 4, 0.82) 60%, rgba(6, 2, 4, 0.95) 100%)',
    pairingGlow: '0 0 0 1px rgba(255, 90, 95, 0.18), 0 24px 70px -24px rgba(255, 90, 95, 0.45)'
  }),
  animation: Object.freeze({ id: 'aura-control', className: 'anim-makima', duration: '16s' }),
  particles: Object.freeze({
    behavior: 'dust',
    shape: 'mote',
    colors: ['#ff5a5f', '#c9383d', '#7c1a20'],
    desktopCount: 46,
    mobileCount: 20,
    speed: 0.16,
    size: [1, 2.6],
    opacity: 0.42,
    glow: 8
  })
});

const NAMI = Object.freeze({
  id: 'nami',
  name: 'Nami',
  character: 'Nami',
  series: 'One Piece',
  icon: '🌊',
  vibe: 'Navigator',
  tagline: 'Ocean breeze, amber horizon, and a chart for every storm.',
  quote: 'I love money and tangerines, in that order.',
  images: catbox('lh0255', '8yp9zw', 'y84zug', 'gijddp', 'rakgm1', 'vjdgrb'),
  colors: Object.freeze({
    primary: '#4cc9f0',
    accent: '#f6b73c',
    background: '#03131d',
    surface: 'rgba(8, 30, 44, 0.7)',
    surfaceHover: 'rgba(13, 44, 62, 0.82)',
    border: 'rgba(76, 201, 240, 0.24)',
    text: '#eaf7fd',
    textMuted: '#9dc0d1',
    glow: 'rgba(76, 201, 240, 0.34)',
    accentGlow: 'rgba(246, 183, 60, 0.34)',
    gradient: 'linear-gradient(140deg, rgba(3, 19, 29, 0.93) 0%, rgba(6, 40, 58, 0.86) 48%, rgba(30, 20, 6, 0.9) 100%)',
    overlay: 'linear-gradient(180deg, rgba(2, 12, 20, 0.5) 0%, rgba(2, 12, 20, 0.8) 60%, rgba(2, 12, 20, 0.94) 100%)',
    pairingGlow: '0 0 0 1px rgba(76, 201, 240, 0.2), 0 24px 70px -24px rgba(76, 201, 240, 0.45)'
  }),
  animation: Object.freeze({ id: 'ocean-flow', className: 'anim-nami', duration: '18s' }),
  particles: Object.freeze({
    behavior: 'wave',
    shape: 'droplet',
    colors: ['#4cc9f0', '#8ce0ff', '#f6b73c'],
    desktopCount: 54,
    mobileCount: 24,
    speed: 0.42,
    size: [1, 3],
    opacity: 0.5,
    glow: 12
  })
});

const NEZUKO = Object.freeze({
  id: 'nezuko',
  name: 'Nezuko',
  character: 'Nezuko Kamado',
  series: 'Demon Slayer',
  icon: '🌸',
  vibe: 'Demon Aura',
  tagline: 'A gentle demon heart glowing through soft crimson petals.',
  quote: 'Even as a demon, I will protect humans.',
  images: catbox('2sk71g', 'kiawc9', 'ats9kj', 'yia51b', '8dwfla'),
  colors: Object.freeze({
    primary: '#ff8fc0',
    accent: '#e11d48',
    background: '#150610',
    surface: 'rgba(40, 12, 28, 0.7)',
    surfaceHover: 'rgba(58, 18, 40, 0.82)',
    border: 'rgba(255, 143, 192, 0.24)',
    text: '#fdeef6',
    textMuted: '#d3a2bb',
    glow: 'rgba(255, 143, 192, 0.36)',
    accentGlow: 'rgba(225, 29, 72, 0.4)',
    gradient: 'linear-gradient(140deg, rgba(21, 6, 16, 0.93) 0%, rgba(52, 12, 34, 0.86) 50%, rgba(24, 5, 12, 0.95) 100%)',
    overlay: 'linear-gradient(180deg, rgba(14, 4, 10, 0.5) 0%, rgba(14, 4, 10, 0.8) 60%, rgba(14, 4, 10, 0.94) 100%)',
    pairingGlow: '0 0 0 1px rgba(255, 143, 192, 0.2), 0 24px 70px -24px rgba(255, 143, 192, 0.45)'
  }),
  animation: Object.freeze({ id: 'soft-aura', className: 'anim-nezuko', duration: '15s' }),
  particles: Object.freeze({
    behavior: 'float',
    shape: 'petal',
    colors: ['#ff8fc0', '#ffc2dc', '#e11d48'],
    desktopCount: 40,
    mobileCount: 18,
    speed: 0.22,
    size: [1.4, 3.4],
    opacity: 0.55,
    glow: 16
  })
});

const SHINOBU = Object.freeze({
  id: 'shinobu',
  name: 'Shinobu',
  character: 'Shinobu Kocho',
  series: 'Demon Slayer',
  icon: '🦋',
  vibe: 'Insect Hashira',
  tagline: 'Butterfly silence carrying an elegant, venomous grace.',
  quote: 'I am the only Hashira who cannot cut off a demon\'s head.',
  images: catbox('3gra92', 'grmrgx', 'xo2isd', '5aiiwz', 'pqjpne', '9h9xko'),
  colors: Object.freeze({
    primary: '#a78bfa',
    accent: '#e9d5ff',
    background: '#0c0718',
    surface: 'rgba(28, 18, 52, 0.7)',
    surfaceHover: 'rgba(42, 27, 74, 0.82)',
    border: 'rgba(167, 139, 250, 0.24)',
    text: '#f3eefe',
    textMuted: '#b7a7d6',
    glow: 'rgba(167, 139, 250, 0.36)',
    accentGlow: 'rgba(233, 213, 255, 0.28)',
    gradient: 'linear-gradient(140deg, rgba(12, 7, 24, 0.93) 0%, rgba(34, 20, 64, 0.86) 50%, rgba(10, 6, 20, 0.95) 100%)',
    overlay: 'linear-gradient(180deg, rgba(8, 4, 16, 0.5) 0%, rgba(8, 4, 16, 0.8) 60%, rgba(8, 4, 16, 0.94) 100%)',
    pairingGlow: '0 0 0 1px rgba(167, 139, 250, 0.2), 0 24px 70px -24px rgba(167, 139, 250, 0.48)'
  }),
  animation: Object.freeze({ id: 'butterfly-drift', className: 'anim-shinobu', duration: '17s' }),
  particles: Object.freeze({
    behavior: 'flutter',
    shape: 'butterfly',
    colors: ['#c4b5fd', '#e9d5ff', '#8b5cf6'],
    desktopCount: 26,
    mobileCount: 12,
    speed: 0.3,
    size: [3, 6.5],
    opacity: 0.6,
    glow: 14
  })
});

const GOJO = Object.freeze({
  id: 'gojo',
  name: 'Gojo',
  character: 'Satoru Gojo',
  series: 'Jujutsu Kaisen',
  icon: '♾️',
  vibe: 'Limitless',
  tagline: 'Limitless energy bending infinity into calm violet light.',
  quote: 'Throughout heaven and earth, I alone am the honored one.',
  images: catbox('lar8xz', 'pfpc8n', 'bcfvml', '990bux', '88yu96', '06ktid', 'baa82q', '4s37uh'),
  colors: Object.freeze({
    primary: '#5fd3ff',
    accent: '#8b5cf6',
    background: '#05060f',
    surface: 'rgba(14, 20, 46, 0.7)',
    surfaceHover: 'rgba(22, 30, 66, 0.82)',
    border: 'rgba(95, 211, 255, 0.24)',
    text: '#eef6ff',
    textMuted: '#a3b6d6',
    glow: 'rgba(95, 211, 255, 0.4)',
    accentGlow: 'rgba(139, 92, 246, 0.42)',
    gradient: 'linear-gradient(140deg, rgba(5, 6, 15, 0.92) 0%, rgba(16, 22, 58, 0.85) 45%, rgba(30, 12, 62, 0.92) 100%)',
    overlay: 'linear-gradient(180deg, rgba(3, 4, 12, 0.5) 0%, rgba(3, 4, 12, 0.8) 60%, rgba(3, 4, 12, 0.94) 100%)',
    pairingGlow: '0 0 0 1px rgba(95, 211, 255, 0.22), 0 24px 70px -24px rgba(139, 92, 246, 0.55)'
  }),
  animation: Object.freeze({ id: 'cosmic-limitless', className: 'anim-gojo', duration: '14s' }),
  particles: Object.freeze({
    behavior: 'cosmic',
    shape: 'orb',
    colors: ['#5fd3ff', '#8b5cf6', '#e0e7ff'],
    desktopCount: 60,
    mobileCount: 26,
    speed: 0.26,
    size: [0.8, 2.8],
    opacity: 0.6,
    glow: 18
  })
});

const SUKUNA = Object.freeze({
  id: 'sukuna',
  name: 'Sukuna',
  character: 'Ryomen Sukuna',
  series: 'Jujutsu Kaisen',
  icon: '🔥',
  vibe: 'King of Curses',
  tagline: 'Cursed flame rising through absolute black.',
  quote: 'Stand proud. You are strong.',
  images: catbox('czb4r4', '98qe3k', '9yzxe3', '3sumdu', 'kmk86n', 'qn19a3', 'hz9hpf', '51skq5', 'dbvmyk'),
  colors: Object.freeze({
    primary: '#ff2e2e',
    accent: '#7f0d0d',
    background: '#080203',
    surface: 'rgba(28, 6, 8, 0.72)',
    surfaceHover: 'rgba(46, 10, 13, 0.84)',
    border: 'rgba(255, 46, 46, 0.22)',
    text: '#ffeceb',
    textMuted: '#c99a98',
    glow: 'rgba(255, 46, 46, 0.38)',
    accentGlow: 'rgba(127, 13, 13, 0.5)',
    gradient: 'linear-gradient(140deg, rgba(8, 2, 3, 0.94) 0%, rgba(40, 6, 9, 0.88) 48%, rgba(6, 1, 2, 0.97) 100%)',
    overlay: 'linear-gradient(180deg, rgba(5, 1, 2, 0.58) 0%, rgba(5, 1, 2, 0.84) 60%, rgba(5, 1, 2, 0.96) 100%)',
    pairingGlow: '0 0 0 1px rgba(255, 46, 46, 0.2), 0 24px 70px -24px rgba(255, 46, 46, 0.5)'
  }),
  animation: Object.freeze({ id: 'cursed-flame', className: 'anim-sukuna', duration: '9s' }),
  particles: Object.freeze({
    behavior: 'ember',
    shape: 'spark',
    colors: ['#ff2e2e', '#ff7a45', '#7f0d0d'],
    desktopCount: 66,
    mobileCount: 28,
    speed: 0.7,
    size: [1, 2.4],
    opacity: 0.62,
    glow: 16
  })
});

const ASTA = Object.freeze({
  id: 'asta',
  name: 'Asta',
  character: 'Asta',
  series: 'Black Clover',
  icon: '⚔️',
  vibe: 'Anti-Magic',
  tagline: 'Anti-magic edge carving emerald energy through the dark.',
  quote: 'My magic is never giving up!',
  images: catbox('c992om', 'qpgevn', 'lkz69j', '5du0vl', 'ajblon', 'w4jash', '55xjag', 'wvp7hp', 'j2y8tv', 'k1tt2o'),
  colors: Object.freeze({
    primary: '#2ee6a8',
    accent: '#0b7a52',
    background: '#04120b',
    surface: 'rgba(8, 32, 22, 0.72)',
    surfaceHover: 'rgba(12, 48, 33, 0.84)',
    border: 'rgba(46, 230, 168, 0.22)',
    text: '#e9fff6',
    textMuted: '#93c7b3',
    glow: 'rgba(46, 230, 168, 0.36)',
    accentGlow: 'rgba(11, 122, 82, 0.46)',
    gradient: 'linear-gradient(140deg, rgba(4, 18, 11, 0.94) 0%, rgba(7, 38, 25, 0.88) 48%, rgba(3, 12, 8, 0.96) 100%)',
    overlay: 'linear-gradient(180deg, rgba(2, 10, 6, 0.55) 0%, rgba(2, 10, 6, 0.82) 60%, rgba(2, 10, 6, 0.95) 100%)',
    pairingGlow: '0 0 0 1px rgba(46, 230, 168, 0.2), 0 24px 70px -24px rgba(46, 230, 168, 0.48)'
  }),
  animation: Object.freeze({ id: 'anti-magic-wave', className: 'anim-asta', duration: '11s' }),
  particles: Object.freeze({
    behavior: 'blade',
    shape: 'shard',
    colors: ['#2ee6a8', '#7dffd0', '#0b7a52'],
    desktopCount: 44,
    mobileCount: 20,
    speed: 0.95,
    size: [1, 3.2],
    opacity: 0.55,
    glow: 14
  })
});

// Order defines the selector order in the dashboard.
const THEMES = Object.freeze([MAKIMA, NAMI, NEZUKO, SHINOBU, GOJO, SUKUNA, ASTA]);

const THEME_MAP = Object.freeze(
  THEMES.reduce((map, theme) => {
    map[theme.id] = theme;
    return map;
  }, {})
);

// Internal, non-selectable safety net. It always resolves to a real anime
// theme so the interface never falls back to a generic look and a generic
// "default" theme is never exposed to the user.
const FALLBACK_THEME_ID = GOJO.id;

function isThemeId(value) {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(THEME_MAP, value);
}

function getTheme(id) {
  return THEME_MAP[id];
}

// Never throws: an unknown or missing id silently resolves to a real theme.
function resolveTheme(id) {
  return THEME_MAP[id] || THEME_MAP[FALLBACK_THEME_ID];
}

function listThemes() {
  return THEMES;
}

module.exports = {
  THEMES,
  THEME_MAP,
  ROTATION_INTERVAL_MS,
  FALLBACK_THEME_ID,
  getTheme,
  isThemeId,
  listThemes,
  resolveTheme
};
