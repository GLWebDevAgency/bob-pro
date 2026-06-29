import { useState } from 'react';
import { ScrollView, View, Text } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../../src/theme';
import { useCustomers } from '../../src/data/hooks';
import { GradientHeader, Card, Chip, ListRow, MoneyText, font } from '../../src/components/ui';

type Filter = 'tous' | 'b2c' | 'b2b' | 'b2g';
const FILTER_LABEL: Record<Filter, string> = { tous: 'Tous', b2c: 'Particuliers', b2b: 'Entreprises', b2g: 'Public' };

export default function Clients() {
  const { colors, semantic } = useTheme();
  const router = useRouter();
  const { data } = useCustomers();
  const [filter, setFilter] = useState<Filter>('tous');

  const list = (data ?? []).filter((c) => filter === 'tous' || c.type === filter);

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ paddingBottom: 120 }}>
      <GradientHeader>
        <Text style={[font('eyebrow'), { color: 'rgba(255,255,255,0.7)' }]}>TON CARNET</Text>
        <Text style={[font('pageTitle'), { color: '#fff', marginTop: 4 }]}>Clients</Text>
      </GradientHeader>
      <View style={{ padding: 20, gap: 14 }}>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {(Object.keys(FILTER_LABEL) as Filter[]).map((f) => (
            <Chip key={f} label={FILTER_LABEL[f]} active={filter === f} onPress={() => setFilter(f)} />
          ))}
        </View>
        <Card>
          {list.length === 0 ? (
            <Text style={[font('body'), { color: colors.slate500 }]}>Aucun client.</Text>
          ) : (
            list.map((c, i) => (
              <View key={c.id}>
                <ListRow
                  title={c.name}
                  subtitle={c.type.toUpperCase()}
                  onPress={() => router.push({ pathname: '/client/[id]', params: { id: c.id } })}
                  amount={<MoneyText cents={c.outstanding} color={c.outstanding > 0 ? semantic.danger : colors.slate400} />}
                />
                {i < list.length - 1 ? <View style={{ height: 1, backgroundColor: colors.lineSoft }} /> : null}
              </View>
            ))
          )}
        </Card>
      </View>
    </ScrollView>
  );
}
