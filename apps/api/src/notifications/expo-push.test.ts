import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppLogger } from '../observability/logger';
import { ExpoPushService, type ExpoPushMessage } from './expo-push';

const warn = vi.fn();
const logger = { audit: vi.fn(), warn } as unknown as AppLogger;

function okTickets(count: number): Response {
  return new Response(JSON.stringify({ data: Array.from({ length: count }, () => ({ status: 'ok' })) }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function message(i: number): ExpoPushMessage {
  return { to: `ExponentPushToken[tok-${i}]`, title: 'Relance', body: 'SARL Martin · 1 240 €', data: { route: '/facture/inv-1' } };
}

describe('ExpoPushService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('chunke par 100 (limite API Expo) et compte les tickets acceptés', async () => {
    const calls: unknown[][] = [];
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      const batch = JSON.parse(String(init.body)) as unknown[];
      calls.push(batch);
      return okTickets(batch.length);
    });
    const service = new ExpoPushService(logger, fetchFn);

    const outcome = await service.send(Array.from({ length: 150 }, (_, i) => message(i)));

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(calls[0]).toHaveLength(100);
    expect(calls[1]).toHaveLength(50);
    expect(outcome).toEqual({ accepted: 150, rejected: [] });
    const [url, init] = fetchFn.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://exp.host/--/api/v2/push/send');
    expect(JSON.parse(String(init.body))[0]).toMatchObject({ title: 'Relance', data: { route: '/facture/inv-1' } });
  });

  it('remonte les erreurs PAR TICKET (loggées, jamais silencieuses) avec le token fautif', async () => {
    const fetchFn = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [
            { status: 'ok' },
            { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered' } },
          ],
        }),
        { status: 200 },
      ),
    );
    const service = new ExpoPushService(logger, fetchFn);

    const outcome = await service.send([message(1), message(2)]);

    expect(outcome.accepted).toBe(1);
    expect(outcome.rejected).toEqual([{ token: 'ExponentPushToken[tok-2]', error: 'DeviceNotRegistered' }]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('DeviceNotRegistered'), 'notifications');
  });

  it('ne transmet jamais aux logs un token Expo, son préfixe, même réfléchi par le provider ou le transport', async () => {
    const token = 'ExponentPushToken[ultra-secret-installation-42]';
    const reflectedTicketError = `invalid recipient ${token}`;
    const ticketFailure = new ExpoPushService(
      logger,
      vi.fn(async () => new Response(JSON.stringify({
        data: [{ status: 'error', message: reflectedTicketError }],
      }), { status: 200 })),
    );

    expect(await ticketFailure.send([{ ...message(1), to: token }])).toEqual({
      accepted: 0,
      rejected: [{ token, error: reflectedTicketError }],
    });

    const reflectedPrefix = token.slice(0, 31);
    const transportFailure = new ExpoPushService(
      logger,
      vi.fn(async () => Promise.reject(new Error(`timeout for ${reflectedPrefix}…`))),
    );
    await transportFailure.send([{ ...message(2), to: token }]);

    const serializedLogs = JSON.stringify(warn.mock.calls);
    expect(serializedLogs).toContain('[push-token-redacted]');
    expect(serializedLogs).not.toContain(token);
    expect(serializedLogs).not.toContain(reflectedPrefix);
    expect(serializedLogs).not.toContain('ExponentPushToken');
    expect(serializedLogs).not.toContain('ultra-secret-installation');
  });

  it('API injoignable ou HTTP non-2xx : tout le lot est rejeté proprement, sans lever', async () => {
    const http500 = new ExpoPushService(logger, vi.fn(async () => new Response('boom', { status: 500 })));
    expect(await http500.send([message(1)])).toEqual({
      accepted: 0,
      rejected: [{ token: 'ExponentPushToken[tok-1]', error: 'Expo Push HTTP 500' }],
    });

    const offline = new ExpoPushService(logger, vi.fn(async () => Promise.reject(new Error('réseau coupé'))));
    expect(await offline.send([message(1)])).toEqual({
      accepted: 0,
      rejected: [{ token: 'ExponentPushToken[tok-1]', error: 'réseau coupé' }],
    });

    expect(await offline.send([])).toEqual({ accepted: 0, rejected: [] }); // aucun message : aucun appel
  });
});
