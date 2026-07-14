/**
 * Devis — détail de pièce (claim C16, réf dc.html §showPiece). VUE = buildPieceView
 * (@bob/core, use case pur : acompte proportionnel — test d'or 488,40) via PieceDetailView ;
 * ACTIONS = QuoteActions (source unique, confirmations typées, mêmes use cases que Bob).
 * Nav croisée réelle : première facture issue du devis (parentQuoteId).
 */
import { useMemo } from 'react';
import { Alert, Linking, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { buildPieceView, type PieceLinkedRef } from '@bob/core';
import { t } from '@bob/i18n';
import { Card, ErrorRetry, SkeletonCard, SkeletonHeader, font, useTheme } from '@bob/ui';
import { useCustomers, useInvoices, useQuote } from '../../src/data/hooks';
import { useDocuments } from '../../src/data/documents';
import { useBobClient } from '../../src/data/client';
import { shareDocument } from '../../src/lib/share-document';
import { QuoteActions, hasQuoteActions } from '../../src/components/DocumentActions';
import { PieceDetailView } from '../../src/components/PieceDetailView';
import {
  usePublishAgentContext,
  type AgentCapability,
  type AgentContext,
  type AgentAccessLayout,
} from '../../src/agent';

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
    // TOUTES les factures issues de ce devis (lien durable parentQuoteId), acompte d'abord
    // puis par numéro — chacune porte CE QU'ELLE FACTURE (netToPay, règle acompte).
    const linked = (invoices.data ?? [])
      .filter((i) => i.parentQuoteId === q.id)
      .sort(
        (a, b) =>
          (a.kind === 'deposit' ? 0 : 1) - (b.kind === 'deposit' ? 0 : 1) ||
          (a.number ?? '').localeCompare(b.number ?? ''),
      )
      .map((i) => ({ id: i.id, number: i.number, ttcCents: i.totals.netToPay, kind: i.kind }));
    return buildPieceView({
      source: 'quote',
      quote: q,
      customer,
      ...(linked.length > 0 ? { linkedInvoices: linked } : {}),
    });
  }, [quote.data, customers.data, invoices.data]);
  const agentContext = useMemo<AgentContext>(() => {
    const q = quote.data;
    if (!q) {
      return {
        screen: { name: '/devis/[id]', instanceId: `quote:${id}` },
        entities: [],
        capabilities: ['screen.read'],
      };
    }
    const customer = (customers.data ?? []).find((item) => item.id === q.customerId);
    const actionCapabilities: AgentCapability[] =
      q.status === 'draft'
        ? ['quote.send', 'quote.line.update', 'quote.deposit.update']
        : q.status === 'sent' || q.status === 'viewed'
          ? ['quote.send']
          : q.status === 'signed'
            ? ['quote.invoice.generate']
            : [];
    return {
      screen: { name: '/devis/[id]', instanceId: `quote:${q.id}` },
      entities: [
        { type: 'quote' as const, id: q.id, label: q.number ? `Devis ${q.number}` : 'Devis brouillon' },
        ...(customer ? [{ type: 'customer' as const, id: customer.id, label: customer.name }] : []),
        ...q.lines.slice(0, 18).map((line, index) => ({
          type: 'quote_line' as const,
          id: line.id,
          label: `${index + 1} · ${line.label}`,
        })),
      ],
      capabilities: ['screen.read', 'quote.read', ...actionCapabilities],
    };
  }, [customers.data, id, quote.data]);
  const agentLayout = useMemo<AgentAccessLayout>(() => ({ bottomAvoidance: 86 }), []);
  usePublishAgentContext(agentContext, agentLayout);

  const pdfDoc = useMemo(
    () =>
      (documents.data ?? []).find(
        (d) =>
          d.linkedEntityType === 'quote' &&
          d.linkedEntityId === id &&
          (d.kind === 'quote_pdf' || d.kind === 'signed_quote'),
      ) ?? null,
    [documents.data, id],
  );
  const openPdf = pdfDoc
    ? async (): Promise<void> => {
        const r = await client.documentDownloadUrl(pdfDoc.id);
        if (r.ok) await Linking.openURL(r.value.url);
      }
    : null;
  // A4 : le client reçoit le VRAI fichier via la feuille de partage (repli honnête sinon).
  const sharePdf = pdfDoc
    ? async (): Promise<void> => {
        const r = await client.documentDownloadUrl(pdfDoc.id);
        if (!r.ok) {
          Alert.alert('Oups', t('piece.shareError', { personality }));
          return;
        }
        const shared = await shareDocument({
          url: r.value.url,
          filename: pdfDoc.filename,
          mimeType: pdfDoc.mimeType,
        });
        if (shared === 'unavailable')
          Alert.alert('Oups', t('piece.shareUnavailable', { personality }));
        else if (shared === 'error') Alert.alert('Oups', t('piece.shareError', { personality }));
      }
    : null;

  if (quote.isLoading || customers.isLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <SkeletonHeader onClose={() => router.back()} />
        <View style={{ padding: 18, gap: 12 }}>
          <SkeletonCard contentLines={4} />
          <SkeletonCard contentLines={3} />
          <SkeletonCard contentLines={2} />
        </View>
      </View>
    );
  }
  // Un ÉCHEC réseau n'est JAMAIS un cul-de-sac : retry ET fermeture restent disponibles
  // (avant ce correctif l'utilisateur était piégé sans issue — bug P0 de l'audit états).
  if (quote.isError) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', backgroundColor: colors.bg, padding: 18 }}>
        <ErrorRetry
          message={t('piece.dataError', { personality })}
          onRetry={() => void quote.refetch()}
          secondaryLabel={t('piece.close', { personality })}
          onSecondaryAction={() => router.back()}
        />
      </View>
    );
  }
  if (!view || !quote.data) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', backgroundColor: colors.bg, padding: 18 }}>
        <Card>
          <Text accessibilityRole="alert" style={[font('sub'), { color: colors.slate500 }]}>
            {t('piece.notFound', { personality })}
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
      onSharePdf={sharePdf ? () => void sharePdf() : undefined}
      actions={
        hasQuoteActions(q) ? <QuoteActions quote={q} customerName={view.customerName} /> : null
      }
    />
  );
}
