import { randomUUID } from 'node:crypto';
import {
  AcknowledgeQuoteScreen,
  AdvanceQuoteAgentMission,
  CancelQuoteAgentMission,
  GetActiveAgentMission,
  StartQuoteAgentMission,
  createEmptyQuoteDraftPayload,
  parseQuoteDraftPayload,
  sha256Hex,
  type AgentMissionFingerprintPort,
  type AgentMissionOwner,
  type AgentMissionQuoteLineWork,
  type AgentMissionRealtimeAuthorityProof,
  type AgentMissionTransaction,
  type AgentMissionUnitOfWorkPort,
  type AcknowledgeQuoteScreenInput,
  type AdvanceQuoteAgentMissionInput,
  type CancelQuoteAgentMissionInput,
  type Instant,
  type StartQuoteAgentMissionCommand,
} from '@bob/core';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaQuoteDraftSlotRepository } from './quote-draft-slots.repository';
import {
  prepareRealtimeContext,
  type RealtimeAdmissionPolicy,
} from '../../voice/realtime/realtime-admission';
import { PrismaRealtimeAdmission } from '../../voice/realtime/realtime-admission.prisma';
import {
  PrismaAgentMissionDraftFence,
  PrismaAgentMissionUnitOfWork,
} from './agent-mission.persistence';
import {
  PrismaAgentMissionFingerprintKeyVersionAuthority,
} from './agent-mission-fingerprint-key-version.prisma';
import {
  fingerprintAgentMissionHmacKey,
} from '../../agent-missions/agent-mission-fingerprint-key-version';
import {
  PrismaService,
  type IsolatedOwnerTransactionOptions,
} from './prisma.service';

const RUN_CERT = process.env.RUN_AGENT_MISSION_POSTGRES_CERT === 'true';
const DISPOSABLE = process.env.AGENT_MISSION_CERT_DATABASE_IS_DISPOSABLE === 'true';
const CERT_FINGERPRINT_KEY = Buffer.alloc(32, 41).toString('base64url');
const CERT_FINGERPRINT_BINDING = Object.freeze({
  keyVersion: 1,
  keyFingerprint: fingerprintAgentMissionHmacKey(CERT_FINGERPRINT_KEY),
});
const CERT_RETAINED_FINGERPRINT_BINDING = Object.freeze({
  keyVersion: 3,
  keyFingerprint: fingerprintAgentMissionHmacKey(
    Buffer.alloc(32, 43).toString('base64url'),
  ),
});

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

let authorizeOwner: (
  owner: AgentMissionOwner,
) => Promise<AgentMissionRealtimeAuthorityProof> = async () => {
  throw new Error('AgentMission PostgreSQL capability fixture is not initialized.');
};

function certificationAuthorityProof(
  owner: AgentMissionOwner,
): AgentMissionRealtimeAuthorityProof {
  const key = `${owner.companyId}\u0000${owner.ownerUserId}`;
  return Object.freeze({
    subjectHashCandidates: Object.freeze([
      sha256Hex(`agent-mission-cert-subject:${key}`),
    ]),
    principalBindingHash: sha256Hex(`agent-mission-cert-principal:${key}`),
    capabilityHash: sha256Hex(`agent-mission-cert-capability:${key}`),
  });
}

function start(uow: AgentMissionUnitOfWorkPort) {
  const useCase = new StartQuoteAgentMission({
    unitOfWork: uow,
    fingerprints: FINGERPRINTS,
    ids: ids(),
  });
  return {
    execute: async (
      input: Omit<
        StartQuoteAgentMissionCommand,
        'authority' | 'origin' | 'customerReference'
      > & Partial<Pick<StartQuoteAgentMissionCommand, 'origin' | 'customerReference'>>,
      authority?: AgentMissionRealtimeAuthorityProof,
    ) => useCase.execute({
      ...input,
      authority: authority ?? await authorizeOwner(input),
      origin: input.origin ?? { actor: 'user_tap', correlation: null },
      customerReference: input.customerReference ?? null,
    }),
  };
}

function cancel(uow: AgentMissionUnitOfWorkPort) {
  const useCase = new CancelQuoteAgentMission({
    unitOfWork: uow,
    fingerprints: FINGERPRINTS,
    ids: ids(),
  });
  return {
    execute: async (
      input: Omit<CancelQuoteAgentMissionInput, 'authority'>,
    ) => useCase.execute({ ...input, authority: await authorizeOwner(input) }),
  };
}

function acknowledge(uow: AgentMissionUnitOfWorkPort) {
  const useCase = new AcknowledgeQuoteScreen({
    unitOfWork: uow,
    fingerprints: FINGERPRINTS,
    ids: ids(),
  });
  return {
    execute: async (
      input: Omit<AcknowledgeQuoteScreenInput, 'authority'>,
    ) => useCase.execute({ ...input, authority: await authorizeOwner(input) }),
  };
}

function advance(uow: AgentMissionUnitOfWorkPort) {
  const useCase = new AdvanceQuoteAgentMission({
    unitOfWork: uow,
    fingerprints: FINGERPRINTS,
    ids: ids(),
  });
  return {
    execute: async (
      input: Omit<AdvanceQuoteAgentMissionInput, 'authority'>,
    ) => useCase.execute({ ...input, authority: await authorizeOwner(input) }),
  };
}

function get(uow: AgentMissionUnitOfWorkPort) {
  const useCase = new GetActiveAgentMission({ unitOfWork: uow });
  return {
    execute: async (owner: AgentMissionOwner) =>
      useCase.execute(owner, await authorizeOwner(owner)),
  };
}

