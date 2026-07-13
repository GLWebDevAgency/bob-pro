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

function harness(
  input: {
    available?: boolean;
    handle?: string | null;
    putFails?: boolean;
    gateRejects?: boolean;
    gateKind?: 'answer' | 'proposed' | 'done';
    gateNavigate?: string;
    /** Diffère la résolution de orchestrator.start() — simule un bootstrap réseau lent. */
    deferStart?: boolean;
    /** Remplace le PUT contexte — pour orchestrer des courses de publication. */
    updateContextImpl?: (handle: string, revision: number) => Promise<ReturnType<typeof ok<{ revision: number; contextDigest: string }>> | { ok: false; error: { kind: 'dependency'; port: string; cause: string } }>;
  } = {},
) {
  const log: string[] = [];
  let emit: (event: RealtimeResilienceEvent) => void = () => undefined;
  const external: {
    resolveStart: ((phase: string) => void) | null;
    fallback: import('../realtime/realtime-resilience-orchestrator').LegacyVoiceFallbackPort | null;
  } = { resolveStart: null, fallback: null };
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
    start: async () => {
      if (input.deferStart === true) {
        const phase = await new Promise<string>((resolve) => {
          external.resolveStart = resolve;
        });
        return { phase, fallbackChannel: null };
      }
      return { phase: 'ready', fallbackChannel: null };
    },
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
        if (input.updateContextImpl) return input.updateContextImpl(handle, update.revision);
        if (input.putFails === true) {
          return { ok: false as const, error: { kind: 'dependency' as const, port: 'realtime', cause: 'offline' } };
        }
        return ok({ revision: update.revision, contextDigest: `digest-${update.revision}` });
      },
      createOrchestrator: (fallback, onPrimaryCreated) => {
        onPrimaryCreated(transport);
        external.fallback = fallback; // capturé : les tests simulent la prise de main du repli
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
  return { controller, log, emit: (event: RealtimeResilienceEvent) => emit(event), external };
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

  it('P0 — stop() PENDANT le bootstrap : le start en vol est invalidé, JAMAIS de micro posthume', async () => {
    const { controller, log, emit, external } = harness({ deferStart: true });
    const pending = controller.start(); // bootstrap lent (réseau/WebRTC)
    await new Promise((resolve) => setTimeout(resolve, 0));
    await controller.stop('user'); // l'utilisateur (ou AppState background) coupe AVANT la fin
    external.resolveStart?.('ready'); // le bootstrap aboutit quand même côté réseau…
    expect(await pending).toBe('unavailable'); // …mais la génération est morte
    emit({ type: 'transport', event: { type: 'state', state: readyState } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(log).not.toContain('mic:true'); // le micro fantôme du P0 n'existe plus
    expect(log.some((entry) => entry.startsWith('publish:'))).toBe(false);
  });

  it('publication SUPERSEDED (navigation doublée) : la session survit, pas de repli', async () => {
    let call = 0;
    let deferredA: ((v: { ok: true; value: { revision: number; contextDigest: string } }) => void) | null = null;
    const h = harness({
      updateContextImpl: (_handle, revision) => {
        call += 1;
        if (call === 1) {
          // Publication de BOOTSTRAP (r1) : immédiate — le micro s'ouvre normalement.
          return Promise.resolve({ ok: true as const, value: { revision, contextDigest: `d-${revision}` } });
        }
        if (call === 2) {
          // Navigation A (r2) : PUT lent, sera doublé par B.
          return new Promise((resolve) => {
            deferredA = (v) => resolve(v);
          });
        }
        // Navigation B (r3) : résout D'ABORD, puis on relâche A (course réelle du terrain).
        setTimeout(() => deferredA?.({ ok: true, value: { revision: 2, contextDigest: 'd-2' } }), 0);
        return Promise.resolve({ ok: true as const, value: { revision, contextDigest: `d-${revision}` } });
      },
    });
    await h.controller.start();
    h.emit({ type: 'transport', event: { type: 'state', state: readyState } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const a = h.controller.publishContext(); // navigation A (sera doublée)
    const b = h.controller.publishContext(); // navigation B (fraîche)
    await Promise.all([a, b]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.log).not.toContain('orchestrator:stop'); // AUCUNE destruction de session
    expect(h.log.some((entry) => entry.startsWith('fallback:'))).toBe(false);
    // Le micro finit OUVERT via la publication fraîche (B) — la doublée n'a rien cassé.
    expect(h.log.lastIndexOf('mic:true')).toBeGreaterThan(h.log.lastIndexOf('mic:false'));
  });

  it('repli pendant le bootstrap (orchestrateur → legacy) : outcome=fallback, pas de double boucle', async () => {
    const { controller, log, external } = harness({ deferStart: true });
    const pending = controller.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // L'orchestrateur épuise ses retries et active le repli AVANT de résoudre start().
    await external.fallback?.start({ reason: 'bootstrap_failed', channel: 'voice' });
    external.resolveStart?.('legacy');
    expect(await pending).toBe('fallback'); // l'appelant SAIT que onFallback a déjà relancé legacy
    expect(log.some((entry) => entry.startsWith('fallback:bootstrap_failed'))).toBe(true);
    expect(log).not.toContain('mic:true');
  });

  it('redémarrage après un repli mid-call : start() repart d’un monde PROPRE (jamais un zombie)', async () => {
    const { controller, log, emit, external } = harness();
    await controller.start();
    emit({ type: 'transport', event: { type: 'state', state: readyState } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Transport meurt en pleine conversation → l'orchestrateur active le repli via le port.
    await external.fallback?.start({ reason: 'provider_error', channel: 'voice' });
    expect(controller.active).toBe(false); // scellé — les événements tardifs sont ignorés
    log.length = 0;
    expect(await controller.start()).toBe('realtime'); // PAS un retour immédiat sur l'ancien monde
    expect(log).toContain('orchestrator:stop'); // le zombie a été démonté d'abord
    emit({ type: 'transport', event: { type: 'state', state: readyState } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(log).toContain('mic:true'); // la session fraîche vit vraiment
  });
});
