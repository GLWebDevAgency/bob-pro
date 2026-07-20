import {
  parisDateOnly,
  type CashMovement,
  type CashMovementProjectionPort,
  type ExpenseRepository,
  type PaymentRepository,
} from '@bob/core';

/**
 * Double déterministe réservé au harness de tests API — miroir FIDÈLE de
 * `PrismaCashMovementProjection` : mêmes sources, même sens, même précision d'horodatage, et la
 * même borne LARGE (`>=`, jour Europe/Paris) qui laisse au use case seul le filtrage qui fait foi.
 */
export class InMemoryCashMovementProjection implements CashMovementProjectionPort {
  constructor(
    private readonly payments: PaymentRepository,
    private readonly expenses: ExpenseRepository,
  ) {}

  async listSinceObservation(input: {
    companyId: string;
    observedAt: string;
  }): Promise<readonly CashMovement[]> {
    const observedDay = parisDateOnly(input.observedAt);
    const [payments, expenses] = await Promise.all([
      this.payments.listByCompany(input.companyId),
      this.expenses.listByCompany(input.companyId),
    ]);

    const movements: CashMovement[] = [];

    for (const payment of payments) {
      if (new Date(payment.receivedAt).getTime() < new Date(input.observedAt).getTime()) continue;
      movements.push({
        id: payment.id,
        companyId: payment.companyId,
        source: 'invoice_payment',
        direction: 'in',
        amountCents: payment.amount,
        occurredAt: { precision: 'instant', value: new Date(payment.receivedAt).toISOString() },
      });
    }

    for (const expense of expenses) {
      const props = expense.toProps();
      // Réglée ET datée : une ligne `paid` sans preuve reste hors trésorerie (cf. adapter Prisma).
      const paidOn = props.paymentEvidence?.paidOn ?? null;
      if (props.status !== 'paid' || paidOn === null || paidOn < observedDay) continue;
      movements.push({
        id: props.id,
        companyId: props.companyId,
        source: 'expense_settlement',
        direction: 'out',
        amountCents: props.totalTtcCents,
        occurredAt: { precision: 'date', value: paidOn },
      });
    }

    return movements;
  }
}
