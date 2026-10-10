#!/usr/bin/env node
'use strict';
// Keep this launcher parseable by old Node releases, before loading ESM.
var major = Number(process.versions.node.split('.')[0]);
if (major < 22) {
  console.error('Spond CLI benötigt Node.js 22 oder neuer. Aktuell: ' + process.version + '.');
  console.error('Bitte Node.js aktualisieren und mit node --version prüfen.');
  process.exitCode = 1;
} else {
  // Old Node versions must not parse the dynamic import expression.
  new Function('return import("../src/cli.js")')().catch(function () {
    console.error('Spond CLI konnte nicht geladen werden. Installation prüfen.');
    process.exitCode = 1;
  });
}
