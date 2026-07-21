/**
 * Machine persistable d'une restitution OpenAI Realtime native.
 *
 * Ce module est volontairement pur : aucun Prisma, WebSocket, Nest, horloge globale ou SDK
 * fournisseur. Il ne porte que des identifiants opaques, des preuves HMAC et des compteurs. Le
 * texte canonique, les transcripts et l'audio ne doivent jamais franchir cette frontiere.
 */

export const OPENAI_NATIVE_SPEECH_DELIVERY_VERSION = 1 as const;
export const OPENAI_NATIVE_SPEECH_PROOF_FORMAT_VERSION = 2 as const;
export const OPENAI_NATIVE_SPEECH_POLICY_VERSION = 1 as const;
export const OPENAI_NATIVE_SPEECH_SLO_FORMAT_VERSION = 1 as const;
export const OPENAI_NATIVE_SPEECH_DELIVERY_MAX_TTL_MS = 5 * 60 * 1_000;
export const OPENAI_NATIVE_SPEECH_STOPPED_EVENT_TO_FIRST_INBOUND_RTP_MAX_MS = 60_000;
export const OPENAI_NATIVE_BARGE_IN_MAX_MS = 10_000;
export const OPENAI_NATIVE_BARGE_IN_MAX_PENDING = 16;

const POSTGRES_INT_MAX = 2_147_483_647;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HMAC_SHA256 = /^[a-f0-9]{64}$/u;
const TENANT_ID = /^[A-Za-z0-9-]{1,64}$/u;
const SAFE_PROVIDER_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u;

export type OpenAiNativeSpeechDeliveryPhase =
  | 'prepared'
  | 'dispatching'
  | 'requested'
  | 'accepted'
  | 'streaming'
  | 'draining'
  | 'completed'
  | 'delivered'
  | 'cancelled'
  | 'failed'
  | 'expired';

export type OpenAiNativeSpeechDeliveryTerminalPhase = Extract<
  OpenAiNativeSpeechDeliveryPhase,
  'delivered' | 'cancelled' | 'failed' | 'expired'
>;

export type OpenAiNativeSpeechCancellationReason =
  | 'barge_in'
  | 'user_cancel'
  | 'context_changed'
  | 'session_end'
  | 'superseded';

export type OpenAiNativeSpeechFailureReason =
  | 'provider_rejected'
  | 'provider_failed'
  | 'speech_mismatch'
  | 'protocol_violation'
  | 'owner_lost'
  | 'context_changed'
  | 'internal_error';

export type OpenAiNativePendingBargeInSlo =
  | { readonly status: 'complete'; readonly durationsMs: readonly number[] }
  | { readonly status: 'overflowed' };

/** Mesures transport uniquement : aucun texte, identifiant provider ou contenu metier. */
export interface OpenAiNativeSpeechSlo {
  /** Reception locale de `speech_stopped` jusqu'au premier paquet RTP entrant. */
  readonly speechStoppedEventToFirstInboundRtpMs?: number;
  readonly pendingBargeIn?: OpenAiNativePendingBargeInSlo;
}

export type OpenAiNativeSpeechDeliveryErrorCode =
  | 'invalid_preparation'
  | 'invalid_state'
  | 'invalid_event'
  | 'invalid_state_transition'
  | 'event_conflict'
  | 'acknowledgement_conflict'
  | 'terminal_immutable'
  | 'delivery_expired'
  | 'expiry_not_reached';

export class OpenAiNativeSpeechDeliveryError extends Error {
  constructor(readonly code: OpenAiNativeSpeechDeliveryErrorCode) {
    super(code);
    this.name = 'OpenAiNativeSpeechDeliveryError';
  }
}

export interface OpenAiNativeSpeechDeliveryPreparation {
  readonly deliveryId: string;
  readonly companyId: string;
  readonly subjectHmac: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly contextRevision: number;
  readonly contextDigest: string;
  readonly sidebandOwnerEpoch: number;
  readonly sidebandOwnerTokenHmac: string;
  readonly speechPolicyVersion: typeof OPENAI_NATIVE_SPEECH_POLICY_VERSION;
  readonly speechScenarioId: 'generic_help_v1' | 'generic_unknown_v1';
  /** Version du format de normalisation/dérivation, indépendante de la version de clé. */
  readonly proofFormatVersion: typeof OPENAI_NATIVE_SPEECH_PROOF_FORMAT_VERSION;
  /** Version de clé de preuve ; indépendante de la version de machine et du contrôle. */
  readonly proofKeyVersion: number;
  readonly canonicalSpeechHmac: string;
  readonly factsHmac: string;
  readonly requestNonceHmac: string;
  readonly provider: 'openai';
  readonly model: string;
  readonly voice: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
}

/**
 * Projection plate pour un stockage CAS. Les champs nullable sont intentionnels : ils rendent le
 * mapping SQL exact sans perdre les invariants, tous reverifies par `assert...State`.
 */
export interface OpenAiNativeSpeechDeliveryState
  extends OpenAiNativeSpeechDeliveryPreparation {
  readonly version: typeof OPENAI_NATIVE_SPEECH_DELIVERY_VERSION;
  readonly revision: number;
  readonly phase: OpenAiNativeSpeechDeliveryPhase;
  readonly dispatchClaimId: string | null;
  readonly dispatchingAtMs: number | null;
  readonly requestedAtMs: number | null;
  readonly providerResponseIdHmac: string | null;
  readonly acceptedAtMs: number | null;
  readonly streamingAtMs: number | null;
  readonly responseDoneAtMs: number | null;
  readonly outputStoppedAtMs: number | null;
  readonly outputTranscriptHmac: string | null;
  readonly completedAtMs: number | null;
  readonly acknowledgementId: string | null;
  readonly deliveredAtMs: number | null;
  /** Version nullable pour distinguer un ACK sans SLO d'un format connu. */
  readonly sloFormatVersion: typeof OPENAI_NATIVE_SPEECH_SLO_FORMAT_VERSION | null;
  readonly speechStoppedEventToFirstInboundRtpMs: number | null;
  readonly bargeInStatus: 'complete' | 'overflowed' | null;
  readonly bargeInDurationsMs: readonly number[];
  readonly cancellationId: string | null;
  readonly cancellationReason: OpenAiNativeSpeechCancellationReason | null;
  readonly failureId: string | null;
  readonly failureReason: OpenAiNativeSpeechFailureReason | null;
  readonly terminalAtMs: number | null;
}

