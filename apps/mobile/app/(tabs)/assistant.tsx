import { useMemo, useRef, useState } from 'react';
import { View, Text, TextInput, Pressable, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import type { AgentRun, PendingAction } from '@bob/ai';
import { useTheme } from '../../src/theme';
import { useBobClient } from '../../src/data/client';
import { useSubscription } from '../../src/data/hooks';
import { makeBobAgent } from '../../src/data/bob';
import { getAutonomy } from '../../src/data/settings';
import { Card, Button, Badge, Chip, font } from '../../src/components/ui';

interface ChatItem {
  id: string;
  role: 'user' | 'bob';
  text: string;
  run?: AgentRun;
  pending?: PendingAction;
}

const SUGGESTIONS = ['Encaisse la facture 2026-014', 'Mes factures impayées', 'Combien je peux me verser ?', 'Prépare une relance'];

export default function Assistant() {
  const { colors, semantic, theme } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const client = useBobClient();
  const qc = useQueryClient();
  const agent = useMemo(() => makeBobAgent(client), [client]);
  const { data: sub } = useSubscription();
  const entitled = (sub?.features ?? []).includes('ai_assistant');

  const [items, setItems] = useState<ChatItem[]>([
    { id: 'intro', role: 'bob', text: "Salut, moi c'est Bob. Dis-moi par exemple « encaisse la facture 2026-014 » — je m'en occupe." },
  ]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const counter = useRef(0);
  const nextId = (): string => {
    counter.current += 1;
    return `m-${counter.current}`;
  };

  const refreshAfterAction = (): void => {
    void qc.invalidateQueries({ queryKey: ['invoices'] });
    void qc.invalidateQueries({ queryKey: ['cashflow'] });
  };

  const pushBob = (run: AgentRun): void => {
    setItems((prev) => [
      ...prev,
      { id: nextId(), role: 'bob', text: run.card.body, run, pending: run.kind === 'proposed' ? run.pending : undefined },
    ]);
    if (run.kind === 'done') refreshAfterAction();
  };

  const ask = async (text: string): Promise<void> => {
    const message = text.trim();
    if (!message || busy) return;
    setInput('');
    setItems((prev) => [...prev, { id: nextId(), role: 'user', text: message }]);
    setBusy(true);
    const autonomy = await getAutonomy();
    const r = await agent.ask(message, { autonomy });
    setBusy(false);
    if (r.ok) pushBob(r.value);
    else setItems((prev) => [...prev, { id: nextId(), role: 'bob', text: "Désolé, je n'ai pas pu traiter ça." }]);
  };

  const confirm = async (item: ChatItem): Promise<void> => {
    if (!item.pending || busy) return;
    setBusy(true);
    const r = await agent.confirm(item.pending);
    setBusy(false);
    // L'action proposée est consommée (on retire le bouton de confirmation).
    setItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, pending: undefined } : it)));
    if (r.ok) pushBob(r.value);
    else setItems((prev) => [...prev, { id: nextId(), role: 'bob', text: "L'action a échoué. Réessaie." }]);
  };

  const cancel = (item: ChatItem): void => {
    setItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, pending: undefined } : it)));
  };

  if (!entitled) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, padding: 20, paddingTop: insets.top + 40, gap: 16 }}>
        <View style={{ width: 56, height: 56, borderRadius: 18, backgroundColor: semantic.ai, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ color: '#fff', fontSize: 28 }}>★</Text>
        </View>
        <Text style={[font('pageTitle'), { color: colors.ink900 }]}>Bob, ton copilote</Text>
        <Text style={[font('body'), { color: colors.slate500 }]}>
          Bob exécute tes tâches pour toi — encaisser une facture, préparer une relance, suivre ta trésorerie — en langage
          naturel. Inclus à partir de l’offre Pro. Sans lui, tu fais tout à la main (l’app reste 100 % fonctionnelle).
        </Text>
        <Button title="Voir les offres" onPress={() => router.push('/compte')} />
      </View>
    );
  }

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
                    {it.run.kind === 'done' ? <Badge label="exécuté" tone="success" /> : null}
                  </View>
                ) : null}
                {it.run ? <Text style={[font('cardTitle'), { color: colors.ink900, marginBottom: 4 }]}>{it.run.card.title}</Text> : null}
                <Text style={[font('body'), { color: colors.ink800 }]}>{it.text}</Text>
                {it.pending ? (
                  <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
                    <View style={{ flex: 1 }}>
                      <Button title="Confirmer" onPress={() => void confirm(it)} disabled={busy} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Button title="Annuler" variant="secondary" onPress={() => cancel(it)} disabled={busy} />
                    </View>
                  </View>
                ) : null}
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
