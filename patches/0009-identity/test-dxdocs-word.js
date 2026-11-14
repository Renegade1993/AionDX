#!/usr/bin/env node
// test-dxdocs-word.js: a DX Doc as Word (dxdocs-word.js). node patches\0009-identity\test-dxdocs-word.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const W = require(path.join(__dirname, 'dxdocs-word.js'));
let JSZip;
try { JSZip = require('jszip'); } catch (e) { JSZip = require(path.join(__dirname, '..', '..', 'vendor', 'extracted', 'node_modules', 'jszip')); }
let pass = 0, fail = 0;
function check(name, ok, detail) { if (ok) { pass++; console.log('PASS  ' + name); } else { fail++; console.log('FAIL  ' + name + (detail ? '   [' + String(detail).slice(0, 400) + ']' : '')); } }
(async () => {
  try {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'dxw-'));
    const dd = path.join(ws, 'DX Docs');
    fs.mkdirSync(path.join(dd, 'pictures'), { recursive: true });
    // a 2 x 1 PNG
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGP8z8DwnwEIGBkZAAoIAgH3HhjFAAAAAElFTkSuQmCC', 'base64');
    fs.writeFileSync(path.join(dd, 'pictures', 'p.png'), png);
    check('a picture\'s size is read from its header', JSON.stringify(W.imageSize(png)) === '{"w":2,"h":1,"type":"png"}', JSON.stringify(W.imageSize(png)));
    const md = '# Launch plan\n\nShip **beta** first, *carefully*, see [site](https://example.com).\n\n## Goals\n\n1. One\n2. Two\n\n- [x] Done task\n- [ ] Open task\n\n## Numbers\n\n```chart\n{"type":"bar","title":"Sales","unit":"$k","x":["Q1","Q2"],"series":[{"name":"2026","values":[3,5]}]}\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n![Map](pictures/p.png)\n\n```mermaid\nflowchart LR\n  A-->B\n```\n\n> quoted\n\n<!-- aiondx:pending risks -->\n';
    const buf = await W.toDocx(md, { docsDir: dd, title: 'Launch plan', pictures: [] });
    const zip = await JSZip.loadAsync(buf);
    const xml = await zip.file('word/document.xml').async('string');
    const text = xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    check('it is a Word file whose text holds the title, the sections and the words', buf.slice(0, 2).toString() === 'PK' && /Launch plan/.test(text) && /Goals/.test(text) && /carefully/.test(text) && /Done task/.test(text), text.slice(0, 300));
    check('the title is a Title, the sections Heading 1', /<w:pStyle w:val="Title"\/>/.test(xml) && (xml.match(/<w:pStyle w:val="Heading1"\/>/g) || []).length === 2);
    check('each major section after the first starts on a new page (the house rule)', (xml.match(/<w:pageBreakBefore\/>/g) || []).length === 1, (xml.match(/<w:pageBreakBefore\/>/g) || []).length);
    check('bold, italic and a link are kept', /<w:b\/>[\s\S]*?beta/.test(xml) && /<w:i\/>[\s\S]*?carefully/.test(xml) && /w:hyperlink/.test(xml));
    check('tasks show their boxes, ticked and not', /☒ [\s\S]*Done task/.test(text) && /☐ [\s\S]*Open task/.test(text));
    check('without a picture of it, a chart is the table of its numbers; tables keep their rows together', /Sales/.test(text) && /2026 \(\$k\)/.test(text) && /<w:cantSplit\/>/.test(xml), text.slice(0, 600));
    check('a picture beside the doc is embedded', Object.keys(zip.files).some((f) => /^word\/media\//.test(f)));
    check('a diagram without its picture is its text; a section not yet written says so', /flowchart LR/.test(text) && /Not written yet: risks/.test(text));
    // with the panel's pictures, the chart and the diagram are pictures
    const buf2 = await W.toDocx(md, { docsDir: dd, pictures: [{ png: 'data:image/png;base64,' + png.toString('base64'), w: 640, h: 360 }, { png: png.toString('base64'), w: 400, h: 200 }] });
    const zip2 = await JSZip.loadAsync(buf2);
    const xml2 = await zip2.file('word/document.xml').async('string');
    check('with the panel\'s pictures, the chart and the diagram are pictures (three in all with the map), not their table or text', (xml2.match(/<pic:pic /g) || []).length === 3 && !/flowchart LR/.test(xml2) && !/2026 \(\$k\)/.test(xml2), (xml2.match(/<pic:pic /g) || []).length);
    fs.rmSync(ws, { recursive: true, force: true });
  } catch (e) { check('no exception', false, e.stack); }
  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  process.exit(fail ? 1 : 0);
})();