export interface OpenAiNativeSpeechDeliveryAcknowledgementBinding {
  readonly deliveryId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly contextRevision: number;
  readonly contextDigest: string;
}

export type OpenAiNativeSpeechDeliveryEvent =
  | {
      readonly type: 'CLAIM_DISPATCH';
      readonly dispatchClaimId: string;
      readonly atMs: number;
    }
  | {
      readonly type: 'MARK_REQUESTED';
      readonly dispatchClaimId: string;
      readonly atMs: number;
    }
  | {
      readonly type: 'ACCEPT_RESPONSE';
      readonly providerResponseIdHmac: string;
      readonly atMs: number;
    }
  | {
      readonly type: 'START_STREAMING';
      readonly providerResponseIdHmac: string;
      readonly atMs: number;
    }
  | {
      readonly type: 'RESPONSE_DONE';
      readonly providerResponseIdHmac: string;
      /** HMAC du transcript normalise ; il doit correspondre au canonique, sans stocker le texte. */
      readonly outputTranscriptHmac: string;
      readonly atMs: number;
    }
  | {
      readonly type: 'OUTPUT_STOPPED';
      readonly providerResponseIdHmac: string;
      readonly atMs: number;
    }
  | ({
      readonly type: 'ACK_DELIVERY';
      readonly acknowledgementId: string;
      /** `null` signifie exactement que le corps ACK ne portait aucun lot SLO. */
      readonly slo: OpenAiNativeSpeechSlo | null;
      readonly atMs: number;
    } & OpenAiNativeSpeechDeliveryAcknowledgementBinding)
  | {
      readonly type: 'CANCEL';
      readonly cancellationId: string;
      readonly reason: OpenAiNativeSpeechCancellationReason;
      readonly atMs: number;
    }
  | {
      readonly type: 'FAIL';
      readonly failureId: string;
      readonly reason: OpenAiNativeSpeechFailureReason;
      readonly atMs: number;
    }
  | {
      readonly type: 'EXPIRE';
      readonly atMs: number;
    };

export interface OpenAiNativeSpeechDeliveryReduction {
  readonly status: 'applied' | 'idempotent';
  readonly state: OpenAiNativeSpeechDeliveryState;
}

export interface OpenAiNativeSpeechDeliveryKey {
  readonly companyId: string;
  readonly deliveryId: string;
}

export type OpenAiNativeSpeechDeliveryPrepareResult =
  | { readonly status: 'created' | 'already_prepared'; readonly state: OpenAiNativeSpeechDeliveryState }
  | { readonly status: 'conflict' | 'unavailable' };

export type OpenAiNativeSpeechDeliveryReadResult =
  | { readonly status: 'found'; readonly state: OpenAiNativeSpeechDeliveryState }
  | { readonly status: 'not_found' | 'unavailable' };

export interface OpenAiNativeSpeechDeliveryCompareAndSwapInput {
  readonly key: OpenAiNativeSpeechDeliveryKey;
  readonly expectedRevision: number;
  readonly next: OpenAiNativeSpeechDeliveryState;
}

export type OpenAiNativeSpeechDeliveryCompareAndSwapResult =
  | { readonly status: 'applied' | 'already_applied'; readonly state: OpenAiNativeSpeechDeliveryState }
  | { readonly status: 'not_found' | 'conflict' | 'unavailable' };

/** Port durable minimal ; l'adapter decide seul de sa transaction et de son verrouillage tenant. */
export interface OpenAiNativeSpeechDeliveryRepositoryPort {
  prepare(
    state: OpenAiNativeSpeechDeliveryState,
  ): Promise<OpenAiNativeSpeechDeliveryPrepareResult>;
  read(key: OpenAiNativeSpeechDeliveryKey): Promise<OpenAiNativeSpeechDeliveryReadResult>;
  compareAndSwap(
    input: OpenAiNativeSpeechDeliveryCompareAndSwapInput,
  ): Promise<OpenAiNativeSpeechDeliveryCompareAndSwapResult>;
}

/** Le local ne simule jamais une preuve de livraison ou un ACK d'action. */
export class DisabledOpenAiNativeSpeechDeliveryRepository
implements OpenAiNativeSpeechDeliveryRepositoryPort {
  async prepare(
    _state: OpenAiNativeSpeechDeliveryState,
  ): Promise<OpenAiNativeSpeechDeliveryPrepareResult> {
    return { status: 'unavailable' };
  }

  async read(
    _key: OpenAiNativeSpeechDeliveryKey,
  ): Promise<OpenAiNativeSpeechDeliveryReadResult> {
    return { status: 'unavailable' };
  }

  async compareAndSwap(
    _input: OpenAiNativeSpeechDeliveryCompareAndSwapInput,
  ): Promise<OpenAiNativeSpeechDeliveryCompareAndSwapResult> {
    return { status: 'unavailable' };
  }
}

