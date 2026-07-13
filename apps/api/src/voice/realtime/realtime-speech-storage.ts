import { createHash } from 'node:crypto';
import {
  REALTIME_SPEECH_ALLOWED_MIME_TYPES,
  REALTIME_SPEECH_RENDER_LIMITS,
  type RealtimeSpeechMimeType,
} from './realtime-speech-renderer';

const DEFAULT_BUCKET = 'bob-live-audio';
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_REQUEST_TIMEOUT_MS = 30_000;
const MAX_SIGNED_URL_TTL_SECONDS = 30;
const MAX_STORAGE_RESPONSE_BYTES = 8 * 1024;
const MAX_SIGNED_URL_LENGTH = 4 * 1024;
const MAX_BASE_URL_LENGTH = 2 * 1024;
const MAX_SERVICE_ROLE_KEY_LENGTH = 16 * 1024;
const SAFE_STORAGE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/u;
const SAFE_BUCKET = /^[a-z0-9](?:[a-z0-9._-]{0,61}[a-z0-9])?$/u;
const SAFE_SERVICE_ROLE_KEY = /^[\x21-\x7e]+$/u;
const SAFE_SIGNED_TOKEN = /^[A-Za-z0-9._~-]+$/u;
const ALLOWED_MIME_TYPES = new Set<string>(REALTIME_SPEECH_ALLOWED_MIME_TYPES);
const ABORT_REASON = Object.freeze({ code: 'bob_live_storage_aborted' });
const TIMEOUT_REASON = Object.freeze({ code: 'bob_live_storage_timeout' });

export const REALTIME_SPEECH_STORAGE_LIMITS = Object.freeze({
  maxAudioBytes: REALTIME_SPEECH_RENDER_LIMITS.maxAudioBytes,
  maxSignedUrlTtlSeconds: MAX_SIGNED_URL_TTL_SECONDS,
  maxResponseBytes: MAX_STORAGE_RESPONSE_BYTES,
} as const);

export type RealtimeSpeechStorageErrorCode =
  | 'INVALID_INPUT'
  | 'ABORTED'
  | 'TIMEOUT'
  | 'ALREADY_EXISTS'
  | 'NOT_FOUND'
  | 'RESPONSE_TOO_LARGE'
  | 'INVALID_RESPONSE'
  | 'UNAVAILABLE';

/**
 * Erreur volontairement opaque : ni clé objet, ni URL signée, ni réponse fournisseur, ni secret
 * ne sont conservés dans le message ou comme `cause`.
 */
export class RealtimeSpeechStorageError extends Error {
  constructor(readonly code: RealtimeSpeechStorageErrorCode) {
    super(`Realtime speech storage ${code.toLowerCase()}.`);
    this.name = 'RealtimeSpeechStorageError';
  }
}

export interface RealtimeSpeechStorageKeyParts {
  readonly companyId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly artifactId: string;
}

export interface RealtimeSpeechStoredArtifact {
  readonly key: string;
  readonly sizeBytes: number;
  readonly audioSha256: string;
  readonly mimeType: RealtimeSpeechMimeType;
}

export interface RealtimeSpeechSignedDownload {
  readonly url: string;
  readonly expiresInSeconds: number;
}

export interface RealtimeSpeechStoragePort {
  /**
   * Écrit un artefact une seule fois. Une clé déjà présente n'est jamais remplacée.
   * L'appelant doit persister l'empreinte retournée avant de rendre l'artefact livrable.
   */
  upload(input: {
    readonly companyId: string;
    readonly key: string;
    readonly bytes: Uint8Array;
    readonly mimeType: RealtimeSpeechMimeType;
    readonly signal: AbortSignal;
  }): Promise<RealtimeSpeechStoredArtifact>;

  /**
   * L'autorisation tenant et l'existence durable de l'artefact doivent être prouvées en base
   * avant cet appel. Le stockage vérifie à nouveau que la clé est dans le préfixe du tenant.
   */
  createSignedDownload(input: {
    readonly companyId: string;
    readonly key: string;
    readonly ttlSeconds?: number;
    readonly signal: AbortSignal;
  }): Promise<RealtimeSpeechSignedDownload>;

  /** Suppression idempotente, y compris quand l'objet est déjà absent. */
  delete(input: {
    readonly companyId: string;
    readonly key: string;
    readonly signal: AbortSignal;
  }): Promise<void>;
}

export type RealtimeSpeechStorageFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface SupabaseRealtimeSpeechStorageConfig {
  readonly url: string;
  readonly serviceRoleKey: string;
  readonly bucket?: string;
  readonly requestTimeoutMs?: number;
}

