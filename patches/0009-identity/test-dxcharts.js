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
check('the HTML has the chart, a Data button and the hidden table of numbers', /<figure class="dx-chart"><svg/.test(evil) && /data-act="chart-data"/.test(evil) && /<div class="dx-chart-tablewrap" hidden><table/.test(evil));
check('a bad chart becomes a box saying why', /dx-chart--bad[\s\S]*not valid JSON/.test(C.toHtml('nope')));
// the engine's check over a whole doc
const md = '# Plan\n\n## Sales\n\n```chart\n{"type":"bar","x":["a"],"series":[{"name":"s","values":[1]}]}\n```\n\n## Costs\n\n```chart\n{"type":"bar","x":["a","b"],"series":[{"name":"s","values":[1]}]}\n```\n';
const bad = C.check(md);
check('check finds the bad chart, its section and line', bad.length === 1 && bad[0].section === 'Costs' && bad[0].line === 11 && /"x" has 2 labels/.test(bad[0].error), JSON.stringify(bad));
console.log('\n' + pass + '/' + (pass + fail) + ' passed');
process.exit(fail ? 1 : 0);
