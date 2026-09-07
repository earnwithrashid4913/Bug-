'use strict';

/* ---------------------------------------------------------------------------
   Dashboard behaviour.
   All theme values arrive from /api/bootstrap (system/theme.js is the single
   source of truth). This file only applies them and drives the artwork
   rotation, particles, live connection state and the web pairing flow.
--------------------------------------------------------------------------- */

(() => {
  const state = {
    themes: [],
    byId: new Map(),
    activeThemeId: null,
    images: [],
    imageIndex: -1,
    failedImages: new Set(),
    slides: [],
    activeSlide: 0,
    statusTimer: null,
    failureTimer: null,
    preload: null,
    connected: false,
    reducedMotion: false,
    particles: null
  };

  const el = {};
  const root = document.documentElement;
  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const STORAGE_KEY = 'dashboard.theme';

  const COLOR_VARIABLES = Object.freeze({
    primary: '--primary',
    accent: '--accent',
    background: '--bg',
    surface: '--surface',
    surfaceHover: '--surface-hover',
    border: '--border',
    text: '--text',
    textMuted: '--text-muted',
    glow: '--glow',
    accentGlow: '--accent-glow',
    gradient: '--gradient',
    overlay: '--overlay',
    pairingGlow: '--pairing-glow'
  });

  const STATUS_LABELS = Object.freeze({
    starting: 'Starting…',
    connecting: 'Connecting…',
    pairing: 'Awaiting code',
    connected: 'Connected',
    disconnected: 'Disconnected',
    logged_out: 'Logged out',
    dry_run: 'Dry run',
    error: 'Error'
  });

  function cacheElements() {
    const ids = [
      'botName', 'ownerName', 'botNumber', 'themeName', 'themeIcon', 'themeSeries', 'themeVibe',
      'themeTagline', 'themeQuote', 'themeCharacter', 'themeGrid', 'statusPill', 'statusText',
      'pairForm', 'phoneNumber', 'pairButton', 'formMessage', 'codeBox', 'codeValue',
      'copyButton', 'regenerateButton', 'linkedBox', 'linkedText', 'steps', 'particles',
      'bgSlideA', 'bgSlideB', 'credit'
    ];
    for (const id of ids) el[id] = document.getElementById(id);
    el.stage = document.querySelector('.stage');
    el.shell = document.querySelector('.shell');
    state.slides = [el.bgSlideA, el.bgSlideB];
  }

  async function fetchJson(url, options) {
    const response = await fetch(url, options);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      const error = new Error(payload.error || `Request failed (${response.status}).`);
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  function setMessage(text, kind) {
    el.formMessage.textContent = text || '';
    el.formMessage.className = `form-message${kind ? ` is-${kind}` : ''}`;
  }

  function setStep(activeStep) {
    for (const node of el.steps.children) {
      const index = Number(node.dataset.step);
      node.classList.toggle('is-active', index === activeStep);
      node.classList.toggle('is-done', index < activeStep);
    }
  }

  /* ------------------------------ theming ------------------------------ */

  function applyThemeVariables(theme) {
    for (const [key, variable] of Object.entries(COLOR_VARIABLES)) {
      if (theme.colors[key]) root.style.setProperty(variable, theme.colors[key]);
    }
    root.dataset.theme = theme.id;
  }

  function applyTheme(themeId, { persist = true, restart = true } = {}) {
    const theme = state.byId.get(themeId) || state.themes[0];
    if (!theme) return;

    const changed = theme.id !== state.activeThemeId;
    state.activeThemeId = theme.id;

    applyThemeVariables(theme);

    el.themeName.textContent = theme.name;
    el.themeIcon.textContent = theme.icon;
    el.themeSeries.textContent = theme.series;
    el.themeVibe.textContent = theme.vibe;
    el.themeTagline.textContent = theme.tagline;
    el.themeQuote.textContent = `“${theme.quote}”`;
    el.themeCharacter.textContent = `${theme.character} · ${theme.series}`;

    for (const chip of el.themeGrid.children) {
      chip.setAttribute('aria-pressed', String(chip.dataset.theme === theme.id));
    }

    if (persist) {
      try {
        window.localStorage.setItem(STORAGE_KEY, theme.id);
      } catch {
        /* private mode: the in-memory theme still applies */
      }
    }

    if (restart || changed) {
      state.failedImages.clear();
      state.imageIndex = -1;
      state.images = [...theme.images];
      el.stage.dataset.images = 'on';
      showNextImage(true);
      configureParticles(theme);
    }
  }

  function renderThemeChips() {
    const fragment = document.createDocumentFragment();

    for (const theme of state.themes) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'theme-chip';
      chip.dataset.theme = theme.id;
      chip.setAttribute('aria-pressed', 'false');

      const swatch = document.createElement('span');
      swatch.className = 'chip-swatch';
      swatch.textContent = theme.icon;
      swatch.style.setProperty('--chip-primary', theme.colors.primary);
      swatch.style.setProperty('--chip-accent', theme.colors.accent);
      swatch.style.setProperty('--chip-glow', theme.colors.glow);

      const text = document.createElement('span');
      text.className = 'chip-text';

      const name = document.createElement('span');
      name.className = 'chip-name';
      name.textContent = theme.name;

      const vibe = document.createElement('span');
      vibe.className = 'chip-vibe';
      vibe.textContent = theme.vibe;

      text.append(name, vibe);
      chip.append(swatch, text);
      chip.style.setProperty('--chip-primary', theme.colors.primary);
      chip.style.setProperty('--chip-accent', theme.colors.accent);
      chip.style.setProperty('--chip-glow', theme.colors.glow);

      chip.addEventListener('click', () => selectTheme(theme.id));
      fragment.append(chip);
    }

    el.themeGrid.replaceChildren(fragment);
  }

  async function selectTheme(themeId) {
    if (themeId === state.activeThemeId) return;

    // Apply immediately so the transition is seamless; the server call only
    // keeps the backend record of the active theme in sync.
    applyTheme(themeId);

    try {
      await fetchJson('/api/theme', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ themeId })
      });
    } catch {
      /* the local theme is already applied; nothing to recover */
    }
  }

  /* --------------------------- image rotation --------------------------- */

  function nextImageIndex() {
    const total = state.images.length;
    if (!total) return -1;

    for (let step = 1; step <= total; step += 1) {
      const candidate = (state.imageIndex + step) % total;
      if (!state.failedImages.has(state.images[candidate])) return candidate;
    }
    return -1;
  }

  function preloadFollowing() {
    const total = state.images.length;
    if (total < 2 || state.failedImages.size >= total) return;

    const following = nextImageIndex();
    if (following < 0) return;

    const url = state.images[following];
    if (state.preload && state.preload.src === url) return;

    // Warm the browser cache for exactly one upcoming frame.
    const image = new Image();
    image.decoding = 'async';
    image.src = url;
    state.preload = image;
  }

  function handleImageFailure(url) {
    state.failedImages.add(url);

    if (state.failedImages.size >= state.images.length) {
      // Every hosted frame for this theme failed: keep the themed gradient,
      // glow and particles instead of showing a broken image.
      el.stage.dataset.images = 'off';
      return;
    }

    clearTimeout(state.failureTimer);
    state.failureTimer = setTimeout(() => showNextImage(true), 600);
  }

  function showNextImage(immediate = false) {
    const index = nextImageIndex();
    if (index < 0) return;

    const url = state.images[index];
    state.imageIndex = index;

    const incoming = state.slides[1 - state.activeSlide];
    const outgoing = state.slides[state.activeSlide];
    const image = incoming.querySelector('img');

    const activate = () => {
      image.onload = null;
      image.onerror = null;
      incoming.classList.add('is-active');
      if (outgoing !== incoming) outgoing.classList.remove('is-active');
      state.activeSlide = 1 - state.activeSlide;
      preloadFollowing();
    };

    const fail = () => {
      image.onload = null;
      image.onerror = null;
      handleImageFailure(url);
    };

    image.onload = activate;
    image.onerror = fail;
    image.decoding = 'async';
    image.loading = immediate ? 'eager' : 'lazy';
    image.src = url;

    // Already cached: the load event will not fire again.
    if (image.complete && image.naturalWidth > 0) activate();
  }

  function tick() {
    showNextImage();
  }

  // No automatic rotation: display the selected theme's primary image only.

  /* ------------------------------ particles ----------------------------- */

  function configureParticles(theme) {
    const canvas = el.particles;
    const context = canvas.getContext('2d');
    const profile = theme.particles;
    const mobile = window.innerWidth < 768;
    const count = state.reducedMotion ? 0 : (mobile ? profile.mobileCount : profile.desktopCount);
    const ratio = Math.min(window.devicePixelRatio || 1, 2);

    const resize = () => {
      canvas.width = Math.floor(window.innerWidth * ratio);
      canvas.height = Math.floor(window.innerHeight * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };

    const spawn = () => ({
      x: Math.random() * window.innerWidth,
      y: Math.random() * window.innerHeight,
      radius: profile.size[0] + Math.random() * (profile.size[1] - profile.size[0]),
      color: profile.colors[Math.floor(Math.random() * profile.colors.length)],
      phase: Math.random() * Math.PI * 2,
      speed: profile.speed * (0.55 + Math.random() * 0.9),
      alpha: profile.opacity * (0.45 + Math.random() * 0.55)
    });

    state.particles = {
      context,
      profile,
      items: Array.from({ length: count }, spawn),
      resize,
      spawn,
      frame: 0,
      handle: null
    };

    resize();
    startParticles();
  }

  function updateParticle(item, width, height, time) {
    const { profile } = state.particles;

    switch (profile.behavior) {
      case 'ember':
        item.y -= item.speed * 1.7;
        item.x += Math.sin(time * 0.002 + item.phase) * 0.6;
        item.alpha = profile.opacity * (0.35 + Math.abs(Math.sin(time * 0.004 + item.phase)) * 0.65);
        break;
      case 'blade':
        item.x += item.speed * 1.9;
        item.y += item.speed * 0.7;
        break;
      case 'wave':
        item.x += item.speed * 1.3;
        item.y += Math.sin(item.x / 90 + item.phase) * 0.4;
        break;
      case 'flutter':
        item.x += Math.sin(time * 0.0013 + item.phase) * 1.15;
        item.y -= item.speed * 0.55;
        break;
      case 'cosmic':
        item.x += Math.cos(time * 0.0006 + item.phase) * item.speed * 0.7;
        item.y -= item.speed * 0.35;
        item.alpha = profile.opacity * (0.4 + Math.abs(Math.sin(time * 0.0015 + item.phase)) * 0.6);
        break;
      case 'float':
        item.y -= item.speed * 0.35;
        item.x += Math.sin(time * 0.0008 + item.phase) * 0.3;
        break;
      default: // "dust" — slow, controlled drift
        item.y -= item.speed * 0.2;
        item.x += Math.sin(time * 0.0005 + item.phase) * 0.16;
        break;
    }

    if (item.y < -20) {
      item.y = height + 20;
      item.x = Math.random() * width;
    }
    if (item.y > height + 20) {
      item.y = -20;
      item.x = Math.random() * width;
    }
    if (item.x > width + 20) item.x = -20;
    if (item.x < -20) item.x = width + 20;
  }

  function drawParticle(item, time) {
    const { context, profile } = state.particles;

    context.globalAlpha = item.alpha;
    context.fillStyle = item.color;
    context.strokeStyle = item.color;

    if (profile.shape === 'butterfly') {
      const flap = Math.abs(Math.sin(time * 0.006 + item.phase));
      context.beginPath();
      context.ellipse(item.x - item.radius * 0.7, item.y, item.radius * 0.9, item.radius * (0.35 + flap), -0.4, 0, Math.PI * 2);
      context.ellipse(item.x + item.radius * 0.7, item.y, item.radius * 0.9, item.radius * (0.35 + flap), 0.4, 0, Math.PI * 2);
      context.fill();
      return;
    }

    if (profile.shape === 'shard') {
      context.lineWidth = Math.max(1, item.radius * 0.7);
      context.beginPath();
      context.moveTo(item.x, item.y);
      context.lineTo(item.x - item.radius * 5, item.y - item.radius * 1.8);
      context.stroke();
      return;
    }

    context.beginPath();
    context.arc(item.x, item.y, item.radius, 0, Math.PI * 2);
    context.fill();
  }

  function particleFrame(time) {
    const engine = state.particles;
    if (!engine) return;

    const { context, items } = engine;
    const width = window.innerWidth;
    const height = window.innerHeight;

    context.clearRect(0, 0, width, height);
    context.globalCompositeOperation = 'lighter';
    context.shadowBlur = engine.profile.glow;

    for (const item of items) {
      context.shadowColor = item.color;
      updateParticle(item, width, height, time);
      drawParticle(item, time);
    }

    context.globalCompositeOperation = 'source-over';
    context.shadowBlur = 0;
    context.globalAlpha = 1;

    engine.handle = window.requestAnimationFrame(particleFrame);
  }

  function startParticles() {
    stopParticles();
    if (!state.particles || !state.particles.items.length || document.hidden) return;
    state.particles.handle = window.requestAnimationFrame(particleFrame);
  }

  function stopParticles() {
    if (state.particles?.handle) {
      window.cancelAnimationFrame(state.particles.handle);
      state.particles.handle = null;
    }
  }

  /* --------------------------- connection state ------------------------- */

  function renderStatus(status) {
    if (!status) return;

    const key = STATUS_LABELS[status.state] ? status.state : 'connecting';
    el.statusPill.dataset.state = key;
    el.statusText.textContent = STATUS_LABELS[key];

    state.connected = Boolean(status.connected);

    if (state.connected) {
      el.linkedBox.hidden = false;
      el.codeBox.hidden = true;
      el.pairButton.disabled = true;
      el.pairButton.textContent = 'WhatsApp is linked';
      el.linkedText.textContent = status.message || 'WhatsApp is linked and the bot is live.';
      setStep(5);
      return;
    }

    el.pairButton.disabled = false;
    el.pairButton.textContent = 'Generate pairing code';
    el.linkedBox.hidden = true;

    if (status.pairingCode && el.codeBox.hidden) {
      revealCode(status.pairingCode);
    }
  }

  async function pollStatus() {
    try {
      renderStatus(await fetchJson('/api/status'));
    } catch {
      el.statusPill.dataset.state = 'error';
      el.statusText.textContent = 'Status unavailable';
    }
  }

  function startStatusPolling() {
    clearInterval(state.statusTimer);
    state.statusTimer = setInterval(pollStatus, 4000);
  }

  /* ------------------------------- pairing ------------------------------ */

  function revealCode(code) {
    el.codeValue.textContent = code;
    el.codeBox.hidden = false;
    el.linkedBox.hidden = true;
    setStep(3);
  }

  async function requestPairingCode(event) {
    if (event) event.preventDefault();
    if (state.connected) return;

    const raw = el.phoneNumber.value.trim();

    if (raw.includes('+')) {
      el.phoneNumber.classList.add('is-invalid');
      setMessage('Remove the "+". Enter your WhatsApp number with country code, without +.', 'error');
      return;
    }
    if (!/^\d{7,15}$/.test(raw)) {
      el.phoneNumber.classList.add('is-invalid');
      setMessage('Use 7-15 digits including the country code, for example 923001234567.', 'error');
      return;
    }

    el.phoneNumber.classList.remove('is-invalid');
    el.pairButton.disabled = true;
    el.pairButton.textContent = 'Requesting code…';
    setMessage('Asking WhatsApp for a pairing code…');
    setStep(2);

    try {
      const result = await fetchJson('/api/pairing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: raw })
      });
      revealCode(result.code);
      setMessage('Open WhatsApp → Linked devices → Link with phone number instead.', 'ok');
      pollStatus();
    } catch (error) {
      setMessage(error.message, 'error');
      setStep(1);
    } finally {
      if (!state.connected) {
        el.pairButton.disabled = false;
        el.pairButton.textContent = 'Generate pairing code';
      }
    }
  }

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(el.codeValue.textContent.trim());
      el.copyButton.textContent = 'Copied';
      setTimeout(() => {
        el.copyButton.textContent = 'Copy code';
      }, 1600);
    } catch {
      setMessage('Copy failed — select the code manually.', 'error');
    }
  }

  /* ------------------------------ lifecycle ----------------------------- */

  function bindEvents() {
    el.pairForm.addEventListener('submit', requestPairingCode);
    el.regenerateButton.addEventListener('click', requestPairingCode);
    el.copyButton.addEventListener('click', copyCode);

    const onVisibility = () => {
      if (document.hidden) {
        stopParticles();
      } else {
        startParticles();
      }
    };

    document.addEventListener('visibilitychange', onVisibility);

    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => state.particles?.resize(), 180);
    });

    // Never leak timers or animation frames past the page lifetime.
    window.addEventListener('pagehide', () => {
      stopParticles();
      clearInterval(state.statusTimer);
      clearTimeout(state.failureTimer);
      clearTimeout(resizeTimer);
    }, { once: true });

    motionQuery.addEventListener('change', (event) => {
      state.reducedMotion = event.matches;
      const theme = state.byId.get(state.activeThemeId);
      if (theme) configureParticles(theme);
    });
  }

  function readStoredTheme() {
    try {
      return window.localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  }

  async function init() {
    cacheElements();
    state.reducedMotion = motionQuery.matches;

    const bootstrap = await fetchJson('/api/bootstrap');

    state.themes = bootstrap.themes;
    state.byId = new Map(bootstrap.themes.map((theme) => [theme.id, theme]));

    el.botName.textContent = bootstrap.botName;
    el.ownerName.textContent = bootstrap.ownerName;
    el.botNumber.textContent = bootstrap.botNumber;
    el.phoneNumber.value = bootstrap.botNumber;
    el.credit.textContent = `Developed By: ${bootstrap.developer}`;

    renderThemeChips();
    bindEvents();

    const preferred = readStoredTheme();
    applyTheme(state.byId.has(preferred) ? preferred : bootstrap.activeThemeId, { persist: false });

    renderStatus(bootstrap.connection);
    startStatusPolling();

    el.shell.classList.add('is-ready');
  }

  init().catch((error) => {
    console.error('[dashboard] Failed to start:', error);
    const shell = document.querySelector('.shell');
    if (shell) shell.classList.add('is-ready');
    const statusText = document.getElementById('statusText');
    if (statusText) statusText.textContent = 'Dashboard offline';
  });
})();
