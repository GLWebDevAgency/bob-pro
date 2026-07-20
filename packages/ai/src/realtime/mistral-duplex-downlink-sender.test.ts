import { describe, expect, it, vi } from 'vitest';
import {
  MISTRAL_DUPLEX_DOWNLINK_LIMITS,
  MistralDuplexDownlinkReceiver,
  MistralDuplexProtocolError,
  createMistralDuplexArtifactManifest,
  type MistralDuplexDownlinkEnvelope,
  type MistralDuplexPreparedArtifact,
  type MistralDuplexReceiverFlowControl,
  type MistralDuplexReceiverPlaybackDrained,
} from './mistral-duplex-downlink-protocol';
import {
  MistralDuplexDownlinkSender,
  MistralDuplexSenderError,
  type MistralDuplexDownlinkSenderConfig,
} from './mistral-duplex-downlink-sender';

const SESSION_ID = '10000000-0000-4000-8000-000000000001';
const DUPLEX_ID = '10000000-0000-4000-8000-000000000002';
const TURN_ID = '20000000-0000-4000-8000-000000000002';
const ARTIFACT_ID = '30000000-0000-4000-8000-000000000003';
const SECOND_TURN_ID = '20000000-0000-4000-8000-000000000004';
const SECOND_ARTIFACT_ID = '30000000-0000-4000-8000-000000000005';
const AUDIT_PROOF_SHA256 = 'a'.repeat(64);
const MAX_INT32 = 0x7fff_ffff;

function pcm(byteLength: number, seed: number): Uint8Array {
  const result = new Uint8Array(byteLength);
  for (let index = 0; index < byteLength; index += 1) {
    result[index] = (seed + index * 17) & 0xff;
  }
  return result;
}

interface Fixture {
  readonly chunks: readonly Uint8Array[];
  readonly prepared: MistralDuplexPreparedArtifact;
  readonly sender: MistralDuplexDownlinkSender;
  readonly receiver: MistralDuplexDownlinkReceiver;
}

function fixture(input: {
  readonly chunks?: readonly Uint8Array[];
  readonly nextSequence?: number;
  readonly connectionEpoch?: number;
  readonly playbackGeneration?: number;
} = {}): Fixture {
  const chunks = input.chunks ?? [pcm(8, 1), pcm(10, 2), pcm(12, 3)];
  const nextSequence = input.nextSequence ?? 0;
  const connectionEpoch = input.connectionEpoch ?? 1;
  const playbackGeneration = input.playbackGeneration ?? 1;
  const prepared = createMistralDuplexArtifactManifest({
    sessionId: SESSION_ID,
    duplexId: DUPLEX_ID,
    connectionEpoch,
    turnId: TURN_ID,
    artifactId: ARTIFACT_ID,
    playbackGeneration,
    auditProofSha256: AUDIT_PROOF_SHA256,
    chunks,
  });
  return {
    chunks,
    prepared,
    sender: new MistralDuplexDownlinkSender({
      artifact: prepared,
      chunks,
      nextSequence,
      receiverRevisionBase: 0,
      nativePlaybackRevisionBase: 0,
    }),
    receiver: new MistralDuplexDownlinkReceiver({
      sessionId: SESSION_ID,
      duplexId: DUPLEX_ID,
      connectionEpoch,
      nextSequence,
      playbackGeneration,
    }),
  };
}

function nextRequired(sender: MistralDuplexDownlinkSender): MistralDuplexDownlinkEnvelope {
  const frame = sender.nextEnvelope();
  if (frame === null) throw new Error('expected_sender_frame');
  return frame;
}

function open(value: Fixture): void {
  const frame = nextRequired(value.sender);
  expect(frame.type).toBe('speech.open');
  expect(value.receiver.accept(frame)).toMatchObject({ type: 'opened' });
}

function confirmPlaybackDrained(
  receiver: MistralDuplexDownlinkReceiver,
  nativePlaybackRevision = 8,
  drainedAtMonotonicMs = 100,
) {
  return receiver.confirmPlaybackDrained(
    1,
    ARTIFACT_ID,
    nativePlaybackRevision,
    drainedAtMonotonicMs,
    0,
    0,
  );
}

function completePublicationAndDrain(
  value: Fixture,
  nativePlaybackRevision = 1,
  drainedAtMonotonicMs = 100,
): MistralDuplexReceiverPlaybackDrained {
  open(value);
  value.sender.acceptControl(value.receiver.flowControl());
  for (let index = 0; index < value.chunks.length; index += 1) {
    expect(value.receiver.accept(nextRequired(value.sender))).toMatchObject({ type: 'buffered' });
  }
  expect(value.receiver.accept(nextRequired(value.sender))).toMatchObject({ type: 'closed' });
  for (let index = 0; index < value.chunks.length; index += 1) {
    expect(value.receiver.takeNextChunk()).toMatchObject({ chunkIndex: index });
    value.receiver.confirmChunkConsumed(1, ARTIFACT_ID, index);
  }
  const effect = confirmPlaybackDrained(
    value.receiver,
    nativePlaybackRevision,
    drainedAtMonotonicMs,
  );
  if (effect.type !== 'playback_drained') throw new Error('expected_playback_drained');
  return effect.control;
}

function expectSenderError(
  action: () => unknown,
  code: MistralDuplexSenderError['code'],
): MistralDuplexSenderError {
  try {
    action();
    throw new Error('expected_sender_error');
  } catch (error) {
    expect(error).toBeInstanceOf(MistralDuplexSenderError);
    expect((error as MistralDuplexSenderError).code).toBe(code);
    expect((error as Error).message).toBe(code);
    return error as MistralDuplexSenderError;
  }
}

