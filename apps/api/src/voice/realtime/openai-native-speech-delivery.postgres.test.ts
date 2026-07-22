import { createHash, randomInt, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { PrismaClient, type Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../persistence/prisma/prisma.service';
import {
  prepareRealtimeContext,
  type PreparedRealtimeContext,
  type RealtimeAdmissionLease,
  type RealtimeAdmissionPolicy,
} from './realtime-admission';
import { PrismaRealtimeAdmission } from './realtime-admission.prisma';
import {
  createOpenAiNativeSpeechDelivery,
  reduceOpenAiNativeSpeechDelivery,
  type OpenAiNativeSpeechDeliveryState,
} from './openai-native-speech-delivery';
import { PrismaOpenAiNativeSpeechDeliveryRepository } from './openai-native-speech-delivery.prisma';
import type { RealtimeSidebandOwnerIdentity } from './realtime-sideband-owner';
import { PrismaRealtimeSidebandOwner } from './realtime-sideband-owner.prisma';

const RUN_POSTGRES_CERT = process.env.RUN_POSTGRES_OPENAI_NATIVE_DELIVERY_CERT === 'true';
const ADMISSION_POLICY: RealtimeAdmissionPolicy = {
  userLimitPerMinute: 50,
  userLimitPerHour: 100,
  tenantLimitPerMinute: 100,
  tenantLimitPerHour: 1_000,
  reservationTtlSeconds: 120,
  activeLeaseSeconds: 180,
  heartbeatSeconds: 30,
  reaperLeaseSeconds: 30,
};

interface Authority {
  readonly companyId: string;
  readonly subjectHmac: string;
  readonly lease: RealtimeAdmissionLease;
  readonly owner: RealtimeSidebandOwnerIdentity;
  readonly context: PreparedRealtimeContext;
}

interface StoredProof {
  readonly xmin: string;
  readonly revision: number;
  readonly phase: string;
  readonly speechPolicyVersion: number;
  readonly speechScenarioId: string;
  readonly proofFormatVersion: number;
  readonly retentionCurrent: boolean;
  readonly controlCount: number;
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function company(id: string, discriminator: number) {
  const siren = String(randomInt(100_000_000, 999_999_999));
  return {
    id,
    name: `OpenAI native delivery PostgreSQL certification ${discriminator}`,
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

describe.skipIf(!RUN_POSTGRES_CERT)(
  'Bob Live OpenAI natif — adapter Prisma PostgreSQL/RLS',
  () => {
    const suffix = randomUUID().replaceAll('-', '');
    const companyId = `native-delivery-${suffix}`;
    const otherCompanyId = `native-other-${suffix}`;
    const runtimeUrl = process.env.DATABASE_URL ?? '';
    const directUrl = process.env.DIRECT_URL ?? '';
    let admin: PrismaClient;
    let workers: [PrismaService, PrismaService];
    let admissions: [PrismaRealtimeAdmission, PrismaRealtimeAdmission];
    let sidebands: [PrismaRealtimeSidebandOwner, PrismaRealtimeSidebandOwner];
    let repositories: [
      PrismaOpenAiNativeSpeechDeliveryRepository,
      PrismaOpenAiNativeSpeechDeliveryRepository,
    ];

    async function databaseNow(): Promise<Date> {
      const [row] = await workers[0].$queryRaw<Array<{ databaseNow: Date }>>`
        SELECT clock_timestamp() AS "databaseNow"
      `;
      if (!(row?.databaseNow instanceof Date)) throw new Error('PostgreSQL clock unavailable.');
      return row.databaseNow;
    }

    async function createAuthority(
      label: string,
      tenantId = companyId,
    ): Promise<Authority> {
      const subjectHmac = digest(`subject:${suffix}:${label}`);
      const context = prepareRealtimeContext({
        version: 1,
        revision: 1,
        context: {
          screen: { name: '/aujourdhui', instanceId: `native-cert:${label}` },
          entities: [],
          capabilities: ['screen.read'],
        },
      });
      if (!context) throw new Error('Native certification context invalid.');
      const admission = admissions[0];
      const reserved = await admission.reserve({
        companyId: tenantId,
        subjectHash: subjectHmac,
        sessionId: randomUUID(),
        maxSessionSeconds: 180,
      });
      if (!reserved.allowed) throw new Error(`Unexpected admission denial: ${reserved.denial}`);
      const lease = reserved.lease;
      expect(await admission.bindProvider({
        ...lease,
        providerId: 'openai',
        providerCallId: `native_cert_${suffix}_${label}`,
      })).toMatchObject({ ok: true });
      expect(await admission.updateContext({
        companyId: tenantId,
        subjectHash: subjectHmac,
        sessionId: lease.sessionId,
        version: context.snapshot.version,
        revision: context.snapshot.revision,
        context: context.snapshot.context,
      })).toEqual({ ok: true, status: 'updated', revision: 1 });
      expect(await admission.activate(lease)).toMatchObject({ ok: true });

      const acquired = await sidebands[0].acquire({
        companyId: tenantId,
        sessionId: lease.sessionId,
        ownerInstanceHash: digest(`owner-instance:${suffix}:${label}:1`),
        candidateOwnerTokenHash: digest(`owner-token:${suffix}:${label}:1`),
        leaseSeconds: 120,
      });
      if (acquired.status !== 'acquired') {
        throw new Error(`Unexpected sideband owner result: ${acquired.status}`);
      }
      expect(await sidebands[0].applyContext(acquired.owner, {
        revision: context.snapshot.revision,
        digest: context.digest,
      })).toEqual({ status: 'applied' });
      return { companyId: tenantId, subjectHmac, lease, owner: acquired.owner, context };
    }

    async function delivery(
      authority: Authority,
      label: string,
      ttlMs = 30_000,
    ): Promise<OpenAiNativeSpeechDeliveryState> {
      const now = await databaseNow();
      return createOpenAiNativeSpeechDelivery({
        deliveryId: randomUUID(),
        companyId: authority.companyId,
        subjectHmac: authority.subjectHmac,
        sessionId: authority.lease.sessionId,
        turnId: randomUUID(),
        contextRevision: authority.context.snapshot.revision,
        contextDigest: authority.context.digest,
        sidebandOwnerEpoch: authority.owner.ownerEpoch,
        sidebandOwnerTokenHmac: authority.owner.ownerTokenHash,
        speechPolicyVersion: 1,
        speechScenarioId: 'generic_help_v1',
        proofFormatVersion: 2,
        proofKeyVersion: 1,
        canonicalSpeechHmac: digest(`speech:${suffix}:${label}`),
        factsHmac: digest(`facts:${suffix}:${label}`),
        requestNonceHmac: digest(`nonce:${suffix}:${label}`),
        provider: 'openai',
        model: 'gpt-realtime-2.1',
        voice: 'marin',
        createdAtMs: now.getTime(),
        expiresAtMs: now.getTime() + ttlMs,
      });
    }

    function claim(
      state: OpenAiNativeSpeechDeliveryState,
      dispatchClaimId = randomUUID(),
    ): OpenAiNativeSpeechDeliveryState {
      return reduceOpenAiNativeSpeechDelivery(state, {
        type: 'CLAIM_DISPATCH',
        dispatchClaimId,
        atMs: state.createdAtMs + 1,
      });
    }

    async function persistTransition(
      previous: OpenAiNativeSpeechDeliveryState,
      next: OpenAiNativeSpeechDeliveryState,
    ): Promise<OpenAiNativeSpeechDeliveryState> {
      expect(await repositories[0].compareAndSwap({
        key: { companyId: previous.companyId, deliveryId: previous.deliveryId },
        expectedRevision: previous.revision,
        next,
      })).toEqual({ status: 'applied', state: next });
      return next;
    }

    async function persistUntilStreaming(
      initial: OpenAiNativeSpeechDeliveryState,
      label: string,
    ): Promise<{
      readonly state: OpenAiNativeSpeechDeliveryState;
      readonly responseHmac: string;
      readonly at: number;
    }> {
      const at = Math.max((await databaseNow()).getTime(), initial.createdAtMs) + 1;
      const responseHmac = digest(`response:${suffix}:${label}`);
      let state = await persistTransition(initial, reduceOpenAiNativeSpeechDelivery(initial, {
        type: 'CLAIM_DISPATCH', dispatchClaimId: randomUUID(), atMs: at,
      }));
      state = await persistTransition(state, reduceOpenAiNativeSpeechDelivery(state, {
        type: 'MARK_REQUESTED', dispatchClaimId: state.dispatchClaimId!, atMs: at + 1,
      }));
      state = await persistTransition(state, reduceOpenAiNativeSpeechDelivery(state, {
        type: 'ACCEPT_RESPONSE', providerResponseIdHmac: responseHmac, atMs: at + 2,
      }));
      state = await persistTransition(state, reduceOpenAiNativeSpeechDelivery(state, {
        type: 'START_STREAMING', providerResponseIdHmac: responseHmac, atMs: at + 3,
      }));
      return { state, responseHmac, at };
    }

    async function storedProof(state: OpenAiNativeSpeechDeliveryState): Promise<StoredProof> {
      const [row] = await workers[0].withTenant(state.companyId, (tx) => tx.$queryRaw<StoredProof[]>`
        SELECT delivery.xmin::text AS xmin,
               delivery.revision,
               delivery.phase,
               delivery."speechPolicyVersion" AS "speechPolicyVersion",
               delivery."speechScenarioId" AS "speechScenarioId",
               delivery."proofFormatVersion" AS "proofFormatVersion",
               delivery."retentionExpiresAt" >= delivery."createdAt" + INTERVAL '29 days'
                 AS "retentionCurrent",
               (SELECT COUNT(*)::integer
                  FROM realtime_control_grants AS control_grant
                 WHERE control_grant."companyId" = delivery."companyId"
                   AND control_grant."nativeDeliveryId" = delivery."deliveryId") AS "controlCount"
          FROM realtime_native_speech_deliveries AS delivery
         WHERE delivery."companyId" = ${state.companyId}
           AND delivery."deliveryId" = ${state.deliveryId}::uuid
      `);
      if (!row) throw new Error('Native delivery proof row missing.');
      return row;
    }

    async function waitUntilExpired(expiresAtMs: number): Promise<void> {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((await databaseNow()).getTime() >= expiresAtMs) return;
        await delay(20);
      }
      throw new Error('PostgreSQL expiry deadline was not reached.');
    }

    async function waitForBlockedStatements(sqlFragment: string, expected: number): Promise<void> {
      const pattern = `%${sqlFragment}%`;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const [row] = await admin.$queryRaw<Array<{ count: number }>>`
          SELECT COUNT(*)::integer AS count
            FROM pg_stat_activity
           WHERE datname = current_database()
             AND pid <> pg_backend_pid()
             AND wait_event_type = 'Lock'
             AND query LIKE ${pattern}
        `;
        if ((row?.count ?? 0) >= expected) return;
        await delay(20);
      }
      throw new Error(`Expected ${expected} blocked PostgreSQL statements for ${sqlFragment}.`);
    }

    async function runWithDatabaseBarrier<T>(
      acquireBlocker: (tx: Prisma.TransactionClient) => Promise<unknown>,
      blockedSqlFragment: string,
      operation: () => Promise<T>,
    ): Promise<T> {
      let signalLocked: (() => void) | undefined;
      let releaseBlocker: (() => void) | undefined;
      const locked = new Promise<void>((resolve) => { signalLocked = resolve; });
      const released = new Promise<void>((resolve) => { releaseBlocker = resolve; });
      const blocker = admin.$transaction(async (tx) => {
        await acquireBlocker(tx);
        signalLocked?.();
        await released;
      }, { timeout: 10_000 });
      await Promise.race([
        locked,
        blocker.then(
          () => Promise.reject(new Error('PostgreSQL blocker ended before acquiring its lock.')),
          (error: unknown) => Promise.reject(error),
        ),
      ]);

      const pending = operation();
      let barrierError: unknown;
      try {
        await waitForBlockedStatements(blockedSqlFragment, 2);
      } catch (error) {
        barrierError = error;
      } finally {
        releaseBlocker?.();
        await blocker;
      }
      const result = await pending;
      if (barrierError) throw barrierError;
      return result;
    }

    beforeAll(async () => {
      if (!runtimeUrl || !directUrl) {
        throw new Error('DATABASE_URL (runtime) and DIRECT_URL (admin) are required.');
      }
      admin = new PrismaClient({ datasourceUrl: directUrl });
      workers = [
        new PrismaService({ datasourceUrl: runtimeUrl }),
        new PrismaService({ datasourceUrl: runtimeUrl }),
      ];
      admissions = workers.map((worker) => new PrismaRealtimeAdmission(
        worker,
        ADMISSION_POLICY,
      )) as typeof admissions;
      sidebands = workers.map((worker) => new PrismaRealtimeSidebandOwner(worker)) as typeof sidebands;
      repositories = workers.map((worker) => new PrismaOpenAiNativeSpeechDeliveryRepository(
        worker,
      )) as typeof repositories;
      await Promise.all([admin.$connect(), ...workers.map((worker) => worker.$connect())]);
      await admin.company.createMany({
        data: [company(companyId, 1), company(otherCompanyId, 2)],
      });
    }, 30_000);

    afterAll(async () => {
      if (admin) {
        await admin.realtimeControlConsumption.deleteMany({
          where: { companyId: { in: [companyId, otherCompanyId] } },
        }).catch(() => undefined);
        await admin.realtimeControlGrant.deleteMany({
          where: { companyId: { in: [companyId, otherCompanyId] } },
        }).catch(() => undefined);
        await admin.realtimeNativeSpeechDelivery.deleteMany({
          where: { companyId: { in: [companyId, otherCompanyId] } },
        }).catch(() => undefined);
        await admin.realtimeSessionLease.deleteMany({
          where: { companyId: { in: [companyId, otherCompanyId] } },
        }).catch(() => undefined);
        await admin.realtimeAdmissionEvent.deleteMany({
          where: { companyId: { in: [companyId, otherCompanyId] } },
        }).catch(() => undefined);
        await admin.company.deleteMany({
          where: { id: { in: [companyId, otherCompanyId] } },
        }).catch(() => undefined);
      }
      await Promise.allSettled([
        ...((workers ?? []) as PrismaService[]).map((worker) => worker.$disconnect()),
        ...(admin ? [admin.$disconnect()] : []),
      ]);
    });

    it('certifie rôle runtime, prepare/replay sans réécriture, RLS et zéro contrôle natif', async () => {
      const [role] = await workers[0].$queryRaw<Array<{
        rolsuper: boolean;
        rolbypassrls: boolean;
      }>>`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
      expect(role).toEqual({ rolsuper: false, rolbypassrls: false });

      const authority = await createAuthority('prepare');
      const state = await delivery(authority, 'prepare');
      const preparationRace = await runWithDatabaseBarrier(
        (tx) => tx.$queryRaw`
          SELECT 1
            FROM realtime_session_leases
           WHERE "companyId" = ${companyId}
             AND "sessionId" = ${state.sessionId}::uuid
           FOR UPDATE
        `,
        'FROM realtime_session_leases AS lease',
        () => Promise.all(repositories.map((repository) => repository.prepare(state))),
      );
      expect(preparationRace.map((result) => result.status).sort()).toEqual([
        'already_prepared',
        'created',
      ]);
      const beforeReplay = await storedProof(state);
      expect(beforeReplay).toMatchObject({
        revision: 1,
        phase: 'prepared',
        speechPolicyVersion: 1,
        speechScenarioId: 'generic_help_v1',
        proofFormatVersion: 2,
        retentionCurrent: true,
        controlCount: 0,
      });
      expect(await repositories[1].prepare(state)).toEqual({ status: 'already_prepared', state });
      expect(await storedProof(state)).toEqual(beforeReplay);

      expect(await repositories[1].read({
        companyId: otherCompanyId,
        deliveryId: state.deliveryId,
      })).toEqual({ status: 'not_found' });
      expect(await workers[1].withTenant(otherCompanyId, (tx) => tx.$executeRaw`
        UPDATE realtime_native_speech_deliveries
           SET revision = revision + 1
         WHERE "companyId" = ${companyId}
           AND "deliveryId" = ${state.deliveryId}::uuid
      `)).toBe(0);
      await expect(workers[0].withTenant(companyId, (tx) =>
        tx.realtimeNativeSpeechDelivery.deleteMany({
          where: { companyId, deliveryId: state.deliveryId },
        }))).rejects.toThrow();
    }, 30_000);

    it('classe les collisions visibles et masque une unicité appartenant à un autre tenant', async () => {
      const authority = await createAuthority('collisions');
      const initial = await delivery(authority, 'collisions');
      expect(await repositories[0].prepare(initial)).toMatchObject({ status: 'created' });

      const turnCollision = createOpenAiNativeSpeechDelivery({
        ...initial,
        deliveryId: randomUUID(),
        requestNonceHmac: digest(`nonce:${suffix}:turn-collision`),
      });
      expect(await repositories[0].prepare(turnCollision)).toEqual({ status: 'conflict' });
      const nonceCollision = createOpenAiNativeSpeechDelivery({
        ...initial,
        deliveryId: randomUUID(),
        turnId: randomUUID(),
      });
      expect(await repositories[0].prepare(nonceCollision)).toEqual({ status: 'conflict' });

      const otherAuthority = await createAuthority('cross-tenant-collision', otherCompanyId);
      const hiddenCollisionBase = await delivery(otherAuthority, 'cross-tenant-collision');
      const hiddenCollision = createOpenAiNativeSpeechDelivery({
        ...hiddenCollisionBase,
        requestNonceHmac: initial.requestNonceHmac,
      });
      expect(await repositories[1].prepare(hiddenCollision)).toEqual({ status: 'unavailable' });
      expect(await repositories[1].read({
        companyId: otherCompanyId,
        deliveryId: hiddenCollision.deliveryId,
      })).toEqual({ status: 'not_found' });
    }, 30_000);

    it('sérialise deux CAS identiques et prouve le replay sans mutation de tuple', async () => {
      const authority = await createAuthority('cas-identical');
      const initial = await delivery(authority, 'cas-identical');
      expect(await repositories[0].prepare(initial)).toMatchObject({ status: 'created' });
      const next = claim(initial);

      const race = await runWithDatabaseBarrier(
        (tx) => tx.$queryRaw`
          SELECT 1
            FROM realtime_native_speech_deliveries
           WHERE "companyId" = ${companyId}
             AND "deliveryId" = ${initial.deliveryId}::uuid
           FOR UPDATE
        `,
        'UPDATE realtime_native_speech_deliveries',
        () => Promise.all(repositories.map((repository) => repository.compareAndSwap({
          key: { companyId, deliveryId: initial.deliveryId },
          expectedRevision: initial.revision,
          next,
        }))),
      );
      expect(race.map((result) => result.status).sort()).toEqual(['already_applied', 'applied']);
      const beforeReplay = await storedProof(next);
      expect(await repositories[0].compareAndSwap({
        key: { companyId, deliveryId: initial.deliveryId },
        expectedRevision: initial.revision,
        next,
      })).toEqual({ status: 'already_applied', state: next });
      expect(await storedProof(next)).toEqual(beforeReplay);
    }, 30_000);

    it('sérialise deux CAS divergents et conserve intégralement le gagnant', async () => {
      const authority = await createAuthority('cas-divergent');
      const initial = await delivery(authority, 'cas-divergent');
      expect(await repositories[0].prepare(initial)).toMatchObject({ status: 'created' });
      const candidates = [claim(initial), claim(initial)];

      const race = await runWithDatabaseBarrier(
        (tx) => tx.$queryRaw`
          SELECT 1
            FROM realtime_native_speech_deliveries
           WHERE "companyId" = ${companyId}
             AND "deliveryId" = ${initial.deliveryId}::uuid
           FOR UPDATE
        `,
        'UPDATE realtime_native_speech_deliveries',
        () => Promise.all(repositories.map((repository, index) =>
          repository.compareAndSwap({
            key: { companyId, deliveryId: initial.deliveryId },
            expectedRevision: initial.revision,
            next: candidates[index]!,
          }))),
      );
      expect(race.map((result) => result.status).sort()).toEqual(['applied', 'conflict']);
      const persisted = await repositories[0].read({ companyId, deliveryId: initial.deliveryId });
      expect(persisted.status).toBe('found');
      if (persisted.status !== 'found') throw new Error('CAS winner unavailable.');
      expect(candidates).toContainEqual(persisted.state);
    }, 30_000);

    it('certifie le lifecycle complet, la course ACK/SLO et le terminal immuable', async () => {
      const authority = await createAuthority('ack-slo');
      const initial = await delivery(authority, 'ack-slo');
      expect(await repositories[0].prepare(initial)).toMatchObject({ status: 'created' });
      const streaming = await persistUntilStreaming(initial, 'ack-slo');
      const { at, responseHmac } = streaming;
      let { state } = streaming;
      state = await persistTransition(state, reduceOpenAiNativeSpeechDelivery(state, {
        type: 'RESPONSE_DONE', providerResponseIdHmac: responseHmac,
        outputTranscriptHmac: initial.canonicalSpeechHmac, atMs: at + 4,
      }));
      state = await persistTransition(state, reduceOpenAiNativeSpeechDelivery(state, {
        type: 'OUTPUT_STOPPED', providerResponseIdHmac: responseHmac, atMs: at + 5,
      }));
      const completed = state;
      const acknowledgementId = randomUUID();
      const candidates = [
        reduceOpenAiNativeSpeechDelivery(completed, {
          type: 'ACK_DELIVERY', acknowledgementId, deliveryId: completed.deliveryId,
          sessionId: completed.sessionId, turnId: completed.turnId,
          contextRevision: completed.contextRevision, contextDigest: completed.contextDigest,
          slo: {
            speechStoppedEventToFirstInboundRtpMs: 701,
            pendingBargeIn: { status: 'complete', durationsMs: [91, 120] },
          },
          atMs: at + 6,
        }),
        reduceOpenAiNativeSpeechDelivery(completed, {
          type: 'ACK_DELIVERY', acknowledgementId, deliveryId: completed.deliveryId,
          sessionId: completed.sessionId, turnId: completed.turnId,
          contextRevision: completed.contextRevision, contextDigest: completed.contextDigest,
          slo: {
            speechStoppedEventToFirstInboundRtpMs: 702,
            pendingBargeIn: { status: 'overflowed' },
          },
          atMs: at + 6,
        }),
      ];
      const race = await runWithDatabaseBarrier(
        (tx) => tx.$queryRaw`
          SELECT 1
            FROM realtime_native_speech_deliveries
           WHERE "companyId" = ${companyId}
             AND "deliveryId" = ${completed.deliveryId}::uuid
           FOR UPDATE
        `,
        'UPDATE realtime_native_speech_deliveries',
        () => Promise.all(repositories.map((repository, index) =>
          repository.compareAndSwap({
            key: { companyId, deliveryId: completed.deliveryId },
            expectedRevision: completed.revision,
            next: candidates[index]!,
          }))),
      );
      expect(race.map((result) => result.status).sort()).toEqual(['applied', 'conflict']);
      const winner = race.find((result) => result.status === 'applied');
      if (!winner || !('state' in winner)) throw new Error('ACK/SLO winner unavailable.');
      const beforeReplay = await storedProof(winner.state);
      expect(await repositories[0].compareAndSwap({
        key: { companyId, deliveryId: completed.deliveryId },
        expectedRevision: completed.revision,
        next: winner.state,
      })).toEqual({ status: 'already_applied', state: winner.state });
      expect(await storedProof(winner.state)).toEqual(beforeReplay);
      await expect(workers[0].withTenant(companyId, (tx) => tx.$executeRaw`
        UPDATE realtime_native_speech_deliveries
           SET "speechStoppedEventToFirstInboundRtpMs" = 999
         WHERE "companyId" = ${companyId}
           AND "deliveryId" = ${winner.state.deliveryId}::uuid
      `)).rejects.toThrow(/immutable/u);
      expect((await storedProof(winner.state)).controlCount).toBe(0);
    }, 30_000);

    it('persiste aussi OUTPUT_STOPPED avant RESPONSE_DONE puis rejoue le complet sans mutation', async () => {
      const authority = await createAuthority('output-first');
      const initial = await delivery(authority, 'output-first');
      expect(await repositories[0].prepare(initial)).toMatchObject({ status: 'created' });
      const { state: streaming, responseHmac, at } = await persistUntilStreaming(
        initial,
        'output-first',
      );
      const outputStopped = await persistTransition(
        streaming,
        reduceOpenAiNativeSpeechDelivery(streaming, {
          type: 'OUTPUT_STOPPED', providerResponseIdHmac: responseHmac, atMs: at + 4,
        }),
      );
      expect(outputStopped.phase).toBe('draining');
      const completed = await persistTransition(
        outputStopped,
        reduceOpenAiNativeSpeechDelivery(outputStopped, {
          type: 'RESPONSE_DONE', providerResponseIdHmac: responseHmac,
          outputTranscriptHmac: initial.canonicalSpeechHmac, atMs: at + 5,
        }),
      );
      expect(completed.phase).toBe('completed');
      const beforeReplay = await storedProof(completed);
      expect(await repositories[1].compareAndSwap({
        key: { companyId, deliveryId: completed.deliveryId },
        expectedRevision: outputStopped.revision,
        next: completed,
      })).toEqual({ status: 'already_applied', state: completed });
      expect(await storedProof(completed)).toEqual(beforeReplay);
      expect(beforeReplay.controlCount).toBe(0);
    }, 30_000);

    it('laisse l’horloge DB seule autoriser EXPIRE et refuse les transitions devenues obsolètes', async () => {
      const authority = await createAuthority('expiry');
      const initial = await delivery(authority, 'expiry', 500);
      expect(await repositories[0].prepare(initial)).toMatchObject({ status: 'created' });
      const expired = reduceOpenAiNativeSpeechDelivery(initial, {
        type: 'EXPIRE',
        atMs: initial.expiresAtMs,
      });
      expect(await repositories[0].compareAndSwap({
        key: { companyId, deliveryId: initial.deliveryId },
        expectedRevision: initial.revision,
        next: expired,
      })).toEqual({ status: 'conflict' });

      await waitUntilExpired(initial.expiresAtMs);
      expect(await repositories[0].compareAndSwap({
        key: { companyId, deliveryId: initial.deliveryId },
        expectedRevision: initial.revision,
        next: claim(initial),
      })).toEqual({ status: 'conflict' });
      const cancelled = reduceOpenAiNativeSpeechDelivery(initial, {
        type: 'CANCEL',
        cancellationId: randomUUID(),
        reason: 'user_cancel',
        atMs: initial.createdAtMs + 1,
      });
      expect(await repositories[0].compareAndSwap({
        key: { companyId, deliveryId: initial.deliveryId },
        expectedRevision: initial.revision,
        next: cancelled,
      })).toEqual({ status: 'conflict' });
      expect(await repositories[0].compareAndSwap({
        key: { companyId, deliveryId: initial.deliveryId },
        expectedRevision: initial.revision,
        next: expired,
      })).toEqual({ status: 'applied', state: expired });
    }, 30_000);

    it('fence takeover et dérive de contexte, tout en autorisant leur terminalisation', async () => {
      const takeoverAuthority = await createAuthority('takeover');
      const takeoverState = await delivery(takeoverAuthority, 'takeover');
      expect(await repositories[0].prepare(takeoverState)).toMatchObject({ status: 'created' });
      expect(await sidebands[0].release(takeoverAuthority.owner)).toEqual({ status: 'released' });
      const takeover = await sidebands[1].acquire({
        companyId,
        sessionId: takeoverAuthority.lease.sessionId,
        ownerInstanceHash: digest(`owner-instance:${suffix}:takeover:2`),
        candidateOwnerTokenHash: digest(`owner-token:${suffix}:takeover:2`),
        leaseSeconds: 120,
      });
      if (takeover.status !== 'acquired') throw new Error(`Takeover failed: ${takeover.status}`);
      expect(await sidebands[1].applyContext(takeover.owner, {
        revision: takeoverAuthority.context.snapshot.revision,
        digest: takeoverAuthority.context.digest,
      })).toEqual({ status: 'applied' });
      const ambientProof = await workers[0].runInTransaction(async () => {
        const result = await repositories[0].compareAndSwap({
          key: { companyId, deliveryId: takeoverState.deliveryId },
          expectedRevision: takeoverState.revision,
          next: claim(takeoverState),
        });
        const tx = workers[0].client() as Prisma.TransactionClient;
        const [health] = await tx.$queryRaw<Array<{ ok: number; tenant: string | null }>>`
          SELECT 1::integer AS ok,
                 NULLIF(current_setting('app.current_company_id', true), '') AS tenant
        `;
        return { result, health };
      });
      expect(ambientProof).toEqual({
        result: { status: 'unavailable' },
        health: { ok: 1, tenant: null },
      });
      const ownerLost = reduceOpenAiNativeSpeechDelivery(takeoverState, {
        type: 'FAIL', failureId: randomUUID(), reason: 'owner_lost',
        atMs: Math.max((await databaseNow()).getTime(), takeoverState.createdAtMs),
      });
      expect(await repositories[0].compareAndSwap({
        key: { companyId, deliveryId: takeoverState.deliveryId },
        expectedRevision: takeoverState.revision,
        next: ownerLost,
      })).toEqual({ status: 'applied', state: ownerLost });

      const contextAuthority = await createAuthority('context-drift');
      const contextState = await delivery(contextAuthority, 'context-drift');
      expect(await repositories[0].prepare(contextState)).toMatchObject({ status: 'created' });
      const nextContext = prepareRealtimeContext({
        version: 1,
        revision: 2,
        context: {
          screen: { name: '/devis/new', instanceId: 'native-cert:context-drift:2' },
          entities: [],
          capabilities: ['screen.read'],
        },
      });
      if (!nextContext) throw new Error('Next certification context invalid.');
      expect(await admissions[0].updateContext({
        companyId,
        subjectHash: contextAuthority.subjectHmac,
        sessionId: contextAuthority.lease.sessionId,
        version: nextContext.snapshot.version,
        revision: nextContext.snapshot.revision,
        context: nextContext.snapshot.context,
      })).toEqual({ ok: true, status: 'updated', revision: 2 });
      expect(await sidebands[0].applyContext(contextAuthority.owner, {
        revision: nextContext.snapshot.revision,
        digest: nextContext.digest,
      })).toEqual({ status: 'applied' });
      expect(await repositories[0].compareAndSwap({
        key: { companyId, deliveryId: contextState.deliveryId },
        expectedRevision: contextState.revision,
        next: claim(contextState),
      })).toEqual({ status: 'unavailable' });
      const contextChanged = reduceOpenAiNativeSpeechDelivery(contextState, {
        type: 'CANCEL', cancellationId: randomUUID(), reason: 'context_changed',
        atMs: Math.max((await databaseNow()).getTime(), contextState.createdAtMs),
      });
      expect(await repositories[0].compareAndSwap({
        key: { companyId, deliveryId: contextState.deliveryId },
        expectedRevision: contextState.revision,
        next: contextChanged,
      })).toEqual({ status: 'applied', state: contextChanged });
    }, 30_000);
  },
);
