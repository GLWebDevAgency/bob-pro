import { Redirect } from 'expo-router';
import { LEGACY_VOICE_ROUTE_POLICY } from '../src/voice-flow/legacy-voice-route-policy';

/**
 * L'ancien wizard « facture à la voix » est retiré : il dupliquait Bob et pouvait assimiler
 * la confirmation de l'artisan à une signature client. Toute entrée historique rejoint désormais
 * l'Assistant canonique, seul point d'accès vocal autorisé.
 */
export default function LegacyVoiceRoute() {
  return <Redirect href={LEGACY_VOICE_ROUTE_POLICY.destination} />;
}
