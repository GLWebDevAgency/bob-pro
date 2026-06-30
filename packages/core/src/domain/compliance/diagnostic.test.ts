import { describe, it, expect } from 'vitest';
import { runDiagnostic } from './diagnostic';

const base = {
  country: 'FR' as const,
  trade: 'consultant' as const,
  vatRegime: 'reel_normal' as const,
  customerTypes: ['b2c', 'b2b'] as ('b2c' | 'b2b' | 'b2g')[],
  hasDecennale: false,
  asOf: '2026-06-29',
};

describe('runDiagnostic — conformité française', () => {
  it('France : items e-invoicing + calendrier 2026/2027', () => {
    const r = runDiagnostic(base);
    expect(r.supported).toBe(true);
    expect(r.calendar.map((c) => c.date)).toEqual(['2026-09-01', '2027-09-01']);
    expect(r.items.some((i) => i.id === 'einvoice-reception')).toBe(true);
    expect(r.items.some((i) => i.id === 'pa')).toBe(true);
    expect(r.score).toBeGreaterThan(0);
    expect(r.score).toBeLessThanOrEqual(100);
  });

  it('BTP sans décennale : item critique todo, score plus bas', () => {
    const withDec = runDiagnostic({ ...base, trade: 'plombier', vatRegime: 'reel_simpl', customerTypes: ['b2c'], hasDecennale: true });
    const without = runDiagnostic({ ...base, trade: 'plombier', vatRegime: 'reel_simpl', customerTypes: ['b2c'], hasDecennale: false });
    const dec = without.items.find((i) => i.id === 'decennale');
    expect(dec?.status).toBe('todo');
    expect(dec?.severity).toBe('critical');
    expect(without.score).toBeLessThan(withDec.score);
  });

  it('client public : item Chorus Pro présent', () => {
    const r = runDiagnostic({ ...base, customerTypes: ['b2g'] });
    expect(r.items.some((i) => i.id === 'chorus-pro')).toBe(true);
  });

  it('pays non encore couvert : supported false', () => {
    expect(runDiagnostic({ ...base, country: 'BE' }).supported).toBe(false);
  });
});
