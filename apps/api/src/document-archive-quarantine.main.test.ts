import { describe, expect, it } from 'vitest';
import {
  archiveQuarantineSourceCompanyId,
  parseArchiveQuarantinePlanConfig,
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
    DOCUMENT_ARCHIVE_QUARANTINE_DESTINATION_BUCKET: 'archive-quarantine',
    DOCUMENT_ARCHIVE_QUARANTINE_AUDIT_REPORT: '/private/report.json',
    DOCUMENT_ARCHIVE_QUARANTINE_AUDIT_REPORT_SHA256: 'b'.repeat(64),
    DOCUMENT_ARCHIVE_QUARANTINE_OUTPUT: '/private/plan.json',
  };
}

describe('CLI plan de quarantaine Archive staging', () => {
  it('est staging-only, read-only et lié à la release', () => {
    expect(parseArchiveQuarantinePlanConfig(validEnvironment())).toMatchObject({
      sourceBucket: 'bob-documents',
      destinationBucket: 'archive-quarantine',
      releaseSha: 'a'.repeat(40),
      maxObjectBytes: 64 * 1024 * 1024,
    });
    expect(() => parseArchiveQuarantinePlanConfig({
      ...validEnvironment(),
      BOB_RELEASE_EXPECTED_ENV: 'production',
    })).toThrow('ARCHIVE_QUARANTINE_STAGING_ONLY');
    expect(() => parseArchiveQuarantinePlanConfig({
      ...validEnvironment(),
      DOCUMENT_ARCHIVE_QUARANTINE_MODE: 'apply',
    })).toThrow('ARCHIVE_QUARANTINE_APPLY_NOT_EXPOSED_WITHOUT_FOUNDER_RECEIPT');
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
      DOCUMENT_ARCHIVE_QUARANTINE_DESTINATION_BUCKET: 'bob-documents',
    })).toThrow('ARCHIVE_QUARANTINE_BUCKET_INVALID');
  });

  it('accepte exactement les deux familles de clés produites par l’audit', () => {
    expect(archiveQuarantineSourceCompanyId(
      'companies/company-a/documents/document-a/v1/original.pdf',
    )).toBe('company-a');
    expect(archiveQuarantineSourceCompanyId(
      'companies/company-b/chantiers/chantier-a/photo.jpg',
    )).toBe('company-b');
    expect(() => archiveQuarantineSourceCompanyId(
      'companies/company-a/other/object.pdf',
    )).toThrow('ARCHIVE_QUARANTINE_SOURCE_KEY_INVALID');
  });
});
