import { useMemo, useRef, useState } from 'react';
import { View, Text, TextInput, Pressable, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import type { AgentRun } from '@bob/ai';
import { useTheme } from '../../src/theme';
import { useBobClient } from '../../src/data/client';
import { makeBobAgent } from '../../src/data/bob';
import { Card, Badge, Chip, font } from '../../src/components/ui';

interface ChatItem {
  id: string;
  role: 'user' | 'bob';
  text: string;
  run?: AgentRun;
}

const SUGGESTIONS = ['Combien je peux me verser ?', 'Prépare une relance', 'Bonjour Bob'];

export default function Assistant() {
  const { colors, semantic, theme } = useTheme();
  const insets = useSafeAreaInsets();
  const client = useBobClient();
  const agent = useMemo(() => makeBobAgent(client), [client]);

  const [items, setItems] = useState<ChatItem[]>([
    { id: 'intro', role: 'bob', text: "Salut, moi c'est Bob. Demande-moi ce que tu veux — je prépare, tu valides." },
  ]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const counter = useRef(0);
  const nextId = (): string => {
    counter.current += 1;
    return `m-${counter.current}`;
  };

  const ask = async (text: string): Promise<void> => {
    const message = text.trim();
    if (!message || busy) return;
    setInput('');
    setItems((prev) => [...prev, { id: nextId(), role: 'user', text: message }]);
    setBusy(true);
    const r = await agent.ask(message);
    setBusy(false);
    setItems((prev) => [
      ...prev,
      r.ok
        ? { id: nextId(), role: 'bob', text: r.value.card.body, run: r.value }
        : { id: nextId(), role: 'bob', text: "Désolé, je n'ai pas pu traiter ça." },
    ]);
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ paddingTop: insets.top + 14, paddingHorizontal: 20, paddingBottom: 14, backgroundColor: semantic.aiInk, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View style={{ width: 40, height: 40, borderRadius: 14, backgroundColor: semantic.ai, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ color: '#fff', fontSize: 20 }}>★</Text>
        </View>
        <View>
          <Text style={[font('cardTitle'), { color: '#fff' }]}>Bob</Text>
          <Text style={[font('meta'), { color: '#C9C2EE' }]}>• en ligne</Text>
        </View>
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 12 }}>
        {items.map((it) =>
          it.role === 'user' ? (
            <View key={it.id} style={{ alignSelf: 'flex-end', backgroundColor: theme.ink2, borderRadius: 16, padding: 12, maxWidth: '85%' }}>
              <Text style={[font('body'), { color: '#fff' }]}>{it.text}</Text>
            </View>
          ) : (
            <View key={it.id} style={{ alignSelf: 'flex-start', maxWidth: '92%' }}>
              <Card>
                {it.run ? (
                  <View style={{ marginBottom: 8, flexDirection: 'row', gap: 8 }}>
                    <Badge label={`plan · ${it.run.model}`} tone="ai" />
                  </View>
                ) : null}
                {it.run ? <Text style={[font('cardTitle'), { color: colors.ink900, marginBottom: 4 }]}>{it.run.card.title}</Text> : null}
                <Text style={[font('body'), { color: colors.ink800 }]}>{it.text}</Text>
              </Card>
            </View>
          ),
        )}
        {busy ? <Text style={[font('sub'), { color: colors.slate400 }]}>Bob réfléchit…</Text> : null}
        {items.length <= 1 ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
            {SUGGESTIONS.map((s) => (
              <Chip key={s} label={s} onPress={() => void ask(s)} />
            ))}
          </View>
        ) : null}
      </ScrollView>

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, paddingBottom: insets.bottom + 12, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.surface }}>
        <TextInput
          value={input}
          onChangeText={setInput}
          placeholder="Demande à Bob…"
          placeholderTextColor={colors.slate300}
          style={{ flex: 1, backgroundColor: colors.lineSoft, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, color: colors.ink800 }}
          onSubmitEditing={() => void ask(input)}
          returnKeyType="send"
        />
        <Pressable onPress={() => void ask(input)} accessibilityRole="button" accessibilityLabel="Envoyer" style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: semantic.ai, alignItems: 'center', justifyContent: 'center' }}>
          <Ionicons name="arrow-up" size={22} color="#fff" />
        </Pressable>
      </View>
    </View>
  );
}
