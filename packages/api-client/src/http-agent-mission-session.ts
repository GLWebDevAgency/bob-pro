import {
  appUnavailable,
  isCanonicalAgentMissionDraftSessionId,
  isCanonicalAgentMissionOpaqueIdentifier,
  isCanonicalAgentMissionUserCommandId,
  isCanonicalAgentMissionUuid,
  normalizeAgentMissionQuoteLineCandidate,
  normalizeAgentMissionQuoteLinePatch,
  type AcknowledgeQuoteScreenOutput,
  type AgentMissionViewV1,
  type AppError,
  type CancelQuoteAgentMissionOutput,
  type DecideQuoteAgentMissionOutput,
  type QuoteAgentMissionPresentationV1,
  type Result,
  type StartQuoteAgentMissionOutput,
} from '@bob/core';
import {
  decodeAgentMissionCancel,
  decodeAgentMissionCancelPendingQuoteLine,
  decodeAgentMissionCancelV2,
  decodeAgentMissionCatalogueChoice,
  decodeAgentMissionCurrent,
  decodeAgentMissionCurrentV2,
  decodeAgentMissionDecision,
  decodeAgentMissionDecisionV2,
  decodeAgentMissionLineProposalDecision,
  decodeAgentMissionPatchQuoteLine,
  decodeAgentMissionScreenAck,
  decodeAgentMissionScreenAckV2,
  decodeAgentMissionStageQuoteLines,
  decodeAgentMissionStart,
  decodeAgentMissionStartV2,
} from './agent-mission-codec';
import {
  REALTIME_AGENT_MISSION_PROTOCOL_M2A_VERSION,
  REALTIME_AGENT_MISSION_PROTOCOL_VERSION,
  type RealtimeAgentMissionAcknowledgeQuoteScreenInput,
  type RealtimeAgentMissionAcknowledgeQuoteScreenOutputV2,
  type RealtimeAgentMissionCancelQuoteInput,
  type RealtimeAgentMissionCancelPendingQuoteLineInput,
  type RealtimeAgentMissionCancelPendingQuoteLineOutput,
  type RealtimeAgentMissionCatalogueChoiceInput,
  type RealtimeAgentMissionCatalogueChoiceOutput,
  type RealtimeAgentMissionLineProposalDecisionInput,
  type RealtimeAgentMissionLineProposalDecisionOutput,
  type RealtimeAgentMissionPatchQuoteLineInput,
  type RealtimeAgentMissionPatchQuoteLineOutput,
  type RealtimeAgentMissionProtocolVersion,
  type RealtimeAgentMissionQuoteDecisionInput,
  type RealtimeAgentMissionQuoteDecisionOutputV2,
  type RealtimeAgentMissionSession,
  type RealtimeAgentMissionSessionV1,
  type RealtimeAgentMissionSessionV2,
  type RealtimeAgentMissionStageQuoteLinesInput,
  type RealtimeAgentMissionStageQuoteLinesOutput,
  type RealtimeAgentMissionStartQuoteInput,
} from './agent-mission-session';

const POSTGRES_INT_MAX = 2_147_483_647;
const SHA_256 = /^[a-f0-9]{64}$/u;
const CATALOGUE_ITEM_ID = /^[A-Za-z0-9-]{1,128}$/u;
const AGENT_MISSION_REQUEST_TIMEOUT_MS = 12_000;

type AcknowledgeQuoteScreenOutputFor<
TProtocol extends RealtimeAgentMissionProtocolVersion,
> = TProtocol extends typeof REALTIME_AGENT_MISSION_PROTOCOL_M2A_VERSION
  ? RealtimeAgentMissionAcknowledgeQuoteScreenOutputV2
  : AcknowledgeQuoteScreenOutput;

type DecideQuoteCreationOutputFor<
TProtocol extends RealtimeAgentMissionProtocolVersion,
> = TProtocol extends typeof REALTIME_AGENT_MISSION_PROTOCOL_M2A_VERSION
  ? RealtimeAgentMissionQuoteDecisionOutputV2
  : DecideQuoteAgentMissionOutput;

