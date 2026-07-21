import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react';
import { View, Share, Text } from 'react-native';
import { router } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import type { AccountingPreviewLine, QuoteView, InvoiceView } from '@bob/api-client';
import { formatDateOnlyFr, type FrenchOperationCategory } from '@bob/core';
import { challengeFor, buildActionDiff } from '@bob/ai';
import { t } from '@bob/i18n';
import { DeleteIconButton, LegalHint, QuestionSheet, Sheet, font, useTheme } from '@bob/ui';
import {
  useCompanyMe,
  useCompanyBillingSettings,
  useSendQuote,
  useSignQuote,
  useCreateQuoteSignatureLink,
  useRefuseQuote,
  useCreateCreditNote,
  useGenerateInvoice,
  useIssueInvoice,
  useRegisterPayment,
  useInvoicePaymentLink,
  useDeleteDraftInvoice,
  useScheduleEmbargoPayment,
  appErrorMessage,
} from '../data/hooks';
import {
  embargoPromptOf,
  shouldAdviseRemoteSignature,
  type EmbargoPrompt,
} from '../lib/embargo-prompt';
import { Button, Badge } from './ui';
import { useConfirm } from './ConfirmSheet';
import { useErrorSheet, type ErrorSheetHandle } from './ErrorSheet';
import { useBobClient } from '../data/client';
import { companyCanIssue } from '../data/company-completeness';
import {
  companyIncompleteGateSpec,
  paymentTermsMissingGateSpec,
  type GateSpec,
} from './document-gates.logic';
import {
  deriveQuoteInvoiceCtaState,
  mergeLinkedInvoices,
  reconcileLinkedInvoicesEcho,
  type QuoteInvoiceLinksState,
} from './quote-invoice-actions.logic';
import { SignOnsiteSheet } from './SignOnsiteSheet';
import { SituationSheet } from './SituationSheet';
import { resolveCollectAccountingPreview } from './collect-accounting-preview';
import { isPaymentLinkEligible } from '../lib/payment-link-affordance';
import {
  EMPTY_INVOICE_ISSUE_DECISION,
  INVOICE_OPERATION_CATEGORIES,
  invoiceIssueDecisionInput,
  isOperationCategoryRequiredError,
  mergeInvoiceIssueDecision,
  parseInvoiceOperationCategoryChoice,
} from './invoice-operation-category.logic';

/**
 * Gate « entreprise complète » (RÈGLE PRODUIT) : l'app reste utilisable sans fiche entreprise
 * complète (brouillons…), le gate n'apparaît qu'à l'ACTE qui l'exige légalement — ici, la toute
 * première émission (devis « Envoyer » depuis l'état brouillon, facture « Émettre » depuis
 * l'état brouillon : c'est précisément à ce moment que le numéro légal est alloué). Les
 * renvois/partages d'un devis DÉJÀ envoyé ne sont pas re-gatés : la complétude a déjà été
 * vérifiée à son premier envoi.
 * Feuille @bob/ui (plus JAMAIS d'Alert système gris dans le flow) : CTA vers l'écran qui règle
 * le manque en premier plan, « Plus tard » referme — mêmes textes i18n qu'avant.
 *
 * Les SPÉCIFICATIONS des gates (textes + destination) vivent dans `document-gates.logic.ts` :
 * logique pure et TESTÉE, après le cul-de-sac de production du 20/07 où ce gate routait vers
 * `/compte`, écran qui ne porte ni `rcsOrRm` ni l'adresse. Ce fichier ne fait plus que rendre.
 */
function GateSheet({
  gate,
  onClose,
}: {
  gate: GateSpec | null;
  onClose: () => void;
}): ReactNode {
  const { colors } = useTheme();
  return (
    <Sheet
      visible={gate !== null}
      onClose={onClose}
      accessibilityLabel={gate?.title ?? 'Complément requis'}
    >
      {gate !== null ? (
        <>
          <Text
            accessibilityRole="header"
            style={[font('cardTitle'), { color: colors.ink900, marginBottom: 8 }]}
          >
            {gate.title}
          </Text>
          <Text style={[font('sub'), { color: colors.slate500, lineHeight: 20, marginBottom: 14 }]}>
            {gate.body}
          </Text>
          <View style={{ gap: 8, marginBottom: 8 }}>
            <Button
              title={gate.ctaLabel}
              onPress={() => {
                const route = gate.route;
                onClose();
                router.push(route);
              }}
            />
            <Button title={gate.cancelLabel} variant="secondary" onPress={onClose} />
          </View>
        </>
      ) : null}
    </Sheet>
  );
}

// Profils de risque des actions manuelles (mêmes paliers que le registre d'outils de Bob -> confirmation typée).
const OUTBOUND = { mutating: true, outbound: true, riskTier: 'outbound' } as const;
const REVERSIBLE = { mutating: true, outbound: false, riskTier: 'reversible' } as const;
const ACCOUNTING = { mutating: true, outbound: false, riskTier: 'accounting' } as const;
const FISCAL = { mutating: true, outbound: false, riskTier: 'fiscal' } as const;

/**
 * Actions contextuelles d'un devis / d'une facture — SOURCE UNIQUE, partagée par la liste (ventes.tsx)
 * et les écrans de détail. Encapsule le plancher de sécurité manuel : confirmation explicite avant toute
 * action sensible (miroir du safety floor de Bob), avec verrou anti-double-tap.
 */

// Badges de statut (E5 : dérivés par kind — avoir masculin/ambre) : logique PURE extraite dans
// invoice-badge.logic.ts (testable en node, aucun import RN) — re-export pour les appelants.
export { QUOTE_BADGE, INVOICE_BADGE, invoiceBadgeFor, type BadgeTone } from './invoice-badge.logic';

// Un document terminal (devis refusé/expiré, facture payée/annulée) n'a plus d'action -> permet au parent
// de ne pas réserver d'espace inutile. Source unique : ces prédicats et les composants restent alignés.
export const hasQuoteActions = (q: QuoteView): boolean =>
  q.status === 'draft' || q.status === 'sent' || q.status === 'viewed' || q.status === 'signed';
export const hasInvoiceActions = (inv: InvoiceView): boolean =>
  inv.status === 'draft' ||
  inv.status === 'issued' ||
  inv.status === 'partially_paid' ||
  inv.status === 'late';

