import type { OcrExtraction, PaymentMethod } from '@bob/core';

/**
 * Routage payé/à payer du scan (bug ticket Leroy Merlin ≠ facture fournisseur).
 *
 * Un ticket de caisse EST une preuve de paiement : la dépense doit naître PAYÉE, le scan
 * attaché comme preuve. Une facture fournisseur reste « à payer » (avec son échéance lue).
 * Quand l'extraction ne tranche pas (`kind` null), on NE devine PAS : l'écran de validation
 * pose la question. Module PUR (aucune dépendance React) — testable et partagé avec la voix.
 */

export type ScanSettlementChoice = 'paid' | 'to_pay';

export interface ScanSettlementProposal {
  /** Statut proposé par l'extraction — null = ambigu, la question DOIT être posée. */
  proposal: ScanSettlementChoice | null;
  /** Moyen de règlement LU sur le ticket (CB/espèces), null s'il n'est pas visible. */
  methodSeen: PaymentMethod | null;
  /** Échéance lue sur une facture fournisseur, sinon null. */
  dueAt: string | null;
}

export function deriveScanSettlementProposal(
  extraction: Pick<OcrExtraction, 'kind' | 'paymentMethodSeen' | 'dueDate'>,
): ScanSettlementProposal {
  if (extraction.kind === 'ticket_caisse') {
    return { proposal: 'paid', methodSeen: extraction.paymentMethodSeen, dueAt: null };
  }
  if (extraction.kind === 'facture_fournisseur') {
    return { proposal: 'to_pay', methodSeen: null, dueAt: extraction.dueDate };
  }
  return { proposal: null, methodSeen: null, dueAt: null };
}

/** Moyen par défaut du ticket quand rien n'est lisible — affiché et corrigeable d'un tap. */
export const DEFAULT_TICKET_PAYMENT_METHOD: PaymentMethod = 'card';

export interface ScanSettlementDecision {
  choice: ScanSettlementChoice;
  method: PaymentMethod;
  dueAt: string | null;
}

export interface ScanSettlementExpenseFields {
  /** Ticket déjà réglé : date + moyen. La preuve = l'original scanné, imposée côté serveur. */
  payment?: { paidOn: string; method: PaymentMethod };
  dueAt?: string;
}

/**
 * Traduit la décision (proposée puis confirmée à l'écran ou à la voix) en champs de la
 * commande de création : payé → `payment` (paidOn = date de la pièce) ; à payer → `dueAt`
 * si une échéance a été lue. Jamais les deux.
 */
export function settlementExpenseFields(
  decision: ScanSettlementDecision,
  documentDate: string,
): ScanSettlementExpenseFields {
  if (decision.choice === 'paid') {
    return { payment: { paidOn: documentDate, method: decision.method } };
  }
  return decision.dueAt !== null ? { dueAt: decision.dueAt } : {};
}
