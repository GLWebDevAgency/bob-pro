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

/** mod 97 sur les 4 premiers caractères déplacés en fin + lettres → chiffres (ISO 7064). */
function ibanMod97(v: string): number {
  const rearranged = v.slice(4) + v.slice(0, 4);
  let remainder = '';
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    remainder += code >= 65 && code <= 90 ? String(code - 55) : ch;
  }
  let acc = 0;
  for (const digit of remainder) {
    acc = (acc * 10 + (digit.charCodeAt(0) - 48)) % 97;
  }
  return acc;
}

/**
 * IBAN — coordonnées bancaires (RIB, réglages facturation). Format générique ISO 13616
 * (2 lettres pays + 2 chiffres de contrôle + jusqu'à 30 alphanumériques) + clé mod 97 = 1.
 * `value` normalisé SANS espaces (le formatage groupé par 4 est un souci d'affichage,
 * fait au rendu — jamais stocké avec des espaces).
 */
export class Iban {
  private constructor(readonly value: string) {}
  static of(raw: string): DomainResult<Iban> {
    const v = raw.replace(/\s/g, '').toUpperCase();
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(v))
      return err({ code: 'VALIDATION', field: 'iban', message: 'Format IBAN invalide.' });
    if (ibanMod97(v) !== 1)
      return err({ code: 'VALIDATION', field: 'iban', message: 'IBAN invalide (clé de contrôle).' });
    return ok(new Iban(v));
  }
  /** Affichage masqué groupé par 4, ne garde en clair que le pays/clé et les 4 derniers
   * caractères (ex. "FR76 3000 •••• •••• •••• 0123 45") — jamais le RIB complet à l'écran. */
  masked(): string {
    const head = this.value.slice(0, 4);
    const tail = this.value.slice(-4);
    const middleGroups = Math.max(0, Math.ceil((this.value.length - 8) / 4));
    const dots = Array.from({ length: middleGroups }, () => '••••').join(' ');
    return [head, dots, tail].filter(Boolean).join(' ');
  }
}
