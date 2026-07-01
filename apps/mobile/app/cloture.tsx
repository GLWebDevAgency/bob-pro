import { ScrollView, View, Text, Pressable, Alert } from 'react-native';
import { useRouter, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Sharing from 'expo-sharing';
import { writeAsStringAsync, cacheDirectory, EncodingType } from 'expo-file-system/legacy';
import { useTheme } from '../src/theme';
import { useInvoices, useQuotes, useSubscription, useExportFec, appErrorMessage } from '../src/data/hooks';
import { useDocuments } from '../src/data/documents';
import { Card, Badge, Button, SectionHeader, font } from '../src/components/ui';

/** Un point de clôture : libellé, compte, où agir. count=0 => réglé. */
interface CheckItem {
  label: string;
  count: number;
  route: Href;
}

function moisCourant(): { key: string; label: string } {
  const d = new Date();
  return { key: d.toISOString().slice(0, 7), label: d.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' }) };
}

export default function Cloture() {
  const { colors, semantic } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { data: sub } = useSubscription();
  const invoices = useInvoices();
  const quotes = useQuotes();
  const documents = useDocuments();
  const exportFec = useExportFec();
  const entitled = (sub?.features ?? []).includes('accounting_operations');

  const mois = moisCourant();
  const inv = invoices.data ?? [];
  const qs = quotes.data ?? [];
  const docs = documents.data ?? [];
  const loading = invoices.isLoading || quotes.isLoading || documents.isLoading;

  // Anomalies (état à date) — actionnables.
  const draftInvoices = inv.filter((i) => i.status === 'draft');
  const lateInvoices = inv.filter((i) => i.status === 'late');
  const partialInvoices = inv.filter((i) => i.status === 'partially_paid');
  const signedNotInvoiced = qs.filter((q) => q.status === 'signed' && !inv.some((i) => i.parentQuoteId === q.id));

  // Pièces manquantes : factures émises sans PDF archivé.
  const invoicePdfIds = new Set(docs.filter((d) => d.kind === 'invoice_pdf' && d.linkedEntityId).map((d) => d.linkedEntityId));
  const issued = inv.filter((i) => i.status !== 'draft' && i.status !== 'cancelled');
  const missingPdf = issued.filter((i) => !invoicePdfIds.has(i.id));

  const anomalies: CheckItem[] = [
    { label: 'Devis signés à facturer', count: signedNotInvoiced.length, route: '/ventes' },
    { label: 'Factures à émettre (brouillons)', count: draftInvoices.length, route: '/ventes' },
    { label: 'Factures en retard', count: lateInvoices.length, route: '/ventes' },
    { label: 'Factures partiellement payées', count: partialInvoices.length, route: '/ventes' },
  ];
  const pieces: CheckItem[] = [
    { label: 'Factures émises sans PDF archivé', count: missingPdf.length, route: '/documents' },
  ];
  const anomaliesTotal = anomalies.reduce((s, i) => s + i.count, 0);
  const piecesTotal = pieces.reduce((s, i) => s + i.count, 0);
  const allClear = anomaliesTotal === 0 && piecesTotal === 0;

  // Période FEC = le mois courant (de YYYY-MM-01 au dernier jour du mois).
  const pad = (n: number) => String(n).padStart(2, '0');
  const [yy, mm] = mois.key.split('-').map(Number);
  const fecFrom = `${mois.key}-01`;
  const fecTo = `${mois.key}-${pad(new Date(yy ?? 2026, mm ?? 1, 0).getDate())}`;

  const onExportFec = async (): Promise<void> => {
    try {
      const res = await exportFec.mutateAsync({ from: fecFrom, to: fecTo });
      if (!cacheDirectory) {
        Alert.alert('Export FEC', 'Stockage indisponible sur cet appareil.');
        return;
      }
      const uri = `${cacheDirectory}${res.filename}`;
      await writeAsStringAsync(uri, res.content, { encoding: EncodingType.UTF8 });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, { mimeType: res.mimeType || 'text/plain', dialogTitle: 'Export FEC' });
      } else {
        Alert.alert('Export FEC', `${res.filename} généré (${res.entryCount} écriture${res.entryCount > 1 ? 's' : ''}).`);
      }
      if (res.warnings.length) Alert.alert('Avertissements FEC', res.warnings.join('\n'));
    } catch (e) {
      Alert.alert('Oups', appErrorMessage(e));
    }
  };

  const Row = ({ item }: { item: CheckItem }) => {
    const done = item.count === 0;
    return (
      <Pressable
        onPress={item.count > 0 ? () => router.push(item.route) : undefined}
        accessibilityRole={item.count > 0 ? 'button' : undefined}
        accessibilityLabel={`${item.label} : ${item.count}`}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 }}
      >
        <Ionicons
          name={done ? 'checkmark-circle' : 'alert-circle'}
          size={20}
          color={done ? semantic.success : semantic.warning}
        />
        <Text style={[font('body'), { color: colors.ink800, flex: 1 }]}>{item.label}</Text>
        <Badge label={String(item.count)} tone={done ? 'success' : 'warning'} />
        {item.count > 0 ? <Ionicons name="chevron-forward" size={18} color={colors.slate400} /> : null}
      </Pressable>
    );
  };

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
        <Text style={[font('screenH1'), { color: colors.ink900, marginTop: 6 }]}>Clôture — {mois.label}</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 20, paddingTop: 8, gap: 16, paddingBottom: 40 }}>
        {!entitled ? (
          <Card>
            <Text style={[font('cardTitle'), { color: colors.ink900 }]}>Clôture assistée — offre Pro</Text>
            <Text style={[font('sub'), { color: colors.slate500, marginTop: 6 }]}>
              La préparation du mois pour le comptable (anomalies, pièces manquantes, export) fait partie de l’offre Operations.
            </Text>
            <View style={{ height: 12 }} />
            <Button title="Voir les offres" variant="secondary" onPress={() => router.push('/compte')} />
          </Card>
        ) : loading ? (
          <Card>
            <Text style={[font('body'), { color: colors.slate500 }]}>Bob prépare ton mois…</Text>
          </Card>
        ) : (
          <>
            <Card style={allClear ? { backgroundColor: semantic.successBg, borderColor: semantic.success } : undefined}>
              {allClear ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <Ionicons name="checkmark-circle" size={28} color={semantic.success} />
                  <Text style={[font('cardTitle'), { color: semantic.success, flex: 1 }]}>Tout est prêt pour le comptable.</Text>
                </View>
              ) : (
                <>
                  <Text style={[font('cardTitle'), { color: colors.ink900 }]}>Bob a préparé ton mois.</Text>
                  <Text style={[font('body'), { color: colors.ink800, marginTop: 6 }]}>
                    Il reste <Text style={{ color: semantic.warning }}>{anomaliesTotal} point{anomaliesTotal > 1 ? 's' : ''} à arbitrer</Text>
                    {' · '}
                    <Text style={{ color: semantic.warning }}>{piecesTotal} pièce{piecesTotal > 1 ? 's' : ''} manquante{piecesTotal > 1 ? 's' : ''}</Text>.
                  </Text>
                </>
              )}
            </Card>

            <View>
              <SectionHeader title="À arbitrer" />
              <Card>
                {anomalies.map((item, i) => (
                  <View key={item.label}>
                    {i > 0 ? <View style={{ height: 1, backgroundColor: colors.lineSoft }} /> : null}
                    <Row item={item} />
                  </View>
                ))}
              </Card>
            </View>

            <View>
              <SectionHeader title="Pièces" />
              <Card>
                {pieces.map((item, i) => (
                  <View key={item.label}>
                    {i > 0 ? <View style={{ height: 1, backgroundColor: colors.lineSoft }} /> : null}
                    <Row item={item} />
                  </View>
                ))}
              </Card>
            </View>

            <View>
              <SectionHeader title="Export cabinet" />
              <Button
                title={exportFec.isPending ? 'Génération du FEC…' : 'Exporter pour le comptable (FEC)'}
                variant="secondary"
                disabled={exportFec.isPending}
                onPress={() => void onExportFec()}
              />
              <Text style={[font('meta'), { color: colors.slate400, marginTop: 8, textAlign: 'center' }]}>
                Fichier des écritures conforme (FEC) — {mois.label}.
              </Text>
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}
