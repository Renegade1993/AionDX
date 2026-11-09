import type { Activity, Approval, Message, Task } from '../types';
import type { MockAgent, MockConversation, MockTeam } from './facade';

/*
 * Demo data: one busy team that exercises every display state the contract can report
 * (needs approval, question, error, working with a queue, waiting on a blocked task,
 * a solo chat, a stopped second team).
 */

const MIN = 60_000;

// Task ids look like the real ones (hex UUIDs).
export const T1 = '01a1b3ff-8bea-7780-828a-4d155d10b93d';
export const T2 = '01a1b3ff-9927-7cc2-8c50-f3034212d550';
export const T3 = '01a1b40d-94a0-7463-b7bc-6cf103c90a37';
export const T4 = '01a1b425-ae9f-7e50-9ac5-c7530b8a0dc0';
export const T5 = '01a1b449-5abe-7612-ab58-a0cdce0c5837';

const T3_DESCRIPTION = [
  '## Scope',
  'Build the screens from `docs/design/SPEC.md` on top of the scaffold.',
  '',
  '- Restructure routes into **(onboarding)** / **(app)** groups',
  '- Agents, Chat, Tasks and Settings tabs',
  '- Approvals inbox + sheet',
  '- Encrypted local cache',
  '- App lock (Face ID default)',
  '',
  '## Notes',
  '1. Drop manual pairing for v1',
  '2. Build against mock data',
  '3. Keep the data layer swappable',
  '',
  '```ts',
  'export interface AionDxApi { getRunState(teamId: string): Promise<RunState> }',
  '```',
].join('\n');

const BASH_COMMAND =
  'npx expo install expo-camera && npx expo prebuild --clean --platform ios && cd ios && pod install --repo-update && cd .. && npx expo run:ios --configuration Release';

function agent(partial: Partial<MockAgent> & Pick<MockAgent, 'slotId' | 'name'>): MockAgent {
  return {
    role: 'teammate',
    conversationId: `conv-${partial.slotId}`,
    backend: 'claude',
    model: 'sonnet',
    icon: null,
    state: 'idle',
    blockedReason: null,
    runtime: 'ready',
    turn: null,
    queue: [],
    backgroundQueue: 0,
    shutdown: null,
    lastActivityAt: 0,
    ...partial,
  };
}

type SeedMessage = Omit<Message, 'conversationId' | 'status' | 'type'> & Partial<Pick<Message, 'status' | 'type'>>;

function conversation(c: Omit<MockConversation, 'messages' | 'readUpTo' | 'state' | 'updatedAt'>, messages: SeedMessage[], readUpTo = 0): MockConversation {
  const full = messages.map((m) => ({ type: 'text' as const, status: 'done' as const, ...m, conversationId: c.conversationId, rev: 0 }));
  return { ...c, state: 'idle', readUpTo, messages: full, updatedAt: full.at(-1)?.createdAt ?? 0 };
}

const user = (messageId: string, text: string, createdAt: number): SeedMessage => ({ messageId, role: 'user', sender: { kind: 'user' }, text, createdAt });
const agentSays = (name: string, messageId: string, text: string, createdAt: number): SeedMessage => ({
  messageId,
  role: 'agent',
  sender: { kind: 'agent', name },
  text,
  createdAt,
});

export interface Seed {
  teams: MockTeam[];
  conversations: MockConversation[];
  approvals: Approval[];
}

