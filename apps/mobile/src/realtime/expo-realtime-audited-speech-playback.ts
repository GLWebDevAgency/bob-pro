import type { RealtimeVoiceSpeechMimeType } from '@bob/api-client';
import {
  createAudioPlayer,
  setAudioModeAsync,
  type AudioPlayer,
  type AudioStatus,
} from 'expo-audio';
import { CryptoDigestAlgorithm, digest, randomUUID } from 'expo-crypto';
import { File, FileMode, Paths, type FileHandle } from 'expo-file-system';
import { fetch as expoFetch } from 'expo/fetch';
import {
  processAudioSession,
  type ProcessAudioLease,
} from '../audio';
import type {
  RealtimeAuditedSpeechPlaybackPort,
  RealtimeSpeechDownloadRequest,
  RealtimeVerifiedSpeechAudio,
} from './realtime-audited-speech-player';

const HARD_MAX_AUDIO_BYTES = 2 * 1024 * 1024;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 10_000;
const DEFAULT_PLAYBACK_TIMEOUT_MS = 60_000;
const MAX_DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_PLAYBACK_TIMEOUT_MS = 120_000;
const MAX_SOURCE_URL_CHARS = 4 * 1024;
const MAX_STREAM_CHUNKS = 8_192;
const SIGNATURE_PREFIX_BYTES = 16;
const SHA_256_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_STORAGE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/u;
const SAFE_BUCKET = /^[a-z0-9](?:[a-z0-9._-]{0,61}[a-z0-9])?$/u;
const SAFE_SIGNED_QUERY = /^\?token=[A-Za-z0-9._~-]+$/u;
const ALLOWED_MIME_TYPES = new Set<RealtimeVoiceSpeechMimeType>([
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
  'audio/webm',
  'audio/mp4',
  'audio/aac',
  'audio/flac',
]);

export const EXPO_REALTIME_AUDITED_SPEECH_LIMITS = Object.freeze({
  maximumAudioBytes: HARD_MAX_AUDIO_BYTES,
  maximumSourceUrlCharacters: MAX_SOURCE_URL_CHARS,
  maximumDownloadTimeoutMs: MAX_DOWNLOAD_TIMEOUT_MS,
  maximumPlaybackTimeoutMs: MAX_PLAYBACK_TIMEOUT_MS,
} as const);

export type ExpoRealtimeAuditedSpeechErrorCode =
  | 'INVALID_CONFIG'
  | 'INVALID_REQUEST'
  | 'SOURCE_NOT_ALLOWED'
  | 'AUDIO_NOT_OWNED'
  | 'ABORTED'
  | 'DOWNLOAD_TIMEOUT'
  | 'DOWNLOAD_FAILED'
  | 'INVALID_RESPONSE'
  | 'AUDIO_TOO_LARGE'
  | 'AUDIO_INTEGRITY_FAILED'
  | 'PLAYBACK_TIMEOUT'
  | 'PLAYBACK_FAILED'
  | 'INVALID_HANDLE'
  | 'CLEANUP_FAILED';

/**
 * Erreur volontairement opaque. Elle ne conserve jamais l'URL signée, les octets audio, le
 * chemin du cache, le token Supabase ou une erreur native comme `cause`.
 */
export class ExpoRealtimeAuditedSpeechError extends Error {
  constructor(readonly code: ExpoRealtimeAuditedSpeechErrorCode) {
    super(`Realtime audited speech ${code.toLowerCase().replaceAll('_', ' ')}.`);
    this.name = 'ExpoRealtimeAuditedSpeechError';
  }
}

export interface ExpoRealtimeAuditedSpeechPlaybackConfig {
  /** Origine Supabase de confiance, sans chemin ni query (ex. https://project.supabase.co). */
  readonly supabaseUrl: string;
  readonly bucket: string;
  /** Le chemin signé est obligatoirement lié à ce tenant. */
  readonly companyId: string;
  /** Lease déjà acquis par le transport WebRTC. Le player ne crée jamais un second owner audio. */
  readonly audioLease: ProcessAudioLease;
  readonly downloadTimeoutMs?: number;
  readonly playbackTimeoutMs?: number;
}

