import { describe, expect, it, vi } from 'vitest';
import type { RealtimeProviderTerminationRequest } from './realtime-provider-registry';
import type { MistralRealtimeTerminationAuthority } from './mistral-realtime-termination';
import {
  MistralConversationTerminationRouter,
  type MistralConversationReaperTerminationAuthority,
} from './mistral-conversation-reaper-termination';

const BOOTSTRAP_ID = '30000000-0000-4000-8000-000000000001';

function request(providerCallId = `mcv2:${BOOTSTRAP_ID}`): RealtimeProviderTerminationRequest {
  return {
    companyId: 'company-1',
    subjectHash: 'a'.repeat(64),
    sessionId: '30000000-0000-4000-8000-000000000002',
    providerId: 'mistral',
    providerCallId,
    reaperToken: 'R'.repeat(43),
    reaperLeaseExpiresAt: '2026-07-19T10:00:30.000Z',
    terminationCause: 'lease_expired',
    hardExpiryProof: null,
  };
}

function v1(hangupCall: ReturnType<typeof vi.fn>): MistralRealtimeTerminationAuthority {
  return { hangupCall } as unknown as MistralRealtimeTerminationAuthority;
}

function v2(
  terminateReaping: ReturnType<typeof vi.fn>,
): MistralConversationReaperTerminationAuthority {
  return { terminateReaping };
}

describe('Mistral conversation termination router', () => {
  it('route mcv2 avec le claim owner-fencé complet et ne contacte jamais Voxtral v1', async () => {
    const hangupV1 = vi.fn(async () => undefined);
    const terminateV2 = vi.fn(async () => ({ status: 'terminated' as const }));
    const input = request();
    const router = new MistralConversationTerminationRouter(v1(hangupV1), v2(terminateV2));

    await expect(router.hangupCall(input)).resolves.toBeUndefined();
    expect(terminateV2).toHaveBeenCalledWith(input);
    expect(hangupV1).not.toHaveBeenCalled();
  });

  it('interdit tout fallback v1 pour un namespace mcv2 absent ou malformé', async () => {
    const hangupV1 = vi.fn(async () => undefined);
    await expect(new MistralConversationTerminationRouter(v1(hangupV1), null)
      .hangupCall(request())).rejects.toMatchObject({ code: 'v2_unavailable' });
    await expect(new MistralConversationTerminationRouter(v1(hangupV1), null)
      .hangupCall(request('mcv2:not-a-uuid'))).rejects.toMatchObject({
      code: 'invalid_v2_identity',
    });
    expect(hangupV1).not.toHaveBeenCalled();
  });

  it('conserve le chemin Voxtral v1 historique hors namespace réservé', async () => {
    const hangupV1 = vi.fn(async () => undefined);
    const terminateV2 = vi.fn(async () => ({ status: 'terminated' as const }));
    const router = new MistralConversationTerminationRouter(v1(hangupV1), v2(terminateV2));

    await router.hangupCall(request('voxtral_remote_session_1'));
    expect(hangupV1).toHaveBeenCalledWith('voxtral_remote_session_1', undefined);
    expect(terminateV2).not.toHaveBeenCalled();
  });
});
