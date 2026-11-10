#!/usr/bin/env node
/**
 * check-page-script.js - refuses a page script with a name declared twice as a function in one scope, or a name it reads that is
 * declared nowhere (a typo or a removed helper still called: a ReferenceError only when that line runs). Names declared and never read
 * are listed as warnings.
 *
 *   node tools\check-page-script.js [file ...]     default: patches\0001-renderer-dx\aiondx-ui.js
 *
 * Written 2026-11-10 after a second `function placeMenu` (the chat menus') silently replaced the Loop menu's own: JavaScript keeps the last
 * declaration, so the Loop menu stopped opening and nothing complained. The scope scan (acorn, from vendor\node_modules) was added the
 * same day; its first run found a Stop backstop and two helpers nothing called any more. Run by tools\build-release.ps1 before the app is
 * packed. Exit 1 with the names and lines when a check fails.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const files = process.argv.slice(2);
if (!files.length) files.push(path.join(__dirname, '..', 'patches', '0001-renderer-dx', 'aiondx-ui.js'));
let bad = 0;

// ---- 1. a function name declared twice in one scope (by indentation and the nearest opening line above)
for (const f of files) {
  const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
  const seen = new Map();
  lines.forEach((l, i) => {
    const m = /^(\s*)(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(l);
    if (!m) return;
    const indent = m[1].length;
    let scope = -1;
    for (let j = i - 1; j >= 0; j--) {
      const lj = lines[j];
      if (!lj.trim()) continue;
      const ind = lj.length - lj.trimStart().length;
      if (ind < indent && /\{\s*$/.test(lj)) { scope = j; break; }
    }
    const key = scope + ':' + m[2];
    if (seen.has(key)) { console.log(path.basename(f) + ': function ' + m[2] + ' is declared twice in one scope, at lines ' + (seen.get(key) + 1) + ' and ' + (i + 1)); bad++; }
    else seen.set(key, i);
  });
}

// ---- 2. names read but declared nowhere; names declared and never read (warnings)
let acorn = null;
try { acorn = require(path.join(__dirname, '..', 'vendor', 'node_modules', 'acorn')); } catch (e) { console.log('check-page-script: acorn not found in vendor\\node_modules, scope scan skipped'); }
const KNOWN = new Set(Object.getOwnPropertyNames(globalThis).concat(('window document location localStorage sessionStorage navigator Notification ' +
  'MutationObserver ResizeObserver IntersectionObserver getComputedStyle requestAnimationFrame cancelAnimationFrame HTMLElement Element Node NodeFilter ' +
  'Event CustomEvent KeyboardEvent MouseEvent InputEvent DOMParser XMLHttpRequest Image Audio FileReader alert confirm prompt history screen ' +
  'innerWidth innerHeight devicePixelRatio speechSynthesis SpeechSynthesisUtterance HTMLTextAreaElement HTMLInputElement getSelection Range CSS ' +
  'matchMedia performance indexedDB caches AudioContext MediaRecorder Blob File FormData Headers Request Response fetch WebSocket EventSource Worker ' +
  'top self parent frames open close focus blur scrollTo scrollBy isSecureContext crypto DataTransfer ClipboardItem PointerEvent FocusEvent ' +
  'WheelEvent TextEncoder TextDecoder arguments undefined').split(/\s+/)));

function scan(f) {
  const ast = acorn.parse(fs.readFileSync(f, 'utf8'), { ecmaVersion: 'latest', sourceType: 'script', locations: true, allowHashBang: true, allowReturnOutsideFunction: true });
  function Scope(parent, fn) { this.parent = parent; this.fn = fn; this.names = new Map(); }
  Scope.prototype.declare = function (n, node, kind) { if (!this.names.has(n)) this.names.set(n, { node, kind, reads: 0 }); };
  Scope.prototype.fnScope = function () { let s = this; while (!s.fn) s = s.parent; return s; };
  Scope.prototype.lookup = function (n) { for (let s = this; s; s = s.parent) if (s.names.has(n)) return s.names.get(n); return null; };
  const opens = new Map(), all = [], declIds = new Set();
  const ids = (p, out) => {
    if (!p) return out;
    if (p.type === 'Identifier') out.push(p);
    else if (p.type === 'ObjectPattern') p.properties.forEach(q => ids(q.type === 'RestElement' ? q.argument : q.value, out));
    else if (p.type === 'ArrayPattern') p.elements.forEach(e => ids(e, out));
    else if (p.type === 'RestElement') ids(p.argument, out);
    else if (p.type === 'AssignmentPattern') ids(p.left, out);
    return out;
  };
  const kids = (node, cb) => { for (const k of Object.keys(node)) { if (k === 'loc') continue; const v = node[k]; if (Array.isArray(v)) v.forEach(c => c && typeof c.type === 'string' && cb(c, k)); else if (v && typeof v.type === 'string') cb(v, k); } };
  (function declare(node, scope) {
    let inner = scope;
    const isFn = /Function/.test(node.type);
    if (node.type === 'Program' || isFn) {
      inner = new Scope(scope, true); all.push(inner); opens.set(node, inner);
      if (node.type === 'FunctionDeclaration' && node.id) scope.fnScope().declare(node.id.name, node.id, 'function');
      if (node.type === 'FunctionExpression' && node.id) inner.declare(node.id.name, node.id, 'own');
      if (isFn) node.params.forEach(p => ids(p, []).forEach(id => inner.declare(id.name, id, 'param')));
    } else if (/^(BlockStatement|ForStatement|ForInStatement|ForOfStatement|SwitchStatement|CatchClause)$/.test(node.type)) {
      inner = new Scope(scope, false); all.push(inner); opens.set(node, inner);
      if (node.type === 'CatchClause' && node.param) ids(node.param, []).forEach(id => inner.declare(id.name, id, 'param'));
    }
    if (node.type === 'VariableDeclaration') node.declarations.forEach(d => ids(d.id, []).forEach(id => (node.kind === 'var' ? scope.fnScope() : scope).declare(id.name, id, node.kind)));
    if (node.type === 'ClassDeclaration' && node.id) scope.declare(node.id.name, node.id, 'class');
    kids(node, (c, k) => { if (!(isFn && (k === 'params' || k === 'id'))) declare(c, inner); });
  })(ast, null);
  all.forEach(s => s.names.forEach(v => declIds.add(v.node)));
  const undeclared = new Map();
  (function refs(node, scope, parent, pkey) {
    const inner = opens.get(node) || scope;
    if (node.type === 'Identifier' && !declIds.has(node)) {
      const skip = (parent.type === 'MemberExpression' && pkey === 'property' && !parent.computed) ||
        (/^(Property|MethodDefinition|PropertyDefinition)$/.test(parent.type) && pkey === 'key' && !parent.computed) || /Label|Break|Continue/.test(parent.type);
      if (!skip) {
        const d = scope.lookup(node.name);
        const write = parent.type === 'AssignmentExpression' && pkey === 'left' && parent.operator === '=';
        if (d) { if (!write) d.reads++; }
        else if (!KNOWN.has(node.name)) { const u = undeclared.get(node.name) || []; u.push(node.loc.start.line); undeclared.set(node.name, u); }
      }
    }
    kids(node, (c, k) => refs(c, inner, node, k));
  })(ast, null, null, null);
  undeclared.forEach((ls, n) => { console.log(path.basename(f) + ': ' + n + ' is read but declared nowhere, at line ' + ls.slice(0, 6).join(', ')); bad++; });
  all.forEach(s => s.names.forEach((v, n) => {
    if (!v.reads && v.kind !== 'param' && v.kind !== 'own') console.log(path.basename(f) + ': warning: ' + v.kind + ' ' + n + ' (line ' + v.node.loc.start.line + ') is never read');
  }));
}
if (acorn) for (const f of files) scan(f);
if (!bad) console.log('check-page-script: no name declared twice, none read undeclared');
process.exit(bad ? 1 : 0);
