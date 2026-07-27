import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FactoryProvider, Provider } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { ModuleRef } from '@nestjs/core';
import { loadEnv, type Env } from '../../config/env';
import type { Persistence } from '../../persistence/persistence';
import { PERSISTENCE } from '../../persistence/persistence-token';
import type { MistralConversationDurableAuthority } from './mistral-conversation-gateway-v2';
import type { MistralConversationPersistenceKeyRing } from './mistral-conversation-outbox-seal';
import { DisabledMistralConversationResumeAuthority } from './mistral-conversation-resume-ticket';
import { DisabledMistralConversationBootstrapTicketAuthority } from './mistral-conversation-bootstrap-ticket';
import { DisabledMistralConversationAdmissionAuthority } from './mistral-conversation-admission';
import {
  openMistralRealtimeUserIdentity,
  sealMistralRealtimeUserIdentity,
  type MistralRealtimeIdentityBinding,
  type MistralRealtimeIngressIdentityKeyRing,
} from './realtime-mistral-ingress-ticket';
import { RealtimeBobAgentTurnAdapter } from './realtime-agent-turn';
import {
  BOB_LIVE_RUNTIME_READINESS,
  REALTIME_ADMISSION,
  REALTIME_DURABLE_CONTROLS,
  REALTIME_AGENT_MISSION_ADMISSION,
  OPENAI_NATIVE_SPEECH_MAINTENANCE,
  MISTRAL_REALTIME_TERMINATION_AUTHORITY,
  REALTIME_AGENT_TURN,
  REALTIME_SIDEBAND,
  REALTIME_SPEECH_SOURCE_POLICY,
  REALTIME_VOICE_SETTINGS,
} from './realtime.tokens';
import { DurableRealtimeAgentMissionAdmissionGate } from './realtime-agent-mission-admission';
import { OpenAiNativeSpeechMaintenanceScheduler } from './openai-native-speech-maintenance.scheduler';
import { OpenAiNativeSpeechAuthority } from './openai-native-speech-authority';
import { OpenAiNativeSpeechAcknowledgementService } from './openai-native-speech-acknowledgement';
import { REALTIME_REAPER_DIRECTORY } from './realtime-reaper.scheduler';
import type { RealtimeVoiceSettings } from './realtime.types';
import { MistralRealtimeTerminationAuthority } from './mistral-realtime-termination';
import { DisabledRealtimeDurableControlAuthority } from './realtime-control';
import { RealtimeVoiceUsageWriter } from './realtime-voice-usage';
import { RealtimeSpeechAcousticProbe } from './realtime-acoustic-probe';
import {
  buildMistralConversationBootstrapReaperOptions,
  buildMistralConversationTerminalReplayRuntime,
  buildRealtimeSpeechRuntime,
  buildVerifiedRealtimeSpeechRuntime,
  RealtimeVoiceModule,
} from './realtime.module';

type RealtimeAgentTurnFactoryProvider = FactoryProvider & {
  provide: typeof REALTIME_AGENT_TURN;
};

function isRealtimeAgentTurnFactoryProvider(
  provider: Provider,
): provider is RealtimeAgentTurnFactoryProvider {
  return typeof provider === 'object'
    && provider !== null
    && 'provide' in provider
    && provider.provide === REALTIME_AGENT_TURN
    && 'inject' in provider
    && Array.isArray(provider.inject)
    && 'useFactory' in provider
    && typeof provider.useFactory === 'function';
}

function moduleFactory(token: unknown): FactoryProvider {
  const providers = Reflect.getMetadata(
    MODULE_METADATA.PROVIDERS,
    RealtimeVoiceModule,
  ) as Provider[];
  const provider = providers.find((candidate) =>
    typeof candidate === 'object'
    && candidate !== null
    && 'provide' in candidate
    && candidate.provide === token);
  if (!provider || !('useFactory' in provider) || typeof provider.useFactory !== 'function') {
    throw new Error('RealtimeVoiceModule factory provider is unavailable.');
  }
  return provider as FactoryProvider;
}

function validMistralEnvironment(): void {
  vi.stubEnv('DEMO_MODE', 'true');
  vi.stubEnv('BOB_LIVE_ENABLED', 'true');
  vi.stubEnv('BOB_LIVE_PROVIDER', 'mistral');
  vi.stubEnv('BOB_LIVE_GLOBAL_MAX_CONCURRENT_SESSIONS', '100');
  vi.stubEnv('BOB_LIVE_PROVIDER_MAX_CONCURRENT_SESSIONS', '100');
  vi.stubEnv('BOB_LIVE_CAPACITY_CONFIG_VERSION', '1');
  vi.stubEnv('MISTRAL_API_KEY', 'test-mistral-key');
  vi.stubEnv('BOB_LIVE_SUBJECT_HMAC_SECRET', 'i'.repeat(32));
  vi.stubEnv('BOB_LIVE_SUBJECT_KEY_VERSION', '1');
  vi.stubEnv('BOB_LIVE_SUBJECT_HMAC_KEYRING', JSON.stringify({ 1: 'i'.repeat(32) }));
  vi.stubEnv('BOB_LIVE_PROOF_SECRET', 'p'.repeat(32));
  vi.stubEnv('BOB_LIVE_PROOF_KEY_VERSION', '1');
  vi.stubEnv('BOB_LIVE_PROOF_KEYRING', JSON.stringify({ 1: 'p'.repeat(32) }));
  vi.stubEnv('BOB_LIVE_USAGE_HMAC_SECRET', 'u'.repeat(32));
  vi.stubEnv('BOB_LIVE_CONTROL_ENCRYPTION_SECRET', 'c'.repeat(32));
  vi.stubEnv('BOB_LIVE_AUDIT_PROVIDER', 'local-whisper');
  vi.stubEnv('BOB_LIVE_LOCAL_AUDIT_BASE_URL', 'http://127.0.0.1:8080/v1');
  vi.stubEnv('BOB_LIVE_LOCAL_AUDIT_TOKEN', 'a'.repeat(32));
}

