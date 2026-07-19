/**
 * Contrat provider-neutral de la conversation Bob Live opérée avec les briques Mistral.
 *
 * Ce module ne connaît ni WebSocket, ni Nest, ni React Native, ni Voxtral. Il fixe seulement :
 * - les messages texte stricts du protocole `bob.mistral-pcm.v2` ;
 * - l'enveloppe binaire PCM16 mono 16 kHz ;
 * - les machines de mission et de tour, pures et rejouables.
 *
 * Toute donnée invalide échoue fermée. Les erreurs ne recopient jamais le payload reçu afin de
 * ne pas faire fuiter ticket, transcript ou identifiant dans les logs.
 */

export const MISTRAL_CONVERSATION_PROTOCOL = 'bob.mistral-pcm.v2' as const;
export const MISTRAL_CONVERSATION_PROTOCOL_VERSION = 2 as const;
export const MISTRAL_CONVERSATION_SAMPLE_RATE_HZ = 16_000 as const;
export const MISTRAL_CONVERSATION_CHANNELS = 1 as const;
export const MISTRAL_CONVERSATION_SAMPLE_BYTES = 2 as const;
export const MISTRAL_CONVERSATION_AUDIO_QUANTUM_MS = 10 as const;
export const MISTRAL_CONVERSATION_AUDIO_QUANTUM_BYTES = 320 as const;
export const MISTRAL_CONVERSATION_MAX_AUDIO_FRAME_BYTES = 3_200 as const;
export const MISTRAL_CONVERSATION_MAX_PRE_ROLL_MS = 300 as const;
export const MISTRAL_CONVERSATION_MAX_TURN_AUDIO_MS = 120_000 as const;
export const MISTRAL_CONVERSATION_MAX_TURN_AUDIO_BYTES = 3_849_600 as const;
export const MISTRAL_CONVERSATION_MAX_MISSION_AUDIO_BYTES = 28_800_000 as const;
export const MISTRAL_CONVERSATION_MAX_CLIENT_CONTROL_BYTES = 2_048 as const;
export const MISTRAL_CONVERSATION_MAX_SERVER_EVENT_BYTES = 16_384 as const;

const UINT32_MAX = 0xffff_ffff;
const UINT32_CURSOR_END = UINT32_MAX + 1;
const INT32_MAX = 0x7fff_ffff;
const FRAME_HEADER_BYTES = 20;
const FRAME_MAGIC = Uint8Array.of(0x42, 0x4f, 0x42, 0x32); // BOB2
const FRAME_ENCODING_PCM_S16LE = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TENANT_ID = /^[A-Za-z0-9-]{1,64}$/u;
const CAPABILITY = /^[A-Za-z0-9_-]{32,128}$/u;
const OPAQUE_ID = /^[A-Za-z0-9_-]{16,128}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export type MistralConversationProtocolErrorCode =
  | 'invalid_json'
  | 'message_too_large'
  | 'invalid_message'
  | 'invalid_frame'
  | 'invalid_state_transition'
  | 'stale_after_cancellation'
  | 'sequence_error'
  | 'audio_budget_exceeded'
  | 'cancellation_conflict';

export class MistralConversationProtocolError extends Error {
  constructor(readonly code: MistralConversationProtocolErrorCode) {
    super(code);
    this.name = 'MistralConversationProtocolError';
  }
}

export type MistralConversationCancelReason =
  | 'barge_in'
  | 'user'
  | 'context_changed'
  | 'route_lost'
  | 'network_backpressure'
  | 'session_ending'
  | 'timeout';

export type MistralConversationRouteMode = 'push_to_talk' | 'full_duplex';
export type MistralConversationResumeScope = 'live_takeover' | 'terminal_replay';

/** Raisons qu'un client est autorisé à déclarer lui-même. Les causes serveur restent serveur. */
export type MistralConversationClientSessionEndReason =
  | 'user'
  | 'background'
  | 'context_changed'
  | 'client_handoff';

export type MistralConversationClientControl =
  | {
      readonly type: 'authenticate';
      readonly protocol: typeof MISTRAL_CONVERSATION_PROTOCOL;
      readonly companyId: string;
      readonly ticket: string;
      /** Absent pour le bootstrap initial ; obligatoire pour toute capacité de reprise `r2_`. */
      readonly resumeScope?: MistralConversationResumeScope;
      /** Première séquence serveur qui n'a encore produit aucun effet local. */
      readonly resumeNextServerSequence: number;
    }
  | {
      readonly type: 'turn.start';
      readonly clientTurnId: string;
      readonly contextRevision: number;
      readonly contextDigest: string;
      readonly vadStartedAtMs: number;
      readonly preRollMs: number;
    }
  | {
      readonly type: 'turn.commit';
      readonly clientTurnId: string;
      readonly lastAudioSequence: number;
      readonly vadEndedAtMs: number;
    }
  | {
      readonly type: 'turn.cancel';
      readonly clientTurnId: string;
      readonly cancellationId: string;
      readonly reason: MistralConversationCancelReason;
    }
  | {
      readonly type: 'context.update';
      readonly contextRevision: number;
      readonly contextDigest: string;
    }
  | {
      /** ACK cumulatif émis uniquement après application locale de tous les événements précédents. */
      readonly type: 'events.ack';
      readonly missionConnectionEpoch: number;
      readonly nextServerSequence: number;
    }
  | {
      readonly type: 'session.end';
      readonly reason: MistralConversationClientSessionEndReason;
    };

export type MistralConversationTurnPhaseEvent =
  | 'transcribing'
  | 'reasoning'
  | 'rendering'
  | 'delivering';

export type MistralConversationSessionEndReason =
  | 'user'
  | 'background'
  | 'context_changed'
  | 'client_handoff'
  | 'expired'
  | 'service_shutdown'
  | 'fatal_error';

export type MistralConversationServerErrorCode =
  | 'authentication_failed'
  | 'ticket_expired'
  | 'protocol_error'
  | 'invalid_state'
  | 'sequence_error'
  | 'audio_budget_exceeded'
  | 'backpressure'
  | 'context_stale'
  | 'route_uncertified'
  | 'temporarily_unavailable'
  | 'session_expired'
  | 'internal_error';

interface MistralConversationServerEnvelope {
  readonly serverSequence: number;
}

interface MistralConversationServerTurnCorrelation extends MistralConversationServerEnvelope {
  readonly clientTurnId: string;
  readonly turnId: string;
  readonly ordinal: number;
}

