import type { OnApplicationShutdown } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';

interface Entry {
  hitExpirationsMs: number[];
  blockUntilMs: number;
}

export interface BoundedThrottlerStorageOptions {
  readonly maxKeys?: number;
  readonly sweepIntervalMs?: number;
  readonly saturationLogIntervalMs?: number;
  readonly now?: () => number;
  readonly onSaturation?: (throttlerName: string) => void;
}

const DEFAULT_MAX_KEYS = 50_000;
const DEFAULT_SWEEP_INTERVAL_MS = 30_000;

function secondsRemaining(deadlineMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((deadlineMs - nowMs) / 1_000));
}

/**
 * Storage local borné pour @nestjs/throttler.
 *
 * Le storage Map amont 6.5.0 ne supprime jamais ses clés expirées et peut annuler les timers
 * d'autres clés lors d'un unblock. Ici chaque clé possède son propre historique glissant, un
 * sweep unique évacue les entrées expirées, et la saturation échoue fermée sans évincer une
 * capacité encore active. Le workflow Railway impose un replica tant qu'un storage partagé
 * atomique n'a pas remplacé cette implémentation.
 */
export class BoundedThrottlerStorage implements ThrottlerStorage, OnApplicationShutdown {
  private readonly entriesByThrottler = new Map<string, Map<string, Entry>>();
  private readonly lastSaturationLogMs = new Map<string, number>();
  private readonly maxKeys: number;
  private readonly now: () => number;
  private readonly saturationLogIntervalMs: number;
  private readonly onSaturation: (throttlerName: string) => void;
  private readonly sweepInterval: ReturnType<typeof setInterval>;

  constructor(options: BoundedThrottlerStorageOptions = {}) {
    this.maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
    const sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.saturationLogIntervalMs = options.saturationLogIntervalMs ?? 60_000;
    if (!Number.isInteger(this.maxKeys) || this.maxKeys < 1) {
      throw new Error('maxKeys throttler doit être un entier positif');
    }
    if (!Number.isInteger(sweepIntervalMs) || sweepIntervalMs < 1) {
      throw new Error('sweepIntervalMs throttler doit être un entier positif');
    }
    if (!Number.isInteger(this.saturationLogIntervalMs) || this.saturationLogIntervalMs < 1) {
      throw new Error('saturationLogIntervalMs throttler doit être un entier positif');
    }
    this.now = options.now ?? Date.now;
    this.onSaturation =
      options.onSaturation ??
      ((throttlerName) => {
        console.warn(`[throttle] capacité mémoire saturée pour ${throttlerName}`);
      });
    this.sweepInterval = setInterval(() => this.sweep(), sweepIntervalMs);
    this.sweepInterval.unref?.();
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ) {
    if (
      key.length === 0 ||
      !Number.isFinite(ttl) ||
      ttl < 1 ||
      !Number.isFinite(limit) ||
      limit < 1 ||
      !Number.isFinite(blockDuration) ||
      blockDuration < 1
    )
      throw new Error('Paramètres throttler invalides');

    const now = this.now();
    let entries = this.entriesByThrottler.get(throttlerName);
    if (entries === undefined) {
      entries = new Map();
      this.entriesByThrottler.set(throttlerName, entries);
    }
    let entry = entries.get(key);
    if (entry === undefined) {
      if (entries.size >= this.maxKeys) this.sweep(now, throttlerName);
      entries = this.entriesByThrottler.get(throttlerName) ?? new Map<string, Entry>();
      if (!this.entriesByThrottler.has(throttlerName)) {
        this.entriesByThrottler.set(throttlerName, entries);
      }
      if (entries.size >= this.maxKeys) {
        this.recordSaturation(throttlerName, now);
        return {
          totalHits: limit + 1,
          timeToExpire: secondsRemaining(now + ttl, now),
          isBlocked: true,
          timeToBlockExpire: secondsRemaining(now + blockDuration, now),
        };
      }
      entry = { hitExpirationsMs: [], blockUntilMs: 0 };
      entries.set(key, entry);
    }

    if (entry.blockUntilMs > 0 && entry.blockUntilMs <= now) {
      entry.blockUntilMs = 0;
      entry.hitExpirationsMs = [];
    }
    entry.hitExpirationsMs = entry.hitExpirationsMs.filter((expiresAtMs) => expiresAtMs > now);

    if (entry.blockUntilMs > now) {
      const firstExpiration = entry.hitExpirationsMs[0] ?? now;
      return {
        totalHits: entry.hitExpirationsMs.length,
        timeToExpire: secondsRemaining(firstExpiration, now),
        isBlocked: true,
        timeToBlockExpire: secondsRemaining(entry.blockUntilMs, now),
      };
    }

    entry.hitExpirationsMs.push(now + ttl);
    if (entry.hitExpirationsMs.length > limit) entry.blockUntilMs = now + blockDuration;
    return {
      totalHits: entry.hitExpirationsMs.length,
      timeToExpire: secondsRemaining(entry.hitExpirationsMs[0]!, now),
      isBlocked: entry.blockUntilMs > now,
      timeToBlockExpire: secondsRemaining(entry.blockUntilMs, now),
    };
  }

  onApplicationShutdown(): void {
    clearInterval(this.sweepInterval);
    this.entriesByThrottler.clear();
    this.lastSaturationLogMs.clear();
  }

  /** Métrologie sans exposer les clés ; déclenche aussi le sweep paresseux. */
  activeKeyCount(throttlerName?: string): number {
    this.sweep();
    if (throttlerName !== undefined) return this.entriesByThrottler.get(throttlerName)?.size ?? 0;
    let total = 0;
    for (const entries of this.entriesByThrottler.values()) total += entries.size;
    return total;
  }

  private sweep(now = this.now(), onlyThrottlerName?: string): void {
    for (const [throttlerName, entries] of this.entriesByThrottler) {
      if (onlyThrottlerName !== undefined && throttlerName !== onlyThrottlerName) continue;
      for (const [key, entry] of entries) {
        entry.hitExpirationsMs = entry.hitExpirationsMs.filter((expiresAtMs) => expiresAtMs > now);
        if (entry.hitExpirationsMs.length === 0 && entry.blockUntilMs <= now) entries.delete(key);
      }
      if (entries.size === 0) this.entriesByThrottler.delete(throttlerName);
    }
  }

  private recordSaturation(throttlerName: string, now: number): void {
    const lastLogAt = this.lastSaturationLogMs.get(throttlerName);
    if (lastLogAt !== undefined && now - lastLogAt < this.saturationLogIntervalMs) return;
    this.lastSaturationLogMs.set(throttlerName, now);
    this.onSaturation(throttlerName);
  }
}
