import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { isIP } from 'node:net';
import type { Duplex } from 'node:stream';
import type { TLSSocket } from 'node:tls';
import { MISTRAL_CONVERSATION_PROTOCOL } from '@bob/ai';
import WebSocket, { WebSocketServer, type RawData } from 'ws';
import {
  serveMistralConversationGatewayV2,
  type MistralConversationGatewayV2Dependencies,
  type MistralConversationGatewayV2Socket,
} from './mistral-conversation-gateway-v2';
import {
  MISTRAL_PCM_GATEWAY_PROTOCOL,
  serveMistralRealtimeGateway,
  type MistralRealtimeGatewayDependencies,
  type MistralRealtimeGatewaySocket,
} from './mistral-realtime-gateway';

export const MISTRAL_REALTIME_UPGRADE_PATH = '/v1/voice/realtime/mistral' as const;
export const MISTRAL_REALTIME_MAX_PAYLOAD_BYTES = 16_400 as const;

const MAX_UPGRADE_PATH_CHARS = 160;
const MAX_ORIGIN_CHARS = 2_048;
const MAX_CONNECTIONS = 10_000;
const MIN_SHUTDOWN_GRACE_MS = 25;
const MAX_SHUTDOWN_GRACE_MS = 10_000;
const SESSION_CLOSE_GRACE_MS = 250;
const MAX_UPGRADE_HEAD_BYTES = MISTRAL_REALTIME_MAX_PAYLOAD_BYTES + 32;
const WEBSOCKET_KEY = /^[+/0-9A-Za-z]{22}==$/u;
const UPGRADE_PATH = /^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]+$/u;
const OPAQUE_UPGRADE_REJECTION = Buffer.from(
  'HTTP/1.1 404 Not Found\r\n'
  + 'Connection: close\r\n'
  + 'Cache-Control: no-store\r\n'
  + 'Content-Length: 0\r\n'
  + '\r\n',
  'ascii',
);

type GatewayMessageData = string | Uint8Array | ArrayBuffer;
type GatewayMessageListener = (data: GatewayMessageData, isBinary: boolean) => void;
type GatewayCloseListener = (code: number) => void;
type GatewayErrorListener = (error: Error) => void;
type RawMessageListener = (data: RawData, isBinary: boolean) => void;
type RawCloseListener = (code: number, reason: Buffer) => void;
type RawErrorListener = (error: Error) => void;

export type MistralRealtimeGatewayDependenciesFactory = () => MistralRealtimeGatewayDependencies;

export type MistralConversationGatewayV2DependenciesFactory = (
) => MistralConversationGatewayV2Dependencies;

export type MistralRealtimeGatewayServe = (
  socket: MistralRealtimeGatewaySocket,
  dependencies: MistralRealtimeGatewayDependencies,
  input?: { readonly signal?: AbortSignal },
) => Promise<void>;

export type MistralConversationGatewayV2Serve = (
  socket: MistralConversationGatewayV2Socket,
  dependencies: MistralConversationGatewayV2Dependencies,
  input?: { readonly signal?: AbortSignal },
) => Promise<void>;

export interface MistralRealtimeUpgradeSettings {
  /** Chemin HTTP exact. Les query strings et fragments sont toujours refusés. */
  readonly path?: string;
  /** Origins navigateur sérialisées exactement (`https://app.example.com`), sans wildcard. */
  readonly allowedBrowserOrigins: readonly string[];
  readonly maxConnections: number;
  readonly shutdownGraceMs?: number;
}

export interface MistralRealtimeUpgradeConversationV2Dependencies {
  readonly createGatewayDependencies: MistralConversationGatewayV2DependenciesFactory;
  /** Injection réservée aux tests; la production utilise le noyau conversationnel v2 canonique. */
  readonly serveGateway?: MistralConversationGatewayV2Serve;
}

export interface MistralRealtimeUpgradeDependencies {
  readonly createGatewayDependencies: MistralRealtimeGatewayDependenciesFactory;
  /** Injection réservée aux tests de l'adapter; la production utilise le noyau canonique. */
  readonly serveGateway?: MistralRealtimeGatewayServe;
  /** Active explicitement `bob.mistral-pcm.v2` sur le même listener et le même chemin WSS. */
  readonly conversationV2?: MistralRealtimeUpgradeConversationV2Dependencies;
  /**
   * Hook pour un terminateur TLS de confiance. Par défaut, seuls TLS direct et loopback clair
   * sont admis. Le hook ne reçoit jamais le ticket, qui voyage dans la première frame WSS.
   */
  readonly isSecureRequest?: (request: IncomingMessage) => boolean;
}

