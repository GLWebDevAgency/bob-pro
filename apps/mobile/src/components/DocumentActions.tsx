import { useRef, useState, type ReactNode } from 'react';
import { View, Alert } from 'react-native';
import { formatEUR } from '@bob/core';
import type { QuoteView, InvoiceView } from '@bob/api-client';
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

// Plancher de sécurité manuel. `destructive` (rouge iOS) réservé aux actions vraiment destructrices (refus).
function confirmThen(title: string, message: string, onOk: () => void, destructive = false): void {
  Alert.alert(title, message, [
    { text: 'Annuler', style: 'cancel' },
    { text: 'Confirmer', style: destructive ? 'destructive' : 'default', onPress: onOk },
  ]);
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

export function QuoteActions({ quote, customerName }: { quote: QuoteView; customerName: string }): ReactNode {
  const send = useSendQuote();
  const sign = useSignQuote();
  const refuse = useRefuseQuote();
  const generate = useGenerateInvoice();
  const { busy, run } = useActionLock();
  // Confort UX : masque l'action après un succès dans la session. La sûreté anti-doublon est garantie
  // AU DOMAINE (GenerateInvoiceFromQuote est idempotent, dédup par parentQuoteId+kind) — ceci n'est
  // qu'un retour visuel local (non partagé entre l'instance liste et l'instance détail).
  const [invoiced, setInvoiced] = useState(false);

  if (quote.status === 'draft') {
    return (
      <Button
        title="Envoyer"
        loading={busy === 'send'}
        disabled={!!busy}
        onPress={() =>
          confirmThen('Envoyer le devis', `Le devis part chez ${customerName}. Continuer ?`, () =>
            void run('send', () => send.mutateAsync(quote.id)),
          )
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
              confirmThen('Signature sur place', 'Le client signe le devis maintenant. Confirmer ?', () =>
                void run('sign', () => sign.mutateAsync({ quoteId: quote.id, signerName: customerName })),
              )
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
              confirmThen(
                'Refuser le devis',
                'Marquer ce devis comme refusé par le client ?',
                () => void run('refuse', () => refuse.mutateAsync(quote.id)),
                true,
              )
            }
          />
        </View>
      </View>
    );
  }
  if (quote.status === 'signed') {
    if (invoiced) return <Badge label="Facture générée" tone="success" />;
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

  if (invoice.status === 'draft') {
    return (
      <Button
        title="Émettre"
        loading={busy === 'issue'}
        disabled={!!busy}
        onPress={() =>
          confirmThen(
            'Émettre la facture',
            'Action définitive : numéro légal attribué et transmission e-invoicing. Émettre ?',
            () => void run('issue', () => issue.mutateAsync(invoice.id)),
          )
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
                confirmThen(
                  'Enregistrer le paiement',
                  `Encaisser ${formatEUR(remaining)} met à jour ta compta (CA, TVA, relances). Confirmer ?`,
                  () =>
                    void run('pay', () =>
                      pay.mutateAsync({
                        invoiceId: invoice.id,
                        amount: remaining,
                        method: 'transfer',
                        idempotencyKey: `mobile:payment:${invoice.id}:${invoice.paid}:${remaining}:transfer`,
                      }),
                    ),
                )
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
