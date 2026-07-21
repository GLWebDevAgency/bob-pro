import { describe, expect, it } from 'vitest';
import { validateFrenchVatId } from './french-vat-id';

describe('validateFrenchVatId', () => {
  it('normalise un numéro réellement fourni et cohérent', () => {
    expect(validateFrenchVatId(' fr44 732 829 320 ', '732829320')).toEqual({
      ok: true,
      value: 'FR44732829320',
    });
  });

  it.each([
    ['FR44732829321', '732829320'],
    ['FR24732829320', '732829320'],
    ['FRXX732829320', '732829320'],
    ['FR4473282932', '732829320'],
  ])('refuse incohérence, clé inventée ou format invalide (%s)', (value, siren) => {
    expect(validateFrenchVatId(value, siren).ok).toBe(false);
  });
});