interface NativeResponseHeaders {
  get(name: string): string | null;
}

interface NativeResponseBody {
  getReader(): ReadableStreamDefaultReader<Uint8Array>;
  cancel(reason?: unknown): Promise<void>;
}

interface NativeFetchResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly url: string;
  readonly redirected: boolean;
  readonly headers: NativeResponseHeaders;
  readonly body: NativeResponseBody | null;
}

interface NativeWritableFileHandle {
  writeBytes(bytes: Uint8Array): void;
  close(): void;
}

export interface ExpoRealtimeAuditedSpeechPrivateFile {
  readonly uri: string;
  readonly exists: boolean;
  readonly size: number;
  create(): void;
  openForWrite(): NativeWritableFileHandle;
  bytes(): Promise<Uint8Array>;
  delete(): void;
}

interface NativePlaybackStatus {
  readonly didJustFinish: boolean;
  readonly error: string | null;
  readonly mediaServicesDidReset?: boolean;
}

interface NativePlaybackSubscription {
  remove(): void;
}

export interface ExpoRealtimeAuditedSpeechNativePlayer {
  play(): void;
  pause(): void;
  remove(): void;
  addStatusListener(listener: (status: NativePlaybackStatus) => void): NativePlaybackSubscription;
}

export interface ExpoRealtimeAuditedSpeechRuntime {
  fetch(
    url: string,
    init: {
      readonly method: 'GET';
      readonly credentials: 'omit';
      readonly redirect: 'manual';
      readonly headers: Readonly<Record<string, string>>;
      readonly signal: AbortSignal;
    },
  ): Promise<NativeFetchResponse>;
  createPrivateFile(extension: string): ExpoRealtimeAuditedSpeechPrivateFile;
  sha256(bytes: Uint8Array): Promise<string>;
  preparePlayback(): Promise<void>;
  createPlayer(localUri: string): ExpoRealtimeAuditedSpeechNativePlayer;
  ownsAudioLease(lease: ProcessAudioLease): boolean;
}

interface VerifiedHandleState {
  readonly file: ExpoRealtimeAuditedSpeechPrivateFile;
  readonly sha256: string;
  readonly mimeType: RealtimeVoiceSpeechMimeType;
  readonly byteSize: number;
  released: boolean;
}

interface ActivePlayback {
  readonly state: VerifiedHandleState;
  readonly player: ExpoRealtimeAuditedSpeechNativePlayer;
  readonly subscription: NativePlaybackSubscription;
  readonly reject: (error: ExpoRealtimeAuditedSpeechError) => void;
  readonly abortSignal: AbortSignal;
  readonly abortListener: () => void;
  readonly timeout: ReturnType<typeof setTimeout>;
  settled: boolean;
}

function fail(code: ExpoRealtimeAuditedSpeechErrorCode): never {
  throw new ExpoRealtimeAuditedSpeechError(code);
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    return fail('INVALID_CONFIG');
  }
  return value;
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return typeof value === 'object'
    && value !== null
    && typeof (value as AbortSignal).aborted === 'boolean'
    && typeof (value as AbortSignal).addEventListener === 'function'
    && typeof (value as AbortSignal).removeEventListener === 'function';
}

function extensionForMime(mimeType: RealtimeVoiceSpeechMimeType): string {
  switch (mimeType) {
    case 'audio/mpeg': return 'mp3';
    case 'audio/wav': return 'wav';
    case 'audio/ogg': return 'ogg';
    case 'audio/webm': return 'webm';
    case 'audio/mp4': return 'm4a';
    case 'audio/aac': return 'aac';
    case 'audio/flac': return 'flac';
  }
}

function normalizedMime(value: string | null): string | null {
  if (value === null) return null;
  const [mime, ...parameters] = value.split(';');
  if (parameters.length > 0) return null;
  return mime?.trim().toLowerCase() || null;
}

