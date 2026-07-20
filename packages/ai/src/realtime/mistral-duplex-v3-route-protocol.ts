/**
 * Pure wire contract for the dormant Mistral Duplex V3 route.
 *
 * This module deliberately knows nothing about WebSocket, HTTP, persistence, Mistral SDKs or
 * React Native. Text frames never contain speech, transcripts or PCM. Every diagnostic is a
 * stable code and never copies an untrusted wire value.
 */

import {
  MISTRAL_DUPLEX_DOWNLINK_PROTOCOL,
  MistralDuplexProtocolError,
  decodeMistralDuplexUpstreamControl,
  encodeMistralDuplexUpstreamControl,
  type MistralDuplexUpstreamControl,
} from './mistral-duplex-downlink-protocol';

export const MISTRAL_DUPLEX_V3_ROUTE_PROTOCOL = MISTRAL_DUPLEX_DOWNLINK_PROTOCOL;
export const MISTRAL_DUPLEX_V3_ROUTE_MAX_TEXT_BYTES = 4_096 as const;
export const MISTRAL_DUPLEX_V3_ROUTE_TICKET_PREFIX = 'd3_' as const;
export const MISTRAL_DUPLEX_V3_CONNECTION_NONCE_PREFIX = 'n3_' as const;

export const MISTRAL_DUPLEX_V3_UPLINK_SAMPLE_FORMAT = 'pcm_s16le' as const;
export const MISTRAL_DUPLEX_V3_UPLINK_SAMPLE_RATE_HZ = 16_000 as const;
export const MISTRAL_DUPLEX_V3_UPLINK_CHANNELS = 1 as const;
export const MISTRAL_DUPLEX_V3_UPLINK_FRAME_DURATION_MS = 20 as const;
export const MISTRAL_DUPLEX_V3_UPLINK_PCM_BYTES = 640 as const;
export const MISTRAL_DUPLEX_V3_UPLINK_HEADER_BYTES = 24 as const;
export const MISTRAL_DUPLEX_V3_UPLINK_FRAME_BYTES = (
  MISTRAL_DUPLEX_V3_UPLINK_HEADER_BYTES + MISTRAL_DUPLEX_V3_UPLINK_PCM_BYTES
) as 664;
export const MISTRAL_DUPLEX_V3_MAX_CAPTURE_SEQUENCE = 0x7fff_fffe as const;

const INT32_MAX = 0x7fff_ffff;
const MAX_PLAYBACK_GENERATION = INT32_MAX - 2;
const MAX_JSON_DEPTH = 32;
const MAX_ACK_CURSOR_CHOICES = 4;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const COMPANY_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/u;
// Canonical unpadded base64url for exactly 32 bytes. Four payload bits remain in the final
// sextet, so its two low padding bits must be zero (indices divisible by four).
const CANONICAL_32_BYTE_BASE64URL_SUFFIX = '[AEIMQUYcgkosw048]';
const ROUTE_TICKET_PATTERN = new RegExp(`^d3_[A-Za-z0-9_-]{42}${CANONICAL_32_BYTE_BASE64URL_SUFFIX}$`, 'u');
const CONNECTION_NONCE_PATTERN = new RegExp(`^n3_[A-Za-z0-9_-]{42}${CANONICAL_32_BYTE_BASE64URL_SUFFIX}$`, 'u');
const UPLINK_MAGIC = Uint8Array.of(0x42, 0x4f, 0x42, 0x55); // BOBU
const UPLINK_VERSION = 3;
const UPLINK_KIND_PCM = 1;
const UPLINK_ENCODING_PCM_S16LE = 1;

type JsonRecord = Record<string, unknown>;
type InvalidTextEnvelopeCode = 'invalid_auth' | 'invalid_control' | 'invalid_control_ack';

export type MistralDuplexV3RouteProtocolErrorCode =
  | 'invalid_json'
  | 'text_frame_too_large'
  | 'invalid_auth'
  | 'invalid_resume_snapshot'
  | 'invalid_control'
  | 'invalid_control_ack'
  | 'binding_mismatch'
  | 'cursor_regression'
  | 'invalid_pcm_frame'
  | 'capture_sequence_mismatch';

export class MistralDuplexV3RouteProtocolError extends Error {
  constructor(readonly code: MistralDuplexV3RouteProtocolErrorCode) {
    super(code);
    this.name = 'MistralDuplexV3RouteProtocolError';
  }
}

export interface MistralDuplexV3ResumeSnapshot {
  /** `null` identifies a brand-new route and requires the complete zero cursor tuple. */
  readonly routeId: string | null;
  readonly connectionEpoch: number;
  readonly routeRevision: number;
  readonly nextDownlinkSequence: number;
  readonly playbackGeneration: number;
  readonly lastReceiverRevision: number;
  readonly lastNativePlaybackRevision: number;
}

export interface MistralDuplexV3RouteAuthenticate {
  readonly type: 'route.authenticate';
  readonly protocol: typeof MISTRAL_DUPLEX_V3_ROUTE_PROTOCOL;
  /** RLS routing hint only. The one-shot ticket remains the authority and binds this value. */
  readonly companyId: string;
  /** Opaque one-shot capability. It is never included in a diagnostic. */
  readonly ticket: string;
  readonly duplexId: string;
  /** Canonical 256-bit base64url nonce, unique to this physical connection attempt. */
  readonly connectionNonce: string;
  readonly resume: MistralDuplexV3ResumeSnapshot;
}

