import { describe, expect, it } from 'vitest';
import { ok } from '@bob/core';
import type { AgentContext } from '@bob/ai';
import {
  REALTIME_AGENT_MISSION_PROTOCOL_M2A_VERSION,
  REALTIME_AGENT_MISSION_PROTOCOL_VERSION,
  type RealtimeAgentMissionSession,
  type RealtimeVoiceConfig,
} from '@bob/api-client';
import type { RealtimeResilienceEvent } from '../realtime/realtime-resilience-orchestrator';
import {
  AgentMissionRuntimeOwner,
  type AgentMissionRuntimeBridge,
} from './agent-mission-runtime';
import {
  RealtimeSessionController,
  type RealtimeOrchestratorLike,
  type RealtimeSessionHooks,
  type RealtimeTransportLike,
} from './realtime-session';

const CONTEXT: AgentContext = {
  screen: { name: 'ventes', instanceId: 'ventes' },
  entities: [],
  capabilities: ['screen.read'],
};

const NEGOTIATION: RealtimeVoiceConfig = Object.freeze({
  available: true,
  transport: 'webrtc',
  model: 'gpt-realtime-2.1',
  voice: 'marin',
  configVersion: 'bob-live-provider-neutral-v2',
  requiresDevelopmentBuild: true,
  maxSessionSeconds: 900,
  speechDelivery: 'audited-signed-url-v1',
});

const NATIVE_WEBRTC_NEGOTIATION: RealtimeVoiceConfig = Object.freeze({
  ...NEGOTIATION,
  configVersion: 'bob-live-provider-neutral-v4',
  speechDelivery: 'openai-native-webrtc-v1',
});

const MISTRAL_NEGOTIATION: RealtimeVoiceConfig = Object.freeze({
  available: true,
  transport: 'mistral-pcm',
  model: 'voxtral-mini-transcribe-realtime-2602',
  voice: 'marin',
  configVersion: 'bob-live-provider-neutral-v2',
  requiresDevelopmentBuild: true,
  maxSessionSeconds: 60,
  speechDelivery: 'audited-signed-url-v1',
});

function acceptingMissionRuntime(): AgentMissionRuntimeBridge {
  return {
    adopt: () => true,
    invalidateContext: () => undefined,
    confirmContext: () => true,
    settleTurn: () => true,
    release: () => true,
  };
}

function owningMissionRuntime(): AgentMissionRuntimeBridge {
  let owned: RealtimeAgentMissionSession | null = null;
  return {
    adopt: (session) => {
      if (owned !== null && owned !== session) owned.dispose();
      owned = session;
      return true;
    },
    invalidateContext: () => undefined,
    confirmContext: () => true,
    settleTurn: () => true,
    release: (realtimeSessionId) => {
      if (owned?.realtimeSessionId !== realtimeSessionId) return false;
      const released = owned;
      owned = null;
      released.dispose();
      return true;
    },
  };
}

function missionSessionStub(
  log: string[],
  label: string,
  realtimeSessionId = `realtime-${label}`,
  protocolVersion:
    | typeof REALTIME_AGENT_MISSION_PROTOCOL_VERSION
    | typeof REALTIME_AGENT_MISSION_PROTOCOL_M2A_VERSION =
      REALTIME_AGENT_MISSION_PROTOCOL_M2A_VERSION,
): RealtimeAgentMissionSession {
  let disposed = false;
  const unused = async (): Promise<never> => {
    throw new Error('unused_agent_mission_method');
  };
  return {
    protocolVersion,
    realtimeSessionId,
    get disposed() {
      return disposed;
    },
    getCurrentQuoteCreation: unused,
    startQuoteCreation: unused,
    cancelQuoteCreation: unused,
    acknowledgeQuoteScreen: unused,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      log.push(`${label}:dispose`);
    },
  } as unknown as RealtimeAgentMissionSession;
}

