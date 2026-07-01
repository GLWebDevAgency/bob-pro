import { ScrollView, View, Text, Pressable } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { formatEUR } from '@bob/core';
import { useTheme } from '../../src/theme';
import { useQuote, useCustomers, useInvoices } from '../../src/data/hooks';
import { Card, Badge, MoneyText, SectionHeader, font } from '../../src/components/ui';
import { QuoteActions, hasQuoteActions, QUOTE_BADGE, INVOICE_BADGE } from '../../src/components/DocumentActions';

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString('fr-FR');
}

export default function DevisDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const quote = useQuote(id);
  const customers = useCustomers();
  const invoices = useInvoices();

  const q = quote.data ?? null;
  const customerName = q ? (customers.data ?? []).find((c) => c.id === q.customerId)?.name ?? 'Client' : 'Client';
  const badge = q ? QUOTE_BADGE[q.status] : null;
  const validUntil = formatDate(q?.validUntil ?? null);
  // Factures issues de ce devis (lien durable via parentQuoteId exposé par le domaine).
  const linkedInvoices = q ? (invoices.data ?? []).filter((i) => i.parentQuoteId === q.id) : [];

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
          <Text style={[font('body'), { color: colors.ink800 }]}>Devis &amp; Factures</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={{ padding: 20, paddingTop: 8, gap: 16, paddingBottom: 40 }}>
        {quote.isLoading ? (
          <Card>
            <Text style={[font('body'), { color: colors.slate500 }]}>Chargement…</Text>
          </Card>
        ) : quote.isError ? (
          <Card>
            <Text accessibilityRole="alert" style={[font('body'), { color: colors.slate500 }]}>
              Devis introuvable.
            </Text>
          </Card>
        ) : q && badge ? (
          <>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <View style={{ flex: 1, paddingRight: 12 }}>
                <Text style={[font('screenH1'), { color: colors.ink900 }]}>{q.number ?? 'Brouillon'}</Text>
                <Text style={[font('sub'), { color: colors.slate400, marginTop: 2 }]}>{customerName}</Text>
              </View>
              <Badge label={badge.label} tone={badge.tone} />
            </View>

            <Card>
              <SectionHeader title="Lignes" />
              {q.lines.map((l) => (
                <View key={l.id} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 }}>
                  <View style={{ flex: 1, paddingRight: 12 }}>
                    <Text style={[font('body'), { color: colors.ink800 }]}>{l.label}</Text>
                    <Text style={[font('meta'), { color: colors.slate400 }]}>
                      {l.qty} × {formatEUR(l.unitPriceHT)} HT · TVA {l.vatRate} %
                    </Text>
                  </View>
                  <MoneyText cents={l.qty * l.unitPriceHT} />
                </View>
              ))}
              <View style={{ height: 1, backgroundColor: colors.lineSoft, marginVertical: 10 }} />
              <Row label="Total HT" value={formatEUR(q.totals.ht)} colors={colors} />
              <Row label="TVA" value={formatEUR(q.totals.vat)} colors={colors} />
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 }}>
                <Text style={[font('cardTitle'), { color: colors.ink900 }]}>Total TTC</Text>
                <MoneyText cents={q.totals.ttc} variant="big" />
              </View>
              {q.depositPct ? (
                <View style={{ marginTop: 10 }}>
                  <Badge label={`Acompte ${q.depositPct} % · ${formatEUR(q.totals.netToPay)}`} tone="b2b" />
                </View>
              ) : null}
              {validUntil ? (
                <Text style={[font('meta'), { color: colors.slate400, marginTop: 10 }]}>Valable jusqu&apos;au {validUntil}</Text>
              ) : null}
            </Card>

            {linkedInvoices.length > 0 ? (
              <Card>
                <SectionHeader title="Facture(s) générée(s)" />
                <View style={{ gap: 4 }}>
                  {linkedInvoices.map((f) => {
                    const fb = INVOICE_BADGE[f.status];
                    return (
                      <Pressable
                        key={f.id}
                        onPress={() => router.push(`/facture/${f.id}`)}
                        accessibilityRole="button"
                        accessibilityLabel={`Ouvrir la facture ${f.number ?? 'brouillon'}`}
                        style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8 }}
                      >
                        <Text style={[font('body'), { color: colors.ink800 }]}>{f.number ?? 'Brouillon'}</Text>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                          <Badge label={fb.label} tone={fb.tone} />
                          <Ionicons name="chevron-forward" size={18} color={colors.slate400} />
                        </View>
                      </Pressable>
                    );
                  })}
                </View>
              </Card>
            ) : null}

            {/* Pour un devis signé, on attend que les factures soient connues (évite d'afficher « Générer »
                une fraction de seconde sur un devis déjà facturé). Les autres statuts ne dépendent pas des factures. */}
            {hasQuoteActions(q) && (q.status !== 'signed' || !invoices.isLoading) ? (
              <QuoteActions quote={q} customerName={customerName} alreadyInvoiced={linkedInvoices.length > 0} />
            ) : null}
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

function Row({ label, value, colors }: { label: string; value: string; colors: { slate500: string; ink800: string } }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2 }}>
      <Text style={[font('sub'), { color: colors.slate500 }]}>{label}</Text>
      <Text style={[font('sub'), { color: colors.ink800 }]}>{value}</Text>
    </View>
  );
}