describe('Mistral duplex downlink V3 sender — audited artifact and contiguous publication', () => {
  it('publishes open, waits for exact credit, streams committed chunks, then closes', () => {
    const value = fixture();
    expect(value.sender.snapshot()).toMatchObject({
      phase: 'prepared',
      nextSequence: 0,
      retainedPayloadBytes: 30,
    });

    open(value);
    expect(value.sender.nextEnvelope()).toBeNull();
    expect(value.sender.snapshot()).toMatchObject({
      phase: 'awaiting_flow_control',
      nextSequence: 1,
      emittedChunks: 0,
    });

    expect(value.sender.acceptControl(value.receiver.flowControl())).toEqual({
      type: 'flow_control_applied',
      receiverRevision: 1,
      acknowledgedChunks: 0,
      consumedChunks: 0,
      availableBytes: MISTRAL_DUPLEX_DOWNLINK_LIMITS.highWaterBufferedBytes,
      availableChunks: MISTRAL_DUPLEX_DOWNLINK_LIMITS.highWaterBufferedChunks,
    });

    for (let index = 0; index < value.chunks.length; index += 1) {
      const frame = nextRequired(value.sender);
      expect(frame).toMatchObject({
        type: 'speech.chunk',
        sequence: index + 1,
        chunkIndex: index,
        encoding: 'binary',
      });
      expect(value.receiver.accept(frame)).toMatchObject({ type: 'buffered' });
    }
    const close = nextRequired(value.sender);
    expect(close).toMatchObject({ type: 'speech.close', sequence: 4 });
    expect(value.receiver.accept(close)).toMatchObject({ type: 'closed' });
    expect(value.sender.nextEnvelope()).toBeNull();
    expect(value.sender.snapshot()).toMatchObject({
      phase: 'closed',
      nextSequence: 5,
      emittedChunks: 3,
      retainedPayloadBytes: 0,
    });

    for (let index = 0; index < value.chunks.length; index += 1) {
      expect(value.receiver.takeNextChunk()).toMatchObject({ chunkIndex: index });
      value.receiver.confirmChunkConsumed(1, ARTIFACT_ID, index);
    }
    const drain = confirmPlaybackDrained(value.receiver, 8, 900.5);
    if (drain.type !== 'playback_drained') throw new Error('expected_playback_drained');
    expect(value.sender.acceptControl(drain.control)).toMatchObject({
      type: 'playback_drained_applied',
      artifactId: ARTIFACT_ID,
      playbackGeneration: 1,
      receiverRevision: 9,
      nativePlaybackRevision: 8,
      drainedAtMonotonicMs: 900.5,
      idempotent: false,
      proof: drain.control,
    });
    expect(value.receiver.snapshot()).toMatchObject({
      phase: 'idle',
      expectedSequence: 5,
      expectedPlaybackGeneration: 2,
    });
  });

  it('valide puis rejoue exactement playback_drained sans marquer lui-même delivered', () => {
    const value = fixture();
    const proof = completePublicationAndDrain(value, 8, 1_234.5);

    const first = value.sender.acceptControl(proof);
    expect(first).toEqual({
      type: 'playback_drained_applied',
      artifactId: ARTIFACT_ID,
      playbackGeneration: 1,
      receiverRevision: 9,
      nativePlaybackRevision: 8,
      drainedAtMonotonicMs: 1_234.5,
      idempotent: false,
      proof,
    });
    expect(value.sender.acceptControl(proof)).toEqual({ ...first, idempotent: true });
    expect(value.sender.snapshot()).toMatchObject({
      phase: 'closed',
      acknowledgedChunks: 3,
      consumedChunks: 3,
      receiverRevision: 9,
      terminalReplayAvailable: true,
    });
    expect(JSON.stringify({ effect: first, snapshot: value.sender.snapshot() }))
      .not.toContain('delivered');
  });

  it('enchaîne deux artefacts avec des séquences et révisions cumulatives non nulles', () => {
    const first = fixture({ chunks: [pcm(8, 1)] });
    const firstProof = completePublicationAndDrain(first, 4, 100);
    expect(first.sender.acceptControl(firstProof)).toMatchObject({
      type: 'playback_drained_applied',
      receiverRevision: 5,
      nativePlaybackRevision: 4,
    });

    const secondChunks = [pcm(12, 2)];
    const secondArtifact = createMistralDuplexArtifactManifest({
      sessionId: SESSION_ID,
      duplexId: DUPLEX_ID,
      connectionEpoch: 1,
      turnId: SECOND_TURN_ID,
      artifactId: SECOND_ARTIFACT_ID,
      playbackGeneration: 2,
      auditProofSha256: AUDIT_PROOF_SHA256,
      chunks: secondChunks,
    });
    const secondSender = new MistralDuplexDownlinkSender({
      artifact: secondArtifact,
      chunks: secondChunks,
      nextSequence: 3,
      receiverRevisionBase: 5,
      nativePlaybackRevisionBase: 4,
    });

    expect(first.receiver.accept(nextRequired(secondSender))).toMatchObject({ type: 'opened' });
    expect(secondSender.acceptControl(first.receiver.flowControl())).toMatchObject({
      type: 'flow_control_applied',
      receiverRevision: 6,
    });
    expect(first.receiver.accept(nextRequired(secondSender))).toMatchObject({ type: 'buffered' });
    expect(first.receiver.accept(nextRequired(secondSender))).toMatchObject({ type: 'closed' });
    expect(first.receiver.takeNextChunk()).toMatchObject({ chunkIndex: 0 });
    first.receiver.confirmChunkConsumed(2, SECOND_ARTIFACT_ID, 0);
    const secondDrain = first.receiver.confirmPlaybackDrained(
      2,
      SECOND_ARTIFACT_ID,
      8,
      200,
      0,
      0,
    );
    if (secondDrain.type !== 'playback_drained') throw new Error('expected_second_drain');
    expect(secondSender.acceptControl(secondDrain.control)).toMatchObject({
      type: 'playback_drained_applied',
      receiverRevision: 10,
      nativePlaybackRevision: 8,
    });
    expect(secondSender.snapshot()).toMatchObject({
      nextSequence: 6,
      receiverRevisionBase: 5,
      receiverRevision: 10,
      nativePlaybackRevisionBase: 4,
      nativePlaybackRevision: 8,
    });
    expect(first.receiver.snapshot()).toMatchObject({
      expectedSequence: 6,
      expectedPlaybackGeneration: 3,
      receiverRevision: 10,
    });
  });

  it('accepte le drain après le dernier flow-control closed sans recréditer le sender', () => {
    const value = fixture();
    open(value);
    value.sender.acceptControl(value.receiver.flowControl());
    for (let index = 0; index < value.chunks.length; index += 1) {
      value.receiver.accept(nextRequired(value.sender));
    }
    value.receiver.accept(nextRequired(value.sender));
    for (let index = 0; index < value.chunks.length; index += 1) {
      value.receiver.takeNextChunk();
      value.receiver.confirmChunkConsumed(1, ARTIFACT_ID, index);
    }

    expect(value.sender.acceptControl(value.receiver.flowControl())).toMatchObject({
      type: 'flow_control_applied',
      receiverRevision: 8,
      acknowledgedChunks: 3,
      consumedChunks: 3,
      availableBytes: 0,
      availableChunks: 0,
    });
    const drained = confirmPlaybackDrained(value.receiver, 8, 1_600);
    if (drained.type !== 'playback_drained') throw new Error('expected_playback_drained');
    expect(value.sender.acceptControl(drained.control)).toMatchObject({
      type: 'playback_drained_applied',
      receiverRevision: 9,
      nativePlaybackRevision: 8,
      idempotent: false,
    });
    expect(value.sender.snapshot()).toMatchObject({
      phase: 'closed',
      availableBytes: 0,
      availableChunks: 0,
    });
  });

  it('rejette une preuve prématurée même si elle provient d’un autre receiver exact', () => {
    const source = fixture();
    const proof = completePublicationAndDrain(source, 8, 400);
    const premature = fixture();
    open(premature);

    expectSenderError(
      () => premature.sender.acceptControl(proof),
      'invalid_sender_transition',
    );
  });

  it('fault sur binding, séquence, index final ou receiverRevision forgés', () => {
    const cases = [
      {
        expected: 'binding_mismatch' as const,
        mutate: (proof: MistralDuplexReceiverPlaybackDrained) => ({
          ...proof,
          artifactId: '30000000-0000-4000-8000-000000000099',
        }),
      },
      {
        expected: 'receiver_control_conflict' as const,
        mutate: (proof: MistralDuplexReceiverPlaybackDrained) => ({
          ...proof,
          closeSequence: proof.closeSequence + 1,
          nextExpectedSequence: proof.nextExpectedSequence + 1,
        }),
      },
      {
        expected: 'receiver_control_conflict' as const,
        mutate: (proof: MistralDuplexReceiverPlaybackDrained) => ({
          ...proof,
          consumedThroughChunkIndex: proof.consumedThroughChunkIndex - 1,
        }),
      },
      {
        expected: 'receiver_control_conflict' as const,
        mutate: (proof: MistralDuplexReceiverPlaybackDrained) => ({
          ...proof,
          receiverRevision: proof.receiverRevision + 1,
        }),
      },
    ];

    for (const testCase of cases) {
      const value = fixture();
      const proof = completePublicationAndDrain(value, 8, 500);
      expectSenderError(
        () => value.sender.acceptControl(testCase.mutate(proof)),
        testCase.expected,
      );
    }
  });

  it('refuse un replay dont la révision ou le temps natif diffère', () => {
    for (const mutate of [
      (proof: MistralDuplexReceiverPlaybackDrained) => ({
        ...proof,
        nativePlaybackRevision: proof.nativePlaybackRevision + 1,
      }),
      (proof: MistralDuplexReceiverPlaybackDrained) => ({
        ...proof,
        drainedAtMonotonicMs: proof.drainedAtMonotonicMs + 1,
      }),
    ]) {
      const value = fixture();
      const proof = completePublicationAndDrain(value, 8, 600);
      value.sender.acceptControl(proof);
      expectSenderError(
        () => value.sender.acceptControl(mutate(proof)),
        'receiver_control_conflict',
      );
    }
  });

  it('copies, authenticates and progressively releases its bounded PCM payload', () => {
    const source = [pcm(8, 1), pcm(10, 2)];
    const value = fixture({ chunks: source });
    source[0]!.fill(0xff);
    open(value);
    value.sender.acceptControl(value.receiver.flowControl());
    const first = nextRequired(value.sender);
    expect(first.type).toBe('speech.chunk');
    if (first.type !== 'speech.chunk') throw new Error('expected_chunk');
    expect(first.payload).not.toEqual(source[0]);
    expect(value.sender.snapshot().retainedPayloadBytes).toBe(10);
    nextRequired(value.sender);
    expect(value.sender.snapshot().retainedPayloadBytes).toBe(0);

    const serialized = JSON.stringify(value.sender.snapshot());
    expect(serialized).not.toContain('payload');
    expect(serialized).not.toContain('canonicalSpeech');
    expect(serialized).not.toContain('transcript');
    expect(Object.keys(value.sender.snapshot())).toEqual([
      'phase',
      'nextSequence',
      'emittedChunks',
      'acknowledgedChunks',
      'consumedChunks',
      'retainedPayloadBytes',
      'availableBytes',
      'availableChunks',
      'receiverRevisionBase',
      'receiverRevision',
      'nativePlaybackRevisionBase',
      'nativePlaybackRevision',
      'terminalReplayAvailable',
    ]);
  });

  it('rejects byte tampering before open and keeps the diagnostic code-only', () => {
    const chunks = [pcm(8, 1)];
    const prepared = createMistralDuplexArtifactManifest({
      sessionId: SESSION_ID,
      duplexId: DUPLEX_ID,
      connectionEpoch: 1,
      turnId: TURN_ID,
      artifactId: ARTIFACT_ID,
      playbackGeneration: 1,
      auditProofSha256: AUDIT_PROOF_SHA256,
      chunks,
    });
    const tampered = chunks[0]!.slice();
    tampered[0] = tampered[0]! ^ 0xff;
    const error = expectSenderError(
      () => new MistralDuplexDownlinkSender({
        artifact: prepared,
        chunks: [tampered],
        nextSequence: 0,
        receiverRevisionBase: 0,
        nativePlaybackRevisionBase: 0,
      }),
      'artifact_payload_mismatch',
    );
    expect(error.message).not.toContain(String(tampered[0]));
  });

  it('copie par primitive intrinsèque sans appeler slice surchargeable', () => {
    class HostileSlicePcm extends Uint8Array {
      override slice(_start?: number, _end?: number): Uint8Array<ArrayBuffer> {
        throw new Error('hostile_slice_called');
      }
    }
    const chunk = new HostileSlicePcm(8);
    chunk.set(pcm(8, 9));
    const prepared = createMistralDuplexArtifactManifest({
      sessionId: SESSION_ID,
      duplexId: DUPLEX_ID,
      connectionEpoch: 1,
      turnId: TURN_ID,
      artifactId: ARTIFACT_ID,
      playbackGeneration: 1,
      auditProofSha256: AUDIT_PROOF_SHA256,
      chunks: [chunk],
    });

    const sender = new MistralDuplexDownlinkSender({
      artifact: prepared,
      chunks: [chunk],
      nextSequence: 0,
      receiverRevisionBase: 0,
      nativePlaybackRevisionBase: 0,
    });
    expect(sender.snapshot()).toMatchObject({ phase: 'prepared', retainedPayloadBytes: 8 });
    sender.dispose();
  });

  it('efface toutes les copies déjà créées si un chunk ultérieur invalide le constructeur', () => {
    const chunks = [pcm(8, 1), pcm(10, 2)];
    const prepared = createMistralDuplexArtifactManifest({
      sessionId: SESSION_ID,
      duplexId: DUPLEX_ID,
      connectionEpoch: 1,
      turnId: TURN_ID,
      artifactId: ARTIFACT_ID,
      playbackGeneration: 1,
      auditProofSha256: AUDIT_PROOF_SHA256,
      chunks,
    });
    const tamperedSecond = Uint8Array.from(chunks[1]!);
    tamperedSecond[0] = tamperedSecond[0]! ^ 0xff;
    const originalSet = Uint8Array.prototype.set;
    const retainedCopyDestinations: Uint8Array[] = [];
    const setSpy = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function set(
      this: Uint8Array,
      source: ArrayLike<number>,
      offset?: number,
    ): void {
      if (source === chunks[0]) retainedCopyDestinations.push(this);
      originalSet.call(this, source, offset);
    });
    try {
      expectSenderError(() => new MistralDuplexDownlinkSender({
        artifact: prepared,
        chunks: [chunks[0]!, tamperedSecond],
        nextSequence: 0,
        receiverRevisionBase: 0,
        nativePlaybackRevisionBase: 0,
      }), 'artifact_payload_mismatch');
    } finally {
      setSpy.mockRestore();
    }

    expect(retainedCopyDestinations).toHaveLength(1);
    expect(retainedCopyDestinations.every(
      (destination) => destination.every((byte) => byte === 0),
    )).toBe(true);
    expect(chunks[0]!.some((byte) => byte !== 0)).toBe(true);
  });

  it('refuse un chunk partagé sans le copier ni écrire dans la mémoire étrangère', () => {
    const normal = pcm(8, 3);
    const prepared = createMistralDuplexArtifactManifest({
      sessionId: SESSION_ID,
      duplexId: DUPLEX_ID,
      connectionEpoch: 1,
      turnId: TURN_ID,
      artifactId: ARTIFACT_ID,
      playbackGeneration: 1,
      auditProofSha256: AUDIT_PROOF_SHA256,
      chunks: [normal],
    });
    const shared = new Uint8Array(new SharedArrayBuffer(normal.byteLength));
    shared.set(normal);
    const before = Uint8Array.from(shared);

    expectSenderError(() => new MistralDuplexDownlinkSender({
      artifact: prepared,
      chunks: [shared],
      nextSequence: 0,
      receiverRevisionBase: 0,
      nativePlaybackRevisionBase: 0,
    }), 'artifact_payload_mismatch');
    expect(shared).toEqual(before);
  });
});

