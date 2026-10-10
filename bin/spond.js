#!/usr/bin/env node
'use strict';
// Keep this launcher parseable by old Node releases, before loading ESM.
var major = Number(process.versions.node.split('.')[0]);
if (major < 22) {
  console.error('Spond CLI requires Node.js 22 or newer. Current version: ' + process.version + '.');
  console.error('Please update Node.js and verify it with node --version.');
  process.exitCode = 1;
} else {
  // Old Node versions must not parse the dynamic import expression.
  new Function('return import("../src/cli.js")')().catch(function () {
    console.error('Spond CLI could not be loaded. Please check the installation.');
    process.exitCode = 1;
  });
}
