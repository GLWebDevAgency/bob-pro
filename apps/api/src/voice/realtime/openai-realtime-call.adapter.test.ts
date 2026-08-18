import { describe, expect, it, vi } from 'vitest';
import {
  DisabledOpenAiRealtimeCallProvider,
  OpenAiRealtimeCallAdapter,
  RealtimeProviderCallCompensatedError,
  RealtimeProviderCleanupError,
} from './openai-realtime-call.adapter';
import {
  buildOpenAiNativeRealtimeSessionConfig,
  buildOpenAiRealtimeSessionConfig,
} from './realtime-session-config';
import type { OpenAiRealtimeCallInput } from './realtime.types';

const OFFER_SDP = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
const DATA_CHANNEL_SDP = 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=sendrecv\r\na=sctp-port:5000\r\n';
const ANSWER_SDP = `v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=recvonly\r\n${DATA_CHANNEL_SDP}`;
const NATIVE_ANSWER_SDP = `v=0\r\no=- 3 3 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\n${DATA_CHANNEL_SDP}`;
const SETTINGS = {
  apiKey: 'server-key-never-returned',
  baseUrl: 'https://api.openai.test/v1',
  providerTimeoutMs: 5_000,
  model: 'gpt-realtime-2.1',
  voice: 'marin' as const,
};

function callInput(overrides: Partial<OpenAiRealtimeCallInput> = {}): OpenAiRealtimeCallInput {
  return {
    offerSdp: OFFER_SDP,
    safetyIdentifier: 'bob_hmac-only',
    session: buildOpenAiRealtimeSessionConfig(SETTINGS),
    onCallCreated: async () => undefined,
    ...overrides,
  };
}

function providerResponse(callId: string, onFirstRead: () => void = () => undefined): Response {
  let delivered = false;
  const reader = {
    read: vi.fn(async () => {
      if (delivered) return { done: true, value: undefined };
      delivered = true;
      onFirstRead();
      return { done: false, value: new TextEncoder().encode(ANSWER_SDP) };
    }),
    cancel: vi.fn(async () => undefined),
    releaseLock: vi.fn(),
  };
  return {
    ok: true,
    status: 200,
    headers: new Headers({ location: `/v1/realtime/calls/${callId}` }),
    body: { getReader: () => reader },
  } as unknown as Response;
}