describe('Mistral duplex downlink V3 sender — absolute credit and control loss', () => {
  it('subtracts already-emitted frames from a delayed absolute credit without double-spending', () => {
    const chunks = Array.from(
      { length: 6 },
      (_, index) => pcm(MISTRAL_DUPLEX_DOWNLINK_LIMITS.maxChunkBytes, index + 1),
    );
    const value = fixture({ chunks });
    open(value);
    value.sender.acceptControl(value.receiver.flowControl());

    const inFlight = [
      nextRequired(value.sender),
      nextRequired(value.sender),
      nextRequired(value.sender),
    ];
    expect(value.sender.nextEnvelope()).toBeNull();
    value.receiver.accept(inFlight[0]!);

    const delayedCredit = value.sender.acceptControl(value.receiver.flowControl());
    expect(delayedCredit).toMatchObject({
      type: 'flow_control_applied',
      acknowledgedChunks: 1,
      availableBytes: 0,
      availableChunks: 3,
    });
    expect(value.sender.nextEnvelope()).toBeNull();

    // The control after chunk 2 is deliberately lost. The later state is still accepted exactly.
    value.receiver.accept(inFlight[1]!);
    value.receiver.accept(inFlight[2]!);
    expect(value.receiver.flowControl()).toMatchObject({
      receiverRevision: 4,
      pressure: 'backpressured',
      availableBytes: 0,
      availableChunks: 0,
    });
    value.sender.acceptControl(value.receiver.flowControl());
    expect(value.sender.nextEnvelope()).toBeNull();

    value.receiver.takeNextChunk();
    value.receiver.confirmChunkConsumed(1, ARTIFACT_ID, 0);
    value.receiver.takeNextChunk();
    value.receiver.confirmChunkConsumed(1, ARTIFACT_ID, 1);
    const resumed = value.receiver.flowControl();
    expect(resumed).toMatchObject({
      receiverRevision: 6,
      consumedThroughChunkIndex: 1,
      pressure: 'accepting',
      availableBytes: MISTRAL_DUPLEX_DOWNLINK_LIMITS.maxChunkBytes * 2,
      availableChunks: 5,
    });
    expect(value.sender.acceptControl(resumed)).toMatchObject({
      type: 'flow_control_applied',
      availableBytes: MISTRAL_DUPLEX_DOWNLINK_LIMITS.maxChunkBytes * 2,
      availableChunks: 5,
    });
    expect(nextRequired(value.sender)).toMatchObject({ type: 'speech.chunk', chunkIndex: 3 });
    expect(nextRequired(value.sender)).toMatchObject({ type: 'speech.chunk', chunkIndex: 4 });
    expect(value.sender.nextEnvelope()).toBeNull();
  });

  it('accepts a backpressured state reached through a lost high-water control', () => {
    const chunks = Array.from(
      { length: 4 },
      (_, index) => pcm(MISTRAL_DUPLEX_DOWNLINK_LIMITS.maxChunkBytes, index + 1),
    );
    const value = fixture({ chunks });
    open(value);
    value.sender.acceptControl(value.receiver.flowControl());
    const frames = [
      nextRequired(value.sender),
      nextRequired(value.sender),
      nextRequired(value.sender),
    ];
    frames.forEach((frame) => value.receiver.accept(frame));
    // Receiver entered the exact three-chunk high-water mark; that control is lost.
    value.receiver.takeNextChunk();
    value.receiver.confirmChunkConsumed(1, ARTIFACT_ID, 0);
    const afterOneConsumption = value.receiver.flowControl();
    expect(afterOneConsumption).toMatchObject({
      pressure: 'backpressured',
      consumedThroughChunkIndex: 0,
      availableBytes: 0,
      availableChunks: 0,
    });
    expect(value.sender.acceptControl(afterOneConsumption)).toMatchObject({
      type: 'flow_control_applied',
      availableBytes: 0,
      availableChunks: 0,
    });
  });
});

