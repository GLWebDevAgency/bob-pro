import { type DomainError } from '../../shared-kernel/result';

/** Sentinelle : lever dans `runInTransaction` pour déclencher le rollback sur erreur métier (no-gap). */
export class TxDomainError extends Error {
  constructor(readonly domainError: DomainError) {
    super('tx-domain');
  }
}
