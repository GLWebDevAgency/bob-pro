import { describe, expect, it, vi } from 'vitest';
import { createRealtimeSpeechProof } from './realtime-speech-proof';
import { requestContext, setPrincipal } from '../../observability/logger';
import { admissionSubjectHash } from './realtime.service';
import {
  RealtimeSpeechDeliveryService,
  parseRealtimeSpeechCancellationBody,
  parseRealtimeSpeechDeliveryBody,
  parseRealtimeSpeechFeedQuery,
  verifyRealtimeSpeechDeliveryProof,
} from './realtime-speech-delivery';
import type {
  RealtimeSpeechDeliveryArtifact,
  RealtimeSpeechDeliveryRepositoryPort,
} from './realtime-speech-delivery.repository';
import type { RealtimeSpeechStoragePort } from './realtime-speech-storage';

const COMPANY = 'company-1';
const USER = 'user-1';
const SESSION = '00000000-0000-4000-8000-000000000001';
const TURN = '00000000-0000-4000-8000-000000000002';
const ARTIFACT = '00000000-0000-4000-8000-000000000003';
const DELIVERY = '00000000-0000-4000-8000-000000000004';
const CANCELLATION = '00000000-0000-4000-8000-000000000005';
const SUBJECT_SECRET = 'subject-secret-must-have-at-least-thirty-two-characters';
const PROOF_SECRET = 'proof-secret-must-have-at-least-thirty-two-characters';
const SUBJECT = admissionSubjectHash(SUBJECT_SECRET, COMPANY, USER);
const CONTEXT = 'a'.repeat(64);
const TEXT_SHA = 'b'.repeat(64);
const FACTS_SHA = 'c'.repeat(64);
const AUDIT_SHA = 'd'.repeat(64);
const AUDIO_SHA = 'e'.repeat(64);
const STORAGE_KEY = `companies/${COMPANY}/bob-live/${SESSION}/${TURN}/${ARTIFACT}`;

function artifact(overrides: Partial<RealtimeSpeechDeliveryArtifact> = {}): RealtimeSpeechDeliveryArtifact {
  const metadata = {
    version: 1 as const,
    sessionId: SESSION,
    turnId: TURN,
    contextRevision: 7,
    contextDigest: CONTEXT,
    classification: 'dynamic_sensitive' as const,
    source: 'synthesized_audited' as const,
    mimeType: 'audio/mpeg' as const,
    byteLength: 24_000,
    estimatedDurationMs: 1_250,
    textSha256: TEXT_SHA,
    factsSha256: FACTS_SHA,
    auditTranscriptSha256: AUDIT_SHA,
    audioSha256: AUDIO_SHA,
    synthesisAdapterId: 'mistral-tts',
    synthesisTrustDomain: 'mistral.ai',
    auditAdapterId: 'whisper-local',
    auditTrustDomain: 'bob.local-whisper',
  };
  const proof = createRealtimeSpeechProof({
    secret: PROOF_SECRET,
    keyVersion: 1,
    companyId: COMPANY,
    subjectHash: SUBJECT,
    artifactId: ARTIFACT,
    sequence: 1,
    storageKey: STORAGE_KEY,
    metadata,
  });
  const databaseNow = new Date('2026-07-14T10:00:00.000Z');
  return {
    artifactId: ARTIFACT,
    companyId: COMPANY,
    subjectHash: SUBJECT,
    sessionId: SESSION,
    turnId: TURN,
    sequence: 1,
    state: 'ready',
    classification: metadata.classification,
    source: metadata.source,
    contextRevision: metadata.contextRevision,
    contextDigest: metadata.contextDigest,
    sidebandOwnerEpoch: 3,
    sidebandOwnerTokenHash: 'f'.repeat(64),
    storageKey: STORAGE_KEY,
    storageExpiresAt: new Date(databaseNow.getTime() + 60_000),
    mimeType: metadata.mimeType,
    byteLength: metadata.byteLength,
    durationMs: metadata.estimatedDurationMs,
    canonicalSpeechHmac: proof.canonicalSpeechHmac,
    auditTranscriptHmac: proof.auditTranscriptHmac,
    factsHmac: proof.factsHmac,
    evidenceHmac: proof.evidenceHmac,
    audioSha256: metadata.audioSha256,
    proofKeyVersion: proof.proofKeyVersion,
    synthesisAdapterId: metadata.synthesisAdapterId,
    synthesisTrustDomain: metadata.synthesisTrustDomain,
    auditAdapterId: metadata.auditAdapterId,
    auditTrustDomain: metadata.auditTrustDomain,
    objectPurgedAt: null,
    deliveryId: null,
    cancellationId: null,
    cancellationReasonCode: null,
    failureReasonCode: null,
    version: 2,
    fenceCurrent: true,
    databaseNow,
    ...overrides,
  };
}

