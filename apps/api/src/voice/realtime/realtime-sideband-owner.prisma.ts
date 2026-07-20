import { Prisma } from '@prisma/client';
import { PrismaService } from '../../persistence/prisma/prisma.service';
import {
  isRealtimeSidebandContextVersion,
  isRealtimeSidebandOwnerAcquireInput,
  isRealtimeSidebandOwnerIdentity,
  type RealtimeSidebandContextVersion,
  type RealtimeSidebandOwnerAcquireInput,
  type RealtimeSidebandOwnerAcquireResult,
  type RealtimeSidebandOwnerContextResult,
  type RealtimeSidebandOwnerIdentity,
  type RealtimeSidebandOwnerMutationResult,
  type RealtimeSidebandOwnerPort,
} from './realtime-sideband-owner';

const POSTGRES_INT_MAX = 2_147_483_647;

interface OwnerLeaseRow {
  readonly subjectHash: string;
  readonly state: string;
  readonly leaseExpiresAt: Date;
  readonly hardExpiresAt: Date;
  readonly sidebandOwnerInstanceHash: string | null;
  readonly sidebandOwnerTokenHash: string | null;
  readonly sidebandOwnerLeaseExpiresAt: Date | null;
  readonly sidebandOwnerEpoch: number;
  readonly contextRevision: number | null;
  readonly contextDigest: string | null;
}

interface AcquiredRow extends OwnerLeaseRow {
  readonly databaseNow: Date;
}

function trimmed(value: string | null): string | null {
  return value === null ? null : value.trim();
}

function contextFromRow(row: Pick<OwnerLeaseRow, 'contextRevision' | 'contextDigest'>): RealtimeSidebandContextVersion | null {
  const digest = trimmed(row.contextDigest);
  const candidate = row.contextRevision === null || digest === null
    ? null
    : { revision: row.contextRevision, digest };
  return candidate !== null && isRealtimeSidebandContextVersion(candidate) ? candidate : null;
}

function acquired(
  input: RealtimeSidebandOwnerAcquireInput,
  row: AcquiredRow,
): RealtimeSidebandOwnerAcquireResult {
  const subjectHash = trimmed(row.subjectHash);
  const ownerTokenHash = trimmed(row.sidebandOwnerTokenHash);
  const ownerInstanceHash = trimmed(row.sidebandOwnerInstanceHash);
  if (
    subjectHash === null
    || ownerTokenHash !== input.candidateOwnerTokenHash
    || ownerInstanceHash !== input.ownerInstanceHash
    || !Number.isSafeInteger(row.sidebandOwnerEpoch)
    || row.sidebandOwnerEpoch < 1
    || row.sidebandOwnerEpoch > POSTGRES_INT_MAX
    || !(row.sidebandOwnerLeaseExpiresAt instanceof Date)
    || row.sidebandOwnerLeaseExpiresAt.getTime() <= row.databaseNow.getTime()
  ) return { status: 'unavailable' };
  const owner: RealtimeSidebandOwnerIdentity = {
    companyId: input.companyId,
    subjectHash,
    sessionId: input.sessionId.toLowerCase(),
    ownerInstanceHash,
    ownerTokenHash,
    ownerEpoch: row.sidebandOwnerEpoch,
  };
  if (!isRealtimeSidebandOwnerIdentity(owner)) return { status: 'unavailable' };
  return {
    status: 'acquired',
    owner,
    currentContext: contextFromRow(row),
    leaseExpiresAt: row.sidebandOwnerLeaseExpiresAt.toISOString(),
  };
}

/**
 * Bail sideband inter-répliques. Toutes les transitions sont CAS sur token+epoch et utilisent
 * l'horloge PostgreSQL ; aucun pod ne peut publier après une reprise de propriété.
 */
export class PrismaRealtimeSidebandOwner implements RealtimeSidebandOwnerPort {
  constructor(private readonly prisma: PrismaService) {}

