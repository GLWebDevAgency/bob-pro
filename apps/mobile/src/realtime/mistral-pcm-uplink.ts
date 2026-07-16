export const MISTRAL_PCM_UPLINK_PROTOCOL = 'bob.mistral-pcm.v1' as const;
export const MISTRAL_PCM_UPLINK_VERSION = 1 as const;
export const MISTRAL_PCM_UPLINK_SAMPLE_RATE_HZ = 16_000 as const;

const FRAME_MAGIC = Uint8Array.of(0x42, 0x4f, 0x42, 0x31);
const FRAME_HEADER_BYTES = 16;
const MAX_PCM_CHUNK_BYTES = 16 * 1024;
const MAX_SOCKET_BUFFERED_BYTES = 256 * 1024;
const MAX_SERVER_MESSAGE_BYTES = 20 * 1024;
const TICKET = /^[A-Za-z0-9_-]{43}$/u;
const TENANT = /^[A-Za-z0-9-]{1,64}$/u;
const LANGUAGE = /^[A-Za-z]{2,8}(?:[-_][A-Za-z0-9]{1,8}){0,3}$/u;

export type MistralPcmUplinkState =
  'idle' | 'connecting' | 'ready' | 'ending' | 'closing' | 'closed';
export type MistralPcmUplinkErrorCode =
  | 'invalid_bootstrap'
  | 'socket_unavailable'
  | 'connect_timeout'
  | 'protocol_error'
  | 'backpressure'
  | 'capture_error'
  | 'aborted';

export type MistralPcmUplinkEvent =
  | { readonly type: 'state'; readonly state: MistralPcmUplinkState }
  | { readonly type: 'transcript_delta'; readonly text: string }
  | {
      readonly type: 'transcript_segment';
      readonly text: string;
      readonly startSeconds: number;
      readonly endSeconds: number;
      readonly speakerId: string | null;
    }
  | { readonly type: 'transcript_final'; readonly text: string; readonly language: string | null }
  /** Le provider et le sink Bob ont terminé le tour one-shot, avant fermeture du socket. */
  | { readonly type: 'complete' }
  | { readonly type: 'error'; readonly code: string };

export class MistralPcmUplinkError extends Error {
  constructor(readonly code: MistralPcmUplinkErrorCode) {
    super(code);
    this.name = 'MistralPcmUplinkError';
  }
}

/**
 * Erreur volontairement opaque de la frontière capture : le runtime sait uniquement que
 * l'arrêt physique n'est pas prouvé. Aucun détail natif ou constructeur ne traverse la couche.
 */
export class MistralPcmCaptureStopError extends Error {
  readonly code = 'capture_stop_unconfirmed' as const;

  constructor() {
    super('capture_stop_unconfirmed');
    this.name = 'MistralPcmCaptureStopError';
  }
}

export interface MistralPcmUplinkBootstrap {
  readonly websocketUrl: string;
  /** Localisateur RLS non autorisant, transmis avec le ticket dans la première trame. */
  readonly companyId: string;
  /** Ticket opaque court, consommé dans la première frame et jamais placé dans l'URL. */
  readonly ticket: string;
  readonly protocol: typeof MISTRAL_PCM_UPLINK_PROTOCOL;
  readonly ticketExpiresAt: string;
  readonly hardExpiresAt: string;
  readonly maxAudioBytes: number;
}

export interface MistralPcmCaptureSession {
  stop(): Promise<void>;
}

/**
 * Port natif futur. L'implémentation doit fournir du PCM signé little-endian, mono, 16 kHz.
 * Ce contrat ne prétend pas fournir AEC/NS : ces capacités devront être certifiées par le
 * module audio natif avant d'annoncer un mode full-duplex.
 */
export interface MistralPcmCapturePort {
  start(input: {
    readonly encoding: 'pcm_s16le';
    readonly sampleRateHz: typeof MISTRAL_PCM_UPLINK_SAMPLE_RATE_HZ;
    readonly channels: 1;
    readonly signal: AbortSignal;
    /**
     * `true` signifie que le transport a effectivement accepté la trame. L'adaptateur natif
     * ne doit acquitter sa séquence qu'après ce retour ; `false` impose un arrêt fail-closed.
     */
    readonly onChunk: (pcm: Uint8Array) => boolean;
    readonly onError: () => void;
  }): Promise<MistralPcmCaptureSession>;
}