function validSpeechRuntimeEnvironment(provider: 'openai' | 'mistral'): Env {
  validMistralEnvironment();
  vi.stubEnv('BOB_LIVE_PROVIDER', provider);
  vi.stubEnv('BOB_LIVE_SPEECH_DELIVERY', 'audited-signed-url-v1');
  vi.stubEnv('SUPABASE_URL', 'https://bob-live-test.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key');
  if (provider === 'openai') vi.stubEnv('OPENAI_API_KEY', 'test-openai-key');
  return loadEnv();
}

function speechPersistenceFixture(): {
  readonly persistence: Persistence;
  readonly owner: ReturnType<Persistence['createRealtimeSidebandOwner']>;
  readonly factories: Readonly<Record<
  | 'owner'
  | 'usage'
  | 'keyVersions'
  | 'nativeDelivery'
  | 'auditedDelivery'
  | 'controls'
  | 'artifact',
  ReturnType<typeof vi.fn>
  >>;
} {
  const owner = {} as ReturnType<Persistence['createRealtimeSidebandOwner']>;
  const factories = {
    owner: vi.fn(() => owner),
    usage: vi.fn(() => ({} as ReturnType<Persistence['createRealtimeVoiceUsageRepository']>)),
    keyVersions: vi.fn(() => ({ assertCurrentKeyVersions: vi.fn(async () => undefined) })),
    nativeDelivery: vi.fn(() => (
      {} as ReturnType<Persistence['createOpenAiNativeSpeechDeliveryRepository']>
    )),
    auditedDelivery: vi.fn(() => (
      {} as ReturnType<Persistence['createRealtimeSpeechDeliveryRepository']>
    )),
    controls: vi.fn(() => ({} as ReturnType<Persistence['createRealtimeControlRepository']>)),
    artifact: vi.fn(() => (
      {} as ReturnType<Persistence['createRealtimeSpeechArtifactRepository']>
    )),
  };
  return {
    owner,
    factories,
    persistence: {
      createRealtimeSidebandOwner: factories.owner,
      createRealtimeVoiceUsageRepository: factories.usage,
      createOpenAiNativeKeyVersionAuthority: factories.keyVersions,
      createOpenAiNativeSpeechDeliveryRepository: factories.nativeDelivery,
      createRealtimeSpeechDeliveryRepository: factories.auditedDelivery,
      createRealtimeControlRepository: factories.controls,
      createRealtimeSpeechArtifactRepository: factories.artifact,
    } as unknown as Persistence,
  };
}

function durable(): MistralConversationDurableAuthority {
  return {
    open: vi.fn(async () => ({ status: 'unavailable' as const })),
    transition: vi.fn(async () => ({ status: 'unavailable' as const })),
  };
}

