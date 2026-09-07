'use strict';

// Keep the package, host manifests, sample environment, and documentation in
// agreement. These files are the deployment interface, so a configuration
// drift here can break a host even when the application code itself passes.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const packageJson = JSON.parse(read('package.json'));
const heroku = JSON.parse(read('app.json'));
const metadata = JSON.parse(read('metadata.json'));
const render = read('render.yaml');
const envExample = read('.env.example');
const readme = read('README.md');
const deployment = read('DEPLOYMENT.md');

test('package and supported host manifests use the production start command', () => {
  assert.equal(packageJson.engines.node, '>=20.9');
  assert.equal(packageJson.scripts.start, 'node index.js');
  assert.equal(read('Procfile').trim(), 'web: npm start');
  assert.match(render, /^\s*buildCommand: npm ci$/m);
  assert.match(render, /^\s*startCommand: npm start$/m);
  assert.match(render, /^\s*healthCheckPath: \/health$/m);
  assert.equal(heroku.stack, 'heroku-24');
});

test('deployment manifests expose the required pairing configuration', () => {
  for (const key of ['OWNER_NAME', 'BOT_NUMBER', 'SESSION_ID', 'AUTH_METHOD']) {
    assert.ok(Object.hasOwn(heroku.env, key), `app.json is missing ${key}`);
    assert.match(render, new RegExp(`- key: ${key}`), `render.yaml is missing ${key}`);
    assert.match(envExample, new RegExp(`^${key}=|^# ${key}=`, 'm'), `.env.example is missing ${key}`);
  }

  assert.match(render, /AUTH_DIR\n\s+value: \/var\/data\/session/);
  assert.match(render, /DATA_DIR\n\s+value: \/var\/data\/data/);
  assert.match(render, /mountPath: \/var\/data/);
});

test('documentation, metadata, and committed assets match the current bot', () => {
  assert.match(readme, /ANIME MD/);
  assert.match(deployment, /^# ANIME MD Deployment Guide$/m);
  assert.match(deployment, /`>=20\.9` engine requirement/);
  assert.match(readme, /supplied Catbox artwork/);
  assert.doesNotMatch(JSON.stringify(metadata), /gemini/i);
  assert.deepEqual(metadata.majorCapabilities, []);

  for (const character of ['asta', 'gojo', 'makima', 'nami', 'nezuko', 'shinobu', 'sukuna']) {
    assert.ok(fs.existsSync(path.join(ROOT, 'public', 'assets', 'characters', `${character}.jpg`)));
  }
});
