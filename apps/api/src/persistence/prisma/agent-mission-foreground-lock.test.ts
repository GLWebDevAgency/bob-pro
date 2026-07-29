import type {
  AgentMissionRealtimeAuthorityProof,
  AgentMissionTransaction,
} from '@bob/core';
import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import {
  PrismaAgentMissionDraftFence,
  PrismaAgentMissionUnitOfWork,
} from './agent-mission.persistence';
import type { PrismaService } from './prisma.service';

const OWNER = Object.freeze({
  companyId: 'company-1',
  ownerUserId: 'owner-1',
});
const AUTHORITY = Object.freeze({
  subjectHashCandidates: Object.freeze(['a'.repeat(64)]),
  principalBindingHash: 'b'.repeat(64),
  capabilityHash: 'c'.repeat(64),
}) satisfies AgentMissionRealtimeAuthorityProof;

function lockFailingPrisma(
  sqlState: string,
  options: {
    readonly failAtQuery?: number | null;
    readonly boundaryOutcome?: (outcome: 'resolved' | 'rejected') => void;
  } = {},
): PrismaService {
  let queryNumber = 0;
  const failAtQuery = options.failAtQuery === undefined ? 2 : options.failAtQuery;
  const transaction = {
    $executeRaw: async () => 0,
    $queryRaw: async () => {
      queryNumber += 1;
      if (queryNumber === failAtQuery) throw postgresFailure(sqlState);
      if (queryNumber === 1) return [{ closedAt: null }];
      return [];
    },
  } as unknown as Prisma.TransactionClient;
  return {
    withIsolatedOwner: async (
      _companyId: string,
      _ownerUserId: string,
      work: (tx: Prisma.TransactionClient) => Promise<unknown>,
    ) => {
      try {
        const value = await work(transaction);
        options.boundaryOutcome?.('resolved');
        return value;
      } catch (error) {
        options.boundaryOutcome?.('rejected');
        throw error;
      }
    },
  } as unknown as PrismaService;
}

function postgresFailure(sqlState: string): {
  readonly code: 'P2010';
  readonly meta: { readonly code: string; readonly message: string };
} {
  return {
    code: 'P2010',
    meta: { code: sqlState, message: 'sensitive database detail' },
  };
}

function prismaTransactionFailure(error: string): {
  readonly code: 'P2028';
  readonly meta: { readonly error: string };
} {
  return {
    code: 'P2028',
    meta: { error },
  };
}

function boundaryFailingPrisma(error: unknown): PrismaService {
  return {
    withIsolatedOwner: async () => {
      throw error;
    },
  } as unknown as PrismaService;
}

function authorizedPrismaWithFutureEvent(): {
  readonly prisma: PrismaService;
  readonly findEvent: ReturnType<typeof vi.fn>;
} {
  const now = new Date('2026-07-29T10:00:00.000Z');
  const findEvent = vi.fn()
    .mockResolvedValueOnce({
      missionId: 'future-mission',
      mission: { kind: 'future_kind' },
    })
    .mockRejectedValue(new Error('FUTURE_EVENT_MUST_NOT_BE_PARSED'));
  let queryNumber = 0;
  const transaction = {
    $executeRaw: async () => 0,
    $queryRaw: async () => {
      queryNumber += 1;
      if (queryNumber === 1) return [{ closedAt: null }];
      if (queryNumber >= 2 && queryNumber <= 4) return [];
      if (queryNumber === 5) {
        return [{
          subjectHash: AUTHORITY.subjectHashCandidates[0],
          sessionId: 'realtime-session-1',
          state: 'active',
          leaseExpiresAt: new Date(now.getTime() + 60_000),
          hardExpiresAt: new Date(now.getTime() + 120_000),
          contextSchemaVersion: null,
          contextRevision: null,
          contextPayload: null,
          contextDigest: null,
          contextUpdatedAt: null,
          sidebandOwnerLeaseExpiresAt: null,
          sidebandOwnerEpoch: 0,
          contextAppliedRevision: null,
          contextAppliedDigest: null,
          contextAppliedAt: null,
          contextAppliedOwnerEpoch: null,
          agentMissionProtocolVersion: 1,
          agentMissionProtocolBoundAt: new Date(now.getTime() - 1_000),
          agentMissionCapabilityHash: AUTHORITY.capabilityHash,
          agentMissionReleaseFlagVersion: 1,
          agentMissionBootstrapAcknowledgedAt: new Date(now.getTime() - 1_000),
        }];
      }
      if (queryNumber === 6) return [{ now }];
      throw new Error(`UNEXPECTED_QUERY_${queryNumber}`);
    },
    agentMissionEvent: { findFirst: findEvent },
  } as unknown as Prisma.TransactionClient;
  return {
    findEvent,
    prisma: {
      withIsolatedOwner: async (
        _companyId: string,
        _ownerUserId: string,
        work: (tx: Prisma.TransactionClient) => Promise<unknown>,
      ) => work(transaction),
    } as unknown as PrismaService,
  };
}