function faultAfterWrite(
  delegate: AgentMissionUnitOfWorkPort,
  failAtWrite: number,
): AgentMissionUnitOfWorkPort {
  return {
    readQuoteCreationOwner: (owner, authority, work) =>
      delegate.readQuoteCreationOwner(owner, authority, work),
    runQuoteCreationOwner: (owner, authority, work) =>
      delegate.runQuoteCreationOwner(owner, authority, async (tx) => {
      let writes = 0;
      const afterWrite = <T>(value: T): T => {
        writes += 1;
        if (writes === failAtWrite) throw new Error(`injected-write-${failAtWrite}`);
        return value;
      };
      const wrapped: AgentMissionTransaction = {
        databaseNow: () => tx.databaseNow(),
        realtime: tx.realtime,
        missions: {
          findActive: (input) => tx.missions.findActive(input),
          findForeground: (input) => tx.missions.findForeground(input),
          findById: (input) => tx.missions.findById(input),
          findActiveForUpdate: (input) => tx.missions.findActiveForUpdate(input),
          findForegroundForUpdate: (input) => tx.missions.findForegroundForUpdate(input),
          findByIdForUpdate: (input) => tx.missions.findByIdForUpdate(input),
          insert: async (mission) => {
            const result = await tx.missions.insert(mission);
            afterWrite(undefined);
            return result;
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
          selectCustomerCas: async (input) => (
            afterWrite(await tx.quoteDrafts.selectCustomerCas(input))
          ),
        },
        quoteLineWork: {
          listForUpdate: (input) => tx.quoteLineWork.listForUpdate(input),
          findByIdForUpdate: (input) => tx.quoteLineWork.findByIdForUpdate(input),
          insertMany: async (input) => (
            afterWrite(await tx.quoteLineWork.insertMany(input))
          ),
          updateCas: async (input) => (
            afterWrite(await tx.quoteLineWork.updateCas(input))
          ),
          delete: async (input) => (
            afterWrite(await tx.quoteLineWork.delete(input))
          ),
          deleteAll: async (input) => (
            afterWrite(await tx.quoteLineWork.deleteAll(input))
          ),
        },
        quoteScreen: tx.quoteScreen,
        customers: tx.customers,
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
    readQuoteCreationOwner: (owner, authority, work) =>
      delegate.readQuoteCreationOwner(owner, authority, (transaction) =>
        work({ ...transaction, databaseNow: async () => now })),
    runQuoteCreationOwner: (owner, authority, work) =>
      delegate.runQuoteCreationOwner(owner, authority, (transaction) =>
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
    const exactCustomerId = `customer-camping-les-pins-${randomUUID()}`;
    const fuzzyCustomerIds = Object.freeze([
      `customer-ratp-fontaines-bastille-${randomUUID()}`,
      `customer-ratp-fontaines-nation-${randomUUID()}`,
      `customer-ratp-fontaines-republique-${randomUUID()}`,
    ]);
    const manyCustomerIds = Object.freeze(Array.from(
      { length: 6 },
      (_, index) => `customer-entretien-vitrines-${index + 1}-${randomUUID()}`,
    ));
    const foreignExactCustomerId = `customer-foreign-camping-${randomUUID()}`;
    let admin: PrismaClient;
    let deployer: PrismaClient;
    let workerA: PrismaService;
    let workerB: PrismaService;
    let uowA: PrismaAgentMissionUnitOfWork;
    let uowB: PrismaAgentMissionUnitOfWork;
    const authorityByOwner = new Map<
      string,
      Promise<AgentMissionRealtimeAuthorityProof>
    >();

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
      authorizeOwner = async (owner) => {
        const key = `${owner.companyId}\u0000${owner.ownerUserId}`;
        const existing = authorityByOwner.get(key);
        if (existing !== undefined) return existing;
        const creating = (async (): Promise<AgentMissionRealtimeAuthorityProof> => {
          const authority = certificationAuthorityProof(owner);
          const subjectHash = authority.subjectHashCandidates[0];
          if (subjectHash === undefined) {
            throw new Error('AgentMission PostgreSQL subject hash fixture is missing.');
          }
          const sessionId = randomUUID();
          const reservedAt = new Date();
          await deployer.$transaction(async (transaction) => {
            await transaction.$executeRawUnsafe('SET LOCAL ROLE bob_schema_owner');
            await transaction.$executeRaw`
              SELECT set_config('app.current_company_id', ${owner.companyId}, true)
            `;
            await transaction.$executeRaw`
              SELECT set_config('app.current_user_id', ${owner.ownerUserId}, true)
            `;
            await transaction.realtimeSessionLease.create({
              data: {
                companyId: owner.companyId,
                subjectHash,
                sessionId,
                leaseTokenHash: sha256Hex(`agent-mission-cert-lease:${key}`),
                state: 'active',
                providerId: 'openai',
                providerCallId: `agent-mission-cert-${sessionId}`,
                reservedAt,
                leaseExpiresAt: new Date(reservedAt.getTime() + 10 * 60_000),
                hardExpiresAt: new Date(reservedAt.getTime() + 20 * 60_000),
                activatedAt: reservedAt,
                agentMissionProtocolVersion: 1,
                agentMissionProtocolBoundAt: reservedAt,
                agentMissionCapabilityHash: authority.capabilityHash,
                agentMissionReleaseFlagVersion: 1,
                updatedAt: reservedAt,
              },
            });
            await transaction.realtimeSessionLease.update({
              where: {
                realtime_session_lease_subject: {
                  companyId: owner.companyId,
                  subjectHash,
                },
              },
              // Le trigger remplace cette sentinelle par clock_timestamp() et n'autorise qu'une
              // transition NULL -> reçu sur une lease V1 déjà persistée.
              data: {
                agentMissionBootstrapAcknowledgedAt: reservedAt,
              },
            });
          });
          return authority;
        })();
        authorityByOwner.set(key, creating);
        return creating;
      };
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
      for (const [id, companyId, name] of [
        [exactCustomerId, companyA, 'Camping Les Pins'],
        [fuzzyCustomerIds[0] ?? '', companyA, 'RATP Fontaines Bastille'],
        [fuzzyCustomerIds[1] ?? '', companyA, 'RATP Fontaines Nation'],
        [fuzzyCustomerIds[2] ?? '', companyA, 'RATP Fontaines République'],
        ...manyCustomerIds.map((id, index) => (
          [id, companyA, `Entretien vitrines secteur ${index + 1}`] as const
        )),
        [foreignExactCustomerId, companyB, 'Camping Les Pins'],
      ] as const) {
        await admin.$executeRaw`
          INSERT INTO public.customers ("id", "companyId", "name")
          VALUES (${id}, ${companyId}, ${name})
        `;
      }
    }, 30_000);

    async function publishQuoteScreenContext(
      owner: AgentMissionOwner,
      rawContext?: Readonly<Record<string, unknown>>,
      options: Readonly<{ apply?: boolean }> = {},
    ): Promise<{
      readonly sessionId: string;
      readonly revision: number;
      readonly digest: string;
    }> {
      const authority = await authorizeOwner(owner);
      const subjectHash = authority.subjectHashCandidates[0];
      if (subjectHash === undefined) {
        throw new Error('AgentMission context fixture subject hash is missing.');
      }
      const canonicalContext = {
        screen: {
          name: '/devis/new',
          instanceId: `quote-screen-${randomUUID()}`,
        },
        entities: [],
        capabilities: ['screen.read' as const],
      };
      const revision = 3;
      const prepared = prepareRealtimeContext({
        version: 1,
        revision,
        context: rawContext ?? canonicalContext,
      });
      if (prepared === null) {
        throw new Error('AgentMission context fixture is invalid.');
      }
      const lease = await admin.realtimeSessionLease.findUniqueOrThrow({
        where: {
          realtime_session_lease_subject: {
            companyId: owner.companyId,
            subjectHash,
          },
        },
      });
      const updatedAt = new Date(Math.max(Date.now(), lease.reservedAt.getTime() + 1));
      const ownerLeaseExpiresAt = new Date(Math.min(
        lease.hardExpiresAt.getTime() - 1,
        updatedAt.getTime() + 5 * 60_000,
      ));
      if (ownerLeaseExpiresAt.getTime() <= updatedAt.getTime()) {
        throw new Error('AgentMission context fixture lease is already expired.');
      }
      const ownerNonce = randomUUID();
      await deployer.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe('SET LOCAL ROLE bob_schema_owner');
        await transaction.$executeRaw`
          SELECT set_config('app.current_company_id', ${owner.companyId}, true)
        `;
        await transaction.$executeRaw`
          SELECT set_config('app.current_user_id', ${owner.ownerUserId}, true)
        `;
        await transaction.realtimeSessionLease.update({
          where: {
            realtime_session_lease_subject: {
              companyId: owner.companyId,
              subjectHash,
            },
          },
          data: {
            contextSchemaVersion: 1,
            contextRevision: revision,
            contextPayload: JSON.parse(JSON.stringify(
              rawContext ?? canonicalContext,
            )) as Prisma.InputJsonValue,
            contextDigest: prepared.digest,
            contextUpdatedAt: updatedAt,
            sidebandOwnerInstanceHash: sha256Hex(`instance:${ownerNonce}`),
            sidebandOwnerTokenHash: sha256Hex(`token:${ownerNonce}`),
            sidebandOwnerLeaseExpiresAt: ownerLeaseExpiresAt,
            sidebandOwnerEpoch: 1,
            contextAppliedRevision: null,
            contextAppliedDigest: null,
            contextAppliedAt: null,
            contextAppliedOwnerEpoch: null,
            updatedAt,
            version: { increment: 1 },
          },
        });
        if (options.apply !== false) {
          await transaction.realtimeSessionLease.update({
            where: {
              realtime_session_lease_subject: {
                companyId: owner.companyId,
                subjectHash,
              },
            },
            data: {
              contextAppliedRevision: revision,
              contextAppliedDigest: prepared.digest,
              contextAppliedAt: updatedAt,
              contextAppliedOwnerEpoch: 1,
              updatedAt,
              version: { increment: 1 },
            },
          });
        }
      });
      return {
        sessionId: lease.sessionId,
        revision,
        digest: prepared.digest,
      };
    }

    async function prepareMissionForCancellation(
      owner: AgentMissionOwner,
      reason: CancelQuoteAgentMissionInput['reason'],
    ) {
      if (reason === 'user_cancelled') {
        const started = await start(uowA).execute({
          ...owner,
          commandId: randomUUID(),
        });
        if (!started.ok) {
          throw new Error(`start cancellation fixture failed:${JSON.stringify(started.error)}`);
        }
        return started.value.mission;
      }

      // `manual_handoff` est volontairement réservé à awaiting_lines : la certification DB
      // traverse donc le vrai chemin voix → résolution tenantée → ACK écran → continuation,
      // au lieu de fabriquer une phase ou d'affaiblir l'invariant du domaine.
      const context = await publishQuoteScreenContext(owner);
      const turnId = randomUUID();
      const started = await start(uowA).execute({
        ...owner,
        commandId: turnId,
        customerReference: 'Camping Les Pins',
        origin: {
          actor: 'user_voice',
          correlation: {
            realtimeSessionId: context.sessionId,
            turnId,
            contextRevision: context.revision,
            contextDigest: context.digest,
          },
        },
      });
      if (!started.ok) {
        throw new Error(`manual handoff start fixture failed:${JSON.stringify(started)}`);
      }
      const mission = started.value.mission;
      const draft = mission.payload.draft;
      if (draft === null) {
        throw new Error('manual handoff start fixture returned no draft');
      }
      const acknowledgementCommandId = randomUUID();
      const acknowledged = await acknowledge(uowA).execute({
        ...owner,
        missionId: mission.id,
        commandId: acknowledgementCommandId,
        expectedMissionRevision: mission.revision,
        realtimeSessionId: context.sessionId,
        contextRevision: context.revision,
        contextDigest: context.digest,
        draftSessionId: draft.sessionId,
        expectedDraftSlotRevision: draft.slotRevision,
        expectedDraftContentRevision: draft.contentRevision,
      });
      if (!acknowledged.ok) {
        throw new Error(`manual handoff ACK fixture failed:${JSON.stringify(acknowledged.error)}`);
      }
      const advanced = await advance(uowA).execute({
        ...owner,
        missionId: mission.id,
        acknowledgementCommandId,
      });
      if (!advanced.ok || advanced.value.mission.phase !== 'awaiting_lines') {
        throw new Error(`manual handoff advance fixture failed:${JSON.stringify(advanced)}`);
      }
      return advanced.value.mission;
    }

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
          OR has_function_privilege(
            exposed.role_name,
            'public.guard_realtime_agent_mission_capability_immutable_v1()',
            'EXECUTE'
          )
          OR has_function_privilege(
            exposed.role_name,
            'public.guard_realtime_agent_mission_bootstrap_receipt_v1()',
            'EXECUTE'
          )
      `;
      expect(exposedFunctions).toEqual([]);
    });

    it('relit et décode le QuoteDraftPayloadV1 N-1 exact après le train M2-A-0', async () => {
      const legacyOwner = {
        companyId: 'writer-n1-company',
        ownerUserId: 'writer-n1-owner',
      };
      const row = await workerA.withIsolatedOwner(
        legacyOwner.companyId,
        legacyOwner.ownerUserId,
        (transaction) => transaction.quoteDraftSlot.findUnique({
          where: { quote_draft_slot_owner: legacyOwner },
          select: {
            payloadVersion: true,
            payload: true,
            agentMissionId: true,
          },
        }),
        {
          maxWaitMs: 5_000,
          timeoutMs: 10_000,
          readOnly: true,
          isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        },
      );
      expect(row).not.toBeNull();
      if (row === null) return;
      expect(row.payloadVersion).toBe(1);
      expect(row.agentMissionId).toBeNull();
      const decoded = parseQuoteDraftPayload(row.payload);
      expect(decoded).toMatchObject({
        ok: true,
        value: {
          schema: 'bob.quote-draft',
          version: 1,
          draft: {
            sessionId: 'n1',
            contentRevision: 0,
            stagingRevision: 0,
            step: 'client',
            customer: null,
            lines: [],
            lineMetadata: [],
          },
        },
      });
    });

    it('appelle réellement le repository de lignes sous RLS, savepoint et CAS', async () => {
      const ownerA = {
        companyId: companyA,
        ownerUserId: `owner-quote-line-work-a-${randomUUID()}`,
      };
      const ownerB = {
        companyId: companyA,
        ownerUserId: `owner-quote-line-work-b-${randomUUID()}`,
      };
      const [startedA, startedB] = await Promise.all([
        start(uowA).execute({ ...ownerA, commandId: randomUUID() }),
        start(uowB).execute({ ...ownerB, commandId: randomUUID() }),
      ]);
      if (!startedA.ok || !startedB.ok) {
        throw new Error(
          `quote line work mission fixture failed:${JSON.stringify({ startedA, startedB })}`,
        );
      }
      const missionA = startedA.value.mission;
      const missionB = startedB.value.mission;
      const createdAt = new Date().toISOString();
      const makeWorkItem = (
        owner: AgentMissionOwner,
        missionId: string,
        id: string,
        ordinal: number,
      ): AgentMissionQuoteLineWork => ({
        id,
        companyId: owner.companyId,
        ownerUserId: owner.ownerUserId,
        missionId,
        ordinal,
        revision: 1,
        state: 'queued',
        origin: 'user_voice',
        serviceReference: 'Main-d’œuvre plomberie',
        category: 'labor',
        quantityMilli: 2_000,
        unit: 'heure',
        unitPriceCents: 5_500,
        requestedVatRate: 20,
        priceBasis: 'per_unit',
        housingOlderThan2y: null,
        energyRenovation: null,
        requiredFact: null,
        catalogueItemId: null,
        expectedCatalogueRevision: null,
        proposalId: null,
        proposalRevision: null,
        proposalDiffHash: null,
        createdAt,
        updatedAt: createdAt,
      });
      const runOwner = async <T>(
        uow: PrismaAgentMissionUnitOfWork,
        owner: AgentMissionOwner,
        work: (transaction: AgentMissionTransaction) => Promise<T>,
      ): Promise<T> => {
        const result = await uow.runQuoteCreationOwner(
          owner,
          await authorizeOwner(owner),
          work,
        );
        if (result.status !== 'executed') {
          throw new Error(`quote line work transaction rejected:${JSON.stringify(result)}`);
        }
        return result.value;
      };

      // La collision de PK appartient à un autre owner et reste donc invisible au pré-check RLS.
      // Le createMany doit échouer atomiquement, revenir au savepoint puis laisser la transaction
      // utilisable — sans conserver le premier item du batch.
      const globalCollisionId = randomUUID();
      const foreignCollision = makeWorkItem(
        ownerB,
        missionB.id,
        globalCollisionId,
        1,
      );
      expect(await runOwner(uowB, ownerB, (transaction) =>
        transaction.quoteLineWork.insertMany({
          ...ownerB,
          missionId: missionB.id,
          workItems: [foreignCollision],
        }),
      )).toBe('inserted');

      const workA = makeWorkItem(ownerA, missionA.id, randomUUID(), 1);
      const collidingWorkA = makeWorkItem(
        ownerA,
        missionA.id,
        globalCollisionId,
        2,
      );
      expect(await runOwner(uowA, ownerA, async (transaction) => {
        const outcome = await transaction.quoteLineWork.insertMany({
          ...ownerA,
          missionId: missionA.id,
          workItems: [workA, collidingWorkA],
        });
        const afterConflict = await transaction.quoteLineWork.listForUpdate({
          ...ownerA,
          missionId: missionA.id,
        });
        return { outcome, afterConflict };
      })).toEqual({ outcome: 'conflict', afterConflict: [] });

      const workA2: AgentMissionQuoteLineWork = {
        ...makeWorkItem(ownerA, missionA.id, randomUUID(), 2),
        serviceReference: 'Contrat entretien annuel',
        category: 'subscription',
        unit: 'mois',
        requestedVatRate: 2.1,
      };
      expect(await runOwner(uowA, ownerA, (transaction) =>
        transaction.quoteLineWork.insertMany({
          ...ownerA,
          missionId: missionA.id,
          workItems: [workA, workA2],
        }),
      )).toBe('inserted');

      const listed = await runOwner(uowA, ownerA, (transaction) =>
        transaction.quoteLineWork.listForUpdate({
          ...ownerA,
          missionId: missionA.id,
        }),
      );
      expect(listed.map((item) => [item.id, item.ordinal])).toEqual([
        [workA.id, 1],
        [workA2.id, 2],
      ]);
      expect(await runOwner(uowA, ownerA, (transaction) =>
        transaction.quoteLineWork.findByIdForUpdate({
          ...ownerA,
          missionId: missionA.id,
          workItemId: workA.id,
        }),
      )).toEqual(workA);

      // Même en fournissant les identifiants exacts, une transaction autorisée pour ownerB ne
      // peut ni verrouiller la mission A ni découvrir son work item.
      expect(await runOwner(uowB, ownerB, (transaction) =>
        transaction.quoteLineWork.findByIdForUpdate({
          ...ownerA,
          missionId: missionA.id,
          workItemId: workA.id,
        }),
      )).toBeNull();

      const revisedWorkA: AgentMissionQuoteLineWork = {
        ...workA,
        revision: 2,
        state: 'awaiting_details',
        requiredFact: 'vat_rate',
        updatedAt: new Date(Date.parse(createdAt) + 1_000).toISOString(),
      };
      expect(await runOwner(uowA, ownerA, (transaction) =>
        transaction.quoteLineWork.updateCas({
          workItem: revisedWorkA,
          expectedRevision: 1,
        }),
      )).toBe('updated');
      expect(await runOwner(uowA, ownerA, (transaction) =>
        transaction.quoteLineWork.updateCas({
          workItem: revisedWorkA,
          expectedRevision: 1,
        }),
      )).toBe('revision_conflict');
      expect(await runOwner(uowA, ownerA, (transaction) =>
        transaction.quoteLineWork.delete({
          ...ownerA,
          missionId: missionA.id,
          workItemId: workA.id,
          expectedRevision: 1,
        }),
      )).toBe('revision_conflict');
      expect(await runOwner(uowA, ownerA, (transaction) =>
        transaction.quoteLineWork.delete({
          ...ownerA,
          missionId: missionA.id,
          workItemId: workA.id,
          expectedRevision: 2,
        }),
      )).toBe('deleted');
      expect(await runOwner(uowA, ownerA, (transaction) =>
        transaction.quoteLineWork.deleteAll({
          ...ownerA,
          missionId: missionA.id,
        }),
      )).toBe(1);
      expect(await runOwner(uowB, ownerB, (transaction) =>
        transaction.quoteLineWork.deleteAll({
          ...ownerB,
          missionId: missionB.id,
        }),
      )).toBe(1);
    });

    it('ferme get/start/cancel/screen-ack avant le reçu durable puis ouvre exactement après ACK', async () => {
      const owner = {
        companyId: companyA,
        ownerUserId: `owner-pre-bootstrap-receipt-${randomUUID()}`,
      };
      const authority = certificationAuthorityProof(owner);
      const subjectHash = authority.subjectHashCandidates[0];
      if (subjectHash === undefined) {
        throw new Error('AgentMission pre-receipt subject fixture is missing.');
      }
      const realtimeSessionId = randomUUID();
      const reservedAt = new Date();
      const initialLeaseExpiresAt = new Date(reservedAt.getTime() + 15_000);
      await deployer.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe('SET LOCAL ROLE bob_schema_owner');
        await transaction.$executeRaw`
          SELECT set_config('app.current_company_id', ${owner.companyId}, true)
        `;
        await transaction.$executeRaw`
          SELECT set_config('app.current_user_id', ${owner.ownerUserId}, true)
        `;
        await transaction.realtimeSessionLease.create({
          data: {
            companyId: owner.companyId,
            subjectHash,
            sessionId: realtimeSessionId,
            leaseTokenHash: sha256Hex(
              `agent-mission-pre-receipt-lease:${owner.ownerUserId}`,
            ),
            state: 'active',
            providerId: 'openai',
            providerCallId: `agent-mission-pre-receipt-${realtimeSessionId}`,
            reservedAt,
            leaseExpiresAt: initialLeaseExpiresAt,
            hardExpiresAt: new Date(reservedAt.getTime() + 10 * 60_000),
            activatedAt: reservedAt,
            agentMissionProtocolVersion: 1,
            agentMissionProtocolBoundAt: reservedAt,
            agentMissionCapabilityHash: authority.capabilityHash,
            agentMissionReleaseFlagVersion: 1,
            updatedAt: reservedAt,
          },
        });
      });

      const getResult = await new GetActiveAgentMission({
        unitOfWork: uowA,
      }).execute(owner, authority);
      const startResult = await start(uowA).execute({
        ...owner,
        commandId: randomUUID(),
      }, authority);
      const cancelResult = await new CancelQuoteAgentMission({
        unitOfWork: uowA,
        fingerprints: FINGERPRINTS,
        ids: ids(),
      }).execute({
        ...owner,
        authority,
        missionId: randomUUID(),
        commandId: randomUUID(),
        expectedRevision: 1,
        reason: 'user_cancelled',
        actor: 'user_tap',
      });
      const screenAckResult = await new AcknowledgeQuoteScreen({
        unitOfWork: uowA,
        fingerprints: FINGERPRINTS,
        ids: ids(),
      }).execute({
        ...owner,
        authority,
        missionId: randomUUID(),
        commandId: randomUUID(),
        expectedMissionRevision: 1,
        realtimeSessionId,
        contextRevision: 1,
        contextDigest: 'a'.repeat(64),
        draftSessionId: 'pre-bootstrap-receipt-draft',
        expectedDraftSlotRevision: 1,
        expectedDraftContentRevision: 0,
      });

      for (const result of [
        getResult,
        startResult,
        cancelResult,
        screenAckResult,
      ]) {
        expect(result).toEqual({
          ok: false,
          error: {
            kind: 'forbidden',
            reason: 'agent_mission_capability_invalid',
          },
        });
      }
      expect(await admin.agentMission.count({ where: owner })).toBe(0);
      expect(await admin.agentMissionEvent.count({ where: owner })).toBe(0);
      expect(await admin.quoteDraftSlot.count({ where: owner })).toBe(0);
      expect(await admin.realtimeSessionLease.findUniqueOrThrow({
        where: {
          realtime_session_lease_subject: {
            companyId: owner.companyId,
            subjectHash,
          },
        },
      })).toMatchObject({
        sessionId: realtimeSessionId,
        agentMissionBootstrapAcknowledgedAt: null,
        version: 1,
      });

      const admissionPolicy: RealtimeAdmissionPolicy = {
        globalCapacity: {
          providerId: 'openai',
          providerModel: 'gpt-realtime',
          globalMaxSessions: 100,
          providerMaxSessions: 100,
          configVersion: 1,
        },
        userLimitPerMinute: 3,
        userLimitPerHour: 30,
        tenantLimitPerMinute: 50,
        tenantLimitPerHour: 1_000,
        reservationTtlSeconds: 15,
        activeLeaseSeconds: 30,
        heartbeatSeconds: 10,
        reaperLeaseSeconds: 30,
      };
      const admission = new PrismaRealtimeAdmission(workerA, admissionPolicy);
      const receiptInput = {
        companyId: owner.companyId,
        subjectHashCandidates: authority.subjectHashCandidates,
        principalBindingHash: authority.principalBindingHash,
        sessionId: realtimeSessionId,
        capabilityHash: authority.capabilityHash,
      };
      const acknowledged = await admission.acknowledgeAgentMissionBootstrap(receiptInput);
      expect(acknowledged).toMatchObject({
        ok: true,
        status: 'acknowledged',
      });
      const replayed = await admission.acknowledgeAgentMissionBootstrap(receiptInput);
      expect(replayed).toEqual({
        ...acknowledged,
        status: 'replayed',
      });
      expect(await new GetActiveAgentMission({
        unitOfWork: uowA,
      }).execute(owner, authority)).toEqual({ ok: true, value: null });

      const acknowledgedLease = await admin.realtimeSessionLease.findUniqueOrThrow({
        where: {
          realtime_session_lease_subject: {
            companyId: owner.companyId,
            subjectHash,
          },
        },
      });
      expect(acknowledgedLease.agentMissionBootstrapAcknowledgedAt)
        .toBeInstanceOf(Date);
      expect(acknowledgedLease.leaseExpiresAt.getTime())
        .toBeGreaterThan(initialLeaseExpiresAt.getTime());
      expect(acknowledgedLease.version).toBe(2);
    });

    it('sérialise la course reçu/reaper sans double autorité', async () => {
      const owner = {
        companyId: companyA,
        ownerUserId: `owner-bootstrap-reaper-race-${randomUUID()}`,
      };
      const authority = certificationAuthorityProof(owner);
      const subjectHash = authority.subjectHashCandidates[0];
      if (subjectHash === undefined) {
        throw new Error('AgentMission receipt/reaper race subject fixture is missing.');
      }
      const realtimeSessionId = randomUUID();
      const reservedAt = new Date();
      await deployer.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe('SET LOCAL ROLE bob_schema_owner');
        await transaction.$executeRaw`
          SELECT set_config('app.current_company_id', ${owner.companyId}, true)
        `;
        await transaction.$executeRaw`
          SELECT set_config('app.current_user_id', ${owner.ownerUserId}, true)
        `;
        await transaction.realtimeSessionLease.create({
          data: {
            companyId: owner.companyId,
            subjectHash,
            sessionId: realtimeSessionId,
            leaseTokenHash: sha256Hex(
              `agent-mission-receipt-reaper-race:${owner.ownerUserId}`,
            ),
            state: 'active',
            providerId: 'openai',
            providerCallId: `agent-mission-receipt-reaper-race-${realtimeSessionId}`,
            reservedAt,
            leaseExpiresAt: new Date(reservedAt.getTime() + 15_000),
            hardExpiresAt: new Date(reservedAt.getTime() + 10 * 60_000),
            activatedAt: reservedAt,
            agentMissionProtocolVersion: 1,
            agentMissionProtocolBoundAt: reservedAt,
            agentMissionCapabilityHash: authority.capabilityHash,
            agentMissionReleaseFlagVersion: 1,
            updatedAt: reservedAt,
          },
        });
      });

      const admissionPolicy: RealtimeAdmissionPolicy = {
        globalCapacity: {
          providerId: 'openai',
          providerModel: 'gpt-realtime',
          globalMaxSessions: 100,
          providerMaxSessions: 100,
          configVersion: 1,
        },
        userLimitPerMinute: 3,
        userLimitPerHour: 30,
        tenantLimitPerMinute: 50,
        tenantLimitPerHour: 1_000,
        reservationTtlSeconds: 15,
        activeLeaseSeconds: 30,
        heartbeatSeconds: 10,
        reaperLeaseSeconds: 30,
      };
      const receiptAdmission = new PrismaRealtimeAdmission(workerA, admissionPolicy);
      const reaperAdmission = new PrismaRealtimeAdmission(workerB, admissionPolicy);
      const identity = {
        companyId: owner.companyId,
        subjectHashCandidates: authority.subjectHashCandidates,
        principalBindingHash: authority.principalBindingHash,
        sessionId: realtimeSessionId,
      };

      const [receipt, termination] = await Promise.all([
        receiptAdmission.acknowledgeAgentMissionBootstrap({
          ...identity,
          capabilityHash: authority.capabilityHash,
        }),
        reaperAdmission.claimTermination(identity),
      ]);

      expect(termination.ok, JSON.stringify(termination)).toBe(true);
      if (!termination.ok) return;
      expect(termination.pending).toBe(false);
      expect(termination.claim).not.toBeNull();
      expect(['acknowledged', 'state']).toContain(
        receipt.ok ? receipt.status : receipt.reason,
      );

      const lease = await admin.realtimeSessionLease.findUniqueOrThrow({
        where: {
          realtime_session_lease_subject: {
            companyId: owner.companyId,
            subjectHash,
          },
        },
      });
      expect(lease.state).toBe('reaping');
      expect(lease.reaperTokenHash).toMatch(/^[a-f0-9]{64}$/u);
      expect(lease.agentMissionBootstrapAcknowledgedAt === null)
        .toBe(!receipt.ok);
      expect(await new GetActiveAgentMission({
        unitOfWork: uowA,
      }).execute(owner, authority)).toEqual({
        ok: false,
        error: {
          kind: 'forbidden',
          reason: 'agent_mission_capability_invalid',
        },
      });
      expect(await admin.agentMission.count({ where: owner })).toBe(0);
      expect(await admin.agentMissionEvent.count({ where: owner })).toBe(0);
      expect(await admin.quoteDraftSlot.count({ where: owner })).toBe(0);

      if (termination.claim !== null) {
        await expect(reaperAdmission.completeReaping({
          companyId: termination.claim.companyId,
          subjectHash: termination.claim.subjectHash,
          sessionId: termination.claim.sessionId,
          reaperToken: termination.claim.reaperToken,
        })).resolves.toEqual({ ok: true, reason: null });
      }
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
        readQuoteCreationOwner: (scope, authority, work) =>
          uowA.readQuoteCreationOwner(scope, authority, work),
        runQuoteCreationOwner: (scope, authority, work) =>
          uowA.runQuoteCreationOwner(scope, authority, async (transaction) => {
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
      expect(await start(uowA).execute(
        { ...owner, commandId: randomUUID() },
        certificationAuthorityProof(owner),
      )).toEqual({
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

    it('force le rollback réel si PostgreSQL annule la transaction après une écriture', async () => {
      const owner = {
        companyId: companyA,
        ownerUserId: `owner-timeout-rollback-${randomUUID()}`,
      };
      const legacy = new PrismaQuoteDraftSlotRepository(workerA);

      const result = await new PrismaAgentMissionDraftFence(workerA)
        .runLegacyMutationIfUnowned(owner, async () => {
          expect(await legacy.upsert({
            ...owner,
            expectedRevision: 0,
            payload: emptyPayload('must-be-rolled-back'),
          })).toMatchObject({ status: 'created' });
          const transaction = workerA.client() as Prisma.TransactionClient;
          await transaction.$executeRaw`
            SELECT set_config('statement_timeout', '20ms', true)
          `;
          await transaction.$queryRaw`SELECT pg_sleep(0.1)`;
          return 'unreachable';
        });

      expect(result).toEqual({
        status: 'foreground_unavailable',
        reason: 'query_canceled',
      });
      expect(await admin.quoteDraftSlot.count({ where: owner })).toBe(0);
    });

    it('traduit une expiration P2028 émise par la vraie transaction interactive Prisma', async () => {
      const owner = {
        companyId: companyA,
        ownerUserId: `owner-prisma-expired-${randomUUID()}`,
      };
      const expiringPrisma = {
        withIsolatedOwner: <T>(
          companyId: string,
          ownerUserId: string,
          work: (transaction: Prisma.TransactionClient) => Promise<T>,
          options: IsolatedOwnerTransactionOptions,
        ) => workerA.withIsolatedOwner(companyId, ownerUserId, work, {
          ...options,
          timeoutMs: 500,
        }),
      } as PrismaService;
      let callbackReached = false;

      const result = await new PrismaAgentMissionDraftFence(expiringPrisma)
        .runLegacyMutationIfUnowned(owner, async () => {
          callbackReached = true;
          await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
          const transaction = workerA.client() as Prisma.TransactionClient;
          await transaction.$queryRaw`SELECT 1`;
          return 'unreachable';
        });

      expect(callbackReached).toBe(true);
      expect(result).toEqual({
        status: 'foreground_unavailable',
        reason: 'transaction_timeout',
      });
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

    it('ACK écran relit lease, contexte et draft réels, puis rejoue sans écrire', async () => {
      const owner = {
        companyId: companyA,
        ownerUserId: `owner-screen-ack-${randomUUID()}`,
      };
      const started = await start(uowA).execute({ ...owner, commandId: randomUUID() });
      expect(started.ok, JSON.stringify(started)).toBe(true);
      if (!started.ok || started.value.mission.payload.draft === null) return;
      const draft = started.value.mission.payload.draft;
      const context = await publishQuoteScreenContext(owner);
      const command = {
        ...owner,
        missionId: started.value.mission.id,
        commandId: randomUUID(),
        expectedMissionRevision: started.value.mission.revision,
        realtimeSessionId: context.sessionId,
        contextRevision: context.revision,
        contextDigest: context.digest,
        draftSessionId: draft.sessionId,
        expectedDraftSlotRevision: draft.slotRevision,
        expectedDraftContentRevision: draft.contentRevision,
      };

      const accepted = await acknowledge(uowA).execute(command);
      expect(accepted, JSON.stringify(accepted)).toMatchObject({
        ok: true,
        value: {
          outcome: 'acknowledged',
          mission: {
            revision: 2,
            phase: 'awaiting_customer',
            currentBinding: {
              realtimeSessionId: context.sessionId,
              contextRevision: context.revision,
              contextDigest: context.digest,
              screenName: '/devis/new',
            },
          },
        },
      });
      const missionAfterAck = await admin.agentMission.findUniqueOrThrow({
        where: { id: started.value.mission.id },
      });
      const eventsAfterAck = await admin.agentMissionEvent.findMany({
        where: { missionId: started.value.mission.id },
        orderBy: { sequence: 'asc' },
      });
      expect(missionAfterAck).toMatchObject({
        revision: 2,
        phase: 'awaiting_customer',
      });
      expect(eventsAfterAck).toHaveLength(2);
      expect(eventsAfterAck[1]).toMatchObject({
        eventType: 'screen_acknowledged',
        actor: 'system',
        commandId: command.commandId,
        realtimeSessionId: context.sessionId,
        contextRevision: context.revision,
        contextDigest: context.digest,
        turnId: null,
      });

      const replayed = await acknowledge(uowB).execute(command);
      expect(replayed).toMatchObject({
        ok: true,
        value: { outcome: 'replayed', mission: { revision: 2 } },
      });
      expect(await admin.agentMission.findUniqueOrThrow({
        where: { id: started.value.mission.id },
      })).toEqual(missionAfterAck);
      expect(await admin.agentMissionEvent.findMany({
        where: { missionId: started.value.mission.id },
        orderBy: { sequence: 'asc' },
      })).toEqual(eventsAfterAck);

      const collision = await acknowledge(uowA).execute({
        ...command,
        expectedDraftContentRevision: command.expectedDraftContentRevision + 1,
      });
      expect(collision).toMatchObject({
        ok: false,
        error: {
          kind: 'conflict',
          entity: 'agent_mission_command',
          reason: 'fingerprint_mismatch',
        },
      });
      expect(await admin.agentMissionEvent.count({
        where: { missionId: started.value.mission.id },
      })).toBe(2);
    });

    it('enchaîne voix → client exact tenanté → ACK → sélection atomique et replay concurrent', async () => {
      const owner = {
        companyId: companyA,
        ownerUserId: `owner-exact-customer-${randomUUID()}`,
      };
      const context = await publishQuoteScreenContext(owner);
      const turnId = randomUUID();
      const started = await start(uowA).execute({
        ...owner,
        commandId: turnId,
        customerReference: 'camping les pins',
        origin: {
          actor: 'user_voice',
          correlation: {
            realtimeSessionId: context.sessionId,
            turnId,
            contextRevision: context.revision,
            contextDigest: context.digest,
          },
        },
      });
      expect(started, JSON.stringify(started)).toMatchObject({
        ok: true,
        value: {
          outcome: 'created',
          mission: {
            payload: {
              stagedCustomerResolution: {
                kind: 'exact',
                customerId: exactCustomerId,
              },
            },
          },
        },
      });
      if (!started.ok || started.value.mission.payload.draft === null) return;
      const missionId = started.value.mission.id;
      const draft = started.value.mission.payload.draft;
      const startEvent = await admin.agentMissionEvent.findFirstOrThrow({
        where: { missionId, sequence: 1 },
      });
      expect(startEvent).toMatchObject({
        actor: 'user_voice',
        realtimeSessionId: context.sessionId,
        turnId,
        contextRevision: context.revision,
        contextDigest: context.digest,
      });

      const acknowledgementCommandId = randomUUID();
      const acknowledged = await acknowledge(uowA).execute({
        ...owner,
        missionId,
        commandId: acknowledgementCommandId,
        expectedMissionRevision: started.value.mission.revision,
        realtimeSessionId: context.sessionId,
        contextRevision: context.revision,
        contextDigest: context.digest,
        draftSessionId: draft.sessionId,
        expectedDraftSlotRevision: draft.slotRevision,
        expectedDraftContentRevision: draft.contentRevision,
      });
      expect(acknowledged, JSON.stringify(acknowledged)).toMatchObject({
        ok: true,
        value: {
          outcome: 'acknowledged',
          receipt: {
            ackCommandId: acknowledgementCommandId,
            missionId,
            missionRevisionAfter: 2,
            realtimeSessionId: context.sessionId,
            contextRevision: context.revision,
            contextDigest: context.digest,
          },
        },
      });
      if (!acknowledged.ok) return;

      const advanceCommand = {
        ...owner,
        missionId,
        acknowledgementCommandId,
      };
      const [left, right] = await Promise.all([
        advance(uowA).execute(advanceCommand),
        advance(uowB).execute(advanceCommand),
      ]);
      expect(left.ok, JSON.stringify(left)).toBe(true);
      expect(right.ok, JSON.stringify(right)).toBe(true);
      expect([left, right]
        .filter((result) => result.ok)
        .map((result) => result.value.outcome)
        .sort()).toEqual(['advanced', 'replayed']);

      const slot = await admin.quoteDraftSlot.findUniqueOrThrow({
        where: {
          quote_draft_slot_owner: {
            companyId: owner.companyId,
            ownerUserId: owner.ownerUserId,
          },
        },
      });
      expect(slot).toMatchObject({
        revision: 2,
        agentMissionId: missionId,
      });
      expect(slot.payload).toMatchObject({
        draft: {
          contentRevision: 1,
          step: 'lignes',
          customer: {
            id: exactCustomerId,
            name: 'Camping Les Pins',
          },
        },
      });
      const mission = await admin.agentMission.findUniqueOrThrow({
        where: { id: missionId },
      });
      expect(mission).toMatchObject({
        revision: 3,
        phase: 'awaiting_lines',
      });
      expect(mission.payload).toMatchObject({ stagedCustomerResolution: null });
      const events = await admin.agentMissionEvent.findMany({
        where: { missionId },
        orderBy: { sequence: 'asc' },
      });
      expect(events).toHaveLength(3);
      expect(events[2]).toMatchObject({
        eventType: 'customer_selected',
        actor: 'system',
        realtimeSessionId: context.sessionId,
        turnId: null,
        contextRevision: context.revision,
        contextDigest: context.digest,
        data: {
          kind: 'customer_selected',
          customerId: exactCustomerId,
          source: 'exact_match',
        },
      });
      expect(events[2]?.commandId[14]).toBe('8');

      const replayedAck = await acknowledge(uowA).execute({
        ...owner,
        missionId,
        commandId: acknowledgementCommandId,
        expectedMissionRevision: started.value.mission.revision,
        realtimeSessionId: context.sessionId,
        contextRevision: context.revision,
        contextDigest: context.digest,
        draftSessionId: draft.sessionId,
        expectedDraftSlotRevision: draft.slotRevision,
        expectedDraftContentRevision: draft.contentRevision,
      });
      expect(replayedAck).toMatchObject({
        ok: true,
        value: {
          outcome: 'replayed',
          receipt: acknowledged.value.receipt,
          mission: { revision: 3 },
        },
      });
      expect(await admin.agentMissionEvent.count({ where: { missionId } })).toBe(3);
    });

    it('refuse le tour voix avant contexte réellement appliqué sans aucune écriture métier', async () => {
      const owner = {
        companyId: companyA,
        ownerUserId: `owner-context-not-applied-${randomUUID()}`,
      };
      const context = await publishQuoteScreenContext(owner, undefined, { apply: false });
      const turnId = randomUUID();

      const rejected = await start(uowA).execute({
        ...owner,
        commandId: turnId,
        customerReference: 'camping les pins',
        origin: {
          actor: 'user_voice',
          correlation: {
            realtimeSessionId: context.sessionId,
            turnId,
            contextRevision: context.revision,
            contextDigest: context.digest,
          },
        },
      });

      expect(rejected).toEqual({
        ok: false,
        error: {
          kind: 'conflict',
          entity: 'agent_mission_command',
          reason: 'context_stale',
        },
      });
      expect(await admin.agentMission.count({ where: owner })).toBe(0);
      expect(await admin.agentMissionEvent.count({ where: owner })).toBe(0);
      expect(await admin.quoteDraftSlot.count({ where: owner })).toBe(0);
    });

    it.each([
      {
        label: 'zéro candidat',
        query: 'Client réellement absent 74f8a6',
        stagedKind: 'none',
        nextPhase: 'awaiting_customer',
        eventType: 'customer_not_found',
        eventResult: 'none',
      },
      {
        label: 'plus de cinq candidats',
        query: 'Entretien vitrines',
        stagedKind: 'too_many',
        nextPhase: 'awaiting_customer',
        eventType: 'customer_not_found',
        eventResult: 'too_many',
      },
      {
        label: 'plusieurs candidats ordonnés',
        query: 'RATP Fontaines',
        stagedKind: 'choices',
        nextPhase: 'awaiting_customer_choice',
        eventType: 'customer_choice_presented',
        eventResult: null,
      },
    ])(
      'résout $label par la recherche PostgreSQL puis poursuit après ACK',
      async ({
        query,
        stagedKind,
        nextPhase,
        eventType,
        eventResult,
      }) => {
        const owner = {
          companyId: companyA,
          ownerUserId: `owner-customer-resolution-${stagedKind}-${randomUUID()}`,
        };
        const started = await start(uowA).execute({
          ...owner,
          commandId: randomUUID(),
          customerReference: query,
        });
        expect(started.ok, JSON.stringify(started)).toBe(true);
        if (!started.ok || started.value.mission.payload.draft === null) return;
        expect(started.value.mission.payload.stagedCustomerResolution)
          .toMatchObject({ kind: stagedKind });
        if (stagedKind === 'choices') {
          const staged = started.value.mission.payload.stagedCustomerResolution;
          expect(staged?.kind).toBe('choices');
          if (staged?.kind === 'choices') {
            expect(staged.candidates.map((candidate) => candidate.customerId))
              .toEqual(fuzzyCustomerIds);
            expect(staged.candidates.map((candidate) => candidate.customerId))
              .not.toContain(foreignExactCustomerId);
          }
        }
        const draft = started.value.mission.payload.draft;
        const context = await publishQuoteScreenContext(owner);
        const acknowledgementCommandId = randomUUID();
        expect(await acknowledge(uowA).execute({
          ...owner,
          missionId: started.value.mission.id,
          commandId: acknowledgementCommandId,
          expectedMissionRevision: started.value.mission.revision,
          realtimeSessionId: context.sessionId,
          contextRevision: context.revision,
          contextDigest: context.digest,
          draftSessionId: draft.sessionId,
          expectedDraftSlotRevision: draft.slotRevision,
          expectedDraftContentRevision: draft.contentRevision,
        })).toMatchObject({ ok: true });

        const advanced = await advance(uowA).execute({
          ...owner,
          missionId: started.value.mission.id,
          acknowledgementCommandId,
        });
        expect(advanced, JSON.stringify(advanced)).toMatchObject({
          ok: true,
          value: {
            outcome: 'advanced',
            mission: {
              phase: nextPhase,
              payload: { stagedCustomerResolution: null },
            },
          },
        });
        const continuation = await admin.agentMissionEvent.findFirstOrThrow({
          where: { missionId: started.value.mission.id, sequence: 3 },
        });
        expect(continuation).toMatchObject({
          eventType,
          actor: 'system',
          turnId: null,
        });
        if (eventResult !== null) {
          expect(continuation.data).toMatchObject({ result: eventResult });
        }
        const slot = await admin.quoteDraftSlot.findUniqueOrThrow({
          where: {
            quote_draft_slot_owner: {
              companyId: owner.companyId,
              ownerUserId: owner.ownerUserId,
            },
          },
        });
        expect(slot).toMatchObject({ revision: 1 });
        expect(slot.payload).toMatchObject({
          draft: {
            step: 'client',
            customer: null,
            contentRevision: 0,
          },
        });
      },
    );

    it('ACK écran refuse un payload contexte projetable mais non canonique sans écrire', async () => {
      const owner = {
        companyId: companyA,
        ownerUserId: `owner-screen-noncanonical-${randomUUID()}`,
      };
      const started = await start(uowA).execute({ ...owner, commandId: randomUUID() });
      expect(started.ok, JSON.stringify(started)).toBe(true);
      if (!started.ok || started.value.mission.payload.draft === null) return;
      const draft = started.value.mission.payload.draft;
      const rawContext = {
        screen: {
          name: '/devis/new',
          instanceId: `quote-screen-${randomUUID()}`,
        },
        entities: [],
        capabilities: ['screen.read', 'screen.read'],
        ignoredByParser: 'must-never-authorize',
      };
      const context = await publishQuoteScreenContext(owner, rawContext);
      const beforeMission = await admin.agentMission.findUniqueOrThrow({
        where: { id: started.value.mission.id },
      });
      const beforeEvents = await admin.agentMissionEvent.findMany({
        where: { missionId: started.value.mission.id },
      });

      const rejected = await acknowledge(uowA).execute({
        ...owner,
        missionId: started.value.mission.id,
        commandId: randomUUID(),
        expectedMissionRevision: started.value.mission.revision,
        realtimeSessionId: context.sessionId,
        contextRevision: context.revision,
        contextDigest: context.digest,
        draftSessionId: draft.sessionId,
        expectedDraftSlotRevision: draft.slotRevision,
        expectedDraftContentRevision: draft.contentRevision,
      });

      expect(rejected).toEqual({
        ok: false,
        error: {
          kind: 'conflict',
          entity: 'agent_mission_screen_ack',
          reason: 'context_stale',
        },
      });
      expect(await admin.agentMission.findUniqueOrThrow({
        where: { id: started.value.mission.id },
      })).toEqual(beforeMission);
      expect(await admin.agentMissionEvent.findMany({
        where: { missionId: started.value.mission.id },
      })).toEqual(beforeEvents);
    });

    it.each([1, 2])(
      'rollbacke intégralement l’ACK écran après la faute injectée %s',
      async (failAtWrite) => {
        const owner = {
          companyId: companyA,
          ownerUserId: `owner-screen-rollback-${failAtWrite}-${randomUUID()}`,
        };
        const started = await start(uowA).execute({ ...owner, commandId: randomUUID() });
        expect(started.ok, JSON.stringify(started)).toBe(true);
        if (!started.ok || started.value.mission.payload.draft === null) return;
        const draft = started.value.mission.payload.draft;
        const context = await publishQuoteScreenContext(owner);

        await expect(acknowledge(faultAfterWrite(uowA, failAtWrite)).execute({
          ...owner,
          missionId: started.value.mission.id,
          commandId: randomUUID(),
          expectedMissionRevision: started.value.mission.revision,
          realtimeSessionId: context.sessionId,
          contextRevision: context.revision,
          contextDigest: context.digest,
          draftSessionId: draft.sessionId,
          expectedDraftSlotRevision: draft.slotRevision,
          expectedDraftContentRevision: draft.contentRevision,
        })).rejects.toThrow(`injected-write-${failAtWrite}`);

        expect(await admin.agentMission.findUniqueOrThrow({
          where: { id: started.value.mission.id },
        })).toMatchObject({
          revision: 1,
          phase: 'awaiting_quote_screen',
          currentBinding: null,
        });
        expect(await admin.agentMissionEvent.count({
          where: { missionId: started.value.mission.id },
        })).toBe(1);
      },
    );

    it('RLS masque cross-owner et cross-tenant, tandis que GET reste sans écriture', async () => {
      const owner = { companyId: companyA, ownerUserId: `owner-read-${randomUUID()}` };
      const created = await start(uowA).execute({ ...owner, commandId: randomUUID() });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const before = await admin.agentMissionEvent.count({ where: owner });
      const event = await admin.agentMissionEvent.findFirstOrThrow({
        where: { missionId: created.value.mission.id },
      });
      const getMission = get(uowA);

      expect(await getMission.execute(owner)).toMatchObject({
        ok: true,
        value: { status: 'active', actionable: true },
      });
      expect(await getMission.execute({ ...owner, ownerUserId: `${owner.ownerUserId}-foreign` }))
        .toEqual({ ok: true, value: null });
      expect(await getMission.execute({ ...owner, companyId: companyB }))
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

      const projected = await get(uowA).execute(owner);

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

    it('sérialise réellement un writer N-1 V1 avec le writer K2 V2→V1', async () => {
      const owner = {
        companyId: companyA,
        ownerUserId: `owner-n1-k2-race-${randomUUID()}`,
      };
      const legacy = new PrismaQuoteDraftSlotRepository(workerA);
      const legacyOwnerLockKey = [
        'bob.agent-mission.owner-kind.v1',
        owner.companyId,
        owner.ownerUserId,
        'quote_creation',
      ].join('\u001f');
      let releaseLegacy!: () => void;
      let markLegacyEntered!: () => void;
      const legacyEntered = new Promise<void>((resolve) => {
        markLegacyEntered = resolve;
      });
      const legacyCanCommit = new Promise<void>((resolve) => {
        releaseLegacy = resolve;
      });

      // Forme exacte du binaire N-1 : Company SHARE puis verrou owner/kind V1, sans connaître V2.
      const legacyWrite = workerA.withIsolatedOwner(
        owner.companyId,
        owner.ownerUserId,
        async (transaction) => {
          await transaction.$executeRaw`
            SELECT
              set_config('lock_timeout', '5s', true),
              set_config('statement_timeout', '10s', true)
          `;
          const company = await transaction.$queryRaw<Array<{ closedAt: Date | null }>>`
            SELECT "closedAt"
            FROM public.companies
            WHERE "id" = ${owner.companyId}
            LIMIT 1
            FOR SHARE
          `;
          expect(company).toEqual([{ closedAt: null }]);
          await transaction.$queryRaw<Array<{ locked: boolean }>>`
            SELECT (
              pg_advisory_xact_lock(
                hashtextextended(${legacyOwnerLockKey}, 0)
              ) IS NULL
            ) AS "locked"
          `;
          markLegacyEntered();
          await legacyCanCommit;
          return legacy.upsert({
            ...owner,
            expectedRevision: 0,
            payload: meaningfulPayload('legacy-n1-wins-race'),
          });
        },
        { maxWaitMs: 5_000, timeoutMs: 15_000, readOnly: false },
      );
      await legacyEntered;

      const missionStart = start(uowB).execute({
        ...owner,
        commandId: randomUUID(),
      });
      try {
        let waiterObserved = false;
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const [row] = await admin.$queryRaw<Array<{ waiting: number }>>`
            SELECT count(*)::integer AS "waiting"
            FROM pg_catalog.pg_locks AS lock
            JOIN pg_catalog.pg_stat_activity AS activity
              ON activity.pid = lock.pid
            WHERE activity.datname = current_database()
              AND lock.locktype = 'advisory'
              AND lock.granted = false
          `;
          if ((row?.waiting ?? 0) > 0) {
            waiterObserved = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(waiterObserved).toBe(true);
      } finally {
        releaseLegacy();
      }

      const [legacyResult, missionResult] = await Promise.all([
        legacyWrite,
        missionStart,
      ]);
      expect(legacyResult).toMatchObject({ status: 'created' });
      expect(missionResult).toMatchObject({
        ok: true,
        value: {
          outcome: 'created',
          startOutcome: 'draft_conflict',
          mission: { phase: 'awaiting_draft_decision' },
        },
      });
      expect(await admin.agentMission.count({
        where: { ...owner, status: 'active' },
      })).toBe(1);
      expect(await admin.agentMissionEvent.count({ where: owner })).toBe(1);
      expect(await admin.quoteDraftSlot.findUniqueOrThrow({
        where: { quote_draft_slot_owner: owner },
      })).toMatchObject({
        agentMissionId: null,
        payload: {
          draft: {
            sessionId: 'legacy-n1-wins-race',
            lineForm: { label: 'Main-d’œuvre plomberie' },
          },
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
        const mission = await prepareMissionForCancellation(owner, reason);
        const before = await admin.quoteDraftSlot.findUniqueOrThrow({
          where: { quote_draft_slot_owner: owner },
        });

        const cancelled = await cancel(uowA).execute({
          ...owner,
          missionId: mission.id,
          commandId: randomUUID(),
          expectedRevision: mission.revision,
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
          const mission = await prepareMissionForCancellation(owner, reason);
          const slotBefore = await admin.quoteDraftSlot.findUniqueOrThrow({
            where: { quote_draft_slot_owner: owner },
          });
          const eventCountBefore = await admin.agentMissionEvent.count({
            where: { missionId: mission.id },
          });

          await expect(cancel(faultAfterWrite(uowA, failAtWrite)).execute({
            ...owner,
            missionId: mission.id,
            commandId: randomUUID(),
            expectedRevision: mission.revision,
            reason,
            actor: 'user_tap',
          })).rejects.toThrow(`injected-write-${failAtWrite}`);

          expect(await admin.agentMission.findUniqueOrThrow({
            where: { id: mission.id },
          })).toMatchObject({ status: 'active', revision: mission.revision });
          expect(await admin.agentMissionEvent.count({
            where: { missionId: mission.id },
          })).toBe(eventCountBefore);
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

    it('le GET RR ne prend pas le verrou exclusif du principal', async () => {
      const owner: AgentMissionOwner = {
        companyId: companyB,
        ownerUserId: `owner-read-no-principal-lock-${randomUUID()}`,
      };
      const authority = await authorizeOwner(owner);
      const started = await start(uowA).execute(
        { ...owner, commandId: randomUUID() },
        authority,
      );
      expect(started.ok, JSON.stringify(started)).toBe(true);

      let markLockHeld: (() => void) | undefined;
      const lockHeld = new Promise<void>((resolve) => {
        markLockHeld = resolve;
      });
      let releaseLock: (() => void) | undefined;
      const mayReleaseLock = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      const lockKey = [
        'bob-live:principal',
        owner.companyId,
        authority.principalBindingHash,
      ].join(':');
      const holder = workerB.withIsolatedOwner(
        owner.companyId,
        owner.ownerUserId,
        async (transaction) => {
          await transaction.$queryRaw<Array<{ locked: boolean }>>`
            SELECT (
              pg_advisory_xact_lock(hashtextextended(${lockKey}, 0)) IS NULL
            ) AS "locked"
          `;
          markLockHeld?.();
          await mayReleaseLock;
        },
        { maxWaitMs: 5_000, timeoutMs: 10_000, readOnly: false },
      );
      await lockHeld;

      const read = get(uowA).execute(owner);
      const firstOutcome = await Promise.race([
        read.then((result) => ({ kind: 'read' as const, result })),
        new Promise<{ readonly kind: 'blocked' }>((resolve) => {
          setTimeout(() => resolve({ kind: 'blocked' }), 500);
        }),
      ]);
      releaseLock?.();
      await holder;
      const completed = await read;

      expect(firstOutcome.kind).toBe('read');
      expect(completed).toMatchObject({
        ok: true,
        value: { id: started.ok ? started.value.mission.id : undefined },
      });
    });

    it('la readiness voit les versions globales sans élargir le SELECT tenant du runtime', async () => {
      await expect(workerA.agentMissionEvent.findMany({
        where: { companyId: 'writer-n1-company' },
      })).resolves.toEqual([]);
      await expect(workerA.$queryRaw`
        SELECT "keyVersion",
               "keyFingerprint",
               retained,
               "minimumWriterVersion",
               "highestWriterVersion",
               "writerEnabled"
          FROM public.agent_mission_fingerprint_key_readiness(
            ARRAY[1]::INTEGER[]
          )
         ORDER BY "keyVersion"
      `).resolves.toEqual([
        {
          keyVersion: 1,
          keyFingerprint: CERT_FINGERPRINT_BINDING.keyFingerprint,
          retained: true,
          minimumWriterVersion: 1,
          highestWriterVersion: 1,
          writerEnabled: true,
        },
        {
          keyVersion: 3,
          keyFingerprint: CERT_RETAINED_FINGERPRINT_BINDING.keyFingerprint,
          retained: true,
          minimumWriterVersion: 1,
          highestWriterVersion: 1,
          writerEnabled: true,
        },
      ]);

      await expect(
        new PrismaAgentMissionFingerprintKeyVersionAuthority(
          workerA,
          [
            CERT_FINGERPRINT_BINDING,
            CERT_RETAINED_FINGERPRINT_BINDING,
          ],
          1,
        ).assertKeyBindings(),
      ).resolves.toBeUndefined();
    });

    it('la readiness refuse un runtime dont la version courante régresse sous le floor', async () => {
      await expect(
        new PrismaAgentMissionFingerprintKeyVersionAuthority(
          workerA,
          [{
            keyVersion: 2,
            keyFingerprint: 'b'.repeat(64),
          }],
          2,
        ).assertKeyBindings(),
      ).rejects.toThrow(
        'AgentMission fingerprint writer key floor is not ready.',
      );
    });
  },
);
