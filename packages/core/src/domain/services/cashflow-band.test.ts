import { describe, it, expect } from 'vitest';
import { cashflowBand, type CashflowSeriesPoint } from './cashflow-band';
import { projectCashflow, type Horizon } from './project-cashflow';

function point(horizon: Horizon, available: number, payout: number): CashflowSeriesPoint {
  return {
    horizon,
    projection: {
      available,
      payout,
      vatDue: 0,
      risk: available < 0,
      basis: {
        modelVersion: 'cashflow-projection/2',
        kind: 'aggregate_legacy',
        scenario: 'realiste',
        horizonDays: horizon,
        receivableCollectionRatePct: 90,
      },
    },
  };
}

describe('cashflowBand', () => {
  it('« creux » quand la dispo passe sous zéro à l’horizon regardé', () => {
    const series = [point(7, 120000, 90000), point(30, -50000, 0)];
    expect(cashflowBand(series, 30)).toBe('creux');
  });

  it('« repart » quand un horizon plus court était en creux et que la dispo est repassée au-dessus', () => {
    const series = [point(7, 200000, 150000), point(30, -30000, 0), point(60, 40000, 10000)];
    expect(cashflowBand(series, 60)).toBe('repart');
  });

  it('« tranquille » vs « ça passe » selon le poids de la réserve (payout × 2 ≥ available)', () => {
    const series = [point(7, 100000, 80000), point(30, 100000, 20000), point(60, 100000, 0)];
    expect(cashflowBand(series, 7)).toBe('tranquille'); // réserve faible → marge confortable
    expect(cashflowBand(series, 30)).toBe('passe'); // réserve > moitié de la dispo → serré
    expect(cashflowBand(series, 60)).toBe('passe'); // rien à se verser → serré
  });

  it('horizon absent de la série → null (donnée absente, pas de note inventée)', () => {
    expect(cashflowBand([point(7, 100000, 50000)], 90)).toBeNull();
    expect(cashflowBand([], 30)).toBeNull();
  });

  it('se compose avec projectCashflow (le moteur réel) sans creux sur des comptes sains', () => {
    const base = { bankBalance: 682000, receivables: 300000, charges: 100000, vatDue: 124000 };
    const series = ([7, 30, 60, 90] as const).map((horizon) => ({
      horizon,
      projection: projectCashflow(base, 'realiste', horizon),
    }));
    const band = cashflowBand(series, 30);
    expect(band).not.toBeNull();
    expect(band).not.toBe('creux');
  });
});
