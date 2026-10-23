'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const packageJson = JSON.parse(read('package.json'));
const heroku = JSON.parse(read('app.json'));
const metadata = JSON.parse(read('metadata.json'));
const render = read('render.yaml');
const readme = read('README.md');
const deployment = read('DEPLOYMENT.md');

test('package and host manifests use the production start command without environment configuration', () => {
  assert.equal(packageJson.engines.node, '>=20.9');
  assert.equal(packageJson.scripts.start, 'node index.js');
  assert.equal(read('Procfile').trim(), 'worker: npm start');
  assert.match(render, /^\s*buildCommand: npm ci$/m);
  assert.match(render, /^\s*startCommand: npm start$/m);
  assert.deepEqual(heroku.env, {});
  assert.equal(fs.existsSync(path.join(ROOT, '.env.example')), false);
});

test('documentation and deployment files point users to config.js', () => {
  assert.match(read('config.js'), /TELEGRAM SETTINGS/);
  assert.match(readme, /config\.js/);
  assert.match(deployment, /^# ANIME MD Deployment Guide$/m);
  assert.match(deployment, /Node\.js 20\.9 or newer/);
  assert.doesNotMatch(JSON.stringify(metadata), /gemini/i);
  assert.deepEqual(metadata.majorCapabilities, []);
});

test('Render keeps the WhatsApp session and databases on the mounted disk', () => {
  assert.match(render, /^\s*mountPath: \/var\/data$/m);
  assert.match(render, /key: ANIME_MD_AUTH_DIR\s*\n\s*value: \/var\/data\/session/);
  assert.match(render, /key: ANIME_MD_DATA_DIR\s*\n\s*value: \/var\/data\/data/);

  const authDir = path.join(os.tmpdir(), 'anime-md-render-auth');
  const dataDir = path.join(os.tmpdir(), 'anime-md-render-data');
  const output = execFileSync(process.execPath, [
    '-e',
    "const { config } = require('./system/config'); console.log(config.authDir); console.log(config.dataDir);"
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ANIME_MD_AUTH_DIR: authDir, ANIME_MD_DATA_DIR: dataDir }
  }).trim().split(/\r?\n/);
  assert.deepEqual(output, [authDir, dataDir]);
});

test('default Telegram pairing policy keeps public and premium users eligible', () => {
  const config = require('../config');
  assert.equal(config.telegram.publicMode, true, 'public pairing must stay open by default');
  assert.equal(config.telegram.premiumOnly, false, 'premium users remain eligible without closing public pairing');
});
