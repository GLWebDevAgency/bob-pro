import { randomUUID } from 'node:crypto';
import {
  CancelQuoteAgentMission,
  GetActiveAgentMission,
  StartQuoteAgentMission,
  createEmptyQuoteDraftPayload,
  sha256Hex,
  type AgentMissionFingerprintPort,
  type AgentMissionOwner,
  type AgentMissionTransaction,
  type AgentMissionUnitOfWorkPort,
  type Instant,
} from '@bob/core';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaQuoteDraftSlotRepository } from './quote-draft-slots.repository';
import {
  PrismaAgentMissionDraftFence,
  PrismaAgentMissionUnitOfWork,
} from './agent-mission.persistence';
import { PrismaService } from './prisma.service';

const RUN_CERT = process.env.RUN_AGENT_MISSION_POSTGRES_CERT === 'true';
const DISPOSABLE = process.env.AGENT_MISSION_CERT_DATABASE_IS_DISPOSABLE === 'true';

const FINGERPRINTS: AgentMissionFingerprintPort = {
  sign(canonicalRequest) {
    return { keyVersion: 1, hmac: sha256Hex(`test-key:${canonicalRequest}`) };
  },
  matches(canonicalRequest, fingerprint) {
    if (fingerprint.keyVersion !== 1) return null;
    return fingerprint.hmac === sha256Hex(`test-key:${canonicalRequest}`);
  },
};

function ids() {
  return { newId: () => randomUUID() };
}

function emptyPayload(sessionId: string) {
  const result = createEmptyQuoteDraftPayload(sessionId);
  if (!result.ok) throw new Error(`invalid test payload:${result.error.code}`);
  return result.value;
}

function meaningfulPayload(sessionId: string) {
  const payload = emptyPayload(sessionId);
  return {
    ...payload,
    draft: {
      ...payload.draft,
      lineForm: {
        ...payload.draft.lineForm,
        label: 'Main-d’œuvre plomberie',
      },
    },
  };
}

function start(uow: AgentMissionUnitOfWorkPort) {
  return new StartQuoteAgentMission({
    unitOfWork: uow,
    fingerprints: FINGERPRINTS,
    ids: ids(),
  });
}

function cancel(uow: AgentMissionUnitOfWorkPort) {
  return new CancelQuoteAgentMission({
    unitOfWork: uow,
    fingerprints: FINGERPRINTS,
    ids: ids(),
  });
}

function faultAfterWrite(
  delegate: AgentMissionUnitOfWorkPort,
  failAtWrite: number,
): AgentMissionUnitOfWorkPort {
  return {
    readQuoteCreationOwner: (owner, work) => delegate.readQuoteCreationOwner(owner, work),
    runQuoteCreationOwner: (owner, work) => delegate.runQuoteCreationOwner(owner, async (tx) => {
      let writes = 0;
      const afterWrite = <T>(value: T): T => {
        writes += 1;
        if (writes === failAtWrite) throw new Error(`injected-write-${failAtWrite}`);
        return value;
      };
      const wrapped: AgentMissionTransaction = {
        databaseNow: () => tx.databaseNow(),
        missions: {
          findActive: (input) => tx.missions.findActive(input),
          findById: (input) => tx.missions.findById(input),
          findActiveForUpdate: (input) => tx.missions.findActiveForUpdate(input),
          findByIdForUpdate: (input) => tx.missions.findByIdForUpdate(input),
          insert: async (mission) => {
            await tx.missions.insert(mission);
            afterWrite(undefined);
          },
          updateCas: async (input) => afterWrite(await tx.missions.updateCas(input)),
        },
        events: {
          findByCommandId: (input) => tx.events.findByCommandId(input),
          append: async (event) => {
            await tx.events.append(event);
            afterWrite(undefined);
          },
        },
        quoteDrafts: {
          getForUpdate: (input) => tx.quoteDrafts.getForUpdate(input),
          create: async (input) => afterWrite(await tx.quoteDrafts.create(input)),
          claim: async (input) => afterWrite(await tx.quoteDrafts.claim(input)),
          release: async (input) => afterWrite(await tx.quoteDrafts.release(input)),
        },
      };
      return work(wrapped);
    }),
  };
}

function withDatabaseNow(
  delegate: AgentMissionUnitOfWorkPort,
  now: Instant,
): AgentMissionUnitOfWorkPort {
  return {
    readQuoteCreationOwner: (owner, work) =>
      delegate.readQuoteCreationOwner(owner, (transaction) =>
        work({ ...transaction, databaseNow: async () => now })),
    runQuoteCreationOwner: (owner, work) =>
      delegate.runQuoteCreationOwner(owner, (transaction) =>
        work({ ...transaction, databaseNow: async () => now })),
  };
}

