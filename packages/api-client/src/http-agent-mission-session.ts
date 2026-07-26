import {
  appUnavailable,
  isCanonicalAgentMissionUserCommandId,
  isCanonicalAgentMissionUuid,
  type AcknowledgeQuoteScreenOutput,
  type AgentMissionViewV1,
  type AppError,
  type CancelQuoteAgentMissionOutput,
  type Result,
  type StartQuoteAgentMissionOutput,
} from '@bob/core';
import {
  decodeAgentMissionCancel,
  decodeAgentMissionCurrent,
  decodeAgentMissionScreenAck,
  decodeAgentMissionStart,
} from './agent-mission-codec';
import {
  REALTIME_AGENT_MISSION_PROTOCOL_VERSION,
  type RealtimeAgentMissionAcknowledgeQuoteScreenInput,
  type RealtimeAgentMissionCancelQuoteInput,
  type RealtimeAgentMissionSession,
  type RealtimeAgentMissionStartQuoteInput,
} from './agent-mission-session';

const POSTGRES_INT_MAX = 2_147_483_647;
const SHA_256 = /^[a-f0-9]{64}$/u;
const MAX_DRAFT_SESSION_ID_LENGTH = 160;
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

function hasAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function draftSessionId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= MAX_DRAFT_SESSION_ID_LENGTH
    && value === value.trim()
    && !hasAsciiControlCharacter(value);
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
    return this.call<CancelQuoteAgentMissionOutput>({
      method: 'POST',
      path: `/agent-missions/${encodeURIComponent(input.missionId)}/cancel`,
      body: {
        commandId: input.commandId,
        expectedMissionRevision: input.expectedMissionRevision,
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