interface SocketMessageEvent {
  readonly data: unknown;
}

export interface MistralPcmMobileSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  binaryType: string;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: SocketMessageEvent) => void): void;
  addEventListener(type: 'close', listener: () => void): void;
  addEventListener(type: 'error', listener: () => void): void;
  removeEventListener(type: 'open', listener: () => void): void;
  removeEventListener(type: 'message', listener: (event: SocketMessageEvent) => void): void;
  removeEventListener(type: 'close', listener: () => void): void;
  removeEventListener(type: 'error', listener: () => void): void;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
}

export type MistralPcmMobileSocketFactory = (
  url: string,
  protocols: readonly string[],
) => MistralPcmMobileSocket;

export interface MistralPcmUplinkOptions {
  readonly socketFactory: MistralPcmMobileSocketFactory;
  readonly capture: MistralPcmCapturePort;
  readonly connectTimeoutMs?: number;
  readonly now?: () => number;
}

type DecodedServerEvent =
  | { readonly type: 'ready'; readonly hardExpiresAt: string }
  | { readonly type: 'transcript_delta'; readonly sequence: number; readonly text: string }
  | {
      readonly type: 'transcript_segment';
      readonly sequence: number;
      readonly text: string;
      readonly startSeconds: number;
      readonly endSeconds: number;
      readonly speakerId: string | null;
    }
  | {
      readonly type: 'transcript_final';
      readonly sequence: number;
      readonly text: string;
      readonly language: string | null;
    }
  | { readonly type: 'complete'; readonly sequence: number }
  | { readonly type: 'error'; readonly code: string };

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function sequence(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff
    ? value
    : null;
}

function boundedNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 86_400
    ? value
    : null;
}

function decodeServerEvent(raw: unknown): DecodedServerEvent {
  if (
    typeof raw !== 'string' ||
    new TextEncoder().encode(raw).byteLength > MAX_SERVER_MESSAGE_BYTES
  ) {
    throw new MistralPcmUplinkError('protocol_error');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new MistralPcmUplinkError('protocol_error');
  }
  const value = object(decoded);
  if (!value || typeof value.type !== 'string') throw new MistralPcmUplinkError('protocol_error');
  if (value.type === 'ready') {
    const audio = object(value.audio);
    if (
      !exactKeys(value, ['type', 'protocol', 'audio', 'hardExpiresAt']) ||
      value.protocol !== MISTRAL_PCM_UPLINK_PROTOCOL ||
      !audio ||
      !exactKeys(audio, ['encoding', 'sampleRateHz', 'channels', 'maxChunkBytes']) ||
      audio.encoding !== 'pcm_s16le' ||
      audio.sampleRateHz !== MISTRAL_PCM_UPLINK_SAMPLE_RATE_HZ ||
      audio.channels !== 1 ||
      audio.maxChunkBytes !== MAX_PCM_CHUNK_BYTES ||
      typeof value.hardExpiresAt !== 'string' ||
      !Number.isFinite(Date.parse(value.hardExpiresAt))
    )
      throw new MistralPcmUplinkError('protocol_error');
    return { type: 'ready', hardExpiresAt: value.hardExpiresAt };
  }
  if (value.type === 'transcript.delta') {
    const seq = sequence(value.sequence);
    if (
      !exactKeys(value, ['type', 'sequence', 'text']) ||
      seq === null ||
      typeof value.text !== 'string' ||
      value.text.length > 4_000
    )
      throw new MistralPcmUplinkError('protocol_error');
    return { type: 'transcript_delta', sequence: seq, text: value.text };
  }
  if (value.type === 'transcript.segment') {
    const seq = sequence(value.sequence);
    const start = boundedNumber(value.startSeconds);
    const end = boundedNumber(value.endSeconds);
    if (
      !exactKeys(value, ['type', 'sequence', 'text', 'startSeconds', 'endSeconds', 'speakerId']) ||
      seq === null ||
      typeof value.text !== 'string' ||
      value.text.length > 4_000 ||
      start === null ||
      end === null ||
      end < start ||
      (value.speakerId !== null &&
        (typeof value.speakerId !== 'string' || value.speakerId.length > 200))
    )
      throw new MistralPcmUplinkError('protocol_error');
    return {
      type: 'transcript_segment',
      sequence: seq,
      text: value.text,
      startSeconds: start,
      endSeconds: end,
      speakerId: typeof value.speakerId === 'string' ? value.speakerId : null,
    };
  }
  if (value.type === 'transcript.final') {
    const seq = sequence(value.sequence);
    if (
      !exactKeys(value, ['type', 'sequence', 'text', 'language']) ||
      seq === null ||
      typeof value.text !== 'string' ||
      value.text.length > 16_000 ||
      (value.language !== null &&
        (typeof value.language !== 'string' || !LANGUAGE.test(value.language)))
    )
      throw new MistralPcmUplinkError('protocol_error');
    return {
      type: 'transcript_final',
      sequence: seq,
      text: value.text,
      language: typeof value.language === 'string' ? value.language : null,
    };
  }
  if (value.type === 'complete') {
    const seq = sequence(value.sequence);
    if (!exactKeys(value, ['type', 'sequence']) || seq === null) {
      throw new MistralPcmUplinkError('protocol_error');
    }
    return { type: 'complete', sequence: seq };
  }
  if (value.type === 'error') {
    if (
      !exactKeys(value, ['type', 'code']) ||
      typeof value.code !== 'string' ||
      !/^[a-z_]{1,64}$/u.test(value.code)
    )
      throw new MistralPcmUplinkError('protocol_error');
    return { type: 'error', code: value.code };
  }
  throw new MistralPcmUplinkError('protocol_error');
}

