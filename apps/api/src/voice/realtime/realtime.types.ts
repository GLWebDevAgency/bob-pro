import type { Env } from '../../config/env';

export const BOB_REALTIME_CONFIG_VERSION = 'bob-live-webrtc-v1';

export interface RealtimeVoiceSettings {
  enabled: boolean;
  model: string;
  voice: 'marin' | 'cedar';
  baseUrl: string;
  apiKey: string | null;
  safetySecret: string | null;
  providerTimeoutMs: number;
  sidebandTimeoutMs: number;
  maxSessionSeconds: number;
  heartbeatSeconds: number;
  maxCallsPerMinute: number;
}

export function realtimeVoiceSettingsFromEnv(env: Env): RealtimeVoiceSettings {
  return {
    enabled: env.OPENAI_REALTIME_ENABLED === 'true',
    model: env.OPENAI_REALTIME_MODEL,
    voice: env.OPENAI_REALTIME_VOICE,
    baseUrl: env.OPENAI_REALTIME_BASE_URL.replace(/\/$/, ''),
    apiKey: env.OPENAI_API_KEY ?? null,
    safetySecret: env.OPENAI_REALTIME_SAFETY_SECRET ?? null,
    providerTimeoutMs: env.OPENAI_REALTIME_PROVIDER_TIMEOUT_MS,
    sidebandTimeoutMs: env.OPENAI_REALTIME_SIDEBAND_TIMEOUT_MS,
    maxSessionSeconds: env.OPENAI_REALTIME_MAX_SESSION_SECONDS,
    heartbeatSeconds: env.OPENAI_REALTIME_HEARTBEAT_SECONDS,
    maxCallsPerMinute: env.OPENAI_REALTIME_MAX_CALLS_PER_MINUTE,
  };
}

export interface RealtimeVoicePublicConfig {
  available: boolean;
  availabilityReason?: 'disabled' | 'not_entitled' | 'entitlement_unavailable';
  transport: 'webrtc';
  model: string;
  voice: 'marin' | 'cedar';
  configVersion: string;
  requiresDevelopmentBuild: true;
  maxSessionSeconds: number;
}

export interface RealtimeCallBootstrap {
  transport: 'webrtc';
  answerSdp: string;
  sessionHandle: string;
  hardExpiresAt: string;
  model: string;
  voice: 'marin' | 'cedar';
  configVersion: string;
  maxSessionSeconds: number;
}

export interface OpenAiRealtimeCallInput {
  offerSdp: string;
  safetyIdentifier: string;
  session: OpenAiRealtimeSessionConfig;
  /**
   * Barrière durable appelée aussitôt que le fournisseur a publié son call_id, avant toute
   * lecture de son SDP. Le callback doit enregistrer le call_id dans le bail d'admission ou lever
   * une erreur. L'adapter compense alors l'appel fournisseur avant de rejeter le bootstrap.
   */
  onCallCreated(callId: string): Promise<void>;
  /** Annulation du bootstrap client, observée seulement une fois le call_id récupérable. */
  signal?: AbortSignal;
}

export interface OpenAiRealtimeCallOutput {
  answerSdp: string;
  callId: string;
}

export interface OpenAiRealtimeCallProvider {
  createCall(input: OpenAiRealtimeCallInput): Promise<OpenAiRealtimeCallOutput>;
  hangupCall(callId: string): Promise<void>;
}

export interface OpenAiRealtimeSessionConfig {
  type: 'realtime';
  model: string;
  output_modalities: ['audio'];
  instructions: string;
  include: [];
  truncation: 'auto';
  audio: {
    input: {
      format: { type: 'audio/pcm'; rate: 24_000 };
      noise_reduction: { type: 'near_field' };
      transcription: {
        model: 'gpt-4o-mini-transcribe';
        language: 'fr';
        prompt: string;
      };
      turn_detection: {
        type: 'semantic_vad';
        eagerness: 'auto';
        create_response: false;
        interrupt_response: true;
      };
    };
    output: {
      format: { type: 'audio/pcm'; rate: 24_000 };
      voice: 'marin' | 'cedar';
      speed: 1;
    };
  };
  max_output_tokens: number;
  tools: [];
  tool_choice: 'none';
  tracing: null;
}
