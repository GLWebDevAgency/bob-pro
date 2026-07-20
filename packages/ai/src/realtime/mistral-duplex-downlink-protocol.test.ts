import { describe, expect, it } from 'vitest';
import {
  MISTRAL_DUPLEX_CHANNELS,
  MISTRAL_DUPLEX_CONTENT_TYPE,
  MISTRAL_DUPLEX_DOWNLINK_LIMITS,
  MISTRAL_DUPLEX_DOWNLINK_PROTOCOL,
  MISTRAL_DUPLEX_PCM_LIMITS,
  MISTRAL_DUPLEX_SAMPLE_FORMAT,
  MISTRAL_DUPLEX_SAMPLE_RATE_HZ,
  MistralDuplexDownlinkReceiver,
  MistralDuplexProtocolError,
  computeMistralDuplexManifestSha256,
  createMistralDuplexArtifactManifest,
  decodeMistralDuplexBinaryChunk,
  decodeMistralDuplexTextEnvelope,
  decodeMistralDuplexUpstreamControl,
  encodeMistralDuplexBinaryChunk,
  encodeMistralDuplexTextEnvelope,
  encodeMistralDuplexUpstreamControl,
  mistralDuplexSha256Hex,
  type MistralDuplexArtifactBinding,
  type MistralDuplexCancelReason,
  type MistralDuplexManifestEntry,
  type MistralDuplexPreparedArtifact,
  type MistralDuplexSpeechCancel,
  type MistralDuplexSpeechChunk,
  type MistralDuplexSpeechClose,
  type MistralDuplexSpeechFlush,
  type MistralDuplexSpeechOpen,
} from './mistral-duplex-downlink-protocol';

const SESSION_ID = '10000000-0000-4000-8000-000000000001';
const DUPLEX_ID = '10000000-0000-4000-8000-000000000002';
const CONNECTION_EPOCH = 1;
const TURN_ID = '20000000-0000-4000-8000-000000000002';
const ARTIFACT_ID = '30000000-0000-4000-8000-000000000003';
const NEXT_ARTIFACT_ID = '30000000-0000-4000-8000-000000000004';
const AUDIT_PROOF = 'a'.repeat(64);

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
  readonly open: (sequence?: number) => MistralDuplexSpeechOpen;
  readonly chunk: (
    index: number,
    sequence?: number,
    encoding?: 'binary' | 'base64',
  ) => MistralDuplexSpeechChunk;
  readonly close: (sequence?: number) => MistralDuplexSpeechClose;
  readonly cancel: (
    sequence: number,
    reason?: MistralDuplexCancelReason,
  ) => MistralDuplexSpeechCancel;
  readonly flush: (sequence: number, cancelSequence: number) => MistralDuplexSpeechFlush;
}

function fixture(input: {
  readonly chunks?: readonly Uint8Array[];
  readonly playbackGeneration?: number;
  readonly artifactId?: string;
  readonly connectionEpoch?: number;
} = {}): Fixture {
  const chunks = input.chunks ?? [pcm(8, 1), pcm(10, 2), pcm(12, 3)];
  const playbackGeneration = input.playbackGeneration ?? 1;
  const prepared = createMistralDuplexArtifactManifest({
    sessionId: SESSION_ID,
    duplexId: DUPLEX_ID,
    connectionEpoch: input.connectionEpoch ?? CONNECTION_EPOCH,
    turnId: TURN_ID,
    artifactId: input.artifactId ?? ARTIFACT_ID,
    playbackGeneration,
    auditProofSha256: AUDIT_PROOF,
    chunks,
  });
  return {
    chunks,
    prepared,
    open: (sequence = 0) => ({
      type: 'speech.open',
      sequence,
      ...prepared.binding,
      manifest: prepared.manifest,
    }),
    chunk: (index, sequence = index + 1, encoding = 'binary') => {
      const entry = prepared.manifest[index]!;
      return {
        type: 'speech.chunk',
        sequence,
        ...prepared.binding,
        ...entry,
        encoding,
        payload: chunks[index]!.slice(),
      };
    },
    close: (sequence = chunks.length + 1) => ({
      type: 'speech.close',
      sequence,
      ...prepared.binding,
    }),
    cancel: (sequence, reason = 'barge_in') => ({
      type: 'speech.cancel',
      sequence,
      ...prepared.binding,
      reason,
      nextPlaybackGeneration: playbackGeneration + 1,
    }),
    flush: (sequence, cancelSequence) => ({
      type: 'speech.flush',
      sequence,
      ...prepared.binding,
      cancelSequence,
      nextPlaybackGeneration: playbackGeneration + 1,
    }),
  };
}

function expectProtocolError(
  action: () => unknown,
  code: MistralDuplexProtocolError['code'],
): MistralDuplexProtocolError {
  try {
    action();
    throw new Error('expected protocol error');
  } catch (error) {
    expect(error).toBeInstanceOf(MistralDuplexProtocolError);
    expect((error as MistralDuplexProtocolError).code).toBe(code);
    expect((error as Error).message).toBe(code);
    return error as MistralDuplexProtocolError;
  }
}

function wireObject(value: string): Record<string, unknown> {
  return JSON.parse(value) as Record<string, unknown>;
}

function confirmPlaybackDrained(
  receiver: MistralDuplexDownlinkReceiver,
  playbackGeneration: number,
  playbackId: string,
  nativePlaybackRevision = 1,
  drainedAtMonotonicMs = 100,
) {
  return receiver.confirmPlaybackDrained(
    playbackGeneration,
    playbackId,
    nativePlaybackRevision,
    drainedAtMonotonicMs,
    0,
    0,
  );
}

