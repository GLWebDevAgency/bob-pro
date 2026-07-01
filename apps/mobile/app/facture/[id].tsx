import { ScrollView, View, Text, Pressable } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { formatEUR } from '@bob/core';
import { useTheme } from '../../src/theme';
import { useInvoice, useCustomers } from '../../src/data/hooks';
import { Card, Badge, MoneyText, SectionHeader, font } from '../../src/components/ui';
import { InvoiceActions, hasInvoiceActions, INVOICE_BADGE } from '../../src/components/DocumentActions';

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString('fr-FR');
}

export default function FactureDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors, semantic } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const invoice = useInvoice(id);
  const customers = useCustomers();

  const inv = invoice.data ?? null;
  const customerName = inv ? (customers.data ?? []).find((c) => c.id === inv.customerId)?.name ?? 'Client' : 'Client';
  const badge = inv ? INVOICE_BADGE[inv.status] : null;
  // Assiette = netToPay (acompte si depositPct, sinon ttc) : c'est ce que le domaine autorise à encaisser.
  const remaining = inv ? Math.max(0, inv.totals.netToPay - inv.paid) : 0;
  const dueAt = formatDate(inv?.dueAt ?? null);

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
        {invoice.isLoading ? (
          <Card>
            <Text style={[font('body'), { color: colors.slate500 }]}>Chargement…</Text>
          </Card>
        ) : invoice.isError ? (
          <Card>
            <Text accessibilityRole="alert" style={[font('body'), { color: colors.slate500 }]}>
              Facture introuvable.
            </Text>
          </Card>
        ) : inv && badge ? (
          <>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <View style={{ flex: 1, paddingRight: 12 }}>
                <Text style={[font('screenH1'), { color: colors.ink900 }]}>{inv.number ?? 'Brouillon'}</Text>
                <Text style={[font('sub'), { color: colors.slate400, marginTop: 2 }]}>{customerName}</Text>
              </View>
              <Badge label={badge.label} tone={badge.tone} />
            </View>

            <Card>
              <SectionHeader title="Montant" />
              <Row label="Total HT" value={formatEUR(inv.totals.ht)} colors={colors} />
              <Row label="TVA" value={formatEUR(inv.totals.vat)} colors={colors} />
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 }}>
                <Text style={[font('cardTitle'), { color: colors.ink900 }]}>Total TTC</Text>
                <MoneyText cents={inv.totals.ttc} variant="big" />
              </View>
              {inv.paid > 0 ? <Row label="Déjà encaissé" value={formatEUR(inv.paid)} colors={colors} /> : null}
              {remaining > 0 && remaining !== inv.totals.ttc ? (
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 }}>
                  <Text style={[font('cardTitle'), { color: colors.ink900 }]}>Reste à encaisser</Text>
                  <MoneyText cents={remaining} color={semantic.danger} />
                </View>
              ) : null}
              {dueAt ? (
                <Text style={[font('meta'), { color: colors.slate400, marginTop: 10 }]}>Échéance : {dueAt}</Text>
              ) : null}
            </Card>

            {inv.mentions.length > 0 ? (
              <Card>
                <SectionHeader title="Mentions légales" />
                <View style={{ gap: 6 }}>
                  {inv.mentions.map((m, i) => (
                    <Text key={i} style={[font('meta'), { color: colors.slate500 }]}>
                      • {m}
                    </Text>
                  ))}
                </View>
              </Card>
            ) : null}

            {inv.parentQuoteId ? (
              <Pressable
                onPress={() => router.push(`/devis/${inv.parentQuoteId}`)}
                accessibilityRole="button"
                accessibilityLabel="Ouvrir le devis d'origine"
              >
                <Card>
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                    <Text style={[font('cardTitle'), { color: colors.ink900 }]}>Devis d&apos;origine</Text>
                    <Ionicons name="chevron-forward" size={20} color={colors.slate400} />
                  </View>
                </Card>
              </Pressable>
            ) : null}

            {hasInvoiceActions(inv) ? <InvoiceActions invoice={inv} /> : null}
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
