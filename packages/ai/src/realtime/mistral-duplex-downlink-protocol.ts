/**
 * Pure server-to-client speech transport for the future Mistral duplex route.
 *
 * This module deliberately has no WebSocket, Nest, React Native, provider SDK, timer, logger or
 * persistence dependency. It transports audited audio only. Transcripts, canonical speech and
 * business controls belong to separate channels.
 *
 * Every failure exposes a stable code and never copies a wire value into the Error message.
 */

export const MISTRAL_DUPLEX_DOWNLINK_PROTOCOL = 'bob.mistral-duplex.v3' as const;

export const MISTRAL_DUPLEX_CONTENT_TYPE = 'audio/pcm' as const;
export const MISTRAL_DUPLEX_SAMPLE_FORMAT = 'pcm_s16le' as const;
export const MISTRAL_DUPLEX_SAMPLE_RATE_HZ = 24_000 as const;
export const MISTRAL_DUPLEX_CHANNELS = 1 as const;

const PCM_BYTES_PER_SAMPLE = 2;
const PCM_SAMPLE_FRAME_BYTES = PCM_BYTES_PER_SAMPLE * MISTRAL_DUPLEX_CHANNELS;
const PCM_BYTES_PER_SECOND = MISTRAL_DUPLEX_SAMPLE_RATE_HZ * PCM_SAMPLE_FRAME_BYTES;
const PCM_QUANTUM_MS = 20;
const PCM_QUANTUM_BYTES = PCM_BYTES_PER_SECOND * PCM_QUANTUM_MS / 1_000;
const MIN_AUDITED_ARTIFACT_DURATION_MS = 100;
const MIN_AUDITED_ARTIFACT_BYTES = (
  PCM_BYTES_PER_SECOND * MIN_AUDITED_ARTIFACT_DURATION_MS / 1_000
);
const TRANSPORT_CHUNK_CEILING_BYTES = 16 * 1024;
const TRANSPORT_CHUNK_QUANTA = Math.floor(
  TRANSPORT_CHUNK_CEILING_BYTES / PCM_QUANTUM_BYTES,
);
const TRANSPORT_CHUNK_BYTES = TRANSPORT_CHUNK_QUANTA * PCM_QUANTUM_BYTES;
const MAX_CHUNKS_PER_ARTIFACT = 128;
const MAX_PCM_ARTIFACT_BYTES = TRANSPORT_CHUNK_BYTES * MAX_CHUNKS_PER_ARTIFACT;
const MAX_PCM_DURATION_MS = MAX_PCM_ARTIFACT_BYTES * 1_000 / PCM_BYTES_PER_SECOND;

/**
 * Effective PCM envelope for V3. The binary ceiling is deliberately rounded down to a whole
 * 20 ms acoustic quantum; all downstream V3 manifest, claim and WAV boundaries must use these
 * effective values, never the raw 16 KiB frame ceiling. Generic N-1 artifact storage may retain
 * a broader compatibility envelope, but it cannot grant a V3 acoustic right above this limit.
 */
export const MISTRAL_DUPLEX_PCM_LIMITS = Object.freeze({
  bytesPerSample: PCM_BYTES_PER_SAMPLE,
  sampleFrameBytes: PCM_SAMPLE_FRAME_BYTES,
  bytesPerSecond: PCM_BYTES_PER_SECOND,
  quantumMs: PCM_QUANTUM_MS,
  quantumBytes: PCM_QUANTUM_BYTES,
  minAuditedArtifactDurationMs: MIN_AUDITED_ARTIFACT_DURATION_MS,
  minAuditedArtifactBytes: MIN_AUDITED_ARTIFACT_BYTES,
  transportChunkCeilingBytes: TRANSPORT_CHUNK_CEILING_BYTES,
  transportChunkQuanta: TRANSPORT_CHUNK_QUANTA,
  transportChunkBytes: TRANSPORT_CHUNK_BYTES,
  maxChunksPerArtifact: MAX_CHUNKS_PER_ARTIFACT,
  maxArtifactBytes: MAX_PCM_ARTIFACT_BYTES,
  maxDurationMs: MAX_PCM_DURATION_MS,
} as const);

export const MISTRAL_DUPLEX_DOWNLINK_LIMITS = Object.freeze({
  maxTextEnvelopeBytes: 32 * 1024,
  maxBinaryHeaderBytes: 4 * 1024,
  maxChunkBytes: MISTRAL_DUPLEX_PCM_LIMITS.transportChunkBytes,
  maxArtifactBytes: MISTRAL_DUPLEX_PCM_LIMITS.maxArtifactBytes,
  maxChunksPerArtifact: MISTRAL_DUPLEX_PCM_LIMITS.maxChunksPerArtifact,
  maxBufferedBytes: MISTRAL_DUPLEX_PCM_LIMITS.transportChunkBytes * 4,
  highWaterBufferedBytes: MISTRAL_DUPLEX_PCM_LIMITS.transportChunkBytes * 3,
  lowWaterBufferedBytes: MISTRAL_DUPLEX_PCM_LIMITS.transportChunkBytes,
  maxBufferedChunks: 8,
  highWaterBufferedChunks: 6,
  lowWaterBufferedChunks: 2,
} as const);

const PCM_SAMPLE_BYTES = MISTRAL_DUPLEX_PCM_LIMITS.sampleFrameBytes;
const MAX_COUNTER = 0x7fff_ffff;
const MAX_PLAYABLE_GENERATION = MAX_COUNTER - 2;
const MIN_ROUTE_SEQUENCE_SLOTS = 5; // open + 1 chunk + close + cancel + flush
const TERMINAL_TOMBSTONE_LIMIT = 8;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BINARY_MAGIC = Uint8Array.of(0x42, 0x4f, 0x42, 0x33);
const BINARY_VERSION = 3;
const BINARY_KIND_CHUNK = 1;
const BINARY_PREFIX_BYTES = 12;

type JsonRecord = Record<string, unknown>;

export type MistralDuplexProtocolErrorCode =
  | 'invalid_json'
  | 'envelope_too_large'
  | 'unsupported_protocol'
  | 'invalid_envelope'
  | 'invalid_manifest'
  | 'invalid_binary_frame'
  | 'chunk_tampered'
  | 'invalid_receiver_config'
  | 'receiver_faulted'
  | 'invalid_transition'
  | 'binding_mismatch'
  | 'stale_generation'
  | 'generation_gap'
  | 'generation_exhausted'
  | 'sequence_exhausted'
  | 'duplicate_sequence'
  | 'sequence_gap'
  | 'chunk_order_violation'
  | 'close_incomplete'
  | 'artifact_tampered'
  | 'backpressure_violation'
  | 'buffer_limit_exceeded'
  | 'flush_mismatch'
  | 'playback_not_drained';

export class MistralDuplexProtocolError extends Error {
  constructor(readonly code: MistralDuplexProtocolErrorCode) {
    super(code);
    this.name = 'MistralDuplexProtocolError';
  }
}

export interface MistralDuplexArtifactBinding {
  readonly protocol: typeof MISTRAL_DUPLEX_DOWNLINK_PROTOCOL;
  readonly sessionId: string;
  readonly duplexId: string;
  readonly connectionEpoch: number;
  readonly turnId: string;
  readonly artifactId: string;
  readonly playbackGeneration: number;
  readonly contentType: typeof MISTRAL_DUPLEX_CONTENT_TYPE;
  readonly sampleFormat: typeof MISTRAL_DUPLEX_SAMPLE_FORMAT;
  readonly sampleRateHz: typeof MISTRAL_DUPLEX_SAMPLE_RATE_HZ;
  readonly channels: typeof MISTRAL_DUPLEX_CHANNELS;
  readonly totalBytes: number;
  readonly artifactSha256: string;
  readonly totalChunks: number;
  readonly manifestSha256: string;
  /** Digest of the durable audit evidence; never canonical speech or a transcript. */
  readonly auditProofSha256: string;
}

export interface MistralDuplexManifestEntry {
  readonly chunkIndex: number;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly chunkSha256: string;
}

interface MistralDuplexSequencedEnvelope extends MistralDuplexArtifactBinding {
  readonly sequence: number;
}

export interface MistralDuplexSpeechOpen extends MistralDuplexSequencedEnvelope {
  readonly type: 'speech.open';
  /** Complete, ordered commitment. It is verified before a chunk may enter the jitter buffer. */
  readonly manifest: readonly MistralDuplexManifestEntry[];
}

export interface MistralDuplexSpeechChunk extends MistralDuplexSequencedEnvelope {
  readonly type: 'speech.chunk';
  readonly chunkIndex: number;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly chunkSha256: string;
  readonly encoding: 'binary' | 'base64';
  readonly payload: Uint8Array;
}

export interface MistralDuplexSpeechClose extends MistralDuplexSequencedEnvelope {
  readonly type: 'speech.close';
}

export type MistralDuplexCancelReason =
  | 'barge_in'
  | 'user_cancel'
  | 'context_changed'
  | 'route_lost'
  | 'network_backpressure'
  | 'session_end'
  | 'superseded';

export interface MistralDuplexSpeechCancel extends MistralDuplexSequencedEnvelope {
  readonly type: 'speech.cancel';
  readonly reason: MistralDuplexCancelReason;
  /** Must be exactly playbackGeneration + 1. */
  readonly nextPlaybackGeneration: number;
}

export interface MistralDuplexSpeechFlush extends MistralDuplexSequencedEnvelope {
  readonly type: 'speech.flush';
  /** Exact sequence of the cancel which invalidated this generation. */
  readonly cancelSequence: number;
  /** Must equal the generation announced by the matching cancel. */
  readonly nextPlaybackGeneration: number;
}

export type MistralDuplexDownlinkEnvelope =
  | MistralDuplexSpeechOpen
  | MistralDuplexSpeechChunk
  | MistralDuplexSpeechClose
  | MistralDuplexSpeechCancel
  | MistralDuplexSpeechFlush;

export interface MistralDuplexPreparedArtifact {
  readonly binding: MistralDuplexArtifactBinding;
  readonly manifest: readonly MistralDuplexManifestEntry[];
}

export interface MistralDuplexBufferedChunk {
  readonly playbackGeneration: number;
  readonly sequence: number;
  readonly chunkIndex: number;
  readonly byteOffset: number;
  readonly payload: Uint8Array;
}

export type MistralDuplexReceiverPhase =
  | 'idle'
  | 'streaming'
  | 'closed'
  | 'locally_cancelled_awaiting_server_cancel'
  | 'cancelled_awaiting_flush'
  | 'faulted';

export type MistralDuplexBufferPressure = 'accepting' | 'backpressured';

export interface MistralDuplexReceiverSnapshot {
  readonly phase: MistralDuplexReceiverPhase;
  readonly pressure: MistralDuplexBufferPressure;
  readonly routeExhausted: boolean;
  readonly expectedSequence: number;
  readonly expectedPlaybackGeneration: number;
  readonly activePlaybackGeneration: number | null;
  readonly receivedChunks: number;
  readonly receivedBytes: number;
  readonly bufferedChunks: number;
  readonly bufferedBytes: number;
  readonly queuedChunks: number;
  readonly queuedBytes: number;
  readonly inFlightChunks: number;
  readonly inFlightBytes: number;
  readonly receiverRevision: number;
}

export interface MistralDuplexActivePlaybackBinding {
  readonly playbackId: string;
  readonly playbackGeneration: number;
  readonly finalChunkIndex: number;
}

