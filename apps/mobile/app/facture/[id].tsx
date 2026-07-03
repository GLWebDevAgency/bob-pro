/**
 * Facture — détail de pièce (claim C16, réf dc.html §showPiece). La VUE vient de
 * buildPieceView (@bob/core, use case pur — parité d'actions) via PieceDetailView ;
 * les ACTIONS restent InvoiceActions (source unique, confirmations typées, mêmes use
 * cases que Bob). Nav croisée réelle : devis parent, avoir, situation (parentQuoteId).
 * Le PDF s'ouvre depuis le coffre (document lié) quand il existe — sinon pas de bouton.
 * L'aperçu comptable (fonctionnalité réelle antérieure) est conservé sous les mentions.
 */
import { useMemo } from 'react';
import { ActivityIndicator, Linking, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { buildPieceView, type PieceLinkedRef } from '@bob/core';
import { t } from '@bob/i18n';
import { Card, SectionHeader, font, useTheme } from '@bob/ui';
import { useCustomers, useInvoice, useInvoiceAccountingPreview, useInvoices, useQuotes } from '../../src/data/hooks';
import { useDocuments } from '../../src/data/documents';
import { useBobClient } from '../../src/data/client';
import { InvoiceActions, hasInvoiceActions } from '../../src/components/DocumentActions';
import { AccountingLinesView } from '../../src/components/AccountingLinesView';
import { PieceDetailView } from '../../src/components/PieceDetailView';

export default function FactureDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { personality, colors } = useTheme();
  const router = useRouter();
  const client = useBobClient();
  const invoice = useInvoice(id);
  const invoices = useInvoices();
  const quotes = useQuotes();
  const customers = useCustomers();
  const documents = useDocuments();
  const acct = useInvoiceAccountingPreview(id, !!invoice.data);
  const ledger = acct.data?.available ? acct.data : null;

  const view = useMemo(() => {
    const inv = invoice.data;
    if (!inv) return null;
    const customer = (customers.data ?? []).find((c) => c.id === inv.customerId) ?? null;
    const parent = inv.parentQuoteId ? (quotes.data ?? []).find((q) => q.id === inv.parentQuoteId) : undefined;
    // Pièces sœurs du même devis parent : avoir émis / situation liée (réel, sans ambiguïté).
    const siblings = inv.parentQuoteId
      ? (invoices.data ?? []).filter((i) => i.parentQuoteId === inv.parentQuoteId && i.id !== inv.id)
      : [];
    const credit = siblings.find((i) => i.kind === 'credit_note');
    const situation = siblings.find((i) => i.kind === 'situation');
    return buildPieceView({
      source: 'invoice',
      invoice: inv,
      customer,
      ...(parent ? { parentQuote: { id: parent.id, number: parent.number, ttcCents: parent.totals.ttc } } : {}),
      ...(credit ? { creditNote: { id: credit.id, number: credit.number, ttcCents: credit.totals.ttc } } : {}),
      ...(situation ? { situation: { id: situation.id, number: situation.number, ttcCents: situation.totals.ttc } } : {}),
    });
  }, [invoice.data, invoices.data, quotes.data, customers.data]);

  // PDF archivé au coffre (document lié à la facture) — bouton absent sinon (pas de chemin fantôme).
  const pdfDoc = useMemo(
    () =>
      (documents.data ?? []).find(
        (d) => d.linkedEntityType === 'invoice' && d.linkedEntityId === id && d.kind === 'invoice_pdf',
      ) ?? null,
    [documents.data, id],
  );
  const openPdf = pdfDoc
    ? async (): Promise<void> => {
        const r = await client.documentDownloadUrl(pdfDoc.id);
        if (r.ok) await Linking.openURL(r.value.url);
      }
    : null;

  if (invoice.isLoading || customers.isLoading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg }}>
        <ActivityIndicator color={colors.ink800} />
      </View>
    );
  }
  if (invoice.isError || !view || !invoice.data) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', backgroundColor: colors.bg, padding: 18 }}>
        <Card>
          <Text accessibilityRole="alert" style={[font('sub'), { color: colors.slate500 }]}>
            {t(invoice.isError ? 'piece.dataError' : 'piece.notFound', { personality })}
          </Text>
        </Card>
      </View>
    );
  }
  const inv = invoice.data;

  return (
    <PieceDetailView
      view={view}
      onClose={() => router.back()}
      onOpenQuote={(ref: PieceLinkedRef) => router.push(`/devis/${ref.id}`)}
      onOpenInvoice={(ref: PieceLinkedRef) => router.push(`/facture/${ref.id}`)}
      onOpenPdf={openPdf ? () => void openPdf() : undefined}
      actions={hasInvoiceActions(inv) ? <InvoiceActions invoice={inv} /> : null}
      extra={
        ledger && ledger.lines.length > 0 ? (
          <Card>
            <SectionHeader title="Écriture comptable" />
            <AccountingLinesView
              lines={ledger.lines}
              totalDebitCents={ledger.totalDebitCents}
              totalCreditCents={ledger.totalCreditCents}
            />
          </Card>
        ) : null
      }
    />
  );
}