const CANCELLATION_REASONS = new Set<OpenAiNativeSpeechCancellationReason>([
  'barge_in',
  'user_cancel',
  'context_changed',
  'session_end',
  'superseded',
]);
const FAILURE_REASONS = new Set<OpenAiNativeSpeechFailureReason>([
  'provider_rejected',
  'provider_failed',
  'speech_mismatch',
  'protocol_violation',
  'owner_lost',
  'context_changed',
  'internal_error',
]);
const TERMINAL_PHASES = new Set<OpenAiNativeSpeechDeliveryPhase>([
  'delivered',
  'cancelled',
  'failed',
  'expired',
]);

const STATE_KEYS: readonly (keyof OpenAiNativeSpeechDeliveryState)[] = [
  'version',
  'revision',
  'phase',
  'deliveryId',
  'companyId',
  'subjectHmac',
  'sessionId',
  'turnId',
  'contextRevision',
  'contextDigest',
  'sidebandOwnerEpoch',
  'sidebandOwnerTokenHmac',
  'speechPolicyVersion',
  'speechScenarioId',
  'proofFormatVersion',
  'proofKeyVersion',
  'canonicalSpeechHmac',
  'factsHmac',
  'requestNonceHmac',
  'provider',
  'model',
  'voice',
  'createdAtMs',
  'expiresAtMs',
  'dispatchClaimId',
  'dispatchingAtMs',
  'requestedAtMs',
  'providerResponseIdHmac',
  'acceptedAtMs',
  'streamingAtMs',
  'responseDoneAtMs',
  'outputStoppedAtMs',
  'outputTranscriptHmac',
  'completedAtMs',
  'acknowledgementId',
  'deliveredAtMs',
  'sloFormatVersion',
  'speechStoppedEventToFirstInboundRtpMs',
  'bargeInStatus',
  'bargeInDurationsMs',
  'cancellationId',
  'cancellationReason',
  'failureId',
  'failureReason',
  'terminalAtMs',
];

const EVENT_KEYS: Readonly<Record<OpenAiNativeSpeechDeliveryEvent['type'], readonly string[]>> = {
  CLAIM_DISPATCH: ['type', 'dispatchClaimId', 'atMs'],
  MARK_REQUESTED: ['type', 'dispatchClaimId', 'atMs'],
  ACCEPT_RESPONSE: ['type', 'providerResponseIdHmac', 'atMs'],
  START_STREAMING: ['type', 'providerResponseIdHmac', 'atMs'],
  RESPONSE_DONE: ['type', 'providerResponseIdHmac', 'outputTranscriptHmac', 'atMs'],
  OUTPUT_STOPPED: ['type', 'providerResponseIdHmac', 'atMs'],
  ACK_DELIVERY: [
    'type',
    'acknowledgementId',
    'deliveryId',
    'sessionId',
    'turnId',
    'contextRevision',
    'contextDigest',
    'slo',
    'atMs',
  ],
  CANCEL: ['type', 'cancellationId', 'reason', 'atMs'],
  FAIL: ['type', 'failureId', 'reason', 'atMs'],
  EXPIRE: ['type', 'atMs'],
};

function fail(code: OpenAiNativeSpeechDeliveryErrorCode): never {
  throw new OpenAiNativeSpeechDeliveryError(code);
}

