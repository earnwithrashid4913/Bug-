'use strict';

// Runtime verification for public/app.js. There is no browser in CI, so this
// harness drives the real script inside a vm with a minimal DOM: it proves the
// dashboard boots, rotates artwork on one 5s timer, preloads the next frame,
// survives broken images, repaints on theme change, and never claims a
// connection the server did not report.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const { PUBLIC_DIR } = require('../system/web');
const { ROTATION_INTERVAL_MS, THEMES } = require('../system/theme');

const APP_SOURCE = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8');

const ELEMENT_IDS = [
  'botName', 'ownerName', 'botNumber', 'themeName', 'themeIcon', 'themeSeries', 'themeVibe',
  'themeTagline', 'themeQuote', 'themeCharacter', 'themeGrid', 'statusPill', 'statusText',
  'pairForm', 'phoneNumber', 'pairButton', 'formMessage', 'codeBox', 'codeValue',
  'copyButton', 'regenerateButton', 'linkedBox', 'linkedText', 'steps', 'particles',
  'bgSlideA', 'bgSlideB', 'rotationNote', 'credit',
  'sessionCard', 'sessionHint', 'sessionExport', 'sessionValue', 'copySessionButton', 'sessionDisabledNote'
];

const BOOTSTRAP = {
  botName: 'ANIME MD',
  ownerName: 'F!xa Dev',
  botNumber: '923001234567',
  developer: 'F!xa Dev',
  rotationIntervalMs: ROTATION_INTERVAL_MS,
  activeThemeId: 'gojo',
  session: { exportEnabled: false, configured: false },
  themes: THEMES.map((theme) => ({
    id: theme.id,
    name: theme.name,
    character: theme.character,
    series: theme.series,
    icon: theme.icon,
    vibe: theme.vibe,
    tagline: theme.tagline,
    quote: theme.quote,
    images: [...theme.images],
    colors: { ...theme.colors },
    animation: { ...theme.animation },
    particles: { ...theme.particles }
  })),
  connection: { state: 'starting', connected: false, message: 'Starting…', pairingCode: null }
};

function createClassList() {
  const classes = new Set();
  return {
    set: classes,
    add: (name) => classes.add(name),
    remove: (name) => classes.delete(name),
    contains: (name) => classes.has(name),
    toggle(name, force) {
      const enabled = force === undefined ? !classes.has(name) : Boolean(force);
      if (enabled) classes.add(name);
      else classes.delete(name);
      return enabled;
    }
  };
}

function createElement(tag = 'div', id = '') {
  const listeners = {};
  const element = {
    tagName: tag,
    id,
    children: [],
    dataset: {},
    hidden: false,
    disabled: false,
    value: '',
    textContent: '',
    width: 0,
    height: 0,
    attrs: {},
    classList: createClassList(),
    style: {
      properties: new Map(),
      setProperty(name, value) {
        this.properties.set(name, value);
      }
    },
    setAttribute(name, value) {
      this.attrs[name] = String(value);
    },
    getAttribute(name) {
      return this.attrs[name];
    },
    append(...nodes) {
      this.children.push(...nodes);
    },
    replaceChildren(...nodes) {
      this.children = nodes.flatMap((node) => (node.isFragment ? node.children : [node]));
    },
    addEventListener(type, handler) {
      (listeners[type] ||= []).push(handler);
    },
    dispatch(type, event = {}) {
      for (const handler of listeners[type] || []) handler({ preventDefault() {}, ...event });
    },
    querySelector(selector) {
      return this.selectors?.[selector];
    },
    getContext() {
      return this.context2d;
    }
  };

  // A real element keeps className and classList in sync.
  Object.defineProperty(element, 'className', {
    get() {
      return [...element.classList.set].join(' ');
    },
    set(value) {
      element.classList.set.clear();
      for (const name of String(value).split(/\s+/).filter(Boolean)) element.classList.set.add(name);
    }
  });

  return element;
}

