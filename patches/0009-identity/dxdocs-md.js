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
    var isBlockStart = function (l) { return /^(#{1,6}\s|```|~~~|>\s?|\s*([-*+]|\d+[.)])\s+|\s*(-{3,}|\*{3,}|_{3,})\s*$|\|)/.test(l) || PENDING_RE.test(l.trim()) || TAB_RE.test(l); };
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
      var tm0 = TAB_RE.exec(l);
      if (tm0) { var ta0 = tabAttrs(tm0[1]); out.push('<div class="dx-tabmark" data-tab="' + esc(ta0.id || '') + '">' + esc(ta0.title || 'Tab') + '</div>'); i++; continue; }
      var pm = PENDING_RE.exec(l.trim());
      if (pm) { out.push('<div class="dx-pending" data-section="' + esc(section) + '" data-intent="' + esc(pm[1] || '') + '"><span class="dx-pending-dot"></span>Writing: ' + esc(pm[1] || 'this section') + '</div>'); i++; continue; }
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
  var api = { toHtml: toHtml, inline: inline, esc: esc, exportAll: exportAll, splitTabs: splitTabs, joinTabs: joinTabs, findTab: findTab, tabView: tabView, withTabView: withTabView, tabList: tabList, TAB_RE: TAB_RE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.__dxMd = api;
})(typeof window !== 'undefined' ? window : this);
