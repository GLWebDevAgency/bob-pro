import type { MistralConversationSessionEndReason } from '@bob/ai';
import { resolveBobLiveEnv, type BobLiveAuditProviderId, type BobLiveProviderId, type Env } from '../../config/env';

export const BOB_REALTIME_CONFIG_VERSION = 'bob-live-provider-neutral-v4';
export const BOB_REALTIME_CONFIG_VERSION_N_MINUS_ONE = 'bob-live-provider-neutral-v3';

export interface RealtimeVoiceSettings {
  enabled: boolean;
  provider: BobLiveProviderId;
  speechDelivery: 'audited-signed-url-v1' | 'openai-native-webrtc-v1';
  model: string;
  voice: 'marin' | 'cedar';
  baseUrl: string;
  apiKey: string | null;
  safetySecret: string | null;
  subjectKeyVersion: number;
  /** Versions HMAC conservées pour authentifier les Missions/reçus créés avant rotation. */
  subjectHmacKeyRing?: readonly Readonly<{ version: number; secret: string }>[];
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
  mistralV2InitialBootstrapEnabled: boolean;
}

export function realtimeVoiceSettingsFromEnv(env: Env): RealtimeVoiceSettings {
  const live = resolveBobLiveEnv(env);
  return {
    enabled: live.enabled,
    provider: live.provider,
    speechDelivery: live.speechDelivery,
    model: live.providerModel,
    voice: env.OPENAI_REALTIME_VOICE,
    baseUrl: live.providerBaseUrl,
    apiKey: (live.provider === 'mistral' ? env.MISTRAL_API_KEY : env.OPENAI_API_KEY) ?? null,
    safetySecret: live.subjectHmacSecret,
    subjectKeyVersion: live.subjectKeyVersion,
    subjectHmacKeyRing: live.subjectHmacKeyRing?.versions.map((version) => {
      const secret = live.subjectHmacKeyRing?.secret(version);
      if (!secret) throw new Error(`Bob Live subject HMAC key ${version} is unavailable.`);
      return Object.freeze({ version, secret });
    }) ?? [],
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
    mistralV2InitialBootstrapEnabled: live.mistralV2InitialBootstrapEnabled,
  };
}

export type RealtimeVoiceTransport = 'webrtc' | 'mistral-pcm';

interface RealtimeVoicePublicConfigCommon {
  available: boolean;
  availabilityReason?: 'disabled' | 'not_entitled' | 'entitlement_unavailable';
  model: string;
  voice: 'marin' | 'cedar';
  configVersion: string;
  requiresDevelopmentBuild: true;
  maxSessionSeconds: number;
}

export interface RealtimeVoiceNativePublicConfig extends RealtimeVoicePublicConfigCommon {
  transport: 'webrtc';
  speechDelivery: 'openai-native-webrtc-v1';
}

export interface RealtimeVoiceAuditedWebRtcPublicConfig extends RealtimeVoicePublicConfigCommon {
  transport: 'webrtc';
  speechDelivery: 'audited-signed-url-v1';
}

export interface RealtimeVoiceMistralPublicConfig extends RealtimeVoicePublicConfigCommon {
  transport: 'mistral-pcm';
  speechDelivery: 'audited-signed-url-v1';
  /** Permet un rollout v1/v2 sans heuristique ; absent pour le serveur N-1. */
  protocol?: 'bob.mistral-pcm.v1' | 'bob.mistral-pcm.v2';
}

export type RealtimeVoicePublicConfig =
  | RealtimeVoiceNativePublicConfig
  | RealtimeVoiceAuditedWebRtcPublicConfig
  | RealtimeVoiceMistralPublicConfig;

interface RealtimeCallBootstrapCommon {
  sessionHandle: string;
  hardExpiresAt: string;
  model: string;
  voice: 'marin' | 'cedar';
  configVersion: string;
  maxSessionSeconds: number;
}

interface RealtimeAuditedCallBootstrapCommon extends RealtimeCallBootstrapCommon {
  speechDelivery: 'audited-signed-url-v1';
  speechSourcePolicy: import('./realtime-speech-storage').RealtimeSpeechSourcePolicy;
}

interface RealtimeLegacyAuditedCallBootstrapCommon extends RealtimeCallBootstrapCommon {
  /** Réponse wire v3 : le client N-1 ne connaît pas encore ce discriminant. */
  speechDelivery?: never;
  speechSourcePolicy: import('./realtime-speech-storage').RealtimeSpeechSourcePolicy;
}

export interface OpenAiNativeRealtimeCallBootstrap extends RealtimeCallBootstrapCommon {
  transport: 'webrtc';
  speechDelivery: 'openai-native-webrtc-v1';
  answerSdp: string;
}