function exactHeaderInteger(value: string | null): number | null {
  if (value === null) return null;
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) return fail('INVALID_RESPONSE');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return fail('INVALID_RESPONSE');
  return parsed;
}

function bytesEqualPrefix(bytes: Uint8Array, expected: readonly number[], offset = 0): boolean {
  if (bytes.byteLength < offset + expected.length) return false;
  return expected.every((value, index) => bytes[offset + index] === value);
}

/** Vérifie le conteneur/codec, indépendamment du header HTTP contrôlé par le stockage. */
export function hasRealtimeSpeechAudioSignature(
  mimeType: RealtimeVoiceSpeechMimeType,
  prefix: Uint8Array,
): boolean {
  switch (mimeType) {
    case 'audio/mpeg':
      return bytesEqualPrefix(prefix, [0x49, 0x44, 0x33])
        || (prefix.byteLength >= 2
          && prefix[0] === 0xff
          && (prefix[1]! & 0xe0) === 0xe0
          && (prefix[1]! & 0x06) !== 0);
    case 'audio/wav':
      return bytesEqualPrefix(prefix, [0x52, 0x49, 0x46, 0x46])
        && bytesEqualPrefix(prefix, [0x57, 0x41, 0x56, 0x45], 8);
    case 'audio/ogg':
      return bytesEqualPrefix(prefix, [0x4f, 0x67, 0x67, 0x53]);
    case 'audio/webm':
      return bytesEqualPrefix(prefix, [0x1a, 0x45, 0xdf, 0xa3]);
    case 'audio/mp4':
      return bytesEqualPrefix(prefix, [0x66, 0x74, 0x79, 0x70], 4);
    case 'audio/aac':
      return bytesEqualPrefix(prefix, [0x41, 0x44, 0x49, 0x46])
        || (prefix.byteLength >= 2
          && prefix[0] === 0xff
          && (prefix[1]! & 0xf6) === 0xf0);
    case 'audio/flac':
      return bytesEqualPrefix(prefix, [0x66, 0x4c, 0x61, 0x43]);
  }
}

function constantTimeHexEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function safeDelete(file: ExpoRealtimeAuditedSpeechPrivateFile): void {
  try {
    if (file.exists) file.delete();
    if (file.exists) fail('CLEANUP_FAILED');
  } catch (error) {
    if (error instanceof ExpoRealtimeAuditedSpeechError) throw error;
    fail('CLEANUP_FAILED');
  }
}

/**
 * Rend l'attente JS bornée même si un binding natif défectueux ne résout jamais sa Promise.
 * Le signal est également transmis à `expo/fetch`/au reader pour annuler la ressource physique.
 */
function awaitWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new ExpoRealtimeAuditedSpeechError('ABORTED'));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (result: { ok: true; value: T } | { ok: false }): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (result.ok) resolve(result.value);
      else reject(new ExpoRealtimeAuditedSpeechError('DOWNLOAD_FAILED'));
    };
    const onAbort = (): void => finish({ ok: false });
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => finish({ ok: true, value }),
      () => finish({ ok: false }),
    );
    if (signal.aborted) onAbort();
  });
}

class ExpoPrivateFile implements ExpoRealtimeAuditedSpeechPrivateFile {
  constructor(private readonly file: File) {}

  get uri(): string { return this.file.uri; }
  get exists(): boolean { return this.file.exists; }
  get size(): number { return this.file.size; }

  create(): void {
    this.file.create({ overwrite: false });
  }

  openForWrite(): NativeWritableFileHandle {
    const handle: FileHandle = this.file.open(FileMode.WriteOnly);
    return {
      writeBytes: (bytes) => handle.writeBytes(bytes),
      close: () => handle.close(),
    };
  }

  bytes(): Promise<Uint8Array> {
    return this.file.bytes();
  }

  delete(): void {
    this.file.delete();
  }
}

class ExpoNativePlayer implements ExpoRealtimeAuditedSpeechNativePlayer {
  constructor(private readonly player: AudioPlayer) {}