// Gives an element the load/error behaviour of a real <img>.
function attachImageBehaviour(element, loaded, failing) {
  let currentSrc = '';

  element.complete = false;
  element.naturalWidth = 0;
  element.decoding = '';
  element.loading = '';
  element.onload = null;
  element.onerror = null;

  Object.defineProperty(element, 'src', {
    get() {
      return currentSrc;
    },
    set(url) {
      currentSrc = url;
      loaded.push(url);
      Promise.resolve().then(() => {
        if (failing.has(url)) {
          element.complete = false;
          element.naturalWidth = 0;
          element.onerror?.();
        } else {
          element.complete = true;
          element.naturalWidth = 1024;
          element.onload?.();
        }
      });
    }
  });

  return element;
}

function createFakeImage(loaded, failing) {
  return class FakeImage {
    constructor() {
      attachImageBehaviour(this, loaded, failing);
    }
  };
}

function createClock() {
  const scheduled = new Map();
  const clock = {
    now: 0,
    nextId: 1,
    setTimeout(fn, ms = 0) {
      const id = clock.nextId++;
      scheduled.set(id, { fn, at: clock.now + ms, interval: null });
      return id;
    },
    setInterval(fn, ms = 0) {
      const id = clock.nextId++;
      scheduled.set(id, { fn, at: clock.now + ms, interval: ms });
      return id;
    },
    clearTimeout(id) {
      scheduled.delete(id);
    },
    clearInterval(id) {
      scheduled.delete(id);
    },
    tick(ms) {
      const target = clock.now + ms;
      for (;;) {
        let due = null;
        for (const [id, timer] of scheduled) {
          if (timer.at <= target && (!due || timer.at < due.timer.at)) due = { id, timer };
        }
        if (!due) break;

        clock.now = due.timer.at;
        if (due.timer.interval) due.timer.at = clock.now + due.timer.interval;
        else scheduled.delete(due.id);
        due.timer.fn();
      }
      clock.now = target;
    },
    count: () => scheduled.size
  };

  return clock;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

async function createDashboard({ failing = new Set(), status = BOOTSTRAP.connection, width = 1280 } = {}) {
  const clock = createClock();
  const loaded = [];
  const requests = [];
  const elements = new Map();

  for (const id of ELEMENT_IDS) elements.set(id, createElement(id.includes('bg') ? 'div' : 'div', id));

  // Each background slide owns one <img>, exactly like the markup.
  for (const slideId of ['bgSlideA', 'bgSlideB']) {
    const image = attachImageBehaviour(createElement('img'), loaded, failing);
    elements.get(slideId).selectors = { img: image };
    elements.get(slideId).image = image;
  }

  const steps = createElement('ol', 'steps');
  steps.children = [1, 2, 3, 4].map((index) => {
    const step = createElement('li');
    step.dataset.step = String(index);
    return step;
  });
  elements.set('steps', steps);

  const canvas = elements.get('particles');
  canvas.context2d = {
    calls: [],
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    shadowBlur: 0,
    shadowColor: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    clearRect(...args) { this.calls.push(['clearRect', ...args]); },
    setTransform() {},
    beginPath() {},
    arc() {},
    fill() {},
    stroke() {},
    moveTo() {},
    lineTo() {},
    ellipse() {}
  };

  const stage = createElement('div');
  stage.dataset.images = 'on';
  const shell = createElement('main');
  const root = createElement('html');

  let currentStatus = { ...status };
  const responses = {
    '/api/bootstrap': () => ({ ok: true, body: { ...BOOTSTRAP, connection: currentStatus } }),
    '/api/status': () => ({ ok: true, body: currentStatus }),
    '/api/theme': () => ({ ok: true, body: { ok: true, activeThemeId: 'gojo' } }),
    '/api/pairing': () => ({ ok: true, body: { ok: true, code: 'ABCD1234', number: '923001234567' } })
  };

  const globals = {
    console,
    Promise,
    setTimeout: clock.setTimeout,
    setInterval: clock.setInterval,
    clearTimeout: clock.clearTimeout,
    clearInterval: clock.clearInterval,
    Image: createFakeImage(loaded, failing),
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : undefined;
      requests.push({ url, method: options.method || 'GET', body });
      const responder = responses[url];
      assert.ok(responder, `unexpected request to ${url}`);
      const { ok, body: payload } = responder(body);
      return {
        ok,
        status: ok ? 200 : 400,
        headers: { get: () => 'application/json' },
        json: async () => payload
      };
    },
    document: {
      documentElement: root,
      hidden: false,
      getElementById: (id) => elements.get(id) || null,
      querySelector: (selector) => (selector === '.stage' ? stage : shell),
      createElement: (tag) => createElement(tag),
      createDocumentFragment: () => {
        const fragment = createElement('#fragment');
        fragment.isFragment = true;
        return fragment;
      },
      addEventListener() {}
    }
  };

  globals.window = {
    innerWidth: width,
    innerHeight: 800,
    devicePixelRatio: 1,
    localStorage: {
      store: new Map(),
      getItem(key) { return this.store.get(key) ?? null; },
      setItem(key, value) { this.store.set(key, value); }
    },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    addEventListener() {},
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {}
  };
  globals.window.window = globals.window;
  globals.window.localStorage = globals.window.localStorage;

  vm.createContext(globals);
  vm.runInContext(APP_SOURCE, globals, { filename: 'public/app.js' });

  await settle();
  await settle();

  return {
    clock,
    loaded,
    requests,
    root,
    stage,
    shell,
    el: Object.fromEntries(elements),
    setStatus(next) {
      currentStatus = { ...next };
    }
  };
}

