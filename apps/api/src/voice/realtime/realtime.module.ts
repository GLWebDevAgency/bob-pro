import { Module, type Provider } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { buildRealtimeSpeechAuditStt, buildRealtimeSpeechTts } from '../../ai/providers';
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
import { RealtimeBackendEntitlementAdapter } from './realtime-entitlement';
import { RealtimeSpeechDeliveryService } from './realtime-speech-delivery';
import type { RealtimeSpeechDeliveryRepositoryPort } from './realtime-speech-delivery.repository';
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
  REALTIME_AGENT_TURN,
  REALTIME_ENTITLEMENT,
  REALTIME_DURABLE_CONTROLS,
  REALTIME_PROVIDER_TERMINATION_REGISTRY,
  REALTIME_SIDEBAND,
  REALTIME_VOICE_SETTINGS,
  REALTIME_SPEECH_SOURCE_POLICY,
} from './realtime.tokens';
import {
  realtimeVoiceSettingsFromEnv,
  type OpenAiRealtimeCallProvider,
  type RealtimeVoiceSettings,
} from './realtime.types';

const REALTIME_SPEECH_RUNTIME = Symbol('REALTIME_SPEECH_RUNTIME');

interface RealtimeSpeechRuntime {
  readonly storage: RealtimeSpeechStoragePort;
  readonly sourcePolicy: RealtimeSpeechSourcePolicyPort;
  readonly publisher: RealtimeSpeechPublisher;
  readonly owner: RealtimeSidebandOwnerPort;
  readonly deliveryRepository: RealtimeSpeechDeliveryRepositoryPort;
  readonly usage: RealtimeVoiceUsageWriter;
  readonly controls: RealtimeDurableControlAuthority;
}

/**
 * Composition root de la sortie Bob Live : le fournisseur ne devient jamais une dépendance du
 * service métier. Une session activée sans stockage privé, TTS qualifié ou audit indépendant fait
 * échouer le démarrage au lieu de retomber silencieusement sur une sortie audio non auditée.
 */
export function buildRealtimeSpeechRuntime(
  persistence: Persistence,
  env: Env = loadEnv(),
): RealtimeSpeechRuntime | null {
  const live = resolveBobLiveEnv(env);
  if (!live.enabled) return null;
  if (
    !live.proofSecret ||
    !live.controlEncryptionSecret ||
    !live.usageHmacSecret ||
    !env.SUPABASE_URL ||
    !env.SUPABASE_SERVICE_ROLE_KEY
  ) {
    throw new Error('Bob Live audited speech runtime is incompletely configured.');
  }

  // La composition consomme la configuration déjà validée, jamais un fallback implicite basé
  // sur la présence fortuite de la clé concurrente dans `process.env`.
  const tts = buildRealtimeSpeechTts(live.provider);
  const auditStt = buildRealtimeSpeechAuditStt(live.auditProvider);
  if (!tts || !auditStt) {
    throw new Error('Bob Live audited speech providers are unavailable.');
  }

  const storage = new SupabaseRealtimeSpeechStorage({
    url: env.SUPABASE_URL,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    bucket: env.SUPABASE_REALTIME_AUDIO_BUCKET,
    requestTimeoutMs: 2_000,
  });
  const deliveryRepository = persistence.createRealtimeSpeechDeliveryRepository();
  const renderer = new RealtimeSpeechRenderer({
    synthesizer: new BobAiRealtimeSpeechSynthesisAdapter(tts),
    auditor: new BobAiRealtimeSpeechAuditAdapter(auditStt),
  });

  return Object.freeze({
    storage,
    sourcePolicy: storage,
    deliveryRepository,
    owner: persistence.createRealtimeSidebandOwner(),
    usage: new RealtimeVoiceUsageWriter(persistence.createRealtimeVoiceUsageRepository(), {
      proofSecret: live.usageHmacSecret,
      proofKeyVersion: live.usageKeyVersion,
    }),
    controls: new RealtimeDurableControlAuthority(persistence.createRealtimeControlRepository(), {
      sealKeys: {
        encryptionSecret: live.controlEncryptionSecret,
        encryptionKeyVersion: live.controlEncryptionKeyVersion,
        proofSecret: live.proofSecret,
        proofKeyVersion: live.proofKeyVersion,
      },
      keyRing: {
        encryptionSecret: (version) =>
          version === live.controlEncryptionKeyVersion ? live.controlEncryptionSecret : null,
        proofSecret: (version) => (version === live.proofKeyVersion ? live.proofSecret : null),
      },
    }),
    publisher: new RealtimeSpeechPublisher({
      renderer,
      repository: persistence.createRealtimeSpeechArtifactRepository(),
      storage,
      proofSecret: live.proofSecret,
      proofKeyVersion: live.proofKeyVersion,
    }),
  });
}

