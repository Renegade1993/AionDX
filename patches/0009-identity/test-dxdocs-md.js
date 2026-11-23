'use strict';
// test-dxdocs-md.js - DX Docs' Markdown renderer (dxdocs-md.js): each construct, escaping, unsafe links refused, pending sections.
//   node patches\0009-identity\test-dxdocs-md.js
const path = require('path');
const M = require(path.join(__dirname, 'dxdocs-md.js'));
let pass = 0, fail = 0;
const check = (name, got, want) => { const ok = got === want; if (ok) pass++; else fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : '\n   got:  ' + JSON.stringify(got) + '\n   want: ' + JSON.stringify(want))); };
const H = M.toHtml;
check('a title and a section heading carry their section', H('# Plan\n\n## Goals'), '<h1 id="plan" data-section="Plan">Plan</h1>\n<h2 id="goals" data-section="Goals">Goals</h2>');
check('a pending section becomes "Writing: ..." under its section', H('## Goals\n\n<!-- aiondx:pending the three outcomes -->'),
  '<h2 id="goals" data-section="Goals">Goals</h2>\n<div class="dx-pending" data-section="Goals" data-intent="the three outcomes"><span class="dx-pending-dot"></span>Writing: the three outcomes</div>');
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
check('a chart block is drawn as a chart (R-125)', /^<figure class="dx-chart" data-src="[^"]*"><svg class="dx-chart-svg"/.test(H('```chart\n{"type":"bar","x":["a"],"series":[{"name":"s","values":[1]}]}\n```')), true);
check('a bad chart block says why', /dx-chart--bad/.test(H('```chart\n{nope}\n```')), true);
check('a mermaid block becomes a holder with its text, escaped', H('```mermaid\nflowchart LR\n  A["<b>x</b>"]-->B\n```'),
  '<div class="dx-mermaid" data-src="flowchart LR\n  A[&quot;&lt;b&gt;x&lt;/b&gt;&quot;]--&gt;B"><pre><code class="language-mermaid">flowchart LR\n  A[&quot;&lt;b&gt;x&lt;/b&gt;&quot;]--&gt;B</code></pre></div>');
check('a code block keeps its text escaped, and headings inside it are not headings', H('```js\n## not\n<b>\n```'), '<pre><code class="language-js">## not\n&lt;b&gt;</code></pre>');
check('a table with alignment (:-- left, --: right, :-: centre, -- none)', H('| A | B | C |\n|:--|--:|--|\n| 1 | **2** | 3 |'),
  '<table><thead><tr><th style="text-align:left">A</th><th style="text-align:right">B</th><th>C</th></tr></thead><tbody><tr><td style="text-align:left">1</td><td style="text-align:right"><strong>2</strong></td><td>3</td></tr></tbody></table>');
// writing and tables (DX Docs mirror, November 15th)
check('a heading carries an anchor for links to it', H('### Open questions?'), '<h3 id="open-questions" data-section="Open questions?">Open questions?</h3>');
check('++underline++ and ==highlight==', H('a ++b c++ and ==d== e'), '<p>a <u>b c</u> and <mark>d</mark> e</p>');
check('a numbered list starts at its first number', H('5. five\n6. six'), '<ol start="5"><li>five</li><li>six</li></ol>');
check('an inline formula is an atom with its TeX; money is not a formula', H('so $x^2 < y$ but $5 and $10'),
  '<p>so <span class="dx-atom dx-math" contenteditable="false" data-src="$x^2 &lt; y$" data-tex="x^2 &lt; y">x^2 &lt; y</span> but $5 and $10</p>');
check('a formula block, $$ or ```math', /<div class="dx-atom dx-math dx-math--block"[^>]*data-src="\$\$\\frac\{a\}\{b\}\$\$" data-tex="\\frac\{a\}\{b\}"/.test(H('$$\\frac{a}{b}$$')) &&
  /data-src="```math\n\\sum x\n```" data-tex="\\sum x"/.test(H('```math\n\\sum x\n```')), true);
check('a CSV block is a grid, its text kept as the source', H('```csv\nName,"Cost, est"\nA,"say ""hi"""\n```'),
  '<div class="dx-atom dx-csv" contenteditable="false" data-src="```csv\nName,&quot;Cost, est&quot;\nA,&quot;say &quot;&quot;hi&quot;&quot;&quot;\n```"><table class="dx-csv-grid"><thead><tr><th>Name</th><th>Cost, est</th></tr></thead><tbody><tr><td>A</td><td>say &quot;hi&quot;</td></tr></tbody></table></div>');
check('a Markdown block is drawn, its text kept as the source', /^<div class="dx-atom dx-mdblock" contenteditable="false" data-src="```markdown\n# T\n```"><div class="dx-mdblock-tag">Markdown<\/div><h1 id="t" data-section="T">T<\/h1><\/div>$/.test(H('```markdown\n# T\n```')), true);
check('table cells: colours, a column width, a merged cell', H('| A {.bg-blue w=160} | B | C |\n| --- | --- | --- |\n| wide | << | c {.bg-green} |'),
  '<table><thead><tr><th class="dx-bg-blue" data-w="160" style="width:160px">A</th><th>B</th><th>C</th></tr></thead><tbody><tr><td colspan="2">wide</td><td class="dx-bg-green">c</td></tr></tbody></table>');
