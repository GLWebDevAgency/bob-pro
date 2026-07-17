import { buildPaymentAccountingPreviewLines } from '../../domain/accounting/payment-accounting';
import { type AccountingEntryLineProps } from '../../domain/accounting/accounting-entry';
import { Invoice } from '../../domain/billing/invoice/invoice';
import { type PaymentMethod } from '../../domain/payment/payment';
import { err, ok, type Result } from '../../shared-kernel/result';
import { type AppError, appNotFound } from '../result';
import { type InvoiceRepository } from '../ports/repositories';
import { type ClockPort } from '../ports/services';

const PAYMENT_METHODS = new Set<PaymentMethod>(['card', 'transfer', 'cash']);

export interface PreviewPaymentAccountingEntryInput {
  companyId: string;
  invoiceId: string;
  amountCents: number;
  method: PaymentMethod;
}

export type PaymentAccountingPreviewOutput =
  | {
      invoiceId: string;
      available: false;
      reason: string;
    }
  | {
      invoiceId: string;
      available: true;
      reference: string;
      amountCents: number;
      remainingCents: number;
      method: PaymentMethod;
      totalDebitCents: number;
      totalCreditCents: number;
      lines: AccountingEntryLineProps[];
    };

export interface PreviewPaymentAccountingEntryDeps {
  invoices: InvoiceRepository;
  clock: ClockPort;
}

function validation(field: string, message: string): AppError {
  return { kind: 'validation', issues: [{ field, message }] };
}

function domainMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    const detail = error.message.trim();
    if (detail) return detail;
  }
  return "Apercu d'encaissement indisponible.";
}

function unavailable(input: {
  invoiceId: string;
  reason: string;
}): PaymentAccountingPreviewOutput {
  return {
    invoiceId: input.invoiceId,
    available: false,
    reason: input.reason,
  };
}

export class PreviewPaymentAccountingEntry {
  constructor(private readonly deps: PreviewPaymentAccountingEntryDeps) {}

  async execute(input: PreviewPaymentAccountingEntryInput): Promise<Result<PaymentAccountingPreviewOutput, AppError>> {
    if (!PAYMENT_METHODS.has(input.method)) return err(validation('method', 'Mode de paiement invalide.'));
    if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0)
      return err(validation('amountCents', 'Montant strictement positif requis en centimes entiers.'));

    const invoice = await this.deps.invoices.findById(input.invoiceId);
    if (!invoice || invoice.companyId !== input.companyId) return err(appNotFound('invoice', input.invoiceId));

    const totals = invoice.totals();
    const remainingCents = Math.max(0, totals.netToPay - invoice.paid);
    const reference = invoice.number ?? invoice.id;
    const dryRun = Invoice.rehydrate(invoice.toSnapshot()).registerPayment(
      input.amountCents,
      this.deps.clock.now(),
    );
    if (!dryRun.ok) {
      return ok(
        unavailable({
          invoiceId: invoice.id,
          reason: domainMessage(dryRun.error),
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
        }),
      );
    }

    const totalDebitCents = lines.value.reduce((sum, line) => sum + line.debitCents, 0);
    const totalCreditCents = lines.value.reduce((sum, line) => sum + line.creditCents, 0);
    return ok({
      invoiceId: invoice.id,
      available: true,
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
