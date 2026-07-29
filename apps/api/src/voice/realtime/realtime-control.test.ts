import { describe, expect, it, vi } from 'vitest';
import { RealtimeDurableControlAuthority } from './realtime-control';
import { sealRealtimeControl } from './realtime-control-seal';
import type { RealtimeControlRepositoryPort } from './realtime-control.repository';

const SESSION = '11111111-1111-4111-8111-111111111111';
const TURN = '22222222-2222-4222-8222-222222222222';
const ARTIFACT = '33333333-3333-4333-8333-333333333333';
const GRANT = '44444444-4444-4444-8444-444444444444';
const ACK = '55555555-5555-4555-8555-555555555555';
const DIGEST = 'a'.repeat(64);
const SUBJECT = 'b'.repeat(64);
const OWNER = 'c'.repeat(64);
const ENCRYPTION_SECRET = 'encryption-secret-long-enough-00001';
const PROOF_SECRET = 'proof-secret-that-is-long-enough-0001';

function repository(overrides: Partial<RealtimeControlRepositoryPort> = {}) {
  return {
    issue: vi.fn(async () => ({ status: 'issued' as const, grantId: GRANT })),
    readConsumable: vi.fn(async () => ({ status: 'not_found' as const })),
    consume: vi.fn(async () => ({ status: 'not_found' as const })),
    ...overrides,
  } as unknown as RealtimeControlRepositoryPort & {
    issue: ReturnType<typeof vi.fn>;
    readConsumable: ReturnType<typeof vi.fn>;
    consume: ReturnType<typeof vi.fn>;
  };
}

function authority(repo: RealtimeControlRepositoryPort) {
  return new RealtimeDurableControlAuthority(repo, {
    sealKeys: {
      encryptionSecret: ENCRYPTION_SECRET,
      encryptionKeyVersion: 3,
      proofSecret: PROOF_SECRET,
      proofKeyVersion: 5,
    },
    keyRing: {
      encryptionSecret: (version) => version === 3 ? ENCRYPTION_SECRET : null,
      proofSecret: (version) => version === 5 ? PROOF_SECRET : null,
    },
  }, { grantId: () => GRANT });
}

const ISSUE = {
  companyId: 'company-1',
  subjectHash: SUBJECT,
  sessionId: SESSION,
  turnId: TURN,
  artifactId: ARTIFACT,
  contextRevision: 7,
  contextDigest: DIGEST,
  sidebandOwnerEpoch: 2,
  sidebandOwnerTokenHash: OWNER,
  kind: 'answer' as const,
};