export type MistralConversationServerEvent =
  | (MistralConversationServerEnvelope & {
      readonly type: 'session.ready';
      readonly sessionHandle: string;
      readonly missionConnectionEpoch: number;
      readonly expiresAt: string;
      readonly contextRevision: number;
      readonly contextDigest: string;
      readonly routeMode: MistralConversationRouteMode;
      readonly fullDuplexCertified: boolean;
      readonly nextAudioSequence: number;
      readonly maxMissionAudioBytes: number;
    })
  | (MistralConversationServerTurnCorrelation & {
      readonly type: 'turn.started';
      readonly contextRevision: number;
      readonly contextDigest: string;
      readonly cancellationGeneration: number;
      readonly firstAudioSequence: number;
      readonly vadStartedAtMs: number;
      readonly preRollMs: number;
    })
  | (MistralConversationServerTurnCorrelation & {
      readonly type: 'turn.committed';
      readonly lastAudioSequence: number;
      readonly vadEndedAtMs: number;
    })
  | (MistralConversationServerTurnCorrelation & {
      readonly type: 'turn.phase';
      readonly phase: MistralConversationTurnPhaseEvent;
    })
  | (MistralConversationServerTurnCorrelation & {
      readonly type: 'turn.transcript';
      readonly text: string;
      readonly final: boolean;
    })
  | (MistralConversationServerTurnCorrelation & {
      readonly type: 'turn.cancelled';
      readonly cancellationId: string;
      readonly cancellationGeneration: number;
    })
  | (MistralConversationServerTurnCorrelation & {
      readonly type: 'turn.completed';
    })
  | (MistralConversationServerEnvelope & {
      readonly type: 'session.route_recovering';
      readonly cancellationGeneration: number;
    })
  | (MistralConversationServerEnvelope & {
      readonly type: 'session.route_recovered';
      readonly missionConnectionEpoch: number;
      readonly routeMode: MistralConversationRouteMode;
      readonly fullDuplexCertified: boolean;
    })
  | (MistralConversationServerEnvelope & {
      readonly type: 'session.context_updated';
      readonly contextRevision: number;
      readonly contextDigest: string;
    })
  | (MistralConversationServerEnvelope & {
      readonly type: 'session.draining';
      readonly reason: MistralConversationSessionEndReason;
      readonly cancellationGeneration: number;
    })
  | (MistralConversationServerEnvelope & {
      readonly type: 'session.closed';
      readonly reason: MistralConversationSessionEndReason;
    })
  | (MistralConversationServerEnvelope & {
      readonly type: 'error';
      readonly code: MistralConversationServerErrorCode;
      readonly retryable: boolean;
    });

export interface MistralConversationAudioFrame {
  readonly turnOrdinal: number;
  readonly audioSequence: number;
  readonly pcm: Uint8Array;
}

type JsonRecord = Record<string, unknown>;

function fail(code: MistralConversationProtocolErrorCode): never {
  throw new MistralConversationProtocolError(code);
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: JsonRecord, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function isIntegerBetween(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && !Object.is(value, -0)
    && value >= minimum
    && value <= maximum;
}

function isCanonicalIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) return false;
  try {
    return new Date(epoch).toISOString() === value;
  } catch {
    return false;
  }
}

function hasValidUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function hasDisallowedControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code <= 0x08
      || code === 0x0b
      || code === 0x0c
      || (code >= 0x0e && code <= 0x1f)
      || code === 0x7f
    ) return true;
  }
  return false;
}

function isBoundedTranscript(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 4_000
    && hasValidUnicode(value)
    && !hasDisallowedControlCharacter(value)
    && new TextEncoder().encode(value).byteLength <= 8_000;
}

function parseStrictJson(raw: unknown, maximumBytes: number): JsonRecord {
  if (typeof raw !== 'string') fail('invalid_json');
  const size = new TextEncoder().encode(raw).byteLength;
  if (size === 0) fail('invalid_json');
  if (size > maximumBytes) fail('message_too_large');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    fail('invalid_json');
  }
  if (!isRecord(parsed)) fail('invalid_message');
  return parsed;
}

function stringifyStrict(value: unknown, maximumBytes: number): string {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    fail('invalid_message');
  }
  if (typeof encoded !== 'string') fail('invalid_message');
  if (new TextEncoder().encode(encoded).byteLength > maximumBytes) fail('message_too_large');
  return encoded;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_ID.test(value);
}

function isContextRevision(value: unknown): value is number {
  return isIntegerBetween(value, 1, INT32_MAX);
}

function isContextDigest(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value);
}

function isUint32(value: unknown): value is number {
  return isIntegerBetween(value, 0, UINT32_MAX);
}

/** Le curseur désigne la prochaine séquence ; MAX+1 est donc la sentinelle terminale valide. */
function isServerSequenceCursor(value: unknown): value is number {
  return isIntegerBetween(value, 0, UINT32_CURSOR_END);
}

function isPositiveUint32(value: unknown): value is number {
  return isIntegerBetween(value, 1, UINT32_MAX);
}

function isCancellationGeneration(value: unknown): value is number {
  return isUint32(value);
}

function isCancelReason(value: unknown): value is MistralConversationCancelReason {
  return value === 'barge_in'
    || value === 'user'
    || value === 'context_changed'
    || value === 'route_lost'
    || value === 'network_backpressure'
    || value === 'session_ending'
    || value === 'timeout';
}

function isClientSessionEndReason(value: unknown): value is MistralConversationClientSessionEndReason {
  return value === 'user'
    || value === 'background'
    || value === 'context_changed'
    || value === 'client_handoff';
}

function isRouteMode(value: unknown): value is MistralConversationRouteMode {
  return value === 'push_to_talk' || value === 'full_duplex';
}

function isRouteCertificationConsistent(mode: unknown, certified: unknown): boolean {
  return isRouteMode(mode)
    && typeof certified === 'boolean'
    // Une route certifiée peut rester volontairement en push-to-talk (kill-switch, préférence,
    // réseau dégradé). L'inverse est interdit : aucun full-duplex sans preuve signée.
    && (mode !== 'full_duplex' || certified);
}

/** Décode un contrôle client texte. Aucun champ inconnu ou coercition n'est accepté. */
export function decodeMistralConversationClientControl(raw: unknown): MistralConversationClientControl {
  const value = parseStrictJson(raw, MISTRAL_CONVERSATION_MAX_CLIENT_CONTROL_BYTES);
  switch (value.type) {
    case 'authenticate':
      if (
        !(
          hasExactKeys(value, ['type', 'protocol', 'companyId', 'ticket', 'resumeNextServerSequence'])
          || hasExactKeys(value, [
            'type',
            'protocol',
            'companyId',
            'ticket',
            'resumeScope',
            'resumeNextServerSequence',
          ])
        )
        || value.protocol !== MISTRAL_CONVERSATION_PROTOCOL
        || typeof value.companyId !== 'string'
        || !TENANT_ID.test(value.companyId)
        || typeof value.ticket !== 'string'
        || !CAPABILITY.test(value.ticket)
        || (
          value.resumeScope !== undefined
          && value.resumeScope !== 'live_takeover'
          && value.resumeScope !== 'terminal_replay'
        )
        || !isServerSequenceCursor(value.resumeNextServerSequence)
      ) fail('invalid_message');
      return {
        type: 'authenticate',
        protocol: MISTRAL_CONVERSATION_PROTOCOL,
        companyId: value.companyId,
        ticket: value.ticket,
        ...(value.resumeScope === undefined ? {} : { resumeScope: value.resumeScope }),
        resumeNextServerSequence: value.resumeNextServerSequence,
      };
    case 'turn.start':
      if (
        !hasExactKeys(value, [
          'type',
          'clientTurnId',
          'contextRevision',
          'contextDigest',
          'vadStartedAtMs',
          'preRollMs',
        ])
        || !isUuid(value.clientTurnId)
        || !isContextRevision(value.contextRevision)
        || !isContextDigest(value.contextDigest)
        || !isIntegerBetween(value.vadStartedAtMs, 0, Number.MAX_SAFE_INTEGER)
        || !isIntegerBetween(value.preRollMs, 0, MISTRAL_CONVERSATION_MAX_PRE_ROLL_MS)
      ) fail('invalid_message');
      return {
        type: 'turn.start',
        clientTurnId: value.clientTurnId,
        contextRevision: value.contextRevision,
        contextDigest: value.contextDigest,
        vadStartedAtMs: value.vadStartedAtMs,
        preRollMs: value.preRollMs,
      };
    case 'turn.commit':
      if (
        !hasExactKeys(value, ['type', 'clientTurnId', 'lastAudioSequence', 'vadEndedAtMs'])
        || !isUuid(value.clientTurnId)
        || !isUint32(value.lastAudioSequence)
        || !isIntegerBetween(value.vadEndedAtMs, 0, Number.MAX_SAFE_INTEGER)
      ) fail('invalid_message');
      return {
        type: 'turn.commit',
        clientTurnId: value.clientTurnId,
        lastAudioSequence: value.lastAudioSequence,
        vadEndedAtMs: value.vadEndedAtMs,
      };
    case 'turn.cancel':
      if (
        !hasExactKeys(value, ['type', 'clientTurnId', 'cancellationId', 'reason'])
        || !isUuid(value.clientTurnId)
        || !isUuid(value.cancellationId)
        || !isCancelReason(value.reason)
      ) fail('invalid_message');
      return {
        type: 'turn.cancel',
        clientTurnId: value.clientTurnId,
        cancellationId: value.cancellationId,
        reason: value.reason,
      };
    case 'context.update':
      if (
        !hasExactKeys(value, ['type', 'contextRevision', 'contextDigest'])
        || !isContextRevision(value.contextRevision)
        || !isContextDigest(value.contextDigest)
      ) fail('invalid_message');
      return {
        type: 'context.update',
        contextRevision: value.contextRevision,
        contextDigest: value.contextDigest,
      };
    case 'events.ack':
      if (
        !hasExactKeys(value, ['type', 'missionConnectionEpoch', 'nextServerSequence'])
        || !isIntegerBetween(value.missionConnectionEpoch, 1, INT32_MAX)
        || !isServerSequenceCursor(value.nextServerSequence)
      ) fail('invalid_message');
      return {
        type: 'events.ack',
        missionConnectionEpoch: value.missionConnectionEpoch,
        nextServerSequence: value.nextServerSequence,
      };
    case 'session.end':
      if (
        !hasExactKeys(value, ['type', 'reason'])
        || !isClientSessionEndReason(value.reason)
      ) fail('invalid_message');
      return { type: 'session.end', reason: value.reason };
    default:
      return fail('invalid_message');
  }
}

