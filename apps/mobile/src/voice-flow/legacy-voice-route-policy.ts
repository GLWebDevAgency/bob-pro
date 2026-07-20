/**
 * Contrat fail-closed de la route historique `/voix`.
 *
 * `allowsBillingEffects` reste explicite afin qu'une future réintroduction du wizard ne puisse
 * pas remettre silencieusement la chaîne create → send → sign → invoice derrière une seule
 * confirmation artisan.
 */
export const LEGACY_VOICE_ROUTE_POLICY = Object.freeze({
  mode: 'redirect',
  destination: '/(tabs)/assistant',
  allowsBillingEffects: false,
} as const);
