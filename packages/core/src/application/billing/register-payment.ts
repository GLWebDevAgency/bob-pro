import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appDomain, appNotFound } from '../result';
import { Payment, type PaymentMethod } from '../../domain/payment/payment';
import { type InvoiceRepository, type PaymentRepository } from '../ports/repositories';
import { type IdGeneratorPort, type ClockPort, type UnitOfWorkPort } from '../ports/services';

export interface RegisterPaymentDeps {
  invoices: InvoiceRepository;
  payments: PaymentRepository;
  uow: UnitOfWorkPort;
  ids: IdGeneratorPort;
  clock: ClockPort;
}

export interface RegisterPaymentInput {
  invoiceId: string;
  amount: number;
  method: PaymentMethod;
  /** Clé d'idempotence (retry réseau, double-tap) : si déjà vue, on ne ré-encaisse pas. */
  idempotencyKey?: string | null;
}

/** Encaisse un paiement et met à jour le statut de la facture, de façon ATOMIQUE et IDEMPOTENTE. */
export class RegisterPayment {
  constructor(private readonly deps: RegisterPaymentDeps) {}

  async execute(input: RegisterPaymentInput): Promise<Result<{ status: string }, AppError>> {
    const invoice = await this.deps.invoices.findById(input.invoiceId);
    if (!invoice) return err(appNotFound('invoice', input.invoiceId));

    if (input.idempotencyKey) {
      const existing = await this.deps.payments.findByIdempotencyKey(invoice.companyId, input.idempotencyKey);
      if (existing) return ok({ status: invoice.status }); // déjà traité -> réponse idempotente, aucun double paiement
    }

    const payment = Payment.record({
      id: this.deps.ids.newId(),
      companyId: invoice.companyId,
      invoiceId: invoice.id,
      amount: input.amount,
      method: input.method,
      receivedAt: this.deps.clock.now(),
      idempotencyKey: input.idempotencyKey ?? null,
    });
    if (!payment.ok) return err(appDomain(payment.error));

    const registered = invoice.registerPayment(input.amount, this.deps.clock.now());
    if (!registered.ok) return err(appDomain(registered.error));

    // Paiement + mise à jour facture dans une seule transaction (jamais l'un sans l'autre).
    await this.deps.uow.runInTransaction(async () => {
      await this.deps.payments.save(payment.value);
      await this.deps.invoices.save(invoice);
    });
    return ok({ status: invoice.status });
  }
}
