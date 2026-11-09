import Ionicons from '@expo/vector-icons/Ionicons';
import * as Clipboard from 'expo-clipboard';
import { Component, memo, type ReactNode, useMemo, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, type TextStyle, View } from 'react-native';

import { EdgeFade } from '@/components/ui/EdgeFade';
import { Text } from '@/components/ui/Text';
import { toast } from '@/state/toastStore';
import { type ColorToken, radius, space, type as typeScale, touchTarget, useColors, withAlpha } from '@/theme';

/*
 * Lightweight Markdown renderer for agent messages (SPEC §4.6). No dependency:
 * paragraphs, headings (#..###), bullet / numbered lists, blockquotes, rules,
 * **bold**, *italic*, `code`, fenced code blocks (copy button, horizontal scroll),
 * tables (monospace preformatted, horizontal scroll) and links.
 * Never throws: any parse/render failure falls back to the raw text.
 */

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

type Block =
  | { kind: 'paragraph'; text: string }
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'list'; items: { ordered: boolean; marker: string; depth: number; text: string }[] }
  | { kind: 'quote'; text: string }
  | { kind: 'code'; lang: string; code: string }
  | { kind: 'table'; text: string }
  | { kind: 'rule' };

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const LIST_ITEM = /^(\s*)([-*+•]|\d{1,9}[.)])\s+(.*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;

function isTableRow(line: string): boolean {
  return line.includes('|') && line.trim().length > 1;
}

export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: 'paragraph', text: para.join('\n') });
    para = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const marker = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(marker)) body.push(lines[i++]);
      i++; // closing fence (or EOF)
      blocks.push({ kind: 'code', lang: fence[2] ?? '', code: body.join('\n') });
      continue;
    }

    if (!line.trim()) {
      flush();
      i++;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: 'heading', level: Math.min(3, heading[1].length) as 1 | 2 | 3, text: heading[2] });
      i++;
      continue;
    }

    if (isTableRow(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      flush();
      const rows: string[] = [line];
      i += 2; // skip separator
      while (i < lines.length && isTableRow(lines[i])) rows.push(lines[i++]);
      blocks.push({ kind: 'table', text: formatTable(rows) });
      continue;
    }

    if (RULE.test(line)) {
      flush();
      blocks.push({ kind: 'rule' });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      flush();
      const body: string[] = [];
      let m: RegExpExecArray | null;
      while (i < lines.length && (m = QUOTE.exec(lines[i]))) {
        body.push(m[1]);
        i++;
      }
      blocks.push({ kind: 'quote', text: body.join('\n') });
      continue;
    }

    if (LIST_ITEM.test(line)) {
      flush();
      const items: Extract<Block, { kind: 'list' }>['items'] = [];
      while (i < lines.length) {
        const m = LIST_ITEM.exec(lines[i]);
        if (m) {
          const ordered = /\d/.test(m[2]);
          items.push({
            ordered,
            marker: ordered ? `${m[2].replace(')', '.')}` : '•',
            depth: Math.min(4, Math.floor(m[1].replace(/\t/g, '    ').length / 2)),
            text: m[3],
          });
          i++;
        } else if (lines[i].trim() && /^\s+/.test(lines[i]) && items.length) {
          // Indented continuation of the previous item.
          items[items.length - 1].text += `\n${lines[i].trim()}`;
          i++;
        } else break;
      }
      blocks.push({ kind: 'list', items });
      continue;
    }

    para.push(line);
    i++;
  }
  flush();
  return blocks;
}

function splitRow(row: string): string[] {
  let r = row.trim();
  if (r.startsWith('|')) r = r.slice(1);
  if (r.endsWith('|')) r = r.slice(0, -1);
  return r.split('|').map((c) => c.trim());
}

/** Pads cells into aligned monospace columns. */
function formatTable(rows: string[]): string {
  const cells = rows.map(splitRow);
  const cols = Math.max(...cells.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, c) => Math.max(3, ...cells.map((r) => (r[c] ?? '').length)));
  const fmt = (r: string[]) => widths.map((w, c) => (r[c] ?? '').padEnd(w)).join(' │ ').trimEnd();
  const [head, ...body] = cells;
  return [fmt(head), widths.map((w) => '─'.repeat(w)).join('─┼─'), ...body.map(fmt)].join('\n');
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------

