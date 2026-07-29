import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeQuoteAgentMissionResume } from './agent-mission-codec';
import { HttpBobClient } from './http-client';
import { LocalBobClient } from './local-client';

const MISSION_ID = '11111111-1111-4111-8111-111111111111';
const CHOICE_ONE = '22222222-2222-4222-8222-222222222222';
const CHOICE_TWO = '33333333-3333-4333-8333-333333333333';

function wire() {
  return {
    mission: {
      id: MISSION_ID,
      status: 'active',
      phase: 'awaiting_customer_choice',
      revision: 3,
      actionable: true,
      draft: {
        sessionId: 'quote-draft-session-1',
        slotRevision: 1,
        contentRevision: 0,
      },
      idleExpiresAt: '2026-07-30T08:00:00.000Z',
      hardExpiresAt: '2026-08-05T08:00:00.000Z',
    },
    draft: {
      sessionId: 'quote-draft-session-1',
      slotRevision: 1,
      contentRevision: 0,
      step: 'client',
    },
    customerChoices: [
      {
        status: 'available',
        choiceId: CHOICE_ONE,
        label: 'Camping les Pins renommé',
      },
      {
        status: 'unavailable',
        choiceId: CHOICE_TWO,
      },
    ],
  };
}

describe('AgentMission cold resume client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('décode uniquement le DTO minimal exact et conserve l’ordre autoritaire', () => {
    expect(decodeQuoteAgentMissionResume(wire())).toEqual(wire());
    expect(decodeQuoteAgentMissionResume({ mission: null })).toEqual({
      mission: null,
    });
    expect(decodeQuoteAgentMissionResume({
      ...wire(),
      currentBinding: { realtimeSessionId: 'forbidden' },
    })).toBeNull();
    expect(decodeQuoteAgentMissionResume({
      ...wire(),
      draft: { ...wire().draft, slotRevision: 2 },
    })).toBeNull();
    expect(decodeQuoteAgentMissionResume({
      ...wire(),
      customerChoices: [
        wire().customerChoices[0],
        { ...wire().customerChoices[0] },
      ],
    })).toBeNull();
    expect(decodeQuoteAgentMissionResume({
      ...wire(),
      customerChoices: [{
        status: 'available',
        choiceId: CHOICE_ONE,
        label: 'Client\u0000injecté',
      }],
    })).toBeNull();
    expect(decodeQuoteAgentMissionResume({
      ...wire(),
      customerChoices: [
        {
          status: 'available',
          choiceId: CHOICE_ONE,
          label: '  Camping  Les\tPins ',
        },
        wire().customerChoices[1],
      ],
    })).toMatchObject({
      customerChoices: [
        {
          status: 'available',
          choiceId: CHOICE_ONE,
          label: 'Camping Les Pins',
        },
        { status: 'unavailable', choiceId: CHOICE_TWO },
      ],
    });
  });

  it('fait un GET JWT sans body ni capability et refuse une réponse difforme', async () => {
    const getToken = vi.fn(async () => 'supabase-jwt');
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.method).toBe('GET');
      expect(init?.body).toBeUndefined();
      expect(init?.headers).toMatchObject({
        authorization: 'Bearer supabase-jwt',
      });
      expect(init?.headers).not.toHaveProperty('x-bob-agent-mission-capability');
      return new Response(JSON.stringify(wire()), {
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBobClient({
      baseUrl: 'https://api.bob.test',
      companyId: 'company-1',
      getToken,
    });

    await expect(client.getCurrentQuoteAgentMissionResume()).resolves.toEqual({
      ok: true,
      value: wire(),
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://api.bob.test/agent-missions/current/quote-creation/resume',
    );

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      ...wire(),
      tenantId: 'forged',
    }), {
      headers: { 'content-type': 'application/json' },
    }));
    await expect(client.getCurrentQuoteAgentMissionResume()).resolves.toMatchObject({
      ok: false,
      error: { kind: 'dependency', port: 'api-contract' },
    });
  });

  it('reste fail-closed sur le client local au lieu de fabriquer mission:null', async () => {
    await expect(
      new LocalBobClient().getCurrentQuoteAgentMissionResume(),
    ).resolves.toEqual({
      ok: false,
      error: {
        kind: 'unavailable',
        service: 'agent_mission_resume_persistence',
      },
    });
  });
});