  async acquire(input: RealtimeSidebandOwnerAcquireInput): Promise<RealtimeSidebandOwnerAcquireResult> {
    if (!isRealtimeSidebandOwnerAcquireInput(input)) return { status: 'rejected' };
    try {
      return await this.prisma.withTenant(input.companyId, async (tx) => {
        const [row] = await tx.$queryRaw<OwnerLeaseRow[]>`
          SELECT "subjectHash", state, "leaseExpiresAt", "hardExpiresAt",
                 "sidebandOwnerInstanceHash", "sidebandOwnerTokenHash",
                 "sidebandOwnerLeaseExpiresAt", "sidebandOwnerEpoch",
                 "contextRevision", "contextDigest"
            FROM realtime_session_leases
           WHERE "companyId" = ${input.companyId}
             AND "sessionId" = ${input.sessionId}::uuid
           FOR UPDATE
        `;
        const [{ databaseNow }] = await tx.$queryRaw<Array<{ databaseNow: Date }>>`
          SELECT clock_timestamp() AS "databaseNow"
        `;
        if (!row || !databaseNow) return { status: 'unavailable' as const };
        if (
          row.state !== 'active'
          || row.leaseExpiresAt.getTime() <= databaseNow.getTime()
          || row.hardExpiresAt.getTime() <= databaseNow.getTime()
        ) return { status: 'rejected' as const };

        const currentToken = trimmed(row.sidebandOwnerTokenHash);
        const currentInstance = trimmed(row.sidebandOwnerInstanceHash);
        const currentLeaseLive = row.sidebandOwnerLeaseExpiresAt instanceof Date
          && row.sidebandOwnerLeaseExpiresAt.getTime() > databaseNow.getTime();
        if (currentLeaseLive && (
          currentToken !== input.candidateOwnerTokenHash
          || currentInstance !== input.ownerInstanceHash
        )) return { status: 'busy' as const };

        if (currentLeaseLive) {
          return acquired(input, { ...row, databaseNow });
        }
        if (row.sidebandOwnerEpoch >= POSTGRES_INT_MAX) return { status: 'unavailable' as const };

        const [updated] = await tx.$queryRaw<AcquiredRow[]>`
          UPDATE realtime_session_leases
             SET "sidebandOwnerInstanceHash" = ${input.ownerInstanceHash},
                 "sidebandOwnerTokenHash" = ${input.candidateOwnerTokenHash},
                 "sidebandOwnerLeaseExpiresAt" = LEAST(
                   clock_timestamp() + make_interval(secs => ${input.leaseSeconds}),
                   "leaseExpiresAt", "hardExpiresAt"
                 ),
                 "sidebandOwnerEpoch" = "sidebandOwnerEpoch" + 1,
                 "contextAppliedRevision" = NULL,
                 "contextAppliedDigest" = NULL,
                 "contextAppliedAt" = NULL,
                 "contextAppliedOwnerEpoch" = NULL,
                 "updatedAt" = clock_timestamp(),
                 version = version + 1
           WHERE "companyId" = ${input.companyId}
             AND "sessionId" = ${input.sessionId}::uuid
             AND state = 'active'
             AND "leaseExpiresAt" > clock_timestamp()
             AND "hardExpiresAt" > clock_timestamp()
             AND (
               "sidebandOwnerTokenHash" IS NULL
               OR "sidebandOwnerLeaseExpiresAt" <= clock_timestamp()
             )
          RETURNING "subjectHash", state, "leaseExpiresAt", "hardExpiresAt",
                    "sidebandOwnerInstanceHash", "sidebandOwnerTokenHash",
                    "sidebandOwnerLeaseExpiresAt", "sidebandOwnerEpoch",
                    "contextRevision", "contextDigest", clock_timestamp() AS "databaseNow"
        `;
        return updated ? acquired(input, updated) : { status: 'busy' as const };
      });
    } catch {
      return { status: 'unavailable' };
    }
  }

  async renew(
    owner: RealtimeSidebandOwnerIdentity,
    leaseSeconds: number,
  ): Promise<RealtimeSidebandOwnerMutationResult> {
    if (!isRealtimeSidebandOwnerIdentity(owner)
      || !Number.isSafeInteger(leaseSeconds)
      || leaseSeconds < 5
      || leaseSeconds > 300) return { status: 'rejected' };
    try {
      return await this.prisma.withTenant(owner.companyId, async (tx) => {
        const [row] = await tx.$queryRaw<Array<{ leaseExpiresAt: Date }>>`
          UPDATE realtime_session_leases
             SET "sidebandOwnerLeaseExpiresAt" = LEAST(
                   clock_timestamp() + make_interval(secs => ${leaseSeconds}),
                   "leaseExpiresAt", "hardExpiresAt"
                 ),
                 "updatedAt" = clock_timestamp(), version = version + 1
           WHERE ${this.ownerFence(owner)}
             AND state = 'active'
             AND "leaseExpiresAt" > clock_timestamp()
             AND "hardExpiresAt" > clock_timestamp()
             AND "sidebandOwnerLeaseExpiresAt" > clock_timestamp()
          RETURNING "sidebandOwnerLeaseExpiresAt" AS "leaseExpiresAt"
        `;
        return row
          ? { status: 'renewed' as const, leaseExpiresAt: row.leaseExpiresAt.toISOString() }
          : { status: 'lost' as const };
      });
    } catch {
      return { status: 'unavailable' };
    }
  }

