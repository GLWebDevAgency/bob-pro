import WebSocket, { type ClientOptions, type RawData } from 'ws';

const MAX_PROVIDER_EVENT_BYTES = 256 * 1024;
const MAX_AUDIO_CHUNK_BYTES = 64 * 1024;
const MAX_PROVIDER_BUFFERED_BYTES = 512 * 1024;
const MAX_TRANSCRIPT_CHARS = 16_000;
const MAX_DELTA_CHARS = 4_000;
const MAX_SEGMENT_CHARS = 4_000;
const MAX_SPEAKER_ID_CHARS = 200;
const MAX_QUEUED_PROVIDER_EVENTS = 128;
const MAX_QUEUED_PROVIDER_EVENT_BYTES = 256 * 1024;
const PROVIDER_SESSION_ID = /^[A-Za-z0-9._:-]{1,200}$/u;
const LANGUAGE = /^[A-Za-z]{2,8}(?:[-_][A-Za-z0-9]{1,8}){0,3}$/u;
const PCM_BYTES_PER_SECOND = 16_000 * 2;

interface MistralSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  on(event: 'message', listener: (data: RawData, isBinary: boolean) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'close', listener: (code: number, reason: Buffer) => void): this;
  off(event: 'message', listener: (data: RawData, isBinary: boolean) => void): this;
  off(event: 'error', listener: (error: Error) => void): this;
  off(event: 'close', listener: (code: number, reason: Buffer) => void): this;
  send(data: string, callback?: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

export type MistralRealtimeSocketFactory = (url: string, options: ClientOptions) => MistralSocket;

export interface MistralRealtimeTranscriptionSettings {
  apiKey: string;
  baseUrl: string;
  model: string;
  targetDelayMs: number;
  connectTimeoutMs: number;
  maxSessionSeconds: number;
}

export type MistralRealtimeTranscriptionEvent =
  | { type: 'transcript_delta'; text: string }
  | {
      type: 'transcript_segment';
      text: string;
      startSeconds: number;
      endSeconds: number;
      speakerId: string | null;
    }
  | {
      type: 'transcript_final';
      text: string;
      language: string | null;
      usage: {
        inputAudioSeconds: number | null;
        totalTokens: number;
      };
    };

type ProviderSessionEvent = {
  requestId: string;
  model: string;
  encoding: string;
  sampleRate: number;
  targetDelayMs: number | null;
};

type ProviderEvent =
  | ({ type: 'session_created' } & ProviderSessionEvent)
  | ({ type: 'session_updated' } & ProviderSessionEvent)
  | { type: 'transcript_delta'; text: string }
  | {
      type: 'transcript_segment';
      text: string;
      startSeconds: number;
      endSeconds: number;
      speakerId: string | null;
    }
  | {
      type: 'transcript_final';
      model: string;
      text: string;
      language: string | null;
      inputAudioSeconds: number | null;
      totalTokens: number;
    }
  | { type: 'provider_error'; code: number }
  | { type: 'ignored' }
  | { type: 'malformed' }
  | { type: 'socket_closed'; code: number };

interface QueueWaiter<T> {
  resolve(value: T): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout> | null;
  signal: AbortSignal | null;
  onAbort: (() => void) | null;
}

interface EventQueueLimits<T> {
  readonly maxValues: number;
  readonly maxBytes: number;
  readonly sizeOf: (value: T) => number;
  readonly overflow: () => Error;
}

class EventQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: QueueWaiter<T>[] = [];
  private failure: Error | null = null;
  private queuedBytes = 0;

  constructor(private readonly limits: EventQueueLimits<T>) {}

  push(value: T): boolean {
    if (this.failure) return false;
    const waiter = this.waiters.shift();
    if (!waiter) {
      const bytes = this.limits.sizeOf(value);
      if (
        !Number.isSafeInteger(bytes)
        || bytes < 0
        || this.values.length >= this.limits.maxValues
        || this.queuedBytes + bytes > this.limits.maxBytes
      ) {
        this.fail(this.limits.overflow());
        return false;
      }
      this.values.push(value);
      this.queuedBytes += bytes;
      return true;
    }
    this.cleanup(waiter);
    waiter.resolve(value);
    return true;
  }

  fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.values.splice(0);
    this.queuedBytes = 0;
    for (const waiter of this.waiters.splice(0)) {
      this.cleanup(waiter);
      waiter.reject(error);
    }
  }

  next(timeoutMs: number, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(new MistralRealtimeError('aborted'));
    const value = this.values.shift();
    if (value !== undefined) {
      this.queuedBytes -= this.limits.sizeOf(value);
      return Promise.resolve(value);
    }
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<T>((resolve, reject) => {
      const waiter: QueueWaiter<T> = {
        resolve,
        reject,
        timer: null,
        signal: signal ?? null,
        onAbort: null,
      };
      waiter.timer = setTimeout(() => {
        this.remove(waiter);
        reject(new MistralRealtimeError('provider_timeout'));
      }, timeoutMs);
      if (signal) {
        waiter.onAbort = () => {
          this.remove(waiter);
          reject(new MistralRealtimeError('aborted'));
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  private remove(waiter: QueueWaiter<T>): void {
    const index = this.waiters.indexOf(waiter);
    if (index >= 0) this.waiters.splice(index, 1);
    this.cleanup(waiter);
  }

  private cleanup(waiter: QueueWaiter<T>): void {
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.timer = null;
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
    waiter.signal = null;
    waiter.onAbort = null;
  }
}

export class MistralRealtimeError extends Error {
  constructor(readonly code:
    | 'invalid_configuration'
    | 'aborted'
    | 'provider_timeout'
    | 'provider_error'
    | 'provider_protocol_error'
    | 'provider_closed'
    | 'audio_chunk_invalid'
    | 'audio_budget_exceeded'
    | 'backpressure') {
    super(code);
    this.name = 'MistralRealtimeError';
  }
}

function providerEventBytes(event: ProviderEvent): number {
  if (event.type === 'transcript_delta') return Buffer.byteLength(event.text, 'utf8') + 32;
  if (event.type === 'transcript_segment') {
    return Buffer.byteLength(event.text, 'utf8') + Buffer.byteLength(event.speakerId ?? '', 'utf8') + 64;
  }
  if (event.type === 'transcript_final') {
    return Buffer.byteLength(event.text, 'utf8') + Buffer.byteLength(event.language ?? '', 'utf8') + 96;
  }
  return 256;
}

function providerEventQueue(): EventQueue<ProviderEvent> {
  return new EventQueue<ProviderEvent>({
    maxValues: MAX_QUEUED_PROVIDER_EVENTS,
    maxBytes: MAX_QUEUED_PROVIDER_EVENT_BYTES,
    sizeOf: providerEventBytes,
    overflow: () => new MistralRealtimeError('provider_protocol_error'),
  });
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedNonNegativeInteger(value: unknown, max = 2_147_483_647): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max
    ? value
    : null;
}

function boundedNonNegativeNumber(value: unknown, max: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max
    ? value
    : null;
}

function rawBytes(raw: RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof ArrayBuffer) return Buffer.from(raw);
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return Buffer.from(raw as ArrayBuffer);
}

function sessionEvent(type: 'session_created' | 'session_updated', payload: Record<string, unknown>): ProviderEvent {
  const session = record(payload.session);
  const audioFormat = record(session?.audio_format);
  const requestId = session?.request_id;
  const model = session?.model;
  const encoding = audioFormat?.encoding;
  const sampleRate = audioFormat?.sample_rate;
  const targetDelay = session?.target_streaming_delay_ms;
  if (
    typeof requestId !== 'string'
    || !PROVIDER_SESSION_ID.test(requestId)
    || typeof model !== 'string'
    || model.length < 1
    || model.length > 100
    || typeof encoding !== 'string'
    || typeof sampleRate !== 'number'
    || !Number.isInteger(sampleRate)
    || (targetDelay !== undefined && targetDelay !== null && boundedNonNegativeInteger(targetDelay, 5_000) === null)
  ) return { type: 'malformed' };
  return {
    type,
    requestId,
    model,
    encoding,
    sampleRate,
    targetDelayMs: typeof targetDelay === 'number' ? targetDelay : null,
  };
}

/** Décodeur strict du protocole officiel Voxtral Realtime. Aucun message provider brut ne sort. */
export function decodeMistralRealtimeEvent(raw: RawData, isBinary: boolean): ProviderEvent {
  if (isBinary) return { type: 'malformed' };
  const bytes = rawBytes(raw);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PROVIDER_EVENT_BYTES) return { type: 'malformed' };
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return { type: 'malformed' };
  }
  const payload = record(value);
  if (!payload || typeof payload.type !== 'string') return { type: 'malformed' };
  if (payload.type === 'session.created') return sessionEvent('session_created', payload);
  if (payload.type === 'session.updated') return sessionEvent('session_updated', payload);
  if (payload.type === 'transcription.text.delta') {
    return typeof payload.text === 'string' && payload.text.length <= MAX_DELTA_CHARS
      ? { type: 'transcript_delta', text: payload.text }
      : { type: 'malformed' };
  }
  if (payload.type === 'transcription.segment') {
    const start = boundedNonNegativeNumber(payload.start, 86_400);
    const end = boundedNonNegativeNumber(payload.end, 86_400);
    const speakerId = payload.speaker_id;
    if (
      typeof payload.text !== 'string'
      || payload.text.length > MAX_SEGMENT_CHARS
      || start === null
      || end === null
      || end < start
      || (
        speakerId !== undefined
        && speakerId !== null
        && (typeof speakerId !== 'string' || speakerId.length > MAX_SPEAKER_ID_CHARS)
      )
    ) return { type: 'malformed' };
    return {
      type: 'transcript_segment',
      text: payload.text,
      startSeconds: start,
      endSeconds: end,
      speakerId: typeof speakerId === 'string' ? speakerId : null,
    };
  }
  if (payload.type === 'transcription.done') {
    const usage = record(payload.usage);
    const totalTokens = boundedNonNegativeInteger(usage?.total_tokens);
    const audioSeconds = usage?.prompt_audio_seconds;
    const validAudioSeconds = audioSeconds === null || audioSeconds === undefined
      ? null
      : boundedNonNegativeInteger(audioSeconds, 86_400);
    if (
      typeof payload.model !== 'string'
      || payload.model.length < 1
      || payload.model.length > 100
      || typeof payload.text !== 'string'
      || payload.text.length > MAX_TRANSCRIPT_CHARS
      || (
        payload.language !== null
        && (typeof payload.language !== 'string' || !LANGUAGE.test(payload.language))
      )
      || totalTokens === null
      || (audioSeconds !== null && audioSeconds !== undefined && validAudioSeconds === null)
    ) return { type: 'malformed' };
    return {
      type: 'transcript_final',
      model: payload.model,
      text: payload.text,
      language: typeof payload.language === 'string' ? payload.language : null,
      inputAudioSeconds: validAudioSeconds,
      totalTokens,
    };
  }
  if (payload.type === 'error') {
    const error = record(payload.error);
    const code = boundedNonNegativeInteger(error?.code);
    return code === null ? { type: 'malformed' } : { type: 'provider_error', code };
  }
  if (payload.type === 'transcription.language') {
    return typeof payload.audio_language === 'string' && LANGUAGE.test(payload.audio_language)
      ? { type: 'ignored' }
      : { type: 'malformed' };
  }
  return { type: 'malformed' };
}

export class MistralRealtimeTranscriptionConnection {
  readonly providerId = 'mistral' as const;
  readonly providerSessionId: string;
  private readonly eventsQueue = providerEventQueue();
  private sentAudioBytes = 0;
  private sendTail: Promise<void> = Promise.resolve();
  private ended = false;
  private closed = false;
  private providerCloseConfirmed = false;
  private readonly abortListener: (() => void) | null;

  private readonly onMessage = (raw: RawData, isBinary: boolean): void => {
    const event = decodeMistralRealtimeEvent(raw, isBinary);
    if (event.type === 'malformed') {
      this.eventsQueue.fail(new MistralRealtimeError('provider_protocol_error'));
      this.terminateUnexpected();
      return;
    }
    if (event.type === 'provider_error') {
      this.eventsQueue.fail(new MistralRealtimeError('provider_error'));
      this.terminateUnexpected();
      return;
    }
    if (!this.eventsQueue.push(event)) this.terminateUnexpected();
  };
  private readonly onError = (): void => {
    this.eventsQueue.fail(new MistralRealtimeError('provider_error'));
    this.terminateUnexpected();
  };
  private readonly onClose = (code: number): void => {
    this.closed = true;
    this.providerCloseConfirmed = true;
    this.eventsQueue.push({ type: 'socket_closed', code });
    this.cleanupListeners();
  };

  private constructor(
    private readonly socket: MistralSocket,
    private readonly settings: MistralRealtimeTranscriptionSettings,
    providerSessionId: string,
    private readonly signal?: AbortSignal,
  ) {
    this.providerSessionId = providerSessionId;
    this.abortListener = signal
      ? () => {
          this.eventsQueue.fail(new MistralRealtimeError('aborted'));
          this.terminateUnexpected();
        }
      : null;
    if (signal && this.abortListener) signal.addEventListener('abort', this.abortListener, { once: true });
  }

  static async connect(
    settings: MistralRealtimeTranscriptionSettings,
    options: {
      signal?: AbortSignal;
      socketFactory?: MistralRealtimeSocketFactory;
    } = {},
  ): Promise<MistralRealtimeTranscriptionConnection> {
    validateSettings(settings);
    if (options.signal?.aborted) throw new MistralRealtimeError('aborted');
    const url = providerUrl(settings);
    const factory = options.socketFactory
      ?? ((target, clientOptions) => new WebSocket(target, clientOptions) as MistralSocket);
    const socket = factory(url, {
      headers: { authorization: `Bearer ${settings.apiKey}` },
      handshakeTimeout: settings.connectTimeoutMs,
      maxPayload: MAX_PROVIDER_EVENT_BYTES,
      perMessageDeflate: false,
    });

    // Le listener temporaire couvre le handshake. La connexion définitive le remplace une fois
    // request_id validé afin de ne jamais perdre un événement entre session.created et update.
    const queue = providerEventQueue();
    const onMessage = (raw: RawData, isBinary: boolean): void => {
      if (!queue.push(decodeMistralRealtimeEvent(raw, isBinary))) socket.terminate();
    };
    const onError = (): void => queue.fail(new MistralRealtimeError('provider_error'));
    const onClose = (code: number): void => {
      queue.push({ type: 'socket_closed', code });
    };
    socket.on('message', onMessage);
    socket.on('error', onError);
    socket.on('close', onClose);
    try {
      const created = await nextRequired(queue, settings.connectTimeoutMs, options.signal, 'session_created');
      if (created.model !== settings.model) throw new MistralRealtimeError('provider_protocol_error');
      await sendJson(socket, {
        type: 'session.update',
        session: {
          audio_format: { encoding: 'pcm_s16le', sample_rate: 16_000 },
          target_streaming_delay_ms: settings.targetDelayMs,
        },
      });
      const updated = await nextRequired(queue, settings.connectTimeoutMs, options.signal, 'session_updated');
      if (
        updated.requestId !== created.requestId
        || updated.model !== settings.model
        || updated.encoding !== 'pcm_s16le'
        || updated.sampleRate !== 16_000
        || updated.targetDelayMs !== settings.targetDelayMs
      ) throw new MistralRealtimeError('provider_protocol_error');

      const connection = new MistralRealtimeTranscriptionConnection(
        socket,
        settings,
        created.requestId,
        options.signal,
      );
      socket.on('message', connection.onMessage);
      socket.on('error', connection.onError);
      socket.on('close', connection.onClose);
      // Chevauchement volontaire : on arme d'abord le propriétaire définitif puis on retire les
      // listeners de handshake. Un événement ne peut donc pas tomber dans un interstice.
      socket.off('message', onMessage);
      socket.off('error', onError);
      socket.off('close', onClose);
      return connection;
    } catch (error) {
      socket.off('message', onMessage);
      socket.off('error', onError);
      socket.off('close', onClose);
      socket.terminate();
      throw error instanceof MistralRealtimeError
        ? error
        : new MistralRealtimeError('provider_error');
    }
  }

  sendAudio(audioBytes: Uint8Array): Promise<void> {
    if (
      this.closed
      || this.ended
      || audioBytes.byteLength === 0
      || audioBytes.byteLength > MAX_AUDIO_CHUNK_BYTES
      || audioBytes.byteLength % 2 !== 0
    ) return Promise.reject(new MistralRealtimeError('audio_chunk_invalid'));
    const nextTotal = this.sentAudioBytes + audioBytes.byteLength;
    if (nextTotal > this.settings.maxSessionSeconds * PCM_BYTES_PER_SECOND) {
      return Promise.reject(new MistralRealtimeError('audio_budget_exceeded'));
    }
    if (this.socket.bufferedAmount > MAX_PROVIDER_BUFFERED_BYTES) {
      return Promise.reject(new MistralRealtimeError('backpressure'));
    }
    this.sentAudioBytes = nextTotal;
    return this.enqueue({
      type: 'input_audio.append',
      audio: Buffer.from(audioBytes).toString('base64'),
    });
  }

  flushAudio(): Promise<void> {
    if (this.closed || this.ended) return Promise.reject(new MistralRealtimeError('audio_chunk_invalid'));
    return this.enqueue({ type: 'input_audio.flush' });
  }

  endAudio(): Promise<void> {
    if (this.closed || this.ended) return Promise.resolve();
    this.ended = true;
    return this.enqueue({ type: 'input_audio.end' });
  }

  async *events(): AsyncIterable<MistralRealtimeTranscriptionEvent> {
    for (;;) {
      const event = await this.eventsQueue.next(this.settings.maxSessionSeconds * 1_000, this.signal);
      if (event.type === 'transcript_delta') {
        yield event;
        continue;
      }
      if (event.type === 'transcript_segment') {
        yield event;
        continue;
      }
      if (event.type === 'transcript_final') {
        if (event.model !== this.settings.model) {
          this.terminateUnexpected();
          throw new MistralRealtimeError('provider_protocol_error');
        }
        yield {
          type: 'transcript_final',
          text: event.text,
          language: event.language,
          usage: {
            inputAudioSeconds: event.inputAudioSeconds,
            totalTokens: event.totalTokens,
          },
        };
        return;
      }
      if (event.type === 'ignored' || event.type === 'session_updated') continue;
      if (event.type === 'socket_closed') {
        if (this.ended && event.code === 1000) return;
        throw new MistralRealtimeError('provider_closed');
      }
      if (event.type === 'provider_error') throw new MistralRealtimeError('provider_error');
      throw new MistralRealtimeError('provider_protocol_error');
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      this.cleanupListeners();
      if (!this.providerCloseConfirmed) throw new MistralRealtimeError('provider_timeout');
      return;
    }
    this.ended = true;
    if (this.signal && this.abortListener) this.signal.removeEventListener('abort', this.abortListener);
    let settled = false;
    let providerCloseObserved = false;
    let resolveClosed: () => void = () => undefined;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const finalize = (): void => {
      if (settled) return;
      settled = true;
      resolveClosed();
    };
    const confirmProviderClose = (): void => {
      providerCloseObserved = true;
      finalize();
    };
    this.socket.on('close', confirmProviderClose);
    try {
      this.socket.close(1000, 'session_complete');
    } catch {
      this.socket.terminate();
      finalize();
    }
    const timer = setTimeout(finalize, 1_000);
    await closed;
    clearTimeout(timer);
    this.socket.off('close', confirmProviderClose);
    if (!providerCloseObserved) {
      try {
        this.socket.terminate();
      } catch {
        // La terminaison locale reste non confirmée et sera reprise par le reaper durable.
      }
      this.closed = true;
      this.cleanupListeners();
      throw new MistralRealtimeError('provider_timeout');
    }
    this.providerCloseConfirmed = true;
    this.closed = true;
    this.cleanupListeners();
  }

  private enqueue(payload: unknown): Promise<void> {
    const operation = this.sendTail.then(() => sendJson(this.socket, payload));
    this.sendTail = operation.catch(() => undefined);
    return operation;
  }

  private terminateUnexpected(): void {
    if (this.closed) {
      this.cleanupListeners();
      return;
    }
    this.closed = true;
    try {
      this.socket.terminate();
    } catch {
      // Le socket est déjà tombé : l'EventQueue porte l'erreur stable.
    }
    this.cleanupListeners();
  }

  private cleanupListeners(): void {
    if (this.signal && this.abortListener) {
      this.signal.removeEventListener('abort', this.abortListener);
    }
    this.socket.off('message', this.onMessage);
    this.socket.off('error', this.onError);
    this.socket.off('close', this.onClose);
  }
}

async function nextRequired<T extends ProviderEvent['type']>(
  queue: EventQueue<ProviderEvent>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  expected: T,
): Promise<Extract<ProviderEvent, { type: T }>> {
  for (;;) {
    const event = await queue.next(timeoutMs, signal);
    if (event.type === expected) return event as Extract<ProviderEvent, { type: T }>;
    if (event.type === 'ignored') continue;
    if (event.type === 'provider_error') throw new MistralRealtimeError('provider_error');
    if (event.type === 'socket_closed') throw new MistralRealtimeError('provider_closed');
    throw new MistralRealtimeError('provider_protocol_error');
  }
}

function sendJson(socket: MistralSocket, payload: unknown): Promise<void> {
  if (socket.readyState !== WebSocket.OPEN) return Promise.reject(new MistralRealtimeError('provider_closed'));
  const message = JSON.stringify(payload);
  return new Promise<void>((resolve, reject) => {
    socket.send(message, (error) => {
      if (error) reject(new MistralRealtimeError('provider_error'));
      else resolve();
    });
  });
}

function validateSettings(settings: MistralRealtimeTranscriptionSettings): void {
  let url: URL;
  try {
    url = new URL(settings.baseUrl);
  } catch {
    throw new MistralRealtimeError('invalid_configuration');
  }
  if (
    settings.apiKey.trim().length < 1
    || settings.model.trim().length < 1
    || settings.model.length > 100
    || url.protocol !== 'wss:'
    || url.username.length > 0
    || url.password.length > 0
    || url.search.length > 0
    || url.hash.length > 0
    || !Number.isInteger(settings.targetDelayMs)
    || settings.targetDelayMs < 100
    || settings.targetDelayMs > 5_000
    || !Number.isInteger(settings.connectTimeoutMs)
    || settings.connectTimeoutMs < 1_000
    || settings.connectTimeoutMs > 10_000
    || !Number.isInteger(settings.maxSessionSeconds)
    || settings.maxSessionSeconds < 60
    || settings.maxSessionSeconds > 900
  ) throw new MistralRealtimeError('invalid_configuration');
}

function providerUrl(settings: MistralRealtimeTranscriptionSettings): string {
  const url = new URL(settings.baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/v1/audio/transcriptions/realtime`;
  url.search = new URLSearchParams({ model: settings.model }).toString();
  return url.toString();
}
