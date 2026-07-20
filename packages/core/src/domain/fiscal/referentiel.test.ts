import { describe, it, expect } from 'vitest';
import {
  FISCAL_TEMPORAL_PARAMETERS,
  KEY_ACRE_DUE_SHARE,
  KEY_MICRO_CEILING_SERVICES,
  KEY_MICRO_CEILING_VENTE,
  KEY_PFU_RATE,
  KEY_VAT_FRANCHISE_BASE_SERVICES,
  KEY_VAT_FRANCHISE_BASE_VENTE,
  KEY_VAT_FRANCHISE_MAJORE_SERVICES,
  KEY_VAT_FRANCHISE_MAJORE_VENTE,
  findOverlaps,
  resolveParameter,
  type TemporalParameter,
} from './referentiel';

describe('resolveParameter — résolution datée, exacte', () => {
  it('micro ceiling vente : 188 700 € avant 2026, 203 100 € à partir du 01/01/2026', () => {
    expect(resolveParameter(KEY_MICRO_CEILING_VENTE, '2025-06-01')).toMatchObject({ value: 188_700, stale: false });
    expect(resolveParameter(KEY_MICRO_CEILING_VENTE, '2026-01-01')).toMatchObject({ value: 203_100, stale: false });
    expect(resolveParameter(KEY_MICRO_CEILING_VENTE, '2026-07-15')).toMatchObject({ value: 203_100, stale: false });
  });

  it('micro ceiling services : 77 700 € avant 2026, 83 600 € à partir du 01/01/2026', () => {
    expect(resolveParameter(KEY_MICRO_CEILING_SERVICES, '2025-12-31')).toMatchObject({ value: 77_700, stale: false });
    expect(resolveParameter(KEY_MICRO_CEILING_SERVICES, '2026-03-01')).toMatchObject({ value: 83_600, stale: false });
  });

  it('franchise TVA 2025-2026 : seuils de base et majorés, ventes et services', () => {
    expect(resolveParameter(KEY_VAT_FRANCHISE_BASE_VENTE, '2026-07-15')).toMatchObject({ value: 85_000 });
    expect(resolveParameter(KEY_VAT_FRANCHISE_MAJORE_VENTE, '2026-07-15')).toMatchObject({ value: 93_500 });
    expect(resolveParameter(KEY_VAT_FRANCHISE_BASE_SERVICES, '2026-07-15')).toMatchObject({ value: 37_500 });
    expect(resolveParameter(KEY_VAT_FRANCHISE_MAJORE_SERVICES, '2026-07-15')).toMatchObject({ value: 41_250 });
  });

  it('PFU : 30 % avant 2026, 31,4 % à partir du 01/01/2026 (LFSS 2026)', () => {
    expect(resolveParameter(KEY_PFU_RATE, '2025-12-31')).toMatchObject({ value: 30, stale: false });
    expect(resolveParameter(KEY_PFU_RATE, '2026-01-01')).toMatchObject({ value: 31.4, stale: false });
  });

  it('ACRE micro : part due 50 % avant le 01/07/2026, 75 % à partir de cette date', () => {
    expect(resolveParameter(KEY_ACRE_DUE_SHARE, '2026-06-30')).toMatchObject({ value: 50, stale: false });
    expect(resolveParameter(KEY_ACRE_DUE_SHARE, '2026-07-01')).toMatchObject({ value: 75, stale: false });
  });
});

describe('resolveParameter — stale (date hors de toute fenêtre connue)', () => {
  it('date avant la plus ancienne fenêtre connue : repli sur la plus ancienne, stale=true', () => {
    // KEY_VAT_FRANCHISE_BASE_VENTE ne connaît rien avant 2025-01-01.
    const r = resolveParameter(KEY_VAT_FRANCHISE_BASE_VENTE, '2020-01-01');
    expect(r.stale).toBe(true);
    expect(r.value).toBe(85_000);
    expect(r.parameter.effectiveFrom).toBe('2025-01-01');
  });

  it('date très future sur une clé sans fin connue : reste EXACTE (dernière valeur, toujours en vigueur)', () => {
    const r = resolveParameter(KEY_PFU_RATE, '2099-01-01');
    expect(r.stale).toBe(false);
    expect(r.value).toBe(31.4);
  });

  it('clé totalement inconnue : erreur explicite (bug d’appel, pas un trou de donnée)', () => {
    expect(() => resolveParameter('clef_inexistante', '2026-07-15')).toThrow(/clé inconnue/);
  });
});

describe('findOverlaps — chevauchements interdits', () => {
  it('le référentiel réel FISCAL_TEMPORAL_PARAMETERS ne contient AUCUN chevauchement', () => {
    expect(findOverlaps(FISCAL_TEMPORAL_PARAMETERS)).toEqual([]);
  });

  it('détecte un chevauchement construit : une fenêtre ouverte suivie d’une autre entrée', () => {
    const overlapping: TemporalParameter[] = [
      { key: 'k', value: 1, effectiveFrom: '2020-01-01', source: { label: 's', url: 'https://x' }, verifiedAt: '2026-07-15' },
      { key: 'k', value: 2, effectiveFrom: '2021-01-01', source: { label: 's', url: 'https://x' }, verifiedAt: '2026-07-15' },
    ];
    expect(findOverlaps(overlapping)).toHaveLength(1);
  });

  it('détecte un chevauchement construit : effectiveTo après le effectiveFrom suivant', () => {
    const overlapping: TemporalParameter[] = [
      {
        key: 'k',
        value: 1,
        effectiveFrom: '2020-01-01',
        effectiveTo: '2022-06-01',
        source: { label: 's', url: 'https://x' },
        verifiedAt: '2026-07-15',
      },
      { key: 'k', value: 2, effectiveFrom: '2022-01-01', source: { label: 's', url: 'https://x' }, verifiedAt: '2026-07-15' },
    ];
    expect(findOverlaps(overlapping)).toHaveLength(1);
  });

  it('des fenêtres adjacentes (effectiveTo === effectiveFrom suivant) ne chevauchent PAS', () => {
    const adjacent: TemporalParameter[] = [
      {
        key: 'k',
        value: 1,
        effectiveFrom: '2020-01-01',
        effectiveTo: '2022-01-01',
        source: { label: 's', url: 'https://x' },
        verifiedAt: '2026-07-15',
      },
      { key: 'k', value: 2, effectiveFrom: '2022-01-01', source: { label: 's', url: 'https://x' }, verifiedAt: '2026-07-15' },
    ];
    expect(findOverlaps(adjacent)).toEqual([]);
  });

  it('des clés différentes ne sont jamais comparées entre elles', () => {
    const distinctKeys: TemporalParameter[] = [
      { key: 'a', value: 1, effectiveFrom: '2020-01-01', source: { label: 's', url: 'https://x' }, verifiedAt: '2026-07-15' },
      { key: 'b', value: 2, effectiveFrom: '2020-01-01', source: { label: 's', url: 'https://x' }, verifiedAt: '2026-07-15' },
    ];
    expect(findOverlaps(distinctKeys)).toEqual([]);
  });
});
