'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const COMMANDS_CATALOG = [
  {
    id: 'general',
    category: 'General Utilities',
    icon: '⚡',
    badge: 'Universal',
    description: 'Everyday utility, latency checks, and identity commands available to all users',
    color: '#38bdf8',
    items: [
      { cmd: 'menu', args: '', desc: 'Display bot command menu, character banner, and active theme branding', perm: 'Everyone' },
      { cmd: 'ping', args: '', desc: 'Check bot response latency and connection speed in milliseconds', perm: 'Everyone' },
      { cmd: 'status', args: '', desc: 'Show bot runtime status, uptime ticker, and host memory statistics', perm: 'Everyone' },
      { cmd: 'alive', args: '', desc: 'Instant pulse check to confirm bot is awake and responding', perm: 'Everyone' },
      { cmd: 'owner', args: '', desc: 'View bot owner contact identity and official WhatsApp channel', perm: 'Everyone' },
      { cmd: 'theme', args: '', desc: 'Show current anime character theme, series, and available presets', perm: 'Everyone' },
      { cmd: 'jid', args: '', desc: 'Inspect current sender and chat JID identifiers for debugging', perm: 'Everyone' },
      { cmd: 'idch', args: '<WhatsApp channel URL>', desc: 'Inspect public WhatsApp channel metadata from its invite URL', perm: 'Everyone' }
    ]
  },
  {
    id: 'media',
    category: 'Media & WebP Studio',
    icon: '🎨',
    badge: 'Creative',
    description: 'High-fidelity image to WebP sticker conversion and profile photo tools',
    color: '#a855f7',
    items: [
      { cmd: 'sticker', args: '[reply to image]', desc: 'Convert image to full-fidelity WebP sticker with EXIF metadata', perm: 'Everyone' },
      { cmd: 'toimg', args: '[reply to sticker]', desc: 'Deconstruct WebP sticker back to crisp image file', perm: 'Everyone' },
      { cmd: 'getpp', args: '[@user / group]', desc: 'Fetch highest resolution profile picture of specified user or group', perm: 'Everyone' },
      { cmd: 'setpp', args: '[reply to image]', desc: 'Update WhatsApp bot profile avatar to attached image', perm: 'Owner Only' }
    ]
  },
  {
    id: 'group',
    category: 'Group Moderation',
    icon: '🛡️',
    badge: 'Admin Only',
    description: 'Complete admin control suite for group moderation, broadcast mentions, and greetings',
    color: '#22c55e',
    items: [
      { cmd: 'hidetag', args: '<message>', desc: 'Mention all group members invisibly inside custom announcement', perm: 'Group Admin' },
      { cmd: 'tagall', args: '<message>', desc: 'Mention every participant explicitly with numbered roster list', perm: 'Group Admin' },
      { cmd: 'welcome', args: '<on|off|status>', desc: 'Configure automated greeting card dispatched when new members join', perm: 'Group Admin' },
      { cmd: 'goodbye', args: '<on|off|status>', desc: 'Configure automated farewell notice when members leave group', perm: 'Group Admin' },
      { cmd: 'group', args: '', desc: 'Display comprehensive group management dashboard and active toggle status', perm: 'Group Admin' },
      { cmd: 'gname', args: '<new name>', desc: 'Update group subject title in real-time', perm: 'Group Admin' },
      { cmd: 'gdesc', args: '<new description>', desc: 'Update group description text and rules notice', perm: 'Group Admin' },
      { cmd: 'add', args: '<phone number>', desc: 'Add member to group chat via international phone number', perm: 'Group Admin' },
      { cmd: 'kick', args: '[@user]', desc: 'Remove disruptive member from group chat', perm: 'Group Admin' },
      { cmd: 'promote', args: '[@user]', desc: 'Promote regular group member to full group administrator', perm: 'Group Admin' },
      { cmd: 'demote', args: '[@user]', desc: 'Demote group administrator back to regular participant', perm: 'Group Admin' },
      { cmd: 'lock', args: '', desc: 'Restrict group messaging permissions exclusively to admins', perm: 'Group Admin' },
      { cmd: 'unlock', args: '', desc: 'Open group messaging permissions to all participants', perm: 'Group Admin' },
      { cmd: 'grouplink', args: '', desc: 'Retrieve permanent invite link for the current group', perm: 'Group Admin' }
    ]
  },
  {
    id: 'ai',
    category: 'Groq & AI Intelligence',
    icon: '🤖',
    badge: 'Smart Engine',
    description: 'Bounded Groq language model integration for natural language queries and requests',
    color: '#ec4899',
    items: [
      { cmd: 'ai', args: '<prompt>', desc: 'Query Groq language model with conversational prompt', perm: 'Everyone' },
      { cmd: 'request', args: '<message>', desc: 'Forward feature request or bug report directly to instance owner JID', perm: 'Everyone' }
    ]
  },
  {
    id: 'owner',
    category: 'Owner & VIP Suite',
    icon: '👑',
    badge: 'Owner Restricted',
    description: 'Privileged operations guarded by HMAC protected identity verification',
    color: '#eab308',
    items: [
      { cmd: 'public', args: '', desc: 'Switch bot to public mode (responds in personal & group chats)', perm: 'Owner Only' },
      { cmd: 'self', args: '', desc: 'Switch bot to private mode (responds exclusively to instance owner)', perm: 'Owner Only' },
      { cmd: 'addprem', args: '<number> [duration]', desc: 'Grant time-limited premium AI cooldown access (up to 366 days)', perm: 'Owner Only' },
      { cmd: 'delprem', args: '<number>', desc: 'Revoke premium privileges from specified subscriber number', perm: 'Owner Only' },
      { cmd: 'listprem', args: '', desc: 'List all currently active premium subscribers with expiration timestamps', perm: 'Owner Only' },
      { cmd: 'restart', args: '', desc: 'Gracefully recycle and restart bot socket worker process', perm: 'Owner Only' }
    ]
  }
];

