import { type DomainResult, ok, err } from '../../../shared-kernel/result';
import { type LineCategory } from './line-item';

/**
 * B3 — Remise commerciale (ligne ou globale) d'une pièce de facturation.
 *
 * Deux formes exclusives, toujours EXPLICITES (jamais déduites d'un prix ressaisi) :
 *  • `percent` : pourcentage de la base HT concernée (0 < value ≤ 100, 2 décimales max) ;
 *  • `amount`  : montant HT en centimes entiers (0 < cents), plafonné par la base qu'il remise
 *    — la validation du plafond appartient au point qui CONNAÎT la base (agrégat/use case).
 *
 * La remise est un fait commercial de la pièce : elle est portée par la ligne (LineInput.discount)
 * ou par la pièce (globalDiscount), figée avec les totaux à l'émission (snapshot immuable), et
 * déclenche la mention « rabais, remises, ristournes » (art. L441-9 du code de commerce ;
 * art. 242 nonies A, I-8° de l'annexe II au CGI : réductions de prix acquises et chiffrables
 * lors de l'opération et directement liées à elle).
 */
export type Discount =
  | { readonly type: 'percent'; readonly value: number }
  | { readonly type: 'amount'; readonly cents: number };

/** Copie défensive (les snapshots ne partagent jamais de référence mutable). */
export function cloneDiscount(d: Discount): Discount {
  return { ...d };
}

/** Égalité structurelle (idempotence des mutateurs). */
export function discountEquals(a: Discount | null, b: Discount | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.type !== b.type) return false;
  return a.type === 'percent' && b.type === 'percent' ? a.value === b.value : (a as { cents: number }).cents === (b as { cents: number }).cents;
}

/** 2 décimales max (les remises se négocient en pourcentages lisibles, jamais en flottants fous). */
function hasAtMostTwoDecimals(value: number): boolean {
  const scaled = value * 100;
  return Math.abs(scaled - Math.round(scaled)) < 1e-6;
}

/**
 * Validation STRUCTURELLE d'une remise (bornes et types). Le plafond « montant ≤ base remisée »
 * est validé là où la base est connue (Quote/Invoice.addLine, setGlobalDiscount, send/issue).
 */
export function validateDiscount(d: Discount, field = 'discount'): DomainResult<Discount> {
  if (d === null || typeof d !== 'object')
    return err({ code: 'VALIDATION', field, message: 'Remise invalide.' });
  if (d.type === 'percent') {
    if (!Number.isFinite(d.value) || d.value <= 0 || d.value > 100 || !hasAtMostTwoDecimals(d.value))
      return err({
        code: 'VALIDATION',
        field,
        message: 'Remise en pourcentage invalide (0 < % ≤ 100, deux décimales max).',
      });
    return ok({ type: 'percent', value: d.value });
  }
  if (d.type === 'amount') {
    if (!Number.isSafeInteger(d.cents) || d.cents <= 0)
      return err({
        code: 'VALIDATION',
        field,
        message: 'Remise en montant invalide (centimes entiers > 0 requis).',
      });
    return ok({ type: 'amount', cents: d.cents });
  }
  return err({ code: 'VALIDATION', field, message: 'Type de remise inconnu.' });
}

/**
 * Validation COMPLÈTE d'une remise DE LIGNE contre la base HT de sa ligne : structure + plafond
 * (une remise en montant ne peut excéder la base qu'elle remise — la ligne ne devient jamais
 * négative) + INTERDICTION sur un DÉBOURS (art. 267, II-2° du CGI : l'exclusion de base TVA
 * exige le remboursement exact des sommes avancées, justificatif à l'appui — un débours remisé
 * ne correspond plus à sa pièce et risque la requalification en recette taxable). Partagée par
 * Quote.addLine/updateLine, Invoice.addLine et la validation frontière (validateLineInputs).
 */
export function validateLineDiscount(
  discount: Discount,
  lineBaseCents: number,
  category?: LineCategory,
): DomainResult<Discount> {
  if (category === 'disbursement')
    return err({
      code: 'VALIDATION',
      field: 'discount',
      message:
        'Un débours se refacture à l’euro près des sommes avancées (art. 267, II-2° du CGI) : ' +
        'aucune remise possible sur cette ligne.',
    });
  const structural = validateDiscount(discount);
  if (!structural.ok) return structural;
  if (discount.type === 'amount' && discount.cents > lineBaseCents)
    return err({
      code: 'VALIDATION',
      field: 'discount',
      message: 'Remise de ligne supérieure à la base HT de la ligne.',
    });
  return structural;
}

/**
 * Montant de remise imputé à une base HT donnée, en centimes — arrondi commercial (half-up),
 * borné DÉFENSIVEMENT à [0, base] : une remise ne rend jamais une base négative (la validation
 * amont rejette déjà un montant supérieur à la base ; la borne protège le calcul pur contre
 * toute donnée legacy — fail-closed côté assiette, jamais une TVA négative fabriquée).
 */
export function discountAmountCents(baseCents: number, d: Discount | null | undefined): number {
  if (!d || baseCents <= 0) return 0;
  const raw = d.type === 'percent' ? Math.round((baseCents * d.value) / 100) : d.cents;
  return Math.min(Math.max(0, raw), baseCents);
}
