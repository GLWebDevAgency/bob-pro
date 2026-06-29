import { useState } from 'react';
import { ScrollView, View, Text, TextInput, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TRADE_PROFILES, resolveTradeConfig, type Trade } from '@bob/core';
import { useTheme } from '../src/theme';
import { useLookupCompany } from '../src/data/hooks';
import { Card, Chip, Button, SectionHeader, font } from '../src/components/ui';

const TIER_LABEL: Record<string, string> = { free: 'Gratuit', solo: 'Solo', pro: 'Pro', business: 'Business' };

export default function Onboarding() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const trades = Object.values(TRADE_PROFILES);
  const [trade, setTrade] = useState<Trade | null>(null);
  const [siret, setSiret] = useState('');
  const lookup = useLookupCompany();
  const selected = trade ? resolveTradeConfig(trade, 'free') : null;
  const found = lookup.data;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ paddingTop: insets.top + 20, paddingBottom: 40, paddingHorizontal: 20, gap: 16 }}
    >
      <Text style={[font('pageTitle'), { color: colors.ink900 }]}>Bienvenue chez Bob</Text>
      <Text style={[font('body'), { color: colors.slate500 }]}>
        Ton bureau pro, dans ta poche. Bob s&apos;occupe de la paperasse — toi, tu bosses.
      </Text>

      <SectionHeader title="Ton SIRET (optionnel)" />
      <Text style={[font('sub'), { color: colors.slate400 }]}>
        Saisis ton SIRET et je récupère ton nom, ton adresse, ta TVA et je devine ton métier.
      </Text>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
        <TextInput
          value={siret}
          onChangeText={setSiret}
          placeholder="14 chiffres"
          placeholderTextColor={colors.slate300}
          keyboardType="number-pad"
          style={{ flex: 1, backgroundColor: colors.lineSoft, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, color: colors.ink800 }}
        />
        <Button
          title={lookup.isPending ? '…' : 'Récupérer'}
          disabled={siret.replace(/\s/g, '').length !== 14 || lookup.isPending}
          onPress={() =>
            lookup.mutate(siret, {
              onSuccess: (r) => {
                if (r.trade) setTrade(r.trade);
              },
            })
          }
        />
      </View>
      {lookup.isPending ? <ActivityIndicator color={colors.ink800} /> : null}
      {lookup.isError ? (
        <Text style={[font('sub'), { color: '#c0392b' }]}>SIRET introuvable. Choisis ton métier ci-dessous.</Text>
      ) : null}
      {found ? (
        <Card>
          <Text style={[font('cardTitle'), { color: colors.ink900 }]}>{found.denomination}</Text>
          {found.address ? (
            <Text style={[font('sub'), { color: colors.slate500, marginTop: 2 }]}>
              {found.address.line1}, {found.address.zip} {found.address.city}
            </Text>
          ) : null}
          {found.tvaIntracom ? (
            <Text style={[font('meta'), { color: colors.slate400, marginTop: 4 }]}>TVA {found.tvaIntracom}</Text>
          ) : null}
          {found.rge ? (
            <View style={{ marginTop: 8, alignSelf: 'flex-start' }}>
              <Chip label="Certifié RGE" active />
            </View>
          ) : null}
        </Card>
      ) : null}

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
