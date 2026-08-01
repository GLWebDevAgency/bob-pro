import { Prisma } from '@prisma/client';
import type {
  RealtimeVoiceTraceDeleteReason,
  RealtimeVoiceTraceAppendOutcome,
  RealtimeVoiceTraceAppendStore,
  RealtimeVoiceTraceRetention,
  RealtimeVoiceTraceStoredEvent,
  RealtimeVoiceTraceSubjectEraser,
} from '../../voice/realtime/realtime-voice-trace.repository';
import { PrismaService } from './prisma.service';

const TRACE_TRANSACTION_OPTIONS = Object.freeze({
  readOnly: false,
  maxWaitMs: 1_000,
  timeoutMs: 3_000,
});

interface RealtimeVoiceTraceReadinessRow {
  readonly rlsEnabled: boolean;
  readonly rlsForced: boolean;
  readonly canSelect: boolean;
  readonly canInsert: boolean;
  readonly canDelete: boolean;
  readonly canUpdate: boolean;
  readonly canTruncate: boolean;
  readonly updateTrigger: boolean;
  readonly truncateTrigger: boolean;
  readonly purgeFunction: boolean;
  readonly accessAuditRlsEnabled: boolean;
  readonly accessAuditRlsForced: boolean;
  readonly canSelectDigest: boolean;
  readonly canSelectTranscript: boolean;
  readonly canEraseSubject: boolean;
  readonly canPurge: boolean;
  readonly canInspectRetention: boolean;
}

function createManyRow(
  input: RealtimeVoiceTraceStoredEvent,
): Prisma.RealtimeVoiceTraceEventCreateManyInput {
  const event = input.event;
  return {
    id: input.id,
    companyId: event.companyId,
    userId: event.userId,
    traceAttemptId: event.traceAttemptId,
    sessionHandle: event.sessionHandle ?? null,
    ownerEpoch: event.ownerEpoch,
    eventOrdinal: event.eventOrdinal,
    turnId: event.turnId ?? null,
    eventKind: event.eventKind,
    eventDigest: input.eventDigest,
    eventDigestKeyVersion: input.eventDigestKeyVersion,
    occurredAt: new Date(event.occurredAt),
    durationMs: event.durationMs ?? null,
    contextRevision: event.contextRevision ?? null,
    contextDigest: event.contextDigest ?? null,
    provider: event.provider ?? null,
    transport: event.transport ?? null,
    speechDelivery: event.speechDelivery ?? null,
    realtimeModel: event.realtimeModel ?? null,
    plannerDisposition: event.plannerDisposition ?? null,
    plannerAuthority: event.plannerAuthority ?? null,
    plannerModel: event.plannerModel ?? null,
    plannerStepIndex: event.plannerStepIndex ?? null,
    plannerStepCount: event.plannerStepCount ?? null,
    plannerIntent: event.plannerIntent ?? null,
    missionKind: event.missionKind ?? null,
    runKind: event.runKind ?? null,
    controlKind: event.controlKind ?? null,
    stage: event.stage ?? null,
    outcome: event.outcome ?? null,
    failureClass: event.failureClass ?? null,
    interruptionReason: event.interruptionReason ?? null,
    sessionCloseReason: event.sessionCloseReason ?? null,
    encryptionKeyVersion: input.encryptionKeyVersion,
    transcriptCiphertext: input.transcriptCiphertext,
    canonicalReplyCiphertext: input.canonicalReplyCiphertext,
  };
}

