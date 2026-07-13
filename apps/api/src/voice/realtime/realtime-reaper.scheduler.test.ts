import { describe, expect, it, vi } from 'vitest';
import type { AppLogger } from '../../observability/logger';
import type { RealtimeAdmissionPort, RealtimeReapingClaim } from './realtime-admission';
import {
  RealtimeAdmissionReaperScheduler,
  type RealtimeReaperTenantDirectory,
} from './realtime-reaper.scheduler';
import type { OpenAiRealtimeCallProvider, RealtimeVoiceSettings } from './realtime.types';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function claim(companyId = 'company-a', suffix = '1'): RealtimeReapingClaim {
  return {
    companyId,
    subjectHash: suffix.repeat(64),
    sessionId: `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`,
    providerCallId: `rtc_${suffix}`,
    reaperToken: `reaper-${suffix}-${'x'.repeat(40)}`,
    reaperLeaseExpiresAt: '2026-07-13T12:00:30.000Z',
  };
}

function admissionStub(overrides: Partial<RealtimeAdmissionPort> = {}): RealtimeAdmissionPort {
  return {
    reserve: vi.fn(),
    bindProvider: vi.fn(),
    activate: vi.fn(),
    renew: vi.fn(),
    release: vi.fn(),
    claimExpired: vi.fn(async () => ({ ok: true, claims: [] })),
    claimTermination: vi.fn(),
    completeReaping: vi.fn(async () => ({ ok: true, reason: null })),
    acquire: vi.fn(() => ({ allowed: false, denial: 'unavailable', retryAt: null })),
    ...overrides,
  } as RealtimeAdmissionPort;
}

function providerStub(hangupCall = vi.fn(async () => undefined)): OpenAiRealtimeCallProvider {
  return { createCall: vi.fn(), hangupCall };
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

function settings(enabled = true): RealtimeVoiceSettings {
  return { enabled } as RealtimeVoiceSettings;
}

function scheduler(input: {
  admission: RealtimeAdmissionPort;
  provider?: OpenAiRealtimeCallProvider;
  tenants?: RealtimeReaperTenantDirectory;
  enabled?: boolean;
}) {
  return new RealtimeAdmissionReaperScheduler(
    input.admission,
    input.provider ?? providerStub(),
    input.tenants ?? { listCompanyIds: async () => ['company-a'] },
    settings(input.enabled ?? true),
    loggerStub(),
    {
      maxTenantsPerSweep: 10,
      maxClaimsPerTenant: 2,
      maxConcurrentTenants: 2,
      maxConcurrentHangups: 2,
    },
  );
}

describe('Bob Live — reaper multi-réplique', () => {
  it('effectue le hangup hors claim et ne complète qu’après confirmation provider', async () => {
    const providerGate = deferred();
    const reaping = claim();
    const completeReaping = vi.fn(async () => ({ ok: true as const, reason: null }));
    const admission = admissionStub({
      claimExpired: vi.fn(async () => ({ ok: true as const, claims: [reaping] })),
      completeReaping,
    });
    const hangupCall = vi.fn(() => providerGate.promise);
    const running = scheduler({ admission, provider: providerStub(hangupCall) }).sweep();

    await vi.waitFor(() => expect(hangupCall).toHaveBeenCalledWith('rtc_1'));
    expect(completeReaping).not.toHaveBeenCalled();
    providerGate.resolve();
    await expect(running).resolves.toMatchObject({ claims: 1, terminated: 1, failures: 0 });
    expect(completeReaping).toHaveBeenCalledWith({
      companyId: reaping.companyId,
      subjectHash: reaping.subjectHash,
      sessionId: reaping.sessionId,
      reaperToken: reaping.reaperToken,
    });
  });

  it('conserve le fence quand le provider échoue et distingue une admission indisponible', async () => {
    const claims = [claim('company-a', '1')];
    const completeReaping = vi.fn(async () => ({ ok: true as const, reason: null }));
    const admission = admissionStub({
      claimExpired: vi.fn(async ({ companyId }) => companyId === 'company-a'
        ? { ok: true as const, claims }
        : { ok: false as const, reason: 'unavailable' as const }),
      completeReaping,
    });
    const provider = providerStub(vi.fn(async () => {
      throw new Error('provider unavailable');
    }));
    const result = await scheduler({
      admission,
      provider,
      tenants: { listCompanyIds: async () => ['company-a', 'company-b'] },
    }).sweep();

    expect(result).toMatchObject({ tenants: 2, claims: 1, terminated: 0, failures: 2, unavailableTenants: 1 });
    expect(completeReaping).not.toHaveBeenCalled();
  });

  it('déduplique, filtre et borne les tenants avant tout claim', async () => {
    const claimExpired = vi.fn(async () => ({ ok: true as const, claims: [] }));
    const admission = admissionStub({ claimExpired });
    const reaper = new RealtimeAdmissionReaperScheduler(
      admission,
      providerStub(),
      {
        listCompanyIds: async () => [
          'company-a', 'company-a', 'invalid/tenant', 'company-b', 'company-c',
        ],
      },
      settings(),
      loggerStub(),
      { maxTenantsPerSweep: 2, maxClaimsPerTenant: 1, maxConcurrentTenants: 1, maxConcurrentHangups: 1 },
    );
    const result = await reaper.sweep();
    expect(result.tenants).toBe(2);
    expect(claimExpired).toHaveBeenCalledTimes(2);
    expect(claimExpired).toHaveBeenNthCalledWith(1, { companyId: 'company-a', limit: 1 });
    expect(claimExpired).toHaveBeenNthCalledWith(2, { companyId: 'company-b', limit: 1 });
  });

  it('évite les sweeps locaux chevauchants et reste inerte quand Bob Live est désactivé', async () => {
    const tenantGate = deferred();
    const tenants = { listCompanyIds: vi.fn(() => tenantGate.promise.then(() => ['company-a'])) };
    const admission = admissionStub();
    const reaper = scheduler({ admission, tenants });
    const first = reaper.sweep();
    await vi.waitFor(() => expect(tenants.listCompanyIds).toHaveBeenCalledOnce());
    await expect(reaper.sweep()).resolves.toMatchObject({ skipped: true });
    tenantGate.resolve();
    await expect(first).resolves.toMatchObject({ skipped: false });

    const disabled = scheduler({ admission, tenants: { listCompanyIds: vi.fn() }, enabled: false });
    await expect(disabled.sweep()).resolves.toMatchObject({ skipped: true, tenants: 0 });
  });
});
