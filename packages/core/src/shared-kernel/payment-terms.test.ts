import { describe, it, expect } from 'vitest';
import { PaymentTerms } from './payment-terms';

describe('PaymentTerms', () => {
  it('calcule une échéance à 30 jours', () => {
    const t = PaymentTerms.of({ days: 30, endOfMonth: false, label: 'Paiement à 30 jours' });
    expect(t.ok).toBe(true);
    if (t.ok) expect(t.value.dueDateFrom('2026-01-10')).toBe('2026-02-09');
  });
  it('retourne null si non calculable (mandat administratif)', () => {
    const t = PaymentTerms.of({ days: 0, endOfMonth: false, label: 'Mandat administratif' });
    if (t.ok) expect(t.value.dueDateFrom('2026-01-10')).toBeNull();
  });
});
