/**
 * Registre idempotent lié au principal authentifié, au-dessus du routeur.
 *
 * Une réponse HTTP peut être perdue après commit. La surface est alors démontée le temps de la
 * relecture causale ; recréer un commandId au remontage transformerait un retry en nouvelle
 * commande. Ce registre borné survit aux routes et ne contient que les empreintes canoniques
 * construites par les coordinateurs — jamais de capability ni de secret.
 */
export class AgentMissionCommandIdRegistry {
  private readonly commandIds = new Map<string, string>();

  getOrCreate(key: string, createCommandId: () => string): string {
    const existing = this.commandIds.get(key);
    if (existing !== undefined) return existing;
    const commandId = createCommandId();
    if (this.commandIds.size >= 128) {
      const oldest = this.commandIds.keys().next().value;
      if (typeof oldest === 'string') this.commandIds.delete(oldest);
    }
    this.commandIds.set(key, commandId);
    return commandId;
  }

  /**
   * Libère la mémoïsation d'un geste dont le REÇU est arrivé (U1-f §3). Tant qu'aucun reçu n'est
   * revenu, la clé DOIT survivre : c'est elle qui fait qu'un retry après coupure réseau rejoue le
   * MÊME `commandId`, donc le même run, au lieu d'en semer un second. Une fois le reçu obtenu, la
   * garder serait l'erreur inverse : le geste suivant sur la même cible rejouerait un run déjà
   * terminé, et l'artisan resterait devant une demande close sans pouvoir en rouvrir une.
   */
  release(key: string): void {
    this.commandIds.delete(key);
  }

  clear(): void {
    this.commandIds.clear();
  }
}