function isSafeIntegerBetween(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function isHmac(value: unknown): value is string {
  return typeof value === 'string' && HMAC_SHA256.test(value);
}

function isTimestamp(value: unknown): value is number {
  return isSafeIntegerBetween(value, 0, Number.MAX_SAFE_INTEGER);
}

function isNullableTimestamp(value: unknown): value is number | null {
  return value === null || isTimestamp(value);
}

function isBoundedMilliseconds(value: unknown, max: number): value is number {
  return isSafeIntegerBetween(value, 0, max) && !Object.is(value, -0);
}

function isDenseBoundedDurationBatch(value: unknown): value is readonly number[] {
  if (
    !Array.isArray(value)
    || value.length < 1
    || value.length > OPENAI_NATIVE_BARGE_IN_MAX_PENDING
    || Object.keys(value).length !== value.length
  ) return false;
  for (const duration of value) {
    if (!isBoundedMilliseconds(duration, OPENAI_NATIVE_BARGE_IN_MAX_MS)) return false;
  }
  return true;
}

function assertSpeechSlo(slo: OpenAiNativeSpeechSlo): void {
  const keys = Object.keys(slo);
  if (
    keys.length < 1
    || keys.length > 2
    || keys.some((key) => key !== 'speechStoppedEventToFirstInboundRtpMs' && key !== 'pendingBargeIn')
    || (
      slo.speechStoppedEventToFirstInboundRtpMs !== undefined
      && !isBoundedMilliseconds(slo.speechStoppedEventToFirstInboundRtpMs, OPENAI_NATIVE_SPEECH_STOPPED_EVENT_TO_FIRST_INBOUND_RTP_MAX_MS)
    )
  ) fail('invalid_event');
  const pending = slo.pendingBargeIn;
  if (pending === undefined) return;
  if (pending.status === 'overflowed') {
    if (!hasExactKeys(pending, ['status'])) fail('invalid_event');
    return;
  }
  if (
    pending.status !== 'complete'
    || !hasExactKeys(pending, ['status', 'durationsMs'])
    || !isDenseBoundedDurationBatch(pending.durationsMs)
  ) fail('invalid_event');
}

function stateSloIsValid(state: OpenAiNativeSpeechDeliveryState): boolean {
  if (!Array.isArray(state.bargeInDurationsMs)) return false;
  if (state.sloFormatVersion === null) {
    return state.speechStoppedEventToFirstInboundRtpMs === null
      && state.bargeInStatus === null
      && state.bargeInDurationsMs.length === 0;
  }
  if (state.sloFormatVersion !== OPENAI_NATIVE_SPEECH_SLO_FORMAT_VERSION) return false;
  if (
    state.speechStoppedEventToFirstInboundRtpMs !== null
    && !isBoundedMilliseconds(state.speechStoppedEventToFirstInboundRtpMs, OPENAI_NATIVE_SPEECH_STOPPED_EVENT_TO_FIRST_INBOUND_RTP_MAX_MS)
  ) return false;
  if (state.bargeInStatus === 'complete') {
    if (!isDenseBoundedDurationBatch(state.bargeInDurationsMs)) return false;
  } else if (state.bargeInStatus === 'overflowed') {
    if (state.bargeInDurationsMs.length !== 0) return false;
  } else if (state.bargeInStatus === null) {
    if (state.bargeInDurationsMs.length !== 0) return false;
  } else {
    return false;
  }
  return state.speechStoppedEventToFirstInboundRtpMs !== null || state.bargeInStatus !== null;
}

function stateHasNoSlo(state: OpenAiNativeSpeechDeliveryState): boolean {
  return state.sloFormatVersion === null
    && state.speechStoppedEventToFirstInboundRtpMs === null
    && state.bargeInStatus === null
    && state.bargeInDurationsMs.length === 0;
}

function isTerminalPhase(
  phase: OpenAiNativeSpeechDeliveryPhase,
): phase is OpenAiNativeSpeechDeliveryTerminalPhase {
  return TERMINAL_PHASES.has(phase);
}

function assertPreparation(
  input: OpenAiNativeSpeechDeliveryPreparation,
): void {
  if (
    !isUuid(input.deliveryId)
    || !TENANT_ID.test(input.companyId)
    || !isHmac(input.subjectHmac)
    || !isUuid(input.sessionId)
    || !isUuid(input.turnId)
    || !isSafeIntegerBetween(input.contextRevision, 1, POSTGRES_INT_MAX)
    || !isHmac(input.contextDigest)
    || !isSafeIntegerBetween(input.sidebandOwnerEpoch, 1, POSTGRES_INT_MAX)
    || !isHmac(input.sidebandOwnerTokenHmac)
    || input.speechPolicyVersion !== OPENAI_NATIVE_SPEECH_POLICY_VERSION
    || (input.speechScenarioId !== 'generic_help_v1'
      && input.speechScenarioId !== 'generic_unknown_v1')
    || input.proofFormatVersion !== OPENAI_NATIVE_SPEECH_PROOF_FORMAT_VERSION
    || !isSafeIntegerBetween(input.proofKeyVersion, 1, POSTGRES_INT_MAX)
    || !isHmac(input.canonicalSpeechHmac)
    || !isHmac(input.factsHmac)
    || !isHmac(input.requestNonceHmac)
    || input.provider !== 'openai'
    || !SAFE_PROVIDER_VALUE.test(input.model)
    || !SAFE_PROVIDER_VALUE.test(input.voice)
    || !isTimestamp(input.createdAtMs)
    || !isTimestamp(input.expiresAtMs)
    || input.expiresAtMs <= input.createdAtMs
    || input.expiresAtMs - input.createdAtMs > OPENAI_NATIVE_SPEECH_DELIVERY_MAX_TTL_MS
  ) fail('invalid_preparation');
}

/** Construit la seule forme persistable autorisee ; aucune propriete supplementaire n'est copiee. */
export function createOpenAiNativeSpeechDelivery(
  input: OpenAiNativeSpeechDeliveryPreparation,
): OpenAiNativeSpeechDeliveryState {
  assertPreparation(input);
  return {
    version: OPENAI_NATIVE_SPEECH_DELIVERY_VERSION,
    revision: 1,
    phase: 'prepared',
    deliveryId: input.deliveryId,
    companyId: input.companyId,
    subjectHmac: input.subjectHmac,
    sessionId: input.sessionId,
    turnId: input.turnId,
    contextRevision: input.contextRevision,
    contextDigest: input.contextDigest,
    sidebandOwnerEpoch: input.sidebandOwnerEpoch,
    sidebandOwnerTokenHmac: input.sidebandOwnerTokenHmac,
    speechPolicyVersion: input.speechPolicyVersion,
    speechScenarioId: input.speechScenarioId,
    proofFormatVersion: input.proofFormatVersion,
    proofKeyVersion: input.proofKeyVersion,
    canonicalSpeechHmac: input.canonicalSpeechHmac,
    factsHmac: input.factsHmac,
    requestNonceHmac: input.requestNonceHmac,
    provider: input.provider,
    model: input.model,
    voice: input.voice,
    createdAtMs: input.createdAtMs,
    expiresAtMs: input.expiresAtMs,
    dispatchClaimId: null,
    dispatchingAtMs: null,
    requestedAtMs: null,
    providerResponseIdHmac: null,
    acceptedAtMs: null,
    streamingAtMs: null,
    responseDoneAtMs: null,
    outputStoppedAtMs: null,
    outputTranscriptHmac: null,
    completedAtMs: null,
    acknowledgementId: null,
    deliveredAtMs: null,
    sloFormatVersion: null,
    speechStoppedEventToFirstInboundRtpMs: null,
    bargeInStatus: null,
    bargeInDurationsMs: [],
    cancellationId: null,
    cancellationReason: null,
    failureId: null,
    failureReason: null,
    terminalAtMs: null,
  };
}

function hasProgressionThrough(
  state: OpenAiNativeSpeechDeliveryState,
  through: 'dispatching' | 'requested' | 'accepted' | 'streaming',
): boolean {
  if (!isUuid(state.dispatchClaimId) || state.dispatchingAtMs === null) return false;
  if (through === 'dispatching') return true;
  if (state.requestedAtMs === null) return false;
  if (through === 'requested') return true;
  if (!isHmac(state.providerResponseIdHmac) || state.acceptedAtMs === null) return false;
  if (through === 'accepted') return true;
  return state.streamingAtMs !== null;
}

function timestampsAreMonotone(state: OpenAiNativeSpeechDeliveryState): boolean {
  const ordered = [
    state.createdAtMs,
    state.dispatchingAtMs,
    state.requestedAtMs,
    state.acceptedAtMs,
    state.streamingAtMs,
  ].filter((value): value is number => value !== null);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index]! < ordered[index - 1]!) return false;
  }
  const streamingAt = state.streamingAtMs;
  if (streamingAt !== null) {
    if (state.responseDoneAtMs !== null && state.responseDoneAtMs < streamingAt) return false;
    if (state.outputStoppedAtMs !== null && state.outputStoppedAtMs < streamingAt) return false;
  }
  const lastProviderAt = Math.max(
    state.responseDoneAtMs ?? -1,
    state.outputStoppedAtMs ?? -1,
  );
  if (state.completedAtMs !== null && state.completedAtMs < lastProviderAt) return false;
  if (state.deliveredAtMs !== null && state.completedAtMs !== null
    && state.deliveredAtMs < state.completedAtMs) return false;
  const lastKnownAt = Math.max(
    state.createdAtMs,
    state.dispatchingAtMs ?? -1,
    state.requestedAtMs ?? -1,
    state.acceptedAtMs ?? -1,
    state.streamingAtMs ?? -1,
    lastProviderAt,
    state.completedAtMs ?? -1,
  );
  if (state.terminalAtMs !== null && state.terminalAtMs < lastKnownAt) return false;
  return true;
}