type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'bold'; c: Inline[] }
  | { t: 'italic'; c: Inline[] }
  | { t: 'strike'; c: Inline[] }
  | { t: 'link'; c: Inline[]; url: string };

const LINK = /^\[([^\]\n]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/;
const AUTOLINK = /^https?:\/\/[^\s<>()]+/;
const isWordChar = (ch: string | undefined) => !!ch && /[A-Za-z0-9À-ɏЀ-ӿ]/.test(ch);

export function parseInline(s: string, depth = 0): Inline[] {
  if (depth > 4) return [{ t: 'text', v: s }];
  const out: Inline[] = [];
  let buf = '';
  const push = (node: Inline) => {
    if (buf) out.push({ t: 'text', v: buf });
    buf = '';
    out.push(node);
  };

  let i = 0;
  while (i < s.length) {
    const ch = s[i];

    if (ch === '\\' && i + 1 < s.length && /[\\`*_[\]()#~|>-]/.test(s[i + 1])) {
      buf += s[i + 1];
      i += 2;
      continue;
    }

    if (ch === '`') {
      let ticks = 1;
      while (s[i + ticks] === '`') ticks++;
      const marker = '`'.repeat(ticks);
      const end = s.indexOf(marker, i + ticks);
      if (end > i + ticks - 1) {
        push({ t: 'code', v: s.slice(i + ticks, end).replace(/^ (.*) $/, '$1') });
        i = end + ticks;
        continue;
      }
    }

    if ((ch === '*' || ch === '_') && s[i + 1] === ch) {
      const marker = ch + ch;
      let end = s.indexOf(marker, i + 2);
      // `**bold *italic***` — the closing pair is the last two of the run.
      while (end > 0 && s[end + 2] === ch) end++;
      if (end > i + 2 && !/\s/.test(s[i + 2]) && (ch === '*' || !isWordChar(s[i - 1]))) {
        push({ t: 'bold', c: parseInline(s.slice(i + 2, end), depth + 1) });
        i = end + 2;
        continue;
      }
    }

    if (ch === '~' && s[i + 1] === '~') {
      const end = s.indexOf('~~', i + 2);
      if (end > i + 2) {
        push({ t: 'strike', c: parseInline(s.slice(i + 2, end), depth + 1) });
        i = end + 2;
        continue;
      }
    }

    if ((ch === '*' || ch === '_') && s[i + 1] && !/\s/.test(s[i + 1]) && (ch === '*' || !isWordChar(s[i - 1]))) {
      let end = -1;
      for (let j = i + 1; j < s.length; j++) {
        if (s[j] === '\n') break;
        if (s[j] === ch && s[j + 1] !== ch && !/\s/.test(s[j - 1]) && (ch === '*' || !isWordChar(s[j + 1]))) {
          end = j;
          break;
        }
      }
      if (end > i + 1) {
        push({ t: 'italic', c: parseInline(s.slice(i + 1, end), depth + 1) });
        i = end + 1;
        continue;
      }
    }

    if (ch === '[') {
      const m = LINK.exec(s.slice(i));
      if (m) {
        push({ t: 'link', c: parseInline(m[1], depth + 1), url: m[2] });
        i += m[0].length;
        continue;
      }
    }

    if (ch === 'h' && !isWordChar(s[i - 1])) {
      const m = AUTOLINK.exec(s.slice(i));
      if (m) {
        const url = m[0].replace(/[.,;:!?'"]+$/, '');
        push({ t: 'link', c: [{ t: 'text', v: url }], url });
        i += url.length;
        continue;
      }
    }

    buf += ch;
    i++;
  }
  if (buf) out.push({ t: 'text', v: buf });
  return out;
}

/** Markdown → plain text for previews and screen-reader labels. */
export function markdownToPlain(src: string): string {
  try {
    return src
      .replace(/```[\w+#.-]*\n?/g, '')
      .replace(/^\s{0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/gm, '$1')
      .replace(/^\s*>\s?/gm, '')
      .replace(/\[([^\]\n]+)\]\([^)\n]+\)/g, '$1')
      .replace(/(\*\*|__|~~|`)/g, '')
      .replace(/(^|\s)([*_])(?=\S)([^*_\n]*?[^\s*_])\2(?=\s|$|[.,;:!?])/g, '$1$3')
      .replace(/^\s*[-*+]\s+/gm, '• ')
      .trim();
  } catch {
    return src;
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const SAFE_URL = /^(https?:|mailto:)/i;

function openUrl(url: string) {
  if (!SAFE_URL.test(url)) {
    toast(`Can't open link: ${url}`, 'error');
    return;
  }
  Linking.openURL(url).catch(() => toast("Couldn't open link", 'error'));
}

async function copy(text: string, what = 'Copied') {
  try {
    await Clipboard.setStringAsync(text);
    toast(what, 'success');
  } catch {
    toast("Couldn't copy", 'error');
  }
}

interface Palette {
  text: string;
  muted: string;
  link: string;
  codeBg: string;
  blockBg: string;
  /** Opaque colour for scroll fades; undefined when blockBg is translucent (own bubbles). */
  fadeBg?: string;
  border: string;
}

function renderInline(nodes: Inline[], p: Palette, keyPrefix = ''): ReactNode[] {
  return nodes.map((n, idx) => {
    const key = `${keyPrefix}${idx}`;
    switch (n.t) {
      case 'text':
        return n.v;
      case 'code':
        return (
          <Text key={key} style={[styles.inlineCode, { backgroundColor: p.codeBg, color: p.text }]}>
            {n.v}
          </Text>
        );
      case 'bold':
        return (
          <Text key={key} style={[styles.bold, { color: p.text }]}>
            {renderInline(n.c, p, `${key}.`)}
          </Text>
        );
      case 'italic':
        return (
          <Text key={key} style={[styles.italic, { color: p.text }]}>
            {renderInline(n.c, p, `${key}.`)}
          </Text>
        );
      case 'strike':
        return (
          <Text key={key} style={[styles.strike, { color: p.text }]}>
            {renderInline(n.c, p, `${key}.`)}
          </Text>
        );
      case 'link':
        return (
          <Text key={key} accessibilityRole="link" onPress={() => openUrl(n.url)} style={[styles.link, { color: p.link }]}>
            {renderInline(n.c, p, `${key}.`)}
          </Text>
        );
      default:
        return null;
    }
  });
}

function InlineText({ text, p, style }: { text: string; p: Palette; style?: TextStyle }) {
  return <Text style={[{ color: p.text }, style]}>{renderInline(parseInline(text), p)}</Text>;
}

function CodeBlock({ code, lang, p }: { code: string; lang: string; p: Palette }) {
  const [viewport, setViewport] = useState(0);
  const [content, setContent] = useState(0);
  const [offset, setOffset] = useState(0);
  // Fade only while there is more to the right, so a cut-off line reads as scrollable (SPEC §13.15).
  const moreRight = content - viewport - offset > 2;
  return (
    <View style={[styles.codeBlock, { backgroundColor: p.blockBg, borderColor: p.border }]}>
      <View style={styles.codeHeader}>
        <Text variant="caption" style={{ color: p.muted, flex: 1 }}>
          {lang || 'code'}
        </Text>
        <Pressable
          onPress={() => void copy(code, 'Code copied')}
          accessibilityRole="button"
          accessibilityLabel="Copy code"
          hitSlop={8}
          style={styles.copyButton}
        >
          <CopyIcon color={p.muted} />
        </Pressable>
      </View>
      <View>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator
          nestedScrollEnabled
          contentContainerStyle={styles.codeScroll}
          onLayout={(e) => setViewport(e.nativeEvent.layout.width)}
          onContentSizeChange={(w) => setContent(w)}
          onScroll={(e) => setOffset(e.nativeEvent.contentOffset.x)}
          scrollEventThrottle={32}
        >
          <Text variant="mono" style={{ color: p.text }}>
            {code}
          </Text>
        </ScrollView>
        {moreRight && p.fadeBg ? <EdgeFade edge="right" color={p.fadeBg} /> : null}
      </View>
    </View>
  );
}

function CopyIcon({ color }: { color: string }) {
  return (
    <View style={styles.copyInner}>
      <Text variant="caption" style={{ color }}>
        Copy
      </Text>
      <Ionicons name="copy-outline" size={16} color={color} />
    </View>
  );
}

export interface MarkdownProps {
  children: string;
  /** Text color token for body text (default `text`). */
  color?: ColorToken;
  /** Render for a `primary` background (own bubble): onPrimary text, underlined links. */
  inverse?: boolean;
}

function MarkdownImpl({ children, color, inverse }: MarkdownProps) {
  const c = useColors();
  const source = typeof children === 'string' ? children : String(children ?? '');
  const p: Palette = useMemo(() => {
    const text = c[color ?? (inverse ? 'onPrimary' : 'text')];
    return {
      text,
      muted: inverse ? c.onPrimary : c.textMuted,
      link: inverse ? c.onPrimary : c.primary,
      codeBg: withAlpha(text, 0.12),
      blockBg: inverse ? withAlpha(c.onPrimary, 0.12) : c.surfaceAlt,
      fadeBg: inverse ? undefined : c.surfaceAlt,
      border: inverse ? withAlpha(c.onPrimary, 0.25) : c.border,
    };
  }, [c, color, inverse]);

  const blocks = useMemo(() => {
    try {
      return parseBlocks(source);
    } catch {
      return null;
    }
  }, [source]);

  const fallback = <Text style={{ color: p.text }}>{source}</Text>;
  if (!blocks) return fallback;

  return (
    <RenderGuard key={source} fallback={fallback}>
      <View style={styles.root}>
        {blocks.map((b, idx) => {
          switch (b.kind) {
            case 'paragraph':
              return <InlineText key={idx} text={b.text} p={p} />;
            case 'heading':
              return (
                <InlineText
                  key={idx}
                  text={b.text}
                  p={p}
                  style={b.level === 1 ? (typeScale.title as TextStyle) : (typeScale.headline as TextStyle)}
                />
              );
            case 'list':
              return (
                <View key={idx} style={styles.list}>
                  {b.items.map((it, j) => (
                    <View key={j} style={[styles.listItem, { paddingLeft: it.depth * space.lg }]}>
                      <Text style={[styles.marker, { color: p.text }]}>{it.marker}</Text>
                      <InlineText text={it.text} p={p} style={styles.flex} />
                    </View>
                  ))}
                </View>
              );
            case 'quote':
              return (
                <View key={idx} style={[styles.quote, { borderLeftColor: p.border }]}>
                  <InlineText text={b.text} p={p} style={{ opacity: 0.85 }} />
                </View>
              );
            case 'code':
              return <CodeBlock key={idx} code={b.code} lang={b.lang} p={p} />;
            case 'table':
              return (
                <View key={idx} style={[styles.codeBlock, { backgroundColor: p.blockBg, borderColor: p.border }]}>
                  <ScrollView horizontal showsHorizontalScrollIndicator nestedScrollEnabled contentContainerStyle={styles.codeScroll}>
                    <Text variant="mono" style={{ color: p.text }}>
                      {b.text}
                    </Text>
                  </ScrollView>
                </View>
              );
            case 'rule':
              return <View key={idx} style={[styles.rule, { backgroundColor: p.border }]} />;
            default:
              return null;
          }
        })}
      </View>
    </RenderGuard>
  );
}

/** Falls back to plain text if rendering odd input ever throws. */
class RenderGuard extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export const Markdown = memo(MarkdownImpl);

const styles = StyleSheet.create({
  root: { gap: space.sm },
  flex: { flex: 1 },
  bold: { fontWeight: '700' },
  italic: { fontStyle: 'italic' },
  strike: { textDecorationLine: 'line-through' },
  link: { textDecorationLine: 'underline' },
  inlineCode: { fontFamily: typeScale.mono.fontFamily, fontSize: typeScale.mono.fontSize },
  list: { gap: 2 },
  listItem: { flexDirection: 'row', gap: space.sm },
  marker: { minWidth: 14 },
  quote: { borderLeftWidth: 3, paddingLeft: space.sm },
  codeBlock: { borderRadius: radius.card - 4, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  codeHeader: { flexDirection: 'row', alignItems: 'center', paddingLeft: space.md },
  copyButton: { minHeight: touchTarget, minWidth: touchTarget, paddingHorizontal: space.sm, justifyContent: 'center', alignItems: 'flex-end' },
  copyInner: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  codeScroll: { paddingHorizontal: space.md, paddingBottom: space.md },
  rule: { height: StyleSheet.hairlineWidth, marginVertical: space.xs },
});
