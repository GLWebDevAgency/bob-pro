import { randomUUID } from 'node:crypto';
import {
  assertOpenAiNativeSpeechDeliveryState,
  type OpenAiNativeSpeechCancellationReason,
  type OpenAiNativeSpeechDeliveryState,
  type OpenAiNativeSpeechFailureReason,
} from './openai-native-speech-delivery';
import type {
  OpenAiNativeSpeechAuthority,
  OpenAiNativeSpeechAuthorityBinding,
  OpenAiNativeSpeechTransitionOutcome,
  OpenAiNativeSpeechTurnPreparationOutcome,
} from './openai-native-speech-authority';
import {
  OPENAI_NATIVE_RESPONSE_LIMITS,
  areOpenAiNativeSpeechTranscriptsConcordant,
  buildOpenAiNativeResponseCreate,
  createOpenAiNativeResponseState,
  decodeOpenAiNativeResponseEvent,
  reduceOpenAiNativeResponseState,
  type OpenAiNativeResponseEvent,
  type OpenAiNativeResponseMetadata,
  type OpenAiNativeResponseRequest,
  type OpenAiNativeResponseState,
  type OpenAiNativeResponseUsage,
  type OpenAiNativeResponseUsageCounters,
} from './openai-native-response-protocol';

/**
 * The provider can answer synchronously from `send()`. Keep this queue deliberately much smaller
 * than the protocol-wide event budget: it is only a bridge until MARK_REQUESTED is durable.
 */
export const OPENAI_NATIVE_MAX_PRE_REQUEST_EVENTS = 256;
export const OPENAI_NATIVE_MAX_PENDING_EVENTS = 256;
export const OPENAI_NATIVE_RESPONSE_SEND_TIMEOUT_MS = 5_000;
export const OPENAI_NATIVE_SERVER_INTERRUPT_TIMEOUT_MS = 5_000;
export const OPENAI_NATIVE_DURABLE_OPERATION_TIMEOUT_MS = 5_000;
const OPENAI_NATIVE_FATAL_PERSIST_MAX_ATTEMPTS = 3;
const OPENAI_NATIVE_USAGE_RECONCILE_MAX_ATTEMPTS = 3;

export type OpenAiNativePreparedResponseTurn = Extract<
OpenAiNativeSpeechTurnPreparationOutcome,
{ readonly status: 'prepared' }
>;

type PreparedTurn = OpenAiNativePreparedResponseTurn;

type AuthorityPort = Pick<
OpenAiNativeSpeechAuthority,
| 'claimDispatch'
| 'markRequested'
| 'acceptProviderResponse'
| 'startStreaming'
| 'responseDone'
| 'outputStopped'
| 'cancel'
| 'fail'
>;

export interface OpenAiNativeResponseSocket {
  readonly readyState: number;
  /** A callback error is an ambiguous network outcome and MUST NOT be retried. */
  send(data: string, callback: (error?: Error) => void): void;
}

export type OpenAiNativeResponseSessionFenceResult =
  | { readonly status: 'applied' | 'already_closed' }
  | { readonly status: 'failed' };

/**
 * Synchronous hard fence owned by the sideband runtime. `applied` means provider transport and
 * local event ingress are already closed before this method returns.
 */
export interface OpenAiNativeResponseSessionFencePort {
  fenceAndClose(input: {
    readonly reason: Exclude<OpenAiNativeResponseFatalReason, 'session_fence_failed'>;
  }): OpenAiNativeResponseSessionFenceResult;
  /** Independent last resort: revoke owner/lease and terminate the provider transport. */
  emergencyRevokeAndTerminate(input: {
    readonly reason: Exclude<OpenAiNativeResponseFatalReason, 'session_fence_failed'>;
  }): OpenAiNativeResponseSessionFenceResult;
}

export interface OpenAiNativeResponseUsageInput {
  readonly provider: 'openai';
  readonly companyId: string;
  readonly deliveryId: string;
  readonly sessionId: string;
  readonly turnId: string;
  /** Sanitised counters from the strict decoder; never the provider payload or transcript. */
  readonly usage: OpenAiNativeResponseUsageCounters;
}

export type OpenAiNativeResponseUsageResult =
  | { readonly status: 'recorded' | 'duplicate' }
  | { readonly status: 'rejected' | 'conflict' | 'unavailable' };

/** Runtime adapter responsible for cost/accounting-grade, idempotent usage persistence. */
export interface OpenAiNativeResponseUsagePort {
  record(input: OpenAiNativeResponseUsageInput): Promise<OpenAiNativeResponseUsageResult>;
}

export interface OpenAiNativeResponseDispatcherEntropy {
  cancellationId(): string;
  failureId(): string;
}