function terminalFieldsAreEmpty(state: OpenAiNativeSpeechDeliveryState): boolean {
  return state.acknowledgementId === null
    && state.deliveredAtMs === null
    && stateHasNoSlo(state)
    && state.cancellationId === null
    && state.cancellationReason === null
    && state.failureId === null
    && state.failureReason === null
    && state.terminalAtMs === null;
}

function progressionPrefixIsValid(state: OpenAiNativeSpeechDeliveryState): boolean {
  const noResponseLatches = state.responseDoneAtMs === null
    && state.outputStoppedAtMs === null
    && state.outputTranscriptHmac === null
    && state.completedAtMs === null;
  if (state.dispatchClaimId === null || state.dispatchingAtMs === null) {
    return state.dispatchClaimId === null
      && state.dispatchingAtMs === null
      && state.requestedAtMs === null
      && state.providerResponseIdHmac === null
      && state.acceptedAtMs === null
      && state.streamingAtMs === null
      && noResponseLatches;
  }
  if (!isUuid(state.dispatchClaimId)) return false;
  if (state.requestedAtMs === null) {
    return state.providerResponseIdHmac === null
      && state.acceptedAtMs === null
      && state.streamingAtMs === null
      && noResponseLatches;
  }
  if (state.providerResponseIdHmac === null || state.acceptedAtMs === null) {
    return state.providerResponseIdHmac === null
      && state.acceptedAtMs === null
      && state.streamingAtMs === null
      && noResponseLatches;
  }
  if (!isHmac(state.providerResponseIdHmac)) return false;
  if (state.streamingAtMs === null) return noResponseLatches;

  const hasDoneLatch = state.responseDoneAtMs !== null
    && state.outputTranscriptHmac !== null
    && state.outputTranscriptHmac === state.canonicalSpeechHmac;
  const hasStoppedLatch = state.outputStoppedAtMs !== null;
  if (!hasDoneLatch && !hasStoppedLatch) return noResponseLatches;
  if (hasDoneLatch !== hasStoppedLatch) return state.completedAtMs === null;
  return state.completedAtMs !== null;
}

function expectedTerminalRevision(state: OpenAiNativeSpeechDeliveryState): number | null {
  if (!progressionPrefixIsValid(state)) return null;
  if (state.completedAtMs !== null) return 8;
  if (state.responseDoneAtMs !== null || state.outputStoppedAtMs !== null) return 7;
  if (state.streamingAtMs !== null) return 6;
  if (state.acceptedAtMs !== null) return 5;
  if (state.requestedAtMs !== null) return 4;
  if (state.dispatchingAtMs !== null) return 3;
  return 2;
}

/**
 * Verifie une projection relue de la base avant tout calcul. Une colonne incoherente n'est jamais
 * interpretee comme un etat plus permissif.
 */