/** Native evidence emitted only after the cancel/flush barrier emptied the device queue. */
export interface MistralDuplexV3ReceiverPlaybackFlushed {
  readonly protocol: typeof MISTRAL_DUPLEX_V3_ROUTE_PROTOCOL;
  readonly type: 'receiver.playback_flushed';
  readonly sessionId: string;
  readonly duplexId: string;
  readonly connectionEpoch: number;
  readonly turnId: string;
  readonly artifactId: string;
  readonly playbackGeneration: number;
  readonly receiverRevision: number;
  readonly nativePlaybackRevision: number;
  readonly nextPlaybackGeneration: number;
  readonly nativeQueueEmpty: true;
  readonly flushedAtMonotonicMs: number;
}

export type MistralDuplexV3RouteControlPayload =
  | MistralDuplexUpstreamControl
  | MistralDuplexV3ReceiverPlaybackFlushed;

export interface MistralDuplexV3ReceiverControl {
  readonly type: 'receiver.control';
  readonly protocol: typeof MISTRAL_DUPLEX_V3_ROUTE_PROTOCOL;
  readonly controlId: string;
  readonly routeId: string;
  readonly connectionEpoch: number;
  readonly payload: MistralDuplexV3RouteControlPayload;
}

export type MistralDuplexV3ControlVerdict = 'applied' | 'replayed' | 'superseded';
export type MistralDuplexV3ClaimState = 'opened' | 'completed' | 'revoked' | 'expired';

export interface MistralDuplexV3ReceiverControlAck {
  readonly type: 'receiver.control_ack';
  readonly protocol: typeof MISTRAL_DUPLEX_V3_ROUTE_PROTOCOL;
  readonly controlId: string;
  readonly routeId: string;
  readonly connectionEpoch: number;
  /**
   * First durable resolution of this controlId. Re-delivering the same controlId returns the
   * identical value; `replayed` describes a newly persisted receipt, never the transport retry.
   */
  readonly verdict: MistralDuplexV3ControlVerdict;
  readonly claimState: MistralDuplexV3ClaimState;
  /** CAS revision of the durable route projection. Replays may repeat it, never regress it. */
  readonly routeRevision: number;
  readonly nextDownlinkSequence: number;
  readonly playbackGeneration: number;
  readonly lastReceiverRevision: number;
  readonly lastNativePlaybackRevision: number;
}

export interface MistralDuplexV3RouteControlExpectation {
  readonly routeId: string;
  readonly duplexId: string;
  readonly connectionEpoch: number;
  readonly sessionId: string;
  readonly turnId: string;
  readonly artifactId: string;
  readonly playbackGeneration: number;
}

export interface MistralDuplexV3ControlAckCursorSnapshot {
  readonly routeRevision: number;
  readonly nextDownlinkSequence: number;
  readonly playbackGeneration: number;
  readonly lastReceiverRevision: number;
  readonly lastNativePlaybackRevision: number;
}

/** Exact durable ACK meaning and cursors. Cursor equality alone cannot prove the race verdict. */
export interface MistralDuplexV3ControlAckSnapshot
extends MistralDuplexV3ControlAckCursorSnapshot {
  readonly verdict: MistralDuplexV3ControlVerdict;
  readonly claimState: MistralDuplexV3ClaimState;
}

/** Identity and exact outcome of the previously accepted ACK on this route. */
export interface MistralDuplexV3PreviousControlAck
extends MistralDuplexV3ControlAckSnapshot {
  readonly controlId: string;
  readonly routeId: string;
  readonly connectionEpoch: number;
}

export interface MistralDuplexV3ControlAckExpectation {
  readonly controlId: string;
  readonly routeId: string;
  readonly connectionEpoch: number;
  /** `null` for the first ACK; same-control replay must reproduce this exact outcome. */
  readonly previous: MistralDuplexV3PreviousControlAck | null;
  /** Exact durable semantic targets permitted for this control; never a numeric range. */
  readonly accepted: readonly MistralDuplexV3ControlAckSnapshot[];
}

export interface MistralDuplexV3UplinkPcmFrame {
  readonly connectionEpoch: number;
  readonly captureSequence: number;
  readonly pcm: Uint8Array;
}

export interface MistralDuplexV3UplinkPcmExpectation {
  readonly connectionEpoch: number;
  /** Exact next sequence. WSS ordering makes a gap, duplicate or regression non-canonical. */
  readonly captureSequence: number;
}

const RESUME_KEYS = [
  'routeId',
  'connectionEpoch',
  'routeRevision',
  'nextDownlinkSequence',
  'playbackGeneration',
  'lastReceiverRevision',
  'lastNativePlaybackRevision',
] as const satisfies readonly (keyof MistralDuplexV3ResumeSnapshot)[];

const AUTH_KEYS = [
  'type',
  'protocol',
  'companyId',
  'ticket',
  'duplexId',
  'connectionNonce',
  'resume',
] as const satisfies readonly (keyof MistralDuplexV3RouteAuthenticate)[];

const CONTROL_KEYS = [
  'type',
  'protocol',
  'controlId',
  'routeId',
  'connectionEpoch',
  'payload',
] as const satisfies readonly (keyof MistralDuplexV3ReceiverControl)[];

const ACK_KEYS = [
  'type',
  'protocol',
  'controlId',
  'routeId',
  'connectionEpoch',
  'verdict',
  'claimState',
  'routeRevision',
  'nextDownlinkSequence',
  'playbackGeneration',
  'lastReceiverRevision',
  'lastNativePlaybackRevision',
] as const satisfies readonly (keyof MistralDuplexV3ReceiverControlAck)[];

const CONTROL_EXPECTATION_KEYS = [
  'routeId',
  'duplexId',
  'connectionEpoch',
  'sessionId',
  'turnId',
  'artifactId',
  'playbackGeneration',
] as const satisfies readonly (keyof MistralDuplexV3RouteControlExpectation)[];

const ACK_EXPECTATION_KEYS = [
  'controlId',
  'routeId',
  'connectionEpoch',
  'previous',
  'accepted',
] as const satisfies readonly (keyof MistralDuplexV3ControlAckExpectation)[];

