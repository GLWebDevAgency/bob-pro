import type { Prisma } from '@prisma/client';

export type MistralConversationCompletionResult =
  | { readonly status: 'opened' }
  | { readonly status: 'context_stale' | 'not_found' | 'unavailable' };

export interface MistralConversationCompletionInput {
  readonly companyId: string;
  readonly subjectHash: string;
  readonly subjectKeyVersion: number;
  readonly sessionHandle: string;
  readonly turnId: string;
  readonly missionConnectionEpoch: number;
  readonly cancellationGeneration: number;
  readonly contextRevision: number;
  readonly contextDigest: string;
  readonly authorizationHandle: string;
  readonly stagedDeliveryHandle: string;
  readonly signal: AbortSignal;
}

/**
 * Port volontairement transactionnel : l'implémentation doit revalider la capacité d'autorisation
 * puis rendre l'artefact stagé ouvrable en utilisant exclusivement `tx`. Aucun appel réseau n'est
 * autorisé ici ; une erreur lève ou retourne `unavailable`, ce qui fait rollback de toute la
 * completion (snapshot, outbox, ledger et ouverture de delivery).
 */
export interface MistralConversationCompletionTransactionPort {
  authorizeAndOpen(
    tx: Prisma.TransactionClient,
    input: MistralConversationCompletionInput,
  ): Promise<MistralConversationCompletionResult>;
}
