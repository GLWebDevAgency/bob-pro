import { describe, expect, it } from 'vitest';
import type { AgentContext } from '@bob/ai';
import {
  agentContextSemanticKey,
  realtimeOwnsAgentSession,
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
});
