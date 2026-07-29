import { describe, expect, it } from 'vitest';
import {
  REALTIME_AGENT_MISSION_PROTOCOL_VERSION,
  type RealtimeAgentMissionSession,
} from '@bob/api-client';
import {
  AgentMissionRuntimeOwner,
  type AgentMissionRuntimeCapture,
} from './agent-mission-runtime';

function session(
  id: string,
  disposals: string[],
): RealtimeAgentMissionSession {
  let disposed = false;
  const unused = async (): Promise<never> => {
    throw new Error('unused_agent_mission_method');
  };
  return {
    protocolVersion: REALTIME_AGENT_MISSION_PROTOCOL_VERSION,
    realtimeSessionId: id,
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
      disposals.push(id);
    },
  } as unknown as RealtimeAgentMissionSession;
}

describe('AgentMissionRuntimeOwner', () => {
  it('transfère move-only, remplace en disposant l’ancien une fois et fence sa génération', () => {
    const disposals: string[] = [];
    const owner = new AgentMissionRuntimeOwner();
    const firstId = '10000000-0000-4000-8000-000000000001';
    const secondId = '10000000-0000-4000-8000-000000000002';
    const first = session(firstId, disposals);
    const second = session(secondId, disposals);

    expect(owner.adopt(first)).toBe(true);
    const stale = owner.capture() as AgentMissionRuntimeCapture;
    expect(owner.adopt(first)).toBe(true);
    expect(disposals).toEqual([]);

    expect(owner.adopt(second)).toBe(true);
    expect(disposals).toEqual([firstId]);
    expect(owner.isCurrent(stale)).toBe(false);
    expect(owner.capture()?.session).toBe(second);

    owner.dispose();
    owner.dispose();
    expect(disposals).toEqual([firstId, secondId]);
  });

  it('ne publie un contexte qu’après confirmation exacte de la session possédée', () => {
    const owner = new AgentMissionRuntimeOwner();
    const currentId = '20000000-0000-4000-8000-000000000001';
    const current = session(currentId, []);
    owner.adopt(current);

    expect(owner.confirmContext('20000000-0000-4000-8000-000000000002', {
      sessionHandle: currentId,
      contextRevision: 3,
      contextDigest: 'a'.repeat(64),
    }, {
      screen: { name: '/devis/new', instanceId: 'quote-screen-1' },
      entities: [],
      capabilities: ['screen.read'],
    })).toBe(false);
    expect(owner.snapshot().confirmedContext).toBeNull();

    expect(owner.confirmContext(currentId, {
      sessionHandle: currentId,
      contextRevision: 3,
      contextDigest: 'a'.repeat(64),
    }, {
      screen: { name: '/devis/new', instanceId: 'quote-screen-1' },
      entities: [],
      capabilities: ['screen.read'],
    })).toBe(true);
    expect(owner.snapshot().confirmedContext).toEqual({
      realtimeSessionId: currentId,
      revision: 3,
      digest: 'a'.repeat(64),
      screen: {
        name: '/devis/new',
        instanceId: 'quote-screen-1',
      },
    });
    const revisionThree = owner.capture() as AgentMissionRuntimeCapture;
    expect(owner.isCurrent(revisionThree)).toBe(true);

    owner.invalidateContext('20000000-0000-4000-8000-000000000002');
    expect(owner.snapshot().confirmedContext).not.toBeNull();
    owner.invalidateContext(currentId);
    expect(owner.snapshot().confirmedContext).toBeNull();
    expect(owner.isCurrent(revisionThree)).toBe(false);

    expect(owner.confirmContext(currentId, {
      sessionHandle: currentId,
      contextRevision: 4,
      contextDigest: 'b'.repeat(64),
    }, {
      screen: { name: '/devis/new', instanceId: 'quote-screen-2' },
      entities: [],
      capabilities: ['screen.read'],
    })).toBe(true);
    const revisionFour = owner.capture() as AgentMissionRuntimeCapture;
    expect(owner.isCurrent(revisionFour)).toBe(true);
    expect(owner.isCurrent(revisionThree)).toBe(false);

    expect(owner.confirmContext(currentId, {
      sessionHandle: currentId,
      contextRevision: 3,
      contextDigest: 'c'.repeat(64),
    }, {
      screen: { name: '/devis/new', instanceId: 'quote-screen-rollback' },
      entities: [],
      capabilities: ['screen.read'],
    })).toBe(false);
    expect(owner.confirmContext(currentId, {
      sessionHandle: currentId,
      contextRevision: 4,
      contextDigest: 'b'.repeat(64),
    }, {
      screen: { name: '/devis/new', instanceId: 'quote-screen-divergent' },
      entities: [],
      capabilities: ['screen.read'],
    })).toBe(false);
    expect(owner.snapshot().confirmedContext).toEqual(revisionFour.confirmedContext);
  });

  it('fence synchroniquement les captures pendant un démontage puis survit au cycle Strict Effects', () => {
    const disposals: string[] = [];
    const owner = new AgentMissionRuntimeOwner();
    const id = '30000000-0000-4000-8000-000000000003';
    const current = session(id, disposals);
    expect(owner.adopt(current)).toBe(true);
    const beforeCleanup = owner.capture() as AgentMissionRuntimeCapture;

    owner.deactivate();
    expect(owner.capture()).toBeNull();
    expect(owner.isCurrent(beforeCleanup)).toBe(false);
    expect(disposals).toEqual([]);

    expect(owner.activate()).toBe(true);
    expect(owner.capture()?.session).toBe(current);
    expect(owner.isCurrent(beforeCleanup)).toBe(false);

    owner.dispose();
    expect(disposals).toEqual([id]);
    expect(owner.activate()).toBe(false);
  });

  it('refuse un handle détruit et toute adoption après démontage sans toucher au candidat', () => {
    const disposals: string[] = [];
    const owner = new AgentMissionRuntimeOwner();
    const alreadyDisposed = session('30000000-0000-4000-8000-000000000001', disposals);
    alreadyDisposed.dispose();

    expect(owner.adopt(alreadyDisposed)).toBe(false);
    owner.dispose();
    const late = session('30000000-0000-4000-8000-000000000002', disposals);
    expect(owner.adopt(late)).toBe(false);
    expect(late.disposed).toBe(false);
  });
});