/** A6 : un avoir se crée sur une facture ÉMISE (payée comprise) — jamais sur un avoir. */
export const canCreateCreditNote = (inv: InvoiceView): boolean =>
  inv.kind !== 'credit_note' &&
  (inv.status === 'issued' ||
    inv.status === 'partially_paid' ||
    inv.status === 'paid' ||
    inv.status === 'late');

// ── Encaissement : invariants partagés (InvoiceActions + briefing A2-C10) ─────────────────
// Assiette = netToPay (acompte si depositPct, sinon ttc) : le domaine PLAFONNE le paiement à
// netToPay (invoice.ts). Baser sur ttc ferait rejeter l'encaissement d'une facture d'acompte.
export const collectRemainingCents = (invoice: Pick<InvoiceView, 'totals' | 'paid'>): number =>
  Math.max(0, invoice.totals.netToPay - invoice.paid);

/** Encaissable = statut vivant ET reste dû strictement positif. */
export const isCollectible = (inv: InvoiceView): boolean =>
  (inv.status === 'issued' || inv.status === 'partially_paid' || inv.status === 'late') &&
  collectRemainingCents(inv) > 0;

/** Clé d'idempotence du paiement manuel — même recette partout (anti double encaissement). */
export const paymentIdempotencyKey = (
  invoice: Pick<InvoiceView, 'id' | 'paid'>,
  remaining: number,
): string => `mobile:payment:${invoice.id}:${invoice.paid}:${remaining}:transfer`;

/** Confirmation typée de l'encaissement — SOURCE UNIQUE du diff et du challenge ACCOUNTING. */
export function collectConfirmSpec(
  invoice: InvoiceView,
  remaining: number,
  accountingLines: readonly AccountingPreviewLine[],
) {
  return {
    title: 'Enregistrer le paiement',
    message: 'Met à jour le journal de banque, le compte client et les relances.',
    diff: buildActionDiff(
      'encaisser_facture',
      { amountCents: remaining },
      { number: invoice.number, remainingCents: remaining, accountingLines },
    ),
    challenge: challengeFor(ACCOUNTING, 'confirm_all', { amountCents: remaining }),
  };
}

/**
 * Feuille embargo L221-10 PARTAGÉE devis/facture (génération ET émission) : DÉFAUT en premier
 * plan (programmer au premier jour légal, formulé BÉNÉFICE + LegalHint sourcé), override
 * responsabilisé en SECOND niveau (feuille de confirmation dédiée au risque concret, action
 * tracée serveur). Une seule feuille, deux étages — jamais le risque et le défaut au même écran.
 */
function EmbargoPromptSheet({
  prompt,
  stage,
  busyDefault,
  busyOverride,
  disabled,
  onClose,
  onDefault,
  onOverride,
  onStage,
}: {
  prompt: EmbargoPrompt | null;
  stage: 'choice' | 'confirm';
  busyDefault: boolean;
  busyOverride: boolean;
  disabled: boolean;
  onClose: () => void;
  onDefault: () => void;
  onOverride: () => void;
  onStage: (stage: 'choice' | 'confirm') => void;
}): ReactNode {
  const { personality, colors } = useTheme();
  return (
    <Sheet
      visible={prompt !== null}
      onClose={onClose}
      accessibilityLabel={t('legal.embargoSheet.title', { personality })}
    >
      {prompt !== null && stage === 'choice' ? (
        <>
          <Text
            accessibilityRole="header"
            style={[font('cardTitle'), { color: colors.ink900, marginBottom: 8 }]}
          >
            {t('legal.embargoSheet.title', { personality })}
          </Text>
          <Text style={[font('sub'), { color: colors.slate500, lineHeight: 20, marginBottom: 10 }]}>
            {prompt.message}
          </Text>
          <View style={{ marginBottom: 14 }}>
            <LegalHint
              label={t('legal.embargo.inline', {
                personality,
                params: { date: prompt.availableFromFr },
              })}
              lawKey="legal.embargo.law"
              whyKey="legal.embargo.why"
              source="art. L221-10 du code de la consommation"
            />
          </View>
          <View style={{ gap: 8, marginBottom: 8 }}>
            <Button
              title={t('legal.embargoSchedule.button', {
                personality,
                params: { date: prompt.availableFromFr },
              })}
              loading={busyDefault}
              disabled={disabled}
              onPress={onDefault}
            />
            {prompt.overridable ? (
              <Button
                title={t('legal.embargoOverride.button', { personality })}
                variant="secondary"
                disabled={disabled}
                onPress={() => onStage('confirm')}
              />
            ) : null}
          </View>
        </>
      ) : null}
      {prompt !== null && stage === 'confirm' ? (
        <>
          <Text
            accessibilityRole="header"
            style={[font('cardTitle'), { color: colors.ink900, marginBottom: 8 }]}
          >
            {t('legal.embargoOverride.sheetTitle', { personality })}
          </Text>
          <Text style={[font('sub'), { color: colors.slate500, lineHeight: 20, marginBottom: 14 }]}>
            {prompt.overrideRisk ?? t('legal.embargoOverride.risk', { personality })}
          </Text>
          <View style={{ gap: 8, marginBottom: 8 }}>
            <Button
              title={t('legal.embargoOverride.confirm', { personality })}
              variant="danger"
              loading={busyOverride}
              disabled={disabled}
              onPress={onOverride}
            />
            <Button
              title={t('legal.embargoOverride.cancel', {
                personality,
                params: { date: prompt.availableFromFr },
              })}
              variant="secondary"
              disabled={disabled}
              onPress={() => onStage('choice')}
            />
          </View>
        </>
      ) : null}
    </Sheet>
  );
}

// Verrou : `busy` (state) pilote spinner/disabled ; `lock` (ref) bloque un 2e tap avant tout re-render.
// L'échec inattendu remonte dans la feuille d'erreur premium du composant appelant (plus d'Alert natif).
function useActionLock(showError: ErrorSheetHandle['showError']) {
  const [busy, setBusy] = useState<string | null>(null);
  const lock = useRef(false);
  const run = async (key: string, fn: () => Promise<unknown>): Promise<void> => {
    if (lock.current) return;
    lock.current = true;
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      showError('Oups', appErrorMessage(e));
    } finally {
      lock.current = false;
      setBusy(null);
    }
  };
  return { busy, lock, run };
}

/**
 * Factures déjà liées à CE devis (dérivé de InvoiceView.parentQuoteId, côté appelant) — pilote les
 * 3 états RÉELS du CTA post-signature (R3/R5) : aucune → Sheet de choix ; acompte sans finale →
 * « Générer la facture finale » (mode EXPLICITE, le bug R3) ; finale déjà là → badge.
 */
