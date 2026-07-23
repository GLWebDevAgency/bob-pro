import { err, ok, type DomainResult } from './result';

/**
 * Normalise et valide un numéro de TVA français RÉELLEMENT fourni.
 *
 * Cette fonction ne génère jamais un identifiant depuis le SIREN : elle vérifie
 * uniquement la structure officielle (FR + clé numérique sur 2 chiffres + SIREN)
 * et la clé de contrôle. L'existence/activité VIES reste une vérification externe
 * distincte ; une syntaxe valide n'est donc jamais présentée comme une preuve VIES.
 */
export function validateFrenchVatId(value: string, siren: string): DomainResult<string> {
  if (typeof value !== 'string') {
    return err({ code: 'VALIDATION', field: 'tvaIntracom', message: 'Numéro de TVA intracommunautaire requis.' });
  }
  const normalized = value.toUpperCase().replace(/\s+/g, '');
  const match = /^FR(\d{2})(\d{9})$/.exec(normalized);
  if (match === null) {
    return err({
      code: 'VALIDATION',
      field: 'tvaIntracom',
      message: 'Numéro de TVA français invalide (FR + clé à 2 chiffres + SIREN à 9 chiffres).',
    });
  }
  const key = match[1];
  const vatSiren = match[2];
  if (vatSiren !== siren) {
    return err({ code: 'VALIDATION', field: 'tvaIntracom', message: 'Numéro de TVA incohérent avec le SIREN.' });
  }
  const expectedKey = String((12 + 3 * (Number(siren) % 97)) % 97).padStart(2, '0');
  if (key !== expectedKey) {
    return err({ code: 'VALIDATION', field: 'tvaIntracom', message: 'Clé du numéro de TVA français invalide.' });
  }
  return ok(normalized);
}
