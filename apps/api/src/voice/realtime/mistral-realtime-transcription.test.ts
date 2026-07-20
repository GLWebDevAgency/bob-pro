import { EventEmitter } from 'node:events';
import WebSocket, { type ClientOptions, type RawData } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import {
  decodeMistralRealtimeEvent,
  MistralRealtimeError,
  MistralRealtimeTranscriptionConnection,
  type MistralRealtimeSocketFactory,
  type MistralRealtimeTranscriptionSettings,
} from './mistral-realtime-transcription';

const SETTINGS: MistralRealtimeTranscriptionSettings = {
  apiKey: 'mistral-secret',
  baseUrl: 'wss://api.mistral.ai',
  model: 'voxtral-mini-transcribe-realtime-2602',
  targetDelayMs: 240,
  connectTimeoutMs: 1_000,
  maxSessionSeconds: 60,
};

function sessionEvent(type: 'session.created' | 'session.updated', overrides: Record<string, unknown> = {}): object {
  return {
    type,
    session: {
      request_id: 'mistral-session-1',
      model: SETTINGS.model,
      audio_format: { encoding: 'pcm_s16le', sample_rate: 16_000 },
      target_streaming_delay_ms: SETTINGS.targetDelayMs,
      ...overrides,
    },
  };
}

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount: number = 0;
  readonly sent: string[] = [];
  terminated = false;
  suppressCloseEvent = false;

  constructor(private readonly updated: object = sessionEvent('session.updated')) {
    super();
    queueMicrotask(() => this.message(sessionEvent('session.created')));
  }

  send(data: string, callback?: (error?: Error) => void): void {
    this.sent.push(data);
    callback?.();
    const message = JSON.parse(data) as { type?: string };
    if (message.type === 'session.update') queueMicrotask(() => this.message(this.updated));
  }

  close(code = 1000): void {
    this.readyState = WebSocket.CLOSED;
    if (!this.suppressCloseEvent) queueMicrotask(() => this.emit('close', code, Buffer.alloc(0)));
  }

  terminate(): void {
    this.terminated = true;
    this.readyState = WebSocket.CLOSED;
    queueMicrotask(() => this.emit('close', 1006, Buffer.alloc(0)));
  }

  message(payload: object | string, isBinary = false): void {
    const bytes = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
    this.emit('message', bytes satisfies RawData, isBinary);
  }
}

function harness(updated?: object): {
  socket: FakeSocket;
  factory: MistralRealtimeSocketFactory;
  calls: Array<{ url: string; options: ClientOptions }>;
} {
  const socket = new FakeSocket(updated);
  const calls: Array<{ url: string; options: ClientOptions }> = [];
  const factory: MistralRealtimeSocketFactory = (url, options) => {
    calls.push({ url, options });
    return socket;
  };
  return { socket, factory, calls };
}

