import { forwardRef, useImperativeHandle, useRef, useState, type ReactNode } from 'react';
import { View, Alert, Share } from 'react-native';
import { router } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import type { AccountingPreviewLine, QuoteView, InvoiceView } from '@bob/api-client';
import { challengeFor, buildActionDiff } from '@bob/ai';
import { t, type Personality } from '@bob/i18n';
import { DeleteIconButton, QuestionSheet, useTheme } from '@bob/ui';
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
  appErrorMessage,
} from '../data/hooks';
import { Button, Badge } from './ui';
import { useConfirm } from './ConfirmSheet';
import { useBobClient } from '../data/client';
import { companyCanIssue } from '../data/company-completeness';
import {
  deriveQuoteInvoiceCtaState,
  type QuoteInvoiceLinksState,
} from './quote-invoice-actions.logic';
import { SignOnsiteSheet } from './SignOnsiteSheet';
import { resolveCollectAccountingPreview } from './collect-accounting-preview';
import { isPaymentLinkEligible } from '../lib/payment-link-affordance';

/**
 * Gate « entreprise complète » (RÈGLE PRODUIT, compte.tsx §Entreprise) : l'app reste utilisable
 * sans fiche entreprise complète (brouillons…), le gate n'apparaît qu'à l'ACTE qui l'exige
 * légalement — ici, la toute première émission (devis « Envoyer » depuis l'état brouillon,
 * facture « Émettre » depuis l'état brouillon : c'est précisément à ce moment que le numéro légal
 * est alloué). Les renvois/partages d'un devis DÉJÀ envoyé ne sont pas re-gatés : la complétude a
 * déjà été vérifiée à son premier envoi. CTA → /compte (fiche entreprise, §3 du chantier).
 */
