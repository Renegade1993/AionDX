import { Stack } from 'expo-router';

import { useConfirmAttentionToast } from '@/components/confirm';
import { useChangeFeed } from '@/lib/api/changeFeed';
import { useConnectionStore } from '@/state/connectionStore';
import { useColors } from '@/theme';

/** Tabs plus the modals that cover them (approvals, spawn, task editor, team picker). */
export default function AppLayout() {
  const c = useColors();
  // One change feed for the active PC keeps every screen current (contract §6.2).
  useChangeFeed(useConnectionStore((s) => s.activeHostId));
  // "Confirmations need attention on NATE-PC" · Fix, once per PC and state (SPEC §15.1.5).
  useConfirmAttentionToast();
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: c.surface },
        headerTintColor: c.primary,
        headerTitleStyle: { color: c.text },
        contentStyle: { backgroundColor: c.bg },
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="approvals" options={{ presentation: 'modal', title: 'Approvals' }} />
      <Stack.Screen
        name="approval/[approvalId]"
        options={{
          presentation: 'formSheet',
          sheetAllowedDetents: [0.7, 1],
          sheetGrabberVisible: true,
          headerShown: false,
        }}
      />
      <Stack.Screen name="spawn" options={{ presentation: 'modal', title: 'Spawn an agent' }} />
      <Stack.Screen name="rekey/[hostId]" options={{ presentation: 'fullScreenModal', title: 'Re-confirm' }} />
      <Stack.Screen
        name="confirm-help"
        options={{ presentation: 'formSheet', sheetAllowedDetents: [0.75, 1], sheetGrabberVisible: true, headerShown: false }}
      />
      <Stack.Screen name="task-edit" options={{ presentation: 'modal', title: 'New task' }} />
      <Stack.Screen
        name="team-picker"
        options={{ presentation: 'formSheet', sheetAllowedDetents: [0.4, 0.8], sheetGrabberVisible: true, title: 'Switch team' }}
      />
    </Stack>
  );
}
