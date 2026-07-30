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
  Query,
  Res,
} from '@nestjs/common';
import {
  normalizeAgentMissionQuoteLineCandidate,
  normalizeAgentMissionQuoteLinePatch,
  type AgentMissionQuoteLineCandidateV1,
  type AgentMissionQuoteLinePatchScope,
  type AgentMissionQuoteLinePatchV1,
} from '@bob/core';
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
    if (!Object.hasOwn(body, field)) invalidBody(field, 'Champ requis.');
  }
  return body;
}

function quoteLineCandidates(
  value: unknown,
  field: 'lines' | 'additionalLines',
): readonly AgentMissionQuoteLineCandidateV1[] {
  if (!Array.isArray(value)) invalidBody(field, 'Liste de lignes requise.');
  for (let index = 0; index < value.length; index += 1) {
    const parsed = normalizeAgentMissionQuoteLineCandidate(value[index]);
    if (!parsed.ok) {
      invalidBody(
        `${field}[${index}].${parsed.error.field}`,
        `Ligne invalide (${parsed.error.reason}).`,
      );
    }
  }
  return value as readonly AgentMissionQuoteLineCandidateV1[];
}

function decisionBody(value: unknown):
  | {
      readonly action: 'choose_presented_option';
      readonly commandId: string;
      readonly expectedMissionRevision: number;
      readonly expectedDraftSessionId: string;
      readonly expectedDraftSlotRevision: number;
      readonly expectedDraftContentRevision: number;
      readonly decisionId: string;
      readonly choiceSetRevision: number;
      readonly choiceId: string;
    }
  | {
      readonly action: 'select_screen_customer';
      readonly commandId: string;
      readonly expectedMissionRevision: number;
      readonly expectedDraftSessionId: string;
      readonly expectedDraftSlotRevision: number;
      readonly expectedDraftContentRevision: number;
      readonly customerId: string;
    } {
  const candidate = jsonObject(value);
  if (candidate === null) invalidBody('body', 'Corps JSON objet requis.');
  const action = candidate.action;
  if (action === 'choose_presented_option') {
    const body = exactBody(value, [
      'action',
      'commandId',
      'expectedMissionRevision',
      'expectedDraftSessionId',
      'expectedDraftSlotRevision',
      'expectedDraftContentRevision',
      'decisionId',
      'choiceSetRevision',
      'choiceId',
    ]);
    return {
      action,
      commandId: body.commandId as string,
      expectedMissionRevision: body.expectedMissionRevision as number,
      expectedDraftSessionId: body.expectedDraftSessionId as string,
      expectedDraftSlotRevision: body.expectedDraftSlotRevision as number,
      expectedDraftContentRevision: body.expectedDraftContentRevision as number,
      decisionId: body.decisionId as string,
      choiceSetRevision: body.choiceSetRevision as number,
      choiceId: body.choiceId as string,
    };
  }
  if (action === 'select_screen_customer') {
    const body = exactBody(value, [
      'action',
      'commandId',
      'expectedMissionRevision',
      'expectedDraftSessionId',
      'expectedDraftSlotRevision',
      'expectedDraftContentRevision',
      'customerId',
    ]);
    return {
      action,
      commandId: body.commandId as string,
      expectedMissionRevision: body.expectedMissionRevision as number,
      expectedDraftSessionId: body.expectedDraftSessionId as string,
      expectedDraftSlotRevision: body.expectedDraftSlotRevision as number,
      expectedDraftContentRevision: body.expectedDraftContentRevision as number,
      customerId: body.customerId as string,
    };
  }
  invalidBody('action', 'Action de décision non prise en charge.');
}

function stageLinesBody(value: unknown): {
  readonly commandId: string;
  readonly expectedMissionRevision: number;
  readonly expectedDraftSessionId: string;
  readonly expectedDraftSlotRevision: number;
  readonly expectedDraftContentRevision: number;
  readonly lines: readonly AgentMissionQuoteLineCandidateV1[];
} {
  const body = exactBody(value, [
    'commandId',
    'expectedMissionRevision',
    'expectedDraftSessionId',
    'expectedDraftSlotRevision',
    'expectedDraftContentRevision',
    'lines',
  ]);
  return {
    commandId: body.commandId as string,
    expectedMissionRevision: body.expectedMissionRevision as number,
    expectedDraftSessionId: body.expectedDraftSessionId as string,
    expectedDraftSlotRevision: body.expectedDraftSlotRevision as number,
    expectedDraftContentRevision: body.expectedDraftContentRevision as number,
    lines: quoteLineCandidates(body.lines, 'lines'),
  };
}

