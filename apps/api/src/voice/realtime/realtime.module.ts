import { Module, type Provider } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { SttPort } from '@bob/ai';
import { QUOTE_CREATION_MISSION_KIND_V1 } from '@bob/core';
import {
  buildLlmForProvider,
  buildRealtimeSpeechAuditStt,
  buildRealtimeSpeechTts,
  type LocalWhisperAuditDeploymentProbePort,
} from '../../ai/providers';
import { AgentMissionModule } from '../../agent-missions/agent-mission.module';
import { AgentMissionService } from '../../agent-missions/agent-mission.service';
import { BackendService } from '../../backend.service';
import {
  loadEnv,
  resolveBobLiveEnv,
  resolveMistralConversationPersistenceKeyRing,
  resolveMistralV2IdentityEncryptionKeyRing,
  type Env,
} from '../../config/env';
import { allowedCorsOrigins } from '../../config/cors';
import { AppLogger } from '../../observability/logger';
import { Metrics } from '../../observability/metrics';
import { PersistenceModule } from '../../persistence/persistence.module';
import type { Persistence } from '../../persistence/persistence';
import { PERSISTENCE } from '../../persistence/persistence-token';
import {
  DisabledOpenAiRealtimeCallProvider,
  OpenAiRealtimeCallAdapter,
} from './openai-realtime-call.adapter';
import { realtimeAdmissionPolicyFromEnv } from './realtime-admission';
import { buildRealtimeAgentMissionAdmissionGate } from './realtime-agent-mission-admission';
import { RealtimeGlobalCapacityMonitor } from './realtime-capacity-monitor';
import { RealtimeVoiceController } from './realtime.controller';
import {
  REALTIME_REAPER_DIRECTORY,
  RealtimeAdmissionReaperScheduler,
} from './realtime-reaper.scheduler';
import {
  MISTRAL_CONVERSATION_BOOTSTRAP_REAPER,
  MISTRAL_CONVERSATION_BOOTSTRAP_REAPER_OPTIONS,
  MistralConversationBootstrapReaperScheduler,
  type MistralConversationBootstrapReaperOptions,
} from './mistral-conversation-bootstrap-reaper.scheduler';
import { RealtimeSidebandManager } from './realtime-sideband';
import { RealtimeVoiceService } from './realtime.service';
import { RealtimeBobAgentTurnAdapter } from './realtime-agent-turn';
import { RealtimeQuoteMissionOrchestrator } from './realtime-quote-mission-orchestrator';
import { QuoteCreationMissionKindAdapter } from './quote-creation-mission-kind.adapter';
import { RealtimeMissionKindRegistry } from './realtime-mission-kind';
import { RealtimeBackendEntitlementAdapter } from './realtime-entitlement';
import { RealtimeSpeechDeliveryService } from './realtime-speech-delivery';
import {
  DisabledRealtimeSpeechDeliveryRepository,
  type RealtimeSpeechDeliveryRepositoryPort,
} from './realtime-speech-delivery.repository';
import {
  BobAiRealtimeSpeechAuditAdapter,
  BobAiRealtimeSpeechSynthesisAdapter,
} from './realtime-speech-provider-adapters';
import { RealtimeSpeechPublisher } from './realtime-speech-publisher';
import { RealtimeSpeechRenderer } from './realtime-speech-renderer';
import {
  SupabaseRealtimeSpeechStorage,
  type RealtimeSpeechStoragePort,
  type RealtimeSpeechSourcePolicyPort,
} from './realtime-speech-storage';
import type { RealtimeSidebandOwnerPort } from './realtime-sideband-owner';
import { RealtimeVoiceUsageWriter } from './realtime-voice-usage';
import {
  DisabledRealtimeDurableControlAuthority,
  RealtimeDurableControlAuthority,
} from './realtime-control';
import {
  DEFAULT_MISTRAL_REALTIME_INGRESS_TICKET_POLICY,
  DisabledMistralRealtimeIngressTicketAuthority,
  type MistralRealtimeIngressTicketAuthority,
} from './realtime-mistral-ingress-ticket';
import { MistralRealtimeAgentSink } from './mistral-realtime-agent-sink';
import { MistralRealtimeGatewayProviderAdapter } from './mistral-realtime-gateway-provider';
import { MistralRealtimeTerminationAuthority } from './mistral-realtime-termination';
import { MistralConversationTerminationRouter } from './mistral-conversation-reaper-termination';
import {
  RealtimeProviderTerminationRegistry,
  realtimeProviderTerminationAdapter,
} from './realtime-provider-registry';
import {
  createMistralRealtimeUpgradeAdapter,
  isSecureMistralRequestBehindTrustedProxy,
} from './mistral-realtime-upgrade';
import {
  createMistralConversationTerminalReplayRuntime,
  type MistralConversationTerminalReplayRuntime,
} from './mistral-conversation-terminal-replay';
import { DisabledMistralConversationResumeAuthority } from './mistral-conversation-resume-ticket';
import { DisabledMistralConversationBootstrapTicketAuthority } from './mistral-conversation-bootstrap-ticket';
import { OpenAiNativeSpeechMaintenanceScheduler } from './openai-native-speech-maintenance.scheduler';
import { OpenAiNativeSpeechAuthority } from './openai-native-speech-authority';
import { OpenAiNativeSpeechAcknowledgementService } from './openai-native-speech-acknowledgement';
import {
  ActiveMistralRealtimeIngressRuntime,
  DisabledMistralRealtimeIngressRuntime,
} from './mistral-realtime-runtime';
import {
  MISTRAL_REALTIME_INGRESS_TICKETS,
  MISTRAL_REALTIME_INGRESS_RUNTIME,
  MISTRAL_REALTIME_TERMINATION_AUTHORITY,
  MISTRAL_CONVERSATION_RESUME_AUTHORITY,
  MISTRAL_CONVERSATION_BOOTSTRAP_AUTHORITY,
  MISTRAL_CONVERSATION_TERMINAL_REPLAY_RUNTIME,
  OPENAI_NATIVE_SPEECH_MAINTENANCE,
  OPENAI_REALTIME_CALL_PROVIDER,
  REALTIME_ADMISSION,
  REALTIME_AGENT_MISSION_ADMISSION,
  REALTIME_GLOBAL_CAPACITY_INSPECTOR,
  REALTIME_MISSION_KIND_REGISTRY,
  REALTIME_AGENT_TURN,
  REALTIME_ENTITLEMENT,
  REALTIME_DURABLE_CONTROLS,
  REALTIME_PROVIDER_TERMINATION_REGISTRY,
  REALTIME_SIDEBAND,
  REALTIME_VOICE_SETTINGS,
  REALTIME_SPEECH_SOURCE_POLICY,
  BOB_LIVE_RUNTIME_READINESS,
} from './realtime.tokens';
import {
  type OpenAiRealtimeCallProvider,
  type RealtimeVoiceSettings,
} from './realtime.types';
import { realtimeVoiceSettingsProvider } from './realtime-settings.provider';
import {
  AuditedBobLiveRuntimeReadiness,
  gateRealtimeAdmissionOnBobLiveReadiness,
  NonAuditedBobLiveRuntimeReadiness,
  type BobLiveRuntimeReadinessPort,
} from './realtime-readiness';
import {
  RealtimeSpeechAcousticProbe,
  type BobLiveAcousticProofPort,
} from './realtime-acoustic-probe';