const settingsProvider: Provider = {
  provide: REALTIME_VOICE_SETTINGS,
  useFactory: (): RealtimeVoiceSettings => realtimeVoiceSettingsFromEnv(loadEnv()),
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
  inject: [PERSISTENCE],
  useFactory: (persistence: Persistence) =>
    persistence.createRealtimeAdmission(realtimeAdmissionPolicyFromEnv(loadEnv())),
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
  useFactory: (persistence: Persistence) => buildRealtimeSpeechRuntime(persistence),
};

const realtimeDurableControlProvider: Provider = {
  provide: REALTIME_DURABLE_CONTROLS,
  inject: [REALTIME_SPEECH_RUNTIME],
  useFactory: (speech: RealtimeSpeechRuntime | null) =>
    speech?.controls ?? new DisabledRealtimeDurableControlAuthority(),
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
    if (!speech || !terminations)
      throw new Error('Bob Live Mistral audited runtime is unavailable.');
    const env = loadEnv();
    const live = resolveBobLiveEnv(env);
    const provider = new MistralRealtimeGatewayProviderAdapter(settings);
    const sink = new MistralRealtimeAgentSink({
      admission,
      owners: speech.owner,
      agentTurns,
      speech: speech.publisher,
      usage: speech.usage,
      controls: speech.controls,
      cancellation: speech.deliveryRepository,
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
            publisher: speech.publisher,
            cancellation: speech.deliveryRepository,
            controls: speech.controls,
          }
        : undefined,
    ),
};

const realtimeAgentTurnProvider: Provider = {
  provide: REALTIME_AGENT_TURN,
  inject: [PERSISTENCE, REALTIME_VOICE_SETTINGS, ModuleRef],
  useFactory: (
    persistence: Persistence,
    settings: RealtimeVoiceSettings,
    moduleRef: ModuleRef,
  ) =>
    new RealtimeBobAgentTurnAdapter(
      persistence,
      settings.provider,
      // Résolution tardive : RealtimeVoiceModule est enfant d'AppModule, qui possède BackendService.
      // `strict:false` traverse le conteneur sans introduire un cycle de modules Nest.
      () => moduleRef.get(BackendService, { strict: false }),
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
  inject: [PERSISTENCE, AppLogger, REALTIME_SPEECH_RUNTIME],
  useFactory: (
    persistence: Persistence,
    logger: AppLogger,
    speech: RealtimeSpeechRuntime | null,
  ) => {
    const env = loadEnv();
    const live = resolveBobLiveEnv(env);
    return new RealtimeSpeechDeliveryService(
      speech?.deliveryRepository ?? persistence.createRealtimeSpeechDeliveryRepository(),
      speech?.storage ?? null,
      {
        enabled: live.enabled,
        subjectHmacSecret: live.subjectHmacSecret,
        proofSecret: live.proofSecret,
        proofKeyVersion: live.proofKeyVersion,
      },
      logger,
    );
  },
};

const realtimeSpeechSourcePolicyProvider: Provider = {
  provide: REALTIME_SPEECH_SOURCE_POLICY,
  inject: [REALTIME_SPEECH_RUNTIME],
  useFactory: (speech: RealtimeSpeechRuntime | null): RealtimeSpeechSourcePolicyPort | null =>
    speech?.sourcePolicy ?? null,
};

@Module({
  imports: [PersistenceModule],
  controllers: [RealtimeVoiceController],
  providers: [
    settingsProvider,
    openAiProvider,
    mistralRealtimeTerminationAuthorityProvider,
    providerTerminationRegistryProvider,
    admissionProvider,
    mistralIngressTicketProvider,
    realtimeSpeechRuntimeProvider,
    realtimeDurableControlProvider,
    mistralConversationTerminalReplayRuntimeProvider,
    mistralConversationResumeAuthorityProvider,
    mistralConversationBootstrapAuthorityProvider,
    mistralConversationBootstrapReaperProvider,
    mistralConversationBootstrapReaperOptionsProvider,
    realtimeAgentTurnProvider,
    realtimeEntitlementProvider,
    sidebandProvider,
    realtimeReaperDirectoryProvider,
    openAiNativeSpeechMaintenanceProvider,
    realtimeSpeechDeliveryProvider,
    realtimeSpeechSourcePolicyProvider,
    mistralRealtimeIngressRuntimeProvider,
    RealtimeAdmissionReaperScheduler,
    MistralConversationBootstrapReaperScheduler,
    OpenAiNativeSpeechMaintenanceScheduler,
    RealtimeVoiceService,
  ],
  exports: [MISTRAL_REALTIME_INGRESS_RUNTIME],
})
export class RealtimeVoiceModule {}
