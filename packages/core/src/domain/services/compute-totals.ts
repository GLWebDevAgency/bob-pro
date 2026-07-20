import { type LineInput } from '../billing/shared/line-item';
import { type Totals } from '../billing/shared/totals';
import { type VatRate } from '../billing/shared/vat-rate';
import { type Discount, discountAmountCents } from '../billing/shared/discount';

/** Arrondi commercial (half-up) de la TVA pour une base donnee, en centimes. */
export function roundVatForBase(baseCents: number, rate: VatRate): number {
  return Math.round((baseCents * rate) / 100);
}

/**
 * Répartition d'un montant entier sur des poids entiers par la méthode du PLUS FORT RESTE :
 * la somme des parts vaut EXACTEMENT `target` (aucun centime perdu ni inventé), chaque part
 * est bornée par son poids quand target ≤ somme des poids, et les égalités de reste se
 * départagent par l'index (déterminisme total). Politique d'allocation UNIQUE du domaine
 * (remise globale B3, proration des situations B2).
 */
export function allocateByLargestRemainder(weights: readonly number[], target: number): number[] {
  const total = weights.reduce((sum, w) => sum + Math.max(0, w), 0);
  if (total <= 0 || target <= 0) return weights.map(() => 0);
  const raw = weights.map((weight, index) => {
    const exact = (Math.max(0, weight) * target) / total;
    const floor = Math.floor(exact);
    return { index, floor, remainder: exact - floor };
  });
  let remaining = target - raw.reduce((sum, item) => sum + item.floor, 0);
  for (const item of [...raw].sort((a, b) => b.remainder - a.remainder || a.index - b.index)) {
    if (remaining <= 0) break;
    item.floor += 1;
    remaining -= 1;
  }
  return raw.sort((a, b) => a.index - b.index).map((item) => item.floor);
}

/** Décomposition HT d'une pièce : bases nettes PAR LIGNE après remises (B3). */
export interface LineBasesBreakdown {
  /** HT brut (somme des qty × unitPriceHT arrondis), avant toute remise. */
  grossHt: number;
  /** Base HT nette de CHAQUE ligne : remise de ligne puis quote-part de remise globale déduites. */
  netLineBases: number[];
  /** Total des remises réellement imputées (lignes + globale), en centimes. */
  discountCents: number;
}

/**
 * B3/B9 — base HT REMISABLE d'une pièce : HT net des remises de ligne, HORS lignes de DÉBOURS.
 * Un débours (art. 267, II-2° du CGI) est le remboursement À L'EURO PRÈS de sommes avancées au
 * nom et pour le compte du client, justificatifs à l'appui : l'amputer d'une remise ferait
 * diverger la pièce du justificatif (exclusion de base TVA compromise en contrôle) et
 * laisserait le compte de passage 467 non soldé. Assiette du % de remise globale ET plafond
 * des remises globales en montant (Quote/Invoice.setGlobalDiscount, send/issue).
 */
export function discountableNetHtCents(lines: readonly LineInput[]): number {
  return lines.reduce((sum, line) => {
    if (line.category === 'disbursement') return sum;
    const base = Math.round(line.qty * line.unitPriceHT);
    return sum + base - discountAmountCents(base, line.discount);
  }, 0);
}

/**
 * B3 — bases HT nettes par ligne, source unique de l'assiette TVA et de la proration des
 * situations (B2) :
 *  1. base brute de ligne = round(qty × unitPriceHT) ;
 *  2. remise DE LIGNE déduite (bornée à la base — jamais de base négative) ;
 *  3. remise GLOBALE (% du HT REMISABLE, ou montant plafonné par lui) répartie au plus fort
 *     reste ENTRE LES LIGNES REMISABLES UNIQUEMENT — un DÉBOURS (art. 267, II-2° CGI) reste
 *     à l'euro près du justificatif, jamais amputé d'une quote-part. La somme répartie vaut
 *     exactement la remise, et l'assiette de TVA par taux est ensuite calculée sur les bases
 *     NETTES (TVA par taux APRÈS remises, arrondi par taux conservé).
 */
export function computeLineBases(
  lines: readonly LineInput[],
  opts?: { globalDiscount?: Discount | null },
): LineBasesBreakdown {
  const gross = lines.map((l) => Math.round(l.qty * l.unitPriceHT));
  const grossHt = gross.reduce((sum, base) => sum + base, 0);
  const afterLineDiscount = gross.map((base, i) => base - discountAmountCents(base, lines[i]?.discount));
  // B9 — poids de répartition NULS pour les débours : la remise globale ne les touche jamais
  // (assiette ET allocation restreintes aux lignes remisables — fail-closed côté justificatif).
  const discountableWeights = afterLineDiscount.map((base, i) =>
    lines[i]?.category === 'disbursement' ? 0 : base,
  );
  const netDiscountable = discountableWeights.reduce((sum, base) => sum + base, 0);
  const globalCents = discountAmountCents(netDiscountable, opts?.globalDiscount ?? null);
  const allocated = allocateByLargestRemainder(discountableWeights, globalCents);
  const netLineBases = afterLineDiscount.map((base, i) => base - (allocated[i] ?? 0));
  const netHt = netLineBases.reduce((sum, base) => sum + base, 0);
  return { grossHt, netLineBases, discountCents: grossHt - netHt };
}

/**
 * Totaux d'un document. Arrondi TVA par TAUX (somme des bases NETTES d'un meme taux),
 * source unique de la politique d'arrondi (cf. blueprint M10). B3 : l'assiette de chaque taux
 * est prise APRÈS remises (ligne puis globale) — `grossHt`/`discountCents` ne sont présents
 * que lorsqu'une remise existe (les pièces antérieures gardent des totaux identiques au centime).
 */
export function computeTotals(
  lines: LineInput[],
  opts?: { depositPct?: number; globalDiscount?: Discount | null },
): Totals {
  const { grossHt, netLineBases, discountCents } = computeLineBases(
    lines,
    opts?.globalDiscount !== undefined ? { globalDiscount: opts.globalDiscount } : undefined,
  );
  const baseByRate = new Map<VatRate, number>();
  let ht = 0;
  for (const [i, l] of lines.entries()) {
    const base = netLineBases[i] ?? 0;
    ht += base;
    baseByRate.set(l.vatRate, (baseByRate.get(l.vatRate) ?? 0) + base);
  }
  const vatByRate: Record<string, number> = {};
  let vat = 0;
  for (const [rate, base] of baseByRate) {
    const v = roundVatForBase(base, rate);
    vatByRate[String(rate)] = v;
    vat += v;
  }
  const ttc = ht + vat;
  const netToPay = opts?.depositPct ? Math.round((ttc * opts.depositPct) / 100) : ttc;
  return {
    ht,
    vatByRate,
    vat,
    ttc,
    netToPay,
    ...(discountCents > 0 ? { grossHt, discountCents } : {}),
  };
}
