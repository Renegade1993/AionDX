import { QueryClient } from '@tanstack/react-query';

import { createApi, isSensitiveAnswer } from '../api/api';
import { applyChanges, resetHost } from '../api/changeFeed';
import { ApiError, cancelNotice, ConfirmCancelledError, ConfirmUnavailableError, describeActionError } from '../api/errors';
import { keys, upsertMessages } from '../api/hooks';
import { approvalHeading, toAgent, toApproval, toChanges, toMessage, toMessageSync, toRunState, toTask } from '../api/mappers';
import { isUsableBaseUrl, joinUrl, postJson } from '../api/http';
import { createMockFacade, DEMO_REKEY_SECRET, type MockFacade } from '../api/mock/facade';
import { generateKeyPair } from '../crypto/primitives';
import { encodePairingUri, parsePairingUri } from '../crypto/protocol';
import { allowPrompt, canConfirm, confirmStateFor } from '../confirmState';
import { classifyScannedCode, encodeRekeyUri } from '../crypto/confirm';
import { createMockTransport } from '../api/mock/transport';
import type { Agent, Approval, Message, Task } from '../api/types';
import {
  agentReasonCopy,
  agentStatusKey,
  formatArgs,
  openBlockers,
  planEntries,
  optionLabel,
  orderedOptions,
  quickOptions,
  retryTargetFor,
  sortAgents,
  stripTaskRef,
  taskIdFromNotice,
  taskOwnerLabel,
  waitingOn,
} from '../format';
import { backoffInterval, connectionState } from '@/state/healthStore';

// The change feed and hooks modules import the connection store; these tests only use their pure parts.
jest.mock('@/state/connectionStore', () => ({ getApi: jest.fn(), useConnectionStore: jest.fn(), useActiveHost: jest.fn(), DEMO_HOST_ID: 'demo' }));
jest.mock('expo-router', () => ({ useIsFocused: () => true }));

const agent = (over: Partial<Agent> = {}): Agent => ({
  ...toAgent({ slotId: 's', name: 'Agent', conversationId: 'c-s' })!,
  ...over,
});

const task = (over: Partial<Task> & Pick<Task, 'taskId'>): Task => ({
  ...toTask({ taskId: over.taskId, teamId: 't', subject: over.taskId })!,
  ...over,
});

const approval = (over: Partial<Approval> = {}): Approval => ({
  ...toApproval({ approvalId: 'a1', kind: 'permission', conversationId: 'c-s', agentName: 'Agent', input: { command: 'ls' } })!,
  ...over,
});

const msg = (over: Partial<Message> & Pick<Message, 'messageId'>): Message => ({
  ...toMessage({ messageId: over.messageId, role: 'agent', sender: { kind: 'agent', name: 'A' }, type: 'text', status: 'done' })!,
  ...over,
});

// ---------------------------------------------------------------------------
// Display status (SPEC §14.1.1) and the reason line (§14.2)
// ---------------------------------------------------------------------------

