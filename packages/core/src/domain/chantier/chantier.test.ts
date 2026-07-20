import { describe, it, expect } from 'vitest';
import { Chantier } from './chantier';

describe('Chantier', () => {
  it('crée et normalise un chantier', () => {
    const r = Chantier.record({ id: 'c1', companyId: 'co', name: '  Villa Durand  ', customerId: null, address: null, notes: null, status: 'open', openedAt: '2026-06-30' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.name).toBe('Villa Durand');
      expect(r.value.status).toBe('open');
    }
  });

  it('rejette un nom vide', () => {
    expect(
      Chantier.record({ id: 'c1', companyId: 'co', name: '   ', customerId: null, address: null, notes: null, status: 'open', openedAt: '2026-06-30' }).ok,
    ).toBe(false);
  });

  it('normalise une note vide en null et garde une note renseignée', () => {
    const blank = Chantier.record({ id: 'c1', companyId: 'co', name: 'Villa Durand', customerId: null, address: null, notes: '   ', status: 'open', openedAt: '2026-06-30' });
    expect(blank.ok && blank.value.notes).toBe(null);

    const withNotes = Chantier.record({ id: 'c1', companyId: 'co', name: 'Villa Durand', customerId: null, address: null, notes: '  Clé sous le pot de fleurs  ', status: 'open', openedAt: '2026-06-30' });
    expect(withNotes.ok && withNotes.value.notes).toBe('Clé sous le pot de fleurs');
  });

  it('rejette une note trop longue (> 2000 caractères)', () => {
    const tooLong = 'a'.repeat(2001);
    const r = Chantier.record({ id: 'c1', companyId: 'co', name: 'Villa Durand', customerId: null, address: null, notes: tooLong, status: 'open', openedAt: '2026-06-30' });
    expect(r.ok).toBe(false);
  });
});