export interface MistralRealtimeUpgradeState {
  readonly attached: boolean;
  readonly accepting: boolean;
  readonly activeConnections: number;
}

export interface MistralRealtimeUpgradeAdapter {
  attach(server: HttpServer): void;
  detach(): void;
  shutdown(): Promise<void>;
  state(): MistralRealtimeUpgradeState;
}

type ConfigurationErrorCode =
  | 'invalid_settings'
  | 'invalid_path'
  | 'invalid_origin_allowlist'
  | 'invalid_connection_budget'
  | 'invalid_shutdown_budget'
  | 'invalid_dependencies'
  | 'already_attached'
  | 'adapter_shutdown';

export class MistralRealtimeUpgradeConfigurationError extends Error {
  constructor(readonly code: ConfigurationErrorCode) {
    super(code);
    this.name = 'MistralRealtimeUpgradeConfigurationError';
  }
}

function rawHeaderValues(request: IncomingMessage, expectedName: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === expectedName) {
      values.push(request.rawHeaders[index + 1] ?? '');
    }
  }
  return values;
}

function canonicalWebSocketKey(key: string): boolean {
  if (!WEBSOCKET_KEY.test(key)) return false;
  const decoded = Buffer.from(key, 'base64');
  return decoded.byteLength === 16 && decoded.toString('base64') === key;
}

function loopbackHost(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '[::1]';
}

function canonicalBrowserOrigin(origin: string): boolean {
  if (origin.length === 0 || origin.length > MAX_ORIGIN_CHARS) return false;
  try {
    const parsed = new URL(origin);
    if (
      parsed.origin !== origin
      || parsed.username !== ''
      || parsed.password !== ''
      || parsed.pathname !== '/'
      || parsed.search !== ''
      || parsed.hash !== ''
    ) return false;
    if (parsed.protocol === 'https:') return true;
    return parsed.protocol === 'http:' && loopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

function loopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return address === '::1'
    || address.startsWith('127.')
    || address.startsWith('::ffff:127.');
}

function privateProxyAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  const family = isIP(normalized);
  if (family === 4) {
    const parts = normalized.split('.').map(Number);
    const first = parts[0];
    const second = parts[1];
    return first === 10
      || first === 127
      || (first === 172 && second !== undefined && second >= 16 && second <= 31)
      || (first === 192 && second === 168);
  }
  if (family === 6) {
    const lower = normalized.toLowerCase();
    return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd');
  }
  return false;
}

function defaultSecureRequest(request: IncomingMessage): boolean {
  if ((request.socket as TLSSocket).encrypted === true) return true;
  return loopbackAddress(request.socket.remoteAddress);
}

/**
 * Variante explicite pour un reverse proxy TLS placé sur un réseau privé de confiance.
 *
 * Elle ne doit être sélectionnée que si le backend Node n'est pas joignable directement et si
 * l'ingress écrase `X-Forwarded-Proto`. Une adresse publique, une chaîne ambiguë, un header doublé
 * ou le header standard `Forwarded` concurrent font échouer la connexion.
 */
export function isSecureMistralRequestBehindTrustedProxy(request: IncomingMessage): boolean {
  if ((request.socket as TLSSocket).encrypted === true) return true;
  if (!privateProxyAddress(request.socket.remoteAddress)) return false;
  const forwardedProto = rawHeaderValues(request, 'x-forwarded-proto');
  const standardizedForwarded = rawHeaderValues(request, 'forwarded');
  return standardizedForwarded.length === 0
    && forwardedProto.length === 1
    && forwardedProto[0] === 'https';
}

function normalizeRawData(raw: RawData): Uint8Array {
  if (Buffer.isBuffer(raw)) return Uint8Array.from(raw);
  if (raw instanceof ArrayBuffer) return Uint8Array.from(new Uint8Array(raw));
  const totalBytes = raw.reduce((total, chunk) => total + chunk.byteLength, 0);
  return Uint8Array.from(Buffer.concat(raw, totalBytes));
}

