import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadEnv } from './env';

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
});
