import { type MaintenanceContract } from '../../domain/contract/maintenance-contract';
import { type ContractInvoiceProjection } from './derive-contract-schedule';

/**
 * Port du contrat de maintenance (§2.6). Lectures tenant-scopées PAR CONTRAT ; la persistance
 * ajoute FK composites + RLS en défense en profondeur. `save` persiste l'agrégat COMPLET
 * (conditions + lignes + liaison équipements) — la couverture de facturation, elle, n'est
 * JAMAIS écrite : elle se dérive des factures réelles (direction 1).
 */
export interface MaintenanceContractRepository {
  findById(companyId: string, id: string): Promise<MaintenanceContract | null>;
  /** Verrouille la ligne (SELECT … FOR UPDATE) dans la transaction courante — sérialise les
   * émissions concurrentes de la facture annuelle (garde d'émission §2.6) et les mutations.
   * REQUIS (pas optionnel) : la garde IssueInvoice ne fonctionne pas sans verrou. */
  lockById(companyId: string, id: string): Promise<MaintenanceContract | null>;
  listByCompany(companyId: string): Promise<MaintenanceContract[]>;
  listByCustomer(companyId: string, customerId: string): Promise<MaintenanceContract[]>;
  save(contract: MaintenanceContract): Promise<void>;
  /** Supprime un BROUILLON (le use case garde le statut ; le trigger SQL BEFORE DELETE
   * draft-only re-refuse en défense en profondeur). */
  deleteById(companyId: string, id: string): Promise<void>;
}

/**
 * Lecture des factures d'un contrat pour la dérivation de couverture (§2.5, index partiel
 * invoices_contract_period_idx). [Annexe erratum n° 8] `listContractInvoicesByCompany` est
 * BATCHÉE : UNE requête pour tout le tenant, projections groupées par contrat — les priorités
 * Aujourd'hui et le cron 6 h ne font JAMAIS N requêtes par contrat.
 */
export interface ContractInvoicesReadPort {
  listByMaintenanceContract(
    companyId: string,
    contractId: string,
  ): Promise<ContractInvoiceProjection[]>;
  listContractInvoicesByCompany(
    companyId: string,
  ): Promise<Map<string, ContractInvoiceProjection[]>>;
}