function pushListener<K, V>(map: Map<K, V[]>, listener: K, wrapper: V): void {
  const wrappers = map.get(listener);
  if (wrappers) wrappers.push(wrapper);
  else map.set(listener, [wrapper]);
}

function popListener<K, V>(map: Map<K, V[]>, listener: K): V | null {
  const wrappers = map.get(listener);
  const wrapper = wrappers?.pop() ?? null;
  if (wrappers?.length === 0) map.delete(listener);
  return wrapper;
}

class NodeWsGatewaySocket implements MistralRealtimeGatewaySocket, MistralConversationGatewayV2Socket {
  private readonly messageListeners = new Map<GatewayMessageListener, RawMessageListener[]>();
  private readonly closeListeners = new Map<GatewayCloseListener, RawCloseListener[]>();
  private readonly errorListeners = new Map<GatewayErrorListener, RawErrorListener[]>();

  constructor(private readonly socket: WebSocket) {}

  get readyState(): number {
    return this.socket.readyState;
  }

  get bufferedAmount(): number {
    return this.socket.bufferedAmount;
  }

  on(event: 'message', listener: GatewayMessageListener): this;
  on(event: 'close', listener: GatewayCloseListener): this;
  on(event: 'error', listener: GatewayErrorListener): this;
  on(
    event: 'message' | 'close' | 'error',
    listener: GatewayMessageListener | GatewayCloseListener | GatewayErrorListener,
  ): this {
    if (event === 'message') {
      const gatewayListener = listener as GatewayMessageListener;
      const wrapper: RawMessageListener = (data, isBinary) => {
        gatewayListener(normalizeRawData(data), isBinary);
      };
      pushListener(this.messageListeners, gatewayListener, wrapper);
      this.socket.on('message', wrapper);
    } else if (event === 'close') {
      const gatewayListener = listener as GatewayCloseListener;
      const wrapper: RawCloseListener = (code) => gatewayListener(code);
      pushListener(this.closeListeners, gatewayListener, wrapper);
      this.socket.on('close', wrapper);
    } else {
      const gatewayListener = listener as GatewayErrorListener;
      const wrapper: RawErrorListener = () => gatewayListener(new Error('websocket_error'));
      pushListener(this.errorListeners, gatewayListener, wrapper);
      this.socket.on('error', wrapper);
    }
    return this;
  }

  off(event: 'message', listener: GatewayMessageListener): this;
  off(event: 'close', listener: GatewayCloseListener): this;
  off(event: 'error', listener: GatewayErrorListener): this;
  off(
    event: 'message' | 'close' | 'error',
    listener: GatewayMessageListener | GatewayCloseListener | GatewayErrorListener,
  ): this {
    if (event === 'message') {
      const wrapper = popListener(this.messageListeners, listener as GatewayMessageListener);
      if (wrapper) this.socket.off('message', wrapper);
    } else if (event === 'close') {
      const wrapper = popListener(this.closeListeners, listener as GatewayCloseListener);
      if (wrapper) this.socket.off('close', wrapper);
    } else {
      const wrapper = popListener(this.errorListeners, listener as GatewayErrorListener);
      if (wrapper) this.socket.off('error', wrapper);
    }
    return this;
  }

  send(data: string, callback?: (error?: Error) => void): void {
    if (this.socket.readyState !== WebSocket.OPEN) {
      callback?.(new Error('socket_closed'));
      return;
    }
    try {
      this.socket.send(data, { binary: false, compress: false }, (error) => {
        callback?.(error ? new Error('socket_write_failed') : undefined);
      });
    } catch {
      callback?.(new Error('socket_write_failed'));
    }
  }

  close(code?: number, reason?: string): void {
    try {
      this.socket.close(code, reason);
    } catch {
      this.terminate();
    }
  }

  terminate(): void {
    try {
      this.socket.terminate();
    } catch {
      // Socket déjà détruite : la terminaison reste idempotente.
    }
  }

  dispose(): void {
    for (const wrappers of this.messageListeners.values()) {
      for (const wrapper of wrappers) this.socket.off('message', wrapper);
    }
    for (const wrappers of this.closeListeners.values()) {
      for (const wrapper of wrappers) this.socket.off('close', wrapper);
    }
    for (const wrappers of this.errorListeners.values()) {
      for (const wrapper of wrappers) this.socket.off('error', wrapper);
    }
    this.messageListeners.clear();
    this.closeListeners.clear();
    this.errorListeners.clear();
  }
}

