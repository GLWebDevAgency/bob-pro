import { PrismaService } from '../../persistence/prisma/prisma.service';
import {
  type RealtimeGlobalCapacityInspection,
  type RealtimeGlobalCapacityInspector,
  type RealtimeGlobalCapacityMode,
} from './realtime-capacity';
import { isRealtimeProviderId } from './realtime-admission';

interface CapacityRow {
  mode: string;
  providerId: string | null;
  providerModel: string | null;
  globalMaxSessions: number | null;
  providerMaxSessions: number | null;
  configVersion: number | null;
  retryAfterSeconds: number | null;
  usedSessions: number;
  revision: bigint;
  updatedAt: Date;
}

const MODES = new Set<RealtimeGlobalCapacityMode>(['tracking', 'closed', 'active']);

function validNullablePositive(value: number | null, max: number): boolean {
  return value === null || (Number.isInteger(value) && value >= 1 && value <= max);
}

function parseCapacityRow(row: CapacityRow | undefined): RealtimeGlobalCapacityInspection {
  if (
    !row
    || !MODES.has(row.mode as RealtimeGlobalCapacityMode)
    || (row.providerId !== null && !isRealtimeProviderId(row.providerId))
    || (row.providerModel !== null && (row.providerModel.length < 1 || row.providerModel.length > 100))
    || !validNullablePositive(row.globalMaxSessions, 1_000)
    || !validNullablePositive(row.providerMaxSessions, 10_000)
    || !validNullablePositive(row.configVersion, 2_147_483_647)
    || !validNullablePositive(row.retryAfterSeconds, 60)
    || !Number.isInteger(row.usedSessions)
    || row.usedSessions < 0
    || row.revision < 0n
    || !(row.updatedAt instanceof Date)
    || !Number.isFinite(row.updatedAt.getTime())
  ) return { ok: false, reason: 'unavailable' };

  return {
    ok: true,
    snapshot: {
      mode: row.mode as RealtimeGlobalCapacityMode,
      providerId: row.providerId,
      providerModel: row.providerModel,
      globalMaxSessions: row.globalMaxSessions,
      providerMaxSessions: row.providerMaxSessions,
      configVersion: row.configVersion,
      retryAfterSeconds: row.retryAfterSeconds,
      usedSessions: row.usedSessions,
      revision: row.revision,
      updatedAt: row.updatedAt.toISOString(),
    },
  };
}

export class PrismaRealtimeGlobalCapacityInspector implements RealtimeGlobalCapacityInspector {
  constructor(private readonly prisma: PrismaService) {}

  async inspect(): Promise<RealtimeGlobalCapacityInspection> {
    try {
      return await this.prisma.withIsolatedGlobal(async (tx) => {
        const [timeouts] = await tx.$queryRaw<Array<{
          statementTimeout: string;
          lockTimeout: string;
        }>>`
          SELECT set_config('statement_timeout', '2s', true) AS "statementTimeout",
                 set_config('lock_timeout', '750ms', true) AS "lockTimeout"
        `;
        if (timeouts?.statementTimeout !== '2s' || timeouts.lockTimeout !== '750ms') {
          return { ok: false, reason: 'unavailable' };
        }
        const rows = await tx.$queryRaw<CapacityRow[]>`
          SELECT mode, "providerId", "providerModel", "globalMaxSessions",
                 "providerMaxSessions", "configVersion", "retryAfterSeconds",
                 "usedSessions", revision, "updatedAt"
            FROM inspect_realtime_global_capacity_v1()
        `;
        return parseCapacityRow(rows[0]);
      }, { maxWaitMs: 1_000, timeoutMs: 3_000 });
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
  }
}
