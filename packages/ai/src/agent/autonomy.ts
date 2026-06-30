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

/** Décide si un outil doit être confirmé avant exécution, selon son profil et le mode d'autonomie. */
export function requiresConfirmation(tool: { mutating: boolean; outbound: boolean }, mode: AgentAutonomy): boolean {
  if (!tool.mutating) return false; // lecture : jamais
  if (mode === 'auto') return false;
  if (mode === 'confirm_all') return true;
  return tool.outbound; // confirm_outbound
}
