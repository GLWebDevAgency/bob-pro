import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from './prisma.service';
import {
  PrismaAgentMissionFingerprintKeyVersionAuthority,
} from './agent-mission-fingerprint-key-version.prisma';

const FIRST = 'a'.repeat(64);
const SECOND = 'b'.repeat(64);

interface ReadinessRow {
  readonly keyVersion: number;
  readonly keyFingerprint: string | null;
  readonly retained: boolean;
  readonly minimumWriterVersion: number | null;
  readonly highestWriterVersion: number | null;
  readonly writerEnabled?: boolean | null;
}

function harness(rows: readonly ReadinessRow[], inTransaction = false) {
  const executedQueries: unknown[] = [];
  const executeRaw = vi.fn(async (query: unknown) => {
    executedQueries.push(query);
    return 0;
  });
  const queryRaw = vi.fn(async () => rows.map((row) => ({
    writerEnabled: true,
    ...row,
  })));
  const transaction = {
    $executeRaw: executeRaw,
    $queryRaw: queryRaw,
  } as unknown as Prisma.TransactionClient;
  const rootTransaction = vi.fn(async (
    work: (client: Prisma.TransactionClient) => Promise<void>,
  ) => work(transaction));
  const prisma = {
    inTransaction: vi.fn(() => inTransaction),
    $transaction: rootTransaction,
  } as unknown as PrismaService;
  return { prisma, executeRaw, executedQueries, queryRaw, rootTransaction };
}

function bindings(...entries: ReadonlyArray<readonly [number, string]>) {
  return entries.map(([keyVersion, keyFingerprint]) => ({
    keyVersion,
    keyFingerprint,
  }));
}

describe('PrismaAgentMissionFingerprintKeyVersionAuthority', () => {
  it.each([
    [],
    bindings([0, FIRST]),
    bindings([1, 'A'.repeat(64)]),
    bindings([1, FIRST], [1, SECOND]),
    bindings([1, FIRST], [2, FIRST]),
    Array.from({ length: 33 }, (_, index) => ({
      keyVersion: index + 1,
      keyFingerprint: index.toString(16).padStart(64, '0'),
    })),
  ].map((configured) => [configured] as const))(
    'refuse des bindings non canoniques (%j)',
    (configured) => {
      const { prisma } = harness([]);
      expect(() => new PrismaAgentMissionFingerprintKeyVersionAuthority(
        prisma,
        configured,
        1,
      )).toThrow(/key bindings are invalid/u);
    },
  );

  it('refuse une transaction ambiante avant toute requête', async () => {
    const { prisma, rootTransaction } = harness([], true);
    const authority = new PrismaAgentMissionFingerprintKeyVersionAuthority(
      prisma,
      bindings([1, FIRST]),
      1,
    );

    await expect(authority.assertKeyBindings()).rejects.toThrow(/root transaction/u);
    expect(rootTransaction).not.toHaveBeenCalled();
  });

  it('admet les bindings configurés et retenus exacts en lecture seule', async () => {
    const { prisma, executeRaw, executedQueries, queryRaw } = harness([
      {
        keyVersion: 1,
        keyFingerprint: FIRST,
        retained: true,
        minimumWriterVersion: 1,
        highestWriterVersion: 2,
      },
      {
        keyVersion: 2,
        keyFingerprint: SECOND,
        retained: false,
        minimumWriterVersion: 1,
        highestWriterVersion: 2,
      },
    ]);
    const authority = new PrismaAgentMissionFingerprintKeyVersionAuthority(
      prisma,
      bindings([2, SECOND], [1, FIRST]),
      2,
    );

    await expect(authority.assertKeyBindings()).resolves.toBeUndefined();
    expect(executeRaw).toHaveBeenCalledTimes(3);
    expect(queryRaw).toHaveBeenCalledOnce();
    expect(executeRaw.mock.invocationCallOrder.at(-1))
      .toBeLessThan(queryRaw.mock.invocationCallOrder[0] as number);
    expect(
      executedQueries.map((query) => (
        Array.isArray(query)
          ? query.join('')
          : (query as { readonly strings: readonly string[] }).strings.join('')
      )),
    ).toEqual([
      'SET TRANSACTION READ ONLY',
      "SET LOCAL lock_timeout = '1s'",
      "SET LOCAL statement_timeout = '3s'",
    ]);
  });

  it.each([
    [
      [{
        keyVersion: 1,
        keyFingerprint: null,
        retained: false,
        minimumWriterVersion: 1,
        highestWriterVersion: 1,
      }],
      /material does not match durable version 1/u,
    ],
    [
      [{
        keyVersion: 1,
        keyFingerprint: FIRST,
        retained: false,
        minimumWriterVersion: 1,
        highestWriterVersion: 1,
        writerEnabled: false,
      }],
      /writer key floor is not ready/u,
    ],
    [
      [{
        keyVersion: 1,
        keyFingerprint: SECOND,
        retained: true,
        minimumWriterVersion: 1,
        highestWriterVersion: 1,
      }],
      /material does not match durable version 1/u,
    ],
    [
      [
        {
          keyVersion: 1,
          keyFingerprint: FIRST,
          retained: false,
          minimumWriterVersion: 1,
          highestWriterVersion: 1,
        },
        {
          keyVersion: 2,
          keyFingerprint: SECOND,
          retained: true,
          minimumWriterVersion: 1,
          highestWriterVersion: 1,
        },
      ],
      /key version 2 is retained but unavailable/u,
    ],
  ] as const)('refuse une absence, substitution ou rétention non couverte', async (
    rows,
    error,
  ) => {
    const { prisma } = harness(rows);
    const authority = new PrismaAgentMissionFingerprintKeyVersionAuthority(
      prisma,
      bindings([1, FIRST]),
      1,
    );

    await expect(authority.assertKeyBindings()).rejects.toThrow(error);
  });

  it.each([
    [],
    [
      {
        keyVersion: 1,
        keyFingerprint: FIRST,
        retained: false,
        minimumWriterVersion: 1,
        highestWriterVersion: 1,
      },
      {
        keyVersion: 1,
        keyFingerprint: FIRST,
        retained: true,
        minimumWriterVersion: 1,
        highestWriterVersion: 1,
      },
    ],
    [{
      keyVersion: 0,
      keyFingerprint: FIRST,
      retained: false,
      minimumWriterVersion: 1,
      highestWriterVersion: 1,
    }],
    [{
      keyVersion: 1,
      keyFingerprint: 'A'.repeat(64),
      retained: false,
      minimumWriterVersion: 1,
      highestWriterVersion: 1,
    }],
    [{
      keyVersion: 1,
      keyFingerprint: FIRST,
      retained: 'yes' as unknown as boolean,
      minimumWriterVersion: 1,
      highestWriterVersion: 1,
    }],
    Array.from({ length: 33 }, (_, index) => ({
      keyVersion: index + 1,
      keyFingerprint: index.toString(16).padStart(64, '0'),
      retained: true,
      minimumWriterVersion: 1,
      highestWriterVersion: 1,
    })),
  ].map((rows) => [rows] as const))(
    'refuse une sortie DB non canonique (%j)',
    async (rows) => {
      const { prisma } = harness(rows);
      const authority = new PrismaAgentMissionFingerprintKeyVersionAuthority(
        prisma,
        bindings([1, FIRST]),
        1,
      );

      await expect(authority.assertKeyBindings()).rejects.toThrow(
        'AgentMission fingerprint key readiness output is invalid.',
      );
    },
  );
});