export interface MistralDuplexReceiverFlowControl {
  readonly protocol: typeof MISTRAL_DUPLEX_DOWNLINK_PROTOCOL;
  readonly type: 'receiver.flow_control';
  readonly sessionId: string;
  readonly duplexId: string;
  readonly connectionEpoch: number;
  readonly turnId: string;
  readonly artifactId: string;
  readonly playbackGeneration: number;
  readonly receiverRevision: number;
  readonly nextExpectedSequence: number;
  readonly consumedThroughChunkIndex: number | null;
  readonly pressure: MistralDuplexBufferPressure;
  readonly routeExhausted: boolean;
  /** Crédit absolu restant. Le sender attend cette preuve avant le premier speech.chunk. */
  readonly availableBytes: number;
  readonly availableChunks: number;
}

export interface MistralDuplexReceiverCancelRequest {
  readonly protocol: typeof MISTRAL_DUPLEX_DOWNLINK_PROTOCOL;
  readonly type: 'receiver.cancel_requested';
  readonly sessionId: string;
  readonly duplexId: string;
  readonly connectionEpoch: number;
  readonly turnId: string;
  readonly artifactId: string;
  readonly playbackGeneration: number;
  readonly receiverRevision: number;
  readonly reason: MistralDuplexCancelReason;
  readonly nextPlaybackGeneration: number;
  /** La demande n'est émise qu'après le flush synchrone ou le barge-in natif déjà prouvé. */
  readonly nativeFlushConfirmed: true;
}

/**
 * Preuve acoustique mobile→serveur. Elle atteste uniquement que le player natif a vidé la file
 * du dernier `speech.close`; l'autorité durable reste seule habilitée à marquer la livraison.
 */
export interface MistralDuplexReceiverPlaybackDrained {
  readonly protocol: typeof MISTRAL_DUPLEX_DOWNLINK_PROTOCOL;
  readonly type: 'receiver.playback_drained';
  readonly sessionId: string;
  readonly duplexId: string;
  readonly connectionEpoch: number;
  readonly turnId: string;
  readonly artifactId: string;
  readonly playbackGeneration: number;
  readonly receiverRevision: number;
  /** Séquence exacte du `speech.close` physiquement drainé. */
  readonly closeSequence: number;
  /** Prochaine séquence downlink attendue, donc exactement `closeSequence + 1`. */
  readonly nextExpectedSequence: number;
  /** Doit être le dernier index du manifeste, jamais seulement le dernier chunk remis au natif. */
  readonly consumedThroughChunkIndex: number;
  /** Révision ordonnée émise par l'unique autorité de playback native. */
  readonly nativePlaybackRevision: number;
  /** Temps monotone du callback natif ; ce n'est volontairement pas une heure murale. */
  readonly drainedAtMonotonicMs: number;
  readonly nativeQueueEmpty: true;
}

export type MistralDuplexUpstreamControl =
  | MistralDuplexReceiverFlowControl
  | MistralDuplexReceiverCancelRequest
  | MistralDuplexReceiverPlaybackDrained;

export type MistralDuplexReceiverEffect =
  | { readonly type: 'opened'; readonly playbackGeneration: number }
  | {
      readonly type: 'buffered';
      readonly playbackGeneration: number;
      readonly pressure: MistralDuplexBufferPressure;
    }
  | { readonly type: 'closed'; readonly playbackGeneration: number; readonly idempotent: boolean }
  | {
      readonly type: 'cancelled';
      readonly playbackGeneration: number;
      readonly nextPlaybackGeneration: number;
      readonly flushRequired: true;
      readonly localAlreadyFenced: boolean;
      readonly idempotent: boolean;
    }
  | {
      readonly type: 'local_cancelled';
      readonly playbackGeneration: number;
      readonly nextPlaybackGeneration: number;
      readonly reason: MistralDuplexCancelReason;
      readonly flushRequired: true;
      readonly idempotent: boolean;
    }
  | {
      readonly type: 'dropped_after_local_cancel';
      readonly playbackGeneration: number;
      readonly envelopeType: 'speech.chunk' | 'speech.close';
    }
  | {
      readonly type: 'chunk_consumed';
      readonly playbackGeneration: number;
      readonly chunkIndex: number;
      readonly pressure: MistralDuplexBufferPressure;
    }
  | {
      readonly type: 'playback_drained';
      readonly playbackGeneration: number;
      readonly receiverRevision: number;
      readonly idempotent: boolean;
      readonly control: MistralDuplexReceiverPlaybackDrained;
    }
  | {
      readonly type: 'server_flush_barrier';
      readonly nextPlaybackGeneration: number;
      readonly nativeFlushRequired: true;
      readonly idempotent: boolean;
    }
  | {
      readonly type: 'native_flush_confirmed';
      readonly nextPlaybackGeneration: number;
      readonly serverBarrierRequired: boolean;
      readonly idempotent: boolean;
    }
  | {
      readonly type: 'terminal_replay';
      readonly envelopeType: 'speech.close' | 'speech.cancel' | 'speech.flush';
      readonly playbackGeneration: number;
    }
  | {
      readonly type: 'stale_native_callback';
      readonly playbackGeneration: number;
      readonly chunkIndex: number | null;
    }
  | {
      readonly type: 'stale_connection_frame';
      readonly connectionEpoch: number;
      readonly envelopeType: MistralDuplexDownlinkEnvelope['type'];
    }
  | { readonly type: 'flushed'; readonly nextPlaybackGeneration: number };

function fail(code: MistralDuplexProtocolErrorCode): never {
  throw new MistralDuplexProtocolError(code);
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: JsonRecord, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function isCanonicalInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && !Object.is(value, -0)
    && value >= minimum
    && value <= maximum;
}

function isSequence(value: unknown): value is number {
  return isCanonicalInteger(value, 0, MAX_COUNTER);
}

function isGeneration(value: unknown): value is number {
  return isCanonicalInteger(value, 1, MAX_COUNTER);
}

function isPlayableGeneration(value: unknown): value is number {
  return isCanonicalInteger(value, 1, MAX_PLAYABLE_GENERATION);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_PATTERN.test(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isCancelReason(value: unknown): value is MistralDuplexCancelReason {
  return value === 'barge_in'
    || value === 'user_cancel'
    || value === 'context_changed'
    || value === 'route_lost'
    || value === 'network_backpressure'
    || value === 'session_end'
    || value === 'superseded';
}

const MAX_JSON_DEPTH = 64;

/**
 * `JSON.parse` écrase silencieusement une clé dupliquée. Sur une frontière de contrôle audio,
 * cette ambiguïté est interdite : le texte est donc parcouru avant parsing et chaque objet porte
 * son propre registre de clés. Le parcours valide aussi les nombres non canoniques (`-0`, infini).
 */
function assertStrictJsonSource(raw: string): void {
  let cursor = 0;

  const skipWhitespace = (): void => {
    while (cursor < raw.length) {
      const codePoint = raw.charCodeAt(cursor);
      if (codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d && codePoint !== 0x20) {
        return;
      }
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
          if (error instanceof MistralDuplexProtocolError) throw error;
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
      fail('invalid_json');
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
      fail('invalid_json');
    }
    if (character === 't') return consume('true');
    if (character === 'f') return consume('false');
    if (character === 'n') return consume('null');
    const match = raw.slice(cursor).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u);
    if (match === null) fail('invalid_json');
    const numeric = Number(match[0]);
    if (!Number.isFinite(numeric) || Object.is(numeric, -0)) fail('invalid_json');
    cursor += match[0].length;
  };

  parseValue(0);
  skipWhitespace();
  if (cursor !== raw.length) fail('invalid_json');
}

function assertCanonicalJsonValue(
  value: unknown,
  seen: Set<object> = new Set<object>(),
  depth = 0,
): void {
  if (depth > MAX_JSON_DEPTH) fail('invalid_envelope');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) fail('invalid_envelope');
    return;
  }
  if (typeof value !== 'object') fail('invalid_envelope');
  if (seen.has(value)) fail('invalid_envelope');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (const entry of value) assertCanonicalJsonValue(entry, seen, depth + 1);
      return;
    }
    if (!isRecord(value) || Object.getOwnPropertySymbols(value).length !== 0) {
      fail('invalid_envelope');
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const name of Object.getOwnPropertyNames(value)) {
      const descriptor = descriptors[name];
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        fail('invalid_envelope');
      }
      assertCanonicalJsonValue(descriptor.value, seen, depth + 1);
    }
  } finally {
    seen.delete(value);
  }
}

function parseStrictJson(raw: unknown, maximumBytes: number): JsonRecord {
  if (typeof raw !== 'string' || raw.length === 0) fail('invalid_json');
  if (new TextEncoder().encode(raw).byteLength > maximumBytes) fail('envelope_too_large');
  assertStrictJsonSource(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    fail('invalid_json');
  }
  if (!isRecord(parsed)) fail('invalid_envelope');
  return parsed;
}

function strictStringify(value: unknown, maximumBytes: number): string {
  let encoded: string;
  try {
    assertCanonicalJsonValue(value);
    encoded = JSON.stringify(value);
  } catch (error) {
    if (error instanceof MistralDuplexProtocolError) throw error;
    fail('invalid_envelope');
  }
  if (typeof encoded !== 'string') fail('invalid_envelope');
  if (new TextEncoder().encode(encoded).byteLength > maximumBytes) fail('envelope_too_large');
  return encoded;
}

/**
 * Incremental SHA-256 over bytes. It exists here so browser, React Native and Node adapters share
 * the exact same framework-free integrity contract.
 */
class Sha256Accumulator {
  private readonly state = new Uint32Array([
    0x6a09e667,
    0xbb67ae85,
    0x3c6ef372,
    0xa54ff53a,
    0x510e527f,
    0x9b05688c,
    0x1f83d9ab,
    0x5be0cd19,
  ]);

  private readonly block = new Uint8Array(64);
  private blockLength = 0;
  private byteLength = 0;

  update(input: Uint8Array): void {
    this.byteLength += input.byteLength;
    let offset = 0;
    while (offset < input.byteLength) {
      const copied = Math.min(64 - this.blockLength, input.byteLength - offset);
      this.block.set(input.subarray(offset, offset + copied), this.blockLength);
      this.blockLength += copied;
      offset += copied;
      if (this.blockLength === 64) {
        this.compress(this.block);
        this.blockLength = 0;
      }
    }
  }

  digestHex(): string {
    const clone = new Sha256Accumulator();
    clone.state.set(this.state);
    clone.block.set(this.block);
    clone.blockLength = this.blockLength;
    clone.byteLength = this.byteLength;
    return clone.finish();
  }

  private finish(): string {
    const messageBytes = this.byteLength;
    this.block[this.blockLength] = 0x80;
    this.blockLength += 1;

    if (this.blockLength > 56) {
      this.block.fill(0, this.blockLength);
      this.compress(this.block);
      this.block.fill(0);
      this.blockLength = 0;
    } else {
      this.block.fill(0, this.blockLength);
    }

    const bitLength = messageBytes * 8;
    const high = Math.floor(bitLength / 0x1_0000_0000);
    const low = bitLength >>> 0;
    this.block[56] = (high >>> 24) & 0xff;
    this.block[57] = (high >>> 16) & 0xff;
    this.block[58] = (high >>> 8) & 0xff;
    this.block[59] = high & 0xff;
    this.block[60] = (low >>> 24) & 0xff;
    this.block[61] = (low >>> 16) & 0xff;
    this.block[62] = (low >>> 8) & 0xff;
    this.block[63] = low & 0xff;
    this.compress(this.block);

    return Array.from(this.state)
      .map((word) => word.toString(16).padStart(8, '0'))
      .join('');
  }

