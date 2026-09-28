'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { config } = require('../system/config');
const { resolveCommand } = require('../system/lib/menu');
const { inspect } = require('../scripts/command-registry-check');

test('the retired hidden-video engine has no runtime configuration or public command route', () => {
  assert.equal(Object.hasOwn(config, 'hiddenVideo'), false);
  for (const name of ['hvideo', 'hv', 'hvid', 'h', 'hidden']) assert.equal(resolveCommand(name), undefined);
  const routes = inspect().routes.map((route) => route.name);
  for (const name of ['hvideo', 'hv', 'hvid']) assert.ok(!routes.includes(name));
  assert.deepEqual(inspect().hidden, []);
});
