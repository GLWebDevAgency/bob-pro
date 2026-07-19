import { EventEmitter } from 'node:events';
import { HEADERS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AppError, Result } from '@bob/core';
import { RealtimeVoiceController } from './realtime.controller';
import type { RealtimeVoiceService } from './realtime.service';
import type { RealtimeVoiceBootstrapReconciliation } from './realtime.types';

function responseStub() {
  const response = { setHeader: vi.fn(), status: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

describe('RealtimeVoiceController — réconciliation du bootstrap', () => {
  it('propage l’abandon HTTP, applique Retry-After et retire son listener', async () => {
    let receivedSignal: AbortSignal | undefined;
    let finish!: (value: Result<RealtimeVoiceBootstrapReconciliation, AppError>) => void;
    const gate = new Promise<Result<RealtimeVoiceBootstrapReconciliation, AppError>>((resolve) => {
      finish = resolve;
    });
    const reconcileInitialBootstrap = vi.fn(async (
      _sessionHandle: string,
      _body: unknown,
      signal: AbortSignal,
    ) => {
      receivedSignal = signal;
      return gate;
    });
    const service = { reconcileInitialBootstrap } as unknown as RealtimeVoiceService;
    const controller = new RealtimeVoiceController(service);
    const request = new EventEmitter();
    const response = responseStub();
    const body = {
      protocol: 'bob.mistral-pcm.v2',
      bootstrapTicket: 'b2_QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI',
      attempt: 1,
    };
    const running = controller.reconcileInitialBootstrap(
      'mistral_reconcile_session_0001',
      body,
      request as never,
      response,
    );
    await vi.waitFor(() => expect(receivedSignal).toBeDefined());

    request.emit('aborted');
    expect(receivedSignal?.aborted).toBe(true);
    finish({
      ok: false,
      error: {
        kind: 'unavailable',
        service: 'bob-live-mistral-reconciliation',
        retryAfterSeconds: 5,
      },
    });
    await expect(running).rejects.toBeInstanceOf(HttpException);
    await running.catch((error: unknown) => {
      expect((error as HttpException).getStatus()).toBe(503);
    });
    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '5');
    expect(request.listenerCount('aborted')).toBe(0);
    expect(reconcileInitialBootstrap).toHaveBeenCalledWith(
      'mistral_reconcile_session_0001',
      body,
      receivedSignal,
    );
  });

  it('grave la route ressource, les headers privés, le throttle 30/min et la sortie transactionnelle', () => {
    const handler = RealtimeVoiceController.prototype.reconcileInitialBootstrap;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(
      'calls/:sessionHandle/bootstrap-reconciliations',
    );
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(30);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', handler)).toBe(60_000);

    const headers = Reflect.getMetadata(HEADERS_METADATA, handler) as readonly {
      name: string;
      value: string;
    }[];
    expect(Object.fromEntries(headers.map(({ name, value }) => [name.toLowerCase(), value])))
      .toMatchObject({
        'cache-control': 'no-store, private, max-age=0',
        pragma: 'no-cache',
        expires: '0',
        vary: 'Authorization',
        'referrer-policy': 'no-referrer',
      });
    const tenantEscape = Reflect.getMetadataKeys(handler).find(
      (key) => typeof key === 'symbol' && key.description === 'tenant-transaction-disabled',
    );
    expect(tenantEscape).toBeDefined();
    expect(Reflect.getMetadata(tenantEscape!, handler)).toBe(true);
  });
});
