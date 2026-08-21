/**
 * Jarvis U1-l — certificat PostgreSQL de l'annuaire paginé.
 *
 * Il exerce le writer N-1 réel pour créer les runs, puis compare la page v1 stateless au protocole
 * v2 durable : keyset, cutoff figé, claim/renew/start/ACK, reprise suffixe et verrou borné. La base
 * est obligatoirement jetable ; aucune fixture n'est supprimée au prix d'un contournement RLS.
 */
import { randomUUID } from 'node:crypto';

import {
  StartQuoteAgentMission,
  sha256Hex,
  type AgentMissionFingerprintPort,
  type AgentMissionOwner,
  type AgentMissionRealtimeAuthorityProof,
} from '@bob/core';
import { PrismaClient, type Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  JarvisDispatchCoordinates,
  JarvisDispatchDirectoryClaimResult,
} from '../../jobs/jarvis-dispatch-directory';
import { PrismaAgentMissionUnitOfWork } from './agent-mission.persistence';
import { PrismaJarvisDispatchRunDirectory } from './jarvis-dispatch-directory.persistence';
import { PrismaService } from './prisma.service';

const RUN_CERT =
  process.env.RUN_AGENT_MISSION_POSTGRES_CERT === 'true'
  && process.env.RUN_POSTGRES_JARVIS_DISPATCH_DIRECTORY_CERT === 'true';
const DISPOSABLE = process.env.AGENT_MISSION_CERT_DATABASE_IS_DISPOSABLE === 'true';
const TEST_TIMEOUT_MS = 90_000;

const FINGERPRINTS: AgentMissionFingerprintPort = {
  sign(canonicalRequest) {
    return { keyVersion: 1, hmac: sha256Hex(`jarvis-u1l-key:${canonicalRequest}`) };
  },
  matches(canonicalRequest, fingerprint) {
    if (fingerprint.keyVersion !== 1) return null;
    return fingerprint.hmac === sha256Hex(`jarvis-u1l-key:${canonicalRequest}`);
  },
};

function certificationAuthorityProof(owner: AgentMissionOwner): AgentMissionRealtimeAuthorityProof {
  const key = `${owner.companyId} ${owner.ownerUserId} 1`;
  return Object.freeze({
    protocolVersion: 1 as const,
    subjectHashCandidates: Object.freeze([sha256Hex(`jarvis-u1l-subject:${key}`)]),
    principalBindingHash: sha256Hex(`jarvis-u1l-principal:${key}`),
    capabilityHash: sha256Hex(`jarvis-u1l-capability:${key}`),
  });
}

type ClaimedPage = Extract<JarvisDispatchDirectoryClaimResult, { readonly status: 'claimed' }>;

interface CursorLeaseRow {
  readonly claimId: string | null;
  readonly claimExpiresAt: Date | null;
  readonly claimHardExpiresAt: Date | null;
}