export function assertOpenAiNativeSpeechDeliveryState(
  state: OpenAiNativeSpeechDeliveryState,
): void {
  try {
    assertPreparation(state);
  } catch {
    fail('invalid_state');
  }
  if (
    !hasExactKeys(state, STATE_KEYS)
    || state.version !== OPENAI_NATIVE_SPEECH_DELIVERY_VERSION
    || !isSafeIntegerBetween(state.revision, 1, POSTGRES_INT_MAX)
    || !isNullableTimestamp(state.dispatchingAtMs)
    || !isNullableTimestamp(state.requestedAtMs)
    || !isNullableTimestamp(state.acceptedAtMs)
    || !isNullableTimestamp(state.streamingAtMs)
    || !isNullableTimestamp(state.responseDoneAtMs)
    || !isNullableTimestamp(state.outputStoppedAtMs)
    || !isNullableTimestamp(state.completedAtMs)
    || !isNullableTimestamp(state.deliveredAtMs)
    || !isNullableTimestamp(state.terminalAtMs)
    || (state.providerResponseIdHmac !== null && !isHmac(state.providerResponseIdHmac))
    || (state.outputTranscriptHmac !== null && !isHmac(state.outputTranscriptHmac))
    || (state.acknowledgementId !== null && !isUuid(state.acknowledgementId))
    || (state.cancellationId !== null && !isUuid(state.cancellationId))
    || (state.failureId !== null && !isUuid(state.failureId))
    || !stateSloIsValid(state)
    || !timestampsAreMonotone(state)
  ) fail('invalid_state');

  const providerTimestamps = [
    state.dispatchingAtMs,
    state.requestedAtMs,
    state.acceptedAtMs,
    state.streamingAtMs,
    state.responseDoneAtMs,
    state.outputStoppedAtMs,
    state.completedAtMs,
  ];
  if (providerTimestamps.some((value) => value !== null && value >= state.expiresAtMs)) {
    fail('invalid_state');
  }

  const noResponseLatches = state.responseDoneAtMs === null
    && state.outputStoppedAtMs === null
    && state.outputTranscriptHmac === null
    && state.completedAtMs === null;
  const hasDoneLatch = state.responseDoneAtMs !== null
    && state.outputTranscriptHmac !== null
    && state.outputTranscriptHmac === state.canonicalSpeechHmac;
  const hasStoppedLatch = state.outputStoppedAtMs !== null;
  const hasCompleted = hasDoneLatch && hasStoppedLatch && state.completedAtMs !== null;

  if (state.phase === 'prepared') {
    if (state.revision !== 1
      || state.dispatchClaimId !== null || state.dispatchingAtMs !== null
      || state.requestedAtMs !== null || state.providerResponseIdHmac !== null
      || state.acceptedAtMs !== null || state.streamingAtMs !== null
      || !noResponseLatches || !terminalFieldsAreEmpty(state)) fail('invalid_state');
    return;
  }

  if (state.phase === 'dispatching') {
    if (state.revision !== 2
      || !hasProgressionThrough(state, 'dispatching') || state.requestedAtMs !== null
      || state.providerResponseIdHmac !== null || state.acceptedAtMs !== null
      || state.streamingAtMs !== null || !noResponseLatches
      || !terminalFieldsAreEmpty(state)) fail('invalid_state');
    return;
  }

  if (state.phase === 'requested') {
    if (state.revision !== 3
      || !hasProgressionThrough(state, 'requested') || state.providerResponseIdHmac !== null
      || state.acceptedAtMs !== null || state.streamingAtMs !== null
      || !noResponseLatches || !terminalFieldsAreEmpty(state)) fail('invalid_state');
    return;
  }

  if (state.phase === 'accepted') {
    if (state.revision !== 4
      || !hasProgressionThrough(state, 'accepted') || state.streamingAtMs !== null
      || !noResponseLatches || !terminalFieldsAreEmpty(state)) fail('invalid_state');
    return;
  }

  if (state.phase === 'streaming') {
    if (state.revision !== 5
      || !hasProgressionThrough(state, 'streaming') || !noResponseLatches
      || !terminalFieldsAreEmpty(state)) fail('invalid_state');
    return;
  }

  if (state.phase === 'draining') {
    if (state.revision !== 6
      || !hasProgressionThrough(state, 'streaming')
      || hasDoneLatch === hasStoppedLatch
      || state.completedAtMs !== null
      || !terminalFieldsAreEmpty(state)) fail('invalid_state');
    return;
  }

  if (state.phase === 'completed') {
    if (state.revision !== 7
      || !hasProgressionThrough(state, 'streaming') || !hasCompleted
      || !terminalFieldsAreEmpty(state)) fail('invalid_state');
    return;
  }

  if (state.phase === 'delivered') {
    if (state.revision !== 8
      || !hasProgressionThrough(state, 'streaming') || !hasCompleted
      || !isUuid(state.acknowledgementId)
      || state.deliveredAtMs === null
      || state.deliveredAtMs >= state.expiresAtMs
      || state.terminalAtMs !== state.deliveredAtMs
      || state.cancellationId !== null || state.cancellationReason !== null
      || state.failureId !== null || state.failureReason !== null) fail('invalid_state');
    return;
  }

  if (state.phase === 'cancelled') {
    if (state.revision !== expectedTerminalRevision(state)
      || !progressionPrefixIsValid(state)
      || !isUuid(state.cancellationId)
      || !CANCELLATION_REASONS.has(state.cancellationReason as OpenAiNativeSpeechCancellationReason)
      || state.terminalAtMs === null
      || state.terminalAtMs >= state.expiresAtMs
      || state.acknowledgementId !== null || state.deliveredAtMs !== null
      || !stateHasNoSlo(state)
      || state.failureId !== null || state.failureReason !== null) fail('invalid_state');
    return;
  }

  if (state.phase === 'failed') {
    if (state.revision !== expectedTerminalRevision(state)
      || !progressionPrefixIsValid(state)
      || !isUuid(state.failureId)
      || !FAILURE_REASONS.has(state.failureReason as OpenAiNativeSpeechFailureReason)
      || state.terminalAtMs === null
      || state.terminalAtMs >= state.expiresAtMs
      || state.acknowledgementId !== null || state.deliveredAtMs !== null
      || !stateHasNoSlo(state)
      || state.cancellationId !== null || state.cancellationReason !== null) fail('invalid_state');
    return;
  }

  if (state.phase === 'expired') {
    if (state.revision !== expectedTerminalRevision(state)
      || !progressionPrefixIsValid(state)
      || state.terminalAtMs === null || state.terminalAtMs < state.expiresAtMs
      || state.acknowledgementId !== null || state.deliveredAtMs !== null
      || !stateHasNoSlo(state)
      || state.cancellationId !== null || state.cancellationReason !== null
      || state.failureId !== null || state.failureReason !== null) fail('invalid_state');
    return;
  }

  fail('invalid_state');
}