describe('Mistral duplex downlink V3 sender — adversarial upstream controls', () => {
  it('faults on replayed and reordered flow controls', () => {
    const replayed = fixture({ chunks: [pcm(8, 1)] });
    open(replayed);
    const initial = replayed.receiver.flowControl();
    replayed.sender.acceptControl(initial);
    expectSenderError(
      () => replayed.sender.acceptControl(initial),
      'receiver_control_replayed',
    );
    expect(replayed.sender.snapshot()).toMatchObject({
      phase: 'faulted',
      retainedPayloadBytes: 0,
      availableBytes: 0,
    });

    const reordered = fixture({ chunks: [pcm(8, 1), pcm(8, 2)] });
    open(reordered);
    const old = reordered.receiver.flowControl();
    reordered.sender.acceptControl(old);
    reordered.receiver.accept(nextRequired(reordered.sender));
    reordered.sender.acceptControl(reordered.receiver.flowControl());
    expectSenderError(
      () => reordered.sender.acceptControl(old),
      'receiver_control_reordered',
    );
  });

  it('faults on future sequence, invented revision and forged absolute credit', () => {
    const future = fixture({ chunks: [pcm(8, 1)] });
    open(future);
    const futureControl: MistralDuplexReceiverFlowControl = {
      ...future.receiver.flowControl(),
      receiverRevision: 2,
      nextExpectedSequence: 2,
    };
    expectSenderError(
      () => future.sender.acceptControl(futureControl),
      'receiver_control_future',
    );

    const revision = fixture({ chunks: [pcm(8, 1)] });
    open(revision);
    expectSenderError(
      () => revision.sender.acceptControl({
        ...revision.receiver.flowControl(),
        receiverRevision: 2,
      }),
      'receiver_control_conflict',
    );

    const credit = fixture({ chunks: [pcm(8, 1)] });
    open(credit);
    expectSenderError(
      () => credit.sender.acceptControl({
        ...credit.receiver.flowControl(),
        availableBytes: MISTRAL_DUPLEX_DOWNLINK_LIMITS.highWaterBufferedBytes - 2,
      }),
      'receiver_control_conflict',
    );
  });

  it('faults closed on foreign bindings and stale/future epochs', () => {
    const foreign = fixture({ chunks: [pcm(8, 1)] });
    open(foreign);
    expectSenderError(
      () => foreign.sender.acceptControl({
        ...foreign.receiver.flowControl(),
        artifactId: '30000000-0000-4000-8000-000000000004',
      }),
      'binding_mismatch',
    );

    const stale = fixture({ chunks: [pcm(8, 1)], connectionEpoch: 2 });
    open(stale);
    expectSenderError(
      () => stale.sender.acceptControl({
        ...stale.receiver.flowControl(),
        connectionEpoch: 1,
      }),
      'stale_connection_epoch',
    );

    const future = fixture({ chunks: [pcm(8, 1)], connectionEpoch: 2 });
    open(future);
    expectSenderError(
      () => future.sender.acceptControl({
        ...future.receiver.flowControl(),
        connectionEpoch: 3,
      }),
      'future_connection_epoch',
    );
  });

  it('uses the strict protocol decoder and never reflects rejected PII', () => {
    const value = fixture({ chunks: [pcm(8, 1)] });
    open(value);
    const malformed = {
      ...value.receiver.flowControl(),
      transcript: 'Marie Durand, chantier privé',
    } as unknown as MistralDuplexReceiverFlowControl;
    try {
      value.sender.acceptControl(malformed);
      throw new Error('expected_protocol_error');
    } catch (error) {
      expect(error).toBeInstanceOf(MistralDuplexProtocolError);
      expect((error as MistralDuplexProtocolError).code).toBe('invalid_envelope');
      expect((error as Error).message).toBe('invalid_envelope');
      expect((error as Error).message).not.toContain('Marie');
    }
    expect(value.sender.snapshot()).toMatchObject({ phase: 'faulted', retainedPayloadBytes: 0 });
  });

  it('produces contiguous frames whose loss, reordering and replay fail closed at the receiver', () => {
    const reordered = fixture({ chunks: [pcm(8, 1), pcm(8, 2)] });
    open(reordered);
    reordered.sender.acceptControl(reordered.receiver.flowControl());
    const first = nextRequired(reordered.sender);
    const second = nextRequired(reordered.sender);
    try {
      reordered.receiver.accept(second);
      throw new Error('expected_sequence_gap');
    } catch (error) {
      expect(error).toBeInstanceOf(MistralDuplexProtocolError);
      expect((error as MistralDuplexProtocolError).code).toBe('sequence_gap');
    }

    const replayed = fixture({ chunks: [pcm(8, 1), pcm(8, 2)] });
    open(replayed);
    replayed.sender.acceptControl(replayed.receiver.flowControl());
    const frame = nextRequired(replayed.sender);
    replayed.receiver.accept(frame);
    try {
      replayed.receiver.accept(frame);
      throw new Error('expected_duplicate_sequence');
    } catch (error) {
      expect(error).toBeInstanceOf(MistralDuplexProtocolError);
      expect((error as MistralDuplexProtocolError).code).toBe('duplicate_sequence');
    }

    expect(first).toMatchObject({ type: 'speech.chunk', sequence: 1 });
    expect(second).toMatchObject({ type: 'speech.chunk', sequence: 2 });
  });
});

