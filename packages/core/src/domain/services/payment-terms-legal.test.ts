import { describe, it, expect } from 'vitest';
import {
  validateProPaymentTermsCeiling,
  PRO_PAYMENT_TERMS_MAX_DAYS,
  PRO_PAYMENT_TERMS_END_OF_MONTH_MAX_DAYS,
} from './payment-terms-legal';

describe('validateProPaymentTermsCeiling (B4 — art. L441-10)', () => {
  it('plafonds légaux : 60 jours nets / 45 jours fin de mois', () => {
    expect(PRO_PAYMENT_TERMS_MAX_DAYS).toBe(60);
    expect(PRO_PAYMENT_TERMS_END_OF_MONTH_MAX_DAYS).toBe(45);
  });
  it.each(['b2b', 'b2g'] as const)('%s : 60 j nets accepté, 61 j refusé', (type) => {
    expect(validateProPaymentTermsCeiling(type, { days: 60, endOfMonth: false }).ok).toBe(true);
    const r = validateProPaymentTermsCeiling(type, { days: 61, endOfMonth: false });
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.code === 'VALIDATION') expect(r.error.message).toContain('L441-10');
  });
  it.each(['b2b', 'b2g'] as const)('%s : 45 j fin de mois accepté, 46 j fin de mois refusé', (type) => {
    expect(validateProPaymentTermsCeiling(type, { days: 45, endOfMonth: true }).ok).toBe(true);
    expect(validateProPaymentTermsCeiling(type, { days: 46, endOfMonth: true }).ok).toBe(false);
  });
  it('b2c : hors périmètre L441-10 — jamais bloqué ici', () => {
    expect(validateProPaymentTermsCeiling('b2c', { days: 90, endOfMonth: false }).ok).toBe(true);
    expect(validateProPaymentTermsCeiling('b2c', { days: 60, endOfMonth: true }).ok).toBe(true);
  });
  it('0 jour (à réception / mandat administratif) : accepté', () => {
    expect(validateProPaymentTermsCeiling('b2b', { days: 0, endOfMonth: false }).ok).toBe(true);
  });
});
