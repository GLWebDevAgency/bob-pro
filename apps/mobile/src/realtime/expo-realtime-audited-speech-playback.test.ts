import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.mock('expo/fetch', () => ({ fetch: vi.fn() }));
vi.mock('expo-audio', () => ({
  createAudioPlayer: vi.fn(),
}));
vi.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digest: vi.fn(),
  randomUUID: vi.fn(() => '00000000-0000-4000-8000-000000000001'),
}));
vi.mock('expo-file-system', () => ({
  File: class {},
  FileMode: { WriteOnly: 'w' },
  Paths: { cache: {} },
}));

import type { ProcessAudioLease } from '../audio';
import {
  ExpoRealtimeAuditedSpeechError,
  ExpoRealtimeAuditedSpeechPlayback,
  hasRealtimeSpeechAudioSignature,
  type ExpoRealtimeAuditedSpeechNativePlayer,
  type ExpoRealtimeAuditedSpeechPrivateFile,
  type ExpoRealtimeAuditedSpeechRuntime,
} from './expo-realtime-audited-speech-playback';

const LEASE: ProcessAudioLease = Object.freeze({
  generation: 7,
  mode: 'realtime',
  owner: 'bob-live-webrtc',
  token: Symbol('test-audio-lease'),
});
const SESSION_ID = '00000000-0000-4000-8000-000000000001';
const TURN_ID = '00000000-0000-4000-8000-000000000002';
const ARTIFACT_ID = '00000000-0000-4000-8000-000000000003';
const POLICY = Object.freeze({
  mode: 'signed-url-v1' as const,
  allowedOrigin: 'https://project.supabase.co',
  allowedPathPrefix: `/storage/v1/object/sign/bob-live-audio/companies/company-1/bob-live/${SESSION_ID}/`,
});
const URL = `${POLICY.allowedOrigin}${POLICY.allowedPathPrefix}${TURN_ID}/${ARTIFACT_ID}?token=opaque.token`;
const MP3 = Uint8Array.from([
  0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0xff, 0xfb, 0x90, 0x64, 0x00, 0x00,
]);
const SHA = createHash('sha256').update(MP3).digest('hex');

class MemoryPrivateFile implements ExpoRealtimeAuditedSpeechPrivateFile {
  readonly uri = 'file:///private/cache/opaque.mp3';
  exists = false;
  deleteError = false;
  private data = new Uint8Array();

  get size(): number { return this.exists ? this.data.byteLength : 0; }

  create(): void {
    if (this.exists) throw new Error('exists');
    this.exists = true;
    this.data = new Uint8Array();
  }

  openForWrite() {
    if (!this.exists) throw new Error('missing');
    let closed = false;
    return {
      writeBytes: (bytes: Uint8Array) => {
        if (closed) throw new Error('closed');
        const next = new Uint8Array(this.data.byteLength + bytes.byteLength);
        next.set(this.data);
        next.set(bytes, this.data.byteLength);
        this.data = next;
      },
      close: () => { closed = true; },
    };
  }

  async bytes(): Promise<Uint8Array> {
    return this.data.slice();
  }

  delete(): void {
    if (this.deleteError) throw new Error('delete failed with private path');
    this.exists = false;
    this.data = new Uint8Array();
  }
}

class FakePlayer implements ExpoRealtimeAuditedSpeechNativePlayer {
  readonly play = vi.fn();
  readonly pause = vi.fn();
  readonly remove = vi.fn();
  readonly subscriptionRemove = vi.fn();
  private listener: ((status: {
    didJustFinish: boolean;
    error: string | null;
    mediaServicesDidReset?: boolean;
  }) => void) | null = null;

  addStatusListener(listener: NonNullable<FakePlayer['listener']>) {
    this.listener = listener;
    return { remove: this.subscriptionRemove };
  }

  finish(): void {
    this.listener?.({ didJustFinish: true, error: null });
  }

  fail(): void {
    this.listener?.({ didJustFinish: false, error: 'private native decoder detail' });
  }
}

