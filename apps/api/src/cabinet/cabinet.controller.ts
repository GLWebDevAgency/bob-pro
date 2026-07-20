import { Body, Controller, Delete, Get, Headers, HttpCode, HttpException, HttpStatus, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { CabinetApiService } from './cabinet-api.service';

const createCabinetSchema = z.object({
  name: z.string().trim().min(2).max(120),
  timeZone: z.string().trim().min(1).max(64).optional(),
}).strict();
const inviteSchema = z.object({
  email: z.string().trim().email().max(254),
  role: z.enum(['admin', 'manager', 'collaborator']).default('collaborator'),
}).strict();
const updateMemberSchema = z.object({
  role: z.enum(['admin', 'manager', 'collaborator']).optional(),
  status: z.enum(['active', 'suspended', 'revoked']).optional(),
}).strict().refine((value) => Number(value.role !== undefined) + Number(value.status !== undefined) === 1);
const acceptInvitationSchema = z.object({ token: z.string().trim().min(1).max(256) }).strict();
const cursorPageSchema = z.object({
  cursor: z.string().trim().min(1).max(160).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
}).strict();

function bodyOf<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new HttpException(
      {
        code: 'CABINET_VALIDATION',
        params: { issues: parsed.error.issues.map((issue) => ({ field: issue.path.join('.'), code: issue.code })) },
      },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
  return parsed.data;
}

function dossierValidation(field: string): never {
  throw new HttpException(
    { code: 'CABINET_DOSSIER_INVALID', params: { field } },
    HttpStatus.UNPROCESSABLE_ENTITY,
  );
}

export function dossierExpectedRevision(
  ifMatch: string | undefined,
  ifNoneMatch: string | undefined,
): number | null {
  if (ifMatch === undefined && ifNoneMatch === '*') return null;
  if (ifNoneMatch === undefined && ifMatch !== undefined) {
    const match = /^"([1-9]\d*)"$/.exec(ifMatch.trim());
    const revision = match?.[1] ? Number(match[1]) : Number.NaN;
    if (Number.isSafeInteger(revision)) return revision;
    dossierValidation('if-match');
  }
  if (ifMatch === undefined && ifNoneMatch === undefined) {
    throw new HttpException(
      { code: 'CABINET_DOSSIER_PRECONDITION_REQUIRED' },
      HttpStatus.PRECONDITION_REQUIRED,
    );
  }
  dossierValidation('precondition');
}

function dossierInput(body: unknown, siren: string, expectedRevision: number | null): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) dossierValidation('body');
  const input = body as Record<string, unknown>;
  if ('expectedRevision' in input) dossierValidation('expectedRevision');
  if (input.siren !== siren) dossierValidation('siren');
  return { ...input, expectedRevision };
}

@Controller('cabinet/v1')
export class CabinetController {
  constructor(private readonly cabinet: CabinetApiService) {}

  @Get('availability')
  availability() {
    return this.cabinet.availability();
  }

  @Get('cabinets')
  listCabinets() {
    return this.cabinet.listCabinets();
  }

  @Post('cabinets')
  createCabinet(@Body() body: unknown) {
    return this.cabinet.createCabinet(bodyOf(createCabinetSchema, body));
  }

  @Get('cabinets/:cabinetId')
  getCabinet(@Param('cabinetId') cabinetId: string) {
    return this.cabinet.getCabinet(cabinetId);
  }

  @Get('cabinets/:cabinetId/members')
  listMembers(@Param('cabinetId') cabinetId: string, @Query() query: unknown) {
    return this.cabinet.listMembers(cabinetId, bodyOf(cursorPageSchema, query));
  }

  @Get('cabinets/:cabinetId/dossiers')
  listDossiers(@Param('cabinetId') cabinetId: string, @Query() query: unknown) {
    return this.cabinet.listDossiers(cabinetId, bodyOf(cursorPageSchema, query));
  }

  @Get('cabinets/:cabinetId/dossiers/:siren')
  getDossier(@Param('cabinetId') cabinetId: string, @Param('siren') siren: string) {
    return this.cabinet.getDossier(cabinetId, siren);
  }

  @Put('cabinets/:cabinetId/dossiers/:siren')
  saveDossier(
    @Param('cabinetId') cabinetId: string,
    @Param('siren') siren: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Body() body: unknown,
  ) {
    return this.cabinet.saveDossier(
      cabinetId,
      dossierInput(body, siren, dossierExpectedRevision(ifMatch, ifNoneMatch)),
    );
  }

  @Delete('cabinets/:cabinetId/dossiers/:siren')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteDossier(
    @Param('cabinetId') cabinetId: string,
    @Param('siren') siren: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
  ) {
    const revision = dossierExpectedRevision(ifMatch, ifNoneMatch);
    if (revision === null) dossierValidation('if-match');
    return this.cabinet.deleteDossier(cabinetId, siren, revision);
  }

  @Patch('cabinets/:cabinetId/members/:memberId')
  updateMember(
    @Param('cabinetId') cabinetId: string,
    @Param('memberId') memberId: string,
    @Body() body: unknown,
  ) {
    return this.cabinet.updateMember(cabinetId, memberId, bodyOf(updateMemberSchema, body));
  }

  @Get('cabinets/:cabinetId/invitations')
  listInvitations(@Param('cabinetId') cabinetId: string, @Query() query: unknown) {
    return this.cabinet.listInvitations(cabinetId, bodyOf(cursorPageSchema, query));
  }

  @Post('cabinets/:cabinetId/invitations')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  inviteMember(
    @Param('cabinetId') cabinetId: string,
    @Body() body: unknown,
  ) {
    const input = bodyOf(inviteSchema, body);
    return this.cabinet.inviteMember(cabinetId, { email: input.email, role: input.role ?? 'collaborator' });
  }

  @Delete('cabinets/:cabinetId/invitations/:invitationId')
  revokeInvitation(
    @Param('cabinetId') cabinetId: string,
    @Param('invitationId') invitationId: string,
  ) {
    return this.cabinet.revokeInvitation(cabinetId, invitationId);
  }

  @Post('cabinets/:cabinetId/invitation-deliveries/retry')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  retryDeliveries(@Param('cabinetId') cabinetId: string) {
    return this.cabinet.retryInvitationDeliveries(cabinetId);
  }

  @Post('invitations/accept')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  acceptInvitation(@Body() body: unknown) {
    return this.cabinet.acceptInvitation(bodyOf(acceptInvitationSchema, body));
  }
}
