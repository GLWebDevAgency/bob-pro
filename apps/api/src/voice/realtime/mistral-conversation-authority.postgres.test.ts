import { randomInt, randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import { MISTRAL_CONVERSATION_AUDIO_QUANTUM_BYTES } from '@bob/ai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../persistence/prisma/prisma.service';
import { PrismaMistralConversationDurableAuthority } from './mistral-conversation-authority.prisma';
import type {
  MistralConversationBootstrapGrant,
  MistralConversationDurableCommand,
  MistralConversationDurableOpenResult,
  MistralConversationDurableSnapshot,
  MistralConversationDurableTransitionResult,
} from './mistral-conversation-gateway-v2';
import type {
  MistralConversationCompletionInput,
  MistralConversationCompletionResult,
  MistralConversationCompletionTransactionPort,
} from './mistral-conversation-completion';
import type { MistralConversationPersistenceKeyRing } from './mistral-conversation-outbox-seal';

const RUN_POSTGRES_CERT = process.env.RUN_POSTGRES_MISTRAL_CONVERSATION_CERT === 'true';
const SUBJECT_HASH = 'd'.repeat(64);
const CONTEXT_DIGEST = 'a'.repeat(64);
const OPEN_MAX_EVENTS = 256;
const OPEN_MAX_BYTES = 240 * 1024;
const LIVE_MAX_EVENTS = 253;
const LIVE_MAX_BYTES = 192 * 1024;
const TRANSCRIPT = 'Deux heures de main-d’œuvre plomberie à cinquante-cinq euros.';

const keysV1: MistralConversationPersistenceKeyRing = {
  currentVersion: 1,
  secret: (version) => version === 1 ? new Uint8Array(32).fill(1) : null,
};

const keysV2WithoutV1: MistralConversationPersistenceKeyRing = {
  currentVersion: 2,
  secret: (version) => version === 2 ? new Uint8Array(32).fill(2) : null,
};

class CertificationCompletionPort implements MistralConversationCompletionTransactionPort {
  mode: MistralConversationCompletionResult['status'] = 'opened';
  readonly calls: MistralConversationCompletionInput[] = [];

  async authorizeAndOpen(
    tx: Prisma.TransactionClient,
    input: MistralConversationCompletionInput,
  ): Promise<MistralConversationCompletionResult> {
    this.calls.push(input);
    // Cette mutation certifie l'atomicité avec snapshot/outbox/ledger : un retour non-opened doit
    // annuler ce changement, et le replay idempotent ne doit jamais l'exécuter une seconde fois.
    await tx.$executeRaw`
      UPDATE companies
         SET trade = trade || ${'|delivery'}
       WHERE id = ${input.companyId}
    `;
    return { status: this.mode } as MistralConversationCompletionResult;
  }
}

function opened(
  result: MistralConversationDurableOpenResult,
): asserts result is Extract<MistralConversationDurableOpenResult, { readonly status: 'opened' }> {
  expect(result.status).toBe('opened');
  if (result.status !== 'opened') throw new Error(`Expected opened, received ${result.status}.`);
}

function applied(
  result: MistralConversationDurableTransitionResult,
): asserts result is Extract<
  MistralConversationDurableTransitionResult,
  { readonly status: 'applied' | 'replayed' }
> & { readonly status: 'applied' } {
  expect(result.status).toBe('applied');
  if (result.status !== 'applied') throw new Error(`Expected applied, received ${result.status}.`);
}

describe.skipIf(!RUN_POSTGRES_CERT)(
  'Bob Live Mistral conversation v2 — certification PostgreSQL/RLS réelle',
  () => {
    const suffix = randomUUID().replaceAll('-', '');
    const companyId = `mistral-v2-${suffix}`;
    const otherCompanyId = `mistral-v2-other-${suffix}`;
    const runtimeUrl = process.env.DATABASE_URL ?? '';
    const directUrl = process.env.DIRECT_URL ?? '';
    const completion = new CertificationCompletionPort();
    let admin: PrismaClient;
    let workers: [PrismaService, PrismaService];
    let authorities: [
      PrismaMistralConversationDurableAuthority,
      PrismaMistralConversationDurableAuthority,
    ];

    function company(id: string, discriminator: number) {
      const siren = String(randomInt(100_000_000, 999_999_999));
      return {
        id,
        name: `Mistral v2 PostgreSQL certification ${discriminator}`,
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

    function grant(label: string, tenant = companyId): MistralConversationBootstrapGrant {
      return {
        bootstrapId: randomUUID(),
        companyId: tenant,
        subjectHash: SUBJECT_HASH,
        subjectKeyVersion: 1,
        plan: 'pro',
        sessionHandle: `mistral_${suffix}_${label}`,
        hardExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        contextRevision: 1,
        contextDigest: CONTEXT_DIGEST,
        routeMode: 'push_to_talk',
        fullDuplexCertified: false,
        maxMissionAudioBytes: 320_000,
      };
    }

    function owner(label: string): string {
      return `owner_${label}_${randomUUID().replaceAll('-', '')}`;
    }

    async function openMission(
      authority: PrismaMistralConversationDurableAuthority,
      missionGrant: MistralConversationBootstrapGrant,
      ownerLeaseToken: string,
      resumeNextServerSequence = 0,
    ): Promise<MistralConversationDurableOpenResult> {
      return authority.open({
        grant: missionGrant,
        ownerLeaseToken,
        resumeNextServerSequence,
        maxReplayEvents: OPEN_MAX_EVENTS,
        maxReplayBytes: OPEN_MAX_BYTES,
        signal: new AbortController().signal,
      });
    }

    async function transition(
      authority: PrismaMistralConversationDurableAuthority,
      missionGrant: MistralConversationBootstrapGrant,
      ownerLeaseToken: string,
      snapshot: MistralConversationDurableSnapshot,
      command: MistralConversationDurableCommand,
    ): Promise<MistralConversationDurableTransitionResult> {
      return authority.transition({
        companyId: missionGrant.companyId,
        subjectHash: missionGrant.subjectHash,
        sessionHandle: missionGrant.sessionHandle,
        ownerLeaseToken,
        missionConnectionEpoch: snapshot.missionConnectionEpoch,
        expectedVersion: snapshot.version,
        maxUnacknowledgedEvents: LIVE_MAX_EVENTS,
        maxUnacknowledgedBytes: LIVE_MAX_BYTES,
        command,
        signal: new AbortController().signal,
      });
    }

    async function apply(
      authority: PrismaMistralConversationDurableAuthority,
      missionGrant: MistralConversationBootstrapGrant,
      ownerLeaseToken: string,
      snapshot: MistralConversationDurableSnapshot,
      command: MistralConversationDurableCommand,
    ): Promise<MistralConversationDurableSnapshot> {
      const result = await transition(authority, missionGrant, ownerLeaseToken, snapshot, command);
      applied(result);
      return result.snapshot;
    }

    interface MissionEvidence {
      readonly ownerTokenHash: string;
      readonly ownerAcquiredAt: Date;
      readonly missionConnectionEpoch: number;
      readonly version: bigint;
      readonly acknowledgedServerSequence: bigint;
      readonly nextServerSequence: bigint;
      readonly contextRevision: number;
      readonly contextDigest: string;
      readonly routeMode: string;
      readonly fullDuplexCertified: boolean;
      readonly phase: string;
      readonly terminalReason: string | null;
      readonly missionState: unknown;
      readonly turnState: unknown | null;
      readonly finalTranscriptRecorded: boolean;
      readonly outboxCount: number;
      readonly commandCount: number;
    }

    async function missionEvidence(sessionHandle: string): Promise<MissionEvidence> {
      const [evidence] = await admin.$queryRaw<MissionEvidence[]>`
        SELECT btrim(mission."ownerTokenHash") AS "ownerTokenHash",
               mission."ownerAcquiredAt", mission."missionConnectionEpoch", mission.version,
               mission."acknowledgedServerSequence", mission."nextServerSequence",
               mission."contextRevision", btrim(mission."contextDigest") AS "contextDigest",
               mission."routeMode", mission."fullDuplexCertified", mission.phase,
               mission."terminalReason", mission."missionState", mission."turnState",
               mission."finalTranscriptRecorded",
               (
                 SELECT count(*)::int
                   FROM realtime_mistral_conversation_outbox AS event
                  WHERE event."companyId" = mission."companyId"
                    AND event."missionId" = mission.id
               ) AS "outboxCount",
               (
                 SELECT count(*)::int
                   FROM realtime_mistral_conversation_commands AS command
                  WHERE command."companyId" = mission."companyId"
                    AND command."missionId" = mission.id
               ) AS "commandCount"
          FROM realtime_mistral_conversation_missions AS mission
         WHERE mission."companyId" = ${companyId}
           AND mission."sessionHandle" = ${sessionHandle}
      `;
      if (!evidence) throw new Error('Durable Mistral mission evidence missing.');
      return evidence;
    }

    async function waitForDatabaseTime(target: string): Promise<void> {
      const targetEpoch = Date.parse(target);
      if (!Number.isFinite(targetEpoch)) throw new Error('Invalid certification timestamp.');
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const [clock] = await admin.$queryRaw<Array<{ databaseNow: Date }>>`
          SELECT clock_timestamp() AS "databaseNow"
        `;
        if (clock && clock.databaseNow.getTime() >= targetEpoch) return;
        const remaining = Math.max(1, targetEpoch - (clock?.databaseNow.getTime() ?? Date.now()));
        await new Promise((resolve) => setTimeout(resolve, Math.min(remaining, 25)));
      }
      throw new Error('PostgreSQL clock did not reach the requested certification boundary.');
    }

    async function installOutboxBoundaryDelay(): Promise<void> {
      await admin.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION bob_test_delay_mistral_outbox_boundary()
        RETURNS trigger
        LANGUAGE plpgsql
        SET search_path = pg_catalog, public
        AS $function$
        BEGIN
          PERFORM pg_sleep(3);
          RETURN NEW;
        END;
        $function$
      `);
      await admin.$executeRawUnsafe(`
        DROP TRIGGER IF EXISTS bob_test_delay_mistral_outbox_boundary
        ON realtime_mistral_conversation_outbox
      `);
      await admin.$executeRawUnsafe(`
        CREATE TRIGGER bob_test_delay_mistral_outbox_boundary
        AFTER INSERT ON realtime_mistral_conversation_outbox
        FOR EACH ROW EXECUTE FUNCTION bob_test_delay_mistral_outbox_boundary()
      `);
    }

    async function removeOutboxBoundaryDelay(): Promise<void> {
      await admin.$executeRawUnsafe(`
        DROP TRIGGER IF EXISTS bob_test_delay_mistral_outbox_boundary
        ON realtime_mistral_conversation_outbox
      `);
      await admin.$executeRawUnsafe(`
        DROP FUNCTION IF EXISTS bob_test_delay_mistral_outbox_boundary()
      `);
    }

    beforeAll(async () => {
      if (!runtimeUrl || !directUrl) {
        throw new Error('DATABASE_URL (rôle runtime) et DIRECT_URL (admin) sont requis.');
      }
      admin = new PrismaClient({ datasourceUrl: directUrl });
      workers = [
        new PrismaService({ datasourceUrl: runtimeUrl }),
        new PrismaService({ datasourceUrl: runtimeUrl }),
      ];
      authorities = [
        new PrismaMistralConversationDurableAuthority(workers[0], completion, keysV1),
        new PrismaMistralConversationDurableAuthority(workers[1], completion, keysV1),
      ];
      await Promise.all([admin.$connect(), ...workers.map((worker) => worker.$connect())]);
      await admin.company.createMany({
        data: [company(companyId, 1), company(otherCompanyId, 2)],
      });
    }, 30_000);

    afterAll(async () => {
      try {
        if (admin) {
          await removeOutboxBoundaryDelay().catch(() => undefined);
          // Les tables sont append-only et protégées contre la suppression avant rétention. Le
          // bypass est strictement transactionnel et revient à `origin` avant la suppression des
          // sociétés, pour éviter la fuite de session_replication_role déjà rencontrée ailleurs.
          await admin.$transaction(async (tx) => {
            await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
            await tx.$executeRaw`
              DELETE FROM realtime_mistral_conversation_commands
               WHERE "companyId" IN (${companyId}, ${otherCompanyId})
            `;
            await tx.$executeRaw`
              DELETE FROM realtime_mistral_conversation_outbox
               WHERE "companyId" IN (${companyId}, ${otherCompanyId})
            `;
            await tx.$executeRaw`
              DELETE FROM realtime_mistral_conversation_missions
               WHERE "companyId" IN (${companyId}, ${otherCompanyId})
            `;
          }).catch(() => undefined);
          await admin.company.deleteMany({
            where: { id: { in: [companyId, otherCompanyId] } },
          }).catch(() => undefined);
        }
      } finally {
        await Promise.allSettled([
          ...((workers ?? []) as PrismaService[]).map((worker) => worker.$disconnect()),
          ...(admin ? [admin.$disconnect()] : []),
        ]);
      }
    });

    it('certifie migration, FORCE RLS, rôle runtime et création durable réelle', async () => {
      const [role] = await workers[0].$queryRaw<Array<{
        rolsuper: boolean;
        rolbypassrls: boolean;
      }>>`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
      expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
      const [privileges] = await workers[0].$queryRaw<Array<{
        missionDelete: boolean;
        outboxUpdate: boolean;
        outboxDelete: boolean;
        commandUpdate: boolean;
        commandDelete: boolean;
      }>>`
        SELECT has_table_privilege(
                 current_user, 'realtime_mistral_conversation_missions', 'DELETE'
               ) AS "missionDelete",
               has_table_privilege(
                 current_user, 'realtime_mistral_conversation_outbox', 'UPDATE'
               ) AS "outboxUpdate",
               has_table_privilege(
                 current_user, 'realtime_mistral_conversation_outbox', 'DELETE'
               ) AS "outboxDelete",
               has_table_privilege(
                 current_user, 'realtime_mistral_conversation_commands', 'UPDATE'
               ) AS "commandUpdate",
               has_table_privilege(
                 current_user, 'realtime_mistral_conversation_commands', 'DELETE'
               ) AS "commandDelete"
      `;
      expect(privileges).toEqual({
        missionDelete: false,
        outboxUpdate: false,
        outboxDelete: false,
        commandUpdate: false,
        commandDelete: false,
      });

      const shape = await admin.$queryRaw<Array<{
        tableName: string;
        rowSecurity: boolean;
        forceRowSecurity: boolean;
      }>>`
        SELECT relname AS "tableName", relrowsecurity AS "rowSecurity",
               relforcerowsecurity AS "forceRowSecurity"
          FROM pg_class
         WHERE oid IN (
           'realtime_mistral_conversation_missions'::regclass,
           'realtime_mistral_conversation_outbox'::regclass,
           'realtime_mistral_conversation_commands'::regclass
         )
         ORDER BY relname
      `;
      expect(shape).toEqual([
        {
          tableName: 'realtime_mistral_conversation_commands',
          rowSecurity: true,
          forceRowSecurity: true,
        },
        {
          tableName: 'realtime_mistral_conversation_missions',
          rowSecurity: true,
          forceRowSecurity: true,
        },
        {
          tableName: 'realtime_mistral_conversation_outbox',
          rowSecurity: true,
          forceRowSecurity: true,
        },
      ]);

      const missionGrant = grant('creation');
      const result = await openMission(authorities[0], missionGrant, owner('creation'));
      opened(result);
      expect(result.snapshot).toMatchObject({
        version: 1,
        missionConnectionEpoch: 1,
        acknowledgedServerSequence: 0,
        nextServerSequence: 1,
        mission: { phase: 'ready', sessionHandle: missionGrant.sessionHandle },
      });
      expect(result.events).toEqual([
        expect.objectContaining({ type: 'session.ready', serverSequence: 0 }),
      ]);

      const oversizedMissionId = randomUUID();
      const oversizedBootstrapId = randomUUID();
      const oversizedSessionHandle = `mistral_${suffix}_oversized_replay_grace`;
      const oversizedHardExpiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
      const oversizedReplayGraceExpiresAt = new Date(
        Date.parse(oversizedHardExpiresAt) + 7 * 24 * 60 * 60_000 + 1_000,
      ).toISOString();
      await expect(workers[0].withTenant(companyId, async (tx) => {
        await tx.$executeRaw`
          INSERT INTO realtime_mistral_conversation_missions (
            id, "companyId", "initialBootstrapId", protocol, "subjectHash",
            "subjectKeyVersion", plan, "sessionHandle", "ownerTokenHash",
            "missionConnectionEpoch", version, "acknowledgedServerSequence",
            "retainedFromServerSequence", "nextServerSequence", "nextProviderSequence",
            "contextRevision", "contextDigest", "routeMode", "fullDuplexCertified",
            "maxMissionAudioBytes", "missionState", "turnState", "audioBytes",
            "finalTranscriptRecorded", phase, "terminalReason", "terminalServerSequence",
            "ownerAcquiredAt", "closedAt", "hardExpiresAt", "replayGraceExpiresAt",
            "retentionExpiresAt", "createdAt", "updatedAt"
          )
          SELECT ${oversizedMissionId}::uuid, mission."companyId",
                 ${oversizedBootstrapId}::uuid, mission.protocol, mission."subjectHash",
                 mission."subjectKeyVersion", mission.plan, ${oversizedSessionHandle},
                 mission."ownerTokenHash", mission."missionConnectionEpoch", mission.version,
                 mission."acknowledgedServerSequence", mission."retainedFromServerSequence",
                 mission."nextServerSequence", mission."nextProviderSequence",
                 mission."contextRevision", mission."contextDigest", mission."routeMode",
                 mission."fullDuplexCertified", mission."maxMissionAudioBytes",
                 jsonb_set(
                   jsonb_set(
                     mission."missionState",
                     '{sessionHandle}',
                     to_jsonb(${oversizedSessionHandle}::text),
                     true
                   ),
                   '{expiresAt}',
                   to_jsonb(${oversizedHardExpiresAt}::text),
                   true
                 ),
                 mission."turnState", mission."audioBytes", mission."finalTranscriptRecorded",
                 mission.phase, mission."terminalReason", mission."terminalServerSequence",
                 statement_timestamp(), NULL, ${oversizedHardExpiresAt}::timestamptz,
                 ${oversizedReplayGraceExpiresAt}::timestamptz,
                 ${oversizedReplayGraceExpiresAt}::timestamptz,
                 statement_timestamp(), statement_timestamp()
            FROM realtime_mistral_conversation_missions AS mission
           WHERE mission."companyId" = ${companyId}
             AND mission."sessionHandle" = ${missionGrant.sessionHandle}
        `;
      })).rejects.toThrow(
        'realtime_mistral_conversation_missions_replay_grace_max_check',
      );

      const hidden = await workers[1].withTenant(otherCompanyId, async (tx) => {
        const [row] = await tx.$queryRaw<Array<{ count: number }>>`
          SELECT count(*)::int AS count
            FROM realtime_mistral_conversation_missions
           WHERE "companyId" = ${companyId}
        `;
        return row?.count ?? -1;
      });
      expect(hidden).toBe(0);
    }, 30_000);

    it('échoue fermé si la clé historique de l’outbox n’est plus disponible', async () => {
      const missionGrant = grant('missing_key');
      const created = await openMission(authorities[0], missionGrant, owner('missing_key_a'));
      opened(created);
      const authorityWithoutHistoricalKey = new PrismaMistralConversationDurableAuthority(
        workers[1],
        completion,
        keysV2WithoutV1,
      );

      await expect(openMission(
        authorityWithoutHistoricalKey,
        missionGrant,
        owner('missing_key_b'),
      )).resolves.toEqual({ status: 'history_unavailable' });

      const [persisted] = await admin.$queryRaw<Array<{ epoch: number; version: bigint }>>`
        SELECT "missionConnectionEpoch" AS epoch, version
          FROM realtime_mistral_conversation_missions
         WHERE "companyId" = ${companyId}
           AND "sessionHandle" = ${missionGrant.sessionHandle}
      `;
      expect(persisted).toEqual({ epoch: 1, version: 1n });
    });

    it('sérialise deux répliques, fence l’ancien owner et impose CAS + idempotence', async () => {
      const missionGrant = grant('concurrency');
      const attempts = [
        { authority: authorities[0], owner: owner('concurrency_a') },
        { authority: authorities[1], owner: owner('concurrency_b') },
      ] as const;
      const results = await Promise.all(attempts.map((attempt) => (
        openMission(attempt.authority, missionGrant, attempt.owner)
      )));
      expect(results.map((result) => result.status).sort()).toEqual(['opened', 'recovered']);
      const openedIndex = results.findIndex((result) => result.status === 'opened');
      const recoveredIndex = results.findIndex((result) => result.status === 'recovered');
      if (openedIndex < 0 || recoveredIndex < 0) throw new Error('Owner race outcomes missing.');
      const recovered = results[recoveredIndex];
      if (recovered?.status !== 'recovered') throw new Error('Recovered snapshot missing.');
      expect(recovered.snapshot.missionConnectionEpoch).toBe(2);

      const staleResult = await transition(
        attempts[openedIndex]!.authority,
        missionGrant,
        attempts[openedIndex]!.owner,
        recovered.snapshot,
        {
          type: 'record_error',
          commandId: 'error:stale-owner',
          errorCode: 'internal_error',
          retryable: true,
        },
      );
      expect(staleResult).toEqual({ status: 'not_owner' });

      const commands = [
        {
          type: 'record_error',
          commandId: 'error:cas-first',
          errorCode: 'internal_error',
          retryable: true,
        },
        {
          type: 'record_error',
          commandId: 'error:cas-second',
          errorCode: 'temporarily_unavailable',
          retryable: true,
        },
      ] as const satisfies readonly MistralConversationDurableCommand[];
      const freshOwner = attempts[recoveredIndex]!.owner;
      const concurrent = await Promise.all(authorities.map((authority, index) => (
        transition(authority, missionGrant, freshOwner, recovered.snapshot, commands[index]!)
      )));
      expect(concurrent.map((result) => result.status).sort()).toEqual(['applied', 'conflict']);
      const winnerIndex = concurrent.findIndex((result) => result.status === 'applied');
      if (winnerIndex < 0) throw new Error('CAS winner missing.');
      const winner = concurrent[winnerIndex];
      applied(winner!);

      const replay = await transition(
        authorities[1 - winnerIndex],
        missionGrant,
        freshOwner,
        recovered.snapshot,
        commands[winnerIndex]!,
      );
      expect(replay).toMatchObject({
        status: 'replayed',
        snapshot: { version: winner.snapshot.version },
        events: winner.events,
      });

      const divergent = {
        ...commands[winnerIndex]!,
        retryable: false,
      } satisfies MistralConversationDurableCommand;
      await expect(transition(
        authorities[0],
        missionGrant,
        freshOwner,
        recovered.snapshot,
        divergent,
      )).resolves.toEqual({ status: 'rejected', reason: 'invalid_state' });

      const routeOwner = owner('concurrency_route_change');
      const routeGrant: MistralConversationBootstrapGrant = {
        ...missionGrant,
        bootstrapId: randomUUID(),
        routeMode: 'full_duplex',
        fullDuplexCertified: true,
      };
      const routeRecovery = await openMission(
        authorities[0],
        routeGrant,
        routeOwner,
      );
      expect(routeRecovery.status).toBe('recovered');
      if (routeRecovery.status !== 'recovered') throw new Error('Route recovery missing.');
      expect(routeRecovery.snapshot).toMatchObject({
        missionConnectionEpoch: 3,
        mission: { routeMode: 'full_duplex', fullDuplexCertified: true },
      });
      await expect(transition(
        authorities[1],
        routeGrant,
        routeOwner,
        routeRecovery.snapshot,
        commands[winnerIndex]!,
      )).resolves.toEqual({ status: 'rejected', reason: 'invalid_state' });
    }, 30_000);

    it('fence à H toute mutation métier et toute écriture SQL directe sans effet collatéral', async () => {
      const hardExpiresAt = new Date(Date.now() + 1_200).toISOString();
      const missionGrant = { ...grant('hard_expiry_fence'), hardExpiresAt };
      const missionOwner = owner('hard_expiry_fence');
      const created = await openMission(authorities[0], missionGrant, missionOwner);
      opened(created);
      const before = await missionEvidence(missionGrant.sessionHandle);
      const completionCallsBefore = completion.calls.length;
      const tradeBefore = (await admin.company.findUniqueOrThrow({ where: { id: companyId } })).trade;

      await waitForDatabaseTime(hardExpiresAt);

      const clientTurnId = randomUUID();
      const turnId = `turn_${randomUUID().replaceAll('-', '')}`;
      const disallowed = [
        {
          type: 'start_turn',
          commandId: `start:expired:${clientTurnId}`,
          control: {
            type: 'turn.start',
            clientTurnId,
            contextRevision: 1,
            contextDigest: CONTEXT_DIGEST,
            vadStartedAtMs: 1_000,
            preRollMs: 160,
          },
          turnId,
          bargeInCancellationId: randomUUID(),
        },
        {
          type: 'ingest_audio',
          commandId: 'audio:expired:0',
          frame: {
            turnOrdinal: 1,
            audioSequence: 0,
            audioBytes: MISTRAL_CONVERSATION_AUDIO_QUANTUM_BYTES,
            audioSha256: 'f'.repeat(64),
          },
        },
        {
          type: 'commit_turn',
          commandId: 'commit:expired',
          control: {
            type: 'turn.commit',
            clientTurnId,
            lastAudioSequence: 0,
            vadEndedAtMs: 1_320,
          },
        },
        {
          type: 'cancel_turn',
          commandId: 'cancel:expired',
          control: {
            type: 'turn.cancel',
            clientTurnId,
            cancellationId: randomUUID(),
            reason: 'user',
          },
        },
        {
          type: 'fail_turn',
          commandId: 'fail:expired',
          turnId,
          cancellationId: randomUUID(),
          reason: 'timeout',
          errorCode: 'internal_error',
        },
        {
          type: 'record_transcript',
          commandId: 'transcript:expired:0',
          turnId,
          providerSequence: 0,
          text: TRANSCRIPT,
          final: true,
        },
        {
          type: 'advance_phase',
          commandId: 'phase:expired:reasoning',
          turnId,
          phase: 'reasoning',
        },
        {
          type: 'update_context',
          commandId: 'context:expired:2',
          control: {
            type: 'context.update',
            contextRevision: 2,
            contextDigest: 'b'.repeat(64),
          },
        },
        {
          type: 'record_error',
          commandId: 'error:expired:business',
          errorCode: 'internal_error',
          retryable: true,
        },
        {
          type: 'drain',
          commandId: 'drain:expired:user-reason-forbidden',
          reason: 'user',
          cancellationId: randomUUID(),
        },
      ] as const satisfies readonly MistralConversationDurableCommand[];

      for (const command of disallowed) {
        await expect(transition(
          authorities[0],
          missionGrant,
          missionOwner,
          created.snapshot,
          command,
        )).resolves.toEqual({ status: 'expired' });
      }
      expect(await missionEvidence(missionGrant.sessionHandle)).toEqual(before);
      expect(completion.calls).toHaveLength(completionCallsBefore);
      expect((await admin.company.findUniqueOrThrow({ where: { id: companyId } })).trade)
        .toBe(tradeBefore);

      const directDigest = 'c'.repeat(64);
      await expect(workers[0].withTenant(companyId, async (tx) => {
        await tx.$executeRaw`
          UPDATE realtime_mistral_conversation_missions
             SET version = version + 1,
                 "contextRevision" = "contextRevision" + 1,
                 "contextDigest" = ${directDigest},
                 "missionState" = jsonb_set(
                   jsonb_set(
                     "missionState",
                     '{contextRevision}',
                     to_jsonb(("contextRevision" + 1)::integer),
                     true
                   ),
                   '{contextDigest}',
                   to_jsonb(${directDigest}::text),
                   true
                 ),
                 "updatedAt" = clock_timestamp()
           WHERE "companyId" = ${companyId}
             AND "sessionHandle" = ${missionGrant.sessionHandle}
        `;
      })).rejects.toThrow();
      expect(await missionEvidence(missionGrant.sessionHandle)).toEqual(before);
    }, 30_000);

    it('rollbacke entièrement si H est franchi entre append outbox et CAS snapshot', async () => {
      const hardExpiresAt = new Date(Date.now() + 2_500).toISOString();
      const missionGrant = { ...grant('hard_expiry_append_race'), hardExpiresAt };
      const missionOwner = owner('hard_expiry_append_race');
      const created = await openMission(authorities[0], missionGrant, missionOwner);
      opened(created);
      await installOutboxBoundaryDelay();
      const before = await missionEvidence(missionGrant.sessionHandle);
      const [clock] = await admin.$queryRaw<Array<{ databaseNow: Date }>>`
        SELECT clock_timestamp() AS "databaseNow"
      `;
      expect(clock?.databaseNow.getTime()).toBeLessThan(Date.parse(hardExpiresAt));

      const startedAt = Date.now();
      try {
        await expect(transition(
          authorities[0],
          missionGrant,
          missionOwner,
          created.snapshot,
          {
            type: 'record_error',
            commandId: 'error:hard-expiry-append-race',
            errorCode: 'internal_error',
            retryable: true,
          },
        )).resolves.toEqual({ status: 'expired' });
      } finally {
        await removeOutboxBoundaryDelay();
      }

      // La durée prouve que l'INSERT a traversé le trigger AFTER INSERT avant que le CAS perde à H.
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2_900);
      expect(await missionEvidence(missionGrant.sessionHandle)).toEqual(before);
    }, 30_000);

    it('interdit après H une completion pourtant valide et rollbacke son side-effect', async () => {
      const hardExpiresAt = new Date(Date.now() + 5_000).toISOString();
      const missionGrant = { ...grant('hard_expiry_completion'), hardExpiresAt };
      const missionOwner = owner('hard_expiry_completion');
      const created = await openMission(authorities[0], missionGrant, missionOwner);
      opened(created);
      const clientTurnId = randomUUID();
      const turnId = `turn_${randomUUID().replaceAll('-', '')}`;
      let snapshot = created.snapshot;

      snapshot = await apply(authorities[0], missionGrant, missionOwner, snapshot, {
        type: 'start_turn',
        commandId: `start:expiry-completion:${clientTurnId}`,
        control: {
          type: 'turn.start',
          clientTurnId,
          contextRevision: 1,
          contextDigest: CONTEXT_DIGEST,
          vadStartedAtMs: 1_000,
          preRollMs: 160,
        },
        turnId,
        bargeInCancellationId: randomUUID(),
      });
      snapshot = await apply(authorities[0], missionGrant, missionOwner, snapshot, {
        type: 'ingest_audio',
        commandId: 'audio:expiry-completion:0',
        frame: {
          turnOrdinal: 1,
          audioSequence: 0,
          audioBytes: MISTRAL_CONVERSATION_AUDIO_QUANTUM_BYTES,
          audioSha256: 'f'.repeat(64),
        },
      });
      snapshot = await apply(authorities[0], missionGrant, missionOwner, snapshot, {
        type: 'commit_turn',
        commandId: 'commit:expiry-completion',
        control: {
          type: 'turn.commit',
          clientTurnId,
          lastAudioSequence: 0,
          vadEndedAtMs: 1_320,
        },
      });
      snapshot = await apply(authorities[0], missionGrant, missionOwner, snapshot, {
        type: 'record_transcript',
        commandId: 'transcript:expiry-completion:0',
        turnId,
        providerSequence: 0,
        text: TRANSCRIPT,
        final: true,
      });
      for (const phase of ['reasoning', 'rendering', 'delivering'] as const) {
        snapshot = await apply(authorities[0], missionGrant, missionOwner, snapshot, {
          type: 'advance_phase',
          commandId: `phase:expiry-completion:${phase}`,
          turnId,
          phase,
        });
      }

      const before = await missionEvidence(missionGrant.sessionHandle);
      const completionCallsBefore = completion.calls.length;
      const tradeBefore = (await admin.company.findUniqueOrThrow({ where: { id: companyId } })).trade;
      completion.mode = 'opened';
      await waitForDatabaseTime(hardExpiresAt);

      const result = await transition(
        authorities[1],
        missionGrant,
        missionOwner,
        snapshot,
        {
          type: 'complete_turn',
          commandId: 'complete:expiry-completion',
          turnId,
          missionConnectionEpoch: snapshot.missionConnectionEpoch,
          cancellationGeneration: snapshot.mission.cancellationGeneration,
          authorizationHandle: 'authorization_handle_expiry_certification',
          stagedDeliveryHandle: 'staged_delivery_handle_expiry_certification',
        },
      );
      expect(result).toEqual({ status: 'expired' });
      expect(completion.calls).toHaveLength(completionCallsBefore);
      expect((await admin.company.findUniqueOrThrow({ where: { id: companyId } })).trade)
        .toBe(tradeBefore);
      expect(await missionEvidence(missionGrant.sessionHandle)).toEqual(before);
    }, 30_000);

    it('terminalise une seule fois après H puis rejoue identiquement sans takeover', async () => {
      const hardExpiresAt = new Date(Date.now() + 1_200).toISOString();
      const missionGrant = { ...grant('hard_expiry_terminal_replay'), hardExpiresAt };
      const initialOwner = owner('hard_expiry_terminal_initial');
      const created = await openMission(authorities[0], missionGrant, initialOwner);
      opened(created);
      const before = await missionEvidence(missionGrant.sessionHandle);
      await waitForDatabaseTime(hardExpiresAt);

      const first = await openMission(
        authorities[0],
        { ...missionGrant, bootstrapId: randomUUID() },
        owner('hard_expiry_terminal_resume_a'),
      );
      expect(first.status).toBe('terminal_replay');
      if (first.status !== 'terminal_replay') throw new Error('Expired terminal replay missing.');
      expect(first.snapshot).toMatchObject({
        missionConnectionEpoch: before.missionConnectionEpoch,
        mission: {
          phase: 'closed',
          drainReason: 'expired',
          routeMode: before.routeMode,
          fullDuplexCertified: before.fullDuplexCertified,
          contextRevision: before.contextRevision,
          contextDigest: before.contextDigest,
        },
      });
      expect(first.events.map((event) => event.type)).toEqual([
        'session.ready',
        'session.draining',
        'session.closed',
      ]);
      expect(first.terminal).toMatchObject({
        missionConnectionEpoch: before.missionConnectionEpoch,
        reason: 'expired',
      });
      expect(Date.parse(first.terminal.replayGraceExpiresAt)).toBeGreaterThan(Date.parse(hardExpiresAt));

      const afterFirst = await missionEvidence(missionGrant.sessionHandle);
      expect(afterFirst).toMatchObject({
        ownerTokenHash: before.ownerTokenHash,
        ownerAcquiredAt: before.ownerAcquiredAt,
        missionConnectionEpoch: before.missionConnectionEpoch,
        routeMode: before.routeMode,
        fullDuplexCertified: before.fullDuplexCertified,
        contextRevision: before.contextRevision,
        contextDigest: before.contextDigest,
        phase: 'closed',
        terminalReason: 'expired',
      });

      const second = await openMission(
        authorities[1],
        { ...missionGrant, bootstrapId: randomUUID() },
        owner('hard_expiry_terminal_resume_b'),
      );
      expect(second.status).toBe('terminal_replay');
      if (second.status !== 'terminal_replay') throw new Error('Second expired terminal replay missing.');
      expect(second.events).toEqual(first.events);
      expect(second.terminal).toEqual(first.terminal);
      expect(second.snapshot).toEqual(first.snapshot);
      expect(await missionEvidence(missionGrant.sessionHandle)).toEqual(afterFirst);

      const terminalCounts = await admin.$queryRaw<Array<{ eventType: string; count: number }>>`
        SELECT "eventType", count(*)::int AS count
          FROM realtime_mistral_conversation_outbox
         WHERE "companyId" = ${companyId}
           AND "sessionHandle" = ${missionGrant.sessionHandle}
           AND "eventType" IN ('session.draining', 'session.closed')
         GROUP BY "eventType"
         ORDER BY "eventType"
      `;
      expect(terminalCounts).toEqual([
        { eventType: 'session.closed', count: 1 },
        { eventType: 'session.draining', count: 1 },
      ]);
    }, 30_000);

    it('annule canoniquement un tour actif à H avant le drain et la fermeture', async () => {
      const hardExpiresAt = new Date(Date.now() + 2_500).toISOString();
      const missionGrant = { ...grant('active_turn_expiry'), hardExpiresAt };
      const missionOwner = owner('active_turn_expiry');
      const created = await openMission(authorities[0], missionGrant, missionOwner);
      opened(created);
      const clientTurnId = randomUUID();
      const turnId = `turn_${randomUUID().replaceAll('-', '')}`;
      const started = await transition(
        authorities[0],
        missionGrant,
        missionOwner,
        created.snapshot,
        {
          type: 'start_turn',
          commandId: `start:${clientTurnId}`,
          control: {
            type: 'turn.start',
            clientTurnId,
            contextRevision: created.snapshot.mission.contextRevision,
            contextDigest: CONTEXT_DIGEST,
            vadStartedAtMs: 1_000,
            preRollMs: 160,
          },
          turnId,
          bargeInCancellationId: randomUUID(),
        },
      );
      applied(started);
      expect(started.snapshot.mission.phase).toBe('turn_active');
      await waitForDatabaseTime(hardExpiresAt);

      const terminal = await openMission(
        authorities[1],
        { ...missionGrant, bootstrapId: randomUUID() },
        owner('active_turn_expiry_resume'),
      );
      expect(terminal.status).toBe('terminal_replay');
      if (terminal.status !== 'terminal_replay') {
        throw new Error('Active turn terminal replay missing.');
      }
      expect(terminal.events.slice(-3).map((event) => event.type)).toEqual([
        'turn.cancelled',
        'session.draining',
        'session.closed',
      ]);
      expect(terminal.snapshot).toMatchObject({
        turn: null,
        missionConnectionEpoch: started.snapshot.missionConnectionEpoch,
        mission: {
          phase: 'closed',
          drainReason: 'expired',
          lastTerminalTurn: {
            clientTurnId,
            turnId,
            outcome: 'cancelled',
          },
        },
      });
      const cancellation = terminal.events.at(-3);
      expect(cancellation).toMatchObject({
        type: 'turn.cancelled',
        clientTurnId,
        turnId,
      });
      if (cancellation?.type !== 'turn.cancelled') {
        throw new Error('Canonical cancellation evidence missing.');
      }
      expect(terminal.snapshot.mission.lastTerminalTurn).toMatchObject({
        cancellationId: cancellation.cancellationId,
      });
    }, 30_000);

    it('conserve à H la raison user d’un drain déjà commité puis ferme exactement une fois', async () => {
      const hardExpiresAt = new Date(Date.now() + 2_500).toISOString();
      const missionGrant = { ...grant('user_drain_expiry'), hardExpiresAt };
      const missionOwner = owner('user_drain_expiry');
      const created = await openMission(authorities[0], missionGrant, missionOwner);
      opened(created);
      const drained = await transition(
        authorities[0],
        missionGrant,
        missionOwner,
        created.snapshot,
        {
          type: 'drain',
          commandId: 'drain:user:before-expiry',
          reason: 'user',
          cancellationId: randomUUID(),
        },
      );
      applied(drained);
      expect(drained.snapshot.mission).toMatchObject({
        phase: 'draining',
        drainReason: 'user',
      });
      const beforeExpiry = await missionEvidence(missionGrant.sessionHandle);
      await waitForDatabaseTime(hardExpiresAt);

      const terminal = await openMission(
        authorities[1],
        { ...missionGrant, bootstrapId: randomUUID() },
        owner('user_drain_expiry_resume'),
      );
      expect(terminal.status).toBe('terminal_replay');
      if (terminal.status !== 'terminal_replay') {
        throw new Error('User drain terminal replay missing.');
      }
      expect(terminal.events.at(-1)).toMatchObject({ type: 'session.closed', reason: 'user' });
      expect(terminal.snapshot).toMatchObject({
        missionConnectionEpoch: drained.snapshot.missionConnectionEpoch,
        mission: { phase: 'closed', drainReason: 'user' },
      });
      const afterExpiry = await missionEvidence(missionGrant.sessionHandle);
      expect(afterExpiry).toMatchObject({
        ownerTokenHash: beforeExpiry.ownerTokenHash,
        missionConnectionEpoch: beforeExpiry.missionConnectionEpoch,
        terminalReason: 'user',
        phase: 'closed',
        outboxCount: beforeExpiry.outboxCount + 1,
        commandCount: beforeExpiry.commandCount,
      });

      const replayed = await openMission(
        authorities[0],
        { ...missionGrant, bootstrapId: randomUUID() },
        owner('user_drain_expiry_replay'),
      );
      expect(replayed.status).toBe('terminal_replay');
      expect(await missionEvidence(missionGrant.sessionHandle)).toEqual(afterExpiry);
    }, 30_000);

    it('autorise après H uniquement l’ACK exact d’un snapshot fermé et le rejoue sans événement', async () => {
      const hardExpiresAt = new Date(Date.now() + 1_200).toISOString();
      const missionGrant = { ...grant('terminal_ack'), hardExpiresAt };
      const missionOwner = owner('terminal_ack');
      const created = await openMission(authorities[0], missionGrant, missionOwner);
      opened(created);
      await waitForDatabaseTime(hardExpiresAt);

      const terminal = await openMission(
        authorities[0],
        { ...missionGrant, bootstrapId: randomUUID() },
        owner('terminal_ack_resume'),
      );
      expect(terminal.status).toBe('terminal_replay');
      if (terminal.status !== 'terminal_replay') throw new Error('Terminal ACK fixture missing.');
      const beforeAck = await missionEvidence(missionGrant.sessionHandle);
      const ackCommand = {
        type: 'ack_events',
        commandId: `ack:${terminal.snapshot.missionConnectionEpoch}:${terminal.snapshot.nextServerSequence}`,
        control: {
          type: 'events.ack',
          missionConnectionEpoch: terminal.snapshot.missionConnectionEpoch,
          nextServerSequence: terminal.snapshot.nextServerSequence,
        },
      } as const satisfies MistralConversationDurableCommand;

      await expect(workers[0].withTenant(companyId, async (tx) => {
        await tx.$executeRaw`
          INSERT INTO realtime_mistral_conversation_commands (
            "companyId", "missionId", "sessionHandle", "commandIdHash", "commandType",
            "commandPayloadHmac", "proofKeyVersion", "missionConnectionEpoch",
            "snapshotVersionBefore", "snapshotVersionAfter", "firstServerSequence",
            "eventCount", "createdAt", "retentionExpiresAt"
          )
          SELECT mission."companyId", mission.id, mission."sessionHandle", ${'1'.repeat(64)},
                 'ack_events', ${'2'.repeat(64)}, 1, mission."missionConnectionEpoch",
                 mission.version - 1, mission.version, mission."nextServerSequence", 0,
                 clock_timestamp(), mission."retentionExpiresAt"
            FROM realtime_mistral_conversation_missions AS mission
           WHERE mission."companyId" = ${companyId}
             AND mission."sessionHandle" = ${missionGrant.sessionHandle}
        `;
      })).rejects.toThrow('terminal ACK commands are not persisted');
      expect(await missionEvidence(missionGrant.sessionHandle)).toEqual(beforeAck);

      const ack = await transition(
        authorities[1],
        missionGrant,
        missionOwner,
        terminal.snapshot,
        ackCommand,
      );
      applied(ack);
      expect(ack.events).toEqual([]);
      const afterAck = await missionEvidence(missionGrant.sessionHandle);
      expect(afterAck).toEqual({
        ...beforeAck,
        version: beforeAck.version + 1n,
        acknowledgedServerSequence: beforeAck.nextServerSequence,
      });

      const replayed = await transition(
        authorities[0],
        missionGrant,
        missionOwner,
        terminal.snapshot,
        ackCommand,
      );
      expect(replayed).toMatchObject({
        status: 'replayed',
        snapshot: { version: Number(afterAck.version) },
        events: [],
      });
      expect(await missionEvidence(missionGrant.sessionHandle)).toEqual(afterAck);
    }, 30_000);

    it('terminalise à H même si le curseur de reprise est invalide', async () => {
      const hardExpiresAt = new Date(Date.now() + 1_200).toISOString();
      const missionGrant = { ...grant('terminal_invalid_cursor'), hardExpiresAt };
      const initialOwner = owner('terminal_invalid_cursor_initial');
      const created = await openMission(authorities[0], missionGrant, initialOwner);
      opened(created);
      const before = await missionEvidence(missionGrant.sessionHandle);
      await waitForDatabaseTime(hardExpiresAt);

      await expect(openMission(
        authorities[1],
        { ...missionGrant, bootstrapId: randomUUID() },
        owner('terminal_invalid_cursor_resume'),
        999,
      )).resolves.toEqual({ status: 'invalid_cursor' });

      const terminalized = await missionEvidence(missionGrant.sessionHandle);
      expect(terminalized).toMatchObject({
        ownerTokenHash: before.ownerTokenHash,
        ownerAcquiredAt: before.ownerAcquiredAt,
        missionConnectionEpoch: before.missionConnectionEpoch,
        phase: 'closed',
        terminalReason: 'expired',
        outboxCount: 3,
      });
      const replay = await openMission(
        authorities[0],
        { ...missionGrant, bootstrapId: randomUUID() },
        owner('terminal_invalid_cursor_valid_resume'),
      );
      expect(replay.status).toBe('terminal_replay');
      if (replay.status !== 'terminal_replay') throw new Error('Terminal replay missing after bad cursor.');
      expect(replay.events.map((event) => event.type)).toEqual([
        'session.ready',
        'session.draining',
        'session.closed',
      ]);
      expect(await missionEvidence(missionGrant.sessionHandle)).toEqual(terminalized);
    }, 30_000);

    it('refuse open et toute mutation à G sans altérer la preuve retenue', async () => {
      const missionGrant = grant('replay_grace_elapsed');
      const missionOwner = owner('replay_grace_elapsed');
      const created = await openMission(authorities[0], missionGrant, missionOwner);
      opened(created);

      // Voyage temporel de fixture uniquement : les triggers sont suspendus par l'admin dans cette
      // transaction, mais toutes les CHECK restent actives. L'appel testé utilise ensuite le rôle
      // runtime réel, RLS forcée et `clock_timestamp()` non simulé.
      const shiftedCreatedAt = new Date(Date.now() - 120_000).toISOString();
      const shiftedOwnerAt = new Date(Date.now() - 119_000).toISOString();
      const shiftedHardExpiresAt = new Date(Date.now() - 90_000).toISOString();
      const shiftedReplayGraceExpiresAt = new Date(Date.now() - 30_000).toISOString();
      const shiftedRetentionExpiresAt = new Date(Date.now() + 60_000).toISOString();
      await admin.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
        await tx.$executeRaw`
          UPDATE realtime_mistral_conversation_missions
             SET "createdAt" = ${shiftedCreatedAt}::timestamptz,
                 "ownerAcquiredAt" = ${shiftedOwnerAt}::timestamptz,
                 "updatedAt" = ${shiftedOwnerAt}::timestamptz,
                 "hardExpiresAt" = ${shiftedHardExpiresAt}::timestamptz,
                 "replayGraceExpiresAt" = ${shiftedReplayGraceExpiresAt}::timestamptz,
                 "retentionExpiresAt" = ${shiftedRetentionExpiresAt}::timestamptz,
                 "missionState" = jsonb_set(
                   "missionState", '{expiresAt}', to_jsonb(${shiftedHardExpiresAt}::text), true
                 )
           WHERE "companyId" = ${companyId}
             AND "sessionHandle" = ${missionGrant.sessionHandle}
        `;
      });
      const shiftedGrant = { ...missionGrant, hardExpiresAt: shiftedHardExpiresAt };
      const before = await missionEvidence(missionGrant.sessionHandle);

      await expect(openMission(
        authorities[1],
        { ...shiftedGrant, bootstrapId: randomUUID() },
        owner('replay_grace_elapsed_resume'),
      )).resolves.toEqual({ status: 'expired' });
      await expect(transition(
        authorities[0],
        shiftedGrant,
        missionOwner,
        created.snapshot,
        {
          type: 'drain',
          commandId: 'drain:after-replay-grace',
          reason: 'expired',
          cancellationId: randomUUID(),
        },
      )).resolves.toEqual({ status: 'expired' });
      expect(await missionEvidence(missionGrant.sessionHandle)).toEqual(before);
    }, 30_000);

    it('rollbacke la terminalisation si G est franchi entre append terminal et CAS snapshot', async () => {
      const missionGrant = grant('replay_grace_append_race');
      const missionOwner = owner('replay_grace_append_race');
      const created = await openMission(authorities[0], missionGrant, missionOwner);
      opened(created);
      await installOutboxBoundaryDelay();

      const shiftedCreatedAt = new Date(Date.now() - 120_000).toISOString();
      const shiftedOwnerAt = new Date(Date.now() - 119_000).toISOString();
      const shiftedHardExpiresAt = new Date(Date.now() - 60_000).toISOString();
      const shiftedReplayGraceExpiresAt = new Date(Date.now() + 2_500).toISOString();
      const shiftedRetentionExpiresAt = new Date(Date.now() + 60_000).toISOString();
      await admin.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
        await tx.$executeRaw`
          UPDATE realtime_mistral_conversation_missions
             SET "createdAt" = ${shiftedCreatedAt}::timestamptz,
                 "ownerAcquiredAt" = ${shiftedOwnerAt}::timestamptz,
                 "updatedAt" = ${shiftedOwnerAt}::timestamptz,
                 "hardExpiresAt" = ${shiftedHardExpiresAt}::timestamptz,
                 "replayGraceExpiresAt" = ${shiftedReplayGraceExpiresAt}::timestamptz,
                 "retentionExpiresAt" = ${shiftedRetentionExpiresAt}::timestamptz,
                 "missionState" = jsonb_set(
                   "missionState", '{expiresAt}', to_jsonb(${shiftedHardExpiresAt}::text), true
                 )
           WHERE "companyId" = ${companyId}
             AND "sessionHandle" = ${missionGrant.sessionHandle}
        `;
      });
      const shiftedGrant = { ...missionGrant, hardExpiresAt: shiftedHardExpiresAt };
      const before = await missionEvidence(missionGrant.sessionHandle);
      const startedAt = Date.now();

      try {
        await expect(openMission(
          authorities[1],
          { ...shiftedGrant, bootstrapId: randomUUID() },
          owner('replay_grace_append_race_resume'),
        )).resolves.toEqual({ status: 'expired' });
      } finally {
        await removeOutboxBoundaryDelay();
      }

      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2_900);
      expect(await missionEvidence(missionGrant.sessionHandle)).toEqual(before);
    }, 30_000);

    it('terminalise en deux CAS une recovery qui ne tient plus dans la fenêtre live', async () => {
      const missionGrant = grant('terminal_fallback');
      const created = await openMission(
        authorities[0],
        missionGrant,
        owner('terminal_fallback_a'),
      );
      opened(created);

      const terminal = await authorities[1].open({
        grant: { ...missionGrant, bootstrapId: randomUUID() },
        ownerLeaseToken: owner('terminal_fallback_b'),
        resumeNextServerSequence: 0,
        maxReplayEvents: 5,
        maxReplayBytes: OPEN_MAX_BYTES,
        signal: new AbortController().signal,
      });
      expect(terminal.status).toBe('terminal_replay');
      if (terminal.status !== 'terminal_replay') throw new Error('Terminal fallback missing.');
      expect(terminal.snapshot).toMatchObject({
        version: 3,
        missionConnectionEpoch: 1,
        mission: { phase: 'closed', drainReason: 'fatal_error' },
      });
      expect(terminal.events.map((event) => event.type)).toEqual([
        'session.ready',
        'session.draining',
        'session.closed',
      ]);

      const terminalEvents = await admin.$queryRaw<Array<{ eventType: string; count: number }>>`
        SELECT "eventType", count(*)::int AS count
          FROM realtime_mistral_conversation_outbox
         WHERE "companyId" = ${companyId}
           AND "sessionHandle" = ${missionGrant.sessionHandle}
           AND "eventType" IN ('session.draining', 'session.closed')
         GROUP BY "eventType"
         ORDER BY "eventType"
      `;
      expect(terminalEvents).toEqual([
        { eventType: 'session.closed', count: 1 },
        { eventType: 'session.draining', count: 1 },
      ]);
    }, 30_000);

    it('chiffre le transcript et rend complete_turn atomique, rejouable et sans double effet', async () => {
      const missionGrant = grant('completion');
      const completionOwner = owner('completion');
      const created = await openMission(authorities[0], missionGrant, completionOwner);
      opened(created);
      const clientTurnId = randomUUID();
      const turnId = `turn_${randomUUID().replaceAll('-', '')}`;
      let snapshot = created.snapshot;

      snapshot = await apply(authorities[0], missionGrant, completionOwner, snapshot, {
        type: 'start_turn',
        commandId: `start:${clientTurnId}`,
        control: {
          type: 'turn.start',
          clientTurnId,
          contextRevision: 1,
          contextDigest: CONTEXT_DIGEST,
          vadStartedAtMs: 1_000,
          preRollMs: 160,
        },
        turnId,
        bargeInCancellationId: randomUUID(),
      });
      snapshot = await apply(authorities[0], missionGrant, completionOwner, snapshot, {
        type: 'ingest_audio',
        commandId: 'audio:completion:0',
        frame: {
          turnOrdinal: 1,
          audioSequence: 0,
          audioBytes: MISTRAL_CONVERSATION_AUDIO_QUANTUM_BYTES,
          audioSha256: 'e'.repeat(64),
        },
      });
      snapshot = await apply(authorities[0], missionGrant, completionOwner, snapshot, {
        type: 'commit_turn',
        commandId: 'commit:completion',
        control: {
          type: 'turn.commit',
          clientTurnId,
          lastAudioSequence: 0,
          vadEndedAtMs: 1_320,
        },
      });
      snapshot = await apply(authorities[0], missionGrant, completionOwner, snapshot, {
        type: 'record_transcript',
        commandId: 'transcript:completion:0',
        turnId,
        providerSequence: 0,
        text: TRANSCRIPT,
        final: true,
      });
      for (const phase of ['reasoning', 'rendering', 'delivering'] as const) {
        snapshot = await apply(authorities[0], missionGrant, completionOwner, snapshot, {
          type: 'advance_phase',
          commandId: `phase:completion:${phase}`,
          turnId,
          phase,
        });
      }

      const complete = {
        type: 'complete_turn',
        commandId: 'complete:completion',
        turnId,
        missionConnectionEpoch: snapshot.missionConnectionEpoch,
        cancellationGeneration: snapshot.mission.cancellationGeneration,
        authorizationHandle: 'authorization_handle_certification',
        stagedDeliveryHandle: 'staged_delivery_handle_certification',
      } satisfies MistralConversationDurableCommand;
      const beforeFailedCompletion = snapshot;
      completion.mode = 'context_stale';
      const rejected = await transition(
        authorities[0],
        missionGrant,
        completionOwner,
        beforeFailedCompletion,
        complete,
      );
      expect(rejected).toEqual({ status: 'rejected', reason: 'context_stale' });
      expect((await admin.company.findUniqueOrThrow({ where: { id: companyId } })).trade)
        .toBe('certification');

      const [rolledBack] = await admin.$queryRaw<Array<{
        version: bigint;
        nextServerSequence: bigint;
        completeCommands: number;
      }>>`
        SELECT mission.version, mission."nextServerSequence",
               count(command.*) FILTER (WHERE command."commandType" = 'complete_turn')::int
                 AS "completeCommands"
          FROM realtime_mistral_conversation_missions AS mission
          LEFT JOIN realtime_mistral_conversation_commands AS command
            ON command."companyId" = mission."companyId"
           AND command."missionId" = mission.id
         WHERE mission."companyId" = ${companyId}
           AND mission."sessionHandle" = ${missionGrant.sessionHandle}
         GROUP BY mission.id
      `;
      expect(rolledBack).toEqual({
        version: BigInt(beforeFailedCompletion.version),
        nextServerSequence: BigInt(beforeFailedCompletion.nextServerSequence),
        completeCommands: 0,
      });

      completion.mode = 'opened';
      const completed = await transition(
        authorities[1],
        missionGrant,
        completionOwner,
        beforeFailedCompletion,
        complete,
      );
      applied(completed);
      expect((await admin.company.findUniqueOrThrow({ where: { id: companyId } })).trade)
        .toBe('certification|delivery');

      const replay = await transition(
        authorities[0],
        missionGrant,
        completionOwner,
        beforeFailedCompletion,
        complete,
      );
      expect(replay.status).toBe('replayed');
      expect(completion.calls).toHaveLength(2);
      expect((await admin.company.findUniqueOrThrow({ where: { id: companyId } })).trade)
        .toBe('certification|delivery');

      const persisted = await admin.$queryRaw<Array<{
        ciphertext: Uint8Array;
        missionState: unknown;
        turnState: unknown | null;
      }>>`
        SELECT event."payloadCiphertext" AS ciphertext,
               mission."missionState" AS "missionState", mission."turnState" AS "turnState"
          FROM realtime_mistral_conversation_outbox AS event
          JOIN realtime_mistral_conversation_missions AS mission
            ON mission.id = event."missionId" AND mission."companyId" = event."companyId"
         WHERE event."companyId" = ${companyId}
           AND event."sessionHandle" = ${missionGrant.sessionHandle}
      `;
      expect(persisted.length).toBeGreaterThan(0);
      expect(persisted.some((row) => Buffer.from(row.ciphertext).includes(Buffer.from(TRANSCRIPT))))
        .toBe(false);
      expect(JSON.stringify(persisted.map(({ missionState, turnState }) => ({ missionState, turnState }))))
        .not.toContain(TRANSCRIPT);

      const forbiddenColumns = await admin.$queryRaw<Array<{ columnName: string }>>`
        SELECT lower(column_name) AS "columnName"
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name IN (
             'realtime_mistral_conversation_missions',
             'realtime_mistral_conversation_outbox',
             'realtime_mistral_conversation_commands'
           )
           AND lower(column_name) IN (
             'transcript', 'pcm', 'audio', 'ownerleasetoken', 'authorizationhandle',
             'stageddeliveryhandle', 'commandid'
           )
      `;
      expect(forbiddenColumns).toEqual([]);

      snapshot = completed.snapshot;
      snapshot = await apply(authorities[0], missionGrant, completionOwner, snapshot, {
        type: 'drain',
        commandId: 'drain:completion',
        reason: 'user',
        cancellationId: randomUUID(),
      });
      snapshot = await apply(authorities[1], missionGrant, completionOwner, snapshot, {
        type: 'close',
        commandId: 'close:completion',
      });
      expect(snapshot.mission.phase).toBe('closed');

      const terminalFirst = await openMission(authorities[0], missionGrant, owner('terminal_a'));
      const terminalSecond = await openMission(authorities[1], missionGrant, owner('terminal_b'));
      expect([terminalFirst.status, terminalSecond.status]).toEqual([
        'terminal_replay',
        'terminal_replay',
      ]);
      for (const terminal of [terminalFirst, terminalSecond]) {
        if (terminal.status !== 'terminal_replay') throw new Error('Terminal replay missing.');
        expect(terminal.events.filter((event) => event.type === 'session.closed')).toHaveLength(1);
        expect(terminal.terminal).toMatchObject({ reason: 'user' });
      }
      const [closedCount] = await admin.$queryRaw<Array<{ count: number }>>`
        SELECT count(*)::int AS count
          FROM realtime_mistral_conversation_outbox
         WHERE "companyId" = ${companyId}
           AND "sessionHandle" = ${missionGrant.sessionHandle}
           AND "eventType" = 'session.closed'
      `;
      expect(closedCount?.count).toBe(1);
    }, 60_000);
  },
);
