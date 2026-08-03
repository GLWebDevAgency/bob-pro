import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BobClient } from './client';
import { HttpBobClient } from './http-client';
import { LocalBobClient } from './local-client';

const SESSION = '00000000-0000-4000-8000-000000000001';
const INVALID_DIAGNOSTIC = {
  version: 1,
  terminationSource: 'automatic_failure',
  lastSuccessfulCheckpoint: 'bootstrap_acknowledged',
  failureCode: 'texte_libre_interdit',
} as never;

describe('BobClient — diagnostic terminal Bob Live', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('refuse la même forme libre dans les clients HTTP et local avant tout effet', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const clients: readonly BobClient[] = [
      new HttpBobClient({
        baseUrl: 'https://api.bob.test',
        companyId: 'company-1',
      }),
      new LocalBobClient(),
    ];

    for (const client of clients) {
      await expect(client.hangupRealtimeVoiceCall(
        SESSION,
        undefined,
        INVALID_DIAGNOSTIC,
      )).resolves.toEqual({
        ok: false,
        error: {
          kind: 'validation',
          issues: [{
            field: 'diagnostic',
            message: 'Le diagnostic terminal Bob Live est invalide.',
          }],
        },
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('préserve l’AbortSignal historique en deuxième argument et un DELETE sans body', async () => {
    let request: RequestInit | undefined;
    const fetchMock = vi.fn((_url: unknown, init?: RequestInit) => {
      request = init;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBobClient({
      baseUrl: 'https://api.bob.test',
      companyId: 'company-1',
    });
    const abort = new AbortController();

    const pending = client.hangupRealtimeVoiceCall(SESSION, abort.signal);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    abort.abort();
    await expect(pending).resolves.toMatchObject({ ok: false });

    expect(request?.body).toBeUndefined();
    expect(request?.signal?.aborted).toBe(true);
  });
});
