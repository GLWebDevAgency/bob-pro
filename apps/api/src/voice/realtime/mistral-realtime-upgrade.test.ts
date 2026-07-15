import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { connect } from 'node:net';
import WebSocket, { type ClientOptions } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MISTRAL_PCM_GATEWAY_PROTOCOL,
  type MistralRealtimeGatewayDependencies,
} from './mistral-realtime-gateway';
import {
  createMistralRealtimeUpgradeAdapter,
  isSecureMistralRequestBehindTrustedProxy,
  MISTRAL_REALTIME_MAX_PAYLOAD_BYTES,
  MISTRAL_REALTIME_UPGRADE_PATH,
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

function holdingServe(observations: MessageObservation[] = []): MistralRealtimeGatewayServe {
  return async (socket, _dependencies, input = {}) => new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      socket.off('message', onMessage);
      socket.off('close', onClose);
      socket.off('error', onError);
      input.signal?.removeEventListener('abort', onAbort);
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
    if (input.signal?.aborted) finish();
    else input.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function createHarness(input: {
  maxConnections?: number;
  shutdownGraceMs?: number;
  serveGateway?: MistralRealtimeGatewayServe;
  useCanonicalServe?: boolean;
  createDependencies?: () => MistralRealtimeGatewayDependencies;
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

  it('réserve atomiquement le budget de connexions avant l’upgrade', async () => {
    const createDependencies = vi.fn(() => UNUSED_GATEWAY_DEPENDENCIES);
    const harness = await createHarness({ maxConnections: 1, createDependencies });
    const url = `${harness.origin}${MISTRAL_REALTIME_UPGRADE_PATH}`;
    const first = await openClient(url);
    expect(harness.adapter.state().activeConnections).toBe(1);
    await expect(rejectedClient(url)).resolves.toBe(404);
    expect(createDependencies).toHaveBeenCalledTimes(1);
    await closeClient(first);
    await waitFor(() => harness.adapter.state().activeConnections === 0);
  });

  it('borne le shutdown même si une dépendance ignore AbortSignal', async () => {
    const neverSettles: MistralRealtimeGatewayServe = async (socket) => {
      socket.on('message', () => undefined);
      socket.on('close', () => undefined);
      socket.on('error', () => undefined);
      await new Promise<void>(() => undefined);
    };
    const harness = await createHarness({ shutdownGraceMs: 30, serveGateway: neverSettles });
    const client = await openClient(`${harness.origin}${MISTRAL_REALTIME_UPGRADE_PATH}`);
    const closed = new Promise<number>((resolve) => client.once('close', (code) => resolve(code)));
    const startedAt = Date.now();
    await harness.adapter.shutdown();
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(harness.adapter.state()).toEqual({
      attached: false,
      accepting: false,
      activeConnections: 0,
    });
    expect(harness.server.listenerCount('upgrade')).toBe(0);
    await expect(closed).resolves.toBe(1006);
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
