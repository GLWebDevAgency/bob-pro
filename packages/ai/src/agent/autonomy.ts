/**
 * Niveau d'autonomie de Bob (réglable par l'utilisateur, réservé aux offres avec assistant IA).
 * - confirm_all      : toute action modifiante demande confirmation.
 * - confirm_outbound : (défaut) actions internes réversibles directes ; confirmation pour le sortant/irréversible.
 * - auto             : toutes les actions sont exécutées sans confirmation.
 */
export type AgentAutonomy = 'confirm_all' | 'confirm_outbound' | 'auto';

export const DEFAULT_AUTONOMY: AgentAutonomy = 'confirm_outbound';

export const AUTONOMY_LABELS: Record<AgentAutonomy, string> = {
  confirm_all: 'Toujours confirmer',
  confirm_outbound: 'Confirmer l’envoi au client (recommandé)',
  auto: 'Tout exécuter (réversible)',
};

/**
 * Plancher de sécurité INVIOLABLE : actions confirmées MÊME en autonomie 'auto'. = envoi vers un tiers
 * (`outbound`) OU action irréversible légale/fiscale / purge (`safetyFloor`). L'encaissement (réversible,
 * entrant) n'en fait PAS partie. Rend « vendre l'auto pas cher » sûr : l'auto n'accélère que l'interne réversible.
 */
export function isSafetyFloor(tool: { outbound: boolean; safetyFloor?: boolean }): boolean {
  return tool.outbound || tool.safetyFloor === true;
}

/** Décide si un outil doit être confirmé avant exécution, selon son profil et le mode d'autonomie. */
export function requiresConfirmation(
  tool: { mutating: boolean; outbound: boolean; safetyFloor?: boolean },
  mode: AgentAutonomy,
): boolean {
  if (!tool.mutating) return false; // lecture : jamais
  if (isSafetyFloor(tool)) return true; // plancher : toujours, même en 'auto'
  if (mode === 'confirm_all') return true;
  return false; // interne réversible non-sensible (ex. encaissement) : direct en confirm_outbound et auto
}
