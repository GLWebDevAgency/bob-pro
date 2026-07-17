import { describe, expect, it } from 'vitest';
import {
  displayExpensePaymentDate,
  validateExpensePaymentDate,
} from './expense-payment-form';

describe('validateExpensePaymentDate', () => {
  const today = '2026-07-17';

  it('exige une date choisie explicitement', () => {
    expect(validateExpensePaymentDate('   ', today)).toEqual({ ok: false, error: 'required' });
  });

  it('accepte le format français et retourne la DateOnly canonique', () => {
    expect(validateExpensePaymentDate('16/07/2026', today)).toEqual({
      ok: true,
      value: '2026-07-16',
    });
  });

  it('accepte aussi une DateOnly ISO', () => {
    expect(validateExpensePaymentDate('2026-07-17', today)).toEqual({
      ok: true,
      value: '2026-07-17',
    });
  });

  it('rejette les dates impossibles au lieu de les normaliser', () => {
    expect(validateExpensePaymentDate('31/02/2026', today)).toEqual({
      ok: false,
      error: 'format',
    });
  });

  it('rejette un règlement déclaré dans le futur', () => {
    expect(validateExpensePaymentDate('18/07/2026', today)).toEqual({
      ok: false,
      error: 'future',
    });
  });
});

describe('displayExpensePaymentDate', () => {
  it('affiche la DateOnly sans conversion de fuseau', () => {
    expect(displayExpensePaymentDate('2026-07-17')).toBe('17/07/2026');
  });
});
