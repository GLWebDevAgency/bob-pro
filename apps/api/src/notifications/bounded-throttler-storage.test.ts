import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoundedThrottlerStorage } from './bounded-throttler-storage';

const storages: BoundedThrottlerStorage[] = [];

function storage(options: ConstructorParameters<typeof BoundedThrottlerStorage>[0] = {}) {
  const value = new BoundedThrottlerStorage({ sweepIntervalMs: 60_000, ...options });
  storages.push(value);
  return value;
}

afterEach(() => {
  for (const value of storages.splice(0)) value.onApplicationShutdown();
});

describe('BoundedThrottlerStorage', () => {
  it('évacue réellement toute cardinalité après expiration', async () => {
    let now = 0;
    const value = storage({ maxKeys: 2_000, now: () => now });
    for (let index = 0; index < 1_000; index += 1) {
      await value.increment(`key-${index}`, 5, 10, 5, 'capability');
    }
    expect(value.activeKeyCount()).toBe(1_000);

    now = 6;
    expect(value.activeKeyCount()).toBe(0);
  });

  it('n’annule jamais l’expiration d’une autre clé lors d’un unblock', async () => {
    let now = 0;
    const value = storage({ now: () => now });
    await value.increment('victim', 80, 10, 80, 'capability');
    await value.increment('attacker', 80, 1, 10, 'capability');
    expect((await value.increment('attacker', 80, 1, 10, 'capability')).isBlocked).toBe(true);

    now = 15;
    expect((await value.increment('attacker', 80, 1, 10, 'capability')).isBlocked).toBe(false);
    now = 81;
    expect(await value.increment('victim', 80, 10, 80, 'capability')).toMatchObject({
      totalHits: 1,
      isBlocked: false,
    });
  });

  it('échoue fermé à la borne sans évincer une clé active', async () => {
    const onSaturation = vi.fn();
    const value = storage({ maxKeys: 2, now: () => 0, onSaturation });
    await value.increment('first', 60_000, 10, 60_000, 'default');
    await value.increment('second', 60_000, 10, 60_000, 'default');

    expect(await value.increment('overflow', 60_000, 10, 60_000, 'default')).toMatchObject({
      totalHits: 11,
      isBlocked: true,
    });
    expect((await value.increment('first', 60_000, 10, 60_000, 'default')).totalHits).toBe(2);
    expect(value.activeKeyCount()).toBe(2);
    expect(onSaturation).toHaveBeenCalledOnce();
    expect(onSaturation).toHaveBeenCalledWith('default');
  });

  it('isole la cardinalité par throttler pour qu’un spray public ne bloque pas les routes métier', async () => {
    const value = storage({ maxKeys: 2, now: () => 0, onSaturation: vi.fn() });
    await value.increment('capability-a', 60_000, 10, 60_000, 'publicPushCapability');
    await value.increment('capability-b', 60_000, 10, 60_000, 'publicPushCapability');
    expect(
      await value.increment('capability-overflow', 60_000, 10, 60_000, 'publicPushCapability'),
    ).toMatchObject({ isBlocked: true });

    expect(
      await value.increment('authenticated-route', 60_000, 100, 60_000, 'default'),
    ).toMatchObject({ totalHits: 1, isBlocked: false });
    expect(value.activeKeyCount('publicPushCapability')).toBe(2);
    expect(value.activeKeyCount('default')).toBe(1);
  });

  it('applique un quota glissant et réouvre seulement après le blockDuration', async () => {
    let now = 0;
    const value = storage({ now: () => now });
    expect((await value.increment('key', 60_000, 2, 10_000, 'default')).isBlocked).toBe(false);
    expect((await value.increment('key', 60_000, 2, 10_000, 'default')).isBlocked).toBe(false);
    expect((await value.increment('key', 60_000, 2, 10_000, 'default')).isBlocked).toBe(true);

    now = 9_999;
    expect((await value.increment('key', 60_000, 2, 10_000, 'default')).isBlocked).toBe(true);
    now = 10_000;
    expect(await value.increment('key', 60_000, 2, 10_000, 'default')).toMatchObject({
      totalHits: 1,
      isBlocked: false,
    });
  });
});
