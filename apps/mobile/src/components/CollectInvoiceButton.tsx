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
import { useBobClient } from '../data/client';
import { appErrorMessage, useRegisterPayment } from '../data/hooks';
import { useConfirm } from './ConfirmSheet';
import {
  collectConfirmSpec,
  collectRemainingCents,
  isCollectible,
  paymentIdempotencyKey,
} from './DocumentActions';
import { resolveCollectAccountingPreview } from './collect-accounting-preview';

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
  const client = useBobClient();
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
            const ok = await confirm(
              collectConfirmSpec(invoice, remaining, preview.lines),
            );
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