const REALTIME_SPEECH_RUNTIME = Symbol('REALTIME_SPEECH_RUNTIME');

interface RealtimeCommonSpeechRuntime {
  readonly owner: RealtimeSidebandOwnerPort;
  readonly usage: RealtimeVoiceUsageWriter;
}

interface RealtimeAuditedSpeechRuntime {
  readonly auditHealth: Pick<SttPort, 'health'>;
  readonly acousticProof: BobLiveAcousticProofPort;
  readonly storage: RealtimeSpeechStoragePort;
  readonly sourcePolicy: RealtimeSpeechSourcePolicyPort;
  readonly publisher: RealtimeSpeechPublisher;
  readonly deliveryRepository: RealtimeSpeechDeliveryRepositoryPort;
  readonly controls: RealtimeDurableControlAuthority;
}

interface RealtimeNativeSpeechRuntime {
  readonly authority: OpenAiNativeSpeechAuthority;
}

type RealtimeSpeechRuntime = RealtimeCommonSpeechRuntime & (
  | {
      readonly audited: RealtimeAuditedSpeechRuntime;
      readonly native?: never;
    }
  | {
      readonly audited?: never;
      readonly native: RealtimeNativeSpeechRuntime;
    }
);

function buildRealtimeCommonSpeechRuntime(
  persistence: Persistence,
  usageHmacSecret: string,
  usageKeyVersion: number,
): RealtimeCommonSpeechRuntime {
  return Object.freeze({
    owner: persistence.createRealtimeSidebandOwner(),
    usage: new RealtimeVoiceUsageWriter(persistence.createRealtimeVoiceUsageRepository(), {
      proofSecret: usageHmacSecret,
      proofKeyVersion: usageKeyVersion,
    }),
  });
}