const ACK_CURSOR_KEYS = [
  'routeRevision',
  'nextDownlinkSequence',
  'playbackGeneration',
  'lastReceiverRevision',
  'lastNativePlaybackRevision',
] as const satisfies readonly (keyof MistralDuplexV3ControlAckCursorSnapshot)[];

const ACK_SNAPSHOT_KEYS = [
  'verdict',
  'claimState',
  ...ACK_CURSOR_KEYS,
] as const satisfies readonly (keyof MistralDuplexV3ControlAckSnapshot)[];

const PREVIOUS_ACK_KEYS = [
  'controlId',
  'routeId',
  'connectionEpoch',
  ...ACK_SNAPSHOT_KEYS,
] as const satisfies readonly (keyof MistralDuplexV3PreviousControlAck)[];

const PCM_FRAME_KEYS = [
  'connectionEpoch',
  'captureSequence',
  'pcm',
] as const satisfies readonly (keyof MistralDuplexV3UplinkPcmFrame)[];

const PCM_EXPECTATION_KEYS = [
  'connectionEpoch',
  'captureSequence',
] as const satisfies readonly (keyof MistralDuplexV3UplinkPcmExpectation)[];

const FLOW_CONTROL_KEYS = [
  'protocol',
  'type',
  'sessionId',
  'duplexId',
  'connectionEpoch',
  'turnId',
  'artifactId',
  'playbackGeneration',
  'receiverRevision',
  'nextExpectedSequence',
  'consumedThroughChunkIndex',
  'pressure',
  'routeExhausted',
  'availableBytes',
  'availableChunks',
] as const;

const CANCEL_REQUEST_KEYS = [
  'protocol',
  'type',
  'sessionId',
  'duplexId',
  'connectionEpoch',
  'turnId',
  'artifactId',
  'playbackGeneration',
  'receiverRevision',
  'reason',
  'nextPlaybackGeneration',
  'nativeFlushConfirmed',
] as const;

const PLAYBACK_DRAINED_KEYS = [
  'protocol',
  'type',
  'sessionId',
  'duplexId',
  'connectionEpoch',
  'turnId',
  'artifactId',
  'playbackGeneration',
  'receiverRevision',
  'closeSequence',
  'nextExpectedSequence',
  'consumedThroughChunkIndex',
  'nativePlaybackRevision',
  'drainedAtMonotonicMs',
  'nativeQueueEmpty',
] as const;

const PLAYBACK_FLUSHED_KEYS = [
  'protocol',
  'type',
  'sessionId',
  'duplexId',
  'connectionEpoch',
  'turnId',
  'artifactId',
  'playbackGeneration',
  'receiverRevision',
  'nativePlaybackRevision',
  'nextPlaybackGeneration',
  'nativeQueueEmpty',
  'flushedAtMonotonicMs',
] as const satisfies readonly (keyof MistralDuplexV3ReceiverPlaybackFlushed)[];

function fail(code: MistralDuplexV3RouteProtocolErrorCode): never {
  throw new MistralDuplexV3RouteProtocolError(code);
}

function isInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && !Object.is(value, -0)
    && value >= minimum
    && value <= maximum;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** Canonical, domain-separated 256-bit one-shot route capability. */
export function isCanonicalMistralDuplexV3RouteTicket(value: unknown): value is string {
  return typeof value === 'string' && ROUTE_TICKET_PATTERN.test(value);
}

/** Canonical, domain-separated 256-bit nonce for one physical connection attempt. */
export function isCanonicalMistralDuplexV3ConnectionNonce(value: unknown): value is string {
  return typeof value === 'string' && CONNECTION_NONCE_PATTERN.test(value);
}

function isMonotonicMilliseconds(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && !Object.is(value, -0)
    && value >= 0
    && value <= Number.MAX_SAFE_INTEGER;
}

/**
 * Snapshots only ordinary, enumerable own data properties. Accessors, inherited values, symbols,
 * proxies that throw and null/custom prototypes are rejected without invoking user code.
 */
function exactDataSnapshot<T extends object>(
  value: unknown,
  expectedKeys: readonly (keyof T)[],
): T | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    if (Object.getPrototypeOf(value) !== Object.prototype) return null;
    if (Object.getOwnPropertySymbols(value).length !== 0) return null;
    const names = Object.getOwnPropertyNames(value).sort();
    const expected = expectedKeys.map(String).sort();
    if (names.length !== expected.length
      || !names.every((name, index) => name === expected[index])) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
      string,
      PropertyDescriptor | undefined
    >;
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of expectedKeys) {
      const name = String(key);
      const descriptor = descriptors[name];
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        return null;
      }
      snapshot[name] = descriptor.value;
    }
    return Object.freeze(snapshot) as T;
  } catch {
    return null;
  }
}

