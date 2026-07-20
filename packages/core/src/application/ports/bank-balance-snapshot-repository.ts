import { type BankBalanceSnapshot } from '../../domain/banking/bank-balance-snapshot';

export type AppendBankBalanceSnapshotOutcome = 'created' | 'id_conflict';

/** Port append-only. Chaque méthode doit appliquer le `companyId` dans la requête SQL/RLS. */
export interface BankBalanceSnapshotRepository {
  /** N'écrase jamais un snapshot existant : un identifiant déjà utilisé est un conflit. */
  append(snapshot: BankBalanceSnapshot): Promise<AppendBankBalanceSnapshotOutcome>;

  /**
   * Dernière observation du tenant, triée par observedAt DESC puis recordedAt DESC puis id DESC.
   * Ne doit jamais retourner le snapshot d'un autre tenant.
   */
  findLatestByCompanyId(companyId: string): Promise<BankBalanceSnapshot | null>;
}
