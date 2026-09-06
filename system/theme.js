'use strict';

// Themes are presentation-only metadata. They must never influence the bot's
// identity, authorization, command access, or external media downloads.
const DEFAULT_THEME = Object.freeze({
  id: 'default',
  name: 'Default',
  displayName: undefined,
  icon: undefined,
  character: undefined,
  tagline: 'The original GOATVERSE MD experience.',
  colors: Object.freeze({}),
  branding: Object.freeze({})
});

const GOJO_THEME = Object.freeze({
  id: 'gojo',
  name: 'Gojo',
  displayName: 'Gojo Theme',
  vibe: 'Limitless Aura',
  icon: '⚡',
  character: 'Satoru Gojo',
  tagline: 'Limitless style & effortless dominance for GOATVERSE MD.',
  personality: 'Calm, playful, stylish, and omnipotent with limitless blue/violet cursed energy.',
  quote: 'Throughout heaven and earth, I alone am the honored one.',
  image: '/assets/characters/gojo.jpg',
  colors: Object.freeze({
    primary: '#75d9ff',
    accent: '#7c3aed',
    background: '#0a0f24',
    surface: '#121a38',
    surfaceHover: '#1a244c',
    border: '#2a3a6c',
    glow: 'rgba(117, 217, 255, 0.45)',
    accentGlow: 'rgba(124, 58, 237, 0.35)',
    gradient: 'linear-gradient(135deg, #0a0f24 0%, #15103a 50%, #0d1a3a 100%)'
  }),
  branding: Object.freeze({ series: 'Jujutsu Kaisen', role: 'The Strongest Sorcerer' })
});

const MAKIMA_THEME = Object.freeze({
  id: 'makima',
  name: 'Makima',
  displayName: 'Makima Theme',
  vibe: 'Control Aura',
  icon: '👁️',
  character: 'Makima',
  tagline: 'Hypnotic authority, crimson thread resonance, and absolute control.',
  personality: 'Enigmatic, calculating, commanding, and hypnotic with golden spiral eyes and blood-red thread pulses.',
  quote: 'I like humans. In the same way that humans are fond of dogs.',
  image: '/assets/characters/makima.jpg',
  colors: Object.freeze({
    primary: '#f59e0b',
    accent: '#e11d48',
    background: '#0e0a12',
    surface: '#18101f',
    surfaceHover: '#261730',
    border: '#3e1e48',
    glow: 'rgba(245, 158, 11, 0.45)',
    accentGlow: 'rgba(225, 29, 72, 0.4)',
    gradient: 'linear-gradient(135deg, #0e0a12 0%, #1c0e22 50%, #120716 100%)'
  }),
  branding: Object.freeze({ series: 'Chainsaw Man', role: 'Public Safety Special Division 4' })
});

const SUKUNA_THEME = Object.freeze({
  id: 'sukuna',
  name: 'Sukuna',
  displayName: 'Sukuna Theme',
  vibe: 'Cursed King',
  icon: '🩸',
  character: 'Ryomen Sukuna',
  tagline: 'Malevolent shrine dominance and raw cursed authority.',
  personality: 'Aggressive, dangerous, sinister, and regal with ferocious blood-red cursed flames.',
  quote: 'Stand proud. You are strong.',
  image: '/assets/characters/sukuna.jpg',
  colors: Object.freeze({
    primary: '#f87171',
    accent: '#dc2626',
    background: '#120508',
    surface: '#1c0a0e',
    surfaceHover: '#2a1017',
    border: '#451820',
    glow: 'rgba(248, 113, 113, 0.4)',
    accentGlow: 'rgba(220, 38, 38, 0.45)',
    gradient: 'linear-gradient(135deg, #120508 0%, #200910 50%, #170408 100%)'
  }),
  branding: Object.freeze({ series: 'Jujutsu Kaisen', role: 'King of Curses' })
});

const ASTA_THEME = Object.freeze({
  id: 'asta',
  name: 'Asta',
  displayName: 'Asta Theme',
  vibe: 'Never Give Up',
  icon: '⚔️',
  character: 'Asta',
  tagline: 'Never give up! Unstoppable anti-magic energy and willpower.',
  personality: 'Energetic, fierce, hard-working, and resilient with demon-slayer emerald force.',
  quote: 'My magic is never giving up!',
  image: '/assets/characters/asta.jpg',
  colors: Object.freeze({
    primary: '#4ade80',
    accent: '#16a34a',
    background: '#07120a',
    surface: '#0f2014',
    surfaceHover: '#162e1e',
    border: '#1f4329',
    glow: 'rgba(74, 222, 128, 0.35)',
    accentGlow: 'rgba(22, 163, 74, 0.35)',
    gradient: 'linear-gradient(135deg, #07120a 0%, #0c1e11 50%, #06150b 100%)'
  }),
  branding: Object.freeze({ series: 'Black Clover', role: 'Black Bull Magic Knight' })
});

