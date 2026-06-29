import { useState } from 'react';
import { ScrollView, View, Text } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TRADE_PROFILES, resolveTradeConfig, type Trade } from '@bob/core';
import { useTheme } from '../src/theme';
import { Card, Chip, Button, SectionHeader, font } from '../src/components/ui';

const TIER_LABEL: Record<string, string> = { free: 'Gratuit', solo: 'Solo', pro: 'Pro', business: 'Business' };

export default function Onboarding() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const trades = Object.values(TRADE_PROFILES);
  const [trade, setTrade] = useState<Trade | null>(null);
  const selected = trade ? resolveTradeConfig(trade, 'free') : null;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ paddingTop: insets.top + 20, paddingBottom: 40, paddingHorizontal: 20, gap: 16 }}
    >
      <Text style={[font('pageTitle'), { color: colors.ink900 }]}>Bienvenue chez Bob</Text>
      <Text style={[font('body'), { color: colors.slate500 }]}>
        Ton bureau pro, dans ta poche. Bob s&apos;occupe de la paperasse — toi, tu bosses.
      </Text>

      <SectionHeader title="Ton métier" />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {trades.map((t) => (
          <Chip key={t.trade} label={t.label} active={trade === t.trade} onPress={() => setTrade(t.trade)} />
        ))}
      </View>

      {selected ? (
        <Card>
          <Text style={[font('cardTitle'), { color: colors.ink900 }]}>Adapté pour {selected.label}</Text>
          <Text style={[font('sub'), { color: colors.slate400, marginTop: 2 }]}>
            Tes modules — actifs dès le gratuit, le reste se débloque en montant d’offre :
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
            {selected.modules.map((m) => (
              <Chip key={m.key} label={m.active ? m.label : `${m.label} · ${TIER_LABEL[m.unlockTier]}`} active={m.active} />
            ))}
          </View>
        </Card>
      ) : null}

      <View style={{ height: 8 }} />
      <Button title="Faire le diagnostic 2026" onPress={() => router.push('/diagnostic')} disabled={!selected} />
      <Button title="Entrer dans l'app" variant="secondary" onPress={() => router.back()} />
    </ScrollView>
  );
}