function storageError(code: RealtimeSpeechStorageErrorCode): never {
  throw new RealtimeSpeechStorageError(code);
}

function isSafeSegment(value: unknown): value is string {
  return typeof value === 'string' && SAFE_STORAGE_SEGMENT.test(value);
}

export function buildRealtimeSpeechStorageKey(parts: RealtimeSpeechStorageKeyParts): string {
  if (!isSafeSegment(parts.companyId)
    || !isSafeSegment(parts.sessionId)
    || !isSafeSegment(parts.turnId)
    || !isSafeSegment(parts.artifactId)) {
    return storageError('INVALID_INPUT');
  }
  return `companies/${parts.companyId}/bob-live/${parts.sessionId}/${parts.turnId}/${parts.artifactId}`;
}

function assertTenantStorageKey(companyId: string, key: string): void {
  if (!isSafeSegment(companyId) || typeof key !== 'string') storageError('INVALID_INPUT');
  const segments = key.split('/');
  if (segments.length !== 6
    || segments[0] !== 'companies'
    || segments[1] !== companyId
    || segments[2] !== 'bob-live'
    || !isSafeSegment(segments[3])
    || !isSafeSegment(segments[4])
    || !isSafeSegment(segments[5])) {
    storageError('INVALID_INPUT');
  }
  const canonical = buildRealtimeSpeechStorageKey({
    companyId,
    sessionId: segments[3],
    turnId: segments[4],
    artifactId: segments[5],
  });
  if (canonical !== key) storageError('INVALID_INPUT');
}

