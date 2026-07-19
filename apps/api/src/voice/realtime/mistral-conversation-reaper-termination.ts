import { parseMistralConversationProviderCallId } from './mistral-conversation-admission';
import type { MistralRealtimeTerminationAuthority } from './mistral-realtime-termination';
import type {
  RealtimeProviderTerminationAdapter,
  RealtimeProviderTerminationRequest,
} from './realtime-provider-registry';

export type MistralConversationReaperTerminationResult =
  | { readonly status: 'terminated' | 'replayed' }
  | { readonly status: 'invalid' | 'stale_fence' | 'unavailable' };

export interface MistralConversationReaperTerminationAuthority {
  terminateReaping(
    request: RealtimeProviderTerminationRequest,
  ): Promise<MistralConversationReaperTerminationResult>;
}

export class MistralConversationTerminationRouterError extends Error {
  constructor(readonly code: 'v1_unavailable' | 'v2_unavailable' | 'invalid_v2_identity') {
    super(`mistral_termination_${code}`);
    this.name = 'MistralConversationTerminationRouterError';
  }
}

/** Route durable par namespace. Un identifiant mcv2 malformé ne retombe jamais sur Voxtral v1. */
export class MistralConversationTerminationRouter
implements RealtimeProviderTerminationAdapter {
  readonly providerId = 'mistral' as const;

  constructor(
    private readonly v1: MistralRealtimeTerminationAuthority | null,
    private readonly v2: MistralConversationReaperTerminationAuthority | null,
  ) {}

  async hangupCall(request: RealtimeProviderTerminationRequest): Promise<void> {
    const bootstrapId = parseMistralConversationProviderCallId(request.providerCallId);
    if (bootstrapId !== null) {
      if (!this.v2) throw new MistralConversationTerminationRouterError('v2_unavailable');
      const result = await this.v2.terminateReaping(request);
      if (result.status === 'terminated' || result.status === 'replayed') return;
      throw new MistralConversationTerminationRouterError('v2_unavailable');
    }
    if (request.providerCallId.startsWith('mcv2:')) {
      throw new MistralConversationTerminationRouterError('invalid_v2_identity');
    }
    if (!this.v1) throw new MistralConversationTerminationRouterError('v1_unavailable');
    await this.v1.hangupCall(
      request.providerCallId,
      request.hardExpiryProof ?? undefined,
    );
  }
}