function frameKindCode(kind: 'audio' | 'flush' | 'end'): number {
  if (kind === 'audio') return 1;
  if (kind === 'flush') return 2;
  return 3;
}

export function encodeMistralPcmUplinkFrame(input: {
  readonly kind: 'audio' | 'flush' | 'end';
  readonly sequence: number;
  readonly pcm?: Uint8Array;
}): ArrayBuffer {
  const pcm = input.pcm ?? new Uint8Array();
  if (
    !Number.isInteger(input.sequence) ||
    input.sequence < 0 ||
    input.sequence > 0xffff_ffff ||
    (input.kind === 'audio' &&
      (pcm.byteLength === 0 || pcm.byteLength > MAX_PCM_CHUNK_BYTES || pcm.byteLength % 2 !== 0)) ||
    (input.kind !== 'audio' && pcm.byteLength !== 0)
  )
    throw new MistralPcmUplinkError('protocol_error');
  const bytes = new Uint8Array(FRAME_HEADER_BYTES + pcm.byteLength);
  bytes.set(FRAME_MAGIC, 0);
  const view = new DataView(bytes.buffer);
  view.setUint8(4, MISTRAL_PCM_UPLINK_VERSION);
  view.setUint8(5, frameKindCode(input.kind));
  view.setUint16(6, 0, false);
  view.setUint32(8, input.sequence, false);
  view.setUint32(12, pcm.byteLength, false);
  bytes.set(pcm, FRAME_HEADER_BYTES);
  return bytes.buffer;
}

function validateBootstrap(
  input: MistralPcmUplinkBootstrap,
  now: number,
): {
  readonly url: URL;
  readonly ticketExpiresAtMs: number;
} {
  let url: URL;
  try {
    url = new URL(input.websocketUrl);
  } catch {
    throw new MistralPcmUplinkError('invalid_bootstrap');
  }
  const developmentWs =
    url.protocol === 'ws:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
  const hardExpiry = Date.parse(input.hardExpiresAt);
  const ticketExpiry = Date.parse(input.ticketExpiresAt);
  if (
    (url.protocol !== 'wss:' && !developmentWs) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    input.protocol !== MISTRAL_PCM_UPLINK_PROTOCOL ||
    !TENANT.test(input.companyId) ||
    !TICKET.test(input.ticket) ||
    !Number.isFinite(ticketExpiry) ||
    new Date(ticketExpiry).toISOString() !== input.ticketExpiresAt ||
    ticketExpiry <= now ||
    !Number.isFinite(hardExpiry) ||
    new Date(hardExpiry).toISOString() !== input.hardExpiresAt ||
    hardExpiry <= now ||
    hardExpiry > now + 900_000 ||
    ticketExpiry > hardExpiry ||
    !Number.isSafeInteger(input.maxAudioBytes) ||
    input.maxAudioBytes < 32_000 ||
    input.maxAudioBytes > 28_800_000 ||
    input.maxAudioBytes % 2 !== 0
  )
    throw new MistralPcmUplinkError('invalid_bootstrap');
  return { url, ticketExpiresAtMs: ticketExpiry };
}

