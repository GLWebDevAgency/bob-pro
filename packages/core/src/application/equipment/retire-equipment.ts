import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appConflict, appDomain, appNotFound } from '../result';
import { type EquipmentProps } from '../../domain/equipment/equipment';
import {
  type EquipmentContractCoveragePort,
  type EquipmentRepository,
} from './equipment-repository';
import { type ClockPort } from '../ports/services';

export interface RetireEquipmentInput {
  companyId: string;
  equipmentId: string;
  expectedRevision: number;
}

export interface RetireEquipmentOutput {
  equipment: EquipmentProps;
  /**
   * [Amélioration 4] — avertissement HONNÊTE et NON bloquant : l'équipement est couvert par
   * un (des) contrat(s) actif(s) — la couverture (et son prix) continue jusqu'à modification
   * du contrat. `null` = aucune couverture connue. Le retrait reste TOUJOURS possible : la
   * réalité du terrain prime.
   */
  contractWarning: string | null;
}

export interface RetireEquipmentDeps {
  equipments: EquipmentRepository;
  clock: ClockPort;
  /** Absent tant que les contrats (Bloc B) ne sont pas livrés : aucun avertissement inventé. */
  contractCoverage?: EquipmentContractCoveragePort;
}

/** Bloc A §1.5 — retrait LOGIQUE (« la vitrine froide est déposée ») : `retiredAt` posé,
 * historique intact, avertissement contrat dit AVANT confirmation (écran ET voix). */
export class RetireEquipment {
  constructor(private readonly deps: RetireEquipmentDeps) {}

  async execute(input: RetireEquipmentInput): Promise<Result<RetireEquipmentOutput, AppError>> {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)
      return err(appDomain({ code: 'VALIDATION', field: 'expectedRevision', message: 'Révision invalide.' }));
    const load = this.deps.equipments.lockById?.bind(this.deps.equipments) ??
      this.deps.equipments.findById.bind(this.deps.equipments);
    const equipment = await load(input.companyId, input.equipmentId);
    if (!equipment || equipment.companyId !== input.companyId)
      return err(appNotFound('equipment', input.equipmentId));
    if (equipment.revision !== input.expectedRevision)
      return err(appConflict('equipment', 'stale_revision'));
    const retired = equipment.retire(this.deps.clock.now());
    if (!retired.ok) return err(appDomain(retired.error));
    await this.deps.equipments.save(equipment);

    let contractWarning: string | null = null;
    if (this.deps.contractCoverage) {
      const labels = await this.deps.contractCoverage.activeContractLabels(
        input.companyId,
        input.equipmentId,
      );
      if (labels.length > 0) {
        contractWarning = `Couvert par le contrat ${labels.join(', ')} : la couverture (et son prix) continue jusqu'à modification du contrat.`;
      }
    }
    return ok({ equipment: equipment.toProps(), contractWarning });
  }
}

export interface ReactivateEquipmentInput {
  companyId: string;
  equipmentId: string;
  expectedRevision: number;
}

export interface ReactivateEquipmentDeps {
  equipments: EquipmentRepository;
}

/** Bloc A §1.4 — réactivation (erreur honnête corrigée) : `retiredAt` PURGÉ, cycle repart. */
export class ReactivateEquipment {
  constructor(private readonly deps: ReactivateEquipmentDeps) {}

  async execute(input: ReactivateEquipmentInput): Promise<Result<EquipmentProps, AppError>> {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)
      return err(appDomain({ code: 'VALIDATION', field: 'expectedRevision', message: 'Révision invalide.' }));
    const load = this.deps.equipments.lockById?.bind(this.deps.equipments) ??
      this.deps.equipments.findById.bind(this.deps.equipments);
    const equipment = await load(input.companyId, input.equipmentId);
    if (!equipment || equipment.companyId !== input.companyId)
      return err(appNotFound('equipment', input.equipmentId));
    if (equipment.revision !== input.expectedRevision)
      return err(appConflict('equipment', 'stale_revision'));
    const reactivated = equipment.reactivate();
    if (!reactivated.ok) return err(appDomain(reactivated.error));
    await this.deps.equipments.save(equipment);
    return ok(equipment.toProps());
  }
}
