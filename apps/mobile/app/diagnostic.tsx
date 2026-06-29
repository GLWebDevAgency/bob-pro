import { ScrollView, View, Text, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../src/theme';
import { useDiagnostic } from '../src/data/hooks';
import { Card, Badge, SectionHeader, font } from '../src/components/ui';

export default function Diagnostic() {
  const { colors, semantic } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { data } = useDiagnostic();
  const bandColor =
    data?.band === 'green' ? semantic.success : data?.band === 'orange' ? semantic.warning : semantic.danger;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ paddingBottom: 40 }}>
      <View style={{ paddingTop: insets.top + 8, paddingHorizontal: 20, paddingBottom: 8 }}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Retour" style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Ionicons name="chevron-back" size={22} color={colors.ink800} />
          <Text style={[font('body'), { color: colors.ink800 }]}>Retour</Text>
        </Pressable>
      </View>

      <View style={{ padding: 20, gap: 16 }}>
        <Text style={[font('pageTitle'), { color: colors.ink900 }]}>Diagnostic conformité 2026</Text>

        <Card elevation="e2">
          <Text style={[font('meta'), { color: colors.slate400 }]}>Ton score de conformité</Text>
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 6, marginTop: 4 }}>
            <Text style={[font('heroNum'), { color: bandColor }]}>{data?.score ?? '—'}</Text>
            <Text style={[font('bigNum'), { color: colors.slate400, marginBottom: 8 }]}>/ 100</Text>
          </View>
        </Card>

        <SectionHeader title="Échéances clés" />
        {(data?.calendar ?? []).map((c) => (
          <Card key={c.date}>
            <Badge label={c.date} tone="b2g" />
            <Text style={[font('sub'), { color: colors.ink800, marginTop: 8 }]}>{c.label}</Text>
          </Card>
        ))}

        <SectionHeader title="Tes actions" />
        {(data?.items ?? []).map((it) => (
          <Card key={it.id}>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              {it.status === 'ok' ? (
                <Ionicons name="checkmark-circle" size={22} color={semantic.success} />
              ) : it.status === 'todo' ? (
                <Ionicons name="alert-circle" size={22} color={it.severity === 'critical' ? semantic.danger : semantic.warning} />
              ) : (
                <Ionicons name="remove-circle-outline" size={22} color={colors.slate300} />
              )}
              <View style={{ flex: 1 }}>
                <Text style={[font('cardTitle'), { color: colors.ink900 }]}>{it.label}</Text>
                <Text style={[font('sub'), { color: colors.slate500, marginTop: 4 }]}>{it.help}</Text>
                {it.dueDate ? (
                  <Text style={[font('meta'), { color: semantic.warning, marginTop: 4 }]}>Échéance : {it.dueDate}</Text>
                ) : null}
              </View>
            </View>
          </Card>
        ))}
      </View>
    </ScrollView>
  );
}
