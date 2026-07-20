import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { connect } from 'node:net';
import { MISTRAL_CONVERSATION_PROTOCOL } from '@bob/ai';
import WebSocket, { type ClientOptions } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MistralConversationGatewayV2Dependencies } from './mistral-conversation-gateway-v2';
import {
  MISTRAL_PCM_GATEWAY_PROTOCOL,
  type MistralRealtimeGatewayDependencies,
} from './mistral-realtime-gateway';
import {
  createMistralRealtimeUpgradeAdapter,
  isSecureMistralRequestBehindTrustedProxy,
  MISTRAL_REALTIME_MAX_PAYLOAD_BYTES,
  MISTRAL_REALTIME_UPGRADE_PATH,
  type MistralConversationGatewayV2Serve,
  type MistralRealtimeGatewayServe,
  type MistralRealtimeUpgradeAdapter,
} from './mistral-realtime-upgrade';
import { MistralRealtimeTerminationAuthority } from './mistral-realtime-termination';

const ALLOWED_ORIGIN = 'https://app.bob.test';

const UNUSED_GATEWAY_DEPENDENCIES: MistralRealtimeGatewayDependencies = {
  tickets: {
    issue: async () => ({ ok: false, reason: 'unavailable' }),
    consume: async () => ({ ok: false, reason: 'unavailable' }),
    bindAndActivate: async () => ({ ok: false, reason: 'unavailable' }),
    abandon: async () => undefined,
    complete: async () => undefined,
  },
  provider: {
    connect: async () => {
      throw new Error('unused_provider');
    },
  },
  terminations: new MistralRealtimeTerminationAuthority(),
  sink: {
    publish: async () => undefined,
  },
};

const CONVERSATION_V2_DEPENDENCIES_SENTINEL = Object.freeze(
  {},
) as MistralConversationGatewayV2Dependencies;

interface MessageObservation {
  readonly data: Uint8Array;
  readonly isBinary: boolean;
}

interface LoopbackHarness {
  readonly server: Server;
  readonly adapter: MistralRealtimeUpgradeAdapter;
  readonly origin: string;
  readonly port: number;
  close(): Promise<void>;
}

const harnesses: LoopbackHarness[] = [];

type HoldableGatewaySocket = Parameters<MistralRealtimeGatewayServe>[0];

function holdGatewaySocket(
  socket: HoldableGatewaySocket,
  signal: AbortSignal | undefined,
  observations: MessageObservation[],
): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      socket.off('message', onMessage);
      socket.off('close', onClose);
      socket.off('error', onError);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const onMessage = (data: string | Uint8Array | ArrayBuffer, isBinary: boolean): void => {
      const bytes = typeof data === 'string'
        ? new TextEncoder().encode(data)
        : data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : data;
      observations.push({ data: bytes, isBinary });
    };
    const onClose = (): void => finish();
    const onError = (): void => finish();
    const onAbort = (): void => finish();
    socket.on('message', onMessage);
    socket.on('close', onClose);
    socket.on('error', onError);
    if (signal?.aborted) finish();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function holdingServe(observations: MessageObservation[] = []): MistralRealtimeGatewayServe {
  return async (socket, _dependencies, input = {}) => (
    holdGatewaySocket(socket, input.signal, observations)
  );
}

function holdingConversationV2Serve(
  observations: MessageObservation[] = [],
): MistralConversationGatewayV2Serve {
  return async (socket, _dependencies, input = {}) => (
    holdGatewaySocket(socket, input.signal, observations)
  );
}

