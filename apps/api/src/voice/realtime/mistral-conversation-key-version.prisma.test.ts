import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../persistence/prisma/prisma.service';
import {
  fingerprintMistralConversationPersistenceKey,
  PrismaMistralConversationKeyVersionAuthority,
} from './mistral-conversation-key-version.prisma';

const CURRENT_SECRET = new Uint8Array(32).fill(7);
const CURRENT_FINGERPRINT = fingerprintMistralConversationPersistenceKey(CURRENT_SECRET);

function prismaReturning(
  minimumVersion: number,
  highestVersion = minimumVersion,
  inTransaction = false,
  keyFingerprint: string | null = CURRENT_FINGERPRINT,
) {
  const tx = {
    $queryRaw: vi.fn(async () => [{ minimumVersion, highestVersion, keyFingerprint }]),
  } as unknown as Prisma.TransactionClient;
  const transaction = vi.fn(async (
    callback: (client: Prisma.TransactionClient) => Promise<void>,
  ) => callback(tx));
  const prisma = {
    inTransaction: vi.fn(() => inTransaction),
    $transaction: transaction,
  } as unknown as PrismaService;
  return { prisma, transaction, tx };
}

describe('PrismaMistralConversationKeyVersionAuthority', () => {
  it.each([0, -1, 1.5, Number.NaN, 2_147_483_648])(
    'refuse une version PostgreSQL invalide (%s)',
    (version) => {
      const { prisma } = prismaReturning(1);
      expect(() => new PrismaMistralConversationKeyVersionAuthority(
        prisma,
        version,
        CURRENT_SECRET,
      ))
        .toThrow(/positive integer/);
    },
  );

  it('refuse toute composition dans une transaction ambiante', async () => {
    const { prisma, transaction } = prismaReturning(1, 1, true);
    const authority = new PrismaMistralConversationKeyVersionAuthority(
      prisma,
      1,
      CURRENT_SECRET,
    );

    await expect(authority.assertCurrentVersion()).rejects.toThrow(/root transaction/);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('admet une version courante comprise dans la plage préparée', async () => {
    const { prisma, transaction, tx } = prismaReturning(2, 4);
    const authority = new PrismaMistralConversationKeyVersionAuthority(
      prisma,
      3,
      CURRENT_SECRET,
    );

    await expect(authority.assertCurrentVersion()).resolves.toBeUndefined();
    expect(transaction).toHaveBeenCalledOnce();
    expect(tx.$queryRaw).toHaveBeenCalledOnce();
  });

  it('refuse le boot sous le plancher durable', async () => {
    const { prisma } = prismaReturning(4, 5);
    const authority = new PrismaMistralConversationKeyVersionAuthority(
      prisma,
      3,
      CURRENT_SECRET,
    );

    await expect(authority.assertCurrentVersion()).rejects.toThrow(
      /version 3 is outside the admitted range 4-5/,
    );
  });

  it('refuse le boot au-dessus de la clé préparée', async () => {
    const { prisma } = prismaReturning(2, 3);
    const authority = new PrismaMistralConversationKeyVersionAuthority(
      prisma,
      4,
      CURRENT_SECRET,
    );

    await expect(authority.assertCurrentVersion()).rejects.toThrow(
      /version 4 is outside the admitted range 2-3/,
    );
  });

  it('échoue fermée sur une réponse PostgreSQL absente ou mal formée', async () => {
    const tx = { $queryRaw: vi.fn(async () => []) } as unknown as Prisma.TransactionClient;
    const prisma = {
      inTransaction: () => false,
      $transaction: (callback: (client: Prisma.TransactionClient) => Promise<void>) => callback(tx),
    } as unknown as PrismaService;
    const authority = new PrismaMistralConversationKeyVersionAuthority(
      prisma,
      1,
      CURRENT_SECRET,
    );

    await expect(authority.assertCurrentVersion()).rejects.toThrow(/not initialized/);
  });

  it('refuse une clé absente ou différente pour une version déjà engagée', async () => {
    const { prisma: missing } = prismaReturning(3, 3, false, null);
    await expect(
      new PrismaMistralConversationKeyVersionAuthority(
        missing,
        3,
        CURRENT_SECRET,
      ).assertCurrentVersion(),
    ).rejects.toThrow(/does not match durable version 3/);

    const { prisma: changed } = prismaReturning(3, 3, false, 'f'.repeat(64));
    await expect(
      new PrismaMistralConversationKeyVersionAuthority(
        changed,
        3,
        CURRENT_SECRET,
      ).assertCurrentVersion(),
    ).rejects.toThrow(/does not match durable version 3/);
  });

  it('refuse un matériau qui ne contient pas exactement 32 octets', () => {
    const { prisma } = prismaReturning(1);
    expect(() => new PrismaMistralConversationKeyVersionAuthority(
      prisma,
      1,
      new Uint8Array(31),
    )).toThrow(/exactly 32 bytes/);
  });
});
