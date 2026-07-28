import type { RealtimeFallbackReason } from './realtime-transport';

/**
 * Une erreur `fatal` ne peut pas être réparée en recréant immédiatement un peer WebRTC.
 * Une erreur `transient` autorise UNE nouvelle tentative dans la même mission vocale.
 */
export type RealtimeFailureClass = 'fatal' | 'transient';

export type LegacyFallbackChannel = 'voice' | 'text_only';

const FAILURE_CLASS: Readonly<Record<RealtimeFallbackReason, RealtimeFailureClass>> = Object.freeze({
  native_module_unavailable: 'fatal',
  backend_disabled: 'fatal',
  not_entitled: 'fatal',
  entitlement_unavailable: 'transient',
  audio_busy: 'fatal',
  microphone_denied: 'fatal',
  bootstrap_failed: 'transient',
  agent_mission_negotiation_failed: 'fatal',
  data_channel_timeout: 'transient',
  ice_failed: 'transient',
  provider_error: 'transient',
  aborted: 'fatal',
});

const FALLBACK_CHANNEL: Readonly<Record<RealtimeFallbackReason, LegacyFallbackChannel | null>> =
  Object.freeze({
    native_module_unavailable: 'voice',
    backend_disabled: 'voice',
    // Le droit Bob Live ne doit jamais être contourné par une reconnexion Realtime. Le mode
    // historique reste toutefois disponible : il utilise son propre contrat/quotas serveur.
    not_entitled: 'voice',
    // Une panne du service d'entitlements échoue fermée pour Bob Live, puis replie vers le
    // canal historique après l'unique tentative transitoire bornée de l'orchestrateur.
    entitlement_unavailable: 'voice',
    // Relancer un autre moteur audio répéterait exactement l'accroc. Le port legacy peut
    // néanmoins ouvrir son composer texte/local, sans nouvelle permission ni second micro.
    audio_busy: 'text_only',
    microphone_denied: 'text_only',
    bootstrap_failed: 'voice',
    // Une capability absente/perdue ne peut être reconstruite. Seul un nouveau geste utilisateur
    // peut créer une nouvelle session ; tout retry ou legacy automatique masquerait la rupture.
    agent_mission_negotiation_failed: null,
    data_channel_timeout: 'voice',
    ice_failed: 'voice',
    provider_error: 'voice',
    // `aborted` représente une intention de fermeture, jamais une demande de repli.
    aborted: null,
  });

export function isRealtimeFallbackReason(value: unknown): value is RealtimeFallbackReason {
  return typeof value === 'string' && Object.hasOwn(FAILURE_CLASS, value);
}

export function classifyRealtimeFailure(reason: RealtimeFallbackReason): RealtimeFailureClass {
  return FAILURE_CLASS[reason];
}

/** Canal explicite à activer une fois le transport primaire totalement fermé. */
export function legacyFallbackChannelFor(
  reason: RealtimeFallbackReason,
): LegacyFallbackChannel | null {
  return FALLBACK_CHANNEL[reason];
}
