import { Prisma } from '@prisma/client';
import { PrismaService } from '../../persistence/prisma/prisma.service';
import {
  assertOpenAiNativeSpeechDeliveryState,
  type OpenAiNativeSpeechDeliveryCompareAndSwapInput,
  type OpenAiNativeSpeechDeliveryCompareAndSwapResult,
  type OpenAiNativeSpeechDeliveryKey,
  type OpenAiNativeSpeechDeliveryPrepareResult,
  type OpenAiNativeSpeechDeliveryReadResult,
  type OpenAiNativeSpeechDeliveryRepositoryPort,
  type OpenAiNativeSpeechDeliveryState,
} from './openai-native-speech-delivery';

const POSTGRES_INT_MAX = 2_147_483_647;
const PREPARATION_CLOCK_SKEW_MS = 60_000;
const MAX_RETENTION_MS = 31 * 24 * 60 * 60 * 1_000;
const DELIVERY_TRANSACTION_OPTIONS = { maxWaitMs: 1_000, timeoutMs: 4_000 } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TENANT_ID = /^[A-Za-z0-9-]{1,64}$/u;

interface DatabaseFenceRow {
  readonly databaseNow: Date;
}

interface NativeDeliveryRow {
  readonly deliveryId: string;
  readonly companyId: string;
  readonly subjectHmac: string;
  readonly subjectKeyVersion: number | null;
  readonly sessionId: string;
  readonly turnId: string;
  readonly contextRevision: number;
  readonly contextDigest: string;
  readonly sidebandOwnerEpoch: number;
  readonly sidebandOwnerTokenHmac: string;
  readonly speechPolicyVersion: number;
  readonly speechScenarioId: string;
  readonly canonicalSpeechHmac: string;
  readonly factsHmac: string;
  readonly requestNonceHmac: string;
  readonly proofFormatVersion: number;
  readonly proofKeyVersion: number;
  readonly provider: string;
  readonly model: string;
  readonly voice: string;
  readonly version: number;
  readonly revision: number;
  readonly phase: string;
  readonly dispatchClaimId: string | null;
  readonly dispatchingAt: Date | null;
  readonly requestedAt: Date | null;
  readonly providerResponseIdHmac: string | null;
  readonly acceptedAt: Date | null;
  readonly streamingAt: Date | null;
  readonly responseDoneAt: Date | null;
  readonly outputStoppedAt: Date | null;
  readonly outputTranscriptHmac: string | null;
  readonly completedAt: Date | null;
  readonly acknowledgementId: string | null;
  readonly deliveredAt: Date | null;
  readonly localObservationFormatVersion: number | null;
  readonly localObservationKind: string | null;
  readonly sloFormatVersion: number | null;
  readonly speechStoppedEventToFirstInboundRtpMs: number | null;
  readonly bargeInStatus: string | null;
  readonly bargeInDurationsMs: number[];
  readonly cancellationId: string | null;
  readonly cancellationReason: string | null;
  readonly failureId: string | null;
  readonly failureReason: string | null;
  readonly terminalAt: Date | null;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly retentionExpiresAt: Date;
}

const DELIVERY_COLUMNS = Prisma.sql`
  "deliveryId", "companyId", "subjectHmac", "subjectKeyVersion", "sessionId", "turnId",
  "contextRevision", "contextDigest", "sidebandOwnerEpoch", "sidebandOwnerTokenHmac",
  "speechPolicyVersion", "speechScenarioId", "canonicalSpeechHmac", "factsHmac",
  "requestNonceHmac", "proofFormatVersion", "proofKeyVersion",
  provider, model, voice, version, revision, phase,
  "dispatchClaimId", "dispatchingAt", "requestedAt", "providerResponseIdHmac",
  "acceptedAt", "streamingAt", "responseDoneAt", "outputStoppedAt",
  "outputTranscriptHmac", "completedAt", "acknowledgementId", "deliveredAt",
  "localObservationFormatVersion", "localObservationKind",
  "sloFormatVersion", "speechStoppedEventToFirstInboundRtpMs", "bargeInStatus",
  "bargeInDurationsMs", "cancellationId", "cancellationReason", "failureId",
  "failureReason", "terminalAt", "createdAt", "expiresAt", "retentionExpiresAt"
`;

