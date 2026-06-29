import { ScrollView, View, Text, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { formatEUR } from '@bob/core';
import { useTheme } from '../src/theme';
import { useSubscription } from '../src/data/hooks';
import { Card, Badge, Button, SectionHeader, font } from '../src/components/ui';

export default function Compte() {
  const { colors, theme } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { data } = useSubscription();

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ paddingBottom: 40 }}>
      <View style={{ paddingTop: insets.top + 8, paddingHorizontal: 20, paddingBottom: 8 }}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Retour" style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Ionicons name="chevron-back" size={22} color={colors.ink800} />
          <Text style={[font('body'), { color: colors.ink800 }]}>Retour</Text>
        </Pressable>
      </View>

      <View style={{ padding: 20, gap: 16 }}>
        <Text style={[font('pageTitle'), { color: colors.ink900 }]}>Compte & abonnement</Text>

        <Card>
          <Text style={[font('cardTitle'), { color: colors.ink800 }]}>Mercier Plomberie</Text>
          <Text style={[font('sub'), { color: colors.slate400, marginTop: 2 }]}>EI · SIRET 732 829 320 00074 · RM 92</Text>
        </Card>

        <SectionHeader title="Ton offre" />
        {(data?.catalog ?? []).map((p) => {
          const current = p.tier === data?.tier;
          return (
            <Card key={p.tier} style={current ? { borderColor: theme.ink2, borderWidth: 2 } : undefined}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <View>
                  <Text style={[font('cardTitle'), { color: colors.ink900 }]}>{p.label}</Text>
                  <Text style={[font('sub'), { color: colors.slate400 }]}>{p.features.length} fonctionnalités incluses</Text>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={[font('bigNum'), { color: colors.ink900 }]}>{formatEUR(p.priceCents)}</Text>
                  <Text style={[font('meta'), { color: colors.slate400 }]}>/ mois</Text>
                </View>
              </View>
              {current ? (
                <View style={{ marginTop: 10 }}>
                  <Badge label={`Offre actuelle · ${data?.status}`} tone="success" />
                </View>
              ) : (
                <View style={{ marginTop: 12 }}>
                  <Button title={`Passer à ${p.label}`} variant="secondary" />
                </View>
              )}
            </Card>
          );
        })}

        <Text style={[font('meta'), { color: colors.slate400, textAlign: 'center', marginTop: 4 }]}>
          Paiement sécurisé via Stripe · résiliable à tout moment.
        </Text>
      </View>
    </ScrollView>
  );
}