function renderDashboardHtml({ config, activeTheme, liveStatus, recentLogs, allThemes }) {
  const p = config.commandPrefix || '!';
  const c = activeTheme.colors || {};
  const primary = c.primary || '#75d9ff';
  const accent = c.accent || '#7c3aed';
  const bg = c.background || '#0a0f24';
  const surface = c.surface || '#121a38';
  const surfaceHover = c.surfaceHover || '#1a244c';
  const border = c.border || '#2a3a6c';
  const glow = c.glow || 'rgba(117, 217, 255, 0.45)';
  const accentGlow = c.accentGlow || 'rgba(124, 58, 237, 0.35)';
  const characterImg = activeTheme.image || `/assets/characters/${activeTheme.id}.jpg`;

  // Filter out any unwanted themes from public listing
  const validThemes = (allThemes || []).filter(t => t.id !== 'default');

  return `<!DOCTYPE html>
<html lang="en" data-theme="${escapeHtml(activeTheme.id)}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(config.masterBotName)} — Anime WhatsApp Web Pairing</title>
  <meta name="description" content="Connect your WhatsApp to ${escapeHtml(config.masterBotName)} via anime-inspired Web Pairing Sanctum.">
  <meta property="og:title" content="${escapeHtml(config.masterBotName)} Web Pairing">
  <meta property="og:description" content="Fast, anime-themed 4-step WhatsApp Web Pairing powered by Baileys.">
  <style>
    :root {
      --primary: ${primary};
      --accent: ${accent};
      --bg: ${bg};
      --surface: ${surface};
      --surface-hover: ${surfaceHover};
      --border: ${border};
      --glow: ${glow};
      --accent-glow: ${accentGlow};
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --text-dim: #64748b;
      --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      --radius-sm: 8px;
      --radius-md: 14px;
      --radius-lg: 22px;
      --radius-full: 9999px;
      --transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      -webkit-tap-highlight-color: transparent;
    }

    html {
      scroll-behavior: smooth;
    }

    body {
      font-family: var(--font-sans);
      background-color: var(--bg);
      color: var(--text);
      line-height: 1.5;
      min-height: 100vh;
      overflow-x: hidden;
      transition: background-color 0.4s ease, color 0.4s ease;
      position: relative;
    }

    /* GPU-accelerated interactive particle canvas */
    #aura-canvas {
      position: fixed;
      inset: 0;
      width: 100vw;
      height: 100vh;
      pointer-events: none;
      z-index: 0;
      opacity: 0.85;
      transition: opacity 0.5s ease;
    }

    /* Ambient background mesh overlay */
    .ambient-grid {
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: 1;
      opacity: 0.05;
      background-image: linear-gradient(to right, #ffffff 1px, transparent 1px),
                        linear-gradient(to bottom, #ffffff 1px, transparent 1px);
      background-size: 40px 40px;
    }

    /* Main Container */
    .page-container {
      position: relative;
      z-index: 2;
      width: 100%;
      max-width: 1120px;
      margin: 0 auto;
      padding: 16px 20px 60px;
      display: flex;
      flex-direction: column;
      gap: 36px;
    }

    /* ================================================================
       1. BRAND / HEADER & COMPACT NAVIGATION
       ================================================================ */
    .site-header {
      position: sticky;
      top: 12px;
      z-index: 100;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 10px 18px;
      background: rgba(14, 18, 36, 0.78);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
      transition: border-color 0.3s ease;
    }

    .header-brand {
      display: flex;
      align-items: center;
      gap: 12px;
      text-decoration: none;
      color: inherit;
    }

    .brand-avatar-box {
      width: 42px;
      height: 42px;
      border-radius: var(--radius-md);
      overflow: hidden;
      border: 2px solid var(--primary);
      box-shadow: 0 0 14px var(--glow);
      background: var(--surface);
      flex-shrink: 0;
    }

    .brand-avatar-img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
      transition: transform 0.4s ease;
    }

    .header-brand:hover .brand-avatar-img {
      transform: scale(1.08);
    }

    .brand-titles {
      display: flex;
      flex-direction: column;
    }

    .brand-title-main {
      font-size: 17px;
      font-weight: 800;
      letter-spacing: -0.3px;
      line-height: 1.2;
      background: linear-gradient(120deg, #ffffff 40%, var(--primary) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .brand-title-sub {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-muted);
      letter-spacing: 0.3px;
    }

    .header-nav {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .nav-link {
      padding: 7px 14px;
      font-size: 13px;
      font-weight: 600;
      color: var(--text-muted);
      text-decoration: none;
      border-radius: var(--radius-full);
      transition: var(--transition);
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    .nav-link:hover {
      color: #ffffff;
      background: rgba(255, 255, 255, 0.08);
    }

    .status-pill {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      background: rgba(0, 0, 0, 0.35);
      border: 1px solid var(--border);
      border-radius: var(--radius-full);
      font-size: 12px;
      font-weight: 600;
      white-space: nowrap;
    }

    .live-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #94a3b8;
      transition: background-color 0.3s ease, box-shadow 0.3s ease;
    }

    .live-dot.online {
      background: #22c55e;
      box-shadow: 0 0 10px #22c55e;
      animation: pulse-dot 2s infinite;
    }

    .live-dot.pairing {
      background: #f59e0b;
      box-shadow: 0 0 10px #f59e0b;
      animation: pulse-dot 1.4s infinite;
    }

    @keyframes pulse-dot {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.45; transform: scale(0.85); }
    }

    /* Section Title */
    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 18px;
      flex-wrap: wrap;
      gap: 12px;
    }

    .section-title {
      font-size: 22px;
      font-weight: 800;
      letter-spacing: -0.4px;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .section-title .section-icon {
      color: var(--primary);
    }

    .section-tagline {
      font-size: 13px;
      color: var(--text-muted);
    }

    /* ================================================================
       2. WEB PAIRING SANCTUM (HERO & 4-STEP ANIME FLOW)
       ================================================================ */
    .pairing-sanctum {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 28px;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5);
      position: relative;
      overflow: hidden;
      transition: border-color 0.4s ease;
    }

    .pairing-hero-grid {
      display: grid;
      grid-template-columns: 320px 1fr;
      gap: 32px;
      align-items: center;
    }

    /* Anime Character Stage & Breathing Aura */
    .character-stage {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      position: relative;
      padding: 16px 0;
    }

    .aura-glow-back {
      position: absolute;
      top: 45%;
      left: 50%;
      width: 280px;
      height: 280px;
      border-radius: 50%;
      background: radial-gradient(circle, var(--glow) 0%, transparent 68%);
      transform: translate(-50%, -50%);
      pointer-events: none;
      filter: blur(24px);
      opacity: 0.6;
      animation: aura-breathe 4s ease-in-out infinite alternate;
    }

    .aura-rune-ring {
      position: absolute;
      top: 45%;
      left: 50%;
      width: 240px;
      height: 240px;
      border-radius: 50%;
      border: 1px dashed var(--primary);
      transform: translate(-50%, -50%);
      pointer-events: none;
      opacity: 0.35;
      animation: ring-spin 28s linear infinite;
    }

    @keyframes aura-breathe {
      0% { transform: translate(-50%, -50%) scale(0.92); opacity: 0.45; }
      100% { transform: translate(-50%, -50%) scale(1.15); opacity: 0.8; }
    }

    @keyframes ring-spin {
      0% { transform: translate(-50%, -50%) rotate(0deg); }
      100% { transform: translate(-50%, -50%) rotate(360deg); }
    }

    .character-art-box {
      position: relative;
      z-index: 2;
      width: 200px;
      height: 200px;
      border-radius: var(--radius-lg);
      overflow: hidden;
      border: 2px solid var(--primary);
      box-shadow: 0 0 26px var(--glow);
      margin-bottom: 16px;
      background: #000;
    }

    .character-art-img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      transition: transform 0.5s ease;
      display: block;
    }

    .character-stage:hover .character-art-img {
      transform: scale(1.05);
    }

    .character-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 12px;
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid var(--border);
      border-radius: var(--radius-full);
      font-size: 11px;
      font-weight: 700;
      color: var(--primary);
      text-transform: uppercase;
      letter-spacing: 0.6px;
      margin-bottom: 6px;
    }

    .character-name {
      font-size: 20px;
      font-weight: 800;
      color: #ffffff;
      margin-bottom: 4px;
    }

    .character-quote {
      font-size: 12px;
      color: var(--text-muted);
      font-style: italic;
      max-width: 260px;
      line-height: 1.4;
    }

    /* Right: Interactive Flow Area */
    .pairing-flow-card {
      background: rgba(0, 0, 0, 0.28);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: var(--radius-md);
      padding: 24px 26px;
      display: flex;
      flex-direction: column;
      gap: 20px;
      position: relative;
      min-height: 360px;
      justify-content: center;
    }

    /* Stage 1: Phone Input */
    .flow-stage {
      display: none;
      flex-direction: column;
      gap: 18px;
      animation: fadeInStage 0.3s cubic-bezier(0.4, 0, 0.2, 1) forwards;
    }

    .flow-stage.active {
      display: flex;
    }

    @keyframes fadeInStage {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .flow-heading {
      font-size: 24px;
      font-weight: 800;
      letter-spacing: -0.4px;
      color: #ffffff;
    }

    .flow-sub {
      font-size: 14px;
      color: var(--text-muted);
      line-height: 1.5;
    }

    .phone-input-cluster {
      display: flex;
      gap: 10px;
      align-items: stretch;
      width: 100%;
    }

    .country-select {
      background: rgba(0, 0, 0, 0.45);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      color: #ffffff;
      padding: 12px 14px;
      font-size: 14px;
      font-weight: 600;
      outline: none;
      cursor: pointer;
      transition: var(--transition);
      max-width: 150px;
    }

    .country-select:focus {
      border-color: var(--primary);
      box-shadow: 0 0 10px var(--glow);
    }

    .country-select option {
      background: #0f172a;
      color: #ffffff;
    }

    .phone-number-field {
      flex: 1;
      background: rgba(0, 0, 0, 0.45);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      color: #ffffff;
      padding: 12px 16px;
      font-size: 16px;
      font-family: var(--font-mono);
      font-weight: 600;
      outline: none;
      transition: var(--transition);
      letter-spacing: 0.5px;
    }

    .phone-number-field:focus {
      border-color: var(--primary);
      box-shadow: 0 0 12px var(--glow);
    }

    .phone-number-field::placeholder {
      color: var(--text-dim);
      font-family: var(--font-sans);
      font-weight: 400;
    }

    .btn-continue {
      background: var(--primary);
      color: #0b1120;
      border: none;
      border-radius: var(--radius-sm);
      padding: 14px 24px;
      font-size: 15px;
      font-weight: 700;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      box-shadow: 0 4px 18px var(--glow);
      transition: var(--transition);
      width: 100%;
      min-height: 48px;
    }

    .btn-continue:hover:not(:disabled) {
      transform: translateY(-2px);
      box-shadow: 0 6px 24px var(--glow);
    }

    .btn-continue:disabled {
      opacity: 0.6;
      cursor: not-allowed;
      transform: none;
    }

    .input-error-text {
      color: #f87171;
      font-size: 13px;
      font-weight: 600;
      display: none;
    }

    /* Stage 2: Anime Summoning Loading Animation */
    .loading-aura-stage {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      gap: 20px;
      padding: 30px 0;
    }

    .summoning-orb-wrap {
      position: relative;
      width: 110px;
      height: 110px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .summoning-ring-outer {
      position: absolute;
      inset: 0;
      border-radius: 50%;
      border: 3px dashed var(--primary);
      animation: ring-spin 4s linear infinite;
    }

    .summoning-ring-inner {
      position: absolute;
      inset: 12px;
      border-radius: 50%;
      border: 2px solid var(--accent);
      border-top-color: transparent;
      animation: ring-spin-reverse 2s linear infinite;
    }

    .summoning-core-orb {
      width: 44px;
      height: 44px;
      border-radius: 50%;
      background: var(--primary);
      box-shadow: 0 0 25px var(--glow), 0 0 45px var(--accent-glow);
      animation: core-pulse 1.2s ease-in-out infinite alternate;
    }

    @keyframes ring-spin-reverse {
      0% { transform: rotate(360deg); }
      100% { transform: rotate(0deg); }
    }

    @keyframes core-pulse {
      0% { transform: scale(0.85); opacity: 0.7; }
      100% { transform: scale(1.15); opacity: 1; }
    }

    .loading-title {
      font-size: 18px;
      font-weight: 700;
      color: #ffffff;
    }

    .loading-target-number {
      font-family: var(--font-mono);
      font-size: 15px;
      color: var(--primary);
      font-weight: 700;
    }

    /* Stage 3: Pairing Code Reveal */
    .code-reveal-stage {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .code-header-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .code-title {
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 1px;
      color: var(--primary);
      text-transform: uppercase;
    }

    .btn-change-number {
      background: none;
      border: none;
      color: var(--text-muted);
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      text-decoration: underline;
    }

    .btn-change-number:hover {
      color: #ffffff;
    }

    /* 8-Character Tiles Grid */
    .code-display-block {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 16px 12px;
      background: rgba(0, 0, 0, 0.45);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      box-shadow: inset 0 0 20px rgba(0, 0, 0, 0.6);
    }

    .code-char-box {
      width: 38px;
      height: 50px;
      background: var(--surface-hover);
      border: 1.5px solid var(--border);
      border-radius: var(--radius-sm);
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: var(--font-mono);
      font-size: 24px;
      font-weight: 800;
      color: #ffffff;
      box-shadow: 0 4px 10px rgba(0, 0, 0, 0.3);
      text-shadow: 0 0 10px var(--glow);
      transition: var(--transition);
    }

    .code-char-divider {
      font-size: 22px;
      font-weight: 700;
      color: var(--primary);
      margin: 0 2px;
    }

    .code-actions-row {
      display: flex;
      gap: 10px;
    }

    .btn-copy-code {
      flex: 2;
      background: var(--primary);
      color: #0b1120;
      border: none;
      border-radius: var(--radius-sm);
      padding: 12px 18px;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      box-shadow: 0 4px 14px var(--glow);
      transition: var(--transition);
      min-height: 44px;
    }

    .btn-copy-code:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 20px var(--glow);
    }

    .btn-retry-code {
      flex: 1;
      background: rgba(255, 255, 255, 0.08);
      color: #ffffff;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 12px 14px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      transition: var(--transition);
      min-height: 44px;
    }

    .btn-retry-code:hover {
      background: rgba(255, 255, 255, 0.14);
    }

    /* Short Concise Steps */
    .short-instructions-box {
      background: rgba(0, 0, 0, 0.25);
      border-radius: var(--radius-sm);
      padding: 12px 16px;
      border-left: 3px solid var(--primary);
    }

    .short-instructions-box ol {
      padding-left: 18px;
      font-size: 13px;
      color: var(--text-muted);
      line-height: 1.6;
    }

    .short-instructions-box ol strong {
      color: #ffffff;
    }

    /* Connected Celebration Banner */
    .connected-banner {
      display: none;
      background: linear-gradient(135deg, rgba(34, 197, 94, 0.15) 0%, rgba(16, 185, 129, 0.05) 100%);
      border: 1px solid #22c55e;
      border-radius: var(--radius-md);
      padding: 24px;
      text-align: center;
      flex-direction: column;
      align-items: center;
      gap: 12px;
    }

    .connected-banner.active {
      display: flex;
    }

    .connected-badge-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 16px;
      background: #22c55e;
      color: #0b1120;
      border-radius: var(--radius-full);
      font-weight: 800;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    /* ================================================================
       3. REAL-TIME CONNECTION STATUS TIMELINE
       ================================================================ */
    .status-timeline-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 22px 26px;
      box-shadow: 0 12px 30px rgba(0, 0, 0, 0.35);
    }

    .timeline-track {
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      gap: 12px;
      position: relative;
      margin-top: 14px;
    }

    .timeline-node {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      position: relative;
      gap: 8px;
    }

    .timeline-indicator {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.06);
      border: 1.5px solid var(--border);
      color: var(--text-dim);
      font-family: var(--font-mono);
      font-size: 12px;
      font-weight: 700;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: var(--transition);
      z-index: 2;
    }

    .timeline-node.active .timeline-indicator {
      background: var(--primary);
      color: #0b1120;
      border-color: var(--primary);
      box-shadow: 0 0 14px var(--glow);
      transform: scale(1.1);
    }

    .timeline-node.completed .timeline-indicator {
      background: #22c55e;
      color: #0b1120;
      border-color: #22c55e;
      box-shadow: 0 0 12px rgba(34, 197, 94, 0.5);
    }

    .timeline-label {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-dim);
      transition: var(--transition);
      line-height: 1.3;
    }

    .timeline-node.active .timeline-label {
      color: #ffffff;
      font-weight: 700;
    }

    .timeline-node.completed .timeline-label {
      color: #22c55e;
      font-weight: 600;
    }

    /* ================================================================
       4. COMMANDS HUB
       ================================================================ */
    .commands-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 26px;
      box-shadow: 0 12px 30px rgba(0, 0, 0, 0.35);
      display: flex;
      flex-direction: column;
      gap: 20px;
    }

    .commands-filter-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      flex-wrap: wrap;
    }

    .search-input-box {
      flex: 1;
      min-width: 240px;
      position: relative;
    }

    .cmd-search-input {
      width: 100%;
      background: rgba(0, 0, 0, 0.4);
      border: 1px solid var(--border);
      border-radius: var(--radius-full);
      padding: 10px 18px 10px 38px;
      color: #ffffff;
      font-size: 14px;
      outline: none;
      transition: var(--transition);
    }

    .cmd-search-input:focus {
      border-color: var(--primary);
      box-shadow: 0 0 10px var(--glow);
    }

    .search-icon-symbol {
      position: absolute;
      left: 14px;
      top: 50%;
      transform: translateY(-50%);
      color: var(--text-dim);
      font-size: 14px;
      pointer-events: none;
    }

    .category-pills-row {
      display: flex;
      gap: 6px;
      overflow-x: auto;
      padding-bottom: 4px;
    }

    .cat-pill {
      padding: 6px 14px;
      font-size: 12px;
      font-weight: 600;
      color: var(--text-muted);
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border);
      border-radius: var(--radius-full);
      cursor: pointer;
      white-space: nowrap;
      transition: var(--transition);
    }

    .cat-pill:hover {
      color: #ffffff;
      background: rgba(255, 255, 255, 0.1);
    }

    .cat-pill.active {
      background: var(--primary);
      color: #0b1120;
      font-weight: 700;
      border-color: var(--primary);
      box-shadow: 0 0 10px var(--glow);
    }

    .commands-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
      gap: 14px;
    }

    .command-item-card {
      background: rgba(0, 0, 0, 0.28);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: 14px 16px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      cursor: pointer;
      transition: var(--transition);
      position: relative;
    }

    .command-item-card:hover {
      transform: translateY(-3px);
      border-color: var(--primary);
      box-shadow: 0 8px 20px rgba(0, 0, 0, 0.4), 0 0 15px var(--glow);
      background: var(--surface-hover);
    }

    .cmd-top-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .cmd-name {
      font-family: var(--font-mono);
      font-size: 15px;
      font-weight: 700;
      color: var(--primary);
    }

    .cmd-perm-badge {
      font-size: 10px;
      font-weight: 700;
      padding: 2px 8px;
      border-radius: var(--radius-full);
      background: rgba(255, 255, 255, 0.08);
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.4px;
    }

    .cmd-desc {
      font-size: 12px;
      color: var(--text-muted);
      line-height: 1.4;
    }

    /* Toast copy indicator */
    .cmd-copy-hint {
      font-size: 10px;
      color: var(--text-dim);
      margin-top: auto;
      display: flex;
      align-items: center;
      gap: 4px;
    }

    /* ================================================================
       5. ANIME THEME SELECTOR
       ================================================================ */
    .themes-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 26px;
      box-shadow: 0 12px 30px rgba(0, 0, 0, 0.35);
      display: flex;
      flex-direction: column;
      gap: 20px;
    }

    .themes-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: 16px;
    }

    .theme-card {
      background: rgba(0, 0, 0, 0.35);
      border: 1.5px solid var(--border);
      border-radius: var(--radius-md);
      overflow: hidden;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      transition: var(--transition);
      position: relative;
    }

    .theme-card:hover {
      transform: translateY(-4px);
      border-color: var(--primary);
      box-shadow: 0 12px 24px rgba(0, 0, 0, 0.5), 0 0 16px var(--glow);
    }

    .theme-card.active {
      border-color: var(--primary);
      box-shadow: 0 0 20px var(--glow);
      background: rgba(255, 255, 255, 0.04);
    }

    .theme-art-frame {
      width: 100%;
      height: 140px;
      overflow: hidden;
      position: relative;
      background: #000;
    }

    .theme-art-img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      transition: transform 0.4s ease;
    }

    .theme-card:hover .theme-art-img {
      transform: scale(1.08);
    }

    .theme-active-tag {
      position: absolute;
      top: 8px;
      right: 8px;
      background: var(--primary);
      color: #0b1120;
      font-size: 10px;
      font-weight: 800;
      padding: 3px 10px;
      border-radius: var(--radius-full);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
      display: none;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .theme-card.active .theme-active-tag {
      display: block;
    }

    .theme-body {
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .theme-character-title {
      font-size: 15px;
      font-weight: 800;
      color: #ffffff;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .theme-vibe-text {
      font-size: 12px;
      font-weight: 600;
      color: var(--primary);
    }

    .theme-series-text {
      font-size: 11px;
      color: var(--text-dim);
    }

    /* ================================================================
       6. DEVELOPER / OWNER PORTFOLIO
       ================================================================ */
    .developer-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 24px 28px;
      box-shadow: 0 12px 30px rgba(0, 0, 0, 0.35);
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 24px;
      align-items: center;
    }

    .dev-info-left {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .dev-role-label {
      font-size: 11px;
      font-weight: 700;
      color: var(--primary);
      text-transform: uppercase;
      letter-spacing: 0.8px;
    }

    .dev-name-heading {
      font-size: 20px;
      font-weight: 800;
      color: #ffffff;
    }

    .dev-desc-text {
      font-size: 13px;
      color: var(--text-muted);
      line-height: 1.5;
      max-width: 580px;
    }

    .dev-links-row {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-top: 6px;
      flex-wrap: wrap;
    }

    .dev-btn-link {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 8px 16px;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid var(--border);
      border-radius: var(--radius-full);
      color: #ffffff;
      font-size: 12px;
      font-weight: 600;
      text-decoration: none;
      transition: var(--transition);
    }

    .dev-btn-link:hover {
      background: var(--primary);
      color: #0b1120;
      border-color: var(--primary);
      box-shadow: 0 0 12px var(--glow);
    }

    .dev-badge-box {
      background: rgba(0, 0, 0, 0.4);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: 16px 20px;
      text-align: right;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .dev-badge-title {
      font-size: 11px;
      font-weight: 700;
      color: var(--text-dim);
      text-transform: uppercase;
    }

    .dev-badge-value {
      font-size: 14px;
      font-weight: 700;
      color: #ffffff;
    }

    /* ================================================================
       7. FOOTER
       ================================================================ */
    .site-footer {
      text-align: center;
      padding: 20px 0 10px;
      font-size: 12px;
      color: var(--text-dim);
      display: flex;
      flex-direction: column;
      gap: 6px;
      border-top: 1px solid rgba(255, 255, 255, 0.05);
    }

    .footer-highlight {
      color: var(--text-muted);
      font-weight: 600;
    }

    /* Responsive Mobile Tweaks */
    @media (max-width: 860px) {
      .pairing-hero-grid {
        grid-template-columns: 1fr;
        gap: 24px;
      }
      .character-art-box {
        width: 160px;
        height: 160px;
      }
      .timeline-track {
        grid-template-columns: 1fr;
        gap: 16px;
      }
      .timeline-node {
        flex-direction: row;
        text-align: left;
      }
      .developer-card {
        grid-template-columns: 1fr;
      }
      .dev-badge-box {
        text-align: left;
      }
      .header-nav .nav-link {
        display: none;
      }
    }

    @media (max-width: 480px) {
      .phone-input-cluster {
        flex-direction: column;
      }
      .country-select {
        max-width: 100%;
      }
      .code-display-block {
        gap: 4px;
      }
      .code-char-box {
        width: 32px;
        height: 44px;
        font-size: 20px;
      }
    }

    /* Accessibility: prefers-reduced-motion */
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.01ms !important;
      }
      #aura-canvas {
        display: none;
      }
    }
  </style>
</head>
<body>

  <!-- Interactive Anime Particle Canvas -->
  <canvas id="aura-canvas"></canvas>
  <div class="ambient-grid"></div>

  <div class="page-container">

    <!-- 1. BRAND / HEADER -->
    <header class="site-header" id="header">
      <a href="#pairing" class="header-brand" id="nav-brand">
        <div class="brand-avatar-box">
          <img id="header-avatar" class="brand-avatar-img" src="${escapeHtml(characterImg)}" alt="${escapeHtml(activeTheme.character || activeTheme.name)}" onerror="handleAvatarFallback(this)">
        </div>
        <div class="brand-titles">
          <span class="brand-title-main">${escapeHtml(config.masterBotName)}</span>
          <span class="brand-title-sub">Developed by GOATS MODS</span>
        </div>
      </a>

      <nav class="header-nav">
        <a href="#pairing" class="nav-link">Pairing</a>
        <a href="#status" class="nav-link">Status</a>
        <a href="#commands" class="nav-link">Commands</a>
        <a href="#themes" class="nav-link">Themes</a>
        <a href="#developer" class="nav-link">Developer</a>
        
        <div class="status-pill" id="header-status-pill">
          <div class="live-dot ${liveStatus.status === 'connected' ? 'online' : (liveStatus.status === 'pairing' ? 'pairing' : '')}" id="live-dot-indicator"></div>
          <span id="live-status-label">${liveStatus.status === 'connected' ? 'Online' : (liveStatus.status === 'pairing' ? 'Pairing Ready' : 'Connecting')}</span>
        </div>
      </nav>
    </header>

    <!-- 2. WEB PAIRING SANCTUM (HERO & 4-STEP ANIME FLOW) -->
    <section class="pairing-sanctum" id="pairing">
      <div class="pairing-hero-grid">
        
        <!-- Left: Anime Character Portrait & Breathing Aura -->
        <div class="character-stage" id="hero-stage">
          <div class="aura-glow-back" id="hero-aura-glow"></div>
          <div class="aura-rune-ring"></div>

          <div class="character-art-box">
            <img id="hero-art" class="character-art-img" src="${escapeHtml(characterImg)}" alt="${escapeHtml(activeTheme.character || activeTheme.name)}" onerror="handleArtFallback(this)">
          </div>

          <span class="character-badge" id="hero-vibe-badge">
            <span id="hero-theme-icon">${escapeHtml(activeTheme.icon || '⚡')}</span>
            <span id="hero-theme-vibe">${escapeHtml(activeTheme.vibe || 'Limitless Aura')}</span>
          </span>

          <h2 class="character-name" id="hero-character-name">${escapeHtml(activeTheme.character || activeTheme.name)}</h2>
          <p class="character-quote" id="hero-quote">"${escapeHtml(activeTheme.quote || activeTheme.tagline)}"</p>
        </div>

        <!-- Right: 4-Step Interactive Web Pairing Flow -->
        <div class="pairing-flow-card">

          <!-- STEP 1: Enter Phone Number -->
          <div class="flow-stage active" id="stage-phone">
            <div>
              <h3 class="flow-heading">Connect Your WhatsApp</h3>
              <p class="flow-sub">Enter your phone number to generate an instant pairing code for Baileys WhatsApp connection.</p>
            </div>

            <div class="phone-input-cluster">
              <select class="country-select" id="country-select" onchange="handleCountryChange(this.value)">
                <option value="92" selected>🇵🇰 +92</option>
                <option value="1">🇺🇸 +1</option>
                <option value="44">🇬🇧 +44</option>
                <option value="62">🇮🇩 +62</option>
                <option value="91">🇮🇳 +91</option>
                <option value="234">🇳🇬 +234</option>
                <option value="55">🇧🇷 +55</option>
                <option value="27">🇿🇦 +27</option>
                <option value="60">🇲🇾 +60</option>
                <option value="63">🇵🇭 +63</option>
                <option value="966">🇸🇦 +966</option>
                <option value="971">🇦🇪 +971</option>
                <option value="custom">🌐 Custom</option>
              </select>

              <input 
                type="tel" 
                id="phone-input" 
                class="phone-number-field" 
                placeholder="3195176242" 
                inputmode="numeric"
                autocomplete="tel"
                onkeydown="if(event.key==='Enter') submitPhoneNumber()">
            </div>

            <span class="input-error-text" id="phone-error-msg"></span>

            <button class="btn-continue" id="btn-submit" onclick="submitPhoneNumber()">
              <span>Continue</span>
              <span>→</span>
            </button>
          </div>

          <!-- STEP 2: Anime Aura Summoning Loading State -->
          <div class="flow-stage" id="stage-loading">
            <div class="loading-aura-stage">
              <div class="summoning-orb-wrap">
                <div class="summoning-ring-outer"></div>
                <div class="summoning-ring-inner"></div>
                <div class="summoning-core-orb"></div>
              </div>

              <div>
                <h4 class="loading-title">Generating Pairing Code...</h4>
                <p class="flow-sub">Summoning character aura and dispatching Baileys socket handshake for <span class="loading-target-number" id="loading-target-phone">+92...</span></p>
              </div>
            </div>
          </div>

          <!-- STEP 3: Pairing Code Reveal -->
          <div class="flow-stage" id="stage-code">
            <div class="code-reveal-stage">
              <div class="code-header-row">
                <span class="code-title">Pairing Code</span>
                <button class="btn-change-number" onclick="returnToPhoneInput()">Change Number</button>
              </div>

              <div class="code-display-block" id="code-tiles-container">
                <!-- Injected dynamically: 8 character boxes -->
                <div class="code-char-box">-</div>
              </div>

              <div class="code-actions-row">
                <button class="btn-copy-code" id="btn-copy-code" onclick="copyPairingCode()">
                  <span>📋</span>
                  <span>Copy Pairing Code</span>
                </button>
                <button class="btn-retry-code" id="btn-regenerate" onclick="regeneratePairingCode()">
                  <span>🔄</span>
                  <span>Regenerate</span>
                </button>
              </div>

              <div class="short-instructions-box">
                <ol>
                  <li>Open <strong>WhatsApp</strong> on your phone</li>
                  <li>Tap <strong>Settings</strong> → <strong>Linked Devices</strong></li>
                  <li>Tap <strong>Link a Device</strong></li>
                  <li>Tap <strong>Link with phone number instead</strong></li>
                  <li>Enter the 8-character pairing code above</li>
                </ol>
              </div>
            </div>
          </div>

          <!-- CONNECTED CELEBRATION STATE -->
          <div class="connected-banner" id="stage-connected">
            <span class="connected-badge-pill">✓ Bot Online</span>
            <h3 class="flow-heading" style="color: #22c55e;">Successfully Connected!</h3>
            <p class="flow-sub">Your WhatsApp account has approved pairing. ${escapeHtml(config.masterBotName)} is now running live in your chats.</p>
            <p class="flow-sub" style="font-size: 13px;">Send <strong>${escapeHtml(p)}menu</strong> in any chat to explore commands.</p>
          </div>

        </div>

      </div>
    </section>

    <!-- 3. REAL-TIME CONNECTION STATUS TIMELINE -->
    <section class="status-timeline-card" id="status">
      <div class="section-header">
        <h3 class="section-title">
          <span class="section-icon">📶</span>
          <span>Connection Pipeline</span>
        </h3>
        <span class="section-tagline" id="timeline-status-text">Ready to Connect</span>
      </div>

      <div class="timeline-track">
        <div class="timeline-node" id="step-node-1">
          <div class="timeline-indicator">01</div>
          <span class="timeline-label">Number Submitted</span>
        </div>
        <div class="timeline-node" id="step-node-2">
          <div class="timeline-indicator">02</div>
          <span class="timeline-label">Code Generated</span>
        </div>
        <div class="timeline-node" id="step-node-3">
          <div class="timeline-indicator">03</div>
          <span class="timeline-label">Device Approval</span>
        </div>
        <div class="timeline-node" id="step-node-4">
          <div class="timeline-indicator">04</div>
          <span class="timeline-label">WhatsApp Connection</span>
        </div>
        <div class="timeline-node" id="step-node-5">
          <div class="timeline-indicator">05</div>
          <span class="timeline-label">Bot Online</span>
        </div>
      </div>
    </section>

    <!-- 4. COMMANDS HUB -->
    <section class="commands-card" id="commands">
      <div class="section-header">
        <div>
          <h3 class="section-title">
            <span class="section-icon">📖</span>
            <span>Commands Directory</span>
          </h3>
          <p class="section-tagline">Clean interactive reference. Click any command to copy syntax directly.</p>
        </div>

        <div class="search-input-box">
          <span class="search-icon-symbol">🔍</span>
          <input 
            type="text" 
            class="cmd-search-input" 
            placeholder="Search commands..." 
            oninput="filterCommands(this.value)">
        </div>
      </div>

      <div class="category-pills-row">
        <button class="cat-pill active" onclick="selectCategory('all', this)">All</button>
        <button class="cat-pill" onclick="selectCategory('general', this)">Utilities</button>
        <button class="cat-pill" onclick="selectCategory('media', this)">Media</button>
        <button class="cat-pill" onclick="selectCategory('group', this)">Group</button>
        <button class="cat-pill" onclick="selectCategory('ai', this)">Groq AI</button>
        <button class="cat-pill" onclick="selectCategory('owner', this)">Owner</button>
      </div>

      <div class="commands-grid" id="commands-list">
        ${COMMANDS_CATALOG.flatMap(cat => 
          cat.items.map(item => `
            <div class="command-item-card" data-category="${escapeHtml(cat.id)}" onclick="copyCommandSyntax('${escapeHtml(p + item.cmd + (item.args ? ' ' + item.args : ''))}')">
              <div class="cmd-top-row">
                <span class="cmd-name">${escapeHtml(p + item.cmd)}</span>
                <span class="cmd-perm-badge">${escapeHtml(item.perm)}</span>
              </div>
              <p class="cmd-desc">${escapeHtml(item.desc)}</p>
              <div class="cmd-copy-hint">
                <span>📋</span>
                <span>Click to copy</span>
              </div>
            </div>
          `)
        ).join('')}
      </div>
    </section>

    <!-- 5. ANIME THEME SELECTOR -->
    <section class="themes-card" id="themes">
      <div class="section-header">
        <div>
          <h3 class="section-title">
            <span class="section-icon">🎭</span>
            <span>Anime Visual Identities</span>
          </h3>
          <p class="section-tagline">Select a character to transform the interface aura, interactive particles, and color palette.</p>
        </div>
      </div>

      <div class="themes-grid">
        ${validThemes.map(th => `
          <div class="theme-card ${th.id === activeTheme.id ? 'active' : ''}" id="theme-card-${escapeHtml(th.id)}" onclick="selectTheme('${escapeHtml(th.id)}')">
            <div class="theme-art-frame">
              <img class="theme-art-img" src="${escapeHtml(th.image || `/assets/characters/${th.id}.jpg`)}" alt="${escapeHtml(th.character || th.name)}" onerror="handleCardFallback(this)">
              <span class="theme-active-tag">Active</span>
            </div>
            <div class="theme-body">
              <h4 class="theme-character-title">
                <span>${escapeHtml(th.icon || '⚡')}</span>
                <span>${escapeHtml(th.character || th.name)}</span>
              </h4>
              <span class="theme-vibe-text">${escapeHtml(th.vibe || 'Anime Aura')}</span>
              <span class="theme-series-text">${escapeHtml(th.branding?.series || 'Anime Series')}</span>
            </div>
          </div>
        `).join('')}
      </div>
    </section>

    <!-- 6. DEVELOPER / OWNER PORTFOLIO -->
    <section class="developer-card" id="developer">
      <div class="dev-info-left">
        <span class="dev-role-label">Official Core Development</span>
        <h3 class="dev-name-heading">GOATS MODS • Only F!xa Dev</h3>
        <p class="dev-desc-text">
          Engineered as a robust, anime-inspired multi-device WhatsApp bot architecture. Built on Baileys v7 WebSocket socket handling with cryptographic HMAC protected identity safeguards.
        </p>

        <div class="dev-links-row">
          <a href="${escapeHtml(config.whatsappChannel || 'https://whatsapp.com/channel/0029VbBepCNBVJl5vGUHET3T')}" target="_blank" rel="noopener noreferrer" class="dev-btn-link">
            <span>📢</span>
            <span>Official WhatsApp Channel</span>
          </a>
          <span class="dev-btn-link" style="cursor: default;">
            <span>🛡️</span>
            <span>Apache-2.0 License</span>
          </span>
          <span class="dev-btn-link" style="cursor: default;">
            <span>⚡</span>
            <span>Baileys v7 Multi-Device</span>
          </span>
        </div>
      </div>

      <div class="dev-badge-box">
        <span class="dev-badge-title">Runtime Bot Identity</span>
        <span class="dev-badge-value">${escapeHtml(config.masterBotName)}</span>
        <span class="dev-badge-title" style="margin-top: 6px;">Instance Number</span>
        <span class="dev-badge-value" style="font-family: var(--font-mono);">+${escapeHtml(config.botNumber)}</span>
      </div>
    </section>

    <!-- 7. FOOTER -->
    <footer class="site-footer">
      <p class="footer-highlight">${escapeHtml(config.masterBotName)} • Developed by GOATS MODS • Developer: Only F!xa Dev</p>
      <p>Next-generation anime-powered WhatsApp bot Web Pairing environment.</p>
    </footer>

  </div>

  <!-- Client-Side State, Particle Engine & WebSocket Handshake Poller -->
  <script>
    const THEME_DATA = ${JSON.stringify(
      Object.fromEntries(validThemes.map(t => [t.id, {
        id: t.id,
        name: t.name,
        character: t.character || t.name,
        vibe: t.vibe || 'Limitless Aura',
        icon: t.icon || '⚡',
        quote: t.quote || t.tagline,
        image: t.image || ('/assets/characters/' + t.id + '.jpg'),
        series: t.branding?.series || 'Anime Series',
        role: t.branding?.role || 'Fighter',
        colors: t.colors || {}
      }]))
    )};

    let currentThemeId = '${escapeJs(activeTheme.id)}';
    let currentPairingCode = '${escapeJs(liveStatus.pairingCode || '')}';
    let userHasSubmitted = false;
    let targetPhoneNumber = '';

    // ================================================================
    // INTERACTIVE GPU-ACCELERATED PARTICLE SYSTEM ("AURA FARMING")
    // ================================================================
    const canvas = document.getElementById('aura-canvas');
    const ctx = canvas.getContext('2d');
    let particles = [];
    let animationFrameId;
    let mouseX = -1000;
    let mouseY = -1000;
    let isMouseMoving = false;
    let mouseTimeout;

    function initCanvas() {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      createParticles();
    }

    window.addEventListener('resize', () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      createParticles();
    });

    window.addEventListener('mousemove', (e) => {
      mouseX = e.clientX;
      mouseY = e.clientY;
      isMouseMoving = true;
      clearTimeout(mouseTimeout);
      mouseTimeout = setTimeout(() => { isMouseMoving = false; }, 2000);
    });

    window.addEventListener('touchmove', (e) => {
      if (e.touches && e.touches[0]) {
        mouseX = e.touches[0].clientX;
        mouseY = e.touches[0].clientY;
        isMouseMoving = true;
      }
    }, { passive: true });

    function getThemeParticleConfig(themeId) {
      switch (themeId) {
        case 'gojo':
          return { colors: ['#75d9ff', '#38bdf8', '#7c3aed', '#c084fc'], speed: 0.6, sizeRange: [2, 5], shape: 'orb' };
        case 'sukuna':
          return { colors: ['#f87171', '#dc2626', '#991b1b', '#fca5a5'], speed: 0.9, sizeRange: [1.5, 4.5], shape: 'ember' };
        case 'asta':
          return { colors: ['#4ade80', '#16a34a', '#22c55e', '#86efac'], speed: 1.1, sizeRange: [2, 5], shape: 'spark' };
        case 'nami':
          return { colors: ['#fb923c', '#0284c7', '#38bdf8', '#fdba74'], speed: 0.7, sizeRange: [2, 5.5], shape: 'droplet' };
        case 'nezuko':
          return { colors: ['#f472b6', '#e11d48', '#fb7185', '#fbcfe8'], speed: 0.65, sizeRange: [2, 6], shape: 'petal' };
        case 'shinobu':
          return { colors: ['#c084fc', '#9333ea', '#a855f7', '#e9d5ff'], speed: 0.6, sizeRange: [2, 5], shape: 'butterfly' };
        case 'makima':
          return { colors: ['#f59e0b', '#e11d48', '#fb7185', '#fbbf24'], speed: 0.75, sizeRange: [1.8, 5], shape: 'thread' };
        default:
          return { colors: ['#75d9ff', '#38bdf8', '#7c3aed'], speed: 0.7, sizeRange: [2, 5], shape: 'orb' };
      }
    }

    function createParticles() {
      const isMobile = window.innerWidth <= 768;
      const count = isMobile ? 24 : 52;
      const cfg = getThemeParticleConfig(currentThemeId);
      particles = [];

      for (let i = 0; i < count; i++) {
        particles.push({
          x: Math.random() * canvas.width,
          y: Math.random() * canvas.height,
          radius: Math.random() * (cfg.sizeRange[1] - cfg.sizeRange[0]) + cfg.sizeRange[0],
          vx: (Math.random() - 0.5) * cfg.speed,
          vy: (Math.random() - 0.5) * cfg.speed - 0.2, // slight upward drift
          color: cfg.colors[Math.floor(Math.random() * cfg.colors.length)],
          alpha: Math.random() * 0.6 + 0.2,
          pulse: Math.random() * Math.PI * 2,
          shape: cfg.shape
        });
      }
    }

    function animateParticles() {
      if (document.hidden) {
        animationFrameId = requestAnimationFrame(animateParticles);
        return;
      }

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];

        // Subtle mouse repulsion / attraction
        if (isMouseMoving) {
          const dx = mouseX - p.x;
          const dy = mouseY - p.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 140) {
            const force = (140 - dist) / 140;
            p.x -= (dx / dist) * force * 1.8;
            p.y -= (dy / dist) * force * 1.8;
          }
        }

        p.x += p.vx;
        p.y += p.vy;
        p.pulse += 0.03;

        // Wrap around boundaries
        if (p.x < -20) p.x = canvas.width + 20;
        if (p.x > canvas.width + 20) p.x = -20;
        if (p.y < -20) p.y = canvas.height + 20;
        if (p.y > canvas.height + 20) p.y = -20;

        const currentAlpha = Math.max(0.1, p.alpha + Math.sin(p.pulse) * 0.18);

        ctx.save();
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        ctx.fillStyle = p.color;
        ctx.globalAlpha = currentAlpha;
        ctx.shadowColor = p.color;
        ctx.shadowBlur = p.radius * 3;
        ctx.fill();
        ctx.restore();
      }

      animationFrameId = requestAnimationFrame(animateParticles);
    }

    initCanvas();
    animateParticles();

    // ================================================================
    // THEME SWITCHING ENGINE (REAL TIME + LOCALSTORAGE + API)
    // ================================================================
    async function selectTheme(themeId) {
      const th = THEME_DATA[themeId];
      if (!th) return;

      currentThemeId = themeId;
      localStorage.setItem('goatverse_theme', themeId);
      document.documentElement.setAttribute('data-theme', themeId);

      // Update CSS Variables
      const root = document.documentElement;
      const c = th.colors || {};
      if (c.primary) root.style.setProperty('--primary', c.primary);
      if (c.accent) root.style.setProperty('--accent', c.accent);
      if (c.background) root.style.setProperty('--bg', c.background);
      if (c.surface) root.style.setProperty('--surface', c.surface);
      if (c.surfaceHover) root.style.setProperty('--surface-hover', c.surfaceHover);
      if (c.border) root.style.setProperty('--border', c.border);
      if (c.glow) root.style.setProperty('--glow', c.glow);
      if (c.accentGlow) root.style.setProperty('--accent-glow', c.accentGlow);

      // Update Artwork & Text Elements
      const imgPath = th.image || ('/assets/characters/' + th.id + '.jpg');
      const avatar = document.getElementById('header-avatar');
      const heroArt = document.getElementById('hero-art');
      if (avatar) avatar.src = imgPath;
      if (heroArt) heroArt.src = imgPath;

      const heroName = document.getElementById('hero-character-name');
      if (heroName) heroName.innerText = th.character;

      const heroVibe = document.getElementById('hero-theme-vibe');
      if (heroVibe) heroVibe.innerText = th.vibe;

      const heroIcon = document.getElementById('hero-theme-icon');
      if (heroIcon) heroIcon.innerText = th.icon;

      const heroQuote = document.getElementById('hero-quote');
      if (heroQuote) heroQuote.innerText = '"' + th.quote + '"';

      // Update Theme Cards Active State
      document.querySelectorAll('.theme-card').forEach(el => el.classList.remove('active'));
      const activeCard = document.getElementById('theme-card-' + themeId);
      if (activeCard) activeCard.classList.add('active');

      // Refresh canvas particles to match theme style
      createParticles();

      // Notify backend to update memory theme
      try {
        await fetch('/api/theme', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ theme: themeId })
        });
      } catch (_) {}
    }

    // Safe fallbacks for missing images
    function handleAvatarFallback(img) {
      img.onerror = null;
      img.src = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 80 80"><rect width="80" height="80" fill="%23121a38"/><text x="40" y="48" font-size="32" text-anchor="middle" fill="%2375d9ff">⚡</text></svg>';
    }

    function handleArtFallback(img) {
      img.onerror = null;
      img.src = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400"><rect width="400" height="400" fill="%23121a38"/><text x="200" y="210" font-size="60" text-anchor="middle" fill="%2375d9ff">⚡</text><text x="200" y="260" font-size="16" font-family="sans-serif" font-weight="bold" text-anchor="middle" fill="%23ffffff">GOATVERSE MD</text></svg>';
    }

    function handleCardFallback(img) {
      img.onerror = null;
      img.src = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200" viewBox="0 0 300 200"><rect width="300" height="200" fill="%2310172d"/><text x="150" y="110" font-size="36" text-anchor="middle" fill="%2375d9ff">⚡</text></svg>';
    }

    // ================================================================
    // WEB PAIRING 4-STEP FLOW (REAL BACKEND INTEGRATION)
    // ================================================================
    function handleCountryChange(val) {
      const input = document.getElementById('phone-input');
      if (val === 'custom') {
        input.placeholder = 'e.g. 447123456789';
      } else if (val === '92') {
        input.placeholder = '3195176242';
      } else {
        input.placeholder = 'Phone digits';
      }
      input.focus();
    }

    async function submitPhoneNumber() {
      const country = document.getElementById('country-select').value;
      const raw = (document.getElementById('phone-input').value || '').trim();
      const errEl = document.getElementById('phone-error-msg');
      errEl.style.display = 'none';

      let combined = raw;
      if (country !== 'custom') {
        const cleanDigits = raw.replace(/\\D/g, '').replace(/^0+/, '');
        combined = country + cleanDigits;
      } else {
        combined = raw.replace(/\\D/g, '');
      }

      if (!combined || combined.length < 8 || combined.length > 15) {
        errEl.innerText = 'Please enter a valid international phone number (8 to 15 digits).';
        errEl.style.display = 'block';
        return;
      }

      userHasSubmitted = true;
      targetPhoneNumber = combined;
      document.getElementById('loading-target-phone').innerText = '+' + combined;

      // STEP 2: Show loading aura stage
      showStage('loading');
      updateTimeline(1, 'active');

      const btn = document.getElementById('btn-submit');
      if (btn) btn.disabled = true;

      try {
        const res = await fetch('/api/pairing/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phoneNumber: combined })
        });

        const data = await res.json();
        if (!res.ok || !data.success) {
          throw new Error(data.error || 'Failed to request pairing code');
        }

        if (data.pairingCode) {
          currentPairingCode = data.pairingCode;
          renderPairingCode(data.pairingCode);
          showStage('code');
          updateTimeline(2, 'active');
        } else {
          // Poll until socket returns code
          pollForPairingCode();
        }
      } catch (err) {
        showStage('phone');
        if (btn) btn.disabled = false;
        errEl.innerText = err.message || 'Connection error. Please try again.';
        errEl.style.display = 'block';
      }
    }

    function showStage(stage) {
      document.getElementById('stage-phone').classList.toggle('active', stage === 'phone');
      document.getElementById('stage-loading').classList.toggle('active', stage === 'loading');
      document.getElementById('stage-code').classList.toggle('active', stage === 'code');
      document.getElementById('stage-connected').classList.toggle('active', stage === 'connected');
    }

    function returnToPhoneInput() {
      showStage('phone');
      const btn = document.getElementById('btn-submit');
      if (btn) btn.disabled = false;
      updateTimeline(0, 'active');
    }

    function renderPairingCode(code) {
      if (!code) return;
      const clean = code.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      const container = document.getElementById('code-tiles-container');
      if (!container) return;

      let html = '';
      for (let i = 0; i < clean.length; i++) {
        if (i === 4 && clean.length >= 8) {
          html += '<div class="code-char-divider">-</div>';
        }
        html += '<div class="code-char-box">' + clean[i] + '</div>';
      }
      container.innerHTML = html;
    }

    function copyPairingCode() {
      if (!currentPairingCode) return;
      const raw = currentPairingCode.replace(/[^A-Za-z0-9]/g, '');
      navigator.clipboard.writeText(raw).then(() => {
        const btn = document.getElementById('btn-copy-code');
        btn.innerHTML = '<span>✓</span><span>Copied!</span>';
        setTimeout(() => {
          btn.innerHTML = '<span>📋</span><span>Copy Pairing Code</span>';
        }, 2000);
      });
    }

    async function regeneratePairingCode() {
      const btn = document.getElementById('btn-regenerate');
      btn.innerHTML = '<span>⏳</span><span>Summoning...</span>';
      try {
        const res = await fetch('/api/pairing/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phoneNumber: targetPhoneNumber })
        });
        const data = await res.json();
        if (data.pairingCode) {
          currentPairingCode = data.pairingCode;
          renderPairingCode(data.pairingCode);
        }
      } catch (_) {}
      setTimeout(() => {
        btn.innerHTML = '<span>🔄</span><span>Regenerate</span>';
      }, 1500);
    }

    function pollForPairingCode() {
      let tries = 0;
      const timer = setInterval(async () => {
        tries++;
        if (tries > 25) {
          clearInterval(timer);
          return;
        }
        try {
          const res = await fetch('/api/status');
          if (!res.ok) return;
          const data = await res.json();
          if (data.pairingCode) {
            clearInterval(timer);
            currentPairingCode = data.pairingCode;
            renderPairingCode(data.pairingCode);
            showStage('code');
            updateTimeline(2, 'active');
          }
        } catch (_) {}
      }, 1500);
    }

    // Timeline Pipeline State Update
    function updateTimeline(stepNumber, state) {
      for (let i = 1; i <= 5; i++) {
        const el = document.getElementById('step-node-' + i);
        if (!el) continue;
        el.classList.remove('active', 'completed');
        if (i < stepNumber) {
          el.classList.add('completed');
        } else if (i === stepNumber) {
          el.classList.add(state === 'completed' ? 'completed' : 'active');
        }
      }

      const txt = document.getElementById('timeline-status-text');
      if (txt) {
        if (stepNumber === 5 && state === 'completed') {
          txt.innerText = 'Online & Active';
          txt.style.color = '#22c55e';
        } else if (stepNumber === 0) {
          txt.innerText = 'Ready to Connect';
          txt.style.color = 'var(--text-muted)';
        } else {
          txt.innerText = 'Step ' + stepNumber + ' of 5 in Progress';
          txt.style.color = 'var(--primary)';
        }
      }
    }

    // Real-time Status Poller for Baileys Socket
    setInterval(async () => {
      try {
        const res = await fetch('/api/status');
        if (!res.ok) return;
        const data = await res.json();

        const dot = document.getElementById('live-dot-indicator');
        const label = document.getElementById('live-status-label');

        if (data.status === 'connected') {
          if (dot) dot.className = 'live-dot online';
          if (label) label.innerText = 'Online';

          showStage('connected');
          updateTimeline(5, 'completed');
        } else if (data.status === 'pairing') {
          if (dot) dot.className = 'live-dot pairing';
          if (label) label.innerText = 'Pairing Ready';

          if (userHasSubmitted && data.pairingCode) {
            currentPairingCode = data.pairingCode;
            renderPairingCode(data.pairingCode);
            showStage('code');
            updateTimeline(3, 'active');
          }
        }
      } catch (_) {}
    }, 2500);

    // ================================================================
    // COMMANDS SEARCH & CATEGORY FILTER
    // ================================================================
    let activeCategory = 'all';
    let searchQuery = '';

    function selectCategory(cat, btn) {
      activeCategory = cat;
      document.querySelectorAll('.cat-pill').forEach(b => b.classList.remove('active'));
      if (btn) btn.classList.add('active');
      applyCommandFilters();
    }

    function filterCommands(query) {
      searchQuery = (query || '').toLowerCase().trim();
      applyCommandFilters();
    }

    function applyCommandFilters() {
      const cards = document.querySelectorAll('.command-item-card');
      cards.forEach(card => {
        const cat = card.getAttribute('data-category');
        const text = card.innerText.toLowerCase();
        const matchesCategory = activeCategory === 'all' || cat === activeCategory;
        const matchesSearch = !searchQuery || text.includes(searchQuery);

        card.style.display = matchesCategory && matchesSearch ? 'flex' : 'none';
      });
    }

    function copyCommandSyntax(syntax) {
      navigator.clipboard.writeText(syntax).then(() => {
        const temp = document.createElement('div');
        temp.style.position = 'fixed';
        temp.style.bottom = '24px';
        temp.style.right = '24px';
        temp.style.background = 'var(--primary)';
        temp.style.color = '#0b1120';
        temp.style.fontWeight = '700';
        temp.style.padding = '10px 18px';
        temp.style.borderRadius = '30px';
        temp.style.boxShadow = '0 6px 20px rgba(0,0,0,0.5)';
        temp.style.zIndex = '9999';
        temp.innerText = 'Copied ' + syntax;
        document.body.appendChild(temp);
        setTimeout(() => temp.remove(), 1800);
      });
    }

    // Load saved theme if existing
    const savedTheme = localStorage.getItem('goatverse_theme');
    if (savedTheme && savedTheme !== currentThemeId && THEME_DATA[savedTheme]) {
      selectTheme(savedTheme);
    }
  </script>
</body>
</html>`;
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeJs(str) {
  return String(str || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"');
}

function createWebServer({ config, liveStatus, recentLogs, getActiveTheme, listThemes, getPublicMode, port = 3000, host = '0.0.0.0', onRefreshPairingCode }) {
  const publicDir = path.resolve(__dirname, '..', 'public');
  let currentWebThemeId = config.theme || 'default';

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    // Serve static character assets from /assets/characters/*
    if (url.pathname.startsWith('/assets/characters/')) {
      const fileName = path.basename(url.pathname);
      const filePath = path.join(publicDir, 'assets', 'characters', fileName);

      if (fs.existsSync(filePath)) {
        res.writeHead(200, {
          'Content-Type': 'image/jpeg',
          'Cache-Control': 'public, max-age=86400',
          'Access-Control-Allow-Origin': '*'
        });
        const stream = fs.createReadStream(filePath);
        return stream.pipe(res);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('Asset not found');
      }
    }

    // Health check endpoint
    if (url.pathname === '/health' || url.pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        status: 'ok',
        bot: config.masterBotName,
        connected: liveStatus.status === 'connected',
        uptime: Math.floor(process.uptime())
      }));
    }

    // Live status API
    if (url.pathname === '/api/status' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const currentTheme = getActiveTheme(currentWebThemeId);
      return res.end(JSON.stringify({
        name: config.masterBotName,
        botNumber: config.botNumber,
        owner: config.instanceOwnerName,
        status: liveStatus.status,
        pairingCode: liveStatus.pairingCode,
        lastQr: liveStatus.lastQr,
        authMethod: config.authMethod,
        publicMode: typeof getPublicMode === 'function' ? getPublicMode() : config.publicMode,
        commandPrefix: config.commandPrefix,
        theme: currentTheme.id,
        uptime: Math.floor(process.uptime()),
        logs: recentLogs.slice(-30)
      }));
    }

    // Command catalog API
    if (url.pathname === '/api/commands' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(COMMANDS_CATALOG));
    }

    // Trigger pairing code request / refresh with optional phone number
    if ((url.pathname === '/api/pairing/request' || url.pathname === '/api/pair') && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
        if (body.length > 10000) req.destroy();
      });
      req.on('end', async () => {
        let phoneNumber;
        try {
          if (body.trim()) {
            const parsed = JSON.parse(body);
            phoneNumber = parsed.phoneNumber || parsed.number;
          }
        } catch (_) {}

        try {
          let code;
          if (typeof onRefreshPairingCode === 'function') {
            code = await onRefreshPairingCode(phoneNumber);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            success: true,
            pairingCode: code || liveStatus.pairingCode,
            botNumber: config.botNumber,
            status: liveStatus.status
          }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            success: false,
            error: err.message || 'Failed to request pairing code'
          }));
        }
      });
      return;
    }

    // Theme details and catalog
    if ((url.pathname === '/api/theme' || url.pathname === '/api/themes') && req.method === 'GET') {
      const activeTheme = getActiveTheme(currentWebThemeId);
      const allThemes = typeof listThemes === 'function' ? listThemes() : [activeTheme];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ activeTheme, allThemes }));
    }

    // Update active theme in memory
    if (url.pathname === '/api/theme' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
        if (body.length > 10_000) req.destroy();
      });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const requestedThemeId = String(parsed.theme || '').trim().toLowerCase();
          const activeTheme = getActiveTheme(requestedThemeId);
          if (!requestedThemeId || activeTheme.id !== requestedThemeId) {
            throw new Error('Unknown theme.');
          }
          currentWebThemeId = activeTheme.id;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: true, activeTheme: currentWebThemeId }));
        } catch (error) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: error.message || 'Invalid theme request.' }));
        }
      });
      return;
    }

    // Main HTML anime web pairing interface
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    const activeTheme = getActiveTheme(currentWebThemeId);
    const allThemes = typeof listThemes === 'function' ? listThemes() : [activeTheme];
    const html = renderDashboardHtml({
      config,
      activeTheme,
      liveStatus,
      recentLogs,
      allThemes
    });
    res.end(html);
  });

  server.listen(port, host, () => {
    console.log(`[web] ${config.masterBotName} anime web pairing interface listening on http://${host}:${port}`);
  });

  return server;
}

module.exports = {
  createWebServer,
  COMMANDS_CATALOG
};