function showCompanyIncompleteGate(kind: 'quote' | 'invoice', personality: Personality): void {
  Alert.alert(
    t('gate.companyIncompleteTitle', { personality }),
    t(kind === 'quote' ? 'gate.companyIncompleteBodyQuote' : 'gate.companyIncompleteBodyInvoice', {
      personality,
    }),
    [
      { text: t('gate.companyIncompleteCancel', { personality }), style: 'cancel' },
      {
        text: t('gate.companyIncompleteCta', { personality }),
        onPress: () => router.push('/compte'),
      },
    ],
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

export type BadgeTone = 'b2b' | 'b2g' | 'particulier' | 'success' | 'warning' | 'danger' | 'ai';

// Statut -> pastille (label FR + ton DA). Records exhaustifs : ajouter un statut oblige à le mapper.
export const QUOTE_BADGE: Record<QuoteView['status'], { label: string; tone: BadgeTone }> = {
  draft: { label: 'Brouillon', tone: 'warning' },
  sent: { label: 'Envoyé', tone: 'b2b' },
  viewed: { label: 'Vu', tone: 'b2b' },
  signed: { label: 'Signé', tone: 'success' },
  refused: { label: 'Refusé', tone: 'danger' },
  expired: { label: 'Expiré', tone: 'danger' },
};
export const INVOICE_BADGE: Record<InvoiceView['status'], { label: string; tone: BadgeTone }> = {
  draft: { label: 'Brouillon', tone: 'warning' },
  issued: { label: 'Émise', tone: 'b2b' },
  partially_paid: { label: 'Partielle', tone: 'warning' },
  paid: { label: 'Payée', tone: 'success' },
  late: { label: 'En retard', tone: 'danger' },
  cancelled: { label: 'Annulée', tone: 'danger' },
};

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

// Verrou : `busy` (state) pilote spinner/disabled ; `lock` (ref) bloque un 2e tap avant tout re-render.
function useActionLock() {
  const [busy, setBusy] = useState<string | null>(null);
  const lock = useRef(false);
  const run = async (key: string, fn: () => Promise<unknown>): Promise<void> => {
    if (lock.current) return;
    lock.current = true;
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      Alert.alert('Oups', appErrorMessage(e));
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
  }
>(function QuoteActions(
  { quote, customerName, linkedInvoices = NO_LINKED_INVOICES },
  ref,
): ReactNode {
  const { personality } = useTheme();
  const send = useSendQuote();
  const sign = useSignQuote();
  const signatureLink = useCreateQuoteSignatureLink();
  const refuse = useRefuseQuote();
  const generate = useGenerateInvoice();
  const { busy, run } = useActionLock();
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
  const [choiceOpen, setChoiceOpen] = useState(false);
  // R4 : choix de signature (Sur place / Envoyer le lien) puis, si « Sur place », le pad lui-même.
  const [signChoiceOpen, setSignChoiceOpen] = useState(false);
  const [onsiteOpen, setOnsiteOpen] = useState(false);
  // Mode passage client durci (challenge GPT 20260714, P1 reprise) : un échec réseau de
  // `signQuote` ne doit jamais vider le pad — l'erreur vit ICI (pas dans SignOnsiteSheet) pour
  // survivre à ses re-renders, et n'est réarmée qu'à une ouverture explicite du pad.
  const [onsiteError, setOnsiteError] = useState<string | null>(null);
  const linked: QuoteLinkedInvoices = {
    hasDepositInvoice: linkedInvoices.hasDepositInvoice || localLinked.hasDepositInvoice,
    hasFinalInvoice: linkedInvoices.hasFinalInvoice || localLinked.hasFinalInvoice,
    depositStatus: linkedInvoices.depositStatus ?? localLinked.depositStatus,
    finalStatus: linkedInvoices.finalStatus ?? localLinked.finalStatus,
  };
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
  const generateInvoice = (mode: 'deposit' | 'final') =>
    run('gen', async () => {
      const out = await generate.mutateAsync({ quoteId: quote.id, mode });
      setLocalLinked((prev) => ({
        ...prev,
        ...(mode === 'deposit'
          ? { hasDepositInvoice: true, depositStatus: 'draft' as const }
          : { hasFinalInvoice: true, finalStatus: 'draft' as const }),
      }));
      router.push(`/facture/${out.invoiceId}`);
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
        Alert.alert(
          'Envoi programmé',
          'L’e-mail partira en arrière-plan. Vous pouvez suivre sa livraison dans l’activité.',
        );
      } else if (result.deliveryStatus === 'sent') {
        Alert.alert('E-mail envoyé', 'L’e-mail a été pris en charge par le service d’envoi.');
      } else {
        Alert.alert(
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
      <Button
        title="Envoyer"
        loading={busy === 'send'}
        disabled={!!busy}
        onPress={() =>
          void (async () => {
            if (!companyComplete) {
              showCompanyIncompleteGate('quote', personality);
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
                  Alert.alert(
                    'Envoi programmé',
                    'L’e-mail partira en arrière-plan. Vous pouvez suivre sa livraison dans l’activité.',
                  );
                } else if (result.deliveryStatus === 'sent') {
                  Alert.alert(
                    'Devis envoyé',
                    'L’e-mail a été pris en charge par le service d’envoi.',
                  );
                } else {
                  Alert.alert(
                    'Devis préparé',
                    'Le devis est passé au statut Envoyé, mais aucun e-mail n’a été programmé. Vérifiez l’adresse du client.',
                  );
                }
              });
            }
          })()
        }
      />
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
      </>
    );
  }
  if (quote.status === 'signed') {
    const invoiceCtaState = deriveQuoteInvoiceCtaState(linked);
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
        <Button
          title={t('piece.actionFacturerSolde', { personality })}
          loading={busy === 'gen'}
          disabled={!!busy}
          onPress={() => void generateInvoice('final')}
        />
      );
    }

    // État (a) : aucune facture liée — Sheet de choix. « 100 % » toujours ; « acompte » UNIQUEMENT
    // si le devis SIGNÉ en porte un (arbitrage 1 : le % est celui du contrat signé, jamais un autre).
    const choiceOptions = [
      { value: 'final', label: 'Facture de 100 %' },
      ...(quote.depositPct !== null
        ? [{ value: 'deposit', label: `Facture d'acompte (${quote.depositPct} %)` }]
        : []),
    ];
    return (
      <>
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
            void generateInvoice(values[0] === 'deposit' ? 'deposit' : 'final');
          }}
        />
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
  const { busy, lock, run } = useActionLock();
  const confirm = useConfirm();
  const client = useBobClient();
  const { semantic, personality } = useTheme();
  // Gate entreprise complète — même doctrine que QuoteActions (voir showCompanyIncompleteGate) :
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
    return creditNoteButton || null;
  }

  if (invoice.status === 'draft') {
    return (
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Button
            title="Émettre"
            loading={busy === 'issue'}
            disabled={!!busy || billingSettings.isLoading}
            onPress={() =>
              void (async () => {
                if (!companyComplete) {
                  showCompanyIncompleteGate('invoice', personality);
                  return;
                }
                if (billingSettings.isError || billingSettings.data === undefined) {
                  Alert.alert(t('reglages.dataError', { personality }), undefined, [
                    {
                      text: t('common.close', { personality }),
                      style: 'cancel',
                    },
                  ]);
                  return;
                }
                const paymentTermsDays = billingSettings.data.defaultInvoicePaymentTermsDays;
                if (paymentTermsDays === null) {
                  Alert.alert(
                    t('invoice.paymentTermsMissingTitle', { personality }),
                    t('invoice.paymentTermsMissingBody', { personality }),
                    [
                      { text: t('common.cancel', { personality }), style: 'cancel' },
                      {
                        text: t('invoice.paymentTermsMissingCta', { personality }),
                        onPress: () => router.push('/reglages-facturation'),
                      },
                    ],
                  );
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
                if (ok) await run('issue', () => issue.mutateAsync(invoice.id));
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
    );
  }
  // S5 : prédicat PARTAGÉ avec l'affordance vocale « lien de paiement » (facture/[id].tsx) —
  // la parité voix↔tap est structurelle : même condition, même hook (useInvoicePaymentLink).
  if (isPaymentLinkEligible(invoice.status)) {
    const remaining = collectRemainingCents(invoice);
    return (
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
                    Alert.alert('Aperçu indisponible', appErrorMessage(preview.error));
                    return;
                  }
                  if (preview.kind === 'unavailable') {
                    Alert.alert('Aperçu indisponible', preview.reason);
                    return;
                  }
                  if (preview.kind === 'stale') {
                    Alert.alert(
                      'Facture actualisée',
                      'Le reste dû a changé. Actualise la facture avant d’enregistrer le paiement.',
                    );
                    return;
                  }
                  if (preview.kind === 'invalid_contract') {
                    Alert.alert(
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
    );
  }
  return null; // cancelled : rien à faire
}
