import { describe, it, expect } from 'vitest';
import { Chantier } from './chantier';

describe('Chantier', () => {
  it('crée et normalise un chantier', () => {
    const r = Chantier.record({ id: 'c1', companyId: 'co', name: '  Villa Durand  ', customerId: null, address: null, status: 'open', openedAt: '2026-06-30' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.name).toBe('Villa Durand');
      expect(r.value.status).toBe('open');
    }
  });

  it('rejette un nom vide', () => {
    expect(
      Chantier.record({ id: 'c1', companyId: 'co', name: '   ', customerId: null, address: null, status: 'open', openedAt: '2026-06-30' }).ok,
    ).toBe(false);
  });
});
