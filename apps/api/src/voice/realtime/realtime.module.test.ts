import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../../config/env';
import type { Persistence } from '../../persistence/persistence';
import type { MistralConversationDurableAuthority } from './mistral-conversation-gateway-v2';
import type { MistralConversationPersistenceKeyRing } from './mistral-conversation-outbox-seal';
import { DisabledMistralConversationResumeAuthority } from './mistral-conversation-resume-ticket';
import { buildMistralConversationTerminalReplayRuntime } from './realtime.module';

function validMistralEnvironment(): void {
  vi.stubEnv('DEMO_MODE', 'true');
  vi.stubEnv('BOB_LIVE_ENABLED', 'true');
  vi.stubEnv('BOB_LIVE_PROVIDER', 'mistral');
  vi.stubEnv('MISTRAL_API_KEY', 'test-mistral-key');
  vi.stubEnv('BOB_LIVE_SUBJECT_HMAC_SECRET', 'i'.repeat(32));
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
      assertCurrentKeyVersion: vi.fn(async () => undefined),
    };
    const create = vi.fn((_keys: MistralConversationPersistenceKeyRing) => authorities);
    const persistence = {
      createMistralConversationTerminalReplayAuthorities: create,
    } as Pick<Persistence, 'createMistralConversationTerminalReplayAuthorities'>;

    const runtime = await buildMistralConversationTerminalReplayRuntime(
      persistence,
      loadEnv(),
    );

    expect(authorities.assertCurrentKeyVersion).toHaveBeenCalledOnce();
    expect(runtime?.resume).toBe(authorities.resume);
    expect(runtime?.gatewayDependencies.authority).toBe(authorities.durable);
    expect(create).toHaveBeenCalledOnce();
    const keys = create.mock.calls[0]?.[0];
    expect(keys?.currentVersion).toBe(3);
    expect(Buffer.from(keys?.secret(3) ?? [])).toEqual(secret);
    expect(keys?.secret(2)).toBeNull();
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