export type QuoteLinkedInvoices = QuoteInvoiceLinksState;
const NO_LINKED_INVOICES: QuoteLinkedInvoices = {
  hasDepositInvoice: false,
  hasFinalInvoice: false,
  depositStatus: null,
  finalStatus: null,
};

/**
 * R7 (parité vocale) : pouvoir IMPÉRATIF exposé au parent pour ouvrir le Sheet de choix depuis une
 * affordance vocale — SANS exécuter. Plancher de sûreté : la voix dit et montre, seul le tap dans
 * le Sheet (ou sur le bouton de l'état b) déclenche réellement generate.mutateAsync.
 */
export interface QuoteActionsHandle {
  openChoiceSheet: () => void;
  /** R4/R7 : ouvre le Sheet de choix de signature (Sur place / Envoyer le lien) — SANS rien
   * exécuter. Couvre « fais signer » et « envoie le lien de signature » : dans les deux cas la
   * voix dit et montre, seul le tap sur l'option choisie déclenche réellement sign/send. */
  openSignSheet: () => void;
  /** R4/R7 : ouvre DIRECTEMENT le pad de signature sur place (bypass le choix) — « fais signer
   * sur place ». Le tap sur « Valider la signature » reste le seul point d'écriture. */
  openSignOnsite: () => void;
}

export const QuoteActions = forwardRef<
  QuoteActionsHandle,
  {
    quote: QuoteView;
    customerName: string;
    linkedInvoices?: QuoteLinkedInvoices;
    /** Qualité du client (fiche) — pilote le conseil du canal de signature (B2C non urgent)
     *  et rien d'autre : les gardes légales restent au SERVEUR. Absent = pas de conseil. */
    customerType?: 'b2c' | 'b2b' | 'b2g' | null;
  }
