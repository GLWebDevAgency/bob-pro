import { type DomainResult, ok, err } from './result';

function luhnValid(num: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let d = num.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export class Siren {
  private constructor(readonly value: string) {}
  static of(raw: string): DomainResult<Siren> {
    const v = raw.replace(/\s/g, '');
    if (!/^\d{9}$/.test(v)) return err({ code: 'VALIDATION', field: 'siren', message: 'SIREN = 9 chiffres.' });
    if (!luhnValid(v)) return err({ code: 'VALIDATION', field: 'siren', message: 'SIREN invalide (Luhn).' });
    return ok(new Siren(v));
  }
}

export class Siret {
  private constructor(readonly value: string) {}
  static of(raw: string): DomainResult<Siret> {
    const v = raw.replace(/\s/g, '');
    if (!/^\d{14}$/.test(v)) return err({ code: 'VALIDATION', field: 'siret', message: 'SIRET = 14 chiffres.' });
    if (!luhnValid(v)) return err({ code: 'VALIDATION', field: 'siret', message: 'SIRET invalide (Luhn).' });
    return ok(new Siret(v));
  }
  siren(): Siren {
    return (Siren.of(this.value.slice(0, 9)) as { ok: true; value: Siren }).value;
  }
}
