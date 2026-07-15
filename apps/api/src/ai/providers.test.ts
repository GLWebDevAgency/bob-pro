import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildSttCloud,
  buildTtsCloud,
  buildRealtimeSpeechAuditStt,
  buildRealtimeSpeechTts,
  LocalWhisperAuditSttAdapter,
  OpenAiRealtimeSpeechTtsAdapter,
  MistralVoxtralSttAdapter,
  MistralVoxtralTtsAdapter,
  OpenAiCompatibleLlmAdapter,
} from './providers';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Mistral Voxtral providers', () => {
  it('transcrit via audio/transcriptions avec langue fr et context bias', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ text: ' Bonjour Bob ' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new MistralVoxtralSttAdapter('mistral-key', 'voxtral-test', 'https://api.test/v1', 'Durand,F-2026-001');

    const r = await adapter.transcribe(Buffer.from([1, 2, 3]).toString('base64'), 'audio/webm');

    expect(r).toEqual({ text: 'Bonjour Bob', model: 'voxtral-test' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.test/v1/audio/transcriptions',
      expect.objectContaining({ method: 'POST' }),
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer mistral-key');
    const body = init.body as FormData;
    expect(body.get('model')).toBe('voxtral-test');
    expect(body.get('language')).toBe('fr');
    expect(body.get('context_bias')).toBe('Durand,F-2026-001');
  });

  it('synthétise via audio/speech et retourne audio_data base64', async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ audio_data: 'YWJj' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new MistralVoxtralTtsAdapter('mistral-key', 'voxtral-tts-test', 'https://api.test/v1', 'voice-1');

    const r = await adapter.synthesize('Bonjour.');

    expect(r).toEqual({ audioBase64: 'YWJj', mimeType: 'audio/mp3', model: 'voxtral-tts-test' });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'voxtral-tts-test',
      input: 'Bonjour.',
      response_format: 'mp3',
      stream: false,
      voice_id: 'voice-1',
    });
  });

  it('assemble strictement la sortie WAV streamée dédiée à Bob Live', async () => {
    process.env.BOB_LIVE_PROVIDER = 'mistral';
    process.env.MISTRAL_API_KEY = 'mistral-key';
    process.env.OPENAI_API_KEY = 'openai-key-that-must-not-be-used';
    process.env.MISTRAL_URL = 'https://proxy-non-qualifie.example/v1';
    const wav = Buffer.alloc(512);
    wav.write('RIFF', 0, 'ascii');
    wav.write('WAVE', 8, 'ascii');
    const first = wav.subarray(0, 256).toString('base64');
    const second = wav.subarray(256).toString('base64');
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`event: speech.audio.delta\ndata: {"type":"speech.audio.delta","audio_data":"${first}"}\n\n`));
        controller.enqueue(encoder.encode(`event: speech.audio.delta\ndata: {"type":"speech.audio.delta","audio_data":"${second}"}\n\n`));
        controller.enqueue(encoder.encode(
          'event: speech.audio.done\ndata: {"type":"speech.audio.done","usage":{"prompt_tokens":0,"total_tokens":1}}\n\n',
        ));
        controller.close();
      },
    });
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const tts = buildRealtimeSpeechTts();

    await expect(tts?.synthesize('Bonjour Bob.')).resolves.toEqual({
      audioBase64: wav.toString('base64'),
      mimeType: 'audio/wav',
      model: 'voxtral-mini-tts-2603',
    });
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body).toMatchObject({ response_format: 'wav', stream: true });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.mistral.ai/v1/audio/speech');
    expect(((fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>).authorization)
      .toBe('Bearer mistral-key');
  });

  it('sélectionne un profil Bob Live pur, sans fallback vers la clé de l’autre fournisseur', () => {
    process.env.OPENAI_API_KEY = 'openai-key';
    process.env.MISTRAL_API_KEY = 'mistral-key';

    process.env.BOB_LIVE_PROVIDER = 'openai';
    expect(buildRealtimeSpeechTts()?.id).toBe('openai-realtime-tts');
    delete process.env.OPENAI_API_KEY;
    expect(buildRealtimeSpeechTts()).toBeUndefined();

    process.env.OPENAI_API_KEY = 'openai-key';
    process.env.BOB_LIVE_PROVIDER = 'mistral';
    expect(buildRealtimeSpeechTts()?.id).toBe('mistral-voxtral-tts');
    delete process.env.MISTRAL_API_KEY;
    expect(buildRealtimeSpeechTts()).toBeUndefined();
  });

  it('synthétise le profil OpenAI sur l’endpoint officiel avec son modèle snapshot et sa voix', async () => {
    process.env.BOB_LIVE_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'openai-key';
    process.env.MISTRAL_API_KEY = 'mistral-key-that-must-not-be-used';
    process.env.OPENAI_URL = 'https://proxy-non-qualifie.example/v1';
    process.env.OPENAI_REALTIME_VOICE = 'cedar';
    delete process.env.OPENAI_TTS_MODEL;
    const wav = Buffer.alloc(512);
    wav.write('RIFF', 0, 'ascii');
    wav.write('WAVE', 8, 'ascii');
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(wav, {
      status: 200,
      headers: { 'content-type': 'audio/wav' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const tts = buildRealtimeSpeechTts();

    await expect(tts?.synthesize('Bonjour Bob.')).resolves.toEqual({
      audioBase64: wav.toString('base64'),
      mimeType: 'audio/wav',
      model: 'gpt-4o-mini-tts-2025-12-15',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/audio/speech',
      expect.objectContaining({ method: 'POST' }),
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer openai-key');
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'gpt-4o-mini-tts-2025-12-15',
      input: 'Bonjour Bob.',
      voice: 'cedar',
      response_format: 'wav',
      instructions: [
        'Parle en français de France avec une voix naturelle, chaleureuse et professionnelle,',
        'à un débit conversationnel. Articule clairement les montants, dates et références.',
        'Lis exactement le texte fourni sans rien ajouter ni omettre.',
      ].join(' '),
    });
  });

  it('honore le modèle OpenAI configuré et borne/refuse toute réponse non-WAV', async () => {
    process.env.BOB_LIVE_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'openai-key';
    process.env.OPENAI_TTS_MODEL = 'gpt-4o-mini-tts-custom-snapshot';
    const adapter = buildRealtimeSpeechTts();
    const fetchMock = vi.fn(async () => new Response(new Uint8Array(1), {
      status: 200,
      headers: {
        'content-type': 'audio/wav',
        'content-length': String(4 * 1024 * 1024 + 1),
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(adapter?.synthesize('Bonjour.')).rejects.toThrow('voice_provider_response_too_large');

    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));
    await expect(adapter?.synthesize('Bonjour.')).rejects.toThrow('voice_provider_invalid_audio');
  });

  it('propage l’annulation du tour au TTS OpenAI qualifié', async () => {
    const adapter = new OpenAiRealtimeSpeechTtsAdapter('openai-key');
    const abort = new AbortController();
    let providerSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      providerSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        providerSignal?.addEventListener('abort', () => reject(providerSignal?.reason), { once: true });
      });
    }));

    const running = adapter.synthesize('Bonjour.', { signal: abort.signal });
    await vi.waitFor(() => expect(providerSignal).toBeInstanceOf(AbortSignal));
    abort.abort();

    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(providerSignal?.aborted).toBe(true);
  });

  it('rejette un flux TTS inconnu ou incomplet', async () => {
    const adapter = new MistralVoxtralTtsAdapter(
      'mistral-key',
      'tts',
      'https://api.test/v1',
      undefined,
      'wav',
      true,
    );
    const response = (events: string) => new Response(events, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
    vi.stubGlobal('fetch', vi.fn(async () => response(
      'event: future.audio\ndata: {"type":"future.audio"}\n\n',
    )));
    await expect(adapter.synthesize('Bonjour.')).rejects.toThrow('voice_provider_invalid_stream');

    vi.stubGlobal('fetch', vi.fn(async () => response(
      `event: speech.audio.delta\ndata: {"type":"speech.audio.delta","audio_data":"${Buffer.from([1]).toString('base64')}"}\n\n`,
    )));
    await expect(adapter.synthesize('Bonjour.')).rejects.toThrow('voice_provider_invalid_stream');
  });

  it('interrompt physiquement un flux TTS qui dépasse le budget audio agrégé', async () => {
    const adapter = new MistralVoxtralTtsAdapter(
      'mistral-key',
      'tts',
      'https://api.test/v1',
      undefined,
      'wav',
      true,
    );
    const encoder = new TextEncoder();
    let cancelled = false;
    const audioData = Buffer.alloc(256 * 1024).toString('base64');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 17; index += 1) {
          controller.enqueue(encoder.encode(
            `event: speech.audio.delta\ndata: {"type":"speech.audio.delta","audio_data":"${audioData}"}\n\n`,
          ));
        }
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })));

    await expect(adapter.synthesize('Bonjour.')).rejects.toThrow('voice_provider_response_too_large');
    expect(cancelled).toBe(true);
  });

  it('propage l’annulation du tour au TTS et au STT au lieu de laisser vivre les fetchs', async () => {
    const seenSignals: AbortSignal[] = [];
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal;
      if (!(signal instanceof AbortSignal)) throw new Error('signal required');
      seenSignals.push(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const tts = new MistralVoxtralTtsAdapter('mistral-key', 'tts', 'https://api.test/v1');
    const stt = new MistralVoxtralSttAdapter('mistral-key', 'stt', 'https://api.test/v1');
    const ttsAbort = new AbortController();
    const sttAbort = new AbortController();

    const ttsRun = tts.synthesize('Bonjour.', { signal: ttsAbort.signal });
    const sttRun = stt.transcribe(Buffer.from([1]).toString('base64'), 'audio/wav', {
      signal: sttAbort.signal,
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    ttsAbort.abort();
    sttAbort.abort();

    await expect(ttsRun).rejects.toMatchObject({ name: 'AbortError' });
    await expect(sttRun).rejects.toMatchObject({ name: 'AbortError' });
    expect(seenSignals).toHaveLength(2);
    expect(seenSignals.every((signal) => signal.aborted)).toBe(true);
  });

  it('sélectionne Mistral STT en priorité puis fallback OpenAI si demandé', () => {
    delete process.env.BOB_LIVE_ENABLED;
    delete process.env.OPENAI_REALTIME_ENABLED;
    process.env.MISTRAL_API_KEY = 'mistral-key';
    delete process.env.OPENAI_API_KEY;
    delete process.env.STT_PROVIDER;
    expect(buildSttCloud()?.id).toBe('mistral-voxtral-stt');

    process.env.STT_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'openai-key';
    expect(buildSttCloud()?.id).toBe('whisper');
  });

  it('active le TTS cloud uniquement avec une clé Mistral', () => {
    delete process.env.BOB_LIVE_ENABLED;
    delete process.env.OPENAI_REALTIME_ENABLED;
    delete process.env.MISTRAL_API_KEY;
    expect(buildTtsCloud()).toBeUndefined();

    process.env.MISTRAL_API_KEY = 'mistral-key';
    expect(buildTtsCloud()?.id).toBe('mistral-voxtral-tts');
  });

  it.each([
    ['openai', 'https://api.openai.com/v1/audio/transcriptions', 'whisper', 'openai-realtime-tts'],
    ['mistral', 'https://api.mistral.ai/v1/audio/transcriptions', 'mistral-voxtral-stt', 'mistral-voxtral-tts'],
  ] as const)(
    'aligne aussi les routes vocales historiques sur le profil %s sans egress concurrent',
    async (provider, expectedSttUrl, expectedSttId, expectedTtsId) => {
      process.env.BOB_LIVE_ENABLED = 'true';
      process.env.BOB_LIVE_PROVIDER = provider;
      process.env.OPENAI_API_KEY = 'openai-key';
      process.env.MISTRAL_API_KEY = 'mistral-key';
      process.env.OPENAI_URL = 'https://wrong-openai-proxy.example/v1';
      process.env.MISTRAL_URL = 'https://wrong-mistral-proxy.example/v1';
      const fetchMock = vi.fn(
        async (_url: string | URL | Request, _init?: RequestInit) => new Response(
          JSON.stringify({ text: 'Bonjour.' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
      vi.stubGlobal('fetch', fetchMock);

      const stt = buildSttCloud();
      expect(stt?.id).toBe(expectedSttId);
      expect(buildTtsCloud()?.id).toBe(expectedTtsId);
      await stt?.transcribe(Buffer.from([1, 2, 3]).toString('base64'), 'audio/wav');

      expect(fetchMock.mock.calls[0]?.[0]).toBe(expectedSttUrl);
      const authorization = ((fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>)
        .authorization;
      expect(authorization).toBe(`Bearer ${provider}-key`);
    },
  );

  it('force un ASR indépendant du TTS pour l’audit acoustique Bob Live', () => {
    process.env.MISTRAL_API_KEY = 'mistral-key';
    delete process.env.BOB_LIVE_AUDIT_PROVIDER;
    process.env.OPENAI_API_KEY = 'openai-key-that-must-not-be-used-by-default';
    expect(buildRealtimeSpeechAuditStt()).toBeUndefined();

    process.env.BOB_LIVE_LOCAL_AUDIT_BASE_URL = 'http://127.0.0.1:8080/v1';
    process.env.BOB_LIVE_LOCAL_AUDIT_TOKEN = 'a'.repeat(32);
    expect(buildRealtimeSpeechAuditStt()?.id).toBe('local-whisper');

    process.env.BOB_LIVE_AUDIT_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'openai-key';
    process.env.REALTIME_SPEECH_AUDIT_STT_MODEL = 'gpt-4o-transcribe-test';
    expect(buildRealtimeSpeechAuditStt()?.id).toBe('openai-realtime-audit-whisper');

    process.env.BOB_LIVE_AUDIT_PROVIDER = 'local-whisper';
    process.env.BOB_LIVE_LOCAL_AUDIT_BASE_URL = 'http://127.0.0.1:8080/v1';
    process.env.BOB_LIVE_LOCAL_AUDIT_TOKEN = 'a'.repeat(32);
    delete process.env.OPENAI_API_KEY;
    expect(buildRealtimeSpeechAuditStt()?.id).toBe('local-whisper');
  });

  it('épingle l’audit OpenAI qualifié sur le domaine officiel malgré un endpoint générique redirigé', async () => {
    process.env.BOB_LIVE_AUDIT_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'openai-key';
    process.env.OPENAI_URL = 'https://proxy-non-qualifie.example/v1';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ text: 'Bonjour.' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = buildRealtimeSpeechAuditStt();

    await adapter?.transcribe(Buffer.from([1]).toString('base64'), 'audio/wav');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/audio/transcriptions',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('audite avec Whisper local sans clé OpenAI et avec un contrat réseau strict', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ text: ' Bonjour Bob. ' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new LocalWhisperAuditSttAdapter(
      'audit-token-that-is-at-least-32-bytes',
      'http://localhost:8080/v1',
      'whisper-local-test',
    );
    const audio = Buffer.from([0x52, 0x49, 0x46, 0x46]).toString('base64');

    await expect(adapter.transcribe(audio, 'audio/wav')).resolves.toEqual({
      text: 'Bonjour Bob.',
      model: 'whisper-local-test',
    });
    expect(adapter.auditTrustDomain).toBe('bob.local-whisper');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8080/v1/audio/transcriptions',
      expect.objectContaining({
        method: 'POST',
        headers: { authorization: 'Bearer audit-token-that-is-at-least-32-bytes' },
      }),
    );
  });

  it('ferme l’auditeur local sur configuration, audio ou réponse non conformes', async () => {
    expect(() => new LocalWhisperAuditSttAdapter('short', 'https://localhost:8080/v1')).toThrow(
      'local_whisper_invalid_config',
    );
    expect(() => new LocalWhisperAuditSttAdapter('a'.repeat(32), 'http://audit.example/v1')).toThrow(
      'local_whisper_invalid_config',
    );
    expect(() => new LocalWhisperAuditSttAdapter('a'.repeat(32), 'https://audit.example/v1')).toThrow(
      'local_whisper_invalid_config',
    );
    const adapter = new LocalWhisperAuditSttAdapter('a'.repeat(32), 'https://localhost:8080/v1');
    await expect(adapter.transcribe('!!!!', 'audio/wav')).rejects.toThrow('voice_provider_invalid_audio');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ transcript: 'non' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));
    await expect(adapter.transcribe(Buffer.from([1]).toString('base64'), 'audio/wav'))
      .rejects.toThrow('local_whisper_invalid_response');
  });

  it('annule physiquement un audit Whisper local et refuse une réponse au mauvais MIME', async () => {
    const adapter = new LocalWhisperAuditSttAdapter('a'.repeat(32), 'https://localhost:8080/v1');
    const abort = new AbortController();
    let providerSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      providerSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        providerSignal?.addEventListener('abort', () => reject(providerSignal?.reason), { once: true });
      });
    }));
    const running = adapter.transcribe(Buffer.from([1]).toString('base64'), 'audio/wav', {
      signal: abort.signal,
    });
    await vi.waitFor(() => expect(providerSignal).toBeInstanceOf(AbortSignal));
    abort.abort();
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(providerSignal?.aborted).toBe(true);

    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"text":"Bonjour"}', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    })));
    await expect(adapter.transcribe(Buffer.from([1]).toString('base64'), 'audio/wav'))
      .rejects.toThrow('local_whisper_invalid_response');
  });

  it('borne le flux audio TTS avant de l’accumuler en mémoire', async () => {
    const adapter = new MistralVoxtralTtsAdapter('mistral-key', 'tts', 'https://api.test/v1');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(1), {
      status: 200,
      headers: {
        'content-type': 'audio/mpeg',
        'content-length': String(4 * 1024 * 1024 + 1),
      },
    })));

    await expect(adapter.synthesize('Bonjour.')).rejects.toThrow('voice_provider_response_too_large');
  });
});

describe('LLM provider cancellation', () => {
  it('interrompt physiquement le fetch fournisseur avec le signal du tour', async () => {
    let providerSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      providerSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        providerSignal?.addEventListener('abort', () => reject(providerSignal?.reason), { once: true });
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new OpenAiCompatibleLlmAdapter({
      id: 'openai-test',
      baseUrl: 'https://api.test/v1',
      apiKey: 'secret',
      model: 'test-model',
    });
    const controller = new AbortController();

    const running = adapter.complete([{ role: 'user', content: 'Bonjour' }], { signal: controller.signal });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort();

    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(providerSignal?.aborted).toBe(true);
  });
});
