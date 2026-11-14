'use strict';
// dxdocs-word.js (patches/0009-identity): a DX Doc as a Word document (DX Docs mirror, step 4; Claude Docs exports to Word). The doc's
// Markdown, read block by block, with the app's own docx library (9.x). Charts and diagrams come as pictures of what the panel drew
// (PNG, in the order they stand); without one, a chart becomes the table of its numbers and a diagram its text. Pictures beside the doc
// are embedded. House rule for generated Word documents: each major section (##) starts on a new page; a table stays on one page where it
// fits (rows kept together).
//   toDocx(markdown, { docsDir, pictures: [{ png: <base64>, w, h }] }) -> Promise<Buffer>

const fs = require('fs');
const path = require('path');
function lib() {
  try { return require('docx'); } catch (e) { return require(path.join(__dirname, '..', '..', 'vendor', 'extracted', 'node_modules', 'docx')); }
}
let CHARTS = null;
try { CHARTS = require('./dxcharts.js'); } catch (e) { CHARTS = null; }

/** Width and height of a PNG, JPEG or GIF, read from its header; null when not known. */
function imageSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), type: 'png' };
  if (buf.length > 10 && buf.toString('ascii', 0, 3) === 'GIF') return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8), type: 'gif' };
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1], len = buf.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5), type: 'jpg' };
      i += 2 + len;
    }
  }
  return null;
}
/** Inline Markdown (what dxdocs-md draws) to runs: bold, italic, strike, code, links. */
function runs(D, text, base) {
  const out = [];
  const re = /(\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*([^*\s][^*]*)\*|(^|[^\w])_([^_\s][^_]*)_(?![\w]))/g;
  let last = 0, m;
  const plain = (t) => { if (t) out.push(new D.TextRun(Object.assign({ text: t }, base))); };
  while ((m = re.exec(text))) {
    let start = m.index;
    if (m[10] !== undefined) { plain(text.slice(last, start) + m[9]); out.push(new D.TextRun(Object.assign({ text: m[10], italics: true }, base))); last = re.lastIndex; continue; }
    plain(text.slice(last, start));
    if (m[2] !== undefined || m[3] !== undefined) out.push(new D.TextRun(Object.assign({ text: m[2] || m[3], bold: true }, base)));
    else if (m[4] !== undefined) out.push(new D.TextRun(Object.assign({ text: m[4], strike: true }, base)));
    else if (m[5] !== undefined) out.push(new D.TextRun(Object.assign({ text: m[5], font: 'Consolas' }, base)));
    else if (m[6] !== undefined) {
      const href = m[7];
      if (/^(https?:|mailto:)/i.test(href)) out.push(new D.ExternalHyperlink({ link: href, children: [new D.TextRun(Object.assign({ text: m[6], style: 'Hyperlink' }, base))] }));
      else plain(m[6]);
    } else if (m[8] !== undefined) out.push(new D.TextRun(Object.assign({ text: m[8], italics: true }, base)));
    last = re.lastIndex;
  }
  plain(text.slice(last));
  return out.length ? out : [new D.TextRun(Object.assign({ text: '' }, base))];
}

