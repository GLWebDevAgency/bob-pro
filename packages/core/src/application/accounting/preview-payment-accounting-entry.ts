import { buildPaymentAccountingPreviewLines } from '../../domain/accounting/payment-accounting';
import { type AccountingEntryLineProps } from '../../domain/accounting/accounting-entry';
import { Invoice } from '../../domain/billing/invoice/invoice';
import { type PaymentMethod } from '../../domain/payment/payment';
import { err, ok, type Result } from '../../shared-kernel/result';
import { type AppError, appNotFound } from '../result';
import { type InvoiceRepository } from '../ports/repositories';

const PREVIEW_AT = '1970-01-01T00:00:00.000Z';
const PAYMENT_METHODS = new Set<PaymentMethod>(['card', 'transfer', 'cash']);

export interface PreviewPaymentAccountingEntryInput {
  companyId: string;
  invoiceId: string;
  amountCents: number;
  method: PaymentMethod;
}

export interface PaymentAccountingPreviewOutput {
  invoiceId: string;
  available: boolean;
  reason: string | null;
  reference: string | null;
  amountCents: number;
  remainingCents: number;
  method: PaymentMethod;
  totalDebitCents: number;
  totalCreditCents: number;
  lines: AccountingEntryLineProps[];
}

export interface PreviewPaymentAccountingEntryDeps {
  invoices: InvoiceRepository;
}

function validation(field: string, message: string): AppError {
  return { kind: 'validation', issues: [{ field, message }] };
}

function domainMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
  return "Apercu d'encaissement indisponible.";
}

function unavailable(input: {
  invoiceId: string;
  reason: string;
  reference: string | null;
  amountCents: number;
  remainingCents: number;
  method: PaymentMethod;
}): PaymentAccountingPreviewOutput {
  return {
    invoiceId: input.invoiceId,
    available: false,
    reason: input.reason,
    reference: input.reference,
    amountCents: input.amountCents,
    remainingCents: input.remainingCents,
    method: input.method,
    totalDebitCents: 0,
    totalCreditCents: 0,
    lines: [],
  };
}

export class PreviewPaymentAccountingEntry {
  constructor(private readonly deps: PreviewPaymentAccountingEntryDeps) {}

  async execute(input: PreviewPaymentAccountingEntryInput): Promise<Result<PaymentAccountingPreviewOutput, AppError>> {
    if (!PAYMENT_METHODS.has(input.method)) return err(validation('method', 'Mode de paiement invalide.'));
    if (!Number.isSafeInteger(input.amountCents)) return err(validation('amountCents', 'Montant requis en centimes entiers.'));

    const invoice = await this.deps.invoices.findById(input.invoiceId);
    if (!invoice || invoice.companyId !== input.companyId) return err(appNotFound('invoice', input.invoiceId));

    const totals = invoice.totals();
    const remainingCents = Math.max(0, totals.netToPay - invoice.paid);
    const reference = invoice.number ?? invoice.id;
    const dryRun = Invoice.rehydrate(invoice.toSnapshot()).registerPayment(input.amountCents, PREVIEW_AT);
    if (!dryRun.ok) {
      return ok(
        unavailable({
          invoiceId: invoice.id,
          reason: domainMessage(dryRun.error),
          reference,
          amountCents: input.amountCents,
          remainingCents,
          method: input.method,
        }),
      );
    }

    const lines = buildPaymentAccountingPreviewLines({
      amountCents: input.amountCents,
      method: input.method,
      reference,
    });
    if (!lines.ok) {
      return ok(
        unavailable({
          invoiceId: invoice.id,
          reason: domainMessage(lines.error),
          reference,
          amountCents: input.amountCents,
          remainingCents,
          method: input.method,
        }),
      );
    }

    const totalDebitCents = lines.value.reduce((sum, line) => sum + line.debitCents, 0);
    const totalCreditCents = lines.value.reduce((sum, line) => sum + line.creditCents, 0);
    return ok({
      invoiceId: invoice.id,
      available: true,
      reason: null,
      reference,
      amountCents: input.amountCents,
      remainingCents,
      method: input.method,
      totalDebitCents,
      totalCreditCents,
      lines: lines.value,
    });
  }
}
