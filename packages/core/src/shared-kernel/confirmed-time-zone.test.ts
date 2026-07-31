import { describe, expect, it } from 'vitest';
import { deriveConfirmedTimeZone } from './confirmed-time-zone';

const VALID = {
  timeZone: 'Europe/Paris',
  confirmedAt: '2026-07-31T00:00:00.000Z',
  boundCompanyId: 'company-1',
  currentCompanyId: 'company-1',
} as const;

describe('deriveConfirmedTimeZone', () => {
  it('accepte uniquement une confirmation IANA canonique liée au tenant courant', () => {
    expect(deriveConfirmedTimeZone(VALID)).toEqual({
      timeZone: 'Europe/Paris',
      confirmedAt: '2026-07-31T00:00:00.000Z',
    });
  });

  it.each([
    { ...VALID, currentCompanyId: null },
    { ...VALID, boundCompanyId: 'company-2' },
    { ...VALID, boundCompanyId: null },
    { ...VALID, timeZone: 'Europe/Introuvable' },
    { ...VALID, confirmedAt: '2026-07-31' },
    { ...VALID, confirmedAt: 'pas-une-date' },
    { ...VALID, confirmedAt: null },
  ])('refuse une autorité absente, invalide ou cross-tenant : %j', (candidate) => {
    expect(deriveConfirmedTimeZone(candidate)).toBeNull();
  });
});
