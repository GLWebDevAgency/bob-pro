import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appDomain } from '../result';
import { type ClockPort } from '../ports/services';
import { type VatValidationPort, type VatCheckResult } from '../ports/vat-validation';

/** Normalise un n° TVA intracom (majuscules, sans espaces). */
export function normalizeVatNumber(raw: string): string {
  return raw.replace(/\s/g, '').toUpperCase();
}

export class ValidateVatNumber {
  constructor(private readonly deps: { vat: VatValidationPort; clock: ClockPort }) {}

  async execute(input: { vatNumber: string }): Promise<Result<VatCheckResult, AppError>> {
    const vatNumber = normalizeVatNumber(input.vatNumber);
    if (!/^[A-Z]{2}[A-Z0-9]{2,13}$/.test(vatNumber))
      return err(appDomain({ code: 'VALIDATION', field: 'vatNumber', message: 'N° TVA intracom invalide.' }));
    const outcome = await this.deps.vat.check(vatNumber);
    return ok({ vatNumber, ...outcome, checkedAt: this.deps.clock.today() });
  }
}