function trim(value: string | null): string | null {
  return value === null ? null : value.trim();
}

function validDate(value: unknown): value is Date {
  return value instanceof Date
    && Number.isSafeInteger(value.getTime())
    && value.getTime() >= 0;
}

function timestamp(value: Date | null): number | null {
  return value === null ? null : value.getTime();
}

function date(value: number | null): Date | null {
  return value === null ? null : new Date(value);
}

function mapRow(row: NativeDeliveryRow): OpenAiNativeSpeechDeliveryState | null {
  const dates = [
    row.createdAt,
    row.expiresAt,
    row.retentionExpiresAt,
    row.dispatchingAt,
    row.requestedAt,
    row.acceptedAt,
    row.streamingAt,
    row.responseDoneAt,
    row.outputStoppedAt,
    row.completedAt,
    row.deliveredAt,
    row.terminalAt,
  ];
  if (
    dates.some((candidate) => candidate !== null && !validDate(candidate))
    || !Array.isArray(row.bargeInDurationsMs)
    || row.bargeInDurationsMs.some((duration) => typeof duration !== 'number')
    || row.retentionExpiresAt.getTime() <= row.expiresAt.getTime()
    || row.retentionExpiresAt.getTime() - row.createdAt.getTime() > MAX_RETENTION_MS
  ) return null;

  const candidate: OpenAiNativeSpeechDeliveryState = {
    version: row.version as OpenAiNativeSpeechDeliveryState['version'],
    revision: row.revision,
    phase: row.phase as OpenAiNativeSpeechDeliveryState['phase'],
    deliveryId: row.deliveryId.toLowerCase(),
    companyId: row.companyId,
    subjectHmac: row.subjectHmac.trim(),
    subjectKeyVersion: row.subjectKeyVersion,
    sessionId: row.sessionId.toLowerCase(),
    turnId: row.turnId.toLowerCase(),
    contextRevision: row.contextRevision,
    contextDigest: row.contextDigest.trim(),
    sidebandOwnerEpoch: row.sidebandOwnerEpoch,
    sidebandOwnerTokenHmac: row.sidebandOwnerTokenHmac.trim(),
    speechPolicyVersion:
      row.speechPolicyVersion as OpenAiNativeSpeechDeliveryState['speechPolicyVersion'],
    speechScenarioId:
      row.speechScenarioId as OpenAiNativeSpeechDeliveryState['speechScenarioId'],
    proofFormatVersion:
      row.proofFormatVersion as OpenAiNativeSpeechDeliveryState['proofFormatVersion'],
    proofKeyVersion: row.proofKeyVersion,
    canonicalSpeechHmac: row.canonicalSpeechHmac.trim(),
    factsHmac: row.factsHmac.trim(),
    requestNonceHmac: row.requestNonceHmac.trim(),
    provider: row.provider as OpenAiNativeSpeechDeliveryState['provider'],
    model: row.model,
    voice: row.voice,
    createdAtMs: row.createdAt.getTime(),
    expiresAtMs: row.expiresAt.getTime(),
    dispatchClaimId: row.dispatchClaimId?.toLowerCase() ?? null,
    dispatchingAtMs: timestamp(row.dispatchingAt),
    requestedAtMs: timestamp(row.requestedAt),
    providerResponseIdHmac: trim(row.providerResponseIdHmac),
    acceptedAtMs: timestamp(row.acceptedAt),
    streamingAtMs: timestamp(row.streamingAt),
    responseDoneAtMs: timestamp(row.responseDoneAt),
    outputStoppedAtMs: timestamp(row.outputStoppedAt),
    outputTranscriptHmac: trim(row.outputTranscriptHmac),
    completedAtMs: timestamp(row.completedAt),
    acknowledgementId: row.acknowledgementId?.toLowerCase() ?? null,
    deliveredAtMs: timestamp(row.deliveredAt),
    localObservationFormatVersion:
      row.localObservationFormatVersion as
        OpenAiNativeSpeechDeliveryState['localObservationFormatVersion'],
    localObservationKind:
      row.localObservationKind as OpenAiNativeSpeechDeliveryState['localObservationKind'],
    sloFormatVersion:
      row.sloFormatVersion as OpenAiNativeSpeechDeliveryState['sloFormatVersion'],
    speechStoppedEventToFirstInboundRtpMs: row.speechStoppedEventToFirstInboundRtpMs,
    bargeInStatus: row.bargeInStatus as OpenAiNativeSpeechDeliveryState['bargeInStatus'],
    bargeInDurationsMs: [...row.bargeInDurationsMs],
    cancellationId: row.cancellationId?.toLowerCase() ?? null,
    cancellationReason:
      row.cancellationReason as OpenAiNativeSpeechDeliveryState['cancellationReason'],
    failureId: row.failureId?.toLowerCase() ?? null,
    failureReason: row.failureReason as OpenAiNativeSpeechDeliveryState['failureReason'],
    terminalAtMs: timestamp(row.terminalAt),
  };
  try {
    assertOpenAiNativeSpeechDeliveryState(candidate);
    return candidate;
  } catch {
    return null;
  }
}

