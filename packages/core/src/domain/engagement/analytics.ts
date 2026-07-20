import { type Instant } from '../../shared-kernel/time';
import { type Feature, type PlanTier } from '../subscription/plan';

/**
 * ANALYTICS PRODUIT (pilier 2) — le CONTRAT d'événements qui mesure activation, conversion
 * et rétention. Domaine pur : un schéma TYPÉ + un port ; les adapters (PostHog, entrepôt
 * interne) vivent côté hôtes. AUCUNE PII : tenantId opaque, jamais de nom/email/contenu.
 *
 * La north-star de Bob : la VALEUR ADMINISTRATIVE RENDUE (€ encaissés + heures rendues à
 * l'artisan chaque semaine) — chaque événement sert à relier une action produit à cette valeur.
 */

/** Jalons d'ACTIVATION, dans l'ordre du « aha » (première valeur < 3 min visée). */
export const ACTIVATION_MILESTONES = [
  'onboarding_completed', // profil/SIRET posés — l'app est à lui
  'first_document_created', // premier devis/facture — la valeur cœur
  'first_voice_action', // Bob a agi à la voix — le différenciateur vécu
  'first_invoice_issued', // premier document OFFICIEL émis
  'first_payment_recorded', // premier € encaissé via Bob — la boucle de valeur fermée
] as const;

export type ActivationMilestone = (typeof ACTIVATION_MILESTONES)[number];

/** Prochain jalon à provoquer (ordre du funnel) — null si l'activation est complète. */
export function nextActivationMilestone(
  completed: ReadonlySet<ActivationMilestone>,
): ActivationMilestone | null {
  for (const milestone of ACTIVATION_MILESTONES) {
    if (!completed.has(milestone)) return milestone;
  }
  return null;
}

/** D'où vient un paywall — le contexte de la friction, pas un écran générique. */
export type PaywallSource =
  | 'voice_live_tap' // tap sur le micro temps réel sans droit
  | 'feature_screen' // écran d'une capacité verrouillée (relances, trésorerie…)
  | 'plans_screen' // grille « Changer d'offre »
  | 'trial_ending' // bannière/écran de fin d'essai
  | 'quota_reached'; // quota d'actions IA du palier atteint

export type ProductEvent =
  // ── Activation ──
  | { readonly name: 'activation_milestone'; readonly milestone: ActivationMilestone }
  // ── Monétisation ──
  | {
      readonly name: 'paywall_viewed';
      readonly feature: Feature;
      readonly source: PaywallSource;
      readonly decision: 'upgrade' | 'addon' | 'past_due';
      readonly requiredTier?: PlanTier;
    }
  | {
      readonly name: 'paywall_converted';
      readonly feature: Feature;
      readonly source: PaywallSource;
      readonly fromTier: PlanTier;
      readonly toTier: PlanTier;
    }
  | { readonly name: 'paywall_dismissed'; readonly feature: Feature; readonly source: PaywallSource }
  | { readonly name: 'trial_started'; readonly tier: PlanTier; readonly days: number }
  | { readonly name: 'trial_converted'; readonly toTier: PlanTier; readonly daysUsed: number }
  | { readonly name: 'trial_expired'; readonly featuresUsed: readonly Feature[] }
  | { readonly name: 'plan_changed'; readonly fromTier: PlanTier; readonly toTier: PlanTier }
  // ── Rétention ──
  | { readonly name: 'value_digest_sent'; readonly highlightKind: 'money' | 'time' | 'volume' }
  | { readonly name: 'value_digest_opened'; readonly highlightKind: 'money' | 'time' | 'volume' }
  | { readonly name: 'winback_sent'; readonly hookType: 'expiring_quote' | 'overdue_invoice' }
  | { readonly name: 'winback_opened'; readonly hookType: 'expiring_quote' | 'overdue_invoice' };

/** Enveloppe commune : QUI (tenant opaque) et QUAND (fourni par l'hôte — jamais d'horloge ici). */
export interface TrackedEvent {
  readonly tenantId: string;
  readonly at: Instant;
  readonly event: ProductEvent;
}

/** Port de sortie — les hôtes branchent PostHog/entrepôt ; le domaine n'en sait rien.
 *  fire-and-forget : l'analytics ne fait JAMAIS échouer une action utilisateur. */
export interface AnalyticsPort {
  track(event: TrackedEvent): void;
}

/** Adapter nul — opt-out RGPD explicite ou environnement sans collecte analytique. */
export const NOOP_ANALYTICS: AnalyticsPort = { track: () => undefined };
