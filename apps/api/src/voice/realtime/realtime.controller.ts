import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Inject,
  Optional,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { unwrap } from '../../http/result';
import { getPrincipal } from '../../observability/logger';
import { WithoutTenantPersistenceTransaction } from '../../persistence/tenant-persistence.interceptor';
import type { RealtimeSidebandControl } from './realtime-sideband';
import { RealtimeVoiceService } from './realtime.service';
import { RealtimeSpeechDeliveryService } from './realtime-speech-delivery';
import { REALTIME_SIDEBAND } from './realtime.tokens';

interface AbortAwareRequest {
  once(event: 'aborted', listener: () => void): void;
  removeListener(event: 'aborted', listener: () => void): void;
}

interface HeaderResponse {
  setHeader(name: string, value: string): void;
  status?(code: number): HeaderResponse;
}

@Controller('voice/realtime')
export class RealtimeVoiceController {
  constructor(
    private readonly realtime: RealtimeVoiceService,
    @Optional() private readonly speech?: RealtimeSpeechDeliveryService,
    @Optional() @Inject(REALTIME_SIDEBAND) private readonly sideband?: RealtimeSidebandControl,
  ) {}

  @Get('config')
  @Header('Cache-Control', 'no-store, private')
  @Header('Pragma', 'no-cache')
  @Header('Expires', '0')
  @Header('Vary', 'Authorization')
  async config() {
    return this.realtime.publicConfig();
  }

  @Post('calls')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @WithoutTenantPersistenceTransaction()
  @Header('Cache-Control', 'no-store, private')
  @Header('Pragma', 'no-cache')
  @Header('Expires', '0')
  @Header('Vary', 'Authorization')
  async createCall(
    @Body() body: unknown,
    @Req() request: AbortAwareRequest,
    @Res({ passthrough: true }) response: HeaderResponse,
  ) {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    request.once('aborted', abort);
    try {
      const result = await this.realtime.createCall(body, controller.signal);
      this.applyRetryAfter(result, response);
      return unwrap(result);
    } finally {
      request.removeListener('aborted', abort);
    }
  }

  @Post('calls/:sessionHandle/resume-tickets')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @WithoutTenantPersistenceTransaction()
  @Header('Cache-Control', 'no-store, private, max-age=0')
  @Header('Pragma', 'no-cache')
  @Header('Expires', '0')
  @Header('Vary', 'Authorization')
  @Header('Referrer-Policy', 'no-referrer')
  async requestResumeTicket(
    @Param('sessionHandle') sessionHandle: string,
    @Body() body: unknown,
    @Req() request: AbortAwareRequest,
    @Res({ passthrough: true }) response: HeaderResponse,
  ) {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    request.once('aborted', abort);
    try {
      const result = await this.realtime.requestResumeTicket(
        sessionHandle,
        body,
        controller.signal,
      );
      this.applyRetryAfter(result, response);
      return unwrap(result);
    } finally {
      request.removeListener('aborted', abort);
    }
  }

  @Delete('calls/:sessionHandle')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @WithoutTenantPersistenceTransaction()
  @Header('Cache-Control', 'no-store, private')
  @Header('Pragma', 'no-cache')
  @Header('Expires', '0')
  @Header('Vary', 'Authorization')
  async hangup(
    @Param('sessionHandle') sessionHandle: string,
    @Res({ passthrough: true }) response: HeaderResponse,
  ) {
    const result = await this.realtime.hangup(sessionHandle);
    this.applyRetryAfter(result, response);
    return unwrap(result);
  }