  async applyContext(
    owner: RealtimeSidebandOwnerIdentity,
    context: RealtimeSidebandContextVersion,
  ): Promise<RealtimeSidebandOwnerMutationResult> {
    if (!isRealtimeSidebandOwnerIdentity(owner) || !isRealtimeSidebandContextVersion(context)) {
      return { status: 'rejected' };
    }
    try {
      return await this.prisma.withTenant(owner.companyId, async (tx) => {
        const [row] = await tx.$queryRaw<Array<{ revision: number }>>`
          UPDATE realtime_session_leases
             SET "contextAppliedRevision" = ${context.revision},
                 "contextAppliedDigest" = ${context.digest},
                 "contextAppliedAt" = clock_timestamp(),
                 "contextAppliedOwnerEpoch" = ${owner.ownerEpoch},
                 "updatedAt" = clock_timestamp(), version = version + 1
           WHERE ${this.ownerFence(owner)}
             AND state = 'active'
             AND "leaseExpiresAt" > clock_timestamp()
             AND "hardExpiresAt" > clock_timestamp()
             AND "sidebandOwnerLeaseExpiresAt" > clock_timestamp()
             AND "contextRevision" = ${context.revision}
             AND "contextDigest" = ${context.digest}
          RETURNING "contextAppliedRevision" AS revision
        `;
        if (row?.revision === context.revision) return { status: 'applied' as const };
        const [live] = await tx.$queryRaw<Array<{ currentRevision: number | null; currentDigest: string | null }>>`
          SELECT "contextRevision" AS "currentRevision", "contextDigest" AS "currentDigest"
            FROM realtime_session_leases
           WHERE ${this.ownerFence(owner)}
             AND state = 'active'
             AND "sidebandOwnerLeaseExpiresAt" > clock_timestamp()
        `;
        return live ? { status: 'stale_context' as const } : { status: 'lost' as const };
      });
    } catch {
      return { status: 'unavailable' };
    }
  }

  async readCurrentContext(owner: RealtimeSidebandOwnerIdentity): Promise<RealtimeSidebandOwnerContextResult> {
    if (!isRealtimeSidebandOwnerIdentity(owner)) return { status: 'lost' };
    try {
      return await this.prisma.withTenant(owner.companyId, async (tx) => {
        const [row] = await tx.$queryRaw<Array<{ revision: number; digest: string }>>`
          SELECT "contextRevision" AS revision, "contextDigest" AS digest
            FROM realtime_session_leases
           WHERE ${this.ownerFence(owner)}
             AND state = 'active'
             AND "leaseExpiresAt" > clock_timestamp()
             AND "hardExpiresAt" > clock_timestamp()
             AND "sidebandOwnerLeaseExpiresAt" > clock_timestamp()
             AND "contextRevision" = "contextAppliedRevision"
             AND "contextDigest" = "contextAppliedDigest"
             AND "contextAppliedOwnerEpoch" = "sidebandOwnerEpoch"
        `;
        const context = row && contextFromRow({ contextRevision: row.revision, contextDigest: row.digest });
        return context ? { status: 'current' as const, context } : { status: 'lost' as const };
      });
    } catch {
      return { status: 'unavailable' };
    }
  }

  async release(owner: RealtimeSidebandOwnerIdentity): Promise<RealtimeSidebandOwnerMutationResult> {
    if (!isRealtimeSidebandOwnerIdentity(owner)) return { status: 'rejected' };
    try {
      return await this.prisma.withTenant(owner.companyId, async (tx) => {
        const [row] = await tx.$queryRaw<Array<{ sidebandOwnerEpoch: number }>>`
          UPDATE realtime_session_leases
             SET "sidebandOwnerInstanceHash" = NULL,
                 "sidebandOwnerTokenHash" = NULL,
                 "sidebandOwnerLeaseExpiresAt" = NULL,
                 "contextAppliedRevision" = NULL,
                 "contextAppliedDigest" = NULL,
                 "contextAppliedAt" = NULL,
                 "contextAppliedOwnerEpoch" = NULL,
                 "updatedAt" = clock_timestamp(), version = version + 1
           WHERE ${this.ownerFence(owner)}
          RETURNING "sidebandOwnerEpoch"
        `;
        return row ? { status: 'released' as const } : { status: 'lost' as const };
      });
    } catch {
      return { status: 'unavailable' };
    }
  }

  private ownerFence(owner: RealtimeSidebandOwnerIdentity): Prisma.Sql {
    return Prisma.sql`
      "companyId" = ${owner.companyId}
      AND "subjectHash" = ${owner.subjectHash}
      AND "sessionId" = ${owner.sessionId}::uuid
      AND "sidebandOwnerInstanceHash" = ${owner.ownerInstanceHash}
      AND "sidebandOwnerTokenHash" = ${owner.ownerTokenHash}
      AND "sidebandOwnerEpoch" = ${owner.ownerEpoch}
    `;
  }
}
