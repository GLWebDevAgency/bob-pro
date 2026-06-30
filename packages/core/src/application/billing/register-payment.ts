import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appDomain, appNotFound } from '../result';
import { Payment, type PaymentMethod } from '../../domain/payment/payment';
import { type InvoiceRepository, type PaymentRepository } from '../ports/repositories';
import { type IdGeneratorPort, type ClockPort, type UnitOfWorkPort } from '../ports/services';
import { TxDomainError } from './tx-error';

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

/**
 * Encaisse un paiement et met à jour le statut de la facture, de façon ATOMIQUE, IDEMPOTENTE et
 * SÉRIALISÉE : la facture est relue SOUS VERROU (lockById) dans la transaction, donc deux paiements
 * concurrents ne peuvent plus contourner le garde anti-surpaiement (plus de lost-update sur paidCents).
 */
export class RegisterPayment {
  constructor(private readonly deps: RegisterPaymentDeps) {}

  async execute(input: RegisterPaymentInput): Promise<Result<{ status: string }, AppError>> {
    const pre = await this.deps.invoices.findById(input.invoiceId);
    if (!pre) return err(appNotFound('invoice', input.invoiceId));

    if (input.idempotencyKey) {
      const existing = await this.deps.payments.findByIdempotencyKey(pre.companyId, input.idempotencyKey);
      if (existing) return ok({ status: pre.status }); // déjà traité -> réponse idempotente
    }

    try {
      const status = await this.deps.uow.runInTransaction(async () => {
        const invoice = await this.deps.invoices.lockById(input.invoiceId);
        if (!invoice) throw new TxDomainError({ code: 'VALIDATION', field: 'invoice', message: 'Facture introuvable.' });
        const registered = invoice.registerPayment(input.amount, this.deps.clock.now());
        if (!registered.ok) throw new TxDomainError(registered.error);
        const payment = Payment.record({
          id: this.deps.ids.newId(),
          companyId: invoice.companyId,
          invoiceId: invoice.id,
          amount: input.amount,
          method: input.method,
          receivedAt: this.deps.clock.now(),
          idempotencyKey: input.idempotencyKey ?? null,
        });
        if (!payment.ok) throw new TxDomainError(payment.error);
        await this.deps.payments.save(payment.value);
        await this.deps.invoices.save(invoice);
        return invoice.status;
      });
      return ok({ status });
    } catch (e) {
      if (e instanceof TxDomainError) return err(appDomain(e.domainError));
      // Course d'idempotence : une insertion concurrente avec la même clé a gagné (violation d'unicité).
      // On honore le contrat idempotent en renvoyant l'état courant plutôt qu'une erreur 500.
      if (input.idempotencyKey) {
        const existing = await this.deps.payments.findByIdempotencyKey(pre.companyId, input.idempotencyKey);
        if (existing) {
          const current = await this.deps.invoices.findById(input.invoiceId);
          return ok({ status: current?.status ?? pre.status });
        }
      }
      throw e; // autre erreur d'infrastructure -> propager (transaction annulée)
    }
  }
}
