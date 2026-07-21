import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FactoryProvider, Provider } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { ModuleRef } from '@nestjs/core';
import { loadEnv } from '../../config/env';
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
  REALTIME_AGENT_TURN,
  REALTIME_VOICE_SETTINGS,
} from './realtime.tokens';
import type { RealtimeVoiceSettings } from './realtime.types';
import {
  buildMistralConversationBootstrapReaperOptions,
  buildMistralConversationTerminalReplayRuntime,
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

function validMistralEnvironment(): void {
  vi.stubEnv('DEMO_MODE', 'true');
  vi.stubEnv('BOB_LIVE_ENABLED', 'true');
  vi.stubEnv('BOB_LIVE_PROVIDER', 'mistral');
  vi.stubEnv('MISTRAL_API_KEY', 'test-mistral-key');
  vi.stubEnv('BOB_LIVE_SUBJECT_HMAC_SECRET', 'i'.repeat(32));
  vi.stubEnv('BOB_LIVE_SUBJECT_KEY_VERSION', '1');
  vi.stubEnv('BOB_LIVE_SUBJECT_HMAC_KEYRING', JSON.stringify({ 1: 'i'.repeat(32) }));
  vi.stubEnv('BOB_LIVE_PROOF_SECRET', 'p'.repeat(32));
  vi.stubEnv('BOB_LIVE_USAGE_HMAC_SECRET', 'u'.repeat(32));
  vi.stubEnv('BOB_LIVE_CONTROL_ENCRYPTION_SECRET', 'c'.repeat(32));
  vi.stubEnv('BOB_LIVE_AUDIT_PROVIDER', 'local-whisper');
  vi.stubEnv('BOB_LIVE_LOCAL_AUDIT_BASE_URL', 'http://127.0.0.1:8080/v1');
  vi.stubEnv('BOB_LIVE_LOCAL_AUDIT_TOKEN', 'a'.repeat(32));
}

function durable(): MistralConversationDurableAuthority {
  return {
    open: vi.fn(async () => ({ status: 'unavailable' as const })),
    transition: vi.fn(async () => ({ status: 'unavailable' as const })),
  };
}

describe('RealtimeVoiceModule — composition terminale Mistral v2', () => {
  afterEach(() => vi.unstubAllEnvs());

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
