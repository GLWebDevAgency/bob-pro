import { describe, expect, it, vi } from 'vitest';
import type { RealtimeVoiceConfig } from '@bob/api-client';
import type { RealtimeAuditedUplinkTransport } from './realtime-audited-conversation-transport';
import {
  composeRealtimeConversationTransport,
  type RealtimePrimaryConversationTransport,
} from './realtime-conversation-transport-factory';

const COMMON = {
  available: true,
  model: 'gpt-realtime-2.1',
  voice: 'marin',
  configVersion: 'bob-live-provider-neutral-v4',
  requiresDevelopmentBuild: true,
  maxSessionSeconds: 900,
} as const;

function transport(completionMode?: 'continuous'): RealtimeAuditedUplinkTransport {
  const value = { ...(completionMode === undefined ? {} : { completionMode }) };
  return value as unknown as RealtimeAuditedUplinkTransport;
}

describe('composeRealtimeConversationTransport', () => {
  it('retourne le WebRTC brut sans construire de lecteur signé pour le contrat natif', () => {
    const negotiation: RealtimeVoiceConfig = {
      ...COMMON,
      transport: 'webrtc',
      speechDelivery: 'openai-native-webrtc-v1',
    };
    const rawWebRtc = transport('continuous');
    const wrapAudited = vi.fn();

    expect(composeRealtimeConversationTransport(negotiation, rawWebRtc, wrapAudited))
      .toBe(rawWebRtc);
    expect(wrapAudited).not.toHaveBeenCalled();
  });

  it.each<Readonly<[string, RealtimeVoiceConfig]>>([
    ['WebRTC N-1', {
      ...COMMON,
      transport: 'webrtc',
      speechDelivery: 'audited-signed-url-v1',
    }],
    ['Mistral v1', {
      ...COMMON,
      transport: 'mistral-pcm',
      protocol: 'bob.mistral-pcm.v1',
      speechDelivery: 'audited-signed-url-v1',
    }],
    ['Mistral v2', {
      ...COMMON,
      transport: 'mistral-pcm',
      protocol: 'bob.mistral-pcm.v2',
      speechDelivery: 'audited-signed-url-v1',
    }],
  ])('conserve le wrapper audité pour %s', (_label, negotiation) => {
    const uplink = transport();
    const wrapper = {} as RealtimePrimaryConversationTransport;
    const wrapAudited = vi.fn(() => wrapper);

    expect(composeRealtimeConversationTransport(negotiation, uplink, wrapAudited)).toBe(wrapper);
    expect(wrapAudited).toHaveBeenCalledOnce();
    expect(wrapAudited).toHaveBeenCalledWith(uplink);
  });

  it('échoue fermé si un contrat natif est mélangé à un uplink non WebRTC brut', () => {
    const mixed = {
      ...COMMON,
      transport: 'mistral-pcm',
      speechDelivery: 'openai-native-webrtc-v1',
    } as unknown as RealtimeVoiceConfig;

    expect(() => composeRealtimeConversationTransport(mixed, transport(), vi.fn()))
      .toThrow('bootstrap_failed');
  });
});
