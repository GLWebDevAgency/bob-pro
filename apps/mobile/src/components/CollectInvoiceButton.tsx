/**
 * « Encaisser » hors écran Ventes (briefing, A2-C10) : LE MÊME flux que InvoiceActions —
 * confirmation typée ACCOUNTING (collectConfirmSpec), assiette plafonnée netToPay,
 * idempotence, useRegisterPayment — mais rendu @bob/ui (DA du briefing). Parité d'actions :
 * aucun chemin parallèle, uniquement les invariants partagés de DocumentActions.
 * Rend null si la facture n'a rien à encaisser (pas de bouton fantôme).
 */
import { useRef, useState } from 'react';
import { Alert } from 'react-native';
import type { InvoiceView } from '@bob/api-client';
import { Button } from '@bob/ui';
import { appErrorMessage, useRegisterPayment } from '../data/hooks';
import { useConfirm } from './ConfirmSheet';
import {
  collectConfirmSpec,
  collectRemainingCents,
  isCollectible,
  paymentIdempotencyKey,
} from './DocumentActions';

export function CollectInvoiceButton({
  invoice,
  title,
  onDone,
}: {
  invoice: InvoiceView;
  title: string;
  /** Appelé après encaissement réussi avec le montant enregistré (toast du parent). */
  onDone?: (amountCents: number) => void;
}) {
  const pay = useRegisterPayment();
  const confirm = useConfirm();
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);

  if (!isCollectible(invoice)) return null;
  const remaining = collectRemainingCents(invoice);

  return (
    <Button
      title={title}
      variant="secondary"
      size="compact"
      radius={11}
      loading={busy}
      disabled={busy}
      onPress={() =>
        void (async () => {
          if (lock.current) return;
          lock.current = true;
          try {
            const ok = await confirm(collectConfirmSpec(invoice, remaining));
            if (!ok) return;
            setBusy(true);
            await pay.mutateAsync({
              invoiceId: invoice.id,
              amount: remaining,
              method: 'transfer',
              idempotencyKey: paymentIdempotencyKey(invoice, remaining),
            });
            onDone?.(remaining);
          } catch (e) {
            Alert.alert('Oups', appErrorMessage(e));
          } finally {
            lock.current = false;
            setBusy(false);
          }
        })()
      }
    />
  );
}