export interface OpenAiNativeResponseDispatcherTiming {
  readonly responseSendTimeoutMs?: number;
  readonly serverInterruptTimeoutMs?: number;
  readonly durableOperationTimeoutMs?: number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type OpenAiNativeMobileInterruptionSource = 'user_speech' | 'tap' | 'navigation';
export type OpenAiNativeServerInterruptionReason = Extract<
OpenAiNativeSpeechCancellationReason,
'context_changed' | 'superseded' | 'session_end'
>;

export interface OpenAiNativeServerCancelAndClearCommand {
  readonly responseId: string | null;
  readonly events: readonly (
    | { readonly type: 'response.cancel'; readonly response_id: string }
    | { readonly type: 'output_audio_buffer.clear' }
  )[];
  /** The sideband owner must close the provider session when the send outcome is ambiguous. */
  readonly closeIfAmbiguous: true;
}

export type OpenAiNativeServerCancelAndClearResult =
  | { readonly status: 'sent' }
  | { readonly status: 'ambiguous' };

export type OpenAiNativeResponseFatalReason =
  | 'socket_not_open'
  | 'socket_send_ambiguous'
  | 'request_commit_failed'
  | 'event_queue_overflow'
  | 'protocol_violation'
  | 'provider_failed'
  | 'usage_unavailable'
  | 'speech_mismatch'
  | 'durable_transition_failed'
  | 'cancellation_failed'
  | 'server_interrupt_ambiguous'
  | 'session_fence_failed'
  | 'internal_error';

export type OpenAiNativeResponseFatalOutcome =
  | {
      readonly status: 'fatal';
      readonly reason: Exclude<OpenAiNativeResponseFatalReason, 'session_fence_failed'>;
      readonly closeRequired: true;
    }
  | {
      readonly status: 'fatal';
      readonly reason: 'session_fence_failed';
      readonly cause: Exclude<OpenAiNativeResponseFatalReason, 'session_fence_failed'>;
      readonly closeRequired: true;
    };

type OpenAiNativeResponseFatalTrigger = Exclude<
OpenAiNativeResponseFatalReason,
'session_fence_failed'
>;

export type OpenAiNativeResponseStartOutcome =
  | { readonly status: 'started'; readonly deliveryId: string }
  | {
      readonly status: 'not_started';
      readonly reason:
        | 'already_started'
        | 'invalid_prepared_request'
        | 'dispatch_not_authorized'
        | 'interrupted_before_send';
      readonly closeRequired: false;
    }
  | OpenAiNativeResponseFatalOutcome;

export type OpenAiNativeResponseWireOutcome =
  | { readonly status: 'handled' | 'queued' | 'ignored' }
  | OpenAiNativeResponseFatalOutcome;

export type OpenAiNativeResponseInterruptionOutcome =
  | {
      readonly status: 'cancelled';
      readonly source:
        | OpenAiNativeMobileInterruptionSource
        | OpenAiNativeServerInterruptionReason;
    }
  | { readonly status: 'not_active' }
  | OpenAiNativeResponseFatalOutcome;

export type OpenAiNativeResponseSettledOutcome =
  | { readonly status: 'idle' | 'active' | 'completed' | 'cancelled' }
  | OpenAiNativeResponseFatalOutcome;

export interface OpenAiNativeResponseDispatcherCallbacks {
  readonly onStreaming?: (input: { readonly deliveryId: string; readonly responseId: string }) => void;
  readonly onCompleted?: (input: {
    readonly deliveryId: string;
    readonly responseId: string;
    readonly state: OpenAiNativeResponseState;
  }) => void;
  readonly onCancelled?: (input: {
    readonly deliveryId: string;
    readonly source: OpenAiNativeMobileInterruptionSource | OpenAiNativeServerInterruptionReason;
  }) => void;
  /** Must synchronously fence/close the owning provider connection. */
  readonly onFatal: (outcome: OpenAiNativeResponseFatalOutcome) => void;
}

const secureEntropy: OpenAiNativeResponseDispatcherEntropy = Object.freeze({
  cancellationId: randomUUID,
  failureId: randomUUID,
});

const runtimeTiming: OpenAiNativeResponseDispatcherTiming = Object.freeze({
  setTimeout: (callback: () => void, delayMs: number) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle: unknown) => globalThis.clearTimeout(
    handle as ReturnType<typeof globalThis.setTimeout>,
  ),
});

function durableApplied(outcome: OpenAiNativeSpeechTransitionOutcome): boolean {
  return outcome.status === 'applied' || outcome.status === 'idempotent';
}

function metadataMatchesRequest(
  metadata: OpenAiNativeResponseMetadata,
  request: OpenAiNativeResponseRequest,
): boolean {
  return metadata.bob_delivery_id === request.deliveryId
    && metadata.bob_turn_id === request.turnId
    && metadata.bob_context_revision === String(request.contextRevision)
    && metadata.bob_context_digest === request.contextDigest
    && metadata.bob_request_nonce === request.requestNonce;
}

function sameResponseDoneEvidence(
  left: Extract<OpenAiNativeResponseEvent, { readonly type: 'response_done' }>,
  right: Extract<OpenAiNativeResponseEvent, { readonly type: 'response_done' }>,
): boolean {
  return left.responseId === right.responseId
    && left.status === right.status
    && left.transcript === right.transcript
    && left.metadata.bob_protocol === right.metadata.bob_protocol
    && left.metadata.bob_delivery_id === right.metadata.bob_delivery_id
    && left.metadata.bob_turn_id === right.metadata.bob_turn_id
    && left.metadata.bob_context_revision === right.metadata.bob_context_revision
    && left.metadata.bob_context_digest === right.metadata.bob_context_digest
    && left.metadata.bob_request_nonce === right.metadata.bob_request_nonce
    && JSON.stringify(left.usage) === JSON.stringify(right.usage);
}

function snapshotUsage(
  usage: OpenAiNativeResponseUsage,
): Readonly<OpenAiNativeResponseUsage> {
  if (usage.status === 'unavailable') return Object.freeze({ status: 'unavailable' as const });
  return Object.freeze({
    status: 'available' as const,
    totalTokens: usage.totalTokens,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    inputTokenDetails: usage.inputTokenDetails === null
      ? null
      : Object.freeze({ ...usage.inputTokenDetails }),
    outputTokenDetails: usage.outputTokenDetails === null
      ? null
      : Object.freeze({ ...usage.outputTokenDetails }),
  });
}

function snapshotResponseDoneEvidence(
  event: Extract<OpenAiNativeResponseEvent, { readonly type: 'response_done' }>,
): Extract<OpenAiNativeResponseEvent, { readonly type: 'response_done' }> {
  return Object.freeze({
    type: 'response_done' as const,
    responseId: event.responseId,
    status: event.status,
    metadata: Object.freeze({ ...event.metadata }),
    transcript: event.transcript,
    usage: snapshotUsage(event.usage),
  });
}

function snapshotResponseState(state: OpenAiNativeResponseState): OpenAiNativeResponseState {
  return Object.freeze({
    ...state,
    expected: Object.freeze({ ...state.expected }),
    usage: snapshotUsage(state.usage),
  });
}

function stateMatchesBinding(
  state: OpenAiNativeSpeechDeliveryState,
  binding: OpenAiNativeSpeechAuthorityBinding,
): boolean {
  return state.companyId === binding.companyId
    && state.subjectHmac === binding.subjectHmac
    && state.deliveryId === binding.deliveryId
    && state.sessionId === binding.sessionId
    && state.turnId === binding.turnId
    && state.contextRevision === binding.contextRevision
    && state.contextDigest === binding.contextDigest
    && state.sidebandOwnerEpoch === binding.sidebandOwnerEpoch
    && state.sidebandOwnerTokenHmac === binding.sidebandOwnerTokenHmac;
}

function exactResponseRequest(
  left: Readonly<OpenAiNativeResponseRequest>,
  right: Readonly<OpenAiNativeResponseRequest>,
): boolean {
  const expectedKeys: readonly (keyof OpenAiNativeResponseRequest)[] = [
    'deliveryId',
    'turnId',
    'contextRevision',
    'contextDigest',
    'requestNonce',
    'canonicalSpeech',
  ];
  return Object.isFrozen(left)
    && Object.keys(left).length === expectedKeys.length
    && expectedKeys.every((key) => Object.is(left[key], right[key]));
}

