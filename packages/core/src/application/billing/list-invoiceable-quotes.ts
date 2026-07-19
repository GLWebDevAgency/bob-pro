import { type Result, ok } from '../../shared-kernel/result';
import { type AppError } from '../result';
import { type PurchaseOrderRef } from '../../domain/billing/shared/purchase-order-ref';
import {
  type QuoteRepository,
  type InvoiceRepository,
  type CustomerRepository,
} from '../ports/repositories';

/**
 * ASK-2 / B8 — vue « devis facturables » : devis SIGNÉS sans facture finale (non annulée).
 * L'acompte déjà émis est signalé (depositInvoiced) pour que la finale devienne l'évidence,
 * et le bon de commande (numéro d'engagement grands comptes) est exposé pour que le flow
 * facturation l'affiche AVANT émission — il doit figurer sur la facture (Chorus Pro, B8).
 * Use case UNIQUE pour l'écran et pour Bob (parité d'actions humain ↔ voix).
 */
export interface InvoiceableQuoteView {
  id: string;
  number: string | null;
  customerName: string;
  totalTtcCents: number;
  depositPct: number | null;
  depositInvoiced: boolean;
  /** B8 : bon de commande attaché au devis — null si aucun (compat ascendante). */
  purchaseOrder: PurchaseOrderRef | null;
}

export interface ListInvoiceableQuotesInput {
  companyId: string;
}

export interface ListInvoiceableQuotesDeps {
  quotes: Pick<QuoteRepository, 'listByCompany'>;
  invoices: Pick<InvoiceRepository, 'listByCompany'>;
  customers: Pick<CustomerRepository, 'listByCompany'>;
}

export class ListInvoiceableQuotes {
  constructor(private readonly deps: ListInvoiceableQuotesDeps) {}

  async execute(
    input: ListInvoiceableQuotesInput,
  ): Promise<Result<InvoiceableQuoteView[], AppError>> {
    const [quotes, invoices, customers] = await Promise.all([
      this.deps.quotes.listByCompany(input.companyId),
      this.deps.invoices.listByCompany(input.companyId),
      this.deps.customers.listByCompany(input.companyId),
    ]);
    const names = new Map(customers.map((c) => [c.id, c.name]));
    return ok(
      quotes
        .filter((q) => q.status === 'signed')
        .filter(
          (q) =>
            !invoices.some(
              (i) => i.parentQuoteId === q.id && i.kind === 'final' && i.status !== 'cancelled',
            ),
        )
        .map((q) => ({
          id: q.id,
          number: q.number,
          customerName: names.get(q.customerId) ?? '',
          totalTtcCents: q.totals().ttc,
          depositPct: q.depositPct,
          depositInvoiced: invoices.some(
            (i) => i.parentQuoteId === q.id && i.kind === 'deposit' && i.status !== 'cancelled',
          ),
          purchaseOrder: q.purchaseOrder,
        })),
    );
  }
}
