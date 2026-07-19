/**
 * B2 — Situations de travaux : logique PURE de la feuille « Facturer une situation »
 * (devis signé). Les situations se stipulent en HT (la TVA en découle par taux, côté
 * serveur) ; la garde du CUMUL ≤ marché reste au SERVEUR (GenerateInvoiceFromQuote) —
 * l'écran n'affiche que la réalité déjà facturée et se borne à proposer un pourcentage
 * ATTEIGNABLE (jamais un 422 fabriqué à l'avance quand le max est choisi).
 */
import {
  allocateByLargestRemainder,
  computeLineBases,
  type InvoiceKind,
  type InvoiceStatus,
  type QuoteLine,
  type Totals,
} from '@bob/core';

/** Projection minimale d'une facture liée au devis (InvoiceView suffit structurellement). */
export interface SituationSiblingInvoice {
  readonly kind: InvoiceKind;
  readonly status: InvoiceStatus;
  readonly totals: Pick<Totals, 'ht'>;
}

export interface SituationBasis {
  /** Marché HT NET du devis signé (après remises B3) — l'assiette des situations. */
  readonly marketHtCents: number;
  /** HT déjà facturé (acompte + situations non annulées, brouillons inclus : ils comptent
   *  dans le cumul serveur dès leur création). */
  readonly invoicedHtCents: number;
  /** % entier déjà facturé (arrondi commercial), borné 0..100. */
  readonly invoicedPct: number;
  readonly remainingHtCents: number;
  /** % maximal proposable SANS dépasser le reste (arrondi serveur pris en compte). */
  readonly maxPercent: number;
  /** false = plus rien à facturer en situation (marché couvert). */
  readonly canInvoice: boolean;
}

/** Montant HT d'une situation à {pct} % — MÊME arrondi commercial que le serveur. */
export function situationAmountFromPercent(marketHtCents: number, pct: number): number {
  return Math.round((marketHtCents * pct) / 100);
}

/** Le plus grand % entier dont le montant ARRONDI tient dans le reste facturable. */
export function maxSituationPercent(marketHtCents: number, remainingHtCents: number): number {
  if (marketHtCents <= 0 || remainingHtCents <= 0) return 0;
  let pct = Math.min(100, Math.floor((remainingHtCents * 100) / marketHtCents));
  while (pct > 0 && situationAmountFromPercent(marketHtCents, pct) > remainingHtCents) pct -= 1;
  return pct;
}

/**
 * Base RÉELLE de la feuille : marché HT du devis, déjà-facturé (acompte + situations, jamais
 * un avoir ni une pièce annulée), reste et % max atteignable. Une facture FINALE vivante
 * (brouillon ou émise, non annulée) FERME le marché aux situations — même règle que la garde
 * serveur (GenerateInvoiceFromQuote) : l'écran ne propose jamais un % que le serveur refusera.
 */
export function deriveSituationBasis(
  quoteHtCents: number,
  siblings: readonly SituationSiblingInvoice[],
): SituationBasis {
  const market = Math.max(0, quoteHtCents);
  const invoiced = siblings
    .filter(
      (invoice) =>
        invoice.status !== 'cancelled' &&
        (invoice.kind === 'deposit' || invoice.kind === 'situation'),
    )
    .reduce((sum, invoice) => sum + Math.max(0, invoice.totals.ht), 0);
  const hasLivingFinal = siblings.some(
    (invoice) => invoice.kind === 'final' && invoice.status !== 'cancelled',
  );
  const remaining = Math.max(0, market - invoiced);
  const invoicedPct =
    market > 0 ? Math.min(100, Math.max(0, Math.round((invoiced / market) * 100))) : 0;
  const maxPercent = maxSituationPercent(market, remaining);
  return {
    marketHtCents: market,
    invoicedHtCents: invoiced,
    invoicedPct,
    remainingHtCents: remaining,
    maxPercent,
    canInvoice: market > 0 && remaining > 0 && maxPercent > 0 && !hasLivingFinal,
  };
}

/** Pas de réglage du % (steppers premium) : ±5 grossier, ±1 fin — borné [1, maxPercent]. */
export function stepSituationPercent(
  current: number,
  delta: number,
  maxPercent: number,
): number {
  return Math.min(Math.max(1, current + delta), Math.max(1, maxPercent));
}

/** Proposition d'ouverture HONNÊTE : le prochain quart d'avancement atteignable (25/50/75/100),
 *  sinon le max restant — jamais un avancement inventé depuis des données qui n'existent pas. */
export function defaultSituationPercent(basis: SituationBasis): number {
  if (!basis.canInvoice) return 0;
  const quarters = [25, 50, 75, 100];
  for (const quarter of quarters) {
    const step = quarter - basis.invoicedPct;
    if (step >= 5 && step <= basis.maxPercent) return step;
  }
  return Math.min(10, basis.maxPercent) > 0 ? Math.min(10, basis.maxPercent) : basis.maxPercent;
}

/** B2 — un POSTE du devis dans la proposition par tâches : sa quote-part du marché HT net. */
export interface SituationPoste {
  readonly id: string;
  readonly label: string;
  /** Quote-part du poste dans le MARCHÉ HT net — la somme des postes vaut le marché au centime. */
  readonly amountHtCents: number;
}

/**
 * B2 — « proposition par tâches » : les POSTES du devis signé, chacun avec sa quote-part du
 * marché HT NET affiché (basis.marketHtCents). Poids = bases HT nettes de REMISES DE LIGNE
 * (mêmes règles computeLineBases que le serveur), répartis au plus fort reste pour totaliser
 * EXACTEMENT le marché — le % dérivé des postes cochés est donc toujours cohérent avec la
 * frise et les steppers. STRICTEMENT CONSULTATIF (proposeSituationFromChantier, même
 * philosophie) : cocher PROPOSE un %, l'artisan décide toujours du montant final — et le
 * serveur (GenerateInvoiceFromQuote) reste seul juge du cumul.
 */
export function derivePostesFromQuote(
  lines: readonly QuoteLine[],
  marketHtCents: number,
): SituationPoste[] {
  if (marketHtCents <= 0 || lines.length === 0) return [];
  const { netLineBases } = computeLineBases(lines);
  const allocated = allocateByLargestRemainder(netLineBases, marketHtCents);
  return lines
    .map((line, index) => ({
      id: line.id,
      label: line.label,
      amountHtCents: allocated[index] ?? 0,
    }))
    .filter((poste) => poste.amountHtCents > 0);
}

/**
 * % de LA SITUATION proposé par les postes cochés : avancement CUMULÉ de la sélection
 * (arrondi commercial) MOINS le % déjà facturé, borné [0, maxPercent]. 0 = la sélection est
 * déjà couverte par le facturé (l'écran l'explique honnêtement au lieu de forcer 1 %).
 */
export function situationPercentFromPostes(
  basis: SituationBasis,
  postes: readonly SituationPoste[],
  checkedIds: ReadonlySet<string>,
): number {
  if (!basis.canInvoice || basis.marketHtCents <= 0) return 0;
  const doneHtCents = postes
    .filter((poste) => checkedIds.has(poste.id))
    .reduce((sum, poste) => sum + poste.amountHtCents, 0);
  const cumulPct = Math.min(
    100,
    Math.max(0, Math.round((doneHtCents / basis.marketHtCents) * 100)),
  );
  return Math.min(Math.max(0, cumulPct - basis.invoicedPct), basis.maxPercent);
}
