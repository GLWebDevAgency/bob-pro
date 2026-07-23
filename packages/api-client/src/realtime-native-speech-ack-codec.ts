import type {
  RealtimeVoiceNativeSpeechDeliveryAcknowledgement,
  RealtimeVoiceNativeSpeechDeliveryInput,
  RealtimeVoiceNativeSpeechLocalObservation,
  RealtimeVoiceNativeSpeechPendingBargeInSlo,
  RealtimeVoiceNativeSpeechSlo,
} from './client';

export const REALTIME_NATIVE_SPEECH_ACK_CONTEXT_REVISION_MAX = 2_147_483_647;
export const REALTIME_NATIVE_SPEECH_ACK_FIRST_RTP_MAX_MS = 60_000;
export const REALTIME_NATIVE_SPEECH_ACK_BARGE_IN_MAX_MS = 10_000;
export const REALTIME_NATIVE_SPEECH_ACK_BARGE_IN_MAX_COUNT = 16;
export const REALTIME_NATIVE_SPEECH_LOCAL_OBSERVATION = Object.freeze({
  formatVersion: 1 as const,
  kind: 'webrtc_remote_rtp_observed_provider_drained_v1' as const,
});

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA_256_PATTERN = /^[a-f0-9]{64}$/;
const INPUT_KEYS = [
  'acknowledgementId',
  'contextRevision',
  'contextDigest',
  'slo',
  'localObservation',
] as const;
const RECEIPT_KEYS = [
  'deliveryId',
  'turnId',
  'acknowledgementId',
  'contextRevision',
  'contextDigest',
  'idempotent',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every((key) => expected.includes(key));
}

function isBoundedMilliseconds(value: unknown, max: number): value is number {
  return Number.isSafeInteger(value) && !Object.is(value, -0) && (value as number) >= 0
    && (value as number) <= max;
}

function decodePendingBargeIn(
  value: unknown,
): RealtimeVoiceNativeSpeechPendingBargeInSlo | null {
  if (!isRecord(value)) return null;
  if (value.status === 'overflowed' && hasExactKeys(value, ['status'])) {
    return Object.freeze({ status: 'overflowed' });
  }
  if (
    value.status !== 'complete'
    || !hasExactKeys(value, ['status', 'durationsMs'])
    || !Array.isArray(value.durationsMs)
    || value.durationsMs.length < 1
    || value.durationsMs.length > REALTIME_NATIVE_SPEECH_ACK_BARGE_IN_MAX_COUNT
    || Object.keys(value.durationsMs).length !== value.durationsMs.length
    || !value.durationsMs.every((duration) =>
      isBoundedMilliseconds(duration, REALTIME_NATIVE_SPEECH_ACK_BARGE_IN_MAX_MS))
  ) return null;
  return Object.freeze({ status: 'complete', durationsMs: Object.freeze([...value.durationsMs]) });
}

function decodeSlo(value: unknown): RealtimeVoiceNativeSpeechSlo | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (
    keys.length < 1
    || keys.length > 2
    || keys.some((key) =>
      key !== 'speechStoppedEventToFirstInboundRtpMs' && key !== 'pendingBargeIn')
  ) return null;

  const hasFirstRtp = Object.hasOwn(value, 'speechStoppedEventToFirstInboundRtpMs');
  const hasPending = Object.hasOwn(value, 'pendingBargeIn');
  if (
    !hasFirstRtp
    || !isBoundedMilliseconds(
      value.speechStoppedEventToFirstInboundRtpMs,
      REALTIME_NATIVE_SPEECH_ACK_FIRST_RTP_MAX_MS,
    )
  ) return null;
  let pending: RealtimeVoiceNativeSpeechPendingBargeInSlo | undefined;
  if (hasPending) {
    const decoded = decodePendingBargeIn(value.pendingBargeIn);
    if (decoded === null) return null;
    pending = decoded;
  }

  return Object.freeze({
    speechStoppedEventToFirstInboundRtpMs: value.speechStoppedEventToFirstInboundRtpMs as number,
    ...(pending === undefined ? {} : { pendingBargeIn: pending }),
  });
}

function decodeLocalObservation(value: unknown): RealtimeVoiceNativeSpeechLocalObservation | null {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ['formatVersion', 'kind'])
    || value.formatVersion !== REALTIME_NATIVE_SPEECH_LOCAL_OBSERVATION.formatVersion
    || value.kind !== REALTIME_NATIVE_SPEECH_LOCAL_OBSERVATION.kind
  ) return null;
  return REALTIME_NATIVE_SPEECH_LOCAL_OBSERVATION;
}