function encodeStoragePath(path: string): string {
  return path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

function isAllowedMimeType(value: unknown): value is RealtimeSpeechMimeType {
  return typeof value === 'string' && ALLOWED_MIME_TYPES.has(value);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function validateSignal(signal: AbortSignal): void {
  if (!(signal instanceof AbortSignal)) storageError('INVALID_INPUT');
}

function cancelBody(response: Response): void {
  // Ne jamais attendre le hook `cancel()` d'un serveur/stream tiers : un hook malveillant ou
  // défectueux ne doit pas retenir le worker au-delà de notre propre timeout.
  void response.body?.cancel('bob-live-storage-response-discarded').catch(() => undefined);
}

function throwIfInternalSignalAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('bob_live_storage_request_cancelled');
}

async function readBoundedBytes(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const announced = response.headers.get('content-length');
  if (announced !== null) {
    if (!/^\d+$/u.test(announced)) {
      cancelBody(response);
      storageError('INVALID_RESPONSE');
    }
    const length = Number(announced);
    if (!Number.isSafeInteger(length) || length > maxBytes) {
      cancelBody(response);
      storageError('RESPONSE_TOO_LARGE');
    }
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const cancelOnAbort = (): void => {
    void reader.cancel('bob-live-storage-request-cancelled').catch(() => undefined);
  };
  signal.addEventListener('abort', cancelOnAbort, { once: true });
  try {
    throwIfInternalSignalAborted(signal);
    let chunk = await reader.read();
    while (!chunk.done) {
      throwIfInternalSignalAborted(signal);
      length += chunk.value.byteLength;
      if (length > maxBytes) {
        void reader.cancel('bob-live-storage-response-too-large').catch(() => undefined);
        storageError('RESPONSE_TOO_LARGE');
      }
      chunks.push(chunk.value);
      chunk = await reader.read();
    }
    throwIfInternalSignalAborted(signal);
  } finally {
    signal.removeEventListener('abort', cancelOnAbort);
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readBoundedJson(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  const bytes = await readBoundedBytes(response, MAX_STORAGE_RESPONSE_BYTES, signal);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    return storageError('INVALID_RESPONSE');
  }
}

async function readOptionalErrorPayload(
  response: Response,
  signal: AbortSignal,
): Promise<Record<string, unknown> | null> {
  const bytes = await readBoundedBytes(response, MAX_STORAGE_RESPONSE_BYTES, signal);
  if (bytes.byteLength === 0) return null;
  try {
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function providerStatus(payload: Record<string, unknown> | null): number | null {
  const raw = payload?.statusCode;
  if (typeof raw === 'number' && Number.isInteger(raw)) return raw;
  if (typeof raw === 'string' && /^\d{3}$/u.test(raw)) return Number(raw);
  return null;
}

function isNotFound(status: number, payload: Record<string, unknown> | null): boolean {
  return status === 404
    || (status === 400
      && (providerStatus(payload) === 404 || payload?.error === 'not_found'));
}

function isAlreadyExists(status: number, payload: Record<string, unknown> | null): boolean {
  return status === 409
    || status === 412
    || (status === 400
      && (providerStatus(payload) === 409 || payload?.error === 'Duplicate'));
}

function validTtlSeconds(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_SIGNED_URL_TTL_SECONDS;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/**
 * Adaptateur REST service-role. Le bucket doit rester privé : aucune opération de lecture publique
 * n'est exposée, et chaque URL de téléchargement est éphémère et liée à une clé tenant stricte.
 */
export class SupabaseRealtimeSpeechStorage implements RealtimeSpeechStoragePort {
  private readonly baseUrl: string;
  private readonly baseOrigin: string;
  private readonly serviceRoleKey: string;
  private readonly bucket: string;
  private readonly requestTimeoutMs: number;

  constructor(
    config: SupabaseRealtimeSpeechStorageConfig,
    private readonly fetchImpl: RealtimeSpeechStorageFetch = fetch,
  ) {
    let parsedUrl: URL;
    if (typeof config?.url !== 'string'
      || config.url.length === 0
      || config.url.length > MAX_BASE_URL_LENGTH) {
      storageError('INVALID_INPUT');
    }
    try {
      parsedUrl = new URL(config.url);
    } catch {
      storageError('INVALID_INPUT');
    }
    if ((parsedUrl.protocol !== 'https:'
        && !(parsedUrl.protocol === 'http:' && isLoopbackHostname(parsedUrl.hostname)))
      || parsedUrl.username !== ''
      || parsedUrl.password !== ''
      || parsedUrl.search !== ''
      || parsedUrl.hash !== '') {
      storageError('INVALID_INPUT');
    }
    const serviceRoleKey = config.serviceRoleKey;
    if (typeof serviceRoleKey !== 'string'
      || serviceRoleKey.length === 0
      || serviceRoleKey.length > MAX_SERVICE_ROLE_KEY_LENGTH
      || serviceRoleKey.trim() !== serviceRoleKey
      || !SAFE_SERVICE_ROLE_KEY.test(serviceRoleKey)) {
      storageError('INVALID_INPUT');
    }
    const bucket = config.bucket ?? DEFAULT_BUCKET;
    const requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!SAFE_BUCKET.test(bucket)
      || !Number.isSafeInteger(requestTimeoutMs)
      || requestTimeoutMs < 1
      || requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS) {
      storageError('INVALID_INPUT');
    }

    this.baseUrl = parsedUrl.toString().replace(/\/+$/u, '');
    this.baseOrigin = parsedUrl.origin;
    this.serviceRoleKey = serviceRoleKey;
    this.bucket = bucket;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  async upload(input: {
    readonly companyId: string;
    readonly key: string;
    readonly bytes: Uint8Array;
    readonly mimeType: RealtimeSpeechMimeType;
    readonly signal: AbortSignal;
  }): Promise<RealtimeSpeechStoredArtifact> {
    validateSignal(input.signal);
    assertTenantStorageKey(input.companyId, input.key);
    if (!(input.bytes instanceof Uint8Array)
      || input.bytes.byteLength < REALTIME_SPEECH_RENDER_LIMITS.minAudioBytes
      || input.bytes.byteLength > REALTIME_SPEECH_RENDER_LIMITS.maxAudioBytes
      || !isAllowedMimeType(input.mimeType)) {
      storageError('INVALID_INPUT');
    }

    // Copie possédée avant le premier await : une mutation concurrente du buffer appelant ne peut
    // modifier ni le flux envoyé, ni son empreinte.
    const bytes = new Uint8Array(input.bytes);
    const audioSha256 = sha256(bytes);
    await this.runRequest(input.signal, async (signal) => {
      const response = await this.fetchImpl(this.objectUrl(input.key), {
        method: 'POST',
        headers: {
          ...this.authorizedHeaders(),
          'cache-control': 'private, no-store, max-age=0',
          'content-type': input.mimeType,
          'x-upsert': 'false',
        },
        body: Buffer.from(bytes),
        redirect: 'error',
        signal,
      });
      if (response.ok) {
        cancelBody(response);
        return;
      }
      const payload = await readOptionalErrorPayload(response, signal);
      if (isAlreadyExists(response.status, payload)) storageError('ALREADY_EXISTS');
      storageError('UNAVAILABLE');
    });

    return {
      key: input.key,
      sizeBytes: bytes.byteLength,
      audioSha256,
      mimeType: input.mimeType,
    };
  }

  async createSignedDownload(input: {
    readonly companyId: string;
    readonly key: string;
    readonly ttlSeconds?: number;
    readonly signal: AbortSignal;
  }): Promise<RealtimeSpeechSignedDownload> {
    validateSignal(input.signal);
    assertTenantStorageKey(input.companyId, input.key);
    const ttlSeconds = input.ttlSeconds ?? MAX_SIGNED_URL_TTL_SECONDS;
    if (!validTtlSeconds(ttlSeconds)) storageError('INVALID_INPUT');

    return this.runRequest(input.signal, async (signal) => {
      const endpoint = this.signUrl(input.key);
      const response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          ...this.authorizedHeaders(),
          accept: 'application/json',
          'cache-control': 'no-store',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ expiresIn: ttlSeconds }),
        redirect: 'error',
        signal,
      });
      if (!response.ok) {
        if (response.status === 404) {
          cancelBody(response);
          storageError('NOT_FOUND');
        }
        const payload = await readOptionalErrorPayload(response, signal);
        if (isNotFound(response.status, payload)) storageError('NOT_FOUND');
        storageError('UNAVAILABLE');
      }
      const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
      if (contentType !== 'application/json') {
        cancelBody(response);
        storageError('INVALID_RESPONSE');
      }
      const payload = await readBoundedJson(response, signal);
      const signedValue = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
        ? ((payload as Record<string, unknown>).signedURL ?? (payload as Record<string, unknown>).signedUrl)
        : undefined;
      if (typeof signedValue !== 'string'
        || signedValue.length === 0
        || signedValue.length > MAX_SIGNED_URL_LENGTH) {
        storageError('INVALID_RESPONSE');
      }
      const url = this.validateSignedUrl(signedValue, endpoint);
      return { url, expiresInSeconds: ttlSeconds };
    });
  }

  async delete(input: {
    readonly companyId: string;
    readonly key: string;
    readonly signal: AbortSignal;
  }): Promise<void> {
    validateSignal(input.signal);
    assertTenantStorageKey(input.companyId, input.key);
    await this.runRequest(input.signal, async (signal) => {
      const response = await this.fetchImpl(this.objectUrl(input.key), {
        method: 'DELETE',
        headers: this.authorizedHeaders(),
        redirect: 'error',
        signal,
      });
      if (response.ok || response.status === 404) {
        cancelBody(response);
        return;
      }
      const payload = await readOptionalErrorPayload(response, signal);
      if (isNotFound(response.status, payload)) return;
      storageError('UNAVAILABLE');
    });
  }

  private objectUrl(key: string): string {
    return `${this.baseUrl}/storage/v1/object/${encodeURIComponent(this.bucket)}/${encodeStoragePath(key)}`;
  }

  private signUrl(key: string): string {
    return `${this.baseUrl}/storage/v1/object/sign/${encodeURIComponent(this.bucket)}/${encodeStoragePath(key)}`;
  }

  private authorizedHeaders(): Record<string, string> {
    return {
      authorization: `Bearer ${this.serviceRoleKey}`,
      apikey: this.serviceRoleKey,
    };
  }

  private validateSignedUrl(value: string, expectedEndpoint: string): string {
    let signed: URL;
    try {
      signed = new URL(value, this.baseOrigin);
    } catch {
      return storageError('INVALID_RESPONSE');
    }
    const expected = new URL(expectedEndpoint);
    const tokens = signed.searchParams.getAll('token');
    const queryKeys = [...signed.searchParams.keys()];
    if (signed.origin !== this.baseOrigin
      || signed.protocol !== expected.protocol
      || signed.username !== ''
      || signed.password !== ''
      || signed.hash !== ''
      || signed.pathname !== expected.pathname
      || tokens.length !== 1
      || tokens[0] === ''
      || tokens[0]!.length > MAX_SIGNED_URL_LENGTH
      || !SAFE_SIGNED_TOKEN.test(tokens[0]!)
      || queryKeys.some((key) => key !== 'token')) {
      storageError('INVALID_RESPONSE');
    }
    const normalized = signed.toString();
    if (normalized.length > MAX_SIGNED_URL_LENGTH) storageError('INVALID_RESPONSE');
    return normalized;
  }

  private async runRequest<T>(
    callerSignal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (callerSignal.aborted) storageError('ABORTED');
    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = (): void => controller.abort(ABORT_REASON);
    callerSignal.addEventListener('abort', abortFromCaller, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(TIMEOUT_REASON);
    }, this.requestTimeoutMs);
    try {
      const result = await operation(controller.signal);
      if (callerSignal.aborted) storageError('ABORTED');
      if (timedOut) storageError('TIMEOUT');
      return result;
    } catch (error) {
      if (callerSignal.aborted) storageError('ABORTED');
      if (timedOut) storageError('TIMEOUT');
      if (error instanceof RealtimeSpeechStorageError) throw error;
      storageError('UNAVAILABLE');
    } finally {
      clearTimeout(timer);
      callerSignal.removeEventListener('abort', abortFromCaller);
    }
  }
}
