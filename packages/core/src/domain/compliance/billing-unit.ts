import { err, ok, type DomainResult } from '../../shared-kernel/result';
import {
  resolveBillingUnitReference,
  type StandardBillingUnitReference,
} from '../billing/shared/billing-unit-reference';

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

const UNECE_BY_STANDARD_UNIT: Readonly<
  Record<StandardBillingUnitReference, BillingUneceUnitCode>
> = Object.freeze({
  unité: 'C62',
  pièce: 'C62',
  heure: 'HUR',
  jour: 'DAY',
  mètre: 'MTR',
  kilomètre: 'KMT',
  'm²': 'MTK',
  'm³': 'MTQ',
  kilogramme: 'KGM',
  litre: 'LTR',
  forfait: 'LS',
  lot: 'LS',
});

/**
 * Traduit l'unité humaine conservée dans la pièce vers son code international. Une unité
 * absente signifie « unité de compte » (C62), mais une valeur présente et inconnue est refusée :
 * jamais de remplacement silencieux par « unité » dans le PDF/XML légal.
 */
export function billingUnitToUneceCode(
  unit: string | null | undefined,
): DomainResult<BillingUneceUnitCode> {
  if (unit === null || unit === undefined || unit.trim().length === 0) return ok('C62');
  const resolved = resolveBillingUnitReference(unit);
  if (resolved?.standard !== null && resolved?.standard !== undefined) {
    return ok(UNECE_BY_STANDARD_UNIT[resolved.standard]);
  }
  return err({
    code: 'VALIDATION',
    field: 'unit',
    message:
      `Unité « ${unit.trim()} » non reconnue pour la facture électronique. ` +
      'Choisis unité, pièce, heure, jour, mètre, m², m³, km, kg, litre ou forfait.',
  });
}
