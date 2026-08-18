import type { RealtimeSessionHooks } from './realtime-session';

export type AgentRealtimeUiHooks = Omit<RealtimeSessionHooks, 'getContextSnapshot'>;

export function fenceAgentRealtimeHooks(input: {
  readonly isCurrentController: () => boolean;
  readonly ownsLiveUi: () => boolean;
  readonly hooks: AgentRealtimeUiHooks;
}): AgentRealtimeUiHooks {
  const mayDeliver = (): boolean => input.isCurrentController() && input.ownsLiveUi();
  return {
    onPhase: (phase) => { if (mayDeliver()) input.hooks.onPhase(phase); },
    onUserTranscript: (text, final) => {
      if (mayDeliver()) input.hooks.onUserTranscript(text, final);
    },
    onBobTranscript: (text, final) => {
      if (mayDeliver()) input.hooks.onBobTranscript(text, final);
    },
    onDiagnosticTrace: (disclosure) => {
      if (mayDeliver()) input.hooks.onDiagnosticTrace(disclosure);
    },
    onReview: (proposalId, proposalExpiresAt) => {
      if (mayDeliver()) input.hooks.onReview(proposalId, proposalExpiresAt);
    },
    onNavigate: (route) => { if (mayDeliver()) input.hooks.onNavigate(route); },
    onFallback: (reason, channel) => {
      if (mayDeliver()) input.hooks.onFallback(reason, channel);
    },
    onFailedClosed: (reason) => {
      if (mayDeliver()) input.hooks.onFailedClosed(reason);
    },
    onCompleted: () => { if (mayDeliver()) input.hooks.onCompleted?.(); },
  } satisfies AgentRealtimeUiHooks;
}