test('dashboard boots, paints the active theme and starts exactly two timers', async () => {
  const dash = await createDashboard();
  const gojo = THEMES.find((theme) => theme.id === 'gojo');

  assert.equal(dash.root.dataset.theme, 'gojo');
  assert.equal(dash.root.style.properties.get('--primary'), gojo.colors.primary);
  assert.equal(dash.root.style.properties.get('--accent'), gojo.colors.accent);
  assert.equal(dash.root.style.properties.get('--pairing-glow'), gojo.colors.pairingGlow);

  assert.equal(dash.el.botName.textContent, 'ANIME MD');
  assert.equal(dash.el.ownerName.textContent, 'F!xa Dev');
  assert.equal(dash.el.credit.textContent, 'Developed By: F!xa Dev');
  assert.equal(dash.el.phoneNumber.value, '923001234567');
  assert.equal(dash.el.rotationNote.textContent, 'background rotates every 5s');
  assert.equal(dash.el.themeName.textContent, 'Gojo');
  assert.equal(dash.shell.classList.contains('is-ready'), true);

  const chips = dash.el.themeGrid.children;
  assert.equal(chips.length, 7);
  assert.deepEqual(chips.map((chip) => chip.dataset.theme), ['makima', 'nami', 'nezuko', 'shinobu', 'gojo', 'sukuna', 'asta']);
  assert.equal(chips.find((chip) => chip.dataset.theme === 'gojo').getAttribute('aria-pressed'), 'true');

  assert.deepEqual(dash.loaded, [gojo.images[0], gojo.images[1]], 'first frame plus one preloaded frame');
  assert.equal(dash.el.bgSlideB.classList.contains('is-active'), true);
  assert.equal(dash.clock.count(), 2, 'one rotation timer and one status poll');
});

test('artwork rotates every five seconds on a single controlled timer', async () => {
  const dash = await createDashboard();
  const gojo = THEMES.find((theme) => theme.id === 'gojo');

  dash.clock.tick(ROTATION_INTERVAL_MS);
  await settle();
  assert.ok(dash.loaded.includes(gojo.images[1]));
  assert.equal(dash.el.bgSlideA.classList.contains('is-active'), true);
  assert.equal(dash.el.bgSlideB.classList.contains('is-active'), false);

  dash.clock.tick(ROTATION_INTERVAL_MS);
  await settle();
  assert.ok(dash.loaded.includes(gojo.images[2]));
  assert.equal(dash.el.bgSlideB.classList.contains('is-active'), true);

  assert.equal(dash.clock.count(), 2, 'no extra timers were created while rotating');
  assert.ok(!dash.loaded.some((url) => !gojo.images.includes(url)), 'no foreign artwork was loaded');
});

