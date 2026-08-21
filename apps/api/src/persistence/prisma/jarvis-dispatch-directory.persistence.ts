/**
 * Jarvis U1-l — adapter de l'annuaire global paginé.
 *
 * Chaque geste ouvre une transaction globale courte et vérifie ses timeouts avant d'appeler une
 * fonction SECURITY DEFINER. Le binaire N ne connaît pas la fonction v1 stateless : une absence,
 * une exception ou une projection SQL incohérente devient `unavailable`, jamais une page vide.
 */
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Prisma } from '@prisma/client';
import { hasAsciiControlCharacter } from '@bob/core';

import {
  JARVIS_DISPATCH_DIRECTORY_HARD_LEASE_MS,
  JARVIS_DISPATCH_DIRECTORY_MAX_PAGE_SIZE,
  JARVIS_DISPATCH_DIRECTORY_WATCHDOG_MARGIN_MS,
  type JarvisDispatchDirectoryAckResult,
  type JarvisDispatchDirectoryClaimCommand,
  type JarvisDispatchDirectoryClaimInput,
  type JarvisDispatchDirectoryClaimResult,
  type JarvisDispatchCoordinates,
  type JarvisDispatchDirectoryRenewResult,
  type JarvisDispatchDirectoryStartCommand,
  type JarvisDispatchDirectoryStartResult,
  type JarvisDispatchRunDirectoryPort,
} from '../../jobs/jarvis-dispatch-directory';
import { PrismaService } from './prisma.service';

const DIRECTORY_STATEMENT_TIMEOUT = '4s';
const DIRECTORY_LOCK_TIMEOUT = '1s';
const DIRECTORY_TRANSACTION_OPTIONS = { maxWaitMs: 2_000, timeoutMs: 10_000 } as const;

interface DirectoryTimeoutRow {
  readonly statementTimeout: string | null;
  readonly lockTimeout: string | null;
}

interface DispatchDirectoryClaimRow {
  readonly status: unknown;
  readonly companyId: unknown;
  readonly claimId: unknown;
  readonly position: unknown;
  readonly pageSize: unknown;
  readonly ownerUserId: unknown;
  readonly runId: unknown;
  readonly hasMore: unknown;
  readonly replayed: unknown;
  readonly databaseNow: unknown;
  readonly claimHardExpiresAt: unknown;
}

interface BooleanResultRow {
  readonly result: unknown;
}

function isDirectoryIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string'
    && value.length >= 1
    && value.length <= 200
    && value === value.trim()
    && !hasAsciiControlCharacter(value)
  );
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

function isCanonicalNonNilUuid(value: unknown): value is string {
  return typeof value === 'string' && value !== NIL_UUID && UUID_PATTERN.test(value);
}

function validClaimCommand(input: unknown): input is JarvisDispatchDirectoryClaimCommand {
  if (typeof input !== 'object' || input === null) return false;
  const candidate = input as Partial<JarvisDispatchDirectoryClaimCommand>;
  return isDirectoryIdentifier(candidate.companyId) && isCanonicalNonNilUuid(candidate.claimId);
}

function compareCoordinateBytes(
  left: Pick<JarvisDispatchCoordinates, 'ownerUserId' | 'runId'>,
  right: Pick<JarvisDispatchCoordinates, 'ownerUserId' | 'runId'>,
): number {
  const ownerOrder = Buffer.compare(
    Buffer.from(left.ownerUserId, 'utf8'),
    Buffer.from(right.ownerUserId, 'utf8'),
  );
  if (ownerOrder !== 0) return ownerOrder;
  return Buffer.compare(
    Buffer.from(left.runId.replaceAll('-', ''), 'hex'),
    Buffer.from(right.runId.replaceAll('-', ''), 'hex'),
  );
}

