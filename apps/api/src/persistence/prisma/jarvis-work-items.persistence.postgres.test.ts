/**
 * Jarvis U1-c — certification PostgreSQL du repository de dispatch (spec Jarvis §5.3,
 * SPEC_U1C_ADMISSION_DISPATCH_20260818 §3/§5).
 *
 * Preuves : (1) le claim incrémente le fence et pose la lease ; (2) deux claims concurrents
 * (deux connexions, Promise.all) ne produisent qu'un gagnant ; (3) un worker stale (fence
 * périmé) ne peut ni autoriser ni écrire un résultat ; (4) une ligne `authorized` dont la
 * lease a vieilli (UPDATE auditeur) n'est JAMAIS reprise par le claim ni re-`prepared` ;
 * (5) cancel et authorize concourent sur la même ligne et le même fence — un seul gagnant ;
 * (6) résultat sans signal => pending level-triggered, signal appliqué UNE fois, fencé ;
 * (7) RLS zéro-amendement fail-closed : les GUC d'un autre tenant ne montrent ni ne mutent
 * rien ; (8) une lease `leased` EXPIRÉE est reprise par claimDue — CAS fence+1, token neuf,
 * jamais avant expiration (revue C10) ; (9) `reclaimExpiredAuthorized` reprend une ligne
 * `authorized` expirée SANS changer son statut — jamais re-`prepared`, l'ancien détenteur
 * devient stale (revue C10) ; (10) authorize échoue quand `executeBy` est passé DANS la
 * transaction d'autorisation, et le cancel no-effect gagne derrière (revue C12) ;
 * (11) gate §5 « lease expirée reprise par CAS » (revue C17) : après la reprise, le
 * détenteur mort ne peut plus RIEN écrire — authorize, storeResult ET markRetryDue rendent
 * tous false, la ligne relue en base est vierge de toute écriture du mort.
 *
 * Même harnais que jarvis-run-expand.postgres.test.ts : gates env, base jetable, sociétés
 * via l'auditeur, missions via le WRITER RÉEL (StartQuoteAgentMission + UoW canonique).
 */
import { randomUUID } from 'node:crypto';

import {
  StartQuoteAgentMission,
  sha256Hex,
  type AgentMissionFingerprintPort,
  type AgentMissionOwner,
  type AgentMissionRealtimeAuthorityProof,
} from '@bob/core';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaAgentMissionUnitOfWork } from './agent-mission.persistence';
import {
  PrismaJarvisWorkItemsRepository,
  type JarvisWorkItemCoordinates,
  type JarvisWorkItemLease,
} from './jarvis-work-items.persistence';
import { PrismaService } from './prisma.service';

const RUN_CERT = process.env.RUN_AGENT_MISSION_POSTGRES_CERT === 'true';
const DISPOSABLE = process.env.AGENT_MISSION_CERT_DATABASE_IS_DISPOSABLE === 'true';

const TEST_TIMEOUT_MS = 60_000;
const LEASE_DURATION_MS = 60_000;

const FINGERPRINTS: AgentMissionFingerprintPort = {
  sign(canonicalRequest) {
    return { keyVersion: 1, hmac: sha256Hex(`jarvis-u1c-key:${canonicalRequest}`) };
  },
  matches(canonicalRequest, fingerprint) {
    if (fingerprint.keyVersion !== 1) return null;
    return fingerprint.hmac === sha256Hex(`jarvis-u1c-key:${canonicalRequest}`);
  },
};

function certificationAuthorityProof(owner: AgentMissionOwner): AgentMissionRealtimeAuthorityProof {
  const key = `${owner.companyId} ${owner.ownerUserId} 1`;
  return Object.freeze({
    protocolVersion: 1 as const,
    subjectHashCandidates: Object.freeze([sha256Hex(`jarvis-u1c-subject:${key}`)]),
    principalBindingHash: sha256Hex(`jarvis-u1c-principal:${key}`),
    capabilityHash: sha256Hex(`jarvis-u1c-capability:${key}`),
  });
}

interface AuditedWorkItemRow {
  readonly status: string;
  readonly attempts: number;
  readonly leaseToken: string | null;
  readonly leaseFence: bigint;
  readonly leaseExpiresAt: Date | null;
  readonly authorizedAt: Date | null;
  readonly authorizationDigest: string | null;
  readonly resultDigest: string | null;
  readonly signalAppliedAt: Date | null;
}

