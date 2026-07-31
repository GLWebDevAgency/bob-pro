import { describe, expect, it, vi } from 'vitest';
import {
  ConversationTimeZoneGateCoordinator,
  type ConversationTimeZoneConfirmationState,
} from './conversation-time-zone-gate';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('ConversationTimeZoneGateCoordinator', () => {
  it('reste sélectionnable après une détection nulle puis publie une redétection valide', () => {
    const states: Array<ConversationTimeZoneConfirmationState | null> = [];
    const gate = new ConversationTimeZoneGateCoordinator((state) => states.push(state));

    void gate.require(null);
    gate.redetect('Europe/Paris');

    expect(states).toEqual([
      {
        phase: 'choosing',
        suggestedTimeZone: null,
        detectionRevision: 1,
        issue: 'detection_unavailable',
      },
      {
        phase: 'choosing',
        suggestedTimeZone: 'Europe/Paris',
        detectionRevision: 2,
        issue: null,
      },
    ]);
  });

  it('sérialise deux confirmations same-frame sur la même Promise et un seul PUT/refresh', async () => {
    const saveDeferred = deferred<{
      timeZone: string;
      confirmedAt: string;
      requiresSessionRefresh: boolean;
    } | null>();
    const save = vi.fn(async () => saveDeferred.promise);
    const refreshAuthority = vi.fn(async () => ({
      timeZone: 'Europe/Paris',
      confirmedAt: '2026-07-31T08:00:00.000Z',
    }));
    const gate = new ConversationTimeZoneGateCoordinator(() => undefined);
    const confirmed = gate.require('Europe/Paris');

    const first = gate.confirm('Europe/Paris', { save, refreshAuthority });
    const second = gate.confirm('America/Cayenne', { save, refreshAuthority });
    expect(second).toBe(first);
    expect(save).toHaveBeenCalledOnce();

    saveDeferred.resolve({
      timeZone: 'Europe/Paris',
      confirmedAt: '2026-07-31T08:00:00.000Z',
      requiresSessionRefresh: true,
    });
    await first;

    await expect(confirmed).resolves.toBe(true);
    expect(refreshAuthority).toHaveBeenCalledOnce();
  });

  it('ignore un résultat réseau tardif après invalidation et ne confirme jamais le gate suivant', async () => {
    const saveDeferred = deferred<{
      timeZone: string;
      confirmedAt: string;
      requiresSessionRefresh: boolean;
    } | null>();
    const gate = new ConversationTimeZoneGateCoordinator(() => undefined);
    const firstGate = gate.require('Europe/Paris');
    const flight = gate.confirm('Europe/Paris', {
      save: async () => saveDeferred.promise,
      refreshAuthority: async () => ({
        timeZone: 'Europe/Paris',
        confirmedAt: '2026-07-31T08:00:00.000Z',
      }),
    });

    gate.invalidate();
    const nextGate = gate.require('America/Cayenne');
    saveDeferred.resolve({
      timeZone: 'Europe/Paris',
      confirmedAt: '2026-07-31T08:00:00.000Z',
      requiresSessionRefresh: true,
    });
    await flight;

    await expect(firstGate).resolves.toBe(false);
    let nextSettled = false;
    void nextGate.then(() => {
      nextSettled = true;
    });
    await Promise.resolve();
    expect(nextSettled).toBe(false);
    gate.invalidate();
  });

  it('préserve la suggestion après erreur puis autorise un retry neuf', async () => {
    const states: Array<ConversationTimeZoneConfirmationState | null> = [];
    const gate = new ConversationTimeZoneGateCoordinator((state) => states.push(state));
    void gate.require('Europe/Paris');
    const save = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        timeZone: 'Europe/Paris',
        confirmedAt: '2026-07-31T08:00:00.000Z',
        requiresSessionRefresh: true,
      });
    const operations = {
      save,
      refreshAuthority: async () => ({
        timeZone: 'Europe/Paris',
        confirmedAt: '2026-07-31T08:00:00.000Z',
      }),
    };

    await gate.confirm('Europe/Paris', operations);
    expect(states.at(-1)).toEqual(expect.objectContaining({
      phase: 'choosing',
      suggestedTimeZone: 'Europe/Paris',
      issue: 'confirmation_failed',
    }));
    await gate.confirm('Europe/Paris', operations);

    expect(save).toHaveBeenCalledTimes(2);
    expect(states.at(-1)).toBeNull();
  });

  it('refuse une zone invalide sans réseau et vérifie le reçu JWT exact', async () => {
    const states: Array<ConversationTimeZoneConfirmationState | null> = [];
    const gate = new ConversationTimeZoneGateCoordinator((state) => states.push(state));
    void gate.require(null);
    const save = vi.fn(async () => ({
      timeZone: 'Europe/Paris',
      confirmedAt: '2026-07-31T08:00:00.000Z',
      requiresSessionRefresh: true,
    }));

    await gate.confirm('Europe/Introuvable', {
      save,
      refreshAuthority: async () => null,
    });
    expect(save).not.toHaveBeenCalled();

    await gate.confirm('Europe/Paris', {
      save,
      refreshAuthority: async () => ({
        timeZone: 'Europe/Paris',
        confirmedAt: '2026-07-31T09:00:00.000Z',
      }),
    });
    expect(states.at(-1)).toEqual(expect.objectContaining({
      phase: 'choosing',
      issue: 'confirmation_failed',
    }));
  });
});