interface SessionRecord {
  readonly socket: WebSocket;
  readonly port: NodeWsGatewaySocket;
  readonly abort: AbortController;
  done: Promise<void>;
  finalized: boolean;
}

interface ConversationV2Runtime {
  readonly createGatewayDependencies: MistralConversationGatewayV2DependenciesFactory;
  readonly serveGateway: MistralConversationGatewayV2Serve;
}

function rejectUpgrade(socket: Duplex): void {
  if (socket.destroyed) return;
  const destroy = (): void => {
    socket.destroy();
  };
  socket.once('error', destroy);
  socket.once('finish', destroy);
  try {
    socket.end(OPAQUE_UPGRADE_REJECTION);
  } catch {
    socket.destroy();
  }
}

function closeSocket(socket: WebSocket, code: 1000 | 1011): void {
  if (socket.readyState === WebSocket.OPEN) {
    try {
      socket.close(code, code === 1000 ? 'session_complete' : 'realtime_failed');
    } catch {
      socket.terminate();
    }
  }
}

function websocketClosed(socket: WebSocket): boolean {
  return socket.readyState === WebSocket.CLOSED;
}

async function closeSocketWithin(socket: WebSocket, code: 1000 | 1011, timeoutMs: number): Promise<void> {
  if (websocketClosed(socket)) return;
  closeSocket(socket, code);
  if (websocketClosed(socket)) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('close', onClose);
      resolve();
    };
    const onClose = (): void => finish();
    const timer = setTimeout(finish, timeoutMs);
    socket.on('close', onClose);
  });
  if (!websocketClosed(socket)) socket.terminate();
}

