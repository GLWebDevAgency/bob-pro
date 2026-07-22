import { createHash, randomInt, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Prisma, PrismaClient } from '@prisma/client';
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
import { PrismaOpenAiNativeSpeechMaintenance } from './openai-native-speech-maintenance.prisma';
import type { RealtimeSidebandOwnerIdentity } from './realtime-sideband-owner';
import { PrismaRealtimeSidebandOwner } from './realtime-sideband-owner.prisma';

const RUN_POSTGRES_CERT = process.env.RUN_POSTGRES_OPENAI_NATIVE_DELIVERY_CERT === 'true';
const CERT_DATABASE_KIND = process.env.OPENAI_NATIVE_CERT_DATABASE_KIND;
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
      'OPENAI_NATIVE_CERT_DATABASE_KIND=ephemeral is required: mutation certification refused.',
    );
  }
  const runtimeDatabase = certifiedEphemeralTarget(process.env.DATABASE_URL ?? '', 'DATABASE_URL');
  const directDatabase = certifiedEphemeralTarget(process.env.DIRECT_URL ?? '', 'DIRECT_URL');
  if (runtimeDatabase !== directDatabase) {
    throw new Error('DATABASE_URL and DIRECT_URL must target the same ephemeral database.');
  }
}
const DAY_MS = 24 * 60 * 60 * 1_000;
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
    let maintenances: [
      PrismaOpenAiNativeSpeechMaintenance,
      PrismaOpenAiNativeSpeechMaintenance,
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
      for (let attempt = 0; attempt < 500; attempt += 1) {
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

    function historicalTerminalState(
      label: string,
      terminal: 'delivered' | 'cancelled' | 'failed' | 'expired',
      databaseNow: Date,
      ageDays = 31,
    ): OpenAiNativeSpeechDeliveryState {
      const createdAtMs = databaseNow.getTime() - ageDays * DAY_MS;
      const initial = createOpenAiNativeSpeechDelivery({
        deliveryId: randomUUID(),
        companyId,
        subjectHmac: digest(`historical-subject:${suffix}:${label}`),
        sessionId: randomUUID(),
        turnId: randomUUID(),
        contextRevision: 1,
        contextDigest: digest(`historical-context:${suffix}:${label}`),
        sidebandOwnerEpoch: 1,
        sidebandOwnerTokenHmac: digest(`historical-owner:${suffix}:${label}`),
        speechPolicyVersion: 1,
        speechScenarioId: 'generic_help_v1',
        proofFormatVersion: 2,
        proofKeyVersion: 1,
        canonicalSpeechHmac: digest(`historical-speech:${suffix}:${label}`),
        factsHmac: digest(`historical-facts:${suffix}:${label}`),
        requestNonceHmac: digest(`historical-nonce:${suffix}:${label}`),
        provider: 'openai',
        model: 'gpt-realtime-2.1',
        voice: 'marin',
        createdAtMs,
        expiresAtMs: createdAtMs + 5 * 60_000,
      });
      if (terminal === 'expired') {
        return reduceOpenAiNativeSpeechDelivery(initial, {
          type: 'EXPIRE', atMs: initial.expiresAtMs,
        });
      }
      if (terminal === 'cancelled') {
        return reduceOpenAiNativeSpeechDelivery(initial, {
          type: 'CANCEL', cancellationId: randomUUID(), reason: 'session_end',
          atMs: createdAtMs + 1,
        });
      }
      if (terminal === 'failed') {
        return reduceOpenAiNativeSpeechDelivery(initial, {
          type: 'FAIL', failureId: randomUUID(), reason: 'provider_failed',
          atMs: createdAtMs + 1,
        });
      }
      const responseHmac = digest(`historical-response:${suffix}:${label}`);
      let state = reduceOpenAiNativeSpeechDelivery(initial, {
        type: 'CLAIM_DISPATCH', dispatchClaimId: randomUUID(), atMs: createdAtMs + 1,
      });
      state = reduceOpenAiNativeSpeechDelivery(state, {
        type: 'MARK_REQUESTED', dispatchClaimId: state.dispatchClaimId!, atMs: createdAtMs + 2,
      });
      state = reduceOpenAiNativeSpeechDelivery(state, {
        type: 'ACCEPT_RESPONSE', providerResponseIdHmac: responseHmac, atMs: createdAtMs + 3,
      });
      state = reduceOpenAiNativeSpeechDelivery(state, {
        type: 'START_STREAMING', providerResponseIdHmac: responseHmac, atMs: createdAtMs + 4,
      });
      state = reduceOpenAiNativeSpeechDelivery(state, {
        type: 'RESPONSE_DONE', providerResponseIdHmac: responseHmac,
        outputTranscriptHmac: initial.canonicalSpeechHmac, atMs: createdAtMs + 5,
      });
      state = reduceOpenAiNativeSpeechDelivery(state, {
        type: 'OUTPUT_STOPPED', providerResponseIdHmac: responseHmac, atMs: createdAtMs + 6,
      });
      return reduceOpenAiNativeSpeechDelivery(state, {
        type: 'ACK_DELIVERY',
        acknowledgementId: randomUUID(),
        deliveryId: state.deliveryId,
        sessionId: state.sessionId,
        turnId: state.turnId,
        contextRevision: state.contextRevision,
        contextDigest: state.contextDigest,
        slo: null,
        atMs: createdAtMs + 7,
      });
    }

    function historicalNonTerminalState(
      label: string,
      target: 'prepared' | 'dispatching' | 'requested' | 'accepted' | 'streaming' | 'draining' | 'completed',
      databaseNow: Date,
      tenantId = companyId,
    ): OpenAiNativeSpeechDeliveryState {
      const createdAtMs = databaseNow.getTime() - DAY_MS;
      const initial = createOpenAiNativeSpeechDelivery({
        deliveryId: randomUUID(),
        companyId: tenantId,
        subjectHmac: digest(`historical-live-subject:${suffix}:${label}`),
        sessionId: randomUUID(),
        turnId: randomUUID(),
        contextRevision: 1,
        contextDigest: digest(`historical-live-context:${suffix}:${label}`),
        sidebandOwnerEpoch: 1,
        sidebandOwnerTokenHmac: digest(`historical-live-owner:${suffix}:${label}`),
        speechPolicyVersion: 1,
        speechScenarioId: 'generic_help_v1',
        proofFormatVersion: 2,
        proofKeyVersion: 1,
        canonicalSpeechHmac: digest(`historical-live-speech:${suffix}:${label}`),
        factsHmac: digest(`historical-live-facts:${suffix}:${label}`),
        requestNonceHmac: digest(`historical-live-nonce:${suffix}:${label}`),
        provider: 'openai',
        model: 'gpt-realtime-2.1',
        voice: 'marin',
        createdAtMs,
        expiresAtMs: createdAtMs + 5 * 60_000,
      });
      const responseHmac = digest(`historical-live-response:${suffix}:${label}`);
      let state = initial;
      if (target !== 'prepared') {
        state = reduceOpenAiNativeSpeechDelivery(state, {
          type: 'CLAIM_DISPATCH', dispatchClaimId: randomUUID(), atMs: createdAtMs + 1,
        });
      }
      if (['requested', 'accepted', 'streaming', 'draining', 'completed'].includes(target)) {
        state = reduceOpenAiNativeSpeechDelivery(state, {
          type: 'MARK_REQUESTED', dispatchClaimId: state.dispatchClaimId!, atMs: createdAtMs + 2,
        });
      }
      if (['accepted', 'streaming', 'draining', 'completed'].includes(target)) {
        state = reduceOpenAiNativeSpeechDelivery(state, {
          type: 'ACCEPT_RESPONSE', providerResponseIdHmac: responseHmac, atMs: createdAtMs + 3,
        });
      }
      if (['streaming', 'draining', 'completed'].includes(target)) {
        state = reduceOpenAiNativeSpeechDelivery(state, {
          type: 'START_STREAMING', providerResponseIdHmac: responseHmac, atMs: createdAtMs + 4,
        });
      }
      if (['draining', 'completed'].includes(target)) {
        state = reduceOpenAiNativeSpeechDelivery(state, {
          type: 'RESPONSE_DONE', providerResponseIdHmac: responseHmac,
          outputTranscriptHmac: state.canonicalSpeechHmac, atMs: createdAtMs + 5,
        });
      }
      if (target === 'completed') {
        state = reduceOpenAiNativeSpeechDelivery(state, {
          type: 'OUTPUT_STOPPED', providerResponseIdHmac: responseHmac, atMs: createdAtMs + 6,
        });
      }
      return state;
    }

    function historicalRow(
      state: OpenAiNativeSpeechDeliveryState,
      retentionExpiresAt: Date,
    ): Prisma.RealtimeNativeSpeechDeliveryUncheckedCreateInput {
      const at = (value: number | null) => value === null ? null : new Date(value);
      return {
        deliveryId: state.deliveryId,
        companyId: state.companyId,
        subjectHmac: state.subjectHmac,
        sessionId: state.sessionId,
        turnId: state.turnId,
        contextRevision: state.contextRevision,
        contextDigest: state.contextDigest,
        sidebandOwnerEpoch: state.sidebandOwnerEpoch,
        sidebandOwnerTokenHmac: state.sidebandOwnerTokenHmac,
        speechPolicyVersion: state.speechPolicyVersion,
        speechScenarioId: state.speechScenarioId,
        canonicalSpeechHmac: state.canonicalSpeechHmac,
        factsHmac: state.factsHmac,
        requestNonceHmac: state.requestNonceHmac,
        proofFormatVersion: state.proofFormatVersion,
        proofKeyVersion: state.proofKeyVersion,
        provider: state.provider,
        model: state.model,
        voice: state.voice,
        version: state.version,
        revision: state.revision,
        phase: state.phase,
        dispatchClaimId: state.dispatchClaimId,
        dispatchingAt: at(state.dispatchingAtMs),
        requestedAt: at(state.requestedAtMs),
        providerResponseIdHmac: state.providerResponseIdHmac,
        acceptedAt: at(state.acceptedAtMs),
        streamingAt: at(state.streamingAtMs),
        responseDoneAt: at(state.responseDoneAtMs),
        outputStoppedAt: at(state.outputStoppedAtMs),
        outputTranscriptHmac: state.outputTranscriptHmac,
        completedAt: at(state.completedAtMs),
        acknowledgementId: state.acknowledgementId,
        deliveredAt: at(state.deliveredAtMs),
        sloFormatVersion: state.sloFormatVersion,
        speechStoppedEventToFirstInboundRtpMs: state.speechStoppedEventToFirstInboundRtpMs,
        bargeInStatus: state.bargeInStatus,
        bargeInDurationsMs: [...state.bargeInDurationsMs],
        cancellationId: state.cancellationId,
        cancellationReason: state.cancellationReason,
        failureId: state.failureId,
        failureReason: state.failureReason,
        terminalAt: at(state.terminalAtMs),
        createdAt: new Date(state.createdAtMs),
        expiresAt: new Date(state.expiresAtMs),
        retentionExpiresAt,
      };
    }

    async function insertHistoricalTerminals(
      specs: ReadonlyArray<{
        readonly label: string;
        readonly terminal: 'delivered' | 'cancelled' | 'failed' | 'expired';
        readonly ageDays?: number;
      }>,
    ): Promise<OpenAiNativeSpeechDeliveryState[]> {
      const now = await databaseNow();
      const states = specs.map((spec) =>
        historicalTerminalState(spec.label, spec.terminal, now, spec.ageDays));
      await admin.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
        for (let index = 0; index < states.length; index += 1) {
          const state = states[index]!;
          const ageDays = specs[index]?.ageDays ?? 31;
          await tx.realtimeNativeSpeechDelivery.create({
            data: historicalRow(
              state,
              new Date(now.getTime() - ageDays * DAY_MS + 30 * DAY_MS),
            ),
          });
        }
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = origin');
      }, { timeout: 10_000 });
      return states;
    }

    async function insertHistoricalNonTerminals(
      states: readonly OpenAiNativeSpeechDeliveryState[],
    ): Promise<void> {
      await admin.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
        for (const state of states) {
          await tx.realtimeNativeSpeechDelivery.create({
            data: historicalRow(state, new Date(state.createdAtMs + 30 * DAY_MS)),
          });
        }
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = origin');
      }, { timeout: 10_000 });
    }

    async function cleanupPreviouslyExpiredLiveDeliveries(
      tenantId = companyId,
    ): Promise<void> {
      await admin.$executeRaw`
        DELETE FROM realtime_native_speech_deliveries
         WHERE "companyId" = ${tenantId}
           AND phase NOT IN ('delivered', 'cancelled', 'failed', 'expired')
           AND "expiresAt" <= clock_timestamp()
      `;
    }

    async function assertEphemeralAdminTarget(): Promise<void> {
      const runtimeDatabase = certifiedEphemeralTarget(runtimeUrl, 'DATABASE_URL');
      const directDatabase = certifiedEphemeralTarget(directUrl, 'DIRECT_URL');
      const [physicalTarget] = await admin.$queryRaw<Array<{ databaseName: string }>>`
        SELECT current_database() AS "databaseName"
      `;
      if (
        runtimeDatabase !== directDatabase
        || physicalTarget?.databaseName !== directDatabase
      ) {
        throw new Error('Maintenance certification target changed after startup.');
      }
    }

    async function resetMaintenanceLane(lane: 'expiry' | 'retention'): Promise<void> {
      await assertEphemeralAdminTarget();
      const updated = await admin.$executeRaw`
        UPDATE realtime_native_speech_maintenance_cursors
           SET "afterDueAt" = NULL,
               "afterCompanyId" = NULL,
               "afterDeliveryId" = NULL,
               "cycleUpperDueAt" = NULL,
               "cycleUpperCompanyId" = NULL,
               "cycleUpperDeliveryId" = NULL,
               "pendingCompanyIds" = ARRAY[]::TEXT[],
               "pendingAfterDueAt" = NULL,
               "pendingAfterCompanyId" = NULL,
               "pendingAfterDeliveryId" = NULL,
               "pendingHasMore" = NULL,
               "claimId" = NULL,
               "claimExpiresAt" = NULL,
               revision = revision + 1
         WHERE lane = ${lane}
      `;
      expect(updated).toBe(1);
    }

    async function forceExpireMaintenanceClaim(
      lane: 'expiry' | 'retention',
      claimId: string,
    ): Promise<void> {
      await assertEphemeralAdminTarget();
      const updated = await admin.$executeRaw`
        UPDATE realtime_native_speech_maintenance_cursors
           SET "claimExpiresAt" = statement_timestamp() - INTERVAL '1 millisecond',
               revision = revision + 1
         WHERE lane = ${lane}
           AND "claimId" = ${claimId}::uuid
      `;
      expect(updated).toBe(1);
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
      maintenances = workers.map((worker) => new PrismaOpenAiNativeSpeechMaintenance(
        worker,
      )) as typeof maintenances;
      await Promise.all([admin.$connect(), ...workers.map((worker) => worker.$connect())]);
      await assertEphemeralAdminTarget();
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
      const [acl] = await workers[0].$queryRaw<Array<{
        canDelete: boolean;
        canTruncate: boolean;
        canTrigger: boolean;
      }>>`
        SELECT has_table_privilege(
                 current_user, 'public.realtime_native_speech_deliveries', 'DELETE'
               ) AS "canDelete",
               has_table_privilege(
                 current_user, 'public.realtime_native_speech_deliveries', 'TRUNCATE'
               ) AS "canTruncate",
               has_table_privilege(
                 current_user, 'public.realtime_native_speech_deliveries', 'TRIGGER'
               ) AS "canTrigger"
      `;
      expect(acl).toEqual({ canDelete: true, canTruncate: false, canTrigger: false });
      const [v1ControlFence] = await admin.$queryRaw<Array<{ active: boolean }>>`
        SELECT convalidated AS active
          FROM pg_constraint
         WHERE conrelid = 'public.realtime_control_grants'::regclass
           AND conname = 'realtime_control_grants_provider_stream_v1_disabled_check'
      `;
      expect(v1ControlFence).toEqual({ active: true });

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
        }))).resolves.toEqual({ count: 0 });
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

    it('expire en batch toutes les phases non terminales, une seule fois et sans toucher le futur', async () => {
      await cleanupPreviouslyExpiredLiveDeliveries();
      await cleanupPreviouslyExpiredLiveDeliveries(otherCompanyId);
      await resetMaintenanceLane('expiry');
      const targets = [
        'prepared',
        'dispatching',
        'requested',
        'accepted',
        'streaming',
        'draining',
        'completed',
      ] as const;
      const now = await databaseNow();
      const candidates = targets.map((target) =>
        historicalNonTerminalState(`maintenance-${target}`, target, now));
      const otherCandidate = historicalNonTerminalState(
        'maintenance-other-tenant',
        'prepared',
        now,
        otherCompanyId,
      );
      await insertHistoricalNonTerminals([...candidates, otherCandidate]);

      const requestedClaimId = randomUUID();
      const rawDue = await workers[0].$queryRaw<Array<{
        companyId: string;
        hasMore: boolean;
        claimId: string;
      }>>`
        SELECT due."companyId" AS "companyId", due."hasMore" AS "hasMore",
               due."claimId" AS "claimId"
          FROM public.list_realtime_native_speech_maintenance_tenants_v1(
            'expiry'::text, 100::integer, ${requestedClaimId}::uuid
          ) AS due
      `;
      expect(rawDue.map((row) => row.companyId)).toEqual(
        expect.arrayContaining([companyId, otherCompanyId]),
      );
      expect(rawDue).toHaveLength(2);
      expect(rawDue.every((row) => row.claimId === requestedClaimId)).toBe(true);
      expect(rawDue.every((row) => row.hasMore === false)).toBe(true);

      const terminalAuthority = await createAuthority('maintenance-terminal');
      const terminalInitial = await delivery(terminalAuthority, 'maintenance-terminal', 300_000);
      expect(await repositories[0].prepare(terminalInitial)).toMatchObject({ status: 'created' });
      const terminal = reduceOpenAiNativeSpeechDelivery(terminalInitial, {
        type: 'CANCEL', cancellationId: randomUUID(), reason: 'user_cancel',
        atMs: terminalInitial.createdAtMs + 1,
      });
      await persistTransition(terminalInitial, terminal);

      const futureAuthority = await createAuthority('maintenance-future');
      const future = await delivery(futureAuthority, 'maintenance-future', 300_000);
      expect(await repositories[0].prepare(future)).toMatchObject({ status: 'created' });

      await expect(maintenances[0].renewDueCompanyIdsClaim({
        lane: 'expiry', claimId: requestedClaimId,
      })).resolves.toEqual({ status: 'succeeded', renewed: true });
      const sweep = await Promise.all(maintenances.map((maintenance) =>
        maintenance.reapExpired({ companyId, limit: 100 })));
      expect(sweep.every((result) => result.status === 'succeeded')).toBe(true);
      expect(sweep.reduce(
        (total, result) => total + (result.status === 'succeeded' ? result.expiredCount : 0),
        0,
      )).toBe(candidates.length);

      for (const previous of candidates) {
        const current = await repositories[0].read({ companyId, deliveryId: previous.deliveryId });
        expect(current.status).toBe('found');
        if (current.status !== 'found') throw new Error('Reaped delivery missing.');
        expect(current.state).toMatchObject({
          phase: 'expired',
          revision: previous.revision + 1,
          terminalAtMs: previous.expiresAtMs,
        });
      }
      expect(await repositories[0].read({ companyId, deliveryId: terminal.deliveryId }))
        .toEqual({ status: 'found', state: terminal });
      expect(await repositories[0].read({ companyId, deliveryId: future.deliveryId }))
        .toEqual({ status: 'found', state: future });
      await expect(maintenances[1].renewDueCompanyIdsClaim({
        lane: 'expiry', claimId: requestedClaimId,
      })).resolves.toEqual({ status: 'succeeded', renewed: true });
      await expect(maintenances[0].reapExpired({ companyId: otherCompanyId, limit: 100 }))
        .resolves.toEqual({ status: 'succeeded', expiredCount: 1, hasMore: false });
      await expect(maintenances[0].renewDueCompanyIdsClaim({
        lane: 'expiry', claimId: requestedClaimId,
      })).resolves.toEqual({ status: 'succeeded', renewed: true });
      await expect(maintenances[0].reapExpired({ companyId, limit: 100 })).resolves.toEqual({
        status: 'succeeded', expiredCount: 0, hasMore: false,
      });
      await expect(maintenances[0].acknowledgeDueCompanyIds({
        lane: 'expiry', claimId: requestedClaimId,
      })).resolves.toEqual({ status: 'succeeded', acknowledged: true });
      const noLongerDue = await maintenances[0].listDueCompanyIds({ lane: 'expiry', limit: 100 });
      expect(noLongerDue.status).toBe('succeeded');
      if (noLongerDue.status !== 'succeeded') throw new Error('Due directory unavailable.');
      expect(noLongerDue.companyIds).not.toContain(companyId);
      expect(noLongerDue.companyIds).not.toContain(otherCompanyId);
      expect(noLongerDue.claimId).toBeNull();
    }, 30_000);

    it('SKIP LOCKED ignore une ligne occupée puis la reprend au sweep suivant', async () => {
      await cleanupPreviouslyExpiredLiveDeliveries();
      const authority = await createAuthority('maintenance-lock');
      const state = await delivery(authority, 'maintenance-lock', 2_000);
      expect(await repositories[0].prepare(state)).toMatchObject({ status: 'created' });
      await waitUntilExpired(state.expiresAtMs);

      let release!: () => void;
      let locked!: () => void;
      const releaseSignal = new Promise<void>((resolve) => { release = resolve; });
      const lockSignal = new Promise<void>((resolve) => { locked = resolve; });
      const blocker = admin.$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT 1
            FROM realtime_native_speech_deliveries
           WHERE "deliveryId" = ${state.deliveryId}::uuid
           FOR UPDATE
        `;
        locked();
        await releaseSignal;
      }, { timeout: 10_000 });
      await lockSignal;

      const skipped = await Promise.race([
        maintenances[0].reapExpired({ companyId, limit: 1 }),
        delay(1_000).then(() => { throw new Error('SKIP LOCKED sweep blocked.'); }),
      ]);
      expect(skipped).toEqual({ status: 'succeeded', expiredCount: 0, hasMore: false });
      release();
      await blocker;
      await expect(maintenances[1].reapExpired({ companyId, limit: 1 })).resolves.toEqual({
        status: 'succeeded', expiredCount: 1, hasMore: false,
      });
    }, 30_000);

    it('borne réellement l’attente du curseur global verrouillé et récupère après rollback', async () => {
      await resetMaintenanceLane('expiry');

      let release!: () => void;
      let locked!: () => void;
      const releaseSignal = new Promise<void>((resolve) => { release = resolve; });
      const lockSignal = new Promise<void>((resolve) => { locked = resolve; });
      const blocker = admin.$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT 1
            FROM realtime_native_speech_maintenance_cursors
           WHERE lane = 'expiry'
           FOR UPDATE
        `;
        locked();
        await releaseSignal;
      }, { timeout: 10_000 });
      await lockSignal;

      const startedAt = Date.now();
      let blockedResult: Awaited<ReturnType<
        PrismaOpenAiNativeSpeechMaintenance['listDueCompanyIds']
      >>;
      try {
        blockedResult = await Promise.race([
          maintenances[0].listDueCompanyIds({ lane: 'expiry', limit: 1 }),
          delay(2_800).then(() => {
            throw new Error('Maintenance directory exceeded its lock timeout.');
          }),
        ]);
      } finally {
        release();
        await blocker;
      }
      const elapsedMs = Date.now() - startedAt;
      expect(blockedResult).toEqual({ status: 'unavailable' });
      expect(elapsedMs).toBeGreaterThanOrEqual(500);
      expect(elapsedMs).toBeLessThan(2_500);

      await expect(maintenances[1].listDueCompanyIds({ lane: 'expiry', limit: 1 }))
        .resolves.toEqual({ status: 'succeeded', companyIds: [], hasMore: false, claimId: null });
    }, 30_000);

    it('draine exactement 201 expirations en 100 + 100 + 1 avec hasMore exact', async () => {
      await cleanupPreviouslyExpiredLiveDeliveries();
      const now = await databaseNow();
      const states = Array.from({ length: 201 }, (_, index) =>
        historicalNonTerminalState(`maintenance-drain-${index}`, 'prepared', now));
      await insertHistoricalNonTerminals(states);

      await expect(maintenances[0].reapExpired({ companyId, limit: 100 })).resolves.toEqual({
        status: 'succeeded', expiredCount: 100, hasMore: true,
      });
      await expect(maintenances[1].reapExpired({ companyId, limit: 100 })).resolves.toEqual({
        status: 'succeeded', expiredCount: 100, hasMore: true,
      });
      await expect(maintenances[0].reapExpired({ companyId, limit: 100 })).resolves.toEqual({
        status: 'succeeded', expiredCount: 1, hasMore: false,
      });
    }, 30_000);

    it('fait avancer le curseur durable entre tenants et utilise les deux indexes keyset', async () => {
      await cleanupPreviouslyExpiredLiveDeliveries();
      await cleanupPreviouslyExpiredLiveDeliveries(otherCompanyId);
      await resetMaintenanceLane('expiry');
      const now = await databaseNow();
      const local = historicalNonTerminalState('keyset-local', 'prepared', now);
      const other = historicalNonTerminalState(
        'keyset-other',
        'prepared',
        now,
        otherCompanyId,
      );
      await insertHistoricalNonTerminals([local, other]);

      const first = await maintenances[0].listDueCompanyIds({ lane: 'expiry', limit: 1 });
      expect(first.status).toBe('succeeded');
      if (first.status !== 'succeeded') throw new Error('First keyset page unavailable.');
      expect(first.companyIds).toHaveLength(1);
      expect(first.hasMore).toBe(true);
      expect(first.claimId).toEqual(expect.any(String));
      if (!first.claimId) throw new Error('First keyset page claim missing.');
      const firstCompanyId = first.companyIds[0]!;
      await expect(maintenances[0].renewDueCompanyIdsClaim({
        lane: 'expiry', claimId: first.claimId,
      })).resolves.toEqual({ status: 'succeeded', renewed: true });
      await expect(maintenances[0].reapExpired({ companyId: firstCompanyId, limit: 100 }))
        .resolves.toMatchObject({ status: 'succeeded', expiredCount: 1 });
      await expect(maintenances[0].acknowledgeDueCompanyIds({
        lane: 'expiry', claimId: first.claimId,
      })).resolves.toEqual({ status: 'succeeded', acknowledged: true });

      const second = await maintenances[1].listDueCompanyIds({ lane: 'expiry', limit: 1 });
      expect(second.status).toBe('succeeded');
      if (second.status !== 'succeeded') throw new Error('Second keyset page unavailable.');
      expect(second.companyIds).toHaveLength(1);
      expect(second.companyIds[0]).not.toBe(firstCompanyId);
      expect(second.claimId).toEqual(expect.any(String));
      if (!second.claimId) throw new Error('Second keyset page claim missing.');
      await expect(maintenances[1].renewDueCompanyIdsClaim({
        lane: 'expiry', claimId: second.claimId,
      })).resolves.toEqual({ status: 'succeeded', renewed: true });
      await expect(maintenances[1].reapExpired({
        companyId: second.companyIds[0]!,
        limit: 100,
      })).resolves.toMatchObject({ status: 'succeeded', expiredCount: 1 });
      await expect(maintenances[1].acknowledgeDueCompanyIds({
        lane: 'expiry', claimId: second.claimId,
      })).resolves.toEqual({ status: 'succeeded', acknowledged: true });

      const plans = await admin.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
        await tx.$executeRawUnsafe('SET LOCAL enable_bitmapscan = off');
        await tx.$executeRawUnsafe('SET LOCAL enable_sort = off');
        await tx.$executeRawUnsafe('SET LOCAL enable_incremental_sort = off');
        const expiry = await tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(`
          EXPLAIN (COSTS OFF)
          SELECT "companyId"
            FROM realtime_native_speech_deliveries
           WHERE phase NOT IN ('delivered', 'cancelled', 'failed', 'expired')
             AND "expiresAt" <= statement_timestamp()
             AND ("expiresAt", "companyId", "deliveryId") >
                 ('1970-01-01 00:00:00+00'::timestamptz, ''::text,
                  '00000000-0000-0000-0000-000000000000'::uuid)
           ORDER BY "expiresAt", "companyId", "deliveryId"
           LIMIT 101
        `);
        const retention = await tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(`
          EXPLAIN (COSTS OFF)
          SELECT "companyId"
            FROM realtime_native_speech_deliveries
           WHERE phase IN ('delivered', 'cancelled', 'failed', 'expired')
             AND "retentionExpiresAt" <= statement_timestamp()
             AND ("retentionExpiresAt", "companyId", "deliveryId") >
                 ('1970-01-01 00:00:00+00'::timestamptz, ''::text,
                  '00000000-0000-0000-0000-000000000000'::uuid)
           ORDER BY "retentionExpiresAt", "companyId", "deliveryId"
           LIMIT 101
        `);
        return [...expiry, ...retention].map((row) => row['QUERY PLAN']).join('\n');
      });
      expect(plans).toContain('realtime_native_speech_due_expiry_directory_idx');
      expect(plans).toContain('realtime_native_speech_due_retention_directory_idx');
      expect(plans).toContain('Index Cond');
    }, 30_000);

    it('relivre sans perte une page crashée, refuse son ancien ACK et ne crée aucune famine', async () => {
      await cleanupPreviouslyExpiredLiveDeliveries();
      await cleanupPreviouslyExpiredLiveDeliveries(otherCompanyId);
      await resetMaintenanceLane('expiry');

      const initialNow = await databaseNow();
      const firstCycleStates = [
        historicalNonTerminalState('claim-crash-local', 'prepared', initialNow),
        historicalNonTerminalState(
          'claim-crash-other',
          'prepared',
          initialNow,
          otherCompanyId,
        ),
      ] as const;
      await insertHistoricalNonTerminals(firstCycleStates);

      const claimed = await maintenances[0].listDueCompanyIds({ lane: 'expiry', limit: 1 });
      expect(claimed.status).toBe('succeeded');
      if (claimed.status !== 'succeeded') throw new Error('Initial maintenance claim unavailable.');
      expect(claimed.companyIds).toHaveLength(1);
      expect(claimed.hasMore).toBe(true);
      expect(claimed.claimId).toEqual(expect.any(String));
      if (!claimed.claimId) throw new Error('Initial maintenance claim missing.');

      const claimedCompanyId = claimed.companyIds[0]!;
      const waitingCompanyId = claimedCompanyId === companyId ? otherCompanyId : companyId;
      const claimedState = firstCycleStates.find(
        (state) => state.companyId === claimedCompanyId,
      );
      const waitingState = firstCycleStates.find(
        (state) => state.companyId === waitingCompanyId,
      );
      if (!claimedState || !waitingState) throw new Error('Claimed test tenant mismatch.');

      const tailReference = await databaseNow();
      const tailState = historicalNonTerminalState(
        'claim-crash-concurrent-tail',
        'prepared',
        new Date(Math.max(initialNow.getTime() + 1_000, tailReference.getTime() + 1_000)),
        waitingCompanyId,
      );
      expect(tailState.expiresAtMs).toBeGreaterThan(waitingState.expiresAtMs);
      await insertHistoricalNonTerminals([tailState]);

      const blockedByLiveLease = await maintenances[1].listDueCompanyIds({
        lane: 'expiry', limit: 1,
      });
      expect(blockedByLiveLease).toEqual({
        status: 'succeeded', companyIds: [], hasMore: false, claimId: null,
      });

      await forceExpireMaintenanceClaim('expiry', claimed.claimId);
      const reclaimed = await maintenances[1].listDueCompanyIds({ lane: 'expiry', limit: 1 });
      expect(reclaimed.status).toBe('succeeded');
      if (reclaimed.status !== 'succeeded') throw new Error('Expired claim was not reclaimed.');
      expect(reclaimed.companyIds).toEqual(claimed.companyIds);
      expect(reclaimed.hasMore).toBe(claimed.hasMore);
      expect(reclaimed.claimId).toEqual(expect.any(String));
      expect(reclaimed.claimId).not.toBe(claimed.claimId);
      if (!reclaimed.claimId) throw new Error('Replacement maintenance claim missing.');

      await expect(maintenances[0].acknowledgeDueCompanyIds({
        lane: 'expiry', claimId: claimed.claimId,
      })).resolves.toEqual({ status: 'succeeded', acknowledged: false });
      await expect(maintenances[1].renewDueCompanyIdsClaim({
        lane: 'expiry', claimId: reclaimed.claimId,
      })).resolves.toEqual({ status: 'succeeded', renewed: true });
      await expect(maintenances[1].reapExpired({
        companyId: claimedCompanyId, limit: 1,
      })).resolves.toEqual({ status: 'succeeded', expiredCount: 1, hasMore: false });
      await expect(maintenances[1].acknowledgeDueCompanyIds({
        lane: 'expiry', claimId: reclaimed.claimId,
      })).resolves.toEqual({ status: 'succeeded', acknowledged: true });
      expect(await repositories[0].read({
        companyId: claimedCompanyId, deliveryId: claimedState.deliveryId,
      })).toMatchObject({ status: 'found', state: { phase: 'expired' } });

      const waitingPage = await maintenances[0].listDueCompanyIds({ lane: 'expiry', limit: 1 });
      expect(waitingPage.status).toBe('succeeded');
      if (waitingPage.status !== 'succeeded') throw new Error('Waiting tenant page unavailable.');
      expect(waitingPage.companyIds).toEqual([waitingCompanyId]);
      expect(waitingPage.hasMore).toBe(false);
      if (!waitingPage.claimId) throw new Error('Waiting tenant claim missing.');
      await expect(maintenances[0].renewDueCompanyIdsClaim({
        lane: 'expiry', claimId: waitingPage.claimId,
      })).resolves.toEqual({ status: 'succeeded', renewed: true });
      await expect(maintenances[0].reapExpired({
        companyId: waitingCompanyId, limit: 1,
      })).resolves.toEqual({ status: 'succeeded', expiredCount: 1, hasMore: true });
      await expect(maintenances[0].acknowledgeDueCompanyIds({
        lane: 'expiry', claimId: waitingPage.claimId,
      })).resolves.toEqual({ status: 'succeeded', acknowledged: true });
      expect(await repositories[0].read({
        companyId: waitingCompanyId, deliveryId: waitingState.deliveryId,
      })).toMatchObject({ status: 'found', state: { phase: 'expired' } });
      expect(await repositories[0].read({
        companyId: waitingCompanyId, deliveryId: tailState.deliveryId,
      })).toEqual({ status: 'found', state: tailState });

      const tailPage = await maintenances[1].listDueCompanyIds({ lane: 'expiry', limit: 1 });
      expect(tailPage.status).toBe('succeeded');
      if (tailPage.status !== 'succeeded') throw new Error('Concurrent tail page unavailable.');
      expect(tailPage.companyIds).toEqual([waitingCompanyId]);
      expect(tailPage.hasMore).toBe(false);
      if (!tailPage.claimId) throw new Error('Concurrent tail claim missing.');
      await expect(maintenances[1].renewDueCompanyIdsClaim({
        lane: 'expiry', claimId: tailPage.claimId,
      })).resolves.toEqual({ status: 'succeeded', renewed: true });
      await expect(maintenances[1].reapExpired({
        companyId: waitingCompanyId, limit: 1,
      })).resolves.toEqual({ status: 'succeeded', expiredCount: 1, hasMore: false });
      await expect(maintenances[1].acknowledgeDueCompanyIds({
        lane: 'expiry', claimId: tailPage.claimId,
      })).resolves.toEqual({ status: 'succeeded', acknowledged: true });
      expect(await repositories[0].read({
        companyId: waitingCompanyId, deliveryId: tailState.deliveryId,
      })).toMatchObject({ status: 'found', state: { phase: 'expired' } });
    }, 30_000);

    it('purge les quatre terminaux après rétention, concurrence incluse, jamais avant', async () => {
      await resetMaintenanceLane('retention');
      const expired = await insertHistoricalTerminals([
        { label: 'retention-delivered', terminal: 'delivered' },
        { label: 'retention-cancelled', terminal: 'cancelled' },
        { label: 'retention-failed', terminal: 'failed' },
        { label: 'retention-expired', terminal: 'expired' },
      ]);
      const [future] = await insertHistoricalTerminals([
        { label: 'retention-future', terminal: 'expired', ageDays: 29 },
      ]);
      if (!future) throw new Error('Future retention fixture missing.');

      const dueBeforePurge = await maintenances[0].listDueCompanyIds({
        lane: 'retention', limit: 100,
      });
      expect(dueBeforePurge.status).toBe('succeeded');
      if (dueBeforePurge.status !== 'succeeded') throw new Error('Due directory unavailable.');
      expect(dueBeforePurge.companyIds).toContain(companyId);
      expect(dueBeforePurge.claimId).toEqual(expect.any(String));
      if (!dueBeforePurge.claimId) throw new Error('Retention page claim missing.');

      await expect(maintenances[0].renewDueCompanyIdsClaim({
        lane: 'retention', claimId: dueBeforePurge.claimId,
      })).resolves.toEqual({ status: 'succeeded', renewed: true });
      const sweep = await Promise.all(maintenances.map((maintenance) =>
        maintenance.purgeRetained({ companyId, limit: 100 })));
      expect(sweep.every((result) => result.status === 'succeeded')).toBe(true);
      expect(sweep.reduce(
        (total, result) => total + (result.status === 'succeeded' ? result.purgedCount : 0),
        0,
      )).toBe(expired.length);
      expect(sweep.every((result) =>
        result.status !== 'succeeded' || result.dependenciesBlocked === 0)).toBe(true);

      for (const state of expired) {
        await expect(repositories[0].read({ companyId, deliveryId: state.deliveryId }))
          .resolves.toEqual({ status: 'not_found' });
      }
      await expect(repositories[0].read({ companyId, deliveryId: future.deliveryId }))
        .resolves.toEqual({ status: 'found', state: future });
      await expect(maintenances[0].acknowledgeDueCompanyIds({
        lane: 'retention', claimId: dueBeforePurge.claimId,
      })).resolves.toEqual({ status: 'succeeded', acknowledged: true });
      const dueAfterPurge = await maintenances[0].listDueCompanyIds({
        lane: 'retention', limit: 100,
      });
      expect(dueAfterPurge.status).toBe('succeeded');
      if (dueAfterPurge.status !== 'succeeded') throw new Error('Due directory unavailable.');
      expect(dueAfterPurge.companyIds).not.toContain(companyId);
      expect(dueAfterPurge.claimId).toBeNull();
    }, 30_000);

    it('borne la purge, reste idempotent et ne transforme jamais un autre tenant en oracle', async () => {
      const states = await insertHistoricalTerminals([
        { label: 'retention-batch-1', terminal: 'expired' },
        { label: 'retention-batch-2', terminal: 'expired' },
        { label: 'retention-batch-3', terminal: 'expired' },
      ]);

      await expect(maintenances[0].purgeRetained({ companyId: otherCompanyId, limit: 100 }))
        .resolves.toEqual({
          status: 'succeeded', purgedCount: 0, dependenciesBlocked: 0, hasMore: false,
        });
      expect(await repositories[0].read({ companyId, deliveryId: states[0]!.deliveryId }))
        .toMatchObject({ status: 'found' });
      await expect(maintenances[0].purgeRetained({ companyId, limit: 2 })).resolves.toEqual({
        status: 'succeeded', purgedCount: 2, dependenciesBlocked: 0, hasMore: true,
      });
      await expect(maintenances[1].purgeRetained({ companyId, limit: 2 })).resolves.toEqual({
        status: 'succeeded', purgedCount: 1, dependenciesBlocked: 0, hasMore: false,
      });
      await expect(maintenances[0].purgeRetained({ companyId, limit: 2 })).resolves.toEqual({
        status: 'succeeded', purgedCount: 0, dependenciesBlocked: 0, hasMore: false,
      });
    }, 30_000);
  },
);