export class MistralPcmUplink {
  /** Le downlink provider est explicitement absent : seule la livraison audio auditée Bob est autorisée. */
  readonly capabilities = {
    microphoneUplink: true,
    providerAudioDownlink: false,
    fullDuplex: false,
  } as const;
  private currentState: MistralPcmUplinkState = 'idle';
  private readonly listeners = new Set<(event: MistralPcmUplinkEvent) => void>();
  private socket: MistralPcmMobileSocket | null = null;
  private captureSession: MistralPcmCaptureSession | null = null;
  private captureStartTask: Promise<void> | null = null;
  private captureStopTask: Promise<void> | null = null;
  private captureStopUnconfirmed = false;
  private closeTask: Promise<void> | null = null;
  private lifecycle: AbortController | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private nextFrameSequence = 0;
  private sentAudioBytes = 0;
  private currentMaxAudioBytes = 0;
  private nextServerSequence = 0;
  private generation = 0;
  private captureGeneration = 0;
  private inputEnded = false;
  private pendingReady: { resolve(): void; reject(error: Error): void } | null = null;
  private externalSignal: AbortSignal | null = null;
  private externalAbort: (() => void) | null = null;
  private expectedHardExpiresAt: string | null = null;
  private lastFailure: MistralPcmUplinkError | null = null;
  private socketBinding: {
    readonly socket: MistralPcmMobileSocket;
    readonly generation: number;
    readonly onOpen: () => void;
    readonly onMessage: (event: SocketMessageEvent) => void;
    readonly onClose: () => void;
    readonly onError: () => void;
  } | null = null;

  constructor(private readonly options: MistralPcmUplinkOptions) {}

  get state(): MistralPcmUplinkState {
    return this.currentState;
  }

  subscribe(listener: (event: MistralPcmUplinkEvent) => void): () => void {
    this.listeners.add(listener);
    this.safeNotify(listener, { type: 'state', state: this.currentState });
    return () => this.listeners.delete(listener);
  }

