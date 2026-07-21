import { describe, it, expect } from 'vitest';
import { internationalProEmissionGuard, INTERNATIONAL_PRO_EMISSION_BLOCK_MESSAGE } from './international-emission-guard';
import { Customer, type CustomerProps } from '../customer/customer';

const base: CustomerProps = {
  id: 'k1',
  companyId: 'c1',
  type: 'b2b',
  name: 'GmbH Bau',
  address: { line1: 'Hauptstr. 1', zip: '10115', city: 'Berlin' },
};

const customer = (over: Partial<CustomerProps> = {}): Customer => {
  const r = Customer.of({ ...base, ...over });
  if (!r.ok) throw new Error('customer de test invalide');
  return r.value;
};

describe('internationalProEmissionGuard (B6 — fail-closed, pas d’override)', () => {
  it('b2b international → BLOQUÉ avec le message honnête', () => {
    const r = internationalProEmissionGuard(customer({ isInternational: true }));
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.code === 'VALIDATION') {
      expect(r.error.message).toBe(INTERNATIONAL_PRO_EMISSION_BLOCK_MESSAGE);
      expect(r.error.message).toContain('259');
      expect(r.error.message).toContain('262');
      expect(r.error.message).toContain('fiscalement faux');
    }
  });
  it('b2g international → BLOQUÉ (professionnel aussi)', () => {
    expect(internationalProEmissionGuard(customer({ type: 'b2g', isInternational: true })).ok).toBe(false);
  });
  it('b2c international → bloqué tant que pays et régime OSS ne sont pas modélisés', () => {
    expect(internationalProEmissionGuard(customer({ type: 'b2c', isInternational: true })).ok).toBe(false);
  });
  it('b2b français → autorisé', () => {
    expect(internationalProEmissionGuard(customer()).ok).toBe(true);
    expect(internationalProEmissionGuard(customer({ isInternational: false })).ok).toBe(true);
  });
});
