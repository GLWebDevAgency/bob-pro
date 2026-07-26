import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import { unwrap } from '../http/result';
import { WithoutTenantPersistenceTransaction } from '../persistence/tenant-persistence.interceptor';
import {
  AGENT_MISSION_HTTP_AUTHORITY,
  type AgentMissionHttpAuthority,
  type AgentMissionHttpOperation,
} from './agent-mission-http-authority';
import { AgentMissionService } from './agent-mission.service';

interface StatusResponse {
  status(code: number): unknown;
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function invalidBody(field: string, message: string): never {
  throw new HttpException(
    { ok: false, error: { kind: 'validation', issues: [{ field, message }] } },
    HttpStatus.UNPROCESSABLE_ENTITY,
  );
}

function exactBody(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const body = jsonObject(value);
  if (body === null) invalidBody('body', 'Corps JSON objet requis.');
  const unknown = Object.keys(body).find((field) => !fields.includes(field));
  if (unknown !== undefined) invalidBody(unknown, 'Champ non autorisé.');
  for (const field of fields) {
    if (!(field in body)) invalidBody(field, 'Champ requis.');
  }
  return body;
}

@Controller('agent-missions')
@WithoutTenantPersistenceTransaction()
export class AgentMissionController {
  constructor(
    @Inject(AgentMissionService)
    private readonly missions: AgentMissionService,
    @Inject(AGENT_MISSION_HTTP_AUTHORITY)
    private readonly authority: AgentMissionHttpAuthority,
  ) {}

  private requireAuthority(
    operation: AgentMissionHttpOperation,
    capability: string | undefined,
  ) {
    return unwrap(this.authority.prepare(operation, capability));
  }

  @Get('current/quote-creation')
  @Header('Cache-Control', 'private, no-store')
  async getCurrent(
    @Headers('x-bob-agent-mission-capability') capability: string | undefined,
  ) {
    const authorization = this.requireAuthority(
      'get_current_quote_creation',
      capability,
    );
    return unwrap(await this.missions.getCurrent(authorization));
  }

  @Post('quote-creation/start')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  async start(
    @Body() value: unknown,
    @Res({ passthrough: true }) response: StatusResponse,
    @Headers('x-bob-agent-mission-capability') capability: string | undefined,
  ) {
    const authorization = this.requireAuthority('start_quote_creation', capability);
    const body = exactBody(value, ['commandId']);
    const result = unwrap(await this.missions.start({
      authorization,
      commandId: body.commandId as string,
    }));
    response.status(result.outcome === 'created' ? HttpStatus.CREATED : HttpStatus.OK);
    return result;
  }

  @Post(':missionId/cancel')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  async cancel(
    @Param('missionId') missionId: string,
    @Body() value: unknown,
    @Headers('x-bob-agent-mission-capability') capability: string | undefined,
  ) {
    const authorization = this.requireAuthority('cancel_quote_creation', capability);
    const body = exactBody(value, ['commandId', 'expectedMissionRevision']);
    return unwrap(await this.missions.cancel({
      authorization,
      missionId,
      commandId: body.commandId as string,
      expectedMissionRevision: body.expectedMissionRevision as number,
    }));
  }

  @Post(':missionId/screen-acks')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  async acknowledgeScreen(
    @Param('missionId') missionId: string,
    @Body() value: unknown,
    @Headers('x-bob-agent-mission-capability') capability: string | undefined,
  ) {
    const authorization = this.requireAuthority(
      'acknowledge_quote_screen',
      capability,
    );
    const body = exactBody(value, [
      'commandId',
      'expectedMissionRevision',
      'realtimeSessionId',
      'contextRevision',
      'contextDigest',
      'draftSessionId',
      'expectedDraftSlotRevision',
      'expectedDraftContentRevision',
    ]);
    return unwrap(await this.missions.acknowledgeScreen({
      authorization,
      missionId,
      commandId: body.commandId as string,
      expectedMissionRevision: body.expectedMissionRevision as number,
      realtimeSessionId: body.realtimeSessionId as string,
      contextRevision: body.contextRevision as number,
      contextDigest: body.contextDigest as string,
      draftSessionId: body.draftSessionId as string,
      expectedDraftSlotRevision: body.expectedDraftSlotRevision as number,
      expectedDraftContentRevision: body.expectedDraftContentRevision as number,
    }));
  }
}