describe('OpenAiRealtimeCallAdapter', () => {
  it('reste totalement inerte quand le profil OpenAI est désactivé', async () => {
    const adapter = new DisabledOpenAiRealtimeCallProvider();

    await expect(adapter.createCall(callInput())).rejects.toThrow('openai_realtime_provider_disabled');
    await expect(adapter.hangupCall('rtc_never_sent')).rejects.toThrow('openai_realtime_provider_disabled');
  });

  it('envoie SDP, configuration verrouillée et safety identifier puis extrait le call_id', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(ANSWER_SDP, {
      status: 200,
      headers: { location: '/v1/realtime/calls/rtc_123456' },
    }));
    const adapter = new OpenAiRealtimeCallAdapter(SETTINGS, fetchMock);
    const session = buildOpenAiRealtimeSessionConfig(SETTINGS);

    const onCallCreated = vi.fn(async () => undefined);
    const result = await adapter.createCall(callInput({ session, onCallCreated }));

    expect(result).toEqual({ answerSdp: ANSWER_SDP, callId: 'rtc_123456' });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.openai.test/v1/realtime/calls');
    expect(init?.headers).toMatchObject({
      authorization: 'Bearer server-key-never-returned',
      'OpenAI-Safety-Identifier': 'bob_hmac-only',
    });
    const body = init?.body as FormData;
    expect(body.get('sdp')).toBe(OFFER_SDP);
    expect(JSON.parse(String(body.get('session')))).toEqual(session);
    expect(JSON.parse(String(body.get('session')))).toMatchObject({ tools: [], tool_choice: 'none', tracing: null });
    expect(onCallCreated).toHaveBeenCalledOnce();
    expect(onCallCreated).toHaveBeenCalledWith('rtc_123456');
  });

  it.each([
    ['explicite', NATIVE_ANSWER_SDP],
    [
      'implicite',
      'v=0\r\no=- 4 4 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n',
    ],
  ] as const)('accepte le SDP natif sendrecv %s après le bind durable', async (_label, answerSdp) => {
    const order: string[] = [];
    const adapter = new OpenAiRealtimeCallAdapter(SETTINGS, async () => new Response(answerSdp, {
      status: 200,
      headers: { location: '/v1/realtime/calls/rtc_native_answer' },
    }));

    await expect(adapter.createCall(callInput({
      session: buildOpenAiNativeRealtimeSessionConfig(SETTINGS),
      onCallCreated: async () => { order.push('bind'); },
    }))).resolves.toEqual({ answerSdp, callId: 'rtc_native_answer' });

    expect(order).toEqual(['bind']);
  });

  it('compense après bind une réponse native recvonly que le mobile aurait refusée', async () => {
    const order: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/hangup')) {
        order.push('hangup');
        return new Response(null, { status: 200 });
      }
      return new Response(ANSWER_SDP, {
        status: 200,
        headers: { location: '/v1/realtime/calls/rtc_native_recvonly' },
      });
    });
    const adapter = new OpenAiRealtimeCallAdapter(SETTINGS, fetchMock);

    await expect(adapter.createCall(callInput({
      session: buildOpenAiNativeRealtimeSessionConfig(SETTINGS),
      onCallCreated: async () => { order.push('bind'); },
    }))).rejects.toMatchObject({
      message: 'provider_invalid_sdp',
      providerTermination: 'confirmed',
    });

    expect(order).toEqual(['bind', 'hangup']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('ne durcit pas le rail audité publié avant le cutover natif', async () => {
    const fetchMock = vi.fn(async () => new Response(NATIVE_ANSWER_SDP, {
      status: 200,
      headers: { location: '/v1/realtime/calls/rtc_audited_historical' },
    }));
    const adapter = new OpenAiRealtimeCallAdapter(SETTINGS, fetchMock);

    await expect(adapter.createCall(callInput())).resolves.toEqual({
      answerSdp: NATIVE_ANSWER_SDP,
      callId: 'rtc_audited_historical',
    });

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('échoue fermé si OpenAI omet le call_id nécessaire au sideband', async () => {
    const adapter = new OpenAiRealtimeCallAdapter(SETTINGS, async () => new Response(ANSWER_SDP, { status: 200 }));

    await expect(adapter.createCall(callInput())).rejects.toThrow('provider_call_id_missing');
  });

  it('ne lit ni ne relaie le corps sensible d’une erreur fournisseur', async () => {
    const secretBody = 'provider says customer-name and secret';
    const adapter = new OpenAiRealtimeCallAdapter(SETTINGS, async () => new Response(secretBody, { status: 429 }));

    await expect(adapter.createCall(callInput())).rejects.toThrow('provider_http_4xx');
  });

  it('borne la réponse SDP avant allocation non maîtrisée', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => (
      String(url).endsWith('/hangup')
        ? new Response(null, { status: 204 })
        : new Response('x', {
            status: 200,
            headers: {
              location: '/v1/realtime/calls/rtc_12345678',
              'content-length': String(300 * 1024),
            },
          })
    ));
    const adapter = new OpenAiRealtimeCallAdapter(SETTINGS, fetchMock);

    await expect(adapter.createCall(callInput())).rejects.toThrow('provider_response_too_large');
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.openai.test/v1/realtime/calls/rtc_12345678/hangup',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('raccroche immédiatement un appel créé dont le SDP est invalide', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => (
      String(url).endsWith('/hangup')
        ? new Response(null, { status: 204 })
        : new Response('not-an-sdp', {
            status: 200,
            headers: { location: '/v1/realtime/calls/rtc_invalid_answer' },
          })
    ));
    const adapter = new OpenAiRealtimeCallAdapter(SETTINGS, fetchMock);

    await expect(adapter.createCall(callInput())).rejects.toThrow('provider_invalid_sdp');

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.openai.test/v1/realtime/calls/rtc_invalid_answer/hangup',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('compense une panne de lecture du body sans exposer son erreur brute', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => (
      String(url).endsWith('/hangup')
        ? new Response(null, { status: 204 })
        : providerResponse('rtc_body_read_failure', () => {
            throw new Error(`stream failed with ${SETTINGS.apiKey}`);
          })
    ));
    const adapter = new OpenAiRealtimeCallAdapter(SETTINGS, fetchMock);

    let caught: unknown;
    try {
      await adapter.createCall(callInput());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RealtimeProviderCallCompensatedError);
    expect(caught).toMatchObject({ message: 'provider_response_read_error' });
    expect(JSON.stringify(caught)).not.toContain(SETTINGS.apiKey);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('signale sans secret un possible orphelin si le hangup compensatoire échoue', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => (
      String(url).endsWith('/hangup')
        ? new Response(null, { status: 400 })
        : new Response('not-an-sdp', {
            status: 200,
            headers: { location: '/v1/realtime/calls/rtc_cleanup_failure' },
          })
    ));
    const adapter = new OpenAiRealtimeCallAdapter(SETTINGS, fetchMock);

    let caught: unknown;
    try {
      await adapter.createCall(callInput());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RealtimeProviderCleanupError);
    expect(caught).toMatchObject({
      message: 'provider_invalid_sdp',
      sourceErrorClass: 'provider_invalid_sdp',
      cleanupErrorClass: 'provider_hangup_http_4xx',
    });
    expect(JSON.stringify(caught)).not.toContain('rtc_cleanup_failure');
    expect(JSON.stringify(caught)).not.toContain(SETTINGS.apiKey);
  });

  it('normalise les pannes réseau sans exposer leur message', async () => {
    const adapter = new OpenAiRealtimeCallAdapter(SETTINGS, async () => {
      throw new Error('socket failed with server-key-never-returned');
    });

    await expect(adapter.createCall(callInput())).rejects.toThrow('provider_network_error');
  });

  it('attend le bind durable avant de commencer à consommer le SDP', async () => {
    const order: string[] = [];
    const fetchMock = vi.fn(async () => providerResponse('rtc_durable_first', () => order.push('body')));
    const adapter = new OpenAiRealtimeCallAdapter(SETTINGS, fetchMock);

    await adapter.createCall(callInput({
      onCallCreated: async () => {
        order.push('bind');
      },
    }));

    expect(order).toEqual(['bind', 'body']);
  });

  it('raccroche exactement une fois si le bind durable échoue avant lecture du SDP', async () => {
    const bodyRead = vi.fn();
    const fetchMock = vi.fn(async (url: string | URL | Request) => (
      String(url).endsWith('/hangup')
        ? new Response(null, { status: 204 })
        : providerResponse('rtc_bind_failed_early', bodyRead)
    ));
    const adapter = new OpenAiRealtimeCallAdapter(SETTINGS, fetchMock);

    await expect(adapter.createCall(callInput({
      onCallCreated: async () => {
        throw new Error('realtime_admission_bind_unavailable');
      },
    }))).rejects.toMatchObject({
      message: 'realtime_admission_bind_unavailable',
      providerTermination: 'confirmed',
    });

    expect(bodyRead).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.openai.test/v1/realtime/calls/rtc_bind_failed_early/hangup',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('normalise une panne arbitraire du callback sans en divulguer le contenu', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => (
      String(url).endsWith('/hangup')
        ? new Response(null, { status: 204 })
        : new Response(ANSWER_SDP, {
            status: 200,
            headers: { location: '/v1/realtime/calls/rtc_callback_failure' },
          })
    ));
    const adapter = new OpenAiRealtimeCallAdapter(SETTINGS, fetchMock);

    let caught: unknown;
    try {
      await adapter.createCall(callInput({
        onCallCreated: async () => {
          throw new Error(`database failure ${SETTINGS.apiKey}`);
        },
      }));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RealtimeProviderCallCompensatedError);
    expect(caught).toMatchObject({ message: 'provider_create_callback_failed' });
    expect(JSON.stringify(caught)).not.toContain(SETTINGS.apiKey);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('compense une annulation survenue après Location et avant le corps SDP', async () => {
    const controller = new AbortController();
    const bodyRead = vi.fn();
    const fetchMock = vi.fn(async (url: string | URL | Request) => (
      String(url).endsWith('/hangup')
        ? new Response(null, { status: 204 })
        : providerResponse('rtc_abort_after_location', bodyRead)
    ));
    const adapter = new OpenAiRealtimeCallAdapter(SETTINGS, fetchMock);

    await expect(adapter.createCall(callInput({
      signal: controller.signal,
      onCallCreated: async () => {
        controller.abort();
      },
    }))).rejects.toMatchObject({ message: 'bootstrap_aborted', providerTermination: 'confirmed' });

    expect(bodyRead).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.openai.test/v1/realtime/calls/rtc_abort_after_location/hangup',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('termine un appel WebRTC côté fournisseur sans lire ni exposer sa réponse', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    const adapter = new OpenAiRealtimeCallAdapter(SETTINGS, fetchMock);

    await adapter.hangupCall('rtc_123456');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.test/v1/realtime/calls/rtc_123456/hangup',
      expect.objectContaining({
        method: 'POST',
        headers: { authorization: 'Bearer server-key-never-returned' },
      }),
    );
  });

  it.each([404, 409])('préserve le terminal historique HTTP %i du rail déjà publié', async (status) => {
    const fetchMock = vi.fn(async () => new Response(null, { status }));
    const adapter = new OpenAiRealtimeCallAdapter(SETTINGS, fetchMock);

    await expect(adapter.hangupCall('rtc_already_closed')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([202, 204, 404, 409])(
    'refuse le statut HTTP %i comme preuve terminale d’une compensation native',
    async (status) => {
      const fetchMock = vi.fn(async (url: string | URL | Request) => (
        String(url).endsWith('/hangup')
          ? new Response(null, { status })
          : new Response(ANSWER_SDP, {
              status: 200,
              headers: { location: '/v1/realtime/calls/rtc_native_terminal_strict' },
            })
      ));
      const adapter = new OpenAiRealtimeCallAdapter(SETTINGS, fetchMock);

      await expect(adapter.createCall(callInput({
        session: buildOpenAiNativeRealtimeSessionConfig(SETTINGS),
      }))).rejects.toMatchObject({
        message: 'provider_invalid_sdp',
        providerTermination: 'unconfirmed',
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it('coalesce les hangups concurrents du même appel dans un seul vol borné', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn(async () => {
      await gate;
      return new Response(null, { status: 204 });
    });
    const adapter = new OpenAiRealtimeCallAdapter(SETTINGS, fetchMock);

    const first = adapter.hangupCall('rtc_single_flight');
    const second = adapter.hangupCall('rtc_single_flight');
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledOnce();

    release?.();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
  });

  it('refuse tout call_id injecté avant le hangup', async () => {
    const fetchMock = vi.fn();
    const adapter = new OpenAiRealtimeCallAdapter(SETTINGS, fetchMock);

    await expect(adapter.hangupCall('../tenant-2')).rejects.toThrow('provider_call_id_invalid');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
