/**
 * FormField / DateField — logique PURE (Lot 0). Le masque AAAA-MM-JJ est PUREMENT visuel :
 * littéraux calculés à la main, idempotence prouvée (la frappe et la correction passent par
 * le même chemin).
 */
import { describe, expect, it } from 'vitest';
import {
  FORM_FIELD_MIN_HEIGHT,
  applyDateMask,
  formFieldBorderColor,
} from './form-field.logic';

describe('formFieldBorderColor', () => {
  const palette = { cardBorder: '#EAEEF3', danger: '#C8463C' };

  it('au repos → bord de carte ; en erreur → danger', () => {
    expect(formFieldBorderColor(false, palette)).toBe('#EAEEF3');
    expect(formFieldBorderColor(true, palette)).toBe('#C8463C');
  });

  it('cible tactile de l’input ≥ 44 (littéral des champs d’equipements)', () => {
    expect(FORM_FIELD_MIN_HEIGHT).toBe(44);
  });
});

describe('applyDateMask — masque AAAA-MM-JJ purement visuel', () => {
  it('insère les tirets pendant la frappe : 4 puis 6 chiffres', () => {
    // À la main : '2026' → 4 chiffres, aucun tiret ; '202608' → '2026' + '-' + '08' ;
    // '20260802' → '2026' + '-' + '08' + '-' + '02'.
    expect(applyDateMask('2026')).toBe('2026');
    expect(applyDateMask('20260')).toBe('2026-0');
    expect(applyDateMask('202608')).toBe('2026-08');
    expect(applyDateMask('2026080')).toBe('2026-08-0');
    expect(applyDateMask('20260802')).toBe('2026-08-02');
  });

  it('ne garde que les chiffres, plafonnés à 8 (AAAA-MM-JJ complet)', () => {
    // 'a2b0c2d6' → chiffres '2026' ; '2026-08-02-99' → 10 chiffres '2026080299' → 8 gardés.
    expect(applyDateMask('a2b0c2d6')).toBe('2026');
    expect(applyDateMask('2026-08-02-99')).toBe('2026-08-02');
    expect(applyDateMask('')).toBe('');
  });

  it('IDEMPOTENT : masquer une valeur déjà masquée rend la même chaîne', () => {
    for (const raw of ['2026', '2026-0', '2026-08', '2026-08-0', '2026-08-02']) {
      expect(applyDateMask(raw)).toBe(raw);
    }
  });
});
