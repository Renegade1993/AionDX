#!/usr/bin/env node
// test-dxcharts.js: the DX Docs chart block (R-125). node patches\0009-identity\test-dxcharts.js
'use strict';
const path = require('path');
const C = require(path.join(__dirname, 'dxcharts.js'));
let pass = 0, fail = 0;
function check(name, ok, detail) { if (ok) { pass++; console.log('PASS  ' + name); } else { fail++; console.log('FAIL  ' + name + (detail ? '   [' + String(detail).slice(0, 300) + ']' : '')); } }
const count = (s, re) => (s.match(re) || []).length;

let r = C.parse('{"type":"bar","title":"Revenue","unit":"$k","x":["Q1","Q2","Q3"],"series":[{"name":"2025","values":[120,140,150]},{"name":"2026","values":[130,160,170]}]}');
check('a bar chart in series form reads', r.spec && r.spec.type === 'bar' && r.spec.series.length === 2 && r.spec.x.join() === 'Q1,Q2,Q3', JSON.stringify(r));
let svg = C.toSvg(r.spec);
check('it draws one bar per value, each with its value on hover', count(svg, /<rect class="dx-ch-mark"/g) === 6 && /<title>Q2\n2026: 160 \$k<\/title>/.test(svg), svg.slice(0, 400));
check('with its title and a legend for two series', /dx-ch-title[^>]*>Revenue</.test(svg) && count(svg, /dx-ch-legend/g) === 2);
r = C.parse({ type: 'line', columns: ['Month', 'Sales', 'Cost'], rows: [['Jan', 10, 7], ['Feb', 12, null], ['Mar', 15, 9]] });
check('rows with columns read as series; null is a gap', r.spec && r.spec.series[0].name === 'Sales' && r.spec.series[1].values[1] === null && r.spec.x[2] === 'Mar', JSON.stringify(r));
svg = C.toSvg(r.spec);
check('a line with a gap draws two pieces for that series, and a point per value', count(svg, /class="dx-ch-line"/g) === 3 && count(svg, /dx-ch-pt/g) === 5, svg.slice(0, 300));
r = C.parse({ type: 'pie', x: ['A', 'B', 'C'], series: [{ name: 'Share', values: [50, 30, 20] }] });
svg = C.toSvg(r.spec);
check('a pie: a slice each, with the share on hover and in the slice', count(svg, /<path d="M/g) === 3 && /<title>B\n30 \(30\.0%\)<\/title>/.test(svg) && />50%</.test(svg), svg.slice(0, 300));
r = C.parse({ type: 'pie', series: [{ name: 'All', values: [5] }] });
check('a pie of one value is a whole circle', /<circle/.test(C.toSvg(r.spec)));
r = C.parse({ type: 'stacked', x: ['a', 'b'], series: [{ name: 'p', values: [1, 2] }, { name: 'q', values: [3, -1] }] });
check('stacked bars read and draw', r.spec && count(C.toSvg(r.spec), /<rect class="dx-ch-mark"/g) === 4);
r = C.parse({ type: 'scatter', series: [{ name: 'runs', values: [[1, 2], [3, 4.5]] }] });
check('scatter reads [x, y] pairs and draws a point each', r.spec && count(C.toSvg(r.spec), /<circle class="dx-ch-mark"/g) === 2, JSON.stringify(r));
r = C.parse({ type: 'hbar', x: ['Alpha', 'Beta'], series: [{ name: 'n', values: [3, 5] }] });
check('horizontal bars draw', r.spec && count(C.toSvg(r.spec), /<rect class="dx-ch-mark"/g) === 2);
// what an agent gets wrong, said plainly
check('bad JSON says so', /not valid JSON/.test(C.parse('{"type":"bar",').error));
check('an unknown type names the types', /"type" must be one of bar, stacked, hbar, line, area, pie, scatter/.test(C.parse({ type: 'donut', series: [{ values: [1] }] }).error));
check('a value that is not a number names the series and the place', /series "s", value 2 is not a number \("2"\)/.test(C.parse({ x: ['a', 'b'], series: [{ name: 's', values: [1, '2'] }] }).error));
check('labels and values that do not match are counted', /"x" has 3 labels but the longest series has 2 values/.test(C.parse({ x: ['a', 'b', 'c'], series: [{ name: 's', values: [1, 2] }] }).error));
check('a row of the wrong length is named', /row 2 has 2 values; "columns" names 3/.test(C.parse({ columns: ['m', 'a', 'b'], rows: [['x', 1, 2], ['y', 1]] }).error));
check('a pie of two series is refused with what to use', /a pie has one series/.test(C.parse({ type: 'pie', x: ['a'], series: [{ values: [1] }, { values: [2] }] }).error));
// nothing an agent writes becomes markup
const evil = C.toHtml({ type: 'bar', title: '<script>alert(1)</script>', x: ['<img src=x onerror=alert(1)>'], series: [{ name: '"><b>', values: [1] }] });
check('titles, labels and names are escaped, never markup', !/<script|<img|"><b>/.test(evil) && /&lt;script&gt;/.test(evil), evil.slice(0, 300));
check('the HTML has the chart, a Data button and the hidden table of numbers', /<figure class="dx-chart" data-src="{&quot;type&quot;:&quot;bar&quot;[^"]*"><svg/.test(evil) && /data-act="chart-data"/.test(evil) && /<div class="dx-chart-tablewrap" hidden><table/.test(evil));
check('a bad chart becomes a box saying why', /dx-chart--bad[\s\S]*not valid JSON/.test(C.toHtml('nope')));
// the engine's check over a whole doc
const md = '# Plan\n\n## Sales\n\n```chart\n{"type":"bar","x":["a"],"series":[{"name":"s","values":[1]}]}\n```\n\n## Costs\n\n```chart\n{"type":"bar","x":["a","b"],"series":[{"name":"s","values":[1]}]}\n```\n';
const bad = C.check(md);
check('check finds the bad chart, its section and line', bad.length === 1 && bad[0].section === 'Costs' && bad[0].line === 11 && /"x" has 2 labels/.test(bad[0].error), JSON.stringify(bad));
// the kinds Claude Docs draws that DX Docs did not, and the extras (DX Docs mirror, November 15th)
const S = (o) => { const p = C.parse(o); return p.spec ? C.toSvg(p.spec) : 'ERROR ' + p.error; };
svg = S({ type: 'waterfall', x: ['Start', 'Sales', 'Costs', 'End'], series: [{ name: 'Cash', values: [100, 40, -25, null] }], totals: ['Start', 'End'], labels: true });
check('a waterfall: totals from zero in the first colour, rises and falls from the running total, joined; the end total computed',
  count(svg, /class="dx-ch-mark"/g) === 4 && /var\(--dxc3\)/.test(svg) && /var\(--dxc5\)/.test(svg) && count(svg, /dx-ch-conn/g) === 3 && /<title>End\nTotal: 115<\/title>/.test(svg) && />115</.test(svg), svg.slice(0, 200));
svg = S({ type: 'range', x: ['A', 'B'], series: [{ name: 'Estimate', values: [[2, 5, 9], [4, 7]] }] });
check('a range: whiskers from low to high, the middle as a dot when given', count(svg, /<g class="dx-ch-mark"/g) === 2 && count(svg, /<circle cx/g) === 1 && /Estimate: 2 ≤ 5 – 9/.test(svg), svg.slice(0, 200));
check('a range value must be low first', /low first/.test(S({ type: 'range', x: ['A'], series: [{ name: 'E', values: [[9, 2]] }] })));
svg = S({ type: 'combo', x: ['Q1', 'Q2', 'Q3'], series: [{ name: 'Revenue', values: [10, 12, 15] }, { name: 'Margin', values: [20, 22, 25] }], lines: ['Margin'] });
check('a combo: bars for one series, a line for the other', count(svg, /<rect class="dx-ch-mark"/g) === 3 && count(svg, /class="dx-ch-line"/g) === 1 && count(svg, /dx-ch-pt/g) === 3, svg.slice(0, 200));
check('a combo must say which series is the line', /name the line series in "lines"/.test(S({ type: 'combo', x: ['a'], series: [{ name: 's', values: [1] }] })));
svg = S({ type: 'funnel', x: ['Visits', 'Sign-ups', 'Paid'], series: [{ name: 'People', values: [1000, 300, 60] }] });
check('a funnel: a bar per stage, its share of the first beside it', count(svg, /<rect class="dx-ch-mark"/g) === 3 && />1000</.test(svg) && /60 · 6%/.test(svg) && /6\.0% of the first/.test(svg), svg.slice(0, 200));
svg = S({ type: 'bar', x: ['Q1', 'Q2', 'Q3', 'Q4'], series: [{ name: 'Sales', values: [3, 5, 4, 6] }], target: { value: 5.5, label: 'Goal' }, notes: [{ x: 'Q2', text: 'Launch' }], labels: ['Q4'], accent: 'Q4', projectedFrom: 'Q4' });
check('the extras: a target line named at its end, a note on a point, a label on the chosen point, one accent with the rest grey, the projected bar pale and dashed',
  /<g class="dx-ch-target">/.test(svg) && />Goal 5\.5</.test(svg) && /<g class="dx-ch-note">[\s\S]*>Launch</.test(svg) && count(svg, /class="dx-ch-val"/g) === 1 && />6</.test(svg) &&
  count(svg, /style="fill:var\(--dxc1\)"/g) === 1 && count(svg, /style="fill:var\(--dxc8\)"/g) === 3 && /fill-opacity="0.42"/.test(svg) && />Projected</.test(svg), svg);
svg = S({ type: 'line', x: ['Jan', 'Feb', 'Mar', 'Apr'], series: [{ name: 'Sales', values: [3, 5, 4, 6] }], projectedFrom: 'Mar' });
check('a line\'s projected part is dashed, joined to the last actual point, its points hollow', count(svg, /class="dx-ch-line"/g) === 2 && /stroke-dasharray="6 4"/.test(svg) && count(svg, /fill:var\(--dxc-bg\)/g) === 2, svg.slice(-600));
// drawings (row 48): a 2x2, pillars, a timeline; every word has its place for editing in place (row 49)
const DR = (o) => { const r = C.parseDrawing(o); return r.spec ? C.drawingToSvg(r.spec) : 'ERROR ' + r.error; };
svg = DR({ type: 'quadrant', title: 'Effort and value', x: { low: 'Low effort', high: 'High effort' }, y: { low: 'Low value', high: 'High value' }, quadrants: ['Quick wins', 'Big bets', 'Fill-ins', 'Money pits'], items: [{ label: 'Tabs', x: 0.2, y: 0.9 }] });
check('a 2x2: four named boxes, the axes, an item placed; each word knows its place', count(svg, /class="dx-dr-box/g) === 4 && /data-path="quadrants\.1">[\s\S]*?Big bets/.test(svg) && /data-path="items\.0\.label"/.test(svg) && /data-path="x\.low"/.test(svg), svg.slice(0, 300));
svg = DR({ type: 'pillars', roof: 'Ship DX Docs', pillars: [{ title: 'Writing', points: ['Tabs', 'Tables'] }, { title: 'Talking', points: ['Comments'] }], base: 'Files on your disk' });
check('pillars: a roof, a column each with its points, a base', count(svg, /class="dx-dr-pillar"/g) === 2 && /data-path="pillars\.0\.points\.1"/.test(svg) && /data-path="roof"/.test(svg) && /data-path="base"/.test(svg));
svg = DR({ type: 'timeline', events: [{ date: 'Nov 15', title: 'Plan' }, { date: 'Nov 16', title: 'Build', text: 'Every row' }, { date: 'Nov 17', title: 'Release' }] });
check('a timeline: a dot per event, dates and titles above and below the line', count(svg, /class="dx-dr-dot"/g) === 3 && /data-path="events\.1\.text"/.test(svg));
check('a drawing that does not read says what it needs', /"type" is one of quadrant, pillars, timeline/.test(DR({ type: 'venn' })) && /four boxes/.test(DR({ type: 'quadrant', quadrants: ['a'] })));
// an agent's own SVG, cleaned before it shows
const dirty = '<svg viewBox="0 0 10 10" onload="alert(1)"><script>alert(2)</script><rect width="5" height="5" onclick="x()" style="fill:url(http://evil/x)"/><foreignObject><iframe src="http://evil"></iframe></foreignObject>' +
  '<a href="javascript:alert(3)"><circle r="2"/></a><use href="http://evil/s.svg#a"/><use href="#ok"/><text x="1" y="9">Hi &amp; bye</text></svg>';
const clean = C.sanitizeSvg(dirty);
check('an SVG is cleaned: no script, no event, no outside link, no embedded page, no outside url in a style; shapes and text stay',
  clean.svg && !/script|onload|onclick|foreignObject|iframe|javascript|http:/i.test(clean.svg) && /<rect width="5" height="5"\/>/.test(clean.svg) && /<use href="#ok"\/>/.test(clean.svg) && /<text x="1" y="9">Hi &amp; bye<\/text>/.test(clean.svg) && /^<svg class="dx-drawing-svg" viewBox/.test(clean.svg), clean.svg);
check('a block with no svg in it says so', /holds one <svg>/.test(C.sanitizeSvg('<div>x</div>').error || ''));
check('check finds a bad drawing too', JSON.stringify(C.check('## D\n\n```drawing\n{"type":"venn"}\n```\n').map((p) => [p.kind, p.line])) === '[["drawing",3]]');
check('the extras are checked: a note on an x that is not there, an accent that names nothing',
  /note 1 needs "x"/.test(S({ type: 'bar', x: ['a'], series: [{ name: 's', values: [1] }], notes: [{ x: 'z', text: 'n' }] })) && /"accent" names one series or one x label/.test(S({ type: 'bar', x: ['a'], series: [{ name: 's', values: [1] }], accent: 'q' })));
console.log('\n' + pass + '/' + (pass + fail) + ' passed');
process.exit(fail ? 1 : 0);
