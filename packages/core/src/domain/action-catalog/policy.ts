/**
 * Table normative classe→mode (spec §7.0, FD-2026-0817-02).
 *
 * Ces fonctions SONT l'autorité : le catalogue porte les valeurs par action mais ne
 * peut pas y déroger vers le bas, et aucun classement en `confirmable` avec
 * restitution vocale ne contourne ce plancher. Le LLM ne choisit jamais ces
 * propriétés (spec §6).
 */

import type {
  ActionCatalogEntry,
  ActionFlag,
  PresentationRequirement,
  StepUpRequirement,
} from './types';

/** Seuil d'escalade R2→R3 : 5 000 € TTC — fixe en V1, jamais désactivable (FD-02). */
export const AMOUNT_STEP_UP_THRESHOLD_CENTS = 500_000;

/** ≥ 2 destinataires = action de masse (FD-02). */
export const MASS_ACTION_MIN_RECIPIENTS = 2;

/** Plafond de destinataires par mandat de campagne (FD-02, FD-05). */
export const MANDATE_RECIPIENTS_CAP = 20;

/** Flags qui imposent `screen_ack` quel que soit le niveau de classe (spec §7.0). */
const SCREEN_ACK_FLAGS: ReadonlySet<ActionFlag> = new Set([
  'financial',
  'external',
  'mass_action',
  'destructive',
  'irreversible',
  'security_sensitive',
]);

/** Flags dont la présence impose le step-up biométrie/PIN (sous-ensemble dérivable de la liste R3). */
const STEP_UP_FLAGS: ReadonlySet<ActionFlag> = new Set([
  'destructive',
  'irreversible',
  'mass_action',
  'security_sensitive',
]);

/**
 * Reçu de présentation minimal exigé pour atteindre `presented` (spec §7.1).
 * Pour un résultat `screen_ack`, une restitution vocale, même complète, ne
 * l'atteint jamais.
 */
export function requiredPresentation(
  entry: Pick<ActionCatalogEntry, 'riskClass' | 'flags'>,
): PresentationRequirement {
  if (entry.riskClass === 'L0' || entry.riskClass === 'P1') {
    return 'none';
  }
  if (entry.riskClass === 'E3' || entry.flags.some((flag) => SCREEN_ACK_FLAGS.has(flag))) {
    return 'screen_ack';
  }
  return 'voice_presentation_ack';
}

/** Plancher de step-up dérivable des flags ; l'entrée peut exiger plus, jamais moins. */
export function stepUpFloor(
  entry: Pick<ActionCatalogEntry, 'flags'>,
): StepUpRequirement {
  return entry.flags.some((flag) => STEP_UP_FLAGS.has(flag)) ? 'biometric_or_pin' : 'none';
}

/**
 * Escalade au montant (FD-02) : tout acte engageant ≥ 5 000 € TTC monte R2→R3.
 * À évaluer au moment de la proposition, sur le montant TTC autoritaire en centimes.
 */
export function amountEscalatesToStepUp(amountTtcCents: number): boolean {
  return amountTtcCents >= AMOUNT_STEP_UP_THRESHOLD_CENTS;
}

/** ≥ 2 destinataires = `mass_action` (FD-02). */
export function isMassAction(recipientCount: number): boolean {
  return recipientCount >= MASS_ACTION_MIN_RECIPIENTS;
}
