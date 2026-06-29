import { ScrollView, View, Text } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../src/theme';
import { GradientHeader, Card, Button, font } from '../../src/components/ui';

const FOLDERS = [
  { id: 'chantiers', name: 'Chantiers', count: 12, icon: 'construct-outline' as const },
  { id: 'achats', name: 'Achats', count: 34, icon: 'cart-outline' as const },
  { id: 'assurances', name: 'Assurances', count: 4, icon: 'shield-checkmark-outline' as const },
  { id: 'fiscal', name: 'Fiscal & social', count: 9, icon: 'document-text-outline' as const },
  { id: 'banque', name: 'Banque', count: 21, icon: 'card-outline' as const },
  { id: 'comptable', name: 'Comptable', count: 6, icon: 'calculator-outline' as const },
];

export default function Documents() {
  const { colors, theme } = useTheme();
  const router = useRouter();
  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ paddingBottom: 120 }}>
      <GradientHeader>
        <Text style={[font('eyebrow'), { color: 'rgba(255,255,255,0.7)' }]}>TON COFFRE-FORT</Text>
        <Text style={[font('pageTitle'), { color: '#fff', marginTop: 4 }]}>Documents</Text>
        <Text style={[font('body'), { color: 'rgba(255,255,255,0.8)', marginTop: 4 }]}>Je classe, tu retrouves. Même 3 ans après.</Text>
      </GradientHeader>
      <View style={{ paddingHorizontal: 20, paddingTop: 16 }}>
        <Button title="Scanner un document" onPress={() => router.push('/scan-document')} />
      </View>
      <View style={{ padding: 20, flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
        {FOLDERS.map((f) => (
          <Card key={f.id} style={{ width: '47%' }}>
            <Ionicons name={f.icon} size={26} color={theme.ink2} />
            <Text style={[font('cardTitle'), { color: colors.ink800, marginTop: 10 }]}>{f.name}</Text>
            <Text style={[font('meta'), { color: colors.slate400, marginTop: 2 }]}>{f.count} documents</Text>
          </Card>
        ))}
      </View>
    </ScrollView>
  );
}
