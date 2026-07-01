import { useRef, useState, type ReactNode } from 'react';
import { View, Alert } from 'react-native';
import type { QuoteView, InvoiceView } from '@bob/api-client';
import { challengeFor, buildActionDiff } from '@bob/ai';
import {
  useSendQuote,
  useSignQuote,
  useRefuseQuote,
  useGenerateInvoice,
  useIssueInvoice,
  useRegisterPayment,
  useInvoicePaymentLink,
  appErrorMessage,
} from '../data/hooks';
import { Button, Badge } from './ui';
import { useConfirm } from './ConfirmSheet';
import { useBobClient } from '../data/client';

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
  inv.status === 'draft' || inv.status === 'issued' || inv.status === 'partially_paid' || inv.status === 'late';

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

export function QuoteActions({
  quote,
  customerName,
  alreadyInvoiced = false,
}: {
  quote: QuoteView;
  customerName: string;
  /** Vrai si une facture liée existe déjà (dérivé de InvoiceView.parentQuoteId) — garde DURABLE anti-doublon UI. */
  alreadyInvoiced?: boolean;
}): ReactNode {
  const send = useSendQuote();
  const sign = useSignQuote();
  const refuse = useRefuseQuote();
  const generate = useGenerateInvoice();
  const { busy, run } = useActionLock();
  const confirm = useConfirm();
  // Confort UX : masque l'action après un succès dans la session (fallback quand la liste des factures liées
  // n'est pas disponible). La sûreté anti-doublon est garantie AU DOMAINE (GenerateInvoiceFromQuote idempotent
  // par parentQuoteId+kind) ; `alreadyInvoiced` rend le masquage durable là où l'appelant connaît les liens.
  const [invoiced, setInvoiced] = useState(false);

  if (quote.status === 'draft') {
    return (
      <Button
        title="Envoyer"
        loading={busy === 'send'}
        disabled={!!busy}
        onPress={() =>
          void (async () => {
            const ok = await confirm({
              title: 'Envoyer le devis',
              message: `Le devis part chez ${customerName}.`,
              diff: buildActionDiff('envoyer_devis', {}, { number: quote.number }),
              challenge: challengeFor(OUTBOUND, 'confirm_all'),
            });
            if (ok) await run('send', () => send.mutateAsync(quote.id));
          })()
        }
      />
    );
  }
  if (quote.status === 'sent' || quote.status === 'viewed') {
    return (
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Button
            title="Signer sur place"
            loading={busy === 'sign'}
            disabled={!!busy}
            onPress={() =>
              void (async () => {
                const ok = await confirm({
                  title: 'Signature sur place',
                  message: 'Le client signe le devis maintenant.',
                  challenge: challengeFor(REVERSIBLE, 'confirm_all'),
                });
                if (ok) await run('sign', () => sign.mutateAsync({ quoteId: quote.id, signerName: customerName }));
              })()
            }
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
    );
  }
  if (quote.status === 'signed') {
    if (invoiced || alreadyInvoiced) return <Badge label="Facture générée" tone="success" />;
    return (
      <Button
        title="Générer la facture"
        loading={busy === 'gen'}
        disabled={!!busy}
        onPress={() =>
          void run('gen', async () => {
            await generate.mutateAsync({ quoteId: quote.id });
            setInvoiced(true); // one-shot : plus de re-génération dans cette session
          })
        }
      />
    );
  }
  return null; // refused / expired : rien à faire
}

export function InvoiceActions({ invoice }: { invoice: InvoiceView }): ReactNode {
  const issue = useIssueInvoice();
  const pay = useRegisterPayment();
  const link = useInvoicePaymentLink();
  const { busy, lock, run } = useActionLock();
  const confirm = useConfirm();
  const client = useBobClient();

  if (invoice.status === 'draft') {
    return (
      <Button
        title="Émettre"
        loading={busy === 'issue'}
        disabled={!!busy}
        onPress={() =>
          void (async () => {
            // Aperçu comptable prévisionnel (le domaine sait prévisualiser un brouillon) — best-effort.
            const preview = await client.invoiceAccountingPreview(invoice.id);
            const accountingLines = preview.ok && preview.value.available ? preview.value.lines : undefined;
            const ok = await confirm({
              title: 'Émettre la facture',
              message: 'Numéro légal attribué et transmission e-invoicing.',
              diff: buildActionDiff('emettre_facture', {}, { number: invoice.number, accountingLines }),
              challenge: challengeFor(FISCAL, 'confirm_all'),
            });
            if (ok) await run('issue', () => issue.mutateAsync(invoice.id));
          })()
        }
      />
    );
  }
  if (invoice.status === 'issued' || invoice.status === 'partially_paid' || invoice.status === 'late') {
    // Assiette = netToPay (acompte si depositPct, sinon ttc) : le domaine PLAFONNE le paiement à netToPay
    // (invoice.ts). Baser sur ttc ferait rejeter l'encaissement d'une facture d'acompte.
    const remaining = Math.max(0, invoice.totals.netToPay - invoice.paid);
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
                  const ok = await confirm({
                    title: 'Enregistrer le paiement',
                    message: 'Met à jour le journal de banque, le compte client et les relances.',
                    diff: buildActionDiff(
                      'encaisser_facture',
                      { amountCents: remaining },
                      { number: invoice.number, remainingCents: remaining },
                    ),
                    challenge: challengeFor(ACCOUNTING, 'confirm_all', { amountCents: remaining }),
                  });
                  if (ok)
                    await run('pay', () =>
                      pay.mutateAsync({
                        invoiceId: invoice.id,
                        amount: remaining,
                        method: 'transfer',
                        idempotencyKey: `mobile:payment:${invoice.id}:${invoice.paid}:${remaining}:transfer`,
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
      </View>
    );
  }
  return null; // paid / cancelled : rien à faire
}