describe('Mistral duplex downlink V3 sender — local cancel barrier and replay', () => {
  it('turns an exact delayed pre-terminal flow into an inert ACK after cancellation', () => {
    const value = fixture({ chunks: [pcm(8, 1)] });
    open(value);
    const delayedFlow = value.receiver.flowControl();

    value.receiver.cancelLocally('barge_in', 1, ARTIFACT_ID);
    value.receiver.confirmNativeFlush(1, ARTIFACT_ID, 2);
    const cancelRequest = value.receiver.localCancelRequest();
    const cancel = value.sender.acceptControl(cancelRequest);
    expect(cancel).toMatchObject({
      type: 'cancel_barrier',
      receiverRevision: 3,
      idempotent: false,
    });
    const beforeDelayedFlow = value.sender.snapshot();

    expect(value.sender.acceptControl(delayedFlow)).toEqual({
      type: 'terminal_flow_control_ignored',
      receiverRevision: 1,
      acknowledgedChunks: 0,
      consumedChunks: 0,
      idempotent: true,
    });
    expect(value.sender.snapshot()).toEqual(beforeDelayedFlow);
    expect(value.sender.snapshot()).toMatchObject({
      phase: 'cancelled',
      availableBytes: 0,
      availableChunks: 0,
      retainedPayloadBytes: 0,
      receiverRevision: 3,
    });

    expect(value.sender.acceptControl(cancelRequest)).toEqual({
      ...cancel,
      idempotent: true,
    });

    expectSenderError(
      () => value.sender.acceptControl({
        ...delayedFlow,
        availableBytes: delayedFlow.availableBytes - 2,
      }),
      'receiver_control_conflict',
    );
  });

  it('faults on a future flow revision even after a valid terminal cancel barrier', () => {
    const value = fixture({ chunks: [pcm(8, 1)] });
    open(value);
    const delayedFlow = value.receiver.flowControl();
    value.receiver.cancelLocally('barge_in', 1, ARTIFACT_ID);
    value.receiver.confirmNativeFlush(1, ARTIFACT_ID, 2);
    const cancelRequest = value.receiver.localCancelRequest();
    value.sender.acceptControl(cancelRequest);

    expectSenderError(
      () => value.sender.acceptControl({
        ...delayedFlow,
        receiverRevision: cancelRequest.receiverRevision + 1,
      }),
      'receiver_control_future',
    );
  });

  it('orders already-emitted chunks before exact cancel+flush and replays terminals idempotently', () => {
    const value = fixture({ chunks: [pcm(8, 1), pcm(8, 2), pcm(8, 3)] });
    open(value);
    value.sender.acceptControl(value.receiver.flowControl());
    const accepted = nextRequired(value.sender);
    const alreadyInFlight = nextRequired(value.sender);
    value.receiver.accept(accepted);
    value.receiver.cancelLocally('barge_in', 1, ARTIFACT_ID);
    value.receiver.confirmNativeFlush(1, ARTIFACT_ID, 2);
    const request = value.receiver.localCancelRequest();

    const effect = value.sender.acceptControl(request);
    expect(effect).toMatchObject({
      type: 'cancel_barrier',
      receiverRevision: 4,
      idempotent: false,
    });
    if (effect.type !== 'cancel_barrier') throw new Error('expected_cancel_barrier');
    expect(effect.frames[0]).toMatchObject({
      type: 'speech.cancel',
      sequence: 3,
      reason: 'barge_in',
      nextPlaybackGeneration: 2,
    });
    expect(effect.frames[1]).toMatchObject({
      type: 'speech.flush',
      sequence: 4,
      cancelSequence: 3,
      nextPlaybackGeneration: 2,
    });
    expect(value.sender.snapshot()).toMatchObject({
      phase: 'cancelled',
      nextSequence: 5,
      retainedPayloadBytes: 0,
      terminalReplayAvailable: true,
    });

    expect(value.receiver.accept(alreadyInFlight)).toMatchObject({
      type: 'dropped_after_local_cancel',
      envelopeType: 'speech.chunk',
    });
    expect(value.receiver.accept(effect.frames[0])).toMatchObject({
      type: 'cancelled',
      localAlreadyFenced: true,
    });
    expect(value.receiver.accept(effect.frames[1])).toEqual({
      type: 'flushed',
      nextPlaybackGeneration: 2,
    });

    const replay = value.sender.acceptControl(request);
    expect(replay).toEqual({ ...effect, idempotent: true });
    if (replay.type !== 'cancel_barrier') throw new Error('expected_cancel_replay');
    expect(value.receiver.accept(replay.frames[0])).toMatchObject({
      type: 'terminal_replay',
      envelopeType: 'speech.cancel',
    });
    expect(value.receiver.accept(replay.frames[1])).toMatchObject({
      type: 'terminal_replay',
      envelopeType: 'speech.flush',
    });
  });

  it('can cancel immediately after open without granting audio credit', () => {
    const value = fixture({ chunks: [pcm(8, 1)] });
    open(value);
    value.receiver.cancelLocally('user_cancel', 1, ARTIFACT_ID);
    value.receiver.confirmNativeFlush(1, ARTIFACT_ID, 2);
    const effect = value.sender.acceptControl(value.receiver.localCancelRequest());
    expect(effect).toMatchObject({
      type: 'cancel_barrier',
      receiverRevision: 3,
      idempotent: false,
      frames: [
        expect.objectContaining({ type: 'speech.cancel', sequence: 1 }),
        expect.objectContaining({ type: 'speech.flush', sequence: 2, cancelSequence: 1 }),
      ],
    });
    expect(value.sender.snapshot()).toMatchObject({ emittedChunks: 0, retainedPayloadBytes: 0 });
  });

  it('faults on a conflicting cancellation after first-writer-wins', () => {
    const value = fixture({ chunks: [pcm(8, 1)] });
    open(value);
    value.receiver.cancelLocally('barge_in', 1, ARTIFACT_ID);
    value.receiver.confirmNativeFlush(1, ARTIFACT_ID, 2);
    const request = value.receiver.localCancelRequest();
    value.sender.acceptControl(request);
    expectSenderError(
      () => value.sender.acceptControl({ ...request, reason: 'user_cancel' }),
      'receiver_control_conflict',
    );
  });

  it('only replays the exact serialized cancel request and rejects a future revision', () => {
    const value = fixture({ chunks: [pcm(8, 1)] });
    open(value);
    value.receiver.cancelLocally('barge_in', 1, ARTIFACT_ID);
    value.receiver.confirmNativeFlush(1, ARTIFACT_ID, 2);
    const request = value.receiver.localCancelRequest();
    value.sender.acceptControl(request);
    expectSenderError(
      () => value.sender.acceptControl({
        ...request,
        receiverRevision: request.receiverRevision + 1,
      }),
      'receiver_control_future',
    );
  });
});