function dataProperty(value: unknown, name: string): unknown {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    if (Object.getPrototypeOf(value) !== Object.prototype) return undefined;
    if (Object.getOwnPropertySymbols(value).length !== 0) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    return descriptor !== undefined && descriptor.enumerable && 'value' in descriptor
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

/** Reject duplicate object keys before JSON.parse can silently keep the last one. */
function assertStrictJsonSource(raw: string): void {
  let cursor = 0;

  const skipWhitespace = (): void => {
    while (cursor < raw.length) {
      const code = raw.charCodeAt(cursor);
      if (code !== 0x09 && code !== 0x0a && code !== 0x0d && code !== 0x20) return;
      cursor += 1;
    }
  };

  const parseString = (): string => {
    if (raw[cursor] !== '"') fail('invalid_json');
    const start = cursor;
    cursor += 1;
    while (cursor < raw.length) {
      const character = raw[cursor]!;
      if (character === '"') {
        cursor += 1;
        try {
          const decoded = JSON.parse(raw.slice(start, cursor)) as unknown;
          if (typeof decoded !== 'string') fail('invalid_json');
          return decoded;
        } catch (error) {
          if (error instanceof MistralDuplexV3RouteProtocolError) throw error;
          return fail('invalid_json');
        }
      }
      if (character.charCodeAt(0) < 0x20) fail('invalid_json');
      if (character === '\\') {
        cursor += 1;
        if (cursor >= raw.length) fail('invalid_json');
        const escaped = raw[cursor]!;
        if (escaped === 'u') {
          const unicode = raw.slice(cursor + 1, cursor + 5);
          if (!/^[0-9a-fA-F]{4}$/u.test(unicode)) fail('invalid_json');
          cursor += 5;
          continue;
        }
        if (!'"\\/bfnrt'.includes(escaped)) fail('invalid_json');
      }
      cursor += 1;
    }
    return fail('invalid_json');
  };

  const consume = (literal: string): void => {
    if (raw.slice(cursor, cursor + literal.length) !== literal) fail('invalid_json');
    cursor += literal.length;
  };

  const parseValue = (depth: number): void => {
    if (depth > MAX_JSON_DEPTH) fail('invalid_json');
    skipWhitespace();
    const character = raw[cursor];
    if (character === '"') {
      parseString();
      return;
    }
    if (character === '{') {
      cursor += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (raw[cursor] === '}') {
        cursor += 1;
        return;
      }
      while (cursor < raw.length) {
        skipWhitespace();
        const key = parseString();
        if (keys.has(key)) fail('invalid_json');
        keys.add(key);
        skipWhitespace();
        if (raw[cursor] !== ':') fail('invalid_json');
        cursor += 1;
        parseValue(depth + 1);
        skipWhitespace();
        if (raw[cursor] === '}') {
          cursor += 1;
          return;
        }
        if (raw[cursor] !== ',') fail('invalid_json');
        cursor += 1;
      }
      return fail('invalid_json');
    }
    if (character === '[') {
      cursor += 1;
      skipWhitespace();
      if (raw[cursor] === ']') {
        cursor += 1;
        return;
      }
      while (cursor < raw.length) {
        parseValue(depth + 1);
        skipWhitespace();
        if (raw[cursor] === ']') {
          cursor += 1;
          return;
        }
        if (raw[cursor] !== ',') fail('invalid_json');
        cursor += 1;
      }
      return fail('invalid_json');
    }
    if (character === 't') return consume('true');
    if (character === 'f') return consume('false');
    if (character === 'n') return consume('null');
    const match = raw.slice(cursor).match(
      /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u,
    );
    if (match === null) fail('invalid_json');
    const numeric = Number(match[0]);
    if (!Number.isFinite(numeric) || Object.is(numeric, -0)) fail('invalid_json');
    cursor += match[0].length;
  };

  parseValue(0);
  skipWhitespace();
  if (cursor !== raw.length) fail('invalid_json');
}

function parseTextRecord(raw: unknown, invalidCode: InvalidTextEnvelopeCode): JsonRecord {
  if (typeof raw !== 'string' || raw.length === 0) fail('invalid_json');
  // UTF-8 never uses fewer bytes than UTF-16 code units. Reject oversized hostile frames before
  // TextEncoder can allocate a proportional byte buffer; the second check remains authoritative.
  if (raw.length > MISTRAL_DUPLEX_V3_ROUTE_MAX_TEXT_BYTES) fail('text_frame_too_large');
  if (new TextEncoder().encode(raw).byteLength > MISTRAL_DUPLEX_V3_ROUTE_MAX_TEXT_BYTES) {
    fail('text_frame_too_large');
  }
  assertStrictJsonSource(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    fail('invalid_json');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fail(invalidCode);
  }
  const parsedKeys = Object.keys(parsed);
  if (exactDataSnapshot<JsonRecord>(parsed, parsedKeys) === null) {
    fail(invalidCode);
  }
  return parsed as JsonRecord;
}

function encodeText(value: JsonRecord, invalidCode: InvalidTextEnvelopeCode): string {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    fail(invalidCode);
  }
  if (encoded.length > MISTRAL_DUPLEX_V3_ROUTE_MAX_TEXT_BYTES) {
    fail('text_frame_too_large');
  }
  if (new TextEncoder().encode(encoded).byteLength > MISTRAL_DUPLEX_V3_ROUTE_MAX_TEXT_BYTES) {
    fail('text_frame_too_large');
  }
  return encoded;
}

export function snapshotMistralDuplexV3ResumeSnapshot(
  value: unknown,
): MistralDuplexV3ResumeSnapshot {
  const resume = exactDataSnapshot<MistralDuplexV3ResumeSnapshot>(value, RESUME_KEYS);
  if (resume === null
    || !(resume.routeId === null || isUuid(resume.routeId))
    || !isInteger(resume.connectionEpoch, 0, INT32_MAX)
    || !isInteger(resume.routeRevision, 0, INT32_MAX)
    || !isInteger(resume.nextDownlinkSequence, 0, INT32_MAX)
    || !isInteger(resume.playbackGeneration, 1, MAX_PLAYBACK_GENERATION)
    || !isInteger(resume.lastReceiverRevision, 0, INT32_MAX)
    || !isInteger(resume.lastNativePlaybackRevision, 0, INT32_MAX)) {
    fail('invalid_resume_snapshot');
  }
  if (resume.routeId === null) {
    if (resume.connectionEpoch !== 0
      || resume.routeRevision !== 0
      || resume.nextDownlinkSequence !== 0
      || resume.playbackGeneration !== 1
      || resume.lastReceiverRevision !== 0
      || resume.lastNativePlaybackRevision !== 0) {
      fail('invalid_resume_snapshot');
    }
  } else if (resume.connectionEpoch < 1 || resume.routeRevision < 1) {
    fail('invalid_resume_snapshot');
  }
  return Object.freeze({
    routeId: resume.routeId,
    connectionEpoch: resume.connectionEpoch,
    routeRevision: resume.routeRevision,
    nextDownlinkSequence: resume.nextDownlinkSequence,
    playbackGeneration: resume.playbackGeneration,
    lastReceiverRevision: resume.lastReceiverRevision,
    lastNativePlaybackRevision: resume.lastNativePlaybackRevision,
  });
}

