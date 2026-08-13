import { describe, expect, it } from 'vitest';
import type { AgentContext } from '@bob/ai';
import {
  REALTIME_AGENT_MISSION_PROTOCOL_M2A_VERSION,
  REALTIME_AGENT_MISSION_PROTOCOL_VERSION,
} from '@bob/api-client';
import {
  AgentRealtimeControllerRegistry,
  agentContextSemanticKey,
  classifyAgentRealtimeControllerAcquisition,
  closeAgentRealtimeController,
  composeHandoffSpeech,
  planAgentSessionFallback,
  planAgentSessionFailedClosed,
  revalidateAgentSessionBackgroundAfterPermission,
  realtimeGenericReconnectBudget,
  realtimeOwnsAgentSession,
  settleAgentSessionRealtimeBootstrap,
  shouldRecoverLegacyListeningSilence,
  shouldStopAgentSessionForAppState,
  type AgentSessionDriver,
} from './agent-session-runtime';

const context = (): AgentContext => ({
  screen: { name: 'recherche', instanceId: 'search:plombier' },
  entities: [
    { type: 'customer', id: 'c-1', label: 'Camping Les Pins' },
    { type: 'quote', id: 'q-1', label: 'D-2026-001' },
  ],
  capabilities: ['screen.read', 'search.read'],
});