describe.skipIf(!RUN_CERT)(
  'Jarvis U1-c — certification PostgreSQL du dispatch jarvis_work_items',
  () => {
    const runtimeUrl = process.env.DATABASE_URL ?? '';
    const directUrl = process.env.DIRECT_URL ?? '';
    const certAdminUrl = process.env.AGENT_MISSION_CERT_ADMIN_URL ?? '';
    const companyA = `jarvis-dispatch-company-a-${randomUUID()}`;
    const companyB = `jarvis-dispatch-company-b-${randomUUID()}`;
    let admin: PrismaClient;
    let deployer: PrismaClient;
    let workerA: PrismaService;
    let workerB: PrismaService;
    let uow: PrismaAgentMissionUnitOfWork;
    let repositoryA: PrismaJarvisWorkItemsRepository;
    let repositoryB: PrismaJarvisWorkItemsRepository;
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
        if (subjectHash === undefined) {
          throw new Error('Jarvis U1-c: subject hash fixture manquant.');
        }
        const sessionId = randomUUID();
        const reservedAt = new Date();
        await deployer.$transaction(async (tx) => {
          await tx.$executeRawUnsafe('SET LOCAL ROLE bob_schema_owner');
          await tx.$executeRaw`
            SELECT set_config('app.current_company_id', ${owner.companyId}, true)
          `;
          await tx.$executeRaw`
            SELECT set_config('app.current_user_id', ${owner.ownerUserId}, true)
          `;
          await tx.realtimeSessionLease.create({
            data: {
              companyId: owner.companyId,
              subjectHash,
              sessionId,
              leaseTokenHash: sha256Hex(`jarvis-u1c-lease:${key}`),
              state: 'active',
              providerId: 'openai',
              providerCallId: `jarvis-u1c-cert-${sessionId}`,
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
          await tx.realtimeSessionLease.update({
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

    /** Crée un run par le WRITER N-1 RÉEL : use case + UoW canonique, jamais un insert brut. */
    async function createRunViaRealWriter(companyId: string, ownerUserId: string): Promise<string> {
      const owner: AgentMissionOwner = { companyId, ownerUserId };
      const authority = await provisionAuthority(owner);
      const useCase = new StartQuoteAgentMission({
        unitOfWork: uow,
        fingerprints: FINGERPRINTS,
        ids: { newId: () => randomUUID() },
      });
      const result = await useCase.execute({
        companyId,
        ownerUserId,
        authority,
        commandId: randomUUID(),
        origin: { actor: 'user_tap', correlation: null },
        customerReference: null,
      });
      if (!result.ok) {
        throw new Error(`Jarvis U1-c: start N-1 refuse ${JSON.stringify(result.error)}`);
      }
      return result.value.mission.id;
    }

    /** Chaque preuve isole son propriétaire : aucune contrainte one-active partagée. */
    async function freshCoordinates(companyId: string): Promise<JarvisWorkItemCoordinates> {
      const ownerUserId = `jarvis-dispatch-owner-${randomUUID()}`;
      const runId = await createRunViaRealWriter(companyId, ownerUserId);
      return { companyId, ownerUserId, runId };
    }

    async function asOwner<T>(
      coordinates: JarvisWorkItemCoordinates,
      work: (tx: Prisma.TransactionClient) => Promise<T>,
    ): Promise<T> {
      return deployer.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE bob_schema_owner');
        await tx.$executeRaw`
          SELECT set_config('app.current_company_id', ${coordinates.companyId}, true)
        `;
        await tx.$executeRaw`
          SELECT set_config('app.current_user_id', ${coordinates.ownerUserId}, true)
        `;
        await tx.$executeRaw`
          SELECT set_config('app.current_agent_mission_id', ${coordinates.runId}, true)
        `;
        return work(tx);
      });
    }

    /** Le repository n'insère jamais : l'admission (§5.2) est simulée par le harnais owner. */
    async function insertPreparedWorkItem(coordinates: JarvisWorkItemCoordinates): Promise<string> {
      const id = randomUUID();
      await asOwner(
        coordinates,
        (tx) =>
          tx.$executeRaw`
          INSERT INTO public.jarvis_work_items (
            "id", "companyId", "runId", "ownerUserId", "effectId",
            "actionId", "actionVersion", "authorizationSource", "actingPrincipalId",
            "executeBy", "createdAt", "updatedAt"
          ) VALUES (
            ${id}::uuid, ${coordinates.companyId}, ${coordinates.runId}::uuid,
            ${coordinates.ownerUserId}, ${randomUUID()}::uuid,
            'client-creer', 1,
            jsonb_build_object('source', 'confirmation', 'receiptId', ${randomUUID()}::text),
            ${coordinates.ownerUserId},
            now() + interval '1 hour', now(), now()
          )
        `,
      );
      return id;
    }

    async function auditItem(id: string): Promise<AuditedWorkItemRow> {
      const rows = await admin.$queryRaw<AuditedWorkItemRow[]>`
        SELECT "status", "attempts", "leaseToken", "leaseFence", "leaseExpiresAt",
               "authorizedAt", "authorizationDigest", "resultDigest", "signalAppliedAt"
          FROM public.jarvis_work_items
         WHERE "id" = ${id}::uuid
      `;
      const row = rows[0];
      if (row === undefined) throw new Error(`Jarvis U1-c: work item introuvable ${id}`);
      return row;
    }

    /** Vieillissement du lease PAR L'AUDITEUR (harnais §19.2) : jamais par le worker. */
    async function ageLease(id: string): Promise<void> {
      const count = await admin.$executeRaw`
        UPDATE public.jarvis_work_items
           SET "leaseExpiresAt" = statement_timestamp() - INTERVAL '1 hour'
         WHERE "id" = ${id}::uuid
      `;
      if (count !== 1) throw new Error(`Jarvis U1-c: vieillissement raté pour ${id}`);
    }

    /** Échéance `executeBy` passée PAR L'AUDITEUR : simule un worker suspendu (revue C12). */
    async function ageExecuteBy(id: string): Promise<void> {
      const count = await admin.$executeRaw`
        UPDATE public.jarvis_work_items
           SET "executeBy" = statement_timestamp() - INTERVAL '1 minute'
         WHERE "id" = ${id}::uuid
      `;
      if (count !== 1) throw new Error(`Jarvis U1-c: échéance non vieillie pour ${id}`);
    }

    /** Reprise d'un claim après backoff : borne dure, jamais une attente aveugle. */
    async function claimUntilDue(
      repository: PrismaJarvisWorkItemsRepository,
      coordinates: JarvisWorkItemCoordinates,
      leaseToken: string,
    ): Promise<readonly JarvisWorkItemLease[]> {
      const startedAt = Date.now();
      for (;;) {
        const claimed = await repository.claimDue(coordinates, {
          leaseOwner: 'jarvis-u1c-cert-worker',
          leaseToken,
          leaseDurationMs: LEASE_DURATION_MS,
          limit: 10,
        });
        if (claimed.length > 0) return claimed;
        if (Date.now() - startedAt > 5_000) {
          throw new Error('Jarvis U1-c: le work item retry_due n’est jamais redevenu dû.');
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }

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
      admin = new PrismaClient({ datasourceUrl: certAdminUrl, errorFormat: 'minimal' });
      deployer = new PrismaClient({ datasourceUrl: directUrl, errorFormat: 'minimal' });
      // Deux connexions runtime distinctes : les courses (claim/claim, cancel/authorize)
      // sont de vraies transactions concurrentes, pas un aller-retour séquentiel.
      workerA = new PrismaService({ datasourceUrl: runtimeUrl, errorFormat: 'minimal' });
      workerB = new PrismaService({ datasourceUrl: runtimeUrl, errorFormat: 'minimal' });
      uow = new PrismaAgentMissionUnitOfWork(workerA);
      repositoryA = new PrismaJarvisWorkItemsRepository(workerA);
      repositoryB = new PrismaJarvisWorkItemsRepository(workerB);
      await Promise.all([
        admin.$connect(),
        deployer.$connect(),
        workerA.$connect(),
        workerB.$connect(),
      ]);
      for (const [companyId, suffix] of [
        [companyA, '3'],
        [companyB, '4'],
      ] as const) {
        await admin.$executeRaw`
          INSERT INTO public.companies (
            "id", "name", "legalForm", "siren", "siret", "trade", "vatRegime",
            "addrLine1", "addrZip", "addrCity"
          ) VALUES (
            ${companyId}, ${`Jarvis dispatch cert ${suffix}`}, ${'EI'},
            ${`90300000${suffix}`}, ${`90300000${suffix}0000${suffix}`},
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

    it(
      'claimDue incrémente le fence, pose la lease, et chaque reprise ré-incrémente',
      async () => {
        const coordinates = await freshCoordinates(companyA);
        const itemId = await insertPreparedWorkItem(coordinates);

        const tokenA = randomUUID();
        const claimed = await repositoryA.claimDue(coordinates, {
          leaseOwner: 'jarvis-u1c-cert-worker',
          leaseToken: tokenA,
          leaseDurationMs: LEASE_DURATION_MS,
          limit: 10,
        });
        expect(claimed).toHaveLength(1);
        expect(claimed[0]?.id).toBe(itemId);
        expect(claimed[0]?.leaseFence).toBe(1n);
        expect(claimed[0]?.leaseToken).toBe(tokenA);

        const leased = await auditItem(itemId);
        expect(leased.status).toBe('leased');
        expect(leased.leaseFence).toBe(1n);
        expect(leased.leaseExpiresAt?.getTime()).toBeGreaterThan(Date.now() - 60_000);

        // Échec transitoire : retour retry_due avec backoff, lease libérée, fence conservé.
        await expect(
          repositoryA.markRetryDue(coordinates, {
            id: itemId,
            leaseToken: tokenA,
            leaseFence: 1n,
            retryDelayMs: 1,
          }),
        ).resolves.toBe(true);
        const retryDue = await auditItem(itemId);
        expect(retryDue.status).toBe('retry_due');
        expect(retryDue.attempts).toBe(1);
        expect(retryDue.leaseToken).toBeNull();
        expect(retryDue.leaseFence).toBe(1n);

        const reclaimed = await claimUntilDue(repositoryA, coordinates, randomUUID());
        expect(reclaimed).toHaveLength(1);
        expect(reclaimed[0]?.leaseFence).toBe(2n);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'deux claims concurrents sur la même ligne (deux connexions) => un seul gagnant',
      async () => {
        const coordinates = await freshCoordinates(companyA);
        const itemId = await insertPreparedWorkItem(coordinates);

        const [claimedA, claimedB] = await Promise.all([
          repositoryA.claimDue(coordinates, {
            leaseOwner: 'jarvis-u1c-cert-worker-a',
            leaseToken: randomUUID(),
            leaseDurationMs: LEASE_DURATION_MS,
            limit: 10,
          }),
          repositoryB.claimDue(coordinates, {
            leaseOwner: 'jarvis-u1c-cert-worker-b',
            leaseToken: randomUUID(),
            leaseDurationMs: LEASE_DURATION_MS,
            limit: 10,
          }),
        ]);
        expect(claimedA.length + claimedB.length).toBe(1);
        const winner = claimedA[0] ?? claimedB[0];
        expect(winner?.id).toBe(itemId);
        // Un seul incrément : le perdant n'a JAMAIS écrit, même en ayant attendu le verrou.
        expect(winner?.leaseFence).toBe(1n);
        const settled = await auditItem(itemId);
        expect(settled.status).toBe('leased');
        expect(settled.leaseFence).toBe(1n);
        expect(settled.leaseToken).toBe(winner?.leaseToken ?? null);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'un worker stale (fence périmé) ne peut ni autoriser ni écrire un résultat',
      async () => {
        const coordinates = await freshCoordinates(companyA);
        const itemId = await insertPreparedWorkItem(coordinates);
        const staleToken = randomUUID();
        const staleClaim = await repositoryA.claimDue(coordinates, {
          leaseOwner: 'jarvis-u1c-cert-worker-stale',
          leaseToken: staleToken,
          leaseDurationMs: LEASE_DURATION_MS,
          limit: 10,
        });
        expect(staleClaim[0]?.leaseFence).toBe(1n);
        await expect(
          repositoryA.markRetryDue(coordinates, {
            id: itemId,
            leaseToken: staleToken,
            leaseFence: 1n,
            retryDelayMs: 1,
          }),
        ).resolves.toBe(true);

        const successorToken = randomUUID();
        const successorClaim = await claimUntilDue(repositoryB, coordinates, successorToken);
        expect(successorClaim[0]?.leaseFence).toBe(2n);

        // L'ancien détenteur revient : son couple (token, fence) est périmé — zéro écriture.
        await expect(
          repositoryA.authorize(coordinates, {
            id: itemId,
            leaseToken: staleToken,
            leaseFence: 1n,
            authorizationDigest: sha256Hex('jarvis-u1c-authorization-stale'),
          }),
        ).resolves.toBe(false);
        await expect(
          repositoryA.storeResult(coordinates, {
            id: itemId,
            leaseToken: staleToken,
            leaseFence: 1n,
            status: 'succeeded',
            resultDigest: sha256Hex('jarvis-u1c-result-stale'),
          }),
        ).resolves.toBe(false);
        const untouched = await auditItem(itemId);
        expect(untouched.status).toBe('leased');
        expect(untouched.leaseFence).toBe(2n);
        expect(untouched.authorizedAt).toBeNull();
        expect(untouched.resultDigest).toBeNull();

        // Le détenteur courant, lui, autorise — authorizedAt + digest ENSEMBLE.
        await expect(
          repositoryB.authorize(coordinates, {
            id: itemId,
            leaseToken: successorToken,
            leaseFence: 2n,
            authorizationDigest: sha256Hex('jarvis-u1c-authorization-current'),
          }),
        ).resolves.toBe(true);
        const authorized = await auditItem(itemId);
        expect(authorized.status).toBe('authorized');
        expect(authorized.authorizedAt).not.toBeNull();
        expect(authorized.authorizationDigest).toBe(sha256Hex('jarvis-u1c-authorization-current'));
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'une ligne authorized dont la lease a vieilli n’est jamais reprise ni re-prepared',
      async () => {
        const coordinates = await freshCoordinates(companyA);
        const itemId = await insertPreparedWorkItem(coordinates);
        const holderToken = randomUUID();
        const claimed = await repositoryA.claimDue(coordinates, {
          leaseOwner: 'jarvis-u1c-cert-worker-holder',
          leaseToken: holderToken,
          leaseDurationMs: LEASE_DURATION_MS,
          limit: 10,
        });
        expect(claimed[0]?.leaseFence).toBe(1n);
        const authorizationDigest = sha256Hex('jarvis-u1c-authorization-aged');
        await expect(
          repositoryA.authorize(coordinates, {
            id: itemId,
            leaseToken: holderToken,
            leaseFence: 1n,
            authorizationDigest,
          }),
        ).resolves.toBe(true);

        await ageLease(itemId);

        // authorized = point de non-retour : le claim ne le voit pas, quel que soit l'âge.
        await expect(
          repositoryB.claimDue(coordinates, {
            leaseOwner: 'jarvis-u1c-cert-worker-scavenger',
            leaseToken: randomUUID(),
            leaseDurationMs: LEASE_DURATION_MS,
            limit: 10,
          }),
        ).resolves.toHaveLength(0);
        const aged = await auditItem(itemId);
        expect(aged.status).toBe('authorized');
        expect(aged.leaseFence).toBe(1n);
        expect(aged.authorizedAt).not.toBeNull();
        expect(aged.authorizationDigest).toBe(authorizationDigest);
        expect(aged.resultDigest).toBeNull();

        // Le détenteur du fence courant règle l'issue RÉELLE même après la fenêtre :
        // l'autorité est le fence, jamais l'horloge d'un worker.
        await expect(
          repositoryA.storeResult(coordinates, {
            id: itemId,
            leaseToken: holderToken,
            leaseFence: 1n,
            status: 'succeeded',
            resultDigest: sha256Hex('jarvis-u1c-result-aged'),
          }),
        ).resolves.toBe(true);
        const settled = await auditItem(itemId);
        expect(settled.status).toBe('succeeded');
        expect(settled.resultDigest).toBe(sha256Hex('jarvis-u1c-result-aged'));
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'une lease leased EXPIRÉE est reprise par claimDue (fence+1, token neuf) — jamais avant expiration',
      async () => {
        const coordinates = await freshCoordinates(companyA);
        const itemId = await insertPreparedWorkItem(coordinates);
        const deadToken = randomUUID();
        const claimed = await repositoryA.claimDue(coordinates, {
          leaseOwner: 'jarvis-u1c-cert-worker-dead',
          leaseToken: deadToken,
          leaseDurationMs: LEASE_DURATION_MS,
          limit: 10,
        });
        expect(claimed[0]?.leaseFence).toBe(1n);

        // Lease encore vivante : la ligne n'est PAS reprise — un seul détenteur à la fois.
        await expect(
          repositoryB.claimDue(coordinates, {
            leaseOwner: 'jarvis-u1c-cert-worker-early',
            leaseToken: randomUUID(),
            leaseDurationMs: LEASE_DURATION_MS,
            limit: 10,
          }),
        ).resolves.toHaveLength(0);

        // Le worker meurt (redeploy, kill) : l'auditeur fait expirer la lease.
        await ageLease(itemId);

        // Reprise par le claim NORMAL (revue C10) : fence+1, token neuf, jamais stranded.
        const successorToken = randomUUID();
        const reclaimed = await repositoryB.claimDue(coordinates, {
          leaseOwner: 'jarvis-u1c-cert-worker-successor',
          leaseToken: successorToken,
          leaseDurationMs: LEASE_DURATION_MS,
          limit: 10,
        });
        expect(reclaimed).toHaveLength(1);
        expect(reclaimed[0]?.id).toBe(itemId);
        expect(reclaimed[0]?.leaseFence).toBe(2n);
        expect(reclaimed[0]?.leaseToken).toBe(successorToken);

        // Le mort revenu (couple périmé) n'écrit plus rien ; le successeur autorise.
        await expect(
          repositoryA.authorize(coordinates, {
            id: itemId,
            leaseToken: deadToken,
            leaseFence: 1n,
            authorizationDigest: sha256Hex('jarvis-u1c-authorization-dead'),
          }),
        ).resolves.toBe(false);
        await expect(
          repositoryB.authorize(coordinates, {
            id: itemId,
            leaseToken: successorToken,
            leaseFence: 2n,
            authorizationDigest: sha256Hex('jarvis-u1c-authorization-successor'),
          }),
        ).resolves.toBe(true);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'après reprise d’une lease expirée, le détenteur mort ne peut plus RIEN écrire — zéro écriture (revue C17)',
      async () => {
        const coordinates = await freshCoordinates(companyA);
        const itemId = await insertPreparedWorkItem(coordinates);
        const deadToken = randomUUID();
        const claimed = await repositoryA.claimDue(coordinates, {
          leaseOwner: 'jarvis-u1c-cert-worker-zombie',
          leaseToken: deadToken,
          leaseDurationMs: LEASE_DURATION_MS,
          limit: 10,
        });
        expect(claimed[0]?.leaseFence).toBe(1n);

        await ageLease(itemId);
        const successorToken = randomUUID();
        const reclaimed = await repositoryB.claimDue(coordinates, {
          leaseOwner: 'jarvis-u1c-cert-worker-heir',
          leaseToken: successorToken,
          leaseDurationMs: LEASE_DURATION_MS,
          limit: 10,
        });
        expect(reclaimed[0]?.leaseFence).toBe(2n);
        expect(reclaimed[0]?.leaseToken).toBe(successorToken);

        // Le zombie revient et tente TOUTES ses écritures : chacune rend false — la
        // vérité est le couple (token, fence), jamais la mémoire d'un worker.
        await expect(
          repositoryA.authorize(coordinates, {
            id: itemId,
            leaseToken: deadToken,
            leaseFence: 1n,
            authorizationDigest: sha256Hex('jarvis-u1c-authorization-zombie'),
          }),
        ).resolves.toBe(false);
        await expect(
          repositoryA.storeResult(coordinates, {
            id: itemId,
            leaseToken: deadToken,
            leaseFence: 1n,
            status: 'failed_terminal',
            resultDigest: sha256Hex('jarvis-u1c-result-zombie'),
          }),
        ).resolves.toBe(false);
        await expect(
          repositoryA.markRetryDue(coordinates, {
            id: itemId,
            leaseToken: deadToken,
            leaseFence: 1n,
            retryDelayMs: 1,
          }),
        ).resolves.toBe(false);

        // LA BASE : la ligne du successeur est vierge de toute écriture du mort.
        const untouched = await auditItem(itemId);
        expect(untouched.status).toBe('leased');
        expect(untouched.leaseFence).toBe(2n);
        expect(untouched.leaseToken).toBe(successorToken);
        expect(untouched.attempts).toBe(0);
        expect(untouched.authorizedAt).toBeNull();
        expect(untouched.authorizationDigest).toBeNull();
        expect(untouched.resultDigest).toBeNull();
        expect(untouched.signalAppliedAt).toBeNull();
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'reclaimExpiredAuthorized reprend une ligne authorized expirée : fence+1, token neuf, statut INCHANGÉ',
      async () => {
        const coordinates = await freshCoordinates(companyA);
        const itemId = await insertPreparedWorkItem(coordinates);
        const deadToken = randomUUID();
        const claimed = await repositoryA.claimDue(coordinates, {
          leaseOwner: 'jarvis-u1c-cert-worker-dead-authorized',
          leaseToken: deadToken,
          leaseDurationMs: LEASE_DURATION_MS,
          limit: 10,
        });
        expect(claimed[0]?.leaseFence).toBe(1n);
        await expect(
          repositoryA.authorize(coordinates, {
            id: itemId,
            leaseToken: deadToken,
            leaseFence: 1n,
            authorizationDigest: sha256Hex('jarvis-u1c-authorization-reclaim'),
          }),
        ).resolves.toBe(true);

        // Lease encore vivante : rien à reprendre.
        await expect(
          repositoryB.reclaimExpiredAuthorized(coordinates, {
            leaseOwner: 'jarvis-u1c-cert-worker-reconciler-early',
            leaseToken: randomUUID(),
            leaseDurationMs: LEASE_DURATION_MS,
            limit: 10,
          }),
        ).resolves.toHaveLength(0);

        await ageLease(itemId);

        // claimDue ne reprend JAMAIS un authorized, même expiré (point de non-retour).
        await expect(
          repositoryB.claimDue(coordinates, {
            leaseOwner: 'jarvis-u1c-cert-worker-scavenger',
            leaseToken: randomUUID(),
            leaseDurationMs: LEASE_DURATION_MS,
            limit: 10,
          }),
        ).resolves.toHaveLength(0);

        // La reprise DÉDIÉE, elle, prend : fence+1, token neuf, statut inchangé (revue C10).
        const reconcilerToken = randomUUID();
        const reclaimed = await repositoryB.reclaimExpiredAuthorized(coordinates, {
          leaseOwner: 'jarvis-u1c-cert-worker-reconciler',
          leaseToken: reconcilerToken,
          leaseDurationMs: LEASE_DURATION_MS,
          limit: 10,
        });
        expect(reclaimed).toHaveLength(1);
        expect(reclaimed[0]?.id).toBe(itemId);
        expect(reclaimed[0]?.leaseFence).toBe(2n);
        expect(reclaimed[0]?.leaseToken).toBe(reconcilerToken);
        const reclaimedRow = await auditItem(itemId);
        expect(reclaimedRow.status).toBe('authorized'); // jamais re-prepared (§5.3)
        expect(reclaimedRow.authorizedAt).not.toBeNull();
        expect(reclaimedRow.leaseFence).toBe(2n);

        // L'ancien détenteur (fence périmé) ne règle plus rien — jamais un écrasement.
        await expect(
          repositoryA.storeResult(coordinates, {
            id: itemId,
            leaseToken: deadToken,
            leaseFence: 1n,
            status: 'succeeded',
            resultDigest: sha256Hex('jarvis-u1c-result-dead'),
          }),
        ).resolves.toBe(false);
        // Le réconciliateur règle (U1-c : registre vide => outcome_unknown honnête).
        await expect(
          repositoryB.storeResult(coordinates, {
            id: itemId,
            leaseToken: reconcilerToken,
            leaseFence: 2n,
            status: 'outcome_unknown',
            resultDigest: sha256Hex('jarvis-u1c-result-reconciled'),
          }),
        ).resolves.toBe(true);
        const settled = await auditItem(itemId);
        expect(settled.status).toBe('outcome_unknown');
        expect(settled.resultDigest).toBe(sha256Hex('jarvis-u1c-result-reconciled'));
        // Une ligne réglée n'est plus JAMAIS reprise par la réconciliation.
        await expect(
          repositoryB.reclaimExpiredAuthorized(coordinates, {
            leaseOwner: 'jarvis-u1c-cert-worker-reconciler-late',
            leaseToken: randomUUID(),
            leaseDurationMs: LEASE_DURATION_MS,
            limit: 10,
          }),
        ).resolves.toHaveLength(0);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'authorize échoue quand executeBy est passé DANS la transaction ; le cancel no-effect gagne (revue C12)',
      async () => {
        const coordinates = await freshCoordinates(companyA);
        const itemId = await insertPreparedWorkItem(coordinates);
        const holderToken = randomUUID();
        const claimed = await repositoryA.claimDue(coordinates, {
          leaseOwner: 'jarvis-u1c-cert-worker-expired-deadline',
          leaseToken: holderToken,
          leaseDurationMs: LEASE_DURATION_MS,
          limit: 10,
        });
        expect(claimed[0]?.leaseFence).toBe(1n);

        // Worker suspendu entre revalidation et authorize : l'échéance passe entre-temps.
        await ageExecuteBy(itemId);

        // §5.3 étape 2 : `databaseNow <= executeBy` tient dans LA transaction d'authorize —
        // le couple (token, fence) valide ne suffit pas, l'autorisation échoue.
        await expect(
          repositoryA.authorize(coordinates, {
            id: itemId,
            leaseToken: holderToken,
            leaseFence: 1n,
            authorizationDigest: sha256Hex('jarvis-u1c-authorization-late'),
          }),
        ).resolves.toBe(false);
        const refused = await auditItem(itemId);
        expect(refused.status).toBe('leased');
        expect(refused.authorizedAt).toBeNull();
        expect(refused.resultDigest).toBeNull();

        // Route §5.3 : l'échéance passée se règle no-effect — le cancel fencé gagne.
        const noEffectDigest = sha256Hex('jarvis-u1c-no-effect-expired-deadline');
        await expect(
          repositoryA.cancelUnauthorized(coordinates, {
            id: itemId,
            expectedLeaseFence: 1n,
            noEffectResultDigest: noEffectDigest,
          }),
        ).resolves.toBe(true);
        const settled = await auditItem(itemId);
        expect(settled.status).toBe('cancelled');
        expect(settled.authorizedAt).toBeNull();
        expect(settled.resultDigest).toBe(noEffectDigest);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'cancel et authorize concourent sur la même ligne et le même fence => un seul gagnant',
      async () => {
        const coordinates = await freshCoordinates(companyA);

        // Un item encore prepared s'annule au fence observé 0, puis reste invisible au claim.
        const preparedId = await insertPreparedWorkItem(coordinates);
        const preparedNoEffect = sha256Hex('jarvis-u1c-no-effect-prepared');
        await expect(
          repositoryA.cancelUnauthorized(coordinates, {
            id: preparedId,
            expectedLeaseFence: 0n,
            noEffectResultDigest: preparedNoEffect,
          }),
        ).resolves.toBe(true);
        const cancelledPrepared = await auditItem(preparedId);
        expect(cancelledPrepared.status).toBe('cancelled');
        expect(cancelledPrepared.resultDigest).toBe(preparedNoEffect);
        await expect(
          repositoryA.claimDue(coordinates, {
            leaseOwner: 'jarvis-u1c-cert-worker',
            leaseToken: randomUUID(),
            leaseDurationMs: LEASE_DURATION_MS,
            limit: 10,
          }),
        ).resolves.toHaveLength(0);

        // La course frontale : même ligne, même fence, deux connexions.
        const racedId = await insertPreparedWorkItem(coordinates);
        const holderToken = randomUUID();
        const claimed = await repositoryA.claimDue(coordinates, {
          leaseOwner: 'jarvis-u1c-cert-worker-racer',
          leaseToken: holderToken,
          leaseDurationMs: LEASE_DURATION_MS,
          limit: 10,
        });
        expect(claimed[0]?.leaseFence).toBe(1n);
        const authorizationDigest = sha256Hex('jarvis-u1c-authorization-race');
        const noEffectDigest = sha256Hex('jarvis-u1c-no-effect-race');
        const [authorizeWon, cancelWon] = await Promise.all([
          repositoryA.authorize(coordinates, {
            id: racedId,
            leaseToken: holderToken,
            leaseFence: 1n,
            authorizationDigest,
          }),
          repositoryB.cancelUnauthorized(coordinates, {
            id: racedId,
            expectedLeaseFence: 1n,
            noEffectResultDigest: noEffectDigest,
          }),
        ]);
        expect([authorizeWon, cancelWon].filter(Boolean)).toHaveLength(1);
        const settled = await auditItem(racedId);
        if (authorizeWon) {
          expect(settled.status).toBe('authorized');
          expect(settled.authorizationDigest).toBe(authorizationDigest);
          expect(settled.resultDigest).toBeNull();
        } else {
          expect(settled.status).toBe('cancelled');
          expect(settled.authorizedAt).toBeNull();
          expect(settled.resultDigest).toBe(noEffectDigest);
        }
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'un résultat sans signal reste pending (index partiel) et le stamp fencé est unique',
      async () => {
        const coordinates = await freshCoordinates(companyA);
        const itemId = await insertPreparedWorkItem(coordinates);
        const holderToken = randomUUID();
        const claimed = await repositoryA.claimDue(coordinates, {
          leaseOwner: 'jarvis-u1c-cert-worker-signal',
          leaseToken: holderToken,
          leaseDurationMs: LEASE_DURATION_MS,
          limit: 10,
        });
        expect(claimed[0]?.leaseFence).toBe(1n);
        await expect(
          repositoryA.authorize(coordinates, {
            id: itemId,
            leaseToken: holderToken,
            leaseFence: 1n,
            authorizationDigest: sha256Hex('jarvis-u1c-authorization-signal'),
          }),
        ).resolves.toBe(true);
        const resultDigest = sha256Hex('jarvis-u1c-result-signal');
        await expect(
          repositoryA.storeResult(coordinates, {
            id: itemId,
            leaseToken: holderToken,
            leaseFence: 1n,
            status: 'succeeded',
            resultDigest,
          }),
        ).resolves.toBe(true);

        // Une issue indécidable plus ancienne reste durablement quarantinée : elle n'entre
        // jamais dans la page des vrais reçus et ne peut donc ni les affamer, ni être stampée.
        const unknownId = await insertPreparedWorkItem(coordinates);
        const unknownToken = randomUUID();
        const unknownClaim = await repositoryA.claimDue(coordinates, {
          leaseOwner: 'jarvis-u1c-cert-worker-unknown-signal',
          leaseToken: unknownToken,
          leaseDurationMs: LEASE_DURATION_MS,
          limit: 10,
        });
        expect(unknownClaim.map((lease) => lease.id)).toEqual([unknownId]);
        await expect(
          repositoryA.authorize(coordinates, {
            id: unknownId,
            leaseToken: unknownToken,
            leaseFence: 1n,
            authorizationDigest: sha256Hex('jarvis-u1c-authorization-unknown-signal'),
          }),
        ).resolves.toBe(true);
        const unknownDigest = sha256Hex('jarvis-u1c-result-unknown-signal');
        await expect(
          repositoryA.storeResult(coordinates, {
            id: unknownId,
            leaseToken: unknownToken,
            leaseFence: 1n,
            status: 'outcome_unknown',
            resultDigest: unknownDigest,
          }),
        ).resolves.toBe(true);

        const pending = await repositoryA.listPendingSignals(coordinates, 10);
        expect(pending).toHaveLength(1);
        expect(pending[0]?.id).toBe(itemId);
        expect(pending[0]?.resultDigest).toBe(resultDigest);
        expect(pending[0]?.leaseFence).toBe(1n);
        await expect(
          repositoryA.markSignalApplied(coordinates, {
            id: unknownId,
            leaseFence: 1n,
            resultDigest: unknownDigest,
          }),
        ).resolves.toBe(false);
        const quarantined = await auditItem(unknownId);
        expect(quarantined.status).toBe('outcome_unknown');
        expect(quarantined.signalAppliedAt).toBeNull();

        // Forme historique contradictoire : un statut `cancelled` ne prouve pas no-effect si une
        // autorisation existe. Ni la lecture pending ni le stamp ne doivent la blanchir.
        const contradictoryId = await insertPreparedWorkItem(coordinates);
        const contradictoryToken = randomUUID();
        const contradictoryClaim = await repositoryA.claimDue(coordinates, {
          leaseOwner: 'jarvis-u1c-cert-worker-contradictory-signal',
          leaseToken: contradictoryToken,
          leaseDurationMs: LEASE_DURATION_MS,
          limit: 10,
        });
        expect(contradictoryClaim.map((lease) => lease.id)).toEqual([contradictoryId]);
        const contradictoryAuthorization = sha256Hex(
          'jarvis-u1c-authorization-contradictory-signal',
        );
        await expect(
          repositoryA.authorize(coordinates, {
            id: contradictoryId,
            leaseToken: contradictoryToken,
            leaseFence: 1n,
            authorizationDigest: contradictoryAuthorization,
          }),
        ).resolves.toBe(true);
        const contradictoryDigest = sha256Hex('jarvis-u1c-result-contradictory-signal');
        await admin.$executeRaw`
          UPDATE public.jarvis_work_items
             SET "status" = 'cancelled',
                 "resultDigest" = ${contradictoryDigest},
                 "leaseToken" = NULL,
                 "leaseExpiresAt" = NULL,
                 "updatedAt" = statement_timestamp()
           WHERE "id" = ${contradictoryId}::uuid
        `;
        await expect(repositoryA.listPendingSignals(coordinates, 10)).resolves.toEqual([
          expect.objectContaining({ id: itemId }),
        ]);
        await expect(
          repositoryA.markSignalApplied(coordinates, {
            id: contradictoryId,
            leaseFence: 1n,
            resultDigest: contradictoryDigest,
          }),
        ).resolves.toBe(false);
        const contradictory = await auditItem(contradictoryId);
        expect(contradictory).toMatchObject({
          status: 'cancelled',
          authorizedAt: expect.any(Date),
          authorizationDigest: contradictoryAuthorization,
          resultDigest: contradictoryDigest,
          signalAppliedAt: null,
        });

        // Signal stale (autre digest) ou fence périmé : no-op EXPLICITE, jamais un stamp.
        await expect(
          repositoryA.markSignalApplied(coordinates, {
            id: itemId,
            leaseFence: 1n,
            resultDigest: sha256Hex('jarvis-u1c-result-signal-divergent'),
          }),
        ).resolves.toBe(false);
        await expect(
          repositoryA.markSignalApplied(coordinates, {
            id: itemId,
            leaseFence: 2n,
            resultDigest,
          }),
        ).resolves.toBe(false);

        await expect(
          repositoryA.markSignalApplied(coordinates, {
            id: itemId,
            leaseFence: 1n,
            resultDigest,
          }),
        ).resolves.toBe(true);
        // Le signal ne s'applique qu'UNE fois ; la file pending se vide.
        await expect(
          repositoryA.markSignalApplied(coordinates, {
            id: itemId,
            leaseFence: 1n,
            resultDigest,
          }),
        ).resolves.toBe(false);
        await expect(repositoryA.listPendingSignals(coordinates, 10)).resolves.toHaveLength(0);
        const stamped = await auditItem(itemId);
        expect(stamped.signalAppliedAt).not.toBeNull();
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'RLS zéro-amendement fail-closed : les GUC d’un autre tenant ne montrent ni ne mutent rien',
      async () => {
        const coordinatesA = await freshCoordinates(companyA);
        const itemA = await insertPreparedWorkItem(coordinatesA);
        const coordinatesB = await freshCoordinates(companyB);
        const itemB = await insertPreparedWorkItem(coordinatesB);

        // Sous ses propres GUC, le tenant B ne claim QUE sa ligne — jamais celle de A.
        const claimedB = await repositoryB.claimDue(coordinatesB, {
          leaseOwner: 'jarvis-u1c-cert-worker-b',
          leaseToken: randomUUID(),
          leaseDurationMs: LEASE_DURATION_MS,
          limit: 10,
        });
        expect(claimedB.map((lease) => lease.id)).toEqual([itemB]);

        // Coordonnées volées (GUC B, ligne A) : la base ne rend rien et ne mute rien.
        const stolen: JarvisWorkItemCoordinates = {
          companyId: companyB,
          ownerUserId: coordinatesB.ownerUserId,
          runId: coordinatesA.runId,
        };
        await expect(
          repositoryB.claimDue(stolen, {
            leaseOwner: 'jarvis-u1c-cert-worker-thief',
            leaseToken: randomUUID(),
            leaseDurationMs: LEASE_DURATION_MS,
            limit: 10,
          }),
        ).resolves.toHaveLength(0);
        await expect(
          repositoryB.authorize(stolen, {
            id: itemA,
            leaseToken: randomUUID(),
            leaseFence: 0n,
            authorizationDigest: sha256Hex('jarvis-u1c-authorization-thief'),
          }),
        ).resolves.toBe(false);
        await expect(
          repositoryB.storeResult(stolen, {
            id: itemA,
            leaseToken: randomUUID(),
            leaseFence: 0n,
            status: 'succeeded',
            resultDigest: sha256Hex('jarvis-u1c-result-thief'),
          }),
        ).resolves.toBe(false);
        await expect(
          repositoryB.cancelUnauthorized(stolen, {
            id: itemA,
            expectedLeaseFence: 0n,
            noEffectResultDigest: sha256Hex('jarvis-u1c-no-effect-thief'),
          }),
        ).resolves.toBe(false);
        await expect(repositoryB.listPendingSignals(stolen, 10)).resolves.toHaveLength(0);

        // Même un SELECT brut ciblant explicitement companyA sous les GUC de B rend zéro
        // ligne : la policy U1-a filtre, le repository n'y ajoute aucune ouverture.
        const crossTenantRows = await workerB.withIsolatedOwner(
          companyB,
          coordinatesB.ownerUserId,
          (tx) =>
            tx.$queryRaw<Array<{ id: string }>>`
              SELECT "id" FROM public.jarvis_work_items WHERE "companyId" = ${companyA}
            `,
          { maxWaitMs: 5_000, timeoutMs: 15_000, readOnly: true },
        );
        expect(crossTenantRows).toHaveLength(0);

        const intactA = await auditItem(itemA);
        expect(intactA.status).toBe('prepared');
        expect(intactA.leaseFence).toBe(0n);
        expect(intactA.resultDigest).toBeNull();
      },
      TEST_TIMEOUT_MS,
    );
  },
);
