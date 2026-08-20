'use strict';

// Compatibility entry point for projects that previously loaded system/setting.js.
// New code should import { config } from './config' directly instead of relying on globals.
module.exports = require('./config').config;
