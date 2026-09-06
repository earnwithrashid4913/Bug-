'use strict';

// Theme definitions are intentionally data-only. Future visual modes can add an
// id, displayName, icon, colors, banner, images, and optional branding here
// without changing authorization or the GOATVERSE MD master identity.
const DEFAULT_THEME = Object.freeze({
  id: 'default',
  name: 'Default',
  displayName: undefined,
  icon: undefined,
  colors: Object.freeze({}),
  banner: undefined,
  images: Object.freeze({}),
  branding: Object.freeze({})
});

// Future modes belong here as reviewed data definitions. Theme IDs never replace
// the master GOATVERSE MD name and never participate in authorization.
const THEMES = Object.freeze({ default: DEFAULT_THEME });

function getActiveTheme(themeId) {
  const id = String(themeId || DEFAULT_THEME.id).trim().toLowerCase();
  return THEMES[id] || DEFAULT_THEME;
}

function formatBrandHeader(botName, theme) {
  return [botName, theme?.displayName ? `${theme.icon ? `${theme.icon} ` : ''}${theme.displayName}` : undefined]
    .filter(Boolean)
    .join('\n');
}

module.exports = { DEFAULT_THEME, THEMES, formatBrandHeader, getActiveTheme };