type CurrentQuoteCreationOutputFor<
TProtocol extends RealtimeAgentMissionProtocolVersion,
> = TProtocol extends typeof REALTIME_AGENT_MISSION_PROTOCOL_M2A_VERSION
  ? {
      readonly mission: AgentMissionViewV1 | null;
      readonly presentation: QuoteAgentMissionPresentationV1 | null;
    }
  : { readonly mission: AgentMissionViewV1 | null };

export interface HttpAgentMissionRequest<T> {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: unknown;
  readonly headers: Readonly<Record<string, string>>;
  readonly decode: (value: unknown) => T | null;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
}

export type HttpAgentMissionRequester = <T>(
  request: HttpAgentMissionRequest<T>,
) => Promise<Result<T, AppError>>;

function unavailable<T>(): Promise<Result<T, AppError>> {
  return Promise.resolve({
    ok: false,
    error: appUnavailable('bob_agent_mission_session_disposed'),
  });
}

function validation<T>(field: string, message: string): Promise<Result<T, AppError>> {
  return Promise.resolve({
    ok: false,
    error: { kind: 'validation', issues: [{ field, message }] },
  });
}

function revision(value: unknown, allowZero = false): value is number {
  return Number.isSafeInteger(value)
    && !Object.is(value, -0)
    && (value as number) >= (allowZero ? 0 : 1)
    && (value as number) <= POSTGRES_INT_MAX;
}

function draftSessionId(value: unknown): value is string {
  return isCanonicalAgentMissionDraftSessionId(value);
}

function exactInput(value: unknown, fields: readonly string[]): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

function quoteLineCandidateIssue(
  value: unknown,
  field: 'lines' | 'additionalLines',
  allowEmpty: boolean,
): { readonly field: string; readonly message: string } | null {
  if (
    !Array.isArray(value)
    || value.length > 20
    || (!allowEmpty && value.length === 0)
  ) {
    return {
      field,
      message: allowEmpty
        ? 'Vingt lignes maximum.'
        : 'Entre une et vingt lignes sont requises.',
    };
  }
  for (let index = 0; index < value.length; index += 1) {
    const parsed = normalizeAgentMissionQuoteLineCandidate(value[index]);
    if (!parsed.ok) {
      return {
        field: `${field}[${index}].${parsed.error.field}`,
        message: `Ligne invalide (${parsed.error.reason}).`,
      };
    }
  }
  return null;
}

function quoteLineCommandIssue(input: {
  readonly commandId: string;
  readonly expectedMissionRevision: number;
  readonly expectedDraftSessionId: string;
  readonly expectedDraftSlotRevision: number;
  readonly expectedDraftContentRevision: number;
}): { readonly field: string; readonly message: string } | null {
  if (!isCanonicalAgentMissionUserCommandId(input.commandId)) {
    return { field: 'commandId', message: 'UUID v4 canonique requis.' };
  }
  if (!revision(input.expectedMissionRevision)) {
    return {
      field: 'expectedMissionRevision',
      message: 'Révision positive requise.',
    };
  }
  if (!draftSessionId(input.expectedDraftSessionId)) {
    return {
      field: 'expectedDraftSessionId',
      message: 'Session de brouillon canonique requise.',
    };
  }
  if (!revision(input.expectedDraftSlotRevision)) {
    return {
      field: 'expectedDraftSlotRevision',
      message: 'Révision de slot positive requise.',
    };
  }
  if (!revision(input.expectedDraftContentRevision, true)) {
    return {
      field: 'expectedDraftContentRevision',
      message: 'Révision de contenu requise.',
    };
  }
  return null;
}

