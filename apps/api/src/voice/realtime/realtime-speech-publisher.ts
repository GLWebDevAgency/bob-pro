import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createCanonicalSpeechEnvelope } from '@bob/ai';
import {
  createRealtimeSpeechContentProof,
  createRealtimeSpeechProof,
} from './realtime-speech-proof';
import {
  RealtimeSpeechRenderer,
  REALTIME_SPEECH_RENDER_LIMITS,
  realtimeSpeechEnvelopeDigests,
  type RealtimeSpeechArtifactMetadata,
  type RealtimeSpeechContextVersion,
  type RealtimeSpeechRejectionCode,
} from './realtime-speech-renderer';
import {
  buildRealtimeSpeechStorageKey,
  type RealtimeSpeechStoragePort,
} from './realtime-speech-storage';

const SHA256_HEX = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const COMPANY_ID = /^[A-Za-z0-9-]{1,64}$/u;
const MAX_SEGMENT_INDEX = 127;
const POSTGRES_INT_MAX = 2_147_483_647;
const FOURTH_FENCE_TIMEOUT_MS = 2_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const FINALIZE_RECONCILIATION_DELAYS_MS = [0, 25, 100] as const;

export type RealtimeSpeechCancellationReason =
  | 'barge_in'
  | 'user_cancel'
  | 'context_changed'
  | 'session_end'
  | 'superseded'
  | 'playback_error';

export interface RealtimeSpeechArtifactClaimInput {
  readonly companyId: string;
  readonly subjectHash: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly segmentIndex: number;
  readonly candidateArtifactId: string;
  readonly contextRevision: number;
  readonly contextDigest: string;
  /** Hash du token du sideband qui demande ce claim ; lie toute la vie de l'artefact à son epoch. */
  readonly sidebandOwnerTokenHash: string;
  readonly classification: RealtimeSpeechArtifactMetadata['classification'];
  readonly canonicalSpeechHmac: string;
  readonly factsHmac: string;
  readonly renderTokenHash: string;
}

export type RealtimeSpeechArtifactClaim =
  | { readonly status: 'claimed'; readonly artifactId: string; readonly sequence: number }
  | { readonly status: 'ready'; readonly artifactId: string; readonly sequence: number }
  | { readonly status: 'busy' }
  | { readonly status: 'terminal' }
  | { readonly status: 'unavailable' };

export interface RealtimeSpeechArtifactReadyInput {
  readonly companyId: string;
  readonly subjectHash: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly artifactId: string;
  readonly sequence: number;
  readonly renderTokenHash: string;
  readonly contextRevision: number;
  readonly contextDigest: string;
  readonly sidebandOwnerTokenHash: string;
  readonly classification: RealtimeSpeechArtifactMetadata['classification'];
  readonly source: RealtimeSpeechArtifactMetadata['source'];
  readonly storageKey: string;
  readonly mimeType: RealtimeSpeechArtifactMetadata['mimeType'];
  readonly byteLength: number;
  readonly durationMs: number;
  readonly canonicalSpeechHmac: string;
  readonly factsHmac: string;
  readonly auditTranscriptHmac: string | null;
  readonly evidenceHmac: string;
  readonly audioSha256: string;
  readonly proofKeyVersion: number;
  readonly synthesisAdapterId: string;
  readonly synthesisTrustDomain: string;
  readonly auditAdapterId: string | null;
  readonly auditTrustDomain: string | null;
}

export type RealtimeSpeechArtifactFinalizeResult =
  | { readonly status: 'ready' }
  | { readonly status: 'stale_context' | 'cancelled' | 'lost_claim' | 'unavailable' };

