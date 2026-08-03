/**
 * Décision pure du CTA Bob Live dans l'onglet Assistant.
 *
 * L'Assistant ne possède jamais d'oreille : il délègue au contrôleur racine. Une session déjà
 * active reste toujours pilotable, même si la lecture d'abonnement est momentanément en retard ;
 * son arrêt ou son commit semi-duplex ne doit jamais être enfermé derrière un paywall.
 */
export type AssistantRealtimeControlPlan =
  | 'toggle_root_session'
  | 'wait_for_manual_turn'
  | 'wait_for_entitlement'
  | 'show_paywall';

export function planAssistantRealtimeControl(input: {
  readonly sessionActive: boolean;
  readonly manualTurnBusy: boolean;
  readonly entitlementLoading: boolean;
  readonly entitlementAllowed: boolean;
}): AssistantRealtimeControlPlan {
  // Arrêter une session reste toujours possible, y compris si un ancien tour manuel se termine.
  if (input.sessionActive) return 'toggle_root_session';
  if (input.manualTurnBusy) return 'wait_for_manual_turn';
  if (input.entitlementLoading) return 'wait_for_entitlement';
  return input.entitlementAllowed ? 'toggle_root_session' : 'show_paywall';
}

/** Un tour texte et Bob Live ne possèdent jamais simultanément la navigation ou les mutations. */
export function canRunAssistantManualTurn(input: {
  readonly sessionActive: boolean;
  readonly manualTurnBusy: boolean;
  readonly entitlementVerified: boolean;
  readonly entitlementAllowed: boolean;
}): boolean {
  return (
    !input.sessionActive &&
    !input.manualTurnBusy &&
    input.entitlementVerified &&
    input.entitlementAllowed
  );
}

/** L'orbe est masqué sur `/assistant` : une proposition doit y demander elle-même son handoff. */
export function shouldRequestAssistantRealtimeHandoff(input: {
  readonly assistantFocused: boolean;
  readonly reviewRequired: boolean;
  readonly handoffExists: boolean;
  readonly handoffAlreadyRequested: boolean;
}): boolean {
  return (
    input.assistantFocused &&
    input.reviewRequired &&
    input.handoffExists &&
    !input.handoffAlreadyRequested
  );
}