describe('Mistral duplex downlink V3 sender — server authority revocation', () => {
  it('orders an authority cancel+flush, wipes retained PCM and replays only the exact reason', () => {
    const value = fixture({ chunks: [pcm(8, 1), pcm(8, 2)] });
    open(value);

    const first = value.sender.cancelFromAuthority('context_changed');
    expect(first).toMatchObject({
      type: 'authority_cancel_barrier',
      reason: 'context_changed',
      idempotent: false,
      frames: [
        expect.objectContaining({
          type: 'speech.cancel',
          sequence: 1,
          reason: 'context_changed',
          nextPlaybackGeneration: 2,
        }),
        expect.objectContaining({
          type: 'speech.flush',
          sequence: 2,
          cancelSequence: 1,
          nextPlaybackGeneration: 2,
        }),
      ],
    });
    expect(value.sender.snapshot()).toMatchObject({
      phase: 'cancelled',
      nextSequence: 3,
      retainedPayloadBytes: 0,
      availableBytes: 0,
      availableChunks: 0,
      terminalReplayAvailable: true,
    });

    expect(value.sender.cancelFromAuthority('context_changed')).toEqual({
      ...first,
      idempotent: true,
    });
    expectSenderError(
      () => value.sender.cancelFromAuthority('session_end'),
      'receiver_control_conflict',
    );
  });

  it('turns a late exact flow proof inert without manufacturing a native-flush acknowledgement', () => {
    const value = fixture({ chunks: [pcm(8, 1)] });
    open(value);
    const delayedFlow = value.receiver.flowControl();
    value.sender.cancelFromAuthority('superseded');
    const before = value.sender.snapshot();

    expect(value.sender.acceptControl(delayedFlow)).toEqual({
      type: 'terminal_flow_control_ignored',
      receiverRevision: 1,
      acknowledgedChunks: 0,
      consumedChunks: 0,
      idempotent: true,
    });
    expect(value.sender.snapshot()).toEqual(before);
  });

  it('fails closed before speech.open and rejects a receiver terminal after authority wins', () => {
    const beforeOpen = fixture({ chunks: [pcm(8, 1)] });
    expectSenderError(
      () => beforeOpen.sender.cancelFromAuthority('session_end'),
      'invalid_sender_transition',
    );
    expect(beforeOpen.sender.snapshot()).toMatchObject({
      phase: 'faulted',
      retainedPayloadBytes: 0,
    });

    const value = fixture({ chunks: [pcm(8, 1)] });
    open(value);
    value.sender.cancelFromAuthority('superseded');
    value.receiver.cancelLocally('user_cancel', 1, ARTIFACT_ID);
    value.receiver.confirmNativeFlush(1, ARTIFACT_ID, 2);
    expectSenderError(
      () => value.sender.acceptControl(value.receiver.localCancelRequest()),
      'receiver_control_conflict',
    );
  });
});

