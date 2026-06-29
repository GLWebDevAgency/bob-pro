import { type DocNumber } from '../../domain/billing/shared/doc-number';
import { type Instant, type DateOnly } from '../../shared-kernel/time';

export type CounterKey = 'quote' | 'invoice' | 'credit';

/** Allocation atomique d'un numéro séquentiel sans trou (impl. infra = SELECT ... FOR UPDATE). */
export interface SequenceCounterPort {
  allocate(input: {
    companyId: string;
    counterKey: CounterKey;
    fiscalYear: number;
  }): Promise<{ sequence: number; formatted: DocNumber }>;
}

export interface ClockPort {
  now(): Instant;
  today(): DateOnly;
}

export interface IdGeneratorPort {
  newId(): string;
}

export interface CashflowSnapshotPort {
  get(companyId: string): Promise<{ bankBalance: number; receivables: number; charges: number; vatDue: number }>;
}
