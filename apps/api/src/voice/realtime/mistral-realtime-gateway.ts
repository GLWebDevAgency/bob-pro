import type { MistralRealtimeTranscriptionEvent } from './mistral-realtime-transcription';
import type {
  MistralRealtimeConnectionRegistration,
  MistralRealtimeTerminationAuthority,
} from './mistral-realtime-termination';
import type {
  MistralRealtimeIngressGrant,
  MistralRealtimeIngressTicketAuthority,
  MistralRealtimeTicketConsumeResult,
} from './realtime-mistral-ingress-ticket';

export type {
  MistralRealtimeIngressGrant,
  MistralRealtimeIngressTicketAuthority,
  MistralRealtimeTicketConsumeResult,
} from './realtime-mistral-ingress-ticket';

export const MISTRAL_PCM_GATEWAY_PROTOCOL = 'bob.mistral-pcm.v1' as const;
export const MISTRAL_PCM_GATEWAY_VERSION = 1 as const;
export const MISTRAL_PCM_SAMPLE_RATE_HZ = 16_000 as const;
export const MISTRAL_PCM_CHANNELS = 1 as const;

const FRAME_MAGIC = Uint8Array.of(0x42, 0x4f, 0x42, 0x31); // BOB1
const FRAME_HEADER_BYTES = 16;
const MAX_PCM_CHUNK_BYTES = 16 * 1024;
const MAX_QUEUED_INGRESS_BYTES = 128 * 1024;
const MAX_AUTH_MESSAGE_BYTES = 512;
const MAX_SERVER_MESSAGE_BYTES = 20 * 1024;
const MAX_SERVER_BUFFERED_BYTES = 256 * 1024;
const MAX_SESSION_SECONDS = 900;
const DEFAULT_PROVIDER_CLOSE_TIMEOUT_MS = 1_500;
const PCM_BYTES_PER_SECOND = MISTRAL_PCM_SAMPLE_RATE_HZ * MISTRAL_PCM_CHANNELS * 2;
const TICKET = /^[A-Za-z0-9_-]{32,128}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TENANT = /^[A-Za-z0-9-]{1,64}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const PLANS = new Set(['free', 'solo', 'pro', 'business']);

export type MistralPcmFrameKind = 'audio' | 'flush' | 'end';

export interface MistralPcmFrame {
  readonly kind: MistralPcmFrameKind;
  readonly sequence: number;
  readonly pcm: Uint8Array;
}

export type MistralGatewayErrorCode =
  | 'auth_timeout'
  | 'auth_failed'
  | 'service_unavailable'
  | 'protocol_error'
  | 'sequence_error'
  | 'audio_budget_exceeded'
  | 'backpressure'
  | 'aborted'
  | 'provider_error'
  | 'sink_error';

export class MistralRealtimeGatewayError extends Error {
  constructor(readonly code: MistralGatewayErrorCode) {
    super(code);
    this.name = 'MistralRealtimeGatewayError';
  }
}

export interface MistralRealtimeGatewayProviderConnection {
  readonly providerSessionId: string;
  sendAudio(pcm: Uint8Array): Promise<void>;
  flushAudio(): Promise<void>;
  endAudio(): Promise<void>;
  events(): AsyncIterable<MistralRealtimeTranscriptionEvent>;
  close(): Promise<void>;
}

/** La clé Mistral reste encapsulée dans l'implémentation serveur de ce port. */
export interface MistralRealtimeGatewayProvider {
  connect(input: {
    readonly maxSessionSeconds: number;
    readonly signal: AbortSignal;
  }): Promise<MistralRealtimeGatewayProviderConnection>;
}

interface MistralRealtimeTranscriptionSinkIdentity {
  /** Identité one-shot serveur ; aucune de ces valeurs ne doit être sérialisée au socket. */
  readonly redemptionId: string;
  readonly companyId: string;
  readonly userId: string;
  readonly subjectHash: string;
  readonly subjectKeyVersion: number;
  readonly plan: MistralRealtimeIngressGrant['plan'];
  readonly sessionId: string;
  readonly contextRevision: number;
  readonly contextDigest: string;
  readonly signal: AbortSignal;
}

