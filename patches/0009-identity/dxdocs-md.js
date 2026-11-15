/* dxdocs-md.js (patches/0009-identity): Markdown to HTML for DX Docs' sidebar (R-121). Loaded in the page before aiondx-ui.js
 * (window.__dxMd) and in Node for its test (module.exports). Everything is escaped first; only the Markdown's own structure becomes markup.
 * Headings carry data-section (their text) so a comment knows its section; a pending section's line becomes a "Writing: ..." placeholder.
 * Supports: headings, paragraphs, line breaks, bold, italic, strikethrough, inline code, links, autolinks, images, bullet / numbered / task
 * lists (nested by indent), block quotes, code fences, tables, rules. Links: http, https, mailto, file and relative paths only.
 * R-125: a ```chart block is drawn by dxcharts.js (window.__dxCharts); a ```mermaid block becomes a .dx-mermaid holder the page draws;
 * a top-level task's box carries its line (data-line) so the page can tick it. */
(function (root) {
  'use strict';
  var PENDING_RE = /^<!--\s*aiondx:pending\s*([\s\S]*?)\s*-->\s*$/;
  var CHARTS = root.__dxCharts || (typeof require === 'function' ? (function () { try { return require('./dxcharts.js'); } catch (e) { return null; } })() : null);
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function safeUrl(u) {
    var t = String(u || '').trim();
    if (/^(https?:|mailto:|file:)/i.test(t)) return t;
    if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return null;   // javascript:, data: and the rest
    return t;
  }
  /** A heading's anchor (links to it: [text](#anchor)). */
  function slug(t) { return String(t || '').toLowerCase().replace(/<[^>]*>/g, '').replace(/[^\wÀ-￿]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'section'; }
  // inline formulas: $...$ with no space just inside either $, the closing $ not followed by a digit (so "$5 and $10" stays money)
  var MATH_INLINE_RE = /(^|[^\\$\w])\$([^\s$](?:[^$\n]*[^\s$\\])?)\$(?![\d$])/g;
  function mathAtom(tex, block) {
    var src = block ? '$$' + tex + '$$' : '$' + tex + '$';
    return (block ? '<div' : '<span') + ' class="dx-atom dx-math' + (block ? ' dx-math--block' : '') + '" contenteditable="false" data-src="' + esc(src) + '" data-tex="' + esc(tex) + '">' + esc(tex) + (block ? '</div>' : '</span>');
  }
  // ---- chips (DX Docs mirror): [[date:2026-11-20]]  [[pick:In progress|Not started|In progress|Done]] (the value, then the options)
  //      [[@you]] [[@agent]] [[@Name]] (a mention)  [[tab:t2|Decisions]]  [[doc:launch-plan|Launch plan]] (links to a tab, to another doc)
  var CHIP_RE = /\[\[(date|pick|tab|doc):([^\]\n]{1,400})\]\]|\[\[@([^\]\n|]{1,80})\]\]/g;
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function dateText(v) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || '').trim()); return m && +m[2] >= 1 && +m[2] <= 12 ? MONTHS[+m[2] - 1] + ' ' + (+m[3]) + ', ' + m[1] : String(v || ''); }
  /** A chip's parts: { kind, value, options, target, label }. */
  function chipOf(kind, body, who) {
    if (who != null) return { kind: 'mention', value: who.trim() };
    var parts = String(body).split('|').map(function (x) { return x.trim(); });
    if (kind === 'date') return { kind: 'date', value: parts[0] };
    if (kind === 'pick') { var opts = parts.slice(1).filter(Boolean); if (opts.indexOf(parts[0]) < 0 && parts[0]) opts.unshift(parts[0]); return { kind: 'pick', value: parts[0], options: opts }; }
    return { kind: kind, target: parts[0], label: parts[1] || parts[0] };
  }
  function chipHtml(c, src) {
    var label = c.kind === 'date' ? dateText(c.value) : c.kind === 'pick' ? (c.value || 'Choose') : c.kind === 'mention' ? '@' + (c.value === 'agent' ? 'the agent' : c.value) : c.label;
    var cls = 'dx-atom dx-chip dx-chip--' + c.kind + (c.kind === 'pick' ? ' dx-pick-' + slug(c.value) : '');
    return '<span class="' + cls + '" contenteditable="false" data-src="' + esc(src) + '" data-kind="' + c.kind + '"' +
      (c.value != null ? ' data-value="' + esc(c.value) + '"' : '') + (c.options ? ' data-options="' + esc(c.options.join('|')) + '"' : '') + (c.target != null ? ' data-target="' + esc(c.target) + '"' : '') +
      '>' + esc(label) + (c.kind === 'pick' ? '<span class="dx-chip-caret">▾</span>' : '') + '</span>';
  }
  function inline(src) {
    var codes = [];
    var s = String(src).replace(/`([^`]+)`/g, function (m, c) { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
    var chips = [];
    s = s.replace(CHIP_RE, function (m, kind, body, who) { chips.push(chipHtml(chipOf(kind, body, who), m)); return '\u0002' + (chips.length - 1) + '\u0002'; });
    var maths = [];
    s = s.replace(MATH_INLINE_RE, function (m, pre, tex) { maths.push(tex); return pre + '\u0001' + (maths.length - 1) + '\u0001'; });
    s = esc(s);
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g, function (m, alt, url, title) {
      var u = safeUrl(url.replace(/&amp;/g, '&'));
      return u === null ? esc(alt) : '<img src="' + esc(u) + '" alt="' + alt + '"' + (title ? ' title="' + title + '"' : '') + '>';
    });
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (m, text, url) {
      var u = safeUrl(url.replace(/&amp;/g, '&'));
      return u === null ? text : '<a href="' + esc(u) + '">' + text + '</a>';
    });
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, function (m, pre, url) { return pre + '<a href="' + url + '">' + url + '</a>'; });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>').replace(/(^|[^\w_])_([^_\s][^_]*)_(?![\w])/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    s = s.replace(/\+\+([^+\s](?:[^+]*[^+\s])?)\+\+/g, '<u>$1</u>');            // ++underline++
    s = s.replace(/==([^=\s](?:[^=]*[^=\s])?)==/g, '<mark>$1</mark>');            // ==highlight==
    s = s.replace(/\u0001(\d+)\u0001/g, function (m, i) { return mathAtom(maths[+i], false); });
    s = s.replace(/\u0002(\d+)\u0002/g, function (m, i) { return chips[+i]; });
    s = s.replace(/\u0000(\d+)\u0000/g, function (m, i) { return '<code>' + esc(codes[+i]) + '</code>'; });
    return s;
  }
  // ---- tables: a cell may end with attributes, {.bg-green w=160} (colour, and on a header cell the column's width); a cell that is
  // exactly << joins the cell on its left (a merged cell). Colours: the seven Claude Docs offers.
  var CELL_COLOURS = ['gray', 'red', 'orange', 'yellow', 'green', 'blue', 'purple'];
  var CELL_ATTR_RE = /\s*\{((?:\s*(?:\.bg-[a-z]+|w=\d{1,4}))+)\s*\}\s*$/;
  function cellAttrs(text) {
    var m = CELL_ATTR_RE.exec(text), o = { text: text, bg: '', w: 0 };
    if (!m) return o;
    o.text = text.slice(0, m.index);
    m[1].trim().split(/\s+/).forEach(function (a) {
      var b = /^\.bg-([a-z]+)$/.exec(a); if (b && CELL_COLOURS.indexOf(b[1]) >= 0) o.bg = b[1];
      var w = /^w=(\d+)$/.exec(a); if (w) o.w = Math.max(40, Math.min(900, +w[1]));
    });
    return o;
  }
  /** Rows of cells as written, to [[{ text, bg, w, span }]] with merged cells folded into the cell on their left. */
  function tableModel(rows) {
    return rows.map(function (r) {
      var out = [];
      r.forEach(function (c) {
        if (c === '<<' && out.length) { out[out.length - 1].span++; return; }
        var a = cellAttrs(c);
        out.push({ text: a.text, bg: a.bg, w: a.w, span: 1 });
      });
      return out;
    });
  }
  var CALLOUTS = { NOTE: 'Note', TIP: 'Tip', WARNING: 'Warning', DECISION: 'Decision', IMPORTANT: 'Important', CAUTION: 'Caution' };
  var CALLOUT_RE = /^\[!(note|tip|warning|decision|important|caution)\]\s*(.*)$/i;
  // ---- question and approval blocks (DX Docs mirror: the tools for question docs and plans). JSON in a fenced block:
  //   ```choice  {"question":"...","options":["A","B"],"multi":false,"answer":[]}      the user picks; the answer is saved and sent to the agent
  //   ```approve {"label":"Approve the plan","status":"open"|"approved"|"changes","note":"","by":"","at":0}
  /** A question or approval block read: { spec } or { error } (the line an agent needs to fix it). */
  function blockSpec(kind, text) {
    var s;
    try { s = JSON.parse(String(text || '').trim() || '{}'); } catch (e) { return { error: 'its JSON does not read (' + String(e.message).slice(0, 80) + ')' }; }
    if (!s || typeof s !== 'object' || Array.isArray(s)) return { error: 'it is not a JSON object' };
    if (kind === 'choice') {
      if (!String(s.question || '').trim()) return { error: 'it needs "question"' };
      if (!Array.isArray(s.options) || s.options.length < 2 || s.options.some(function (o) { return typeof o !== 'string' || !o.trim(); })) return { error: 'it needs "options": two or more strings' };
      var ans = Array.isArray(s.answer) ? s.answer : s.answer ? [s.answer] : [];
      return { spec: { question: String(s.question), options: s.options.map(String), multi: !!s.multi, answer: ans.filter(function (a) { return s.options.indexOf(a) >= 0; }), by: s.by ? String(s.by) : '', at: +s.at || 0, note: s.note ? String(s.note) : '' } };
    }
    var st = s.status || 'open';
    if (['open', 'approved', 'changes'].indexOf(st) < 0) return { error: '"status" is open, approved or changes' };
    return { spec: { label: String(s.label || 'Approve this plan'), status: st, note: s.note ? String(s.note) : '', by: s.by ? String(s.by) : '', at: +s.at || 0 } };
  }
  var qn = 0;
  function blockCard(kind, text, whole) {
    var r = blockSpec(kind, text);
    if (r.error) return '<div class="dx-atom dx-chart dx-chart--bad" contenteditable="false" data-src="' + esc(whole) + '">This ' + (kind === 'choice' ? 'question' : 'approval') + ' block cannot be shown: ' + esc(r.error) + '.</div>';
    var s = r.spec, h = [];
    var when = s.at ? ' · ' + dateText(new Date(s.at).toISOString().slice(0, 10)) : '';
    if (kind === 'choice') {
      var name = 'dxq' + (++qn);
      h.push('<div class="dx-atom dx-choice' + (s.answer.length ? ' dx-choice--answered' : '') + '" contenteditable="false" data-kind="choice" data-src="' + esc(whole) + '">');
      h.push('<div class="dx-choice-q">' + inline(s.question) + '</div>');
      s.options.forEach(function (o) {
        h.push('<label class="dx-choice-opt"><input type="' + (s.multi ? 'checkbox' : 'radio') + '" name="' + name + '" data-opt="' + esc(o) + '"' + (s.answer.indexOf(o) >= 0 ? ' checked' : '') + '> <span>' + inline(o) + '</span></label>');
      });
      h.push('<div class="dx-choice-state">' + (s.answer.length ? 'Answered' + (s.by ? ' by ' + esc(s.by) : '') + when + ': ' + esc(s.answer.join(', ')) : s.multi ? 'Tick any that apply.' : 'Pick one.') + '</div></div>');
    } else {
      h.push('<div class="dx-atom dx-approve dx-approve--' + s.status + '" contenteditable="false" data-kind="approve" data-src="' + esc(whole) + '">');
      h.push('<div class="dx-approve-label">' + inline(s.label) + '</div>');
      h.push('<div class="dx-approve-state">' + (s.status === 'approved' ? 'Approved' + (s.by ? ' by ' + esc(s.by) : '') + when : s.status === 'changes' ? 'Changes asked' + (s.by ? ' by ' + esc(s.by) : '') + when + (s.note ? ': ' + esc(s.note) : '') : 'Waiting for approval') + '</div>');
      h.push('<div class="dx-approve-row"><button type="button" class="dx-btn dx-btn--primary" data-approve="yes">' + (s.status === 'approved' ? 'Approved' : 'Approve') + '</button><button type="button" class="dx-btn" data-approve="changes">Ask for changes</button></div></div>');
    }
    return h.join('');
  }
  function splitRow(row) { return row.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(function (c) { return c.trim().replace(/\\\|/g, '|'); }); }
  /** A CSV block's rows (quotes and doubled quotes as in a spreadsheet's CSV). */
  function csvRows(text) {
    var rows = [], row = [], cell = '', q = false, s = String(text || '');
    for (var k = 0; k < s.length; k++) {
      var ch = s[k];
      if (q) { if (ch === '"' && s[k + 1] === '"') { cell += '"'; k++; } else if (ch === '"') q = false; else cell += ch; continue; }
      if (ch === '"' && cell === '') { q = true; continue; }
      if (ch === ',') { row.push(cell); cell = ''; continue; }
      if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[k + 1] === '\n') k++; row.push(cell); rows.push(row); row = []; cell = ''; continue; }
      cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (c) { return c.trim(); }); });
  }
  function tableHtml(model, aligns, opts) {
    var t = ['<table' + (opts && opts.cls ? ' class="' + opts.cls + '"' : '') + '><thead><tr>'];
    var cellHtml = function (c, k, tag) {
      var st = [];
      if (aligns[k]) st.push('text-align:' + aligns[k]);
      if (tag === 'th' && c.w) st.push('width:' + c.w + 'px');
      return '<' + tag + (c.span > 1 ? ' colspan="' + c.span + '"' : '') + (c.bg ? ' class="dx-bg-' + c.bg + '"' : '') + (tag === 'th' && c.w ? ' data-w="' + c.w + '"' : '') +
        (st.length ? ' style="' + st.join(';') + '"' : '') + '>' + (opts && opts.plain ? esc(c.text) : inline(c.text)) + '</' + tag + '>';
    };
    var col = 0;
    (model[0] || []).forEach(function (c) { t.push(cellHtml(c, col, 'th')); col += c.span; });
    t.push('</tr></thead><tbody>');
    model.slice(1).forEach(function (r) { t.push('<tr>'); col = 0; r.forEach(function (c) { t.push(cellHtml(c, col, 'td')); col += c.span; }); t.push('</tr>'); });
    t.push('</tbody></table>');
    return t.join('');
  }
  function renderList(lines, start) {
    // lines: [{indent, ordered, text, task}] from start while indent >= base
    var base = lines[start].indent, ordered = lines[start].ordered;
    // a numbered list starts where its first number says (5. starts at 5)
    var out = [ordered ? (lines[start].num > 1 ? '<ol start="' + lines[start].num + '">' : '<ol>') : '<ul>'], i = start;
    while (i < lines.length && lines[i].indent >= base) {
      if (lines[i].indent > base) { var sub = renderList(lines, i); out[out.length - 1] = out[out.length - 1].replace(/<\/li>$/, sub.html + '</li>'); i = sub.next; continue; }
      var it = lines[i], body = inline(it.text);
      if (it.task !== null) body = '<input type="checkbox" class="dx-tick"' + (it.line != null ? ' data-line="' + it.line + '"' : ' disabled') + (it.task ? ' checked' : '') + '> ' + body;
      out.push('<li' + (it.task !== null ? ' class="dx-task"' : '') + '>' + body + '</li>');
      i++;
    }
    out.push(ordered ? '</ol>' : '</ul>');
    return { html: out.join(''), next: i };
  }
  function toHtml(md, nested) {
    var lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
    var out = [], i = 0, section = '';
    var isBlockStart = function (l) { return /^(#{1,6}\s|```|~~~|>\s?|\s*([-*+]|\d+[.)])\s+|\s*(-{3,}|\*{3,}|_{3,})\s*$|\||\s*\$\$)/.test(l) || PENDING_RE.test(l.trim()) || TAB_RE.test(l); };
    while (i < lines.length) {
      var l = lines[i];
      if (!l.trim()) { i++; continue; }
      var fm = /^(```|~~~)\s*([\w+-]*)\s*$/.exec(l);
      if (fm) {
        var code = [], j = i + 1;
        while (j < lines.length && !new RegExp('^' + fm[1]).test(lines[j])) code.push(lines[j++]);
        var lang = fm[2].toLowerCase();
        var whole = fm[1] + fm[2] + '\n' + code.join('\n') + '\n' + fm[1];
        if (lang === 'chart' && CHARTS) out.push(CHARTS.toHtml(code.join('\n')));
        else if (lang === 'mermaid') out.push('<div class="dx-mermaid" data-src="' + esc(code.join('\n')) + '"><pre><code class="language-mermaid">' + esc(code.join('\n')) + '</code></pre></div>');
        else if (lang === 'math' || lang === 'latex' || lang === 'tex') out.push(mathAtom(code.join('\n'), true).replace('data-src="' + esc('$$' + code.join('\n') + '$$') + '"', 'data-src="' + esc(whole) + '"'));
        else if (lang === 'csv') {
          // a CSV block drawn as a grid (its first row the header); the text stays the source
          var rows = csvRows(code.join('\n'));
          out.push('<div class="dx-atom dx-csv" contenteditable="false" data-src="' + esc(whole) + '">' + (rows.length ? tableHtml(rows.map(function (r) { return r.map(function (c) { return { text: c, bg: '', w: 0, span: 1 }; }); }), [], { plain: true, cls: 'dx-csv-grid' }) : '<div class="dx-csv-empty">Empty CSV</div>') + '</div>');
        }
        else if (lang === 'choice' || lang === 'approve') out.push(blockCard(lang, code.join('\n'), whole));
        else if (lang === 'markdown' || lang === 'md') out.push('<div class="dx-atom dx-mdblock" contenteditable="false" data-src="' + esc(whole) + '"><div class="dx-mdblock-tag">Markdown</div>' + toHtml(code.join('\n'), true) + '</div>');
        else out.push('<pre><code' + (fm[2] ? ' class="language-' + esc(fm[2]) + '"' : '') + '>' + esc(code.join('\n')) + '</code></pre>');
        i = j + 1; continue;
      }
      // a formula block: $$ ... $$ (on one line or several)
      if (/^\s*\$\$/.test(l)) {
        var one = /^\s*\$\$([\s\S]+?)\$\$\s*$/.exec(l);
        if (one) { out.push(mathAtom(one[1].trim(), true)); i++; continue; }
        var tex = [l.replace(/^\s*\$\$/, '')], k2 = i + 1;
        while (k2 < lines.length && !/\$\$\s*$/.test(lines[k2])) tex.push(lines[k2++]);
        if (k2 < lines.length) { tex.push(lines[k2].replace(/\$\$\s*$/, '')); out.push(mathAtom(tex.join('\n').trim(), true)); i = k2 + 1; continue; }
      }
      var tm0 = TAB_RE.exec(l);
      if (tm0) { var ta0 = tabAttrs(tm0[1]); out.push('<div class="dx-tabmark" data-tab="' + esc(ta0.id || '') + '">' + esc(ta0.title || 'Tab') + '</div>'); i++; continue; }
      var pm = PENDING_RE.exec(l.trim());
      if (pm) { out.push('<div class="dx-pending" data-section="' + esc(section) + '" data-intent="' + esc(pm[1] || '') + '"><span class="dx-pending-dot"></span>Writing: ' + esc(pm[1] || 'this section') + '</div>'); i++; continue; }
      var hm = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
      if (hm) { section = hm[2]; out.push('<h' + hm[1].length + ' id="' + esc(slug(hm[2])) + '" data-section="' + esc(hm[2]) + '">' + inline(hm[2]) + '</h' + hm[1].length + '>'); i++; continue; }
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
      if (/^>\s?/.test(l)) {
        var q = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, ''));
        // a callout: > [!NOTE] (also TIP, WARNING, DECISION, IMPORTANT, CAUTION), the way GitHub writes them
        var cm = q.length && CALLOUT_RE.exec(q[0]);
        if (cm) {
          var kind = cm[1].toUpperCase();
          var rest = (cm[2] ? [cm[2]] : []).concat(q.slice(1));
          out.push('<blockquote class="dx-callout dx-callout--' + kind.toLowerCase() + '" data-callout="' + kind + '"><div class="dx-callout-tag" contenteditable="false">' + CALLOUTS[kind] + '</div>' + toHtml(rest.join('\n'), true) + '</blockquote>');
          continue;
        }
        out.push('<blockquote>' + toHtml(q.join('\n'), true) + '</blockquote>'); continue;
      }
      if (/^\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
        var aligns = splitRow(lines[i + 1]).map(function (c) { return /^:-+:$/.test(c) ? 'center' : /^:-+$/.test(c) ? 'left' : /-+:$/.test(c) ? 'right' : ''; });
        var trows = [splitRow(l)];
        i += 2;
        while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) trows.push(splitRow(lines[i++]));
        out.push(tableHtml(tableModel(trows), aligns));
        continue;
      }
      if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
        var items = [];
        while (i < lines.length && (/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) || (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length))) {
          var m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
          if (!m) { items[items.length - 1].text += ' ' + lines[i].trim(); i++; continue; }
          var tm = /^\[([ xX])\]\s+(.*)$/.exec(m[3]);
          items.push({ indent: m[1].replace(/\t/g, '    ').length, ordered: /\d/.test(m[2]), num: /\d/.test(m[2]) ? parseInt(m[2], 10) : 0, text: tm ? tm[2] : m[3], task: tm ? tm[1] !== ' ' : null, line: nested ? null : i });
          i++;
        }
        var pos = 0;
        while (pos < items.length) { var r = renderList(items, pos); out.push(r.html); pos = r.next; }
        continue;
      }
      var para = [];
      while (i < lines.length && lines[i].trim() && !(para.length && isBlockStart(lines[i]))) para.push(lines[i++]);
      out.push('<p>' + para.map(inline).join('<br>') + '</p>');
    }
    return out.join('\n');
  }
  // ---- tabs (DX Docs mirror, November 15th, 2026). A doc stays one Markdown file; each tab starts with its marker line, an HTML comment
  // that other Markdown readers hide:   <!-- dx:tab id="t2" title="Decisions" parent="t1" -->
  // A doc with no marker is one tab, "main" (implicit: nothing is written for it). Sub-tabs name their parent; order is the file's order.
  var TAB_RE = /^<!--\s*dx:tab\s+([\s\S]*?)\s*-->\s*$/;
  function tabAttrs(s) {
    var o = {};
    String(s).replace(/([a-z]+)="((?:[^"\\]|\\.)*)"/g, function (m, k, v) { o[k] = v.replace(/\\(.)/g, '$1'); return ''; });
    return o;
  }
  function tabAttr(v) { return String(v == null ? '' : v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/-->/g, '- ->').replace(/[\r\n]+/g, ' '); }
  function trimLines(a) { while (a.length && !a[a.length - 1].trim()) a.pop(); while (a.length && !a[0].trim()) a.shift(); return a.join('\n'); }
  /** { title, tabs: [{ id, title, parent, body, implicit }] }: the doc's title line, then each tab's Markdown (headings, lead, sections). */
  function splitTabs(md) {
    var lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
    var i = 0;
    while (i < lines.length && !lines[i].trim()) i++;
    var title = '';
    if (i < lines.length && /^#\s+/.test(lines[i])) { title = lines[i].replace(/^#\s+/, '').trim(); i++; }
    var pre = [], tabs = [], cur = null, fence = false;
    for (; i < lines.length; i++) {
      var l = lines[i];
      if (/^\s*(```|~~~)/.test(l)) fence = !fence;
      var m = !fence && TAB_RE.exec(l);
      if (m) {
        var a = tabAttrs(m[1]);
        cur = { id: a.id || 't' + (tabs.length + 1), title: a.title || 'Untitled tab', parent: a.parent || '', body: [] };
        tabs.push(cur);
        continue;
      }
      (cur ? cur.body : pre).push(l);
    }
    if (!tabs.length) return { title: title, tabs: [{ id: 'main', title: '', parent: '', body: trimLines(pre), implicit: true }] };
    tabs.forEach(function (t) { t.body = trimLines(t.body); });
    var lead = trimLines(pre);
    if (lead) tabs[0].body = lead + (tabs[0].body ? '\n\n' + tabs[0].body : '');   // text above the first marker belongs to the first tab
    var seen = {};
    tabs.forEach(function (t, k) { while (seen[t.id]) t.id = t.id + '-' + (k + 1); seen[t.id] = true; });
    tabs.forEach(function (t) { if (t.parent && (!seen[t.parent] || t.parent === t.id)) t.parent = ''; });
    return { title: title, tabs: tabs };
  }
  function joinTabs(doc) {
    var out = '# ' + (doc.title || 'Untitled') + '\n\n';
    var tabs = doc.tabs || [];
    if (tabs.length === 1 && tabs[0].implicit) out += tabs[0].body ? tabs[0].body + '\n' : '';
    else tabs.forEach(function (t) {
      out += '<!-- dx:tab id="' + tabAttr(t.id) + '" title="' + tabAttr(t.title) + '"' + (t.parent ? ' parent="' + tabAttr(t.parent) + '"' : '') + ' -->\n\n' + (t.body ? t.body + '\n\n' : '');
    });
    return out.replace(/\n{3,}/g, '\n\n').replace(/\n*$/, '\n');
  }
  /** A tab by its id, else its title (any case); null when none. */
  function findTab(doc, ref) {
    var r = String(ref == null ? '' : ref).trim();
    if (!r) return null;
    var tabs = doc.tabs || [];
    for (var k = 0; k < tabs.length; k++) if (tabs[k].id === r) return tabs[k];
    var low = r.toLowerCase();
    for (k = 0; k < tabs.length; k++) if (String(tabs[k].title).toLowerCase() === low) return tabs[k];
    return null;
  }
  /** What a tab shows, as a doc of its own: the doc's title line, then the tab's Markdown. */
  function tabView(md, ref) {
    var d = splitTabs(md);
    var t = findTab(d, ref) || d.tabs[0];
    return '# ' + (d.title || 'Untitled') + '\n\n' + (t.body ? t.body + '\n' : '');
  }
  /** The whole doc with one tab's view written back (its title line becomes the doc's title). */
  function withTabView(md, ref, view) {
    var d = splitTabs(md);
    var t = findTab(d, ref) || d.tabs[0];
    var v = splitTabs(view);
    if (v.title) d.title = v.title;
    t.body = v.tabs.map(function (x) { return x.body; }).filter(Boolean).join('\n\n');
    return joinTabs(d);
  }
  /** The tabs as the panel lists them: [{ id, title, parent, depth }] in order, sub-tabs after their parent. */
  function tabList(md) {
    var d = splitTabs(md);
    if (d.tabs.length === 1 && d.tabs[0].implicit) return [];
    var byParent = {}, out = [];
    d.tabs.forEach(function (t) { (byParent[t.parent || ''] = byParent[t.parent || ''] || []).push(t); });
    (function walk(p, depth) { (byParent[p] || []).forEach(function (t) { out.push({ id: t.id, title: t.title, parent: t.parent, depth: depth }); if (depth < 6) walk(t.id, depth + 1); }); })('', 0);
    return out;
  }
  /** A doc with tabs as one document (export, print): the title, then each tab under a heading of its own (a sub-tab's names its parent),
   *  each tab's own headings one level down. A doc without tabs is as it is. */
  function exportAll(markdown) {
    var T = splitTabs(markdown);
    if (T.tabs[0].implicit) return String(markdown || '');
    var byId = {};
    T.tabs.forEach(function (t) { byId[t.id] = t; });
    var parts = ['# ' + (T.title || 'Untitled'), ''];
    T.tabs.forEach(function (t) {
      parts.push('## ' + (t.parent && byId[t.parent] ? byId[t.parent].title + ' / ' : '') + t.title, '');
      var fence = false;
      var body = String(t.body || '').split('\n').map(function (l) {
        if (/^\s*(```|~~~)/.test(l)) fence = !fence;
        return !fence && /^#{2,5}\s/.test(l) ? '#' + l : l;
      }).join('\n');
      if (body.trim()) parts.push(body, '');
    });
    return parts.join('\n');
  }
  var api = { blockSpec: blockSpec, chipOf: chipOf, dateText: dateText, CHIP_RE: CHIP_RE, CALLOUT_RE: CALLOUT_RE, CALLOUTS: CALLOUTS, slug: slug, csvRows: csvRows, cellAttrs: cellAttrs, tableModel: tableModel, splitRow: splitRow, CELL_COLOURS: CELL_COLOURS, MATH_INLINE_RE: MATH_INLINE_RE,
    toHtml: toHtml, inline: inline, esc: esc, exportAll: exportAll, splitTabs: splitTabs, joinTabs: joinTabs, findTab: findTab, tabView: tabView, withTabView: withTabView, tabList: tabList, TAB_RE: TAB_RE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.__dxMd = api;
})(typeof window !== 'undefined' ? window : this);
