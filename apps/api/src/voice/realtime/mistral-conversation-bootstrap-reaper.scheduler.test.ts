import { describe, expect, it, vi } from 'vitest';
import type { AppLogger } from '../../observability/logger';
import type {
  MistralConversationBootstrapPurgeBatchResult,
  MistralConversationBootstrapReaperPort,
} from './mistral-conversation-bootstrap-reaper';
import {
  MistralConversationBootstrapReaperScheduler,
  type MistralConversationBootstrapReaperOptions,
  type MistralConversationBootstrapReaperRuntime,
} from './mistral-conversation-bootstrap-reaper.scheduler';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function loggerStub(): AppLogger {
  return {
    log: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    verbose: vi.fn(),
    audit: vi.fn(),
  } as unknown as AppLogger;
}

function batch(
  override: Partial<MistralConversationBootstrapPurgeBatchResult> = {},
): MistralConversationBootstrapPurgeBatchResult {
  return {
    purgedCount: 0,
    missionsPurged: 0,
    bootstrapsPurged: 0,
    resumeTicketsPurged: 0,
    commandsPurged: 0,
    outboxEventsPurged: 0,
    lockSkipped: 0,
    admissionBlocked: 0,
    invariantBlocked: 0,
    terminalizationBlocked: false,
    eligibleRootsRemain: false,
    expiredRowsRemain: false,
    ...override,
  };
}

function reaperStub(
  purgeBatch = vi.fn(async () => batch()),
): MistralConversationBootstrapReaperPort {
  return { assertReady: vi.fn(async () => undefined), purgeBatch };
}

function runtimeStub(initialNow = 1_000): MistralConversationBootstrapReaperRuntime & {
  advance(ms: number): void;
  callback(): (() => void) | null;
  cancel: ReturnType<typeof vi.fn>;
  schedule: ReturnType<typeof vi.fn>;
} {
  let now = initialNow;
  let scheduled: (() => void) | null = null;
  const schedule = vi.fn((callback: () => void) => {
    scheduled = callback;
    return Symbol('timer');
  });
  const cancel = vi.fn();
  return {
    now: () => now,
    advance: (ms) => { now += ms; },
    schedule,
    cancel,
    callback: () => scheduled,
  };
}

const enabledOptions: MistralConversationBootstrapReaperOptions = {
  enabled: true,
  intervalMs: 10_000,
  batchSize: 100,
  maxBatchesPerSweep: 3,
};

function scheduler(input: {
  reaper?: MistralConversationBootstrapReaperPort | null;
  options?: MistralConversationBootstrapReaperOptions;
  runtime?: ReturnType<typeof runtimeStub>;
  logger?: AppLogger;
} = {}) {
  const runtime = input.runtime ?? runtimeStub();
  const logger = input.logger ?? loggerStub();
  const reaper = input.reaper === undefined ? reaperStub() : input.reaper;
  return {
    scheduler: new MistralConversationBootstrapReaperScheduler(
      reaper,
      input.options ?? enabledOptions,
      logger,
      runtime,
    ),
    runtime,
    logger,
    reaper,
  };
}