function catalogueChoiceBody(value: unknown): {
  readonly commandId: string;
  readonly expectedMissionRevision: number;
  readonly expectedDraftSessionId: string;
  readonly expectedDraftSlotRevision: number;
  readonly expectedDraftContentRevision: number;
  readonly decisionId: string;
  readonly choiceSetRevision: number;
  readonly pendingLineId: string;
  readonly expectedWorkRevision: number;
  readonly choiceId: string;
  readonly additionalLines: readonly AgentMissionQuoteLineCandidateV1[];
} {
  const body = exactBody(value, [
    'commandId',
    'expectedMissionRevision',
    'expectedDraftSessionId',
    'expectedDraftSlotRevision',
    'expectedDraftContentRevision',
    'decisionId',
    'choiceSetRevision',
    'pendingLineId',
    'expectedWorkRevision',
    'choiceId',
    'additionalLines',
  ]);
  return {
    commandId: body.commandId as string,
    expectedMissionRevision: body.expectedMissionRevision as number,
    expectedDraftSessionId: body.expectedDraftSessionId as string,
    expectedDraftSlotRevision: body.expectedDraftSlotRevision as number,
    expectedDraftContentRevision: body.expectedDraftContentRevision as number,
    decisionId: body.decisionId as string,
    choiceSetRevision: body.choiceSetRevision as number,
    pendingLineId: body.pendingLineId as string,
    expectedWorkRevision: body.expectedWorkRevision as number,
    choiceId: body.choiceId as string,
    additionalLines: quoteLineCandidates(
      body.additionalLines,
      'additionalLines',
    ),
  };
}

function quoteLinePatchBody(value: unknown): {
  readonly commandId: string;
  readonly expectedMissionRevision: number;
  readonly expectedDraftSessionId: string;
  readonly expectedDraftSlotRevision: number;
  readonly expectedDraftContentRevision: number;
  readonly pendingLineId: string;
  readonly expectedWorkRevision: number;
  readonly scope: AgentMissionQuoteLinePatchScope;
  readonly patch: AgentMissionQuoteLinePatchV1;
} {
  const body = exactBody(value, [
    'commandId',
    'expectedMissionRevision',
    'expectedDraftSessionId',
    'expectedDraftSlotRevision',
    'expectedDraftContentRevision',
    'pendingLineId',
    'expectedWorkRevision',
    'scope',
    'patch',
  ]);
  if (
    body.scope !== 'answer_required_fact'
    && body.scope !== 'explicit_correction'
  ) {
    invalidBody('scope', 'Portée de correction invalide.');
  }
  const patch = normalizeAgentMissionQuoteLinePatch(body.patch);
  if (!patch.ok) {
    invalidBody(
      `patch.${patch.error.field}`,
      `Correction invalide (${patch.error.reason}).`,
    );
  }
  return {
    commandId: body.commandId as string,
    expectedMissionRevision: body.expectedMissionRevision as number,
    expectedDraftSessionId: body.expectedDraftSessionId as string,
    expectedDraftSlotRevision: body.expectedDraftSlotRevision as number,
    expectedDraftContentRevision: body.expectedDraftContentRevision as number,
    pendingLineId: body.pendingLineId as string,
    expectedWorkRevision: body.expectedWorkRevision as number,
    scope: body.scope,
    patch: body.patch as AgentMissionQuoteLinePatchV1,
  };
}

