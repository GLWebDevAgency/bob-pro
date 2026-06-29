import { ScrollView, View, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../src/theme';
import { Card, Chip, Badge, font } from '../../src/components/ui';

const SUGGESTIONS = [
  'Combien je peux me payer ?',
  'Prépare une relance pour Martin',
  'Mon dossier comptable de juin',
  'Diagnostic conformité 2026',
];

export default function Assistant() {
  const { colors, semantic } = useTheme();
  const insets = useSafeAreaInsets();
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
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 20, gap: 14 }}>
        <Card>
          <Badge label="Assistant IA" tone="ai" />
          <Text style={[font('body'), { color: colors.ink800, marginTop: 10 }]}>
            Salut, moi c&apos;est Bob. Je gère ta paperasse pendant que tu bosses. Demande-moi ce que tu veux —
            je prépare, tu valides.
          </Text>
        </Card>
        <Text style={[font('meta'), { color: colors.slate400 }]}>Suggestions</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {SUGGESTIONS.map((s) => (
            <Chip key={s} label={s} />
          ))}
        </View>
        <Card style={{ borderStyle: 'dashed' }}>
          <Text style={[font('sub'), { color: colors.slate500 }]}>
            Le moteur agentique de Bob (routeur Claude/GLM, outils = use cases, garde-fous anti-hallucination)
            est branché à l&apos;étape suivante. En attendant, toutes les actions restent accessibles manuellement.
          </Text>
        </Card>
      </ScrollView>
    </View>
  );
}
