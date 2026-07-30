import { type Trade } from '../../domain/company/company';
import { isVatRate, type VatRate } from '../../domain/billing/shared/vat-rate';
import {
  hasBillingControlCharacter,
  MAX_BILLING_AMOUNT_CENTS,
  type LineCategory,
} from '../../domain/billing/shared/line-item';

/** Catégories facturables exposées par le catalogue propriétaire.
 * PR-14 « Le métier » — `subscription` (forfaits/contrats récurrents : entretien annuel,
 * abonnement de maintenance) rejoint le catalogue : la catégorie existait déjà côté domaine
 * (LineCategory), la chaîne catalogue/UI la propose désormais à la saisie. */
export type CatalogueCategory = Extract<
  LineCategory,
  'labor' | 'supply' | 'travel' | 'subscription'
>;

export const CATALOGUE_CATEGORIES: readonly CatalogueCategory[] = [
  'labor',
  'supply',
  'travel',
  'subscription',
];

export function isCatalogueCategory(value: unknown): value is CatalogueCategory {
  return (CATALOGUE_CATEGORIES as readonly unknown[]).includes(value);
}

/**
 * `metier` reste compris par le contrat de présentation pour une future bibliothèque externe
 * sourcée. `deriveCatalogue` ne produit toutefois que des lignes `perso` appartenant au tenant :
 * aucun tarif de marché codé en dur ne peut se retrouver dans un devis.
 */
export type CatalogueSource = 'metier' | 'perso';

const CUSTOM_PRESTATION_KEYS = [
  'id',
  'label',
  'category',
  'unit',
  'unitPriceHT',
  'vatRate',
] as const;
const CUSTOM_PRESTATION_ID = /^[A-Za-z0-9-]{1,128}$/u;
export const MAX_CUSTOM_PRESTATION_LABEL_LENGTH = 500 as const;
const MAX_CUSTOM_PRESTATION_UNIT_LENGTH = 80;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

export function isCustomPrestationId(value: unknown): value is string {
  return typeof value === 'string' && CUSTOM_PRESTATION_ID.test(value);
}

/** Prestation créée/importée par l'entreprise et persistée par son autorité tenant. */
export interface CustomPrestation {
  readonly id: string;
  readonly label: string;
  readonly category: CatalogueCategory;
  readonly unit: string | null;
  /** Prix unitaire HT en centimes. */
  readonly unitPriceHT: number;
  readonly vatRate: VatRate;
}

/**
 * Frontière canonique pour toute prestation provenant d'un formulaire, d'un cache ou du réseau.
 * `null` signifie rejet ; seuls le trim du libellé et de l'unité sont appliqués sans perte.
 */
export function parseCustomPrestation(value: unknown): CustomPrestation | null {
  if (!isRecord(value) || !hasExactKeys(value, CUSTOM_PRESTATION_KEYS)) return null;

  const id = value['id'];
  const label = value['label'];
  const category = value['category'];
  const unit = value['unit'];
  const unitPriceHT = value['unitPriceHT'];
  const vatRate = value['vatRate'];

  if (!isCustomPrestationId(id)) return null;
  if (typeof label !== 'string') return null;
  const canonicalLabel = label.trim();
  if (
    canonicalLabel.length === 0 ||
    canonicalLabel.length > MAX_CUSTOM_PRESTATION_LABEL_LENGTH ||
    hasBillingControlCharacter(label)
  ) {
    return null;
  }
  if (!isCatalogueCategory(category)) return null;

  let canonicalUnit: string | null = null;
  if (unit !== null) {
    if (typeof unit !== 'string' || hasBillingControlCharacter(unit)) return null;
    canonicalUnit = unit.trim();
    if (canonicalUnit.length === 0 || canonicalUnit.length > MAX_CUSTOM_PRESTATION_UNIT_LENGTH) {
      return null;
    }
  }

  if (
    typeof unitPriceHT !== 'number' ||
    !Number.isSafeInteger(unitPriceHT) ||
    unitPriceHT < 1 ||
    unitPriceHT > MAX_BILLING_AMOUNT_CENTS
  ) {
    return null;
  }
  if (typeof vatRate !== 'number' || !isVatRate(vatRate)) return null;

  return {
    id,
    label: canonicalLabel,
    category,
    unit: canonicalUnit,
    unitPriceHT,
    vatRate,
  };
}

export interface CataloguePrestation extends CustomPrestation {
  readonly source: CatalogueSource;
  /** Une ligne propriétaire n'est jamais un tarif indicatif. */
  readonly indicative: boolean;
}

/**
 * Contrat Unicode partagé avec le générateur SQL M2-A.
 *
 * Les plages Latin sont translittérées selon leur décomposition NFD. Les caractères qui ne se
 * décomposent pas sont listés comme expansions explicites. Les marques combinantes sont retirées
 * avant que la ponctuation restante devienne un séparateur. Le SQL est généré depuis ces trois
 * listes : ajouter une règle ici sans régénérer la migration casse volontairement le build.
 */
