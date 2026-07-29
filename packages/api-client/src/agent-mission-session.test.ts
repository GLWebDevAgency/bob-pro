import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentMission,
  toAgentMissionView,
  type AgentMissionViewV1,
} from '@bob/core';
import { HttpBobClient } from './http-client';

const CONFIG_VERSION = 'bob-live-provider-neutral-v4';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const MISSION_ID = '11111111-1111-4111-8111-111111111111';
const CAPABILITY = `bam1_${Buffer.alloc(32, 7).toString('base64url')}`;
const CREATED_AT = '2026-07-26T08:00:00.000Z';
const ACKNOWLEDGED_AT = '2026-07-26T08:01:00.000Z';
const ACK_COMMAND_ID = '55555555-5555-4555-8555-555555555555';
const DRAFT = Object.freeze({
  sessionId: 'quote-draft-session-1',
  slotRevision: 1,
  contentRevision: 0,
});

function initialMission() {
  const result = AgentMission.start({
    id: MISSION_ID,
    companyId: 'company-1',
    ownerUserId: 'user-1',
    createdAt: CREATED_AT,
    stagedCustomerResolution: null,
    startOutcome: 'no_slot',
    draft: DRAFT,
  });
  if (!result.ok) throw new Error(`Mission fixture invalide: ${result.error.code}`);
  return result.value.mission;
}

function missionView(mission: AgentMission, now: string): AgentMissionViewV1 {
  const result = toAgentMissionView(mission, now);
  if (!result.ok) throw new Error(`Vue fixture invalide: ${result.error.kind}`);
  return result.value;
}

function acknowledgedMission() {
  const result = initialMission().acknowledgeQuoteScreen({
    expectedRevision: 1,
    binding: {
      realtimeSessionId: SESSION_ID,
      contextRevision: 3,
      contextDigest: 'a'.repeat(64),
      screenName: '/devis/new',
      screenInstanceId: 'quote-screen-1',
      acknowledgedAt: ACKNOWLEDGED_AT,
    },
    observedDraft: DRAFT,
    draftHasCustomer: false,
    occurredAt: ACKNOWLEDGED_AT,
  });
  if (!result.ok) throw new Error(`ACK fixture invalide: ${result.error.code}`);
  return result.value.mission;
}

function selectedMission() {
  const result = acknowledgedMission().selectCustomer({
    expectedRevision: 2,
    source: 'screen_selection',
    customerId: 'customer-camping',
    updatedDraft: {
      sessionId: DRAFT.sessionId,
      slotRevision: 2,
      contentRevision: 1,
    },
    occurredAt: '2026-07-26T08:02:00.000Z',
  });
  if (!result.ok) throw new Error(`Sélection fixture invalide: ${result.error.code}`);
  return result.value.mission;
}

function nativeBootstrap(
  negotiation: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    transport: 'webrtc',
    answerSdp: 'v=0\r\nm=audio 9 RTP/AVP 0\r\na=recvonly\r\n',
    sessionHandle: SESSION_ID,
    hardExpiresAt: '2026-07-26T08:15:00.000Z',
    model: 'gpt-realtime-2.1',
    voice: 'marin',
    configVersion: CONFIG_VERSION,
    speechDelivery: 'openai-native-webrtc-v1',
    maxSessionSeconds: 900,
    ...negotiation,
  };
}

function client(getToken?: () => Promise<string | null>): HttpBobClient {
  return new HttpBobClient({
    baseUrl: 'https://api.bob.test',
    companyId: 'company-1',
    ...(getToken === undefined ? {} : { getToken }),
  });
}

function nativeCallInput(
  agentMissionProtocolVersion?: 1 | null,
): Parameters<HttpBobClient['createRealtimeVoiceCall']>[0] {
  return {
    transport: 'webrtc',
    sdp: 'v=0\r\nm=audio 9 RTP/AVP 0\r\n',
    configVersion: CONFIG_VERSION,
    speechDelivery: 'openai-native-webrtc-v1',
    sessionHandle: SESSION_ID,
    ...(agentMissionProtocolVersion === undefined
      ? {}
      : { agentMissionProtocolVersion }),
  };
}

