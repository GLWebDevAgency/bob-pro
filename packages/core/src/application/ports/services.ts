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

/**
 * Unité de travail : exécute `fn` dans une transaction atomique. Si `fn` LÈVE, tout est annulé
 * (rollback) — d'où, pour annuler sur erreur métier, on lève (cf. use cases d'émission/encaissement).
 * Impl. in-memory = exécution directe (JS mono-thread) ; impl. Prisma = $transaction.
 */
export interface UnitOfWorkPort {
  runInTransaction<T>(fn: () => Promise<T>): Promise<T>;
}

export interface CashflowSnapshotPort {
  /** E9 : vatDue est OPTIONNEL — la position de TVA réelle se dérive des factures (E2,
   *  deriveVatPosition) ; le champ ne sert plus que de repli aux implémentations amont. */
  get(companyId: string): Promise<{ bankBalance: number; receivables: number; charges: number; vatDue?: number }>;
}