class HttpRealtimeAgentMissionSessionBase<
TProtocol extends RealtimeAgentMissionProtocolVersion,
> {
  #capability: string | null;
  #protocolVersion: TProtocol;
  #request: HttpAgentMissionRequester | null;
  #realtimeSessionId: string;

  constructor(input: {
    readonly realtimeSessionId: string;
    readonly capability: string;
    readonly protocolVersion: TProtocol;
    readonly request: HttpAgentMissionRequester;
  }) {
    this.#realtimeSessionId = input.realtimeSessionId;
    this.#capability = input.capability;
    this.#protocolVersion = input.protocolVersion;
    this.#request = input.request;
    Object.freeze(this);
  }

  get protocolVersion(): TProtocol {
    return this.#protocolVersion;
  }

  get realtimeSessionId(): string {
    return this.#realtimeSessionId;
  }

  get disposed(): boolean {
    return this.#capability === null || this.#request === null;
  }

  getCurrentQuoteCreation(
    signal?: AbortSignal,
  ): Promise<Result<CurrentQuoteCreationOutputFor<TProtocol>, AppError>> {
    return this.call<CurrentQuoteCreationOutputFor<TProtocol>>({
      method: 'GET',
      path: '/agent-missions/current/quote-creation',
      decode: (
        this.#protocolVersion === REALTIME_AGENT_MISSION_PROTOCOL_M2A_VERSION
          ? decodeAgentMissionCurrentV2
          : decodeAgentMissionCurrent
      ) as (value: unknown) => CurrentQuoteCreationOutputFor<TProtocol> | null,
      signal,
    });
  }

  startQuoteCreation(
    input: RealtimeAgentMissionStartQuoteInput,
    signal?: AbortSignal,
  ) {
    if (!isCanonicalAgentMissionUserCommandId(input?.commandId)) {
      return validation<StartQuoteAgentMissionOutput>(
        'commandId',
        'UUID v4 canonique requis.',
      );
    }
    return this.call<StartQuoteAgentMissionOutput>({
      method: 'POST',
      path: '/agent-missions/quote-creation/start',
      body: { commandId: input.commandId },
      decode: this.#protocolVersion === REALTIME_AGENT_MISSION_PROTOCOL_M2A_VERSION
        ? decodeAgentMissionStartV2
        : decodeAgentMissionStart,
      signal,
    });
  }

  cancelQuoteCreation(
    input: RealtimeAgentMissionCancelQuoteInput,
    signal?: AbortSignal,
  ) {
    if (!isCanonicalAgentMissionUuid(input?.missionId)) {
      return validation<CancelQuoteAgentMissionOutput>(
        'missionId',
        'UUID canonique requis.',
      );
    }
    if (!isCanonicalAgentMissionUserCommandId(input.commandId)) {
      return validation<CancelQuoteAgentMissionOutput>(
        'commandId',
        'UUID v4 canonique requis.',
      );
    }
    if (!revision(input.expectedMissionRevision)) {
      return validation<CancelQuoteAgentMissionOutput>(
        'expectedMissionRevision',
        'Révision positive requise.',
      );
    }
    if (
      input.reason !== undefined
      && input.reason !== 'user_cancelled'
      && input.reason !== 'manual_handoff'
    ) {
      return validation<CancelQuoteAgentMissionOutput>(
        'reason',
        'Motif d’arrêt invalide.',
      );
    }
    return this.call<CancelQuoteAgentMissionOutput>({
      method: 'POST',
      path: `/agent-missions/${encodeURIComponent(input.missionId)}/cancel`,
      body: {
        commandId: input.commandId,
        expectedMissionRevision: input.expectedMissionRevision,
        reason: input.reason ?? 'user_cancelled',
      },
      decode: this.#protocolVersion === REALTIME_AGENT_MISSION_PROTOCOL_M2A_VERSION
        ? decodeAgentMissionCancelV2
        : decodeAgentMissionCancel,
      signal,
    });
  }

  acknowledgeQuoteScreen(
    input: RealtimeAgentMissionAcknowledgeQuoteScreenInput,
    signal?: AbortSignal,
  ): Promise<Result<AcknowledgeQuoteScreenOutputFor<TProtocol>, AppError>> {
    if (!isCanonicalAgentMissionUuid(input?.missionId)) {
      return validation<AcknowledgeQuoteScreenOutputFor<TProtocol>>(
        'missionId',
        'UUID canonique requis.',
      );
    }
    if (!isCanonicalAgentMissionUserCommandId(input.commandId)) {
      return validation<AcknowledgeQuoteScreenOutputFor<TProtocol>>(
        'commandId',
        'UUID v4 canonique requis.',
      );
    }
    if (!revision(input.expectedMissionRevision)) {
      return validation<AcknowledgeQuoteScreenOutputFor<TProtocol>>(
        'expectedMissionRevision',
        'Révision positive requise.',
      );
    }
    if (!revision(input.contextRevision)) {
      return validation<AcknowledgeQuoteScreenOutputFor<TProtocol>>(
        'contextRevision',
        'Révision de contexte positive requise.',
      );
    }
    if (typeof input.contextDigest !== 'string' || !SHA_256.test(input.contextDigest)) {
      return validation<AcknowledgeQuoteScreenOutputFor<TProtocol>>(
        'contextDigest',
        'Digest SHA-256 canonique requis.',
      );
    }
    if (!draftSessionId(input.draftSessionId)) {
      return validation<AcknowledgeQuoteScreenOutputFor<TProtocol>>(
        'draftSessionId',
        'Session de brouillon canonique requise.',
      );
    }
    if (!revision(input.expectedDraftSlotRevision)) {
      return validation<AcknowledgeQuoteScreenOutputFor<TProtocol>>(
        'expectedDraftSlotRevision',
        'Révision de slot positive requise.',
      );
    }
    if (!revision(input.expectedDraftContentRevision, true)) {
      return validation<AcknowledgeQuoteScreenOutputFor<TProtocol>>(
        'expectedDraftContentRevision',
        'Révision de contenu requise.',
      );
    }
    return this.call<AcknowledgeQuoteScreenOutputFor<TProtocol>>({
      method: 'POST',
      path: `/agent-missions/${encodeURIComponent(input.missionId)}/screen-acks`,
      body: {
        commandId: input.commandId,
        expectedMissionRevision: input.expectedMissionRevision,
        realtimeSessionId: this.#realtimeSessionId,
        contextRevision: input.contextRevision,
        contextDigest: input.contextDigest,
        draftSessionId: input.draftSessionId,
        expectedDraftSlotRevision: input.expectedDraftSlotRevision,
        expectedDraftContentRevision: input.expectedDraftContentRevision,
      },
      decode: (
        this.#protocolVersion === REALTIME_AGENT_MISSION_PROTOCOL_M2A_VERSION
          ? decodeAgentMissionScreenAckV2
          : decodeAgentMissionScreenAck
      ) as (value: unknown) => AcknowledgeQuoteScreenOutputFor<TProtocol> | null,
      signal,
    });
  }

  decideQuoteCreation(
    input: RealtimeAgentMissionQuoteDecisionInput,
    signal?: AbortSignal,
  ): Promise<Result<DecideQuoteCreationOutputFor<TProtocol>, AppError>> {
    if (!isCanonicalAgentMissionUuid(input?.missionId)) {
      return validation<DecideQuoteCreationOutputFor<TProtocol>>(
        'missionId',
        'UUID canonique requis.',
      );
    }
    if (!isCanonicalAgentMissionUserCommandId(input.commandId)) {
      return validation<DecideQuoteCreationOutputFor<TProtocol>>(
        'commandId',
        'UUID v4 canonique requis.',
      );
    }
    if (!revision(input.expectedMissionRevision)) {
      return validation<DecideQuoteCreationOutputFor<TProtocol>>(
        'expectedMissionRevision',
        'Révision positive requise.',
      );
    }
    if (!draftSessionId(input.expectedDraftSessionId)) {
      return validation<DecideQuoteCreationOutputFor<TProtocol>>(
        'expectedDraftSessionId',
        'Session de brouillon canonique requise.',
      );
    }
    if (!revision(input.expectedDraftSlotRevision)) {
      return validation<DecideQuoteCreationOutputFor<TProtocol>>(
        'expectedDraftSlotRevision',
        'Révision de slot positive requise.',
      );
    }
    if (!revision(input.expectedDraftContentRevision, true)) {
      return validation<DecideQuoteCreationOutputFor<TProtocol>>(
        'expectedDraftContentRevision',
        'Révision de contenu requise.',
      );
    }
    if (input.action === 'choose_presented_option') {
      if (!exactInput(input, [
        'missionId',
        'action',
        'commandId',
        'expectedMissionRevision',
        'expectedDraftSessionId',
        'expectedDraftSlotRevision',
        'expectedDraftContentRevision',
        'decisionId',
        'choiceSetRevision',
        'choiceId',
      ])) {
        return validation<DecideQuoteCreationOutputFor<TProtocol>>(
          'decision',
          'Décision de choix exacte requise.',
        );
      }
      if (!isCanonicalAgentMissionUuid(input.decisionId)) {
        return validation<DecideQuoteCreationOutputFor<TProtocol>>(
          'decisionId',
          'UUID canonique requis.',
        );
      }
      if (!revision(input.choiceSetRevision)) {
        return validation<DecideQuoteCreationOutputFor<TProtocol>>(
          'choiceSetRevision',
          'Révision positive requise.',
        );
      }
      if (!isCanonicalAgentMissionUuid(input.choiceId)) {
        return validation<DecideQuoteCreationOutputFor<TProtocol>>(
          'choiceId',
          'UUID canonique requis.',
        );
      }
    } else if (input.action === 'select_screen_customer') {
      if (!exactInput(input, [
        'missionId',
        'action',
        'commandId',
        'expectedMissionRevision',
        'expectedDraftSessionId',
        'expectedDraftSlotRevision',
        'expectedDraftContentRevision',
        'customerId',
      ])) {
        return validation<DecideQuoteCreationOutputFor<TProtocol>>(
          'decision',
          'Sélection client exacte requise.',
        );
      }
      if (!isCanonicalAgentMissionOpaqueIdentifier(input.customerId)) {
        return validation<DecideQuoteCreationOutputFor<TProtocol>>(
          'customerId',
          'Identifiant client canonique requis.',
        );
      }
    } else {
      return validation<DecideQuoteCreationOutputFor<TProtocol>>(
        'action',
        'Action de décision inconnue.',
      );
    }
    const { missionId, ...body } = input;
    return this.call<DecideQuoteCreationOutputFor<TProtocol>>({
      method: 'POST',
      path: `/agent-missions/${encodeURIComponent(missionId)}/decisions`,
      body,
      decode: (
        this.#protocolVersion === REALTIME_AGENT_MISSION_PROTOCOL_M2A_VERSION
          ? (value: unknown) => decodeAgentMissionDecisionV2(value, missionId)
          : (value: unknown) => decodeAgentMissionDecision(value, missionId)
      ) as (value: unknown) => DecideQuoteCreationOutputFor<TProtocol> | null,
      signal,
    });
  }

  dispose(): void {
    this.#capability = null;
    this.#request = null;
  }

  protected call<T>(
    input: Omit<HttpAgentMissionRequest<T>, 'headers' | 'timeoutMs'>,
  ): Promise<Result<T, AppError>> {
    const capability = this.#capability;
    const request = this.#request;
    if (capability === null || request === null) return unavailable();
    return request({
      ...input,
      headers: { 'x-bob-agent-mission-capability': capability },
      timeoutMs: AGENT_MISSION_REQUEST_TIMEOUT_MS,
    });
  }
}

