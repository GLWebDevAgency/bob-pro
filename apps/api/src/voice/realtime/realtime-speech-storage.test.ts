import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  REALTIME_SPEECH_STORAGE_LIMITS,
  RealtimeSpeechStorageError,
  SupabaseRealtimeSpeechStorage,
  buildRealtimeSpeechStorageKey,
  type RealtimeSpeechStorageErrorCode,
  type RealtimeSpeechStorageFetch,
} from './realtime-speech-storage';

const COMPANY_ID = 'co-1';
const SESSION_ID = 'session-1';
const TURN_ID = 'turn-1';
const ARTIFACT_ID = 'artifact-1';
const KEY = `companies/${COMPANY_ID}/bob-live/${SESSION_ID}/${TURN_ID}/${ARTIFACT_ID}`;
const AUDIO = new Uint8Array(256).map((_, index) => index % 251);
const AUDIO_SHA256 = createHash('sha256').update(AUDIO).digest('hex');
const ABORT_SIGNAL = new AbortController().signal;
const JSON_HEADERS = { 'content-type': 'application/json' };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function makeStorage(
  fetchImpl: RealtimeSpeechStorageFetch,
  options: { requestTimeoutMs?: number; url?: string } = {},
): SupabaseRealtimeSpeechStorage {
  return new SupabaseRealtimeSpeechStorage({
    url: options.url ?? 'https://project.supabase.co',
    serviceRoleKey: 'service-role-secret',
    requestTimeoutMs: options.requestTimeoutMs,
  }, fetchImpl);
}

async function expectStorageError(
  promise: Promise<unknown>,
  code: RealtimeSpeechStorageErrorCode,
): Promise<RealtimeSpeechStorageError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RealtimeSpeechStorageError);
    expect(error).toMatchObject({ code });
    return error as RealtimeSpeechStorageError;
  }
  throw new Error(`Expected storage error ${code}.`);
}

function signedUrlPayload(path = KEY, token = 'opaque-download-token'): Response {
  return new Response(JSON.stringify({
    signedURL: `/storage/v1/object/sign/bob-live-audio/${path}?token=${token}`,
  }), { status: 200, headers: JSON_HEADERS });
}

describe('Bob Live private speech storage key', () => {
  it('construit exactement la clé tenant sans extension ni segment implicite', () => {
    expect(buildRealtimeSpeechStorageKey({
      companyId: COMPANY_ID,
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      artifactId: ARTIFACT_ID,
    })).toBe(KEY);
  });

  it.each([
    { companyId: '../co', sessionId: SESSION_ID, turnId: TURN_ID, artifactId: ARTIFACT_ID },
    { companyId: COMPANY_ID, sessionId: 'session/other', turnId: TURN_ID, artifactId: ARTIFACT_ID },
    { companyId: COMPANY_ID, sessionId: SESSION_ID, turnId: 'évasion', artifactId: ARTIFACT_ID },
    { companyId: COMPANY_ID, sessionId: SESSION_ID, turnId: TURN_ID, artifactId: 'artifact.json' },
    { companyId: COMPANY_ID, sessionId: '', turnId: TURN_ID, artifactId: ARTIFACT_ID },
  ])('rejette tout segment ambigu ou traversable (%j)', (parts) => {
    expect(() => buildRealtimeSpeechStorageKey(parts)).toThrowError(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    );
  });
});