describe('Mistral duplex downlink V3 sender — Int32 exhaustion fence', () => {
  it('rejects a route before open unless close, cancel and flush all fit below Int32 MAX', () => {
    const chunks = [pcm(8, 1)];
    const prepared = createMistralDuplexArtifactManifest({
      sessionId: SESSION_ID,
      duplexId: DUPLEX_ID,
      connectionEpoch: 1,
      turnId: TURN_ID,
      artifactId: ARTIFACT_ID,
      playbackGeneration: 1,
      auditProofSha256: AUDIT_PROOF_SHA256,
      chunks,
    });
    expectSenderError(
      () => new MistralDuplexDownlinkSender({
        artifact: prepared,
        chunks,
        nextSequence: MAX_INT32 - 4,
        receiverRevisionBase: 0,
        nativePlaybackRevisionBase: 0,
      }),
      'sequence_exhausted',
    );
  });

  it('uses the final complete route without ever emitting sequence Int32 MAX', () => {
    const value = fixture({ chunks: [pcm(8, 1)], nextSequence: MAX_INT32 - 5 });
    open(value);
    value.sender.acceptControl(value.receiver.flowControl());
    value.receiver.accept(nextRequired(value.sender));
    value.receiver.accept(nextRequired(value.sender));
    value.receiver.cancelLocally('session_end', 1, ARTIFACT_ID);
    value.receiver.confirmNativeFlush(1, ARTIFACT_ID, 2);
    const effect = value.sender.acceptControl(value.receiver.localCancelRequest());
    if (effect.type !== 'cancel_barrier') throw new Error('expected_cancel_barrier');
    expect(effect.frames[0].sequence).toBe(MAX_INT32 - 2);
    expect(effect.frames[1].sequence).toBe(MAX_INT32 - 1);
    expect(value.sender.snapshot().nextSequence).toBe(MAX_INT32);
    expect([
      effect.frames[0].sequence,
      effect.frames[1].sequence,
    ]).not.toContain(MAX_INT32);
  });

  it('refuse une génération si ses révisions receiver ou natives dépasseraient Int32', () => {
    const chunks = [pcm(8, 1)];
    const prepared = createMistralDuplexArtifactManifest({
      sessionId: SESSION_ID,
      duplexId: DUPLEX_ID,
      connectionEpoch: 1,
      turnId: TURN_ID,
      artifactId: ARTIFACT_ID,
      playbackGeneration: 1,
      auditProofSha256: AUDIT_PROOF_SHA256,
      chunks,
    });
    expectSenderError(() => new MistralDuplexDownlinkSender({
      artifact: prepared,
      chunks,
      nextSequence: 0,
      receiverRevisionBase: MAX_INT32 - 5,
      nativePlaybackRevisionBase: 0,
    }), 'revision_exhausted');
    expectSenderError(() => new MistralDuplexDownlinkSender({
      artifact: prepared,
      chunks,
      nextSequence: 0,
      receiverRevisionBase: 0,
      nativePlaybackRevisionBase: MAX_INT32 - 3,
    }), 'revision_exhausted');
  });

  it('réserve exactement la dernière révision pour un cancel après close et consommation', () => {
    const chunks = [pcm(8, 1)];
    const prepared = createMistralDuplexArtifactManifest({
      sessionId: SESSION_ID,
      duplexId: DUPLEX_ID,
      connectionEpoch: 1,
      turnId: TURN_ID,
      artifactId: ARTIFACT_ID,
      playbackGeneration: 1,
      auditProofSha256: AUDIT_PROOF_SHA256,
      chunks,
    });
    const receiverRevisionBase = MAX_INT32 - 6;
    const sender = new MistralDuplexDownlinkSender({
      artifact: prepared,
      chunks,
      nextSequence: 0,
      receiverRevisionBase,
      nativePlaybackRevisionBase: 0,
    });
    const receiver = new MistralDuplexDownlinkReceiver({
      sessionId: SESSION_ID,
      duplexId: DUPLEX_ID,
      connectionEpoch: 1,
      nextSequence: 0,
      playbackGeneration: 1,
    });

    receiver.accept(nextRequired(sender));
    const initialFlow = receiver.flowControl();
    sender.acceptControl({
      ...initialFlow,
      receiverRevision: receiverRevisionBase + initialFlow.receiverRevision,
    });
    receiver.accept(nextRequired(sender));
    receiver.accept(nextRequired(sender));
    receiver.takeNextChunk();
    receiver.confirmChunkConsumed(1, ARTIFACT_ID, 0);
    const closedFlow = receiver.flowControl();
    sender.acceptControl({
      ...closedFlow,
      receiverRevision: receiverRevisionBase + closedFlow.receiverRevision,
    });
    receiver.cancelLocally('session_end', 1, ARTIFACT_ID);
    receiver.confirmNativeFlush(1, ARTIFACT_ID, 2);
    const request = receiver.localCancelRequest();
    const effect = sender.acceptControl({
      ...request,
      receiverRevision: receiverRevisionBase + request.receiverRevision,
    });

    expect(request.receiverRevision).toBe(6);
    expect(effect).toMatchObject({
      type: 'cancel_barrier',
      receiverRevision: MAX_INT32,
      idempotent: false,
    });
  });
});

