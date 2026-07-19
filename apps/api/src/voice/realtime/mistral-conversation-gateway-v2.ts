import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
  INITIAL_MISTRAL_CONVERSATION_MISSION_STATE,
  MISTRAL_CONVERSATION_AUDIO_QUANTUM_BYTES,
  MISTRAL_CONVERSATION_MAX_AUDIO_FRAME_BYTES,
  MISTRAL_CONVERSATION_MAX_CLIENT_CONTROL_BYTES,
  MISTRAL_CONVERSATION_MAX_MISSION_AUDIO_BYTES,
  MISTRAL_CONVERSATION_MAX_PRE_ROLL_MS,
  MISTRAL_CONVERSATION_MAX_SERVER_EVENT_BYTES,
  MISTRAL_CONVERSATION_MAX_TURN_AUDIO_MS,
  MISTRAL_CONVERSATION_PROTOCOL,
  MistralConversationProtocolError,
  createMistralConversationTurnState,
  decodeMistralConversationAudioFrame,
  decodeMistralConversationClientControl,
  encodeMistralConversationServerEvent,
  reduceMistralConversationMissionState,
  reduceMistralConversationTurnState,
  type MistralConversationAudioFrame,
  type MistralConversationCancelReason,
  type MistralConversationClientControl,
  type MistralConversationMissionState,
  type MistralConversationRouteMode,
  type MistralConversationServerErrorCode,
  type MistralConversationServerEvent,
  type MistralConversationSessionEndReason,
  type MistralConversationTurnPhaseEvent,
  type MistralConversationTurnState,
} from '@bob/ai';
import {
  MISTRAL_CONVERSATION_TERMINAL_ACK_RESERVE_MS,
  isMistralConversationConnectionLeaseToken,
  isMistralConversationReplayConnectionId,
  isMistralConversationResumeTicket,
  type MistralConversationRedeemAndOpenResult,
  type MistralConversationResumeAuthority,
} from './mistral-conversation-resume-ticket';
import type {
  MistralConversationAdmissionAuthority,
  MistralConversationAdmissionOwner,
} from './mistral-conversation-admission';
import { validateMistralConversationAdmissionPolicy } from './mistral-conversation-admission';

const MAX_INGRESS_MESSAGES = 256;
const MAX_INGRESS_BYTES = 128 * 1024;
const MAX_PROVIDER_AUDIO_MESSAGES = 128;
const MAX_PROVIDER_AUDIO_BYTES = 128 * 1024;
const MAX_DOWNLINK_BUFFERED_BYTES = 256 * 1024;
const MAX_OPEN_REPLAY_EVENTS = 256;
const MAX_OPEN_REPLAY_BYTES = MAX_DOWNLINK_BUFFERED_BYTES
  - MISTRAL_CONVERSATION_MAX_SERVER_EVENT_BYTES;
const TERMINAL_EVENT_RESERVE = 3;
const MAX_LIVE_UNACKED_EVENTS = MAX_OPEN_REPLAY_EVENTS - TERMINAL_EVENT_RESERVE;
const MAX_LIVE_UNACKED_BYTES = MAX_OPEN_REPLAY_BYTES
  - TERMINAL_EVENT_RESERVE * MISTRAL_CONVERSATION_MAX_SERVER_EVENT_BYTES;
const MAX_SESSION_MS = 15 * 60 * 1_000;
const DEFAULT_AUTH_TIMEOUT_MS = 5_000;
const DEFAULT_PROVIDER_CLOSE_TIMEOUT_MS = 1_500;
const DEFAULT_OPERATION_TIMEOUT_MS = 5_000;
const DEFAULT_REPLAY_TIMEOUT_MS = 10_000;
const MAX_TERMINAL_ACK_CAPABILITY_MS = 30_000;
// L'autorité SQL impose au plus 30 s. Le gateway tolère uniquement le faible skew NTP
// d'une base distante et le soustrait ensuite de tous ses budgets ; il ne prolonge donc
// jamais une capability au-delà de l'horloge PostgreSQL qui l'a créée.
const MAX_SERVER_CLOCK_SKEW_MS = 1_000;
const DEFAULT_PIPELINE_TIMEOUT_MS = 30_000;
const DEFAULT_PROVIDER_RESPONSE_TIMEOUT_MS = 45_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 2_000;
const MAX_PROVIDER_CLOSE_TIMEOUT_MS = 5_000;
const MAX_AUTH_TIMEOUT_MS = 10_000;
const MAX_OPERATION_TIMEOUT_MS = 60_000;
const MAX_REPLAY_TIMEOUT_MS = 30_000;
const MAX_REPLAY_GRACE_MS = 7 * 24 * 60 * 60 * 1_000;
const MIN_TIMEOUT_MS = 25;
const INT32_MAX = 0x7fff_ffff;
const UINT32_MAX = 0xffff_ffff;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const TENANT_ID = /^[A-Za-z0-9-]{1,64}$/u;
const OPAQUE_ID = /^[A-Za-z0-9_-]{16,128}$/u;
const OWNER_TOKEN = /^[A-Za-z0-9_-]{32,128}$/u;
const COMMAND_ID = /^[A-Za-z0-9:_.-]{1,200}$/u;
const PLANS = new Set(['free', 'solo', 'pro', 'business']);

type SocketData = string | Uint8Array | ArrayBuffer;

export type MistralConversationGatewayV2ErrorCode =
  | 'auth_timeout'
  | 'authentication_failed'
  | 'temporarily_unavailable'
  | 'protocol_error'
  | 'sequence_error'
  | 'audio_budget_exceeded'
  | 'backpressure'
  | 'replay_window_exhausted'
  | 'context_stale'
  | 'route_uncertified'
  | 'invalid_state'
  | 'provider_error'
  | 'expired'
  | 'aborted';

export class MistralConversationGatewayV2Error extends Error {
  constructor(readonly code: MistralConversationGatewayV2ErrorCode) {
    super(code);
    this.name = 'MistralConversationGatewayV2Error';
  }
}

