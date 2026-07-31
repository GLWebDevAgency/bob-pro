import type {
  QuoteAgentMissionResumeView,
  QuoteAgentMissionResumeViewV2,
  QuoteAgentMissionPresentationV1,
  ResumableQuoteAgentMissionView,
} from '@bob/core';

type PresentQuoteAgentMissionResumeViewV1 = Exclude<
  QuoteAgentMissionResumeView,
  { readonly mission: null }
>;

type PresentQuoteAgentMissionResumeViewV2 = Exclude<
  QuoteAgentMissionResumeViewV2,
  { readonly mission: null }
>;

export type QuoteAgentMissionRecoveryView =
  | {
      readonly protocolVersion: null;
      readonly mission: null;
      readonly presentation: null;
    }
  | (
      PresentQuoteAgentMissionResumeViewV1
      & {
        readonly protocolVersion: 1;
        readonly presentation: null;
      }
    )
  | (
      PresentQuoteAgentMissionResumeViewV2
      & { readonly protocolVersion: 2 }
    );

export type PresentQuoteAgentMissionResumeView = Exclude<
  QuoteAgentMissionRecoveryView,
  { readonly mission: null }
>;

export type AgentMissionRecoverySnapshot =
  | { readonly phase: 'loading' }
  | { readonly phase: 'absent' }
  | {
      readonly phase: 'resumable';
      readonly value: PresentQuoteAgentMissionResumeView;
    }
  | {
      readonly phase: 'error';
      readonly reason: 'unauthenticated' | 'unavailable';
    };

export interface AgentMissionRecoveryQueryObservation {
  readonly authenticated: boolean;
  readonly pending: boolean;
  readonly fetching: boolean;
  readonly failed: boolean;
  readonly data: QuoteAgentMissionRecoveryView | undefined;
}

/**
 * Projection pure de la query.
 *
 * Une ancienne donnée ne survit jamais à un refetch en vol ou échoué : tant que l'absence de
 * mission n'est pas fraîchement prouvée, le writer manuel reste fermé.
 */
export function deriveAgentMissionRecoverySnapshot(
  observation: AgentMissionRecoveryQueryObservation,
): AgentMissionRecoverySnapshot {
  if (!observation.authenticated) {
    return { phase: 'error', reason: 'unauthenticated' };
  }
  if (observation.pending || observation.fetching) return { phase: 'loading' };
  if (observation.failed || observation.data === undefined) {
    return { phase: 'error', reason: 'unavailable' };
  }
  return observation.data.mission === null
    ? { phase: 'absent' }
    : { phase: 'resumable', value: observation.data };
}

export function sameRecoveredMission(
  recovered: PresentQuoteAgentMissionResumeView,
  expected: {
    readonly id: string;
    readonly revision: number;
    readonly draft: ResumableQuoteAgentMissionView['draft'];
  },
): boolean {
  const actual = recovered.mission;
  return actual.id === expected.id
    && actual.revision === expected.revision
    && actual.draft.sessionId === expected.draft.sessionId
    && actual.draft.slotRevision === expected.draft.slotRevision
    && actual.draft.contentRevision === expected.draft.contentRevision
    && recovered.draft.sessionId === expected.draft.sessionId
    && recovered.draft.slotRevision === expected.draft.slotRevision
    && recovered.draft.contentRevision === expected.draft.contentRevision;
}

export function recoveryPresentation(
  recovered: PresentQuoteAgentMissionResumeView,
): QuoteAgentMissionPresentationV1 | null {
  return recovered.protocolVersion === 2 ? recovered.presentation : null;
}