describe('RealtimeVoiceModule — composition terminale Mistral v2', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('compose obligatoirement le gate durable lorsque le master AgentMission est ON', () => {
    validSpeechRuntimeEnvironment('openai');
    const missionSecret = Buffer.alloc(32, 91).toString('base64url');
    vi.stubEnv('BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED', 'true');
    vi.stubEnv('BOB_AGENT_MISSION_HMAC_KEY_VERSION', '1');
    vi.stubEnv('BOB_AGENT_MISSION_HMAC_KEYRING', JSON.stringify({
      1: missionSecret,
    }));
    const provider = moduleFactory(REALTIME_AGENT_MISSION_ADMISSION);
    const persistence = {
      cabinet: { flags: {} },
      runWithIdentity: vi.fn(),
    } as unknown as Persistence;

    expect(provider.inject).toEqual([PERSISTENCE]);
    expect(provider.useFactory(persistence))
      .toBeInstanceOf(DurableRealtimeAgentMissionAdmissionGate);
  });

  it('reste dormant et ne sollicite jamais la persistance sans opt-in', async () => {
    validMistralEnvironment();
    const create = vi.fn();
    const persistence = {
      createMistralConversationTerminalReplayAuthorities: create,
    } as Pick<Persistence, 'createMistralConversationTerminalReplayAuthorities'>;

    await expect(buildMistralConversationTerminalReplayRuntime(persistence, loadEnv()))
      .resolves.toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('active automatiquement le reaper avec le replay v2, y compris en drain-only', () => {
    validMistralEnvironment();
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_TERMINAL_REPLAY_ENABLED', 'true');
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEY_VERSION', '1');
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEYRING', JSON.stringify({
      1: Buffer.alloc(32, 7).toString('base64url'),
    }));
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_BOOTSTRAP_REAPER_INTERVAL_MS', '120000');
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_BOOTSTRAP_REAPER_BATCH_SIZE', '25');
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_BOOTSTRAP_REAPER_MAX_BATCHES', '6');

    expect(buildMistralConversationBootstrapReaperOptions(loadEnv())).toEqual({
      enabled: true,
      intervalMs: 120_000,
      batchSize: 25,
      maxBatchesPerSweep: 6,
    });
  });

  it('admet durablement la version avant de brancher le runtime PostgreSQL réel', async () => {
    validMistralEnvironment();
    const secret = Buffer.alloc(32, 7);
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_TERMINAL_REPLAY_ENABLED', 'true');
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEY_VERSION', '3');
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEYRING', JSON.stringify({
      3: secret.toString('base64url'),
    }));
    const authorities = {
      durable: durable(),
      resume: new DisabledMistralConversationResumeAuthority(),
      initialBootstrap: null,
      admission: new DisabledMistralConversationAdmissionAuthority(),
      termination: { terminateReaping: vi.fn(async () => ({ status: 'unavailable' as const })) },
      assertCurrentKeyVersion: vi.fn(async () => undefined),
    };
    const create = vi.fn((
      _keys: MistralConversationPersistenceKeyRing,
      _identityKeys: MistralRealtimeIngressIdentityKeyRing | null,
      _subjectKeys: {
        readonly currentVersion: number;
        readonly versions: readonly number[];
        secret(version: number): string | null;
      },
      _admissionPolicy: { readonly activeLeaseSeconds: number; readonly heartbeatSeconds: number },
    ) => authorities);
    const persistence = {
      createMistralConversationTerminalReplayAuthorities: create,
    } as Pick<Persistence, 'createMistralConversationTerminalReplayAuthorities'>;

    const runtime = await buildMistralConversationTerminalReplayRuntime(
      persistence,
      loadEnv(),
    );

    expect(authorities.assertCurrentKeyVersion).toHaveBeenCalledOnce();
    expect(runtime?.resume).not.toBe(authorities.resume);
    expect(runtime?.gatewayDependencies.resume).toBe(runtime?.resume);
    expect(runtime?.gatewayDependencies.authority).toBe(authorities.durable);
    expect(create).toHaveBeenCalledOnce();
    const keys = create.mock.calls[0]?.[0];
    expect(create.mock.calls[0]?.[1]).toBeNull();
    const subjectKeys = create.mock.calls[0]?.[2];
    expect(subjectKeys?.currentVersion).toBe(1);
    expect(subjectKeys?.versions).toEqual([1]);
    expect(subjectKeys?.secret(1)).toBe('i'.repeat(32));
    expect(create.mock.calls[0]?.[3]).toEqual({
      activeLeaseSeconds: 30,
      heartbeatSeconds: 10,
    });
    expect(keys?.currentVersion).toBe(3);
    expect(Buffer.from(keys?.secret(3) ?? [])).toEqual(secret);
    expect(keys?.secret(2)).toBeNull();
  });

  it('ouvre une preuve identité v1 après rotation du runtime bootstrap vers v2', async () => {
    validMistralEnvironment();
    const persistenceSecret = Buffer.alloc(32, 7);
    const firstIdentitySecret = Buffer.alloc(32, 8).toString('base64url');
    const currentIdentitySecret = Buffer.alloc(32, 9).toString('base64url');
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_TERMINAL_REPLAY_ENABLED', 'true');
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_INITIAL_BOOTSTRAP_ENABLED', 'true');
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEY_VERSION', '3');
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEYRING', JSON.stringify({
      3: persistenceSecret.toString('base64url'),
    }));
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_IDENTITY_ENCRYPTION_KEY_VERSION', '2');
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_IDENTITY_ENCRYPTION_KEYRING', JSON.stringify({
      1: firstIdentitySecret,
      2: currentIdentitySecret,
    }));
    const identityBinding: MistralRealtimeIdentityBinding = {
      companyId: 'company-1',
      subjectHash: '1'.repeat(64),
      subjectKeyVersion: 1,
      sessionId: '10000000-0000-4000-8000-000000000001',
      redemptionId: '20000000-0000-4000-8000-000000000002',
      plan: 'pro',
      contextRevision: 1,
      contextDigest: '2'.repeat(64),
    };
    const v1Proof = sealMistralRealtimeUserIdentity('auth-user-42', identityBinding, {
      currentVersion: 1,
      secret: (version) => (version === 1 ? firstIdentitySecret : null),
    });
    const initialBootstrap = new DisabledMistralConversationBootstrapTicketAuthority();
    const authorities = {
      durable: durable(),
      resume: new DisabledMistralConversationResumeAuthority(),
      initialBootstrap,
      admission: new DisabledMistralConversationAdmissionAuthority(),
      termination: { terminateReaping: vi.fn(async () => ({ status: 'unavailable' as const })) },
      assertCurrentKeyVersion: vi.fn(async () => undefined),
    };
    const create = vi.fn((
      _keys: MistralConversationPersistenceKeyRing,
      _identityKeys: MistralRealtimeIngressIdentityKeyRing | null,
      _subjectKeys: {
        readonly currentVersion: number;
        readonly versions: readonly number[];
        secret(version: number): string | null;
      },
      _admissionPolicy: { readonly activeLeaseSeconds: number; readonly heartbeatSeconds: number },
    ) => authorities);
    const persistence = {
      createMistralConversationTerminalReplayAuthorities: create,
    } as Pick<Persistence, 'createMistralConversationTerminalReplayAuthorities'>;

    const runtime = await buildMistralConversationTerminalReplayRuntime(persistence, loadEnv());

    expect(runtime?.initialBootstrap).toBeNull();
    const identityKeys = create.mock.calls[0]?.[1];
    expect(identityKeys?.currentVersion).toBe(2);
    expect(identityKeys?.secret(1)).toBe(firstIdentitySecret);
    expect(identityKeys?.secret(2)).toBe(currentIdentitySecret);
    expect(identityKeys?.secret(3)).toBeNull();
    expect(openMistralRealtimeUserIdentity(v1Proof, identityBinding, identityKeys!))
      .toBe('auth-user-42');
  });

  it('conserve le keyring identité en rollback drain-only sans réactiver le flag bootstrap', async () => {
    validMistralEnvironment();
    const persistenceSecret = Buffer.alloc(32, 7);
    const firstIdentitySecret = Buffer.alloc(32, 8).toString('base64url');
    const currentIdentitySecret = Buffer.alloc(32, 9).toString('base64url');
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_TERMINAL_REPLAY_ENABLED', 'true');
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEY_VERSION', '3');
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEYRING', JSON.stringify({
      3: persistenceSecret.toString('base64url'),
    }));
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_IDENTITY_ENCRYPTION_KEY_VERSION', '2');
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_IDENTITY_ENCRYPTION_KEYRING', JSON.stringify({
      1: firstIdentitySecret,
      2: currentIdentitySecret,
    }));
    const authorities = {
      durable: durable(),
      resume: new DisabledMistralConversationResumeAuthority(),
      initialBootstrap: null,
      admission: new DisabledMistralConversationAdmissionAuthority(),
      termination: { terminateReaping: vi.fn(async () => ({ status: 'unavailable' as const })) },
      assertCurrentKeyVersion: vi.fn(async () => undefined),
    };
    const create = vi.fn((
      _keys: MistralConversationPersistenceKeyRing,
      _identityKeys: MistralRealtimeIngressIdentityKeyRing | null,
      _subjectKeys: {
        readonly currentVersion: number;
        readonly versions: readonly number[];
        secret(version: number): string | null;
      },
      _admissionPolicy: { readonly activeLeaseSeconds: number; readonly heartbeatSeconds: number },
    ) => authorities);
    const persistence = {
      createMistralConversationTerminalReplayAuthorities: create,
    } as Pick<Persistence, 'createMistralConversationTerminalReplayAuthorities'>;

    const runtime = await buildMistralConversationTerminalReplayRuntime(persistence, loadEnv());

    expect(runtime).not.toBeNull();
    const identityKeys = create.mock.calls[0]?.[1];
    expect(identityKeys?.currentVersion).toBe(2);
    expect(identityKeys?.secret(1)).toBe(firstIdentitySecret);
    expect(identityKeys?.secret(2)).toBe(currentIdentitySecret);
  });

  it('fait échouer le boot si l’adapter ne fournit aucune autorité réelle', async () => {
    validMistralEnvironment();
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_TERMINAL_REPLAY_ENABLED', 'true');
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEY_VERSION', '1');
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEYRING', JSON.stringify({
      1: Buffer.alloc(32, 9).toString('base64url'),
    }));
    const persistence = {
      createMistralConversationTerminalReplayAuthorities: vi.fn(() => null),
    } as Pick<Persistence, 'createMistralConversationTerminalReplayAuthorities'>;

    await expect(buildMistralConversationTerminalReplayRuntime(persistence, loadEnv()))
      .rejects.toThrow(/PostgreSQL terminal replay authority is unavailable/);
  });

  it('fait échouer le boot si le bootstrap initial est activé sans autorité PostgreSQL', async () => {
    validMistralEnvironment();
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_TERMINAL_REPLAY_ENABLED', 'true');
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_INITIAL_BOOTSTRAP_ENABLED', 'true');
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEY_VERSION', '1');
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEYRING', JSON.stringify({
      1: Buffer.alloc(32, 9).toString('base64url'),
    }));
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_IDENTITY_ENCRYPTION_KEY_VERSION', '1');
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_IDENTITY_ENCRYPTION_KEYRING', JSON.stringify({
      1: Buffer.alloc(32, 8).toString('base64url'),
    }));
    const authorities = {
      durable: durable(),
      resume: new DisabledMistralConversationResumeAuthority(),
      initialBootstrap: null,
      admission: new DisabledMistralConversationAdmissionAuthority(),
      termination: { terminateReaping: vi.fn(async () => ({ status: 'unavailable' as const })) },
      assertCurrentKeyVersion: vi.fn(async () => undefined),
    };
    const persistence = {
      createMistralConversationTerminalReplayAuthorities: vi.fn(() => authorities),
    } as Pick<Persistence, 'createMistralConversationTerminalReplayAuthorities'>;

    await expect(buildMistralConversationTerminalReplayRuntime(persistence, loadEnv()))
      .rejects.toThrow(/PostgreSQL bootstrap authority is unavailable/);
    expect(authorities.assertCurrentKeyVersion).not.toHaveBeenCalled();
  });

  it('refuse le boot et n’expose aucun runtime quand le plancher durable rejette la version', async () => {
    validMistralEnvironment();
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_TERMINAL_REPLAY_ENABLED', 'true');
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEY_VERSION', '1');
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEYRING', JSON.stringify({
      1: Buffer.alloc(32, 9).toString('base64url'),
    }));
    const admissionError = new Error('durable key floor is 2');
    const authorities = {
      durable: durable(),
      resume: new DisabledMistralConversationResumeAuthority(),
      initialBootstrap: null,
      admission: new DisabledMistralConversationAdmissionAuthority(),
      termination: { terminateReaping: vi.fn(async () => ({ status: 'unavailable' as const })) },
      assertCurrentKeyVersion: vi.fn(async () => Promise.reject(admissionError)),
    };
    const persistence = {
      createMistralConversationTerminalReplayAuthorities: vi.fn(() => authorities),
    } as Pick<Persistence, 'createMistralConversationTerminalReplayAuthorities'>;

    await expect(buildMistralConversationTerminalReplayRuntime(persistence, loadEnv()))
      .rejects.toBe(admissionError);
    expect(authorities.assertCurrentKeyVersion).toHaveBeenCalledOnce();
    expect(authorities.durable.open).not.toHaveBeenCalled();
  });
});

