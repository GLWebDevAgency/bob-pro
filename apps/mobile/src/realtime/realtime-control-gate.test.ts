import type { BobClient, RealtimeVoiceControlAcknowledgement } from '@bob/api-client';
import { describe, expect, it, vi } from 'vitest';
import {
  RealtimeControlAcknowledgementGate,
  type RealtimePublishedContextFence,
} from './realtime-control-gate';

const TURN = '00000000-0000-4000-8000-000000000010';
const SECOND_TURN = '00000000-0000-4000-8000-000000000013';
const HANDLE = '00000000-0000-4000-8000-000000000011';
const ACKNOWLEDGEMENT = '00000000-0000-4000-8000-000000000012';
const SECOND_ACKNOWLEDGEMENT = '00000000-0000-4000-8000-000000000014';
const DIGEST = 'a'.repeat(64);
const REFERENCE = {
  turnId: TURN,
  acknowledgementId: ACKNOWLEDGEMENT,
  contextRevision: 4,
  contextDigest: DIGEST,
} as const;
const PROVIDER_REFERENCE = { turnId: TURN, contextRevision: 4, contextDigest: DIGEST } as const;

function approved(
  override: Partial<RealtimeVoiceControlAcknowledgement> = {},
): RealtimeVoiceControlAcknowledgement {
  return {
    ...REFERENCE,
    kind: 'answer',
    navigate: '/cloture',
    ...override,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('RealtimeControlAcknowledgementGate', () => {
  it('rejette sans réseau une metadata provider dépourvue de preuve de livraison audio', async () => {
    const acknowledge = vi.fn();
    const gate = new RealtimeControlAcknowledgementGate(
      { acknowledgeRealtimeVoiceControl: acknowledge } as unknown as Pick<BobClient, 'acknowledgeRealtimeVoiceControl'>,
      () => ({ sessionHandle: HANDLE, contextRevision: 4, contextDigest: DIGEST }),
    );

    await expect(gate.acknowledge(PROVIDER_REFERENCE)).resolves.toBeNull();
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it('ne libère que le contrôle exact approuvé par notre API sur le contexte encore courant', async () => {
    let fence: RealtimePublishedContextFence | null = {
      sessionHandle: HANDLE,
      contextRevision: 4,
      contextDigest: DIGEST,
    };
    const acknowledge = vi.fn(async () => ({ ok: true as const, value: approved() }));
    const gate = new RealtimeControlAcknowledgementGate(
      { acknowledgeRealtimeVoiceControl: acknowledge } as Pick<BobClient, 'acknowledgeRealtimeVoiceControl'>,
      () => fence,
    );

    await expect(gate.acknowledge(REFERENCE)).resolves.toEqual({
      turnId: TURN,
      kind: 'answer',
      navigate: '/cloture',
      contextRevision: 4,
      contextDigest: DIGEST,
    });
    expect(acknowledge).toHaveBeenCalledWith(HANDLE, REFERENCE, expect.any(AbortSignal));

    fence = null;
    await expect(gate.acknowledge(REFERENCE)).resolves.toBeNull();
    expect(acknowledge).toHaveBeenCalledTimes(1);
  });

  it('laisse deux tours distincts acquitter le même contexte sans que le second annule le premier', async () => {
    const first = deferred<{ ok: true; value: RealtimeVoiceControlAcknowledgement }>();
    const second = deferred<{ ok: true; value: RealtimeVoiceControlAcknowledgement }>();
    const signals = new Map<string, AbortSignal>();
    const acknowledge = vi.fn(
      (
        _handle: string,
        reference: typeof REFERENCE,
        signal?: AbortSignal,
      ) => {
        if (signal !== undefined) signals.set(reference.turnId, signal);
        return reference.turnId === TURN ? first.promise : second.promise;
      },
    );
    const gate = new RealtimeControlAcknowledgementGate(
      {
        acknowledgeRealtimeVoiceControl: acknowledge,
      } as unknown as Pick<BobClient, 'acknowledgeRealtimeVoiceControl'>,
      () => ({ sessionHandle: HANDLE, contextRevision: 4, contextDigest: DIGEST }),
    );
    const secondReference = {
      ...REFERENCE,
      turnId: SECOND_TURN,
      acknowledgementId: SECOND_ACKNOWLEDGEMENT,
    };

    const firstResult = gate.acknowledge(REFERENCE);
    const duplicateFirstResult = gate.acknowledge(REFERENCE);
    const secondResult = gate.acknowledge(secondReference);

    expect(duplicateFirstResult).toBe(firstResult);
    expect(acknowledge).toHaveBeenCalledTimes(2);
    expect(signals.get(TURN)?.aborted).toBe(false);
    expect(signals.get(SECOND_TURN)?.aborted).toBe(false);

    second.resolve({
      ok: true,
      value: approved({
        turnId: SECOND_TURN,
        acknowledgementId: SECOND_ACKNOWLEDGEMENT,
      }),
    });
    await expect(secondResult).resolves.toMatchObject({ turnId: SECOND_TURN });
    expect(signals.get(TURN)?.aborted).toBe(false);

    first.resolve({ ok: true, value: approved() });
    await expect(firstResult).resolves.toMatchObject({ turnId: TURN });
  });

  it('rejoue le même ACK après perte du HTTP 200 et rend le reçu exact une seule fois', async () => {
    vi.useFakeTimers();
    try {
      const acknowledge = vi.fn()
        .mockRejectedValueOnce(new Error('response_lost_after_commit'))
        .mockResolvedValueOnce({ ok: true as const, value: approved() });
      const gate = new RealtimeControlAcknowledgementGate(
        {
          acknowledgeRealtimeVoiceControl: acknowledge,
        } as Pick<BobClient, 'acknowledgeRealtimeVoiceControl'>,
        () => ({ sessionHandle: HANDLE, contextRevision: 4, contextDigest: DIGEST }),
      );

      const pending = gate.acknowledge(REFERENCE);
      await vi.advanceTimersByTimeAsync(100);

      await expect(pending).resolves.toEqual({
        turnId: TURN,
        kind: 'answer',
        navigate: '/cloture',
        contextRevision: 4,
        contextDigest: DIGEST,
      });
      expect(acknowledge).toHaveBeenCalledTimes(2);
      expect(acknowledge.mock.calls[0]?.[1]).toEqual(REFERENCE);
      expect(acknowledge.mock.calls[1]?.[1]).toEqual(REFERENCE);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejette avant réseau une révision ou empreinte non publiée', async () => {
    const acknowledge = vi.fn();
    const gate = new RealtimeControlAcknowledgementGate(
      { acknowledgeRealtimeVoiceControl: acknowledge } as unknown as Pick<BobClient, 'acknowledgeRealtimeVoiceControl'>,
      () => ({ sessionHandle: HANDLE, contextRevision: 5, contextDigest: 'b'.repeat(64) }),
    );

    await expect(gate.acknowledge(REFERENCE)).resolves.toBeNull();
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it('abandonne un ACK si le contexte change pendant le réseau', async () => {
    const pending = deferred<{ ok: true; value: RealtimeVoiceControlAcknowledgement }>();
    let fence: RealtimePublishedContextFence | null = {
      sessionHandle: HANDLE,
      contextRevision: 4,
      contextDigest: DIGEST,
    };
    const gate = new RealtimeControlAcknowledgementGate(
      {
        acknowledgeRealtimeVoiceControl: vi.fn(() => pending.promise),
      } as unknown as Pick<BobClient, 'acknowledgeRealtimeVoiceControl'>,
      () => fence,
    );
    const result = gate.acknowledge(REFERENCE);
    fence = { sessionHandle: HANDLE, contextRevision: 5, contextDigest: 'b'.repeat(64) };
    pending.resolve({ ok: true, value: approved() });

    await expect(result).resolves.toBeNull();
  });

  it('ferme et annule physiquement la requête en vol', async () => {
    const pending = deferred<{ ok: true; value: RealtimeVoiceControlAcknowledgement }>();
    let signal: AbortSignal | undefined;
    const gate = new RealtimeControlAcknowledgementGate(
      {
        acknowledgeRealtimeVoiceControl: vi.fn((_handle, _input, inputSignal) => {
          signal = inputSignal;
          return pending.promise;
        }),
      } as unknown as Pick<BobClient, 'acknowledgeRealtimeVoiceControl'>,
      () => ({ sessionHandle: HANDLE, contextRevision: 4, contextDigest: DIGEST }),
    );
    const result = gate.acknowledge(REFERENCE);
    gate.close();
    expect(signal?.aborted).toBe(true);
    pending.resolve({ ok: true, value: approved() });
    await expect(result).resolves.toBeNull();
    await expect(gate.acknowledge(REFERENCE)).resolves.toBeNull();
  });

  it('rejette une réponse API dont la référence diffère même si le décodeur amont a accepté la forme', async () => {
    const gate = new RealtimeControlAcknowledgementGate(
      {
        acknowledgeRealtimeVoiceControl: vi.fn(async () => ({
          ok: true as const,
          value: approved({ turnId: '00000000-0000-4000-8000-000000000099' }),
        })),
      } as unknown as Pick<BobClient, 'acknowledgeRealtimeVoiceControl'>,
      () => ({ sessionHandle: HANDLE, contextRevision: 4, contextDigest: DIGEST }),
    );

    await expect(gate.acknowledge(REFERENCE)).resolves.toBeNull();
  });

  it('rejette une réponse liée à un autre acquittement audio', async () => {
    const gate = new RealtimeControlAcknowledgementGate(
      {
        acknowledgeRealtimeVoiceControl: vi.fn(async () => ({
          ok: true as const,
          value: approved({ acknowledgementId: '00000000-0000-4000-8000-000000000099' }),
        })),
      } as unknown as Pick<BobClient, 'acknowledgeRealtimeVoiceControl'>,
      () => ({ sessionHandle: HANDLE, contextRevision: 4, contextDigest: DIGEST }),
    );

    await expect(gate.acknowledge(REFERENCE)).resolves.toBeNull();
  });
});
