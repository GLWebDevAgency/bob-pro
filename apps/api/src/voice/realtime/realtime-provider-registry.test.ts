import { describe, expect, it, vi } from 'vitest';
import {
  RealtimeProviderRegistryError,
  RealtimeProviderTerminationRegistry,
  realtimeProviderTerminationAdapter,
  type RealtimeProviderTerminationAdapter,
} from './realtime-provider-registry';

const BINDING = {
  companyId: 'company-1',
  subjectHash: 'a'.repeat(64),
  sessionId: '11111111-1111-4111-8111-111111111111',
  reaperToken: 'R'.repeat(43),
  reaperLeaseExpiresAt: '2026-07-14T10:00:30.000Z',
  terminationCause: 'lease_expired',
} as const;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('Bob Live — registre de terminaison provider', () => {
  it('route le même identifiant distant vers le provider durable exact', async () => {
    const openai = vi.fn(async () => undefined);
    const mistral = vi.fn(async () => undefined);
    const registry = new RealtimeProviderTerminationRegistry([
      realtimeProviderTerminationAdapter('openai', { hangupCall: openai }),
      realtimeProviderTerminationAdapter('mistral', { hangupCall: mistral }),
    ]);

    await registry.hangupCall({
      ...BINDING, providerId: 'openai', providerCallId: 'shared_remote_id', hardExpiryProof: null,
    });
    expect(openai).toHaveBeenCalledWith('shared_remote_id');
    expect(mistral).not.toHaveBeenCalled();

    await registry.hangupCall({
      ...BINDING, providerId: 'mistral', providerCallId: 'shared_remote_id', hardExpiryProof: null,
    });
    expect(mistral).toHaveBeenCalledWith('shared_remote_id');
    expect(openai).toHaveBeenCalledOnce();
  });

  it('échoue fermé si aucun adapter ne porte le provider persisté', async () => {
    const openai = vi.fn(async () => undefined);
    const registry = new RealtimeProviderTerminationRegistry([
      realtimeProviderTerminationAdapter('openai', { hangupCall: openai }),
    ]);

    await expect(registry.hangupCall({
      ...BINDING,
      providerId: 'mistral',
      providerCallId: 'mistral_session_1',
      hardExpiryProof: null,
    })).rejects.toMatchObject({ code: 'provider_adapter_unavailable' });
    expect(openai).not.toHaveBeenCalled();
  });

  it('refuse une preuve hard-expired provenant d’un autre tenant sans aucune cross-route', async () => {
    const mistral = vi.fn(async () => undefined);
    const registry = new RealtimeProviderTerminationRegistry([
      realtimeProviderTerminationAdapter('mistral', { hangupCall: mistral }),
    ]);
    const hardExpiresAt = '2026-07-14T10:00:00.000Z';

    await expect(registry.hangupCall({
      ...BINDING,
      providerId: 'mistral',
      providerCallId: 'mistral_tenant_fence',
      hardExpiryProof: {
        source: 'database_hard_expiry',
        companyId: 'company-2',
        subjectHash: BINDING.subjectHash,
        sessionId: BINDING.sessionId,
        providerId: 'mistral',
        providerCallId: 'mistral_tenant_fence',
        hardExpiresAt,
        databaseObservedAt: hardExpiresAt,
        leaseVersion: 2,
      },
    })).rejects.toMatchObject({ code: 'invalid_provider_identity' });
    expect(mistral).not.toHaveBeenCalled();
  });

  it('refuse les adapters dupliqués ou les identités runtime invalides sans fuite du call id', async () => {
    const adapter = realtimeProviderTerminationAdapter('openai', { hangupCall: vi.fn() });
    expect(() => new RealtimeProviderTerminationRegistry([adapter, adapter]))
      .toThrowError(RealtimeProviderRegistryError);

    const registry = new RealtimeProviderTerminationRegistry([adapter]);
    const invalidCallId = 'call/id-secret';
    let error: unknown;
    try {
      await registry.hangupCall({
        ...BINDING, providerId: 'openai', providerCallId: invalidCallId, hardExpiryProof: null,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'invalid_provider_identity' });
    expect(String(error)).not.toContain(invalidCallId);
  });

  it('coalesce les hangups concurrents par identité composite, jamais entre providers', async () => {
    const openaiGate = deferred();
    const openai = vi.fn(() => openaiGate.promise);
    const mistral = vi.fn(async () => undefined);
    const registry = new RealtimeProviderTerminationRegistry([
      realtimeProviderTerminationAdapter('openai', { hangupCall: openai }),
      realtimeProviderTerminationAdapter('mistral', { hangupCall: mistral }),
    ]);

    const first = registry.hangupCall({
      ...BINDING, providerId: 'openai', providerCallId: 'shared', hardExpiryProof: null,
    });
    const retry = registry.hangupCall({
      ...BINDING, providerId: 'openai', providerCallId: 'shared', hardExpiryProof: null,
    });
    await registry.hangupCall({
      ...BINDING, providerId: 'mistral', providerCallId: 'shared', hardExpiryProof: null,
    });
    await Promise.resolve();
    expect(openai).toHaveBeenCalledOnce();
    expect(mistral).toHaveBeenCalledOnce();

    openaiGate.resolve();
    await expect(Promise.all([first, retry])).resolves.toEqual([undefined, undefined]);
  });

  it('ne coalesce jamais deux fences reaper distinctes pour le même call fournisseur', async () => {
    const firstGate = deferred();
    const hangupCall = vi.fn((input: Parameters<RealtimeProviderTerminationAdapter['hangupCall']>[0]) => (
      input.reaperToken === BINDING.reaperToken ? firstGate.promise : Promise.resolve()
    ));
    const registry = new RealtimeProviderTerminationRegistry([{
      providerId: 'mistral',
      hangupCall,
    }]);

    const first = registry.hangupCall({
      ...BINDING,
      providerId: 'mistral',
      providerCallId: 'mcv2:30000000-0000-4000-8000-000000000001',
      hardExpiryProof: null,
    });
    const nextFence = registry.hangupCall({
      ...BINDING,
      providerId: 'mistral',
      providerCallId: 'mcv2:30000000-0000-4000-8000-000000000001',
      reaperToken: 'S'.repeat(43),
      reaperLeaseExpiresAt: '2026-07-14T10:01:30.000Z',
      hardExpiryProof: null,
    });
    await Promise.resolve();
    await nextFence;

    expect(hangupCall).toHaveBeenCalledTimes(2);
    firstGate.resolve();
    await first;
  });

  it('valide aussi les adapters non typés à la frontière runtime', () => {
    const invalid = { providerId: 'unknown', hangupCall: vi.fn() } as unknown as RealtimeProviderTerminationAdapter;
    expect(() => new RealtimeProviderTerminationRegistry([invalid]))
      .toThrowError('realtime_invalid_provider_adapter');
  });

  it('fige la fonction de terminaison enregistrée contre une mutation tardive du conteneur', async () => {
    const original = vi.fn(async () => undefined);
    const replacement = vi.fn(async () => undefined);
    const mutable: RealtimeProviderTerminationAdapter = {
      providerId: 'openai',
      hangupCall: original,
    };
    const registry = new RealtimeProviderTerminationRegistry([mutable]);
    mutable.hangupCall = replacement;

    await registry.hangupCall({
      ...BINDING, providerId: 'openai', providerCallId: 'rtc_immutable', hardExpiryProof: null,
    });
    expect(original).toHaveBeenCalledWith(expect.objectContaining({
      providerCallId: 'rtc_immutable',
      reaperToken: BINDING.reaperToken,
    }));
    expect(replacement).not.toHaveBeenCalled();
  });
});