export type MistralRealtimeTranscriptionSinkInput = MistralRealtimeTranscriptionSinkIdentity & (
  | {
      readonly event: Extract<MistralRealtimeTranscriptionEvent, { readonly type: 'transcript_final' }>;
      /** Horodatage UTC canonique figé une seule fois à l'observation de l'événement provider. */
      readonly occurredAt: string;
    }
  | {
      readonly event: Exclude<MistralRealtimeTranscriptionEvent, { readonly type: 'transcript_final' }>;
      readonly occurredAt?: never;
    }
);

export interface MistralRealtimeTranscriptionSink {
  publish(input: MistralRealtimeTranscriptionSinkInput): Promise<void>;
}

type GatewaySocketData = string | Uint8Array | ArrayBuffer;

export interface MistralRealtimeGatewaySocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  on(event: 'message', listener: (data: GatewaySocketData, isBinary: boolean) => void): this;
  on(event: 'close', listener: (code: number) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  off(event: 'message', listener: (data: GatewaySocketData, isBinary: boolean) => void): this;
  off(event: 'close', listener: (code: number) => void): this;
  off(event: 'error', listener: (error: Error) => void): this;
  send(data: string, callback?: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

export interface MistralRealtimeGatewayDependencies {
  readonly tickets: MistralRealtimeIngressTicketAuthority;
  readonly provider: MistralRealtimeGatewayProvider;
  /** Même instance process-locale que celle enregistrée dans le termination registry. */
  readonly terminations: MistralRealtimeTerminationAuthority;
  readonly sink: MistralRealtimeTranscriptionSink;
  readonly now?: () => number;
  readonly authTimeoutMs?: number;
  readonly providerCloseTimeoutMs?: number;
}

interface QueuedMessage {
  readonly data: GatewaySocketData;
  readonly isBinary: boolean;
  readonly size: number;
}

interface QueueWaiter {
  resolve(value: QueuedMessage): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout> | null;
  signal: AbortSignal | null;
  onAbort: (() => void) | null;
}

class BoundedIngressQueue {
  private readonly values: QueuedMessage[] = [];
  private readonly waiters: QueueWaiter[] = [];
  private queuedBytes = 0;
  private failure: Error | null = null;

  get count(): number {
    return this.values.length;
  }

  push(message: QueuedMessage): boolean {
    if (this.failure) return false;
    const waiter = this.waiters.shift();
    if (waiter) {
      this.cleanup(waiter);
      waiter.resolve(message);
      return true;
    }
    if (this.queuedBytes + message.size > MAX_QUEUED_INGRESS_BYTES) return false;
    this.values.push(message);
    this.queuedBytes += message.size;
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

  next(input: { signal: AbortSignal; timeoutMs?: number }): Promise<QueuedMessage> {
    if (input.signal.aborted) return Promise.reject(new MistralRealtimeGatewayError('aborted'));
    const value = this.values.shift();
    if (value) {
      this.queuedBytes -= value.size;
      return Promise.resolve(value);
    }
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<QueuedMessage>((resolve, reject) => {
      const waiter: QueueWaiter = {
        resolve,
        reject,
        timer: null,
        signal: input.signal,
        onAbort: null,
      };
      if (input.timeoutMs !== undefined) {
        waiter.timer = setTimeout(() => {
          this.remove(waiter);
          reject(new MistralRealtimeGatewayError('auth_timeout'));
        }, input.timeoutMs);
      }
      waiter.onAbort = () => {
        this.remove(waiter);
        reject(new MistralRealtimeGatewayError('aborted'));
      };
      input.signal.addEventListener('abort', waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private remove(waiter: QueueWaiter): void {
    const index = this.waiters.indexOf(waiter);
    if (index >= 0) this.waiters.splice(index, 1);
    this.cleanup(waiter);
  }

  private cleanup(waiter: QueueWaiter): void {
    if (waiter.timer) clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
    waiter.timer = null;
    waiter.signal = null;
    waiter.onAbort = null;
  }
}

function asBytes(data: GatewaySocketData): Uint8Array {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function messageSize(data: GatewaySocketData): number {
  return typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : asBytes(data).byteLength;
}

function frameKind(code: number): MistralPcmFrameKind | null {
  if (code === 1) return 'audio';
  if (code === 2) return 'flush';
  if (code === 3) return 'end';
  return null;
}

function frameKindCode(kind: MistralPcmFrameKind): number {
  if (kind === 'audio') return 1;
  if (kind === 'flush') return 2;
  return 3;
}

export function encodeMistralPcmGatewayFrame(input: {
  readonly kind: MistralPcmFrameKind;
  readonly sequence: number;
  readonly pcm?: Uint8Array;
}): Uint8Array {
  const pcm = input.pcm ?? new Uint8Array();
  if (
    !Number.isInteger(input.sequence)
    || input.sequence < 0
    || input.sequence > 0xffff_ffff
    || (input.kind === 'audio' && (pcm.byteLength === 0 || pcm.byteLength > MAX_PCM_CHUNK_BYTES || pcm.byteLength % 2 !== 0))
    || (input.kind !== 'audio' && pcm.byteLength !== 0)
  ) throw new MistralRealtimeGatewayError('protocol_error');
  const bytes = new Uint8Array(FRAME_HEADER_BYTES + pcm.byteLength);
  bytes.set(FRAME_MAGIC, 0);
  const view = new DataView(bytes.buffer);
  view.setUint8(4, MISTRAL_PCM_GATEWAY_VERSION);
  view.setUint8(5, frameKindCode(input.kind));
  view.setUint16(6, 0, false);
  view.setUint32(8, input.sequence, false);
  view.setUint32(12, pcm.byteLength, false);
  bytes.set(pcm, FRAME_HEADER_BYTES);
  return bytes;
}

export function decodeMistralPcmGatewayFrame(data: GatewaySocketData): MistralPcmFrame {
  const bytes = asBytes(data);
  if (bytes.byteLength < FRAME_HEADER_BYTES || bytes.byteLength > FRAME_HEADER_BYTES + MAX_PCM_CHUNK_BYTES) {
    throw new MistralRealtimeGatewayError('protocol_error');
  }
  for (let index = 0; index < FRAME_MAGIC.byteLength; index += 1) {
    if (bytes[index] !== FRAME_MAGIC[index]) throw new MistralRealtimeGatewayError('protocol_error');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kind = frameKind(view.getUint8(5));
  const payloadBytes = view.getUint32(12, false);
  if (
    view.getUint8(4) !== MISTRAL_PCM_GATEWAY_VERSION
    || kind === null
    || view.getUint16(6, false) !== 0
    || payloadBytes !== bytes.byteLength - FRAME_HEADER_BYTES
    || (kind === 'audio' && (payloadBytes === 0 || payloadBytes % 2 !== 0))
    || (kind !== 'audio' && payloadBytes !== 0)
  ) throw new MistralRealtimeGatewayError('protocol_error');
  return {
    kind,
    sequence: view.getUint32(8, false),
    pcm: Uint8Array.from(bytes.subarray(FRAME_HEADER_BYTES)),
  };
}

interface AuthMessage {
  type: 'authenticate';
  protocol: typeof MISTRAL_PCM_GATEWAY_PROTOCOL;
  companyId: string;
  ticket: string;
}

function decodeAuth(message: QueuedMessage): AuthMessage {
  if (message.isBinary || message.size === 0 || message.size > MAX_AUTH_MESSAGE_BYTES) {
    throw new MistralRealtimeGatewayError('auth_failed');
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(asBytes(message.data)));
  } catch {
    throw new MistralRealtimeGatewayError('auth_failed');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new MistralRealtimeGatewayError('auth_failed');
  }
  const payload = value as Record<string, unknown>;
  if (
    Object.keys(payload).length !== 4
    || payload.type !== 'authenticate'
    || payload.protocol !== MISTRAL_PCM_GATEWAY_PROTOCOL
    || typeof payload.companyId !== 'string'
    || !TENANT.test(payload.companyId)
    || typeof payload.ticket !== 'string'
    || !TICKET.test(payload.ticket)
  ) throw new MistralRealtimeGatewayError('auth_failed');
  return {
    type: 'authenticate',
    protocol: MISTRAL_PCM_GATEWAY_PROTOCOL,
    companyId: payload.companyId,
    ticket: payload.ticket,
  };
}

function validateGrant(grant: MistralRealtimeIngressGrant, now: number): number {
  const hardExpiry = Date.parse(grant.hardExpiresAt);
  if (
    !UUID.test(grant.redemptionId)
    || !TENANT.test(grant.companyId)
    || typeof grant.userId !== 'string'
    || grant.userId.length < 1
    || grant.userId.length > 256
    || Buffer.byteLength(grant.userId, 'utf8') > 512
    // eslint-disable-next-line no-control-regex
    || /[\u0000-\u001f\u007f]/u.test(grant.userId)
    || !DIGEST.test(grant.subjectHash)
    || !Number.isSafeInteger(grant.subjectKeyVersion)
    || grant.subjectKeyVersion < 1
    || grant.subjectKeyVersion > 2_147_483_647
    || !PLANS.has(grant.plan)
    || !UUID.test(grant.sessionId)
    || !Number.isInteger(grant.contextRevision)
    || grant.contextRevision < 1
    || grant.contextRevision > 2_147_483_647
    || !DIGEST.test(grant.contextDigest)
    || !Number.isFinite(hardExpiry)
    || new Date(hardExpiry).toISOString() !== grant.hardExpiresAt
    || hardExpiry <= now
    || hardExpiry > now + MAX_SESSION_SECONDS * 1_000
    || !Number.isInteger(grant.maxAudioBytes)
    || grant.maxAudioBytes < 2
    || grant.maxAudioBytes > MAX_SESSION_SECONDS * PCM_BYTES_PER_SECOND
  ) throw new MistralRealtimeGatewayError('service_unavailable');
  return hardExpiry;
}

function safeSocketError(error: unknown): MistralRealtimeGatewayError {
  if (error instanceof MistralRealtimeGatewayError) return error;
  return new MistralRealtimeGatewayError('provider_error');
}

function socketErrorWireCode(code: MistralGatewayErrorCode): string {
  if (code === 'auth_timeout') return 'authentication_timeout';
  if (code === 'auth_failed') return 'authentication_failed';
  if (code === 'service_unavailable') return 'temporarily_unavailable';
  if (code === 'audio_budget_exceeded') return 'audio_budget_exceeded';
  if (code === 'backpressure') return 'backpressure';
  if (code === 'aborted') return 'session_closed';
  return 'realtime_failed';
}

function socketCloseCode(code: MistralGatewayErrorCode): number {
  if (code === 'auth_timeout') return 4408;
  if (code === 'auth_failed') return 4401;
  if (code === 'service_unavailable') return 1013;
  if (code === 'protocol_error' || code === 'sequence_error' || code === 'audio_budget_exceeded') return 4400;
  return 1011;
}

function sendText(socket: MistralRealtimeGatewaySocket, payload: unknown): Promise<void> {
  if (socket.readyState !== 1) return Promise.reject(new MistralRealtimeGatewayError('aborted'));
  if (socket.bufferedAmount > MAX_SERVER_BUFFERED_BYTES) {
    return Promise.reject(new MistralRealtimeGatewayError('backpressure'));
  }
  const text = JSON.stringify(payload);
  if (Buffer.byteLength(text, 'utf8') > MAX_SERVER_MESSAGE_BYTES) {
    return Promise.reject(new MistralRealtimeGatewayError('protocol_error'));
  }
  return new Promise<void>((resolve, reject) => {
    socket.send(text, (error) => {
      if (error) reject(new MistralRealtimeGatewayError('aborted'));
      else resolve();
    });
  });
}

function canonicalObservedAt(now: () => number): string {
  const epoch = now();
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    throw new MistralRealtimeGatewayError('sink_error');
  }
  try {
    return new Date(epoch).toISOString();
  } catch {
    throw new MistralRealtimeGatewayError('sink_error');
  }
}

async function closeProvider(
  connection: MistralRealtimeGatewayProviderConnection | null,
  registration: MistralRealtimeConnectionRegistration | null,
  timeoutMs: number,
): Promise<'confirmed' | 'not_created' | 'unconfirmed'> {
  if (!connection) return 'not_created';
  let timer: ReturnType<typeof setTimeout> | null = null;
  const close = Promise.resolve().then(() => (
    registration ? registration.close() : connection.close()
  )).then(
    () => 'confirmed' as const,
    () => 'unconfirmed' as const,
  );
  const timeout = new Promise<'unconfirmed'>((resolve) => {
    timer = setTimeout(() => resolve('unconfirmed'), timeoutMs);
  });
  const outcome = await Promise.race([close, timeout]);
  if (timer) clearTimeout(timer);
  return outcome;
}

/**
 * Noyau de session WSS testable, sans attachement HTTP/Nest implicite. L'adapter d'upgrade devra
 * imposer TLS (hors localhost), une allowlist Origin anti-CSWSH, `bob.mistral-pcm.v1`,
 * `perMessageDeflate: false` et une limite de payload à 16 400 octets.
 */
export async function serveMistralRealtimeGateway(
  socket: MistralRealtimeGatewaySocket,
  dependencies: MistralRealtimeGatewayDependencies,
  input: { readonly signal?: AbortSignal } = {},
): Promise<void> {
  const now = dependencies.now ?? Date.now;
  const authTimeoutMs = dependencies.authTimeoutMs ?? 5_000;
  const providerCloseTimeoutMs = dependencies.providerCloseTimeoutMs ?? DEFAULT_PROVIDER_CLOSE_TIMEOUT_MS;
  if (!Number.isInteger(authTimeoutMs) || authTimeoutMs < 1_000 || authTimeoutMs > 10_000) {
    throw new MistralRealtimeGatewayError('service_unavailable');
  }
  if (
    !Number.isInteger(providerCloseTimeoutMs)
    || providerCloseTimeoutMs < 25
    || providerCloseTimeoutMs > 5_000
  ) throw new MistralRealtimeGatewayError('service_unavailable');

  const queue = new BoundedIngressQueue();
  const lifecycle = new AbortController();
  let grant: MistralRealtimeIngressGrant | null = null;
  let connection: MistralRealtimeGatewayProviderConnection | null = null;
  let terminationRegistration: MistralRealtimeConnectionRegistration | null = null;
  let hardExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  let completed = false;
  let providerTermination: 'confirmed' | 'not_created' | 'unconfirmed' | null = null;
  let ingressPhase: 'auth' | 'connecting' | 'ready' | 'ending' | 'closed' = 'auth';
  const abortFromExternal = (): void => lifecycle.abort();
  const onMessage = (data: GatewaySocketData, isBinary: boolean): void => {
    const size = messageSize(data);
    if (ingressPhase === 'connecting' || ingressPhase === 'ending' || ingressPhase === 'closed') {
      queue.fail(new MistralRealtimeGatewayError('protocol_error'));
      lifecycle.abort();
      return;
    }
    if (size > FRAME_HEADER_BYTES + MAX_PCM_CHUNK_BYTES || !queue.push({ data, isBinary, size })) {
      queue.fail(new MistralRealtimeGatewayError('backpressure'));
      lifecycle.abort();
    }
  };
  const onClose = (): void => lifecycle.abort();
  const onError = (): void => lifecycle.abort();

  if (input.signal?.aborted) lifecycle.abort();
  else input.signal?.addEventListener('abort', abortFromExternal, { once: true });
  socket.on('message', onMessage);
  socket.on('close', onClose);
  socket.on('error', onError);

  try {
    const auth = decodeAuth(await queue.next({ signal: lifecycle.signal, timeoutMs: authTimeoutMs }));
    ingressPhase = 'connecting';
    let consumed: MistralRealtimeTicketConsumeResult;
    try {
      consumed = await dependencies.tickets.consume({
        companyId: auth.companyId,
        ticket: auth.ticket,
        protocol: MISTRAL_PCM_GATEWAY_PROTOCOL,
      });
    } catch {
      throw new MistralRealtimeGatewayError('service_unavailable');
    } finally {
      // Le ticket brut ne traverse aucun autre port et n'est jamais inclus dans une erreur/wire event.
      auth.ticket = '';
    }
    if (!consumed.ok) {
      throw new MistralRealtimeGatewayError(
        consumed.reason === 'unavailable' ? 'service_unavailable' : 'auth_failed',
      );
    }
    grant = consumed.grant;
    if (grant.companyId !== auth.companyId) {
      throw new MistralRealtimeGatewayError('service_unavailable');
    }
    const hardExpiry = validateGrant(grant, now());
    const remainingMs = hardExpiry - now();
    if (remainingMs <= 0) throw new MistralRealtimeGatewayError('auth_failed');
    hardExpiryTimer = setTimeout(() => lifecycle.abort(), remainingMs);
    if (queue.count > 0) throw new MistralRealtimeGatewayError('protocol_error');

    connection = await dependencies.provider.connect({
      maxSessionSeconds: Math.max(1, Math.min(MAX_SESSION_SECONDS, Math.ceil(remainingMs / 1_000))),
      signal: lifecycle.signal,
    });
    if (!/^[A-Za-z0-9._:-]{1,200}$/u.test(connection.providerSessionId)) {
      throw new MistralRealtimeGatewayError('provider_error');
    }
    terminationRegistration = dependencies.terminations.register({
      connection,
      hardExpiresAt: grant.hardExpiresAt,
    });
    const activated = await dependencies.tickets.bindAndActivate({
      companyId: grant.companyId,
      redemptionId: grant.redemptionId,
      providerId: 'mistral',
      providerSessionId: connection.providerSessionId,
      contextRevision: grant.contextRevision,
      contextDigest: grant.contextDigest,
    });
    if (!activated.ok) {
      throw new MistralRealtimeGatewayError(
        activated.reason === 'unavailable' ? 'service_unavailable' : 'auth_failed',
      );
    }
    if (queue.count > 0) throw new MistralRealtimeGatewayError('protocol_error');

    await sendText(socket, {
      type: 'ready',
      protocol: MISTRAL_PCM_GATEWAY_PROTOCOL,
      audio: {
        encoding: 'pcm_s16le',
        sampleRateHz: MISTRAL_PCM_SAMPLE_RATE_HZ,
        channels: MISTRAL_PCM_CHANNELS,
        maxChunkBytes: MAX_PCM_CHUNK_BYTES,
      },
      hardExpiresAt: grant.hardExpiresAt,
    });
    ingressPhase = 'ready';

    let expectedSequence = 0;
    let audioBytes = 0;
    const audioBudget = Math.min(grant.maxAudioBytes, Math.ceil(remainingMs / 1_000) * PCM_BYTES_PER_SECOND);
    let finalObserved = false;
    const consumeMobile = async (): Promise<void> => {
      for (;;) {
        const message = await queue.next({ signal: lifecycle.signal });
        if (!message.isBinary) throw new MistralRealtimeGatewayError('protocol_error');
        const frame = decodeMistralPcmGatewayFrame(message.data);
        if (frame.sequence !== expectedSequence) throw new MistralRealtimeGatewayError('sequence_error');
        expectedSequence += 1;
        if (frame.kind === 'audio') {
          audioBytes += frame.pcm.byteLength;
          if (audioBytes > audioBudget) {
            throw new MistralRealtimeGatewayError('audio_budget_exceeded');
          }
          await connection!.sendAudio(frame.pcm);
          continue;
        }
        if (frame.kind === 'flush') {
          await connection!.flushAudio();
          continue;
        }
        ingressPhase = 'ending';
        await connection!.endAudio();
        if (queue.count > 0) throw new MistralRealtimeGatewayError('protocol_error');
        return;
      }
    };

    let serverSequence = 0;
    const consumeProvider = async (): Promise<void> => {
      for await (const event of connection!.events()) {
        const identity = {
          redemptionId: grant!.redemptionId,
          companyId: grant!.companyId,
          userId: grant!.userId,
          subjectHash: grant!.subjectHash,
          subjectKeyVersion: grant!.subjectKeyVersion,
          plan: grant!.plan,
          sessionId: grant!.sessionId,
          contextRevision: grant!.contextRevision,
          contextDigest: grant!.contextDigest,
          signal: lifecycle.signal,
        } as const;
        try {
          if (event.type === 'transcript_final') {
            const occurredAt = canonicalObservedAt(now);
            await dependencies.sink.publish({ ...identity, event, occurredAt });
          } else {
            await dependencies.sink.publish({ ...identity, event });
          }
        } catch {
          throw new MistralRealtimeGatewayError('sink_error');
        }
        if (event.type === 'transcript_delta') {
          await sendText(socket, { type: 'transcript.delta', sequence: serverSequence++, text: event.text });
        } else if (event.type === 'transcript_segment') {
          await sendText(socket, {
            type: 'transcript.segment',
            sequence: serverSequence++,
            text: event.text,
            startSeconds: event.startSeconds,
            endSeconds: event.endSeconds,
            speakerId: event.speakerId,
          });
        } else {
          finalObserved = true;
          await sendText(socket, {
            type: 'transcript.final',
            sequence: serverSequence++,
            text: event.text,
            language: event.language,
          });
        }
      }
      if (!finalObserved) throw new MistralRealtimeGatewayError('provider_error');
    };

    await Promise.all([consumeMobile(), consumeProvider()]);
    providerTermination = await closeProvider(connection, terminationRegistration, providerCloseTimeoutMs);
    if (providerTermination !== 'confirmed') throw new MistralRealtimeGatewayError('provider_error');
    await dependencies.tickets.complete({
      companyId: grant.companyId,
      redemptionId: grant.redemptionId,
      providerSessionId: connection.providerSessionId,
      providerTermination: 'confirmed',
    });
    completed = true;
    await sendText(socket, { type: 'complete', sequence: serverSequence });
    socket.close(1000, 'session_complete');
  } catch (unknownError) {
    const error = safeSocketError(unknownError);
    lifecycle.abort();
    const termination = providerTermination
      ?? await closeProvider(connection, terminationRegistration, providerCloseTimeoutMs);
    if (grant && !completed) {
      await dependencies.tickets.abandon({
        companyId: grant.companyId,
        redemptionId: grant.redemptionId,
        providerSessionId: connection?.providerSessionId ?? null,
        providerTermination: termination,
      }).catch(() => undefined);
    }
    await sendText(socket, { type: 'error', code: socketErrorWireCode(error.code) }).catch(() => undefined);
    try {
      socket.close(socketCloseCode(error.code), socketErrorWireCode(error.code));
    } catch {
      socket.terminate();
    }
    throw error;
  } finally {
    ingressPhase = 'closed';
    if (hardExpiryTimer) clearTimeout(hardExpiryTimer);
    input.signal?.removeEventListener('abort', abortFromExternal);
    socket.off('message', onMessage);
    socket.off('close', onClose);
    socket.off('error', onError);
    queue.fail(new MistralRealtimeGatewayError('aborted'));
  }
}