  play(): void { this.player.play(); }
  pause(): void { this.player.pause(); }
  remove(): void { this.player.remove(); }

  addStatusListener(listener: (status: NativePlaybackStatus) => void): NativePlaybackSubscription {
    const subscription = this.player.addListener('playbackStatusUpdate', (status: AudioStatus) => {
      listener({
        didJustFinish: status.didJustFinish,
        error: status.error,
        mediaServicesDidReset: status.mediaServicesDidReset,
      });
    });
    return { remove: () => subscription.remove() };
  }
}

const expoRealtimeAuditedSpeechRuntime: ExpoRealtimeAuditedSpeechRuntime = {
  fetch: (url, init) => expoFetch(url, init) as unknown as Promise<NativeFetchResponse>,
  createPrivateFile: (extension) => new ExpoPrivateFile(
    new File(Paths.cache, `bob-live-audited-${randomUUID()}.${extension}`),
  ),
  sha256: async (bytes) => {
    const ownedBytes = new Uint8Array(new ArrayBuffer(bytes.byteLength));
    ownedBytes.set(bytes);
    try {
      const hashed = new Uint8Array(await digest(CryptoDigestAlgorithm.SHA256, ownedBytes));
      return [...hashed].map((value) => value.toString(16).padStart(2, '0')).join('');
    } finally {
      ownedBytes.fill(0);
    }
  },
  preparePlayback: () => setAudioModeAsync({
    allowsRecording: true,
    interruptionMode: 'doNotMix',
    playsInSilentMode: true,
    shouldPlayInBackground: false,
    shouldRouteThroughEarpiece: false,
  }),
  createPlayer: (localUri) => new ExpoNativePlayer(createAudioPlayer(
    { uri: localUri },
    {
      downloadFirst: false,
      keepAudioSessionActive: true,
      preferredForwardBufferDuration: 0,
      updateInterval: 50,
    },
  )),
  ownsAudioLease: (lease) => processAudioSession.isCurrent(lease),
};

/**
 * Adaptateur Expo du canal acoustique audité.
 *
 * Garanties natives et limites explicites :
 * - `expo/fetch` reçoit le signal physique et `redirect: 'manual'`; toute redirection, URL finale
 *   différente ou réponse non 200 est refusée avant d'écrire un octet lisible.
 * - le flux est écrit dans le cache privé de l'application, borné à 2 Mio, puis relu au maximum
 *   une fois pour le SHA-256 natif. `expo-crypto.digest` n'est pas interruptible pendant cet appel
 *   court : le signal est donc vérifié avant et après, et un résultat arrivé après annulation est
 *   détruit sans être joué (fail-closed).
 * - Expo ne peut pas exécuter `finally` après un kill brutal du processus. Les artefacts ne vont
 *   jamais dans Documents/backup : ils restent dans le cache sandboxé, supprimés sur chaque chemin
 *   normal/erreur/release et éligibles à la purge OS après crash.
 * - le barge-in appelle synchronement `pause()` puis `remove()`. La dernière trame déjà remise au
 *   DAC natif ne peut pas être reprise par JavaScript, mais aucun réseau ni await ne précède l'arrêt.
 */
export class ExpoRealtimeAuditedSpeechPlayback implements RealtimeAuditedSpeechPlaybackPort {
  private readonly allowedOrigin: string;
  private readonly signedPathPrefix: string;
  private readonly audioLease: ProcessAudioLease;
  private readonly downloadTimeoutMs: number;
  private readonly playbackTimeoutMs: number;
  private readonly handles = new WeakMap<object, VerifiedHandleState>();
  private activePlayback: ActivePlayback | null = null;

