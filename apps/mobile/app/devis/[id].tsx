/**
 * Devis — détail de pièce (claim C16, réf dc.html §showPiece). VUE = buildPieceView
 * (@bob/core, use case pur : acompte proportionnel — test d'or 488,40) via PieceDetailView ;
 * ACTIONS = QuoteActions (source unique, confirmations typées, mêmes use cases que Bob).
 * Nav croisée réelle : première facture issue du devis (parentQuoteId).
 */
import { useMemo } from 'react';
import { ActivityIndicator, Linking, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { buildPieceView, type PieceLinkedRef } from '@bob/core';
import { t } from '@bob/i18n';
import { Card, font, useTheme } from '@bob/ui';
import { useCustomers, useInvoices, useQuote } from '../../src/data/hooks';
import { useDocuments } from '../../src/data/documents';
import { useBobClient } from '../../src/data/client';
import { QuoteActions, hasQuoteActions } from '../../src/components/DocumentActions';
import { PieceDetailView } from '../../src/components/PieceDetailView';

export default function DevisDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { personality, colors } = useTheme();
  const router = useRouter();
  const client = useBobClient();
  const quote = useQuote(id);
  const customers = useCustomers();
  const invoices = useInvoices();
  const documents = useDocuments();

  const view = useMemo(() => {
    const q = quote.data;
    if (!q) return null;
    const customer = (customers.data ?? []).find((c) => c.id === q.customerId) ?? null;
    // Factures issues de ce devis (lien durable parentQuoteId) — la première en nav croisée.
    const linked = (invoices.data ?? []).find((i) => i.parentQuoteId === q.id);
    return buildPieceView({
      source: 'quote',
      quote: q,
      customer,
      ...(linked ? { finalInvoice: { id: linked.id, number: linked.number, ttcCents: linked.totals.ttc } } : {}),
    });
  }, [quote.data, customers.data, invoices.data]);

  const pdfDoc = useMemo(
    () =>
      (documents.data ?? []).find(
        (d) => d.linkedEntityType === 'quote' && d.linkedEntityId === id && (d.kind === 'quote_pdf' || d.kind === 'signed_quote'),
      ) ?? null,
    [documents.data, id],
  );
  const openPdf = pdfDoc
    ? async (): Promise<void> => {
        const r = await client.documentDownloadUrl(pdfDoc.id);
        if (r.ok) await Linking.openURL(r.value.url);
      }
    : null;

  if (quote.isLoading || customers.isLoading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg }}>
        <ActivityIndicator color={colors.ink800} />
      </View>
    );
  }
  if (quote.isError || !view || !quote.data) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', backgroundColor: colors.bg, padding: 18 }}>
        <Card>
          <Text accessibilityRole="alert" style={[font('sub'), { color: colors.slate500 }]}>
            {t(quote.isError ? 'piece.dataError' : 'piece.notFound', { personality })}
          </Text>
        </Card>
      </View>
    );
  }
  const q = quote.data;

  return (
    <PieceDetailView
      view={view}
      onClose={() => router.back()}
      onOpenInvoice={(ref: PieceLinkedRef) => router.push(`/facture/${ref.id}`)}
      onOpenPdf={openPdf ? () => void openPdf() : undefined}
      actions={hasQuoteActions(q) ? <QuoteActions quote={q} customerName={view.customerName} /> : null}
    />
  );
}
