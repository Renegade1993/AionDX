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
  function inline(src) {
    var codes = [];
    var s = String(src).replace(/`([^`]+)`/g, function (m, c) { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
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
    s = s.replace(/\u0000(\d+)\u0000/g, function (m, i) { return '<code>' + esc(codes[+i]) + '</code>'; });
    return s;
  }
  function renderList(lines, start) {
    // lines: [{indent, ordered, text, task}] from start while indent >= base
    var base = lines[start].indent, ordered = lines[start].ordered;
    var out = [ordered ? '<ol>' : '<ul>'], i = start;
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
    var isBlockStart = function (l) { return /^(#{1,6}\s|```|~~~|>\s?|\s*([-*+]|\d+[.)])\s+|\s*(-{3,}|\*{3,}|_{3,})\s*$|\|)/.test(l) || PENDING_RE.test(l.trim()); };
    while (i < lines.length) {
      var l = lines[i];
      if (!l.trim()) { i++; continue; }
      var fm = /^(```|~~~)\s*([\w+-]*)\s*$/.exec(l);
      if (fm) {
        var code = [], j = i + 1;
        while (j < lines.length && !new RegExp('^' + fm[1]).test(lines[j])) code.push(lines[j++]);
        var lang = fm[2].toLowerCase();
        if (lang === 'chart' && CHARTS) out.push(CHARTS.toHtml(code.join('\n')));
        else if (lang === 'mermaid') out.push('<div class="dx-mermaid" data-src="' + esc(code.join('\n')) + '"><pre><code class="language-mermaid">' + esc(code.join('\n')) + '</code></pre></div>');
        else out.push('<pre><code' + (fm[2] ? ' class="language-' + esc(fm[2]) + '"' : '') + '>' + esc(code.join('\n')) + '</code></pre>');
        i = j + 1; continue;
      }
      var pm = PENDING_RE.exec(l.trim());
      if (pm) { out.push('<div class="dx-pending" data-section="' + esc(section) + '"><span class="dx-pending-dot"></span>Writing: ' + esc(pm[1] || 'this section') + '</div>'); i++; continue; }
      var hm = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
      if (hm) { section = hm[2]; out.push('<h' + hm[1].length + ' data-section="' + esc(hm[2]) + '">' + inline(hm[2]) + '</h' + hm[1].length + '>'); i++; continue; }
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
      if (/^>\s?/.test(l)) {
        var q = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, ''));
        out.push('<blockquote>' + toHtml(q.join('\n'), true) + '</blockquote>'); continue;
      }
      if (/^\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
        var cells = function (row) { return row.trim().replace(/^\||\|$/g, '').split('|').map(function (c) { return c.trim(); }); };
        var head = cells(l), aligns = cells(lines[i + 1]).map(function (c) { return /^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : ''; });
        var t = ['<table><thead><tr>'];
        head.forEach(function (c, k) { t.push('<th' + (aligns[k] ? ' style="text-align:' + aligns[k] + '"' : '') + '>' + inline(c) + '</th>'); });
        t.push('</tr></thead><tbody>');
        i += 2;
        while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) {
          t.push('<tr>');
          cells(lines[i]).forEach(function (c, k) { t.push('<td' + (aligns[k] ? ' style="text-align:' + aligns[k] + '"' : '') + '>' + inline(c) + '</td>'); });
          t.push('</tr>'); i++;
        }
        t.push('</tbody></table>');
        out.push(t.join('')); continue;
      }
      if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
        var items = [];
        while (i < lines.length && (/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) || (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length))) {
          var m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
          if (!m) { items[items.length - 1].text += ' ' + lines[i].trim(); i++; continue; }
          var tm = /^\[([ xX])\]\s+(.*)$/.exec(m[3]);
          items.push({ indent: m[1].replace(/\t/g, '    ').length, ordered: /\d/.test(m[2]), text: tm ? tm[2] : m[3], task: tm ? tm[1] !== ' ' : null, line: nested ? null : i });
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
  var api = { toHtml: toHtml, inline: inline, esc: esc };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.__dxMd = api;
})(typeof window !== 'undefined' ? window : this);
