import { err, ok, type DomainResult } from '../../shared-kernel/result';

/** Sous-ensemble UN/ECE Recommendation 20 réellement proposé par Bob. */
export type BillingUneceUnitCode =
  | 'C62' // unité / pièce
  | 'HUR' // heure
  | 'DAY' // jour
  | 'MTR' // mètre
  | 'KMT' // kilomètre
  | 'MTK' // mètre carré
  | 'MTQ' // mètre cube
  | 'KGM' // kilogramme
  | 'LTR' // litre
  | 'LS'; // forfait (lump sum)

function canonicalBillingUnit(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase('fr-FR')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[²]/gu, '2')
    .replace(/[³]/gu, '3')
    .replace(/[._]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .replace(/^1\s+/u, '');
}

/**
 * Traduit l'unité humaine conservée dans la pièce vers son code international. Une unité
 * absente signifie « unité de compte » (C62), mais une valeur présente et inconnue est refusée :
 * jamais de remplacement silencieux par « unité » dans le PDF/XML légal.
 */
export function billingUnitToUneceCode(
  unit: string | null | undefined,
): DomainResult<BillingUneceUnitCode> {
  if (unit === null || unit === undefined || unit.trim().length === 0) return ok('C62');
  const canonical = canonicalBillingUnit(unit);
  const mappings: readonly [RegExp, BillingUneceUnitCode][] = [
    [/^(?:u|unite?s?|piece?s?)$/u, 'C62'],
    [/^(?:h|heure?s?|hr?s?)$/u, 'HUR'],
    [/^(?:j|jour?s?)$/u, 'DAY'],
    [/^(?:m|metre?s?)$/u, 'MTR'],
    [/^(?:km|kilometre?s?)$/u, 'KMT'],
    [/^(?:m\s?2|metre?s? carre?s?)$/u, 'MTK'],
    [/^(?:m\s?3|metre?s? cube?s?)$/u, 'MTQ'],
    [/^(?:kg|kilogramme?s?)$/u, 'KGM'],
    [/^(?:l|litre?s?)$/u, 'LTR'],
    [/^(?:forfait|lot)$/u, 'LS'],
  ];
  const matched = mappings.find(([pattern]) => pattern.test(canonical));
  if (matched !== undefined) return ok(matched[1]);
  return err({
    code: 'VALIDATION',
    field: 'unit',
    message:
      `Unité « ${unit.trim()} » non reconnue pour la facture électronique. ` +
      'Choisis unité, pièce, heure, jour, mètre, m², m³, km, kg, litre ou forfait.',
  });
}
