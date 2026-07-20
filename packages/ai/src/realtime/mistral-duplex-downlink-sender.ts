/**
 * Pure, bounded server-side sender for `bob.mistral-duplex.v3`.
 *
 * The sender only accepts a complete artifact whose audit proof and byte commitments already
 * exist. It never accepts speech text, transcripts or business controls. WebSocket ownership,
 * persistence and retries across connection epochs belong to the API adapter.
 */

import {
  MISTRAL_DUPLEX_DOWNLINK_LIMITS,
  decodeMistralDuplexBinaryChunk,
  decodeMistralDuplexTextEnvelope,
  decodeMistralDuplexUpstreamControl,
  encodeMistralDuplexBinaryChunk,
  encodeMistralDuplexTextEnvelope,
  encodeMistralDuplexUpstreamControl,
  mistralDuplexSha256Hex,
  type MistralDuplexArtifactBinding,
  type MistralDuplexBufferPressure,
  type MistralDuplexCancelReason,
  type MistralDuplexDownlinkEnvelope,
  type MistralDuplexManifestEntry,
  type MistralDuplexPreparedArtifact,
  type MistralDuplexReceiverCancelRequest,
  type MistralDuplexReceiverFlowControl,
  type MistralDuplexReceiverPlaybackDrained,
  type MistralDuplexSpeechCancel,
  type MistralDuplexSpeechChunk,
  type MistralDuplexSpeechClose,
  type MistralDuplexSpeechFlush,
  type MistralDuplexSpeechOpen,
  type MistralDuplexUpstreamControl,
} from './mistral-duplex-downlink-protocol';

const MAX_INT32 = 0x7fff_ffff;
const RESERVED_TERMINAL_FRAMES = 3; // close + cancel + flush

const ARTIFACT_BINDING_KEYS = [
  'protocol',
  'sessionId',
  'duplexId',
  'connectionEpoch',
  'turnId',
  'artifactId',
  'playbackGeneration',
  'contentType',
  'sampleFormat',
  'sampleRateHz',
  'channels',
  'totalBytes',
  'artifactSha256',
  'totalChunks',
  'manifestSha256',
  'auditProofSha256',
] as const satisfies readonly (keyof MistralDuplexArtifactBinding)[];

const MANIFEST_ENTRY_KEYS = [
  'chunkIndex',
  'byteOffset',
  'byteLength',
  'chunkSha256',
] as const satisfies readonly (keyof MistralDuplexManifestEntry)[];

const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object;
const TYPED_ARRAY_BUFFER_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'buffer',
)?.get;
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'byteLength',
)?.get;

export type MistralDuplexSenderErrorCode =
  | 'invalid_sender_config'
  | 'artifact_payload_mismatch'
  | 'sender_faulted'
  | 'sender_disposed'
  | 'invalid_sender_transition'
  | 'binding_mismatch'
  | 'stale_connection_epoch'
  | 'future_connection_epoch'
  | 'receiver_control_replayed'
  | 'receiver_control_reordered'
  | 'receiver_control_future'
  | 'receiver_control_conflict'
  | 'receiver_credit_conflict'
  | 'sequence_exhausted'
  | 'revision_exhausted';

/** Stable, code-only diagnostics. No wire value or audio byte is ever copied into the message. */
export class MistralDuplexSenderError extends Error {
  constructor(readonly code: MistralDuplexSenderErrorCode) {
    super(code);
    this.name = 'MistralDuplexSenderError';
  }
}

export type MistralDuplexSenderPhase =
  | 'prepared'
  | 'awaiting_flow_control'
  | 'streaming'
  | 'closed'
  | 'cancelled'
  | 'disposed'
  | 'faulted';

export interface MistralDuplexSenderSnapshot {
  readonly phase: MistralDuplexSenderPhase;
  readonly nextSequence: number;
  readonly emittedChunks: number;
  readonly acknowledgedChunks: number;
  readonly consumedChunks: number;
  readonly retainedPayloadBytes: number;
  readonly availableBytes: number;
  readonly availableChunks: number;
  /** Durable receiver cursor immediately before this artifact. */
  readonly receiverRevisionBase: number;
  readonly receiverRevision: number;
  /** Durable native playback cursor immediately before this artifact. */
  readonly nativePlaybackRevisionBase: number;
  readonly nativePlaybackRevision: number;
  readonly terminalReplayAvailable: boolean;
}

export type MistralDuplexSenderControlEffect =
  | {
      readonly type: 'flow_control_applied';
      readonly receiverRevision: number;
      readonly acknowledgedChunks: number;
      readonly consumedChunks: number;
      /** Spendable credit after subtracting already-emitted frames absent from the snapshot. */
      readonly availableBytes: number;
      readonly availableChunks: number;
    }
  | {
      readonly type: 'cancel_barrier';
      readonly receiverRevision: number;
      readonly idempotent: boolean;
      /** Exact terminal frames. An idempotent replay returns the same sequences and reason. */
      readonly frames: readonly [MistralDuplexSpeechCancel, MistralDuplexSpeechFlush];
    }
  | {
      /** A pre-terminal flow proof which completed late. It never changes credit or phase. */
      readonly type: 'terminal_flow_control_ignored';
      readonly receiverRevision: number;
      readonly acknowledgedChunks: number;
      readonly consumedChunks: number;
      readonly idempotent: true;
    }
  | {
      /** Preuve validée à remettre à l'autorité durable; le sender ne marque rien livré. */
      readonly type: 'playback_drained_applied';
      readonly artifactId: string;
      readonly playbackGeneration: number;
      readonly receiverRevision: number;
      readonly nativePlaybackRevision: number;
      readonly drainedAtMonotonicMs: number;
      readonly idempotent: boolean;
      readonly proof: MistralDuplexReceiverPlaybackDrained;
    };

