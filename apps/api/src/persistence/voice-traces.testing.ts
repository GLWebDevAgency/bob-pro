import type {
  VoiceTraceCompleteTurn,
  VoiceTraceOpenTurn,
  VoiceTraceRepository,
} from './voice-traces';

/** Trace telle qu'elle serait relue en base : l'ouverture fusionnée avec la complétion. */
export type StoredVoiceTrace = VoiceTraceOpenTurn &
  Partial<VoiceTraceCompleteTurn> & { readonly companyId: string };

/** Double déterministe réservé au harness de tests API. */
export class InMemoryVoiceTraceRepository implements VoiceTraceRepository {
  private readonly rows = new Map<string, StoredVoiceTrace>();

  async openTurn(companyId: string, turn: VoiceTraceOpenTurn): Promise<void> {
    const unique = `${companyId}:${turn.sessionId}:${turn.turnIndex}`;
    // Reproduit la contrainte d'unicité (companyId, sessionId, turnIndex) de la table.
    for (const row of this.rows.values()) {
      if (`${row.companyId}:${row.sessionId}:${row.turnIndex}` === unique) return;
    }
    this.rows.set(turn.id, { ...turn, companyId });
  }

  async completeTurn(companyId: string, turn: VoiceTraceCompleteTurn): Promise<void> {
    const existing = this.rows.get(turn.id);
    // Un identifiant inconnu est ignoré : jamais de ligne recréée sans son ouverture.
    if (!existing || existing.companyId !== companyId) return;
    this.rows.set(turn.id, { ...existing, ...turn });
  }

  async purgeExpired(input: {
    companyId: string;
    before: string;
    limit: number;
  }): Promise<number> {
    const expired = [...this.rows.values()]
      .filter(
        (row) =>
          row.companyId === input.companyId &&
          Date.parse(row.retentionExpiresAt) <= Date.parse(input.before),
      )
      .sort(
        (left, right) =>
          Date.parse(left.retentionExpiresAt) - Date.parse(right.retentionExpiresAt) ||
          left.id.localeCompare(right.id),
      )
      .slice(0, Math.max(0, input.limit));
    for (const row of expired) this.rows.delete(row.id);
    return expired.length;
  }

  /** Lecture de test uniquement — ordonnée comme le script de diagnostic les affiche. */
  list(): StoredVoiceTrace[] {
    return [...this.rows.values()].sort(
      (left, right) =>
        left.sessionId.localeCompare(right.sessionId) || left.turnIndex - right.turnIndex,
    );
  }
}
