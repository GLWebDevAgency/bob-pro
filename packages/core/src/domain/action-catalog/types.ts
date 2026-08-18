/**
 * Catalogue des actions publiques utilisateur — source unique (spec Jarvis §6).
 *
 * Les unions sont fermées : une action non classable ne compile pas, ce qui rend
 * « unclassified=0 » vrai par construction. Les valeurs par entrée ne peuvent pas
 * déroger vers le bas à la table normative §7.0 — c'est `policy.ts` qui la porte,
 * jamais la donnée.
 */

/** Classe de risque (spec §7). */
export type RiskClass = 'L0' | 'P1' | 'M2' | 'E3';

export const ACTION_FLAGS = [
  'external',
  'financial',
  'legal',
  'privacy_sensitive',
  'recipient_authority',
  'destructive',
  'irreversible',
  'third_party_act',
  'mass_action',
  'security_sensitive',
] as const;
export type ActionFlag = (typeof ACTION_FLAGS)[number];

/** Modes vocaux fermés (spec §2) — `closed` = écart produit temporaire. */
export const VOICE_MODES = [
  'read',
  'prepare',
  'confirmable',
  'screen_commit',
  'third_party_wait',
  'closed',
] as const;
export type VoiceMode = (typeof VOICE_MODES)[number];

/** Statut canonique d'une action (spec §6.3) — la disponibilité est décidée ailleurs (release manifest). */
export const ACTION_STATUSES = ['specified', 'implemented', 'certified', 'released'] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

/** Familles du catalogue (spec §6.1). */
export const ACTION_DOMAINS = [
  'contexte',
  'client',
  'contact',
  'communication',
  'chantier',
  'parc_intervention',
  'contrat',
  'catalogue',
  'devis',
  'facture',
  'encaissement',
  'impaye',
  'depense',
  'document',
  'gestion',
  'precompta',
  'societe_reglages',
] as const;
export type ActionDomain = (typeof ACTION_DOMAINS)[number];

/** Reçu de présentation minimal exigé avant `presented` (spec §7.0/§7.1). */
export type PresentationRequirement = 'none' | 'voice_presentation_ack' | 'screen_ack';

/** Step-up d'authentification exigé au commit (spec §7.0, liste R3 de FD-2026-0817-02). */
export type StepUpRequirement = 'none' | 'biometric_or_pin';

/** Identifiant machine-readable d'une décision fondatrice (DECISION_JARVIS_UNIVERSEL_20260817.md). */
export type FounderDecisionId = `FD-${string}`;

export interface ManualSurface {
  readonly platform: 'mobile' | 'web' | 'api';
  /** Route expo-router, chemin d'endpoint ou identifiant d'écran. */
  readonly route: string;
  /** Fichier:ligne au commit de l'inventaire. */
  readonly source: string;
}

export interface ActionCatalogEntry {
  /** kebab-case, unique par version. */
  readonly actionId: string;
  readonly version: number;
  readonly label: string;
  readonly domain: ActionDomain;
  readonly status: ActionStatus;
  readonly voiceMode: VoiceMode;
  readonly riskClass: RiskClass;
  readonly flags: readonly ActionFlag[];
  /**
   * Step-up exigé au commit. La liste R3 de FD-2026-0817-02 n'est pas entièrement
   * dérivable des flags (ex. mise en demeure, export FEC) : la valeur est explicite
   * ici et `invariants.ts` vérifie qu'elle ne descend jamais sous le plancher.
   */
  readonly stepUp: StepUpRequirement;
  /**
   * Token de l'autorité de commande (use case/coordinateur) partagée avec la surface
   * manuelle. `null` uniquement pour une action `closed` dont l'autorité canonique
   * n'est pas encore extraite.
   */
  readonly commandAuthority: string | null;
  /** Au moins une surface manuelle réelle pour toute action ouverte (spec §6.2). */
  readonly surfaces: readonly ManualSurface[];
  readonly founderDecisionIds: readonly FounderDecisionId[];
  /** Motif de fermeture — requis quand `voiceMode === 'closed'` (gate §21.1). */
  readonly closedReason?: string;
  readonly notes?: string;
}
