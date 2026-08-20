import { describe, expect, it, vi } from 'vitest';
import type { JarvisRunSnapshotView, JarvisRunView } from '@bob/api-client';

import {
  JarvisRunConvergenceCoordinator,
  type JarvisRunConvergenceClock,
} from './jarvis-run-convergence';

const RUN_A = '11111111-1111-4111-8111-111111111111';
const RUN_B = '22222222-2222-4222-8222-222222222222';
const RUN_C = '33333333-3333-4333-8333-333333333333';
const RUN_D = '44444444-4444-4444-8444-444444444444';
const RUN_E = '55555555-5555-4555-8555-555555555555';

function run(
  runId: string,
  status: JarvisRunView['status'] = 'waiting_external',
  revision = status === 'completed' ? 6 : 5,
): JarvisRunView {
  return {
    runId,
    kind: 'customer_contact',
    definitionVersion: 1,
    actionReference:
      status === 'completed' ? null : { actionId: 'client-modifier', actionVersion: 1 },
    status,
    revision,
    nextWakeAt: null,
    terminalAt: status === 'completed' ? '2026-08-20T20:00:00.000Z' : null,
  };
}

function snapshot(
  runId: string,
  status: JarvisRunView['status'],
  revision?: number,
): JarvisRunSnapshotView {
  return { run: run(runId, status, revision), presentation: null };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

class ManualClock implements JarvisRunConvergenceClock {
  private nowMs = 0;
  private nextTimerId = 0;
  private readonly timers = new Map<number, { readonly at: number; readonly callback: () => void }>();

  readonly now = (): number => this.nowMs;

  readonly setTimeout = (
    callback: () => void,
    delayMs: number,
  ): ReturnType<typeof setTimeout> => {
    const id = ++this.nextTimerId;
    this.timers.set(id, { at: this.nowMs + delayMs, callback });
    return id as unknown as ReturnType<typeof setTimeout>;
  };

  readonly clearTimeout = (handle: ReturnType<typeof setTimeout>): void => {
    this.timers.delete(handle as unknown as number);
  };

  private nextDueTimer(
    target: number,
  ): [number, { readonly at: number; readonly callback: () => void }] | null {
    let next: [number, { readonly at: number; readonly callback: () => void }] | null = null;
    for (const entry of this.timers.entries()) {
      if (entry[1].at > target) continue;
      if (next === null || entry[1].at < next[1].at || (
        entry[1].at === next[1].at && entry[0] < next[0]
      )) {
        next = entry;
      }
    }
    return next;
  }

  async advanceBy(delayMs: number): Promise<void> {
    const target = this.nowMs + delayMs;
    let next = this.nextDueTimer(target);
    while (next !== null) {
      this.timers.delete(next[0]);
      this.nowMs = next[1].at;
      next[1].callback();
      await flushMicrotasks();
      next = this.nextDueTimer(target);
    }
    this.nowMs = target;
    await flushMicrotasks();
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('JarvisRunConvergenceCoordinator — autorité L7 unique', () => {
  it('déduplique reçu/current, cadence réellement à 1,5 s et s’arrête définitivement au règlement', async () => {
    const clock = new ManualClock();
    const calls: number[] = [];
    const outcomes: JarvisRunView['status'][] = ['waiting_external', 'completed'];
    const settled = vi.fn();
    const coordinator = new JarvisRunConvergenceCoordinator(
      async () => {
        calls.push(clock.now());
        const status = outcomes.shift();
        if (status === undefined) throw new Error('lecture surnuméraire');
        return { ok: true, value: snapshot(RUN_A, status) };
      },
      settled,
      clock,
    );
    coordinator.setAvailable(true);
    coordinator.observe(run(RUN_A));
    coordinator.observe(run(RUN_A, 'retry_due'));

    await clock.advanceBy(0);
    expect(calls).toEqual([0]);
    expect(settled).not.toHaveBeenCalled();
    await clock.advanceBy(1_499);
    expect(calls).toEqual([0]);
    await clock.advanceBy(1);
    expect(calls).toEqual([0, 1_500]);
    expect(settled).toHaveBeenCalledOnce();
    expect(settled).toHaveBeenCalledWith(RUN_A);

    // Reçu N-1 rejoué puis temps largement avancé : le tombstone empêche une seconde convergence.
    coordinator.observe(run(RUN_A));
    await clock.advanceBy(60_000);
    expect(calls).toEqual([0, 1_500]);
    expect(settled).toHaveBeenCalledOnce();
  });

  it('une erreur A n’affame pas B–E : un seul vol, ordre équitable, plancher global respecté', async () => {
    const clock = new ManualClock();
    const calls: Array<{ readonly runId: string; readonly at: number }> = [];
    const attempts = new Map<string, number>();
    const settled: string[] = [];
    const coordinator = new JarvisRunConvergenceCoordinator(
      async (runId) => {
        calls.push({ runId, at: clock.now() });
        const count = (attempts.get(runId) ?? 0) + 1;
        attempts.set(runId, count);
        if (runId === RUN_A && count === 1) {
          return { ok: false, error: { kind: 'unavailable', service: 'jarvis-run' } };
        }
        return { ok: true, value: snapshot(runId, 'completed') };
      },
      (runId) => settled.push(runId),
      clock,
    );
    coordinator.setAvailable(true);
    for (const runId of [RUN_A, RUN_B, RUN_C, RUN_D, RUN_E]) coordinator.observe(run(runId));

    await clock.advanceBy(7_500);
    expect(calls.map(({ runId }) => runId)).toEqual([
      RUN_A,
      RUN_B,
      RUN_C,
      RUN_D,
      RUN_E,
      RUN_A,
    ]);
    expect(calls.map(({ at }) => at)).toEqual([0, 1_500, 3_000, 4_500, 6_000, 7_500]);
    expect(new Set(settled)).toEqual(new Set([RUN_A, RUN_B, RUN_C, RUN_D, RUN_E]));
  });

  it('plafonne le backoff d’une dépendance durable à 30 s', async () => {
    const clock = new ManualClock();
    const calls: number[] = [];
    const coordinator = new JarvisRunConvergenceCoordinator(
      async () => {
        calls.push(clock.now());
        return { ok: false, error: { kind: 'unavailable', service: 'jarvis-run' } };
      },
      vi.fn(),
      clock,
    );
    coordinator.setAvailable(true);
    coordinator.observe(run(RUN_A));

    await clock.advanceBy(76_500);
    expect(calls).toEqual([0, 1_500, 4_500, 10_500, 22_500, 46_500, 76_500]);
    expect(calls.at(-1)! - calls.at(-2)!).toBe(30_000);
  });

  it('refuse de régler A avec l’écho terminal de B et retente A après backoff', async () => {
    const clock = new ManualClock();
    const calls: number[] = [];
    const outcomes = [snapshot(RUN_B, 'completed'), snapshot(RUN_A, 'completed')];
    const settled = vi.fn();
    const coordinator = new JarvisRunConvergenceCoordinator(
      async () => {
        calls.push(clock.now());
        const value = outcomes.shift();
        if (value === undefined) throw new Error('lecture surnuméraire');
        return { ok: true, value };
      },
      settled,
      clock,
    );
    coordinator.setAvailable(true);
    coordinator.observe(run(RUN_A));

    await clock.advanceBy(0);
    expect(settled).not.toHaveBeenCalled();
    await clock.advanceBy(1_500);
    expect(calls).toEqual([0, 1_500]);
    expect(settled).toHaveBeenCalledOnce();
    expect(settled).toHaveBeenCalledWith(RUN_A);
  });

  it('garde la plus haute révision observée : un exact stable N-1 ne clôt jamais la cible', async () => {
    const clock = new ManualClock();
    const calls: number[] = [];
    const outcomes = [
      snapshot(RUN_A, 'completed', 6),
      snapshot(RUN_A, 'completed', 8),
    ];
    const settled = vi.fn();
    const coordinator = new JarvisRunConvergenceCoordinator(
      async () => {
        calls.push(clock.now());
        const value = outcomes.shift();
        if (value === undefined) throw new Error('lecture surnuméraire');
        return { ok: true, value };
      },
      settled,
      clock,
    );
    coordinator.setAvailable(true);
    coordinator.observe(run(RUN_A, 'waiting_external', 5));
    coordinator.observe(run(RUN_A, 'retry_due', 7));

    await clock.advanceBy(0);
    expect(settled).not.toHaveBeenCalled();
    await clock.advanceBy(1_500);
    expect(calls).toEqual([0, 1_500]);
    expect(settled).toHaveBeenCalledOnce();
  });

  it('ne tombstone pas si la publication de convergence lève : elle est retentée', async () => {
    const clock = new ManualClock();
    const calls: number[] = [];
    const settled = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error('projection indisponible');
      })
      .mockImplementation(() => undefined);
    const coordinator = new JarvisRunConvergenceCoordinator(
      async () => {
        calls.push(clock.now());
        return { ok: true, value: snapshot(RUN_A, 'completed') };
      },
      settled,
      clock,
    );
    coordinator.setAvailable(true);
    coordinator.observe(run(RUN_A));

    await clock.advanceBy(0);
    expect(settled).toHaveBeenCalledOnce();
    await clock.advanceBy(1_500);
    expect(calls).toEqual([0, 1_500]);
    expect(settled).toHaveBeenCalledTimes(2);

    coordinator.observe(run(RUN_A));
    await clock.advanceBy(60_000);
    expect(calls).toEqual([0, 1_500]);
  });

  it('l’arrière-plan libère même un transport qui ignore abort ; sa réponse tardive ne règle rien', async () => {
    const clock = new ManualClock();
    const first = deferred<ReturnType<typeof snapshot>>();
    const signals: AbortSignal[] = [];
    let calls = 0;
    const settled = vi.fn();
    const coordinator = new JarvisRunConvergenceCoordinator(
      async (_runId, signal) => {
        calls += 1;
        signals.push(signal);
        if (calls === 1) return { ok: true, value: await first.promise };
        return { ok: true, value: snapshot(RUN_A, 'completed') };
      },
      settled,
      clock,
    );
    coordinator.observe(run(RUN_A));
    await clock.advanceBy(10_000);
    expect(calls).toBe(0);

    coordinator.setAvailable(true);
    await clock.advanceBy(0);
    expect(calls).toBe(1);
    coordinator.setAvailable(false);
    expect(signals[0]?.aborted).toBe(true);
    // Le premier transport ignore volontairement AbortSignal et reste en suspens. Le retour au
    // premier plan doit pouvoir repartir après le plancher global sans attendre cette Promise.
    coordinator.setAvailable(true);
    await clock.advanceBy(1_499);
    expect(calls).toBe(1);
    await clock.advanceBy(1);
    expect(calls).toBe(2);
    expect(settled).toHaveBeenCalledWith(RUN_A);

    first.resolve(snapshot(RUN_A, 'completed'));
    await flushMicrotasks();
    expect(settled).toHaveBeenCalledOnce();
  });

  it('dispose purge la file et clôture les observations/callbacks tardifs de l’ancien owner', async () => {
    const clock = new ManualClock();
    const read = deferred<ReturnType<typeof snapshot>>();
    const signals: AbortSignal[] = [];
    const settled = vi.fn();
    const coordinator = new JarvisRunConvergenceCoordinator(
      async (_runId, signal) => {
        signals.push(signal);
        return { ok: true, value: await read.promise };
      },
      settled,
      clock,
    );
    coordinator.setAvailable(true);
    coordinator.observe(run(RUN_A));
    await clock.advanceBy(0);

    coordinator.dispose();
    coordinator.observe(run(RUN_B));
    expect(signals[0]?.aborted).toBe(true);
    await clock.advanceBy(60_000);
    expect(signals).toHaveLength(1);

    read.resolve(snapshot(RUN_A, 'completed'));
    await flushMicrotasks();
    expect(settled).not.toHaveBeenCalled();
  });

  it('un cleanup/remount StrictMode conserve la file de la même identité', async () => {
    const clock = new ManualClock();
    const calls: string[] = [];
    const settled = vi.fn();
    const coordinator = new JarvisRunConvergenceCoordinator(
      async (runId) => {
        calls.push(runId);
        return { ok: true, value: snapshot(runId, 'completed') };
      },
      settled,
      clock,
    );
    coordinator.observe(run(RUN_A));
    const firstActivation = coordinator.activate(false);
    coordinator.release(firstActivation);
    coordinator.activate(true);

    await flushMicrotasks();
    await clock.advanceBy(0);
    expect(calls).toEqual([RUN_A]);
    expect(settled).toHaveBeenCalledWith(RUN_A);
  });
});