class HttpRealtimeAgentMissionSessionV1
extends HttpRealtimeAgentMissionSessionBase<
typeof REALTIME_AGENT_MISSION_PROTOCOL_VERSION
>
implements RealtimeAgentMissionSessionV1 {}

class HttpRealtimeAgentMissionSessionV2
extends HttpRealtimeAgentMissionSessionBase<
typeof REALTIME_AGENT_MISSION_PROTOCOL_M2A_VERSION
>
implements RealtimeAgentMissionSessionV2 {
  stageQuoteLines(
    input: RealtimeAgentMissionStageQuoteLinesInput,
    signal?: AbortSignal,
  ) {
    if (!isCanonicalAgentMissionUuid(input?.missionId)) {
      return validation<RealtimeAgentMissionStageQuoteLinesOutput>(
        'missionId',
        'UUID canonique requis.',
      );
    }
    if (!exactInput(input, [
      'missionId',
      'commandId',
      'expectedMissionRevision',
      'expectedDraftSessionId',
      'expectedDraftSlotRevision',
      'expectedDraftContentRevision',
      'lines',
    ])) {
      return validation<RealtimeAgentMissionStageQuoteLinesOutput>(
        'command',
        'Commande de staging exacte requise.',
      );
    }
    const commonIssue = quoteLineCommandIssue(input);
    if (commonIssue !== null) {
      return validation<RealtimeAgentMissionStageQuoteLinesOutput>(
        commonIssue.field,
        commonIssue.message,
      );
    }
    const lineIssue = quoteLineCandidateIssue(input.lines, 'lines', false);
    if (lineIssue !== null) {
      return validation<RealtimeAgentMissionStageQuoteLinesOutput>(
        lineIssue.field,
        lineIssue.message,
      );
    }
    const { missionId, ...body } = input;
    return this.call<RealtimeAgentMissionStageQuoteLinesOutput>({
      method: 'POST',
      path: `/agent-missions/${encodeURIComponent(missionId)}/quote-lines`,
      body,
      decode: (value) => decodeAgentMissionStageQuoteLines(value, missionId),
      signal,
    });
  }

  decideQuoteCatalogueChoice(
    input: RealtimeAgentMissionCatalogueChoiceInput,
    signal?: AbortSignal,
  ) {
    if (!isCanonicalAgentMissionUuid(input?.missionId)) {
      return validation<RealtimeAgentMissionCatalogueChoiceOutput>(
        'missionId',
        'UUID canonique requis.',
      );
    }
    if (!exactInput(input, [
      'missionId',
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
    ])) {
      return validation<RealtimeAgentMissionCatalogueChoiceOutput>(
        'command',
        'Commande de choix catalogue exacte requise.',
      );
    }
    const commonIssue = quoteLineCommandIssue(input);
    if (commonIssue !== null) {
      return validation<RealtimeAgentMissionCatalogueChoiceOutput>(
        commonIssue.field,
        commonIssue.message,
      );
    }
    for (const [field, value] of [
      ['decisionId', input.decisionId],
      ['pendingLineId', input.pendingLineId],
      ['choiceId', input.choiceId],
    ] as const) {
      if (!isCanonicalAgentMissionUuid(value)) {
        return validation<RealtimeAgentMissionCatalogueChoiceOutput>(
          field,
          'UUID canonique requis.',
        );
      }
    }
    if (!revision(input.choiceSetRevision)) {
      return validation<RealtimeAgentMissionCatalogueChoiceOutput>(
        'choiceSetRevision',
        'Révision positive requise.',
      );
    }
    if (!revision(input.expectedWorkRevision)) {
      return validation<RealtimeAgentMissionCatalogueChoiceOutput>(
        'expectedWorkRevision',
        'Révision positive requise.',
      );
    }
    const lineIssue = quoteLineCandidateIssue(
      input.additionalLines,
      'additionalLines',
      true,
    );
    if (lineIssue !== null) {
      return validation<RealtimeAgentMissionCatalogueChoiceOutput>(
        lineIssue.field,
        lineIssue.message,
      );
    }
    const { missionId, ...body } = input;
    return this.call<RealtimeAgentMissionCatalogueChoiceOutput>({
      method: 'POST',
      path: `/agent-missions/${encodeURIComponent(missionId)}/catalogue-choices`,
      body,
      decode: (value) => decodeAgentMissionCatalogueChoice(value, missionId),
      signal,
    });
  }

  patchQuoteLine(
    input: RealtimeAgentMissionPatchQuoteLineInput,
    signal?: AbortSignal,
  ) {
    if (!isCanonicalAgentMissionUuid(input?.missionId)) {
      return validation<RealtimeAgentMissionPatchQuoteLineOutput>(
        'missionId',
        'UUID canonique requis.',
      );
    }
    if (!exactInput(input, [
      'missionId',
      'commandId',
      'expectedMissionRevision',
      'expectedDraftSessionId',
      'expectedDraftSlotRevision',
      'expectedDraftContentRevision',
      'pendingLineId',
      'expectedWorkRevision',
      'scope',
      'patch',
    ])) {
      return validation<RealtimeAgentMissionPatchQuoteLineOutput>(
        'command',
        'Commande de correction exacte requise.',
      );
    }
    const commonIssue = quoteLineCommandIssue(input);
    if (commonIssue !== null) {
      return validation<RealtimeAgentMissionPatchQuoteLineOutput>(
        commonIssue.field,
        commonIssue.message,
      );
    }
    if (!isCanonicalAgentMissionUuid(input.pendingLineId)) {
      return validation<RealtimeAgentMissionPatchQuoteLineOutput>(
        'pendingLineId',
        'UUID canonique requis.',
      );
    }
    if (!revision(input.expectedWorkRevision)) {
      return validation<RealtimeAgentMissionPatchQuoteLineOutput>(
        'expectedWorkRevision',
        'Révision positive requise.',
      );
    }
    if (
      input.scope !== 'answer_required_fact'
      && input.scope !== 'explicit_correction'
    ) {
      return validation<RealtimeAgentMissionPatchQuoteLineOutput>(
        'scope',
        'Portée de correction invalide.',
      );
    }
    const patch = normalizeAgentMissionQuoteLinePatch(input.patch);
    if (!patch.ok) {
      return validation<RealtimeAgentMissionPatchQuoteLineOutput>(
        `patch.${patch.error.field}`,
        `Correction invalide (${patch.error.reason}).`,
      );
    }
    const { missionId, ...body } = input;
    return this.call<RealtimeAgentMissionPatchQuoteLineOutput>({
      method: 'POST',
      path: `/agent-missions/${encodeURIComponent(missionId)}/quote-line-patches`,
      body,
      decode: (value) => decodeAgentMissionPatchQuoteLine(value, missionId),
      signal,
    });
  }

  cancelPendingQuoteLine(
    input: RealtimeAgentMissionCancelPendingQuoteLineInput,
    signal?: AbortSignal,
  ) {
    if (!isCanonicalAgentMissionUuid(input?.missionId)) {
      return validation<RealtimeAgentMissionCancelPendingQuoteLineOutput>(
        'missionId',
        'UUID canonique requis.',
      );
    }
    if (!exactInput(input, [
      'missionId',
      'commandId',
      'expectedMissionRevision',
      'expectedDraftSessionId',
      'expectedDraftSlotRevision',
      'expectedDraftContentRevision',
      'pendingLineId',
      'expectedWorkRevision',
    ])) {
      return validation<RealtimeAgentMissionCancelPendingQuoteLineOutput>(
        'command',
        'Commande d’annulation de ligne exacte requise.',
      );
    }
    const commonIssue = quoteLineCommandIssue(input);
    if (commonIssue !== null) {
      return validation<RealtimeAgentMissionCancelPendingQuoteLineOutput>(
        commonIssue.field,
        commonIssue.message,
      );
    }
    if (!isCanonicalAgentMissionUuid(input.pendingLineId)) {
      return validation<RealtimeAgentMissionCancelPendingQuoteLineOutput>(
        'pendingLineId',
        'UUID canonique requis.',
      );
    }
    if (!revision(input.expectedWorkRevision)) {
      return validation<RealtimeAgentMissionCancelPendingQuoteLineOutput>(
        'expectedWorkRevision',
        'Révision positive requise.',
      );
    }
    const { missionId, ...body } = input;
    return this.call<RealtimeAgentMissionCancelPendingQuoteLineOutput>({
      method: 'POST',
      path:
        `/agent-missions/${encodeURIComponent(missionId)}/quote-line-cancellations`,
      body,
      decode: (value) => decodeAgentMissionCancelPendingQuoteLine(
        value,
        missionId,
      ),
      signal,
    });
  }

  decideQuoteLineProposal(
    input: RealtimeAgentMissionLineProposalDecisionInput,
    signal?: AbortSignal,
  ) {
    if (!isCanonicalAgentMissionUuid(input?.missionId)) {
      return validation<RealtimeAgentMissionLineProposalDecisionOutput>(
        'missionId',
        'UUID canonique requis.',
      );
    }
    if (!exactInput(input, [
      'missionId',
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
    ])) {
      return validation<RealtimeAgentMissionLineProposalDecisionOutput>(
        'command',
        'Commande de décision de ligne exacte requise.',
      );
    }
    const commonIssue = quoteLineCommandIssue(input);
    if (commonIssue !== null) {
      return validation<RealtimeAgentMissionLineProposalDecisionOutput>(
        commonIssue.field,
        commonIssue.message,
      );
    }
    for (const [field, value] of [
      ['decisionId', input.decisionId],
      ['choiceId', input.choiceId],
      ['pendingLineId', input.pendingLineId],
      ['proposalId', input.proposalId],
    ] as const) {
      if (!isCanonicalAgentMissionUuid(value)) {
        return validation<RealtimeAgentMissionLineProposalDecisionOutput>(
          field,
          'UUID canonique requis.',
        );
      }
    }
    if (!revision(input.choiceSetRevision)) {
      return validation<RealtimeAgentMissionLineProposalDecisionOutput>(
        'choiceSetRevision',
        'Révision positive requise.',
      );
    }
    if (!revision(input.expectedWorkRevision)) {
      return validation<RealtimeAgentMissionLineProposalDecisionOutput>(
        'expectedWorkRevision',
        'Révision positive requise.',
      );
    }
    if (input.proposalRevision !== 1) {
      return validation<RealtimeAgentMissionLineProposalDecisionOutput>(
        'proposalRevision',
        'Révision de proposition invalide.',
      );
    }
    if (
      typeof input.choiceSetHash !== 'string'
      || !SHA_256.test(input.choiceSetHash)
    ) {
      return validation<RealtimeAgentMissionLineProposalDecisionOutput>(
        'choiceSetHash',
        'Digest SHA-256 canonique requis.',
      );
    }
    if (typeof input.diffHash !== 'string' || !SHA_256.test(input.diffHash)) {
      return validation<RealtimeAgentMissionLineProposalDecisionOutput>(
        'diffHash',
        'Digest SHA-256 canonique requis.',
      );
    }
    if (
      input.expectedCatalogue !== null
      && (
        !exactInput(input.expectedCatalogue, ['itemId', 'revision'])
        || !CATALOGUE_ITEM_ID.test(input.expectedCatalogue.itemId)
        || !revision(input.expectedCatalogue.revision)
      )
    ) {
      return validation<RealtimeAgentMissionLineProposalDecisionOutput>(
        'expectedCatalogue',
        'Fence catalogue exacte requise.',
      );
    }
    const { missionId, ...body } = input;
    return this.call<RealtimeAgentMissionLineProposalDecisionOutput>({
      method: 'POST',
      path: `/agent-missions/${encodeURIComponent(missionId)}/quote-line-decisions`,
      body,
      decode: (value) => decodeAgentMissionLineProposalDecision(
        value,
        missionId,
      ),
      signal,
    });
  }
}

