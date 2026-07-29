import { describe, expect, it } from 'vitest';
import type { AgentContext } from '@bob/ai';
import {
  agentContextSemanticKey,
  composeHandoffSpeech,
  planAgentSessionFallback,
  planAgentSessionFailedClosed,
  revalidateAgentSessionBackgroundAfterPermission,
  realtimeOwnsAgentSession,
  shouldRecoverLegacyListeningSilence,
  shouldStopAgentSessionForAppState,
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
