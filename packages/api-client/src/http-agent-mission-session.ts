import {
  appUnavailable,
  isCanonicalAgentMissionDraftSessionId,
  isCanonicalAgentMissionOpaqueIdentifier,
  isCanonicalAgentMissionUserCommandId,
  isCanonicalAgentMissionUuid,
  type AcknowledgeQuoteScreenOutput,
  type AgentMissionViewV1,
  type AppError,
  type CancelQuoteAgentMissionOutput,
  type DecideQuoteAgentMissionOutput,
  type Result,
  type StartQuoteAgentMissionOutput,
} from '@bob/core';
import {
  decodeAgentMissionCancel,
  decodeAgentMissionCurrent,
  decodeAgentMissionDecision,
  decodeAgentMissionScreenAck,
  decodeAgentMissionStart,
} from './agent-mission-codec';
import {
  REALTIME_AGENT_MISSION_PROTOCOL_VERSION,
  type RealtimeAgentMissionAcknowledgeQuoteScreenInput,
  type RealtimeAgentMissionCancelQuoteInput,
  type RealtimeAgentMissionQuoteDecisionInput,
  type RealtimeAgentMissionSession,
  type RealtimeAgentMissionStartQuoteInput,
} from './agent-mission-session';

const POSTGRES_INT_MAX = 2_147_483_647;
const SHA_256 = /^[a-f0-9]{64}$/u;
const AGENT_MISSION_REQUEST_TIMEOUT_MS = 12_000;

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

class HttpRealtimeAgentMissionSession implements RealtimeAgentMissionSession {
  #capability: string | null;
  #request: HttpAgentMissionRequester | null;
  #realtimeSessionId: string;

  constructor(input: {
    readonly realtimeSessionId: string;
    readonly capability: string;
    readonly request: HttpAgentMissionRequester;
  }) {
    this.#realtimeSessionId = input.realtimeSessionId;
    this.#capability = input.capability;
    this.#request = input.request;
    Object.freeze(this);
  }

  get protocolVersion(): typeof REALTIME_AGENT_MISSION_PROTOCOL_VERSION {
    return REALTIME_AGENT_MISSION_PROTOCOL_VERSION;
  }

  get realtimeSessionId(): string {
    return this.#realtimeSessionId;
  }

  get disposed(): boolean {
    return this.#capability === null || this.#request === null;
  }

  getCurrentQuoteCreation(signal?: AbortSignal) {
    return this.call<{ readonly mission: AgentMissionViewV1 | null }>({
      method: 'GET',
      path: '/agent-missions/current/quote-creation',
      decode: decodeAgentMissionCurrent,
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
      decode: decodeAgentMissionStart,
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
      decode: decodeAgentMissionCancel,
      signal,
    });
  }

  acknowledgeQuoteScreen(
    input: RealtimeAgentMissionAcknowledgeQuoteScreenInput,
    signal?: AbortSignal,
  ) {
    if (!isCanonicalAgentMissionUuid(input?.missionId)) {
      return validation<AcknowledgeQuoteScreenOutput>(
        'missionId',
        'UUID canonique requis.',
      );
    }
    if (!isCanonicalAgentMissionUserCommandId(input.commandId)) {
      return validation<AcknowledgeQuoteScreenOutput>(
        'commandId',
        'UUID v4 canonique requis.',
      );
    }
    if (!revision(input.expectedMissionRevision)) {
      return validation<AcknowledgeQuoteScreenOutput>(
        'expectedMissionRevision',
        'Révision positive requise.',
      );
    }
    if (!revision(input.contextRevision)) {
      return validation<AcknowledgeQuoteScreenOutput>(
        'contextRevision',
        'Révision de contexte positive requise.',
      );
    }
    if (typeof input.contextDigest !== 'string' || !SHA_256.test(input.contextDigest)) {
      return validation<AcknowledgeQuoteScreenOutput>(
        'contextDigest',
        'Digest SHA-256 canonique requis.',
      );
    }
    if (!draftSessionId(input.draftSessionId)) {
      return validation<AcknowledgeQuoteScreenOutput>(
        'draftSessionId',
        'Session de brouillon canonique requise.',
      );
    }
    if (!revision(input.expectedDraftSlotRevision)) {
      return validation<AcknowledgeQuoteScreenOutput>(
        'expectedDraftSlotRevision',
        'Révision de slot positive requise.',
      );
    }
    if (!revision(input.expectedDraftContentRevision, true)) {
      return validation<AcknowledgeQuoteScreenOutput>(
        'expectedDraftContentRevision',
        'Révision de contenu requise.',
      );
    }
    return this.call<AcknowledgeQuoteScreenOutput>({
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
      decode: decodeAgentMissionScreenAck,
      signal,
    });
  }