describe('SupabaseRealtimeSpeechStorage upload create-only', () => {
  it('envoie une copie privée, x-upsert=false, no-store et retourne le sha256 réel', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    let releaseFetch: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { releaseFetch = resolve; });
    const fetchImpl: RealtimeSpeechStorageFetch = vi.fn(async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      await gate;
      return new Response(null, { status: 201 });
    });
    const storage = makeStorage(fetchImpl);
    const mutable = new Uint8Array(AUDIO);

    const pending = storage.upload({
      companyId: COMPANY_ID,
      key: KEY,
      bytes: mutable,
      mimeType: 'audio/mpeg',
      signal: ABORT_SIGNAL,
    });
    mutable.fill(255);
    releaseFetch?.();

    await expect(pending).resolves.toEqual({
      key: KEY,
      sizeBytes: AUDIO.byteLength,
      audioSha256: AUDIO_SHA256,
      mimeType: 'audio/mpeg',
    });
    expect(capturedUrl).toBe(
      `https://project.supabase.co/storage/v1/object/bob-live-audio/${KEY}`,
    );
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get('authorization')).toBe('Bearer service-role-secret');
    expect(headers.get('apikey')).toBe('service-role-secret');
    expect(headers.get('content-type')).toBe('audio/mpeg');
    expect(headers.get('cache-control')).toBe('private, no-store, max-age=0');
    expect(headers.get('x-upsert')).toBe('false');
    expect(capturedInit?.redirect).toBe('error');
    expect(new Uint8Array(capturedInit?.body as Uint8Array)).toEqual(AUDIO);
  });

  it('rejette taille, MIME et clé cross-tenant avant toute requête', async () => {
    const fetchImpl = vi.fn<RealtimeSpeechStorageFetch>();
    const storage = makeStorage(fetchImpl);

    await expectStorageError(storage.upload({
      companyId: COMPANY_ID,
      key: KEY,
      bytes: new Uint8Array(REALTIME_SPEECH_STORAGE_LIMITS.maxAudioBytes + 1),
      mimeType: 'audio/mpeg',
      signal: ABORT_SIGNAL,
    }), 'INVALID_INPUT');
    await expectStorageError(storage.upload({
      companyId: COMPANY_ID,
      key: KEY,
      bytes: AUDIO,
      mimeType: 'text/plain' as 'audio/mpeg',
      signal: ABORT_SIGNAL,
    }), 'INVALID_INPUT');
    await expectStorageError(storage.upload({
      companyId: COMPANY_ID,
      key: KEY.replace('companies/co-1/', 'companies/co-2/'),
      bytes: AUDIO,
      mimeType: 'audio/mpeg',
      signal: ABORT_SIGNAL,
    }), 'INVALID_INPUT');

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    new Response(null, { status: 409 }),
    new Response(JSON.stringify({ statusCode: '409', error: 'Duplicate' }), { status: 400 }),
  ])('traduit un conflit fournisseur en ALREADY_EXISTS sans écrasement', async (response) => {
    const storage = makeStorage(vi.fn(async () => response));

    await expectStorageError(storage.upload({
      companyId: COMPANY_ID,
      key: KEY,
      bytes: AUDIO,
      mimeType: 'audio/mpeg',
      signal: ABORT_SIGNAL,
    }), 'ALREADY_EXISTS');
  });

  it('ne propage ni corps fournisseur, ni clé, ni secret dans une erreur', async () => {
    const providerSecret = 'provider-body-secret-456';
    const storage = makeStorage(vi.fn(async () => new Response(
      JSON.stringify({ message: providerSecret }),
      { status: 500, headers: JSON_HEADERS },
    )));

    const error = await expectStorageError(storage.upload({
      companyId: COMPANY_ID,
      key: KEY,
      bytes: AUDIO,
      mimeType: 'audio/mpeg',
      signal: ABORT_SIGNAL,
    }), 'UNAVAILABLE');

    expect(error.message).not.toContain(providerSecret);
    expect(error.message).not.toContain(KEY);
    expect(error.message).not.toContain('service-role-secret');
    expect(Object.hasOwn(error, 'cause')).toBe(false);
  });

  it('annule physiquement fetch quand l’appelant interrompt la requête', async () => {
    const caller = new AbortController();
    let providerAborted = false;
    const fetchImpl: RealtimeSpeechStorageFetch = vi.fn(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal as AbortSignal;
      signal.addEventListener('abort', () => {
        providerAborted = true;
        reject(new DOMException('aborted', 'AbortError'));
      }, { once: true });
    }));
    const storage = makeStorage(fetchImpl);
    const pending = storage.upload({
      companyId: COMPANY_ID,
      key: KEY,
      bytes: AUDIO,
      mimeType: 'audio/mpeg',
      signal: caller.signal,
    });
    const rejection = expectStorageError(pending, 'ABORTED');

    caller.abort('user-left-screen');

    await rejection;
    expect(providerAborted).toBe(true);
  });

  it('borne la durée fournisseur et annule physiquement au timeout', async () => {
    vi.useFakeTimers();
    let providerAborted = false;
    const fetchImpl: RealtimeSpeechStorageFetch = vi.fn(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal as AbortSignal;
      signal.addEventListener('abort', () => {
        providerAborted = true;
        reject(new DOMException('timeout', 'AbortError'));
      }, { once: true });
    }));
    const storage = makeStorage(fetchImpl, { requestTimeoutMs: 25 });
    const pending = storage.upload({
      companyId: COMPANY_ID,
      key: KEY,
      bytes: AUDIO,
      mimeType: 'audio/mpeg',
      signal: ABORT_SIGNAL,
    });
    const rejection = expectStorageError(pending, 'TIMEOUT');

    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(providerAborted).toBe(true);
  });

  it('court-circuite un signal déjà annulé sans appeler le fournisseur', async () => {
    const caller = new AbortController();
    caller.abort();
    const fetchImpl = vi.fn<RealtimeSpeechStorageFetch>();
    const storage = makeStorage(fetchImpl);

    await expectStorageError(storage.upload({
      companyId: COMPANY_ID,
      key: KEY,
      bytes: AUDIO,
      mimeType: 'audio/mpeg',
      signal: caller.signal,
    }), 'ABORTED');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('ne reste pas bloqué sur le hook cancel d’un corps de succès ignoré', async () => {
    const body = new ReadableStream<Uint8Array>({
      cancel: () => new Promise<void>(() => undefined),
    });
    const storage = makeStorage(vi.fn(async () => new Response(body, { status: 201 })));

    await expect(storage.upload({
      companyId: COMPANY_ID,
      key: KEY,
      bytes: AUDIO,
      mimeType: 'audio/mpeg',
      signal: ABORT_SIGNAL,
    })).resolves.toMatchObject({ audioSha256: AUDIO_SHA256 });
  });
});

