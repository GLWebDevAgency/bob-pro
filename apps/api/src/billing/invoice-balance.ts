import { type Totals } from '@bob/core';

export interface InvoiceBalanceView {
  totals: Pick<Totals, 'netToPay'>;
  paid: number;
}

export function remainingInvoiceBalanceCents(invoice: InvoiceBalanceView): number {
  return Math.max(0, invoice.totals.netToPay - invoice.paid);
}
