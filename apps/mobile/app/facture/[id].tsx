/**
 * Facture — détail de pièce (claim C16, réf dc.html §showPiece). La VUE vient de
 * buildPieceView (@bob/core, use case pur — parité d'actions) via PieceDetailView ;
 * les ACTIONS restent InvoiceActions (source unique, confirmations typées, mêmes use
 * cases que Bob). Nav croisée réelle : devis parent, avoir, situation (parentQuoteId).
 * Le PDF s'ouvre depuis le coffre (document lié) quand il existe — sinon pas de bouton.
 * L'aperçu comptable (fonctionnalité réelle antérieure) est conservé sous les mentions.
 */
import { useMemo, useRef, useState } from 'react';
import { Alert, Linking, Share, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { buildPieceView, normalizeVoiceText, type PieceLinkedRef, type PurchaseOrderRefInput } from '@bob/core';
import { challengeFor } from '@bob/ai';
import { t } from '@bob/i18n';
import { Card, ErrorRetry, SectionHeader, Skeleton, SkeletonCard, SkeletonHeader, font, useTheme } from '@bob/ui';
import { Button } from '@bob/ui';
import {
  useAttachInvoicePurchaseOrder,
  useCreateInvoiceViewLink,
  useCustomers,
  useDetachInvoicePurchaseOrder,
  useGenerateInvoice,
  useInvoice,
  useInvoiceAccountingPreview,
  useInvoicePaymentLink,
  useInvoices,
  useQuotes,
} from '../../src/data/hooks';
import { useDocuments } from '../../src/data/documents';
import { useBobClient } from '../../src/data/client';
import { shareDocument } from '../../src/lib/share-document';
import { goBackOrHome } from '../../src/lib/navigation';
import {
  isPaymentLinkEligible,
  matchesPaymentLinkUtterance,
} from '../../src/lib/payment-link-affordance';
import {
  InvoiceActions,
  canCreateCreditNote,
  hasInvoiceActions,
  isCollectible,
} from '../../src/components/DocumentActions';
import { AccountingLinesView } from '../../src/components/AccountingLinesView';
import { PieceDetailView } from '../../src/components/PieceDetailView';
import { PurchaseOrderCard, PurchaseOrderSheet } from '../../src/components/PurchaseOrderSection';
import { purchaseOrderErrorMessage } from '../../src/components/purchase-order-form.logic';
import { useConfirm } from '../../src/components/ConfirmSheet';
import {
  usePublishAgentContext,
  type AgentCapability,
  type AgentContext,
  type AgentAccessLayout,
  type AgentSurface,
} from '../../src/agent';

// B8 : retirer le bon de commande d'un BROUILLON est réversible (même palier de risque que
// les actions réversibles de DocumentActions — jamais une action fiscale avant émission).
const PO_REVERSIBLE = { mutating: true, outbound: false, riskTier: 'reversible' } as const;

export default function FactureDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { personality, colors, semantic } = useTheme();
  const router = useRouter();
  const client = useBobClient();
  const invoice = useInvoice(id);
  const viewLink = useCreateInvoiceViewLink();
  // S5 : MÊME hook que le bouton « Lien de paiement » (InvoiceActions) — présentation
  // 'manual' : c'est l'affordance vocale qui ouvre le Share natif et parle l'échec.
  const paymentLink = useInvoicePaymentLink('manual');
  const invoices = useInvoices();
  const quotes = useQuotes();
  const customers = useCustomers();
  const documents = useDocuments();
  const screenDataReady =
    invoice.data !== undefined &&
    invoices.data !== undefined &&
    quotes.data !== undefined &&
    customers.data !== undefined &&
    documents.data !== undefined &&
    !invoice.isError &&
    !invoices.isError &&
    !quotes.isError &&
    !customers.isError &&
    !documents.isError;
  const acct = useInvoiceAccountingPreview(id, !!invoice.data);
  const ledger = acct.data?.available ? acct.data : null;
  // Pont A1-C16 : générer la facture finale = MÊME use case que le briefing et que Bob
  // (generate-invoice-from-quote) — brouillon créé, on route dessus pour l'émettre.
  const generate = useGenerateInvoice();

  // ── B8 : bon de commande grands comptes — repris du devis à la dérivation, modifiable
  //    tant que la facture est BROUILLON (jamais un avoir : figé depuis la facture d'origine),
  //    figé à l'émission (lecture seule, mention visible). ──
  const confirm = useConfirm();
  const attachPo = useAttachInvoicePurchaseOrder();
  const detachPo = useDetachInvoicePurchaseOrder();
  const [poSheetOpen, setPoSheetOpen] = useState(false);
  const [poError, setPoError] = useState<string | null>(null);
  const poEditable =
    invoice.data?.status === 'draft' && invoice.data?.kind !== 'credit_note';
  const openPoSheet = (): void => {
    setPoError(null);
    setPoSheetOpen(true);
  };
  const submitPurchaseOrder = async (input: PurchaseOrderRefInput): Promise<void> => {
    setPoError(null);
    try {
      await attachPo.mutateAsync({
        invoiceId: id,
        purchaseOrder: input,
        expectedRevision: invoice.data?.revision ?? 1,
      });
      setPoSheetOpen(false);
    } catch (error) {
      setPoError(purchaseOrderErrorMessage(error, t('po.saveError', { personality })));
    }
  };
  const removePurchaseOrder = async (): Promise<void> => {
    const po = invoice.data?.purchaseOrder;
    if (!po) return;
    const ok = await confirm({
      title: t('po.removeConfirmTitle', { personality }),
      message: t('po.removeConfirmBody', { personality, params: { number: po.number } }),
      challenge: challengeFor(PO_REVERSIBLE, 'confirm_all'),
      destructive: true,
    });
    if (!ok) return;
    try {
      await detachPo.mutateAsync({ invoiceId: id, expectedRevision: invoice.data?.revision ?? 1 });
    } catch (error) {
      Alert.alert('Oups', purchaseOrderErrorMessage(error, t('po.saveError', { personality })));
    }
  };

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
    if (
      !inv
      || !screenDataReady
    ) {
      return {
        screen: { name: '/facture/[id]', instanceId: `invoice:${id}` },
        entities: [],
        capabilities: [],
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
  }, [customers.data, id, invoice.data, invoices.data, quotes.data, screenDataReady]);
  const agentLayout = useMemo<AgentAccessLayout>(() => ({ bottomAvoidance: 86 }), []);

  // R7 : « partage le lien de la facture » — dit + ouvre le Share (pattern établi), SANS
  // Sheet intermédiaire (aucun choix à faire, un seul geste). Refs : la surface est mémoïsée
  // une fois ([] deps) et doit lire l'état COURANT sans se recréer à chaque render.
  const invoiceNumberRef = useRef<string | null>(invoice.data?.number ?? null);
  invoiceNumberRef.current = invoice.data?.number ?? null;
  const canShareLinkRef = useRef(invoice.data?.number !== null && invoice.data?.number !== undefined);
  canShareLinkRef.current = invoice.data?.number !== null && invoice.data?.number !== undefined;
  const viewLinkRef = useRef(viewLink);
  viewLinkRef.current = viewLink;
  // S5 : « envoie le lien de paiement » — même hook que le bouton (parité structurelle via
  // isPaymentLinkEligible, la condition exacte de la branche bouton dans InvoiceActions).
  const paymentLinkRef = useRef(paymentLink);
  paymentLinkRef.current = paymentLink;
  const canSharePaymentLinkRef = useRef(
    invoice.data != null && isPaymentLinkEligible(invoice.data.status),
  );
  canSharePaymentLinkRef.current = invoice.data != null && isPaymentLinkEligible(invoice.data.status);
  const personalityRef = useRef(personality);
  personalityRef.current = personality;
  const invoiceVoiceSurface = useMemo<AgentSurface>(
    () => ({
      affordances: [
        {
          // S5 : lien de PAIEMENT à la voix — MÊME flux useInvoicePaymentLink que le bouton
          // « Lien de paiement », présenté via le Share natif : AUCUN envoi sortant tant que
          // le Share n'est pas complété par l'utilisateur (doctrine devis.shareViewLink).
          // Testée AVANT shareViewLink : la phrase contient « lien » et serait sinon
          // consommée par elle (premier match gagne, cf. agent-session §affordances).
          id: 'facture.sharePaymentLink',
          match: (utterance) => {
            if (!canSharePaymentLinkRef.current) return null;
            if (!matchesPaymentLinkUtterance(utterance)) return null;
            return async () => {
              const p = personalityRef.current;
              try {
                const result = await paymentLinkRef.current.mutateAsync(id);
                await Share.share({
                  message: `Bonjour, voici le lien pour régler la facture${invoiceNumberRef.current ? ` ${invoiceNumberRef.current}` : ''} : ${result.url}`,
                });
                return { say: t('facture.voice.shareLinkOpened', { personality: p }) };
              } catch {
                return { say: t('piece.shareLinkError', { personality: p }) };
              }
            };
          },
        },
        {
          // Contient « lien » mais PAS « paiement » : l'affordance paiement ci-dessus est
          // testée AVANT et consomme déjà ces phrases-là (même doctrine que devis/signature).
          id: 'facture.shareViewLink',
          match: (utterance) => {
            if (!canShareLinkRef.current) return null;
            const n = normalizeVoiceText(utterance);
            if (!/\b(partage|partager|envoie|envoyer)\b/.test(n) || !/\blien\b/.test(n) || /\bpaiement\b/.test(n))
              return null;
            return async () => {
              const p = personalityRef.current;
              try {
                const result = await viewLinkRef.current.mutateAsync(id);
                await Share.share({
                  message: `Bonjour, voici le lien pour consulter la facture${invoiceNumberRef.current ? ` ${invoiceNumberRef.current}` : ''} : ${result.viewUrl}`,
                });
                return { say: t('facture.voice.shareLinkOpened', { personality: p }) };
              } catch {
                return { say: t('piece.shareLinkError', { personality: p }) };
              }
            };
          },
        },
      ],
    }),
    [],
  );
  usePublishAgentContext(agentContext, agentLayout, invoiceVoiceSurface);

  // Lien public de VISUALISATION (canal universel, sans e-mail) — facture ÉMISE uniquement
  // (jamais un brouillon). SANS AUCUN sortant tant que le Share natif n'est pas complété.
  const shareViewLink = invoice.data && invoice.data.number !== null
    ? async (): Promise<void> => {
        try {
          const result = await viewLink.mutateAsync(id);
          await Share.share({
            message: `Bonjour, voici le lien pour consulter la facture${invoice.data?.number ? ` ${invoice.data.number}` : ''} : ${result.viewUrl}`,
          });
        } catch {
          Alert.alert('Oups', t('piece.shareLinkError', { personality }));
        }
      }
    : null;

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

  if (
    invoice.isLoading
    || invoices.isLoading
    || quotes.isLoading
    || customers.isLoading
    || documents.isLoading
  ) {
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
  if (
    invoice.isError
    || invoices.isError
    || quotes.isError
    || customers.isError
    || documents.isError
  ) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', backgroundColor: colors.bg, padding: 18 }}>
        <ErrorRetry
          message={t('piece.dataError', { personality })}
          onRetry={() => {
            void Promise.all([
              invoice.refetch(),
              invoices.refetch(),
              quotes.refetch(),
              customers.refetch(),
              documents.refetch(),
            ]);
          }}
          retrying={
            invoice.isRefetching ||
            invoices.isRefetching ||
            quotes.isRefetching ||
            customers.isRefetching ||
            documents.isRefetching
          }
          secondaryLabel={t('piece.close', { personality })}
          onSecondaryAction={() => router.back()}
        />
      </View>
    );
  }
  // « Introuvable » n'est pas un cul-de-sac non plus (S7) : réessayer (la pièce peut
  // apparaître après sync) ET fermer — sortie sûre même sans pile derrière (deep link),
  // via le helper partagé avec devis/[id] (pattern client/chantier).
  if (!view || !invoice.data) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', backgroundColor: colors.bg, padding: 18 }}>
        <ErrorRetry
          message={t('piece.notFound', { personality })}
          onRetry={() => void invoice.refetch()}
          retrying={invoice.isRefetching}
          secondaryLabel={t('piece.close', { personality })}
          onSecondaryAction={() => goBackOrHome(router)}
        />
      </View>
    );
  }
  const inv = invoice.data;
  // B8 : réassurance à l'étape « Facturer le solde » — le devis parent porte un bon de
  // commande, il sera repris sur la facture générée (aucune re-saisie).
  const nextStepPurchaseOrder = view.nextStep
    ? ((quotes.data ?? []).find((q) => q.id === view.nextStep!.quoteId)?.purchaseOrder ?? null)
    : null;

  return (
    <>
    <PieceDetailView
      view={view}
      onClose={() => router.back()}
      onOpenQuote={(ref: PieceLinkedRef) => router.push(`/devis/${ref.id}`)}
      onOpenInvoice={(ref: PieceLinkedRef) => router.push(`/facture/${ref.id}`)}
      onOpenPdf={openPdf ? () => void openPdf() : undefined}
      onSharePdf={sharePdf ? () => void sharePdf() : undefined}
      onShareLink={shareViewLink ? () => void shareViewLink() : undefined}
      actions={
        hasInvoiceActions(inv) || canCreateCreditNote(inv) ? (
          // withCreditNote (A6) : « Créer un avoir » — détail uniquement, jamais en liste.
          // onDraftDeleted (R6) : le brouillon supprimé n'existe plus, l'écran de détail se ferme.
          <InvoiceActions invoice={inv} withCreditNote onDraftDeleted={() => router.back()} />
        ) : null
      }
      nextStepAction={
        view.nextStep ? (
          <View style={{ gap: 10 }}>
            {nextStepPurchaseOrder ? (
              // B8 : le numéro d'engagement suit tout seul — réassurance, pas de re-saisie.
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 7,
                  backgroundColor: semantic.successBg,
                  borderRadius: 10,
                  paddingVertical: 9,
                  paddingHorizontal: 12,
                }}
              >
                <Text style={{ ...font('meta', 600), fontSize: 12.5, color: semantic.success, flex: 1 }}>
                  {t('po.carriedToInvoice', {
                    personality,
                    params: { number: nextStepPurchaseOrder.number },
                  })}
                </Text>
              </View>
            ) : null}
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
          </View>
        ) : null
      }
      extra={
        <>
        {/* B8 : section « Bon de commande » — éditable sur BROUILLON (hors avoir), lecture
            seule dès l'émission (mention « figé à l'émission » visible). */}
        {poEditable || inv.purchaseOrder != null ? (
          <PurchaseOrderCard
            purchaseOrder={inv.purchaseOrder ?? null}
            editable={poEditable}
            frozen={inv.purchaseOrder != null && inv.status !== 'draft'}
            emptyBody={t('po.emptyInvoiceBody', { personality })}
            documents={documents.data ?? []}
            onAdd={openPoSheet}
            onEdit={openPoSheet}
            onRemove={() => void removePurchaseOrder()}
            onOpenDocument={(documentId) => router.push(`/documents/${documentId}`)}
          />
        ) : null}
        {
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
              retrying={acct.isRefetching}
            />
          </Card>
        ) : acct.data?.available === false ? (
          <Card>
            <SectionHeader title="Écriture comptable" />
            <Text accessibilityRole="alert" style={[font('meta'), { color: colors.slate500 }]}>
              {acct.data.reason}
            </Text>
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
        </>
      }
    />
    <PurchaseOrderSheet
      visible={poSheetOpen}
      initial={inv.purchaseOrder ?? null}
      documents={documents.data ?? []}
      saving={attachPo.isPending}
      error={poError}
      onClose={() => {
        if (attachPo.isPending) return;
        setPoSheetOpen(false);
        setPoError(null);
      }}
      onInputChange={() => setPoError(null)}
      onSubmit={(input) => void submitPurchaseOrder(input)}
    />
    </>
  );
}
