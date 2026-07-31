import { planRealtimeSemanticTurn } from '@bob/ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildLlmForProvider,
  buildSttCloud,
  buildTtsCloud,
  buildRealtimeSpeechAuditStt,
  buildRealtimeSpeechTts,
  DEFAULT_OPENAI_CHAT_MODEL,
  LocalWhisperAuditSttAdapter,
  OpenAiRealtimeSpeechTtsAdapter,
  MistralVoxtralSttAdapter,
  MistralVoxtralTtsAdapter,
  OpenAiCompatibleLlmAdapter,
  resolveOpenAiChatModel,
} from './providers';
import { LOCAL_WHISPER_AUDIT_CONTRACT } from './local-whisper-audit-contract';
import {
  classifyLlmProviderHttpFailure,
  LlmProviderHttpError,
  LlmStrictSchemaError,
} from './provider-failure';

const ORIGINAL_ENV = { ...process.env };

function openAiWave(dataByteLength = 468, streamingLengths = false): Buffer {
  const bytes = Buffer.alloc(44 + dataByteLength);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(streamingLengths ? 0xffff_ffff : bytes.byteLength - 8, 4);
  bytes.write('WAVEfmt ', 8, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(24_000, 24);
  bytes.writeUInt32LE(48_000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(streamingLengths ? 0xffff_ffff : dataByteLength, 40);
  for (let index = 44; index < bytes.byteLength; index += 1) {
    bytes[index] = (index - 44) % 251;
  }
  return bytes;
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('OpenAI chat model runtime contract', () => {
  it('résout le défaut versionné quand Railway ne pose aucun override', () => {
    delete process.env.OPENAI_MODEL;
    expect(resolveOpenAiChatModel()).toBe(DEFAULT_OPENAI_CHAT_MODEL);
  });

  it('conserve un snapshot explicite valide sans le normaliser', () => {
    expect(resolveOpenAiChatModel('gpt-4o-mini-2026-07-18')).toBe(
      'gpt-4o-mini-2026-07-18',
    );
  });

  it.each(['', ' ', ' gpt-4o-mini', 'gpt-4o-mini ', 'gpt/model'])(
    'refuse fermement un override ambigu %j',
    (configured) => {
      expect(() => resolveOpenAiChatModel(configured)).toThrow(
        /OPENAI_MODEL doit être un identifiant de modèle valide/u,
      );
    },
  );

  it('branche le modèle résolu dans la requête réelle de l’adapter', async () => {
    process.env.OPENAI_API_KEY = 'openai-test-key';
    delete process.env.OPENAI_MODEL;
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
          model: DEFAULT_OPENAI_CHAT_MODEL,
          choices: [{ message: { content: 'ok', tool_calls: [] } }],
          }),
          {
          status: 200,
          headers: { 'content-type': 'application/json' },
          },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const llm = buildLlmForProvider('openai');
    await expect(llm?.complete([{ role: 'user', content: 'Bonjour' }])).resolves.toMatchObject({
      model: DEFAULT_OPENAI_CHAT_MODEL,
    });

    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string) as {
      readonly model?: unknown;
    };
    expect(body.model).toBe(DEFAULT_OPENAI_CHAT_MODEL);
  });

  it('distingue le modèle produit du modèle réellement attesté par le fournisseur', async () => {
    process.env.OPENAI_API_KEY = 'openai-test-key';
    process.env.OPENAI_MODEL = 'gpt-test';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: 'ok', tool_calls: [] } }],
            }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          ),
      ),
    );

    await expect(
      buildLlmForProvider('openai')?.complete([{ role: 'user', content: 'Bonjour' }]),
    ).resolves.toMatchObject({
      model: 'gpt-test',
      providerReportedModel: null,
    });
  });

  it('émet les contrôles stricts uniquement sur l’adapter OpenAI natif qualifié', async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            model: 'gpt-test',
            choices: [{ message: { content: null, tool_calls: [] } }],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    process.env.OPENAI_API_KEY = 'openai-test-key';
    process.env.OPENAI_MODEL = 'gpt-test';
    const tool = {
      name: 'mission_test',
      description: 'Test',
      schemaAdherence: 'strict' as const,
      parameters: {
        type: 'object',
        properties: { value: { type: ['string', 'null'] } },
        required: ['value'],
        additionalProperties: false,
      },
    };

    await buildLlmForProvider('openai')?.complete([{ role: 'user', content: 'Bonjour' }], {
      tools: [tool],
      toolChoice: 'auto',
      toolCallConcurrency: 'single',
    });
    const openAiBody = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string) as {
      readonly parallel_tool_calls?: unknown;
      readonly tools?: Array<{ readonly function?: Record<string, unknown> }>;
    };
    expect(openAiBody.parallel_tool_calls).toBe(false);
    expect(openAiBody.tools?.[0]?.function?.strict).toBe(true);

    fetchMock.mockClear();
    await new OpenAiCompatibleLlmAdapter({
      id: 'mistral-compatible-test',
      baseUrl: 'https://mistral-compatible.test/v1',
      apiKey: 'mistral-key',
      model: 'mistral-test',
    }).complete([{ role: 'user', content: 'Bonjour' }], {
      tools: [tool],
      toolChoice: 'auto',
      toolCallConcurrency: 'single',
    });
    const compatibleBody = JSON.parse(
      (fetchMock.mock.calls[0]?.[1] as RequestInit).body as string,
    ) as {
      readonly parallel_tool_calls?: unknown;
      readonly tools?: Array<{ readonly function?: Record<string, unknown> }>;
    };
    expect(compatibleBody).not.toHaveProperty('parallel_tool_calls');
    expect(compatibleBody.tools?.[0]?.function).not.toHaveProperty('strict');

    fetchMock.mockClear();
    process.env.OPENAI_URL = 'https://proxy-openai-compatible.test/v1';
    await buildLlmForProvider('openai')?.complete([{ role: 'user', content: 'Bonjour' }], {
      tools: [tool],
      toolChoice: 'auto',
      toolCallConcurrency: 'single',
    });
    const proxiedOpenAiBody = JSON.parse(
      (fetchMock.mock.calls[0]?.[1] as RequestInit).body as string,
    ) as {
      readonly parallel_tool_calls?: unknown;
      readonly tools?: Array<{ readonly function?: Record<string, unknown> }>;
    };
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://proxy-openai-compatible.test/v1/chat/completions',
    );
    expect(proxiedOpenAiBody).not.toHaveProperty('parallel_tool_calls');
    expect(proxiedOpenAiBody.tools?.[0]?.function).not.toHaveProperty('strict');
  });

  it('refuse localement un schéma OpenAI strict invalide avant tout appel réseau', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new OpenAiCompatibleLlmAdapter({
      id: 'openai-strict-test',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'openai-key',
      model: 'gpt-test',
      nativeOpenAiToolControls: true,
    });

    await expect(
      adapter.complete([{ role: 'user', content: 'Bonjour' }], {
        tools: [{
          name: 'mission_invalide',
          description: 'Test',
          schemaAdherence: 'strict',
          parameters: {
            type: 'object',
            properties: {
              kind: { const: 'sans_type' },
            },
            required: ['kind'],
            additionalProperties: false,
          },
        }],
      }),
    ).rejects.toBeInstanceOf(LlmStrictSchemaError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      'root anyOf',
      {
        anyOf: [
          {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
            additionalProperties: false,
          },
        ],
      },
    ],
    ['root non objet', { type: 'string' }],
    [
      'composition allOf',
      {
        type: 'object',
        properties: {
          value: {
            allOf: [{ type: 'string' }],
          },
        },
        required: ['value'],
        additionalProperties: false,
      },
    ],
    [
      'condition if/then',
      {
        type: 'object',
        properties: {
          value: {
            type: 'string',
            if: { const: 'a', type: 'string' },
            then: { const: 'b', type: 'string' },
          },
        },
        required: ['value'],
        additionalProperties: false,
      },
    ],
    [
      'profondeur 11',
      Array.from({ length: 11 }).reduce<Record<string, unknown>>(
        (nested) => ({
          type: 'object',
          properties: { value: nested },
          required: ['value'],
          additionalProperties: false,
        }),
        { type: 'string' },
      ),
    ],
  ])('refuse le schéma strict OpenAI hors contrat : %s', async (_label, parameters) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new OpenAiCompatibleLlmAdapter({
      id: 'openai-strict-contract-test',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'openai-key',
      model: 'gpt-test',
      nativeOpenAiToolControls: true,
    });

    await expect(adapter.complete([{ role: 'user', content: 'Bonjour' }], {
      tools: [{
        name: 'mission_invalide',
        description: 'Test',
        schemaAdherence: 'strict',
        parameters,
      }],
    })).rejects.toBeInstanceOf(LlmStrictSchemaError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepte un const entier déclaré number dans un schéma strict valide', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      model: 'gpt-test',
      choices: [{ message: { content: null, tool_calls: [] } }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new OpenAiCompatibleLlmAdapter({
      id: 'openai-strict-number-test',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'openai-key',
      model: 'gpt-test',
      nativeOpenAiToolControls: true,
    });

    await expect(adapter.complete([{ role: 'user', content: 'Bonjour' }], {
      tools: [{
        name: 'mission_valide',
        description: 'Test',
        schemaAdherence: 'strict',
        parameters: {
          type: 'object',
          properties: { version: { type: 'number', const: 1 } },
          required: ['version'],
          additionalProperties: false,
        },
      }],
    })).resolves.toBeDefined();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    [401, 'invalid_function_parameters', 'authentication_failed'],
    [403, 'invalid_function_parameters', 'permission_denied'],
    [429, 'invalid_function_parameters', 'rate_limited'],
    [500, 'invalid_function_parameters', 'provider_unavailable'],
    [400, 'invalid_function_parameters', 'invalid_function_parameters'],
  ] as const)(
    'priorise le statut HTTP %s sur le code fournisseur incohérent',
    (status, code, expected) => {
      expect(classifyLlmProviderHttpFailure(status, { error: { code } })).toBe(expected);
    },
  );

  it('borne une erreur HTTP OpenAI à une catégorie fermée sans conserver le corps', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({
        error: {
          type: 'invalid_request_error',
          code: 'invalid_function_parameters',
          param: 'tools[0].function.parameters',
          message: 'transcript et secret fournisseur à ne jamais propager',
        },
      }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })),
    );
    const adapter = new OpenAiCompatibleLlmAdapter({
      id: 'openai-error-test',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'openai-key',
      model: 'gpt-test',
    });

    const failure = await adapter.complete([{ role: 'user', content: 'Bonjour' }])
      .then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(LlmProviderHttpError);
    expect(failure).toMatchObject({
      status: 400,
      category: 'invalid_function_parameters',
      message: 'llm_provider_invalid_function_parameters',
    });
    expect(JSON.stringify(failure)).not.toContain('transcript');
    expect(JSON.stringify(failure)).not.toContain('secret fournisseur');
    expect(JSON.stringify(failure)).not.toContain('tools[0]');
  });

  it('ignore un corps d’erreur fournisseur surdimensionné et conserve seulement le statut', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({
        error: {
          code: 'invalid_function_parameters',
          message: `donnée-non-publiable-${'x'.repeat(20 * 1024)}`,
        },
      }), { status: 400 })),
    );
    const adapter = new OpenAiCompatibleLlmAdapter({
      id: 'openai-oversized-error-test',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'openai-key',
      model: 'gpt-test',
    });

    const failure = await adapter.complete([{ role: 'user', content: 'Bonjour' }])
      .then(() => null, (error: unknown) => error);

    expect(failure).toMatchObject({
      status: 400,
      category: 'provider_http_error',
      message: 'llm_provider_http_error',
    });
    expect(JSON.stringify(failure)).not.toContain('donnée-non-publiable');
  });

  it('conserve la catégorie bornée sur un adapter OpenAI-compatible tiers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({
        error: { message: 'secret tiers non publiable' },
      }), { status: 503 })),
    );
    const adapter = new OpenAiCompatibleLlmAdapter({
      id: 'proxy-compatible-test',
      baseUrl: 'https://proxy-compatible.test/v1',
      apiKey: 'proxy-key',
      model: 'proxy-model',
    });

    const failure = await adapter.complete([{ role: 'user', content: 'Bonjour' }])
      .then(() => null, (error: unknown) => error);

    expect(failure).toMatchObject({
      status: 503,
      category: 'provider_unavailable',
      message: 'llm_provider_unavailable',
    });
    expect(JSON.stringify(failure)).not.toContain('secret tiers');
  });

  it('ne requalifie pas une annulation appelant pendant la lecture d’une erreur HTTP', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({
        error: { message: 'corps non pertinent' },
      }), { status: 503 })),
    );
    const adapter = new OpenAiCompatibleLlmAdapter({
      id: 'openai-abort-test',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'openai-key',
      model: 'gpt-test',
    });
    const controller = new AbortController();
    const reason = new Error('caller_cancelled');
    controller.abort(reason);

    const failure = await adapter.complete([{ role: 'user', content: 'Bonjour' }], {
      signal: controller.signal,
    }).then(() => null, (error: unknown) => error);

    expect(failure).toBe(reason);
    expect(failure).not.toBeInstanceOf(LlmProviderHttpError);
  });

  it('préserve le strict mission et le multi-actions global dans le wire OpenAI réel', async () => {
    process.env.OPENAI_API_KEY = 'openai-test-key';
    process.env.OPENAI_MODEL = 'gpt-test';
    delete process.env.OPENAI_URL;
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            model: 'gpt-test',
            choices: [{
              message: {
                content: null,
                tool_calls: [{
                  function: {
                    name: 'mettre_a_jour_mission_devis_v2',
                    arguments: JSON.stringify({
                      operations: [{
                        kind: 'select_presented_choice',
                        ordinal: 1,
                        has_unprocessed_request: false,
                      }],
                    }),
                  },
                }],
              },
            }],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const llm = buildLlmForProvider('openai');
    if (llm === undefined) throw new Error('Adapter OpenAI attendu.');

    await expect(
      planRealtimeSemanticTurn(llm, {
        transcript: 'Prends la première.',
        history: [],
        context: {
          screen: { name: '/devis/new', instanceId: 'quote-test' },
          entities: [],
          capabilities: ['quote.read', 'quote.line.update'],
        },
        screen: {
          route: '/devis/new',
          revision: 1,
          digest: 'a'.repeat(64),
        },
        quoteMission: {
          missionAlias: 'M1',
          missionRevision: 1,
          confirmedLineCount: 0,
          pendingLineCount: 1,
          pendingDecisionKind: 'catalogue',
          protocolVersion: 2,
          phase: 'awaiting_catalogue_choice',
          requiredFact: null,
          currentLine: {
            label: 'Main-d’œuvre',
            category: 'labor',
            quantityDecimal: '2',
            unit: 'heure',
            unitPriceDecimal: null,
            currency: 'EUR',
            vatRate: null,
            priceBasis: 'per_unit',
            housingOlderThan2y: null,
            energyRenovation: null,
          },
          presentedChoices: [{
            alias: 'C1',
            kind: 'catalogue',
            available: true,
            label: 'Main-d’œuvre atelier',
            category: 'labor',
            unit: 'heure',
            unitPriceDecimal: '55.00',
            currency: 'EUR',
          }],
        },
        hostManifest: {
          schema: 'bob.realtime-semantic-host-manifest',
          version: 1,
          globalToolNames: ['factures_impayees', 'ouvrir_cloture'],
        },
        missionCapabilities: [
          'quote.line.stage',
          'quote.catalogue.search',
          'quote.line.patch',
          'quote.line.confirm',
        ],
        locale: 'fr-FR',
        timeZone: 'Europe/Paris',
        now: '2026-07-31T08:00:00.000Z',
      }),
    ).resolves.toMatchObject({ status: 'mission_frame' });

    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string) as {
      readonly parallel_tool_calls?: unknown;
      readonly tools?: Array<{
        readonly function?: {
          readonly name?: unknown;
          readonly strict?: unknown;
        };
      }>;
    };
    const missionTool = body.tools?.find(
      (tool) => tool.function?.name === 'mettre_a_jour_mission_devis_v2',
    );
    expect(body.tools?.map((tool) => tool.function?.name)).toEqual([
      'mettre_a_jour_mission_devis_v2',
      'factures_impayees',
      'ouvrir_cloture',
    ]);
    expect(missionTool?.function?.strict).toBe(true);
    expect(body).not.toHaveProperty('parallel_tool_calls');
  });
});