// chips, callouts, question and approval blocks (DX Docs mirror, step 4)
check('chips: a date, a dropdown with its options, a mention, links to a tab and a doc; each keeps its source',
  H('Due [[date:2026-11-20]], [[pick:In progress|Not started|In progress|Done]], [[@agent]], see [[tab:t2|Decisions]] and [[doc:launch-plan|Launch plan]].'),
  '<p>Due <span class="dx-atom dx-chip dx-chip--date" contenteditable="false" data-src="[[date:2026-11-20]]" data-kind="date" data-value="2026-11-20">Nov 20, 2026</span>, ' +
  '<span class="dx-atom dx-chip dx-chip--pick dx-pick-in-progress" contenteditable="false" data-src="[[pick:In progress|Not started|In progress|Done]]" data-kind="pick" data-value="In progress" data-options="Not started|In progress|Done">In progress<span class="dx-chip-caret">▾</span></span>, ' +
  '<span class="dx-atom dx-chip dx-chip--mention" contenteditable="false" data-src="[[@agent]]" data-kind="mention" data-value="agent">@the agent</span>, see ' +
  '<span class="dx-atom dx-chip dx-chip--tab" contenteditable="false" data-src="[[tab:t2|Decisions]]" data-kind="tab" data-target="t2">Decisions</span> and ' +
  '<span class="dx-atom dx-chip dx-chip--doc" contenteditable="false" data-src="[[doc:launch-plan|Launch plan]]" data-kind="doc" data-target="launch-plan">Launch plan</span>.</p>');
check('a callout', H('> [!WARNING] Mind the budget\n> It is tight.'), '<blockquote class="dx-callout dx-callout--warning" data-callout="WARNING"><div class="dx-callout-tag" contenteditable="false">Warning</div><p>Mind the budget<br>It is tight.</p></blockquote>');
const ch = H('```choice\n{"question":"Ship when?","options":["Q1","Q2"],"answer":["Q2"],"by":"you"}\n```');
check('a question block: its options, the answer ticked, its source kept', /^<div class="dx-atom dx-choice dx-choice--answered" contenteditable="false" data-kind="choice" data-src="```choice\n\{&quot;question/.test(ch) &&
  /type="radio" name="dxq\d+" data-opt="Q2" checked/.test(ch) && /Answered by you: Q2/.test(ch), true);
// R-138 (November 23rd, 2026): a write-in line on every question; its text is the block's note, shown in the Answered line; "other": false leaves it out
check('every question has a write-in line, empty until used', /<input type="text" class="dx-choice-own" data-testid="aiondx-dx-choice-own"[^>]*placeholder="Or write your own answer"[^>]*value=""><button type="button" class="dx-btn dx-choice-send"/.test(ch) &&
  /Answered by you: Q2</.test(ch), true);
const chw = H('```choice\n{"question":"Which day?","options":["Mon","Tue"],"multi":true,"answer":["Tue"],"note":"Thu if the crew \\"can\\" <make> it","by":"you"}\n```');
check('a written answer: kept in the line (escaped), and in the Answered line with the ticks', /value="Thu if the crew &quot;can&quot; &lt;make&gt; it"/.test(chw) && /placeholder="Add your own answer"/.test(chw) &&
  /Answered by you: Tue, “Thu if the crew &quot;can&quot; &lt;make&gt; it”</.test(chw), true);
const cho = H('```choice\n{"question":"Ship when?","options":["Q1","Q2"],"note":"Q3","other":false}\n```');
check('"other": false: no write-in line, and the note is not shown as an answer', !/dx-choice-own/.test(cho) && /Pick one\.</.test(cho) && !/dx-choice--answered/.test(cho), true);
check('unanswered, the state line says a written answer is welcome', /Pick one, or write your own\.</.test(H('```choice\n{"question":"a","options":["b","c"]}\n```')), true);
check('an approval block, waiting', /dx-approve--open[\s\S]*Approve the plan[\s\S]*Waiting for approval[\s\S]*data-approve="yes"/.test(H('```approve\n{"label":"Approve the plan"}\n```')), true);
check('a block that does not read says why', /This question block cannot be shown: it needs &quot;options&quot;: two or more strings/.test(H('```choice\n{"question":"x","options":["only"]}\n```')), true);
check('an unknown colour is ignored; a cell pipe stays in its cell', H('| a {.bg-pink} | b \\| c |\n| --- | --- |'), '<table><thead><tr><th>a</th><th>b | c</th></tr></thead><tbody></tbody></table>');
check('a quote', H('> said\n> twice'), '<blockquote><p>said<br>twice</p></blockquote>');
check('a rule', H('a\n\n---\n\nb'), '<p>a</p>\n<hr>\n<p>b</p>');
check('a paragraph ends where a list starts', H('Intro\n- one'), '<p>Intro</p>\n<ul><li>one</li></ul>');
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