function bodyFromChunks(
  chunks: readonly Uint8Array[],
  onCancel = vi.fn(),
): { body: { getReader(): ReadableStreamDefaultReader<Uint8Array>; cancel(reason?: unknown): Promise<void> }; onCancel: ReturnType<typeof vi.fn> } {
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel(reason) { onCancel(reason); },
  }, { highWaterMark: 0 });
  return {
    body: {
      getReader: () => stream.getReader(),
      cancel: (reason) => stream.cancel(reason),
    },
    onCancel,
  };
}

function response(input: {
  bytes?: Uint8Array;
  chunks?: readonly Uint8Array[];
  status?: number;
  url?: string;
  redirected?: boolean;
  mimeType?: string;
  contentLength?: string | null;
  contentEncoding?: string | null;
  onCancel?: ReturnType<typeof vi.fn>;
} = {}) {
  const bytes = input.bytes ?? MP3;
  const streamed = bodyFromChunks(input.chunks ?? [bytes], input.onCancel);
  const headers = new Headers();
  headers.set('content-type', input.mimeType ?? 'audio/mpeg');
  if (input.contentLength !== null) {
    headers.set('content-length', input.contentLength ?? String(bytes.byteLength));
  }
  if (input.contentEncoding !== undefined && input.contentEncoding !== null) {
    headers.set('content-encoding', input.contentEncoding);
  }
  const status = input.status ?? 200;
  return {
    value: {
      status,
      ok: status >= 200 && status < 300,
      url: input.url ?? URL,
      redirected: input.redirected ?? false,
      headers,
      body: streamed.body,
    },
    onCancel: streamed.onCancel,
  };
}

function harness(overrides: {
  fetch?: ExpoRealtimeAuditedSpeechRuntime['fetch'];
  owns?: (lease: ProcessAudioLease) => boolean;
  sha256?: (bytes: Uint8Array) => Promise<string>;
  file?: MemoryPrivateFile;
  player?: FakePlayer;
  purgeStalePrivateFiles?: () => void;
  downloadTimeoutMs?: number;
  playbackTimeoutMs?: number;
} = {}) {
  const file = overrides.file ?? new MemoryPrivateFile();
  const player = overrides.player ?? new FakePlayer();
  const fetch = vi.fn(overrides.fetch ?? (async () => response().value));
  const runtime: ExpoRealtimeAuditedSpeechRuntime = {
    fetch,
    createPrivateFile: vi.fn(() => file),
    sha256: vi.fn(
      overrides.sha256 ?? (async (bytes) => createHash('sha256').update(bytes).digest('hex')),
    ),
    purgeStalePrivateFiles: vi.fn(overrides.purgeStalePrivateFiles ?? (() => undefined)),
    createPlayer: vi.fn(() => player),
    ownsAudioLease: vi.fn(overrides.owns ?? (() => true)),
  };
  const playback = new ExpoRealtimeAuditedSpeechPlayback({
    speechSourcePolicy: POLICY,
    audioLease: LEASE,
    downloadTimeoutMs: overrides.downloadTimeoutMs,
    playbackTimeoutMs: overrides.playbackTimeoutMs,
  }, runtime);
  return { playback, runtime, fetch, file, player };
}

function request(overrides: Partial<Parameters<ExpoRealtimeAuditedSpeechPlayback['downloadVerified']>[0]> = {}) {
  return {
    sourceUrl: URL,
    expectedSha256: SHA,
    expectedMimeType: 'audio/mpeg' as const,
    expectedByteSize: MP3.byteLength,
    maximumBytes: MP3.byteLength,
    expectedTurnId: TURN_ID,
    expectedArtifactId: ARTIFACT_ID,
    ...overrides,
  };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => { resolve = onResolve; });
  return { promise, resolve };
}

