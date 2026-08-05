import { describe, expect, it } from 'vitest';
import type { ArchiveQuarantineWorkflowIdentity } from './documents/archive-quarantine';
import {
  assertDistinctArchiveQuarantineApplyAuthority,
  parseOptionalArchiveQuarantineAuditPin,
} from './document-archive-quarantine.runtime';

const RELEASE_SHA = 'a'.repeat(40);

function workflowIdentity(
  overrides: Partial<ArchiveQuarantineWorkflowIdentity> = {},
): ArchiveQuarantineWorkflowIdentity {
  return {
    issuer: 'https://token.actions.githubusercontent.com',
    audience: 'bob-document-archive-quarantine-staging',
    repository: 'GLWebDevAgency/bob-pro',
    ref: 'refs/heads/main',
    sha: RELEASE_SHA,
    environment: 'staging',
    workflowRef:
      'GLWebDevAgency/bob-pro/.github/workflows/document-archive-quarantine-staging.yml@refs/heads/main',
    workflowSha: RELEASE_SHA,
    eventName: 'workflow_dispatch',
    subject: 'repo:GLWebDevAgency/bob-pro:environment:staging',
    repositoryId: '1286748365',
    repositoryOwnerId: '84627817',
    actor: 'GLWebDevAgency',
    actorId: '84627817',
    runId: '123456789',
    runAttempt: 1,
    tokenSha256: '1'.repeat(64),
    ...overrides,
  };
}

describe('autorité OIDC de la quarantaine Archive', () => {
  it('distingue une reprise sans pin d’une configuration partielle ou exacte', () => {
    expect(parseOptionalArchiveQuarantineAuditPin({})).toBeNull();
    expect(() =>
      parseOptionalArchiveQuarantineAuditPin({
        DOCUMENT_ARCHIVE_QUARANTINE_AUDIT_DEPLOYMENT_ID: '11111111-1111-4111-8111-111111111111',
      }),
    ).toThrow('ARCHIVE_QUARANTINE_AUDIT_PIN_PARTIAL');
    expect(
      parseOptionalArchiveQuarantineAuditPin({
        DOCUMENT_ARCHIVE_QUARANTINE_AUDIT_DEPLOYMENT_ID: '11111111-1111-4111-8111-111111111111',
        DOCUMENT_ARCHIVE_QUARANTINE_AUDIT_INVENTORY_DIGEST: 'b'.repeat(64),
        DOCUMENT_ARCHIVE_QUARANTINE_AUDIT_REPORT_SHA256: 'c'.repeat(64),
      }),
    ).toEqual({
      deploymentId: '11111111-1111-4111-8111-111111111111',
      inventoryDigest: 'b'.repeat(64),
      reportSha256: 'c'.repeat(64),
    });
  });

  it('accepte une seconde preuve distincte sous la même autorité stable', () => {
    const planned = workflowIdentity();
    const apply = workflowIdentity({ runId: '123456790', tokenSha256: '2'.repeat(64) });
    expect(() => assertDistinctArchiveQuarantineApplyAuthority(planned, apply)).not.toThrow();
  });

  it('refuse le rejeu du jeton de plan au moment de apply', () => {
    const planned = workflowIdentity();
    expect(() =>
      assertDistinctArchiveQuarantineApplyAuthority(
        planned,
        workflowIdentity({ runId: '123456790' }),
      ),
    ).toThrow('ARCHIVE_QUARANTINE_APPLY_OIDC_PROOF_REPLAYED');
  });

  it('refuse une preuve de plan malformée ou une autorité stable différente', () => {
    expect(() =>
      assertDistinctArchiveQuarantineApplyAuthority(
        { ...workflowIdentity(), tokenSha256: 'not-a-digest' },
        workflowIdentity({ tokenSha256: '2'.repeat(64) }),
      ),
    ).toThrow('ARCHIVE_QUARANTINE_APPLY_AUTHORITY_DIVERGENT');
    expect(() =>
      assertDistinctArchiveQuarantineApplyAuthority(
        { ...workflowIdentity(), repositoryId: '999999999' },
        workflowIdentity({ tokenSha256: '2'.repeat(64) }),
      ),
    ).toThrow('ARCHIVE_QUARANTINE_APPLY_AUTHORITY_DIVERGENT');
  });
});
