import { ScrollView, View, Text, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { formatEUR, type PlanTier } from '@bob/core';
import { useTheme } from '../src/theme';
import { useSubscription, useDiagnostic, useStartCheckout, useBillingPortal } from '../src/data/hooks';
import { useAuth } from '../src/data/auth';
import { Card, Badge, Button, SectionHeader, font } from '../src/components/ui';

export default function Compte() {
  const { colors, theme, semantic } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { data } = useSubscription();
  const { data: diag } = useDiagnostic();
  const checkout = useStartCheckout();
  const portal = useBillingPortal();
  const { enabled: authEnabled, signOut } = useAuth();

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

        <SectionHeader title="Conformité 2026" />
        <Card>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
            <View style={{ flex: 1 }}>
              <Text style={[font('cardTitle'), { color: colors.ink900 }]}>Diagnostic de conformité</Text>
              <Text style={[font('sub'), { color: colors.slate400, marginTop: 2 }]}>
                Facture électronique, TVA, mentions légales — ta préparation à la réforme.
              </Text>
            </View>
            {diag ? (
              <Text
                style={[
                  font('bigNum'),
                  { color: diag.band === 'green' ? semantic.success : diag.band === 'orange' ? semantic.warning : semantic.danger },
                ]}
              >
                {diag.score}
              </Text>
            ) : null}
          </View>
          <View style={{ marginTop: 12, gap: 8 }}>
            <Button title="Voir mon diagnostic" onPress={() => router.push('/diagnostic')} />
            <Button title="Configurer mon métier" variant="secondary" onPress={() => router.push('/onboarding')} />
          </View>
        </Card>

        <SectionHeader title="Ton offre" />
        {(data?.catalog ?? []).map((p) => {
          const current = p.tier === data?.tier;
          return (
            <Card key={p.tier} style={current ? { borderColor: theme.ink2, borderWidth: 2 } : undefined}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <View style={{ flex: 1 }}>
                  <Text style={[font('cardTitle'), { color: colors.ink900 }]}>{p.label}</Text>
                  <Text style={[font('sub'), { color: colors.slate400 }]}>{p.tagline}</Text>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={[font('bigNum'), { color: colors.ink900 }]}>{p.priceCents === 0 ? 'Gratuit' : formatEUR(p.priceCents)}</Text>
                  {p.priceCents > 0 ? <Text style={[font('meta'), { color: colors.slate400 }]}>/ mois</Text> : null}
                  {p.annualMonthlyCents > 0 && p.annualMonthlyCents < p.priceCents ? (
                    <Text style={[font('meta'), { color: semantic.success }]}>{formatEUR(p.annualMonthlyCents)}/mois en annuel</Text>
                  ) : null}
                </View>
              </View>
              {current ? (
                <View style={{ marginTop: 10 }}>
                  <Badge label={`Offre actuelle · ${data?.status}`} tone="success" />
                </View>
              ) : p.tier !== 'free' ? (
                <View style={{ marginTop: 12 }}>
                  <Button
                    title={checkout.isPending ? 'Redirection…' : `Passer à ${p.label}`}
                    variant="secondary"
                    disabled={checkout.isPending}
                    onPress={() => checkout.mutate(p.tier as PlanTier)}
                  />
                </View>
              ) : null}
            </Card>
          );
        })}

        <Button
          title={portal.isPending ? 'Ouverture…' : 'Gérer mon abonnement'}
          variant="secondary"
          disabled={portal.isPending}
          onPress={() => portal.mutate()}
        />
        <Text style={[font('meta'), { color: colors.slate400, textAlign: 'center', marginTop: 4 }]}>
          Paiement sécurisé via Stripe · résiliable à tout moment.
        </Text>

        {authEnabled ? (
          <View style={{ marginTop: 8 }}>
            <Button title="Se déconnecter" variant="secondary" onPress={() => void signOut()} />
          </View>
        ) : null}
      </View>
    </ScrollView>
  );
}
