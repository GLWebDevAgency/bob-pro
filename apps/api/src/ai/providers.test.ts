import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildSttCloud,
  buildTtsCloud,
  buildRealtimeSpeechAuditStt,
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
      voice_id: 'voice-1',
    });
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
    process.env.MISTRAL_API_KEY = 'mistral-key';
    delete process.env.OPENAI_API_KEY;
    delete process.env.STT_PROVIDER;
    expect(buildSttCloud()?.id).toBe('mistral-voxtral-stt');

    process.env.STT_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'openai-key';
    expect(buildSttCloud()?.id).toBe('whisper');
  });

  it('active le TTS cloud uniquement avec une clé Mistral', () => {
    delete process.env.MISTRAL_API_KEY;
    expect(buildTtsCloud()).toBeUndefined();

    process.env.MISTRAL_API_KEY = 'mistral-key';
    expect(buildTtsCloud()?.id).toBe('mistral-voxtral-tts');
  });

  it('force un ASR OpenAI indépendant du TTS pour l’audit acoustique Bob Live', () => {
    process.env.MISTRAL_API_KEY = 'mistral-key';
    delete process.env.OPENAI_API_KEY;
    expect(buildRealtimeSpeechAuditStt()).toBeUndefined();

    process.env.OPENAI_API_KEY = 'openai-key';
    process.env.REALTIME_SPEECH_AUDIT_STT_MODEL = 'gpt-4o-transcribe-test';
    expect(buildRealtimeSpeechAuditStt()?.id).toBe('whisper');
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
