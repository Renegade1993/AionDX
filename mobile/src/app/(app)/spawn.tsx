import { router, Stack } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { ConfirmUnavailableLine, useSensitive } from '@/components/confirm';
import { Button } from '@/components/ui/Button';
import { Card, EmptyState, Icon, IconButton, SkeletonList } from '@/components/ui/primitives';
import { Text } from '@/components/ui/Text';
import { TextField } from '@/components/ui/TextField';
import { useAgentActions, useAssistants, useRunState } from '@/lib/api/hooks';
import type { Assistant } from '@/lib/api/types';
import { describeActionError } from '@/lib/api/errors';
import { useIsOffline } from '@/state/healthStore';
import { toast } from '@/state/toastStore';
import { radius, space, touchTarget, useColors } from '@/theme';

/** D3 — Spawn agent: pick assistant, then name it (SPEC §6.4). */
export default function SpawnAgent() {
  const c = useColors();
  const assistants = useAssistants();
  const agents = useRunState().data?.agents ?? [];
  const { spawn } = useAgentActions();
  const sensitive = useSensitive();
  const offline = useIsOffline();
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Assistant | null>(null);
  const [name, setName] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = assistants.data ?? [];
    if (!q) return list;
    return list.filter((a) => [a.name, a.description ?? '', a.backend].some((s) => s.toLowerCase().includes(q)));
  }, [assistants.data, query]);

  const trimmed = name.trim();
  const nameTaken = agents.some((a) => a.name.toLowerCase() === trimmed.toLowerCase());

  const submit = () => {
    if (!picked || !trimmed || nameTaken) return;
    spawn.mutate(
      { assistantId: picked.assistantId, name: trimmed },
      {
        onSuccess: () => {
          toast(`${trimmed} is starting`, 'success');
          router.back();
        },
        // A cancelled Face ID / passcode prompt (spawn is sensitive, contract §5.1) says nothing.
        onError: (e) => {
          const text = describeActionError(e, "Couldn't spawn agent");
          if (text) toast(text, 'error');
        },
      },
    );
  };

  const inputStyle = [styles.input, { backgroundColor: c.surfaceAlt, color: c.text }];

  if (picked) {
    return (
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <Stack.Screen options={{ title: picked.name, headerLeft: () => <IconButton icon="chevron-back" label="Back to assistants" onPress={() => setPicked(null)} /> }} />
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {picked.description ? <Text>{picked.description}</Text> : null}
          {picked.backend ? <Text variant="caption" color="textMuted">Runs on {picked.backend}</Text> : null}
          <View style={{ gap: space.xs }}>
            <Text variant="headline">Name</Text>
            <TextField
              value={name}
              onChangeText={setName}
              placeholder={`${picked.name} 2`}
              placeholderTextColor={c.textMuted}
              style={inputStyle}
              autoFocus
              maxLength={40}
              accessibilityLabel="Agent name"
              returnKeyType="done"
              onSubmitEditing={submit}
            />
            {nameTaken ? <Text variant="caption" color="danger">An agent with this name already exists in the team.</Text> : null}
          </View>
          {/* Spawning is sensitive (§15.1.1): the glyph shows it confirms; unavailable → disabled with the reason. */}
          <Button
            title="Spawn"
            icon={sensitive.icon}
            accessibilityHint={sensitive.accessibilityHint}
            onPress={submit}
            loading={spawn.isPending}
            disabled={!trimmed || nameTaken || offline || !sensitive.available}
            style={sensitive.style}
          />
          <ConfirmUnavailableLine state={sensitive.state} />
        </ScrollView>
      </KeyboardAvoidingView>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title: 'Spawn an agent', headerLeft: undefined }} />
      <View style={styles.search}>
        <Icon name="search" color="textMuted" />
        <TextField
          value={query}
          onChangeText={setQuery}
          placeholder="Search assistants"
          placeholderTextColor={c.textMuted}
          style={[inputStyle, { flex: 1 }]}
          accessibilityLabel="Search assistants"
        />
      </View>
      {assistants.isPending ? (
        <SkeletonList />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(a) => a.assistantId}
          contentContainerStyle={styles.list}
          ListEmptyComponent={<EmptyState title="No assistants match." />}
          renderItem={({ item }) => (
            <Pressable onPress={() => setPicked(item)} accessibilityRole="button" accessibilityLabel={`${item.name}. ${item.description ?? ''}`}>
              <Card>
                <Text variant="headline">{item.name}</Text>
                {item.description ? (
                  <Text color="textMuted" numberOfLines={2}>
                    {item.description}
                  </Text>
                ) : null}
                {item.backend ? <Text variant="caption" color="textMuted">{item.backend}</Text> : null}
              </Card>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.gutter, gap: space.lg },
  search: { flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.gutter, paddingBottom: 0 },
  input: { minHeight: touchTarget, borderRadius: radius.card, paddingHorizontal: space.md, fontSize: 15 },
  list: { padding: space.gutter, gap: space.md },
});
