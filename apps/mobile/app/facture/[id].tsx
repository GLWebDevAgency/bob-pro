/**
 * Facture — détail de pièce (claim C16, réf dc.html §showPiece). La VUE vient de
 * buildPieceView (@bob/core, use case pur — parité d'actions) via PieceDetailView ;
 * les ACTIONS restent InvoiceActions (source unique, confirmations typées, mêmes use
 * cases que Bob). Nav croisée réelle : devis parent, avoir, situation (parentQuoteId).
 * Le PDF s'ouvre depuis le coffre (document lié) quand il existe — sinon pas de bouton.
 * L'aperçu comptable (fonctionnalité réelle antérieure) est conservé sous les mentions.
 */
import { useMemo, useRef, useState } from 'react';
import { Alert, Linking, Pressable, Share, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { buildPieceView, formatDateOnlyFr, normalizeVoiceText, parisDateOnly, type PieceLinkedRef, type PurchaseOrderRefInput } from '@bob/core';
import { challengeFor } from '@bob/ai';
import { t } from '@bob/i18n';
import { Card, ErrorRetry, SectionHeader, Sheet, Skeleton, SkeletonCard, SkeletonHeader, StatusBadge, font, useTheme } from '@bob/ui';
import { Button } from '@bob/ui';
import { dueLineForInvoice } from '../../src/components/customer-terms.logic';
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
  useMaintenanceContract,
  useNotificationsFeed,
  useQuotes,
  useRecordInvoiceTransmission,
  useUpdateInvoiceServicePeriod,
  appErrorMessage,
} from '../../src/data/hooks';
import {
  relanceHistoryForInvoice,
  relanceHistoryStatusKey,
} from '../../src/components/invoice-relance-history.logic';
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
  const { personality, colors, semantic, controls } = useTheme();
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
  // PR-02 — déclaration « envoyée le » du canal email (le déclaratif chorus/portail existait déjà).
  const recordTransmission = useRecordInvoiceTransmission();
  // PR-06 — historique des relances de CETTE facture = filtre du fil serveur (aucun état parallèle).
  const notificationsFeed = useNotificationsFeed();
  const relanceHistory = useMemo(
    () => relanceHistoryForInvoice(notificationsFeed.items, id),
    [notificationsFeed.items, id],
  );
  const [poSheetOpen, setPoSheetOpen] = useState(false);
  const [poError, setPoError] = useState<string | null>(null);
  const poEditable =
    invoice.data?.status === 'draft' && invoice.data?.kind !== 'credit_note';
  // ── Écrans §6.5 : bloc « Contrat : {label} · Période : … » — le brouillon annuel MONTRE le
  //    contrat et la période qu'il porte ; la période est éditable en BROUILLON (le remède que
  //    la garde d'émission indique), figée à l'émission (mention visible). ──
  const invoiceContractId = invoice.data?.maintenanceContractId ?? null;
  // Label du contrat : lecture fail-soft (capacité optionnelle du transport) — sans elle, le
  // bloc affiche la période seule, jamais un label inventé.
  const contractView = useMaintenanceContract(
    invoiceContractId ?? '',
    invoiceContractId !== null && client.getMaintenanceContract !== undefined,
  );
  const updatePeriod = useUpdateInvoiceServicePeriod();
  const [periodDraft, setPeriodDraft] = useState<{ start: string; end: string } | null>(null);
  const [periodError, setPeriodError] = useState<string | null>(null);
  const periodEditable = invoiceContractId !== null && poEditable;
  const openPeriodSheet = (): void => {
    setPeriodError(null);
    setPeriodDraft({
      start: invoice.data?.servicePeriod?.start ?? '',
      end: invoice.data?.servicePeriod?.end ?? '',
    });
  };
  const submitPeriod = async (): Promise<void> => {
    if (periodDraft === null) return;
    const start = periodDraft.start.trim();
    const end = periodDraft.end.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      setPeriodError(t('contrat.dateInvalid', { personality }));
      return;
    }
    setPeriodError(null);
    try {
      await updatePeriod.mutateAsync({
        invoiceId: id,
        expectedRevision: invoice.data?.revision ?? 1,
        servicePeriod: { start, end },
      });
      setPeriodDraft(null);
    } catch (error) {
      // Refus du DOMAINE (fin < début, déjà émise…) restitués verbatim — actionnables.
      setPeriodError(appErrorMessage(error));
    }
  };
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
    // E3 : l'avoir qui annule CETTE facture — identité FIGÉE creditNoteSource d'abord (précis :
    // l'avoir d'une pièce sœur ne s'affiche plus ici, et les factures hors devis sont couvertes) ;
    // repli siblings pour les projections antérieures sans snapshot (compat ascendante).
    // La réf inverse (avoir → facture d'origine) voyage, elle, DANS inv.creditNoteSource :
    // buildPieceView en dérive view.sourceInvoice sans recalcul côté écran.
    const credit =
      (invoices.data ?? []).find(
        (i) => i.kind === 'credit_note' && i.creditNoteSource?.invoiceId === inv.id,
      ) ?? siblings.find((i) => i.kind === 'credit_note' && i.creditNoteSource == null);
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
  // B4 — échéance dérivée AFFICHÉE à l'émission : date SERVEUR (inv.dueAt) + libellé des
  // conditions du client (« Échéance : 12/09/2026 — 45 jours fin de mois »). Jamais sur un
  // brouillon (pas d'échéance avant émission).
  const invoiceCustomer = (customers.data ?? []).find((c) => c.id === inv.customerId) ?? null;
  const dueLine =
    inv.status !== 'draft' && inv.status !== 'cancelled'
      ? dueLineForInvoice(inv.dueAt, invoiceCustomer?.paymentTerms ?? null, personality)
      : null;
  // Canal de facturation : guide de dépôt (chorus/portail) embarqué par GET /invoices/:id
  // d'une pièce émise — l'entrée n'existe que si le serveur a fourni le guide (état honnête).
  const transmissionGuide =
    inv.transmissionGuide !== undefined && inv.transmissionGuide.channel !== 'email'
      ? inv.transmissionGuide
      : null;
  // PR-02 — suivi de transmission du canal EMAIL (« envoyée le ») : preuve serveur (outbox)
  // d'abord, déclaration manuelle sinon (facture partagée par WhatsApp/SMS/mail perso). Les
  // deux faits doivent être TRANSPORTÉS pour affirmer « jamais transmise » (fail-closed).
  const emailChannel =
    inv.transmissionGuide !== undefined && inv.transmissionGuide.channel === 'email';
  const emailSentLine = !emailChannel
    ? null
    : inv.emailDeliveredAt != null
      ? t('facture.emailDeliveredOn', {
          personality,
          params: { date: formatDateOnlyFr(inv.emailDeliveredAt.slice(0, 10)) },
        })
      : inv.transmission?.depositedAt != null
        ? t('facture.declaredSentOn', {
            personality,
            params: { date: formatDateOnlyFr(inv.transmission.depositedAt) },
          })
        : null;
  const showNeverTransmitted =
    emailChannel &&
    emailSentLine === null &&
    inv.status === 'issued' &&
    inv.kind !== 'credit_note' &&
    inv.emailDeliveredAt !== undefined &&
    inv.transmission !== undefined;
  const markSentToday = (): void =>
    void (async () => {
      const ok = await confirm({
        title: t('facture.markSentConfirmTitle', { personality }),
        message: t('facture.markSentConfirmBody', { personality }),
        challenge: challengeFor(PO_REVERSIBLE, 'confirm_all'),
      });
      if (!ok) return;
      try {
        await recordTransmission.mutateAsync({
          invoiceId: id,
          // Date DÉCLARÉE = calendrier MÉTIER Paris (convention du repo — même helper que
          // l'écran transmission), jamais un slice UTC qui décale la veille après 22 h/23 h.
          depositedAt: parisDateOnly(),
        });
      } catch (error) {
        Alert.alert('Oups', appErrorMessage(error));
      }
    })();
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
          <InvoiceActions
            invoice={inv}
            withCreditNote
            onDraftDeleted={() => router.back()}
            // PR-04 : « saisir le BC maintenant » ouvre la feuille BC de CETTE fiche.
            onRequestPurchaseOrder={openPoSheet}
          />
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
        {dueLine !== null ? (
          // B4 — l'échéance dérivée des conditions du client, visible dès l'émission.
          <Card>
            <Text style={{ ...font('sub', 700), color: colors.ink800, fontVariant: ['tabular-nums'] }}>
              {dueLine}
            </Text>
          </Card>
        ) : null}
        {emailSentLine !== null ? (
          // PR-02 — transmission PROUVÉE (outbox) ou DÉCLARÉE (« envoyée le ») du canal email.
          <Card>
            <Text style={[font('meta', 700), { fontSize: 12.5, color: semantic.success }]}>
              {emailSentLine}
            </Text>
          </Card>
        ) : showNeverTransmitted ? (
          // PR-02 — émise, JAMAIS transmise : l'état honnête + la sortie déclarative (la pièce
          // est peut-être partie par un autre canal — WhatsApp, courrier — que Bob ne voit pas).
          <Card>
            <Text style={[font('sub', 700), { color: semantic.warning }]}>
              {t('facture.neverTransmitted', { personality })}
            </Text>
            <Text style={[font('meta', 500), { fontSize: 12.5, color: colors.slate400, marginTop: 4 }]}>
              {t('facture.neverTransmittedHint', { personality })}
            </Text>
            <Button
              title={t('facture.markSentAction', { personality })}
              variant="secondary"
              size="compact"
              radius={11}
              loading={recordTransmission.isPending}
              style={{ alignSelf: 'flex-start', marginTop: 10 }}
              onPress={markSentToday}
            />
          </Card>
        ) : null}
        {transmissionGuide !== null ? (
          // Canal chorus/portail : ENTRÉE du guide de dépôt pas-à-pas + état du suivi déclaré.
          <Card>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('guide.entryTitle', { personality })}
              onPress={() => router.push(`/facture/transmission/${id}`)}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                minHeight: 44,
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <View style={{ flex: 1 }}>
                <Text style={[font('cardTitle'), { fontSize: 15, color: colors.ink900 }]}>
                  {t('guide.entryTitle', { personality })}
                </Text>
                <Text style={[font('meta', 500), { fontSize: 12.5, color: colors.slate400, marginTop: 2 }]}>
                  {t(
                    transmissionGuide.channel === 'chorus'
                      ? 'guide.entrySubtitleChorus'
                      : 'guide.entrySubtitlePortail',
                    { personality },
                  )}
                </Text>
                {inv.transmission?.depositedAt != null ? (
                  <Text style={[font('meta', 700), { fontSize: 12, color: semantic.success, marginTop: 4 }]}>
                    {inv.transmission.acceptedAt != null
                      ? t('guide.acceptedOn', {
                          personality,
                          params: { date: formatDateOnlyFr(inv.transmission.acceptedAt) },
                        })
                      : t('guide.depositedOn', {
                          personality,
                          params: { date: formatDateOnlyFr(inv.transmission.depositedAt) },
                        })}
                  </Text>
                ) : null}
              </View>
              <StatusBadge
                label={
                  transmissionGuide.channel === 'chorus'
                    ? t('canal.chorus', { personality })
                    : t('canal.portail', { personality })
                }
                variant="b2g"
              />
            </Pressable>
          </Card>
        ) : null}
        {relanceHistory.length > 0 ? (
          // PR-06 — « Relances » : ce que le fil serveur SAIT de cette pièce (jobs
          // invoice-relance), statut honnête par ligne — jamais un envoi affirmé sans preuve.
          <Card>
            <SectionHeader title={t('facture.relanceHistoryTitle', { personality })} />
            <View style={{ gap: 8 }}>
              {relanceHistory.map((entry) => (
                <View
                  key={entry.id}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={[font('sub', 600), { fontSize: 13.5, color: colors.ink800 }]} numberOfLines={1}>
                      {entry.title}
                    </Text>
                    <Text style={[font('meta', 500), { fontSize: 12, color: colors.slate400, marginTop: 1 }]}>
                      {formatDateOnlyFr(entry.createdAt.slice(0, 10))}
                    </Text>
                  </View>
                  <StatusBadge
                    label={t(relanceHistoryStatusKey(entry.status), { personality })}
                    variant={
                      entry.status === 'done' ? 'success' : entry.status === 'failed' ? 'danger' : 'b2b'
                    }
                  />
                </View>
              ))}
            </View>
          </Card>
        ) : null}
        {invoiceContractId !== null ? (
          // Écrans §6.5 : « Contrat : {label} · Période : … » — bloc info du brouillon annuel,
          // période éditable en BROUILLON, figée à l'émission (trigger étendu). Les refus
          // d'émission (« période déjà facturée par {n°} », « facture de contrat sans
          // période ») s'affichent tels quels par le canal d'erreur existant.
          <Card>
            <SectionHeader title={t('facture.contractBlockTitle', { personality })} />
            <Pressable
              accessibilityRole={contractView.data ? 'button' : 'text'}
              accessibilityLabel={t('facture.contractLabel', {
                personality,
                params: { label: contractView.data?.contract.label ?? '…' },
              })}
              disabled={!contractView.data}
              onPress={() => router.push(`/contrat/${invoiceContractId}`)}
              style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
            >
              {contractView.data ? (
                <Text style={[font('sub', 700), { color: colors.ink800 }]}>
                  {t('facture.contractLabel', {
                    personality,
                    params: { label: contractView.data.contract.label },
                  })}
                </Text>
              ) : null}
              {inv.servicePeriod?.start != null && inv.servicePeriod.end != null ? (
                <Text
                  style={[
                    font('sub', 600),
                    { color: colors.ink800, marginTop: contractView.data ? 4 : 0, fontVariant: ['tabular-nums'] },
                  ]}
                >
                  {t('facture.contractPeriod', {
                    personality,
                    params: {
                      start: formatDateOnlyFr(inv.servicePeriod.start),
                      end: formatDateOnlyFr(inv.servicePeriod.end),
                    },
                  })}
                </Text>
              ) : (
                <Text style={[font('sub', 700), { color: semantic.warning, marginTop: 4 }]}>
                  {t('facture.contractPeriodMissing', { personality })}
                </Text>
              )}
            </Pressable>
            {periodEditable ? (
              <Button
                title={t('facture.contractPeriodEditCta', { personality })}
                variant="secondary"
                size="compact"
                radius={11}
                style={{ alignSelf: 'flex-start', marginTop: 10 }}
                onPress={openPeriodSheet}
              />
            ) : inv.servicePeriod != null ? (
              <Text style={[font('meta', 500), { fontSize: 12.5, color: colors.slate400, marginTop: 6 }]}>
                {t('facture.contractPeriodFrozen', { personality })}
              </Text>
            ) : null}
          </Card>
        ) : null}
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
    <Sheet
      visible={periodDraft !== null}
      onClose={() => {
        if (!updatePeriod.isPending) setPeriodDraft(null);
      }}
      accessibilityLabel={t('facture.contractPeriodSheetTitle', { personality })}
    >
      <Text style={[font('section'), { color: colors.ink800, marginBottom: 10 }]}>
        {t('facture.contractPeriodSheetTitle', { personality })}
      </Text>
      <View style={{ gap: 8 }}>
        {(
          [
            { key: 'start' as const, labelKey: 'facture.contractPeriodStartField' as const },
            { key: 'end' as const, labelKey: 'facture.contractPeriodEndField' as const },
          ]
        ).map((field) => (
          <TextInput
            key={field.key}
            value={periodDraft?.[field.key] ?? ''}
            onChangeText={(value) => {
              setPeriodError(null);
              setPeriodDraft((current) =>
                current === null ? current : { ...current, [field.key]: value },
              );
            }}
            placeholder={t(field.labelKey, { personality })}
            placeholderTextColor={colors.slate400}
            accessibilityLabel={t(field.labelKey, { personality })}
            autoCapitalize="none"
            style={[
              font('body'),
              {
                minHeight: 44,
                borderWidth: 1,
                borderColor: controls.cardBorder,
                borderRadius: 12,
                paddingHorizontal: 12,
                color: colors.ink800,
                backgroundColor: colors.surface,
                fontVariant: ['tabular-nums'],
              },
            ]}
          />
        ))}
        {periodError ? (
          <Text accessibilityLiveRegion="polite" style={[font('sub', 500), { color: semantic.danger }]}>
            {periodError}
          </Text>
        ) : null}
        <Button
          title={t('facture.contractPeriodSaveCta', { personality })}
          loading={updatePeriod.isPending}
          onPress={() => void submitPeriod()}
        />
      </View>
    </Sheet>
    </>
  );
}
