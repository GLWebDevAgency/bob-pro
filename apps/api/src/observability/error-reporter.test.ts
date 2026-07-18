import { describe, expect, it, vi } from 'vitest';
import { HttpErrorReporter } from './error-reporter';
import type { AppLogger } from './logger';

const ENDPOINT = 'https://hooks.example.test/errors';

function loggerDouble(): { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; asLogger: AppLogger } {
  const warn = vi.fn();
  const error = vi.fn();
  return { warn, error, asLogger: { warn, error } as unknown as AppLogger };
}

function respond(status: number): Promise<Response> {
  return Promise.resolve(new Response(null, { status }));
}

/** Vide la microtask queue + timers courts : captureException est fire-and-forget. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('HttpErrorReporter — dégradation propre quand la destination est morte', () => {
  it('warn par échec sous le seuil, puis UN SEUL log de désactivation et plus aucun appel', async () => {
    const { warn, error, asLogger } = loggerDouble();
    const fetchFn = vi.fn(() => respond(404));
    const reporter = new HttpErrorReporter(ENDPOINT, asLogger, fetchFn as unknown as typeof fetch);

    for (let i = 0; i < 5; i++) {
      reporter.captureException(new Error('boom'), { correlationId: `c-${i}` });
      await flush();
    }

    expect(fetchFn).toHaveBeenCalledTimes(5);
    expect(warn).toHaveBeenCalledTimes(4); // échecs 1 à 4
    expect(warn).toHaveBeenCalledWith('Error reporter HTTP 404.', 'ErrorReporter');
    expect(error).toHaveBeenCalledTimes(1); // désactivation explicite au 5e
    expect(String(error.mock.calls[0]?.[0])).toContain('ERROR_REPORTER_WEBHOOK_URL');

    // Destination morte : plus AUCUN trafic ni log supplémentaire.
    reporter.captureException(new Error('encore'), {});
    await flush();
    expect(fetchFn).toHaveBeenCalledTimes(5);
    expect(warn).toHaveBeenCalledTimes(4);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('un succès remet le compteur d’échecs consécutifs à zéro', async () => {
    const { warn, error, asLogger } = loggerDouble();
    const statuses = [404, 404, 404, 404, 200, 404];
    const fetchFn = vi.fn(() => respond(statuses.shift() ?? 200));
    const reporter = new HttpErrorReporter(ENDPOINT, asLogger, fetchFn as unknown as typeof fetch);

    for (let i = 0; i < 6; i++) {
      reporter.captureException(new Error('boom'), {});
      await flush();
    }

    // 4 échecs, succès (reset), puis 1er échec d'une nouvelle série : jamais désactivé.
    expect(fetchFn).toHaveBeenCalledTimes(6);
    expect(warn).toHaveBeenCalledTimes(5);
    expect(error).not.toHaveBeenCalled();
  });

  it('les pannes réseau comptent aussi vers la désactivation', async () => {
    const { warn, error, asLogger } = loggerDouble();
    const fetchFn = vi.fn(() => Promise.reject(new Error('ECONNREFUSED')));
    const reporter = new HttpErrorReporter(ENDPOINT, asLogger, fetchFn as unknown as typeof fetch);

    for (let i = 0; i < 5; i++) {
      reporter.captureException(new Error('boom'), {});
      await flush();
    }

    expect(warn).toHaveBeenCalledTimes(4);
    expect(warn).toHaveBeenCalledWith('Error reporter indisponible.', 'ErrorReporter');
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('n’envoie jamais message ni stack — uniquement type + contexte fournis', async () => {
    const { asLogger } = loggerDouble();
    const fetchFn = vi.fn(() => respond(200));
    const reporter = new HttpErrorReporter(ENDPOINT, asLogger, fetchFn as unknown as typeof fetch);

    reporter.captureException(new RangeError('IBAN FR76 SECRET'), { correlationId: 'abc' });
    await flush();

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(ENDPOINT);
    expect(String(init.body)).toBe(
      JSON.stringify({ service: 'bob-pro-api', errorType: 'RangeError', context: { correlationId: 'abc' } }),
    );
    expect(String(init.body)).not.toContain('SECRET');
  });
});
