import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadEnv, resolveBobLiveEnv } from './env';

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
    });
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