describe('agent display status', () => {
  it('follows the §14.1.1 priority table', () => {
    expect(agentStatusKey(agent({ attention: 'needs_answer', state: 'running' }))).toBe('question');
    expect(agentStatusKey(agent({ attention: 'needs_approval', state: 'running' }))).toBe('needs_you');
    expect(agentStatusKey(agent({ attention: 'error' }))).toBe('error');
    expect(agentStatusKey(agent({ runtime: 'failed' }))).toBe('error');
    expect(agentStatusKey(agent({ shutdown: { state: 'approved', requestedAt: 1, respondedAt: 2 } }))).toBe('removing');
    expect(agentStatusKey(agent({ blockedReason: 'removing' }))).toBe('removing');
    expect(agentStatusKey(agent({ shutdown: { state: 'requested', requestedAt: 1, reason: null }, state: 'running' }))).toBe('shutting_down');
    expect(agentStatusKey(agent({ state: 'paused' }))).toBe('paused');
    expect(agentStatusKey(agent({ state: 'running' }))).toBe('working');
    expect(agentStatusKey(agent({ runtime: 'pending' }))).toBe('starting');
    expect(agentStatusKey(agent({ state: 'queued' }))).toBe('idle');
    // A rejected shutdown isn't a status: the real state shows.
    expect(agentStatusKey(agent({ state: 'running', shutdown: { state: 'rejected', requestedAt: 1, respondedAt: 2, rejectReason: 'no' } }))).toBe('working');
  });

  it('shows "Not running" while the team session is down, but still surfaces errors', () => {
    expect(agentStatusKey(agent({ state: 'idle' }), 'stopped')).toBe('not_running');
    expect(agentStatusKey(agent({ runtime: 'failed' }), 'failed')).toBe('error');
    expect(agentStatusKey(agent({ state: 'running' }), 'starting')).toBe('working');
  });

  it('sorts by section, lead first within a section, then roster order', () => {
    const sorted = sortAgents([
      agent({ slotId: 'b', state: 'running' }),
      agent({ slotId: 'a', state: 'running' }),
      agent({ slotId: 'l', state: 'running', role: 'lead' }),
      agent({ slotId: 'n', attention: 'needs_approval' }),
      agent({ slotId: 'i' }),
    ]);
    expect(sorted.map((x) => x.slotId)).toEqual(['n', 'l', 'b', 'a', 'i']);
  });

  it('reason line: approval command, question, your turn, waiting on a blocker', () => {
    const perm = approval({ title: 'Bash', inputSummary: 'npx expo install x' });
    expect(agentReasonCopy(agent({ attention: 'needs_approval' }), { approvals: [perm] })).toMatchObject({
      text: 'Waiting for approval: Bash',
      detail: 'npx expo install x',
      cta: { kind: 'review', approvalId: 'a1' },
    });
    const q = approval({ approvalId: 'q1', kind: 'question', questions: [{ question: 'Who?', header: null, multiSelect: false, options: [] }] });
    expect(agentReasonCopy(agent({ attention: 'needs_answer' }), { approvals: [q] })?.cta).toEqual({ label: 'Answer', kind: 'answer', approvalId: 'q1' });
    expect(agentReasonCopy(agent({ role: 'lead', attention: 'your_turn' }), {})?.cta?.kind).toBe('reply');

    const tasks = [task({ taskId: 'dep', subject: 'Build screens', status: 'in_progress' }), task({ taskId: 'mine', owner: 's', blockedBy: ['dep'] })];
    expect(agentReasonCopy(agent(), { tasks })).toMatchObject({ text: 'Waiting on "Build screens"', cta: { kind: 'task', taskId: 'dep' } });
  });
});

describe('waiting on a task (§14.2)', () => {
  const dep = task({ taskId: 'dep', subject: 'Dep', status: 'pending' });
  it('needs every open task to be blocked', () => {
    const blocked = task({ taskId: 'x', owner: 's', blockedBy: ['dep'], createdAt: 1 });
    const free = task({ taskId: 'y', owner: 's', createdAt: 2 });
    expect(waitingOn(agent(), [dep, blocked])?.blocker.taskId).toBe('dep');
    expect(waitingOn(agent(), [dep, blocked, free])).toBeNull();
  });
  it('ignores finished blockers, busy agents and agents shutting down', () => {
    const blocked = task({ taskId: 'x', owner: 's', blockedBy: ['dep'] });
    expect(waitingOn(agent(), [{ ...dep, status: 'completed' }, blocked])).toBeNull();
    expect(waitingOn(agent({ state: 'running' }), [dep, blocked])).toBeNull();
    expect(waitingOn(agent({ shutdown: { state: 'requested', requestedAt: 1, reason: null } }), [dep, blocked])).toBeNull();
  });
});

describe('tasks', () => {
  it('only counts unfinished blockers', () => {
    const tasks = [task({ taskId: '1', status: 'completed' }), task({ taskId: '2', status: 'in_progress' }), task({ taskId: '3', blockedBy: ['1', '2', 'missing'] })];
    expect(openBlockers(tasks[2], tasks).map((t) => t.taskId)).toEqual(['2']);
  });

  it('labels owners: You, Unassigned, Removed agent (§14.6)', () => {
    expect(taskOwnerLabel({ owner: 'user', ownerName: 'You' })).toBe('You');
    expect(taskOwnerLabel({ owner: null, ownerName: null })).toBe('Unassigned');
    expect(taskOwnerLabel({ owner: 'gone', ownerName: null })).toBe('Removed agent');
    expect(taskOwnerLabel({ owner: 'qa', ownerName: 'QA Engineer' })).toBe('QA Engineer');
  });

  it('formats approval args', () => {
    expect(formatArgs({ command: 'ls -la' })).toBe('ls -la');
    expect(formatArgs({ file_path: 'a.ts' })).toBe('a.ts');
    expect(formatArgs({ a: 1, b: 2 })).toContain('"a": 1');
  });
});

// ---------------------------------------------------------------------------
// Approvals (contract §6.5, SPEC §14.4, sign-off #9)
// ---------------------------------------------------------------------------