  @Put('calls/:sessionHandle/context')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 240, ttl: 60_000 } })
  @WithoutTenantPersistenceTransaction()
  @Header('Cache-Control', 'no-store, private')
  @Header('Pragma', 'no-cache')
  @Header('Expires', '0')
  @Header('Vary', 'Authorization')
  async updateContext(
    @Param('sessionHandle') sessionHandle: string,
    @Body() body: unknown,
  ) {
    return unwrap(await this.realtime.updateContext(sessionHandle, body));
  }

  @Post('calls/:sessionHandle/control-acknowledgements')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @WithoutTenantPersistenceTransaction()
  @Header('Cache-Control', 'no-store, private')
  @Header('Pragma', 'no-cache')
  @Header('Expires', '0')
  @Header('Vary', 'Authorization')
  async acknowledgeControl(
    @Param('sessionHandle') sessionHandle: string,
    @Body() body: unknown,
    @Req() request: AbortAwareRequest,
    @Res({ passthrough: true }) response: HeaderResponse,
  ) {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    request.once('aborted', abort);
    try {
      const result = await this.realtime.acknowledgeControl(sessionHandle, body, controller.signal);
      this.applyRetryAfter(result, response);
      return unwrap(result);
    } finally {
      request.removeListener('aborted', abort);
    }
  }

  @Get('calls/:sessionHandle/speech')
  @Throttle({ default: { limit: 180, ttl: 60_000 } })
  @WithoutTenantPersistenceTransaction()
  @Header('Cache-Control', 'no-store, private, max-age=0')
  @Header('Pragma', 'no-cache')
  @Header('Expires', '0')
  @Header('Vary', 'Authorization')
  @Header('Referrer-Policy', 'no-referrer')
  async nextSpeech(
    @Param('sessionHandle') sessionHandle: string,
    @Query() query: unknown,
    @Req() request: AbortAwareRequest,
    @Res({ passthrough: true }) response: HeaderResponse,
  ) {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    request.once('aborted', abort);
    try {
      const result = this.speech
        ? await this.speech.next(sessionHandle, query, controller.signal)
        : { ok: false as const, error: { kind: 'unavailable' as const, service: 'bob-live-speech' } };
      this.applyRetryAfter(result, response);
      const value = unwrap(result);
      if (value.status === 'none') {
        response.status?.(HttpStatus.NO_CONTENT);
        return undefined;
      }
      if (value.status === 'rendering') {
        response.status?.(HttpStatus.ACCEPTED);
        return value;
      }
      if (value.status === 'terminal') {
        response.status?.(HttpStatus.GONE);
        return value;
      }
      response.status?.(HttpStatus.OK);
      const { status: _status, ...wire } = value;
      return wire;
    } finally {
      request.removeListener('aborted', abort);
    }
  }

  @Post('calls/:sessionHandle/turns/:turnId/speech/:artifactId/deliveries')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @WithoutTenantPersistenceTransaction()
  @Header('Cache-Control', 'no-store, private, max-age=0')
  @Header('Pragma', 'no-cache')
  @Header('Expires', '0')
  @Header('Vary', 'Authorization')
  @Header('Referrer-Policy', 'no-referrer')
  async acknowledgeSpeechDelivery(
    @Param('sessionHandle') sessionHandle: string,
    @Param('turnId') turnId: string,
    @Param('artifactId') artifactId: string,
    @Body() body: unknown,
    @Req() request: AbortAwareRequest,
    @Res({ passthrough: true }) response: HeaderResponse,
  ) {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    request.once('aborted', abort);
    try {
      const result = this.speech
        ? await this.speech.acknowledgeDelivery(
            sessionHandle,
            turnId,
            artifactId,
            body,
            controller.signal,
          )
        : { ok: false as const, error: { kind: 'unavailable' as const, service: 'bob-live-speech' } };
      this.applyRetryAfter(result, response);
      const acknowledgement = unwrap(result);
      const principal = getPrincipal();
      if (
        acknowledgement.controlReference
        && principal?.userId
        && principal.companyId
        && this.sideband?.speechDelivered
      ) {
        // Cette notification n'ouvre le contrôle qu'APRÈS le CAS durable ready -> delivered.
        // L'artefact et le contexte sont tous deux revalidés dans acknowledgeDelivery.
        this.sideband.speechDelivered({
          userId: principal.userId,
          companyId: principal.companyId,
          sessionHandle,
          artifactId,
          ...acknowledgement.controlReference,
        });
      }
      return acknowledgement;
    } finally {
      request.removeListener('aborted', abort);
    }
  }

  @Post('calls/:sessionHandle/turns/:turnId/speech/:artifactId/cancellations')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 180, ttl: 60_000 } })
  @WithoutTenantPersistenceTransaction()
  @Header('Cache-Control', 'no-store, private, max-age=0')
  @Header('Pragma', 'no-cache')
  @Header('Expires', '0')
  @Header('Vary', 'Authorization')
  @Header('Referrer-Policy', 'no-referrer')
  async cancelSpeech(
    @Param('sessionHandle') sessionHandle: string,
    @Param('turnId') turnId: string,
    @Param('artifactId') artifactId: string,
    @Body() body: unknown,
    @Req() request: AbortAwareRequest,
    @Res({ passthrough: true }) response: HeaderResponse,
  ) {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    request.once('aborted', abort);
    try {
      const result = this.speech
        ? await this.speech.cancel(sessionHandle, turnId, artifactId, body, controller.signal)
        : { ok: false as const, error: { kind: 'unavailable' as const, service: 'bob-live-speech' } };
      this.applyRetryAfter(result, response);
      unwrap(result);
      return undefined;
    } finally {
      request.removeListener('aborted', abort);
    }
  }

  private applyRetryAfter(
    result: { readonly ok: boolean; readonly error?: unknown },
    response: HeaderResponse,
  ): void {
    const error = result.error;
    if (!result.ok
      && typeof error === 'object'
      && error !== null
      && 'retryAfterSeconds' in error
      && typeof error.retryAfterSeconds === 'number') {
      response.setHeader('Retry-After', String(error.retryAfterSeconds));
    }
  }
}
