import { describe, expect, it } from 'vitest';
import { loadCabinetStagingE2EConfig } from './config';

const validEnvironment: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  CABINET_WEB_BASE_URL: 'https://cabinet-staging.test',
  API_BASE_URL: 'https://api-staging.test',
  CABINET_E2E_SUPABASE_URL: 'https://auth-staging.test',
  EXPECTED_RELEASE_SHA: 'a'.repeat(40),
  CABINET_E2E_ADMIN_EMAIL: 'admin@e2e.test',
  CABINET_E2E_COLLABORATOR_EMAIL: 'collaborator@e2e.test',
  CABINET_E2E_PRIMARY_CABINET_ID: '11111111-1111-4111-8111-111111111111',
  CABINET_E2E_FOREIGN_CABINET_ID: '22222222-2222-4222-8222-222222222222',
  CABINET_E2E_MAILOSAUR_SERVER_ID: 'server-1',
  CABINET_E2E_MAILOSAUR_API_KEY: 'mailbox-secret',
};

describe('Cabinet staging E2E configuration', () => {
  it('normalizes a complete HTTPS staging contract', () => {
    expect(loadCabinetStagingE2EConfig(validEnvironment)).toMatchObject({
      webBaseUrl: 'https://cabinet-staging.test',
      apiBaseUrl: 'https://api-staging.test',
      vercelBypassSecret: null,
    });
  });

  it('fails closed on an insecure public origin', () => {
    expect(() => loadCabinetStagingE2EConfig({
      ...validEnvironment,
      CABINET_WEB_BASE_URL: 'http://cabinet-staging.test',
    })).toThrow(/HTTPS origin/);
  });

  it('requires distinct identities and tenants', () => {
    expect(() => loadCabinetStagingE2EConfig({
      ...validEnvironment,
      CABINET_E2E_COLLABORATOR_EMAIL: validEnvironment.CABINET_E2E_ADMIN_EMAIL,
    })).toThrow(/identities must be distinct/);
    expect(() => loadCabinetStagingE2EConfig({
      ...validEnvironment,
      CABINET_E2E_FOREIGN_CABINET_ID: validEnvironment.CABINET_E2E_PRIMARY_CABINET_ID,
    })).toThrow(/tenants must be distinct/);
  });
});
