import { ScrollView, View, Text, Pressable } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../src/theme';
import { useCustomers } from '../../src/data/hooks';
import { Card, Badge, ScoreBar, MoneyText, Button, SectionHeader, font } from '../../src/components/ui';

export default function ClientDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors, semantic } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { data } = useCustomers();
  const customer = (data ?? []).find((c) => c.id === id) ?? null;

  const einvoice =
    customer?.type === 'b2g'
      ? { label: 'Public · Chorus Pro', tone: 'b2g' as const }
      : customer?.type === 'b2b'
        ? { label: 'Entreprise · PDP', tone: 'b2b' as const }
        : { label: 'Particulier · e-reporting', tone: 'particulier' as const };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ paddingBottom: 40 }}>
      <View style={{ paddingTop: insets.top + 8, paddingHorizontal: 20, paddingBottom: 8 }}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Retour" style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Ionicons name="chevron-back" size={22} color={colors.ink800} />
          <Text style={[font('body'), { color: colors.ink800 }]}>Clients</Text>
        </Pressable>
      </View>

      {!customer ? (
        <View style={{ padding: 20 }}>
          <Text style={[font('body'), { color: colors.slate500 }]}>Client introuvable.</Text>
        </View>
      ) : (
        <View style={{ padding: 20, gap: 16 }}>
          <View style={{ alignItems: 'center', gap: 8 }}>
            <View style={{ width: 72, height: 72, borderRadius: 22, backgroundColor: colors.ink600, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={[font('pageTitle'), { color: '#fff' }]}>
                {customer.name.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('')}
              </Text>
            </View>
            <Text style={[font('screenH1'), { color: colors.ink900 }]}>{customer.name}</Text>
            <Badge label={einvoice.label} tone={einvoice.tone} />
          </View>

          <Card>
            <Text style={[font('meta'), { color: colors.slate400, marginBottom: 6 }]}>Score de paiement</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <Text style={[font('bigNum'), { color: colors.ink900 }]}>{customer.score}/100</Text>
              <View style={{ flex: 1 }}>
                <ScoreBar value={customer.score} />
              </View>
            </View>
          </Card>

          <Card>
            <SectionHeader title="Encours" />
            <MoneyText cents={customer.outstanding} variant="big" color={customer.outstanding > 0 ? semantic.danger : semantic.success} />
          </Card>

          <Button title="Créer un devis" onPress={() => router.push('/devis/new')} />
        </View>
      )}
    </ScrollView>
  );
}