describe('ExpoRealtimeAuditedSpeechPlayback config', () => {
  it.each([
    ['origine HTTP', { speechSourcePolicy: { ...POLICY, allowedOrigin: 'http://project.supabase.co' } }],
    ['origine avec chemin', { speechSourcePolicy: { ...POLICY, allowedOrigin: 'https://project.supabase.co/storage' } }],
    ['origine avec query', { speechSourcePolicy: { ...POLICY, allowedOrigin: 'https://project.supabase.co?token=leak' } }],
    ['bucket invalide', { speechSourcePolicy: { ...POLICY, allowedPathPrefix: POLICY.allowedPathPrefix.replace('bob-live-audio', '../public') } }],
    ['tenant invalide', { speechSourcePolicy: { ...POLICY, allowedPathPrefix: POLICY.allowedPathPrefix.replace('company-1', 'company/other') } }],
    ['timeout réseau non borné', { downloadTimeoutMs: 31_000 }],
    ['timeout player non borné', { playbackTimeoutMs: 121_000 }],
    ['lease non realtime', { audioLease: { ...LEASE, mode: 'legacy_output' as const } }],
  ])('rejette la configuration non sûre (%s)', (_label, override) => {
    const runtime = harness().runtime;
    expect(() => new ExpoRealtimeAuditedSpeechPlayback({
      speechSourcePolicy: POLICY,
      audioLease: LEASE,
      ...override,
    }, runtime)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });

  it('purge les reliquats privés au démarrage et échoue fermé si la purge est impossible', () => {
    const clean = harness();
    expect(clean.runtime.purgeStalePrivateFiles).toHaveBeenCalledTimes(1);
    expect(() => harness({
      purgeStalePrivateFiles: () => { throw new Error('private cache path'); },
    })).toThrow(expect.objectContaining({ code: 'CLEANUP_FAILED' }));
  });
});

describe('ExpoRealtimeAuditedSpeechPlayback download', () => {
  it('streame dans le cache privé, vérifie les octets et ne retourne qu’un handle opaque', async () => {
    const first = MP3.subarray(0, 5);
    const second = MP3.subarray(5);
    const streamed = response({ chunks: [first, second] });
    const value = harness({ fetch: async () => streamed.value });

    const verified = await value.playback.downloadVerified(request(), new AbortController().signal);

    expect(verified).toEqual({
      opaqueHandle: expect.any(Object),
      sha256: SHA,
      mimeType: 'audio/mpeg',
      byteSize: MP3.byteLength,
    });
    expect(Object.keys(verified.opaqueHandle as object)).toEqual([]);
    expect(value.fetch).toHaveBeenCalledWith(URL, expect.objectContaining({
      method: 'GET',
      credentials: 'omit',
      redirect: 'manual',
      headers: { Accept: 'audio/mpeg' },
      signal: expect.any(AbortSignal),
    }));
    expect(value.file.exists).toBe(true);

    value.playback.release(verified);
    expect(value.file.exists).toBe(false);
  });

  it('honore en développement une policy HTTP strictement loopback', async () => {
    const localPolicy = Object.freeze({
      ...POLICY,
      allowedOrigin: 'http://127.0.0.1:54321',
    });
    const localUrl = `${localPolicy.allowedOrigin}${localPolicy.allowedPathPrefix}${TURN_ID}/${ARTIFACT_ID}?token=opaque.token`;
    const base = harness();
    const runtime: ExpoRealtimeAuditedSpeechRuntime = {
      ...base.runtime,
      fetch: vi.fn(async () => response({ url: localUrl }).value),
    };
    const playback = new ExpoRealtimeAuditedSpeechPlayback({
      speechSourcePolicy: localPolicy,
      audioLease: LEASE,
    }, runtime);

    const verified = await playback.downloadVerified(
      request({ sourceUrl: localUrl }),
      new AbortController().signal,
    );

    expect(runtime.fetch).toHaveBeenCalledWith(localUrl, expect.any(Object));
    playback.release(verified);
  });

  it.each([
    ['HTTP', URL.replace('https:', 'http:')],
    ['origine', URL.replace('project.supabase.co', 'evil.example')],
    ['tenant', URL.replace('companies/company-1/', 'companies/company-2/')],
    ['bucket', URL.replace('bob-live-audio', 'public-documents')],
    ['session', URL.replace(SESSION_ID, '00000000-0000-4000-8000-000000000099')],
    ['turn', URL.replace(TURN_ID, '00000000-0000-4000-8000-000000000098')],
    ['artefact', URL.replace(ARTIFACT_ID, '00000000-0000-4000-8000-000000000097')],
    ['path', URL.replace('/bob-live/', '/documents/')],
    ['query supplémentaire', `${URL}&download=true`],
    ['query dupliquée', `${URL}&token=second`],
    ['token encodé', URL.replace('opaque.token', 'opaque%2Etoken')],
    ['fragment', `${URL}#leak`],
    ['credentials', URL.replace('https://', 'https://user:secret@')],
  ])('refuse la source non canonique avant réseau (%s)', async (_label, sourceUrl) => {
    const value = harness();
    await expectCode(
      value.playback.downloadVerified(request({ sourceUrl }), new AbortController().signal),
      'SOURCE_NOT_ALLOWED',
    );
    expect(value.fetch).not.toHaveBeenCalled();
  });

  it.each(['audio/ogg', 'audio/webm', 'audio/mp4', 'audio/aac', 'audio/flac'] as const)(
    'refuse le codec non certifié %s avant réseau',
    async (expectedMimeType) => {
      const value = harness();
      // Fixture hostile injecté à la frontière runtime : ces MIME ne font volontairement plus
      // partie du contrat TypeScript de production.
      const malformedRequest = request({
        expectedMimeType: expectedMimeType as unknown as 'audio/mpeg',
      });
      await expectCode(
        value.playback.downloadVerified(
          malformedRequest,
          new AbortController().signal,
        ),
        'INVALID_REQUEST',
      );
      expect(value.fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['redirection marquée', response({ redirected: true }).value],
    ['URL finale différente', response({ url: URL.replace(ARTIFACT_ID, 'other') }).value],
    ['redirection HTTP', response({ status: 302 }).value],
    ['MIME divergent', response({ mimeType: 'application/octet-stream' }).value],
    ['MIME paramétré', response({ mimeType: 'audio/mpeg; charset=binary' }).value],
    ['encodage transparent', response({ contentEncoding: 'gzip' }).value],
    ['taille annoncée divergente', response({ contentLength: String(MP3.byteLength - 1) }).value],
  ])('échoue fermé sur une réponse ambiguë (%s)', async (_label, result) => {
    const value = harness({ fetch: async () => result });
    await expectCode(
      value.playback.downloadVerified(request(), new AbortController().signal),
      'INVALID_RESPONSE',
    );
    expect(value.file.exists).toBe(false);
  });

  it('annule physiquement un flux qui dépasse la borne et supprime le partiel', async () => {
    const onCancel = vi.fn();
    const oversized = Uint8Array.from([...MP3, 0x00]);
    const streamed = response({
      chunks: [oversized],
      contentLength: null,
      onCancel,
    });
    const value = harness({ fetch: async () => streamed.value });

    await expectCode(
      value.playback.downloadVerified(request(), new AbortController().signal),
      'AUDIO_TOO_LARGE',
    );
    expect(onCancel).toHaveBeenCalled();
    expect(value.file.exists).toBe(false);
  });

  it('rejette SHA et signature de codec même si le serveur annonce le bon MIME', async () => {
    const badSha = harness({ sha256: async () => 'f'.repeat(64) });
    await expectCode(
      badSha.playback.downloadVerified(request(), new AbortController().signal),
      'AUDIO_INTEGRITY_FAILED',
    );
    expect(badSha.file.exists).toBe(false);

    const fakeMp3 = new Uint8Array(MP3.byteLength).fill(0x42);
    const fakeSha = createHash('sha256').update(fakeMp3).digest('hex');
    const badSignature = harness({ fetch: async () => response({ bytes: fakeMp3 }).value });
    await expectCode(
      badSignature.playback.downloadVerified(request({ expectedSha256: fakeSha }), new AbortController().signal),
      'AUDIO_INTEGRITY_FAILED',
    );
    expect(badSignature.file.exists).toBe(false);
  });

  it('propage AbortSignal au transport, annule le reader et détruit le cache partiel', async () => {
    const onCancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      pull: () => new Promise(() => undefined),
      cancel: onCancel,
    });
    const result = response({ contentLength: null }).value;
    const value = harness({
      fetch: async () => ({
        ...result,
        body: {
          getReader: () => stream.getReader(),
          cancel: (reason?: unknown) => stream.cancel(reason),
        },
      }),
    });
    const abort = new AbortController();
    const pending = value.playback.downloadVerified(request(), abort.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));

    abort.abort();

    await expectCode(pending, 'ABORTED');
    expect(onCancel).toHaveBeenCalled();
    expect(value.file.exists).toBe(false);
    const fetchSignal = value.fetch.mock.calls[0]?.[1]?.signal;
    expect(fetchSignal?.aborted).toBe(true);
  });

  it('cesse d’attendre même si le binding fetch natif ignore anormalement son AbortSignal', async () => {
    const value = harness({
      fetch: () => new Promise(() => undefined),
    });
    const abort = new AbortController();
    const pending = value.playback.downloadVerified(request(), abort.signal);
    await Promise.resolve();
    abort.abort();

    await expectCode(pending, 'ABORTED');
    expect(value.fetch.mock.calls[0]?.[1]?.signal.aborted).toBe(true);
    expect(value.file.exists).toBe(false);
  });

  it('borne aussi un fetch natif bloqué par le timeout interne', async () => {
    vi.useFakeTimers();
    try {
      const value = harness({
        fetch: () => new Promise(() => undefined),
        downloadTimeoutMs: 250,
      });
      const pending = value.playback.downloadVerified(request(), new AbortController().signal);
      const rejected = expectCode(pending, 'DOWNLOAD_TIMEOUT');
      await vi.advanceTimersByTimeAsync(250);

      await rejected;
      expect(value.fetch.mock.calls[0]?.[1]?.signal.aborted).toBe(true);
      expect(value.file.exists).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fence la perte du lease audio au milieu du flux', async () => {
    const onCancel = vi.fn();
    const streamed = response({ onCancel });
    let checks = 0;
    const value = harness({
      fetch: async () => streamed.value,
      owns: () => ++checks < 2,
    });
    await expectCode(
      value.playback.downloadVerified(request(), new AbortController().signal),
      'AUDIO_NOT_OWNED',
    );
    expect(onCancel).toHaveBeenCalled();
    expect(value.file.exists).toBe(false);
  });

  it('borne et annule aussi la relecture native et le SHA après le download', async () => {
    const bytesPending = deferred<Uint8Array>();
    const bytesValue = harness();
    vi.spyOn(bytesValue.file, 'bytes').mockReturnValue(bytesPending.promise);
    const bytesAbort = new AbortController();
    const pendingBytes = bytesValue.playback.downloadVerified(request(), bytesAbort.signal);
    await vi.waitFor(() => expect(bytesValue.file.exists).toBe(true));
    bytesAbort.abort();
    await expectCode(pendingBytes, 'ABORTED');
    expect(bytesValue.file.exists).toBe(false);

    const hashPending = deferred<string>();
    const hashValue = harness({ sha256: () => hashPending.promise });
    const hashAbort = new AbortController();
    const pendingHash = hashValue.playback.downloadVerified(request(), hashAbort.signal);
    await vi.waitFor(() => expect(hashValue.runtime.sha256).toHaveBeenCalledTimes(1));
    hashAbort.abort();
    await expectCode(pendingHash, 'ABORTED');
    expect(hashValue.file.exists).toBe(false);
  });

  it('annule le body si Content-Length est malformé', async () => {
    const onCancel = vi.fn();
    const malformed = response({ contentLength: '+16', onCancel });
    const value = harness({ fetch: async () => malformed.value });

    await expectCode(
      value.playback.downloadVerified(request(), new AbortController().signal),
      'INVALID_RESPONSE',
    );
    expect(onCancel).toHaveBeenCalled();
  });

  it('ne fuit jamais URL, token, octets ou erreur native dans son erreur publique', async () => {
    const value = harness({ fetch: async () => { throw new Error(`secret ${URL}`); } });
    let caught: unknown;
    try {
      await value.playback.downloadVerified(request(), new AbortController().signal);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ExpoRealtimeAuditedSpeechError);
    const serialized = JSON.stringify(caught);
    expect(serialized).not.toContain(URL);
    expect(String(caught)).not.toContain('opaque.token');
    expect(String(caught)).not.toContain(MP3.join(','));
  });
});

