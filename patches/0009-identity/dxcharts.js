/* dxcharts.js (patches/0009-identity): data charts for DX Docs (R-125, a request of 2026-11-13: "give our agents the ability to use any of
 * this functionality for displaying information to the user as well (like the graphs and charts and whatnot", "It should be usable by any
 * agent type (claude or not)"). An agent writes a fenced block of JSON in the doc's Markdown:
 *
 *   ```chart
 *   {"type":"bar","title":"Revenue by quarter","unit":"$k","x":["Q1","Q2","Q3"],
 *    "series":[{"name":"2025","values":[120,140,150]},{"name":"2026","values":[130,160,170]}]}
 *   ```
 *
 * or the same as rows: {"type":"line","columns":["Month","Sales","Cost"],"rows":[["Jan",10,7],["Feb",12,8]]}.
 * Types: bar (grouped), stacked, hbar (horizontal), line, area, pie, scatter (values are [x, y] pairs). Optional: title, unit, yLabel,
 * xLabel, yMin, yMax, note. The page draws it as SVG (each mark has a tooltip with its value) with a Data button for the numbers; the
 * engine (dxdocs.js) checks every chart block when an agent writes, and refuses a bad one with a plain reason, so any agent can fix it.
 * Loaded in the page before aiondx-dxdocs-md.js (window.__dxCharts) and in Node (module.exports). Nothing an agent writes becomes markup:
 * every text is escaped, every number is checked. */