/**
 * Composition root de la sortie Bob Live : owner et métrologie sont communs, puis une seule branche
 * de restitution est assemblée. L'audité exige stockage privé + TTS + audit indépendant ; le natif
 * OpenAI exige uniquement son autorité durable. Aucun mode ne retombe implicitement sur l'autre.
 */
export function buildRealtimeSpeechRuntime(
  persistence: Persistence,
  env: Env = loadEnv(),
): RealtimeSpeechRuntime | null {
  const live = resolveBobLiveEnv(env);
  if (!live.enabled) return null;
  if (live.speechDelivery === 'openai-native-webrtc-v1') {
    if (
      live.provider !== 'openai'
      || !live.subjectHmacKeyRing
      || !live.proofKeyRing
      || !live.usageHmacSecret
    ) {
      throw new Error('Bob Live OpenAI native speech runtime is incompletely configured.');
    }
    const common = buildRealtimeCommonSpeechRuntime(
      persistence,
      live.usageHmacSecret,
      live.usageKeyVersion,
    );
    const authority = new OpenAiNativeSpeechAuthority(
      persistence.createOpenAiNativeSpeechDeliveryRepository(),
      {
        proofKeys: live.proofKeyRing,
      },
    );
    return Object.freeze({
      ...common,
      native: Object.freeze({ authority }),
    });
  }

  if (
    !live.proofSecret
    || !live.controlEncryptionSecret
    || !live.usageHmacSecret
    || !env.SUPABASE_URL
    || !env.SUPABASE_SERVICE_ROLE_KEY
  ) {
    throw new Error('Bob Live audited speech runtime is incompletely configured.');
  }
  const proofSecret = live.proofSecret;
  const controlEncryptionSecret = live.controlEncryptionSecret;
  const supabaseUrl = env.SUPABASE_URL;
  const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;

  // La composition consomme la configuration déjà validée, jamais un fallback implicite basé
  // sur la présence fortuite de la clé concurrente dans `process.env`.
  const tts = buildRealtimeSpeechTts(live.provider);
  const auditStt = buildRealtimeSpeechAuditStt(live.auditProvider);
  if (!tts || !auditStt) {
    throw new Error('Bob Live audited speech providers are unavailable.');
  }
  const deploymentControls = auditStt as SttPort
    & Partial<LocalWhisperAuditDeploymentProbePort>;
  if (typeof deploymentControls.proveDeploymentControls !== 'function') {
    throw new Error('Bob Live local Whisper deployment proof is unavailable.');
  }
  const proveDeploymentControls =
    deploymentControls.proveDeploymentControls.bind(deploymentControls);

  const storage = new SupabaseRealtimeSpeechStorage({
    url: supabaseUrl,
    serviceRoleKey: supabaseServiceRoleKey,
    bucket: env.SUPABASE_REALTIME_AUDIO_BUCKET,
    requestTimeoutMs: 2_000,
  });
  const deliveryRepository = persistence.createRealtimeSpeechDeliveryRepository();
  const renderer = new RealtimeSpeechRenderer({
    synthesizer: new BobAiRealtimeSpeechSynthesisAdapter(tts),
    auditor: new BobAiRealtimeSpeechAuditAdapter(auditStt),
  });
  const acousticProof = new RealtimeSpeechAcousticProbe(renderer, {
    proveDeploymentControls,
  });
  const common = buildRealtimeCommonSpeechRuntime(
    persistence,
    live.usageHmacSecret,
    live.usageKeyVersion,
  );
  const controls = new RealtimeDurableControlAuthority(
    persistence.createRealtimeControlRepository(),
    {
      sealKeys: {
        encryptionSecret: controlEncryptionSecret,
        encryptionKeyVersion: live.controlEncryptionKeyVersion,
        proofSecret,
        proofKeyVersion: live.proofKeyVersion,
      },
      keyRing: {
        encryptionSecret: (version) =>
          version === live.controlEncryptionKeyVersion ? controlEncryptionSecret : null,
        proofSecret: (version) => (version === live.proofKeyVersion ? proofSecret : null),
      },
    },
  );
  const publisher = new RealtimeSpeechPublisher({
    renderer,
    repository: persistence.createRealtimeSpeechArtifactRepository(),
    storage,
    proofSecret,
    proofKeyVersion: live.proofKeyVersion,
  });

  return Object.freeze({
    ...common,
    audited: Object.freeze({
      auditHealth: auditStt,
      acousticProof,
      storage,
      sourcePolicy: storage,
      deliveryRepository,
      controls,
      publisher,
    }),
  });
}