function repository(
  overrides: Partial<RealtimeSpeechDeliveryRepositoryPort> = {},
): RealtimeSpeechDeliveryRepositoryPort {
  return {
    readNext: vi.fn(async () => ({ status: 'found' as const, artifact: artifact() })),
    readExact: vi.fn(async () => ({ status: 'found' as const, artifact: artifact() })),
    validateReadyFence: vi.fn(async () => 'current' as const),
    acknowledgeDelivery: vi.fn(async () => ({
      status: 'delivered' as const,
      idempotent: false,
      controlCurrent: true,
      contextRevision: 7,
      contextDigest: CONTEXT,
    })),
    cancel: vi.fn(async () => ({ status: 'cancelled' as const, idempotent: false })),
    ...overrides,
  };
}

function storage(): RealtimeSpeechStoragePort {
  return {
    upload: vi.fn(),
    createSignedDownload: vi.fn(async () => ({
      url: 'https://storage.bob.test/private-audio?token=opaque',
      expiresInSeconds: 15,
    })),
    delete: vi.fn(),
  };
}

function service(
  repo = repository(),
  store = storage(),
  config: { enabled?: boolean; proofSecret?: string | null } = {},
) {
  return {
    service: new RealtimeSpeechDeliveryService(repo, store, {
      enabled: config.enabled ?? true,
      subjectHmacSecret: SUBJECT_SECRET,
      proofSecret: config.proofSecret === undefined ? PROOF_SECRET : config.proofSecret,
      proofKeyVersion: 1,
      pollIntervalMs: 25,
    }),
    repo,
    store,
  };
}

function runAsPrincipal<T>(fn: () => Promise<T>): Promise<T> {
  return requestContext.run({ correlationId: 'speech-delivery-test' }, async () => {
    setPrincipal({ userId: USER, companyId: COMPANY });
    return fn();
  });
}

describe('Realtime speech delivery parsers', () => {
  it('accepte seulement les paramètres canoniques et bornés', () => {
    expect(parseRealtimeSpeechFeedQuery({ afterSequence: '0' })).toEqual({
      ok: true,
      value: { afterSequence: 0, waitMs: 2_500 },
    });
    expect(parseRealtimeSpeechFeedQuery({ afterSequence: '01' }).ok).toBe(false);
    expect(parseRealtimeSpeechFeedQuery({ afterSequence: '0', waitMs: '2501' }).ok).toBe(false);
    expect(parseRealtimeSpeechFeedQuery({ afterSequence: '0', providerId: 'private' }).ok).toBe(false);
  });

  it('refuse champs supplémentaires, hash non canonique et motif hors allowlist', () => {
    expect(parseRealtimeSpeechDeliveryBody({
      deliveryId: DELIVERY,
      audioSha256: AUDIO_SHA,
    }).ok).toBe(true);
    expect(parseRealtimeSpeechDeliveryBody({
      deliveryId: DELIVERY,
      audioSha256: AUDIO_SHA.toUpperCase(),
    }).ok).toBe(false);
    expect(parseRealtimeSpeechCancellationBody({
      cancellationId: CANCELLATION,
      reason: 'barge_in',
    }).ok).toBe(true);
    expect(parseRealtimeSpeechCancellationBody({
      cancellationId: CANCELLATION,
      reason: 'provider_error',
    }).ok).toBe(false);
  });
});