function claimMatchesPrepared(
  claim: Extract<Awaited<ReturnType<AuthorityPort['claimDispatch']>>, { readonly status: 'authorized' }>,
  prepared: OpenAiNativeSpeechDeliveryState,
  preparedRequest: Readonly<OpenAiNativeResponseRequest>,
): boolean {
  const immutableKeys: readonly (keyof OpenAiNativeSpeechDeliveryState)[] = [
    'version',
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
  ];
  return claim.state.phase === 'dispatching'
    && claim.state.dispatchClaimId === claim.dispatchClaimId
    && claim.state.revision === prepared.revision + 1
    && immutableKeys.every((key) => Object.is(claim.state[key], prepared[key]))
    && exactResponseRequest(claim.request, preparedRequest);
}

function preparedInputIsValid(
  prepared: PreparedTurn,
  binding: OpenAiNativeSpeechAuthorityBinding,
): boolean {
  try {
    assertOpenAiNativeSpeechDeliveryState(prepared.state);
    createOpenAiNativeResponseState(prepared.request);
    buildOpenAiNativeResponseCreate(prepared.request);
  } catch {
    return false;
  }
  return prepared.state.phase === 'prepared'
    && prepared.state.revision === 1
    && stateMatchesBinding(prepared.state, binding)
    && prepared.request.deliveryId === binding.deliveryId
    && prepared.request.turnId === binding.turnId
    && prepared.request.contextRevision === binding.contextRevision
    && prepared.request.contextDigest === binding.contextDigest;
}

function snapshotPreparedInput(
  prepared: PreparedTurn,
  binding: OpenAiNativeSpeechAuthorityBinding,
): { readonly prepared: PreparedTurn; readonly binding: OpenAiNativeSpeechAuthorityBinding } | null {
  try {
    const request = Object.freeze({
      deliveryId: prepared.request.deliveryId,
      turnId: prepared.request.turnId,
      contextRevision: prepared.request.contextRevision,
      contextDigest: prepared.request.contextDigest,
      requestNonce: prepared.request.requestNonce,
      canonicalSpeech: prepared.request.canonicalSpeech,
    });
    const state = Object.freeze({
      ...prepared.state,
      bargeInDurationsMs: Object.freeze([...prepared.state.bargeInDurationsMs]),
    });
    return Object.freeze({
      prepared: Object.freeze({ ...prepared, state, request }),
      binding: Object.freeze({
        companyId: binding.companyId,
        subjectHmac: binding.subjectHmac,
        deliveryId: binding.deliveryId,
        sessionId: binding.sessionId,
        turnId: binding.turnId,
        contextRevision: binding.contextRevision,
        contextDigest: binding.contextDigest,
        sidebandOwnerEpoch: binding.sidebandOwnerEpoch,
        sidebandOwnerTokenHmac: binding.sidebandOwnerTokenHmac,
      }),
    });
  } catch {
    return null;
  }
}

function durableFailureReason(
  reason: OpenAiNativeResponseFatalReason,
): OpenAiNativeSpeechFailureReason {
  if (reason === 'provider_failed') return 'provider_failed';
  if (reason === 'speech_mismatch') return 'speech_mismatch';
  if (reason === 'protocol_violation' || reason === 'event_queue_overflow') {
    return 'protocol_violation';
  }
  return 'internal_error';
}

function failureForState(state: OpenAiNativeResponseState): OpenAiNativeResponseFatalTrigger {
  if (state.failureCode === 'transcript_mismatch' || state.failureCode === 'transcript_conflict') {
    return 'speech_mismatch';
  }
  if (state.failureCode === 'provider_error' || state.failureCode === 'provider_response_not_completed') {
    return 'provider_failed';
  }
  return 'protocol_violation';
}