/**
 * Porte de composition réellement utilisée par Nest. Les deux keyrings natifs sont admis par
 * PostgreSQL avant la création du moindre port request-time : une configuration locale cohérente
 * mais non stageée, retirée ou liée à un autre matériau fait échouer le boot.
 */
export async function buildVerifiedRealtimeSpeechRuntime(
  persistence: Persistence,
  env: Env = loadEnv(),
): Promise<RealtimeSpeechRuntime | null> {
  const live = resolveBobLiveEnv(env);
  if (
    !live.enabled
    || live.provider !== 'openai'
    || live.speechDelivery !== 'openai-native-webrtc-v1'
  ) return buildRealtimeSpeechRuntime(persistence, env);
  if (!live.subjectHmacKeyRing || !live.proofKeyRing) {
    throw new Error('Bob Live OpenAI native keyrings are incompletely configured.');
  }
  const keyVersions = persistence.createOpenAiNativeKeyVersionAuthority(
    live.subjectHmacKeyRing,
    live.proofKeyRing,
  );
  if (!keyVersions) {
    throw new Error('Bob Live OpenAI native PostgreSQL key authority is unavailable.');
  }
  await keyVersions.assertCurrentKeyVersions();
  return buildRealtimeSpeechRuntime(persistence, env);
}

const realtimeGlobalCapacityInspectorProvider: Provider = {
  provide: REALTIME_GLOBAL_CAPACITY_INSPECTOR,
  inject: [PERSISTENCE],
  useFactory: (persistence: Persistence) => persistence.createRealtimeGlobalCapacityInspector(),
};

const realtimeGlobalCapacityMonitorProvider: Provider = {
  provide: RealtimeGlobalCapacityMonitor,
  inject: [REALTIME_VOICE_SETTINGS, REALTIME_GLOBAL_CAPACITY_INSPECTOR, Metrics, AppLogger],
  useFactory: (
    settings: RealtimeVoiceSettings,
    inspector: ReturnType<Persistence['createRealtimeGlobalCapacityInspector']>,
    metrics: Metrics,
    logger: AppLogger,
  ) => new RealtimeGlobalCapacityMonitor(
    settings.enabled,
    resolveBobLiveEnv(loadEnv()).globalCapacity,
    inspector,
    metrics,
    logger,
  ),
};

const openAiProvider: Provider = {
  provide: OPENAI_REALTIME_CALL_PROVIDER,
  inject: [REALTIME_VOICE_SETTINGS],
  useFactory: (settings: RealtimeVoiceSettings) =>
    settings.provider === 'openai'
      ? new OpenAiRealtimeCallAdapter(settings)
      : new DisabledOpenAiRealtimeCallProvider(),
};

const mistralRealtimeTerminationAuthorityProvider: Provider = {
  provide: MISTRAL_REALTIME_TERMINATION_AUTHORITY,
  inject: [REALTIME_VOICE_SETTINGS],
  useFactory: (settings: RealtimeVoiceSettings) =>
    settings.provider === 'mistral'
      ? new MistralRealtimeTerminationAuthority()
      : null,
};

/**
 * Le kill-switch ferme les nouvelles admissions, jamais le drain des appels déjà persistés.
 * L'adapter du provider sélectionné reste donc enregistré même lorsque `enabled=false` ; retirer
 * ses credentials avant zéro lease relève du protocole de bascule C4, pas de ce switch runtime.
 */
export function buildRealtimeProviderTerminationRegistry(
  settings: RealtimeVoiceSettings,
  openAi: OpenAiRealtimeCallProvider,
  mistral: MistralRealtimeTerminationAuthority | null,
  conversation: MistralConversationTerminalReplayRuntime | null,
): RealtimeProviderTerminationRegistry {
  const adapters = [];
  if (settings.provider === 'openai') {
    adapters.push(realtimeProviderTerminationAdapter('openai', openAi));
  }
  if (mistral || conversation) {
    adapters.push(new MistralConversationTerminationRouter(
      mistral,
      conversation?.termination ?? null,
    ));
  }
  return new RealtimeProviderTerminationRegistry(adapters);
}

