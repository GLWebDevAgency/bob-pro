import { describe, expect, it, vi } from 'vitest';
import { MistralRealtimeGatewayProviderAdapter } from './mistral-realtime-gateway-provider';
import type { RealtimeVoiceSettings } from './realtime.types';

const SETTINGS: RealtimeVoiceSettings = {
  enabled: true,
  provider: 'mistral',
  model: 'voxtral-mini-transcribe-realtime-2602',
  voice: 'marin',
  baseUrl: 'wss://api.mistral.ai',
  apiKey: 'mistral-secret',
  safetySecret: 's'.repeat(32),
  subjectKeyVersion: 1,
  providerTimeoutMs: 4_000,
  sidebandTimeoutMs: 4_000,
  maxSessionSeconds: 900,
  heartbeatSeconds: 20,
  maxCallsPerMinute: 6,
  auditProvider: 'local-whisper',
  localAuditBaseUrl: 'http://127.0.0.1:9000',
  localAuditToken: 'audit-token',
  mistralTargetDelayMs: 240,
  mistralWebsocketUrl: 'wss://api.bob.test/v1/voice/realtime/mistral',
};

describe('MistralRealtimeGatewayProviderAdapter', () => {
  it('capture la configuration serveur et ne transmet au provider que le signal et la borne', async () => {
    const connection = { providerSessionId: 'request-1' };
    const connect = vi.fn(async () => connection as never);
    const adapter = new MistralRealtimeGatewayProviderAdapter(SETTINGS, connect);
    const signal = new AbortController().signal;

    await expect(adapter.connect({ maxSessionSeconds: 420, signal })).resolves.toBe(connection);
    expect(connect).toHaveBeenCalledWith({
      apiKey: 'mistral-secret',
      baseUrl: 'wss://api.mistral.ai',
      model: 'voxtral-mini-transcribe-realtime-2602',
      targetDelayMs: 240,
      connectTimeoutMs: 4_000,
      maxSessionSeconds: 420,
    }, { signal });
  });

  it('refuse toute composition hors Mistral live ou sans clé', () => {
    expect(() => new MistralRealtimeGatewayProviderAdapter({
      ...SETTINGS,
      provider: 'openai',
    })).toThrow('unavailable');
    expect(() => new MistralRealtimeGatewayProviderAdapter({
      ...SETTINGS,
      apiKey: null,
    })).toThrow('unavailable');
  });

  it('refuse avant le réseau une durée invalide ou un signal déjà annulé', async () => {
    const connect = vi.fn(async () => ({}) as never);
    const adapter = new MistralRealtimeGatewayProviderAdapter(SETTINGS, connect);
    const abort = new AbortController();
    abort.abort();

    await expect(adapter.connect({ maxSessionSeconds: 59, signal: new AbortController().signal }))
      .rejects.toThrow('rejected');
    await expect(adapter.connect({ maxSessionSeconds: 60, signal: abort.signal }))
      .rejects.toThrow('rejected');
    expect(connect).not.toHaveBeenCalled();
  });
});