describe('SupabaseRealtimeSpeechStorage signed private download', () => {
  it('signe 30 secondes par défaut, même origine, chemin exact et sans redirect HTTP', async () => {
    let capturedInit: RequestInit | undefined;
    const storage = makeStorage(vi.fn(async (_url, init) => {
      capturedInit = init;
      return signedUrlPayload();
    }));

    await expect(storage.createSignedDownload({
      companyId: COMPANY_ID,
      key: KEY,
      signal: ABORT_SIGNAL,
    })).resolves.toEqual({
      url: `https://project.supabase.co/storage/v1/object/sign/bob-live-audio/${KEY}?token=opaque-download-token`,
      expiresInSeconds: 30,
    });
    expect(JSON.parse(String(capturedInit?.body))).toEqual({ expiresIn: 30 });
    expect(capturedInit?.redirect).toBe('error');
    expect(new Headers(capturedInit?.headers).get('cache-control')).toBe('no-store');
  });

  it('accepte une durée plus courte et rejette 0, décimal ou > 30 avant fetch', async () => {
    const fetchImpl = vi.fn(async () => signedUrlPayload());
    const storage = makeStorage(fetchImpl);

    await expect(storage.createSignedDownload({
      companyId: COMPANY_ID,
      key: KEY,
      ttlSeconds: 7,
      signal: ABORT_SIGNAL,
    })).resolves.toMatchObject({ expiresInSeconds: 7 });

    for (const ttlSeconds of [0, 1.5, 31]) {
      await expectStorageError(storage.createSignedDownload({
        companyId: COMPANY_ID,
        key: KEY,
        ttlSeconds,
        signal: ABORT_SIGNAL,
      }), 'INVALID_INPUT');
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['https://evil.example/audio?token=stolen', 'cross-origin'],
    [`/storage/v1/object/sign/bob-live-audio/${KEY}-other?token=opaque`, 'wrong-path'],
    [`/storage/v1/object/sign/bob-live-audio/${KEY}`, 'missing-token'],
    [`/storage/v1/object/sign/bob-live-audio/${KEY}?token=one&token=two`, 'duplicate-token'],
    [`/storage/v1/object/sign/bob-live-audio/${KEY}?token=one&download=true`, 'extra-query'],
    [`/storage/v1/object/sign/bob-live-audio/${KEY}?token=one%2Ftwo`, 'non-opaque-token'],
  ])('rejette une URL signée non canonique (%s, %s)', async (signedURL) => {
    const storage = makeStorage(vi.fn(async () => new Response(
      JSON.stringify({ signedURL }),
      { status: 200, headers: JSON_HEADERS },
    )));

    await expectStorageError(storage.createSignedDownload({
      companyId: COMPANY_ID,
      key: KEY,
      signal: ABORT_SIGNAL,
    }), 'INVALID_RESPONSE');
  });

  it('rejette un type de réponse non JSON et un JSON malformé', async () => {
    const wrongMime = makeStorage(vi.fn(async () => new Response('not-json', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })));
    await expectStorageError(wrongMime.createSignedDownload({
      companyId: COMPANY_ID,
      key: KEY,
      signal: ABORT_SIGNAL,
    }), 'INVALID_RESPONSE');

    const malformed = makeStorage(vi.fn(async () => new Response('{', {
      status: 200,
      headers: JSON_HEADERS,
    })));
    await expectStorageError(malformed.createSignedDownload({
      companyId: COMPANY_ID,
      key: KEY,
      signal: ABORT_SIGNAL,
    }), 'INVALID_RESPONSE');
  });

  it('borne le flux JSON même sans Content-Length et le cancel au dépassement', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(5_000));
        controller.enqueue(new Uint8Array(5_000));
      },
      cancel() {
        cancelled = true;
      },
    });
    const storage = makeStorage(vi.fn(async () => new Response(stream, {
      status: 200,
      headers: JSON_HEADERS,
    })));

    await expectStorageError(storage.createSignedDownload({
      companyId: COMPANY_ID,
      key: KEY,
      signal: ABORT_SIGNAL,
    }), 'RESPONSE_TOO_LARGE');
    expect(cancelled).toBe(true);
  });

  it('mappe les absences Supabase 404 et 400/not_found sans exposer leur corps', async () => {
    for (const response of [
      new Response(null, { status: 404 }),
      new Response(JSON.stringify({ statusCode: '404', error: 'not_found' }), { status: 400 }),
    ]) {
      const storage = makeStorage(vi.fn(async () => response));
      await expectStorageError(storage.createSignedDownload({
        companyId: COMPANY_ID,
        key: KEY,
        signal: ABORT_SIGNAL,
      }), 'NOT_FOUND');
    }
  });

  it('interrompt un flux de réponse qui ne produit jamais de premier octet', async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
      cancel() {
        cancelled = true;
      },
    });
    const storage = makeStorage(vi.fn(async () => new Response(stream, {
      status: 200,
      headers: JSON_HEADERS,
    })), { requestTimeoutMs: 25 });
    const pending = storage.createSignedDownload({
      companyId: COMPANY_ID,
      key: KEY,
      signal: ABORT_SIGNAL,
    });
    const rejection = expectStorageError(pending, 'TIMEOUT');

    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(cancelled).toBe(true);
  });
});