  private compress(bytes: Uint8Array): void {
    const k = SHA256_ROUND_CONSTANTS;
    const words = new Uint32Array(64);
    for (let index = 0; index < 16; index += 1) {
      const offset = index * 4;
      words[index] = (
        (bytes[offset]! << 24)
        | (bytes[offset + 1]! << 16)
        | (bytes[offset + 2]! << 8)
        | bytes[offset + 3]!
      ) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const x = words[index - 15]!;
      const y = words[index - 2]!;
      const sigma0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3);
      const sigma1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10);
      words[index] = (
        words[index - 16]!
        + sigma0
        + words[index - 7]!
        + sigma1
      ) >>> 0;
    }

    let a = this.state[0]!;
    let b = this.state[1]!;
    let c = this.state[2]!;
    let d = this.state[3]!;
    let e = this.state[4]!;
    let f = this.state[5]!;
    let g = this.state[6]!;
    let h = this.state[7]!;

    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temporary1 = (h + sum1 + choice + k[index]! + words[index]!) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }

    this.state[0] = (this.state[0]! + a) >>> 0;
    this.state[1] = (this.state[1]! + b) >>> 0;
    this.state[2] = (this.state[2]! + c) >>> 0;
    this.state[3] = (this.state[3]! + d) >>> 0;
    this.state[4] = (this.state[4]! + e) >>> 0;
    this.state[5] = (this.state[5]! + f) >>> 0;
    this.state[6] = (this.state[6]! + g) >>> 0;
    this.state[7] = (this.state[7]! + h) >>> 0;
  }
}

const SHA256_ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

export function mistralDuplexSha256Hex(input: Uint8Array): string {
  if (!(input instanceof Uint8Array)) fail('invalid_envelope');
  const accumulator = new Sha256Accumulator();
  accumulator.update(input);
  return accumulator.digestHex();
}

function encodeBase64(bytes: Uint8Array): string {
  let encoded = '';
  for (let offset = 0; offset < bytes.byteLength; offset += 3) {
    const first = bytes[offset]!;
    const second = bytes[offset + 1];
    const third = bytes[offset + 2];
    const value = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    encoded += BASE64_ALPHABET[(value >>> 18) & 0x3f]!;
    encoded += BASE64_ALPHABET[(value >>> 12) & 0x3f]!;
    encoded += second === undefined ? '=' : BASE64_ALPHABET[(value >>> 6) & 0x3f]!;
    encoded += third === undefined ? '=' : BASE64_ALPHABET[value & 0x3f]!;
  }
  return encoded;
}

function decodeBase64(value: unknown): Uint8Array {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length % 4 !== 0
    || !BASE64_PATTERN.test(value)) fail('invalid_envelope');

  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const result = new Uint8Array((value.length / 4) * 3 - padding);
  let outputOffset = 0;
  for (let offset = 0; offset < value.length; offset += 4) {
    const a = BASE64_ALPHABET.indexOf(value[offset]!);
    const b = BASE64_ALPHABET.indexOf(value[offset + 1]!);
    const c = value[offset + 2] === '=' ? 0 : BASE64_ALPHABET.indexOf(value[offset + 2]!);
    const d = value[offset + 3] === '=' ? 0 : BASE64_ALPHABET.indexOf(value[offset + 3]!);
    if (a < 0 || b < 0 || c < 0 || d < 0) fail('invalid_envelope');
    const combined = (a << 18) | (b << 12) | (c << 6) | d;
    if (outputOffset < result.byteLength) result[outputOffset++] = (combined >>> 16) & 0xff;
    if (outputOffset < result.byteLength) result[outputOffset++] = (combined >>> 8) & 0xff;
    if (outputOffset < result.byteLength) result[outputOffset++] = combined & 0xff;
  }
  if (encodeBase64(result) !== value) fail('invalid_envelope');
  return result;
}

type ManifestBinding = Omit<MistralDuplexArtifactBinding, 'manifestSha256'>;

function validateManifestBinding(binding: ManifestBinding): void {
  if (
    binding.protocol !== MISTRAL_DUPLEX_DOWNLINK_PROTOCOL
    || !isUuid(binding.sessionId)
    || !isUuid(binding.duplexId)
    || !isCanonicalInteger(binding.connectionEpoch, 1, MAX_COUNTER)
    || !isUuid(binding.turnId)
    || !isUuid(binding.artifactId)
    || !isPlayableGeneration(binding.playbackGeneration)
    || binding.contentType !== MISTRAL_DUPLEX_CONTENT_TYPE
    || binding.sampleFormat !== MISTRAL_DUPLEX_SAMPLE_FORMAT
    || binding.sampleRateHz !== MISTRAL_DUPLEX_SAMPLE_RATE_HZ
    || binding.channels !== MISTRAL_DUPLEX_CHANNELS
    || !isCanonicalInteger(binding.totalBytes, PCM_SAMPLE_BYTES, MISTRAL_DUPLEX_DOWNLINK_LIMITS.maxArtifactBytes)
    || binding.totalBytes % PCM_SAMPLE_BYTES !== 0
    || !isSha256(binding.artifactSha256)
    || !isCanonicalInteger(binding.totalChunks, 1, MISTRAL_DUPLEX_DOWNLINK_LIMITS.maxChunksPerArtifact)
    || !isSha256(binding.auditProofSha256)
  ) fail('invalid_envelope');
}

function validateManifestEntries(
  totalBytes: number,
  totalChunks: number,
  manifest: readonly MistralDuplexManifestEntry[],
): void {
  if (!Array.isArray(manifest) || manifest.length !== totalChunks) fail('invalid_manifest');
  let expectedOffset = 0;
  for (let index = 0; index < manifest.length; index += 1) {
    const entry = manifest[index];
    if (
      !isRecord(entry)
      || !hasExactKeys(entry, ['chunkIndex', 'byteOffset', 'byteLength', 'chunkSha256'])
      || entry.chunkIndex !== index
      || entry.byteOffset !== expectedOffset
      || !isCanonicalInteger(entry.byteLength, PCM_SAMPLE_BYTES, MISTRAL_DUPLEX_DOWNLINK_LIMITS.maxChunkBytes)
      || entry.byteLength % PCM_SAMPLE_BYTES !== 0
      || !isSha256(entry.chunkSha256)
    ) fail('invalid_manifest');
    expectedOffset += entry.byteLength;
    if (expectedOffset > totalBytes) fail('invalid_manifest');
  }
  if (expectedOffset !== totalBytes) fail('invalid_manifest');
}

function canonicalManifestValue(
  binding: ManifestBinding,
  manifest: readonly MistralDuplexManifestEntry[],
): unknown {
  return {
    protocol: binding.protocol,
    sessionId: binding.sessionId,
    duplexId: binding.duplexId,
    connectionEpoch: binding.connectionEpoch,
    turnId: binding.turnId,
    artifactId: binding.artifactId,
    playbackGeneration: binding.playbackGeneration,
    contentType: binding.contentType,
    sampleFormat: binding.sampleFormat,
    sampleRateHz: binding.sampleRateHz,
    channels: binding.channels,
    totalBytes: binding.totalBytes,
    artifactSha256: binding.artifactSha256,
    totalChunks: binding.totalChunks,
    auditProofSha256: binding.auditProofSha256,
    chunks: manifest.map((entry) => ({
      chunkIndex: entry.chunkIndex,
      byteOffset: entry.byteOffset,
      byteLength: entry.byteLength,
      chunkSha256: entry.chunkSha256,
    })),
  };
}

export function computeMistralDuplexManifestSha256(
  binding: ManifestBinding,
  manifest: readonly MistralDuplexManifestEntry[],
): string {
  validateManifestBinding(binding);
  validateManifestEntries(binding.totalBytes, binding.totalChunks, manifest);
  const canonical = strictStringify(
    canonicalManifestValue(binding, manifest),
    MISTRAL_DUPLEX_DOWNLINK_LIMITS.maxTextEnvelopeBytes,
  );
  return mistralDuplexSha256Hex(new TextEncoder().encode(canonical));
}

export function createMistralDuplexArtifactManifest(input: {
  readonly sessionId: string;
  readonly duplexId: string;
  readonly connectionEpoch: number;
  readonly turnId: string;
  readonly artifactId: string;
  readonly playbackGeneration: number;
  readonly auditProofSha256: string;
  readonly chunks: readonly Uint8Array[];
}): MistralDuplexPreparedArtifact {
  if (!isRecord(input)
    || !hasExactKeys(input, [
      'sessionId',
      'duplexId',
      'connectionEpoch',
      'turnId',
      'artifactId',
      'playbackGeneration',
      'auditProofSha256',
      'chunks',
    ])
    || !Array.isArray(input.chunks)
    || input.chunks.length < 1
    || input.chunks.length > MISTRAL_DUPLEX_DOWNLINK_LIMITS.maxChunksPerArtifact
  ) fail('invalid_manifest');

  const artifactHasher = new Sha256Accumulator();
  const manifest: MistralDuplexManifestEntry[] = [];
  let totalBytes = 0;
  for (let index = 0; index < input.chunks.length; index += 1) {
    const chunk = input.chunks[index];
    if (!(chunk instanceof Uint8Array)
      || chunk.byteLength < PCM_SAMPLE_BYTES
      || chunk.byteLength > MISTRAL_DUPLEX_DOWNLINK_LIMITS.maxChunkBytes
      || chunk.byteLength % PCM_SAMPLE_BYTES !== 0
    ) fail('invalid_manifest');
    manifest.push({
      chunkIndex: index,
      byteOffset: totalBytes,
      byteLength: chunk.byteLength,
      chunkSha256: mistralDuplexSha256Hex(chunk),
    });
    totalBytes += chunk.byteLength;
    if (totalBytes > MISTRAL_DUPLEX_DOWNLINK_LIMITS.maxArtifactBytes) fail('invalid_manifest');
    artifactHasher.update(chunk);
  }

  const withoutManifest: ManifestBinding = {
    protocol: MISTRAL_DUPLEX_DOWNLINK_PROTOCOL,
    sessionId: input.sessionId,
    duplexId: input.duplexId,
    connectionEpoch: input.connectionEpoch,
    turnId: input.turnId,
    artifactId: input.artifactId,
    playbackGeneration: input.playbackGeneration,
    contentType: MISTRAL_DUPLEX_CONTENT_TYPE,
    sampleFormat: MISTRAL_DUPLEX_SAMPLE_FORMAT,
    sampleRateHz: MISTRAL_DUPLEX_SAMPLE_RATE_HZ,
    channels: MISTRAL_DUPLEX_CHANNELS,
    totalBytes,
    artifactSha256: artifactHasher.digestHex(),
    totalChunks: manifest.length,
    auditProofSha256: input.auditProofSha256,
  };
  validateManifestBinding(withoutManifest);
  const manifestSha256 = computeMistralDuplexManifestSha256(withoutManifest, manifest);
  return {
    binding: Object.freeze({ ...withoutManifest, manifestSha256 }),
    manifest: Object.freeze(manifest.map((entry) => Object.freeze(entry))),
  };
}

const COMMON_WIRE_KEYS = [
  'type',
  'protocol',
  'sessionId',
  'duplexId',
  'connectionEpoch',
  'turnId',
  'artifactId',
  'playbackGeneration',
  'sequence',
  'contentType',
  'sampleFormat',
  'sampleRateHz',
  'channels',
  'totalBytes',
  'artifactSha256',
  'totalChunks',
  'manifestSha256',
  'auditProofSha256',
] as const;

function commonKeys(...additional: readonly string[]): readonly string[] {
  return [...COMMON_WIRE_KEYS, ...additional];
}

