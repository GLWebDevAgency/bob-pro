import { describe, expect, it } from 'vitest';
import {
  OPENAI_NATIVE_RESPONSE_LIMITS,
  OPENAI_NATIVE_RESPONSE_PROTOCOL,
  OpenAiNativeResponseProtocolError,
  areOpenAiNativeSpeechTranscriptsConcordant,
  buildOpenAiNativeResponseCreate,
  createOpenAiNativeResponseState,
  decodeOpenAiNativeResponseEvent,
  reduceOpenAiNativeResponseState,
  type OpenAiNativeResponseEvent,
  type OpenAiNativeResponseMetadata,
  type OpenAiNativeResponseRequest,
  type OpenAiNativeResponseState,
} from './openai-native-response-protocol';

const DELIVERY_ID = '10000000-0000-4000-8000-000000000001';
const TURN_ID = '20000000-0000-4000-8000-000000000002';
const CONTEXT_DIGEST = 'a'.repeat(64);
const REQUEST_NONCE = 'request_nonce_1234567890_ABCDEFGHIJK';
const RESPONSE_ID = 'resp_bob_1';
const ITEM_ID = 'item_bob_1';

const REQUEST: OpenAiNativeResponseRequest = {
  deliveryId: DELIVERY_ID,
  turnId: TURN_ID,
  contextRevision: 7,
  contextDigest: CONTEXT_DIGEST,
  requestNonce: REQUEST_NONCE,
  canonicalSpeech: 'Reste dû : 1 320 €.',
};

const METADATA: OpenAiNativeResponseMetadata = {
  bob_protocol: OPENAI_NATIVE_RESPONSE_PROTOCOL,
  bob_delivery_id: DELIVERY_ID,
  bob_turn_id: TURN_ID,
  bob_context_revision: '7',
  bob_context_digest: CONTEXT_DIGEST,
  bob_request_nonce: REQUEST_NONCE,
};

function wire(value: unknown): string {
  return JSON.stringify(value);
}

function expectProtocolError(
  action: () => unknown,
  code: OpenAiNativeResponseProtocolError['code'],
): void {
  try {
    action();
    throw new Error('expected protocol error');
  } catch (error) {
    expect(error).toBeInstanceOf(OpenAiNativeResponseProtocolError);
    expect((error as OpenAiNativeResponseProtocolError).code).toBe(code);
    expect((error as Error).message).toBe(code);
  }
}

function createdEvent(
  responseId = RESPONSE_ID,
  metadata: OpenAiNativeResponseMetadata = METADATA,
): unknown {
  return {
    type: 'response.created',
    response: {
      id: responseId,
      status: 'in_progress',
      conversation_id: null,
      output_modalities: ['audio'],
      output: [],
      metadata,
    },
  };
}

function responseDoneEvent(input: {
  readonly status?: 'completed' | 'cancelled' | 'failed' | 'incomplete';
  readonly responseId?: string;
  readonly metadata?: OpenAiNativeResponseMetadata;
  readonly transcript?: string;
  readonly usage?: unknown;
} = {}): unknown {
  const status = input.status ?? 'completed';
  const transcript = input.transcript ?? REQUEST.canonicalSpeech;
  return {
    type: 'response.done',
    response: {
      id: input.responseId ?? RESPONSE_ID,
      status,
      output_modalities: ['audio'],
      metadata: input.metadata ?? METADATA,
      output: status === 'completed'
        ? [{
            id: ITEM_ID,
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_audio', transcript }],
          }]
        : [],
      ...(input.usage === undefined ? {} : { usage: input.usage }),
    },
  };
}

function audioEvent(
  type:
    | 'response.output_audio.delta'
    | 'response.output_audio.done'
    | 'response.output_audio_transcript.delta'
    | 'response.output_audio_transcript.done',
  value?: string,
  responseId = RESPONSE_ID,
): unknown {
  return {
    type,
    response_id: responseId,
    item_id: ITEM_ID,
    output_index: 0,
    content_index: 0,
    ...(type.endsWith('transcript.delta') ? { delta: value } : {}),
    ...(type.endsWith('transcript.done') ? { transcript: value } : {}),
    ...(type === 'response.output_audio.delta' ? { delta: value ?? 'AQIDBA==' } : {}),
  };
}

