import type { InvoiceKind, VatTreatment } from '../billing/invoice/invoice';
import type { LineCategory } from '../billing/shared/line-item';
import { err, ok, type DomainResult } from '../../shared-kernel/result';

/**
 * BT-23 — cadres autorisés par le CIUS France v1.4.0 (30 juin 2026).
 * Source normative : XP Z12-012 / BR-FR-08, publication FNFE France_RFE v1.4.0.02.
 * B7/S7 signifient « TVA déjà collectée via e-reporting » ; ce ne sont pas des avoirs.
 */
export type FrenchBillingMode =
  | 'B1' | 'S1' | 'M1'
  | 'B2' | 'S2' | 'M2'
  | 'S3'
  | 'B4' | 'S4' | 'M4'
  | 'S5' | 'S6'
  | 'B7' | 'S7'
  | 'B8' | 'S8' | 'M8'
  | 'B9' | 'S9' | 'M9';

/** Fait métier demandé lorsque les lignes ne suffisent pas à qualifier l'opération. */
export type FrenchOperationCategory = 'goods' | 'services' | 'mixed';

const FRENCH_BILLING_MODES = new Set<FrenchBillingMode>([
  'B1', 'S1', 'M1', 'B2', 'S2', 'M2', 'S3', 'B4', 'S4', 'M4', 'S5', 'S6',
  'B7', 'S7', 'B8', 'S8', 'M8', 'B9', 'S9', 'M9',
]);
const FRENCH_OPERATION_CATEGORIES = new Set<FrenchOperationCategory>([
  'goods', 'services', 'mixed',
]);

export function isFrenchBillingMode(value: unknown): value is FrenchBillingMode {
  return typeof value === 'string' && FRENCH_BILLING_MODES.has(value as FrenchBillingMode);
}

export function isFrenchOperationCategory(value: unknown): value is FrenchOperationCategory {
  return typeof value === 'string'
    && FRENCH_OPERATION_CATEGORIES.has(value as FrenchOperationCategory);
}

export interface ResolveFrenchBillingModeInput {
  kind: InvoiceKind;
  vatTreatment: VatTreatment;
  lineCategories: readonly LineCategory[];
  /** Autoritaire : l'accessorité d'un bien ou service ne se déduit pas du type des lignes. */
  operationCategory?: FrenchOperationCategory;
  depositDeductionCents: number;
  situationDeductionCents: number;
}

function inferOperationCategory(
  categories: readonly LineCategory[],
): DomainResult<FrenchOperationCategory> {
  const hasGoods = categories.includes('supply');
  const hasServices = categories.some((category) =>
    category === 'labor' || category === 'travel' || category === 'subscription');

  if (hasGoods && !hasServices) return ok('goods');
  if (hasServices && !hasGoods) return ok('services');

  return err({
    code: 'VALIDATION',
    field: 'operationCategory',
    message:
      hasGoods && hasServices
        ? 'Précise si la facture concerne principalement une prestation, une vente, ou des biens et services indépendants.'
        : 'La nature de l’opération doit être précisée avant émission.',
  });
}

/**
 * Même frontière que le resolver BT-23, exposée aux canaux UI/agent pour savoir s'ils doivent
 * demander le fait métier AVANT de proposer l'émission. Aucun canal ne réimplémente la règle.
 */
export function requiresFrenchOperationCategoryAtIssuance(input: Pick<
  ResolveFrenchBillingModeInput,
  'kind' | 'vatTreatment' | 'lineCategories'
>): boolean {
  if (input.kind === 'credit_note' || input.vatTreatment === 'autoliquidation') return false;
  return !inferOperationCategory(input.lineCategories).ok;
}

/** Résout BT-23 depuis des faits figés, sans libellé, montant dû ou heuristique IA. */
export function resolveFrenchBillingModeAtIssuance(
  input: ResolveFrenchBillingModeInput,
): DomainResult<FrenchBillingMode> {
  if (input.kind === 'credit_note') {
    return err({
      code: 'VALIDATION',
      field: 'frenchBillingMode',
      message: 'Un avoir doit reprendre le cadre de facturation figé de sa facture source.',
    });
  }

  if (input.vatTreatment === 'autoliquidation') return ok('S5');

  const category: DomainResult<FrenchOperationCategory> = input.operationCategory === undefined
    ? inferOperationCategory(input.lineCategories)
    : isFrenchOperationCategory(input.operationCategory)
      ? ok(input.operationCategory)
      : err({
          code: 'VALIDATION',
          field: 'operationCategory',
          message: 'Nature de l’opération invalide.',
        });
  if (!category.ok) return category;

  const prefix = category.value === 'goods'
    ? 'B'
    : category.value === 'services'
      ? 'S'
      : 'M';
  const advanceCents = Math.max(0, input.depositDeductionCents - input.situationDeductionCents);
  const suffix = input.kind === 'final' && advanceCents > 0 ? '4' : '1';
  return ok(`${prefix}${suffix}` as FrenchBillingMode);
}