describe('Realtime AgentMission capability handle', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('encapsule le secret, pose seule le header et injecte le vrai realtimeSessionId', async () => {
    const initialView = missionView(initialMission(), CREATED_AT);
    const acknowledgedView = missionView(acknowledgedMission(), ACKNOWLEDGED_AT);
    const selectedView = missionView(selectedMission(), '2026-07-26T08:02:00.000Z');
    const cancelled = initialMission().cancel({
      expectedRevision: 1,
      reason: 'user_cancelled',
      occurredAt: ACKNOWLEDGED_AT,
    });
    if (!cancelled.ok) throw new Error(`Cancel fixture invalide: ${cancelled.error.code}`);
    const cancelledView = missionView(cancelled.value.mission, ACKNOWLEDGED_AT);
    const getToken = vi.fn(async () => 'supabase-jwt');
    const paths: string[] = [];
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      if (path === '/voice/realtime/calls') {
        expect(JSON.parse(String(init?.body))).toEqual({
          sdp: 'v=0\r\nm=audio 9 RTP/AVP 0\r\n',
          configVersion: CONFIG_VERSION,
          speechDelivery: 'openai-native-webrtc-v1',
          agentMissionProtocolVersion: 1,
          sessionHandle: SESSION_ID,
        });
        return new Response(JSON.stringify(nativeBootstrap({
          agentMissionProtocolVersion: 1,
          agentMissionCapability: CAPABILITY,
        })), { headers: { 'content-type': 'application/json' } });
      }

      expect(init?.headers).toMatchObject({
        authorization: 'Bearer supabase-jwt',
        'x-bob-agent-mission-capability': CAPABILITY,
      });
      if (
        path
        === `/voice/realtime/calls/${SESSION_ID}/agent-mission-bootstrap-acknowledgements`
      ) {
        expect(init?.method).toBe('POST');
        expect(init?.body).toBeUndefined();
        return new Response(JSON.stringify({
          acknowledged: true,
          replayed: false,
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (path === '/agent-missions/current/quote-creation') {
        expect(init?.method).toBe('GET');
        expect(init?.body).toBeUndefined();
        return new Response(JSON.stringify({ mission: initialView }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (path === '/agent-missions/quote-creation/start') {
        expect(JSON.parse(String(init?.body))).toEqual({
          commandId: '33333333-3333-4333-8333-333333333333',
        });
        return new Response(JSON.stringify({
          outcome: 'created',
          startOutcome: 'no_slot',
          mission: initialView,
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (path === `/agent-missions/${MISSION_ID}/cancel`) {
        expect(JSON.parse(String(init?.body))).toEqual({
          commandId: '44444444-4444-4444-8444-444444444444',
          expectedMissionRevision: 1,
          reason: 'user_cancelled',
        });
        return new Response(JSON.stringify({
          outcome: 'cancelled',
          mission: cancelledView,
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (path === `/agent-missions/${MISSION_ID}/screen-acks`) {
        expect(JSON.parse(String(init?.body))).toEqual({
          commandId: '55555555-5555-4555-8555-555555555555',
          expectedMissionRevision: 1,
          realtimeSessionId: SESSION_ID,
          contextRevision: 3,
          contextDigest: 'a'.repeat(64),
          draftSessionId: DRAFT.sessionId,
          expectedDraftSlotRevision: 1,
          expectedDraftContentRevision: 0,
        });
        return new Response(JSON.stringify({
          outcome: 'acknowledged',
          receipt: {
            ackCommandId: ACK_COMMAND_ID,
            missionId: MISSION_ID,
            missionRevisionAfter: 2,
            realtimeSessionId: SESSION_ID,
            contextRevision: 3,
            contextDigest: 'a'.repeat(64),
            occurredAt: ACKNOWLEDGED_AT,
          },
          mission: acknowledgedView,
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (path === `/agent-missions/${MISSION_ID}/decisions`) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body).not.toHaveProperty('missionId');
        expect(body).not.toHaveProperty('realtimeSessionId');
        expect(body).not.toHaveProperty('actor');
        if (body.action === 'select_screen_customer') {
          expect(body).toEqual({
            action: 'select_screen_customer',
            commandId: '66666666-6666-4666-8666-666666666666',
            expectedMissionRevision: 2,
            expectedDraftSessionId: DRAFT.sessionId,
            expectedDraftSlotRevision: 1,
            expectedDraftContentRevision: 0,
            customerId: 'customer-camping',
          });
        } else {
          expect(body).toEqual({
            action: 'choose_presented_option',
            commandId: '77777777-7777-4777-8777-777777777777',
            expectedMissionRevision: 2,
            expectedDraftSessionId: DRAFT.sessionId,
            expectedDraftSlotRevision: 1,
            expectedDraftContentRevision: 0,
            decisionId: '88888888-8888-4888-8888-888888888888',
            choiceSetRevision: 2,
            choiceId: '99999999-9999-4999-8999-999999999999',
          });
        }
        return new Response(JSON.stringify({
          outcome: 'selected',
          effect: { kind: 'selected' },
          mission: selectedView,
        }), { headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`Route inattendue: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const bootstrap = await client(getToken).createRealtimeVoiceCall(nativeCallInput(1));
    expect(bootstrap.ok).toBe(true);
    if (!bootstrap.ok) return;
    expect(paths.slice(0, 2)).toEqual([
      '/voice/realtime/calls',
      `/voice/realtime/calls/${SESSION_ID}/agent-mission-bootstrap-acknowledgements`,
    ]);
    const handle = bootstrap.value.agentMissionSession;
    expect(handle).not.toBeNull();
    expect(handle).not.toBeUndefined();
    if (!handle) return;

    expect(handle.realtimeSessionId).toBe(SESSION_ID);
    expect(Object.keys(handle)).toEqual([]);
    expect({ ...handle }).toEqual({});
    expect(JSON.stringify(handle)).toBe('{}');
    expect(JSON.stringify(bootstrap.value)).not.toContain('bam1_');
    expect({ ...bootstrap.value }).not.toHaveProperty('agentMissionSession');

    await expect(handle.getCurrentQuoteCreation()).resolves.toEqual({
      ok: true,
      value: { mission: initialView },
    });
    await expect(handle.startQuoteCreation({
      commandId: '33333333-3333-4333-8333-333333333333',
    })).resolves.toMatchObject({ ok: true, value: { outcome: 'created' } });
    await expect(handle.cancelQuoteCreation({
      missionId: MISSION_ID,
      commandId: '44444444-4444-4444-8444-444444444444',
      expectedMissionRevision: 1,
    })).resolves.toMatchObject({ ok: true, value: { outcome: 'cancelled' } });
    await expect(handle.acknowledgeQuoteScreen({
      missionId: MISSION_ID,
      commandId: '55555555-5555-4555-8555-555555555555',
      expectedMissionRevision: 1,
      contextRevision: 3,
      contextDigest: 'a'.repeat(64),
      draftSessionId: DRAFT.sessionId,
      expectedDraftSlotRevision: 1,
      expectedDraftContentRevision: 0,
    })).resolves.toMatchObject({ ok: true, value: { outcome: 'acknowledged' } });
    await expect(handle.decideQuoteCreation({
      missionId: MISSION_ID,
      action: 'select_screen_customer',
      commandId: '66666666-6666-4666-8666-666666666666',
      expectedMissionRevision: 2,
      expectedDraftSessionId: DRAFT.sessionId,
      expectedDraftSlotRevision: 1,
      expectedDraftContentRevision: 0,
      customerId: 'customer-camping',
    })).resolves.toMatchObject({ ok: true, value: { outcome: 'selected' } });
    await expect(handle.decideQuoteCreation({
      missionId: MISSION_ID,
      action: 'choose_presented_option',
      commandId: '77777777-7777-4777-8777-777777777777',
      expectedMissionRevision: 2,
      expectedDraftSessionId: DRAFT.sessionId,
      expectedDraftSlotRevision: 1,
      expectedDraftContentRevision: 0,
      decisionId: '88888888-8888-4888-8888-888888888888',
      choiceSetRevision: 2,
      choiceId: '99999999-9999-4999-8999-999999999999',
    })).resolves.toMatchObject({ ok: true, value: { outcome: 'selected' } });

    const fetchesBeforeDispose = fetchMock.mock.calls.length;
    const tokenReadsBeforeDispose = getToken.mock.calls.length;
    handle.dispose();
    expect(handle.disposed).toBe(true);
    await expect(handle.getCurrentQuoteCreation()).resolves.toMatchObject({
      ok: false,
      error: { kind: 'unavailable' },
    });
    await expect(handle.decideQuoteCreation({
      missionId: MISSION_ID,
      action: 'select_screen_customer',
      commandId: '66666666-6666-4666-8666-666666666666',
      expectedMissionRevision: 2,
      expectedDraftSessionId: DRAFT.sessionId,
      expectedDraftSlotRevision: 1,
      expectedDraftContentRevision: 0,
      customerId: 'customer-camping',
    })).resolves.toMatchObject({
      ok: false,
      error: { kind: 'unavailable' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(fetchesBeforeDispose);
    expect(getToken).toHaveBeenCalledTimes(tokenReadsBeforeDispose);
  });

  it('préserve explicitement null/null sans fabriquer de capability locale', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(nativeBootstrap({
      agentMissionProtocolVersion: null,
      agentMissionCapability: null,
    })), { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await client().createRealtimeVoiceCall(nativeCallInput(null));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.hasOwn(result.value, 'agentMissionSession')).toBe(true);
    expect(result.value.agentMissionSession).toBeNull();
    expect(JSON.stringify(result.value)).not.toContain('agentMission');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('échoue fermé et termine la session avant retour si le reçu durable est refusé', async () => {
    const paths: string[] = [];
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      if (path === '/voice/realtime/calls') {
        return new Response(JSON.stringify(nativeBootstrap({
          agentMissionProtocolVersion: 1,
          agentMissionCapability: CAPABILITY,
        })), { headers: { 'content-type': 'application/json' } });
      }
      if (
        path
        === `/voice/realtime/calls/${SESSION_ID}/agent-mission-bootstrap-acknowledgements`
      ) {
        expect(init?.headers).toMatchObject({
          'x-bob-agent-mission-capability': CAPABILITY,
        });
        return new Response(JSON.stringify({
          error: { kind: 'forbidden', reason: 'agent_mission_bootstrap_receipt_rejected' },
        }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (path === `/voice/realtime/calls/${SESSION_ID}`) {
        expect(init?.method).toBe('DELETE');
        expect(init?.headers).not.toHaveProperty(
          'x-bob-agent-mission-capability',
        );
        return new Response(JSON.stringify({ ended: true }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Route inattendue: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      client().createRealtimeVoiceCall(nativeCallInput(1)),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: 'forbidden' },
    });
    expect(paths).toEqual([
      '/voice/realtime/calls',
      `/voice/realtime/calls/${SESSION_ID}/agent-mission-bootstrap-acknowledgements`,
      `/voice/realtime/calls/${SESSION_ID}`,
    ]);
  });

  it('ne rejoue pas un reçu au contrat invalide et compense la session', async () => {
    const paths: string[] = [];
    const fetchMock = vi.fn(async (url: unknown) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      if (path === '/voice/realtime/calls') {
        return new Response(JSON.stringify(nativeBootstrap({
          agentMissionProtocolVersion: 1,
          agentMissionCapability: CAPABILITY,
        })), { headers: { 'content-type': 'application/json' } });
      }
      if (
        path
        === `/voice/realtime/calls/${SESSION_ID}/agent-mission-bootstrap-acknowledgements`
      ) {
        return new Response(JSON.stringify({ acknowledged: true }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (path === `/voice/realtime/calls/${SESSION_ID}`) {
        return new Response(JSON.stringify({ ended: true }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Route inattendue: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      client().createRealtimeVoiceCall(nativeCallInput(1)),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: 'dependency', port: 'api-contract' },
    });
    expect(paths).toEqual([
      '/voice/realtime/calls',
      `/voice/realtime/calls/${SESSION_ID}/agent-mission-bootstrap-acknowledgements`,
      `/voice/realtime/calls/${SESSION_ID}`,
    ]);
  });

  it('rejoue le même reçu après perte de réponse avant de construire le handle opaque', async () => {
    let receiptAttempts = 0;
    const paths: string[] = [];
    const fetchMock = vi.fn(async (url: unknown) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      if (path === '/voice/realtime/calls') {
        return new Response(JSON.stringify(nativeBootstrap({
          agentMissionProtocolVersion: 1,
          agentMissionCapability: CAPABILITY,
        })), { headers: { 'content-type': 'application/json' } });
      }
      if (
        path
        === `/voice/realtime/calls/${SESSION_ID}/agent-mission-bootstrap-acknowledgements`
      ) {
        receiptAttempts += 1;
        if (receiptAttempts === 1) {
          throw new Error('réponse perdue après commit du reçu');
        }
        return new Response(JSON.stringify({
          acknowledged: true,
          replayed: true,
        }), { headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`Route inattendue: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await client().createRealtimeVoiceCall(nativeCallInput(1));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(receiptAttempts).toBe(2);
    expect(paths).toEqual([
      '/voice/realtime/calls',
      `/voice/realtime/calls/${SESSION_ID}/agent-mission-bootstrap-acknowledgements`,
      `/voice/realtime/calls/${SESSION_ID}/agent-mission-bootstrap-acknowledgements`,
    ]);
    expect(result.value.agentMissionSession?.disposed).toBe(false);
    result.value.agentMissionSession?.dispose();
  });

  it('ne rejoue pas après abort et termine la session avant de rendre la main', async () => {
    const controller = new AbortController();
    const paths: string[] = [];
    const fetchMock = vi.fn(async (url: unknown) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      if (path === '/voice/realtime/calls') {
        return new Response(JSON.stringify(nativeBootstrap({
          agentMissionProtocolVersion: 1,
          agentMissionCapability: CAPABILITY,
        })), { headers: { 'content-type': 'application/json' } });
      }
      if (
        path
        === `/voice/realtime/calls/${SESSION_ID}/agent-mission-bootstrap-acknowledgements`
      ) {
        controller.abort();
        return new Response(JSON.stringify({
          acknowledged: true,
          replayed: false,
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (path === `/voice/realtime/calls/${SESSION_ID}`) {
        return new Response(JSON.stringify({ ended: true }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Route inattendue: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      client().createRealtimeVoiceCall(nativeCallInput(1), controller.signal),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: 'dependency' },
    });
    expect(paths).toEqual([
      '/voice/realtime/calls',
      `/voice/realtime/calls/${SESSION_ID}/agent-mission-bootstrap-acknowledgements`,
      `/voice/realtime/calls/${SESSION_ID}`,
    ]);
  });

  it('compense un bootstrap V1 mal formé avec le handle demandé', async () => {
    const paths: string[] = [];
    const fetchMock = vi.fn(async (url: unknown) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      if (path === '/voice/realtime/calls') {
        return new Response(JSON.stringify(nativeBootstrap({
          agentMissionProtocolVersion: 1,
        })), { headers: { 'content-type': 'application/json' } });
      }
      if (path === `/voice/realtime/calls/${SESSION_ID}`) {
        return new Response(JSON.stringify({ ended: true }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Route inattendue: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      client().createRealtimeVoiceCall(nativeCallInput(1)),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: 'dependency', port: 'api-contract' },
    });
    expect(paths).toEqual([
      '/voice/realtime/calls',
      `/voice/realtime/calls/${SESSION_ID}`,
    ]);
  });

  it.each([
    ['réponse N+1 ajoutée à une demande omise', undefined, {
      agentMissionProtocolVersion: null,
      agentMissionCapability: null,
    }],
    ['paire absente après demande V1', 1, {}],
    ['capability absente', 1, { agentMissionProtocolVersion: 1 }],
    ['version absente', 1, { agentMissionCapability: CAPABILITY }],
    ['capability non canonique', 1, {
      agentMissionProtocolVersion: 1,
      agentMissionCapability: 'bam1_invalide',
    }],
    ['version inconnue', 1, {
      agentMissionProtocolVersion: 2,
      agentMissionCapability: CAPABILITY,
    }],
    ['capability interdite après demande null', null, {
      agentMissionProtocolVersion: 1,
      agentMissionCapability: CAPABILITY,
    }],
  ] as const)('refuse toute négociation partielle ou discordante : %s', async (
    _label,
    requested,
    responseBinding,
  ) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(
      nativeBootstrap(responseBinding),
    ), { headers: { 'content-type': 'application/json' } })));

    const result = await client().createRealtimeVoiceCall(nativeCallInput(requested));
    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'dependency', port: 'api-contract' },
    });
  });

  it('refuse une propriété présente mais undefined avant token et réseau', async () => {
    const getToken = vi.fn(async () => 'supabase-jwt');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const input = {
      ...nativeCallInput(),
      agentMissionProtocolVersion: undefined,
    } as never;
    await expect(client(getToken).createRealtimeVoiceCall(input)).resolves.toMatchObject({
      ok: false,
      error: { kind: 'validation' },
    });
    expect(getToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
