import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { OnApplicationShutdown } from '@nestjs/common';
import {
  isAllowedAgentNavigationRoute,
  type AgentHistoryTurn,
  type AgentRunKind,
} from '@bob/ai';
import type { PlanTier } from '@bob/core';
import WebSocket, { type ClientOptions, type RawData } from 'ws';
import type { AppLogger } from '../../observability/logger';
import type { Metrics } from '../../observability/metrics';
import type { RealtimeCallTerminationOutcome } from './realtime-call-lifecycle';
import type { RealtimeAgentTurnOutcome } from './realtime-agent-turn';
import {
  OpenAiNativeResponseDispatcher,
  type OpenAiNativeResponseDispatcherCallbacks,
  type OpenAiNativeResponseFatalReason,
  type OpenAiNativeResponseSessionFencePort,
  type OpenAiNativeServerCancelAndClearCommand,
  type OpenAiNativeServerCancelAndClearResult,
} from './openai-native-response-dispatcher';
import type {
  OpenAiNativeSpeechAuthority,
  OpenAiNativeSpeechAuthorityBinding,
} from './openai-native-speech-authority';
import { OpenAiNativeResponseUsageAdapter } from './openai-native-response-usage';
import type {
  RealtimeSidebandContextVersion,
  RealtimeSidebandOwnerIdentity,
  RealtimeSidebandOwnerPort,
} from './realtime-sideband-owner';
import type { RealtimeSpeechDeliveryRepositoryPort } from './realtime-speech-delivery.repository';
import type { RealtimeDurableControlAuthority } from './realtime-control';
import type {
  RealtimeSpeechCancellationReason,
  RealtimeSpeechPublisher,
  RealtimeSpeechPublishOutcome,
} from './realtime-speech-publisher';
import type {
  OpenAiRealtimeCallProvider,
  OpenAiRealtimeSessionConfig,
  RealtimeVoiceSettings,
} from './realtime.types';
import type { RealtimeVoiceUsageWriterPort } from './realtime-voice-usage';

const CALL_ID = /^rtc_[A-Za-z0-9_-]{1,200}$/u;
const PROVIDER_ITEM_ID = /^[A-Za-z0-9_-]{1,200}$/u;
const PROVIDER_ERROR_TOKEN = /^[A-Za-z0-9_.-]{1,120}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CONTEXT_DIGEST = /^[a-f0-9]{64}$/u;
const MAX_SIDEBAND_EVENT_BYTES = 256 * 1024;
const MAX_SEEN_INPUT_ITEMS = 256;
const MAX_TURNS_PER_SESSION = 60;
const MAX_TRANSCRIPT_CHARS = 4_000;
const MAX_PROVIDER_ERRORS = 3;
const CONTROL_ACK_WAIT_TIMEOUT_MS = 2_000;
const CONTROL_CONTEXT_REVALIDATION_TIMEOUT_MS = 1_000;
const CONTROL_APPROVAL_TTL_MS = 15_000;
const MAX_CONTROL_TURNS = 64;
const MAX_CONTROL_WAITERS = 8;
const DURABLE_CLEANUP_MAX_TIMEOUT_MS = 2_000;
const PLAN_TIERS = new Set<PlanTier>(['free', 'solo', 'pro', 'business']);

