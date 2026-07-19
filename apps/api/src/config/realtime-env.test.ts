import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadEnv,
  resolveBobLiveEnv,
  resolveBobLiveSubjectHmacKeyRing,
  resolveMistralConversationPersistenceKeyRing,
  resolveMistralV2IdentityEncryptionKeyRing,
} from './env';

function validRealtimeEnv(): void {
  vi.stubEnv('DEMO_MODE', 'true');
  vi.stubEnv('OPENAI_REALTIME_ENABLED', 'true');
  vi.stubEnv('OPENAI_API_KEY', 'test-openai-key');
  vi.stubEnv('OPENAI_REALTIME_SAFETY_SECRET', 's'.repeat(32));
  vi.stubEnv('OPENAI_REALTIME_PROOF_SECRET', 'p'.repeat(32));
  vi.stubEnv('OPENAI_REALTIME_CONTROL_ENCRYPTION_SECRET', 'c'.repeat(32));
  vi.stubEnv('OPENAI_REALTIME_PROVIDER_TIMEOUT_MS', '4000');
  vi.stubEnv('OPENAI_REALTIME_SIDEBAND_TIMEOUT_MS', '3000');
  vi.stubEnv('OPENAI_REALTIME_MAX_SESSION_SECONDS', '900');
  vi.stubEnv('OPENAI_REALTIME_MAX_CALLS_PER_MINUTE', '3');
  vi.stubEnv('OPENAI_REALTIME_MAX_CALLS_PER_HOUR', '30');
  vi.stubEnv('OPENAI_REALTIME_MAX_TENANT_CALLS_PER_MINUTE', '50');
  vi.stubEnv('OPENAI_REALTIME_MAX_TENANT_CALLS_PER_HOUR', '1000');
  vi.stubEnv('OPENAI_REALTIME_RESERVATION_TTL_SECONDS', '15');
  vi.stubEnv('OPENAI_REALTIME_ACTIVE_LEASE_SECONDS', '30');
  vi.stubEnv('OPENAI_REALTIME_HEARTBEAT_SECONDS', '10');
  vi.stubEnv('OPENAI_REALTIME_REAPER_LEASE_SECONDS', '30');
  vi.stubEnv('BOB_LIVE_AUDIT_PROVIDER', 'local-whisper');
  vi.stubEnv('BOB_LIVE_LOCAL_AUDIT_BASE_URL', 'http://127.0.0.1:8080/v1');
  vi.stubEnv('BOB_LIVE_LOCAL_AUDIT_TOKEN', 'a'.repeat(32));
}

