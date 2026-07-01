import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSttCloud, buildTtsCloud, MistralVoxtralSttAdapter, MistralVoxtralTtsAdapter } from './providers';

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
});
