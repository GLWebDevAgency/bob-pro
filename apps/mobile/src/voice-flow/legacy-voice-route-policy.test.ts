import { describe, expect, it } from 'vitest';
import { LEGACY_VOICE_ROUTE_POLICY } from './legacy-voice-route-policy';

describe('route vocale historique — retrait fail-closed', () => {
  it("rejoint l'Assistant canonique sans autoriser aucun effet de facturation", () => {
    expect(LEGACY_VOICE_ROUTE_POLICY).toEqual({
      mode: 'redirect',
      destination: '/(tabs)/assistant',
      allowsBillingEffects: false,
    });
  });
});