describe('RealtimeVoiceModule — runtimes de restitution exclusifs', () => {
  afterEach(() => vi.unstubAllEnvs());

  type SpeechRuntime = NonNullable<ReturnType<typeof buildRealtimeSpeechRuntime>>;
  type SidebandFactory = (
    settings: RealtimeVoiceSettings,
    callProvider: unknown,
    metrics: unknown,
    logger: unknown,
    speech: SpeechRuntime | null,
  ) => unknown;
  type WiredSpeech = {
    readonly owner?: unknown;
    readonly audited?: unknown;
    readonly native?: { readonly authority?: unknown; readonly usage?: unknown };
  };

  function sidebandSpeech(runtime: SpeechRuntime): WiredSpeech | undefined {
    const factory = moduleFactory(REALTIME_SIDEBAND).useFactory as unknown as SidebandFactory;
    const manager = factory(
      {} as RealtimeVoiceSettings,
      {},
      {},
      {},
      runtime,
    );
    return (manager as { readonly speech?: WiredSpeech }).speech;
  }

  it('compose OpenAI natif sans stockage Supabase, TTS ni audit acoustique', () => {
    const configured = validSpeechRuntimeEnvironment('openai');
    const env: Env = {
      ...configured,
      BOB_LIVE_SPEECH_DELIVERY: 'openai-native-webrtc-v1',
      SUPABASE_URL: undefined,
      SUPABASE_SERVICE_ROLE_KEY: undefined,
      BOB_LIVE_LOCAL_AUDIT_BASE_URL: undefined,
      BOB_LIVE_LOCAL_AUDIT_TOKEN: undefined,
    };
    // Les builders historiques lisent process.env : les rendre indisponibles prouve que la branche
    // native ne les sollicite pas, même si la configuration Env lui est injectée directement.
    vi.stubEnv('BOB_LIVE_LOCAL_AUDIT_BASE_URL', '');
    vi.stubEnv('BOB_LIVE_LOCAL_AUDIT_TOKEN', '');
    const fixture = speechPersistenceFixture();

    const runtime = buildRealtimeSpeechRuntime(fixture.persistence, env);

    if (!runtime?.native) throw new Error('Native speech runtime was not composed.');
    expect(runtime.owner).toBe(fixture.owner);
    expect(runtime.usage).toBeInstanceOf(RealtimeVoiceUsageWriter);
    expect(runtime.native.authority).toBeInstanceOf(OpenAiNativeSpeechAuthority);
    expect(runtime.audited).toBeUndefined();
    expect(fixture.factories.owner).toHaveBeenCalledOnce();
    expect(fixture.factories.usage).toHaveBeenCalledOnce();
    expect(fixture.factories.nativeDelivery).toHaveBeenCalledOnce();
    expect(fixture.factories.auditedDelivery).not.toHaveBeenCalled();
    expect(fixture.factories.controls).not.toHaveBeenCalled();
    expect(fixture.factories.artifact).not.toHaveBeenCalled();

    const wired = sidebandSpeech(runtime);
    expect(wired?.owner).toBe(runtime.owner);
    expect(wired?.native).toEqual({
      authority: runtime.native.authority,
      usage: runtime.usage,
    });
    expect(wired?.audited).toBeUndefined();

    const controlsFactory = moduleFactory(REALTIME_DURABLE_CONTROLS).useFactory as unknown as
      (speech: SpeechRuntime | null) => unknown;
    const sourcePolicyFactory = moduleFactory(REALTIME_SPEECH_SOURCE_POLICY).useFactory as unknown as
      (speech: SpeechRuntime | null) => unknown;
    expect(controlsFactory(runtime)).toBeInstanceOf(DisabledRealtimeDurableControlAuthority);
    expect(sourcePolicyFactory(runtime)).toBeNull();

    // Le flag natif reste volontairement bloqué tant que la certification device n'est pas verte.
    // Le provider est néanmoins composé avec l'autorité native injectée et demeure désactivé.
    vi.stubEnv('BOB_LIVE_SPEECH_DELIVERY', 'audited-signed-url-v1');
    vi.stubEnv('BOB_LIVE_LOCAL_AUDIT_BASE_URL', 'http://127.0.0.1:8080/v1');
    vi.stubEnv('BOB_LIVE_LOCAL_AUDIT_TOKEN', 'a'.repeat(32));
    const acknowledgementFactory = moduleFactory(
      OpenAiNativeSpeechAcknowledgementService,
    ).useFactory as unknown as (logger: unknown, speech: SpeechRuntime | null) => unknown;
    const acknowledgements = acknowledgementFactory({ audit: vi.fn(), warn: vi.fn() }, runtime);
    expect(acknowledgements).toBeInstanceOf(OpenAiNativeSpeechAcknowledgementService);
    expect((acknowledgements as { readonly authority?: unknown }).authority)
      .toBe(runtime.native.authority);
    // Le service ne conserve volontairement pas l'objet de configuration (il contient la keyring
    // sujet). Prouver le bit effectif évite aussi de réintroduire les secrets dans son instance.
    expect((acknowledgements as { readonly enabled?: boolean }).enabled).toBe(false);
  });

  it('admet sujet et preuve dans PostgreSQL avant de construire le runtime natif', async () => {
    const configured = validSpeechRuntimeEnvironment('openai');
    const env: Env = {
      ...configured,
      BOB_LIVE_SPEECH_DELIVERY: 'openai-native-webrtc-v1',
      SUPABASE_URL: undefined,
      SUPABASE_SERVICE_ROLE_KEY: undefined,
      BOB_LIVE_LOCAL_AUDIT_BASE_URL: undefined,
      BOB_LIVE_LOCAL_AUDIT_TOKEN: undefined,
    };
    const fixture = speechPersistenceFixture();
    const assertCurrentKeyVersions = vi.fn(async () => undefined);
    fixture.factories.keyVersions.mockReturnValue({ assertCurrentKeyVersions });

    const runtime = await buildVerifiedRealtimeSpeechRuntime(fixture.persistence, env);

    expect(runtime?.native).toBeDefined();
    expect(fixture.factories.keyVersions).toHaveBeenCalledOnce();
    expect(assertCurrentKeyVersions).toHaveBeenCalledOnce();
    expect(fixture.factories.keyVersions.mock.invocationCallOrder[0])
      .toBeLessThan(assertCurrentKeyVersions.mock.invocationCallOrder[0] as number);
    expect(assertCurrentKeyVersions.mock.invocationCallOrder[0])
      .toBeLessThan(fixture.factories.nativeDelivery.mock.invocationCallOrder[0] as number);
  });

  it('refuse le runtime natif si la persistance ne fournit pas son autorité de versions', async () => {
    const configured = validSpeechRuntimeEnvironment('openai');
    const env: Env = {
      ...configured,
      BOB_LIVE_SPEECH_DELIVERY: 'openai-native-webrtc-v1',
    };
    const fixture = speechPersistenceFixture();
    fixture.factories.keyVersions.mockReturnValue(null);

    await expect(buildVerifiedRealtimeSpeechRuntime(fixture.persistence, env))
      .rejects.toThrow('PostgreSQL key authority is unavailable');
    expect(fixture.factories.owner).not.toHaveBeenCalled();
    expect(fixture.factories.usage).not.toHaveBeenCalled();
    expect(fixture.factories.nativeDelivery).not.toHaveBeenCalled();
  });

  it.each(['openai', 'mistral'] as const)(
    'ne sollicite pas le registre natif pour la restitution auditée %s',
    async (provider) => {
      const fixture = speechPersistenceFixture();

      await expect(buildVerifiedRealtimeSpeechRuntime(
        fixture.persistence,
        validSpeechRuntimeEnvironment(provider),
      )).resolves.not.toBeNull();

      expect(fixture.factories.keyVersions).not.toHaveBeenCalled();
    },
  );

  it('exporte une readiness qui réutilise l’auditeur et la preuve acoustique du renderer', async () => {
    const health = vi.fn(async () => ({ healthy: true }));
    const prove = vi.fn(async () => ({ healthy: true }));
    const provider = moduleFactory(BOB_LIVE_RUNTIME_READINESS);
    const readiness = provider.useFactory({
      audited: { auditHealth: { health }, acousticProof: { prove } },
    });
    const exports = Reflect.getMetadata(
      MODULE_METADATA.EXPORTS,
      RealtimeVoiceModule,
    ) as unknown[];

    expect(exports).toContain(BOB_LIVE_RUNTIME_READINESS);
    await expect(readiness.check({ fresh: true })).resolves.toEqual({
      ready: true,
      mode: 'audited',
      speechAudit: 'ready',
    });
    expect(health).toHaveBeenCalledOnce();
    expect(prove).toHaveBeenCalledOnce();
    await expect(provider.useFactory({ native: {} }).check()).resolves.toMatchObject({
      ready: true,
      mode: 'native',
      speechAudit: 'not_applicable',
    });
    await expect(provider.useFactory(null).check()).resolves.toMatchObject({
      ready: true,
      mode: 'disabled',
      speechAudit: 'not_applicable',
    });
  });

  it('câble la readiness avant toute réservation sans bloquer les autres gestes du port', async () => {
    validSpeechRuntimeEnvironment('openai');
    const reserve = vi.fn(async () => ({ allowed: false, denial: 'user_minute', retryAt: null }));
    const persistence = {
      createRealtimeAdmission: vi.fn(() => ({ reserve })),
    } as unknown as Persistence;
    const readiness = {
      check: vi.fn(async () => ({
        ready: false as const,
        mode: 'audited' as const,
        speechAudit: 'unavailable' as const,
      })),
    };
    const provider = moduleFactory(REALTIME_ADMISSION);

    expect(provider.inject).toEqual([PERSISTENCE, BOB_LIVE_RUNTIME_READINESS]);
    const gated = provider.useFactory(persistence, readiness);
    await expect(gated.reserve({})).resolves.toEqual({
      allowed: false,
      denial: 'unavailable',
      retryAt: null,
    });
    expect(reserve).not.toHaveBeenCalled();
  });

  it.each(['openai', 'mistral'] as const)(
    'conserve la chaîne auditée complète et exclusive avec %s',
    (provider) => {
      const env = validSpeechRuntimeEnvironment(provider);
      const fixture = speechPersistenceFixture();

      const runtime = buildRealtimeSpeechRuntime(fixture.persistence, env);

      if (!runtime?.audited) throw new Error('Audited speech runtime was not composed.');
      expect(runtime.native).toBeUndefined();
      expect(runtime.audited.acousticProof).toBeInstanceOf(RealtimeSpeechAcousticProbe);
      expect(fixture.factories.nativeDelivery).not.toHaveBeenCalled();
      expect(fixture.factories.auditedDelivery).toHaveBeenCalledOnce();
      expect(fixture.factories.controls).toHaveBeenCalledOnce();
      expect(fixture.factories.artifact).toHaveBeenCalledOnce();

      const wired = sidebandSpeech(runtime);
      expect(wired?.owner).toBe(runtime.owner);
      expect(wired?.audited).toEqual({
        publisher: runtime.audited.publisher,
        cancellation: runtime.audited.deliveryRepository,
        controls: runtime.audited.controls,
      });
      expect(wired?.native).toBeUndefined();

      const controlsFactory = moduleFactory(REALTIME_DURABLE_CONTROLS).useFactory as unknown as
        (speech: SpeechRuntime | null) => unknown;
      const sourcePolicyFactory = moduleFactory(REALTIME_SPEECH_SOURCE_POLICY).useFactory as unknown as
        (speech: SpeechRuntime | null) => unknown;
      expect(controlsFactory(runtime)).toBe(runtime.audited.controls);
      expect(sourcePolicyFactory(runtime)).toBe(runtime.audited.sourcePolicy);

      const acknowledgementFactory = moduleFactory(
        OpenAiNativeSpeechAcknowledgementService,
      ).useFactory as unknown as (logger: unknown, speech: SpeechRuntime | null) => unknown;
      const acknowledgements = acknowledgementFactory({ audit: vi.fn(), warn: vi.fn() }, runtime);
      expect(acknowledgements).toBeInstanceOf(OpenAiNativeSpeechAcknowledgementService);
      expect((acknowledgements as { readonly authority?: unknown }).authority).toBeNull();
    },
  );

  it.each(['openai', 'mistral'] as const)(
    'reste fail-closed avant toute construction de port en mode audité %s incomplet',
    (provider) => {
      const configured = validSpeechRuntimeEnvironment(provider);
      const env: Env = {
        ...configured,
        SUPABASE_URL: undefined,
        SUPABASE_SERVICE_ROLE_KEY: undefined,
      };
      const fixture = speechPersistenceFixture();

      expect(() => buildRealtimeSpeechRuntime(fixture.persistence, env))
        .toThrow('Bob Live audited speech runtime is incompletely configured.');
      expect(fixture.factories.owner).not.toHaveBeenCalled();
      expect(fixture.factories.usage).not.toHaveBeenCalled();
      expect(fixture.factories.nativeDelivery).not.toHaveBeenCalled();
      expect(fixture.factories.auditedDelivery).not.toHaveBeenCalled();
    },
  );
});

