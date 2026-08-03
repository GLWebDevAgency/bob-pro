/**
 * Diagnostic client minimal de Bob Live.
 *
 * Le contrat est volontairement fermé : aucune chaîne libre, SDP, URL, transcription ou donnée
 * métier ne peut traverser cette frontière. Il accompagne uniquement la fermeture HTTP afin que
 * staging indique quelle frontière native a été franchie en dernier.
 */

export const REALTIME_VOICE_CLIENT_CHECKPOINTS = [
  'transport_started',
  'audio_acquired',
  'local_offer_set',
  'bootstrap_acknowledged',
  'answer_sdp_validated',
  'remote_description_set',
  'transceiver_validated',
  'data_channel_open',
  'raw_transport_ready',
  'audited_player_created',
  'mission_adopted',
  'context_put_started',
  'context_confirmed',
  'microphone_opened',
] as const;

export const REALTIME_VOICE_CLIENT_FAILURE_CODES = [
  'native_module_unavailable',
  'audio_acquisition_failed',
  'microphone_permission_denied',
  'local_offer_rejected',
  'bootstrap_request_failed',
  'bootstrap_contract_rejected',
  'mission_bootstrap_rejected',
  'diagnostic_contract_rejected',
  'session_expiry_rejected',
  'answer_sdp_rejected',
  'remote_description_rejected',
  'remote_track_rejected',
  'transceiver_rejected',
  'data_channel_closed',
  'data_channel_timeout',
  'audited_downlink_binding_rejected',
  'audited_player_creation_failed',
  'audited_player_runtime_failed',
  'audited_pipeline_failed',
  'mission_adoption_failed',
  'context_publish_failed',
  'context_synchronization_failed',
  'mission_context_confirmation_failed',
  'microphone_activation_refused',
  'provider_connection_failed',
  'aborted',
  'unknown',
] as const;

export const REALTIME_VOICE_CLIENT_LIFECYCLE_CLOSE_REASONS = [
  'background',
  'navigation',
  'unmount',
  'aborted',
  'max_duration',
] as const;

export type RealtimeVoiceClientCheckpoint =
  (typeof REALTIME_VOICE_CLIENT_CHECKPOINTS)[number];
export type RealtimeVoiceClientFailureCode =
  (typeof REALTIME_VOICE_CLIENT_FAILURE_CODES)[number];
export type RealtimeVoiceClientLifecycleCloseReason =
  (typeof REALTIME_VOICE_CLIENT_LIFECYCLE_CLOSE_REASONS)[number];

interface RealtimeVoiceClientTerminationBase {
  readonly version: 1;
  readonly lastSuccessfulCheckpoint: RealtimeVoiceClientCheckpoint;
}

export type RealtimeVoiceClientTerminationDiagnostic =
  | (RealtimeVoiceClientTerminationBase & {
      readonly terminationSource: 'automatic_failure';
      readonly failureCode: RealtimeVoiceClientFailureCode;
    })
  | (RealtimeVoiceClientTerminationBase & {
      readonly terminationSource: 'user';
      readonly closeReason: 'user';
    })
  | (RealtimeVoiceClientTerminationBase & {
      readonly terminationSource: 'lifecycle';
      readonly closeReason: RealtimeVoiceClientLifecycleCloseReason;
    });

const CHECKPOINTS = new Set<string>(REALTIME_VOICE_CLIENT_CHECKPOINTS);
const FAILURE_CODES = new Set<string>(REALTIME_VOICE_CLIENT_FAILURE_CODES);
const LIFECYCLE_CLOSE_REASONS = new Set<string>(
  REALTIME_VOICE_CLIENT_LIFECYCLE_CLOSE_REASONS,
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

/** Parse la forme wire exacte ; `null` signifie refus, jamais normalisation permissive. */
export function parseRealtimeVoiceClientTerminationDiagnostic(
  value: unknown,
): RealtimeVoiceClientTerminationDiagnostic | null {
  if (!isRecord(value) || value.version !== 1) return null;
  if (
    typeof value.lastSuccessfulCheckpoint !== 'string'
    || !CHECKPOINTS.has(value.lastSuccessfulCheckpoint)
  ) return null;

  if (value.terminationSource === 'automatic_failure') {
    if (
      !hasExactKeys(value, [
        'version',
        'terminationSource',
        'lastSuccessfulCheckpoint',
        'failureCode',
      ])
      || typeof value.failureCode !== 'string'
      || !FAILURE_CODES.has(value.failureCode)
    ) return null;
    return value as unknown as RealtimeVoiceClientTerminationDiagnostic;
  }

  if (value.terminationSource === 'user') {
    if (
      !hasExactKeys(value, [
        'version',
        'terminationSource',
        'lastSuccessfulCheckpoint',
        'closeReason',
      ])
      || value.closeReason !== 'user'
    ) return null;
    return value as unknown as RealtimeVoiceClientTerminationDiagnostic;
  }

  if (value.terminationSource === 'lifecycle') {
    if (
      !hasExactKeys(value, [
        'version',
        'terminationSource',
        'lastSuccessfulCheckpoint',
        'closeReason',
      ])
      || typeof value.closeReason !== 'string'
      || !LIFECYCLE_CLOSE_REASONS.has(value.closeReason)
    ) return null;
    return value as unknown as RealtimeVoiceClientTerminationDiagnostic;
  }

  return null;
}
