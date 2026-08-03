import { randomInt, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RealtimeVoiceTraceStoredEvent } from '../../voice/realtime/realtime-voice-trace.repository';
import { PrismaVoiceTraceRepository } from '../voice-traces';
import { PrismaRealtimeVoiceTraceRepository } from './realtime-voice-trace.prisma';
import { PrismaService } from './prisma.service';

const RUN_POSTGRES_CERT = process.env.RUN_POSTGRES_REALTIME_VOICE_TRACE_V2_CERT === 'true';
const CERT_DATABASE_KIND = process.env.REALTIME_VOICE_TRACE_V2_CERT_DATABASE_KIND;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const EPHEMERAL_DATABASE = /^bob_ephemeral_[a-z0-9_]{1,48}$/u;

function certifiedEphemeralTarget(url: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${label} must be a canonical PostgreSQL URL.`);
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//u, ''));
  if (!LOOPBACK_HOSTS.has(parsed.hostname) || !EPHEMERAL_DATABASE.test(databaseName)) {
    throw new Error(
      `${label} must target loopback and a bob_ephemeral_* database; mutation certification refused.`,
    );
  }
  return databaseName;
}

if (RUN_POSTGRES_CERT) {
  if (CERT_DATABASE_KIND !== 'ephemeral') {
    throw new Error(
      'REALTIME_VOICE_TRACE_V2_CERT_DATABASE_KIND=ephemeral is required: mutation certification refused.',
    );
  }
  const runtimeDatabase = certifiedEphemeralTarget(process.env.DATABASE_URL ?? '', 'DATABASE_URL');
  const directDatabase = certifiedEphemeralTarget(process.env.DIRECT_URL ?? '', 'DIRECT_URL');
  if (runtimeDatabase !== directDatabase) {
    throw new Error('DATABASE_URL and DIRECT_URL must target the same ephemeral database.');
  }
}

function company(id: string, discriminator: number) {
  const siren = String(randomInt(100_000_000, 999_999_999));
  return {
    id,
    name: `Realtime trace V2 certification ${discriminator}`,
    legalForm: 'EI' as const,
    siren,
    siret: `${siren}${String(discriminator).padStart(5, '0')}`,
    trade: 'certification',
    vatRegime: 'reel_normal' as const,
    addrLine1: `${discriminator} rue de la Certification`,
    addrZip: '75001',
    addrCity: 'Paris',
  };
}

function storedSessionReady(input: {
  readonly companyId: string;
  readonly userId: string;
  readonly sessionHandle: string;
  readonly traceAttemptId?: string;
  readonly id?: string;
}): RealtimeVoiceTraceStoredEvent {
  const id = input.id ?? randomUUID();
  return {
    id,
    event: {
      version: 1,
      companyId: input.companyId,
      userId: input.userId,
      traceAttemptId: input.traceAttemptId ?? randomUUID(),
      sessionHandle: input.sessionHandle,
      ownerEpoch: 1,
      eventOrdinal: 1,
      eventKind: 'session_ready',
      occurredAt: new Date().toISOString(),
      provider: 'openai',
      transport: 'webrtc',
      speechDelivery: 'openai-native-webrtc-v1',
      realtimeModel: 'gpt-realtime-2.1',
      outcome: 'ready',
    },
    eventDigest: 'a'.repeat(64),
    eventDigestKeyVersion: 1,
    encryptionKeyVersion: null,
    transcriptCiphertext: null,
    canonicalReplyCiphertext: null,
  };
}

function storedSessionClosed(input: {
  readonly companyId: string;
  readonly userId: string;
  readonly sessionHandle: string;
  readonly closeReason: 'user' | 'policy';
}): RealtimeVoiceTraceStoredEvent {
  return {
    id: randomUUID(),
    event: {
      version: 1,
      companyId: input.companyId,
      userId: input.userId,
      traceAttemptId: randomUUID(),
      sessionHandle: input.sessionHandle,
      ownerEpoch: 1,
      eventOrdinal: 1,
      eventKind: 'session_closed',
      occurredAt: new Date().toISOString(),
      outcome: 'closed',
      sessionCloseReason: input.closeReason,
    },
    eventDigest: input.closeReason === 'user' ? 'e'.repeat(64) : 'f'.repeat(64),
    eventDigestKeyVersion: 1,
    encryptionKeyVersion: null,
    transcriptCiphertext: null,
    canonicalReplyCiphertext: null,
  };
}

const TRANSCRIPT_CIPHERTEXT = `v1.${'A'.repeat(16)}.${'B'.repeat(8)}.${'C'.repeat(22)}`;
const REPLY_CIPHERTEXT = `v1.${'D'.repeat(16)}.${'E'.repeat(8)}.${'F'.repeat(22)}`;

function storedTranscript(input: {
  readonly companyId: string;
  readonly userId: string;
  readonly sessionHandle: string;
  readonly traceAttemptId: string;
  readonly turnId: string;
}): RealtimeVoiceTraceStoredEvent {
  return {
    id: randomUUID(),
    event: {
      version: 1,
      companyId: input.companyId,
      userId: input.userId,
      traceAttemptId: input.traceAttemptId,
      sessionHandle: input.sessionHandle,
      ownerEpoch: 1,
      eventOrdinal: 2,
      turnId: input.turnId,
      eventKind: 'turn_transcript_final',
      occurredAt: new Date().toISOString(),
      contextRevision: 1,
      contextDigest: '1'.repeat(64),
      stage: 'transcription',
      outcome: 'ready',
    },
    eventDigest: 'b'.repeat(64),
    eventDigestKeyVersion: 1,
    encryptionKeyVersion: 1,
    transcriptCiphertext: TRANSCRIPT_CIPHERTEXT,
    canonicalReplyCiphertext: null,
  };
}

function storedAgentResult(input: {
  readonly companyId: string;
  readonly userId: string;
  readonly sessionHandle: string;
  readonly traceAttemptId: string;
  readonly turnId: string;
}): RealtimeVoiceTraceStoredEvent {
  return {
    id: randomUUID(),
    event: {
      version: 1,
      companyId: input.companyId,
      userId: input.userId,
      traceAttemptId: input.traceAttemptId,
      sessionHandle: input.sessionHandle,
      ownerEpoch: 1,
      eventOrdinal: 3,
      turnId: input.turnId,
      eventKind: 'turn_agent_result',
      occurredAt: new Date().toISOString(),
      contextRevision: 1,
      contextDigest: '1'.repeat(64),
      runKind: 'answer',
      controlKind: 'none',
      stage: 'agent',
      outcome: 'ready',
    },
    eventDigest: 'c'.repeat(64),
    eventDigestKeyVersion: 1,
    encryptionKeyVersion: 1,
    transcriptCiphertext: null,
    canonicalReplyCiphertext: REPLY_CIPHERTEXT,
  };
}

describe.skipIf(!RUN_POSTGRES_CERT)(
  'Realtime Voice Trace V2 — certification PostgreSQL/RLS réelle',
  () => {
    const suffix = randomUUID().replaceAll('-', '');
    const companyId = `trace-v2-${suffix}`;
    const otherCompanyId = `trace-v2-other-${suffix}`;
    const userId = randomUUID();
    const otherUserId = randomUUID();
    const thirdUserId = randomUUID();
    const erasureUserId = randomUUID();
    const runtimeUrl = process.env.DATABASE_URL ?? '';
    const directUrl = process.env.DIRECT_URL ?? '';
    let admin: PrismaClient;
    let runtime: PrismaService;
    let repository: PrismaRealtimeVoiceTraceRepository;
    let deployerActor: string;

    async function withoutUserTriggers(
      work: (transaction: Prisma.TransactionClient) => Promise<void>,
    ): Promise<void> {
      await admin.$transaction(async (transaction) => {
        // Le harnais est strictement borné à la base éphémère loopback certifiée ci-dessus.
        // Supabase accorde ce SET au déployeur ; il permet de vieillir/retirer les fixtures sans
        // affaiblir les triggers du schéma réellement livré.
        await transaction.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
        await work(transaction);
      });
    }

    async function readSession(input: {
      readonly companyId: string;
      readonly userId: string;
      readonly sessionHandle: string;
      readonly requestId?: string;
      readonly includeContent?: boolean;
    }) {
      const requestId = input.requestId ?? randomUUID();
      const rows = await admin.$transaction(async (transaction) => {
        // Le CLI staging appelle la SECURITY DEFINER avec le role deployeur. Ne pas SET ROLE
        // ici : ce test doit casser si le GRANT staging manque, meme si l'owner interne reste sain.
        return transaction.$queryRaw<
          Array<{
            id: string;
            traceAttemptId: string;
            sessionHandle: string;
            ownerEpoch: number;
            eventOrdinal: number;
            eventKind: string;
            turnId: string | null;
            contextRevision: number | null;
            contextDigest: string | null;
            speechDelivery: string | null;
            stage: string | null;
            outcome: string | null;
            sessionCloseReason: string | null;
            transcriptCiphertext: string | null;
            canonicalReplyCiphertext: string | null;
          }>
        >`
          SELECT trace.id,
                 trace."traceAttemptId",
                 trace."sessionHandle",
                 trace."ownerEpoch",
                 trace."eventOrdinal",
                 trace."eventKind",
                 trace."turnId",
                 trace."contextRevision",
                 trace."contextDigest",
                 trace."speechDelivery",
                 trace.stage,
                 trace.outcome,
                 trace."sessionCloseReason",
                 trace."transcriptCiphertext",
                 trace."canonicalReplyCiphertext"
            FROM public.read_realtime_voice_trace_session_v3(
              ${requestId}::uuid,
              ${input.companyId},
              ${input.userId}::uuid,
              ${input.sessionHandle}::uuid,
              'investigate_staging_voice_failure',
              ${`CERT-${suffix.slice(0, 24)}`},
              ${input.includeContent ?? false}
            ) AS trace
        `;
      });
      return { requestId, rows };
    }

    async function insertFailureUnderOwner(input: {
      readonly ownerCompanyId: string;
      readonly ownerUserId: string;
      readonly rowCompanyId: string;
      readonly rowUserId: string;
    }): Promise<void> {
      await runtime.withIsolatedOwner(
        input.ownerCompanyId,
        input.ownerUserId,
        async (transaction) => {
          await transaction.$executeRaw`
            INSERT INTO public.realtime_voice_trace_events (
              id, "companyId", "userId", "traceAttemptId", "sessionHandle", "ownerEpoch",
              "eventOrdinal", "eventKind", "eventDigest", "eventDigestKeyVersion",
              "occurredAt", stage, outcome, "failureClass"
            ) VALUES (
              ${randomUUID()}::uuid,
              ${input.rowCompanyId},
              ${input.rowUserId}::uuid,
              ${randomUUID()}::uuid,
              ${randomUUID()}::uuid,
              0,
              1,
              'provider_failed',
              ${'d'.repeat(64)},
              1,
              pg_catalog.transaction_timestamp(),
              'provider_call',
              'failed',
              'provider_create_failed'
            )
          `;
        },
        { readOnly: false, maxWaitMs: 1_000, timeoutMs: 3_000 },
      );
    }

    async function traceTableOwnerIdentifier(): Promise<string> {
      const [owner] = await admin.$queryRaw<Array<{ roleName: string; canSet: boolean }>>`
        SELECT pg_catalog.pg_get_userbyid(relation.relowner) AS "roleName",
               pg_catalog.pg_has_role(current_user, relation.relowner, 'SET') AS "canSet"
          FROM pg_catalog.pg_class AS relation
         WHERE relation.oid = 'public.realtime_voice_trace_events'::regclass
      `;
      if (
        !owner ||
        !owner.canSet ||
        owner.roleName.length < 1 ||
        owner.roleName.length > 63 ||
        Array.from(owner.roleName).some((character) => {
          const codePoint = character.codePointAt(0);
          return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
        })
      ) {
        throw new Error('Realtime Voice Trace table owner is not an assumable PostgreSQL role.');
      }
      return `"${owner.roleName.replaceAll('"', '""')}"`;
    }

    async function installClientCloseExpandState(): Promise<void> {
      const ownerIdentifier = await traceTableOwnerIdentifier();
      const [constraint] = await admin.$queryRaw<Array<{ definition: string; validated: boolean }>>`
        SELECT pg_catalog.pg_get_constraintdef(constraint_catalog.oid, TRUE) AS definition,
               constraint_catalog.convalidated AS validated
          FROM pg_catalog.pg_constraint AS constraint_catalog
         WHERE constraint_catalog.conrelid =
               'public.realtime_voice_trace_events'::regclass
           AND constraint_catalog.conname = 'realtime_voice_trace_close_reason_check'
      `;
      if (
        !constraint ||
        !constraint.validated ||
        !constraint.definition.startsWith('CHECK (') ||
        !constraint.definition.includes('automatic_failure') ||
        !constraint.definition.includes('lifecycle') ||
        !constraint.definition.includes('policy') ||
        constraint.definition.includes(';')
      ) {
        throw new Error('Realtime Voice Trace final close-reason constraint is not canonical.');
      }

      await admin.$transaction(
        async (transaction) => {
          await transaction.$executeRawUnsafe(`SET LOCAL ROLE ${ownerIdentifier}`);
          await transaction.$executeRawUnsafe(`
            ALTER TABLE public.realtime_voice_trace_events
              DROP CONSTRAINT realtime_voice_trace_close_reason_check
          `);
          await transaction.$executeRawUnsafe(`
            ALTER TABLE public.realtime_voice_trace_events
              ADD CONSTRAINT realtime_voice_trace_close_reason_check_v2
              ${constraint.definition} NOT VALID
          `);
        },
        { timeout: 30_000 },
      );

      const [expanded] = await admin.$queryRaw<Array<{ validated: boolean }>>`
        SELECT constraint_catalog.convalidated AS validated
          FROM pg_catalog.pg_constraint AS constraint_catalog
         WHERE constraint_catalog.conrelid =
               'public.realtime_voice_trace_events'::regclass
           AND constraint_catalog.conname = 'realtime_voice_trace_close_reason_check_v2'
      `;
      expect(expanded).toEqual({ validated: false });
    }

    async function installClientCloseValidatedState(): Promise<void> {
      const ownerIdentifier = await traceTableOwnerIdentifier();
      await admin.$transaction(
        async (transaction) => {
          await transaction.$executeRawUnsafe(`SET LOCAL ROLE ${ownerIdentifier}`);
          await transaction.$executeRawUnsafe(`
            ALTER TABLE public.realtime_voice_trace_events
              VALIDATE CONSTRAINT realtime_voice_trace_close_reason_check_v2
          `);
          await transaction.$executeRawUnsafe(`
            ALTER TABLE public.realtime_voice_trace_events
              RENAME CONSTRAINT realtime_voice_trace_close_reason_check_v2
              TO realtime_voice_trace_close_reason_check
          `);
        },
        { timeout: 30_000 },
      );

      const [validated] = await admin.$queryRaw<Array<{ validated: boolean }>>`
        SELECT constraint_catalog.convalidated AS validated
          FROM pg_catalog.pg_constraint AS constraint_catalog
         WHERE constraint_catalog.conrelid =
               'public.realtime_voice_trace_events'::regclass
           AND constraint_catalog.conname = 'realtime_voice_trace_close_reason_check'
      `;
      expect(validated).toEqual({ validated: true });
    }

    beforeAll(async () => {
      if (!runtimeUrl || !directUrl) {
        throw new Error('DATABASE_URL (runtime) and DIRECT_URL (deployer) are required.');
      }
      admin = new PrismaClient({ datasourceUrl: directUrl, errorFormat: 'minimal' });
      runtime = new PrismaService({ datasourceUrl: runtimeUrl, errorFormat: 'minimal' });
      repository = new PrismaRealtimeVoiceTraceRepository(runtime);
      await Promise.all([admin.$connect(), runtime.$connect()]);
      const actorRows = await admin.$queryRaw<Array<{ actor: string }>>`
        SELECT session_user::text AS actor
      `;
      deployerActor = actorRows[0]?.actor ?? '';
      if (!deployerActor) throw new Error('Realtime trace deployer actor unavailable.');
      await admin.company.createMany({
        data: [company(companyId, 1), company(otherCompanyId, 2)],
      });
    }, 30_000);

    afterAll(async () => {
      if (admin) {
        await withoutUserTriggers(async (transaction) => {
          await transaction.realtimeVoiceTraceAccessAudit.deleteMany({
            where: { companyId: { in: [companyId, otherCompanyId] } },
          });
          await transaction.realtimeVoiceTraceEvent.deleteMany({
            where: { companyId: { in: [companyId, otherCompanyId] } },
          });
        }).catch(() => undefined);
        await admin.voiceTrace
          .deleteMany({
            where: { companyId: { in: [companyId, otherCompanyId] } },
          })
          .catch(() => undefined);
        await admin.company
          .deleteMany({
            where: { id: { in: [companyId, otherCompanyId] } },
          })
          .catch(() => undefined);
      }
      await Promise.allSettled([
        ...(runtime ? [runtime.$disconnect()] : []),
        ...(admin ? [admin.$disconnect()] : []),
      ]);
    });

    it('prouve readiness, append idempotent, RLS sujet et colonnes de contenu inaccessibles', async () => {
      const sessionHandle = randomUUID();
      const event = storedSessionReady({ companyId, userId, sessionHandle });

      await expect(repository.assertReady([1])).resolves.toBeUndefined();
      await expect(repository.append(event)).resolves.toEqual({
        status: 'inserted',
        eventId: event.id,
      });
      await expect(repository.append(event)).resolves.toEqual({
        status: 'existing',
        eventId: event.id,
        eventDigest: event.eventDigest,
        eventDigestKeyVersion: 1,
      });

      const ownerRows = await runtime.withIsolatedOwner(
        companyId,
        userId,
        (transaction) => transaction.$queryRaw<Array<{ id: string }>>`
          SELECT trace.id
            FROM public.realtime_voice_trace_events AS trace
           WHERE trace.id = ${event.id}::uuid
        `,
        { readOnly: true, maxWaitMs: 1_000, timeoutMs: 3_000 },
      );
      const otherUserRows = await runtime.withIsolatedOwner(
        companyId,
        otherUserId,
        (transaction) => transaction.$queryRaw<Array<{ id: string }>>`
          SELECT trace.id
            FROM public.realtime_voice_trace_events AS trace
           WHERE trace.id = ${event.id}::uuid
        `,
        { readOnly: true, maxWaitMs: 1_000, timeoutMs: 3_000 },
      );
      const otherTenantRows = await runtime.withIsolatedOwner(
        otherCompanyId,
        userId,
        (transaction) => transaction.$queryRaw<Array<{ id: string }>>`
          SELECT trace.id
            FROM public.realtime_voice_trace_events AS trace
           WHERE trace.id = ${event.id}::uuid
        `,
        { readOnly: true, maxWaitMs: 1_000, timeoutMs: 3_000 },
      );

      expect(ownerRows).toEqual([{ id: event.id }]);
      expect(otherUserRows).toEqual([]);
      expect(otherTenantRows).toEqual([]);
      await expect(
        runtime.withIsolatedOwner(
          companyId,
          userId,
          (transaction) => transaction.$queryRaw`
          SELECT trace."transcriptCiphertext"
            FROM public.realtime_voice_trace_events AS trace
           WHERE trace.id = ${event.id}::uuid
        `,
          { readOnly: true, maxWaitMs: 1_000, timeoutMs: 3_000 },
        ),
      ).rejects.toThrow(/permission denied for table realtime_voice_trace_events/u);

      await expect(
        insertFailureUnderOwner({
          ownerCompanyId: companyId,
          ownerUserId: otherUserId,
          rowCompanyId: companyId,
          rowUserId: userId,
        }),
      ).rejects.toThrow(/row-level security policy.*realtime_voice_trace_events/u);
      await expect(
        insertFailureUnderOwner({
          ownerCompanyId: otherCompanyId,
          ownerUserId: userId,
          rowCompanyId: companyId,
          rowUserId: userId,
        }),
      ).rejects.toThrow(/row-level security policy.*realtime_voice_trace_events/u);
      await expect(
        runtime.withIsolatedOwner(
          companyId,
          userId,
          (transaction) => transaction.$queryRaw`
          SELECT *
            FROM public.read_realtime_voice_trace_session_v2(
              ${randomUUID()}::uuid,
              ${companyId},
              ${userId}::uuid,
              ${sessionHandle}::uuid,
              'runtime_must_not_read',
              'CERT-RUNTIME-REFUSAL',
              FALSE
            )
        `,
          { readOnly: true, maxWaitMs: 1_000, timeoutMs: 3_000 },
        ),
      ).rejects.toThrow(/permission denied for function read_realtime_voice_trace_session_v2/u);
      await expect(
        runtime.withIsolatedOwner(
          companyId,
          userId,
          (transaction) => transaction.$queryRaw`
          SELECT *
            FROM public.read_realtime_voice_trace_session_v3(
              ${randomUUID()}::uuid,
              ${companyId},
              ${userId}::uuid,
              ${sessionHandle}::uuid,
              'runtime_must_not_read',
              'CERT-RUNTIME-REFUSAL',
              FALSE
            )
        `,
          { readOnly: true, maxWaitMs: 1_000, timeoutMs: 3_000 },
        ),
      ).rejects.toThrow(/permission denied for function read_realtime_voice_trace_session_v3/u);
    });

    it('lit un snapshot exact via la RPC, masque le contenu et audite chaque accès', async () => {
      const sessionHandle = randomUUID();
      const traceAttemptId = randomUUID();
      const turnId = randomUUID();
      const event = storedSessionReady({ companyId, userId, sessionHandle, traceAttemptId });
      const transcript = storedTranscript({
        companyId,
        userId,
        sessionHandle,
        traceAttemptId,
        turnId,
      });
      const agentResult = storedAgentResult({
        companyId,
        userId,
        sessionHandle,
        traceAttemptId,
        turnId,
      });
      await repository.append(event);
      await repository.append(transcript);
      await repository.append(agentResult);

      const read = await readSession({ companyId, userId, sessionHandle });
      expect(read.rows).toMatchObject([
        {
          id: event.id,
          eventOrdinal: 1,
          eventKind: 'session_ready',
          transcriptCiphertext: null,
          canonicalReplyCiphertext: null,
        },
        {
          id: transcript.id,
          eventOrdinal: 2,
          eventKind: 'turn_transcript_final',
          transcriptCiphertext: null,
          canonicalReplyCiphertext: null,
        },
        {
          id: agentResult.id,
          eventOrdinal: 3,
          eventKind: 'turn_agent_result',
          transcriptCiphertext: null,
          canonicalReplyCiphertext: null,
        },
      ]);
      expect(
        read.rows.map((row) => ({
          traceAttemptId: row.traceAttemptId,
          sessionHandle: row.sessionHandle,
          ownerEpoch: row.ownerEpoch,
          turnId: row.turnId,
          contextRevision: row.contextRevision,
          contextDigest: row.contextDigest,
          stage: row.stage,
          outcome: row.outcome,
        })),
      ).toEqual([
        {
          traceAttemptId,
          sessionHandle,
          ownerEpoch: 1,
          turnId: null,
          contextRevision: null,
          contextDigest: null,
          stage: null,
          outcome: 'ready',
        },
        {
          traceAttemptId,
          sessionHandle,
          ownerEpoch: 1,
          turnId,
          contextRevision: 1,
          contextDigest: '1'.repeat(64),
          stage: 'transcription',
          outcome: 'ready',
        },
        {
          traceAttemptId,
          sessionHandle,
          ownerEpoch: 1,
          turnId,
          contextRevision: 1,
          contextDigest: '1'.repeat(64),
          stage: 'agent',
          outcome: 'ready',
        },
      ]);
      const audit = await admin.realtimeVoiceTraceAccessAudit.findUniqueOrThrow({
        where: { requestId: read.requestId },
      });
      expect(audit).toMatchObject({
        companyId,
        subjectUserId: userId,
        sessionHandle,
        actor: deployerActor,
        reason: 'investigate_staging_voice_failure',
        includedContent: false,
        rowCount: 3,
      });

      const withContent = await readSession({
        companyId,
        userId,
        sessionHandle,
        includeContent: true,
      });
      expect(
        withContent.rows.map((row) => ({
          eventKind: row.eventKind,
          transcriptCiphertext: row.transcriptCiphertext,
          canonicalReplyCiphertext: row.canonicalReplyCiphertext,
        })),
      ).toEqual([
        {
          eventKind: 'session_ready',
          transcriptCiphertext: null,
          canonicalReplyCiphertext: null,
        },
        {
          eventKind: 'turn_transcript_final',
          transcriptCiphertext: TRANSCRIPT_CIPHERTEXT,
          canonicalReplyCiphertext: null,
        },
        {
          eventKind: 'turn_agent_result',
          transcriptCiphertext: null,
          canonicalReplyCiphertext: REPLY_CIPHERTEXT,
        },
      ]);
      await expect(
        admin.realtimeVoiceTraceAccessAudit.findUniqueOrThrow({
          where: { requestId: withContent.requestId },
        }),
      ).resolves.toMatchObject({
        actor: deployerActor,
        includedContent: true,
        rowCount: 3,
      });

      await expect(
        readSession({
          companyId,
          userId,
          sessionHandle,
          requestId: read.requestId,
        }),
      ).rejects.toMatchObject({
        code: 'P2010',
        meta: { code: '23505' },
      });
      await expect(
        admin.realtimeVoiceTraceAccessAudit.count({
          where: { requestId: read.requestId },
        }),
      ).resolves.toBe(1);
    });

    it('accepte exactement 1 000 événements séquentiels puis refuse 1 001 sans audit', async () => {
      const sessionHandle = randomUUID();
      const traceAttemptId = randomUUID();
      await runtime.withIsolatedOwner(
        companyId,
        userId,
        async (transaction) => {
          await transaction.$executeRaw`
          INSERT INTO public.realtime_voice_trace_events (
            id, "companyId", "userId", "traceAttemptId", "sessionHandle", "ownerEpoch",
            "eventOrdinal", "eventKind", "eventDigest", "eventDigestKeyVersion",
            "occurredAt", "contextRevision", "contextDigest", stage, outcome
          )
          SELECT pg_catalog.gen_random_uuid(),
                 ${companyId},
                 ${userId}::uuid,
                 ${traceAttemptId}::uuid,
                 ${sessionHandle}::uuid,
                 1,
                 ordinal,
                 'context_applied',
                 repeat('b', 64),
                 1,
                 pg_catalog.transaction_timestamp(),
                 ordinal,
                 repeat('1', 64),
                 'context',
                 'ready'
            FROM pg_catalog.generate_series(1, 1000) AS ordinal
          `;
        },
        { readOnly: false, maxWaitMs: 1_000, timeoutMs: 30_000 },
      );

      const exactBoundary = await readSession({ companyId, userId, sessionHandle });
      expect(exactBoundary.rows).toHaveLength(1_000);
      await expect(
        admin.realtimeVoiceTraceAccessAudit.findUniqueOrThrow({
          where: { requestId: exactBoundary.requestId },
        }),
      ).resolves.toMatchObject({ rowCount: 1_000 });

      await runtime.withIsolatedOwner(
        companyId,
        userId,
        async (transaction) => {
          await transaction.$executeRaw`
            INSERT INTO public.realtime_voice_trace_events (
              id, "companyId", "userId", "traceAttemptId", "sessionHandle", "ownerEpoch",
              "eventOrdinal", "eventKind", "eventDigest", "eventDigestKeyVersion",
              "occurredAt", "contextRevision", "contextDigest", stage, outcome
            ) VALUES (
              ${randomUUID()}::uuid,
              ${companyId},
              ${userId}::uuid,
              ${traceAttemptId}::uuid,
              ${sessionHandle}::uuid,
              1,
              1001,
              'context_applied',
              ${'b'.repeat(64)},
              1,
              pg_catalog.transaction_timestamp(),
              1001,
              ${'1'.repeat(64)},
              'context',
              'ready'
            )
          `;
        },
        { readOnly: false, maxWaitMs: 1_000, timeoutMs: 5_000 },
      );

      const requestId = randomUUID();
      await expect(
        readSession({
          companyId,
          userId,
          sessionHandle,
          requestId,
        }),
      ).rejects.toThrow(/realtime voice trace access row limit exceeded/u);
      await expect(
        admin.realtimeVoiceTraceAccessAudit.count({
          where: { requestId },
        }),
      ).resolves.toBe(0);
    }, 45_000);

    it('refuse UPDATE, DELETE et TRUNCATE sur les événements et leurs audits', async () => {
      const sessionHandle = randomUUID();
      const event = storedSessionReady({ companyId, userId: thirdUserId, sessionHandle });
      await repository.append(event);
      const audit = await readSession({
        companyId,
        userId: thirdUserId,
        sessionHandle,
      });

      await expect(
        admin.realtimeVoiceTraceEvent.update({
          where: { id: event.id },
          data: { outcome: 'failed' },
        }),
      ).rejects.toThrow(/append-only/u);
      await expect(
        admin.realtimeVoiceTraceEvent.delete({
          where: { id: event.id },
        }),
      ).rejects.toThrow(/delete authority rejected/u);
      await expect(
        admin.$executeRawUnsafe('TRUNCATE TABLE public.realtime_voice_trace_events'),
      ).rejects.toThrow(/append-only/u);

      await expect(
        admin.realtimeVoiceTraceAccessAudit.update({
          where: { requestId: audit.requestId },
          data: { rowCount: 0 },
        }),
      ).rejects.toThrow(/append-only/u);
      await expect(
        admin.realtimeVoiceTraceAccessAudit.delete({
          where: { requestId: audit.requestId },
        }),
      ).rejects.toThrow(/delete authority rejected/u);
      await expect(
        admin.$executeRawUnsafe('TRUNCATE TABLE public.realtime_voice_trace_access_audits'),
      ).rejects.toThrow(/append-only/u);
    });

    it('purge équitablement événements et audits expirés sans toucher les lignes vivantes', async () => {
      const expiredSessions = [randomUUID(), randomUUID(), randomUUID()];
      const liveSession = randomUUID();
      const expired = expiredSessions.map((sessionHandle) =>
        storedSessionReady({
          companyId,
          userId: otherUserId,
          sessionHandle,
        }),
      );
      const live = storedSessionReady({
        companyId,
        userId: thirdUserId,
        sessionHandle: liveSession,
      });
      for (const event of expired) await repository.append(event);
      await repository.append(live);
      const expiredAudit = await readSession({
        companyId,
        userId: otherUserId,
        sessionHandle: expiredSessions[0]!,
      });
      const liveAudit = await readSession({
        companyId,
        userId: thirdUserId,
        sessionHandle: liveSession,
      });

      await withoutUserTriggers(async (transaction) => {
        await transaction.realtimeVoiceTraceEvent.updateMany({
          where: { id: { in: expired.map((event) => event.id) } },
          data: {
            occurredAt: new Date('2026-01-01T00:00:00.000Z'),
            ingestedAt: new Date('2026-01-01T00:00:00.000Z'),
            retentionExpiresAt: new Date('2026-01-31T00:00:00.000Z'),
          },
        });
        await transaction.realtimeVoiceTraceAccessAudit.update({
          where: { requestId: expiredAudit.requestId },
          data: {
            accessedAt: new Date('2025-10-01T00:00:00.000Z'),
            retentionExpiresAt: new Date('2025-12-30T00:00:00.000Z'),
          },
        });
      });

      await expect(repository.purgeExpired(1)).rejects.toThrow(
        /Realtime Voice Trace V2 purge batch rejected/u,
      );
      await expect(repository.purgeExpired(1.5)).rejects.toThrow(
        /Realtime Voice Trace V2 purge batch rejected/u,
      );
      await expect(repository.purgeExpired(1_001)).rejects.toThrow(
        /Realtime Voice Trace V2 purge batch rejected/u,
      );
      await expect(repository.inspectLag()).resolves.toMatchObject({ due: 4 });
      await expect(repository.purgeExpired(2)).resolves.toBe(2);
      await expect(
        admin.realtimeVoiceTraceAccessAudit.findUnique({
          where: { requestId: expiredAudit.requestId },
        }),
      ).resolves.toBeNull();
      await expect(
        admin.realtimeVoiceTraceEvent.count({
          where: { id: { in: expired.map((event) => event.id) } },
        }),
      ).resolves.toBe(2);
      await expect(repository.inspectLag()).resolves.toMatchObject({ due: 2 });
      await expect(repository.purgeExpired(2)).resolves.toBe(2);
      await expect(repository.inspectLag()).resolves.toEqual({
        due: 0,
        oldestExpiredAt: null,
      });
      await expect(
        admin.realtimeVoiceTraceEvent.findUnique({
          where: { id: live.id },
        }),
      ).resolves.toBeTruthy();
      await expect(
        admin.realtimeVoiceTraceAccessAudit.findUnique({
          where: { requestId: liveAudit.requestId },
        }),
      ).resolves.toBeTruthy();
    });

    it('efface exactement un sujet et conserve les autres sujets et tenants', async () => {
      const erasedSession = randomUUID();
      const keptSession = randomUUID();
      const otherTenantSession = randomUUID();
      const erased = storedSessionReady({
        companyId,
        userId: erasureUserId,
        sessionHandle: erasedSession,
      });
      const kept = storedSessionReady({
        companyId,
        userId: otherUserId,
        sessionHandle: keptSession,
      });
      const otherTenant = storedSessionReady({
        companyId: otherCompanyId,
        userId: erasureUserId,
        sessionHandle: otherTenantSession,
      });
      await repository.append(erased);
      await repository.append(kept);
      await repository.append(otherTenant);
      const erasedAudit = await readSession({
        companyId,
        userId: erasureUserId,
        sessionHandle: erasedSession,
      });
      const keptAudit = await readSession({
        companyId,
        userId: otherUserId,
        sessionHandle: keptSession,
      });
      const otherTenantAudit = await readSession({
        companyId: otherCompanyId,
        userId: erasureUserId,
        sessionHandle: otherTenantSession,
      });

      await expect(
        repository.eraseInCurrentTransaction({
          companyId,
          userId: erasureUserId,
          reason: 'subject_erasure',
        }),
      ).rejects.toThrow(/caller transaction/u);
      await expect(
        runtime.withIsolatedOwner(
          otherCompanyId,
          erasureUserId,
          () =>
            repository.eraseInCurrentTransaction({
              companyId,
              userId: erasureUserId,
              reason: 'subject_erasure',
            }),
          { readOnly: false, maxWaitMs: 1_000, timeoutMs: 5_000 },
        ),
      ).rejects.toThrow(/realtime voice trace subject erasure rejected/u);
      await expect(
        runtime.withIsolatedOwner(
          companyId,
          erasureUserId,
          async () => {
            await repository.eraseInCurrentTransaction({
              companyId,
              userId: erasureUserId,
              reason: 'subject_erasure',
            });
            throw new Error('force_subject_erasure_rollback');
          },
          { readOnly: false, maxWaitMs: 1_000, timeoutMs: 5_000 },
        ),
      ).rejects.toThrow(/force_subject_erasure_rollback/u);
      await expect(
        admin.realtimeVoiceTraceEvent.count({
          where: { id: erased.id },
        }),
      ).resolves.toBe(1);
      await expect(
        admin.realtimeVoiceTraceAccessAudit.count({
          where: { requestId: erasedAudit.requestId },
        }),
      ).resolves.toBe(1);

      await expect(
        runtime.withIsolatedOwner(
          companyId,
          erasureUserId,
          () =>
            repository.eraseInCurrentTransaction({
              companyId,
              userId: erasureUserId,
              reason: 'subject_erasure',
            }),
          { readOnly: false, maxWaitMs: 1_000, timeoutMs: 5_000 },
        ),
      ).resolves.toEqual({ deletedEvents: 1, deletedAccessAudits: 1 });

      const [
        erasedCount,
        keptCount,
        otherTenantCount,
        erasedAuditCount,
        keptAuditCount,
        otherTenantAuditCount,
      ] = await Promise.all([
        admin.realtimeVoiceTraceEvent.count({ where: { id: erased.id } }),
        admin.realtimeVoiceTraceEvent.count({ where: { id: kept.id } }),
        admin.realtimeVoiceTraceEvent.count({ where: { id: otherTenant.id } }),
        admin.realtimeVoiceTraceAccessAudit.count({
          where: { requestId: erasedAudit.requestId },
        }),
        admin.realtimeVoiceTraceAccessAudit.count({
          where: { requestId: keptAudit.requestId },
        }),
        admin.realtimeVoiceTraceAccessAudit.count({
          where: { requestId: otherTenantAudit.requestId },
        }),
      ]);
      expect([erasedCount, keptCount, otherTenantCount]).toEqual([0, 1, 1]);
      expect([erasedAuditCount, keptAuditCount, otherTenantAuditCount]).toEqual([0, 1, 1]);
    });

    it('garde le writer Voice Trace N-1 fonctionnel sur le schéma final', async () => {
      const legacy = new PrismaVoiceTraceRepository(runtime);
      const id = `vtr_${randomUUID()}`;
      const now = new Date();
      await runtime.withTenant(companyId, () =>
        legacy.openTurn(companyId, {
          id,
          sessionId: randomUUID(),
          turnIndex: 1,
          userId,
          correlationId: randomUUID(),
          startedAt: now.toISOString(),
          transcript: 'Entretien vitrines demain',
          sttModel: 'gpt-4o-transcribe',
          transcriptionMs: 120,
          outcome: 'heard',
          level: 'info',
          reason: null,
          retentionExpiresAt: new Date(now.getTime() + 30 * 86_400_000).toISOString(),
        }),
      );
      await runtime.withTenant(companyId, () =>
        legacy.completeTurn(companyId, {
          id,
          planCorrelationId: randomUUID(),
          intent: 'create_customer',
          tool: 'start_customer_creation',
          toolArgs: { source: 'voice' },
          autonomy: 'proposed',
          llmModel: 'gpt-realtime-2.1',
          outcome: 'success',
          level: 'info',
          reason: null,
          reply: 'Je prépare le nouveau client.',
          ttsModel: 'gpt-realtime-2.1',
          planificationMs: 90,
          executionMs: 35,
          syntheseMs: 70,
          updatedAt: new Date().toISOString(),
        }),
      );

      await expect(admin.voiceTrace.findUnique({ where: { id } })).resolves.toMatchObject({
        id,
        companyId,
        outcome: 'success',
        intent: 'create_customer',
        reply: 'Je prépare le nouveau client.',
      });
    });

    it('garde le writer N-1 exact sous les états expand puis validate des motifs client', async () => {
      await installClientCloseExpandState();
      try {
        const legacyExpand = storedSessionClosed({
          companyId,
          userId,
          sessionHandle: randomUUID(),
          closeReason: 'user',
        });
        await expect(repository.append(legacyExpand)).resolves.toEqual({
          status: 'inserted',
          eventId: legacyExpand.id,
        });
      } finally {
        await installClientCloseValidatedState();
      }

      const legacyValidated = storedSessionClosed({
        companyId,
        userId,
        sessionHandle: randomUUID(),
        closeReason: 'user',
      });
      const policySessionHandle = randomUUID();
      const policy = storedSessionClosed({
        companyId,
        userId,
        sessionHandle: policySessionHandle,
        closeReason: 'policy',
      });
      await expect(repository.append(legacyValidated)).resolves.toEqual({
        status: 'inserted',
        eventId: legacyValidated.id,
      });
      await expect(repository.append(policy)).resolves.toEqual({
        status: 'inserted',
        eventId: policy.id,
      });
      const policyRead = await readSession({
        companyId,
        userId,
        sessionHandle: policySessionHandle,
      });
      expect(policyRead.rows).toMatchObject([{
        id: policy.id,
        eventKind: 'session_closed',
        sessionCloseReason: 'policy',
      }]);
      await expect(admin.realtimeVoiceTraceAccessAudit.count({
        where: { requestId: policyRead.requestId },
      })).resolves.toBe(1);
    });
  },
);