export const CATALOGUE_SEARCH_LATIN_RANGES = [
  '00c0-024f',
  '1e00-1eff',
  '2c60-2c7f',
  'a720-a7ff',
  'ab30-ab6f',
] as const;

export const CATALOGUE_SEARCH_IGNORED_MARK_RANGES = [
  '0300-036f',
  '1ab0-1aff',
  '1dc0-1dff',
  '20d0-20ff',
  'fe20-fe2f',
] as const;

export const CATALOGUE_SEARCH_EXPANSIONS = [
  // U+212B se décompose en NFD côté core mais vit hors des plages Latin générées en SQL.
  // L'expansion explicite garde donc PostgreSQL strictement aligné sur `normalize('NFD')`.
  'Å=a',
  'Œ=oe',
  'œ=oe',
  'Æ=ae',
  'æ=ae',
  'ẞ=ss',
  'ß=ss',
  'Þ=th',
  'þ=th',
  'Ð=d',
  'ð=d',
  'Đ=d',
  'đ=d',
  'Ł=l',
  'ł=l',
  'Ø=o',
  'ø=o',
  'Ħ=h',
  'ħ=h',
  'ı=i',
  'Ŋ=n',
  'ŋ=n',
  'Ŧ=t',
  'ŧ=t',
  'Ə=e',
  'ə=e',
] as const;

function parseCatalogueSearchRange(range: string): readonly [number, number] {
  const [startToken, endToken] = range.split('-');
  const start = Number.parseInt(startToken ?? '', 16);
  const end = Number.parseInt(endToken ?? '', 16);
  if (
    !Number.isSafeInteger(start)
    || !Number.isSafeInteger(end)
    || start < 0
    || end < start
    || end > 0x10ffff
  ) {
    throw new Error(`CATALOGUE_SEARCH_RANGE_INVALID:${range}`);
  }
  return [start, end];
}

const CATALOGUE_SEARCH_IGNORED_MARK_BOUNDS =
  CATALOGUE_SEARCH_IGNORED_MARK_RANGES.map(parseCatalogueSearchRange);

function isIgnoredCatalogueSearchMark(character: string): boolean {
  const codePoint = character.codePointAt(0);
  return codePoint !== undefined
    && CATALOGUE_SEARCH_IGNORED_MARK_BOUNDS.some(
      ([start, end]) => codePoint >= start && codePoint <= end,
    );
}

/**
 * Clé de recherche partagée avec l'index PostgreSQL M2-A :
 * minuscules + sans accents (œ → oe) + ponctuation → espaces.
 */
export function normalizeCatalogueSearchKey(input: string): string {
  const expanded = CATALOGUE_SEARCH_EXPANSIONS.reduce((value, encodedRule) => {
    const separator = encodedRule.indexOf('=');
    return value.replaceAll(
      encodedRule.slice(0, separator),
      encodedRule.slice(separator + 1),
    );
  }, input);
  const withoutMarks = [...expanded.normalize('NFD')]
    .filter((character) => !isIgnoredCatalogueSearchMark(character))
    .join('');
  return withoutMarks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface DeriveCatalogueInput {
  /** Conservé pour la compatibilité de vue ; ne sélectionne aucun prix implicite. */
  readonly trade: Trade;
  readonly custom?: readonly CustomPrestation[];
}

export interface CatalogueView {
  readonly trade: Trade;
  readonly prestations: readonly CataloguePrestation[];
}

/**
 * Construit la vue exclusivement depuis les prestations du propriétaire, validées puis triées.
 * Une valeur invalide est exclue ; l'adapter de persistance doit en plus la refuser à l'écriture.
 */
export function deriveCatalogue(input: DeriveCatalogueInput): CatalogueView {
  const prestations = (input.custom ?? [])
    .map((prestation) => parseCustomPrestation(prestation))
    .filter((prestation): prestation is CustomPrestation => prestation !== null)
    .map<CataloguePrestation>((prestation) => ({
      ...prestation,
      source: 'perso',
      indicative: false,
    }));

  const order: Record<CatalogueCategory, number> = { labor: 0, supply: 1, travel: 2, subscription: 3 };
  prestations.sort((left, right) => {
    const categoryOrder = order[left.category] - order[right.category];
    return categoryOrder !== 0 ? categoryOrder : left.label.localeCompare(right.label, 'fr');
  });

  return { trade: input.trade, prestations };
}

/** Recherche au fil de la saisie, insensible à la casse et aux accents. */
export function searchCatalogue(
  prestations: readonly CataloguePrestation[],
  query: string,
): CataloguePrestation[] {
  const normalizedQuery = normalizeCatalogueSearchKey(query);
  if (normalizedQuery === '') return [...prestations];
  return prestations.filter((prestation) =>
    normalizeCatalogueSearchKey(prestation.label).includes(normalizedQuery),
  );
}