export function seed(now: number): Seed {
  const app: MockTeam = {
    teamId: 'aiondx-app',
    name: 'AionDX App Team',
    workspace: 'C:\\projects\\aiondx',
    sessionStatus: 'ready',
    activeRun: null,
    agents: [
      agent({ slotId: 'lead', name: 'Claude Code', role: 'lead', model: 'opus', lastActivityAt: now - 2 * MIN }),
      agent({ slotId: 'designer', name: 'App Designer', state: 'running', turn: { turnId: 'turn-d1', startedAt: now - 3 * MIN }, lastActivityAt: now - 2 * MIN }),
      agent({
        slotId: 'mobile',
        name: 'Mobile Engineer',
        backend: 'acp',
        model: 'opus[1m]',
        state: 'running',
        turn: { turnId: 'turn-m1', startedAt: now - 4 * MIN },
        queue: ['m-mq1', 'm-mq2'],
        lastActivityAt: now - 1 * MIN,
      }),
      agent({ slotId: 'qa', name: 'QA Engineer', lastActivityAt: now - 30 * MIN }),
      agent({ slotId: 'writer', name: 'Docs Writer', state: 'running', turn: { turnId: 'turn-w1', startedAt: now - 6 * MIN }, lastActivityAt: now - 5 * MIN }),
      agent({ slotId: 'research', name: 'Researcher', lastActivityAt: now - 50 * MIN }),
      // Paused on the PC (SPEC §14.1.2): no Stop / Wake on the phone, messages only queue.
      agent({ slotId: 'release', name: 'Release Bot', state: 'paused', queue: ['m-rq1'], lastActivityAt: now - 25 * MIN }),
      agent({ slotId: 'perf', name: 'Perf Analyst', runtime: 'failed', blockedReason: 'runtime_failed', state: 'blocked', lastActivityAt: now - 15 * MIN }),
    ],
    tasks: [],
    broadcasts: [
      {
        broadcastId: 'b-1',
        teamId: 'aiondx-app',
        content: 'Standup in 10 minutes — post your status.',
        createdAt: now - 60 * MIN,
        sentFrom: { kind: 'mobile', deviceId: 'demo-device', deviceName: 'This phone' },
        deliveries: ['lead', 'designer', 'mobile', 'qa', 'writer', 'research', 'perf'].map((slotId) => ({
          slotId,
          messageId: `m-b1-${slotId}`,
          delivery: slotId === 'perf' ? ('failed' as const) : ('started' as const),
          error: slotId === 'perf' ? 'Agent runtime failed to start' : undefined,
        })),
      },
    ],
    activity: [],
  };

  const task = (t: Omit<Task, 'teamId' | 'ownerName' | 'blocks' | 'assignment' | 'createdAt' | 'updatedAt'> & Partial<Task>): Task => ({
    teamId: app.teamId,
    ownerName: null,
    blocks: [],
    assignment: null,
    createdAt: now - 90 * MIN,
    updatedAt: now - 20 * MIN,
    ...t,
  });
  app.tasks = [
    task({ taskId: T1, subject: 'Design AionDX mobile app screens & flows', description: 'Design the full UI/UX for the AionDX companion app (iOS/Android).\n\n- Dashboard\n- Chat\n- Task board\n- Agent controls\n- Pairing flow', status: 'completed', owner: 'designer', blockedBy: [] }),
    task({ taskId: T2, subject: 'Scaffold React Native app + pairing/encryption design', description: null, status: 'completed', owner: 'mobile', blockedBy: [] }),
    task({
      taskId: T3,
      subject: 'Build app screens per design spec',
      description: T3_DESCRIPTION,
      status: 'in_progress',
      owner: 'mobile',
      blockedBy: [T1, T2],
      assignment: { conversationId: 'conv-mobile', messageId: 'm-m0', createdAt: now - 20 * MIN },
      updatedAt: now - 4 * MIN,
    }),
    task({ taskId: T4, subject: 'Write QA test plan for pairing + approvals', description: null, status: 'pending', owner: 'qa', blockedBy: [T3] }),
    task({ taskId: T5, subject: 'Review the bridge API schema', description: null, status: 'pending', owner: 'user', blockedBy: [] }),
  ];

  const conversations: MockConversation[] = [
    conversation({ conversationId: 'conv-lead', name: 'Claude Code', kind: 'team_member', teamId: app.teamId, slotId: 'lead', backend: 'claude', model: 'opus' }, [
      user('m-l1', 'Can you get the mobile app scaffolded today?', now - 40 * MIN),
      agentSays('Claude Code', 'm-l2', "On it. I've assigned **Mobile Engineer** to the scaffold and **App Designer** to the screens.", now - 39 * MIN),
      { messageId: 'm-l2t', role: 'agent', sender: { kind: 'agent', name: 'Claude Code' }, type: 'tool_call', tool: { name: 'Bash', title: 'Bash', status: 'completed', summary: 'git status' }, createdAt: now - 38 * MIN },
      { messageId: 'm-l2c', role: 'system', sender: { kind: 'team_system' }, text: 'Context cleared', notice: { kind: 'context_reset' }, createdAt: now - 30 * MIN },
      user('m-l2u', 'Status check: where are we on the mobile app?', now - 5 * MIN),
      agentSays('Claude Code', 'm-l3', 'Mobile Engineer is building the screens; App Designer needs an approval for the camera module. Standing by for your review.', now - 2 * MIN),
    ], now - 10 * MIN),
    conversation({ conversationId: 'conv-designer', name: 'App Designer', kind: 'team_member', teamId: app.teamId, slotId: 'designer', backend: 'claude' }, [
      agentSays('App Designer', 'm-d1', 'Prototyping the QR pairing screen; I need the camera module installed.', now - 3 * MIN),
    ], now),
    conversation({ conversationId: 'conv-mobile', name: 'Mobile Engineer', kind: 'team_member', teamId: app.teamId, slotId: 'mobile', backend: 'acp', model: 'opus[1m]' }, [
      {
        messageId: 'm-m0',
        role: 'teammate',
        sender: { kind: 'teammate', name: 'Claude Code', slotId: 'lead', conversationId: 'conv-lead' },
        text: `📋 Task assigned to you (#${T3}): Build app screens per design spec`,
        notice: { kind: 'task_assigned', taskId: T3 },
        createdAt: now - 20 * MIN,
      },
      agentSays(
        'Mobile Engineer',
        'm-m1',
        "I've scaffolded the Expo app. Questions:\n\n1. Use expo-router?\n2. Keep polling at 3s?\n\n```ts\nexport const poll = { runState: 3000 };\n```",
        now - 15 * MIN,
      ),
      user('m-m2', 'Yes, expo-router. 3s is fine.', now - 14 * MIN),
      { messageId: 'm-m3', role: 'agent', sender: { kind: 'agent', name: 'Mobile Engineer' }, type: 'thinking', text: 'Routes first, then the data layer…', createdAt: now - 13 * MIN },
      ...['src/app/_layout.tsx', 'src/app/(tabs)/_layout.tsx', 'src/lib/api/hooks.ts', 'src/theme/tokens.ts', 'src/components/SlotCard.tsx'].map(
        (file, i): SeedMessage => ({
          messageId: `m-mt${i}`,
          role: 'agent',
          sender: { kind: 'agent', name: 'Mobile Engineer' },
          type: 'tool_call',
          tool: { name: 'Edit', title: 'Edit', status: 'completed', summary: file },
          createdAt: now - 12 * MIN + i * 1000,
        }),
      ),
      {
        messageId: 'm-mp',
        role: 'agent',
        sender: { kind: 'agent', name: 'Mobile Engineer' },
        type: 'plan',
        raw: {
          entries: [
            { content: 'Restructure routes', status: 'completed' },
            { content: 'Dashboard and agent detail', status: 'completed' },
            { content: 'Chat thread', status: 'completed' },
            { content: 'Approvals sheet', status: 'in_progress' },
            { content: 'Task board', status: 'pending' },
          ],
        },
        createdAt: now - 11 * MIN,
      },
      {
        messageId: 'm-mtm',
        role: 'teammate',
        sender: { kind: 'teammate', name: 'App Designer', slotId: 'designer', conversationId: 'conv-designer' },
        text: 'Heads-up: the approval sheet now lists the agent’s own options, not three fixed buttons. See SPEC §14.4.',
        createdAt: now - 10 * MIN,
      },
      { messageId: 'm-mt9', role: 'agent', sender: { kind: 'agent', name: 'Mobile Engineer' }, type: 'tool_call', tool: { name: 'Bash', title: 'Bash', status: 'failed', summary: 'npx tsc --noEmit · exit code 2' }, createdAt: now - 9 * MIN },
      {
        messageId: 'm-m4',
        role: 'agent',
        sender: { kind: 'agent', name: 'Mobile Engineer' },
        status: 'streaming',
        text: 'Two type errors left in the approval sheet; fixing the option ordering now',
        createdAt: now - 1 * MIN,
      },
    ], now - 14 * MIN),
    conversation({ conversationId: 'conv-qa', name: 'QA Engineer', kind: 'team_member', teamId: app.teamId, slotId: 'qa', backend: 'claude' }, []),
    conversation({ conversationId: 'conv-writer', name: 'Docs Writer', kind: 'team_member', teamId: app.teamId, slotId: 'writer', backend: 'claude' }, [
      agentSays('Docs Writer', 'm-w1', "I'm drafting the README. One question before I go further.", now - 6 * MIN),
    ]),
    conversation({ conversationId: 'conv-research', name: 'Researcher', kind: 'team_member', teamId: app.teamId, slotId: 'research', backend: 'claude' }, []),
    conversation({ conversationId: 'conv-perf', name: 'Perf Analyst', kind: 'team_member', teamId: app.teamId, slotId: 'perf', backend: 'claude' }, [
      {
        messageId: 'm-p1',
        role: 'agent',
        sender: { kind: 'agent', name: 'Perf Analyst' },
        type: 'tips',
        status: 'error',
        error: { source: 'agent', code: 'overloaded', message: 'Upstream 529 overloaded' },
        createdAt: now - 15 * MIN,
      },
    ]),
    conversation({ conversationId: 'conv-release', name: 'Release Bot', kind: 'team_member', teamId: app.teamId, slotId: 'release', backend: 'claude' }, [
      agentSays('Release Bot', 'm-r1', 'Release checklist is ready for 1.0.', now - 26 * MIN),
      user('m-rq1', 'Tag the 1.0 release when the build is green.', now - 20 * MIN),
    ], now),
    conversation({ conversationId: 'solo-notes', name: 'Release notes draft', kind: 'solo', backend: 'claude', model: 'sonnet', workspace: 'C:\\projects\\aiondx' }, [
      user('m-s1', 'Draft release notes for 1.0.', now - 3 * 60 * MIN - MIN),
      agentSays('Claude', 'm-s2', 'Here is a first draft of the 1.0 release notes…', now - 3 * 60 * MIN),
      user('m-s3', 'Make it shorter and add the pairing changes.', now - 4 * MIN),
      {
        messageId: 'm-s4',
        role: 'system',
        sender: { kind: 'app' },
        type: 'tips',
        status: 'error',
        error: { source: 'send_failed', code: 'cli_missing', message: 'Claude CLI not found. Install it on your PC, then try again.', messageId: 'm-s3' },
        createdAt: now - 4 * MIN + 2000,
      },
    ], now),
  ];

  // Rev 4.4: an ACP agent asking through the permission channel. A solo chat, so team demos are unchanged.
  conversations.push(
    conversation({ conversationId: 'solo-translate', name: 'Translate the docs', kind: 'solo', backend: 'acp', model: 'gemini-2.5-pro', workspace: 'C:\projects\aiondx' }, [
      user('m-t1', 'Translate the README into German.', now - 8 * MIN),
      agentSays('Gemini', 'm-t2', 'Before I start: one question about the terminology.', now - 7 * MIN),
    ]),
  );

  const approvals: Approval[] = [
    {
      approvalId: 'c29sby10cjpjYWxsLTQ',
      kind: 'permission',
      conversationId: 'solo-translate',
      agentName: 'Gemini',
      title: 'Keep product names in English?',
      description: '',
      commandType: null,
      toolName: 'ask_user',
      input: { question: 'Keep product names in English?' },
      inputSummary: null,
      // Display-only (contract §6.5 rev 4.4): answered with an optionId, never `answers`.
      questions: [
        {
          question: 'Should product names like "AionDX" and "Agents" stay in English?',
          header: 'Terminology',
          multiSelect: false,
          options: [
            { label: 'Keep English', description: 'Matches the app UI' },
            { label: 'Translate', description: 'Fully German docs' },
          ],
        },
      ],
      options: [
        { optionId: 'opt-keep', label: 'Keep English', kind: 'allow_once', rule: null },
        { optionId: 'opt-translate', label: 'Translate', kind: 'other', rule: null },
        { optionId: 'opt-cancel', label: 'Cancel', kind: 'reject_once', rule: null },
      ],
      freeText: false,
      firstSeenAt: now - 7 * MIN,
    },
    {
      approvalId: 'YXBwLTE6Y2FsbC0x',
      kind: 'permission',
      conversationId: 'conv-designer',
      teamId: app.teamId,
      slotId: 'designer',
      agentName: 'App Designer',
      title: 'Bash',
      description: '',
      commandType: 'execute',
      toolName: 'Bash',
      input: { command: BASH_COMMAND, description: 'Need camera for QR pairing prototype' },
      inputSummary: BASH_COMMAND,
      options: [
        { optionId: 'allow', label: 'Allow once', kind: 'allow_once', rule: null },
        { optionId: 'allow_always', label: 'Always allow', kind: 'allow_always', rule: null, alwaysScope: 'same_as_once' },
        { optionId: 'reject', label: 'Deny', kind: 'reject_once', rule: null },
      ],
      freeText: false,
      firstSeenAt: now - 2 * MIN,
    },
    {
      approvalId: 'YXBwLTI6Y2FsbC0y',
      kind: 'permission',
      conversationId: 'conv-mobile',
      teamId: app.teamId,
      slotId: 'mobile',
      agentName: 'Mobile Engineer',
      title: 'Write src/app/_layout.tsx',
      description: '',
      commandType: 'edit',
      toolName: 'Write',
      input: { file_path: 'src/app/_layout.tsx' },
      inputSummary: 'src/app/_layout.tsx',
      options: [
        { optionId: 'opt-allow-once', label: 'Allow', kind: 'allow_once', rule: null },
        { optionId: 'opt-allow-always', label: 'Allow for this session', kind: 'allow_always', rule: null, alwaysScope: 'backend_defined' },
        { optionId: 'opt-reject-once', label: 'Reject', kind: 'reject_once', rule: null },
        { optionId: 'opt-reject-always', label: "Reject and don't ask again", kind: 'reject_always', rule: null },
      ],
      freeText: false,
      firstSeenAt: now - 30_000,
    },
    {
      approvalId: 'YXBwLTM6Y2FsbC0z',
      kind: 'question',
      conversationId: 'conv-writer',
      teamId: app.teamId,
      slotId: 'writer',
      agentName: 'Docs Writer',
      title: 'AskUserQuestion',
      description: '',
      commandType: null,
      toolName: 'AskUserQuestion',
      input: null,
      inputSummary: null,
      options: [],
      questions: [
        {
          question: 'Who should the README target?',
          header: 'Audience',
          multiSelect: false,
          options: [
            { label: 'End users', description: 'Install + first run only' },
            { label: 'Contributors', description: 'Build, test and release steps' },
          ],
        },
        {
          question: 'Which sections should it include?',
          header: 'Sections',
          multiSelect: true,
          options: [
            { label: 'Quick start', description: null },
            { label: 'Configuration', description: null },
            { label: 'Troubleshooting', description: null },
          ],
        },
      ],
      freeText: true,
      firstSeenAt: now - 5 * MIN,
    },
  ];

  const activity: Activity[] = [
    {
      kind: 'message',
      activityId: 'act-1',
      createdAt: now - 20 * MIN,
      message: {
        messageId: 'mb-1',
        from: { slotId: 'lead', name: 'Claude Code', isUser: false },
        to: { slotId: 'mobile', name: 'Mobile Engineer', isUser: false },
        msgType: 'message',
        content: `📋 Task assigned to you (#${T3}): Build app screens per design spec`,
        summary: null,
        read: true,
        notice: { kind: 'task_assigned', taskId: T3 },
      },
    },
    {
      kind: 'message',
      activityId: 'act-2',
      createdAt: now - 25 * MIN,
      message: {
        messageId: 'mb-2',
        from: { slotId: 'mobile', name: 'Mobile Engineer', isUser: false },
        to: { slotId: 'lead', name: 'Claude Code', isUser: false },
        msgType: 'message',
        content: 'Scaffold is done; starting on the screens.',
        summary: 'Scaffold done',
        read: true,
      },
    },
  ];
  app.activity = activity;

  const research: MockTeam = {
    teamId: 'research',
    name: 'Research Team',
    workspace: 'C:\\projects\\research',
    sessionStatus: 'stopped',
    activeRun: null,
    agents: [agent({ slotId: 'r-lead', name: 'Research Lead', role: 'lead', conversationId: 'conv-r-lead', runtime: 'dormant', blockedReason: 'session_stopped' })],
    tasks: [],
    broadcasts: [],
    activity: [],
  };
  conversations.push(
    conversation({ conversationId: 'conv-r-lead', name: 'Research Lead', kind: 'team_member', teamId: research.teamId, slotId: 'r-lead', backend: 'claude' }, []),
  );

  return { teams: [app, research], conversations, approvals };
}
