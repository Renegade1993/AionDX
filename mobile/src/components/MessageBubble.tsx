import { memo } from 'react';
import { type AccessibilityActionEvent, Pressable, StyleSheet, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { Markdown, markdownToPlain } from '@/components/Markdown';
import { Card, Icon } from '@/components/ui/primitives';
import { Text } from '@/components/ui/Text';
import type { ThreadMessage } from '@/lib/api/hooks';
import type { Message } from '@/lib/api/types';
import { formatClock, messageText, stripTaskRef, taskIdFromNotice } from '@/lib/format';
import { radius, space, touchTarget, useColors, useReduceMotion, withAlpha } from '@/theme';

const SHUTDOWN = /^\s*(shutdown_(?:request|approved|rejected))\b:?\s*([\s\S]*)$/;
const WIDE_CONTENT = /```|~~~|^\s*\|?\s*:?-{2,}:?\s*\|/m;
const SHUTDOWN_JSON = /"type"\s*:\s*"(shutdown_(?:request|approved|rejected))"/;

/**
 * Rows rendered as centered system cards instead of bubbles (SPEC §4.6, §14.3.1): system rows,
 * task-assignment notices, recognized shutdown mailbox texts, and failed sends.
 */
export function isSystemMessage(m: Pick<Message, 'role' | 'type' | 'text' | 'notice' | 'status' | 'error'>): boolean {
  if (m.role === 'system' || m.notice) return true;
  if (m.status === 'error' && m.error?.source === 'send_failed') return true;
  const t = (m.text ?? '').trimStart();
  return t.startsWith('📋 Task assigned') || SHUTDOWN.test(t) || (t.startsWith('{') && SHUTDOWN_JSON.test(t));
}

export function isTaskNotice(m: Pick<Message, 'text' | 'notice'>): boolean {
  return m.notice?.kind === 'task_assigned' || (m.text ?? '').trimStart().startsWith('📋 Task assigned');
}

/** The task a notice links to: the bridge's notice first, the text pattern as a fallback. */
export function noticeTaskId(m: Pick<Message, 'text' | 'notice'>): string | null {
  return m.notice?.kind === 'task_assigned' ? m.notice.taskId : taskIdFromNotice(m.text ?? '');
}

/** Tool, thinking, plan and status rows: compact lines rather than bubbles (SPEC §14.3.3). */
export function isCompactRow(m: Pick<Message, 'type' | 'status'>): boolean {
  return m.type === 'tool_call' || m.type === 'thinking' || m.type === 'plan' || m.type === 'agent_status' || (m.type === 'tips' && m.status !== 'error');
}

const SHUTDOWN_COPY: Record<string, string> = {
  shutdown_request: 'Shutdown requested',
  shutdown_approved: 'Shutdown approved',
  shutdown_rejected: 'Shutdown rejected',
};

/** Human copy for a system message. */
export function systemText(m: Pick<Message, 'type' | 'text' | 'notice' | 'error' | 'status' | 'tool'>): string {
  if (m.notice?.kind === 'context_reset') return 'Context cleared';
  if (m.status === 'error' && m.error?.source === 'send_failed') return `Couldn't start a reply: ${m.error.message}`;
  const content = messageText(m).trim();
  const match = SHUTDOWN.exec(content);
  if (match) return match[2] ? `${SHUTDOWN_COPY[match[1]]}: ${match[2].trim()}` : SHUTDOWN_COPY[match[1]];
  const json = content.startsWith('{') ? SHUTDOWN_JSON.exec(content) : null;
  if (json) return SHUTDOWN_COPY[json[1]];
  return markdownToPlain(stripTaskRef(content));
}

export interface MessageBubbleProps {
  message: ThreadMessage;
  /** Display name of the sender ("You" for own messages). */
  senderName: string;
  senderLead?: boolean;
  /** First message of a group (same sender within 2 min): shows avatar + name. */
  groupStart: boolean;
  /** Own message still waiting in the agent's queue (`Agent.queue.foregroundMessageIds`). */
  queued?: boolean;
  onRetry?: (m: ThreadMessage) => void;
  onLongPress?: (m: ThreadMessage) => void;
  /** Tap on a system card (e.g. task-assignment notice → Tasks). */
  onSystemPress?: (m: ThreadMessage) => void;
  /** Avatar color key: the agent's slotId (team chats) or the conversationId (solo); a teammate's slotId. */
  avatarId?: string;
  /** Teammate rows: the always-shown `Claude Code → Mobile Engineer` header (SPEC §14.3.1). */
  teammateHeader?: { from: string; to: string; onPressFrom?: () => void };
  /**
   * Own message whose mid-turn delivery failed (status error): `⊗ Not delivered · Retry`, the
   * same Retry as its send_failed row (SPEC §14.3.2). `retry` is unset until that row arrives.
   */
  failedDelivery?: { retry?: () => void; retried: boolean };
  /** Everyone thread: the delivery summary under your broadcast; tap opens per-agent detail. */
  broadcastMeta?: { text: string; failed: string | null; onPress: () => void };
}

