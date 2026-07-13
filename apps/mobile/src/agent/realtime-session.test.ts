import { describe, expect, it } from 'vitest';
import { ok } from '@bob/core';
import type { AgentContext } from '@bob/ai';
import type { RealtimeResilienceEvent } from '../realtime/realtime-resilience-orchestrator';
import {
  RealtimeSessionController,
  type RealtimeOrchestratorLike,
  type RealtimeSessionHooks,
} from './realtime-session';

const CONTEXT: AgentContext = {
  screen: { name: 'ventes', instanceId: 'ventes' },
  entities: [],
  capabilities: ['screen.read'],
};

function harness(input: { available?: boolean; handle?: string | null } = {}) {
  const log: string[] = [];
  let emit: (event: RealtimeResilienceEvent) => void = () => undefined;
  const transport = {
    setMicrophoneEnabled: (enabled: boolean) => {
      log.push(`mic:${enabled}`);
    },
  };
  const orchestrator: RealtimeOrchestratorLike = {
    subscribe: (listener) => {
      emit = listener;
      return () => undefined;
    },
    start: async () => ({ phase: 'ready', fallbackChannel: null }),
    stop: async () => {
      log.push('orchestrator:stop');
    },
  };
  const hooks: RealtimeSessionHooks = {
    onPhase: (phase) => log.push(`phase:${phase}`),
    onUserTranscript: (text, final) => log.push(`user:${text}:${final}`),
    onBobTranscript: (text) => log.push(`bob:${text}`),
    onReview: (proposalId) => log.push(`review:${proposalId}`),
    onNavigate: (route) => log.push(`nav:${route}`),
    onFallback: (reason) => log.push(`fallback:${reason}`),
    getContextSnapshot: () => CONTEXT,
  };
  const controller = new RealtimeSessionController(
    {
      isAvailable: async () => input.available ?? true,
      updateContext: async (handle, update) => {
        log.push(`publish:${handle}:r${update.revision}`);
        return ok({});
      },
      createOrchestrator: (fallback, onPrimaryCreated) => {
        onPrimaryCreated(transport);
        void fallback; // le port est câblé par l'orchestrateur réel ; ici on émet les événements
        return orchestrator;
      },
      readSessionHandle: () => (input.handle !== undefined ? input.handle : 'h-42'),
    },
    hooks,
  );
  return { controller, log, emit: (event: RealtimeResilienceEvent) => emit(event) };
}

const readyState = {
  phase: 'ready',
  generation: 1,
  turn: 0,
  fallbackReason: null,
} as const;

describe('RealtimeSessionController — l’ORDRE du contrat monobrain', () => {
  it('serveur indisponible (entitlement/rollout) → unavailable, rien ne démarre', async () => {
    const { controller, log } = harness({ available: false });
    expect(await controller.start()).toBe('unavailable');
    expect(log).toEqual([]);
  });

  it('micro FERMÉ à la création → ready → PUBLIE le contexte → PUIS ouvre le micro', async () => {
    const { controller, log, emit } = harness();
    expect(await controller.start()).toBe('realtime');
    expect(log).toContain('mic:false');
    emit({ type: 'transport', event: { type: 'state', state: readyState } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const publishIndex = log.findIndex((entry) => entry.startsWith('publish:h-42:r1'));
    const micOnIndex = log.indexOf('mic:true');
    expect(publishIndex).toBeGreaterThan(-1);
    expect(micOnIndex).toBeGreaterThan(publishIndex); // JAMAIS le micro avant le contexte
  });

  it('handle indisponible (trou de contrat) : pas de publication, micro ouvert quand même — dégradé honnête', async () => {
    const { controller, log, emit } = harness({ handle: null });
    await controller.start();
    emit({ type: 'transport', event: { type: 'state', state: readyState } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(log.some((entry) => entry.startsWith('publish:'))).toBe(false);
    expect(log).toContain('mic:true');
  });

  it('agent_control : proposition → review (jamais d’auto-confirmation), route hostile → rien', async () => {
    const { controller, log, emit } = harness();
    await controller.start();
    emit({
      type: 'transport',
      event: { type: 'agent_control', control: { turnId: 't', kind: 'proposed', proposalId: 'p-9' } },
    });
    emit({
      type: 'transport',
      event: { type: 'agent_control', control: { turnId: 't2', kind: 'answer', navigate: 'https://evil' } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(log).toContain('review:p-9');
    expect(log.some((entry) => entry.startsWith('nav:'))).toBe(false);
  });

  it('stop() ferme le publieur puis l’orchestrateur ; les événements tardifs sont ignorés', async () => {
    const { controller, log, emit } = harness();
    await controller.start();
    await controller.stop();
    emit({ type: 'transport', event: { type: 'user_transcript', text: 'tard', final: true } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(log).toContain('orchestrator:stop');
    expect(log.some((entry) => entry.startsWith('user:tard'))).toBe(false);
  });
});
