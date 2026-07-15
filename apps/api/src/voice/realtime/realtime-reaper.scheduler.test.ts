import { describe, expect, it, vi } from 'vitest';
import type { AppLogger } from '../../observability/logger';
import type { RealtimeAdmissionPort, RealtimeReapingClaim } from './realtime-admission';
import {
  RealtimeAdmissionReaperScheduler,
  type RealtimeReaperTenantDirectory,
} from './realtime-reaper.scheduler';
import {
  RealtimeProviderTerminationRegistry,
  realtimeProviderTerminationAdapter,
} from './realtime-provider-registry';
import type { OpenAiRealtimeCallProvider, RealtimeVoiceSettings } from './realtime.types';
import { MistralRealtimeTerminationAuthority } from './mistral-realtime-termination';

const NOW = Date.parse('2026-07-14T10:00:00.000Z');

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function claim(
  companyId = 'company-a',
  suffix = '1',
  providerId: RealtimeReapingClaim['providerId'] = 'openai',
): RealtimeReapingClaim {
  return {
    companyId,
    subjectHash: suffix.repeat(64),
    sessionId: `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`,
    providerId,
    providerCallId: `rtc_${suffix}`,
    reaperToken: `reaper-${suffix}-${'x'.repeat(40)}`,
    reaperLeaseExpiresAt: '2026-07-13T12:00:30.000Z',
    hardExpiryProof: null,
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

function settings(
  enabled = true,
  provider: RealtimeVoiceSettings['provider'] = 'openai',
): RealtimeVoiceSettings {
  return { enabled, provider } as RealtimeVoiceSettings;
}

function scheduler(input: {
  admission: RealtimeAdmissionPort;
  provider?: OpenAiRealtimeCallProvider | RealtimeProviderTerminationRegistry;
  tenants?: RealtimeReaperTenantDirectory;
  enabled?: boolean;
  selectedProvider?: RealtimeVoiceSettings['provider'];
}) {
  return new RealtimeAdmissionReaperScheduler(
    input.admission,
    input.provider ?? providerStub(),
    input.tenants ?? { listCompanyIds: async () => ['company-a'] },
    settings(input.enabled ?? true, input.selectedProvider ?? 'openai'),
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
  it('ferme la connexion Mistral locale réelle avant de compléter le claim', async () => {
    const reaping = claim('company-a', '1', 'mistral');
    const close = vi.fn(async () => undefined);
    const authority = new MistralRealtimeTerminationAuthority(() => NOW);
    authority.register({
      connection: { providerSessionId: reaping.providerCallId, close },
      hardExpiresAt: new Date(NOW + 60_000).toISOString(),
    });
    const completeReaping = vi.fn(async () => ({ ok: true as const, reason: null }));
    const admission = admissionStub({
      claimExpired: vi.fn(async () => ({ ok: true as const, claims: [reaping] })),
      completeReaping,
    });

    const result = await scheduler({
      admission,
      provider: new RealtimeProviderTerminationRegistry([authority]),
      selectedProvider: 'mistral',
    }).sweep();

    expect(result).toMatchObject({ claims: 1, terminated: 1, failures: 0 });
    expect(close).toHaveBeenCalledOnce();
    expect(completeReaping).toHaveBeenCalledOnce();
  });

  it('garde le fence Mistral sur une autre réplique avant le hard cap', async () => {
    const reaping = claim('company-a', '1', 'mistral');
    const completeReaping = vi.fn(async () => ({ ok: true as const, reason: null }));
    const admission = admissionStub({
      claimExpired: vi.fn(async () => ({ ok: true as const, claims: [reaping] })),
      completeReaping,
    });
    const remoteReplica = new MistralRealtimeTerminationAuthority(() => NOW);

    const result = await scheduler({
      admission,
      provider: new RealtimeProviderTerminationRegistry([remoteReplica]),
      selectedProvider: 'mistral',
    }).sweep();

    expect(result).toMatchObject({ claims: 1, terminated: 0, failures: 1 });
    expect(completeReaping).not.toHaveBeenCalled();
  });

  it('complète sans egress sur une autre réplique seulement avec la preuve DB post-hard-cap', async () => {
    const base = claim('company-a', '1', 'mistral');
    const hardExpiresAt = new Date(NOW - 1).toISOString();
    const reaping: RealtimeReapingClaim = {
      ...base,
      hardExpiryProof: {
        source: 'database_hard_expiry',
        companyId: base.companyId,
        subjectHash: base.subjectHash,
        sessionId: base.sessionId,
        providerId: base.providerId,
        providerCallId: base.providerCallId,
        hardExpiresAt,
        databaseObservedAt: new Date(NOW).toISOString(),
        leaseVersion: 5,
      },
    };
    const completeReaping = vi.fn(async () => ({ ok: true as const, reason: null }));
    const admission = admissionStub({
      claimExpired: vi.fn(async () => ({ ok: true as const, claims: [reaping] })),
      completeReaping,
    });
    const remoteReplica = new MistralRealtimeTerminationAuthority(() => NOW);

    const result = await scheduler({
      admission,
      provider: new RealtimeProviderTerminationRegistry([remoteReplica]),
      selectedProvider: 'mistral',
    }).sweep();

    expect(result).toMatchObject({ claims: 1, terminated: 1, failures: 0 });
    expect(completeReaping).toHaveBeenCalledOnce();
    expect(remoteReplica.state()).toEqual({ activeConnections: 0, terminalProofs: 1 });
  });

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

  it('route chaque claim selon son provider persisté, même si les call ids sont identiques', async () => {
    const openaiHangup = vi.fn(async () => undefined);
    const mistralHangup = vi.fn(async () => undefined);
    const providers = new RealtimeProviderTerminationRegistry([
      realtimeProviderTerminationAdapter('openai', { hangupCall: openaiHangup }),
      realtimeProviderTerminationAdapter('mistral', { hangupCall: mistralHangup }),
    ]);
    const openaiClaim = { ...claim('company-a', '1', 'openai'), providerCallId: 'shared_remote' };
    const mistralClaim = { ...claim('company-a', '2', 'mistral'), providerCallId: 'shared_remote' };
    const completeReaping = vi.fn(async () => ({ ok: true as const, reason: null }));
    const admission = admissionStub({
      claimExpired: vi.fn(async () => ({
        ok: true as const,
        claims: [openaiClaim, mistralClaim],
      })),
      completeReaping,
    });

    const result = await scheduler({
      admission,
      provider: providers,
    }).sweep();

    expect(result).toMatchObject({ claims: 2, terminated: 2, failures: 0 });
    expect(openaiHangup).toHaveBeenCalledWith('shared_remote');
    expect(mistralHangup).toHaveBeenCalledWith('shared_remote');
    expect(completeReaping).toHaveBeenCalledTimes(2);
  });

  it('ne termine ni ne complète un claim Mistral avec le fallback OpenAI', async () => {
    const mistralClaim = claim('company-a', '1', 'mistral');
    const completeReaping = vi.fn(async () => ({ ok: true as const, reason: null }));
    const admission = admissionStub({
      claimExpired: vi.fn(async () => ({ ok: true as const, claims: [mistralClaim] })),
      completeReaping,
    });
    const openaiHangup = vi.fn(async () => undefined);

    const result = await scheduler({
      admission,
      provider: providerStub(openaiHangup),
    }).sweep();

    expect(result).toMatchObject({ claims: 1, terminated: 0, failures: 1 });
    expect(openaiHangup).not.toHaveBeenCalled();
    expect(completeReaping).not.toHaveBeenCalled();
  });

  it('n’envoie jamais un ancien bail OpenAI à l’adapter construit après une bascule Mistral', async () => {
    const oldOpenAiClaim = claim('company-a', '1', 'openai');
    const completeReaping = vi.fn(async () => ({ ok: true as const, reason: null }));
    const admission = admissionStub({
      claimExpired: vi.fn(async () => ({ ok: true as const, claims: [oldOpenAiClaim] })),
      completeReaping,
    });
    // Ce port représente l'ancien token DI, mais il a été construit avec les settings Mistral.
    // Le reaper ne peut donc pas l'étiqueter OpenAI sans preuve explicite.
    const selectedProviderAdapter = vi.fn(async () => undefined);

    const result = await scheduler({
      admission,
      provider: providerStub(selectedProviderAdapter),
      selectedProvider: 'mistral',
    }).sweep();

    expect(result).toMatchObject({ claims: 1, terminated: 0, failures: 1 });
    expect(selectedProviderAdapter).not.toHaveBeenCalled();
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