function decoded(value: unknown): OpenAiNativeResponseEvent {
  return decodeOpenAiNativeResponseEvent(wire(value));
}

function reduceWire(state: OpenAiNativeResponseState, value: unknown): OpenAiNativeResponseState {
  return reduceOpenAiNativeResponseState(state, decoded(value));
}

function readyForTerminalOrder(): OpenAiNativeResponseState {
  let state = createOpenAiNativeResponseState(REQUEST);
  state = reduceWire(state, createdEvent());
  state = reduceWire(state, {
    type: 'response.output_item.added',
    response_id: RESPONSE_ID,
    output_index: 0,
    item: { id: ITEM_ID, type: 'message', role: 'assistant', content: [] },
  });
  state = reduceWire(state, {
    type: 'response.content_part.added',
    response_id: RESPONSE_ID,
    item_id: ITEM_ID,
    output_index: 0,
    content_index: 0,
    part: { type: 'audio', transcript: '' },
  });
  state = reduceWire(state, audioEvent('response.output_audio.delta'));
  state = reduceWire(state, audioEvent(
    'response.output_audio_transcript.delta',
    REQUEST.canonicalSpeech,
  ));
  state = reduceWire(state, audioEvent(
    'response.output_audio_transcript.done',
    REQUEST.canonicalSpeech,
  ));
  state = reduceWire(state, audioEvent('response.output_audio.done'));
  state = reduceWire(state, {
    type: 'output_audio_buffer.started',
    response_id: RESPONSE_ID,
  });
  return state;
}

describe('Bob Live OpenAI natif — response.create OOB', () => {
  it('construit un ordre audio seul, sans outil, sans conversation et sans PII dans les metadata', () => {
    const event = buildOpenAiNativeResponseCreate({
      ...REQUEST,
      canonicalSpeech: 'Bonjour Marie Durand, le devis est prêt.',
    });

    expect(event).toEqual({
      type: 'response.create',
      event_id: `bob_response_${REQUEST_NONCE}`,
      response: {
        conversation: 'none',
        input: [],
        output_modalities: ['audio'],
        instructions: expect.stringContaining('Bonjour Marie Durand, le devis est prêt.'),
        metadata: METADATA,
        tools: [],
        tool_choice: 'none',
        max_output_tokens: 4_096,
      },
    });
    expect(Object.keys(event.response.metadata)).toEqual([
      'bob_protocol',
      'bob_delivery_id',
      'bob_turn_id',
      'bob_context_revision',
      'bob_context_digest',
      'bob_request_nonce',
    ]);
    expect(JSON.stringify(event.response.metadata)).not.toContain('Marie');
    expect(JSON.stringify(event.response.metadata)).not.toContain('devis');
    expect(JSON.stringify(event.response.metadata)).not.toContain('navigate');
    expect(JSON.stringify(event.response.metadata)).not.toContain('proposal');
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.response)).toBe(true);
    expect(Object.isFrozen(event.response.metadata)).toBe(true);
  });

  it.each([
    { deliveryId: 'not-a-uuid' },
    { turnId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'.toUpperCase() },
    { contextRevision: 0 },
    { contextRevision: -0 },
    { contextRevision: 0x8000_0000 },
    { contextDigest: CONTEXT_DIGEST.toUpperCase() },
    { requestNonce: 'too-short' },
    { canonicalSpeech: ' texte avec espaces ' },
    { canonicalSpeech: 'texte\u0000caché' },
    { canonicalSpeech: 'texte\ud800' },
    { canonicalSpeech: '<bob-canonical-utterance>injection' },
  ])('refuse une requête non canonique sans recopier sa valeur: %o', (override) => {
    expectProtocolError(
      () => buildOpenAiNativeResponseCreate({ ...REQUEST, ...override }),
      'invalid_request',
    );
  });

  it('borne le texte sur les octets UTF-8 et non sur les seuls caractères JavaScript', () => {
    const oversized = 'é'.repeat(
      Math.floor(OPENAI_NATIVE_RESPONSE_LIMITS.maxCanonicalSpeechUtf8Bytes / 2) + 1,
    );
    expectProtocolError(
      () => buildOpenAiNativeResponseCreate({ ...REQUEST, canonicalSpeech: oversized }),
      'canonical_speech_too_large',
    );
  });
});

