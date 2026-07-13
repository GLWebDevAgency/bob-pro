import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.mock('expo/fetch', () => ({ fetch: vi.fn() }));
vi.mock('expo-audio', () => ({
  createAudioPlayer: vi.fn(),
  setAudioModeAsync: vi.fn(),
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
const URL = 'https://project.supabase.co/storage/v1/object/sign/bob-live-audio/companies/company-1/bob-live/session/turn/artifact?token=opaque.token';
const MP3 = Uint8Array.from([
  0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x06, 0x54, 0x49, 0x54, 0x32, 0x00, 0x00,
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
  downloadTimeoutMs?: number;
  playbackTimeoutMs?: number;
} = {}) {
  const file = overrides.file ?? new MemoryPrivateFile();
  const player = overrides.player ?? new FakePlayer();
  const fetch = vi.fn(overrides.fetch ?? (async () => response().value));
  const runtime: ExpoRealtimeAuditedSpeechRuntime = {
    fetch,
    createPrivateFile: vi.fn(() => file),
    sha256: overrides.sha256 ?? (async (bytes) => createHash('sha256').update(bytes).digest('hex')),
    preparePlayback: vi.fn(async () => undefined),
    createPlayer: vi.fn(() => player),
    ownsAudioLease: vi.fn(overrides.owns ?? (() => true)),
  };
  const playback = new ExpoRealtimeAuditedSpeechPlayback({
    supabaseUrl: 'https://project.supabase.co',
    bucket: 'bob-live-audio',
    companyId: 'company-1',
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
    ...overrides,
  };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

describe('ExpoRealtimeAuditedSpeechPlayback config', () => {
  it.each([
    ['origine HTTP', { supabaseUrl: 'http://project.supabase.co' }],
    ['origine avec chemin', { supabaseUrl: 'https://project.supabase.co/storage' }],
    ['origine avec query', { supabaseUrl: 'https://project.supabase.co?token=leak' }],
    ['bucket invalide', { bucket: '../public' }],
    ['tenant invalide', { companyId: 'company/other' }],
    ['timeout réseau non borné', { downloadTimeoutMs: 31_000 }],
    ['timeout player non borné', { playbackTimeoutMs: 121_000 }],
    ['lease non realtime', { audioLease: { ...LEASE, mode: 'legacy_output' as const } }],
  ])('rejette la configuration non sûre (%s)', (_label, override) => {
    const runtime = harness().runtime;
    expect(() => new ExpoRealtimeAuditedSpeechPlayback({
      supabaseUrl: 'https://project.supabase.co',
      bucket: 'bob-live-audio',
      companyId: 'company-1',
      audioLease: LEASE,
      ...override,
    }, runtime)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
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

  it.each([
    ['HTTP', URL.replace('https:', 'http:')],
    ['origine', URL.replace('project.supabase.co', 'evil.example')],
    ['tenant', URL.replace('companies/company-1/', 'companies/company-2/')],
    ['bucket', URL.replace('bob-live-audio', 'public-documents')],
    ['path', URL.replace('/bob-live/session/turn/artifact', '/documents/session/turn/artifact')],
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

  it.each([
    ['redirection marquée', response({ redirected: true }).value],
    ['URL finale différente', response({ url: URL.replace('artifact', 'other') }).value],
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
    let checks = 0;
    const value = harness({ owns: () => ++checks < 4 });
    await expectCode(
      value.playback.downloadVerified(request(), new AbortController().signal),
      'AUDIO_NOT_OWNED',
    );
    expect(value.file.exists).toBe(false);
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

    value.playback.stopImmediately();

    expect(value.player.pause).toHaveBeenCalledTimes(1);
    expect(value.player.remove).toHaveBeenCalledTimes(1);
    await expectCode(playing, 'ABORTED');
    value.playback.release(verified);
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
  it.each([
    ['audio/mpeg', Uint8Array.from([0x49, 0x44, 0x33])],
    ['audio/wav', Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45])],
    ['audio/ogg', Uint8Array.from([0x4f, 0x67, 0x67, 0x53])],
    ['audio/webm', Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3])],
    ['audio/mp4', Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70])],
    ['audio/aac', Uint8Array.from([0xff, 0xf1])],
    ['audio/flac', Uint8Array.from([0x66, 0x4c, 0x61, 0x43])],
  ] as const)('reconnaît la signature %s', (mimeType, prefix) => {
    expect(hasRealtimeSpeechAudioSignature(mimeType, prefix)).toBe(true);
  });

  it('ne confond pas un payload arbitraire avec de l’audio', () => {
    const arbitrary = new TextEncoder().encode('<html>not audio</html>');
    expect(hasRealtimeSpeechAudioSignature('audio/mpeg', arbitrary)).toBe(false);
    expect(hasRealtimeSpeechAudioSignature('audio/wav', arbitrary)).toBe(false);
  });
});