>(function QuoteActions(
  { quote, customerName, linkedInvoices = NO_LINKED_INVOICES, customerType = null },
  ref,
): ReactNode {
  const { personality, semantic, colors } = useTheme();
  const send = useSendQuote();
  const sign = useSignQuote();
  const signatureLink = useCreateQuoteSignatureLink();
  const refuse = useRefuseQuote();
  const generate = useGenerateInvoice();
  const scheduleEmbargo = useScheduleEmbargoPayment();
  // Feuille d'erreur premium locale (plus aucun Alert natif dans le flow) — partagée par le
  // verrou d'action et les remontées embargo/génération.
  const { showError, errorSheet } = useErrorSheet();
  const { busy, run } = useActionLock(showError);
  const confirm = useConfirm();
  // Gate entreprise complète — ne concerne QUE le premier envoi (état brouillon), cf. doc du
  // gate en tête de fichier. `undefined` (pas encore chargé) est traité comme incomplet : on ne
  // laisse jamais partir un numéro légal avant d'être sûr de la fiche société.
  const companyMe = useCompanyMe();
  const companyComplete = companyCanIssue(companyMe.data);
  // Confort UX : bascule l'état affiché DANS LA SESSION dès le succès, sans attendre le refetch des
  // factures liées côté appelant. La sûreté anti-doublon reste AU DOMAINE (GenerateInvoiceFromQuote,
  // idempotent par parentQuoteId+kind) ; `linkedInvoices` est la source DURABLE (survit au re-render).
  const [localLinked, setLocalLinked] = useState<QuoteLinkedInvoices>(NO_LINKED_INVOICES);
  // Gate « entreprise complète » (feuille locale, voir GateSheet) — armé au tap « Envoyer ».
  const [gate, setGate] = useState<GateSpec | null>(null);
  const [choiceOpen, setChoiceOpen] = useState(false);
  // B2 : feuille « Facturer une situation » — devis signé sans facture finale (le solde final
  // déduit automatiquement acompte + situations émises, GenerateInvoiceFromQuote).
  const [situationOpen, setSituationOpen] = useState(false);
  // R4 : choix de signature (Sur place / Envoyer le lien) puis, si « Sur place », le pad lui-même.
  const [signChoiceOpen, setSignChoiceOpen] = useState(false);
  const [onsiteOpen, setOnsiteOpen] = useState(false);
  // Conseil du canal (item 4) : B2C non urgent + « sur place » choisi → feuille conseil AVANT le
  // pad — le choix reste 100 % libre (« Continuer sur place » toujours proposé).
  const [signAdviceOpen, setSignAdviceOpen] = useState(false);
  // Embargo L221-10 : refus serveur traduit en invite (DÉFAUT = programmer à J+7 ; override
  // responsabilisé en second niveau — jamais au même écran que le défaut).
  const [embargoPrompt, setEmbargoPrompt] = useState<EmbargoPrompt | null>(null);
  const [embargoStage, setEmbargoStage] = useState<'choice' | 'confirm'>('choice');
  // Mode passage client durci (challenge GPT 20260714, P1 reprise) : un échec réseau de
  // `signQuote` ne doit jamais vider le pad — l'erreur vit ICI (pas dans SignOnsiteSheet) pour
  // survivre à ses re-renders, et n'est réarmée qu'à une ouverture explicite du pad.
  const [onsiteError, setOnsiteError] = useState<string | null>(null);
  // Écho ≠ vérité : dès que la source DURABLE confirme une pièce, son écho de session s'efface
  // — sinon le OR de la fusion ne redescend jamais et supprimer ensuite le brouillon depuis
  // l'écran facture laissait badge/CTA fantômes au retour (bug terrain APK d091b0b5).
  useEffect(() => {
    setLocalLinked((prev) => reconcileLinkedInvoicesEcho(prev, linkedInvoices));
  }, [linkedInvoices.hasDepositInvoice, linkedInvoices.hasFinalInvoice]);
  const linked: QuoteLinkedInvoices = mergeLinkedInvoices(linkedInvoices, localLinked);
  // La reprise d'avance structurée concerne le chemin B2B/B2G. Tant qu'EXTENDED + PA ne sont
  // pas certifiés, seul le B2C (PDF/e-reporting distinct) peut ouvrir le choix d'acompte.
  // `null` reste fail-closed : une fiche client absente ne rend jamais l'action disponible.
  const depositPathAvailable = customerType === 'b2c';
  useImperativeHandle(
    ref,
    () => ({
      openChoiceSheet: () => {
        // N'ouvre que si l'état (a) s'applique (aucune facture liée) — sinon rien à choisir.
        if (!linked.hasFinalInvoice && !linked.hasDepositInvoice) setChoiceOpen(true);
      },
      openSignSheet: () => {
        if (quote.status === 'sent' || quote.status === 'viewed') setSignChoiceOpen(true);
      },
      openSignOnsite: () => {
        if (quote.status === 'sent' || quote.status === 'viewed') {
          setOnsiteError(null);
          setOnsiteOpen(true);
        }
      },
    }),
    [linked.hasFinalInvoice, linked.hasDepositInvoice, quote.status],
  );
  // Un SEUL point d'écriture pour les deux boutons (a) et (b) : mode TOUJOURS explicite — c'est
  // précisément le correctif R3 (sans mode, l'inférence retombait sur 'deposit' déjà facturé et
  // l'idempotence renvoyait l'existante sans créer la finale).
  const markGenerated = (mode: 'deposit' | 'final', invoiceId: string): void => {
    setLocalLinked((prev) => ({
      ...prev,
      ...(mode === 'deposit'
        ? { hasDepositInvoice: true, depositStatus: 'draft' as const }
        : { hasFinalInvoice: true, finalStatus: 'draft' as const }),
    }));
    router.push(`/facture/${invoiceId}`);
  };

  const generateInvoice = (mode: 'deposit' | 'final') =>
    run('gen', async () => {
      try {
        const out = await generate.mutateAsync({ quoteId: quote.id, mode });
        markGenerated(mode, out.invoiceId);
      } catch (e) {
        // Embargo L221-10 : le refus devient une INVITE (défaut = programmer à J+7, override
        // responsabilisé en second niveau) — toute autre erreur garde le message générique.
        const prompt = embargoPromptOf(e, mode);
        if (prompt === null) {
          showError('Oups', appErrorMessage(e));
          return;
        }
        setEmbargoStage('choice');
        setEmbargoPrompt(prompt);
      }
    });

  /** DÉFAUT légal : programme le message client au premier jour où le paiement est exigible. */
  const scheduleEmbargoDefault = () =>
    run('schedule', async () => {
      try {
        const scheduled = await scheduleEmbargo.mutateAsync(quote.id);
        setEmbargoPrompt(null);
        showError(
          t('legal.embargoSheet.title', { personality }),
          t('legal.embargoSchedule.confirmed', {
            personality,
            // Date SERVEUR (source de vérité) : pour un devis SANS acompte, la pièce visée est
            // la FINALE, gelée jusqu'à la fin du délai de rétractation — la date du refus
            // embargo (J+7) serait alors une promesse fausse.
            params: { date: formatDateOnlyFr(scheduled.availableFrom) },
          }),
        );
      } catch (e) {
        showError('Oups', appErrorMessage(e));
      }
    });

  /** OVERRIDE responsabilisé : rejoue la génération avec le flag EXPLICITE — tracé serveur. */
  const overrideEmbargo = (prompt: EmbargoPrompt) =>
    run('gen', async () => {
      try {
        const out = await generate.mutateAsync({
          quoteId: quote.id,
          mode: prompt.mode,
          embargoOverride: true,
        });
        setEmbargoPrompt(null);
        // La navigation vers la pièce générée attend la FERMETURE de la feuille : l'utilisateur
        // lit la confirmation du traçage avant d'arriver sur la facture (l'Alert natif, lui,
        // flottait au-dessus de la navigation — une feuille appartient à son écran).
        showError(
          t('legal.embargoSheet.title', { personality }),
          t('legal.embargoOverride.traced', { personality }),
          () => markGenerated(prompt.mode, out.invoiceId),
        );
      } catch (e) {
        showError('Oups', appErrorMessage(e));
      }
    });

  // P0 R4 (fermé) : « Envoyer le lien » n'appelle PLUS sendQuote — l'ancienne implémentation
  // mettait l'e-mail en outbox AVANT d'ouvrir Share, donc annuler le partage n'annulait rien.
  // Désormais : POST /quotes/:id/signature-link (CreateQuoteSignatureLink) prépare/rotate le
  // lien SANS AUCUN sortant, puis Share s'ouvre. Annuler le Share = rien n'est parti (critère
  // du P0) — seul un lien roté existe côté serveur, aucun destinataire ne l'a reçu. L'URL vient
  // DU SERVEUR (source unique) : le mobile ne connaît jamais SIGN_WEB_BASE_URL.
  const handleSendLink = () =>
    run('sendLink', async () => {
      const result = await signatureLink.mutateAsync(quote.id);
      await Share.share({
        message: `Bonjour, voici le lien pour signer le devis${quote.number ? ` ${quote.number}` : ''} : ${result.signatureUrl}`,
      });
    });

  // R4 : l'envoi PAR E-MAIL reste possible mais devient une option EXPLICITE et confirmée
  // (sortant réel vers le client — même plancher OUTBOUND que l'envoi initial du devis).
  // Sélectionner un mode dans le sheet n'est pas la confirmation d'un effet sortant.
  const handleSendEmail = async () => {
    const ok = await confirm({
      title: 'Envoyer par e-mail',
      message: `Le lien de signature part par e-mail chez ${customerName}.`,
      diff: buildActionDiff('envoyer_devis', {}, { number: quote.number }),
      challenge: challengeFor(OUTBOUND, 'confirm_all'),
    });
    if (!ok) return;
    await run('sendEmail', async () => {
      const result = await send.mutateAsync(quote.id);
      if (result.deliveryStatus === 'queued') {
        showError(
          'Envoi programmé',
          'L’e-mail partira en arrière-plan. Vous pouvez suivre sa livraison dans l’activité.',
        );
      } else if (result.deliveryStatus === 'sent') {
        showError('E-mail envoyé', 'L’e-mail a été pris en charge par le service d’envoi.');
      } else {
        showError(
          'Aucun e-mail programmé',
          'Vérifiez l’adresse e-mail du client, puis réessayez.',
        );
      }
    });
  };

  // R4 (P0 fermé) : signature sur place — le tracé du pad (dataURL) est TRANSMIS avec la
  // signature ; le serveur en calcule le SHA-256 et persiste { method:'onsite_draw', sha256,
  // capturedAt } (le dataURL lui-même n'est pas stocké en V1 — hash + méta ; archivage image =
  // évolution suivante). Le pad signe désormais ce qu'il affiche.
  // Reprise (challenge GPT 20260714, P1) : un échec (réseau…) reste DANS le pad — bandeau
  // d'erreur + bouton « Réessayer », tracé et nom intacts — jamais le double Alert du `run()`
  // partagé (l'erreur est avalée ICI, pas rethrow) ni un pad vidé qui ferait perdre le geste.
  const submitOnsiteSignature = (signerName: string, proofDataUrl: string) =>
    run('sign', async () => {
      setOnsiteError(null);
      try {
        await sign.mutateAsync({ quoteId: quote.id, signerName, proofDataUrl });
        setOnsiteOpen(false);
      } catch (e) {
        setOnsiteError(appErrorMessage(e));
      }
    });

  if (quote.status === 'draft') {
    return (
      <>
        <Button
          title="Envoyer"
          loading={busy === 'send'}
          disabled={!!busy}
          onPress={() =>
            void (async () => {
              if (!companyComplete) {
                setGate(companyIncompleteGateSpec('quote', personality));
                return;
              }
              const ok = await confirm({
                title: 'Envoyer le devis',
                message: `Le devis part chez ${customerName}.`,
                diff: buildActionDiff('envoyer_devis', {}, { number: quote.number }),
                challenge: challengeFor(OUTBOUND, 'confirm_all'),
              });
              if (ok) {
                await run('send', async () => {
                  const result = await send.mutateAsync(quote.id);
                  if (result.deliveryStatus === 'queued') {
                    showError(
                      'Envoi programmé',
                      'L’e-mail partira en arrière-plan. Vous pouvez suivre sa livraison dans l’activité.',
                    );
                  } else if (result.deliveryStatus === 'sent') {
                    showError(
                      'Devis envoyé',
                      'L’e-mail a été pris en charge par le service d’envoi.',
                    );
                  } else {
                    showError(
                      'Devis préparé',
                      'Le devis est passé au statut Envoyé, mais aucun e-mail n’a été programmé. Vérifiez l’adresse du client.',
                    );
                  }
                });
              }
            })()
          }
        />
        <GateSheet gate={gate} onClose={() => setGate(null)} />
        {errorSheet}
      </>
    );
  }
  if (quote.status === 'sent' || quote.status === 'viewed') {
    return (
      <>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <View style={{ flex: 1 }}>
            {/* R4 : « Faire signer » ouvre le VRAI choix (Sur place / Envoyer le lien) — l'ancienne
                ConfirmSheet booléenne sans tracé était mensongère (« signature » sans preuve). */}
            <Button
              title="Faire signer"
              loading={busy === 'sendLink' || busy === 'sendEmail'}
              disabled={!!busy}
              onPress={() => setSignChoiceOpen(true)}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Button
              title="Refuser"
              variant="danger"
              loading={busy === 'refuse'}
              disabled={!!busy}
              onPress={() =>
                void (async () => {
                  const ok = await confirm({
                    title: 'Refuser le devis',
                    message: 'Marquer ce devis comme refusé par le client ?',
                    challenge: challengeFor(REVERSIBLE, 'confirm_all'),
                    destructive: true,
                  });
                  if (ok) await run('refuse', () => refuse.mutateAsync(quote.id));
                })()
              }
            />
          </View>
        </View>
        <QuestionSheet
          visible={signChoiceOpen}
          header="Signature"
          question="Comment le client signe-t-il ?"
          options={[
            {
              value: 'onsite',
              label: 'Sur place',
              description: 'Il signe du doigt, directement sur votre téléphone.',
            },
            {
              value: 'link',
              label: 'Envoyer le lien',
              description:
                'Prépare le lien à partager toi-même — rien ne part tant que tu ne l’envoies pas.',
            },
            {
              value: 'email',
              label: 'Envoyer par e-mail',
              description: 'Bob envoie le lien par e-mail au client (confirmation avant envoi).',
            },
          ]}
          confirmLabel="Choisir"
          otherLabel="Annuler"
          onClose={() => setSignChoiceOpen(false)}
          onOther={() => setSignChoiceOpen(false)}
          onSelect={(values) => {
            setSignChoiceOpen(false);
            if (values[0] === 'onsite') {
              // Item 4 — devis B2C NON urgent : conseil « envoie plutôt le lien » AVANT le pad
              // (lien signé PLUS TARD = contrat à distance = acompte dès la signature ; signé
              // dans la foulée de la visite = hors établissement, L221-1, I-2°, b — 7 jours).
              // Le choix reste 100 % libre.
              if (
                shouldAdviseRemoteSignature({
                  customerType,
                  urgentRepairRequested: quote.urgentRepair != null,
                })
              ) {
                setSignAdviceOpen(true);
                return;
              }
              setOnsiteError(null);
              setOnsiteOpen(true);
            } else if (values[0] === 'email') {
              // Sortant réel : confirmation OUTBOUND explicite AVANT tout e-mail (P0 R4).
              void handleSendEmail();
            } else {
              // Préparation locale sans sortant : pas de confirmation nécessaire — le seul
              // « envoi » possible est le geste de partage de l'utilisateur lui-même.
              void handleSendLink();
            }
          }}
        />
        {/* Item 4 — conseil du canal AU BON MOMENT (B2C non urgent, « sur place » choisi) :
            bandeau bénéfice + LegalHint (différence à distance / hors établissement), puis le
            choix libre — « Envoyer le lien » OU « Continuer sur place ». */}
        <Sheet
          visible={signAdviceOpen}
          onClose={() => setSignAdviceOpen(false)}
          accessibilityLabel={t('legal.signatureChannel.banner', { personality })}
        >
          <Text
            accessibilityRole="header"
            style={[font('cardTitle'), { color: colors.ink900, marginBottom: 8, lineHeight: 22 }]}
          >
            {t('legal.signatureChannel.banner', { personality })}
          </Text>
          <View style={{ marginBottom: 14 }}>
            <LegalHint
              label={t('legal.signatureChannel.inline', { personality })}
              lawKey="legal.signatureChannel.law"
              whyKey="legal.signatureChannel.why"
              source="art. L221-1 et L221-10 du code de la consommation"
            />
          </View>
          <View style={{ gap: 8, marginBottom: 8 }}>
            <Button
              title="Envoyer le lien"
              loading={busy === 'sendLink'}
              disabled={!!busy}
              onPress={() => {
                setSignAdviceOpen(false);
                void handleSendLink();
              }}
            />
            <Button
              title="Continuer sur place"
              variant="secondary"
              disabled={!!busy}
              onPress={() => {
                setSignAdviceOpen(false);
                setOnsiteError(null);
                setOnsiteOpen(true);
              }}
            />
          </View>
        </Sheet>
        <SignOnsiteSheet
          visible={onsiteOpen}
          customerName={customerName}
          quoteNumber={quote.number}
          saving={busy === 'sign'}
          error={onsiteError}
          onClose={() => {
            setOnsiteOpen(false);
            setOnsiteError(null);
          }}
          onSubmit={(signerName, proofDataUrl) =>
            void submitOnsiteSignature(signerName, proofDataUrl)
          }
        />
        {errorSheet}
      </>
    );
  }
  if (quote.status === 'signed') {
    const invoiceCtaState = deriveQuoteInvoiceCtaState(linked);
    // Embargo L221-10 — l'invite du refus « encaisser » : feuille PARTAGÉE (EmbargoPromptSheet),
    // défaut d'abord, override responsabilisé en second niveau.
    const embargoSheet = (
      <EmbargoPromptSheet
        prompt={embargoPrompt}
        stage={embargoStage}
        busyDefault={busy === 'schedule'}
        busyOverride={busy === 'gen'}
        disabled={!!busy}
        onClose={() => {
          setEmbargoPrompt(null);
          setEmbargoStage('choice');
        }}
        onDefault={() => void scheduleEmbargoDefault()}
        onOverride={() => {
          if (embargoPrompt !== null) void overrideEmbargo(embargoPrompt);
        }}
        onStage={setEmbargoStage}
      />
    );
    // B8 : le devis porte un bon de commande — l'étape de génération AFFICHE la reprise
    // (« Bon de commande n° X repris sur la facture ») : réassurance, jamais de re-saisie.
    const poReassurance = quote.purchaseOrder ? (
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: semantic.successBg,
          borderRadius: 10,
          paddingVertical: 8,
          paddingHorizontal: 11,
          marginBottom: 8,
        }}
      >
        <Text
          numberOfLines={2}
          style={{ ...font('meta', 600), fontSize: 12, color: semantic.success, flex: 1 }}
        >
          {t('po.carriedToInvoice', {
            personality,
            params: { number: quote.purchaseOrder.number },
          })}
        </Text>
      </View>
    ) : null;
    // Ancien acompte professionnel déjà présent : il reste visible et archivable, mais la
    // finale n'est pas proposée tant que sa reprise structurée n'est pas certifiée.
    if (!depositPathAvailable && linked.hasDepositInvoice) {
      return (
        <View style={{ gap: 8 }}>
          <Badge
            label={t('piece.advanceRecoveryUnavailableTitle', { personality })}
            tone="warning"
          />
          <Text style={[font('meta'), { color: colors.slate500, lineHeight: 18 }]}>
            {t('piece.advanceRecoveryUnavailableBody', { personality })}
          </Text>
          {errorSheet}
        </View>
      );
    }
    // État (c) : la finale existe déjà — plus rien à générer.
    if (invoiceCtaState === 'final_draft_pending' || invoiceCtaState === 'final_exists') {
      return (
        <Badge
          label={
            invoiceCtaState === 'final_draft_pending'
              ? 'Facture brouillon prête'
              : 'Facture générée'
          }
          tone={invoiceCtaState === 'final_draft_pending' ? 'warning' : 'success'}
        />
      );
    }

    // État (b) : acompte lié SANS finale — LE bug R3 (mode:'final' explicite obligatoire, sinon
    // l'inférence retombe sur 'deposit' déjà facturé et renvoie l'existante sans rien créer).
    if (invoiceCtaState === 'deposit_draft_pending') {
      return <Badge label="Acompte brouillon à vérifier" tone="warning" />;
    }
    if (invoiceCtaState === 'generate_final') {
      return (
        <View>
          {poReassurance}
          <Button
            title={t('piece.actionFacturerSolde', { personality })}
            loading={busy === 'gen'}
            disabled={!!busy}
            onPress={() => void generateInvoice('final')}
          />
          {/* B2 : entre l'acompte et le solde, chaque avancement se facture en situation —
              la finale déduira automatiquement acompte + situations émises. */}
          <View style={{ marginTop: 8 }}>
            <Button
              title={t('situation.action', { personality })}
              variant="secondary"
              disabled={!!busy}
              onPress={() => setSituationOpen(true)}
            />
          </View>
          <SituationSheet
            visible={situationOpen}
            quote={quote}
            onClose={() => setSituationOpen(false)}
          />
          {embargoSheet}
          {errorSheet}
        </View>
      );
    }

    // État (a) : aucune facture liée — Sheet de choix. « 100 % » toujours ; « acompte » UNIQUEMENT
    // si le devis SIGNÉ en porte un (arbitrage 1 : le % est celui du contrat signé, jamais un autre).
    const choiceOptions = [
      { value: 'final', label: 'Facture de 100 %' },
      ...(depositPathAvailable && quote.depositPct !== null
        ? [{ value: 'deposit', label: `Facture d'acompte (${quote.depositPct} %)` }]
        : []),
      // B2 : la situation vit dans le MÊME choix que l'acompte et la finale — un seul geste,
      // la feuille dédiée règle le % (marché déjà facturé visible, garde cumul au serveur).
      { value: 'situation', label: t('situation.action', { personality }) },
    ];
    return (
      <>
        {poReassurance}
        <Button
          title="Générer la facture"
          loading={busy === 'gen'}
          disabled={!!busy}
          onPress={() => setChoiceOpen(true)}
        />
        <QuestionSheet
          visible={choiceOpen}
          header="Facture"
          question="Quelle facture veux-tu générer ?"
          options={choiceOptions}
          confirmLabel="Générer"
          otherLabel="Annuler"
          onClose={() => setChoiceOpen(false)}
          onOther={() => setChoiceOpen(false)}
          onSelect={(values) => {
            setChoiceOpen(false);
            if (values[0] === 'situation') {
              setSituationOpen(true);
              return;
            }
            void generateInvoice(values[0] === 'deposit' ? 'deposit' : 'final');
          }}
        />
        <SituationSheet
          visible={situationOpen}
          quote={quote}
          onClose={() => setSituationOpen(false)}
        />
        {embargoSheet}
        {errorSheet}
      </>
    );
  }
  return null; // refused / expired : rien à faire
});