  constructor(
    config: ExpoRealtimeAuditedSpeechPlaybackConfig,
    private readonly runtime: ExpoRealtimeAuditedSpeechRuntime = expoRealtimeAuditedSpeechRuntime,
  ) {
    let base: URL;
    try {
      base = new URL(config?.supabaseUrl);
    } catch {
      fail('INVALID_CONFIG');
    }
    if (base.protocol !== 'https:'
      || base.username !== ''
      || base.password !== ''
      || base.pathname !== '/'
      || base.search !== ''
      || base.hash !== ''
      || !SAFE_BUCKET.test(config.bucket)
      || !SAFE_STORAGE_SEGMENT.test(config.companyId)
      || !config.audioLease
      || config.audioLease.mode !== 'realtime') {
      fail('INVALID_CONFIG');
    }
    this.allowedOrigin = base.origin;
    this.signedPathPrefix = `/storage/v1/object/sign/${config.bucket}/companies/${config.companyId}/bob-live/`;
    this.audioLease = config.audioLease;
    this.downloadTimeoutMs = boundedInteger(
      config.downloadTimeoutMs,
      DEFAULT_DOWNLOAD_TIMEOUT_MS,
      250,
      MAX_DOWNLOAD_TIMEOUT_MS,
    );
    this.playbackTimeoutMs = boundedInteger(
      config.playbackTimeoutMs,
      DEFAULT_PLAYBACK_TIMEOUT_MS,
      1_000,
      MAX_PLAYBACK_TIMEOUT_MS,
    );
  }

