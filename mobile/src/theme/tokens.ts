import { Platform } from 'react-native';

// Design tokens — copied from docs/design/tokens.ts (source of truth: docs/design/SPEC.md §3, §14).
// Local change: MONO (platform font name).

export const palette = {
  light: {
    bg: '#F7F8FA',
    surface: '#FFFFFF',
    surfaceAlt: '#EEF1F5',
    border: '#DDE2E8',
    text: '#11151B',
    textMuted: '#5B6573',
    primary: '#3B5BDB',
    onPrimary: '#FFFFFF',
    danger: '#D6336C',
    stWorking: '#2F9E44',
    stIdle: '#868E96',
    stNeedsYou: '#E8590C',
    stWaiting: '#B08900',
    stError: '#C92A2A',
    stTransition: '#3B5BDB',
    stUnknown: '#ADB5BD',
    // Text-safe status colors (≥4.5:1 on surface, page bg and the 12% status-tint pill).
    // Use for pill labels, blocked-reason lines and "blocked by N"; the st* values above are
    // for dots, edge strips and icons only (≥3:1 non-text).
    stWorkingText: '#237A35',
    stIdleText: '#5F6B76',
    stNeedsYouText: '#B4470A',
    stWaitingText: '#7A5E00',
    stErrorText: '#B02525',
    stTransitionText: '#3B5BDB',
    stUnknownText: '#5F6B76',
  },
  dark: {
    bg: '#0E1116',
    surface: '#171B22',
    surfaceAlt: '#1F252E',
    border: '#2A313C',
    text: '#E8ECF1',
    textMuted: '#98A2B1',
    primary: '#7C93FF',
    onPrimary: '#0E1116',
    danger: '#FF6B9A',
    stWorking: '#51CF66',
    stIdle: '#7D8794',
    stNeedsYou: '#FF922B',
    stWaiting: '#FCC419',
    stError: '#FF6B6B',
    stTransition: '#7C93FF',
    stUnknown: '#495057',
    stWorkingText: '#51CF66',
    stIdleText: '#98A2B1',
    stNeedsYouText: '#FF922B',
    stWaitingText: '#FCC419',
    stErrorText: '#FF6B6B',
    stTransitionText: '#7C93FF',
    stUnknownText: '#98A2B1',
  },
} as const;

export type ColorToken = keyof typeof palette.light;

// 'monospace' isn't a font name on iOS.
const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' });

export const type = {
  display: { fontSize: 28, lineHeight: 34, fontWeight: '700' },
  title: { fontSize: 20, lineHeight: 26, fontWeight: '600' },
  headline: { fontSize: 16, lineHeight: 22, fontWeight: '600' },
  body: { fontSize: 15, lineHeight: 21, fontWeight: '400' },
  caption: { fontSize: 13, lineHeight: 18, fontWeight: '400' },
  mono: { fontSize: 13, lineHeight: 18, fontWeight: '400', fontFamily: MONO },
  verifyCode: { fontSize: 32, lineHeight: 40, fontWeight: '700', fontFamily: MONO, letterSpacing: 6 },
} as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, gutter: 16 } as const;
export const radius = { chip: 999, card: 12, sheet: 16, bubble: 18 } as const;
export const touchTarget = 44;
export const motion = { fast: 150, normal: 250 } as const;

// Slot status → token, text token, icon, and label. Status must never be conveyed by color alone.
// Rev 2 (SPEC §14.1.1): which status applies is picked by the priority table there.
export const slotStatusStyle = {
  needs_you: { color: 'stNeedsYou', textColor: 'stNeedsYouText', icon: 'hand', label: 'Needs you' },
  question: { color: 'stNeedsYou', textColor: 'stNeedsYouText', icon: 'hand', label: 'Question' },
  error: { color: 'stError', textColor: 'stErrorText', icon: 'x-octagon', label: 'Error' },
  removing: { color: 'stTransition', textColor: 'stTransitionText', icon: 'spinner', label: 'Removing…' },
  shutting_down: { color: 'stTransition', textColor: 'stTransitionText', icon: 'spinner', label: 'Shutting down…' },
  paused: { color: 'stWaiting', textColor: 'stWaitingText', icon: 'pause', label: 'Paused' },
  working: { color: 'stWorking', textColor: 'stWorkingText', icon: 'pulse-dot', label: 'Working' },
  starting: { color: 'stTransition', textColor: 'stTransitionText', icon: 'spinner', label: 'Starting…' },
  idle: { color: 'stIdle', textColor: 'stIdleText', icon: 'circle-outline', label: 'Idle' },
  not_running: { color: 'stUnknown', textColor: 'stUnknownText', icon: 'dash', label: 'Not running' },
  offline: { color: 'stUnknown', textColor: 'stUnknownText', icon: 'dash', label: 'Unknown' },
} as const satisfies Record<string, { color: ColorToken; textColor: ColorToken; icon: string; label: string }>;

// Derived "waiting on a task" reason line on Idle cards (SPEC §14.2). Not a status or section.
export const waitingReasonStyle = { color: 'stWaiting', textColor: 'stWaitingText', icon: 'hourglass' } as const;

// Dashboard sections, top to bottom (SPEC §14.1.1). "Waiting" was removed in rev 2.
export const dashboardSections = [
  { key: 'needs_you', label: 'Needs you', statuses: ['needs_you', 'question'] },
  { key: 'error', label: 'Error', statuses: ['error'] },
  { key: 'shutting_down', label: 'Shutting down', statuses: ['removing', 'shutting_down'] },
  { key: 'paused', label: 'Paused', statuses: ['paused'] },
  { key: 'working', label: 'Working', statuses: ['working', 'starting'] },
  { key: 'idle', label: 'Idle', statuses: ['idle', 'not_running', 'offline'] },
] as const;

// Polling intervals in ms (SPEC §5).
export const poll = {
  runState: 3000,
  runStateBackgroundTab: 10000,
  thread: 2000,
  threadAfterSend: 1000,
  threadAfterSendWindow: 30000,
  conversations: 5000,
  tasks: 5000,
  backoff: [3000, 6000, 12000, 30000],
  staleAfterMultiplier: 2,
  unreachableAfterMs: 60000,
} as const;