  decideQuoteCreation(
    input: RealtimeAgentMissionQuoteDecisionInput,
    signal?: AbortSignal,
  ) {
    if (!isCanonicalAgentMissionUuid(input?.missionId)) {
      return validation<DecideQuoteAgentMissionOutput>(
        'missionId',
        'UUID canonique requis.',
      );
    }
    if (!isCanonicalAgentMissionUserCommandId(input.commandId)) {
      return validation<DecideQuoteAgentMissionOutput>(
        'commandId',
        'UUID v4 canonique requis.',
      );
    }
    if (!revision(input.expectedMissionRevision)) {
      return validation<DecideQuoteAgentMissionOutput>(
        'expectedMissionRevision',
        'Révision positive requise.',
      );
    }
    if (!draftSessionId(input.expectedDraftSessionId)) {
      return validation<DecideQuoteAgentMissionOutput>(
        'expectedDraftSessionId',
        'Session de brouillon canonique requise.',
      );
    }
    if (!revision(input.expectedDraftSlotRevision)) {
      return validation<DecideQuoteAgentMissionOutput>(
        'expectedDraftSlotRevision',
        'Révision de slot positive requise.',
      );
    }
    if (!revision(input.expectedDraftContentRevision, true)) {
      return validation<DecideQuoteAgentMissionOutput>(
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
        return validation<DecideQuoteAgentMissionOutput>(
          'decision',
          'Décision de choix exacte requise.',
        );
      }
      if (!isCanonicalAgentMissionUuid(input.decisionId)) {
        return validation<DecideQuoteAgentMissionOutput>(
          'decisionId',
          'UUID canonique requis.',
        );
      }
      if (!revision(input.choiceSetRevision)) {
        return validation<DecideQuoteAgentMissionOutput>(
          'choiceSetRevision',
          'Révision positive requise.',
        );
      }
      if (!isCanonicalAgentMissionUuid(input.choiceId)) {
        return validation<DecideQuoteAgentMissionOutput>(
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
        return validation<DecideQuoteAgentMissionOutput>(
          'decision',
          'Sélection client exacte requise.',
        );
      }
      if (!isCanonicalAgentMissionOpaqueIdentifier(input.customerId)) {
        return validation<DecideQuoteAgentMissionOutput>(
          'customerId',
          'Identifiant client canonique requis.',
        );
      }
    } else {
      return validation<DecideQuoteAgentMissionOutput>(
        'action',
        'Action de décision inconnue.',
      );
    }
    const { missionId, ...body } = input;
    return this.call<DecideQuoteAgentMissionOutput>({
      method: 'POST',
      path: `/agent-missions/${encodeURIComponent(missionId)}/decisions`,
      body,
      decode: (value) => decodeAgentMissionDecision(value, missionId),
      signal,
    });
  }

  dispose(): void {
    this.#capability = null;
    this.#request = null;
  }

  private call<T>(
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

export function createHttpRealtimeAgentMissionSession(input: {
  readonly realtimeSessionId: string;
  readonly capability: string;
  readonly request: HttpAgentMissionRequester;
}): RealtimeAgentMissionSession {
  return new HttpRealtimeAgentMissionSession(input);
}
