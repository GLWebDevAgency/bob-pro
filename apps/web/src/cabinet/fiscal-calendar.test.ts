import { describe, expect, it } from 'vitest';
import {
  deriveCabinetFiscalCalendar,
  FISCAL_CALENDAR_DISCLAIMER,
  FiscalCalendarInputError,
} from './fiscal-calendar';
import type { CabinetFiscalProfile } from './types';

function profile(overrides: Partial<CabinetFiscalProfile> = {}): CabinetFiscalProfile {
  return {
    legalForm: 'EURL',
    vatRegime: 'reel_simpl',
    incomeTaxRegime: 'IS',
    fiscalYearEnd: '12-31',
    urssafPeriodicity: null,
    dateCreation: '2024-03-01',
    ...overrides,
  };
}

describe('deriveCabinetFiscalCalendar', () => {
  it('transmet forme juridique, régime TVA et horizon explicite au moteur @bob/core', () => {
    const calendar = deriveCabinetFiscalCalendar({
      fiscal: profile(),
      asOf: '2026-04-01',
      horizonDays: 120,
    });

    expect(calendar.window).toEqual({ from: '2026-04-01', to: '2026-07-30', horizonDays: 120 });
    expect(calendar.deadlines.some((deadline) => deadline.id === 'tva-ca12-2026')).toBe(true);
    expect(calendar.deadlines.some((deadline) => deadline.id === 'is-liasse-2065-2026-05-05')).toBe(
      true,
    );
    expect(calendar.deadlines.some((deadline) => deadline.kind === 'cfe')).toBe(true);
  });

  it('masque toutes les échéances IS quand le cabinet choisit IR et expose la couverture manquante', () => {
    const calendar = deriveCabinetFiscalCalendar({
      fiscal: profile({ incomeTaxRegime: 'IR' }),
      asOf: '2026-04-01',
      horizonDays: 120,
    });

    expect(calendar.deadlines.some((deadline) => deadline.kind === 'is')).toBe(false);
    expect(calendar.deadlines.some((deadline) => deadline.kind === 'tva')).toBe(true);
    expect(calendar.deadlines.some((deadline) => deadline.kind === 'cfe')).toBe(true);
    expect(calendar.limitations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'ir_not_derived',
          message: expect.stringContaining('2031/2035'),
        }),
      ]),
    );
  });

  it('respecte la borne incluse avec un horizon nul au lieu de prendre le défaut core', () => {
    const calendar = deriveCabinetFiscalCalendar({
      fiscal: profile({
        legalForm: 'micro',
        vatRegime: 'franchise',
        incomeTaxRegime: 'IR',
        urssafPeriodicity: 'monthly',
      }),
      asOf: '2026-02-28',
      horizonDays: 0,
    });

    expect(calendar.window.to).toBe('2026-02-28');
    expect(calendar.deadlines.map((deadline) => deadline.id)).toEqual(['urssaf-2026-02-28']);
  });

  it('signale les dates supposées, les montants absents et conserve le disclaimer', () => {
    const calendar = deriveCabinetFiscalCalendar({
      fiscal: profile({ legalForm: 'SASU', vatRegime: 'reel_normal', fiscalYearEnd: null }),
      asOf: '2026-04-20',
      horizonDays: 30,
    });

    expect(calendar.deadlines.some((deadline) => deadline.confidence === 'assumed')).toBe(true);
    expect(calendar.limitations.map((limitation) => limitation.code)).toEqual(
      expect.arrayContaining(['assumed_dates', 'amounts_unavailable']),
    );
    expect(calendar.deadlines.every((deadline) => deadline.amountHint === null)).toBe(true);
    expect(calendar.disclaimer).toBe(FISCAL_CALENDAR_DISCLAIMER);
    expect(calendar.disclaimer).toContain('à confirmer');
  });

  it('rejette les dates et horizons invalides plutôt que dériver une fenêtre implicite', () => {
    expect(() =>
      deriveCabinetFiscalCalendar({ fiscal: profile(), asOf: '11/07/2026', horizonDays: 90 }),
    ).toThrowError(FiscalCalendarInputError);
    expect(() =>
      deriveCabinetFiscalCalendar({ fiscal: profile(), asOf: '2026-07-11', horizonDays: -1 }),
    ).toThrowError(/compris entre 0 et 1 095/);
    expect(() =>
      deriveCabinetFiscalCalendar({ fiscal: profile(), asOf: '2026-07-11', horizonDays: 90.5 }),
    ).toThrowError(FiscalCalendarInputError);
  });
});
