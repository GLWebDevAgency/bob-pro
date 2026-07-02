import { describe, expect, it } from 'vitest';
import { activeSegmentIndex, isSegmentActive } from './segmented-control.logic';

const OPTIONS = [
  { key: '7', label: '7 j' },
  { key: '30', label: '30 j' },
  { key: '60', label: '60 j' },
  { key: '90', label: '90 j' },
] as const;

describe('isSegmentActive', () => {
  it('active le segment dont la clé égale la valeur', () => {
    expect(isSegmentActive('30', '30')).toBe(true);
  });

  it('désactive les autres segments', () => {
    expect(isSegmentActive('7', '30')).toBe(false);
    expect(isSegmentActive('90', '30')).toBe(false);
  });
});

describe('activeSegmentIndex', () => {
  it('retourne l’index du segment sélectionné', () => {
    expect(activeSegmentIndex(OPTIONS, '7')).toBe(0);
    expect(activeSegmentIndex(OPTIONS, '90')).toBe(3);
  });

  it('retourne -1 quand la valeur ne correspond à aucune option', () => {
    expect(activeSegmentIndex(OPTIONS, '365' as (typeof OPTIONS)[number]['key'])).toBe(-1);
  });
});
