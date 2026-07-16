export interface GlobalBobAccessibilityAnnouncementInput {
  readonly visible: boolean;
  readonly active: boolean;
  readonly stateLabel: string;
  readonly response: string | null;
  readonly reviewRequiredLabel: string | null;
}

/** Contenu dédupliquable annoncé explicitement à VoiceOver (liveRegion est Android-only). */
export function deriveGlobalBobAccessibilityAnnouncement(
  input: GlobalBobAccessibilityAnnouncementInput,
): string | null {
  if (!input.visible) return null;
  const response = input.response?.trim() ?? '';
  const review = input.reviewRequiredLabel?.trim() ?? '';
  if (response !== '') {
    if (review === '') return response;
    const separator = /[.!?…]$/u.test(response) ? ' ' : '. ';
    return `${response}${separator}${review}`;
  }
  const state = input.stateLabel.trim();
  return input.active && state !== '' ? state : null;
}
