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
