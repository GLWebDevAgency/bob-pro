import { type DomainResult, ok, err } from '../../../shared-kernel/result';

export function assertTransition<S extends string>(
  table: Record<S, readonly S[]>,
  from: S,
  to: S,
): DomainResult<void> {
  const allowed = table[from] ?? [];
  if (!allowed.includes(to)) return err({ code: 'INVALID_TRANSITION', from, to });
  return ok(undefined);
}

export type QuoteStatus = 'draft' | 'sent' | 'viewed' | 'signed' | 'refused' | 'expired';
export const QUOTE_TRANSITIONS: Record<QuoteStatus, readonly QuoteStatus[]> = {
  draft: ['sent'],
  sent: ['viewed', 'signed', 'refused', 'expired'],
  viewed: ['signed', 'refused', 'expired'],
  signed: [],
  refused: [],
  expired: [],
};

export type InvoiceStatus = 'draft' | 'issued' | 'partially_paid' | 'paid' | 'late' | 'cancelled';
export const INVOICE_TRANSITIONS: Record<InvoiceStatus, readonly InvoiceStatus[]> = {
  draft: ['issued', 'cancelled'],
  issued: ['partially_paid', 'paid', 'late', 'cancelled'],
  partially_paid: ['paid', 'late', 'cancelled'],
  late: ['partially_paid', 'paid', 'cancelled'],
  paid: [],
  cancelled: [],
};

export type TransmissionStatus = 'issued' | 'transmitted' | 'received' | 'accepted' | 'refused' | 'paid';
export const TRANSMISSION_TRANSITIONS: Record<TransmissionStatus, readonly TransmissionStatus[]> = {
  issued: ['transmitted'],
  transmitted: ['received'],
  received: ['accepted', 'refused'],
  accepted: ['paid'],
  refused: [],
  paid: [],
};