  async connect(
    bootstrap: MistralPcmUplinkBootstrap,
    input: { readonly signal?: AbortSignal } = {},
  ): Promise<void> {
    if (this.closeTask) {
      try {
        await this.closeTask;
      } catch {
        throw new MistralPcmUplinkError('capture_error');
      }
    }
    if (this.captureStopUnconfirmed || this.captureSession || this.captureStopTask) {
      throw new MistralPcmUplinkError('capture_error');
    }
    if (this.currentState !== 'idle' && this.currentState !== 'closed') {
      throw new MistralPcmUplinkError('socket_unavailable');
    }
    if (input.signal?.aborted) throw new MistralPcmUplinkError('aborted');
    const now = this.options.now ?? Date.now;
    const validated = validateBootstrap(bootstrap, now());
    const connectTimeoutMs = this.options.connectTimeoutMs ?? 10_000;
    if (
      !Number.isInteger(connectTimeoutMs) ||
      connectTimeoutMs < 1_000 ||
      connectTimeoutMs > 30_000
    ) {
      throw new MistralPcmUplinkError('invalid_bootstrap');
    }
    const generation = ++this.generation;
    const lifecycle = new AbortController();
    this.lifecycle = lifecycle;
    this.nextFrameSequence = 0;
    this.sentAudioBytes = 0;
    this.currentMaxAudioBytes = bootstrap.maxAudioBytes;
    this.nextServerSequence = 0;
    this.inputEnded = false;
    this.captureGeneration += 1;
    this.captureStartTask = null;
    this.lastFailure = null;
    this.expectedHardExpiresAt = bootstrap.hardExpiresAt;
    this.transition('connecting');
    this.externalSignal = input.signal ?? null;
    this.externalAbort = () => this.fail(new MistralPcmUplinkError('aborted'));
    input.signal?.addEventListener('abort', this.externalAbort, { once: true });

    let socket: MistralPcmMobileSocket;
    try {
      socket = this.options.socketFactory(validated.url.toString(), [MISTRAL_PCM_UPLINK_PROTOCOL]);
    } catch {
      this.cleanup();
      this.transition('closed');
      throw new MistralPcmUplinkError('socket_unavailable');
    }
    this.socket = socket;
    socket.binaryType = 'arraybuffer';
    const binding = {
      socket,
      generation,
      onOpen: () => undefined,
      onMessage: (event: SocketMessageEvent) => {
        if (this.isCurrentSocket(socket, generation)) this.handleMessage(event, generation);
      },
      onClose: () => {
        if (this.isCurrentSocket(socket, generation) && this.currentState !== 'closed') {
          this.fail(new MistralPcmUplinkError('socket_unavailable'), undefined, generation);
        }
      },
      onError: () => {
        if (this.isCurrentSocket(socket, generation)) {
          this.fail(new MistralPcmUplinkError('socket_unavailable'), undefined, generation);
        }
      },
    };
    this.socketBinding = binding;
    socket.addEventListener('open', binding.onOpen);
    socket.addEventListener('message', binding.onMessage);
    socket.addEventListener('close', binding.onClose);
    socket.addEventListener('error', binding.onError);

    const ready = new Promise<void>((resolve, reject) => {
      this.pendingReady = { resolve, reject };
    });
    // Le socket peut tomber avant `open`; ce handler empêche alors une rejection non observée
    // tout en conservant la rejection du Promise original lorsque connect l'attendra.
    void ready.catch(() => undefined);
    this.connectTimer = setTimeout(
      () => this.fail(new MistralPcmUplinkError('connect_timeout'), undefined, generation),
      connectTimeoutMs,
    );
    try {
      await this.waitForOpen(
        socket,
        generation,
        lifecycle.signal,
        Math.max(1, Math.min(connectTimeoutMs, validated.ticketExpiresAtMs - now())),
      );
      if (generation !== this.generation || lifecycle.signal.aborted)
        throw new MistralPcmUplinkError('aborted');
      if (now() >= validated.ticketExpiresAtMs) throw new MistralPcmUplinkError('connect_timeout');
      let ticket = bootstrap.ticket;
      socket.send(
        JSON.stringify({
          type: 'authenticate',
          protocol: MISTRAL_PCM_UPLINK_PROTOCOL,
          companyId: bootstrap.companyId,
          ticket,
        }),
      );
      ticket = '';
      await ready;
      if (generation !== this.generation || lifecycle.signal.aborted)
        throw new MistralPcmUplinkError('aborted');
    } catch (error) {
      const safe =
        this.lastFailure ??
        (error instanceof MistralPcmUplinkError
          ? error
          : new MistralPcmUplinkError('socket_unavailable'));
      this.fail(safe);
      throw safe;
    }
  }