/**
 * Valide puis reconstruit le corps exact envoyé au serveur. Toute clé inconnue ou valeur hors
 * borne échoue fermé ; aucune metadata provider ne peut traverser ce codec.
 */
export function encodeRealtimeVoiceNativeSpeechDeliveryInput(
  value: unknown,
): RealtimeVoiceNativeSpeechDeliveryInput | null {
  try {
    if (
      !isRecord(value)
      || !hasExactKeys(value, INPUT_KEYS)
      || typeof value.acknowledgementId !== 'string'
      || !UUID_PATTERN.test(value.acknowledgementId)
      || !Number.isSafeInteger(value.contextRevision)
      || Object.is(value.contextRevision, -0)
      || (value.contextRevision as number) < 1
      || (value.contextRevision as number) > REALTIME_NATIVE_SPEECH_ACK_CONTEXT_REVISION_MAX
      || typeof value.contextDigest !== 'string'
      || !SHA_256_PATTERN.test(value.contextDigest)
    ) return null;
    const slo = decodeSlo(value.slo);
    const localObservation = decodeLocalObservation(value.localObservation);
    if (slo === null || localObservation === null) return null;
    return Object.freeze({
      acknowledgementId: value.acknowledgementId.toLowerCase(),
      contextRevision: value.contextRevision as number,
      contextDigest: value.contextDigest,
      slo,
      localObservation,
    });
  } catch {
    return null;
  }
}

export interface RealtimeVoiceNativeSpeechDeliveryReceiptBinding {
  readonly deliveryId: string;
  readonly turnId: string;
  readonly acknowledgementId: string;
  readonly contextRevision: number;
  readonly contextDigest: string;
}

/** Décode un reçu 200 exact et le lie à la requête, jamais seulement à sa forme. */
export function decodeRealtimeVoiceNativeSpeechDeliveryAcknowledgement(
  status: number,
  value: unknown,
  expected: RealtimeVoiceNativeSpeechDeliveryReceiptBinding,
): RealtimeVoiceNativeSpeechDeliveryAcknowledgement | null {
  try {
    if (
      !UUID_PATTERN.test(expected.deliveryId)
      || !UUID_PATTERN.test(expected.turnId)
      || !UUID_PATTERN.test(expected.acknowledgementId)
      || !Number.isSafeInteger(expected.contextRevision)
      || Object.is(expected.contextRevision, -0)
      || expected.contextRevision < 1
      || expected.contextRevision > REALTIME_NATIVE_SPEECH_ACK_CONTEXT_REVISION_MAX
      || !SHA_256_PATTERN.test(expected.contextDigest)
      || status !== 200
      || !isRecord(value)
      || !hasExactKeys(value, RECEIPT_KEYS)
      || typeof value.deliveryId !== 'string'
      || !UUID_PATTERN.test(value.deliveryId)
      || value.deliveryId.toLowerCase() !== expected.deliveryId.toLowerCase()
      || typeof value.turnId !== 'string'
      || !UUID_PATTERN.test(value.turnId)
      || value.turnId.toLowerCase() !== expected.turnId.toLowerCase()
      || typeof value.acknowledgementId !== 'string'
      || !UUID_PATTERN.test(value.acknowledgementId)
      || value.acknowledgementId.toLowerCase() !== expected.acknowledgementId.toLowerCase()
      || !Number.isSafeInteger(value.contextRevision)
      || Object.is(value.contextRevision, -0)
      || (value.contextRevision as number) < 1
      || (value.contextRevision as number) > REALTIME_NATIVE_SPEECH_ACK_CONTEXT_REVISION_MAX
      || value.contextRevision !== expected.contextRevision
      || typeof value.contextDigest !== 'string'
      || !SHA_256_PATTERN.test(value.contextDigest)
      || value.contextDigest !== expected.contextDigest
      || typeof value.idempotent !== 'boolean'
    ) return null;
    return Object.freeze({
      deliveryId: value.deliveryId.toLowerCase(),
      turnId: value.turnId.toLowerCase(),
      acknowledgementId: value.acknowledgementId.toLowerCase(),
      contextRevision: value.contextRevision as number,
      contextDigest: value.contextDigest,
      idempotent: value.idempotent,
    });
  } catch {
    return null;
  }
}
