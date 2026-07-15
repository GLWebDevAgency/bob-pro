import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  RealtimeSpeechPublisher,
  type RealtimeSpeechArtifactRepositoryPort,
  type RealtimeSpeechPublisherInput,
} from './realtime-speech-publisher';
import { RealtimeSpeechRenderer, type RealtimeRenderedAudio } from './realtime-speech-renderer';
import type { RealtimeSpeechStoragePort } from './realtime-speech-storage';

const COMPANY_ID = 'company-1';
const SUBJECT_HASH = '1'.repeat(64);
const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const TURN_ID = '22222222-2222-4222-8222-222222222222';
const ARTIFACT_ID = '33333333-3333-4333-8333-333333333333';
const CANCELLATION_ID = '44444444-4444-4444-8444-444444444444';
const CONTEXT = { contextRevision: 7, contextDigest: '2'.repeat(64) } as const;
const SIDEBAND_OWNER = 'a'.repeat(64);
const TEXT = 'Le reste dû est de 1 320 €.';

function mp3(): RealtimeRenderedAudio {
  const audioBytes = new Uint8Array(2_048);
  audioBytes.set([0x49, 0x44, 0x33]);
  return { audioBytes, mimeType: 'audio/mpeg', estimatedDurationMs: 1_000 };
}

function repository(): RealtimeSpeechArtifactRepositoryPort {
  return {
    claimRender: vi.fn<RealtimeSpeechArtifactRepositoryPort['claimRender']>().mockResolvedValue({
      status: 'claimed',
      artifactId: ARTIFACT_ID,
      sequence: 1,
    }),
    finalizeReady: vi.fn<RealtimeSpeechArtifactRepositoryPort['finalizeReady']>()
      .mockResolvedValue({ status: 'ready' }),
    failRender: vi.fn<RealtimeSpeechArtifactRepositoryPort['failRender']>().mockResolvedValue(undefined),
    cancel: vi.fn<RealtimeSpeechArtifactRepositoryPort['cancel']>().mockResolvedValue(undefined),
  };
}

function storage(): RealtimeSpeechStoragePort {
  return {
    upload: vi.fn<RealtimeSpeechStoragePort['upload']>().mockImplementation(async (input) => ({
      key: input.key,
      sizeBytes: input.bytes.byteLength,
      audioSha256: createHash('sha256').update(input.bytes).digest('hex'),
      mimeType: input.mimeType,
    })),
    createSignedDownload: vi.fn<RealtimeSpeechStoragePort['createSignedDownload']>(),
    delete: vi.fn<RealtimeSpeechStoragePort['delete']>().mockResolvedValue(undefined),
  };
}

function input(overrides: Partial<RealtimeSpeechPublisherInput> = {}): RealtimeSpeechPublisherInput {
  return {
    companyId: COMPANY_ID,
    subjectHash: SUBJECT_HASH,
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    segmentIndex: 0,
    canonicalSpeech: TEXT,
    contextRevision: CONTEXT.contextRevision,
    contextDigest: CONTEXT.contextDigest,
    sidebandOwnerTokenHash: SIDEBAND_OWNER,
    signal: new AbortController().signal,
    revalidateContext: async () => CONTEXT,
    ...overrides,
  };
}

