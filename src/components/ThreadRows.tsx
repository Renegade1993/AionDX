import { memo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/primitives';
import { Text } from '@/components/ui/Text';
import type { ThreadMessage } from '@/lib/api/hooks';
import type { Broadcast } from '@/lib/api/types';
import { formatClock, messageText, planEntries } from '@/lib/format';
import { radius, space, touchTarget, useColors, withAlpha } from '@/theme';

/*
 * Thread rows that aren't chat bubbles (SPEC §14.3): tool, thinking and plan rows (compact, aligned
 * with the agent bubbles' left edge), the context-cleared divider, app captions, the failed-send
 * row with Retry, the task-assignment card, the "New" divider and broadcast delivery marks.
 */

/** Indent past the avatar column, so compact rows line up with agent bubbles. */
const INDENT = 32 + space.sm;

function toolFailed(m: ThreadMessage) {
  const s = m.tool?.status?.toLowerCase();
  return s === 'error' || s === 'failed';
}

/** `🔧 Used Bash · npx expo install …`; tap to expand title, status and the full summary. */
export const ToolRow = memo(function ToolRow({ message: m }: { message: ThreadMessage }) {
  const c = useColors();
  const [open, setOpen] = useState(false);
  const name = m.tool?.title ?? m.tool?.name ?? 'a tool';
  const failed = toolFailed(m);
  const streaming = m.status === 'streaming';
  const verb = streaming ? `Using ${name}` : failed ? `${name} failed` : `Used ${name}`;
  return (
    <Pressable onPress={() => setOpen((o) => !o)} accessibilityRole="button" accessibilityState={{ expanded: open }} style={styles.compact}>
      <View style={styles.compactLine}>
        {streaming ? <ActivityIndicator size="small" color={c.textMuted} style={styles.spinner} /> : <Text variant="caption">{failed ? '⊗' : '🔧'}</Text>}
        <Text variant="caption" color={failed ? 'stErrorText' : 'textMuted'} numberOfLines={1} ellipsizeMode="middle" style={styles.flex}>
          {verb}
          {m.tool?.summary ? (
            <Text variant="caption" color={failed ? 'stErrorText' : 'textMuted'} style={styles.mono}>
              {` · ${m.tool.summary}`}
            </Text>
          ) : null}
        </Text>
      </View>
      {open ? (
        <View style={[styles.block, { backgroundColor: c.surfaceAlt }]}>
          <Text variant="caption" style={{ fontWeight: '600' }}>
            {name}
            {m.tool?.status ? ` · ${m.tool.status}` : ''}
          </Text>
          {m.tool?.summary ? (
            <Text variant="mono" numberOfLines={12} selectable>
              {m.tool.summary}
            </Text>
          ) : null}
        </View>
      ) : null}
    </Pressable>
  );
});

/** Four or more tool rows in a row collapse into `▸ Used N tools` (SPEC §14.3.3). */
export function ToolRunRow({ messages }: { messages: ThreadMessage[] }) {
  const [open, setOpen] = useState(false);
  if (open) return <>{messages.map((m) => <ToolRow key={m.messageId} message={m} />)}</>;
  return (
    <Pressable onPress={() => setOpen(true)} accessibilityRole="button" accessibilityLabel={`Used ${messages.length} tools. Show them`} style={styles.compact}>
      <Text variant="caption" color="textMuted">
        ▸ Used {messages.length} tools
      </Text>
    </Pressable>
  );
}

/** `💭 Thought · tap to show`, collapsed by default; not remembered between visits. */
export const ThinkingRow = memo(function ThinkingRow({ message: m }: { message: ThreadMessage }) {
  const c = useColors();
  const [open, setOpen] = useState(false);
  const streaming = m.status === 'streaming';
  return (
    <View style={styles.compact}>
      <Pressable onPress={() => setOpen((o) => !o)} accessibilityRole="button" accessibilityState={{ expanded: open }} hitSlop={6}>
        <Text variant="caption" color="textMuted">
          {streaming ? '💭 Thinking…' : open ? '💭 Thought' : '💭 Thought · tap to show'}
        </Text>
      </Pressable>
      {open && m.text ? (
        <View style={[styles.block, { backgroundColor: c.surfaceAlt }]}>
          <Text color="textMuted" style={{ fontStyle: 'italic' }} selectable>
            {m.text}
          </Text>
          <Pressable onPress={() => setOpen(false)} accessibilityRole="button" hitSlop={6}>
            <Text variant="caption" color="primary">
              Hide
            </Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
});

/** `📋 Plan updated · 3 of 5 done`; expands to a checklist when the entries can be read. */
export const PlanRow = memo(function PlanRow({ message: m }: { message: ThreadMessage }) {
  const [open, setOpen] = useState(false);
  const entries = planEntries(m.raw);
  const done = entries?.filter((e) => e.status === 'completed').length ?? 0;
  return (
    <View style={styles.compact}>
      <Pressable onPress={() => setOpen((o) => !o)} accessibilityRole="button" accessibilityState={{ expanded: open }} hitSlop={6}>
        <Text variant="caption" color="textMuted">
          {entries ? `📋 Plan updated · ${done} of ${entries.length} done  ${open ? '▾' : '▸'}` : '📋 Plan updated — open on your PC to view'}
        </Text>
      </Pressable>
      {open && entries
        ? entries.map((e, i) => (
            <Text key={i}>
              {e.status === 'completed' ? '☑' : e.status === 'in_progress' ? '◐' : '☐'} {e.content}
            </Text>
          ))
        : null}
    </View>
  );
});

/** Full-width `──── Context cleared · 14:02 ────` divider (SPEC §14.3.1). */
export function ContextDivider({ message: m }: { message: ThreadMessage }) {
  const c = useColors();
  return (
    <View style={styles.dividerWrap} accessibilityRole="header" accessibilityLabel={`Context cleared at ${formatClock(m.createdAt)}`}>
      <View style={styles.dividerRow}>
        <View style={[styles.line, { backgroundColor: c.border }]} />
        <Text variant="caption" color="textMuted">
          Context cleared · {formatClock(m.createdAt)}
        </Text>
        <View style={[styles.line, { backgroundColor: c.border }]} />
      </View>
      <Text variant="caption" color="textMuted" style={styles.center}>
        The agent doesn&apos;t remember messages above this line.
      </Text>
    </View>
  );
}

/** `──── New ────` above the first unread agent row (SPEC §14.3.1). */
export function NewDivider() {
  const c = useColors();
  return (
    <View style={styles.dividerRow} accessibilityRole="header" accessibilityLabel="New messages">
      <View style={[styles.line, { backgroundColor: c.primary }]} />
      <Text variant="caption" color="primary" style={{ fontWeight: '600' }}>
        New
      </Text>
      <View style={[styles.line, { backgroundColor: c.primary }]} />
    </View>
  );
}

/** AionCore tips and status rows: centered caption text, no card, at most 2 lines. */
export function AppCaption({ message: m }: { message: ThreadMessage }) {
  return (
    <Text variant="caption" color="textMuted" numberOfLines={2} style={[styles.center, styles.caption]}>
      {messageText(m)}
    </Text>
  );
}

/**
 * The user's send failed (`error.source: 'send_failed'`): a centered row with Retry, which re-sends
 * the message that failed (SPEC §14.3.2). Hidden Retry when there's nothing to re-send.
 */
export function FailedSendRow({ message: m, onRetry, retried }: { message: ThreadMessage; onRetry?: () => void; retried: boolean }) {
  const c = useColors();
  const [more, setMore] = useState(false);
  return (
    <View style={styles.failedWrap}>
      <View style={[styles.failedCard, { backgroundColor: c.surfaceAlt, borderColor: withAlpha(c.stError, 0.12 * 4) }]} accessibilityRole="alert">
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="caption" color="stErrorText" style={{ fontWeight: '600' }}>
            ⊗ Couldn&apos;t start a reply
          </Text>
          <Pressable onPress={() => setMore((x) => !x)} accessibilityRole="text">
            <Text variant="caption" numberOfLines={more ? undefined : 3}>
              {m.error?.message}
            </Text>
          </Pressable>
        </View>
        {retried ? (
          <Text variant="caption" color="textMuted">
            Retried
          </Text>
        ) : onRetry ? (
          <Button title="Retry" variant="outline" compact onPress={onRetry} />
        ) : null}
      </View>
    </View>
  );
}

/** `📋 Claude Code assigned you a task / subject / View task ›` (SPEC §14.3.1). */
export function TaskNoticeCard({ assigner, subject, time, onPress }: { assigner: string; subject: string; time: string; onPress?: () => void }) {
  return (
    <Pressable onPress={onPress} disabled={!onPress} accessibilityRole={onPress ? 'button' : undefined} accessibilityHint={onPress ? 'Opens the task' : undefined} style={styles.systemWrap}>
      <Card style={styles.systemCard}>
        <Text variant="caption" color="textMuted" style={styles.center}>
          📋 {assigner} assigned {assigner === 'You' ? 'a task' : 'you a task'}
        </Text>
        <Text style={[styles.center, { fontWeight: '600' }]}>{subject}</Text>
        <Text variant="caption" color="textMuted" style={styles.center}>
          {time}
          {onPress ? ' · View task ›' : ''}
        </Text>
      </Card>
    </Pressable>
  );
}

/**
 * `✓ Delivered to 5` / `Delivered to 4 · 1 queued` / `Delivered to 6 · ⊗ 1 failed` (SPEC §14.3.4).
 * `failed` is a separate segment so only it is red (§16 N3).
 */
export function broadcastSummary(b: Broadcast): { text: string; failed: string | null } {
  const failed = b.deliveries.filter((d) => d.delivery === 'failed').length;
  const queued = b.deliveries.filter((d) => d.delivery === 'queued' || d.delivery === 'queued_first').length;
  const delivered = b.deliveries.length - failed - queued;
  const parts = [`Delivered to ${delivered}`, ...(queued > 0 ? [`${queued} queued`] : [])];
  return { text: `${failed > 0 ? '' : '✓ '}${parts.join(' · ')}`, failed: failed > 0 ? `⊗ ${failed} failed` : null };
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  compact: { marginLeft: INDENT, minHeight: 32, justifyContent: 'center', paddingVertical: 4, paddingRight: space.xl, gap: space.xs },
  compactLine: { flexDirection: 'row', alignItems: 'center', gap: space.xs, minHeight: touchTarget - 20 },
  spinner: { transform: [{ scale: 0.6 }] },
  mono: { fontFamily: 'monospace' },
  block: { borderRadius: radius.card, padding: space.md, gap: space.xs },
  center: { textAlign: 'center' },
  caption: { marginVertical: space.xs, paddingHorizontal: space.xl },
  dividerWrap: { marginVertical: space.md, gap: 2 },
  dividerRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.md, marginVertical: space.sm },
  line: { flex: 1, height: StyleSheet.hairlineWidth },
  failedWrap: { alignItems: 'center', marginVertical: space.sm, paddingHorizontal: space.md },
  failedCard: { flexDirection: 'row', alignItems: 'center', gap: space.md, borderWidth: 1, borderRadius: radius.card, padding: space.md, alignSelf: 'stretch' },
  systemWrap: { alignItems: 'center', marginVertical: space.sm, paddingHorizontal: space.xl },
  systemCard: { alignItems: 'center', maxWidth: '100%' },
});
