import { type DomainResult, ok, err } from './result';

export class Money {
  private constructor(
    readonly cents: number,
    readonly currency: 'EUR',
  ) {}

  static of(cents: number, currency: 'EUR' = 'EUR'): DomainResult<Money> {
    if (!Number.isSafeInteger(cents)) {
      return err({ code: 'VALIDATION', field: 'cents', message: 'Le montant doit être un entier de centimes.' });
    }
    return ok(new Money(cents, currency));
  }

  static zero(currency: 'EUR' = 'EUR'): Money {
    return new Money(0, currency);
  }

  private assertSameCurrency(o: Money): void {
    if (o.currency !== this.currency) throw new Error('Devises incompatibles');
  }

  add(o: Money): Money {
    this.assertSameCurrency(o);
    return new Money(this.cents + o.cents, this.currency);
  }
  sub(o: Money): Money {
    this.assertSameCurrency(o);
    return new Money(this.cents - o.cents, this.currency);
  }
  mulInt(n: number): Money {
    if (!Number.isInteger(n)) throw new Error('mulInt exige un entier');
    return new Money(this.cents * n, this.currency);
  }
  isNegative(): boolean {
    return this.cents < 0;
  }
  equals(o: Money): boolean {
    return this.cents === o.cents && this.currency === o.currency;
  }
}
