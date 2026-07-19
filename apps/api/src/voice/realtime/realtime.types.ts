import { resolveBobLiveEnv, type BobLiveAuditProviderId, type BobLiveProviderId, type Env } from '../../config/env';

export const BOB_REALTIME_CONFIG_VERSION = 'bob-live-provider-neutral-v3';

export interface RealtimeVoiceSettings {
  enabled: boolean;
  provider: BobLiveProviderId;
  model: string;
  voice: 'marin' | 'cedar';
  baseUrl: string;
  apiKey: string | null;
  safetySecret: string | null;
  subjectKeyVersion: number;
  providerTimeoutMs: number;
  sidebandTimeoutMs: number;
  maxSessionSeconds: number;
  heartbeatSeconds: number;
  maxCallsPerMinute: number;
  auditProvider: BobLiveAuditProviderId;
  localAuditBaseUrl: string | null;
  localAuditToken: string | null;
  mistralTargetDelayMs: number;
  mistralWebsocketUrl: string;
}

export function realtimeVoiceSettingsFromEnv(env: Env): RealtimeVoiceSettings {
  const live = resolveBobLiveEnv(env);
  return {
    enabled: live.enabled,
    provider: live.provider,
    model: live.providerModel,
    voice: env.OPENAI_REALTIME_VOICE,
    baseUrl: live.providerBaseUrl,
    apiKey: (live.provider === 'mistral' ? env.MISTRAL_API_KEY : env.OPENAI_API_KEY) ?? null,
    safetySecret: live.subjectHmacSecret,
    subjectKeyVersion: live.subjectKeyVersion,
    providerTimeoutMs: live.providerTimeoutMs,
    sidebandTimeoutMs: live.controlTimeoutMs,
    maxSessionSeconds: live.maxSessionSeconds,
    heartbeatSeconds: live.heartbeatSeconds,
    maxCallsPerMinute: live.maxCallsPerMinute,
    auditProvider: live.auditProvider,
    localAuditBaseUrl: live.localAuditBaseUrl,
    localAuditToken: live.localAuditToken,
    mistralTargetDelayMs: live.mistralTargetDelayMs,
    mistralWebsocketUrl: live.mistralWebsocketUrl,
  };
}

export type RealtimeVoiceTransport = 'webrtc' | 'mistral-pcm';

export interface RealtimeVoicePublicConfig {
  available: boolean;
  availabilityReason?: 'disabled' | 'not_entitled' | 'entitlement_unavailable';
  transport: RealtimeVoiceTransport;
  model: string;
  voice: 'marin' | 'cedar';
  configVersion: string;
  requiresDevelopmentBuild: true;
  maxSessionSeconds: number;
  speechDelivery: 'audited-signed-url-v1';
}

interface RealtimeCallBootstrapCommon {
  sessionHandle: string;
  hardExpiresAt: string;
  model: string;
  voice: 'marin' | 'cedar';
  configVersion: string;
  maxSessionSeconds: number;
  speechSourcePolicy: import('./realtime-speech-storage').RealtimeSpeechSourcePolicy;
}

export interface OpenAiRealtimeCallBootstrap extends RealtimeCallBootstrapCommon {
  transport: 'webrtc';
  answerSdp: string;
}

export interface MistralRealtimeCallBootstrap extends RealtimeCallBootstrapCommon {
  transport: 'mistral-pcm';
  websocketUrl: string;
  companyId: string;
  ticket: string;
  protocol: 'bob.mistral-pcm.v1';
  ticketExpiresAt: string;
  maxAudioBytes: number;
  contextRevision: number;
  contextDigest: string;
}

export type RealtimeCallBootstrap = OpenAiRealtimeCallBootstrap | MistralRealtimeCallBootstrap;

export interface RealtimeVoiceResumeTicketIssued {
  readonly status: 'issued';
  readonly websocketUrl: string;
  readonly companyId: string;
  readonly sessionHandle: string;
  readonly ticket: string;
  readonly protocol: 'bob.mistral-pcm.v2';
  readonly scope: 'terminal_replay';
  readonly ticketExpiresAt: string;
  readonly expectedMissionConnectionEpoch: number;
  readonly clientAcceptedMissionConnectionEpoch: number;
  readonly resumeNextServerSequence: number;
}

export type RealtimeVoiceResumeTicket =
  | RealtimeVoiceResumeTicketIssued
  | { readonly status: 'terminal_complete' };

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
  /** Le provider ne produit jamais la voix Bob. `text` neutralise la piste audio descendante. */
  output_modalities: ['text'];
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
