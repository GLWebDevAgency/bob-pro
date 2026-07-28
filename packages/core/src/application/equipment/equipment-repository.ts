import { type Equipment } from '../../domain/equipment/equipment';

/**
 * Port du parc d'équipements (Bloc A §1.5). Les lectures sont tenant-scopées PAR CONTRAT :
 * un adapter qui renverrait un équipement d'un autre tenant serait re-refusé par les use cases
 * (garde companyId), la persistance ajoute FK composites + RLS en défense en profondeur.
 */
export interface EquipmentRepository {
  findById(companyId: string, id: string): Promise<Equipment | null>;
  /** Verrouille la ligne (SELECT … FOR UPDATE) dans la transaction courante — sérialise les
   * mutations concurrentes (retrait vs édition à deux appareils). Optionnel : les adapters
   * sans transaction (lectures pures) n'en ont pas besoin. */
  lockById?(companyId: string, id: string): Promise<Equipment | null>;
  listByChantier(companyId: string, chantierId: string): Promise<Equipment[]>;
  listByCompany(companyId: string): Promise<Equipment[]>;
  save(equipment: Equipment): Promise<void>;
}

/**
 * [Amélioration 4] — couverture contractuelle d'un équipement (contrats `active` le liant).
 * Le port est OPTIONNEL tant que les contrats de maintenance (Bloc B) ne sont pas livrés :
 * absent = aucun avertissement (honnête), jamais un avertissement inventé.
 */
export interface EquipmentContractCoveragePort {
  /** Libellés des contrats ACTIFS couvrant cet équipement (vide = aucun). */
  activeContractLabels(companyId: string, equipmentId: string): Promise<string[]>;
}
