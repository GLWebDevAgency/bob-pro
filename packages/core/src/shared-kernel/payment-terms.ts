import { type DomainResult, ok, err } from './result';
import { type DateOnly, addDays } from './time';

export class PaymentTerms {
  private constructor(
    readonly days: number,
    readonly endOfMonth: boolean,
    readonly label: string,
  ) {}

  static of(p: { days: number; endOfMonth: boolean; label: string }): DomainResult<PaymentTerms> {
    if (!Number.isInteger(p.days) || p.days < 0)
      return err({ code: 'VALIDATION', field: 'paymentTerms.days', message: 'Jours invalides.' });
    if (!p.label.trim())
      return err({ code: 'VALIDATION', field: 'paymentTerms.label', message: 'Libellé requis.' });
    return ok(new PaymentTerms(p.days, p.endOfMonth, p.label));
  }

  /** null si non calculable (ex. days=0 sur un terme spécial type "Mandat administratif"). */
  dueDateFrom(issuedAt: DateOnly): DateOnly | null {
    if (this.days <= 0) return null;
    let due = addDays(issuedAt, this.days);
    if (this.endOfMonth) {
      const d = new Date(`${due}T00:00:00.000Z`);
      const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
      due = last.toISOString().slice(0, 10);
    }
    return due;
  }
}
