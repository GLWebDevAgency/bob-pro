import { describe, expect, it, vi } from 'vitest';
import type { RealtimeVoiceDiagnosticTraceDisclosure } from '@bob/api-client';
import { fenceAgentRealtimeHooks, type AgentRealtimeUiHooks } from './agent-session-realtime-hook-fence';

const disclosure = Object.freeze({
  version: 1,
  purpose: 'bob_live_quality',
  capturedData: Object.freeze(['transcript']),
  retentionDays: 7,
} as unknown as RealtimeVoiceDiagnosticTraceDisclosure);

function hooks(log: string[]): AgentRealtimeUiHooks {
  return {
    onPhase: (value) => log.push(`phase:${value}`),
    onUserTranscript: (text, final) => log.push(`user:${text}:${final}`),
    onBobTranscript: (text, final) => log.push(`bob:${text}:${final}`),
    onDiagnosticTrace: () => log.push('trace'),
    onReview: (id, expiry) => log.push(`review:${id}:${expiry}`),
    onNavigate: (route) => log.push(`nav:${route}`),
    onFallback: (reason, channel) => log.push(`fallback:${reason}:${channel}`),
    onFailedClosed: (reason) => log.push(`failed:${reason}`),
    onCompleted: () => log.push('completed'),
  };
}

function invokeAll(value: AgentRealtimeUiHooks): void {
  value.onPhase('thinking');
  value.onUserTranscript('u', true);
  value.onBobTranscript('b', true);
  value.onDiagnosticTrace(disclosure);
  value.onReview('p', 'e');
  value.onNavigate('/clients');
  value.onFallback('provider_error', 'voice');
  value.onFailedClosed('provider_error');
  value.onCompleted?.();
}

describe('fenceAgentRealtimeHooks', () => {
  it('délivre exhaustivement les neuf callbacks seulement au controller courant et vivant', () => {
    const log: string[] = [];
    let current = true;
    let live = true;
    const fenced = fenceAgentRealtimeHooks({
      isCurrentController: () => current,
      ownsLiveUi: () => live,
      hooks: hooks(log),
    });
    invokeAll(fenced);
    expect(log).toHaveLength(9);

    log.length = 0;
    current = false;
    invokeAll(fenced);
    expect(log).toEqual([]);

    current = true;
    live = false;
    invokeAll(fenced);
    expect(log).toEqual([]);
  });

  it('rend tous les callbacks A inertes dès que B possède l’UI', () => {
    const aLog: string[] = [];
    const bLog: string[] = [];
    let owner: 'A' | 'B' = 'A';
    const a = fenceAgentRealtimeHooks({
      isCurrentController: () => owner === 'A',
      ownsLiveUi: () => true,
      hooks: hooks(aLog),
    });
    const b = fenceAgentRealtimeHooks({
      isCurrentController: () => owner === 'B',
      ownsLiveUi: () => true,
      hooks: hooks(bLog),
    });
    owner = 'B';
    invokeAll(a);
    invokeAll(b);
    expect(aLog).toEqual([]);
    expect(bLog).toHaveLength(9);
    expect(vi.isMockFunction(b.onPhase)).toBe(false);
  });
});