describe('RealtimeSpeechDeliveryService feed', () => {
  it('vérifie la preuve, signe brièvement puis applique le cinquième fence avant publication', async () => {
    const value = service();

    const result = await runAsPrincipal(() => value.service.next(
      SESSION,
      { afterSequence: '0', waitMs: '0' },
    ));

    expect(result).toEqual({
      ok: true,
      value: {
        status: 'ready',
        artifactId: ARTIFACT,
        turnId: TURN,
        sequence: 1,
        contextRevision: 7,
        contextDigest: CONTEXT,
        audioUrl: 'https://storage.bob.test/private-audio?token=opaque',
        audioSha256: AUDIO_SHA,
        mimeType: 'audio/mpeg',
        byteSize: 24_000,
        durationMs: 1_250,
      },
    });
    expect(value.store.createSignedDownload).toHaveBeenCalledWith({
      companyId: COMPANY,
      key: STORAGE_KEY,
      ttlSeconds: 15,
      signal: expect.any(AbortSignal),
    });
    expect(value.repo.validateReadyFence).toHaveBeenCalledWith(expect.objectContaining({
      artifactId: ARTIFACT,
      version: 2,
      evidenceHmac: artifact().evidenceHmac,
      audioSha256: AUDIO_SHA,
    }));
  });

  it('échoue fermé avant signature si une colonne de preuve est altérée', async () => {
    const repo = repository({
      readNext: vi.fn(async () => ({
        status: 'found' as const,
        artifact: artifact({ byteLength: 23_999 }),
      })),
    });
    const value = service(repo);

    const result = await runAsPrincipal(() => value.service.next(
      SESSION,
      { afterSequence: '0', waitMs: '0' },
    ));

    expect(result).toMatchObject({ ok: false, error: { kind: 'unavailable' } });
    expect(value.store.createSignedDownload).not.toHaveBeenCalled();
  });

  it('ne publie pas une URL déjà signée si le contexte change dans la fenêtre de course', async () => {
    const repo = repository({ validateReadyFence: vi.fn(async () => 'terminal' as const) });
    const value = service(repo);

    const result = await runAsPrincipal(() => value.service.next(
      SESSION,
      { afterSequence: '0', waitMs: '0' },
    ));

    expect(result).toMatchObject({
      ok: true,
      value: { status: 'terminal', reason: 'expired', sequence: 1 },
    });
  });

  it('long-poll sans trou puis retourne le premier segment rendering', async () => {
    const readNext = vi.fn()
      .mockResolvedValueOnce({ status: 'none' })
      .mockResolvedValueOnce({
        status: 'found',
        artifact: artifact({ state: 'rendering', source: null }),
      });
    const value = service(repository({ readNext }));

    const result = await runAsPrincipal(() => value.service.next(
      SESSION,
      { afterSequence: '0', waitMs: '100' },
    ));

    expect(result).toMatchObject({ ok: true, value: { status: 'rendering', sequence: 1 } });
    expect(readNext).toHaveBeenCalledTimes(2);
  });

  it('représente un retry post-ACK par un terminal delivered sans resignature', async () => {
    const value = service(repository({
      readNext: vi.fn(async () => ({
        status: 'found' as const,
        artifact: artifact({ state: 'delivered', deliveryId: DELIVERY }),
      })),
    }));

    const result = await runAsPrincipal(() => value.service.next(
      SESSION,
      { afterSequence: '0', waitMs: '0' },
    ));

    expect(result).toMatchObject({
      ok: true,
      value: { status: 'terminal', reason: 'delivered', sequence: 1 },
    });
    expect(value.store.createSignedDownload).not.toHaveBeenCalled();
  });
});

describe('RealtimeSpeechDeliveryService mutations', () => {
  it('acquitte avec preuve exacte et ne retourne qu’une référence de contrôle fenceée', async () => {
    const value = service();

    const result = await runAsPrincipal(() => value.service.acknowledgeDelivery(
      SESSION,
      TURN,
      ARTIFACT,
      { deliveryId: DELIVERY, audioSha256: AUDIO_SHA },
    ));

    expect(result).toEqual({
      ok: true,
      value: {
        controlReference: {
          turnId: TURN,
          acknowledgementId: DELIVERY,
          contextRevision: 7,
          contextDigest: CONTEXT,
        },
      },
    });
    expect(value.repo.acknowledgeDelivery).toHaveBeenCalledWith(expect.objectContaining({
      companyId: COMPANY,
      subjectHash: SUBJECT,
      deliveryId: DELIVERY,
      evidenceHmac: artifact().evidenceHmac,
    }));
  });

  it('refuse un ACK dont le hash ne correspond pas avant toute mutation', async () => {
    const value = service();

    const result = await runAsPrincipal(() => value.service.acknowledgeDelivery(
      SESSION,
      TURN,
      ARTIFACT,
      { deliveryId: DELIVERY, audioSha256: '0'.repeat(64) },
    ));

    expect(result).toMatchObject({ ok: false, error: { kind: 'not_found' } });
    expect(value.repo.acknowledgeDelivery).not.toHaveBeenCalled();
  });

  it('annule immédiatement avec identité tenant/sujet et motif barge-in allowlisté', async () => {
    const value = service();

    const result = await runAsPrincipal(() => value.service.cancel(
      SESSION,
      TURN,
      ARTIFACT,
      { cancellationId: CANCELLATION, reason: 'barge_in' },
    ));

    expect(result).toEqual({ ok: true, value: undefined });
    expect(value.repo.cancel).toHaveBeenCalledWith({
      companyId: COMPANY,
      subjectHash: SUBJECT,
      sessionId: SESSION,
      turnId: TURN,
      artifactId: ARTIFACT,
      cancellationId: CANCELLATION,
      reason: 'barge_in',
    });
  });

  it('certifie la compatibilité du vérificateur avec la preuve du publisher', () => {
    expect(verifyRealtimeSpeechDeliveryProof(artifact(), {
      proofSecret: PROOF_SECRET,
      proofKeyVersion: 1,
    })).toBe(true);
    expect(verifyRealtimeSpeechDeliveryProof(artifact({ contextRevision: 8 }), {
      proofSecret: PROOF_SECRET,
      proofKeyVersion: 1,
    })).toBe(false);
  });
});