export interface MistralConversationGatewayV2Socket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  on(event: 'message', listener: (data: SocketData, isBinary: boolean) => void): this;
  on(event: 'close', listener: (code: number) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  off(event: 'message', listener: (data: SocketData, isBinary: boolean) => void): this;
  off(event: 'close', listener: (code: number) => void): this;
  off(event: 'error', listener: (error: Error) => void): this;
  send(data: string, callback?: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

export interface MistralConversationBootstrapGrant {
  readonly bootstrapId: string;
  /** UUID durable du bail d'admission ayant autorisé cette mission. */
  readonly admissionSessionId: string;
  readonly companyId: string;
  readonly subjectHash: string;
  readonly subjectKeyVersion: number;
  readonly plan: 'free' | 'solo' | 'pro' | 'business';
  readonly sessionHandle: string;
  readonly hardExpiresAt: string;
  readonly contextRevision: number;
  readonly contextDigest: string;
  readonly routeMode: MistralConversationRouteMode;
  readonly fullDuplexCertified: boolean;
  readonly maxMissionAudioBytes: number;
}

export interface MistralConversationDurableSnapshot {
  readonly version: number;
  readonly missionConnectionEpoch: number;
  /** Curseur cumulatif attesté par le dernier owner après application locale. */
  readonly acknowledgedServerSequence: number;
  readonly nextServerSequence: number;
  readonly nextProviderSequence: number;
  readonly mission: MistralConversationMissionState;
  readonly turn: MistralConversationTurnState | null;
  readonly finalTranscriptRecorded: boolean;
}

export type MistralConversationDurableCommand =
  | {
      readonly type: 'start_turn';
      readonly commandId: string;
      readonly control: Extract<MistralConversationClientControl, { readonly type: 'turn.start' }>;
      readonly turnId: string;
      /** Toujours fourni ; utilisé seulement si le start devient un barge-in atomique. */
      readonly bargeInCancellationId: string;
    }
  | {
      readonly type: 'ingest_audio';
      readonly commandId: string;
      readonly frame: Omit<MistralConversationAudioFrame, 'pcm'> & {
        readonly audioBytes: number;
        readonly audioSha256: string;
      };
    }
  | {
      readonly type: 'commit_turn';
      readonly commandId: string;
      readonly control: Extract<MistralConversationClientControl, { readonly type: 'turn.commit' }>;
    }
  | {
      readonly type: 'cancel_turn';
      readonly commandId: string;
      readonly control: Extract<MistralConversationClientControl, { readonly type: 'turn.cancel' }>;
    }
  | {
      readonly type: 'fail_turn';
      readonly commandId: string;
      readonly turnId: string;
      readonly cancellationId: string;
      readonly reason: Extract<
        MistralConversationCancelReason,
        'context_changed' | 'route_lost' | 'network_backpressure' | 'timeout'
      >;
      readonly errorCode: Extract<
        MistralConversationServerErrorCode,
        'backpressure' | 'context_stale' | 'temporarily_unavailable' | 'internal_error'
      >;
    }
  | {
      readonly type: 'record_transcript';
      readonly commandId: string;
      readonly turnId: string;
      readonly providerSequence: number;
      readonly text: string;
      readonly final: boolean;
    }
  | {
      readonly type: 'advance_phase';
      readonly commandId: string;
      readonly turnId: string;
      readonly phase: Extract<MistralConversationTurnPhaseEvent, 'reasoning' | 'rendering' | 'delivering'>;
    }
  | {
      readonly type: 'complete_turn';
      readonly commandId: string;
      readonly turnId: string;
      readonly missionConnectionEpoch: number;
      readonly cancellationGeneration: number;
      readonly authorizationHandle: string;
      /** Artefact privé ; l'adapter l'ouvre à la livraison dans la transaction de completion. */
      readonly stagedDeliveryHandle: string;
    }
  | {
      readonly type: 'update_context';
      readonly commandId: string;
      readonly control: Extract<MistralConversationClientControl, { readonly type: 'context.update' }>;
    }
  | {
      readonly type: 'ack_events';
      readonly commandId: string;
      readonly control: Extract<MistralConversationClientControl, { readonly type: 'events.ack' }>;
    }
  | {
      readonly type: 'record_error';
      readonly commandId: string;
      readonly errorCode: MistralConversationServerErrorCode;
      readonly retryable: boolean;
    }
  | {
      readonly type: 'drain';
      readonly commandId: string;
      readonly reason: MistralConversationSessionEndReason;
      readonly cancellationId: string;
    }
  | {
      readonly type: 'close';
      readonly commandId: string;
    };

export type MistralConversationTransitionRejection =
  | 'invalid_state'
  | 'sequence_error'
  | 'audio_budget_exceeded'
  | 'context_stale'
  | 'route_uncertified'
  | 'replay_window_exhausted';

export type MistralConversationDurableTransitionResult =
  | {
      readonly status: 'applied' | 'replayed';
      readonly snapshot: MistralConversationDurableSnapshot;
      /** Événements déjà persistés/outboxés dans la même transaction que le snapshot. */
      readonly events: readonly MistralConversationServerEvent[];
    }
  | {
      readonly status: 'conflict';
      readonly snapshot: MistralConversationDurableSnapshot;
    }
  | { readonly status: 'rejected'; readonly reason: MistralConversationTransitionRejection }
  | { readonly status: 'not_owner' | 'expired' | 'not_found' | 'unavailable' };

export interface MistralConversationRecoveryCancellation {
  readonly clientTurnId: string;
  readonly turnId: string;
  readonly ordinal: number;
  readonly cancellationId: string;
  readonly cancellationGeneration: number;
}

export interface MistralConversationRecoveryMetadata {
  readonly fromServerSequence: number;
  readonly previousMissionConnectionEpoch: number;
  readonly previousCancellationGeneration: number;
  readonly cancellation: MistralConversationRecoveryCancellation | null;
}

interface MistralConversationReplayEnvelope {
  readonly snapshot: MistralConversationDurableSnapshot;
  readonly replayFromServerSequence: number;
  readonly events: readonly MistralConversationServerEvent[];
}

export type MistralConversationDurableOpenResult =
  | (MistralConversationReplayEnvelope & {
      readonly status: 'opened';
      readonly recovery: null;
      readonly terminal: null;
    })
  | (MistralConversationReplayEnvelope & {
      readonly status: 'recovered' | 'replayed';
      readonly recovery: MistralConversationRecoveryMetadata;
      readonly terminal: null;
    })
  | (MistralConversationReplayEnvelope & {
      readonly status: 'terminal_replay';
      readonly recovery: null;
      readonly terminal: {
        readonly missionConnectionEpoch: number;
        readonly closedAtServerSequence: number;
        readonly reason: MistralConversationSessionEndReason;
        /** Borne BDD de lecture/ACK terminal ; elle ne prolonge jamais une capacité live. */
        readonly replayGraceExpiresAt: string;
      };
    })
  | {
      readonly status:
        | 'conflict'
        | 'expired'
        | 'invalid_cursor'
        | 'history_unavailable'
        | 'unavailable';
    };

export type MistralConversationBootstrapOpenResult =
  | (Extract<MistralConversationDurableOpenResult, { readonly status: 'opened' }> & {
      readonly grant: MistralConversationBootstrapGrant;
    })
  | {
      readonly status:
        | 'invalid'
        | 'expired'
        | 'replayed'
        | 'invalid_cursor'
        | 'history_unavailable'
        | 'aborted'
        | 'unavailable';
    };

/**
 * Autorité atomique du ticket WSS initial. Elle possède la transaction PostgreSQL racine et
 * consomme le ticket uniquement dans le même commit que Mission + outbox `session.ready`.
 */
export interface MistralConversationBootstrapAuthority {
  redeemAndOpenInitial(input: {
    readonly companyId: string;
    readonly ticket: string;
    readonly protocol: typeof MISTRAL_CONVERSATION_PROTOCOL;
    readonly ownerLeaseToken: string;
    readonly resumeNextServerSequence: number;
    readonly maxReplayEvents: number;
    readonly maxReplayBytes: number;
    readonly signal: AbortSignal;
  }): Promise<MistralConversationBootstrapOpenResult>;
}

/**
 * Autorité obligatoire pour chaque succès. L'adapter doit :
 * - CASer `version` + `missionConnectionEpoch` + `ownerLeaseToken` ;
 * - exécuter `reduceMistralConversationDurableSnapshot` dans la transaction ;
 * - dédupliquer durablement `commandId` avec empreinte du payload ;
 * - persister état et événements/outbox avant de répondre `applied` ;
 * - pour `complete_turn`, revalider `authorizationHandle` et ouvrir le staged delivery uniquement
 *   dans cette même transaction.
 * `open` doit créer la mission ou effectuer un takeover CAS via
 * `recoverMistralConversationDurableSession`, refuser transactionnellement tout grant expiré ou
 * curseur en avance, puis relire sans trou l'outbox depuis
 * `min(resumeNextServerSequence, acknowledgedServerSequence)`. L'outbox est immuable et conservée
 * pendant toute la mission plus sa période de grâce ; aucun PCM brut n'est repris/persisté.
 */
export interface MistralConversationDurableAuthority {
  open(input: {
    readonly grant: MistralConversationBootstrapGrant;
    readonly ownerLeaseToken: string;
    readonly resumeNextServerSequence: number;
    /** Bornes à appliquer dans la requête outbox, avant toute matérialisation en mémoire. */
    readonly maxReplayEvents: number;
    readonly maxReplayBytes: number;
    readonly signal: AbortSignal;
  }): Promise<MistralConversationDurableOpenResult>;

  transition(input: {
    readonly companyId: string;
    readonly subjectHash: string;
    readonly sessionHandle: string;
    readonly missionConnectionEpoch: number;
    readonly ownerLeaseToken: string;
    readonly expectedVersion: number;
    readonly maxUnacknowledgedEvents: number;
    readonly maxUnacknowledgedBytes: number;
    readonly command: MistralConversationDurableCommand;
    readonly signal: AbortSignal;
  }): Promise<MistralConversationDurableTransitionResult>;
}

export type MistralConversationContextAuthorizationResult =
  | {
      readonly status: 'authorized';
      readonly authorizationHandle: string;
      readonly plan: MistralConversationBootstrapGrant['plan'];
    }
  | { readonly status: 'stale' | 'forbidden' | 'unavailable' };

/**
 * Le digest client n'est jamais une autorisation. Ce port doit résoudre le contexte canonique,
 * les droits tenant/subject et les entitlements au moment de chaque décision sensible.
 */
export interface MistralConversationContextAuthority {
  authorize(input: {
    readonly companyId: string;
    readonly subjectHash: string;
    readonly subjectKeyVersion: number;
    readonly sessionHandle: string;
    readonly action: 'start_turn' | 'update_context' | 'reason';
    readonly contextRevision: number;
    readonly contextDigest: string;
    readonly signal: AbortSignal;
  }): Promise<MistralConversationContextAuthorizationResult>;
}

export type MistralConversationProviderEvent =
  | {
      readonly type: 'transcript_delta';
      readonly providerSequence: number;
      readonly text: string;
    }
  | {
      readonly type: 'transcript_final';
      readonly providerSequence: number;
      readonly text: string;
    }
  | {
      readonly type: 'provider_error';
      readonly providerSequence: number;
    };

export interface MistralConversationProviderConnection {
  sendAudio(pcm: Uint8Array, input: { readonly signal: AbortSignal }): Promise<void>;
  commitAudio(input: { readonly signal: AbortSignal }): Promise<void>;
  events(): AsyncIterable<MistralConversationProviderEvent>;
  close(input: { readonly signal: AbortSignal }): Promise<void>;
}

/** Une nouvelle connexion Voxtral est créée pour chaque utterance, jamais pour la mission entière. */
export interface MistralConversationProvider {
  openTurn(input: {
    readonly sessionHandle: string;
    readonly turnId: string;
    readonly maxAudioMs: number;
    readonly signal: AbortSignal;
  }): Promise<MistralConversationProviderConnection>;
}

export interface MistralConversationReasoningHandle {
  readonly handle: string;
}

export interface MistralConversationAuditedHandle {
  readonly handle: string;
}

export interface MistralConversationDeliveryHandle {
  readonly handle: string;
}

interface MistralConversationPipelineIdentity {
  readonly companyId: string;
  readonly subjectHash: string;
  readonly subjectKeyVersion: number;
  readonly plan: MistralConversationBootstrapGrant['plan'];
  readonly sessionHandle: string;
  readonly turnId: string;
  readonly clientTurnId: string;
  readonly contextRevision: number;
  readonly contextDigest: string;
  readonly missionConnectionEpoch: number;
  readonly cancellationGeneration: number;
  readonly authorizationHandle: string;
  readonly signal: AbortSignal;
}

/**
 * Pipeline en trois fences. Le gateway avance durablement la phase avant chaque méthode.
 * `auditAndRender` réalise l'audit TTS→ASR. `stageDelivery` stocke un artefact privé et
 * non échangeable. Seule l'autorité durable peut l'ouvrir, atomiquement avec `complete_turn`.
 */
export interface MistralConversationBobAuditPipeline {
  reason(input: MistralConversationPipelineIdentity & {
    readonly transcript: string;
  }): Promise<MistralConversationReasoningHandle>;

  auditAndRender(input: MistralConversationPipelineIdentity & {
    readonly reasoning: MistralConversationReasoningHandle;
  }): Promise<MistralConversationAuditedHandle>;

  stageDelivery(input: MistralConversationPipelineIdentity & {
    readonly audited: MistralConversationAuditedHandle;
  }): Promise<MistralConversationDeliveryHandle>;
}

export interface MistralConversationGatewayV2Entropy {
  ownerLeaseToken(): string;
}

export interface MistralConversationGatewayV2Dependencies {
  readonly bootstrap: MistralConversationBootstrapAuthority;
  /**
   * Port atomique des seules capacités `r2_`. Optionnel tant que le runtime v2 reste dormant ;
   * son absence refuse ces tickets sans jamais retomber sur le bootstrap historique.
   */
  readonly resume?: MistralConversationResumeAuthority;
  readonly authority: MistralConversationDurableAuthority;
  readonly context: MistralConversationContextAuthority;
  readonly provider: MistralConversationProvider;
  readonly pipeline: MistralConversationBobAuditPipeline;
  /** Obligatoire pour tout owner live ; absent uniquement sur un runtime de replay terminal pur. */
  readonly admission?: MistralConversationAdmissionAuthority;
  readonly entropy?: MistralConversationGatewayV2Entropy;
  readonly now?: () => number;
  readonly authTimeoutMs?: number;
  readonly providerCloseTimeoutMs?: number;
  readonly operationTimeoutMs?: number;
  readonly replayTimeoutMs?: number;
  readonly pipelineTimeoutMs?: number;
  readonly providerResponseTimeoutMs?: number;
  readonly cleanupTimeoutMs?: number;
}

type ServerEventWithoutSequence = MistralConversationServerEvent extends infer Event
  ? Event extends { readonly serverSequence: number }
    ? Omit<Event, 'serverSequence'>
    : never
  : never;

function gatewayError(code: MistralConversationGatewayV2ErrorCode): never {
  throw new MistralConversationGatewayV2Error(code);
}

function isIntegerBetween(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && !Object.is(value, -0)
    && value >= minimum
    && value <= maximum;
}

function canonicalEpoch(value: string): number | null {
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) return null;
  try {
    return new Date(epoch).toISOString() === value ? epoch : null;
  } catch {
    return null;
  }
}

function validateGrantBinding(
  grant: MistralConversationBootstrapGrant,
  companyId: string,
): number {
  const hardExpiry = canonicalEpoch(grant.hardExpiresAt);
  if (
    !UUID.test(grant.bootstrapId)
    || !UUID.test(grant.admissionSessionId)
    || !TENANT_ID.test(grant.companyId)
    || grant.companyId !== companyId
    || !SHA256.test(grant.subjectHash)
    || !isIntegerBetween(grant.subjectKeyVersion, 1, INT32_MAX)
    || !PLANS.has(grant.plan)
    || !OPAQUE_ID.test(grant.sessionHandle)
    || !isIntegerBetween(grant.contextRevision, 1, INT32_MAX)
    || !SHA256.test(grant.contextDigest)
    || !(
      (grant.routeMode === 'push_to_talk' && typeof grant.fullDuplexCertified === 'boolean')
      || (grant.routeMode === 'full_duplex' && grant.fullDuplexCertified)
    )
    || hardExpiry === null
    || !isIntegerBetween(
      grant.maxMissionAudioBytes,
      MISTRAL_CONVERSATION_AUDIO_QUANTUM_BYTES,
      MISTRAL_CONVERSATION_MAX_MISSION_AUDIO_BYTES,
    )
    || grant.maxMissionAudioBytes % MISTRAL_CONVERSATION_AUDIO_QUANTUM_BYTES !== 0
  ) gatewayError('temporarily_unavailable');
  return hardExpiry;
}

function validateGrant(grant: MistralConversationBootstrapGrant, companyId: string, now: number): number {
  const hardExpiry = validateGrantBinding(grant, companyId);
  // Le bootstrap générique reste strictement live. Seul le résultat discriminé de l'autorité de
  // reprise peut ouvrir la fenêtre H..G ; ne jamais élargir cette capacité ici.
  if (
    hardExpiry <= now
    || hardExpiry > now + MAX_SESSION_MS + MAX_SERVER_CLOCK_SKEW_MS
  ) {
    gatewayError('temporarily_unavailable');
  }
  return hardExpiry;
}

function defaultEntropy(): MistralConversationGatewayV2Entropy {
  return {
    ownerLeaseToken: () => randomBytes(32).toString('base64url'),
  };
}

function validateEntropyValue(value: string, pattern: RegExp): string {
  if (!pattern.test(value)) gatewayError('temporarily_unavailable');
  return value;
}

function validateSnapshot(snapshot: MistralConversationDurableSnapshot): void {
  const mission = snapshot.mission;
  const validMissionPhase = mission.phase === 'ready'
    || mission.phase === 'turn_active'
    || mission.phase === 'response_active'
    || mission.phase === 'recovering_route'
    || mission.phase === 'draining'
    || mission.phase === 'closed';
  const routeConsistent = (
    mission.routeMode === 'push_to_talk' && typeof mission.fullDuplexCertified === 'boolean'
  ) || (
    mission.routeMode === 'full_duplex' && mission.fullDuplexCertified
  );
  if (
    !isIntegerBetween(snapshot.version, 1, Number.MAX_SAFE_INTEGER)
    || !isIntegerBetween(snapshot.missionConnectionEpoch, 1, INT32_MAX)
    || snapshot.missionConnectionEpoch !== mission.missionConnectionEpoch
    || !isIntegerBetween(snapshot.acknowledgedServerSequence, 0, UINT32_MAX + 1)
    || !isIntegerBetween(snapshot.nextServerSequence, 0, UINT32_MAX + 1)
    || snapshot.acknowledgedServerSequence > snapshot.nextServerSequence
    || !isIntegerBetween(snapshot.nextProviderSequence, 0, UINT32_MAX + 1)
    || !OPAQUE_ID.test(mission.sessionHandle ?? '')
    || canonicalEpoch(mission.expiresAt ?? '') === null
    || !isIntegerBetween(mission.contextRevision, 1, INT32_MAX)
    || !SHA256.test(mission.contextDigest ?? '')
    || !routeConsistent
    || !isIntegerBetween(mission.lastTurnOrdinal, 0, UINT32_MAX)
    || !isIntegerBetween(mission.nextAudioSequence, 0, UINT32_MAX + 1)
    || !isIntegerBetween(
      mission.maxMissionAudioBytes,
      MISTRAL_CONVERSATION_AUDIO_QUANTUM_BYTES,
      MISTRAL_CONVERSATION_MAX_MISSION_AUDIO_BYTES,
    )
    || mission.maxMissionAudioBytes % MISTRAL_CONVERSATION_AUDIO_QUANTUM_BYTES !== 0
    || !isIntegerBetween(mission.audioBytes, 0, mission.maxMissionAudioBytes)
    || mission.audioBytes % MISTRAL_CONVERSATION_AUDIO_QUANTUM_BYTES !== 0
    || !isIntegerBetween(mission.cancellationGeneration, 0, UINT32_MAX)
    || !validMissionPhase
    || (
      mission.lastVadTimestampMs !== null
      && !isIntegerBetween(mission.lastVadTimestampMs, 0, Number.MAX_SAFE_INTEGER)
    )
    || (mission.lastCancellationId !== null && !UUID.test(mission.lastCancellationId))
    || (mission.routeRecoveryCancellationId !== null && !UUID.test(mission.routeRecoveryCancellationId))
    || (mission.drainCancellationId !== null && !UUID.test(mission.drainCancellationId))
  ) gatewayError('temporarily_unavailable');
  const missionHasTurn = mission.activeTurn !== null;
  const phaseHasTurn = mission.phase === 'turn_active' || mission.phase === 'response_active';
  if (missionHasTurn !== phaseHasTurn) gatewayError('temporarily_unavailable');
  const phaseIsTerminal = mission.phase === 'draining' || mission.phase === 'closed';
  if (phaseIsTerminal !== (mission.drainReason !== null)) gatewayError('temporarily_unavailable');
  if (missionHasTurn !== (snapshot.turn !== null)) gatewayError('temporarily_unavailable');
  if (snapshot.turn && mission.activeTurn) {
    if (
      snapshot.turn.turnId !== mission.activeTurn.turnId
      || snapshot.turn.clientTurnId !== mission.activeTurn.clientTurnId
      || snapshot.turn.ordinal !== mission.activeTurn.ordinal
      || snapshot.turn.contextRevision !== mission.activeTurn.contextRevision
      || snapshot.turn.contextDigest !== mission.activeTurn.contextDigest
      || snapshot.turn.cancellationGeneration !== mission.activeTurn.cancellationGeneration
      || snapshot.turn.nextAudioSequence !== mission.nextAudioSequence
      || !OPAQUE_ID.test(snapshot.turn.turnId ?? '')
      || !UUID.test(snapshot.turn.clientTurnId)
      || !isIntegerBetween(snapshot.turn.ordinal, 1, UINT32_MAX)
      || !isIntegerBetween(snapshot.turn.audioBytes, 0, mission.audioBytes)
    ) gatewayError('temporarily_unavailable');
  }
  if (!snapshot.turn && snapshot.nextProviderSequence !== 0) gatewayError('temporarily_unavailable');
  if (snapshot.finalTranscriptRecorded && snapshot.turn === null) {
    gatewayError('temporarily_unavailable');
  }
  if (
    snapshot.turn
    && snapshot.turn.phase !== 'transcribing'
    && snapshot.turn.phase !== 'reasoning'
    && snapshot.turn.phase !== 'rendering'
    && snapshot.turn.phase !== 'delivering'
    && snapshot.finalTranscriptRecorded
  ) gatewayError('temporarily_unavailable');
}

/**
 * Décodeur fail-closed destiné aux adapters durables. PostgreSQL restitue un JSONB comme
 * `unknown` : aucun cast infra ne doit pouvoir contourner les invariants du réducteur.
 */
export function parseMistralConversationDurableSnapshot(
  value: unknown,
): MistralConversationDurableSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    gatewayError('temporarily_unavailable');
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.mission !== 'object'
    || candidate.mission === null
    || Array.isArray(candidate.mission)
    || !(
      candidate.turn === null
      || (
        typeof candidate.turn === 'object'
        && candidate.turn !== null
        && !Array.isArray(candidate.turn)
      )
    )
  ) {
    gatewayError('temporarily_unavailable');
  }
  const snapshot = value as MistralConversationDurableSnapshot;
  validateSnapshot(snapshot);
  return snapshot;
}

function validateOpenResult(
  opened: Extract<MistralConversationDurableOpenResult, {
    readonly status: 'opened' | 'recovered' | 'replayed';
  }>,
  grant: MistralConversationBootstrapGrant,
  resumeNextServerSequence: number,
): void {
  validateSnapshot(opened.snapshot);
  const { mission } = opened.snapshot;
  const expectedReplayFrom = Math.min(
    resumeNextServerSequence,
    opened.snapshot.acknowledgedServerSequence,
  );
  if (
    mission.sessionHandle !== grant.sessionHandle
    || mission.contextRevision !== grant.contextRevision
    || mission.contextDigest !== grant.contextDigest
    || mission.expiresAt !== grant.hardExpiresAt
    || mission.routeMode !== grant.routeMode
    || mission.fullDuplexCertified !== grant.fullDuplexCertified
    || mission.maxMissionAudioBytes !== grant.maxMissionAudioBytes
    || mission.phase !== 'ready'
    || mission.activeTurn !== null
    || opened.snapshot.turn !== null
    || opened.events.length === 0
    || opened.events.length > MAX_OPEN_REPLAY_EVENTS
    || !isIntegerBetween(resumeNextServerSequence, 0, UINT32_MAX + 1)
    || opened.replayFromServerSequence !== expectedReplayFrom
    || opened.terminal !== null
  ) gatewayError('temporarily_unavailable');
  let replayBytes = 0;
  for (let index = 0; index < opened.events.length; index += 1) {
    const event = opened.events[index];
    if (!event) gatewayError('temporarily_unavailable');
    replayBytes += Buffer.byteLength(encodeMistralConversationServerEvent(event), 'utf8');
    if (replayBytes > MAX_OPEN_REPLAY_BYTES) gatewayError('temporarily_unavailable');
    if (index > 0 && event.serverSequence !== (opened.events[index - 1]?.serverSequence ?? -2) + 1) {
      gatewayError('temporarily_unavailable');
    }
  }
  const first = opened.events[0];
  const last = opened.events[opened.events.length - 1];
  if (
    !first
    || !last
    || first.serverSequence !== opened.replayFromServerSequence
    || last.serverSequence !== opened.snapshot.nextServerSequence - 1
    || ((opened.replayFromServerSequence === 0) !== (first.type === 'session.ready'))
  ) {
    gatewayError('temporarily_unavailable');
  }

  for (let index = 0; index < opened.events.length; index += 1) {
    const event = opened.events[index];
    if (event?.type !== 'session.ready') continue;
    if (
      index !== 0
      || event.serverSequence !== 0
      || event.sessionHandle !== grant.sessionHandle
      || event.expiresAt !== grant.hardExpiresAt
      || event.maxMissionAudioBytes !== grant.maxMissionAudioBytes
      || event.nextAudioSequence !== 0
    ) gatewayError('temporarily_unavailable');
  }

  if (opened.status === 'opened') {
    if (
      opened.recovery !== null
      || opened.replayFromServerSequence !== 0
      || resumeNextServerSequence !== 0
      || opened.snapshot.acknowledgedServerSequence !== 0
      || opened.snapshot.version !== 1
      || opened.snapshot.missionConnectionEpoch !== 1
      || opened.snapshot.nextServerSequence !== 1
      || opened.snapshot.nextProviderSequence !== 0
      || opened.snapshot.finalTranscriptRecorded
      || mission.lastTurnOrdinal !== 0
      || mission.nextAudioSequence !== 0
      || mission.audioBytes !== 0
      || mission.cancellationGeneration !== 0
      || mission.lastTerminalTurn !== null
      || mission.lastCancellationId !== null
      || mission.routeRecoveryCancellationId !== null
      || mission.drainCancellationId !== null
      || mission.drainReason !== null
      || opened.events.length !== 1
      || first.type !== 'session.ready'
      || first.missionConnectionEpoch !== opened.snapshot.missionConnectionEpoch
      || first.contextRevision !== grant.contextRevision
      || first.contextDigest !== grant.contextDigest
      || first.routeMode !== grant.routeMode
      || first.fullDuplexCertified !== grant.fullDuplexCertified
    ) gatewayError('temporarily_unavailable');
    return;
  }

  const recovery = opened.recovery;
  if (!recovery) gatewayError('temporarily_unavailable');
  const recoveryFrom = recovery.fromServerSequence;
  if (
    !isIntegerBetween(recovery.previousMissionConnectionEpoch, 1, INT32_MAX - 1)
    || !isIntegerBetween(recovery.previousCancellationGeneration, 0, UINT32_MAX)
  ) gatewayError('temporarily_unavailable');
  const expectedCancellationGeneration = recovery.previousCancellationGeneration
    + (recovery.cancellation ? 1 : 0);
  if (
    !isIntegerBetween(recoveryFrom, 1, UINT32_MAX)
    || resumeNextServerSequence > recoveryFrom
    || opened.snapshot.acknowledgedServerSequence > recoveryFrom
    || recoveryFrom < opened.replayFromServerSequence
    || recovery.previousMissionConnectionEpoch + 1 !== opened.snapshot.missionConnectionEpoch
    || expectedCancellationGeneration > UINT32_MAX
    || mission.cancellationGeneration !== expectedCancellationGeneration
    || mission.routeRecoveryCancellationId !== null
    || mission.drainCancellationId !== null
    || mission.drainReason !== null
  ) gatewayError('temporarily_unavailable');
  const recoveryIndex = recoveryFrom - opened.replayFromServerSequence;
  const recovering = opened.events[recoveryIndex];
  const maybeCancellation = opened.events[recoveryIndex + 1];
  const hasCancellation = maybeCancellation?.type === 'turn.cancelled';
  const declaredCancellation = recovery.cancellation;
  const recovered = opened.events[recoveryIndex + (hasCancellation ? 2 : 1)];
  if (
    recovering?.type !== 'session.route_recovering'
    || recovered?.type !== 'session.route_recovered'
    || recovered !== last
    || recovering.cancellationGeneration !== expectedCancellationGeneration
    || ((declaredCancellation !== null) !== hasCancellation)
    || (
      hasCancellation
      && (
        declaredCancellation === null
        || maybeCancellation.cancellationGeneration !== recovering.cancellationGeneration
        || declaredCancellation.clientTurnId !== maybeCancellation.clientTurnId
        || declaredCancellation.turnId !== maybeCancellation.turnId
        || declaredCancellation.ordinal !== maybeCancellation.ordinal
        || declaredCancellation.cancellationId !== maybeCancellation.cancellationId
        || declaredCancellation.cancellationGeneration !== maybeCancellation.cancellationGeneration
        || mission.lastTerminalTurn?.outcome !== 'cancelled'
        || mission.lastTerminalTurn.clientTurnId !== maybeCancellation.clientTurnId
        || mission.lastTerminalTurn.turnId !== maybeCancellation.turnId
        || mission.lastTerminalTurn.ordinal !== maybeCancellation.ordinal
        || mission.lastTerminalTurn.cancellationId !== maybeCancellation.cancellationId
        || mission.lastCancellationId !== maybeCancellation.cancellationId
      )
    )
    || recovered.missionConnectionEpoch !== opened.snapshot.missionConnectionEpoch
    || recovered.routeMode !== grant.routeMode
    || recovered.fullDuplexCertified !== grant.fullDuplexCertified
  ) gatewayError('temporarily_unavailable');
}