  /**
   * Ouvre le micro explicitement, après que l'appelant a validé le fence de contexte du
   * bootstrap. `connect()` n'ouvre jamais la capture tout seul.
   */
  startCapture(): Promise<void> {
    if (this.currentState !== 'ready' || this.inputEnded || !this.lifecycle) {
      return Promise.reject(new MistralPcmUplinkError('capture_error'));
    }
    if (this.captureStopUnconfirmed || this.captureStopTask) {
      return Promise.reject(new MistralPcmUplinkError('capture_error'));
    }
    if (this.captureSession) return Promise.resolve();
    if (this.captureStartTask) return this.captureStartTask;
    const generation = this.generation;
    const captureGeneration = ++this.captureGeneration;
    const lifecycle = this.lifecycle;
    const task = (async (): Promise<void> => {
      let capture: MistralPcmCaptureSession;
      try {
        capture = await this.options.capture.start({
          encoding: 'pcm_s16le',
          sampleRateHz: MISTRAL_PCM_UPLINK_SAMPLE_RATE_HZ,
          channels: 1,
          signal: lifecycle.signal,
          onChunk: (pcm) =>
            generation === this.generation && captureGeneration === this.captureGeneration
              ? this.pushPcm(pcm)
              : false,
          onError: () => {
            if (generation === this.generation && captureGeneration === this.captureGeneration) {
              this.fail(new MistralPcmUplinkError('capture_error'), undefined, generation);
            }
          },
        });
      } catch (cause) {
        if (cause instanceof MistralPcmCaptureStopError) {
          this.captureStopUnconfirmed = true;
        }
        const current =
          generation === this.generation &&
          captureGeneration === this.captureGeneration &&
          !lifecycle.signal.aborted;
        const error = new MistralPcmUplinkError(current ? 'capture_error' : 'aborted');
        if (current) this.fail(error, undefined, generation);
        throw error;
      }
      if (
        generation !== this.generation ||
        captureGeneration !== this.captureGeneration ||
        lifecycle.signal.aborted ||
        this.currentState !== 'ready' ||
        this.inputEnded
      ) {
        this.captureSession = capture;
        await this.stopCurrentCapture();
        throw new MistralPcmUplinkError('aborted');
      }
      this.captureSession = capture;
    })();
    this.captureStartTask = task;
    void task
      .finally(() => {
        if (this.captureStartTask === task) this.captureStartTask = null;
      })
      .catch(() => undefined);
    return task;
  }

  /** Coupe uniquement la capture montante. Le socket et le feed audite restent ouverts. */
  async stopCapture(): Promise<void> {
    this.captureGeneration += 1;
    try {
      await this.captureStartTask;
    } catch {
      if (this.captureStopUnconfirmed) throw new MistralPcmUplinkError('capture_error');
    }
    await this.stopCurrentCapture();
  }

  flush(): boolean {
    return this.sendFrame('flush');
  }

  async finishInput(): Promise<void> {
    if (this.currentState !== 'ready' || this.inputEnded) return;
    this.inputEnded = true;
    await this.stopCapture();
    if (this.state === 'closed') return;
    this.transition('ending');
    if (!this.sendFrame('flush') || !this.sendFrame('end')) {
      this.fail(new MistralPcmUplinkError('socket_unavailable'));
    }
  }

  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    if (
      this.currentState === 'closed' &&
      !this.captureSession &&
      !this.captureStopTask &&
      !this.captureStopUnconfirmed
    )
      return Promise.resolve();