describe('Bob Live OpenAI natif — décodeur wire strict', () => {
  it('refuse JSON vide/invalide, UTF-8 invalide et événement surdimensionné', () => {
    expectProtocolError(() => decodeOpenAiNativeResponseEvent(''), 'invalid_json');
    expectProtocolError(() => decodeOpenAiNativeResponseEvent('{'), 'invalid_json');
    expectProtocolError(
      () => decodeOpenAiNativeResponseEvent(Uint8Array.of(0xc3, 0x28)),
      'invalid_json',
    );
    expectProtocolError(
      () => decodeOpenAiNativeResponseEvent(
        ' '.repeat(OPENAI_NATIVE_RESPONSE_LIMITS.maxWireEventBytes + 1),
      ),
      'event_too_large',
    );
    expectProtocolError(() => decodeOpenAiNativeResponseEvent({ type: 'response.done' }), 'invalid_json');
  });

  it('accepte un Buffer ou des fragments wire et refuse les metadata supplémentaires', () => {
    const raw = Buffer.from(wire(createdEvent()));
    expect(decodeOpenAiNativeResponseEvent(raw)).toMatchObject({
      type: 'response_created',
      responseId: RESPONSE_ID,
      metadata: METADATA,
    });
    expect(decodeOpenAiNativeResponseEvent([
      raw.subarray(0, 10),
      raw.subarray(10),
    ])).toMatchObject({ type: 'response_created' });

    expectProtocolError(
      () => decodeOpenAiNativeResponseEvent(wire(createdEvent(RESPONSE_ID, {
        ...METADATA,
        bob_navigate: '/argent',
      } as unknown as OpenAiNativeResponseMetadata))),
      'invalid_metadata',
    );
  });

  it('valide le PCM base64 mais ne le conserve jamais dans l’événement décodé', () => {
    const event = decodeOpenAiNativeResponseEvent(wire(audioEvent(
      'response.output_audio.delta',
      'AQIDBA==',
    )));
    expect(event).toEqual({
      type: 'audio_delta',
      responseId: RESPONSE_ID,
      itemId: ITEM_ID,
      outputIndex: 0,
      contentIndex: 0,
      audioBytes: 4,
    });
    expect(JSON.stringify(event)).not.toContain('AQIDBA');
    expectProtocolError(
      () => decodeOpenAiNativeResponseEvent(wire(audioEvent(
        'response.output_audio.delta',
        '***=',
      ))),
      'invalid_event',
    );
  });

  it.each([
    { type: 'response.function_call_arguments.delta', response_id: RESPONSE_ID, delta: '{}' },
    { type: 'response.mcp_call.completed', response_id: RESPONSE_ID },
    {
      type: 'response.output_item.added',
      response_id: RESPONSE_ID,
      output_index: 0,
      item: { id: ITEM_ID, type: 'function_call', name: 'delete_invoice' },
    },
    {
      type: 'conversation.item.done',
      item: { id: ITEM_ID, type: 'function_call_output', output: 'ok' },
    },
  ])('refuse toute surface outil: %o', (event) => {
    expectProtocolError(
      () => decodeOpenAiNativeResponseEvent(wire(event)),
      'forbidden_tool_output',
    );
  });

  it.each([
    { type: 'response.output_text.delta', response_id: RESPONSE_ID, delta: 'secret' },
    { type: 'response.refusal.done', response_id: RESPONSE_ID, refusal: 'non' },
    {
      type: 'conversation.item.added',
      item: { id: ITEM_ID, type: 'message', role: 'assistant', content: [] },
    },
    {
      type: 'response.content_part.added',
      response_id: RESPONSE_ID,
      item_id: ITEM_ID,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: 'contournement' },
    },
  ])('refuse toute sortie texte autonome: %o', (event) => {
    expectProtocolError(
      () => decodeOpenAiNativeResponseEvent(wire(event)),
      'forbidden_text_output',
    );
  });

  it('inspecte aussi la sortie terminale et refuse un texte ou un outil caché', () => {
    for (const item of [
      {
        id: ITEM_ID,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'contournement' }],
      },
      { id: ITEM_ID, type: 'function_call', name: 'navigate', arguments: '{}' },
    ]) {
      const event = responseDoneEvent() as {
        response: Record<string, unknown>;
      };
      event.response.output = [item];
      expectProtocolError(
        () => decodeOpenAiNativeResponseEvent(wire(event)),
        item.type === 'function_call' ? 'forbidden_tool_output' : 'forbidden_text_output',
      );
    }
  });

  it('refuse tout nouvel événement response non explicitement audité', () => {
    expectProtocolError(
      () => decodeOpenAiNativeResponseEvent(wire({
        type: 'response.new_magic_event',
        response_id: RESPONSE_ID,
      })),
      'unsupported_response_event',
    );
    expect(decodeOpenAiNativeResponseEvent(wire({ type: 'rate_limits.updated' }))).toEqual({
      type: 'ignored',
    });
  });

  it('extrait uniquement des compteurs usage bornés et n’invente rien quand ils sont absents', () => {
    const available = decoded(responseDoneEvent({
      usage: {
        total_tokens: 140,
        input_tokens: 100,
        output_tokens: 40,
        input_token_details: {
          cached_tokens: 20,
          text_tokens: 30,
          audio_tokens: 70,
          cached_tokens_details: { text_tokens: 5, audio_tokens: 15 },
        },
        output_token_details: { text_tokens: 5, audio_tokens: 35 },
        provider_private_field: 'never-retained',
      },
    }));
    expect(available).toMatchObject({
      type: 'response_done',
      usage: {
        status: 'available',
        totalTokens: 140,
        inputTokens: 100,
        outputTokens: 40,
        inputTokenDetails: {
          cachedTokens: 20,
          textTokens: 30,
          audioTokens: 70,
          cachedTextTokens: 5,
          cachedAudioTokens: 15,
        },
        outputTokenDetails: { textTokens: 5, audioTokens: 35 },
      },
    });
    expect(JSON.stringify(available)).not.toContain('provider_private_field');
    expect(decoded(responseDoneEvent())).toMatchObject({
      type: 'response_done',
      usage: { status: 'unavailable' },
    });

    expectProtocolError(
      () => decoded(responseDoneEvent({
        usage: { total_tokens: 139, input_tokens: 100, output_tokens: 40 },
      })),
      'invalid_event',
    );
    expectProtocolError(
      () => decoded(responseDoneEvent({
        usage: { total_tokens: 140, input_tokens: 100, output_tokens: 1_000_000_001 },
      })),
      'invalid_event',
    );
  });
});