describe('ExpoRealtimeAuditedSpeechPlayback playback', () => {
  it('lit seulement un handle vérifié, attend la fin native puis efface à release', async () => {
    const value = harness();
    const verified = await value.playback.downloadVerified(request(), new AbortController().signal);
    const playing = value.playback.play(verified, new AbortController().signal);
    await Promise.resolve();
    expect(value.player.play).toHaveBeenCalledTimes(1);

    value.player.finish();
    await expect(playing).resolves.toBeUndefined();
    expect(value.player.pause).toHaveBeenCalledTimes(1);
    expect(value.player.remove).toHaveBeenCalledTimes(1);
    expect(value.file.exists).toBe(true);

    value.playback.release(verified);
    expect(value.file.exists).toBe(false);
  });

  it('stopImmediately coupe pause/remove sur la même pile et rejette la lecture', async () => {
    const value = harness();
    const verified = await value.playback.downloadVerified(request(), new AbortController().signal);
    const playing = value.playback.play(verified, new AbortController().signal);
    await Promise.resolve();

    expect(() => value.playback.stopImmediately()).not.toThrow();

    expect(value.player.pause).toHaveBeenCalledTimes(1);
    expect(value.player.remove).toHaveBeenCalledTimes(1);
    await expectCode(playing, 'ABORTED');
    value.playback.release(verified);
  });

  it('rend deux appels play atomiques : aucun player ne peut devenir orphelin', async () => {
    const value = harness();
    const verified = await value.playback.downloadVerified(request(), new AbortController().signal);
    const first = value.playback.play(verified, new AbortController().signal);
    const second = value.playback.play(verified, new AbortController().signal);

    await expectCode(second, 'PLAYBACK_FAILED');
    expect(value.runtime.createPlayer).toHaveBeenCalledTimes(1);
    expect(value.player.play).toHaveBeenCalledTimes(1);
    value.player.finish();
    await expect(first).resolves.toBeUndefined();
    value.playback.release(verified);
  });

  it('remonte un arrêt natif impossible et conserve une voie de retry', async () => {
    const value = harness();
    value.player.pause.mockImplementation(() => { throw new Error('pause'); });
    value.player.remove.mockImplementation(() => { throw new Error('remove'); });
    const verified = await value.playback.downloadVerified(request(), new AbortController().signal);
    const playing = value.playback.play(verified, new AbortController().signal);

    expect(() => value.playback.stopImmediately()).toThrow(expect.objectContaining({
      code: 'PLAYBACK_STOP_FAILED',
    }));

    await expectCode(playing, 'PLAYBACK_STOP_FAILED');
    expect(() => value.playback.release(verified)).toThrow(expect.objectContaining({
      code: 'PLAYBACK_STOP_FAILED',
    }));
    value.player.pause.mockReset();
    value.player.remove.mockReset();
    expect(() => value.playback.release(verified)).not.toThrow();
    expect(value.file.exists).toBe(false);
  });

  it('ne valide pas une lecture dont le player est arrêté mais non libéré', async () => {
    const value = harness();
    value.player.remove.mockImplementation(() => { throw new Error('remove'); });
    const verified = await value.playback.downloadVerified(request(), new AbortController().signal);
    const playing = value.playback.play(verified, new AbortController().signal);

    value.player.finish();

    await expectCode(playing, 'PLAYBACK_FAILED');
    value.player.remove.mockReset();
    expect(() => value.playback.release(verified)).not.toThrow();
  });

  it('l’abort pendant lecture coupe physiquement le player', async () => {
    const value = harness();
    const verified = await value.playback.downloadVerified(request(), new AbortController().signal);
    const abort = new AbortController();
    const playing = value.playback.play(verified, abort.signal);
    await Promise.resolve();

    abort.abort();

    await expectCode(playing, 'ABORTED');
    expect(value.player.pause).toHaveBeenCalledTimes(1);
    expect(value.player.remove).toHaveBeenCalledTimes(1);
    value.playback.release(verified);
  });

  it('rejette un handle forgé, muté ou rejoué après release', async () => {
    const value = harness();
    const verified = await value.playback.downloadVerified(request(), new AbortController().signal);
    await expectCode(value.playback.play({ ...verified, sha256: 'e'.repeat(64) }, new AbortController().signal), 'INVALID_HANDLE');
    await expectCode(value.playback.play({ ...verified, opaqueHandle: {} }, new AbortController().signal), 'INVALID_HANDLE');
    value.playback.release(verified);
    await expectCode(value.playback.play(verified, new AbortController().signal), 'INVALID_HANDLE');
  });

  it('refuse de jouer si le lease WebRTC n’est plus courant', async () => {
    let owned = true;
    const value = harness({ owns: () => owned });
    const verified = await value.playback.downloadVerified(request(), new AbortController().signal);
    owned = false;
    await expectCode(value.playback.play(verified, new AbortController().signal), 'AUDIO_NOT_OWNED');
    value.playback.release(verified);
  });

  it('coupe au prochain statut natif si le lease est perdu pendant la lecture', async () => {
    let owned = true;
    const value = harness({ owns: () => owned });
    const verified = await value.playback.downloadVerified(request(), new AbortController().signal);
    const playing = value.playback.play(verified, new AbortController().signal);
    await Promise.resolve();
    owned = false;
    value.player.finish();

    await expectCode(playing, 'AUDIO_NOT_OWNED');
    expect(value.player.pause).toHaveBeenCalledTimes(1);
    expect(value.player.remove).toHaveBeenCalledTimes(1);
    value.playback.release(verified);
  });

  it('signale une suppression impossible sans condamner une nouvelle tentative de cleanup', async () => {
    const file = new MemoryPrivateFile();
    const value = harness({ file });
    const verified = await value.playback.downloadVerified(request(), new AbortController().signal);
    file.deleteError = true;
    expect(() => value.playback.release(verified)).toThrow(expect.objectContaining({
      code: 'CLEANUP_FAILED',
    }));
    expect(file.exists).toBe(true);

    file.deleteError = false;
    expect(() => value.playback.release(verified)).not.toThrow();
    expect(file.exists).toBe(false);
  });

  it('transforme une erreur décodeur en erreur opaque', async () => {
    const value = harness();
    const verified = await value.playback.downloadVerified(request(), new AbortController().signal);
    const playing = value.playback.play(verified, new AbortController().signal);
    await Promise.resolve();
    value.player.fail();
    await expectCode(playing, 'PLAYBACK_FAILED');
    expect(String(await playing.catch((error) => error))).not.toContain('private native decoder detail');
    value.playback.release(verified);
  });

  it('borne un décodeur natif qui ne publie jamais de statut terminal', async () => {
    vi.useFakeTimers();
    try {
      const value = harness({ playbackTimeoutMs: 1_000 });
      const verified = await value.playback.downloadVerified(request(), new AbortController().signal);
      const playing = value.playback.play(verified, new AbortController().signal);
      const rejected = expectCode(playing, 'PLAYBACK_TIMEOUT');
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_000);

      await rejected;
      expect(value.player.pause).toHaveBeenCalledTimes(1);
      expect(value.player.remove).toHaveBeenCalledTimes(1);
      value.playback.release(verified);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('hasRealtimeSpeechAudioSignature', () => {
  const wav = Uint8Array.from([
    0x52, 0x49, 0x46, 0x46, 38, 0, 0, 0, 0x57, 0x41, 0x56, 0x45,
    0x66, 0x6d, 0x74, 0x20, 16, 0, 0, 0, 1, 0, 1, 0,
    0x80, 0x3e, 0, 0, 0x00, 0x7d, 0, 0, 2, 0, 16, 0,
    0x64, 0x61, 0x74, 0x61, 2, 0, 0, 0, 0, 0,
  ]);

  it.each([
    ['audio/mpeg', Uint8Array.from([0xff, 0xfb, 0x90, 0x64])],
    ['audio/wav', wav],
  ] as const)('reconnaît la signature %s', (mimeType, prefix) => {
    expect(hasRealtimeSpeechAudioSignature(mimeType, prefix)).toBe(true);
  });

  it('rejette un simple tag ID3 ou RIFF sans trame/conteneur audio valide', () => {
    expect(hasRealtimeSpeechAudioSignature(
      'audio/mpeg',
      Uint8Array.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]),
    )).toBe(false);
    expect(hasRealtimeSpeechAudioSignature(
      'audio/wav',
      Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]),
    )).toBe(false);
  });

  it('ne confond pas un payload arbitraire avec de l’audio', () => {
    const arbitrary = new TextEncoder().encode('<html>not audio</html>');
    expect(hasRealtimeSpeechAudioSignature('audio/mpeg', arbitrary)).toBe(false);
    expect(hasRealtimeSpeechAudioSignature('audio/wav', arbitrary)).toBe(false);
  });
});