describe('RealtimeVoiceModule — composition du cerveau Bob Live', () => {
  it.each(['openai', 'mistral'] as const)(
    'injecte le fournisseur %s choisi au bootstrap dans l’adaptateur agent',
    (provider) => {
      const providers = Reflect.getMetadata(
        MODULE_METADATA.PROVIDERS,
        RealtimeVoiceModule,
      ) as Provider[];
      const definition = providers.find(isRealtimeAgentTurnFactoryProvider);

      expect(definition).toBeDefined();
      expect(definition?.inject).toEqual([
        PERSISTENCE,
        REALTIME_VOICE_SETTINGS,
        ModuleRef,
      ]);

      const persistence = {} as Persistence;
      const moduleRef = { get: vi.fn() } as unknown as ModuleRef;
      const factory = definition?.useFactory as ((
        persistence: Persistence,
        settings: RealtimeVoiceSettings,
        moduleRef: ModuleRef,
      ) => RealtimeBobAgentTurnAdapter) | undefined;
      const adapter = factory?.(
        persistence,
        { provider } as RealtimeVoiceSettings,
        moduleRef,
      );

      expect(adapter).toBeInstanceOf(RealtimeBobAgentTurnAdapter);
      expect(
        (adapter as unknown as { readonly requiredProvider: unknown }).requiredProvider,
      ).toBe(provider);
    },
  );
});