/** Encode après une nouvelle validation runtime, y compris quand l'objet vient de JavaScript. */
export function encodeMistralConversationClientControl(
  message: MistralConversationClientControl,
): string {
  const encoded = stringifyStrict(message, MISTRAL_CONVERSATION_MAX_CLIENT_CONTROL_BYTES);
  decodeMistralConversationClientControl(encoded);
  return encoded;
}

function parseTurnCorrelation(value: JsonRecord): MistralConversationServerTurnCorrelation | null {
  return isUint32(value.serverSequence)
    && isUuid(value.clientTurnId)
    && isOpaqueId(value.turnId)
    && isPositiveUint32(value.ordinal)
    ? {
        serverSequence: value.serverSequence,
        clientTurnId: value.clientTurnId,
        turnId: value.turnId,
        ordinal: value.ordinal,
      }
    : null;
}

function isTurnPhaseEvent(value: unknown): value is MistralConversationTurnPhaseEvent {
  return value === 'transcribing'
    || value === 'reasoning'
    || value === 'rendering'
    || value === 'delivering';
}

function isSessionEndReason(value: unknown): value is MistralConversationSessionEndReason {
  return value === 'user'
    || value === 'background'
    || value === 'context_changed'
    || value === 'client_handoff'
    || value === 'expired'
    || value === 'service_shutdown'
    || value === 'fatal_error';
}

function isServerErrorCode(value: unknown): value is MistralConversationServerErrorCode {
  return value === 'authentication_failed'
    || value === 'ticket_expired'
    || value === 'protocol_error'
    || value === 'invalid_state'
    || value === 'sequence_error'
    || value === 'audio_budget_exceeded'
    || value === 'backpressure'
    || value === 'context_stale'
    || value === 'route_uncertified'
    || value === 'temporarily_unavailable'
    || value === 'session_expired'
    || value === 'internal_error';
}

