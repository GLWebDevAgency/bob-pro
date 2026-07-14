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
