import { describe, expect, it, vi } from 'vitest';
import {
  encodeMistralPcmUplinkFrame,
  MISTRAL_PCM_UPLINK_PROTOCOL,
  MistralPcmUplink,
  type MistralPcmCapturePort,
  type MistralPcmCaptureSession,
  type MistralPcmMobileSocket,
  type MistralPcmUplinkBootstrap,
  type MistralPcmUplinkEvent,
} from './mistral-pcm-uplink';

const NOW = 1_000_000;
const HARD_EXPIRES_AT = new Date(NOW + 60_000).toISOString();
const TICKET_EXPIRES_AT = new Date(NOW + 30_000).toISOString();
const TICKET = 'A'.repeat(43);
const BOOTSTRAP: MistralPcmUplinkBootstrap = {
  websocketUrl: 'wss://api.bob.example/voice/realtime/mistral',
  companyId: 'company-1',
  ticket: TICKET,
  protocol: MISTRAL_PCM_UPLINK_PROTOCOL,
  ticketExpiresAt: TICKET_EXPIRES_AT,
  hardExpiresAt: HARD_EXPIRES_AT,
  maxAudioBytes: 32_000,
};

type Listener = (() => void) | ((event: { readonly data: unknown }) => void);

class FakeMobileSocket implements MistralPcmMobileSocket {
  readyState = 0;
  bufferedAmount = 0;
  binaryType = '';
  readonly sent: Array<string | ArrayBuffer> = [];
  readonly closes: Array<{ code: number; reason: string }> = [];
  private readonly listeners = new Map<string, Set<Listener>>();

  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
  addEventListener(type: 'close', listener: () => void): void;
  addEventListener(type: 'error', listener: () => void): void;
  addEventListener(
    type: string,
    listener: (() => void) | ((event: { readonly data: unknown }) => void),
  ): void {
    const current = this.listeners.get(type) ?? new Set<Listener>();
    current.add(listener);
    this.listeners.set(type, current);
  }

  removeEventListener(type: 'open', listener: () => void): void;
  removeEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
  removeEventListener(type: 'close', listener: () => void): void;
  removeEventListener(type: 'error', listener: () => void): void;
  removeEventListener(
    type: string,
    listener: (() => void) | ((event: { readonly data: unknown }) => void),
  ): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string | ArrayBuffer): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ''): void {
    this.closes.push({ code, reason });
    this.readyState = 3;
    this.dispatch('close');
  }

  open(): void {
    this.readyState = 1;
    this.dispatch('open');
  }

  server(payload: unknown): void {
    this.dispatch('message', {
      data: typeof payload === 'string' ? payload : JSON.stringify(payload),
    });
  }

  serverBinary(bytes: ArrayBuffer): void {
    this.dispatch('message', { data: bytes });
  }

  snapshot(type: 'message' | 'close'): readonly Listener[] {
    return [...(this.listeners.get(type) ?? [])];
  }

  dispatchSnapshot(listeners: readonly Listener[], event?: { readonly data: unknown }): void {
    for (const listener of listeners) {
      if (event) (listener as (value: { readonly data: unknown }) => void)(event);
      else (listener as () => void)();
    }
  }

  private dispatch(type: string, event?: { data: unknown }): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      if (event) (listener as (value: { readonly data: unknown }) => void)(event);
      else (listener as () => void)();
    }
  }
}

function captureHarness(
  input: {
    readonly stop?: () => Promise<void>;
  } = {},
): {
  capture: MistralPcmCapturePort;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  input: Parameters<MistralPcmCapturePort['start']>[0] | null;
} {
  const stop = vi.fn(async () => input.stop?.());
  const state: { input: Parameters<MistralPcmCapturePort['start']>[0] | null } = { input: null };
  const session: MistralPcmCaptureSession = { stop };
  const start = vi.fn(async (input: Parameters<MistralPcmCapturePort['start']>[0]) => {
    state.input = input;
    return session;
  });
  return {
    capture: { start },
    start,
    stop,
    get input() {
      return state.input;
    },
  };
}

function ready(socket: FakeMobileSocket, hardExpiresAt = HARD_EXPIRES_AT): void {
  socket.server({
    type: 'ready',
    protocol: MISTRAL_PCM_UPLINK_PROTOCOL,
    audio: {
      encoding: 'pcm_s16le',
      sampleRateHz: 16_000,
      channels: 1,
      maxChunkBytes: 16 * 1024,
    },
    hardExpiresAt,
  });
}

