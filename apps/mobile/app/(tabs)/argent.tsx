import { useState } from 'react';
import { ScrollView, View, Text } from 'react-native';
import { formatEUR, type Scenario, type Horizon } from '@bob/core';
import { useTheme } from '../../src/theme';
import { useCashflow, useExpenses } from '../../src/data/hooks';
import { GradientHeader, Card, MoneyText, SectionHeader, Chip, Badge, font } from '../../src/components/ui';

const HORIZONS: Horizon[] = [7, 30, 60, 90];
const SCENARIOS: Scenario[] = ['optimiste', 'realiste', 'prudent'];

export default function Argent() {
  const { colors, semantic } = useTheme();
  const [scenario, setScenario] = useState<Scenario>('realiste');
  const [horizon, setHorizon] = useState<Horizon>(30);
  const { data } = useCashflow(scenario, horizon);
  const { data: expenses } = useExpenses();
  const toPay = (expenses ?? []).filter((e) => e.status === 'to_pay');

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ paddingBottom: 120 }}>
      <GradientHeader>
        <Text style={[font('eyebrow'), { color: 'rgba(255,255,255,0.7)' }]}>TRÉSORERIE</Text>
        <Text style={[font('pageTitle'), { color: '#fff', marginTop: 4 }]}>Argent</Text>
        {data ? (
          <View style={{ marginTop: 14 }}>
            <Text style={[font('meta'), { color: 'rgba(255,255,255,0.7)' }]}>Tu peux te verser</Text>
            <Text style={[font('heroNum'), { color: '#fff', fontVariant: ['tabular-nums'] }]}>{formatEUR(data.payout)}</Text>
          </View>
        ) : null}
      </GradientHeader>

      <View style={{ padding: 20, gap: 18 }}>
        <View>
          <SectionHeader title="Prévision de trésorerie" />
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 10 }}>
            {HORIZONS.map((h) => (
              <Chip key={h} label={`${h} j`} active={horizon === h} onPress={() => setHorizon(h)} />
            ))}
          </View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {SCENARIOS.map((s) => (
              <Chip key={s} label={s.charAt(0).toUpperCase() + s.slice(1)} active={scenario === s} onPress={() => setScenario(s)} />
            ))}
          </View>
        </View>

        <Card elevation="e2">
          <Text style={[font('meta'), { color: colors.slate400 }]}>Disponible prévisionnel ({horizon} j)</Text>
          {data ? <MoneyText cents={data.available} variant="hero" /> : <Text>…</Text>}
          {data?.risk ? (
            <View style={{ marginTop: 10 }}>
              <Badge label="Risque de tension" tone="danger" />
            </View>
          ) : (
            <View style={{ marginTop: 10 }}>
              <Badge label="Trésorerie saine" tone="success" />
            </View>
          )}
          <Text style={[font('sub'), { color: colors.slate500, marginTop: 12 }]}>
            Le solde bancaire « ment » : Bob déduit la TVA à reverser et les charges à venir pour te donner le vrai disponible.
          </Text>
        </Card>

        {toPay.length > 0 ? (
          <View>
            <SectionHeader title="Dépenses à venir" />
            {toPay.map((e) => (
              <Card key={e.id} style={{ marginBottom: 8 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <View style={{ flex: 1 }}>
                    <Text style={[font('cardTitle'), { color: colors.ink900 }]}>{e.supplierName}</Text>
                    <Text style={[font('meta'), { color: colors.slate400 }]}>
                      {e.documentDate} · {e.category}
                    </Text>
                  </View>
                  <Text style={[font('cardTitle'), { color: colors.ink900 }]}>{formatEUR(e.totalTtcCents)}</Text>
                </View>
              </Card>
            ))}
          </View>
        ) : null}
      </View>
    </ScrollView>
  );
}
