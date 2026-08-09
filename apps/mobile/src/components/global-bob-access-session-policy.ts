import type { RealtimeVoiceClientPolicyCloseReason } from '@bob/core';
import type { VoiceInputIssue } from '../data/voice';
import { requestAssistantTextRecoveryFocus } from '../assistant/text-recovery-focus';

export type GlobalBobSessionStopReason = RealtimeVoiceClientPolicyCloseReason;
export type GlobalBobRecoveryAction =
  | 'none'
  | 'continue_in_assistant'
  | 'write_in_assistant';

export const GLOBAL_BOB_TEXT_RECOVERY_ROUTE = '/(tabs)/assistant' as const;

export interface GlobalBobRecoveryPresentation {
  readonly cardVisible: boolean;
  readonly action: GlobalBobRecoveryAction;
}

/**
 * Parcours où Bob est volontairement indisponible en V1 : Auth n'a aucune session exploitable ;
 * l'onboarding est authentifié mais reste un parcours de configuration explicitement exclu de
 * la parité vocale V1. L'y afficher promettrait une aide qu'il ne peut pas encore rendre.
 *
 * Une route est reconnue par égalité ou par préfixe de segment : `/auth` couvre `/auth/callback`
 * et `/auth/recovery`, sans jamais capturer un `/authentification` qui n'aurait rien à voir.
 */
export const BOB_ENTRY_ROUTES = Object.freeze(['/auth', '/onboarding'] as const);

export function isBobEntryRoute(pathname: string): boolean {
  const route = pathname.replace(/\/+$/, '') || '/';
  return BOB_ENTRY_ROUTES.some((entry) => route === entry || route.startsWith(`${entry}/`));
}

/** Un cache est une photographie utile à l'affichage, jamais la preuve actuelle d'un droit Live. */
export function isGlobalBobSubscriptionVerified(input: {
  readonly hasPayload: boolean;
  readonly failed: boolean;
}): boolean {
  return input.hasPayload && !input.failed;
}

export function deriveGlobalBobSessionStopReason(input: {
  readonly subscriptionVerified: boolean;
  readonly entitled: boolean;
  readonly pathname: string;
}): GlobalBobSessionStopReason | null {
  // La route prime sur le droit : elle est connue localement et sans latence. Auth n'a aucune
  // session exploitable et l'onboarding est volontairement hors parité vocale pendant la V1.
  if (input.pathname === '/voix' || isBobEntryRoute(input.pathname)) return 'incompatible_route';
  if (!input.subscriptionVerified) return 'entitlement_unconfirmed';
  if (!input.entitled) return 'entitlement_revoked';
  return null;
}

/**
 * Fence synchrone d'un effet React : une même transition active→interdite coupe exactement une
 * fois. Le retour à une session inactive réarme la protection contre toute activation posthume.
 */
export function advanceGlobalBobSessionStopFence(input: {
  readonly latched: boolean;
  readonly sessionActive: boolean;
  readonly stopReason: GlobalBobSessionStopReason | null;
}): { readonly latched: boolean; readonly shouldStop: boolean } {
  if (!input.sessionActive || input.stopReason === null) {
    return Object.freeze({ latched: false, shouldStop: false });
  }
  if (input.latched) return Object.freeze({ latched: true, shouldStop: false });
  return Object.freeze({ latched: true, shouldStop: true });
}

/**
 * Une seule action de reprise est présentée. Un handoff scellé conserve la priorité ; une panne
 * sans proposition ouvre uniquement le canal texte, sans prétendre transporter un contexte absent.
 */
export function deriveGlobalBobRecoveryAction(input: {
  readonly active: boolean;
  readonly reviewRequired: boolean;
  readonly hasHandoff: boolean;
  readonly issue: VoiceInputIssue | null;
}): GlobalBobRecoveryAction {
  if (input.active) return 'none';
  if (input.reviewRequired && input.hasHandoff) return 'continue_in_assistant';
  if (input.issue !== null) return 'write_in_assistant';
  return 'none';
}

/** Même autorité pour le rendu et l'annonce : une action démontée ne reste jamais annoncée. */
export function deriveGlobalBobRecoveryPresentation(input: {
  readonly response: string | null;
  readonly active: boolean;
  readonly reviewRequired: boolean;
  readonly hasHandoff: boolean;
  readonly issue: VoiceInputIssue | null;
}): GlobalBobRecoveryPresentation {
  const cardVisible = input.response !== null || input.active;
  return Object.freeze({
    cardVisible,
    action: cardVisible ? deriveGlobalBobRecoveryAction(input) : 'none',
  });
}

/** Capacité volontairement étroite : aucun moteur vocal ni handoff n'est injectable ici. */
export function navigateGlobalBobTextRecovery(
  navigate: (route: typeof GLOBAL_BOB_TEXT_RECOVERY_ROUTE) => void,
): void {
  requestAssistantTextRecoveryFocus();
  navigate(GLOBAL_BOB_TEXT_RECOVERY_ROUTE);
}