describe('RealtimeVoiceModule — maintenance durable OpenAI native', () => {
  it('compose une capacité DB séparée depuis Persistence sans annuaire de jobs configuré', () => {
    const providers = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      RealtimeVoiceModule,
    ) as Provider[];
    const maintenance = providers.find((provider) =>
      typeof provider === 'object'
      && provider !== null
      && 'provide' in provider
      && provider.provide === OPENAI_NATIVE_SPEECH_MAINTENANCE);
    expect(maintenance).toMatchObject({ inject: [PERSISTENCE] });
    expect(providers).toContain(OpenAiNativeSpeechMaintenanceScheduler);

    const create = vi.fn(() => ({
      listDueCompanyIds: vi.fn(), acknowledgeDueCompanyIds: vi.fn(),
      renewDueCompanyIdsClaim: vi.fn(), reapExpired: vi.fn(), purgeRetained: vi.fn(),
    }));
    const factory = (maintenance as FactoryProvider | undefined)?.useFactory as
      | ((persistence: Pick<Persistence, 'createOpenAiNativeSpeechMaintenance'>) => unknown)
      | undefined;
    expect(factory?.({ createOpenAiNativeSpeechMaintenance: create })).toBe(create.mock.results[0]?.value);
    expect(create).toHaveBeenCalledOnce();
  });
});

