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

/**
 * Journal OBLIGATOIRE de l'override d'encaissement pendant l'embargo L221-10 (doctrine de
 * l'override responsabilisé) : l'artisan informé assume, l'événement `payment.embargo_overridden`
 * est horodaté et tracé AVANT que la pièce ne soit produite — si le journal échoue, l'action
 * échoue (jamais d'override silencieux). Impl. API : logger d'audit structuré.
 */
export interface EmbargoOverrideAuditPort {
  embargoOverridden(event: {
    /** Toujours 'payment.embargo_overridden' — figé pour l'exploitation du journal. */
    type: 'payment.embargo_overridden';
    quoteId: string;
    companyId: string;
    /** Pièce concernée par l'encaissement forcé (acompte/situation/finale). */
    invoiceKind: string;
    /** Fin de l'embargo contourné (instant ISO) — matérialise la fenêtre assumée. */
    embargoExpiresAt: Instant;
    /** Horodatage serveur de la confirmation de l'artisan. */
    occurredAt: Instant;
  }): Promise<void>;
}

export interface CashflowSnapshotPort {
  /** E9 : vatDue est OPTIONNEL — la position de TVA réelle se dérive des factures (E2,
   *  deriveVatPosition) ; le champ ne sert plus que de repli aux implémentations amont. */
  get(companyId: string): Promise<{ bankBalance: number; receivables: number; charges: number; vatDue?: number }>;
}
