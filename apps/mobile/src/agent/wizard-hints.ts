/**
 * HINT de pré-remplissage inter-écrans (S2-GUIDÉ) : « nouveau devis pour Camping Les Pins »
 * — le nom entendu passe de la session au wizard SANS toucher la route (allowlist stricte)
 * ni le serveur. CIBLÉ (un écran précis), PÉRISSABLE (20 s), consommé UNE fois, purgé à
 * l'arrêt de session : un hint périmé ne pré-remplit jamais un écran ouvert plus tard.
 */
export interface WizardHint {
  readonly customerReference?: string;
}

const TTL_MS = 20_000;

let pending: { readonly target: string; readonly hint: WizardHint; readonly at: number } | null = null;

export function setWizardHint(target: string, hint: WizardHint): void {
  pending = { target, hint, at: Date.now() };
}

export function consumeWizardHint(target: string): WizardHint | null {
  if (pending === null || pending.target !== target) return null;
  const { hint, at } = pending;
  pending = null;
  return Date.now() - at <= TTL_MS ? hint : null;
}

export function clearWizardHint(): void {
  pending = null;
}