export interface MistralDuplexAuthorityCancelEffect {
  readonly type: 'authority_cancel_barrier';
  readonly reason: MistralDuplexCancelReason;
  readonly idempotent: boolean;
  /** Exact terminal frames. A same-reason replay returns the same immutable pair. */
  readonly frames: readonly [MistralDuplexSpeechCancel, MistralDuplexSpeechFlush];
}

export interface MistralDuplexDownlinkSenderConfig {
  readonly artifact: MistralDuplexPreparedArtifact;
  /** PCM chunks in the exact order and boundaries committed by `artifact.manifest`. */
  readonly chunks: readonly Uint8Array[];
  /** First downlink sequence allocated to `speech.open` for this connection epoch. */
  readonly nextSequence: number;
  /** Cumulative receiver revision committed by the preceding generation in this epoch. */
  readonly receiverRevisionBase: number;
  /** Cumulative native playback revision committed by the preceding generation in this epoch. */
  readonly nativePlaybackRevisionBase: number;
}

export interface MistralDuplexSenderAuthorizationSnapshot
extends MistralDuplexArtifactBinding {
  readonly openSequence: number;
}

interface RemoteState {
  readonly acceptedChunks: number;
  readonly consumedChunks: number;
  readonly pressure: MistralDuplexBufferPressure;
  readonly closeAccepted: boolean;
}

type CancelTerminal =
  | {
      readonly origin: 'receiver';
      readonly request: MistralDuplexReceiverCancelRequest;
      readonly frames: readonly [MistralDuplexSpeechCancel, MistralDuplexSpeechFlush];
    }
  | {
      readonly origin: 'authority';
      readonly reason: MistralDuplexCancelReason;
      readonly frames: readonly [MistralDuplexSpeechCancel, MistralDuplexSpeechFlush];
    };

interface FlowStateAnalysis {
  readonly state: RemoteState;
}

const INITIAL_REMOTE_STATE: RemoteState = Object.freeze({
  acceptedChunks: 0,
  consumedChunks: 0,
  pressure: 'accepting',
  closeAccepted: false,
});

function fail(code: MistralDuplexSenderErrorCode): never {
  throw new MistralDuplexSenderError(code);
}

function exactDataSnapshot<T extends object>(
  value: unknown,
  expectedKeys: readonly (keyof T)[],
): T | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    if (Object.getOwnPropertySymbols(value).length !== 0) return null;
    const names = Object.getOwnPropertyNames(value).sort();
    const wanted = expectedKeys.map(String).sort();
    if (names.length !== wanted.length
      || !names.every((name, index) => name === wanted[index])) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
    const snapshot: Record<string, unknown> = {};
    for (const name of names) {
      const descriptor = descriptors[name];
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) return null;
      snapshot[name] = descriptor.value;
    }
    return Object.freeze(snapshot) as T;
  } catch {
    return null;
  }
}

