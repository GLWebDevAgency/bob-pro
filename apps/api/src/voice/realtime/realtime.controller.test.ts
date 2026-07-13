import { EventEmitter } from 'node:events';
import { HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AppError, Result } from '@bob/core';
import { RealtimeVoiceController } from './realtime.controller';
import type { RealtimeVoiceService } from './realtime.service';
import type { RealtimeCallBootstrap } from './realtime.types';
import type { RealtimeApprovedAgentControl } from './realtime-sideband';

function responseStub() {
  return { setHeader: vi.fn() };
}

function serviceStub(input: {
  createCall?: (body: unknown, signal?: AbortSignal) => Promise<Result<RealtimeCallBootstrap, AppError>>;
  hangup?: (sessionHandle: string) => Promise<Result<{ ended: true }, AppError>>;
  acknowledgeControl?: (
    sessionHandle: string,
    body: unknown,
    signal?: AbortSignal,
  ) => Promise<Result<RealtimeApprovedAgentControl, AppError>>;
}): RealtimeVoiceService {
  return {
    publicConfig: vi.fn(),
    createCall: vi.fn(input.createCall),
    hangup: vi.fn(input.hangup),
    acknowledgeControl: vi.fn(input.acknowledgeControl),
  } as unknown as RealtimeVoiceService;
}

describe('RealtimeVoiceController', () => {
  it('répond 429 avec Retry-After issu du quota durable', async () => {
    const service = serviceStub({
      createCall: async () => ({
        ok: false,
        error: { kind: 'rate_limited', reason: 'quota', retryAfterSeconds: 37 },
      }),
    });
    const controller = new RealtimeVoiceController(service);
    const request = new EventEmitter();
    const response = responseStub();

    const rejected = controller.createCall({}, request as never, response);

    await expect(rejected).rejects.toBeInstanceOf(HttpException);
    await rejected.catch((error: unknown) => {
      expect((error as HttpException).getStatus()).toBe(429);
    });
    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '37');
  });

  it('propage l’abandon HTTP au bootstrap serveur et retire son listener', async () => {
    let receivedSignal: AbortSignal | undefined;
    let finish!: (value: Result<RealtimeCallBootstrap, AppError>) => void;
    const gate = new Promise<Result<RealtimeCallBootstrap, AppError>>((resolve) => { finish = resolve; });
    const service = serviceStub({
      createCall: async (_body, signal) => {
        receivedSignal = signal;
        return gate;
      },
    });
    const controller = new RealtimeVoiceController(service);
    const request = new EventEmitter();
    const response = responseStub();
    const running = controller.createCall({}, request as never, response);
    await vi.waitFor(() => expect(receivedSignal).toBeDefined());

    request.emit('aborted');
    expect(receivedSignal?.aborted).toBe(true);
    finish({ ok: false, error: { kind: 'unavailable', service: 'bob-live', retryAfterSeconds: 10 } });
    await expect(running).rejects.toBeInstanceOf(HttpException);
    expect(request.listenerCount('aborted')).toBe(0);
  });

  it('expose un hangup opaque idempotent', async () => {
    const hangup = vi.fn(async () => ({ ok: true as const, value: { ended: true as const } }));
    const controller = new RealtimeVoiceController(serviceStub({ hangup }));

    await expect(controller.hangup('00000000-0000-4000-8000-000000000001', responseStub()))
      .resolves.toEqual({ ended: true });
    expect(hangup).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001');
  });

  it('délègue l’acquittement opaque au service et retire le listener d’abandon', async () => {
    const handle = '00000000-0000-4000-8000-000000000001';
    const body = {
      turnId: '00000000-0000-4000-8000-000000000002',
      contextRevision: 3,
      contextDigest: 'a'.repeat(64),
    };
    let receivedSignal: AbortSignal | undefined;
    const acknowledgeControl = vi.fn(async (_handle: string, _body: unknown, signal?: AbortSignal) => {
      receivedSignal = signal;
      return {
        ok: true as const,
        value: { ...body, kind: 'answer' as const, navigate: '/cloture' },
      };
    });
    const controller = new RealtimeVoiceController(serviceStub({ acknowledgeControl }));
    const request = new EventEmitter();

    await expect(controller.acknowledgeControl(handle, body, request as never, responseStub()))
      .resolves.toEqual({ ...body, kind: 'answer', navigate: '/cloture' });
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal?.aborted).toBe(false);
    expect(acknowledgeControl).toHaveBeenCalledWith(handle, body, receivedSignal);
    expect(request.listenerCount('aborted')).toBe(0);
  });
});