async function toDocx(markdown, o) {
  const D = lib();
  const opts = o || {};
  const pictures = Array.isArray(opts.pictures) ? opts.pictures.slice() : [];
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const kids = [];
  let firstH2 = true, numbered = 0, i = 0;
  const picture = (buf, w, h, type) => {
    const maxW = 600, scale = w > maxW ? maxW / w : 1;
    return new D.Paragraph({ keepLines: true, spacing: { before: 120, after: 120 }, children: [new D.ImageRun({ type: type || 'png', data: buf, transformation: { width: Math.round(w * scale), height: Math.round(h * scale) } })] });
  };
  const tableOf = (rows, header) => new D.Table({
    width: { size: 100, type: D.WidthType.PERCENTAGE },
    rows: rows.map((r, ri) => new D.TableRow({
      cantSplit: true, tableHeader: header && ri === 0,
      children: r.map((c) => new D.TableCell({
        shading: header && ri === 0 ? { type: D.ShadingType.CLEAR, color: 'auto', fill: 'EDEDED' } : undefined,
        children: [new D.Paragraph({ keepNext: ri < rows.length - 1, children: runs(D, String(c), header && ri === 0 ? { bold: true } : {}) })],
      })),
    })),
  });
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    const fm = /^(```|~~~)\s*([\w+-]*)\s*$/.exec(l);
    if (fm) {
      const code = []; let j = i + 1;
      while (j < lines.length && lines[j].indexOf(fm[1]) !== 0) code.push(lines[j++]);
      i = j + 1;
      const lang = fm[2].toLowerCase();
      if (lang === 'chart' || lang === 'mermaid') {
        const pic = pictures.shift();
        if (pic && pic.png) { const buf = Buffer.from(String(pic.png).replace(/^data:image\/png;base64,/, ''), 'base64'); kids.push(picture(buf, pic.w || 640, pic.h || 360, 'png')); continue; }
        if (lang === 'chart' && CHARTS) {
          const r = CHARTS.parse(code.join('\n'));
          if (r.spec) {
            const s = r.spec;
            if (s.title) kids.push(new D.Paragraph({ keepNext: true, children: [new D.TextRun({ text: s.title, bold: true })] }));
            const rows = s.type === 'scatter' ? [['Series', 'x', 'y']].concat(...s.series.map((se) => se.values.map((v) => [se.name, v[0], v[1]])))
              : [[s.xLabel || ''].concat(s.series.map((se) => se.name + (s.unit ? ' (' + s.unit + ')' : '')))].concat(s.x.map((x, k) => [x].concat(s.series.map((se) => se.values[k] == null ? '' : se.values[k]))));
            kids.push(tableOf(rows, true));
            kids.push(new D.Paragraph({ children: [] }));   // Word joins tables that touch
            continue;
          }
        }
      }
      for (const c of (code.length ? code : [''])) kids.push(new D.Paragraph({ shading: { type: D.ShadingType.CLEAR, color: 'auto', fill: 'F4F4F4' }, spacing: { before: 0, after: 0 }, children: [new D.TextRun({ text: c || ' ', font: 'Consolas', size: 19 })] }));
      continue;
    }
    const pm = /^<!--\s*aiondx:pending\s*([\s\S]*?)\s*-->\s*$/.exec(l.trim());
    if (pm) { kids.push(new D.Paragraph({ children: [new D.TextRun({ text: '(Not written yet: ' + (pm[1] || 'this section') + ')', italics: true, color: '888888' })] })); i++; continue; }
    const hm = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
    if (hm) {
      const n = hm[1].length;
      const level = n === 1 ? D.HeadingLevel.TITLE : n === 2 ? D.HeadingLevel.HEADING_1 : n === 3 ? D.HeadingLevel.HEADING_2 : n === 4 ? D.HeadingLevel.HEADING_3 : D.HeadingLevel.HEADING_4;
      const pageBreakBefore = n === 2 && !firstH2;
      if (n === 2) firstH2 = false;
      kids.push(new D.Paragraph({ heading: level, pageBreakBefore, keepNext: true, children: runs(D, hm[2]) }));
      i++; continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l)) { kids.push(new D.Paragraph({ border: { bottom: { color: 'BBBBBB', space: 1, style: D.BorderStyle.SINGLE, size: 6 } }, children: [] })); i++; continue; }
    if (/^>\s?/.test(l)) {
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        const t = lines[i++].replace(/^>\s?/, '');
        kids.push(new D.Paragraph({ indent: { left: 567 }, border: { left: { color: 'BBBBBB', space: 8, style: D.BorderStyle.SINGLE, size: 12 } }, children: runs(D, t, { italics: true, color: '444444' }) }));
      }
      continue;
    }
    if (/^\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      const cells = (row) => row.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
      const rows = [cells(l)]; i += 2;
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      const w = Math.max(...rows.map((r) => r.length));
      kids.push(tableOf(rows.map((r) => { while (r.length < w) r.push(''); return r; }), true));
      kids.push(new D.Paragraph({ children: [] }));
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
      numbered++;
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i++]);
        const level = Math.min(4, Math.floor(m[1].replace(/\t/g, '    ').length / 2));
        const tm = /^\[([ xX])\]\s+(.*)$/.exec(m[3]);
        const text = tm ? tm[2] : m[3];
        const kidsRuns = (tm ? [new D.TextRun({ text: tm[1] === ' ' ? '☐ ' : '☒ ' })] : []).concat(runs(D, text, tm && tm[1] !== ' ' ? { strike: false } : {}));
        if (tm) kids.push(new D.Paragraph({ indent: { left: 360 + level * 360 }, children: kidsRuns }));
        else if (/\d/.test(m[2])) kids.push(new D.Paragraph({ numbering: { reference: 'dx-num', level, instance: numbered }, children: kidsRuns }));
        else kids.push(new D.Paragraph({ bullet: { level }, children: kidsRuns }));
      }
      continue;
    }
    // a paragraph; a picture alone on its line is embedded when it is a file in the project
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|~~~|>\s?|\s*([-*+]|\d+[.)])\s+|\|)/.test(lines[i]) && !/^<!--\s*aiondx:pending/.test(lines[i].trim())) para.push(lines[i++]);
    if (!para.length) { i++; continue; }
    const img = para.length === 1 && /^!\[([^\]]*)\]\(([^)\s]+)\)\s*$/.exec(para[0].trim());
    if (img && opts.docsDir && !/^[a-z][a-z0-9+.-]*:/i.test(img[2])) {
      try {
        const root = path.dirname(opts.docsDir), f = path.resolve(opts.docsDir, decodeURIComponent(img[2]));
        const rel = path.relative(root, f);
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel) && fs.statSync(f).size < 15 * 1048576) {
          const buf = fs.readFileSync(f), sz = imageSize(buf);
          if (sz) { kids.push(picture(buf, sz.w, sz.h, sz.type)); if (img[1]) kids.push(new D.Paragraph({ children: [new D.TextRun({ text: img[1], italics: true, color: '666666', size: 18 })] })); continue; }
        }
      } catch (e) { /* the alt text instead */ }
    }
    kids.push(new D.Paragraph({ spacing: { after: 120 }, children: [].concat(...para.map((p, k) => (k ? [new D.TextRun({ break: 1 })] : []).concat(runs(D, p.replace(/!\[([^\]]*)\]\([^)]*\)/g, '[$1]'))))) }));
  }
  const doc = new D.Document({
    creator: 'AionDX', title: opts.title || '', description: 'Exported from DX Docs',
    styles: { default: { document: { run: { font: 'Segoe UI', size: 22 } } } },
    numbering: { config: [{ reference: 'dx-num', levels: [0, 1, 2, 3, 4].map((lv) => ({ level: lv, format: D.LevelFormat.DECIMAL, text: '%' + (lv + 1) + '.', alignment: D.AlignmentType.START, style: { paragraph: { indent: { left: 720 + lv * 360, hanging: 360 } } } })) }] },
    sections: [{ children: kids.length ? kids : [new D.Paragraph({ children: [] })] }],
  });
  return D.Packer.toBuffer(doc);
}
module.exports = { toDocx, imageSize };