function exactArraySnapshot(
  value: unknown,
  maximumLength: number,
): readonly unknown[] | null {
  try {
    if (!Array.isArray(value) || Object.getOwnPropertySymbols(value).length !== 0) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
    const lengthDescriptor = descriptors.length;
    if (lengthDescriptor === undefined
      || !('value' in lengthDescriptor)
      || !Number.isSafeInteger(lengthDescriptor.value)
      || (lengthDescriptor.value as number) < 1
      || (lengthDescriptor.value as number) > maximumLength) return null;
    const length = lengthDescriptor.value as number;
    const expectedNames = ['length', ...Array.from({ length }, (_, index) => String(index))].sort();
    const names = Object.getOwnPropertyNames(value).sort();
    if (names.length !== expectedNames.length
      || !names.every((name, index) => name === expectedNames[index])) return null;
    const snapshot: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) return null;
      snapshot.push(descriptor.value);
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function intrinsicTypedArrayMetadata(value: unknown): {
  readonly buffer: ArrayBufferLike;
  readonly byteLength: number;
} | null {
  if (TYPED_ARRAY_BUFFER_GETTER === undefined || TYPED_ARRAY_BYTE_LENGTH_GETTER === undefined) {
    return null;
  }
  try {
    const buffer = Reflect.apply(TYPED_ARRAY_BUFFER_GETTER, value, []) as ArrayBufferLike;
    const byteLength = Reflect.apply(TYPED_ARRAY_BYTE_LENGTH_GETTER, value, []) as number;
    return { buffer, byteLength };
  } catch {
    return null;
  }
}

function isInt32(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_INT32;
}

function sameCancelRequestBinding(
  left: MistralDuplexReceiverCancelRequest,
  right: MistralDuplexReceiverCancelRequest,
): boolean {
  return left.protocol === right.protocol
    && left.sessionId === right.sessionId
    && left.duplexId === right.duplexId
    && left.connectionEpoch === right.connectionEpoch
    && left.turnId === right.turnId
    && left.artifactId === right.artifactId
    && left.playbackGeneration === right.playbackGeneration
    && left.reason === right.reason
    && left.nextPlaybackGeneration === right.nextPlaybackGeneration
    && left.nativeFlushConfirmed === right.nativeFlushConfirmed;
}

function samePlaybackDrainProof(
  left: MistralDuplexReceiverPlaybackDrained,
  right: MistralDuplexReceiverPlaybackDrained,
): boolean {
  return left.protocol === right.protocol
    && left.type === right.type
    && left.sessionId === right.sessionId
    && left.duplexId === right.duplexId
    && left.connectionEpoch === right.connectionEpoch
    && left.turnId === right.turnId
    && left.artifactId === right.artifactId
    && left.playbackGeneration === right.playbackGeneration
    && left.receiverRevision === right.receiverRevision
    && left.closeSequence === right.closeSequence
    && left.nextExpectedSequence === right.nextExpectedSequence
    && left.consumedThroughChunkIndex === right.consumedThroughChunkIndex
    && left.nativePlaybackRevision === right.nativePlaybackRevision
    && left.drainedAtMonotonicMs === right.drainedAtMonotonicMs
    && left.nativeQueueEmpty === right.nativeQueueEmpty;
}

function prefixBytes(manifest: readonly MistralDuplexManifestEntry[]): readonly number[] {
  const result = new Array<number>(manifest.length + 1).fill(0);
  for (let index = 0; index < manifest.length; index += 1) {
    result[index + 1] = result[index]! + manifest[index]!.byteLength;
  }
  return Object.freeze(result);
}

function bufferedBytes(
  bytePrefixes: readonly number[],
  acceptedChunks: number,
  consumedChunks: number,
): number {
  return bytePrefixes[acceptedChunks]! - bytePrefixes[consumedChunks]!;
}

/**
 * Verifies that a reported pressure can be reached despite omitted intermediate controls.
 * Accept and consume events retain their receiver ordering and the exact hysteresis contract.
 */
function canReachRemoteState(input: {
  readonly from: RemoteState;
  readonly targetAcceptedChunks: number;
  readonly targetConsumedChunks: number;
  readonly targetPressure: MistralDuplexBufferPressure;
  readonly bytePrefixes: readonly number[];
}): boolean {
  const { from, targetAcceptedChunks, targetConsumedChunks, targetPressure, bytePrefixes } = input;
  if (
    targetAcceptedChunks < from.acceptedChunks
    || targetConsumedChunks < from.consumedChunks
    || targetConsumedChunks > targetAcceptedChunks
    || (from.closeAccepted && targetAcceptedChunks !== from.acceptedChunks)
  ) return false;

  type Reachable = readonly [accepted: number, consumed: number, pressure: MistralDuplexBufferPressure];
  const pending: Reachable[] = [[from.acceptedChunks, from.consumedChunks, from.pressure]];
  const visited = new Set<string>();

  while (pending.length > 0) {
    const [accepted, consumed, pressure] = pending.pop()!;
    const key = `${accepted}:${consumed}:${pressure}`;
    if (visited.has(key)) continue;
    visited.add(key);

    if (
      accepted === targetAcceptedChunks
      && consumed === targetConsumedChunks
      && pressure === targetPressure
    ) return true;

    if (!from.closeAccepted && accepted < targetAcceptedChunks && pressure === 'accepting') {
      const nextAccepted = accepted + 1;
      const nextBufferedChunks = nextAccepted - consumed;
      const nextBufferedBytes = bufferedBytes(bytePrefixes, nextAccepted, consumed);
      const nextPressure = (
        nextBufferedBytes >= MISTRAL_DUPLEX_DOWNLINK_LIMITS.highWaterBufferedBytes
        || nextBufferedChunks >= MISTRAL_DUPLEX_DOWNLINK_LIMITS.highWaterBufferedChunks
      ) ? 'backpressured' : 'accepting';
      pending.push([nextAccepted, consumed, nextPressure]);
    }

    if (consumed < targetConsumedChunks && consumed < accepted) {
      const nextConsumed = consumed + 1;
      const nextBufferedChunks = accepted - nextConsumed;
      const nextBufferedBytes = bufferedBytes(bytePrefixes, accepted, nextConsumed);
      const nextPressure = (
        pressure === 'backpressured'
        && nextBufferedBytes <= MISTRAL_DUPLEX_DOWNLINK_LIMITS.lowWaterBufferedBytes
        && nextBufferedChunks <= MISTRAL_DUPLEX_DOWNLINK_LIMITS.lowWaterBufferedChunks
      ) ? 'accepting' : pressure;
      pending.push([accepted, nextConsumed, nextPressure]);
    }
  }
  return false;
}

/**
 * One-artifact V3 sender. It deliberately has no async work: a gateway calls `nextEnvelope()` only
 * when its own socket write budget is available, and calls `acceptControl()` for strictly decoded
 * receiver controls.
 *
 * An adapter-level `sendControl` must use successful write/enqueue as its ordering point, not the
 * later completion of an async transport promise. Frames returned earlier remain ahead of a
 * cancel barrier even if their completion promises resolve later. This state machine does not
 * invent socket semantics or reorder frames on behalf of an adapter.
 */
export class MistralDuplexDownlinkSender {
  private phase: MistralDuplexSenderPhase = 'prepared';
  private readonly openEnvelope!: MistralDuplexSpeechOpen;
  private readonly binding!: MistralDuplexArtifactBinding;
  private readonly manifest!: readonly MistralDuplexManifestEntry[];
  private readonly bytePrefixes!: readonly number[];
  private payloads: Array<Uint8Array | null> = [];
  private retainedPayloadBytes = 0;
  private nextSequence = 0;
  private emittedChunks = 0;
  private availableBytes = 0;
  private availableChunks = 0;
  private closeEmitted = false;
  private readonly receiverRevisionBase!: number;
  private lastReceiverRevision = 0;
  private readonly nativePlaybackRevisionBase!: number;
  private lastNativePlaybackRevision = 0;
  private lastAcknowledgedSequence = 0;
  private remoteState: RemoteState = {
    acceptedChunks: 0,
    consumedChunks: 0,
    pressure: 'accepting',
    closeAccepted: false,
  };
  private terminal: CancelTerminal | null = null;
  /** Cache de validation/replay uniquement; l'état durable de livraison vit hors de ce sender. */
  private playbackDrainProof: MistralDuplexReceiverPlaybackDrained | null = null;

  constructor(config: MistralDuplexDownlinkSenderConfig) {
    const configSnapshot = exactDataSnapshot<MistralDuplexDownlinkSenderConfig>(
      config,
      [
        'artifact',
        'chunks',
        'nextSequence',
        'receiverRevisionBase',
        'nativePlaybackRevisionBase',
      ],
    );
    const artifactSnapshot = configSnapshot === null
      ? null
      : exactDataSnapshot<MistralDuplexPreparedArtifact>(
          configSnapshot.artifact,
          ['binding', 'manifest'],
        );
    const bindingSnapshot = artifactSnapshot === null
      ? null
      : exactDataSnapshot<MistralDuplexArtifactBinding>(
          artifactSnapshot.binding,
          ARTIFACT_BINDING_KEYS,
        );
    const rawManifest = artifactSnapshot === null
      ? null
      : exactArraySnapshot(
          artifactSnapshot.manifest,
          MISTRAL_DUPLEX_DOWNLINK_LIMITS.maxChunksPerArtifact,
        );
    const rawChunks = configSnapshot === null
      ? null
      : exactArraySnapshot(
          configSnapshot.chunks,
          MISTRAL_DUPLEX_DOWNLINK_LIMITS.maxChunksPerArtifact,
        );
    if (
      configSnapshot === null
      || artifactSnapshot === null
      || bindingSnapshot === null
      || rawManifest === null
      || rawChunks === null
      || !isInt32(configSnapshot.nextSequence)
      || !isInt32(configSnapshot.receiverRevisionBase)
      || !isInt32(configSnapshot.nativePlaybackRevisionBase)
    ) fail('invalid_sender_config');

    const manifest: MistralDuplexManifestEntry[] = [];
    for (const rawEntry of rawManifest) {
      const entry = exactDataSnapshot<MistralDuplexManifestEntry>(
        rawEntry,
        MANIFEST_ENTRY_KEYS,
      );
      if (entry === null) fail('invalid_sender_config');
      manifest.push(entry);
    }
    const immutableManifest = Object.freeze(manifest);
    const nextSequence = configSnapshot.nextSequence;

    const candidate: MistralDuplexSpeechOpen = {
      ...bindingSnapshot,
      type: 'speech.open',
      sequence: nextSequence,
      manifest: immutableManifest,
    };
    const normalized = decodeMistralDuplexTextEnvelope(
      encodeMistralDuplexTextEnvelope(candidate),
    );
    if (normalized.type !== 'speech.open') fail('invalid_sender_config');
    if (
      nextSequence + normalized.totalChunks + RESERVED_TERMINAL_FRAMES >= MAX_INT32
    ) fail('sequence_exhausted');
    if (
      // Reserve the worst valid receiver path: open + flow + every accepted/consumed chunk,
      // close, local cancel fence and native flush proof. A normal drain consumes one revision
      // less, but admitting only that path would strand a legitimate cancel-after-close.
      configSnapshot.receiverRevisionBase + 4 + normalized.totalChunks * 2 > MAX_INT32
      || configSnapshot.nativePlaybackRevisionBase + 2 + normalized.totalChunks * 2 > MAX_INT32
    ) fail('revision_exhausted');
    if (rawChunks.length !== normalized.totalChunks) fail('artifact_payload_mismatch');

    const payloads: Uint8Array[] = [];
    const aggregate = new Uint8Array(normalized.totalBytes);
    let committed = false;
    try {
      let aggregateOffset = 0;
      for (let index = 0; index < rawChunks.length; index += 1) {
        const payload = rawChunks[index];
        const entry = normalized.manifest[index];
        const metadata = intrinsicTypedArrayMetadata(payload);
        if (
          !(payload instanceof Uint8Array)
          || metadata === null
          || !(metadata.buffer instanceof ArrayBuffer)
          || entry === undefined
          || metadata.byteLength !== entry.byteLength
        ) return fail('artifact_payload_mismatch');

        // Ne jamais appeler une méthode surchargeable du payload. `set.call` effectue une copie
        // TypedArray intrinsèque vers un buffer standalone détenu uniquement par le sender.
        const owned = new Uint8Array(metadata.byteLength);
        try {
          Uint8Array.prototype.set.call(owned, payload);
        } catch {
          owned.fill(0);
          return fail('artifact_payload_mismatch');
        }
        if (mistralDuplexSha256Hex(owned) !== entry.chunkSha256) {
          owned.fill(0);
          return fail('artifact_payload_mismatch');
        }
        payloads.push(owned);
        aggregate.set(owned, aggregateOffset);
        aggregateOffset += owned.byteLength;
      }
      if (mistralDuplexSha256Hex(aggregate) !== normalized.artifactSha256) {
        return fail('artifact_payload_mismatch');
      }

      this.openEnvelope = Object.freeze(normalized);
      this.binding = Object.freeze({
        protocol: normalized.protocol,
        sessionId: normalized.sessionId,
        duplexId: normalized.duplexId,
        connectionEpoch: normalized.connectionEpoch,
        turnId: normalized.turnId,
        artifactId: normalized.artifactId,
        playbackGeneration: normalized.playbackGeneration,
        contentType: normalized.contentType,
        sampleFormat: normalized.sampleFormat,
        sampleRateHz: normalized.sampleRateHz,
        channels: normalized.channels,
        totalBytes: normalized.totalBytes,
        artifactSha256: normalized.artifactSha256,
        totalChunks: normalized.totalChunks,
        manifestSha256: normalized.manifestSha256,
        auditProofSha256: normalized.auditProofSha256,
      });
      this.manifest = normalized.manifest;
      this.bytePrefixes = prefixBytes(normalized.manifest);
      this.payloads = payloads;
      this.retainedPayloadBytes = normalized.totalBytes;
      this.nextSequence = nextSequence;
      this.lastAcknowledgedSequence = nextSequence;
      this.receiverRevisionBase = configSnapshot.receiverRevisionBase;
      this.lastReceiverRevision = configSnapshot.receiverRevisionBase;
      this.nativePlaybackRevisionBase = configSnapshot.nativePlaybackRevisionBase;
      this.lastNativePlaybackRevision = configSnapshot.nativePlaybackRevisionBase;
      committed = true;
    } finally {
      aggregate.fill(0);
      if (!committed) {
        for (const owned of payloads) owned.fill(0);
      }
    }
  }

  /** Immutable identity of the exact normalized `speech.open` this sender can emit. */
  authorizationSnapshot(): MistralDuplexSenderAuthorizationSnapshot {
    return Object.freeze({
      ...this.binding,
      openSequence: this.openEnvelope.sequence,
    });
  }

  /**
   * Returns at most one frame. `null` means either receiver credit or a terminal state blocks work.
   * The first call emits `speech.open`; chunks remain impossible until an exact flow control.
   */
  nextEnvelope(): MistralDuplexDownlinkEnvelope | null {
    if (this.phase === 'faulted') return fail('sender_faulted');
    if (this.phase === 'disposed') return fail('sender_disposed');
    try {
      if (this.phase === 'prepared') {
        this.advanceSequence();
        this.phase = 'awaiting_flow_control';
        return this.openEnvelope;
      }
      if (this.phase === 'awaiting_flow_control' || this.phase === 'closed' || this.phase === 'cancelled') {
        return null;
      }
      if (this.emittedChunks < this.manifest.length) {
        const entry = this.manifest[this.emittedChunks]!;
        if (this.availableChunks < 1 || this.availableBytes < entry.byteLength) return null;
        const ownedPayload = this.payloads[this.emittedChunks];
        if (ownedPayload === null || ownedPayload === undefined) {
          return this.abort('invalid_sender_transition');
        }
        const candidate: MistralDuplexSpeechChunk & { readonly encoding: 'binary' } = {
          ...this.binding,
          type: 'speech.chunk',
          sequence: this.nextSequence,
          ...entry,
          encoding: 'binary',
          payload: ownedPayload,
        };
        const normalized = decodeMistralDuplexBinaryChunk(
          encodeMistralDuplexBinaryChunk(candidate),
        );
        this.availableBytes -= entry.byteLength;
        this.availableChunks -= 1;
        this.emittedChunks += 1;
        this.payloads[this.emittedChunks - 1] = null;
        this.retainedPayloadBytes -= entry.byteLength;
        ownedPayload.fill(0);
        this.advanceSequence();
        return Object.freeze(normalized);
      }

      const candidate: MistralDuplexSpeechClose = {
        ...this.binding,
        type: 'speech.close',
        sequence: this.nextSequence,
      };
      const normalized = decodeMistralDuplexTextEnvelope(
        encodeMistralDuplexTextEnvelope(candidate),
      );
      if (normalized.type !== 'speech.close') return this.abort('invalid_sender_transition');
      this.advanceSequence();
      this.closeEmitted = true;
      this.phase = 'closed';
      this.clearPayloads();
      return Object.freeze(normalized);
    } catch (error) {
      this.markFaulted();
      throw error;
    }
  }

  /** Applies a receiver credit proof or returns the exact cancel+flush terminal barrier. */
  acceptControl(control: MistralDuplexUpstreamControl): MistralDuplexSenderControlEffect {
    if (this.phase === 'faulted') return fail('sender_faulted');
    if (this.phase === 'disposed') return fail('sender_disposed');
    let normalized: MistralDuplexUpstreamControl;
    try {
      normalized = decodeMistralDuplexUpstreamControl(
        encodeMistralDuplexUpstreamControl(control),
      );
      this.assertControlBinding(normalized);
      if (normalized.type === 'receiver.flow_control') return this.applyFlowControl(normalized);
      if (normalized.type === 'receiver.cancel_requested') {
        return this.applyCancelRequest(normalized);
      }
      return this.applyPlaybackDrained(normalized);
    } catch (error) {
      if (!(error instanceof MistralDuplexSenderError && error.code === 'sender_faulted')) {
        this.markFaulted();
      }
      throw error;
    }
  }

  /**
   * Pose la barrière terminale demandée par l'autorité serveur, sans fabriquer de preuve mobile.
   *
   * Contrairement à `receiver.cancel_requested`, cette voie ne prétend jamais que le flush natif
   * a déjà eu lieu. Elle ordonne seulement `speech.cancel` puis `speech.flush` dans le FIFO
   * descendant. Le mobile reste responsable de l'arrêt acoustique immédiat à leur réception.
   */
  cancelFromAuthority(reason: MistralDuplexCancelReason): MistralDuplexAuthorityCancelEffect {
    if (this.phase === 'faulted') return fail('sender_faulted');
    if (this.phase === 'disposed') return fail('sender_disposed');
    if (this.playbackDrainProof !== null) return this.abort('receiver_control_conflict');

    const terminal = this.terminal;
    if (terminal !== null) {
      if (terminal.origin !== 'authority' || terminal.reason !== reason) {
        return this.abort('receiver_control_conflict');
      }
      return Object.freeze({
        type: 'authority_cancel_barrier',
        reason,
        idempotent: true,
        frames: terminal.frames,
      });
    }
    if (
      this.phase !== 'awaiting_flow_control'
      && this.phase !== 'streaming'
      && this.phase !== 'closed'
    ) return this.abort('invalid_sender_transition');

    const nextPlaybackGeneration = this.binding.playbackGeneration + 1;
    const cancel = this.normalizeCancel({
      ...this.binding,
      type: 'speech.cancel',
      sequence: this.nextSequence,
      reason,
      nextPlaybackGeneration,
    });
    this.advanceSequence();
    const flush = this.normalizeFlush({
      ...this.binding,
      type: 'speech.flush',
      sequence: this.nextSequence,
      cancelSequence: cancel.sequence,
      nextPlaybackGeneration,
    });
    this.advanceSequence();
    const frames = Object.freeze([cancel, flush]) as readonly [
      MistralDuplexSpeechCancel,
      MistralDuplexSpeechFlush,
    ];
    this.terminal = { origin: 'authority', reason, frames };
    this.availableBytes = 0;
    this.availableChunks = 0;
    this.phase = 'cancelled';
    this.clearPayloads();
    return Object.freeze({
      type: 'authority_cancel_barrier',
      reason,
      idempotent: false,
      frames,
    });
  }

  snapshot(): MistralDuplexSenderSnapshot {
    return Object.freeze({
      phase: this.phase,
      nextSequence: this.nextSequence,
      emittedChunks: this.emittedChunks,
      acknowledgedChunks: this.remoteState.acceptedChunks,
      consumedChunks: this.remoteState.consumedChunks,
      retainedPayloadBytes: this.retainedPayloadBytes,
      availableBytes: this.availableBytes,
      availableChunks: this.availableChunks,
      receiverRevisionBase: this.receiverRevisionBase,
      receiverRevision: this.lastReceiverRevision,
      nativePlaybackRevisionBase: this.nativePlaybackRevisionBase,
      nativePlaybackRevision: this.lastNativePlaybackRevision,
      terminalReplayAvailable: this.terminal !== null || this.playbackDrainProof !== null,
    });
  }

  /**
   * Releases every retained PCM copy without manufacturing an invalid protocol transition.
   *
   * A gateway owns connection teardown, while this pure sender owns its defensive payload copies.
   * Disposal is therefore explicit and idempotent; after it, neither a wire frame nor a receiver
   * control can revive the artifact. The terminal replay cache is intentionally discarded too.
   */
  dispose(): void {
    if (this.phase === 'disposed') return;
    this.availableBytes = 0;
    this.availableChunks = 0;
    this.terminal = null;
    this.playbackDrainProof = null;
    this.clearPayloads();
    this.phase = 'disposed';
  }

  private applyFlowControl(
    control: MistralDuplexReceiverFlowControl,
  ): MistralDuplexSenderControlEffect {
    if (this.playbackDrainProof !== null) return this.abort('receiver_control_conflict');
    const terminal = this.terminal;
    if (terminal !== null) return this.ignoreExactTerminalFlowControl(control, terminal);
    if (
      this.phase !== 'awaiting_flow_control'
      && this.phase !== 'streaming'
      && this.phase !== 'closed'
    ) return this.abort('invalid_sender_transition');
    if (control.receiverRevision === this.lastReceiverRevision) {
      return this.abort('receiver_control_replayed');
    }
    if (control.receiverRevision < this.lastReceiverRevision) {
      return this.abort('receiver_control_reordered');
    }
    if (control.nextExpectedSequence < this.lastAcknowledgedSequence) {
      return this.abort('receiver_control_reordered');
    }
    if (control.nextExpectedSequence > this.nextSequence) {
      return this.abort('receiver_control_future');
    }
    const analysis = this.validateFlowState(control, this.remoteState);
    const { acceptedChunks, consumedChunks, closeAccepted } = analysis.state;

    const outstandingChunks = this.emittedChunks - acceptedChunks;
    const outstandingBytes = bufferedBytes(
      this.bytePrefixes,
      this.emittedChunks,
      acceptedChunks,
    );
    if (
      outstandingBytes > control.availableBytes
      || outstandingChunks > control.availableChunks
    ) return this.abort('receiver_credit_conflict');

    this.availableBytes = closeAccepted ? 0 : control.availableBytes - outstandingBytes;
    this.availableChunks = closeAccepted ? 0 : control.availableChunks - outstandingChunks;
    this.lastReceiverRevision = control.receiverRevision;
    this.lastAcknowledgedSequence = control.nextExpectedSequence;
    this.remoteState = analysis.state;
    if (this.phase === 'awaiting_flow_control') this.phase = 'streaming';
    return Object.freeze({
      type: 'flow_control_applied',
      receiverRevision: control.receiverRevision,
      acknowledgedChunks: acceptedChunks,
      consumedChunks,
      availableBytes: this.availableBytes,
      availableChunks: this.availableChunks,
    });
  }

  private ignoreExactTerminalFlowControl(
    control: MistralDuplexReceiverFlowControl,
    terminal: CancelTerminal,
  ): MistralDuplexSenderControlEffect {
    if (terminal.origin === 'authority') {
      const analysis = this.validateFlowState(control, INITIAL_REMOTE_STATE);
      return Object.freeze({
        type: 'terminal_flow_control_ignored',
        receiverRevision: control.receiverRevision,
        acknowledgedChunks: analysis.state.acceptedChunks,
        consumedChunks: analysis.state.consumedChunks,
        idempotent: true,
      });
    }
    if (control.receiverRevision > terminal.request.receiverRevision) {
      return this.abort('receiver_control_future');
    }
    if (control.receiverRevision === terminal.request.receiverRevision) {
      return this.abort('receiver_control_conflict');
    }
    const analysis = this.validateFlowState(control, INITIAL_REMOTE_STATE);
    return Object.freeze({
      type: 'terminal_flow_control_ignored',
      receiverRevision: control.receiverRevision,
      acknowledgedChunks: analysis.state.acceptedChunks,
      consumedChunks: analysis.state.consumedChunks,
      idempotent: true,
    });
  }

  private validateFlowState(
    control: MistralDuplexReceiverFlowControl,
    from: RemoteState,
  ): FlowStateAnalysis {
    const firstAfterOpen = this.openEnvelope.sequence + 1;
    if (control.nextExpectedSequence < firstAfterOpen) {
      return this.abort('receiver_control_conflict');
    }
    const acknowledgedAfterOpen = control.nextExpectedSequence - firstAfterOpen;
    const maximumAcknowledgedAfterOpen = this.emittedChunks + (this.closeEmitted ? 1 : 0);
    if (acknowledgedAfterOpen > maximumAcknowledgedAfterOpen) {
      return this.abort('receiver_control_future');
    }
    const acceptedChunks = Math.min(acknowledgedAfterOpen, this.emittedChunks);
    const closeAccepted = this.closeEmitted && acknowledgedAfterOpen === this.emittedChunks + 1;
    const consumedChunks = control.consumedThroughChunkIndex === null
      ? 0
      : control.consumedThroughChunkIndex + 1;
    if (
      consumedChunks > acceptedChunks
      || consumedChunks < from.consumedChunks
      || acceptedChunks < from.acceptedChunks
    ) return this.abort('receiver_control_conflict');

    const expectedRevision = this.receiverRevisionBase
      + 1
      + acceptedChunks
      + consumedChunks
      + (closeAccepted ? 1 : 0);
    if (control.receiverRevision !== expectedRevision) {
      return this.abort('receiver_control_conflict');
    }
    if (control.routeExhausted) return this.abort('receiver_control_conflict');

    const currentBufferedBytes = bufferedBytes(
      this.bytePrefixes,
      acceptedChunks,
      consumedChunks,
    );
    const currentBufferedChunks = acceptedChunks - consumedChunks;
    if (closeAccepted) {
      if (
        control.pressure !== 'backpressured'
        || control.availableBytes !== 0
        || control.availableChunks !== 0
      ) return this.abort('receiver_control_conflict');
      const closeStateReachable = from.closeAccepted
        ? acceptedChunks === from.acceptedChunks
        : (['accepting', 'backpressured'] as const).some((pressure) => canReachRemoteState({
            from,
            targetAcceptedChunks: acceptedChunks,
            targetConsumedChunks: consumedChunks,
            targetPressure: pressure,
            bytePrefixes: this.bytePrefixes,
          }));
      if (!closeStateReachable) return this.abort('receiver_control_conflict');
    } else {
      if (!canReachRemoteState({
        from,
        targetAcceptedChunks: acceptedChunks,
        targetConsumedChunks: consumedChunks,
        targetPressure: control.pressure,
        bytePrefixes: this.bytePrefixes,
      })) return this.abort('receiver_control_conflict');

      const expectedAvailableBytes = control.pressure === 'accepting'
        ? MISTRAL_DUPLEX_DOWNLINK_LIMITS.highWaterBufferedBytes - currentBufferedBytes
        : 0;
      const expectedAvailableChunks = control.pressure === 'accepting'
        ? MISTRAL_DUPLEX_DOWNLINK_LIMITS.highWaterBufferedChunks - currentBufferedChunks
        : 0;
      if (
        control.availableBytes !== expectedAvailableBytes
        || control.availableChunks !== expectedAvailableChunks
      ) return this.abort('receiver_control_conflict');
    }

    return {
      state: {
        acceptedChunks,
        consumedChunks,
        pressure: control.pressure,
        closeAccepted,
      },
    };
  }

  private applyPlaybackDrained(
    proof: MistralDuplexReceiverPlaybackDrained,
  ): MistralDuplexSenderControlEffect {
    const prior = this.playbackDrainProof;
    if (prior !== null) {
      if (!samePlaybackDrainProof(prior, proof)) {
        return this.abort('receiver_control_conflict');
      }
      return Object.freeze({
        type: 'playback_drained_applied',
        artifactId: prior.artifactId,
        playbackGeneration: prior.playbackGeneration,
        receiverRevision: prior.receiverRevision,
        nativePlaybackRevision: prior.nativePlaybackRevision,
        drainedAtMonotonicMs: prior.drainedAtMonotonicMs,
        idempotent: true,
        proof: prior,
      });
    }
    if (this.terminal !== null) return this.abort('receiver_control_conflict');
    if (
      this.phase !== 'closed'
      || !this.closeEmitted
      || this.emittedChunks !== this.manifest.length
    ) return this.abort('invalid_sender_transition');

    const finalChunkIndex = this.manifest.length - 1;
    const closeSequence = this.openEnvelope.sequence + this.manifest.length + 1;
    const nextExpectedSequence = closeSequence + 1;
    const expectedReceiverRevision = this.receiverRevisionBase + 3 + this.manifest.length * 2;
    const expectedNativePlaybackRevision = this.nativePlaybackRevisionBase
      + 2
      + this.manifest.length * 2;
    if (
      proof.closeSequence !== closeSequence
      || proof.nextExpectedSequence !== nextExpectedSequence
      || proof.nextExpectedSequence !== this.nextSequence
      || proof.consumedThroughChunkIndex !== finalChunkIndex
      || proof.receiverRevision !== expectedReceiverRevision
      || proof.nativePlaybackRevision !== expectedNativePlaybackRevision
      || proof.nativeQueueEmpty !== true
    ) return this.abort('receiver_control_conflict');
    if (proof.receiverRevision <= this.lastReceiverRevision) {
      return this.abort(proof.receiverRevision === this.lastReceiverRevision
        ? 'receiver_control_replayed'
        : 'receiver_control_reordered');
    }
    const fullyDrainedStateIsReachable = (
      ['accepting', 'backpressured'] as const
    ).some((pressure) => canReachRemoteState({
      from: this.remoteState,
      targetAcceptedChunks: this.manifest.length,
      targetConsumedChunks: this.manifest.length,
      targetPressure: pressure,
      bytePrefixes: this.bytePrefixes,
    }));
    if (!fullyDrainedStateIsReachable) return this.abort('receiver_control_conflict');

    const normalized = Object.freeze({ ...proof });
    this.playbackDrainProof = normalized;
    this.lastReceiverRevision = proof.receiverRevision;
    this.lastNativePlaybackRevision = proof.nativePlaybackRevision;
    this.lastAcknowledgedSequence = proof.nextExpectedSequence;
    this.remoteState = Object.freeze({
      acceptedChunks: this.manifest.length,
      consumedChunks: this.manifest.length,
      pressure: 'accepting',
      closeAccepted: true,
    });
    this.availableBytes = 0;
    this.availableChunks = 0;
    return Object.freeze({
      type: 'playback_drained_applied',
      artifactId: normalized.artifactId,
      playbackGeneration: normalized.playbackGeneration,
      receiverRevision: normalized.receiverRevision,
      nativePlaybackRevision: normalized.nativePlaybackRevision,
      drainedAtMonotonicMs: normalized.drainedAtMonotonicMs,
      idempotent: false,
      proof: normalized,
    });
  }

  private applyCancelRequest(
    request: MistralDuplexReceiverCancelRequest,
  ): MistralDuplexSenderControlEffect {
    if (this.playbackDrainProof !== null) return this.abort('receiver_control_conflict');
    const terminal = this.terminal;
    if (terminal !== null) {
      if (terminal.origin !== 'receiver') {
        return this.abort('receiver_control_conflict');
      }
      if (!sameCancelRequestBinding(terminal.request, request)) {
        return this.abort('receiver_control_conflict');
      }
      if (request.receiverRevision < terminal.request.receiverRevision) {
        return this.abort('receiver_control_reordered');
      }
      if (request.receiverRevision > terminal.request.receiverRevision) {
        return this.abort('receiver_control_future');
      }
      return Object.freeze({
        type: 'cancel_barrier',
        receiverRevision: request.receiverRevision,
        idempotent: true,
        frames: terminal.frames,
      });
    }
    if (
      this.phase !== 'awaiting_flow_control'
      && this.phase !== 'streaming'
      && this.phase !== 'closed'
    ) return this.abort('invalid_sender_transition');
    if (request.receiverRevision <= this.lastReceiverRevision) {
      return this.abort(request.receiverRevision === this.lastReceiverRevision
        ? 'receiver_control_replayed'
        : 'receiver_control_reordered');
    }
    if (!this.cancelRevisionIsReachable(request.receiverRevision)) {
      return this.abort('receiver_control_future');
    }

    const cancel = this.normalizeCancel({
      ...this.binding,
      type: 'speech.cancel',
      sequence: this.nextSequence,
      reason: request.reason,
      nextPlaybackGeneration: request.nextPlaybackGeneration,
    });
    this.advanceSequence();
    const flush = this.normalizeFlush({
      ...this.binding,
      type: 'speech.flush',
      sequence: this.nextSequence,
      cancelSequence: cancel.sequence,
      nextPlaybackGeneration: request.nextPlaybackGeneration,
    });
    this.advanceSequence();
    const frames = Object.freeze([cancel, flush]) as readonly [
      MistralDuplexSpeechCancel,
      MistralDuplexSpeechFlush,
    ];
    this.terminal = {
      origin: 'receiver',
      request,
      frames,
    };
    this.lastReceiverRevision = request.receiverRevision;
    this.availableBytes = 0;
    this.availableChunks = 0;
    this.phase = 'cancelled';
    this.clearPayloads();
    return Object.freeze({
      type: 'cancel_barrier',
      receiverRevision: request.receiverRevision,
      idempotent: false,
      frames,
    });
  }

  private cancelRevisionIsReachable(receiverRevision: number): boolean {
    if (this.remoteState.closeAccepted) {
      for (
        let consumedChunks = this.remoteState.consumedChunks;
        consumedChunks <= this.remoteState.acceptedChunks;
        consumedChunks += 1
      ) {
        if (
          receiverRevision
          === this.receiverRevisionBase
            + 3
            + this.remoteState.acceptedChunks
            + consumedChunks
            + 1
        ) return true;
      }
      return false;
    }
    for (
      let acceptedChunks = this.remoteState.acceptedChunks;
      acceptedChunks <= this.emittedChunks;
      acceptedChunks += 1
    ) {
      for (
        let consumedChunks = this.remoteState.consumedChunks;
        consumedChunks <= acceptedChunks;
        consumedChunks += 1
      ) {
        const pressures: readonly MistralDuplexBufferPressure[] = ['accepting', 'backpressured'];
        const reachable = pressures.some((pressure) => canReachRemoteState({
          from: this.remoteState,
          targetAcceptedChunks: acceptedChunks,
          targetConsumedChunks: consumedChunks,
          targetPressure: pressure,
          bytePrefixes: this.bytePrefixes,
        }));
        if (!reachable) continue;
        const closeOptions = this.closeEmitted && acceptedChunks === this.manifest.length
          ? [0, 1] as const
          : [0] as const;
        for (const closeAccepted of closeOptions) {
          // open + accepted chunks + native consumption + optional close + local fence + flush proof
          if (
            receiverRevision
            === this.receiverRevisionBase + 3 + acceptedChunks + consumedChunks + closeAccepted
          ) return true;
        }
      }
    }
    return false;
  }

  private assertControlBinding(control: MistralDuplexUpstreamControl): void {
    if (
      control.sessionId !== this.binding.sessionId
      || control.duplexId !== this.binding.duplexId
      || control.turnId !== this.binding.turnId
      || control.artifactId !== this.binding.artifactId
      || control.playbackGeneration !== this.binding.playbackGeneration
    ) return this.abort('binding_mismatch');
    if (control.connectionEpoch < this.binding.connectionEpoch) {
      return this.abort('stale_connection_epoch');
    }
    if (control.connectionEpoch > this.binding.connectionEpoch) {
      return this.abort('future_connection_epoch');
    }
  }

  private normalizeCancel(candidate: MistralDuplexSpeechCancel): MistralDuplexSpeechCancel {
    const normalized = decodeMistralDuplexTextEnvelope(
      encodeMistralDuplexTextEnvelope(candidate),
    );
    if (normalized.type !== 'speech.cancel') return this.abort('invalid_sender_transition');
    return Object.freeze(normalized);
  }

  private normalizeFlush(candidate: MistralDuplexSpeechFlush): MistralDuplexSpeechFlush {
    const normalized = decodeMistralDuplexTextEnvelope(
      encodeMistralDuplexTextEnvelope(candidate),
    );
    if (normalized.type !== 'speech.flush') return this.abort('invalid_sender_transition');
    return Object.freeze(normalized);
  }

  private advanceSequence(): void {
    if (this.nextSequence >= MAX_INT32) return this.abort('sequence_exhausted');
    this.nextSequence += 1;
  }

  private clearPayloads(): void {
    for (const payload of this.payloads) payload?.fill(0);
    this.payloads = [];
    this.retainedPayloadBytes = 0;
  }

  private abort(code: MistralDuplexSenderErrorCode): never {
    this.markFaulted();
    return fail(code);
  }

  private markFaulted(): void {
    this.phase = 'faulted';
    this.availableBytes = 0;
    this.availableChunks = 0;
    this.clearPayloads();
  }
}
