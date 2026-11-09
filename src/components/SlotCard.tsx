import { useEffect, useRef, useState } from 'react';
import { Animated, type AccessibilityActionEvent, Pressable, StyleSheet, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { StatusPill } from '@/components/StatusPill';
import { Button } from '@/components/ui/Button';
import { Card, Icon, type IconName } from '@/components/ui/primitives';
import { Text } from '@/components/ui/Text';
import type { Agent, Approval, SessionStatus, Task } from '@/lib/api/types';
import { agentReasonCopy, agentStatusKey, formatAgo, formatDuration, type ReasonCopy } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import { type ColorToken, slotStatusStyle, space, useColors, useReduceMotion, waitingReasonStyle, withAlpha } from '@/theme';

export interface SlotCardProps {
  agent: Agent;
  sessionStatus?: SessionStatus;
  approvals?: Approval[];
  tasks?: Task[];
  onPress: () => void;
  onLongPress?: () => void;
  onReasonAction?: (cta: NonNullable<ReasonCopy['cta']>) => void;
  /** Accessibility custom actions (Message, Stop turn). */
  actions?: { name: string; label: string; onActivate: () => void }[];
  disabled?: boolean;
  /**
   * A declined or unanswered (rev 4.5 `expired`) shutdown, unless dismissed with Keep running on
   * this phone (SPEC §14.1.5). onAskAgain: a new shutdown request, offered after no response.
   */
  rejection?: {
    onKeepRunning: () => void;
    onAskAgain?: () => void;
    onForceRemove?: () => void;
    forceIcon?: IconName;
    forceDisabled?: boolean;
  } | null;
}

/** Dashboard row (SPEC §4.3). Flashes briefly when status changes between polls. */
export function SlotCard({ agent, sessionStatus, approvals, tasks, onPress, onLongPress, onReasonAction, actions = [], disabled, rejection }: SlotCardProps) {
  const c = useColors();
  const now = useNow(15_000);
  const status = agentStatusKey(agent, sessionStatus);
  const style = slotStatusStyle[status];
  const reason = agentReasonCopy(agent, { approvals, tasks, sessionStatus, now });
  const task = agent.currentTask;
  // The bridge reports elapsedMs at fetch time; startedAt keeps it ticking between updates.
  const turn = agent.turn ? formatDuration(now - agent.turn.startedAt) : null;
  const isAlert = status === 'needs_you' || status === 'question' || status === 'error';
  const queued = agent.queue.foreground;

  const flash = useChangeFlash(status);

  const meta = [queued > 0 ? `✉ ${queued > 99 ? '99+' : queued} queued` : null, turn ? `⏱ ${turn} in turn` : null].filter(Boolean).join(' · ');

  const a11yLabel = [
    agent.name,
    style.label,
    reason?.text,
    task ? `task ${task.subject}` : null,
    `${queued} queued message${queued === 1 ? '' : 's'}`,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <Animated.View style={{ backgroundColor: flash.interpolate({ inputRange: [0, 1], outputRange: ['transparent', withAlpha(c[style.color], 0.18)] }), borderRadius: 12 }}>
      <Card accentColor={isAlert ? c[style.color] : undefined} style={styles.card}>
        <Pressable
          onPress={onPress}
          onLongPress={onLongPress}
          accessibilityRole="button"
          accessibilityLabel={a11yLabel}
          accessibilityHint="Double-tap for details. Actions available."
          accessibilityActions={actions.map((a) => ({ name: a.name, label: a.label }))}
          onAccessibilityAction={(e: AccessibilityActionEvent) => actions.find((a) => a.name === e.nativeEvent.actionName)?.onActivate()}
        >
          <View style={styles.card}>
            <View style={styles.header}>
              <Avatar id={agent.slotId} name={agent.name} lead={agent.role === 'lead'} />
              <Text variant="headline" style={styles.name}>
                {agent.name}
              </Text>
              <StatusPill status={status} />
            </View>
            <View style={styles.body}>
              {reason ? (
                <>
                  {reason.tone === 'waiting' ? (
                    // Not conveyed by color alone (§14.2, §16 #10).
                    <View style={styles.reasonRow}>
                      <Icon name="hourglass-outline" size={14} color={waitingReasonStyle.textColor} />
                      <Text color={waitingReasonStyle.textColor} style={{ flexShrink: 1 }}>
                        {reason.text}
                      </Text>
                    </View>
                  ) : (
                    <Text color={reasonColor(reason, style.textColor)}>{reason.text}</Text>
                  )}
                  {reason.detail ? (
                    <Text variant={reason.detailIsCode ? 'mono' : 'caption'} color="textMuted" numberOfLines={1}>
                      {reason.detail}
                    </Text>
                  ) : null}
                  {status === 'paused' && agent.blockedReason === 'runtime_failed' ? (
                    <Text color="stErrorText">Runtime failed — check AionDX on your PC</Text>
                  ) : null}
                  {status === 'paused' && task ? (
                    <Text color="textMuted" numberOfLines={1}>
                      {task.subject}
                    </Text>
                  ) : null}
                </>
              ) : (
                <Text color="textMuted" numberOfLines={1}>
                  {task?.subject ?? (agent.role === 'lead' ? 'Coordinating team' : 'No task')}
                </Text>
              )}
              {meta ? (
                <Text variant="caption" color="textMuted">
                  {meta}
                </Text>
              ) : null}
            </View>
          </View>
        </Pressable>
        {/* Outside the card's Pressable: nested buttons are invalid on web and ambiguous for screen readers. */}
        {reason?.cta && onReasonAction ? (
          <Button
            title={reason.cta.label}
            variant="secondary"
            compact
            disabled={disabled}
            style={styles.cta}
            onPress={() => onReasonAction(reason.cta!)}
          />
        ) : null}
        {rejection && hasShutdownOutcome(agent) ? (
          <RejectedBlock agent={agent} now={now} {...rejection} disabled={disabled} />
        ) : null}
      </Card>
    </Animated.View>
  );
}

function reasonColor(reason: ReasonCopy, statusText: ColorToken): ColorToken {
  switch (reason.tone) {
    case 'muted':
      return 'textMuted';
    case 'primary':
      return 'primary';
    case 'waiting':
      return 'stWaitingText';
    default:
      // Errors and lifecycle notes take the pill's text color; approvals/questions read as plain text.
      return statusText === 'stErrorText' || statusText === 'stTransitionText' ? statusText : 'text';
  }
}

/** A shutdown the agent declined, or never answered within 10 minutes (contract rev 4.5). */
export const hasShutdownOutcome = (agent: Agent) => agent.shutdown?.state === 'rejected' || agent.shutdown?.state === 'expired';

/**
 * "Declined to shut down" / "No response" inset (SPEC §14.1.5). Not attention: the user was the
 * one who asked.
 */
export function RejectedBlock({
  agent,
  now,
  onKeepRunning,
  onAskAgain,
  onForceRemove,
  forceIcon,
  forceDisabled,
  disabled,
  inset = true,
}: NonNullable<SlotCardProps['rejection']> & { agent: Agent; now: number; disabled?: boolean; inset?: boolean }) {
  const c = useColors();
  const [more, setMore] = useState(false);
  const shutdown = agent.shutdown;
  if (shutdown?.state !== 'rejected' && shutdown?.state !== 'expired') return null;
  const expired = shutdown.state === 'expired';
  const rejectReason = expired ? null : shutdown.rejectReason;
  return (
    <View
      accessibilityRole="summary"
      style={[styles.rejected, inset && styles.rejectedInset, { backgroundColor: c.surfaceAlt, borderLeftColor: c.stNeedsYou }]}
    >
      <Text variant="caption" color="stNeedsYouText" style={{ fontWeight: '600' }}>
        {expired ? 'No response to shutdown' : 'Declined to shut down'} · {formatAgo(expired ? shutdown.expiredAt : shutdown.respondedAt, now)}
      </Text>
      {expired ? <Text color="textMuted">{"It didn't answer within 10 minutes. It may be busy or stuck."}</Text> : null}
      {rejectReason ? (
        <Pressable onPress={() => setMore((m) => !m)} disabled={rejectReason.length < 120} accessibilityRole="text">
          <Text numberOfLines={more ? undefined : 3}>“{rejectReason}”</Text>
        </Pressable>
      ) : null}
      <View style={styles.rejectedActions}>
        <Button title="Keep running" variant="outline" compact onPress={onKeepRunning} />
        {expired && onAskAgain ? (
          <Button title="Ask again" variant="outline" compact icon={forceIcon} disabled={disabled || forceDisabled} onPress={onAskAgain} />
        ) : null}
        {onForceRemove ? (
          <Button title="Force remove…" variant="dangerOutline" compact icon={forceIcon} disabled={disabled || forceDisabled} onPress={onForceRemove} />
        ) : null}
      </View>
    </View>
  );
}

function useChangeFlash(value: string): Animated.Value {
  const reduce = useReduceMotion();
  const [anim] = useState(() => new Animated.Value(0));
  const prev = useRef(value);
  useEffect(() => {
    if (prev.current === value) return;
    prev.current = value;
    if (reduce) return;
    anim.setValue(1);
    Animated.timing(anim, { toValue: 0, duration: 1000, useNativeDriver: false }).start();
  }, [value, reduce, anim]);
  return anim;
}

const styles = StyleSheet.create({
  card: { gap: space.sm },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  name: { flex: 1, flexWrap: 'wrap' },
  body: { marginLeft: 36 + space.md, gap: 2 },
  cta: { alignSelf: 'flex-start', marginLeft: 36 + space.md },
  reasonRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  rejected: { borderLeftWidth: 4, borderRadius: 8, padding: space.md, gap: space.xs },
  rejectedInset: { marginLeft: 36 + space.md },
  rejectedActions: { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap', marginTop: space.xs },
});
