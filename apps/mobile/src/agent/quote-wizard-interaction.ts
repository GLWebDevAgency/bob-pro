import type {
  QuoteScreenMissionBindingState,
} from './quote-screen-mission-coordinator';

type QuoteMissionPhase = QuoteScreenMissionBindingState['phase'];

const INTERACTIVE_PHASES: ReadonlySet<QuoteMissionPhase> = new Set([
  'ready',
  'handoff',
  'manual',
]);

/**
 * Gate unique du writer devis.
 *
 * Les réglages chargés ne suffisent jamais : dès que l'autorité Mission repart en détection,
 * hydratation, ACK ou reprise, l'intégralité du wizard redevient non interactive.
 */
export function quoteWizardInteractionEnabled(input: {
  readonly billingDefaultsReady: boolean;
  readonly missionPhase: QuoteMissionPhase;
}): boolean {
  return input.billingDefaultsReady && INTERACTIVE_PHASES.has(input.missionPhase);
}

/**
 * Le bouton Bob global ne doit jamais ouvrir une seconde session par-dessus une décision
 * autoritaire, une reprise ou une passation en cours. Il réapparaît uniquement lorsque l'écran
 * est réellement prêt à recevoir une interaction.
 */
export function quoteWizardGlobalBobHidden(
  missionPhase: QuoteMissionPhase,
): boolean {
  return !INTERACTIVE_PHASES.has(missionPhase);
}

/**
 * Empêche un back/swipe de détacher l'écran pendant qu'une reprise ou une passation possède
 * encore les ressources Live. Le verrou est borné par la transition autoritaire du binding.
 */
export function quoteWizardNavigationLocked(input: {
  readonly missionPhase: QuoteMissionPhase;
  readonly missionResumePending: boolean;
}): boolean {
  return input.missionResumePending || input.missionPhase === 'handing_off';
}

/**
 * Un brouillon local parké ne peut reprendre la main que lorsque le binding a prouvé l'absence
 * d'autorité Mission. Dans toutes les autres phases, le brouillon serveur reste l'unique vérité.
 */
export function quoteWizardCanResumeParkedDraft(
  missionPhase: QuoteMissionPhase,
): boolean {
  return missionPhase === 'manual';
}

/**
 * Sérialise les actualisations de liste déclenchées par plusieurs surfaces (erreur partielle,
 * candidat supprimé, retry explicite). L'appelant reçoit toujours un booléen honnête et chaque
 * vague concurrente ne produit qu'une requête réseau.
 */
export class QuoteCustomerListRefreshCoordinator {
  private flight: Promise<boolean> | null = null;

  refresh(
    operation: () => Promise<boolean>,
    onPendingChange: (pending: boolean) => void,
  ): Promise<boolean> {
    if (this.flight !== null) return this.flight;

    onPendingChange(true);
    const flight = Promise.resolve()
      .then(operation)
      .catch(() => false)
      .finally(() => {
        if (this.flight !== flight) return;
        this.flight = null;
        onPendingChange(false);
      });
    this.flight = flight;
    return flight;
  }
}
