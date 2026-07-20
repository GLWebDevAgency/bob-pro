import { DocNumber } from '@bob/core';
import type {
  SequenceCounterPort,
  CounterKey,
  IdGeneratorPort,
  ClockPort,
  CashflowSnapshotPort,
} from '@bob/core';

export class InMemorySequenceCounter implements SequenceCounterPort {
  private readonly counters = new Map<string, number>();
  async allocate(input: { companyId: string; counterKey: CounterKey; fiscalYear: number }): Promise<{
    sequence: number;
    formatted: DocNumber;
  }> {
    const key = `${input.companyId}:${input.counterKey}:${input.fiscalYear}`;
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    // D = devis · F = facture · A = avoir (A6) — chaque famille tient SA séquence sans trou.
    const prefix = input.counterKey === 'quote' ? 'D' : input.counterKey === 'credit' ? 'A' : 'F';
    return { sequence: next, formatted: DocNumber.format(prefix, input.fiscalYear, next) };
  }
  snapshot(): Map<string, number> {
    return new Map(this.counters);
  }
  restore(snap: Map<string, number>): void {
    this.counters.clear();
    for (const [k, v] of snap) this.counters.set(k, v);
  }
}

/** Générateur d'ID RN-safe (pas de crypto.randomUUID requis sur Hermes). */
export class CounterIdGenerator implements IdGeneratorPort {
  private n = 0;
  newId(): string {
    this.n += 1;
    return `bob-${this.n.toString(36)}-${Date.now().toString(36)}`;
  }
}

export class FixtureClock implements ClockPort {
  constructor(private readonly fixedDay: string) {}
  now(): string {
    return `${this.fixedDay}T09:00:00.000Z`;
  }
  today(): string {
    return this.fixedDay;
  }
}

export class FixtureCashflowSnapshot implements CashflowSnapshotPort {
  constructor(private readonly snapshot: { bankBalance: number; receivables: number; charges: number; vatDue: number }) {}
  async get(_companyId: string): Promise<{ bankBalance: number; receivables: number; charges: number; vatDue: number }> {
    return this.snapshot;
  }
}