function decodeCommon(value: JsonRecord): MistralDuplexSequencedEnvelope {
  if (value.protocol !== MISTRAL_DUPLEX_DOWNLINK_PROTOCOL) fail('unsupported_protocol');
  const binding: ManifestBinding = {
    protocol: MISTRAL_DUPLEX_DOWNLINK_PROTOCOL,
    sessionId: value.sessionId as string,
    duplexId: value.duplexId as string,
    connectionEpoch: value.connectionEpoch as number,
    turnId: value.turnId as string,
    artifactId: value.artifactId as string,
    playbackGeneration: value.playbackGeneration as number,
    contentType: value.contentType as typeof MISTRAL_DUPLEX_CONTENT_TYPE,
    sampleFormat: value.sampleFormat as typeof MISTRAL_DUPLEX_SAMPLE_FORMAT,
    sampleRateHz: value.sampleRateHz as typeof MISTRAL_DUPLEX_SAMPLE_RATE_HZ,
    channels: value.channels as typeof MISTRAL_DUPLEX_CHANNELS,
    totalBytes: value.totalBytes as number,
    artifactSha256: value.artifactSha256 as string,
    totalChunks: value.totalChunks as number,
    auditProofSha256: value.auditProofSha256 as string,
  };
  validateManifestBinding(binding);
  if (!isSha256(value.manifestSha256) || !isSequence(value.sequence)) fail('invalid_envelope');
  return {
    ...binding,
    manifestSha256: value.manifestSha256,
    sequence: value.sequence,
  };
}

function decodeChunkRecord(
  value: JsonRecord,
  expectedEncoding: 'binary' | 'base64',
  payload: Uint8Array,
): MistralDuplexSpeechChunk {
  const expectedKeys = expectedEncoding === 'base64'
    ? commonKeys('chunkIndex', 'byteOffset', 'byteLength', 'chunkSha256', 'encoding', 'data')
    : commonKeys('chunkIndex', 'byteOffset', 'byteLength', 'chunkSha256', 'encoding');
  if (!hasExactKeys(value, expectedKeys)
    || value.type !== 'speech.chunk'
    || value.encoding !== expectedEncoding
  ) fail('invalid_envelope');
  const common = decodeCommon(value);
  if (
    !isCanonicalInteger(value.chunkIndex, 0, common.totalChunks - 1)
    || !isCanonicalInteger(value.byteOffset, 0, common.totalBytes - PCM_SAMPLE_BYTES)
    || value.byteOffset % PCM_SAMPLE_BYTES !== 0
    || !isCanonicalInteger(value.byteLength, PCM_SAMPLE_BYTES, MISTRAL_DUPLEX_DOWNLINK_LIMITS.maxChunkBytes)
    || value.byteLength % PCM_SAMPLE_BYTES !== 0
    || value.byteOffset + value.byteLength > common.totalBytes
    || !isSha256(value.chunkSha256)
    || payload.byteLength !== value.byteLength
  ) fail('invalid_envelope');
  if (mistralDuplexSha256Hex(payload) !== value.chunkSha256) fail('chunk_tampered');
  return {
    type: 'speech.chunk',
    ...common,
    chunkIndex: value.chunkIndex,
    byteOffset: value.byteOffset,
    byteLength: value.byteLength,
    chunkSha256: value.chunkSha256,
    encoding: expectedEncoding,
    payload: payload.slice(),
  };
}

/** Strict decoder for JSON controls and canonical base64 chunks. */
export function decodeMistralDuplexTextEnvelope(raw: unknown): MistralDuplexDownlinkEnvelope {
  const value = parseStrictJson(raw, MISTRAL_DUPLEX_DOWNLINK_LIMITS.maxTextEnvelopeBytes);
  switch (value.type) {
    case 'speech.open': {
      if (!hasExactKeys(value, commonKeys('manifest')) || !Array.isArray(value.manifest)) {
        fail('invalid_envelope');
      }
      const common = decodeCommon(value);
      const manifest = value.manifest as unknown as readonly MistralDuplexManifestEntry[];
      validateManifestEntries(common.totalBytes, common.totalChunks, manifest);
      const { manifestSha256: _manifestSha256, sequence: _sequence, ...withoutManifest } = common;
      if (computeMistralDuplexManifestSha256(withoutManifest, manifest) !== common.manifestSha256) {
        fail('invalid_manifest');
      }
      return {
        type: 'speech.open',
        ...common,
        manifest: Object.freeze(manifest.map((entry) => Object.freeze({ ...entry }))),
      };
    }
    case 'speech.chunk': {
      if (value.encoding !== 'base64') fail('invalid_envelope');
      const payload = decodeBase64(value.data);
      return decodeChunkRecord(value, 'base64', payload);
    }
    case 'speech.close': {
      if (!hasExactKeys(value, commonKeys())) fail('invalid_envelope');
      return { type: 'speech.close', ...decodeCommon(value) };
    }
    case 'speech.cancel': {
      if (!hasExactKeys(value, commonKeys('reason', 'nextPlaybackGeneration'))
        || !isCancelReason(value.reason)
        || !isGeneration(value.nextPlaybackGeneration)
      ) fail('invalid_envelope');
      const common = decodeCommon(value);
      if (common.playbackGeneration >= MAX_COUNTER
        || value.nextPlaybackGeneration !== common.playbackGeneration + 1) {
        fail('invalid_envelope');
      }
      return {
        type: 'speech.cancel',
        ...common,
        reason: value.reason,
        nextPlaybackGeneration: value.nextPlaybackGeneration,
      };
    }
    case 'speech.flush': {
      if (!hasExactKeys(value, commonKeys('cancelSequence', 'nextPlaybackGeneration'))
        || !isSequence(value.cancelSequence)
        || !isGeneration(value.nextPlaybackGeneration)
      ) fail('invalid_envelope');
      const common = decodeCommon(value);
      if (common.playbackGeneration >= MAX_COUNTER
        || value.nextPlaybackGeneration !== common.playbackGeneration + 1) {
        fail('invalid_envelope');
      }
      return {
        type: 'speech.flush',
        ...common,
        cancelSequence: value.cancelSequence,
        nextPlaybackGeneration: value.nextPlaybackGeneration,
      };
    }
    default:
      return fail('invalid_envelope');
  }
}

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

function isMonotonicMilliseconds(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && !Object.is(value, -0)
    && value >= 0
    && value <= Number.MAX_SAFE_INTEGER;
}

function decodeUpstreamCommon(value: JsonRecord): {
  readonly sessionId: string;
  readonly duplexId: string;
  readonly connectionEpoch: number;
  readonly turnId: string;
  readonly artifactId: string;
  readonly playbackGeneration: number;
  readonly receiverRevision: number;
} {
  if (
    value.protocol !== MISTRAL_DUPLEX_DOWNLINK_PROTOCOL
    || !isUuid(value.sessionId)
    || !isUuid(value.duplexId)
    || !isCanonicalInteger(value.connectionEpoch, 1, MAX_COUNTER)
    || !isUuid(value.turnId)
    || !isUuid(value.artifactId)
    || !isPlayableGeneration(value.playbackGeneration)
    || !isCanonicalInteger(value.receiverRevision, 1, MAX_COUNTER)
  ) fail('invalid_envelope');
  return {
    sessionId: value.sessionId,
    duplexId: value.duplexId,
    connectionEpoch: value.connectionEpoch,
    turnId: value.turnId,
    artifactId: value.artifactId,
    playbackGeneration: value.playbackGeneration,
    receiverRevision: value.receiverRevision,
  };
}

/** Décode les seuls contrôles mobile→serveur autorisés par le downlink V3. */
export function decodeMistralDuplexUpstreamControl(raw: unknown): MistralDuplexUpstreamControl {
  const value = parseStrictJson(raw, MISTRAL_DUPLEX_DOWNLINK_LIMITS.maxBinaryHeaderBytes);
  if (value.type === 'receiver.flow_control') {
    if (!hasExactKeys(value, FLOW_CONTROL_KEYS)) fail('invalid_envelope');
    const common = decodeUpstreamCommon(value);
    if (
      !isSequence(value.nextExpectedSequence)
      || !(value.consumedThroughChunkIndex === null
        || isCanonicalInteger(
          value.consumedThroughChunkIndex,
          0,
          MISTRAL_DUPLEX_DOWNLINK_LIMITS.maxChunksPerArtifact - 1,
        ))
      || (value.pressure !== 'accepting' && value.pressure !== 'backpressured')
      || typeof value.routeExhausted !== 'boolean'
      || !isCanonicalInteger(
        value.availableBytes,
        0,
        MISTRAL_DUPLEX_DOWNLINK_LIMITS.highWaterBufferedBytes,
      )
      || !isCanonicalInteger(
        value.availableChunks,
        0,
        MISTRAL_DUPLEX_DOWNLINK_LIMITS.highWaterBufferedChunks,
      )
      || ((value.routeExhausted || value.pressure === 'backpressured')
        && (value.availableBytes !== 0 || value.availableChunks !== 0))
      || (value.pressure === 'accepting'
        && (value.routeExhausted || value.availableBytes === 0 || value.availableChunks === 0))
    ) fail('invalid_envelope');
    return {
      protocol: MISTRAL_DUPLEX_DOWNLINK_PROTOCOL,
      type: 'receiver.flow_control',
      ...common,
      nextExpectedSequence: value.nextExpectedSequence,
      consumedThroughChunkIndex: value.consumedThroughChunkIndex,
      pressure: value.pressure,
      routeExhausted: value.routeExhausted,
      availableBytes: value.availableBytes,
      availableChunks: value.availableChunks,
    };
  }
  if (value.type === 'receiver.cancel_requested') {
    if (!hasExactKeys(value, CANCEL_REQUEST_KEYS)) fail('invalid_envelope');
    const common = decodeUpstreamCommon(value);
    if (
      !isCancelReason(value.reason)
      || value.nextPlaybackGeneration !== common.playbackGeneration + 1
      || !isGeneration(value.nextPlaybackGeneration)
      || value.nativeFlushConfirmed !== true
    ) fail('invalid_envelope');
    return {
      protocol: MISTRAL_DUPLEX_DOWNLINK_PROTOCOL,
      type: 'receiver.cancel_requested',
      ...common,
      reason: value.reason,
      nextPlaybackGeneration: value.nextPlaybackGeneration,
      nativeFlushConfirmed: true,
    };
  }
  if (value.type === 'receiver.playback_drained') {
    if (!hasExactKeys(value, PLAYBACK_DRAINED_KEYS)) fail('invalid_envelope');
    const common = decodeUpstreamCommon(value);
    if (
      !isSequence(value.closeSequence)
      || !isSequence(value.nextExpectedSequence)
      || value.closeSequence >= MAX_COUNTER
      || value.nextExpectedSequence !== value.closeSequence + 1
      || !isCanonicalInteger(
        value.consumedThroughChunkIndex,
        0,
        MISTRAL_DUPLEX_DOWNLINK_LIMITS.maxChunksPerArtifact - 1,
      )
      || !isCanonicalInteger(value.nativePlaybackRevision, 1, MAX_COUNTER)
      || !isMonotonicMilliseconds(value.drainedAtMonotonicMs)
      || value.nativeQueueEmpty !== true
    ) fail('invalid_envelope');
    return {
      protocol: MISTRAL_DUPLEX_DOWNLINK_PROTOCOL,
      type: 'receiver.playback_drained',
      ...common,
      closeSequence: value.closeSequence,
      nextExpectedSequence: value.nextExpectedSequence,
      consumedThroughChunkIndex: value.consumedThroughChunkIndex,
      nativePlaybackRevision: value.nativePlaybackRevision,
      drainedAtMonotonicMs: value.drainedAtMonotonicMs,
      nativeQueueEmpty: true,
    };
  }
  return fail('invalid_envelope');
}

export function encodeMistralDuplexUpstreamControl(
  control: MistralDuplexUpstreamControl,
): string {
  if (!isRecord(control) || typeof control.type !== 'string') fail('invalid_envelope');
  const encoded = strictStringify(
    control,
    MISTRAL_DUPLEX_DOWNLINK_LIMITS.maxBinaryHeaderBytes,
  );
  decodeMistralDuplexUpstreamControl(encoded);
  return encoded;
}