export class PrismaRealtimeVoiceTraceRepository
  implements
    RealtimeVoiceTraceAppendStore,
    RealtimeVoiceTraceSubjectEraser,
    RealtimeVoiceTraceRetention
{
  constructor(private readonly prisma: PrismaService) {}

  async assertReady(configuredKeyVersions: readonly number[]): Promise<void> {
    if (
      configuredKeyVersions.length < 1 ||
      configuredKeyVersions.some((version) => !Number.isInteger(version) || version < 1) ||
      new Set(configuredKeyVersions).size !== configuredKeyVersions.length
    ) {
      throw new Error('Realtime Voice Trace V2 configured key versions rejected.');
    }
    const rows = await this.prisma.$queryRaw<RealtimeVoiceTraceReadinessRow[]>`
      SELECT
        trace.relrowsecurity AS "rlsEnabled",
        trace.relforcerowsecurity AS "rlsForced",
        has_table_privilege(current_user, trace.oid, 'SELECT') AS "canSelect",
        has_any_column_privilege(current_user, trace.oid, 'INSERT') AS "canInsert",
        has_table_privilege(current_user, trace.oid, 'DELETE') AS "canDelete",
        has_table_privilege(current_user, trace.oid, 'UPDATE') AS "canUpdate",
        has_table_privilege(current_user, trace.oid, 'TRUNCATE') AS "canTruncate",
        has_column_privilege(
          current_user, trace.oid, 'id', 'SELECT'
        ) AND has_column_privilege(
          current_user, trace.oid, 'companyId', 'SELECT'
        ) AND has_column_privilege(
          current_user, trace.oid, 'traceAttemptId', 'SELECT'
        ) AND has_column_privilege(
          current_user, trace.oid, 'eventOrdinal', 'SELECT'
        ) AND has_column_privilege(
          current_user, trace.oid, 'eventDigest', 'SELECT'
        ) AND has_column_privilege(
          current_user, trace.oid, 'eventDigestKeyVersion', 'SELECT'
        ) AS "canSelectDigest",
        has_column_privilege(
          current_user, trace.oid, 'transcriptCiphertext', 'SELECT'
        ) AS "canSelectTranscript",
        EXISTS (
          SELECT 1
            FROM pg_catalog.pg_trigger AS trigger
           WHERE trigger.tgrelid = trace.oid
             AND trigger.tgname = 'realtime_voice_trace_update_denied'
             AND NOT trigger.tgisinternal
             AND trigger.tgenabled <> 'D'
        ) AS "updateTrigger",
        EXISTS (
          SELECT 1
            FROM pg_catalog.pg_trigger AS trigger
           WHERE trigger.tgrelid = trace.oid
             AND trigger.tgname = 'realtime_voice_trace_truncate_denied'
             AND NOT trigger.tgisinternal
             AND trigger.tgenabled <> 'D'
        ) AS "truncateTrigger",
        pg_catalog.to_regprocedure(
          'public.purge_realtime_voice_trace_v2(integer)'
        ) IS NOT NULL AS "purgeFunction",
        access_audit.relrowsecurity AS "accessAuditRlsEnabled",
        access_audit.relforcerowsecurity AS "accessAuditRlsForced",
        has_function_privilege(
          current_user,
          'public.erase_realtime_voice_trace_subject_v2(text,uuid,text)'::regprocedure,
          'EXECUTE'
        ) AS "canEraseSubject",
        has_function_privilege(
          current_user,
          'public.purge_realtime_voice_trace_v2(integer)'::regprocedure,
          'EXECUTE'
        ) AS "canPurge",
        has_function_privilege(
          current_user,
          'public.inspect_realtime_voice_trace_retention_v2()'::regprocedure,
          'EXECUTE'
        ) AS "canInspectRetention"
      FROM pg_catalog.pg_class AS trace
      JOIN pg_catalog.pg_class AS access_audit
        ON access_audit.oid = pg_catalog.to_regclass(
          'public.realtime_voice_trace_access_audits'
        )
     WHERE trace.oid = pg_catalog.to_regclass('public.realtime_voice_trace_events')
    `;
    const row = rows[0];
    if (
      !row ||
      !row.rlsEnabled ||
      !row.rlsForced ||
      row.canSelect ||
      !row.canInsert ||
      row.canDelete ||
      row.canUpdate ||
      row.canTruncate ||
      !row.canSelectDigest ||
      row.canSelectTranscript ||
      !row.updateTrigger ||
      !row.truncateTrigger ||
      !row.purgeFunction ||
      !row.accessAuditRlsEnabled ||
      !row.accessAuditRlsForced ||
      !row.canEraseSubject ||
      !row.canPurge ||
      !row.canInspectRetention
    ) {
      throw new Error('Realtime Voice Trace V2 PostgreSQL readiness rejected.');
    }
    const configuredArray = Prisma.sql`ARRAY[${Prisma.join(configuredKeyVersions)}]::integer[]`;
    const keyRows = await this.prisma.$queryRaw<Array<{ ready: boolean }>>`
      SELECT public.assert_realtime_voice_trace_key_versions_v2(
        ${configuredArray}
      ) AS ready
    `;
    if (keyRows[0]?.ready !== true) {
      throw new Error('Realtime Voice Trace V2 retained key versions rejected.');
    }
  }

  append(input: RealtimeVoiceTraceStoredEvent): Promise<RealtimeVoiceTraceAppendOutcome> {
    return this.prisma.withIsolatedOwner(
      input.event.companyId,
      input.event.userId,
      async (transaction) => {
        await transaction.$executeRaw`SET LOCAL lock_timeout = '750ms'`;
        await transaction.$executeRaw`SET LOCAL statement_timeout = '2500ms'`;
        const inserted = await transaction.realtimeVoiceTraceEvent.createMany({
          data: [createManyRow(input)],
          skipDuplicates: true,
        });
        if (inserted.count === 1) return { status: 'inserted', eventId: input.id };
        const existing = await transaction.realtimeVoiceTraceEvent.findUnique({
          where: {
            realtime_voice_trace_attempt_ordinal: {
              companyId: input.event.companyId,
              traceAttemptId: input.event.traceAttemptId,
              eventOrdinal: input.event.eventOrdinal,
            },
          },
          select: { id: true, eventDigest: true, eventDigestKeyVersion: true },
        });
        if (!existing) return { status: 'unavailable' };
        return {
          status: 'existing',
          eventId: existing.id,
          eventDigest: existing.eventDigest,
          eventDigestKeyVersion: existing.eventDigestKeyVersion,
        };
      },
      TRACE_TRANSACTION_OPTIONS,
    );
  }

  async eraseInCurrentTransaction(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly reason: RealtimeVoiceTraceDeleteReason;
  }): Promise<{ readonly deletedEvents: number; readonly deletedAccessAudits: number }> {
    if (!this.prisma.inTransaction()) {
      throw new Error('Realtime Voice Trace V2 subject erasure requires the caller transaction.');
    }
    const transaction = this.prisma.client() as Prisma.TransactionClient;
    await transaction.$executeRaw`
      SELECT set_config('app.current_user_id', ${input.userId}, true)
    `;
    const rows = await transaction.$queryRaw<
      Array<{
        deletedEvents: number;
        deletedAccessAudits: number;
      }>
    >`
      SELECT
        erased."deletedEvents",
        erased."deletedAccessAudits"
      FROM public.erase_realtime_voice_trace_subject_v2(
        ${input.companyId},
        ${input.userId}::uuid,
        ${input.reason}
      ) AS erased
    `;
    const erased = rows[0];
    if (
      !erased ||
      !Number.isInteger(erased.deletedEvents) ||
      erased.deletedEvents < 0 ||
      !Number.isInteger(erased.deletedAccessAudits) ||
      erased.deletedAccessAudits < 0
    ) {
      throw new Error('Realtime Voice Trace V2 subject erasure result rejected.');
    }
    return erased;
  }

  async purgeExpired(batchLimit: number): Promise<number> {
    if (!Number.isInteger(batchLimit) || batchLimit < 2 || batchLimit > 1_000) {
      throw new Error('Realtime Voice Trace V2 purge batch rejected.');
    }
    return this.prisma.withIsolatedGlobal(
      async (transaction) => {
        const rows = await transaction.$queryRaw<Array<{ deletedCount: number }>>`
        SELECT public.purge_realtime_voice_trace_v2(
          ${batchLimit}::integer
        ) AS "deletedCount"
      `;
        const count = rows[0]?.deletedCount;
        if (!Number.isInteger(count) || (count as number) < 0 || (count as number) > batchLimit) {
          throw new Error('Realtime Voice Trace V2 purge result rejected.');
        }
        return count as number;
      },
      { maxWaitMs: 1_000, timeoutMs: 5_000 },
    );
  }

  async inspectLag(): Promise<{ readonly due: number; readonly oldestExpiredAt: string | null }> {
    return this.prisma.withIsolatedGlobal(
      async (transaction) => {
        const rows = await transaction.$queryRaw<
          Array<{
            due: number;
            oldestExpiredAt: Date | null;
          }>
        >`
        SELECT observation.due, observation."oldestExpiredAt"
          FROM public.inspect_realtime_voice_trace_retention_v2() AS observation
      `;
        const observation = rows[0];
        if (!observation || !Number.isInteger(observation.due) || observation.due < 0) {
          throw new Error('Realtime Voice Trace V2 retention observation rejected.');
        }
        return {
          due: observation.due,
          oldestExpiredAt: observation.oldestExpiredAt?.toISOString() ?? null,
        };
      },
      { maxWaitMs: 1_000, timeoutMs: 3_000 },
    );
  }
}