describe('RealtimeVoiceModule — annuaire durable du reaper admission', () => {
  it('compose le port PostgreSQL séparé sans ScheduledTenantDirectory', () => {
    const providers = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      RealtimeVoiceModule,
    ) as Provider[];
    const directory = providers.find((provider) =>
      typeof provider === 'object'
      && provider !== null
      && 'provide' in provider
      && provider.provide === REALTIME_REAPER_DIRECTORY);
    expect(directory).toMatchObject({ inject: [PERSISTENCE] });

    const created = {
      listDueCompanyIds: vi.fn(), renewClaim: vi.fn(), acknowledgeClaim: vi.fn(),
    };
    const create = vi.fn(() => created);
    const factory = (directory as FactoryProvider | undefined)?.useFactory as
      | ((persistence: Pick<Persistence, 'createRealtimeReaperDirectory'>) => unknown)
      | undefined;
    expect(factory?.({ createRealtimeReaperDirectory: create })).toBe(created);
    expect(create).toHaveBeenCalledOnce();
  });

  it('conserve aussi l’autorité de terminaison Mistral en mode drain-only', () => {
    const providers = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      RealtimeVoiceModule,
    ) as Provider[];
    const termination = providers.find((provider) =>
      typeof provider === 'object'
      && provider !== null
      && 'provide' in provider
      && provider.provide === MISTRAL_REALTIME_TERMINATION_AUTHORITY);
    const factory = (termination as FactoryProvider | undefined)?.useFactory as
      | ((settings: RealtimeVoiceSettings) => MistralRealtimeTerminationAuthority | null)
      | undefined;

    expect(factory?.({ enabled: false, provider: 'mistral' } as RealtimeVoiceSettings))
      .toBeInstanceOf(MistralRealtimeTerminationAuthority);
    expect(factory?.({ enabled: false, provider: 'openai' } as RealtimeVoiceSettings))
      .toBeNull();
  });
});
