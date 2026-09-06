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
  icon: '⚡',
  character: 'Satoru Gojo',
  tagline: 'Limitless style for your GOATVERSE MD menus.',
  colors: Object.freeze({ primary: '#75d9ff', accent: '#7c3aed', background: '#10172d' }),
  branding: Object.freeze({ series: 'Jujutsu Kaisen' })
});

const KAKASHI_THEME = Object.freeze({
  id: 'kakashi',
  name: 'Kakashi',
  displayName: 'Kakashi Theme',
  icon: '🍃',
  character: 'Kakashi Hatake',
  tagline: 'Calm, tactical styling for your GOATVERSE MD menus.',
  colors: Object.freeze({ primary: '#94a3b8', accent: '#ef4444', background: '#172033' }),
  branding: Object.freeze({ series: 'Naruto' })
});

const THEMES = Object.freeze({
  default: DEFAULT_THEME,
  gojo: GOJO_THEME,
  kakashi: KAKASHI_THEME
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
  KAKASHI_THEME,
  THEMES,
  formatBrandHeader,
  formatThemeSummary,
  getActiveTheme,
  listThemes,
  normalizeThemeId
};
