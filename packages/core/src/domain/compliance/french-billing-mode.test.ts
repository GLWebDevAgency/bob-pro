import { describe, expect, it } from 'vitest';
import {
  isFrenchBillingMode,
  requiresFrenchOperationCategoryAtIssuance,
  resolveFrenchBillingModeAtIssuance,
} from './french-billing-mode';

const base = {
  kind: 'final' as const,
  vatTreatment: 'standard' as const,
  depositDeductionCents: 0,
  situationDeductionCents: 0,
};

describe('resolveFrenchBillingModeAtIssuance — BT-23 France', () => {
  it('suit exactement la liste BR-FR-08 v1.4.0.02 en réception', () => {
    for (const mode of [
      'B1', 'S1', 'M1', 'B2', 'S2', 'M2', 'S3', 'B4', 'S4', 'M4', 'S5', 'S6',
      'B7', 'S7', 'B8', 'S8', 'M8', 'B9', 'S9', 'M9',
    ]) {
      expect(isFrenchBillingMode(mode), mode).toBe(true);
    }
    // M7 n'existe pas dans BR-FR-08 : l'accepter masquerait un flux non conforme.
    expect(isFrenchBillingMode('M7')).toBe(false);
  });
  it('infère uniquement les cas non ambigus', () => {
    expect(resolveFrenchBillingModeAtIssuance({ ...base, lineCategories: ['supply'] })).toEqual({ ok: true, value: 'B1' });
    expect(resolveFrenchBillingModeAtIssuance({ ...base, lineCategories: ['labor', 'travel'] })).toEqual({ ok: true, value: 'S1' });
  });

  it('refuse de décider si biens et services sont accessoires ou indépendants', () => {
    const result = resolveFrenchBillingModeAtIssuance({ ...base, lineCategories: ['supply', 'labor'] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ code: 'VALIDATION', field: 'operationCategory' });
  });

  it('respecte le fait explicite pour une opération avec fournitures intégrées', () => {
    expect(resolveFrenchBillingModeAtIssuance({
      ...base,
      lineCategories: ['supply', 'labor'],
      operationCategory: 'services',
    })).toEqual({ ok: true, value: 'S1' });
    expect(resolveFrenchBillingModeAtIssuance({
      ...base,
      lineCategories: ['supply', 'labor'],
      operationCategory: 'mixed',
    })).toEqual({ ok: true, value: 'M1' });
  });

  it('refuse fail-closed toute catégorie runtime hors du contrat fermé', () => {
    const result = resolveFrenchBillingModeAtIssuance({
      ...base,
      lineCategories: ['supply', 'labor'],
      operationCategory: 'hybrid' as never,
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'VALIDATION',
        field: 'operationCategory',
        message: 'Nature de l’opération invalide.',
      },
    });
  });

  it('utilise le code 4 seulement pour une finale qui reprend un véritable acompte', () => {
    expect(resolveFrenchBillingModeAtIssuance({
      ...base,
      lineCategories: ['labor'],
      depositDeductionCents: 30_000,
    })).toEqual({ ok: true, value: 'S4' });
    expect(resolveFrenchBillingModeAtIssuance({
      ...base,
      lineCategories: ['labor'],
      depositDeductionCents: 30_000,
      situationDeductionCents: 30_000,
    })).toEqual({ ok: true, value: 'S1' });
  });

  it('la sous-traitance autoliquidée est toujours S5', () => {
    expect(resolveFrenchBillingModeAtIssuance({
      ...base,
      vatTreatment: 'autoliquidation',
      lineCategories: ['supply', 'labor'],
    })).toEqual({ ok: true, value: 'S5' });
  });

  it('expose la même nécessité de décision aux interfaces et à Bob', () => {
    expect(requiresFrenchOperationCategoryAtIssuance({
      kind: 'final',
      vatTreatment: 'standard',
      lineCategories: ['supply', 'labor'],
    })).toBe(true);
    expect(requiresFrenchOperationCategoryAtIssuance({
      kind: 'final',
      vatTreatment: 'standard',
      lineCategories: ['labor'],
    })).toBe(false);
    expect(requiresFrenchOperationCategoryAtIssuance({
      kind: 'final',
      vatTreatment: 'autoliquidation',
      lineCategories: ['supply', 'labor'],
    })).toBe(false);
    expect(requiresFrenchOperationCategoryAtIssuance({
      kind: 'credit_note',
      vatTreatment: 'standard',
      lineCategories: ['supply', 'labor'],
    })).toBe(false);
  });
});