function assertEvent(event: OpenAiNativeSpeechDeliveryEvent): void {
  if (!event
    || typeof event !== 'object'
    || !Object.prototype.hasOwnProperty.call(EVENT_KEYS, event.type)) fail('invalid_event');
  const expectedKeys = EVENT_KEYS[event.type];
  if (!hasExactKeys(event, expectedKeys) || !isTimestamp(event.atMs)) fail('invalid_event');
  switch (event.type) {
    case 'CLAIM_DISPATCH':
    case 'MARK_REQUESTED':
      if (!isUuid(event.dispatchClaimId)) fail('invalid_event');
      break;
    case 'ACCEPT_RESPONSE':
    case 'START_STREAMING':
    case 'OUTPUT_STOPPED':
      if (!isHmac(event.providerResponseIdHmac)) fail('invalid_event');
      break;
    case 'RESPONSE_DONE':
      if (!isHmac(event.providerResponseIdHmac) || !isHmac(event.outputTranscriptHmac)) {
        fail('invalid_event');
      }
      break;
    case 'ACK_DELIVERY':
      if (!isUuid(event.acknowledgementId)
        || !isUuid(event.deliveryId)
        || !isUuid(event.sessionId)
        || !isUuid(event.turnId)
        || !isSafeIntegerBetween(event.contextRevision, 1, POSTGRES_INT_MAX)
        || !isHmac(event.contextDigest)
        || (event.slo !== null && (typeof event.slo !== 'object' || Array.isArray(event.slo)))) {
        fail('invalid_event');
      }
      if (event.slo !== null) assertSpeechSlo(event.slo);
      break;
    case 'CANCEL':
      if (!isUuid(event.cancellationId) || !CANCELLATION_REASONS.has(event.reason)) {
        fail('invalid_event');
      }
      break;
    case 'FAIL':
      if (!isUuid(event.failureId) || !FAILURE_REASONS.has(event.reason)) fail('invalid_event');
      break;
    case 'EXPIRE':
      break;
  }
}

function sameAcknowledgementBinding(
  state: OpenAiNativeSpeechDeliveryState,
  event: Extract<OpenAiNativeSpeechDeliveryEvent, { type: 'ACK_DELIVERY' }>,
): boolean {
  return state.deliveryId === event.deliveryId
    && state.sessionId === event.sessionId
    && state.turnId === event.turnId
    && state.contextRevision === event.contextRevision
    && state.contextDigest === event.contextDigest;
}

function sameSlo(
  state: OpenAiNativeSpeechDeliveryState,
  slo: OpenAiNativeSpeechSlo | null,
): boolean {
  if (slo === null) return stateHasNoSlo(state);
  const pending = slo.pendingBargeIn;
  const expectedStatus = pending?.status ?? null;
  const expectedDurations = pending?.status === 'complete' ? pending.durationsMs : [];
  return state.sloFormatVersion === OPENAI_NATIVE_SPEECH_SLO_FORMAT_VERSION
    && state.speechStoppedEventToFirstInboundRtpMs === (slo.speechStoppedEventToFirstInboundRtpMs ?? null)
    && state.bargeInStatus === expectedStatus
    && state.bargeInDurationsMs.length === expectedDurations.length
    && state.bargeInDurationsMs.every((duration, index) => duration === expectedDurations[index]);
}

function exactTerminalReplay(
  state: OpenAiNativeSpeechDeliveryState,
  event: OpenAiNativeSpeechDeliveryEvent,
): boolean {
  if (state.phase === 'delivered' && event.type === 'ACK_DELIVERY') {
    if (
      state.acknowledgementId !== event.acknowledgementId
      || !sameAcknowledgementBinding(state, event)
      || !sameSlo(state, event.slo)
    ) {
      fail('acknowledgement_conflict');
    }
    return true;
  }
  if (state.phase === 'cancelled' && event.type === 'CANCEL') {
    if (state.cancellationId !== event.cancellationId || state.cancellationReason !== event.reason) {
      fail('event_conflict');
    }
    return true;
  }
  if (state.phase === 'failed' && event.type === 'FAIL') {
    if (state.failureId !== event.failureId || state.failureReason !== event.reason) {
      fail('event_conflict');
    }
    return true;
  }
  if (state.phase === 'expired' && event.type === 'EXPIRE') return true;
  return false;
}

function assertLiveEventTime(
  state: OpenAiNativeSpeechDeliveryState,
  event: OpenAiNativeSpeechDeliveryEvent,
): void {
  if (event.atMs < state.createdAtMs) fail('invalid_event');
  if (event.type === 'EXPIRE') {
    if (event.atMs < state.expiresAtMs) fail('expiry_not_reached');
    return;
  }
  if (event.atMs >= state.expiresAtMs) fail('delivery_expired');
}

function nextRevision(state: OpenAiNativeSpeechDeliveryState): number {
  // La projection valide borne structurellement le lifecycle à 8 révisions maximum.
  return state.revision + 1;
}

function applied(
  state: OpenAiNativeSpeechDeliveryState,
  patch: Partial<OpenAiNativeSpeechDeliveryState>,
): OpenAiNativeSpeechDeliveryReduction {
  const next: OpenAiNativeSpeechDeliveryState = {
    ...state,
    ...patch,
    revision: nextRevision(state),
  };
  assertOpenAiNativeSpeechDeliveryState(next);
  return { status: 'applied', state: next };
}

function idempotent(state: OpenAiNativeSpeechDeliveryState): OpenAiNativeSpeechDeliveryReduction {
  return { status: 'idempotent', state };
}

function assertResponseBinding(
  state: OpenAiNativeSpeechDeliveryState,
  providerResponseIdHmac: string,
): void {
  if (state.providerResponseIdHmac !== providerResponseIdHmac) fail('event_conflict');
}

