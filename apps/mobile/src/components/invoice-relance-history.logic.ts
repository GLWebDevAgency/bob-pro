import type { NotificationView } from '@bob/api-client';

/**
 * PR-06 — historique des relances d'UNE facture : filtre PUR du fil de notifications serveur
 * (les jobs `invoice-relance`, dont la clé de dédup `invoice:{id}:relance:*` produit le deep
 * link `/facture/{id}` — notificationRoute, source unique côté serveur). Aucun état parallèle :
 * ce que le fil sait, la fiche le montre — rien de plus, rien d'inventé.
 */
export function relanceHistoryForInvoice(
  items: readonly NotificationView[],
  invoiceId: string,
): NotificationView[] {
  return items.filter(
    (item) => item.kind === 'invoice-relance' && item.route === `/facture/${invoiceId}`,
  );
}

/** Libellé i18n du statut d'un job de relance — `done` = livrée, sinon l'état honnête. */
export function relanceHistoryStatusKey(
  status: string,
): 'facture.relanceSent' | 'facture.relancePending' | 'facture.relanceFailed' {
  if (status === 'done') return 'facture.relanceSent';
  if (status === 'failed') return 'facture.relanceFailed';
  return 'facture.relancePending';
}