function validMistralRealtimeEnv(): void {
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

function enableMistralV2TerminalReplay(): void {
  const subjectSecret = Buffer.alloc(32, 6).toString('base64url');
  vi.stubEnv('BOB_LIVE_MISTRAL_V2_TERMINAL_REPLAY_ENABLED', 'true');
  vi.stubEnv('BOB_LIVE_SUBJECT_HMAC_SECRET', subjectSecret);
  vi.stubEnv('BOB_LIVE_SUBJECT_HMAC_KEYRING', JSON.stringify({ 1: subjectSecret }));
  vi.stubEnv('BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEY_VERSION', '1');
  vi.stubEnv('BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEYRING', JSON.stringify({
    1: Buffer.alloc(32, 7).toString('base64url'),
  }));
}

describe('Bob Live — validation de la politique d’admission', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('charge les quotas et baux production par défaut arbitrés', () => {
    validRealtimeEnv();
    expect(loadEnv()).toMatchObject({
      OPENAI_REALTIME_MAX_CALLS_PER_MINUTE: 3,
      OPENAI_REALTIME_MAX_CALLS_PER_HOUR: 30,
      OPENAI_REALTIME_MAX_TENANT_CALLS_PER_MINUTE: 50,
      OPENAI_REALTIME_MAX_TENANT_CALLS_PER_HOUR: 1_000,
      OPENAI_REALTIME_RESERVATION_TTL_SECONDS: 15,
      OPENAI_REALTIME_ACTIVE_LEASE_SECONDS: 30,
      OPENAI_REALTIME_HEARTBEAT_SECONDS: 10,
      OPENAI_REALTIME_REAPER_LEASE_SECONDS: 30,
      BOB_LIVE_SUBJECT_KEY_VERSION: 1,
      OPENAI_REALTIME_PROOF_KEY_VERSION: 1,
      OPENAI_REALTIME_CONTROL_ENCRYPTION_KEY_VERSION: 1,
      SUPABASE_REALTIME_AUDIO_BUCKET: 'bob-live-audio',
    });
  });

  it('refuse quota horaire inférieur au quota minute', () => {
    validRealtimeEnv();
    vi.stubEnv('OPENAI_REALTIME_MAX_CALLS_PER_HOUR', '2');
    expect(() => loadEnv()).toThrow(/quota Bob Live utilisateur horaire/i);
  });

  it('refuse une réservation plus courte que le bootstrap borné', () => {
    validRealtimeEnv();
    vi.stubEnv('OPENAI_REALTIME_PROVIDER_TIMEOUT_MS', '6000');
    vi.stubEnv('OPENAI_REALTIME_SIDEBAND_TIMEOUT_MS', '5000');
    expect(() => loadEnv()).toThrow(/budget bootstrap Bob Live/i);
  });

  it('refuse un heartbeat qui ne laisse aucune marge au bail actif', () => {
    validRealtimeEnv();
    vi.stubEnv('OPENAI_REALTIME_HEARTBEAT_SECONDS', '30');
    expect(() => loadEnv()).toThrow(/heartbeat Bob Live/i);
  });

  it('refuse une preuve acoustique absente, placeholder ou dans le bucket documentaire', () => {
    validRealtimeEnv();
    vi.stubEnv('OPENAI_REALTIME_PROOF_SECRET', '');
    expect(() => loadEnv()).toThrow(/OPENAI_REALTIME_PROOF_SECRET/);

    vi.stubEnv('OPENAI_REALTIME_PROOF_SECRET', `[${'p'.repeat(32)}]`);
    expect(() => loadEnv()).toThrow(/PROOF_SECRET contient un placeholder/);

    vi.stubEnv('OPENAI_REALTIME_PROOF_SECRET', 'p'.repeat(32));
    vi.stubEnv('SUPABASE_REALTIME_AUDIO_BUCKET', 'bob-documents');
    expect(() => loadEnv()).toThrow(/bucket audio Bob Live doit être distinct/);
  });

  it('refuse une clé de contrôle absente, placeholder ou réutilisée', () => {
    validRealtimeEnv();
    vi.stubEnv('OPENAI_REALTIME_CONTROL_ENCRYPTION_SECRET', '');
    expect(() => loadEnv()).toThrow(/OPENAI_REALTIME_CONTROL_ENCRYPTION_SECRET/);

    vi.stubEnv('OPENAI_REALTIME_CONTROL_ENCRYPTION_SECRET', `[${'c'.repeat(32)}]`);
    expect(() => loadEnv()).toThrow(/CONTROL_ENCRYPTION_SECRET contient un placeholder/);

    vi.stubEnv('OPENAI_REALTIME_CONTROL_ENCRYPTION_SECRET', 'p'.repeat(32));
    expect(() => loadEnv()).toThrow(/doit être dédiée/);
  });

  it('active Mistral Realtime sans aucune clé OpenAI avec un audit Whisper local indépendant', () => {
    validMistralRealtimeEnv();
    vi.stubEnv('OPENAI_API_KEY', '');

    const env = loadEnv();
    expect(resolveBobLiveEnv(env)).toMatchObject({
      enabled: true,
      provider: 'mistral',
      providerModel: 'voxtral-mini-transcribe-realtime-2602',
      providerBaseUrl: 'wss://api.mistral.ai',
      subjectKeyVersion: 1,
      usageKeyVersion: 1,
      auditProvider: 'local-whisper',
      mistralTargetDelayMs: 240,
      mistralWebsocketUrl: 'ws://127.0.0.1:3000/v1/voice/realtime/mistral',
      gatewayMaxConnections: 500,
      gatewayShutdownGraceMs: 1_500,
      gatewayTlsMode: 'direct',
      mistralV2TerminalReplayEnabled: false,
      mistralV2InitialBootstrapEnabled: false,
      mistralV2BootstrapReaperIntervalMs: 60_000,
      mistralV2BootstrapReaperBatchSize: 10,
      mistralV2BootstrapReaperMaxBatches: 4,
    });
  });

  it('borne strictement la cadence et le volume du reaper bootstrap v2', () => {
    validMistralRealtimeEnv();
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_BOOTSTRAP_REAPER_INTERVAL_MS', '9999');
    expect(() => loadEnv()).toThrow(/BOOTSTRAP_REAPER_INTERVAL_MS/u);

    vi.stubEnv('BOB_LIVE_MISTRAL_V2_BOOTSTRAP_REAPER_INTERVAL_MS', '60000');
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_BOOTSTRAP_REAPER_BATCH_SIZE', '101');
    expect(() => loadEnv()).toThrow(/BOOTSTRAP_REAPER_BATCH_SIZE/u);

    vi.stubEnv('BOB_LIVE_MISTRAL_V2_BOOTSTRAP_REAPER_BATCH_SIZE', '10');
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_BOOTSTRAP_REAPER_MAX_BATCHES', '0');
    expect(() => loadEnv()).toThrow(/BOOTSTRAP_REAPER_MAX_BATCHES/u);
  });

  it('active le replay terminal v2 avec un keyring canonique et conserve les anciennes versions', () => {
    validMistralRealtimeEnv();
    const subject = Buffer.alloc(32, 6).toString('base64url');
    vi.stubEnv('BOB_LIVE_SUBJECT_HMAC_SECRET', subject);
    vi.stubEnv('BOB_LIVE_SUBJECT_HMAC_KEYRING', JSON.stringify({ 1: subject }));
    const first = Buffer.alloc(32, 1).toString('base64url');
    const current = Buffer.alloc(32, 2).toString('base64url');
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_TERMINAL_REPLAY_ENABLED', 'true');
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEY_VERSION', '2');
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEYRING', JSON.stringify({ 1: first, 2: current }));

    const env = loadEnv();
    const keys = resolveMistralConversationPersistenceKeyRing(env);
    expect(resolveBobLiveEnv(env).mistralV2TerminalReplayEnabled).toBe(true);
    expect(keys?.currentVersion).toBe(2);
    expect(Buffer.from(keys?.secret(1) ?? []).toString('base64url')).toBe(first);
    expect(Buffer.from(keys?.secret(2) ?? []).toString('base64url')).toBe(current);
    expect(keys?.secret(3)).toBeNull();
  });

  it('conserve les versions HMAC sujet nécessaires aux reçus terminaux après rotation', () => {
    validMistralRealtimeEnv();
    enableMistralV2TerminalReplay();
    const previous = Buffer.alloc(32, 4).toString('base64url');
    const current = Buffer.alloc(32, 5).toString('base64url');
    vi.stubEnv('BOB_LIVE_SUBJECT_KEY_VERSION', '2');
    vi.stubEnv('BOB_LIVE_SUBJECT_HMAC_SECRET', current);
    vi.stubEnv('BOB_LIVE_SUBJECT_HMAC_KEYRING', JSON.stringify({ 1: previous, 2: current }));

    const keyRing = resolveBobLiveSubjectHmacKeyRing(loadEnv());
    expect(keyRing?.currentVersion).toBe(2);
    expect(keyRing?.versions).toEqual([1, 2]);
    expect(keyRing?.secret(1)).toBe(previous);
    expect(keyRing?.secret(2)).toBe(current);
    expect(keyRing?.secret(3)).toBeNull();
  });

  it('conserve octet pour octet un secret sujet historique non base64url', () => {
    validMistralRealtimeEnv();
    enableMistralV2TerminalReplay();
    const legacy = 'legacy-HMAC-secret-kept-byte-for-byte-2026';
    vi.stubEnv('BOB_LIVE_SUBJECT_HMAC_SECRET', legacy);
    vi.stubEnv('BOB_LIVE_SUBJECT_HMAC_KEYRING', JSON.stringify({ 1: legacy }));

    const keyRing = resolveBobLiveSubjectHmacKeyRing(loadEnv());
    expect(keyRing?.secret(1)).toBe(legacy);
    expect(resolveBobLiveEnv(loadEnv()).subjectHmacSecret).toBe(legacy);
  });

  it('refuse le replay v2 sans keyring sujet ou avec une version courante divergente', () => {
    validMistralRealtimeEnv();
    enableMistralV2TerminalReplay();
    vi.stubEnv('BOB_LIVE_SUBJECT_HMAC_KEYRING', '');
    expect(() => loadEnv()).toThrow(/SUBJECT_HMAC_KEYRING/u);

    const old = Buffer.alloc(32, 4).toString('base64url');
    const current = Buffer.alloc(32, 5).toString('base64url');
    vi.stubEnv('BOB_LIVE_SUBJECT_KEY_VERSION', '2');
    vi.stubEnv('BOB_LIVE_SUBJECT_HMAC_SECRET', current);
    vi.stubEnv('BOB_LIVE_SUBJECT_HMAC_KEYRING', JSON.stringify({ 1: old }));
    expect(() => loadEnv()).toThrow(/version courante sujet/u);

    vi.stubEnv('BOB_LIVE_SUBJECT_HMAC_KEYRING', JSON.stringify({ 1: old, 2: old }));
    expect(() => loadEnv()).toThrow(/version ou une clé invalide/u);
  });

  it('n’autorise le bootstrap initial v2 qu’au-dessus du replay terminal', () => {
    validMistralRealtimeEnv();
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_INITIAL_BOOTSTRAP_ENABLED', 'true');
    expect(() => loadEnv()).toThrow(/exige le replay terminal/i);

    enableMistralV2TerminalReplay();
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_IDENTITY_ENCRYPTION_KEY_VERSION', '1');
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_IDENTITY_ENCRYPTION_KEYRING', JSON.stringify({
      1: Buffer.alloc(32, 8).toString('base64url'),
    }));
    expect(resolveBobLiveEnv(loadEnv()).mistralV2InitialBootstrapEnabled).toBe(true);
  });

  it('retient les identités v1 sous une clé courante v2, y compris pendant un rollback drain-only', () => {
    validMistralRealtimeEnv();
    enableMistralV2TerminalReplay();
    const first = Buffer.alloc(32, 8).toString('base64url');
    const current = Buffer.alloc(32, 9).toString('base64url');
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_IDENTITY_ENCRYPTION_KEY_VERSION', '2');
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_IDENTITY_ENCRYPTION_KEYRING', JSON.stringify({
      1: first,
      2: current,
    }));

    const drainEnv = loadEnv();
    const drainKeys = resolveMistralV2IdentityEncryptionKeyRing(drainEnv);
    expect(resolveBobLiveEnv(drainEnv).mistralV2InitialBootstrapEnabled).toBe(false);
    expect(drainKeys?.currentVersion).toBe(2);
    expect(drainKeys?.secret(1)).toBe(first);
    expect(drainKeys?.secret(2)).toBe(current);
    expect(drainKeys?.secret(3)).toBeNull();

    vi.stubEnv('BOB_LIVE_MISTRAL_V2_INITIAL_BOOTSTRAP_ENABLED', 'true');
    expect(resolveMistralV2IdentityEncryptionKeyRing(loadEnv())?.secret(1)).toBe(first);
  });

  it('exige le keyring identité complet pour émettre et refuse toute paire partielle', () => {
    validMistralRealtimeEnv();
    enableMistralV2TerminalReplay();
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_INITIAL_BOOTSTRAP_ENABLED', 'true');
    expect(() => loadEnv()).toThrow(/identité.*incomplet/i);

    vi.stubEnv('BOB_LIVE_MISTRAL_V2_IDENTITY_ENCRYPTION_KEY_VERSION', '1');
    expect(() => loadEnv()).toThrow(/identité.*incomplet/i);
  });

  it('refuse aussi une paire identité partielle en mode drain-only', () => {
    validMistralRealtimeEnv();
    enableMistralV2TerminalReplay();
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_IDENTITY_ENCRYPTION_KEY_VERSION', '1');
    expect(() => loadEnv()).toThrow(/identité.*incomplet/i);
  });

  it('interdit le keyring identité lorsque le replay terminal est désactivé', () => {
    validMistralRealtimeEnv();
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_IDENTITY_ENCRYPTION_KEY_VERSION', '1');
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_IDENTITY_ENCRYPTION_KEYRING', JSON.stringify({
      1: Buffer.alloc(32, 8).toString('base64url'),
    }));
    expect(() => loadEnv()).toThrow(/identité.*replay terminal.*désactivé/i);
  });

  it('refuse version invalide, version courante absente, doublon et dépassement de borne', () => {
    validMistralRealtimeEnv();
    enableMistralV2TerminalReplay();
    const first = Buffer.alloc(32, 8).toString('base64url');
    const current = Buffer.alloc(32, 9).toString('base64url');
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_IDENTITY_ENCRYPTION_KEY_VERSION', '2');

    vi.stubEnv('BOB_LIVE_MISTRAL_V2_IDENTITY_ENCRYPTION_KEYRING', JSON.stringify({ 1: first }));
    expect(() => loadEnv()).toThrow(/version courante.*identité/i);

    vi.stubEnv(
      'BOB_LIVE_MISTRAL_V2_IDENTITY_ENCRYPTION_KEYRING',
      `{"01":"${first}","2":"${current}"}`,
    );
    expect(() => loadEnv()).toThrow(/version ou une clé invalide/i);

    vi.stubEnv('BOB_LIVE_MISTRAL_V2_IDENTITY_ENCRYPTION_KEYRING', JSON.stringify({
      1: first,
      2: first,
    }));
    let duplicateError: unknown;
    try {
      loadEnv();
    } catch (error) {
      duplicateError = error;
    }
    expect(String(duplicateError)).toMatch(/version ou une clé invalide/i);
    expect(String(duplicateError)).not.toContain(first);

    vi.stubEnv('BOB_LIVE_MISTRAL_V2_IDENTITY_ENCRYPTION_KEYRING', JSON.stringify(
      Object.fromEntries(Array.from({ length: 9 }, (_, index) => [
        index + 1,
        Buffer.alloc(32, index + 8).toString('base64url'),
      ])),
    ));
    expect(() => loadEnv()).toThrow(/entre 1 et 8 clés/i);
  });

  it('refuse un secret identité mal formé ou réutilisé par la persistance', () => {
    validMistralRealtimeEnv();
    enableMistralV2TerminalReplay();
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_IDENTITY_ENCRYPTION_KEY_VERSION', '1');
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_IDENTITY_ENCRYPTION_KEYRING', '{"1":"not-a-key"}');
    expect(() => loadEnv()).toThrow(/version ou une clé invalide/i);

    const persistenceSecret = Buffer.alloc(32, 7).toString('base64url');
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_IDENTITY_ENCRYPTION_KEYRING', JSON.stringify({
      1: persistenceSecret,
    }));
    expect(() => loadEnv()).toThrow(/doit être dédiée/i);
  });

  it('refuse toute configuration partielle ou dormante du keyring v2', () => {
    validMistralRealtimeEnv();
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEY_VERSION', '1');
    expect(() => loadEnv()).toThrow(/désactivé/i);

    vi.stubEnv('BOB_LIVE_MISTRAL_V2_TERMINAL_REPLAY_ENABLED', 'true');
    expect(() => loadEnv()).toThrow(/keyring.*incomplet/i);
  });

  it('refuse le replay terminal v2 avec OpenAI ou un keyring corrompu', () => {
    validRealtimeEnv();
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_TERMINAL_REPLAY_ENABLED', 'true');
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEY_VERSION', '1');
    vi.stubEnv(
      'BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEYRING',
      JSON.stringify({ 1: Buffer.alloc(32, 1).toString('base64url') }),
    );
    expect(() => loadEnv()).toThrow(/PROVIDER=mistral/i);

    validMistralRealtimeEnv();
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEYRING', '{"1":"not-a-key"}');
    expect(() => loadEnv()).toThrow(/version ou une clé invalide/i);
  });

  it('refuse une version absente et la réutilisation d’une même clé v2', () => {
    validMistralRealtimeEnv();
    const secret = Buffer.alloc(32, 3).toString('base64url');
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_TERMINAL_REPLAY_ENABLED', 'true');
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEY_VERSION', '2');
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEYRING', JSON.stringify({ 1: secret }));
    expect(() => loadEnv()).toThrow(/version courante/i);

    vi.stubEnv('BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEYRING', JSON.stringify({ 1: secret, 2: secret }));
    expect(() => loadEnv()).toThrow(/version ou une clé invalide/i);
  });

  it('active OpenAI Realtime et son TTS sans aucune clé Mistral', () => {
    validRealtimeEnv();
    vi.stubEnv('MISTRAL_API_KEY', '');

    const env = loadEnv();
    expect(env).toMatchObject({
      OPENAI_TTS_MODEL: 'gpt-4o-mini-tts-2025-12-15',
      BOB_LIVE_AUDIT_PROVIDER: 'local-whisper',
    });
    expect(resolveBobLiveEnv(env)).toMatchObject({
      enabled: true,
      provider: 'openai',
      providerModel: 'gpt-realtime-2.1',
      providerBaseUrl: 'https://api.openai.com/v1',
      auditProvider: 'local-whisper',
    });
  });

  it.each(['openai', 'mistral'] as const)(
    'refuse pour %s un audit cloud corrélé au pipeline vocal',
    (provider) => {
      if (provider === 'mistral') validMistralRealtimeEnv();
      else validRealtimeEnv();
      vi.stubEnv('BOB_LIVE_PROVIDER', provider);
      vi.stubEnv('BOB_LIVE_AUDIT_PROVIDER', 'openai');
      expect(() => loadEnv()).toThrow(/doit valoir local-whisper/);
    },
  );

  it('refuse qu’un faux Whisper local exfiltre l’audio vers un hôte distant', () => {
    validMistralRealtimeEnv();
    vi.stubEnv('BOB_LIVE_LOCAL_AUDIT_BASE_URL', 'https://audit-compatible.example/v1');
    expect(() => loadEnv()).toThrow(/sidecar loopback local/);
  });

  it('rend explicite le terminateur TLS de confiance et borne le budget du gateway', () => {
    validMistralRealtimeEnv();
    vi.stubEnv('BOB_LIVE_GATEWAY_TLS_MODE', 'trusted-proxy');
    vi.stubEnv('BOB_LIVE_GATEWAY_MAX_CONNECTIONS', '750');
    vi.stubEnv('BOB_LIVE_GATEWAY_SHUTDOWN_GRACE_MS', '2500');

    expect(resolveBobLiveEnv(loadEnv())).toMatchObject({
      gatewayTlsMode: 'trusted-proxy',
      gatewayMaxConnections: 750,
      gatewayShutdownGraceMs: 2_500,
    });
  });

  it('expose une version de clé sujet indépendante de la clé de preuve', () => {
    validMistralRealtimeEnv();
    vi.stubEnv('BOB_LIVE_SUBJECT_KEY_VERSION', '7');
    vi.stubEnv('BOB_LIVE_PROOF_KEY_VERSION', '11');
    vi.stubEnv('BOB_LIVE_USAGE_KEY_VERSION', '13');

    expect(resolveBobLiveEnv(loadEnv())).toMatchObject({
      subjectKeyVersion: 7,
      proofKeyVersion: 11,
      usageKeyVersion: 13,
    });
  });

  it('exige une clé usage dédiée pour une configuration provider-neutre', () => {
    validMistralRealtimeEnv();
    vi.stubEnv('BOB_LIVE_USAGE_HMAC_SECRET', '');
    expect(() => loadEnv()).toThrow(/BOB_LIVE_USAGE_HMAC_SECRET/);

    vi.stubEnv('BOB_LIVE_USAGE_HMAC_SECRET', 'p'.repeat(32));
    expect(() => loadEnv()).toThrow(/doit être dédiée/);
  });

  it('refuse Mistral-only si l’auditeur indépendant local n’est pas entièrement configuré', () => {
    validMistralRealtimeEnv();
    vi.stubEnv('BOB_LIVE_LOCAL_AUDIT_TOKEN', '');
    expect(() => loadEnv()).toThrow(/BOB_LIVE_LOCAL_AUDIT_TOKEN/);
  });

  it('refuse une URL Mistral non chiffrée et laisse les réglages BOB_LIVE_* primer sur les alias', () => {
    validMistralRealtimeEnv();
    vi.stubEnv('MISTRAL_REALTIME_BASE_URL', 'http://api.mistral.ai');
    expect(() => loadEnv()).toThrow(/doit utiliser WSS/);

    vi.stubEnv('MISTRAL_REALTIME_BASE_URL', 'wss://api.mistral.ai');
    vi.stubEnv('BOB_LIVE_MAX_SESSION_SECONDS', '300');
    vi.stubEnv('OPENAI_REALTIME_MAX_SESSION_SECONDS', '900');
    expect(resolveBobLiveEnv(loadEnv()).maxSessionSeconds).toBe(300);
  });

  it('refuse une URL gateway Mistral ambiguë ou hors du chemin canonique', () => {
    validMistralRealtimeEnv();
    vi.stubEnv('BOB_LIVE_MISTRAL_WEBSOCKET_URL', 'wss://api.bob.example/other?ticket=forbidden');
    expect(() => loadEnv()).toThrow(/WEBSOCKET_URL/);

    vi.stubEnv('BOB_LIVE_MISTRAL_WEBSOCKET_URL', 'wss://api.bob.example/v1/voice/realtime/mistral');
    expect(resolveBobLiveEnv(loadEnv()).mistralWebsocketUrl)
      .toBe('wss://api.bob.example/v1/voice/realtime/mistral');
  });
});