/**
 * Dernière fence avant le CAS one-shot initial. L'autorité PostgreSQL l'appelle avec son horloge
 * autoritative, dans la même transaction que Mission + outbox + activation admission.
 */
export function isMistralConversationInitialCommitCandidate(input: {
  readonly opened: Extract<MistralConversationDurableOpenResult, { readonly status: 'opened' }>;
  readonly grant: MistralConversationBootstrapGrant;
  readonly companyId: string;
  readonly resumeNextServerSequence: number;
  readonly databaseNow: number;
}): boolean {
  try {
    const hardExpiry = validateGrantBinding(input.grant, input.companyId);
    if (
      !Number.isFinite(input.databaseNow)
      || hardExpiry <= input.databaseNow
      || hardExpiry > input.databaseNow + MAX_SESSION_MS
    ) return false;
    validateOpenResult(input.opened, input.grant, input.resumeNextServerSequence);
    return true;
  } catch {
    return false;
  }
}

function validateTerminalOpenResult(
  opened: Extract<MistralConversationDurableOpenResult, { readonly status: 'terminal_replay' }>,
  grant: MistralConversationBootstrapGrant,
  resumeNextServerSequence: number,
): void {
  validateSnapshot(opened.snapshot);
  const { mission } = opened.snapshot;
  const hardExpiry = canonicalEpoch(grant.hardExpiresAt);
  const replayGraceExpiry = canonicalEpoch(opened.terminal?.replayGraceExpiresAt ?? '');
  const expectedReplayFrom = Math.min(
    resumeNextServerSequence,
    opened.snapshot.acknowledgedServerSequence,
  );
  if (
    opened.recovery !== null
    || !opened.terminal
    || mission.sessionHandle !== grant.sessionHandle
    || mission.contextRevision !== grant.contextRevision
    || mission.contextDigest !== grant.contextDigest
    || mission.expiresAt !== grant.hardExpiresAt
    || mission.routeMode !== grant.routeMode
    || mission.fullDuplexCertified !== grant.fullDuplexCertified
    || mission.maxMissionAudioBytes !== grant.maxMissionAudioBytes
    || mission.phase !== 'closed'
    || mission.activeTurn !== null
    || mission.routeRecoveryCancellationId !== null
    || mission.drainReason === null
    || opened.snapshot.turn !== null
    || opened.snapshot.nextProviderSequence !== 0
    || opened.snapshot.finalTranscriptRecorded
    || !isIntegerBetween(resumeNextServerSequence, 0, UINT32_MAX + 1)
    || resumeNextServerSequence > opened.snapshot.nextServerSequence
    || opened.snapshot.nextServerSequence < 3
    || opened.snapshot.version < 3
    || opened.replayFromServerSequence !== expectedReplayFrom
    || opened.replayFromServerSequence > opened.snapshot.nextServerSequence
    || opened.events.length > MAX_OPEN_REPLAY_EVENTS
    || opened.terminal.missionConnectionEpoch !== opened.snapshot.missionConnectionEpoch
    || opened.terminal.closedAtServerSequence < 2
    || opened.terminal.closedAtServerSequence !== opened.snapshot.nextServerSequence - 1
    || opened.terminal.reason !== mission.drainReason
    || hardExpiry === null
    || replayGraceExpiry === null
    || replayGraceExpiry <= hardExpiry
    || replayGraceExpiry > hardExpiry + MAX_REPLAY_GRACE_MS
  ) gatewayError('temporarily_unavailable');

  if (opened.events.length === 0) {
    if (opened.replayFromServerSequence !== opened.snapshot.nextServerSequence) {
      gatewayError('temporarily_unavailable');
    }
    return;
  }

  let replayBytes = 0;
  for (let index = 0; index < opened.events.length; index += 1) {
    const event = opened.events[index];
    if (!event) gatewayError('temporarily_unavailable');
    replayBytes += Buffer.byteLength(encodeMistralConversationServerEvent(event), 'utf8');
    if (replayBytes > MAX_OPEN_REPLAY_BYTES) gatewayError('temporarily_unavailable');
    if (event.serverSequence !== opened.replayFromServerSequence + index) {
      gatewayError('temporarily_unavailable');
    }
    if (event.type === 'session.ready') {
      if (
        index !== 0
        || event.serverSequence !== 0
        || event.sessionHandle !== grant.sessionHandle
        || event.expiresAt !== grant.hardExpiresAt
        || event.maxMissionAudioBytes !== grant.maxMissionAudioBytes
      ) gatewayError('temporarily_unavailable');
    }
    if (event.type === 'session.closed' && index !== opened.events.length - 1) {
      gatewayError('temporarily_unavailable');
    }
  }
  const first = opened.events[0];
  const last = opened.events.at(-1);
  const terminalPredecessor = opened.events.at(-2);
  if (
    !first
    || !last
    || ((opened.replayFromServerSequence === 0) !== (first.type === 'session.ready'))
    || last.serverSequence !== opened.snapshot.nextServerSequence - 1
    || last.type !== 'session.closed'
    || last.reason !== opened.terminal.reason
    || (
      terminalPredecessor !== undefined
      && (
        terminalPredecessor.type !== 'session.draining'
        || terminalPredecessor.reason !== opened.terminal.reason
      )
    )
  ) gatewayError('temporarily_unavailable');
}

function nextServerEvent(
  cursor: { value: number },
  event: ServerEventWithoutSequence,
): MistralConversationServerEvent {
  if (cursor.value > UINT32_MAX) gatewayError('temporarily_unavailable');
  const sequenced = { ...event, serverSequence: cursor.value } as MistralConversationServerEvent;
  // Réutilise le codec gelé : aucune construction wire parallèle dans le gateway.
  encodeMistralConversationServerEvent(sequenced);
  cursor.value += 1;
  return sequenced;
}

function finishTransition(
  snapshot: MistralConversationDurableSnapshot,
  input: {
    readonly mission: MistralConversationMissionState;
    readonly turn: MistralConversationTurnState | null;
    readonly finalTranscriptRecorded: boolean;
    readonly nextProviderSequence: number;
    readonly acknowledgedServerSequence: number;
    readonly events: readonly MistralConversationServerEvent[];
    readonly nextServerSequence: number;
  },
): { readonly snapshot: MistralConversationDurableSnapshot; readonly events: readonly MistralConversationServerEvent[] } {
  const terminalEventReserve = input.mission.phase === 'closed'
    ? 0
    : input.mission.phase === 'draining'
      ? 1
      : input.turn
        ? 3
        : 2;
  const terminalVersionReserve = input.mission.phase === 'closed'
    ? 0
    : input.mission.phase === 'draining'
      ? 1
      : 2;
  // Toute mutation non terminale doit laisser assez de séquences pour annuler le tour éventuel,
  // annoncer le drain puis fermer. Une mission ne peut donc jamais devenir irréparable au wrap.
  if (input.nextServerSequence > UINT32_MAX + 1 - terminalEventReserve) {
    gatewayError('temporarily_unavailable');
  }
  const nextVersion = snapshot.version + 1;
  if (
    !Number.isSafeInteger(nextVersion)
    || nextVersion > Number.MAX_SAFE_INTEGER - terminalVersionReserve
  ) gatewayError('temporarily_unavailable');
  const next: MistralConversationDurableSnapshot = {
    version: nextVersion,
    missionConnectionEpoch: snapshot.missionConnectionEpoch,
    acknowledgedServerSequence: input.acknowledgedServerSequence,
    nextServerSequence: input.nextServerSequence,
    nextProviderSequence: input.nextProviderSequence,
    mission: input.mission,
    turn: input.turn,
    finalTranscriptRecorded: input.finalTranscriptRecorded,
  };
  validateSnapshot(next);
  return { snapshot: next, events: input.events };
}

function turnCorrelation(snapshot: MistralConversationDurableSnapshot): {
  readonly clientTurnId: string;
  readonly turnId: string;
  readonly ordinal: number;
} {
  const turn = snapshot.mission.activeTurn;
  if (!turn) gatewayError('invalid_state');
  return { clientTurnId: turn.clientTurnId, turnId: turn.turnId, ordinal: turn.ordinal };
}

/**
 * Réducteur transactionnel de référence pour l'adapter durable. Il ne réalise aucune I/O et
 * applique les deux machines @bob/ai dans la même valeur immuable.
 */
