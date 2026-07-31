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

  clear(): void {
    this.commandIds.clear();
  }
}