export function InvoiceActions({
  invoice,
  withCreditNote = false,
  onDraftDeleted,
}: {
  invoice: InvoiceView;
  /** A6 : propose « Créer un avoir » (détail de pièce uniquement — action rare, pas en liste). */
  withCreditNote?: boolean;
  /** R6 : après suppression du brouillon, l'écran de DÉTAIL quitte la pièce qui n'existe plus
   * (la liste, elle, se contente du refetch — aucun callback à fournir). */
  onDraftDeleted?: () => void;
}): ReactNode {
  const issue = useIssueInvoice();
  const pay = useRegisterPayment();
  const link = useInvoicePaymentLink();
  const createCreditNote = useCreateCreditNote();
  const deleteDraft = useDeleteDraftInvoice();
  const scheduleEmbargo = useScheduleEmbargoPayment();
  // Feuille d'erreur premium locale (plus aucun Alert natif dans le flow encaissement/émission).
  const { showError, errorSheet } = useErrorSheet();
  const { busy, lock, run } = useActionLock(showError);
  const confirm = useConfirm();
  const client = useBobClient();
  const { semantic, personality } = useTheme();
  // Gates de l'émission (entreprise incomplète, conditions de paiement) — feuille locale unique.
  const [gate, setGate] = useState<GateSpec | null>(null);
  // Embargo L221-10 à l'ÉMISSION (l'acte qui rend la pièce opposable et permet le lien de
  // paiement) : le refus serveur devient la MÊME invite deux étages qu'à la génération —
  // jamais un « Oups » générique en cul-de-sac après un override déjà confirmé côté brouillon.
  const [embargoPrompt, setEmbargoPrompt] = useState<EmbargoPrompt | null>(null);
  const [embargoStage, setEmbargoStage] = useState<'choice' | 'confirm'>('choice');
  // BT-23 : quand biens et services coexistent, le serveur refuse AVANT tout numéro et demande
  // ce fait métier. La décision reste ouverte et séquentielle ; elle est réutilisée si l'embargo
  // L221-10 exige ensuite un second passage, sinon le replay perdrait la qualification fiscale.
  const [operationCategoryOpen, setOperationCategoryOpen] = useState(false);
  const [issueDecision, setIssueDecision] = useState(EMPTY_INVOICE_ISSUE_DECISION);

  const clearIssueDecision = (): void => {
    setIssueDecision(EMPTY_INVOICE_ISSUE_DECISION);
    setOperationCategoryOpen(false);
    setEmbargoPrompt(null);
    setEmbargoStage('choice');
  };

  const attemptIssue = async (input: {
    operationCategory?: FrenchOperationCategory;
    embargoOverride?: boolean;
  }): Promise<void> => {
    const nextDecision = mergeInvoiceIssueDecision(issueDecision, input);
    try {
      await issue.mutateAsync({
        invoiceId: invoice.id,
        ...invoiceIssueDecisionInput(nextDecision),
      });
      clearIssueDecision();
      if (nextDecision.embargoOverride) {
        showError(
          t('legal.embargoSheet.title', { personality }),
          t('legal.embargoOverride.traced', { personality }),
        );
      }
    } catch (error) {
      if (isOperationCategoryRequiredError(error)) {
        setIssueDecision(nextDecision);
        // Une seule décision à la fois : l'éventuelle feuille embargo disparaît avant BT-23.
        setEmbargoPrompt(null);
        setEmbargoStage('choice');
        setOperationCategoryOpen(true);
        return;
      }
      const prompt = embargoPromptOf(
        error,
        invoice.kind === 'deposit' ? 'deposit' : 'final',
      );
      if (prompt === null) {
        clearIssueDecision();
        showError('Oups', appErrorMessage(error));
        return;
      }
      setIssueDecision(nextDecision);
      setOperationCategoryOpen(false);
      setEmbargoStage('choice');
      setEmbargoPrompt(prompt);
    }
  };

  /** DÉFAUT légal : programme le message client (le devis parent porte la fenêtre embargo). */
  const scheduleEmbargoDefault = () =>
    run('schedule', async () => {
      try {
        if (invoice.parentQuoteId === null) {
          // Garde théorique : l'embargo ne frappe que les pièces dérivées d'un devis.
          throw { kind: 'unavailable', service: 'embargo-scheduled-payment' };
        }
        const scheduled = await scheduleEmbargo.mutateAsync(invoice.parentQuoteId);
        clearIssueDecision();
        showError(
          t('legal.embargoSheet.title', { personality }),
          t('legal.embargoSchedule.confirmed', {
            personality,
            // Date SERVEUR : source de vérité (gel de rétractation compris pour une finale).
            params: { date: formatDateOnlyFr(scheduled.availableFrom) },
          }),
        );
      } catch (e) {
        showError('Oups', appErrorMessage(e));
      }
    });

  /** OVERRIDE responsabilisé : rejoue l'ÉMISSION avec le flag explicite — tracé serveur. */
  const overrideEmbargoIssue = () =>
    run('issue', async () => {
      await attemptIssue({ embargoOverride: true });
    });

  const embargoSheet = (
    <EmbargoPromptSheet
      prompt={embargoPrompt}
      stage={embargoStage}
      busyDefault={busy === 'schedule'}
      busyOverride={busy === 'issue'}
      disabled={!!busy}
      onClose={clearIssueDecision}
      onDefault={() => void scheduleEmbargoDefault()}
      onOverride={() => void overrideEmbargoIssue()}
      onStage={setEmbargoStage}
    />
  );
  const operationCategorySheet = (
    <QuestionSheet
      visible={operationCategoryOpen}
      header={t('piece.operationCategory.title', { personality })}
      question={t('piece.operationCategory.question', { personality })}
      options={INVOICE_OPERATION_CATEGORIES.map((value) => ({
        value,
        label: t(`piece.operationCategory.${value}` as const, { personality }),
      }))}
      confirmLabel={t('piece.operationCategory.confirm', { personality })}
      otherLabel={t('piece.operationCategory.cancel', { personality })}
      onClose={clearIssueDecision}
      onOther={clearIssueDecision}
      onSelect={(values) => {
        const category = parseInvoiceOperationCategoryChoice(values[0]);
        if (category === null) {
          showError('Oups', t('piece.operationCategory.invalid', { personality }));
          return;
        }
        setOperationCategoryOpen(false);
        void run('issue', () => attemptIssue({ operationCategory: category }));
      }}
    />
  );
  // Gate entreprise complète — même doctrine que QuoteActions (voir companyIncompleteGateSpec) :
  // ne concerne que la toute première émission (état brouillon → numéro légal alloué).
  const companyMe = useCompanyMe();
  const companyComplete = companyCanIssue(companyMe.data);
  const billingSettings = useCompanyBillingSettings();

  // A6 : avoir TOTAL — confirmation FISCAL (l'avoir s'émettra avec son numéro A- et
  // l'écriture inverse), puis navigation vers le brouillon créé.
  const creditNoteButton = withCreditNote && canCreateCreditNote(invoice) && (
    <Button
      title="Créer un avoir"
      variant="secondary"
      loading={busy === 'credit'}
      disabled={!!busy}
      onPress={() =>
        void (async () => {
          const ok = await confirm({
            title: 'Créer un avoir',
            message: `Avoir total sur ${invoice.number ?? 'cette facture'} : il s'émettra avec son propre numéro (A-) et passera l'écriture comptable inverse.`,
            challenge: challengeFor(FISCAL, 'confirm_all'),
          });
          if (!ok) return;
          await run('credit', async () => {
            const out = await createCreditNote.mutateAsync({ invoiceId: invoice.id });
            router.push(`/facture/${out.creditNoteId}`);
          });
        })()
      }
    />
  );

  if (invoice.status === 'paid') {
    // Facture payée : plus rien à encaisser — reste l'avoir (correction/geste commercial).
    return creditNoteButton ? (
      <>
        {creditNoteButton}
        {errorSheet}
      </>
    ) : null;
  }

  if (invoice.status === 'draft') {
    return (
      <>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Button
            title="Émettre"
            loading={busy === 'issue'}
            disabled={!!busy || billingSettings.isLoading}
            onPress={() =>
              void (async () => {
                if (!companyComplete) {
                  setGate(companyIncompleteGateSpec('invoice', personality));
                  return;
                }
                if (billingSettings.isError || billingSettings.data === undefined) {
                  showError(t('reglages.dataError', { personality }));
                  return;
                }
                const paymentTermsDays = billingSettings.data.defaultInvoicePaymentTermsDays;
                if (paymentTermsDays === null) {
                  setGate(paymentTermsMissingGateSpec(personality));
                  return;
                }
                // Aperçu comptable prévisionnel (le domaine sait prévisualiser un brouillon) — best-effort.
                const preview = await client.invoiceAccountingPreview(invoice.id);
                const accountingLines =
                  preview.ok && preview.value.available ? preview.value.lines : undefined;
                const ok = await confirm({
                  title: 'Émettre la facture',
                  message: `Numéro légal attribué · échéance à ${paymentTermsDays} jours · transmission e-invoicing.`,
                  diff: buildActionDiff(
                    'emettre_facture',
                    { paymentTermsDays },
                    {
                      number: invoice.number,
                      accountingLines,
                    },
                  ),
                  challenge: challengeFor(FISCAL, 'confirm_all'),
                });
                if (ok)
                  await run('issue', async () => {
                    await attemptIssue({});
                  });
              })()
            }
          />
        </View>
        {/* R6 : erreur détectée dans le devis source -> supprimer le brouillon (jamais une pièce émise).
            Corbeille canonique @bob/ui (DeleteIconButton) — même composant que catalogue.tsx C27. */}
        <DeleteIconButton
          icon={<Feather name="trash-2" size={20} color={semantic.danger} />}
          accessibilityLabel="Supprimer le brouillon"
          size={52}
          radius={16}
          loading={busy === 'delete'}
          disabled={!!busy}
          onPress={() =>
            void (async () => {
              const ok = await confirm({
                title: 'Supprimer le brouillon',
                message: `Cette facture brouillon${invoice.number ? ` ${invoice.number}` : ''} sera définitivement supprimée. Cette action est irréversible.`,
                challenge: challengeFor(REVERSIBLE, 'confirm_all'),
                destructive: true,
              });
              if (ok) {
                await run('delete', async () => {
                  await deleteDraft.mutateAsync(invoice.id);
                  onDraftDeleted?.();
                });
              }
            })()
          }
        />
      </View>
      {embargoSheet}
      {operationCategorySheet}
      <GateSheet gate={gate} onClose={() => setGate(null)} />
      {errorSheet}
      </>
    );
  }
  // S5 : prédicat PARTAGÉ avec l'affordance vocale « lien de paiement » (facture/[id].tsx) —
  // la parité voix↔tap est structurelle : même condition, même hook (useInvoicePaymentLink).
  if (isPaymentLinkEligible(invoice.status)) {
    const remaining = collectRemainingCents(invoice);
    return (
      <>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {remaining > 0 ? (
          <View style={{ flex: 1 }}>
            <Button
              title="Marquer payée"
              loading={busy === 'pay'}
              disabled={!!busy}
              onPress={() =>
                void (async () => {
                  const preview = await resolveCollectAccountingPreview(client, {
                    invoiceId: invoice.id,
                    expectedRemainingCents: remaining,
                  });
                  if (preview.kind === 'error') {
                    showError('Aperçu indisponible', appErrorMessage(preview.error));
                    return;
                  }
                  if (preview.kind === 'unavailable') {
                    showError('Aperçu indisponible', preview.reason);
                    return;
                  }
                  if (preview.kind === 'stale') {
                    showError(
                      'Facture actualisée',
                      'Le reste dû a changé. Actualise la facture avant d’enregistrer le paiement.',
                    );
                    return;
                  }
                  if (preview.kind === 'invalid_contract') {
                    showError(
                      'Aperçu indisponible',
                      'La preuve comptable reçue est incohérente. Réessaie avant d’enregistrer le paiement.',
                    );
                    return;
                  }
                  const ok = await confirm(collectConfirmSpec(invoice, remaining, preview.lines));
                  if (ok)
                    await run('pay', () =>
                      pay.mutateAsync({
                        invoiceId: invoice.id,
                        amount: remaining,
                        method: 'transfer',
                        idempotencyKey: paymentIdempotencyKey(invoice, remaining),
                      }),
                    );
                })()
              }
            />
          </View>
        ) : null}
        <View style={{ flex: 1 }}>
          {/* Le hook gère déjà erreur (Alert) + ouverture de l'URL — on n'enveloppe PAS dans run() (sinon double Alert). */}
          <Button
            title="Lien de paiement"
            variant="secondary"
            loading={link.isPending}
            disabled={!!busy || link.isPending}
            onPress={() => {
              if (lock.current) return;
              link.mutate(invoice.id);
            }}
          />
        </View>
        {creditNoteButton ? <View style={{ flex: 1 }}>{creditNoteButton}</View> : null}
      </View>
      {errorSheet}
      </>
    );
  }
  return null; // cancelled : rien à faire
}