const NAMI_THEME = Object.freeze({
  id: 'nami',
  name: 'Nami',
  displayName: 'Nami Theme',
  vibe: 'Navigator',
  icon: '🧭',
  character: 'Nami',
  tagline: 'Clever navigation, stylish breezes, and golden oceanic treasures.',
  personality: 'Smart, confident, stylish, and adventurous with radiant clima-tact gusts and azure currents.',
  quote: 'What good is having hope if you don’t have the courage to reach for it?',
  image: '/assets/characters/nami.jpg',
  colors: Object.freeze({
    primary: '#fb923c',
    accent: '#0284c7',
    background: '#081320',
    surface: '#0e1e33',
    surfaceHover: '#142944',
    border: '#1f3c63',
    glow: 'rgba(251, 146, 60, 0.4)',
    accentGlow: 'rgba(2, 132, 199, 0.4)',
    gradient: 'linear-gradient(135deg, #081320 0%, #0b1f35 50%, #07192c 100%)'
  }),
  branding: Object.freeze({ series: 'One Piece', role: 'Straw Hat Navigator' })
});

const NEZUKO_THEME = Object.freeze({
  id: 'nezuko',
  name: 'Nezuko',
  displayName: 'Nezuko Theme',
  vibe: 'Demonic Bloom',
  icon: '🌸',
  character: 'Nezuko Kamado',
  tagline: 'Gentle heart, fierce protection, and blossoming pink demonic flames.',
  personality: 'Protective, gentle yet fiercely resilient with soft glowing sakura embers and bamboo aesthetic.',
  quote: 'Humans are to be protected and saved... I will never hurt them.',
  image: '/assets/characters/nezuko.jpg',
  colors: Object.freeze({
    primary: '#f472b6',
    accent: '#e11d48',
    background: '#14080e',
    surface: '#200e18',
    surfaceHover: '#2e1424',
    border: '#4a1d36',
    glow: 'rgba(244, 114, 182, 0.45)',
    accentGlow: 'rgba(225, 29, 72, 0.4)',
    gradient: 'linear-gradient(135deg, #14080e 0%, #240c1a 50%, #160710 100%)'
  }),
  branding: Object.freeze({ series: 'Demon Slayer', role: 'Demon Sister of Tanjiro' })
});

const SHINOBU_THEME = Object.freeze({
  id: 'shinobu',
  name: 'Shinobu',
  displayName: 'Shinobu Theme',
  vibe: 'Insect Hashira',
  icon: '🦋',
  character: 'Shinobu Kocho',
  tagline: 'Graceful butterfly flutter, lethal precision, and lavender wisteria elegance.',
  personality: 'Graceful, witty, tactical, and ethereal with shimmering butterfly wings and luminous lavender poison mist.',
  quote: 'I may be the only swordsperson who cannot cut a demon’s head off, but I can poison them.',
  image: '/assets/characters/shinobu.jpg',
  colors: Object.freeze({
    primary: '#c084fc',
    accent: '#9333ea',
    background: '#0d0718',
    surface: '#170f28',
    surfaceHover: '#23173c',
    border: '#3c245c',
    glow: 'rgba(192, 132, 252, 0.45)',
    accentGlow: 'rgba(147, 51, 234, 0.4)',
    gradient: 'linear-gradient(135deg, #0d0718 0%, #1b0f33 50%, #100820 100%)'
  }),
  branding: Object.freeze({ series: 'Demon Slayer', role: 'Insect Hashira' })
});

const THEMES = Object.freeze({
  default: DEFAULT_THEME,
  gojo: GOJO_THEME,
  sukuna: SUKUNA_THEME,
  asta: ASTA_THEME,
  nami: NAMI_THEME,
  nezuko: NEZUKO_THEME,
  shinobu: SHINOBU_THEME,
  makima: MAKIMA_THEME
});

function normalizeThemeId(themeId) {
  return String(themeId || DEFAULT_THEME.id).trim().toLowerCase();
}

function getActiveTheme(themeId) {
  return THEMES[normalizeThemeId(themeId)] || DEFAULT_THEME;
}

function listThemes() {
  return Object.values(THEMES);
}

function formatBrandHeader(botName, theme) {
  return [botName, theme?.displayName ? `${theme.icon ? `${theme.icon} ` : ''}${theme.displayName}` : undefined]
    .filter(Boolean)
    .join('\n');
}

function formatThemeSummary(theme) {
  const activeTheme = theme || DEFAULT_THEME;
  const label = activeTheme.displayName || activeTheme.name;
  return [
    `${activeTheme.icon ? `${activeTheme.icon} ` : ''}${label}`,
    activeTheme.character ? `Character: ${activeTheme.character}` : undefined,
    activeTheme.branding?.series ? `Series: ${activeTheme.branding.series}` : undefined,
    activeTheme.tagline
  ].filter(Boolean).join('\n');
}

module.exports = {
  DEFAULT_THEME,
  GOJO_THEME,
  MAKIMA_THEME,
  SUKUNA_THEME,
  ASTA_THEME,
  NAMI_THEME,
  NEZUKO_THEME,
  SHINOBU_THEME,
  THEMES,
  formatBrandHeader,
  formatThemeSummary,
  getActiveTheme,
  listThemes,
  normalizeThemeId
};
