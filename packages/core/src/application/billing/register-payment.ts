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
  afterPaymentRecorded?: (ctx: RegisterPaymentRecordedContext) => Promise<Result<unknown, AppError>>;
}

export interface RegisterPaymentInput {
  invoiceId: string;
  amount: number;
  method: PaymentMethod;
  /** Clé d'idempotence (retry réseau, double-tap) : si déjà vue, on ne ré-encaisse pas. */
  idempotencyKey?: string | null;
}

export interface RegisterPaymentOutput {
  status: string;
  paymentId: string;
}

export interface RegisterPaymentRecordedContext {
  companyId: string;
  invoiceId: string;
  paymentId: string;
  status: string;
}

class TxAppError extends Error {
  constructor(readonly appError: AppError) {
    super('tx-app-error');
  }
}

function normalizeIdempotencyKey(key: string | null | undefined): Result<string | null, AppError> {
  if (key === undefined || key === null) return ok(null);
  const normalized = key.trim();
  if (!/^[A-Za-z0-9:._-]{1,160}$/.test(normalized)) {
    return err(appDomain({ code: 'VALIDATION', field: 'idempotencyKey', message: 'Clé d’idempotence invalide.' }));
  }
  return ok(normalized);
}

function idempotencyReplayMismatch(existing: Payment, input: RegisterPaymentInput): boolean {
  return existing.amount !== input.amount || existing.method !== input.method;
}

function idempotencyReplayMismatchError(): AppError {
  return appDomain({
    code: 'VALIDATION',
    field: 'idempotencyKey',
    message: 'Clé déjà utilisée avec des paramètres de paiement différents.',
  });
}

/**
 * Encaisse un paiement et met à jour le statut de la facture, de façon ATOMIQUE, IDEMPOTENTE et
 * SÉRIALISÉE : la facture est relue SOUS VERROU (lockById) dans la transaction, donc deux paiements
 * concurrents ne peuvent plus contourner le garde anti-surpaiement (plus de lost-update sur paidCents).
 */
export class RegisterPayment {
  constructor(private readonly deps: RegisterPaymentDeps) {}

  async execute(input: RegisterPaymentInput): Promise<Result<RegisterPaymentOutput, AppError>> {
    const key = normalizeIdempotencyKey(input.idempotencyKey);
    if (!key.ok) return key;
    const pre = await this.deps.invoices.findById(input.invoiceId);
    if (!pre) return err(appNotFound('invoice', input.invoiceId));

    if (key.value) {
      const existing = await this.deps.payments.findByIdempotencyKey(pre.companyId, key.value);
      if (existing) {
        if (existing.invoiceId !== input.invoiceId)
          return err(appDomain({ code: 'VALIDATION', field: 'idempotencyKey', message: 'Clé déjà utilisée pour une autre facture.' }));
        if (idempotencyReplayMismatch(existing, input)) return err(idempotencyReplayMismatchError());
        return ok({ status: pre.status, paymentId: existing.id }); // déjà traité -> réponse idempotente
      }
    }

    try {
      const output = await this.deps.uow.runInTransaction(async () => {
        const invoice = await this.deps.invoices.lockById(input.invoiceId);
        if (!invoice) throw new TxDomainError({ code: 'VALIDATION', field: 'invoice', message: 'Facture introuvable.' });
        const receivedAt = this.deps.clock.now();
        const registered = invoice.registerPayment(input.amount, receivedAt);
        if (!registered.ok) throw new TxDomainError(registered.error);
        const payment = Payment.record({
          id: this.deps.ids.newId(),
          companyId: invoice.companyId,
          invoiceId: invoice.id,
          amount: input.amount,
          method: input.method,
          receivedAt,
          idempotencyKey: key.value,
        });
        if (!payment.ok) throw new TxDomainError(payment.error);
        await this.deps.payments.save(payment.value);
        await this.deps.invoices.save(invoice);
        if (this.deps.afterPaymentRecorded) {
          const after = await this.deps.afterPaymentRecorded({
            companyId: invoice.companyId,
            invoiceId: invoice.id,
            paymentId: payment.value.id,
            status: invoice.status,
          });
          if (!after.ok) throw new TxAppError(after.error);
        }
        return { status: invoice.status, paymentId: payment.value.id };
      });
      return ok(output);
    } catch (e) {
      if (e instanceof TxDomainError) return err(appDomain(e.domainError));
      if (e instanceof TxAppError) return err(e.appError);
      // Course d'idempotence : une insertion concurrente avec la même clé a gagné (violation d'unicité).
      // On honore le contrat idempotent en renvoyant l'état courant plutôt qu'une erreur 500.
      if (key.value) {
        const existing = await this.deps.payments.findByIdempotencyKey(pre.companyId, key.value);
        if (existing && existing.invoiceId === input.invoiceId) {
          if (idempotencyReplayMismatch(existing, input)) return err(idempotencyReplayMismatchError());
          const current = await this.deps.invoices.findById(input.invoiceId);
          return ok({ status: current?.status ?? pre.status, paymentId: existing.id });
        }
      }
      throw e; // autre erreur d'infrastructure -> propager (transaction annulée)
    }
  }
}