function wireChunkValue(chunk: MistralDuplexSpeechChunk, includeData: boolean): unknown {
  return {
    type: chunk.type,
    protocol: chunk.protocol,
    sessionId: chunk.sessionId,
    duplexId: chunk.duplexId,
    connectionEpoch: chunk.connectionEpoch,
    turnId: chunk.turnId,
    artifactId: chunk.artifactId,
    playbackGeneration: chunk.playbackGeneration,
    sequence: chunk.sequence,
    contentType: chunk.contentType,
    sampleFormat: chunk.sampleFormat,
    sampleRateHz: chunk.sampleRateHz,
    channels: chunk.channels,
    totalBytes: chunk.totalBytes,
    artifactSha256: chunk.artifactSha256,
    totalChunks: chunk.totalChunks,
    manifestSha256: chunk.manifestSha256,
    auditProofSha256: chunk.auditProofSha256,
    chunkIndex: chunk.chunkIndex,
    byteOffset: chunk.byteOffset,
    byteLength: chunk.byteLength,
    chunkSha256: chunk.chunkSha256,
    encoding: chunk.encoding,
    ...(includeData ? { data: encodeBase64(chunk.payload) } : {}),
  };
}

function validateInternalChunkKeys(value: MistralDuplexSpeechChunk): void {
  if (!isRecord(value)
    || !hasExactKeys(value, commonKeys(
      'chunkIndex',
      'byteOffset',
      'byteLength',
      'chunkSha256',
      'encoding',
      'payload',
    ))
    || !(value.payload instanceof Uint8Array)
  ) fail('invalid_envelope');
}

/** Encoder for controls and base64 chunks. Binary chunks use encodeMistralDuplexBinaryChunk. */
export function encodeMistralDuplexTextEnvelope(
  envelope: Exclude<MistralDuplexDownlinkEnvelope, MistralDuplexSpeechChunk>
    | (MistralDuplexSpeechChunk & { readonly encoding: 'base64' }),
): string {
  if (!isRecord(envelope) || typeof envelope.type !== 'string') fail('invalid_envelope');
  let wire: unknown = envelope;
  if (envelope.type === 'speech.chunk') {
    validateInternalChunkKeys(envelope);
    if (envelope.encoding !== 'base64') fail('invalid_envelope');
    wire = wireChunkValue(envelope, true);
  }
  const encoded = strictStringify(wire, MISTRAL_DUPLEX_DOWNLINK_LIMITS.maxTextEnvelopeBytes);
  decodeMistralDuplexTextEnvelope(encoded);
  return encoded;
}

/** Self-contained binary frame: fixed prefix, strict JSON binding header, then raw PCM bytes. */
export function encodeMistralDuplexBinaryChunk(
  chunk: MistralDuplexSpeechChunk & { readonly encoding: 'binary' },
): Uint8Array {
  validateInternalChunkKeys(chunk);
  if (chunk.encoding !== 'binary') fail('invalid_envelope');
  const headerJson = strictStringify(
    wireChunkValue(chunk, false),
    MISTRAL_DUPLEX_DOWNLINK_LIMITS.maxBinaryHeaderBytes,
  );
  const header = new TextEncoder().encode(headerJson);
  if (header.byteLength === 0 || header.byteLength > 0xffff) fail('invalid_binary_frame');
  const frame = new Uint8Array(BINARY_PREFIX_BYTES + header.byteLength + chunk.payload.byteLength);
  frame.set(BINARY_MAGIC, 0);
  frame[4] = BINARY_VERSION;
  frame[5] = BINARY_KIND_CHUNK;
  frame[6] = (header.byteLength >>> 8) & 0xff;
  frame[7] = header.byteLength & 0xff;
  frame[8] = (chunk.payload.byteLength >>> 24) & 0xff;
  frame[9] = (chunk.payload.byteLength >>> 16) & 0xff;
  frame[10] = (chunk.payload.byteLength >>> 8) & 0xff;
  frame[11] = chunk.payload.byteLength & 0xff;
  frame.set(header, BINARY_PREFIX_BYTES);
  frame.set(chunk.payload, BINARY_PREFIX_BYTES + header.byteLength);
  decodeMistralDuplexBinaryChunk(frame);
  return frame;
}

export function decodeMistralDuplexBinaryChunk(raw: unknown): MistralDuplexSpeechChunk {
  if (!(raw instanceof Uint8Array) || raw.byteLength < BINARY_PREFIX_BYTES) {
    fail('invalid_binary_frame');
  }
  if (
    raw[0] !== BINARY_MAGIC[0]
    || raw[1] !== BINARY_MAGIC[1]
    || raw[2] !== BINARY_MAGIC[2]
    || raw[3] !== BINARY_MAGIC[3]
    || raw[4] !== BINARY_VERSION
    || raw[5] !== BINARY_KIND_CHUNK
  ) fail('invalid_binary_frame');

  const headerLength = (raw[6]! << 8) | raw[7]!;
  const payloadLength = (
    (raw[8]! * 0x1_0000_00)
    + (raw[9]! << 16)
    + (raw[10]! << 8)
    + raw[11]!
  );
  if (
    headerLength < 1
    || headerLength > MISTRAL_DUPLEX_DOWNLINK_LIMITS.maxBinaryHeaderBytes
    || payloadLength < PCM_SAMPLE_BYTES
    || payloadLength > MISTRAL_DUPLEX_DOWNLINK_LIMITS.maxChunkBytes
    || BINARY_PREFIX_BYTES + headerLength + payloadLength !== raw.byteLength
  ) fail('invalid_binary_frame');

  let headerJson: string;
  try {
    headerJson = new TextDecoder('utf-8', { fatal: true }).decode(
      raw.subarray(BINARY_PREFIX_BYTES, BINARY_PREFIX_BYTES + headerLength),
    );
  } catch {
    fail('invalid_binary_frame');
  }
  const value = parseStrictJson(headerJson, MISTRAL_DUPLEX_DOWNLINK_LIMITS.maxBinaryHeaderBytes);
  const payload = raw.subarray(BINARY_PREFIX_BYTES + headerLength);
  return decodeChunkRecord(value, 'binary', payload);
}

function sameBinding(
  active: MistralDuplexArtifactBinding,
  candidate: MistralDuplexArtifactBinding,
): boolean {
  return active.protocol === candidate.protocol
    && active.sessionId === candidate.sessionId
    && active.duplexId === candidate.duplexId
    && active.connectionEpoch === candidate.connectionEpoch
    && active.turnId === candidate.turnId
    && active.artifactId === candidate.artifactId
    && active.playbackGeneration === candidate.playbackGeneration
    && active.contentType === candidate.contentType
    && active.sampleFormat === candidate.sampleFormat
    && active.sampleRateHz === candidate.sampleRateHz
    && active.channels === candidate.channels
    && active.totalBytes === candidate.totalBytes
    && active.artifactSha256 === candidate.artifactSha256
    && active.totalChunks === candidate.totalChunks
    && active.manifestSha256 === candidate.manifestSha256
    && active.auditProofSha256 === candidate.auditProofSha256;
}

function sameClose(left: MistralDuplexSpeechClose, right: MistralDuplexSpeechClose): boolean {
  return left.sequence === right.sequence && sameBinding(left, right);
}

function sameCancel(left: MistralDuplexSpeechCancel, right: MistralDuplexSpeechCancel): boolean {
  return left.sequence === right.sequence
    && left.reason === right.reason
    && left.nextPlaybackGeneration === right.nextPlaybackGeneration
    && sameBinding(left, right);
}

function sameFlush(left: MistralDuplexSpeechFlush, right: MistralDuplexSpeechFlush): boolean {
  return left.sequence === right.sequence
    && left.cancelSequence === right.cancelSequence
    && left.nextPlaybackGeneration === right.nextPlaybackGeneration
    && sameBinding(left, right);
}

function normalizeEnvelope(envelope: MistralDuplexDownlinkEnvelope): MistralDuplexDownlinkEnvelope {
  if (!isRecord(envelope) || typeof envelope.type !== 'string') fail('invalid_envelope');
  if (envelope.type === 'speech.chunk') {
    validateInternalChunkKeys(envelope);
    if (envelope.encoding === 'binary') {
      return decodeMistralDuplexBinaryChunk(encodeMistralDuplexBinaryChunk(
        envelope as MistralDuplexSpeechChunk & { readonly encoding: 'binary' },
      ));
    }
    if (envelope.encoding === 'base64') {
      return decodeMistralDuplexTextEnvelope(encodeMistralDuplexTextEnvelope(
        envelope as MistralDuplexSpeechChunk & { readonly encoding: 'base64' },
      ));
    }
    return fail('invalid_envelope');
  }
  return decodeMistralDuplexTextEnvelope(encodeMistralDuplexTextEnvelope(envelope));
}

interface ActiveArtifact {
  readonly open: MistralDuplexSpeechOpen;
  readonly hasher: Sha256Accumulator;
  receivedChunks: number;
  receivedBytes: number;
}

export interface MistralDuplexDownlinkReceiverConfig {
  readonly sessionId: string;
  readonly duplexId: string;
  readonly connectionEpoch: number;
  readonly nextSequence: number;
  readonly playbackGeneration: number;
}

const RECEIVER_CONFIG_KEYS = Object.freeze([
  'sessionId',
  'duplexId',
  'connectionEpoch',
  'nextSequence',
  'playbackGeneration',
] as const);

/**
 * Capture la configuration une seule fois avant toute transition. La machine ne conserve jamais
 * la référence fournie par l'adapter : un getter, un proxy ou une mutation après construction ne
 * doit pas pouvoir changer l'autorité de session sous une instance déjà validée.
 */
function snapshotReceiverConfig(
  input: unknown,
): Readonly<MistralDuplexDownlinkReceiverConfig> {
  try {
    if (!isRecord(input)
      || Object.getPrototypeOf(input) !== Object.prototype
      || Object.getOwnPropertySymbols(input).length !== 0
    ) fail('invalid_receiver_config');

    const descriptors = Object.getOwnPropertyDescriptors(input);
    const names = Object.getOwnPropertyNames(input);
    if (names.length !== RECEIVER_CONFIG_KEYS.length
      || names.some((name) => !RECEIVER_CONFIG_KEYS.includes(
        name as (typeof RECEIVER_CONFIG_KEYS)[number],
      ))
    ) fail('invalid_receiver_config');

    const values: Record<(typeof RECEIVER_CONFIG_KEYS)[number], unknown> = {
      sessionId: undefined,
      duplexId: undefined,
      connectionEpoch: undefined,
      nextSequence: undefined,
      playbackGeneration: undefined,
    };
    for (const key of RECEIVER_CONFIG_KEYS) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        fail('invalid_receiver_config');
      }
      values[key] = descriptor.value;
    }

    if (!isUuid(values.sessionId)
      || !isUuid(values.duplexId)
      || !isCanonicalInteger(values.connectionEpoch, 1, MAX_COUNTER)
      || !isSequence(values.nextSequence)
      || !isPlayableGeneration(values.playbackGeneration)
    ) fail('invalid_receiver_config');

    return Object.freeze({
      sessionId: values.sessionId,
      duplexId: values.duplexId,
      connectionEpoch: values.connectionEpoch,
      nextSequence: values.nextSequence,
      playbackGeneration: values.playbackGeneration,
    });
  } catch (error) {
    if (error instanceof MistralDuplexProtocolError) throw error;
    return fail('invalid_receiver_config');
  }
}

/**
 * Deterministic jitter-buffer and generation fence.
 *
 * A caller must stop native playback synchronously when it receives a cancelled effect, then
 * process the matching speech.flush. Chunks returned by takeNextChunk carry their generation so a
 * native adapter can discard a callback which races with cancellation.
 */