function reduceResponseLatch(
  state: OpenAiNativeSpeechDeliveryState,
  event: Extract<
    OpenAiNativeSpeechDeliveryEvent,
    { type: 'RESPONSE_DONE' | 'OUTPUT_STOPPED' }
  >,
): OpenAiNativeSpeechDeliveryReduction {
  assertResponseBinding(state, event.providerResponseIdHmac);
  if (state.phase !== 'streaming' && state.phase !== 'draining' && state.phase !== 'completed') {
    fail('invalid_state_transition');
  }

  if (event.type === 'RESPONSE_DONE') {
    if (event.outputTranscriptHmac !== state.canonicalSpeechHmac) fail('event_conflict');
    if (state.responseDoneAtMs !== null) {
      if (state.outputTranscriptHmac !== event.outputTranscriptHmac) fail('event_conflict');
      return idempotent(state);
    }
    const completed = state.outputStoppedAtMs !== null;
    return applied(state, {
      phase: completed ? 'completed' : 'draining',
      responseDoneAtMs: event.atMs,
      outputTranscriptHmac: event.outputTranscriptHmac,
      completedAtMs: completed ? Math.max(event.atMs, state.outputStoppedAtMs!) : null,
    });
  }

  if (state.outputStoppedAtMs !== null) return idempotent(state);
  const completed = state.responseDoneAtMs !== null;
  return applied(state, {
    phase: completed ? 'completed' : 'draining',
    outputStoppedAtMs: event.atMs,
    completedAtMs: completed ? Math.max(event.atMs, state.responseDoneAtMs!) : null,
  });
}

/**
 * Reduction pure et CAS-friendly. `status` doit etre consulte : un replay de CLAIM_DISPATCH ne
 * donne jamais l'autorisation de renvoyer `response.create`.
 */
export function transitionOpenAiNativeSpeechDelivery(
  state: OpenAiNativeSpeechDeliveryState,
  event: OpenAiNativeSpeechDeliveryEvent,
): OpenAiNativeSpeechDeliveryReduction {
  assertOpenAiNativeSpeechDeliveryState(state);
  assertEvent(event);

  if (isTerminalPhase(state.phase)) {
    if (exactTerminalReplay(state, event)) return idempotent(state);
    fail('terminal_immutable');
  }
  assertLiveEventTime(state, event);

  switch (event.type) {
    case 'CLAIM_DISPATCH':
      if (state.phase === 'dispatching') {
        if (state.dispatchClaimId !== event.dispatchClaimId) fail('event_conflict');
        return idempotent(state);
      }
      if (state.phase !== 'prepared') fail('invalid_state_transition');
      return applied(state, {
        phase: 'dispatching',
        dispatchClaimId: event.dispatchClaimId,
        dispatchingAtMs: event.atMs,
      });
    case 'MARK_REQUESTED':
      if (state.dispatchClaimId !== event.dispatchClaimId) fail('event_conflict');
      if (state.phase === 'requested') return idempotent(state);
      if (state.phase !== 'dispatching') fail('invalid_state_transition');
      return applied(state, { phase: 'requested', requestedAtMs: event.atMs });
    case 'ACCEPT_RESPONSE':
      if (state.providerResponseIdHmac !== null) {
        if (state.providerResponseIdHmac !== event.providerResponseIdHmac) fail('event_conflict');
        if (
          state.phase === 'accepted'
          || state.phase === 'streaming'
          || state.phase === 'draining'
          || state.phase === 'completed'
        ) return idempotent(state);
      }
      if (state.phase !== 'requested') fail('invalid_state_transition');
      return applied(state, {
        phase: 'accepted',
        providerResponseIdHmac: event.providerResponseIdHmac,
        acceptedAtMs: event.atMs,
      });
    case 'START_STREAMING':
      assertResponseBinding(state, event.providerResponseIdHmac);
      if (
        state.phase === 'streaming'
        || state.phase === 'draining'
        || state.phase === 'completed'
      ) return idempotent(state);
      if (state.phase !== 'accepted') fail('invalid_state_transition');
      return applied(state, { phase: 'streaming', streamingAtMs: event.atMs });
    case 'RESPONSE_DONE':
    case 'OUTPUT_STOPPED':
      return reduceResponseLatch(state, event);
    case 'ACK_DELIVERY':
      if (!sameAcknowledgementBinding(state, event)) fail('acknowledgement_conflict');
      if (state.phase !== 'completed') fail('invalid_state_transition');
      {
        const pending = event.slo?.pendingBargeIn;
        const bargeInStatus = pending?.status ?? null;
        const bargeInDurationsMs = pending?.status === 'complete'
          ? [...pending.durationsMs]
          : [];
      return applied(state, {
        phase: 'delivered',
        acknowledgementId: event.acknowledgementId,
        deliveredAtMs: event.atMs,
        sloFormatVersion: event.slo === null ? null : OPENAI_NATIVE_SPEECH_SLO_FORMAT_VERSION,
        speechStoppedEventToFirstInboundRtpMs: event.slo?.speechStoppedEventToFirstInboundRtpMs ?? null,
        bargeInStatus,
        bargeInDurationsMs,
        terminalAtMs: event.atMs,
      });
      }
    case 'CANCEL':
      // `completed` reste revocable jusqu'a l'ACK acoustique exact.
      return applied(state, {
        phase: 'cancelled',
        cancellationId: event.cancellationId,
        cancellationReason: event.reason,
        terminalAtMs: event.atMs,
      });
    case 'FAIL':
      return applied(state, {
        phase: 'failed',
        failureId: event.failureId,
        failureReason: event.reason,
        terminalAtMs: event.atMs,
      });
    case 'EXPIRE':
      return applied(state, { phase: 'expired', terminalAtMs: event.atMs });
  }
}

/** Variante reducer classique lorsque l'appelant n'a pas besoin de distinguer le replay. */
export function reduceOpenAiNativeSpeechDelivery(
  state: OpenAiNativeSpeechDeliveryState,
  event: OpenAiNativeSpeechDeliveryEvent,
): OpenAiNativeSpeechDeliveryState {
  return transitionOpenAiNativeSpeechDelivery(state, event).state;
}

export function openAiNativeSpeechDeliveryKey(
  state: Pick<OpenAiNativeSpeechDeliveryState, 'companyId' | 'deliveryId'>,
): OpenAiNativeSpeechDeliveryKey {
  return { companyId: state.companyId, deliveryId: state.deliveryId };
}