test('a broken image falls back to the next artwork of the same theme', async () => {
  const gojo = THEMES.find((theme) => theme.id === 'gojo');
  const dash = await createDashboard({ failing: new Set([gojo.images[0]]) });

  dash.clock.tick(600);
  await settle();

  assert.ok(dash.loaded.includes(gojo.images[1]), 'the next frame of the same theme is used');
  assert.ok(!dash.loaded.some((url) => !gojo.images.includes(url)), 'no other character artwork is used');
  assert.equal(dash.stage.dataset.images, 'on');
  assert.equal(dash.el.bgSlideB.classList.contains('is-active'), true);
});

test('when every image of a theme fails the artwork hides but the theme survives', async () => {
  const gojo = THEMES.find((theme) => theme.id === 'gojo');
  const dash = await createDashboard({ failing: new Set(gojo.images) });

  for (let round = 0; round < gojo.images.length + 2; round += 1) {
    dash.clock.tick(600);
    await settle();
  }

  assert.equal(dash.stage.dataset.images, 'off');
  assert.equal(dash.root.dataset.theme, 'gojo');
  assert.equal(dash.root.style.properties.get('--primary'), gojo.colors.primary);
  assert.equal(dash.clock.count(), 1, 'the rotation timer stops, the status poll stays');
});

test('switching theme repaints the page and swaps artwork without a reload', async () => {
  const dash = await createDashboard();
  const sukuna = THEMES.find((theme) => theme.id === 'sukuna');
  const chip = dash.el.themeGrid.children.find((node) => node.dataset.theme === 'sukuna');

  chip.dispatch('click');
  await settle();

  assert.equal(dash.root.dataset.theme, 'sukuna');
  assert.equal(dash.root.style.properties.get('--primary'), sukuna.colors.primary);
  assert.equal(dash.root.style.properties.get('--glow'), sukuna.colors.glow);
  assert.equal(dash.el.themeName.textContent, 'Sukuna');
  assert.equal(chip.getAttribute('aria-pressed'), 'true');
  assert.ok(dash.loaded.includes(sukuna.images[0]), 'the new theme artwork is loaded');
  assert.equal(dash.clock.count(), 2, 'the rotation timer is replaced, not duplicated');

  const themeCall = dash.requests.find((request) => request.url === '/api/theme');
  assert.deepEqual(themeCall.body, { themeId: 'sukuna' });
});

test('pairing rejects a plus sign locally and never calls the server', async () => {
  const dash = await createDashboard();
  dash.el.phoneNumber.value = '+923001234567';

  dash.el.pairForm.dispatch('submit');
  await settle();

  assert.match(dash.el.formMessage.textContent, /without \+/);
  assert.equal(dash.el.formMessage.classList.contains('is-error'), true);
  assert.deepEqual(dash.requests.filter((request) => request.url === '/api/pairing'), []);
});

test('pairing reveals the code the server returned', async () => {
  const dash = await createDashboard();
  dash.el.phoneNumber.value = '923001234567';

  dash.el.pairForm.dispatch('submit');
  await settle();
  await settle();

  assert.equal(dash.el.codeValue.textContent, 'ABCD1234');
  assert.equal(dash.el.codeBox.hidden, false);
  assert.equal(dash.el.steps.children[2].classList.contains('is-active'), true);
  assert.deepEqual(dash.requests.find((request) => request.url === '/api/pairing').body, { phoneNumber: '923001234567' });
});

test('the UI only reports connected when the server says so', async () => {
  const dash = await createDashboard();

  assert.equal(dash.el.statusPill.dataset.state, 'starting');
  assert.equal(dash.el.linkedBox.hidden, true);
  assert.equal(dash.el.pairButton.disabled, false);

  dash.setStatus({ state: 'connected', connected: true, message: 'ANIME MD is connected to WhatsApp.', pairingCode: null });
  dash.clock.tick(4000);
  await settle();
  await settle();

  assert.equal(dash.el.statusPill.dataset.state, 'connected');
  assert.equal(dash.el.statusText.textContent, 'Connected');
  assert.equal(dash.el.linkedBox.hidden, false);
  assert.equal(dash.el.pairButton.disabled, true);
  assert.equal(dash.el.steps.children.every((step) => step.classList.contains('is-done')), true);
});