function snapshotAuth(value: unknown): MistralDuplexV3RouteAuthenticate {
  const auth = exactDataSnapshot<MistralDuplexV3RouteAuthenticate>(value, AUTH_KEYS);
  if (auth === null
    || auth.type !== 'route.authenticate'
    || auth.protocol !== MISTRAL_DUPLEX_V3_ROUTE_PROTOCOL
    || typeof auth.companyId !== 'string'
    || !COMPANY_ID_PATTERN.test(auth.companyId)
    || !isCanonicalMistralDuplexV3RouteTicket(auth.ticket)
    || !isUuid(auth.duplexId)
    || !isCanonicalMistralDuplexV3ConnectionNonce(auth.connectionNonce)) {
    fail('invalid_auth');
  }
  return Object.freeze({
    type: 'route.authenticate',
    protocol: MISTRAL_DUPLEX_V3_ROUTE_PROTOCOL,
    companyId: auth.companyId,
    ticket: auth.ticket,
    duplexId: auth.duplexId,
    connectionNonce: auth.connectionNonce,
    resume: snapshotMistralDuplexV3ResumeSnapshot(auth.resume),
  });
}

export function decodeMistralDuplexV3RouteAuthenticate(
  raw: unknown,
): MistralDuplexV3RouteAuthenticate {
  return snapshotAuth(parseTextRecord(raw, 'invalid_auth'));
}

export function encodeMistralDuplexV3RouteAuthenticate(
  input: MistralDuplexV3RouteAuthenticate,
): string {
  const auth = snapshotAuth(input);
  return encodeText({
    type: auth.type,
    protocol: auth.protocol,
    companyId: auth.companyId,
    ticket: auth.ticket,
    duplexId: auth.duplexId,
    connectionNonce: auth.connectionNonce,
    resume: auth.resume,
  }, 'invalid_auth');
}

function snapshotKnownUpstreamControl(value: unknown): MistralDuplexUpstreamControl {
  const type = dataProperty(value, 'type');
  const keys = type === 'receiver.flow_control'
    ? FLOW_CONTROL_KEYS
    : type === 'receiver.cancel_requested'
      ? CANCEL_REQUEST_KEYS
      : type === 'receiver.playback_drained'
        ? PLAYBACK_DRAINED_KEYS
        : null;
  if (keys === null) fail('invalid_control');
  const snapshot = exactDataSnapshot<Record<string, unknown>>(value, keys);
  if (snapshot === null) fail('invalid_control');
  try {
    return Object.freeze(decodeMistralDuplexUpstreamControl(
      encodeMistralDuplexUpstreamControl(snapshot as unknown as MistralDuplexUpstreamControl),
    ));
  } catch (error) {
    if (error instanceof MistralDuplexProtocolError) fail('invalid_control');
    throw error;
  }
}

function snapshotPlaybackFlushed(value: unknown): MistralDuplexV3ReceiverPlaybackFlushed {
  const payload = exactDataSnapshot<MistralDuplexV3ReceiverPlaybackFlushed>(
    value,
    PLAYBACK_FLUSHED_KEYS,
  );
  if (payload === null
    || payload.protocol !== MISTRAL_DUPLEX_V3_ROUTE_PROTOCOL
    || payload.type !== 'receiver.playback_flushed'
    || !isUuid(payload.sessionId)
    || !isUuid(payload.duplexId)
    || !isInteger(payload.connectionEpoch, 1, INT32_MAX)
    || !isUuid(payload.turnId)
    || !isUuid(payload.artifactId)
    || !isInteger(payload.playbackGeneration, 1, MAX_PLAYBACK_GENERATION)
    || !isInteger(payload.receiverRevision, 1, INT32_MAX)
    || !isInteger(payload.nativePlaybackRevision, 1, INT32_MAX)
    || payload.nextPlaybackGeneration !== payload.playbackGeneration + 1
    || payload.nativeQueueEmpty !== true
    || !isMonotonicMilliseconds(payload.flushedAtMonotonicMs)) {
    fail('invalid_control');
  }
  return Object.freeze({
    protocol: MISTRAL_DUPLEX_V3_ROUTE_PROTOCOL,
    type: 'receiver.playback_flushed',
    sessionId: payload.sessionId,
    duplexId: payload.duplexId,
    connectionEpoch: payload.connectionEpoch,
    turnId: payload.turnId,
    artifactId: payload.artifactId,
    playbackGeneration: payload.playbackGeneration,
    receiverRevision: payload.receiverRevision,
    nativePlaybackRevision: payload.nativePlaybackRevision,
    nextPlaybackGeneration: payload.nextPlaybackGeneration,
    nativeQueueEmpty: true,
    flushedAtMonotonicMs: payload.flushedAtMonotonicMs,
  });
}

function snapshotRouteControlPayload(value: unknown): MistralDuplexV3RouteControlPayload {
  return dataProperty(value, 'type') === 'receiver.playback_flushed'
    ? snapshotPlaybackFlushed(value)
    : snapshotKnownUpstreamControl(value);
}

