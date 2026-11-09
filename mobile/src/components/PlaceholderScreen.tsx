import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

/** Stand-in for screens awaiting the UI/UX design spec. */
export function PlaceholderScreen({ title, note, children }: { title: string; note?: string; children?: ReactNode }) {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>{title}</Text>
      {note ? <Text style={styles.note}>{note}</Text> : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  title: { fontSize: 20, fontWeight: '600' },
  note: { fontSize: 14, opacity: 0.6, textAlign: 'center' },
});