interface SidebandSocket {
  readonly readyState: number;
  on(event: 'open', listener: () => void): this;
  on(event: 'message', listener: (data: RawData, isBinary: boolean) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'close', listener: (code: number, reason: Buffer) => void): this;
  send(data: string, callback?: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

export type RealtimeSidebandSocketFactory = (url: string, options: ClientOptions) => SidebandSocket;

export interface RealtimeSidebandAuditedSpeechDependencies {
  readonly publisher: Pick<RealtimeSpeechPublisher, 'publish'>;
  readonly cancellation: Pick<RealtimeSpeechDeliveryRepositoryPort, 'cancel'>;
  readonly controls: Pick<RealtimeDurableControlAuthority, 'issue'>;
}

export interface RealtimeSidebandNativeSpeechDependencies {
  readonly authority: OpenAiNativeSpeechAuthority;
  readonly usage: RealtimeVoiceUsageWriterPort;
}

export interface RealtimeSidebandSpeechDependencies {
  readonly owner: RealtimeSidebandOwnerPort;
  readonly audited?: RealtimeSidebandAuditedSpeechDependencies;
  readonly native?: RealtimeSidebandNativeSpeechDependencies;
  readonly entropy?: {
    readonly ownerToken: () => string;
    readonly cancellationId: () => string;
  };
}

export interface RealtimeSidebandAttachInput {
  callId: string;
  userId: string;
  companyId: string;
  sessionHandle?: string;
  speechDelivery: 'audited-signed-url-v1' | 'openai-native-webrtc-v1';
  plan: PlanTier;
  subjectKeyVersion: number;
  session: OpenAiRealtimeSessionConfig;
  lifecycle?: {
    activate(): Promise<void>;
    terminate(
      reason: 'user' | 'kill_switch' | 'superseded' | 'max_duration' | 'shutdown',
    ): Promise<RealtimeCallTerminationOutcome>;
  };
  turn?: {
    run(input: {
      transcript: string;
      history: readonly AgentHistoryTurn[];
      signal: AbortSignal;
    }): Promise<RealtimeAgentTurnOutcome>;
  };
  controlContext?: {
    isCurrent(
      input: { version: 1; revision: number; digest: string },
      signal: AbortSignal,
    ): Promise<boolean>;
  };
}

export interface RealtimeApprovedAgentControl {
  readonly turnId: string;
  readonly kind: AgentRunKind;
  readonly contextRevision: number;
  readonly contextDigest: string;
  readonly navigate?: string;
  readonly proposalId?: string;
  readonly proposalExpiresAt?: string;
}

export type RealtimeAgentControlConsumption =
  | { readonly status: 'approved'; readonly control: RealtimeApprovedAgentControl }
  | { readonly status: 'not_found' }
  | { readonly status: 'unavailable' };

export interface RealtimeSpeechDeliveryAcknowledgement {
  readonly userId: string;
  readonly companyId: string;
  readonly sessionHandle: string;
  readonly turnId: string;
  readonly artifactId: string;
  readonly acknowledgementId: string;
  readonly contextRevision: number;
  readonly contextDigest: string;
}

export interface RealtimeSidebandControl {
  attach(input: RealtimeSidebandAttachInput): Promise<void>;
  contextChanged(input: {
    userId: string;
    companyId: string;
    sessionHandle: string;
    revision: number;
    digest: string;
  }): void;
  /**
   * Doit être appelé exclusivement après le CAS durable `ready -> delivered`. Son absence garde
   * les contrôles fermés : un turnId deviné avant l'ACK ne peut jamais naviguer ni proposer.
   */
  speechDelivered?(input: RealtimeSpeechDeliveryAcknowledgement): void;
  consumeAgentControl(input: {
    userId: string;
    companyId: string;
    sessionHandle: string;
    turnId: string;
    contextRevision: number;
    contextDigest: string;
    signal?: AbortSignal;
  }): Promise<RealtimeAgentControlConsumption>;
  closeForPrincipal(
    input: { userId: string; companyId: string },
    reason: 'user' | 'kill_switch',
  ): Promise<void>;
  closeSession(input: {
    userId: string;
    companyId: string;
    sessionHandle: string;
  }): Promise<'not_found' | RealtimeCallTerminationOutcome>;
}

type DecodedSidebandEvent =
  | { readonly type: 'session_updated'; readonly policyMatches: boolean }
  | { readonly type: 'input_committed'; readonly itemId: string | null }
  | { readonly type: 'speech_started' }
  | { readonly type: 'transcript_completed'; readonly itemId: string | null; readonly transcript: string | null }
  | { readonly type: 'transcript_failed'; readonly itemId: string | null }
  | { readonly type: 'user_text_item'; readonly itemId: string | null; readonly text: string | null }
  | { readonly type: 'dangerous_conversation_item' }
  | { readonly type: 'forbidden_provider_output' }
  | { readonly type: 'unexpected_tool_call' }
  | {
      readonly type: 'provider_error';
      readonly errorType: string | null;
      readonly code: string | null;
    }
  | { readonly type: 'malformed_event' }
  | { readonly type: 'ignored' };

interface PendingSpeech {
  readonly generation: number;
  readonly turnId: string;
  readonly userTranscript: string;
  readonly canonicalSpeech: string;
  readonly kind: string;
  readonly context: RealtimeSidebandContextVersion;
  readonly control: RealtimeApprovedAgentControl | null;
  readonly controller: AbortController;
  artifactId: string | null;
  delivered: boolean;
}

interface PendingNativeSpeech {
  readonly generation: number;
  readonly deliveryId: string;
  readonly turnId: string;
  readonly userTranscript: string;
  readonly canonicalSpeech: string;
  readonly kind: string;
  readonly context: RealtimeSidebandContextVersion;
  readonly dispatcher: OpenAiNativeResponseDispatcher;
  responseId: string | null;
}

interface DecodedSidebandWireEvent {
  readonly event: DecodedSidebandEvent;
  readonly rawEvent: Record<string, unknown> | null;
  readonly rawWire: Buffer | null;
}

interface ApprovedControlRecord {
  readonly control: RealtimeApprovedAgentControl;
  readonly expiresAt: number;
}

interface ControlWaiter {
  readonly contextRevision: number;
  readonly contextDigest: string;
  readonly signal?: AbortSignal;
  readonly resolve: (outcome: RealtimeAgentControlConsumption) => void;
  timer: ReturnType<typeof setTimeout> | null;
  onAbort: (() => void) | null;
  settled: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeProviderItemId(value: unknown): string | null {
  return typeof value === 'string' && PROVIDER_ITEM_ID.test(value) ? value : null;
}

function safeProviderErrorToken(value: unknown): string | null {
  return typeof value === 'string' && PROVIDER_ERROR_TOKEN.test(value) ? value : null;
}

function isUnexpectedToolEvent(event: Record<string, unknown>): boolean {
  if (typeof event.type !== 'string') return false;
  if (event.type.includes('function_call') || event.type.includes('.mcp_')) return true;
  if (event.type === 'response.output_item.created' || event.type === 'response.output_item.done') {
    const itemType = record(event.item)?.type;
    return typeof itemType === 'string' && (itemType === 'function_call' || itemType.endsWith('_call'));
  }
  return false;
}

function conversationItemEvent(event: Record<string, unknown>): DecodedSidebandEvent | null {
  if (event.type !== 'conversation.item.added' && event.type !== 'conversation.item.done') return null;
  const item = record(event.item);
  if (!item || typeof item.type !== 'string') return { type: 'malformed_event' };
  if (
    item.type === 'function_call'
    || item.type === 'function_call_output'
    || item.type === 'mcp_approval_response'
    || item.type.startsWith('mcp_')
    || item.type.endsWith('_call')
  ) return { type: 'dangerous_conversation_item' };
  if (item.type !== 'message') return { type: 'ignored' };
  if (item.role !== 'user') return { type: 'dangerous_conversation_item' };
  if (!Array.isArray(item.content)) return { type: 'malformed_event' };
  const part = item.content
    .map(record)
    .find((candidate) => candidate?.type === 'input_text' && typeof candidate.text === 'string');
  if (!part) return { type: 'ignored' };
  const text = typeof part.text === 'string'
    && part.text.trim().length > 0
    && part.text.length <= MAX_TRANSCRIPT_CHARS
    ? part.text
    : null;
  return { type: 'user_text_item', itemId: safeProviderItemId(item.id), text };
}

function sessionPolicyMatches(value: unknown, expected: OpenAiRealtimeSessionConfig): boolean {
  const session = record(value);
  const audio = record(session?.audio);
  const input = record(audio?.input);
  const output = record(audio?.output);
  const turnDetection = record(input?.turn_detection);
  const noiseReduction = record(input?.noise_reduction);
  const transcription = record(input?.transcription);
  const inputFormat = record(input?.format);
  const outputFormat = record(output?.format);
  const modalities = session?.output_modalities;
  return session?.type === 'realtime'
    && session.model === expected.model
    && Array.isArray(modalities)
    && modalities.length === 1
    && modalities[0] === expected.output_modalities[0]
    && session.instructions === expected.instructions
    && (session.include === undefined || (Array.isArray(session.include) && session.include.length === 0))
    && session.truncation === expected.truncation
    && (session.prompt === undefined || session.prompt === null)
    && Array.isArray(session.tools)
    && session.tools.length === 0
    && session.tool_choice === 'none'
    && session.max_output_tokens === expected.max_output_tokens
    && session.tracing === null
    && output?.voice === expected.audio.output.voice
    && output?.speed === expected.audio.output.speed
    && inputFormat?.type === expected.audio.input.format.type
    && inputFormat.rate === expected.audio.input.format.rate
    && outputFormat?.type === expected.audio.output.format.type
    && outputFormat.rate === expected.audio.output.format.rate
    && noiseReduction?.type === expected.audio.input.noise_reduction.type
    && transcription?.model === expected.audio.input.transcription.model
    && transcription.language === expected.audio.input.transcription.language
    && transcription.prompt === expected.audio.input.transcription.prompt
    && turnDetection?.type === expected.audio.input.turn_detection.type
    && turnDetection.eagerness === expected.audio.input.turn_detection.eagerness
    && turnDetection.create_response === false
    && turnDetection.interrupt_response === expected.audio.input.turn_detection.interrupt_response;
}

function rawBytes(raw: RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof ArrayBuffer) return Buffer.from(raw);
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return Buffer.from(raw as ArrayBuffer);
}

function decodeEvent(
  raw: RawData,
  isBinary: boolean,
  expected: OpenAiRealtimeSessionConfig,
): DecodedSidebandWireEvent {
  const malformed = (): DecodedSidebandWireEvent => ({
    event: { type: 'malformed_event' },
    rawEvent: null,
    rawWire: null,
  });
  if (isBinary) return malformed();
  const bytes = rawBytes(raw);
  if (bytes.byteLength > MAX_SIDEBAND_EVENT_BYTES) return malformed();
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    return malformed();
  }
  const event = record(value);
  if (!event || typeof event.type !== 'string') return malformed();
  const decoded = (decodedEvent: DecodedSidebandEvent): DecodedSidebandWireEvent => ({
    event: decodedEvent,
    rawEvent: event,
    rawWire: bytes,
  });
  if (event.type === 'session.updated') {
    return decoded({ type: 'session_updated', policyMatches: sessionPolicyMatches(event.session, expected) });
  }
  if (event.type === 'input_audio_buffer.committed') {
    return decoded({ type: 'input_committed', itemId: safeProviderItemId(event.item_id) });
  }
  if (event.type === 'input_audio_buffer.speech_started') return decoded({ type: 'speech_started' });
  if (event.type === 'conversation.item.input_audio_transcription.completed') {
    const transcript = typeof event.transcript === 'string'
      && event.transcript.trim().length > 0
      && event.transcript.length <= MAX_TRANSCRIPT_CHARS
      ? event.transcript
      : null;
    return decoded({ type: 'transcript_completed', itemId: safeProviderItemId(event.item_id), transcript });
  }
  if (event.type === 'conversation.item.input_audio_transcription.failed') {
    return decoded({ type: 'transcript_failed', itemId: safeProviderItemId(event.item_id) });
  }
  const conversation = conversationItemEvent(event);
  if (conversation) return decoded(conversation);
  if (isUnexpectedToolEvent(event)) return decoded({ type: 'unexpected_tool_call' });
  if (event.type === 'error') {
    const error = record(event.error);
    return decoded({
      type: 'provider_error',
      errorType: safeProviderErrorToken(error?.type),
      code: safeProviderErrorToken(error?.code),
    });
  }
  if (event.type.startsWith('response.') || event.type.startsWith('output_audio_buffer.')) {
    return decoded({ type: 'forbidden_provider_output' });
  }
  return decoded({ type: 'ignored' });
}

function websocketUrl(baseUrl: string, callId: string): string {
  if (!CALL_ID.test(callId)) throw new Error('sideband_invalid_call_id');
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('sideband_invalid_base_url');
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/$/u, '')}/realtime`;
  url.search = '';
  url.hash = '';
  url.searchParams.set('call_id', callId);
  return url.toString();
}

function controlSession(session: OpenAiRealtimeSessionConfig): Record<string, unknown> {
  return {
    type: 'realtime',
    output_modalities: session.output_modalities,
    instructions: session.instructions,
    include: session.include,
    truncation: session.truncation,
    tools: [],
    tool_choice: 'none',
    audio: session.audio,
    max_output_tokens: session.max_output_tokens,
    tracing: null,
  };
}

function principalKey(input: { userId: string; companyId: string }): string {
  return JSON.stringify([input.companyId, input.userId]);
}

function tokenHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function boundedCleanup<T>(work: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const guarded = work.catch(() => null);
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), Math.min(timeoutMs, DURABLE_CLEANUP_MAX_TIMEOUT_MS));
  });
  try {
    return await Promise.race([guarded, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sessionMatchesSpeechDelivery(
  session: OpenAiRealtimeSessionConfig,
  speechDelivery: RealtimeSidebandAttachInput['speechDelivery'],
): boolean {
  return speechDelivery === 'openai-native-webrtc-v1'
    ? session.output_modalities.length === 1 && session.output_modalities[0] === 'audio'
    : session.output_modalities.length === 1 && session.output_modalities[0] === 'text';
}

function providerResponseRouteHint(event: Record<string, unknown>): {
  readonly deliveryId: string | null;
  readonly responseId: string | null;
} {
  const response = record(event.response);
  const metadata = record(response?.metadata);
  const error = record(event.error);
  const deliveryId = typeof metadata?.bob_delivery_id === 'string' && UUID.test(metadata.bob_delivery_id)
    ? metadata.bob_delivery_id.toLowerCase()
    : null;
  const responseId = safeProviderItemId(
    event.response_id ?? response?.id ?? error?.response_id,
  );
  return { deliveryId, responseId };
}

function validContext(revision: number, digest: string): boolean {
  return Number.isSafeInteger(revision)
    && revision >= 1
    && revision <= 2_147_483_647
    && CONTEXT_DIGEST.test(digest);
}

function approvedControlFromOutcome(
  outcome: Exclude<RealtimeAgentTurnOutcome, { status: 'aborted' }>,
): RealtimeApprovedAgentControl | null {
  if (outcome.status !== 'ready') return null;
  const { contextVersion } = outcome;
  if (
    !UUID.test(outcome.turnId)
    || !validContext(contextVersion.revision ?? 0, contextVersion.digest)
    || (outcome.navigate !== undefined && !isAllowedAgentNavigationRoute(outcome.navigate))
    || (outcome.proposalId !== undefined && !UUID.test(outcome.proposalId))
    || (outcome.proposalExpiresAt !== undefined && (
      outcome.proposalExpiresAt.length > 40
      || !Number.isFinite(Date.parse(outcome.proposalExpiresAt))
      || outcome.proposalId === undefined
    ))
  ) return null;
  return {
    turnId: outcome.turnId,
    kind: outcome.kind,
    contextRevision: contextVersion.revision!,
    contextDigest: contextVersion.digest,
    ...(outcome.navigate === undefined ? {} : { navigate: outcome.navigate }),
    ...(outcome.proposalId === undefined ? {} : { proposalId: outcome.proposalId }),
    ...(outcome.proposalExpiresAt === undefined ? {} : { proposalExpiresAt: outcome.proposalExpiresAt }),
  };
}

function speechContext(
  outcome: Exclude<RealtimeAgentTurnOutcome, { status: 'aborted' }>,
  applied: RealtimeSidebandContextVersion | null,
): RealtimeSidebandContextVersion | null {
  if (outcome.status === 'ready') {
    const revision = outcome.contextVersion.revision;
    if (revision === null || !validContext(revision, outcome.contextVersion.digest)) return null;
    if (applied?.revision !== revision || applied.digest !== outcome.contextVersion.digest) return null;
    return { revision, digest: outcome.contextVersion.digest };
  }
  return applied;
}

function cancellationReasonForClose(
  reason: 'user' | 'kill_switch' | 'superseded' | 'max_duration' | 'shutdown',
): RealtimeSpeechCancellationReason {
  if (reason === 'user') return 'user_cancel';
  if (reason === 'superseded') return 'superseded';
  return 'session_end';
}

class ManagedSidebandSession {
  private settled = false;
  private ready = false;
  private countedActive = false;
  private closed = false;
  private finalized = false;
  private providerIngressFenced = false;
  private providerSocketTerminated = false;
  private closing: Promise<RealtimeCallTerminationOutcome> | null = null;
  private bootstrapTimer: ReturnType<typeof setTimeout> | null = null;
  private lifetimeTimer: ReturnType<typeof setTimeout> | null = null;
  private ownerRenewTimer: ReturnType<typeof setTimeout> | null = null;
  private startReject: ((error: Error) => void) | null = null;
  private activationPending = false;
  private readonly seenInputItems = new Set<string>();
  private readonly processedInputItems = new Set<string>();
  private readonly approvedControls = new Map<string, ApprovedControlRecord>();
  private readonly settledControlTurns = new Set<string>();
  private readonly controlWaiters = new Map<string, Set<ControlWaiter>>();
  private readonly controlValidationControllers = new Set<AbortController>();
  private history: AgentHistoryTurn[] = [];
  private turnAbort: AbortController | null = null;
  private turnCleanup: Promise<void> = Promise.resolve();
  private currentSpeech: PendingSpeech | null = null;
  private currentNativeSpeech: PendingNativeSpeech | null = null;
  private readonly nativeSpeechByDeliveryId = new Map<string, PendingNativeSpeech>();
  private readonly nativeSpeechByResponseId = new Map<string, PendingNativeSpeech>();
  private owner: RealtimeSidebandOwnerIdentity | null = null;
  private appliedContext: RealtimeSidebandContextVersion | null = null;
  private contextTransitionPending = false;
  private highestContextRevision = 0;
  private turnGeneration = 0;
  private contextApplicationGeneration = 0;
  private turns = 0;
  private providerErrors = 0;

  constructor(
    readonly principal: { userId: string; companyId: string },
    readonly sessionHandle: string,
    private readonly socket: SidebandSocket,
    private readonly session: OpenAiRealtimeSessionConfig,
    private readonly speechDelivery: RealtimeSidebandAttachInput['speechDelivery'],
    private readonly plan: PlanTier,
    private readonly subjectKeyVersion: number,
    private readonly timeoutMs: number,
    private readonly maxSessionSeconds: number,
    private readonly ownerLeaseSeconds: number,
    private readonly ownerRenewSeconds: number,
    private readonly ownerInstanceHash: string,
    private readonly ownerTokenHash: string,
    private readonly ownerPort: RealtimeSidebandOwnerPort,
    private readonly audited: RealtimeSidebandAuditedSpeechDependencies | null,
    private readonly native: RealtimeSidebandNativeSpeechDependencies | null,
    private readonly cancellationId: () => string,
    private readonly activateLease: () => Promise<void>,
    private readonly terminateCall: (
      reason: 'user' | 'kill_switch' | 'superseded' | 'max_duration' | 'shutdown',
    ) => Promise<RealtimeCallTerminationOutcome>,
    private readonly runTurn: (input: {
      transcript: string;
      history: readonly AgentHistoryTurn[];
      signal: AbortSignal;
    }) => Promise<RealtimeAgentTurnOutcome>,
    private readonly isControlContextCurrent: (
      input: { version: 1; revision: number; digest: string },
      signal: AbortSignal,
    ) => Promise<boolean>,
    private readonly metrics: Metrics,
    private readonly onSecurityRejection: (reason:
      | 'unexpected_tool_call'
      | 'session_policy_drift'
      | 'malformed_event'
      | 'unauthorized_response'
      | 'dangerous_conversation_item'
      | 'turn_budget_exceeded'
      | 'context_fence_rejected'
    ) => void,
    private readonly onProviderError: (reason:
      | 'provider_event_error'
      | 'sideband_closed'
      | 'hangup_failed'
      | 'turn_failed'
      | 'speech_publish_failed'
      | 'control_seal_failed'
      | 'speech_cancel_failed'
      | 'owner_lease_lost'
    ) => void,
    private readonly onReady: () => void,
    private readonly onClosed: (wasCountedActive: boolean) => void,
  ) {}

  isReady(): boolean {
    return this.ready && !this.closed && !this.finalized && this.owner !== null;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.startReject = reject;
      this.bootstrapTimer = setTimeout(() => this.failBootstrap(reject, 'sideband_timeout'), this.timeoutMs);
      const fail = (reason: string): void => this.failBootstrap(reject, reason);

      this.socket.on('open', () => {
        try {
          this.socket.send(JSON.stringify({
            type: 'session.update',
            event_id: 'bob_sideband_bootstrap',
            session: controlSession(this.session),
          }), (error) => {
            if (error) fail('sideband_send_failed');
          });
        } catch {
          fail('sideband_send_failed');
        }
      });
      this.socket.on('message', (data, isBinary) => {
        if (this.finalized || this.providerIngressFenced) return;
        const decoded = decodeEvent(data, isBinary, this.session);
        const { event } = decoded;
        if (event.type === 'session_updated') {
          if (!event.policyMatches) {
            this.rejectSecurity('session_policy_drift');
            if (!this.settled) fail('sideband_policy_drift');
            return;
          }
          if (!this.settled && !this.activationPending) {
            this.activationPending = true;
            void this.finishActivation(resolve, fail);
          }
          return;
        }
        if (event.type === 'input_committed') {
          if (!event.itemId || !this.isReady()) {
            this.rejectSecurity('malformed_event');
            return;
          }
          this.rememberInputItem(event.itemId);
          return;
        }
        if (event.type === 'speech_started') {
          if (this.isReady()) void this.interruptCurrentTurn('barge_in');
          return;
        }
        if (event.type === 'transcript_completed' || event.type === 'user_text_item') {
          const transcript = event.type === 'transcript_completed' ? event.transcript : event.text;
          if (!event.itemId || !transcript || !this.isReady()) {
            this.rejectSecurity('malformed_event');
            return;
          }
          if (!this.seenInputItems.has(event.itemId)) this.rememberInputItem(event.itemId);
          void this.processTranscript(event.itemId, transcript);
          return;
        }
        if (event.type === 'transcript_failed') {
          if (event.itemId && this.isReady()) void this.processTranscriptFailure(event.itemId);
          return;
        }
        if (event.type === 'forbidden_provider_output') {
          if (
            this.speechDelivery === 'openai-native-webrtc-v1'
            && decoded.rawEvent !== null
            && decoded.rawWire !== null
            && this.routeNativeProviderEvent(decoded.rawEvent, decoded.rawWire)
          ) return;
          this.rejectSecurity('unauthorized_response');
          return;
        }
        if (event.type === 'dangerous_conversation_item') {
          this.rejectSecurity('dangerous_conversation_item');
          return;
        }
        if (event.type === 'unexpected_tool_call') {
          this.rejectSecurity('unexpected_tool_call');
          return;
        }
        if (event.type === 'malformed_event') {
          this.rejectSecurity('malformed_event');
          if (!this.settled) fail('sideband_malformed_event');
          return;
        }
        if (event.type === 'provider_error') {
          if (
            this.speechDelivery === 'openai-native-webrtc-v1'
            && decoded.rawEvent !== null
            && decoded.rawWire !== null
            && this.routeNativeProviderEvent(decoded.rawEvent, decoded.rawWire)
          ) return;
          if (!this.settled) {
            fail('sideband_provider_error');
            return;
          }
          this.providerErrors += 1;
          this.onProviderError('provider_event_error');
          if (this.providerErrors >= MAX_PROVIDER_ERRORS) void this.close('kill_switch').catch(() => undefined);
        }
      });
      this.socket.on('error', () => {
        if (!this.settled) {
          fail('sideband_network_error');
          return;
        }
        if (!this.closed) {
          this.onProviderError('sideband_closed');
          void this.close('kill_switch').catch(() => undefined);
        }
      });
      this.socket.on('close', () => {
        this.providerSocketTerminated = true;
        if (!this.settled) {
          fail('sideband_closed_before_ready');
          return;
        }
        if (!this.closed) {
          this.onProviderError('sideband_closed');
          void this.close('kill_switch').catch(() => undefined);
          return;
        }
        this.finalize();
      });
    });
  }

  private routeNativeProviderEvent(
    rawEvent: Record<string, unknown>,
    rawWire: Buffer,
  ): boolean {
    const hint = providerResponseRouteHint(rawEvent);
    const byDelivery = hint.deliveryId === null
      ? null
      : this.nativeSpeechByDeliveryId.get(hint.deliveryId) ?? null;
    const byResponse = hint.responseId === null
      ? null
      : this.nativeSpeechByResponseId.get(hint.responseId) ?? null;
    if (byDelivery && byResponse && byDelivery !== byResponse) {
      this.rejectSecurity('unauthorized_response');
      return true;
    }
    const pending = byDelivery ?? byResponse ?? (
      rawEvent.type === 'error' ? this.currentNativeSpeech : null
    );
    if (!pending) return false;
    const handled = pending.dispatcher.handleWireEvent(rawWire);
    if (handled.status === 'fatal') return true;
    if (hint.responseId !== null) {
      if (pending.responseId !== null && pending.responseId !== hint.responseId) {
        this.rejectSecurity('unauthorized_response');
        return true;
      }
      pending.responseId = hint.responseId;
      this.nativeSpeechByResponseId.set(hint.responseId, pending);
    }
    if (rawEvent.type === 'response.done') {
      void pending.dispatcher.settled().catch(() => {
        this.hardFenceAndScheduleTermination('internal_error');
      });
    }
    return true;
  }

  contextChanged(revision: number, digest: string): void {
    if (!validContext(revision, digest)) return;
    if (revision <= this.highestContextRevision) return;
    this.highestContextRevision = revision;
    // Ferme la lecture et les contrôles sur l'ancien écran avant la première opération async.
    // Le microphone client doit déjà être fermé jusqu'à l'ACK, mais le serveur ne lui fait jamais
    // confiance pour empêcher un tour lancé dans la fenêtre de changement de contexte.
    this.contextTransitionPending = true;
    this.appliedContext = null;
    void this.interruptCurrentTurn('context_changed');
    const owner = this.owner;
    if (!owner || !this.isReady()) return;
    const generation = ++this.contextApplicationGeneration;
    void this.ownerPort.applyContext(owner, { revision, digest }).then((result) => {
      if (generation !== this.contextApplicationGeneration || this.closed || this.finalized) return;
      if (result.status !== 'applied') {
        this.onSecurityRejection('context_fence_rejected');
        void this.close('kill_switch').catch(() => undefined);
        return;
      }
      this.appliedContext = { revision, digest };
      this.contextTransitionPending = false;
      this.history = [];
    }, () => {
      if (generation !== this.contextApplicationGeneration || this.closed || this.finalized) return;
      this.onSecurityRejection('context_fence_rejected');
      void this.close('kill_switch').catch(() => undefined);
    });
  }

  speechDelivered(input: Omit<RealtimeSpeechDeliveryAcknowledgement, 'userId' | 'companyId' | 'sessionHandle'>): void {
    const pending = this.currentSpeech;
    if (
      !pending
      || pending.delivered
      || !UUID.test(input.acknowledgementId)
      || pending.artifactId !== input.artifactId
      || pending.turnId !== input.turnId
      || pending.context.revision !== input.contextRevision
      || pending.context.digest !== input.contextDigest
      || !this.contextMatches(input.contextRevision, input.contextDigest)
    ) return;
    pending.delivered = true;
    this.currentSpeech = null;
    this.pushHistory({ role: 'bob', text: pending.canonicalSpeech });
    this.metrics.bobLiveTurns.inc({ outcome: 'completed', kind: pending.kind });
    // L'autorité est désormais PostgreSQL. Le sideband ne conserve jamais une seconde capacité
    // locale après l'ACK : son rôle se limite à l'historique conversationnel et aux métriques.
    this.rejectControlTurn(pending.turnId);
  }

  async consumeAgentControl(input: {
    turnId: string;
    contextRevision: number;
    contextDigest: string;
    signal?: AbortSignal;
  }): Promise<RealtimeAgentControlConsumption> {
    if (!this.isReady() || input.signal?.aborted) return { status: 'unavailable' };
    if (!UUID.test(input.turnId) || !validContext(input.contextRevision, input.contextDigest)) {
      return { status: 'not_found' };
    }
    this.purgeExpiredControls();
    if (!this.contextMatches(input.contextRevision, input.contextDigest)) return { status: 'not_found' };
    if (this.settledControlTurns.has(input.turnId)) return { status: 'not_found' };
    const approved = this.approvedControls.get(input.turnId);
    if (approved) {
      this.approvedControls.delete(input.turnId);
      if (
        approved.control.contextRevision !== input.contextRevision
        || approved.control.contextDigest !== input.contextDigest
      ) {
        this.markControlTurnSettled(input.turnId);
        return { status: 'not_found' };
      }
      this.markControlTurnSettled(input.turnId);
      return { status: 'approved', control: approved.control };
    }
    const waiterCount = [...this.controlWaiters.values()].reduce((sum, waiters) => sum + waiters.size, 0);
    if (waiterCount >= MAX_CONTROL_WAITERS) return { status: 'unavailable' };
    return new Promise((resolve) => {
      const waiter: ControlWaiter = {
        contextRevision: input.contextRevision,
        contextDigest: input.contextDigest,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        resolve,
        timer: null,
        onAbort: null,
        settled: false,
      };
      const unavailable = (): void => this.settleControlWaiter(input.turnId, waiter, { status: 'unavailable' });
      waiter.onAbort = input.signal === undefined ? null : unavailable;
      const waiters = this.controlWaiters.get(input.turnId) ?? new Set<ControlWaiter>();
      waiters.add(waiter);
      this.controlWaiters.set(input.turnId, waiters);
      waiter.timer = setTimeout(() => {
        this.settleControlWaiter(input.turnId, waiter, { status: 'not_found' });
      }, CONTROL_ACK_WAIT_TIMEOUT_MS);
      input.signal?.addEventListener('abort', unavailable, { once: true });
      if (!this.isReady() || input.signal?.aborted || !this.contextMatches(input.contextRevision, input.contextDigest)) {
        unavailable();
      }
    });
  }

  async close(
    reason: 'user' | 'kill_switch' | 'superseded' | 'max_duration' | 'shutdown',
  ): Promise<RealtimeCallTerminationOutcome> {
    if (this.closed && !this.closing) return 'confirmed';
    if (this.closing) return this.closing;
    this.closing = this.terminate(reason).catch((error: unknown) => {
      this.onProviderError('hangup_failed');
      throw error;
    });
    return this.closing;
  }

  forceDispose(): void {
    if (this.finalized) return;
    this.providerIngressFenced = true;
    this.closed = true;
    this.turnAbort?.abort();
    this.currentSpeech?.controller.abort();
    if (this.owner) void this.ownerPort.release(this.owner).catch(() => undefined);
    try {
      this.socket.terminate();
      this.providerSocketTerminated = true;
    } catch { /* déjà fermée */ }
    this.finalize();
  }

  private failBootstrap(reject: (error: Error) => void, reason: string): void {
    if (this.settled) return;
    this.settled = true;
    if (this.bootstrapTimer) clearTimeout(this.bootstrapTimer);
    this.bootstrapTimer = null;
    this.startReject = null;
    try { this.socket.terminate(); } catch { /* déjà fermée */ }
    reject(new Error(reason));
  }

  private rejectSecurity(reason: Parameters<ManagedSidebandSession['onSecurityRejection']>[0]): void {
    this.onSecurityRejection(reason);
    if (this.speechDelivery === 'openai-native-webrtc-v1') {
      this.hardFenceAndScheduleTermination('protocol_violation');
      return;
    }
    void this.close('kill_switch').catch(() => undefined);
  }

  private async finishActivation(resolve: () => void, fail: (reason: string) => void): Promise<void> {
    try {
      await this.activateLease();
      const acquired = await this.ownerPort.acquire({
        companyId: this.principal.companyId,
        sessionId: this.sessionHandle,
        ownerInstanceHash: this.ownerInstanceHash,
        candidateOwnerTokenHash: this.ownerTokenHash,
        leaseSeconds: this.ownerLeaseSeconds,
      });
      if (acquired.status !== 'acquired') throw new Error(`sideband_owner_${acquired.status}`);
      this.owner = acquired.owner;
      if (acquired.currentContext) {
        const applied = await this.ownerPort.applyContext(acquired.owner, acquired.currentContext);
        if (applied.status !== 'applied') throw new Error(`sideband_context_${applied.status}`);
        this.appliedContext = acquired.currentContext;
        this.highestContextRevision = acquired.currentContext.revision;
      }
    } catch (error) {
      if (this.owner) await this.ownerPort.release(this.owner).catch(() => undefined);
      const reason = error instanceof Error && /^sideband_(owner|context)_[a-z_]+$/u.test(error.message)
        ? error.message
        : 'sideband_activation_failed';
      fail(reason);
      return;
    } finally {
      this.activationPending = false;
    }
    if (this.settled || this.closed || this.finalized) return;
    this.settled = true;
    this.ready = true;
    this.countedActive = true;
    if (this.bootstrapTimer) clearTimeout(this.bootstrapTimer);
    this.bootstrapTimer = null;
    this.startReject = null;
    this.onReady();
    this.scheduleOwnerRenewal();
    this.lifetimeTimer = setTimeout(() => {
      void this.close('max_duration').catch(() => undefined);
    }, this.maxSessionSeconds * 1_000);
    resolve();
  }

  private scheduleOwnerRenewal(): void {
    if (this.closed || this.finalized || !this.owner) return;
    this.ownerRenewTimer = setTimeout(() => {
      this.ownerRenewTimer = null;
      const owner = this.owner;
      if (!owner || this.closed || this.finalized) return;
      void this.ownerPort.renew(owner, this.ownerLeaseSeconds).then((result) => {
        if (this.closed || this.finalized) return;
        if (result.status !== 'renewed') {
          this.onProviderError('owner_lease_lost');
          void this.close('kill_switch').catch(() => undefined);
          return;
        }
        this.scheduleOwnerRenewal();
      }, () => {
        if (this.closed || this.finalized) return;
        this.onProviderError('owner_lease_lost');
        void this.close('kill_switch').catch(() => undefined);
      });
    }, this.ownerRenewSeconds * 1_000);
  }

  private async processTranscript(inputItemId: string, rawTranscript: string): Promise<void> {
    if (!this.rememberProcessedInput(inputItemId)) return;
    const transcript = rawTranscript
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim();
    if (!transcript || transcript.length > MAX_TRANSCRIPT_CHARS) {
      this.rejectSecurity('malformed_event');
      return;
    }
    this.turns += 1;
    if (this.turns > MAX_TURNS_PER_SESSION) {
      this.rejectSecurity('turn_budget_exceeded');
      return;
    }
    if (this.contextTransitionPending || !this.appliedContext) {
      this.onSecurityRejection('context_fence_rejected');
      return;
    }

    // Le ticket est pris avant le premier await : deux transcripts reçus dans le même tick ne
    // peuvent donc jamais lancer deux cerveaux avec des AbortSignal encore valides.
    const generation = ++this.turnGeneration;
    await this.interruptCurrentTurn('superseded', false);
    if (this.closed || this.finalized || generation !== this.turnGeneration) return;
    const controller = new AbortController();
    this.turnAbort = controller;
    const brainStartedAt = performance.now();
    let outcome: RealtimeAgentTurnOutcome;
    try {
      outcome = await this.runTurn({ transcript, history: [...this.history], signal: controller.signal });
    } catch {
      outcome = { status: 'failed', canonicalSpeech: 'Je rencontre un souci temporaire. Rien n’a été exécuté.' };
    }
    this.metrics.bobLiveBrainDuration.observe(
      { outcome: outcome.status },
      (performance.now() - brainStartedAt) / 1_000,
    );
    if (
      controller.signal.aborted
      || this.closed
      || this.finalized
      || generation !== this.turnGeneration
      || outcome.status === 'aborted'
    ) return;
    this.turnAbort = null;
    if (outcome.status === 'failed') this.onProviderError('turn_failed');
    this.pushHistory({ role: 'user', text: transcript });
    await this.publishOutcome(outcome, transcript, generation);
  }

  private async processTranscriptFailure(inputItemId: string): Promise<void> {
    if (
      !this.rememberProcessedInput(inputItemId)
      || this.contextTransitionPending
      || !this.appliedContext
    ) return;
    this.turns += 1;
    if (this.turns > MAX_TURNS_PER_SESSION) {
      this.rejectSecurity('turn_budget_exceeded');
      return;
    }
    const generation = ++this.turnGeneration;
    await this.interruptCurrentTurn('superseded', false);
    if (this.closed || this.finalized || generation !== this.turnGeneration) return;
    await this.publishOutcome({
      status: 'failed',
      canonicalSpeech: "Je n’ai pas bien entendu. Tu peux répéter en une phrase courte ?",
    }, '', generation);
  }

  private async publishOutcome(
    outcome: Exclude<RealtimeAgentTurnOutcome, { status: 'aborted' }>,
    userTranscript: string,
    generation: number,
  ): Promise<void> {
    const owner = this.owner;
    const context = speechContext(outcome, this.appliedContext);
    if (!owner || !context || this.closed || this.finalized || generation !== this.turnGeneration) {
      this.onSecurityRejection('context_fence_rejected');
      if (outcome.status === 'ready') this.rejectControlTurn(outcome.turnId);
      return;
    }
    const turnId = outcome.status === 'ready' ? outcome.turnId : randomUUID();
    if (!UUID.test(turnId)) {
      this.onSecurityRejection('context_fence_rejected');
      return;
    }
    if (this.speechDelivery === 'openai-native-webrtc-v1') {
      await this.publishNativeOutcome(outcome, userTranscript, generation, owner, context, turnId);
      return;
    }
    const audited = this.audited;
    if (!audited) {
      this.onProviderError('speech_publish_failed');
      void this.close('kill_switch').catch(() => undefined);
      return;
    }
    const controller = new AbortController();
    const pending: PendingSpeech = {
      generation,
      turnId,
      userTranscript,
      canonicalSpeech: outcome.canonicalSpeech,
      kind: outcome.status === 'ready' ? outcome.kind : 'failed',
      context,
      control: approvedControlFromOutcome(outcome),
      controller,
      artifactId: null,
      delivered: false,
    };
    this.currentSpeech = pending;
    const startedAt = performance.now();
    let published: RealtimeSpeechPublishOutcome;
    try {
      published = await audited.publisher.publish({
        companyId: owner.companyId,
        subjectHash: owner.subjectHash,
        sessionId: owner.sessionId,
        turnId,
        segmentIndex: 0,
        canonicalSpeech: outcome.canonicalSpeech,
        contextRevision: context.revision,
        contextDigest: context.digest,
        sidebandOwnerTokenHash: owner.ownerTokenHash,
        signal: controller.signal,
        abortReason: 'barge_in',
        revalidateContext: async (signal) => {
          signal.throwIfAborted();
          const current = await this.ownerPort.readCurrentContext(owner);
          signal.throwIfAborted();
          if (current.status !== 'current') throw new Error('sideband_context_unavailable');
          return { contextRevision: current.context.revision, contextDigest: current.context.digest };
        },
      });
    } catch {
      published = { status: 'unavailable', stage: 'finalize' };
    }
    this.metrics.bobLiveRenderDispatchDuration.observe(
      { outcome: published.status === 'ready' || published.status === 'already_ready' ? 'ok' : 'rejected' },
      (performance.now() - startedAt) / 1_000,
    );
    const stale = controller.signal.aborted
      || this.closed
      || this.finalized
      || generation !== this.turnGeneration
      || this.currentSpeech !== pending;
    if (published.status === 'ready' || published.status === 'already_ready') {
      pending.artifactId = published.artifactId;
      if (stale) {
        await this.cancelArtifact(pending, 'barge_in');
        return;
      }
      if (pending.control) {
        let sealed: Awaited<ReturnType<RealtimeDurableControlAuthority['issue']>>;
        try {
          sealed = await audited.controls.issue({
            companyId: owner.companyId,
            subjectHash: owner.subjectHash,
            sessionId: owner.sessionId,
            turnId: pending.turnId,
            artifactId: published.artifactId,
            contextRevision: pending.context.revision,
            contextDigest: pending.context.digest,
            sidebandOwnerEpoch: owner.ownerEpoch,
            sidebandOwnerTokenHash: owner.ownerTokenHash,
            kind: pending.control.kind,
            ...(pending.control.navigate === undefined
              ? {}
              : { navigate: pending.control.navigate }),
            ...(pending.control.proposalId === undefined
              ? {}
              : { proposalId: pending.control.proposalId }),
            ...(pending.control.proposalExpiresAt === undefined
              ? {}
              : { proposalExpiresAt: pending.control.proposalExpiresAt }),
          });
        } catch {
          sealed = { status: 'unavailable' };
        }
        if (sealed.status !== 'issued' && sealed.status !== 'already_issued') {
          if (this.currentSpeech === pending) this.currentSpeech = null;
          this.rejectControlTurn(pending.turnId);
          await this.cancelArtifact(pending, 'session_end');
          this.onProviderError('control_seal_failed');
          void this.close('kill_switch').catch(() => undefined);
          return;
        }
      }
      const becameStale = controller.signal.aborted
        || this.closed
        || this.finalized
        || generation !== this.turnGeneration
        || this.currentSpeech !== pending;
      if (becameStale) await this.cancelArtifact(pending, 'barge_in');
      return;
    }
    if (this.currentSpeech === pending) this.currentSpeech = null;
    if (pending.control) this.rejectControlTurn(pending.turnId);
    if (published.status !== 'aborted' && !stale) {
      this.onProviderError('speech_publish_failed');
      void this.close('kill_switch').catch(() => undefined);
    }
  }

  private async publishNativeOutcome(
    outcome: Exclude<RealtimeAgentTurnOutcome, { status: 'aborted' }>,
    userTranscript: string,
    generation: number,
    owner: RealtimeSidebandOwnerIdentity,
    context: RealtimeSidebandContextVersion,
    turnId: string,
  ): Promise<void> {
    const native = this.native;
    if (!native || outcome.status !== 'ready') {
      this.onProviderError('speech_publish_failed');
      void this.close('kill_switch').catch(() => undefined);
      return;
    }
    let prepared: Awaited<ReturnType<OpenAiNativeSpeechAuthority['prepareTurn']>>;
    try {
      prepared = await native.authority.prepareTurn({
        companyId: owner.companyId,
        subjectHmac: owner.subjectHash,
        sessionId: owner.sessionId,
        turnId,
        contextRevision: context.revision,
        contextDigest: context.digest,
        sidebandOwnerEpoch: owner.ownerEpoch,
        sidebandOwnerTokenHmac: owner.ownerTokenHash,
        canonicalSpeech: outcome.canonicalSpeech,
        model: this.session.model,
        voice: this.session.audio.output.voice,
        risk: {
          purpose: outcome.speechPurpose,
          source: outcome.speechSource,
          runKind: outcome.kind,
          hasTenantContext: outcome.hasTenantContext,
          hasControl: outcome.navigate !== undefined || outcome.proposalId !== undefined,
        },
      });
    } catch {
      prepared = { status: 'unavailable' };
    }
    const staleAfterPreparation = this.closed
      || this.finalized
      || generation !== this.turnGeneration
      || this.owner !== owner
      || !this.contextMatches(context.revision, context.digest);
    if (staleAfterPreparation) {
      if (prepared.status === 'prepared') {
        await this.cancelPreparedNativeTurn(native.authority, {
          companyId: owner.companyId,
          subjectHmac: owner.subjectHash,
          deliveryId: prepared.state.deliveryId,
          sessionId: owner.sessionId,
          turnId,
          contextRevision: context.revision,
          contextDigest: context.digest,
          sidebandOwnerEpoch: owner.ownerEpoch,
          sidebandOwnerTokenHmac: owner.ownerTokenHash,
        });
      }
      return;
    }
    if (prepared.status !== 'prepared') {
      // Le contrat v4 natif ne possède aucun fallback audité par tour. Une réponse sensible ou
      // improuvable reste donc silencieuse et termine la session jusqu'au protocole hybride v5.
      this.onProviderError('speech_publish_failed');
      void this.close('kill_switch').catch(() => undefined);
      return;
    }
    const binding = Object.freeze({
      companyId: owner.companyId,
      subjectHmac: owner.subjectHash,
      deliveryId: prepared.state.deliveryId,
      sessionId: owner.sessionId,
      turnId,
      contextRevision: context.revision,
      contextDigest: context.digest,
      sidebandOwnerEpoch: owner.ownerEpoch,
      sidebandOwnerTokenHmac: owner.ownerTokenHash,
    });
    let usage: OpenAiNativeResponseUsageAdapter;
    try {
      usage = new OpenAiNativeResponseUsageAdapter(native.usage, {
        companyId: owner.companyId,
        subjectHash: owner.subjectHash,
        subjectKeyVersion: this.subjectKeyVersion,
        sessionId: owner.sessionId,
        plan: this.plan,
        occurredAt: new Date(prepared.state.createdAtMs).toISOString(),
      });
    } catch {
      await this.cancelPreparedNativeTurn(native.authority, binding);
      this.onProviderError('speech_publish_failed');
      void this.close('kill_switch').catch(() => undefined);
      return;
    }
    const pendingRef: { current: PendingNativeSpeech | null } = { current: null };
    const callbacks: OpenAiNativeResponseDispatcherCallbacks = {
      onStreaming: ({ responseId }) => {
        const pending = pendingRef.current;
        if (!pending) return;
        if (this.nativeSpeechByDeliveryId.get(prepared.state.deliveryId) !== pending) return;
        pending.responseId = responseId;
        this.nativeSpeechByResponseId.set(responseId, pending);
      },
      onCompleted: () => {
        // `completed` est une preuve provider, pas une preuve acoustique. L'historique et les
        // contrôles restent fermés jusqu'au futur ACK mobile natif durable.
      },
      onCancelled: () => {
        const pending = pendingRef.current;
        if (!pending) return;
        if (this.currentNativeSpeech === pending) this.currentNativeSpeech = null;
      },
      onFatal: () => {
        const pending = pendingRef.current;
        if (!pending) return;
        if (this.currentNativeSpeech === pending) this.currentNativeSpeech = null;
        this.onProviderError('speech_publish_failed');
      },
    };
    const fence: OpenAiNativeResponseSessionFencePort = {
      fenceAndClose: ({ reason }) => this.hardFenceAndScheduleTermination(reason),
      emergencyRevokeAndTerminate: ({ reason }) => this.hardFenceAndScheduleTermination(reason),
    };
    const dispatcher = new OpenAiNativeResponseDispatcher(
      native.authority,
      this.socket,
      WebSocket.OPEN,
      usage,
      fence,
      callbacks,
    );
    const pending: PendingNativeSpeech = {
      generation,
      deliveryId: prepared.state.deliveryId,
      turnId,
      userTranscript,
      canonicalSpeech: outcome.canonicalSpeech,
      kind: outcome.kind,
      context,
      dispatcher,
      responseId: null,
    };
    pendingRef.current = pending;
    this.currentNativeSpeech = pending;
    this.nativeSpeechByDeliveryId.set(pending.deliveryId, pending);
    const startedAt = performance.now();
    const started = await dispatcher.start({ prepared, binding });
    this.metrics.bobLiveRenderDispatchDuration.observe(
      { outcome: started.status === 'started' ? 'ok' : 'rejected' },
      (performance.now() - startedAt) / 1_000,
    );
    const stale = this.closed
      || this.finalized
      || generation !== this.turnGeneration
      || this.currentNativeSpeech !== pending;
    if (started.status === 'started' && !stale) return;
    if (this.currentNativeSpeech === pending) this.currentNativeSpeech = null;
    if (started.status === 'started') {
      await dispatcher.interruptForServerOrigin(
        'superseded',
        (command) => this.sendNativeCancelAndClear(command),
      );
      return;
    }
    if (started.status !== 'fatal') {
      this.onProviderError('speech_publish_failed');
      void this.close('kill_switch').catch(() => undefined);
    }
  }

  private async cancelPreparedNativeTurn(
    authority: OpenAiNativeSpeechAuthority,
    binding: OpenAiNativeSpeechAuthorityBinding,
  ): Promise<void> {
    let cancellationId: string;
    try {
      cancellationId = this.cancellationId().toLowerCase();
    } catch {
      this.hardFenceAndScheduleTermination('internal_error');
      return;
    }
    if (!UUID.test(cancellationId)) {
      this.hardFenceAndScheduleTermination('internal_error');
      return;
    }
    const cancelled = await boundedCleanup(authority.cancel({
      ...binding,
      cancellationId,
      reason: 'superseded',
    }), this.timeoutMs);
    if (cancelled?.status === 'applied' || cancelled?.status === 'idempotent') return;
    this.hardFenceAndScheduleTermination('cancellation_failed');
  }

  private async interruptCurrentTurn(
    reason: RealtimeSpeechCancellationReason,
    invalidateGeneration = true,
  ): Promise<void> {
    const wasThinking = this.turnAbort !== null;
    const speech = this.currentSpeech;
    const nativeSpeech = this.currentNativeSpeech;
    this.invalidateUnconsumedControls();
    if (invalidateGeneration) this.turnGeneration += 1;
    this.turnAbort?.abort();
    this.turnAbort = null;
    if (wasThinking) this.metrics.bobLiveTurns.inc({ outcome: 'interrupted', kind: 'thinking' });
    const pending: Promise<unknown>[] = [];
    if (speech) {
      this.currentSpeech = null;
      speech.controller.abort();
      this.rejectControlTurn(speech.turnId);
      this.metrics.bobLiveTurns.inc({ outcome: 'interrupted', kind: speech.kind });
      if (speech.artifactId) pending.push(this.cancelArtifact(speech, reason));
    }
    if (nativeSpeech) {
      this.currentNativeSpeech = null;
      this.metrics.bobLiveTurns.inc({ outcome: 'interrupted', kind: nativeSpeech.kind });
      if (reason === 'barge_in' || reason === 'user_cancel') {
        pending.push(nativeSpeech.dispatcher.markMobileInterruption(
          reason === 'barge_in' ? 'user_speech' : 'tap',
        ));
      } else if (
        reason === 'context_changed'
        || reason === 'superseded'
        || reason === 'session_end'
      ) {
        pending.push(nativeSpeech.dispatcher.interruptForServerOrigin(
          reason,
          (command) => this.sendNativeCancelAndClear(command),
        ));
      }
    }
    const previousCleanup = this.turnCleanup;
    const cleanup = Promise.allSettled([previousCleanup, ...pending]).then(() => undefined);
    this.turnCleanup = cleanup;
    await cleanup;
  }

  private async cancelArtifact(
    speech: PendingSpeech,
    reason: RealtimeSpeechCancellationReason,
  ): Promise<void> {
    if (!speech.artifactId || !this.owner) return;
    const id = this.cancellationId();
    if (!UUID.test(id)) {
      this.onProviderError('speech_cancel_failed');
      void this.close('kill_switch').catch(() => undefined);
      return;
    }
    const cancellation = this.audited?.cancellation;
    if (!cancellation) {
      this.onProviderError('speech_cancel_failed');
      void this.close('kill_switch').catch(() => undefined);
      return;
    }
    const result = await boundedCleanup(
      cancellation.cancel({
        companyId: this.owner.companyId,
        subjectHash: this.owner.subjectHash,
        sessionId: this.owner.sessionId,
        turnId: speech.turnId,
        artifactId: speech.artifactId,
        cancellationId: id,
        reason,
      }),
      this.timeoutMs,
    );
    if (result?.status === 'cancelled' || result?.status === 'terminal') return;
    this.onProviderError('speech_cancel_failed');
    void this.close('kill_switch').catch(() => undefined);
  }

  private async sendNativeCancelAndClear(
    command: OpenAiNativeServerCancelAndClearCommand,
  ): Promise<OpenAiNativeServerCancelAndClearResult> {
    if (
      !command.closeIfAmbiguous
      || this.providerIngressFenced
      || this.socket.readyState !== WebSocket.OPEN
    ) return { status: 'ambiguous' };
    for (const event of command.events) {
      const sent = await new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (value: boolean): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        };
        const timer = setTimeout(() => finish(false), this.timeoutMs);
        try {
          this.socket.send(JSON.stringify(event), (error) => finish(error === undefined));
        } catch {
          finish(false);
        }
      });
      if (!sent) return { status: 'ambiguous' };
    }
    return { status: 'sent' };
  }

  private hardFenceAndScheduleTermination(
    _reason: Exclude<OpenAiNativeResponseFatalReason, 'session_fence_failed'>,
  ): ReturnType<OpenAiNativeResponseSessionFencePort['fenceAndClose']> {
    this.providerIngressFenced = true;
    this.turnAbort?.abort();
    this.turnAbort = null;
    this.currentNativeSpeech = null;
    let socketFenced = this.providerSocketTerminated || this.socket.readyState === WebSocket.CLOSED;
    if (!socketFenced) {
      try {
        this.socket.terminate();
        socketFenced = true;
      } catch {
        socketFenced = false;
      }
    }
    this.providerSocketTerminated = socketFenced;
    void this.close('kill_switch').catch(() => undefined);
    return socketFenced
      ? { status: this.closed || this.finalized ? 'already_closed' : 'applied' }
      : { status: 'failed' };
  }

  private async terminate(
    reason: 'user' | 'kill_switch' | 'superseded' | 'max_duration' | 'shutdown',
  ): Promise<RealtimeCallTerminationOutcome> {
    this.closed = true;
    this.contextApplicationGeneration += 1;
    await this.interruptCurrentTurn(cancellationReasonForClose(reason));
    const owner = this.owner;
    this.owner = null;
    if (owner) await this.ownerPort.release(owner).catch(() => undefined);
    let outcome: RealtimeCallTerminationOutcome = 'pending_reaper';
    try {
      outcome = await this.terminateCall(reason);
    } finally {
      if (this.socket.readyState === WebSocket.OPEN) {
        try { this.socket.close(1000, `bob_${reason}`); } catch { /* déjà fermée */ }
      } else {
        try { this.socket.terminate(); } catch { /* déjà fermée */ }
      }
      this.finalize();
    }
    return outcome;
  }

  private contextMatches(revision: number, digest: string): boolean {
    return this.appliedContext?.revision === revision && this.appliedContext.digest === digest;
  }

  private markControlTurnSettled(turnId: string): void {
    if (!UUID.test(turnId)) return;
    if (this.settledControlTurns.size >= MAX_CONTROL_TURNS) {
      const oldest = this.settledControlTurns.values().next().value as string | undefined;
      if (oldest) this.settledControlTurns.delete(oldest);
    }
    this.settledControlTurns.add(turnId);
  }

  private purgeExpiredControls(now = Date.now()): void {
    for (const [turnId, entry] of this.approvedControls) {
      if (entry.expiresAt > now) continue;
      this.approvedControls.delete(turnId);
      this.markControlTurnSettled(turnId);
    }
  }

  private settleControlWaiter(
    turnId: string,
    waiter: ControlWaiter,
    outcome: RealtimeAgentControlConsumption,
  ): void {
    if (waiter.settled) return;
    waiter.settled = true;
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.timer = null;
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
    waiter.onAbort = null;
    const waiters = this.controlWaiters.get(turnId);
    waiters?.delete(waiter);
    if (waiters?.size === 0) this.controlWaiters.delete(turnId);
    waiter.resolve(outcome);
  }

  private settleAllControlWaiters(status: 'not_found' | 'unavailable'): void {
    for (const [turnId, waiters] of [...this.controlWaiters]) {
      for (const waiter of [...waiters]) this.settleControlWaiter(turnId, waiter, { status });
    }
  }

  private rejectControlTurn(turnId: string): void {
    if (!UUID.test(turnId)) return;
    this.approvedControls.delete(turnId);
    this.markControlTurnSettled(turnId);
    const waiters = this.controlWaiters.get(turnId);
    if (!waiters) return;
    for (const waiter of [...waiters]) this.settleControlWaiter(turnId, waiter, { status: 'not_found' });
  }

  private invalidateUnconsumedControls(): void {
    for (const turnId of this.approvedControls.keys()) this.markControlTurnSettled(turnId);
    this.approvedControls.clear();
    this.settleAllControlWaiters('not_found');
    for (const controller of this.controlValidationControllers) controller.abort();
    this.controlValidationControllers.clear();
  }

  private publishApprovedControl(control: RealtimeApprovedAgentControl): void {
    this.purgeExpiredControls();
    const now = Date.now();
    const proposalExpiresAt = control.proposalExpiresAt ? Date.parse(control.proposalExpiresAt) : null;
    if (
      !this.isReady()
      || this.settledControlTurns.has(control.turnId)
      || !this.contextMatches(control.contextRevision, control.contextDigest)
      || (proposalExpiresAt !== null && proposalExpiresAt <= now)
    ) {
      this.rejectControlTurn(control.turnId);
      return;
    }
    const waiters = this.controlWaiters.get(control.turnId);
    const winner = waiters && [...waiters].find((waiter) => (
      !waiter.signal?.aborted
      && waiter.contextRevision === control.contextRevision
      && waiter.contextDigest === control.contextDigest
    ));
    if (!winner) {
      this.approvedControls.set(control.turnId, {
        control,
        expiresAt: Math.min(now + CONTROL_APPROVAL_TTL_MS, proposalExpiresAt ?? Number.POSITIVE_INFINITY),
      });
      return;
    }
    this.markControlTurnSettled(control.turnId);
    this.settleControlWaiter(control.turnId, winner, { status: 'approved', control });
    const remaining = this.controlWaiters.get(control.turnId);
    if (remaining) {
      for (const waiter of [...remaining]) this.settleControlWaiter(control.turnId, waiter, { status: 'not_found' });
    }
  }

  private async approveControlIfCurrent(control: RealtimeApprovedAgentControl): Promise<void> {
    if (!this.contextMatches(control.contextRevision, control.contextDigest)) {
      this.rejectControlTurn(control.turnId);
      return;
    }
    const controller = new AbortController();
    this.controlValidationControllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), CONTROL_CONTEXT_REVALIDATION_TIMEOUT_MS);
    let current = false;
    try {
      current = await this.isControlContextCurrent({
        version: 1,
        revision: control.contextRevision,
        digest: control.contextDigest,
      }, controller.signal);
    } catch {
      current = false;
    } finally {
      clearTimeout(timeout);
      this.controlValidationControllers.delete(controller);
    }
    if (!current || controller.signal.aborted || !this.isReady() || !this.contextMatches(control.contextRevision, control.contextDigest)) {
      this.rejectControlTurn(control.turnId);
      return;
    }
    this.publishApprovedControl(control);
  }

  private rememberInputItem(itemId: string): boolean {
    if (this.seenInputItems.has(itemId)) return false;
    if (this.seenInputItems.size >= MAX_SEEN_INPUT_ITEMS) {
      const oldest = this.seenInputItems.values().next().value as string | undefined;
      if (oldest) this.seenInputItems.delete(oldest);
    }
    this.seenInputItems.add(itemId);
    return true;
  }

  private rememberProcessedInput(itemId: string): boolean {
    if (this.processedInputItems.has(itemId)) return false;
    if (this.processedInputItems.size >= MAX_SEEN_INPUT_ITEMS) {
      const oldest = this.processedInputItems.values().next().value as string | undefined;
      if (oldest) this.processedInputItems.delete(oldest);
    }
    this.processedInputItems.add(itemId);
    return true;
  }

  private pushHistory(turn: AgentHistoryTurn): void {
    this.history = [...this.history, turn].slice(-6);
  }

  private finalize(): void {
    if (this.finalized) return;
    this.finalized = true;
    if (!this.settled && this.startReject) {
      this.settled = true;
      this.startReject(new Error('sideband_closed_before_ready'));
    }
    this.startReject = null;
    const wasCountedActive = this.countedActive;
    this.ready = false;
    this.countedActive = false;
    this.closed = true;
    if (this.bootstrapTimer) clearTimeout(this.bootstrapTimer);
    if (this.lifetimeTimer) clearTimeout(this.lifetimeTimer);
    if (this.ownerRenewTimer) clearTimeout(this.ownerRenewTimer);
    this.bootstrapTimer = null;
    this.lifetimeTimer = null;
    this.ownerRenewTimer = null;
    this.turnGeneration += 1;
    this.contextApplicationGeneration += 1;
    this.turnAbort?.abort();
    this.turnAbort = null;
    this.currentSpeech?.controller.abort();
    this.currentSpeech = null;
    this.currentNativeSpeech = null;
    this.nativeSpeechByDeliveryId.clear();
    this.nativeSpeechByResponseId.clear();
    this.owner = null;
    this.appliedContext = null;
    this.contextTransitionPending = false;
    for (const controller of this.controlValidationControllers) controller.abort();
    this.controlValidationControllers.clear();
    this.approvedControls.clear();
    this.settledControlTurns.clear();
    this.settleAllControlWaiters('unavailable');
    this.seenInputItems.clear();
    this.processedInputItems.clear();
    this.history = [];
    this.onClosed(wasCountedActive);
  }
}

/**
 * Contrôle sideband exclusivement serveur avec une seule autorité acoustique par session.
 * En mode audité, toute sortie fournisseur reste interdite et la parole vient de l’artefact privé.
 * En mode natif, seul le dispatcher corrélé peut créer et accepter la réponse OpenAI ; toute autre
 * sortie déclenche le kill-switch. Aucun des deux chemins ne peut retomber implicitement sur l’autre.
 */
export class RealtimeSidebandManager implements RealtimeSidebandControl, OnApplicationShutdown {
  private readonly sessionsByPrincipal = new Map<string, ManagedSidebandSession>();
  private readonly generationsByPrincipal = new Map<string, number>();
  private readonly instanceHash = tokenHash(randomBytes(32).toString('base64url'));
  private readonly entropy: NonNullable<RealtimeSidebandSpeechDependencies['entropy']>;
  private shuttingDown = false;

  constructor(
    private readonly settings: RealtimeVoiceSettings,
    private readonly callProvider: OpenAiRealtimeCallProvider,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
    private readonly socketFactory: RealtimeSidebandSocketFactory = (url, options) => new WebSocket(url, options),
    private readonly speech?: RealtimeSidebandSpeechDependencies,
  ) {
    this.entropy = speech?.entropy ?? {
      ownerToken: () => randomBytes(32).toString('base64url'),
      cancellationId: randomUUID,
    };
  }

  async attach(input: RealtimeSidebandAttachInput): Promise<void> {
    if (!this.settings.apiKey) throw new Error('sideband_not_configured');
    if (!this.speech || !input.sessionHandle || !UUID.test(input.sessionHandle)) {
      throw new Error('sideband_speech_not_configured');
    }
    if (
      !sessionMatchesSpeechDelivery(input.session, input.speechDelivery)
      || !PLAN_TIERS.has(input.plan)
      || !Number.isSafeInteger(input.subjectKeyVersion)
      || input.subjectKeyVersion < 1
      || input.subjectKeyVersion > 2_147_483_647
      || (
        input.speechDelivery === 'audited-signed-url-v1'
          ? this.speech.audited === undefined
          : this.speech.native === undefined
            || typeof this.speech.native.usage.recordBatch !== 'function'
      )
    ) throw new Error('sideband_speech_not_configured');
    if (this.shuttingDown) throw new Error('sideband_closed_before_ready');
    const ownerToken = this.entropy.ownerToken();
    if (ownerToken.length < 32 || ownerToken.length > 128) throw new Error('sideband_owner_entropy_invalid');
    const socket = this.socketFactory(websocketUrl(this.settings.baseUrl, input.callId), {
      headers: { Authorization: `Bearer ${this.settings.apiKey}` },
      handshakeTimeout: this.settings.sidebandTimeoutMs,
      maxPayload: MAX_SIDEBAND_EVENT_BYTES,
      perMessageDeflate: false,
    });
    const key = principalKey(input);
    const previous = this.sessionsByPrincipal.get(key);
    const generation = (this.generationsByPrincipal.get(key) ?? 0) + 1;
    this.generationsByPrincipal.set(key, generation);
    const ownerLeaseSeconds = Math.min(300, Math.max(5, this.settings.heartbeatSeconds * 3));
    const managed = new ManagedSidebandSession(
      { userId: input.userId, companyId: input.companyId },
      input.sessionHandle.toLowerCase(),
      socket,
      input.session,
      input.speechDelivery,
      input.plan,
      input.subjectKeyVersion,
      this.settings.sidebandTimeoutMs,
      this.settings.maxSessionSeconds,
      ownerLeaseSeconds,
      Math.max(1, Math.min(this.settings.heartbeatSeconds, ownerLeaseSeconds - 1)),
      this.instanceHash,
      tokenHash(ownerToken),
      this.speech.owner,
      this.speech.audited ?? null,
      this.speech.native ?? null,
      this.entropy.cancellationId,
      () => input.lifecycle?.activate() ?? Promise.resolve(),
      (reason) => input.lifecycle?.terminate(reason)
        ?? this.callProvider.hangupCall(input.callId).then(() => 'confirmed' as const),
      (turn) => input.turn?.run(turn) ?? Promise.resolve({
        status: 'failed' as const,
        canonicalSpeech: 'Bob Live n’est pas encore relié au moteur métier.',
      }),
      (context, signal) => input.controlContext?.isCurrent(context, signal) ?? Promise.resolve(false),
      this.metrics,
      (reason) => {
        this.metrics.bobLiveSecurityRejections.inc({ reason });
        this.logger.warn(`bob.live.security.rejected reason=${reason}`, 'BobLive');
      },
      (reason) => {
        this.metrics.bobLiveProviderErrors.inc({ class: `sideband_${reason}` });
        this.logger.warn(`bob.live.provider.error class=sideband_${reason}`, 'BobLive');
      },
      () => this.metrics.bobLiveSessionsActive.inc({ transport: 'webrtc' }),
      (wasCountedActive) => {
        if (this.sessionsByPrincipal.get(key) === managed) {
          this.sessionsByPrincipal.delete(key);
          if (this.generationsByPrincipal.get(key) === generation) this.generationsByPrincipal.delete(key);
        }
        if (wasCountedActive) this.metrics.bobLiveSessionsActive.dec({ transport: 'webrtc' });
      },
    );
    this.sessionsByPrincipal.set(key, managed);
    try {
      await Promise.all([managed.start(), previous?.close('superseded') ?? Promise.resolve()]);
      if (
        this.shuttingDown
        || this.sessionsByPrincipal.get(key) !== managed
        || this.generationsByPrincipal.get(key) !== generation
        || !managed.isReady()
      ) throw new Error('sideband_superseded');
      this.metrics.bobLiveSidebandConnections.inc({ outcome: 'ok' });
      this.logger.audit('bob.live.sideband.ready', {
        transport: 'webrtc',
        output: input.speechDelivery === 'openai-native-webrtc-v1'
          ? 'openai_native_provider_stream'
          : 'audited_private_artifact',
      });
    } catch (error) {
      await managed.close('kill_switch').catch(() => undefined);
      managed.forceDispose();
      if (this.sessionsByPrincipal.get(key) === managed) this.sessionsByPrincipal.delete(key);
      this.metrics.bobLiveSidebandConnections.inc({ outcome: 'failed' });
      const errorClass = error instanceof Error && /^sideband_[a-z_]+$/u.test(error.message)
        ? error.message
        : 'sideband_unknown';
      throw new Error(errorClass);
    }
  }

  contextChanged(input: {
    userId: string;
    companyId: string;
    sessionHandle: string;
    revision: number;
    digest: string;
  }): void {
    const session = this.sessionsByPrincipal.get(principalKey(input));
    if (!session || session.sessionHandle !== input.sessionHandle.toLowerCase()) return;
    session.contextChanged(input.revision, input.digest);
  }

  speechDelivered(input: RealtimeSpeechDeliveryAcknowledgement): void {
    const session = this.sessionsByPrincipal.get(principalKey(input));
    if (!session || session.sessionHandle !== input.sessionHandle.toLowerCase()) return;
    session.speechDelivered(input);
  }

  async consumeAgentControl(input: {
    userId: string;
    companyId: string;
    sessionHandle: string;
    turnId: string;
    contextRevision: number;
    contextDigest: string;
    signal?: AbortSignal;
  }): Promise<RealtimeAgentControlConsumption> {
    const session = this.sessionsByPrincipal.get(principalKey(input));
    if (!session || session.sessionHandle !== input.sessionHandle.toLowerCase()) return { status: 'not_found' };
    return session.consumeAgentControl({
      turnId: input.turnId,
      contextRevision: input.contextRevision,
      contextDigest: input.contextDigest,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }

  async closeForPrincipal(
    input: { userId: string; companyId: string },
    reason: 'user' | 'kill_switch',
  ): Promise<void> {
    await this.sessionsByPrincipal.get(principalKey(input))?.close(reason);
  }

  async closeSession(input: {
    userId: string;
    companyId: string;
    sessionHandle: string;
  }): Promise<'not_found' | RealtimeCallTerminationOutcome> {
    const session = this.sessionsByPrincipal.get(principalKey(input));
    if (!session || session.sessionHandle !== input.sessionHandle.toLowerCase()) return 'not_found';
    return session.close('user');
  }

  async onApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;
    const sessions = [...this.sessionsByPrincipal.values()];
    await Promise.all(sessions.map(async (session) => {
      try {
        await session.close('shutdown');
      } catch {
        session.forceDispose();
      }
    }));
    this.sessionsByPrincipal.clear();
    this.generationsByPrincipal.clear();
  }
}