function harness(overrides: {
  repository?: RealtimeSpeechArtifactRepositoryPort;
  storage?: RealtimeSpeechStoragePort;
  synthesize?: (input: { text: string; signal: AbortSignal }) => Promise<RealtimeRenderedAudio>;
  transcribe?: (input: { audioBytes: Uint8Array; mimeType: string; signal: AbortSignal }) => Promise<{ text: string }>;
} = {}) {
  const repo = overrides.repository ?? repository();
  const artifactStorage = overrides.storage ?? storage();
  const renderer = new RealtimeSpeechRenderer({
    synthesizer: {
      id: 'mistral-voxtral-tts',
      trustDomain: 'mistral.ai',
      synthesize: overrides.synthesize ?? (async () => mp3()),
    },
    auditor: {
      id: 'whisper',
      trustDomain: 'openai.com',
      transcribe: overrides.transcribe ?? (async () => ({ text: TEXT })),
    },
  });
  return {
    repo,
    storage: artifactStorage,
    publisher: new RealtimeSpeechPublisher({
      renderer,
      repository: repo,
      storage: artifactStorage,
      proofSecret: 'proof-secret-that-is-long-enough-0001',
      proofKeyVersion: 2,
      entropy: {
        artifactId: () => ARTIFACT_ID,
        token: () => 'render-token-that-is-long-enough-0001',
        cancellationId: () => CANCELLATION_ID,
      },
      reconciliationPause: async () => undefined,
    }),
  };
}

