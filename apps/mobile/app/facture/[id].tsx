/**
 * Facture — détail de pièce (claim C16, réf dc.html §showPiece). La VUE vient de
 * buildPieceView (@bob/core, use case pur — parité d'actions) via PieceDetailView ;
 * les ACTIONS restent InvoiceActions (source unique, confirmations typées, mêmes use
 * cases que Bob). Nav croisée réelle : devis parent, avoir, situation (parentQuoteId).
 * Le PDF s'ouvre depuis le coffre (document lié) quand il existe — sinon pas de bouton.
 * L'aperçu comptable (fonctionnalité réelle antérieure) est conservé sous les mentions.
 */
import { useMemo } from 'react';
import { Alert, Linking, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { buildPieceView, type PieceLinkedRef } from '@bob/core';
import { t } from '@bob/i18n';
import { Card, ErrorRetry, SectionHeader, Skeleton, SkeletonCard, SkeletonHeader, font, useTheme } from '@bob/ui';
import { Button } from '@bob/ui';
import {
  useCustomers,
  useGenerateInvoice,
  useInvoice,
  useInvoiceAccountingPreview,
  useInvoices,
  useQuotes,
} from '../../src/data/hooks';
import { useDocuments } from '../../src/data/documents';
import { useBobClient } from '../../src/data/client';
import { shareDocument } from '../../src/lib/share-document';
import {
  InvoiceActions,
  canCreateCreditNote,
  hasInvoiceActions,
  isCollectible,
} from '../../src/components/DocumentActions';
import { AccountingLinesView } from '../../src/components/AccountingLinesView';
import { PieceDetailView } from '../../src/components/PieceDetailView';
import {
  usePublishAgentContext,
  type AgentCapability,
  type AgentContext,
  type AgentAccessLayout,
} from '../../src/agent';

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
  // Pont A1-C16 : générer la facture finale = MÊME use case que le briefing et que Bob
  // (generate-invoice-from-quote) — brouillon créé, on route dessus pour l'émettre.
  const generate = useGenerateInvoice();

  const view = useMemo(() => {
    const inv = invoice.data;
    if (!inv) return null;
    const customer = (customers.data ?? []).find((c) => c.id === inv.customerId) ?? null;
    const parent = inv.parentQuoteId
      ? (quotes.data ?? []).find((q) => q.id === inv.parentQuoteId)
      : undefined;
    // Pièces sœurs du même devis parent : avoir émis / situation liée (réel, sans ambiguïté).
    const siblings = inv.parentQuoteId
      ? (invoices.data ?? []).filter(
          (i) => i.parentQuoteId === inv.parentQuoteId && i.id !== inv.id,
        )
      : [];
    const credit = siblings.find((i) => i.kind === 'credit_note');
    const situation = siblings.find((i) => i.kind === 'situation');
    const deposit = siblings.find((i) => i.kind === 'deposit');
    const hasFinalInvoice = siblings.some((i) => i.kind === 'final');
    return buildPieceView({
      source: 'invoice',
      invoice: inv,
      customer,
      hasFinalInvoice,
      ...(parent
        ? { parentQuote: { id: parent.id, number: parent.number, ttcCents: parent.totals.ttc } }
        : {}),
      ...(credit
        ? { creditNote: { id: credit.id, number: credit.number, ttcCents: credit.totals.ttc } }
        : {}),
      ...(situation
        ? {
            situation: {
              id: situation.id,
              number: situation.number,
              ttcCents: situation.totals.ttc,
            },
          }
        : {}),
      ...(deposit
        ? {
            depositInvoice: {
              id: deposit.id,
              number: deposit.number,
              ttcCents: deposit.totals.netToPay,
            },
          }
        : {}),
    });
  }, [invoice.data, invoices.data, quotes.data, customers.data]);
  const agentContext = useMemo<AgentContext>(() => {
    const inv = invoice.data;
    if (!inv) {
      return {
        screen: { name: '/facture/[id]', instanceId: `invoice:${id}` },
        entities: [],
        capabilities: ['screen.read'],
      };
    }
    const customer = (customers.data ?? []).find((item) => item.id === inv.customerId);
    const actionCapabilities: AgentCapability[] = [
      ...(inv.status === 'draft' ? (['invoice.issue', 'invoice.draft_line.update'] as const) : []),
      ...(isCollectible(inv) ? (['invoice.collect'] as const) : []),
      ...(canCreateCreditNote(inv) ? (['invoice.credit_note.create'] as const) : []),
    ];
    return {
      screen: { name: '/facture/[id]', instanceId: `invoice:${inv.id}` },
      entities: [
        {
          type: 'invoice' as const,
          id: inv.id,
          label: inv.number ? `Facture ${inv.number}` : 'Facture brouillon',
        },
        ...(customer ? [{ type: 'customer' as const, id: customer.id, label: customer.name }] : []),
        ...inv.lines.slice(0, 18).map((line, index) => ({
          type: 'invoice_line' as const,
          id: line.id,
          label: `${index + 1} · ${line.label}`,
        })),
      ],
      capabilities: ['screen.read', 'invoice.read', ...actionCapabilities],
    };
  }, [customers.data, id, invoice.data]);
  const agentLayout = useMemo<AgentAccessLayout>(() => ({ bottomAvoidance: 86 }), []);
  usePublishAgentContext(agentContext, agentLayout);

  // PDF archivé au coffre (document lié à la facture) — bouton absent sinon (pas de chemin fantôme).
  const pdfDoc = useMemo(
    () =>
      (documents.data ?? []).find(
        (d) =>
          d.linkedEntityType === 'invoice' && d.linkedEntityId === id && d.kind === 'invoice_pdf',
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

  if (invoice.isLoading || customers.isLoading) {
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
  if (invoice.isError) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', backgroundColor: colors.bg, padding: 18 }}>
        <ErrorRetry
          message={t('piece.dataError', { personality })}
          onRetry={() => void invoice.refetch()}
          secondaryLabel={t('piece.close', { personality })}
          onSecondaryAction={() => router.back()}
        />
      </View>
    );
  }
  if (!view || !invoice.data) {
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
  const inv = invoice.data;

  return (
    <PieceDetailView
      view={view}
      onClose={() => router.back()}
      onOpenQuote={(ref: PieceLinkedRef) => router.push(`/devis/${ref.id}`)}
      onOpenInvoice={(ref: PieceLinkedRef) => router.push(`/facture/${ref.id}`)}
      onOpenPdf={openPdf ? () => void openPdf() : undefined}
      onSharePdf={sharePdf ? () => void sharePdf() : undefined}
      actions={
        hasInvoiceActions(inv) || canCreateCreditNote(inv) ? (
          // withCreditNote (A6) : « Créer un avoir » — détail uniquement, jamais en liste.
          <InvoiceActions invoice={inv} withCreditNote />
        ) : null
      }
      nextStepAction={
        view.nextStep ? (
          <Button
            title={t('piece.actionFacturerSolde', { personality })}
            variant="primary"
            size="compact"
            radius={12}
            loading={generate.isPending}
            style={{ alignSelf: 'flex-start' }}
            onPress={() =>
              generate.mutate(
                { quoteId: view.nextStep!.quoteId, mode: 'final' },
                { onSuccess: (out) => router.push(`/facture/${out.invoiceId}`) },
              )
            }
          />
        ) : null
      }
      extra={
        // Un échec réseau de l'aperçu comptable ne doit JAMAIS ressembler à « pas
        // d'écriture » (bug P2 de l'audit) : loading/erreur/absence sont distingués.
        acct.isLoading ? (
          <Card>
            <SectionHeader title="Écriture comptable" />
            <Skeleton width="55%" height={12} style={{ marginTop: 2, marginBottom: 8 }} />
            <Skeleton width="85%" height={12} />
          </Card>
        ) : acct.isError ? (
          <Card>
            <SectionHeader title="Écriture comptable" />
            <ErrorRetry
              message={t('piece.accountingError', { personality })}
              onRetry={() => void acct.refetch()}
            />
          </Card>
        ) : ledger && ledger.lines.length > 0 ? (
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
