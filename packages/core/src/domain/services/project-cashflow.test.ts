import { describe, it, expect } from 'vitest';
import { projectCashflow } from './project-cashflow';

describe('projectCashflow', () => {
  const base = { bankBalance: 682000, receivables: 300000, charges: 100000, vatDue: 124000 };
  it('prudent applique ~20% de risque sur les encours', () => {
    const real = projectCashflow(base, 'realiste', 30).available;
    const prud = projectCashflow(base, 'prudent', 30).available;
    expect(prud).toBeLessThan(real);
  });
  it('expose un payout positif quand la dispo est saine', () => {
    expect(projectCashflow(base, 'realiste', 30).payout).toBeGreaterThan(0);
  });
  it('expose la TVA a provisionner telle quelle (le KPI briefing lit le MEME chiffre que la dispo)', () => {
    expect(projectCashflow(base, 'realiste', 30).vatDue).toBe(124000);
  });
  it('rend explicites le modèle, le scénario et le taux de recouvrement appliqué', () => {
    expect(projectCashflow(base, 'realiste', 30).basis).toEqual({
      modelVersion: 'cashflow-projection/2',
      kind: 'aggregate_legacy',
      scenario: 'realiste',
      horizonDays: 30,
      receivableCollectionRatePct: 90,
    });
  });
});