describe('agent session runtime fences', () => {
  it('classe une acquisition A périmée comme inerte sans repeindre B', () => {
    expect(classifyAgentRealtimeControllerAcquisition({
      generation: 1,
      currentGeneration: 2,
      active: true,
      driver: 'live_bootstrap',
      appState: 'active',
      controller: null,
    })).toEqual({ kind: 'superseded' });
    expect(classifyAgentRealtimeControllerAcquisition({
      generation: 2,
      currentGeneration: 2,
      active: true,
      driver: 'live_bootstrap',
      appState: 'active',
      controller: 'B',
    })).toEqual({ kind: 'owned', controller: 'B' });
  });

  it('sérialise fermeture A, relit la cible et crée une seule autorité fraîche', async () => {
    const registry = new AgentRealtimeControllerRegistry<string, object, string>();
    const clientA = {};
    const clientB = {};
    const clientC = {};
    let desired = { client: clientA, checkpoint: null as string | null };
    let created = 0;
    const create = () => `controller-${++created}`;
    await expect(registry.acquire({
      readDesired: () => desired,
      create,
      closeStale: async () => 'closed',
    })).resolves.toBe('controller-1');

    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
    desired = { client: clientB, checkpoint: null };
    const first = registry.acquire({
      readDesired: () => desired,
      create,
      closeStale: async () => { await closeGate; return 'closed'; },
    });
    desired = { client: clientC, checkpoint: null };
    const second = registry.acquire({
      readDesired: () => desired,
      create,
      closeStale: async () => 'closed',
    });
    releaseClose();

    await expect(Promise.all([first, second])).resolves.toEqual([
      'controller-2',
      'controller-2',
    ]);
    expect(created).toBe(2);
    expect(registry.peek()).toBe('controller-2');
  });

  it('conserve le même controller tant que sa fermeture reste non confirmée', async () => {
    const registry = new AgentRealtimeControllerRegistry<string, object, string>();
    const clientA = {};
    const clientB = {};
    let desired = { client: clientA, checkpoint: null as string | null };
    let created = 0;
    const create = () => `controller-${++created}`;
    await registry.acquire({
      readDesired: () => desired,
      create,
      closeStale: async () => 'closed',
    });
    desired = { client: clientB, checkpoint: null };
    await expect(registry.acquire({
      readDesired: () => desired,
      create,
      closeStale: async () => 'unconfirmed',
    })).resolves.toBeNull();
    expect(registry.peek()).toBeNull();
    expect(created).toBe(1);

    await expect(registry.acquire({
      readDesired: () => desired,
      create,
      closeStale: async () => 'closed',
    })).resolves.toBe('controller-2');
    expect(created).toBe(2);
  });

  it('ne réutilise jamais un controller fermé de manière incertaine quand la cible est inchangée', async () => {
    const registry = new AgentRealtimeControllerRegistry<string, object, string>();
    const client = {};
    const desired = { client, checkpoint: null as string | null };
    let created = 0;
    let closeAttempts = 0;
    const create = () => `controller-${++created}`;
    const first = await registry.acquire({
      readDesired: () => desired,
      create,
      closeStale: async () => 'closed',
    });
    expect(first).toBe('controller-1');

    await expect(registry.close(async () => {
      closeAttempts += 1;
      return 'unconfirmed';
    })).resolves.toBe('unconfirmed');

    await expect(registry.acquire({
      readDesired: () => desired,
      create,
      closeStale: async (controller) => {
        closeAttempts += 1;
        expect(controller).toBe('controller-1');
        return 'closed';
      },
    })).resolves.toBe('controller-2');
    expect({ closeAttempts, created }).toEqual({ closeAttempts: 2, created: 2 });
  });

  it('désarme immédiatement le lease UI pendant une fermeture encore en vol', async () => {
    const registry = new AgentRealtimeControllerRegistry<string, object, string>();
    const client = {};
    const leaseCurrent: { current: (() => boolean) | null } = { current: null };
    await registry.acquire({
      readDesired: () => ({ client, checkpoint: null as string | null }),
      create: (lease) => {
        leaseCurrent.current = lease.isCurrent;
        return 'controller';
      },
      closeStale: async () => 'closed',
    });
    expect(leaseCurrent.current?.()).toBe(true);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const closing = registry.close(async () => {
      expect(leaseCurrent.current?.()).toBe(false);
      await gate;
      return 'unconfirmed';
    });
    expect(leaseCurrent.current?.()).toBe(false);
    release();
    await expect(closing).resolves.toBe('unconfirmed');
    expect(leaseCurrent.current?.()).toBe(false);
  });

  it('ignore le checkpoint tardif d’un lease remplacé', async () => {
    const registry = new AgentRealtimeControllerRegistry<string, object, string>();
    const clientA = {};
    const clientB = {};
    let desired = { client: clientA, checkpoint: 'a' as string | null };
    const staleRecord: { current: ((checkpoint: string | null) => void) | null } = {
      current: null,
    };
    await registry.acquire({
      readDesired: () => desired,
      create: (lease) => {
        staleRecord.current = lease.recordCheckpointUsed;
        return 'A';
      },
      closeStale: async () => 'closed',
    });
    desired = { client: clientB, checkpoint: 'b' };
    await registry.acquire({
      readDesired: () => desired,
      create: (lease) => {
        lease.recordCheckpointUsed('b');
        return 'B';
      },
      closeStale: async () => 'closed',
    });
    staleRecord.current?.('poison');
    expect(registry.hasMismatch(desired)).toBe(false);
    expect(registry.peek()).toBe('B');
  });

  it('conserve le checkpoint consommé synchroniquement pendant la construction', async () => {
    const registry = new AgentRealtimeControllerRegistry<string, object, string>();
    const client = {};
    let desired = { client, checkpoint: 'a' as string | null };
    let created = 0;
    await registry.acquire({
      readDesired: () => desired,
      create: (lease) => {
        lease.recordCheckpointUsed('a');
        return `controller-${++created}`;
      },
      closeStale: async () => 'closed',
    });
    desired = { client, checkpoint: 'b' };
    expect(registry.hasMismatch(desired)).toBe(true);
    await expect(registry.acquire({
      readDesired: () => desired,
      create: () => `controller-${++created}`,
      closeStale: async () => 'closed',
    })).resolves.toBe('controller-2');
  });

  it('rejoue une fermeture incertaine une fois sur la même autorité', async () => {
    const calls: string[] = [];
    const controller = {
      stop: async () => {
        calls.push('stop');
        return calls.length === 1
          ? { status: 'unconfirmed', missionReleased: true, transportClosed: false } as const
          : { status: 'closed', missionReleased: true, transportClosed: true } as const;
      },
      stopForPolicy: async () => {
        calls.push('policy');
        return { status: 'unconfirmed', missionReleased: true, transportClosed: false } as const;
      },
      stopAfterManualHandoff: async () => undefined,
    };
    await expect(closeAgentRealtimeController({
      controller,
      reason: 'user',
      policyReason: 'entitlement_revoked',
    })).resolves.toBe('closed');
    expect(calls).toEqual(['policy', 'stop']);
  });
  it('ne republie pas un contexte semantiquement identique malgre de nouvelles references', () => {
    expect(agentContextSemanticKey(context())).toBe(agentContextSemanticKey(context()));
  });

  it('republie toute hydratation metier, y compris a instanceId identique', () => {
    const base = context();
    const variants: AgentContext[] = [
      { ...base, screen: { ...base.screen, name: 'clients' } },
      { ...base, entities: [{ ...base.entities[0]!, label: 'Camping des Pins' }, base.entities[1]!] },
      { ...base, entities: [...base.entities].reverse() },
      { ...base, capabilities: ['screen.read'] },
    ];
    for (const variant of variants) {
      expect(agentContextSemanticKey(variant)).not.toBe(agentContextSemanticKey(base));
    }
  });

  it('donne le micro Realtime pendant le bootstrap et ferme seulement au vrai background', () => {
    expect(realtimeOwnsAgentSession('live_bootstrap')).toBe(true);
    expect(realtimeOwnsAgentSession('live')).toBe(true);
    expect(realtimeOwnsAgentSession('legacy')).toBe(false);
    expect(shouldStopAgentSessionForAppState('inactive')).toBe(false);
    expect(shouldStopAgentSessionForAppState('active')).toBe(false);
    expect(shouldStopAgentSessionForAppState('background')).toBe(true);
    expect(shouldStopAgentSessionForAppState('background', true)).toBe(false);
  });

  it('une ouverture A tardive ne peut jamais arrêter la nouvelle session B', async () => {
    let resolveA!: (value: 'cancelled') => void;
    const a = new Promise<'cancelled'>((resolve) => { resolveA = resolve; });
    let generation = 1;
    const active = true;
    const driver: AgentSessionDriver = 'live_bootstrap';
    let stops = 0;
    const settle = (
      ownedGeneration: number,
      start: () => Promise<'cancelled' | 'resumed'>,
    ) => settleAgentSessionRealtimeBootstrap({
      generation: ownedGeneration,
      currentGeneration: () => generation,
      isActive: () => active,
      currentDriver: () => driver,
      currentAppState: () => 'active',
      start,
      stopOwnedController: () => { stops += 1; },
    });

    const staleA = settle(1, () => a);
    generation = 2;
    const currentB = await settle(2, async () => 'resumed');
    expect(currentB).toEqual({ outcome: 'resumed', owned: true });

    resolveA('cancelled');
    await expect(staleA).resolves.toEqual({ outcome: 'cancelled', owned: false });
    expect(stops).toBe(0);
    expect({ generation, active, driver }).toEqual({
      generation: 2,
      active: true,
      driver: 'live_bootstrap',
    });
  });

  it('nettoie encore un bootstrap courant devenu inactif', async () => {
    let stops = 0;
    await expect(settleAgentSessionRealtimeBootstrap({
      generation: 4,
      currentGeneration: () => 4,
      isActive: () => false,
      currentDriver: () => 'live_bootstrap',
      currentAppState: () => 'active',
      start: async () => 'cancelled' as const,
      stopOwnedController: () => { stops += 1; },
    })).resolves.toEqual({ outcome: 'cancelled', owned: false });
    expect(stops).toBe(1);
  });

  it('interdit la reconnexion générique à toute mission M2-A, quel que soit le provider', () => {
    expect(realtimeGenericReconnectBudget(
      REALTIME_AGENT_MISSION_PROTOCOL_M2A_VERSION,
      false,
    )).toBe(0);
    expect(realtimeGenericReconnectBudget(null, true)).toBe(0);

    expect(realtimeGenericReconnectBudget(null, false)).toBe(1);
    expect(realtimeGenericReconnectBudget(
      REALTIME_AGENT_MISSION_PROTOCOL_VERSION,
      false,
    )).toBe(1);
  });

  it('respecte le repli texte sans jamais réarmer un micro legacy', () => {
    expect(planAgentSessionFallback('microphone_denied', 'text_only')).toEqual({
      driver: 'idle',
      continueVoice: false,
      issue: 'denied',
    });
    expect(planAgentSessionFallback('audio_busy', 'text_only')).toEqual({
      driver: 'idle',
      continueVoice: false,
      issue: 'unavailable',
    });
    expect(planAgentSessionFallback('provider_error', 'voice')).toEqual({
      driver: 'legacy',
      continueVoice: true,
      issue: null,
    });
  });

  it('terminalise une rupture Mission en erreur sans pilote legacy ni orbe zombie', () => {
    expect(planAgentSessionFailedClosed()).toEqual({
      driver: 'idle',
      active: false,
      issue: 'failed',
      phase: 'error',
      responseKey: 'live.error',
    });
  });

  it('revalide le vrai background après la boîte de permission Android', async () => {
    let resolvePermission!: () => void;
    const permissionSettled = new Promise<void>((resolve) => {
      resolvePermission = resolve;
    });
    let appState = 'background';
    let mounted = true;
    let stops = 0;
    const revalidation = revalidateAgentSessionBackgroundAfterPermission({
      waitForPermissionRequests: () => permissionSettled,
      waitForLifecycleStabilization: async () => undefined,
      currentAppState: () => appState,
      isMounted: () => mounted,
      stop: () => { stops += 1; },
    });

    appState = 'active';
    resolvePermission();
    await expect(revalidation).resolves.toBe(false);
    expect(stops).toBe(0);

    appState = 'background';
    await expect(revalidateAgentSessionBackgroundAfterPermission({
      waitForPermissionRequests: async () => undefined,
      waitForLifecycleStabilization: async () => undefined,
      currentAppState: () => appState,
      isMounted: () => mounted,
      stop: () => { stops += 1; },
    })).resolves.toBe(true);
    expect(stops).toBe(1);

    mounted = false;
    await expect(revalidateAgentSessionBackgroundAfterPermission({
      waitForPermissionRequests: async () => undefined,
      waitForLifecycleStabilization: async () => undefined,
      currentAppState: () => appState,
      isMounted: () => mounted,
      stop: () => { stops += 1; },
    })).resolves.toBe(false);
    expect(stops).toBe(1);
  });

  it('accepte l’ordre Android permissionSettled puis onResume sans fermer Bob', async () => {
    let resolvePermission!: () => void;
    let resolveLifecycle!: () => void;
    const permissionSettled = new Promise<void>((resolve) => { resolvePermission = resolve; });
    const lifecycleSettled = new Promise<void>((resolve) => { resolveLifecycle = resolve; });
    let appState = 'background';
    let stopped = false;
    const revalidation = revalidateAgentSessionBackgroundAfterPermission({
      waitForPermissionRequests: () => permissionSettled,
      waitForLifecycleStabilization: () => lifecycleSettled,
      currentAppState: () => appState,
      isMounted: () => true,
      stop: () => { stopped = true; },
    });

    resolvePermission();
    await Promise.resolve();
    expect(stopped).toBe(false);
    appState = 'active';
    resolveLifecycle();
    await expect(revalidation).resolves.toBe(false);
    expect(stopped).toBe(false);
  });

  it('S3 — retombe au repos honnête quand l’oreille legacy est fermée en pleine « écoute »', () => {
    // Cas nominal : la reco native s'est terminée seule sur silence — l'orbe doit cesser
    // de promettre « Je t'écoute… » et retomber en idle avec agent.global.heardNothing.
    expect(shouldRecoverLegacyListeningSilence({
      active: true,
      driver: 'legacy',
      phase: 'listening',
      voiceListening: false,
    })).toBe(true);
  });

  it('S3 — ne rattrape jamais un faux silence (temps réel, autre phase, oreille ouverte, session éteinte)', () => {
    const nominal = {
      active: true,
      driver: 'legacy' as const,
      phase: 'listening',
      voiceListening: false,
    };
    expect(shouldRecoverLegacyListeningSilence({ ...nominal, driver: 'live' })).toBe(false);
    expect(shouldRecoverLegacyListeningSilence({ ...nominal, driver: 'live_bootstrap' })).toBe(false);
    expect(shouldRecoverLegacyListeningSilence({ ...nominal, driver: 'idle' })).toBe(false);
    expect(shouldRecoverLegacyListeningSilence({ ...nominal, phase: 'thinking' })).toBe(false);
    expect(shouldRecoverLegacyListeningSilence({ ...nominal, phase: 'speaking' })).toBe(false);
    expect(shouldRecoverLegacyListeningSilence({ ...nominal, phase: 'idle' })).toBe(false);
    expect(shouldRecoverLegacyListeningSilence({ ...nominal, voiceListening: true })).toBe(false);
    expect(shouldRecoverLegacyListeningSilence({ ...nominal, active: false })).toBe(false);
  });

  it('S4 — le handoff prononce le corps de la réponse PUIS la consigne Assistant', () => {
    expect(composeHandoffSpeech(
      'J’envoie la relance à Durand SARL.',
      'Cette action se termine dans l’Assistant — rien n’a été fait pour l’instant.',
    )).toBe(
      'J’envoie la relance à Durand SARL. Cette action se termine dans l’Assistant — rien n’a été fait pour l’instant.',
    );
  });

  it('S4 — le handoff reste prononçable même avec un morceau vide (jamais d’espace orphelin)', () => {
    expect(composeHandoffSpeech('', 'Consigne.')).toBe('Consigne.');
    expect(composeHandoffSpeech('Corps.', '  ')).toBe('Corps.');
    expect(composeHandoffSpeech('  Corps.  ', ' Consigne. ')).toBe('Corps. Consigne.');
  });

  it('reste fail-closed si le waiter permission dérive et que l’app est en background', async () => {
    let stopped = false;
    await expect(revalidateAgentSessionBackgroundAfterPermission({
      waitForPermissionRequests: async () => { throw new Error('waiter failed'); },
      waitForLifecycleStabilization: async () => undefined,
      currentAppState: () => 'background',
      isMounted: () => true,
      stop: () => { stopped = true; },
    })).resolves.toBe(true);
    expect(stopped).toBe(true);
  });
});
