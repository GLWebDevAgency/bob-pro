/**
 * Jeton d'injection runtime isolé du harness in-memory.
 *
 * Les modules de production ne doivent pas charger `persistence.ts`, car ce fichier contient les
 * doubles de test et leurs fixtures explicites. Les imports de `Persistence` restent type-only et
 * sont donc effacés du JavaScript produit.
 */
export const PERSISTENCE = Symbol('PERSISTENCE');