export type OpenAiAuditedRealtimeCallBootstrap = (
  | RealtimeAuditedCallBootstrapCommon
  | RealtimeLegacyAuditedCallBootstrapCommon
) & {
  transport: 'webrtc';
  answerSdp: string;
};

export type OpenAiRealtimeCallBootstrap =
  | OpenAiNativeRealtimeCallBootstrap
  | OpenAiAuditedRealtimeCallBootstrap;

interface MistralRealtimeCallBootstrapBody {
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

export type MistralRealtimeCallBootstrap = (
  | RealtimeAuditedCallBootstrapCommon
  | RealtimeLegacyAuditedCallBootstrapCommon
) & MistralRealtimeCallBootstrapBody;

/** Canary serveur v2 : session durable push-to-talk, sans annonce publique ni tour actif. */
interface MistralConversationInitialCallBootstrapBody {
  transport: 'mistral-pcm';
  websocketUrl: string;
  companyId: string;
  ticket: string;
  protocol: 'bob.mistral-pcm.v2';
  ticketExpiresAt: string;
  maxMissionAudioBytes: number;
  contextRevision: number;
  contextDigest: string;
  routeMode: 'push_to_talk';
  fullDuplexCertified: false;
}

export type MistralConversationInitialCallBootstrap = (
  | RealtimeAuditedCallBootstrapCommon
  | RealtimeLegacyAuditedCallBootstrapCommon
) & MistralConversationInitialCallBootstrapBody;

export type RealtimeCallBootstrap =
  | OpenAiRealtimeCallBootstrap
  | MistralRealtimeCallBootstrap
  | MistralConversationInitialCallBootstrap;

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
  | {
      readonly status: 'terminal_complete';
      readonly companyId: string;
      readonly sessionHandle: string;
      readonly protocol: 'bob.mistral-pcm.v2';
      readonly missionConnectionEpoch: number;
      readonly nextServerSequence: number;
      readonly reason: MistralConversationSessionEndReason;
      readonly closedAt: string;
    };

export interface RealtimeVoiceBootstrapReconciliationIssued {
  readonly status: 'issued';
  readonly websocketUrl: string;
  readonly companyId: string;
  readonly sessionHandle: string;
  readonly ticket: string;
  readonly protocol: 'bob.mistral-pcm.v2';
  readonly scope: 'live_takeover' | 'terminal_replay';
  readonly ticketExpiresAt: string;
  readonly expectedMissionConnectionEpoch: number;
  /** Le mobile n'a jamais reçu `session.ready` sur le bootstrap ambigu. */
  readonly clientAcceptedMissionConnectionEpoch: 0;
  /** Aucun événement serveur n'a encore été appliqué par ce mobile. */
  readonly resumeNextServerSequence: 0;
}

export type RealtimeVoiceBootstrapReconciliation =
  | RealtimeVoiceBootstrapReconciliationIssued
  | { readonly status: 'retry_initial' }
  | { readonly status: 'attempt_consumed' };

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

interface OpenAiRealtimeSessionConfigCommon {
  type: 'realtime';
  model: string;
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
        interrupt_response: boolean;
      };
    };
    output: {
      format: { type: 'audio/pcm'; rate: 24_000 };
      voice: 'marin' | 'cedar';
      speed: 1;
    };
  };
  tools: [];
  tool_choice: 'none';
  tracing: null;
}

/**
 * Le provider ne produit jamais la voix Bob dans le parcours audité. `text` neutralise la piste
 * audio descendante ; le VAD peut interrompre une éventuelle réponse ouverte par un client N-1.
 */
export interface OpenAiAuditedRealtimeSessionConfig extends OpenAiRealtimeSessionConfigCommon {
  output_modalities: ['text'];
  audio: OpenAiRealtimeSessionConfigCommon['audio'] & {
    input: OpenAiRealtimeSessionConfigCommon['audio']['input'] & {
      turn_detection: OpenAiRealtimeSessionConfigCommon['audio']['input']['turn_detection'] & {
        interrupt_response: true;
      };
    };
  };
  max_output_tokens: 1;
}

/**
 * Le transport natif reçoit une piste audio, mais ne répond jamais automatiquement : seule une
 * réponse OOB canonique et approuvée par le serveur peut être créée par le sideband.
 */
export interface OpenAiNativeRealtimeSessionConfig extends OpenAiRealtimeSessionConfigCommon {
  output_modalities: ['audio'];
  audio: OpenAiRealtimeSessionConfigCommon['audio'] & {
    input: OpenAiRealtimeSessionConfigCommon['audio']['input'] & {
      turn_detection: OpenAiRealtimeSessionConfigCommon['audio']['input']['turn_detection'] & {
        interrupt_response: false;
      };
    };
  };
  max_output_tokens: 4_096;
}

export type OpenAiRealtimeSessionConfig =
  | OpenAiAuditedRealtimeSessionConfig
  | OpenAiNativeRealtimeSessionConfig;
