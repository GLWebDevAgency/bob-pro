import { describe, expect, it } from 'vitest';
import {
  companyIdFromAppMetadata,
  confirmedTimeZoneFromAppMetadata,
  validCompanyId,
} from './tenant-identity';

describe('tenant identity', () => {
  it('lit uniquement le tenant canonique du JWT', () => {
    expect(companyIdFromAppMetadata({ company_id: 'company-user-1' })).toBe('company-user-1');
    expect(companyIdFromAppMetadata({ company_id: '../other-tenant' })).toBeNull();
    expect(companyIdFromAppMetadata({ company_id: '' })).toBeNull();
    expect(companyIdFromAppMetadata(null)).toBeNull();
  });

  it('borne le format exactement comme le contrat API', () => {
    expect(validCompanyId('a'.repeat(64))).toBe(true);
    expect(validCompanyId('a'.repeat(65))).toBe(false);
  });

  it('ne reconnaît qu’un fuseau confirmé, canonique et lié au même tenant', () => {
    expect(
      confirmedTimeZoneFromAppMetadata({
        company_id: 'company-user-1',
        bob_time_zone: 'Europe/Paris',
        bob_time_zone_confirmed_at: '2026-07-31T00:00:00.000Z',
        bob_time_zone_company_id: 'company-user-1',
      }),
    ).toEqual({
      timeZone: 'Europe/Paris',
      confirmedAt: '2026-07-31T00:00:00.000Z',
    });
    expect(
      confirmedTimeZoneFromAppMetadata({
        company_id: 'company-user-1',
        bob_time_zone: 'Europe/Paris',
        bob_time_zone_confirmed_at: '2026-07-31T00:00:00.000Z',
        bob_time_zone_company_id: 'company-autre',
      }),
    ).toBeNull();
  });
});
