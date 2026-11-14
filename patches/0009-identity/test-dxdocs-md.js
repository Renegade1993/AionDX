'use strict';
// test-dxdocs-md.js - DX Docs' Markdown renderer (dxdocs-md.js): each construct, escaping, unsafe links refused, pending sections.
//   node patches\0009-identity\test-dxdocs-md.js
const path = require('path');
const M = require(path.join(__dirname, 'dxdocs-md.js'));
let pass = 0, fail = 0;
const check = (name, got, want) => { const ok = got === want; if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : '\n   got:  ' + JSON.stringify(got) + '\n   want: ' + JSON.stringify(want))); };
const H = M.toHtml;
check('a title and a section heading carry their section', H('# Plan\n\n## Goals'), '<h1 data-section="Plan">Plan</h1>\n<h2 data-section="Goals">Goals</h2>');
check('a pending section becomes "Writing: ..." under its section', H('## Goals\n\n<!-- aiondx:pending the three outcomes -->'),
  '<h2 data-section="Goals">Goals</h2>\n<div class="dx-pending" data-section="Goals"><span class="dx-pending-dot"></span>Writing: the three outcomes</div>');
check('a paragraph with bold, italic, code, strikethrough', H('A **b** *i* `c<d>` ~~x~~'), '<p>A <strong>b</strong> <em>i</em> <code>c&lt;d&gt;</code> <del>x</del></p>');
check('lines of one paragraph keep their breaks', H('one\ntwo'), '<p>one<br>two</p>');
check('raw HTML is shown as text, never run', H('<script>alert(1)</script> <img src=x onerror=y>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt; &lt;img src=x onerror=y&gt;</p>');
check('links: http kept; javascript: refused (text only)', H('[a](https://x.example/p?q=1&r=2) [b](javascript:alert(1))'), '<p><a href="https://x.example/p?q=1&amp;r=2">a</a> b)</p>');
check('an address on its own becomes a link', H('see https://example.com/a now'), '<p>see <a href="https://example.com/a">https://example.com/a</a> now</p>');
check('an image', H('![chart](./chart.png "Q1")'), '<p><img src="./chart.png" alt="chart" title="Q1"></p>');
check('a bullet list, nested', H('- a\n  - a1\n- b'), '<ul><li>a<ul><li>a1</li></ul></li><li>b</li></ul>');
check('a numbered list', H('1. one\n2. two'), '<ol><li>one</li><li>two</li></ol>');
check('a task list: each box carries its line, so it can be ticked', H('- [x] done\n- [ ] open'), '<ul><li class="dx-task"><input type="checkbox" class="dx-tick" data-line="0" checked> done</li><li class="dx-task"><input type="checkbox" class="dx-tick" data-line="1"> open</li></ul>');
check('a task inside a quote cannot be ticked (no line of its own)', /<input type="checkbox" class="dx-tick" disabled>/.test(H('> - [ ] quoted')), true);
check('a chart block is drawn as a chart (R-125)', /^<figure class="dx-chart"><svg class="dx-chart-svg"/.test(H('```chart\n{"type":"bar","x":["a"],"series":[{"name":"s","values":[1]}]}\n```')), true);
check('a bad chart block says why', /dx-chart--bad/.test(H('```chart\n{nope}\n```')), true);
check('a mermaid block becomes a holder with its text, escaped', H('```mermaid\nflowchart LR\n  A["<b>x</b>"]-->B\n```'),
  '<div class="dx-mermaid" data-src="flowchart LR\n  A[&quot;&lt;b&gt;x&lt;/b&gt;&quot;]--&gt;B"><pre><code class="language-mermaid">flowchart LR\n  A[&quot;&lt;b&gt;x&lt;/b&gt;&quot;]--&gt;B</code></pre></div>');
check('a code block keeps its text escaped, and headings inside it are not headings', H('```js\n## not\n<b>\n```'), '<pre><code class="language-js">## not\n&lt;b&gt;</code></pre>');
check('a table with alignment', H('| A | B |\n|:--|--:|\n| 1 | **2** |'),
  '<table><thead><tr><th style="text-align:">A</th><th style="text-align:right">B</th></tr></thead><tbody><tr><td style="text-align:">1</td><td style="text-align:right"><strong>2</strong></td></tr></tbody></table>'.replace(/ style="text-align:"/g, ''));
check('a quote', H('> said\n> twice'), '<blockquote><p>said<br>twice</p></blockquote>');
check('a rule', H('a\n\n---\n\nb'), '<p>a</p>\n<hr>\n<p>b</p>');
check('a paragraph ends where a list starts', H('Intro\n- one'), '<p>Intro</p>\n<ul><li>one</li></ul>');
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
