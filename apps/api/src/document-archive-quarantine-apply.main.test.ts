import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  parseArchiveQuarantineApplyInput,
} from './document-archive-quarantine-apply.main';
import { verifyArchiveQuarantineOidc } from './document-archive-quarantine-oidc';

const RELEASE_SHA = 'a'.repeat(40);
const MANIFEST_DIGEST = 'b'.repeat(64);

function input(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    manifestDigest: MANIFEST_DIGEST,
    confirmation: `QUARANTINE-STAGING:${MANIFEST_DIGEST}`,
    oidcToken: 'x'.repeat(100),
    ...overrides,
  });
}

describe('opérateur apply de quarantaine Archive', () => {
  it('exige la confirmation exacte sans accepter une autorité libre ajoutée', () => {
    expect(parseArchiveQuarantineApplyInput(input())).toMatchObject({
      manifestDigest: MANIFEST_DIGEST,
      confirmation: `QUARANTINE-STAGING:${MANIFEST_DIGEST}`,
    });
    expect(() => parseArchiveQuarantineApplyInput(input({ confirmation: 'yes' }))).toThrow(
      'ARCHIVE_QUARANTINE_APPLY_INPUT_INVALID',
    );
    expect(() => parseArchiveQuarantineApplyInput(input({ founderChannel: 'invented' }))).toThrow(
      'ARCHIVE_QUARANTINE_APPLY_INPUT_INVALID',
    );
    expect(() => parseArchiveQuarantineApplyInput(input({ extra: true }))).toThrow(
      'ARCHIVE_QUARANTINE_APPLY_INPUT_INVALID',
    );
  });

  it('lie le jeton OIDC au workflow main, à staging et au SHA servi', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = 'test-key';
    publicJwk.alg = 'RS256';
    const jwks = createLocalJWKSet({ keys: [publicJwk] });
    const token = await new SignJWT({
      repository: 'GLWebDevAgency/bob-pro',
      repository_id: '1286748365',
      repository_owner_id: '84627817',
      ref: 'refs/heads/main',
      sha: RELEASE_SHA,
      environment: 'staging',
      workflow_sha: RELEASE_SHA,
      workflow_ref:
        'GLWebDevAgency/bob-pro/.github/workflows/document-archive-quarantine-staging.yml@refs/heads/main',
      event_name: 'workflow_dispatch',
      actor: 'founder',
      actor_id: '84627817',
      run_id: '123456789',
      run_attempt: '1',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer('https://token.actions.githubusercontent.com')
      .setAudience('bob-document-archive-quarantine-staging')
      .setSubject('repo:GLWebDevAgency/bob-pro:environment:staging')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    await expect(verifyArchiveQuarantineOidc({
      token,
      releaseSha: RELEASE_SHA,
      jwks,
    })).resolves.toMatchObject({
      repository: 'GLWebDevAgency/bob-pro',
      sha: RELEASE_SHA,
      environment: 'staging',
      subject: 'repo:GLWebDevAgency/bob-pro:environment:staging',
      repositoryId: '1286748365',
      repositoryOwnerId: '84627817',
      actorId: '84627817',
      runId: '123456789',
      runAttempt: 1,
    });
    await expect(verifyArchiveQuarantineOidc({
      token,
      releaseSha: 'c'.repeat(40),
      jwks,
    })).rejects.toThrow('ARCHIVE_QUARANTINE_OIDC_CLAIMS_INVALID');

    const wrongActorToken = await new SignJWT({
      repository: 'GLWebDevAgency/bob-pro',
      repository_id: '1286748365',
      repository_owner_id: '84627817',
      ref: 'refs/heads/main',
      sha: RELEASE_SHA,
      environment: 'staging',
      workflow_sha: RELEASE_SHA,
      workflow_ref:
        'GLWebDevAgency/bob-pro/.github/workflows/document-archive-quarantine-staging.yml@refs/heads/main',
      event_name: 'workflow_dispatch',
      actor: 'other-writer',
      actor_id: '99999999',
      run_id: '123456790',
      run_attempt: '1',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer('https://token.actions.githubusercontent.com')
      .setAudience('bob-document-archive-quarantine-staging')
      .setSubject('repo:GLWebDevAgency/bob-pro:environment:staging')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    await expect(verifyArchiveQuarantineOidc({
      token: wrongActorToken,
      releaseSha: RELEASE_SHA,
      jwks,
    })).rejects.toThrow('ARCHIVE_QUARANTINE_OIDC_CLAIMS_INVALID');
  });
});
