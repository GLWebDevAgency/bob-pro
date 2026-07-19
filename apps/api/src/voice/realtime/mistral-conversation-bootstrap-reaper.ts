export const MISTRAL_CONVERSATION_BOOTSTRAP_REAPER_ROLE =
  'bob_mistral_bootstrap_reaper' as const;

export interface MistralConversationBootstrapPurgeBatchResult {
  /** Nombre de racines bootstrap supprimées (missions complètes + bootstraps jamais consommés). */
  readonly purgedCount: number;
  readonly missionsPurged: number;
  readonly bootstrapsPurged: number;
  readonly resumeTicketsPurged: number;
  readonly commandsPurged: number;
  readonly outboxEventsPurged: number;
  readonly lockSkipped: number;
  readonly admissionBlocked: number;
  readonly invariantBlocked: number;
  readonly terminalizationBlocked: boolean;
  readonly eligibleRootsRemain: boolean;
  readonly expiredRowsRemain: boolean;
}

/**
 * Port d'infrastructure étroit : aucun tenant n'est accepté en entrée, car la fonction SQL et le
 * rôle NOLOGIN dédié constituent l'unique autorité de purge multi-tenant.
 */
export interface MistralConversationBootstrapReaperPort {
  /** Prouve au boot le rôle effectif, FORCE-RLS et le jeu minimal de privilèges. */
  assertReady(): Promise<void>;
  /** Exécute un batch borné par la fonction SQL certifiée, jamais un DELETE applicatif. */
  purgeBatch(batchLimit: number): Promise<MistralConversationBootstrapPurgeBatchResult>;
}

export class MistralConversationBootstrapReaperUnavailableError extends Error {
  constructor() {
    super('Mistral conversation bootstrap reaper authority is unavailable.');
    this.name = 'MistralConversationBootstrapReaperUnavailableError';
  }
}