    ++this.generation;
    this.captureGeneration += 1;
    const captureStartTask = this.captureStartTask;
    const lifecycle = this.lifecycle;
    const socket = this.socket;
    this.cleanup();
    lifecycle?.abort();
    try {
      socket?.close(1000, 'client_close');
    } catch {
      // Le runtime WebSocket est déjà tombé.
    }
    this.transition('closing');
    return this.scheduleCaptureShutdown(captureStartTask);
  }

  private handleMessage(message: SocketMessageEvent, generation: number): void {
    if (!this.isCurrentSocket(this.socket, generation)) return;
    try {
      const event = decodeServerEvent(message.data);
      if (event.type === 'ready') {
        if (this.currentState !== 'connecting') throw new MistralPcmUplinkError('protocol_error');
        const hardExpiry = Date.parse(event.hardExpiresAt);
        if (
          event.hardExpiresAt !== this.expectedHardExpiresAt ||
          !Number.isFinite(hardExpiry) ||
          hardExpiry <= (this.options.now ?? Date.now)()
        ) {
          throw new MistralPcmUplinkError('protocol_error');
        }
        if (this.connectTimer) clearTimeout(this.connectTimer);
        this.connectTimer = null;
        this.expiryTimer = setTimeout(
          () => this.fail(new MistralPcmUplinkError('aborted'), undefined, generation),
          hardExpiry - (this.options.now ?? Date.now)(),
        );
        this.transition('ready');
        this.pendingReady?.resolve();
        this.pendingReady = null;
        return;
      }
      if (event.type === 'error') {
        this.fail(new MistralPcmUplinkError('socket_unavailable'), event.code, generation);
        return;
      }
      if (this.currentState !== 'ready' && this.currentState !== 'ending') {
        throw new MistralPcmUplinkError('protocol_error');
      }
      if (event.sequence !== this.nextServerSequence)
        throw new MistralPcmUplinkError('protocol_error');
      this.nextServerSequence += 1;
      if (event.type === 'transcript_delta') {
        this.emit({ type: 'transcript_delta', text: event.text });
      } else if (event.type === 'transcript_segment') {
        this.emit({
          type: 'transcript_segment',
          text: event.text,
          startSeconds: event.startSeconds,
          endSeconds: event.endSeconds,
          speakerId: event.speakerId,
        });
      } else if (event.type === 'transcript_final') {
        this.emit({ type: 'transcript_final', text: event.text, language: event.language });
      } else {
        this.emit({ type: 'complete' });
        void this.close().catch(() => undefined);
      }
    } catch (error) {
      this.fail(
        error instanceof MistralPcmUplinkError
          ? error
          : new MistralPcmUplinkError('protocol_error'),
        undefined,
        generation,
      );
    }
  }

  private pushPcm(pcm: Uint8Array): boolean {
    if (this.currentState !== 'ready' || this.inputEnded) return false;
    if (
      !(pcm instanceof Uint8Array) ||
      pcm.byteLength === 0 ||
      pcm.byteLength > MAX_PCM_CHUNK_BYTES ||
      pcm.byteLength % 2 !== 0
    ) {
      this.fail(new MistralPcmUplinkError('capture_error'));
      return false;
    }
    return this.sendFrame('audio', pcm);
  }

  private sendFrame(kind: 'audio' | 'flush' | 'end', pcm?: Uint8Array): boolean {
    const socket = this.socket;
    if (
      !socket ||
      socket.readyState !== 1 ||
      (this.currentState !== 'ready' && this.currentState !== 'ending')
    )
      return false;
    if (this.nextFrameSequence > 0xffff_ffff) {
      this.fail(new MistralPcmUplinkError('protocol_error'));
      return false;
    }
    try {
      const frame = encodeMistralPcmUplinkFrame({
        kind,
        sequence: this.nextFrameSequence,
        ...(pcm ? { pcm } : {}),
      });
      if (socket.bufferedAmount + frame.byteLength > MAX_SOCKET_BUFFERED_BYTES) {
        this.fail(new MistralPcmUplinkError('backpressure'));
        return false;
      }
      if (kind === 'audio') {
        const nextAudioBytes = this.sentAudioBytes + (pcm?.byteLength ?? 0);
        if (nextAudioBytes > this.currentMaxAudioBytes) {
          this.fail(new MistralPcmUplinkError('backpressure'));
          return false;
        }
        this.sentAudioBytes = nextAudioBytes;
      }
      socket.send(frame);
      this.nextFrameSequence += 1;
      return true;
    } catch {
      this.fail(new MistralPcmUplinkError('socket_unavailable'));
      return false;
    }
  }

  private waitForOpen(
    socket: MistralPcmMobileSocket,
    generation: number,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<void> {
    if (socket.readyState === 1 && this.isCurrentSocket(socket, generation))
      return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        socket.removeEventListener('open', onOpen);
        if (error) reject(error);
        else resolve();
      };
      const onOpen = (): void => {
        if (!this.isCurrentSocket(socket, generation)) {
          finish(new MistralPcmUplinkError('aborted'));
          return;
        }
        finish();
      };
      const onAbort = (): void => finish(new MistralPcmUplinkError('aborted'));
      const timer = setTimeout(
        () => finish(new MistralPcmUplinkError('connect_timeout')),
        timeoutMs,
      );
      signal.addEventListener('abort', onAbort, { once: true });
      socket.addEventListener('open', onOpen);
    });
  }

  private fail(
    error: MistralPcmUplinkError,
    publicCode: string = error.code,
    expectedGeneration: number = this.generation,
  ): void {
    if (
      expectedGeneration !== this.generation ||
      this.currentState === 'closed' ||
      this.currentState === 'closing'
    )
      return;
    this.lastFailure = error;
    ++this.generation;
    this.captureGeneration += 1;
    const captureStartTask = this.captureStartTask;
    const lifecycle = this.lifecycle;
    const socket = this.socket;
    this.cleanup();
    lifecycle?.abort();
    this.pendingReady?.reject(error);
    this.pendingReady = null;
    try {
      socket?.close(1000, 'session_closed');
    } catch {
      // Le runtime WebSocket est déjà tombé.
    }
    this.transition('closing');
    // Publier le Promise de fermeture avant l'erreur empêche un orchestrateur réentrant de
    // prendre le fallback entre le signal de panne et la preuve d'arrêt du micro.
    const shutdown = this.scheduleCaptureShutdown(captureStartTask);
    void shutdown.catch(() => undefined);
    this.emit({ type: 'error', code: publicCode });
  }

  private stopCurrentCapture(): Promise<void> {
    if (this.captureStopUnconfirmed) {
      return Promise.reject(new MistralPcmUplinkError('capture_error'));
    }
    if (this.captureStopTask) return this.captureStopTask;
    const capture = this.captureSession;
    if (!capture) return Promise.resolve();

    const task = Promise.resolve()
      .then(() => capture.stop())
      .then(
        () => {
          if (this.captureSession === capture) this.captureSession = null;
          if (this.captureStopTask === task) this.captureStopTask = null;
        },
        () => {
          this.captureStopUnconfirmed = true;
          throw new MistralPcmUplinkError('capture_error');
        },
      );
    this.captureStopTask = task;
    // Chaque appelant reçoit bien la rejection ; ce handler évite seulement une rejection non
    // observée quand l'arrêt a été initié par un callback natif/sockette synchrone.
    void task.catch(() => undefined);
    return task;
  }

  private scheduleCaptureShutdown(captureStartTask: Promise<void> | null): Promise<void> {
    if (this.closeTask) return this.closeTask;
    const task = Promise.resolve().then(async (): Promise<void> => {
      try {
        await captureStartTask;
      } catch {
        if (this.captureStopUnconfirmed) {
          throw new MistralPcmUplinkError('capture_error');
        }
      }
      await this.stopCurrentCapture();
      if (this.captureStopUnconfirmed) {
        throw new MistralPcmUplinkError('capture_error');
      }
      this.transition('closed');
    });
    this.closeTask = task;
    void task
      .finally(() => {
        if (this.closeTask === task) this.closeTask = null;
      })
      .catch(() => undefined);
    return task;
  }

  private cleanup(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.connectTimer = null;
    this.expiryTimer = null;
    if (this.externalSignal && this.externalAbort) {
      this.externalSignal.removeEventListener('abort', this.externalAbort);
    }
    this.externalSignal = null;
    this.externalAbort = null;
    const binding = this.socketBinding;
    if (binding) {
      binding.socket.removeEventListener('open', binding.onOpen);
      binding.socket.removeEventListener('message', binding.onMessage);
      binding.socket.removeEventListener('close', binding.onClose);
      binding.socket.removeEventListener('error', binding.onError);
    }
    this.socketBinding = null;
    this.socket = null;
    this.lifecycle = null;
    this.captureStartTask = null;
    this.expectedHardExpiresAt = null;
    this.currentMaxAudioBytes = 0;
  }

  private isCurrentSocket(
    socket: MistralPcmMobileSocket | null,
    generation: number,
  ): socket is MistralPcmMobileSocket {
    return (
      socket !== null &&
      generation === this.generation &&
      this.socket === socket &&
      this.socketBinding?.socket === socket &&
      this.socketBinding.generation === generation
    );
  }

  private transition(state: MistralPcmUplinkState): void {
    if (this.currentState === state) return;
    this.currentState = state;
    this.emit({ type: 'state', state });
  }

  private emit(event: MistralPcmUplinkEvent): void {
    for (const listener of this.listeners) this.safeNotify(listener, event);
  }

  private safeNotify(
    listener: (event: MistralPcmUplinkEvent) => void,
    event: MistralPcmUplinkEvent,
  ): void {
    try {
      listener(event);
    } catch {
      // Un observateur UI ne peut pas casser la session audio.
    }
  }
}
