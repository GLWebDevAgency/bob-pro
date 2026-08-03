import { describe, expect, it } from 'vitest';
import {
  canRunAssistantManualTurn,
  planAssistantRealtimeControl,
  shouldRequestAssistantRealtimeHandoff,
} from './assistant-realtime-control';

describe('Assistant — pilotage de la session Realtime racine', () => {
  it('laisse toujours piloter une session déjà active', () => {
    expect(
      planAssistantRealtimeControl({
        sessionActive: true,
        manualTurnBusy: true,
        entitlementLoading: true,
        entitlementAllowed: false,
      }),
    ).toBe('toggle_root_session');
  });

  it('attend une autorité abonnement encore inconnue', () => {
    expect(
      planAssistantRealtimeControl({
        sessionActive: false,
        manualTurnBusy: false,
        entitlementLoading: true,
        entitlementAllowed: false,
      }),
    ).toBe('wait_for_entitlement');
  });

  it('ouvre le paywall uniquement après un refus autoritatif', () => {
    expect(
      planAssistantRealtimeControl({
        sessionActive: false,
        manualTurnBusy: false,
        entitlementLoading: false,
        entitlementAllowed: false,
      }),
    ).toBe('show_paywall');
  });

  it('délègue un démarrage autorisé à la session racine', () => {
    expect(
      planAssistantRealtimeControl({
        sessionActive: false,
        manualTurnBusy: false,
        entitlementLoading: false,
        entitlementAllowed: true,
      }),
    ).toBe('toggle_root_session');
  });

  it('ne démarre pas Bob Live pendant un tour texte mais autorise toujours son arrêt', () => {
    expect(
      planAssistantRealtimeControl({
        sessionActive: false,
        manualTurnBusy: true,
        entitlementLoading: false,
        entitlementAllowed: true,
      }),
    ).toBe('wait_for_manual_turn');
    expect(
      planAssistantRealtimeControl({
        sessionActive: true,
        manualTurnBusy: true,
        entitlementLoading: false,
        entitlementAllowed: true,
      }),
    ).toBe('toggle_root_session');
  });

  it('interdit tout tour manuel tant que la voix, un autre tour ou le droit le bloque', () => {
    expect(canRunAssistantManualTurn({
      sessionActive: false,
      manualTurnBusy: false,
      entitlementVerified: true,
      entitlementAllowed: true,
    })).toBe(true);
    for (const input of [
      { sessionActive: true, manualTurnBusy: false, entitlementVerified: true, entitlementAllowed: true },
      { sessionActive: false, manualTurnBusy: true, entitlementVerified: true, entitlementAllowed: true },
      { sessionActive: false, manualTurnBusy: false, entitlementVerified: false, entitlementAllowed: true },
      { sessionActive: false, manualTurnBusy: false, entitlementVerified: true, entitlementAllowed: false },
    ]) {
      expect(canRunAssistantManualTurn(input)).toBe(false);
    }
  });

  it('demande une seule fois le handoff d une proposition reçue sur l écran focalisé', () => {
    expect(
      shouldRequestAssistantRealtimeHandoff({
        assistantFocused: true,
        reviewRequired: true,
        handoffExists: true,
        handoffAlreadyRequested: false,
      }),
    ).toBe(true);

    for (const input of [
      {
        assistantFocused: false,
        reviewRequired: true,
        handoffExists: true,
        handoffAlreadyRequested: false,
      },
      {
        assistantFocused: true,
        reviewRequired: false,
        handoffExists: true,
        handoffAlreadyRequested: false,
      },
      {
        assistantFocused: true,
        reviewRequired: true,
        handoffExists: false,
        handoffAlreadyRequested: false,
      },
      {
        assistantFocused: true,
        reviewRequired: true,
        handoffExists: true,
        handoffAlreadyRequested: true,
      },
    ] as const) {
      expect(shouldRequestAssistantRealtimeHandoff(input)).toBe(false);
    }
  });
});
