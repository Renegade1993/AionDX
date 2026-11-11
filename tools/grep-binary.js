#!/usr/bin/env node
// grep-binary.js FILE NEEDLE [before] [after] [max] - prints the text around each occurrence of NEEDLE in a large binary (latin1), fast.
'use strict';
const fs = require('fs');
const [file, needle, b = '600', af = '600', max = '5'] = process.argv.slice(2);
const buf = fs.readFileSync(file);
const n = Buffer.from(needle, 'latin1');
let at = 0, k = 0;
while (k < +max && (at = buf.indexOf(n, at)) >= 0) {
  console.log('---- @' + at);
  console.log(buf.slice(Math.max(0, at - +b), at + n.length + +af).toString('latin1').replace(/[^\x20-\x7e\n]/g, '.'));
  at += n.length; k++;
}