function harness(
  input: {
    log?: string[];
    agentMissionSessions?: readonly (RealtimeAgentMissionSession | null)[];
    available?: boolean;
    handle?: string | null;
    putFails?: boolean;
    gateRejects?: boolean;
    gateKind?: 'answer' | 'proposed' | 'done';
    gateNavigate?: string;
    gateDelay?: Promise<void>;
    completionMode?: 'continuous' | 'one-shot';
    /** Diffère la résolution de orchestrator.start() — simule un bootstrap réseau lent. */
    deferStart?: boolean;
    /** Remplace le PUT contexte — pour orchestrer des courses de publication. */
    updateContextImpl?: (
      handle: string,
      revision: number,
    ) => Promise<
      | ReturnType<typeof ok<{ revision: number; contextDigest: string }>>
      | { ok: false; error: { kind: 'dependency'; port: string; cause: string } }
    >;
    allowMicrophoneActivation?: () => Promise<boolean>;
    ensureConfirmedTimeZoneForMissionV2?: () => Promise<boolean>;
    confirmDiagnosticTraceBeforeListening?: (
      disclosure: import('@bob/api-client').RealtimeVoiceDiagnosticTraceDisclosure,
    ) => Promise<boolean>;
    synchronizeContext?: (
      fence: import('./realtime-driver').RealtimePublishedFence,
    ) => Promise<boolean>;
    emitCommitOnFinish?: boolean;
    failAgentMissionNegotiation?: boolean;
    agentMissionRuntime?: AgentMissionRuntimeBridge;
    /** Simule volontairement un montage audité sans propriétaire runtime. */
    omitAgentMissionRuntime?: boolean;
    negotiation?: RealtimeVoiceConfig;
  } = {},
) {
  const log: string[] = input.log ?? [];
  const negotiated = input.negotiation ?? NEGOTIATION;
  const effectiveAgentMissionRuntime =
    input.agentMissionRuntime
    ?? (
      input.omitAgentMissionRuntime !== true
      && negotiated.transport === 'webrtc'
      && negotiated.speechDelivery === 'audited-signed-url-v1'
        ? owningMissionRuntime()
        : undefined
    );
  let nextAgentMissionSession = 0;
  let emit: (event: RealtimeResilienceEvent) => void = () => undefined;
  const external: {
    resolveStart: ((phase: string) => void) | null;
    fallback: import('../realtime/realtime-resilience-orchestrator').LegacyVoiceFallbackPort | null;
    negotiations: number;
    receivedNegotiation: RealtimeVoiceConfig | null;
    receivedAgentMissionProtocolVersion:
      | typeof REALTIME_AGENT_MISSION_PROTOCOL_VERSION
      | typeof REALTIME_AGENT_MISSION_PROTOCOL_M2A_VERSION
      | null;
    reconnect: ((label: string, handle?: string | null) => RealtimeTransportLike) | null;
  } = {
    resolveStart: null,
    fallback: null,
    negotiations: 0,
    receivedNegotiation: null,
    receivedAgentMissionProtocolVersion: null,
    reconnect: null,
  };
  const createTransport = (label: string | null, handle: string | null): RealtimeTransportLike => {
    const explicitAgentMissionSessions = input.agentMissionSessions;
    let agentMissionSession = explicitAgentMissionSessions === undefined
      ? (
          handle !== null
          && negotiated.transport === 'webrtc'
          && negotiated.speechDelivery === 'audited-signed-url-v1'
            ? missionSessionStub(
                log,
                `auto-mission-${label ?? 'initial'}`,
                handle,
                REALTIME_AGENT_MISSION_PROTOCOL_M2A_VERSION,
              )
            : null
        )
      : explicitAgentMissionSessions[nextAgentMissionSession++] ?? null;
    const trace = (entry: string): void => {
      log.push(label === null ? entry : `${label}:${entry}`);
    };
    return {
      completionMode: input.completionMode ?? 'continuous',
      setMicrophoneEnabled: (enabled: boolean) => {
        trace(`mic:${enabled}`);
      },
      interrupt: (reason) => {
        trace(`interrupt:${reason}`);
        return true;
      },
      finishUserInput: async () => {
        trace('finish-input');
        if (input.emitCommitOnFinish === true) {
          emit({ type: 'transport', event: { type: 'state', state: readyState } });
          emit({
            type: 'transport',
            event: { type: 'user_input_committed', turnId: 'manual-turn' },
          });
        }
        return true;
      },
      getSessionHandle: () => handle,
      takeAgentMissionSession: () => {
        trace('mission:take');
        const session = agentMissionSession;
        agentMissionSession = null;
        return session;
      },
      ...(input.synchronizeContext === undefined ? {} : {
        synchronizePublishedContext: async (
          fence: import('./realtime-driver').RealtimePublishedFence,
        ) => {
          trace(`sync:r${fence.contextRevision}`);
          return input.synchronizeContext!(fence);
        },
      }),
    };
  };
  const transport = createTransport(null, input.handle !== undefined ? input.handle : 'h-42');
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
        return { phase, fallbackChannel: null, lastFailureReason: null };
      }
      return input.failAgentMissionNegotiation === true
        ? {
            phase: 'stopped',
            fallbackChannel: null,
            lastFailureReason: 'agent_mission_negotiation_failed',
          }
        : { phase: 'ready', fallbackChannel: null, lastFailureReason: null };
    },
    stop: async () => {
      log.push('orchestrator:stop');
    },
  };
  const hooks: RealtimeSessionHooks = {
    onPhase: (phase) => log.push(`phase:${phase}`),
    onUserTranscript: (text, final) => log.push(`user:${text}:${final}`),
    onBobTranscript: (text) => log.push(`bob:${text}`),
    onDiagnosticTrace: (disclosure) => {
      log.push(`trace:${disclosure.purpose}:${disclosure.retentionDays}`);
    },
    onReview: (proposalId, proposalExpiresAt) => {
      log.push(`review:${proposalId}:${proposalExpiresAt ?? 'none'}`);
    },
    onNavigate: (route) => log.push(`nav:${route}`),
    onFallback: (reason, channel) => log.push(`fallback:${reason}:${channel}`),
    onFailedClosed: (reason) => log.push(`failed-closed:${reason}`),
    onCompleted: () => log.push('completed'),
    getContextSnapshot: () => CONTEXT,
  };
  const controller = new RealtimeSessionController(
    {
      negotiate: async () => {
        external.negotiations += 1;
        return input.available === false
          ? { ...NEGOTIATION, available: false, availabilityReason: 'not_entitled' }
          : negotiated;
      },
      ensureConfirmedTimeZoneForMissionV2:
        input.ensureConfirmedTimeZoneForMissionV2 ?? (async () => true),
      confirmDiagnosticTraceBeforeListening:
        input.confirmDiagnosticTraceBeforeListening ?? (async () => true),
      updateContext: async (handle, update) => {
        log.push(`publish:${handle}:r${update.revision}`);
        if (input.updateContextImpl) return input.updateContextImpl(handle, update.revision);
        if (input.putFails === true) {
          return {
            ok: false as const,
            error: { kind: 'dependency' as const, port: 'realtime', cause: 'offline' },
          };
        }
        return ok({ revision: update.revision, contextDigest: `digest-${update.revision}` });
      },
      createOrchestrator: (
        negotiation,
        agentMissionProtocolVersion,
        fallback,
        _currentFence,
        onPrimaryCreated,
      ) => {
        external.receivedNegotiation = negotiation;
        external.receivedAgentMissionProtocolVersion =
          agentMissionProtocolVersion;
        onPrimaryCreated(transport);
        external.reconnect = (label, handle = `h-${label}`) => {
          const fresh = createTransport(label, handle);
          onPrimaryCreated(fresh);
          return fresh;
        };
        external.fallback = fallback; // capturé : les tests simulent la prise de main du repli
        return orchestrator;
      },
      createControlGate: (currentFence) => ({
        acknowledge: async (reference) => {
          await input.gateDelay;
          const fence = currentFence();
          log.push(`ack:${reference.turnId}:fence-r${fence?.contextRevision ?? 'none'}`);
          if (!fence || input.gateRejects === true) return null;
          return {
            turnId: reference.turnId,
            kind: input.gateKind ?? 'proposed',
            contextRevision: fence.contextRevision,
            contextDigest: fence.contextDigest,
            ...(input.gateNavigate !== undefined ? { navigate: input.gateNavigate } : {}),
            ...(input.gateKind === 'proposed' || input.gateKind === undefined
              ? { proposalId: 'p-9' }
              : {}),
          };
        },
        close: () => log.push('gate:close'),
      }),
      allowMicrophoneActivation: input.allowMicrophoneActivation
        ?? (async () => true),
      ...(effectiveAgentMissionRuntime === undefined
        ? {}
        : { agentMissionRuntime: effectiveAgentMissionRuntime }),
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
  it('négocie une seule fois et remet le snapshot exact à toute la mission', async () => {
    const { controller, external } = harness();

    expect(await controller.start()).toBe('realtime');
    expect(external.negotiations).toBe(1);
    expect(external.receivedNegotiation).toBe(NEGOTIATION);
    expect(external.receivedAgentMissionProtocolVersion)
      .toBe(REALTIME_AGENT_MISSION_PROTOCOL_M2A_VERSION);
    // LITTÉRAL délibéré : un start frais audité demande EXACTEMENT 2 au transport. Comparer
    // uniquement à la constante laisserait survivre le mutant qui muterait la constante
    // elle-même ou le repli `?? M2A` de startInternal vers la constante V1.
    expect(external.receivedAgentMissionProtocolVersion).toBe(2);
  });

  it('conserve OpenAI natif sans capability Mission et transmet explicitement null', async () => {
    const h = harness({ negotiation: NATIVE_WEBRTC_NEGOTIATION });

    await expect(h.controller.start()).resolves.toBe('realtime');

    expect(h.external.receivedNegotiation).toBe(NATIVE_WEBRTC_NEGOTIATION);
    expect(h.external.receivedAgentMissionProtocolVersion).toBeNull();
    expect(h.log.some((entry) => entry.startsWith('fallback:'))).toBe(false);
  });

  it('serveur indisponible (entitlement/rollout) → unavailable, rien ne démarre', async () => {
    const { controller, log } = harness({ available: false });
    expect(await controller.start()).toBe('unavailable');
    expect(log).toEqual([]);
  });

  it('demande le fuseau après la négociation uniquement pour Mission V2', async () => {
    const order: string[] = [];
    const h = harness({
      ensureConfirmedTimeZoneForMissionV2: async () => {
        order.push('time-zone');
        return false;
      },
    });

    await expect(h.controller.start()).resolves.toBe('cancelled');

    expect(h.external.negotiations).toBe(1);
    expect(order).toEqual(['time-zone']);
    expect(h.external.receivedNegotiation).toBeNull();
    expect(h.log.some((entry) => entry.startsWith('mic:'))).toBe(false);
  });

  it('demande le consentement diagnostic avant fuseau, orchestrateur et micro', async () => {
    const order: string[] = [];
    const diagnosticNegotiation: RealtimeVoiceConfig = {
      ...NEGOTIATION,
      diagnosticTrace: {
        enabled: true,
        retentionDays: 30,
        purpose: 'staging_quality',
      },
    };
    const h = harness({
      negotiation: diagnosticNegotiation,
      confirmDiagnosticTraceBeforeListening: async (disclosure) => {
        order.push(`trace:${disclosure.retentionDays}`);
        return false;
      },
      ensureConfirmedTimeZoneForMissionV2: async () => {
        order.push('time-zone');
        return true;
      },
    });

    await expect(h.controller.start()).resolves.toBe('cancelled');

    expect(order).toEqual(['trace:30']);
    expect(h.external.receivedNegotiation).toBeNull();
    expect(h.log.some((entry) => entry.startsWith('mic:'))).toBe(false);
  });

  it('transmet la disclosure bootstrap au hook sans changer la phase', async () => {
    const h = harness({ negotiation: NATIVE_WEBRTC_NEGOTIATION });
    await h.controller.start();

    h.emit({
      type: 'transport',
      event: {
        type: 'diagnostic_trace_disclosure',
        disclosure: { enabled: true, retentionDays: 30, purpose: 'staging_quality' },
      },
    });

    expect(h.log).toContain('trace:staging_quality:30');
    expect(h.log.filter((entry) => entry.startsWith('phase:'))).toEqual([]);
  });

  it('ne bloque jamais une reprise V1 sur la confirmation du fuseau V2', async () => {
    const log: string[] = [];
    let timeZoneGateCalls = 0;
    const realtimeSessionId = '08000000-0000-4000-8000-000000000001';
    const h = harness({
      log,
      handle: realtimeSessionId,
      ensureConfirmedTimeZoneForMissionV2: async () => {
        timeZoneGateCalls += 1;
        return false;
      },
      agentMissionSessions: [
        missionSessionStub(
          log,
          'resume-v1-without-time-zone',
          realtimeSessionId,
          REALTIME_AGENT_MISSION_PROTOCOL_VERSION,
        ),
      ],
      agentMissionRuntime: acceptingMissionRuntime(),
    });

    const pending = h.controller.resumeMissionV1();
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.emit({ type: 'transport', event: { type: 'state', state: readyState } });

    await expect(pending).resolves.toBe('resumed');
    expect(timeZoneGateCalls).toBe(0);
    expect(log).toContain('mic:true');
  });

  it.each([
    ['OpenAI natif', NATIVE_WEBRTC_NEGOTIATION],
    ['Mistral', MISTRAL_NEGOTIATION],
  ] as const)(
    'ne bloque jamais %s sans Mission V2 sur la confirmation temporelle',
    async (_label, negotiation) => {
      let timeZoneGateCalls = 0;
      const h = harness({
        negotiation,
        ensureConfirmedTimeZoneForMissionV2: async () => {
          timeZoneGateCalls += 1;
          return false;
        },
      });

      await expect(h.controller.start()).resolves.toBe('realtime');

      expect(timeZoneGateCalls).toBe(0);
      expect(h.external.receivedAgentMissionProtocolVersion).toBeNull();
    },
  );

  it('reprise V2 indisponible : échoue fermée sans jamais appeler le fallback legacy', async () => {
    const { controller, log } = harness({
      available: false,
      agentMissionRuntime: acceptingMissionRuntime(),
    });

    await expect(controller.resumeMissionV2()).resolves.toBe('failed_closed');
    expect(log.some((entry) => entry.startsWith('fallback:'))).toBe(false);
    expect(log).not.toContain('mic:true');
  });

  it('reprise V2 sans runtime propriétaire échoue avant négociation, contexte et micro', async () => {
    const h = harness({ omitAgentMissionRuntime: true });

    await expect(h.controller.resumeMissionV2()).resolves.toBe('failed_closed');

    expect(h.external.negotiations).toBe(0);
    expect(h.external.receivedNegotiation).toBeNull();
    expect(h.log.some((entry) => entry.startsWith('publish:'))).toBe(false);
    expect(h.log).not.toContain('mic:true');
  });

  it.each([
    ['Mistral V1', MISTRAL_NEGOTIATION],
    ['OpenAI native non certifié', NATIVE_WEBRTC_NEGOTIATION],
  ] as const)(
    'reprise V2 refuse %s avant de créer le transport',
    async (_label, negotiation) => {
      const h = harness({
        negotiation,
        agentMissionRuntime: acceptingMissionRuntime(),
      });

      await expect(h.controller.resumeMissionV2()).resolves.toBe('failed_closed');

      expect(h.external.negotiations).toBe(1);
      expect(h.external.receivedNegotiation).toBeNull();
      expect(h.log.some((entry) => entry.startsWith('publish:'))).toBe(false);
      expect(h.log).not.toContain('mic:true');
    },
  );

  it('reprise V2 ne réussit qu’après capability V2, contexte confirmé et micro ouvert', async () => {
    const log: string[] = [];
    const realtimeSessionId = '09000000-0000-4000-8000-000000000001';
    const runtime: AgentMissionRuntimeBridge = {
      adopt: () => {
        log.push('runtime:adopt');
        return true;
      },
      invalidateContext: () => undefined,
      confirmContext: () => {
        log.push('runtime:confirm');
        return true;
      },
      settleTurn: () => true,
      release: () => true,
    };
    const h = harness({
      log,
      handle: realtimeSessionId,
      agentMissionSessions: [
        missionSessionStub(log, 'resume-mission', realtimeSessionId),
      ],
      agentMissionRuntime: runtime,
    });

    const pending = h.controller.resumeMissionV2();
    await new Promise((resolve) => setTimeout(resolve, 0));
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    expect(settled).toBe(false);

    h.emit({ type: 'transport', event: { type: 'state', state: readyState } });
    await expect(pending).resolves.toBe('resumed');
    expect(log.indexOf('runtime:adopt')).toBeLessThan(log.indexOf('runtime:confirm'));
    expect(log.indexOf('runtime:confirm')).toBeLessThan(log.indexOf('mic:true'));
    expect(log.some((entry) => entry.startsWith('fallback:'))).toBe(false);
    expect(h.external.receivedAgentMissionProtocolVersion)
      .toBe(REALTIME_AGENT_MISSION_PROTOCOL_M2A_VERSION);
  });

  it('reprise V1 auditée transmet V1 et ne réussit qu’après son contexte exact', async () => {
    const log: string[] = [];
    const realtimeSessionId = '09000000-0000-4000-8000-000000000011';
    const h = harness({
      log,
      handle: realtimeSessionId,
      agentMissionSessions: [
        missionSessionStub(
          log,
          'resume-v1',
          realtimeSessionId,
          REALTIME_AGENT_MISSION_PROTOCOL_VERSION,
        ),
      ],
      agentMissionRuntime: acceptingMissionRuntime(),
    });

    const pending = h.controller.resumeMissionV1();
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.emit({ type: 'transport', event: { type: 'state', state: readyState } });

    await expect(pending).resolves.toBe('resumed');
    expect(h.external.receivedAgentMissionProtocolVersion)
      .toBe(REALTIME_AGENT_MISSION_PROTOCOL_VERSION);
    expect(log).toContain('mic:true');
    expect(log.some((entry) => entry.startsWith('fallback:'))).toBe(false);
  });

  it('reprise V1 détruit une capability V2 sans publier le contexte ni ouvrir le micro', async () => {
    const log: string[] = [];
    const realtimeSessionId = '09000000-0000-4000-8000-000000000012';
    const h = harness({
      log,
      handle: realtimeSessionId,
      agentMissionSessions: [
        missionSessionStub(
          log,
          'resume-v2-refused',
          realtimeSessionId,
          REALTIME_AGENT_MISSION_PROTOCOL_M2A_VERSION,
        ),
      ],
      agentMissionRuntime: acceptingMissionRuntime(),
    });

    const pending = h.controller.resumeMissionV1();
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.emit({ type: 'transport', event: { type: 'state', state: readyState } });

    await expect(pending).resolves.toBe('failed_closed');
    expect(log).toContain('resume-v2-refused:dispose');
    expect(log.some((entry) => entry.startsWith('publish:'))).toBe(false);
    expect(log).not.toContain('mic:true');
  });

  it('reprise V2 sans capability ferme le primaire au lieu de lancer le legacy', async () => {
    const h = harness({
      agentMissionSessions: [null],
      agentMissionRuntime: acceptingMissionRuntime(),
    });
    const pending = h.controller.resumeMissionV2();
    await new Promise((resolve) => setTimeout(resolve, 0));

    h.emit({ type: 'transport', event: { type: 'state', state: readyState } });
    await expect(pending).resolves.toBe('failed_closed');
    expect(h.log).toContain('orchestrator:stop');
    expect(h.log).not.toContain('mic:true');
    expect(h.log.some((entry) => entry.startsWith('fallback:'))).toBe(false);
  });

  it('start frais V2 sans capability ferme la session sans jamais rallumer le legacy', async () => {
    const h = harness({ agentMissionSessions: [null] });

    await expect(h.controller.start()).resolves.toBe('realtime');
    h.emit({ type: 'transport', event: { type: 'state', state: readyState } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.log).toContain('orchestrator:stop');
    expect(h.log).toContain('failed-closed:provider_error');
    expect(h.log.some((entry) => entry.startsWith('fallback:'))).toBe(false);
    expect(h.log).not.toContain('mic:true');
    expect(h.controller.active).toBe(false);
  });

  it('start frais audité sans runtime propriétaire échoue avant transport et micro', async () => {
    const h = harness({ omitAgentMissionRuntime: true });

    await expect(h.controller.start()).resolves.toBe('failed_closed');

    expect(h.external.negotiations).toBe(1);
    expect(h.external.receivedNegotiation).toBeNull();
    expect(h.log.some((entry) => entry.startsWith('publish:'))).toBe(false);
    expect(h.log.some((entry) => entry.startsWith('mic:'))).toBe(false);
  });

  it('reprise V2 interdit aussi le fallback demandé par l’orchestrateur', async () => {
    const h = harness({
      deferStart: true,
      agentMissionRuntime: acceptingMissionRuntime(),
    });
    const pending = h.controller.resumeMissionV2();
    await new Promise((resolve) => setTimeout(resolve, 0));

    await h.external.fallback?.start({
      reason: 'bootstrap_failed',
      channel: 'voice',
    });
    h.external.resolveStart?.('legacy');

    await expect(pending).resolves.toBe('failed_closed');
    expect(h.log.some((entry) => entry.startsWith('fallback:'))).toBe(false);
    expect(h.log).not.toContain('mic:true');
  });

  it('reprise V2 détruit une capability V1 sans publier le contexte ni ouvrir le micro', async () => {
    const log: string[] = [];
    const realtimeSessionId = '09000000-0000-4000-8000-000000000010';
    const h = harness({
      log,
      handle: realtimeSessionId,
      agentMissionSessions: [
        missionSessionStub(
          log,
          'resume-v1-refused',
          realtimeSessionId,
          REALTIME_AGENT_MISSION_PROTOCOL_VERSION,
        ),
      ],
      agentMissionRuntime: acceptingMissionRuntime(),
    });

    const pending = h.controller.resumeMissionV2();
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.emit({ type: 'transport', event: { type: 'state', state: readyState } });

    await expect(pending).resolves.toBe('failed_closed');
    expect(log).toContain('resume-v1-refused:dispose');
    expect(log.some((entry) => entry.startsWith('publish:'))).toBe(false);
    expect(log).not.toContain('mic:true');
  });

  it('retourne failed_closed sans boucle legacy si la négociation mission échoue', async () => {
    const { controller, log } = harness({ failAgentMissionNegotiation: true });

    await expect(controller.start()).resolves.toBe('failed_closed');

    expect(log).toContain('orchestrator:stop');
    expect(log.some((entry) => entry.startsWith('fallback:'))).toBe(false);
    expect(controller.active).toBe(false);
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

  it('prend la capability avant le premier await puis la détruit avant le stop transport', async () => {
    const log: string[] = [];
    const realtimeSessionId = '00000000-0000-4000-8000-000000000042';
    const mission = missionSessionStub(log, 'mission-1', realtimeSessionId);
    const { controller, emit } = harness({
      log,
      handle: realtimeSessionId,
      agentMissionSessions: [mission],
    });
    await controller.start();

    emit({ type: 'transport', event: { type: 'state', state: readyState } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(log.indexOf('mission:take')).toBeLessThan(
      log.indexOf(`publish:${realtimeSessionId}:r1`),
    );
    expect(log.indexOf(`publish:${realtimeSessionId}:r1`))
      .toBeLessThan(log.indexOf('mic:true'));

    await controller.stop('background');
    expect(log.indexOf('mission-1:dispose')).toBeLessThan(log.indexOf('orchestrator:stop'));
    expect(log.filter((entry) => entry === 'mission-1:dispose')).toHaveLength(1);
  });

  it('refuse avant adoption une capability liée à un autre handle Realtime', async () => {
    const log: string[] = [];
    const handle = '00000000-0000-4000-8000-000000000043';
    const mission = missionSessionStub(
      log,
      'mission-mismatch',
      '00000000-0000-4000-8000-000000000044',
    );
    let adoptionAttempts = 0;
    const { controller, emit } = harness({
      log,
      handle,
      agentMissionSessions: [mission],
      agentMissionRuntime: {
        adopt: () => {
          adoptionAttempts += 1;
          return true;
        },
        invalidateContext: () => undefined,
        confirmContext: () => true,
        settleTurn: () => true,
        release: () => true,
      },
    });
    await controller.start();

    emit({ type: 'transport', event: { type: 'state', state: readyState } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(adoptionAttempts).toBe(0);
    expect(log).not.toContain(`publish:${handle}:r1`);
    expect(log).not.toContain('mic:true');
    expect(log.filter((entry) => entry === 'mission-mismatch:dispose')).toHaveLength(1);
    expect(log).toContain('orchestrator:stop');
    expect(log.some((entry) => entry.startsWith('fallback:'))).toBe(false);
  });

  it.each([
    ['refus', (): boolean => false],
    ['exception', (): boolean => {
      throw new Error('provider_disposed');
    }],
  ] as const)(
    'échoue fermé et détruit la capability si le provider répond par %s',
    async (_label, adopt) => {
      const log: string[] = [];
      const realtimeSessionId = '00000000-0000-4000-8000-000000000045';
      const mission = missionSessionStub(log, 'mission-provider-refused', realtimeSessionId);
      const { controller, emit } = harness({
        log,
        handle: realtimeSessionId,
        agentMissionSessions: [mission],
        agentMissionRuntime: {
          adopt,
          invalidateContext: () => undefined,
          confirmContext: () => true,
          settleTurn: () => true,
          release: () => true,
        },
      });
      await controller.start();

      emit({ type: 'transport', event: { type: 'state', state: readyState } });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(log).not.toContain(`publish:${realtimeSessionId}:r1`);
      expect(log).not.toContain('mic:true');
      expect(log.filter((entry) => entry === 'mission-provider-refused:dispose')).toHaveLength(1);
      expect(log).toContain('orchestrator:stop');
      expect(log.some((entry) => entry.startsWith('fallback:'))).toBe(false);
    },
  );

  it('transfère la capability au provider puis confirme contexte et écran avant le micro', async () => {
    const log: string[] = [];
    const realtimeSessionId = '10000000-0000-4000-8000-000000000001';
    const mission = missionSessionStub(log, 'mission-owned', realtimeSessionId);
    const missionRuntime: AgentMissionRuntimeBridge = {
      adopt: (candidate) => {
        log.push(`runtime:adopt:${candidate.realtimeSessionId}`);
        return true;
      },
      invalidateContext: (sessionId) => {
        log.push(`runtime:invalidate:${sessionId}`);
      },
      confirmContext: (sessionId, fence, context) => {
        log.push(
          `runtime:confirm:${sessionId}:r${fence.contextRevision}:${context.screen.name}`,
        );
        return true;
      },
      settleTurn: (sessionId, settlement) => {
        log.push(`runtime:settle:${sessionId}:${settlement.turnId}:${settlement.status}`);
        return true;
      },
      release: (sessionId) => {
        log.push(`runtime:release:${sessionId}`);
        return true;
      },
    };
    const { controller, emit } = harness({
      log,
      handle: realtimeSessionId,
      agentMissionSessions: [mission],
      agentMissionRuntime: missionRuntime,
      updateContextImpl: async (_handle, revision) => ok({
        revision,
        contextDigest: 'a'.repeat(64),
      }),
    });
    await controller.start();

    emit({ type: 'transport', event: { type: 'state', state: readyState } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(log.indexOf('mission:take')).toBeLessThan(
      log.indexOf(`runtime:adopt:${realtimeSessionId}`),
    );
    expect(log.indexOf(`runtime:adopt:${realtimeSessionId}`)).toBeLessThan(
      log.indexOf(`publish:${realtimeSessionId}:r1`),
    );
    expect(log.indexOf(`publish:${realtimeSessionId}:r1`)).toBeLessThan(
      log.indexOf(`runtime:confirm:${realtimeSessionId}:r1:${CONTEXT.screen.name}`),
    );
    expect(log.indexOf(`runtime:confirm:${realtimeSessionId}:r1:${CONTEXT.screen.name}`))
      .toBeLessThan(log.indexOf('mic:true'));

    await controller.stop('user');
    expect(log).not.toContain('mission-owned:dispose');
    expect(log).toContain(`runtime:invalidate:${realtimeSessionId}`);
    expect(log).toContain(`runtime:release:${realtimeSessionId}`);
    expect(log.indexOf(`runtime:release:${realtimeSessionId}`))
      .toBeLessThan(log.indexOf('orchestrator:stop'));
  });

  it.each(['user', 'background', 'unmount'] as const)(
    'libère réellement le runtime sur stop(%s), sans handle dormant avant une reprise froide',
    async (reason) => {
      const log: string[] = [];
      const realtimeSessionId = `14000000-0000-4000-8000-00000000000${
        reason === 'user' ? '1' : reason === 'background' ? '2' : '3'
      }`;
      const owner = new AgentMissionRuntimeOwner();
      const h = harness({
        log,
        handle: realtimeSessionId,
        agentMissionSessions: [
          missionSessionStub(log, `mission-${reason}`, realtimeSessionId),
        ],
        agentMissionRuntime: owner,
        updateContextImpl: async (_handle, revision) => ok({
          revision,
          contextDigest: 'c'.repeat(64),
        }),
      });
      await h.controller.start();
      h.emit({ type: 'transport', event: { type: 'state', state: readyState } });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(owner.snapshot()).toMatchObject({
        protocolVersion: REALTIME_AGENT_MISSION_PROTOCOL_M2A_VERSION,
        realtimeSessionId,
      });
      expect(owner.snapshot().confirmedContext).not.toBeNull();

      await h.controller.stop(reason);

      expect(owner.snapshot()).toMatchObject({
        protocolVersion: null,
        realtimeSessionId: null,
        confirmedContext: null,
      });
      expect(log).toContain(`mission-${reason}:dispose`);
      expect(log.indexOf(`mission-${reason}:dispose`))
        .toBeLessThan(log.indexOf('orchestrator:stop'));
    },
  );

  it('échoue fermé sans ouvrir le micro si le provider perd la propriété avant confirmation', async () => {
    const log: string[] = [];
    const realtimeSessionId = '10000000-0000-4000-8000-000000000002';
    const mission = missionSessionStub(log, 'mission-lost', realtimeSessionId);
    const { controller, emit } = harness({
      log,
      handle: realtimeSessionId,
      agentMissionSessions: [mission],
      agentMissionRuntime: {
        adopt: () => true,
        invalidateContext: () => undefined,
        confirmContext: () => false,
        settleTurn: () => false,
        release: () => true,
      },
      updateContextImpl: async (_handle, revision) => ok({
        revision,
        contextDigest: 'b'.repeat(64),
      }),
    });
    await controller.start();

    emit({ type: 'transport', event: { type: 'state', state: readyState } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(log).not.toContain('mic:true');
    expect(log).toContain('orchestrator:stop');
    expect(log.some((entry) => entry.startsWith('fallback:'))).toBe(false);
    expect(mission.disposed).toBe(false);
  });

  it('interdit le repli legacy demandé après adoption d’une capability Mission', async () => {
    const log: string[] = [];
    const realtimeSessionId = '10000000-0000-4000-8000-000000000099';
    const h = harness({
      log,
      handle: realtimeSessionId,
      agentMissionSessions: [
        missionSessionStub(log, 'mission-no-legacy-fallback', realtimeSessionId),
      ],
      agentMissionRuntime: {
        adopt: () => true,
        invalidateContext: () => undefined,
        confirmContext: () => true,
        settleTurn: () => true,
        release: () => true,
      },
    });
    await h.controller.start();
    h.emit({ type: 'transport', event: { type: 'state', state: readyState } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.log).toContain('mic:true');
    h.log.length = 0;

    h.emit({
      type: 'transport',
      event: { type: 'fallback', reason: 'provider_error' },
    });
    await Promise.resolve();
    await h.external.fallback?.start({
      reason: 'provider_error',
      channel: 'voice',
    });

    expect(h.controller.active).toBe(false);
    expect(h.log.some((entry) => entry.startsWith('fallback:'))).toBe(false);
    expect(h.log).toContain('failed-closed:provider_error');
  });

  it('détruit l ancienne capability avant d adopter puis de réclamer le peer reconnecté', async () => {
    const log: string[] = [];
    const firstSessionId = '10000000-0000-4000-8000-000000000003';
    const freshSessionId = '10000000-0000-4000-8000-000000000004';
    const firstMission = missionSessionStub(log, 'mission-old', firstSessionId);
    const freshMission = missionSessionStub(log, 'mission-fresh', freshSessionId);
    const h = harness({
      log,
      handle: firstSessionId,
      agentMissionSessions: [firstMission, freshMission],
    });
    await h.controller.start();
    h.emit({ type: 'transport', event: { type: 'state', state: readyState } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    h.external.reconnect?.('fresh', freshSessionId);

    expect(log.indexOf('mission-old:dispose')).toBeLessThan(log.indexOf('fresh:mic:false'));
    expect(log).not.toContain('fresh:mission:take');
    h.emit({ type: 'transport', event: { type: 'state', state: readyState } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(log).toContain('fresh:mission:take');

    await h.controller.stop('user');
    expect(log.filter((entry) => entry === 'mission-old:dispose')).toHaveLength(1);
    expect(log.filter((entry) => entry === 'mission-fresh:dispose')).toHaveLength(1);
  });

  it('conserve l’autorité Mission si le peer reconnecté demande un fallback avant ready', async () => {
    const log: string[] = [];
    const firstSessionId = '10000000-0000-4000-8000-000000000071';
    const h = harness({
      log,
      handle: firstSessionId,
      agentMissionSessions: [
        missionSessionStub(log, 'mission-reconnect-fallback', firstSessionId),
        null,
      ],
      agentMissionRuntime: {
        adopt: () => true,
        invalidateContext: () => undefined,
        confirmContext: () => true,
        settleTurn: () => true,
        release: () => true,
      },
    });
    await h.controller.start();
    h.emit({ type: 'transport', event: { type: 'state', state: readyState } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.log).toContain('mic:true');
    h.log.length = 0;

    h.external.reconnect?.(
      'fresh',
      '10000000-0000-4000-8000-000000000072',
    );
    await h.external.fallback?.start({
      reason: 'provider_error',
      channel: 'voice',
    });

    expect(h.log).toContain('failed-closed:provider_error');
    expect(h.log.some((entry) => entry.startsWith('fallback:'))).toBe(false);
    expect(h.log).not.toContain('fresh:mic:true');
    expect(h.controller.active).toBe(false);
  });

  it('refuse de rouvrir le micro si le peer reconnecté ne rend pas la capability Mission', async () => {
    const log: string[] = [];
    const firstSessionId = '10000000-0000-4000-8000-000000000081';
    const h = harness({
      log,
      handle: firstSessionId,
      agentMissionSessions: [
        missionSessionStub(log, 'mission-reconnect-missing', firstSessionId),
        null,
      ],
      agentMissionRuntime: {
        adopt: () => true,
        invalidateContext: () => undefined,
        confirmContext: () => true,
        settleTurn: () => true,
        release: () => true,
      },
    });
    await h.controller.start();
    h.emit({ type: 'transport', event: { type: 'state', state: readyState } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.log.length = 0;

    h.external.reconnect?.(
      'fresh',
      '10000000-0000-4000-8000-000000000082',
    );
    h.emit({ type: 'transport', event: { type: 'state', state: readyState } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.log).toContain('fresh:mission:take');
    expect(h.log).not.toContain('fresh:mic:true');
    expect(h.log.some((entry) => entry.startsWith('fallback:'))).toBe(false);
    expect(h.log).toContain('failed-closed:provider_error');
    expect(h.log).toContain('orchestrator:stop');
    expect(h.controller.active).toBe(false);
  });

  it('attend le vrai foreground avant le micro Realtime', async () => {
    let allow!: (value: boolean) => void;
    const permissionLifecycle = new Promise<boolean>((resolve) => { allow = resolve; });
    const { controller, log, emit } = harness({
      allowMicrophoneActivation: () => permissionLifecycle,
    });
    await controller.start();
    emit({ type: 'transport', event: { type: 'state', state: readyState } });
    await Promise.resolve();
    expect(log).toContain('publish:h-42:r1');
    expect(log).not.toContain('mic:true');

    allow(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(log).toContain('mic:true');
  });

  it('ferme sans fallback audio si l’app reste en background après la permission', async () => {
    const { controller, log, emit } = harness({
      allowMicrophoneActivation: async () => false,
    });
    await controller.start();
    emit({ type: 'transport', event: { type: 'state', state: readyState } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(log).not.toContain('mic:true');
    expect(log).toContain('orchestrator:stop');
    expect(log.some((entry) => entry.startsWith('fallback:'))).toBe(false);
    expect(controller.active).toBe(false);
  });

  it('handle indisponible sous protocole V2 → FAIL-CLOSED, jamais de cerveau legacy', async () => {
    const { controller, log, emit } = harness({ handle: null });
    await controller.start();
    emit({ type: 'transport', event: { type: 'state', state: readyState } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(log.some((entry) => entry.startsWith('publish:'))).toBe(false);
    expect(log).not.toContain('mic:true');
    expect(log).toContain('orchestrator:stop');
    expect(log.some((entry) => entry.startsWith('fallback:'))).toBe(false);
    expect(log).toContain('failed-closed:provider_error');
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
    expect(log).toContain('review:p-9:none');
  });

  it('gate rejette (fence périmée/serveur non) → AUCUN effet ; route hostile ACKée → ignorée', async () => {
    const rejected = harness({ gateRejects: true });
    await rejected.controller.start();
    rejected.emit({ type: 'transport', event: { type: 'state', state: readyState } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    rejected.emit(candidate('t'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      rejected.log.some((entry) => entry.startsWith('review:') || entry.startsWith('nav:')),
    ).toBe(false);

    const hostile = harness({ gateKind: 'answer', gateNavigate: 'https://evil' });
    await hostile.controller.start();
    hostile.emit({ type: 'transport', event: { type: 'state', state: readyState } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    hostile.emit(candidate('t2'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hostile.log.some((entry) => entry.startsWith('nav:'))).toBe(false);
  });

  it('changement d’écran : micro OFF → interrupt → PUT → micro ON ; échec V2 → stop fail-closed', async () => {
    const okCase = harness();
    await okCase.controller.start();
    okCase.emit({ type: 'transport', event: { type: 'state', state: readyState } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    okCase.log.length = 0;
    await okCase.controller.publishContext();
    expect(okCase.log.slice(0, 3)).toEqual([
      'mic:false',
      'interrupt:navigation',
      'publish:h-42:r2',
    ]);
    expect(okCase.log).toContain('mic:true');

    const failing = harness({ putFails: true });
    await failing.controller.start();
    // Publication initiale en échec sous V2 : jamais de cerveau historique de secours.
    failing.emit({ type: 'transport', event: { type: 'state', state: readyState } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(failing.log).toContain('orchestrator:stop');
    expect(failing.log.some((entry) => entry.startsWith('fallback:'))).toBe(false);
    expect(failing.log).toContain('failed-closed:provider_error');
    expect(failing.log).not.toContain('mic:true');
  });

  it('attend la fence WSS après le PUT et échoue fermé avant le micro si elle est refusée', async () => {
    const synchronized = harness({ synchronizeContext: async () => true });
    await synchronized.controller.start();
    synchronized.emit({ type: 'transport', event: { type: 'state', state: readyState } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(synchronized.log.indexOf('publish:h-42:r1')).toBeLessThan(
      synchronized.log.indexOf('sync:r1'),
    );
    expect(synchronized.log.indexOf('sync:r1')).toBeLessThan(
      synchronized.log.indexOf('mic:true'),
    );

    const refused = harness({ synchronizeContext: async () => false });
    await refused.controller.start();
    refused.emit({ type: 'transport', event: { type: 'state', state: readyState } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(refused.log).toContain('sync:r1');
    expect(refused.log).not.toContain('mic:true');
    expect(refused.log).toContain('orchestrator:stop');
    expect(refused.log.some((entry) => entry.startsWith('fallback:'))).toBe(false);
    expect(refused.log).toContain('failed-closed:provider_error');
  });

  it('commit semi-duplex : finalise l’utterance sans stopper puis passe en traitement', async () => {
    const h = harness({ emitCommitOnFinish: true });
    await h.controller.start();
    h.emit({ type: 'transport', event: { type: 'state', state: readyState } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.log.length = 0;

    await expect(h.controller.finishUserInput()).resolves.toBe(true);
    h.emit({ type: 'transport', event: { type: 'state', state: readyState } });
    await Promise.resolve();

    expect(h.log).toEqual(['finish-input', 'phase:listening', 'phase:thinking']);
    expect(h.log).not.toContain('orchestrator:stop');
  });

  it('passe en traitement sur le commit VAD autoritatif sans action manuelle', async () => {
    const h = harness();
    await h.controller.start();
    h.emit({ type: 'transport', event: { type: 'state', state: readyState } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.log.length = 0;

    h.emit({
      type: 'transport',
      event: {
        type: 'state',
        state: { ...readyState, phase: 'user_speaking' },
      },
    });
    h.emit({ type: 'transport', event: { type: 'state', state: readyState } });
    h.emit({
      type: 'transport',
      event: { type: 'user_input_committed', turnId: 'vad-turn' },
    });
    h.emit({ type: 'transport', event: { type: 'state', state: readyState } });
    await Promise.resolve();

    expect(h.log).toEqual([
      'phase:listening',
      'phase:listening',
      'phase:thinking',
    ]);

    h.emit({
      type: 'transport',
      event: { type: 'state', state: { ...readyState, phase: 'bob_speaking' } },
    });
    h.emit({ type: 'transport', event: { type: 'state', state: readyState } });
    await Promise.resolve();
    expect(h.log.slice(-2)).toEqual(['phase:speaking', 'phase:listening']);
  });

  it('fin one-shot : ferme avant la proposition et ne republie jamais sur le ticket terminal', async () => {
    const h = harness({ completionMode: 'one-shot' });
    await h.controller.start();
    h.emit({ type: 'transport', event: { type: 'state', state: readyState } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.log.length = 0;

    h.emit(candidate('terminal-turn'));
    h.emit({ type: 'transport', event: { type: 'conversation_completed' } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const ackIndex = h.log.indexOf('ack:terminal-turn:fence-r1');
    const closeIndex = h.log.indexOf('gate:close');
    const stopIndex = h.log.indexOf('orchestrator:stop');
    const completedIndex = h.log.indexOf('completed');
    const reviewIndex = h.log.indexOf('review:p-9:none');
    expect(ackIndex).toBeGreaterThanOrEqual(0);
    expect(closeIndex).toBeGreaterThan(ackIndex);
    expect(stopIndex).toBeGreaterThan(closeIndex);
    expect(reviewIndex).toBeGreaterThan(stopIndex);
    expect(completedIndex).toBeGreaterThan(reviewIndex);
    expect(h.log.some((entry) => entry.startsWith('fallback:'))).toBe(false);
  });

  it('controle continu : applique la navigation immediatement sans attendre une completion', async () => {
    const realtimeSessionId = '10000000-0000-4000-8000-000000000005';
    const log: string[] = [];
    const h = harness({
      log,
      handle: realtimeSessionId,
      agentMissionSessions: [missionSessionStub(log, 'mission-navigation', realtimeSessionId)],
      agentMissionRuntime: {
        adopt: () => true,
        invalidateContext: (sessionId) => log.push(`runtime:invalidate:${sessionId}`),
        confirmContext: () => true,
        settleTurn: () => true,
        release: () => true,
      },
      gateKind: 'answer',
      gateNavigate: '/cloture',
      completionMode: 'continuous',
    });
    await h.controller.start();
    h.emit({ type: 'transport', event: { type: 'state', state: readyState } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.log.length = 0;

    h.emit(candidate('continuous-turn'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const microphoneClosed = h.log.indexOf('mic:false');
    const contextInvalidated = h.log.indexOf(`runtime:invalidate:${realtimeSessionId}`);
    const navigated = h.log.indexOf('nav:/cloture');
    expect(microphoneClosed).toBeGreaterThanOrEqual(0);
    expect(contextInvalidated).toBeGreaterThan(microphoneClosed);
    expect(navigated).toBeGreaterThan(contextInvalidated);
    expect(h.log).not.toContain('orchestrator:stop');
    expect(h.log).not.toContain('completed');
  });

  it('attend l’ACK de contrôle du même tour avant de publier son terminal à la mission', async () => {
    let releaseGate!: () => void;
    const gateDelay = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const realtimeSessionId = '11000000-0000-4000-8000-000000000001';
    const turnId = '11000000-0000-4000-8000-000000000002';
    const log: string[] = [];
    const h = harness({
      log,
      handle: realtimeSessionId,
      gateDelay,
      agentMissionSessions: [missionSessionStub(log, 'mission-settlement', realtimeSessionId)],
      agentMissionRuntime: {
        adopt: () => true,
        invalidateContext: () => undefined,
        confirmContext: () => true,
        settleTurn: (sessionId, settlement) => {
          log.push(`runtime:settle:${sessionId}:${settlement.turnId}:${settlement.status}`);
          return true;
        },
        release: () => true,
      },
    });
    await h.controller.start();
    h.emit({ type: 'transport', event: { type: 'state', state: readyState } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.log.length = 0;

    h.emit(candidate(turnId));
    h.emit({
      type: 'transport',
      event: { type: 'turn_settled', turnId, status: 'done' },
    });
    await Promise.resolve();
    expect(h.log.some((entry) => entry.startsWith('runtime:settle:'))).toBe(false);

    releaseGate();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const ackIndex = h.log.indexOf(`ack:${turnId}:fence-r1`);
    const settlementIndex = h.log.indexOf(
      `runtime:settle:${realtimeSessionId}:${turnId}:done`,
    );
    expect(ackIndex).toBeGreaterThanOrEqual(0);
    expect(settlementIndex).toBeGreaterThan(ackIndex);
  });

  it('refuse de solder la mission si le contrôle annoncé ne peut pas être relu', async () => {
    const realtimeSessionId = '11000000-0000-4000-8000-000000000011';
    const turnId = '11000000-0000-4000-8000-000000000012';
    const log: string[] = [];
    const h = harness({
      log,
      handle: realtimeSessionId,
      gateRejects: true,
      agentMissionSessions: [missionSessionStub(log, 'mission-control-lost', realtimeSessionId)],
      agentMissionRuntime: {
        adopt: () => true,
        invalidateContext: () => undefined,
        confirmContext: () => true,
        settleTurn: (_sessionId, settlement) => {
          log.push(`runtime:settle:${settlement.turnId}`);
          return true;
        },
        release: () => true,
      },
    });
    await h.controller.start();
    h.emit({ type: 'transport', event: { type: 'state', state: readyState } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.log.length = 0;

    h.emit(candidate(turnId));
    h.emit({
      type: 'transport',
      event: { type: 'turn_settled', turnId, status: 'done' },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.log).toContain(`ack:${turnId}:fence-r1`);
    expect(h.log).not.toContain(`runtime:settle:${turnId}`);
    expect(h.log).toContain('orchestrator:stop');
    expect(h.log.some((entry) => entry.startsWith('nav:'))).toBe(false);
    expect(h.log.some((entry) => entry.startsWith('fallback:'))).toBe(false);
  });

  it('applique une navigation rejouée du même tour exactement une fois', async () => {
    const h = harness({
      gateKind: 'answer',
      gateNavigate: '/devis/new',
      completionMode: 'continuous',
    });
    await h.controller.start();
    h.emit({ type: 'transport', event: { type: 'state', state: readyState } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.log.length = 0;

    h.emit(candidate('control-replay-turn'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.emit(candidate('control-replay-turn'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.log.filter((entry) => entry === 'nav:/devis/new')).toHaveLength(1);
    expect(h.log.filter((entry) => entry.startsWith('ack:control-replay-turn:')))
      .toHaveLength(1);
  });

  it('suspend le micro, attend le terminal exact puis libère avant le stop manuel', async () => {
    const realtimeSessionId = '12000000-0000-4000-8000-000000000001';
    const turnId = '12000000-0000-4000-8000-000000000002';
    const log: string[] = [];
    const h = harness({
      log,
      handle: realtimeSessionId,
      agentMissionSessions: [
        missionSessionStub(log, 'mission-manual-handoff', realtimeSessionId),
      ],
      agentMissionRuntime: {
        adopt: () => true,
        invalidateContext: () => undefined,
        confirmContext: () => true,
        settleTurn: (_sessionId, settlement) => {
          log.push(`runtime:settle:${settlement.turnId}:${settlement.status}`);
          return true;
        },
        release: (sessionId) => {
          log.push(`runtime:release:${sessionId}`);
          return true;
        },
      },
    });
    await h.controller.start();
    h.emit({ type: 'transport', event: { type: 'state', state: readyState } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.emit({
      type: 'transport',
      event: { type: 'user_input_committed', turnId },
    });
    log.length = 0;

    const suspended = h.controller.suspendForManualHandoff();
    await Promise.resolve();
    let didSuspend = false;
    void suspended.then(() => {
      didSuspend = true;
    });
    expect(log.slice(0, 2)).toEqual(['mic:false', 'interrupt:tap']);
    expect(didSuspend).toBe(false);

    h.emit({
      type: 'transport',
      event: { type: 'turn_settled', turnId, status: 'cancelled' },
    });
    await expect(suspended).resolves.toBe(true);
    expect(log).toContain(`runtime:settle:${turnId}:cancelled`);

    await h.controller.stopAfterManualHandoff();
    expect(log.indexOf(`runtime:release:${realtimeSessionId}`))
      .toBeLessThan(log.indexOf('orchestrator:stop'));
  });

  it('refuse d’acquitter la passation si la capability ne peut pas être libérée', async () => {
    const realtimeSessionId = '13000000-0000-4000-8000-000000000001';
    const log: string[] = [];
    const h = harness({
      log,
      handle: realtimeSessionId,
      agentMissionSessions: [
        missionSessionStub(log, 'mission-release-refused', realtimeSessionId),
      ],
      agentMissionRuntime: {
        adopt: () => true,
        invalidateContext: () => undefined,
        confirmContext: () => true,
        settleTurn: () => true,
        release: () => false,
      },
    });
    await h.controller.start();
    h.emit({ type: 'transport', event: { type: 'state', state: readyState } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(h.controller.stopAfterManualHandoff())
      .rejects.toThrow('agent_mission_release_failed');
    expect(log).toContain('orchestrator:stop');
  });

  it('un stop lifecycle ferme et notifie une seule fois sans rejection non gérée si release refuse', async () => {
    const realtimeSessionId = '13000000-0000-4000-8000-000000000002';
    const log: string[] = [];
    const h = harness({
      log,
      handle: realtimeSessionId,
      agentMissionSessions: [
        missionSessionStub(log, 'mission-lifecycle-release-refused', realtimeSessionId),
      ],
      agentMissionRuntime: {
        adopt: () => true,
        invalidateContext: () => undefined,
        confirmContext: () => true,
        settleTurn: () => true,
        release: () => false,
      },
    });
    await h.controller.start();
    h.emit({ type: 'transport', event: { type: 'state', state: readyState } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(h.controller.stop('background')).resolves.toBeUndefined();

    expect(log).toContain('orchestrator:stop');
    expect(log.filter(
      (entry) => entry === 'failed-closed:agent_mission_negotiation_failed',
    )).toHaveLength(1);
    expect(h.controller.active).toBe(false);

    const negotiationsBeforeRestart = h.external.negotiations;
    log.length = 0;
    await expect(h.controller.start()).resolves.toBe('failed_closed');
    expect(h.external.negotiations).toBe(negotiationsBeforeRestart);
    expect(log.some((entry) => entry.startsWith('mic:'))).toBe(false);
    expect(log.some((entry) => entry.startsWith('fallback:'))).toBe(false);
    expect(log).not.toContain('orchestrator:stop');
  });

  it('stop pendant ACK one-shot efface la decision terminale sans aucun effet UI tardif', async () => {
    let releaseGate!: () => void;
    const gateDelay = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const h = harness({ gateDelay, completionMode: 'one-shot' });
    await h.controller.start();
    h.emit({ type: 'transport', event: { type: 'state', state: readyState } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.log.length = 0;

    h.emit(candidate('terminal-old'));
    h.emit({ type: 'transport', event: { type: 'conversation_completed' } });
    await Promise.resolve();
    await h.controller.stop('user');
    releaseGate();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.log.some((entry) => entry.startsWith('review:') || entry.startsWith('nav:'))).toBe(
      false,
    );
    expect(h.log).not.toContain('completed');
  });

  it('fence un ACK tardif d’une ancienne mission même si une nouvelle session est active', async () => {
    let releaseGate!: () => void;
    const gateDelay = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const h = harness({
      gateDelay,
      negotiation: NATIVE_WEBRTC_NEGOTIATION,
    });
    await h.controller.start();
    h.emit({ type: 'transport', event: { type: 'state', state: readyState } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    h.emit(candidate('old-turn'));
    h.emit({ type: 'transport', event: { type: 'conversation_completed' } });
    await Promise.resolve();
    await h.controller.stop();
    await h.controller.start();
    h.emit({ type: 'transport', event: { type: 'state', state: readyState } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.log.length = 0;

    releaseGate();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.log.some((entry) => entry.startsWith('review:') || entry.startsWith('nav:'))).toBe(
      false,
    );
    expect(h.log).not.toContain('completed');
    expect(h.log).not.toContain('orchestrator:stop');
    expect(h.controller.active).toBe(true);
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
    let deferredA:
      ((v: { ok: true; value: { revision: number; contextDigest: string } }) => void) | null = null;
    const h = harness({
      updateContextImpl: (_handle, revision) => {
        call += 1;
        if (call === 1) {
          // Publication de BOOTSTRAP (r1) : immédiate — le micro s'ouvre normalement.
          return Promise.resolve({
            ok: true as const,
            value: { revision, contextDigest: `d-${revision}` },
          });
        }
        if (call === 2) {
          // Navigation A (r2) : PUT lent, sera doublé par B.
          return new Promise((resolve) => {
            deferredA = (v) => resolve(v);
          });
        }
        // Navigation B (r3) : résout D'ABORD, puis on relâche A (course réelle du terrain).
        setTimeout(
          () => deferredA?.({ ok: true, value: { revision: 2, contextDigest: 'd-2' } }),
          0,
        );
        return Promise.resolve({
          ok: true as const,
          value: { revision, contextDigest: `d-${revision}` },
        });
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

  it('reconnexion pendant le PUT initial : le succès ancien ne rouvre jamais l’ancien micro', async () => {
    let releaseInitial!: () => void;
    let calls = 0;
    const h = harness({
      updateContextImpl: (_handle, revision) => {
        calls += 1;
        if (calls === 1) {
          return new Promise((resolve) => {
            releaseInitial = () => resolve(ok({ revision, contextDigest: `d-${revision}` }));
          });
        }
        return Promise.resolve(ok({ revision, contextDigest: `d-${revision}` }));
      },
    });
    await h.controller.start();
    h.emit({ type: 'transport', event: { type: 'state', state: readyState } });
    await Promise.resolve();

    h.external.reconnect?.('fresh', 'h-fresh');
    releaseInitial();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.log).not.toContain('mic:true');
    expect(h.log).not.toContain('orchestrator:stop');
    expect(h.controller.active).toBe(true);

    h.emit({ type: 'transport', event: { type: 'state', state: readyState } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.log).toContain('publish:h-fresh:r1');
    expect(h.log).toContain('fresh:mic:true');
  });

  it('reconnexion pendant une navigation : l’échec ancien ne stoppe pas le nouveau transport', async () => {
    let rejectNavigation!: () => void;
    let calls = 0;
    const h = harness({
      updateContextImpl: (_handle, revision) => {
        calls += 1;
        if (calls === 2) {
          return new Promise((resolve) => {
            rejectNavigation = () =>
              resolve({
                ok: false as const,
                error: { kind: 'dependency' as const, port: 'realtime', cause: 'old-offline' },
              });
          });
        }
        return Promise.resolve(ok({ revision, contextDigest: `d-${revision}` }));
      },
    });
    await h.controller.start();
    h.emit({ type: 'transport', event: { type: 'state', state: readyState } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.log.length = 0;

    const oldNavigation = h.controller.publishContext();
    await Promise.resolve();
    h.external.reconnect?.('fresh', 'h-fresh');
    rejectNavigation();
    await oldNavigation;

    expect(h.log).not.toContain('orchestrator:stop');
    expect(h.log.some((entry) => entry.startsWith('fallback:'))).toBe(false);
    expect(h.controller.active).toBe(true);

    h.emit({ type: 'transport', event: { type: 'state', state: readyState } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.log).toContain('fresh:mic:true');
  });

  it('ACK et completion d’un ancien primaire restent sans effet après reconnexion', async () => {
    let releaseGate!: () => void;
    const gateDelay = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const h = harness({ gateDelay, completionMode: 'one-shot' });
    await h.controller.start();
    h.emit({ type: 'transport', event: { type: 'state', state: readyState } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.log.length = 0;

    h.emit(candidate('old-primary-turn'));
    h.emit({ type: 'transport', event: { type: 'conversation_completed' } });
    await Promise.resolve();
    h.external.reconnect?.('fresh', 'h-fresh');
    h.emit({ type: 'transport', event: { type: 'state', state: readyState } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    releaseGate();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.log).toContain('fresh:mic:true');
    expect(h.log.some((entry) => entry.startsWith('review:') || entry.startsWith('nav:'))).toBe(
      false,
    );
    expect(h.log).not.toContain('completed');
    expect(h.log).not.toContain('orchestrator:stop');
    expect(h.controller.active).toBe(true);
  });

  it('repli pendant le bootstrap (orchestrateur → legacy) : outcome=fallback, pas de double boucle', async () => {
    const { controller, log, external } = harness({
      deferStart: true,
      negotiation: NATIVE_WEBRTC_NEGOTIATION,
    });
    const pending = controller.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // L'orchestrateur épuise ses retries et active le repli AVANT de résoudre start().
    await external.fallback?.start({ reason: 'bootstrap_failed', channel: 'voice' });
    external.resolveStart?.('legacy');
    expect(await pending).toBe('fallback'); // l'appelant SAIT que onFallback a déjà relancé legacy
    expect(log).toContain('fallback:bootstrap_failed:voice');
    expect(log).not.toContain('mic:true');
  });

  it('bootstrap V2 audité en échec reste fail-closed avant même la prise de capability', async () => {
    const { controller, log, external } = harness({
      deferStart: true,
      agentMissionSessions: [null],
    });
    const pending = controller.start();
    await new Promise((resolve) => setTimeout(resolve, 0));

    await external.fallback?.start({ reason: 'bootstrap_failed', channel: 'voice' });
    external.resolveStart?.('legacy');

    await expect(pending).resolves.toBe('failed_closed');
    expect(log).toContain('failed-closed:bootstrap_failed');
    expect(log.some((entry) => entry.startsWith('fallback:'))).toBe(false);
    expect(log).not.toContain('mic:true');
  });

  it('transmet le canal text_only après refus micro, sans le transformer en repli vocal', async () => {
    const { controller, log, external } = harness({
      deferStart: true,
      negotiation: NATIVE_WEBRTC_NEGOTIATION,
    });
    const pending = controller.start();
    await new Promise((resolve) => setTimeout(resolve, 0));

    await external.fallback?.start({ reason: 'microphone_denied', channel: 'text_only' });
    external.resolveStart?.('legacy');

    expect(await pending).toBe('fallback');
    expect(log).toContain('fallback:microphone_denied:text_only');
    expect(log).not.toContain('mic:true');
  });

  it('redémarrage après un repli mid-call : start() repart d’un monde PROPRE (jamais un zombie)', async () => {
    const { controller, log, emit, external } = harness({
      negotiation: NATIVE_WEBRTC_NEGOTIATION,
    });
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
