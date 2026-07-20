import { buildActionDiff, type AccountingLine, type ActionDiff, type PendingAction } from '@bob/ai';

interface InvoicePreviewRecord {
  readonly id: string;
  readonly number: string | null;
  readonly totals: { readonly netToPay: number };
  readonly paid: number;
}

interface QuotePreviewRecord {
  readonly id: string;
  readonly number: string | null;
}

export interface QuerySnapshot<T> {
  readonly data: readonly T[] | undefined;
  readonly isError: boolean;
}

export type PendingPreviewState =
  | { readonly kind: 'ready'; readonly diff: ActionDiff | null }
  | { readonly kind: 'loading' }
  | { readonly kind: 'error' }
  | { readonly kind: 'missing' };

/**
 * Builds a proposal preview only from successfully loaded source records.
 * Financial confirmation is intentionally fail-closed when the record cannot be verified.
 */
export function derivePendingPreview(input: {
  readonly pending: PendingAction;
  readonly invoices: QuerySnapshot<InvoicePreviewRecord>;
  readonly quotes: QuerySnapshot<QuotePreviewRecord>;
  readonly accountingLines?: readonly AccountingLine[];
}): PendingPreviewState {
  const { pending, invoices, quotes, accountingLines } = input;
  const invoiceId = typeof pending.args.invoiceId === 'string' ? pending.args.invoiceId : '';
  const quoteId = typeof pending.args.quoteId === 'string' ? pending.args.quoteId : '';

  if (pending.tool === 'encaisser_facture') {
    if (invoices.isError) return { kind: 'error' };
    if (invoices.data === undefined) return { kind: 'loading' };
    const invoice = invoices.data.find((candidate) => candidate.id === invoiceId);
    if (!invoice) return { kind: 'missing' };
    const remainingCents = Math.max(0, invoice.totals.netToPay - invoice.paid);
    const amountCents =
      typeof pending.args.amountCents === 'number' ? pending.args.amountCents : remainingCents;
    return {
      kind: 'ready',
      diff: buildActionDiff(
        'encaisser_facture',
        { amountCents },
        { number: invoice.number, remainingCents },
      ),
    };
  }

  if (pending.tool === 'emettre_facture') {
    if (invoices.isError) return { kind: 'error' };
    if (invoices.data === undefined) return { kind: 'loading' };
    const invoice = invoices.data.find((candidate) => candidate.id === invoiceId);
    if (!invoice) return { kind: 'missing' };
    return {
      kind: 'ready',
      diff: buildActionDiff(
        'emettre_facture',
        {},
        {
          number: invoice.number,
          ...(accountingLines !== undefined ? { accountingLines } : {}),
        },
      ),
    };
  }

  if (pending.tool === 'envoyer_devis') {
    if (quotes.isError) return { kind: 'error' };
    if (quotes.data === undefined) return { kind: 'loading' };
    const quote = quotes.data.find((candidate) => candidate.id === quoteId);
    if (!quote) return { kind: 'missing' };
    return {
      kind: 'ready',
      diff: buildActionDiff('envoyer_devis', {}, { number: quote.number }),
    };
  }

  return { kind: 'ready', diff: null };
}