describe.skipIf(!RUN_CERT)(
  'AgentMission M1-A — certification PostgreSQL transaction/RLS/N-1',
  () => {
    const runtimeUrl = process.env.DATABASE_URL ?? '';
    const directUrl = process.env.DIRECT_URL ?? '';
    const certAdminUrl = process.env.AGENT_MISSION_CERT_ADMIN_URL ?? '';
    const companyA = `mission-company-a-${randomUUID()}`;
    const companyB = `mission-company-b-${randomUUID()}`;
    const companyLifecycle = `mission-company-lifecycle-${randomUUID()}`;
    let admin: PrismaClient;
    let deployer: PrismaClient;
    let workerA: PrismaService;
    let workerB: PrismaService;
    let uowA: PrismaAgentMissionUnitOfWork;
    let uowB: PrismaAgentMissionUnitOfWork;

    beforeAll(async () => {
      if (!DISPOSABLE) {
        throw new Error(
          'AGENT_MISSION_CERT_DATABASE_IS_DISPOSABLE=true est obligatoire : le journal est immuable.',
        );
      }
      if (runtimeUrl === '' || directUrl === '' || certAdminUrl === '') {
        throw new Error(
          'DATABASE_URL runtime, DIRECT_URL deployer et AGENT_MISSION_CERT_ADMIN_URL sont requis.',
        );
      }
      admin = new PrismaClient({ datasourceUrl: certAdminUrl });
      deployer = new PrismaClient({ datasourceUrl: directUrl });
      workerA = new PrismaService({ datasourceUrl: runtimeUrl });
      workerB = new PrismaService({ datasourceUrl: runtimeUrl });
      uowA = new PrismaAgentMissionUnitOfWork(workerA);
      uowB = new PrismaAgentMissionUnitOfWork(workerB);
      await Promise.all([
        admin.$connect(),
        deployer.$connect(),
        workerA.$connect(),
        workerB.$connect(),
      ]);
      for (const [companyId, suffix] of [
        [companyA, '1'],
        [companyB, '2'],
        [companyLifecycle, '3'],
      ] as const) {
        await admin.$executeRaw`
          INSERT INTO public.companies (
            "id", "name", "legalForm", "siren", "siret", "trade", "vatRegime",
            "addrLine1", "addrZip", "addrCity"
          ) VALUES (
            ${companyId},
            ${`Mission cert ${suffix}`},
            ${'EI'},
            ${`90100000${suffix}`},
            ${`90100000${suffix}0000${suffix}`},
            ${'certification'},
            ${'reel_normal'},
            ${'1 rue du Test'},
            ${'75001'},
            ${'Paris'}
          )
        `;
      }
    }, 30_000);

    afterAll(async () => {
      await Promise.allSettled([
        workerA?.$disconnect(),
        workerB?.$disconnect(),
        deployer?.$disconnect(),
        admin?.$disconnect(),
      ]);
    });

    it('utilise un runtime non-superuser, non-owner et sans BYPASSRLS', async () => {
      const rows = await workerA.$queryRaw<Array<{
        currentUser: string;
        superuser: boolean;
        bypassRls: boolean;
        ownsMissionTable: boolean;
      }>>`
        SELECT
          current_user AS "currentUser",
          role.rolsuper AS "superuser",
          role.rolbypassrls AS "bypassRls",
          (
            relation.relowner = role.oid
          ) AS "ownsMissionTable"
        FROM pg_catalog.pg_roles AS role
        JOIN pg_catalog.pg_class AS relation
          ON relation.oid = 'public.agent_missions'::regclass
        WHERE role.rolname = current_user
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        superuser: false,
        bypassRls: false,
        ownsMissionTable: false,
      });
    });

    it('sépare le déployeur du propriétaire NOLOGIN sans révoquer son ADMIN OPTION automatique', async () => {
      const memberships = await admin.$queryRaw<Array<{
        deployerSuperuser: boolean;
        deployerOwnsMissionTable: boolean;
        ownerCanLogin: boolean;
        setOption: boolean;
        inheritOption: boolean;
        adminOption: boolean;
      }>>`
        SELECT
          deployer.rolsuper AS "deployerSuperuser",
          mission_table.relowner = deployer.oid AS "deployerOwnsMissionTable",
          owner_role.rolcanlogin AS "ownerCanLogin",
          membership.set_option AS "setOption",
          membership.inherit_option AS "inheritOption",
          membership.admin_option AS "adminOption"
        FROM pg_catalog.pg_roles AS deployer
        JOIN pg_catalog.pg_auth_members AS membership
          ON membership.member = deployer.oid
        JOIN pg_catalog.pg_roles AS owner_role
          ON owner_role.oid = membership.roleid
        JOIN pg_catalog.pg_class AS mission_table
          ON mission_table.oid = 'public.agent_missions'::regclass
        WHERE deployer.rolname = 'bob_deployer'
          AND owner_role.rolname = 'bob_schema_owner'
      `;
      expect(memberships.length).toBeGreaterThanOrEqual(1);
      expect(memberships.every((membership) =>
        !membership.deployerSuperuser
        && !membership.deployerOwnsMissionTable
        && !membership.ownerCanLogin
        && !membership.inheritOption,
      )).toBe(true);
      expect(memberships.some((membership) => membership.setOption)).toBe(true);
      expect(memberships.some((membership) => membership.adminOption)).toBe(true);
    });

    it('certifie les ACL runtime minimales et zéro exposition Data API Supabase', async () => {
      const runtimeAcl = await admin.$queryRaw<Array<{
        missionSelect: boolean;
        missionInsert: boolean;
        missionUpdate: boolean;
        missionDelete: boolean;
        missionTruncate: boolean;
        eventSelect: boolean;
        eventInsert: boolean;
        eventUpdate: boolean;
        eventDelete: boolean;
        eventTruncate: boolean;
      }>>`
        SELECT
          has_table_privilege('bob_app', 'public.agent_missions', 'SELECT')
            AS "missionSelect",
          has_table_privilege('bob_app', 'public.agent_missions', 'INSERT')
            AS "missionInsert",
          has_table_privilege('bob_app', 'public.agent_missions', 'UPDATE')
            AS "missionUpdate",
          has_table_privilege('bob_app', 'public.agent_missions', 'DELETE')
            AS "missionDelete",
          has_table_privilege('bob_app', 'public.agent_missions', 'TRUNCATE')
            AS "missionTruncate",
          has_table_privilege('bob_app', 'public.agent_mission_events', 'SELECT')
            AS "eventSelect",
          has_table_privilege('bob_app', 'public.agent_mission_events', 'INSERT')
            AS "eventInsert",
          has_table_privilege('bob_app', 'public.agent_mission_events', 'UPDATE')
            AS "eventUpdate",
          has_table_privilege('bob_app', 'public.agent_mission_events', 'DELETE')
            AS "eventDelete",
          has_table_privilege('bob_app', 'public.agent_mission_events', 'TRUNCATE')
            AS "eventTruncate"
      `;
      expect(runtimeAcl).toEqual([{
        missionSelect: true,
        missionInsert: true,
        missionUpdate: true,
        missionDelete: false,
        missionTruncate: false,
        eventSelect: true,
        eventInsert: true,
        eventUpdate: false,
        eventDelete: false,
        eventTruncate: false,
      }]);

      const exposedPrivileges = await admin.$queryRaw<Array<{
        roleName: string;
        objectName: string;
        privilegeName: string;
      }>>`
        SELECT
          exposed.role_name AS "roleName",
          tested.object_name AS "objectName",
          tested.privilege_name AS "privilegeName"
        FROM (
          VALUES ('anon'), ('authenticated'), ('service_role')
        ) AS exposed(role_name)
        CROSS JOIN (
          VALUES
            ('public.agent_missions', 'SELECT'),
            ('public.agent_missions', 'INSERT'),
            ('public.agent_missions', 'UPDATE'),
            ('public.agent_missions', 'DELETE'),
            ('public.agent_missions', 'TRUNCATE'),
            ('public.agent_mission_events', 'SELECT'),
            ('public.agent_mission_events', 'INSERT'),
            ('public.agent_mission_events', 'UPDATE'),
            ('public.agent_mission_events', 'DELETE'),
            ('public.agent_mission_events', 'TRUNCATE')
        ) AS tested(object_name, privilege_name)
        WHERE has_table_privilege(
          exposed.role_name,
          tested.object_name,
          tested.privilege_name
        )
      `;
      expect(exposedPrivileges).toEqual([]);

      const exposedFunctions = await admin.$queryRaw<Array<{ roleName: string }>>`
        SELECT exposed.role_name AS "roleName"
        FROM (
          VALUES ('anon'), ('authenticated'), ('service_role'), ('bob_app')
        ) AS exposed(role_name)
        WHERE has_function_privilege(
          exposed.role_name,
          'public.guard_agent_mission_mutation_v1()',
          'EXECUTE'
        )
          OR has_function_privilege(
            exposed.role_name,
            'public.guard_quote_draft_agent_mission_v1()',
            'EXECUTE'
          )
          OR has_function_privilege(
            exposed.role_name,
            'public.reject_agent_mission_event_mutation_v1()',
            'EXECUTE'
          )
          OR has_function_privilege(
            exposed.role_name,
            'public.guard_agent_mission_event_append_v1()',
            'EXECUTE'
          )
          OR has_function_privilege(
            exposed.role_name,
            'public.require_agent_mission_event_v1()',
            'EXECUTE'
          )
      `;
      expect(exposedFunctions).toEqual([]);
    });

    it('converge sous deux starts simultanés et rejoue le commandId sans event doublé', async () => {
      const owner = { companyId: companyA, ownerUserId: `owner-race-${randomUUID()}` };
      const commandA = randomUUID();
      const commandB = randomUUID();

      const [left, right] = await Promise.all([
        start(uowA).execute({ ...owner, commandId: commandA }),
        start(uowB).execute({ ...owner, commandId: commandB }),
      ]);

      expect(left.ok, JSON.stringify(left)).toBe(true);
      expect(right.ok, JSON.stringify(right)).toBe(true);
      const outcomes = [left, right]
        .filter((result) => result.ok)
        .map((result) => result.value.outcome)
        .sort();
      expect(outcomes).toEqual(['created', 'joined_active']);
      expect(await admin.agentMission.count({ where: owner })).toBe(1);
      expect(await admin.agentMissionEvent.count({ where: owner })).toBe(2);

      const creatorCommand = left.ok && left.value.outcome === 'created' ? commandA : commandB;
      const joinCommand = creatorCommand === commandA ? commandB : commandA;
      const mission = left.ok ? left.value.mission : right.ok ? right.value.mission : null;
      expect(mission).not.toBeNull();
      if (mission === null) return;
      const replay = await start(uowA).execute({ ...owner, commandId: creatorCommand });
      expect(replay).toMatchObject({ ok: true, value: { outcome: 'replayed' } });
      const joinReplay = await start(uowA).execute({ ...owner, commandId: joinCommand });
      expect(joinReplay).toMatchObject({
        ok: true,
        value: {
          outcome: 'replayed',
          mission: { id: mission.id, revision: 2 },
        },
      });
      expect(await admin.agentMissionEvent.count({ where: owner })).toBe(2);

      expect(await cancel(uowA).execute({
        ...owner,
        missionId: mission.id,
        commandId: randomUUID(),
        expectedRevision: 2,
        reason: 'user_cancelled',
        actor: 'user_tap',
      })).toMatchObject({ ok: true, value: { outcome: 'cancelled' } });
      const afterTerminal = await start(uowA).execute({ ...owner, commandId: joinCommand });
      expect(afterTerminal).toMatchObject({
        ok: true,
        value: {
          outcome: 'replayed',
          mission: { id: mission.id, status: 'cancelled' },
        },
      });
      expect(await admin.agentMission.count({ where: owner })).toBe(1);
      expect(await admin.agentMissionEvent.count({ where: owner })).toBe(3);
    });

    it('ordonne Company SHARE avant owner/kind et refuse tout writer après clôture', async () => {
      const owner = {
        companyId: companyLifecycle,
        ownerUserId: `owner-lifecycle-${randomUUID()}`,
      };
      let releaseMissionWork!: () => void;
      let markMissionWorkEntered!: () => void;
      const missionWorkEntered = new Promise<void>((resolve) => {
        markMissionWorkEntered = resolve;
      });
      const missionWorkCanContinue = new Promise<void>((resolve) => {
        releaseMissionWork = resolve;
      });
      const gatedUnitOfWork: AgentMissionUnitOfWorkPort = {
        readQuoteCreationOwner: (scope, work) => uowA.readQuoteCreationOwner(scope, work),
        runQuoteCreationOwner: (scope, work) =>
          uowA.runQuoteCreationOwner(scope, async (transaction) => {
            markMissionWorkEntered();
            await missionWorkCanContinue;
            return work(transaction);
          }),
      };

      const missionStart = start(gatedUnitOfWork).execute({
        ...owner,
        commandId: randomUUID(),
      });
      await missionWorkEntered;

      const competingClose = workerB.withIsolatedOwner(
        owner.companyId,
        owner.ownerUserId,
        async (transaction) => {
          await transaction.$executeRaw`
            SELECT set_config('lock_timeout', '200ms', true)
          `;
          return transaction.company.updateMany({
            where: { id: owner.companyId, closedAt: null },
            data: {
              closedAt: new Date(),
              closureReason: 'close must wait for mission writer',
            },
          });
        },
        { maxWaitMs: 5_000, timeoutMs: 5_000, readOnly: false },
      );
      try {
        await expect(competingClose).rejects.toThrow(/lock timeout/u);
      } finally {
        releaseMissionWork();
      }

      const started = await missionStart;
      expect(started.ok, JSON.stringify(started)).toBe(true);
      const closedAt = new Date();
      await expect(workerB.withIsolatedOwner(
        owner.companyId,
        owner.ownerUserId,
        (transaction) => transaction.company.updateMany({
          where: { id: owner.companyId, closedAt: null },
          data: {
            closedAt,
            closureReason: 'certified lifecycle close',
          },
        }),
        { maxWaitMs: 5_000, timeoutMs: 5_000, readOnly: false },
      )).resolves.toEqual({ count: 1 });

      const before = {
        missions: await admin.agentMission.count({ where: owner }),
        events: await admin.agentMissionEvent.count({ where: owner }),
        slots: await admin.quoteDraftSlot.count({ where: owner }),
      };
      expect(await start(uowA).execute({ ...owner, commandId: randomUUID() })).toEqual({
        ok: false,
        error: { kind: 'forbidden', reason: 'company_closed' },
      });
      let callbackCalled = false;
      expect(await new PrismaAgentMissionDraftFence(workerA).runLegacyMutationIfUnowned(
        owner,
        async () => {
          callbackCalled = true;
          return 'unreachable';
        },
      )).toEqual({ status: 'company_unavailable', reason: 'closed' });
      expect(callbackCalled).toBe(false);
      expect({
        missions: await admin.agentMission.count({ where: owner }),
        events: await admin.agentMissionEvent.count({ where: owner }),
        slots: await admin.quoteDraftSlot.count({ where: owner }),
      }).toEqual(before);
    });

    it('refuse une company absente sans exécuter le writer mission ou manuel', async () => {
      const owner = {
        companyId: `missing-company-${randomUUID()}`,
        ownerUserId: `owner-missing-${randomUUID()}`,
      };
      expect(await start(uowA).execute({ ...owner, commandId: randomUUID() })).toEqual({
        ok: false,
        error: { kind: 'not_found', entity: 'company', id: 'current' },
      });
      let callbackCalled = false;
      expect(await new PrismaAgentMissionDraftFence(workerA).runLegacyMutationIfUnowned(
        owner,
        async () => {
          callbackCalled = true;
          return 'unreachable';
        },
      )).toEqual({ status: 'company_unavailable', reason: 'missing' });
      expect(callbackCalled).toBe(false);
    });

    it('converge aussi sous deux replays simultanés du même commandId', async () => {
      const owner = { companyId: companyA, ownerUserId: `owner-replay-${randomUUID()}` };
      const commandId = randomUUID();
      const [left, right] = await Promise.all([
        start(uowA).execute({ ...owner, commandId }),
        start(uowB).execute({ ...owner, commandId }),
      ]);

      expect(left.ok, JSON.stringify(left)).toBe(true);
      expect(right.ok, JSON.stringify(right)).toBe(true);
      const outcomes = [left, right]
        .filter((result) => result.ok)
        .map((result) => result.value.outcome)
        .sort();
      expect(outcomes).toEqual(['created', 'replayed']);
      expect(await admin.agentMission.count({ where: owner })).toBe(1);
      expect(await admin.agentMissionEvent.count({ where: owner })).toBe(1);
    });

    it('RLS masque cross-owner et cross-tenant, tandis que GET reste sans écriture', async () => {
      const owner = { companyId: companyA, ownerUserId: `owner-read-${randomUUID()}` };
      const created = await start(uowA).execute({ ...owner, commandId: randomUUID() });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const before = await admin.agentMissionEvent.count({ where: owner });
      const event = await admin.agentMissionEvent.findFirstOrThrow({
        where: { missionId: created.value.mission.id },
      });
      const get = new GetActiveAgentMission({ unitOfWork: uowA });

      expect(await get.execute(owner)).toMatchObject({
        ok: true,
        value: { status: 'active', actionable: true },
      });
      expect(await get.execute({ ...owner, ownerUserId: `${owner.ownerUserId}-foreign` }))
        .toEqual({ ok: true, value: null });
      expect(await get.execute({ ...owner, companyId: companyB }))
        .toEqual({ ok: true, value: null });
      expect(await admin.agentMissionEvent.count({ where: owner })).toBe(before);

      const rawRowsVisibleTo = (
        effectiveOwner: AgentMissionOwner,
      ) => workerA.withIsolatedOwner(
        effectiveOwner.companyId,
        effectiveOwner.ownerUserId,
        async (transaction) => {
          const missions = await transaction.$queryRaw<Array<{ id: string }>>`
            SELECT "id"::text AS "id"
              FROM public.agent_missions
             WHERE "id" = ${created.value.mission.id}::uuid
          `;
          const events = await transaction.$queryRaw<Array<{ id: string }>>`
            SELECT "id"::text AS "id"
              FROM public.agent_mission_events
             WHERE "id" = ${event.id}::uuid
          `;
          return { missions, events };
        },
        { maxWaitMs: 5_000, timeoutMs: 10_000, readOnly: true },
      );

      await expect(rawRowsVisibleTo({
        ...owner,
        ownerUserId: `${owner.ownerUserId}-foreign`,
      })).resolves.toEqual({ missions: [], events: [] });
      await expect(rawRowsVisibleTo({
        ...owner,
        companyId: companyB,
      })).resolves.toEqual({ missions: [], events: [] });
    });

    it.each(['UPDATE', 'DELETE', 'TRUNCATE'] as const)(
      'le trigger append-only refuse réellement %s même au propriétaire du schéma',
      async (mutation) => {
        const owner = {
          companyId: companyA,
          ownerUserId: `owner-immutable-${mutation.toLowerCase()}-${randomUUID()}`,
        };
        const created = await start(uowA).execute({ ...owner, commandId: randomUUID() });
        expect(created.ok, JSON.stringify(created)).toBe(true);
        if (!created.ok) return;
        const before = await admin.agentMissionEvent.findFirstOrThrow({
          where: { missionId: created.value.mission.id },
        });

        const attempt = deployer.$transaction(async (transaction) => {
          await transaction.$executeRawUnsafe('SET LOCAL ROLE bob_schema_owner');
          if (mutation === 'UPDATE') {
            return transaction.$executeRaw`
              UPDATE public.agent_mission_events
                 SET "data" = "data"
               WHERE "id" = ${before.id}::uuid
            `;
          }
          if (mutation === 'DELETE') {
            return transaction.$executeRaw`
              DELETE FROM public.agent_mission_events
               WHERE "id" = ${before.id}::uuid
            `;
          }
          return transaction.$executeRawUnsafe(
            'TRUNCATE TABLE public.agent_mission_events',
          );
        });

        await expect(attempt).rejects.toThrow(/AGENT_MISSION_EVENT_IMMUTABLE/u);
        expect(await admin.agentMissionEvent.findUniqueOrThrow({
          where: { id: before.id },
        })).toEqual(before);
      },
    );

    it('ferme payload, binding et event data aux clés libres contenant du contenu métier', async () => {
      const owner = {
        companyId: companyA,
        ownerUserId: `owner-closed-json-${randomUUID()}`,
      };
      const created = await start(uowA).execute({ ...owner, commandId: randomUUID() });
      expect(created.ok, JSON.stringify(created)).toBe(true);
      if (!created.ok) return;
      const missionId = created.value.mission.id;
      const initialEvent = await admin.agentMissionEvent.findFirstOrThrow({
        where: { missionId, eventType: 'mission_started' },
      });

      const attemptMissionUpdate = (
        mutation: 'payload_top' | 'payload_nested' | 'binding',
      ) => workerA.withIsolatedOwner(
        owner.companyId,
        owner.ownerUserId,
        async (transaction) => {
          await transaction.$executeRaw`
            SELECT set_config('app.current_agent_mission_id', ${missionId}, true)
          `;
          if (mutation === 'binding') {
            const binding = JSON.stringify({
              realtimeSessionId: randomUUID(),
              contextRevision: 1,
              contextDigest: 'a'.repeat(64),
              screenName: '/devis/new',
              screenInstanceId: 'screen-certified',
              acknowledgedAt: new Date().toISOString(),
              customerName: 'contenu métier interdit',
            });
            return transaction.$executeRaw`
              WITH business_time AS (SELECT clock_timestamp() AS at)
              UPDATE public.agent_missions
                 SET "phase" = 'awaiting_customer',
                     "revision" = 2,
                     "currentBinding" = ${binding}::JSONB,
                     "updatedAt" = business_time.at,
                     "idleExpiresAt" = LEAST(
                       business_time.at + INTERVAL '24 hours',
                       "hardExpiresAt"
                     )
                FROM business_time
               WHERE "id" = ${missionId}::UUID
            `;
          }
          return transaction.$executeRaw`
            WITH business_time AS (SELECT clock_timestamp() AS at)
            UPDATE public.agent_missions
               SET "revision" = 2,
                   "payload" = CASE
                     WHEN ${mutation} = 'payload_top'
                       THEN "payload" || '{"transcript":"contenu métier interdit"}'::JSONB
                     ELSE jsonb_set(
                       "payload",
                       '{draft,amount}',
                       '12500'::JSONB,
                       true
                     )
                   END,
                   "updatedAt" = business_time.at,
                   "idleExpiresAt" = LEAST(
                     business_time.at + INTERVAL '24 hours',
                     "hardExpiresAt"
                   )
              FROM business_time
             WHERE "id" = ${missionId}::UUID
          `;
        },
        { maxWaitMs: 5_000, timeoutMs: 10_000, readOnly: false },
      );

      await expect(attemptMissionUpdate('payload_top'))
        .rejects.toThrow(/agent_missions_payload_closed_shape_check/u);
      await expect(attemptMissionUpdate('payload_nested'))
        .rejects.toThrow(/agent_missions_payload_closed_shape_check/u);
      await expect(attemptMissionUpdate('binding'))
        .rejects.toThrow(/agent_missions_binding_shape_check/u);

      const forbiddenEventData = JSON.stringify({
        kind: 'mission_cancelled',
        reason: 'user_cancelled',
        transcript: 'contenu vocal interdit',
      });
      await expect(workerA.withIsolatedOwner(
        owner.companyId,
        owner.ownerUserId,
        async (transaction) => {
          await transaction.$executeRaw`
            SELECT set_config('app.current_agent_mission_id', ${missionId}, true)
          `;
          const businessTime = await transaction.$queryRaw<Array<{ at: Date }>>`
            SELECT clock_timestamp() AS "at"
          `;
          const occurredAt = businessTime[0]?.at;
          if (!(occurredAt instanceof Date)) {
            throw new Error('agent mission privacy cert DB clock unavailable');
          }
          await transaction.$executeRaw`
            UPDATE public.agent_missions
               SET "revision" = 2,
                   "updatedAt" = ${occurredAt},
                   "idleExpiresAt" = LEAST(
                     ${occurredAt}::TIMESTAMPTZ + INTERVAL '24 hours',
                     "hardExpiresAt"
                   )
             WHERE "id" = ${missionId}::UUID
          `;
          return transaction.$executeRaw`
            INSERT INTO public.agent_mission_events (
              "id",
              "companyId",
              "ownerUserId",
              "missionId",
              "sequence",
              "eventType",
              "eventVersion",
              "actor",
              "commandId",
              "requestFingerprintHmac",
              "fingerprintKeyVersion",
              "fingerprintCanonicalizationVersion",
              "missionRevisionBefore",
              "missionRevisionAfter",
              "draftSlotRevisionBefore",
              "draftSlotRevisionAfter",
              "draftContentRevisionBefore",
              "draftContentRevisionAfter",
              "realtimeSessionId",
              "turnId",
              "contextRevision",
              "contextDigest",
              "data",
              "occurredAt",
              "retentionExpiresAt"
            )
            VALUES (
              ${randomUUID()}::UUID,
              ${owner.companyId},
              ${owner.ownerUserId},
              ${missionId}::UUID,
              2,
              'mission_cancelled',
              1,
              'user_tap',
              ${randomUUID()}::UUID,
              ${'b'.repeat(64)},
              1,
              1,
              1,
              2,
              ${initialEvent.draftSlotRevisionAfter},
              ${initialEvent.draftSlotRevisionAfter},
              ${initialEvent.draftContentRevisionAfter},
              ${initialEvent.draftContentRevisionAfter},
              NULL,
              NULL,
              NULL,
              NULL,
              ${forbiddenEventData}::JSONB,
              ${occurredAt},
              ${new Date(occurredAt.getTime() + 90 * 24 * 60 * 60 * 1_000)}
            )
          `;
        },
        { maxWaitMs: 5_000, timeoutMs: 10_000, readOnly: false },
      )).rejects.toThrow(/agent_mission_events_data_check/u);

      expect(await admin.agentMission.findUniqueOrThrow({ where: { id: missionId } }))
        .toMatchObject({ revision: 1, phase: 'awaiting_quote_screen', currentBinding: null });
      expect(await admin.agentMissionEvent.count({ where: { missionId } })).toBe(1);
    });

    it('refuse un event sans révision mission correspondante et une mission sans event atomique', async () => {
      const owner = {
        companyId: companyA,
        ownerUserId: `owner-event-coupling-${randomUUID()}`,
      };
      const created = await start(uowA).execute({ ...owner, commandId: randomUUID() });
      expect(created.ok, JSON.stringify(created)).toBe(true);
      if (!created.ok) return;
      const missionId = created.value.mission.id;
      const initialEvent = await admin.agentMissionEvent.findFirstOrThrow({
        where: { missionId, eventType: 'mission_started' },
      });
      const occurredAt = new Date();
      const validData = JSON.stringify({
        kind: 'mission_cancelled',
        reason: 'user_cancelled',
      });

      await expect(workerA.withIsolatedOwner(
        owner.companyId,
        owner.ownerUserId,
        async (transaction) => {
          await transaction.$executeRaw`
            SELECT set_config('app.current_agent_mission_id', ${missionId}, true)
          `;
          return transaction.$executeRaw`
            INSERT INTO public.agent_mission_events (
              "id", "companyId", "ownerUserId", "missionId", "sequence",
              "eventType", "eventVersion", "actor", "commandId",
              "requestFingerprintHmac", "fingerprintKeyVersion",
              "fingerprintCanonicalizationVersion", "missionRevisionBefore",
              "missionRevisionAfter", "draftSlotRevisionBefore",
              "draftSlotRevisionAfter", "draftContentRevisionBefore",
              "draftContentRevisionAfter", "realtimeSessionId", "turnId",
              "contextRevision", "contextDigest", "data", "occurredAt",
              "retentionExpiresAt"
            ) VALUES (
              ${randomUUID()}::UUID, ${owner.companyId}, ${owner.ownerUserId},
              ${missionId}::UUID, 2, 'mission_cancelled', 1, 'user_tap',
              ${randomUUID()}::UUID, ${'c'.repeat(64)}, 1, 1, 1, 2,
              ${initialEvent.draftSlotRevisionAfter},
              ${initialEvent.draftSlotRevisionAfter},
              ${initialEvent.draftContentRevisionAfter},
              ${initialEvent.draftContentRevisionAfter},
              NULL, NULL, NULL, NULL, ${validData}::JSONB, ${occurredAt},
              ${new Date(occurredAt.getTime() + 90 * 24 * 60 * 60 * 1_000)}
            )
          `;
        },
        { maxWaitMs: 5_000, timeoutMs: 10_000, readOnly: false },
      )).rejects.toThrow(/AGENT_MISSION_EVENT_REVISION_MISMATCH/u);

      await expect(workerA.withIsolatedOwner(
        owner.companyId,
        owner.ownerUserId,
        async (transaction) => {
          await transaction.$executeRaw`
            SELECT set_config('app.current_agent_mission_id', ${missionId}, true)
          `;
          const rows = await transaction.$queryRaw<Array<{ at: Date }>>`
            SELECT clock_timestamp() AS "at"
          `;
          const at = rows[0]?.at;
          if (!(at instanceof Date)) throw new Error('event coupling DB clock unavailable');
          await transaction.$executeRaw`
            UPDATE public.agent_missions
               SET "revision" = 2,
                   "updatedAt" = ${at},
                   "idleExpiresAt" = LEAST(
                     ${at}::TIMESTAMPTZ + INTERVAL '24 hours',
                     "hardExpiresAt"
                   )
             WHERE "id" = ${missionId}::UUID
          `;
        },
        { maxWaitMs: 5_000, timeoutMs: 10_000, readOnly: false },
      )).rejects.toThrow(/AGENT_MISSION_EVENT_REQUIRED/u);

      expect(await admin.agentMission.findUniqueOrThrow({ where: { id: missionId } }))
        .toMatchObject({ revision: 1 });
      expect(await admin.agentMissionEvent.count({ where: { missionId } })).toBe(1);
    });

    it('projette une mission expirée par GET sans aucune écriture', async () => {
      const owner = { companyId: companyB, ownerUserId: `owner-expired-get-${randomUUID()}` };
      const past = new Date(Date.now() - 25 * 60 * 60 * 1_000).toISOString() as Instant;
      const created = await start(withDatabaseNow(uowA, past)).execute({
        ...owner,
        commandId: randomUUID(),
      });
      expect(created.ok, JSON.stringify(created)).toBe(true);
      if (!created.ok) return;
      const beforeMission = await admin.agentMission.findUniqueOrThrow({
        where: { id: created.value.mission.id },
      });
      const beforeEventCount = await admin.agentMissionEvent.count({ where: owner });
      const beforeSlot = await admin.quoteDraftSlot.findUniqueOrThrow({
        where: { quote_draft_slot_owner: owner },
      });

      const projected = await new GetActiveAgentMission({ unitOfWork: uowA }).execute(owner);

      expect(projected).toMatchObject({
        ok: true,
        value: { id: created.value.mission.id, status: 'expired', actionable: false },
      });
      expect(await admin.agentMission.findUniqueOrThrow({
        where: { id: created.value.mission.id },
      })).toEqual(beforeMission);
      expect(await admin.agentMissionEvent.count({ where: owner })).toBe(beforeEventCount);
      expect(await admin.quoteDraftSlot.findUniqueOrThrow({
        where: { quote_draft_slot_owner: owner },
      })).toEqual(beforeSlot);
    });

    it('terminalise une mission expirée une seule fois avant le nouveau start', async () => {
      const owner = { companyId: companyB, ownerUserId: `owner-expired-start-${randomUUID()}` };
      const past = new Date(Date.now() - 25 * 60 * 60 * 1_000).toISOString() as Instant;
      const first = await start(withDatabaseNow(uowA, past)).execute({
        ...owner,
        commandId: randomUUID(),
      });
      expect(first.ok, JSON.stringify(first)).toBe(true);
      if (!first.ok) return;
      const beforeSlot = await admin.quoteDraftSlot.findUniqueOrThrow({
        where: { quote_draft_slot_owner: owner },
      });

      const second = await start(uowA).execute({ ...owner, commandId: randomUUID() });
      expect(second).toMatchObject({
        ok: true,
        value: { outcome: 'created', startOutcome: 'empty_slot_adopted' },
      });
      const joined = await start(uowB).execute({ ...owner, commandId: randomUUID() });
      expect(joined).toMatchObject({ ok: true, value: { outcome: 'joined_active' } });

      expect(await admin.agentMission.count({ where: owner })).toBe(2);
      expect(await admin.agentMission.count({
        where: { ...owner, status: 'expired' },
      })).toBe(1);
      expect(await admin.agentMission.count({
        where: { ...owner, status: 'active' },
      })).toBe(1);
      expect(await admin.agentMissionEvent.count({
        where: { ...owner, eventType: 'mission_expired' },
      })).toBe(1);
      expect(await admin.agentMissionEvent.count({ where: owner })).toBe(4);
      const slot = await admin.quoteDraftSlot.findUniqueOrThrow({
        where: { quote_draft_slot_owner: owner },
      });
      expect(slot.agentMissionId).toBe(
        second.ok ? second.value.mission.id : 'unreachable',
      );
      expect(slot.payload).toEqual(beforeSlot.payload);
      expect(slot.revision).toBe(beforeSlot.revision);
      expect(slot.updatedAt).toEqual(beforeSlot.updatedAt);
    });

    it('le writer N-1 fonctionne marker NULL, puis échoue fermé pendant la mission', async () => {
      const owner = { companyId: companyA, ownerUserId: `owner-n1-${randomUUID()}` };
      const legacy = new PrismaQuoteDraftSlotRepository(workerA);
      await workerA.withIdentity(owner.ownerUserId, () =>
        workerA.withTenant(owner.companyId, async () => {
          expect(await legacy.upsert({
            ...owner,
            expectedRevision: 0,
            payload: emptyPayload('legacy-empty'),
          })).toMatchObject({ status: 'created' });
          expect(await legacy.upsert({
            ...owner,
            expectedRevision: 1,
            payload: emptyPayload('legacy-before-mission'),
          })).toMatchObject({ status: 'updated' });
        }),
      );

      const started = await start(uowA).execute({ ...owner, commandId: randomUUID() });
      expect(started.ok).toBe(true);
      let callbackCalled = false;
      const fenced = await new PrismaAgentMissionDraftFence(workerA)
        .runLegacyMutationIfUnowned(owner, async () => {
          callbackCalled = true;
          return 'unreachable';
        });
      expect(fenced).toEqual({ status: 'owned_by_agent_mission' });
      expect(callbackCalled).toBe(false);
      await expect(workerA.withIdentity(owner.ownerUserId, () =>
        workerA.withTenant(owner.companyId, () =>
          legacy.upsert({
            ...owner,
            expectedRevision: 2,
            payload: emptyPayload('legacy-forbidden'),
          }),
        ),
      )).rejects.toThrow(/QUOTE_DRAFT_AGENT_MISSION_CAPABILITY_REQUIRED/u);
    });

    it('sérialise une sauvegarde manuelle et un start mission sur le même advisory lock', async () => {
      const owner = { companyId: companyA, ownerUserId: `owner-fence-race-${randomUUID()}` };
      const legacy = new PrismaQuoteDraftSlotRepository(workerA);
      const fence = new PrismaAgentMissionDraftFence(workerA);
      let releaseLegacy!: () => void;
      let markLegacyEntered!: () => void;
      const legacyEntered = new Promise<void>((resolve) => {
        markLegacyEntered = resolve;
      });
      const legacyCanCommit = new Promise<void>((resolve) => {
        releaseLegacy = resolve;
      });

      const legacyWrite = fence.runLegacyMutationIfUnowned(owner, async () => {
        markLegacyEntered();
        await legacyCanCommit;
        return legacy.upsert({
          ...owner,
          expectedRevision: 0,
          payload: meaningfulPayload('legacy-wins-race'),
        });
      });
      await legacyEntered;
      const missionStart = start(uowB).execute({ ...owner, commandId: randomUUID() });
      releaseLegacy();

      const [legacyResult, missionResult] = await Promise.all([legacyWrite, missionStart]);
      expect(legacyResult).toMatchObject({
        status: 'executed',
        value: { status: 'created' },
      });
      expect(missionResult).toMatchObject({
        ok: true,
        value: {
          outcome: 'created',
          startOutcome: 'draft_conflict',
          mission: { phase: 'awaiting_draft_decision' },
        },
      });
      const slot = await admin.quoteDraftSlot.findUniqueOrThrow({
        where: { quote_draft_slot_owner: owner },
      });
      expect(slot.agentMissionId).toBeNull();
      expect(slot.payload).toMatchObject({
        draft: {
          sessionId: 'legacy-wins-race',
          lineForm: { label: 'Main-d’œuvre plomberie' },
        },
      });
    });

    it('refuse les mutations mission si la capability est absente, erronée ou cross-owner', async () => {
      const owner = { companyId: companyA, ownerUserId: `owner-guc-${randomUUID()}` };
      const started = await start(uowA).execute({ ...owner, commandId: randomUUID() });
      expect(started.ok, JSON.stringify(started)).toBe(true);
      if (!started.ok) return;

      const attempt = (
        effectiveOwner: AgentMissionOwner,
        capability: string | null,
      ) => workerA.withIsolatedOwner(
        effectiveOwner.companyId,
        effectiveOwner.ownerUserId,
        async (transaction) => {
          if (capability !== null) {
            await transaction.$executeRaw`
              SELECT set_config('app.current_agent_mission_id', ${capability}, true)
            `;
          }
          return transaction.agentMission.updateMany({
            where: { id: started.value.mission.id },
            data: { revision: 2 },
          });
        },
        { maxWaitMs: 5_000, timeoutMs: 10_000, readOnly: false },
      );

      await expect(attempt(owner, null)).resolves.toEqual({ count: 0 });
      await expect(attempt(owner, randomUUID())).resolves.toEqual({ count: 0 });
      await expect(attempt(
        { ...owner, ownerUserId: `${owner.ownerUserId}-foreign` },
        started.value.mission.id,
      )).resolves.toEqual({ count: 0 });
      expect(await admin.agentMission.findUniqueOrThrow({
        where: { id: started.value.mission.id },
      })).toMatchObject({ revision: 1, status: 'active' });
    });

    it.each(['user_cancelled', 'manual_handoff'] as const)(
      '%s conserve le payload, libère le marker et rend le writer N-1 à nouveau opérant',
      async (reason) => {
        const owner = {
          companyId: companyA,
          ownerUserId: `owner-${reason}-${randomUUID()}`,
        };
        const started = await start(uowA).execute({ ...owner, commandId: randomUUID() });
        expect(started.ok).toBe(true);
        if (!started.ok) return;
        const before = await admin.quoteDraftSlot.findUniqueOrThrow({
          where: { quote_draft_slot_owner: owner },
        });

        const cancelled = await cancel(uowA).execute({
          ...owner,
          missionId: started.value.mission.id,
          commandId: randomUUID(),
          expectedRevision: 1,
          reason,
          actor: 'user_tap',
        });

        expect(cancelled, JSON.stringify(cancelled)).toMatchObject({
          ok: true,
          value: { outcome: 'cancelled', mission: { status: 'cancelled' } },
        });
        const after = await admin.quoteDraftSlot.findUniqueOrThrow({
          where: { quote_draft_slot_owner: owner },
        });
        expect(after.agentMissionId).toBeNull();
        expect(after.payload).toEqual(before.payload);
        expect(after.revision).toBe(before.revision);
        expect(after.updatedAt).toEqual(before.updatedAt);

        const legacy = new PrismaQuoteDraftSlotRepository(workerA);
        await workerA.withIdentity(owner.ownerUserId, () =>
          workerA.withTenant(owner.companyId, async () => {
            expect(await legacy.upsert({
              ...owner,
              expectedRevision: after.revision,
              payload: emptyPayload(`legacy-after-${reason}`),
            })).toMatchObject({ status: 'updated' });
          }),
        );
      },
    );

    it('interdit DELETE d’un slot possédé même avec la GUC mission exacte', async () => {
      const owner = { companyId: companyA, ownerUserId: `owner-delete-${randomUUID()}` };
      const started = await start(uowA).execute({ ...owner, commandId: randomUUID() });
      expect(started.ok).toBe(true);
      if (!started.ok) return;

      await expect(workerA.withIsolatedOwner(
        owner.companyId,
        owner.ownerUserId,
        async (transaction) => {
          await transaction.$executeRaw`
            SELECT set_config(
              'app.current_agent_mission_id',
              ${started.value.mission.id},
              true
            )
          `;
          await transaction.quoteDraftSlot.delete({
            where: { quote_draft_slot_owner: owner },
          });
        },
        { maxWaitMs: 5_000, timeoutMs: 10_000, readOnly: false },
      )).rejects.toThrow(/QUOTE_DRAFT_OWNED_DELETE_FORBIDDEN/u);
    });

    it.each([1, 2, 3, 4])(
      'rollbacke draft/mission/marker/event après la faute injectée %s',
      async (failAtWrite) => {
        const owner = {
          companyId: companyB,
          ownerUserId: `owner-rollback-${failAtWrite}-${randomUUID()}`,
        };
        await expect(start(faultAfterWrite(uowA, failAtWrite)).execute({
          ...owner,
          commandId: randomUUID(),
        })).rejects.toThrow(`injected-write-${failAtWrite}`);

        expect(await admin.agentMission.count({ where: owner })).toBe(0);
        expect(await admin.agentMissionEvent.count({ where: owner })).toBe(0);
        expect(await admin.quoteDraftSlot.count({ where: owner })).toBe(0);
      },
    );

    it.each(['user_cancelled', 'manual_handoff'] as const)(
      'rollbacke chaque écriture de terminalisation %s',
      async (reason) => {
        for (const failAtWrite of [1, 2, 3]) {
          const owner = {
            companyId: companyB,
            ownerUserId: `owner-${reason}-rollback-${failAtWrite}-${randomUUID()}`,
          };
          const started = await start(uowA).execute({ ...owner, commandId: randomUUID() });
          expect(started.ok, JSON.stringify(started)).toBe(true);
          if (!started.ok) continue;
          const slotBefore = await admin.quoteDraftSlot.findUniqueOrThrow({
            where: { quote_draft_slot_owner: owner },
          });

          await expect(cancel(faultAfterWrite(uowA, failAtWrite)).execute({
            ...owner,
            missionId: started.value.mission.id,
            commandId: randomUUID(),
            expectedRevision: 1,
            reason,
            actor: 'user_tap',
          })).rejects.toThrow(`injected-write-${failAtWrite}`);

          expect(await admin.agentMission.findUniqueOrThrow({
            where: { id: started.value.mission.id },
          })).toMatchObject({ status: 'active', revision: 1 });
          expect(await admin.agentMissionEvent.count({ where: owner })).toBe(1);
          expect(await admin.quoteDraftSlot.findUniqueOrThrow({
            where: { quote_draft_slot_owner: owner },
          })).toEqual(slotBefore);
        }
      },
    );

    it.each([1, 2, 3, 4, 5, 6])(
      'rollbacke expiration et nouveau start après la faute injectée %s',
      async (failAtWrite) => {
        const owner = {
          companyId: companyB,
          ownerUserId: `owner-expiry-rollback-${failAtWrite}-${randomUUID()}`,
        };
        const past = new Date(Date.now() - 25 * 60 * 60 * 1_000).toISOString() as Instant;
        const first = await start(withDatabaseNow(uowA, past)).execute({
          ...owner,
          commandId: randomUUID(),
        });
        expect(first.ok, JSON.stringify(first)).toBe(true);
        if (!first.ok) return;
        const slotBefore = await admin.quoteDraftSlot.findUniqueOrThrow({
          where: { quote_draft_slot_owner: owner },
        });

        await expect(start(faultAfterWrite(uowA, failAtWrite)).execute({
          ...owner,
          commandId: randomUUID(),
        })).rejects.toThrow(`injected-write-${failAtWrite}`);

        expect(await admin.agentMission.count({ where: owner })).toBe(1);
        expect(await admin.agentMission.findUniqueOrThrow({
          where: { id: first.value.mission.id },
        })).toMatchObject({ status: 'active', revision: 1 });
        expect(await admin.agentMissionEvent.count({ where: owner })).toBe(1);
        expect(await admin.quoteDraftSlot.findUniqueOrThrow({
          where: { quote_draft_slot_owner: owner },
        })).toEqual(slotBefore);
      },
    );

    it('la transaction GET est matériellement READ ONLY', async () => {
      const owner: AgentMissionOwner = {
        companyId: companyB,
        ownerUserId: `owner-readonly-${randomUUID()}`,
      };
      await expect(workerA.withIsolatedOwner(
        owner.companyId,
        owner.ownerUserId,
        async (transaction) => {
          await transaction.quoteDraftSlot.create({
            data: {
              ...owner,
              revision: 1,
              payloadVersion: 1,
              payload: JSON.parse(
                JSON.stringify(emptyPayload('read-only-write')),
              ) as Prisma.InputJsonValue,
            },
          });
        },
        { maxWaitMs: 5_000, timeoutMs: 10_000, readOnly: true },
      )).rejects.toBeDefined();
      expect(await admin.quoteDraftSlot.count({ where: owner })).toBe(0);
    });
  },
);