function allControlFieldsNull(row: DispatchDirectoryClaimRow): boolean {
  return (
    row.claimId === null
    && row.position === null
    && row.pageSize === null
    && row.ownerUserId === null
    && row.runId === null
    && row.hasMore === null
    && row.replayed === null
    && row.databaseNow === null
    && row.claimHardExpiresAt === null
  );
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

interface HomogeneousPageMetadata {
  readonly pageSize: number;
  readonly hasMore: boolean;
  readonly replayed: boolean;
  readonly databaseNowMs: number;
  readonly claimHardExpiresAtMs: number;
}

function readPageMetadata(row: DispatchDirectoryClaimRow): HomogeneousPageMetadata | null {
  if (
    !Number.isSafeInteger(row.pageSize)
    || (row.pageSize as number) < 1
    || (row.pageSize as number) > JARVIS_DISPATCH_DIRECTORY_MAX_PAGE_SIZE
    || typeof row.hasMore !== 'boolean'
    || typeof row.replayed !== 'boolean'
    || !validDate(row.databaseNow)
    || !validDate(row.claimHardExpiresAt)
  ) return null;
  const databaseNowMs = row.databaseNow.getTime();
  const claimHardExpiresAtMs = row.claimHardExpiresAt.getTime();
  const hardLeaseMs = claimHardExpiresAtMs - databaseNowMs;
  if (hardLeaseMs <= 0 || hardLeaseMs > JARVIS_DISPATCH_DIRECTORY_HARD_LEASE_MS) return null;
  return {
    pageSize: row.pageSize as number,
    hasMore: row.hasMore,
    replayed: row.replayed,
    databaseNowMs,
    claimHardExpiresAtMs,
  };
}

function samePageMetadata(
  row: DispatchDirectoryClaimRow,
  expected: HomogeneousPageMetadata,
): boolean {
  const actual = readPageMetadata(row);
  return (
    actual !== null
    && actual.pageSize === expected.pageSize
    && actual.hasMore === expected.hasMore
    && actual.replayed === expected.replayed
    && actual.databaseNowMs === expected.databaseNowMs
    && actual.claimHardExpiresAtMs === expected.claimHardExpiresAtMs
  );
}

export class PrismaJarvisDispatchRunDirectory implements JarvisDispatchRunDirectoryPort {
  constructor(private readonly prisma: PrismaService) {}

  private withBoundedDirectory<T>(
    operation: (transaction: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.withIsolatedGlobal(async (transaction) => {
      const [timeouts] = await transaction.$queryRaw<DirectoryTimeoutRow[]>(Prisma.sql`
        SELECT pg_catalog.set_config(
                 'statement_timeout', ${DIRECTORY_STATEMENT_TIMEOUT}, true
               ) AS "statementTimeout",
               pg_catalog.set_config(
                 'lock_timeout', ${DIRECTORY_LOCK_TIMEOUT}, true
               ) AS "lockTimeout"
      `);
      if (
        timeouts?.statementTimeout !== DIRECTORY_STATEMENT_TIMEOUT
        || timeouts.lockTimeout !== DIRECTORY_LOCK_TIMEOUT
      ) throw new Error('jarvis_dispatch_directory_timeout_fence_rejected');
      return operation(transaction);
    }, DIRECTORY_TRANSACTION_OPTIONS);
  }

  async claimDispatchCoordinates(
    input: JarvisDispatchDirectoryClaimInput,
  ): Promise<JarvisDispatchDirectoryClaimResult> {
    if (
      typeof input !== 'object'
      || input === null
      || !isDirectoryIdentifier(input.companyId)
      || !Number.isSafeInteger(input.limit)
      || input.limit < 1
      || input.limit > JARVIS_DISPATCH_DIRECTORY_MAX_PAGE_SIZE
    ) return { status: 'unavailable' };

    const requestedClaimId = randomUUID();
    const queryStartedAt = performance.now();
    try {
      return await this.withBoundedDirectory(async (transaction) => {
        const rows = await transaction.$queryRaw<DispatchDirectoryClaimRow[]>(Prisma.sql`
          SELECT directory.status AS status,
                 directory."companyId" AS "companyId",
                 directory."claimId" AS "claimId",
                 directory."position" AS "position",
                 directory."pageSize" AS "pageSize",
                 directory."ownerUserId" AS "ownerUserId",
                 directory."runId" AS "runId",
                 directory."hasMore" AS "hasMore",
                 directory.replayed AS replayed,
                 directory."databaseNow" AS "databaseNow",
                 directory."claimHardExpiresAt" AS "claimHardExpiresAt"
            FROM public.claim_jarvis_dispatch_coordinates_v2(
              ${input.companyId}::text, ${input.limit}::integer, ${requestedClaimId}::uuid
            ) AS directory
        `);
        if (rows.length === 0) throw new Error('jarvis_dispatch_directory_projection_rejected');
        const status = rows[0]?.status;
        if (rows.some((row) => row.status !== status || row.companyId !== input.companyId)) {
          throw new Error('jarvis_dispatch_directory_projection_rejected');
        }

        if (status === 'empty' || status === 'busy') {
          if (rows.length !== 1 || !allControlFieldsNull(rows[0]!)) {
            throw new Error('jarvis_dispatch_directory_projection_rejected');
          }
          return { status };
        }

        if (status !== 'claimed' && status !== 'ack_ready') {
          throw new Error('jarvis_dispatch_directory_projection_rejected');
        }
        const first = rows[0]!;
        const metadata = readPageMetadata(first);
        if (
          metadata === null
          || first.claimId !== requestedClaimId
          || rows.some(
            (row) => row.claimId !== requestedClaimId || !samePageMetadata(row, metadata),
          )
        ) throw new Error('jarvis_dispatch_directory_projection_rejected');

        const queryElapsedMs = Math.max(0, performance.now() - queryStartedAt);
        const hardLeaseRemainingMs = Math.floor(
          metadata.claimHardExpiresAtMs
          - metadata.databaseNowMs
          - queryElapsedMs
          - JARVIS_DISPATCH_DIRECTORY_WATCHDOG_MARGIN_MS,
        );
        if (hardLeaseRemainingMs <= 0) {
          throw new Error('jarvis_dispatch_directory_projection_rejected');
        }
        const owned = {
          claimId: requestedClaimId,
          pageSize: metadata.pageSize,
          hasMore: metadata.hasMore,
          replayed: metadata.replayed,
          hardLeaseRemainingMs,
        } as const;

        if (status === 'ack_ready') {
          if (
            rows.length !== 1
            || metadata.replayed !== true
            || first.position !== null
            || first.ownerUserId !== null
            || first.runId !== null
          ) throw new Error('jarvis_dispatch_directory_projection_rejected');
          return Object.freeze({ status, ...owned });
        }

        if (rows.length > JARVIS_DISPATCH_DIRECTORY_MAX_PAGE_SIZE) {
          throw new Error('jarvis_dispatch_directory_projection_rejected');
        }
        const entries: Array<{
          readonly position: number;
          readonly coordinates: JarvisDispatchCoordinates;
        }> = [];
        const seen = new Set<string>();
        for (const [index, row] of rows.entries()) {
          if (
            !Number.isSafeInteger(row.position)
            || (row.position as number) < 1
            || (row.position as number) > metadata.pageSize
            || !isDirectoryIdentifier(row.ownerUserId)
            || !isCanonicalNonNilUuid(row.runId)
          ) throw new Error('jarvis_dispatch_directory_projection_rejected');
          const position = row.position as number;
          if (index > 0 && position !== entries[index - 1]!.position + 1) {
            throw new Error('jarvis_dispatch_directory_projection_rejected');
          }
          const coordinates = Object.freeze({
            companyId: input.companyId,
            ownerUserId: row.ownerUserId,
            runId: row.runId,
          });
          if (
            index > 0
            && compareCoordinateBytes(entries[index - 1]!.coordinates, coordinates) >= 0
          ) throw new Error('jarvis_dispatch_directory_projection_rejected');
          const key = `${coordinates.ownerUserId}\u0000${coordinates.runId}`;
          if (seen.has(key)) throw new Error('jarvis_dispatch_directory_projection_rejected');
          seen.add(key);
          entries.push(Object.freeze({ position, coordinates }));
        }
        if (
          entries.length === 0
          || entries.at(-1)?.position !== metadata.pageSize
          || (!metadata.replayed && entries[0]?.position !== 1)
          || (!metadata.replayed && metadata.pageSize > input.limit)
        ) throw new Error('jarvis_dispatch_directory_projection_rejected');
        return Object.freeze({ status, ...owned, entries: Object.freeze(entries) });
      });
    } catch {
      return { status: 'unavailable' };
    }
  }

  async renewDispatchCoordinatesClaim(
    input: JarvisDispatchDirectoryClaimCommand,
  ): Promise<JarvisDispatchDirectoryRenewResult> {
    return this.runBooleanGesture(
      input,
      (transaction) => transaction.$queryRaw<BooleanResultRow[]>(Prisma.sql`
        SELECT public.renew_jarvis_dispatch_coordinates_claim_v2(
          ${input.companyId}::text, ${input.claimId}::uuid
        ) AS result
      `),
      'renewed',
    );
  }

  async startDispatchCoordinate(
    input: JarvisDispatchDirectoryStartCommand,
  ): Promise<JarvisDispatchDirectoryStartResult> {
    if (
      !validClaimCommand(input)
      || !Number.isSafeInteger(input.position)
      || input.position < 1
      || input.position > JARVIS_DISPATCH_DIRECTORY_MAX_PAGE_SIZE
    ) return { status: 'unavailable' };
    return this.runBooleanGesture(
      input,
      (transaction) => transaction.$queryRaw<BooleanResultRow[]>(Prisma.sql`
        SELECT public.start_jarvis_dispatch_coordinate_v2(
          ${input.companyId}::text, ${input.claimId}::uuid, ${input.position}::integer
        ) AS result
      `),
      'started',
    );
  }

  async acknowledgeDispatchCoordinates(
    input: JarvisDispatchDirectoryClaimCommand,
  ): Promise<JarvisDispatchDirectoryAckResult> {
    return this.runBooleanGesture(
      input,
      (transaction) => transaction.$queryRaw<BooleanResultRow[]>(Prisma.sql`
        SELECT public.ack_jarvis_dispatch_coordinates_v2(
          ${input.companyId}::text, ${input.claimId}::uuid
        ) AS result
      `),
      'acknowledged',
    );
  }

  private async runBooleanGesture<Key extends 'renewed' | 'started' | 'acknowledged'>(
    input: JarvisDispatchDirectoryClaimCommand,
    query: (transaction: Prisma.TransactionClient) => Promise<BooleanResultRow[]>,
    key: Key,
  ): Promise<
    | ({ readonly status: 'succeeded' } & Readonly<Record<Key, boolean>>)
    | { readonly status: 'unavailable' }
  > {
    if (!validClaimCommand(input)) return { status: 'unavailable' };
    try {
      return await this.withBoundedDirectory(async (transaction) => {
        const [row] = await query(transaction);
        if (!row || typeof row.result !== 'boolean') {
          throw new Error('jarvis_dispatch_directory_boolean_projection_rejected');
        }
        return { status: 'succeeded' as const, [key]: row.result } as {
          readonly status: 'succeeded';
        } & Readonly<Record<Key, boolean>>;
      });
    } catch {
      return { status: 'unavailable' };
    }
  }
}
