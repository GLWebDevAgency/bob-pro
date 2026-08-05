import { describe, expect, it } from 'vitest';
import {
  archiveQuarantineSourceCompanyId,
  parseArchiveQuarantinePlanConfig,
  parseArchiveQuarantinePlanInput,
} from './document-archive-quarantine.main';

function validEnvironment(): NodeJS.ProcessEnv {
  return {
    DOCUMENT_ARCHIVE_QUARANTINE_MODE: 'plan',
    BOB_RELEASE_EXPECTED_ENV: 'staging',
    BOB_RELEASE_SHA: 'a'.repeat(40),
    DIRECT_URL: 'postgresql://deployer@staging.example.invalid/postgres',
    SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
    DOCUMENT_ARCHIVE_SUPABASE_PROJECT_REF: 'abcdefghijklmnopqrst',
    SUPABASE_SERVICE_ROLE_KEY: 'test-only-secret',
    SUPABASE_STORAGE_BUCKET: 'bob-documents',
    DOCUMENT_ARCHIVE_QUARANTINE_AUDIT_DEPLOYMENT_ID:
      '11111111-1111-4111-8111-111111111111',
    DOCUMENT_ARCHIVE_QUARANTINE_AUDIT_INVENTORY_DIGEST: 'c'.repeat(64),
    DOCUMENT_ARCHIVE_QUARANTINE_AUDIT_REPORT_SHA256: 'b'.repeat(64),
  };
}

describe('CLI plan de quarantaine Archive staging', () => {
  it('exige un jeton OIDC borné et aucun champ d’autorité libre', () => {
    expect(parseArchiveQuarantinePlanInput(JSON.stringify({
      schemaVersion: 1,
      oidcToken: 'x'.repeat(100),
    }))).toMatchObject({ schemaVersion: 1 });
    expect(() => parseArchiveQuarantinePlanInput(JSON.stringify({
      schemaVersion: 1,
      oidcToken: 'x'.repeat(100),
      actor: 'invented',
    }))).toThrow('ARCHIVE_QUARANTINE_PLAN_INPUT_INVALID');
    expect(() => parseArchiveQuarantinePlanInput('{}')).toThrow(
      'ARCHIVE_QUARANTINE_PLAN_INPUT_INVALID',
    );
  });
  it('est staging-only et lié à la release et à une preuve d’audit exacte', () => {
    expect(parseArchiveQuarantinePlanConfig(validEnvironment())).toMatchObject({
      runtime: {
        sourceBucket: 'bob-documents',
        destinationBucket: 'archive-quarantine',
        releaseSha: 'a'.repeat(40),
        maxObjectBytes: 64 * 1024 * 1024,
      },
      audit: {
        deploymentId: '11111111-1111-4111-8111-111111111111',
        inventoryDigest: 'c'.repeat(64),
        reportSha256: 'b'.repeat(64),
      },
    });
    expect(() => parseArchiveQuarantinePlanConfig({
      ...validEnvironment(),
      BOB_RELEASE_EXPECTED_ENV: 'production',
    })).toThrow('ARCHIVE_QUARANTINE_STAGING_ONLY');
    expect(() => parseArchiveQuarantinePlanConfig({
      ...validEnvironment(),
      DOCUMENT_ARCHIVE_QUARANTINE_MODE: 'apply',
    })).toThrow('ARCHIVE_QUARANTINE_PLAN_MODE_REQUIRED');
  });

  it('refuse un rapport, une URL ou un bucket ambigus', () => {
    expect(() => parseArchiveQuarantinePlanConfig({
      ...validEnvironment(),
      DOCUMENT_ARCHIVE_QUARANTINE_AUDIT_REPORT_SHA256: '',
    })).toThrow('ARCHIVE_QUARANTINE_CONFIG_REQUIRED');
    expect(() => parseArchiveQuarantinePlanConfig({
      ...validEnvironment(),
      SUPABASE_URL: 'https://example.com/storage',
    })).toThrow('ARCHIVE_QUARANTINE_SUPABASE_URL_INVALID');
    expect(() => parseArchiveQuarantinePlanConfig({
      ...validEnvironment(),
      SUPABASE_STORAGE_BUCKET: 'archive-quarantine',
    })).toThrow('ARCHIVE_QUARANTINE_BUCKET_INVALID');
  });

  it('accepte uniquement le chemin PDF document scellé par ce lot', () => {
    expect(archiveQuarantineSourceCompanyId(
      'companies/company-a/documents/document-a/v1/original.pdf',
    )).toBe('company-a');
    expect(() => archiveQuarantineSourceCompanyId(
      'companies/company-b/chantiers/chantier-a/photo.jpg',
    )).toThrow('ARCHIVE_QUARANTINE_SOURCE_KEY_INVALID');
    expect(() => archiveQuarantineSourceCompanyId(
      'companies/company-a/other/object.pdf',
    )).toThrow('ARCHIVE_QUARANTINE_SOURCE_KEY_INVALID');
  });
});
