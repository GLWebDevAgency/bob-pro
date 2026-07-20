import type { RealtimeSpeechCancellationReason } from './realtime-speech-publisher';

export type RealtimeSpeechDeliveryState =
  | 'rendering'
  | 'ready'
  | 'delivered'
  | 'cancelled'
  | 'failed';

/**
 * Projection minimale de l'artefact durable. Elle ne contient volontairement ni parole, ni
 * transcription, ni token de stockage. Les MAC sont nécessaires pour vérifier la preuve avant
 * de signer un téléchargement privé.
 */
export interface RealtimeSpeechDeliveryArtifact {
  readonly artifactId: string;
  readonly companyId: string;
  readonly subjectHash: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly sequence: number;
  readonly state: RealtimeSpeechDeliveryState;
  readonly classification: 'fixed_safe' | 'dynamic_sensitive';
  readonly source: 'preapproved_static' | 'synthesized_audited' | null;
  readonly contextRevision: number;
  readonly contextDigest: string;
  readonly sidebandOwnerEpoch: number;
  readonly sidebandOwnerTokenHash: string;
  readonly storageKey: string | null;
  readonly storageExpiresAt: Date | null;
  readonly mimeType: 'audio/mpeg' | 'audio/wav' | null;
  readonly byteLength: number | null;
  readonly durationMs: number | null;
  readonly canonicalSpeechHmac: string;
  readonly auditTranscriptHmac: string | null;
  readonly factsHmac: string;
  readonly evidenceHmac: string | null;
  readonly audioSha256: string | null;
  readonly proofKeyVersion: number | null;
  readonly synthesisAdapterId: string | null;
  readonly synthesisTrustDomain: string | null;
  readonly auditAdapterId: string | null;
  readonly auditTrustDomain: string | null;
  readonly objectPurgedAt: Date | null;
  readonly deliveryId: string | null;
  readonly cancellationId: string | null;
  readonly cancellationReasonCode: string | null;
  readonly failureReasonCode: string | null;
  readonly version: number;
  /** Fence calculé par la base contre le lease actif, le contexte appliqué et l'owner exact. */
  readonly fenceCurrent: boolean;
  /** Horloge DB de la lecture ; ne dépend pas de l'horloge du pod. */
  readonly databaseNow: Date;
}

export type RealtimeSpeechDeliveryReadResult =
  | { readonly status: 'none' }
  | { readonly status: 'found'; readonly artifact: RealtimeSpeechDeliveryArtifact }
  | { readonly status: 'unavailable' };

export interface RealtimeSpeechReadyFenceInput {
  readonly companyId: string;
  readonly subjectHash: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly artifactId: string;
  readonly version: number;
  readonly evidenceHmac: string;
  readonly audioSha256: string;
  readonly storageKey: string;
}

export type RealtimeSpeechReadyFenceResult = 'current' | 'terminal' | 'unavailable';

export interface RealtimeSpeechDeliveryMutationInput extends RealtimeSpeechReadyFenceInput {
  readonly deliveryId: string;
}

export type RealtimeSpeechDeliveryMutationResult =
  | {
      readonly status: 'delivered';
      readonly idempotent: boolean;
      readonly controlCurrent: boolean;
      readonly contextRevision: number;
      readonly contextDigest: string;
    }
  | { readonly status: 'not_found' | 'terminal' | 'conflict' | 'unavailable' };

export interface RealtimeSpeechCancellationMutationInput {
  readonly companyId: string;
  readonly subjectHash: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly artifactId: string;
  readonly cancellationId: string;
  readonly reason: RealtimeSpeechCancellationReason;
}

export type RealtimeSpeechCancellationMutationResult =
  | { readonly status: 'cancelled'; readonly idempotent: boolean }
  | { readonly status: 'not_found' | 'terminal' | 'conflict' | 'unavailable' };

export interface RealtimeSpeechDeliveryRepositoryPort {
  readNext(input: {
    readonly companyId: string;
    readonly subjectHash: string;
    readonly sessionId: string;
    readonly afterSequence: number;
  }): Promise<RealtimeSpeechDeliveryReadResult>;
  readExact(input: {
    readonly companyId: string;
    readonly subjectHash: string;
    readonly sessionId: string;
    readonly turnId: string;
    readonly artifactId: string;
  }): Promise<RealtimeSpeechDeliveryReadResult>;
  /** Cinquième fence après signature de l'URL, juste avant sa publication au mobile. */
  validateReadyFence(input: RealtimeSpeechReadyFenceInput): Promise<RealtimeSpeechReadyFenceResult>;
  acknowledgeDelivery(
    input: RealtimeSpeechDeliveryMutationInput,
  ): Promise<RealtimeSpeechDeliveryMutationResult>;
  cancel(
    input: RealtimeSpeechCancellationMutationInput,
  ): Promise<RealtimeSpeechCancellationMutationResult>;
}

/** Le mode local ne simule jamais une autorité acoustique durable. */
export class DisabledRealtimeSpeechDeliveryRepository implements RealtimeSpeechDeliveryRepositoryPort {
  async readNext(): Promise<RealtimeSpeechDeliveryReadResult> {
    return { status: 'none' };
  }

  async validateReadyFence(): Promise<RealtimeSpeechReadyFenceResult> {
    return 'terminal';
  }

  async readExact(): Promise<RealtimeSpeechDeliveryReadResult> {
    return { status: 'none' };
  }

  async acknowledgeDelivery(): Promise<RealtimeSpeechDeliveryMutationResult> {
    return { status: 'not_found' };
  }

  async cancel(): Promise<RealtimeSpeechCancellationMutationResult> {
    return { status: 'not_found' };
  }
}