async function connectedHarness(
  input: {
    readonly stop?: () => Promise<void>;
  } = {},
): Promise<{
  socket: FakeMobileSocket;
  capture: ReturnType<typeof captureHarness>;
  uplink: MistralPcmUplink;
  events: MistralPcmUplinkEvent[];
}> {
  const socket = new FakeMobileSocket();
  const capture = captureHarness(input);
  const uplink = new MistralPcmUplink({
    socketFactory: () => socket,
    capture: capture.capture,
    now: () => NOW,
    connectTimeoutMs: 1_000,
  });
  const events: MistralPcmUplinkEvent[] = [];
  uplink.subscribe((event) => events.push(event));
  const connect = uplink.connect(BOOTSTRAP);
  socket.open();
  await Promise.resolve();
  ready(socket);
  await connect;
  await uplink.startCapture();
  return { socket, capture, uplink, events };
}

describe('Mistral PCM mobile uplink', () => {
  it('garde le ticket hors URL, attend ready avant le micro et utilise le framing canonique', async () => {
    const socket = new FakeMobileSocket();
    const capture = captureHarness();
    const factory = vi.fn((_url: string, _protocols: readonly string[]) => socket);
    const uplink = new MistralPcmUplink({
      socketFactory: factory,
      capture: capture.capture,
      now: () => NOW,
      connectTimeoutMs: 1_000,
    });
    const connect = uplink.connect(BOOTSTRAP);
    expect(factory).toHaveBeenCalledWith(BOOTSTRAP.websocketUrl, [MISTRAL_PCM_UPLINK_PROTOCOL]);
    expect(factory.mock.calls[0]?.[0]).not.toContain(TICKET);
    expect(capture.start).not.toHaveBeenCalled();

    socket.open();
    await Promise.resolve();
    expect(JSON.parse(socket.sent[0] as string)).toEqual({
      type: 'authenticate',
      protocol: MISTRAL_PCM_UPLINK_PROTOCOL,
      companyId: BOOTSTRAP.companyId,
      ticket: TICKET,
    });
    expect(capture.start).not.toHaveBeenCalled();
    ready(socket);
    await connect;

    // Le handshake seul ne possède jamais le micro : le contrôleur ouvre la capture seulement
    // après validation du contexte durable retourné par le bootstrap.
    expect(capture.start).not.toHaveBeenCalled();
    await uplink.startCapture();

    expect(capture.start).toHaveBeenCalledWith(
      expect.objectContaining({
        encoding: 'pcm_s16le',
        sampleRateHz: 16_000,
        channels: 1,
      }),
    );
    capture.input?.onChunk(Uint8Array.of(1, 0, 2, 0));
    const frame = socket.sent[1];
    expect(frame).toBeInstanceOf(ArrayBuffer);
    expect(Buffer.from(frame as ArrayBuffer).toString('hex')).toBe(
      '424f423101010000000000000000000401000200',
    );
    await uplink.close();
  });

  it('streame segments et final dans un ordre strict, sans aucun audio descendant provider', async () => {
    const h = await connectedHarness();
    h.socket.server({ type: 'transcript.delta', sequence: 0, text: 'Bon' });
    h.socket.server({
      type: 'transcript.segment',
      sequence: 1,
      text: 'Bonjour',
      startSeconds: 0,
      endSeconds: 0.8,
      speakerId: null,
    });
    await h.uplink.finishInput();
    h.socket.server({ type: 'transcript.final', sequence: 2, text: 'Bonjour', language: 'fr' });
    h.socket.server({ type: 'complete', sequence: 3 });
    await h.uplink.close();

    expect(h.events.filter((event) => event.type.startsWith('transcript'))).toEqual([
      { type: 'transcript_delta', text: 'Bon' },
      {
        type: 'transcript_segment',
        text: 'Bonjour',
        startSeconds: 0,
        endSeconds: 0.8,
        speakerId: null,
      },
      { type: 'transcript_final', text: 'Bonjour', language: 'fr' },
    ]);
    expect(h.events).toContainEqual({ type: 'complete' });
    expect(h.uplink.capabilities).toEqual({
      microphoneUplink: true,
      providerAudioDownlink: false,
      fullDuplex: false,
    });
    expect(h.capture.stop).toHaveBeenCalledTimes(1);
    const frames = h.socket.sent.slice(1) as ArrayBuffer[];
    expect(frames.map((frame) => Buffer.from(frame).subarray(4, 6).toString('hex'))).toEqual([
      '0102',
      '0103',
    ]);
    expect(h.uplink.state).toBe('closed');
  });

  it('refuse tout downlink binaire et ferme sans interpréter son contenu', async () => {
    const h = await connectedHarness();
    h.socket.serverBinary(
      encodeMistralPcmUplinkFrame({ kind: 'audio', sequence: 0, pcm: Uint8Array.of(1, 0) }),
    );
    await h.uplink.close();
    expect(h.uplink.state).toBe('closed');
    expect(h.events).toContainEqual({ type: 'error', code: 'protocol_error' });
    expect(h.capture.stop).toHaveBeenCalledTimes(1);
  });

  it('ferme fail-closed sur trou de séquence, chunk invalide ou backpressure', async () => {
    const sequence = await connectedHarness();
    sequence.socket.server({ type: 'transcript.delta', sequence: 1, text: 'hors ordre' });
    await sequence.uplink.close();
    expect(sequence.uplink.state).toBe('closed');
    expect(sequence.events).toContainEqual({ type: 'error', code: 'protocol_error' });

    const chunk = await connectedHarness();
    chunk.capture.input?.onChunk(Uint8Array.of(1));
    await chunk.uplink.close();
    expect(chunk.uplink.state).toBe('closed');
    expect(chunk.events).toContainEqual({ type: 'error', code: 'capture_error' });

    const pressure = await connectedHarness();
    pressure.socket.bufferedAmount = 256 * 1024 + 1;
    pressure.capture.input?.onChunk(Uint8Array.of(1, 0));
    await pressure.uplink.close();
    expect(pressure.uplink.state).toBe('closed');
    expect(pressure.events).toContainEqual({ type: 'error', code: 'backpressure' });
  });

  it('refuse bootstrap ambigu, ticket en query et dérive de l’expiration ready', async () => {
    const factory = vi.fn((_url: string, _protocols: readonly string[]) => new FakeMobileSocket());
    const capture = captureHarness();
    for (const bootstrap of [
      { ...BOOTSTRAP, websocketUrl: `wss://api.bob.example/live?ticket=${TICKET}` },
      { ...BOOTSTRAP, websocketUrl: 'https://api.bob.example/live' },
      { ...BOOTSTRAP, ticket: 'court' },
      { ...BOOTSTRAP, companyId: '../autre' },
    ]) {
      const uplink = new MistralPcmUplink({
        socketFactory: factory,
        capture: capture.capture,
        now: () => NOW,
      });
      await expect(uplink.connect(bootstrap)).rejects.toMatchObject({ code: 'invalid_bootstrap' });
    }
    expect(factory).not.toHaveBeenCalled();

    const socket = new FakeMobileSocket();
    const uplink = new MistralPcmUplink({
      socketFactory: () => socket,
      capture: capture.capture,
      now: () => NOW,
      connectTimeoutMs: 1_000,
    });
    const connect = uplink.connect(BOOTSTRAP);
    socket.open();
    await Promise.resolve();
    ready(socket, new Date(NOW + 30_000).toISOString());
    await expect(connect).rejects.toMatchObject({ code: 'protocol_error' });
    expect(capture.start).not.toHaveBeenCalled();
  });

  it('propage l’abort sans ouvrir de socket', async () => {
    const factory = vi.fn((_url: string, _protocols: readonly string[]) => new FakeMobileSocket());
    const abort = new AbortController();
    abort.abort();
    const uplink = new MistralPcmUplink({
      socketFactory: factory,
      capture: captureHarness().capture,
      now: () => NOW,
    });
    await expect(uplink.connect(BOOTSTRAP, { signal: abort.signal })).rejects.toMatchObject({
      code: 'aborted',
    });
    expect(factory).not.toHaveBeenCalled();
  });

  it('termine immédiatement si le socket tombe avant open et distingue une panne capture', async () => {
    const earlySocket = new FakeMobileSocket();
    const earlyCapture = captureHarness();
    const early = new MistralPcmUplink({
      socketFactory: () => earlySocket,
      capture: earlyCapture.capture,
      now: () => NOW,
      connectTimeoutMs: 1_000,
    });
    const earlyConnect = early.connect(BOOTSTRAP);
    earlySocket.close(1006, 'network_lost');
    await expect(earlyConnect).rejects.toMatchObject({ code: 'socket_unavailable' });
    expect(earlyCapture.start).not.toHaveBeenCalled();

    const captureSocket = new FakeMobileSocket();
    const failingCapture: MistralPcmCapturePort = {
      start: vi.fn(async () => {
        throw new Error('native detail must not leak');
      }),
    };
    const captureUplink = new MistralPcmUplink({
      socketFactory: () => captureSocket,
      capture: failingCapture,
      now: () => NOW,
      connectTimeoutMs: 1_000,
    });
    const captureConnect = captureUplink.connect(BOOTSTRAP);
    captureSocket.open();
    await Promise.resolve();
    ready(captureSocket);
    await captureConnect;
    await expect(captureUplink.startCapture()).rejects.toMatchObject({ code: 'capture_error' });
  });

  it('stopCapture fence un prepare natif tardif et refuse ses chunks sans fermer le socket', async () => {
    const socket = new FakeMobileSocket();
    const stop = vi.fn(async () => undefined);
    let releaseCapture!: (session: MistralPcmCaptureSession) => void;
    const captureState: {
      input: Parameters<MistralPcmCapturePort['start']>[0] | null;
    } = { input: null };
    const capture: MistralPcmCapturePort = {
      start: vi.fn((input) => {
        captureState.input = input;
        return new Promise<MistralPcmCaptureSession>((resolve) => {
          releaseCapture = resolve;
        });
      }),
    };
    const uplink = new MistralPcmUplink({
      socketFactory: () => socket,
      capture,
      now: () => NOW,
      connectTimeoutMs: 1_000,
    });
    const connect = uplink.connect(BOOTSTRAP);
    socket.open();
    await Promise.resolve();
    ready(socket);
    await connect;

    const starting = uplink.startCapture();
    await Promise.resolve();
    const stopping = uplink.stopCapture();
    releaseCapture({ stop });

    await expect(starting).rejects.toMatchObject({ code: 'aborted' });
    await stopping;
    expect(stop).toHaveBeenCalledOnce();
    expect(captureState.input?.onChunk(Uint8Array.of(1, 0))).toBe(false);
    expect(uplink.state).toBe('ready');
    expect(socket.closes).toHaveLength(0);
    await uplink.close();
  });

  it('propage un stop non confirmé et interdit close, restart et reconnexion', async () => {
    const h = await connectedHarness({
      stop: async () => {
        throw new Error('native secret must not leak');
      },
    });

    await expect(h.uplink.stopCapture()).rejects.toMatchObject({
      code: 'capture_error',
      message: 'capture_error',
    });
    await expect(h.uplink.close()).rejects.toMatchObject({ code: 'capture_error' });
    await expect(h.uplink.startCapture()).rejects.toMatchObject({ code: 'capture_error' });
    await expect(h.uplink.connect(BOOTSTRAP)).rejects.toMatchObject({ code: 'capture_error' });

    expect(h.capture.stop).toHaveBeenCalledTimes(1);
    expect(h.uplink.state).toBe('closing');
  });

  it('ne transforme pas une panne protocole en close réussi si le micro résiste au stop', async () => {
    const h = await connectedHarness({
      stop: async () => {
        throw new Error('bridge failed');
      },
    });

    h.socket.serverBinary(
      encodeMistralPcmUplinkFrame({ kind: 'audio', sequence: 0, pcm: Uint8Array.of(1, 0) }),
    );

    await expect(h.uplink.close()).rejects.toMatchObject({ code: 'capture_error' });
    expect(h.events).toContainEqual({ type: 'error', code: 'protocol_error' });
    expect(h.uplink.state).toBe('closing');
    expect(h.capture.stop).toHaveBeenCalledTimes(1);
  });

  it('ignore les callbacks deja queues d’un ancien socket apres reconnexion', async () => {
    const first = new FakeMobileSocket();
    const second = new FakeMobileSocket();
    const sockets = [first, second];
    const capture = captureHarness();
    const events: MistralPcmUplinkEvent[] = [];
    const uplink = new MistralPcmUplink({
      socketFactory: () => sockets.shift()!,
      capture: capture.capture,
      now: () => NOW,
      connectTimeoutMs: 1_000,
    });
    uplink.subscribe((event) => events.push(event));
    const firstConnect = uplink.connect(BOOTSTRAP);
    first.open();
    await Promise.resolve();
    ready(first);
    await firstConnect;
    const staleMessages = first.snapshot('message');
    const staleCloses = first.snapshot('close');
    await uplink.close();

    const secondConnect = uplink.connect(BOOTSTRAP);
    second.open();
    await Promise.resolve();
    ready(second);
    await secondConnect;
    const errorsBefore = events.filter((event) => event.type === 'error').length;

    first.dispatchSnapshot(staleMessages, {
      data: JSON.stringify({ type: 'error', code: 'stale_socket' }),
    });
    first.dispatchSnapshot(staleCloses);

    expect(uplink.state).toBe('ready');
    expect(events.filter((event) => event.type === 'error')).toHaveLength(errorsBefore);
    await uplink.close();
  });
});
