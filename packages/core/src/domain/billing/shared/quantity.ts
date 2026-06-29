import { type DomainResult, ok, err } from '../../../shared-kernel/result';

export class Quantity {
  private constructor(readonly value: number) {}
  static of(v: number): DomainResult<Quantity> {
    if (!Number.isFinite(v) || v <= 0)
      return err({ code: 'VALIDATION', field: 'qty', message: 'Quantite > 0 requise.' });
    if (Math.round(v * 1000) !== v * 1000)
      return err({ code: 'VALIDATION', field: 'qty', message: 'Max 3 decimales.' });
    return ok(new Quantity(v));
  }
}