describe('Mistral Voxtral Realtime — protocole PCM serveur', () => {
  it('décode uniquement les événements bornés du contrat officiel', () => {
    expect(decodeMistralRealtimeEvent(
      Buffer.from(JSON.stringify({ type: 'transcription.text.delta', text: 'Bonjour' })),
      false,
    )).toEqual({ type: 'transcript_delta', text: 'Bonjour' });

    expect(decodeMistralRealtimeEvent(Buffer.from(JSON.stringify({
      type: 'transcription.done',
      model: SETTINGS.model,
      text: 'Bonjour Bob',
      language: 'fr',
      usage: { total_tokens: 12, prompt_audio_seconds: 2 },
    })), false)).toEqual({
      type: 'transcript_final',
      model: SETTINGS.model,
      text: 'Bonjour Bob',
      language: 'fr',
      inputAudioSeconds: 2,
      totalTokens: 12,
    });

    expect(decodeMistralRealtimeEvent(Buffer.from(JSON.stringify({
      type: 'transcription.segment',
      text: 'Bonjour Bob',
      start: 0.12,
      end: 0.84,
      speaker_id: 'speaker-0',
    })), false)).toEqual({
      type: 'transcript_segment',
      text: 'Bonjour Bob',
      startSeconds: 0.12,
      endSeconds: 0.84,
      speakerId: 'speaker-0',
    });
    expect(decodeMistralRealtimeEvent(Buffer.from(JSON.stringify({
      type: 'transcription.segment',
      text: 'invalide',
      start: 2,
      end: 1,
    })), false)).toEqual({ type: 'malformed' });

    expect(decodeMistralRealtimeEvent(Buffer.from('{}'), false)).toEqual({ type: 'malformed' });
    expect(decodeMistralRealtimeEvent(Buffer.from('{}'), true)).toEqual({ type: 'malformed' });
    expect(decodeMistralRealtimeEvent(Buffer.alloc(256 * 1024 + 1), false)).toEqual({ type: 'malformed' });
  });

  it('garde la clé côté serveur, acquitte le format exact puis streame le PCM', async () => {
    const h = harness();
    const connection = await MistralRealtimeTranscriptionConnection.connect(SETTINGS, {
      socketFactory: h.factory,
    });

    expect(connection.providerSessionId).toBe('mistral-session-1');
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.url).toBe(
      'wss://api.mistral.ai/v1/audio/transcriptions/realtime?model=voxtral-mini-transcribe-realtime-2602',
    );
    expect(h.calls[0]?.options.headers).toEqual({ authorization: 'Bearer mistral-secret' });
    expect(h.calls[0]?.options.perMessageDeflate).toBe(false);
    expect(JSON.parse(h.socket.sent[0] ?? '{}')).toEqual({
      type: 'session.update',
      session: {
        audio_format: { encoding: 'pcm_s16le', sample_rate: 16_000 },
        target_streaming_delay_ms: 240,
      },
    });

    await connection.sendAudio(new Uint8Array([1, 0, 2, 0]));
    await connection.flushAudio();
    await connection.endAudio();
    expect(JSON.parse(h.socket.sent[1] ?? '{}')).toEqual({
      type: 'input_audio.append',
      audio: 'AQACAA==',
    });
    expect(JSON.parse(h.socket.sent[2] ?? '{}')).toEqual({ type: 'input_audio.flush' });
    expect(JSON.parse(h.socket.sent[3] ?? '{}')).toEqual({ type: 'input_audio.end' });

    h.socket.message({ type: 'transcription.text.delta', text: 'Bonjour ' });
    h.socket.message({
      type: 'transcription.done',
      model: SETTINGS.model,
      text: 'Bonjour Bob',
      language: 'fr',
      usage: { total_tokens: 8, prompt_audio_seconds: 1 },
    });
    const events = [];
    for await (const event of connection.events()) events.push(event);
    expect(events).toEqual([
      { type: 'transcript_delta', text: 'Bonjour ' },
      {
        type: 'transcript_final',
        text: 'Bonjour Bob',
        language: 'fr',
        usage: { inputAudioSeconds: 1, totalTokens: 8 },
      },
    ]);
    await connection.close();
  });

  it('refuse un ACK de session qui dérive du modèle ou du format demandé', async () => {
    const wrongModel = harness(sessionEvent('session.updated', { model: 'other-model' }));
    await expect(MistralRealtimeTranscriptionConnection.connect(SETTINGS, {
      socketFactory: wrongModel.factory,
    })).rejects.toMatchObject({ code: 'provider_protocol_error' });
    expect(wrongModel.socket.terminated).toBe(true);

    const wrongFormat = harness(sessionEvent('session.updated', {
      audio_format: { encoding: 'pcm_f32le', sample_rate: 48_000 },
    }));
    await expect(MistralRealtimeTranscriptionConnection.connect(SETTINGS, {
      socketFactory: wrongFormat.factory,
    })).rejects.toBeInstanceOf(MistralRealtimeError);
  });

  it('propage l’abort sans attendre le timeout provider', async () => {
    const h = harness();
    const abort = new AbortController();
    abort.abort();
    await expect(MistralRealtimeTranscriptionConnection.connect(SETTINGS, {
      socketFactory: h.factory,
      signal: abort.signal,
    })).rejects.toMatchObject({ code: 'aborted' });
  });

  it('borne les chunks, le budget session et la backpressure', async () => {
    const h = harness();
    const connection = await MistralRealtimeTranscriptionConnection.connect(SETTINGS, {
      socketFactory: h.factory,
    });
    await expect(connection.sendAudio(new Uint8Array([1]))).rejects.toMatchObject({ code: 'audio_chunk_invalid' });
    await expect(connection.sendAudio(new Uint8Array(64 * 1024 + 2))).rejects.toMatchObject({
      code: 'audio_chunk_invalid',
    });

    for (let index = 0; index < 29; index += 1) {
      await connection.sendAudio(new Uint8Array(64 * 1024));
    }
    await expect(connection.sendAudio(new Uint8Array(64 * 1024))).rejects.toMatchObject({
      code: 'audio_budget_exceeded',
    });

    h.socket.bufferedAmount = 512 * 1024 + 1;
    await expect(connection.sendAudio(new Uint8Array([1, 0]))).rejects.toMatchObject({ code: 'backpressure' });
    await connection.close();
  });

  it('ferme fail-closed sur événement inconnu ou erreur provider sans exposer son message', async () => {
    const h = harness();
    const connection = await MistralRealtimeTranscriptionConnection.connect(SETTINGS, {
      socketFactory: h.factory,
    });
    h.socket.message({ type: 'future.untrusted.event', secret: 'ne-pas-exposer' });
    await expect(async () => {
      for await (const _event of connection.events()) void _event;
    }).rejects.toMatchObject({ code: 'provider_protocol_error' });
    expect(h.socket.terminated).toBe(true);
    expect(h.socket.listenerCount('message')).toBe(0);
    expect(h.socket.listenerCount('error')).toBe(0);
    expect(h.socket.listenerCount('close')).toBe(0);
  });

  it('refuse le modèle final dérivant de la session et détache tous les listeners', async () => {
    const h = harness();
    const connection = await MistralRealtimeTranscriptionConnection.connect(SETTINGS, {
      socketFactory: h.factory,
    });
    await connection.endAudio();
    h.socket.message({
      type: 'transcription.done',
      model: 'voxtral-untrusted-drift',
      text: 'Bonjour Bob',
      language: 'fr',
      usage: { total_tokens: 1, prompt_audio_seconds: 1 },
    });
    await expect(async () => {
      for await (const _event of connection.events()) void _event;
    }).rejects.toMatchObject({ code: 'provider_protocol_error' });
    expect(h.socket.terminated).toBe(true);
    await expect(connection.close()).rejects.toMatchObject({ code: 'provider_timeout' });
    expect(h.socket.listenerCount('message')).toBe(0);
    expect(h.socket.listenerCount('error')).toBe(0);
    expect(h.socket.listenerCount('close')).toBe(0);
  });

  it('borne la file provider et termine fail-closed sous flood sans lecteur', async () => {
    const h = harness();
    const connection = await MistralRealtimeTranscriptionConnection.connect(SETTINGS, {
      socketFactory: h.factory,
    });
    for (let index = 0; index < 129; index += 1) {
      h.socket.message({ type: 'transcription.text.delta', text: `delta-${index}` });
    }
    await expect(async () => {
      for await (const _event of connection.events()) void _event;
    }).rejects.toMatchObject({ code: 'provider_protocol_error' });
    expect(h.socket.terminated).toBe(true);
    expect(h.socket.listenerCount('message')).toBe(0);
  });

  it('ne confirme pas le close quand aucun close provider n’a été observé', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const connection = await MistralRealtimeTranscriptionConnection.connect(SETTINGS, {
        socketFactory: h.factory,
      });
      h.socket.suppressCloseEvent = true;
      const closing = connection.close();
      const assertion = expect(closing).rejects.toMatchObject({ code: 'provider_timeout' });
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
      expect(h.socket.terminated).toBe(true);
      expect(h.socket.listenerCount('message')).toBe(0);
      expect(h.socket.listenerCount('close')).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuse une configuration non WSS avant d’ouvrir un socket', async () => {
    const factory = vi.fn<MistralRealtimeSocketFactory>();
    await expect(MistralRealtimeTranscriptionConnection.connect({
      ...SETTINGS,
      baseUrl: 'https://api.mistral.ai',
    }, { socketFactory: factory })).rejects.toMatchObject({
      code: 'invalid_configuration',
    });
    expect(factory).not.toHaveBeenCalled();

    for (const baseUrl of [
      'wss://user:secret@api.mistral.ai',
      'wss://api.mistral.ai?api_key=secret',
      'wss://api.mistral.ai#fragment',
    ]) {
      await expect(MistralRealtimeTranscriptionConnection.connect({
        ...SETTINGS,
        baseUrl,
      }, { socketFactory: factory })).rejects.toMatchObject({ code: 'invalid_configuration' });
    }
    expect(factory).not.toHaveBeenCalled();
  });
});
