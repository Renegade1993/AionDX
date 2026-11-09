import Ionicons from '@expo/vector-icons/Ionicons';
import { Tabs } from 'expo-router/js-tabs';

import { useConfirmState, useRunState, useSoloConversations } from '@/lib/api/hooks';
import { useColors } from '@/theme';

export default function TabsLayout() {
  const c = useColors();
  // The change feed keeps these current, so badges stay live on every tab (SPEC §5).
  const runState = useRunState().data;
  const solo = useSoloConversations().data;
  // Only the hard signals count; `your_turn` never badges the Agents tab (SPEC §14.1.3).
  const needsYou = runState?.agents.filter((a) => a.waitingOnUser).length ?? 0;
  const unread = (runState?.agents.reduce((n, a) => n + a.unread, 0) ?? 0) + (solo?.reduce((n, conv) => n + conv.unread, 0) ?? 0);
  // A dot on Settings while confirmations need attention (SPEC §15.1.5).
  const confirm = useConfirmState();
  const settingsDot = confirm === 'needs_reconfirm' || confirm === 'none';

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarHideOnKeyboard: true,
        tabBarActiveTintColor: c.primary,
        tabBarInactiveTintColor: c.textMuted,
        tabBarStyle: { backgroundColor: c.surface, borderTopColor: c.border },
        tabBarBadgeStyle: { backgroundColor: c.stNeedsYou },
      }}
    >
      <Tabs.Screen
        name="(home)"
        options={{
          title: 'Agents',
          tabBarIcon: ({ color, size }) => <Ionicons name="grid-outline" color={String(color)} size={size} />,
          tabBarBadge: needsYou || undefined,
        }}
      />
      <Tabs.Screen
        name="chat"
        options={{
          title: 'Chat',
          tabBarIcon: ({ color, size }) => <Ionicons name="chatbubbles-outline" color={String(color)} size={size} />,
          tabBarBadge: unread ? (unread > 99 ? '99+' : unread) : undefined,
        }}
      />
      <Tabs.Screen
        name="tasks"
        options={{ title: 'Tasks', tabBarIcon: ({ color, size }) => <Ionicons name="checkbox-outline" color={String(color)} size={size} /> }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color, size }) => <Ionicons name="settings-outline" color={String(color)} size={size} />,
          tabBarBadge: settingsDot ? '' : undefined,
          tabBarBadgeStyle: { backgroundColor: c.stNeedsYou, minWidth: 10, maxHeight: 10, borderRadius: 5, lineHeight: 10 },
        }}
      />
    </Tabs>
  );
}