export class MistralDuplexDownlinkReceiver {
  private phase: MistralDuplexReceiverPhase = 'idle';
  private pressure: MistralDuplexBufferPressure = 'accepting';
  private expectedSequence: number;
  private expectedPlaybackGeneration: number;
  private active: ActiveArtifact | null = null;
  private queue: MistralDuplexBufferedChunk[] = [];
  private inFlight: MistralDuplexBufferedChunk[] = [];
  private bufferedBytes = 0;
  private inFlightBytes = 0;
  private consumedThroughChunkIndex: number | null = null;
  private receiverRevision = 0;
  private lastClose: MistralDuplexSpeechClose | null = null;
  private lastCancel: MistralDuplexSpeechCancel | null = null;
  private lastFlush: MistralDuplexSpeechFlush | null = null;
  private readonly terminalCloses: MistralDuplexSpeechClose[] = [];
  private readonly terminalCancels: MistralDuplexSpeechCancel[] = [];
  private readonly terminalFlushes: MistralDuplexSpeechFlush[] = [];
  private readonly terminalDrains: MistralDuplexReceiverPlaybackDrained[] = [];
  private localCancelReason: MistralDuplexCancelReason | null = null;
  private nativeFlushConfirmed = false;
  private serverFlushBarrierReceived = false;
  private readonly config: Readonly<MistralDuplexDownlinkReceiverConfig>;

  constructor(config: MistralDuplexDownlinkReceiverConfig) {
    this.config = snapshotReceiverConfig(config);
    this.expectedSequence = this.config.nextSequence;
    this.expectedPlaybackGeneration = this.config.playbackGeneration;
  }

  accept(input: MistralDuplexDownlinkEnvelope): MistralDuplexReceiverEffect {
    if (this.phase === 'faulted') fail('receiver_faulted');
    let envelope: MistralDuplexDownlinkEnvelope;
    try {
      envelope = normalizeEnvelope(input);
    } catch (error) {
      this.markFaulted();
      throw error;
    }

    if (
      envelope.sessionId !== this.config.sessionId
      || envelope.duplexId !== this.config.duplexId
    ) return this.abort('binding_mismatch');
    if (envelope.connectionEpoch < this.config.connectionEpoch) {
      return {
        type: 'stale_connection_frame',
        connectionEpoch: envelope.connectionEpoch,
        envelopeType: envelope.type,
      };
    }
    if (envelope.connectionEpoch > this.config.connectionEpoch) {
      return this.abort('binding_mismatch');
    }

    if (envelope.type === 'speech.close'
      && this.terminalCloses.some((candidate) => sameClose(envelope, candidate))
    ) {
      return {
        type: 'terminal_replay',
        envelopeType: 'speech.close',
        playbackGeneration: envelope.playbackGeneration,
      };
    }
    if (envelope.type === 'speech.cancel'
      && this.terminalCancels.some((candidate) => sameCancel(envelope, candidate))
    ) {
      return {
        type: 'terminal_replay',
        envelopeType: 'speech.cancel',
        playbackGeneration: envelope.playbackGeneration,
      };
    }
    if (envelope.type === 'speech.flush'
      && this.terminalFlushes.some((candidate) => sameFlush(envelope, candidate))
    ) {
      return {
        type: 'terminal_replay',
        envelopeType: 'speech.flush',
        playbackGeneration: envelope.playbackGeneration,
      };
    }

    if (this.phase === 'closed'
      && envelope.type === 'speech.close'
      && this.lastClose !== null
      && sameClose(envelope, this.lastClose)
    ) {
      return {
        type: 'closed',
        playbackGeneration: envelope.playbackGeneration,
        idempotent: true,
      };
    }
    if (this.phase === 'cancelled_awaiting_flush'
      && envelope.type === 'speech.cancel'
      && this.lastCancel !== null
      && sameCancel(envelope, this.lastCancel)
    ) {
      return {
        type: 'cancelled',
        playbackGeneration: envelope.playbackGeneration,
        nextPlaybackGeneration: envelope.nextPlaybackGeneration,
        flushRequired: true,
        localAlreadyFenced: this.localCancelReason !== null,
        idempotent: true,
      };
    }
    if (this.phase === 'cancelled_awaiting_flush'
      && envelope.type === 'speech.flush'
      && this.lastFlush !== null
      && sameFlush(envelope, this.lastFlush)
    ) {
      return {
        type: 'server_flush_barrier',
        nextPlaybackGeneration: envelope.nextPlaybackGeneration,
        nativeFlushRequired: true,
        idempotent: true,
      };
    }

    if (this.phase === 'locally_cancelled_awaiting_server_cancel') {
      if (envelope.sequence < this.expectedSequence) return this.abort('duplicate_sequence');
      if (envelope.sequence > this.expectedSequence) return this.abort('sequence_gap');
      if (envelope.sequence >= MAX_COUNTER) return this.abort('sequence_exhausted');
      if (envelope.type === 'speech.chunk') return this.acceptDroppedChunkAfterLocalCancel(envelope);
      if (envelope.type === 'speech.close') return this.acceptDroppedCloseAfterLocalCancel(envelope);
      if (envelope.type === 'speech.cancel') return this.acceptCancel(envelope);
      return this.abort('invalid_transition');
    }

    if (envelope.type === 'speech.chunk'
      && envelope.playbackGeneration < this.expectedPlaybackGeneration) {
      return this.abort('stale_generation');
    }
    if (envelope.sequence < this.expectedSequence) return this.abort('duplicate_sequence');
    if (envelope.sequence > this.expectedSequence) return this.abort('sequence_gap');
    if (envelope.sequence >= MAX_COUNTER) return this.abort('sequence_exhausted');

    switch (envelope.type) {
      case 'speech.open':
        return this.acceptOpen(envelope);
      case 'speech.chunk':
        return this.acceptChunk(envelope);
      case 'speech.close':
        return this.acceptClose(envelope);
      case 'speech.cancel':
        return this.acceptCancel(envelope);
      case 'speech.flush':
        return this.acceptFlush(envelope);
    }
  }

  takeNextChunk(): MistralDuplexBufferedChunk | null {
    if (this.phase === 'faulted') fail('receiver_faulted');
    const chunk = this.queue.shift() ?? null;
    if (chunk === null) return null;
    this.inFlight.push(chunk);
    this.inFlightBytes += chunk.payload.byteLength;
    return chunk;
  }

  /**
   * Libère le crédit uniquement après preuve native de consommation. La remise d'un chunk au
   * player ne réduit jamais la borne mémoire/latence de bout en bout.
   */
  confirmChunkConsumed(
    playbackGeneration: number,
    playbackId: string,
    chunkIndex: number,
  ): MistralDuplexReceiverEffect {
    if (this.phase === 'faulted') fail('receiver_faulted');
    if (!isGeneration(playbackGeneration) || !isUuid(playbackId) || !isSequence(chunkIndex)) {
      return this.abort('invalid_transition');
    }
    if (playbackGeneration < this.expectedPlaybackGeneration) {
      const knownStaleBinding = (
        this.active?.open.playbackGeneration === playbackGeneration
        && this.active.open.artifactId === playbackId
      ) || this.isKnownTerminalPlaybackBinding(playbackGeneration, playbackId);
      if (!knownStaleBinding) return this.abort('binding_mismatch');
      return { type: 'stale_native_callback', playbackGeneration, chunkIndex };
    }
    const active = this.active;
    const first = this.inFlight[0];
    if (
      active === null
      || (this.phase !== 'streaming' && this.phase !== 'closed')
      || active.open.playbackGeneration !== playbackGeneration
      || active.open.artifactId !== playbackId
      || first === undefined
      || first.playbackGeneration !== playbackGeneration
      || first.chunkIndex !== chunkIndex
    ) return this.abort('playback_not_drained');
    this.inFlight.shift();
    this.inFlightBytes -= first.payload.byteLength;
    this.bufferedBytes -= first.payload.byteLength;
    this.consumedThroughChunkIndex = chunkIndex;
    if (
      this.pressure === 'backpressured'
      && this.bufferedBytes <= MISTRAL_DUPLEX_DOWNLINK_LIMITS.lowWaterBufferedBytes
      && this.bufferedChunkCount() <= MISTRAL_DUPLEX_DOWNLINK_LIMITS.lowWaterBufferedChunks
    ) {
      this.pressure = 'accepting';
    }
    this.bumpRevision();
    return {
      type: 'chunk_consumed',
      playbackGeneration,
      chunkIndex,
      pressure: this.pressure,
    };
  }

  /**
   * Confirms that every dequeued chunk in a closed generation finished playing. It is intentionally
   * separate from takeNextChunk: dequeueing into a native audio queue is not proof of audibility.
   */
  confirmPlaybackDrained(
    playbackGeneration: number,
    playbackId: string,
    nativePlaybackRevision: number,
    drainedAtMonotonicMs: number,
    nativeQueuedBytes: number,
    nativeQueuedChunks: number,
  ): MistralDuplexReceiverEffect {
    if (this.phase === 'faulted') fail('receiver_faulted');
    if (
      !isGeneration(playbackGeneration)
      || !isUuid(playbackId)
      || !isCanonicalInteger(nativePlaybackRevision, 1, MAX_COUNTER)
      || !isMonotonicMilliseconds(drainedAtMonotonicMs)
      || !isCanonicalInteger(
        nativeQueuedBytes,
        0,
        MISTRAL_DUPLEX_DOWNLINK_LIMITS.maxBufferedBytes,
      )
      || !isCanonicalInteger(
        nativeQueuedChunks,
        0,
        MISTRAL_DUPLEX_DOWNLINK_LIMITS.maxBufferedChunks,
      )
    ) {
      return this.abort('invalid_transition');
    }
    const terminalDrain = this.terminalDrains.find((candidate) => (
      candidate.playbackGeneration === playbackGeneration
      && candidate.artifactId === playbackId
    ));
    if (terminalDrain !== undefined) {
      if (
        terminalDrain.nativePlaybackRevision !== nativePlaybackRevision
        || terminalDrain.drainedAtMonotonicMs !== drainedAtMonotonicMs
        || nativeQueuedBytes !== 0
        || nativeQueuedChunks !== 0
      ) return this.abort('playback_not_drained');
      return Object.freeze({
        type: 'playback_drained',
        playbackGeneration,
        receiverRevision: terminalDrain.receiverRevision,
        idempotent: true,
        control: terminalDrain,
      });
    }
    if (playbackGeneration < this.expectedPlaybackGeneration) {
      if (!this.isKnownTerminalPlaybackBinding(playbackGeneration, playbackId)) {
        return this.abort('binding_mismatch');
      }
      return {
        type: 'stale_native_callback',
        playbackGeneration,
        chunkIndex: null,
      };
    }
    if (this.active !== null && this.active.open.artifactId !== playbackId) {
      return this.abort('binding_mismatch');
    }
    if (
      this.phase !== 'closed'
      || this.active === null
      || this.active.open.playbackGeneration !== playbackGeneration
      || this.queue.length !== 0
      || this.inFlight.length !== 0
      || this.bufferedBytes !== 0
      || nativeQueuedBytes !== 0
      || nativeQueuedChunks !== 0
      || this.consumedThroughChunkIndex !== this.active.open.totalChunks - 1
    ) return this.abort('playback_not_drained');
    if (playbackGeneration >= MAX_COUNTER) return this.abort('generation_exhausted');
    if (this.lastClose === null) return this.abort('invalid_transition');
    const active = this.active;
    const close = this.lastClose;
    this.bumpRevision();
    const control: MistralDuplexReceiverPlaybackDrained = Object.freeze({
      protocol: MISTRAL_DUPLEX_DOWNLINK_PROTOCOL,
      type: 'receiver.playback_drained',
      sessionId: active.open.sessionId,
      duplexId: active.open.duplexId,
      connectionEpoch: active.open.connectionEpoch,
      turnId: active.open.turnId,
      artifactId: active.open.artifactId,
      playbackGeneration: active.open.playbackGeneration,
      receiverRevision: this.receiverRevision,
      closeSequence: close.sequence,
      nextExpectedSequence: this.expectedSequence,
      consumedThroughChunkIndex: active.open.totalChunks - 1,
      nativePlaybackRevision,
      drainedAtMonotonicMs,
      nativeQueueEmpty: true,
    });
    // Encode/decode ici aussi : une évolution future du type ne peut pas créer un contrôle local
    // que la frontière wire refuserait ensuite après avoir déjà avancé la génération.
    const normalized = Object.freeze(decodeMistralDuplexUpstreamControl(
      encodeMistralDuplexUpstreamControl(control),
    ));
    if (normalized.type !== 'receiver.playback_drained') {
      return this.abort('invalid_transition');
    }
    this.rememberTerminalClose(close);
    this.rememberTerminalDrain(normalized);
    this.expectedPlaybackGeneration = playbackGeneration + 1;
    this.active = null;
    this.phase = 'idle';
    this.pressure = 'accepting';
    this.consumedThroughChunkIndex = null;
    this.localCancelReason = null;
    this.lastClose = null;
    return Object.freeze({
      type: 'playback_drained',
      playbackGeneration,
      receiverRevision: normalized.receiverRevision,
      idempotent: false,
      control: normalized,
    });
  }

