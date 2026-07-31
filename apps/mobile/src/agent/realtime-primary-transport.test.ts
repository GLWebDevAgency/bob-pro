import { describe, expect, it, vi } from 'vitest';
import { MISTRAL_CONVERSATION_PROTOCOL } from '@bob/ai';
import type { RealtimeVoiceConfig } from '@bob/api-client';
import type {
  MistralConversationCheckpointBinding,
} from '../realtime/mistral-conversation-runtime';
import type {
  RealtimeAuditedUplinkTransport,
} from '../realtime/realtime-audited-conversation-transport';
import { createRealtimePrimaryTransport } from './realtime-primary-transport';

const OPENAI: RealtimeVoiceConfig = Object.freeze({
  available: true,
  transport: 'webrtc',
  model: 'gpt-realtime-2.1',
  voice: 'marin',
  configVersion: 'bob-live-provider-neutral-v4',
  requiresDevelopmentBuild: true,
  maxSessionSeconds: 900,
  speechDelivery: 'openai-native-webrtc-v1',
});

const MISTRAL_V1: RealtimeVoiceConfig = Object.freeze({
  available: true,
  transport: 'mistral-pcm',
  model: 'voxtral-mini-transcribe-realtime-2602',
  voice: 'marin',
  configVersion: 'bob-live-provider-neutral-v2',
  requiresDevelopmentBuild: true,
  maxSessionSeconds: 60,
  speechDelivery: 'audited-signed-url-v1',
});

const MISTRAL_V2: RealtimeVoiceConfig = Object.freeze({
  ...MISTRAL_V1,
  protocol: MISTRAL_CONVERSATION_PROTOCOL,
  configVersion: 'bob-live-provider-neutral-v4',
});

function uplink(label: string): RealtimeAuditedUplinkTransport {
  return { label } as unknown as RealtimeAuditedUplinkTransport;
}

function residualCheckpoint(): MistralConversationCheckpointBinding {
  return {
    store: { residual: true },
    fence: {
      identity: { subjectId: 'user-owner', companyId: 'company-owner' },
      generation: 3,
      capability: 'checkpoint-capability',
    },
  } as unknown as MistralConversationCheckpointBinding;
}

describe('createRealtimePrimaryTransport — isolation checkpoint/provider', () => {
  it('laisse un checkpoint Mistral résiduel totalement inerte sous une session OpenAI', () => {
    const checkpoint = residualCheckpoint();
    const checkpointLoad = vi.fn();
    const resumeTicket = vi.fn();
    const openMistralSocket = vi.fn();
    const webRtc = vi.fn(() => uplink('openai'));
    const mistralConversation = vi.fn(() => {
      checkpointLoad();
      resumeTicket();
      openMistralSocket();
      return uplink('mistral-v2');
    });
    const mistralPcm = vi.fn(() => uplink('mistral-v1'));

    const selected = createRealtimePrimaryTransport({
      negotiation: OPENAI,
      checkpoint,
      factories: { webRtc, mistralConversation, mistralPcm },
    });

    expect(selected).toEqual({
      uplink: expect.objectContaining({ label: 'openai' }),
      checkpointUsed: null,
    });
    expect(webRtc).toHaveBeenCalledOnce();
    expect(mistralConversation).not.toHaveBeenCalled();
    expect(mistralPcm).not.toHaveBeenCalled();
    expect(checkpointLoad).not.toHaveBeenCalled();
    expect(resumeTicket).not.toHaveBeenCalled();
    expect(openMistralSocket).not.toHaveBeenCalled();
  });

  it('ne remet la capability checkpoint qu’au protocole Mistral conversation V2 explicite', () => {
    const checkpoint = residualCheckpoint();
    const mistralConversation = vi.fn(() => uplink('mistral-v2'));

    const selected = createRealtimePrimaryTransport({
      negotiation: MISTRAL_V2,
      checkpoint,
      factories: {
        webRtc: vi.fn(() => uplink('openai')),
        mistralConversation,
        mistralPcm: vi.fn(() => uplink('mistral-v1')),
      },
    });

    expect(selected.checkpointUsed).toBe(checkpoint);
    expect(mistralConversation).toHaveBeenCalledWith(MISTRAL_V2, checkpoint);
  });

  it('ignore aussi le checkpoint résiduel sur le protocole Mistral PCM V1', () => {
    const checkpoint = residualCheckpoint();
    const mistralPcm = vi.fn(() => uplink('mistral-v1'));
    const mistralConversation = vi.fn(() => uplink('mistral-v2'));

    const selected = createRealtimePrimaryTransport({
      negotiation: MISTRAL_V1,
      checkpoint,
      factories: {
        webRtc: vi.fn(() => uplink('openai')),
        mistralConversation,
        mistralPcm,
      },
    });

    expect(selected.checkpointUsed).toBeNull();
    expect(mistralPcm).toHaveBeenCalledOnce();
    expect(mistralConversation).not.toHaveBeenCalled();
  });

  it('échoue fermé si Mistral V2 est choisi sans coffre owner-bound prêt', () => {
    expect(() => createRealtimePrimaryTransport({
      negotiation: MISTRAL_V2,
      checkpoint: null,
      factories: {
        webRtc: vi.fn(() => uplink('openai')),
        mistralConversation: vi.fn(() => uplink('mistral-v2')),
        mistralPcm: vi.fn(() => uplink('mistral-v1')),
      },
    })).toThrowError(/bootstrap_failed/u);
  });
});