function snapshotControl(value: unknown): MistralDuplexV3ReceiverControl {
  const control = exactDataSnapshot<MistralDuplexV3ReceiverControl>(value, CONTROL_KEYS);
  if (control === null
    || control.type !== 'receiver.control'
    || control.protocol !== MISTRAL_DUPLEX_V3_ROUTE_PROTOCOL
    || !isUuid(control.controlId)
    || !isUuid(control.routeId)
    || !isInteger(control.connectionEpoch, 1, INT32_MAX)) {
    fail('invalid_control');
  }
  const payload = snapshotRouteControlPayload(control.payload);
  if (payload.connectionEpoch !== control.connectionEpoch) fail('binding_mismatch');
  return Object.freeze({
    type: 'receiver.control',
    protocol: MISTRAL_DUPLEX_V3_ROUTE_PROTOCOL,
    controlId: control.controlId,
    routeId: control.routeId,
    connectionEpoch: control.connectionEpoch,
    payload,
  });
}

function snapshotControlExpectation(
  value: unknown,
): MistralDuplexV3RouteControlExpectation {
  const expected = exactDataSnapshot<MistralDuplexV3RouteControlExpectation>(
    value,
    CONTROL_EXPECTATION_KEYS,
  );
  if (expected === null
    || !isUuid(expected.routeId)
    || !isUuid(expected.duplexId)
    || !isInteger(expected.connectionEpoch, 1, INT32_MAX)
    || !isUuid(expected.sessionId)
    || !isUuid(expected.turnId)
    || !isUuid(expected.artifactId)
    || !isInteger(expected.playbackGeneration, 1, MAX_PLAYBACK_GENERATION)) {
    fail('binding_mismatch');
  }
  return expected;
}

export function decodeMistralDuplexV3ReceiverControl(
  raw: unknown,
  expectation?: MistralDuplexV3RouteControlExpectation,
): MistralDuplexV3ReceiverControl {
  const control = snapshotControl(parseTextRecord(raw, 'invalid_control'));
  if (expectation !== undefined) {
    const expected = snapshotControlExpectation(expectation);
    if (control.routeId !== expected.routeId
      || control.connectionEpoch !== expected.connectionEpoch
      || control.payload.duplexId !== expected.duplexId
      || control.payload.sessionId !== expected.sessionId
      || control.payload.turnId !== expected.turnId
      || control.payload.artifactId !== expected.artifactId
      || control.payload.playbackGeneration !== expected.playbackGeneration) {
      fail('binding_mismatch');
    }
  }
  return control;
}

export function encodeMistralDuplexV3ReceiverControl(
  input: MistralDuplexV3ReceiverControl,
): string {
  const control = snapshotControl(input);
  return encodeText({
    type: control.type,
    protocol: control.protocol,
    controlId: control.controlId,
    routeId: control.routeId,
    connectionEpoch: control.connectionEpoch,
    payload: control.payload,
  }, 'invalid_control');
}

function isVerdict(value: unknown): value is MistralDuplexV3ControlVerdict {
  return value === 'applied' || value === 'replayed' || value === 'superseded';
}

function isClaimState(value: unknown): value is MistralDuplexV3ClaimState {
  return value === 'opened'
    || value === 'completed'
    || value === 'revoked'
    || value === 'expired';
}

function snapshotAck(value: unknown): MistralDuplexV3ReceiverControlAck {
  const ack = exactDataSnapshot<MistralDuplexV3ReceiverControlAck>(value, ACK_KEYS);
  if (ack === null
    || ack.type !== 'receiver.control_ack'
    || ack.protocol !== MISTRAL_DUPLEX_V3_ROUTE_PROTOCOL
    || !isUuid(ack.controlId)
    || !isUuid(ack.routeId)
    || !isInteger(ack.connectionEpoch, 1, INT32_MAX)
    || !isVerdict(ack.verdict)
    || !isClaimState(ack.claimState)
    || !isInteger(ack.routeRevision, 1, INT32_MAX)
    || !isInteger(ack.nextDownlinkSequence, 0, INT32_MAX)
    || !isInteger(ack.playbackGeneration, 1, MAX_PLAYBACK_GENERATION)
    || !isInteger(ack.lastReceiverRevision, 0, INT32_MAX)
    || !isInteger(ack.lastNativePlaybackRevision, 0, INT32_MAX)
    || (ack.verdict === 'superseded' && ack.claimState === 'opened')) {
    fail('invalid_control_ack');
  }
  return Object.freeze({
    type: 'receiver.control_ack',
    protocol: MISTRAL_DUPLEX_V3_ROUTE_PROTOCOL,
    controlId: ack.controlId,
    routeId: ack.routeId,
    connectionEpoch: ack.connectionEpoch,
    verdict: ack.verdict,
    claimState: ack.claimState,
    routeRevision: ack.routeRevision,
    nextDownlinkSequence: ack.nextDownlinkSequence,
    playbackGeneration: ack.playbackGeneration,
    lastReceiverRevision: ack.lastReceiverRevision,
    lastNativePlaybackRevision: ack.lastNativePlaybackRevision,
  });
}

function snapshotAckExpectationEntry(
  value: unknown,
): MistralDuplexV3ControlAckSnapshot {
  const snapshot = exactDataSnapshot<MistralDuplexV3ControlAckSnapshot>(
    value,
    ACK_SNAPSHOT_KEYS,
  );
  if (snapshot === null
    || !isVerdict(snapshot.verdict)
    || !isClaimState(snapshot.claimState)
    || (snapshot.verdict === 'superseded' && snapshot.claimState === 'opened')
    || !isInteger(snapshot.routeRevision, 1, INT32_MAX)
    || !isInteger(snapshot.nextDownlinkSequence, 0, INT32_MAX)
    || !isInteger(snapshot.playbackGeneration, 1, MAX_PLAYBACK_GENERATION)
    || !isInteger(snapshot.lastReceiverRevision, 0, INT32_MAX)
    || !isInteger(snapshot.lastNativePlaybackRevision, 0, INT32_MAX)) {
    fail('binding_mismatch');
  }
  return Object.freeze({ ...snapshot });
}