async function createHarness(input: {
  maxConnections?: number;
  shutdownGraceMs?: number;
  serveGateway?: MistralRealtimeGatewayServe;
  useCanonicalServe?: boolean;
  createDependencies?: () => MistralRealtimeGatewayDependencies;
  conversationV2?: {
    serveGateway?: MistralConversationGatewayV2Serve;
    useCanonicalServe?: boolean;
    createDependencies?: () => MistralConversationGatewayV2Dependencies;
  };
} = {}): Promise<LoopbackHarness> {
  const server = createServer((_request, response) => {
    response.writeHead(404, { 'content-length': '0' });
    response.end();
  });
  const adapter = createMistralRealtimeUpgradeAdapter({
    allowedBrowserOrigins: [ALLOWED_ORIGIN],
    maxConnections: input.maxConnections ?? 8,
    shutdownGraceMs: input.shutdownGraceMs ?? 100,
  }, {
    createGatewayDependencies: input.createDependencies ?? (() => UNUSED_GATEWAY_DEPENDENCIES),
    serveGateway: input.useCanonicalServe ? undefined : input.serveGateway ?? holdingServe(),
    conversationV2: input.conversationV2
      ? {
          createGatewayDependencies: input.conversationV2.createDependencies
            ?? (() => CONVERSATION_V2_DEPENDENCIES_SENTINEL),
          serveGateway: input.conversationV2.useCanonicalServe
            ? undefined
            : input.conversationV2.serveGateway ?? holdingConversationV2Serve(),
        }
      : undefined,
  });
  adapter.attach(server);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('loopback_not_bound');
  let closed = false;
  const harness: LoopbackHarness = {
    server,
    adapter,
    port: address.port,
    origin: `ws://127.0.0.1:${address.port}`,
    close: async () => {
      if (closed) return;
      closed = true;
      await adapter.shutdown();
      await new Promise<void>((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
      });
    },
  };
  harnesses.push(harness);
  return harness;
}

function webSocket(
  url: string,
  protocols: string | string[] | null = MISTRAL_PCM_GATEWAY_PROTOCOL,
  options: ClientOptions = {},
): WebSocket {
  const safeOptions: ClientOptions = { perMessageDeflate: false, ...options };
  return protocols === null
    ? new WebSocket(url, safeOptions)
    : new WebSocket(url, protocols, safeOptions);
}

async function openClient(
  url: string,
  protocols: string | string[] | null = MISTRAL_PCM_GATEWAY_PROTOCOL,
  options: ClientOptions = {},
): Promise<WebSocket> {
  const socket = webSocket(url, protocols, options);
  await new Promise<void>((resolve, reject) => {
    const onOpen = (): void => {
      socket.off('error', onError);
      resolve();
    };
    const onError = (): void => {
      socket.off('open', onOpen);
      reject(new Error('websocket_not_open'));
    };
    socket.once('open', onOpen);
    socket.once('error', onError);
  });
  socket.on('error', () => undefined);
  return socket;
}

async function rejectedClient(
  url: string,
  protocols: string | string[] | null = MISTRAL_PCM_GATEWAY_PROTOCOL,
  options: ClientOptions = {},
): Promise<number> {
  const socket = webSocket(url, protocols, options);
  socket.on('error', () => undefined);
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error('upgrade_rejection_timeout'));
    }, 1_000);
    socket.once('open', () => {
      clearTimeout(timer);
      socket.terminate();
      reject(new Error('unexpected_upgrade_success'));
    });
    socket.once('unexpected-response', (request, response) => {
      clearTimeout(timer);
      const status = response.statusCode ?? 0;
      response.resume();
      request.destroy();
      resolve(status);
    });
  });
}

async function closeClient(socket: WebSocket): Promise<number> {
  if (socket.readyState === WebSocket.CLOSED) return 1006;
  const closed = new Promise<number>((resolve) => {
    socket.once('close', (code) => resolve(code));
  });
  if (socket.readyState === WebSocket.OPEN) socket.close(1000, 'test_complete');
  else if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
  return closed;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition_not_reached');
}