function sameState(
  left: OpenAiNativeSpeechDeliveryState,
  right: OpenAiNativeSpeechDeliveryState,
): boolean {
  const leftRecord = left as unknown as Record<string, unknown>;
  const rightRecord = right as unknown as Record<string, unknown>;
  const keys = Object.keys(leftRecord);
  return keys.length === Object.keys(rightRecord).length
    && keys.every((key) => {
      const leftValue = leftRecord[key];
      const rightValue = rightRecord[key];
      return Array.isArray(leftValue) && Array.isArray(rightValue)
        ? leftValue.length === rightValue.length
          && leftValue.every((value, index) => Object.is(value, rightValue[index]))
        : Object.is(leftValue, rightValue);
    });
}

function validKey(key: OpenAiNativeSpeechDeliveryKey): boolean {
  return typeof key === 'object'
    && key !== null
    && typeof key.companyId === 'string'
    && typeof key.deliveryId === 'string'
    && TENANT_ID.test(key.companyId)
    && UUID.test(key.deliveryId);
}

function validState(state: OpenAiNativeSpeechDeliveryState): boolean {
  try {
    assertOpenAiNativeSpeechDeliveryState(state);
    return true;
  } catch {
    return false;
  }
}

function validCompareAndSwap(input: OpenAiNativeSpeechDeliveryCompareAndSwapInput): boolean {
  return typeof input === 'object'
    && input !== null
    && validKey(input.key)
    && Number.isSafeInteger(input.expectedRevision)
    && input.expectedRevision >= 1
    && input.expectedRevision < POSTGRES_INT_MAX
    && validState(input.next)
    && input.next.companyId === input.key.companyId
    && input.next.deliveryId === input.key.deliveryId
    && input.next.revision === input.expectedRevision + 1;
}

function latestTimelineAtMs(state: OpenAiNativeSpeechDeliveryState): number {
  return Math.max(
    state.createdAtMs,
    state.dispatchingAtMs ?? -1,
    state.requestedAtMs ?? -1,
    state.acceptedAtMs ?? -1,
    state.streamingAtMs ?? -1,
    state.responseDoneAtMs ?? -1,
    state.outputStoppedAtMs ?? -1,
    state.completedAtMs ?? -1,
    state.deliveredAtMs ?? -1,
    state.terminalAtMs ?? -1,
  );
}

/**
 * Autorité PostgreSQL de la livraison OpenAI native.
 *
 * Chaque geste ouvre sa transaction tenantée. Un replay exact est relu et retourné sans UPDATE ;
 * aucune capacité provider_stream n'est créée ou exposée par cet adapter V1.
 */
