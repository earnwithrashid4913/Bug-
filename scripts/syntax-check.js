'use strict';

// Syntax check for every JavaScript file in the repository (browser bundle,
// server modules and tests alike). Zero dependencies, cross platform.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SKIPPED_DIRECTORIES = new Set([
  '.git',
  'build',
  'coverage',
  'data',
  'dist',
  'logs',
  'node_modules',
  'session'
]);

function collectJavaScriptFiles(directory, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) collectJavaScriptFiles(full, files);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(full);
    }
  }
  return files;
}

const root = path.resolve(__dirname, '..');
const files = collectJavaScriptFiles(root).sort();
const failures = [];

for (const file of files) {
  const relative = path.relative(root, file);
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    console.log(`ok    ${relative}`);
  } catch (error) {
    failures.push(relative);
    console.error(`FAIL  ${relative}`);
    console.error(String(error.stderr || error.message).trim());
  }
}

console.log(`\n${files.length - failures.length}/${files.length} files passed the syntax check.`);
process.exit(failures.length ? 1 : 0);