export function createHttpRealtimeAgentMissionSession(input: {
  readonly protocolVersion: typeof REALTIME_AGENT_MISSION_PROTOCOL_VERSION;
  readonly realtimeSessionId: string;
  readonly capability: string;
  readonly request: HttpAgentMissionRequester;
}): RealtimeAgentMissionSessionV1;
export function createHttpRealtimeAgentMissionSession(input: {
  readonly protocolVersion: typeof REALTIME_AGENT_MISSION_PROTOCOL_M2A_VERSION;
  readonly realtimeSessionId: string;
  readonly capability: string;
  readonly request: HttpAgentMissionRequester;
}): RealtimeAgentMissionSessionV2;
export function createHttpRealtimeAgentMissionSession(input: {
  readonly protocolVersion: RealtimeAgentMissionProtocolVersion;
  readonly realtimeSessionId: string;
  readonly capability: string;
  readonly request: HttpAgentMissionRequester;
}): RealtimeAgentMissionSession {
  return input.protocolVersion === REALTIME_AGENT_MISSION_PROTOCOL_M2A_VERSION
    ? new HttpRealtimeAgentMissionSessionV2({
        ...input,
        protocolVersion: REALTIME_AGENT_MISSION_PROTOCOL_M2A_VERSION,
      })
    : new HttpRealtimeAgentMissionSessionV1({
        ...input,
        protocolVersion: REALTIME_AGENT_MISSION_PROTOCOL_VERSION,
      });
}