describe('Mistral duplex downlink V3 sender — runtime config shape', () => {
  it('rejette les tableaux hors plafond avant toute allocation proportionnelle à leur length', () => {
    const value = fixture({ chunks: [pcm(8, 1)] });
    value.sender.dispose();
    const oversizedLength = MISTRAL_DUPLEX_DOWNLINK_LIMITS.maxChunksPerArtifact + 1;
    const oversizedManifest = new Array(oversizedLength);
    const oversizedChunks = new Array(oversizedLength);

    expectSenderError(() => new MistralDuplexDownlinkSender({
      artifact: {
        ...value.prepared,
        manifest: oversizedManifest,
      } as unknown as MistralDuplexPreparedArtifact,
      chunks: value.chunks,
      nextSequence: 0,
      receiverRevisionBase: 0,
      nativePlaybackRevisionBase: 0,
    }), 'invalid_sender_config');
    expectSenderError(() => new MistralDuplexDownlinkSender({
      artifact: value.prepared,
      chunks: oversizedChunks as readonly Uint8Array[],
      nextSequence: 0,
      receiverRevisionBase: 0,
      nativePlaybackRevisionBase: 0,
    }), 'invalid_sender_config');
  });

  it('rejects accessor-driven A→B substitution before reading or retaining either artifact', () => {
    const first = fixture({ chunks: [pcm(8, 1)] });
    const second = fixture({ chunks: [pcm(8, 2)], playbackGeneration: 2 });
    first.sender.dispose();
    second.sender.dispose();
    let artifactReads = 0;
    const hostile = {
      get artifact() {
        artifactReads += 1;
        return artifactReads === 1 ? first.prepared : second.prepared;
      },
      chunks: first.chunks,
      nextSequence: 0,
      receiverRevisionBase: 0,
      nativePlaybackRevisionBase: 0,
    } as unknown as MistralDuplexDownlinkSenderConfig;

    expectSenderError(
      () => new MistralDuplexDownlinkSender(hostile),
      'invalid_sender_config',
    );
    expect(artifactReads).toBe(0);
  });

  it('uses descriptor snapshots rather than Proxy get traps and exposes the normalized binding', () => {
    const first = fixture({ chunks: [pcm(8, 1)] });
    const second = fixture({ chunks: [pcm(8, 2)], playbackGeneration: 2 });
    first.sender.dispose();
    second.sender.dispose();
    let artifactGets = 0;
    const proxy = new Proxy({
      artifact: first.prepared,
      chunks: first.chunks,
      nextSequence: 7,
      receiverRevisionBase: 0,
      nativePlaybackRevisionBase: 0,
    }, {
      get(target, property, receiver) {
        if (property === 'artifact') {
          artifactGets += 1;
          return second.prepared;
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const sender = new MistralDuplexDownlinkSender(proxy);
    const authorization = sender.authorizationSnapshot();
    expect(artifactGets).toBe(0);
    expect(authorization).toMatchObject({
      artifactId: first.prepared.binding.artifactId,
      playbackGeneration: 1,
      openSequence: 7,
      artifactSha256: first.prepared.binding.artifactSha256,
    });
    expect(Object.isFrozen(authorization)).toBe(true);
    sender.dispose();
  });

  it('rejects extra config fields before retaining payload bytes', () => {
    const value = fixture({ chunks: [pcm(8, 1)] });
    const config = {
      artifact: value.prepared,
      chunks: value.chunks,
      nextSequence: 0,
      receiverRevisionBase: 0,
      nativePlaybackRevisionBase: 0,
      transcript: 'must never enter the sender',
    } as unknown as MistralDuplexDownlinkSenderConfig;
    expectSenderError(
      () => new MistralDuplexDownlinkSender(config),
      'invalid_sender_config',
    );
  });

  it('dispose explicitement et idempotemment les copies PCM sans simuler un contrôle invalide', () => {
    const value = fixture({ chunks: [pcm(8, 1), pcm(8, 2)] });
    open(value);

    expect(value.sender.snapshot()).toMatchObject({
      phase: 'awaiting_flow_control',
      retainedPayloadBytes: 16,
    });

    value.sender.dispose();
    value.sender.dispose();

    expect(value.sender.snapshot()).toMatchObject({
      phase: 'disposed',
      retainedPayloadBytes: 0,
      availableBytes: 0,
      availableChunks: 0,
      terminalReplayAvailable: false,
    });
    expectSenderError(() => value.sender.nextEnvelope(), 'sender_disposed');
    expectSenderError(
      () => value.sender.acceptControl(value.receiver.flowControl()),
      'sender_disposed',
    );
    expect(value.sender.snapshot().phase).toBe('disposed');
  });
});