function snapshotPreviousAck(value: unknown): MistralDuplexV3PreviousControlAck {
  const previous = exactDataSnapshot<MistralDuplexV3PreviousControlAck>(
    value,
    PREVIOUS_ACK_KEYS,
  );
  if (previous === null
    || !isUuid(previous.controlId)
    || !isUuid(previous.routeId)
    || !isInteger(previous.connectionEpoch, 1, INT32_MAX)) {
    fail('binding_mismatch');
  }
  const semanticSnapshot = snapshotAckExpectationEntry({
    verdict: previous.verdict,
    claimState: previous.claimState,
    routeRevision: previous.routeRevision,
    nextDownlinkSequence: previous.nextDownlinkSequence,
    playbackGeneration: previous.playbackGeneration,
    lastReceiverRevision: previous.lastReceiverRevision,
    lastNativePlaybackRevision: previous.lastNativePlaybackRevision,
  });
  return Object.freeze({
    controlId: previous.controlId,
    routeId: previous.routeId,
    connectionEpoch: previous.connectionEpoch,
    ...semanticSnapshot,
  });
}

function snapshotAckChoices(
  value: unknown,
): readonly MistralDuplexV3ControlAckSnapshot[] {
  try {
    if (!Array.isArray(value)
      || Object.getPrototypeOf(value) !== Array.prototype
      || Object.getOwnPropertySymbols(value).length !== 0) fail('binding_mismatch');
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
      string,
      PropertyDescriptor | undefined
    >;
    const lengthDescriptor = descriptors.length;
    if (lengthDescriptor === undefined
      || !('value' in lengthDescriptor)
      || !isInteger(lengthDescriptor.value, 1, MAX_ACK_CURSOR_CHOICES)) {
      fail('binding_mismatch');
    }
    const length = lengthDescriptor.value;
    const names = Object.getOwnPropertyNames(value).sort();
    const expectedNames = [
      ...Array.from({ length }, (_, index) => String(index)),
      'length',
    ].sort();
    if (names.length !== expectedNames.length
      || !names.every((name, index) => name === expectedNames[index])) {
      fail('binding_mismatch');
    }
    const choices: MistralDuplexV3ControlAckSnapshot[] = [];
    const keys = new Set<string>();
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        fail('binding_mismatch');
      }
      const choice = snapshotAckExpectationEntry(descriptor.value);
      const key = ACK_SNAPSHOT_KEYS.map((field) => choice[field]).join(':');
      if (keys.has(key)) fail('binding_mismatch');
      keys.add(key);
      choices.push(choice);
    }
    return Object.freeze(choices);
  } catch (error) {
    if (error instanceof MistralDuplexV3RouteProtocolError) throw error;
    fail('binding_mismatch');
  }
}

function snapshotAckExpectation(value: unknown): MistralDuplexV3ControlAckExpectation {
  const expected = exactDataSnapshot<MistralDuplexV3ControlAckExpectation>(
    value,
    ACK_EXPECTATION_KEYS,
  );
  if (expected === null
    || !isUuid(expected.controlId)
    || !isUuid(expected.routeId)
    || !isInteger(expected.connectionEpoch, 1, INT32_MAX)
    || !(expected.previous === null || typeof expected.previous === 'object')) {
    fail('binding_mismatch');
  }
  const previous = expected.previous === null ? null : snapshotPreviousAck(expected.previous);
  if (previous !== null
    && (previous.routeId !== expected.routeId
      || previous.connectionEpoch !== expected.connectionEpoch)) {
    fail('binding_mismatch');
  }
  return Object.freeze({
    controlId: expected.controlId,
    routeId: expected.routeId,
    connectionEpoch: expected.connectionEpoch,
    previous,
    accepted: snapshotAckChoices(expected.accepted),
  });
}

function ackSnapshotMatches(
  ack: MistralDuplexV3ReceiverControlAck,
  expected: MistralDuplexV3ControlAckSnapshot,
): boolean {
  return ACK_SNAPSHOT_KEYS.every((field) => ack[field] === expected[field]);
}

export function decodeMistralDuplexV3ReceiverControlAck(
  raw: unknown,
  expectation: MistralDuplexV3ControlAckExpectation,
): MistralDuplexV3ReceiverControlAck {
  const ack = snapshotAck(parseTextRecord(raw, 'invalid_control_ack'));
  const expected = snapshotAckExpectation(expectation);
  if (ack.controlId !== expected.controlId
    || ack.routeId !== expected.routeId
    || ack.connectionEpoch !== expected.connectionEpoch) {
    fail('binding_mismatch');
  }
  if (expected.previous !== null) {
    const previous = expected.previous;
    if (ack.routeRevision < previous.routeRevision
      || ack.nextDownlinkSequence < previous.nextDownlinkSequence
      || ack.playbackGeneration < previous.playbackGeneration
      || ack.lastReceiverRevision < previous.lastReceiverRevision
      || ack.lastNativePlaybackRevision < previous.lastNativePlaybackRevision) {
      fail('cursor_regression');
    }
    if (ack.routeRevision === previous.routeRevision
      && (ack.nextDownlinkSequence !== previous.nextDownlinkSequence
        || ack.playbackGeneration !== previous.playbackGeneration
        || ack.lastReceiverRevision !== previous.lastReceiverRevision
        || ack.lastNativePlaybackRevision !== previous.lastNativePlaybackRevision)) {
      fail('cursor_regression');
    }
    if (ack.controlId === previous.controlId && !ackSnapshotMatches(ack, previous)) {
      fail('cursor_regression');
    }
  }
  if (!expected.accepted.some((candidate) => ackSnapshotMatches(ack, candidate))) {
    fail('cursor_regression');
  }
  return ack;
}

