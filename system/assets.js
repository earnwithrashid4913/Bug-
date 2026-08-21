'use strict';

/**
 * Centralized Black Clover asset registry.
 * All 11 uploaded images cataloged and organized by use case.
 * Single source of truth for asset paths, metadata, and usage.
 */

const ASSETS = Object.freeze({
  // ===== HERO/SPLASH TIER (Full-screen primary images) =====
  hero: {
    astaCombatRed: {
      id: 'asta-combat-red',
      path: '/assets/images/01-asta-combat-red.webp',
      fallback: '/assets/images/01-asta-combat-red.jpg',
      alt: 'Asta with red magical energy, combat-ready stance',
      width: 1920,
      height: 1080,
      aspect: '16:9',
      format: 'webp',
      lazy: false,
      uses: ['startup', 'menu', 'main-hero', 'loading'],
      colors: ['red', 'gold', 'white']
    },
    teamBattleEnsemble: {
      id: 'team-battle-ensemble',
      path: '/assets/images/08-team-battle-ensemble.webp',
      fallback: '/assets/images/08-team-battle-ensemble.jpg',
      alt: 'Black Clover team in coordinated battle action',
      width: 1920,
      height: 1080,
      aspect: '16:9',
      format: 'webp',
      lazy: false,
      uses: ['group-success', 'team-achievement', 'alt-hero'],
      colors: ['gold', 'red', 'brown']
    },
    astaSwordPower: {
      id: 'asta-sword-power',
      path: '/assets/images/09-asta-sword-power.webp',
      fallback: '/assets/images/09-asta-sword-power.jpg',
      alt: 'Asta with glowing anti-magic sword, mystical aura',
      width: 1920,
      height: 1080,
      aspect: '16:9',
      format: 'webp',
      lazy: false,
      uses: ['premium-unlock', 'mystical-achievement', 'power-up'],
      colors: ['white', 'gold', 'red']
    }
  },

  // ===== CARD/PROFILE TIER (Fixed-size display cards) =====
  card: {
    astaPowerStance: {
      id: 'asta-power-stance',
      path: '/assets/images/02-asta-power-stance.webp',
      fallback: '/assets/images/02-asta-power-stance.jpg',
      alt: 'Asta in powerful full-body stance, centered composition',
      width: 512,
      height: 512,
      aspect: '1:1',
      format: 'webp',
      lazy: true,
      uses: ['status-card', 'badge', 'profile-picture'],
      colors: ['white', 'red', 'dark']
    },
    astaSwordReady: {
      id: 'asta-sword-ready',
      path: '/assets/images/03-asta-sword-ready.webp',
      fallback: '/assets/images/03-asta-sword-ready.jpg',
      alt: 'Asta with sword ready, determined expression',
      width: 512,
      height: 512,
      aspect: '1:1',
      format: 'webp',
      lazy: true,
      uses: ['command-button', 'admin-card', 'action-card'],
      colors: ['red', 'dark', 'purple']
    },
    liebeDemon: {
      id: 'liebe-demon',
      path: '/assets/images/10-liebe-demon.webp',
      fallback: '/assets/images/10-liebe-demon.jpg',
      alt: 'Liebe demon with white form, red wings, grimoire below',
      width: 512,
      height: 720,
      aspect: '2:3',
      format: 'webp',
      lazy: true,
      uses: ['premium-tier-card', 'alt-persona', 'elite-badge'],
      colors: ['white', 'red', 'black']
    }
  },

  // ===== BACKGROUND/AMBIENT TIER (Info screens, watermark) =====
  background: {
    yunoStudy: {
      id: 'yuno-study',
      path: '/assets/images/04-yuno-study.webp',
      fallback: '/assets/images/04-yuno-study.jpg',
      alt: 'Yuno reading grimoire, knowledge-focused, warm tones',
      width: 1440,
      height: 1080,
      aspect: '4:3',
      format: 'webp',
      lazy: true,
      uses: ['help-screen-bg', 'info-sidebar', 'knowledge-theme'],
      colors: ['warm', 'red', 'brown']
    },
    dualMagicClash: {
      id: 'dual-magic-clash',
      path: '/assets/images/06-dual-magic-clash.webp',
      fallback: '/assets/images/06-dual-magic-clash.jpg',
      alt: 'Dual character magic clash, purple and green energy',
      width: 1920,
      height: 1080,
      aspect: '16:9',
      format: 'webp',
      lazy: true,
      uses: ['comparison-layout', 'split-screen', 'duality-theme'],
      colors: ['purple', 'green', 'gray']
    }
  },

  // ===== ERROR/ALERT TIER (Warnings, denials, urgency) =====
  alert: {
    astaFightText: {
      id: 'asta-fight-text',
      path: '/assets/images/05-asta-fight-text.webp',
      fallback: '/assets/images/05-asta-fight-text.jpg',
      alt: 'Asta close-up with FIGHT text overlay, urgent action',
      width: 1440,
      height: 1080,
      aspect: '4:3',
      format: 'webp',
      lazy: true,
      uses: ['warning-banner', 'action-button', 'urgency-state'],
      colors: ['red', 'white', 'black']
    },
    villainPortrait: {
      id: 'villain-portrait',
      path: '/assets/images/07-villain-portrait.webp',
      fallback: '/assets/images/07-villain-portrait.jpg',
      alt: 'Antagonist with purple magical aura, intense expression',
      width: 1080,
      height: 1080,
      aspect: '1:1',
      format: 'webp',
      lazy: true,
      uses: ['error-modal', 'permission-denied', 'warning-state'],
      colors: ['purple', 'pink', 'dark']
    }
  },

  // ===== DYNAMIC/ANIMATED TIER (Streaming, looping, high-energy) =====
  dynamic: {
    astaMangaCollage: {
      id: 'asta-manga-collage',
      path: '/assets/images/11-asta-manga-collage.webp',
      fallback: '/assets/images/11-asta-manga-collage.jpg',
      alt: 'Asta manga panel collage with purple neon effects',
      width: 1080,
      height: 1920,
      aspect: '9:16',
      format: 'webp',
      lazy: true,
      uses: ['dashboard-bg', 'menu-animation', 'loading-loop', 'high-energy'],
      colors: ['purple', 'white', 'neon']
    }
  }
});

