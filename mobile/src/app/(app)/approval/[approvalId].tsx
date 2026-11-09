import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/Avatar';
import { ConfirmNotice, useSensitive } from '@/components/confirm';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/primitives';
import { Text } from '@/components/ui/Text';
import { TextField } from '@/components/ui/TextField';
import { clearCancelNotices, ConfirmCancelledError, ConfirmKeyInvalidatedError, ConfirmUnavailableError, describeActionError, isApiError } from '@/lib/api/errors';
import { useAllApprovals, useAnswerApproval } from '@/lib/api/hooks';
import type { AnswerResult, Approval, ApprovalAnswer, ApprovalOption } from '@/lib/api/types';
import { approvalCommand, approvalTitle, formatAgo, formatArgs, optionLabel, orderedOptions } from '@/lib/format';
import { useIsOffline } from '@/state/healthStore';
import { toast } from '@/state/toastStore';
import { radius, space, touchTarget, useColors, withAlpha } from '@/theme';

const MAX_MESSAGE = 2000;
const COUNTER_FROM = 1800;

/** Selections, typed text and notes survive dismissing the sheet, per approval, for the session (SPEC §14.5). */
interface Draft {
  picks: Record<string, string[]>;
  other: Record<string, string>;
  otherOn: Record<string, boolean>;
  message: string;
  messageOpen: boolean;
}
const drafts = new Map<string, Draft>();
const emptyDraft = (): Draft => ({ picks: {}, other: {}, otherOn: {}, message: '', messageOpen: false });

const COMMAND_CHIP: Record<string, { label: string; text: 'stNeedsYouText' | 'primary' | 'stIdleText'; tint: 'stNeedsYou' | 'primary' | 'stIdle' }> = {
  execute: { label: 'Execute', text: 'stNeedsYouText', tint: 'stNeedsYou' },
  edit: { label: 'Edit', text: 'primary', tint: 'primary' },
  read: { label: 'Read', text: 'stIdleText', tint: 'stIdle' },
};

/**
 * Approval sheet (SPEC §14.4) and question sheet (§14.5): one button per option the agent offered,
 * answered by optionId. Allow-type answers confirm with Face ID / passcode (§15.1); deny never does.
 */