const providerTerminationRegistryProvider: Provider = {
  provide: REALTIME_PROVIDER_TERMINATION_REGISTRY,
  inject: [
    REALTIME_VOICE_SETTINGS,
    OPENAI_REALTIME_CALL_PROVIDER,
    MISTRAL_REALTIME_TERMINATION_AUTHORITY,
    MISTRAL_CONVERSATION_TERMINAL_REPLAY_RUNTIME,
  ],
  useFactory: (
    settings: RealtimeVoiceSettings,
    openAi: OpenAiRealtimeCallProvider,
    mistral: MistralRealtimeTerminationAuthority | null,
    conversation: MistralConversationTerminalReplayRuntime | null,
  ) => buildRealtimeProviderTerminationRegistry(settings, openAi, mistral, conversation),
};

const admissionProvider: Provider = {
  provide: REALTIME_ADMISSION,
  inject: [PERSISTENCE, BOB_LIVE_RUNTIME_READINESS],
  useFactory: (
    persistence: Persistence,
    readiness: BobLiveRuntimeReadinessPort,
  ) => gateRealtimeAdmissionOnBobLiveReadiness(
    persistence.createRealtimeAdmission(realtimeAdmissionPolicyFromEnv(loadEnv())),
    readiness,
  ),
};

const agentMissionAdmissionProvider: Provider = {
  provide: REALTIME_AGENT_MISSION_ADMISSION,
  inject: [PERSISTENCE],
  useFactory: (persistence: Persistence) =>
    buildRealtimeAgentMissionAdmissionGate(persistence, loadEnv()),
};

const mistralIngressTicketProvider: Provider = {
  provide: MISTRAL_REALTIME_INGRESS_TICKETS,
  inject: [PERSISTENCE],
  useFactory: (persistence: Persistence) => {
    const env = loadEnv();
    const live = resolveBobLiveEnv(env);
    if (!live.enabled || live.provider !== 'mistral') {
      return new DisabledMistralRealtimeIngressTicketAuthority();
    }
    if (!live.controlEncryptionSecret) {
      throw new Error('Bob Live Mistral ingress identity encryption is unavailable.');
    }
    const currentVersion = live.controlEncryptionKeyVersion;
    const currentSecret = live.controlEncryptionSecret;
    return persistence.createMistralRealtimeIngressTicketAuthority(
      {
        ...DEFAULT_MISTRAL_REALTIME_INGRESS_TICKET_POLICY,
        ticketTtlSeconds: Math.min(
          DEFAULT_MISTRAL_REALTIME_INGRESS_TICKET_POLICY.ticketTtlSeconds,
          live.reservationTtlSeconds,
        ),
        activationTtlSeconds: Math.min(
          DEFAULT_MISTRAL_REALTIME_INGRESS_TICKET_POLICY.activationTtlSeconds,
          live.reservationTtlSeconds,
        ),
        maxAudioBytes: live.maxSessionSeconds * 16_000 * 2,
      },
      {
        currentVersion,
        secret: (version) => (version === currentVersion ? currentSecret : null),
      },
    );
  },
};

const realtimeSpeechRuntimeProvider: Provider = {
  provide: REALTIME_SPEECH_RUNTIME,
  inject: [PERSISTENCE],
  useFactory: (persistence: Persistence) => buildVerifiedRealtimeSpeechRuntime(persistence),
};

export function buildBobLiveRuntimeReadiness(
  speech: RealtimeSpeechRuntime | null,
): BobLiveRuntimeReadinessPort {
  if (speech?.audited) {
    return new AuditedBobLiveRuntimeReadiness(
      speech.audited.auditHealth,
      speech.audited.acousticProof,
    );
  }
  return new NonAuditedBobLiveRuntimeReadiness(speech?.native ? 'native' : 'disabled');
}

const bobLiveRuntimeReadinessProvider: Provider = {
  provide: BOB_LIVE_RUNTIME_READINESS,
  inject: [REALTIME_SPEECH_RUNTIME],
  useFactory: buildBobLiveRuntimeReadiness,
};

const realtimeDurableControlProvider: Provider = {
  provide: REALTIME_DURABLE_CONTROLS,
  inject: [REALTIME_SPEECH_RUNTIME],
  useFactory: (speech: RealtimeSpeechRuntime | null) =>
    speech?.audited?.controls ?? new DisabledRealtimeDurableControlAuthority(),
};