describe('Mistral duplex downlink V3 — version and integrity primitives', () => {
  it('uses an explicitly incompatible protocol and the fixed PCM contract', () => {
    expect(MISTRAL_DUPLEX_DOWNLINK_PROTOCOL).toBe('bob.mistral-duplex.v3');
    expect(MISTRAL_DUPLEX_DOWNLINK_PROTOCOL).not.toBe('bob.mistral-pcm.v2');
    expect({
      contentType: MISTRAL_DUPLEX_CONTENT_TYPE,
      sampleFormat: MISTRAL_DUPLEX_SAMPLE_FORMAT,
      sampleRateHz: MISTRAL_DUPLEX_SAMPLE_RATE_HZ,
      channels: MISTRAL_DUPLEX_CHANNELS,
    }).toEqual({
      contentType: 'audio/pcm',
      sampleFormat: 'pcm_s16le',
      sampleRateHz: 24_000,
      channels: 1,
    });
    expect(MISTRAL_DUPLEX_PCM_LIMITS).toEqual({
      bytesPerSample: 2,
      sampleFrameBytes: 2,
      bytesPerSecond: 48_000,
      quantumMs: 20,
      quantumBytes: 960,
      minAuditedArtifactDurationMs: 100,
      minAuditedArtifactBytes: 4_800,
      transportChunkCeilingBytes: 16_384,
      transportChunkQuanta: 17,
      transportChunkBytes: 16_320,
      maxChunksPerArtifact: 128,
      maxArtifactBytes: 2_088_960,
      maxDurationMs: 43_520,
    });
    expect(MISTRAL_DUPLEX_PCM_LIMITS.quantumBytes).toBe(
      MISTRAL_DUPLEX_PCM_LIMITS.bytesPerSecond * MISTRAL_DUPLEX_PCM_LIMITS.quantumMs / 1_000,
    );
    expect(MISTRAL_DUPLEX_PCM_LIMITS.minAuditedArtifactBytes).toBe(
      MISTRAL_DUPLEX_PCM_LIMITS.bytesPerSecond
        * MISTRAL_DUPLEX_PCM_LIMITS.minAuditedArtifactDurationMs / 1_000,
    );
    expect(MISTRAL_DUPLEX_PCM_LIMITS.transportChunkBytes).toBe(
      Math.floor(
        MISTRAL_DUPLEX_PCM_LIMITS.transportChunkCeilingBytes
          / MISTRAL_DUPLEX_PCM_LIMITS.quantumBytes,
      ) * MISTRAL_DUPLEX_PCM_LIMITS.quantumBytes,
    );
    expect(MISTRAL_DUPLEX_PCM_LIMITS.maxArtifactBytes).toBe(
      MISTRAL_DUPLEX_PCM_LIMITS.transportChunkBytes
        * MISTRAL_DUPLEX_PCM_LIMITS.maxChunksPerArtifact,
    );
    expect(MISTRAL_DUPLEX_PCM_LIMITS.maxDurationMs).toBe(
      MISTRAL_DUPLEX_PCM_LIMITS.maxArtifactBytes * 1_000
        / MISTRAL_DUPLEX_PCM_LIMITS.bytesPerSecond,
    );
    expect(MISTRAL_DUPLEX_DOWNLINK_LIMITS).toMatchObject({
      maxChunkBytes: MISTRAL_DUPLEX_PCM_LIMITS.transportChunkBytes,
      maxArtifactBytes: MISTRAL_DUPLEX_PCM_LIMITS.maxArtifactBytes,
      maxChunksPerArtifact: MISTRAL_DUPLEX_PCM_LIMITS.maxChunksPerArtifact,
    });
  });

  it('matches known SHA-256 byte vectors, including non-UTF-8 bytes', () => {
    expect(mistralDuplexSha256Hex(new Uint8Array())).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(mistralDuplexSha256Hex(Uint8Array.of(0x61, 0x62, 0x63))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(mistralDuplexSha256Hex(Uint8Array.of(0x00, 0x80, 0xff))).toBe(
      '5240672d7b51756b829ad0ef8d9468b7a078afa2f410484fd3892dab47becb72',
    );
  });

  it.each([
    [55, '463eb28e72f82e0a96c0a4cc53690c571281131f672aa229e0d45ae59b598b59'],
    [56, 'da2ae4d6b36748f2a318f23e7ab1dfdf45acdc9d049bd80e59de82a60895f562'],
    [63, '29af2686fd53374a36b0846694cc342177e428d1647515f078784d69cdb9e488'],
    [64, 'fdeab9acf3710362bd2658cdc9a29e8f9c757fcf9811603a8c447cd1d9151108'],
    [65, '4bfd2c8b6f1eec7a2afeb48b934ee4b2694182027e6d0fc075074f2fabb31781'],
    [127, '92ca0fa6651ee2f97b884b7246a562fa71250fedefe5ebf270d31c546bfea976'],
    [128, '471fb943aa23c511f6f72f8d1652d9c880cfa392ad80503120547703e56a2be5'],
    [129, '5099c6a56203f9687f7d33f4bfdf576d31dc91f6b695ecea38b2770c87631135'],
    [1_024, '785b0751fc2c53dc14a4ce3d800e69ef9ce1009eb327ccf458afe09c242c26c9'],
    [16_320, '6de25b7a02c9d5368cc9179a816833f3bd8936e702a3609b57e766bfc7e6ede1'],
  ] as const)('matches the independent SHA-256 vector at the %i-byte boundary', (
    byteLength,
    expected,
  ) => {
    const payload = Uint8Array.from({ length: byteLength }, (_value, index) => index & 0xff);
    expect(mistralDuplexSha256Hex(payload)).toBe(expected);
  });

  it('precommits contiguous chunk hashes, total bytes, artifact hash and canonical manifest', () => {
    const value = fixture();
    expect(value.prepared.manifest).toEqual([
      expect.objectContaining({ chunkIndex: 0, byteOffset: 0, byteLength: 8 }),
      expect.objectContaining({ chunkIndex: 1, byteOffset: 8, byteLength: 10 }),
      expect.objectContaining({ chunkIndex: 2, byteOffset: 18, byteLength: 12 }),
    ]);
    expect(value.prepared.binding.totalBytes).toBe(30);
    const { manifestSha256, ...withoutManifest } = value.prepared.binding;
    expect(computeMistralDuplexManifestSha256(
      withoutManifest,
      value.prepared.manifest,
    )).toBe(manifestSha256);
  });

  it('enforces artifact, chunk and count limits before creating a manifest', () => {
    expectProtocolError(
      () => createMistralDuplexArtifactManifest({
        sessionId: SESSION_ID,
        duplexId: DUPLEX_ID,
        connectionEpoch: CONNECTION_EPOCH,
        turnId: TURN_ID,
        artifactId: ARTIFACT_ID,
        playbackGeneration: 1,
        auditProofSha256: AUDIT_PROOF,
        chunks: [],
      }),
      'invalid_manifest',
    );
    expectProtocolError(
      () => createMistralDuplexArtifactManifest({
        sessionId: SESSION_ID,
        duplexId: DUPLEX_ID,
        connectionEpoch: CONNECTION_EPOCH,
        turnId: TURN_ID,
        artifactId: ARTIFACT_ID,
        playbackGeneration: 1,
        auditProofSha256: AUDIT_PROOF,
        chunks: Array.from(
          { length: MISTRAL_DUPLEX_DOWNLINK_LIMITS.maxChunksPerArtifact + 1 },
          (_, index) => pcm(2, index),
        ),
      }),
      'invalid_manifest',
    );
    expectProtocolError(
      () => createMistralDuplexArtifactManifest({
        sessionId: SESSION_ID,
        duplexId: DUPLEX_ID,
        connectionEpoch: CONNECTION_EPOCH,
        turnId: TURN_ID,
        artifactId: ARTIFACT_ID,
        playbackGeneration: 1,
        auditProofSha256: AUDIT_PROOF,
        chunks: [pcm(MISTRAL_DUPLEX_DOWNLINK_LIMITS.maxChunkBytes + 2, 1)],
      }),
      'invalid_manifest',
    );
    expectProtocolError(
      () => createMistralDuplexArtifactManifest({
        sessionId: SESSION_ID,
        duplexId: DUPLEX_ID,
        connectionEpoch: CONNECTION_EPOCH,
        turnId: TURN_ID,
        artifactId: ARTIFACT_ID,
        playbackGeneration: 1,
        auditProofSha256: AUDIT_PROOF,
        chunks: [pcm(3, 1)],
      }),
      'invalid_manifest',
    );
  });

  it('accepts exactly 128 effective transport chunks and no raw 16 KiB PCM chunk', () => {
    const chunk = pcm(MISTRAL_DUPLEX_PCM_LIMITS.transportChunkBytes, 7);
    const prepared = createMistralDuplexArtifactManifest({
      sessionId: SESSION_ID,
      duplexId: DUPLEX_ID,
      connectionEpoch: CONNECTION_EPOCH,
      turnId: TURN_ID,
      artifactId: ARTIFACT_ID,
      playbackGeneration: 1,
      auditProofSha256: AUDIT_PROOF,
      chunks: Array.from(
        { length: MISTRAL_DUPLEX_PCM_LIMITS.maxChunksPerArtifact },
        () => chunk,
      ),
    });

    expect(prepared.binding).toMatchObject({
      totalBytes: MISTRAL_DUPLEX_PCM_LIMITS.maxArtifactBytes,
      totalChunks: MISTRAL_DUPLEX_PCM_LIMITS.maxChunksPerArtifact,
    });
    expectProtocolError(
      () => createMistralDuplexArtifactManifest({
        sessionId: SESSION_ID,
        duplexId: DUPLEX_ID,
        connectionEpoch: CONNECTION_EPOCH,
        turnId: TURN_ID,
        artifactId: ARTIFACT_ID,
        playbackGeneration: 1,
        auditProofSha256: AUDIT_PROOF,
        chunks: [pcm(MISTRAL_DUPLEX_PCM_LIMITS.transportChunkBytes + 2, 7)],
      }),
      'invalid_manifest',
    );
  });
});

describe('Mistral duplex downlink V3 — strict wire parsing', () => {
  it('round-trips open, close, cancel and flush without transcript or business data', () => {
    const value = fixture();
    const controls = [
      value.open(),
      value.close(),
      value.cancel(1),
      value.flush(2, 1),
    ] as const;
    for (const control of controls) {
      const encoded = encodeMistralDuplexTextEnvelope(control);
      expect(decodeMistralDuplexTextEnvelope(encoded)).toEqual(control);
      expect(encoded).not.toContain('transcript');
      expect(encoded).not.toContain('canonicalSpeech');
      expect(encoded).not.toContain('controlReference');
    }
  });

  it('round-trips both canonical base64 and self-contained binary chunk forms', () => {
    const value = fixture();
    const base64Chunk = value.chunk(0, 1, 'base64') as MistralDuplexSpeechChunk & {
      readonly encoding: 'base64';
    };
    const encoded = encodeMistralDuplexTextEnvelope(base64Chunk);
    const decodedBase64 = decodeMistralDuplexTextEnvelope(encoded);
    expect(decodedBase64).toMatchObject({
      type: 'speech.chunk',
      encoding: 'base64',
      chunkIndex: 0,
      byteLength: 8,
    });
    expect(Array.from((decodedBase64 as MistralDuplexSpeechChunk).payload)).toEqual(
      Array.from(value.chunks[0]!),
    );

    const binaryChunk = value.chunk(1, 2, 'binary') as MistralDuplexSpeechChunk & {
      readonly encoding: 'binary';
    };
    const frame = encodeMistralDuplexBinaryChunk(binaryChunk);
    const decodedBinary = decodeMistralDuplexBinaryChunk(frame);
    expect(decodedBinary).toMatchObject({
      type: 'speech.chunk',
      encoding: 'binary',
      chunkIndex: 1,
      byteOffset: 8,
    });
    expect(Array.from(decodedBinary.payload)).toEqual(Array.from(value.chunks[1]!));
  });

  it('rejects invalid JSON, oversized input, arrays, unknown types and extra fields', () => {
    const value = fixture();
    expectProtocolError(() => decodeMistralDuplexTextEnvelope(''), 'invalid_json');
    expectProtocolError(() => decodeMistralDuplexTextEnvelope('{'), 'invalid_json');
    expectProtocolError(() => decodeMistralDuplexTextEnvelope('[]'), 'invalid_envelope');
    expectProtocolError(
      () => decodeMistralDuplexTextEnvelope(
        ' '.repeat(MISTRAL_DUPLEX_DOWNLINK_LIMITS.maxTextEnvelopeBytes + 1),
      ),
      'envelope_too_large',
    );
    expectProtocolError(
      () => decodeMistralDuplexTextEnvelope(JSON.stringify({
        ...value.open(),
        type: 'speech.transcript',
        transcript: 'private words',
      })),
      'invalid_envelope',
    );
    expectProtocolError(
      () => decodeMistralDuplexTextEnvelope(JSON.stringify({
        ...value.open(),
        unexpected: true,
      })),
      'invalid_envelope',
    );
  });

  it('rejette les clés JSON dupliquées et les valeurs que stringify normaliserait', () => {
    const value = fixture();
    const encoded = encodeMistralDuplexTextEnvelope(value.open());
    const duplicatedTopLevelKey = encoded.replace(
      `"sessionId":"${SESSION_ID}"`,
      `"sessionId":"${SESSION_ID}","sessionId":"${SESSION_ID}"`,
    );
    expectProtocolError(
      () => decodeMistralDuplexTextEnvelope(duplicatedTopLevelKey),
      'invalid_json',
    );
    const duplicatedNestedKey = encoded.replace(
      '"chunkIndex":0',
      '"chunkIndex":0,"chunkIndex":0',
    );
    expectProtocolError(
      () => decodeMistralDuplexTextEnvelope(duplicatedNestedKey),
      'invalid_json',
    );
    expectProtocolError(
      () => encodeMistralDuplexTextEnvelope(null as never),
      'invalid_envelope',
    );
    expectProtocolError(
      () => encodeMistralDuplexTextEnvelope({ ...value.open(), sequence: -0 }),
      'invalid_envelope',
    );
  });

  it('rejects V2 and every malformed binding field without coercion', () => {
    const value = fixture();
    expectProtocolError(
      () => decodeMistralDuplexTextEnvelope(JSON.stringify({
        ...value.open(),
        protocol: 'bob.mistral-pcm.v2',
      })),
      'unsupported_protocol',
    );

    const invalidOverrides: readonly Record<string, unknown>[] = [
      { sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'.toUpperCase() },
      { duplexId: 'not-a-uuid' },
      { connectionEpoch: 0 },
      { connectionEpoch: 1.5 },
      { turnId: 'not-a-uuid' },
      { artifactId: 'not-a-uuid' },
      { playbackGeneration: 0 },
      { playbackGeneration: -0 },
      { playbackGeneration: 0x7fff_ffff },
      { sequence: 1.5 },
      { contentType: 'audio/mpeg' },
      { sampleFormat: 'float32' },
      { sampleRateHz: 16_000 },
      { channels: 2 },
      { totalBytes: 3 },
      { artifactSha256: 'A'.repeat(64) },
      { totalChunks: 0 },
      { manifestSha256: 'g'.repeat(64) },
      { auditProofSha256: 'too-short' },
    ];
    for (const override of invalidOverrides) {
      expectProtocolError(
        () => decodeMistralDuplexTextEnvelope(JSON.stringify({
          ...value.open(),
          ...override,
        })),
        'invalid_envelope',
      );
    }
    const negativeZeroSequence = encodeMistralDuplexTextEnvelope(value.open())
      .replace('"sequence":0', '"sequence":-0');
    expectProtocolError(
      () => decodeMistralDuplexTextEnvelope(negativeZeroSequence),
      'invalid_json',
    );
  });

  it('rejects manifest gaps, reordering, unknown entry fields and digest tampering', () => {
    const value = fixture();
    const manifest = value.prepared.manifest.map((entry) => ({ ...entry }));
    manifest[1] = { ...manifest[1]!, byteOffset: 10 };
    expectProtocolError(
      () => decodeMistralDuplexTextEnvelope(JSON.stringify({ ...value.open(), manifest })),
      'invalid_manifest',
    );

    const reordered = [
      value.prepared.manifest[1]!,
      value.prepared.manifest[0]!,
      value.prepared.manifest[2]!,
    ];
    expectProtocolError(
      () => decodeMistralDuplexTextEnvelope(JSON.stringify({
        ...value.open(),
        manifest: reordered,
      })),
      'invalid_manifest',
    );
    expectProtocolError(
      () => decodeMistralDuplexTextEnvelope(JSON.stringify({
        ...value.open(),
        manifest: value.prepared.manifest.map((entry, index) => (
          index === 0 ? { ...entry, provider: 'mistral' } : entry
        )),
      })),
      'invalid_manifest',
    );
    expectProtocolError(
      () => decodeMistralDuplexTextEnvelope(JSON.stringify({
        ...value.open(),
        manifestSha256: 'f'.repeat(64),
      })),
      'invalid_manifest',
    );
  });

  it('rejects malformed, non-canonical, length-mismatched and tampered base64 chunks', () => {
    const value = fixture();
    const valid = wireObject(encodeMistralDuplexTextEnvelope(
      value.chunk(0, 1, 'base64') as MistralDuplexSpeechChunk & { readonly encoding: 'base64' },
    ));
    expectProtocolError(
      () => decodeMistralDuplexTextEnvelope(JSON.stringify({ ...valid, data: 'AQI' })),
      'invalid_envelope',
    );
    expectProtocolError(
      () => decodeMistralDuplexTextEnvelope(JSON.stringify({ ...valid, byteLength: 10 })),
      'invalid_envelope',
    );
    expectProtocolError(
      () => decodeMistralDuplexTextEnvelope(JSON.stringify({ ...valid, data: 'AAECAwQFBgc=' })),
      'chunk_tampered',
    );
    expectProtocolError(
      () => decodeMistralDuplexTextEnvelope(JSON.stringify({ ...valid, extra: 'no' })),
      'invalid_envelope',
    );
  });

  it('rejects binary magic/version/length corruption and payload tampering', () => {
    const value = fixture();
    const chunk = value.chunk(0, 1, 'binary') as MistralDuplexSpeechChunk & {
      readonly encoding: 'binary';
    };
    const frame = encodeMistralDuplexBinaryChunk(chunk);

    const badMagic = frame.slice();
    badMagic[0] = badMagic[0]! ^ 0xff;
    expectProtocolError(() => decodeMistralDuplexBinaryChunk(badMagic), 'invalid_binary_frame');

    const badVersion = frame.slice();
    badVersion[4] = 2;
    expectProtocolError(() => decodeMistralDuplexBinaryChunk(badVersion), 'invalid_binary_frame');
    expectProtocolError(
      () => decodeMistralDuplexBinaryChunk(frame.subarray(0, frame.byteLength - 1)),
      'invalid_binary_frame',
    );
    const withTrailingByte = new Uint8Array(frame.byteLength + 1);
    withTrailingByte.set(frame);
    expectProtocolError(
      () => decodeMistralDuplexBinaryChunk(withTrailingByte),
      'invalid_binary_frame',
    );

    const tampered = frame.slice();
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;
    expectProtocolError(() => decodeMistralDuplexBinaryChunk(tampered), 'chunk_tampered');
  });

  it('keeps diagnostics code-only even when malformed input contains PII', () => {
    const value = fixture();
    const error = expectProtocolError(
      () => decodeMistralDuplexTextEnvelope(JSON.stringify({
        ...value.open(),
        customerName: 'Marie Durand',
        transcript: 'Le chantier privé est rue Exemple',
      })),
      'invalid_envelope',
    );
    expect(error.message).toBe('invalid_envelope');
    expect(error.message).not.toContain('Marie');
    expect(error.message).not.toContain('chantier');
  });
});

describe('Mistral duplex downlink V3 — upstream receiver controls', () => {
  it('snapshots an exact plain receiver config and never retains caller authority', () => {
    const value = fixture({ chunks: [pcm(8, 1)] });
    const config = {
      sessionId: SESSION_ID,
      duplexId: DUPLEX_ID,
      connectionEpoch: CONNECTION_EPOCH,
      nextSequence: 0,
      playbackGeneration: 1,
    };
    const receiver = new MistralDuplexDownlinkReceiver(config);

    config.sessionId = '10000000-0000-4000-8000-000000000099';
    config.duplexId = '10000000-0000-4000-8000-000000000098';
    config.connectionEpoch = 2;
    config.nextSequence = 12;
    config.playbackGeneration = 12;

    expect(receiver.accept(value.open())).toEqual({
      type: 'opened',
      playbackGeneration: 1,
    });
  });

  it('rejects accessor-backed and inherited receiver configs without invoking getters', () => {
    let getterReads = 0;
    const accessorConfig = Object.defineProperties({}, {
      sessionId: {
        enumerable: true,
        get: () => {
          getterReads += 1;
          return SESSION_ID;
        },
      },
      duplexId: { enumerable: true, value: DUPLEX_ID },
      connectionEpoch: { enumerable: true, value: CONNECTION_EPOCH },
      nextSequence: { enumerable: true, value: 0 },
      playbackGeneration: { enumerable: true, value: 1 },
    });
    expectProtocolError(
      () => new MistralDuplexDownlinkReceiver(accessorConfig as never),
      'invalid_receiver_config',
    );
    expect(getterReads).toBe(0);

    const inheritedConfig = Object.assign(Object.create({ authority: 'foreign' }) as object, {
      sessionId: SESSION_ID,
      duplexId: DUPLEX_ID,
      connectionEpoch: CONNECTION_EPOCH,
      nextSequence: 0,
      playbackGeneration: 1,
    });
    expectProtocolError(
      () => new MistralDuplexDownlinkReceiver(inheritedConfig as never),
      'invalid_receiver_config',
    );
  });

  it('encode un crédit absolu strict et refuse toute ambiguïté de pression', () => {
    const value = fixture({ chunks: [pcm(8, 1)] });
    const receiver = new MistralDuplexDownlinkReceiver({
      sessionId: SESSION_ID,
      duplexId: DUPLEX_ID,
      connectionEpoch: CONNECTION_EPOCH,
      nextSequence: 0,
      playbackGeneration: 1,
    });
    receiver.accept(value.open());
    const control = receiver.flowControl();
    const encoded = encodeMistralDuplexUpstreamControl(control);
    expect(decodeMistralDuplexUpstreamControl(encoded)).toEqual(control);
    expectProtocolError(
      () => decodeMistralDuplexUpstreamControl(encoded.replace(
        '"receiverRevision":1',
        '"receiverRevision":1,"receiverRevision":1',
      )),
      'invalid_json',
    );
    expectProtocolError(
      () => decodeMistralDuplexUpstreamControl(JSON.stringify({
        ...control,
        pressure: 'backpressured',
        availableBytes: 1,
      })),
      'invalid_envelope',
    );
  });

  it('ne produit cancel_requested qu après le fence et la preuve native exacts', () => {
    const value = fixture({ chunks: [pcm(8, 1)] });
    const receiver = new MistralDuplexDownlinkReceiver({
      sessionId: SESSION_ID,
      duplexId: DUPLEX_ID,
      connectionEpoch: CONNECTION_EPOCH,
      nextSequence: 0,
      playbackGeneration: 1,
    });
    receiver.accept(value.open());
    receiver.cancelLocally('barge_in', 1, ARTIFACT_ID);
    receiver.confirmNativeFlush(1, ARTIFACT_ID, 2);
    const request = receiver.localCancelRequest();
    expect(request).toMatchObject({
      type: 'receiver.cancel_requested',
      playbackGeneration: 1,
      nextPlaybackGeneration: 2,
      reason: 'barge_in',
      nativeFlushConfirmed: true,
    });
    expect(decodeMistralDuplexUpstreamControl(
      encodeMistralDuplexUpstreamControl(request),
    )).toEqual(request);

    const unproved = new MistralDuplexDownlinkReceiver({
      sessionId: SESSION_ID,
      duplexId: DUPLEX_ID,
      connectionEpoch: CONNECTION_EPOCH,
      nextSequence: 0,
      playbackGeneration: 1,
    });
    unproved.accept(value.open());
    unproved.cancelLocally('barge_in', 1, ARTIFACT_ID);
    expectProtocolError(() => unproved.localCancelRequest(), 'invalid_transition');
  });

  it('encode une preuve playback_drained exacte et refuse clés, révisions ou file forgées', () => {
    const value = fixture({ chunks: [pcm(8, 1)] });
    const receiver = new MistralDuplexDownlinkReceiver({
      sessionId: SESSION_ID,
      duplexId: DUPLEX_ID,
      connectionEpoch: CONNECTION_EPOCH,
      nextSequence: 0,
      playbackGeneration: 1,
    });
    receiver.accept(value.open());
    receiver.accept(value.chunk(0, 1));
    receiver.accept(value.close(2));
    receiver.takeNextChunk();
    receiver.confirmChunkConsumed(1, ARTIFACT_ID, 0);
    const effect = confirmPlaybackDrained(receiver, 1, ARTIFACT_ID, 8, 456.25);
    if (effect.type !== 'playback_drained') throw new Error('expected_playback_drained');
    const control = effect.control;
    const encoded = encodeMistralDuplexUpstreamControl(control);

    expect(decodeMistralDuplexUpstreamControl(encoded)).toEqual(control);
    expect(control).toMatchObject({
      closeSequence: 2,
      nextExpectedSequence: 3,
      consumedThroughChunkIndex: 0,
      receiverRevision: 5,
      nativePlaybackRevision: 8,
      drainedAtMonotonicMs: 456.25,
      nativeQueueEmpty: true,
    });
    for (const forged of [
      { ...control, receiverRevision: 0 },
      { ...control, closeSequence: 1 },
      { ...control, nextExpectedSequence: 4 },
      { ...control, consumedThroughChunkIndex: null },
      { ...control, nativePlaybackRevision: 0 },
      { ...control, drainedAtMonotonicMs: -1 },
      { ...control, nativeQueueEmpty: false },
      { ...control, transcript: 'forbidden' },
    ]) {
      expectProtocolError(
        () => decodeMistralDuplexUpstreamControl(JSON.stringify(forged)),
        'invalid_envelope',
      );
    }
  });
});

describe('Mistral duplex downlink V3 — contiguous receiver', () => {
  it('accepts a mixed binary/base64 stream, verifies close, drains, then advances generation', () => {
    const value = fixture();
    const receiver = new MistralDuplexDownlinkReceiver({
      sessionId: SESSION_ID,
      duplexId: DUPLEX_ID,
      connectionEpoch: CONNECTION_EPOCH,
      nextSequence: 0,
      playbackGeneration: 1,
    });
    expect(receiver.accept(value.open())).toEqual({ type: 'opened', playbackGeneration: 1 });
    expect(receiver.accept(value.chunk(0, 1, 'binary'))).toMatchObject({
      type: 'buffered',
      pressure: 'accepting',
    });
    expect(receiver.accept(value.chunk(1, 2, 'base64'))).toMatchObject({ type: 'buffered' });
    expect(receiver.takeNextChunk()).toMatchObject({ chunkIndex: 0, playbackGeneration: 1 });
    expect(receiver.confirmChunkConsumed(1, ARTIFACT_ID, 0)).toMatchObject({
      type: 'chunk_consumed',
      chunkIndex: 0,
    });
    expect(receiver.accept(value.chunk(2, 3, 'binary'))).toMatchObject({ type: 'buffered' });
    expect(receiver.accept(value.close(4))).toEqual({
      type: 'closed',
      playbackGeneration: 1,
      idempotent: false,
    });
    expect(receiver.isPlaybackGenerationCurrent(1)).toBe(true);
    expect(receiver.takeNextChunk()).toMatchObject({ chunkIndex: 1 });
    receiver.confirmChunkConsumed(1, ARTIFACT_ID, 1);
    expect(receiver.takeNextChunk()).toMatchObject({ chunkIndex: 2 });
    receiver.confirmChunkConsumed(1, ARTIFACT_ID, 2);
    expect(receiver.takeNextChunk()).toBeNull();
    const drained = confirmPlaybackDrained(receiver, 1, ARTIFACT_ID, 7, 321.5);
    expect(drained).toMatchObject({
      type: 'playback_drained',
      idempotent: false,
      control: {
        type: 'receiver.playback_drained',
        closeSequence: 4,
        nextExpectedSequence: 5,
        consumedThroughChunkIndex: 2,
        receiverRevision: 9,
        nativePlaybackRevision: 7,
        drainedAtMonotonicMs: 321.5,
        nativeQueueEmpty: true,
      },
    });
    expect(receiver.snapshot()).toMatchObject({
      phase: 'idle',
      expectedSequence: 5,
      expectedPlaybackGeneration: 2,
      bufferedChunks: 0,
      bufferedBytes: 0,
    });
    expect(receiver.isPlaybackGenerationCurrent(1)).toBe(false);
    expect(JSON.stringify(receiver.snapshot())).not.toContain(SESSION_ID);
    expect(JSON.stringify(receiver.snapshot())).not.toContain(TURN_ID);
  });

  it('rejects a dropped sequence and a reordered chunk without fast-forwarding', () => {
    const dropped = fixture();
    const receiver = new MistralDuplexDownlinkReceiver({
      sessionId: SESSION_ID,
      duplexId: DUPLEX_ID,
      connectionEpoch: CONNECTION_EPOCH,
      nextSequence: 0,
      playbackGeneration: 1,
    });
    receiver.accept(dropped.open());
    expectProtocolError(() => receiver.accept(dropped.chunk(1, 2)), 'sequence_gap');
    expect(receiver.snapshot().phase).toBe('faulted');
    expectProtocolError(() => receiver.accept(dropped.chunk(0, 1)), 'receiver_faulted');

    const reordered = fixture();
    const secondReceiver = new MistralDuplexDownlinkReceiver({
      sessionId: SESSION_ID,
      duplexId: DUPLEX_ID,
      connectionEpoch: CONNECTION_EPOCH,
      nextSequence: 0,
      playbackGeneration: 1,
    });
    secondReceiver.accept(reordered.open());
    expectProtocolError(
      () => secondReceiver.accept(reordered.chunk(1, 1)),
      'chunk_order_violation',
    );
  });

  it('rejects duplicate chunks and differing terminal replays', () => {
    const value = fixture({ chunks: [pcm(8, 1)] });
    const receiver = new MistralDuplexDownlinkReceiver({
      sessionId: SESSION_ID,
      duplexId: DUPLEX_ID,
      connectionEpoch: CONNECTION_EPOCH,
      nextSequence: 0,
      playbackGeneration: 1,
    });
    receiver.accept(value.open());
    const chunk = value.chunk(0, 1);
    receiver.accept(chunk);
    expectProtocolError(() => receiver.accept(chunk), 'duplicate_sequence');

    const terminalValue = fixture({ chunks: [pcm(8, 1)] });
    const terminalReceiver = new MistralDuplexDownlinkReceiver({
      sessionId: SESSION_ID,
      duplexId: DUPLEX_ID,
      connectionEpoch: CONNECTION_EPOCH,
      nextSequence: 0,
      playbackGeneration: 1,
    });
    terminalReceiver.accept(terminalValue.open());
    terminalReceiver.accept(terminalValue.chunk(0, 1));
    const close = terminalValue.close(2);
    expect(terminalReceiver.accept(close)).toMatchObject({ idempotent: false });
    expect(terminalReceiver.accept(close)).toEqual({
      type: 'closed',
      playbackGeneration: 1,
      idempotent: true,
    });
    expectProtocolError(
      () => terminalReceiver.accept({
        ...close,
        artifactSha256: 'f'.repeat(64),
      }),
      'duplicate_sequence',
    );
  });

  it('rejects session/turn/artifact binding tamper and payload tamper', () => {
    const bindingValue = fixture();
    const bindingReceiver = new MistralDuplexDownlinkReceiver({
      sessionId: SESSION_ID,
      duplexId: DUPLEX_ID,
      connectionEpoch: CONNECTION_EPOCH,
      nextSequence: 0,
      playbackGeneration: 1,
    });
    bindingReceiver.accept(bindingValue.open());
    expectProtocolError(
      () => bindingReceiver.accept({
        ...bindingValue.chunk(0, 1),
        turnId: '20000000-0000-4000-8000-000000000099',
      }),
      'binding_mismatch',
    );

    const duplexReceiver = new MistralDuplexDownlinkReceiver({
      sessionId: SESSION_ID,
      duplexId: '10000000-0000-4000-8000-000000000099',
      connectionEpoch: CONNECTION_EPOCH,
      nextSequence: 0,
      playbackGeneration: 1,
    });
    expectProtocolError(() => duplexReceiver.accept(bindingValue.open()), 'binding_mismatch');

    const epochReceiver = new MistralDuplexDownlinkReceiver({
      sessionId: SESSION_ID,
      duplexId: DUPLEX_ID,
      connectionEpoch: CONNECTION_EPOCH + 1,
      nextSequence: 0,
      playbackGeneration: 1,
    });
    expect(epochReceiver.accept(bindingValue.open())).toEqual({
      type: 'stale_connection_frame',
      connectionEpoch: CONNECTION_EPOCH,
      envelopeType: 'speech.open',
    });
    expect(epochReceiver.snapshot()).toMatchObject({ phase: 'idle', expectedSequence: 0 });

    const futureEpochReceiver = new MistralDuplexDownlinkReceiver({
      sessionId: SESSION_ID,
      duplexId: DUPLEX_ID,
      connectionEpoch: CONNECTION_EPOCH,
      nextSequence: 0,
      playbackGeneration: 1,
    });
    const futureEpochValue = fixture({ connectionEpoch: CONNECTION_EPOCH + 1 });
    expectProtocolError(
      () => futureEpochReceiver.accept(futureEpochValue.open()),
      'binding_mismatch',
    );

    const payloadValue = fixture();
    const payloadReceiver = new MistralDuplexDownlinkReceiver({
      sessionId: SESSION_ID,
      duplexId: DUPLEX_ID,
      connectionEpoch: CONNECTION_EPOCH,
      nextSequence: 0,
      playbackGeneration: 1,
    });
    payloadReceiver.accept(payloadValue.open());
    const tamperedPayload = payloadValue.chunk(0, 1);
    tamperedPayload.payload[0] = tamperedPayload.payload[0]! ^ 0xff;
    expectProtocolError(() => payloadReceiver.accept(tamperedPayload), 'chunk_tampered');
  });

  it('rejects close with a missing chunk and a fully streamed artifact hash mismatch', () => {
    const incomplete = fixture();
    const incompleteReceiver = new MistralDuplexDownlinkReceiver({
      sessionId: SESSION_ID,
      duplexId: DUPLEX_ID,
      connectionEpoch: CONNECTION_EPOCH,
      nextSequence: 0,
      playbackGeneration: 1,
    });
    incompleteReceiver.accept(incomplete.open());
    incompleteReceiver.accept(incomplete.chunk(0, 1));
    expectProtocolError(() => incompleteReceiver.accept(incomplete.close(2)), 'close_incomplete');

    const valid = fixture({ chunks: [pcm(8, 1), pcm(8, 2)] });
    const { manifestSha256: _manifestSha256, ...withoutManifest } = valid.prepared.binding;
    const falseBindingWithoutManifest = {
      ...withoutManifest,
      artifactSha256: 'f'.repeat(64),
    };
    const falseBinding: MistralDuplexArtifactBinding = {
      ...falseBindingWithoutManifest,
      manifestSha256: computeMistralDuplexManifestSha256(
        falseBindingWithoutManifest,
        valid.prepared.manifest,
      ),
    };
    const falseOpen: MistralDuplexSpeechOpen = {
      type: 'speech.open',
      sequence: 0,
      ...falseBinding,
      manifest: valid.prepared.manifest,
    };
    const falseChunk = (
      index: number,
      sequence: number,
    ): MistralDuplexSpeechChunk => ({
      type: 'speech.chunk',
      sequence,
      ...falseBinding,
      ...valid.prepared.manifest[index]!,
      encoding: 'binary',
      payload: valid.chunks[index]!.slice(),
    });
    const falseClose: MistralDuplexSpeechClose = {
      type: 'speech.close',
      sequence: 3,
      ...falseBinding,
    };
    const hashReceiver = new MistralDuplexDownlinkReceiver({
      sessionId: SESSION_ID,
      duplexId: DUPLEX_ID,
      connectionEpoch: CONNECTION_EPOCH,
      nextSequence: 0,
      playbackGeneration: 1,
    });
    hashReceiver.accept(falseOpen);
    hashReceiver.accept(falseChunk(0, 1));
    hashReceiver.accept(falseChunk(1, 2));
    expectProtocolError(() => hashReceiver.accept(falseClose), 'artifact_tampered');
  });
});

describe('Mistral duplex downlink V3 — cancellation and generation fences', () => {
  it('cancels mid-playback, clears queued chunks, fences the handed-off chunk and flushes exactly', () => {
    const value = fixture();
    const receiver = new MistralDuplexDownlinkReceiver({
      sessionId: SESSION_ID,
      duplexId: DUPLEX_ID,
      connectionEpoch: CONNECTION_EPOCH,
      nextSequence: 0,
      playbackGeneration: 1,
    });
    receiver.accept(value.open());
    receiver.accept(value.chunk(0, 1));
    receiver.accept(value.chunk(1, 2));
    const playing = receiver.takeNextChunk()!;
    expect(receiver.isPlaybackGenerationCurrent(playing.playbackGeneration)).toBe(true);

    const cancel = value.cancel(3);
    expect(receiver.accept(cancel)).toEqual({
      type: 'cancelled',
      playbackGeneration: 1,
      nextPlaybackGeneration: 2,
      flushRequired: true,
      localAlreadyFenced: false,
      idempotent: false,
    });
    expect(receiver.isPlaybackGenerationCurrent(playing.playbackGeneration)).toBe(false);
    expect(receiver.takeNextChunk()).toBeNull();
    expect(receiver.snapshot()).toMatchObject({
      phase: 'cancelled_awaiting_flush',
      expectedSequence: 4,
      expectedPlaybackGeneration: 2,
      bufferedChunks: 0,
      bufferedBytes: 0,
    });
    expect(receiver.accept(cancel)).toMatchObject({ type: 'cancelled', idempotent: true });
    expect(receiver.confirmNativeFlush(1, ARTIFACT_ID, 2)).toEqual({
      type: 'native_flush_confirmed',
      nextPlaybackGeneration: 2,
      serverBarrierRequired: true,
      idempotent: false,
    });
    expect(receiver.accept(value.flush(4, 3))).toEqual({
      type: 'flushed',
      nextPlaybackGeneration: 2,
    });

    const next = fixture({
      playbackGeneration: 2,
      artifactId: NEXT_ARTIFACT_ID,
      chunks: [pcm(8, 9)],
    });
    expect(receiver.accept(next.open(5))).toEqual({ type: 'opened', playbackGeneration: 2 });
  });

  it('rejects any old-generation chunk after cancellation, even at the next sequence', () => {
    const value = fixture();
    const receiver = new MistralDuplexDownlinkReceiver({
      sessionId: SESSION_ID,
      duplexId: DUPLEX_ID,
      connectionEpoch: CONNECTION_EPOCH,
      nextSequence: 0,
      playbackGeneration: 1,
    });
    receiver.accept(value.open());
    receiver.accept(value.chunk(0, 1));
    receiver.accept(value.cancel(2));
    expectProtocolError(() => receiver.accept(value.chunk(1, 3)), 'stale_generation');
    expect(receiver.snapshot().phase).toBe('faulted');
  });

  it('rejects opening the next generation before flush and rejects a mismatched flush', () => {
    const value = fixture();
    const receiver = new MistralDuplexDownlinkReceiver({
      sessionId: SESSION_ID,
      duplexId: DUPLEX_ID,
      connectionEpoch: CONNECTION_EPOCH,
      nextSequence: 0,
      playbackGeneration: 1,
    });
    receiver.accept(value.open());
    receiver.accept(value.cancel(1));
    expectProtocolError(() => receiver.accept(value.flush(2, 99)), 'flush_mismatch');

    const secondReceiver = new MistralDuplexDownlinkReceiver({
      sessionId: SESSION_ID,
      duplexId: DUPLEX_ID,
      connectionEpoch: CONNECTION_EPOCH,
      nextSequence: 0,
      playbackGeneration: 1,
    });
    secondReceiver.accept(value.open());
    secondReceiver.accept(value.cancel(1));
    const next = fixture({
      playbackGeneration: 2,
      artifactId: NEXT_ARTIFACT_ID,
      chunks: [pcm(8, 9)],
    });
    expectProtocolError(() => secondReceiver.accept(next.open(2)), 'invalid_transition');
  });

  it('accepts an exact cancel replay but rejects a conflicting replay', () => {
    const value = fixture();
    const receiver = new MistralDuplexDownlinkReceiver({
      sessionId: SESSION_ID,
      duplexId: DUPLEX_ID,
      connectionEpoch: CONNECTION_EPOCH,
      nextSequence: 0,
      playbackGeneration: 1,
    });
    receiver.accept(value.open());
    const cancel = value.cancel(1);
    receiver.accept(cancel);
    expect(receiver.accept(cancel)).toMatchObject({ idempotent: true });
    expectProtocolError(
      () => receiver.accept({ ...cancel, reason: 'user_cancel' }),
      'duplicate_sequence',
    );
  });

  it('fence localement avant le serveur, droppe les trames déjà en vol puis exige les deux barrières', () => {
    const value = fixture();
    const receiver = new MistralDuplexDownlinkReceiver({
      sessionId: SESSION_ID,
      duplexId: DUPLEX_ID,
      connectionEpoch: CONNECTION_EPOCH,
      nextSequence: 0,
      playbackGeneration: 1,
    });
    receiver.accept(value.open());
    receiver.accept(value.chunk(0, 1));
    receiver.takeNextChunk();

    expect(receiver.cancelLocally('barge_in', 1, ARTIFACT_ID)).toEqual({
      type: 'local_cancelled',
      playbackGeneration: 1,
      nextPlaybackGeneration: 2,
      reason: 'barge_in',
      flushRequired: true,
      idempotent: false,
    });
    expect(receiver.cancelLocally('barge_in', 1, ARTIFACT_ID)).toMatchObject({
      type: 'local_cancelled',
      idempotent: true,
    });
    expect(receiver.cancelLocally('route_lost', 1, ARTIFACT_ID)).toEqual({
      type: 'local_cancelled',
      playbackGeneration: 1,
      nextPlaybackGeneration: 2,
      reason: 'barge_in',
      flushRequired: true,
      idempotent: true,
    });
    expect(receiver.confirmNativeFlush(1, ARTIFACT_ID, 2)).toMatchObject({
      type: 'native_flush_confirmed',
      serverBarrierRequired: true,
    });
    expect(receiver.confirmChunkConsumed(1, ARTIFACT_ID, 0)).toEqual({
      type: 'stale_native_callback',
      playbackGeneration: 1,
      chunkIndex: 0,
    });
    expect(receiver.accept(value.chunk(1, 2))).toEqual({
      type: 'dropped_after_local_cancel',
      playbackGeneration: 1,
      envelopeType: 'speech.chunk',
    });
    expect(receiver.accept(value.chunk(2, 3))).toMatchObject({
      type: 'dropped_after_local_cancel',
      envelopeType: 'speech.chunk',
    });
    expect(receiver.accept(value.close(4))).toMatchObject({
      type: 'dropped_after_local_cancel',
      envelopeType: 'speech.close',
    });
    const cancel = value.cancel(5);
    expect(receiver.accept(cancel)).toMatchObject({
      type: 'cancelled',
      localAlreadyFenced: true,
    });
    const flush = value.flush(6, 5);
    expect(receiver.accept(flush)).toEqual({ type: 'flushed', nextPlaybackGeneration: 2 });
    expect(receiver.snapshot()).toMatchObject({
      phase: 'idle',
      expectedSequence: 7,
      expectedPlaybackGeneration: 2,
      bufferedBytes: 0,
      inFlightBytes: 0,
    });

    expect(receiver.accept(cancel)).toEqual({
      type: 'terminal_replay',
      envelopeType: 'speech.cancel',
      playbackGeneration: 1,
    });
    expect(receiver.accept(flush)).toEqual({
      type: 'terminal_replay',
      envelopeType: 'speech.flush',
      playbackGeneration: 1,
    });
  });

  it('ne prend jamais une barrière serveur pour une preuve de flush natif', () => {
    const value = fixture({ chunks: [pcm(8, 1)] });
    const receiver = new MistralDuplexDownlinkReceiver({
      sessionId: SESSION_ID,
      duplexId: DUPLEX_ID,
      connectionEpoch: CONNECTION_EPOCH,
      nextSequence: 0,
      playbackGeneration: 1,
    });
    receiver.accept(value.open());
    receiver.accept(value.cancel(1));
    const flush = value.flush(2, 1);
    expect(receiver.accept(flush)).toEqual({
      type: 'server_flush_barrier',
      nextPlaybackGeneration: 2,
      nativeFlushRequired: true,
      idempotent: false,
    });
    expect(receiver.accept(flush)).toMatchObject({
      type: 'server_flush_barrier',
      idempotent: true,
    });
    expect(receiver.snapshot().phase).toBe('cancelled_awaiting_flush');
    expectProtocolError(
      () => receiver.accept(fixture({
        playbackGeneration: 2,
        artifactId: NEXT_ARTIFACT_ID,
        chunks: [pcm(8, 2)],
      }).open(3)),
      'invalid_transition',
    );

    const second = new MistralDuplexDownlinkReceiver({
      sessionId: SESSION_ID,
      duplexId: DUPLEX_ID,
      connectionEpoch: CONNECTION_EPOCH,
      nextSequence: 0,
      playbackGeneration: 1,
    });
    second.accept(value.open());
    second.accept(value.cancel(1));
    second.accept(flush);
    expect(second.confirmNativeFlush(1, ARTIFACT_ID, 2)).toEqual({
      type: 'flushed',
      nextPlaybackGeneration: 2,
    });
  });

  it('ignore un callback natif exact de G après flush sans toucher G+1', () => {
    const value = fixture({ chunks: [pcm(8, 1)] });
    const receiver = new MistralDuplexDownlinkReceiver({
      sessionId: SESSION_ID,
      duplexId: DUPLEX_ID,
      connectionEpoch: CONNECTION_EPOCH,
      nextSequence: 0,
      playbackGeneration: 1,
    });
    receiver.accept(value.open());
    receiver.accept(value.chunk(0, 1));
    receiver.takeNextChunk();
    receiver.accept(value.cancel(2));
    receiver.confirmNativeFlush(1, ARTIFACT_ID, 2);
    receiver.accept(value.flush(3, 2));
    expect(receiver.confirmChunkConsumed(1, ARTIFACT_ID, 0)).toEqual({
      type: 'stale_native_callback',
      playbackGeneration: 1,
      chunkIndex: 0,
    });
    expectProtocolError(
      () => receiver.confirmChunkConsumed(1, NEXT_ARTIFACT_ID, 0),
      'binding_mismatch',
    );
  });

  it('conserve des tombstones bornés pour les callbacks G1 reçus après G2 et G3', () => {
    const receiver = new MistralDuplexDownlinkReceiver({
      sessionId: SESSION_ID,
      duplexId: DUPLEX_ID,
      connectionEpoch: CONNECTION_EPOCH,
      nextSequence: 0,
      playbackGeneration: 1,
    });
    const artifacts = [
      fixture({ playbackGeneration: 1, artifactId: ARTIFACT_ID, chunks: [pcm(8, 1)] }),
      fixture({ playbackGeneration: 2, artifactId: NEXT_ARTIFACT_ID, chunks: [pcm(8, 2)] }),
      fixture({
        playbackGeneration: 3,
        artifactId: '30000000-0000-4000-8000-000000000005',
        chunks: [pcm(8, 3)],
      }),
    ] as const;

    for (let index = 0; index < artifacts.length; index += 1) {
      const artifact = artifacts[index]!;
      const sequence = index * 3;
      receiver.accept(artifact.open(sequence));
      receiver.accept(artifact.chunk(0, sequence + 1));
      receiver.takeNextChunk();
      receiver.accept(artifact.close(sequence + 2));
      receiver.confirmChunkConsumed(index + 1, artifact.prepared.binding.artifactId, 0);
      confirmPlaybackDrained(
        receiver,
        index + 1,
        artifact.prepared.binding.artifactId,
        index + 1,
        101 + index,
      );
    }

    expect(receiver.confirmChunkConsumed(1, ARTIFACT_ID, 0)).toEqual({
      type: 'stale_native_callback',
      playbackGeneration: 1,
      chunkIndex: 0,
    });
    expect(confirmPlaybackDrained(receiver, 1, ARTIFACT_ID, 1, 101)).toMatchObject({
      type: 'playback_drained',
      playbackGeneration: 1,
      idempotent: true,
      control: { nativePlaybackRevision: 1, drainedAtMonotonicMs: 101 },
    });
    expect(receiver.accept(artifacts[0]!.close(2))).toEqual({
      type: 'terminal_replay',
      envelopeType: 'speech.close',
      playbackGeneration: 1,
    });
    expect(receiver.snapshot()).toMatchObject({
      phase: 'idle',
      expectedPlaybackGeneration: 4,
    });
  });

  it('accepte le barge-in local exact quand le cancel serveur a gagné la course', () => {
    const value = fixture({ chunks: [pcm(8, 1)] });
    const receiver = new MistralDuplexDownlinkReceiver({
      sessionId: SESSION_ID,
      duplexId: DUPLEX_ID,
      connectionEpoch: CONNECTION_EPOCH,
      nextSequence: 0,
      playbackGeneration: 1,
    });
    receiver.accept(value.open());
    receiver.accept(value.cancel(1, 'superseded'));
    expect(receiver.cancelLocally('barge_in', 1, ARTIFACT_ID)).toMatchObject({
      type: 'local_cancelled',
      playbackGeneration: 1,
      idempotent: false,
    });
    expect(receiver.cancelLocally('barge_in', 1, ARTIFACT_ID)).toMatchObject({
      type: 'local_cancelled',
      idempotent: true,
    });
    expect(receiver.confirmNativeFlush(1, ARTIFACT_ID, 2)).toMatchObject({
      type: 'native_flush_confirmed',
      serverBarrierRequired: true,
    });
    expect(receiver.accept(value.flush(2, 1))).toEqual({
      type: 'flushed',
      nextPlaybackGeneration: 2,
    });
  });
});

describe('Mistral duplex downlink V3 — bounded jitter and backpressure', () => {
  const largeChunks = [
    pcm(MISTRAL_DUPLEX_DOWNLINK_LIMITS.maxChunkBytes, 1),
    pcm(MISTRAL_DUPLEX_DOWNLINK_LIMITS.maxChunkBytes, 2),
    pcm(MISTRAL_DUPLEX_DOWNLINK_LIMITS.maxChunkBytes, 3),
    pcm(MISTRAL_DUPLEX_DOWNLINK_LIMITS.maxChunkBytes, 4),
  ] as const;

  it('enters backpressure at the high-water mark and fails closed if the sender ignores it', () => {
    const value = fixture({ chunks: largeChunks });
    const receiver = new MistralDuplexDownlinkReceiver({
      sessionId: SESSION_ID,
      duplexId: DUPLEX_ID,
      connectionEpoch: CONNECTION_EPOCH,
      nextSequence: 0,
      playbackGeneration: 1,
    });
    receiver.accept(value.open());
    expect(receiver.accept(value.chunk(0, 1))).toMatchObject({ pressure: 'accepting' });
    expect(receiver.accept(value.chunk(1, 2))).toMatchObject({ pressure: 'accepting' });
    expect(receiver.accept(value.chunk(2, 3))).toMatchObject({ pressure: 'backpressured' });
    expect(receiver.snapshot()).toMatchObject({
      bufferedChunks: 3,
      bufferedBytes: MISTRAL_DUPLEX_DOWNLINK_LIMITS.highWaterBufferedBytes,
      pressure: 'backpressured',
    });
    expect(receiver.snapshot().bufferedBytes).toBeLessThanOrEqual(
      MISTRAL_DUPLEX_DOWNLINK_LIMITS.maxBufferedBytes,
    );
    expectProtocolError(() => receiver.accept(value.chunk(3, 4)), 'backpressure_violation');
    expect(receiver.snapshot()).toMatchObject({
      phase: 'faulted',
      bufferedChunks: 0,
      bufferedBytes: 0,
    });
  });

  it('resumes only below both low-water marks and never loses sequence or payload', () => {
    const value = fixture({ chunks: largeChunks });
    const receiver = new MistralDuplexDownlinkReceiver({
      sessionId: SESSION_ID,
      duplexId: DUPLEX_ID,
      connectionEpoch: CONNECTION_EPOCH,
      nextSequence: 0,
      playbackGeneration: 1,
    });
    receiver.accept(value.open());
    receiver.accept(value.chunk(0, 1));
    receiver.accept(value.chunk(1, 2));
    receiver.accept(value.chunk(2, 3));
    expect(receiver.takeNextChunk()).toMatchObject({ chunkIndex: 0 });
    expect(receiver.snapshot().pressure).toBe('backpressured');
    receiver.confirmChunkConsumed(1, ARTIFACT_ID, 0);
    expect(receiver.takeNextChunk()).toMatchObject({ chunkIndex: 1 });
    receiver.confirmChunkConsumed(1, ARTIFACT_ID, 1);
    expect(receiver.snapshot()).toMatchObject({
      pressure: 'accepting',
      bufferedChunks: 1,
      bufferedBytes: MISTRAL_DUPLEX_DOWNLINK_LIMITS.lowWaterBufferedBytes,
    });
    receiver.accept(value.chunk(3, 4));
    expect(receiver.takeNextChunk()).toMatchObject({ chunkIndex: 2 });
    receiver.confirmChunkConsumed(1, ARTIFACT_ID, 2);
    expect(receiver.takeNextChunk()).toMatchObject({ chunkIndex: 3 });
    receiver.confirmChunkConsumed(1, ARTIFACT_ID, 3);
    expect(receiver.accept(value.close(5))).toMatchObject({ type: 'closed' });
    confirmPlaybackDrained(receiver, 1, ARTIFACT_ID);
    expect(receiver.snapshot()).toMatchObject({
      phase: 'idle',
      expectedSequence: 6,
      expectedPlaybackGeneration: 2,
    });
  });

  it('requires an empty playback queue before acknowledging a closed generation', () => {
    const value = fixture({ chunks: [pcm(8, 1)] });
    const premature = new MistralDuplexDownlinkReceiver({
      sessionId: SESSION_ID,
      duplexId: DUPLEX_ID,
      connectionEpoch: CONNECTION_EPOCH,
      nextSequence: 0,
      playbackGeneration: 1,
    });
    premature.accept(value.open());
    premature.accept(value.chunk(0, 1));
    premature.accept(value.close(2));
    expectProtocolError(
      () => confirmPlaybackDrained(premature, 1, ARTIFACT_ID),
      'playback_not_drained',
    );
    expect(premature.snapshot().phase).toBe('faulted');

    const receiver = new MistralDuplexDownlinkReceiver({
      sessionId: SESSION_ID,
      duplexId: DUPLEX_ID,
      connectionEpoch: CONNECTION_EPOCH,
      nextSequence: 0,
      playbackGeneration: 1,
    });
    receiver.accept(value.open());
    receiver.accept(value.chunk(0, 1));
    receiver.accept(value.close(2));
    receiver.takeNextChunk();
    receiver.confirmChunkConsumed(1, ARTIFACT_ID, 0);
    confirmPlaybackDrained(receiver, 1, ARTIFACT_ID);
    expect(receiver.snapshot().phase).toBe('idle');
  });

  it('rejoue uniquement la preuve native exacte et fault sur conflit, binding ou profondeur', () => {
    const value = fixture({ chunks: [pcm(8, 1)] });
    const ready = (): MistralDuplexDownlinkReceiver => {
      const receiver = new MistralDuplexDownlinkReceiver({
        sessionId: SESSION_ID,
        duplexId: DUPLEX_ID,
        connectionEpoch: CONNECTION_EPOCH,
        nextSequence: 0,
        playbackGeneration: 1,
      });
      receiver.accept(value.open());
      receiver.accept(value.chunk(0, 1));
      receiver.accept(value.close(2));
      receiver.takeNextChunk();
      receiver.confirmChunkConsumed(1, ARTIFACT_ID, 0);
      return receiver;
    };

    const replayed = ready();
    const first = confirmPlaybackDrained(replayed, 1, ARTIFACT_ID, 9, 600);
    if (first.type !== 'playback_drained') throw new Error('expected_playback_drained');
    expect(confirmPlaybackDrained(replayed, 1, ARTIFACT_ID, 9, 600)).toEqual({
      ...first,
      idempotent: true,
    });

    const conflictingRevision = ready();
    confirmPlaybackDrained(conflictingRevision, 1, ARTIFACT_ID, 9, 600);
    expectProtocolError(
      () => confirmPlaybackDrained(conflictingRevision, 1, ARTIFACT_ID, 10, 600),
      'playback_not_drained',
    );

    const wrongBinding = ready();
    expectProtocolError(
      () => confirmPlaybackDrained(wrongBinding, 1, NEXT_ARTIFACT_ID, 9, 600),
      'binding_mismatch',
    );

    const nonEmptyNativeQueue = ready();
    expectProtocolError(
      () => nonEmptyNativeQueue.confirmPlaybackDrained(1, ARTIFACT_ID, 9, 600, 2, 1),
      'playback_not_drained',
    );
  });

  it('émet un crédit absolu et ne recrédite rien au simple handoff vers le natif', () => {
    const value = fixture({ chunks: largeChunks });
    const receiver = new MistralDuplexDownlinkReceiver({
      sessionId: SESSION_ID,
      duplexId: DUPLEX_ID,
      connectionEpoch: CONNECTION_EPOCH,
      nextSequence: 0,
      playbackGeneration: 1,
    });
    receiver.accept(value.open());
    const initial = receiver.flowControl();
    expect(initial).toMatchObject({
      type: 'receiver.flow_control',
      receiverRevision: 1,
      consumedThroughChunkIndex: null,
      pressure: 'accepting',
      availableBytes: MISTRAL_DUPLEX_DOWNLINK_LIMITS.highWaterBufferedBytes,
      availableChunks: 6,
    });
    expect(receiver.flowControl()).toEqual(initial);

    receiver.accept(value.chunk(0, 1));
    receiver.accept(value.chunk(1, 2));
    receiver.accept(value.chunk(2, 3));
    expect(receiver.flowControl()).toMatchObject({
      pressure: 'backpressured',
      availableBytes: 0,
      availableChunks: 0,
    });
    receiver.takeNextChunk();
    expect(receiver.flowControl()).toMatchObject({
      pressure: 'backpressured',
      availableBytes: 0,
    });
    receiver.confirmChunkConsumed(1, ARTIFACT_ID, 0);
    receiver.takeNextChunk();
    receiver.confirmChunkConsumed(1, ARTIFACT_ID, 1);
    const resumed = receiver.flowControl();
    expect(resumed).toMatchObject({
      consumedThroughChunkIndex: 1,
      pressure: 'accepting',
      availableBytes: MISTRAL_DUPLEX_DOWNLINK_LIMITS.highWaterBufferedBytes
        - MISTRAL_DUPLEX_DOWNLINK_LIMITS.lowWaterBufferedBytes,
      availableChunks: 5,
    });
    expect(receiver.flowControl()).toEqual(resumed);
  });

  it('rejette sequence MAX avant toute mutation', () => {
    const value = fixture({ chunks: [pcm(8, 1)] });
    const receiver = new MistralDuplexDownlinkReceiver({
      sessionId: SESSION_ID,
      duplexId: DUPLEX_ID,
      connectionEpoch: CONNECTION_EPOCH,
      nextSequence: 0x7fff_ffff,
      playbackGeneration: 1,
    });
    expectProtocolError(() => receiver.accept(value.open(0x7fff_ffff)), 'sequence_exhausted');
    expect(receiver.snapshot()).toMatchObject({
      phase: 'faulted',
      receivedChunks: 0,
      bufferedBytes: 0,
    });
  });

  it('refuse un open avant de consommer le budget réservé à close, cancel et flush', () => {
    const value = fixture({ chunks: [pcm(8, 1)] });
    const receiver = new MistralDuplexDownlinkReceiver({
      sessionId: SESSION_ID,
      duplexId: DUPLEX_ID,
      connectionEpoch: CONNECTION_EPOCH,
      nextSequence: 0x7fff_fffb,
      playbackGeneration: 1,
    });
    expect(receiver.snapshot()).toMatchObject({
      routeExhausted: true,
    });
    expectProtocolError(() => receiver.accept(value.open(0x7fff_fffb)), 'sequence_exhausted');
  });

  it('accepte la dernière route complète puis exige une rotation avant le prochain artefact', () => {
    const value = fixture({ chunks: [pcm(8, 1)] });
    const receiver = new MistralDuplexDownlinkReceiver({
      sessionId: SESSION_ID,
      duplexId: DUPLEX_ID,
      connectionEpoch: CONNECTION_EPOCH,
      nextSequence: 0x7fff_fffa,
      playbackGeneration: 1,
    });
    receiver.accept(value.open(0x7fff_fffa));
    receiver.accept(value.chunk(0, 0x7fff_fffb));
    receiver.accept(value.close(0x7fff_fffc));
    receiver.accept(value.cancel(0x7fff_fffd));
    receiver.confirmNativeFlush(1, ARTIFACT_ID, 2);
    receiver.accept(value.flush(0x7fff_fffe, 0x7fff_fffd));
    expect(receiver.snapshot()).toMatchObject({
      phase: 'idle',
      expectedSequence: 0x7fff_ffff,
      routeExhausted: true,
    });
  });

  it('épuise la route avant une génération qui ne pourrait plus être ouverte', () => {
    const generation = 0x7fff_fffd;
    const value = fixture({
      playbackGeneration: generation,
      chunks: [pcm(8, 1)],
    });
    const receiver = new MistralDuplexDownlinkReceiver({
      sessionId: SESSION_ID,
      duplexId: DUPLEX_ID,
      connectionEpoch: CONNECTION_EPOCH,
      nextSequence: 0,
      playbackGeneration: generation,
    });
    receiver.accept(value.open());
    receiver.accept(value.chunk(0, 1));
    receiver.takeNextChunk();
    receiver.accept(value.close(2));
    receiver.confirmChunkConsumed(generation, ARTIFACT_ID, 0);
    confirmPlaybackDrained(receiver, generation, ARTIFACT_ID);
    expect(receiver.snapshot()).toMatchObject({
      phase: 'idle',
      expectedPlaybackGeneration: 0x7fff_fffe,
      routeExhausted: true,
    });
    expectProtocolError(
      () => new MistralDuplexDownlinkReceiver({
        sessionId: SESSION_ID,
        duplexId: DUPLEX_ID,
        connectionEpoch: CONNECTION_EPOCH,
        nextSequence: 3,
        playbackGeneration: 0x7fff_fffe,
      }),
      'invalid_receiver_config',
    );
  });
});

describe('Mistral duplex downlink V3 — manifest parser table', () => {
  it.each([
    ['negative index', { chunkIndex: -1 }],
    ['non-contiguous index', { chunkIndex: 2 }],
    ['negative offset', { byteOffset: -1 }],
    ['odd offset', { byteOffset: 1 }],
    ['zero length', { byteLength: 0 }],
    ['odd length', { byteLength: 3 }],
    ['uppercase hash', { chunkSha256: 'A'.repeat(64) }],
  ])('rejects %s', (_label, override) => {
    const value = fixture({ chunks: [pcm(8, 1)] });
    const entry: MistralDuplexManifestEntry = {
      ...value.prepared.manifest[0]!,
      ...override,
    };
    expectProtocolError(
      () => decodeMistralDuplexTextEnvelope(JSON.stringify({
        ...value.open(),
        manifest: [entry],
      })),
      'invalid_manifest',
    );
  });
});
