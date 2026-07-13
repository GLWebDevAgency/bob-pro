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

function harness(input: { available?: boolean; handle?: string | null; putFails?: boolean; gateRejects?: boolean; gateKind?: 'answer' | 'proposed' | 'done'; gateNavigate?: string } = {}) {
  const log: string[] = [];
  let emit: (event: RealtimeResilienceEvent) => void = () => undefined;
  const transport = {
    setMicrophoneEnabled: (enabled: boolean) => {
      log.push(`mic:${enabled}`);
    },
    interrupt: (reason: string) => {
      log.push(`interrupt:${reason}`);
      return true;
    },
    getSessionHandle: () => (input.handle !== undefined ? input.handle : 'h-42'),
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
        if (input.putFails === true) {
          return { ok: false as const, error: { kind: 'dependency' as const, port: 'realtime', cause: 'offline' } };
        }
        return ok({ revision: update.revision, contextDigest: `digest-${update.revision}` });
      },
      createOrchestrator: (fallback, onPrimaryCreated) => {
        onPrimaryCreated(transport);
        void fallback; // le port est câblé par l'orchestrateur réel ; ici on émet les événements
        return orchestrator;
      },
      createControlGate: (currentFence) => ({
        acknowledge: async (reference) => {
          const fence = currentFence();
          log.push(`ack:${reference.turnId}:fence-r${fence?.contextRevision ?? 'none'}`);
          if (!fence || input.gateRejects === true) return null;
          return {
            turnId: reference.turnId,
            kind: input.gateKind ?? 'proposed',
            contextRevision: fence.contextRevision,
            contextDigest: fence.contextDigest,
            ...(input.gateNavigate !== undefined ? { navigate: input.gateNavigate } : {}),
            ...(input.gateKind === 'proposed' || input.gateKind === undefined ? { proposalId: 'p-9' } : {}),
          };
        },
        close: () => log.push('gate:close'),
      }),
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

  it('handle indisponible → FAIL-CLOSED : pas de publication, JAMAIS de micro, stop + repli', async () => {
    const { controller, log, emit } = harness({ handle: null });
    await controller.start();
    emit({ type: 'transport', event: { type: 'state', state: readyState } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(log.some((entry) => entry.startsWith('publish:'))).toBe(false);
    expect(log).not.toContain('mic:true');
    expect(log).toContain('orchestrator:stop');
    expect(log.some((entry) => entry.startsWith('fallback:'))).toBe(true);
  });

  const candidate = (turnId: string) => ({
    type: 'transport' as const,
    event: {
      type: 'agent_control_candidate' as const,
      reference: { turnId, contextRevision: 1, contextDigest: 'digest-1' },
    },
  });

  it('candidat → ACK gate (fencé sur la publication CONFIRMÉE) → proposition = review only', async () => {
    const { controller, log, emit } = harness();
    await controller.start();
    emit({ type: 'transport', event: { type: 'state', state: readyState } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    emit(candidate('t'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(log).toContain('ack:t:fence-r1');
    expect(log).toContain('review:p-9');
  });

  it('gate rejette (fence périmée/serveur non) → AUCUN effet ; route hostile ACKée → ignorée', async () => {
    const rejected = harness({ gateRejects: true });
    await rejected.controller.start();
    rejected.emit({ type: 'transport', event: { type: 'state', state: readyState } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    rejected.emit(candidate('t'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rejected.log.some((entry) => entry.startsWith('review:') || entry.startsWith('nav:'))).toBe(false);

    const hostile = harness({ gateKind: 'answer', gateNavigate: 'https://evil' });
    await hostile.controller.start();
    hostile.emit({ type: 'transport', event: { type: 'state', state: readyState } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    hostile.emit(candidate('t2'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hostile.log.some((entry) => entry.startsWith('nav:'))).toBe(false);
  });

  it('changement d’écran : micro OFF → interrupt(navigation) → PUT → micro ON ; PUT en échec → stop + fallback', async () => {
    const okCase = harness();
    await okCase.controller.start();
    okCase.emit({ type: 'transport', event: { type: 'state', state: readyState } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    okCase.log.length = 0;
    await okCase.controller.publishContext();
    expect(okCase.log.slice(0, 3)).toEqual(['mic:false', 'interrupt:navigation', 'publish:h-42:r2']);
    expect(okCase.log).toContain('mic:true');

    const failing = harness({ putFails: true });
    await failing.controller.start();
    // publication initiale en échec → session stoppée + fallback honnête
    failing.emit({ type: 'transport', event: { type: 'state', state: readyState } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(failing.log).toContain('orchestrator:stop');
    expect(failing.log.some((entry) => entry.startsWith('fallback:'))).toBe(true);
    expect(failing.log).not.toContain('mic:true');
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
