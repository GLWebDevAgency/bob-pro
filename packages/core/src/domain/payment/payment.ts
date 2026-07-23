import { AggregateRoot } from '../../shared-kernel/aggregate';
import { type DomainResult, ok, err } from '../../shared-kernel/result';
import { type Instant } from '../../shared-kernel/time';

export type PaymentMethod = 'card' | 'transfer' | 'cash';

export class Payment extends AggregateRoot<string> {
  private constructor(
    id: string,
    readonly companyId: string,
    readonly invoiceId: string,
    readonly amount: number, // centimes
    readonly method: PaymentMethod,
    readonly receivedAt: Instant,
    /** Clé d'idempotence : un même encaissement (retry réseau) ne doit pas créer deux paiements. */
    readonly idempotencyKey: string | null,
    /** Part soldant la créance immédiatement exigible (compte 411). */
    readonly ordinaryReceivableCents: number,
    /** Part soldant une retenue de garantie arrivée à échéance (compte 4117). */
    readonly retentionReceivableCents: number,
  ) {
    super(id);
  }

  static record(p: {
    id: string;
    companyId: string;
    invoiceId: string;
    amount: number;
    method: PaymentMethod;
    receivedAt: Instant;
    idempotencyKey?: string | null;
    ordinaryReceivableCents?: number;
    retentionReceivableCents?: number;
  }): DomainResult<Payment> {
    if (!Number.isSafeInteger(p.amount) || p.amount <= 0)
      return err({ code: 'VALIDATION', field: 'amount', message: 'Montant > 0 requis en centimes entiers.' });
    const ordinary = p.ordinaryReceivableCents ?? p.amount;
    const retention = p.retentionReceivableCents ?? 0;
    if (
      !Number.isSafeInteger(ordinary)
      || ordinary < 0
      || !Number.isSafeInteger(retention)
      || retention < 0
      || ordinary + retention !== p.amount
    )
      return err({
        code: 'VALIDATION',
        field: 'receivableAllocation',
        message: 'La ventilation du paiement entre 411 et 4117 doit égaler son montant.',
      });
    return ok(
      new Payment(
        p.id,
        p.companyId,
        p.invoiceId,
        p.amount,
        p.method,
        p.receivedAt,
        p.idempotencyKey ?? null,
        ordinary,
        retention,
      ),
    );
  }
}