  /**
   * Fence local immédiat utilisé après le flush natif d'un barge-in (ou juste avant un flush
   * manuel). Le serveur doit ensuite confirmer avec speech.cancel puis speech.flush.
   */
  cancelLocally(
    reason: MistralDuplexCancelReason,
    playbackGeneration: number,
    playbackId: string,
  ): MistralDuplexReceiverEffect {
    if (this.phase === 'faulted') fail('receiver_faulted');
    if (!isCancelReason(reason) || !isGeneration(playbackGeneration) || !isUuid(playbackId)) {
      return this.abort('invalid_transition');
    }
    const active = this.active;
    if (
      active === null
      || active.open.playbackGeneration !== playbackGeneration
      || active.open.artifactId !== playbackId
    ) return this.abort('binding_mismatch');
    if (
      (
        this.phase === 'locally_cancelled_awaiting_server_cancel'
        || this.phase === 'cancelled_awaiting_flush'
      )
      && this.localCancelReason !== null
    ) {
      return {
        type: 'local_cancelled',
        playbackGeneration: active.open.playbackGeneration,
        nextPlaybackGeneration: this.expectedPlaybackGeneration,
        reason: this.localCancelReason,
        flushRequired: true,
        idempotent: true,
      };
    }
    if (this.phase === 'cancelled_awaiting_flush' && this.localCancelReason === null) {
      this.localCancelReason = reason;
      this.bumpRevision();
      return {
        type: 'local_cancelled',
        playbackGeneration,
        nextPlaybackGeneration: this.expectedPlaybackGeneration,
        reason,
        flushRequired: true,
        idempotent: false,
      };
    }
    if (this.phase !== 'streaming' && this.phase !== 'closed') {
      return this.abort('invalid_transition');
    }
    if (playbackGeneration >= MAX_COUNTER) return this.abort('generation_exhausted');
    const nextPlaybackGeneration = playbackGeneration + 1;
    this.queue = [];
    this.inFlight = [];
    this.bufferedBytes = 0;
    this.inFlightBytes = 0;
    this.pressure = 'backpressured';
    this.expectedPlaybackGeneration = nextPlaybackGeneration;
    this.phase = 'locally_cancelled_awaiting_server_cancel';
    this.localCancelReason = reason;
    this.bumpRevision();
    return {
      type: 'local_cancelled',
      playbackGeneration,
      nextPlaybackGeneration,
      reason,
      flushRequired: true,
      idempotent: false,
    };
  }

  /**
   * Confirme la barrière physique locale. `speech.flush` n'est qu'une barrière serveur : aucune
   * des deux preuves ne peut ouvrir G+1 sans l'autre.
   */
  confirmNativeFlush(
    playbackGeneration: number,
    playbackId: string,
    nextPlaybackGeneration: number,
  ): MistralDuplexReceiverEffect {
    if (this.phase === 'faulted') fail('receiver_faulted');
    if (!isGeneration(playbackGeneration)
      || !isUuid(playbackId)
      || playbackGeneration >= MAX_COUNTER
      || nextPlaybackGeneration !== playbackGeneration + 1
    ) return this.abort('flush_mismatch');

    if (
      this.phase === 'idle'
    ) {
      const terminalCancel = this.terminalCancels.find((candidate) => (
        candidate.playbackGeneration === playbackGeneration
        && candidate.artifactId === playbackId
      ));
      if (terminalCancel !== undefined) {
        if (terminalCancel.nextPlaybackGeneration !== nextPlaybackGeneration) {
          return this.abort('flush_mismatch');
        }
        return {
          type: 'native_flush_confirmed',
          nextPlaybackGeneration,
          serverBarrierRequired: false,
          idempotent: true,
        };
      }
    }

    const active = this.active;
    if (active !== null && active.open.artifactId !== playbackId) {
      return this.abort('binding_mismatch');
    }
    if (
      active === null
      || active.open.playbackGeneration !== playbackGeneration
      || this.expectedPlaybackGeneration !== nextPlaybackGeneration
      || (
        this.phase !== 'locally_cancelled_awaiting_server_cancel'
        && this.phase !== 'cancelled_awaiting_flush'
      )
    ) return this.abort('flush_mismatch');

    if (this.nativeFlushConfirmed) {
      return {
        type: 'native_flush_confirmed',
        nextPlaybackGeneration,
        serverBarrierRequired: !this.serverFlushBarrierReceived,
        idempotent: true,
      };
    }
    this.nativeFlushConfirmed = true;
    this.bumpRevision();
    if (this.serverFlushBarrierReceived) return this.finalizeFlush(nextPlaybackGeneration);
    return {
      type: 'native_flush_confirmed',
      nextPlaybackGeneration,
      serverBarrierRequired: true,
      idempotent: false,
    };
  }

  /**
   * Produit la demande upstream seulement après preuve du flush natif. L'appelant ne reconstruit
   * donc jamais lui-même un binding ou une génération à partir d'un callback UI.
   */
  localCancelRequest(): MistralDuplexReceiverCancelRequest {
    if (this.phase === 'faulted') fail('receiver_faulted');
    const active = this.active;
    if (
      active === null
      || this.localCancelReason === null
      || !this.nativeFlushConfirmed
      || (
        this.phase !== 'locally_cancelled_awaiting_server_cancel'
        && this.phase !== 'cancelled_awaiting_flush'
      )
      || this.expectedPlaybackGeneration !== active.open.playbackGeneration + 1
    ) return this.abort('invalid_transition');
    return Object.freeze({
      protocol: MISTRAL_DUPLEX_DOWNLINK_PROTOCOL,
      type: 'receiver.cancel_requested',
      sessionId: active.open.sessionId,
      duplexId: active.open.duplexId,
      connectionEpoch: active.open.connectionEpoch,
      turnId: active.open.turnId,
      artifactId: active.open.artifactId,
      playbackGeneration: active.open.playbackGeneration,
      receiverRevision: this.receiverRevision,
      reason: this.localCancelReason,
      nextPlaybackGeneration: this.expectedPlaybackGeneration,
      nativeFlushConfirmed: true,
    });
  }

  /** Crédit lié à l'artefact. Aucun sender conforme n'émet avant le premier snapshot. */
  flowControl(): MistralDuplexReceiverFlowControl {
    if (this.phase === 'faulted') fail('receiver_faulted');
    const active = this.active;
    if (active === null || (this.phase !== 'streaming' && this.phase !== 'closed')) {
      return this.abort('invalid_transition');
    }
    const bufferedChunks = this.bufferedChunkCount();
    const routeExhausted = this.routeIsExhausted();
    const mayAcceptChunks = this.phase === 'streaming'
      && !routeExhausted
      && this.pressure === 'accepting';
    return Object.freeze({
      protocol: MISTRAL_DUPLEX_DOWNLINK_PROTOCOL,
      type: 'receiver.flow_control',
      sessionId: active.open.sessionId,
      duplexId: active.open.duplexId,
      connectionEpoch: active.open.connectionEpoch,
      turnId: active.open.turnId,
      artifactId: active.open.artifactId,
      playbackGeneration: active.open.playbackGeneration,
      receiverRevision: this.receiverRevision,
      nextExpectedSequence: this.expectedSequence,
      consumedThroughChunkIndex: this.consumedThroughChunkIndex,
      pressure: mayAcceptChunks ? 'accepting' : 'backpressured',
      routeExhausted,
      availableBytes: mayAcceptChunks
        ? Math.max(0, MISTRAL_DUPLEX_DOWNLINK_LIMITS.highWaterBufferedBytes - this.bufferedBytes)
        : 0,
      availableChunks: mayAcceptChunks
        ? Math.max(0, MISTRAL_DUPLEX_DOWNLINK_LIMITS.highWaterBufferedChunks - bufferedChunks)
        : 0,
    });
  }

  isPlaybackGenerationCurrent(playbackGeneration: number): boolean {
    return this.active !== null
      && this.active.open.playbackGeneration === playbackGeneration
      && (this.phase === 'streaming' || this.phase === 'closed');
  }

  activePlaybackBinding(): MistralDuplexActivePlaybackBinding | null {
    const active = this.active;
    if (active === null) return null;
    return Object.freeze({
      playbackId: active.open.artifactId,
      playbackGeneration: active.open.playbackGeneration,
      finalChunkIndex: active.open.totalChunks - 1,
    });
  }

  snapshot(): MistralDuplexReceiverSnapshot {
    const routeExhausted = this.routeIsExhausted();
    return {
      phase: this.phase,
      pressure: routeExhausted ? 'backpressured' : this.pressure,
      routeExhausted,
      expectedSequence: this.expectedSequence,
      expectedPlaybackGeneration: this.expectedPlaybackGeneration,
      activePlaybackGeneration: this.active?.open.playbackGeneration ?? null,
      receivedChunks: this.active?.receivedChunks ?? 0,
      receivedBytes: this.active?.receivedBytes ?? 0,
      bufferedChunks: this.bufferedChunkCount(),
      bufferedBytes: this.bufferedBytes,
      queuedChunks: this.queue.length,
      queuedBytes: this.bufferedBytes - this.inFlightBytes,
      inFlightChunks: this.inFlight.length,
      inFlightBytes: this.inFlightBytes,
      receiverRevision: this.receiverRevision,
    };
  }

  private acceptOpen(envelope: MistralDuplexSpeechOpen): MistralDuplexReceiverEffect {
    if (this.phase !== 'idle' || this.active !== null) return this.abort('invalid_transition');
    if (this.expectedPlaybackGeneration > MAX_PLAYABLE_GENERATION) {
      return this.abort('generation_exhausted');
    }
    if (envelope.sequence + envelope.totalChunks + 3 >= MAX_COUNTER) {
      return this.abort('sequence_exhausted');
    }
    if (envelope.playbackGeneration < this.expectedPlaybackGeneration) {
      return this.abort('stale_generation');
    }
    if (envelope.playbackGeneration > this.expectedPlaybackGeneration) {
      return this.abort('generation_gap');
    }
    this.active = {
      open: envelope,
      hasher: new Sha256Accumulator(),
      receivedChunks: 0,
      receivedBytes: 0,
    };
    this.phase = 'streaming';
    this.pressure = 'accepting';
    this.queue = [];
    this.inFlight = [];
    this.bufferedBytes = 0;
    this.inFlightBytes = 0;
    this.consumedThroughChunkIndex = null;
    this.advanceSequence();
    this.bumpRevision();
    this.lastClose = null;
    this.lastCancel = null;
    this.lastFlush = null;
    this.localCancelReason = null;
    this.nativeFlushConfirmed = false;
    this.serverFlushBarrierReceived = false;
    return { type: 'opened', playbackGeneration: envelope.playbackGeneration };
  }

