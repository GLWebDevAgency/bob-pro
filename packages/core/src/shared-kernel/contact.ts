import { type DomainResult, ok, err } from './result';

export class Email {
  private constructor(readonly value: string) {}
  static of(raw: string): DomainResult<Email> {
    const v = raw.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v))
      return err({ code: 'VALIDATION', field: 'email', message: 'Email invalide.' });
    return ok(new Email(v));
  }
}

export interface Address {
  line1: string;
  zip: string;
  city: string;
}
