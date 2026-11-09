import { allowPrompt, promptName } from '../confirmState';
import { rekeyProof } from '../crypto/confirm';
import { fromB64u } from '../encoding';
import type { AionDxApi } from './client';
import {
  approvalHeading,
  toActivityPage,
  toAgent,
  toAnswerResult,
  toApprovals,
  toAssistants,
  toBroadcast,
  toChanges,
  toConversation,
  toHostInfo,
  toMessageHistory,
  toMessageSync,
  toPage,
  toRunState,
  toSendResult,
  toTask,
  toTasks,
  toTeams,
  toWorkspaces,
} from './mappers';
import type { ApiRequest, Transport } from './transport';
import type { Approval, ApprovalAnswer } from './types';

/*
 * The bridge facade, contract rev 3.1 §6 (paths) and §10 (mapping from the old client).
 * Every response goes through a mapper; nothing here trusts the wire shape.
 */

const enc = encodeURIComponent;

function query(params: Record<string, string | number | undefined>): string {
  const parts = Object.entries(params)
    .filter((e): e is [string, string | number] => e[1] !== undefined && e[1] !== '')
    .map(([k, v]) => `${k}=${enc(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

/**
 * Allow answers are sensitive (§5.1, §6.5): an optionId whose kind is allow_* or other, a
 * decision other than deny, or answers. Refusals (deny, reject_*, decline) never are. An optionId
 * the approval doesn't list is treated as sensitive: an extra proof is harmless, a missing one isn't.
 */
export function isSensitiveAnswer(approval: Approval, answer: ApprovalAnswer): boolean {
  if ('decline' in answer) return false;
  if ('answers' in answer) return true;
  if ('decision' in answer) return answer.decision !== 'deny';
  const option = approval.options.find((o) => o.optionId === answer.optionId);
  return !option || !option.kind.startsWith('reject_');
}

export function createApi(transport: Transport): AionDxApi {
  const call = async <T>(req: ApiRequest, map: (v: unknown) => T): Promise<T> => map(await transport.request<unknown>(req));
  const get = <T>(path: string, map: (v: unknown) => T) => call({ method: 'GET', path }, map);
  const ignore = () => undefined;
  const team = (teamId: string) => `/v1/teams/${enc(teamId)}`;
  const agent = (teamId: string, slotId: string) => `${team(teamId)}/agents/${enc(slotId)}`;
  const conv = (conversationId: string) => `/v1/conversations/${enc(conversationId)}`;
  const one = <T>(map: (j: Record<string, unknown>) => T | null) => (v: unknown): T => {
    const mapped = map((v ?? {}) as Record<string, unknown>);
    if (mapped === null) throw new Error('Unexpected response from the PC');
    return mapped;
  };

  return {
    async getHost() {
      const info = await get('/v1/host', toHostInfo);
      // The transport needs `requireConfirm` to decide whether a sensitive action prompts (§5).
      transport.onHostInfo?.(info);
      return info;
    },

    async reissueConfirmKey(rekeySecret, deviceId, confirmMode) {
      if (!transport.sessionId) throw new Error('Re-issuing the confirm key needs a live session');
      const proof = rekeyProof(rekeySecret, await transport.sessionId(), deviceId);
      const res = await call({ method: 'POST', path: '/v1/host/device/confirm-key', body: { proof, confirmMode } }, (v) => v as { confirmKey?: unknown });
      if (typeof res.confirmKey !== 'string') throw new Error('Unexpected response from the PC');
      return { confirmKey: fromB64u(res.confirmKey) };
    },

    unpairDevice: () => call({ method: 'DELETE', path: '/v1/host/device' }, ignore),

    getChanges: (since, waitSec) => get(`/v1/changes${query({ since, wait: Math.max(0, Math.min(25, Math.round(waitSec))) })}`, toChanges),

    listTeams: () => get('/v1/teams', toTeams),
    getRunState: (teamId) => get(`${team(teamId)}/run-state`, toRunState),
    getAgent: (teamId, slotId) => get(agent(teamId, slotId), one(toAgent)),
    startTeamSession: (teamId) => call({ method: 'POST', path: `${team(teamId)}/session` }, toRunState),

    listSoloConversations: (cursor, limit) => get(`/v1/conversations${query({ kind: 'solo', cursor, limit })}`, (v) => toPage(v, toConversation)),
    getConversation: (conversationId) => get(conv(conversationId), one(toConversation)),
    createConversation: (input) => call({ method: 'POST', path: '/v1/conversations', body: input }, one(toConversation)),
    listWorkspaces: () => get('/v1/workspaces', toWorkspaces),
    syncMessages: (conversationId, since, limit) => get(`${conv(conversationId)}/messages${query({ since, limit })}`, toMessageSync),
    olderMessages: (conversationId, before, limit) => get(`${conv(conversationId)}/messages${query({ before, limit })}`, toMessageHistory),
    sendMessage: (conversationId, content, opts) =>
      call(
        {
          method: 'POST',
          path: `${conv(conversationId)}/messages`,
          body: opts?.priority && opts.priority !== 'normal' ? { content, priority: opts.priority } : { content },
          rid: opts?.rid,
        },
        toSendResult,
      ),
    markRead: (conversationId, upToMessageId) => call({ method: 'POST', path: `${conv(conversationId)}/read`, body: { upToMessageId } }, ignore),
    broadcast: (teamId, content, opts) => call({ method: 'POST', path: `${team(teamId)}/broadcast`, body: { content }, rid: opts?.rid }, one(toBroadcast)),
    listBroadcasts: (teamId, cursor, limit) => get(`${team(teamId)}/broadcasts${query({ cursor, limit })}`, (v) => toPage(v, toBroadcast)),

    listApprovals: (teamId) => get(`/v1/approvals${query({ teamId })}`, toApprovals),
    answerApproval: (approval, answer) =>
      call(
        {
          method: 'POST',
          path: `/v1/approvals/${enc(approval.approvalId)}/answer`,
          body: answer,
          confirm: isSensitiveAnswer(approval, answer)
            ? approval.kind === 'question'
              ? `Send answers to ${promptName(approval.agentName)}`
              : allowPrompt(
                  'optionId' in answer ? (approval.options.find((o) => o.optionId === answer.optionId) ?? null) : null,
                  approvalHeading(approval),
                  approval.agentName,
                )
            : undefined,
        },
        toAnswerResult,
      ),

    wakeAgent: (teamId, slotId, nudge) =>
      call({ method: 'POST', path: `${agent(teamId, slotId)}/wake`, body: nudge ? { nudge } : {} }, (v) => {
        const runtime = (v as { runtime?: unknown } | null)?.runtime;
        return { runtime: runtime === 'dormant' || runtime === 'pending' || runtime === 'failed' ? runtime : 'ready' };
      }),
    stopAgent: (teamId, slotId, replacementMessage) =>
      call({ method: 'POST', path: `${agent(teamId, slotId)}/stop`, body: replacementMessage ? { replacementMessage } : {} }, (v) => {
        const outcome = (v as { outcome?: unknown } | null)?.outcome;
        return { outcome: outcome === 'interrupted' || outcome === 'no_active_turn' ? outcome : 'cancelled' };
      }),
    shutdownAgent: (teamId, slotId, reason, prompt) =>
      call({ method: 'POST', path: `${agent(teamId, slotId)}/shutdown`, body: reason ? { reason } : {}, confirm: prompt ?? 'Ask this agent to shut down' }, ignore),
    forceRemoveAgent: (teamId, slotId, prompt) => call({ method: 'DELETE', path: agent(teamId, slotId), confirm: prompt ?? 'Force remove this agent' }, ignore),
    spawnAgent: (teamId, input, prompt) => call({ method: 'POST', path: `${team(teamId)}/agents`, body: input, confirm: prompt ?? 'Add an agent to the team' }, one(toAgent)),
    renameAgent: (teamId, slotId, name) => call({ method: 'PATCH', path: agent(teamId, slotId), body: { name } }, one(toAgent)),
    clearContext: (teamId, slotId, prompt) =>
      call({ method: 'POST', path: `${agent(teamId, slotId)}/clear-context`, confirm: prompt ?? "Clear this agent's context" }, (v) => ({
        preservedUnread: Number((v as { preservedUnread?: unknown } | null)?.preservedUnread) || 0,
      })),
    listAssistants: () => get('/v1/assistants', toAssistants),

    listTasks: (teamId, filter) => get(`${team(teamId)}/tasks${query({ status: filter?.status?.join(','), owner: filter?.owner })}`, toTasks),
    getTask: (teamId, taskId) => get(`${team(teamId)}/tasks/${enc(taskId)}`, one(toTask)),
    createTask: (teamId, input) => call({ method: 'POST', path: `${team(teamId)}/tasks`, body: input }, one(toTask)),
    updateTask: (teamId, taskId, patch, prompt) =>
      call(
        { method: 'PATCH', path: `${team(teamId)}/tasks/${enc(taskId)}`, body: patch, confirm: patch.status === 'deleted' ? (prompt ?? 'Delete this task') : undefined },
        one(toTask),
      ),

    getActivity: (teamId, q = {}) => get(`${team(teamId)}/activity${query({ ...q })}`, toActivityPage),
  };
}
