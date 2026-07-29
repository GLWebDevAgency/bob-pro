import { StrictMode, useEffect } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';
import {
  REALTIME_AGENT_MISSION_PROTOCOL_VERSION,
  type RealtimeAgentMissionSession,
} from '@bob/api-client';
import {
  clearBeforeSignOutCleanupsForTests,
  runBeforeSignOutCleanups,
} from '../data/session-cleanup';
import {
  AgentMissionProvider,
  useAgentMissionRuntimeBridge,
} from './agent-mission-provider';
import type { AgentMissionRuntimeBridge } from './agent-mission-runtime';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function session(
  realtimeSessionId: string,
  onDispose: () => void,
): RealtimeAgentMissionSession {
  let disposed = false;
  const unused = async (): Promise<never> => {
    throw new Error('unused_agent_mission_method');
  };
  return {
    protocolVersion: REALTIME_AGENT_MISSION_PROTOCOL_VERSION,
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
      onDispose();
    },
  } as unknown as RealtimeAgentMissionSession;
}

function requireBridge(
  bridge: AgentMissionRuntimeBridge | null,
): AgentMissionRuntimeBridge {
  if (bridge === null) throw new Error('AgentMissionRuntimeBridge non publié');
  return bridge;
}

describe('AgentMissionProvider — lifecycle React 19', () => {
  let renderer: ReactTestRenderer | null = null;

  afterEach(async () => {
    if (renderer !== null) {
      await act(async () => renderer?.unmount());
      renderer = null;
      await Promise.resolve();
    }
    clearBeforeSignOutCleanupsForTests();
  });

  it('reste capable d’adopter après le double cycle Strict Effects', async () => {
    let bridge: AgentMissionRuntimeBridge | null = null;
    function Probe() {
      const current = useAgentMissionRuntimeBridge();
      useEffect(() => {
        bridge = current;
      }, [current]);
      return null;
    }

    await act(async () => {
      renderer = create(
        <StrictMode>
          <AgentMissionProvider>
            <Probe />
          </AgentMissionProvider>
        </StrictMode>,
      );
      await Promise.resolve();
    });

    let disposals = 0;
    const candidate = session(
      '40000000-0000-4000-8000-000000000001',
      () => { disposals += 1; },
    );
    let adopted = false;
    await act(async () => {
      adopted = requireBridge(bridge).adopt(candidate);
    });
    expect(adopted).toBe(true);
    expect(disposals).toBe(0);

    await act(async () => renderer?.unmount());
    renderer = null;
    await Promise.resolve();
    expect(disposals).toBe(1);
  });

  it('détruit immédiatement la capability avant la déconnexion', async () => {
    let bridge: AgentMissionRuntimeBridge | null = null;
    function Probe() {
      bridge = useAgentMissionRuntimeBridge();
      return null;
    }
    await act(async () => {
      renderer = create(
        <AgentMissionProvider>
          <Probe />
        </AgentMissionProvider>,
      );
    });

    let disposals = 0;
    const candidate = session(
      '40000000-0000-4000-8000-000000000002',
      () => { disposals += 1; },
    );
    let adopted = false;
    await act(async () => {
      adopted = requireBridge(bridge).adopt(candidate);
    });
    expect(adopted).toBe(true);

    await act(async () => {
      await runBeforeSignOutCleanups();
    });
    expect(disposals).toBe(1);
    expect(requireBridge(bridge).adopt(
      session('40000000-0000-4000-8000-000000000003', () => undefined),
    )).toBe(false);
  });
});