describe('AgentMission foreground lock — erreurs bornées', () => {
  it.each([
    ['55P03', 'lock_timeout'],
    ['57014', 'query_canceled'],
  ] as const)(
    'traduit %s avant toute autorité, agrégat ou mutation',
    async (sqlState, reason) => {
      const work = vi.fn(async (_transaction: AgentMissionTransaction) => 'unreachable');
      const boundaryOutcome = vi.fn();
      const unitOfWork = new PrismaAgentMissionUnitOfWork(
        lockFailingPrisma(sqlState, { boundaryOutcome }),
      );

      await expect(unitOfWork.runQuoteCreationOwner(
        OWNER,
        AUTHORITY,
        work,
      )).resolves.toEqual({
        status: 'foreground_unavailable',
        reason,
      });
      expect(work).not.toHaveBeenCalled();
      expect(boundaryOutcome).toHaveBeenCalledWith('rejected');
    },
  );

  it('applique la même fermeture au writer manuel du brouillon', async () => {
    const work = vi.fn(async () => 'unreachable');
    const fence = new PrismaAgentMissionDraftFence(
      lockFailingPrisma('55P03'),
    );

    await expect(
      fence.runLegacyMutationIfUnowned(OWNER, work),
    ).resolves.toEqual({
      status: 'foreground_unavailable',
      reason: 'lock_timeout',
    });
    expect(work).not.toHaveBeenCalled();
  });

  it.each([
    ['company', 1],
    ['principal lock', 4],
    ['authority lease', 5],
  ] as const)(
    'force aussi le rejet de la transaction sur timeout dans la région %s',
    async (_region, failAtQuery) => {
      const boundaryOutcome = vi.fn();
      const unitOfWork = new PrismaAgentMissionUnitOfWork(
        lockFailingPrisma('57014', { failAtQuery, boundaryOutcome }),
      );

      await expect(unitOfWork.runQuoteCreationOwner(
        OWNER,
        AUTHORITY,
        async () => 'unreachable',
      )).resolves.toEqual({
        status: 'foreground_unavailable',
        reason: 'query_canceled',
      });
      expect(boundaryOutcome).toHaveBeenCalledWith('rejected');
    },
  );

  it('force le rejet transactionnel si le callback métier rencontre le timeout', async () => {
    const boundaryOutcome = vi.fn();
    const work = vi.fn(async () => {
      throw postgresFailure('57014');
    });
    const fence = new PrismaAgentMissionDraftFence(
      lockFailingPrisma('unused', {
        failAtQuery: null,
        boundaryOutcome,
      }),
    );

    await expect(fence.runLegacyMutationIfUnowned(OWNER, work)).resolves.toEqual({
      status: 'foreground_unavailable',
      reason: 'query_canceled',
    });
    expect(work).toHaveBeenCalledOnce();
    expect(boundaryOutcome).toHaveBeenCalledWith('rejected');
  });

  it('traduit le timeout transactionnel Prisma P2028 avant callback pour les deux writers', async () => {
    const missionWork = vi.fn(async () => 'unreachable');
    const manualWork = vi.fn(async () => 'unreachable');
    const prisma = boundaryFailingPrisma(prismaTransactionFailure(
      'Unable to start a transaction in the given time.',
    ));

    await expect(new PrismaAgentMissionUnitOfWork(prisma).runQuoteCreationOwner(
      OWNER,
      AUTHORITY,
      missionWork,
    )).resolves.toEqual({
      status: 'foreground_unavailable',
      reason: 'transaction_timeout',
    });
    await expect(new PrismaAgentMissionDraftFence(prisma).runLegacyMutationIfUnowned(
      OWNER,
      manualWork,
    )).resolves.toEqual({
      status: 'foreground_unavailable',
      reason: 'transaction_timeout',
    });
    expect(missionWork).not.toHaveBeenCalled();
    expect(manualWork).not.toHaveBeenCalled();
  });

  it('traduit aussi une transaction Prisma expirée, mais ne masque pas un autre P2028', async () => {
    const expired = boundaryFailingPrisma(prismaTransactionFailure(
      'A query cannot be executed on an expired transaction. The timeout for this transaction was 15 ms.',
    ));
    await expect(new PrismaAgentMissionDraftFence(expired).runLegacyMutationIfUnowned(
      OWNER,
      async () => 'unreachable',
    )).resolves.toEqual({
      status: 'foreground_unavailable',
      reason: 'transaction_timeout',
    });

    const invalidConfiguration = prismaTransactionFailure(
      'Invalid isolation level: SNAPSHOT',
    );
    await expect(new PrismaAgentMissionUnitOfWork(
      boundaryFailingPrisma(invalidConfiguration),
    ).runQuoteCreationOwner(
      OWNER,
      AUTHORITY,
      async () => 'unreachable',
    )).rejects.toBe(invalidConfiguration);
  });

  it('ne maquille pas une panne SQL étrangère en contention', async () => {
    const unitOfWork = new PrismaAgentMissionUnitOfWork(
      lockFailingPrisma('XX000'),
    );

    await expect(unitOfWork.runQuoteCreationOwner(
      OWNER,
      AUTHORITY,
      async () => 'unreachable',
    )).rejects.toMatchObject({
      code: 'P2010',
      meta: { code: 'XX000' },
    });
  });

  it('discrimine un événement d’un futur kind sans charger ni parser son payload', async () => {
    const { prisma, findEvent } = authorizedPrismaWithFutureEvent();
    const unitOfWork = new PrismaAgentMissionUnitOfWork(prisma);

    await expect(unitOfWork.runQuoteCreationOwner(
      OWNER,
      AUTHORITY,
      (transaction) => transaction.events.findByCommandId({
        ...OWNER,
        commandId: 'future-command',
      }),
    )).resolves.toEqual({
      status: 'executed',
      value: {
        status: 'unsupported_kind',
        missionId: 'future-mission',
        kind: 'future_kind',
      },
    });
    expect(findEvent).toHaveBeenCalledOnce();
  });
});