export interface RealtimeSpeechArtifactRepositoryPort {
  /** Réserve ou reprend un segment sous un token hashé, et attribue sa séquence session globale. */
  claimRender(input: RealtimeSpeechArtifactClaimInput): Promise<RealtimeSpeechArtifactClaim>;
  /** Le repository relit le lease et applique le quatrième fence dans la même transaction que le CAS. */
  finalizeReady(input: RealtimeSpeechArtifactReadyInput): Promise<RealtimeSpeechArtifactFinalizeResult>;
  failRender(input: {
    readonly companyId: string;
    readonly sessionId: string;
    readonly turnId: string;
    readonly artifactId: string;
    readonly renderTokenHash: string;
    readonly sidebandOwnerTokenHash: string;
    readonly reasonCode: string;
  }): Promise<void>;
  cancel(input: {
    readonly companyId: string;
    readonly sessionId: string;
    readonly turnId: string;
    readonly artifactId: string;
    readonly cancellationId: string;
    readonly sidebandOwnerTokenHash: string;
    readonly reason: RealtimeSpeechCancellationReason;
  }): Promise<void>;
}

export interface RealtimeSpeechPublisherInput {
  readonly companyId: string;
  readonly subjectHash: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly segmentIndex: number;
  readonly canonicalSpeech: string;
  readonly contextRevision: number;
  readonly contextDigest: string;
  readonly sidebandOwnerTokenHash: string;
  readonly signal: AbortSignal;
  readonly abortReason?: RealtimeSpeechCancellationReason;
  readonly revalidateContext: (signal: AbortSignal) => Promise<RealtimeSpeechContextVersion>;
}

export type RealtimeSpeechPublishOutcome =
  | { readonly status: 'ready'; readonly artifactId: string; readonly sequence: number }
  | { readonly status: 'already_ready'; readonly artifactId: string; readonly sequence: number }
  | { readonly status: 'busy' | 'terminal' }
  | { readonly status: 'rejected'; readonly code: RealtimeSpeechRejectionCode | 'PERSISTENCE_REJECTED' }
  | { readonly status: 'aborted' }
  | { readonly status: 'unavailable'; readonly stage: 'claim' | 'storage' | 'context' | 'finalize' };

export interface RealtimeSpeechPublisherDependencies {
  readonly renderer: RealtimeSpeechRenderer;
  readonly repository: RealtimeSpeechArtifactRepositoryPort;
  readonly storage: RealtimeSpeechStoragePort;
  readonly proofSecret: string;
  readonly proofKeyVersion: number;
  readonly entropy?: {
    artifactId(): string;
    token(): string;
    cancellationId(): string;
  };
  /** Injecté uniquement dans les tests ; la production conserve le backoff borné. */
  readonly reconciliationPause?: (milliseconds: number) => Promise<void>;
}

const secureEntropy = Object.freeze({
  artifactId: randomUUID,
  token: () => randomBytes(32).toString('base64url'),
  cancellationId: randomUUID,
});

function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function validInput(input: RealtimeSpeechPublisherInput): boolean {
  return COMPANY_ID.test(input.companyId)
    && SHA256_HEX.test(input.subjectHash)
    && UUID.test(input.sessionId)
    && UUID.test(input.turnId)
    && Number.isSafeInteger(input.segmentIndex)
    && input.segmentIndex >= 0
    && input.segmentIndex <= MAX_SEGMENT_INDEX
    && typeof input.canonicalSpeech === 'string'
    && input.canonicalSpeech.length > 0
    && Buffer.byteLength(input.canonicalSpeech, 'utf8') <= REALTIME_SPEECH_RENDER_LIMITS.maxTextUtf8Bytes
    && Number.isSafeInteger(input.contextRevision)
    && input.contextRevision >= 1
    && input.contextRevision <= POSTGRES_INT_MAX
    && SHA256_HEX.test(input.contextDigest)
    && SHA256_HEX.test(input.sidebandOwnerTokenHash)
    && input.signal instanceof AbortSignal
    && typeof input.revalidateContext === 'function';
}