export function reduceMistralConversationDurableSnapshot(
  snapshot: MistralConversationDurableSnapshot,
  command: MistralConversationDurableCommand,
): { readonly snapshot: MistralConversationDurableSnapshot; readonly events: readonly MistralConversationServerEvent[] } {
  validateSnapshot(snapshot);
  if (!COMMAND_ID.test(command.commandId)) gatewayError('invalid_state');
  const events: MistralConversationServerEvent[] = [];
  const serverCursor = { value: snapshot.nextServerSequence };
  const emit = (event: ServerEventWithoutSequence): void => {
    events.push(nextServerEvent(serverCursor, event));
  };

  let mission = snapshot.mission;
  let turn = snapshot.turn;
  let finalTranscriptRecorded = snapshot.finalTranscriptRecorded;
  let nextProviderSequence = snapshot.nextProviderSequence;
  let acknowledgedServerSequence = snapshot.acknowledgedServerSequence;

  switch (command.type) {
    case 'start_turn': {
      if (!OPAQUE_ID.test(command.turnId) || !UUID.test(command.bargeInCancellationId)) {
        gatewayError('invalid_state');
      }
      const start = command.control;
      let nextTurn = createMistralConversationTurnState(start);
      if (mission.phase === 'ready') {
        const ordinal = mission.lastTurnOrdinal + 1;
        nextTurn = reduceMistralConversationTurnState(nextTurn, {
          type: 'ACCEPT',
          turnId: command.turnId,
          ordinal,
          cancellationGeneration: mission.cancellationGeneration,
          firstAudioSequence: mission.nextAudioSequence,
        });
        mission = reduceMistralConversationMissionState(mission, {
          type: 'TURN_STARTED',
          clientTurnId: start.clientTurnId,
          turnId: command.turnId,
          ordinal,
          contextRevision: start.contextRevision,
          contextDigest: start.contextDigest,
          firstAudioSequence: mission.nextAudioSequence,
          vadStartedAtMs: start.vadStartedAtMs,
          preRollMs: start.preRollMs,
        });
      } else if (mission.phase === 'response_active' && turn) {
        if (mission.routeMode !== 'full_duplex' || !mission.fullDuplexCertified) {
          gatewayError('route_uncertified');
        }
        const old = turnCorrelation(snapshot);
        const cancellationGeneration = mission.cancellationGeneration + 1;
        turn = reduceMistralConversationTurnState(turn, {
          type: 'REQUEST_CANCEL',
          cancellationId: command.bargeInCancellationId,
          cancellationGeneration,
          reason: 'barge_in',
        });
        turn = reduceMistralConversationTurnState(turn, {
          type: 'CONFIRM_CANCEL',
          cancellationId: command.bargeInCancellationId,
          cancellationGeneration,
        });
        const ordinal = mission.lastTurnOrdinal + 1;
        mission = reduceMistralConversationMissionState(mission, {
          type: 'BARGE_IN',
          cancelledTurnId: old.turnId,
          cancellationId: command.bargeInCancellationId,
          cancellationGeneration,
          nextTurn: {
            clientTurnId: start.clientTurnId,
            turnId: command.turnId,
            ordinal,
            contextRevision: start.contextRevision,
            contextDigest: start.contextDigest,
            firstAudioSequence: mission.nextAudioSequence,
            vadStartedAtMs: start.vadStartedAtMs,
            preRollMs: start.preRollMs,
          },
        });
        emit({
          type: 'turn.cancelled',
          ...old,
          cancellationId: command.bargeInCancellationId,
          cancellationGeneration,
        });
        nextTurn = reduceMistralConversationTurnState(
          createMistralConversationTurnState(start),
          {
            type: 'ACCEPT',
            turnId: command.turnId,
            ordinal,
            cancellationGeneration,
            firstAudioSequence: mission.activeTurn?.firstAudioSequence ?? mission.nextAudioSequence,
          },
        );
      } else {
        gatewayError('invalid_state');
      }
      turn = nextTurn;
      finalTranscriptRecorded = false;
      nextProviderSequence = 0;
      const active = mission.activeTurn;
      if (!active) gatewayError('invalid_state');
      emit({
        type: 'turn.started',
        clientTurnId: active.clientTurnId,
        turnId: active.turnId,
        ordinal: active.ordinal,
        contextRevision: active.contextRevision,
        contextDigest: active.contextDigest,
        cancellationGeneration: active.cancellationGeneration,
        firstAudioSequence: active.firstAudioSequence,
        vadStartedAtMs: active.vadStartedAtMs,
        preRollMs: active.preRollMs,
      });
      break;
    }
    case 'ingest_audio': {
      if (!turn || !SHA256.test(command.frame.audioSha256)) gatewayError('invalid_state');
      const correlation = turnCorrelation(snapshot);
      mission = reduceMistralConversationMissionState(mission, {
        type: 'TURN_AUDIO_INGESTED',
        ...correlation,
        audioSequence: command.frame.audioSequence,
        audioBytes: command.frame.audioBytes,
      });
      turn = reduceMistralConversationTurnState(turn, {
        type: 'AUDIO_INGESTED',
        ordinal: command.frame.turnOrdinal,
        audioSequence: command.frame.audioSequence,
        audioBytes: command.frame.audioBytes,
      });
      break;
    }
    case 'commit_turn': {
      if (!turn || turn.clientTurnId !== command.control.clientTurnId) gatewayError('invalid_state');
      const correlation = turnCorrelation(snapshot);
      mission = reduceMistralConversationMissionState(mission, {
        type: 'TURN_COMMITTED',
        ...correlation,
        lastAudioSequence: command.control.lastAudioSequence,
        vadEndedAtMs: command.control.vadEndedAtMs,
      });
      turn = reduceMistralConversationTurnState(turn, {
        type: 'COMMIT',
        lastAudioSequence: command.control.lastAudioSequence,
        vadEndedAtMs: command.control.vadEndedAtMs,
      });
      turn = reduceMistralConversationTurnState(turn, { type: 'START_TRANSCRIPTION' });
      emit({
        type: 'turn.committed',
        ...correlation,
        lastAudioSequence: command.control.lastAudioSequence,
        vadEndedAtMs: command.control.vadEndedAtMs,
      });
      emit({ type: 'turn.phase', ...correlation, phase: 'transcribing' });
      break;
    }
    case 'cancel_turn': {
      if (!turn || turn.clientTurnId !== command.control.clientTurnId) gatewayError('invalid_state');
      const correlation = turnCorrelation(snapshot);
      const cancellationGeneration = mission.cancellationGeneration + 1;
      turn = reduceMistralConversationTurnState(turn, {
        type: 'REQUEST_CANCEL',
        cancellationId: command.control.cancellationId,
        cancellationGeneration,
        reason: command.control.reason,
      });
      turn = reduceMistralConversationTurnState(turn, {
        type: 'CONFIRM_CANCEL',
        cancellationId: command.control.cancellationId,
        cancellationGeneration,
      });
      mission = reduceMistralConversationMissionState(mission, {
        type: 'TURN_CANCELLED',
        ...correlation,
        cancellationId: command.control.cancellationId,
        cancellationGeneration,
      });
      emit({
        type: 'turn.cancelled',
        ...correlation,
        cancellationId: command.control.cancellationId,
        cancellationGeneration,
      });
      turn = null;
      finalTranscriptRecorded = false;
      nextProviderSequence = 0;
      break;
    }
    case 'fail_turn': {
      if (!turn || turn.turnId !== command.turnId || !UUID.test(command.cancellationId)) {
        gatewayError('invalid_state');
      }
      const correlation = turnCorrelation(snapshot);
      const cancellationGeneration = mission.cancellationGeneration + 1;
      turn = reduceMistralConversationTurnState(turn, {
        type: 'REQUEST_CANCEL',
        cancellationId: command.cancellationId,
        cancellationGeneration,
        reason: command.reason,
      });
      turn = reduceMistralConversationTurnState(turn, {
        type: 'CONFIRM_CANCEL',
        cancellationId: command.cancellationId,
        cancellationGeneration,
      });
      mission = reduceMistralConversationMissionState(mission, {
        type: 'TURN_CANCELLED',
        ...correlation,
        cancellationId: command.cancellationId,
        cancellationGeneration,
      });
      emit({
        type: 'turn.cancelled',
        ...correlation,
        cancellationId: command.cancellationId,
        cancellationGeneration,
      });
      emit({ type: 'error', code: command.errorCode, retryable: true });
      turn = null;
      finalTranscriptRecorded = false;
      nextProviderSequence = 0;
      break;
    }
    case 'record_transcript': {
      if (
        !turn
        || turn.turnId !== command.turnId
        || turn.phase !== 'transcribing'
        || command.providerSequence !== nextProviderSequence
        || finalTranscriptRecorded
      ) gatewayError('invalid_state');
      const correlation = turnCorrelation(snapshot);
      emit({
        type: 'turn.transcript',
        ...correlation,
        text: command.text,
        final: command.final,
      });
      nextProviderSequence += 1;
      finalTranscriptRecorded = command.final;
      break;
    }
    case 'advance_phase': {
      if (!turn || turn.turnId !== command.turnId) gatewayError('invalid_state');
      if (command.phase === 'reasoning') {
        if (!finalTranscriptRecorded) gatewayError('invalid_state');
        turn = reduceMistralConversationTurnState(turn, { type: 'START_REASONING' });
      } else if (command.phase === 'rendering') {
        turn = reduceMistralConversationTurnState(turn, { type: 'START_RENDERING' });
      } else {
        turn = reduceMistralConversationTurnState(turn, { type: 'START_DELIVERY' });
      }
      emit({ type: 'turn.phase', ...turnCorrelation(snapshot), phase: command.phase });
      break;
    }
    case 'complete_turn': {
      if (
        !turn
        || turn.turnId !== command.turnId
        || !finalTranscriptRecorded
        || command.missionConnectionEpoch !== snapshot.missionConnectionEpoch
        || command.cancellationGeneration !== mission.cancellationGeneration
        || !OPAQUE_ID.test(command.authorizationHandle)
        || !OPAQUE_ID.test(command.stagedDeliveryHandle)
      ) {
        gatewayError('invalid_state');
      }
      const correlation = turnCorrelation(snapshot);
      turn = reduceMistralConversationTurnState(turn, { type: 'COMPLETE' });
      mission = reduceMistralConversationMissionState(mission, {
        type: 'TURN_COMPLETED',
        ...correlation,
      });
      emit({ type: 'turn.completed', ...correlation });
      turn = null;
      finalTranscriptRecorded = false;
      nextProviderSequence = 0;
      break;
    }
    case 'update_context':
      mission = reduceMistralConversationMissionState(mission, {
        type: 'CONTEXT_UPDATED',
        contextRevision: command.control.contextRevision,
        contextDigest: command.control.contextDigest,
      });
      emit({
        type: 'session.context_updated',
        contextRevision: command.control.contextRevision,
        contextDigest: command.control.contextDigest,
      });
      break;
    case 'ack_events':
      if (
        command.control.missionConnectionEpoch !== snapshot.missionConnectionEpoch
        || command.control.nextServerSequence <= acknowledgedServerSequence
        || command.control.nextServerSequence > snapshot.nextServerSequence
      ) gatewayError('sequence_error');
      acknowledgedServerSequence = command.control.nextServerSequence;
      break;
    case 'record_error':
      emit({ type: 'error', code: command.errorCode, retryable: command.retryable });
      break;
    case 'drain': {
      let cancellation: { cancellationId: string; cancellationGeneration: number } | null = null;
      if (turn) {
        if (!UUID.test(command.cancellationId)) gatewayError('invalid_state');
        const correlation = turnCorrelation(snapshot);
        cancellation = {
          cancellationId: command.cancellationId,
          cancellationGeneration: mission.cancellationGeneration + 1,
        };
        turn = reduceMistralConversationTurnState(turn, {
          type: 'REQUEST_CANCEL',
          ...cancellation,
          reason: 'session_ending',
        });
        turn = reduceMistralConversationTurnState(turn, {
          type: 'CONFIRM_CANCEL',
          ...cancellation,
        });
        emit({ type: 'turn.cancelled', ...correlation, ...cancellation });
      }
      mission = reduceMistralConversationMissionState(mission, {
        type: 'DRAIN',
        reason: command.reason,
        cancellation,
      });
      emit({
        type: 'session.draining',
        reason: command.reason,
        cancellationGeneration: mission.cancellationGeneration,
      });
      turn = null;
      finalTranscriptRecorded = false;
      nextProviderSequence = 0;
      break;
    }
    case 'close': {
      if (!mission.drainReason) gatewayError('invalid_state');
      const reason = mission.drainReason;
      mission = reduceMistralConversationMissionState(mission, { type: 'CLOSE' });
      emit({ type: 'session.closed', reason });
      break;
    }
  }

  return finishTransition(snapshot, {
    mission,
    turn,
    finalTranscriptRecorded,
    nextProviderSequence,
    acknowledgedServerSequence,
    events,
    nextServerSequence: serverCursor.value,
  });
}

/**
 * Takeover pur à exécuter par `authority.open` sous CAS. Aucun PCM n'est persisté : un tour
 * interrompu est annulé, ses octets/séquences restent brûlés, puis le nouvel owner reprend prêt.
 */
export function recoverMistralConversationDurableSession(
  snapshot: MistralConversationDurableSnapshot,
  input: {
    readonly newMissionConnectionEpoch: number;
    readonly cancellationId: string;
    readonly routeMode: MistralConversationRouteMode;
    readonly fullDuplexCertified: boolean;
  },
): {
  readonly snapshot: MistralConversationDurableSnapshot;
  readonly events: readonly MistralConversationServerEvent[];
  readonly recoveryCancellation: MistralConversationRecoveryCancellation | null;
} {
  validateSnapshot(snapshot);
  if (
    input.newMissionConnectionEpoch !== snapshot.missionConnectionEpoch + 1
    || !UUID.test(input.cancellationId)
    || snapshot.mission.phase === 'draining'
    || snapshot.mission.phase === 'closed'
    || snapshot.mission.phase === 'recovering_route'
    || snapshot.mission.phase === 'connecting'
  ) gatewayError('invalid_state');

  const serverCursor = { value: snapshot.nextServerSequence };
  const events: MistralConversationServerEvent[] = [];
  const emit = (event: ServerEventWithoutSequence): void => {
    events.push(nextServerEvent(serverCursor, event));
  };
  const previousTurn = snapshot.turn;
  const correlation = previousTurn ? turnCorrelation(snapshot) : null;
  const cancellation = previousTurn ? {
    cancellationId: input.cancellationId,
    cancellationGeneration: snapshot.mission.cancellationGeneration + 1,
  } : null;
  const recoveryCancellation = correlation && cancellation ? {
    ...correlation,
    ...cancellation,
  } : null;

  let turn = previousTurn;
  if (turn && cancellation) {
    turn = reduceMistralConversationTurnState(turn, {
      type: 'REQUEST_CANCEL',
      ...cancellation,
      reason: 'route_lost',
    });
    turn = reduceMistralConversationTurnState(turn, {
      type: 'CONFIRM_CANCEL',
      ...cancellation,
    });
  }
  let mission = snapshot.mission;
  mission = reduceMistralConversationMissionState(mission, {
    type: 'ROUTE_RECOVERY_STARTED',
    cancellation,
  });
  emit({
    type: 'session.route_recovering',
    cancellationGeneration: mission.cancellationGeneration,
  });
  if (correlation && cancellation) {
    emit({ type: 'turn.cancelled', ...correlation, ...cancellation });
  }
  mission = reduceMistralConversationMissionState(mission, {
    type: 'ROUTE_RECOVERED',
    missionConnectionEpoch: input.newMissionConnectionEpoch,
    routeMode: input.routeMode,
    fullDuplexCertified: input.fullDuplexCertified,
  });
  emit({
    type: 'session.route_recovered',
    missionConnectionEpoch: input.newMissionConnectionEpoch,
    routeMode: input.routeMode,
    fullDuplexCertified: input.fullDuplexCertified,
  });

  const recovered: MistralConversationDurableSnapshot = {
    version: snapshot.version + 1,
    missionConnectionEpoch: input.newMissionConnectionEpoch,
    acknowledgedServerSequence: snapshot.acknowledgedServerSequence,
    nextServerSequence: serverCursor.value,
    nextProviderSequence: 0,
    mission,
    turn: null,
    finalTranscriptRecorded: false,
  };
  // Après takeover, deux slots restent réservés à session.draining + session.closed.
  if (serverCursor.value > UINT32_MAX - 1) gatewayError('temporarily_unavailable');
  if (
    !Number.isSafeInteger(recovered.version)
    || recovered.version > Number.MAX_SAFE_INTEGER - 2
  ) gatewayError('temporarily_unavailable');
  validateSnapshot(recovered);
  return { snapshot: recovered, events, recoveryCancellation };
}

/** Valeur initiale que l'adapter durable doit insérer avec l'outbox `session.ready`. */
export function createMistralConversationDurableSession(input: {
  readonly grant: MistralConversationBootstrapGrant;
  readonly missionConnectionEpoch: number;
}): { readonly snapshot: MistralConversationDurableSnapshot; readonly events: readonly MistralConversationServerEvent[] } {
  const mission = reduceMistralConversationMissionState(INITIAL_MISTRAL_CONVERSATION_MISSION_STATE, {
    type: 'SESSION_READY',
    sessionHandle: input.grant.sessionHandle,
    missionConnectionEpoch: input.missionConnectionEpoch,
    expiresAt: input.grant.hardExpiresAt,
    contextRevision: input.grant.contextRevision,
    contextDigest: input.grant.contextDigest,
    routeMode: input.grant.routeMode,
    fullDuplexCertified: input.grant.fullDuplexCertified,
    nextAudioSequence: 0,
    maxMissionAudioBytes: input.grant.maxMissionAudioBytes,
  });
  const ready: MistralConversationServerEvent = {
    type: 'session.ready',
    serverSequence: 0,
    sessionHandle: input.grant.sessionHandle,
    missionConnectionEpoch: input.missionConnectionEpoch,
    expiresAt: input.grant.hardExpiresAt,
    contextRevision: input.grant.contextRevision,
    contextDigest: input.grant.contextDigest,
    routeMode: input.grant.routeMode,
    fullDuplexCertified: input.grant.fullDuplexCertified,
    nextAudioSequence: mission.nextAudioSequence,
    maxMissionAudioBytes: input.grant.maxMissionAudioBytes,
  };
  encodeMistralConversationServerEvent(ready);
  const snapshot: MistralConversationDurableSnapshot = {
    version: 1,
    missionConnectionEpoch: input.missionConnectionEpoch,
    acknowledgedServerSequence: 0,
    nextServerSequence: 1,
    nextProviderSequence: 0,
    mission,
    turn: null,
    finalTranscriptRecorded: false,
  };
  validateSnapshot(snapshot);
  return { snapshot, events: [ready] };
}

interface QueueWaiter<T> {
  resolve(value: T): void;
  reject(error: Error): void;
  signal: AbortSignal | null;
  onAbort: (() => void) | null;
  timer: ReturnType<typeof setTimeout> | null;
}

class BoundedAsyncQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: QueueWaiter<T>[] = [];
  private queuedBytes = 0;
  private immediateFailure: Error | null = null;
  private deferredFailure: Error | null = null;

  constructor(private readonly limits: {
    readonly maxValues: number;
    readonly maxBytes: number;
    readonly sizeOf: (value: T) => number;
    readonly overflow: () => Error;
  }) {}

  get count(): number {
    return this.values.length;
  }

  push(
    value: T,
    options: { readonly preserveAcceptedOnOverflow?: boolean } = {},
  ): boolean {
    if (this.immediateFailure || this.deferredFailure) return false;
    const waiter = this.waiters.shift();
    if (waiter) {
      this.cleanup(waiter);
      waiter.resolve(value);
      return true;
    }
    const bytes = this.limits.sizeOf(value);
    if (
      !Number.isSafeInteger(bytes)
      || bytes < 0
      || this.values.length >= this.limits.maxValues
      || this.queuedBytes + bytes > this.limits.maxBytes
    ) {
      const error = this.limits.overflow();
      if (options.preserveAcceptedOnOverflow) this.failAfterDrain(error);
      else this.fail(error);
      return false;
    }
    this.values.push(value);
    this.queuedBytes += bytes;
    return true;
  }

  fail(error: Error): void {
    if (this.immediateFailure) return;
    this.immediateFailure = error;
    this.deferredFailure = null;
    this.values.splice(0);
    this.queuedBytes = 0;
    for (const waiter of this.waiters.splice(0)) {
      this.cleanup(waiter);
      waiter.reject(error);
    }
  }

  /**
   * Ferme l'entrée sans effacer les valeurs déjà admises. Une erreur protocolaire reçue après
   * un ACK ne doit jamais remonter dans le temps et annuler cet ACK accepté en FIFO.
   */
  failAfterDrain(error: Error): void {
    if (this.immediateFailure || this.deferredFailure) return;
    this.deferredFailure = error;
    for (const waiter of this.waiters.splice(0)) {
      this.cleanup(waiter);
      waiter.reject(error);
    }
  }

  next(input: { readonly signal: AbortSignal; readonly timeoutMs?: number }): Promise<T> {
    if (this.immediateFailure) return Promise.reject(this.immediateFailure);
    if (input.signal.aborted) return Promise.reject(new MistralConversationGatewayV2Error('aborted'));
    const value = this.values.shift();
    if (value !== undefined) {
      this.queuedBytes -= this.limits.sizeOf(value);
      return Promise.resolve(value);
    }
    if (this.deferredFailure) return Promise.reject(this.deferredFailure);
    return new Promise<T>((resolve, reject) => {
      const waiter: QueueWaiter<T> = {
        resolve,
        reject,
        signal: input.signal,
        onAbort: null,
        timer: null,
      };
      waiter.onAbort = () => {
        this.remove(waiter);
        reject(new MistralConversationGatewayV2Error('aborted'));
      };
      this.waiters.push(waiter);
      input.signal.addEventListener('abort', waiter.onAbort, { once: true });
      if (input.timeoutMs !== undefined) {
        waiter.timer = setTimeout(() => {
          this.remove(waiter);
          reject(new MistralConversationGatewayV2Error('auth_timeout'));
        }, input.timeoutMs);
      }
      if (input.signal.aborted) waiter.onAbort();
    });
  }

  private remove(waiter: QueueWaiter<T>): void {
    const index = this.waiters.indexOf(waiter);
    if (index >= 0) this.waiters.splice(index, 1);
    this.cleanup(waiter);
  }

  private cleanup(waiter: QueueWaiter<T>): void {
    if (waiter.timer) clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
    waiter.signal = null;
    waiter.onAbort = null;
    waiter.timer = null;
  }
}

interface IngressMessage {
  readonly data: SocketData;
  readonly isBinary: boolean;
  readonly size: number;
  readonly receivedPhase: 'auth' | 'opening' | 'replay_only' | 'ready';
}

interface TerminalDisposition {
  readonly source: 'client' | 'expired' | 'service_shutdown';
  readonly reason: MistralConversationSessionEndReason;
}

