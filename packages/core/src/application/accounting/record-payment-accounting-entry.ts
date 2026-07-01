import { type Result, ok, err } from '../../shared-kernel/result';
import { buildPaymentAccountingEntry } from '../../domain/accounting/payment-accounting';
import { type AppError, appDomain, appNotFound } from '../result';
import { type InvoiceRepository, type PaymentRepository } from '../ports/repositories';
import { type AccountingEntryRepository } from '../ports/accounting-entry-repository';
import { type ChartOfAccountsRepository } from '../ports/chart-of-accounts-repository';

export interface RecordPaymentAccountingEntryInput {
  companyId: string;
  paymentId: string;
}

export interface RecordPaymentAccountingEntryDeps {
  invoices: InvoiceRepository;
  payments: PaymentRepository;
  entries: AccountingEntryRepository;
  charts?: ChartOfAccountsRepository;
}

export interface RecordPaymentAccountingEntryOutput {
  id: string;
  created: boolean;
  totalDebitCents: number;
  totalCreditCents: number;
}

export function paymentAccountingEntryId(paymentId: string): string {
  return `payment:${paymentId}:received`;
}

/**
 * Poste l'ecriture comptable definitive d'un encaissement client.
 *
 * Idempotent : la source comptable est le paiement, donc un replay avec le meme paiement reutilise
 * la meme ecriture deterministe au lieu de doubler le journal de banque.
 */
export class RecordPaymentAccountingEntry {
  constructor(private readonly deps: RecordPaymentAccountingEntryDeps) {}

  async execute(input: RecordPaymentAccountingEntryInput): Promise<Result<RecordPaymentAccountingEntryOutput, AppError>> {
    const payment = await this.deps.payments.findById(input.companyId, input.paymentId);
    if (!payment) return err(appNotFound('payment', input.paymentId));

    const invoice = await this.deps.invoices.findById(payment.invoiceId);
    if (!invoice) return err(appNotFound('invoice', payment.invoiceId));

    const id = paymentAccountingEntryId(payment.id);
    const existing = await this.deps.entries.findById(input.companyId, id);
    if (existing) {
      return ok({
        id,
        created: false,
        totalDebitCents: existing.totalDebitCents,
        totalCreditCents: existing.totalCreditCents,
      });
    }

    const chart = this.deps.charts ? await this.deps.charts.findByCompany(input.companyId) : null;
    const entry = buildPaymentAccountingEntry({
      entryId: id,
      payment,
      invoice,
      ...(chart ? { chart } : {}),
    });
    if (!entry.ok) return err(appDomain(entry.error));

    await this.deps.entries.save(entry.value);
    return ok({
      id,
      created: true,
      totalDebitCents: entry.value.totalDebitCents,
      totalCreditCents: entry.value.totalCreditCents,
    });
  }
}