describe('Bob Live OpenAI natif — reducer de preuve acoustique', () => {
  it('converge vers le même état si response.done précède ou suit le drainage du buffer', () => {
    const base = readyForTerminalOrder();
    const doneThenStopped = reduceWire(
      reduceWire(base, responseDoneEvent()),
      { type: 'output_audio_buffer.stopped', response_id: RESPONSE_ID },
    );
    const stoppedThenDone = reduceWire(
      reduceWire(base, { type: 'output_audio_buffer.stopped', response_id: RESPONSE_ID }),
      responseDoneEvent(),
    );

    expect(doneThenStopped).toEqual(stoppedThenDone);
    expect(doneThenStopped.phase).toBe('completed');
    expect(doneThenStopped).toMatchObject({
      audioSeen: true,
      audioDone: true,
      audioBufferStopped: true,
      responseStatus: 'completed',
      finalTranscript: REQUEST.canonicalSpeech,
      failureCode: null,
    });
  });

  it('reste non acquittable tant qu’une preuve audio/transcript/done/drain manque', () => {
    const base = readyForTerminalOrder();
    expect(reduceWire(base, responseDoneEvent()).phase).toBe('draining');
    expect(reduceWire(
      base,
      { type: 'output_audio_buffer.stopped', response_id: RESPONSE_ID },
    ).phase).toBe('draining');

    let withoutAudioDone = createOpenAiNativeResponseState(REQUEST);
    withoutAudioDone = reduceWire(withoutAudioDone, createdEvent());
    withoutAudioDone = reduceWire(withoutAudioDone, audioEvent('response.output_audio.delta'));
    withoutAudioDone = reduceWire(withoutAudioDone, audioEvent(
      'response.output_audio_transcript.done',
      REQUEST.canonicalSpeech,
    ));
    withoutAudioDone = reduceWire(withoutAudioDone, responseDoneEvent());
    withoutAudioDone = reduceWire(withoutAudioDone, {
      type: 'output_audio_buffer.stopped', response_id: RESPONSE_ID,
    });
    expect(withoutAudioDone.phase).toBe('draining');
  });

  it('refuse tout audio ou transcript tardif après response.done ou buffer stopped', () => {
    let state = createOpenAiNativeResponseState(REQUEST);
    state = reduceWire(state, createdEvent());
    state = reduceWire(state, audioEvent('response.output_audio.delta'));
    state = reduceWire(state, responseDoneEvent());
    expect(state.phase).toBe('draining');
    state = reduceWire(state, audioEvent('response.output_audio.done'));
    expect(state).toMatchObject({ phase: 'failed', failureCode: 'event_after_terminal' });

    let stoppedFirst = readyForTerminalOrder();
    stoppedFirst = reduceWire(stoppedFirst, {
      type: 'output_audio_buffer.stopped',
      response_id: RESPONSE_ID,
    });
    stoppedFirst = reduceWire(stoppedFirst, audioEvent(
      'response.output_audio_transcript.delta',
      'tardif',
    ));
    expect(stoppedFirst).toMatchObject({ phase: 'failed', failureCode: 'event_after_terminal' });
  });

  it('rejette un response.done completed sans transcript audio final', () => {
    const withoutTranscript = responseDoneEvent() as {
      response: { output: Array<{ content: Array<Record<string, unknown>> }> };
    };
    delete withoutTranscript.response.output[0]?.content[0]?.transcript;
    expect(() => decodeOpenAiNativeResponseEvent(JSON.stringify(withoutTranscript))).toThrowError(
      expect.objectContaining({ code: 'invalid_event' }),
    );
  });

  it('accepte les différences purement acoustiques mais refuse toute altération de montant', () => {
    expect(areOpenAiNativeSpeechTranscriptsConcordant(
      'Reste dû : 1 320 €.',
      'reste dû 1320 €',
    )).toBe(true);
    expect(areOpenAiNativeSpeechTranscriptsConcordant(
      'Reste dû : 1 320 €.',
      'reste dû 1 230 €',
    )).toBe(false);
    expect(areOpenAiNativeSpeechTranscriptsConcordant(
      'Taux : 20 %.',
      'taux 20',
    )).toBe(false);

    let state = createOpenAiNativeResponseState(REQUEST);
    state = reduceWire(state, createdEvent());
    state = reduceWire(state, audioEvent(
      'response.output_audio_transcript.delta',
      'Reste dû : 1 230 €.',
    ));
    state = reduceWire(state, audioEvent(
      'response.output_audio_transcript.done',
      'Reste dû : 1 230 €.',
    ));
    expect(state).toMatchObject({ phase: 'failed', failureCode: 'transcript_mismatch' });
  });

  it('refuse une réponse automatique, un autre response_id ou des metadata divergentes', () => {
    expectProtocolError(
      () => decoded({
        type: 'response.created',
        response: {
          id: 'resp_auto',
          status: 'in_progress',
          conversation_id: null,
          output_modalities: ['audio'],
          output: [],
          metadata: {},
        },
      }),
      'invalid_metadata',
    );

    let state = createOpenAiNativeResponseState(REQUEST);
    state = reduceWire(state, createdEvent());
    state = reduceWire(state, audioEvent('response.output_audio.delta', 'AQIDBA==', 'resp_rogue'));
    expect(state).toMatchObject({ phase: 'failed', failureCode: 'rogue_response' });

    state = createOpenAiNativeResponseState(REQUEST);
    state = reduceWire(state, createdEvent(RESPONSE_ID, {
      ...METADATA,
      bob_context_digest: 'b'.repeat(64),
    }));
    expect(state).toMatchObject({ phase: 'failed', failureCode: 'metadata_mismatch' });

    state = createOpenAiNativeResponseState(REQUEST);
    state = reduceWire(state, createdEvent());
    state = reduceWire(state, createdEvent('resp_second'));
    expect(state).toMatchObject({ phase: 'failed', failureCode: 'rogue_response' });
  });

  it('refuse un événement de sortie avant response.created et une seconde sortie', () => {
    let state = createOpenAiNativeResponseState(REQUEST);
    state = reduceWire(state, audioEvent('response.output_audio.delta'));
    expect(state).toMatchObject({ phase: 'failed', failureCode: 'response_not_created' });

    state = createOpenAiNativeResponseState(REQUEST);
    state = reduceWire(state, createdEvent());
    state = reduceWire(state, audioEvent('response.output_audio.delta'));
    state = reduceOpenAiNativeResponseState(state, {
      type: 'audio_done',
      responseId: RESPONSE_ID,
      itemId: 'item_bob_2',
      outputIndex: 0,
      contentIndex: 0,
    });
    expect(state).toMatchObject({ phase: 'failed', failureCode: 'multiple_output_items' });
  });

  it('annule au clear/cancel et refuse une réponse provider incomplète', () => {
    let state = createOpenAiNativeResponseState(REQUEST);
    state = reduceWire(state, createdEvent());
    state = reduceWire(state, { type: 'output_audio_buffer.cleared', response_id: RESPONSE_ID });
    expect(state.phase).toBe('cancelled');

    state = createOpenAiNativeResponseState(REQUEST);
    state = reduceWire(state, createdEvent());
    state = reduceWire(state, responseDoneEvent({ status: 'cancelled' }));
    expect(state.phase).toBe('cancelled');

    state = createOpenAiNativeResponseState(REQUEST);
    state = reduceWire(state, createdEvent());
    state = reduceWire(state, responseDoneEvent({ status: 'incomplete' }));
    expect(state).toMatchObject({
      phase: 'failed', failureCode: 'provider_response_not_completed',
    });
  });

  it('borne les cumuls transcript, audio et événement sans muter l’état précédent', () => {
    const initial = createOpenAiNativeResponseState(REQUEST);
    const created = reduceWire(initial, createdEvent());
    expect(initial).toMatchObject({ phase: 'awaiting_response', eventCount: 0, responseId: null });
    expect(created).not.toBe(initial);

    let state = reduceOpenAiNativeResponseState(created, {
      type: 'transcript_delta',
      responseId: RESPONSE_ID,
      itemId: ITEM_ID,
      outputIndex: 0,
      contentIndex: 0,
      text: 'a'.repeat(8_000),
    });
    state = reduceOpenAiNativeResponseState(state, {
      type: 'transcript_delta',
      responseId: RESPONSE_ID,
      itemId: ITEM_ID,
      outputIndex: 0,
      contentIndex: 0,
      text: 'b'.repeat(8_000),
    });
    expect(state).toMatchObject({ phase: 'failed', failureCode: 'transcript_budget_exceeded' });

    state = reduceOpenAiNativeResponseState({
      ...created,
      audioBytes: OPENAI_NATIVE_RESPONSE_LIMITS.maxAudioBytesPerResponse,
    }, {
      type: 'audio_delta',
      responseId: RESPONSE_ID,
      itemId: ITEM_ID,
      outputIndex: 0,
      contentIndex: 0,
      audioBytes: 1,
    });
    expect(state).toMatchObject({ phase: 'failed', failureCode: 'audio_budget_exceeded' });

    state = reduceOpenAiNativeResponseState({
      ...created,
      eventCount: OPENAI_NATIVE_RESPONSE_LIMITS.maxEventsPerResponse,
    }, {
      type: 'audio_buffer_started',
      responseId: RESPONSE_ID,
    });
    expect(state).toMatchObject({ phase: 'failed', failureCode: 'event_budget_exceeded' });
  });

  it('rend les signaux terminaux identiques idempotents mais refuse une reprise audio tardive', () => {
    let state = readyForTerminalOrder();
    state = reduceWire(state, responseDoneEvent());
    state = reduceWire(state, { type: 'output_audio_buffer.stopped', response_id: RESPONSE_ID });
    expect(state.phase).toBe('completed');
    const duplicate = reduceWire(state, responseDoneEvent());
    expect(duplicate.phase).toBe('completed');

    const lateAudio = reduceOpenAiNativeResponseState(duplicate, {
      type: 'audio_delta',
      responseId: RESPONSE_ID,
      itemId: ITEM_ID,
      outputIndex: 0,
      contentIndex: 0,
      audioBytes: 4,
    });
    expect(lateAudio).toMatchObject({ phase: 'failed', failureCode: 'event_after_terminal' });
  });
});