describe('SupabaseRealtimeSpeechStorage idempotent delete and configuration', () => {
  it.each([
    new Response(null, { status: 200 }),
    new Response(null, { status: 404 }),
    new Response(JSON.stringify({ statusCode: '404', error: 'not_found' }), { status: 400 }),
  ])('considère succès et absences comme une suppression réussie', async (response) => {
    const storage = makeStorage(vi.fn(async () => response));

    await expect(storage.delete({
      companyId: COMPANY_ID,
      key: KEY,
      signal: ABORT_SIGNAL,
    })).resolves.toBeUndefined();
  });

  it('refuse une clé avec suffixe, segments supplémentaires ou autre tenant avant delete', async () => {
    const fetchImpl = vi.fn<RealtimeSpeechStorageFetch>();
    const storage = makeStorage(fetchImpl);
    for (const key of [`${KEY}.mp3`, `${KEY}/extra`, KEY.replace('/co-1/', '/co-2/')]) {
      await expectStorageError(storage.delete({
        companyId: COMPANY_ID,
        key,
        signal: ABORT_SIGNAL,
      }), 'INVALID_INPUT');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuse HTTP hors loopback, secrets ambigus, bucket traversable et timeout non borné', () => {
    const fetchImpl = vi.fn<RealtimeSpeechStorageFetch>();
    expect(() => new SupabaseRealtimeSpeechStorage({
      url: 'http://project.supabase.co',
      serviceRoleKey: 'secret',
    }, fetchImpl)).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(() => new SupabaseRealtimeSpeechStorage({
      url: 'https://project.supabase.co',
      serviceRoleKey: ' secret ',
    }, fetchImpl)).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(() => new SupabaseRealtimeSpeechStorage({
      url: 'https://project.supabase.co',
      serviceRoleKey: 'secret\ninjected-header',
    }, fetchImpl)).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(() => new SupabaseRealtimeSpeechStorage({
      url: 'https://project.supabase.co',
      serviceRoleKey: 'secret',
      bucket: '../public',
    }, fetchImpl)).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(() => new SupabaseRealtimeSpeechStorage({
      url: 'https://project.supabase.co',
      serviceRoleKey: 'secret',
      requestTimeoutMs: 30_001,
    }, fetchImpl)).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });

  it('autorise HTTP uniquement pour Supabase local loopback', async () => {
    const storage = makeStorage(vi.fn(async () => new Response(null, { status: 200 })), {
      url: 'http://127.0.0.1:54321',
    });
    await expect(storage.delete({
      companyId: COMPANY_ID,
      key: KEY,
      signal: ABORT_SIGNAL,
    })).resolves.toBeUndefined();
  });
});