  async downloadVerified(
    request: RealtimeSpeechDownloadRequest,
    signal: AbortSignal,
  ): Promise<RealtimeVerifiedSpeechAudio> {
    this.assertRequest(request, signal);
    this.assertAudioOwnership();
    const sourceUrl = this.assertAllowedSource(request.sourceUrl);
    const internalAbort = new AbortController();
    const abortFromCaller = (): void => internalAbort.abort();
    signal.addEventListener('abort', abortFromCaller, { once: true });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      internalAbort.abort();
    }, this.downloadTimeoutMs);
    let file: ExpoRealtimeAuditedSpeechPrivateFile | null = null;

    try {
      this.throwIfAborted(signal, internalAbort.signal, timedOut);
      let response: NativeFetchResponse;
      try {
        response = await awaitWithAbort(
          this.runtime.fetch(sourceUrl, {
            method: 'GET',
            credentials: 'omit',
            redirect: 'manual',
            headers: Object.freeze({ Accept: request.expectedMimeType }),
            signal: internalAbort.signal,
          }),
          internalAbort.signal,
        );
      } catch {
        this.throwIfAborted(signal, internalAbort.signal, timedOut);
        return fail('DOWNLOAD_FAILED');
      }
      this.throwIfAborted(signal, internalAbort.signal, timedOut);
      this.assertResponse(response, sourceUrl, request);
      if (!response.body) return fail('INVALID_RESPONSE');

      file = this.runtime.createPrivateFile(extensionForMime(request.expectedMimeType));
      try {
        file.create();
      } catch {
        return fail('DOWNLOAD_FAILED');
      }

      const prefix = await this.streamToFile(
        response.body,
        file,
        request.maximumBytes,
        request.expectedByteSize,
        signal,
        internalAbort.signal,
        () => timedOut,
      );
      this.throwIfAborted(signal, internalAbort.signal, timedOut);
      this.assertAudioOwnership();
      if (file.size !== request.expectedByteSize
        || !hasRealtimeSpeechAudioSignature(request.expectedMimeType, prefix)) {
        return fail('AUDIO_INTEGRITY_FAILED');
      }

      let bytes: Uint8Array;
      try {
        bytes = await file.bytes();
      } catch {
        return fail('DOWNLOAD_FAILED');
      }
      try {
        if (bytes.byteLength !== request.expectedByteSize) return fail('AUDIO_INTEGRITY_FAILED');
        this.throwIfAborted(signal, internalAbort.signal, timedOut);
        const actualSha256 = (await this.runtime.sha256(bytes)).toLowerCase();
        this.throwIfAborted(signal, internalAbort.signal, timedOut);
        this.assertAudioOwnership();
        if (!SHA_256_PATTERN.test(actualSha256)
          || !constantTimeHexEqual(actualSha256, request.expectedSha256)) {
          return fail('AUDIO_INTEGRITY_FAILED');
        }

        const opaqueHandle = Object.freeze({});
        const state: VerifiedHandleState = {
          file,
          sha256: actualSha256,
          mimeType: request.expectedMimeType,
          byteSize: bytes.byteLength,
          released: false,
        };
        this.handles.set(opaqueHandle, state);
        file = null;
        return Object.freeze({
          opaqueHandle,
          sha256: actualSha256,
          mimeType: request.expectedMimeType,
          byteSize: bytes.byteLength,
        });
      } finally {
        bytes.fill(0);
      }
    } catch (error) {
      if (error instanceof ExpoRealtimeAuditedSpeechError) throw error;
      return fail('DOWNLOAD_FAILED');
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abortFromCaller);
      if (file) safeDelete(file);
    }
  }

  async play(audio: RealtimeVerifiedSpeechAudio, signal: AbortSignal): Promise<void> {
    if (!isAbortSignal(signal)) return fail('INVALID_REQUEST');
    if (signal.aborted) return fail('ABORTED');
    this.assertAudioOwnership();
    const state = this.resolveHandle(audio);
    if (this.activePlayback) return fail('PLAYBACK_FAILED');

    try {
      await this.runtime.preparePlayback();
    } catch {
      return fail('PLAYBACK_FAILED');
    }
    if (signal.aborted) return fail('ABORTED');
    this.assertAudioOwnership();

    let player: ExpoRealtimeAuditedSpeechNativePlayer;
    try {
      player = this.runtime.createPlayer(state.file.uri);
    } catch {
      return fail('PLAYBACK_FAILED');
    }

    await new Promise<void>((resolve, reject) => {
      let subscription: NativePlaybackSubscription;
      let pendingStatus: NativePlaybackStatus | null = null;
      let playInvoked = false;
      const settle = (error?: ExpoRealtimeAuditedSpeechError): void => {
        const active = this.activePlayback;
        if (!active || active.player !== player || active.settled) return;
        active.settled = true;
        this.activePlayback = null;
        clearTimeout(active.timeout);
        active.abortSignal.removeEventListener('abort', active.abortListener);
        try { active.subscription.remove(); } catch { /* ressource native déjà libérée */ }
        try { player.pause(); } catch { /* remove reste autoritaire */ }
        try { player.remove(); } catch { /* l'erreur reste opaque */ }
        if (error) reject(error);
        else resolve();
      };
      const onAbort = (): void => settle(new ExpoRealtimeAuditedSpeechError('ABORTED'));
      const onStatus = (status: NativePlaybackStatus): void => {
        if (!this.activePlayback) {
          pendingStatus = status;
          return;
        }
        if (!this.ownsAudioLease()) {
          settle(new ExpoRealtimeAuditedSpeechError('AUDIO_NOT_OWNED'));
        } else if (status.error || status.mediaServicesDidReset) {
          settle(new ExpoRealtimeAuditedSpeechError('PLAYBACK_FAILED'));
        } else if (playInvoked && status.didJustFinish) {
          settle();
        }
      };
      try {
        subscription = player.addStatusListener(onStatus);
      } catch {
        try { player.remove(); } catch { /* best-effort immédiat */ }
        reject(new ExpoRealtimeAuditedSpeechError('PLAYBACK_FAILED'));
        return;
      }
      const playbackTimeout = setTimeout(
        () => settle(new ExpoRealtimeAuditedSpeechError('PLAYBACK_TIMEOUT')),
        this.playbackTimeoutMs,
      );
      this.activePlayback = {
        state,
        player,
        subscription,
        reject: (error) => settle(error),
        abortSignal: signal,
        abortListener: onAbort,
        timeout: playbackTimeout,
        settled: false,
      };
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted || !this.ownsAudioLease()) {
        settle(new ExpoRealtimeAuditedSpeechError(signal.aborted ? 'ABORTED' : 'AUDIO_NOT_OWNED'));
        return;
      }
      if (pendingStatus) {
        onStatus(pendingStatus);
        if (!this.activePlayback) return;
      }
      try {
        playInvoked = true;
        player.play();
      } catch {
        settle(new ExpoRealtimeAuditedSpeechError('PLAYBACK_FAILED'));
      }
    });
  }

  /** Aucun await : pause puis destruction du player natif sur la même pile JS. */
  stopImmediately(): void {
    const active = this.activePlayback;
    if (!active || active.settled) return;
    active.reject(new ExpoRealtimeAuditedSpeechError('ABORTED'));
  }

  release(audio: RealtimeVerifiedSpeechAudio): void {
    const state = this.resolveHandle(audio);
    if (this.activePlayback?.state === state) this.stopImmediately();
    safeDelete(state.file);
    state.released = true;
    if (typeof audio.opaqueHandle === 'object' && audio.opaqueHandle !== null) {
      this.handles.delete(audio.opaqueHandle);
    }
  }

  private assertRequest(request: RealtimeSpeechDownloadRequest, signal: AbortSignal): void {
    if (!request
      || !isAbortSignal(signal)
      || signal.aborted
      || typeof request.sourceUrl !== 'string'
      || request.sourceUrl.length === 0
      || request.sourceUrl.length > MAX_SOURCE_URL_CHARS
      || !SHA_256_PATTERN.test(request.expectedSha256)
      || !ALLOWED_MIME_TYPES.has(request.expectedMimeType)
      || !Number.isSafeInteger(request.expectedByteSize)
      || request.expectedByteSize <= 0
      || !Number.isSafeInteger(request.maximumBytes)
      || request.maximumBytes <= 0
      || request.maximumBytes > HARD_MAX_AUDIO_BYTES
      || request.expectedByteSize > request.maximumBytes) {
      fail(signal?.aborted ? 'ABORTED' : 'INVALID_REQUEST');
    }
  }

  private assertAllowedSource(value: string): string {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return fail('SOURCE_NOT_ALLOWED');
    }
    const suffix = parsed.pathname.slice(this.signedPathPrefix.length);
    const segments = suffix.split('/');
    if (parsed.protocol !== 'https:'
      || parsed.origin !== this.allowedOrigin
      || parsed.username !== ''
      || parsed.password !== ''
      || parsed.hash !== ''
      || !parsed.pathname.startsWith(this.signedPathPrefix)
      || segments.length !== 3
      || segments.some((segment) => !SAFE_STORAGE_SEGMENT.test(segment))
      || !SAFE_SIGNED_QUERY.test(parsed.search)
      || parsed.searchParams.getAll('token').length !== 1
      || [...parsed.searchParams.keys()].some((key) => key !== 'token')
      || parsed.toString() !== value) {
      return fail('SOURCE_NOT_ALLOWED');
    }
    return value;
  }

  private assertResponse(
    response: NativeFetchResponse,
    sourceUrl: string,
    request: RealtimeSpeechDownloadRequest,
  ): void {
    if (!response
      || !response.ok
      || response.status !== 200
      || response.redirected
      || response.url !== sourceUrl) {
      void response?.body?.cancel('bob-live-response-rejected').catch(() => undefined);
      fail('INVALID_RESPONSE');
    }
    this.assertAllowedSource(response.url);
    const contentEncoding = response.headers.get('content-encoding');
    if (contentEncoding !== null && contentEncoding.trim().toLowerCase() !== 'identity') {
      void response.body?.cancel('bob-live-content-encoding-rejected').catch(() => undefined);
      fail('INVALID_RESPONSE');
    }
    if (normalizedMime(response.headers.get('content-type')) !== request.expectedMimeType) {
      void response.body?.cancel('bob-live-content-type-rejected').catch(() => undefined);
      fail('INVALID_RESPONSE');
    }
    const announcedSize = exactHeaderInteger(response.headers.get('content-length'));
    if (announcedSize !== null && announcedSize !== request.expectedByteSize) {
      void response.body?.cancel('bob-live-content-length-rejected').catch(() => undefined);
      fail(announcedSize > request.maximumBytes ? 'AUDIO_TOO_LARGE' : 'INVALID_RESPONSE');
    }
  }

  private async streamToFile(
    body: NativeResponseBody,
    file: ExpoRealtimeAuditedSpeechPrivateFile,
    maximumBytes: number,
    expectedBytes: number,
    callerSignal: AbortSignal,
    internalSignal: AbortSignal,
    timedOut: () => boolean,
  ): Promise<Uint8Array> {
    const reader = body.getReader();
    const cancelReader = (): void => {
      void reader.cancel('bob-live-download-aborted').catch(() => undefined);
    };
    internalSignal.addEventListener('abort', cancelReader, { once: true });
    let writer: NativeWritableFileHandle | null = null;
    let totalBytes = 0;
    let chunks = 0;
    const prefix = new Uint8Array(Math.min(SIGNATURE_PREFIX_BYTES, expectedBytes));
    let prefixLength = 0;

    try {
      writer = file.openForWrite();
      let complete = false;
      while (!complete) {
        this.throwIfAborted(callerSignal, internalSignal, timedOut());
        const item = await awaitWithAbort(reader.read(), internalSignal);
        this.throwIfAborted(callerSignal, internalSignal, timedOut());
        if (item.done) {
          complete = true;
          continue;
        }
        if (!(item.value instanceof Uint8Array)) return fail('INVALID_RESPONSE');
        chunks += 1;
        if (chunks > MAX_STREAM_CHUNKS) {
          void reader.cancel('bob-live-too-many-chunks').catch(() => undefined);
          return fail('INVALID_RESPONSE');
        }
        if (item.value.byteLength === 0) continue;
        totalBytes += item.value.byteLength;
        if (totalBytes > maximumBytes || totalBytes > expectedBytes) {
          void reader.cancel('bob-live-audio-too-large').catch(() => undefined);
          return fail('AUDIO_TOO_LARGE');
        }
        if (prefixLength < prefix.byteLength) {
          const length = Math.min(item.value.byteLength, prefix.byteLength - prefixLength);
          prefix.set(item.value.subarray(0, length), prefixLength);
          prefixLength += length;
        }
        this.assertAudioOwnership();
        writer.writeBytes(item.value);
      }
      if (totalBytes !== expectedBytes) return fail('AUDIO_INTEGRITY_FAILED');
      return prefix;
    } catch (error) {
      this.throwIfAborted(callerSignal, internalSignal, timedOut());
      if (error instanceof ExpoRealtimeAuditedSpeechError) throw error;
      return fail('DOWNLOAD_FAILED');
    } finally {
      internalSignal.removeEventListener('abort', cancelReader);
      try { writer?.close(); } catch { /* le cleanup du fichier reste obligatoire */ }
      try { reader.releaseLock(); } catch { /* flux déjà annulé */ }
    }
  }

  private resolveHandle(audio: RealtimeVerifiedSpeechAudio): VerifiedHandleState {
    const opaque = audio?.opaqueHandle;
    if (typeof opaque !== 'object' || opaque === null) return fail('INVALID_HANDLE');
    const state = this.handles.get(opaque);
    if (!state
      || state.released
      || audio.sha256 !== state.sha256
      || audio.mimeType !== state.mimeType
      || audio.byteSize !== state.byteSize
      || !state.file.exists
      || state.file.size !== state.byteSize) {
      return fail('INVALID_HANDLE');
    }
    return state;
  }

  private assertAudioOwnership(): void {
    if (!this.ownsAudioLease()) fail('AUDIO_NOT_OWNED');
  }

  private ownsAudioLease(): boolean {
    try {
      return this.runtime.ownsAudioLease(this.audioLease);
    } catch {
      return false;
    }
  }

  private throwIfAborted(
    callerSignal: AbortSignal,
    internalSignal: AbortSignal,
    timedOut: boolean,
  ): void {
    if (callerSignal.aborted) fail('ABORTED');
    if (internalSignal.aborted) fail(timedOut ? 'DOWNLOAD_TIMEOUT' : 'ABORTED');
  }
}