function interruptionReasonForMobile(
  source: OpenAiNativeMobileInterruptionSource,
): OpenAiNativeSpeechCancellationReason {
  return source === 'user_speech' ? 'barge_in' : 'user_cancel';
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * One instance owns exactly one prepared Bob utterance. The dispatcher never generates content,
 * never invokes tools and never sends cancel/clear for a mobile interruption. It only translates
 * strict provider evidence into durable, fenced authority transitions.
 */
export class OpenAiNativeResponseDispatcher {
  private startAttempted = false;
  private startPromise: Promise<OpenAiNativeResponseStartOutcome> | null = null;
  private requestState: OpenAiNativeResponseState | null = null;
  private binding: OpenAiNativeSpeechAuthorityBinding | null = null;
  private dispatchOwned = false;
  private requestCommitted = false;
  private observedResponseId: string | null = null;
  private responseDoneEvidence: Extract<
  OpenAiNativeResponseEvent,
  { readonly type: 'response_done' }
  > | null = null;
  private pendingEvents: OpenAiNativeResponseEvent[] = [];
  private pendingProcessingCount = 0;
  private processing: Promise<void> = Promise.resolve();
  private fatalOutcome: OpenAiNativeResponseFatalOutcome | null = null;
  private fatalTrigger: OpenAiNativeResponseFatalTrigger | null = null;
  private fatalPersisted = false;
  private fatalPersistenceInFlight: Promise<void> | null = null;
  private failureId: string | null = null;
  private retired = false;
  private cancellationPersisted = false;
  private completed = false;
  private streamingNotified = false;
  private completionNotified = false;
  private usageRecorded = false;
  private usageInitialAttempted = false;
  private usageReconcileAttempts = 0;
  private usagePersistenceInFlight: Promise<boolean> | null = null;
  private cancellationPromise: Promise<OpenAiNativeResponseInterruptionOutcome> | null = null;
  private cancellationId: string | null = null;
  private quarantineTranscript = '';
  private quarantineFinalTranscript: string | null = null;
  private ingressEventCount = 0;
  private quarantineOutputItemId: string | null = null;
  private readonly responseSendTimeoutMs: number;
  private readonly serverInterruptTimeoutMs: number;
  private readonly durableOperationTimeoutMs: number;

  constructor(
    private readonly authority: AuthorityPort,
    private readonly socket: OpenAiNativeResponseSocket,
    private readonly openSocketState: number,
    private readonly usage: OpenAiNativeResponseUsagePort,
    private readonly sessionFence: OpenAiNativeResponseSessionFencePort,
    private readonly callbacks: OpenAiNativeResponseDispatcherCallbacks,
    private readonly entropy: OpenAiNativeResponseDispatcherEntropy = secureEntropy,
    private readonly timing: OpenAiNativeResponseDispatcherTiming = runtimeTiming,
  ) {
    const responseSendTimeoutMs = timing.responseSendTimeoutMs
      ?? OPENAI_NATIVE_RESPONSE_SEND_TIMEOUT_MS;
    const serverInterruptTimeoutMs = timing.serverInterruptTimeoutMs
      ?? OPENAI_NATIVE_SERVER_INTERRUPT_TIMEOUT_MS;
    const durableOperationTimeoutMs = timing.durableOperationTimeoutMs
      ?? OPENAI_NATIVE_DURABLE_OPERATION_TIMEOUT_MS;
    if (
      !usage
      || typeof usage.record !== 'function'
      || !sessionFence
      || typeof sessionFence.fenceAndClose !== 'function'
      || typeof sessionFence.emergencyRevokeAndTerminate !== 'function'
      || typeof callbacks.onFatal !== 'function'
      || typeof timing.setTimeout !== 'function'
      || typeof timing.clearTimeout !== 'function'
      || !Number.isSafeInteger(responseSendTimeoutMs)
      || responseSendTimeoutMs < 1
      || responseSendTimeoutMs > 60_000
      || !Number.isSafeInteger(serverInterruptTimeoutMs)
      || serverInterruptTimeoutMs < 1
      || serverInterruptTimeoutMs > 60_000
      || !Number.isSafeInteger(durableOperationTimeoutMs)
      || durableOperationTimeoutMs < 1
      || durableOperationTimeoutMs > 60_000
    ) {
      throw new Error('OpenAI native dispatcher dependencies are required.');
    }
    this.responseSendTimeoutMs = responseSendTimeoutMs;
    this.serverInterruptTimeoutMs = serverInterruptTimeoutMs;
    this.durableOperationTimeoutMs = durableOperationTimeoutMs;
  }

  start(input: {
    readonly prepared: PreparedTurn;
    readonly binding: OpenAiNativeSpeechAuthorityBinding;
  }): Promise<OpenAiNativeResponseStartOutcome> {
    if (this.startAttempted) {
      return Promise.resolve({
        status: 'not_started',
        reason: 'already_started',
        closeRequired: false,
      });
    }
    this.startAttempted = true;
    this.startPromise = this.startInternal(input.prepared, input.binding);
    return this.startPromise;
  }

  handleWireEvent(raw: unknown): OpenAiNativeResponseWireOutcome {
    if (this.fatalOutcome !== null) return this.fatalOutcome;
    if (this.requestState === null || !this.dispatchOwned) return { status: 'ignored' };
    if (this.retired) return this.handleRetiredWireEvent(raw);

    let event: OpenAiNativeResponseEvent;
    try {
      event = decodeOpenAiNativeResponseEvent(raw);
    } catch {
      return this.scheduleFatal('protocol_violation');
    }
    if (event.type === 'ignored') return { status: 'ignored' };
    this.ingressEventCount += 1;
    if (this.ingressEventCount > OPENAI_NATIVE_RESPONSE_LIMITS.maxEventsPerResponse) {
      return this.scheduleFatal('protocol_violation');
    }
    const correlationFailure = this.observeCorrelation(event);
    if (correlationFailure !== null) return correlationFailure;

    if (!this.requestCommitted) {
      if (this.pendingEvents.length >= OPENAI_NATIVE_MAX_PRE_REQUEST_EVENTS) {
        return this.scheduleFatal('event_queue_overflow');
      }
      this.pendingEvents.push(event);
      return { status: 'queued' };
    }
    if (!this.enqueue(event)) return this.scheduleFatal('event_queue_overflow');
    return { status: 'handled' };
  }

  /**
   * Mobile already muted locally and is the sole sender of response.cancel + buffer.clear.
   * This method only fences the durable delivery and is idempotent across repeated UI/VAD events.
   */
  markMobileInterruption(
    source: OpenAiNativeMobileInterruptionSource,
  ): Promise<OpenAiNativeResponseInterruptionOutcome> {
    return this.beginCancellation(source, interruptionReasonForMobile(source));
  }

  /**
   * Server-originated invalidation has a deliberately separate transport contract. The caller,
   * not this dispatcher, sends cancel+clear and MUST close the provider session on ambiguity.
   */
  interruptForServerOrigin(
    reason: OpenAiNativeServerInterruptionReason,
    sendCancelAndClear: (
      command: OpenAiNativeServerCancelAndClearCommand,
    ) => Promise<OpenAiNativeServerCancelAndClearResult>,
  ): Promise<OpenAiNativeResponseInterruptionOutcome> {
    if (this.cancellationPromise !== null) return this.cancellationPromise;
    if (this.fatalOutcome !== null) return Promise.resolve(this.fatalOutcome);
    // Durable `completed` remains revocable until the separate acoustic ACK reaches `delivered`.
    if (this.binding === null || this.requestState === null) {
      return Promise.resolve({ status: 'not_active' });
    }
    if (!this.retire()) return Promise.resolve(this.fatalOutcome!);
    this.cancellationPromise = this.finishServerCancellation(reason, sendCancelAndClear);
    return this.cancellationPromise;
  }

  async settled(): Promise<OpenAiNativeResponseSettledOutcome> {
    await this.drainUntilStable();
    // A fatal closes the transport synchronously. Its durable proof is retried in bounded batches
    // with the same failureId whenever the owner explicitly reconciles through `settled()`.
    if (
      this.fatalOutcome !== null
      && this.binding !== null
      && !this.usageRecorded
      && this.responseDoneEvidence !== null
    ) {
      await this.attemptUsagePersistence(this.responseDoneEvidence, 'reconcile');
    }
    if (this.fatalOutcome !== null && this.binding !== null && !this.fatalPersisted) {
      await this.persistFatal(this.fatalTrigger ?? 'internal_error', true);
      await this.drainUntilStable();
    }
    if (this.fatalOutcome !== null) return this.fatalOutcome;
    if (this.cancellationPersisted) return { status: 'cancelled' };
    if (this.completed) return { status: 'completed' };
    if (this.requestCommitted) return { status: 'active' };
    return { status: 'idle' };
  }

  private async drainUntilStable(): Promise<void> {
    for (;;) {
      const start = this.startPromise;
      if (start !== null) await start;
      const processing = this.processing;
      await processing;
      const cancellation = this.cancellationPromise;
      if (cancellation !== null) await cancellation;
      if (
        start === this.startPromise
        && processing === this.processing
        && cancellation === this.cancellationPromise
      ) return;
    }
  }

  private async startInternal(
    prepared: PreparedTurn,
    binding: OpenAiNativeSpeechAuthorityBinding,
  ): Promise<OpenAiNativeResponseStartOutcome> {
    const snapshot = snapshotPreparedInput(prepared, binding);
    if (snapshot === null || !preparedInputIsValid(snapshot.prepared, snapshot.binding)) {
      return {
        status: 'not_started',
        reason: 'invalid_prepared_request',
        closeRequired: false,
      };
    }
    const preparedSnapshot = snapshot.prepared;
    this.binding = snapshot.binding;
    this.requestState = snapshotResponseState(
      createOpenAiNativeResponseState(preparedSnapshot.request),
    );

    const claimed = await this.runWithDeadline(
      () => this.authority.claimDispatch({
        ...this.binding!,
        request: preparedSnapshot.request,
      }),
      this.durableOperationTimeoutMs,
      { status: 'unavailable' as const },
    );
    if (this.fatalOutcome !== null) return this.fatalOutcome;
    if (claimed.status === 'unavailable') {
      // The claim CAS may have committed before its acknowledgement was lost. No byte is sent,
      // but the provider session is fenced and the durable delivery is terminalised as failed.
      return this.fatal('durable_transition_failed');
    }
    if (claimed.status !== 'authorized') {
      this.disarmLostClaim();
      return {
        status: 'not_started',
        reason: 'dispatch_not_authorized',
        closeRequired: false,
      };
    }
    try {
      assertOpenAiNativeSpeechDeliveryState(claimed.state);
    } catch {
      return this.fatal('durable_transition_failed');
    }
    if (!claimMatchesPrepared(
      claimed,
      preparedSnapshot.state,
      preparedSnapshot.request,
    )) {
      return this.fatal('durable_transition_failed');
    }
    this.dispatchOwned = true;
    if (this.fatalOutcome !== null) return this.fatalOutcome;
    if (this.retired) {
      return {
        status: 'not_started',
        reason: 'interrupted_before_send',
        closeRequired: false,
      };
    }
    if (this.socket.readyState !== this.openSocketState) return this.fatal('socket_not_open');

    let createWire: string;
    try {
      // Build only from the self-contained capability returned by the proof-bound authority CAS.
      createWire = JSON.stringify(buildOpenAiNativeResponseCreate(claimed.request));
    } catch {
      return this.fatal('protocol_violation');
    }

    const sent = await this.sendResponseCreate(createWire);
    if (!sent) return this.fatal('socket_send_ambiguous');

    const requested = await this.safeTransition(() => this.authority.markRequested({
      ...this.binding!,
      dispatchClaimId: claimed.dispatchClaimId,
    }));
    if (!durableApplied(requested)) return this.fatal('request_commit_failed');
    this.requestCommitted = true;
    if (this.fatalOutcome !== null) return this.fatalOutcome;

    const pending = this.pendingEvents;
    this.pendingEvents = [];
    for (const event of pending) {
      if (!this.enqueue(event)) return this.fatal('event_queue_overflow');
    }
    return { status: 'started', deliveryId: preparedSnapshot.state.deliveryId };
  }

  private disarmLostClaim(): void {
    this.dispatchOwned = false;
    this.binding = null;
    this.requestState = null;
    this.pendingEvents = [];
    this.pendingProcessingCount = 0;
    this.observedResponseId = null;
    this.responseDoneEvidence = null;
  }

  private observeCorrelation(
    event: OpenAiNativeResponseEvent,
  ): OpenAiNativeResponseFatalOutcome | null {
    const request = this.requestState?.expected;
    if (request === undefined) return this.scheduleFatal('internal_error');
    if (event.type === 'response_created') {
      if (!metadataMatchesRequest(event.metadata, request)) {
        return this.scheduleFatal('protocol_violation');
      }
      if (this.observedResponseId !== null && this.observedResponseId !== event.responseId) {
        return this.scheduleFatal('protocol_violation');
      }
      this.observedResponseId = event.responseId;
      return null;
    }
    if (event.type === 'response_done') {
      if (!metadataMatchesRequest(event.metadata, request)) {
        return this.scheduleFatal('protocol_violation');
      }
      if (this.observedResponseId === null || this.observedResponseId !== event.responseId) {
        return this.scheduleFatal('protocol_violation');
      }
      if (
        this.responseDoneEvidence !== null
        && !sameResponseDoneEvidence(this.responseDoneEvidence, event)
      ) return this.scheduleFatal('protocol_violation');
      this.responseDoneEvidence ??= snapshotResponseDoneEvidence(event);
      return null;
    }
    if ('responseId' in event && event.responseId !== null) {
      if (this.observedResponseId === null || this.observedResponseId !== event.responseId) {
        return this.scheduleFatal('protocol_violation');
      }
    }
    return null;
  }

  private enqueue(event: OpenAiNativeResponseEvent): boolean {
    if (this.pendingProcessingCount >= OPENAI_NATIVE_MAX_PENDING_EVENTS) return false;
    this.pendingProcessingCount += 1;
    const process = async (): Promise<void> => {
      try {
        await this.process(event);
      } finally {
        this.pendingProcessingCount -= 1;
      }
    };
    this.processing = this.processing.then(process, process);
    return true;
  }

  private async process(event: OpenAiNativeResponseEvent): Promise<void> {
    if (this.requestState === null || this.binding === null) return;
    try {
      // Metering evidence belongs to the provider response, not to the UI lifecycle. Once a
      // correlated response.done has entered the bounded queue, cancellation or a later protocol
      // fatal must not erase the incurred usage.
      if (event.type === 'response_done' && !this.usageRecorded) {
        if (!(await this.attemptUsagePersistence(
          this.responseDoneEvidence ?? event,
          'initial',
        ))) {
          // A preceding duplicate/protocol event may already own the single initial fatal batch.
          // Provider duplicates never open another durable retry batch; only `settled()` may.
          if (this.fatalOutcome === null) await this.fatal('usage_unavailable');
          return;
        }
      }
      if (this.fatalOutcome !== null || this.retired) return;
      const previous = this.requestState;
      const next = snapshotResponseState(reduceOpenAiNativeResponseState(previous, event));
      this.requestState = next;

      // Cost is incurred even when the provider reports a failed/incomplete response. Persist it
      // before any durable RESPONSE_DONE/FAIL transition can make the delivery terminal.
      if (next.phase === 'failed') {
        await this.fatal(failureForState(next));
        return;
      }
      if (next.phase === 'cancelled') {
        await this.fatal('provider_failed');
        return;
      }

      if (event.type === 'response_created' && previous.responseId === null) {
        const accepted = await this.safeTransition(() => this.authority.acceptProviderResponse({
          ...this.binding!,
          providerResponseId: event.responseId,
        }));
        if (this.retired || this.fatalOutcome !== null) return;
        if (!durableApplied(accepted)) {
          await this.fatal('durable_transition_failed');
          return;
        }
      }
      if (event.type === 'audio_delta' && !previous.audioSeen) {
        const streaming = await this.safeTransition(() => this.authority.startStreaming({
          ...this.binding!,
          providerResponseId: event.responseId,
        }));
        if (this.retired || this.fatalOutcome !== null) return;
        if (!durableApplied(streaming)) {
          await this.fatal('durable_transition_failed');
          return;
        }
        if (!this.streamingNotified) {
          this.streamingNotified = true;
          this.callbacks.onStreaming?.({
            deliveryId: this.binding.deliveryId,
            responseId: event.responseId,
          });
        }
      }
      if (event.type === 'response_done' && event.status === 'completed') {
        const transcript = next.finalTranscript;
        if (transcript === null) {
          await this.fatal('protocol_violation');
          return;
        }
        const responseDone = await this.safeTransition(() => this.authority.responseDone({
          ...this.binding!,
          providerResponseId: event.responseId,
          providerTranscript: transcript,
        }));
        if (this.retired || this.fatalOutcome !== null) return;
        if (!durableApplied(responseDone)) {
          await this.fatal('durable_transition_failed');
          return;
        }
      }
      if (event.type === 'audio_buffer_stopped') {
        const stopped = await this.safeTransition(() => this.authority.outputStopped({
          ...this.binding!,
          providerResponseId: event.responseId,
        }));
        if (this.retired || this.fatalOutcome !== null) return;
        if (!durableApplied(stopped)) {
          await this.fatal('durable_transition_failed');
          return;
        }
      }
      if (next.phase === 'completed' && !this.completionNotified && next.responseId !== null) {
        this.completed = true;
        this.completionNotified = true;
        this.callbacks.onCompleted?.({
          deliveryId: this.binding.deliveryId,
          responseId: next.responseId,
          state: snapshotResponseState(next),
        });
      }
    } catch {
      await this.fatal('internal_error');
    }
  }

  private beginCancellation(
    source: OpenAiNativeMobileInterruptionSource,
    reason: OpenAiNativeSpeechCancellationReason,
  ): Promise<OpenAiNativeResponseInterruptionOutcome> {
    if (this.cancellationPromise !== null) return this.cancellationPromise;
    if (this.fatalOutcome !== null) return Promise.resolve(this.fatalOutcome);
    if (this.binding === null || this.requestState === null) {
      return Promise.resolve({ status: 'not_active' });
    }
    if (!this.retire()) return Promise.resolve(this.fatalOutcome!);
    this.cancellationPromise = this.finishCancellation(source, reason);
    return this.cancellationPromise;
  }

  private retire(): boolean {
    if (this.cancellationId === null) {
      try {
        this.cancellationId = this.entropy.cancellationId().toLowerCase();
      } catch {
        this.scheduleFatal('internal_error');
        return false;
      }
    }
    this.retired = true;
    this.pendingEvents = [];
    return true;
  }

  private async finishCancellation(
    source: OpenAiNativeMobileInterruptionSource | OpenAiNativeServerInterruptionReason,
    reason: OpenAiNativeSpeechCancellationReason,
  ): Promise<OpenAiNativeResponseInterruptionOutcome> {
    if (this.startPromise !== null) await this.startPromise;
    if (this.fatalOutcome !== null) {
      await this.persistFatal(this.fatalTrigger ?? 'internal_error', true);
      return this.fatalOutcome;
    }
    if (this.binding === null || this.cancellationId === null) return { status: 'not_active' };
    const cancelled = await this.safeTransition(() => this.authority.cancel({
      ...this.binding!,
      cancellationId: this.cancellationId!,
      reason,
    }));
    if (durableApplied(cancelled)) this.cancellationPersisted = true;
    if (this.fatalOutcome !== null) {
      if (!this.cancellationPersisted) {
        await this.persistFatal(this.fatalTrigger ?? 'internal_error', true);
      }
      return this.fatalOutcome;
    }
    if (!this.cancellationPersisted) return this.fatal('cancellation_failed');
    try {
      this.callbacks.onCancelled?.({ deliveryId: this.binding.deliveryId, source });
    } catch {
      return this.fatal('internal_error', false);
    }
    return { status: 'cancelled', source };
  }

  private async finishServerCancellation(
    reason: OpenAiNativeServerInterruptionReason,
    sendCancelAndClear: (
      command: OpenAiNativeServerCancelAndClearCommand,
    ) => Promise<OpenAiNativeServerCancelAndClearResult>,
  ): Promise<OpenAiNativeResponseInterruptionOutcome> {
    if (this.startPromise !== null) await this.startPromise;
    if (this.fatalOutcome !== null) return this.fatalOutcome;
    if (this.observedResponseId === null) {
      // response.create may already be in flight. A buffer clear alone does not cancel generation.
      const durable = await this.finishCancellation(reason, reason);
      if (durable.status === 'fatal') return durable;
      return this.fatal('server_interrupt_ambiguous', false);
    }
    const events: OpenAiNativeServerCancelAndClearCommand['events'] = Object.freeze([
      { type: 'response.cancel' as const, response_id: this.observedResponseId },
      { type: 'output_audio_buffer.clear' as const },
    ]);
    const sendResult = await this.runWithDeadline(
      () => sendCancelAndClear({
        responseId: this.observedResponseId,
        events,
        closeIfAmbiguous: true,
      }),
      this.serverInterruptTimeoutMs,
      { status: 'ambiguous' as const },
    );
    const durable = await this.finishCancellation(reason, reason);
    if (durable.status === 'fatal') return durable;
    if (
      typeof sendResult !== 'object'
      || sendResult === null
      || sendResult.status !== 'sent'
    ) return this.fatal('server_interrupt_ambiguous', false);
    return durable;
  }

  private handleRetiredWireEvent(raw: unknown): OpenAiNativeResponseWireOutcome {
    if (this.fatalOutcome !== null) return this.fatalOutcome;
    if (this.requestState === null) return { status: 'ignored' };
    let event: OpenAiNativeResponseEvent;
    try {
      event = decodeOpenAiNativeResponseEvent(raw);
    } catch {
      return this.scheduleFatal('protocol_violation');
    }
    if (event.type === 'ignored') return { status: 'ignored' };
    this.ingressEventCount += 1;
    if (this.ingressEventCount > OPENAI_NATIVE_RESPONSE_LIMITS.maxEventsPerResponse) {
      return this.scheduleFatal('protocol_violation');
    }

    const request = this.requestState.expected;
    if (event.type === 'response_created') {
      if (!metadataMatchesRequest(event.metadata, request)) {
        return this.scheduleFatal('protocol_violation');
      }
      if (this.observedResponseId !== null && this.observedResponseId !== event.responseId) {
        return this.scheduleFatal('protocol_violation');
      }
      this.observedResponseId = event.responseId;
      return { status: 'handled' };
    }

    if (event.type === 'response_done') {
      if (!metadataMatchesRequest(event.metadata, request)) {
        return this.scheduleFatal('protocol_violation');
      }
      if (this.observedResponseId !== null && this.observedResponseId !== event.responseId) {
        return this.scheduleFatal('protocol_violation');
      }
      this.observedResponseId ??= event.responseId;
      if (
        this.responseDoneEvidence !== null
        && !sameResponseDoneEvidence(this.responseDoneEvidence, event)
      ) return this.scheduleFatal('protocol_violation');
      this.responseDoneEvidence ??= snapshotResponseDoneEvidence(event);
      const speechMismatch =
        event.status === 'completed'
        && (
          event.transcript === null
          || !areOpenAiNativeSpeechTranscriptsConcordant(
            request.canonicalSpeech,
            event.transcript,
          )
        );
      if (!this.enqueueRetiredTerminal(event, speechMismatch ? 'speech_mismatch' : null)) {
        return this.scheduleFatal('event_queue_overflow');
      }
      return { status: 'handled' };
    }

    if (event.type === 'provider_error') {
      if (event.responseId === null) return { status: 'ignored' };
      return event.responseId === this.observedResponseId
        ? { status: 'handled' }
        : this.scheduleFatal('protocol_violation');
    }
    if (event.type === 'audio_delta' || event.type === 'audio_buffer_started') {
      return this.scheduleFatal('protocol_violation');
    }
    if (this.observedResponseId === null || event.responseId !== this.observedResponseId) {
      return this.scheduleFatal('protocol_violation');
    }
    if (
      'itemId' in event
      && !this.acceptQuarantineOutputIdentity(event)
    ) return this.scheduleFatal('protocol_violation');

    if (event.type === 'transcript_delta') {
      const next = this.quarantineTranscript + event.text;
      if (utf8Bytes(next) > OPENAI_NATIVE_RESPONSE_LIMITS.maxTranscriptUtf8Bytes) {
        return this.scheduleFatal('protocol_violation');
      }
      this.quarantineTranscript = next;
      return { status: 'handled' };
    }
    if (event.type === 'transcript_done') {
      if (
        this.quarantineFinalTranscript !== null
        && this.quarantineFinalTranscript !== event.transcript
      ) return this.scheduleFatal('protocol_violation');
      if (
        this.quarantineTranscript.length > 0
        && this.quarantineTranscript !== event.transcript
      ) return this.scheduleFatal('protocol_violation');
      this.quarantineFinalTranscript = event.transcript;
      return { status: 'handled' };
    }
    if (
      (event.type === 'audio_output_item' || event.type === 'audio_content_part')
      && event.transcript !== null
    ) {
      if (utf8Bytes(event.transcript) > OPENAI_NATIVE_RESPONSE_LIMITS.maxTranscriptUtf8Bytes) {
        return this.scheduleFatal('protocol_violation');
      }
      return { status: 'handled' };
    }
    // audio_done, output item/part without transcript, stopped and cleared are terminal evidence.
    return { status: 'handled' };
  }

  private acceptQuarantineOutputIdentity(
    event: Extract<OpenAiNativeResponseEvent, { readonly itemId: string }>,
  ): boolean {
    if (event.outputIndex !== 0 || ('contentIndex' in event && event.contentIndex !== 0)) {
      return false;
    }
    const expectedItemId = this.requestState?.outputItemId ?? this.quarantineOutputItemId;
    if (expectedItemId !== null && expectedItemId !== event.itemId) return false;
    this.quarantineOutputItemId ??= event.itemId;
    return true;
  }

  private enqueueRetiredTerminal(
    event: Extract<OpenAiNativeResponseEvent, { readonly type: 'response_done' }>,
    postUsageFatal: OpenAiNativeResponseFatalTrigger | null,
  ): boolean {
    if (this.pendingProcessingCount >= OPENAI_NATIVE_MAX_PENDING_EVENTS) return false;
    this.pendingProcessingCount += 1;
    const process = async (): Promise<void> => {
      try {
        if (this.fatalOutcome !== null) return;
        if (!this.usageRecorded && !(await this.attemptUsagePersistence(
          this.responseDoneEvidence ?? event,
          'initial',
        ))) {
          if (this.fatalOutcome === null) await this.fatal('usage_unavailable');
          return;
        }
        if (postUsageFatal !== null) await this.fatal(postUsageFatal);
      } finally {
        this.pendingProcessingCount -= 1;
      }
    };
    this.processing = this.processing.then(process, async () => {
      try {
        await this.fatal('internal_error');
      } finally {
        this.pendingProcessingCount -= 1;
      }
    });
    return true;
  }

  private async attemptUsagePersistence(
    event: Extract<OpenAiNativeResponseEvent, { readonly type: 'response_done' }>,
    mode: 'initial' | 'reconcile',
  ): Promise<boolean> {
    if (this.usageRecorded) return true;
    if (this.usagePersistenceInFlight !== null) return this.usagePersistenceInFlight;
    if (mode === 'initial') {
      if (this.usageInitialAttempted) return false;
      this.usageInitialAttempted = true;
    } else {
      if (this.usageReconcileAttempts >= OPENAI_NATIVE_USAGE_RECONCILE_MAX_ATTEMPTS) return false;
      this.usageReconcileAttempts += 1;
    }
    const attempt = this.recordUsageEvidence(event);
    this.usagePersistenceInFlight = attempt;
    try {
      return await attempt;
    } finally {
      if (this.usagePersistenceInFlight === attempt) this.usagePersistenceInFlight = null;
    }
  }

  private async recordUsageEvidence(
    event: Extract<OpenAiNativeResponseEvent, { readonly type: 'response_done' }>,
  ): Promise<boolean> {
    if (this.binding === null || event.usage.status !== 'available') return false;
    const usage = snapshotUsage(event.usage);
    if (usage.status !== 'available') return false;
    const input = Object.freeze({
      provider: 'openai' as const,
      companyId: this.binding.companyId,
      deliveryId: this.binding.deliveryId,
      sessionId: this.binding.sessionId,
      turnId: this.binding.turnId,
      usage,
    });
    try {
      const result = await this.runWithDeadline(
        () => this.usage.record(input),
        this.durableOperationTimeoutMs,
        { status: 'unavailable' as const },
      );
      if (result.status !== 'recorded' && result.status !== 'duplicate') return false;
      this.usageRecorded = true;
      return true;
    } catch {
      return false;
    }
  }

  private async safeTransition(
    action: () => Promise<OpenAiNativeSpeechTransitionOutcome>,
  ): Promise<OpenAiNativeSpeechTransitionOutcome> {
    return this.runWithDeadline(
      action,
      this.durableOperationTimeoutMs,
      { status: 'unavailable' },
    );
  }

  private sendResponseCreate(data: string): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      let timeoutHandle: unknown;
      const settle = (success: boolean): void => {
        if (settled) return;
        settled = true;
        try {
          this.timing.clearTimeout(timeoutHandle);
        } catch {
          // Clearing an already-fired timer is best effort; the at-most-once latch is authoritative.
        }
        resolve(success);
      };
      try {
        timeoutHandle = this.timing.setTimeout(
          () => settle(false),
          this.responseSendTimeoutMs,
        );
      } catch {
        settle(false);
        return;
      }
      try {
        this.socket.send(data, (error) => settle(error === undefined));
      } catch {
        // `send` can throw after handing bytes to the network. Never retry this delivery.
        settle(false);
      }
    });
  }

  private runWithDeadline<T>(
    action: () => Promise<T>,
    timeoutMs: number,
    timeoutValue: T,
  ): Promise<T> {
    return new Promise((resolve) => {
      let settled = false;
      let timeoutHandle: unknown;
      const settle = (value: T): void => {
        if (settled) return;
        settled = true;
        try {
          this.timing.clearTimeout(timeoutHandle);
        } catch {
          // The result latch makes a late timeout harmless.
        }
        resolve(value);
      };
      try {
        timeoutHandle = this.timing.setTimeout(() => settle(timeoutValue), timeoutMs);
      } catch {
        settle(timeoutValue);
        return;
      }
      try {
        void action().then(settle, () => settle(timeoutValue));
      } catch {
        settle(timeoutValue);
      }
    });
  }

  private scheduleFatal(
    reason: OpenAiNativeResponseFatalTrigger,
    persist = true,
  ): OpenAiNativeResponseFatalOutcome {
    const outcome = this.enterFatal(reason);
    this.processing = this.processing.then(
      () => this.persistFatal(reason, persist),
      () => this.persistFatal(reason, persist),
    );
    return outcome;
  }

  private async fatal(
    reason: OpenAiNativeResponseFatalTrigger,
    persist = true,
  ): Promise<OpenAiNativeResponseFatalOutcome> {
    const outcome = this.enterFatal(reason);
    await this.persistFatal(reason, persist);
    return outcome;
  }

  private enterFatal(reason: OpenAiNativeResponseFatalTrigger): OpenAiNativeResponseFatalOutcome {
    if (this.fatalOutcome !== null) return this.fatalOutcome;
    this.fatalTrigger = reason;
    this.fatalOutcome = Object.freeze({ status: 'fatal', reason, closeRequired: true });
    this.pendingEvents = [];
    let fenceResult: OpenAiNativeResponseSessionFenceResult = { status: 'failed' };
    try {
      fenceResult = this.sessionFence.fenceAndClose({ reason });
    } catch {
      fenceResult = { status: 'failed' };
    }
    if (fenceResult.status !== 'applied' && fenceResult.status !== 'already_closed') {
      try {
        fenceResult = this.sessionFence.emergencyRevokeAndTerminate({ reason });
      } catch {
        fenceResult = { status: 'failed' };
      }
      if (fenceResult.status !== 'applied' && fenceResult.status !== 'already_closed') {
        this.fatalOutcome = Object.freeze({
          status: 'fatal',
          reason: 'session_fence_failed',
          cause: reason,
          closeRequired: true,
        });
      }
    }
    try {
      this.callbacks.onFatal(this.fatalOutcome);
    } catch {
      // The caller callback is advisory; the returned closeRequired outcome remains authoritative.
    }
    return this.fatalOutcome;
  }

  private async persistFatal(
    reason: OpenAiNativeResponseFatalTrigger,
    persist: boolean,
  ): Promise<void> {
    if (!this.usageRecorded && this.responseDoneEvidence !== null && this.binding !== null) {
      // A fatal path gets one initial attempt regardless of how many duplicate done events exist.
      await this.attemptUsagePersistence(this.responseDoneEvidence, 'initial');
    }
    if (this.fatalPersisted || !persist || this.binding === null) return;
    if (this.fatalPersistenceInFlight !== null) {
      await this.fatalPersistenceInFlight;
      return;
    }
    const persistOnce = async (): Promise<void> => {
      for (let attempt = 0; attempt < OPENAI_NATIVE_FATAL_PERSIST_MAX_ATTEMPTS; attempt += 1) {
        if (this.failureId === null) {
          try {
            this.failureId = this.entropy.failureId().toLowerCase();
          } catch {
            continue;
          }
        }
        const failed = await this.safeTransition(() => this.authority.fail({
          ...this.binding!,
          failureId: this.failureId!,
          reason: durableFailureReason(this.fatalOutcome?.reason ?? reason),
        }));
        if (durableApplied(failed)) {
          this.fatalPersisted = true;
          return;
        }
      }
    };
    const inFlight = persistOnce();
    this.fatalPersistenceInFlight = inFlight;
    try {
      await inFlight;
    } finally {
      if (this.fatalPersistenceInFlight === inFlight) this.fatalPersistenceInFlight = null;
    }
  }
}