export default function ApprovalSheet() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { approvalId } = useLocalSearchParams<{ approvalId: string }>();
  const approvals = useAllApprovals();
  const answer = useAnswerApproval({ quiet: true });
  const offline = useIsOffline();
  const sensitive = useSensitive();
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraftState] = useState<Draft>(() => drafts.get(approvalId) ?? emptyDraft());
  const setDraft = (patch: Partial<Draft>) =>
    setDraftState((d) => {
      const next = { ...d, ...patch };
      drafts.set(approvalId, next);
      return next;
    });
  const [resolvedHere, setResolvedHere] = useState(false);
  const [handledOnPc, setHandledOnPc] = useState(false);
  // Errors show inside the sheet, above its footer: a toast would sit behind a web form sheet.
  const [error, setError] = useState<string | null>(null);
  // Re-confirm is offered with an error only when the confirm key is the problem.
  const [errorRekey, setErrorRekey] = useState(false);
  // The D4b hint is neutral and stays until a confirmation succeeds (§16 N2).
  const [hint, setHint] = useState(false);
  const [showFullInput, setShowFullInput] = useState(false);

  // Keep showing the approval after it leaves the list, to explain what happened.
  const live = approvals.data?.find((a) => a.approvalId === approvalId);
  const [snapshot, setSnapshot] = useState<Approval | undefined>(live);
  if (live && live !== snapshot) setSnapshot(live);

  const handledElsewhere = handledOnPc || (!!snapshot && !live && approvals.isFetched && !resolvedHere);
  useEffect(() => {
    if (!handledElsewhere) return;
    const t = setTimeout(() => (router.canGoBack() ? router.back() : router.replace('/')), 1500);
    return () => clearTimeout(t);
  }, [handledElsewhere]);

  const approval = live ?? snapshot;
  if (!approval) {
    return (
      <View style={[styles.sheet, { backgroundColor: c.surface }]}>
        <Text color="textMuted">{approvals.isPending ? 'Loading…' : 'This request is no longer pending.'}</Text>
        {!approvals.isPending ? <Button title="Close" variant="secondary" onPress={() => router.back()} /> : null}
      </View>
    );
  }

  const message = draft.message.trim();
  const send = async (key: string, body: ApprovalAnswer) => {
    setBusy(key);
    if (!hint) setError(null);
    setErrorRekey(false);
    setResolvedHere(true);
    try {
      const res = await answer.mutateAsync({ approval, answer: body });
      if (res.alreadyHandled) {
        setHandledOnPc(true);
        return;
      }
      drafts.delete(approvalId);
      clearCancelNotices();
      toastFor(res, approval, body, message);
      if (router.canGoBack()) router.back();
      else router.replace('/');
    } catch (err) {
      setResolvedHere(false);
      // Cancelling the OS prompt is a normal choice: the sheet stays exactly as it was (SPEC §15.1.3).
      // Cancelling the prompt keeps the sheet as it was; only repeated failures get a hint (§16 D4).
      if (err instanceof ConfirmCancelledError) {
        const note = describeActionError(err, '');
        if (note) {
          setHint(err.reason !== 'lockout');
          setError(note);
        }
        return;
      }
      setHint(false);
      if (isApiError(err, 'ambiguous_decision')) setError('The agent offers more than one matching option. Pick one below.');
      else if (err instanceof ConfirmKeyInvalidatedError || isApiError(err, 'confirm_invalid') || err instanceof ConfirmUnavailableError) {
        setErrorRekey(true);
        setError(
          err instanceof ConfirmKeyInvalidatedError
            ? err.message
            : err instanceof ConfirmUnavailableError
              ? err.message
              : "Your PC didn't accept this phone's confirmation. Re-confirm this phone to continue.",
        );
      } else setError(describeActionError(err, "Couldn't send your answer"));
    } finally {
      setBusy(null);
    }
  };

  const command = approvalCommand(approval);
  const noInput = approval.kind === 'permission' && approval.input === null;
  const input = approval.input && typeof approval.input === 'object' ? (approval.input as Record<string, unknown>) : null;
  const description = typeof input?.description === 'string' ? input.description : null;
  // "Show full input" only when the input has more than the summary and the reason (SPEC §14.4).
  const extraFields = input ? Object.keys(input).filter((k) => k !== 'description' && k !== 'command' && k !== 'file_path' && k !== 'url') : [];
  const chip = approval.commandType ? COMMAND_CHIP[approval.commandType] : undefined;
  const questions = approval.questions ?? [];

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: c.surface }}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.sheet} keyboardShouldPersistTaps="handled">
        <View style={styles.row}>
          <Avatar id={approval.slotId ?? approval.conversationId} name={approval.agentName} />
          <View style={{ flex: 1 }}>
            <Text variant="headline">
              {approval.kind === 'question'
                ? questions.length > 1
                  ? `${approval.agentName} has ${questions.length} questions`
                  : `${approval.agentName} asks`
                : `${approval.agentName} wants to run`}
            </Text>
            {approval.kind === 'permission' ? (
              <View style={styles.titleRow}>
                <Text variant="title">{approvalTitle(approval)}</Text>
                {chip ? (
                  <View style={[styles.chip, { backgroundColor: withAlpha(c[chip.tint], 0.12) }]}>
                    <Text variant="caption" color={chip.text} style={{ fontWeight: '600' }}>
                      {chip.label}
                    </Text>
                  </View>
                ) : null}
              </View>
            ) : null}
          </View>
          <Text variant="caption" color="textMuted">
            {formatAgo(approval.firstSeenAt)}
          </Text>
        </View>

        {/* Rev 4.4: a permission may carry questions as context; they're answered with the options below. */}
        {approval.kind === 'permission' && questions.length > 0 ? <PermissionQuestions questions={questions} /> : null}
        {approval.kind === 'question' ? (
          questions.map((q) => (
            <QuestionBlock
              key={q.question}
              question={q}
              freeText={approval.freeText}
              chosen={draft.picks[q.question] ?? []}
              otherOn={!!draft.otherOn[q.question]}
              otherText={draft.other[q.question] ?? ''}
              onPick={(label) => {
                const chosen = draft.picks[q.question] ?? [];
                const next = q.multiSelect ? (chosen.includes(label) ? chosen.filter((l) => l !== label) : [...chosen, label]) : [label];
                // Single-select: picking an option collapses Other (its text stays as a draft).
                setDraft({ picks: { ...draft.picks, [q.question]: next }, ...(q.multiSelect ? {} : { otherOn: { ...draft.otherOn, [q.question]: false } }) });
              }}
              onOther={() => {
                const on = !draft.otherOn[q.question];
                // Single-select: Other deselects the offered options.
                setDraft({ otherOn: { ...draft.otherOn, [q.question]: on }, ...(q.multiSelect || !on ? {} : { picks: { ...draft.picks, [q.question]: [] } }) });
              }}
              onOtherText={(t) => setDraft({ other: { ...draft.other, [q.question]: t.slice(0, MAX_MESSAGE) } })}
            />
          ))
        ) : noInput ? (
          <View style={[styles.code, { backgroundColor: c.surfaceAlt, padding: space.md, gap: space.xs }]}>
            <Text>🖥 Open AionDX on your PC to see the full command.</Text>
            <Text variant="caption" color="textMuted">
              {"This phone didn't receive the details, so it can't be allowed from here."}
            </Text>
          </View>
        ) : (
          // Wraps instead of scrolling sideways: the whole command must be visible before Allow (a
          // dangerous tail like "&& rm -rf …" must not hide off-screen). Very long input scrolls vertically.
          <ScrollView nestedScrollEnabled style={[styles.code, { backgroundColor: c.surfaceAlt }]} contentContainerStyle={{ padding: space.md }}>
            <Text variant="mono" selectable numberOfLines={approval.inputSummary ? undefined : 16}>
              {command ?? ''}
            </Text>
          </ScrollView>
        )}
        {description ? <Text variant="caption" color="textMuted">Why: “{description}”</Text> : null}
        {approval.inputSummary && extraFields.length > 0 ? (
          <Pressable onPress={() => setShowFullInput((s) => !s)} accessibilityRole="button" hitSlop={6}>
            <Text variant="caption" color="primary">
              {showFullInput ? 'Hide full input' : 'Show full input ›'}
            </Text>
          </Pressable>
        ) : null}
        {showFullInput ? (
          <View style={[styles.code, { backgroundColor: c.surfaceAlt, padding: space.md }]}>
            <Text variant="mono" selectable>
              {formatArgs(approval.input)}
            </Text>
          </View>
        ) : null}
      </ScrollView>

      {/* Actions pinned in the thumb zone; only the context above scrolls (SPEC §13.2). */}
      <View style={[styles.footer, { borderTopColor: c.border, paddingBottom: insets.bottom + space.md }]}>
        {handledElsewhere ? (
          <View style={styles.row}>
            <Icon name="checkmark-done" color="stWorking" />
            <Text variant="headline">{approval.kind === 'question' ? 'Answered on your PC' : 'Already handled on PC'}</Text>
          </View>
        ) : (
          <>
            <ConfirmNotice state={sensitive.state} error={error} rekey={errorRekey} tone={hint ? 'neutral' : 'error'} />
            {draft.messageOpen ? (
              <MessageField
                value={draft.message}
                onChange={(t) => setDraft({ message: t })}
                placeholder={approval.kind === 'question' ? 'Add a note for the agent' : `Tell ${approval.agentName} why, or what to do instead`}
                caption={`Sent to ${approval.agentName} with the refusal.`}
              />
            ) : null}
            {approval.kind === 'question' ? (
              <QuestionFooter approval={approval} draft={draft} message={message} busy={busy} offline={offline} sensitive={sensitive} onSend={send} onNote={() => setDraft({ messageOpen: true })} />
            ) : (
              <PermissionFooter
                approval={approval}
                message={message}
                busy={busy}
                offline={offline}
                sensitive={sensitive}
                onSend={send}
                onMessage={() => setDraft({ messageOpen: !draft.messageOpen })}
                messageOpen={draft.messageOpen}
              />
            )}
            {/* The notice above carries the only Re-confirm link in this sheet (§15.1.5, §16 #7). */}
          </>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

/**
 * Display-only questions on a permission approval (contract §6.5, rev 4.4): non-Claude agents ask
 * through the permission channel and are answered by picking one of the agent's options.
 */
function PermissionQuestions({ questions }: { questions: NonNullable<Approval['questions']> }) {
  const c = useColors();
  return (
    <View style={[styles.code, { backgroundColor: c.surfaceAlt, padding: space.md, gap: space.sm }]}>
      {questions.map((q) => (
        <View key={q.question} style={{ gap: 2 }}>
          {q.header ? (
            <Text variant="caption" color="textMuted" style={{ fontWeight: '600', textTransform: 'uppercase' }}>
              {q.header}
            </Text>
          ) : null}
          <Text style={{ fontWeight: '600' }}>{q.question}</Text>
          {q.options.map((o) => (
            <Text key={o.label} variant="caption" color="textMuted">
              • {o.label}
              {o.description ? ` — ${o.description}` : ''}
            </Text>
          ))}
        </View>
      ))}
      <Text variant="caption" color="textMuted">
        Answer by choosing one of the options below.
      </Text>
    </View>
  );
}

function MessageField({ value, onChange, placeholder, caption }: { value: string; onChange: (t: string) => void; placeholder: string; caption: string }) {
  const c = useColors();
  return (
    <View style={{ gap: space.xs }}>
      <TextField
        value={value}
        onChangeText={(t) => onChange(t.slice(0, MAX_MESSAGE))}
        placeholder={placeholder}
        placeholderTextColor={c.textMuted}
        multiline
        autoFocus
        style={[styles.input, { backgroundColor: c.surfaceAlt, color: c.text }]}
        accessibilityLabel="Reason, sent with the refusal"
      />
      <View style={styles.captionRow}>
        <Text variant="caption" color="textMuted" style={{ flex: 1 }}>
          {caption}
        </Text>
        {value.length >= COUNTER_FROM ? (
          <Text variant="caption" color={value.length >= MAX_MESSAGE ? 'danger' : 'textMuted'}>
            {value.length}/{MAX_MESSAGE}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

type Sensitive = ReturnType<typeof useSensitive>;

function PermissionFooter({
  approval,
  message,
  busy,
  offline,
  sensitive,
  onSend,
  onMessage,
  messageOpen,
}: {
  approval: Approval;
  message: string;
  busy: string | null;
  offline: boolean;
  sensitive: Sensitive;
  onSend: (key: string, body: ApprovalAnswer) => void;
  onMessage: () => void;
  messageOpen: boolean;
}) {
  const options = orderedOptions(approval);
  const firstAllowOnce = options.find((o) => o.kind === 'allow_once');
  const variant = (o: ApprovalOption) => (o.kind.startsWith('reject_') ? 'dangerOutline' : o === firstAllowOnce ? 'primary' : 'secondary');
  // A message is only valid on a refusal (contract §6.5), so allows are disabled while there is one.
  const refusal = (o: ApprovalOption) => o.kind.startsWith('reject_');
  return (
    // More than 4 options: the footer itself scrolls (max 55% of the sheet), SPEC §14.4.
    <ScrollView style={options.length > 4 ? styles.footerScroll : undefined} contentContainerStyle={{ gap: space.sm }} nestedScrollEnabled>
      {options.map((o) => {
        const sensitiveOption = !refusal(o);
        return (
          <View key={o.optionId} style={{ gap: space.xs }}>
            <Button
              title={refusal(o) && message ? `${optionLabel(o)} with message` : optionLabel(o)}
              numberOfLines={2}
              variant={variant(o)}
              icon={sensitiveOption ? sensitive.icon : undefined}
              accessibilityHint={sensitiveOption ? sensitive.accessibilityHint : undefined}
              loading={busy === o.optionId}
              disabled={!!busy || offline || (sensitiveOption && (!!message || !sensitive.available))}
              style={sensitiveOption ? sensitive.style : undefined}
              onPress={() => onSend(o.optionId, refusal(o) && message ? { optionId: o.optionId, message } : { optionId: o.optionId })}
            />
            {o.kind === 'allow_always' && o.rule ? (
              <Text variant="caption" color="textMuted" style={styles.center} selectable>
                Creates rule: {o.rule}
              </Text>
            ) : o.kind === 'allow_always' && o.alwaysScope === 'backend_defined' ? (
              <Text variant="caption" color="textMuted" style={styles.center}>
                Scope decided by {approval.agentName}
              </Text>
            ) : null}
          </View>
        );
      })}
      {options.length === 0 ? <Button title="Close" variant="secondary" onPress={() => router.back()} /> : null}
      {options.some(refusal) ? (
        <Pressable onPress={onMessage} accessibilityRole="button" style={styles.link}>
          <Text color="primary">{messageOpen ? 'Hide message' : 'Deny with message…'}</Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}

function QuestionBlock({
  question: q,
  freeText,
  chosen,
  otherOn,
  otherText,
  onPick,
  onOther,
  onOtherText,
}: {
  question: NonNullable<Approval['questions']>[number];
  freeText: boolean;
  chosen: string[];
  otherOn: boolean;
  otherText: string;
  onPick: (label: string) => void;
  onOther: () => void;
  onOtherText: (t: string) => void;
}) {
  const c = useColors();
  const glyph = (on: boolean) => (q.multiSelect ? (on ? 'checkbox' : 'square-outline') : on ? 'radio-button-on' : 'radio-button-off');
  return (
    <View style={styles.question} accessibilityRole={q.multiSelect ? undefined : 'radiogroup'} accessibilityLabel={`${q.question}${q.multiSelect ? ', choose any' : ''}`}>
      <View style={styles.captionRow}>
        {q.header ? (
          <Text variant="caption" color="textMuted" style={{ fontWeight: '600', textTransform: 'uppercase', flex: 1 }}>
            {q.header}
          </Text>
        ) : (
          <View style={{ flex: 1 }} />
        )}
        {q.multiSelect ? (
          <Text variant="caption" color="textMuted">
            (choose any)
          </Text>
        ) : null}
      </View>
      <Text variant="headline">{q.question}</Text>
      {q.options.map((o) => {
        const on = chosen.includes(o.label);
        return (
          <Pressable
            key={o.label}
            onPress={() => onPick(o.label)}
            accessibilityRole={q.multiSelect ? 'checkbox' : 'radio'}
            accessibilityState={{ checked: on }}
            style={[styles.option, on && { backgroundColor: withAlpha(c.primary, 0.12) }]}
          >
            <Icon name={glyph(on)} color="primary" />
            <View style={{ flex: 1 }}>
              <Text>{o.label}</Text>
              {o.description ? (
                <Text variant="caption" color="textMuted" numberOfLines={3}>
                  {o.description}
                </Text>
              ) : null}
            </View>
          </Pressable>
        );
      })}
      {/* "Other…" only when the agent accepts free text (Claude), SPEC §14.5. */}
      {freeText ? (
        <>
          <Pressable
            onPress={onOther}
            accessibilityRole={q.multiSelect ? 'checkbox' : 'radio'}
            accessibilityState={{ checked: otherOn }}
            style={[styles.option, otherOn && { backgroundColor: withAlpha(c.primary, 0.12) }]}
          >
            <Icon name={glyph(otherOn)} color="primary" />
            <Text style={{ flex: 1 }}>Other…</Text>
          </Pressable>
          {otherOn ? (
            <View style={{ gap: space.xs }}>
              <TextField
                value={otherText}
                onChangeText={onOtherText}
                placeholder="Your answer"
                placeholderTextColor={c.textMuted}
                multiline
                autoFocus
                style={[styles.input, styles.otherInput, { backgroundColor: c.surfaceAlt, color: c.text }]}
                accessibilityLabel={`Other answer to: ${q.question}`}
              />
              {otherText.length >= COUNTER_FROM ? (
                <Text variant="caption" color={otherText.length >= MAX_MESSAGE ? 'danger' : 'textMuted'} style={{ alignSelf: 'flex-end' }}>
                  {otherText.length}/{MAX_MESSAGE}
                </Text>
              ) : null}
            </View>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

function QuestionFooter({
  approval,
  draft,
  message,
  busy,
  offline,
  sensitive,
  onSend,
  onNote,
}: {
  approval: Approval;
  draft: Draft;
  message: string;
  busy: string | null;
  offline: boolean;
  sensitive: Sensitive;
  onSend: (key: string, body: ApprovalAnswer) => void;
  onNote: () => void;
}) {
  const questions = approval.questions ?? [];
  const answers = questions.map((q) => {
    const free = approval.freeText && draft.otherOn[q.question] ? (draft.other[q.question] ?? '').trim() : '';
    const chosen = draft.picks[q.question] ?? [];
    // Single-select: the Other text replaces the picked option; multi-select adds to them.
    const labels = q.multiSelect ? [...chosen, ...(free ? [free] : [])] : free ? [free] : chosen;
    return { question: q.question, labels };
  });
  // Every question needs an answer, and a selected Other needs text.
  const complete = answers.every((a) => a.labels.length > 0) && questions.every((q) => !draft.otherOn[q.question] || !!(draft.other[q.question] ?? '').trim());
  return (
    <>
      <Button
        title="Send answers"
        icon={sensitive.icon}
        accessibilityHint={sensitive.accessibilityHint}
        loading={busy === 'answers'}
        disabled={!!busy || offline || !complete || !sensitive.available}
        style={sensitive.style}
        onPress={() => onSend('answers', { answers })}
      />
      {/* Declining is never confirmed (SPEC §14.5). */}
      <Button
        title={message ? 'Decline with note' : 'Decline'}
        variant="secondary"
        loading={busy === 'decline'}
        disabled={!!busy || offline}
        onPress={() => onSend('decline', message ? { decline: true, message } : { decline: true })}
      />
      {!draft.messageOpen ? (
        <Pressable onPress={onNote} accessibilityRole="button" style={styles.link}>
          <Text color="primary">Add a note…</Text>
        </Pressable>
      ) : null}
    </>
  );
}

/** Toasts after answering (SPEC §14.4, §14.5): where a refusal's message went, or that the answer went. */
function toastFor(res: AnswerResult, approval: Approval, body: ApprovalAnswer, message: string) {
  const openChat = { label: 'Open chat', onPress: () => router.push({ pathname: '/chat/[conversationId]', params: { conversationId: approval.conversationId } }) };
  if ('answers' in body) return toast('Answer sent', 'success');
  if ('decline' in body && !message) return toast(`Declined — ${approval.agentName} will continue without an answer`);
  if (!message) return;
  const what = 'decline' in body ? 'note' : 'reason';
  if (res.messageDelivery === 'native') toast(`Denied. ${approval.agentName} got your reason.`, 'success');
  else if (res.messageDelivery === 'followup') toast(`${'decline' in body ? 'Declined' : 'Denied'}. Your ${what} was posted in the chat.`, 'success', openChat);
  else toast(`${'decline' in body ? 'Declined' : 'Denied'}, but your message wasn't delivered.`, 'error', openChat);
}

const styles = StyleSheet.create({
  sheet: { padding: space.xl, gap: space.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
  chip: { borderRadius: radius.chip, paddingHorizontal: space.sm, paddingVertical: 2 },
  code: { borderRadius: radius.card, maxHeight: 240, flexGrow: 0 },
  footer: { paddingHorizontal: space.xl, paddingTop: space.md, gap: space.sm, borderTopWidth: StyleSheet.hairlineWidth },
  footerScroll: { maxHeight: '55%' as unknown as number },
  center: { textAlign: 'center' },
  input: { minHeight: 96, borderRadius: radius.card, padding: space.md, fontSize: 15, textAlignVertical: 'top' },
  otherInput: { minHeight: 56, maxHeight: 130 },
  captionRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  link: { minHeight: touchTarget, justifyContent: 'center', alignItems: 'center' },
  question: { gap: space.sm, marginBottom: space.lg },
  option: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 48, borderRadius: radius.card, paddingHorizontal: space.sm },
});
