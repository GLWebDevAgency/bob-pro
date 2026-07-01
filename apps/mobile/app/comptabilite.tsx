import { ScrollView, View, Text, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../src/theme';
import { useAccountingEntries, useSubscription } from '../src/data/hooks';
import { Card, Badge, Button, SectionHeader, font } from '../src/components/ui';
import { AccountingLinesView } from '../src/components/AccountingLinesView';

type Tone = 'b2b' | 'b2g' | 'particulier' | 'success' | 'warning' | 'danger' | 'ai';
const JOURNAL: Record<string, { label: string; tone: Tone }> = {
  sales: { label: 'Ventes', tone: 'b2b' },
  purchases: { label: 'Achats', tone: 'warning' },
  bank: { label: 'Banque', tone: 'success' },
  misc: { label: 'OD', tone: 'particulier' },
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('fr-FR');
}

export default function Comptabilite() {
  const { colors, semantic } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { data: sub } = useSubscription();
  const entries = useAccountingEntries();
  const entitled = (sub?.features ?? []).includes('accounting_foundation');

  const sorted = [...(entries.data ?? [])].sort((a, b) => b.entryDate.localeCompare(a.entryDate));

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ paddingTop: insets.top + 8, paddingHorizontal: 20, paddingBottom: 8 }}>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Retour"
          style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}
        >
          <Ionicons name="chevron-back" size={22} color={colors.ink800} />
          <Text style={[font('body'), { color: colors.ink800 }]}>Accueil</Text>
        </Pressable>
        <Text style={[font('screenH1'), { color: colors.ink900, marginTop: 6 }]}>Comptabilité</Text>
        <Text style={[font('sub'), { color: colors.slate400, marginTop: 2 }]}>Journal des écritures — chaque pièce, vérifiable.</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 20, paddingTop: 8, gap: 12, paddingBottom: 40 }}>
        {!entitled ? (
          <Card>
            <Text style={[font('cardTitle'), { color: colors.ink900 }]}>Comptabilité incluse dès l’offre Solo</Text>
            <Text style={[font('sub'), { color: colors.slate500, marginTop: 6 }]}>
              Le grand livre (écritures en partie double, export cabinet) fait partie des offres avec comptabilité.
            </Text>
            <View style={{ height: 12 }} />
            <Button title="Voir les offres" variant="secondary" onPress={() => router.push('/compte')} />
          </Card>
        ) : entries.isLoading ? (
          <Card>
            <Text style={[font('body'), { color: colors.slate500 }]}>Chargement…</Text>
          </Card>
        ) : entries.isError ? (
          <Card style={{ borderColor: semantic.danger }}>
            <Text accessibilityRole="alert" accessibilityLiveRegion="assertive" style={[font('sub'), { color: semantic.danger }]}>
              Impossible de charger le journal.
            </Text>
            <View style={{ height: 12 }} />
            <Button title="Réessayer" variant="secondary" onPress={() => void entries.refetch()} />
          </Card>
        ) : sorted.length === 0 ? (
          <Card>
            <Text style={[font('body'), { color: colors.slate500 }]}>
              Aucune écriture pour l’instant. Émets une facture — Bob passe l’écriture automatiquement.
            </Text>
          </Card>
        ) : (
          sorted.map((e) => {
            const j = JOURNAL[e.journal] ?? { label: e.journal, tone: 'particulier' as Tone };
            return (
              <Card key={e.id}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <View style={{ flex: 1, paddingRight: 12 }}>
                    <Text style={[font('cardTitle'), { color: colors.ink900 }]}>{e.reference}</Text>
                    <Text style={[font('meta'), { color: colors.slate400, marginTop: 2 }]}>{e.label}</Text>
                  </View>
                  <View style={{ alignItems: 'flex-end', gap: 6 }}>
                    <Badge label={j.label} tone={j.tone} />
                    <Text style={[font('meta'), { color: colors.slate400 }]}>{formatDate(e.entryDate)}</Text>
                  </View>
                </View>
                <View style={{ marginTop: 10 }}>
                  <AccountingLinesView lines={e.lines} />
                </View>
              </Card>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}
