import { ScrollView, View, Text, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { formatEUR } from '@bob/core';
import { useTheme } from '../../src/theme';
import { useCashflow, useCustomers, useSubscription } from '../../src/data/hooks';
import { GradientHeader, Card, MoneyText, SectionHeader, StatTile, font } from '../../src/components/ui';
import { greeting, todaySubtitle, footerLine } from '../../src/copy';

export default function Aujourdhui() {
  const { personality, colors, semantic } = useTheme();
  const router = useRouter();
  const cashflow = useCashflow('realiste', 30);
  const customers = useCustomers();
  const { data: sub } = useSubscription();
  const features = sub?.features ?? [];
  const canAccounting = features.includes('accounting_foundation');
  const canClose = features.includes('accounting_operations');

  const aSurveiller = (customers.data ?? []).filter((c) => c.outstanding > 0);
  const totalDu = aSurveiller.reduce((sum, c) => sum + c.outstanding, 0);

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ paddingBottom: 120 }}>
      <GradientHeader>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={[font('eyebrow'), { color: 'rgba(255,255,255,0.7)' }]}>MERCIER PLOMBERIE</Text>
          <Pressable onPress={() => router.push('/compte')} accessibilityRole="button" accessibilityLabel="Mon compte">
            <Ionicons name="person-circle-outline" size={28} color="rgba(255,255,255,0.9)" />
          </Pressable>
        </View>
        <Text style={[font('pageTitle'), { color: '#fff', marginTop: 4 }]}>{greeting(personality, 'Julien')}</Text>
        <Text style={[font('body'), { color: 'rgba(255,255,255,0.8)', marginTop: 4 }]}>
          {todaySubtitle(personality, aSurveiller.length)}
        </Text>
        <View style={{ marginTop: 16, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 16, padding: 16 }}>
          <Text style={[font('meta'), { color: 'rgba(255,255,255,0.7)' }]}>Dispo réel aujourd&apos;hui</Text>
          {cashflow.data ? (
            <Text style={[font('heroNum'), { color: '#fff', fontVariant: ['tabular-nums'] }]}>{formatEUR(cashflow.data.available)}</Text>
          ) : (
            <Text style={{ color: '#fff' }}>…</Text>
          )}
          {cashflow.data ? (
            <View style={{ alignSelf: 'flex-start', backgroundColor: semantic.successOnDark, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6, marginTop: 10 }}>
              <Text style={[font('label'), { color: '#06311f' }]}>Te verser ~ {formatEUR(cashflow.data.payout)}</Text>
            </View>
          ) : null}
        </View>
      </GradientHeader>

      <View style={{ padding: 20, gap: 20 }}>
        <View>
          <SectionHeader title="À régler aujourd'hui" />
          {aSurveiller.length === 0 ? (
            <Card>
              <Text style={[font('body'), { color: colors.slate500 }]}>Tout est à jour. Rien à relancer.</Text>
            </Card>
          ) : (
            <View style={{ gap: 10 }}>
              {aSurveiller.map((c) => (
                <Card key={c.id}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                    <View style={{ flex: 1 }}>
                      <Text style={[font('cardTitle'), { color: colors.ink800 }]}>{c.name}</Text>
                      <Text style={[font('sub'), { color: colors.slate400, marginTop: 2 }]}>Encours à suivre</Text>
                    </View>
                    <MoneyText cents={c.outstanding} color={semantic.danger} />
                  </View>
                </Card>
              ))}
            </View>
          )}
        </View>

        <View>
          <SectionHeader title="En un coup d'œil" />
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <StatTile label="Dispo réel" onPress={() => router.push('/argent')}>
              {cashflow.data ? <MoneyText cents={cashflow.data.available} variant="big" /> : <Text>…</Text>}
            </StatTile>
            <StatTile label="Dû par les clients">
              <MoneyText cents={totalDu} variant="big" color={semantic.danger} />
            </StatTile>
          </View>
        </View>

        <View>
          <SectionHeader title="Ventes" />
          <Pressable onPress={() => router.push('/ventes')} accessibilityRole="button" accessibilityLabel="Devis et factures">
            <Card>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 }}>
                  <Ionicons name="document-text-outline" size={22} color={colors.ink600} />
                  <View style={{ flex: 1 }}>
                    <Text style={[font('cardTitle'), { color: colors.ink900 }]}>Devis &amp; Factures</Text>
                    <Text style={[font('sub'), { color: colors.slate400, marginTop: 2 }]}>Suivre et agir sur tes documents</Text>
                  </View>
                </View>
                <Ionicons name="chevron-forward" size={20} color={colors.slate400} />
              </View>
            </Card>
          </Pressable>
        </View>

        {canAccounting ? (
          <View>
            <SectionHeader title="Comptabilité" />
            <Pressable onPress={() => router.push('/comptabilite')} accessibilityRole="button" accessibilityLabel="Journal comptable">
              <Card>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 }}>
                    <Ionicons name="book-outline" size={22} color={colors.ink600} />
                    <View style={{ flex: 1 }}>
                      <Text style={[font('cardTitle'), { color: colors.ink900 }]}>Journal / Grand livre</Text>
                      <Text style={[font('sub'), { color: colors.slate400, marginTop: 2 }]}>Chaque écriture, vérifiable</Text>
                    </View>
                  </View>
                  <Ionicons name="chevron-forward" size={20} color={colors.slate400} />
                </View>
              </Card>
            </Pressable>
            {canClose ? (
              <Pressable
                onPress={() => router.push('/cloture')}
                accessibilityRole="button"
                accessibilityLabel="Clôture du mois"
                style={{ marginTop: 10 }}
              >
                <Card>
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 }}>
                      <Ionicons name="calendar-clear-outline" size={22} color={colors.ink600} />
                      <View style={{ flex: 1 }}>
                        <Text style={[font('cardTitle'), { color: colors.ink900 }]}>Clôture du mois</Text>
                        <Text style={[font('sub'), { color: colors.slate400, marginTop: 2 }]}>Préparer le mois pour le comptable</Text>
                      </View>
                    </View>
                    <Ionicons name="chevron-forward" size={20} color={colors.slate400} />
                  </View>
                </Card>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        <Text style={[font('sub'), { color: colors.slate400, textAlign: 'center' }]}>{footerLine(personality)}</Text>
      </View>
    </ScrollView>
  );
}