(function (root) {
  'use strict';
  var TYPES = ['bar', 'stacked', 'hbar', 'line', 'area', 'pie', 'scatter'];
  var MAX_POINTS = 2000, MAX_SERIES = 12;
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function num(v) { return typeof v === 'number' && isFinite(v); }
  function fmt(v) {
    var a = Math.abs(v);
    var s = a >= 1e9 ? (v / 1e9).toFixed(a >= 1e10 ? 0 : 1) + 'B' : a >= 1e6 ? (v / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M' : a >= 1e4 ? (v / 1e3).toFixed(a >= 1e5 ? 0 : 1) + 'K'
      : Math.round(v) === v ? String(v) : String(Number(v.toPrecision(4)));
    return s.replace(/\.0([KMB])$/, '$1');
  }
  function full(v) { return Math.round(v) === v ? v.toLocaleString('en-US') : String(Number(v.toPrecision(6))); }

  /** The spec, read and checked: { spec } (normalised: type, title, unit, x, series[{name, values}]) or { error } in plain words. */
  function parse(text) {
    var o;
    try { o = typeof text === 'string' ? JSON.parse(text) : text; } catch (e) { return { error: 'the chart is not valid JSON (' + String(e.message).replace(/^JSON\.parse: /, '') + ')' }; }
    if (!o || typeof o !== 'object' || Array.isArray(o)) return { error: 'the chart must be one JSON object, like {"type":"bar","x":[...],"series":[{"name":"...","values":[...]}]}' };
    var type = String(o.type || 'bar').toLowerCase();
    if (TYPES.indexOf(type) < 0) return { error: '"type" must be one of ' + TYPES.join(', ') + ' (it was "' + String(o.type) + '")' };
    var x = null, series = null;
    if (Array.isArray(o.rows)) {
      var cols = Array.isArray(o.columns) ? o.columns.map(String) : null;
      if (!cols || cols.length < 2) return { error: '"rows" needs "columns": the first names the x column, the rest name the series, like ["Month","Sales","Cost"]' };
      x = []; series = cols.slice(1).map(function (c) { return { name: c, values: [] }; });
      for (var r = 0; r < o.rows.length; r++) {
        var row = o.rows[r];
        if (!Array.isArray(row) || row.length !== cols.length) return { error: 'row ' + (r + 1) + ' has ' + (Array.isArray(row) ? row.length : 0) + ' values; "columns" names ' + cols.length };
        x.push(type === 'scatter' ? row[0] : String(row[0]));
        for (var c = 1; c < cols.length; c++) series[c - 1].values.push(type === 'scatter' ? [row[0], row[c]] : row[c]);
      }
    } else {
      if (!Array.isArray(o.series) || !o.series.length) return { error: 'give "series" (a list of {"name","values"}) or "columns" with "rows"' };
      series = [];
      for (var s = 0; s < o.series.length; s++) {
        var se = o.series[s];
        if (!se || !Array.isArray(se.values)) return { error: 'series ' + (s + 1) + ' needs "values", a list of numbers' };
        series.push({ name: String(se.name == null ? 'Series ' + (s + 1) : se.name), values: se.values.slice() });
      }
      x = Array.isArray(o.x) ? o.x.map(String) : Array.isArray(o.labels) ? o.labels.map(String) : null;
    }
    if (series.length > MAX_SERIES) return { error: 'at most ' + MAX_SERIES + ' series (there are ' + series.length + ')' };
    var n = 0;
    for (var k = 0; k < series.length; k++) {
      var vs = series[k].values;
      n += vs.length;
      for (var j = 0; j < vs.length; j++) {
        var v = vs[j];
        if (type === 'scatter') { if (!Array.isArray(v) || v.length !== 2 || !num(v[0]) || !num(v[1])) return { error: 'scatter values are [x, y] pairs of numbers (series "' + series[k].name + '", value ' + (j + 1) + ')' }; }
        else if (!(num(v) || v === null)) return { error: 'series "' + series[k].name + '", value ' + (j + 1) + ' is not a number (' + JSON.stringify(v) + '); use null for a gap' };
      }
    }
    if (!n) return { error: 'the chart has no values' };
    if (n > MAX_POINTS) return { error: 'at most ' + MAX_POINTS + ' values in one chart (there are ' + n + ')' };
    if (type !== 'scatter') {
      var len = Math.max.apply(null, series.map(function (q) { return q.values.length; }));
      if (!x) { x = []; for (var t = 0; t < len; t++) x.push(String(t + 1)); }
      if (x.length !== len) return { error: '"x" has ' + x.length + ' labels but the longest series has ' + len + ' values' };
      if (type === 'pie') {
        if (series.length !== 1) return { error: 'a pie has one series (it has ' + series.length + '); use "stacked" or "bar" to compare several' };
        if (series[0].values.some(function (v) { return v < 0; })) return { error: 'a pie cannot show negative values' };
      }
    }
    var str = function (v) { return v == null ? '' : String(v).slice(0, 200); };
    return { spec: { type: type, title: str(o.title), unit: str(o.unit), yLabel: str(o.yLabel), xLabel: str(o.xLabel), note: str(o.note),
      yMin: num(o.yMin) ? o.yMin : null, yMax: num(o.yMax) ? o.yMax : null, x: x, series: series } };
  }

  function niceTicks(lo, hi, count) {
    if (lo === hi) { hi = lo + 1; if (lo > 0) lo = 0; }
    var span = hi - lo, step = Math.pow(10, Math.floor(Math.log10(span / count)));
    var err = span / count / step;
    step *= err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1;
    var a = Math.floor(lo / step) * step, b = Math.ceil(hi / step) * step, out = [];
    for (var v = a; v <= b + step / 2; v += step) out.push(Number(v.toPrecision(12)));
    return out;
  }
  function trunc(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  /** The chart as an SVG string (the page sizes it to its column). Colours are CSS variables (--dxc1 ... --dxc8) set by the page's theme. */
  function toSvg(spec) {
    var W = 640, H = 360, padL = 56, padR = 16, padT = spec.title ? 34 : 14, padB = 46;
    var multi = spec.series.length > 1 || spec.type === 'pie';
    if (multi) padB += 22;
    var parts = ['<svg class="dx-chart-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(spec.title || 'Chart') + '" xmlns="http://www.w3.org/2000/svg">'];
    if (spec.title) parts.push('<text class="dx-ch-title" x="' + padL + '" y="20">' + esc(spec.title) + '</text>');
    var col = function (i) { return 'var(--dxc' + (i % 8 + 1) + ')'; };
    var unit = spec.unit ? ' ' + spec.unit : '';
    var tip = function (lines) { return '<title>' + esc(lines.join('\n')) + '</title>'; };
    var legend = function (names) {
      var x = padL, y = H - 12, out = [];
      names.forEach(function (nm, i) {
        var w = Math.min(160, 18 + trunc(nm, 22).length * 6.6);
        if (x + w > W - padR) return;
        out.push('<rect x="' + x + '" y="' + (y - 9) + '" width="10" height="10" rx="2" style="fill:' + col(i) + '"/><text class="dx-ch-legend" x="' + (x + 14) + '" y="' + y + '">' + esc(trunc(nm, 22)) + '</text>');
        x += w;
      });
      return out.join('');
    };
    if (spec.type === 'pie') {
      var vals = spec.series[0].values.map(function (v) { return v || 0; }), total = vals.reduce(function (a, b) { return a + b; }, 0) || 1;
      var cx = W / 2, cy = padT + (H - padT - padB) / 2, rr = Math.min(W, H - padT - padB) / 2 - 6, ang = -Math.PI / 2;
      vals.forEach(function (v, i) {
        var a2 = ang + v / total * Math.PI * 2;
        var large = a2 - ang > Math.PI ? 1 : 0;
        var p = v >= total ? '<circle cx="' + cx + '" cy="' + cy + '" r="' + rr + '"' : '<path d="M' + cx + ',' + cy + 'L' + (cx + rr * Math.cos(ang)).toFixed(1) + ',' + (cy + rr * Math.sin(ang)).toFixed(1) +
          'A' + rr + ',' + rr + ' 0 ' + large + ' 1 ' + (cx + rr * Math.cos(a2)).toFixed(1) + ',' + (cy + rr * Math.sin(a2)).toFixed(1) + 'Z"';
        parts.push('<g class="dx-ch-mark">' + p + ' style="fill:' + col(i) + '" stroke="var(--dxc-bg)" stroke-width="1.5">' + tip([spec.x[i], full(v) + unit + ' (' + (v / total * 100).toFixed(1) + '%)']) + (v >= total ? '</circle>' : '</path>') + '</g>');
        if (v / total >= 0.06) {
          var mid = (ang + a2) / 2;
          parts.push('<text class="dx-ch-pct" text-anchor="middle" x="' + (cx + rr * 0.62 * Math.cos(mid)).toFixed(1) + '" y="' + (cy + rr * 0.62 * Math.sin(mid) + 4).toFixed(1) + '">' + Math.round(v / total * 100) + '%</text>');
        }
        ang = a2;
      });
      parts.push(legend(spec.x));
      parts.push('</svg>');
      return parts.join('');
    }
    var horiz = spec.type === 'hbar';
    if (horiz) padL = 110;
    var pw = W - padL - padR, ph = H - padT - padB;
    var lo = Infinity, hi = -Infinity, xlo = Infinity, xhi = -Infinity;
    if (spec.type === 'stacked') {
      for (var i = 0; i < spec.x.length; i++) {
        var pos = 0, neg = 0;
        spec.series.forEach(function (s) { var v = s.values[i] || 0; if (v >= 0) pos += v; else neg += v; });
        hi = Math.max(hi, pos); lo = Math.min(lo, neg);
      }
    } else spec.series.forEach(function (s) { s.values.forEach(function (v) { if (v == null) return; var y = spec.type === 'scatter' ? v[1] : v; if (spec.type === 'scatter') { xlo = Math.min(xlo, v[0]); xhi = Math.max(xhi, v[0]); } lo = Math.min(lo, y); hi = Math.max(hi, y); }); });
    if (spec.type !== 'line' && spec.type !== 'scatter') { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    if (spec.yMin != null) lo = spec.yMin;
    if (spec.yMax != null) hi = spec.yMax;
    var ticks = niceTicks(lo, hi, 5); lo = ticks[0]; hi = ticks[ticks.length - 1];
    var vpos = function (v) { return horiz ? padL + (v - lo) / (hi - lo) * pw : padT + ph - (v - lo) / (hi - lo) * ph; };
    // grid and value axis
    ticks.forEach(function (t) {
      var p = vpos(t).toFixed(1);
      parts.push(horiz ? '<line class="dx-ch-grid" x1="' + p + '" x2="' + p + '" y1="' + padT + '" y2="' + (padT + ph) + '"/><text class="dx-ch-tick" text-anchor="middle" x="' + p + '" y="' + (padT + ph + 16) + '">' + esc(fmt(t)) + '</text>'
        : '<line class="dx-ch-grid" x1="' + padL + '" x2="' + (padL + pw) + '" y1="' + p + '" y2="' + p + '"/><text class="dx-ch-tick" text-anchor="end" x="' + (padL - 6) + '" y="' + (+p + 4) + '">' + esc(fmt(t)) + '</text>');
    });
    if (spec.yLabel) parts.push('<text class="dx-ch-axis" transform="rotate(-90)" text-anchor="middle" x="' + (-(padT + ph / 2)) + '" y="14">' + esc(spec.yLabel + (spec.unit && spec.yLabel.indexOf(spec.unit) < 0 ? ' (' + spec.unit + ')' : '')) + '</text>');
    if (spec.xLabel) parts.push('<text class="dx-ch-axis" text-anchor="middle" x="' + (padL + pw / 2) + '" y="' + (padT + ph + 34) + '">' + esc(spec.xLabel) + '</text>');
    if (spec.type === 'scatter') {
      var xt = niceTicks(xlo, xhi, 6), xa = xt[0], xb = xt[xt.length - 1];
      var xp = function (v) { return padL + (v - xa) / (xb - xa) * pw; };
      xt.forEach(function (t) { parts.push('<text class="dx-ch-tick" text-anchor="middle" x="' + xp(t).toFixed(1) + '" y="' + (padT + ph + 16) + '">' + esc(fmt(t)) + '</text>'); });
      spec.series.forEach(function (s, si) {
        s.values.forEach(function (v) { parts.push('<circle class="dx-ch-mark" cx="' + xp(v[0]).toFixed(1) + '" cy="' + vpos(v[1]).toFixed(1) + '" r="4" style="fill:' + col(si) + '">' + tip([s.name, full(v[0]) + ', ' + full(v[1]) + unit]) + '</circle>'); });
      });
    } else {
      var nx = spec.x.length, band = (horiz ? ph : pw) / nx;
      var every = Math.max(1, Math.ceil(nx / (horiz ? 14 : 12)));
      spec.x.forEach(function (lab, i) {
        if (i % every) return;
        var c = (horiz ? padT : padL) + band * (i + 0.5);
        parts.push(horiz ? '<text class="dx-ch-tick" text-anchor="end" x="' + (padL - 6) + '" y="' + (c + 4).toFixed(1) + '">' + esc(trunc(lab, 16)) + '</text>'
          : '<text class="dx-ch-tick" text-anchor="middle" x="' + c.toFixed(1) + '" y="' + (padT + ph + 16) + '">' + esc(trunc(lab, Math.max(4, Math.floor(band * every / 6.5)))) + '</text>');
      });
      var zero = vpos(Math.max(lo, Math.min(hi, 0)));
      if (spec.type === 'bar' || spec.type === 'hbar' || spec.type === 'stacked') {
        var ns = spec.type === 'stacked' ? 1 : spec.series.length, inner = band * 0.78, bw = inner / ns;
        var stackP = [], stackN = [];
        spec.series.forEach(function (s, si) {
          s.values.forEach(function (v, i) {
            if (v == null) return;
            var a, b;
            if (spec.type === 'stacked') { var base = v >= 0 ? (stackP[i] || 0) : (stackN[i] || 0); a = vpos(base); b = vpos(base + v); if (v >= 0) stackP[i] = base + v; else stackN[i] = base + v; }
            else { a = zero; b = vpos(v); }
            var off = (horiz ? padT : padL) + band * i + (band - inner) / 2 + (spec.type === 'stacked' ? 0 : bw * si);
            var t1 = Math.min(a, b), len = Math.max(1, Math.abs(a - b));
            parts.push('<rect class="dx-ch-mark" ' + (horiz ? 'x="' + t1.toFixed(1) + '" y="' + off.toFixed(1) + '" width="' + len.toFixed(1) + '" height="' + Math.max(1, bw - 1).toFixed(1) + '"'
              : 'x="' + off.toFixed(1) + '" y="' + t1.toFixed(1) + '" width="' + Math.max(1, bw - 1).toFixed(1) + '" height="' + len.toFixed(1) + '"') + ' rx="2" style="fill:' + col(si) + '">' + tip([spec.x[i], s.name + ': ' + full(v) + unit]) + '</rect>');
          });
        });
        parts.push(horiz ? '<line class="dx-ch-zero" x1="' + zero.toFixed(1) + '" x2="' + zero.toFixed(1) + '" y1="' + padT + '" y2="' + (padT + ph) + '"/>' : '<line class="dx-ch-zero" x1="' + padL + '" x2="' + (padL + pw) + '" y1="' + zero.toFixed(1) + '" y2="' + zero.toFixed(1) + '"/>');
      } else {
        spec.series.forEach(function (s, si) {
          var pts = [], segs = [], cur = [];
          s.values.forEach(function (v, i) {
            if (v == null) { if (cur.length) segs.push(cur); cur = []; return; }
            var p = [padL + band * (i + 0.5), vpos(v)];
            cur.push(p); pts.push({ p: p, v: v, i: i });
          });
          if (cur.length) segs.push(cur);
          segs.forEach(function (sg) {
            var d = sg.map(function (p, k) { return (k ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join('');
            if (spec.type === 'area') parts.push('<path class="dx-ch-area" d="' + d + 'L' + sg[sg.length - 1][0].toFixed(1) + ',' + zero.toFixed(1) + 'L' + sg[0][0].toFixed(1) + ',' + zero.toFixed(1) + 'Z" style="fill:' + col(si) + '"/>');
            parts.push('<path class="dx-ch-line" d="' + d + '" style="stroke:' + col(si) + '"/>');
          });
          pts.forEach(function (q) { parts.push('<circle class="dx-ch-mark dx-ch-pt" cx="' + q.p[0].toFixed(1) + '" cy="' + q.p[1].toFixed(1) + '" r="' + (nx > 40 ? 2.5 : 3.5) + '" style="fill:' + col(si) + '">' + tip([spec.x[q.i], s.name + ': ' + full(q.v) + unit]) + '</circle>'); });
        });
      }
    }
    if (multi) parts.push(legend(spec.series.map(function (s) { return s.name; })));
    parts.push('</svg>');
    return parts.join('');
  }
  /** The numbers behind the chart, as a table (the Data button shows it). */
  function toTable(spec) {
    var unit = spec.unit ? ' (' + esc(spec.unit) + ')' : '';
    if (spec.type === 'scatter') {
      var rows = [];
      spec.series.forEach(function (s) { s.values.forEach(function (v) { rows.push('<tr><td>' + esc(s.name) + '</td><td>' + esc(full(v[0])) + '</td><td>' + esc(full(v[1])) + '</td></tr>'); }); });
      return '<table class="dx-chart-table"><thead><tr><th>Series</th><th>' + esc(spec.xLabel || 'x') + '</th><th>' + esc(spec.yLabel || 'y') + unit + '</th></tr></thead><tbody>' + rows.join('') + '</tbody></table>';
    }
    var head = '<tr><th>' + esc(spec.xLabel || '') + '</th>' + spec.series.map(function (s) { return '<th>' + esc(s.name) + unit + '</th>'; }).join('') + '</tr>';
    var body = spec.x.map(function (x, i) { return '<tr><td>' + esc(x) + '</td>' + spec.series.map(function (s) { var v = s.values[i]; return '<td>' + (v == null ? '' : esc(full(v))) + '</td>'; }).join('') + '</tr>'; }).join('');
    return '<table class="dx-chart-table"><thead>' + head + '</thead><tbody>' + body + '</tbody></table>';
  }
  /** The block as HTML for the doc: the chart, its note, a Data button and the hidden table; or a box saying what is wrong. */
  function toHtml(text) {
    var r = parse(text);
    if (r.error) return '<div class="dx-chart dx-chart--bad"><b>This chart could not be drawn:</b> ' + esc(r.error) + '.</div>';
    return '<figure class="dx-chart">' + toSvg(r.spec) + (r.spec.note ? '<figcaption>' + esc(r.spec.note) + '</figcaption>' : '') +
      '<button type="button" class="dx-chart-data" data-act="chart-data">Data</button><div class="dx-chart-tablewrap" hidden>' + toTable(r.spec) + '</div></figure>';
  }
  /** Every chart block in a doc's Markdown that cannot be drawn: [{ line, section, error }]. */
  function check(md) {
    var lines = String(md || '').replace(/\r\n/g, '\n').split('\n'), out = [], section = '';
    for (var i = 0; i < lines.length; i++) {
      var h = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(lines[i]);
      if (h) { section = h[1]; continue; }
      var f = /^(```|~~~)\s*chart\s*$/.exec(lines[i]);
      if (!f) continue;
      var body = [], j = i + 1;
      while (j < lines.length && lines[j].indexOf(f[1]) !== 0) body.push(lines[j++]);
      var r = parse(body.join('\n'));
      if (r.error) out.push({ line: i + 1, section: section, error: r.error });
      i = j;
    }
    return out;
  }
  var api = { parse: parse, toSvg: toSvg, toTable: toTable, toHtml: toHtml, check: check, TYPES: TYPES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.__dxCharts = api;
})(typeof window !== 'undefined' ? window : this);
