import { describe, expect, it } from 'vitest';
import {
  companyIdFromAppMetadata,
  configuredDemoCompanyId,
  validCompanyId,
} from './tenant-identity';

describe('tenant identity', () => {
  it('lit uniquement le tenant canonique du JWT', () => {
    expect(companyIdFromAppMetadata({ company_id: 'company-user-1' })).toBe('company-user-1');
    expect(companyIdFromAppMetadata({ company_id: '../other-tenant' })).toBeNull();
    expect(companyIdFromAppMetadata({ company_id: '' })).toBeNull();
    expect(companyIdFromAppMetadata(null)).toBeNull();
  });

  it('refuse toute valeur statique implicite ou mal formée', () => {
    expect(configuredDemoCompanyId(undefined)).toBeNull();
    expect(configuredDemoCompanyId('company-mercier')).toBe('company-mercier');
    expect(configuredDemoCompanyId('tenant_with_underscore')).toBeNull();
  });

  it('borne le format exactement comme le contrat API', () => {
    expect(validCompanyId('a'.repeat(64))).toBe(true);
    expect(validCompanyId('a'.repeat(65))).toBe(false);
  });
});
