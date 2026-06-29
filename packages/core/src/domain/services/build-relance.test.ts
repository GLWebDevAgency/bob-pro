import { describe, it, expect } from 'vitest';
import { buildRelance } from './build-relance';

describe('buildRelance', () => {
  it('mise en demeure cite L441-10 et 40', () => {
    const m = buildRelance({ customerName: 'M. Bernard', docNumber: 'F-2026-0118', amountCents: 162800, daysLate: 35, tone: 'miseendemeure', personality: 'Pro' });
    expect(m.body).toContain('L441-10');
    expect(m.body).toContain('40');
  });
  it('ton cordial en personnalite Pote tutoie', () => {
    const m = buildRelance({ customerName: 'Martin', docNumber: 'F-1', amountCents: 5000, daysLate: 7, tone: 'cordial', personality: 'Pote' });
    expect(m.body.toLowerCase()).toMatch(/\btu\b|\bton\b|\bta\b|\bte\b/);
  });
});
