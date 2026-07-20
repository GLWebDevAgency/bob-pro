import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../persistence/prisma/prisma.service';
import {
  isRealtimeVoiceUsageRepositoryInput,
  type RealtimeVoiceUsageRepositoryInput,
  type RealtimeVoiceUsageRepositoryPort,
  type RealtimeVoiceUsageRepositoryResult,
} from './realtime-voice-usage';

interface UsageRow {
  id: string;
  companyId: string;
  subjectHash: string;
  subjectKeyVersion: number;
  sessionId: string;
  turnId: string | null;
  dedupeKeyHmac: string;
  proofKeyVersion: number;
  plan: string;
  kind: string;
  source: string;
  amount: Prisma.Decimal;
  occurredAt: Date;
}

function trim(value: string): string {
  return value.trim();
}

function sameBinding(row: UsageRow, input: RealtimeVoiceUsageRepositoryInput): boolean {
  return row.companyId === input.companyId
    && trim(row.subjectHash) === input.subjectHash
    && row.subjectKeyVersion === input.subjectKeyVersion
    && row.sessionId === input.sessionId
    && row.turnId === input.turnId
    && trim(row.dedupeKeyHmac) === input.dedupeKeyHmac
    && row.proofKeyVersion === input.proofKeyVersion
    && row.plan === input.plan
    && row.kind === input.kind
    && row.source === input.source
    && row.amount.toFixed(6) === input.amount
    && row.occurredAt.toISOString() === input.occurredAt;
}

/** Insert append-only, tenant-scopé et idempotent. Le trigger SQL produit le rollup journalier. */
export class PrismaRealtimeVoiceUsageRepository implements RealtimeVoiceUsageRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: RealtimeVoiceUsageRepositoryInput): Promise<RealtimeVoiceUsageRepositoryResult> {
    if (!isRealtimeVoiceUsageRepositoryInput(input)) return { status: 'unavailable' };
    try {
      return await this.prisma.withTenant(input.companyId, async (tx) => {
        const inserted = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO realtime_voice_usage_events (
            id, "companyId", "subjectHash", "subjectKeyVersion", "sessionId", "turnId",
            "dedupeKeyHmac", "proofKeyVersion", plan, kind, source, amount,
            "occurredAt", "recordedAt", "retentionExpiresAt"
          ) VALUES (
            ${input.eventId}::uuid, ${input.companyId}, ${input.subjectHash}, ${input.subjectKeyVersion},
            ${input.sessionId}::uuid, ${input.turnId}::uuid, ${input.dedupeKeyHmac},
            ${input.proofKeyVersion}, ${input.plan}, ${input.kind}, ${input.source},
            ${input.amount}::numeric, ${new Date(input.occurredAt)}, ${new Date(input.recordedAt)},
            ${new Date(input.retentionExpiresAt)}
          )
          ON CONFLICT ("companyId", "dedupeKeyHmac") DO NOTHING
          RETURNING id
        `;
        if (inserted[0]?.id === input.eventId) return { status: 'recorded', eventId: input.eventId };

        const [existing] = await tx.$queryRaw<UsageRow[]>`
          SELECT id, "companyId" AS "companyId", "subjectHash" AS "subjectHash",
                 "subjectKeyVersion" AS "subjectKeyVersion", "sessionId" AS "sessionId",
                 "turnId" AS "turnId", "dedupeKeyHmac" AS "dedupeKeyHmac",
                 "proofKeyVersion" AS "proofKeyVersion", plan, kind, source, amount,
                 "occurredAt" AS "occurredAt"
            FROM realtime_voice_usage_events
           WHERE "companyId" = ${input.companyId}
             AND "dedupeKeyHmac" = ${input.dedupeKeyHmac}
           LIMIT 1
        `;
        if (!existing) return { status: 'unavailable' };
        return sameBinding(existing, input)
          ? { status: 'duplicate', eventId: existing.id }
          : { status: 'conflict' };
      });
    } catch {
      return { status: 'unavailable' };
    }
  }
}
