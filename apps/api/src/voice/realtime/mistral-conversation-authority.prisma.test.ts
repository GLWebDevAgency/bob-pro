import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../persistence/prisma/prisma.service';
import { PrismaMistralConversationDurableAuthority } from './mistral-conversation-authority.prisma';
import type { MistralConversationCompletionTransactionPort } from './mistral-conversation-completion';
import type { MistralConversationPersistenceKeyRing } from './mistral-conversation-outbox-seal';

const completion: MistralConversationCompletionTransactionPort = {
  authorizeAndOpen: vi.fn(async () => ({ status: 'opened' as const })),
};

const validKeys: MistralConversationPersistenceKeyRing = {
  currentVersion: 1,
  secret: (version) => version === 1 ? new Uint8Array(32).fill(1) : null,
};

function prismaWithoutIo(): PrismaService {
  return {
    withTenant: vi.fn(() => {
      throw new Error('Persistence must not be reached for invalid input.');
    }),
  } as unknown as PrismaService;
}

describe('Prisma Mistral conversation authority — configuration fail-closed', () => {
  it('refuse une clé courante absente, trop courte ou une grâce de replay hors bornes', () => {
    expect(() => new PrismaMistralConversationDurableAuthority(
      prismaWithoutIo(),
      completion,
      { currentVersion: 2, secret: () => null },
    )).toThrow(/Invalid Mistral conversation persistence key ring/u);

    expect(() => new PrismaMistralConversationDurableAuthority(
      prismaWithoutIo(),
      completion,
      { currentVersion: 2, secret: () => new Uint8Array(31) },
    )).toThrow(/Invalid Mistral conversation persistence key ring/u);

    expect(() => new PrismaMistralConversationDurableAuthority(
      prismaWithoutIo(),
      completion,
      validKeys,
      { replayGraceMs: 59_999 },
    )).toThrow(/Invalid Mistral conversation replay grace/u);
  });

  it('rejette les entrées invalides ou déjà annulées avant toute I/O SQL', async () => {
    const prisma = prismaWithoutIo();
    const authority = new PrismaMistralConversationDurableAuthority(prisma, completion, validKeys);
    const aborted = new AbortController();
    aborted.abort();

    await expect(authority.open({
      grant: {
        bootstrapId: '30000000-0000-4000-8000-000000000001',
        companyId: 'company-1',
        subjectHash: 'a'.repeat(64),
        subjectKeyVersion: 1,
        plan: 'pro',
        sessionHandle: 'session_handle_1234567890abcdef',
        hardExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        contextRevision: 1,
        contextDigest: 'b'.repeat(64),
        routeMode: 'push_to_talk',
        fullDuplexCertified: false,
        maxMissionAudioBytes: 320_000,
      },
      ownerLeaseToken: 'L'.repeat(43),
      resumeNextServerSequence: 0,
      maxReplayEvents: 256,
      maxReplayBytes: 256 * 1024,
      signal: aborted.signal,
    })).resolves.toEqual({ status: 'unavailable' });

    await expect(authority.transition({
      companyId: 'company-1',
      subjectHash: 'not-a-hash',
      sessionHandle: 'session_handle_1234567890abcdef',
      ownerLeaseToken: 'L'.repeat(43),
      missionConnectionEpoch: 1,
      expectedVersion: 1,
      maxUnacknowledgedEvents: 256,
      maxUnacknowledgedBytes: 256 * 1024,
      command: {
        type: 'record_error',
        commandId: 'error:invalid-input',
        errorCode: 'internal_error',
        retryable: true,
      },
      signal: new AbortController().signal,
    })).resolves.toEqual({ status: 'unavailable' });

    expect(prisma.withTenant).not.toHaveBeenCalled();
  });

  it('refuse une transaction ambiante pour garantir son rollback racine', async () => {
    const withTenant = vi.fn();
    const prisma = {
      inTransaction: vi.fn(() => true),
      withTenant,
    } as unknown as PrismaService;
    const authority = new PrismaMistralConversationDurableAuthority(prisma, completion, validKeys);
    const grant = {
      bootstrapId: '30000000-0000-4000-8000-000000000001',
      companyId: 'company-1',
      subjectHash: 'a'.repeat(64),
      subjectKeyVersion: 1,
      plan: 'pro' as const,
      sessionHandle: 'session_handle_1234567890abcdef',
      hardExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      contextRevision: 1,
      contextDigest: 'b'.repeat(64),
      routeMode: 'push_to_talk' as const,
      fullDuplexCertified: false,
      maxMissionAudioBytes: 320_000,
    };

    await expect(authority.open({
      grant,
      ownerLeaseToken: 'L'.repeat(43),
      resumeNextServerSequence: 0,
      maxReplayEvents: 256,
      maxReplayBytes: 256 * 1024,
      signal: new AbortController().signal,
    })).resolves.toEqual({ status: 'unavailable' });

    await expect(authority.transition({
      companyId: grant.companyId,
      subjectHash: grant.subjectHash,
      sessionHandle: grant.sessionHandle,
      ownerLeaseToken: 'L'.repeat(43),
      missionConnectionEpoch: 1,
      expectedVersion: 1,
      maxUnacknowledgedEvents: 256,
      maxUnacknowledgedBytes: 256 * 1024,
      command: {
        type: 'record_error',
        commandId: 'error:ambient-transaction',
        errorCode: 'internal_error',
        retryable: true,
      },
      signal: new AbortController().signal,
    })).resolves.toEqual({ status: 'unavailable' });

    expect(withTenant).not.toHaveBeenCalled();
  });
});