export async function buildMistralConversationTerminalReplayRuntime(
  persistence: Pick<Persistence, 'createMistralConversationTerminalReplayAuthorities'>,
  env: Env = loadEnv(),
): Promise<MistralConversationTerminalReplayRuntime | null> {
  const live = resolveBobLiveEnv(env);
  if (!live.mistralV2TerminalReplayEnabled) return null;
  const keys = resolveMistralConversationPersistenceKeyRing(env);
  if (!keys) throw new Error('Mistral conversation persistence keyring is unavailable.');
  const identityKeys = resolveMistralV2IdentityEncryptionKeyRing(env);
  if (live.mistralV2InitialBootstrapEnabled && !identityKeys) {
    throw new Error('Mistral conversation bootstrap identity keyring is unavailable.');
  }
  const subjectKeys = live.subjectHmacKeyRing;
  if (!subjectKeys || subjectKeys.secret(subjectKeys.currentVersion) === null) {
    throw new Error('Bob Live subject HMAC keyring is unavailable for durable replay.');
  }
  const authorities = persistence.createMistralConversationTerminalReplayAuthorities(
    keys,
    identityKeys,
    subjectKeys,
    {
      activeLeaseSeconds: live.activeLeaseSeconds,
      heartbeatSeconds: live.heartbeatSeconds,
    },
  );
  if (!authorities) {
    throw new Error('Mistral conversation PostgreSQL terminal replay authority is unavailable.');
  }
  if (live.mistralV2InitialBootstrapEnabled && !authorities.initialBootstrap) {
    throw new Error('Mistral conversation PostgreSQL bootstrap authority is unavailable.');
  }
  await authorities.assertCurrentKeyVersion();
  return createMistralConversationTerminalReplayRuntime(authorities);
}

const mistralConversationTerminalReplayRuntimeProvider: Provider = {
  provide: MISTRAL_CONVERSATION_TERMINAL_REPLAY_RUNTIME,
  inject: [PERSISTENCE],
  useFactory: (
    persistence: Persistence,
  ): Promise<MistralConversationTerminalReplayRuntime | null> =>
    buildMistralConversationTerminalReplayRuntime(persistence),
};

const mistralConversationResumeAuthorityProvider: Provider = {
  provide: MISTRAL_CONVERSATION_RESUME_AUTHORITY,
  inject: [MISTRAL_CONVERSATION_TERMINAL_REPLAY_RUNTIME],
  useFactory: (runtime: MistralConversationTerminalReplayRuntime | null) =>
    runtime?.resume ?? new DisabledMistralConversationResumeAuthority(),
};

const mistralConversationBootstrapAuthorityProvider: Provider = {
  provide: MISTRAL_CONVERSATION_BOOTSTRAP_AUTHORITY,
  inject: [MISTRAL_CONVERSATION_TERMINAL_REPLAY_RUNTIME],
  useFactory: (runtime: MistralConversationTerminalReplayRuntime | null) =>
    runtime?.initialBootstrap ?? new DisabledMistralConversationBootstrapTicketAuthority(),
};

export function buildMistralConversationBootstrapReaperOptions(
  env: Env = loadEnv(),
): MistralConversationBootstrapReaperOptions {
  const live = resolveBobLiveEnv(env);
  return Object.freeze({
    // Aucun second feature flag : le replay terminal implique sa rétention, y compris en drain.
    enabled: live.mistralV2TerminalReplayEnabled,
    intervalMs: live.mistralV2BootstrapReaperIntervalMs,
    batchSize: live.mistralV2BootstrapReaperBatchSize,
    maxBatchesPerSweep: live.mistralV2BootstrapReaperMaxBatches,
  });
}

const mistralConversationBootstrapReaperProvider: Provider = {
  provide: MISTRAL_CONVERSATION_BOOTSTRAP_REAPER,
  inject: [PERSISTENCE],
  useFactory: (persistence: Persistence) =>
    persistence.createMistralConversationBootstrapReaper(),
};

const mistralConversationBootstrapReaperOptionsProvider: Provider = {
  provide: MISTRAL_CONVERSATION_BOOTSTRAP_REAPER_OPTIONS,
  useFactory: () => buildMistralConversationBootstrapReaperOptions(),
};

