export interface GlobalBobAccessibilityAnnouncementInput {
  readonly visible: boolean;
  /** États silencieux uniquement (écoute/réflexion), jamais pendant la sortie vocale de Bob. */
  readonly announceActiveState: boolean;
  readonly stateLabel: string;
  /** Erreur ou indisponibilité qui ne possède aucun canal TTS fiable. */
  readonly silentAlert: string | null;
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
