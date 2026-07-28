/**
 * Devis — détail de pièce (claim C16, réf dc.html §showPiece). VUE = buildPieceView
 * (@bob/core, use case pur : acompte proportionnel — test d'or 488,40) via PieceDetailView ;
 * ACTIONS = QuoteActions (source unique, confirmations typées, mêmes use cases que Bob).
 * Nav croisée réelle : première facture issue du devis (parentQuoteId).
 */
import { useMemo, useRef, useState } from 'react';
import { Alert, Linking, Share, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { buildPieceView, frSpokenNumbersToDigits, normalizeVoiceText, parisDateOnly, type PieceLineView, type PieceLinkedRef, type PurchaseOrderRefInput } from '@bob/core';
import { challengeFor } from '@bob/ai';
import { PERSONALITY_LABELS, t } from '@bob/i18n';
import { Button, Card, ErrorRetry, FadeIn, SectionHeader, SkeletonCard, SkeletonHeader, font, useTheme } from '@bob/ui';
import {
  appErrorMessage,
  useAttachQuotePurchaseOrder,
  useCreateQuoteViewLink,
  useCustomers,
  useDetachQuotePurchaseOrder,
  useDuplicateQuote,
  useInvoices,
  useQuote,
  useRemoveQuoteLine,
  useUpdateQuoteLine,
} from '../../src/data/hooks';
import { useDocuments } from '../../src/data/documents';
import { useBobClient } from '../../src/data/client';
import { shareDocument } from '../../src/lib/share-document';
import { goBackOrHome } from '../../src/lib/navigation';
import {
  QuoteActions,
  hasQuoteActions,
  type QuoteActionsHandle,
  type QuoteLinkedInvoices,
} from '../../src/components/DocumentActions';
import { Badge } from '../../src/components/ui';
import { ShareQuoteLinkButton } from '../../src/components/ShareQuoteLinkButton';
import { quoteRelancePromptOf } from '../../src/components/quote-relance-prompt.logic';
import { PieceDetailView } from '../../src/components/PieceDetailView';
import { QuoteLineEditSheet, type QuoteLineEditPatch, type QuoteLineEditSeed } from '../../src/components/QuoteLineEditSheet';
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

// R6 : mêmes paliers de risque que DocumentActions (l'édition/suppression de ligne reste
// DRAFT-only, reversible tant que le devis n'est pas signé — jamais une action fiscale).
const REVERSIBLE = { mutating: true, outbound: false, riskTier: 'reversible' } as const;

const ORDINAL_WORDS: Readonly<Record<string, number>> = {
  premiere: 1, premier: 1, deuxieme: 2, troisieme: 3, quatrieme: 4, cinquieme: 5,
  sixieme: 6, septieme: 7, huitieme: 8, neuvieme: 9, dixieme: 10,
};

/** « ligne 2 » / « ligne deux » (déjà digitisé) OU « la deuxième ligne » (mot ordinal). */
function resolveLineOrdinal(digits: string): number | null {
  const afterLigne = /\bligne (\d{1,2})\b/.exec(digits);
  if (afterLigne?.[1] !== undefined) return Number(afterLigne[1]);
  const beforeLigne = /\b(premiere|premier|deuxieme|troisieme|quatrieme|cinquieme|sixieme|septieme|huitieme|neuvieme|dixieme) ligne\b/.exec(digits);
  if (beforeLigne?.[1] !== undefined) return ORDINAL_WORDS[beforeLigne[1]] ?? null;
  return null;
}

/** « mets 3 heures » / « mets 2 jours » — nouvelle quantité énoncée (préremplissage, R7). */
function extractLineQtyPatch(digits: string): number | null {
  const m = /\bmets? (\d{1,3}(?:[.,]\d{1,2})?) ?(heures?|h\b|jours?|unites?|pieces?)/.exec(digits);
  if (!m || m[1] === undefined) return null;
  const n = Number(m[1].replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** « à 60 euros » — nouveau prix unitaire énoncé (préremplissage, R7). */
function extractLinePricePatch(digits: string): number | null {
  const m = /\b(?:a|à) (\d[\d ]*(?:,\d{1,2})?) ?(?:€|euros?)/.exec(digits);
  if (!m || m[1] === undefined) return null;
  const n = Number(m[1].replace(/\s+/g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}

export default function DevisDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { personality, colors, controls } = useTheme();
  const router = useRouter();
  const client = useBobClient();
  const quote = useQuote(id);
  const viewLink = useCreateQuoteViewLink();
  const customers = useCustomers();
  const invoices = useInvoices();
  const documents = useDocuments();
  const screenDataReady =
    quote.data !== undefined &&
    customers.data !== undefined &&
    invoices.data !== undefined &&
    documents.data !== undefined &&
    !quote.isError &&
    !customers.isError &&
    !invoices.isError &&
    !documents.isError;

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
  // PR-05 — la promesse du rappel « un message pré-rédigé vous attend » (deep link /devis/[id])
  // est tenue ICI : au palier atteint (MÊME dérivation quoteRelancePalierOf que le cron), la
  // fiche expose le message buildQuoteRelance prêt à partager (même copy que la carte
  // Aujourd'hui). Calendrier MÉTIER Paris — le même ancrage que le rappel reçu.
  const relancePrompt = useMemo(() => {
    const q = quote.data;
    if (!q || !view) return null;
    return quoteRelancePromptOf({
      status: q.status,
      issuedAt: q.issuedAt ?? null,
      number: q.number,
      ttcCents: q.totals.ttc,
      customerName: view.customerName,
      today: parisDateOnly(),
      personality: PERSONALITY_LABELS[personality],
    });
  }, [quote.data, view, personality]);
  // R3/R5 : les 3 états RÉELS du CTA post-signature (QuoteActions) dérivés des MÊMES factures liées
  // que la vue ci-dessus (view.linkedInvoices) — une seule source, pas de recalcul divergent.
  const quoteLinkedInvoices = useMemo<QuoteLinkedInvoices>(
    () => {
      const linked = (invoices.data ?? []).filter((invoice) => invoice.parentQuoteId === id);
      const deposit = linked.find((invoice) => invoice.kind === 'deposit') ?? null;
      const final = linked.find((invoice) => invoice.kind === 'final') ?? null;
      return {
        hasDepositInvoice: deposit !== null,
        hasFinalInvoice: final !== null,
        depositStatus: deposit?.status ?? null,
        finalStatus: final?.status ?? null,
      };
    },
    [id, invoices.data],
  );
  const agentContext = useMemo<AgentContext>(() => {
    const q = quote.data;
    if (!q || !screenDataReady) {
      return {
        screen: { name: '/devis/[id]', instanceId: `quote:${id}` },
        entities: [],
        capabilities: [],
      };
    }
    const customer = (customers.data ?? []).find((item) => item.id === q.customerId);
    const actionCapabilities: AgentCapability[] =
      q.status === 'draft'
        ? ['quote.send', 'quote.line.update', 'quote.deposit.update']
        : q.status === 'sent' || q.status === 'viewed'
          ? ['quote.send']
          : q.status === 'signed' && invoices.isSuccess
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
  }, [customers.data, id, invoices.data, invoices.isSuccess, quote.data, screenDataReady]);
  const agentLayout = useMemo<AgentAccessLayout>(() => ({ bottomAvoidance: 86 }), []);
  const confirm = useConfirm();

  // ── R6 : édition/suppression d'une ligne de devis BROUILLON (swipe, ou affordance vocale qui
  //    ouvre les mêmes UI — le tap sur Enregistrer/Confirmer reste le SEUL point d'écriture). ──
  const [editingLine, setEditingLine] = useState<PieceLineView | null>(null);
  const [editingSeed, setEditingSeed] = useState<QuoteLineEditSeed | null>(null);
  const [lineMutationError, setLineMutationError] = useState<string | null>(null);
  const updateLine = useUpdateQuoteLine();
  const removeLine = useRemoveQuoteLine();
  const linesRef = useRef<readonly PieceLineView[]>(view?.lines ?? []);
  linesRef.current = view?.lines ?? [];

  const handleEditLine = (lineId: string, seed: QuoteLineEditSeed | null = null): void => {
    const line = linesRef.current.find((l) => l.id === lineId);
    if (!line) return;
    setLineMutationError(null);
    setEditingLine(line);
    setEditingSeed(seed);
  };
  const handleDeleteLine = async (lineId: string): Promise<void> => {
    const line = linesRef.current.find((l) => l.id === lineId);
    const ok = await confirm({
      title: 'Supprimer la ligne',
      message: line ? `« ${line.label} » sera retirée du devis.` : 'Cette ligne sera retirée du devis.',
      challenge: challengeFor(REVERSIBLE, 'confirm_all'),
      destructive: true,
    });
    if (!ok) return;
    try {
      await removeLine.mutateAsync({ quoteId: id, lineId });
    } catch (error) {
      Alert.alert(t('devis.lineMutationErrorTitle', { personality }), appErrorMessage(error));
    }
  };
  const submitLineEdit = async (patch: QuoteLineEditPatch): Promise<void> => {
    if (!editingLine) return;
    setLineMutationError(null);
    try {
      await updateLine.mutateAsync({ quoteId: id, lineId: editingLine.id, patch });
      setEditingLine(null);
      setEditingSeed(null);
    } catch (error) {
      setLineMutationError(appErrorMessage(error));
    }
  };
  // R7 : pont voix → écran (parité stricte avec actionsRef.openChoiceSheet ci-dessous) — la voix
  // ouvre la MÊME UI que le swipe, sans jamais appeler updateLine/removeLine elle-même.
  const lineVoiceRef = useRef<{
    openEdit: (lineId: string, seed?: QuoteLineEditSeed | null) => void;
    openDelete: (lineId: string) => void;
  }>({ openEdit: () => undefined, openDelete: () => undefined });
  lineVoiceRef.current = {
    openEdit: (lineId, seed) => handleEditLine(lineId, seed ?? null),
    openDelete: (lineId) => void handleDeleteLine(lineId),
  };

  // ── B8 : bon de commande grands comptes (numéro d'engagement) — saisi UNE FOIS ici,
  //    repris automatiquement sur la facture dérivée. Éditable sur devis ENVOYÉ/VU/SIGNÉ
  //    tant qu'aucune pièce non annulée n'en dérive (au-delà, la facture est la source —
  //    même règle que le use case attach-purchase-order, pas de 409 surprise). ──
  const attachPo = useAttachQuotePurchaseOrder();
  const detachPo = useDetachQuotePurchaseOrder();
  const [poSheetOpen, setPoSheetOpen] = useState(false);
  const [poError, setPoError] = useState<string | null>(null);
  const poStatusEligible =
    quote.data?.status === 'sent' ||
    quote.data?.status === 'viewed' ||
    quote.data?.status === 'signed';
  const poAlreadyInvoiced = (invoices.data ?? []).some(
    (i) => i.parentQuoteId === id && i.status !== 'cancelled',
  );
  const poEditable = poStatusEligible && !poAlreadyInvoiced;
  const openPoSheet = (): void => {
    setPoError(null);
    setPoSheetOpen(true);
  };
  const submitPurchaseOrder = async (input: PurchaseOrderRefInput): Promise<void> => {
    setPoError(null);
    try {
      await attachPo.mutateAsync({
        quoteId: id,
        purchaseOrder: input,
        expectedRevision: quote.data?.revision ?? 1,
      });
      setPoSheetOpen(false);
    } catch (error) {
      setPoError(purchaseOrderErrorMessage(error, t('po.saveError', { personality })));
    }
  };
  const removePurchaseOrder = async (): Promise<void> => {
    const po = quote.data?.purchaseOrder;
    if (!po) return;
    const ok = await confirm({
      title: t('po.removeConfirmTitle', { personality }),
      message: t('po.removeConfirmBody', { personality, params: { number: po.number } }),
      challenge: challengeFor(REVERSIBLE, 'confirm_all'),
      destructive: true,
    });
    if (!ok) return;
    try {
      await detachPo.mutateAsync({ quoteId: id, expectedRevision: quote.data?.revision ?? 1 });
    } catch (error) {
      Alert.alert('Oups', purchaseOrderErrorMessage(error, t('po.saveError', { personality })));
    }
  };
  // B8/R7 : pont voix → écran — la voix OUVRE la même feuille que le bouton, jamais la mutation.
  const poVoiceRef = useRef<{ canOpen: boolean; open: () => void }>({
    canOpen: false,
    open: () => undefined,
  });
  poVoiceRef.current = { canOpen: screenDataReady && poEditable, open: openPoSheet };

  // ── PR-14 « Refaire ce devis » : NOUVEAU brouillon via CreateQuote serveur — TVA revalidée
  //    au régime du jour, faits légaux (signature, urgence) et temporels (n°, validité) JAMAIS
  //    copiés. Taux réduits : l'éligibilité est RE-DEMANDÉE au point de décision (jamais copiée). ──
  const duplicate = useDuplicateQuote();
  const runDuplicate = async (vatChoice: {
    context?: { housingOlderThan2y?: boolean; energyRenovation?: boolean };
    standardRateForReducedLines?: boolean;
  }): Promise<void> => {
    const ok = await confirm({
      title: t('devis.duplicateConfirmTitle', { personality }),
      message: t('devis.duplicateConfirmBody', { personality }),
      challenge: challengeFor(REVERSIBLE, 'confirm_all'),
    });
    if (!ok) return;
    try {
      const created = await duplicate.mutateAsync({
        quoteId: id,
        ...vatChoice,
        // Clé par GESTE : un retry réseau rejoue LA même création ; un nouveau tap volontaire
        // (seconde copie) reçoit une nouvelle clé.
        idempotencyKey: `refaire:${id}:${Date.now()}`,
      });
      if (created.vatAdjustments.length > 0) {
        Alert.alert(
          t('devis.duplicateDone', { personality }),
          t('devis.duplicateVatAdjusted', {
            personality,
            params: { count: String(created.vatAdjustments.length) },
          }),
        );
      }
      router.push(`/devis/${created.quoteId}`);
    } catch (error) {
      Alert.alert('Oups', appErrorMessage(error));
    }
  };
  const handleDuplicate = (): void => {
    const q = quote.data;
    if (!q || duplicate.isPending) return;
    const reducedRates = q.lines.some((line) => line.vatRate === 10 || line.vatRate === 5.5);
    if (!reducedRates) {
      void runDuplicate({});
      return;
    }
    const energy = q.lines.some((line) => line.vatRate === 5.5)
      ? t('devis.duplicateEligibilityEnergy', { personality })
      : '';
    // Pédagogie légale au point de décision : l'éligibilité appartient à la NOUVELLE pièce.
    Alert.alert(
      t('devis.duplicateEligibilityTitle', { personality }),
      t('devis.duplicateEligibilityBody', { personality, params: { energy } }),
      [
        { text: t('common.cancel', { personality }), style: 'cancel' },
        {
          text: t('devis.duplicateEligibilityNo', { personality }),
          onPress: () => void runDuplicate({ standardRateForReducedLines: true }),
        },
        {
          text: t('devis.duplicateEligibilityYes', { personality }),
          onPress: () =>
            void runDuplicate({
              context: {
                housingOlderThan2y: true,
                ...(q.lines.some((line) => line.vatRate === 5.5) ? { energyRenovation: true } : {}),
              },
            }),
        },
      ],
    );
  };

  // ── R7 (parité vocale) : « génère la facture finale »/« facture d'acompte »/« facture complète »
  //    sur un devis SIGNÉ. Plancher de sûreté : l'affordance dit (say) et, au mieux, OUVRE le Sheet
  //    de choix (QuoteActionsHandle) — JAMAIS n'appelle generate.mutateAsync elle-même. Seul le tap
  //    sur le bouton visible (état b) ou dans le Sheet (état a) déclenche réellement la génération. ──
  const actionsRef = useRef<QuoteActionsHandle>(null);
  const statusRef = useRef(screenDataReady ? quote.data?.status : undefined);
  statusRef.current = screenDataReady ? quote.data?.status : undefined;
  const linkedRef = useRef(quoteLinkedInvoices);
  linkedRef.current = quoteLinkedInvoices;
  const depositPctRef = useRef<number | null>(quote.data?.depositPct ?? null);
  depositPctRef.current = quote.data?.depositPct ?? null;
  const customerTypeRef = useRef<'b2c' | 'b2b' | 'b2g' | null>(
    (customers.data ?? []).find((customer) => customer.id === quote.data?.customerId)?.type ?? null,
  );
  customerTypeRef.current =
    (customers.data ?? []).find((customer) => customer.id === quote.data?.customerId)?.type ?? null;
  const personalityRef = useRef(personality);
  personalityRef.current = personality;
  // R7 : « partage le lien du devis » — dit + ouvre le Share (pattern établi), SANS Sheet
  // intermédiaire : contrairement au choix de signature (3 options dont un e-mail sortant réel),
  // ce lien n'a AUCUN effet sortant tant que le Share natif n'est pas complété par l'utilisateur
  // (même garantie que le tap sur l'icône « Partager le lien »).
  const viewLinkRef = useRef(viewLink);
  viewLinkRef.current = viewLink;
  const quoteNumberRef = useRef<string | null>(quote.data?.number ?? null);
  quoteNumberRef.current = quote.data?.number ?? null;
  const quoteVoiceSurface = useMemo<AgentSurface>(
    () => ({
      affordances: [
        {
          id: 'devis.generateFinalInvoice',
          match: (utterance) => {
            if (statusRef.current !== 'signed') return null;
            if (!/facture finale/.test(normalizeVoiceText(utterance))) return null;
            return () => {
              const p = personalityRef.current;
              if (linkedRef.current.hasFinalInvoice) return { say: t('devis.voice.invoiceAlreadyFinal', { personality: p }) };
              if (linkedRef.current.hasDepositInvoice && customerTypeRef.current !== 'b2c') {
                return { say: t('devis.voice.invoiceDepositUnavailable', { personality: p }) };
              }
              if (linkedRef.current.depositStatus === 'draft') {
                return { say: t('devis.voice.invoiceDepositDraft', { personality: p }) };
              }
              if (linkedRef.current.hasDepositInvoice) return { say: t('devis.voice.invoiceFinalReady', { personality: p }) };
              actionsRef.current?.openChoiceSheet();
              return { say: t('devis.voice.invoiceChoiceOpenedFinal', { personality: p }) };
            };
          },
        },
        {
          id: 'devis.generateDepositInvoice',
          match: (utterance) => {
            if (statusRef.current !== 'signed') return null;
            if (!/facture (d )?acompte/.test(normalizeVoiceText(utterance))) return null;
            return () => {
              const p = personalityRef.current;
              if (linkedRef.current.hasFinalInvoice) return { say: t('devis.voice.invoiceAlreadyFinal', { personality: p }) };
              if (customerTypeRef.current !== 'b2c') {
                return { say: t('devis.voice.invoiceDepositUnavailable', { personality: p }) };
              }
              if (linkedRef.current.hasDepositInvoice) return { say: t('devis.voice.invoiceFinalReady', { personality: p }) };
              const pct = depositPctRef.current;
              if (pct === null) return { say: t('devis.voice.invoiceNoDeposit', { personality: p }) };
              actionsRef.current?.openChoiceSheet();
              return { say: t('devis.voice.invoiceChoiceOpenedDeposit', { personality: p, params: { pct } }) };
            };
          },
        },
        {
          id: 'devis.generateFullInvoice',
          match: (utterance) => {
            if (statusRef.current !== 'signed') return null;
            const n = normalizeVoiceText(utterance);
            if (!/facture/.test(n) || !/(cent pour cent|100 ?%|100 ?pour ?cent|complete)/.test(n)) return null;
            return () => {
              const p = personalityRef.current;
              if (linkedRef.current.hasFinalInvoice) return { say: t('devis.voice.invoiceAlreadyFinal', { personality: p }) };
              if (linkedRef.current.hasDepositInvoice) return { say: t('devis.voice.invoiceFinalReady', { personality: p }) };
              actionsRef.current?.openChoiceSheet();
              return { say: t('devis.voice.invoiceChoiceOpenedFinal', { personality: p }) };
            };
          },
        },
        {
          // R4/R7 : « fais signer sur place » — devis envoyé/vu uniquement. Ouvre DIRECTEMENT le
          // pad (bypass le choix des 2 options) : la phrase nomme déjà l'option choisie. Doit être
          // testée AVANT l'affordance générique « fais signer » ci-dessous (elle la contiendrait).
          id: 'devis.signOnsite',
          match: (utterance) => {
            if (statusRef.current !== 'sent' && statusRef.current !== 'viewed') return null;
            const n = normalizeVoiceText(utterance);
            if (!/\bsigne/.test(n) || !/sur place/.test(n)) return null;
            return () => {
              actionsRef.current?.openSignOnsite();
              return { say: t('devis.voice.signOnsiteOpened', { personality: personalityRef.current }) };
            };
          },
        },
        {
          // R4/R7 : « envoie le lien de signature » — devis envoyé/vu uniquement. Ouvre le choix
          // (le tap sur « Envoyer le lien » reste le seul déclencheur réel de l'envoi/partage).
          id: 'devis.sendSignatureLink',
          match: (utterance) => {
            if (statusRef.current !== 'sent' && statusRef.current !== 'viewed') return null;
            const n = normalizeVoiceText(utterance);
            if (!/\blien\b/.test(n) || !/\bsignature\b/.test(n)) return null;
            return () => {
              actionsRef.current?.openSignSheet();
              return { say: t('devis.voice.signLinkChoiceOpened', { personality: personalityRef.current }) };
            };
          },
        },
        {
          // R4/R7 : « fais signer » (générique, sans qualificatif) — devis envoyé/vu uniquement.
          // Ouvre le choix des 2 options ; les phrases plus spécifiques ci-dessus sont testées
          // avant celle-ci dans le tableau (premier match gagne).
          id: 'devis.signGeneric',
          match: (utterance) => {
            if (statusRef.current !== 'sent' && statusRef.current !== 'viewed') return null;
            const n = normalizeVoiceText(utterance);
            if (!/\bsigner?\b/.test(n) && !/\bsignature\b/.test(n)) return null;
            return () => {
              actionsRef.current?.openSignSheet();
              return { say: t('devis.voice.signChoiceOpened', { personality: personalityRef.current }) };
            };
          },
        },
        {
          // R7 : « partage le lien du devis » — tout statut sauf brouillon (parité avec l'icône
          // « Partager le lien »). Contient « lien » mais PAS « signature » : les affordances
          // signature ci-dessus sont testées AVANT celle-ci et consomment déjà ces phrases-là.
          id: 'devis.shareViewLink',
          match: (utterance) => {
            if (statusRef.current === undefined || statusRef.current === 'draft') return null;
            const n = normalizeVoiceText(utterance);
            if (!/\b(partage|partager|envoie|envoyer)\b/.test(n) || !/\blien\b/.test(n) || /signature/.test(n))
              return null;
            return async () => {
              const p = personalityRef.current;
              try {
                const result = await viewLinkRef.current.mutateAsync(id);
                await Share.share({
                  message: `Bonjour, voici le lien pour consulter le devis${quoteNumberRef.current ? ` ${quoteNumberRef.current}` : ''} : ${result.viewUrl}`,
                });
                return { say: t('devis.voice.shareLinkOpened', { personality: p }) };
              } catch {
                return { say: t('piece.shareLinkError', { personality: p }) };
              }
            };
          },
        },
        {
          // R6/R7 : « modifie la deuxième ligne, mets 3 heures » — devis BROUILLON uniquement
          // (un devis signé est un contrat, l'UI n'affiche déjà rien d'éditable hors draft).
          // Plancher de sûreté : la voix OUVRE la Sheet préremplie — le tap sur Enregistrer
          // reste le seul point d'écriture (jamais updateLine.mutateAsync depuis l'affordance).
          id: 'devis.editLineByOrdinal',
          match: (utterance) => {
            if (statusRef.current !== 'draft') return null;
            const digits = frSpokenNumbersToDigits(normalizeVoiceText(utterance));
            if (!/\b(corrige|modifie|change|passe|edite|mets?)\b/.test(digits)) return null;
            const ordinal = resolveLineOrdinal(digits);
            if (ordinal === null) return null;
            return () => {
              const p = personalityRef.current;
              const line = linesRef.current[ordinal - 1];
              if (!line) return { say: t('devis.voice.lineUnknownOrdinal', { personality: p, params: { ordinal } }) };
              const qtyPatch = extractLineQtyPatch(digits);
              const pricePatch = extractLinePricePatch(digits);
              const seed: QuoteLineEditSeed | null =
                qtyPatch !== null || pricePatch !== null
                  ? { ...(qtyPatch !== null ? { qty: qtyPatch } : {}), ...(pricePatch !== null ? { unitPriceHT: pricePatch } : {}) }
                  : null;
              lineVoiceRef.current.openEdit(line.id, seed);
              return { say: t('devis.voice.lineEditOpened', { personality: p, params: { ordinal } }) };
            };
          },
        },
        {
          // R6/R7 : « supprime la troisième ligne » — devis BROUILLON uniquement. La voix OUVRE
          // la ConfirmSheet destructive (même feuille que le swipe) — seul le tap Confirmer supprime.
          id: 'devis.removeLineByOrdinal',
          match: (utterance) => {
            if (statusRef.current !== 'draft') return null;
            const digits = frSpokenNumbersToDigits(normalizeVoiceText(utterance));
            if (!/\b(supprime|enleve|retire|efface)\b/.test(digits)) return null;
            const ordinal = resolveLineOrdinal(digits);
            if (ordinal === null) return null;
            return () => {
              const p = personalityRef.current;
              const line = linesRef.current[ordinal - 1];
              if (!line) return { say: t('devis.voice.lineUnknownOrdinal', { personality: p, params: { ordinal } }) };
              lineVoiceRef.current.openDelete(line.id);
              return { say: t('devis.voice.lineDeleteOpened', { personality: p, params: { ordinal } }) };
            };
          },
        },
        {
          // B8/R7 : « ajoute le bon de commande » / « numéro d'engagement » — devis envoyé/vu/
          // signé non facturé. La voix OUVRE la MÊME feuille de saisie que le bouton — le tap
          // sur Enregistrer reste le SEUL point d'écriture (jamais attachPo depuis l'affordance).
          id: 'devis.purchaseOrder',
          match: (utterance) => {
            if (!poVoiceRef.current.canOpen) return null;
            const n = normalizeVoiceText(utterance);
            if (!/bon de commande|numero d ?engagement/.test(n)) return null;
            return () => {
              poVoiceRef.current.open();
              return { say: t('po.voice.sheetOpened', { personality: personalityRef.current }) };
            };
          },
        },
      ],
    }),
    [],
  );
  usePublishAgentContext(agentContext, agentLayout, quoteVoiceSurface);

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
  // Lien public de VISUALISATION (canal universel, sans e-mail) — tout statut sauf brouillon
  // (un devis brouillon n'a rien à montrer à un client). SANS AUCUN sortant tant que le Share
  // natif n'est pas complété par l'utilisateur — même doctrine que « Envoyer le lien » (R4).
  const shareViewLink = quote.data && quote.data.status !== 'draft'
    ? async (): Promise<void> => {
        try {
          const result = await viewLink.mutateAsync(id);
          await Share.share({
            message: `Bonjour, voici le lien pour consulter le devis${quote.data?.number ? ` ${quote.data.number}` : ''} : ${result.viewUrl}`,
          });
        } catch {
          Alert.alert('Oups', t('piece.shareLinkError', { personality }));
        }
      }
    : null;

  if (quote.isLoading || customers.isLoading || invoices.isLoading || documents.isLoading) {
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
  if (quote.isError || customers.isError || invoices.isError || documents.isError) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', backgroundColor: colors.bg, padding: 18 }}>
        <ErrorRetry
          message={t('piece.dataError', { personality })}
          onRetry={() => {
            void Promise.all([quote.refetch(), customers.refetch(), invoices.refetch(), documents.refetch()]);
          }}
          retrying={
            quote.isRefetching ||
            customers.isRefetching ||
            invoices.isRefetching ||
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
  // via le helper partagé avec facture/[id] (pattern client/chantier).
  if (!view || !quote.data) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', backgroundColor: colors.bg, padding: 18 }}>
        <ErrorRetry
          message={t('piece.notFound', { personality })}
          onRetry={() => void quote.refetch()}
          retrying={quote.isRefetching}
          secondaryLabel={t('piece.close', { personality })}
          onSecondaryAction={() => goBackOrHome(router)}
        />
      </View>
    );
  }
  const q = quote.data;

  return (
    <>
      <PieceDetailView
        view={view}
        onClose={() => router.back()}
        onOpenInvoice={(ref: PieceLinkedRef) => router.push(`/facture/${ref.id}`)}
        onOpenPdf={openPdf ? () => void openPdf() : undefined}
        onSharePdf={sharePdf ? () => void sharePdf() : undefined}
        onShareLink={shareViewLink ? () => void shareViewLink() : undefined}
        // R6 : swipe droite→gauche = Modifier/Supprimer — DRAFT uniquement (un devis signé est
        // un contrat, l'UI n'affiche rien d'éditable hors draft).
        editableLines={q.status === 'draft'}
        onEditLine={(lineId) => handleEditLine(lineId)}
        onDeleteLine={(lineId) => void handleDeleteLine(lineId)}
        extra={
          <>
            {relancePrompt ? (
              // PR-05 — « un message pré-rédigé vous attend » : aperçu du VRAI message
              // (buildQuoteRelance, palier du cron) + partage avec lien de signature frais.
              // Rien ne part tant que le Share natif n'est pas complété par l'artisan.
              <FadeIn>
                <Card style={{ marginBottom: 12 }}>
                  <SectionHeader title={t('devis.relanceCardTitle', { personality })} />
                  <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
                    <Badge
                      label={t(
                        relancePrompt.palier === 'j30'
                          ? 'today.prioQuoteRelanceBadgeJ30'
                          : 'today.prioQuoteRelanceBadgeJ15',
                        { personality },
                      ).toUpperCase()}
                      tone="warning"
                    />
                    <Text style={[font('meta', 500), { flex: 1, color: colors.slate500 }]}>
                      {t('devis.relanceCardHint', {
                        personality,
                        params: { days: relancePrompt.daysSinceIssued },
                      })}
                    </Text>
                  </View>
                  <View
                    style={{
                      marginTop: 10,
                      borderRadius: 12,
                      borderWidth: 1,
                      borderColor: controls.cardBorder,
                      padding: 12,
                    }}
                  >
                    <Text style={[font('body', 500), { fontSize: 13.5, lineHeight: 20, color: colors.ink800 }]}>
                      {relancePrompt.previewBody}
                    </Text>
                  </View>
                  <View style={{ marginTop: 12, alignSelf: 'flex-start' }}>
                    <ShareQuoteLinkButton
                      quoteId={id}
                      quoteNumber={q.number}
                      title={t('today.ctaQuoteRelance', { personality })}
                      variant="primary"
                      icon={<Feather name="send" size={15} color={colors.surface} />}
                      buildMessage={relancePrompt.buildShareMessage}
                    />
                  </View>
                </Card>
              </FadeIn>
            ) : null}
            {/* B8 : section « Bon de commande » — visible dès que le devis est envoyé/vu/signé,
                ou dès qu'une référence existe (lecture honnête même sur refusé/expiré). */}
            {poStatusEligible || q.purchaseOrder != null ? (
              <PurchaseOrderCard
                purchaseOrder={q.purchaseOrder ?? null}
                editable={poEditable}
                invoicedNote={poStatusEligible && poAlreadyInvoiced}
                emptyBody={t('po.emptyQuoteBody', { personality })}
                documents={documents.data ?? []}
                onAdd={openPoSheet}
                onEdit={openPoSheet}
                onRemove={() => void removePurchaseOrder()}
                onOpenDocument={(documentId) => router.push(`/documents/${documentId}`)}
              />
            ) : null}
            {/* PR-14 — « Refaire ce devis » : pertinent dès que la pièce a vécu (envoyée, signée,
                refusée, expirée) ; un brouillon s'édite directement. */}
            {q.status !== 'draft' ? (
              <Card style={{ marginTop: 12 }}>
                <SectionHeader title={t('devis.duplicateCta', { personality })} />
                <Text style={[font('sub', 500), { color: colors.slate500, marginBottom: 10 }]}>
                  {t('devis.duplicateConfirmBody', { personality })}
                </Text>
                <View style={{ alignSelf: 'flex-start' }}>
                  <Button
                    title={t('devis.duplicateCta', { personality })}
                    variant="secondary"
                    loading={duplicate.isPending}
                    icon={<Feather name="copy" size={15} color={colors.ink900} />}
                    onPress={handleDuplicate}
                  />
                </View>
              </Card>
            ) : null}
          </>
        }
        actions={
          hasQuoteActions(q) ? (
            <QuoteActions
              ref={actionsRef}
              quote={q}
              customerName={view.customerName}
              // Conseil du canal de signature (item 4) : la qualité du client pilote le conseil
              // B2C non urgent — les gardes légales, elles, restent au serveur.
              customerType={
                (customers.data ?? []).find((c) => c.id === q.customerId)?.type ?? null
              }
              linkedInvoices={quoteLinkedInvoices}
            />
          ) : null
        }
      />
      <QuoteLineEditSheet
        visible={editingLine !== null}
        line={editingLine}
        seed={editingSeed}
        saving={updateLine.isPending}
        error={lineMutationError}
        onClose={() => {
          if (updateLine.isPending) return;
          setEditingLine(null);
          setEditingSeed(null);
          setLineMutationError(null);
        }}
        onDelete={() => {
          const lineId = editingLine?.id;
          if (!lineId || updateLine.isPending) return;
          setEditingLine(null);
          setEditingSeed(null);
          setLineMutationError(null);
          void handleDeleteLine(lineId);
        }}
        onInputChange={() => setLineMutationError(null)}
        onSubmit={(patch) => void submitLineEdit(patch)}
      />
      <PurchaseOrderSheet
        visible={poSheetOpen}
        initial={q.purchaseOrder ?? null}
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
