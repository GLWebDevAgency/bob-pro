import { describe, it, expect } from 'vitest';
import { renderWithGuard } from './money-guard';

describe('renderWithGuard (anti-hallucination des montants)', () => {
  it('substitue les placeholders et valide les montants issus du domaine', () => {
    const r = renderWithGuard('Tu peux te verser {{payout}}.', [{ token: 'payout', cents: 200000 }]);
    expect(r.ok).toBe(true);
    expect(r.rendered).toContain('2');
    expect(r.violations).toHaveLength(0);
  });
  it('rejette un montant inventé hors placeholders', () => {
    const r = renderWithGuard('En fait tu me dois 1 234,00 EUR de plus.', []);
    expect(r.ok).toBe(false);
    expect(r.violations.length).toBeGreaterThan(0);
  });
  it('laisse passer un texte sans montant', () => {
    const r = renderWithGuard('Je prépare la relance tout de suite.', []);
    expect(r.ok).toBe(true);
  });
});
