import { describe, expect, it, vi } from 'vitest';
import {
  AuditedBobLiveRuntimeReadiness,
  gateRealtimeAdmissionOnBobLiveReadiness,
  NonAuditedBobLiveRuntimeReadiness,
} from './realtime-readiness';
import type { RealtimeAdmissionPort } from './realtime-admission';

describe('Bob Live runtime readiness', () => {
  it.each(['disabled', 'native'] as const)(
    '%s est prêt sans jamais construire ni sonder Whisper',
    async (mode) => {
      const readiness = new NonAuditedBobLiveRuntimeReadiness(mode);

      await expect(readiness.check({ fresh: true })).resolves.toEqual({
        ready: true,
        mode,
        speechAudit: 'not_applicable',
      });
    },
  );

  it('publie ready uniquement lorsque le même auditeur actif répond sainement', async () => {
    const health = vi.fn(async () => ({ healthy: true }));
    const prove = vi.fn(async () => ({ healthy: true }));
    const readiness = new AuditedBobLiveRuntimeReadiness({ health }, { prove });

    await expect(readiness.check()).resolves.toEqual({
      ready: true,
      mode: 'audited',
      speechAudit: 'ready',
    });
    expect(health).toHaveBeenCalledOnce();
    expect(prove).toHaveBeenCalledOnce();
  });

  it.each([
    ['false', async () => ({ healthy: false })],
    ['exception', async () => { throw new Error('secret-internal-cause'); }],
    ['auditeur absent', null],
  ] as const)('ferme sans propager de cause technique quand le probe vaut %s', async (_case, audit) => {
    const readiness = new AuditedBobLiveRuntimeReadiness(
      audit === null ? null : { health: audit },
      { prove: async () => ({ healthy: true }) },
    );

    await expect(readiness.check()).resolves.toEqual({
      ready: false,
      mode: 'audited',
      speechAudit: 'unavailable',
    });
  });

  it('borne un auditeur bloqué et ne laisse jamais pendre la readiness', async () => {
    const readiness = new AuditedBobLiveRuntimeReadiness(
      { health: async () => new Promise(() => undefined) },
      { prove: async () => ({ healthy: true }) },
      { probeTimeoutMs: 5 },
    );

    await expect(readiness.check()).resolves.toEqual({
      ready: false,
      mode: 'audited',
      speechAudit: 'unavailable',
    });
  });

  it('coalesce les rafales, met en cache brièvement et force une preuve fraîche sur demande', async () => {
    let now = 10;
    const health = vi.fn(async () => ({ healthy: true }));
    const prove = vi.fn(async () => ({ healthy: true }));
    const readiness = new AuditedBobLiveRuntimeReadiness(
      { health },
      { prove },
      {
        successTtlMs: 5,
        failureTtlMs: 2,
        acousticSuccessTtlMs: 50,
        now: () => now,
      },
    );

    await Promise.all([readiness.check(), readiness.check(), readiness.check()]);
    expect(health).toHaveBeenCalledTimes(1);
    now = 14;
    await readiness.check();
    expect(health).toHaveBeenCalledTimes(1);
    await readiness.check({ fresh: true });
    expect(health).toHaveBeenCalledTimes(2);
    expect(prove).toHaveBeenCalledTimes(1);
    now = 20;
    await readiness.check();
    expect(health).toHaveBeenCalledTimes(3);
    expect(prove).toHaveBeenCalledTimes(1);
  });

  it('refuse des options non bornées au lieu de fabriquer un cache ambigu', () => {
    expect(() => new AuditedBobLiveRuntimeReadiness(null, null, { probeTimeoutMs: 0 }))
      .toThrow('bob_live_readiness_invalid_options');
    expect(() => new AuditedBobLiveRuntimeReadiness(null, null, { successTtlMs: -1 }))
      .toThrow('bob_live_readiness_invalid_options');
    expect(() => new AuditedBobLiveRuntimeReadiness(null, null, { acousticSuccessTtlMs: 0 }))
      .toThrow('bob_live_readiness_invalid_options');
    expect(() => new AuditedBobLiveRuntimeReadiness(null, null, { acousticProbeTimeoutMs: 60_001 }))
      .toThrow('bob_live_readiness_invalid_options');
  });

  it('ferme même avec Whisper sain si le round-trip acoustique échoue', async () => {
    const readiness = new AuditedBobLiveRuntimeReadiness(
      { health: async () => ({ healthy: true }) },
      { prove: async () => ({ healthy: false }) },
    );

    await expect(readiness.check()).resolves.toEqual({
      ready: false,
      mode: 'audited',
      speechAudit: 'unavailable',
    });
  });

  it('borne et annule une preuve acoustique bloquée', async () => {
    let providerSignal: AbortSignal | undefined;
    const readiness = new AuditedBobLiveRuntimeReadiness(
      { health: async () => ({ healthy: true }) },
      {
        prove: async (signal) => {
          providerSignal = signal;
          return new Promise(() => undefined);
        },
      },
      { acousticProbeTimeoutMs: 5 },
    );

    await expect(readiness.check()).resolves.toEqual({
      ready: false,
      mode: 'audited',
      speechAudit: 'unavailable',
    });
    expect(providerSignal?.aborted).toBe(true);
  });

  it('rejoue la preuve acoustique après son TTL sans thundering herd', async () => {
    let now = 0;
    const prove = vi.fn(async () => ({ healthy: true }));
    const readiness = new AuditedBobLiveRuntimeReadiness(
      { health: async () => ({ healthy: true }) },
      { prove },
      {
        successTtlMs: 0,
        acousticSuccessTtlMs: 10,
        now: () => now,
      },
    );

    await Promise.all([
      readiness.check({ fresh: true }),
      readiness.check({ fresh: true }),
      readiness.check({ fresh: true }),
    ]);
    expect(prove).toHaveBeenCalledOnce();
    now = 11;
    await Promise.all([
      readiness.check({ fresh: true }),
      readiness.check({ fresh: true }),
    ]);
    expect(prove).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['indisponible', async () => ({
      ready: false as const,
      mode: 'audited' as const,
      speechAudit: 'unavailable' as const,
    })],
    ['en erreur', async () => { throw new Error('private-probe-cause'); }],
  ] as const)('refuse une nouvelle réservation si l’audit est %s', async (_case, check) => {
    const reserve = vi.fn();
    const admission = admissionStub({ reserve });
    const gated = gateRealtimeAdmissionOnBobLiveReadiness(admission, { check });

    await expect(gated.reserve({} as never)).resolves.toEqual({
      allowed: false,
      denial: 'unavailable',
      retryAt: null,
    });
    expect(reserve).not.toHaveBeenCalled();
  });

  it('délègue une réservation saine et ne bloque jamais le drain existant', async () => {
    const allowed = { allowed: false as const, denial: 'user_minute' as const, retryAt: null };
    const reserve = vi.fn(async () => allowed);
    const release = vi.fn(async () => ({ ok: true as const, reason: null }));
    const claimExpired = vi.fn(async () => ({ ok: true as const, claims: [] }));
    const admission = admissionStub({ reserve, release, claimExpired });
    const readiness = {
      check: vi.fn(async () => ({
        ready: true as const,
        mode: 'audited' as const,
        speechAudit: 'ready' as const,
      })),
    };
    const gated = gateRealtimeAdmissionOnBobLiveReadiness(admission, readiness);

    const reservation = {} as never;
    await expect(gated.reserve(reservation)).resolves.toBe(allowed);
    expect(reserve).toHaveBeenCalledWith(reservation);
    await gated.release({} as never);
    await gated.claimExpired({ companyId: 'company-1' });
    expect(release).toHaveBeenCalledOnce();
    expect(claimExpired).toHaveBeenCalledOnce();
  });
});

function admissionStub(
  overrides: Partial<RealtimeAdmissionPort> = {},
): RealtimeAdmissionPort {
  const unavailableMutation = async () => ({ ok: false as const, reason: 'unavailable' as const });
  return {
    reserve: async () => ({ allowed: false, denial: 'unavailable', retryAt: null }),
    bindProvider: unavailableMutation,
    activate: unavailableMutation,
    renew: unavailableMutation,
    release: unavailableMutation,
    claimExpired: async () => ({ ok: true, claims: [] }),
    resolveSession: async () => ({ ok: false, reason: 'unavailable' }),
    acknowledgeAgentMissionBootstrap: async () => ({ ok: false, reason: 'unavailable' }),
    claimTermination: async () => ({ ok: false, reason: 'unavailable' }),
    completeReaping: unavailableMutation,
    updateContext: async () => ({ ok: false, reason: 'unavailable' }),
    readContext: async () => ({ ok: false, reason: 'unavailable' }),
    acquire: () => ({ allowed: false, denial: 'unavailable', retryAt: null }),
    ...overrides,
  } as RealtimeAdmissionPort;
}