async function boundedContextFence(
  input: RealtimeSpeechPublisherInput,
): Promise<'current' | 'stale' | 'aborted' | 'unavailable'> {
  if (input.signal.aborted) return 'aborted';
  const controller = new AbortController();
  let settleBoundary: ((value: 'aborted' | 'unavailable') => void) | null = null;
  const relayAbort = (): void => controller.abort();
  input.signal.addEventListener('abort', relayAbort, { once: true });
  const boundary = new Promise<'aborted' | 'unavailable'>((resolve) => {
    settleBoundary = resolve;
  });
  const onAbort = (): void => settleBoundary?.('aborted');
  input.signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    controller.abort();
    settleBoundary?.('unavailable');
  }, FOURTH_FENCE_TIMEOUT_MS);
  const checked = Promise.resolve()
    .then(() => input.revalidateContext(controller.signal))
    .then((current): 'current' | 'stale' => (
      current.contextRevision === input.contextRevision
        && current.contextDigest === input.contextDigest
        ? 'current'
        : 'stale'
    ))
    .catch((): 'aborted' | 'unavailable' => (
      input.signal.aborted ? 'aborted' : 'unavailable'
    ));
  try {
    return await Promise.race([checked, boundary]);
  } finally {
    clearTimeout(timer);
    input.signal.removeEventListener('abort', relayAbort);
    input.signal.removeEventListener('abort', onAbort);
  }
}

export class RealtimeSpeechPublisher {
  private readonly entropy: NonNullable<RealtimeSpeechPublisherDependencies['entropy']>;
  private readonly reconciliationPause: (milliseconds: number) => Promise<void>;