type ProviderAudioMessage =
  | { readonly type: 'audio'; readonly pcm: Uint8Array }
  | { readonly type: 'commit' };

interface TurnRuntime {
  readonly generation: number;
  readonly turnId: string;
  readonly clientTurnId: string;
  readonly ordinal: number;
  readonly controller: AbortController;
  readonly audio: BoundedAsyncQueue<ProviderAudioMessage>;
  connection: MistralConversationProviderConnection | null;
  commitQueued: boolean;
  readonly responseDeadline: {
    readonly promise: Promise<never>;
    arm(): void;
    clear(): void;
  };
  task: Promise<void> | null;
}

function createResponseDeadline(timeoutMs: number): TurnRuntime['responseDeadline'] {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let active = true;
  let rejectDeadline: (error: Error) => void = () => undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  return {
    promise,
    arm: () => {
      if (!active || timer) return;
      timer = setTimeout(() => {
        timer = null;
        active = false;
        rejectDeadline(new MistralConversationGatewayV2Error('provider_error'));
      }, timeoutMs);
    },
    clear: () => {
      active = false;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

function socketBytes(data: SocketData): Uint8Array {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function messageSize(data: SocketData): number {
  return typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : socketBytes(data).byteLength;
}

function asText(message: IngressMessage): string {
  if (message.isBinary) gatewayError('protocol_error');
  if (typeof message.data === 'string') return message.data;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(socketBytes(message.data));
  } catch {
    gatewayError('protocol_error');
  }
}

function mapProtocolError(error: unknown): MistralConversationGatewayV2Error {
  if (error instanceof MistralConversationGatewayV2Error) return error;
  if (error instanceof MistralConversationProtocolError) {
    if (error.code === 'sequence_error') return new MistralConversationGatewayV2Error('sequence_error');
    if (error.code === 'audio_budget_exceeded') {
      return new MistralConversationGatewayV2Error('audio_budget_exceeded');
    }
    if (error.code === 'invalid_state_transition' || error.code === 'stale_after_cancellation') {
      return new MistralConversationGatewayV2Error('invalid_state');
    }
    return new MistralConversationGatewayV2Error('protocol_error');
  }
  return new MistralConversationGatewayV2Error('temporarily_unavailable');
}

function transitionRejection(error: unknown): MistralConversationTransitionRejection {
  const safe = mapProtocolError(error);
  if (safe.code === 'sequence_error') return 'sequence_error';
  if (safe.code === 'audio_budget_exceeded') return 'audio_budget_exceeded';
  if (safe.code === 'context_stale') return 'context_stale';
  if (safe.code === 'route_uncertified') return 'route_uncertified';
  return 'invalid_state';
}

function wireError(code: MistralConversationGatewayV2ErrorCode): MistralConversationServerErrorCode {
  if (code === 'authentication_failed' || code === 'auth_timeout') return 'authentication_failed';
  if (code === 'sequence_error') return 'sequence_error';
  if (code === 'audio_budget_exceeded') return 'audio_budget_exceeded';
  if (code === 'backpressure' || code === 'replay_window_exhausted') return 'backpressure';
  if (code === 'context_stale') return 'context_stale';
  if (code === 'route_uncertified') return 'route_uncertified';
  if (code === 'protocol_error') return 'protocol_error';
  if (code === 'invalid_state') return 'invalid_state';
  if (code === 'expired') return 'session_expired';
  return 'temporarily_unavailable';
}

function closeCode(code: MistralConversationGatewayV2ErrorCode): number {
  if (code === 'expired') return 1000;
  if (code === 'auth_timeout') return 4408;
  if (code === 'authentication_failed') return 4401;
  if (
    code === 'protocol_error'
    || code === 'sequence_error'
    || code === 'audio_budget_exceeded'
    || code === 'invalid_state'
  ) return 4400;
  if (code === 'backpressure' || code === 'replay_window_exhausted') return 1013;
  return 1011;
}

function closeReason(code: MistralConversationGatewayV2ErrorCode): string {
  return wireError(code);
}

function isServiceShutdown(reason: MistralConversationSessionEndReason): boolean {
  return reason === 'service_shutdown';
}

function commandScope(value: string): string {
  return value.replace(/[^A-Za-z0-9:_.-]/gu, '_').slice(0, 120);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function opaquePipelineHandle(value: unknown): value is { readonly handle: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const handle = (value as { readonly handle?: unknown }).handle;
  return typeof handle === 'string' && OPAQUE_ID.test(handle);
}

async function runWithDeadline<T>(input: {
  readonly parentSignal: AbortSignal;
  readonly timeoutMs: number;
  readonly timeoutCode: MistralConversationGatewayV2ErrorCode;
  readonly operation: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  if (input.parentSignal.aborted) gatewayError('aborted');
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.parentSignal.removeEventListener('abort', onAbort);
      controller.abort();
      action();
    };
    const onAbort = (): void => settle(() => reject(new MistralConversationGatewayV2Error('aborted')));
    const timer = setTimeout(() => settle(() => reject(
      new MistralConversationGatewayV2Error(input.timeoutCode),
    )), input.timeoutMs);
    input.parentSignal.addEventListener('abort', onAbort, { once: true });
    if (input.parentSignal.aborted) {
      onAbort();
      return;
    }
    void Promise.resolve()
      .then(() => input.operation(controller.signal))
      .then(
        (value) => settle(() => resolve(value)),
        (error: unknown) => settle(() => reject(error)),
      );
  });
}

class SerializedAuthority {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly authority: MistralConversationDurableAuthority,
    private readonly identity: {
      readonly companyId: string;
      readonly subjectHash: string;
      readonly sessionHandle: string;
      readonly ownerLeaseToken: string;
    },
    private current: MistralConversationDurableSnapshot,
    private readonly dispatch: (
      events: readonly MistralConversationServerEvent[],
      signal: AbortSignal,
    ) => Promise<void>,
    private readonly defaultSignal: AbortSignal,
    private readonly operationTimeoutMs: number,
  ) {}

  get snapshot(): MistralConversationDurableSnapshot {
    return this.current;
  }

  execute(
    command: MistralConversationDurableCommand,
    afterApplied?: (
      result: Extract<MistralConversationDurableTransitionResult, { readonly status: 'applied' | 'replayed' }>,
    ) => void | Promise<void>,
    signal: AbortSignal = this.defaultSignal,
    dispatchEvents = true,
  ): Promise<MistralConversationDurableTransitionResult> {
    const task = this.tail.then(async () => {
      let before = this.current;
      let result = await this.apply(command, signal);
      if (result.status === 'conflict') {
        this.assertOwned(result.snapshot);
        this.current = result.snapshot;
        before = this.current;
        result = await this.apply(command, signal);
      }
      if (result.status === 'applied' || result.status === 'replayed') {
        this.assertOwned(result.snapshot);
        this.assertTransition(before, result, command);
        this.current = result.snapshot;
        let sideEffectError: unknown = null;
        try {
          await afterApplied?.(result);
        } catch (error) {
          sideEffectError = error;
        }
        // Les événements sont déjà dans l'outbox : une erreur locale ne doit jamais créer un trou.
        if (dispatchEvents) await this.dispatch(result.events, signal);
        if (sideEffectError) throw sideEffectError;
      }
      return result;
    });
    this.tail = task.then(() => undefined, () => undefined);
    return task;
  }

  settled(): Promise<void> {
    return this.tail;
  }

  private apply(
    command: MistralConversationDurableCommand,
    signal: AbortSignal,
  ): Promise<MistralConversationDurableTransitionResult> {
    return runWithDeadline({
      parentSignal: signal,
      timeoutMs: this.operationTimeoutMs,
      timeoutCode: 'temporarily_unavailable',
      operation: (operationSignal) => this.authority.transition({
        ...this.identity,
        missionConnectionEpoch: this.current.missionConnectionEpoch,
        expectedVersion: this.current.version,
        maxUnacknowledgedEvents: MAX_LIVE_UNACKED_EVENTS,
        maxUnacknowledgedBytes: MAX_LIVE_UNACKED_BYTES,
        command,
        signal: operationSignal,
      }),
    });
  }

  private assertOwned(snapshot: MistralConversationDurableSnapshot): void {
    validateSnapshot(snapshot);
    if (
      snapshot.missionConnectionEpoch !== this.current.missionConnectionEpoch
      || snapshot.mission.sessionHandle !== this.identity.sessionHandle
    ) gatewayError('temporarily_unavailable');
  }

  private assertTransition(
    before: MistralConversationDurableSnapshot,
    result: Extract<MistralConversationDurableTransitionResult, { readonly status: 'applied' | 'replayed' }>,
    command: MistralConversationDurableCommand,
  ): void {
    for (let index = 0; index < result.events.length; index += 1) {
      const event = result.events[index];
      if (!event) gatewayError('temporarily_unavailable');
      encodeMistralConversationServerEvent(event);
      if (index > 0 && event.serverSequence !== (result.events[index - 1]?.serverSequence ?? -2) + 1) {
        gatewayError('temporarily_unavailable');
      }
    }
    if (result.status === 'applied') {
      if (
        result.snapshot.version !== before.version + 1
        || result.snapshot.nextServerSequence !== before.nextServerSequence + result.events.length
        || (
          result.events.length > 0
          && result.events[0]?.serverSequence !== before.nextServerSequence
        )
      ) gatewayError('temporarily_unavailable');
      if (command.type === 'ack_events') {
        if (
          result.events.length !== 0
          || result.snapshot.acknowledgedServerSequence !== command.control.nextServerSequence
          || result.snapshot.acknowledgedServerSequence <= before.acknowledgedServerSequence
        ) gatewayError('temporarily_unavailable');
      } else if (
        result.snapshot.acknowledgedServerSequence !== before.acknowledgedServerSequence
      ) gatewayError('temporarily_unavailable');
      return;
    }
    if (
      result.snapshot.version < before.version
      // Une transition peut avoir été commitée après l'expiration de la deadline locale. Son
      // replay retourne alors le snapshot autoritatif courant, qui a légitimement pu avancer
      // (notamment via un ACK ultérieur). Refuser cette progression rendrait la réconciliation
      // idempotente impossible après un timeout réseau.
      || result.snapshot.acknowledgedServerSequence < before.acknowledgedServerSequence
      || (
        command.type === 'ack_events'
        && result.snapshot.acknowledgedServerSequence < command.control.nextServerSequence
      )
      || result.events.some((event) => event.serverSequence >= result.snapshot.nextServerSequence)
    ) gatewayError('temporarily_unavailable');
  }
}

function rejectedAsError(result: MistralConversationDurableTransitionResult): MistralConversationGatewayV2Error {
  if (result.status === 'rejected') {
    return new MistralConversationGatewayV2Error(result.reason);
  }
  if (result.status === 'expired') return new MistralConversationGatewayV2Error('expired');
  return new MistralConversationGatewayV2Error('temporarily_unavailable');
}

/**
 * Noyau WSS v2. L'adapter HTTP devra imposer TLS, Origin allowlist, sous-protocole exact,
 * `perMessageDeflate:false` et une `maxPayload` au plus égale au plus grand message BOB2.
 */
export async function serveMistralConversationGatewayV2(
  socket: MistralConversationGatewayV2Socket,
  dependencies: MistralConversationGatewayV2Dependencies,
  input: { readonly signal?: AbortSignal } = {},
): Promise<void> {
  if (
    socket.readyState !== 1
    || typeof dependencies.bootstrap?.redeemAndOpenInitial !== 'function'
    || typeof dependencies.authority?.open !== 'function'
    || typeof dependencies.authority?.transition !== 'function'
    || typeof dependencies.context?.authorize !== 'function'
    || typeof dependencies.provider?.openTurn !== 'function'
    || typeof dependencies.pipeline?.reason !== 'function'
    || typeof dependencies.pipeline?.auditAndRender !== 'function'
    || typeof dependencies.pipeline?.stageDelivery !== 'function'
  ) gatewayError('temporarily_unavailable');
  const now = dependencies.now ?? Date.now;
  const entropy = dependencies.entropy ?? defaultEntropy();
  const authTimeoutMs = dependencies.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
  const providerCloseTimeoutMs = dependencies.providerCloseTimeoutMs ?? DEFAULT_PROVIDER_CLOSE_TIMEOUT_MS;
  const operationTimeoutMs = dependencies.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
  const replayTimeoutMs = dependencies.replayTimeoutMs ?? DEFAULT_REPLAY_TIMEOUT_MS;
  const pipelineTimeoutMs = dependencies.pipelineTimeoutMs ?? DEFAULT_PIPELINE_TIMEOUT_MS;
  const providerResponseTimeoutMs = dependencies.providerResponseTimeoutMs
    ?? DEFAULT_PROVIDER_RESPONSE_TIMEOUT_MS;
  const cleanupTimeoutMs = dependencies.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;
  if (!isIntegerBetween(authTimeoutMs, 1_000, MAX_AUTH_TIMEOUT_MS)) gatewayError('temporarily_unavailable');
  if (!isIntegerBetween(providerCloseTimeoutMs, MIN_TIMEOUT_MS, MAX_PROVIDER_CLOSE_TIMEOUT_MS)) {
    gatewayError('temporarily_unavailable');
  }
  if (!isIntegerBetween(replayTimeoutMs, MIN_TIMEOUT_MS, MAX_REPLAY_TIMEOUT_MS)) {
    gatewayError('temporarily_unavailable');
  }
  for (const timeout of [operationTimeoutMs, pipelineTimeoutMs, providerResponseTimeoutMs, cleanupTimeoutMs]) {
    if (!isIntegerBetween(timeout, MIN_TIMEOUT_MS, MAX_OPERATION_TIMEOUT_MS)) {
      gatewayError('temporarily_unavailable');
    }
  }

  const lifecycle = new AbortController();
  const ingress = new BoundedAsyncQueue<IngressMessage>({
    maxValues: MAX_INGRESS_MESSAGES,
    maxBytes: MAX_INGRESS_BYTES,
    sizeOf: (message) => message.size,
    overflow: () => new MistralConversationGatewayV2Error('backpressure'),
  });
  let phase: 'auth' | 'opening' | 'replay_only' | 'ready' | 'draining' | 'closed' = 'auth';
  let hardExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  let terminationReason: MistralConversationSessionEndReason = 'fatal_error';
  let grant: MistralConversationBootstrapGrant | null = null;
  let authority: SerializedAuthority | null = null;
  let ownerLeaseToken = '';
  let runtimeGeneration = 0;
  let activeRuntime: TurnRuntime | null = null;
  let fatalIngressError: MistralConversationGatewayV2Error | null = null;
  let authTimedOut = false;
  let routeLost = false;
  let terminalReplayOpened = false;
  let openingRecovery: MistralConversationRecoveryMetadata | null = null;
  let terminalDisposition: TerminalDisposition | null = null;
  let resumeHandshakeActive = false;
  let resumeRedemptionCommitted = false;
  let acceptedResumeAcknowledgements = 0;
  let admissionOwner: MistralConversationAdmissionOwner | null = null;
  let admissionHeartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let admissionHeartbeatAbort: AbortController | null = null;
  let admissionHeartbeatGeneration = 0;
  let admissionOwnershipLost = false;

  const latchTerminalDisposition = (
    source: TerminalDisposition['source'],
    reason: MistralConversationSessionEndReason,
  ): TerminalDisposition => {
    terminalDisposition ??= { source, reason };
    terminationReason = terminalDisposition.reason;
    return terminalDisposition;
  };

  const stopAdmissionHeartbeat = (): void => {
    admissionHeartbeatGeneration += 1;
    if (admissionHeartbeatTimer) clearTimeout(admissionHeartbeatTimer);
    admissionHeartbeatTimer = null;
    admissionHeartbeatAbort?.abort();
    admissionHeartbeatAbort = null;
  };

  const markAdmissionOwnershipLost = (
    status: Exclude<
      Awaited<ReturnType<MistralConversationAdmissionAuthority['renewOwner']>>['status'],
      'renewed'
    >,
  ): void => {
    if (terminalDisposition !== null || phase === 'draining' || phase === 'closed') return;
    admissionOwnershipLost = true;
    fatalIngressError ??= new MistralConversationGatewayV2Error(
      status === 'expired' ? 'expired' : 'temporarily_unavailable',
    );
    ingress.fail(fatalIngressError);
    lifecycle.abort();
  };

  const renewAdmissionOwner = async (
    owner: MistralConversationAdmissionOwner,
    signal: AbortSignal,
  ): Promise<void> => {
    const admission = dependencies.admission;
    if (!admission) gatewayError('temporarily_unavailable');
    const result = await runWithDeadline({
      parentSignal: signal,
      timeoutMs: Math.min(operationTimeoutMs, admission.policy.heartbeatSeconds * 1_000),
      timeoutCode: 'temporarily_unavailable',
      operation: (operationSignal) => admission.renewOwner({
        ...owner,
        signal: operationSignal,
      }),
    });
    if (result.status === 'renewed') return;
    markAdmissionOwnershipLost(result.status);
    gatewayError(result.status === 'expired' ? 'expired' : 'temporarily_unavailable');
  };

  const scheduleAdmissionHeartbeat = (): void => {
    const admission = dependencies.admission;
    const owner = admissionOwner;
    if (!admission || !owner || phase === 'draining' || phase === 'closed') return;
    const generation = admissionHeartbeatGeneration;
    admissionHeartbeatTimer = setTimeout(() => {
      if (
        generation !== admissionHeartbeatGeneration
        || phase === 'draining'
        || phase === 'closed'
      ) return;
      const controller = new AbortController();
      admissionHeartbeatAbort = controller;
      const onLifecycleAbort = (): void => controller.abort();
      lifecycle.signal.addEventListener('abort', onLifecycleAbort, { once: true });
      void renewAdmissionOwner(owner, controller.signal)
        .then(() => {
          if (
            generation === admissionHeartbeatGeneration
            && !controller.signal.aborted
            && !lifecycle.signal.aborted
          ) scheduleAdmissionHeartbeat();
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted || lifecycle.signal.aborted) return;
          const mapped = mapProtocolError(error);
          markAdmissionOwnershipLost(
            mapped.code === 'expired' ? 'expired' : 'unavailable',
          );
        })
        .finally(() => {
          lifecycle.signal.removeEventListener('abort', onLifecycleAbort);
          if (admissionHeartbeatAbort === controller) admissionHeartbeatAbort = null;
        });
    }, admission.policy.heartbeatSeconds * 1_000);
  };

  const startAdmissionHeartbeat = async (
    connectionGrant: MistralConversationBootstrapGrant,
    missionConnectionEpoch: number,
    signal: AbortSignal,
  ): Promise<void> => {
    const admission = dependencies.admission;
    if (!admission) gatewayError('temporarily_unavailable');
    try {
      validateMistralConversationAdmissionPolicy(admission.policy);
    } catch {
      gatewayError('temporarily_unavailable');
    }
    stopAdmissionHeartbeat();
    admissionOwner = {
      companyId: connectionGrant.companyId,
      subjectHash: connectionGrant.subjectHash,
      admissionSessionId: connectionGrant.admissionSessionId,
      sessionHandle: connectionGrant.sessionHandle,
      bootstrapId: connectionGrant.bootstrapId,
      missionConnectionEpoch,
      ownerLeaseToken,
    };
    await renewAdmissionOwner(admissionOwner, signal);
    scheduleAdmissionHeartbeat();
  };

  const releaseClosedAdmission = async (signal: AbortSignal): Promise<void> => {
    const admission = dependencies.admission;
    const owner = admissionOwner;
    if (
      !admission
      || !owner
      || !authority
      || authority.snapshot.mission.phase !== 'closed'
    ) return;
    const released = await runWithDeadline({
      parentSignal: signal,
      timeoutMs: cleanupTimeoutMs,
      timeoutCode: 'temporarily_unavailable',
      operation: (operationSignal) => admission.releaseClosed({
        ...owner,
        signal: operationSignal,
      }),
    });
    if (released.status !== 'released' && released.status !== 'replayed') {
      gatewayError('temporarily_unavailable');
    }
  };

  const sendEvents = async (
    events: readonly MistralConversationServerEvent[],
    signal: AbortSignal,
  ): Promise<void> => {
    for (const event of events) {
      if (socket.readyState !== 1) {
        routeLost = true;
        gatewayError('aborted');
      }
      if (socket.bufferedAmount > MAX_DOWNLINK_BUFFERED_BYTES) {
        routeLost = true;
        gatewayError('backpressure');
      }
      const encoded = encodeMistralConversationServerEvent(event);
      if (Buffer.byteLength(encoded, 'utf8') > MISTRAL_CONVERSATION_MAX_SERVER_EVENT_BYTES) {
        gatewayError('protocol_error');
      }
      try {
        await runWithDeadline({
          parentSignal: signal,
          timeoutMs: operationTimeoutMs,
          timeoutCode: 'backpressure',
          operation: () => new Promise<void>((resolve, reject) => {
            socket.send(encoded, (error) => {
              if (error) reject(new MistralConversationGatewayV2Error('aborted'));
              else resolve();
            });
          }),
        });
      } catch (error) {
        routeLost = true;
        throw error;
      }
    }
  };

  const onMessage = (data: SocketData, isBinary: boolean): void => {
    const receivedPhase = phase;
    const size = messageSize(data);
    const maximum = Math.max(
      MISTRAL_CONVERSATION_MAX_CLIENT_CONTROL_BYTES,
      MISTRAL_CONVERSATION_MAX_AUDIO_FRAME_BYTES + 20,
    );
    if (receivedPhase === 'draining' || receivedPhase === 'closed') return;
    const invalidSize = size === 0 || size > maximum;
    let acceptedSessionEndReason: MistralConversationSessionEndReason | null = null;
    if (receivedPhase === 'ready' && !isBinary && !invalidSize) {
      try {
        const control = decodeMistralConversationClientControl(asText({
          data,
          isBinary,
          size,
          receivedPhase,
        }));
        if (control.type === 'session.end') acceptedSessionEndReason = control.reason;
      } catch {
        // Le décodeur séquentiel produira l'erreur protocolaire ; aucune intention n'est latched.
      }
    }
    let validReplayAck = false;
    if (
      (receivedPhase === 'opening' || receivedPhase === 'replay_only')
      && !isBinary
      && !invalidSize
    ) {
      try {
        validReplayAck = decodeMistralConversationClientControl(asText({
          data,
          isBinary,
          size,
          receivedPhase,
        })).type === 'events.ack';
      } catch {
        validReplayAck = false;
      }
    }
    // Le client peut ACKer synchroniquement le dernier événement de replay avant que le
    // callback socket.send rende la main. Cette frame est bornée puis traitée seulement après
    // la barrière `phase = ready`; toute autre commande reste interdite pendant l'ouverture.
    const openingProtocolError = (
      (receivedPhase === 'opening' || receivedPhase === 'replay_only')
      && !validReplayAck
    );
    if (openingProtocolError || invalidSize) {
      fatalIngressError ??= new MistralConversationGatewayV2Error('protocol_error');
      if (receivedPhase === 'opening' || receivedPhase === 'replay_only') {
        ingress.failAfterDrain(fatalIngressError);
      } else {
        ingress.fail(fatalIngressError);
        if (phase === 'ready') lifecycle.abort();
      }
      return;
    }
    if (!ingress.push(
      { data, isBinary, size, receivedPhase },
      {
        preserveAcceptedOnOverflow:
          receivedPhase === 'opening' || receivedPhase === 'replay_only',
      },
    )) {
      fatalIngressError ??= new MistralConversationGatewayV2Error('backpressure');
      if (phase === 'ready') lifecycle.abort();
    } else if (acceptedSessionEndReason !== null) {
      // La cause terminale est acquise au moment exact où la frame validée entre dans la FIFO.
      // Une commande durable antérieure peut bloquer sa consommation sans permettre à close,
      // expiry ou shutdown de réécrire cette décision utilisateur.
      latchTerminalDisposition('client', acceptedSessionEndReason);
    } else if (
      resumeHandshakeActive
      && validReplayAck
      && (receivedPhase === 'opening' || receivedPhase === 'replay_only')
    ) {
      acceptedResumeAcknowledgements += 1;
    }
  };
  const onClose = (): void => {
    routeLost = true;
    // Une perte de route seule reste reprenable. Toute disposition déjà établie est immuable.
    if (terminalDisposition === null) terminationReason = 'fatal_error';
    // Une frame ACK n'est une intention serveur acquise qu'après commit de la capability.
    // Le booléen distinct ferme le DoS pré-auth sans perdre la fenêtre étroite située entre le
    // retour SQL terminal_replay et le passage de phase à replay_only.
    if (
      resumeRedemptionCommitted
      && acceptedResumeAcknowledgements > 0
      && (phase === 'opening' || phase === 'replay_only')
    ) {
      ingress.failAfterDrain(new MistralConversationGatewayV2Error('aborted'));
      return;
    }
    ingress.fail(new MistralConversationGatewayV2Error('aborted'));
    lifecycle.abort();
  };
  const onError = (): void => onClose();
  const onExternalAbort = (): void => {
    latchTerminalDisposition('service_shutdown', 'service_shutdown');
    ingress.fail(new MistralConversationGatewayV2Error('aborted'));
    lifecycle.abort();
  };
  socket.on('message', onMessage);
  socket.on('close', onClose);
  socket.on('error', onError);
  if (input.signal?.aborted) onExternalAbort();
  else input.signal?.addEventListener('abort', onExternalAbort, { once: true });

  const isRuntimeCurrent = (runtime: TurnRuntime): boolean => (
    activeRuntime === runtime
    && runtime.generation === runtimeGeneration
    && !runtime.controller.signal.aborted
  );

  const closeProviderConnection = async (
    connection: MistralConversationProviderConnection,
  ): Promise<void> => {
    const closeController = new AbortController();
    try {
      await runWithDeadline({
        parentSignal: closeController.signal,
        timeoutMs: providerCloseTimeoutMs,
        timeoutCode: 'provider_error',
        operation: (operationSignal) => connection.close({ signal: operationSignal }),
      });
    } catch {
      // La lease est déjà invalidée ; close est best-effort mais strictement borné.
    } finally {
      closeController.abort();
    }
  };

  const abortRuntime = (runtime: TurnRuntime | null): void => {
    if (!runtime) return;
    runtime.controller.abort();
    runtime.audio.fail(new MistralConversationGatewayV2Error('aborted'));
    runtime.responseDeadline.clear();
    if (activeRuntime === runtime) activeRuntime = null;
    const connection = runtime.connection;
    runtime.connection = null;
    if (connection) void closeProviderConnection(connection);
  };

  const stableDigest = (scope: string): Uint8Array => {
    if (!grant) gatewayError('temporarily_unavailable');
    // Domaine + secret serveur durable : un retry après crash reconstruit exactement le même payload.
    return Uint8Array.from(createHmac('sha256', Buffer.from(grant.subjectHash, 'hex'))
      .update('bob-mistral-v2\0')
      .update(grant.sessionHandle)
      .update('\0')
      .update(scope)
      .digest());
  };
  const stableOpaqueId = (scope: string): string => Buffer.from(stableDigest(scope)).toString('base64url');
  const stableCancellationId = (scope: string): string => {
    const bytes = stableDigest(`cancel:${scope}`);
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = Buffer.from(bytes.subarray(0, 16)).toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  const stableCommandId = (scope: string): string => validateEntropyValue(commandScope(scope), COMMAND_ID);

  const durableError = async (
    errorCode: MistralConversationServerErrorCode,
    retryable: boolean,
  ): Promise<void> => {
    if (!authority) return;
    const result = await authority.execute({
      type: 'record_error',
      commandId: stableCommandId(`error:${authority.snapshot.version}:${errorCode}`),
      errorCode,
      retryable,
    });
    if (result.status !== 'applied' && result.status !== 'replayed') throw rejectedAsError(result);
  };

  const failRuntime = async (
    runtime: TurnRuntime,
    errorCode: Extract<
      MistralConversationServerErrorCode,
      'backpressure' | 'context_stale' | 'temporarily_unavailable' | 'internal_error'
    >,
  ): Promise<void> => {
    if (!authority || !isRuntimeCurrent(runtime)) return;
    const result = await authority.execute({
      type: 'fail_turn',
      commandId: stableCommandId(`fail:${runtime.turnId}:${errorCode}`),
      turnId: runtime.turnId,
      cancellationId: stableCancellationId(`fail:${runtime.turnId}:${errorCode}`),
      reason: errorCode === 'backpressure'
        ? 'network_backpressure'
        : errorCode === 'context_stale' ? 'context_changed' : 'timeout',
      errorCode,
    }, () => abortRuntime(runtime));
    if (result.status !== 'applied' && result.status !== 'replayed') {
      if (!isRuntimeCurrent(runtime)) return;
      throw rejectedAsError(result);
    }
  };

  const authorizeContext = async (
    action: 'start_turn' | 'update_context' | 'reason',
    contextRevision: number,
    contextDigest: string,
    signal: AbortSignal,
  ): Promise<Extract<MistralConversationContextAuthorizationResult, {
    readonly status: 'authorized';
  }> | null> => {
    if (!grant) gatewayError('temporarily_unavailable');
    const result = await runWithDeadline({
      parentSignal: signal,
      timeoutMs: operationTimeoutMs,
      timeoutCode: 'temporarily_unavailable',
      operation: (operationSignal) => dependencies.context.authorize({
        companyId: grant?.companyId ?? '',
        subjectHash: grant?.subjectHash ?? '',
        subjectKeyVersion: grant?.subjectKeyVersion ?? 0,
        sessionHandle: grant?.sessionHandle ?? '',
        action,
        contextRevision,
        contextDigest,
        signal: operationSignal,
      }),
    });
    if (result.status === 'authorized') {
      if (!OPAQUE_ID.test(result.authorizationHandle) || !PLANS.has(result.plan)) {
        gatewayError('temporarily_unavailable');
      }
      return result;
    }
    if (result.status === 'unavailable') gatewayError('temporarily_unavailable');
    return null;
  };

  const pipelineIdentity = (
    runtime: TurnRuntime,
    signal: AbortSignal,
    authorization: Extract<MistralConversationContextAuthorizationResult, {
      readonly status: 'authorized';
    }>,
  ): MistralConversationPipelineIdentity => {
    if (!grant || !authority) gatewayError('temporarily_unavailable');
    const snapshot = authority.snapshot;
    const mission = snapshot.mission;
    if (
      snapshot.missionConnectionEpoch !== mission.missionConnectionEpoch
      || mission.activeTurn?.turnId !== runtime.turnId
      || mission.activeTurn.cancellationGeneration !== mission.cancellationGeneration
    ) gatewayError('aborted');
    return {
      companyId: grant.companyId,
      subjectHash: grant.subjectHash,
      subjectKeyVersion: grant.subjectKeyVersion,
      plan: authorization.plan,
      sessionHandle: grant.sessionHandle,
      turnId: runtime.turnId,
      clientTurnId: runtime.clientTurnId,
      contextRevision: mission.contextRevision,
      contextDigest: mission.contextDigest ?? '',
      missionConnectionEpoch: snapshot.missionConnectionEpoch,
      cancellationGeneration: mission.cancellationGeneration,
      authorizationHandle: authorization.authorizationHandle,
      signal,
    };
  };

  const runPipeline = async (runtime: TurnRuntime, transcript: string): Promise<void> => {
    if (!authority || !isRuntimeCurrent(runtime)) return;
    const ensureAuthorized = async (): Promise<Extract<
      MistralConversationContextAuthorizationResult,
      { readonly status: 'authorized' }
    >> => {
      if (!authority || !isRuntimeCurrent(runtime)) gatewayError('aborted');
      const mission = authority.snapshot.mission;
      const authorization = await authorizeContext(
        'reason',
        mission.contextRevision,
        mission.contextDigest ?? '',
        runtime.controller.signal,
      );
      if (!authorization) gatewayError('context_stale');
      return authorization;
    };
    let authorization = await ensureAuthorized();
    let result = await authority.execute({
      type: 'advance_phase',
      commandId: stableCommandId(`phase:${runtime.turnId}:reasoning`),
      turnId: runtime.turnId,
      phase: 'reasoning',
    });
    if (result.status !== 'applied' && result.status !== 'replayed') throw rejectedAsError(result);
    if (!isRuntimeCurrent(runtime)) return;
    const reasoning = await runWithDeadline({
      parentSignal: runtime.controller.signal,
      timeoutMs: pipelineTimeoutMs,
      timeoutCode: 'provider_error',
      operation: (operationSignal) => dependencies.pipeline.reason({
        ...pipelineIdentity(runtime, operationSignal, authorization),
        transcript,
      }),
    });
    if (!isRuntimeCurrent(runtime)) return;
    if (!opaquePipelineHandle(reasoning)) gatewayError('provider_error');

    authorization = await ensureAuthorized();
    result = await authority.execute({
      type: 'advance_phase',
      commandId: stableCommandId(`phase:${runtime.turnId}:rendering`),
      turnId: runtime.turnId,
      phase: 'rendering',
    });
    if (result.status !== 'applied' && result.status !== 'replayed') throw rejectedAsError(result);
    if (!isRuntimeCurrent(runtime)) return;
    const audited = await runWithDeadline({
      parentSignal: runtime.controller.signal,
      timeoutMs: pipelineTimeoutMs,
      timeoutCode: 'provider_error',
      operation: (operationSignal) => dependencies.pipeline.auditAndRender({
        ...pipelineIdentity(runtime, operationSignal, authorization),
        reasoning,
      }),
    });
    if (!isRuntimeCurrent(runtime)) return;
    if (!opaquePipelineHandle(audited)) gatewayError('provider_error');

    authorization = await ensureAuthorized();
    result = await authority.execute({
      type: 'advance_phase',
      commandId: stableCommandId(`phase:${runtime.turnId}:delivering`),
      turnId: runtime.turnId,
      phase: 'delivering',
    });
    if (result.status !== 'applied' && result.status !== 'replayed') throw rejectedAsError(result);
    if (!isRuntimeCurrent(runtime)) return;
    const staged = await runWithDeadline({
      parentSignal: runtime.controller.signal,
      timeoutMs: pipelineTimeoutMs,
      timeoutCode: 'provider_error',
      operation: (operationSignal) => dependencies.pipeline.stageDelivery({
        ...pipelineIdentity(runtime, operationSignal, authorization),
        audited,
      }),
    });
    if (!isRuntimeCurrent(runtime)) return;
    if (!opaquePipelineHandle(staged)) gatewayError('provider_error');

    authorization = await ensureAuthorized();
    const completionFence = pipelineIdentity(runtime, runtime.controller.signal, authorization);

    result = await authority.execute({
      type: 'complete_turn',
      commandId: stableCommandId(`complete:${runtime.turnId}`),
      turnId: runtime.turnId,
      missionConnectionEpoch: completionFence.missionConnectionEpoch,
      cancellationGeneration: completionFence.cancellationGeneration,
      authorizationHandle: completionFence.authorizationHandle,
      stagedDeliveryHandle: staged.handle,
    }, (applied) => {
      if (applied.status === 'applied') abortRuntime(runtime);
    });
    if (result.status !== 'applied' && result.status !== 'replayed') throw rejectedAsError(result);
  };

  const consumeProviderEvents = async (
    runtime: TurnRuntime,
    connection: MistralConversationProviderConnection,
  ): Promise<string> => {
    if (!authority) gatewayError('temporarily_unavailable');
    for await (const event of connection.events()) {
      if (!isRuntimeCurrent(runtime)) gatewayError('aborted');
      if (!isIntegerBetween(event.providerSequence, 0, UINT32_MAX)) gatewayError('provider_error');
      if (event.type === 'provider_error') gatewayError('provider_error');
      const result = await authority.execute({
        type: 'record_transcript',
        commandId: stableCommandId(`provider:${runtime.turnId}:${event.providerSequence}`),
        turnId: runtime.turnId,
        providerSequence: event.providerSequence,
        text: event.text,
        final: event.type === 'transcript_final',
      });
      if (result.status !== 'applied' && result.status !== 'replayed') throw rejectedAsError(result);
      if (!isRuntimeCurrent(runtime)) gatewayError('aborted');
      if (event.type === 'transcript_final') return event.text;
    }
    gatewayError('provider_error');
  };

  const sendProviderAudio = async (
    runtime: TurnRuntime,
    connection: MistralConversationProviderConnection,
  ): Promise<void> => {
    for (;;) {
      const message = await runtime.audio.next({ signal: runtime.controller.signal });
      if (!isRuntimeCurrent(runtime)) gatewayError('aborted');
      if (message.type === 'commit') {
        await runWithDeadline({
          parentSignal: runtime.controller.signal,
          timeoutMs: operationTimeoutMs,
          timeoutCode: 'provider_error',
          operation: (operationSignal) => connection.commitAudio({ signal: operationSignal }),
        });
        runtime.responseDeadline.arm();
        return;
      }
      await runWithDeadline({
        parentSignal: runtime.controller.signal,
        timeoutMs: operationTimeoutMs,
        timeoutCode: 'provider_error',
        operation: (operationSignal) => connection.sendAudio(message.pcm, { signal: operationSignal }),
      });
    }
  };

  const runProviderTurn = async (runtime: TurnRuntime): Promise<void> => {
    try {
      const opening = dependencies.provider.openTurn({
        sessionHandle: grant?.sessionHandle ?? '',
        turnId: runtime.turnId,
        maxAudioMs: MISTRAL_CONVERSATION_MAX_TURN_AUDIO_MS + MISTRAL_CONVERSATION_MAX_PRE_ROLL_MS,
        signal: runtime.controller.signal,
      });
      const connection = await runWithDeadline({
        parentSignal: runtime.controller.signal,
        timeoutMs: operationTimeoutMs,
        timeoutCode: 'provider_error',
        operation: () => opening,
      }).catch((error: unknown) => {
        void opening.then((late) => closeProviderConnection(late), () => undefined);
        throw error;
      });
      if (!isRuntimeCurrent(runtime)) {
        await closeProviderConnection(connection);
        return;
      }
      runtime.connection = connection;
      const transcriptTask = Promise.race([
        consumeProviderEvents(runtime, connection),
        runtime.responseDeadline.promise,
      ]);
      const ingestTask = runWithDeadline({
        parentSignal: runtime.controller.signal,
        timeoutMs: MISTRAL_CONVERSATION_MAX_TURN_AUDIO_MS + MISTRAL_CONVERSATION_MAX_PRE_ROLL_MS,
        timeoutCode: 'provider_error',
        operation: () => sendProviderAudio(runtime, connection),
      });
      const [transcript] = await Promise.all([transcriptTask, ingestTask]);
      runtime.responseDeadline.clear();
      await closeProviderConnection(connection);
      runtime.connection = null;
      if (!isRuntimeCurrent(runtime)) return;
      await runPipeline(runtime, transcript);
    } catch (error) {
      if (!isRuntimeCurrent(runtime) || runtime.controller.signal.aborted) return;
      try {
        await failRuntime(
          runtime,
          error instanceof MistralConversationGatewayV2Error && error.code === 'backpressure'
            ? 'backpressure'
            : error instanceof MistralConversationGatewayV2Error && error.code === 'context_stale'
              ? 'context_stale'
              : 'temporarily_unavailable',
        );
      } catch (fatal) {
        ingress.fail(mapProtocolError(fatal));
        lifecycle.abort();
      }
    } finally {
      runtime.responseDeadline.clear();
      if (runtime.connection) await closeProviderConnection(runtime.connection);
      runtime.connection = null;
    }
  };

  const launchRuntime = (
    snapshot: MistralConversationDurableSnapshot,
    previous: TurnRuntime | null,
  ): void => {
    abortRuntime(previous);
    const turn = snapshot.turn;
    if (!turn || !turn.turnId || turn.ordinal === null) gatewayError('temporarily_unavailable');
    const runtime: TurnRuntime = {
      generation: ++runtimeGeneration,
      turnId: turn.turnId,
      clientTurnId: turn.clientTurnId,
      ordinal: turn.ordinal,
      controller: new AbortController(),
      audio: new BoundedAsyncQueue<ProviderAudioMessage>({
        maxValues: MAX_PROVIDER_AUDIO_MESSAGES,
        maxBytes: MAX_PROVIDER_AUDIO_BYTES,
        sizeOf: (message) => message.type === 'audio' ? message.pcm.byteLength : 0,
        overflow: () => new MistralConversationGatewayV2Error('backpressure'),
      }),
      connection: null,
      commitQueued: false,
      responseDeadline: createResponseDeadline(providerResponseTimeoutMs),
      task: null,
    };
    activeRuntime = runtime;
    runtime.task = runProviderTurn(runtime);
    void runtime.task.catch(() => undefined);
  };

  const recordRecoverableError = async (error: MistralConversationGatewayV2Error): Promise<void> => {
    await durableError(wireError(error.code), true);
  };

  const handleStart = async (
    control: Extract<MistralConversationClientControl, { readonly type: 'turn.start' }>,
  ): Promise<void> => {
    if (!authority) gatewayError('temporarily_unavailable');
    if (
      authority.snapshot.mission.contextRevision !== control.contextRevision
      || authority.snapshot.mission.contextDigest !== control.contextDigest
      || !await authorizeContext(
        'start_turn',
        control.contextRevision,
        control.contextDigest,
        lifecycle.signal,
      )
    ) {
      await recordRecoverableError(new MistralConversationGatewayV2Error('context_stale'));
      return;
    }
    const assigned = {
      turnId: stableOpaqueId(`turn:${control.clientTurnId}`),
      bargeInCancellationId: stableCancellationId(`barge:${control.clientTurnId}`),
    };
    const previous = activeRuntime;
    const result = await authority.execute({
      type: 'start_turn',
      commandId: `start:${control.clientTurnId}`,
      control,
      turnId: assigned.turnId,
      bargeInCancellationId: assigned.bargeInCancellationId,
    }, (applied) => {
      if (applied.status === 'applied') launchRuntime(applied.snapshot, previous);
    });
    if (result.status === 'applied' || result.status === 'replayed') return;
    const error = rejectedAsError(result);
    if (error.code === 'route_uncertified' || error.code === 'invalid_state') {
      await recordRecoverableError(error);
      return;
    }
    throw error;
  };

  const handleAudio = async (frame: MistralConversationAudioFrame): Promise<void> => {
    if (!authority) gatewayError('temporarily_unavailable');
    const runtime = activeRuntime;
    if (!runtime || frame.turnOrdinal !== runtime.ordinal) gatewayError('sequence_error');
    const result = await authority.execute({
      type: 'ingest_audio',
      commandId: `audio:${runtime.turnId}:${frame.audioSequence}`,
      frame: {
        turnOrdinal: frame.turnOrdinal,
        audioSequence: frame.audioSequence,
        audioBytes: frame.pcm.byteLength,
        audioSha256: sha256(frame.pcm),
      },
    }, (applied) => {
      if (applied.status !== 'applied') return;
      if (!isRuntimeCurrent(runtime)) gatewayError('invalid_state');
      if (!runtime.audio.push({ type: 'audio', pcm: Uint8Array.from(frame.pcm) })) {
        gatewayError('backpressure');
      }
    });
    if (result.status !== 'applied' && result.status !== 'replayed') throw rejectedAsError(result);
  };

  const handleCommit = async (
    control: Extract<MistralConversationClientControl, { readonly type: 'turn.commit' }>,
  ): Promise<void> => {
    if (!authority) gatewayError('temporarily_unavailable');
    const runtime = activeRuntime;
    if (!runtime || runtime.clientTurnId !== control.clientTurnId) gatewayError('invalid_state');
    const result = await authority.execute({
      type: 'commit_turn',
      commandId: `commit:${control.clientTurnId}:${control.lastAudioSequence}`,
      control,
    }, (applied) => {
      if (applied.status !== 'applied') return;
      if (!isRuntimeCurrent(runtime)) gatewayError('invalid_state');
      if (!runtime.commitQueued) {
        runtime.commitQueued = true;
        if (!runtime.audio.push({ type: 'commit' })) gatewayError('backpressure');
      }
    });
    if (result.status !== 'applied' && result.status !== 'replayed') throw rejectedAsError(result);
  };

  const handleCancel = async (
    control: Extract<MistralConversationClientControl, { readonly type: 'turn.cancel' }>,
  ): Promise<void> => {
    if (!authority) gatewayError('temporarily_unavailable');
    const runtime = activeRuntime;
    const result = await authority.execute({
      type: 'cancel_turn',
      commandId: `cancel:${control.cancellationId}`,
      control,
    }, (applied) => {
      if (applied.status === 'applied') abortRuntime(runtime);
    });
    if (result.status === 'applied' || result.status === 'replayed') return;
    const error = rejectedAsError(result);
    if (error.code === 'invalid_state') {
      await recordRecoverableError(error);
      return;
    }
    throw error;
  };

  const handleContext = async (
    control: Extract<MistralConversationClientControl, { readonly type: 'context.update' }>,
  ): Promise<void> => {
    if (!authority) gatewayError('temporarily_unavailable');
    if (!await authorizeContext(
      'update_context',
      control.contextRevision,
      control.contextDigest,
      lifecycle.signal,
    )) {
      await recordRecoverableError(new MistralConversationGatewayV2Error('context_stale'));
      return;
    }
    const result = await authority.execute({
      type: 'update_context',
      commandId: `context:${control.contextRevision}:${control.contextDigest}`,
      control,
    });
    if (result.status === 'applied' || result.status === 'replayed') return;
    const error = rejectedAsError(result);
    if (error.code === 'invalid_state' || error.code === 'context_stale') {
      await recordRecoverableError(new MistralConversationGatewayV2Error('context_stale'));
      return;
    }
    throw error;
  };

  const handleEventsAck = async (
    control: Extract<MistralConversationClientControl, { readonly type: 'events.ack' }>,
  ): Promise<void> => {
    if (!authority) gatewayError('temporarily_unavailable');
    const result = await authority.execute({
      type: 'ack_events',
      commandId: `ack:${control.missionConnectionEpoch}:${control.nextServerSequence}`,
      control,
    });
    if (result.status === 'applied' || result.status === 'replayed') return;
    throw rejectedAsError(result);
  };

  const drainAndClose = async (
    reason: MistralConversationSessionEndReason,
    signal: AbortSignal = lifecycle.signal,
  ): Promise<void> => {
    if (!authority || phase === 'closed') return;
    stopAdmissionHeartbeat();
    phase = 'draining';
    const terminalEvents: MistralConversationServerEvent[] = [];
    let result = await authority.execute({
      type: 'drain',
      commandId: stableCommandId(`drain:${reason}`),
      reason,
      cancellationId: stableCancellationId(`drain:${reason}`),
    }, (applied) => {
      if (applied.status === 'applied') abortRuntime(activeRuntime);
    }, signal, false);
    if (result.status !== 'applied' && result.status !== 'replayed') throw rejectedAsError(result);
    terminalEvents.push(...result.events);
    result = await authority.execute({
      type: 'close',
      commandId: stableCommandId(`close:${reason}`),
    }, undefined, signal, false);
    if (result.status !== 'applied' && result.status !== 'replayed') throw rejectedAsError(result);
    terminalEvents.push(...result.events);
    phase = 'closed';
    await sendEvents(terminalEvents, signal);
  };

  let terminalError: MistralConversationGatewayV2Error | null = null;
  const handshake = new AbortController();
  const onLifecycleHandshakeAbort = (): void => handshake.abort();
  lifecycle.signal.addEventListener('abort', onLifecycleHandshakeAbort, { once: true });
  const authTimer = setTimeout(() => {
    if (fatalIngressError === null) {
      authTimedOut = true;
      fatalIngressError = new MistralConversationGatewayV2Error('auth_timeout');
    }
    ingress.fail(fatalIngressError);
    handshake.abort();
  }, authTimeoutMs);
  type AuthenticatedHandshake =
    | {
        readonly kind: 'bootstrap';
        readonly companyId: string;
        readonly resumeNextServerSequence: number;
        readonly opened: Extract<MistralConversationBootstrapOpenResult, {
          readonly status: 'opened';
        }>;
      }
    | {
        readonly kind: 'resume';
        readonly companyId: string;
        readonly resumeNextServerSequence: number;
        readonly opened: Extract<MistralConversationRedeemAndOpenResult, {
          readonly status: 'terminal_replay' | 'live_takeover';
        }>;
      };
  const consumeHandshake = async (): Promise<AuthenticatedHandshake> => {
    let message: IngressMessage | null = await ingress.next({ signal: handshake.signal });
    let rawText = asText(message);
    let auth: MistralConversationClientControl | null = decodeMistralConversationClientControl(rawText);
    if (auth.type !== 'authenticate') gatewayError('authentication_failed');
    const companyId = auth.companyId;
    const resumeNextServerSequence = auth.resumeNextServerSequence;
    const resumeScope = auth.resumeScope;
    let rawTicket = auth.ticket;
    phase = 'opening';
    try {
      if (isMistralConversationResumeTicket(rawTicket)) {
        if (resumeScope === undefined) gatewayError('authentication_failed');
        resumeHandshakeActive = true;
        if (
          typeof dependencies.resume?.redeemAndOpen !== 'function'
          || typeof dependencies.resume.acknowledgeTerminal !== 'function'
        ) gatewayError('temporarily_unavailable');
        const resumed = await runWithDeadline({
          parentSignal: handshake.signal,
          timeoutMs: authTimeoutMs,
          timeoutCode: 'auth_timeout',
          operation: (operationSignal) => dependencies.resume!.redeemAndOpen({
            companyId,
            ticket: rawTicket,
            protocol: MISTRAL_CONVERSATION_PROTOCOL,
            // Le scope explicite vient du bootstrap HTTP authentifié et est comparé sous lock
            // avant toute mutation SQL. Une capacité live ne peut jamais être rabattue en replay.
            expectedScope: resumeScope,
            resumeNextServerSequence,
            maxReplayEvents: MAX_OPEN_REPLAY_EVENTS,
            maxReplayBytes: MAX_OPEN_REPLAY_BYTES,
            signal: operationSignal,
          }),
        });
        if (resumed.status !== 'terminal_replay' && resumed.status !== 'live_takeover') {
          if (resumed.status === 'expired') gatewayError('expired');
          if (resumed.status === 'invalid_cursor') gatewayError('sequence_error');
          if (resumed.status === 'aborted') gatewayError('aborted');
          if (
            resumed.status === 'invalid'
            || resumed.status === 'replayed'
            || resumed.status === 'stale_epoch'
            || resumed.status === 'scope_mismatch'
          ) gatewayError('authentication_failed');
          gatewayError('temporarily_unavailable');
        }
        resumeRedemptionCommitted = true;
        return {
          kind: 'resume',
          companyId,
          resumeNextServerSequence,
          opened: resumed,
        };
      }
      if (resumeScope !== undefined) gatewayError('authentication_failed');
      ownerLeaseToken = validateEntropyValue(entropy.ownerLeaseToken(), OWNER_TOKEN);
      const opened = await runWithDeadline({
        parentSignal: handshake.signal,
        timeoutMs: authTimeoutMs,
        timeoutCode: 'auth_timeout',
        operation: (operationSignal) => dependencies.bootstrap.redeemAndOpenInitial({
          companyId,
          ticket: rawTicket,
          protocol: MISTRAL_CONVERSATION_PROTOCOL,
          ownerLeaseToken,
          resumeNextServerSequence,
          maxReplayEvents: MAX_OPEN_REPLAY_EVENTS,
          maxReplayBytes: MAX_OPEN_REPLAY_BYTES,
          signal: operationSignal,
        }),
      });
      if (opened.status !== 'opened') {
        if (opened.status === 'expired') gatewayError('expired');
        if (opened.status === 'invalid_cursor') gatewayError('sequence_error');
        if (opened.status === 'unavailable') gatewayError('temporarily_unavailable');
        if (opened.status === 'aborted') gatewayError('aborted');
        gatewayError('authentication_failed');
      }
      return {
        kind: 'bootstrap',
        companyId,
        resumeNextServerSequence,
        opened,
      };
    } finally {
      // Les strings JS ne sont pas effaçables en place ; cette frame courte ne survit pas au consume.
      rawTicket = '';
      rawText = '';
      auth = null;
      message = null;
    }
  };
  try {
    const authenticated = await consumeHandshake();
    let opened: MistralConversationDurableOpenResult
      | Extract<MistralConversationRedeemAndOpenResult, {
        readonly status: 'terminal_replay';
      }>;
    let connectionGrant: MistralConversationBootstrapGrant;
    let hardExpiry: number;
    if (authenticated.kind === 'bootstrap') {
      connectionGrant = authenticated.opened.grant;
      hardExpiry = validateGrant(connectionGrant, authenticated.companyId, now());
      opened = authenticated.opened;
    } else {
      const resumed = authenticated.opened;
      connectionGrant = resumed.grant;
      if (resumed.status === 'live_takeover') {
        hardExpiry = validateGrant(connectionGrant, authenticated.companyId, now());
        ownerLeaseToken = validateEntropyValue(resumed.ownerLeaseToken, OWNER_TOKEN);
        opened = {
          status: 'recovered',
          snapshot: resumed.snapshot,
          replayFromServerSequence: resumed.replayFromServerSequence,
          events: resumed.events,
          recovery: resumed.recovery,
          terminal: null,
        };
      } else {
        hardExpiry = validateGrantBinding(connectionGrant, authenticated.companyId);
        opened = resumed;
      }
    }
    grant = connectionGrant;
    if (
      opened.status !== 'opened'
      && opened.status !== 'recovered'
      && opened.status !== 'replayed'
      && opened.status !== 'terminal_replay'
    ) {
      if (opened.status === 'expired') gatewayError('expired');
      if (opened.status === 'invalid_cursor') gatewayError('sequence_error');
      gatewayError('temporarily_unavailable');
    }
    if (opened.status === 'terminal_replay') {
      validateTerminalOpenResult(opened, connectionGrant, authenticated.resumeNextServerSequence);
      terminalReplayOpened = true;
      clearTimeout(authTimer);
      const replayGraceExpiry = canonicalEpoch(opened.terminal.replayGraceExpiresAt);
      if (replayGraceExpiry === null) gatewayError('temporarily_unavailable');
      const replayClock = now();
      let replayBudgetMs = Math.min(
        replayTimeoutMs,
        replayGraceExpiry - replayClock - MAX_SERVER_CLOCK_SKEW_MS,
      );
      let resumeAuthority: MistralConversationResumeAuthority | null = null;
      let acknowledgement: Extract<
        MistralConversationRedeemAndOpenResult,
        { readonly status: 'terminal_replay' }
      >['terminalAcknowledgement'] | null = null;
      let acknowledgementExpiry: number | null = null;
      if (authenticated.kind === 'resume') {
        if (authenticated.opened.status !== 'terminal_replay') {
          gatewayError('temporarily_unavailable');
        }
        resumeAuthority = dependencies.resume ?? null;
        acknowledgement = authenticated.opened.terminalAcknowledgement;
        acknowledgementExpiry = canonicalEpoch(acknowledgement?.expiresAt ?? '');
        if (
          !resumeAuthority
          || !acknowledgement
          || !isMistralConversationReplayConnectionId(acknowledgement.replayConnectionId)
          || !isMistralConversationConnectionLeaseToken(
            acknowledgement.connectionLeaseToken,
          )
          || acknowledgementExpiry === null
          || new Date(acknowledgementExpiry).toISOString() !== acknowledgement.expiresAt
          || acknowledgementExpiry > replayGraceExpiry
          || acknowledgementExpiry - replayClock
            > MAX_TERMINAL_ACK_CAPABILITY_MS + MAX_SERVER_CLOCK_SKEW_MS
          || acknowledgementExpiry - replayClock
            <= MISTRAL_CONVERSATION_TERMINAL_ACK_RESERVE_MS
              + MAX_SERVER_CLOCK_SKEW_MS
        ) gatewayError('temporarily_unavailable');
        // Le TTL de la capacité démarre avant le replay. Réserve + skew garantissent qu'un envoi
        // autorisé par la deadline ne peut pas consommer la fenêtre d'ACK selon l'horloge BDD.
        replayBudgetMs = Math.min(
          replayBudgetMs,
          acknowledgementExpiry - replayClock
            - MISTRAL_CONVERSATION_TERMINAL_ACK_RESERVE_MS
            - MAX_SERVER_CLOCK_SKEW_MS,
        );
        phase = 'replay_only';
      }
      if (replayBudgetMs <= 0) gatewayError('expired');
      await runWithDeadline({
        parentSignal: handshake.signal,
        timeoutMs: replayBudgetMs,
        timeoutCode: 'backpressure',
        operation: (replaySignal) => sendEvents(opened.events, replaySignal),
      });
      if (authenticated.kind === 'resume') {
        if (!resumeAuthority || !acknowledgement || acknowledgementExpiry === null) {
          gatewayError('temporarily_unavailable');
        }
        const finalCursor = opened.snapshot.nextServerSequence;
        if (opened.snapshot.acknowledgedServerSequence < finalCursor) {
          const acknowledgementBudgetMs = Math.min(
            replayTimeoutMs,
            acknowledgementExpiry - now() - MAX_SERVER_CLOCK_SKEW_MS,
            replayGraceExpiry - now() - MAX_SERVER_CLOCK_SKEW_MS,
          );
          if (acknowledgementBudgetMs > 0) {
            let connectionLeaseToken = acknowledgement.connectionLeaseToken;
            try {
              await runWithDeadline({
                parentSignal: handshake.signal,
                timeoutMs: acknowledgementBudgetMs,
                // L'absence d'ACK est une fermeture normale : le mobile redemandera un ticket.
                timeoutCode: 'aborted',
                operation: async (ackSignal) => {
                  while (!ackSignal.aborted) {
                    const message = await ingress.next({ signal: ackSignal });
                    if (message.receivedPhase === 'auth' || message.isBinary) {
                      gatewayError('protocol_error');
                    }
                    const control = decodeMistralConversationClientControl(asText(message));
                    if (
                      control.type !== 'events.ack'
                      || control.missionConnectionEpoch
                        !== opened.snapshot.missionConnectionEpoch
                      || control.nextServerSequence > finalCursor
                    ) {
                      acceptedResumeAcknowledgements = Math.max(
                        0,
                        acceptedResumeAcknowledgements - 1,
                      );
                      gatewayError('protocol_error');
                    }
                    let acknowledged: Awaited<
                      ReturnType<MistralConversationResumeAuthority['acknowledgeTerminal']>
                    >;
                    try {
                      acknowledged = await runWithDeadline({
                        parentSignal: ackSignal,
                        timeoutMs: Math.min(operationTimeoutMs, acknowledgementBudgetMs),
                        timeoutCode: 'temporarily_unavailable',
                        operation: (operationSignal) => resumeAuthority.acknowledgeTerminal({
                          companyId: connectionGrant.companyId,
                          subjectHash: connectionGrant.subjectHash,
                          sessionHandle: connectionGrant.sessionHandle,
                          missionConnectionEpoch: opened.snapshot.missionConnectionEpoch,
                          replayConnectionId: acknowledgement.replayConnectionId,
                          connectionLeaseToken,
                          nextServerSequence: control.nextServerSequence,
                          signal: operationSignal,
                        }),
                      });
                    } finally {
                      acceptedResumeAcknowledgements = Math.max(
                        0,
                        acceptedResumeAcknowledgements - 1,
                      );
                    }
                    if (
                      acknowledged.status === 'invalid'
                      || acknowledged.status === 'unavailable'
                    ) {
                      gatewayError('temporarily_unavailable');
                    }
                    if (acknowledged.status === 'expired' || acknowledged.status === 'aborted') {
                      return;
                    }
                    if (control.nextServerSequence === finalCursor) return;
                  }
                },
              });
            } catch (error) {
              const acknowledgementError = fatalIngressError ?? mapProtocolError(error);
              if (acknowledgementError.code !== 'aborted') throw acknowledgementError;
            } finally {
              connectionLeaseToken = '';
            }
          }
        }
      }
      phase = 'closed';
      lifecycle.signal.removeEventListener('abort', onLifecycleHandshakeAbort);
      if (fatalIngressError) throw fatalIngressError;
      return;
    }
    validateOpenResult(opened, connectionGrant, authenticated.resumeNextServerSequence);
    openingRecovery = opened.recovery;
    clearTimeout(authTimer);
    authority = new SerializedAuthority(
      dependencies.authority,
      {
        companyId: connectionGrant.companyId,
        subjectHash: connectionGrant.subjectHash,
        sessionHandle: connectionGrant.sessionHandle,
        ownerLeaseToken,
      },
      opened.snapshot,
      sendEvents,
      lifecycle.signal,
      operationTimeoutMs,
    );
    await startAdmissionHeartbeat(
      connectionGrant,
      opened.snapshot.missionConnectionEpoch,
      handshake.signal,
    );
    const readyBudgetMs = Math.min(replayTimeoutMs, hardExpiry - now());
    if (readyBudgetMs <= 0) gatewayError('expired');
    await runWithDeadline({
      parentSignal: handshake.signal,
      timeoutMs: readyBudgetMs,
      timeoutCode: 'expired',
      operation: (readySignal) => sendEvents(opened.events, readySignal),
    });
    phase = 'ready';
    lifecycle.signal.removeEventListener('abort', onLifecycleHandshakeAbort);
    if (fatalIngressError) throw fatalIngressError;
    const remainingMs = hardExpiry - now();
    if (remainingMs <= 0) gatewayError('expired');
    hardExpiryTimer = setTimeout(() => {
      // Un session.end déjà accepté reste l'unique cause terminale, même si son commit durable
      // franchit ensuite l'échéance de la mission. La deadline de transition borne toujours l'I/O.
      if (terminalDisposition !== null) return;
      latchTerminalDisposition('expired', 'expired');
      fatalIngressError = new MistralConversationGatewayV2Error('expired');
      ingress.fail(fatalIngressError);
      lifecycle.abort();
    }, remainingMs);

    while (phase === 'ready') {
      const message = await ingress.next({ signal: lifecycle.signal });
      // Seul un ACK explicitement reçu pendant le replay peut traverser la barrière.
      // Toute seconde frame pré-auth reste une authentification pipelinée interdite.
      if (message.receivedPhase === 'auth') gatewayError('protocol_error');
      if (message.isBinary) {
        const frame = decodeMistralConversationAudioFrame(socketBytes(message.data));
        await handleAudio(frame);
        continue;
      }
      const control = decodeMistralConversationClientControl(asText(message));
      if (control.type === 'authenticate') gatewayError('protocol_error');
      if (control.type === 'turn.start') await handleStart(control);
      else if (control.type === 'turn.commit') await handleCommit(control);
      else if (control.type === 'turn.cancel') await handleCancel(control);
      else if (control.type === 'context.update') await handleContext(control);
      else if (control.type === 'events.ack') {
        const isHistoricalRecoveryAck = openingRecovery !== null
          && control.missionConnectionEpoch === openingRecovery.previousMissionConnectionEpoch
          && control.nextServerSequence <= openingRecovery.fromServerSequence;
        // Le mobile peut ACKer, immédiatement ou après scheduling, un événement historique vu
        // avant route_recovering. La corrélation epoch+borne suffit : cet ACK de l'ancien owner
        // est ignoré, jamais appliqué au snapshot du nouvel epoch ni interprété comme une attaque.
        if (!isHistoricalRecoveryAck) await handleEventsAck(control);
      } else if (control.type === 'session.end') {
        const disposition = latchTerminalDisposition('client', control.reason);
        await drainAndClose(disposition.reason);
      } else {
        const unhandled: never = control;
        void unhandled;
        gatewayError('protocol_error');
      }
    }
  } catch (error) {
    terminalError = authTimedOut
      ? new MistralConversationGatewayV2Error('auth_timeout')
      : fatalIngressError ?? mapProtocolError(error);
    if (terminalError.code === 'expired') {
      latchTerminalDisposition('expired', 'expired');
    }
  } finally {
    clearTimeout(authTimer);
    handshake.abort();
    lifecycle.signal.removeEventListener('abort', onLifecycleHandshakeAbort);
    if (hardExpiryTimer) clearTimeout(hardExpiryTimer);
    stopAdmissionHeartbeat();
    ingress.fail(new MistralConversationGatewayV2Error('aborted'));
    lifecycle.abort();
    if (authority) {
      const settlementController = new AbortController();
      const settlementTimer = setTimeout(() => settlementController.abort(), cleanupTimeoutMs);
      try {
        await runWithDeadline({
          parentSignal: settlementController.signal,
          timeoutMs: cleanupTimeoutMs,
          timeoutCode: 'temporarily_unavailable',
          operation: () => authority?.settled() ?? Promise.resolve(),
        });
      } catch {
        // Le cleanup durable ci-dessous possède sa propre deadline et sa propre lease.
      } finally {
        clearTimeout(settlementTimer);
        settlementController.abort();
      }
    }
    const preserveDurableMission = admissionOwnershipLost || (
      routeLost
      && terminalDisposition === null
      && terminationReason === 'fatal_error'
      && (terminalError?.code === 'aborted' || terminalError?.code === 'backpressure')
    );
    if (authority && !preserveDurableMission) {
      const cleanup = new AbortController();
      const cleanupTimer = setTimeout(() => cleanup.abort(), cleanupTimeoutMs);
      try {
        await drainAndClose(terminationReason, cleanup.signal);
      } catch {
        // Sans ACK durable, aucun succès terminal n'est inventé sur le wire.
      } finally {
        clearTimeout(cleanupTimer);
        cleanup.abort();
      }
    }
    if (authority?.snapshot.mission.phase === 'closed') {
      const release = new AbortController();
      const releaseTimer = setTimeout(() => release.abort(), cleanupTimeoutMs);
      try {
        await releaseClosedAdmission(release.signal);
      } catch {
        // Le bail reste visible et sera repris par le reaper ; aucune suppression non prouvée.
      } finally {
        clearTimeout(releaseTimer);
        release.abort();
      }
    }
    // Sur perte de route, le takeover suivant annule atomiquement le tour et rejoue l'outbox.
    // Pour toute terminaison produit/serveur, le cleanup durable reste fail-closed ci-dessus.
    abortRuntime(activeRuntime);
    phase = 'closed';
    socket.off('message', onMessage);
    socket.off('close', onClose);
    socket.off('error', onError);
    input.signal?.removeEventListener('abort', onExternalAbort);
    ownerLeaseToken = '';
    admissionOwner = null;

    if (socket.readyState === 1) {
      if (!authority && !terminalReplayOpened && terminalError && terminalError.code !== 'aborted') {
        const preAuthEvent: MistralConversationServerEvent = {
          type: 'error',
          serverSequence: 0,
          code: wireError(terminalError.code),
          retryable: terminalError.code === 'temporarily_unavailable',
        };
        try {
          const closeController = new AbortController();
          await sendEvents([preAuthEvent], closeController.signal);
          closeController.abort();
        } catch {
          // La fermeture reste la seule sortie sûre si le downlink est déjà saturé.
        }
      }
      const gracefulShutdown = terminalError?.code === 'aborted' && isServiceShutdown(terminationReason);
      const code = terminalError && !gracefulShutdown ? closeCode(terminalError.code) : 1000;
      const reason = terminalError && !gracefulShutdown
        ? closeReason(terminalError.code)
        : 'session_closed';
      socket.close(code, reason);
    } else if (socket.readyState !== 3) {
      socket.terminate();
    }
  }

  if (terminalError && terminalError.code !== 'aborted' && terminalError.code !== 'expired') {
    throw terminalError;
  }
}

/** Adapter de test/référence : mappe les erreurs pures vers le vocabulaire du port durable. */
export function mistralConversationTransitionRejection(error: unknown): MistralConversationTransitionRejection {
  return transitionRejection(error);
}