const mistralRealtimeIngressRuntimeProvider: Provider = {
  provide: MISTRAL_REALTIME_INGRESS_RUNTIME,
  inject: [
    REALTIME_VOICE_SETTINGS,
    MISTRAL_REALTIME_INGRESS_TICKETS,
    REALTIME_ADMISSION,
    REALTIME_AGENT_TURN,
    REALTIME_SPEECH_RUNTIME,
    MISTRAL_REALTIME_TERMINATION_AUTHORITY,
    MISTRAL_CONVERSATION_TERMINAL_REPLAY_RUNTIME,
  ],
  useFactory: (
    settings: RealtimeVoiceSettings,
    tickets: MistralRealtimeIngressTicketAuthority,
    admission: ReturnType<Persistence['createRealtimeAdmission']>,
    agentTurns: RealtimeBobAgentTurnAdapter,
    speech: RealtimeSpeechRuntime | null,
    terminations: MistralRealtimeTerminationAuthority | null,
    terminalReplay: MistralConversationTerminalReplayRuntime | null,
  ) => {
    if (!settings.enabled || settings.provider !== 'mistral') {
      return new DisabledMistralRealtimeIngressRuntime();
    }
    const audited = speech?.audited;
    if (!speech || !audited || !terminations)
      throw new Error('Bob Live Mistral audited runtime is unavailable.');
    const env = loadEnv();
    const live = resolveBobLiveEnv(env);
    const provider = new MistralRealtimeGatewayProviderAdapter(settings);
    const sink = new MistralRealtimeAgentSink({
      admission,
      owners: speech.owner,
      agentTurns,
      speech: audited.publisher,
      usage: speech.usage,
      controls: audited.controls,
      cancellation: audited.deliveryRepository,
    });
    const adapter = createMistralRealtimeUpgradeAdapter(
      {
        allowedBrowserOrigins: allowedCorsOrigins(env),
        maxConnections: live.gatewayMaxConnections,
        shutdownGraceMs: live.gatewayShutdownGraceMs,
      },
      {
        createGatewayDependencies: () => ({ tickets, provider, terminations, sink }),
        ...(terminalReplay
          ? {
              conversationV2: {
                createGatewayDependencies: () => terminalReplay.gatewayDependencies,
              },
            }
          : {}),
        ...(live.gatewayTlsMode === 'trusted-proxy'
          ? { isSecureRequest: isSecureMistralRequestBehindTrustedProxy }
          : {}),
      },
    );
    return new ActiveMistralRealtimeIngressRuntime(adapter);
  },
};

const sidebandProvider: Provider = {
  provide: REALTIME_SIDEBAND,
  inject: [
    REALTIME_VOICE_SETTINGS,
    OPENAI_REALTIME_CALL_PROVIDER,
    Metrics,
    AppLogger,
    REALTIME_SPEECH_RUNTIME,
  ],
  useFactory: (
    settings: RealtimeVoiceSettings,
    callProvider: OpenAiRealtimeCallProvider,
    metrics: Metrics,
    logger: AppLogger,
    speech: RealtimeSpeechRuntime | null,
  ) =>
    new RealtimeSidebandManager(
      settings,
      callProvider,
      metrics,
      logger,
      undefined,
      speech
        ? {
            owner: speech.owner,
            ...(speech.audited
              ? {
                  audited: {
                    publisher: speech.audited.publisher,
                    cancellation: speech.audited.deliveryRepository,
                    controls: speech.audited.controls,
                  },
                }
              : {}),
            ...(speech.native
              ? {
                  native: {
                    authority: speech.native.authority,
                    usage: speech.usage,
                  },
                }
              : {}),
          }
        : undefined,
    ),
};

const realtimeMissionKindRegistryProvider: Provider = {
  provide: REALTIME_MISSION_KIND_REGISTRY,
  inject: [REALTIME_VOICE_SETTINGS, AgentMissionService],
  useFactory: (
    settings: RealtimeVoiceSettings,
    missions: AgentMissionService,
  ) => {
    const llm = buildLlmForProvider(settings.provider);
    return new RealtimeMissionKindRegistry([
      new QuoteCreationMissionKindAdapter(
        llm === undefined ? null : new RealtimeQuoteMissionOrchestrator(llm, missions),
      ),
    ]);
  },
};

const realtimeAgentTurnProvider: Provider = {
  provide: REALTIME_AGENT_TURN,
  inject: [
    PERSISTENCE,
    REALTIME_VOICE_SETTINGS,
    ModuleRef,
    REALTIME_MISSION_KIND_REGISTRY,
  ],
  useFactory: (
    persistence: Persistence,
    settings: RealtimeVoiceSettings,
    moduleRef: ModuleRef,
    missionKinds: RealtimeMissionKindRegistry,
  ) => new RealtimeBobAgentTurnAdapter(
    persistence,
    settings.provider,
    // Résolution tardive : RealtimeVoiceModule est enfant d'AppModule, qui possède BackendService.
    // `strict:false` traverse le conteneur sans introduire un cycle de modules Nest.
    () => moduleRef.get(BackendService, { strict: false }),
    missionKinds.get(QUOTE_CREATION_MISSION_KIND_V1),
  ),
};

