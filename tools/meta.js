// Writes tornrevive.meta.js: the userscript header alone, which Tampermonkey polls for updates.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'tornrevive.user.js'), 'utf8');
const m = /\/\/ ==UserScript==[^]*?\/\/ ==\/UserScript==\r?\n/.exec(src);
if (!m) throw new Error('no userscript header');
fs.writeFileSync(path.join(root, 'tornrevive.meta.js'), m[0]);
console.log('tornrevive.meta.js written');
