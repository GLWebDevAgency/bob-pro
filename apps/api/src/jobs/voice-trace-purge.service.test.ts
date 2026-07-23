import { describe, expect, it, vi } from 'vitest';
import { VOICE_TRACE_RETENTION_DAYS } from '@bob/core';
import { InMemoryPersistence } from '../persistence/persistence.testing';
import type { Persistence } from '../persistence/persistence';
import type { InMemoryVoiceTraceRepository } from '../persistence/voice-traces.testing';
import { AppLogger } from '../observability/logger';
import type { ScheduledTenantDirectory } from './tenant-directory';
import {
  VOICE_TRACE_PURGE_LIMIT_PER_TENANT,
  VOICE_TRACE_PURGE_MAX_TENANTS,
  VoiceTracePurgeService,
  selectVoiceTracePurgeTenantBatch,
} from './voice-trace-purge.service';

const NOW = new Date('2026-09-01T00:00:00.000Z');

function directory(companyIds: string[]): ScheduledTenantDirectory {
  return { listCompanyIds: async () => companyIds } as unknown as ScheduledTenantDirectory;
}

async function seed(
  traces: InMemoryVoiceTraceRepository,
  companyId: string,
  id: string,
  retentionExpiresAt: string,
): Promise<void> {
  await traces.openTurn(companyId, {
    id,
    sessionId: id,
    turnIndex: 1,
    userId: 'usr_1',
    correlationId: 'req_1',
    startedAt: '2026-07-01T00:00:00.000Z',
    transcript: 'facture Martin',
    sttModel: 'voxtral-mini-latest',
    transcriptionMs: 700,
    outcome: 'heard',
    level: 'info',
    reason: null,
    retentionExpiresAt,
  });
}

function harness(companyIds: string[], now: () => Date = () => NOW) {
  const persistence = new InMemoryPersistence();
  const traces = persistence.voiceTraces as unknown as InMemoryVoiceTraceRepository;
  const service = new VoiceTracePurgeService(
    persistence as unknown as Persistence,
    directory(companyIds),
    new AppLogger(),
    now,
  );
  return { service, traces, persistence };
}

describe('VoiceTracePurgeService — la rétention est CÂBLÉE, pas décorative', () => {
  it('supprime les traces échues et conserve celles qui ne le sont pas', async () => {
    const { service, traces } = harness(['co_1']);
    await seed(traces, 'co_1', 'vtr_echue', '2026-08-19T10:00:00.000Z');
    await seed(traces, 'co_1', 'vtr_vivante', '2026-09-15T10:00:00.000Z');

    const summary = await service.sweep();

    expect(summary).toMatchObject({ skipped: false, tenants: 1, purged: 1, failures: 0 });
    expect(traces.list().map((row) => row.id)).toEqual(['vtr_vivante']);
  });

  it('purge chaque tenant sous SON contexte tenant — jamais un balayage global', async () => {
    const { service, traces, persistence } = harness(['co_1', 'co_2']);
    await seed(traces, 'co_1', 'vtr_1', '2026-08-01T00:00:00.000Z');
    await seed(traces, 'co_2', 'vtr_2', '2026-08-01T00:00:00.000Z');
    const scoped = vi.spyOn(persistence, 'runWithTenant');

    const summary = await service.sweep();

    expect(summary.purged).toBe(2);
    expect(scoped.mock.calls.map((call) => call[0])).toEqual(['co_1', 'co_2']);
    expect(traces.list()).toEqual([]);
  });

  it('un tenant en échec n’empêche pas les autres d’être purgés', async () => {
    const { service, traces, persistence } = harness(['co_ko', 'co_ok']);
    await seed(traces, 'co_ok', 'vtr_ok', '2026-08-01T00:00:00.000Z');
    vi.spyOn(persistence, 'runWithTenant').mockImplementation(async (companyId, fn) => {
      if (companyId === 'co_ko') throw new Error('tenant indisponible');
      return fn();
    });

    const summary = await service.sweep();

    expect(summary).toMatchObject({ tenants: 2, purged: 1, failures: 1 });
    expect(traces.list()).toEqual([]);
  });

  it('borne le travail par tenant : une purge ne bloque jamais la base', async () => {
    const { service, traces } = harness(['co_1']);
    const purge = vi.spyOn(traces, 'purgeExpired');
    await service.sweep();
    expect(purge).toHaveBeenCalledWith(
      expect.objectContaining({ limit: VOICE_TRACE_PURGE_LIMIT_PER_TENANT }),
    );
  });

  it('fait tourner plus de 100 tenants sans famine, y compris après un redémarrage horaire', () => {
    const companyIds = Array.from(
      { length: VOICE_TRACE_PURGE_MAX_TENANTS + 1 },
      (_, index) => `co_${String(index + 1).padStart(3, '0')}`,
    );
    const firstHour = selectVoiceTracePurgeTenantBatch(companyIds, NOW);
    const secondHour = selectVoiceTracePurgeTenantBatch(
      companyIds,
      new Date(NOW.getTime() + 60 * 60 * 1_000),
    );

    expect(firstHour.length).toBeLessThanOrEqual(VOICE_TRACE_PURGE_MAX_TENANTS);
    expect(secondHour.length).toBeLessThanOrEqual(VOICE_TRACE_PURGE_MAX_TENANTS);
    expect(new Set([...firstHour, ...secondHour])).toEqual(new Set(companyIds));
  });

  it('câble la rotation au sweep et purge réellement les 101 tenants sur deux heures', async () => {
    const companyIds = Array.from(
      { length: VOICE_TRACE_PURGE_MAX_TENANTS + 1 },
      (_, index) => `co_${String(index + 1).padStart(3, '0')}`,
    );
    let currentTime = NOW;
    const { service, traces, persistence } = harness(companyIds, () => currentTime);
    await Promise.all(
      companyIds.map((companyId) =>
        seed(traces, companyId, `vtr_${companyId}`, '2026-08-01T00:00:00.000Z'),
      ),
    );
    const scoped = vi.spyOn(persistence, 'runWithTenant');

    const first = await service.sweep();
    currentTime = new Date(NOW.getTime() + 60 * 60 * 1_000);
    const second = await service.sweep();

    expect([first.tenants, second.tenants].sort((left, right) => left - right)).toEqual([
      1,
      VOICE_TRACE_PURGE_MAX_TENANTS,
    ]);
    expect(first.purged + second.purged).toBe(companyIds.length);
    expect(new Set(scoped.mock.calls.map((call) => call[0]))).toEqual(new Set(companyIds));
    expect(traces.list()).toEqual([]);
  });

  it('ne relance pas un balayage déjà en cours', async () => {
    const { service } = harness(['co_1']);
    const [first, second] = await Promise.all([service.sweep(), service.sweep()]);
    expect([first.skipped, second.skipped]).toContain(true);
  });

  it('la fenêtre de rétention retenue est bien de 30 jours', () => {
    expect(VOICE_TRACE_RETENTION_DAYS).toBe(30);
  });
});
