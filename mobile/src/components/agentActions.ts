import { router } from 'expo-router';
import { ActionSheetIOS, Alert, Platform } from 'react-native';

import type { useAgentActions } from '@/lib/api/hooks';
import type { Agent } from '@/lib/api/types';
import { toast } from '@/state/toastStore';

import { toastConfirmUnavailable, type useSensitive } from './confirm';
import { pickOption } from './OptionSheet';
import { promptText } from './TextPromptModal';

type Actions = ReturnType<typeof useAgentActions>;
/** The active PC's confirmation state for sensitive actions (glyph, availability). */
export type Sensitive = Pick<ReturnType<typeof useSensitive>, 'available' | 'icon'>;

export function openThread(conversationId: string) {
  router.push({ pathname: '/chat/[conversationId]', params: { conversationId } });
}

/**
 * The bridge refuses a polite shutdown, a force remove and an interrupt-with-replacement for the
 * lead (`422 lead_not_allowed`, contract §6.6), so those controls are never offered for it.
 */
export const canShutDown = (agent: Agent) => agent.role !== 'lead' && agent.shutdown?.state !== 'requested';
export const canStopWithInstruction = (agent: Agent) => agent.role !== 'lead';
/** Force remove is the "it refused shutdown" path only (SPEC §14.1.5), or it never answered (rev 4.5 `expired`). */
export const canForceRemove = (agent: Agent) => agent.role !== 'lead' && (agent.shutdown?.state === 'rejected' || agent.shutdown?.state === 'expired');
/** Paused slots have no resume route and waking them isn't defined (SPEC §14.1.2). */
export const canStop = (agent: Agent) => agent.state !== 'paused';

/** A sensitive action while confirmations are unavailable: explain, with the way out (SPEC §15.1.5). */
function unavailable(_hostId: string | undefined) {
  toastConfirmUnavailable();
}

/** ConfirmSheet equivalent (SPEC §4.10): Cancel is the default, destructive action in red. */
export function confirmStop(agent: Agent, actions: Actions, onSendInstruction: () => void) {
  const withInstruction = canStopWithInstruction(agent);
  Alert.alert(
    `Stop ${agent.name}'s current turn?`,
    withInstruction ? 'It will stop mid-step. You can send it a new instruction.' : 'It will stop mid-step.',
    [
      { text: 'Cancel', style: 'cancel' },
      ...(withInstruction ? [{ text: 'Stop & send instruction…', onPress: onSendInstruction }] : []),
      { text: 'Stop', style: 'destructive', onPress: () => actions.stop.mutate({ slotId: agent.slotId }) },
    ],
    { cancelable: true },
  );
}

/** Shut down… opens the reason sheet (SPEC §14.1.5); the request is sensitive (§15.1.1). */
export async function confirmShutdown(agent: Agent, actions: Actions, sensitive: Sensitive, hostId?: string) {
  if (!sensitive.available) return unavailable(hostId);
  const reason = await promptText({
    title: `Shut down ${agent.name}?`,
    message: 'The agent is asked to finish and exit. It may decline.',
    placeholder: 'Reason (sent to the agent)',
    maxLength: 200,
    submitLabel: 'Ask to shut down',
    submitVariant: 'dangerOutline',
    submitIcon: sensitive.icon,
  });
  if (reason === null) return;
  actions.shutdown.mutate(
    { slotId: agent.slotId, name: agent.name, reason: reason.trim() || undefined },
    { onSuccess: () => toast(`Asked ${agent.name} to shut down`) },
  );
}

export function confirmForceRemove(agent: Agent, actions: Actions, sensitive: Sensitive, hostId?: string) {
  if (!sensitive.available) return unavailable(hostId);
  Alert.alert(
    `Force remove ${agent.name}?`,
    "This stops its process immediately. Work in progress in its current turn is lost. Its tasks stay on the board under 'Removed agent'.",
    [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Force remove',
        style: 'destructive',
        onPress: () => actions.forceRemove.mutate({ slotId: agent.slotId, name: agent.name }, { onSuccess: () => toast(`${agent.name} was removed`) }),
      },
    ],
  );
}

/** SPEC §15.1.1: the alert comes first, then the confirmation prompt. */
export function confirmClearContext(agent: Agent, actions: Actions, sensitive: Sensitive, hostId?: string) {
  if (!sensitive.available) return unavailable(hostId);
  Alert.alert(
    `Clear ${agent.name}'s context?`,
    'It starts a fresh session and forgets this conversation. Your chat history stays visible here, and unread messages are kept.',
    [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear context',
        style: 'destructive',
        onPress: () => actions.clearContext.mutate({ slotId: agent.slotId, name: agent.name }, { onSuccess: () => toast(`Cleared ${agent.name}'s context`) }),
      },
    ],
  );
}

/** Rename isn't sensitive (§15.1.1 "never confirmed"). */
export async function promptRename(agent: Agent, actions: Actions) {
  const name = await promptText({ title: `Rename ${agent.name}`, initialValue: agent.name, maxLength: 60, submitLabel: 'Rename', allowEmpty: false });
  const trimmed = name?.trim();
  if (trimmed && trimmed !== agent.name) actions.rename.mutate({ slotId: agent.slotId, name: trimmed });
}

/** "Stop & send instruction…": a text prompt, then stop with the replacement message. */
export async function promptInstruction(agent: Agent, actions: Actions) {
  const text = await promptText({ title: `New instruction for ${agent.name}`, placeholder: 'What should it do instead?', submitLabel: 'Stop & send', submitVariant: 'dangerOutline', allowEmpty: false });
  if (text?.trim()) actions.stop.mutate({ slotId: agent.slotId, message: text.trim() });
}

/**
 * Long-press quick actions on a SlotCard (SPEC §6.2, §14.1.2, §14.1.5). `controls: false` while
 * the team session isn't ready: agent controls are hidden then (§14.1.4).
 */
export function showQuickActions(agent: Agent, actions: Actions, sensitive: Sensitive, hostId?: string, controls = true) {
  const items = [
    { label: 'Message', run: () => openThread(agent.conversationId) },
    ...(controls && canStop(agent) ? [{ label: 'Stop turn', run: () => confirmStop(agent, actions, () => void promptInstruction(agent, actions)) }] : []),
    { label: 'View tasks', run: () => router.push('/tasks') },
    ...(controls && canShutDown(agent) ? [{ label: 'Shut down…', run: () => void confirmShutdown(agent, actions, sensitive, hostId), destructive: true }] : []),
    ...(controls && canForceRemove(agent) ? [{ label: 'Force remove…', run: () => confirmForceRemove(agent, actions, sensitive, hostId), destructive: true }] : []),
  ];
  if (Platform.OS === 'ios') {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: agent.name,
        options: [...items.map((i) => i.label), 'Cancel'],
        destructiveButtonIndex: items.flatMap((i, n) => ('destructive' in i && i.destructive ? [n] : [])),
        cancelButtonIndex: items.length,
      },
      (index) => items[index]?.run(),
    );
  } else {
    // Android Alert shows at most 3 buttons.
    void pickOption(
      agent.name,
      items.map((i) => ({ key: i.label, label: i.label, destructive: 'destructive' in i && i.destructive })),
    ).then((key) => items.find((i) => i.label === key)?.run());
  }
}