/**
 * Get an asset by ID or full path reference.
 * @param {string} category - Asset category (hero, card, background, alert, dynamic)
 * @param {string} key - Asset key within category
 * @returns {Object|null} Asset metadata or null if not found
 */
function getAsset(category, key) {
  return ASSETS[category]?.[key] || null;
}

/**
 * Get asset by use case.
 * @param {string} useCase - The intended use (e.g., 'startup', 'error-modal', 'status-card')
 * @returns {Array<Object>} Array of matching assets
 */
function getAssetsByUseCase(useCase) {
  const results = [];
  Object.values(ASSETS).forEach(category => {
    Object.values(category).forEach(asset => {
      if (asset.uses?.includes(useCase)) {
        results.push(asset);
      }
    });
  });
  return results;
}

/**
 * Get responsive image srcset for an asset.
 * @param {Object} asset - Asset metadata object
 * @param {Array<number>} sizes - Breakpoint widths (e.g., [640, 1024, 1440, 1920])
 * @returns {string} Srcset string for img tag
 */
function getSrcset(asset, sizes = [640, 1024, 1440, 1920]) {
  if (!asset.path) return '';
  const basePath = asset.path.replace(/\.[^.]+$/, ''); // Remove extension
  const ext = asset.format || 'webp';
  return sizes
    .filter(s => s <= asset.width)
    .map(s => `${basePath}-${s}w.${ext} ${s}w`)
    .join(', ');
}

/**
 * Get lazy-load attribute value.
 * @param {Object} asset - Asset metadata object
 * @returns {string} 'lazy' or 'eager'
 */
function getLazyLoadType(asset) {
  return asset.lazy !== false ? 'lazy' : 'eager';
}

/**
 * Get all assets organized by category.
 * @returns {Object} Full ASSETS object
 */
function getAllAssets() {
  return ASSETS;
}

/**
 * Validate that all asset paths exist (for CI/deployment checks).
 * In a real system, this would check file system or CDN.
 * @returns {Object} Validation report
 */
function validateAssets() {
  const report = {
    total: 0,
    valid: 0,
    missing: [],
    timestamp: new Date().toISOString()
  };

  Object.entries(ASSETS).forEach(([category, assets]) => {
    Object.entries(assets).forEach(([key, asset]) => {
      report.total++;
      // In production, verify file existence on CDN/disk
      if (asset.path && asset.alt && asset.width && asset.height) {
        report.valid++;
      } else {
        report.missing.push(`${category}.${key}`);
      }
    });
  });

  return report;
}

module.exports = {
  ASSETS,
  getAsset,
  getAssetsByUseCase,
  getSrcset,
  getLazyLoadType,
  getAllAssets,
  validateAssets
};
