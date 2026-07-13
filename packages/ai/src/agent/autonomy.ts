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

import { type RiskTier } from '../tools/tool';

/** Profil minimal d'un outil pour les décisions d'autonomie (structurel, pas de couplage au Tool complet). */
export type ToolRiskProfile = { mutating: boolean; outbound: boolean; safetyFloor?: boolean; riskTier?: RiskTier };

/** Paliers de risque au PLANCHER de sécurité : confirmation exigée même en 'auto'. */
export const FLOOR_TIERS: readonly RiskTier[] = ['accounting', 'outbound', 'fiscal'];

/**
 * Palier de risque effectif d'un outil. Utilise `riskTier` s'il est fourni, sinon le DÉRIVE des booléens
 * historiques (rétro-compatibilité) : lecture -> read ; sortant -> outbound ; sensible -> accounting ;
 * sinon interne réversible.
 */
export function riskTierOf(tool: ToolRiskProfile): RiskTier {
  if (tool.riskTier) return tool.riskTier;
  if (!tool.mutating) return 'read';
  if (tool.outbound) return 'outbound';
  if (tool.safetyFloor) return 'accounting';
  return 'reversible';
}

/**
 * Plancher de sécurité INVIOLABLE : actions confirmées MÊME en autonomie 'auto'. Un outil est au plancher
 * si son palier de risque effectif est accounting (impacte les livres), outbound (envoi tiers) ou fiscal
 * (irréversible légal/fiscal, purge). Rend « vendre l'auto pas cher » sûr : l'auto n'accélère que l'interne réversible.
 */
export function isSafetyFloor(tool: ToolRiskProfile): boolean {
  // `safetyFloor` est un verrou explicite, indépendant du palier descriptif. Cela permet
  // notamment à une mutation interne non comptable de conserver son palier descriptif tout en
  // exigeant systématiquement un consentement lorsqu'elle n'a pas encore de commande d'annulation.
  return tool.safetyFloor === true || FLOOR_TIERS.includes(riskTierOf(tool));
}

/** Décide si un outil doit être confirmé avant exécution, selon son profil et le mode d'autonomie. */
export function requiresConfirmation(tool: ToolRiskProfile, mode: AgentAutonomy): boolean {
  if (!tool.mutating) return false; // lecture : jamais
  if (isSafetyFloor(tool)) return true; // plancher : toujours, même en 'auto'
  if (mode === 'confirm_all') return true;
  return false; // interne réversible non-sensible : direct en confirm_outbound et auto
}
