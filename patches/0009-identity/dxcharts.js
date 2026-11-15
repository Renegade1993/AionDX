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
  // waterfall (deltas, totals where "totals" names the x), range (each value [low, high] or [low, mid, high]: whiskers), combo (bars with
  // a line: the series "lines" names, or a series' "kind":"line"), funnel (one series, largest first): DX Docs mirror, November 15th
  var TYPES = ['bar', 'stacked', 'hbar', 'line', 'area', 'pie', 'scatter', 'waterfall', 'range', 'combo', 'funnel'];
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

  /** A CSV file's rows (quotes and doubled quotes as a spreadsheet writes them). */
  function csvRows(text) {
    var rows = [], row = [], cell = '', q = false, s = String(text || '').replace(/^\ufeff/, '');
    for (var k = 0; k < s.length; k++) {
      var ch = s[k];
      if (q) { if (ch === '"' && s[k + 1] === '"') { cell += '"'; k++; } else if (ch === '"') q = false; else cell += ch; continue; }
      if (ch === '"' && cell === '') { q = true; continue; }
      if (ch === ',') { row.push(cell); cell = ''; continue; }
      if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[k + 1] === '\n') k++; row.push(cell); rows.push(row); row = []; cell = ''; continue; }
      cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (c) { return String(c).trim(); }); });
  }
  /** The spec, read and checked: { spec } (normalised: type, title, unit, x, series[{name, values}]) or { error } in plain words.
   *  A chart can take its numbers from a CSV file in the project ("csv": "data/sales.csv", its first row the column names; "use" picks
   *  columns): opts.csvText is that file's text; without it the answer is { pending: path } (the page fetches the file, then draws). */
  function parse(text, opts) {
    var o;
    try { o = typeof text === 'string' ? JSON.parse(text) : text; } catch (e) { return { error: 'the chart is not valid JSON (' + String(e.message).replace(/^JSON\.parse: /, '') + ')' }; }
    if (!o || typeof o !== 'object' || Array.isArray(o)) return { error: 'the chart must be one JSON object, like {"type":"bar","x":[...],"series":[{"name":"...","values":[...]}]}' };
    if (o.csv != null && !Array.isArray(o.rows)) {
      if (typeof o.csv !== 'string' || !/\.csv$/i.test(o.csv.trim())) return { error: '"csv" is the path of a .csv file in the project, like "data/sales.csv"' };
      var ct = opts && opts.csvText;
      if (ct == null) return { pending: o.csv.trim() };
      if (ct === false) return { error: 'the CSV file "' + o.csv + '" was not found in the project (a path from the DX Docs folder, or from the project\'s folder)' };
      var cr = csvRows(ct);
      if (cr.length < 2) return { error: 'the CSV file "' + o.csv + '" needs a row of column names and at least one row of numbers' };
      var head = cr[0].map(function (h) { return String(h).trim(); });
      var use = Array.isArray(o.use) ? o.use.map(String) : head.slice(1);
      for (var u = 0; u < use.length; u++) if (head.indexOf(use[u]) < 1) return { error: '"use" names columns of "' + o.csv + '" (its columns: ' + head.join(', ') + '); "' + use[u] + '" is not one after the first' };
      var idx = use.map(function (n) { return head.indexOf(n); });
      var copy = {};
      Object.keys(o).forEach(function (k) { if (k !== 'csv' && k !== 'use') copy[k] = o[k]; });
      copy.columns = [head[0]].concat(use);
      copy.rows = cr.slice(1).map(function (r) { return [String(r[0] == null ? '' : r[0]).trim()].concat(idx.map(function (j) { var t = String(r[j] == null ? '' : r[j]).trim().replace(/[$,%\s]/g, ''); return t === '' ? null : isFinite(+t) ? +t : r[j]; })); });
      if (String(o.type || '').toLowerCase() === 'scatter') copy.rows.forEach(function (r) { r[0] = +r[0]; });
      var inner = parse(copy);
      if (inner.spec) inner.spec.csv = o.csv.trim();
      return inner;
    }
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
        series.push({ name: String(se.name == null ? 'Series ' + (s + 1) : se.name), values: se.values.slice(), kind: se.kind === 'line' ? 'line' : '' });
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
        else if (type === 'range') { if (v !== null && (!Array.isArray(v) || (v.length !== 2 && v.length !== 3) || !v.every(num) || v[0] > v[v.length - 1])) return { error: 'range values are [low, high] or [low, mid, high], low first (series "' + series[k].name + '", value ' + (j + 1) + ')' }; }
        else if (!(num(v) || v === null)) return { error: 'series "' + series[k].name + '", value ' + (j + 1) + ' is not a number (' + JSON.stringify(v) + '); use null for a gap' };
      }
    }
    if (!n) return { error: 'the chart has no values' };
    if (n > MAX_POINTS) return { error: 'at most ' + MAX_POINTS + ' values in one chart (there are ' + n + ')' };
    if (type !== 'scatter') {
      var len = Math.max.apply(null, series.map(function (q) { return q.values.length; }));
      if (!x) { x = []; for (var t = 0; t < len; t++) x.push(String(t + 1)); }
      if (x.length !== len) return { error: '"x" has ' + x.length + ' labels but the longest series has ' + len + ' values' };
      if ((type === 'waterfall' || type === 'funnel') && series.length !== 1) return { error: 'a ' + type + ' has one series (it has ' + series.length + ')' };
      if (type === 'funnel' && series[0].values.some(function (v) { return v == null || v < 0; })) return { error: 'a funnel\'s values are counts, none negative or missing' };
      if (type === 'pie') {
        if (series.length !== 1) return { error: 'a pie has one series (it has ' + series.length + '); use "stacked" or "bar" to compare several' };
        if (series[0].values.some(function (v) { return v < 0; })) return { error: 'a pie cannot show negative values' };
      }
    }
    var str = function (v) { return v == null ? '' : String(v).slice(0, 200); };
    // the extras: a target line, notes on points, value labels, one accent with the rest grey, projected values marked
    var has = function (lab) { return x && x.indexOf(String(lab)) >= 0; };
    var target = null;
    if (o.target != null) {
      var tv = typeof o.target === 'object' ? o.target.value : o.target;
      if (!num(tv)) return { error: '"target" is a number, or {"value": a number, "label": "..."}' };
      target = { value: tv, label: str(typeof o.target === 'object' && o.target.label != null ? o.target.label : 'Target') };
    }
    var notes = [];
    if (o.notes != null) {
      if (!Array.isArray(o.notes)) return { error: '"notes" is a list of {"x": a label on the x axis, "text": "..."}' };
      for (var q = 0; q < o.notes.length; q++) {
        var nt = o.notes[q];
        if (!nt || !has(nt.x) || !String(nt.text || '').trim()) return { error: 'note ' + (q + 1) + ' needs "x" (one of the x labels: ' + (x || []).slice(0, 8).join(', ') + ') and "text"' };
        notes.push({ x: String(nt.x), text: str(nt.text) });
      }
    }
    var labels = o.labels === true ? true : Array.isArray(o.labels) ? o.labels.map(String) : null;
    if (Array.isArray(labels)) for (var lq = 0; lq < labels.length; lq++) if (!has(labels[lq])) return { error: '"labels" names x labels to label ("' + labels[lq] + '" is not one), or is true for all' };
    var accent = o.accent == null ? '' : String(o.accent);
    if (accent && !has(accent) && !series.some(function (s) { return s.name === accent; })) return { error: '"accent" names one series or one x label to stand out ("' + accent + '" is neither)' };
    var projectedFrom = o.projectedFrom == null ? '' : String(o.projectedFrom);
    if (projectedFrom && !has(projectedFrom)) return { error: '"projectedFrom" names the first x label whose values are projected ("' + projectedFrom + '" is not one)' };
    var totals = Array.isArray(o.totals) ? o.totals.map(String) : [];
    if (type === 'combo') {
      var lines = Array.isArray(o.lines) ? o.lines.map(String) : [];
      series.forEach(function (s) { if (lines.indexOf(s.name) >= 0) s.kind = 'line'; });
      if (!series.some(function (s) { return s.kind === 'line'; })) return { error: 'a combo draws some series as bars and some as a line: name the line series in "lines", like ["Margin"]' };
      if (series.every(function (s) { return s.kind === 'line'; })) return { error: 'a combo needs at least one series drawn as bars ("lines" names them all)' };
    }
    return { spec: { type: type, title: str(o.title), unit: str(o.unit), yLabel: str(o.yLabel), xLabel: str(o.xLabel), note: str(o.note),
      yMin: num(o.yMin) ? o.yMin : null, yMax: num(o.yMax) ? o.yMax : null, x: x, series: series,
      target: target, notes: notes, labels: labels, accent: accent, projectedFrom: projectedFrom, totals: totals, csv: o.csv ? str(o.csv) : '' } };
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

  /** The chart as an SVG string (the page sizes it to its column). Colours are CSS variables (--dxc1 ... --dxc8) set by the page's theme.
   *  An accent (a series, or one x label) is drawn in the first colour and everything else grey; projected values (from "projectedFrom")
   *  are dashed lines and pale bars; "labels" writes values on the marks; "notes" mark points with words; "target" is a dashed line. */
  function toSvg(spec) {
    var W = 640, H = 360, padL = 56, padR = 16, padT = spec.title ? 34 : 14, padB = 46;
    var T = spec.type;
    var multi = (spec.series.length > 1 || T === 'pie') && T !== 'waterfall' && T !== 'funnel';
    if (multi) padB += 22;
    if (spec.notes && spec.notes.length && T !== 'pie' && T !== 'funnel') padT += 16;
    var parts = ['<svg class="dx-chart-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(spec.title || 'Chart') + '" xmlns="http://www.w3.org/2000/svg">'];
    if (spec.title) parts.push('<text class="dx-ch-title" x="' + padL + '" y="20">' + esc(spec.title) + '</text>');
    var accentSeries = spec.accent && spec.series.some(function (s) { return s.name === spec.accent; });
    var palette = function (k) { return 'var(--dxc' + (k % 8 + 1) + ')'; };
    /** a mark's colour: by its series, or (an accent) the first colour for the accent and grey for the rest */
    var col = function (si, i) {
      if (!spec.accent) return palette(si);
      var on = accentSeries ? spec.series[si] && spec.series[si].name === spec.accent : spec.x && spec.x[i] === spec.accent;
      return on ? 'var(--dxc1)' : 'var(--dxc8)';
    };
    var unit = spec.unit ? ' ' + spec.unit : '';
    var tip = function (lines) { return '<title>' + esc(lines.join('\n')) + '</title>'; };
    var projIdx = spec.projectedFrom && spec.x ? spec.x.indexOf(spec.projectedFrom) : -1;
    var projected = function (i) { return projIdx >= 0 && i >= projIdx; };
    var proj = function (i, c) { return projected(i) ? ' fill-opacity="0.42" stroke="' + c + '" stroke-dasharray="4 2" stroke-width="1"' : ''; };
    var showLabel = function (i) { return spec.labels === true || (Array.isArray(spec.labels) && spec.x && spec.labels.indexOf(spec.x[i]) >= 0); };
    var vlabel = function (x, y, v, anchor) { return '<text class="dx-ch-val" text-anchor="' + (anchor || 'middle') + '" x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '">' + esc(fmt(v)) + '</text>'; };
    var legend = function (names, colour) {
      var x = padL, y = H - 12, out = [];
      names.forEach(function (nm, i) {
        var w = Math.min(160, 18 + trunc(nm, 22).length * 6.6);
        if (x + w > W - padR) return;
        out.push('<rect x="' + x + '" y="' + (y - 9) + '" width="10" height="10" rx="2" style="fill:' + colour(i) + '"/><text class="dx-ch-legend" x="' + (x + 14) + '" y="' + y + '">' + esc(trunc(nm, 22)) + '</text>');
        x += w;
      });
      if (projIdx >= 0 && x + 90 <= W - padR) out.push('<rect x="' + x + '" y="' + (y - 9) + '" width="10" height="10" rx="2" fill="var(--dxc8)" fill-opacity="0.42" stroke="var(--dxc8)" stroke-dasharray="3 2"/><text class="dx-ch-legend" x="' + (x + 14) + '" y="' + y + '">Projected</text>');
      return out.join('');
    };
    if (T === 'pie') {
      var vals = spec.series[0].values.map(function (v) { return v || 0; }), total = vals.reduce(function (a, b) { return a + b; }, 0) || 1;
      var cx = W / 2, cy = padT + (H - padT - padB) / 2, rr = Math.min(W, H - padT - padB) / 2 - 6, ang = -Math.PI / 2;
      var pc = function (i) { return spec.accent ? (spec.x[i] === spec.accent ? 'var(--dxc1)' : 'var(--dxc8)') : palette(i); };
      vals.forEach(function (v, i) {
        var a2 = ang + v / total * Math.PI * 2;
        var large = a2 - ang > Math.PI ? 1 : 0;
        var p = v >= total ? '<circle cx="' + cx + '" cy="' + cy + '" r="' + rr + '"' : '<path d="M' + cx + ',' + cy + 'L' + (cx + rr * Math.cos(ang)).toFixed(1) + ',' + (cy + rr * Math.sin(ang)).toFixed(1) +
          'A' + rr + ',' + rr + ' 0 ' + large + ' 1 ' + (cx + rr * Math.cos(a2)).toFixed(1) + ',' + (cy + rr * Math.sin(a2)).toFixed(1) + 'Z"';
        parts.push('<g class="dx-ch-mark">' + p + ' style="fill:' + pc(i) + '" stroke="var(--dxc-bg)" stroke-width="1.5">' + tip([spec.x[i], full(v) + unit + ' (' + (v / total * 100).toFixed(1) + '%)']) + (v >= total ? '</circle>' : '</path>') + '</g>');
        if (v / total >= 0.06) {
          var mid = (ang + a2) / 2;
          parts.push('<text class="dx-ch-pct" text-anchor="middle" x="' + (cx + rr * 0.62 * Math.cos(mid)).toFixed(1) + '" y="' + (cy + rr * 0.62 * Math.sin(mid) + 4).toFixed(1) + '">' + Math.round(v / total * 100) + '%</text>');
        }
        ang = a2;
      });
      parts.push(legend(spec.x, pc));
      parts.push('</svg>');
      return parts.join('');
    }
    if (T === 'funnel') {
      // one bar per stage, centred, its width its count; the share of the first stage beside it
      var fv = spec.series[0].values, fmax = Math.max.apply(null, fv) || 1, nst = fv.length;
      var fw = W - 2 * 120, fh = (H - padT - padB) / nst, fx0 = W / 2;
      fv.forEach(function (v, i) {
        var w = Math.max(2, v / fmax * fw), y = padT + fh * i + fh * 0.12, h = fh * 0.76;
        var c = spec.accent ? col(0, i) : 'var(--dxc1)';
        parts.push('<rect class="dx-ch-mark" x="' + (fx0 - w / 2).toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="3" style="fill:' + c + '"' + (spec.accent ? '' : ' fill-opacity="' + (1 - i * 0.55 / Math.max(1, nst - 1)).toFixed(2) + '"') + '>' +
          tip([spec.x[i], full(v) + unit + (i ? ' (' + (v / (fv[0] || 1) * 100).toFixed(1) + '% of the first)' : '')]) + '</rect>');
        parts.push('<text class="dx-ch-tick" text-anchor="end" x="' + (fx0 - fw / 2 - 8).toFixed(1) + '" y="' + (y + h / 2 + 4).toFixed(1) + '">' + esc(trunc(spec.x[i], 18)) + '</text>');
        parts.push('<text class="dx-ch-val" text-anchor="start" x="' + (fx0 + fw / 2 + 8).toFixed(1) + '" y="' + (y + h / 2 + 4).toFixed(1) + '">' + esc(fmt(v)) + (i ? ' · ' + Math.round(v / (fv[0] || 1) * 100) + '%' : '') + '</text>');
      });
      parts.push('</svg>');
      return parts.join('');
    }
    var horiz = T === 'hbar';
    if (horiz) padL = 110;
    var pw = W - padL - padR, ph = H - padT - padB;
    var lo = Infinity, hi = -Infinity, xlo = Infinity, xhi = -Infinity;
    // a waterfall's bars: each from the running total to the next, a total from zero
    var wf = [];
    if (T === 'waterfall') {
      var run = 0;
      spec.series[0].values.forEach(function (v, i) {
        var isTotal = spec.totals.indexOf(spec.x[i]) >= 0;
        if (isTotal) { if (v != null) run = v; wf.push({ a: 0, b: run, total: true, v: run }); }
        else if (v == null) wf.push(null);
        else { wf.push({ a: run, b: run + v, v: v }); run += v; }
      });
      wf.forEach(function (w) { if (w) { lo = Math.min(lo, w.a, w.b); hi = Math.max(hi, w.a, w.b); } });
    } else if (T === 'stacked') {
      for (var i = 0; i < spec.x.length; i++) {
        var pos = 0, neg = 0;
        spec.series.forEach(function (s) { var v = s.values[i] || 0; if (v >= 0) pos += v; else neg += v; });
        hi = Math.max(hi, pos); lo = Math.min(lo, neg);
      }
    } else spec.series.forEach(function (s) {
      s.values.forEach(function (v) {
        if (v == null) return;
        if (T === 'range') { lo = Math.min(lo, v[0]); hi = Math.max(hi, v[v.length - 1]); return; }
        var y = T === 'scatter' ? v[1] : v;
        if (T === 'scatter') { xlo = Math.min(xlo, v[0]); xhi = Math.max(xhi, v[0]); }
        lo = Math.min(lo, y); hi = Math.max(hi, y);
      });
    });
    if (spec.target) { lo = Math.min(lo, spec.target.value); hi = Math.max(hi, spec.target.value); }
    if (T !== 'line' && T !== 'scatter' && T !== 'range') { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
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
    var tops = {};   // x index -> the highest point drawn there (for notes)
    var top = function (i, y) { tops[i] = tops[i] == null ? y : Math.min(tops[i], y); };
    if (T === 'scatter') {
      var xt = niceTicks(xlo, xhi, 6), xa = xt[0], xb = xt[xt.length - 1];
      var xp = function (v) { return padL + (v - xa) / (xb - xa) * pw; };
      xt.forEach(function (t) { parts.push('<text class="dx-ch-tick" text-anchor="middle" x="' + xp(t).toFixed(1) + '" y="' + (padT + ph + 16) + '">' + esc(fmt(t)) + '</text>'); });
      spec.series.forEach(function (s, si) {
        s.values.forEach(function (v) { parts.push('<circle class="dx-ch-mark" cx="' + xp(v[0]).toFixed(1) + '" cy="' + vpos(v[1]).toFixed(1) + '" r="4" style="fill:' + col(si, -1) + '">' + tip([s.name, full(v[0]) + ', ' + full(v[1]) + unit]) + '</circle>'); });
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
      var barSeries = T === 'combo' ? spec.series.filter(function (s) { return s.kind !== 'line'; }) : spec.series;
      var lineSeries = T === 'combo' ? spec.series.filter(function (s) { return s.kind === 'line'; }) : [];
      if (T === 'waterfall') {
        var wb = band * 0.62;
        wf.forEach(function (w, i) {
          if (!w) return;
          var off = padL + band * i + (band - wb) / 2, a = vpos(w.a), b = vpos(w.b);
          var c = spec.accent ? col(0, i) : w.total ? 'var(--dxc1)' : w.v >= 0 ? 'var(--dxc3)' : 'var(--dxc5)';
          parts.push('<rect class="dx-ch-mark" x="' + off.toFixed(1) + '" y="' + Math.min(a, b).toFixed(1) + '" width="' + wb.toFixed(1) + '" height="' + Math.max(1, Math.abs(a - b)).toFixed(1) + '" rx="2" style="fill:' + c + '"' + proj(i, c) + '>' +
            tip([spec.x[i], (w.total ? 'Total: ' : (w.v >= 0 ? '+' : '')) + full(w.v) + unit]) + '</rect>');
          top(i, Math.min(a, b));
          if (showLabel(i)) parts.push(vlabel(off + wb / 2, Math.min(a, b) - 4, w.v));
          var nxt = wf[i + 1];
          if (nxt) parts.push('<line class="dx-ch-conn" x1="' + (off + wb).toFixed(1) + '" x2="' + (off + band).toFixed(1) + '" y1="' + b.toFixed(1) + '" y2="' + b.toFixed(1) + '"/>');
        });
        parts.push('<line class="dx-ch-zero" x1="' + padL + '" x2="' + (padL + pw) + '" y1="' + zero.toFixed(1) + '" y2="' + zero.toFixed(1) + '"/>');
      } else if (T === 'range') {
        var nsr = spec.series.length, inr = band * 0.7, bwr = inr / nsr;
        spec.series.forEach(function (s, si) {
          s.values.forEach(function (v, i) {
            if (v == null) return;
            var cxr = padL + band * i + (band - inr) / 2 + bwr * (si + 0.5), y1 = vpos(v[0]), y2 = vpos(v[v.length - 1]), c = col(si, i);
            var cap = Math.min(10, bwr * 0.6);
            parts.push('<g class="dx-ch-mark"' + (projected(i) ? ' stroke-dasharray="3 2"' : '') + '><line x1="' + cxr.toFixed(1) + '" x2="' + cxr.toFixed(1) + '" y1="' + y1.toFixed(1) + '" y2="' + y2.toFixed(1) + '" style="stroke:' + c + '" stroke-width="2"/>' +
              '<line x1="' + (cxr - cap / 2).toFixed(1) + '" x2="' + (cxr + cap / 2).toFixed(1) + '" y1="' + y1.toFixed(1) + '" y2="' + y1.toFixed(1) + '" style="stroke:' + c + '" stroke-width="2"/>' +
              '<line x1="' + (cxr - cap / 2).toFixed(1) + '" x2="' + (cxr + cap / 2).toFixed(1) + '" y1="' + y2.toFixed(1) + '" y2="' + y2.toFixed(1) + '" style="stroke:' + c + '" stroke-width="2"/>' +
              (v.length === 3 ? '<circle cx="' + cxr.toFixed(1) + '" cy="' + vpos(v[1]).toFixed(1) + '" r="4" style="fill:' + c + '"/>' : '') +
              tip([spec.x[i], s.name + ': ' + full(v[0]) + (v.length === 3 ? ' ≤ ' + full(v[1]) : '') + ' – ' + full(v[v.length - 1]) + unit]) + '</g>');
            top(i, y2);
            if (showLabel(i) && v.length === 3) parts.push(vlabel(cxr + 7, vpos(v[1]) + 4, v[1], 'start'));
          });
        });
      }
      if (T === 'bar' || T === 'hbar' || T === 'stacked' || T === 'combo') {
        var ns = T === 'stacked' ? 1 : barSeries.length, inner = band * 0.78, bw = inner / ns;
        var stackP = [], stackN = [];
        barSeries.forEach(function (s) {
          var si = spec.series.indexOf(s);
          var bi = barSeries.indexOf(s);
          s.values.forEach(function (v, i) {
            if (v == null) return;
            var a, b;
            if (T === 'stacked') { var base = v >= 0 ? (stackP[i] || 0) : (stackN[i] || 0); a = vpos(base); b = vpos(base + v); if (v >= 0) stackP[i] = base + v; else stackN[i] = base + v; }
            else { a = zero; b = vpos(v); }
            var off = (horiz ? padT : padL) + band * i + (band - inner) / 2 + (T === 'stacked' ? 0 : bw * bi);
            var t1 = Math.min(a, b), len = Math.max(1, Math.abs(a - b)), c = col(si, i);
            parts.push('<rect class="dx-ch-mark" ' + (horiz ? 'x="' + t1.toFixed(1) + '" y="' + off.toFixed(1) + '" width="' + len.toFixed(1) + '" height="' + Math.max(1, bw - 1).toFixed(1) + '"'
              : 'x="' + off.toFixed(1) + '" y="' + t1.toFixed(1) + '" width="' + Math.max(1, bw - 1).toFixed(1) + '" height="' + len.toFixed(1) + '"') + ' rx="2" style="fill:' + c + '"' + proj(i, c) + '>' + tip([spec.x[i], s.name + ': ' + full(v) + unit + (projected(i) ? ' (projected)' : '')]) + '</rect>');
            if (!horiz) top(i, t1);
            if (showLabel(i)) parts.push(horiz ? vlabel(Math.max(a, b) + 4, off + bw / 2 + 4, v, 'start') : vlabel(off + bw / 2, (v >= 0 ? t1 : t1 + len + 12) - 4, v));
          });
        });
        parts.push(horiz ? '<line class="dx-ch-zero" x1="' + zero.toFixed(1) + '" x2="' + zero.toFixed(1) + '" y1="' + padT + '" y2="' + (padT + ph) + '"/>' : '<line class="dx-ch-zero" x1="' + padL + '" x2="' + (padL + pw) + '" y1="' + zero.toFixed(1) + '" y2="' + zero.toFixed(1) + '"/>');
      }
      if (T === 'line' || T === 'area' || T === 'combo') {
        (T === 'combo' ? lineSeries : spec.series).forEach(function (s) {
          var si = spec.series.indexOf(s), c = col(si, -1);
          var pts = [];
          s.values.forEach(function (v, i) { if (v != null) pts.push({ p: [padL + band * (i + 0.5), vpos(v)], v: v, i: i }); });
          // runs of points with no gap; a projected run is dashed, joined to the last actual point
          var runs = [], cur = [];
          s.values.forEach(function (v, i) { if (v == null) { if (cur.length) runs.push(cur); cur = []; } else cur.push(pts.filter(function (q) { return q.i === i; })[0]); });
          if (cur.length) runs.push(cur);
          runs.forEach(function (rn) {
            var actual = rn.filter(function (q) { return !projected(q.i); }), ahead = rn.filter(function (q) { return projected(q.i); });
            if (ahead.length && actual.length) ahead.unshift(actual[actual.length - 1]);
            var path = function (qs) { return qs.map(function (q, k) { return (k ? 'L' : 'M') + q.p[0].toFixed(1) + ',' + q.p[1].toFixed(1); }).join(''); };
            [[actual, ''], [ahead, ' stroke-dasharray="6 4"']].forEach(function (pair) {
              var qs = pair[0];
              if (qs.length < 1) return;
              var d = path(qs);
              if (T === 'area') parts.push('<path class="dx-ch-area" d="' + d + 'L' + qs[qs.length - 1].p[0].toFixed(1) + ',' + zero.toFixed(1) + 'L' + qs[0].p[0].toFixed(1) + ',' + zero.toFixed(1) + 'Z" style="fill:' + c + '"' + (pair[1] ? ' fill-opacity="0.5"' : '') + '/>');
              parts.push('<path class="dx-ch-line" d="' + d + '" style="stroke:' + c + '"' + pair[1] + '/>');
            });
          });
          pts.forEach(function (q) {
            var pr = projected(q.i);
            parts.push('<circle class="dx-ch-mark dx-ch-pt" cx="' + q.p[0].toFixed(1) + '" cy="' + q.p[1].toFixed(1) + '" r="' + (nx > 40 ? 2.5 : 3.5) + '" style="' + (pr ? 'fill:var(--dxc-bg);stroke:' + c : 'fill:' + c) + '"' + (pr ? ' stroke-width="1.5"' : '') + '>' +
              tip([spec.x[q.i], s.name + ': ' + full(q.v) + unit + (pr ? ' (projected)' : '')]) + '</circle>');
            top(q.i, q.p[1]);
            if (showLabel(q.i)) parts.push(vlabel(q.p[0], q.p[1] - 8, q.v));
          });
        });
      }
      // notes on points: a short stem and the words, above the highest mark at that x
      (spec.notes || []).forEach(function (nt) {
        var i = spec.x.indexOf(nt.x);
        if (i < 0 || horiz) return;
        var nxp = padL + band * (i + 0.5), ny = tops[i] != null ? tops[i] : padT + ph / 2;
        var ty = Math.max(padT - 4, ny - 22);
        parts.push('<g class="dx-ch-note"><line x1="' + nxp.toFixed(1) + '" x2="' + nxp.toFixed(1) + '" y1="' + (ny - 3).toFixed(1) + '" y2="' + (ty + 3).toFixed(1) + '"/>' +
          '<text text-anchor="' + (nxp > W - 120 ? 'end' : nxp < padL + 60 ? 'start' : 'middle') + '" x="' + nxp.toFixed(1) + '" y="' + ty.toFixed(1) + '">' + esc(trunc(nt.text, 40)) + '</text>' + tip([nt.x, nt.text]) + '</g>');
      });
    }
    // the target: a dashed line across, named at its end
    if (spec.target && T !== 'scatter') {
      var tp = vpos(spec.target.value);
      parts.push(horiz ? '<g class="dx-ch-target"><line x1="' + tp.toFixed(1) + '" x2="' + tp.toFixed(1) + '" y1="' + padT + '" y2="' + (padT + ph) + '"/><text text-anchor="middle" x="' + tp.toFixed(1) + '" y="' + (padT - 3) + '">' + esc(spec.target.label + ' ' + fmt(spec.target.value)) + '</text></g>'
        : '<g class="dx-ch-target"><line x1="' + padL + '" x2="' + (padL + pw) + '" y1="' + tp.toFixed(1) + '" y2="' + tp.toFixed(1) + '"/><text text-anchor="end" x="' + (padL + pw - 2) + '" y="' + (tp - 4).toFixed(1) + '">' + esc(spec.target.label + ' ' + fmt(spec.target.value)) + '</text></g>');
    }
    if (multi) parts.push(legend(spec.series.map(function (s) { return s.name; }), function (i) { return col(i, -1); }));
    else if (projIdx >= 0) parts.push(legend([], palette));
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
    var body = spec.x.map(function (x, i) { return '<tr><td>' + esc(x) + '</td>' + spec.series.map(function (s) { var v = s.values[i]; return '<td>' + (v == null ? '' : esc(Array.isArray(v) ? v.map(full).join(' \u2013 ') : full(v))) + '</td>'; }).join('') + '</tr>'; }).join('');
    return '<table class="dx-chart-table"><thead>' + head + '</thead><tbody>' + body + '</tbody></table>';
  }
  /** The block as HTML for the doc: the chart, its note, a Data button and the hidden table; or a box saying what is wrong. */
  function toHtml(text, opts) {
    var r = parse(text, opts);
    var src = esc(typeof text === 'string' ? text : JSON.stringify(text));
    if (r.pending) return '<figure class="dx-chart dx-chart--csv" data-src="' + src + '" data-csv="' + esc(r.pending) + '"><div class="dx-chart-wait">Reading ' + esc(r.pending) + '\u2026</div></figure>';
    if (r.error) return '<div class="dx-chart dx-chart--bad" data-src="' + src + '"><b>This chart could not be drawn:</b> ' + esc(r.error) + '.</div>';
    return '<figure class="dx-chart" data-src="' + src + '">' + toSvg(r.spec) + (r.spec.note ? '<figcaption>' + esc(r.spec.note) + '</figcaption>' : '') +
      '<button type="button" class="dx-chart-data" data-act="chart-data">Data</button><div class="dx-chart-tablewrap" hidden>' + toTable(r.spec) + '</div></figure>';
  }
  /** Every chart block in a doc's Markdown that cannot be drawn: [{ line, section, error }]. opts.loadCsv(path) gives a CSV file's text
   *  (false when it is not there); without it a chart from a CSV file is not checked here. */
  function check(md, opts) {
    var lines = String(md || '').replace(/\r\n/g, '\n').split('\n'), out = [], section = '';
    for (var i = 0; i < lines.length; i++) {
      var h = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(lines[i]);
      if (h) { section = h[1]; continue; }
      var f = /^(```|~~~)\s*(chart|drawing|svg)\s*$/.exec(lines[i]);
      if (!f) continue;
      var body = [], j = i + 1;
      while (j < lines.length && lines[j].indexOf(f[1]) !== 0) body.push(lines[j++]);
      if (f[2] !== 'chart') {
        var dr = f[2] === 'svg' ? sanitizeSvg(body.join('\n')) : parseDrawing(body.join('\n'));
        if (dr.error) out.push({ line: i + 1, section: section, error: dr.error, kind: f[2] });
        i = j;
        continue;
      }
      var r = parse(body.join('\n'));
      if (r.pending && opts && opts.loadCsv) r = parse(body.join('\n'), { csvText: opts.loadCsv(r.pending) });
      if (r.error) out.push({ line: i + 1, section: section, error: r.error });
      i = j;
    }
    return out;
  }
  // ---- drawings (DX Docs mirror, row 48): a 2x2, pillars, a timeline from a ```drawing block of JSON; any ```svg block, cleaned.
  // Every word of a drawing carries data-path (where it sits in the JSON), so a click on it edits it in place (row 49).
  var DRAW_TYPES = ['quadrant', 'pillars', 'timeline'];
  /** Words wrapped to lines of at most n characters (at most max lines; the last ends in an ellipsis when cut). */
  function wrap(text, n, max) {
    var words = String(text || '').split(/\s+/).filter(Boolean), lines = [], cur = '';
    words.forEach(function (w) { if ((cur + ' ' + w).trim().length > n && cur) { lines.push(cur); cur = w; } else cur = (cur + ' ' + w).trim(); });
    if (cur) lines.push(cur);
    if (max && lines.length > max) { lines = lines.slice(0, max); lines[max - 1] = trunc(lines[max - 1] + ' …', n + 1); }
    return lines;
  }
  function tx(x, y, text, cls, pathKey, anchor, n, max, lh) {
    var lines = n ? wrap(text, n, max) : [String(text || '')];
    return '<text class="' + cls + '" x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" text-anchor="' + (anchor || 'middle') + '"' + (pathKey ? ' data-path="' + esc(pathKey) + '"' : '') + '>' +
      lines.map(function (l, k) { return '<tspan x="' + x.toFixed(1) + '" dy="' + (k ? (lh || 15) : 0) + '">' + esc(l) + '</tspan>'; }).join('') + '</text>';
  }
  /** A drawing's spec, read and checked: { spec } or { error }. */
  function parseDrawing(text) {
    var o;
    try { o = typeof text === 'string' ? JSON.parse(text) : text; } catch (e) { return { error: 'the drawing is not valid JSON (' + String(e.message).replace(/^JSON\.parse: /, '') + ')' }; }
    if (!o || typeof o !== 'object' || Array.isArray(o)) return { error: 'a drawing is one JSON object, like {"type":"timeline","events":[{"date":"Jan","title":"Kickoff"}]}' };
    var type = String(o.type || '').toLowerCase();
    if (DRAW_TYPES.indexOf(type) < 0) return { error: '"type" is one of ' + DRAW_TYPES.join(', ') + ' (for anything else, draw it as an ```svg block)' };
    var s = function (v) { return v == null ? '' : String(v).slice(0, 300); };
    if (type === 'quadrant') {
      var q = Array.isArray(o.quadrants) ? o.quadrants.map(s) : [];
      if (q.length !== 4) return { error: 'a quadrant names its four boxes in "quadrants": top left, top right, bottom left, bottom right' };
      var items = Array.isArray(o.items) ? o.items : [];
      for (var i = 0; i < items.length; i++) if (!items[i] || !num(items[i].x) || !num(items[i].y) || items[i].x < 0 || items[i].x > 1 || items[i].y < 0 || items[i].y > 1) return { error: 'item ' + (i + 1) + ' needs "x" and "y" from 0 to 1 (0,0 is the bottom left), and a "label"' };
      var ax = function (a) { a = a || {}; return { low: s(a.low), high: s(a.high), label: s(a.label) }; };
      return { spec: { type: type, title: s(o.title), x: ax(o.x), y: ax(o.y), quadrants: q, items: items.slice(0, 40).map(function (it) { return { label: s(it.label), x: it.x, y: it.y }; }) } };
    }
    if (type === 'pillars') {
      var ps = Array.isArray(o.pillars) ? o.pillars : [];
      if (ps.length < 2 || ps.length > 6) return { error: 'pillars are two to six: "pillars": [{"title":"...","points":["..."]}]' };
      for (var p = 0; p < ps.length; p++) if (!ps[p] || !String(ps[p].title || '').trim()) return { error: 'pillar ' + (p + 1) + ' needs a "title"' };
      return { spec: { type: type, title: s(o.title), roof: s(o.roof), base: s(o.base), pillars: ps.map(function (pp) { return { title: s(pp.title), points: (Array.isArray(pp.points) ? pp.points : []).slice(0, 8).map(s) }; }) } };
    }
    var ev = Array.isArray(o.events) ? o.events : [];
    if (ev.length < 2 || ev.length > 14) return { error: 'a timeline has two to fourteen "events": [{"date":"...","title":"...","text":"..."}]' };
    for (var k = 0; k < ev.length; k++) if (!ev[k] || !String(ev[k].title || '').trim()) return { error: 'event ' + (k + 1) + ' needs a "title"' };
    return { spec: { type: type, title: s(o.title), events: ev.map(function (e) { return { date: s(e.date), title: s(e.title), text: s(e.text) }; }) } };
  }
  function drawingToSvg(sp) {
    var W = 640, H = sp.type === 'timeline' ? 300 : 420, out = [];
    var top = sp.title ? 34 : 12;
    // pillars stand as tall as their longest list needs
    if (sp.type === 'pillars') {
      var pwGuess = (W - 60 - 14 * (sp.pillars.length - 1)) / sp.pillars.length, cplG = Math.max(8, Math.floor(pwGuess / 6.6)) - 2;
      var need = Math.max.apply(null, sp.pillars.map(function (pp) { return pp.points.reduce(function (h, pt) { return h + wrap(pt, cplG, 3).length * 14 + 6; }, 0); }));
      H = top + 8 + (sp.roof ? 52 : 0) + 6 + Math.max(110, 58 + need + 12) + 6 + (sp.base ? 40 : 0) + 12;
    }
    out.push('<svg class="dx-drawing-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(sp.title || sp.type) + '" xmlns="http://www.w3.org/2000/svg">');
    if (sp.title) out.push(tx(20, 22, sp.title, 'dx-dr-title', 'title', 'start'));
    if (sp.type === 'quadrant') {
      var L = 110, T = top + 10, S = Math.min(W - L - 30, H - T - 60), half = S / 2;
      [[0, 0], [1, 0], [0, 1], [1, 1]].forEach(function (c, k) {
        out.push('<rect class="dx-dr-box dx-dr-q' + k + '" x="' + (L + c[0] * half).toFixed(1) + '" y="' + (T + c[1] * half).toFixed(1) + '" width="' + half.toFixed(1) + '" height="' + half.toFixed(1) + '"/>');
        out.push(tx(L + c[0] * half + half / 2, T + c[1] * half + 22, sp.quadrants[k], 'dx-dr-qname', 'quadrants.' + k, 'middle', 30, 2));
      });
      out.push('<line class="dx-dr-axis" x1="' + L + '" y1="' + (T + S) + '" x2="' + (L + S + 8) + '" y2="' + (T + S) + '"/><line class="dx-dr-axis" x1="' + L + '" y1="' + (T + S) + '" x2="' + L + '" y2="' + (T - 8) + '"/>');
      out.push(tx(L, T + S + 18, sp.x.low, 'dx-dr-small', 'x.low', 'start') + tx(L + S, T + S + 18, sp.x.high, 'dx-dr-small', 'x.high', 'end') + tx(L + S / 2, T + S + 36, sp.x.label, 'dx-dr-label', 'x.label'));
      out.push(tx(L - 8, T + S, sp.y.low, 'dx-dr-small', 'y.low', 'end', 14, 2) + tx(L - 8, T + 10, sp.y.high, 'dx-dr-small', 'y.high', 'end', 14, 2) + tx(L - 60, T + S / 2, sp.y.label, 'dx-dr-label', 'y.label', 'middle', 14, 3));
      sp.items.forEach(function (it, k) {
        var x = L + it.x * S, y = T + (1 - it.y) * S;
        out.push('<circle class="dx-dr-dot" cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="6"><title>' + esc(it.label) + '</title></circle>' + tx(x + 9, y + 4, it.label, 'dx-dr-item', 'items.' + k + '.label', 'start', 22, 2));
      });
    } else if (sp.type === 'pillars') {
      var n = sp.pillars.length, gap = 14, x0 = 30, wAll = W - 60, pw = (wAll - gap * (n - 1)) / n;
      var roofH = sp.roof ? 52 : 0, baseH = sp.base ? 40 : 0, pT = top + 8 + roofH + 6, pB = H - 12 - baseH - 6;
      if (sp.roof) {
        out.push('<path class="dx-dr-roof" d="M' + (x0 - 10) + ',' + (top + 8 + roofH) + 'L' + (W / 2) + ',' + (top + 8) + 'L' + (x0 + wAll + 10) + ',' + (top + 8 + roofH) + 'Z"/>');
        out.push(tx(W / 2, top + 8 + roofH - 12, sp.roof, 'dx-dr-roofname', 'roof', 'middle', 60, 1));
      }
      sp.pillars.forEach(function (pp, k) {
        var x = x0 + k * (pw + gap), cpl = Math.max(8, Math.floor(pw / 6.6));
        out.push('<rect class="dx-dr-pillar" x="' + x.toFixed(1) + '" y="' + pT + '" width="' + pw.toFixed(1) + '" height="' + (pB - pT) + '" rx="4"/>');
        out.push(tx(x + pw / 2, pT + 22, pp.title, 'dx-dr-ptitle', 'pillars.' + k + '.title', 'middle', Math.max(8, Math.floor(pw / 7.5)), 2));
        var y = pT + 58;
        pp.points.forEach(function (pt, j) {
          var lines = wrap(pt, cpl - 2, 3);
          if (y + lines.length * 14 > pB - 6) return;
          out.push(tx(x + 10, y, '• ' + pt, 'dx-dr-point', 'pillars.' + k + '.points.' + j, 'start', cpl - 2, 3, 14));
          y += lines.length * 14 + 6;
        });
      });
      if (sp.base) { out.push('<rect class="dx-dr-base" x="' + (x0 - 10) + '" y="' + (H - 12 - baseH) + '" width="' + (wAll + 20) + '" height="' + baseH + '" rx="4"/>'); out.push(tx(W / 2, H - 12 - baseH / 2 + 5, sp.base, 'dx-dr-roofname', 'base', 'middle', 80, 1)); }
    } else {
      var m = sp.events.length, lx0 = 40, lx1 = W - 40, ly = top + (H - top) / 2, step = (lx1 - lx0) / (m - 1 || 1);
      out.push('<line class="dx-dr-axis" x1="' + lx0 + '" y1="' + ly + '" x2="' + lx1 + '" y2="' + ly + '"/>');
      var cpl2 = Math.max(10, Math.floor(step / 6.2));
      sp.events.forEach(function (e, k) {
        var x = lx0 + k * step, up = k % 2 === 0, anchor = k === 0 ? 'start' : k === m - 1 ? 'end' : 'middle';
        out.push('<circle class="dx-dr-dot" cx="' + x.toFixed(1) + '" cy="' + ly + '" r="6"/>');
        out.push('<line class="dx-dr-stem" x1="' + x.toFixed(1) + '" x2="' + x.toFixed(1) + '" y1="' + (ly + (up ? -8 : 8)) + '" y2="' + (ly + (up ? -26 : 26)) + '"/>');
        var by = up ? ly - 86 : ly + 40;
        out.push(tx(x, by, e.date, 'dx-dr-date', 'events.' + k + '.date', anchor, cpl2, 1));
        out.push(tx(x, by + 17, e.title, 'dx-dr-ptitle', 'events.' + k + '.title', anchor, cpl2, 2));
        if (e.text) out.push(tx(x, by + 47, e.text, 'dx-dr-point', 'events.' + k + '.text', anchor, cpl2 + 2, 2, 13));
      });
    }
    out.push('</svg>');
    return out.join('');
  }
  // ---- an agent's own SVG, cleaned: only drawing elements and their attributes stay; no script, no event, no outside link or page
  var SVG_TAGS = ['svg', 'g', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'path', 'text', 'tspan', 'title', 'desc', 'defs', 'lineargradient', 'radialgradient', 'stop', 'marker', 'clippath', 'mask', 'pattern', 'use', 'symbol'];
  var SVG_ATTRS = /^(viewbox|preserveaspectratio|xmlns|xmlns:xlink|width|height|x|y|x1|x2|y1|y2|cx|cy|r|rx|ry|d|points|transform|fill|fill-opacity|fill-rule|stroke|stroke-width|stroke-opacity|stroke-dasharray|stroke-dashoffset|stroke-linecap|stroke-linejoin|stroke-miterlimit|opacity|font-family|font-size|font-weight|font-style|text-anchor|dominant-baseline|alignment-baseline|letter-spacing|dx|dy|rotate|textlength|offset|stop-color|stop-opacity|gradientunits|gradienttransform|x1|spreadmethod|markerwidth|markerheight|refx|refy|orient|markerunits|marker-start|marker-mid|marker-end|clip-path|clippathunits|mask|patternunits|patterncontentunits|id|class|style|role|aria-label|href|xlink:href|data-path|visibility|display)$/;
  function safeStyle(v) { return !/url\s*\(\s*(?!['"]?#)|expression|@import|javascript:|behaviou?r/i.test(v); }
  /** { svg } cleaned, or { error } when there is no drawing in it. Elements outside the list go with all they hold. */
  function sanitizeSvg(src) {
    var s = String(src || '');
    if (s.length > 300000) return { error: 'the SVG is over 300 KB' };
    s = s.replace(/<!--[\s\S]*?-->/g, '').replace(/<\?[\s\S]*?\?>/g, '').replace(/<!DOCTYPE[^>]*>/gi, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
    var re = /<(\/?)([a-zA-Z][\w:.-]*)((?:\s+[\w:.-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>|([^<]+)|(<)/g, m, out = [], skip = 0, stack = [], removed = [];
    while ((m = re.exec(s))) {
      if (m[6]) { if (!skip) out.push('&lt;'); continue; }
      if (m[5] != null) { if (!skip) out.push(m[5].replace(/>/g, '&gt;')); continue; }
      var close = m[1] === '/', name = m[2].toLowerCase(), self = m[4] === '/';
      var ok = SVG_TAGS.indexOf(name) >= 0;
      if (skip) { if (!self) { if (close) skip--; else skip++; } continue; }
      if (!ok) { removed.push(name); if (!self && !close) skip = 1; continue; }
      if (close) { if (stack.length && stack[stack.length - 1] === name) { stack.pop(); out.push('</' + name + '>'); } continue; }
      var attrs = [], ar = /([\w:.-]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g, a;
      while ((a = ar.exec(m[3]))) {
        var an = a[1].toLowerCase(), av = a[2] == null ? '' : a[2].replace(/^["']|["']$/g, '');
        if (!SVG_ATTRS.test(an)) { removed.push(an); continue; }
        if ((an === 'href' || an === 'xlink:href') && av.charAt(0) !== '#') { removed.push(an); continue; }
        if (an === 'style' && !safeStyle(av)) { removed.push('style'); continue; }
        if (/url\s*\(/i.test(av) && !/^url\(\s*['"]?#[\w-]+['"]?\s*\)$/i.test(av.trim()) && an !== 'style') { removed.push(an); continue; }
        attrs.push(a[1] + '="' + av.replace(/&(?!(amp|lt|gt|quot|#\d+|#x[0-9a-f]+);)/gi, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;') + '"');
      }
      out.push('<' + name + (attrs.length ? ' ' + attrs.join(' ') : '') + (self ? '/>' : '>'));
      if (!self) stack.push(name);
    }
    while (stack.length) out.push('</' + stack.pop() + '>');
    var svg = out.join('').trim();
    if (!/^<svg[\s>]/.test(svg)) return { error: 'an svg block holds one <svg> drawing' };
    svg = svg.replace(/^<svg/, '<svg class="dx-drawing-svg"').replace(/^(<svg[^>]*?) class="([^"]*)"([^>]*) class="([^"]*)"/, '$1 class="$2 $4"$3');
    return { svg: svg, removed: removed };
  }
  /** A ```drawing or ```svg block as HTML for the doc. */
  function drawingHtml(kind, text, whole) {
    if (kind === 'svg') {
      var c = sanitizeSvg(text);
      if (c.error) return '<div class="dx-atom dx-chart dx-chart--bad" contenteditable="false" data-src="' + esc(whole) + '"><b>This drawing could not be shown:</b> ' + esc(c.error) + '.</div>';
      return '<div class="dx-atom dx-drawing dx-drawing--svg" contenteditable="false" data-kind="svg" data-src="' + esc(whole) + '">' + c.svg + '</div>';
    }
    var r = parseDrawing(text);
    if (r.error) return '<div class="dx-atom dx-chart dx-chart--bad" contenteditable="false" data-src="' + esc(whole) + '"><b>This drawing could not be drawn:</b> ' + esc(r.error) + '.</div>';
    return '<div class="dx-atom dx-drawing" contenteditable="false" data-kind="drawing" data-src="' + esc(whole) + '">' + drawingToSvg(r.spec) + '</div>';
  }
  var api = { parse: parse, toSvg: toSvg, toTable: toTable, toHtml: toHtml, check: check, csvRows: csvRows, TYPES: TYPES, parseDrawing: parseDrawing, drawingToSvg: drawingToSvg, sanitizeSvg: sanitizeSvg, drawingHtml: drawingHtml, DRAW_TYPES: DRAW_TYPES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.__dxCharts = api;
})(typeof window !== 'undefined' ? window : this);