  private acceptChunk(envelope: MistralDuplexSpeechChunk): MistralDuplexReceiverEffect {
    const active = this.active;
    if (this.phase !== 'streaming' || active === null) return this.abort('invalid_transition');
    if (this.pressure === 'backpressured') return this.abort('backpressure_violation');
    if (!sameBinding(active.open, envelope)) return this.abort('binding_mismatch');
    if (envelope.chunkIndex !== active.receivedChunks) return this.abort('chunk_order_violation');
    const manifestEntry = active.open.manifest[envelope.chunkIndex];
    if (
      manifestEntry === undefined
      || manifestEntry.byteOffset !== envelope.byteOffset
      || manifestEntry.byteLength !== envelope.byteLength
      || manifestEntry.chunkSha256 !== envelope.chunkSha256
    ) return this.abort('chunk_tampered');

    const nextBufferedBytes = this.bufferedBytes + envelope.payload.byteLength;
    const nextBufferedChunks = this.bufferedChunkCount() + 1;
    if (
      nextBufferedBytes > MISTRAL_DUPLEX_DOWNLINK_LIMITS.maxBufferedBytes
      || nextBufferedChunks > MISTRAL_DUPLEX_DOWNLINK_LIMITS.maxBufferedChunks
    ) return this.abort('buffer_limit_exceeded');

    active.hasher.update(envelope.payload);
    active.receivedChunks += 1;
    active.receivedBytes += envelope.payload.byteLength;
    this.queue.push(Object.freeze({
      playbackGeneration: envelope.playbackGeneration,
      sequence: envelope.sequence,
      chunkIndex: envelope.chunkIndex,
      byteOffset: envelope.byteOffset,
      payload: envelope.payload.slice(),
    }));
    this.bufferedBytes = nextBufferedBytes;
    this.advanceSequence();
    this.bumpRevision();
    if (
      nextBufferedBytes >= MISTRAL_DUPLEX_DOWNLINK_LIMITS.highWaterBufferedBytes
      || nextBufferedChunks >= MISTRAL_DUPLEX_DOWNLINK_LIMITS.highWaterBufferedChunks
    ) {
      this.pressure = 'backpressured';
    }
    return {
      type: 'buffered',
      playbackGeneration: envelope.playbackGeneration,
      pressure: this.pressure,
    };
  }

  private acceptClose(envelope: MistralDuplexSpeechClose): MistralDuplexReceiverEffect {
    const active = this.active;
    if (this.phase !== 'streaming' || active === null) return this.abort('invalid_transition');
    if (!sameBinding(active.open, envelope)) return this.abort('binding_mismatch');
    if (
      active.receivedChunks !== active.open.totalChunks
      || active.receivedBytes !== active.open.totalBytes
    ) return this.abort('close_incomplete');
    if (active.hasher.digestHex() !== active.open.artifactSha256) {
      return this.abort('artifact_tampered');
    }
    this.advanceSequence();
    this.phase = 'closed';
    this.lastClose = envelope;
    this.bumpRevision();
    return {
      type: 'closed',
      playbackGeneration: envelope.playbackGeneration,
      idempotent: false,
    };
  }

  private acceptCancel(envelope: MistralDuplexSpeechCancel): MistralDuplexReceiverEffect {
    const active = this.active;
    const localAlreadyFenced = this.phase === 'locally_cancelled_awaiting_server_cancel';
    if (
      (
        this.phase !== 'streaming'
        && this.phase !== 'closed'
        && this.phase !== 'locally_cancelled_awaiting_server_cancel'
      )
      || active === null
    ) {
      return this.abort('invalid_transition');
    }
    if (!sameBinding(active.open, envelope)) return this.abort('binding_mismatch');
    if (envelope.playbackGeneration >= MAX_COUNTER
      || envelope.nextPlaybackGeneration !== envelope.playbackGeneration + 1) {
      return this.abort('generation_gap');
    }
    this.queue = [];
    this.inFlight = [];
    this.bufferedBytes = 0;
    this.inFlightBytes = 0;
    this.pressure = 'backpressured';
    this.advanceSequence();
    this.expectedPlaybackGeneration = envelope.nextPlaybackGeneration;
    this.phase = 'cancelled_awaiting_flush';
    this.lastCancel = envelope;
    this.lastClose = null;
    this.lastFlush = null;
    this.serverFlushBarrierReceived = false;
    this.nativeFlushConfirmed = localAlreadyFenced && this.nativeFlushConfirmed;
    this.bumpRevision();
    return {
      type: 'cancelled',
      playbackGeneration: envelope.playbackGeneration,
      nextPlaybackGeneration: envelope.nextPlaybackGeneration,
      flushRequired: true,
      localAlreadyFenced,
      idempotent: false,
    };
  }

  private acceptFlush(envelope: MistralDuplexSpeechFlush): MistralDuplexReceiverEffect {
    const active = this.active;
    const cancel = this.lastCancel;
    if (this.phase !== 'cancelled_awaiting_flush' || active === null || cancel === null) {
      return this.abort('invalid_transition');
    }
    if (
      !sameBinding(active.open, envelope)
      || envelope.cancelSequence !== cancel.sequence
      || envelope.nextPlaybackGeneration !== cancel.nextPlaybackGeneration
    ) return this.abort('flush_mismatch');
    this.advanceSequence();
    this.lastFlush = envelope;
    this.serverFlushBarrierReceived = true;
    this.bumpRevision();
    if (!this.nativeFlushConfirmed) {
      return {
        type: 'server_flush_barrier',
        nextPlaybackGeneration: envelope.nextPlaybackGeneration,
        nativeFlushRequired: true,
        idempotent: false,
      };
    }
    return this.finalizeFlush(envelope.nextPlaybackGeneration);
  }

  private acceptDroppedChunkAfterLocalCancel(
    envelope: MistralDuplexSpeechChunk,
  ): MistralDuplexReceiverEffect {
    const active = this.active;
    if (active === null || !sameBinding(active.open, envelope)) {
      return this.abort('binding_mismatch');
    }
    if (envelope.chunkIndex !== active.receivedChunks) {
      return this.abort('chunk_order_violation');
    }
    const manifestEntry = active.open.manifest[envelope.chunkIndex];
    if (
      manifestEntry === undefined
      || manifestEntry.byteOffset !== envelope.byteOffset
      || manifestEntry.byteLength !== envelope.byteLength
      || manifestEntry.chunkSha256 !== envelope.chunkSha256
    ) return this.abort('chunk_tampered');
    active.hasher.update(envelope.payload);
    active.receivedChunks += 1;
    active.receivedBytes += envelope.payload.byteLength;
    this.advanceSequence();
    this.bumpRevision();
    return {
      type: 'dropped_after_local_cancel',
      playbackGeneration: envelope.playbackGeneration,
      envelopeType: 'speech.chunk',
    };
  }

  private acceptDroppedCloseAfterLocalCancel(
    envelope: MistralDuplexSpeechClose,
  ): MistralDuplexReceiverEffect {
    const active = this.active;
    if (active === null || !sameBinding(active.open, envelope)) {
      return this.abort('binding_mismatch');
    }
    if (
      active.receivedChunks !== active.open.totalChunks
      || active.receivedBytes !== active.open.totalBytes
    ) return this.abort('close_incomplete');
    if (active.hasher.digestHex() !== active.open.artifactSha256) {
      return this.abort('artifact_tampered');
    }
    this.advanceSequence();
    this.lastClose = envelope;
    this.bumpRevision();
    return {
      type: 'dropped_after_local_cancel',
      playbackGeneration: envelope.playbackGeneration,
      envelopeType: 'speech.close',
    };
  }

  private finalizeFlush(nextPlaybackGeneration: number): MistralDuplexReceiverEffect {
    const cancel = this.lastCancel;
    const flush = this.lastFlush;
    if (cancel === null || flush === null) return this.abort('flush_mismatch');
    this.rememberTerminalCancel(cancel);
    this.rememberTerminalFlush(flush);
    this.active = null;
    this.phase = 'idle';
    this.pressure = 'accepting';
    this.queue = [];
    this.inFlight = [];
    this.bufferedBytes = 0;
    this.inFlightBytes = 0;
    this.consumedThroughChunkIndex = null;
    this.localCancelReason = null;
    this.nativeFlushConfirmed = false;
    this.serverFlushBarrierReceived = false;
    this.bumpRevision();
    return { type: 'flushed', nextPlaybackGeneration };
  }

  private bufferedChunkCount(): number {
    return this.queue.length + this.inFlight.length;
  }

  private routeIsExhausted(): boolean {
    if (this.expectedPlaybackGeneration > MAX_PLAYABLE_GENERATION) return true;
    if (this.active === null) {
      return this.expectedSequence > MAX_COUNTER - MIN_ROUTE_SEQUENCE_SLOTS;
    }
    // Une génération ouverte doit toujours pouvoir émettre cancel + flush, y compris après close.
    return this.expectedSequence > MAX_COUNTER - 2;
  }

  private isKnownTerminalPlaybackBinding(
    playbackGeneration: number,
    playbackId: string,
  ): boolean {
    return this.terminalCloses.some((candidate) => (
      candidate.playbackGeneration === playbackGeneration
      && candidate.artifactId === playbackId
    )) || this.terminalCancels.some((candidate) => (
      candidate.playbackGeneration === playbackGeneration
      && candidate.artifactId === playbackId
    )) || this.terminalDrains.some((candidate) => (
      candidate.playbackGeneration === playbackGeneration
      && candidate.artifactId === playbackId
    ));
  }

  private rememberTerminalClose(envelope: MistralDuplexSpeechClose): void {
    this.pushTerminalTombstone(this.terminalCloses, envelope);
  }

  private rememberTerminalCancel(envelope: MistralDuplexSpeechCancel): void {
    this.pushTerminalTombstone(this.terminalCancels, envelope);
  }

  private rememberTerminalFlush(envelope: MistralDuplexSpeechFlush): void {
    this.pushTerminalTombstone(this.terminalFlushes, envelope);
  }

  private rememberTerminalDrain(control: MistralDuplexReceiverPlaybackDrained): void {
    this.pushTerminalTombstone(this.terminalDrains, control);
  }

  private pushTerminalTombstone<T>(entries: T[], entry: T): void {
    entries.push(entry);
    if (entries.length > TERMINAL_TOMBSTONE_LIMIT) entries.shift();
  }

  private advanceSequence(): void {
    if (this.expectedSequence >= MAX_COUNTER) return this.abort('sequence_exhausted');
    this.expectedSequence += 1;
  }

  private bumpRevision(): void {
    if (this.receiverRevision >= MAX_COUNTER) return this.abort('generation_exhausted');
    this.receiverRevision += 1;
  }

  private abort(code: MistralDuplexProtocolErrorCode): never {
    this.markFaulted();
    return fail(code);
  }

  private markFaulted(): void {
    this.phase = 'faulted';
    this.pressure = 'backpressured';
    this.queue = [];
    this.inFlight = [];
    this.bufferedBytes = 0;
    this.inFlightBytes = 0;
    this.consumedThroughChunkIndex = null;
    this.active = null;
  }
}
