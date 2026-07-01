import { ScrollView, View, Text, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { formatEUR } from '@bob/core';
import type { QuoteView, InvoiceView } from '@bob/api-client';
import { useTheme } from '../src/theme';
import { useCustomers, useQuotes, useInvoices } from '../src/data/hooks';
import { Card, Badge, Button, MoneyText, SectionHeader, font } from '../src/components/ui';
import {
  QuoteActions,
  InvoiceActions,
  hasQuoteActions,
  hasInvoiceActions,
  QUOTE_BADGE,
  INVOICE_BADGE,
} from '../src/components/DocumentActions';

type QuoteStatus = QuoteView['status'];
type InvoiceStatus = InvoiceView['status'];

// Actionnable en premier : les brouillons/à traiter remontent, le terminé descend.
const QUOTE_ORDER: Record<QuoteStatus, number> = { draft: 0, sent: 1, viewed: 1, signed: 2, refused: 4, expired: 4 };
const INVOICE_ORDER: Record<InvoiceStatus, number> = { draft: 0, late: 1, issued: 2, partially_paid: 2, paid: 4, cancelled: 4 };

export default function Ventes() {
  const { colors, semantic } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const customers = useCustomers();
  const quotes = useQuotes();
  const invoices = useInvoices();

  const nameOf = (customerId: string) => (customers.data ?? []).find((c) => c.id === customerId)?.name ?? 'Client';

  const loading = quotes.isLoading || invoices.isLoading;
  const errored = quotes.isError || invoices.isError;

  const sortedQuotes = [...(quotes.data ?? [])].sort((a, b) => QUOTE_ORDER[a.status] - QUOTE_ORDER[b.status]);
  const sortedInvoices = [...(invoices.data ?? [])].sort((a, b) => INVOICE_ORDER[a.status] - INVOICE_ORDER[b.status]);

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
        <Text style={[font('screenH1'), { color: colors.ink900, marginTop: 6 }]}>Devis &amp; Factures</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 20, paddingTop: 8, gap: 20, paddingBottom: 40 }}>
        {loading ? (
          <Card>
            <Text style={[font('body'), { color: colors.slate500 }]}>Chargement…</Text>
          </Card>
        ) : errored ? (
          <Card style={{ borderColor: semantic.danger }}>
            <Text
              accessibilityRole="alert"
              accessibilityLiveRegion="assertive"
              style={[font('sub'), { color: semantic.danger }]}
            >
              Impossible de charger tes documents.
            </Text>
            <View style={{ height: 12 }} />
            <Button
              title="Réessayer"
              variant="secondary"
              onPress={() => {
                void quotes.refetch();
                void invoices.refetch();
              }}
            />
          </Card>
        ) : (
          <>
            <View>
              <SectionHeader title="Devis" />
              {sortedQuotes.length === 0 ? (
                <Card>
                  <Text style={[font('body'), { color: colors.slate500 }]}>Aucun devis pour l&apos;instant.</Text>
                </Card>
              ) : (
                <View style={{ gap: 10 }}>
                  {sortedQuotes.map((q) => {
                    const badge = QUOTE_BADGE[q.status];
                    return (
                      <Card key={q.id}>
                        <Pressable
                          onPress={() => router.push(`/devis/${q.id}`)}
                          accessibilityRole="button"
                          accessibilityLabel={`Devis ${q.number ?? 'brouillon'} — ${nameOf(q.customerId)}`}
                          style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}
                        >
                          <View style={{ flex: 1, paddingRight: 12 }}>
                            <Text style={[font('cardTitle'), { color: colors.ink900 }]}>{q.number ?? 'Brouillon'}</Text>
                            <Text style={[font('meta'), { color: colors.slate400, marginTop: 2 }]}>{nameOf(q.customerId)}</Text>
                          </View>
                          <View style={{ alignItems: 'flex-end', gap: 6 }}>
                            <MoneyText cents={q.totals.ttc} />
                            <Badge label={badge.label} tone={badge.tone} />
                          </View>
                        </Pressable>
                        {hasQuoteActions(q) ? (
                          <View style={{ marginTop: 12 }}>
                            <QuoteActions
                              quote={q}
                              customerName={nameOf(q.customerId)}
                              alreadyInvoiced={(invoices.data ?? []).some((i) => i.parentQuoteId === q.id)}
                            />
                          </View>
                        ) : null}
                      </Card>
                    );
                  })}
                </View>
              )}
            </View>

            <View>
              <SectionHeader title="Factures" />
              {sortedInvoices.length === 0 ? (
                <Card>
                  <Text style={[font('body'), { color: colors.slate500 }]}>Aucune facture pour l&apos;instant.</Text>
                </Card>
              ) : (
                <View style={{ gap: 10 }}>
                  {sortedInvoices.map((inv) => {
                    const badge = INVOICE_BADGE[inv.status];
                    // Assiette = netToPay (acompte si depositPct) : montant réellement encaissable sur la facture.
                    const remaining = Math.max(0, inv.totals.netToPay - inv.paid);
                    const showRemaining = remaining > 0 && remaining !== inv.totals.ttc;
                    return (
                      <Card key={inv.id}>
                        <Pressable
                          onPress={() => router.push(`/facture/${inv.id}`)}
                          accessibilityRole="button"
                          accessibilityLabel={`Facture ${inv.number ?? 'brouillon'} — ${nameOf(inv.customerId)}`}
                          style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}
                        >
                          <View style={{ flex: 1, paddingRight: 12 }}>
                            <Text style={[font('cardTitle'), { color: colors.ink900 }]}>{inv.number ?? 'Brouillon'}</Text>
                            <Text style={[font('meta'), { color: colors.slate400, marginTop: 2 }]}>{nameOf(inv.customerId)}</Text>
                          </View>
                          <View style={{ alignItems: 'flex-end', gap: 6 }}>
                            <MoneyText cents={inv.totals.ttc} />
                            {showRemaining ? (
                              <Text style={[font('meta'), { color: colors.slate500 }]}>À encaisser {formatEUR(remaining)}</Text>
                            ) : null}
                            <Badge label={badge.label} tone={badge.tone} />
                          </View>
                        </Pressable>
                        {hasInvoiceActions(inv) ? (
                          <View style={{ marginTop: 12 }}>
                            <InvoiceActions invoice={inv} />
                          </View>
                        ) : null}
                      </Card>
                    );
                  })}
                </View>
              )}
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}