describe.skipIf(!RUN_CERT)('Jarvis U1-l — annuaire dispatch PostgreSQL', () => {
  const runtimeUrl = process.env.DATABASE_URL ?? '';
  const directUrl = process.env.DIRECT_URL ?? '';
  const certAdminUrl = process.env.AGENT_MISSION_CERT_ADMIN_URL ?? '';
  const companyIds = Array.from(
    { length: 7 },
    (_, index) => `jarvis-u1l-company-${index + 1}-${randomUUID()}`,
  );
  let admin: PrismaClient;
  let deployer: PrismaClient;
  let workerA: PrismaService;
  let workerB: PrismaService;
  let uow: PrismaAgentMissionUnitOfWork;
  let directoryA: PrismaJarvisDispatchRunDirectory;
  let directoryB: PrismaJarvisDispatchRunDirectory;
  const provisioned = new Map<string, Promise<AgentMissionRealtimeAuthorityProof>>();

  async function provisionAuthority(
    owner: AgentMissionOwner,
  ): Promise<AgentMissionRealtimeAuthorityProof> {
    const key = `${owner.companyId} ${owner.ownerUserId}`;
    const existing = provisioned.get(key);
    if (existing !== undefined) return existing;
    const creating = (async () => {
      const authority = certificationAuthorityProof(owner);
      const subjectHash = authority.subjectHashCandidates[0];
      if (subjectHash === undefined) throw new Error('U1-l: subject hash fixture manquant');
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
            leaseTokenHash: sha256Hex(`jarvis-u1l-lease:${key}`),
            state: 'active',
            providerId: 'openai',
            providerCallId: `jarvis-u1l-cert-${sessionId}`,
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
          data: { agentMissionBootstrapAcknowledgedAt: reservedAt },
        });
      });
      return authority;
    })();
    provisioned.set(key, creating);
    return creating;
  }

  async function createCoordinates(
    companyId: string,
    ownerUserId: string,
  ): Promise<JarvisDispatchCoordinates> {
    const owner: AgentMissionOwner = { companyId, ownerUserId };
    const useCase = new StartQuoteAgentMission({
      unitOfWork: uow,
      fingerprints: FINGERPRINTS,
      ids: { newId: () => randomUUID() },
    });
    const result = await useCase.execute({
      companyId,
      ownerUserId,
      authority: await provisionAuthority(owner),
      commandId: randomUUID(),
      origin: { actor: 'user_tap', correlation: null },
      customerReference: null,
    });
    if (!result.ok) throw new Error(`U1-l: writer N-1 refusé ${JSON.stringify(result.error)}`);
    return { companyId, ownerUserId, runId: result.value.mission.id };
  }

  async function insertPreparedInTransaction(
    transaction: Prisma.TransactionClient,
    coordinates: JarvisDispatchCoordinates,
  ): Promise<void> {
    await transaction.$executeRawUnsafe('SET LOCAL ROLE bob_schema_owner');
    await transaction.$executeRaw`
      SELECT set_config('app.current_company_id', ${coordinates.companyId}, true)
    `;
    await transaction.$executeRaw`
      SELECT set_config('app.current_user_id', ${coordinates.ownerUserId}, true)
    `;
    await transaction.$executeRaw`
      SELECT set_config('app.current_agent_mission_id', ${coordinates.runId}, true)
    `;
    await transaction.$executeRaw`
      INSERT INTO public.jarvis_work_items (
        "id", "companyId", "runId", "ownerUserId", "effectId",
        "actionId", "actionVersion", "authorizationSource", "actingPrincipalId",
        "executeBy", "createdAt", "updatedAt"
      ) VALUES (
        ${randomUUID()}::uuid, ${coordinates.companyId}, ${coordinates.runId}::uuid,
        ${coordinates.ownerUserId}, ${randomUUID()}::uuid,
        'client-creer', 1,
        jsonb_build_object('source', 'confirmation', 'receiptId', ${randomUUID()}::text),
        ${coordinates.ownerUserId},
        statement_timestamp() + interval '1 hour',
        statement_timestamp(), statement_timestamp()
      )
    `;
  }

  async function insertPrepared(coordinates: JarvisDispatchCoordinates): Promise<void> {
    await deployer.$transaction((transaction) =>
      insertPreparedInTransaction(transaction, coordinates));
  }

  async function createDueCoordinate(
    companyId: string,
    ownerUserId: string,
  ): Promise<JarvisDispatchCoordinates> {
    const coordinates = await createCoordinates(companyId, ownerUserId);
    await insertPrepared(coordinates);
    return coordinates;
  }

  function requireClaimed(result: JarvisDispatchDirectoryClaimResult): ClaimedPage {
    if (result.status !== 'claimed') {
      throw new Error(`U1-l: page claimed attendue, reçu ${result.status}`);
    }
    return result;
  }

  async function completePage(
    directory: PrismaJarvisDispatchRunDirectory,
    companyId: string,
    page: ClaimedPage,
  ): Promise<void> {
    for (const entry of page.entries) {
      await expect(directory.renewDispatchCoordinatesClaim({
        companyId,
        claimId: page.claimId,
      })).resolves.toEqual({ status: 'succeeded', renewed: true });
      await expect(directory.startDispatchCoordinate({
        companyId,
        claimId: page.claimId,
        position: entry.position,
      })).resolves.toEqual({ status: 'succeeded', started: true });
    }
    await expect(directory.acknowledgeDispatchCoordinates({
      companyId,
      claimId: page.claimId,
    })).resolves.toEqual({ status: 'succeeded', acknowledged: true });
  }

  async function ageClaim(
    companyId: string,
    options: { readonly hard?: boolean } = {},
  ): Promise<void> {
    await deployer.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL ROLE bob_jarvis_dispatch_directory');
      const updated = await transaction.$executeRaw`
        UPDATE public.jarvis_dispatch_directory_cursors
           SET "claimExpiresAt" = statement_timestamp() - interval '1 second',
               "claimHardExpiresAt" = CASE
                 WHEN ${options.hard === true}
                   THEN statement_timestamp() - interval '1 second'
                 ELSE "claimHardExpiresAt"
               END
         WHERE "companyId" = ${companyId}
      `;
      expect(updated).toBe(1);
    });
  }

  async function readClaimLease(companyId: string): Promise<CursorLeaseRow> {
    return deployer.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL ROLE bob_jarvis_dispatch_directory');
      const [row] = await transaction.$queryRaw<CursorLeaseRow[]>`
        SELECT "claimId", "claimExpiresAt", "claimHardExpiresAt"
          FROM public.jarvis_dispatch_directory_cursors
         WHERE "companyId" = ${companyId}
      `;
      if (row === undefined) throw new Error('U1-l: curseur de claim absent');
      return row;
    });
  }

  beforeAll(async () => {
    if (!DISPOSABLE) {
      throw new Error('AGENT_MISSION_CERT_DATABASE_IS_DISPOSABLE=true est obligatoire');
    }
    if (runtimeUrl === '' || directUrl === '' || certAdminUrl === '') {
      throw new Error('DATABASE_URL, DIRECT_URL et AGENT_MISSION_CERT_ADMIN_URL sont requis');
    }
    admin = new PrismaClient({ datasourceUrl: certAdminUrl, errorFormat: 'minimal' });
    deployer = new PrismaClient({ datasourceUrl: directUrl, errorFormat: 'minimal' });
    workerA = new PrismaService({ datasourceUrl: runtimeUrl, errorFormat: 'minimal' });
    workerB = new PrismaService({ datasourceUrl: runtimeUrl, errorFormat: 'minimal' });
    uow = new PrismaAgentMissionUnitOfWork(workerA);
    directoryA = new PrismaJarvisDispatchRunDirectory(workerA);
    directoryB = new PrismaJarvisDispatchRunDirectory(workerB);
    await Promise.all([admin.$connect(), deployer.$connect(), workerA.$connect(), workerB.$connect()]);
    for (const [index, companyId] of companyIds.entries()) {
      const suffix = index + 1;
      await admin.$executeRaw`
        INSERT INTO public.companies (
          "id", "name", "legalForm", "siren", "siret", "trade", "vatRegime",
          "addrLine1", "addrZip", "addrCity"
        ) VALUES (
          ${companyId}, ${`Jarvis U1-l cert ${suffix}`}, ${'EI'},
          ${`90400000${suffix}`}, ${`90400000${suffix}0000${suffix}`},
          ${'certification'}, ${'reel_normal'},
          ${'1 rue du Test'}, ${'75001'}, ${'Paris'}
        )
      `;
    }
  }, 30_000);

  afterAll(async () => {
    await Promise.all([
      admin?.$disconnect(),
      deployer?.$disconnect(),
      workerA?.$disconnect(),
      workerB?.$disconnect(),
    ]);
  });

  it('v1 répète le préfixe tandis que v2 atteint 2L+1 en trois pages ACKées', async () => {
    const companyId = companyIds[0]!;
    const coordinates = await Promise.all(
      ['owner-a', 'owner-b', 'owner-c', 'owner-d', 'owner-e'].map(
        (owner) => createDueCoordinate(companyId, `${owner}-${randomUUID()}`),
      ),
    );
    const firstLegacy = await workerA.$queryRaw<
      Array<{ ownerUserId: string; runId: string }>
    >`
      SELECT "ownerUserId", "runId"
        FROM public.list_jarvis_dispatch_coordinates_v1(${companyId}, 2)
    `;
    const secondLegacy = await workerA.$queryRaw<
      Array<{ ownerUserId: string; runId: string }>
    >`
      SELECT "ownerUserId", "runId"
        FROM public.list_jarvis_dispatch_coordinates_v1(${companyId}, 2)
    `;
    expect(secondLegacy).toEqual(firstLegacy);
    expect(firstLegacy).toHaveLength(2);
    const cursorRows = await deployer.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL ROLE bob_jarvis_dispatch_directory');
      return transaction.$queryRaw`
        SELECT 1 FROM public.jarvis_dispatch_directory_cursors WHERE "companyId" = ${companyId}
      `;
    });
    expect(cursorRows).toHaveLength(0);

    const seen: string[] = [];
    for (const expectedSize of [2, 2, 1]) {
      const page = requireClaimed(await directoryA.claimDispatchCoordinates({ companyId, limit: 2 }));
      expect(page.entries).toHaveLength(expectedSize);
      seen.push(...page.entries.map((entry) => entry.coordinates.ownerUserId));
      await completePage(directoryA, companyId, page);
    }
    expect(seen).toEqual(coordinates.map((entry) => entry.ownerUserId).sort());

    const nextCycle = requireClaimed(
      await directoryA.claimDispatchCoordinates({ companyId, limit: 2 }),
    );
    expect(nextCycle.entries.map((entry) => entry.coordinates.ownerUserId)).toEqual(
      seen.slice(0, 2),
    );
    await completePage(directoryA, companyId, nextCycle);
  }, TEST_TIMEOUT_MS);

  it('fige cutoff et upper malgré un commit tardif horodaté avant la coupure', async () => {
    const companyId = companyIds[1]!;
    const suffix = randomUUID();
    await createDueCoordinate(companyId, `cutoff-a-${suffix}`);
    await createDueCoordinate(companyId, `cutoff-c-${suffix}`);
    const upperExcluded = await createCoordinates(companyId, `cutoff-z-${suffix}`);
    let releaseLateCommit!: () => void;
    const lateCommitHeld = new Promise<void>((resolve) => {
      releaseLateCommit = resolve;
    });
    let markLateInsertReady!: () => void;
    let markLateInsertFailed!: (error: unknown) => void;
    const lateInsertReady = new Promise<void>((resolve, reject) => {
      markLateInsertReady = resolve;
      markLateInsertFailed = reject;
    });
    const lateInsert = deployer.$transaction(async (transaction) => {
      await insertPreparedInTransaction(transaction, upperExcluded);
      markLateInsertReady();
      await lateCommitHeld;
    }, { timeout: 10_000 }).catch((error: unknown) => {
      markLateInsertFailed(error);
      throw error;
    });
    await lateInsertReady;

    try {
      const first = requireClaimed(
        await directoryA.claimDispatchCoordinates({ companyId, limit: 1 }),
      );
      expect(first.entries[0]?.coordinates.ownerUserId).toBe(`cutoff-a-${suffix}`);
      await completePage(directoryA, companyId, first);

      // Cette ligne porte un `updatedAt` antérieur au cutoff (transaction déjà ouverte), mais son
      // commit arrive après le calcul de l'upper. Sans borne haute durable, elle prolongerait le
      // cycle courant ; avec l'upper figé à `cutoff-c`, elle attend le cycle suivant.
      releaseLateCommit();
      await lateInsert;
      await createDueCoordinate(companyId, `cutoff-b-${suffix}`);
      const second = requireClaimed(
        await directoryA.claimDispatchCoordinates({ companyId, limit: 1 }),
      );
      expect(second.entries[0]?.coordinates.ownerUserId).toBe(`cutoff-c-${suffix}`);
      await completePage(directoryA, companyId, second);

      const nextCycleOwners: string[] = [];
      for (let index = 0; index < 4; index += 1) {
        const page = requireClaimed(
          await directoryA.claimDispatchCoordinates({ companyId, limit: 1 }),
        );
        nextCycleOwners.push(page.entries[0]!.coordinates.ownerUserId);
        await completePage(directoryA, companyId, page);
      }
      expect(nextCycleOwners).toEqual([
        `cutoff-a-${suffix}`,
        `cutoff-b-${suffix}`,
        `cutoff-c-${suffix}`,
        `cutoff-z-${suffix}`,
      ]);
    } finally {
      releaseLateCommit();
      await lateInsert;
    }
  }, TEST_TIMEOUT_MS);

  it('busy, renew après soft expiry et takeover suffixe sont fencés par token', async () => {
    const companyId = companyIds[2]!;
    await createDueCoordinate(companyId, `lease-a-${randomUUID()}`);
    await createDueCoordinate(companyId, `lease-b-${randomUUID()}`);
    const concurrentClaims = await Promise.all([
      directoryA.claimDispatchCoordinates({ companyId, limit: 2 }),
      directoryB.claimDispatchCoordinates({ companyId, limit: 2 }),
    ]);
    expect(concurrentClaims.map((result) => result.status).sort()).toEqual(['busy', 'claimed']);
    const ownerIsA = concurrentClaims[0]?.status === 'claimed';
    const ownerDirectory = ownerIsA ? directoryA : directoryB;
    const takeoverDirectory = ownerIsA ? directoryB : directoryA;
    const first = requireClaimed(ownerIsA ? concurrentClaims[0]! : concurrentClaims[1]!);

    await ageClaim(companyId);
    const expiredLease = await readClaimLease(companyId);
    await expect(ownerDirectory.renewDispatchCoordinatesClaim({
      companyId,
      claimId: first.claimId,
    })).resolves.toEqual({ status: 'succeeded', renewed: true });
    const renewedLease = await readClaimLease(companyId);
    if (
      expiredLease.claimExpiresAt === null
      || expiredLease.claimHardExpiresAt === null
      || renewedLease.claimExpiresAt === null
      || renewedLease.claimHardExpiresAt === null
    ) throw new Error('U1-l: échéances de claim absentes');
    expect(renewedLease.claimId).toBe(first.claimId);
    expect(renewedLease.claimExpiresAt.getTime()).toBeGreaterThan(
      expiredLease.claimExpiresAt.getTime(),
    );
    expect(renewedLease.claimHardExpiresAt).toEqual(expiredLease.claimHardExpiresAt);
    await expect(ownerDirectory.startDispatchCoordinate({
      companyId,
      claimId: first.claimId,
      position: 1,
    })).resolves.toEqual({ status: 'succeeded', started: true });

    // Soft expiry seule : sans repreneur, l'ancien token pourrait encore renew/start. Les trois
    // refus ci-dessous discriminent donc réellement le remplacement atomique par un token neuf.
    await ageClaim(companyId);
    const resumed = requireClaimed(
      await takeoverDirectory.claimDispatchCoordinates({ companyId, limit: 1 }),
    );
    expect(resumed.replayed).toBe(true);
    expect(resumed.pageSize).toBe(first.pageSize);
    expect(resumed.entries).toEqual([first.entries[1]]);
    expect(resumed.claimId).not.toBe(first.claimId);
    await expect(ownerDirectory.renewDispatchCoordinatesClaim({
      companyId,
      claimId: first.claimId,
    })).resolves.toEqual({ status: 'succeeded', renewed: false });
    await expect(ownerDirectory.startDispatchCoordinate({
      companyId,
      claimId: first.claimId,
      position: 2,
    })).resolves.toEqual({ status: 'succeeded', started: false });
    await expect(ownerDirectory.acknowledgeDispatchCoordinates({
      companyId,
      claimId: first.claimId,
    })).resolves.toEqual({ status: 'succeeded', acknowledged: false });
    await completePage(takeoverDirectory, companyId, resumed);
  }, TEST_TIMEOUT_MS);

  it('après le dernier start, une hard-expiry se reprend en ack_ready sans rejouer le handler', async () => {
    const companyId = companyIds[3]!;
    await createDueCoordinate(companyId, `ack-ready-${randomUUID()}`);
    const first = requireClaimed(await directoryA.claimDispatchCoordinates({ companyId, limit: 1 }));
    await expect(directoryA.startDispatchCoordinate({
      companyId,
      claimId: first.claimId,
      position: 1,
    })).resolves.toEqual({ status: 'succeeded', started: true });
    await ageClaim(companyId, { hard: true });
    await expect(directoryA.renewDispatchCoordinatesClaim({
      companyId,
      claimId: first.claimId,
    })).resolves.toEqual({ status: 'succeeded', renewed: false });
    await expect(directoryA.startDispatchCoordinate({
      companyId,
      claimId: first.claimId,
      position: 2,
    })).resolves.toEqual({ status: 'succeeded', started: false });

    const resumed = await directoryB.claimDispatchCoordinates({ companyId, limit: 1 });
    expect(resumed).toMatchObject({ status: 'ack_ready', replayed: true, pageSize: 1 });
    if (resumed.status !== 'ack_ready') throw new Error('U1-l: ack_ready attendu');
    await expect(directoryB.acknowledgeDispatchCoordinates({
      companyId,
      claimId: resumed.claimId,
    })).resolves.toEqual({ status: 'succeeded', acknowledged: true });
    const nextCycle = requireClaimed(
      await directoryA.claimDispatchCoordinates({ companyId, limit: 1 }),
    );
    expect(nextCycle.entries).toHaveLength(1);
    await expect(directoryA.startDispatchCoordinate({
      companyId,
      claimId: nextCycle.claimId,
      position: 1,
    })).resolves.toEqual({ status: 'succeeded', started: true });
    await ageClaim(companyId, { hard: true });
    await expect(directoryA.renewDispatchCoordinatesClaim({
      companyId,
      claimId: nextCycle.claimId,
    })).resolves.toEqual({ status: 'succeeded', renewed: false });
    await expect(directoryA.startDispatchCoordinate({
      companyId,
      claimId: nextCycle.claimId,
      position: 2,
    })).resolves.toEqual({ status: 'succeeded', started: false });
    await expect(directoryA.acknowledgeDispatchCoordinates({
      companyId,
      claimId: nextCycle.claimId,
    })).resolves.toEqual({ status: 'succeeded', acknowledged: true });
  }, TEST_TIMEOUT_MS);

  it('évalue la hard lease après acquisition du verrou pour renew et start', async () => {
    async function callBlockedPastHardExpiry<T>(
      companyId: string,
      functionName: string,
      operation: () => Promise<T>,
    ): Promise<T> {
      let expireAndRelease!: () => void;
      const shouldExpire = new Promise<void>((resolve) => {
        expireAndRelease = resolve;
      });
      let markReady!: (lockerPid: number) => void;
      let markFailed!: (error: unknown) => void;
      const ready = new Promise<number>((resolve, reject) => {
        markReady = resolve;
        markFailed = reject;
      });
      const locker = deployer.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe('SET LOCAL ROLE bob_jarvis_dispatch_directory');
        const locked = await transaction.$queryRaw<Array<{
          readonly lockerPid: number;
          readonly claimId: string;
        }>>`
          SELECT pg_catalog.pg_backend_pid() AS "lockerPid", "claimId"
            FROM public.jarvis_dispatch_directory_cursors
           WHERE "companyId" = ${companyId}
           FOR UPDATE
        `;
        if (locked.length !== 1) throw new Error('U1-l: ligne de claim non verrouillée');
        markReady(locked[0]!.lockerPid);
        await shouldExpire;
        const updated = await transaction.$executeRaw`
          UPDATE public.jarvis_dispatch_directory_cursors
             SET "claimExpiresAt" = pg_catalog.clock_timestamp() + interval '50 milliseconds',
                 "claimHardExpiresAt" = pg_catalog.clock_timestamp() + interval '100 milliseconds'
           WHERE "companyId" = ${companyId}
        `;
        expect(updated).toBe(1);
        const waited = await transaction.$queryRaw<Array<{ readonly waited: number }>>`
          SELECT 1::integer AS "waited" FROM pg_catalog.pg_sleep(0.15)
        `;
        expect(waited).toEqual([{ waited: 1 }]);
      }, { timeout: 10_000 }).catch((error: unknown) => {
        markFailed(error);
        throw error;
      });

      const lockerPid = await ready;
      const pending = operation();
      try {
        let blocked = false;
        for (let attempt = 0; attempt < 50 && !blocked; attempt += 1) {
          const [row] = await workerB.$queryRaw<Array<{ readonly blocked: boolean }>>`
            SELECT EXISTS (
              SELECT 1
              FROM pg_catalog.pg_stat_activity AS activity
             WHERE activity.pid <> pg_catalog.pg_backend_pid()
               AND activity.usename = current_user
               AND activity.state = 'active'
               AND activity.query LIKE ${`%${functionName}%`}
               AND ${lockerPid} = ANY(pg_catalog.pg_blocking_pids(activity.pid))
            ) AS "blocked"
          `;
          blocked = row?.blocked === true;
          if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        if (!blocked) {
          throw new Error(`U1-l: appel ${functionName} non observé sous verrou`);
        }
        // Le statement du geste a déjà commencé et attend le row-lock. Le détenteur déplace
        // seulement maintenant la hard lease dans le futur proche, puis la laisse expirer avant
        // COMMIT : statement_timestamp() serait antérieur à la borne et ferait un faux succès ;
        // l'unique clock_timestamp() capturé après le lock doit rendre false.
        expireAndRelease();
      } finally {
        expireAndRelease();
        await locker;
      }
      return pending;
    }

    const renewCompanyId = companyIds[5]!;
    await createDueCoordinate(renewCompanyId, `clock-renew-${randomUUID()}`);
    const renewClaim = requireClaimed(
      await directoryA.claimDispatchCoordinates({ companyId: renewCompanyId, limit: 1 }),
    );
    await expect(callBlockedPastHardExpiry(
      renewCompanyId,
      'renew_jarvis_dispatch_coordinates_claim_v2',
      () => directoryA.renewDispatchCoordinatesClaim({
        companyId: renewCompanyId,
        claimId: renewClaim.claimId,
      }),
    )).resolves.toEqual({ status: 'succeeded', renewed: false });

    const startCompanyId = companyIds[6]!;
    await createDueCoordinate(startCompanyId, `clock-start-${randomUUID()}`);
    const startClaim = requireClaimed(
      await directoryA.claimDispatchCoordinates({ companyId: startCompanyId, limit: 1 }),
    );
    await expect(callBlockedPastHardExpiry(
      startCompanyId,
      'start_jarvis_dispatch_coordinate_v2',
      () => directoryA.startDispatchCoordinate({
        companyId: startCompanyId,
        claimId: startClaim.claimId,
        position: 1,
      }),
    )).resolves.toEqual({ status: 'succeeded', started: false });
  }, TEST_TIMEOUT_MS);

  it('refuse l’état pending sans position et borne une attente de verrou en unavailable', async () => {
    const companyId = companyIds[4]!;
    const invalidPendingRunId = randomUUID();
    await expect(deployer.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL ROLE bob_jarvis_dispatch_directory');
      await transaction.$executeRaw`
        INSERT INTO public.jarvis_dispatch_directory_cursors (
          "companyId", "cycleUpperOwnerUserId", "cycleUpperRunId", "cycleCutoffAt",
          "pendingOwnerUserIds", "pendingRunIds", "pendingAfterOwnerUserId",
          "pendingAfterRunId", "pendingHasMore", "pendingNextPosition",
          "claimId", "claimExpiresAt", "claimHardExpiresAt"
        ) VALUES (
          ${companyId}, 'owner-z', ${randomUUID()}::uuid, statement_timestamp(),
          ARRAY['owner-a'], ARRAY[${invalidPendingRunId}::uuid], 'owner-a',
          ${invalidPendingRunId}::uuid, false, NULL,
          ${randomUUID()}::uuid,
          statement_timestamp() + interval '30 seconds',
          statement_timestamp() + interval '5 minutes'
        )
      `;
    })).rejects.toThrow(/jarvis_dispatch_directory_cursors_pending_check/u);

    await deployer.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL ROLE bob_jarvis_dispatch_directory');
      await transaction.$executeRaw`
        INSERT INTO public.jarvis_dispatch_directory_cursors ("companyId") VALUES (${companyId})
      `;
    });
    let releaseLock!: () => void;
    const lockHeld = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let lockReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      lockReady = resolve;
    });
    const locker = deployer.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL ROLE bob_jarvis_dispatch_directory');
      const locked = await transaction.$queryRaw`
        SELECT 1
          FROM public.jarvis_dispatch_directory_cursors
         WHERE "companyId" = ${companyId}
         FOR UPDATE
      `;
      if (!Array.isArray(locked) || locked.length !== 1) {
        throw new Error('U1-l: ligne de curseur non verrouillée');
      }
      lockReady();
      await lockHeld;
    }, { timeout: 10_000 });
    await ready;
    try {
      const startedAt = Date.now();
      await expect(directoryA.claimDispatchCoordinates({ companyId, limit: 1 }))
        .resolves.toEqual({ status: 'unavailable' });
      expect(Date.now() - startedAt).toBeLessThan(2_500);
    } finally {
      releaseLock();
      await locker;
    }
    await expect(directoryA.claimDispatchCoordinates({ companyId, limit: 1 }))
      .resolves.toEqual({ status: 'empty' });
  }, TEST_TIMEOUT_MS);
});
