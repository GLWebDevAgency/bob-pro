import { EventEmitter } from 'node:events';
import { HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AppError, Result } from '@bob/core';
import { requestContext } from '../../observability/logger';
import { RealtimeVoiceController } from './realtime.controller';
import type { RealtimeVoiceService } from './realtime.service';
import type { RealtimeCallBootstrap, RealtimeVoiceResumeTicket } from './realtime.types';
import type { RealtimeApprovedAgentControl } from './realtime-sideband';
import type { RealtimeSpeechDeliveryService } from './realtime-speech-delivery';
import type { OpenAiNativeSpeechAcknowledgementService } from './openai-native-speech-acknowledgement';

function responseStub() {
  const response = { setHeader: vi.fn(), status: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function serviceStub(input: {
  createCall?: (body: unknown, signal?: AbortSignal) => Promise<Result<RealtimeCallBootstrap, AppError>>;
  hangup?: (sessionHandle: string) => Promise<Result<{ ended: true }, AppError>>;
  acknowledgeControl?: (
    sessionHandle: string,
    body: unknown,
    signal?: AbortSignal,
  ) => Promise<Result<RealtimeApprovedAgentControl, AppError>>;
  requestResumeTicket?: (
    sessionHandle: string,
    body: unknown,
    signal: AbortSignal,
  ) => Promise<Result<RealtimeVoiceResumeTicket, AppError>>;
}): RealtimeVoiceService {
  return {
    publicConfig: vi.fn(),
    createCall: vi.fn(input.createCall),
    hangup: vi.fn(input.hangup),
    acknowledgeControl: vi.fn(input.acknowledgeControl),
    requestResumeTicket: vi.fn(input.requestResumeTicket),
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

  it('propage l’abandon HTTP au ticket de reprise et applique Retry-After', async () => {
    let receivedSignal: AbortSignal | undefined;
    let finish!: (value: Result<RealtimeVoiceResumeTicket, AppError>) => void;
    const gate = new Promise<Result<RealtimeVoiceResumeTicket, AppError>>((resolve) => {
      finish = resolve;
    });
    const requestResumeTicket = vi.fn(async (
      _sessionHandle: string,
      _body: unknown,
      signal: AbortSignal,
    ) => {
      receivedSignal = signal;
      return gate;
    });
    const controller = new RealtimeVoiceController(serviceStub({ requestResumeTicket }));
    const request = new EventEmitter();
    const response = responseStub();
    const running = controller.requestResumeTicket(
      'mistral_resume_session_0001',
      { missionConnectionEpoch: 1, nextServerSequence: 0 },
      request as never,
      response,
    );
    await vi.waitFor(() => expect(receivedSignal).toBeDefined());

    request.emit('aborted');
    expect(receivedSignal?.aborted).toBe(true);
    finish({
      ok: false,
      error: { kind: 'unavailable', service: 'bob-live-mistral-resume', retryAfterSeconds: 5 },
    });
    await expect(running).rejects.toBeInstanceOf(HttpException);
    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '5');
    expect(request.listenerCount('aborted')).toBe(0);
    expect(requestResumeTicket).toHaveBeenCalledWith(
      'mistral_resume_session_0001',
      { missionConnectionEpoch: 1, nextServerSequence: 0 },
      receivedSignal,
    );
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

  it('publie un artefact ready sans exposer son discriminant interne et force HTTP 200', async () => {
    const next = vi.fn(async () => ({
      ok: true as const,
      value: {
        status: 'ready' as const,
        artifactId: '00000000-0000-4000-8000-000000000003',
        turnId: '00000000-0000-4000-8000-000000000002',
        sequence: 1,
        contextRevision: 7,
        contextDigest: 'a'.repeat(64),
        audioUrl: 'https://storage.bob.test/private?token=opaque',
        audioSha256: 'b'.repeat(64),
        mimeType: 'audio/mpeg' as const,
        byteSize: 24_000,
        durationMs: 1_250,
      },
    }));
    const speech = { next } as unknown as RealtimeSpeechDeliveryService;
    const controller = new RealtimeVoiceController(serviceStub({}), speech);
    const request = new EventEmitter();
    const response = responseStub();

    const body = await controller.nextSpeech(
      '00000000-0000-4000-8000-000000000001',
      { afterSequence: '0', waitMs: '0' },
      request as never,
      response,
    );

    expect(body).not.toHaveProperty('status');
    expect(body).toMatchObject({ artifactId: '00000000-0000-4000-8000-000000000003' });
    expect(response.status).toHaveBeenCalledWith(200);
    expect(next).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000001',
      { afterSequence: '0', waitMs: '0' },
      expect.any(AbortSignal),
    );
    expect(request.listenerCount('aborted')).toBe(0);
  });

  it.each([
    [{ status: 'none' as const }, 204],
    [{
      status: 'rendering' as const,
      artifactId: '00000000-0000-4000-8000-000000000003',
      turnId: '00000000-0000-4000-8000-000000000002',
      sequence: 1,
      contextRevision: 7,
      contextDigest: 'a'.repeat(64),
    }, 202],
    [{
      status: 'terminal' as const,
      reason: 'cancelled' as const,
      artifactId: '00000000-0000-4000-8000-000000000003',
      turnId: '00000000-0000-4000-8000-000000000002',
      sequence: 1,
      contextRevision: 7,
      contextDigest: 'a'.repeat(64),
    }, 410],
  ])('préserve le statut métier dynamique %#', async (value, status) => {
    const speech = {
      next: vi.fn(async () => ({ ok: true as const, value })),
    } as unknown as RealtimeSpeechDeliveryService;
    const controller = new RealtimeVoiceController(serviceStub({}), speech);
    const response = responseStub();

    await controller.nextSpeech(
      '00000000-0000-4000-8000-000000000001',
      { afterSequence: '0' },
      new EventEmitter() as never,
      response,
    );

    expect(response.status).toHaveBeenCalledWith(status);
  });

  it('propage l’abandon HTTP à l’annulation durable et retire le listener', async () => {
    let receivedSignal: AbortSignal | undefined;
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const cancel = vi.fn(async (
      _session: string,
      _turn: string,
      _artifact: string,
      _body: unknown,
      signal?: AbortSignal,
    ) => {
      receivedSignal = signal;
      await gate;
      return { ok: false as const, error: { kind: 'unavailable' as const, service: 'bob-live-speech' } };
    });
    const speech = { cancel } as unknown as RealtimeSpeechDeliveryService;
    const controller = new RealtimeVoiceController(serviceStub({}), speech);
    const request = new EventEmitter();
    const pending = controller.cancelSpeech(
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000003',
      { cancellationId: '00000000-0000-4000-8000-000000000005', reason: 'barge_in' },
      request as never,
      responseStub(),
    );
    await vi.waitFor(() => expect(receivedSignal).toBeDefined());

    request.emit('aborted');
    finish();

    expect(receivedSignal?.aborted).toBe(true);
    await expect(pending).rejects.toBeInstanceOf(HttpException);
    expect(request.listenerCount('aborted')).toBe(0);
  });

  it('ouvre le contrôle sideband seulement après l’ACK durable livré et exactement lié', async () => {
    const sessionHandle = '00000000-0000-4000-8000-000000000001';
    const turnId = '00000000-0000-4000-8000-000000000002';
    const artifactId = '00000000-0000-4000-8000-000000000003';
    const acknowledgementId = '00000000-0000-4000-8000-000000000004';
    const contextDigest = 'a'.repeat(64);
    const acknowledgeDelivery = vi.fn(async () => ({
      ok: true as const,
      value: {
        controlReference: { turnId, acknowledgementId, contextRevision: 7, contextDigest },
      },
    }));
    const speechDelivered = vi.fn();
    const controller = new RealtimeVoiceController(
      serviceStub({}),
      { acknowledgeDelivery } as unknown as RealtimeSpeechDeliveryService,
      { speechDelivered } as unknown as import('./realtime-sideband').RealtimeSidebandControl,
    );

    const result = await requestContext.run(
      {
        correlationId: 'test-speech-delivery-control',
        principal: { userId: 'user-1', companyId: 'company-1' },
      },
      () => controller.acknowledgeSpeechDelivery(
        sessionHandle,
        turnId,
        artifactId,
        { deliveryId: acknowledgementId, audioSha256: 'b'.repeat(64) },
        new EventEmitter() as never,
        responseStub(),
      ),
    );

    expect(result).toEqual({
      controlReference: { turnId, acknowledgementId, contextRevision: 7, contextDigest },
    });
    expect(speechDelivered).toHaveBeenCalledWith({
      userId: 'user-1',
      companyId: 'company-1',
      sessionHandle,
      turnId,
      artifactId,
      acknowledgementId,
      contextRevision: 7,
      contextDigest,
    });
    expect(acknowledgeDelivery.mock.invocationCallOrder[0])
      .toBeLessThan(speechDelivered.mock.invocationCallOrder[0]!);
  });

  it('ne notifie jamais le sideband si l’artefact livré ne porte aucun contrôle', async () => {
    const speechDelivered = vi.fn();
    const controller = new RealtimeVoiceController(
      serviceStub({}),
      {
        acknowledgeDelivery: vi.fn(async () => ({ ok: true as const, value: {} })),
      } as unknown as RealtimeSpeechDeliveryService,
      { speechDelivered } as unknown as import('./realtime-sideband').RealtimeSidebandControl,
    );

    await controller.acknowledgeSpeechDelivery(
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000003',
      {},
      new EventEmitter() as never,
      responseStub(),
    );
    expect(speechDelivered).not.toHaveBeenCalled();
  });

  it('notifie le sideband seulement après l’ACK natif durable sans ouvrir le contrôle audité', async () => {
    const sessionHandle = '10000000-0000-4000-8000-000000000001';
    const turnId = '20000000-0000-4000-8000-000000000002';
    const deliveryId = '30000000-0000-4000-8000-000000000003';
    const acknowledgementId = '40000000-0000-4000-8000-000000000004';
    const contextDigest = 'a'.repeat(64);
    let receivedSignal: AbortSignal | undefined;
    const acknowledge = vi.fn(async (
      _session: unknown,
      _turn: unknown,
      _delivery: unknown,
      _body: unknown,
      signal?: AbortSignal,
    ) => {
      receivedSignal = signal;
      return {
        ok: true as const,
        value: {
          deliveryId,
          turnId,
          acknowledgementId,
          contextRevision: 7,
          contextDigest,
          idempotent: false,
        },
      };
    });
    const speechDelivered = vi.fn();
    const nativeSpeechDelivered = vi.fn();
    const controller = new RealtimeVoiceController(
      serviceStub({}),
      undefined,
      {
        speechDelivered,
        nativeSpeechDelivered,
      } as unknown as import('./realtime-sideband').RealtimeSidebandControl,
      { acknowledge } as unknown as OpenAiNativeSpeechAcknowledgementService,
    );
    const request = new EventEmitter();
    const response = responseStub();
    const body = {
      acknowledgementId,
      contextRevision: 7,
      contextDigest,
      localObservation: {
        formatVersion: 1,
        kind: 'webrtc_remote_rtp_observed_provider_drained_v1',
      },
      slo: { speechStoppedEventToFirstInboundRtpMs: 701 },
    };

    await expect(requestContext.run(
      {
        correlationId: 'test-native-speech-delivery-sideband',
        principal: { userId: 'user-1', companyId: 'company-1' },
      },
      () => controller.acknowledgeNativeSpeechDelivery(
        sessionHandle,
        turnId,
        deliveryId,
        body,
        request as never,
        response,
      ),
    )).resolves.toEqual({
      deliveryId,
      turnId,
      acknowledgementId,
      contextRevision: 7,
      contextDigest,
      idempotent: false,
    });
    expect(acknowledge).toHaveBeenCalledWith(
      sessionHandle,
      turnId,
      deliveryId,
      body,
      receivedSignal,
    );
    expect(receivedSignal).toBeDefined();
    expect(speechDelivered).not.toHaveBeenCalled();
    expect(nativeSpeechDelivered).toHaveBeenCalledWith({
      userId: 'user-1',
      companyId: 'company-1',
      sessionHandle,
      deliveryId,
      turnId,
      acknowledgementId,
      contextRevision: 7,
      contextDigest,
    });
    expect(acknowledge.mock.invocationCallOrder[0])
      .toBeLessThan(nativeSpeechDelivered.mock.invocationCallOrder[0]!);
    expect(request.listenerCount('aborted')).toBe(0);
  });

  it('propage l’abandon et Retry-After sur l’ACK natif indisponible', async () => {
    let receivedSignal: AbortSignal | undefined;
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const acknowledge = vi.fn(async (
      _session: unknown,
      _turn: unknown,
      _delivery: unknown,
      _body: unknown,
      signal?: AbortSignal,
    ) => {
      receivedSignal = signal;
      await gate;
      return {
        ok: false as const,
        error: {
          kind: 'unavailable' as const,
          service: 'bob-live-native-acknowledgement',
          retryAfterSeconds: 1,
        },
      };
    });
    const nativeSpeechDelivered = vi.fn();
    const controller = new RealtimeVoiceController(
      serviceStub({}),
      undefined,
      { nativeSpeechDelivered } as unknown as import('./realtime-sideband').RealtimeSidebandControl,
      { acknowledge } as unknown as OpenAiNativeSpeechAcknowledgementService,
    );
    const request = new EventEmitter();
    const response = responseStub();
    const pending = controller.acknowledgeNativeSpeechDelivery(
      '10000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000002',
      '30000000-0000-4000-8000-000000000003',
      {
        acknowledgementId: '40000000-0000-4000-8000-000000000004',
        contextRevision: 7,
        contextDigest: 'a'.repeat(64),
        localObservation: {
          formatVersion: 1,
          kind: 'webrtc_remote_rtp_observed_provider_drained_v1',
        },
        slo: { speechStoppedEventToFirstInboundRtpMs: 701 },
      },
      request as never,
      response,
    );
    await vi.waitFor(() => expect(receivedSignal).toBeDefined());
    request.emit('aborted');
    finish();

    expect(receivedSignal?.aborted).toBe(true);
    await expect(pending).rejects.toBeInstanceOf(HttpException);
    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '1');
    expect(nativeSpeechDelivered).not.toHaveBeenCalled();
    expect(request.listenerCount('aborted')).toBe(0);
  });
});