export class PrismaOpenAiNativeSpeechDeliveryRepository
implements OpenAiNativeSpeechDeliveryRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  async prepare(
    state: OpenAiNativeSpeechDeliveryState,
  ): Promise<OpenAiNativeSpeechDeliveryPrepareResult> {
    if (
      !validState(state)
      || state.subjectKeyVersion === null
      || state.phase !== 'prepared'
      || state.revision !== 1
    ) {
      return { status: 'unavailable' };
    }
    try {
      return await this.prisma.withIsolatedTenant(state.companyId, async (tx) => {
        const existing = await this.inspectPreparation(tx, state);
        if (existing !== null) return existing;

        const [fence] = await tx.$queryRaw<DatabaseFenceRow[]>(Prisma.sql`
          SELECT clock_timestamp() AS "databaseNow"
            FROM realtime_session_leases AS lease
           WHERE lease."companyId" = ${state.companyId}
             AND lease."subjectHash" = ${state.subjectHmac}
             AND lease."sessionId" = ${state.sessionId}::uuid
             AND lease."providerId" = ${state.provider}
             AND lease.state = 'active'
             AND lease."leaseExpiresAt" > clock_timestamp()
             AND lease."hardExpiresAt" > clock_timestamp()
             AND lease."contextRevision" = ${state.contextRevision}
             AND lease."contextDigest" = ${state.contextDigest}
             AND lease."contextAppliedRevision" = ${state.contextRevision}
             AND lease."contextAppliedDigest" = ${state.contextDigest}
             AND lease."contextAppliedOwnerEpoch" = ${state.sidebandOwnerEpoch}
             AND lease."sidebandOwnerEpoch" = ${state.sidebandOwnerEpoch}
             AND lease."sidebandOwnerTokenHash" = ${state.sidebandOwnerTokenHmac}
             AND lease."sidebandOwnerLeaseExpiresAt" > clock_timestamp()
             AND lease."sidebandProtocolVersion" = 2
           FOR SHARE OF lease
        `);
        if (!fence || !validDate(fence.databaseNow)) return { status: 'unavailable' as const };
        const databaseNowMs = fence.databaseNow.getTime();
        if (
          state.createdAtMs > databaseNowMs + PREPARATION_CLOCK_SKEW_MS
          || state.expiresAtMs <= databaseNowMs
        ) return { status: 'unavailable' as const };

        const [inserted] = await tx.$queryRaw<NativeDeliveryRow[]>(Prisma.sql`
          INSERT INTO realtime_native_speech_deliveries (
            "deliveryId", "companyId", "subjectHmac", "subjectKeyVersion", "sessionId", "turnId",
            "contextRevision", "contextDigest", "sidebandOwnerEpoch", "sidebandOwnerTokenHmac",
            "speechPolicyVersion", "speechScenarioId", "canonicalSpeechHmac", "factsHmac",
            "requestNonceHmac", "proofFormatVersion", "proofKeyVersion",
            provider, model, voice, version, revision, phase,
            "dispatchClaimId", "dispatchingAt", "requestedAt", "providerResponseIdHmac",
            "acceptedAt", "streamingAt", "responseDoneAt", "outputStoppedAt",
            "outputTranscriptHmac", "completedAt", "acknowledgementId", "deliveredAt",
            "localObservationFormatVersion", "localObservationKind",
            "sloFormatVersion", "speechStoppedEventToFirstInboundRtpMs", "bargeInStatus",
            "bargeInDurationsMs", "cancellationId", "cancellationReason", "failureId",
            "failureReason", "terminalAt", "createdAt", "expiresAt", "retentionExpiresAt"
          ) VALUES (
            ${state.deliveryId}::uuid, ${state.companyId}, ${state.subjectHmac},
            ${state.subjectKeyVersion},
            ${state.sessionId}::uuid, ${state.turnId}::uuid, ${state.contextRevision},
            ${state.contextDigest}, ${state.sidebandOwnerEpoch}, ${state.sidebandOwnerTokenHmac},
            ${state.speechPolicyVersion}, ${state.speechScenarioId},
            ${state.canonicalSpeechHmac}, ${state.factsHmac}, ${state.requestNonceHmac},
            ${state.proofFormatVersion}, ${state.proofKeyVersion}, ${state.provider},
            ${state.model}, ${state.voice}, ${state.version}, ${state.revision}, ${state.phase},
            NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
            NULL, NULL,
            NULL, NULL, NULL, ARRAY[]::integer[], NULL, NULL, NULL, NULL, NULL,
            ${new Date(state.createdAtMs)}, ${new Date(state.expiresAtMs)},
            clock_timestamp() + INTERVAL '30 days'
          )
          ON CONFLICT DO NOTHING
          RETURNING ${DELIVERY_COLUMNS}
        `);
        if (!inserted) {
          const raced = await this.inspectPreparation(tx, state);
          // Une unicité globale peut appartenir à un autre tenant et rester invisible sous RLS.
          // Ne jamais transformer cette absence visible en oracle d'existence inter-tenant.
          return raced ?? { status: 'unavailable' as const };
        }
        const persisted = mapRow(inserted);
        if (!persisted || !sameState(persisted, state)) {
          throw new Error('openai_native_delivery_projection_mismatch');
        }
        return { status: 'created' as const, state: persisted };
      }, DELIVERY_TRANSACTION_OPTIONS);
    } catch {
      return { status: 'unavailable' };
    }
  }

  async read(
    key: OpenAiNativeSpeechDeliveryKey,
  ): Promise<OpenAiNativeSpeechDeliveryReadResult> {
    if (!validKey(key)) return { status: 'unavailable' };
    try {
      return await this.prisma.withIsolatedTenant(key.companyId, async (tx) => {
        const row = await this.readExactRow(tx, key);
        if (!row) return { status: 'not_found' as const };
        const state = mapRow(row);
        return state
          ? { status: 'found' as const, state }
          : { status: 'unavailable' as const };
      }, DELIVERY_TRANSACTION_OPTIONS);
    } catch {
      return { status: 'unavailable' };
    }
  }

  async compareAndSwap(
    input: OpenAiNativeSpeechDeliveryCompareAndSwapInput,
  ): Promise<OpenAiNativeSpeechDeliveryCompareAndSwapResult> {
    if (!validCompareAndSwap(input)) return { status: 'unavailable' };
    const { key, next } = input;
    try {
      return await this.prisma.withIsolatedTenant(key.companyId, async (tx) => {
        const [updated] = await tx.$queryRaw<NativeDeliveryRow[]>(Prisma.sql`
          UPDATE realtime_native_speech_deliveries
             SET revision = ${next.revision},
                 phase = ${next.phase},
                 "dispatchClaimId" = ${next.dispatchClaimId}::uuid,
                 "dispatchingAt" = ${date(next.dispatchingAtMs)},
                 "requestedAt" = ${date(next.requestedAtMs)},
                 "providerResponseIdHmac" = ${next.providerResponseIdHmac},
                 "acceptedAt" = ${date(next.acceptedAtMs)},
                 "streamingAt" = ${date(next.streamingAtMs)},
                 "responseDoneAt" = ${date(next.responseDoneAtMs)},
                 "outputStoppedAt" = ${date(next.outputStoppedAtMs)},
                 "outputTranscriptHmac" = ${next.outputTranscriptHmac},
                 "completedAt" = ${date(next.completedAtMs)},
                 "acknowledgementId" = ${next.acknowledgementId}::uuid,
                 "deliveredAt" = ${date(next.deliveredAtMs)},
                 "localObservationFormatVersion" = ${next.localObservationFormatVersion},
                 "localObservationKind" = ${next.localObservationKind},
                 "sloFormatVersion" = ${next.sloFormatVersion},
                 "speechStoppedEventToFirstInboundRtpMs" = ${next.speechStoppedEventToFirstInboundRtpMs},
                 "bargeInStatus" = ${next.bargeInStatus},
                 "bargeInDurationsMs" = ${next.bargeInDurationsMs}::integer[],
                 "cancellationId" = ${next.cancellationId}::uuid,
                 "cancellationReason" = ${next.cancellationReason},
                 "failureId" = ${next.failureId}::uuid,
                 "failureReason" = ${next.failureReason},
                 "terminalAt" = ${date(next.terminalAtMs)}
           WHERE "companyId" = ${key.companyId}
             AND "deliveryId" = ${key.deliveryId}::uuid
             AND revision = ${input.expectedRevision}
             AND "subjectHmac" = ${next.subjectHmac}
             AND "subjectKeyVersion" IS NOT DISTINCT FROM ${next.subjectKeyVersion}
             AND "sessionId" = ${next.sessionId}::uuid
             AND "turnId" = ${next.turnId}::uuid
             AND "contextRevision" = ${next.contextRevision}
             AND "contextDigest" = ${next.contextDigest}
             AND "sidebandOwnerEpoch" = ${next.sidebandOwnerEpoch}
             AND "sidebandOwnerTokenHmac" = ${next.sidebandOwnerTokenHmac}
             AND "speechPolicyVersion" = ${next.speechPolicyVersion}
             AND "speechScenarioId" = ${next.speechScenarioId}
             AND "canonicalSpeechHmac" = ${next.canonicalSpeechHmac}
             AND "factsHmac" = ${next.factsHmac}
             AND "requestNonceHmac" = ${next.requestNonceHmac}
             AND "proofFormatVersion" = ${next.proofFormatVersion}
             AND "proofKeyVersion" = ${next.proofKeyVersion}
             AND provider = ${next.provider}
             AND model = ${next.model}
             AND voice = ${next.voice}
             AND version = ${next.version}
             AND "createdAt" = ${new Date(next.createdAtMs)}
             AND "expiresAt" = ${new Date(next.expiresAtMs)}
             AND ${new Date(latestTimelineAtMs(next))}
                   <= clock_timestamp() + INTERVAL '1 minute'
             AND (
               (${next.phase} = 'expired' AND "expiresAt" <= clock_timestamp())
               OR (${next.phase} <> 'expired' AND "expiresAt" > clock_timestamp())
             )
          RETURNING ${DELIVERY_COLUMNS}
        `);
        if (updated) {
          const persisted = mapRow(updated);
          if (!persisted || !sameState(persisted, next)) {
            throw new Error('openai_native_delivery_projection_mismatch');
          }
          return { status: 'applied' as const, state: persisted };
        }

        const currentRow = await this.readExactRow(tx, key);
        if (!currentRow) return { status: 'not_found' as const };
        const current = mapRow(currentRow);
        if (!current) return { status: 'unavailable' as const };
        return sameState(current, next)
          ? { status: 'already_applied' as const, state: current }
          : { status: 'conflict' as const };
      }, DELIVERY_TRANSACTION_OPTIONS);
    } catch {
      return { status: 'unavailable' };
    }
  }

  private async inspectPreparation(
    tx: Prisma.TransactionClient,
    state: OpenAiNativeSpeechDeliveryState,
  ): Promise<OpenAiNativeSpeechDeliveryPrepareResult | null> {
    const rows = await tx.$queryRaw<NativeDeliveryRow[]>(Prisma.sql`
      SELECT ${DELIVERY_COLUMNS}
        FROM realtime_native_speech_deliveries
       WHERE "companyId" = ${state.companyId}
         AND (
           "deliveryId" = ${state.deliveryId}::uuid
           OR "requestNonceHmac" = ${state.requestNonceHmac}
           OR ("sessionId" = ${state.sessionId}::uuid AND "turnId" = ${state.turnId}::uuid)
         )
       LIMIT 2
    `);
    if (rows.length === 0) return null;
    if (rows.length !== 1) return { status: 'conflict' };
    const persisted = mapRow(rows[0]!);
    if (!persisted) return { status: 'unavailable' };
    return sameState(persisted, state)
      ? { status: 'already_prepared', state: persisted }
      : { status: 'conflict' };
  }

  private async readExactRow(
    tx: Prisma.TransactionClient,
    key: OpenAiNativeSpeechDeliveryKey,
  ): Promise<NativeDeliveryRow | null> {
    const [row] = await tx.$queryRaw<NativeDeliveryRow[]>(Prisma.sql`
      SELECT ${DELIVERY_COLUMNS}
        FROM realtime_native_speech_deliveries
       WHERE "companyId" = ${key.companyId}
         AND "deliveryId" = ${key.deliveryId}::uuid
       LIMIT 1
    `);
    return row ?? null;
  }
}
