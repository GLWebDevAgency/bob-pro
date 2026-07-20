import { describe, it, expect } from 'vitest';
import {
  cloneDiscount,
  discountAmountCents,
  discountEquals,
  validateDiscount,
  validateLineDiscount,
  type Discount,
} from './discount';

describe('validateDiscount (B3)', () => {
  it('accepte un pourcentage 0 < % ≤ 100 avec 2 décimales max', () => {
    expect(validateDiscount({ type: 'percent', value: 10 }).ok).toBe(true);
    expect(validateDiscount({ type: 'percent', value: 0.01 }).ok).toBe(true);
    expect(validateDiscount({ type: 'percent', value: 100 }).ok).toBe(true);
    expect(validateDiscount({ type: 'percent', value: 33.33 }).ok).toBe(true);
  });
  it.each([0, -5, 100.01, 33.333, Number.NaN, Infinity])('rejette le pourcentage %s', (value) => {
    expect(validateDiscount({ type: 'percent', value }).ok).toBe(false);
  });
  it('accepte un montant en centimes entiers > 0', () => {
    expect(validateDiscount({ type: 'amount', cents: 1 }).ok).toBe(true);
    expect(validateDiscount({ type: 'amount', cents: 50000 }).ok).toBe(true);
  });
  it.each([0, -100, 10.5, Number.NaN])('rejette le montant %s', (cents) => {
    expect(validateDiscount({ type: 'amount', cents }).ok).toBe(false);
  });
  it('rejette un type de remise inconnu (frontière JSON non typée)', () => {
    const r = validateDiscount({ type: 'mystery' } as unknown as Discount);
    expect(r.ok).toBe(false);
  });
});

describe('validateLineDiscount (B3 — plafond par ligne)', () => {
  it('rejette une remise en montant supérieure à la base de SA ligne', () => {
    const r = validateLineDiscount({ type: 'amount', cents: 10001 }, 10000);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.code === 'VALIDATION') expect(r.error.message).toContain('supérieure à la base');
  });
  it('accepte une remise en montant égale à la base (ligne offerte)', () => {
    expect(validateLineDiscount({ type: 'amount', cents: 10000 }, 10000).ok).toBe(true);
  });
  it('B9 — REFUSE toute remise sur une ligne de DÉBOURS (art. 267, II-2° CGI : euro près)', () => {
    const percent = validateLineDiscount({ type: 'percent', value: 10 }, 10000, 'disbursement');
    expect(percent.ok).toBe(false);
    if (!percent.ok && percent.error.code === 'VALIDATION') {
      expect(percent.error.message).toContain('débours');
      expect(percent.error.message).toContain('267');
    }
    expect(validateLineDiscount({ type: 'amount', cents: 1 }, 10000, 'disbursement').ok).toBe(false);
    // Les autres catégories restent remisables.
    expect(validateLineDiscount({ type: 'percent', value: 10 }, 10000, 'labor').ok).toBe(true);
    expect(validateLineDiscount({ type: 'percent', value: 10 }, 10000, 'supply').ok).toBe(true);
  });
});

describe('discountAmountCents (B3 — imputation)', () => {
  it('pourcentage : arrondi commercial half-up', () => {
    expect(discountAmountCents(10000, { type: 'percent', value: 10 })).toBe(1000);
    expect(discountAmountCents(999, { type: 'percent', value: 10 })).toBe(100); // 99,9 → 100
    expect(discountAmountCents(101, { type: 'percent', value: 33.33 })).toBe(34); // 33,66 → 34
  });
  it('montant : imputé tel quel, borné défensivement à la base', () => {
    expect(discountAmountCents(10000, { type: 'amount', cents: 2500 })).toBe(2500);
    expect(discountAmountCents(2000, { type: 'amount', cents: 999999 })).toBe(2000);
  });
  it('sans remise ou base nulle : 0', () => {
    expect(discountAmountCents(10000, null)).toBe(0);
    expect(discountAmountCents(10000, undefined)).toBe(0);
    expect(discountAmountCents(0, { type: 'percent', value: 50 })).toBe(0);
  });
});

describe('cloneDiscount / discountEquals', () => {
  it('clone défensif sans partage de référence', () => {
    const d: Discount = { type: 'amount', cents: 100 };
    const c = cloneDiscount(d);
    expect(c).toEqual(d);
    expect(c).not.toBe(d);
  });
  it('égalité structurelle (idempotence des mutateurs)', () => {
    expect(discountEquals({ type: 'percent', value: 5 }, { type: 'percent', value: 5 })).toBe(true);
    expect(discountEquals({ type: 'percent', value: 5 }, { type: 'amount', cents: 5 })).toBe(false);
    expect(discountEquals(null, null)).toBe(true);
    expect(discountEquals(null, { type: 'amount', cents: 5 })).toBe(false);
  });
});