describe('Mistral Voxtral providers', () => {
  it('transcrit via audio/transcriptions avec langue fr et context bias', async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ text: ' Bonjour Bob ' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new MistralVoxtralSttAdapter(
      'mistral-key',
      'voxtral-test',
      'https://api.test/v1',
      'Durand,F-2026-001',
    );

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
    const wav = openAiWave();
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
    const wav = openAiWave();
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(new Uint8Array(wav), {
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

  it('matérialise les longueurs sentinelles du WAV OpenAI sans modifier le PCM', async () => {
    const streamed = openAiWave(32_000, true);
    const pcm = Buffer.from(streamed.subarray(44));
    const adapter = new OpenAiRealtimeSpeechTtsAdapter('openai-key');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(streamed), {
      status: 200,
      headers: { 'content-type': 'audio/wav' },
    })));

    const output = await adapter.synthesize('Bob vérifie le montant de 42 euros.');
    const canonical = Buffer.from(output.audioBase64 ?? '', 'base64');

    expect(typeof output.audioBase64).toBe('string');
    expect(canonical.readUInt32LE(4)).toBe(canonical.byteLength - 8);
    expect(canonical.readUInt32LE(40)).toBe(canonical.byteLength - 44);
    expect(canonical.subarray(44)).toEqual(pcm);
    expect(output).toMatchObject({
      mimeType: 'audio/wav',
      model: 'gpt-4o-mini-tts-2025-12-15',
    });
  });

  it.each([
    ['RIFF sentinelle avec data finie', true, false],
    ['RIFF fini avec data sentinelle', false, true],
  ] as const)('matérialise la forme mixte %s', async (_label, streamingRiff, streamingData) => {
    const bytes = openAiWave(4_800);
    if (streamingRiff) bytes.writeUInt32LE(0xffff_ffff, 4);
    if (streamingData) bytes.writeUInt32LE(0xffff_ffff, 40);
    const adapter = new OpenAiRealtimeSpeechTtsAdapter('openai-key');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(bytes), {
      status: 200,
      headers: { 'content-type': 'audio/wav' },
    })));

    const output = Buffer.from(
      (await adapter.synthesize('Bonjour.')).audioBase64 ?? '',
      'base64',
    );

    expect(output.readUInt32LE(4)).toBe(output.byteLength - 8);
    expect(output.readUInt32LE(40)).toBe(output.byteLength - 44);
  });

  it.each([
    ['taille RIFF contradictoire', () => {
      const bytes = openAiWave();
      bytes.writeUInt32LE(12, 4);
      return bytes;
    }],
    ['chunk data tronqué', () => {
      const bytes = openAiWave();
      bytes.writeUInt32LE(bytes.byteLength, 40);
      return bytes;
    }],
    ['sentinelle sur un chunk non-data', () => {
      const bytes = openAiWave();
      bytes.writeUInt32LE(0xffff_ffff, 16);
      return bytes;
    }],
    ['chunk fmt manquant', () => {
      const bytes = openAiWave();
      bytes.write('JUNK', 12, 'ascii');
      return bytes;
    }],
    ['taille sentinelle impaire sans padding prouvable', () => openAiWave(469, true)],
    ['second chunk data', () => {
      const duplicate = Buffer.alloc(12);
      duplicate.write('data', 0, 'ascii');
      duplicate.writeUInt32LE(4, 4);
      const bytes = Buffer.concat([openAiWave(468), duplicate]);
      bytes.writeUInt32LE(bytes.byteLength - 8, 4);
      return bytes;
    }],
    ['plus de 64 chunks', () => {
      const junkChunks = Buffer.alloc(65 * 8);
      for (let offset = 0; offset < junkChunks.byteLength; offset += 8) {
        junkChunks.write('JUNK', offset, 'ascii');
      }
      const bytes = Buffer.concat([
        openAiWave(468).subarray(0, 12),
        junkChunks,
        openAiWave(468).subarray(12),
      ]);
      bytes.writeUInt32LE(bytes.byteLength - 8, 4);
      return bytes;
    }],
  ] as const)('refuse un WAV OpenAI ambigu : %s', async (_label, fixture) => {
    const adapter = new OpenAiRealtimeSpeechTtsAdapter('openai-key');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(fixture()), {
      status: 200,
      headers: { 'content-type': 'audio/wav' },
    })));

    await expect(adapter.synthesize('Bonjour.')).rejects.toThrow('voice_provider_invalid_audio');
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
    delete process.env.REALTIME_SPEECH_AUDIT_STT_MODEL;
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
      LOCAL_WHISPER_AUDIT_CONTRACT.model.id,
    );
    const audio = Buffer.from([0x52, 0x49, 0x46, 0x46]).toString('base64');

    await expect(adapter.transcribe(audio, 'audio/wav')).resolves.toEqual({
      text: 'Bonjour Bob.',
      model: LOCAL_WHISPER_AUDIT_CONTRACT.model.id,
    });
    expect(adapter.auditTrustDomain).toBe('bob.local-whisper');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8080/v1/audio/transcriptions',
      expect.objectContaining({
        method: 'POST',
        headers: { authorization: 'Bearer audit-token-that-is-at-least-32-bytes' },
        redirect: 'error',
      }),
    );
  });

  it('ferme l’auditeur local sur configuration, audio ou réponse non conformes', async () => {
    expect(() => new LocalWhisperAuditSttAdapter('short', 'https://localhost:8080/v1')).toThrow(
      'local_whisper_invalid_config',
    );
    expect(() => new LocalWhisperAuditSttAdapter(
      'é'.repeat(32),
      'https://localhost:8080/v1',
    )).toThrow('local_whisper_invalid_config');
    expect(() => new LocalWhisperAuditSttAdapter(
      'a'.repeat(257),
      'https://localhost:8080/v1',
    )).toThrow('local_whisper_invalid_config');
    expect(() => new LocalWhisperAuditSttAdapter('a'.repeat(32), 'http://audit.example/v1')).toThrow(
      'local_whisper_invalid_config',
    );
    expect(() => new LocalWhisperAuditSttAdapter('a'.repeat(32), 'https://audit.example/v1')).toThrow(
      'local_whisper_invalid_config',
    );
    expect(() => new LocalWhisperAuditSttAdapter(
      'a'.repeat(32),
      'http://another-service.railway.internal:8080/v1',
    )).toThrow('local_whisper_invalid_config');
    expect(() => new LocalWhisperAuditSttAdapter(
      'a'.repeat(32),
      'http://bob-live-whisper-audit.railway.internal:8080/v1',
      'whisper-latest',
    )).toThrow('local_whisper_invalid_config');
    const adapter = new LocalWhisperAuditSttAdapter('a'.repeat(32), 'https://localhost:8080/v1');
    await expect(adapter.transcribe('!!!!', 'audio/wav')).rejects.toThrow('voice_provider_invalid_audio');
    await expect(adapter.transcribe(Buffer.from([1]).toString('base64'), 'audio/mpeg'))
      .rejects.toThrow('voice_provider_invalid_audio');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ transcript: 'non' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));
    await expect(adapter.transcribe(Buffer.from([1]).toString('base64'), 'audio/wav'))
      .rejects.toThrow('local_whisper_invalid_response');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ text: '   ' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));
    await expect(adapter.transcribe(Buffer.from([1]).toString('base64'), 'audio/wav'))
      .rejects.toThrow('local_whisper_invalid_response');
  });

  it('sonde réellement la readiness privée et exige les digests compilés', async () => {
    const adapter = new LocalWhisperAuditSttAdapter(
      'a'.repeat(32),
      'http://bob-live-whisper-audit.railway.internal:8080/v1',
    );
    const readyPayload = {
      status: 'ready',
      schemaVersion: LOCAL_WHISPER_AUDIT_CONTRACT.schemaVersion,
      engine: { ...LOCAL_WHISPER_AUDIT_CONTRACT.engine },
      model: { ...LOCAL_WHISPER_AUDIT_CONTRACT.model },
      capacity: { active: 0, queued: 0 },
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(readyPayload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(adapter.health()).resolves.toEqual({ healthy: true });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://bob-live-whisper-audit.railway.internal:8080/v1/health',
      expect.objectContaining({ method: 'GET', redirect: 'error' }),
    );

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ...readyPayload,
      model: { ...readyPayload.model, sha256: '0'.repeat(64) },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));
    await expect(adapter.health()).resolves.toEqual({ healthy: false });
  });

  it('prouve les refus réseau du gateway sans envoyer de contenu métier', async () => {
    const token = 'audit-token-that-is-at-least-32-bytes';
    const adapter = new LocalWhisperAuditSttAdapter(
      token,
      'http://bob-live-whisper-audit.railway.internal:8080/v1',
    );
    const statuses = [401, 401, 404, 413] as const;
    const fetchMock = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => {
      const status = statuses[fetchMock.mock.calls.length - 1];
      if (status === undefined) throw new Error('unexpected_call');
      return new Response(JSON.stringify({ error: 'refused' }), {
        status,
        headers: {
          'cache-control': 'no-store',
          'content-type': 'application/json; charset=utf-8',
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(adapter.proveDeploymentControls()).resolves.toEqual({ healthy: true });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[0]).toEqual([
      'http://bob-live-whisper-audit.railway.internal:8080/v1/audio/transcriptions',
      expect.objectContaining({ method: 'POST', redirect: 'error' }),
    ]);
    const wrongAuth = (
      (fetchMock.mock.calls[1]?.[1] as RequestInit).headers as Record<string, string>
    ).authorization;
    expect(wrongAuth).not.toBe(`Bearer ${token}`);
    expect(wrongAuth).toMatch(/^Bearer [\x21-\x7e]{32,256}$/u);
    expect(fetchMock.mock.calls[2]?.[0])
      .toBe('http://bob-live-whisper-audit.railway.internal:8080/v1/load');
    const oversized = (fetchMock.mock.calls[3]?.[1] as RequestInit).body;
    expect(oversized).toBeInstanceOf(Uint8Array);
    expect((oversized as Uint8Array).byteLength)
      .toBe(LOCAL_WHISPER_AUDIT_CONTRACT.maxRequestBytes + 1);
    expect(JSON.stringify(await adapter.proveDeploymentControls({
      signal: AbortSignal.abort(),
    }))).toBe('{"healthy":false}');
  });

  it('ferme la preuve réseau si un code ou un header de refus dérive', async () => {
    const adapter = new LocalWhisperAuditSttAdapter(
      'a'.repeat(32),
      'http://bob-live-whisper-audit.railway.internal:8080/v1',
    );
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"refused"}', {
      status: 401,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })));

    await expect(adapter.proveDeploymentControls()).resolves.toEqual({ healthy: false });
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
