import { type InvoiceKind } from '../../domain/billing/invoice/invoice';
import { type InvoiceStatus } from '../../domain/billing/shared/state-machines';
import { type Result, err, ok } from '../../shared-kernel/result';

export interface KnownReceivableInvoice {
  readonly id: string;
  readonly companyId: string;
  readonly kind: InvoiceKind;
  readonly status: InvoiceStatus;
  readonly netToPayCents: number;
  readonly paidCents: number;
}

export interface KnownReceivables {
  /** Créances client nettes réellement émises et non encaissées. */
  readonly receivablesCents: number;
  /** Excédent d'avoirs : dette envers les clients, jamais masquée dans un encours négatif. */
  readonly customerCreditCents: number;
}

export type KnownReceivablesError =
  | { readonly code: 'INVALID_SCOPE' }
  | { readonly code: 'INVALID_INVOICE'; readonly invoiceId: string }
  | { readonly code: 'AGGREGATE_OVERFLOW'; readonly invoiceId: string };

const COLLECTIBLE: ReadonlySet<InvoiceStatus> = new Set(['issued', 'partially_paid', 'late']);

/**
 * Agrège uniquement des pièces persistées du tenant. Les brouillons/annulations ne deviennent
 * jamais de fausses entrées de trésorerie ; un avoir excédentaire devient une dette séparée.
 */
export function deriveKnownReceivables(input: {
  readonly companyId: string;
  readonly invoices: readonly KnownReceivableInvoice[];
}): Result<KnownReceivables, KnownReceivablesError> {
  if (input.companyId.trim() !== input.companyId || input.companyId.length === 0) {
    return err({ code: 'INVALID_SCOPE' });
  }

  let gross = 0;
  let credits = 0;
  for (const invoice of input.invoices) {
    if (invoice.companyId !== input.companyId || !COLLECTIBLE.has(invoice.status)) continue;
    if (
      invoice.id.trim().length === 0 ||
      !Number.isSafeInteger(invoice.netToPayCents) ||
      invoice.netToPayCents < 0 ||
      !Number.isSafeInteger(invoice.paidCents) ||
      invoice.paidCents < 0 ||
      invoice.paidCents > invoice.netToPayCents
    ) {
      return err({ code: 'INVALID_INVOICE', invoiceId: invoice.id });
    }
    const remaining = invoice.netToPayCents - invoice.paidCents;
    const next = (invoice.kind === 'credit_note' ? credits : gross) + remaining;
    if (!Number.isSafeInteger(next)) {
      return err({ code: 'AGGREGATE_OVERFLOW', invoiceId: invoice.id });
    }
    if (invoice.kind === 'credit_note') credits = next;
    else gross = next;
  }

  const net = gross - credits;
  return ok({
    receivablesCents: Math.max(0, net),
    customerCreditCents: Math.max(0, -net),
  });
}
