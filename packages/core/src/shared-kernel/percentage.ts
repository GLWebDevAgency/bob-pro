import { type DomainResult, ok, err } from './result';

export class Percentage {
  private constructor(readonly value: number) {}
  static of(v: number): DomainResult<Percentage> {
    if (!Number.isFinite(v) || v < 0 || v > 100)
      return err({ code: 'VALIDATION', field: 'percentage', message: 'Pourcentage hors bornes (0..100).' });
    return ok(new Percentage(v));
  }
}
