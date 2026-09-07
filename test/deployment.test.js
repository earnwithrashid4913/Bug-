'use strict';

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