export function encodeMistralDuplexV3ReceiverControlAck(
  input: MistralDuplexV3ReceiverControlAck,
): string {
  const ack = snapshotAck(input);
  return encodeText({
    type: ack.type,
    protocol: ack.protocol,
    controlId: ack.controlId,
    routeId: ack.routeId,
    connectionEpoch: ack.connectionEpoch,
    verdict: ack.verdict,
    claimState: ack.claimState,
    routeRevision: ack.routeRevision,
    nextDownlinkSequence: ack.nextDownlinkSequence,
    playbackGeneration: ack.playbackGeneration,
    lastReceiverRevision: ack.lastReceiverRevision,
    lastNativePlaybackRevision: ack.lastNativePlaybackRevision,
  }, 'invalid_control_ack');
}

function writeUint32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function readUint32(source: Uint8Array, offset: number): number {
  return (
    (source[offset]! * 0x1_0000_00)
    + (source[offset + 1]! << 16)
    + (source[offset + 2]! << 8)
    + source[offset + 3]!
  ) >>> 0;
}

function isExactUint8Array(value: unknown, expectedBytes: number): value is Uint8Array {
  try {
    if (!(value instanceof Uint8Array)
      || !ArrayBuffer.isView(value)
      || Object.getPrototypeOf(value) !== Uint8Array.prototype
      || Object.getOwnPropertySymbols(value).length !== 0
      || value.byteLength !== expectedBytes) return false;
    const names = Object.getOwnPropertyNames(value);
    return names.length === expectedBytes
      && names.every((name, index) => name === String(index));
  } catch {
    return false;
  }
}

function snapshotPcmExpectation(value: unknown): MistralDuplexV3UplinkPcmExpectation {
  const expected = exactDataSnapshot<MistralDuplexV3UplinkPcmExpectation>(
    value,
    PCM_EXPECTATION_KEYS,
  );
  if (expected === null
    || !isInteger(expected.connectionEpoch, 1, INT32_MAX)
    || !isInteger(expected.captureSequence, 0, MISTRAL_DUPLEX_V3_MAX_CAPTURE_SEQUENCE)) {
    fail('capture_sequence_mismatch');
  }
  return expected;
}

export function encodeMistralDuplexV3UplinkPcmFrame(
  input: MistralDuplexV3UplinkPcmFrame,
): Uint8Array {
  const frame = exactDataSnapshot<MistralDuplexV3UplinkPcmFrame>(input, PCM_FRAME_KEYS);
  if (frame === null
    || !isInteger(frame.connectionEpoch, 1, INT32_MAX)
    || !isInteger(frame.captureSequence, 0, MISTRAL_DUPLEX_V3_MAX_CAPTURE_SEQUENCE)
    || !isExactUint8Array(frame.pcm, MISTRAL_DUPLEX_V3_UPLINK_PCM_BYTES)) {
    fail('invalid_pcm_frame');
  }
  const encoded = new Uint8Array(MISTRAL_DUPLEX_V3_UPLINK_FRAME_BYTES);
  encoded.set(UPLINK_MAGIC, 0);
  encoded[4] = UPLINK_VERSION;
  encoded[5] = UPLINK_KIND_PCM;
  encoded[6] = UPLINK_ENCODING_PCM_S16LE;
  encoded[7] = MISTRAL_DUPLEX_V3_UPLINK_CHANNELS;
  encoded[8] = MISTRAL_DUPLEX_V3_UPLINK_FRAME_DURATION_MS;
  // Bytes 9..11 are reserved and stay zero.
  writeUint32(encoded, 12, MISTRAL_DUPLEX_V3_UPLINK_SAMPLE_RATE_HZ);
  writeUint32(encoded, 16, frame.connectionEpoch);
  writeUint32(encoded, 20, frame.captureSequence);
  encoded.set(frame.pcm, MISTRAL_DUPLEX_V3_UPLINK_HEADER_BYTES);
  return encoded;
}

export function decodeMistralDuplexV3UplinkPcmFrame(
  raw: unknown,
  expectation: MistralDuplexV3UplinkPcmExpectation,
): MistralDuplexV3UplinkPcmFrame {
  const expected = snapshotPcmExpectation(expectation);
  if (!isExactUint8Array(raw, MISTRAL_DUPLEX_V3_UPLINK_FRAME_BYTES)) {
    fail('invalid_pcm_frame');
  }
  if (raw[0] !== UPLINK_MAGIC[0]
    || raw[1] !== UPLINK_MAGIC[1]
    || raw[2] !== UPLINK_MAGIC[2]
    || raw[3] !== UPLINK_MAGIC[3]
    || raw[4] !== UPLINK_VERSION
    || raw[5] !== UPLINK_KIND_PCM
    || raw[6] !== UPLINK_ENCODING_PCM_S16LE
    || raw[7] !== MISTRAL_DUPLEX_V3_UPLINK_CHANNELS
    || raw[8] !== MISTRAL_DUPLEX_V3_UPLINK_FRAME_DURATION_MS
    || raw[9] !== 0
    || raw[10] !== 0
    || raw[11] !== 0
    || readUint32(raw, 12) !== MISTRAL_DUPLEX_V3_UPLINK_SAMPLE_RATE_HZ) {
    fail('invalid_pcm_frame');
  }
  const connectionEpoch = readUint32(raw, 16);
  const captureSequence = readUint32(raw, 20);
  if (connectionEpoch < 1 || connectionEpoch > INT32_MAX) fail('invalid_pcm_frame');
  if (connectionEpoch !== expected.connectionEpoch) fail('binding_mismatch');
  if (captureSequence !== expected.captureSequence) {
    fail('capture_sequence_mismatch');
  }
  return Object.freeze({
    connectionEpoch,
    captureSequence,
    pcm: raw.slice(MISTRAL_DUPLEX_V3_UPLINK_HEADER_BYTES),
  });
}