async function waitAtMost(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  if (timeoutMs <= 0) return false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const outcome = await Promise.race([
    promise.then(() => true, () => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  return outcome;
}

class SecureMistralRealtimeUpgradeAdapter implements MistralRealtimeUpgradeAdapter {
  private readonly path: string;
  private readonly allowedBrowserOrigins: ReadonlySet<string>;
  private readonly maxConnections: number;
  private readonly shutdownGraceMs: number;
  private readonly createGatewayDependencies: MistralRealtimeGatewayDependenciesFactory;
  private readonly serveGateway: MistralRealtimeGatewayServe;
  private readonly conversationV2: ConversationV2Runtime | null;
  private readonly isSecureRequest: (request: IncomingMessage) => boolean;
  private readonly websocketServer: WebSocketServer;
  private readonly sessions = new Set<SessionRecord>();
  private attachedServer: HttpServer | null = null;
  private activeConnections = 0;
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;

  private readonly onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (!this.accepts(request, head) || this.activeConnections >= this.maxConnections) {
      rejectUpgrade(socket);
      return;
    }

    this.activeConnections += 1;
    let upgraded = false;
    try {
      this.websocketServer.handleUpgrade(request, socket, head, (websocket) => {
        upgraded = true;
        try {
          this.beginSession(websocket);
        } catch {
          websocket.terminate();
          this.releaseReservation();
        }
      });
    } catch {
      if (!upgraded) this.releaseReservation();
      rejectUpgrade(socket);
      return;
    }
    if (!upgraded) this.releaseReservation();
  };

  constructor(
    settings: MistralRealtimeUpgradeSettings,
    dependencies: MistralRealtimeUpgradeDependencies,
  ) {
    if (!settings || typeof settings !== 'object') {
      throw new MistralRealtimeUpgradeConfigurationError('invalid_settings');
    }
    const path = settings.path ?? MISTRAL_REALTIME_UPGRADE_PATH;
    if (
      typeof path !== 'string'
      || path.length > MAX_UPGRADE_PATH_CHARS
      || !UPGRADE_PATH.test(path)
    ) throw new MistralRealtimeUpgradeConfigurationError('invalid_path');
    if (
      !Array.isArray(settings.allowedBrowserOrigins)
      || settings.allowedBrowserOrigins.some((origin) => (
        typeof origin !== 'string' || !canonicalBrowserOrigin(origin)
      ))
      || new Set(settings.allowedBrowserOrigins).size !== settings.allowedBrowserOrigins.length
    ) throw new MistralRealtimeUpgradeConfigurationError('invalid_origin_allowlist');
    if (
      !Number.isInteger(settings.maxConnections)
      || settings.maxConnections < 1
      || settings.maxConnections > MAX_CONNECTIONS
    ) throw new MistralRealtimeUpgradeConfigurationError('invalid_connection_budget');
    const shutdownGraceMs = settings.shutdownGraceMs ?? 1_500;
    if (
      !Number.isInteger(shutdownGraceMs)
      || shutdownGraceMs < MIN_SHUTDOWN_GRACE_MS
      || shutdownGraceMs > MAX_SHUTDOWN_GRACE_MS
    ) throw new MistralRealtimeUpgradeConfigurationError('invalid_shutdown_budget');
    if (
      !dependencies
      || typeof dependencies.createGatewayDependencies !== 'function'
      || (dependencies.serveGateway !== undefined && typeof dependencies.serveGateway !== 'function')
      || (dependencies.isSecureRequest !== undefined && typeof dependencies.isSecureRequest !== 'function')
    ) throw new MistralRealtimeUpgradeConfigurationError('invalid_dependencies');
    const conversationV2 = dependencies.conversationV2;
    if (
      conversationV2 !== undefined
      && (
        !conversationV2
        || typeof conversationV2 !== 'object'
        || typeof conversationV2.createGatewayDependencies !== 'function'
        || (conversationV2.serveGateway !== undefined
          && typeof conversationV2.serveGateway !== 'function')
      )
    ) throw new MistralRealtimeUpgradeConfigurationError('invalid_dependencies');

    this.path = path;
    this.allowedBrowserOrigins = new Set(settings.allowedBrowserOrigins);
    this.maxConnections = settings.maxConnections;
    this.shutdownGraceMs = shutdownGraceMs;
    this.createGatewayDependencies = dependencies.createGatewayDependencies;
    this.serveGateway = dependencies.serveGateway ?? serveMistralRealtimeGateway;
    this.conversationV2 = conversationV2
      ? {
          createGatewayDependencies: conversationV2.createGatewayDependencies,
          serveGateway: conversationV2.serveGateway ?? serveMistralConversationGatewayV2,
        }
      : null;
    this.isSecureRequest = dependencies.isSecureRequest ?? defaultSecureRequest;
    this.websocketServer = new WebSocketServer({
      noServer: true,
      clientTracking: true,
      maxPayload: MISTRAL_REALTIME_MAX_PAYLOAD_BYTES,
      perMessageDeflate: false,
      skipUTF8Validation: false,
      handleProtocols: (protocols) => {
        if (protocols.size !== 1) return false;
        if (protocols.has(MISTRAL_PCM_GATEWAY_PROTOCOL)) return MISTRAL_PCM_GATEWAY_PROTOCOL;
        return this.conversationV2 && protocols.has(MISTRAL_CONVERSATION_PROTOCOL)
          ? MISTRAL_CONVERSATION_PROTOCOL
          : false;
      },
    });
    this.websocketServer.on('wsClientError', (_error, clientSocket) => {
      rejectUpgrade(clientSocket);
    });
  }

  attach(server: HttpServer): void {
    if (this.shuttingDown) throw new MistralRealtimeUpgradeConfigurationError('adapter_shutdown');
    if (this.attachedServer === server) return;
    if (this.attachedServer) throw new MistralRealtimeUpgradeConfigurationError('already_attached');
    this.attachedServer = server;
    server.on('upgrade', this.onUpgrade);
  }

  detach(): void {
    if (!this.attachedServer) return;
    this.attachedServer.off('upgrade', this.onUpgrade);
    this.attachedServer = null;
  }

  state(): MistralRealtimeUpgradeState {
    return {
      attached: this.attachedServer !== null,
      accepting: !this.shuttingDown && this.attachedServer !== null,
      activeConnections: this.activeConnections,
    };
  }

  shutdown(): Promise<void> {
    this.shutdownPromise ??= this.performShutdown();
    return this.shutdownPromise;
  }

  private accepts(request: IncomingMessage, head: Buffer): boolean {
    if (
      this.shuttingDown
      || request.method !== 'GET'
      || request.httpVersion !== '1.1'
      || request.url !== this.path
      || head.byteLength > MAX_UPGRADE_HEAD_BYTES
    ) return false;

    const upgrade = rawHeaderValues(request, 'upgrade');
    const connection = rawHeaderValues(request, 'connection');
    const protocol = rawHeaderValues(request, 'sec-websocket-protocol');
    const extensions = rawHeaderValues(request, 'sec-websocket-extensions');
    const key = rawHeaderValues(request, 'sec-websocket-key');
    const version = rawHeaderValues(request, 'sec-websocket-version');
    const origin = rawHeaderValues(request, 'origin');
    const legacyOrigin = rawHeaderValues(request, 'sec-websocket-origin');
    if (
      upgrade.length !== 1
      || upgrade[0]?.toLowerCase() !== 'websocket'
      || connection.length !== 1
      || connection[0]?.toLowerCase() !== 'upgrade'
      || protocol.length !== 1
      || (
        protocol[0] !== MISTRAL_PCM_GATEWAY_PROTOCOL
        && (protocol[0] !== MISTRAL_CONVERSATION_PROTOCOL || !this.conversationV2)
      )
      || extensions.length !== 0
      || key.length !== 1
      || !canonicalWebSocketKey(key[0] ?? '')
      || version.length !== 1
      || version[0] !== '13'
      || origin.length > 1
      || legacyOrigin.length !== 0
      || (origin.length === 1 && !this.allowedBrowserOrigins.has(origin[0] ?? ''))
    ) return false;

    try {
      return this.isSecureRequest(request) === true;
    } catch {
      return false;
    }
  }

  private beginSession(socket: WebSocket): void {
    const record: SessionRecord = {
      socket,
      port: new NodeWsGatewaySocket(socket),
      abort: new AbortController(),
      done: Promise.resolve(),
      finalized: false,
    };
    this.sessions.add(record);
    record.done = this.runSession(record);
  }

  private async runSession(record: SessionRecord): Promise<void> {
    let succeeded = false;
    try {
      if (record.socket.protocol === MISTRAL_PCM_GATEWAY_PROTOCOL) {
        const dependencies = this.createGatewayDependencies();
        await this.serveGateway(record.port, dependencies, { signal: record.abort.signal });
      } else if (
        record.socket.protocol === MISTRAL_CONVERSATION_PROTOCOL
        && this.conversationV2
      ) {
        const dependencies = this.conversationV2.createGatewayDependencies();
        await this.conversationV2.serveGateway(
          record.port,
          dependencies,
          { signal: record.abort.signal },
        );
      } else {
        throw new Error('unsupported_websocket_protocol');
      }
      succeeded = true;
    } catch {
      // Le noyau ferme la session avec ses codes publics; aucune erreur interne ne remonte au wire.
    } finally {
      await closeSocketWithin(record.socket, succeeded ? 1000 : 1011, SESSION_CLOSE_GRACE_MS);
      this.finalizeSession(record);
    }
  }

  private finalizeSession(record: SessionRecord): void {
    if (record.finalized) return;
    record.finalized = true;
    record.port.dispose();
    this.sessions.delete(record);
    this.releaseReservation();
  }

  private releaseReservation(): void {
    if (this.activeConnections > 0) this.activeConnections -= 1;
  }

  private async performShutdown(): Promise<void> {
    this.shuttingDown = true;
    this.detach();
    const deadline = Date.now() + this.shutdownGraceMs;
    const snapshot = [...this.sessions];
    for (const record of snapshot) record.abort.abort();
    await waitAtMost(
      Promise.allSettled(snapshot.map((record) => record.done)),
      Math.max(0, deadline - Date.now()),
    );

    for (const record of [...this.sessions]) {
      record.socket.terminate();
      this.finalizeSession(record);
    }

    const websocketServerClosed = new Promise<void>((resolve) => {
      try {
        this.websocketServer.close(() => resolve());
      } catch {
        resolve();
      }
    });
    await waitAtMost(websocketServerClosed, Math.max(0, deadline - Date.now()));
  }
}

export function createMistralRealtimeUpgradeAdapter(
  settings: MistralRealtimeUpgradeSettings,
  dependencies: MistralRealtimeUpgradeDependencies,
): MistralRealtimeUpgradeAdapter {
  return new SecureMistralRealtimeUpgradeAdapter(settings, dependencies);
}
