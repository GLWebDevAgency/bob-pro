import type { InvoiceView } from '@bob/api-client';

export interface QuoteInvoiceLinksState {
  readonly hasDepositInvoice: boolean;
  readonly hasFinalInvoice: boolean;
  readonly depositStatus: InvoiceView['status'] | null;
  readonly finalStatus: InvoiceView['status'] | null;
}

export type QuoteInvoiceCtaState =
  | 'choose_first_invoice'
  | 'deposit_draft_pending'
  | 'generate_final'
  | 'final_draft_pending'
  | 'final_exists';

/**
 * Le CTA dépend du cycle réel des pièces liées, pas seulement de leur existence. En particulier,
 * un acompte encore brouillon ne doit jamais ouvrir la génération du solde : il n'est pas encore
 * déductible par le domaine comptable.
 */
export function deriveQuoteInvoiceCtaState(links: QuoteInvoiceLinksState): QuoteInvoiceCtaState {
  if (links.hasFinalInvoice) {
    return links.finalStatus === 'draft' ? 'final_draft_pending' : 'final_exists';
  }
  if (links.hasDepositInvoice) {
    return links.depositStatus === 'draft' ? 'deposit_draft_pending' : 'generate_final';
  }
  return 'choose_first_invoice';
}

/**
 * Fusion source DURABLE (refetch serveur) + écho de session (optimisme post-génération) :
 * la durable prime toujours, l'écho ne comble que ce que le serveur n'a pas encore confirmé.
 */
export function mergeLinkedInvoices(
  durable: QuoteInvoiceLinksState,
  echo: QuoteInvoiceLinksState,
): QuoteInvoiceLinksState {
  return {
    hasDepositInvoice: durable.hasDepositInvoice || echo.hasDepositInvoice,
    hasFinalInvoice: durable.hasFinalInvoice || echo.hasFinalInvoice,
    depositStatus: durable.depositStatus ?? echo.depositStatus,
    finalStatus: durable.finalStatus ?? echo.finalStatus,
  };
}

/**
 * L'écho de session ne survit JAMAIS à la confirmation serveur : dès que la source durable
 * porte une pièce, son écho s'efface. Sans cette réconciliation, le OR de la fusion ne peut
 * jamais redescendre — supprimer ensuite le brouillon laissait badge/CTA fantômes jusqu'au
 * remontage de l'écran (bug terrain APK d091b0b5). Référence inchangée si rien à effacer
 * (setState sans re-render inutile côté appelant).
 */
export function reconcileLinkedInvoicesEcho(
  echo: QuoteInvoiceLinksState,
  durable: QuoteInvoiceLinksState,
): QuoteInvoiceLinksState {
  const clearDeposit = echo.hasDepositInvoice && durable.hasDepositInvoice;
  const clearFinal = echo.hasFinalInvoice && durable.hasFinalInvoice;
  if (!clearDeposit && !clearFinal) return echo;
  return {
    hasDepositInvoice: clearDeposit ? false : echo.hasDepositInvoice,
    depositStatus: clearDeposit ? null : echo.depositStatus,
    hasFinalInvoice: clearFinal ? false : echo.hasFinalInvoice,
    finalStatus: clearFinal ? null : echo.finalStatus,
  };
}