async function rawUpgrade(input: {
  port: number;
  target: string;
  method?: string;
  connection?: string;
}): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = connect(input.port, '127.0.0.1');
    let response = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('raw_upgrade_timeout'));
    }, 1_000);
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write([
        `${input.method ?? 'GET'} ${input.target} HTTP/1.1`,
        `Host: 127.0.0.1:${input.port}`,
        'Upgrade: websocket',
        `Connection: ${input.connection ?? 'Upgrade'}`,
        `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
        'Sec-WebSocket-Version: 13',
        `Sec-WebSocket-Protocol: ${MISTRAL_PCM_GATEWAY_PROTOCOL}`,
        '',
        '',
      ].join('\r\n'));
    });
    socket.on('data', (chunk: string) => {
      response += chunk;
      if (response.includes('\r\n\r\n')) socket.end();
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.close();
});

describe('Mistral realtime HTTP Upgrade adapter', () => {
  it('ne fait confiance à X-Forwarded-Proto que depuis un proxy privé et sans ambiguïté', () => {
    const request = (remoteAddress: string, rawHeaders: string[]) => ({
      rawHeaders,
      socket: { remoteAddress },
    }) as unknown as IncomingMessage;

    expect(isSecureMistralRequestBehindTrustedProxy(request('10.12.0.4', [
      'X-Forwarded-Proto',
      'https',
    ]))).toBe(true);
    expect(isSecureMistralRequestBehindTrustedProxy(request('::ffff:192.168.1.2', [
      'X-Forwarded-Proto',
      'https',
    ]))).toBe(true);
    expect(isSecureMistralRequestBehindTrustedProxy(request('203.0.113.8', [
      'X-Forwarded-Proto',
      'https',
    ]))).toBe(false);
    expect(isSecureMistralRequestBehindTrustedProxy(request('10.12.0.4', [
      'X-Forwarded-Proto',
      'https',
      'X-Forwarded-Proto',
      'http',
    ]))).toBe(false);
    expect(isSecureMistralRequestBehindTrustedProxy(request('10.12.0.4', [
      'X-Forwarded-Proto',
      'https',
      'Forwarded',
      'proto=https',
    ]))).toBe(false);
  });

  it('n’accepte que le chemin exact et ne reflète jamais une query ou un fragment', async () => {
    const harness = await createHarness();
    await expect(rejectedClient(`${harness.origin}/wrong`)).resolves.toBe(404);
    await expect(rejectedClient(
      `${harness.origin}${MISTRAL_REALTIME_UPGRADE_PATH}?ticket=secret-must-not-echo`,
    )).resolves.toBe(404);
    const fragmentResponse = await rawUpgrade({
      port: harness.port,
      target: `${MISTRAL_REALTIME_UPGRADE_PATH}#secret-must-not-echo`,
    });
    expect(fragmentResponse).toMatch(/^HTTP\/1\.1 404 Not Found\r\n/u);
    expect(fragmentResponse).not.toContain('secret-must-not-echo');
  });

  it('exige GET et les headers Upgrade/Connection canoniques', async () => {
    const harness = await createHarness();
    const post = await rawUpgrade({
      port: harness.port,
      method: 'POST',
      target: MISTRAL_REALTIME_UPGRADE_PATH,
    });
    const ambiguousConnection = await rawUpgrade({
      port: harness.port,
      target: MISTRAL_REALTIME_UPGRADE_PATH,
      connection: 'keep-alive, Upgrade',
    });
    expect(post).toMatch(/^HTTP\/1\.1 404 Not Found\r\n/u);
    expect(ambiguousConnection).toMatch(/^HTTP\/1\.1 404 Not Found\r\n/u);
  });

  it('exige le sous-protocole unique exact et refuse toute extension', async () => {
    const harness = await createHarness();
    const url = `${harness.origin}${MISTRAL_REALTIME_UPGRADE_PATH}`;
    await expect(rejectedClient(url, null)).resolves.toBe(404);
    await expect(rejectedClient(url, 'other.protocol')).resolves.toBe(404);
    await expect(rejectedClient(url, [MISTRAL_PCM_GATEWAY_PROTOCOL, 'other.protocol'])).resolves.toBe(404);
    await expect(rejectedClient(url, MISTRAL_PCM_GATEWAY_PROTOCOL, {
      perMessageDeflate: true,
    })).resolves.toBe(404);

    const accepted = await openClient(url);
    expect(accepted.protocol).toBe(MISTRAL_PCM_GATEWAY_PROTOCOL);
    expect(accepted.extensions).toBe('');
    await closeClient(accepted);
  });

  it('préserve le routage v1 et garde v2 dormant sans opt-in explicite', async () => {
    const createDependencies = vi.fn(() => UNUSED_GATEWAY_DEPENDENCIES);
    const serveGateway = vi.fn(holdingServe());
    const harness = await createHarness({ createDependencies, serveGateway });
    const url = `${harness.origin}${MISTRAL_REALTIME_UPGRADE_PATH}`;

    await expect(rejectedClient(url, MISTRAL_CONVERSATION_PROTOCOL)).resolves.toBe(404);
    expect(createDependencies).not.toHaveBeenCalled();
    expect(serveGateway).not.toHaveBeenCalled();

    const client = await openClient(url, MISTRAL_PCM_GATEWAY_PROTOCOL);
    await waitFor(() => serveGateway.mock.calls.length === 1);
    expect(client.protocol).toBe(MISTRAL_PCM_GATEWAY_PROTOCOL);
    expect(createDependencies).toHaveBeenCalledTimes(1);
    expect(serveGateway.mock.calls[0]?.[1]).toBe(UNUSED_GATEWAY_DEPENDENCIES);
    expect(serveGateway.mock.calls[0]?.[2]?.signal).toBeInstanceOf(AbortSignal);
    await closeClient(client);
  });

  it('active v2 sur le listener unique et route chaque protocole vers sa propre factory', async () => {
    const createV1Dependencies = vi.fn(() => UNUSED_GATEWAY_DEPENDENCIES);
    const createV2Dependencies = vi.fn(() => CONVERSATION_V2_DEPENDENCIES_SENTINEL);
    const serveV1 = vi.fn(holdingServe());
    const serveV2 = vi.fn(holdingConversationV2Serve());
    const harness = await createHarness({
      createDependencies: createV1Dependencies,
      serveGateway: serveV1,
      conversationV2: {
        createDependencies: createV2Dependencies,
        serveGateway: serveV2,
      },
    });
    const url = `${harness.origin}${MISTRAL_REALTIME_UPGRADE_PATH}`;

    expect(harness.server.listenerCount('upgrade')).toBe(1);
    await expect(rejectedClient(url, [
      MISTRAL_PCM_GATEWAY_PROTOCOL,
      MISTRAL_CONVERSATION_PROTOCOL,
    ])).resolves.toBe(404);
    await expect(rejectedClient(url, MISTRAL_CONVERSATION_PROTOCOL, {
      origin: 'https://evil.bob.test',
    })).resolves.toBe(404);
    expect(createV1Dependencies).not.toHaveBeenCalled();
    expect(createV2Dependencies).not.toHaveBeenCalled();

    const v2 = await openClient(url, MISTRAL_CONVERSATION_PROTOCOL, { origin: ALLOWED_ORIGIN });
    await waitFor(() => serveV2.mock.calls.length === 1);
    expect(v2.protocol).toBe(MISTRAL_CONVERSATION_PROTOCOL);
    expect(createV2Dependencies).toHaveBeenCalledTimes(1);
    expect(createV1Dependencies).not.toHaveBeenCalled();
    expect(serveV2.mock.calls[0]?.[1]).toBe(CONVERSATION_V2_DEPENDENCIES_SENTINEL);
    expect(serveV2.mock.calls[0]?.[2]?.signal).toBeInstanceOf(AbortSignal);
    expect(serveV1).not.toHaveBeenCalled();

    const v1 = await openClient(url, MISTRAL_PCM_GATEWAY_PROTOCOL);
    await waitFor(() => serveV1.mock.calls.length === 1);
    expect(v1.protocol).toBe(MISTRAL_PCM_GATEWAY_PROTOCOL);
    expect(createV1Dependencies).toHaveBeenCalledTimes(1);
    expect(createV2Dependencies).toHaveBeenCalledTimes(1);
    expect(serveV1.mock.calls[0]?.[1]).toBe(UNUSED_GATEWAY_DEPENDENCIES);
    expect(serveV2).toHaveBeenCalledTimes(1);

    await Promise.all([closeClient(v1), closeClient(v2)]);
    await waitFor(() => harness.adapter.state().activeConnections === 0);
  });

  it('utilise le noyau conversationnel v2 canonique par défaut sans fallback v1', async () => {
    const createV1Dependencies = vi.fn(() => UNUSED_GATEWAY_DEPENDENCIES);
    const createV2Dependencies = vi.fn(() => CONVERSATION_V2_DEPENDENCIES_SENTINEL);
    const serveV1 = vi.fn(holdingServe());
    const harness = await createHarness({
      createDependencies: createV1Dependencies,
      serveGateway: serveV1,
      conversationV2: {
        createDependencies: createV2Dependencies,
        useCanonicalServe: true,
      },
    });
    const client = webSocket(
      `${harness.origin}${MISTRAL_REALTIME_UPGRADE_PATH}`,
      MISTRAL_CONVERSATION_PROTOCOL,
    );
    client.on('error', () => undefined);
    const opened = new Promise<void>((resolve, reject) => {
      client.once('open', resolve);
      client.once('error', reject);
    });
    const closed = new Promise<number>((resolve) => {
      client.once('close', (code) => resolve(code));
    });

    await opened;
    await expect(closed).resolves.toBe(1011);
    expect(createV2Dependencies).toHaveBeenCalledTimes(1);
    expect(createV1Dependencies).not.toHaveBeenCalled();
    expect(serveV1).not.toHaveBeenCalled();
  });

  it('applique une allowlist Origin exacte mais accepte le client natif sans Origin', async () => {
    const harness = await createHarness();
    const url = `${harness.origin}${MISTRAL_REALTIME_UPGRADE_PATH}`;
    const browser = await openClient(url, MISTRAL_PCM_GATEWAY_PROTOCOL, { origin: ALLOWED_ORIGIN });
    await closeClient(browser);
    await expect(rejectedClient(url, MISTRAL_PCM_GATEWAY_PROTOCOL, {
      origin: 'https://evil.bob.test',
    })).resolves.toBe(404);
    await expect(rejectedClient(url, MISTRAL_PCM_GATEWAY_PROTOCOL, {
      origin: `${ALLOWED_ORIGIN}/`,
    })).resolves.toBe(404);
    const native = await openClient(url);
    await closeClient(native);
  });

  it('normalise RawData vers un Uint8Array possédé par le port', async () => {
    const observations: MessageObservation[] = [];
    const harness = await createHarness({ serveGateway: holdingServe(observations) });
    const client = await openClient(`${harness.origin}${MISTRAL_REALTIME_UPGRADE_PATH}`);
    client.send(Buffer.from([1, 2, 3, 4]));
    await waitFor(() => observations.length === 1);
    expect(observations[0]?.isBinary).toBe(true);
    expect(observations[0]?.data.constructor).toBe(Uint8Array);
    expect([...observations[0]!.data]).toEqual([1, 2, 3, 4]);
    await closeClient(client);
  });

  it('branche par défaut le noyau canonique et garde le refus de ticket opaque', async () => {
    const harness = await createHarness({ useCanonicalServe: true });
    const client = await openClient(`${harness.origin}${MISTRAL_REALTIME_UPGRADE_PATH}`);
    const inbound = new Promise<string>((resolve) => {
      client.once('message', (data) => resolve(data.toString()));
    });
    const closed = new Promise<number>((resolve) => client.once('close', (code) => resolve(code)));
    const ticket = 'A'.repeat(43);
    client.send(JSON.stringify({
      type: 'authenticate',
      protocol: MISTRAL_PCM_GATEWAY_PROTOCOL,
      companyId: 'company-1',
      ticket,
    }));
    await expect(inbound).resolves.toBe(JSON.stringify({
      type: 'error',
      code: 'temporarily_unavailable',
    }));
    await expect(closed).resolves.toBe(1013);
    expect(await inbound).not.toContain(ticket);
  });

  it('fait appliquer maxPayload=16 400 par ws sans livrer le message surdimensionné', async () => {
    const observations: MessageObservation[] = [];
    const harness = await createHarness({ serveGateway: holdingServe(observations) });
    const client = await openClient(`${harness.origin}${MISTRAL_REALTIME_UPGRADE_PATH}`);
    const closed = new Promise<number>((resolve) => client.once('close', (code) => resolve(code)));
    client.send(Buffer.alloc(MISTRAL_REALTIME_MAX_PAYLOAD_BYTES + 1));
    await expect(closed).resolves.toBe(1009);
    expect(observations).toEqual([]);
    await waitFor(() => harness.adapter.state().activeConnections === 0);
  });

  it('partage atomiquement le même budget de connexions entre v1 et v2', async () => {
    const createV1Dependencies = vi.fn(() => UNUSED_GATEWAY_DEPENDENCIES);
    const createV2Dependencies = vi.fn(() => CONVERSATION_V2_DEPENDENCIES_SENTINEL);
    const harness = await createHarness({
      maxConnections: 1,
      createDependencies: createV1Dependencies,
      conversationV2: { createDependencies: createV2Dependencies },
    });
    const url = `${harness.origin}${MISTRAL_REALTIME_UPGRADE_PATH}`;
    const first = await openClient(url, MISTRAL_CONVERSATION_PROTOCOL);
    expect(harness.adapter.state().activeConnections).toBe(1);
    await expect(rejectedClient(url, MISTRAL_PCM_GATEWAY_PROTOCOL)).resolves.toBe(404);
    expect(createV2Dependencies).toHaveBeenCalledTimes(1);
    expect(createV1Dependencies).not.toHaveBeenCalled();
    await closeClient(first);
    await waitFor(() => harness.adapter.state().activeConnections === 0);

    const second = await openClient(url, MISTRAL_PCM_GATEWAY_PROTOCOL);
    expect(createV1Dependencies).toHaveBeenCalledTimes(1);
    await closeClient(second);
    await waitFor(() => harness.adapter.state().activeConnections === 0);
  });

  it('partage un shutdown borné entre v1 et v2 même si les noyaux ignorent AbortSignal', async () => {
    const neverSettlesV1: MistralRealtimeGatewayServe = async (socket) => {
      socket.on('message', () => undefined);
      socket.on('close', () => undefined);
      socket.on('error', () => undefined);
      await new Promise<void>(() => undefined);
    };
    const neverSettlesV2: MistralConversationGatewayV2Serve = async (socket) => {
      socket.on('message', () => undefined);
      socket.on('close', () => undefined);
      socket.on('error', () => undefined);
      await new Promise<void>(() => undefined);
    };
    const harness = await createHarness({
      shutdownGraceMs: 30,
      serveGateway: neverSettlesV1,
      conversationV2: { serveGateway: neverSettlesV2 },
    });
    const url = `${harness.origin}${MISTRAL_REALTIME_UPGRADE_PATH}`;
    const v1 = await openClient(url, MISTRAL_PCM_GATEWAY_PROTOCOL);
    const v2 = await openClient(url, MISTRAL_CONVERSATION_PROTOCOL);
    const v1Closed = new Promise<number>((resolve) => v1.once('close', (code) => resolve(code)));
    const v2Closed = new Promise<number>((resolve) => v2.once('close', (code) => resolve(code)));
    expect(harness.adapter.state().activeConnections).toBe(2);
    const startedAt = Date.now();
    await harness.adapter.shutdown();
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(harness.adapter.state()).toEqual({
      attached: false,
      accepting: false,
      activeConnections: 0,
    });
    expect(harness.server.listenerCount('upgrade')).toBe(0);
    await expect(Promise.all([v1Closed, v2Closed])).resolves.toEqual([1006, 1006]);
  });

  it('nettoie listeners et compteurs après des cycles attach/session/detach', async () => {
    const harness = await createHarness();
    const url = `${harness.origin}${MISTRAL_REALTIME_UPGRADE_PATH}`;
    expect(harness.server.listenerCount('upgrade')).toBe(1);
    for (let index = 0; index < 8; index += 1) {
      const client = await openClient(url);
      await closeClient(client);
      await waitFor(() => harness.adapter.state().activeConnections === 0);
    }
    harness.adapter.detach();
    expect(harness.server.listenerCount('upgrade')).toBe(0);
    expect(harness.adapter.state()).toEqual({
      attached: false,
      accepting: false,
      activeConnections: 0,
    });
    harness.adapter.attach(harness.server);
    expect(harness.server.listenerCount('upgrade')).toBe(1);
  });
});