describe('RealtimeDurableControlAuthority', () => {
  it('ne persiste rien pour une réponse sans contrôle', async () => {
    const repo = repository();
    await expect(authority(repo).issue(ISSUE)).resolves.toEqual({ status: 'not_required' });
    expect(repo.issue).not.toHaveBeenCalled();
  });

  it('scelle une navigation sur le turn acoustique et transmet le fence owner', async () => {
    const repo = repository();
    await expect(authority(repo).issue({ ...ISSUE, navigate: '/devis/new' }))
      .resolves.toEqual({ status: 'issued', grantId: GRANT });
    expect(repo.issue).toHaveBeenCalledWith(expect.objectContaining({
      grantId: GRANT,
      turnId: TURN,
      artifactId: ARTIFACT,
      subjectHash: SUBJECT,
      sidebandOwnerEpoch: 2,
      sidebandOwnerTokenHash: OWNER,
      controlKind: 'navigate',
      maxTtlSeconds: 120,
      proposalExpiresAt: null,
    }));
    const persisted = repo.issue.mock.calls[0]![0];
    expect(new TextDecoder().decode(persisted.sealedControl)).not.toContain('/devis/new');
  });

  it('normalise le turn Mistral sur redemptionId sans modifier la proposition', async () => {
    const repo = repository();
    const proposalId = '66666666-6666-4666-8666-666666666666';
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    await authority(repo).issue({
      ...ISSUE,
      // Le monobrain peut avoir produit un autre turn ; il n'est volontairement pas dans ce port.
      proposalId,
      proposalExpiresAt: expiresAt,
      kind: 'proposed',
    });
    expect(repo.issue).toHaveBeenCalledWith(expect.objectContaining({
      turnId: TURN,
      controlKind: 'proposal',
      proposalExpiresAt: expiresAt,
    }));
  });

  it('ouvre le grant livré et rejoue le même reçu après une réponse HTTP perdue', async () => {
    const binding = {
      companyId: ISSUE.companyId,
      sessionId: SESSION,
      turnId: TURN,
      artifactId: ARTIFACT,
      contextRevision: 7,
      contextDigest: DIGEST,
    };
    const sealed = sealRealtimeControl({
      turnId: TURN,
      kind: 'done',
      contextRevision: 7,
      contextDigest: DIGEST,
      navigate: '/devis/new',
    }, binding, {
      encryptionSecret: ENCRYPTION_SECRET,
      encryptionKeyVersion: 3,
      proofSecret: PROOF_SECRET,
      proofKeyVersion: 5,
    });
    const repo = repository({
      readConsumable: vi.fn(async () => ({
        status: 'eligible' as const,
        grant: {
          ...binding,
          ...sealed,
          grantId: GRANT,
          acknowledgementId: ACK,
          subjectHash: SUBJECT,
          sidebandOwnerEpoch: 2,
          sidebandOwnerTokenHash: OWNER,
          databaseNow: new Date('2026-07-14T12:00:00.000Z'),
        },
      })),
      consume: vi.fn(async () => ({ status: 'consumed' as const, idempotent: false })),
    });
    await expect(authority(repo).consume({
      companyId: ISSUE.companyId,
      subjectHash: SUBJECT,
      sessionId: SESSION,
      turnId: TURN,
      acknowledgementId: ACK,
      contextRevision: 7,
      contextDigest: DIGEST,
    })).resolves.toEqual({
      status: 'approved',
      idempotent: false,
      control: {
        turnId: TURN,
        kind: 'done',
        contextRevision: 7,
        contextDigest: DIGEST,
        navigate: '/devis/new',
      },
    });
    expect(repo.consume).toHaveBeenCalledWith(expect.objectContaining({
      grantId: GRANT,
      acknowledgementId: ACK,
      artifactId: ARTIFACT,
      controlPayloadHmac: sealed.controlPayloadHmac,
    }));

    repo.consume.mockResolvedValue({ status: 'consumed', idempotent: true });
    await expect(authority(repo).consume({
      companyId: ISSUE.companyId,
      subjectHash: SUBJECT,
      sessionId: SESSION,
      turnId: TURN,
      acknowledgementId: ACK,
      contextRevision: 7,
      contextDigest: DIGEST,
    })).resolves.toEqual({
      status: 'approved',
      idempotent: true,
      control: {
        turnId: TURN,
        kind: 'done',
        contextRevision: 7,
        contextDigest: DIGEST,
        navigate: '/devis/new',
      },
    });
  });

  it('échoue fermé avant le CAS si le ciphertext a été altéré', async () => {
    const binding = {
      companyId: ISSUE.companyId,
      sessionId: SESSION,
      turnId: TURN,
      artifactId: ARTIFACT,
      contextRevision: 7,
      contextDigest: DIGEST,
    };
    const sealed = sealRealtimeControl({
      turnId: TURN,
      kind: 'done',
      contextRevision: 7,
      contextDigest: DIGEST,
      navigate: '/devis/new',
    }, binding, {
      encryptionSecret: ENCRYPTION_SECRET,
      encryptionKeyVersion: 3,
      proofSecret: PROOF_SECRET,
      proofKeyVersion: 5,
    });
    sealed.sealedControl[0] = (sealed.sealedControl[0] ?? 0) ^ 1;
    const repo = repository({
      readConsumable: vi.fn(async () => ({
        status: 'eligible' as const,
        grant: {
          ...binding,
          ...sealed,
          grantId: GRANT,
          acknowledgementId: ACK,
          subjectHash: SUBJECT,
          sidebandOwnerEpoch: 2,
          sidebandOwnerTokenHash: OWNER,
          databaseNow: new Date(),
        },
      })),
    });
    await expect(authority(repo).consume({
      companyId: ISSUE.companyId,
      subjectHash: SUBJECT,
      sessionId: SESSION,
      turnId: TURN,
      acknowledgementId: ACK,
      contextRevision: 7,
      contextDigest: DIGEST,
    })).resolves.toEqual({ status: 'unavailable' });
    expect(repo.consume).not.toHaveBeenCalled();
  });

  it('rejette les identités invalides sans interroger la base', async () => {
    const repo = repository();
    await expect(authority(repo).consume({
      companyId: ISSUE.companyId,
      subjectHash: SUBJECT,
      sessionId: SESSION,
      turnId: TURN,
      acknowledgementId: 'not-an-ack',
      contextRevision: 7,
      contextDigest: DIGEST,
    })).resolves.toEqual({ status: 'not_found' });
    expect(repo.readConsumable).not.toHaveBeenCalled();
  });
});
