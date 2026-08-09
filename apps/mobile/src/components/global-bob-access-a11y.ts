export interface GlobalBobAccessibilityAnnouncementInput {
  readonly visible: boolean;
  /** États silencieux uniquement (écoute/réflexion), jamais pendant la sortie vocale de Bob. */
  readonly announceActiveState: boolean;
  readonly stateLabel: string;
  /** Erreur ou indisponibilité qui ne possède aucun canal TTS fiable. */
  readonly silentAlert: string | null;
}

export type GlobalBobAccessibilityLiveRegion = 'none' | 'polite' | 'assertive';

/** Compose l'information dynamique dans l'ordre utile : cause précise, puis action disponible. */
export function composeGlobalBobSilentIssueAlert(input: {
  readonly response: string | null;
  readonly fallbackStateLabel: string;
  readonly recoveryActionLabel: string | null;
}): string {
  const cause = input.response?.trim() || input.fallbackStateLabel.trim();
  const action = input.recoveryActionLabel?.trim() ?? '';
  return [cause, action].filter((part) => part !== '').join(' ');
}

/**
 * Contenu dédupliquable annoncé explicitement à VoiceOver (`liveRegion` est Android-only).
 * Une réponse Bob n'entre volontairement jamais ici : elle possède déjà son canal TTS/audité.
 */
export function deriveGlobalBobAccessibilityAnnouncement(
  input: GlobalBobAccessibilityAnnouncementInput,
): string | null {
  if (!input.visible) return null;
  const alert = input.silentAlert?.trim() ?? '';
  if (alert !== '') return alert;
  const state = input.stateLabel.trim();
  return input.announceActiveState && state !== '' ? state : null;
}

/**
 * `accessibilityLiveRegion` pilote TalkBack. Les réponses et la phase `speaking` restent à
 * `none` : la sortie audio de Bob les prononce déjà et une seconde lecture TalkBack rendrait la
 * conversation incompréhensible. Seuls les états silencieux et les erreurs non vocalisées sont
 * annoncés par le lecteur d’écran.
 */
export function deriveGlobalBobAccessibilityLiveRegion(
  input: GlobalBobAccessibilityAnnouncementInput,
): GlobalBobAccessibilityLiveRegion {
  if (!input.visible) return 'none';
  if ((input.silentAlert?.trim() ?? '') !== '') return 'assertive';
  return input.announceActiveState && input.stateLabel.trim() !== '' ? 'polite' : 'none';
}