describe('approval options', () => {
  const options: Approval['options'] = [
    { optionId: 'rj', label: 'Reject', kind: 'reject_once', rule: null },
    { optionId: 'o', label: 'Other', kind: 'other', rule: null },
    { optionId: 'aa', label: 'Always allow', kind: 'allow_always', rule: null, alwaysScope: 'same_as_once' },
    { optionId: 'a', label: 'Allow once', kind: 'allow_once', rule: null },
    { optionId: 'rja', label: 'Reject always', kind: 'reject_always', rule: null },
  ];

  it('orders allow, then other, then reject, keeping the agent order within groups', () => {
    expect(orderedOptions(approval({ options })).map((o) => o.optionId)).toEqual(['aa', 'a', 'o', 'rj', 'rja']);
  });

  it('offers only refusals when the input is unknown', () => {
    expect(orderedOptions(approval({ options, input: null })).map((o) => o.optionId)).toEqual(['rj', 'rja']);
  });

  it('relabels Claude "always" (same_as_once) rather than hiding it', () => {
    expect(optionLabel(options[2])).toBe('Allow (this agent will ask again)');
    expect(optionLabel({ ...options[2], alwaysScope: 'backend_defined' })).toBe('Always allow');
  });

  it('inline quick actions only when unambiguous', () => {
    expect(quickOptions(approval({ options }))?.allow.optionId).toBe('a');
    expect(quickOptions(approval({ options: [...options, { optionId: 'a2', label: 'Allow', kind: 'allow_once', rule: null }] }))).toBeNull();
    expect(quickOptions(approval({ options, input: null }))).toBeNull();
  });

  it('marks only allowing answers as sensitive (§5.1)', () => {
    const a = approval({ options });
    expect(isSensitiveAnswer(a, { optionId: 'a' })).toBe(true);
    expect(isSensitiveAnswer(a, { optionId: 'o' })).toBe(true);
    expect(isSensitiveAnswer(a, { optionId: 'rj', message: 'no' })).toBe(false);
    expect(isSensitiveAnswer(a, { optionId: 'unknown' })).toBe(true);
    expect(isSensitiveAnswer(a, { decision: 'deny' })).toBe(false);
    expect(isSensitiveAnswer(a, { decision: 'allow_always' })).toBe(true);
    expect(isSensitiveAnswer(a, { answers: [] })).toBe(true);
    expect(isSensitiveAnswer(a, { decline: true })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

describe('messages', () => {
  it('hides the task id in the visible notice text', () => {
    expect(stripTaskRef('📋 Task assigned to you (#01a1b3ff-8bea-7780-828a-4d155d10b93d): Design')).toBe('📋 Task assigned to you: Design');
  });

  it('extracts the task id from an assignment notice', () => {
    expect(taskIdFromNotice('📋 Task assigned to you (#01a1b3ff-8bea-7780-828a-4d155d10b93d): Design…')).toBe('01a1b3ff-8bea-7780-828a-4d155d10b93d');
    expect(taskIdFromNotice('📋 Task assigned to you: Design…')).toBeNull();
    expect(taskIdFromNotice('see (#t-3)')).toBeNull();
  });

  it('upserts by messageId, so a streaming reply grows in place', () => {
    const first = upsertMessages([], [msg({ messageId: 'r', text: 'Hel', status: 'streaming', createdAt: 2 }), msg({ messageId: 'u', role: 'user', createdAt: 1 })]);
    const next = upsertMessages(first, [msg({ messageId: 'r', text: 'Hello', status: 'done', createdAt: 2 })]);
    expect(next.map((m) => [m.messageId, m.text])).toEqual([
      ['u', undefined],
      ['r', 'Hello'],
    ]);
  });

  it('Retry re-sends error.messageId, else the nearest earlier user message (rev 3.1)', () => {
    const u1 = msg({ messageId: 'u1', role: 'user' });
    const u2 = msg({ messageId: 'u2', role: 'user' });
    const failed = (messageId: string | null) =>
      msg({ messageId: 'f', role: 'system', type: 'tips', status: 'error', error: { source: 'send_failed', code: null, message: 'x', messageId } });
    expect(retryTargetFor(failed('u1'), [u1, u2, failed('u1')])?.messageId).toBe('u1');
    expect(retryTargetFor(failed(null), [u1, u2, failed(null)])?.messageId).toBe('u2');
    expect(retryTargetFor(failed(null), [failed(null)])).toBeNull();
    expect(retryTargetFor(msg({ messageId: 'a', status: 'error', error: { source: 'agent', code: null, message: 'x' } }), [u1])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Mappers: a newer bridge must never crash an older phone
// ---------------------------------------------------------------------------

describe('mappers', () => {
  it('falls back on unknown enum values and drops rows without ids', () => {
    const run = toRunState({ teamId: 't', sessionStatus: 'exploded', agents: [{ slotId: 'x', state: 'teleporting', attention: 'urgent' }, { name: 'no id' }] });
    expect(run.sessionStatus).toBe('ready');
    expect(run.agents).toHaveLength(1);
    expect(run.agents[0]).toMatchObject({ state: 'idle', attention: 'none', queue: { foreground: 0 } });
  });

  it('puts the lead first', () => {
    const run = toRunState({ agents: [{ slotId: 'a' }, { slotId: 'l', role: 'lead' }, { slotId: 'b' }] });
    expect(run.agents.map((a) => a.slotId)).toEqual(['l', 'a', 'b']);
  });

  it('reads `before` on latest-page and reset responses (rev 4.1)', () => {
    expect(toMessageSync({ items: [], cursor: 'c1', reset: false, hasMore: false, before: 'b5' }).before).toBe('b5');
    expect(toMessageSync({ items: [], cursor: 'c1', reset: true, hasMore: false, before: null }).before).toBeNull();
    expect(toMessageSync({ items: [], cursor: 'c2', reset: false, hasMore: false }).before).toBeUndefined();
  });

  it('keeps the send_failed link and the task notice', () => {
    const m = toMessage({
      messageId: 'm',
      role: 'system',
      sender: { kind: 'app' },
      type: 'tips',
      status: 'error',
      error: { source: 'send_failed', code: 'cli_missing', message: 'Claude CLI not found', messageId: 'u1' },
    });
    expect(m?.error).toEqual({ source: 'send_failed', code: 'cli_missing', message: 'Claude CLI not found', messageId: 'u1' });
    expect(toMessage({ messageId: 'n', notice: { kind: 'task_assigned', taskId: 't1' } })?.notice).toEqual({ kind: 'task_assigned', taskId: 't1' });
  });

  it('skips change kinds it does not know', () => {
    const res = toChanges({ token: 'e.2', changes: [{ kind: 'hologram', id: 1 }, { kind: 'team', teamId: 't', what: ['run_state', 'vibes'] }] });
    expect(res.changes).toEqual([{ kind: 'team', teamId: 't', what: ['run_state'] }]);
  });
});

describe('errors', () => {
  it('turns facade errors into plain copy, and says nothing for a cancelled prompt', () => {
    expect(describeActionError(new ApiError(422, 'lead_not_allowed', ''), 'x')).toMatch(/team lead/);
    expect(describeActionError(new ApiError(503, 'team_session_failed', '', { error: 'Claude CLI not found' }), 'x')).toBe("The team couldn't start: Claude CLI not found");
    expect(describeActionError(new ConfirmUnavailableError('no_passcode'), 'x')).toMatch(/no screen lock/);
  });
});

// ---------------------------------------------------------------------------
// Connection health
// ---------------------------------------------------------------------------

describe('connection health', () => {
  const now = 1_000_000;
  it('escalates reconnecting → unreachable, and revoked wins', () => {
    expect(connectionState({ consecutiveFailures: 0, lastSuccessAt: now, lastFailure: null }, now)).toBe('ok');
    expect(connectionState({ consecutiveFailures: 2, lastSuccessAt: now - 5000, lastFailure: 'unreachable' }, now)).toBe('reconnecting');
    expect(connectionState({ consecutiveFailures: 4, lastSuccessAt: now - 5000, lastFailure: 'unreachable' }, now)).toBe('unreachable');
    expect(connectionState({ consecutiveFailures: 1, lastSuccessAt: now - 120_000, lastFailure: 'unreachable' }, now)).toBe('unreachable');
    expect(connectionState({ consecutiveFailures: 1, lastSuccessAt: now, lastFailure: 'revoked' }, now)).toBe('revoked');
  });

  it('backs off 3 → 6 → 12 → 30 s', () => {
    expect([0, 1, 2, 3, 4, 9].map((f) => backoffInterval(3000, f))).toEqual([3000, 3000, 6000, 12000, 30000, 30000]);
    expect(backoffInterval(10000, 1)).toBe(10000);
  });

  it('counts a burst of concurrent failures as one failed poll', () => {
    const { useHealthStore } = jest.requireActual('@/state/healthStore');
    jest.useFakeTimers();
    useHealthStore.getState().reset();
    for (let i = 0; i < 5; i++) useHealthStore.getState().recordFailure(new Error('net'));
    expect(useHealthStore.getState().consecutiveFailures).toBe(1);
    jest.advanceTimersByTime(3000);
    useHealthStore.getState().recordFailure(new Error('net'));
    expect(useHealthStore.getState().consecutiveFailures).toBe(2);
    useHealthStore.getState().recordSuccess();
    expect(useHealthStore.getState().consecutiveFailures).toBe(0);
    jest.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Change feed → query cache (contract §6.2)
// ---------------------------------------------------------------------------

describe('change feed application', () => {
  const H = 'host-1';
  // gcTime Infinity: no garbage-collection timers left running after the suite.
  const newClient = () => new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  it('patches approvals and tasks inline, invalidates only what was named', () => {
    const qc = newClient();
    qc.setQueryData(keys.approvals(H), [approval({ approvalId: 'old', firstSeenAt: 1 })]);
    qc.setQueryData(keys.tasks(H, 't'), [task({ taskId: 'x', updatedAt: 1 })]);
    qc.setQueryData(keys.runState(H, 't'), { teamId: 't' });
    qc.setQueryData(keys.runState(H, 'other'), { teamId: 'other' });
    applyChanges(qc, H, [
      { kind: 'approval_added', approval: approval({ approvalId: 'new', firstSeenAt: 2 }) },
      { kind: 'approval_removed', approvalId: 'old', conversationId: 'c', resolution: 'answered' },
      { kind: 'task', teamId: 't', task: task({ taskId: 'y', subject: 'New', updatedAt: 5 }), change: 'created' },
      { kind: 'team', teamId: 't', what: ['run_state'] },
    ]);
    expect(qc.getQueryData<Approval[]>(keys.approvals(H))?.map((a) => a.approvalId)).toEqual(['new']);
    expect(qc.getQueryData<Task[]>(keys.tasks(H, 't'))?.map((t) => t.taskId)).toEqual(['y', 'x']);
    expect(qc.getQueryState(keys.runState(H, 't'))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(keys.runState(H, 'other'))?.isInvalidated).toBe(false);
  });

  it('reset drops thread cursors and invalidates everything for the host', () => {
    const qc = newClient();
    qc.setQueryData(keys.thread(H, 'c1'), { items: [], cursor: 'c9', before: null });
    qc.setQueryData(keys.teams(H), []);
    resetHost(qc, H);
    expect(qc.getQueryData<{ cursor?: string }>(keys.thread(H, 'c1'))?.cursor).toBeUndefined();
    expect(qc.getQueryState(keys.teams(H))?.isInvalidated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The demo facade, through the real client (contract §6)
// ---------------------------------------------------------------------------

describe('demo facade via createApi', () => {
  let facade: MockFacade;
  const gate = jest.fn(async () => true);
  const T = 'aiondx-app';
  const setup = (replyDelayMs = 40) => {
    facade = createMockFacade({ replyDelayMs });
    return createApi(createMockTransport(gate, {}, facade));
  };
  // Fake timers that still advance with real time: latency sleeps resolve, and the facade's
  // simulated agent turns don't keep the worker alive after the suite.
  beforeEach(() => jest.useFakeTimers({ advanceTimers: true }));
  afterEach(() => {
    facade?.dispose();
    jest.clearAllTimers();
    jest.useRealTimers();
    gate.mockClear();
  });

  it('serves the run state with derived attention', async () => {
    const api = setup();
    const run = await api.getRunState(T);
    expect(run.agents[0].role).toBe('lead');
    const by = (id: string) => run.agents.find((a) => a.slotId === id)!;
    expect(by('designer').attention).toBe('needs_approval');
    expect(by('writer').attention).toBe('needs_answer');
    expect(by('perf').attention).toBe('error');
    expect(by('mobile').queue.foreground).toBe(2);
    expect(by('mobile').currentTask?.subject).toBe('Build app screens per design spec');
  });

  it('answers by optionId behind the confirm gate; a second answer is already_resolved', async () => {
    const api = setup();
    const [first] = await api.listApprovals(T);
    const allow = first.options.find((o) => o.kind === 'allow_once')!;
    await expect(api.answerApproval(first, { optionId: allow.optionId })).resolves.toMatchObject({ resolved: true, messageDelivery: null });
    expect(gate).toHaveBeenCalledWith(expect.stringMatching(/^Allow /));
    await expect(api.answerApproval(first, { optionId: allow.optionId })).rejects.toMatchObject({ status: 409, code: 'already_resolved' });
  });

  it('refusals skip the gate; a message on an allow is rejected (400)', async () => {
    const api = setup();
    const a = (await api.listApprovals(T)).find((x) => x.slotId === 'mobile')!;
    await expect(api.answerApproval(a, { optionId: 'opt-allow-once', message: 'why' })).rejects.toMatchObject({ status: 400, code: 'invalid_request' });
    gate.mockClear();
    // An ACP agent gets the reason as a follow-up message.
    await expect(api.answerApproval(a, { optionId: 'opt-reject-once', message: 'Not that file' })).resolves.toMatchObject({ messageDelivery: 'followup' });
    expect(gate).not.toHaveBeenCalled();
  });

  it('refuses lead shutdown, and the Researcher declines a shutdown', async () => {
    // Slow agents, so "requested" is still visible after the mock's 250 ms latency.
    const api = setup(4000);
    await expect(api.shutdownAgent(T, 'lead')).rejects.toMatchObject({ status: 422, code: 'lead_not_allowed' });
    await api.shutdownAgent(T, 'research', 'Duplicate');
    expect((await api.getAgent(T, 'research')).shutdown).toMatchObject({ state: 'requested', reason: 'Duplicate' });
    await jest.advanceTimersByTimeAsync(3000);
    expect((await api.getAgent(T, 'research')).shutdown?.state).toBe('rejected');
  });

  it('task create notifies the owner with a user-sent notice (rev 4.1)', async () => {
    const api = setup();
    const created = await api.createTask(T, { subject: 'Check pairing', owner: 'qa' });
    expect(created).toMatchObject({ ownerName: 'QA Engineer', status: 'pending' });
    const thread = await api.syncMessages('conv-qa');
    const notice = thread.items.find((m) => m.notice?.kind === 'task_assigned');
    expect(notice).toMatchObject({ role: 'user', sender: { kind: 'user' }, notice: { taskId: created.taskId } });
  });

  it('syncs messages by cursor: only rows inserted or changed since', async () => {
    const api = setup();
    const first = await api.syncMessages('conv-research');
    const sent = await api.sendMessage('conv-research', 'hello');
    const next = await api.syncMessages('conv-research', first.cursor);
    const ids = next.items.map((m) => m.messageId);
    // The new message (and maybe the agent's reply already), never the rows from the first page.
    expect(ids[0]).toBe(sent.messageId);
    expect(ids.some((id) => first.items.some((m) => m.messageId === id))).toBe(false);
    expect(sent.delivery).toBe('started');
  });

  it('change feed: token without since, coalesced entries after, reset on a foreign token', async () => {
    const api = setup();
    const start = await api.getChanges(undefined, 25);
    expect(start).toMatchObject({ reset: false, more: false, changes: [] });
    await api.updateTask(T, (await api.listTasks(T))[0].taskId, { subject: 'Renamed once' });
    await api.updateTask(T, (await api.listTasks(T))[0].taskId, { subject: 'Renamed twice' });
    const next = await api.getChanges(start.token, 0);
    const taskEntries = next.changes.filter((c) => c.kind === 'task');
    expect(taskEntries).toHaveLength(1);
    expect(taskEntries[0]).toMatchObject({ task: { subject: 'Renamed twice' } });
    expect((await api.getChanges('stale.3', 0)).reset).toBe(true);
  });

  it('marks sensitive requests the way the bridge will check them', () => {
    setup();
    expect(facade.isSensitive({ method: 'POST', path: '/v1/teams/t/agents', body: {} })).toBe(true);
    expect(facade.isSensitive({ method: 'DELETE', path: '/v1/teams/t/agents/s' })).toBe(true);
    expect(facade.isSensitive({ method: 'PATCH', path: '/v1/teams/t/tasks/x', body: { status: 'deleted' } })).toBe(true);
    expect(facade.isSensitive({ method: 'PATCH', path: '/v1/teams/t/tasks/x', body: { status: 'completed' } })).toBe(false);
    expect(facade.isSensitive({ method: 'POST', path: '/v1/teams/t/agents/s/stop' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Phase 2: confirmations (SPEC §15) and thread rows (§14.3)
// ---------------------------------------------------------------------------

describe('confirm state (SPEC §15.5)', () => {
  const device = (requireConfirm: boolean) => ({ device: { deviceId: 'd', name: 'p', pairedAt: 0, requireConfirm, confirmMode: 'biometric' as const } });
  it('maps pairing + PC setting to the five states', () => {
    expect(confirmStateFor({ confirmMode: 'biometric' }, device(true))).toBe('biometric');
    expect(confirmStateFor({ confirmMode: 'device_passcode' }, undefined)).toBe('device_passcode');
    expect(confirmStateFor({ confirmMode: 'none' }, device(true))).toBe('none');
    expect(confirmStateFor({ confirmMode: 'biometric', keyInvalid: true }, device(true))).toBe('needs_reconfirm');
    expect(confirmStateFor({}, device(true))).toBe('needs_reconfirm');
    // Off wins: the PC doesn't ask for proofs from this phone at all.
    expect(confirmStateFor({ confirmMode: 'none' }, device(false))).toBe('off');
    expect(canConfirm('off') && canConfirm('biometric') && !canConfirm('none') && !canConfirm('needs_reconfirm')).toBe(true);
  });

  it('prompt copy names the action (§15.1.1, §15.4)', () => {
    expect(allowPrompt({ kind: 'allow_once' }, 'Bash', 'App Designer')).toBe('Allow Bash for App Designer');
    expect(allowPrompt({ kind: 'allow_always', alwaysScope: 'backend_defined' }, 'Write', 'Mobile Engineer')).toBe('Always allow Write for Mobile Engineer');
    expect(allowPrompt({ kind: 'allow_always', alwaysScope: 'same_as_once' }, 'Bash', 'App Designer')).toBe('Allow Bash for App Designer');
    expect(allowPrompt(null, 'X', 'a'.repeat(50))).toMatch(/…$/);
  });
});

describe('re-key codes (§15.3 R2 local checks)', () => {
  const offer = { hostId: 'h1', deviceId: 'd1', rekeySecret: new Uint8Array(32).fill(1), expiresAt: 123 };
  it('round-trips a re-key URI and tells pairing codes apart', () => {
    expect(classifyScannedCode(encodeRekeyUri(offer))).toEqual({ kind: 'rekey', offer });
    expect(classifyScannedCode('aiondx://pair?v=1&id=x').kind).toBe('pairing');
    expect(classifyScannedCode('https://example.com').kind).toBe('unknown');
    expect(classifyScannedCode('aiondx://rekey?v=1&id=h&d=d&s=short&x=1').kind).toBe('unknown');
  });
});

describe('plan rows (§14.3.3)', () => {
  it('reads ACP plan entries and refuses anything else', () => {
    const entries = planEntries({ entries: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'weird' }, { nope: 1 }] });
    expect(entries).toEqual([
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'pending' },
    ]);
    expect(planEntries('text')).toBeNull();
  });
});

describe('demo re-key (§15.3 against the demo PC)', () => {
  beforeEach(() => jest.useFakeTimers({ advanceTimers: true }));
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });
  it('issues a key for the built-in offer and rejects a wrong secret', async () => {
    const facade = createMockFacade({ replyDelayMs: 40 });
    const api = createApi(createMockTransport(async () => true, {}, facade));
    const { device } = await api.getHost();
    await expect(api.reissueConfirmKey(DEMO_REKEY_SECRET, device!.deviceId, 'biometric')).resolves.toMatchObject({ confirmKey: expect.any(Uint8Array) });
    await expect(api.reissueConfirmKey(new Uint8Array(32), device!.deviceId, 'biometric')).rejects.toMatchObject({ code: 'rekey_invalid' });
    facade.dispose();
  });
});

describe('§16 fixes', () => {
  it('#2: a title that already contains the path falls back to the tool name', () => {
    expect(approvalHeading({ title: 'Write src/app/_layout.tsx', toolName: 'Write', inputSummary: 'src/app/_layout.tsx' })).toBe('Write');
    expect(approvalHeading({ title: 'Bash', toolName: 'Bash', inputSummary: 'npx expo install' })).toBe('Bash');
    expect(approvalHeading({ title: null, toolName: null, inputSummary: null })).toBe('Tool call');
  });

  it('D4: passcode lockout and mismatch get their own copy; the 2nd cancel in 30 s gets one neutral hint', () => {
    const t0 = 1_000_000;
    expect(cancelNotice(new ConfirmCancelledError('lockout', 'p1'), t0)).toMatch(/Too many passcode attempts/);
    expect(cancelNotice(new ConfirmCancelledError('cancel', 'p2'), t0)).toBeNull();
    expect(cancelNotice(new ConfirmCancelledError('cancel', 'p2'), t0 + 10_000)).toMatch(/If Face ID is locked/);
    // Shown once; the count starts over.
    expect(cancelNotice(new ConfirmCancelledError('cancel', 'p2'), t0 + 11_000)).toBeNull();
    // Outside the 30 s window the earlier cancel no longer counts.
    expect(cancelNotice(new ConfirmCancelledError('failed', 'p3'), t0)).toBe("Passcode didn't match. Try again.");
    expect(cancelNotice(new ConfirmCancelledError('cancel', 'p3'), t0 + 31_000)).toBeNull();
  });
});

describe('contract rev 4.4', () => {
  it('§6.5: a permission keeps its display-only questions and is answered by optionId only', async () => {
    const a = toApproval({
      approvalId: 'p',
      kind: 'permission',
      conversationId: 'c',
      freeText: true,
      questions: [{ question: 'Keep English?', header: null, multiSelect: false, options: [{ label: 'Yes' }] }],
      options: [{ optionId: 'o1', label: 'Yes', kind: 'allow_once' }],
    })!;
    expect(a.kind).toBe('permission');
    expect(a.questions?.[0].question).toBe('Keep English?');
    expect(a.freeText).toBe(false);
    expect(toApproval({ approvalId: 'q', kind: 'permission', conversationId: 'c' })!.questions).toBeUndefined();

    jest.useFakeTimers({ advanceTimers: true });
    const facade = createMockFacade({ replyDelayMs: 40 });
    const api = createApi(createMockTransport(async () => true, {}, facade));
    const demo = (await api.listApprovals()).find((x) => x.conversationId === 'solo-translate')!;
    expect(demo).toMatchObject({ kind: 'permission', freeText: false, questions: [expect.objectContaining({ header: 'Terminology' })] });
    await expect(api.answerApproval(demo, { answers: [{ question: demo.questions![0].question, labels: ['Keep English'] }] })).rejects.toMatchObject({ status: 400 });
    await expect(api.answerApproval(demo, { optionId: 'opt-keep' })).resolves.toMatchObject({ resolved: true });
    facade.dispose();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('§6.7: a change entry or write response with assignment null keeps the assignment a read found', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
    const assignment = { conversationId: 'conv-qa', messageId: 'm1', createdAt: 5 };
    qc.setQueryData(keys.tasks('h', 't'), [task({ taskId: 'x', assignment, updatedAt: 1 })]);
    applyChanges(qc, 'h', [{ kind: 'task', teamId: 't', task: task({ taskId: 'x', subject: 'Renamed', assignment: null, updatedAt: 2 }), change: 'updated' }]);
    const [after] = qc.getQueryData<Task[]>(keys.tasks('h', 't'))!;
    expect(after).toMatchObject({ subject: 'Renamed', assignment });
    // A real assignment from a later read still replaces it.
    const next = { conversationId: 'conv-qa', messageId: 'm2', createdAt: 9 };
    applyChanges(qc, 'h', [{ kind: 'task', teamId: 't', task: task({ taskId: 'x', assignment: next, updatedAt: 3 }), change: 'updated' }]);
    expect(qc.getQueryData<Task[]>(keys.tasks('h', 't'))![0].assignment).toEqual(next);
  });

  it('§7: bracketed IPv6 ULA URLs are kept and fetched; link-local is skipped', async () => {
    const { publicKey } = generateKeyPair();
    const uri = encodePairingUri({
      v: 1,
      hostId: 'h',
      hostName: 'PC',
      hostPublicKey: publicKey,
      pairingSecret: new Uint8Array(32).fill(1),
      urls: ['http://[fe80::1]:47734', 'http://[fd12::1]:47734', 'http://192.168.1.5:47734'],
      expiresAt: Date.now() + 60_000,
    });
    expect(parsePairingUri(uri).urls).toEqual(['http://[fd12::1]:47734', 'http://192.168.1.5:47734']);
    expect(isUsableBaseUrl('http://[FE80::abcd]:1')).toBe(false);
    expect(isUsableBaseUrl('http://[fd12::1]:47734')).toBe(true);
    expect(joinUrl('http://[fd12::1]:47734/', '/api/mobile/v1/rpc')).toBe('http://[fd12::1]:47734/api/mobile/v1/rpc');

    const calls: string[] = [];
    globalThis.fetch = jest.fn(async (url: string | URL) => {
      calls.push(String(url));
      return { status: 200, json: async () => ({}) } as Response;
    }) as typeof fetch;
    await postJson(['http://[fe80::1%25en0]:47734', 'http://[fd12::1]:47734'], '/api/mobile/v1/session', {});
    expect(calls).toEqual(['http://[fd12::1]:47734/api/mobile/v1/session']);
  });
});