function MessageBubbleImpl({
  message: m,
  senderName,
  senderLead,
  groupStart,
  queued,
  onRetry,
  onLongPress,
  onSystemPress,
  teammateHeader,
  failedDelivery,
  broadcastMeta,
  avatarId,
}: MessageBubbleProps) {
  const c = useColors();
  const reduceMotion = useReduceMotion();
  const time = formatClock(m.createdAt);

  if (isSystemMessage(m)) {
    const text = systemText(m);
    const task = isTaskNotice(m);
    const taskId = noticeTaskId(m);
    return (
      <Pressable
        onPress={onSystemPress ? () => onSystemPress(m) : undefined}
        onLongPress={onLongPress ? () => onLongPress(m) : undefined}
        accessibilityRole={onSystemPress ? 'button' : undefined}
        accessibilityLabel={`${senderName}: ${text}, ${time}`}
        accessibilityHint={task && onSystemPress ? (taskId ? 'Opens the task' : 'Opens tasks') : undefined}
        style={styles.systemWrap}
      >
        <Card style={styles.systemCard}>
          <Text variant="caption" color="textMuted" style={styles.center}>
            {text}
          </Text>
          <Text variant="caption" color="textMuted" style={[styles.center, styles.systemMeta]}>
            {senderName} · {time}
            {task && onSystemPress ? (taskId ? ' · View task ›' : ' · View tasks ›') : ''}
          </Text>
        </Card>
      </Pressable>
    );
  }

  const own = m.role === 'user';
  const sending = m.localState === 'sending';
  const failed = m.localState === 'failed';
  const content = messageText(m);
  const plain = markdownToPlain(content);
  const mark = own ? deliveryMark(m, !!queued) : null;
  const agentError = m.status === 'error' && m.error?.source === 'agent';
  const stateLabel = sending ? ', sending' : failed ? ', failed to send' : mark ? `, ${mark.label}` : '';
  const a11yLabel = `${agentError ? `${senderName} hit an error` : senderName}: ${plain}, ${time}${stateLabel}`;
  const onPress = failed && onRetry ? () => onRetry(m) : undefined;
  const handleA11yAction = (e: AccessibilityActionEvent) => {
    if (e.nativeEvent.actionName === 'activate') onPress?.();
    else if (e.nativeEvent.actionName === 'longpress') onLongPress?.(m);
  };
  const metaColor = own ? withAlpha(c.onPrimary, 0.8) : c.textMuted;
  // Code blocks / tables scroll horizontally, so their bubble takes the full available width.
  const wide = WIDE_CONTENT.test(content);

  const bubble = (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress ? () => onLongPress(m) : undefined}
      delayLongPress={350}
      accessible
      accessibilityRole={failed ? 'button' : undefined}
      accessibilityLabel={a11yLabel}
      accessibilityHint={failed ? 'Double-tap to retry' : 'Actions available'}
      accessibilityActions={[
        ...(failed ? [{ name: 'activate', label: 'Retry' }] : []),
        ...(onLongPress ? [{ name: 'longpress', label: 'Message actions' }] : []),
      ]}
      onAccessibilityAction={handleA11yAction}
      style={({ pressed }) => [
        styles.bubble,
        own
          ? { backgroundColor: c.primary, borderBottomRightRadius: groupStart ? radius.bubble : 6 }
          : m.role === 'teammate'
            ? { backgroundColor: c.surfaceAlt, borderColor: c.border, borderWidth: 1 }
            : { backgroundColor: c.surface, borderColor: c.border, borderWidth: StyleSheet.hairlineWidth },
        agentError && { borderLeftWidth: 2, borderLeftColor: c.stError },
        own && m.status === 'error' && { borderWidth: 1, borderColor: c.stError },
        wide && styles.wide,
        sending && styles.sending,
        pressed && onLongPress ? { opacity: sending ? 0.5 : 0.85 } : null,
      ]}
    >
      {agentError ? (
        <Text variant="caption" color="stErrorText" style={{ fontWeight: '600' }}>
          ⊗ {senderName} hit an error
        </Text>
      ) : null}
      {/* A streaming reply grows in place, ending in a caret (a static "…" with Reduce Motion). */}
      <Markdown inverse={own}>{`${content}${m.status === 'streaming' ? (reduceMotion ? '…' : ' ▍') : ''}`}</Markdown>
      <View style={styles.meta}>
        <Text variant="caption" style={{ color: metaColor, fontSize: 11, lineHeight: 14 }}>
          {m.status === 'streaming' ? 'Writing…' : time}
        </Text>
        {sending ? (
          <Icon name="time-outline" size={12} color="onPrimary" />
        ) : mark && !failed && m.status !== 'error' ? (
          <>
            <Icon name={mark.icon} size={12} color="onPrimary" />
            {mark.text ? (
              <Text variant="caption" style={{ color: metaColor, fontSize: 11, lineHeight: 14 }}>
                {mark.text}
              </Text>
            ) : null}
          </>
        ) : null}
      </View>
    </Pressable>
  );

  if (own) {
    return (
      <View style={[styles.ownRow, groupStart ? styles.groupGap : styles.tightGap]}>
        {bubble}
        {failed ? (
          <Pressable
            onPress={onPress}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            hitSlop={8}
            style={styles.failedRow}
          >
            <Icon name="alert-circle" size={16} color="danger" />
            <Text variant="caption" color="danger" style={{ fontWeight: '600' }}>
              Tap to retry
            </Text>
          </Pressable>
        ) : null}
        {m.status === 'error' && failedDelivery ? (
          <Pressable
            onPress={failedDelivery.retried ? undefined : failedDelivery.retry}
            disabled={failedDelivery.retried || !failedDelivery.retry}
            accessibilityRole={failedDelivery.retry && !failedDelivery.retried ? 'button' : undefined}
            hitSlop={8}
            style={styles.failedRow}
          >
            {failedDelivery.retried ? (
              <Text variant="caption" color="textMuted">
                Not delivered · retried
              </Text>
            ) : (
              <Text variant="caption" color="stErrorText" style={{ fontWeight: '600' }}>
                ⊗ Not delivered{failedDelivery.retry ? ' · Retry' : ''}
              </Text>
            )}
          </Pressable>
        ) : null}
        {broadcastMeta ? (
          <Pressable onPress={broadcastMeta.onPress} accessibilityRole="button" accessibilityHint="Shows who received it" hitSlop={8} style={styles.failedRow}>
            <Text variant="caption" color="textMuted">
              {broadcastMeta.text}
              {broadcastMeta.failed ? (
                <Text variant="caption" color="stErrorText">
                  {` · ${broadcastMeta.failed}`}
                </Text>
              ) : null}
            </Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  return (
    <View style={[styles.agentRow, groupStart ? styles.groupGap : styles.tightGap]}>
      <View style={styles.avatarCol}>
        {groupStart ? <Avatar id={avatarId ?? senderName} name={senderName} lead={senderLead} size={32} /> : null}
      </View>
      <View style={[styles.agentCol, wide && styles.flex]}>
        {teammateHeader ? (
          <Pressable onPress={teammateHeader.onPressFrom} disabled={!teammateHeader.onPressFrom} accessibilityRole={teammateHeader.onPressFrom ? 'link' : undefined} hitSlop={4}>
            <Text variant="caption" color="textMuted" style={styles.sender}>
              <Text variant="caption" color={teammateHeader.onPressFrom ? 'text' : 'textMuted'} style={{ fontWeight: '600' }}>
                {teammateHeader.from}
              </Text>
              {` → ${teammateHeader.to}`}
            </Text>
          </Pressable>
        ) : groupStart ? (
          <Text variant="caption" color="textMuted" style={styles.sender} accessibilityElementsHidden importantForAccessibility="no">
            {senderName}
          </Text>
        ) : null}
        {bubble}
      </View>
    </View>
  );
}

/**
 * Delivery mark on the user's own bubble (SPEC §14.3.2): a later state always wins, so a row
 * status from the server beats the send response's `delivery`.
 */
function deliveryMark(m: ThreadMessage, queued: boolean): { icon: 'checkmark' | 'time-outline' | 'ellipse-outline'; text?: string; label: string } {
  if (m.status === 'pending') return { icon: 'ellipse-outline', text: 'Delivered · not read yet', label: 'delivered, not read yet' };
  if (queued || m.delivery === 'queued' || m.delivery === 'queued_first') return { icon: 'time-outline', text: 'Queued', label: 'queued' };
  return { icon: 'checkmark', label: 'sent' };
}

export const MessageBubble = memo(MessageBubbleImpl);

const styles = StyleSheet.create({
  center: { textAlign: 'center' },
  systemWrap: { alignItems: 'center', marginVertical: space.sm, paddingHorizontal: space.xl },
  systemCard: { alignItems: 'center', maxWidth: '100%' },
  systemMeta: { fontSize: 11, lineHeight: 14 },
  groupGap: { marginTop: space.md },
  tightGap: { marginTop: 3 },
  ownRow: { alignItems: 'flex-end', paddingLeft: 48 },
  agentRow: { flexDirection: 'row', alignItems: 'flex-start', paddingRight: 32, gap: space.sm },
  avatarCol: { width: 32 },
  agentCol: { flexShrink: 1, alignItems: 'flex-start', gap: 2 },
  sender: { fontWeight: '600', marginLeft: space.xs },
  bubble: {
    borderRadius: radius.bubble,
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    paddingBottom: space.xs + 2,
    gap: space.xs,
    maxWidth: '100%',
    minHeight: touchTarget - 8,
  },
  sending: { opacity: 0.6 },
  wide: { alignSelf: 'stretch' },
  flex: { flex: 1 },
  meta: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-end', gap: 3 },
  compact: { minHeight: 32, justifyContent: 'center', paddingRight: space.xl },
  failedRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs, minHeight: touchTarget - 12, marginTop: 2 },
});
