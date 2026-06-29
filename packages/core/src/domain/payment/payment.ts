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
  }): DomainResult<Payment> {
    if (p.amount <= 0) return err({ code: 'VALIDATION', field: 'amount', message: 'Montant > 0 requis.' });
    return ok(new Payment(p.id, p.companyId, p.invoiceId, p.amount, p.method, p.receivedAt));
  }
}