describe('Mistral conversation bootstrap reaper — scheduler production', () => {
  it('reste totalement inerte lorsque le replay terminal v2 est désactivé', async () => {
    const h = scheduler({ options: { ...enabledOptions, enabled: false }, reaper: null });

    await expect(h.scheduler.onApplicationBootstrap()).resolves.toBeUndefined();
    await expect(h.scheduler.sweep()).resolves.toMatchObject({ outcome: 'disabled' });
    expect(h.runtime.schedule).not.toHaveBeenCalled();
  });

  it('échoue au boot si le port PostgreSQL réel est absent', async () => {
    const h = scheduler({ reaper: null });
    await expect(h.scheduler.onApplicationBootstrap()).rejects.toThrow(/reaper authority/i);
    expect(h.runtime.schedule).not.toHaveBeenCalled();
  });

  it('prouve l’autorité, purge immédiatement, puis arme et désarme la cadence configurée', async () => {
    const purgeBatch = vi.fn(async () => batch());
    const reaper = reaperStub(purgeBatch);
    const h = scheduler({ reaper });

    await h.scheduler.onApplicationBootstrap();

    expect(reaper.assertReady).toHaveBeenCalledOnce();
    expect(purgeBatch).toHaveBeenCalledWith(100);
    expect(h.runtime.schedule).toHaveBeenCalledWith(expect.any(Function), 10_000);
    expect(h.logger.audit).toHaveBeenCalledWith(
      'bob.live.mistral.bootstrap_reaper.ready',
      expect.objectContaining({ batchSize: 100, maxBatchesPerSweep: 3 }),
    );

    h.runtime.callback()?.();
    await vi.waitFor(() => expect(purgeBatch).toHaveBeenCalledTimes(2));
    await h.scheduler.onModuleDestroy();
    expect(h.runtime.cancel).toHaveBeenCalledOnce();
  });

  it('draine par batches bornés et signale un sweep limité sans boucle infinie', async () => {
    const purgeBatch = vi.fn()
      .mockResolvedValueOnce(batch({
        purgedCount: 100,
        missionsPurged: 90,
        bootstrapsPurged: 100,
        outboxEventsPurged: 200,
        eligibleRootsRemain: true,
        expiredRowsRemain: true,
      }))
      .mockResolvedValueOnce(batch({
        purgedCount: 100,
        missionsPurged: 100,
        bootstrapsPurged: 100,
        resumeTicketsPurged: 20,
        eligibleRootsRemain: true,
        expiredRowsRemain: true,
      }))
      .mockResolvedValueOnce(batch({
        purgedCount: 12,
        missionsPurged: 12,
        bootstrapsPurged: 12,
        commandsPurged: 5,
        lockSkipped: 1,
        eligibleRootsRemain: true,
        expiredRowsRemain: true,
      }));
    const h = scheduler({ reaper: reaperStub(purgeBatch) });

    await expect(h.scheduler.sweep()).resolves.toMatchObject({
      outcome: 'succeeded',
      batches: 3,
      purgedCount: 212,
      missionsPurged: 202,
      resumeTicketsPurged: 20,
      commandsPurged: 5,
      outboxEventsPurged: 200,
      lockSkipped: 1,
      expiredRowsRemain: true,
      limited: true,
    });
    expect(purgeBatch).toHaveBeenCalledTimes(3);
    expect(h.logger.audit).toHaveBeenCalledWith(
      'bob.live.mistral.bootstrap_reaper.sweep',
      expect.objectContaining({ purgedCount: 212, limited: true }),
    );
  });

  it('ne chevauche pas deux sweeps et attend le batch engagé à l’arrêt', async () => {
    const gate = deferred<MistralConversationBootstrapPurgeBatchResult>();
    const purgeBatch = vi.fn(() => gate.promise);
    const h = scheduler({ reaper: reaperStub(purgeBatch) });

    const first = h.scheduler.sweep();
    await vi.waitFor(() => expect(purgeBatch).toHaveBeenCalledOnce());
    await expect(h.scheduler.sweep()).resolves.toMatchObject({ outcome: 'skipped' });

    let stopped = false;
    const stopping = h.scheduler.onModuleDestroy().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    gate.resolve(batch());
    await expect(first).resolves.toMatchObject({ outcome: 'succeeded' });
    await stopping;
    expect(stopped).toBe(true);
  });

  it('ouvre le disjoncteur après cinq échecs, reste silencieux, puis se réarme sur succès', async () => {
    const purgeBatch = vi.fn(async (): Promise<MistralConversationBootstrapPurgeBatchResult> => {
      throw new Error('database unavailable with potentially sensitive details');
    });
    const runtime = runtimeStub();
    const logger = loggerStub();
    const h = scheduler({ reaper: reaperStub(purgeBatch), runtime, logger });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(h.scheduler.sweep()).resolves.toMatchObject({ outcome: 'failed' });
    }
    expect(logger.warn).toHaveBeenCalledTimes(4);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify((logger.warn as ReturnType<typeof vi.fn>).mock.calls))
      .not.toContain('potentially sensitive');
    expect(JSON.stringify((logger.error as ReturnType<typeof vi.fn>).mock.calls))
      .not.toContain('potentially sensitive');

    await expect(h.scheduler.sweep()).resolves.toMatchObject({ outcome: 'circuit_open' });
    expect(purgeBatch).toHaveBeenCalledTimes(5);

    runtime.advance(60_000);
    purgeBatch.mockImplementationOnce(async () => batch({
      purgedCount: 1,
      bootstrapsPurged: 1,
    }));
    await expect(h.scheduler.sweep()).resolves.toMatchObject({
      outcome: 'succeeded',
      purgedCount: 1,
    });
    expect(logger.audit).toHaveBeenCalledWith(
      'bob.live.mistral.bootstrap_reaper.sweep',
      expect.objectContaining({ outcome: 'recovered' }),
    );
  });

  it('journalise une seule fois une dépendance de rétention encore vivante', async () => {
    const logger = loggerStub();
    const h = scheduler({
      reaper: reaperStub(vi.fn(async () => batch({
        admissionBlocked: 1,
        eligibleRootsRemain: true,
        expiredRowsRemain: true,
      }))),
      logger,
    });

    await h.scheduler.sweep();
    await h.scheduler.sweep();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'bob.live.mistral.bootstrap_reaper.retention_dependency_pending',
      'MistralConversationBootstrapReaper',
    );
    expect(logger.audit).toHaveBeenCalledWith(
      'bob.live.mistral.bootstrap_reaper.retention_blocked',
      expect.objectContaining({ admissionBlocked: 1 }),
    );
  });

  it.each([
    { ...enabledOptions, intervalMs: 9_999 },
    { ...enabledOptions, batchSize: 0 },
    { ...enabledOptions, batchSize: 101 },
    { ...enabledOptions, maxBatchesPerSweep: 21 },
  ])('refuse la configuration incohérente au lieu de prendre un fallback : %#', (options) => {
    expect(() => scheduler({ options })).toThrow(/configuration is invalid/i);
  });
});