const realtimeEntitlementProvider: Provider = {
  provide: REALTIME_ENTITLEMENT,
  inject: [PERSISTENCE, ModuleRef],
  useFactory: (persistence: Persistence, moduleRef: ModuleRef) =>
    new RealtimeBackendEntitlementAdapter(persistence, () =>
      moduleRef.get(BackendService, { strict: false }),
    ),
};

const realtimeReaperDirectoryProvider: Provider = {
  provide: REALTIME_REAPER_DIRECTORY,
  inject: [PERSISTENCE],
  useFactory: (persistence: Persistence) => persistence.createRealtimeReaperDirectory(),
};

const openAiNativeSpeechMaintenanceProvider: Provider = {
  provide: OPENAI_NATIVE_SPEECH_MAINTENANCE,
  inject: [PERSISTENCE],
  useFactory: (persistence: Persistence) => persistence.createOpenAiNativeSpeechMaintenance(),
};

const realtimeSpeechDeliveryProvider: Provider = {
  provide: RealtimeSpeechDeliveryService,
  inject: [AppLogger, REALTIME_SPEECH_RUNTIME],
  useFactory: (
    logger: AppLogger,
    speech: RealtimeSpeechRuntime | null,
  ) => {
    const env = loadEnv();
    const live = resolveBobLiveEnv(env);
    const audited = speech?.audited;
    return new RealtimeSpeechDeliveryService(
      audited?.deliveryRepository ?? new DisabledRealtimeSpeechDeliveryRepository(),
      audited?.storage ?? null,
      {
        enabled: live.enabled && live.speechDelivery === 'audited-signed-url-v1',
        subjectHmacSecret: live.subjectHmacSecret,
        proofSecret: live.proofSecret,
        proofKeyVersion: live.proofKeyVersion,
      },
      logger,
    );
  },
};

const openAiNativeSpeechAcknowledgementProvider: Provider = {
  provide: OpenAiNativeSpeechAcknowledgementService,
  inject: [AppLogger, REALTIME_SPEECH_RUNTIME],
  useFactory: (
    logger: AppLogger,
    speech: RealtimeSpeechRuntime | null,
  ) => {
    const live = resolveBobLiveEnv(loadEnv());
    return new OpenAiNativeSpeechAcknowledgementService(
      speech?.native?.authority ?? null,
      {
        enabled: live.enabled
          && live.provider === 'openai'
          && live.speechDelivery === 'openai-native-webrtc-v1',
        subjectHmacKeyRing: live.subjectHmacKeyRing,
      },
      logger,
    );
  },
};

const realtimeSpeechSourcePolicyProvider: Provider = {
  provide: REALTIME_SPEECH_SOURCE_POLICY,
  inject: [REALTIME_SPEECH_RUNTIME],
  useFactory: (speech: RealtimeSpeechRuntime | null): RealtimeSpeechSourcePolicyPort | null =>
    speech?.audited?.sourcePolicy ?? null,
};

@Module({
  imports: [PersistenceModule, AgentMissionModule],
  controllers: [RealtimeVoiceController],
  providers: [
    realtimeVoiceSettingsProvider,
    openAiProvider,
    mistralRealtimeTerminationAuthorityProvider,
    providerTerminationRegistryProvider,
    admissionProvider,
    agentMissionAdmissionProvider,
    realtimeGlobalCapacityInspectorProvider,
    realtimeGlobalCapacityMonitorProvider,
    mistralIngressTicketProvider,
    realtimeSpeechRuntimeProvider,
    bobLiveRuntimeReadinessProvider,
    realtimeDurableControlProvider,
    mistralConversationTerminalReplayRuntimeProvider,
    mistralConversationResumeAuthorityProvider,
    mistralConversationBootstrapAuthorityProvider,
    mistralConversationBootstrapReaperProvider,
    mistralConversationBootstrapReaperOptionsProvider,
    realtimeMissionKindRegistryProvider,
    realtimeAgentTurnProvider,
    realtimeEntitlementProvider,
    sidebandProvider,
    realtimeReaperDirectoryProvider,
    openAiNativeSpeechMaintenanceProvider,
    realtimeSpeechDeliveryProvider,
    openAiNativeSpeechAcknowledgementProvider,
    realtimeSpeechSourcePolicyProvider,
    mistralRealtimeIngressRuntimeProvider,
    RealtimeAdmissionReaperScheduler,
    MistralConversationBootstrapReaperScheduler,
    OpenAiNativeSpeechMaintenanceScheduler,
    RealtimeVoiceService,
  ],
  exports: [MISTRAL_REALTIME_INGRESS_RUNTIME, BOB_LIVE_RUNTIME_READINESS],
})
export class RealtimeVoiceModule {}
