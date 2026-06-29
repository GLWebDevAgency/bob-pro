import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appDomain, appNotFound } from '../result';
import { Payment, type PaymentMethod } from '../../domain/payment/payment';
import { type InvoiceRepository, type PaymentRepository } from '../ports/repositories';
import { type IdGeneratorPort, type ClockPort } from '../ports/services';

export interface RegisterPaymentDeps {
  invoices: InvoiceRepository;
  payments: PaymentRepository;
  ids: IdGeneratorPort;
  clock: ClockPort;
}

/** Encaisse un paiement et met à jour le statut de la facture (partially_paid | paid). */
export class RegisterPayment {
  constructor(private readonly deps: RegisterPaymentDeps) {}

  async execute(input: { invoiceId: string; amount: number; method: PaymentMethod }): Promise<Result<{ status: string }, AppError>> {
    const invoice = await this.deps.invoices.findById(input.invoiceId);
    if (!invoice) return err(appNotFound('invoice', input.invoiceId));

    const payment = Payment.record({
      id: this.deps.ids.newId(),
      companyId: invoice.companyId,
      invoiceId: invoice.id,
      amount: input.amount,
      method: input.method,
      receivedAt: this.deps.clock.now(),
    });
    if (!payment.ok) return err(appDomain(payment.error));

    const registered = invoice.registerPayment(input.amount, this.deps.clock.now());
    if (!registered.ok) return err(appDomain(registered.error));

    await this.deps.payments.save(payment.value);
    await this.deps.invoices.save(invoice);
    return ok({ status: invoice.status });
  }
}
