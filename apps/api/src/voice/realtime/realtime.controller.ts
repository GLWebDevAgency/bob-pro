import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Req,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { unwrap } from '../../http/result';
import { WithoutTenantPersistenceTransaction } from '../../persistence/tenant-persistence.interceptor';
import { RealtimeVoiceService } from './realtime.service';

interface AbortAwareRequest {
  once(event: 'aborted', listener: () => void): void;
  removeListener(event: 'aborted', listener: () => void): void;
}

interface HeaderResponse {
  setHeader(name: string, value: string): void;
}

@Controller('voice/realtime')
export class RealtimeVoiceController {
  constructor(private readonly realtime: RealtimeVoiceService) {}

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

  private applyRetryAfter(
    result: Awaited<ReturnType<
      RealtimeVoiceService['createCall']
      | RealtimeVoiceService['hangup']
      | RealtimeVoiceService['acknowledgeControl']
    >>,
    response: HeaderResponse,
  ): void {
    if (!result.ok && 'retryAfterSeconds' in result.error) {
      response.setHeader('Retry-After', String(result.error.retryAfterSeconds));
    }
  }
}