function quoteLineProposalDecisionBody(value: unknown): {
  readonly commandId: string;
  readonly expectedMissionRevision: number;
  readonly expectedDraftSessionId: string;
  readonly expectedDraftSlotRevision: number;
  readonly expectedDraftContentRevision: number;
  readonly decisionId: string;
  readonly choiceSetRevision: number;
  readonly choiceSetHash: string;
  readonly choiceId: string;
  readonly pendingLineId: string;
  readonly proposalId: string;
  readonly proposalRevision: 1;
  readonly expectedWorkRevision: number;
  readonly expectedCatalogue:
    | { readonly itemId: string; readonly revision: number }
    | null;
  readonly diffHash: string;
} {
  const body = exactBody(value, [
    'commandId',
    'expectedMissionRevision',
    'expectedDraftSessionId',
    'expectedDraftSlotRevision',
    'expectedDraftContentRevision',
    'decisionId',
    'choiceSetRevision',
    'choiceSetHash',
    'choiceId',
    'pendingLineId',
    'proposalId',
    'proposalRevision',
    'expectedWorkRevision',
    'expectedCatalogue',
    'diffHash',
  ]);
  if (body.proposalRevision !== 1) {
    invalidBody('proposalRevision', 'Révision de proposition invalide.');
  }
  let expectedCatalogue:
    | { readonly itemId: string; readonly revision: number }
    | null;
  if (body.expectedCatalogue === null) {
    expectedCatalogue = null;
  } else {
    const catalogue = exactBody(body.expectedCatalogue, ['itemId', 'revision']);
    expectedCatalogue = {
      itemId: catalogue.itemId as string,
      revision: catalogue.revision as number,
    };
  }
  return {
    commandId: body.commandId as string,
    expectedMissionRevision: body.expectedMissionRevision as number,
    expectedDraftSessionId: body.expectedDraftSessionId as string,
    expectedDraftSlotRevision: body.expectedDraftSlotRevision as number,
    expectedDraftContentRevision: body.expectedDraftContentRevision as number,
    decisionId: body.decisionId as string,
    choiceSetRevision: body.choiceSetRevision as number,
    choiceSetHash: body.choiceSetHash as string,
    choiceId: body.choiceId as string,
    pendingLineId: body.pendingLineId as string,
    proposalId: body.proposalId as string,
    proposalRevision: 1,
    expectedWorkRevision: body.expectedWorkRevision as number,
    expectedCatalogue,
    diffHash: body.diffHash as string,
  };
}

