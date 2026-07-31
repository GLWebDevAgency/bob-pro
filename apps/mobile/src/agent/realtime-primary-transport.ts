import { MISTRAL_CONVERSATION_PROTOCOL } from '@bob/ai';
import type { RealtimeVoiceConfig } from '@bob/api-client';
import type {
  MistralConversationCheckpointBinding,
  RealtimeMistralConversationNegotiation,
} from '../realtime/mistral-conversation-runtime';
import type {
  RealtimeMistralPcmNegotiation,
} from '../realtime/mistral-realtime-transport';
import { MISTRAL_PCM_UPLINK_PROTOCOL } from '../realtime/mistral-pcm-uplink';
import type {
  RealtimeAuditedUplinkTransport,
} from '../realtime/realtime-audited-conversation-transport';
import { RealtimeTransportError } from '../realtime/realtime-transport';
import type {
  RealtimeWebRtcNegotiation,
} from '../realtime/webrtc-realtime-transport';

function isWebRtc(
  value: RealtimeVoiceConfig,
): value is RealtimeWebRtcNegotiation {
  return value.transport === 'webrtc';
}

function isMistralConversation(
  value: RealtimeVoiceConfig,
): value is RealtimeMistralConversationNegotiation {
  return value.transport === 'mistral-pcm'
    && value.protocol === MISTRAL_CONVERSATION_PROTOCOL;
}

function isMistralPcm(
  value: RealtimeVoiceConfig,
): value is RealtimeMistralPcmNegotiation {
  return value.transport === 'mistral-pcm'
    && (
      value.protocol === undefined
      || value.protocol === MISTRAL_PCM_UPLINK_PROTOCOL
    );
}

export interface RealtimePrimaryTransportFactories {
  readonly webRtc: (
    negotiation: RealtimeWebRtcNegotiation,
  ) => RealtimeAuditedUplinkTransport;
  readonly mistralConversation: (
    negotiation: RealtimeMistralConversationNegotiation,
    checkpoint: MistralConversationCheckpointBinding,
  ) => RealtimeAuditedUplinkTransport;
  readonly mistralPcm: (
    negotiation: RealtimeMistralPcmNegotiation,
  ) => RealtimeAuditedUplinkTransport;
}

export interface RealtimePrimaryTransportSelection {
  readonly uplink: RealtimeAuditedUplinkTransport;
  /**
   * Capability locale réellement consommée par le transport Mistral V2. `null` est une preuve
   * structurelle qu'un checkpoint résiduel n'a aucune autorité sur une session OpenAI/Mistral V1.
   */
  readonly checkpointUsed: MistralConversationCheckpointBinding | null;
}

/**
 * Frontière d'isolation acoustique : la négociation serveur choisit exactement UNE fabrique.
 *
 * Conserver le checkpoint dans l'arbre React n'autorise aucun I/O Mistral. Seul le protocole
 * conversation V2 explicitement négocié peut le remettre à son transport ; les branches OpenAI
 * et Mistral PCM ne touchent jamais la fabrique V2.
 */
export function createRealtimePrimaryTransport(input: {
  readonly negotiation: RealtimeVoiceConfig;
  readonly checkpoint: MistralConversationCheckpointBinding | null;
  readonly factories: RealtimePrimaryTransportFactories;
}): RealtimePrimaryTransportSelection {
  if (isWebRtc(input.negotiation)) {
    return Object.freeze({
      uplink: input.factories.webRtc(input.negotiation),
      checkpointUsed: null,
    });
  }
  if (isMistralConversation(input.negotiation)) {
    if (input.checkpoint === null) {
      throw new RealtimeTransportError('bootstrap_failed');
    }
    return Object.freeze({
      uplink: input.factories.mistralConversation(input.negotiation, input.checkpoint),
      checkpointUsed: input.checkpoint,
    });
  }
  if (isMistralPcm(input.negotiation)) {
    return Object.freeze({
      uplink: input.factories.mistralPcm(input.negotiation),
      checkpointUsed: null,
    });
  }
  throw new RealtimeTransportError('backend_disabled');
}