/** Décode les événements émis par notre gateway, jamais les événements bruts du fournisseur. */
export function decodeMistralConversationServerEvent(raw: unknown): MistralConversationServerEvent {
  const value = parseStrictJson(raw, MISTRAL_CONVERSATION_MAX_SERVER_EVENT_BYTES);
  if (!isUint32(value.serverSequence)) fail('invalid_message');
  switch (value.type) {
    case 'session.ready':
      if (
        !hasExactKeys(value, [
          'type',
          'serverSequence',
          'sessionHandle',
          'missionConnectionEpoch',
          'expiresAt',
          'contextRevision',
          'contextDigest',
          'routeMode',
          'fullDuplexCertified',
          'nextAudioSequence',
          'maxMissionAudioBytes',
        ])
        || !isOpaqueId(value.sessionHandle)
        || !isIntegerBetween(value.missionConnectionEpoch, 1, INT32_MAX)
        || !isCanonicalIsoDate(value.expiresAt)
        || !isContextRevision(value.contextRevision)
        || !isContextDigest(value.contextDigest)
        || !isRouteCertificationConsistent(value.routeMode, value.fullDuplexCertified)
        || !isUint32(value.nextAudioSequence)
        || !isIntegerBetween(
          value.maxMissionAudioBytes,
          MISTRAL_CONVERSATION_AUDIO_QUANTUM_BYTES,
          MISTRAL_CONVERSATION_MAX_MISSION_AUDIO_BYTES,
        )
        || value.maxMissionAudioBytes % MISTRAL_CONVERSATION_AUDIO_QUANTUM_BYTES !== 0
      ) fail('invalid_message');
      return {
        type: 'session.ready',
        serverSequence: value.serverSequence,
        sessionHandle: value.sessionHandle,
        missionConnectionEpoch: value.missionConnectionEpoch,
        expiresAt: value.expiresAt,
        contextRevision: value.contextRevision,
        contextDigest: value.contextDigest,
        routeMode: value.routeMode as MistralConversationRouteMode,
        fullDuplexCertified: value.fullDuplexCertified as boolean,
        nextAudioSequence: value.nextAudioSequence,
        maxMissionAudioBytes: value.maxMissionAudioBytes,
      };
    case 'turn.started': {
      const turn = parseTurnCorrelation(value);
      if (
        !turn
        || !hasExactKeys(value, [
          'type',
          'serverSequence',
          'clientTurnId',
          'turnId',
          'ordinal',
          'contextRevision',
          'contextDigest',
          'cancellationGeneration',
          'firstAudioSequence',
          'vadStartedAtMs',
          'preRollMs',
        ])
        || !isContextRevision(value.contextRevision)
        || !isContextDigest(value.contextDigest)
        || !isCancellationGeneration(value.cancellationGeneration)
        || !isUint32(value.firstAudioSequence)
        || !isIntegerBetween(value.vadStartedAtMs, 0, Number.MAX_SAFE_INTEGER)
        || !isIntegerBetween(value.preRollMs, 0, MISTRAL_CONVERSATION_MAX_PRE_ROLL_MS)
      ) fail('invalid_message');
      return {
        type: 'turn.started',
        ...turn,
        contextRevision: value.contextRevision,
        contextDigest: value.contextDigest,
        cancellationGeneration: value.cancellationGeneration,
        firstAudioSequence: value.firstAudioSequence,
        vadStartedAtMs: value.vadStartedAtMs,
        preRollMs: value.preRollMs,
      };
    }
    case 'turn.committed': {
      const turn = parseTurnCorrelation(value);
      if (
        !turn
        || !hasExactKeys(value, [
          'type',
          'serverSequence',
          'clientTurnId',
          'turnId',
          'ordinal',
          'lastAudioSequence',
          'vadEndedAtMs',
        ])
        || !isUint32(value.lastAudioSequence)
        || !isIntegerBetween(value.vadEndedAtMs, 0, Number.MAX_SAFE_INTEGER)
      ) fail('invalid_message');
      return {
        type: 'turn.committed',
        ...turn,
        lastAudioSequence: value.lastAudioSequence,
        vadEndedAtMs: value.vadEndedAtMs,
      };
    }
    case 'turn.phase': {
      const turn = parseTurnCorrelation(value);
      if (
        !turn
        || !hasExactKeys(value, [
          'type', 'serverSequence', 'clientTurnId', 'turnId', 'ordinal', 'phase',
        ])
        || !isTurnPhaseEvent(value.phase)
      ) fail('invalid_message');
      return { type: 'turn.phase', ...turn, phase: value.phase };
    }
    case 'turn.transcript': {
      const turn = parseTurnCorrelation(value);
      if (
        !turn
        || !hasExactKeys(value, [
          'type', 'serverSequence', 'clientTurnId', 'turnId', 'ordinal', 'text', 'final',
        ])
        || !isBoundedTranscript(value.text)
        || typeof value.final !== 'boolean'
      ) fail('invalid_message');
      return { type: 'turn.transcript', ...turn, text: value.text, final: value.final };
    }
    case 'turn.cancelled': {
      const turn = parseTurnCorrelation(value);
      if (
        !turn
        || !hasExactKeys(value, [
          'type',
          'serverSequence',
          'clientTurnId',
          'turnId',
          'ordinal',
          'cancellationId',
          'cancellationGeneration',
        ])
        || !isUuid(value.cancellationId)
        || !isCancellationGeneration(value.cancellationGeneration)
      ) fail('invalid_message');
      return {
        type: 'turn.cancelled',
        ...turn,
        cancellationId: value.cancellationId,
        cancellationGeneration: value.cancellationGeneration,
      };
    }
    case 'turn.completed': {
      const turn = parseTurnCorrelation(value);
      if (
        !turn
        || !hasExactKeys(value, ['type', 'serverSequence', 'clientTurnId', 'turnId', 'ordinal'])
      ) fail('invalid_message');
      return { type: 'turn.completed', ...turn };
    }
    case 'session.route_recovering':
      if (
        !hasExactKeys(value, ['type', 'serverSequence', 'cancellationGeneration'])
        || !isCancellationGeneration(value.cancellationGeneration)
      ) fail('invalid_message');
      return {
        type: 'session.route_recovering',
        serverSequence: value.serverSequence,
        cancellationGeneration: value.cancellationGeneration,
      };
    case 'session.route_recovered':
      if (
        !hasExactKeys(value, [
          'type', 'serverSequence', 'missionConnectionEpoch', 'routeMode', 'fullDuplexCertified',
        ])
        || !isIntegerBetween(value.missionConnectionEpoch, 1, INT32_MAX)
        || !isRouteCertificationConsistent(value.routeMode, value.fullDuplexCertified)
      ) fail('invalid_message');
      return {
        type: 'session.route_recovered',
        serverSequence: value.serverSequence,
        missionConnectionEpoch: value.missionConnectionEpoch,
        routeMode: value.routeMode as MistralConversationRouteMode,
        fullDuplexCertified: value.fullDuplexCertified as boolean,
      };
    case 'session.context_updated':
      if (
        !hasExactKeys(value, ['type', 'serverSequence', 'contextRevision', 'contextDigest'])
        || !isContextRevision(value.contextRevision)
        || !isContextDigest(value.contextDigest)
      ) fail('invalid_message');
      return {
        type: 'session.context_updated',
        serverSequence: value.serverSequence,
        contextRevision: value.contextRevision,
        contextDigest: value.contextDigest,
      };
    case 'session.draining':
      if (
        !hasExactKeys(value, ['type', 'serverSequence', 'reason', 'cancellationGeneration'])
        || !isSessionEndReason(value.reason)
        || !isCancellationGeneration(value.cancellationGeneration)
      ) fail('invalid_message');
      return {
        type: 'session.draining',
        serverSequence: value.serverSequence,
        reason: value.reason,
        cancellationGeneration: value.cancellationGeneration,
      };
    case 'session.closed':
      if (
        !hasExactKeys(value, ['type', 'serverSequence', 'reason'])
        || !isSessionEndReason(value.reason)
      ) fail('invalid_message');
      return { type: 'session.closed', serverSequence: value.serverSequence, reason: value.reason };
    case 'error':
      if (
        !hasExactKeys(value, ['type', 'serverSequence', 'code', 'retryable'])
        || !isServerErrorCode(value.code)
        || typeof value.retryable !== 'boolean'
      ) fail('invalid_message');
      return {
        type: 'error',
        serverSequence: value.serverSequence,
        code: value.code,
        retryable: value.retryable,
      };
    default:
      return fail('invalid_message');
  }
}

export function encodeMistralConversationServerEvent(event: MistralConversationServerEvent): string {
  const encoded = stringifyStrict(event, MISTRAL_CONVERSATION_MAX_SERVER_EVENT_BYTES);
  decodeMistralConversationServerEvent(encoded);
  return encoded;
}

function asBytes(raw: unknown): Uint8Array {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  return fail('invalid_frame');
}

function validatePcmLength(length: number): void {
  if (
    length < MISTRAL_CONVERSATION_AUDIO_QUANTUM_BYTES
    || length > MISTRAL_CONVERSATION_MAX_AUDIO_FRAME_BYTES
    || length % MISTRAL_CONVERSATION_AUDIO_QUANTUM_BYTES !== 0
  ) fail('invalid_frame');
}

/**
 * Enveloppe BOB2 (big-endian) : magic[4], version[1], encoding[1], headerBytes[2],
 * turnOrdinal[4], audioSequence[4], payloadBytes[4], puis PCM s16le.
 */
export function encodeMistralConversationAudioFrame(input: MistralConversationAudioFrame): Uint8Array {
  if (!isPositiveUint32(input.turnOrdinal) || !isUint32(input.audioSequence)) fail('invalid_frame');
  if (!(input.pcm instanceof Uint8Array)) fail('invalid_frame');
  validatePcmLength(input.pcm.byteLength);
  const encoded = new Uint8Array(FRAME_HEADER_BYTES + input.pcm.byteLength);
  encoded.set(FRAME_MAGIC, 0);
  const view = new DataView(encoded.buffer);
  view.setUint8(4, MISTRAL_CONVERSATION_PROTOCOL_VERSION);
  view.setUint8(5, FRAME_ENCODING_PCM_S16LE);
  view.setUint16(6, FRAME_HEADER_BYTES, false);
  view.setUint32(8, input.turnOrdinal, false);
  view.setUint32(12, input.audioSequence, false);
  view.setUint32(16, input.pcm.byteLength, false);
  encoded.set(input.pcm, FRAME_HEADER_BYTES);
  return encoded;
}