describe('RealtimeSpeechPublisher', () => {
  it('ne publie ready qu’après upload, quatrième fence et CAS durable', async () => {
    const h = harness();
    const revalidate = vi.fn<RealtimeSpeechPublisherInput['revalidateContext']>()
      .mockResolvedValue(CONTEXT);

    await expect(h.publisher.publish(input({ revalidateContext: revalidate }))).resolves.toEqual({
      status: 'ready', artifactId: ARTIFACT_ID, sequence: 1,
    });

    expect(revalidate).toHaveBeenCalledTimes(4);
    expect(h.storage.upload).toHaveBeenCalledOnce();
    expect(h.repo.finalizeReady).toHaveBeenCalledOnce();
    expect(h.repo.finalizeReady).toHaveBeenCalledWith(expect.objectContaining({
      artifactId: ARTIFACT_ID,
      sequence: 1,
      contextRevision: CONTEXT.contextRevision,
      contextDigest: CONTEXT.contextDigest,
      classification: 'dynamic_sensitive',
      source: 'synthesized_audited',
      proofKeyVersion: 2,
      canonicalSpeechHmac: expect.stringMatching(/^[a-f0-9]{64}$/),
      factsHmac: expect.stringMatching(/^[a-f0-9]{64}$/),
      auditTranscriptHmac: expect.stringMatching(/^[a-f0-9]{64}$/),
      evidenceHmac: expect.stringMatching(/^[a-f0-9]{64}$/),
      audioSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(h.storage.delete).not.toHaveBeenCalled();
  });

  it('un retry déjà ready ne relance ni TTS ni stockage', async () => {
    const repo = repository();
    vi.mocked(repo.claimRender).mockResolvedValue({ status: 'ready', artifactId: ARTIFACT_ID, sequence: 9 });
    const synthesize = vi.fn(async () => mp3());
    const h = harness({ repository: repo, synthesize });

    await expect(h.publisher.publish(input())).resolves.toEqual({
      status: 'already_ready', artifactId: ARTIFACT_ID, sequence: 9,
    });
    expect(synthesize).not.toHaveBeenCalled();
    expect(h.storage.upload).not.toHaveBeenCalled();
  });

  it('un changement de contexte après upload supprime l’objet et annule le segment', async () => {
    const revalidate = vi.fn<RealtimeSpeechPublisherInput['revalidateContext']>()
      .mockResolvedValueOnce(CONTEXT)
      .mockResolvedValueOnce(CONTEXT)
      .mockResolvedValueOnce(CONTEXT)
      .mockResolvedValueOnce({ ...CONTEXT, contextRevision: 8 });
    const h = harness();

    await expect(h.publisher.publish(input({ revalidateContext: revalidate })))
      .resolves.toEqual({ status: 'terminal' });
    expect(h.storage.delete).toHaveBeenCalledOnce();
    expect(h.repo.finalizeReady).not.toHaveBeenCalled();
    expect(h.repo.cancel).toHaveBeenCalledWith(expect.objectContaining({
      cancellationId: CANCELLATION_ID,
      reason: 'context_changed',
    }));
  });

  it('une divergence stockage est fail-closed, purgée et marquée failed', async () => {
    const artifactStorage = storage();
    vi.mocked(artifactStorage.upload).mockImplementation(async (request) => ({
      key: request.key,
      sizeBytes: request.bytes.byteLength,
      audioSha256: 'f'.repeat(64),
      mimeType: request.mimeType,
    }));
    const h = harness({ storage: artifactStorage });

    await expect(h.publisher.publish(input())).resolves.toEqual({
      status: 'unavailable', stage: 'storage',
    });
    expect(artifactStorage.delete).toHaveBeenCalledOnce();
    expect(h.repo.failRender).toHaveBeenCalledWith(expect.objectContaining({
      reasonCode: 'storage_integrity',
    }));
    expect(h.repo.finalizeReady).not.toHaveBeenCalled();
  });

  it('une course cancel gagnée au CAS ne laisse ni objet ni contrôle publiable', async () => {
    const repo = repository();
    vi.mocked(repo.finalizeReady).mockResolvedValue({ status: 'cancelled' });
    const h = harness({ repository: repo });

    await expect(h.publisher.publish(input({ abortReason: 'barge_in' })))
      .resolves.toEqual({ status: 'terminal' });
    expect(h.storage.delete).toHaveBeenCalledOnce();
    expect(repo.cancel).toHaveBeenCalledWith(expect.objectContaining({ reason: 'barge_in' }));
  });

  it('réconcilie un COMMIT final ambigu avant toute décision de cleanup', async () => {
    const repo = repository();
    vi.mocked(repo.finalizeReady)
      .mockRejectedValueOnce(new Error('ack lost after commit'))
      .mockResolvedValueOnce({ status: 'ready' });
    const h = harness({ repository: repo });

    await expect(h.publisher.publish(input())).resolves.toEqual({
      status: 'ready', artifactId: ARTIFACT_ID, sequence: 1,
    });
    expect(repo.finalizeReady).toHaveBeenCalledTimes(2);
    expect(h.storage.delete).not.toHaveBeenCalled();
  });

  it('ne supprime jamais un objet quand le verdict de COMMIT reste indisponible', async () => {
    const repo = repository();
    vi.mocked(repo.finalizeReady).mockResolvedValue({ status: 'unavailable' });
    const h = harness({ repository: repo });

    await expect(h.publisher.publish(input())).resolves.toEqual({
      status: 'unavailable', stage: 'finalize',
    });
    expect(repo.finalizeReady).toHaveBeenCalledTimes(3);
    expect(h.storage.delete).not.toHaveBeenCalled();
  });

  it('un rejet acoustique ne touche jamais le stockage et persiste un code borné', async () => {
    const h = harness({ transcribe: async () => ({ text: 'Le reste dû est de 9 999 €.' }) });

    await expect(h.publisher.publish(input())).resolves.toEqual({
      status: 'rejected', code: 'SPEECH_FACT_MISMATCH',
    });
    expect(h.storage.upload).not.toHaveBeenCalled();
    expect(h.repo.failRender).toHaveBeenCalledWith(expect.objectContaining({
      reasonCode: 'speech_fact_mismatch',
    }));
  });

  it('une annulation pendant le TTS est physique et ne ressuscite pas le rendu', async () => {
    const controller = new AbortController();
    let synthesisSignal: AbortSignal | undefined;
    const h = harness({
      synthesize: ({ signal }) => {
        synthesisSignal = signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      },
    });
    const publishing = h.publisher.publish(input({ signal: controller.signal, abortReason: 'barge_in' }));
    await vi.waitFor(() => expect(synthesisSignal).toBeDefined());
    controller.abort();

    await expect(publishing).resolves.toEqual({ status: 'aborted' });
    expect(synthesisSignal?.aborted).toBe(true);
    expect(h.storage.upload).not.toHaveBeenCalled();
    expect(h.repo.cancel).toHaveBeenCalledWith(expect.objectContaining({ reason: 'barge_in' }));
  });
});
