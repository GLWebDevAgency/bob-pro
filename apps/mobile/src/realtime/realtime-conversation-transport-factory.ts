import type { RealtimeVoiceConfig } from '@bob/api-client';
import type {
  RealtimeAuditedUplinkTransport,
} from './realtime-audited-conversation-transport';
import {
  RealtimeTransportError,
  type VoiceConversationTransport,
} from './realtime-transport';

export type RealtimePrimaryConversationTransport = VoiceConversationTransport & {
  readonly completionMode: 'continuous' | 'one-shot';
};

/**
 * Sélectionne une seule autorité acoustique à partir du contrat serveur exact.
 *
 * Le RTP OpenAI natif conserve le WebRTC brut. Tous les contrats audités composent le lecteur
 * signé historique, y compris le WebRTC N-1 et les deux protocoles Mistral.
 */
export function composeRealtimeConversationTransport(
  negotiation: RealtimeVoiceConfig,
  uplink: RealtimeAuditedUplinkTransport,
  wrapAudited: (
    auditedUplink: RealtimeAuditedUplinkTransport,
  ) => RealtimePrimaryConversationTransport,
): RealtimePrimaryConversationTransport {
  if (negotiation.speechDelivery === 'openai-native-webrtc-v1') {
    if (negotiation.transport !== 'webrtc' || uplink.completionMode !== 'continuous') {
      throw new RealtimeTransportError('bootstrap_failed');
    }
    return uplink as RealtimePrimaryConversationTransport;
  }
  if (negotiation.speechDelivery === 'audited-signed-url-v1') {
    return wrapAudited(uplink);
  }
  throw new RealtimeTransportError('bootstrap_failed');
}