function cancellationBody(value: unknown): {
  readonly commandId: string;
  readonly expectedMissionRevision: number;
  readonly reason: 'user_cancelled' | 'manual_handoff';
} {
  const candidate = jsonObject(value);
  if (candidate === null) invalidBody('body', 'Corps JSON objet requis.');
  const hasReason = Object.hasOwn(candidate, 'reason');
  const body = exactBody(
    value,
    hasReason
      ? ['commandId', 'expectedMissionRevision', 'reason']
      : ['commandId', 'expectedMissionRevision'],
  );
  const reason = hasReason ? body.reason : 'user_cancelled';
  if (reason !== 'user_cancelled' && reason !== 'manual_handoff') {
    invalidBody('reason', 'Motif d’arrêt invalide.');
  }
  return {
    commandId: body.commandId as string,
    expectedMissionRevision: body.expectedMissionRevision as number,
    reason,
  };
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
    return unwrap(
      authorization.proof.protocolVersion === 2
        ? await this.missions.getCurrentV2(authorization)
        : await this.missions.getCurrent(authorization),
    );
  }

  @Get('current/quote-creation/resume')
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization, X-Bob-Agent-Mission-Protocol-Version')
  async getCurrentResume(
    @Query() query: Readonly<Record<string, unknown>>,
    @Headers('x-bob-agent-mission-protocol-version')
    protocolVersion: string | undefined,
  ) {
    const unknown = Object.keys(query)[0];
    if (unknown !== undefined) invalidBody(unknown, 'Paramètre non autorisé.');
    if (protocolVersion === undefined) {
      return unwrap(await this.missions.getCurrentResume());
    }
    if (protocolVersion === '2') {
      return unwrap(await this.missions.getCurrentResumeV2());
    }
    invalidBody(
      'x-bob-agent-mission-protocol-version',
      'Version de protocole de reprise non prise en charge.',
    );
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
    const body = cancellationBody(value);
    return unwrap(await this.missions.cancel({
      authorization,
      missionId,
      commandId: body.commandId as string,
      expectedMissionRevision: body.expectedMissionRevision as number,
      reason: body.reason,
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

  @Post(':missionId/decisions')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  async decide(
    @Param('missionId') missionId: string,
    @Body() value: unknown,
    @Headers('x-bob-agent-mission-capability') capability: string | undefined,
  ) {
    const authorization = this.requireAuthority('decide_quote_creation', capability);
    const body = decisionBody(value);
    return unwrap(await this.missions.decide({
      authorization,
      missionId,
      commandId: body.commandId,
      expectedMissionRevision: body.expectedMissionRevision,
      expectedDraftSessionId: body.expectedDraftSessionId,
      expectedDraftSlotRevision: body.expectedDraftSlotRevision,
      expectedDraftContentRevision: body.expectedDraftContentRevision,
      decision: body.action === 'choose_presented_option'
        ? {
            action: body.action,
            decisionId: body.decisionId,
            choiceSetRevision: body.choiceSetRevision,
            choiceId: body.choiceId,
          }
        : {
            action: body.action,
            customerId: body.customerId,
          },
    }));
  }

  @Post(':missionId/quote-lines')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  async stageLines(
    @Param('missionId') missionId: string,
    @Body() value: unknown,
    @Headers('x-bob-agent-mission-capability') capability: string | undefined,
  ) {
    const authorization = this.requireAuthority('stage_quote_lines', capability);
    const body = stageLinesBody(value);
    return unwrap(await this.missions.stageLines({
      authorization,
      missionId,
      commandId: body.commandId,
      expectedMissionRevision: body.expectedMissionRevision,
      expectedDraftSessionId: body.expectedDraftSessionId,
      expectedDraftSlotRevision: body.expectedDraftSlotRevision,
      expectedDraftContentRevision: body.expectedDraftContentRevision,
      lines: body.lines,
    }));
  }

  @Post(':missionId/catalogue-choices')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  async decideCatalogueChoice(
    @Param('missionId') missionId: string,
    @Body() value: unknown,
    @Headers('x-bob-agent-mission-capability') capability: string | undefined,
  ) {
    const authorization = this.requireAuthority(
      'decide_catalogue_choice',
      capability,
    );
    const body = catalogueChoiceBody(value);
    return unwrap(await this.missions.decideCatalogueChoice({
      authorization,
      missionId,
      commandId: body.commandId,
      expectedMissionRevision: body.expectedMissionRevision,
      expectedDraftSessionId: body.expectedDraftSessionId,
      expectedDraftSlotRevision: body.expectedDraftSlotRevision,
      expectedDraftContentRevision: body.expectedDraftContentRevision,
      decisionId: body.decisionId,
      choiceSetRevision: body.choiceSetRevision,
      pendingLineId: body.pendingLineId,
      expectedWorkRevision: body.expectedWorkRevision,
      choiceId: body.choiceId,
      additionalLines: body.additionalLines,
    }));
  }

  @Post(':missionId/quote-line-patches')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  async patchQuoteLine(
    @Param('missionId') missionId: string,
    @Body() value: unknown,
    @Headers('x-bob-agent-mission-capability') capability: string | undefined,
  ) {
    const authorization = this.requireAuthority('patch_quote_line', capability);
    const body = quoteLinePatchBody(value);
    return unwrap(await this.missions.patchLine({
      authorization,
      missionId,
      commandId: body.commandId,
      expectedMissionRevision: body.expectedMissionRevision,
      expectedDraftSessionId: body.expectedDraftSessionId,
      expectedDraftSlotRevision: body.expectedDraftSlotRevision,
      expectedDraftContentRevision: body.expectedDraftContentRevision,
      pendingLineId: body.pendingLineId,
      expectedWorkRevision: body.expectedWorkRevision,
      scope: body.scope,
      patch: body.patch,
    }));
  }

  @Post(':missionId/quote-line-decisions')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  async decideQuoteLineProposal(
    @Param('missionId') missionId: string,
    @Body() value: unknown,
    @Headers('x-bob-agent-mission-capability') capability: string | undefined,
  ) {
    const authorization = this.requireAuthority(
      'decide_quote_line_proposal',
      capability,
    );
    const body = quoteLineProposalDecisionBody(value);
    return unwrap(await this.missions.decideLineProposal({
      authorization,
      missionId,
      commandId: body.commandId,
      expectedMissionRevision: body.expectedMissionRevision,
      expectedDraftSessionId: body.expectedDraftSessionId,
      expectedDraftSlotRevision: body.expectedDraftSlotRevision,
      expectedDraftContentRevision: body.expectedDraftContentRevision,
      decisionId: body.decisionId,
      choiceSetRevision: body.choiceSetRevision,
      choiceSetHash: body.choiceSetHash,
      choiceId: body.choiceId,
      pendingLineId: body.pendingLineId,
      proposalId: body.proposalId,
      proposalRevision: body.proposalRevision,
      expectedWorkRevision: body.expectedWorkRevision,
      expectedCatalogue: body.expectedCatalogue,
      diffHash: body.diffHash,
    }));
  }
}