  constructor(private readonly dependencies: RealtimeSpeechPublisherDependencies) {
    if (Buffer.byteLength(dependencies.proofSecret, 'utf8') < 32
      || !Number.isSafeInteger(dependencies.proofKeyVersion)
      || dependencies.proofKeyVersion < 1
      || dependencies.proofKeyVersion > POSTGRES_INT_MAX) {
      throw new Error('Invalid realtime speech publisher proof configuration.');
    }
    this.entropy = dependencies.entropy ?? secureEntropy;
    this.reconciliationPause = dependencies.reconciliationPause
      ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async publish(input: RealtimeSpeechPublisherInput): Promise<RealtimeSpeechPublishOutcome> {
    if (!validInput(input)) return { status: 'rejected', code: 'PERSISTENCE_REJECTED' };
    if (input.signal.aborted) return { status: 'aborted' };

    let envelope: ReturnType<typeof createCanonicalSpeechEnvelope>;
    try {
      envelope = createCanonicalSpeechEnvelope(input.canonicalSpeech);
    } catch {
      return { status: 'rejected', code: 'INVALID_ENVELOPE' };
    }
    const contentDigests = realtimeSpeechEnvelopeDigests(envelope);
    const contentProof = createRealtimeSpeechContentProof({
      secret: this.dependencies.proofSecret,
      companyId: input.companyId,
      textSha256: contentDigests.textSha256,
      factsSha256: contentDigests.factsSha256,
      auditTranscriptSha256: null,
    });
    const candidateArtifactId = this.entropy.artifactId();
    const renderToken = this.entropy.token();
    if (!UUID.test(candidateArtifactId) || renderToken.length < 32 || renderToken.length > 128) {
      return { status: 'rejected', code: 'PERSISTENCE_REJECTED' };
    }
    const renderTokenHash = tokenHash(renderToken);

    let claim: RealtimeSpeechArtifactClaim;
    try {
      claim = await this.dependencies.repository.claimRender({
        companyId: input.companyId,
        subjectHash: input.subjectHash,
        sessionId: input.sessionId,
        turnId: input.turnId,
        segmentIndex: input.segmentIndex,
        candidateArtifactId,
        contextRevision: input.contextRevision,
        contextDigest: input.contextDigest,
        sidebandOwnerTokenHash: input.sidebandOwnerTokenHash,
        classification: envelope.classification,
        canonicalSpeechHmac: contentProof.canonicalSpeechHmac,
        factsHmac: contentProof.factsHmac,
        renderTokenHash,
      });
    } catch {
      return { status: 'unavailable', stage: 'claim' };
    }
    if (claim.status === 'unavailable') return { status: 'unavailable', stage: 'claim' };
    if (claim.status === 'busy' || claim.status === 'terminal') return { status: claim.status };
    if (claim.status === 'ready') {
      return { status: 'already_ready', artifactId: claim.artifactId, sequence: claim.sequence };
    }
    if (!UUID.test(claim.artifactId)
      || !Number.isSafeInteger(claim.sequence)
      || claim.sequence < 1
      || claim.sequence > POSTGRES_INT_MAX) {
      return { status: 'rejected', code: 'PERSISTENCE_REJECTED' };
    }

    const binding = {
      sessionId: input.sessionId,
      turnId: input.turnId,
      contextRevision: input.contextRevision,
      contextDigest: input.contextDigest,
    };
    const rendered = await this.dependencies.renderer.render({
      envelope,
      binding,
      signal: input.signal,
      revalidateContext: input.revalidateContext,
    });
    if (rendered.status === 'aborted') {
      await this.cancelClaim(input, claim.artifactId);
      return { status: 'aborted' };
    }
    if (rendered.status === 'rejected') {
      await this.failClaim(input, claim.artifactId, renderTokenHash, rendered.code);
      return rendered;
    }

    const storageKey = buildRealtimeSpeechStorageKey({
      companyId: input.companyId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      artifactId: claim.artifactId,
    });
    try {
      const stored = await this.dependencies.storage.upload({
        companyId: input.companyId,
        key: storageKey,
        bytes: rendered.artifact.audioBytes,
        mimeType: rendered.artifact.metadata.mimeType,
        signal: input.signal,
      });
      if (stored.key !== storageKey
        || stored.sizeBytes !== rendered.artifact.metadata.byteLength
        || stored.mimeType !== rendered.artifact.metadata.mimeType
        || stored.audioSha256 !== rendered.artifact.metadata.audioSha256) {
        await this.cleanupStorage(input.companyId, storageKey);
        await this.failClaim(input, claim.artifactId, renderTokenHash, 'STORAGE_INTEGRITY');
        return { status: 'unavailable', stage: 'storage' };
      }
    } catch {
      await this.cleanupStorage(input.companyId, storageKey);
      if (input.signal.aborted) {
        await this.cancelClaim(input, claim.artifactId);
        return { status: 'aborted' };
      }
      await this.failClaim(input, claim.artifactId, renderTokenHash, 'STORAGE_FAILED');
      return { status: 'unavailable', stage: 'storage' };
    }

    const fourthFence = await boundedContextFence(input);
    if (fourthFence !== 'current') {
      await this.cleanupStorage(input.companyId, storageKey);
      if (fourthFence === 'aborted' || fourthFence === 'stale') {
        await this.cancelClaim(
          { ...input, abortReason: fourthFence === 'stale' ? 'context_changed' : input.abortReason },
          claim.artifactId,
        );
        return fourthFence === 'aborted' ? { status: 'aborted' } : { status: 'terminal' };
      }
      await this.failClaim(input, claim.artifactId, renderTokenHash, 'CONTEXT_UNAVAILABLE');
      return { status: 'unavailable', stage: 'context' };
    }

    let proof: ReturnType<typeof createRealtimeSpeechProof>;
    try {
      proof = createRealtimeSpeechProof({
        secret: this.dependencies.proofSecret,
        keyVersion: this.dependencies.proofKeyVersion,
        companyId: input.companyId,
        subjectHash: input.subjectHash,
        artifactId: claim.artifactId,
        sequence: claim.sequence,
        storageKey,
        metadata: rendered.artifact.metadata,
      });
      if (proof.canonicalSpeechHmac !== contentProof.canonicalSpeechHmac
        || proof.factsHmac !== contentProof.factsHmac) {
        throw new Error('realtime_speech_content_proof_changed');
      }
    } catch {
      await this.cleanupStorage(input.companyId, storageKey);
      await this.failClaim(input, claim.artifactId, renderTokenHash, 'PROOF_FAILED');
      return { status: 'rejected', code: 'PERSISTENCE_REJECTED' };
    }

    const metadata = rendered.artifact.metadata;
    const readyInput: RealtimeSpeechArtifactReadyInput = {
      companyId: input.companyId,
      subjectHash: input.subjectHash,
      sessionId: input.sessionId,
      turnId: input.turnId,
      artifactId: claim.artifactId,
      sequence: claim.sequence,
      renderTokenHash,
      sidebandOwnerTokenHash: input.sidebandOwnerTokenHash,
      contextRevision: input.contextRevision,
      contextDigest: input.contextDigest,
      classification: metadata.classification,
      source: metadata.source,
      storageKey,
      mimeType: metadata.mimeType,
      byteLength: metadata.byteLength,
      durationMs: metadata.estimatedDurationMs,
      canonicalSpeechHmac: proof.canonicalSpeechHmac,
      factsHmac: proof.factsHmac,
      auditTranscriptHmac: proof.auditTranscriptHmac,
      evidenceHmac: proof.evidenceHmac,
      audioSha256: metadata.audioSha256,
      proofKeyVersion: proof.proofKeyVersion,
      synthesisAdapterId: metadata.synthesisAdapterId,
      synthesisTrustDomain: metadata.synthesisTrustDomain,
      auditAdapterId: metadata.auditAdapterId,
      auditTrustDomain: metadata.auditTrustDomain,
    };
    const finalized = await this.finalizeWithReconciliation(readyInput);
    if (finalized.status !== 'ready') {
      // Un timeout peut survenir APRES le COMMIT. Détruire ici l'objet créerait une ligne ready
      // pointant vers du vide. L'objet reste donc intact jusqu'à preuve DB négative ou au reaper.
      if (finalized.status === 'unavailable') {
        return { status: 'unavailable', stage: 'finalize' };
      }
      await this.cleanupStorage(input.companyId, storageKey);
      if (finalized.status === 'stale_context' || finalized.status === 'cancelled') {
        await this.cancelClaim(input, claim.artifactId);
        return { status: 'terminal' };
      }
      return { status: 'unavailable', stage: 'finalize' };
    }
    return { status: 'ready', artifactId: claim.artifactId, sequence: claim.sequence };
  }

  private async finalizeWithReconciliation(
    input: RealtimeSpeechArtifactReadyInput,
  ): Promise<RealtimeSpeechArtifactFinalizeResult> {
    for (const delayMs of FINALIZE_RECONCILIATION_DELAYS_MS) {
      if (delayMs > 0) await this.reconciliationPause(delayMs);
      try {
        const result = await this.dependencies.repository.finalizeReady(input);
        if (result.status !== 'unavailable') return result;
      } catch {
        // Même résultat qu'un ACK perdu : relire par le même CAS idempotent exact.
      }
    }
    return { status: 'unavailable' };
  }

  private async failClaim(
    input: RealtimeSpeechPublisherInput,
    artifactId: string,
    renderTokenHash: string,
    reasonCode: string,
  ): Promise<void> {
    await this.dependencies.repository.failRender({
      companyId: input.companyId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      artifactId,
      renderTokenHash,
      sidebandOwnerTokenHash: input.sidebandOwnerTokenHash,
      reasonCode: reasonCode
        .toLowerCase()
        .replace(/[^a-z0-9_]/gu, '')
        .slice(0, 64) || 'unknown',
    }).catch(() => undefined);
  }

  private async cancelClaim(input: RealtimeSpeechPublisherInput, artifactId: string): Promise<void> {
    const cancellationId = this.entropy.cancellationId();
    if (!UUID.test(cancellationId)) return;
    await this.dependencies.repository.cancel({
      companyId: input.companyId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      artifactId,
      cancellationId,
      sidebandOwnerTokenHash: input.sidebandOwnerTokenHash,
      reason: input.abortReason ?? 'superseded',
    }).catch(() => undefined);
  }

  private async cleanupStorage(companyId: string, storageKey: string): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CLEANUP_TIMEOUT_MS);
    try {
      await this.dependencies.storage.delete({ companyId, key: storageKey, signal: controller.signal });
    } catch {
      // Le reaper durable reprend la même clé déterministe ; ne jamais masquer le résultat métier.
    } finally {
      clearTimeout(timer);
    }
  }
}
