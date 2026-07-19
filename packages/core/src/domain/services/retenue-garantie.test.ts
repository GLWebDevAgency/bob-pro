import { describe, it, expect } from 'vitest';
import {
  addOneYear,
  deriveRetenueGarantieSuivi,
  retenueGarantieCents,
  retenueGarantieMention,
  validateRetenueGarantiePct,
  RETENUE_GARANTIE_MAX_PCT,
} from './retenue-garantie';

describe('validateRetenueGarantiePct (B5 — loi 71-584, plafond 5 %)', () => {
  it('accepte 0 < taux ≤ 5 (2 décimales max)', () => {
    expect(validateRetenueGarantiePct(5).ok).toBe(true);
    expect(validateRetenueGarantiePct(2.5).ok).toBe(true);
    expect(validateRetenueGarantiePct(0.01).ok).toBe(true);
  });
  it.each([0, -1, 5.01, 6, 2.555, Number.NaN])('rejette %s', (pct) => {
    expect(validateRetenueGarantiePct(pct).ok).toBe(false);
  });
  it('le plafond légal est bien 5', () => {
    expect(RETENUE_GARANTIE_MAX_PCT).toBe(5);
  });
});

describe('retenueGarantieCents', () => {
  it('5 % de 162 800 → 8 140 ; arrondi commercial', () => {
    expect(retenueGarantieCents(162800, 5)).toBe(8140);
    expect(retenueGarantieCents(999, 5)).toBe(50); // 49,95 → 50
  });
  it('aucun taux ou base nulle → 0', () => {
    expect(retenueGarantieCents(162800, null)).toBe(0);
    expect(retenueGarantieCents(0, 5)).toBe(0);
  });
});

describe('retenueGarantieMention', () => {
  it('cite la loi 71-584, le taux et le montant retenu', () => {
    const mention = retenueGarantieMention(5, 8140);
    expect(mention).toContain('71-584');
    expect(mention).toContain('5 %');
    expect(mention).toContain('81,40');
    expect(mention).toContain('une année');
  });
});

describe('addOneYear (restitution = réception + 1 an)', () => {
  it('cas nominal', () => {
    expect(addOneYear('2026-07-19')).toBe('2027-07-19');
  });
  it('29 février → 28 février (année non bissextile)', () => {
    expect(addOneYear('2028-02-29')).toBe('2029-02-28');
  });
});

describe('deriveRetenueGarantieSuivi (créance suivie, jamais une pièce fiscale)', () => {
  const pieces = [
    { pieceNumber: 'F-2026-0010', retainedCents: 8140 },
    { pieceNumber: 'F-2026-0014', retainedCents: 4070 },
  ];
  it('sans réception : total constitué, AUCUNE échéance inventée', () => {
    const r = deriveRetenueGarantieSuivi({ pieces, asOf: '2026-08-01' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.retainedCents).toBe(12210);
      expect(r.value.restitutionDueAt).toBeNull();
      expect(r.value.restitutionDue).toBe(false);
    }
  });
  it('réception posée : échéance = réception + 1 an, exigible à échéance atteinte', () => {
    const before = deriveRetenueGarantieSuivi({ pieces, receptionAt: '2026-09-15', asOf: '2027-09-14' });
    if (before.ok) {
      expect(before.value.restitutionDueAt).toBe('2027-09-15');
      expect(before.value.restitutionDue).toBe(false);
    }
    const due = deriveRetenueGarantieSuivi({ pieces, receptionAt: '2026-09-15', asOf: '2027-09-15' });
    if (due.ok) expect(due.value.restitutionDue).toBe(true);
  });
  it('dates ou montants invalides → VALIDATION', () => {
    expect(deriveRetenueGarantieSuivi({ pieces, asOf: 'pas-une-date' }).ok).toBe(false);
    expect(deriveRetenueGarantieSuivi({ pieces, receptionAt: '2026-13-40', asOf: '2026-08-01' }).ok).toBe(false);
    expect(
      deriveRetenueGarantieSuivi({ pieces: [{ pieceNumber: null, retainedCents: -1 }], asOf: '2026-08-01' }).ok,
    ).toBe(false);
  });
});