export function decodeMistralConversationAudioFrame(raw: unknown): MistralConversationAudioFrame {
  const bytes = asBytes(raw);
  if (
    bytes.byteLength < FRAME_HEADER_BYTES + MISTRAL_CONVERSATION_AUDIO_QUANTUM_BYTES
    || bytes.byteLength > FRAME_HEADER_BYTES + MISTRAL_CONVERSATION_MAX_AUDIO_FRAME_BYTES
  ) fail('invalid_frame');
  for (let index = 0; index < FRAME_MAGIC.byteLength; index += 1) {
    if (bytes[index] !== FRAME_MAGIC[index]) fail('invalid_frame');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const payloadBytes = view.getUint32(16, false);
  if (
    view.getUint8(4) !== MISTRAL_CONVERSATION_PROTOCOL_VERSION
    || view.getUint8(5) !== FRAME_ENCODING_PCM_S16LE
    || view.getUint16(6, false) !== FRAME_HEADER_BYTES
    || view.getUint32(8, false) === 0
    || payloadBytes !== bytes.byteLength - FRAME_HEADER_BYTES
  ) fail('invalid_frame');
  validatePcmLength(payloadBytes);
  return {
    turnOrdinal: view.getUint32(8, false),
    audioSequence: view.getUint32(12, false),
    // Copie défensive : le buffer réseau peut être réutilisé immédiatement après le décodage.
    pcm: Uint8Array.from(bytes.subarray(FRAME_HEADER_BYTES)),
  };
}

export type MistralConversationMissionPhase =
  | 'connecting'
  | 'ready'
  | 'turn_active'
  | 'response_active'
  | 'recovering_route'
  | 'draining'
  | 'closed';

export interface MistralConversationMissionTurn {
  readonly clientTurnId: string;
  readonly turnId: string;
  readonly ordinal: number;
  readonly contextRevision: number;
  readonly contextDigest: string;
  readonly cancellationGeneration: number;
  readonly firstAudioSequence: number;
  readonly lastAudioSequence: number | null;
  readonly vadStartedAtMs: number;
  readonly preRollMs: number;
}

export interface MistralConversationTerminalTurn {
  readonly clientTurnId: string;
  readonly turnId: string;
  readonly ordinal: number;
  readonly outcome: 'completed' | 'cancelled';
  readonly cancellationId: string | null;
}

export interface MistralConversationMissionState {
  readonly phase: MistralConversationMissionPhase;
  readonly sessionHandle: string | null;
  readonly missionConnectionEpoch: number;
  readonly expiresAt: string | null;
  readonly contextRevision: number;
  readonly contextDigest: string | null;
  readonly routeMode: MistralConversationRouteMode | null;
  readonly fullDuplexCertified: boolean;
  readonly lastTurnOrdinal: number;
  /** Peut valoir UINT32_MAX + 1 comme sentinelle terminale anti-wrap. */
  readonly nextAudioSequence: number;
  readonly maxMissionAudioBytes: number;
  readonly audioBytes: number;
  readonly lastVadTimestampMs: number | null;
  readonly cancellationGeneration: number;
  readonly activeTurn: MistralConversationMissionTurn | null;
  readonly lastTerminalTurn: MistralConversationTerminalTurn | null;
  readonly lastCancellationId: string | null;
  readonly routeRecoveryCancellationId: string | null;
  readonly drainCancellationId: string | null;
  readonly drainReason: MistralConversationSessionEndReason | null;
}

export const INITIAL_MISTRAL_CONVERSATION_MISSION_STATE: MistralConversationMissionState = {
  phase: 'connecting',
  sessionHandle: null,
  missionConnectionEpoch: 0,
  expiresAt: null,
  contextRevision: 0,
  contextDigest: null,
  routeMode: null,
  fullDuplexCertified: false,
  lastTurnOrdinal: 0,
  nextAudioSequence: 0,
  maxMissionAudioBytes: 0,
  audioBytes: 0,
  lastVadTimestampMs: null,
  cancellationGeneration: 0,
  activeTurn: null,
  lastTerminalTurn: null,
  lastCancellationId: null,
  routeRecoveryCancellationId: null,
  drainCancellationId: null,
  drainReason: null,
};

interface MissionTurnActivation {
  readonly clientTurnId: string;
  readonly turnId: string;
  readonly ordinal: number;
  readonly contextRevision: number;
  readonly contextDigest: string;
  readonly firstAudioSequence: number;
  readonly vadStartedAtMs: number;
  readonly preRollMs: number;
}

interface MissionCancellation {
  readonly cancellationId: string;
  readonly cancellationGeneration: number;
}

export type MistralConversationMissionEvent =
  | {
      readonly type: 'SESSION_READY';
      readonly sessionHandle: string;
      readonly missionConnectionEpoch: number;
      readonly expiresAt: string;
      readonly contextRevision: number;
      readonly contextDigest: string;
      readonly routeMode: MistralConversationRouteMode;
      readonly fullDuplexCertified: boolean;
      readonly nextAudioSequence: number;
      readonly maxMissionAudioBytes: number;
    }
  | ({ readonly type: 'TURN_STARTED' } & MissionTurnActivation)
  | {
      readonly type: 'TURN_AUDIO_INGESTED';
      readonly clientTurnId: string;
      readonly turnId: string;
      readonly ordinal: number;
      readonly audioSequence: number;
      readonly audioBytes: number;
    }
  | {
      readonly type: 'TURN_COMMITTED';
      readonly clientTurnId: string;
      readonly turnId: string;
      readonly ordinal: number;
      readonly lastAudioSequence: number;
      readonly vadEndedAtMs: number;
    }
  | {
      readonly type: 'TURN_COMPLETED';
      readonly clientTurnId: string;
      readonly turnId: string;
      readonly ordinal: number;
    }
  | ({
      readonly type: 'TURN_CANCELLED';
      readonly clientTurnId: string;
      readonly turnId: string;
      readonly ordinal: number;
    } & MissionCancellation)
  | ({
      readonly type: 'BARGE_IN';
      readonly cancelledTurnId: string;
      readonly nextTurn: MissionTurnActivation;
    } & MissionCancellation)
  | {
      readonly type: 'ROUTE_RECOVERY_STARTED';
      readonly cancellation: MissionCancellation | null;
    }
  | {
      readonly type: 'ROUTE_RECOVERED';
      readonly missionConnectionEpoch: number;
      readonly routeMode: MistralConversationRouteMode;
      readonly fullDuplexCertified: boolean;
    }
  | {
      readonly type: 'CONTEXT_UPDATED';
      readonly contextRevision: number;
      readonly contextDigest: string;
    }
  | {
      readonly type: 'DRAIN';
      readonly reason: MistralConversationSessionEndReason;
      readonly cancellation: MissionCancellation | null;
    }
  | { readonly type: 'CLOSE' };

function sameTurnIdentity(
  turn: MistralConversationMissionTurn,
  input: { readonly clientTurnId: string; readonly turnId: string; readonly ordinal: number },
): boolean {
  return turn.clientTurnId === input.clientTurnId
    && turn.turnId === input.turnId
    && turn.ordinal === input.ordinal;
}

function validateCurrentContext(
  state: MistralConversationMissionState,
  revision: number,
  digest: string,
): void {
  if (
    !isContextRevision(revision)
    || !isContextDigest(digest)
    || revision !== state.contextRevision
    || digest !== state.contextDigest
  ) fail('invalid_state_transition');
}

function validateActivation(
  state: MistralConversationMissionState,
  input: MissionTurnActivation,
): MistralConversationMissionTurn {
  if (
    !isUuid(input.clientTurnId)
    || !isOpaqueId(input.turnId)
    || !isPositiveUint32(input.ordinal)
    || input.ordinal !== state.lastTurnOrdinal + 1
    || !isUint32(input.firstAudioSequence)
    || input.firstAudioSequence !== state.nextAudioSequence
    || !isIntegerBetween(input.vadStartedAtMs, 0, Number.MAX_SAFE_INTEGER)
    || (
      state.lastVadTimestampMs !== null
      && input.vadStartedAtMs < state.lastVadTimestampMs
    )
    || !isIntegerBetween(input.preRollMs, 0, MISTRAL_CONVERSATION_MAX_PRE_ROLL_MS)
  ) fail('invalid_state_transition');
  validateCurrentContext(state, input.contextRevision, input.contextDigest);
  return {
    ...input,
    cancellationGeneration: state.cancellationGeneration,
    lastAudioSequence: null,
  };
}

function validateCancellation(
  state: MistralConversationMissionState,
  cancellation: MissionCancellation,
): void {
  if (
    !isUuid(cancellation.cancellationId)
    || !isCancellationGeneration(cancellation.cancellationGeneration)
    || cancellation.cancellationGeneration !== state.cancellationGeneration + 1
  ) fail('cancellation_conflict');
}

function terminalFromActive(
  active: MistralConversationMissionTurn,
  outcome: MistralConversationTerminalTurn['outcome'],
  cancellationId: string | null,
): MistralConversationTerminalTurn {
  return {
    clientTurnId: active.clientTurnId,
    turnId: active.turnId,
    ordinal: active.ordinal,
    outcome,
    cancellationId,
  };
}

/** Machine de mission pure. Toute transition absente de l'ADR est refusée, jamais ignorée. */
export function reduceMistralConversationMissionState(
  state: MistralConversationMissionState,
  event: MistralConversationMissionEvent,
): MistralConversationMissionState {
  switch (event.type) {
    case 'SESSION_READY': {
      if (state.phase !== 'connecting') fail('invalid_state_transition');
      if (
        !isOpaqueId(event.sessionHandle)
        || !isIntegerBetween(event.missionConnectionEpoch, 1, INT32_MAX)
        || !isCanonicalIsoDate(event.expiresAt)
        || !isContextRevision(event.contextRevision)
        || !isContextDigest(event.contextDigest)
        || !isRouteCertificationConsistent(event.routeMode, event.fullDuplexCertified)
        || !isUint32(event.nextAudioSequence)
        || !isIntegerBetween(
          event.maxMissionAudioBytes,
          MISTRAL_CONVERSATION_AUDIO_QUANTUM_BYTES,
          MISTRAL_CONVERSATION_MAX_MISSION_AUDIO_BYTES,
        )
        || event.maxMissionAudioBytes % MISTRAL_CONVERSATION_AUDIO_QUANTUM_BYTES !== 0
      ) fail('invalid_state_transition');
      return {
        ...state,
        phase: 'ready',
        sessionHandle: event.sessionHandle,
        missionConnectionEpoch: event.missionConnectionEpoch,
        expiresAt: event.expiresAt,
        contextRevision: event.contextRevision,
        contextDigest: event.contextDigest,
        routeMode: event.routeMode,
        fullDuplexCertified: event.fullDuplexCertified,
        nextAudioSequence: event.nextAudioSequence,
        maxMissionAudioBytes: event.maxMissionAudioBytes,
      };
    }
    case 'TURN_STARTED': {
      if (state.phase === 'turn_active' && state.activeTurn) {
        const same = sameTurnIdentity(state.activeTurn, event)
          && state.activeTurn.contextRevision === event.contextRevision
          && state.activeTurn.contextDigest === event.contextDigest
          && state.activeTurn.firstAudioSequence === event.firstAudioSequence
          && state.activeTurn.vadStartedAtMs === event.vadStartedAtMs
          && state.activeTurn.preRollMs === event.preRollMs;
        if (same) return state;
      }
      if (state.phase !== 'ready' || state.activeTurn !== null) fail('invalid_state_transition');
      const activeTurn = validateActivation(state, event);
      return {
        ...state,
        phase: 'turn_active',
        contextRevision: event.contextRevision,
        contextDigest: event.contextDigest,
        lastTurnOrdinal: event.ordinal,
        lastVadTimestampMs: event.vadStartedAtMs,
        activeTurn,
      };
    }
    case 'TURN_AUDIO_INGESTED': {
      const active = state.activeTurn;
      if (state.phase !== 'turn_active' || !active || !sameTurnIdentity(active, event)) {
        fail('invalid_state_transition');
      }
      if (!isUint32(event.audioSequence)) fail('sequence_error');
      if (event.audioSequence !== state.nextAudioSequence) fail('sequence_error');
      if (
        !isIntegerBetween(
          event.audioBytes,
          MISTRAL_CONVERSATION_AUDIO_QUANTUM_BYTES,
          MISTRAL_CONVERSATION_MAX_AUDIO_FRAME_BYTES,
        )
        || event.audioBytes % MISTRAL_CONVERSATION_AUDIO_QUANTUM_BYTES !== 0
      ) fail('invalid_frame');
      const audioBytes = state.audioBytes + event.audioBytes;
      if (audioBytes > state.maxMissionAudioBytes) fail('audio_budget_exceeded');
      return {
        ...state,
        audioBytes,
        nextAudioSequence: event.audioSequence === UINT32_MAX
          ? UINT32_CURSOR_END
          : event.audioSequence + 1,
        activeTurn: { ...active, lastAudioSequence: event.audioSequence },
      };
    }
    case 'TURN_COMMITTED': {
      const active = state.activeTurn;
      if (state.phase === 'response_active' && active && sameTurnIdentity(active, event)) {
        if (
          active.lastAudioSequence === event.lastAudioSequence
          && state.lastVadTimestampMs === event.vadEndedAtMs
        ) return state;
        fail('sequence_error');
      }
      if (state.phase !== 'turn_active' || !active || !sameTurnIdentity(active, event)) {
        fail('invalid_state_transition');
      }
      if (
        !isUint32(event.lastAudioSequence)
        || active.lastAudioSequence === null
        || event.lastAudioSequence !== active.lastAudioSequence
      ) fail('sequence_error');
      if (
        !isIntegerBetween(event.vadEndedAtMs, 0, Number.MAX_SAFE_INTEGER)
        || event.vadEndedAtMs < active.vadStartedAtMs
        || event.vadEndedAtMs - active.vadStartedAtMs > MISTRAL_CONVERSATION_MAX_TURN_AUDIO_MS
      ) fail('invalid_state_transition');
      return {
        ...state,
        phase: 'response_active',
        lastVadTimestampMs: event.vadEndedAtMs,
        activeTurn: active,
      };
    }
    case 'TURN_COMPLETED': {
      const active = state.activeTurn;
      if (state.phase === 'ready' && state.lastTerminalTurn) {
        const terminal = state.lastTerminalTurn;
        if (
          terminal.outcome === 'completed'
          && terminal.clientTurnId === event.clientTurnId
          && terminal.turnId === event.turnId
          && terminal.ordinal === event.ordinal
        ) return state;
      }
      if (state.phase !== 'response_active' || !active || !sameTurnIdentity(active, event)) {
        fail('invalid_state_transition');
      }
      return {
        ...state,
        phase: 'ready',
        activeTurn: null,
        lastTerminalTurn: terminalFromActive(active, 'completed', null),
      };
    }
    case 'TURN_CANCELLED': {
      if (state.phase === 'ready' && state.lastTerminalTurn) {
        const terminal = state.lastTerminalTurn;
        if (
          terminal.outcome === 'cancelled'
          && terminal.clientTurnId === event.clientTurnId
          && terminal.turnId === event.turnId
          && terminal.ordinal === event.ordinal
          && terminal.cancellationId === event.cancellationId
          && state.cancellationGeneration === event.cancellationGeneration
        ) return state;
      }
      const active = state.activeTurn;
      if (
        (state.phase !== 'turn_active' && state.phase !== 'response_active')
        || !active
        || !sameTurnIdentity(active, event)
      ) fail('invalid_state_transition');
      validateCancellation(state, event);
      return {
        ...state,
        phase: 'ready',
        cancellationGeneration: event.cancellationGeneration,
        activeTurn: null,
        lastTerminalTurn: terminalFromActive(active, 'cancelled', event.cancellationId),
        lastCancellationId: event.cancellationId,
      };
    }
    case 'BARGE_IN': {
      const active = state.activeTurn;
      if (
        state.phase !== 'response_active'
        || !active
        || active.turnId !== event.cancelledTurnId
      ) fail('invalid_state_transition');
      validateCancellation(state, event);
      const afterCancellation: MistralConversationMissionState = {
        ...state,
        cancellationGeneration: event.cancellationGeneration,
      };
      const nextTurn = validateActivation(afterCancellation, event.nextTurn);
      return {
        ...afterCancellation,
        phase: 'turn_active',
        contextRevision: event.nextTurn.contextRevision,
        contextDigest: event.nextTurn.contextDigest,
        lastTurnOrdinal: event.nextTurn.ordinal,
        lastVadTimestampMs: event.nextTurn.vadStartedAtMs,
        activeTurn: nextTurn,
        lastTerminalTurn: terminalFromActive(active, 'cancelled', event.cancellationId),
        lastCancellationId: event.cancellationId,
      };
    }
    case 'ROUTE_RECOVERY_STARTED': {
      if (state.phase === 'recovering_route') {
        if (
          (event.cancellation === null && state.routeRecoveryCancellationId === null)
          || (
            event.cancellation !== null
            && event.cancellation.cancellationId === state.routeRecoveryCancellationId
            && event.cancellation.cancellationGeneration === state.cancellationGeneration
          )
        ) return state;
      }
      if (
        state.phase !== 'ready'
        && state.phase !== 'turn_active'
        && state.phase !== 'response_active'
      ) fail('invalid_state_transition');
      const active = state.activeTurn;
      if (active && event.cancellation === null) fail('cancellation_conflict');
      if (!active && event.cancellation !== null) fail('cancellation_conflict');
      if (active && event.cancellation) validateCancellation(state, event.cancellation);
      return {
        ...state,
        phase: 'recovering_route',
        cancellationGeneration: event.cancellation?.cancellationGeneration ?? state.cancellationGeneration,
        activeTurn: null,
        lastTerminalTurn: active
          ? terminalFromActive(active, 'cancelled', event.cancellation?.cancellationId ?? null)
          : state.lastTerminalTurn,
        lastCancellationId: event.cancellation?.cancellationId ?? state.lastCancellationId,
        routeRecoveryCancellationId: event.cancellation?.cancellationId ?? null,
      };
    }
    case 'ROUTE_RECOVERED':
      if (state.phase !== 'recovering_route') fail('invalid_state_transition');
      if (
        !isIntegerBetween(event.missionConnectionEpoch, 1, INT32_MAX)
        || event.missionConnectionEpoch !== state.missionConnectionEpoch + 1
        || !isRouteCertificationConsistent(event.routeMode, event.fullDuplexCertified)
      ) fail('invalid_state_transition');
      return {
        ...state,
        phase: 'ready',
        missionConnectionEpoch: event.missionConnectionEpoch,
        routeMode: event.routeMode,
        fullDuplexCertified: event.fullDuplexCertified,
        routeRecoveryCancellationId: null,
      };
    case 'CONTEXT_UPDATED':
      if (state.phase !== 'ready' || state.activeTurn !== null) fail('invalid_state_transition');
      if (!isContextRevision(event.contextRevision) || !isContextDigest(event.contextDigest)) {
        fail('invalid_state_transition');
      }
      if (
        event.contextRevision === state.contextRevision
        && event.contextDigest === state.contextDigest
      ) return state;
      if (event.contextRevision <= state.contextRevision) fail('invalid_state_transition');
      return {
        ...state,
        contextRevision: event.contextRevision,
        contextDigest: event.contextDigest,
      };
    case 'DRAIN': {
      if (state.phase === 'draining') {
        if (
          state.drainReason === event.reason
          && (
            (event.cancellation === null && state.drainCancellationId === null)
            || (
              event.cancellation !== null
              && event.cancellation.cancellationId === state.drainCancellationId
              && event.cancellation.cancellationGeneration === state.cancellationGeneration
            )
          )
        ) return state;
        fail('invalid_state_transition');
      }
      if (state.phase === 'closed') fail('invalid_state_transition');
      const active = state.activeTurn;
      if (active && event.cancellation === null) fail('cancellation_conflict');
      if (!active && event.cancellation !== null) fail('cancellation_conflict');
      if (active && event.cancellation) validateCancellation(state, event.cancellation);
      return {
        ...state,
        phase: 'draining',
        cancellationGeneration: event.cancellation?.cancellationGeneration ?? state.cancellationGeneration,
        activeTurn: null,
        lastTerminalTurn: active
          ? terminalFromActive(active, 'cancelled', event.cancellation?.cancellationId ?? null)
          : state.lastTerminalTurn,
        lastCancellationId: event.cancellation?.cancellationId ?? state.lastCancellationId,
        drainCancellationId: event.cancellation?.cancellationId ?? null,
        drainReason: event.reason,
      };
    }
    case 'CLOSE':
      if (state.phase === 'closed') return state;
      if (state.phase !== 'draining') fail('invalid_state_transition');
      return { ...state, phase: 'closed' };
  }
}

export type MistralConversationTurnPhase =
  | 'created'
  | 'ingesting'
  | 'committed'
  | 'transcribing'
  | 'reasoning'
  | 'rendering'
  | 'delivering'
  | 'completed'
  | 'cancel_requested'
  | 'cancelled';

export interface MistralConversationTurnState {
  readonly phase: MistralConversationTurnPhase;
  readonly clientTurnId: string;
  readonly contextRevision: number;
  readonly contextDigest: string;
  readonly vadStartedAtMs: number;
  readonly preRollMs: number;
  readonly turnId: string | null;
  readonly ordinal: number | null;
  readonly cancellationGeneration: number;
  readonly firstAudioSequence: number | null;
  readonly nextAudioSequence: number | null;
  readonly lastAudioSequence: number | null;
  readonly audioBytes: number;
  readonly vadEndedAtMs: number | null;
  readonly cancellationId: string | null;
  readonly cancellationReason: MistralConversationCancelReason | null;
}

export type MistralConversationTurnEvent =
  | {
      readonly type: 'ACCEPT';
      readonly turnId: string;
      readonly ordinal: number;
      readonly cancellationGeneration: number;
      readonly firstAudioSequence: number;
    }
  | {
      readonly type: 'AUDIO_INGESTED';
      readonly ordinal: number;
      readonly audioSequence: number;
      readonly audioBytes: number;
    }
  | {
      readonly type: 'COMMIT';
      readonly lastAudioSequence: number;
      readonly vadEndedAtMs: number;
    }
  | { readonly type: 'START_TRANSCRIPTION' }
  | { readonly type: 'START_REASONING' }
  | { readonly type: 'START_RENDERING' }
  | { readonly type: 'START_DELIVERY' }
  | { readonly type: 'COMPLETE' }
  | {
      readonly type: 'REQUEST_CANCEL';
      readonly cancellationId: string;
      readonly cancellationGeneration: number;
      readonly reason: MistralConversationCancelReason;
    }
  | {
      readonly type: 'CONFIRM_CANCEL';
      readonly cancellationId: string;
      readonly cancellationGeneration: number;
    };

export function createMistralConversationTurnState(
  start: Extract<MistralConversationClientControl, { readonly type: 'turn.start' }>,
): MistralConversationTurnState {
  // Le passage par le codec garantit le même contrat côté état et côté wire.
  const validated = decodeMistralConversationClientControl(
    encodeMistralConversationClientControl(start),
  );
  if (validated.type !== 'turn.start') fail('invalid_state_transition');
  return {
    phase: 'created',
    clientTurnId: validated.clientTurnId,
    contextRevision: validated.contextRevision,
    contextDigest: validated.contextDigest,
    vadStartedAtMs: validated.vadStartedAtMs,
    preRollMs: validated.preRollMs,
    turnId: null,
    ordinal: null,
    cancellationGeneration: 0,
    firstAudioSequence: null,
    nextAudioSequence: null,
    lastAudioSequence: null,
    audioBytes: 0,
    vadEndedAtMs: null,
    cancellationId: null,
    cancellationReason: null,
  };
}

const TURN_PHASE_RANK: Readonly<Record<Exclude<MistralConversationTurnPhase, 'cancel_requested' | 'cancelled'>, number>> = {
  created: 0,
  ingesting: 1,
  committed: 2,
  transcribing: 3,
  reasoning: 4,
  rendering: 5,
  delivering: 6,
  completed: 7,
};

function isCancellationPhase(
  phase: MistralConversationTurnPhase,
): phase is Extract<MistralConversationTurnPhase, 'cancel_requested' | 'cancelled'> {
  return phase === 'cancel_requested' || phase === 'cancelled';
}

function advanceTurnPhase(
  state: MistralConversationTurnState,
  expected: MistralConversationTurnPhase,
  target: MistralConversationTurnPhase,
): MistralConversationTurnState {
  if (isCancellationPhase(state.phase)) fail('stale_after_cancellation');
  if (state.phase === target) return state;
  if (state.phase === 'completed') fail('invalid_state_transition');
  const currentRank = TURN_PHASE_RANK[state.phase];
  const targetRank = TURN_PHASE_RANK[target as keyof typeof TURN_PHASE_RANK];
  if (currentRank !== undefined && targetRank !== undefined && currentRank > targetRank) {
    fail('invalid_state_transition');
  }
  if (state.phase !== expected) fail('invalid_state_transition');
  return { ...state, phase: target };
}

/** Machine de tour CAS-friendly : phases linéaires, annulation monotone et replays idempotents. */
export function reduceMistralConversationTurnState(
  state: MistralConversationTurnState,
  event: MistralConversationTurnEvent,
): MistralConversationTurnState {
  if (event.type !== 'REQUEST_CANCEL' && event.type !== 'CONFIRM_CANCEL' && isCancellationPhase(state.phase)) {
    fail('stale_after_cancellation');
  }
  switch (event.type) {
    case 'ACCEPT':
      if (state.phase === 'ingesting') {
        if (
          state.turnId === event.turnId
          && state.ordinal === event.ordinal
          && state.cancellationGeneration === event.cancellationGeneration
          && state.firstAudioSequence === event.firstAudioSequence
        ) return state;
        fail('invalid_state_transition');
      }
      if (
        state.phase !== 'created'
        || !isOpaqueId(event.turnId)
        || !isPositiveUint32(event.ordinal)
        || !isCancellationGeneration(event.cancellationGeneration)
        || !isUint32(event.firstAudioSequence)
      ) fail('invalid_state_transition');
      return {
        ...state,
        phase: 'ingesting',
        turnId: event.turnId,
        ordinal: event.ordinal,
        cancellationGeneration: event.cancellationGeneration,
        firstAudioSequence: event.firstAudioSequence,
        nextAudioSequence: event.firstAudioSequence,
      };
    case 'AUDIO_INGESTED': {
      if (state.phase !== 'ingesting' || state.ordinal === null || state.nextAudioSequence === null) {
        fail('invalid_state_transition');
      }
      if (
        event.ordinal !== state.ordinal
        || !isUint32(event.audioSequence)
        || event.audioSequence !== state.nextAudioSequence
      ) fail('sequence_error');
      if (
        !isIntegerBetween(
          event.audioBytes,
          MISTRAL_CONVERSATION_AUDIO_QUANTUM_BYTES,
          MISTRAL_CONVERSATION_MAX_AUDIO_FRAME_BYTES,
        )
        || event.audioBytes % MISTRAL_CONVERSATION_AUDIO_QUANTUM_BYTES !== 0
      ) fail('invalid_frame');
      const audioBytes = state.audioBytes + event.audioBytes;
      if (audioBytes > MISTRAL_CONVERSATION_MAX_TURN_AUDIO_BYTES) fail('audio_budget_exceeded');
      return {
        ...state,
        audioBytes,
        lastAudioSequence: event.audioSequence,
        nextAudioSequence: event.audioSequence === UINT32_MAX
          ? UINT32_CURSOR_END
          : event.audioSequence + 1,
      };
    }
    case 'COMMIT':
      if (
        state.phase === 'committed'
        || state.phase === 'transcribing'
        || state.phase === 'reasoning'
        || state.phase === 'rendering'
        || state.phase === 'delivering'
        || state.phase === 'completed'
      ) {
        if (
          state.lastAudioSequence === event.lastAudioSequence
          && state.vadEndedAtMs === event.vadEndedAtMs
        ) return state;
        fail('sequence_error');
      }
      if (state.phase !== 'ingesting' || state.lastAudioSequence === null || state.audioBytes === 0) {
        fail('invalid_state_transition');
      }
      if (
        !isUint32(event.lastAudioSequence)
        || event.lastAudioSequence !== state.lastAudioSequence
      ) fail('sequence_error');
      if (
        !isIntegerBetween(event.vadEndedAtMs, 0, Number.MAX_SAFE_INTEGER)
        || event.vadEndedAtMs < state.vadStartedAtMs
        || event.vadEndedAtMs - state.vadStartedAtMs > MISTRAL_CONVERSATION_MAX_TURN_AUDIO_MS
      ) fail('invalid_state_transition');
      return { ...state, phase: 'committed', vadEndedAtMs: event.vadEndedAtMs };
    case 'START_TRANSCRIPTION':
      return advanceTurnPhase(state, 'committed', 'transcribing');
    case 'START_REASONING':
      return advanceTurnPhase(state, 'transcribing', 'reasoning');
    case 'START_RENDERING':
      return advanceTurnPhase(state, 'reasoning', 'rendering');
    case 'START_DELIVERY':
      return advanceTurnPhase(state, 'rendering', 'delivering');
    case 'COMPLETE':
      return advanceTurnPhase(state, 'delivering', 'completed');
    case 'REQUEST_CANCEL':
      if (state.phase === 'completed') fail('invalid_state_transition');
      if (state.phase === 'cancel_requested' || state.phase === 'cancelled') {
        if (
          state.cancellationId === event.cancellationId
          && state.cancellationGeneration === event.cancellationGeneration
          && state.cancellationReason === event.reason
        ) return state;
        fail('cancellation_conflict');
      }
      if (
        !isUuid(event.cancellationId)
        || !isCancellationGeneration(event.cancellationGeneration)
        || event.cancellationGeneration !== state.cancellationGeneration + 1
        || !isCancelReason(event.reason)
      ) fail('cancellation_conflict');
      return {
        ...state,
        phase: 'cancel_requested',
        cancellationGeneration: event.cancellationGeneration,
        cancellationId: event.cancellationId,
        cancellationReason: event.reason,
      };
    case 'CONFIRM_CANCEL':
      if (state.phase === 'cancelled') {
        if (
          state.cancellationId === event.cancellationId
          && state.cancellationGeneration === event.cancellationGeneration
        ) return state;
        fail('cancellation_conflict');
      }
      if (
        state.phase !== 'cancel_requested'
        || state.cancellationId !== event.cancellationId
        || state.cancellationGeneration !== event.cancellationGeneration
      ) fail('cancellation_conflict');
      return { ...state, phase: 'cancelled' };
  }
}
