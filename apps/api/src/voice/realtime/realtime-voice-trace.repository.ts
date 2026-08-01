import type { RealtimeVoiceTraceEvent } from '@bob/core';

export interface RealtimeVoiceTraceStoredEvent {
  readonly id: string;
  readonly event: Omit<RealtimeVoiceTraceEvent, 'transcript' | 'canonicalReply'>;
  readonly eventDigest: string;
  readonly eventDigestKeyVersion: number;
  readonly encryptionKeyVersion: number | null;
  readonly transcriptCiphertext: string | null;
  readonly canonicalReplyCiphertext: string | null;
}

export type RealtimeVoiceTraceAppendOutcome =
  | { readonly status: 'inserted'; readonly eventId: string }
  | {
      readonly status: 'existing';
      readonly eventId: string;
      readonly eventDigest: string;
      readonly eventDigestKeyVersion: number;
    }
  | { readonly status: 'unavailable' };

export type RealtimeVoiceTraceDeleteReason = 'account_closure' | 'subject_erasure';

/**
 * Port serveur du journal d'observation Realtime V2.
 *
 * Le port n'accepte aucun texte clair. Le chiffrement, la validation pure et le digest sont
 * terminés avant cette frontière ; l'adapter Prisma ne peut donc pas persister accidentellement
 * le transcript ou la réponse dans une colonne non chiffrée.
 */
export interface RealtimeVoiceTraceAppendStore {
  /** Refuse l'activation si schéma, RLS, triggers ou ACL runtime ne sont pas réellement prêts. */
  assertReady(configuredKeyVersions: readonly number[]): Promise<void>;
  append(input: RealtimeVoiceTraceStoredEvent): Promise<RealtimeVoiceTraceAppendOutcome>;
}

export interface RealtimeVoiceTraceSubjectEraser {
  /** Participe obligatoirement à la transaction de clôture déjà ouverte. */
  eraseInCurrentTransaction(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly reason: RealtimeVoiceTraceDeleteReason;
  }): Promise<{ readonly deletedEvents: number; readonly deletedAccessAudits: number }>;
}

export interface RealtimeVoiceTraceRetention {
  /** Purge globale bornée ; un échec laisse les lignes dues pour le prochain sweep. */
  purgeExpired(batchLimit: number): Promise<number>;
  inspectLag(): Promise<{ readonly due: number; readonly oldestExpiredAt: string | null }>;
}

export interface RealtimeVoiceTraceAuthorities {
  readonly append: RealtimeVoiceTraceAppendStore;
  readonly eraser: RealtimeVoiceTraceSubjectEraser;
  readonly retention: RealtimeVoiceTraceRetention;
}
