import { createElement, useEffect } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuoteAgentMissionResumeViewV2 } from '@bob/core';
import {
  AgentMissionRecoveryProvider,
  useAgentMissionRecovery,
} from './agent-mission-recovery';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const fixtures = vi.hoisted(() => ({
  getCurrentQuoteAgentMissionResumeV2: vi.fn(),
  getCurrentQuoteAgentMissionResume: vi.fn(),
  userId: '10000000-0000-4000-8000-000000000001',
  companyId: '20000000-0000-4000-8000-000000000001',
}));

vi.mock('../data/auth', () => ({
  useAuth: () => ({
    enabled: true,
    session: {
      user: {
        id: fixtures.userId,
      },
    },
  }),
}));
vi.mock('../data/client', () => ({
  useBobClient: () => ({
    companyId: fixtures.companyId,
    getCurrentQuoteAgentMissionResumeV2:
      fixtures.getCurrentQuoteAgentMissionResumeV2,
    getCurrentQuoteAgentMissionResume:
      fixtures.getCurrentQuoteAgentMissionResume,
  }),
}));

describe('AgentMissionRecoveryProvider — single-flight QueryClient', () => {
  let queryClient: QueryClient;
  let renderer: ReactTestRenderer | null = null;
  let recovery: ReturnType<typeof useAgentMissionRecovery> | null = null;

  function Probe() {
    const current = useAgentMissionRecovery();
    useEffect(() => {
      recovery = current;
    }, [current]);
    return null;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    fixtures.userId = '10000000-0000-4000-8000-000000000001';
    fixtures.companyId = '20000000-0000-4000-8000-000000000001';
    fixtures.getCurrentQuoteAgentMissionResume.mockRejectedValue(
      new Error('V1 ne doit pas être appelé sans upgrade_required'),
    );
    recovery = null;
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  });

  afterEach(async () => {
    if (renderer !== null) {
      await act(async () => renderer?.unmount());
      renderer = null;
    }
    queryClient.clear();
  });

  it('partage le fetch initial avec deux refresh concurrents sans annulation', async () => {
    let resolveRequest!: (
      value: { readonly ok: true; readonly value: QuoteAgentMissionResumeViewV2 },
    ) => void;
    let observedSignal: AbortSignal | undefined;
    fixtures.getCurrentQuoteAgentMissionResumeV2.mockImplementation(
      (signal: AbortSignal | undefined) => {
        observedSignal = signal;
        return new Promise((resolve) => {
          resolveRequest = resolve;
        });
      },
    );
    await act(async () => {
      renderer = create(createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          AgentMissionRecoveryProvider,
          null,
          createElement(Probe),
        ),
      ));
      await Promise.resolve();
    });
    expect(fixtures.getCurrentQuoteAgentMissionResumeV2).toHaveBeenCalledTimes(1);
    expect(recovery).not.toBeNull();

    let first!: Promise<unknown>;
    let second!: Promise<unknown>;
    await act(async () => {
      first = recovery!.refresh();
      second = recovery!.refresh();
      await Promise.resolve();
    });
    expect(first).toBe(second);
    expect(fixtures.getCurrentQuoteAgentMissionResumeV2).toHaveBeenCalledTimes(1);
    expect(observedSignal?.aborted).toBe(false);

    await act(async () => {
      resolveRequest({
        ok: true,
        value: { mission: null, presentation: null },
      });
      await Promise.all([first, second]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(recovery?.snapshot).toEqual({ phase: 'absent' });
  });

  it('annule toute lecture pré-mutation et exige un GET post-commit neuf', async () => {
    let firstSignal: AbortSignal | undefined;
    fixtures.getCurrentQuoteAgentMissionResumeV2
      .mockImplementationOnce(
        (signal: AbortSignal | undefined) =>
          new Promise((_resolve, reject) => {
            firstSignal = signal;
            signal?.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
          }),
      )
      .mockResolvedValueOnce({
        ok: true,
        value: { mission: null, presentation: null },
      });
    await act(async () => {
      renderer = create(createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          AgentMissionRecoveryProvider,
          null,
          createElement(Probe),
        ),
      ));
      await Promise.resolve();
    });
    expect(fixtures.getCurrentQuoteAgentMissionResumeV2).toHaveBeenCalledOnce();

    let result!: Awaited<ReturnType<
      NonNullable<typeof recovery>['refreshAfterMutation']
    >>;
    await act(async () => {
      result = await recovery!.refreshAfterMutation();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(firstSignal?.aborted).toBe(true);
    expect(fixtures.getCurrentQuoteAgentMissionResumeV2).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ phase: 'absent' });
    expect(recovery?.snapshot).toEqual({ phase: 'absent' });
  });

  it('ne partage jamais un refresh entre deux propriétaires successifs', async () => {
    fixtures.getCurrentQuoteAgentMissionResumeV2
      .mockImplementationOnce(
        (signal: AbortSignal | undefined) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('owner_changed')), {
              once: true,
            });
          }),
      )
      .mockResolvedValue({
        ok: true,
        value: { mission: null, presentation: null },
      });
    const tree = () => createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        AgentMissionRecoveryProvider,
        null,
        createElement(Probe),
      ),
    );
    await act(async () => {
      renderer = create(tree());
      await Promise.resolve();
    });
    const ownerARefresh = recovery!.refresh();

    fixtures.userId = '10000000-0000-4000-8000-000000000002';
    fixtures.companyId = '20000000-0000-4000-8000-000000000002';
    await act(async () => {
      renderer?.update(tree());
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const ownerBRefresh = recovery!.refresh();

    expect(ownerBRefresh).not.toBe(ownerARefresh);
    await expect(ownerBRefresh).resolves.toEqual({ phase: 'absent' });
    expect(fixtures.getCurrentQuoteAgentMissionResumeV2.mock.calls.length)
      .toBeGreaterThanOrEqual(2);
    await Promise.allSettled([ownerARefresh]);
  });
});
